import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadEnvFile, ROOT } from './config.js';
import { groupFileId, openBytes, openForCollector, publicKeyJwk, sealBytes } from './crypto.js';
import {
  addGroup,
  addNotice,
  findSpotifyAccount,
  getGroupByCode,
  getMember,
  listGroups,
  listMembers,
  listNotices,
  openDb,
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

// GitHub Pages에는 서버가 없으므로, 화면에 필요한 값을 그룹별로 미리 계산해 초대 코드로 암호화해 둡니다.
export function buildSnapshot(db, groupId, { now, tzOffsetMinutes }) {
  const weeks = Array.from({ length: MAX_WEEKS_BACK + 1 }, (_, week) => week);
  return {
    generatedAt: now,
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
    const existing = findSpotifyAccount(db, request.spotifyId);
    if (existing && getMember(db, existing.member_id).group_id !== group.id) {
      addNotice(db, group.id, 'Spotify 계정 하나는 한 그룹에만 연결할 수 있어요.', now);
      return;
    }
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

// 중계 대기열의 요청을 처리합니다. 초대 코드를 아는 사람만 그 그룹을 바꿀 수 있습니다. 처리한 항목의 id를 돌려줍니다.
export async function processQueue(db, client, relay, privateKeyPem, now) {
  const done = [];
  for (const { id, sealed } of await relay.list()) {
    try {
      const request = openForCollector(sealed, privateKeyPem);
      const handler = Object.hasOwn(HANDLERS, request.kind) ? HANDLERS[request.kind] : null;
      const group = getGroupByCode(db, request.code);
      if (handler && (group || request.kind === 'group')) await handler(db, client, request, now, group);
    } catch (error) {
      console.error('대기열 처리 실패:', error.constructor.name);
    }
    done.push(id);
  }
  return done;
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
}) {
  // 복호화에 실패하면 여기서 멈춥니다. 빈 DB로 계속하면 쌓인 기록을 덮어쓰게 됩니다.
  if (existsSync(archivePath)) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    writeFileSync(config.dbPath, openBytes(readFileSync(archivePath), dbKey));
  }
  const db = openDb(config.dbPath);
  saveDefaultGroup(db, config.inviteCode, nowSeconds());
  await applyMemberChange(db, client, change);

  let processed = [];
  if (relay) {
    try {
      processed = await processQueue(db, client, relay, tokenPrivateKey, nowSeconds());
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
  writeFileSync(join(outputDir, 'site.json'), JSON.stringify({ connect }));

  const now = nowSeconds();
  for (const group of listGroups(db)) {
    const snapshot = buildSnapshot(db, group.id, { now, tzOffsetMinutes: config.tzOffsetMinutes });
    writeFileSync(join(outputDir, 'groups', `${groupFileId(group.code)}.enc`), sealBytes(JSON.stringify(snapshot), group.code));
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
