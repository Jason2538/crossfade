import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { addMember, insertScrobbles, listMembers, openDb, saveTrackLength } from '../src/db.js';
import { createClient, parseRecentTracks } from '../src/lastfm.js';
import { createApp } from '../src/server.js';
import { artistKey, buildMemberDetail, buildOverview, compareTaste, ESTIMATED_TRACK_SECONDS, trackKey } from '../src/stats.js';
import { fillTrackLengths, syncMember } from '../src/sync.js';
import { localParts, weekRange } from '../src/time.js';

const KST = 540;
// 2026-11-04 수요일 12:00 KST
const WEDNESDAY = Date.UTC(2026, 10, 4, 3) / 1000;
const MONDAY_MIDNIGHT = Date.UTC(2026, 10, 1, 15) / 1000;

test('한 주는 한국 시간 월요일 0시에 시작한다', () => {
  assert.deepEqual(weekRange(0, WEDNESDAY, KST), { start: MONDAY_MIDNIGHT, end: MONDAY_MIDNIGHT + 7 * 86400 });
  assert.equal(weekRange(1, WEDNESDAY, KST).start, MONDAY_MIDNIGHT - 7 * 86400);
  assert.equal(weekRange(0, MONDAY_MIDNIGHT, KST).start, MONDAY_MIDNIGHT);
  assert.equal(weekRange(0, MONDAY_MIDNIGHT - 1, KST).start, MONDAY_MIDNIGHT - 7 * 86400);
});

test('일요일 밤은 그 주의 마지막 날로 계산된다', () => {
  assert.deepEqual(localParts(MONDAY_MIDNIGHT - 1, KST), { dow: 6, hour: 23 });
  assert.deepEqual(localParts(MONDAY_MIDNIGHT, KST), { dow: 0, hour: 0 });
});

test('서비스마다 다른 표기를 같은 곡으로 묶는다', () => {
  assert.equal(artistKey('Dua Lipa, DaBaby'), artistKey('Dua Lipa'));
  assert.equal(artistKey('Dua Lipa feat. DaBaby'), artistKey('dua lipa'));
  assert.equal(trackKey('A', 'Song (feat. B)'), trackKey('a', 'Song'));
  assert.equal(trackKey('A', 'Song - 2011 Remaster'), trackKey('A', 'Song'));
  assert.equal(trackKey('A', 'Song - Radio Edit'), trackKey('A', 'Song'));
  assert.notEqual(trackKey('A', 'Song'), trackKey('A', 'Song Two'));
});

test('취향 점수는 같은 곡을 들으면 100, 겹침이 없으면 0이다', () => {
  const row = (artist, track) => ({ artist, track, image: '', duration_sec: 200 });
  const same = compareTaste([row('A', 'x')], [row('A', 'x')]);
  assert.equal(same.score, 100);
  assert.deepEqual(same.sharedArtists, ['A']);
  assert.equal(same.sharedTracks.length, 1);
  assert.equal(compareTaste([row('A', 'x')], [row('B', 'y')]).score, 0);
});

test('Last.fm 응답에서 재생 중인 곡과 기본 이미지를 구분한다', () => {
  const parsed = parseRecentTracks({
    recenttracks: {
      track: [
        { artist: { '#text': 'A' }, name: '지금 곡', album: { '#text': '' }, '@attr': { nowplaying: 'true' } },
        {
          artist: { '#text': 'B' },
          name: '지난 곡',
          album: { '#text': 'L' },
          date: { uts: '100' },
          image: [{ size: 'large', '#text': 'https://x/2a96cbd8b46e442fc41c2b86b821562f.png' }],
        },
      ],
      '@attr': { totalPages: '3' },
    },
  });
  assert.equal(parsed.nowPlaying.track, '지금 곡');
  assert.equal(parsed.scrobbles.length, 1);
  assert.equal(parsed.scrobbles[0].playedAt, 100);
  assert.equal(parsed.scrobbles[0].image, '');
  assert.equal(parsed.totalPages, 3);
});

test('결과가 한 곡이면 객체로 와도 처리한다', () => {
  const parsed = parseRecentTracks({
    recenttracks: { track: { artist: { '#text': 'A' }, name: 'x', date: { uts: '5' } } },
  });
  assert.equal(parsed.scrobbles.length, 1);
});

test('주간 통계는 곡 길이를 더하고, 모르는 곡은 추정값을 쓴다', () => {
  const db = openDb(':memory:');
  const id = addMember(db, { name: '가', lastfmUser: 'ga', service: 'apple', joinedAt: 0 });
  saveTrackLength(db, 'A', 'known', 300);
  insertScrobbles(db, id, [
    { artist: 'A', track: 'known', album: '', image: '', playedAt: MONDAY_MIDNIGHT + 10 },
    { artist: 'A', track: 'known', album: '', image: '', playedAt: MONDAY_MIDNIGHT + 1000 },
    { artist: 'A', track: 'unknown', album: '', image: '', playedAt: MONDAY_MIDNIGHT + 2000 },
    { artist: 'A', track: 'known', album: '', image: '', playedAt: MONDAY_MIDNIGHT - 10 },
  ]);

  const overview = buildOverview(db, { week: 0, now: WEDNESDAY, tzOffsetMinutes: KST });
  const [member] = overview.members;
  assert.equal(member.plays, 3);
  assert.equal(member.minutes, Math.round((600 + ESTIMATED_TRACK_SECONDS) / 60));
  assert.equal(member.uniqueTracks, 2);
  assert.equal(member.estimatedPlays, 1);
  assert.equal(member.previousMinutes, 0, '지난주 일요일 밤 기록은 같은 시점(수요일) 이후라 비교에서 빠진다');

  const finished = buildOverview(db, { week: 0, now: MONDAY_MIDNIGHT + 8 * 86400, tzOffsetMinutes: KST });
  assert.equal(finished.members[0].previousMinutes, member.minutes, '지난 주 전체와 비교한다');

  const pastWeek = buildOverview(db, { week: 1, now: WEDNESDAY, tzOffsetMinutes: KST });
  assert.equal(pastWeek.members[0].minutes, 5);

  const detail = buildMemberDetail(db, id, { week: 0, now: WEDNESDAY, tzOffsetMinutes: KST });
  assert.equal(detail.topTracks[0].track, 'known');
  assert.equal(detail.topTracks[0].plays, 2);
  assert.equal(detail.byDay[0], member.minutes);
  assert.equal(detail.byHour[0], member.minutes);
});

// 실제 Last.fm 대신 같은 형식으로 응답하는 가짜 서버로 전체 흐름을 확인합니다.
let fake;
let app;
let appUrl;
let db;
const requests = [];

before(async () => {
  const now = Math.floor(Date.now() / 1000);
  fake = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    const method = url.searchParams.get('method');
    const user = url.searchParams.get('user');
    requests.push({ method, user, from: url.searchParams.get('from') });
    res.setHeader('Content-Type', 'application/json');

    if (user === 'nobody') return res.end(JSON.stringify({ error: 6, message: 'User not found' }));
    if (user === 'badkey') return res.end(JSON.stringify({ error: 10, message: 'Invalid API key' }));
    if (user === 'hidden' && method === 'user.getRecentTracks') {
      return res.end(JSON.stringify({ error: 17, message: 'Login: User required to be logged in' }));
    }
    if (method === 'user.getInfo') return res.end(JSON.stringify({ user: { name: user } }));
    if (method === 'user.getRecentTracks') {
      return res.end(
        JSON.stringify({
          recenttracks: {
            track: [
              { artist: { '#text': 'Band' }, name: 'Live', '@attr': { nowplaying: 'true' } },
              { artist: { '#text': 'Band' }, name: 'Tune', album: { '#text': 'LP' }, date: { uts: String(now - 300) } },
            ],
            '@attr': { totalPages: '1' },
          },
        }),
      );
    }
    if (method === 'track.getInfo') return res.end(JSON.stringify({ track: { duration: '240000' } }));
    res.end('{}');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));

  db = openDb(':memory:');
  const config = { demo: false, inviteCode: 'secret-code', tzOffsetMinutes: KST, cookieSecure: false };
  const client = createClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${fake.address().port}/2.0/` });
  app = createApp({ config, db, client });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
  app.client = client;
});

after(() => {
  app.close();
  fake.close();
});

const postJson = (path, body, cookie) =>
  fetch(appUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

async function login() {
  const response = await postJson('/api/session', { code: 'secret-code' });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('초대 코드 없이는 통계를 볼 수 없다', async () => {
  assert.equal((await fetch(`${appUrl}/api/overview`)).status, 401);
  assert.equal((await postJson('/api/session', { code: 'wrong' })).status, 403);
  assert.equal((await fetch(`${appUrl}/api/overview`, { headers: { Cookie: 'crossfade_session=forged' } })).status, 401);
});

test('친구를 추가하면 기록을 가져와 통계에 나타난다', async () => {
  const cookie = await login();
  const added = await postJson('/api/members', { name: '친구', lastfmUser: 'buddy', service: 'apple' }, cookie);
  assert.equal(added.status, 200);

  const member = listMembers(db).find((m) => m.lastfm_user === 'buddy');
  await syncMember(db, app.client, member, { tzOffsetMinutes: KST, gapMs: 0 });
  await fillTrackLengths(db, app.client, { gapMs: 0 });

  const response = await fetch(`${appUrl}/api/overview`, { headers: { Cookie: cookie } });
  const overview = await response.json();
  const buddy = overview.members.find((m) => m.id === member.id);
  assert.equal(buddy.lastfmUser, undefined, 'Last.fm 이름은 화면 데이터에 넣지 않는다');
  assert.equal(buddy.nowPlaying.track, 'Live');
  assert.equal(buddy.lastPlayed.track, 'Tune');
  assert.ok(requests.some((r) => r.method === 'track.getInfo'));
});

test('두 번째 동기화는 늦게 올라오는 기록을 위해 하루를 겹쳐 받고 중복 저장하지 않는다', async () => {
  const member = listMembers(db).find((m) => m.lastfm_user === 'buddy');
  const before = db.prepare('SELECT COUNT(*) AS n FROM scrobbles').get().n;
  requests.length = 0;
  await syncMember(db, app.client, member, { tzOffsetMinutes: KST, gapMs: 0 });
  const latest = db.prepare('SELECT MAX(played_at) AS t FROM scrobbles').get().t;
  assert.equal(Number(requests[0].from), latest - 86400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scrobbles').get().n, before);
});

test('없는 계정과 비공개 계정은 이유를 알려 준다', async () => {
  const cookie = await login();
  const missing = await postJson('/api/members', { name: '없음', lastfmUser: 'nobody', service: 'spotify' }, cookie);
  assert.equal(missing.status, 404);
  const hidden = await postJson('/api/members', { name: '숨김', lastfmUser: 'hidden', service: 'spotify' }, cookie);
  assert.equal(hidden.status, 403);
  assert.match((await hidden.json()).error, /숨기기/);
  const badKey = await postJson('/api/members', { name: '키', lastfmUser: 'badkey', service: 'spotify' }, cookie);
  assert.equal(badKey.status, 502);
  assert.match((await badKey.json()).error, /API 키/);
});

test('그룹에서 빼면 저장된 기록도 함께 지워진다', async () => {
  const cookie = await login();
  const member = listMembers(db).find((m) => m.lastfm_user === 'buddy');
  const response = await fetch(`${appUrl}/api/member?id=${member.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scrobbles WHERE member_id = ?').get(member.id).n, 0);
});

test('공개 폴더 밖의 파일은 읽을 수 없다', async () => {
  const response = await fetch(`${appUrl}/..%2f..%2fpackage.json`);
  assert.equal(response.status, 404);
  assert.equal((await fetch(`${appUrl}/%2e%2e/src/server.js`)).status, 404);
});
