import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    lastfm_user TEXT NOT NULL UNIQUE COLLATE NOCASE,
    service TEXT NOT NULL CHECK (service IN ('spotify', 'apple')),
    joined_at INTEGER NOT NULL,
    last_synced_at INTEGER,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS scrobbles (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    artist TEXT NOT NULL,
    track TEXT NOT NULL,
    album TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    played_at INTEGER NOT NULL,
    UNIQUE (member_id, artist, track, played_at)
  );
  CREATE INDEX IF NOT EXISTS scrobbles_played_at ON scrobbles (played_at);

  CREATE TABLE IF NOT EXISTS now_playing (
    member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    artist TEXT NOT NULL,
    track TEXT NOT NULL,
    album TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    seen_at INTEGER NOT NULL
  );

  -- Spotify로 로그인한 멤버의 토큰입니다. 이 멤버의 lastfm_user 에는 spotify:<id> 를 넣습니다.
  CREATE TABLE IF NOT EXISTS spotify_accounts (
    member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    spotify_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- 길이를 알 수 없는 곡은 duration_sec 이 NULL 이며, 다시 조회하지 않습니다.
  CREATE TABLE IF NOT EXISTS track_lengths (
    artist TEXT NOT NULL,
    track TEXT NOT NULL,
    duration_sec INTEGER,
    PRIMARY KEY (artist, track)
  );
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function resetDb(db) {
  db.exec(
    'DELETE FROM track_lengths; DELETE FROM spotify_accounts; DELETE FROM now_playing; DELETE FROM scrobbles; DELETE FROM members;',
  );
}

export function listMembers(db) {
  return db.prepare('SELECT * FROM members ORDER BY id').all();
}

export function addMember(db, { name, lastfmUser, service, joinedAt }) {
  const result = db
    .prepare('INSERT INTO members (name, lastfm_user, service, joined_at) VALUES (?, ?, ?, ?)')
    .run(name, lastfmUser, service, joinedAt);
  return Number(result.lastInsertRowid);
}

export function getMember(db, id) {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id);
}

export function removeMember(db, id) {
  return db.prepare('DELETE FROM members WHERE id = ?').run(id).changes > 0;
}

export function insertScrobbles(db, memberId, scrobbles) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO scrobbles (member_id, artist, track, album, image, played_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const s of scrobbles) {
      added += Number(insert.run(memberId, s.artist, s.track, s.album, s.image, s.playedAt).changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return added;
}

export function getSpotifyAccount(db, memberId) {
  return db.prepare('SELECT * FROM spotify_accounts WHERE member_id = ?').get(memberId);
}

export function findSpotifyAccount(db, spotifyId) {
  return db.prepare('SELECT * FROM spotify_accounts WHERE spotify_id = ?').get(spotifyId);
}

export function countSpotifyAccounts(db) {
  return db.prepare('SELECT COUNT(*) AS total FROM spotify_accounts').get().total;
}

export function saveSpotifyAccount(db, { memberId, spotifyId, accessToken, refreshToken, expiresAt }) {
  db.prepare(
    `INSERT INTO spotify_accounts (member_id, spotify_id, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (member_id) DO UPDATE SET
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`,
  ).run(memberId, spotifyId, accessToken, refreshToken, expiresAt);
}

export function latestPlayedAt(db, memberId) {
  return db.prepare('SELECT MAX(played_at) AS latest FROM scrobbles WHERE member_id = ?').get(memberId).latest;
}

export function setNowPlaying(db, memberId, track, seenAt) {
  if (!track) {
    db.prepare('DELETE FROM now_playing WHERE member_id = ?').run(memberId);
    return;
  }
  db.prepare(
    `INSERT INTO now_playing (member_id, artist, track, album, image, seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id) DO UPDATE SET
       artist = excluded.artist, track = excluded.track, album = excluded.album,
       image = excluded.image, seen_at = excluded.seen_at`,
  ).run(memberId, track.artist, track.track, track.album, track.image, seenAt);
}

export function markSynced(db, memberId, syncedAt, error = null) {
  if (error) {
    db.prepare('UPDATE members SET last_error = ? WHERE id = ?').run(error, memberId);
  } else {
    db.prepare('UPDATE members SET last_synced_at = ?, last_error = NULL WHERE id = ?').run(syncedAt, memberId);
  }
}

export function tracksMissingLength(db, limit) {
  return db
    .prepare(
      `SELECT DISTINCT s.artist, s.track FROM scrobbles s
       LEFT JOIN track_lengths t ON t.artist = s.artist AND t.track = s.track
       WHERE t.artist IS NULL LIMIT ?`,
    )
    .all(limit);
}

export function saveTrackLength(db, artist, track, durationSec) {
  db.prepare('INSERT OR REPLACE INTO track_lengths (artist, track, duration_sec) VALUES (?, ?, ?)').run(
    artist,
    track,
    durationSec,
  );
}

export function scrobblesBetween(db, start, end) {
  return db
    .prepare(
      `SELECT s.member_id, s.artist, s.track, s.album, s.image, s.played_at, t.duration_sec
       FROM scrobbles s
       LEFT JOIN track_lengths t ON t.artist = s.artist AND t.track = s.track
       WHERE s.played_at >= ? AND s.played_at < ?
       ORDER BY s.played_at DESC`,
    )
    .all(start, end);
}

export function nowPlayingMap(db) {
  return new Map(db.prepare('SELECT * FROM now_playing').all().map((row) => [row.member_id, row]));
}

export function recentScrobble(db, memberId) {
  return db
    .prepare('SELECT artist, track, album, image, played_at FROM scrobbles WHERE member_id = ? ORDER BY played_at DESC LIMIT 1')
    .get(memberId);
}
