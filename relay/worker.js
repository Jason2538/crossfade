// 서버가 없는 사이트와 수집기 사이의 대기열입니다. 그룹 만들기, 친구 추가, Spotify 로그인을 보관합니다.
// 브라우저가 수집기 공개 키로 암호화해 보내므로 이 Worker는 내용을 읽을 수 없습니다.
// 아무나 그룹을 만들 수 있어야 하므로 쓰기에는 키가 없고, 주소별 횟수로 제한합니다.
const MAX_BODY_BYTES = 16_000;
const TTL_SECONDS = 3 * 86400;
const DAILY_LIMIT = 30;
const ITEM_PREFIX = 'item:';
const RATE_PREFIX = 'rate:';

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const hasKey = (request, key) => Boolean(key) && request.headers.get('Authorization') === `Bearer ${key}`;

// 주소를 그대로 저장하지 않으려고 해시만 남깁니다.
async function isOverLimit(request, env) {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `${RATE_PREFIX}${new Date().toISOString().slice(0, 10)}:${hash}`;
  const count = Number(await env.LOGINS.get(key)) || 0;
  if (count >= DAILY_LIMIT) return true;
  await env.LOGINS.put(key, String(count + 1), { expirationTtl: 2 * 86400 });
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/queue' && request.method === 'POST') {
      if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403, cors);
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413, cors);
      let sealed;
      try {
        ({ sealed } = JSON.parse(raw));
      } catch {
        sealed = null;
      }
      if (!sealed?.key || !sealed?.iv || !sealed?.data) return json({ error: 'bad request' }, 400, cors);
      if (await isOverLimit(request, env)) return json({ error: 'too many requests' }, 429, cors);
      await env.LOGINS.put(`${ITEM_PREFIX}${crypto.randomUUID()}`, JSON.stringify(sealed), { expirationTtl: TTL_SECONDS });
      return json({ queued: true }, 200, cors);
    }

    if (!hasKey(request, env.READ_KEY)) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/queue' && request.method === 'GET') {
      const { keys } = await env.LOGINS.list({ prefix: ITEM_PREFIX });
      const items = await Promise.all(
        keys.map(async ({ name }) => ({ id: name.slice(ITEM_PREFIX.length), raw: await env.LOGINS.get(name) })),
      );
      return json(
        { items: items.filter((item) => item.raw).map(({ id, raw }) => ({ id, sealed: JSON.parse(raw) })) },
        200,
      );
    }

    const id = url.pathname.match(/^\/queue\/([\w-]+)$/)?.[1];
    if (id && request.method === 'DELETE') {
      await env.LOGINS.delete(`${ITEM_PREFIX}${id}`);
      return json({ removed: true }, 200);
    }
    return json({ error: 'not found' }, 404);
  },
};
