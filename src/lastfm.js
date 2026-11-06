// Last.fm 기본 이미지(회색 별)는 앨범 아트가 없다는 뜻이므로 버립니다.
const PLACEHOLDER_IMAGE = '2a96cbd8b46e442fc41c2b86b821562f';

export const ERROR_NOT_FOUND = 6;
export const ERROR_INVALID_KEY = 10;
export const ERROR_PRIVATE = 17;
export const ERROR_RATE_LIMIT = 29;

export class LastfmError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createClient({ apiKey, baseUrl }) {
  async function call(method, params) {
    const url = new URL(baseUrl);
    url.search = new URLSearchParams({ method, api_key: apiKey, format: 'json', ...params });
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => null);
    if (body?.error) throw new LastfmError(body.error, body.message);
    if (!response.ok || !body) throw new LastfmError(0, `Last.fm 응답 오류 (${response.status})`);
    return body;
  }

  return {
    async getUser(user) {
      const body = await call('user.getInfo', { user });
      return { name: body.user.name };
    },

    async getRecentTracks({ user, from, page = 1, limit = 200 }) {
      const params = { user, page, limit };
      if (from !== undefined) params.from = from;
      return parseRecentTracks(await call('user.getRecentTracks', params));
    },

    // 길이를 모르면 null을 돌려줍니다.
    async getTrackDuration(artist, track) {
      try {
        const body = await call('track.getInfo', { artist, track, autocorrect: 1 });
        const ms = Number(body.track?.duration);
        return ms > 0 ? Math.round(ms / 1000) : null;
      } catch (error) {
        if (error.code === ERROR_NOT_FOUND) return null;
        throw error;
      }
    },
  };
}

export function parseRecentTracks(body) {
  const root = body.recenttracks ?? {};
  // 결과가 한 곡뿐이면 배열이 아니라 객체로 옵니다.
  const items = [root.track ?? []].flat();
  const scrobbles = [];
  let nowPlaying = null;

  for (const item of items) {
    const track = {
      artist: item.artist?.['#text'] ?? item.artist?.name ?? '',
      track: item.name ?? '',
      album: item.album?.['#text'] ?? '',
      image: pickImage(item.image),
    };
    if (!track.artist || !track.track) continue;
    if (item['@attr']?.nowplaying === 'true') nowPlaying = track;
    else if (item.date?.uts) scrobbles.push({ ...track, playedAt: Number(item.date.uts) });
  }

  return { scrobbles, nowPlaying, totalPages: Number(root['@attr']?.totalPages) || 1 };
}

function pickImage(images) {
  const list = Array.isArray(images) ? images : [];
  const url = (list.find((i) => i.size === 'large') ?? list.at(-1))?.['#text'] ?? '';
  return url.includes(PLACEHOLDER_IMAGE) ? '' : url;
}
