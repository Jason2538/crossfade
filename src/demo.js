import { addMember, insertScrobbles, markSynced, resetDb, saveTrackLength, setNowPlaying } from './db.js';

// 데모 화면용 가상의 친구와 아티스트입니다. 실제 인물이나 곡이 아닙니다.
const CATALOG = {
  '새벽 라디오': ['가로등 아래', '마지막 버스', '창문을 열면', '느린 답장'],
  'Neon Harbor': ['Tidal Lights', 'Static Bloom', 'Harbor Run', 'After Midnight Ferry'],
  '파란 코트': ['겨울 정류장', '두 번째 계절', '손끝의 온도'],
  'Paper Kites Club': ['Slow Orbit', 'Cardboard Sun', 'Weekend Atlas'],
  '달빛 공장': ['야간 근무', '은색 컨베이어', '퇴근길 교향곡'],
  'Mono Lake': ['Glass Water', 'Quiet Engine', 'Salt Flats'],
  '여름방학 밴드': ['운동장 끝', '소나기 신호', '자전거 도둑'],
  'Violet Motel': ['Room 204', 'Vacancy Sign', 'Checkout Time'],
};

const FRIENDS = [
  { name: '민지', service: 'spotify', daily: 34, taste: { '새벽 라디오': 6, 'Neon Harbor': 5, '파란 코트': 3, 'Violet Motel': 2 } },
  { name: '준호', service: 'apple', daily: 26, taste: { 'Neon Harbor': 6, '달빛 공장': 4, 'Mono Lake': 3, '새벽 라디오': 2 } },
  { name: '서연', service: 'spotify', daily: 19, taste: { 'Paper Kites Club': 6, '여름방학 밴드': 4, '파란 코트': 3 } },
  { name: '도윤', service: 'apple', daily: 15, taste: { '달빛 공장': 5, 'Mono Lake': 5, 'Violet Motel': 3 } },
  { name: '하린', service: 'apple', daily: 11, taste: { '새벽 라디오': 5, '파란 코트': 5, 'Paper Kites Club': 3 } },
];

const HISTORY_DAYS = 36;

export function seedDemo(db, now) {
  resetDb(db);
  const random = createRandom(20261106);

  for (const [artist, tracks] of Object.entries(CATALOG)) {
    for (const track of tracks) saveTrackLength(db, artist, track, 150 + Math.floor(random() * 130));
  }

  FRIENDS.forEach((friend, index) => {
    const id = addMember(db, {
      name: friend.name,
      lastfmUser: `demo_${index + 1}`,
      service: friend.service,
      joinedAt: now - HISTORY_DAYS * 86400,
    });

    const pool = Object.entries(friend.taste).flatMap(([artist, weight]) =>
      CATALOG[artist].flatMap((track, rank) => Array(Math.max(1, weight - rank)).fill({ artist, track })),
    );

    const scrobbles = [];
    for (let day = 0; day < HISTORY_DAYS; day += 1) {
      const plays = Math.round(friend.daily * (0.4 + random() * 1.2));
      for (let i = 0; i < plays; i += 1) {
        const { artist, track } = pool[Math.floor(random() * pool.length)];
        const playedAt = now - day * 86400 - Math.floor(random() * 86400);
        if (playedAt < now) scrobbles.push({ artist, track, album: '', image: '', playedAt });
      }
    }
    insertScrobbles(db, id, scrobbles);
    markSynced(db, id, now);

    if (index % 2 === 0) {
      const { artist, track } = pool[Math.floor(random() * pool.length)];
      setNowPlaying(db, id, { artist, track, album: '', image: '' }, now);
    }
  });
}

function createRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
