import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { groupFileId as browserGroupFileId, openSnapshot } from '../public/snapshot.js';
import { applyMemberChange, buildSnapshot, collect } from '../src/collect.js';
import { groupFileId, openBytes, sealBytes } from '../src/crypto.js';
import { DatabaseSync } from 'node:sqlite';
import { addMember, insertScrobbles, listMembers, openDb, saveSpotifyAccount } from '../src/db.js';

const KST = 540;
const NOW = Date.UTC(2026, 10, 6, 3) / 1000;
const dir = mkdtempSync(join(tmpdir(), 'crossfade-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const fakeClient = ({ scrobbles = [] } = {}) => ({
  getUser: async (user) => ({ name: user }),
  getRecentTracks: async () => ({ nowPlaying: null, scrobbles, totalPages: 1 }),
  getTrackDuration: async () => 200,
});

const seeded = () => {
  const db = openDb(':memory:');
  const id = addMember(db, { name: '친구', lastfmUser: 'friend', service: 'apple', joinedAt: NOW });
  insertScrobbles(db, id, [{ artist: 'A', track: 'T', album: '', image: '', playedAt: NOW - 600 }]);
  return { db, id };
};

test('암호화한 값은 같은 코드로만 풀린다', () => {
  const sealed = sealBytes('비밀', 'right-code');
  assert.equal(openBytes(sealed, 'right-code').toString(), '비밀');
  assert.throws(() => openBytes(sealed, 'wrong-code'));
});

test('브라우저 코드가 서버에서 만든 스냅샷을 푼다', async () => {
  const sealed = sealBytes(JSON.stringify({ hello: '안녕' }), 'right-code');
  assert.deepEqual(await openSnapshot(new Uint8Array(sealed), 'right-code'), { hello: '안녕' });
  await assert.rejects(openSnapshot(new Uint8Array(sealed), 'wrong-code'));
});

test('스냅샷에 8주치 화면 데이터가 들어가고 토큰은 나가지 않는다', () => {
  const { db, id } = seeded();
  saveSpotifyAccount(db, { memberId: id, spotifyId: 's', accessToken: 'token-a', refreshToken: 'token-r', expiresAt: 0 });

  const snapshot = buildSnapshot(db, 1, { now: NOW, tzOffsetMinutes: KST });
  assert.deepEqual(snapshot.liveTokens, {});
  assert.equal(snapshot.overview.length, 8);
  assert.equal(snapshot.members[id].length, 8);
  assert.equal(snapshot.overview[0].group.plays, 1);
  assert.equal(snapshot.overview[1].group.plays, 0);
  assert.equal(JSON.stringify(snapshot).includes('token-'), false);
});

test('관리자가 친구를 추가하고 뺄 수 있다', async () => {
  const db = openDb(':memory:');
  const change = { name: '새친구', lastfmUser: 'NewFriend', service: 'spotify' };
  await applyMemberChange(db, fakeClient(), { ...change, action: 'add' });
  assert.equal(listMembers(db)[0].name, '새친구');

  await assert.rejects(applyMemberChange(db, fakeClient(), { ...change, action: 'add' }), /이미 추가된/);
  await assert.rejects(applyMemberChange(db, fakeClient(), { action: 'add', name: '', lastfmUser: 'x1', service: 'apple' }));
  await assert.rejects(applyMemberChange(db, fakeClient(), { action: 'remove', lastfmUser: 'nobody' }), /그룹에 없어요/);

  await applyMemberChange(db, fakeClient(), { action: 'remove', lastfmUser: 'newfriend' });
  assert.equal(listMembers(db).length, 0);
});

test('수집을 반복해도 기록이 이어지고 평문은 남지 않는다', async () => {
  const config = { tzOffsetMinutes: KST, inviteCode: 'invite', dbPath: join(dir, 'work.db') };
  const options = { config, dbKey: 'db-key', archivePath: join(dir, 'archive.enc'), outputDir: join(dir, 'site'), gapMs: 0 };
  const playedAt = Math.floor(Date.now() / 1000) - 600;
  const scrobbles = [{ artist: 'Secret Artist', track: 'One', album: '', image: '', playedAt }];

  await collect({
    ...options,
    client: fakeClient({ scrobbles }),
    change: { action: 'add', name: '친구', lastfmUser: 'friend', service: 'apple' },
  });
  rmSync(config.dbPath);

  const more = [...scrobbles, { artist: 'Secret Artist', track: 'Two', album: '', image: '', playedAt: playedAt + 60 }];
  await collect({ ...options, client: fakeClient({ scrobbles: more }) });

  assert.equal(existsSync(join(options.outputDir, 'index.html')), true);
  assert.equal(await browserGroupFileId('invite'), groupFileId('invite'));
  const sealed = readFileSync(join(options.outputDir, 'groups', `${groupFileId('invite')}.enc`));
  assert.equal(sealed.includes('Secret Artist'), false);
  assert.equal(readFileSync(options.archivePath).includes('Secret Artist'), false);
  const snapshot = await openSnapshot(new Uint8Array(sealed), 'invite');
  assert.equal(snapshot.overview[0].group.plays, 2);
});

test('공개 설정일 때만 site.json 에 코드를 넣는다', async () => {
  const base = {
    config: { tzOffsetMinutes: KST, inviteCode: 'invite', dbPath: join(dir, 'open.db') },
    dbKey: 'db-key',
    archivePath: join(dir, 'open.enc'),
    outputDir: join(dir, 'open-site'),
    client: fakeClient(),
    gapMs: 0,
  };
  await collect(base);
  assert.equal(JSON.parse(readFileSync(join(base.outputDir, 'site.json'))).openCode, null);
  await collect({ ...base, openAccess: true });
  assert.equal(JSON.parse(readFileSync(join(base.outputDir, 'site.json'))).openCode, 'invite');
});

test('관리자 현황은 비밀번호로 암호화되고 초대 코드를 담지 않는다', async () => {
  const base = {
    config: { tzOffsetMinutes: KST, inviteCode: 'invite-secret-code', dbPath: join(dir, 'admin.db') },
    dbKey: 'db-key',
    archivePath: join(dir, 'admin.enc'),
    outputDir: join(dir, 'admin-site'),
    client: fakeClient(),
    gapMs: 0,
  };
  await collect(base);
  assert.equal(existsSync(join(base.outputDir, 'admin.enc')), false, '비밀번호가 없으면 만들지 않는다');

  await collect({
    ...base,
    adminPassword: 'admin-pw',
    change: { action: 'add', name: '친구', lastfmUser: 'friend', service: 'apple' },
  });
  const sealed = readFileSync(join(base.outputDir, 'admin.enc'));
  assert.equal(sealed.includes('friend'), false);
  await assert.rejects(openSnapshot(new Uint8Array(sealed), 'wrong'));

  const summary = await openSnapshot(new Uint8Array(sealed), 'admin-pw');
  assert.equal(summary.groups[0].isDefault, true);
  assert.equal(summary.groups[0].members[0].name, '친구');
  assert.equal(JSON.stringify(summary).includes('invite-secret-code'), false);
});

test('DB를 풀 수 없으면 기록을 덮어쓰지 않고 멈춘다', async () => {
  const archivePath = join(dir, 'broken.enc');
  writeFileSync(archivePath, sealBytes('db', 'other-key'));
  const before = readFileSync(archivePath);
  await assert.rejects(
    collect({
      config: { tzOffsetMinutes: KST, inviteCode: 'invite', dbPath: join(dir, 'broken.db') },
      dbKey: 'db-key',
      archivePath,
      outputDir: join(dir, 'broken-site'),
      client: fakeClient(),
    }),
  );
  assert.deepEqual(readFileSync(archivePath), before);
});

test('다른 그룹의 기록은 스냅샷에 들어가지 않는다', () => {
  const { db } = seeded();
  const other = addMember(db, { name: '남', lastfmUser: 'stranger', service: 'apple', joinedAt: NOW, groupId: 2 });
  insertScrobbles(db, other, [{ artist: 'Hidden', track: 'Song', album: '', image: '', playedAt: NOW - 300 }]);

  const mine = buildSnapshot(db, 1, { now: NOW, tzOffsetMinutes: KST });
  assert.equal(mine.overview[0].group.plays, 1);
  assert.equal(mine.overview[0].members.length, 1);
  assert.equal(JSON.stringify(mine).includes('Hidden'), false);
  assert.equal(mine.members[other], undefined);
  assert.equal(buildSnapshot(db, 2, { now: NOW, tzOffsetMinutes: KST }).overview[0].group.plays, 1);
});

test('그룹이 없던 DB를 옮겨도 기록이 그대로이고 1번 그룹이 된다', () => {
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE members (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, lastfm_user TEXT NOT NULL UNIQUE COLLATE NOCASE,
      service TEXT NOT NULL, joined_at INTEGER NOT NULL, last_synced_at INTEGER, last_error TEXT
    );
    INSERT INTO members (id, name, lastfm_user, service, joined_at) VALUES (7, '옛친구', 'old', 'apple', 1);
    CREATE TABLE scrobbles (
      id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      artist TEXT NOT NULL, track TEXT NOT NULL, album TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
      played_at INTEGER NOT NULL, UNIQUE (member_id, artist, track, played_at)
    );
    INSERT INTO scrobbles (member_id, artist, track, played_at) VALUES (7, 'A', 'T', 100);
  `);
  old.close();

  const db = openDb(path);
  const [member] = listMembers(db, 1);
  assert.equal(member.id, 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM scrobbles').get().total, 1);
  db.exec('DELETE FROM members');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM scrobbles').get().total, 0, '외래 키가 계속 동작한다');
  db.close();
});
