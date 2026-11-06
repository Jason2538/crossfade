import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const apiKey = (env.LASTFM_API_KEY ?? '').trim();
  const host = env.HOST || '127.0.0.1';
  const inviteCode = (env.INVITE_CODE ?? '').trim();
  const demo = !apiKey;
  const port = Number(env.PORT) || 3000;

  if (!demo && !inviteCode && !isLoopback(host)) {
    throw new Error('외부에 공개할 때는 INVITE_CODE 를 설정해야 합니다.');
  }

  return {
    apiKey,
    demo,
    host,
    inviteCode,
    port,
    tzOffsetMinutes: Number(env.TIMEZONE_OFFSET_MINUTES ?? 540),
    cookieSecure: env.COOKIE_SECURE === '1',
    lastfmBaseUrl: env.LASTFM_API_BASE || 'https://ws.audioscrobbler.com/2.0/',
    spotifyClientId: (env.SPOTIFY_CLIENT_ID ?? '').trim(),
    // Spotify는 localhost를 허용하지 않아서 127.0.0.1을 씁니다.
    spotifyRedirectUri: env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${port}/api/spotify/callback`,
    spotifyAccountsUrl: env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com',
    spotifyApiUrl: env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1',
    dbPath: env.DB_PATH || join(ROOT, 'data', demo ? 'demo.db' : 'crossfade.db'),
  };
}

export function loadEnvFile() {
  const path = join(ROOT, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
