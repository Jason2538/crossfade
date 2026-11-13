import { groupFileId, openSnapshot } from './snapshot.js';
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
const CODE_STORAGE_KEY = 'crossfade.inviteCode';
const PENDING_STORAGE_KEY = 'crossfade.pendingGroup';
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';
const QUEUED_MESSAGE = '요청을 보냈어요. 다음 수집 때(15분쯤) 반영돼요.';
const SERVICE_NAMES = { spotify: 'Spotify', apple: 'Apple Music' };
const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

const app = document.getElementById('app');
const tip = document.getElementById('tip');

const SPOTIFY_MESSAGES = {
  connected: 'Spotify 계정을 연결했어요. 최근 재생 기록을 가져오는 중이에요.',
  denied: 'Spotify 로그인이 취소됐어요.',
  notAllowed: '이 Spotify 계정은 아직 앱 사용자로 등록되어 있지 않아요. 그룹 관리자에게 Spotify 이메일을 알려 주세요.',
  full: 'Spotify 로그인은 5명까지만 쓸 수 있어요. Last.fm으로 연결해 주세요.',
  failed: 'Spotify 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.',
  queued: 'Spotify 계정을 연결했어요. 다음 수집 때(15분쯤) 그룹에 나타나요.',
};

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
  state.view = view;
  app.classList.toggle('enter', entering);
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
async function fetchSiteConfig() {
  try {
    const response = await fetch(`site.json?t=${Date.now()}`, { cache: 'no-store' });
    return response.ok ? await response.json() : null;
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
  state.snapshot = await openSnapshot(sealed, code);
  state.snapshotCode = code;
  state.snapshotLoadedAt = Date.now();
}

function invalidCode(message) {
  const error = new Error(message);
  error.invalid = true;
  return error;
}

async function unlockWithCode(code) {
  const sealed = await fetchSealed(code);
  if (sealed === 'missing') throw invalidCode('코드가 맞지 않거나, 아직 준비 중인 새 그룹이에요.');
  if (!sealed) throw new Error('기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  try {
    await unlock(sealed, code);
  } catch {
    throw invalidCode('초대 코드가 맞지 않아요.');
  }
  rememberCode(code);
}

async function loadSession() {
  const site = await fetchSiteConfig();
  if (!site) return api('/api/session');

  state.connect = site.connect;
  state.openCode = site.openCode;
  state.pendingCode = savedPending();
  const session = { demo: false, spotifyLogin: false, static: true, authed: false };
  const saved = savedCode();
  for (const code of [state.invite, saved]) {
    if (!code || session.authed) continue;
    try {
      await unlockWithCode(code);
      session.authed = true;
    } catch (failure) {
      if (code === state.invite) state.gateError = failure.message;
      else if (failure.invalid) rememberCode(null);
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

async function shareInviteLink(event, code = state.snapshotCode) {
  const button = event.currentTarget;
  const hash = code === state.openCode ? '' : `#invite=${encodeURIComponent(code)}`;
  const url = `${location.origin}${location.pathname}${hash}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: '크로스페이드 초대', url });
      return;
    }
    await navigator.clipboard.writeText(url);
    button.textContent = '복사했어요';
    setTimeout(() => {
      button.textContent = '초대 링크';
    }, 1500);
  } catch (failure) {
    if (failure.name !== 'AbortError') prompt('이 링크를 복사해 친구에게 보내 주세요.', url);
  }
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

function withLive(data) {
  const members = data.members.map((member) => {
    const live = state.live.get(member.id);
    if (!live || Date.now() - live.at > LIVE_MAX_AGE_MS) return member;
    return { ...member, nowPlaying: live.nowPlaying, lastPlayed: live.lastPlayed ?? member.lastPlayed };
  });
  return { ...data, members };
}

// 지금 듣는 곡은 수집과 상관없이 바로 바꿉니다.
async function pollLive() {
  const tokens = Object.entries(state.snapshot?.liveTokens ?? {});
  if (document.hidden || !state.connect || !tokens.length) return;
  const results = await Promise.all(tokens.map(async ([id, token]) => [Number(id), await fetchLive(state.connect, token)]));
  let changed = false;
  for (const [id, live] of results) {
    if (!live) continue;
    const before = state.live.get(id);
    changed ||= JSON.stringify([before?.nowPlaying, before?.lastPlayed]) !== JSON.stringify([live.nowPlaying, live.lastPlayed]);
    state.live.set(id, { ...live, at: Date.now() });
  }
  if (changed && state.view?.startsWith('home:')) render();
}

async function readOverview(week) {
  if (state.snapshot) return withLive(hideStaleNowPlaying(state.snapshot.overview[week]));
  return api(`/api/overview?week=${week}`);
}

async function readMember(id, week) {
  if (!state.snapshot) return api(`/api/member?id=${id}&week=${week}`);
  const detail = state.snapshot.members[id]?.[week];
  if (!detail) throw new Error('친구를 찾을 수 없어요.');
  return detail;
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
  return el(
    'span',
    { class: small ? 'cover small' : 'cover', 'aria-hidden': 'true' },
    item.image ? el('img', { src: item.image, alt: '', loading: 'lazy' }) : initial,
  );
}

const equalizer = () => el('span', { class: 'eq', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));

function header() {
  return el(
    'header',
    { class: 'topbar' },
    el('a', { class: 'brand', href: '#/' }, el('img', { src: 'favicon.svg', alt: '' }), '크로스페이드'),
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
      state.session.static ? el('button', { class: 'btn', type: 'button', onclick: shareInviteLink }, '초대 링크') : null,
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

function fader(members) {
  const sum = (service) => members.filter((m) => m.service === service).reduce((total, m) => total + m.minutes, 0);
  const spotify = sum('spotify');
  const apple = sum('apple');
  const total = spotify + apple;
  if (!total) return null;
  const share = Math.round((spotify / total) * 100);
  return el(
    'section',
    { class: 'fader', 'aria-label': `서비스별 청취 비중: Spotify ${share}%, Apple Music ${100 - share}%` },
    el(
      'div',
      { class: 'fader-rail', 'aria-hidden': 'true' },
      el('i', { class: 'spotify', style: { width: `${share}%` } }),
      el('i', { class: 'apple', style: { width: `${100 - share}%` } }),
      el('span', { class: 'fader-knob', style: { left: `${share}%` } }),
    ),
    el(
      'div',
      { class: 'fader-labels' },
      el('span', {}, el('b', {}, `Spotify ${share}%`), ` · ${number(spotify)}분`),
      el('span', {}, el('b', {}, `Apple Music ${100 - share}%`), ` · ${number(apple)}분`),
    ),
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
      el(
        'span',
        { class: 'legend' },
        el('span', {}, el('i', { class: 'swatch spotify' }), 'Spotify'),
        el('span', {}, el('i', { class: 'swatch apple' }), 'Apple Music'),
      ),
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
              el('span', { class: 'service' }, SERVICE_NAMES[member.service]),
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
                  class: `bar-fill ${member.service}`,
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

// Luma처럼 바로 같이 들을 수는 없어서, 각자 쓰는 앱에서 같은 곡을 찾아 줍니다.
function listenLinks(item) {
  const link = (href, label) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
  return el(
    'span',
    { class: 'listen-links' },
    link(`https://open.spotify.com/search/${searchText(item)}`, 'Spotify'),
    link(`https://music.apple.com/kr/search?term=${searchText(item)}`, 'Apple Music'),
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
  const social = state.snapshot?.social;
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
                  el('span', { class: 'pair-tag' }, `${SERVICE_NAMES[a.service]} × ${SERVICE_NAMES[b.service]}`),
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
  const social = state.snapshot?.social ?? null;
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
      fader(members),
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
        el('div', {}, el('h1', {}, data.name), el('span', { class: 'service' }, SERVICE_NAMES[data.service])),
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

function renderAdminLogin() {
  const error = el('p', { class: 'form-error', role: 'alert' });
  const input = el('input', { type: 'password', name: 'password', autocomplete: 'off', required: true });
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
            const password = input.value.trim();
            const response = await fetch(`admin.enc?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
            if (!response?.ok) {
              error.textContent = '관리자 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
              return;
            }
            try {
              const summary = await openSnapshot(new Uint8Array(await response.arrayBuffer()), password);
              state.admin = { password, summary, requested: new Set() };
              renderAdmin();
            } catch {
              error.textContent = '비밀번호가 맞지 않아요.';
            }
          },
        },
        el('img', { src: 'favicon.svg', alt: '', width: '36', height: '36' }),
        el('h1', {}, '관리자'),
        el('p', {}, '관리자 비밀번호를 입력해 주세요.'),
        el('label', { class: 'field' }, el('span', {}, '비밀번호'), input),
        error,
        el('button', { class: 'btn primary', type: 'submit' }, '들어가기'),
        el('a', { class: 'link-button', href: '#/' }, '사이트로 돌아가기'),
      ),
    ),
  );
  input.focus();
}

function adminButton(key, label, question, request) {
  const { admin } = state;
  if (admin.requested.has(key)) return el('span', { class: 'admin-requested' }, '삭제 요청됨');
  return el(
    'button',
    {
      class: 'btn danger',
      type: 'button',
      onclick: async (event) => {
        if (!confirm(question)) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await sendToCollector(state.connect, { kind: 'admin', password: admin.password, ...request });
          admin.requested.add(key);
          renderAdmin();
        } catch (failure) {
          button.disabled = false;
          alert(failure.message);
        }
      },
    },
    label,
  );
}

function adminMemberRow(member) {
  return el(
    'li',
    { class: 'admin-member' },
    el(
      'span',
      { class: 'admin-name' },
      el('b', {}, member.name),
      el('span', {}, `${SERVICE_NAMES[member.service]} · 이번 주 ${number(member.minutes)}분 · ${number(member.plays)}회`),
      member.error ? el('span', { class: 'warn-line' }, `⚠ ${member.error}`) : null,
    ),
    adminButton(`member:${member.id}`, '빼기', `${member.name} 님을 빼고 저장된 기록도 삭제할까요?`, {
      action: 'removeMember',
      memberId: member.id,
    }),
  );
}

function adminGroupCard(group) {
  const title = group.isDefault ? '기본 그룹' : `그룹 ${group.id}`;
  const created = new Date(group.createdAt * 1000).toLocaleDateString('ko-KR');
  return el(
    'section',
    { class: 'card admin-group' },
    el(
      'div',
      { class: 'admin-group-head' },
      el('span', {}, el('h2', {}, title), el('span', {}, `${created} 생성 · ${group.members.length}명`)),
      group.isDefault
        ? null
        : adminButton(`group:${group.id}`, '그룹 삭제', `${title}과 멤버의 기록을 모두 삭제할까요? 되돌릴 수 없어요.`, {
            action: 'removeGroup',
            groupId: group.id,
          }),
    ),
    (group.notices ?? []).map((message) => el('p', { class: 'admin-notice', role: 'status' }, `⚠ ${message}`)),
    group.members.length
      ? el('ul', { class: 'admin-members' }, group.members.map(adminMemberRow))
      : el('p', { class: 'admin-empty' }, '아직 멤버가 없어요.'),
  );
}

function renderAdmin() {
  if (!state.admin) return renderAdminLogin();
  const { summary } = state.admin;
  paint(
    'admin',
    el(
      'main',
      { class: 'shell' },
      el('a', { class: 'back', href: '#/' }, '‹ 사이트로 돌아가기'),
      el('div', { class: 'detail-head' }, el('div', {}, el('h1', {}, '관리자'))),
      el(
        'p',
        { class: 'notice' },
        el('strong', {}, `${timeAgo(summary.generatedAt)} 기준 현황이에요. `),
        '삭제는 다음 수집 때 반영돼요.',
      ),
      el(
        'div',
        { class: 'stat-row' },
        [
          [`${summary.groups.length}/${summary.maxGroups}`, '그룹'],
          [number(summary.groups.reduce((total, group) => total + group.members.length, 0)), '멤버'],
          [`${summary.spotifyUsers}/5`, 'Spotify 로그인'],
        ].map(([value, label]) => el('div', { class: 'card stat' }, el('b', {}, value), el('span', {}, label))),
      ),
      summary.groups.map(adminGroupCard),
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
        el('h1', {}, '새 그룹을 만들고 있어요'),
        el('p', {}, '다음 수집 때(15분쯤) 자동으로 열려요. 그동안 이 코드를 저장해 두세요.'),
        el('p', { class: 'group-code' }, code),
        el('button', { class: 'btn primary', type: 'button', onclick: (event) => shareInviteLink(event, code) }, '초대 링크'),
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
              if (state.session.static) await unlockWithCode(input.value.trim().toLowerCase());
              else await api('/api/session', { method: 'POST', body: JSON.stringify({ code: input.value }) });
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

const SETUP_STEPS = {
  spotify: [
    'last.fm에 무료로 가입합니다.',
    'Last.fm 설정의 애플리케이션 메뉴에서 Spotify를 연결합니다.',
    'Last.fm 사용자 이름을 아래에 입력합니다.',
  ],
  apple: [
    'last.fm에 무료로 가입합니다.',
    '아이폰은 FastScrobbler, 안드로이드는 Pano Scrobbler를 설치하고 Last.fm 계정을 연결합니다.',
    'Last.fm 사용자 이름을 아래에 입력합니다.',
  ],
};

const JOIN_STEP = '이름과 Last.fm 사용자 이름, 쓰는 서비스를 그룹 관리자에게 보내 주세요.';

function openAddDialog() {
  const isStatic = state.session.static;
  const readOnly = isStatic && !state.connect;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const steps = el('ol', { class: 'steps' });
  const canSpotifyLogin = isStatic ? Boolean(state.connect?.spotifyClientId) : state.session.spotifyLogin;
  const spotifyLogin = el(
    'div',
    { class: 'spotify-login' },
    isStatic
      ? el(
          'button',
          {
            class: 'btn primary',
            type: 'button',
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
      : el('a', { class: 'btn primary', href: '/api/spotify/login' }, 'Spotify로 로그인'),
    el('p', {}, '최대 5명까지 가능하고, 관리자가 Spotify 앱에 이메일을 등록한 계정만 로그인할 수 있어요. 아래처럼 Last.fm으로 연결해도 됩니다.'),
  );
  const showSteps = (service) => {
    const texts = readOnly ? [...SETUP_STEPS[service].slice(0, -1), JOIN_STEP] : SETUP_STEPS[service];
    steps.replaceChildren(...texts.map((text) => el('li', {}, text)));
    spotifyLogin.hidden = service !== 'spotify' || !canSpotifyLogin;
  };
  showSteps('spotify');

  const radio = (value, checked) =>
    el(
      'label',
      {},
      el('input', { type: 'radio', name: 'service', value, checked, onchange: () => showSteps(value) }),
      SERVICE_NAMES[value],
    );

  const submit = el('button', { class: 'btn primary', type: 'submit', disabled: state.session.demo }, '추가하기');
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (readOnly) return;
        const fields = new FormData(form);
        const member = {
          name: fields.get('name').trim(),
          lastfmUser: fields.get('lastfmUser').trim(),
          service: fields.get('service'),
        };
        submit.disabled = true;
        error.textContent = '';
        try {
          if (isStatic) {
            await sendToCollector(state.connect, { kind: 'member', code: state.snapshotCode, ...member });
            state.flash = QUEUED_MESSAGE;
          } else {
            await api('/api/members', { method: 'POST', body: JSON.stringify(member) });
          }
          dialog.close();
          render();
        } catch (failure) {
          error.textContent = failure.message;
          submit.disabled = false;
        }
      },
    },
    el('h2', {}, '친구 추가'),
    el(
      'fieldset',
      { class: 'field' },
      el('legend', {}, '쓰는 음악 서비스'),
      el('div', { class: 'service-choice' }, radio('spotify', true), radio('apple', false)),
    ),
    spotifyLogin,
    steps,
    readOnly
      ? null
      : [
          el('label', { class: 'field' }, el('span', {}, '이름'), el('input', { type: 'text', name: 'name', maxlength: '20', required: true })),
          el(
            'label',
            { class: 'field' },
            el('span', {}, 'Last.fm 사용자 이름'),
            el('input', { type: 'text', name: 'lastfmUser', maxlength: '15', required: true, autocapitalize: 'off', spellcheck: 'false' }),
          ),
          state.session.demo ? el('p', { class: 'form-error' }, '데모 모드에서는 친구를 추가할 수 없어요.') : error,
        ],
    el(
      'div',
      { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '닫기'),
      readOnly ? null : submit,
    ),
  );

  const dialog = el('dialog', { onclose: () => dialog.remove() }, form);
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
        state.refreshTimer = setTimeout(render, REFRESH_MS);
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

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
document.addEventListener('visibilitychange', pollLive);
setInterval(pollLive, LIVE_REFRESH_MS);
setupTooltips();
render().then(pollLive);
