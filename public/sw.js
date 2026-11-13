// 하루 한 번 오는 알림을 만듭니다. 서버는 내용 없이 깨우기만 하고, 기록은 이 기기에서 풉니다.
const SETTINGS_CACHE = 'crossfade-settings';
const SETTINGS_URL = 'push-settings.json';
// public/snapshot.js 와 같은 형식입니다: salt | iv | 암호문과 인증 태그
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

async function groupFileId(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`crossfade-group-v1:${code}`));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

async function openSnapshot(sealed, code) {
  const salt = sealed.slice(0, SALT_BYTES);
  const iv = sealed.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed.slice(SALT_BYTES + IV_BYTES));
  return JSON.parse(new TextDecoder().decode(plain));
}

function hoursText(minutes) {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}

// 오전에 받는 알림은 어제 하루를, 오후에 받는 알림은 오늘 지금까지를 알려 줍니다.
function dailyMessage(snapshot, memberId, hour) {
  const key = hour < 12 ? 'yesterday' : 'today';
  const day = hour < 12 ? '어제' : '오늘';
  const members = snapshot.social?.members ?? {};
  const total = Object.values(members).reduce((sum, member) => sum + (member[key]?.minutes ?? 0), 0);
  const mine = members[memberId]?.[key];
  const lines = [];
  if (mine) lines.push(`나는 ${day} ${mine.plays}번, ${hoursText(mine.minutes)} 들었어요.`);
  lines.push(`우리는 ${day} 모두 ${total.toLocaleString('ko-KR')}분 들었어요.`);
  return { title: `크로스페이드 · ${day}의 기록`, body: lines.join('\n') };
}

async function showDaily() {
  let message = { title: '크로스페이드', body: '오늘의 기록을 확인해 보세요.' };
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const settings = await (await cache.match(SETTINGS_URL)).json();
    const response = await fetch(`groups/${await groupFileId(settings.code)}.enc?t=${Date.now()}`, { cache: 'no-store' });
    const snapshot = await openSnapshot(new Uint8Array(await response.arrayBuffer()), settings.code);
    message = dailyMessage(snapshot, settings.memberId, new Date().getHours());
  } catch {
    // 기록을 못 읽어도 알림은 보여 줍니다. 푸시를 받고 아무것도 안 보이면 브라우저가 구독을 끊을 수 있습니다.
  }
  await self.registration.showNotification(message.title, {
    body: message.body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'crossfade-daily',
  });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => event.waitUntil(showDaily()));
self.addEventListener('message', (event) => {
  if (event.data === 'test') event.waitUntil(showDaily());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(self.registration.scope));
});
