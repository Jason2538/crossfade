// 하루 한 번 알림: 서비스 워커 등록, 푸시 구독, 설정 보관
const SETTINGS_KEY = 'crossfade.push';
const SETTINGS_CACHE = 'crossfade-settings';
const SETTINGS_URL = 'push-settings.json';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function savedPush() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return null;
  }
}

// 서비스 워커는 localStorage 를 읽지 못해서 캐시에도 같이 둡니다.
async function storeSettings(settings) {
  const cache = await caches.open(SETTINGS_CACHE);
  if (settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    await cache.put(SETTINGS_URL, new Response(JSON.stringify({ code: settings.code, memberId: settings.memberId })));
  } else {
    localStorage.removeItem(SETTINGS_KEY);
    await cache.delete(SETTINGS_URL);
  }
}

const keyBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

async function tellRelay(connect, body) {
  const response = await fetch(`${connect.relayUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('알림 설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

export async function enablePush(connect, { code, memberId, hour }) {
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('알림 권한이 꺼져 있어요. 브라우저나 기기 설정에서 알림을 허용해 주세요.');
  }
  const registration = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await (await fetch(`${connect.relayUrl}/push`)).json();
  if (!key) throw new Error('알림 서버가 아직 준비되지 않았어요.');
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await tellRelay(connect, { endpoint: subscription.endpoint, hour });
  await storeSettings({ code, memberId, hour });
}

export async function disablePush(connect) {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await tellRelay(connect, { endpoint: subscription.endpoint, remove: true }).catch(() => {});
    await subscription.unsubscribe();
  }
  await storeSettings(null);
}

export async function testPush() {
  const registration = await navigator.serviceWorker.ready;
  registration.active.postMessage('test');
}

// 그룹을 옮기면 알림도 새 그룹 기록을 따라가게 합니다.
export function syncPush(code) {
  const saved = savedPush();
  if (saved && saved.code !== code) storeSettings({ ...saved, code }).catch(() => {});
}
