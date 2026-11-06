import { groupFileId, openSnapshot } from './snapshot.js';
import { finishSpotifyLogin, sendToCollector, startSpotifyLogin, takeSpotifyCallback } from './spotify-login.js';

const REFRESH_MS = 60_000;
const MAX_WEEKS_BACK = 7;
const SNAPSHOT_REFRESH_MS = 5 * 60_000;
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
  invite: takeInviteCode(),
  gateError: null,
  connect: null,
  pendingCode: null,
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
  if (!confirm('이 기기에서 그룹을 나갈까요? 초대 코드가 있으면 다시 들어올 수 있어요.')) return;
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
  const url = `${location.origin}${location.pathname}#invite=${encodeURIComponent(code)}`;
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

async function refreshSnapshot() {
  if (!state.snapshot || Date.now() - state.snapshotLoadedAt < SNAPSHOT_REFRESH_MS) return;
  const sealed = await fetchSealed(state.snapshotCode);
  if (!sealed || sealed === 'missing') return;
  try {
    await unlock(sealed, state.snapshotCode);
  } catch {
    // 초대 코드가 바뀐 경우입니다.
    rememberCode(null);
    state.session.authed = false;
  }
}

function hideStaleNowPlaying(data) {
  if (Date.now() / 1000 - state.snapshot.generatedAt < NOW_PLAYING_TTL_SECONDS) return data;
  return { ...data, members: data.members.map((member) => ({ ...member, nowPlaying: null })) };
}

async function readOverview(week) {
  if (state.snapshot) return hideStaleNowPlaying(state.snapshot.overview[week]);
  return api(`/api/overview?week=${week}`);
}

async function readMember(id, week) {
  if (!state.snapshot) return api(`/api/member?id=${id}&week=${week}`);
  const detail = state.snapshot.members[id]?.[week];
  if (!detail) throw new Error('친구를 찾을 수 없어요.');
  return detail;
}

const number = (value) => value.toLocaleString('ko-KR');

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
      state.session.static ? el('button', { class: 'btn', type: 'button', onclick: shareInviteLink }, '초대 링크') : null,
      el('button', { class: 'btn primary', type: 'button', onclick: openAddDialog }, '친구 추가'),
    ),
  );
}

function demoNotice() {
  if (state.flash) return el('p', { class: 'notice', role: 'status' }, state.flash);
  if (state.snapshot) {
    return [
      el(
        'p',
        { class: 'notice' },
        el('strong', {}, `${timeAgo(state.snapshot.generatedAt)} 업데이트됨. `),
        '기록은 15분쯤마다 모으며, 더 늦어질 수도 있어요.',
      ),
      state.snapshot.notices.map((message) => el('p', { class: 'notice', role: 'status' }, message)),
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

function rankingSection(data) {
  const { members, week } = data;
  const max = Math.max(1, ...members.map((m) => m.minutes));
  const estimated = data.group.plays ? Math.round((data.group.estimatedPlays / data.group.plays) * 100) : 0;

  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('h2', {}, `${weekName(week.offset)} 랭킹`),
      el(
        'span',
        { class: 'legend' },
        el('span', {}, el('i', { class: 'swatch spotify' }), 'Spotify'),
        el('span', {}, el('i', { class: 'swatch apple' }), 'Apple Music'),
      ),
    ),
    el(
      'ol',
      { class: 'card rank-list' },
      members.map((member, index) =>
        el(
          'li',
          {},
          el(
            'a',
            { class: 'rank-row', href: `#/member/${member.id}` },
            el('span', { class: 'rank-no' }, String(index + 1)),
            el(
              'span',
              { class: 'rank-name' },
              el('b', {}, member.name),
              el('span', { class: 'service' }, SERVICE_NAMES[member.service]),
            ),
            el(
              'span',
              {
                class: 'rank-bar',
                'data-tip': `${member.name}: ${number(member.minutes)}분 · ${number(member.plays)}회 재생 · ${number(member.uniqueTracks)}곡`,
              },
              el(
                'div',
                { class: 'bar-track', 'aria-hidden': 'true' },
                el('div', {
                  class: `bar-fill ${member.service}`,
                  style: { width: `${(member.minutes / max) * 100}%` },
                }),
              ),
              el(
                'div',
                { class: 'sub-line' },
                member.topTrack ? `가장 많이 들은 곡: ${member.topTrack.track}` : '이번 주 기록이 없어요',
              ),
            ),
            el(
              'span',
              { class: 'rank-values' },
              el('b', {}, `${number(member.minutes)}분`),
              el('span', {}, `${number(member.plays)}회 · ${number(member.uniqueTracks)}곡 `, deltaLabel(member)),
            ),
            member.error ? el('span', { class: 'warn-line' }, `⚠ 동기화 문제: ${member.error}`) : null,
          ),
        ),
      ),
    ),
    el(
      'p',
      { class: 'footnote' },
      '청취 시간은 재생한 곡의 전체 길이를 더한 값이라 실제와 조금 다를 수 있어요.',
      week.offset === 0 ? ' 증감은 지난주 같은 시점까지와 비교한 값이에요.' : ' 증감은 그 전 주와 비교한 값이에요.',
      estimated ? ` 재생 기록의 ${estimated}%는 곡 길이를 몰라 3분 30초로 계산했어요.` : '',
    ),
  );
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
          data.pairs.map((pair) => {
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
              el('div', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: { width: `${pair.score}%` } })),
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
  const changeWeek = (offset) => {
    state.week = offset;
    render();
  };

  app.replaceChildren(
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
          el('div', { class: 'hero-number' }, number(group.minutes), el('small', {}, '분')),
          el(
            'p',
            { class: 'hero-caption' },
            `우리 그룹이 ${weekName(week.offset)} 함께 들은 시간 · ${hoursLabel(group.minutes)}`,
          ),
        ),
        el(
          'div',
          { class: 'hero-facts' },
          el('div', { class: 'fact' }, el('b', {}, number(group.plays)), el('span', {}, '총 재생')),
          el('div', { class: 'fact' }, el('b', {}, number(group.uniqueTracks)), el('span', {}, '서로 다른 곡')),
          el('div', { class: 'fact' }, el('b', {}, String(members.length)), el('span', {}, '친구')),
        ),
      ),
      fader(members),
      members.length ? [nowPlayingSection(members), rankingSection(data), tasteSection(data)] : emptyHome(),
      state.session.static
        ? el('p', { class: 'footnote' }, el('button', { class: 'link-button', type: 'button', onclick: leaveGroup }, '다른 그룹으로 이동'))
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
          el('i', { style: { height: `${(minutes / max) * 82}%` } }),
        ),
      ),
    ),
    el('div', { class: 'day-labels' }, DAY_NAMES.map((name) => el('span', {}, name))),
  );
}

function hourStrip(byHour) {
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
        el('i', { class: `heat-${level(minutes)}`, 'data-tip': `${hour}시대: ${number(minutes)}분` }),
      ),
    ),
    el(
      'div',
      { class: 'hour-labels' },
      ['0시', '6시', '12시', '18시', '24시'].map((label) => el('span', {}, label)),
    ),
    byHour[peak] > 0 ? el('p', { class: 'peak-note' }, `가장 많이 듣는 시간은 ${peak}시대예요.`) : null,
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

  app.replaceChildren(
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
          [number(data.minutes), '청취 시간(분)'],
          [number(data.plays), '재생 횟수'],
          [number(data.uniqueTracks), '서로 다른 곡'],
          [number(data.uniqueArtists), '아티스트'],
        ].map(([value, label]) => el('div', { class: 'card stat' }, el('b', {}, value), el('span', {}, label))),
      ),
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
      state.session.demo || (state.session.static && !state.connect)
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

function renderWaiting() {
  const code = state.pendingCode;
  app.replaceChildren(
    el(
      'main',
      { class: 'gate' },
      el(
        'div',
        { class: 'card gate-card' },
        el('img', { src: 'favicon.svg', alt: '', width: '36', height: '36' }),
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
  app.replaceChildren(
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
          { class: 'btn primary', type: 'button', onclick: () => startSpotifyLogin(state.connect) },
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
  app.replaceChildren(
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
setupTooltips();
render();
