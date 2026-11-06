import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadEnvFile, ROOT } from './config.js';
import { groupFileId, openBytes, openForCollector, publicKeyJwk, samePassword, sealBytes, sealLiveToken } from './crypto.js';
import {
  addGroup,
  addNotice,
  countSpotifyAccounts,
  findSpotifyAccount,
  getGroupByCode,
  getMember,
  getSpotifyAccount,
  listGroups,
  listMembers,
  listNotices,
  moveMember,
  openDb,
  removeGroup,
  removeMember,
  saveDefaultGroup,
} from './db.js';
import { createClient } from './lastfm.js';
import { createRelayClient } from './relay.js';
import { MAX_WEEKS_BACK, registerMember, saveSpotifyLogin, SpotifyGroupFull } from './server.js';
import { createSpotifyClient } from './spotify.js';
import { buildMemberDetail, buildOverview } from './stats.js';
import { syncAll } from './sync.js';
import { nowSeconds } from './time.js';

// 누구나 그룹을 만들 수 있으므로 GitHub Actions 한 번의 실행 시간이 늘어나지 않게 막아 둡니다.
export const MAX_GROUPS = 20;
const NOTICE_SECONDS = 7 * 86400;
const DEFAULT_GROUP_ID = 1;

// refresh token은 Cloudflare에 보내지 않습니다. 1시간 뒤 끝나는 access token만 넘깁니다.
function liveTarget(db, member) {
  if (!member.lastfm_user.startsWith('spotify:')) return member.lastfm_user;
  const account = getSpotifyAccount(db, member.id);
  return account ? `spotify:${account.access_token}` : null;
}

// GitHub Pages에는 서버가 없으므로, 화면에 필요한 값을 그룹별로 미리 계산해 초대 코드로 암호화해 둡니다.
export function buildSnapshot(db, groupId, { now, tzOffsetMinutes, liveKey = null }) {
  const weeks = Array.from({ length: MAX_WEEKS_BACK + 1 }, (_, week) => week);
  const targets = listMembers(db, groupId)
    .map((member) => [member.id, liveTarget(db, member)])
    .filter(([, target]) => target);
  return {
    generatedAt: now,
    liveTokens: liveKey ? Object.fromEntries(targets.map(([id, target]) => [id, sealLiveToken(target, liveKey)])) : {},
    notices: listNotices(db, groupId, now - NOTICE_SECONDS),
    overview: weeks.map((week) => buildOverview(db, { week, now, tzOffsetMinutes, groupId })),
    members: Object.fromEntries(
      listMembers(db, groupId).map((member) => [
        member.id,
        weeks.map((week) => buildMemberDetail(db, member.id, { week, now, tzOffsetMinutes })),
      ]),
    ),
  };
}

export async function applyMemberChange(db, client, { action, name, lastfmUser, service }) {
  if (action === 'add') return registerMember(db, client, { name, lastfmUser, service });
  if (action !== 'remove') return null;
  const target = String(lastfmUser).trim().toLowerCase();
  const member = listMembers(db, DEFAULT_GROUP_ID).find((m) => m.lastfm_user.toLowerCase() === target);
  if (!member) throw new Error('그 Last.fm 계정은 그룹에 없어요.');
  return removeMember(db, member.id);
}

const HANDLERS = {
  group(db, _client, request, now) {
    if (getGroupByCode(db, request.code) || listGroups(db).length >= MAX_GROUPS) return;
    addGroup(db, request.code, now);
  },

  async member(db, client, request, now, group) {
    const { name, lastfmUser, service } = request;
    try {
      await registerMember(db, client, { name, lastfmUser, service, groupId: group.id });
    } catch (error) {
      addNotice(db, group.id, `${name} 님을 추가하지 못했어요: ${error.message}`, now);
    }
  },

  remove(db, _client, request, _now, group) {
    if (getMember(db, request.memberId)?.group_id === group.id) removeMember(db, request.memberId);
  },

  spotify(db, _client, request, now, group) {
    // 계정 주인이 로그인한 그룹으로 기록과 함께 옮깁니다.
    const existing = findSpotifyAccount(db, request.spotifyId);
    if (existing) moveMember(db, existing.member_id, group.id);
    try {
      saveSpotifyLogin(db, {
        profile: { id: request.spotifyId, displayName: request.displayName },
        tokens: { ...request, expiresIn: request.expiresAt - now },
        now,
        groupId: group.id,
      });
    } catch (error) {
      if (!(error instanceof SpotifyGroupFull)) throw error;
      addNotice(db, group.id, 'Spotify 로그인은 5명까지만 쓸 수 있어요. Last.fm으로 연결해 주세요.', now);
    }
  },
};

// 관리자 화면의 요청입니다. 비밀번호가 맞을 때만 처리합니다.
function handleAdmin(db, request, adminPassword) {
  if (!adminPassword || !samePassword(request.password, adminPassword)) throw new Error('관리자 비밀번호가 맞지 않습니다.');
  if (request.action === 'removeMember') removeMember(db, request.memberId);
  // 1번 그룹은 사이트의 기본 그룹이라 지우지 않습니다.
  if (request.action === 'removeGroup' && request.groupId !== DEFAULT_GROUP_ID) removeGroup(db, request.groupId);
}

// 중계 대기열의 요청을 처리합니다. 초대 코드를 아는 사람만 그 그룹을 바꿀 수 있습니다. 처리한 항목의 id를 돌려줍니다.
// 코드가 공개된 그룹은 누구나 요청할 수 있으므로 멤버 삭제를 받지 않습니다.
export async function processQueue(db, client, relay, privateKeyPem, now, { openCode = null, adminPassword = null } = {}) {
  const done = [];
  for (const { id, sealed } of await relay.list()) {
    try {
      const request = openForCollector(sealed, privateKeyPem);
      if (request.kind === 'admin') {
        handleAdmin(db, request, adminPassword);
        done.push(id);
        continue;
      }
      const handler = Object.hasOwn(HANDLERS, request.kind) ? HANDLERS[request.kind] : null;
      const group = getGroupByCode(db, request.code);
      if (request.kind === 'remove' && request.code === openCode) throw new Error('공개 그룹의 멤버는 뺄 수 없습니다.');
      if (handler && (group || request.kind === 'group')) await handler(db, client, request, now, group);
    } catch (error) {
      console.error('대기열 처리 실패:', error.constructor.name);
    }
    done.push(id);
  }
  return done;
}

// 초대 코드는 넣지 않습니다. 관리자도 그룹의 초대 코드 없이 멤버 목록만 봅니다.
function adminGroup(group, snapshot) {
  return {
    id: group.id,
    createdAt: group.created_at,
    isDefault: group.id === DEFAULT_GROUP_ID,
    members: snapshot.overview[0].members.map(({ id, name, service, minutes, plays, lastSyncedAt, error }) => ({
      id,
      name,
      service,
      minutes,
      plays,
      lastSyncedAt,
      error,
    })),
  };
}

export async function collect({
  config,
  dbKey,
  archivePath,
  outputDir,
  client,
  change = {},
  gapMs,
  spotify = null,
  relay = null,
  tokenPrivateKey = null,
  connect = null,
  openAccess = false,
  adminPassword = null,
  liveKey = null,
}) {
  // 복호화에 실패하면 여기서 멈춥니다. 빈 DB로 계속하면 쌓인 기록을 덮어쓰게 됩니다.
  if (existsSync(archivePath)) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    writeFileSync(config.dbPath, openBytes(readFileSync(archivePath), dbKey));
  }
  const db = openDb(config.dbPath);
  saveDefaultGroup(db, config.inviteCode, nowSeconds());
  const openCode = openAccess ? config.inviteCode : null;
  await applyMemberChange(db, client, change);

  let processed = [];
  if (relay) {
    try {
      processed = await processQueue(db, client, relay, tokenPrivateKey, nowSeconds(), { openCode, adminPassword });
    } catch (error) {
      console.error('중계 서버 연결 실패:', error.message);
    }
  }

  try {
    await syncAll(db, client, { tzOffsetMinutes: config.tzOffsetMinutes, gapMs, spotify });
  } catch (error) {
    // 한도 초과 같은 일시적 문제여도 지금까지 모은 기록은 저장합니다.
    console.error('동기화 실패:', error.message);
  }

  rmSync(outputDir, { recursive: true, force: true });
  cpSync(join(ROOT, 'public'), outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'groups'));
  writeFileSync(join(outputDir, 'site.json'), JSON.stringify({ connect, openCode }));

  const now = nowSeconds();
  const adminGroups = [];
  for (const group of listGroups(db)) {
    const snapshot = buildSnapshot(db, group.id, { now, tzOffsetMinutes: config.tzOffsetMinutes, liveKey });
    writeFileSync(join(outputDir, 'groups', `${groupFileId(group.code)}.enc`), sealBytes(JSON.stringify(snapshot), group.code));
    adminGroups.push(adminGroup(group, snapshot));
  }
  if (adminPassword) {
    const summary = { generatedAt: now, maxGroups: MAX_GROUPS, spotifyUsers: countSpotifyAccounts(db), groups: adminGroups };
    writeFileSync(join(outputDir, 'admin.enc'), sealBytes(JSON.stringify(summary), adminPassword));
  }

  db.close();
  writeFileSync(archivePath, sealBytes(readFileSync(config.dbPath), dbKey));
  // 저장이 끝난 뒤 지웁니다. 먼저 지우면 실패했을 때 요청이 사라집니다.
  for (const id of processed) await relay.remove(id).catch((error) => console.error('중계 정리 실패:', error.message));
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const dbKey = (process.env.DB_KEY ?? '').trim();
  if (config.demo || !config.inviteCode || !dbKey) {
    throw new Error('LASTFM_API_KEY, INVITE_CODE, DB_KEY 가 모두 필요합니다.');
  }

  const tokenPrivateKey = (process.env.TOKEN_PRIVATE_KEY ?? '').trim();
  const relayUrl = (process.env.RELAY_URL ?? '').trim();
  const relayReadKey = (process.env.RELAY_READ_KEY ?? '').trim();
  const relayReady = tokenPrivateKey && relayUrl && relayReadKey;

  await collect({
    ...(relayReady && {
      relay: createRelayClient({ url: relayUrl, readKey: relayReadKey }),
      tokenPrivateKey,
      connect: {
        relayUrl,
        spotifyClientId: config.spotifyClientId,
        tokenPublicKey: publicKeyJwk(tokenPrivateKey),
      },
    }),
    ...(config.spotifyClientId && {
      spotify: createSpotifyClient({
        clientId: config.spotifyClientId,
        accountsUrl: config.spotifyAccountsUrl,
        apiUrl: config.spotifyApiUrl,
      }),
    }),
    config,
    dbKey,
    openAccess: process.env.OPEN_ACCESS === '1',
    adminPassword: (process.env.ADMIN_PASSWORD ?? '').trim() || null,
    liveKey: (process.env.LIVE_KEY ?? '').trim() || null,
    archivePath: process.env.DB_ARCHIVE || join(ROOT, 'crossfade.db.enc'),
    outputDir: join(ROOT, 'site'),
    client: createClient({ apiKey: config.apiKey, baseUrl: config.lastfmBaseUrl }),
    change: {
      action: process.env.MEMBER_ACTION,
      name: process.env.MEMBER_NAME,
      lastfmUser: process.env.MEMBER_LASTFM,
      service: process.env.MEMBER_SERVICE,
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
