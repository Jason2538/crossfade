import {
  getSpotifyAccount,
  insertScrobbles,
  latestPlayedAt,
  listMembers,
  markSynced,
  saveSpotifyAccount,
  saveTrackLength,
  setNowPlaying,
  tracksMissingLength,
} from './db.js';
import { ERROR_INVALID_KEY, ERROR_PRIVATE, ERROR_RATE_LIMIT } from './lastfm.js';
import { nowSeconds, weekRange } from './time.js';

const HISTORY_WEEKS = 8;
const MAX_PAGES = 50;
const LOOP_MS = 60_000;
const DURATION_BATCH = 100;
const REQUEST_GAP_MS = 220;
const TOKEN_MARGIN_SECONDS = 60;

// 아이폰 스크로블 앱은 기록을 모아서 늦게 올리기도 합니다.
// 최신 기록 이후만 받으면 이런 곡을 놓치므로 하루를 겹쳐서 받습니다.
const LATE_SCROBBLE_SECONDS = 86400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function syncMember(db, client, member, { tzOffsetMinutes, gapMs = REQUEST_GAP_MS }) {
  const now = nowSeconds();
  const latest = latestPlayedAt(db, member.id);
  const from = latest ? latest - LATE_SCROBBLE_SECONDS : weekRange(HISTORY_WEEKS, now, tzOffsetMinutes).start;

  try {
    let page = 1;
    let totalPages = 1;
    do {
      const result = await client.getRecentTracks({ user: member.lastfm_user, from, page });
      if (page === 1) setNowPlaying(db, member.id, result.nowPlaying, now);
      insertScrobbles(db, member.id, result.scrobbles);
      totalPages = Math.min(result.totalPages, MAX_PAGES);
      page += 1;
      if (page <= totalPages) await sleep(gapMs);
    } while (page <= totalPages);
    markSynced(db, member.id, now);
  } catch (error) {
    markSynced(db, member.id, now, describeError(error));
    if (error.code === ERROR_RATE_LIMIT) throw error;
  }
}

// Spotify는 최근 재생 50곡만 주지만 1분마다 받으므로 빠지는 곡은 거의 없습니다. 중복은 DB가 걸러 줍니다.
export async function syncSpotifyMember(db, spotify, member, account) {
  const now = nowSeconds();
  try {
    const token = await freshAccessToken(db, spotify, account, now);
    const playing = await spotify.getCurrentlyPlaying(token);
    const recent = await spotify.getRecentlyPlayed(token);
    setNowPlaying(db, member.id, playing, now);
    insertScrobbles(db, member.id, recent);
    for (const { artist, track, durationSec } of recent) {
      if (durationSec) saveTrackLength(db, artist, track, durationSec);
    }
    markSynced(db, member.id, now);
  } catch (error) {
    markSynced(db, member.id, now, describeSpotifyError(error));
  }
}

async function freshAccessToken(db, spotify, account, now) {
  if (account.expires_at - TOKEN_MARGIN_SECONDS > now) return account.access_token;
  const tokens = await spotify.refresh(account.refresh_token);
  saveSpotifyAccount(db, {
    memberId: account.member_id,
    spotifyId: account.spotify_id,
    accessToken: tokens.accessToken,
    // 새 refresh token은 응답에 없을 수도 있으며, 그때는 기존 값을 계속 씁니다.
    refreshToken: tokens.refreshToken ?? account.refresh_token,
    expiresAt: now + tokens.expiresIn,
  });
  return tokens.accessToken;
}

export async function fillTrackLengths(db, client, { limit = DURATION_BATCH, gapMs = REQUEST_GAP_MS } = {}) {
  for (const { artist, track } of tracksMissingLength(db, limit)) {
    saveTrackLength(db, artist, track, await client.getTrackDuration(artist, track));
    await sleep(gapMs);
  }
}

export async function syncAll(db, client, options) {
  for (const member of listMembers(db)) {
    const account = getSpotifyAccount(db, member.id);
    if (!account) await syncMember(db, client, member, options);
    else if (options.spotify) await syncSpotifyMember(db, options.spotify, member, account);
    await sleep(options.gapMs ?? REQUEST_GAP_MS);
  }
  await fillTrackLengths(db, client, options);
}

export function startSyncLoop(db, client, options) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncAll(db, client, options);
    } catch (error) {
      console.error('동기화 실패:', error.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, LOOP_MS);
}

function describeSpotifyError(error) {
  if (error.status === 400 || error.status === 401) return 'Spotify 로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (error.status === 403) return `Spotify가 요청을 거절했습니다: ${error.message}`;
  if (error.status === 429) return 'Spotify 요청 한도를 넘어 잠시 뒤 다시 시도합니다.';
  return error.message || '알 수 없는 오류';
}

function describeError(error) {
  if (error.code === ERROR_PRIVATE) return 'Last.fm 청취 기록이 비공개로 설정되어 있습니다.';
  if (error.code === ERROR_INVALID_KEY) return '서버의 Last.fm API 키가 올바르지 않습니다.';
  return error.message || '알 수 없는 오류';
}
