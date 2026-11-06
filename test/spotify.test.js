import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { getSpotifyAccount, listMembers, openDb, resetDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createSpotifyClient, parseCurrentlyPlaying, parseRecentlyPlayed } from '../src/spotify.js';
import { buildOverview } from '../src/stats.js';
import { syncAll } from '../src/sync.js';

const KST = 540;

const spotifyTrack = (name, durationMs = 200000) => ({
  type: 'track',
  name,
  duration_ms: durationMs,
  artists: [{ name: 'Main Artist' }, { name: 'Guest' }],
  album: { name: 'LP', images: [{ url: 'https://i.scdn.co/640' }, { url: 'https://i.scdn.co/300' }] },
});

test('Spotify 재생 기록을 공통 형식으로 바꾼다', () => {
  const [item] = parseRecentlyPlayed({
    items: [{ played_at: '2026-11-06T01:00:00.000Z', track: spotifyTrack('Song', 183500) }],
  });
  assert.equal(item.artist, 'Main Artist');
  assert.equal(item.track, 'Song');
  assert.equal(item.image, 'https://i.scdn.co/300');
  assert.equal(item.durationSec, 184);
  assert.equal(item.playedAt, Date.UTC(2026, 10, 6, 1) / 1000);
});

test('일시정지, 팟캐스트, 재생 없음은 재생 중으로 보지 않는다', () => {
  assert.equal(parseCurrentlyPlaying(null), null);
  assert.equal(parseCurrentlyPlaying({ is_playing: false, item: spotifyTrack('x') }), null);
  assert.equal(parseCurrentlyPlaying({ is_playing: true, item: { type: 'episode', name: 'x' } }), null);
  assert.equal(parseCurrentlyPlaying({ is_playing: true, item: spotifyTrack('x') }).track, 'x');
});

// Spotify 인증 서버와 API를 흉내 내는 서버입니다.
let fake;
let fakeUrl;
let app;
let appUrl;
let db;
let spotify;
let cookie;
const fakeState = {};
const CONFIG = { demo: false, inviteCode: 'secret-code', tzOffsetMinutes: KST, cookieSecure: false };

beforeEach(() => {
  resetDb(db);
  Object.assign(fakeState, { challenge: null, tokenRequests: [], profileStatus: 200, profileId: 'friend1', refreshReturnsToken: false });
});

before(async () => {
  fake = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/accounts/api/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      fakeState.tokenRequests.push(Object.fromEntries(form));
      if (form.get('grant_type') === 'authorization_code') {
        const hash = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
        if (hash !== fakeState.challenge) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'bad verifier' }));
        }
        return res.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }));
      }
      return res.end(
        JSON.stringify({
          access_token: 'access-2',
          expires_in: 3600,
          ...(fakeState.refreshReturnsToken ? { refresh_token: 'refresh-2' } : {}),
        }),
      );
    }
    if (url.pathname === '/v1/me') {
      res.statusCode = fakeState.profileStatus;
      if (fakeState.profileStatus !== 200) return res.end(JSON.stringify({ error: { message: 'User not registered' } }));
      return res.end(JSON.stringify({ id: fakeState.profileId, display_name: '스포친구' }));
    }
    if (url.pathname === '/v1/me/player/currently-playing') {
      return res.end(JSON.stringify({ is_playing: true, item: spotifyTrack('Now') }));
    }
    if (url.pathname === '/v1/me/player/recently-played') {
      const playedAt = new Date(Date.now() - 600_000).toISOString();
      return res.end(JSON.stringify({ items: [{ played_at: playedAt, track: spotifyTrack('Old', 240000) }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;

  db = openDb(':memory:');
  spotify = createSpotifyClient({
    clientId: 'client-id',
    redirectUri: 'http://127.0.0.1:3000/api/spotify/callback',
    accountsUrl: `${fakeUrl}/accounts`,
    apiUrl: `${fakeUrl}/v1`,
  });
  app = createApp({ config: CONFIG, db, client: null, spotify });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;

  const login = await fetch(`${appUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'secret-code' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => {
  app.close();
  fake.close();
});

const startLogin = () => fetch(`${appUrl}/api/spotify/login`, { headers: { Cookie: cookie }, redirect: 'manual' });

async function finishLogin() {
  const started = await startLogin();
  const authorize = new URL(started.headers.get('location'));
  fakeState.challenge = authorize.searchParams.get('code_challenge');
  return fetch(`${appUrl}/api/spotify/callback?code=abc&state=${authorize.searchParams.get('state')}`, { redirect: 'manual' });
}

test('초대 코드 없이는 Spotify 로그인을 시작할 수 없다', async () => {
  const response = await fetch(`${appUrl}/api/spotify/login`, { redirect: 'manual' });
  assert.equal(response.status, 401);
});

test('로그인은 PKCE로 요청하고 비밀값을 보내지 않는다', async () => {
  const location = new URL((await startLogin()).headers.get('location'));
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('scope'), 'user-read-recently-played user-read-currently-playing');
  assert.equal(location.searchParams.has('client_secret'), false);
});

test('로그인하면 멤버가 생기고 재생 기록과 곡 길이가 들어온다', async () => {
  const done = await finishLogin();
  assert.equal(done.status, 302);
  assert.match(done.headers.get('location'), /\?spotify=connected$/);

  const [member] = listMembers(db);
  assert.equal(member.name, '스포친구');
  assert.equal(member.service, 'spotify');

  await syncAll(db, null, { tzOffsetMinutes: KST, gapMs: 0, spotify });
  const overview = buildOverview(db, { week: 0, now: Math.floor(Date.now() / 1000), tzOffsetMinutes: KST });
  const stats = overview.members[0];
  assert.equal(stats.nowPlaying.track, 'Now');
  assert.equal(stats.lastPlayed.track, 'Old');
  assert.equal(stats.estimatedPlays, 0, 'Spotify가 준 곡 길이를 쓴다');
  assert.equal(JSON.stringify(overview).includes('access-1'), false, '토큰은 화면으로 나가지 않는다');
});

test('다시 로그인해도 멤버가 늘지 않는다', async () => {
  await finishLogin();
  await finishLogin();
  assert.equal(listMembers(db).length, 1);
});

test('state가 틀리거나 재사용되면 거부한다', async () => {
  const forged = await fetch(`${appUrl}/api/spotify/callback?code=abc&state=forged`, { redirect: 'manual' });
  assert.equal(forged.status, 400);

  const started = await startLogin();
  const authorize = new URL(started.headers.get('location'));
  fakeState.challenge = authorize.searchParams.get('code_challenge');
  const url = `${appUrl}/api/spotify/callback?code=abc&state=${authorize.searchParams.get('state')}`;
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 400);
});

test('등록되지 않은 계정과 취소는 이유를 알려 준다', async () => {
  fakeState.profileStatus = 403;
  assert.match((await finishLogin()).headers.get('location'), /spotify=notAllowed/);
  assert.equal(listMembers(db).length, 0);

  const started = await startLogin();
  const state = new URL(started.headers.get('location')).searchParams.get('state');
  const denied = await fetch(`${appUrl}/api/spotify/callback?error=access_denied&state=${state}`, { redirect: 'manual' });
  assert.match(denied.headers.get('location'), /spotify=denied/);
});

test('만료된 토큰을 갱신하고, 새 refresh token이 없으면 기존 값을 유지한다', async () => {
  await finishLogin();
  const [member] = listMembers(db);
  db.prepare('UPDATE spotify_accounts SET expires_at = 0').run();

  await syncAll(db, null, { tzOffsetMinutes: KST, gapMs: 0, spotify });
  const account = getSpotifyAccount(db, member.id);
  assert.equal(account.access_token, 'access-2');
  assert.equal(account.refresh_token, 'refresh-1');
  const refresh = fakeState.tokenRequests.find((r) => r.grant_type === 'refresh_token');
  assert.equal(refresh.client_id, 'client-id');
  assert.equal(refresh.client_secret, undefined);
});

test('5명이 차면 새 계정은 막지만 기존 친구는 다시 로그인할 수 있다', async () => {
  for (let i = 0; i < 5; i += 1) {
    fakeState.profileId = `friend${i}`;
    await finishLogin();
  }

  fakeState.profileId = 'friend5';
  assert.match((await finishLogin()).headers.get('location'), /\?spotify=full$/);
  assert.equal(listMembers(db).length, 5);

  fakeState.profileId = 'friend2';
  assert.match((await finishLogin()).headers.get('location'), /\?spotify=connected$/);
  assert.equal(listMembers(db).length, 5);
});

test('그룹에서 빼면 Spotify 토큰도 함께 지워진다', async () => {
  await finishLogin();
  const [member] = listMembers(db);
  const response = await fetch(`${appUrl}/api/member?id=${member.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(getSpotifyAccount(db, member.id), undefined);
});
