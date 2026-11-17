// Aria에서 화면과 상관없는 계산만 모아 둔 파일입니다. test/aria.test.js 에서 확인합니다.

export function formatTime(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 원하는 크기보다 크거나 같은 것 중 가장 작은 이미지를 고릅니다.
export function pickImage(images, min = 0) {
  if (!images?.length) return '';
  const sorted = [...images].sort((a, b) => (a.width || 9999) - (b.width || 9999));
  return (sorted.find((image) => (image.width || 9999) >= min) ?? sorted[sorted.length - 1]).url;
}

export function normTrack(track, album = null) {
  const art = track.album?.images ?? album?.images ?? [];
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists ?? []).map((artist) => ({ name: artist.name, id: artist.id })),
    album: { id: track.album?.id ?? album?.id ?? null, name: track.album?.name ?? album?.name ?? '', uri: track.album?.uri ?? album?.uri ?? null },
    thumb: pickImage(art, 120),
    cover: pickImage(art, 600),
    duration: track.duration_ms ?? 0,
    number: track.track_number ?? null,
    explicit: Boolean(track.explicit),
  };
}

export const artistNames = (track) => track.artists.map((artist) => artist.name).join(', ');

// 같은 곡이 여러 번 나오면 처음 것만 남깁니다(최근 재생 목록 등).
export function uniqueTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => track?.uri && !seen.has(track.uri) && seen.add(track.uri));
}

// [mm:ss.xx] 형식의 싱크 가사를 줄 목록으로 바꿉니다.
export function parseLRC(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const pattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const times = [];
    let match;
    let end = 0;
    while ((match = pattern.exec(raw))) {
      times.push(Number(match[1]) * 60000 + Number(match[2]) * 1000 + (match[3] ? Math.round(Number(`0.${match[3]}`) * 1000) : 0));
      end = pattern.lastIndex;
    }
    const words = raw.slice(end).trim();
    for (const time of times) lines.push({ time, text: words });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// 지금 위치에서 불러야 할 줄의 번호입니다. 첫 줄 전이면 -1 입니다.
export function activeLine(lines, position) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= position) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

// 가사 검색이 잘 되도록 (feat. …), - Remastered 같은 꼬리를 뗍니다.
export function cleanTitle(title) {
  const cleaned = String(title)
    .replace(/\s*[([][^)\]]*(feat|ft\.|with|remaster|live|version|edit|mono|stereo|deluxe|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|live|version|edit|mono|stereo|single|radio).*$/i, '')
    .trim();
  return cleaned || String(title);
}

// 곡을 누른 위치를 기준으로 Spotify에 넘길 100곡을 자릅니다.
export function windowAround(tracks, index, size = 100) {
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), tracks.length - size));
  const slice = tracks.slice(start, start + size);
  return { uris: slice.map((track) => track.uri), position: index - start };
}
