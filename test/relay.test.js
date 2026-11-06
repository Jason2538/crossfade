import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { finishSpotifyLogin, sealForCollector, takeSpotifyCallback } from '../public/spotify-login.js';
import worker from '../relay/worker.js';
import { MAX_GROUPS, processQueue } from '../src/collect.js';
import { openForCollector, publicKeyJwk } from '../src/crypto.js';
import { addGroup, addMember, getSpotifyAccount, listGroups, listMembers, listNotices, openDb } from '../src/db.js';

const NOW = 1_800_000_000;
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ORIGIN = 'https://site.example';
const CODE = 'group-code';
const login = (id, refreshToken = 'refresh') => ({
  kind: 'spotify',
  code: CODE,
  spotifyId: id,
  displayName: '스포친구',
  accessToken: 'access',
  refreshToken,
  expiresAt: NOW + 3600,
});
const seal = (payload) => sealForCollector(payload, publicKeyJwk(privateKey));
const queueOf = async (...requests) => {
  const items = [];
  for (const [index, request] of requests.entries()) items.push({ id: String(index), sealed: await seal(request) });
  return { list: async () => items };
};
const fakeClient = {
  getUser: async (user) => {
    if (user === 'nobody') throw Object.assign(new Error('not found'), { code: 6 });
    return { name: user };
  },
  getRecentTracks: async () => ({ nowPlaying: null, scrobbles: [], totalPages: 1 }),
};

function groupDb() {
  const db = openDb(':memory:');
  addGroup(db, CODE, NOW);
  return db;
}

function fakeEnv() {
  const store = new Map();
  return {
    store,
    ALLOWED_ORIGIN: ORIGIN,
    READ_KEY: 'read',
    LOGINS: {
      put: async (key, value) => void store.set(key, value),
      get: async (key) => store.get(key) ?? null,
      delete: async (key) => void store.delete(key),
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
  };
}

const call = (env, path, { method = 'GET', key, body, origin } = {}) =>
  worker.fetch(
    new Request(`https://relay.example${path}`, {
      method,
      headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(origin && { Origin: origin }) },
      body,
    }),
    env,
  );

test('브라우저가 암호화한 요청을 수집기만 풀 수 있다', async () => {
  const sealed = await seal(login('friend'));
  assert.equal(JSON.stringify(sealed).includes('refresh'), false);
  assert.equal(openForCollector(sealed, privateKey).spotifyId, 'friend');
});

test('대기열은 사이트에서만 받고, 읽고 지우려면 키가 필요하다', async () => {
  const env = fakeEnv();
  const body = JSON.stringify({ sealed: await seal(login('friend')) });
  const post = (options) => call(env, '/queue', { method: 'POST', origin: ORIGIN, ...options });

  assert.equal((await call(env, '/queue', { method: 'POST', body })).status, 403);
  assert.equal((await post({ origin: 'https://evil.example', body })).status, 403);
  assert.equal((await post({ body: '{}' })).status, 400);
  assert.equal((await post({ body: 'x'.repeat(20000) })).status, 413);
  const created = await post({ body });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('access-control-allow-origin'), ORIGIN);

  assert.equal((await call(env, '/queue')).status, 401);
  assert.equal((await call(env, '/queue', { key: 'wrong' })).status, 401);
  const { items } = await (await call(env, '/queue', { key: 'read' })).json();
  assert.equal(items.length, 1);

  assert.equal((await call(env, `/queue/${items[0].id}`, { method: 'DELETE' })).status, 401);
  await call(env, `/queue/${items[0].id}`, { method: 'DELETE', key: 'read' });
  assert.equal((await (await call(env, '/queue', { key: 'read' })).json()).items.length, 0);
});

test('같은 주소의 요청이 너무 많으면 막는다', async () => {
  const env = fakeEnv();
  const body = JSON.stringify({ sealed: await seal({ kind: 'group', code: 'x' }) });
  const post = () => call(env, '/queue', { method: 'POST', origin: ORIGIN, body });
  for (let i = 0; i < 30; i += 1) assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);
  assert.equal([...env.store.keys()].some((key) => key.includes('unknown')), false, '주소를 그대로 저장하지 않는다');
});

test('새 그룹은 한 번만 만들어지고 개수가 제한된다', async () => {
  const db = openDb(':memory:');
  const request = { kind: 'group', code: CODE };
  assert.deepEqual(await processQueue(db, fakeClient, await queueOf(request, request), privateKey, NOW), ['0', '1']);
  assert.equal(listGroups(db).length, 1);

  for (let i = listGroups(db).length; i < MAX_GROUPS; i += 1) addGroup(db, `code-${i}`, NOW);
  await processQueue(db, fakeClient, await queueOf({ kind: 'group', code: 'one-more' }), privateKey, NOW);
  assert.equal(listGroups(db).length, MAX_GROUPS);
});

test('코드가 맞는 그룹에만 친구를 추가하고, 실패 이유를 그룹에 알린다', async () => {
  const db = groupDb();
  const friend = { kind: 'member', code: CODE, name: '친구', lastfmUser: 'buddy', service: 'apple' };
  await processQueue(
    db,
    fakeClient,
    await queueOf(
      friend,
      { ...friend, code: 'wrong-code', lastfmUser: 'intruder' },
      { ...friend, lastfmUser: 'nobody', name: '없는사람' },
    ),
    privateKey,
    NOW,
  );
  const [group] = listGroups(db);
  assert.deepEqual(listMembers(db).map((m) => [m.lastfm_user, m.group_id]), [['buddy', group.id]]);
  assert.match(listNotices(db, group.id, 0)[0], /없는사람 님을 추가하지 못했어요/);
});

test('다른 그룹의 멤버는 뺄 수 없다', async () => {
  const db = groupDb();
  const groupId = addGroup(db, 'other-code', NOW);
  const memberId = addMember(db, { name: '남', lastfmUser: 'stranger', service: 'apple', joinedAt: NOW, groupId });

  await processQueue(db, fakeClient, await queueOf({ kind: 'remove', code: CODE, memberId }), privateKey, NOW);
  assert.equal(listMembers(db).length, 1);
  await processQueue(db, fakeClient, await queueOf({ kind: 'remove', code: 'other-code', memberId }), privateKey, NOW);
  assert.equal(listMembers(db).length, 0);
});

test('공개 그룹의 멤버는 코드로 뺄 수 없다', async () => {
  const db = groupDb();
  const memberId = addMember(db, { name: '친구', lastfmUser: 'buddy', service: 'apple', joinedAt: NOW, groupId: listGroups(db)[0].id });
  const relay = await queueOf({ kind: 'remove', code: CODE, memberId });
  assert.deepEqual(await processQueue(db, fakeClient, relay, privateKey, NOW, { openCode: CODE }), ['0']);
  assert.equal(listMembers(db).length, 1);
});

test('같은 친구가 여러 그룹에 들어갈 수 있다', async () => {
  const db = groupDb();
  addGroup(db, 'other-code', NOW);
  const friend = { kind: 'member', name: '친구', lastfmUser: 'buddy', service: 'apple' };
  await processQueue(
    db,
    fakeClient,
    await queueOf({ ...friend, code: CODE }, { ...friend, code: 'other-code' }),
    privateKey,
    NOW,
  );
  assert.equal(listMembers(db).length, 2);
});

test('받아 온 로그인을 멤버로 등록하고, 다시 로그인하면 토큰만 바꾼다', async () => {
  const db = groupDb();
  const [group] = listGroups(db);
  assert.deepEqual(await processQueue(db, fakeClient, await queueOf(login('friend')), privateKey, NOW), ['0']);
  const [member] = listMembers(db);
  assert.equal(member.service, 'spotify');
  assert.equal(member.group_id, group.id);
  assert.equal(getSpotifyAccount(db, member.id).expires_at, NOW + 3600);

  await processQueue(db, fakeClient, await queueOf(login('friend', 'refresh-2')), privateKey, NOW);
  assert.equal(listMembers(db).length, 1);
  assert.equal(getSpotifyAccount(db, member.id).refresh_token, 'refresh-2');
});

test('Spotify 인원이 차거나 다른 그룹에 연결된 계정이면 그룹에 알린다', async () => {
  const db = groupDb();
  const [group] = listGroups(db);
  addGroup(db, 'other-code', NOW);
  for (let i = 0; i < 5; i += 1) await processQueue(db, fakeClient, await queueOf(login(`friend${i}`)), privateKey, NOW);

  await processQueue(db, fakeClient, await queueOf(login('friend5')), privateKey, NOW);
  assert.equal(listMembers(db).length, 5);
  assert.match(listNotices(db, group.id, 0)[0], /5명까지만/);

  await processQueue(db, fakeClient, await queueOf({ ...login('friend0'), code: 'other-code' }), privateKey, NOW);
  assert.equal(listMembers(db, group.id).length, 5);
  assert.match(listNotices(db, listGroups(db)[1].id, 0)[0], /한 그룹에만/);
});

test('풀 수 없는 요청과 모르는 종류는 건너뛰고 대기열에서 지운다', async () => {
  const db = groupDb();
  const relay = {
    list: async () => [
      { id: 'bad', sealed: { key: 'AAAA', iv: 'AAAA', data: 'AAAA' } },
      { id: 'odd', sealed: await seal({ kind: 'constructor', code: CODE }) },
    ],
  };
  assert.deepEqual(await processQueue(db, fakeClient, relay, privateKey, NOW), ['bad', 'odd']);
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

  assert.equal(await finishSpotifyLogin(connect(), CODE, { code: 'c', state: 's' }), 'queued');
  globalThis.fetch = realFetch;

  const token = posts.find((p) => p.pathname === '/api/token');
  assert.equal(token.options.body.get('code_verifier'), 'v');
  assert.equal(token.options.body.get('redirect_uri'), 'https://site.example/crossfade/');
  assert.equal(token.options.body.has('client_secret'), false);

  const relayed = posts.find((p) => p.pathname === '/queue');
  assert.equal(relayed.options.body.includes('plain-'), false);
  assert.equal(relayed.options.body.includes(CODE), false);
  const request = openForCollector(JSON.parse(relayed.options.body).sealed, privateKey);
  assert.equal(request.refreshToken, 'plain-refresh');
  assert.equal(request.code, CODE);
  assert.equal(store.has('crossfade.spotifyLogin'), false);
});

test('state가 다르면 토큰을 요청하지 않고, 미등록 계정은 403을 알려 준다', async () => {
  const realFetch = globalThis.fetch;
  const { store, posts } = fakeBrowser({ ...LOGIN_ROUTES, '/v1/me': { status: 403 } });

  store.set('crossfade.spotifyLogin', JSON.stringify({ verifier: 'v', state: 's' }));
  await assert.rejects(finishSpotifyLogin(connect(), CODE, { code: 'c', state: 'forged' }));
  assert.equal(posts.length, 0);

  store.set('crossfade.spotifyLogin', JSON.stringify({ verifier: 'v', state: 's' }));
  await assert.rejects(finishSpotifyLogin(connect(), CODE, { code: 'c', state: 's' }), { status: 403 });
  assert.equal(posts.some((p) => p.pathname === '/queue'), false);
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
