import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadEnvFile, ROOT } from './config.js';
import { openBytes, openForCollector, publicKeyJwk, sealBytes } from './crypto.js';
import { listMembers, openDb, removeMember } from './db.js';
import { createClient } from './lastfm.js';
import { createRelayClient } from './relay.js';
import { MAX_WEEKS_BACK, registerMember, saveSpotifyLogin } from './server.js';
import { createSpotifyClient } from './spotify.js';
import { buildMemberDetail, buildOverview } from './stats.js';
import { syncAll } from './sync.js';
import { nowSeconds } from './time.js';

// GitHub Pages에는 서버가 없으므로, 화면에 필요한 값을 미리 계산해 초대 코드로 암호화해 둡니다.
export function buildSnapshot(db, { now, tzOffsetMinutes, connect = null }) {
  const weeks = Array.from({ length: MAX_WEEKS_BACK + 1 }, (_, week) => week);
  return {
    generatedAt: now,
    connect,
    overview: weeks.map((week) => buildOverview(db, { week, now, tzOffsetMinutes })),
    members: Object.fromEntries(
      listMembers(db).map((member) => [
        member.id,
        weeks.map((week) => buildMemberDetail(db, member.id, { week, now, tzOffsetMinutes })),
      ]),
    ),
  };
}

export async function applyMemberChange(db, client, { action, name, lastfmUser, service }) {
  if (action === 'add') return registerMember(db, client, { name, lastfmUser, service });
  if (action !== 'remove') return null;
  const member = listMembers(db).find((m) => m.lastfm_user.toLowerCase() === String(lastfmUser).trim().toLowerCase());
  if (!member) throw new Error('그 Last.fm 계정은 그룹에 없어요.');
  return removeMember(db, member.id);
}

// 브라우저에서 로그인한 친구의 토큰을 중계 서버에서 받아 옵니다. 처리한 항목의 id를 돌려줍니다.
export async function importSpotifyLogins(db, relay, privateKeyPem, now) {
  const done = [];
  for (const { id, sealed } of await relay.list()) {
    try {
      const login = openForCollector(sealed, privateKeyPem);
      saveSpotifyLogin(db, {
        profile: { id: login.spotifyId, displayName: login.displayName },
        tokens: { ...login, expiresIn: login.expiresAt - now },
        now,
      });
    } catch (error) {
      console.error('Spotify 로그인 처리 실패:', error.constructor.name);
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
  await applyMemberChange(db, client, change);

  let imported = [];
  if (relay) {
    try {
      imported = await importSpotifyLogins(db, relay, tokenPrivateKey, nowSeconds());
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

  const snapshot = buildSnapshot(db, { now: nowSeconds(), tzOffsetMinutes: config.tzOffsetMinutes, connect });
  db.close();
  writeFileSync(archivePath, sealBytes(readFileSync(config.dbPath), dbKey));
  // 저장이 끝난 뒤 지웁니다. 먼저 지우면 실패했을 때 친구가 다시 로그인해야 합니다.
  for (const id of imported) await relay.remove(id).catch((error) => console.error('중계 정리 실패:', error.message));

  rmSync(outputDir, { recursive: true, force: true });
  cpSync(join(ROOT, 'public'), outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'data.enc'), sealBytes(JSON.stringify(snapshot), config.inviteCode));
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
  const relayWriteKey = (process.env.RELAY_WRITE_KEY ?? '').trim();
  const relayReadKey = (process.env.RELAY_READ_KEY ?? '').trim();
  const spotifyReady = config.spotifyClientId && tokenPrivateKey && relayUrl && relayWriteKey && relayReadKey;

  await collect({
    ...(spotifyReady && {
      spotify: createSpotifyClient({
        clientId: config.spotifyClientId,
        accountsUrl: config.spotifyAccountsUrl,
        apiUrl: config.spotifyApiUrl,
      }),
      relay: createRelayClient({ url: relayUrl, readKey: relayReadKey }),
      tokenPrivateKey,
      connect: {
        spotifyClientId: config.spotifyClientId,
        relayUrl,
        relayWriteKey,
        tokenPublicKey: publicKeyJwk(tokenPrivateKey),
      },
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
