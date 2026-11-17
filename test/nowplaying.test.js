import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMember, openDb, setNowPlaying } from '../src/db.js';
import { buildOverview } from '../src/stats.js';

const NOW = 1_800_000_000;
const song = { artist: 'The Weeknd', track: 'In Your Eyes', album: '', image: '' };

test('수집이 실패해 오래전에 본 곡은 지금 듣는 중으로 보여 주지 않는다', () => {
  const db = openDb(':memory:');
  const fresh = addMember(db, { name: '가', lastfmUser: 'a', service: 'spotify', joinedAt: 0 });
  const stale = addMember(db, { name: '나', lastfmUser: 'b', service: 'spotify', joinedAt: 0 });
  setNowPlaying(db, fresh, song, NOW - 5 * 60);
  setNowPlaying(db, stale, song, NOW - 40 * 60);

  const { members } = buildOverview(db, { week: 0, now: NOW, tzOffsetMinutes: 540 });
  const byId = Object.fromEntries(members.map((member) => [member.id, member]));
  assert.equal(byId[fresh].nowPlaying?.track, 'In Your Eyes');
  assert.equal(byId[stale].nowPlaying, null);
});
