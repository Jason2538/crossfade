import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMember, getMember, getSpotifyAccount, openDb, saveSpotifyAccount } from '../src/db.js';
import { SpotifyError } from '../src/spotify.js';
import { spotifyBlockedUntil, syncSpotifyMember } from '../src/sync.js';

function setup() {
  const db = openDb(':memory:');
  const id = addMember(db, { name: '가', lastfmUser: 'spotify:a', service: 'spotify', joinedAt: 0 });
  // 토큰이 아직 살아 있어서 갱신하지 않고 바로 묻습니다.
  saveSpotifyAccount(db, { memberId: id, spotifyId: 'a', accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() / 1000 + 3600 });
  return { db, id };
}

test('Spotify가 429로 막으면 알려 준 시각을 기억하고, 그때까지는 묻지 않는다', async () => {
  const { db, id } = setup();
  let calls = 0;
  const blocked = {
    getCurrentlyPlaying: async () => {
      calls += 1;
      throw new SpotifyError(429, 'Too many requests', 46759);
    },
    getRecentlyPlayed: async () => [],
  };
  await syncSpotifyMember(db, blocked, getMember(db, id), getSpotifyAccount(db, id));
  assert.equal(calls, 1);
  const until = spotifyBlockedUntil(db);
  assert.ok(until > Date.now() / 1000 + 46000, '대기 시간만큼 뒤까지 막힘');
  assert.match(getMember(db, id).last_error, /까지 막아 두었습니다/);

  // 다음 수집 때는 Spotify에 묻지 않습니다.
  await syncSpotifyMember(db, blocked, getMember(db, id), getSpotifyAccount(db, id));
  assert.equal(calls, 1);
});

test('막힘이 풀리면 다시 가져온다', async () => {
  const { db, id } = setup();
  const ok = {
    getCurrentlyPlaying: async () => null,
    getRecentlyPlayed: async () => [{ artist: 'A', track: 'T', album: '', image: '', playedAt: 1_800_000_000 }],
  };
  assert.equal(spotifyBlockedUntil(db), null);
  await syncSpotifyMember(db, ok, getMember(db, id), getSpotifyAccount(db, id));
  assert.equal(getMember(db, id).last_error, null);
});
