import { listMembers, scrobblesBetween } from './db.js';
import { localParts, weekRange } from './time.js';
import { artistKey, compareTaste, cosineSimilarity, ESTIMATED_TRACK_SECONDS, summarize, topArtists, topTracks, trackKey } from './stats.js';

const DAY = 86400;
// 연속 기록은 이 기간 안에서만 셉니다.
const WINDOW_DAYS = 90;
const ACTIVITY_LIMIT = 40;
const GROUP_TOP_LIMIT = 10;
const RECENT_ARTIST_LIMIT = 5;

const brief = (rows) => {
  const { minutes, plays } = summarize(rows);
  return { minutes, plays };
};

const between = (rows, start, end = Infinity) => rows.filter((row) => row.played_at >= start && row.played_at < end);

function minutesByHour(rows, tzOffsetMinutes) {
  const hours = Array(24).fill(0);
  for (const row of rows) hours[localParts(row.played_at, tzOffsetMinutes).hour] += (row.duration_sec ?? ESTIMATED_TRACK_SECONDS) / 60;
  return hours.map(Math.round);
}

// 오늘 들었으면 오늘까지, 아직 안 들었으면 어제까지 이어진 날을 셉니다.
function streakOf(rows, now, tz) {
  const days = new Set(rows.map((row) => Math.floor((row.played_at + tz) / DAY)));
  let day = Math.floor((now + tz) / DAY);
  if (!days.has(day)) day -= 1;
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day -= 1;
  }
  return streak;
}

function withListeners(items, rows, keyOf, itemKey) {
  return items.map((item) => ({
    ...item,
    listeners: [...new Set(rows.filter((row) => keyOf(row) === itemKey(item)).map((row) => row.member_id))],
  }));
}

// 친구 화면에 필요한 값입니다. 주 단위 랭킹과 달리 지금을 기준으로 오늘·이번 달·최근 30일을 계산합니다.
export function buildSocial(db, groupId, { now, tzOffsetMinutes }) {
  const tz = tzOffsetMinutes * 60;
  const today = Math.floor((now + tz) / DAY) * DAY - tz;
  const local = new Date((now + tz) * 1000);
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) / 1000 - tz;
  const week = weekRange(0, now, tzOffsetMinutes);
  const fourWeeks = [3, 2, 1, 0].map((offset) => weekRange(offset, now, tzOffsetMinutes));
  const since = Math.min(today - (WINDOW_DAYS - 1) * DAY, fourWeeks[0].start, monthStart);

  const members = listMembers(db, groupId);
  const ids = new Set(members.map((member) => member.id));
  const rows = scrobblesBetween(db, since, now + 1).filter((row) => ids.has(row.member_id));
  const recentRows = between(rows, now - 30 * DAY);
  const ownRows = (id, list = rows) => list.filter((row) => row.member_id === id);

  const stats = Object.fromEntries(
    members.map((member) => {
      const own = ownRows(member.id);
      const recent = ownRows(member.id, recentRows);
      return [
        member.id,
        {
          today: brief(between(own, today)),
          week: brief(between(own, week.start)),
          month: brief(between(own, monthStart)),
          last30: brief(recent),
          streak: streakOf(own, now, tz),
          days7: Array.from({ length: 7 }, (_, i) => summarize(between(own, today - (6 - i) * DAY, today - (5 - i) * DAY)).minutes),
          weeks4: fourWeeks.map((range) => summarize(between(own, range.start, range.end)).minutes),
          byHour30: minutesByHour(recent, tzOffsetMinutes),
          topArtists30: topArtists(recent, RECENT_ARTIST_LIMIT).map(({ artist, image, plays }) => ({ artist, image, plays })),
        },
      ];
    }),
  );

  const weekRows = between(rows, week.start);
  const pairs = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = ownRows(members[i].id, recentRows);
      const b = ownRows(members[j].id, recentRows);
      if (!a.length || !b.length) continue;
      const hours = (id) => new Map(stats[id].byHour30.map((minutes, hour) => [hour, minutes]));
      pairs.push({
        a: members[i].id,
        b: members[j].id,
        ...compareTaste(a, b),
        hourScore: Math.round(cosineSimilarity(hours(members[i].id), hours(members[j].id)) * 100),
      });
    }
  }

  return {
    members: stats,
    activity: rows.slice(0, ACTIVITY_LIMIT).map((row) => ({
      memberId: row.member_id,
      track: row.track,
      artist: row.artist,
      image: row.image,
      playedAt: row.played_at,
    })),
    groupTop: {
      tracks: withListeners(
        topTracks(weekRows, GROUP_TOP_LIMIT),
        weekRows,
        (row) => trackKey(row.artist, row.track),
        (item) => trackKey(item.artist, item.track),
      ),
      artists: withListeners(
        topArtists(weekRows, GROUP_TOP_LIMIT),
        weekRows,
        (row) => artistKey(row.artist),
        (item) => artistKey(item.artist),
      ),
    },
    pairs,
  };
}
