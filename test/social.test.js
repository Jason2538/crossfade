import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { addMember, insertScrobbles, openDb } from '../src/db.js';
import { buildSocial } from '../src/social.js';

const KST = 540;
const DAY = 86400;
// 2026-11-09(월) 12:00 KST
const NOW = Date.UTC(2026, 10, 9, 3) / 1000;

const play = (track, playedAt, artist = 'Artist') => ({ artist, track, album: '', image: '', playedAt });

function socialDb() {
  const db = openDb(':memory:');
  const a = addMember(db, { name: '가', lastfmUser: 'a', service: 'apple', joinedAt: 0 });
  const b = addMember(db, { name: '나', lastfmUser: 'b', service: 'spotify', joinedAt: 0 });
  return { db, a, b };
}

test('오늘·이번 주·이번 달을 따로 세고, 연속으로 들은 날을 센다', () => {
  const { db, a, b } = socialDb();
  // 가: 오늘, 어제, 그제 / 사흘 전은 쉼 / 열흘 전
  insertScrobbles(db, a, [play('T1', NOW - 600), play('T2', NOW - DAY), play('T3', NOW - 2 * DAY), play('T4', NOW - 10 * DAY)]);
  // 나: 오늘은 아직 안 듣고 어제만
  insertScrobbles(db, b, [play('T1', NOW - DAY - 600)]);

  const social = buildSocial(db, null, { now: NOW, tzOffsetMinutes: KST });
  assert.equal(social.members[a].today.plays, 1);
  assert.equal(social.members[a].yesterday.plays, 1);
  assert.equal(social.members[b].yesterday.plays, 1);
  assert.equal(social.members[a].week.plays, 1, '월요일이라 이번 주는 오늘뿐');
  assert.equal(social.members[a].month.plays, 3, '열흘 전은 지난달');
  assert.equal(social.members[a].last30.plays, 4);
  assert.equal(social.members[a].streak, 3);
  assert.equal(social.members[b].streak, 1, '오늘 아직 안 들었으면 어제까지 센다');
  assert.equal(social.members[a].days7.length, 7);
  assert.ok(social.members[a].days7[6] > 0);
  assert.equal(social.members[a].weeks4.length, 4);
});

test('최근 활동은 최신순이고, 이번 주 많이 들은 곡에는 들은 친구가 붙는다', () => {
  const { db, a, b } = socialDb();
  insertScrobbles(db, a, [play('Shared', NOW - 300), play('Solo', NOW - 200)]);
  insertScrobbles(db, b, [play('Shared', NOW - 100)]);

  const social = buildSocial(db, null, { now: NOW, tzOffsetMinutes: KST });
  assert.deepEqual(
    social.activity.map((item) => [item.memberId, item.track]),
    [
      [b, 'Shared'],
      [a, 'Solo'],
      [a, 'Shared'],
    ],
  );
  const shared = social.groupTop.tracks.find((item) => item.track === 'Shared');
  assert.deepEqual(shared.listeners.sort(), [a, b].sort());
  assert.equal(shared.plays, 2);
});

test('궁합에는 아티스트와 듣는 시간대 점수가 함께 들어간다', () => {
  const { db, a, b } = socialDb();
  insertScrobbles(db, a, [play('X', NOW - 3600, 'Same'), play('Y', NOW - 2 * 3600, 'Same')]);
  insertScrobbles(db, b, [play('Z', NOW - 3600, 'Same')]);

  const [pair] = buildSocial(db, null, { now: NOW, tzOffsetMinutes: KST }).pairs;
  assert.equal(pair.score, 100);
  assert.ok(pair.hourScore > 0);
  assert.deepEqual(pair.sharedArtists, ['Same']);
});

test('알림 문구는 오전에는 어제, 오후에는 오늘 기록으로 만든다', () => {
  const context = vm.createContext({ self: { addEventListener() {} } });
  vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  const snapshot = {
    social: {
      members: {
        1: { today: { minutes: 65, plays: 12 }, yesterday: { minutes: 30, plays: 9 } },
        2: { today: { minutes: 1200, plays: 300 }, yesterday: { minutes: 10, plays: 3 } },
      },
    },
  };
  const evening = context.dailyMessage(snapshot, 1, 21);
  assert.equal(evening.title, '크로스페이드 · 오늘의 기록');
  assert.equal(evening.body, '나는 오늘 12번, 1시간 5분 들었어요.\n우리는 오늘 모두 1,265분 들었어요.');
  const morning = context.dailyMessage(snapshot, null, 8);
  assert.equal(morning.body, '우리는 어제 모두 40분 들었어요.');
});
