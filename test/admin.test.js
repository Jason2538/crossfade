import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { sealForCollector } from '../public/spotify-login.js';
import { buildSnapshot, processQueue } from '../src/collect.js';
import { publicKeyJwk } from '../src/crypto.js';
import { addGroup, addMember, addNotice, getMember, listAdminLog, listGroups, listMembers, listNotices, openDb } from '../src/db.js';

const NOW = 1_800_000_000;
const PASSWORD = 'right-password';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const client = { getUser: async (user) => ({ name: user }) };

function setup() {
  const db = openDb(':memory:');
  const first = addGroup(db, 'default-code', NOW);
  const second = addGroup(db, 'second-code', NOW);
  const memberId = addMember(db, { name: '민지', lastfmUser: 'minji', service: 'spotify', joinedAt: NOW, groupId: first });
  return { db, first, second, memberId };
}

async function admin(db, ...requests) {
  const items = [];
  for (const [index, request] of requests.entries()) {
    items.push({ id: String(index), sealed: await sealForCollector({ kind: 'admin', password: PASSWORD, ...request }, publicKeyJwk(privateKey)) });
  }
  return processQueue(db, client, { list: async () => items }, privateKey, NOW, { adminPassword: PASSWORD });
}

test('관리자는 이름을 바꾸고, 다른 그룹으로 옮기고, 결과가 관리 기록에 남는다', async () => {
  const { db, second, memberId } = setup();
  await admin(db, { action: 'renameMember', memberId, name: '  민지2  ' }, { action: 'moveMember', memberId, groupId: second });
  const member = getMember(db, memberId);
  assert.equal(member.name, '민지2');
  assert.equal(member.group_id, second);
  assert.deepEqual(
    listAdminLog(db).map((entry) => [entry.message, entry.ok]),
    [
      ['민지2 님을 그룹 2으로 옮겼어요', true],
      ['민지 님의 이름을 민지2(으)로 바꿨어요', true],
    ],
  );
});

test('공지는 그룹 화면에 실리고, 오류 알림은 지울 수 있다', async () => {
  const { db, first } = setup();
  addNotice(db, first, '친구를 추가하지 못했어요', NOW);
  await admin(db, { action: 'announce', groupId: first, text: '오늘 밤 같이 들어요' }, { action: 'clearNotices', groupId: first });
  const snapshot = buildSnapshot(db, first, { now: NOW, tzOffsetMinutes: 540 });
  assert.equal(snapshot.announcement, '오늘 밤 같이 들어요');
  assert.deepEqual(listNotices(db, first, 0), []);

  await admin(db, { action: 'announce', groupId: first, text: '' });
  assert.equal(buildSnapshot(db, first, { now: NOW, tzOffsetMinutes: 540 }).announcement, '');
});

test('관리자는 새 그룹을 만들 수 있고, 실패한 요청도 이유와 함께 기록된다', async () => {
  const { db, first, memberId } = setup();
  await admin(
    db,
    { action: 'createGroup', code: 'abcd-efgh-jkmn-pqrs' },
    { action: 'removeGroup', groupId: first },
    { action: 'removeMember', memberId: 999 },
    { action: 'renameMember', memberId, name: '   ' },
    { action: 'unknown' },
  );
  assert.equal(listGroups(db).length, 3);
  assert.equal(listMembers(db).length, 1);
  const log = listAdminLog(db);
  assert.equal(log.filter((entry) => entry.ok).length, 1);
  assert.match(log.map((entry) => entry.message).join('\n'), /기본 그룹은 지울 수 없어요[\s\S]*이미 없는 멤버예요|이미 없는 멤버예요[\s\S]*기본 그룹은 지울 수 없어요/);
});

test('비밀번호가 틀린 요청은 아무것도 바꾸지 않고 기록만 남는다', async () => {
  const { db, memberId } = setup();
  const sealed = await sealForCollector({ kind: 'admin', password: 'wrong', action: 'removeMember', memberId }, publicKeyJwk(privateKey));
  await processQueue(db, client, { list: async () => [{ id: '0', sealed }] }, privateKey, NOW, { adminPassword: PASSWORD });
  assert.equal(listMembers(db).length, 1);
  assert.equal(listAdminLog(db)[0].ok, false);
});
