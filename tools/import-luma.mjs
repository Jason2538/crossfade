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

// [바꿀 내용, 새 내용, 나와야 하는 횟수]
const PATCHES = [
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
