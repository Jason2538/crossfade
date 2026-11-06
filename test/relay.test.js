import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { finishSpotifyLogin, sealForCollector, takeSpotifyCallback } from '../public/spotify-login.js';
import worker from '../relay/worker.js';
import { importSpotifyLogins } from '../src/collect.js';
import { openForCollector, publicKeyJwk } from '../src/crypto.js';
import { getSpotifyAccount, listMembers, openDb } from '../src/db.js';

const NOW = 1_800_000_000;
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const login = (id, refreshToken = 'refresh') => ({
  spotifyId: id,
  displayName: '스포친구',
  accessToken: 'access',
  refreshToken,
  expiresAt: NOW + 3600,
});
const seal = (payload) => sealForCollector(payload, publicKeyJwk(privateKey));

function fakeEnv() {
  const store = new Map();
  return {
    ALLOWED_ORIGIN: 'https://site.example',
    WRITE_KEY: 'write',
    READ_KEY: 'read',
    LOGINS: {
      put: async (key, value) => void store.set(key, value),
      get: async (key) => store.get(key) ?? null,
      delete: async (key) => void store.delete(key),
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
  };
}

const call = (env, path, { method = 'GET', key, body } = {}) =>
  worker.fetch(
    new Request(`https://relay.example${path}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {}, body }),
    env,
  );

test('브라우저가 암호화한 로그인을 수집기만 풀 수 있다', async () => {
  const sealed = await seal(login('friend'));
  assert.equal(JSON.stringify(sealed).includes('refresh'), false);
  assert.equal(openForCollector(sealed, privateKey).spotifyId, 'friend');
});

test('중계 서버는 키가 있어야 쓰고 읽을 수 있다', async () => {
  const env = fakeEnv();
  const body = JSON.stringify({ sealed: await seal(login('friend')) });

  assert.equal((await call(env, '/logins', { method: 'POST', body })).status, 401);
  assert.equal((await call(env, '/logins', { method: 'POST', key: 'read', body })).status, 401);
  assert.equal((await call(env, '/logins', { method: 'POST', key: 'write', body: '{}' })).status, 400);
  assert.equal((await call(env, '/logins', { method: 'POST', key: 'write', body: 'x'.repeat(20000) })).status, 413);
  const created = await call(env, '/logins', { method: 'POST', key: 'write', body });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('access-control-allow-origin'), 'https://site.example');

  assert.equal((await call(env, '/logins')).status, 401);
  assert.equal((await call(env, '/logins', { key: 'write' })).status, 401);
  const { logins } = await (await call(env, '/logins', { key: 'read' })).json();
  assert.equal(logins.length, 1);

  assert.equal((await call(env, `/logins/${logins[0].id}`, { method: 'DELETE' })).status, 401);
  await call(env, `/logins/${logins[0].id}`, { method: 'DELETE', key: 'read' });
  assert.equal((await (await call(env, '/logins', { key: 'read' })).json()).logins.length, 0);
});

test('받아 온 로그인을 멤버로 등록하고, 다시 로그인하면 토큰만 바꾼다', async () => {
  const db = openDb(':memory:');
  const relay = { list: async () => [{ id: 'a', sealed: await seal(login('friend')) }] };
  assert.deepEqual(await importSpotifyLogins(db, relay, privateKey, NOW), ['a']);
  const [member] = listMembers(db);
  assert.equal(member.service, 'spotify');
  assert.equal(getSpotifyAccount(db, member.id).expires_at, NOW + 3600);

  const again = { list: async () => [{ id: 'b', sealed: await seal(login('friend', 'refresh-2')) }] };
  await importSpotifyLogins(db, again, privateKey, NOW);
  assert.equal(listMembers(db).length, 1);
  assert.equal(getSpotifyAccount(db, member.id).refresh_token, 'refresh-2');
});

test('풀 수 없는 로그인은 건너뛰고 대기열에서 지운다', async () => {
  const db = openDb(':memory:');
  const relay = { list: async () => [{ id: 'bad', sealed: { key: 'AAAA', iv: 'AAAA', data: 'AAAA' } }] };
  assert.deepEqual(await importSpotifyLogins(db, relay, privateKey, NOW), ['bad']);
  assert.equal(listMembers(db).length, 0);
});

function fakeBrowser(routes) {
  const store = new Map();
  const posts = [];
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
  globalThis.fetch = async (url, options = {}) => {
    const { pathname } = new URL(url);
    posts.push({ pathname, options });
    return Response.json(routes[pathname]?.body ?? {}, { status: routes[pathname]?.status ?? 200 });
  };
  globalThis.location = { origin: 'https://site.example', pathname: '/crossfade/', search: '', hash: '' };
  return { store, posts };
}

const connect = () => ({
  spotifyClientId: 'client',
  relayUrl: 'https://relay.example',
  relayWriteKey: 'write',
  tokenPublicKey: publicKeyJwk(privateKey),
});
const LOGIN_ROUTES = {
  '/api/token': { body: { access_token: 'plain-access', refresh_token: 'plain-refresh', expires_in: 3600 } },
  '/v1/me': { body: { id: 'friend', display_name: '스포친구' } },
};

test('로그인이 끝나면 토큰을 암호화한 뒤에만 중계 서버로 보낸다', async () => {
  const realFetch = globalThis.fetch;
  const { store, posts } = fakeBrowser(LOGIN_ROUTES);
  store.set('crossfade.spotifyLogin', JSON.stringify({ verifier: 'v', state: 's' }));

  assert.equal(await finishSpotifyLogin(connect(), { code: 'c', state: 's' }), 'queued');
  globalThis.fetch = realFetch;

  const token = posts.find((p) => p.pathname === '/api/token');
  assert.equal(token.options.body.get('code_verifier'), 'v');
  assert.equal(token.options.body.get('redirect_uri'), 'https://site.example/crossfade/');
  assert.equal(token.options.body.has('client_secret'), false);

  const relayed = posts.find((p) => p.pathname === '/logins');
  assert.equal(relayed.options.headers.Authorization, 'Bearer write');
  assert.equal(relayed.options.body.includes('plain-'), false);
  assert.equal(openForCollector(JSON.parse(relayed.options.body).sealed, privateKey).refreshToken, 'plain-refresh');
  assert.equal(store.has('crossfade.spotifyLogin'), false);
});

test('state가 다르면 토큰을 요청하지 않고, 미등록 계정은 403을 알려 준다', async () => {
  const realFetch = globalThis.fetch;
  const { store, posts } = fakeBrowser({ ...LOGIN_ROUTES, '/v1/me': { status: 403 } });

  store.set('crossfade.spotifyLogin', JSON.stringify({ verifier: 'v', state: 's' }));
  await assert.rejects(finishSpotifyLogin(connect(), { code: 'c', state: 'forged' }));
  assert.equal(posts.length, 0);

  store.set('crossfade.spotifyLogin', JSON.stringify({ verifier: 'v', state: 's' }));
  await assert.rejects(finishSpotifyLogin(connect(), { code: 'c', state: 's' }), { status: 403 });
  assert.equal(posts.some((p) => p.pathname === '/logins'), false);
  globalThis.fetch = realFetch;
});

test('Spotify 콜백 주소만 인식한다', () => {
  fakeBrowser({});
  globalThis.history = { replaceState() {} };
  location.search = '?code=c&state=s';
  assert.deepEqual(takeSpotifyCallback(), { code: 'c', state: 's' });
  location.search = '?error=access_denied&state=s';
  assert.deepEqual(takeSpotifyCallback(), { code: null, state: 's' });
  location.search = '?spotify=connected';
  assert.equal(takeSpotifyCallback(), null);
});
