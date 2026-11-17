// 안드로이드 앱(APK)에서 시작한 Spotify 로그인은 휴대폰 기본 브라우저에서 진행됩니다.
// 로그인을 마친 브라우저가 이 주소로 돌아오면(state 가 "app." 으로 시작) 결과를 앱으로 넘깁니다.
// app.js 보다 먼저 실행되며, 주소창의 결과를 지워 이 브라우저에서는 로그인을 처리하지 않게 합니다.
(() => {
  const params = new URLSearchParams(location.search);
  const state = params.get('state') ?? '';
  if (!state.startsWith('app.') || !(params.has('code') || params.has('error'))) return;
  if (/CrossfadeApp\//.test(navigator.userAgent)) return;

  const query = location.search;
  history.replaceState(null, '', location.pathname + location.hash);
  window.crossfadeHandoff = true;
  const target = /Android/i.test(navigator.userAgent)
    ? `intent://callback${query}#Intent;scheme=crossfade;package=io.github.jason2538.crossfade;end`
    : `crossfade://callback${query}`;

  const show = () => {
    const box = document.createElement('div');
    box.className = 'handoff';
    const card = document.createElement('div');
    card.className = 'card handoff-card';
    const title = document.createElement('h1');
    title.textContent = '로그인을 마쳤어요';
    const text = document.createElement('p');
    text.textContent = '크로스페이드 앱으로 돌아가는 중이에요. 앱이 열리지 않으면 아래 버튼을 눌러 주세요.';
    const button = document.createElement('a');
    button.className = 'btn primary';
    button.href = target;
    button.textContent = '앱으로 돌아가기';
    card.append(title, text, button);
    box.append(card);
    document.body.append(box);
  };
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
  // 버튼을 누르지 않아도 한 번 앱을 열어 봅니다(브라우저에 따라 막힐 수 있습니다).
  setTimeout(() => {
    location.href = target;
  }, 400);
})();
