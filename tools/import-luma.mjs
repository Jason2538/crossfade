// Luma(https://github.com/Jason2538/luma)의 index.html 을 크로스페이드 안의 Luma 탭으로 가져옵니다.
// 사용법: node tools/import-luma.mjs <luma 저장소의 index.html> [Spotify Client ID]
// Luma가 바뀌면 다시 실행하면 됩니다. 바꿀 곳을 못 찾으면 멈추므로 조용히 깨지지 않습니다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [source, clientId = '06b050ce121e47328a9c49319c0bc604'] = process.argv.slice(2);
if (!source) {
  console.error('사용법: node tools/import-luma.mjs <luma/index.html> [Spotify Client ID]');
  process.exit(1);
}

// 친구 탭을 크로스페이드 기록으로 채우는 코드와 그 모양입니다.
const BRIDGE = readFileSync(join(ROOT, 'tools', 'luma-crossfade.js'), 'utf8');
const BRIDGE_STYLE = `
/* ---------- 크로스페이드 친구 (tools/luma-crossfade.js) ---------- */
.cfNote{color:var(--dim);font-size:13.5px;margin:4px 0 18px}
.cfList{display:flex;flex-direction:column;gap:6px;margin-bottom:22px}
.cfSong{display:flex;align-items:center;gap:12px;width:100%;padding:8px 10px;border-radius:12px;text-align:left;transition:background .25s}
.cfSong:hover{background:rgba(255,255,255,.06)}.cfSong:active{scale:.99}
.cfSong img,.cfSong .ph{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:var(--faint)}
.cfSong .m,.cfFr .m{min-width:0;flex:1;display:flex;flex-direction:column}
.cfSong b,.cfFr b{font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfSong small,.cfFr small{color:var(--dim);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfSong .go{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--spot);color:#000;font-size:11px}
.cfRank{display:flex;flex-direction:column;gap:4px;margin-bottom:22px;padding:6px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid var(--faint)}
.cfFr{display:flex;align-items:center;gap:12px;padding:8px 10px}
.cfFr .no{width:18px;text-align:center;color:var(--dim);font-weight:700}
.cfAva{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#0a84ff,#bf5af2 55%,#ff9f0a);color:#fff;font-weight:700}
.cfAva.sm{width:28px;height:28px;font-size:12px}
.cfMore{display:block;margin:6px auto 30px}
`;

// [바꿀 내용, 새 내용, 나와야 하는 횟수]
const PATCHES = [
  // 친구 탭과 홈의 "친구가 지금 듣는 중"은 Firebase 대신 크로스페이드 기록을 씁니다.
  ['/* ---------- 화면 ---------- */\nfunction openFri(){\n', `${BRIDGE}\n/* ---------- 화면 ---------- */\nfunction openFri(){\n  if (CF.inside) { detail = null; showView('fri'); window.scrollTo({ top: 0 }); CF.html = ''; cfRenderFri(); return; }\n`, 1],
  ['function renderFri(quiet){\n', 'function renderFri(quiet){\n  if (CF.inside) return cfRenderFri();\n', 1],
  ['function renderLiveStrip(){\n', 'function renderLiveStrip(){\n  if (CF.inside) return cfRenderStrip();\n', 1],
  ['</style>', `${BRIDGE_STYLE}</style>`, 1],
  // 크로스페이드에서 다른 탭을 보고 있으면(화면이 숨겨져 있으면) Spotify에 재생 상태를 묻지 않습니다.
  // 세 앱이 같은 Spotify 앱 한도를 나눠 쓰기 때문입니다.
  [
    'setInterval(() => { if (!tok || S.web || document.hidden) return;',
    'setInterval(() => { if (!tok || S.web || document.hidden || cfAway() || Date.now() < cfRateUntil) return;',
    1,
  ],
  // 재생 상태 확인을 2.5초에서 5초로(멈춰 있으면 10초) 늘립니다.
  ['pollRemote(); }, 2500);', 'pollRemote(); }, 5000);', 1],
  // 시작할 때 Spotify가 막으면(429) 오류만 띄우지 않고, 막힌 시간이 지나면 저절로 다시 연결합니다.
  [
    "    toast('Spotify에 연결하지 못했어요: ' + e.message);",
    "    if (e.status === 429) { const wait = Math.max(30000, cfRateUntil - Date.now()); toast('Spotify 요청이 많아 잠시 막혔어요. ' + Math.ceil(wait / 60000) + '분 안에 저절로 다시 연결할게요', 8000); setTimeout(() => location.reload(), wait); return; }\n    toast('Spotify에 연결하지 못했어요: ' + e.message);",
    1,
  ],
  // Spotify가 "요청이 너무 많다"(429)고 하면 알려 준 시간까지 주기적 확인을 쉽니다.
  [
    "  if (r.status === 429 && retry) { await sleep(",
    "  if (r.status === 429) cfRateUntil = Date.now() + (+r.headers.get('Retry-After') || 5) * 1000;\n  if (r.status === 429 && retry) { await sleep(",
    1,
  ],
  // 친구들이 이미 크로스페이드 앱 사용자로 등록되어 있으므로 같은 Spotify 앱을 씁니다.
  [/CLIENT_ID: '[0-9a-f]{32}'/g, `CLIENT_ID: '${clientId}'`, 1],
  // 같은 주소(jason2538.github.io)의 원래 Luma와 저장 값이 섞이지 않게 이름을 바꿉니다.
  [/'luma_/g, "'cfluma_", null],
  // Spotify에 등록된 돌아올 주소는 크로스페이드 첫 화면입니다. 크로스페이드가 결과를 이 화면으로 넘겨 줍니다.
  [
    "const redirectUri = () => location.origin + location.pathname.replace(/index\\.html$/, '');",
    "const redirectUri = () => location.origin + location.pathname.replace(/luma\\/(index\\.html)?$/, '');",
    1,
  ],
  // Spotify 로그인 화면은 다른 화면 안에서 열 수 없어서 바깥 창을 이동합니다.
  ["  location.href = AUTH_URL + '?' + p;", "  window.top.location.href = AUTH_URL + '?' + p;", 1],
  ["  location.href = AUTH_URL + '?' + new URLSearchParams(", "  window.top.location.href = AUTH_URL + '?' + new URLSearchParams(", 1],
  // 로그인 결과를 처리한 뒤나 로그아웃할 때는 크로스페이드가 아니라 Luma 화면에 머뭅니다.
  ["  history.replaceState(null, '', redirectUri());\n  if ((st", "  history.replaceState(null, '', location.pathname);\n  if ((st", 1],
  ["setTimeout(() => { location.href = redirectUri(); }, 2200);", 'setTimeout(() => { location.href = location.pathname; }, 2200);', 1],
  ["  location.href = redirectUri();\n}", '  location.href = location.pathname;\n}', 1],
  // 크로스페이드 밖에서 바로 열면 위쪽 메뉴가 있는 크로스페이드로 보냅니다.
  [
    '<script>\n/* =====',
    "<script>\nif (window.top === window) location.replace('../#/luma');\n</script>\n<script>\n/* =====",
    1,
  ],
];

let html = readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
for (const [from, to, expected] of PATCHES) {
  const count = typeof from === 'string' ? html.split(from).length - 1 : (html.match(from) ?? []).length;
  if (expected === null ? count === 0 : count !== expected) {
    console.error(`바꿀 곳을 찾지 못했어요 (${count}번 나옴): ${String(from).slice(0, 80)}`);
    process.exit(1);
  }
  html = typeof from === 'string' ? html.split(from).join(to) : html.replace(from, to);
}

const target = join(ROOT, 'public', 'luma', 'index.html');
mkdirSync(dirname(target), { recursive: true });
const NOTE = '<!-- tools/import-luma.mjs 로 만든 파일입니다. 직접 고치지 말고 Luma를 고친 뒤 다시 가져오세요. -->';
writeFileSync(target, html.replace('<!DOCTYPE html>\n', `<!DOCTYPE html>\n${NOTE}\n`));
console.log(`Luma를 가져왔어요: ${target}`);
