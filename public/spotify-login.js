// 서버가 없으므로 브라우저가 PKCE로 직접 로그인합니다. Client Secret은 쓰지 않습니다.
const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-recently-played user-read-currently-playing';
const LOGIN_KEY = 'crossfade.spotifyLogin';

const redirectUri = () => `${location.origin}${location.pathname}`;

const base64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64Url = (bytes) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = (size) => base64Url(crypto.getRandomValues(new Uint8Array(size)));

export async function startSpotifyLogin({ spotifyClientId }) {
  const verifier = randomText(64);
  const state = randomText(16);
  localStorage.setItem(LOGIN_KEY, JSON.stringify({ verifier, state }));

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const url = new URL(`${ACCOUNTS_URL}/authorize`);
  url.search = new URLSearchParams({
    client_id: spotifyClientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: base64Url(digest),
  });
  location.href = url.href;
}

// Spotify에서 돌아온 주소라면 값을 꺼내고 주소창에서 지웁니다.
export function takeSpotifyCallback() {
  const params = new URLSearchParams(location.search);
  const state = params.get('state');
  if (!state || !(params.has('code') || params.has('error'))) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  return { code: params.get('code'), state };
}

// 토큰은 수집기의 공개 키로 암호화해서 보내므로 중계 서버는 내용을 볼 수 없습니다.
export async function sealForCollector(payload, publicKeyJwk) {
  const publicKey = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aesKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', aesKey, 'AES-GCM', false, ['encrypt']);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    key: base64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, aesKey)),
    iv: base64(iv),
    data: base64(data),
  };
}

async function spotifyRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error('Spotify 요청 실패');
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function finishSpotifyLogin(connect, { code, state }) {
  const login = JSON.parse(localStorage.getItem(LOGIN_KEY) ?? 'null');
  localStorage.removeItem(LOGIN_KEY);
  if (!login || login.state !== state) throw new Error('로그인 상태가 맞지 않아요.');

  const tokens = await spotifyRequest(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: connect.spotifyClientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: login.verifier,
    }),
  });
  const profile = await spotifyRequest(`${API_URL}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  const sealed = await sealForCollector(
    {
      spotifyId: profile.id,
      displayName: profile.display_name ?? '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + Number(tokens.expires_in),
    },
    connect.tokenPublicKey,
  );
  const response = await fetch(`${connect.relayUrl}/logins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connect.relayWriteKey}` },
    body: JSON.stringify({ sealed }),
  });
  if (!response.ok) throw new Error('중계 서버 오류');
  return 'queued';
}
