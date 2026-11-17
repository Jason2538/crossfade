import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const BRIDGE = readFileSync(new URL('../tools/luma-crossfade.js', import.meta.url), 'utf8');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loadBridge(friends) {
  const boxes = { vFri: { innerHTML: '' }, liveStrip: { innerHTML: '', hidden: true, dataset: {} } };
  const context = vm.createContext({
    window: { parent: { crossfadeFriends: () => friends } },
    document: { addEventListener() {}, hidden: false },
    setInterval() {},
    $: (id) => boxes[id],
    esc,
    tok: null,
    me: null,
    curView: 'fri',
    toast() {},
  });
  // Luma 안에서는 함수 선언이 바깥에서 보이므로 같은 방식으로 꺼냅니다.
  vm.runInContext(`${BRIDGE}\nthis.cfRenderFri = cfRenderFri; this.cfRenderStrip = cfRenderStrip;`, context);
  // window.parent 가 window 와 달라야 크로스페이드 안으로 봅니다.
  context.window.parent.crossfadeFriends = () => friends;
  return { context, boxes };
}

const FRIENDS = {
  members: [
    { id: 1, name: '민지', nowPlaying: { track: '느린 답장', artist: '새벽 <라디오>', image: '' }, weekMinutes: 218, todayMinutes: 124, streak: 3 },
    { id: 2, name: '준호', nowPlaying: null, weekMinutes: 192, todayMinutes: 69, streak: 0 },
  ],
  activity: [{ memberId: 2, track: 'Static Bloom', artist: 'Neon Harbor', image: '', playedAt: Math.floor(Date.now() / 1000) - 120 }],
  topTracks: [{ track: 'Tidal Lights', artist: 'Sea', image: '', plays: 7 }],
};

test('Luma 친구 탭은 크로스페이드 기록으로 지금 듣는 곡, 오늘 순위, 많이 들은 곡, 최근 활동을 보여 준다', () => {
  const { context, boxes } = loadBridge(FRIENDS);
  context.cfRenderFri();
  const html = boxes.vFri.innerHTML;
  assert.match(html, /민지 님이 듣는 중/);
  assert.match(html, /새벽 &lt;라디오&gt;/, '이름은 이스케이프한다');
  assert.ok(html.indexOf('민지') < html.indexOf('준호'), '오늘 많이 들은 순서');
  assert.match(html, /오늘 2시간 4분 · 이번 주 3시간 38분/);
  assert.match(html, /Tidal Lights[\s\S]*7회/);
  assert.match(html, /Static Bloom[\s\S]*준호 · 2분 전/);
  assert.equal((html.match(/data-cfplay/g) ?? []).length, 3, '곡마다 누르면 재생');
});

test('홈의 "친구가 지금 듣는 중"에는 듣고 있는 친구만 나온다', () => {
  const { context, boxes } = loadBridge(FRIENDS);
  context.cfRenderStrip();
  assert.equal(boxes.liveStrip.hidden, false);
  assert.equal((boxes.liveStrip.innerHTML.match(/class="lsC"/g) ?? []).length, 1);
  assert.match(boxes.liveStrip.innerHTML, /같이 듣기/);
});
