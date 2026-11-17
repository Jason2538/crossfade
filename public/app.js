import { disablePush, enablePush, pushSupported, savedPush, syncPush, testPush } from './notify.js';
import { groupFileId, openSnapshot } from './snapshot.js';
import { createPager } from './switcher.js';
import {
  fetchLive,
  finishSpotifyLogin,
  requestCollection,
  sendToCollector,
  startSpotifyLogin,
  takeSpotifyCallback,
} from './spotify-login.js';

const REFRESH_MS = 60_000;
const MAX_WEEKS_BACK = 7;
const SNAPSHOT_REFRESH_MS = 55_000;
const LIVE_REFRESH_MS = 30_000;
const LIVE_MAX_AGE_MS = 90_000;
const COUNT_UP_MS = 900;
const REFRESH_SPIN_MS = 500;
const COLLECT_WATCH_MS = 15_000;
const COLLECT_WATCH_TRIES = 40;
// 수집이 이보다 오래 멈췄다면 "지금 듣는 중"은 더 이상 지금이 아닙니다.
const NOW_PLAYING_TTL_SECONDS = 30 * 60;
// 길이를 모르는 곡은 수집기(src/stats.js)와 같은 값으로 계산합니다.
const ESTIMATED_TRACK_SECONDS = 210;
const DEFAULT_NOTIFY_HOUR = 21;
const CODE_STORAGE_KEY = 'crossfade.inviteCode';
const PENDING_STORAGE_KEY = 'crossfade.pendingGroup';
// 새 그룹이 열리기를 기다리는 동안 확인하는 간격입니다.
const WAITING_REFRESH_MS = 15_000;
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';
const QUEUED_MESSAGE = '요청을 보냈어요. 다음 수집 때(15분쯤) 반영돼요.';
// Apple Music(Last.fm) 연결은 없앴습니다. 예전에 그렇게 들어온 멤버는 관리자 화면에서만 표시합니다.
const SERVICE_NAMES = { spotify: 'Spotify', apple: 'Last.fm(예전 연결)' };
const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

const app = document.getElementById('app');
const tip = document.getElementById('tip');

const SPOTIFY_MESSAGES = {
  connected: 'Spotify 계정을 연결했어요. 최근 재생 기록을 가져오는 중이에요.',
  denied: 'Spotify 로그인이 취소됐어요.',
  notAllowed: '이 Spotify 계정은 아직 앱 사용자로 등록되어 있지 않아요. 그룹 관리자에게 Spotify 이메일을 알려 주세요.',
  full: 'Spotify 로그인은 5명까지만 쓸 수 있어요. 관리자에게 알려 주세요.',
  failed: 'Spotify 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.',
  queued: 'Spotify 계정을 연결했어요. 다음 수집 때(15분쯤) 그룹에 나타나요.',
};

// 크로스페이드 안에서 띄우는 음악 플레이어입니다. 한 번 열면 계속 떠 있어서 다른 탭으로 가도 노래가 이어집니다.
// stateKeys: 그 플레이어가 Spotify 로그인을 시작할 때 저장하는 값의 이름. 로그인 결과는 크로스페이드 첫 화면으로
// 돌아오므로, 이 값으로 어느 플레이어의 로그인인지 알아보고 그 화면에 넘깁니다.
const PLAYERS = {
  luma: { title: 'Luma', path: 'luma/', stateKeys: ['cfluma_state', 'cfluma_state2'], tokenKey: 'cfluma_tok', dark: true },
  aria: { title: 'Aria', path: 'aria/', stateKeys: ['aria_state'], tokenKey: 'aria_tok', dark: false },
};
const playerCallback = takePlayerCallback();

function takePlayerCallback() {
  const search = location.search;
  const returned = new URLSearchParams(search).get('state');
  if (!returned) return null;
  try {
    for (const [name, player] of Object.entries(PLAYERS)) {
      if (!player.stateKeys.some((key) => localStorage.getItem(key) === returned)) continue;
      history.replaceState(null, '', `${location.pathname}#/${name}`);
      return { name, search };
    }
  } catch {
    // 저장소를 못 읽으면 크로스페이드 로그인으로 봅니다.
  }
  return null;
}

const state = {
  session: null,
  week: 0,
  refreshTimer: null,
  flash: takeSpotifyResult(),
  snapshot: null,
  snapshotCode: null,
  snapshotLoadedAt: 0,
  view: null,
  rankPeriod: 'week',
  rankMetric: 'minutes',
  compareWith: null,
  activityAll: false,
  collecting: false,
  live: new Map(),
  invite: takeInviteCode(),
  gateError: null,
  connect: null,
  openCode: null,
  pendingCode: null,
  admin: null,
  spotifyCallback: takeSpotifyCallback(),
};

// 초대 링크의 # 뒷부분은 서버로 전송되지 않습니다. 주소창과 방문 기록에도 남지 않게 바로 지웁니다.
function takeInviteCode() {
  const code = location.hash.match(/^#invite=(.+)$/)?.[1];
  if (!code) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(code);
}

function takeSpotifyResult() {
  const result = new URLSearchParams(location.search).get('spotify');
  if (result) history.replaceState(null, '', location.pathname + location.hash);
  return SPOTIFY_MESSAGES[result] ?? null;
}

// 곡 제목과 이름은 외부 데이터이므로 innerHTML 없이 DOM 노드로만 만듭니다.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function countUp(node) {
  const target = Number(node.dataset.count);
  const startedAt = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / COUNT_UP_MS));
    node.textContent = number(Math.round(target * (1 - (1 - progress) ** 3)));
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 화면은 1분마다 다시 그려집니다. 등장 효과는 다른 화면으로 넘어갈 때만 보여 줍니다.
function paint(view, ...nodes) {
  const entering = view !== state.view;
  // 홈 → 친구 상세는 앞으로, 그 반대는 뒤로 미끄러집니다.
  const depth = (name) => (name?.startsWith('member') ? 1 : 0);
  const step = entering && state.view ? depth(view) - depth(state.view) : 0;
  state.view = view;
  app.classList.toggle('enter', entering);
  app.classList.toggle('push', step > 0);
  app.classList.toggle('pop', step < 0);
  app.replaceChildren(...nodes);
  if (entering && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    app.querySelectorAll('[data-count]').forEach(countUp);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? '요청을 처리하지 못했어요.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function savedCode() {
  try {
    return localStorage.getItem(CODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberCode(code) {
  try {
    if (code) localStorage.setItem(CODE_STORAGE_KEY, code);
    else localStorage.removeItem(CODE_STORAGE_KEY);
    // 홈 화면 앱에서 저장된 코드가 지워지지 않도록 요청합니다.
    if (code) navigator.storage?.persist?.().catch(() => {});
  } catch {
    // 저장하지 못하면 다음 방문 때 코드를 다시 입력하면 됩니다.
  }
}

function savedPending() {
  try {
    return localStorage.getItem(PENDING_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberPending(code) {
  state.pendingCode = code;
  try {
    if (code) localStorage.setItem(PENDING_STORAGE_KEY, code);
    else localStorage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    // 저장하지 못해도 이번 방문에서는 계속 기다릴 수 있습니다.
  }
}

// GitHub Pages에는 site.json 이 있고, 로컬 서버에는 없습니다.
let siteBuild = null;

async function fetchSiteConfig() {
  try {
    const response = await fetch(`site.json?t=${Date.now()}`, { cache: 'no-store' });
    const site = response.ok ? await response.json() : null;
    siteBuild = site?.build ?? null;
    return site;
  } catch {
    return null;
  }
}

async function fetchSealed(code) {
  try {
    const id = await groupFileId(code);
    const response = await fetch(`groups/${id}.enc?t=${Date.now()}`, { cache: 'no-store' });
    if (response.status === 404) return 'missing';
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function unlock(sealed, code) {
  state.snapshot = hideRemoved(await openSnapshot(sealed, code));
  state.snapshotCode = code;
  state.snapshotLoadedAt = Date.now();
}

// 관리자가 뺀 멤버는 수집과 배포가 끝나기 전에도 이 기기 화면에서 바로 숨깁니다.
// 새 기록에서 그 멤버가 사라지면 숨김 목록에서도 지웁니다.
const REMOVED_STORAGE_KEY = 'crossfade.removedMembers';
const REMOVED_KEEP_MS = 30 * 60 * 1000;

function removedMembers() {
  try {
    const list = JSON.parse(localStorage.getItem(REMOVED_STORAGE_KEY)) ?? [];
    return list.filter((entry) => Date.now() - entry.at < REMOVED_KEEP_MS);
  } catch {
    return [];
  }
}

function saveRemoved(list) {
  try {
    if (list.length) localStorage.setItem(REMOVED_STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(REMOVED_STORAGE_KEY);
  } catch {
    // 저장하지 못하면 이번 화면에서만 숨깁니다.
  }
}

function rememberRemoved(memberId) {
  saveRemoved([...removedMembers().filter((entry) => entry.id !== memberId), { id: memberId, at: Date.now() }]);
  if (state.snapshot) state.snapshot = hideRemoved(state.snapshot);
  state.live.delete(memberId);
}

function hideRemoved(snapshot) {
  const removed = removedMembers();
  const present = new Set(snapshot.overview[0].members.map((member) => member.id));
  const still = removed.filter((entry) => present.has(entry.id));
  if (still.length !== removed.length) saveRemoved(still);
  if (!still.length) return snapshot;
  const gone = new Set(still.map((entry) => entry.id));
  const keep = (id) => !gone.has(Number(id));
  const social = snapshot.social && {
    ...snapshot.social,
    members: Object.fromEntries(Object.entries(snapshot.social.members).filter(([id]) => keep(id))),
    activity: snapshot.social.activity.filter((item) => keep(item.memberId)),
    pairs: snapshot.social.pairs.filter((pair) => keep(pair.a) && keep(pair.b)),
    groupTop: Object.fromEntries(
      Object.entries(snapshot.social.groupTop).map(([kind, items]) => [
        kind,
        items.map((item) => ({ ...item, listeners: item.listeners.filter(keep) })).filter((item) => item.listeners.length),
      ]),
    ),
  };
  return {
    ...snapshot,
    social,
    liveTokens: Object.fromEntries(Object.entries(snapshot.liveTokens ?? {}).filter(([id]) => keep(id))),
    overview: snapshot.overview.map((week) => ({
      ...week,
      members: week.members.filter((member) => keep(member.id)),
      pairs: (week.pairs ?? []).filter((pair) => keep(pair.a) && keep(pair.b)),
    })),
    members: Object.fromEntries(Object.entries(snapshot.members).filter(([id]) => keep(id))),
  };
}

function invalidCode(message) {
  const error = new Error(message);
  error.invalid = true;
  return error;
}

async function unlockWithCode(code) {
  const sealed = await fetchSealed(code);
  if (sealed === 'missing') {
    const error = invalidCode('코드가 맞지 않거나, 아직 준비 중인 새 그룹이에요.');
    error.missing = true;
    throw error;
  }
  if (!sealed) throw new Error('기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  try {
    await unlock(sealed, code);
  } catch {
    throw invalidCode('초대 코드가 맞지 않아요.');
  }
  rememberCode(code);
  syncPush(code);
}

async function loadSession() {
  const site = await fetchSiteConfig();
  if (!site) return api('/api/session');

  state.connect = site.connect;
  state.openCode = site.openCode;
  state.pendingCode = savedPending();
  const session = { demo: false, spotifyLogin: false, static: true, authed: false };
  const saved = savedCode();
  let waiting = false;
  for (const code of [state.invite, saved]) {
    if (!code || session.authed || waiting) continue;
    try {
      await unlockWithCode(code);
      session.authed = true;
    } catch (failure) {
      if (code !== state.invite) {
        if (failure.invalid) rememberCode(null);
      } else if (failure.missing) {
        // 방금 만든 그룹의 초대 링크일 수 있습니다. 열릴 때까지 기다립니다.
        rememberPending(code);
        waiting = true;
      } else state.gateError = failure.message;
    }
  }
  // 만들고 있는 새 그룹이 없으면 코드 없이 공개 그룹으로 바로 들어옵니다.
  if (!session.authed && !state.pendingCode && !state.gateError && state.openCode) {
    await unlockWithCode(state.openCode);
    session.authed = true;
  }
  if (session.authed) state.gateError = null;
  state.invite = null;
  return session;
}

function createCode() {
  const letters = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => CODE_LETTERS[byte % CODE_LETTERS.length]);
  return [0, 4, 8, 12].map((start) => letters.slice(start, start + 4).join('')).join('-');
}

async function createGroup(error) {
  try {
    const code = createCode();
    await sendToCollector(state.connect, { kind: 'group', code });
    rememberPending(code);
    // 15분을 기다리지 않도록 수집을 바로 시작합니다.
    requestCollection(state.connect);
    render();
  } catch (failure) {
    error.textContent = failure.message;
  }
}

function leaveGroup() {
  if (!confirm('이 그룹에서 나가 다른 코드를 입력하거나 새 그룹을 만들까요?')) return;
  rememberCode(null);
  state.snapshot = null;
  state.session.authed = false;
  render();
}

async function completeSpotifyLogin() {
  const callback = state.spotifyCallback;
  if (!callback) return;
  state.spotifyCallback = null;
  try {
    const result = callback.code ? await finishSpotifyLogin(state.connect, state.snapshotCode, callback) : 'denied';
    state.flash = SPOTIFY_MESSAGES[result];
  } catch (failure) {
    state.flash = SPOTIFY_MESSAGES[failure.status === 403 ? 'notAllowed' : 'failed'];
  }
}

// 사이트가 열려 있는 상태에서 초대 링크를 연 경우입니다.
async function joinInvited(code) {
  try {
    await unlockWithCode(code);
    state.session.authed = true;
    state.flash = '초대받은 그룹으로 들어왔어요.';
  } catch (failure) {
    if (failure.missing) {
      rememberPending(code);
      state.snapshot = null;
      state.session.authed = false;
    } else if (state.session.authed) state.flash = failure.message;
    else state.gateError = failure.message;
  }
}

function inviteUrl(code) {
  const hash = code === state.openCode ? '' : `#invite=${encodeURIComponent(code)}`;
  return `${location.origin}${location.pathname}${hash}`;
}

function openInviteDialog(code = state.snapshotCode) {
  const url = inviteUrl(code);
  const open = code === state.openCode;
  const status = el('p', { class: 'form-status', role: 'status' });
  const link = el('input', { type: 'text', name: 'link', readonly: true, value: url, onfocus: () => link.select() });
  const copy = el(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          status.textContent = '링크를 복사했어요. 친구에게 붙여 넣어 보내 주세요.';
        } catch {
          link.select();
          status.textContent = document.execCommand?.('copy')
            ? '링크를 복사했어요. 친구에게 붙여 넣어 보내 주세요.'
            : '복사하지 못했어요. 위 링크를 길게 눌러 복사해 주세요.';
        }
      },
    },
    '링크 복사',
  );
  const share = navigator.share
    ? el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => navigator.share({ title: '크로스페이드 초대', url }).catch(() => {}),
        },
        '공유하기',
      )
    : null;
  const dialog = el(
    'dialog',
    { onclose: () => dialog.remove() },
    el('h2', {}, '친구 초대'),
    el('p', { class: 'dialog-note' }, '이 링크를 받은 친구는 누르기만 하면 바로 들어와요.'),
    el('label', { class: 'field' }, el('span', {}, '초대 링크'), link),
    open
      ? null
      : [
          el(
            'p',
            { class: 'dialog-note' },
            '홈 화면에 추가한 앱에서는 링크가 이어지지 않아요. 그때는 맨 아래 "다른 그룹으로 이동"을 누르고 이 코드를 입력하면 돼요.',
          ),
          el('p', { class: 'group-code' }, code),
        ],
    status,
    el(
      'div',
      { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '닫기'),
      share,
      copy,
    ),
  );
  document.body.append(dialog);
  dialog.showModal();
}

async function reloadSnapshot() {
  const sealed = await fetchSealed(state.snapshotCode);
  if (!sealed || sealed === 'missing') return false;
  try {
    await unlock(sealed, state.snapshotCode);
    return true;
  } catch {
    // 초대 코드가 바뀐 경우입니다.
    rememberCode(null);
    state.session.authed = false;
    return false;
  }
}

async function refreshSnapshot() {
  if (!state.snapshot || Date.now() - state.snapshotLoadedAt < SNAPSHOT_REFRESH_MS) return;
  await reloadSnapshot();
}

// 수집이 끝나 새 기록이 올라올 때까지 확인합니다.
function watchCollection(since, tries = COLLECT_WATCH_TRIES) {
  setTimeout(async () => {
    const loaded = await reloadSnapshot();
    if (!loaded || state.snapshot.generatedAt <= since) {
      if (tries > 1) return watchCollection(since, tries - 1);
      state.flash = '수집이 늦어지고 있어요. 잠시 후 다시 눌러 주세요.';
    } else {
      state.flash = '새 기록을 불러왔어요.';
    }
    state.collecting = false;
    render();
  }, COLLECT_WATCH_MS);
}

async function refreshNow(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.classList.add('busy');
  if (state.snapshot) {
    const before = state.snapshot.generatedAt;
    const [loaded, started] = await Promise.all([
      reloadSnapshot(),
      state.connect ? requestCollection(state.connect) : false,
      new Promise((resolve) => setTimeout(resolve, REFRESH_SPIN_MS)),
    ]);
    if (started) {
      state.collecting = true;
      watchCollection(state.snapshot.generatedAt);
    } else if (!loaded) state.flash = '기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
    else if (state.snapshot.generatedAt > before) state.flash = '새 기록을 불러왔어요.';
    else state.flash = `아직 새 기록이 없어요. 마지막 수집은 ${timeAgo(before)}이에요.`;
  }
  await render();
}

function hideStaleNowPlaying(data) {
  if (Date.now() / 1000 - state.snapshot.generatedAt < NOW_PLAYING_TTL_SECONDS) return data;
  return { ...data, members: data.members.map((member) => ({ ...member, nowPlaying: null })) };
}

const playSeconds = (plays) => plays.reduce((sum, play) => sum + (play.durationSec ?? ESTIMATED_TRACK_SECONDS), 0);

// 마지막 수집 뒤에 들은 곡입니다. 다음 수집 전까지 통계에 미리 더합니다.
function freshPlays(memberId) {
  const live = state.live.get(memberId);
  if (!state.snapshot || !live?.recent || Date.now() - live.at > LIVE_MAX_AGE_MS) return [];
  const collected = state.snapshot.overview[0].members.find((member) => member.id === memberId);
  const since = collected?.lastPlayed?.played_at ?? state.snapshot.generatedAt;
  return live.recent.filter((play) => play.played_at > since);
}

const addPlays = (stat, plays) => ({
  minutes: stat.minutes + Math.round(playSeconds(plays) / 60),
  plays: stat.plays + plays.length,
});

function withLive(data, week) {
  let fresh = [];
  const members = data.members.map((member) => {
    const live = state.live.get(member.id);
    if (!live || Date.now() - live.at > LIVE_MAX_AGE_MS) return member;
    const mine = week === 0 ? freshPlays(member.id) : [];
    fresh = fresh.concat(mine);
    return { ...member, ...addPlays(member, mine), nowPlaying: live.nowPlaying, lastPlayed: live.lastPlayed ?? member.lastPlayed };
  });
  members.sort((a, b) => b.minutes - a.minutes || b.plays - a.plays || a.id - b.id);
  return { ...data, members, group: { ...data.group, ...addPlays(data.group, fresh) } };
}

function liveSocial() {
  const social = state.snapshot?.social;
  if (!social) return null;
  const activity = [];
  const members = Object.fromEntries(
    Object.entries(social.members).map(([id, stat]) => {
      const fresh = freshPlays(Number(id));
      if (!fresh.length) return [id, stat];
      const extra = Math.round(playSeconds(fresh) / 60);
      for (const play of fresh) activity.push({ memberId: Number(id), track: play.track, artist: play.artist, image: play.image, playedAt: play.played_at });
      return [
        id,
        {
          ...stat,
          today: addPlays(stat.today, fresh),
          week: addPlays(stat.week, fresh),
          month: addPlays(stat.month, fresh),
          last30: addPlays(stat.last30, fresh),
          streak: stat.today.plays ? stat.streak : stat.streak + 1,
          days7: stat.days7.map((minutes, index) => (index === 6 ? minutes + extra : minutes)),
          weeks4: stat.weeks4.map((minutes, index) => (index === 3 ? minutes + extra : minutes)),
        },
      ];
    }),
  );
  activity.sort((a, b) => b.playedAt - a.playedAt);
  return { ...social, members, activity: [...activity, ...social.activity] };
}

// 지금 듣는 곡은 수집과 상관없이 바로 바꿉니다.
let lastLivePoll = 0;

async function pollLive() {
  const tokens = Object.entries(state.snapshot?.liveTokens ?? {});
  if (document.hidden || !state.connect || !tokens.length) return;
  // Luma·Aria를 보는 동안은 1분에 한 번만 확인합니다(Luma 친구 탭이 이 값을 씁니다).
  if (app.hidden && Date.now() - lastLivePoll < 2 * LIVE_REFRESH_MS - 1000) return;
  lastLivePoll = Date.now();
  const results = await Promise.all(tokens.map(async ([id, token]) => [Number(id), await fetchLive(state.connect, token)]));
  let changed = false;
  for (const [id, live] of results) {
    if (!live) continue;
    const before = state.live.get(id);
    changed ||= JSON.stringify([before?.nowPlaying, before?.lastPlayed]) !== JSON.stringify([live.nowPlaying, live.lastPlayed]);
    state.live.set(id, { ...live, at: Date.now() });
  }
  if (changed && /^(home|member):/.test(state.view ?? '')) render();
}

async function readOverview(week) {
  if (state.snapshot) return withLive(hideStaleNowPlaying(state.snapshot.overview[week]), week);
  return api(`/api/overview?week=${week}`);
}

async function readMember(id, week) {
  if (!state.snapshot) return api(`/api/member?id=${id}&week=${week}`);
  const detail = state.snapshot.members[id]?.[week];
  if (!detail) throw new Error('친구를 찾을 수 없어요.');
  const fresh = week === 0 ? freshPlays(Number(id)) : [];
  if (!fresh.length) return detail;
  return {
    ...detail,
    ...addPlays(detail, fresh),
    recent: [...fresh.map((play) => ({ track: play.track, artist: play.artist, image: play.image, playedAt: play.played_at })), ...detail.recent],
  };
}

const number = (value) => value.toLocaleString('ko-KR');

const counted = (value, tag = 'b') => el(tag, { 'data-count': value }, number(value));

function hoursLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  return hours ? `${number(hours)}시간 ${minutes % 60}분` : `${minutes}분`;
}

function weekName(offset) {
  if (offset === 0) return '이번 주';
  if (offset === 1) return '지난주';
  return `${offset}주 전`;
}

const weekDates = (week) =>
  `${week.startsOn.month}월 ${week.startsOn.day}일 – ${week.endsOn.month}월 ${week.endsOn.day}일`;

function timeAgo(seconds) {
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

function cover(item, small = false) {
  const initial = (item.artist ?? '?').trim().charAt(0).toUpperCase();
  const image = item.image ? el('img', { src: item.image, alt: '', loading: 'lazy' }) : initial;
  const size = small ? 'cover small' : 'cover';
  if (!item.track || !state.session?.static) return el('span', { class: size, 'aria-hidden': 'true' }, image);
  // 곡 표지를 누르면 내 Spotify 계정으로 Luma에서 재생합니다. 카드 링크 안에 있어도 링크로 넘어가지 않게 막습니다.
  const play = (event) => {
    event.preventDefault();
    event.stopPropagation();
    playInLuma(item);
  };
  return el(
    'span',
    {
      class: `${size} playable`,
      role: 'button',
      tabindex: '0',
      title: '내 Spotify로 재생',
      'aria-label': `${item.track} - ${item.artist} 재생`,
      onclick: play,
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') play(event);
      },
    },
    image,
    el('span', { class: 'play-badge', 'aria-hidden': 'true' }, '▶'),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 친구가 들은 곡은 내가 로그인해 둔 플레이어에서 틉니다. 둘 다 아니면 Aria를 엽니다.
function preferredPlayer() {
  try {
    if (localStorage.getItem(PLAYERS.aria.tokenKey)) return 'aria';
    if (localStorage.getItem(PLAYERS.luma.tokenKey)) return 'luma';
  } catch {
    // 저장소를 못 읽으면 기본 값
  }
  return 'aria';
}

async function playInLuma(item) {
  const name = preferredPlayer();
  if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
  showPlayer(name);
  const frame = playerViews[name].querySelector('iframe');
  for (let tries = 0; tries < 100; tries += 1) {
    const play = name === 'aria' ? frame.contentWindow?.ariaPlay : frame.contentWindow?.cfLumaPlay;
    if (play) return play(item.artist, item.track);
    await sleep(200);
  }
}

// Luma의 친구 탭이 읽는 값입니다. 크로스페이드 홈과 같은 실시간 기록을 넘깁니다.
window.crossfadeFriends = () => {
  if (!state.snapshot) return null;
  const overview = withLive(hideStaleNowPlaying(state.snapshot.overview[0]), 0);
  const social = liveSocial();
  const song = (item) => item && { track: item.track, artist: item.artist, image: item.image ?? '', playedAt: item.played_at ?? item.playedAt ?? null };
  return JSON.parse(
    JSON.stringify({
      generatedAt: state.snapshot.generatedAt,
      members: overview.members.map((member) => ({
        id: member.id,
        name: member.name,
        nowPlaying: song(member.nowPlaying),
        lastPlayed: song(member.lastPlayed),
        weekMinutes: member.minutes,
        todayMinutes: social?.members[member.id]?.today.minutes ?? 0,
        streak: social?.members[member.id]?.streak ?? 0,
      })),
      activity: (social?.activity ?? []).slice(0, 40).map((item) => ({ memberId: item.memberId, ...song(item) })),
      topTracks: (social?.groupTop.tracks ?? []).slice(0, 10).map((item) => ({ ...song(item), plays: item.plays })),
    }),
  );
};

const equalizer = () => el('span', { class: 'eq', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));

// 위쪽 가운데에 떠 있는 크로스페이드 | Luma | Aria 막대입니다. Luma의 탭바처럼 누르거나 끌어서 넘깁니다.
const APPS = [
  {
    id: 'crossfade',
    label: '크로스페이드',
    icon: ['M12.5 8.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z', 'M2.5 19.5c.6-3.3 3.2-5.5 6.5-5.5s5.9 2.2 6.5 5.5', 'M15.5 5.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.3c1.9.7 3.2 2.6 3.5 5.2'],
  },
  {
    id: 'luma',
    label: 'Luma',
    icon: ['M11 3.5c.6 4 2.5 5.9 6.5 6.5-4 .6-5.9 2.5-6.5 6.5-.6-4-2.5-5.9-6.5-6.5 4-.6 5.9-2.5 6.5-6.5z', 'M18.5 15c.3 1.7 1 2.4 2.5 2.7-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.7z'],
  },
  {
    id: 'aria',
    label: 'Aria',
    icon: ['M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 17.5V6l11-2.5v11.5', 'M20 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M9 9.5l11-2.5'],
  },
];

function currentApp() {
  const name = location.hash.match(/^#\/(\w+)$/)?.[1];
  return Object.hasOwn(PLAYERS, name ?? '') ? name : 'crossfade';
}

const playerViews = {};
let switchingApps = false;

const pager = createPager({
  apps: APPS,
  current: currentApp,
  // near 이면 끄는 동안 함께 움직일 화면이 필요하므로 아직 안 연 플레이어도 엽니다.
  layer(name, near) {
    if (name === 'crossfade') return app;
    return near || playerViews[name] ? playerView(name) : null;
  },
  commit(name) {
    switchingApps = true;
    location.hash = name === 'crossfade' ? '#/' : `#/${name}`;
  },
  // Aria 안에서 뒤로 갈 화면이 있으면 왼쪽 가장자리 끌기는 Aria가 씁니다.
  delegate(name) {
    if (name !== 'aria') return null;
    try {
      const back = playerViews.aria?.querySelector('iframe')?.contentWindow?.ariaBack;
      return back?.can() ? back : null;
    } catch {
      return null;
    }
  },
});

document.body.append(el('div', { class: 'dock-row' }, pager.dock));
// 친구 상세를 보다가 크로스페이드를 다시 누르면 홈으로 갑니다.
pager.dock.addEventListener('click', (event) => {
  if (event.target.closest('button')?.dataset.app === 'crossfade' && currentApp() === 'crossfade' && location.hash.startsWith('#/member')) location.hash = '#/';
});

// 휴대폰에서는 크로스페이드 화면 어디서나, Luma·Aria 위에서는 양쪽 가장자리를 끌어 넘깁니다.
pager.attachSwipe(app, { touchOnly: true });
for (const side of ['left', 'right']) {
  const strip = el('div', { class: `edge-swipe ${side}`, 'aria-hidden': 'true' });
  document.body.append(strip);
  pager.attachSwipe(strip, { edge: side });
}

// 플레이어에서 재생 화면을 열면 위쪽 막대를 치워 재생 화면이 창 전체를 씁니다.
const fullscreen = {};
function applyFullscreen() {
  document.documentElement.classList.toggle('player-full', Boolean(fullscreen[currentApp()]));
}

function watchFullscreen(name, frame) {
  frame.addEventListener('load', () => {
    let body;
    try {
      body = frame.contentDocument?.body;
    } catch {
      return;
    }
    if (!body) return;
    // Aria는 np-open, Luma는 player-open 을 몸체에 붙입니다.
    const update = () => {
      fullscreen[name] = body.classList.contains('np-open') || body.classList.contains('player-open');
      applyFullscreen();
    };
    new MutationObserver(update).observe(body, { attributes: true, attributeFilter: ['class'] });
    update();
  });
}

function playerView(name) {
  if (!playerViews[name]) {
    const player = PLAYERS[name];
    // 버전(v)을 붙여 기기에 남은 예전 플레이어 파일을 쓰지 않게 합니다. 로그인 결과(code, state)도 함께 넘깁니다.
    const params = new URLSearchParams(playerCallback?.name === name ? playerCallback.search : '');
    params.set('v', siteBuild ?? String(Math.floor(Date.now() / 60000)));
    const search = `?${params}`;
    const frame = el('iframe', {
      class: 'luma-frame',
      title: player.title,
      src: `${player.path}${search}`,
      allow: 'autoplay; encrypted-media; fullscreen; clipboard-write; picture-in-picture',
    });
    watchFullscreen(name, frame);
    playerViews[name] = el('div', { class: `luma-view ${player.dark ? 'dark' : 'system'}`, hidden: true }, frame);
    document.body.append(playerViews[name]);
  }
  return playerViews[name];
}

// name 이 없으면 크로스페이드를 보여 줍니다.
function showPlayer(name) {
  if (name) playerView(name);
  for (const [key, view] of Object.entries(playerViews)) view.hidden = key !== name;
  document.documentElement.dataset.app = name ?? 'crossfade';
  app.hidden = Boolean(name);
  document.documentElement.classList.toggle('luma-open', Boolean(name));
  document.title = name ? `${PLAYERS[name].title} · 크로스페이드` : '크로스페이드';
  applyFullscreen();
  pager.sync();
}

function header() {
  return el(
    'header',
    { class: 'topbar' },
    el('span', { class: 'brand' }, el('img', { src: 'favicon.svg', alt: '' }), '크로스페이드'),
    el(
      'div',
      { class: 'topbar-actions' },
      el(
        'button',
        {
          class: `btn icon${state.collecting ? ' busy' : ''}`,
          type: 'button',
          title: '새로고침',
          'aria-label': '새로고침',
          disabled: state.collecting,
          onclick: refreshNow,
        },
        el('span', { class: 'refresh-icon', 'aria-hidden': 'true' }, '↻'),
      ),
      state.session.static ? el('button', { class: 'btn', type: 'button', onclick: () => openInviteDialog() }, '초대 링크') : null,
      el('button', { class: 'btn primary', type: 'button', onclick: openAddDialog }, '친구 추가'),
    ),
  );
}

function demoNotice() {
  if (state.flash) return el('p', { class: 'notice', role: 'status' }, state.flash);
  if (state.collecting) return el('p', { class: 'notice', role: 'status' }, '새 기록을 모으는 중이에요. 몇 분 뒤 자동으로 바뀌어요.');
  if (state.snapshot) {
    return [
      el(
        'p',
        { class: 'notice' },
        el('strong', {}, `${timeAgo(state.snapshot.generatedAt)} 업데이트됨. `),
        '기록은 15분쯤마다 모으며, 더 늦어질 수도 있어요.',
        state.snapshotCode === state.openCode ? ' 이 그룹은 주소를 아는 사람 누구나 볼 수 있어요.' : '',
      ),
    ].flat();
  }
  if (!state.session.demo) return null;
  return el(
    'p',
    { class: 'notice' },
    el('strong', {}, '샘플 데이터로 보는 중이에요. '),
    '.env 파일에 Last.fm API 키를 넣으면 실제 청취 기록으로 바뀝니다.',
  );
}

function weekNav(week, onChange) {
  return el(
    'div',
    { class: 'week-nav' },
    el(
      'button',
      {
        type: 'button',
        'aria-label': '이전 주',
        disabled: week.offset >= MAX_WEEKS_BACK,
        onclick: () => onChange(week.offset + 1),
      },
      '‹',
    ),
    el('strong', {}, weekName(week.offset)),
    el(
      'button',
      {
        type: 'button',
        'aria-label': '다음 주',
        disabled: week.offset <= 0,
        onclick: () => onChange(week.offset - 1),
      },
      '›',
    ),
    el('span', {}, weekDates(week)),
  );
}

function nowPlayingSection(members) {
  const sorted = [...members].sort((a, b) => Number(Boolean(b.nowPlaying)) - Number(Boolean(a.nowPlaying)));
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('h2', {}, '지금 듣는 중'),
      el('span', {}, `${members.filter((m) => m.nowPlaying).length}명 재생 중`),
    ),
    el(
      'div',
      { class: 'playing-grid' },
      sorted.map((member) => {
        const item = member.nowPlaying ?? member.lastPlayed;
        return el(
          'a',
          { class: `card playing${member.nowPlaying ? ' live' : ''}`, href: `#/member/${member.id}` },
          item ? cover(item) : el('span', { class: 'cover' }, '–'),
          el(
            'span',
            { style: { minWidth: '0' } },
            el(
              'span',
              { class: 'who' },
              member.nowPlaying ? equalizer() : null,
              member.nowPlaying
                ? member.name
                : `${member.name} · ${item ? timeAgo(item.played_at) : '기록 없음'}`,
            ),
            el('div', { class: 'title-line' }, item?.track ?? '아직 기록이 없어요'),
            el('div', { class: 'sub-line' }, item?.artist ?? ''),
          ),
        );
      }),
    ),
  );
}

function deltaLabel(member) {
  if (!member.previousMinutes) return null;
  const change = member.minutes - member.previousMinutes;
  const percent = Math.round((change / member.previousMinutes) * 100);
  if (percent === 0) return el('span', { class: 'delta' }, '지난주와 같음');
  const up = percent > 0;
  return el('span', { class: `delta${up ? ' up' : ''}` }, `${up ? '▲' : '▼'} ${Math.abs(percent)}%`);
}

const PERIOD_NAMES = { today: '오늘', week: '이번 주', month: '이번 달' };
const METRIC_NAMES = { minutes: '재생 시간', plays: '재생 횟수' };

function segments(options, current, onPick) {
  return el(
    'div',
    { class: 'segments', role: 'group' },
    Object.entries(options).map(([value, label]) =>
      el(
        'button',
        { type: 'button', class: value === current ? 'on' : null, 'aria-pressed': String(value === current), onclick: () => onPick(value) },
        label,
      ),
    ),
  );
}

const streakBadge = (days) => (days >= 2 ? el('span', { class: 'streak', title: `${days}일 연속으로 들었어요` }, `🔥 ${days}`) : null);

function rankingSection(data, social) {
  const { week } = data;
  const live = Boolean(social) && week.offset === 0;
  const period = live ? state.rankPeriod : 'week';
  const metric = state.rankMetric;
  const statOf = (member) => (live ? social.members[member.id]?.[period] ?? { minutes: 0, plays: 0 } : member);
  const members = [...data.members].sort(
    (a, b) => statOf(b)[metric] - statOf(a)[metric] || statOf(b).minutes - statOf(a).minutes || a.id - b.id,
  );
  const max = Math.max(1, ...members.map((member) => statOf(member)[metric]));
  const estimated = data.group.plays ? Math.round((data.group.estimatedPlays / data.group.plays) * 100) : 0;
  const pick = (key) => (value) => {
    state[key] = value;
    render();
  };

  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('h2', {}, live ? `${PERIOD_NAMES[period]} 순위` : `${weekName(week.offset)} 랭킹`),
    ),
    el(
      'div',
      { class: 'rank-controls' },
      live ? segments(PERIOD_NAMES, period, pick('rankPeriod')) : null,
      segments(METRIC_NAMES, metric, pick('rankMetric')),
    ),
    el(
      'ol',
      { class: 'card rank-list' },
      members.map((member, index) => {
        const stat = statOf(member);
        const streak = social?.members[member.id]?.streak ?? 0;
        const value = metric === 'minutes' ? `${number(stat.minutes)}분` : `${number(stat.plays)}회`;
        const other = metric === 'minutes' ? `${number(stat.plays)}회` : `${number(stat.minutes)}분`;
        return el(
          'li',
          {},
          el(
            'a',
            { class: 'rank-row', href: `#/member/${member.id}` },
            el('span', { class: 'rank-no' }, String(index + 1)),
            el(
              'span',
              { class: 'rank-name' },
              el('b', {}, member.name, live ? streakBadge(streak) : null),
            ),
            el(
              'span',
              {
                class: 'rank-bar',
                'data-tip': `${member.name}: ${number(stat.minutes)}분 · ${number(stat.plays)}회 재생`,
              },
              el(
                'div',
                { class: 'bar-track', 'aria-hidden': 'true' },
                el('div', {
                  class: 'bar-fill spotify',
                  style: { width: `${(stat[metric] / max) * 100}%`, animationDelay: `${300 + index * 70}ms` },
                }),
              ),
              el(
                'div',
                { class: 'sub-line' },
                period === 'week'
                  ? member.topTrack
                    ? `가장 많이 들은 곡: ${member.topTrack.track}`
                    : '이번 주 기록이 없어요'
                  : '',
              ),
            ),
            el(
              'span',
              { class: 'rank-values' },
              el('b', {}, value),
              el(
                'span',
                {},
                period === 'week' ? `${other} · ${number(member.uniqueTracks)}곡 ` : other,
                period === 'week' && metric === 'minutes' ? deltaLabel(member) : null,
              ),
            ),
          ),
        );
      }),
    ),
    el(
      'p',
      { class: 'footnote' },
      '청취 시간은 재생한 곡의 전체 길이를 더한 값이라 실제와 조금 다를 수 있어요.',
      period === 'week' ? (week.offset === 0 ? ' 증감은 지난주 같은 시점까지와 비교한 값이에요.' : ' 증감은 그 전 주와 비교한 값이에요.') : '',
      live ? ' 🔥는 며칠 연속으로 들었는지예요.' : '',
      estimated ? ` 재생 기록의 ${estimated}%는 곡 길이를 몰라 3분 30초로 계산했어요.` : '',
    ),
  );
}

function friendsSummary(data, social) {
  if (!social || data.week.offset !== 0 || !data.members.length) return null;
  const best = (score) => [...data.members].sort((a, b) => score(b) - score(a))[0];
  const weekly = best((member) => social.members[member.id]?.week.minutes ?? 0);
  const streaky = best((member) => social.members[member.id]?.streak ?? 0);
  const playing = data.members.filter((member) => member.nowPlaying);
  const weeklyMinutes = social.members[weekly.id]?.week.minutes ?? 0;
  const streakDays = social.members[streaky.id]?.streak ?? 0;
  const card = (label, value, detail) =>
    el('div', { class: 'card stat' }, el('span', {}, label), el('b', {}, value), el('span', {}, detail));
  return el(
    'div',
    { class: 'stat-row three section' },
    card('이번 주 1등', weeklyMinutes ? weekly.name : '–', weeklyMinutes ? `${number(weeklyMinutes)}분` : '아직 기록이 없어요'),
    card('연속 기록 1등', streakDays ? streaky.name : '–', streakDays ? `🔥 ${streakDays}일 연속` : '아직 기록이 없어요'),
    card(
      '지금 듣는 친구',
      `${playing.length}명`,
      playing.length ? playing.map((member) => member.name).join(', ') : '지금은 조용해요',
    ),
  );
}

const ACTIVITY_PREVIEW = 8;

const searchText = (item) => encodeURIComponent(`${item.track} ${item.artist}`);

// ▶ 는 내 Spotify 계정으로 Luma에서 바로 틀고, Spotify 는 Spotify 앱·웹에서 같은 곡을 찾습니다.
function listenLinks(item) {
  return el(
    'span',
    { class: 'listen-links' },
    state.session?.static
      ? el(
          'button',
          {
            class: 'link-button play-link',
            type: 'button',
            onclick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              playInLuma(item);
            },
          },
          '▶ 재생',
        )
      : null,
    el('a', { href: `https://open.spotify.com/search/${searchText(item)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Spotify'),
  );
}

const nameIn = (data) => {
  const names = new Map(data.members.map((member) => [member.id, member.name]));
  return (id) => names.get(id) ?? '나간 친구';
};

function activitySection(data, social) {
  if (!social?.activity.length || data.week.offset !== 0) return null;
  const nameOf = nameIn(data);
  return el(
    'section',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, '최근 활동'), el('span', {}, '친구들이 최근 들은 곡')),
    el(
      'ul',
      { class: 'card list no-rank activity' },
      social.activity.slice(0, state.activityAll ? social.activity.length : ACTIVITY_PREVIEW).map((item) =>
        el(
          'li',
          {},
          cover(item, true),
          el(
            'span',
            { style: { minWidth: '0' } },
            el('div', { class: 'title-line' }, item.track),
            el('div', { class: 'sub-line' }, el('a', { class: 'who-link', href: `#/member/${item.memberId}` }, nameOf(item.memberId)), ` · ${item.artist}`),
          ),
          el('span', { class: 'count' }, timeAgo(item.playedAt), listenLinks(item)),
        ),
      ),
    ),
    social.activity.length > ACTIVITY_PREVIEW
      ? el(
          'button',
          {
            class: 'link-button more',
            type: 'button',
            onclick: () => {
              state.activityAll = !state.activityAll;
              render();
            },
          },
          state.activityAll ? '접기' : `더 보기 (${social.activity.length - ACTIVITY_PREVIEW}곡)`,
        )
      : null,
  );
}

function groupTopSection(data, social) {
  if (!social || data.week.offset !== 0) return null;
  const nameOf = nameIn(data);
  const who = (item) => item.listeners.map(nameOf).join(', ');
  return el(
    'div',
    { class: 'two-col section' },
    el(
      'section',
      {},
      el('div', { class: 'section-head' }, el('h2', {}, '이번 주 우리가 많이 들은 곡')),
      rankedList(
        social.groupTop.tracks,
        (item) =>
          el('span', { style: { minWidth: '0' } }, el('div', { class: 'title-line' }, item.track), el('div', { class: 'sub-line' }, `${item.artist} · ${who(item)}`)),
        '이번 주에는 기록이 없어요.',
      ),
    ),
    el(
      'section',
      {},
      el('div', { class: 'section-head' }, el('h2', {}, '이번 주 우리가 많이 들은 아티스트')),
      rankedList(
        social.groupTop.artists,
        (item) => el('span', { style: { minWidth: '0' } }, el('div', { class: 'title-line' }, item.artist), el('div', { class: 'sub-line' }, who(item))),
        '이번 주에는 기록이 없어요.',
      ),
    ),
  );
}

function barChart(values, labels, tipOf, columns = values.length) {
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const grid = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'day-chart', style: grid },
      values.map((minutes, index) =>
        el(
          'div',
          { class: 'day-col', 'data-tip': tipOf(index, minutes) },
          index === peak && minutes > 0 ? el('em', {}, `${number(minutes)}분`) : null,
          el('i', { style: { height: `${(minutes / max) * 82}%`, animationDelay: `${300 + index * 45}ms` } }),
        ),
      ),
    ),
    el('div', { class: 'day-labels', style: grid }, labels.map((label) => el('span', {}, label))),
  );
}

function compareSection(member, data, social) {
  const others = data.members.filter((other) => other.id !== member.id);
  if (!others.length) return null;
  const otherId = others.some((other) => other.id === state.compareWith) ? state.compareWith : others[0].id;
  const other = others.find((candidate) => candidate.id === otherId);
  const pair = social.pairs.find((p) => (p.a === member.id && p.b === otherId) || (p.b === member.id && p.a === otherId));
  const select = el(
    'select',
    {
      class: 'compare-select',
      'aria-label': '비교할 친구',
      onchange: (event) => {
        state.compareWith = Number(event.currentTarget.value);
        render();
      },
    },
    others.map((candidate) => el('option', { value: candidate.id, selected: candidate.id === otherId }, candidate.name)),
  );
  const mine = social.members[member.id];
  const theirs = social.members[otherId];
  const versus = (label, key) =>
    el('div', { class: 'versus' }, el('span', {}, label), el('b', {}, `${number(mine[key].minutes)}분`), el('i', {}, 'vs'), el('b', {}, `${number(theirs[key].minutes)}분`));

  return el(
    'section',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, '취향 궁합'), select),
    el(
      'div',
      { class: 'card chart-card compare' },
      pair
        ? [
            el(
              'div',
              { class: 'compare-scores' },
              el('div', {}, el('b', {}, `${pair.score}%`), el('span', {}, '아티스트 궁합')),
              el('div', {}, el('b', {}, `${pair.hourScore}%`), el('span', {}, '듣는 시간대 궁합')),
            ),
            pair.sharedArtists.length
              ? el('div', { class: 'chips' }, pair.sharedArtists.map((artist) => el('span', { class: 'chip' }, artist)))
              : el('p', { class: 'pair-tracks' }, '같이 좋아하는 아티스트가 아직 없어요'),
            pair.sharedTracks.length
              ? el('p', { class: 'pair-tracks' }, `둘 다 들은 곡: ${pair.sharedTracks.map((t) => t.track).join(', ')}`)
              : null,
          ]
        : el('p', { class: 'pair-tracks' }, '최근 30일 기록이 더 쌓이면 궁합을 보여 줄게요.'),
      el('h3', { class: 'compare-title' }, `${member.name} vs ${other.name} 재생 시간`),
      versus('오늘', 'today'),
      versus('이번 주', 'week'),
      versus('이번 달', 'month'),
      el('h3', { class: 'compare-title' }, '듣는 시간대 (최근 30일)'),
      el('p', { class: 'hour-who' }, member.name),
      hourStrip(mine.byHour30, false),
      el('p', { class: 'hour-who' }, other.name),
      hourStrip(theirs.byHour30, false),
    ),
  );
}

function memberSocial(id, data, current) {
  const social = liveSocial();
  const mine = social?.members[id];
  if (!mine) return null;
  const today = new Date();
  const dayLabels = mine.days7.map((_, i) => {
    const date = new Date(today.getTime() - (6 - i) * 86_400_000);
    return i === 6 ? '오늘' : DAY_NAMES[(date.getDay() + 6) % 7];
  });
  const weekLabels = ['3주 전', '2주 전', '지난주', '이번 주'];
  const playing = current?.nowPlaying ?? current?.lastPlayed;
  return [
    playing
      ? el(
          'div',
          { class: 'card now-card section' },
          cover(playing),
          el(
            'span',
            { style: { minWidth: '0' } },
            el('span', { class: 'who' }, current.nowPlaying ? [equalizer(), ' 지금 듣는 중'] : `마지막으로 들은 곡 · ${timeAgo(playing.played_at)}`),
            el('div', { class: 'title-line' }, playing.track),
            el('div', { class: 'sub-line' }, playing.artist),
          ),
          el('span', { class: 'now-listen' }, el('span', {}, '같이 듣기'), listenLinks(playing)),
        )
      : null,
    el(
      'div',
      { class: 'stat-row three' },
      [
        [mine.month.minutes, '이번 달(분)'],
        [mine.last30.minutes, '최근 30일(분)'],
        [mine.streak, '연속으로 들은 날'],
      ].map(([value, label]) => el('div', { class: 'card stat' }, counted(value), el('span', {}, label))),
    ),
    el(
      'div',
      { class: 'two-col section' },
      el(
        'section',
        {},
        el('div', { class: 'section-head' }, el('h2', {}, '최근 7일')),
        el('div', { class: 'card chart-card' }, barChart(mine.days7, dayLabels, (i, m) => `${dayLabels[i]}: ${number(m)}분`)),
      ),
      el(
        'section',
        {},
        el('div', { class: 'section-head' }, el('h2', {}, '최근 4주')),
        el('div', { class: 'card chart-card' }, barChart(mine.weeks4, weekLabels, (i, m) => `${weekLabels[i]}: ${number(m)}분`)),
      ),
    ),
    mine.topArtists30.length
      ? el(
          'section',
          { class: 'section' },
          el('div', { class: 'section-head' }, el('h2', {}, '요즘 많이 듣는 아티스트'), el('span', {}, '최근 30일')),
          el('div', { class: 'chips' }, mine.topArtists30.map((item) => el('span', { class: 'chip' }, `${item.artist} · ${number(item.plays)}회`))),
        )
      : null,
    compareSection({ id: Number(id), name: data.name }, current?.overview ?? { members: [] }, social),
  ];
}

function tasteSection(data) {
  const nameOf = (id) => data.members.find((m) => m.id === id);
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('h2', {}, '음악 취향 겹침'),
      el('span', {}, `최근 ${data.tasteWeeks}주 기준`),
    ),
    data.pairs.length
      ? el(
          'div',
          { class: 'taste-grid' },
          data.pairs.map((pair, index) => {
            const a = nameOf(pair.a);
            const b = nameOf(pair.b);
            return el(
              'article',
              { class: 'card pair' },
              el(
                'div',
                { class: 'pair-top' },
                el(
                  'div',
                  { class: 'pair-names' },
                  `${a.name} · ${b.name}`,
                ),
                el('div', { class: 'pair-score' }, String(pair.score), el('small', {}, '%')),
              ),
              el('div', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: { width: `${pair.score}%`, animationDelay: `${400 + index * 70}ms` } })),
              pair.sharedArtists.length
                ? el(
                    'div',
                    { class: 'chips' },
                    pair.sharedArtists.map((artist) => el('span', { class: 'chip' }, artist)),
                  )
                : el('p', { class: 'pair-tracks' }, '아직 겹치는 아티스트가 없어요'),
              pair.sharedTracks.length
                ? el(
                    'p',
                    { class: 'pair-tracks' },
                    `함께 들은 곡: ${pair.sharedTracks
                      .slice(0, 3)
                      .map((t) => t.track)
                      .join(', ')}`,
                  )
                : null,
            );
          }),
        )
      : el('div', { class: 'card empty' }, '아직 취향이 겹치는 친구가 없어요. 기록이 쌓이면 여기에 나타나요.'),
  );
}

function emptyHome() {
  return el(
    'div',
    { class: 'card empty' },
    el('p', {}, '아직 그룹에 아무도 없어요. 첫 번째 친구를 추가해 보세요.'),
    el('p', { style: { marginTop: '14px' } }, el('button', { class: 'btn primary', type: 'button', onclick: openAddDialog }, '친구 추가')),
  );
}

async function renderHome() {
  const data = await readOverview(state.week);
  const { group, members, week } = data;
  const social = liveSocial();
  const changeWeek = (offset) => {
    state.week = offset;
    render();
  };

  paint(
    `home:${state.week}`,
    el(
      'main',
      { class: 'shell' },
      header(),
      demoNotice(),
      state.snapshot?.announcement ? el('p', { class: 'announcement', role: 'note' }, `📢 ${state.snapshot.announcement}`) : null,
      el(
        'section',
        { class: 'hero' },
        weekNav(week, changeWeek),
        el(
          'div',
          {},
          el('div', { class: 'hero-number' }, counted(group.minutes, 'span'), el('small', {}, '분')),
          el(
            'p',
            { class: 'hero-caption' },
            `우리 그룹이 ${weekName(week.offset)} 함께 들은 시간 · ${hoursLabel(group.minutes)}`,
          ),
        ),
        el(
          'div',
          { class: 'hero-facts' },
          el('div', { class: 'fact' }, counted(group.plays), el('span', {}, '총 재생')),
          el('div', { class: 'fact' }, counted(group.uniqueTracks), el('span', {}, '서로 다른 곡')),
          el('div', { class: 'fact' }, counted(members.length), el('span', {}, '친구')),
        ),
      ),
      members.length
        ? [
            friendsSummary(data, social),
            nowPlayingSection(members),
            rankingSection(data, social),
            activitySection(data, social),
            groupTopSection(data, social),
            tasteSection(data),
          ]
        : emptyHome(),
      state.session.static
        ? el(
            'p',
            { class: 'footnote footer-links' },
            state.connect ? el('button', { class: 'link-button', type: 'button', onclick: openNotifyDialog }, '알림 설정') : null,
            el('button', { class: 'link-button', type: 'button', onclick: leaveGroup }, '다른 그룹으로 이동'),
            el('a', { class: 'link-button', href: '#/admin' }, '관리자'),
          )
        : null,
    ),
  );
}

function dayChart(byDay) {
  const max = Math.max(1, ...byDay);
  const peak = byDay.indexOf(Math.max(...byDay));
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'day-chart' },
      byDay.map((minutes, index) =>
        el(
          'div',
          { class: 'day-col', 'data-tip': `${DAY_NAMES[index]}요일: ${number(minutes)}분` },
          index === peak && minutes > 0 ? el('em', {}, `${number(minutes)}분`) : null,
          el('i', { style: { height: `${(minutes / max) * 82}%`, animationDelay: `${300 + index * 45}ms` } }),
        ),
      ),
    ),
    el('div', { class: 'day-labels' }, DAY_NAMES.map((name) => el('span', {}, name))),
  );
}

function hourStrip(byHour, withLabels = true) {
  const max = Math.max(1, ...byHour);
  const peak = byHour.indexOf(Math.max(...byHour));
  const level = (minutes) => (minutes === 0 ? 0 : Math.max(1, Math.ceil((minutes / max) * 5)));
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'hour-strip' },
      byHour.map((minutes, hour) =>
        el('i', {
          class: `heat-${level(minutes)}`,
          'data-tip': `${hour}시대: ${number(minutes)}분`,
          style: { animationDelay: `${300 + hour * 15}ms` },
        }),
      ),
    ),
    el(
      'div',
      { class: 'hour-labels' },
      ['0시', '6시', '12시', '18시', '24시'].map((label) => el('span', {}, label)),
    ),
    withLabels && byHour[peak] > 0 ? el('p', { class: 'peak-note' }, `가장 많이 듣는 시간은 ${peak}시대예요.`) : null,
  );
}

function rankedList(items, renderTitle, emptyText) {
  if (!items.length) return el('div', { class: 'card empty' }, emptyText);
  return el(
    'ol',
    { class: 'card list' },
    items.map((item, index) =>
      el(
        'li',
        {},
        el('span', { class: 'no' }, String(index + 1)),
        cover(item, true),
        renderTitle(item),
        el('span', { class: 'count' }, `${number(item.plays)}회`),
      ),
    ),
  );
}

async function renderMember(id) {
  const data = await readMember(id, state.week);
  const overview = state.snapshot ? await readOverview(0) : null;
  const current = overview ? { ...overview.members.find((member) => member.id === Number(id)), overview } : null;
  const changeWeek = (offset) => {
    state.week = offset;
    render();
  };

  const trackTitle = (item) =>
    el('span', { style: { minWidth: '0' } }, el('div', { class: 'title-line' }, item.track), el('div', { class: 'sub-line' }, item.artist));
  const artistTitle = (item) =>
    el(
      'span',
      { style: { minWidth: '0' } },
      el('div', { class: 'title-line' }, item.artist),
      el('div', { class: 'sub-line' }, `${number(item.minutes)}분`),
    );

  paint(
    `member:${id}:${state.week}`,
    el(
      'main',
      { class: 'shell' },
      header(),
      el('a', { class: 'back', href: '#/' }, '‹ 전체 보기'),
      el(
        'div',
        { class: 'detail-head' },
        el('div', {}, el('h1', {}, data.name)),
        weekNav(data.week, changeWeek),
      ),
      el(
        'div',
        { class: 'stat-row' },
        [
          [data.minutes, '청취 시간(분)'],
          [data.plays, '재생 횟수'],
          [data.uniqueTracks, '서로 다른 곡'],
          [data.uniqueArtists, '아티스트'],
        ].map(([value, label]) => el('div', { class: 'card stat' }, counted(value), el('span', {}, label))),
      ),
      memberSocial(Number(id), data, current),
      el(
        'div',
        { class: 'two-col section' },
        el(
          'section',
          {},
          el('div', { class: 'section-head' }, el('h2', {}, '요일별 청취 시간')),
          el('div', { class: 'card chart-card' }, dayChart(data.byDay)),
        ),
        el(
          'section',
          {},
          el('div', { class: 'section-head' }, el('h2', {}, '시간대별 청취 시간')),
          el('div', { class: 'card chart-card' }, hourStrip(data.byHour)),
        ),
      ),
      el(
        'div',
        { class: 'two-col section' },
        el(
          'section',
          {},
          el('div', { class: 'section-head' }, el('h2', {}, '많이 들은 곡')),
          rankedList(data.topTracks, trackTitle, '이 주에는 기록이 없어요.'),
        ),
        el(
          'section',
          {},
          el('div', { class: 'section-head' }, el('h2', {}, '많이 들은 아티스트')),
          rankedList(data.topArtists, artistTitle, '이 주에는 기록이 없어요.'),
        ),
      ),
      el(
        'section',
        { class: 'section' },
        el('div', { class: 'section-head' }, el('h2', {}, '최근 재생')),
        data.recent.length
          ? el(
              'ul',
              { class: 'card list no-rank' },
              data.recent.map((item) =>
                el('li', {}, cover(item, true), trackTitle(item), el('span', { class: 'count' }, timeAgo(item.playedAt))),
              ),
            )
          : el('div', { class: 'card empty' }, '이 주에는 기록이 없어요.'),
      ),
      state.session.demo || (state.session.static && (!state.connect || state.snapshotCode === state.openCode))
        ? null
        : el(
            'div',
            { class: 'danger-zone' },
            el('span', {}, '그룹에서 빼면 이 친구의 저장된 청취 기록도 함께 삭제됩니다.'),
            el(
              'button',
              {
                class: 'btn danger',
                type: 'button',
                onclick: async () => {
                  if (!confirm(`${data.name} 님을 그룹에서 뺄까요? 저장된 기록도 삭제됩니다.`)) return;
                  if (state.session.static) {
                    await sendToCollector(state.connect, { kind: 'remove', code: state.snapshotCode, memberId: Number(id) });
                    state.flash = QUEUED_MESSAGE;
                  } else {
                    await api(`/api/member?id=${id}`, { method: 'DELETE' });
                  }
                  location.hash = '#/';
                },
              },
              '그룹에서 빼기',
            ),
          ),
    ),
  );
}

async function fetchAdminSummary(password) {
  const response = await fetch(`admin.enc?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
  if (!response?.ok) throw new Error('관리자 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  try {
    return await openSnapshot(new Uint8Array(await response.arrayBuffer()), password);
  } catch {
    throw new Error('비밀번호가 맞지 않아요.');
  }
}

function renderAdminLogin() {
  const error = el('p', { class: 'form-error', role: 'alert' });
  const input = el('input', { type: 'password', name: 'password', autocomplete: 'off', required: true });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, '들어가기');
  paint(
    'admin-login',
    el(
      'main',
      { class: 'gate' },
      el(
        'form',
        {
          class: 'card gate-card',
          onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';
            submit.disabled = true;
            submit.textContent = '확인하는 중…';
            const password = input.value.trim();
            try {
              const summary = await fetchAdminSummary(password);
              state.admin = { password, summary, pending: [], watch: null };
              renderAdmin();
            } catch (failure) {
              error.textContent = failure.message;
              submit.disabled = false;
              submit.textContent = '들어가기';
            }
          },
        },
        el('img', { src: 'favicon.svg', alt: '', width: '36', height: '36' }),
        el('h1', {}, '관리자'),
        el('p', {}, '관리자 비밀번호를 입력해 주세요.'),
        el('label', { class: 'field' }, el('span', {}, '비밀번호'), input),
        error,
        submit,
        el('a', { class: 'link-button', href: '#/' }, '사이트로 돌아가기'),
      ),
    ),
  );
  input.focus();
}

const isAdminView = () => location.hash === '#/admin' && state.admin;

// 요청이 반영된 새 현황이 올라올 때까지 확인합니다. 수집이 막 끝난 직후라면 다음 수집을 다시 부탁합니다.
function watchAdmin(sentAt, tries = COLLECT_WATCH_TRIES) {
  const { admin } = state;
  clearTimeout(admin.watch);
  admin.watch = setTimeout(async () => {
    if (state.admin !== admin) return;
    const summary = await fetchAdminSummary(admin.password).catch(() => null);
    if (summary && summary.generatedAt > sentAt) {
      admin.summary = summary;
      admin.pending = [];
      if (state.snapshotCode) await reloadSnapshot();
      admin.watch = null;
      admin.flash = '반영됐어요. 아래 관리 기록에서 결과를 확인하세요.';
      if (isAdminView()) renderAdmin();
      return;
    }
    if (tries <= 1) {
      admin.watch = null;
      admin.flash = '아직 반영되지 않았어요. 다음 자동 수집(15분 안)에 반영돼요.';
      if (isAdminView()) renderAdmin();
      return;
    }
    // 수집기는 6분에 한 번만 시작할 수 있으므로 그 사이에는 다시 부탁해도 무시됩니다.
    if (tries % 8 === 0) requestCollection(state.connect);
    watchAdmin(sentAt, tries - 1);
  }, COLLECT_WATCH_MS);
}

async function adminSend(request, label) {
  const { admin } = state;
  await sendToCollector(state.connect, { kind: 'admin', password: admin.password, ...request });
  if (request.action === 'removeMember') rememberRemoved(request.memberId);
  admin.pending.push(label);
  admin.flash = null;
  const sentAt = Math.floor(Date.now() / 1000);
  requestCollection(state.connect);
  watchAdmin(sentAt);
  renderAdmin();
}

// 버튼을 눌렀을 때 요청을 보내고, 실패하면 이유를 보여 줍니다.
function adminAction(label, { kind = 'btn', question, ask } = {}, build) {
  return el(
    'button',
    {
      class: `btn small ${kind}`,
      type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        if (question && !confirm(question)) return;
        const request = await build(ask);
        if (!request) return;
        button.disabled = true;
        try {
          await adminSend(request.request, request.label);
        } catch (failure) {
          button.disabled = false;
          alert(failure.message);
        }
      },
    },
    label,
  );
}

function groupTitle(group) {
  return group.isDefault ? '기본 그룹' : `그룹 ${group.id}`;
}

function chooseGroup(member, groups) {
  return new Promise((resolve) => {
    const select = el(
      'select',
      { name: 'group' },
      groups.filter((group) => group.id !== member.groupId).map((group) => el('option', { value: group.id }, groupTitle(group))),
    );
    const dialog = el(
      'dialog',
      { onclose: () => (dialog.remove(), resolve(dialog.returnValue === 'ok' ? Number(select.value) : null)) },
      el('h2', {}, `${member.name} 님 옮기기`),
      el('p', { class: 'dialog-note' }, '청취 기록도 함께 옮겨져요.'),
      el('label', { class: 'field' }, el('span', {}, '옮길 그룹'), select),
      el(
        'div',
        { class: 'form-actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => dialog.close('cancel') }, '취소'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => dialog.close('ok') }, '옮기기'),
      ),
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

function adminMemberRow(member, groups) {
  return el(
    'li',
    { class: 'admin-member' },
    el(
      'span',
      { class: 'admin-name' },
      el('b', {}, member.name),
      el('span', {}, `${SERVICE_NAMES[member.service]} · 이번 주 ${number(member.minutes)}분 · ${number(member.plays)}회`),
      member.lastSyncedAt ? el('span', {}, `마지막 동기화 ${timeAgo(member.lastSyncedAt)}`) : null,
      member.error ? el('span', { class: 'warn-line' }, `⚠ ${member.error}`) : null,
    ),
    el(
      'span',
      { class: 'admin-actions' },
      adminAction('이름', {}, () => {
        const name = prompt(`${member.name} 님의 새 이름`, member.name)?.trim();
        if (!name || name === member.name) return null;
        return { request: { action: 'renameMember', memberId: member.id, name }, label: `${member.name} → ${name} 이름 바꾸기` };
      }),
      groups.length > 1
        ? adminAction('옮기기', {}, async () => {
            const groupId = await chooseGroup(member, groups);
            if (!groupId) return null;
            return { request: { action: 'moveMember', memberId: member.id, groupId }, label: `${member.name} 님 옮기기` };
          })
        : null,
      adminAction('빼기', { kind: 'danger', question: `${member.name} 님을 빼고 저장된 기록도 삭제할까요?` }, () => ({
        request: { action: 'removeMember', memberId: member.id },
        label: `${member.name} 님 빼기`,
      })),
    ),
  );
}

function adminGroupCard(group, groups) {
  const title = groupTitle(group);
  const created = new Date(group.createdAt * 1000).toLocaleDateString('ko-KR');
  const members = group.members.map((member) => ({ ...member, groupId: group.id }));
  return el(
    'section',
    { class: 'card admin-group' },
    el(
      'div',
      { class: 'admin-group-head' },
      el('span', {}, el('h2', {}, title), el('span', {}, `${created} 생성 · ${group.members.length}명`)),
      el(
        'span',
        { class: 'admin-actions' },
        adminAction(group.announcement ? '공지 고치기' : '공지 쓰기', {}, () => {
          const text = prompt(`${title} 친구들에게 보일 공지 (비우면 공지를 내려요)`, group.announcement ?? '');
          if (text === null || text.trim() === (group.announcement ?? '')) return null;
          return { request: { action: 'announce', groupId: group.id, text }, label: `${title} 공지 ${text.trim() ? '올리기' : '내리기'}` };
        }),
        group.notices?.length
          ? adminAction('오류 지우기', {}, () => ({ request: { action: 'clearNotices', groupId: group.id }, label: `${title} 오류 알림 지우기` }))
          : null,
        group.isDefault
          ? null
          : adminAction('그룹 삭제', { kind: 'danger', question: `${title}과 멤버의 기록을 모두 삭제할까요? 되돌릴 수 없어요.` }, () => ({
              request: { action: 'removeGroup', groupId: group.id },
              label: `${title} 삭제`,
            })),
      ),
    ),
    group.announcement ? el('p', { class: 'announcement small' }, `📢 ${group.announcement}`) : null,
    (group.notices ?? []).map((message) => el('p', { class: 'admin-notice', role: 'status' }, `⚠ ${message}`)),
    members.length
      ? el(
          'ul',
          { class: 'admin-members' },
          members.map((member) => adminMemberRow(member, groups)),
        )
      : el('p', { class: 'admin-empty' }, '아직 멤버가 없어요.'),
  );
}

function adminLogSection(log = []) {
  return el(
    'section',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, '관리 기록')),
    log.length
      ? el(
          'ul',
          { class: 'card list no-rank admin-log' },
          log.map((entry) =>
            el(
              'li',
              { class: entry.ok ? '' : 'failed' },
              el('span', { class: 'admin-log-mark', 'aria-hidden': 'true' }, entry.ok ? '✓' : '⚠'),
              el('span', { class: 'admin-log-text' }, entry.message),
              el('span', { class: 'count' }, timeAgo(entry.at)),
            ),
          ),
        )
      : el('div', { class: 'card empty' }, '아직 기록이 없어요. 관리자가 한 일과 결과가 여기에 남아요.'),
  );
}

async function adminCreateGroup(event) {
  const button = event.currentTarget;
  if (!confirm('새 그룹을 만들까요? 만든 뒤 초대 링크를 친구에게 보내면 돼요.')) return;
  const code = createCode();
  button.disabled = true;
  try {
    await adminSend({ action: 'createGroup', code }, '새 그룹 만들기');
    openInviteDialog(code);
  } catch (failure) {
    alert(failure.message);
  } finally {
    button.disabled = false;
  }
}

async function adminCollectNow(event) {
  const button = event.currentTarget;
  button.disabled = true;
  const started = await requestCollection(state.connect);
  state.admin.flash = started
    ? '수집을 시작했어요. 1~2분 뒤 자동으로 새 현황을 불러와요.'
    : '방금 수집했거나 수집 중이에요. 잠시 뒤 다시 확인해요.';
  watchAdmin(state.admin.summary.generatedAt);
  renderAdmin();
}

async function adminReload(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    state.admin.summary = await fetchAdminSummary(state.admin.password);
    state.admin.flash = '최신 현황을 불러왔어요.';
  } catch (failure) {
    state.admin.flash = failure.message;
  }
  renderAdmin();
}

function renderAdmin() {
  if (!state.admin) return renderAdminLogin();
  const { summary, pending, flash } = state.admin;
  const groups = summary.groups;
  paint(
    'admin',
    el(
      'main',
      { class: 'shell' },
      el('a', { class: 'back', href: '#/' }, '‹ 사이트로 돌아가기'),
      el(
        'div',
        { class: 'detail-head' },
        el('div', {}, el('h1', {}, '관리자')),
        el(
          'span',
          { class: 'admin-actions' },
          el('button', { class: 'btn small', type: 'button', onclick: adminReload }, '현황 새로고침'),
          state.connect ? el('button', { class: 'btn small', type: 'button', onclick: adminCollectNow }, '지금 수집') : null,
          state.connect ? el('button', { class: 'btn small primary', type: 'button', onclick: adminCreateGroup }, '새 그룹') : null,
        ),
      ),
      el(
        'p',
        { class: 'notice', role: 'status' },
        pending.length
          ? [el('strong', {}, '반영하는 중이에요. '), `${pending.join(', ')} · 보통 1~2분 걸리고, 끝나면 자동으로 바뀌어요.`]
          : [el('strong', {}, `${timeAgo(summary.generatedAt)} 기준 현황이에요. `), flash ?? '바꾼 내용은 바로 수집을 시작해 1~2분 안에 반영돼요.'],
      ),
      el(
        'div',
        { class: 'stat-row' },
        [
          [`${groups.length}/${summary.maxGroups}`, '그룹'],
          [number(groups.reduce((total, group) => total + group.members.length, 0)), '멤버'],
          [`${summary.spotifyUsers}/5`, 'Spotify 로그인'],
        ].map(([value, label]) => el('div', { class: 'card stat' }, el('b', {}, value), el('span', {}, label))),
      ),
      groups.map((group) => adminGroupCard(group, groups)),
      adminLogSection(summary.log),
    ),
  );
}

function renderWaiting() {
  const code = state.pendingCode;
  paint(
    'waiting',
    el(
      'main',
      { class: 'gate' },
      el(
        'div',
        { class: 'card gate-card' },
        el('span', { class: 'eq large', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
        el('h1', {}, '그룹을 준비하고 있어요'),
        el('p', {}, '새로 만든 그룹은 보통 1~2분, 길면 15분 안에 자동으로 열려요. 그동안 이 코드를 저장해 두세요.'),
        el('p', { class: 'group-code' }, code),
        el('button', { class: 'btn primary', type: 'button', onclick: () => openInviteDialog(code) }, '초대 링크'),
        el(
          'button',
          {
            class: 'link-button',
            type: 'button',
            onclick: () => {
              rememberPending(null);
              render();
            },
          },
          '다른 코드 입력하기',
        ),
      ),
    ),
  );
}

function renderGate() {
  const error = el('p', { class: 'form-error', role: 'alert' }, state.gateError);
  state.gateError = null;
  const input = el('input', { type: 'password', name: 'code', autocomplete: 'off', required: true, autofocus: true });
  paint(
    'gate',
    el(
      'main',
      { class: 'gate' },
      el(
        'form',
        {
          class: 'card gate-card',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              if (state.session.static) {
                const typed = input.value.trim();
                // 만든 코드는 모두 소문자입니다. 대문자로 입력해도 들어가게 합니다.
                await unlockWithCode(typed).catch((failure) => {
                  if (!failure.invalid || typed === typed.toLowerCase()) throw failure;
                  return unlockWithCode(typed.toLowerCase());
                });
              } else await api('/api/session', { method: 'POST', body: JSON.stringify({ code: input.value }) });
              state.session.authed = true;
              render();
            } catch (failure) {
              error.textContent = failure.message;
            }
          },
        },
        el('img', { src: 'favicon.svg', alt: '', width: '36', height: '36' }),
        el('h1', {}, '크로스페이드'),
        el('p', {}, '친구에게 받은 초대 코드를 입력해 주세요.'),
        el('label', { class: 'field' }, el('span', {}, '초대 코드'), input),
        error,
        el('button', { class: 'btn primary', type: 'submit' }, '들어가기'),
        state.connect
          ? el('button', { class: 'btn', type: 'button', onclick: () => createGroup(error) }, '새 그룹 만들기')
          : null,
      ),
    ),
  );
  input.focus();
}

function openAddDialog() {
  const isStatic = state.session.static;
  const canLogin = isStatic ? Boolean(state.connect?.spotifyClientId) : state.session.spotifyLogin;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const login = isStatic
    ? el(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          disabled: !canLogin,
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = 'Spotify로 이동하는 중...';
            try {
              await startSpotifyLogin(state.connect);
            } catch {
              button.disabled = false;
              button.textContent = 'Spotify로 로그인';
              error.textContent = 'Spotify 로그인을 시작하지 못했어요. 다시 시도해 주세요.';
            }
          },
        },
        'Spotify로 로그인',
      )
    : el('a', { class: 'btn primary', href: '/api/spotify/login' }, 'Spotify로 로그인');
  const dialog = el(
    'dialog',
    { onclose: () => dialog.remove() },
    el('h2', {}, '친구 추가'),
    el('p', { class: 'dialog-note' }, '이 그룹에 들어올 친구가 이 기기에서 Spotify로 로그인하면 바로 추가돼요. 다음 수집 때(1~2분) 기록이 보여요.'),
    el('ol', { class: 'steps' }, [
      el('li', {}, '관리자가 Spotify 개발자 대시보드의 User Management에 친구의 Spotify 이메일을 등록해요.'),
      el('li', {}, '친구가 초대 링크로 들어와 아래 버튼으로 로그인해요.'),
    ]),
    canLogin ? null : el('p', { class: 'form-error' }, 'Spotify 로그인이 아직 설정되지 않았어요.'),
    error,
    el(
      'div',
      { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '닫기'),
      login,
    ),
  );
  document.body.append(dialog);
  dialog.showModal();
}

function openNotifyDialog() {
  const saved = savedPush();
  const error = el('p', { class: 'form-error', role: 'alert' });
  const members = state.snapshot.overview[0].members;
  const who = el(
    'select',
    { name: 'member' },
    el('option', { value: '' }, '선택 안 함 (우리 기록만)'),
    members.map((member) => el('option', { value: member.id, selected: member.id === saved?.memberId }, member.name)),
  );
  const hour = el(
    'select',
    { name: 'hour' },
    Array.from({ length: 24 }, (_, value) =>
      el('option', { value, selected: value === (saved?.hour ?? DEFAULT_NOTIFY_HOUR) }, `${value}시`),
    ),
  );
  const finish = (message) => {
    state.flash = message;
    dialog.close();
    render();
  };
  const run = (button, task) => async () => {
    button.disabled = true;
    error.textContent = '';
    try {
      await task();
    } catch (failure) {
      error.textContent = failure.message;
      button.disabled = false;
    }
  };
  const save = el('button', { class: 'btn primary', type: 'button' }, saved ? '저장' : '알림 켜기');
  save.addEventListener(
    'click',
    run(save, async () => {
      const settings = { code: state.snapshotCode, memberId: who.value ? Number(who.value) : null, hour: Number(hour.value) };
      await enablePush(state.connect, settings);
      finish(`알림을 켰어요. 매일 ${settings.hour}시쯤 알려 드릴게요.`);
    }),
  );
  const off = el('button', { class: 'btn danger', type: 'button' }, '알림 끄기');
  off.addEventListener(
    'click',
    run(off, async () => {
      await disablePush(state.connect);
      finish('알림을 껐어요.');
    }),
  );
  const test = el('button', { class: 'btn', type: 'button' }, '지금 한 번 받아 보기');
  test.addEventListener(
    'click',
    run(test, async () => {
      await testPush();
      test.disabled = false;
    }),
  );
  const needsInstall = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;

  const dialog = el(
    'dialog',
    { onclose: () => dialog.remove() },
    el('h2', {}, '하루 한 번 알림'),
    pushSupported()
      ? [
          el('p', { class: 'dialog-note' }, '매일 정한 시각에 내가 몇 번, 얼마나 들었는지와 우리가 모두 몇 분 들었는지 알려 드려요.'),
          el('label', { class: 'field' }, el('span', {}, '나는 누구인가요'), who),
          el('label', { class: 'field' }, el('span', {}, '받을 시각 (한국 시간)'), hour),
          el(
            'p',
            { class: 'dialog-note' },
            '오전으로 정하면 어제 기록을, 오후로 정하면 오늘 지금까지의 기록을 알려 드려요. 알림은 이 기기에만 오고, 정한 시각부터 15분 안에 와요.',
          ),
          needsInstall
            ? el('p', { class: 'dialog-note' }, '아이폰과 아이패드는 공유 → 홈 화면에 추가로 설치한 뒤, 그 앱에서 켜야 알림이 와요.')
            : null,
          error,
        ]
      : el(
          'p',
          { class: 'dialog-note' },
          '이 브라우저는 알림을 지원하지 않아요. 아이폰과 아이패드는 공유 → 홈 화면에 추가로 설치한 뒤, 그 앱에서 다시 열어 주세요.',
        ),
    el(
      'div',
      { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '닫기'),
      pushSupported() ? [saved ? [test, off] : null, save] : null,
    ),
  );
  document.body.append(dialog);
  dialog.showModal();
}

function setupTooltips() {
  const hide = () => {
    tip.hidden = true;
  };
  document.addEventListener('pointermove', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (!target) return hide();
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const x = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.max(event.clientY - tip.offsetHeight - 10, 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  document.addEventListener('pointerleave', hide);
}

function showError(error) {
  paint(
    'error',
    el(
      'main',
      { class: 'shell' },
      el(
        'div',
        { class: 'card empty', role: 'alert' },
        el('p', {}, error.message),
        el(
          'p',
          { style: { marginTop: '14px' } },
          el('button', { class: 'btn', type: 'button', onclick: render }, '다시 시도'),
        ),
      ),
    ),
  );
}

async function render() {
  clearTimeout(state.refreshTimer);
  if (document.querySelector('dialog[open]')) {
    state.refreshTimer = setTimeout(render, REFRESH_MS);
    return;
  }
  const playerName = location.hash.match(/^#\/(\w+)$/)?.[1];
  const onPlayer = Object.hasOwn(PLAYERS, playerName ?? '') ? playerName : null;
  // 플레이어를 처음 열 때 배포 버전을 먼저 알아 둡니다(예전 플레이어 파일을 쓰지 않도록).
  if (onPlayer && !playerViews[onPlayer] && siteBuild === null) await fetchSiteConfig();
  showPlayer(onPlayer);
  if (onPlayer) {
    try {
      if (!state.session) state.session = await loadSession();
      await refreshSnapshot();
    } catch {
      // 기록을 못 받아도 Luma는 그대로 씁니다.
    }
    state.refreshTimer = setTimeout(render, REFRESH_MS);
    return;
  }
  try {
    if (!state.session) state.session = await loadSession();
    if (state.session.static && location.hash === '#/admin') return renderAdmin();
    await refreshSnapshot();
    if (!state.session.authed) {
      if (!state.pendingCode) return renderGate();
      try {
        await unlockWithCode(state.pendingCode);
        rememberPending(null);
        state.session.authed = true;
      } catch {
        state.refreshTimer = setTimeout(render, WAITING_REFRESH_MS);
        return renderWaiting();
      }
    }
    await completeSpotifyLogin();

    const memberId = location.hash.match(/^#\/member\/(\d+)$/)?.[1];
    if (memberId) await renderMember(memberId);
    else await renderHome();
    state.flash = null;
    state.refreshTimer = setTimeout(render, REFRESH_MS);
  } catch (error) {
    if (error.status === 401) {
      state.session.authed = false;
      return renderGate();
    }
    showError(error);
  }
}

window.addEventListener('hashchange', async () => {
  const invited = takeInviteCode();
  if (invited && state.session?.static) await joinInvited(invited);
  else if (invited) state.invite = invited;
  // 앱을 넘긴 경우에는 크로스페이드에서 보던 위치를 그대로 둡니다.
  if (!switchingApps) window.scrollTo(0, 0);
  switchingApps = false;
  render();
});
document.addEventListener('visibilitychange', pollLive);
setInterval(pollLive, LIVE_REFRESH_MS);
setupTooltips();
render().then(pollLive);
