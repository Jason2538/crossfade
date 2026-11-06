import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadEnvFile, ROOT } from './config.js';
import {
  addMember,
  countSpotifyAccounts,
  findSpotifyAccount,
  listMembers,
  openDb,
  removeMember,
  saveSpotifyAccount,
} from './db.js';
import { seedDemo } from './demo.js';
import { createClient, ERROR_INVALID_KEY, ERROR_NOT_FOUND, ERROR_PRIVATE } from './lastfm.js';
import { createSpotifyClient } from './spotify.js';
import { buildMemberDetail, buildOverview } from './stats.js';
import { fillTrackLengths, startSyncLoop, syncMember, syncSpotifyMember } from './sync.js';
import { nowSeconds } from './time.js';

const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY_BYTES = 10_000;
export const MAX_WEEKS_BACK = 7;
const MAX_MEMBERS = 30;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 10;
const COOKIE_NAME = 'crossfade_session';
// Spotify 개발 모드는 앱 하나당 5명까지만 허용합니다.
const MAX_SPOTIFY_USERS = 5;
const SPOTIFY_LOGIN_TTL_MS = 10 * 60_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://*.fastly.net https://*.last.fm https://i.scdn.co; " +
    "style-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; " +
    "frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class SpotifyGroupFull extends Error {}

export function createApp({ config, db, client, spotify = null }) {
  const failures = new Map();
  const spotifyLogins = new Map();
  const sessionToken = config.inviteCode
    ? createHmac('sha256', config.inviteCode).update('crossfade-session-v1').digest('hex')
    : null;
  const statsOptions = () => ({ now: nowSeconds(), tzOffsetMinutes: config.tzOffsetMinutes });

  const isAuthed = (req) => {
    if (!sessionToken) return true;
    return safeEqual(readCookie(req, COOKIE_NAME), sessionToken);
  };

  const requireAuth = (req) => {
    if (!isAuthed(req)) throw new HttpError(401, '초대 코드를 먼저 입력해 주세요.');
  };

  const requireWritable = () => {
    if (config.demo) throw new HttpError(403, '데모 모드에서는 친구를 추가하거나 삭제할 수 없어요.');
  };

  const routes = {
    'GET /api/session': (req) => ({
      demo: config.demo,
      inviteRequired: Boolean(sessionToken),
      authed: isAuthed(req),
      spotifyLogin: Boolean(spotify),
    }),

    'GET /api/spotify/login': (req, res) => {
      requireAuth(req);
      requireWritable();
      if (!spotify) throw new HttpError(404, 'Spotify 로그인이 설정되어 있지 않아요.');

      const origin = `${config.cookieSecure ? 'https' : 'http'}://${req.headers.host}`;
      const now = Date.now();
      for (const [state, login] of spotifyLogins) {
        if (login.expiresAt < now) spotifyLogins.delete(state);
      }
      const { url, state, verifier } = spotify.createAuthRequest();
      spotifyLogins.set(state, { verifier, origin, expiresAt: now + SPOTIFY_LOGIN_TTL_MS });
      return redirect(res, url);
    },

    // Spotify에서 돌아오는 주소입니다. 쿠키 대신 로그인을 시작할 때 만든 state로 요청을 확인합니다.
    'GET /api/spotify/callback': async (_req, res, url) => {
      const state = url.searchParams.get('state');
      const login = spotifyLogins.get(state);
      spotifyLogins.delete(state);
      if (!spotify || !login || login.expiresAt < Date.now()) throw new HttpError(400, '로그인을 다시 시도해 주세요.');

      const code = url.searchParams.get('code');
      if (!code) return redirect(res, `${login.origin}/?spotify=denied`);

      try {
        const member = await connectSpotify(db, spotify, code, login.verifier);
        syncSpotifyMember(db, spotify, member.member, member.account).catch((error) =>
          console.error('첫 동기화 실패:', error.message),
        );
        return redirect(res, `${login.origin}/?spotify=connected`);
      } catch (error) {
        if (error instanceof SpotifyGroupFull) return redirect(res, `${login.origin}/?spotify=full`);
        console.error('Spotify 로그인 실패:', error.message);
        return redirect(res, `${login.origin}/?spotify=${error.status === 403 ? 'notAllowed' : 'failed'}`);
      }
    },

    'POST /api/session': async (req, res) => {
      const address = req.socket.remoteAddress;
      const recent = (failures.get(address) ?? []).filter((at) => Date.now() - at < LOGIN_WINDOW_MS);
      if (recent.length >= LOGIN_MAX_FAILURES) {
        throw new HttpError(429, '시도가 너무 많아요. 잠시 후 다시 입력해 주세요.');
      }
      const { code } = await readJson(req);
      if (!config.inviteCode || !safeEqual(String(code ?? ''), config.inviteCode)) {
        failures.set(address, [...recent, Date.now()]);
        throw new HttpError(403, '초대 코드가 맞지 않아요.');
      }
      failures.delete(address);
      const secure = config.cookieSecure ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
      );
      return { authed: true };
    },

    'GET /api/overview': (req, _res, url) => {
      requireAuth(req);
      return buildOverview(db, { ...statsOptions(), week: readWeek(url) });
    },

    'POST /api/members': async (req) => {
      requireAuth(req);
      requireWritable();
      const id = await registerMember(db, client, await readJson(req));

      const member = listMembers(db).find((m) => m.id === id);
      syncMember(db, client, member, { tzOffsetMinutes: config.tzOffsetMinutes })
        .then(() => fillTrackLengths(db, client))
        .catch((error) => console.error('첫 동기화 실패:', error.message));
      return { id };
    },

    'GET /api/member': (req, _res, url) => {
      requireAuth(req);
      const detail = buildMemberDetail(db, Number(url.searchParams.get('id')), {
        ...statsOptions(),
        week: readWeek(url),
      });
      if (!detail) throw new HttpError(404, '친구를 찾을 수 없어요.');
      return detail;
    },

    'DELETE /api/member': (req, _res, url) => {
      requireAuth(req);
      requireWritable();
      if (!removeMember(db, Number(url.searchParams.get('id')))) throw new HttpError(404, '친구를 찾을 수 없어요.');
      return { removed: true };
    },
  };

  return createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const url = new URL(req.url, 'http://localhost');

    try {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url, res);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, '찾을 수 없는 요청이에요.');
      const body = await route(req, res, url);
      if (!res.headersSent) sendJson(res, 200, body);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : '서버에서 문제가 생겼어요.';
      if (!res.headersSent) sendJson(res, status, { error: message });
    }
  });
}

export async function registerMember(db, client, body) {
  const name = String(body.name ?? '').trim();
  const lastfmUser = String(body.lastfmUser ?? '').trim();
  const service = body.service;

  if (!name || name.length > 20) throw new HttpError(400, '이름은 1~20자로 입력해 주세요.');
  if (!/^[A-Za-z][\w-]{1,14}$/.test(lastfmUser)) throw new HttpError(400, 'Last.fm 사용자 이름을 확인해 주세요.');
  if (service !== 'spotify' && service !== 'apple') throw new HttpError(400, '사용하는 서비스를 골라 주세요.');
  if (listMembers(db).length >= MAX_MEMBERS) throw new HttpError(400, '그룹이 가득 찼어요.');
  if (listMembers(db).some((m) => m.lastfm_user.toLowerCase() === lastfmUser.toLowerCase())) {
    throw new HttpError(409, '이미 추가된 Last.fm 계정이에요.');
  }

  const profile = await verifyLastfmUser(client, lastfmUser);
  return addMember(db, { name, lastfmUser: profile.name, service, joinedAt: nowSeconds() });
}

async function connectSpotify(db, spotify, code, verifier) {
  const tokens = await spotify.exchangeCode(code, verifier);
  const profile = await spotify.getProfile(tokens.accessToken);
  return saveSpotifyLogin(db, { profile, tokens, now: nowSeconds() });
}

export function saveSpotifyLogin(db, { profile, tokens, now }) {

  // 이미 연결된 친구는 인원이 다 찼어도 토큰이 만료되면 다시 로그인할 수 있어야 합니다.
  const existing = findSpotifyAccount(db, profile.id);
  if (!existing && countSpotifyAccounts(db) >= MAX_SPOTIFY_USERS) throw new SpotifyGroupFull();

  const memberId =
    existing?.member_id ??
    addMember(db, {
      name: (profile.displayName || 'Spotify 친구').slice(0, 20),
      lastfmUser: `spotify:${profile.id}`,
      service: 'spotify',
      joinedAt: now,
    });

  saveSpotifyAccount(db, {
    memberId,
    spotifyId: profile.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? existing?.refresh_token ?? '',
    expiresAt: now + tokens.expiresIn,
  });

  return {
    member: listMembers(db).find((m) => m.id === memberId),
    account: findSpotifyAccount(db, profile.id),
  };
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function verifyLastfmUser(client, user) {
  try {
    const profile = await client.getUser(user);
    await client.getRecentTracks({ user: profile.name, limit: 1 });
    return profile;
  } catch (error) {
    if (error.code === ERROR_NOT_FOUND) throw new HttpError(404, 'Last.fm에서 그 사용자를 찾을 수 없어요.');
    if (error.code === ERROR_PRIVATE) {
      throw new HttpError(403, 'Last.fm 설정에서 "최근 청취 기록 숨기기"를 꺼 주세요.');
    }
    if (error.code === ERROR_INVALID_KEY) throw new HttpError(502, '서버의 Last.fm API 키가 올바르지 않아요. .env 파일을 확인해 주세요.');
    console.error('Last.fm 확인 실패:', error.message);
    throw new HttpError(502, 'Last.fm에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}

async function serveStatic(url, res) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const path = normalize(join(PUBLIC_DIR, relative));
  if (!path.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, '찾을 수 없어요.');
  try {
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    throw new HttpError(404, '찾을 수 없어요.');
  }
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'JSON 요청만 받을 수 있어요.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '요청이 너무 커요.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object') return body;
  } catch {
    // 아래의 400 응답으로 처리합니다.
  }
  throw new HttpError(400, '요청 형식이 올바르지 않아요.');
}

function readWeek(url) {
  const week = Number(url.searchParams.get('week') ?? 0);
  if (!Number.isInteger(week) || week < 0 || week > MAX_WEEKS_BACK) throw new HttpError(400, '주를 확인해 주세요.');
  return week;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name) return value ?? '';
  }
  return '';
}

function safeEqual(a, b) {
  const left = createHmac('sha256', 'compare').update(a).digest();
  const right = createHmac('sha256', 'compare').update(b).digest();
  return timingSafeEqual(left, right);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function main() {
  loadEnvFile();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const client = config.demo ? null : createClient({ apiKey: config.apiKey, baseUrl: config.lastfmBaseUrl });

  const spotify =
    !config.demo && config.spotifyClientId
      ? createSpotifyClient({
          clientId: config.spotifyClientId,
          redirectUri: config.spotifyRedirectUri,
          accountsUrl: config.spotifyAccountsUrl,
          apiUrl: config.spotifyApiUrl,
        })
      : null;

  if (config.demo) seedDemo(db, nowSeconds());
  else startSyncLoop(db, client, { tzOffsetMinutes: config.tzOffsetMinutes, spotify });

  createApp({ config, db, client, spotify }).listen(config.port, config.host, () => {
    const mode = config.demo ? '데모 모드 (샘플 데이터)' : 'Last.fm 연동 모드';
    console.log(`크로스페이드 실행 중: http://${config.host}:${config.port} · ${mode}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
