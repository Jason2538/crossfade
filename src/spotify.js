import { createHash, randomBytes } from 'node:crypto';

const SCOPES = 'user-read-recently-played user-read-currently-playing';
const RECENT_LIMIT = 50;

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createSpotifyClient({ clientId, redirectUri, accountsUrl, apiUrl }) {
  async function requestToken(params) {
    const response = await fetch(`${accountsUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.access_token) {
      throw new SpotifyError(response.status, body?.error_description ?? 'Spotify 토큰 요청 실패');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresIn: Number(body.expires_in) || 3600,
    };
  }

  async function api(token, path) {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new SpotifyError(response.status, body?.error?.message ?? 'Spotify 응답 오류');
    return body;
  }

  return {
    createAuthRequest() {
      const verifier = randomBytes(64).toString('base64url');
      const state = randomBytes(16).toString('hex');
      const url = new URL(`${accountsUrl}/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      });
      return { url: url.href, state, verifier };
    },

    exchangeCode: (code, verifier) =>
      requestToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),

    refresh: (refreshToken) => requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    async getProfile(token) {
      const body = await api(token, '/me');
      return { id: body.id, displayName: body.display_name ?? '' };
    },

    async getCurrentlyPlaying(token) {
      return parseCurrentlyPlaying(await api(token, '/me/player/currently-playing'));
    },

    async getRecentlyPlayed(token) {
      return parseRecentlyPlayed(await api(token, `/me/player/recently-played?limit=${RECENT_LIMIT}`));
    },
  };
}

function toTrack(item) {
  return {
    artist: item.artists?.[0]?.name ?? '',
    track: item.name ?? '',
    album: item.album?.name ?? '',
    image: item.album?.images?.[1]?.url ?? item.album?.images?.[0]?.url ?? '',
  };
}

export function parseCurrentlyPlaying(body) {
  // 팟캐스트나 일시정지 상태는 재생 중인 곡으로 보지 않습니다.
  if (!body?.is_playing || body.item?.type !== 'track') return null;
  return toTrack(body.item);
}

export function parseRecentlyPlayed(body) {
  return (body?.items ?? [])
    .map(({ track, played_at: playedAt }) => ({
      ...toTrack(track ?? {}),
      playedAt: Math.floor(Date.parse(playedAt) / 1000),
      durationSec: track?.duration_ms ? Math.round(track.duration_ms / 1000) : null,
    }))
    .filter((item) => item.artist && item.track && item.playedAt);
}
