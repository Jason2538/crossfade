import { getMember, listMembers, nowPlayingMap, recentScrobble, scrobblesBetween } from './db.js';
import { localParts, weekRange } from './time.js';

// 길이를 알 수 없는 곡은 일반적인 곡 길이로 계산하고, 화면에 추정 비율을 표시합니다.
export const ESTIMATED_TRACK_SECONDS = 210;

const TASTE_WEEKS = 4;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 30;
const SHARED_LIMIT = 5;
const PAIR_LIMIT = 9;

const lengthOf = (row) => row.duration_sec ?? ESTIMATED_TRACK_SECONDS;

// 서비스마다 표기가 조금씩 달라서, 같은 곡끼리 묶이도록 비교용 키를 만듭니다.
export function artistKey(name) {
  return baseKey(name).split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bwith\b|×)\s*/)[0].trim();
}

export function trackKey(artist, track) {
  const title = baseKey(track)
    .replace(/\s+-\s+.*(?:remaster|version|live|mix|edit|single|ver\.?).*$/, '')
    .trim();
  return `${artistKey(artist)}\u0000${title}`;
}

function baseKey(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*[([{].*?[)\]}]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarize(rows) {
  const seconds = rows.reduce((sum, row) => sum + lengthOf(row), 0);
  return {
    minutes: Math.round(seconds / 60),
    plays: rows.length,
    uniqueTracks: new Set(rows.map((row) => trackKey(row.artist, row.track))).size,
    uniqueArtists: new Set(rows.map((row) => artistKey(row.artist))).size,
    estimatedPlays: rows.filter((row) => row.duration_sec === null).length,
  };
}

export function topItems(rows, keyOf, labelOf, limit = TOP_LIMIT) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { ...labelOf(row), plays: 0, seconds: 0 };
    group.plays += 1;
    group.seconds += lengthOf(row);
    group.image ||= row.image;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ seconds, ...group }) => ({ ...group, minutes: Math.round(seconds / 60) }))
    .sort((a, b) => b.plays - a.plays || b.minutes - a.minutes)
    .slice(0, limit);
}

export const topTracks = (rows, limit) =>
  topItems(rows, (r) => trackKey(r.artist, r.track), (r) => ({ track: r.track, artist: r.artist, image: r.image }), limit);

export const topArtists = (rows, limit) =>
  topItems(rows, (r) => artistKey(r.artist), (r) => ({ artist: r.artist, image: r.image }), limit);

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (const [key, value] of a) dot += value * (b.get(key) ?? 0);
  const norm = (m) => Math.sqrt([...m.values()].reduce((sum, v) => sum + v * v, 0));
  const denominator = norm(a) * norm(b);
  return denominator ? dot / denominator : 0;
}

function countBy(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  return counts;
}

export function compareTaste(rowsA, rowsB) {
  const artistsA = countBy(rowsA, (r) => artistKey(r.artist));
  const artistsB = countBy(rowsB, (r) => artistKey(r.artist));
  const tracksB = countBy(rowsB, (r) => trackKey(r.artist, r.track));

  const sharedArtists = topArtists(rowsA.filter((r) => artistsB.has(artistKey(r.artist))), SHARED_LIMIT);
  const sharedTracks = topTracks(rowsA.filter((r) => tracksB.has(trackKey(r.artist, r.track))), SHARED_LIMIT);

  return {
    score: Math.round(cosineSimilarity(artistsA, artistsB) * 100),
    sharedArtists: sharedArtists.map((item) => item.artist),
    sharedTracks: sharedTracks.map(({ track, artist }) => ({ track, artist })),
  };
}

function weekLabel(range, tzMinutes) {
  const format = (sec) => {
    const date = new Date((sec + tzMinutes * 60) * 1000);
    return { month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  };
  return { startsOn: format(range.start), endsOn: format(range.end - 1) };
}

export function buildOverview(db, { week, now, tzOffsetMinutes, groupId = null }) {
  const range = weekRange(week, now, tzOffsetMinutes);
  const previous = weekRange(week + 1, now, tzOffsetMinutes);
  const tasteStart = weekRange(week + TASTE_WEEKS - 1, now, tzOffsetMinutes).start;

  const groupMembers = listMembers(db, groupId);
  const memberIds = new Set(groupMembers.map((member) => member.id));
  const groupRows = (start, end) => scrobblesBetween(db, start, end).filter((r) => memberIds.has(r.member_id));

  const rows = groupRows(range.start, range.end);
  // 진행 중인 주는 지난주의 같은 시점까지만 비교해야 공정합니다.
  const previousEnd = Math.min(previous.end, previous.start + (now - range.start));
  const previousRows = groupRows(previous.start, week === 0 ? previousEnd : previous.end);
  const tasteRows = groupRows(tasteStart, range.end);
  const playing = nowPlayingMap(db);

  const members = groupMembers.map((member) => {
    const own = rows.filter((r) => r.member_id === member.id);
    const before = previousRows.filter((r) => r.member_id === member.id);
    return {
      id: member.id,
      name: member.name,
      service: member.service,
      lastfmUser: member.lastfm_user,
      lastSyncedAt: member.last_synced_at,
      error: member.last_error,
      ...summarize(own),
      previousMinutes: summarize(before).minutes,
      topTrack: topTracks(own, 1)[0] ?? null,
      nowPlaying: playing.get(member.id) ?? null,
      lastPlayed: recentScrobble(db, member.id) ?? null,
    };
  });
  members.sort((a, b) => b.minutes - a.minutes || b.plays - a.plays || a.id - b.id);

  const pairs = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i];
      const b = members[j];
      const rowsA = tasteRows.filter((r) => r.member_id === a.id);
      const rowsB = tasteRows.filter((r) => r.member_id === b.id);
      if (rowsA.length && rowsB.length) pairs.push({ a: a.id, b: b.id, ...compareTaste(rowsA, rowsB) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const visiblePairs = pairs.filter((pair) => pair.score > 0).slice(0, PAIR_LIMIT);

  return {
    week: { offset: week, ...range, ...weekLabel(range, tzOffsetMinutes) },
    tasteWeeks: TASTE_WEEKS,
    group: { ...summarize(rows), topTracks: topTracks(rows, 5) },
    members,
    pairs: visiblePairs,
  };
}

export function buildMemberDetail(db, memberId, { week, now, tzOffsetMinutes }) {
  const member = getMember(db, memberId);
  if (!member) return null;

  const range = weekRange(week, now, tzOffsetMinutes);
  const rows = scrobblesBetween(db, range.start, range.end).filter((r) => r.member_id === member.id);

  const byDay = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  for (const row of rows) {
    const { dow, hour } = localParts(row.played_at, tzOffsetMinutes);
    const minutes = lengthOf(row) / 60;
    byDay[dow] += minutes;
    byHour[hour] += minutes;
  }

  return {
    id: member.id,
    name: member.name,
    service: member.service,
    week: { offset: week, ...range, ...weekLabel(range, tzOffsetMinutes) },
    ...summarize(rows),
    topTracks: topTracks(rows),
    topArtists: topArtists(rows),
    byDay: byDay.map(Math.round),
    byHour: byHour.map(Math.round),
    recent: rows.slice(0, RECENT_LIMIT).map((r) => ({
      track: r.track,
      artist: r.artist,
      image: r.image,
      playedAt: r.played_at,
    })),
  };
}
