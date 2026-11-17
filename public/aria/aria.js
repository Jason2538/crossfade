// Aria: Spotify 음악을 Apple 앱 같은 화면으로 듣는 플레이어입니다. 크로스페이드 안의 탭으로 열립니다.
// lib.js 도 이 파일과 같은 버전으로 불러와서, 예전 파일이 섞이지 않게 합니다.
const {
  activeLine,
  artistNames,
  chunkLines,
  cleanTitle,
  foreignLines,
  formatTime,
  guessLanguage,
  normTrack,
  parseLRC,
  parseTranslation,
  pickImage,
  uniqueTracks,
  windowAround,
} = await import(`./lib.js${new URL(import.meta.url).search}`);

const FALLBACK_CLIENT_ID = '06b050ce121e47328a9c49319c0bc604';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-library-modify',
].join(' ');
// 크로스페이드(app.js)가 로그인 결과를 이 화면으로 넘길 때 이 키로 알아봅니다.
const KEYS = { token: 'aria_tok', state: 'aria_state', verifier: 'aria_v', recentSearch: 'aria_recent_search' };
// 다른 기기의 재생 상태를 묻는 간격. 크로스페이드·Luma와 같은 Spotify 앱 한도를 나눠 쓰므로 넉넉히 둡니다.
const POLL_MS = 5000;
const SEARCH_DELAY_MS = 350;
const LIKED_LIMIT = 500;
const PLAYLIST_LIMIT = 500;

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

/* ---------- 작은 도우미 ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

const ICONS = {
  play: ['M8 5.6v12.8c0 .8.9 1.3 1.6.9l10.2-6.4c.6-.4.6-1.3 0-1.7L9.6 4.8C8.9 4.3 8 4.8 8 5.6z', 'fill'],
  pause: ['M7 5.5c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v13c0 .6-.4 1-1 1H8c-.6 0-1-.4-1-1zM13 5.5c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v13c0 .6-.4 1-1 1h-2c-.6 0-1-.4-1-1z', 'fill'],
  next: ['M3.5 6.6v10.8c0 .7.8 1.1 1.3.7L12 12.9v4.5c0 .7.8 1.1 1.3.7l7.6-5.4c.5-.3.5-1 0-1.4l-7.6-5.4c-.5-.4-1.3 0-1.3.7v4.5L4.8 5.9c-.5-.4-1.3 0-1.3.7z', 'fill'],
  prev: ['M20.5 6.6v10.8c0 .7-.8 1.1-1.3.7L12 12.9v4.5c0 .7-.8 1.1-1.3.7l-7.6-5.4c-.5-.3-.5-1 0-1.4l7.6-5.4c.5-.4 1.3 0 1.3.7v4.5l7.2-5.2c.5-.4 1.3 0 1.3.7z', 'fill'],
  heart: ['M12 20s-7.5-4.6-9.2-9.4C1.6 7.3 3.7 4.5 6.9 4.5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.2 0 5.3 2.8 4.1 6.1C19.5 15.4 12 20 12 20z', 'stroke'],
  heartFill: ['M12 20s-7.5-4.6-9.2-9.4C1.6 7.3 3.7 4.5 6.9 4.5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.2 0 5.3 2.8 4.1 6.1C19.5 15.4 12 20 12 20z', 'fill'],
  listen: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8.6v6.8c0 .5.5.7.9.5l5.3-3.4c.4-.2.4-.8 0-1L10.9 8.1c-.4-.2-.9 0-.9.5z', 'stroke'],
  library: ['M5 4v16M9.5 4v16M14 5l4.5 14.5', 'stroke'],
  search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3 20 20', 'stroke'],
  translate: ['M4 5.5h9M8.5 3.5v2M6 5.5c.5 3.5 2.5 6 5.5 7.5M11 5.5c-.8 3.5-3 6-6.5 7.5M13 20.5l3.8-9 3.7 9M14.3 17.5h5', 'stroke'],
  lyrics: ['M5 5.5h14c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5H11l-4.5 3.5V16.5H5c-.8 0-1.5-.7-1.5-1.5V7c0-.8.7-1.5 1.5-1.5zM8 9.5h8M8 12.5h5', 'stroke'],
  devices: ['M7 3.5h10c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H7c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zM12 10.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 6.5h.01', 'stroke'],
  queue: ['M4 6.5h11M4 11.5h11M4 16.5h7M17.5 14v6M15 17h5', 'stroke'],
  down: ['M6 9.5l6 6 6-6', 'stroke'],
  back: ['M15 5l-7 7 7 7', 'stroke'],
  shuffle: ['M3.5 7h3c2.2 0 3.4 1 4.5 3l2 4c1.1 2 2.3 3 4.5 3h3M17.5 14.5l3 2.5-3 2.5M3.5 17h3c1.4 0 2.4-.4 3.2-1.2M13.8 8.2c.8-.8 1.8-1.2 3.2-1.2h3.5M17.5 4.5l3 2.5-3 2.5', 'stroke'],
  repeat: ['M4 11V9.5C4 7.6 5.6 6 7.5 6h12M17 3.5 19.5 6 17 8.5M20 13v1.5c0 1.9-1.6 3.5-3.5 3.5h-12M7 20.5 4.5 18 7 15.5', 'stroke'],
  volLow: ['M4 9.5h3l4-3.5v12l-4-3.5H4z', 'fill'],
  volHigh: ['M4 9.5h3l4-3.5v12l-4-3.5H4zM15 9c1 .8 1.5 1.8 1.5 3s-.5 2.2-1.5 3M17.5 6.5c1.7 1.4 2.5 3.3 2.5 5.5s-.8 4.1-2.5 5.5', 'stroke'],
  shuffleSmall: ['M3.5 7h3c2.2 0 3.4 1 4.5 3l2 4c1.1 2 2.3 3 4.5 3h3M17.5 14.5l3 2.5-3 2.5M3.5 17h3c1.4 0 2.4-.4 3.2-1.2M13.8 8.2c.8-.8 1.8-1.2 3.2-1.2h3.5M17.5 4.5l3 2.5-3 2.5', 'stroke'],
};

function icon(name, extra = '') {
  const [d, mode] = ICONS[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ic ${mode} ${extra}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

let toastTimer = 0;
function toast(message, ms = 3200) {
  $toast.textContent = message;
  $toast.hidden = false;
  $toast.classList.remove('out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.classList.add('out');
    setTimeout(() => ($toast.hidden = true), 300);
  }, ms);
}

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 저장하지 못하면 이번에만 씁니다.
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 무시
    }
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = (size) => base64Url(crypto.getRandomValues(new Uint8Array(size))).slice(0, size);

/* ---------- 로그인 (PKCE, 크로스페이드와 같은 Spotify 앱) ---------- */
let clientId = FALLBACK_CLIENT_ID;
let tok = null;
try {
  tok = JSON.parse(storage.get(KEYS.token));
} catch {
  tok = null;
}

const redirectUri = () => location.origin + location.pathname.replace(/aria\/(index\.html)?$/, '');

async function loadClientId() {
  try {
    const site = await (await fetch(`../site.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    if (site?.connect?.spotifyClientId) clientId = site.connect.spotifyClientId;
  } catch {
    // 로컬 시험처럼 site.json 이 없으면 기본 값을 씁니다.
  }
}

function saveToken(body) {
  tok = {
    access: body.access_token,
    refresh: body.refresh_token || tok?.refresh,
    exp: Date.now() + (body.expires_in || 3600) * 1000,
    scope: body.scope || tok?.scope || '',
  };
  storage.set(KEYS.token, JSON.stringify(tok));
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error_description || body.error || '로그인 오류'), { status: response.status });
  return body;
}

async function login() {
  const verifier = randomText(64);
  const state = `aria.${randomText(16)}`;
  storage.set(KEYS.verifier, verifier);
  storage.set(KEYS.state, state);
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })}`;
  // Spotify 로그인 화면은 다른 화면 안에서 열리지 않아서 바깥 창을 이동합니다.
  window.top.location.href = url;
}

async function handleCallback() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  history.replaceState(null, '', location.pathname);
  if (params.get('error')) return toast('로그인을 취소했어요');
  if (params.get('state') !== storage.get(KEYS.state)) return toast('로그인 정보가 맞지 않아요. 다시 시도해 주세요');
  try {
    saveToken(
      await tokenRequest({
        grant_type: 'authorization_code',
        code: params.get('code'),
        redirect_uri: redirectUri(),
        client_id: clientId,
        code_verifier: storage.get(KEYS.verifier),
      }),
    );
  } catch (error) {
    toast(`로그인하지 못했어요: ${error.message}`, 6000);
  } finally {
    storage.del(KEYS.state);
    storage.del(KEYS.verifier);
  }
}

let refreshing = null;
async function accessToken(force = false) {
  if (!tok) throw Object.assign(new Error('로그인이 필요해요'), { status: 401 });
  if (!force && Date.now() < tok.exp - 60_000) return tok.access;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: clientId })
    .then((body) => {
      saveToken(body);
      return tok.access;
    })
    .catch((error) => {
      if (error.status === 400 || error.status === 401) logout('로그인이 만료됐어요. 다시 로그인해 주세요');
      throw error;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function logout(message) {
  tok = null;
  storage.del(KEYS.token);
  try {
    sdk.player?.disconnect();
  } catch {
    // 무시
  }
  if (message) toast(message, 5000);
  renderLogin();
}

// Spotify가 "요청이 너무 많다"(429)고 하면 알려 준 시간까지 모든 요청을 쉽니다.
let rateLimitedUntil = 0;
const rateLimited = () => Date.now() < rateLimitedUntil;

function rateLimitError() {
  const seconds = Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
  const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`;
  return Object.assign(new Error(`Spotify 요청이 너무 많아 잠시 막혔어요. ${wait} 뒤에 다시 시도해 주세요`), { status: 429 });
}

// 크로스페이드에서 다른 탭(크로스페이드·Luma)을 보고 있으면 이 화면은 숨겨져 있습니다.
const away = () => {
  try {
    return document.hidden || Boolean(window.frameElement && !window.frameElement.getClientRects().length);
  } catch {
    return document.hidden;
  }
};

async function api(path, { method = 'GET', body, retry = true } = {}) {
  if (rateLimited()) throw rateLimitError();
  const response = await fetch(path.startsWith('http') ? path : API_URL + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && retry) {
    await accessToken(true);
    return api(path, { method, body, retry: false });
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After')) || 5;
    rateLimitedUntil = Date.now() + seconds * 1000;
    // 잠깐이면 기다렸다가 한 번만 다시 하고, 길면 바로 알려 줍니다.
    if (retry && seconds <= 5) {
      await sleep(seconds * 1000);
      return api(path, { method, body, retry: false });
    }
    throw rateLimitError();
  }
  if (response.status === 204 || response.status === 202) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Spotify 오류 ${response.status}`), { status: response.status, reason: data?.error?.reason });
  return data;
}

/* ---------- 재생 상태 ---------- */
const S = {
  track: null,
  paused: true,
  position: 0,
  at: Date.now(),
  shuffle: false,
  repeat: 'off',
  device: null,
  local: false,
  volume: 70,
};
const position = () => Math.min(S.track?.duration ?? 0, S.position + (S.paused ? 0 : Date.now() - S.at));
const listeners = new Set();
function setPlayback(next) {
  Object.assign(S, next, { at: Date.now() });
  for (const listener of listeners) listener();
}

const sdk = { player: null, deviceId: null, failed: false, waiters: [] };

function startSdk() {
  // 휴대폰 브라우저는 웹 재생을 지원하지 않아서 Spotify 앱을 리모컨처럼 씁니다.
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    sdk.failed = true;
    return;
  }
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new window.Spotify.Player({
      name: 'Aria (웹)',
      getOAuthToken: (callback) => accessToken().then(callback).catch(() => {}),
      volume: S.volume / 100,
    });
    player.addListener('ready', ({ device_id: id }) => {
      sdk.deviceId = id;
      sdk.waiters.splice(0).forEach((resolve) => resolve(id));
    });
    player.addListener('not_ready', () => {
      sdk.deviceId = null;
    });
    player.addListener('player_state_changed', (state) => {
      if (!state) {
        S.local = false;
        return;
      }
      const current = state.track_window.current_track;
      setPlayback({
        track: current ? normTrack({ ...current, album: current.album }) : null,
        paused: state.paused,
        position: state.position,
        shuffle: state.shuffle,
        repeat: ['off', 'context', 'track'][state.repeat_mode] ?? 'off',
        local: true,
        device: { name: 'Aria (웹)', id: sdk.deviceId },
      });
    });
    player.addListener('account_error', () => {
      sdk.failed = true;
      toast('웹에서 바로 재생하려면 Spotify Premium이 필요해요. Spotify 앱으로 재생할게요', 6000);
    });
    player.addListener('initialization_error', () => {
      sdk.failed = true;
      sdk.waiters.splice(0).forEach((resolve) => resolve(null));
    });
    player.addListener('autoplay_failed', () => toast('브라우저가 자동 재생을 막았어요. 재생 버튼을 한 번 눌러 주세요', 5000));
    player.connect();
    sdk.player = player;
  };
  const script = document.createElement('script');
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  script.async = true;
  document.head.append(script);
}

function waitForSdk(ms = 6000) {
  if (sdk.deviceId || sdk.failed) return Promise.resolve(sdk.deviceId);
  return new Promise((resolve) => {
    sdk.waiters.push(resolve);
    setTimeout(() => resolve(sdk.deviceId), ms);
  });
}

// 이 화면에서 재생할 수 있으면 이 화면을, 아니면 지금 켜져 있는 Spotify 기기를 씁니다.
async function targetDevice() {
  const own = await waitForSdk();
  if (own) return own;
  const { devices = [] } = (await api('/me/player/devices')) ?? {};
  const device = devices.find((item) => item.is_active) ?? devices.find((item) => !item.is_restricted);
  if (!device) {
    toast('재생할 기기가 없어요. 휴대폰이나 컴퓨터에서 Spotify 앱을 한 번 열어 주세요', 7000);
    return null;
  }
  return device.id;
}

// context 가 있으면 앨범·플레이리스트를 이어서, 없으면 곡 목록(최대 100곡)을 재생합니다.
async function play({ tracks = [], index = 0, contextUri = null, shuffle = false }) {
  const chosen = tracks[index];
  if (chosen) setPlayback({ track: chosen, paused: false, position: 0 });
  sdk.player?.activateElement?.();
  try {
    const device = await targetDevice();
    if (!device) return;
    const query = `?device_id=${encodeURIComponent(device)}`;
    if (shuffle !== S.shuffle) await api(`/me/player/shuffle?state=${shuffle}&device_id=${encodeURIComponent(device)}`, { method: 'PUT' }).catch(() => {});
    S.shuffle = shuffle;
    let body;
    if (contextUri) {
      body = { context_uri: contextUri };
      if (!shuffle && chosen) body.offset = { uri: chosen.uri };
    } else {
      const { uris, position: offset } = windowAround(tracks, index);
      body = { uris, offset: { position: shuffle ? Math.floor(Math.random() * uris.length) : offset } };
    }
    await api(`/me/player/play${query}`, { method: 'PUT', body });
    setTimeout(pollPlayback, 900);
  } catch (error) {
    playbackError(error);
  }
}

function playbackError(error) {
  if (error.status === 429) toast(error.message, 6000);
  else if (error.status === 403) toast('Spotify가 재생을 거절했어요. Premium 계정인지 확인해 주세요', 6000);
  else if (error.status === 404) toast('재생할 기기를 찾지 못했어요. Spotify 앱을 한 번 열어 주세요', 6000);
  else toast(`재생하지 못했어요: ${error.message}`, 5000);
}

async function control(action) {
  try {
    if (S.local && sdk.player) {
      if (action === 'toggle') await sdk.player.togglePlay();
      if (action === 'next') await sdk.player.nextTrack();
      if (action === 'prev') await (position() > 3000 ? sdk.player.seek(0) : sdk.player.previousTrack());
      return;
    }
    if (action === 'toggle') {
      if (!S.track) return;
      setPlayback({ paused: !S.paused, position: position() });
      await api(S.paused ? '/me/player/pause' : '/me/player/play', { method: 'PUT' });
    }
    if (action === 'next') await api('/me/player/next', { method: 'POST' });
    if (action === 'prev') {
      if (position() > 3000) await api('/me/player/seek?position_ms=0', { method: 'PUT' });
      else await api('/me/player/previous', { method: 'POST' });
    }
    setTimeout(pollPlayback, 600);
  } catch (error) {
    playbackError(error);
    pollPlayback();
  }
}

async function seek(ms) {
  setPlayback({ position: ms });
  try {
    if (S.local && sdk.player) await sdk.player.seek(ms);
    else await api(`/me/player/seek?position_ms=${Math.round(ms)}`, { method: 'PUT' });
  } catch (error) {
    playbackError(error);
  }
}

async function setVolume(value) {
  S.volume = value;
  try {
    if (S.local && sdk.player) await sdk.player.setVolume(value / 100);
    else await api(`/me/player/volume?volume_percent=${Math.round(value)}`, { method: 'PUT' });
  } catch {
    // 휴대폰 앱은 소리 크기 조절을 막는 경우가 많습니다.
  }
}

async function toggleShuffle() {
  const next = !S.shuffle;
  setPlayback({ shuffle: next, position: position() });
  await api(`/me/player/shuffle?state=${next}`, { method: 'PUT' }).catch(playbackError);
}

async function cycleRepeat() {
  const next = { off: 'context', context: 'track', track: 'off' }[S.repeat];
  setPlayback({ repeat: next, position: position() });
  await api(`/me/player/repeat?state=${next}`, { method: 'PUT' }).catch(playbackError);
}

// 이 화면이 재생 중이 아닐 때는 다른 기기의 재생 상태를 가져옵니다.
async function pollPlayback() {
  if (!tok || away() || rateLimited()) return;
  if (S.local && sdk.player) return;
  try {
    const state = await api('/me/player');
    if (!state?.item) {
      if (S.track && !S.paused) setPlayback({ paused: true, position: position() });
      return;
    }
    setPlayback({
      track: state.item.type === 'track' ? normTrack(state.item) : S.track,
      paused: !state.is_playing,
      position: state.progress_ms ?? 0,
      shuffle: state.shuffle_state,
      repeat: state.repeat_state,
      device: state.device ? { name: state.device.name, id: state.device.id } : null,
      volume: state.device?.volume_percent ?? S.volume,
    });
  } catch {
    // 다음 확인 때 다시 시도합니다.
  }
}

/* ---------- 좋아요 ---------- */
const liked = new Map();
async function checkLiked(track) {
  if (!track?.id || liked.has(track.id)) return liked.get(track?.id);
  try {
    const [value] = await api(`/me/library/contains?uris=${encodeURIComponent(track.uri)}`);
    liked.set(track.id, Boolean(value));
  } catch {
    liked.set(track.id, false);
  }
  return liked.get(track.id);
}

async function toggleLike(track) {
  const next = !liked.get(track.id);
  liked.set(track.id, next);
  for (const listener of listeners) listener();
  np.like?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(0.9)' }, { transform: 'scale(1)' }], {
    duration: 520,
    easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  });
  try {
    await api(`/me/library?uris=${encodeURIComponent(track.uri)}`, { method: next ? 'PUT' : 'DELETE' });
    toast(next ? '좋아요 표시한 곡에 넣었어요' : '좋아요에서 뺐어요', 1800);
  } catch (error) {
    liked.set(track.id, !next);
    for (const listener of listeners) listener();
    toast(error.status === 403 ? '권한이 없어요. 다시 로그인해 주세요' : `바꾸지 못했어요: ${error.message}`);
  }
}

/* ---------- 데이터 ---------- */
const cache = new Map();
function cached(key, load) {
  if (!cache.has(key)) cache.set(key, load().catch((error) => (cache.delete(key), Promise.reject(error))));
  return cache.get(key);
}

async function pages(first, pick, limit) {
  const items = [];
  let url = first;
  while (url && items.length < limit) {
    const page = await api(url);
    items.push(...pick(page));
    url = page.next;
  }
  return items.slice(0, limit);
}

const loaders = {
  me: () => cached('me', () => api('/me')),
  recent: () =>
    cached('recent', async () => uniqueTracks(((await api('/me/player/recently-played?limit=50')).items ?? []).map((item) => normTrack(item.track)))),
  topTracks: () => cached('topTracks', async () => ((await api('/me/top/tracks?limit=40&time_range=short_term')).items ?? []).map((track) => normTrack(track))),
  topArtists: () => cached('topArtists', async () => (await api('/me/top/artists?limit=20&time_range=medium_term')).items ?? []),
  playlists: () => cached('playlists', () => pages('/me/playlists?limit=50', (page) => (page.items ?? []).filter(Boolean), 200)),
  liked: () =>
    cached('liked', () =>
      pages('/me/tracks?limit=50', (page) => (page.items ?? []).map((entry) => entry?.track ?? entry?.item).filter((track) => track?.uri).map((track) => normTrack(track)), LIKED_LIMIT),
    ),
  playlist: (id) =>
    cached(`playlist:${id}`, () =>
      pages(
        `/playlists/${id}/items?limit=50`,
        (page) =>
          (page.items ?? [])
            .map((entry) => entry?.item ?? entry?.track)
            .filter((track) => track?.type === 'track' && !track.is_local && track.uri)
            .map((track) => normTrack(track)),
        PLAYLIST_LIMIT,
      ),
    ),
  album: (id) => cached(`album:${id}`, () => api(`/albums/${id}`)),
  artistTracks: (name) =>
    cached(`artist:${name}`, async () => {
      const query = `artist:"${name.replace(/"/g, '')}"`;
      const tracks = [];
      for (let offset = 0; offset < 30; offset += 10) {
        const page = await api(`/search?${new URLSearchParams({ q: query, type: 'track', limit: 10, offset })}`);
        tracks.push(...(page.tracks?.items ?? []).filter(Boolean).map((track) => normTrack(track)));
        if (!page.tracks?.next) break;
      }
      return uniqueTracks(tracks);
    }),
};

/* ---------- 화면 구조 ---------- */
// 화면마다 자기 스크롤을 가진 판(.view)을 만들어 쌓아 둡니다. 뒤로 가면 다시 그리지 않고 그 판을 그대로 보여 줘서
// 보던 위치가 남고, 넘길 때는 iOS처럼 새 판이 오른쪽에서 들어오고 이전 판은 살짝 왼쪽으로 밀리며 어두워집니다.
const TABS = [
  { id: 'listen', label: '지금 듣기', icon: 'listen' },
  { id: 'library', label: '보관함', icon: 'library' },
  { id: 'search', label: '검색', icon: 'search' },
];
const nav = { tab: 'listen', stacks: { listen: [{ type: 'listen' }], library: [{ type: 'library' }], search: [{ type: 'search' }] }, busy: false };
const parts = {};
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const PUSH_MS = 520;
const PARALLAX = 0.3;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function buildShell() {
  parts.page = el('main', { class: 'page', id: 'page' });
  parts.mini = el('button', { class: 'mini', type: 'button', hidden: true, onclick: openNowPlaying, 'aria-label': '지금 재생 중 화면 열기' });
  parts.tabbar = el(
    'nav',
    { class: 'tabbar', 'aria-label': '메뉴' },
    TABS.map((tab) =>
      el(
        'button',
        { type: 'button', 'data-tab': tab.id, onclick: (event) => selectTab(tab.id, event.currentTarget) },
        icon(tab.icon),
        el('span', {}, tab.label),
      ),
    ),
  );
  parts.sheet = buildNowPlaying();
  $app.replaceChildren(parts.page, parts.mini, parts.tabbar, parts.sheet);
  listeners.add(renderMini);
  listeners.add(renderNowPlaying);
  listeners.add(markPlayingRows);
}

const stack = () => nav.stacks[nav.tab];
const top = () => stack()[stack().length - 1];
const tabLabel = () => TABS.find((tab) => tab.id === nav.tab).label;

// 판 하나를 만들고 내용을 채웁니다. 위쪽에는 스크롤하면 나타나는 작은 제목 막대가 있습니다.
function createViewNode(view, depth) {
  const smallTitle = el('span', { class: 'nav-title' });
  const back =
    depth > 0
      ? el('button', { class: 'back-button', type: 'button', onclick: () => pop() }, icon('back'), el('span', {}, stack()[depth - 1]?.title ?? tabLabel()))
      : null;
  const bar = el('div', { class: 'nav-bar' }, el('span', { class: 'nav-side' }, back), smallTitle, el('span', { class: 'nav-side' }));
  const body = el('div', { class: 'view-body' }, el('div', { class: 'spinner' }));
  const node = el('div', { class: 'view' }, bar, body);
  // 큰 제목이 지나가면 작은 제목과 흐린 막대가 나타납니다.
  node.addEventListener(
    'scroll',
    () => {
      const heading = body.querySelector('.large-title h1, .detail h1');
      const limit = heading ? heading.offsetTop + heading.offsetHeight - bar.offsetHeight : 40;
      node.classList.toggle('scrolled', node.scrollTop > Math.max(4, limit));
    },
    { passive: true },
  );
  view.node = node;
  fillView(view, body, smallTitle);
  return node;
}

async function fillView(view, body, smallTitle) {
  try {
    const nodes = await VIEWS[view.type](view);
    body.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
    smallTitle.textContent = view.title ?? tabLabel();
    body.classList.add('ready');
    markPlayingRows();
  } catch (error) {
    if (error.status === 401) return;
    body.replaceChildren(el('div', { class: 'empty' }, el('b', {}, '불러오지 못했어요'), el('span', {}, error.message)));
  }
}

function setX(node, x, ms = 0) {
  node.style.transition = ms ? `transform ${ms}ms ${EASE}, filter ${ms}ms ${EASE}` : 'none';
  node.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
}

function dim(node, amount, ms = 0) {
  node.style.setProperty('--dim', String(amount));
  if (ms) node.style.transition += `, --dim ${ms}ms`;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms + 30));

function showTab() {
  for (const button of parts.tabbar.querySelectorAll('button')) button.classList.toggle('on', button.dataset.tab === nav.tab);
  for (const node of parts.page.children) node.hidden = true;
  const current = top();
  if (!current.node) parts.page.append(createViewNode(current, stack().length - 1));
  current.node.hidden = false;
  current.node.classList.remove('behind');
  markPlayingRows();
}

async function selectTab(id, button) {
  if (nav.busy) return;
  // 아이콘이 톡 튀었다가 자리를 잡습니다.
  button?.querySelector('.ic')?.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.78)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], {
    duration: 420,
    easing: 'ease-out',
  });
  if (nav.tab === id) {
    // 같은 탭을 다시 누르면 맨 처음 화면으로, 이미 처음이면 맨 위로 갑니다.
    if (stack().length > 1) return popToRoot();
    top().node?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  nav.tab = id;
  showTab();
  const node = top().node;
  if (!reduceMotion()) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
}

async function push(view) {
  if (nav.busy) return;
  nav.busy = true;
  const below = top().node;
  stack().push(view);
  const node = createViewNode(view, stack().length - 1);
  parts.page.append(node);
  if (!reduceMotion()) {
    const width = parts.page.clientWidth;
    setX(node, width);
    node.getBoundingClientRect();
    setX(node, 0, PUSH_MS);
    setX(below, -width * PARALLAX, PUSH_MS);
    below.classList.add('behind');
    await settle(PUSH_MS);
  }
  below.hidden = true;
  setX(below, 0);
  setX(node, 0);
  nav.busy = false;
}

// from 은 이미 끌어 놓은 거리입니다(가장자리 끌기에서 씁니다).
async function pop({ from = 0 } = {}) {
  if (nav.busy || stack().length < 2) return;
  nav.busy = true;
  const leaving = stack().pop();
  const node = leaving.node;
  const below = top().node;
  below.hidden = false;
  if (!reduceMotion()) {
    const width = parts.page.clientWidth;
    setX(below, -width * PARALLAX + from * PARALLAX);
    setX(node, from);
    below.getBoundingClientRect();
    below.classList.remove('behind');
    const ms = Math.max(200, PUSH_MS * (1 - from / width));
    setX(node, width, ms);
    setX(below, 0, ms);
    await settle(ms);
  } else below.classList.remove('behind');
  node.remove();
  setX(below, 0);
  nav.busy = false;
  markPlayingRows();
}

function popToRoot() {
  while (stack().length > 2) stack().splice(stack().length - 2, 1)[0].node?.remove();
  return pop();
}

// 왼쪽 가장자리에서 끌어 뒤로 가기. 크로스페이드가 가장자리 끌기를 이쪽으로 넘겨 줍니다.
window.ariaBack = {
  can: () => !nav.busy && !np.open && stack().length > 1,
  move(dx) {
    const width = parts.page.clientWidth;
    const x = Math.max(0, Math.min(width, dx));
    const below = stack()[stack().length - 2].node;
    below.hidden = false;
    setX(top().node, x);
    setX(below, -width * PARALLAX + x * PARALLAX);
    below.classList.toggle('behind', x < width * 0.5);
  },
  end(dx, speed) {
    const width = parts.page.clientWidth;
    const below = stack()[stack().length - 2].node;
    if (dx > width * 0.35 || speed > 0.4) return pop({ from: Math.max(0, dx) });
    setX(top().node, 0, 320);
    setX(below, -width * PARALLAX, 320);
    below.classList.add('behind');
    setTimeout(() => {
      if (stack()[stack().length - 2]?.node === below) below.hidden = true;
      setX(below, 0);
    }, 350);
  },
};

// 컴퓨터에서도 판 왼쪽 가장자리를 끌어 뒤로 갈 수 있습니다(휴대폰은 크로스페이드의 가장자리 막대가 넘겨 줍니다).
function attachEdgeBack() {
  let start = null;
  parts.page.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.clientX > 24 || !window.ariaBack.can()) return;
    start = { x: event.clientX, t: event.timeStamp, id: event.pointerId };
    parts.page.setPointerCapture(event.pointerId);
  });
  parts.page.addEventListener('pointermove', (event) => {
    if (start?.id === event.pointerId) window.ariaBack.move(event.clientX - start.x);
  });
  const end = (event) => {
    if (start?.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    window.ariaBack.end(dx, dx / Math.max(1, event.timeStamp - start.t));
    start = null;
  };
  parts.page.addEventListener('pointerup', end);
  parts.page.addEventListener('pointercancel', end);
}

function renderPage() {
  showTab();
  attachEdgeBack();
}

const largeTitle = (text, extra = null) => el('header', { class: 'large-title' }, el('h1', {}, text), extra);
const section = (title, ...children) => el('section', { class: 'shelf-section' }, el('h2', {}, title), children);

function art(url, { round = false, size = '' } = {}) {
  return el('span', { class: `art ${round ? 'round' : ''} ${size}` }, url ? el('img', { src: url, alt: '', loading: 'lazy' }) : el('span', { class: 'art-blank' }, '♪'));
}

function tile({ image, title, subtitle, round = false, onclick }) {
  return el('button', { class: `tile ${round ? 'round' : ''}`, type: 'button', onclick }, art(image, { round }), el('b', {}, title), subtitle ? el('small', {}, subtitle) : null);
}

function trackRow(track, { index, onplay, showArt = true, showNumber = false }) {
  return el(
    'button',
    { class: 'row', type: 'button', 'data-uri': track.uri, onclick: onplay },
    showNumber ? el('span', { class: 'num' }, String(track.number ?? index + 1)) : showArt ? art(track.thumb, { size: 'sm' }) : null,
    el(
      'span',
      { class: 'row-text' },
      el('b', {}, track.name, track.explicit ? el('i', { class: 'explicit', title: '청소년 이용 불가' }, 'E') : null),
      el('small', {}, artistNames(track)),
    ),
    el('span', { class: 'eq', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
    el('span', { class: 'dur' }, formatTime(track.duration)),
  );
}

function trackList(tracks, play, options = {}) {
  return el(
    'div',
    { class: 'list' },
    tracks.map((track, index) => trackRow(track, { index, onplay: () => play(index), ...options })),
  );
}

function markPlayingRows() {
  for (const row of parts.page?.querySelectorAll('.row') ?? []) {
    const on = row.dataset.uri === S.track?.uri;
    row.classList.toggle('playing', on);
    row.classList.toggle('paused', on && S.paused);
  }
}

// 큰 앨범 아트와 재생·셔플 버튼이 있는 상세 화면입니다.
function detailHeader({ image, title, subtitle, meta, onplay, onshuffle, round = false }) {
  return el(
    'header',
    { class: 'detail' },
    art(image, { round, size: 'hero' }),
    el('h1', {}, title),
    subtitle ? el('p', { class: 'detail-sub' }, subtitle) : null,
    meta ? el('p', { class: 'detail-meta' }, meta) : null,
    el(
      'div',
      { class: 'detail-actions' },
      el('button', { class: 'pill', type: 'button', onclick: onplay }, icon('play'), '재생'),
      el('button', { class: 'pill', type: 'button', onclick: onshuffle }, icon('shuffleSmall'), '셔플'),
    ),
  );
}

const minutesText = (tracks) => {
  const minutes = Math.round(tracks.reduce((sum, track) => sum + track.duration, 0) / 60000);
  return `${tracks.length}곡 · ${minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`}`;
};

const VIEWS = {
  async listen() {
    const [me, recent, top, artists, playlists] = await Promise.all([
      loaders.me(),
      loaders.recent().catch(() => []),
      loaders.topTracks().catch(() => []),
      loaders.topArtists().catch(() => []),
      loaders.playlists().catch(() => []),
    ]);
    const hour = new Date().getHours();
    const greeting = hour < 6 ? '늦은 밤이에요' : hour < 12 ? '좋은 아침이에요' : hour < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
    const avatar = pickImage(me.images, 64);
    return [
      largeTitle(
        '지금 듣기',
        el('span', { class: 'me' }, avatar ? el('img', { src: avatar, alt: '' }) : el('span', {}, (me.display_name ?? '?').charAt(0))),
      ),
      el('p', { class: 'greeting' }, `${greeting}, ${me.display_name ?? ''}님`),
      recent.length
        ? section(
            '최근 재생한 곡',
            el(
              'div',
              { class: 'shelf' },
              recent.slice(0, 20).map((track, index) =>
                tile({ image: track.cover, title: track.name, subtitle: artistNames(track), onclick: () => play({ tracks: recent, index }) }),
              ),
            ),
          )
        : null,
      top.length
        ? section(
            '요즘 많이 듣는 곡',
            el(
              'div',
              { class: 'shelf rows4' },
              top.map((track, index) => trackRow(track, { index, onplay: () => play({ tracks: top, index }) })),
            ),
          )
        : null,
      artists.length
        ? section(
            '좋아하는 아티스트',
            el(
              'div',
              { class: 'shelf' },
              artists.map((artist) =>
                tile({
                  image: pickImage(artist.images, 300),
                  title: artist.name,
                  round: true,
                  onclick: () => push({ type: 'artist', name: artist.name, image: pickImage(artist.images, 600), title: '지금 듣기' }),
                }),
              ),
            ),
          )
        : null,
      playlists.length
        ? section(
            '내 플레이리스트',
            el(
              'div',
              { class: 'shelf' },
              playlists.slice(0, 20).map((playlist) =>
                tile({
                  image: pickImage(playlist.images, 300),
                  title: playlist.name,
                  subtitle: playlist.owner?.display_name,
                  onclick: () => push({ type: 'playlist', playlist, title: '지금 듣기' }),
                }),
              ),
            ),
          )
        : null,
      !recent.length && !top.length ? el('div', { class: 'empty' }, el('b', {}, '아직 들은 곡이 없어요'), el('span', {}, '검색에서 듣고 싶은 곡을 찾아보세요.')) : null,
    ];
  },

  async library() {
    const playlists = await loaders.playlists().catch(() => []);
    const link = (label, iconName, onclick) => el('button', { class: 'lib-link', type: 'button', onclick }, icon(iconName), el('span', {}, label), el('i', { class: 'chev' }, '›'));
    return [
      largeTitle('보관함'),
      el(
        'div',
        { class: 'lib-links' },
        link('좋아요 표시한 곡', 'heartFill', () => push({ type: 'liked', title: '보관함' })),
        link('최근 재생한 곡', 'listen', () => push({ type: 'recent', title: '보관함' })),
      ),
      section(
        '플레이리스트',
        playlists.length
          ? el(
              'div',
              { class: 'grid' },
              playlists.map((playlist) =>
                tile({
                  image: pickImage(playlist.images, 300),
                  title: playlist.name,
                  subtitle: playlist.owner?.display_name,
                  onclick: () => push({ type: 'playlist', playlist, title: '보관함' }),
                }),
              ),
            )
          : el('div', { class: 'empty small' }, '플레이리스트가 없어요'),
      ),
    ];
  },

  async search(view) {
    const input = el('input', {
      type: 'search',
      placeholder: '아티스트, 노래, 앨범',
      value: view.query ?? '',
      enterkeyhint: 'search',
      autocomplete: 'off',
      'aria-label': '검색',
    });
    const results = el('div', { class: 'results' });
    let timer = 0;
    let sequence = 0;
    const run = async (query) => {
      view.query = query;
      const mine = ++sequence;
      if (!query.trim()) {
        results.replaceChildren(searchHome());
        return;
      }
      results.replaceChildren(el('div', { class: 'spinner' }));
      try {
        const data = await api(`/search?${new URLSearchParams({ q: query, type: 'track,artist,album', limit: 10 })}`);
        if (mine !== sequence) return;
        rememberSearch(query);
        results.replaceChildren(...[searchResults(data)].flat().filter(Boolean));
        markPlayingRows();
      } catch (error) {
        if (mine === sequence) results.replaceChildren(el('div', { class: 'empty' }, el('b', {}, '검색하지 못했어요'), el('span', {}, error.message)));
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(input.value), SEARCH_DELAY_MS);
    });
    const searchHome = () => {
      const recent = recentSearches();
      return recent.length
        ? section(
            '최근 검색',
            el(
              'div',
              { class: 'chips' },
              recent.map((query) =>
                el(
                  'button',
                  {
                    class: 'chip',
                    type: 'button',
                    onclick: () => {
                      input.value = query;
                      run(query);
                    },
                  },
                  query,
                ),
              ),
            ),
          )
        : el('div', { class: 'empty' }, el('b', {}, '무엇을 듣고 싶나요?'), el('span', {}, '아티스트, 노래, 앨범을 검색해 보세요.'));
    };
    run(view.query ?? '');
    setTimeout(() => {
      if (!view.query) input.focus({ preventScroll: true });
    }, 50);
    return [largeTitle('검색'), el('div', { class: 'search-box' }, icon('search'), input), results];
  },

  async playlist(view) {
    const { playlist } = view;
    view.title = playlist.name;
    let tracks = [];
    let blocked = false;
    try {
      tracks = await loaders.playlist(playlist.id);
    } catch (error) {
      // Spotify 정책상 남이 만든 플레이리스트는 곡 목록을 못 읽지만 재생은 됩니다.
      if (error.status !== 403) throw error;
      blocked = true;
    }
    const playAt = (index, shuffle = false) => play({ tracks, index, contextUri: playlist.uri, shuffle });
    return [
      detailHeader({
        image: pickImage(playlist.images, 600),
        title: playlist.name,
        subtitle: playlist.owner?.display_name,
        meta: tracks.length ? minutesText(tracks) : null,
        onplay: () => playAt(0),
        onshuffle: () => playAt(0, true),
      }),
      playlist.description ? el('p', { class: 'description' }, new DOMParser().parseFromString(playlist.description, 'text/html').body.textContent) : null,
      blocked
        ? el('div', { class: 'empty small' }, '다른 사람이 만든 플레이리스트라 곡 목록은 볼 수 없어요. 위의 재생 버튼으로는 들을 수 있어요.')
        : trackList(tracks, (index) => playAt(index)),
    ];
  },

  async album(view) {
    const album = await loaders.album(view.id);
    view.title = album.name;
    const tracks = (album.tracks?.items ?? []).map((track) => normTrack(track, album));
    const year = (album.release_date ?? '').slice(0, 4);
    const playAt = (index, shuffle = false) => play({ tracks, index, contextUri: album.uri, shuffle });
    return [
      detailHeader({
        image: pickImage(album.images, 600),
        title: album.name,
        subtitle: (album.artists ?? []).map((artist) => artist.name).join(', '),
        meta: [album.album_type === 'single' ? '싱글' : '앨범', year, minutesText(tracks)].filter(Boolean).join(' · '),
        onplay: () => playAt(0),
        onshuffle: () => playAt(0, true),
      }),
      trackList(tracks, (index) => playAt(index), { showNumber: true }),
      album.label ? el('p', { class: 'footnote' }, `${album.release_date ?? ''} · ${album.label}`) : null,
    ];
  },

  async artist(view) {
    view.title = view.name;
    const tracks = await loaders.artistTracks(view.name);
    const playAt = (index, shuffle = false) => play({ tracks, index, shuffle });
    const albums = uniqueTracks(tracks.map((track) => ({ ...track.album, uri: track.album.uri, cover: track.cover })).filter((album) => album.id));
    return [
      detailHeader({
        image: view.image || tracks[0]?.cover,
        title: view.name,
        subtitle: '아티스트',
        meta: null,
        round: true,
        onplay: () => playAt(0),
        onshuffle: () => playAt(0, true),
      }),
      section('곡', trackList(tracks, (index) => playAt(index))),
      albums.length
        ? section(
            '앨범',
            el(
              'div',
              { class: 'shelf' },
              albums.map((album) => tile({ image: album.cover, title: album.name, onclick: () => push({ type: 'album', id: album.id, title: view.name }) })),
            ),
          )
        : null,
    ];
  },

  async liked(view) {
    view.title = '좋아요 표시한 곡';
    const tracks = await loaders.liked();
    for (const track of tracks) liked.set(track.id, true);
    const playAt = (index, shuffle = false) => play({ tracks, index, shuffle });
    return [
      detailHeader({
        image: null,
        title: '좋아요 표시한 곡',
        subtitle: '보관함',
        meta: minutesText(tracks),
        onplay: () => playAt(0),
        onshuffle: () => playAt(0, true),
      }),
      trackList(tracks, (index) => playAt(index)),
    ];
  },

  async recent(view) {
    view.title = '최근 재생한 곡';
    const tracks = await loaders.recent();
    return [largeTitle('최근 재생한 곡'), trackList(tracks, (index) => play({ tracks, index }))];
  },
};

function searchResults(data) {
  const tracks = (data.tracks?.items ?? []).filter(Boolean).map((track) => normTrack(track));
  const artists = (data.artists?.items ?? []).filter(Boolean);
  const albums = (data.albums?.items ?? []).filter(Boolean);
  if (!tracks.length && !artists.length && !albums.length) return el('div', { class: 'empty' }, el('b', {}, '검색 결과가 없어요'), el('span', {}, '다른 단어로 찾아보세요.'));
  return [
    tracks.length ? section('노래', trackList(tracks, (index) => play({ tracks, index }))) : null,
    artists.length
      ? section(
          '아티스트',
          el(
            'div',
            { class: 'shelf' },
            artists.map((artist) =>
              tile({
                image: pickImage(artist.images, 300),
                title: artist.name,
                round: true,
                onclick: () => push({ type: 'artist', name: artist.name, image: pickImage(artist.images, 600), title: '검색' }),
              }),
            ),
          ),
        )
      : null,
    albums.length
      ? section(
          '앨범',
          el(
            'div',
            { class: 'shelf' },
            albums.map((album) =>
              tile({
                image: pickImage(album.images, 300),
                title: album.name,
                subtitle: (album.artists ?? []).map((artist) => artist.name).join(', '),
                onclick: () => push({ type: 'album', id: album.id, title: '검색' }),
              }),
            ),
          ),
        )
      : null,
  ];
}

function recentSearches() {
  try {
    return JSON.parse(storage.get(KEYS.recentSearch)) ?? [];
  } catch {
    return [];
  }
}

function rememberSearch(query) {
  const list = [query.trim(), ...recentSearches().filter((item) => item !== query.trim())].slice(0, 8);
  storage.set(KEYS.recentSearch, JSON.stringify(list));
}

/* ---------- 미니 플레이어 ---------- */
function renderMini() {
  const track = S.track;
  parts.mini.hidden = !track;
  document.body.classList.toggle('has-mini', Boolean(track));
  if (!track) return;
  const key = `${track.uri}:${S.paused}`;
  if (parts.mini.dataset.key === key) return;
  parts.mini.dataset.key = key;
  const button = (name, label, action) =>
    el(
      'span',
      {
        class: 'mini-btn',
        role: 'button',
        tabindex: '0',
        'aria-label': label,
        onclick: (event) => {
          event.stopPropagation();
          control(action);
        },
      },
      icon(name),
    );
  parts.mini.replaceChildren(
    art(track.thumb, { size: 'mini-art' }),
    el('span', { class: 'mini-text' }, el('b', {}, track.name), el('small', {}, artistNames(track))),
    button(S.paused ? 'play' : 'pause', S.paused ? '재생' : '일시 정지', 'toggle'),
    button('next', '다음 곡', 'next'),
  );
}

/* ---------- 지금 재생 중 (전체 화면) ---------- */
// 휴대폰에서 재생 화면을 열면 처음엔 가사를 보여 주고, 그 뒤로는 마지막에 고른 화면(앨범 아트·가사)을 기억합니다.
const PANEL_KEY = 'aria_panel';
const np = { open: false, panel: storage.get(PANEL_KEY) === 'art' ? 'art' : 'lyrics', lyrics: null, lyricsFor: null, dragging: false };
// 넓은 화면에서는 가사를 오른쪽에 늘 보여 줍니다.
const wideLayout = () => matchMedia('(min-width: 900px) and (min-height: 560px)').matches;
const lyricsVisible = () => np.panel === 'lyrics' || wideLayout();

function buildNowPlaying() {
  const sheet = el('section', { class: 'np', 'aria-label': '지금 재생 중', 'aria-hidden': 'true' });
  np.bgA = el('div', { class: 'np-bg' });
  np.close = el('button', { class: 'np-close', type: 'button', 'aria-label': '닫기', onclick: closeNowPlaying }, el('i'));
  np.art = el('div', { class: 'np-art' });
  np.lyricsBox = el('div', { class: 'np-lyrics' });
  np.listBox = el('div', { class: 'np-list' });
  np.title = el('b', { class: 'np-title' });
  np.artist = el('button', { class: 'np-artist', type: 'button' });
  np.like = el('button', { class: 'np-icon like', type: 'button', 'aria-label': '좋아요' });
  np.like.addEventListener('click', () => S.track && toggleLike(S.track));
  np.bar = el('input', { class: 'np-bar', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': '재생 위치' });
  np.bar.addEventListener('input', () => {
    np.dragging = true;
    np.elapsed.textContent = formatTime((np.bar.value / 1000) * (S.track?.duration ?? 0));
    paintRange(np.bar);
  });
  np.bar.addEventListener('change', () => {
    np.dragging = false;
    seek((np.bar.value / 1000) * (S.track?.duration ?? 0));
  });
  np.elapsed = el('span');
  np.remain = el('span');
  np.toggle = el('button', { class: 'np-play', type: 'button', 'aria-label': '재생', onclick: () => control('toggle') });
  np.shuffle = el('button', { class: 'np-icon small', type: 'button', 'aria-label': '셔플', onclick: toggleShuffle }, icon('shuffle'));
  np.repeat = el('button', { class: 'np-icon small', type: 'button', 'aria-label': '반복', onclick: cycleRepeat }, icon('repeat'));
  np.volume = el('input', { class: 'np-vol', type: 'range', min: '0', max: '100', value: String(S.volume), 'aria-label': '소리 크기' });
  np.volume.addEventListener('input', () => paintRange(np.volume));
  np.volume.addEventListener('change', () => setVolume(Number(np.volume.value)));
  np.device = el('span', { class: 'np-device' });
  np.tools = {
    lyrics: el('button', { class: 'np-tool', type: 'button', 'aria-label': '가사', onclick: () => showPanel('lyrics') }, icon('lyrics')),
    devices: el('button', { class: 'np-tool', type: 'button', 'aria-label': '재생 기기', onclick: () => showPanel('devices') }, icon('devices')),
    queue: el('button', { class: 'np-tool', type: 'button', 'aria-label': '다음 곡', onclick: () => showPanel('queue') }, icon('queue')),
  };
  // 번역 버튼은 가사가 외국어일 때만 아래 도구 줄에 나타납니다.
  np.translateButton = el(
    'button',
    { class: 'np-tool np-translate', type: 'button', 'aria-label': '가사 번역', hidden: true, onclick: toggleTranslation },
    icon('translate'),
    el('span', {}, '번역'),
  );

  sheet.append(
    np.bgA,
    el('div', { class: 'np-shade' }),
    el(
      'div',
      { class: 'np-inner' },
      np.close,
      el('div', { class: 'np-stage' }, np.art, np.listBox),
      np.lyricsBox,
      el(
        'div',
        { class: 'np-controls' },
        el('div', { class: 'np-head' }, el('div', { class: 'np-names' }, np.title, np.artist), np.like),
        np.bar,
        el('div', { class: 'np-times' }, np.elapsed, np.remain),
        el(
          'div',
          { class: 'np-buttons' },
          np.shuffle,
          el('button', { class: 'np-skip', type: 'button', 'aria-label': '이전 곡', onclick: () => control('prev') }, icon('prev')),
          np.toggle,
          el('button', { class: 'np-skip', type: 'button', 'aria-label': '다음 곡', onclick: () => control('next') }, icon('next')),
          np.repeat,
        ),
        el('div', { class: 'np-volume' }, icon('volLow'), np.volume, icon('volHigh')),
        el(
          'div',
          { class: 'np-toolbar' },
          el('div', { class: 'np-tool-group' }, np.tools.lyrics, np.translateButton),
          el('div', { class: 'np-tool-mid' }, np.tools.devices, np.device),
          np.tools.queue,
        ),
      ),
    ),
  );
  // 아래로 끌어내리면 손을 따라 내려오고, 뒤 화면은 그만큼 원래 크기로 돌아옵니다.
  let drag = null;
  sheet.addEventListener('pointerdown', (event) => {
    if (event.target.closest('input, button, .np-lyrics, .np-list')) return;
    drag = { y: event.clientY, x: event.clientX, samples: [[event.timeStamp, event.clientY]], moving: false, id: event.pointerId };
  });
  sheet.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dy = event.clientY - drag.y;
    if (!drag.moving) {
      if (dy < 8 || Math.abs(event.clientX - drag.x) > dy) return;
      drag.moving = true;
      sheet.setPointerCapture(event.pointerId);
      sheet.style.transition = 'none';
      parts.page.style.transition = 'none';
    }
    drag.samples.push([event.timeStamp, event.clientY]);
    if (drag.samples.length > 6) drag.samples.shift();
    const moved = Math.max(0, dy);
    sheet.style.transform = `translate3d(0, ${moved}px, 0)`;
    pageCard(1 - Math.min(1, moved / innerHeight));
  });
  const end = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const { moving, samples, y } = drag;
    drag = null;
    if (!moving) return;
    const [t0, y0] = samples[0];
    const speed = (event.clientY - y0) / Math.max(1, event.timeStamp - t0);
    sheet.style.transition = '';
    parts.page.style.transition = '';
    sheet.style.transform = '';
    if (event.clientY - y > innerHeight * 0.25 || speed > 0.5) closeNowPlaying();
    else pageCard(1);
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && np.open) closeNowPlaying();
  });
  return sheet;
}

function paintRange(input) {
  const percent = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', `${percent}%`);
}

// 재생 화면이 열린 정도(0~1)만큼 뒤 화면이 카드처럼 작아지고 둥글어집니다.
function pageCard(amount) {
  const page = parts.page;
  if (!amount) {
    page.style.transform = '';
    page.style.borderRadius = '';
    page.style.filter = '';
    return;
  }
  page.style.transform = `scale(${1 - 0.07 * amount}) translateY(${14 * amount}px)`;
  page.style.borderRadius = `${14 * amount}px`;
  page.style.filter = `brightness(${1 - 0.25 * amount})`;
}

// 미니 플레이어의 앨범 아트가 재생 화면의 큰 앨범 아트 자리로 날아가는 효과입니다.
function flyArtwork(fromRect, toRect, { fromRadius, toRadius, src }) {
  if (!src || !fromRect.width || !toRect.width || reduceMotion()) return Promise.resolve();
  const ghost = el('img', { class: 'art-ghost', src, alt: '' });
  document.body.append(ghost);
  const frame = (rect, radius) => ({
    transform: `translate(${rect.left}px, ${rect.top}px)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: `${radius}px`,
  });
  const animation = ghost.animate([frame(fromRect, fromRadius), frame(toRect, toRadius)], { duration: 520, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  return animation.finished.catch(() => {}).finally(() => ghost.remove());
}

// 시트가 다 올라왔을 때 큰 앨범 아트가 놓일 자리입니다(지금 시트가 움직인 만큼 빼서 계산).
function finalArtRect() {
  const art = np.art.getBoundingClientRect();
  const sheet = parts.sheet.getBoundingClientRect();
  return { left: art.left, top: art.top - sheet.top, width: art.width, height: art.height };
}

function openNowPlaying() {
  if (np.open) return;
  np.open = true;
  const mini = parts.mini.querySelector('.art')?.getBoundingClientRect();
  parts.sheet.classList.add('open');
  parts.sheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('np-open');
  applyPanel();
  renderNowPlaying();
  if (lyricsVisible()) loadLyrics();
  pageCard(1);
  if (mini && (np.panel === 'art' || wideLayout()) && S.track?.cover) {
    np.art.style.opacity = '0';
    flyArtwork(mini, finalArtRect(), { fromRadius: 7, toRadius: 12, src: S.track.cover }).then(() => (np.art.style.opacity = ''));
  }
}

function closeNowPlaying() {
  if (!np.open) return;
  np.open = false;
  const mini = parts.mini.querySelector('.art');
  if (mini && (np.panel === 'art' || wideLayout()) && S.track?.cover && !parts.sheet.style.transform) {
    const from = np.art.getBoundingClientRect();
    mini.style.opacity = '0';
    flyArtwork(from, mini.getBoundingClientRect(), { fromRadius: 12, toRadius: 7, src: S.track.cover }).then(() => (mini.style.opacity = ''));
  }
  parts.sheet.classList.remove('open');
  parts.sheet.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('np-open');
  pageCard(0);
}

function showPanel(name) {
  np.panel = np.panel === name ? 'art' : name;
  if (np.panel === 'art' || np.panel === 'lyrics') storage.set(PANEL_KEY, np.panel);
  applyPanel();
  if (lyricsVisible()) loadLyrics();
  if (np.panel === 'devices') renderDevices();
  if (np.panel === 'queue') renderQueue();
}

// 어떤 화면을 보여 줄지는 CSS가 data-panel 로 정합니다(휴대폰과 넓은 화면이 다릅니다).
function applyPanel() {
  parts.sheet.dataset.panel = np.panel;
  for (const [key, button] of Object.entries(np.tools)) button.classList.toggle('on', np.panel === key);
}

function renderNowPlaying() {
  const track = S.track;
  parts.sheet.classList.toggle('paused', S.paused);
  if (!track) return;
  if (np.art.dataset.uri !== track.uri) {
    np.art.dataset.uri = track.uri;
    np.art.replaceChildren(track.cover ? el('img', { src: track.cover, alt: '' }) : el('span', { class: 'art-blank' }, '♪'));
    np.bgA.style.backgroundImage = track.cover ? `url("${track.cover}")` : '';
    np.title.textContent = track.name;
    np.artist.textContent = artistNames(track);
    np.artist.onclick = () => {
      const first = track.artists[0];
      if (!first) return;
      closeNowPlaying();
      push({ type: 'artist', name: first.name, image: null, title: '이전' });
    };
    np.lyrics = null;
    np.lyricsFor = null;
    if (lyricsVisible()) loadLyrics(true);
    if (np.panel === 'queue') renderQueue();
    checkLiked(track).then(() => renderLike());
  }
  renderLike();
  if (np.toggle.dataset.state !== String(S.paused)) {
    np.toggle.dataset.state = String(S.paused);
    np.toggle.replaceChildren(icon(S.paused ? 'play' : 'pause'));
    np.toggle.firstChild.animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], {
      duration: 380,
      easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    });
  }
  np.toggle.setAttribute('aria-label', S.paused ? '재생' : '일시 정지');
  np.shuffle.classList.toggle('on', S.shuffle);
  np.repeat.classList.toggle('on', S.repeat !== 'off');
  np.repeat.classList.toggle('one', S.repeat === 'track');
  np.device.textContent = S.device?.name ?? '';
  np.volume.value = String(S.volume);
  paintRange(np.volume);
}

function renderLike() {
  const on = Boolean(S.track && liked.get(S.track.id));
  np.like.replaceChildren(icon(on ? 'heartFill' : 'heart'));
  np.like.classList.toggle('on', on);
  np.like.setAttribute('aria-pressed', String(on));
}

// 재생 위치와 가사는 화면 그리는 주기마다 맞춥니다.
function tick() {
  if (S.track && np.open) {
    const now = position();
    if (!np.dragging) {
      np.bar.value = String(S.track.duration ? Math.round((now / S.track.duration) * 1000) : 0);
      paintRange(np.bar);
      np.elapsed.textContent = formatTime(now);
      np.remain.textContent = `-${formatTime(S.track.duration - now)}`;
    }
    if (lyricsVisible() && np.lyrics?.synced) syncLyrics(now);
  }
  requestAnimationFrame(tick);
}

/* ---------- 가사 (LRCLIB: 무료 공개 가사) ---------- */
const lyricsCache = new Map();
async function fetchLyrics(track) {
  if (lyricsCache.has(track.uri)) return lyricsCache.get(track.uri);
  const name = cleanTitle(track.name);
  const artist = track.artists[0]?.name ?? '';
  const ask = async (path, params) => {
    const response = await fetch(`https://lrclib.net/api/${path}?${new URLSearchParams(params)}`);
    return response.ok ? response.json() : null;
  };
  let found = await ask('get', { track_name: name, artist_name: artist, album_name: track.album.name, duration: Math.round(track.duration / 1000) }).catch(() => null);
  if (!found?.syncedLyrics && !found?.plainLyrics) {
    const list = (await ask('search', { track_name: name, artist_name: artist }).catch(() => null)) ?? [];
    found = list.find((item) => item.syncedLyrics) ?? list.find((item) => item.plainLyrics) ?? null;
  }
  const result = found?.syncedLyrics
    ? { synced: true, lines: parseLRC(found.syncedLyrics).filter((line) => line.text) }
    : found?.plainLyrics
      ? { synced: false, lines: found.plainLyrics.split(/\r?\n/).map((text) => ({ time: null, text })) }
      : null;
  lyricsCache.set(track.uri, result);
  return result;
}

async function loadLyrics(force = false) {
  const track = S.track;
  if (!track || (!force && np.lyricsFor === track.uri)) return;
  np.lyricsFor = track.uri;
  np.lyricsBox.replaceChildren(el('div', { class: 'spinner light' }));
  const lyrics = await fetchLyrics(track).catch(() => null);
  if (np.lyricsFor !== track.uri) return;
  np.lyrics = lyrics;
  np.activeLine = -2;
  if (!lyrics?.lines.length) {
    np.lyricsBox.replaceChildren(el('div', { class: 'np-nolyrics' }, '이 곡의 가사를 찾지 못했어요'));
    return;
  }
  np.foreign = foreignLines(lyrics.lines.map((line) => line.text));
  updateTranslateButton();
  np.lyricsBox.replaceChildren(
    el(
      'div',
      { class: `lines ${lyrics.synced ? 'synced' : 'plain'}` },
      lyrics.lines.map((line) =>
        el(
          'p',
          {
            class: 'line',
            onclick: () => {
              if (line.time !== null) seek(line.time);
            },
          },
          el('span', { class: 'orig' }, line.text || '♪'),
        ),
      ),
    ),
    lyrics.synced ? null : el('p', { class: 'np-lyrics-note' }, '시간이 맞춰지지 않은 가사예요'),
  );
  if (np.foreign.length && np.translate) showTranslation(track);
}

/* ---------- 가사 번역 ---------- */
// 외국어 가사는 줄마다 아래에 한국어 번역을 붙입니다. 켜고 끈 것은 기억합니다.
const TRANSLATE_KEY = 'aria_translate';
np.translate = storage.get(TRANSLATE_KEY) !== '0';
const translations = new Map();

function updateTranslateButton() {
  const show = Boolean(np.foreign?.length);
  np.translateButton.hidden = !show;
  np.translateButton.classList.toggle('on', show && np.translate);
  np.translateButton.setAttribute('aria-pressed', String(show && np.translate));
}

function toggleTranslation() {
  np.translate = !np.translate;
  storage.set(TRANSLATE_KEY, np.translate ? '1' : '0');
  updateTranslateButton();
  toast(np.translate ? '가사 번역을 켰어요' : '가사 번역을 껐어요', 1500);
  if (np.translate && S.track) showTranslation(S.track);
  else for (const node of np.lyricsBox.querySelectorAll('.tr')) node.remove();
  np.activeLine = -2;
}

const GOOGLE = 'https://translate.googleapis.com/translate_a/single';

async function googleTranslate(lines) {
  const result = [];
  for (const [, chunk] of chunkLines(lines)) {
    const response = await fetch(`${GOOGLE}?${new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'ko', dt: 't', q: chunk.join('\n') })}`);
    if (!response.ok) throw new Error(`번역 오류 ${response.status}`);
    let translated = parseTranslation(await response.json(), chunk.length);
    // 줄 수가 어긋나면 그 묶음만 한 줄씩 다시 번역합니다.
    if (!translated) {
      translated = [];
      for (const line of chunk) {
        const one = await fetch(`${GOOGLE}?${new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'ko', dt: 't', q: line })}`);
        translated.push(one.ok ? (parseTranslation(await one.json(), 1)?.[0] ?? '') : '');
      }
    }
    result.push(...translated);
  }
  return result;
}

// Google 번역이 막히면 MyMemory(무료, 하루 사용량 제한 있음)로 한 줄씩 번역합니다.
async function myMemoryTranslate(lines) {
  const result = [];
  for (const line of lines) {
    const params = new URLSearchParams({ q: line, langpair: `${guessLanguage(line)}|ko` });
    const response = await fetch(`https://api.mymemory.translated.net/get?${params}`);
    const data = response.ok ? await response.json() : null;
    result.push(data?.responseStatus === 200 ? data.responseData.translatedText : '');
  }
  return result;
}

// 외국어 줄만 보냅니다(가사 글자만, 계정 정보는 보내지 않습니다). 결과는 줄 번호에 맞춰 돌려줍니다.
async function translateLines(lines, indexes) {
  const texts = indexes.map((index) => lines[index]);
  let translated;
  try {
    translated = await googleTranslate(texts);
  } catch {
    translated = await myMemoryTranslate(texts);
  }
  const result = Array(lines.length).fill('');
  indexes.forEach((index, i) => (result[index] = translated[i] ?? ''));
  if (!result.some(Boolean)) throw new Error('번역 결과가 없어요');
  return result;
}

async function showTranslation(track) {
  const box = np.lyricsBox;
  parts.sheet.classList.add('translating');
  try {
    if (!translations.has(track.uri)) translations.set(track.uri, await translateLines(np.lyrics.lines.map((line) => line.text), np.foreign));
    if (np.lyricsFor !== track.uri || !np.translate) return;
    const lines = translations.get(track.uri);
    box.querySelectorAll('.line').forEach((node, i) => {
      node.querySelector('.tr')?.remove();
      const text = lines[i];
      // 원문과 같거나 비어 있으면(의성어 등) 붙이지 않습니다.
      if (text && text !== np.lyrics.lines[i].text) node.append(el('span', { class: 'tr' }, text));
    });
    np.activeLine = -2;
  } catch {
    translations.delete(track.uri);
    toast('가사를 번역하지 못했어요. 번역 버튼을 다시 눌러 주세요', 4000);
  } finally {
    parts.sheet.classList.remove('translating');
  }
}

function syncLyrics(now) {
  const index = activeLine(np.lyrics.lines, now + 250);
  if (index === np.activeLine) return;
  np.activeLine = index;
  const lines = np.lyricsBox.querySelectorAll('.line');
  lines.forEach((line, i) => {
    line.classList.toggle('active', i === index);
    line.classList.toggle('past', i < index);
    line.classList.toggle('next', i === index + 1);
  });
  const target = lines[Math.max(0, index)];
  if (target) np.lyricsBox.scrollTo({ top: target.offsetTop - np.lyricsBox.clientHeight * 0.3, behavior: 'smooth' });
}

/* ---------- 다음 곡 · 재생 기기 ---------- */
async function renderQueue() {
  np.listBox.replaceChildren(el('div', { class: 'spinner light' }));
  try {
    const data = await api('/me/player/queue');
    const upcoming = (data?.queue ?? []).filter((item) => item?.type === 'track').map((item) => normTrack(item));
    np.listBox.replaceChildren(
      el('h3', {}, '다음 곡'),
      upcoming.length
        ? el(
            'div',
            { class: 'list light' },
            upcoming.slice(0, 30).map((track) =>
              el(
                'div',
                { class: 'row static' },
                art(track.thumb, { size: 'sm' }),
                el('span', { class: 'row-text' }, el('b', {}, track.name), el('small', {}, artistNames(track))),
              ),
            ),
          )
        : el('p', { class: 'np-nolyrics' }, '다음에 나올 곡이 없어요'),
    );
  } catch (error) {
    np.listBox.replaceChildren(el('p', { class: 'np-nolyrics' }, `다음 곡을 불러오지 못했어요: ${error.message}`));
  }
}

async function renderDevices() {
  np.listBox.replaceChildren(el('div', { class: 'spinner light' }));
  try {
    const { devices = [] } = (await api('/me/player/devices')) ?? {};
    np.listBox.replaceChildren(
      el('h3', {}, '재생 기기'),
      devices.length
        ? el(
            'div',
            { class: 'list light' },
            devices.map((device) =>
              el(
                'button',
                {
                  class: `row device ${device.is_active ? 'active' : ''}`,
                  type: 'button',
                  disabled: device.is_restricted,
                  onclick: async () => {
                    try {
                      await api('/me/player', { method: 'PUT', body: { device_ids: [device.id], play: !S.paused } });
                      S.local = device.id === sdk.deviceId;
                      toast(`${device.name}에서 재생할게요`, 2000);
                      setTimeout(() => {
                        pollPlayback();
                        renderDevices();
                      }, 800);
                    } catch (error) {
                      playbackError(error);
                    }
                  },
                },
                icon('devices'),
                el('span', { class: 'row-text' }, el('b', {}, device.name), el('small', {}, device.is_active ? '지금 재생 중' : deviceKind(device.type))),
              ),
            ),
          )
        : el('p', { class: 'np-nolyrics' }, '켜져 있는 Spotify 기기가 없어요. Spotify 앱을 한 번 열어 주세요.'),
    );
  } catch (error) {
    np.listBox.replaceChildren(el('p', { class: 'np-nolyrics' }, `기기 목록을 불러오지 못했어요: ${error.message}`));
  }
}

const deviceKind = (type) => ({ Computer: '컴퓨터', Smartphone: '휴대폰', Speaker: '스피커', TV: 'TV', Tablet: '태블릿' })[type] ?? type;

/* ---------- 크로스페이드에서 곡 재생 요청 ---------- */
// 크로스페이드가 친구가 들은 곡을 이 플레이어로 틀 때 부릅니다.
window.ariaPlay = async (artist, track) => {
  if (!tok) return toast('먼저 Spotify로 로그인해 주세요');
  const clean = (text) => String(text ?? '').replace(/["']/g, '');
  try {
    let data = await api(`/search?${new URLSearchParams({ q: `track:${clean(track)} artist:${clean(artist)}`, type: 'track', limit: 1 })}`);
    let found = data.tracks?.items?.[0];
    if (!found) {
      data = await api(`/search?${new URLSearchParams({ q: `${track} ${artist}`, type: 'track', limit: 1 })}`);
      found = data.tracks?.items?.[0];
    }
    if (!found) return toast('Spotify에서 이 곡을 찾지 못했어요');
    await play({ tracks: [normTrack(found)], index: 0 });
    openNowPlaying();
  } catch (error) {
    playbackError(error);
  }
};

/* ---------- 시작 ---------- */
function renderLogin() {
  document.body.classList.remove('has-mini');
  $app.replaceChildren(
    el(
      'main',
      { class: 'welcome' },
      el('img', { class: 'welcome-icon', src: 'icon.svg', alt: '' }),
      el('h1', {}, 'Aria'),
      el('p', {}, '좋아하는 음악을, 더 아름답게.'),
      el('button', { class: 'pill accent big', type: 'button', onclick: login }, 'Spotify로 계속하기'),
      el('small', {}, '크로스페이드에 등록된 Spotify 계정으로 로그인해요. 이 화면에서 바로 재생하려면 Spotify Premium이 필요해요.'),
    ),
  );
}

async function start() {
  await loadClientId();
  await handleCallback();
  requestAnimationFrame(tick);
  if (!tok) return renderLogin();
  buildShell();
  renderPage();
  startSdk();
  pollPlayback();
  setInterval(pollPlayback, POLL_MS);
  document.addEventListener('visibilitychange', pollPlayback);
}

start();
