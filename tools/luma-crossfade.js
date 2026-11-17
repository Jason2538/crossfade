/* ---------- 크로스페이드 친구 ----------
   tools/import-luma.mjs 가 Luma 안에 넣는 코드입니다. 크로스페이드 안에서 열렸을 때
   친구 탭과 홈의 "친구가 지금 듣는 중"을 Firebase 대신 크로스페이드 그룹 기록으로 채우고,
   곡을 누르면 내 Spotify 계정으로 찾아서 틀어요. */
const CF = {
  inside: window.parent !== window,
  html: '',
  data(){
    try { return this.inside && window.parent.crossfadeFriends ? window.parent.crossfadeFriends() : null; } catch { return null; }
  }
};
// 크로스페이드에서 다른 탭을 보고 있는지(이 화면이 숨겨져 있는지)
const cfAway = () => {
  try { return CF.inside && Boolean(window.frameElement && !window.frameElement.getClientRects().length); } catch { return false; }
};
let cfRateUntil = 0;
const cfAgo = s => {
  if (!s) return '';
  const m = Math.floor((Date.now() / 1000 - s) / 60);
  return m < 1 ? '방금' : m < 60 ? m + '분 전' : m < 1440 ? Math.floor(m / 60) + '시간 전' : Math.floor(m / 1440) + '일 전';
};
const cfMin = m => m >= 60 ? Math.floor(m / 60) + '시간 ' + (m % 60) + '분' : m + '분';
const cfInitial = name => esc(String(name || '?').trim().charAt(0).toUpperCase());
const cfHead = '<header class="spHead"><p class="spKicker fk"><i></i>크로스페이드 친구</p><h1>친구</h1></header>';
function cfSong(song, sub){
  return `<button class="cfSong" data-cfplay="1" data-ar="${esc(song.artist)}" data-tr="${esc(song.track)}">` +
    (song.image ? `<img src="${esc(song.image)}" alt="" loading="lazy">` : '<div class="ph"></div>') +
    `<span class="m"><b>${esc(song.track)}</b><small>${esc(song.artist)}${sub ? ' · ' + esc(sub) : ''}</small></span>` +
    '<span class="go" aria-hidden="true">▶</span></button>';
}
function cfFriHTML(d){
  const names = new Map(d.members.map(m => [m.id, m.name]));
  const live = d.members.filter(m => m.nowPlaying);
  const ranked = [...d.members].sort((a, b) => b.todayMinutes - a.todayMinutes || b.weekMinutes - a.weekMinutes);
  let h = cfHead + '<p class="cfNote">크로스페이드 그룹의 기록을 실시간으로 보여 줘요. 곡을 누르면 내 Spotify로 재생해요.</p>';
  h += '<h2 class="sec">지금 듣는 중</h2>';
  h += live.length
    ? '<div class="cfList">' + live.map(m => cfSong(m.nowPlaying, m.name + ' 님이 듣는 중')).join('') + '</div>'
    : '<div class="fEmpty sm">지금 듣고 있는 친구가 없어요</div>';
  h += '<h2 class="sec">오늘 순위</h2><div class="cfRank">' + ranked.map((m, i) =>
    `<div class="cfFr"><span class="no">${i + 1}</span><span class="cfAva">${cfInitial(m.name)}</span>` +
    `<span class="m"><b>${esc(m.name)}${m.streak > 1 ? ` <small>🔥${m.streak}일</small>` : ''}</b>` +
    `<small>오늘 ${cfMin(m.todayMinutes)} · 이번 주 ${cfMin(m.weekMinutes)}</small></span></div>`).join('') + '</div>';
  if (d.topTracks.length) {
    h += '<h2 class="sec">이번 주 우리가 많이 들은 곡</h2><div class="cfList">' + d.topTracks.map(t => cfSong(t, t.plays + '회')).join('') + '</div>';
  }
  h += '<h2 class="sec">최근 활동</h2>';
  h += d.activity.length
    ? '<div class="cfList">' + d.activity.slice(0, 20).map(a => cfSong(a, (names.get(a.memberId) || '나간 친구') + ' · ' + cfAgo(a.playedAt))).join('') + '</div>'
    : '<div class="fEmpty sm">아직 기록이 없어요</div>';
  return h + '<button class="pill cfMore" data-cfhome="1">크로스페이드에서 자세히 보기</button>';
}
function cfRenderFri(){
  const box = $('vFri'); if (!box) return;
  const d = CF.data();
  const h = d ? cfFriHTML(d) : cfHead + '<div class="fEmpty">크로스페이드 그룹 기록을 불러오는 중이에요.<br>잠시 뒤 저절로 나타나요.</div>';
  if (h !== CF.html) { box.innerHTML = h; CF.html = h; }
}
function cfRenderStrip(){
  const box = $('liveStrip'); if (!box) return;
  const d = CF.data();
  const live = d ? d.members.filter(m => m.nowPlaying) : [];
  if (!live.length) { box.hidden = true; return; }
  const html = '<span class="lsH"><i class="eq"><i></i><i></i><i></i></i>친구가 지금 듣는 중</span>' + live.map(m =>
    `<button class="lsC" data-cfplay="1" data-ar="${esc(m.nowPlaying.artist)}" data-tr="${esc(m.nowPlaying.track)}">` +
    `<span class="cfAva sm">${cfInitial(m.name)}</span>${m.nowPlaying.image ? `<img src="${esc(m.nowPlaying.image)}" alt="">` : ''}` +
    `<span class="m"><b>${esc(m.name)}</b><small>${esc(m.nowPlaying.track)} · ${esc(m.nowPlaying.artist)}</small></span>` +
    '<span class="go">같이 듣기</span></button>').join('');
  if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; }
  box.hidden = false;
}
// 친구가 들은 곡은 이름만 알아서 Spotify에서 찾아 틀어요.
async function cfPlay(artist, track){
  if (!tok) { toast('먼저 Spotify로 로그인해 주세요'); return; }
  for (let i = 0; i < 50 && !me; i++) await sleep(200);
  const clean = s => String(s || '').replace(/["']/g, '');
  try {
    let j = await api('/search?' + new URLSearchParams({ q: `track:${clean(track)} artist:${clean(artist)}`, type: 'track', limit: 1 }));
    let t = j.tracks?.items?.[0];
    if (!t) {
      j = await api('/search?' + new URLSearchParams({ q: `${track} ${artist}`, type: 'track', limit: 1 }));
      t = j.tracks?.items?.[0];
    }
    if (!t) { toast('Spotify에서 이 곡을 찾지 못했어요'); return; }
    toast(`${t.name} 재생할게요`, 2000);
    playList([normTrack(t)], 0, '친구가 들은 곡');
  } catch (e) { toast('재생하지 못했어요: ' + e.message); }
}
if (CF.inside) {
  window.cfLumaPlay = cfPlay;
  document.addEventListener('click', e => {
    const song = e.target.closest('[data-cfplay]');
    if (song) { e.preventDefault(); e.stopPropagation(); cfPlay(song.dataset.ar, song.dataset.tr); return; }
    if (e.target.closest('[data-cfhome]')) { e.preventDefault(); window.parent.location.hash = '#/'; }
  }, true);
  setInterval(() => {
    if (document.hidden || !tok) return;
    cfRenderStrip();
    if (curView === 'fri') cfRenderFri();
  }, 5000);
}
