// 서버가 없는 사이트와 수집기 사이에서 암호화된 Spotify 로그인을 잠시 보관합니다.
// 브라우저가 수집기 공개 키로 암호화해 보내므로 이 Worker는 토큰을 읽을 수 없습니다.
const MAX_BODY_BYTES = 16_000;
const TTL_SECONDS = 3 * 86400;
const PREFIX = 'login:';

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const hasKey = (request, key) => Boolean(key) && request.headers.get('Authorization') === `Bearer ${key}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/logins' && request.method === 'POST') {
      if (!hasKey(request, env.WRITE_KEY)) return json({ error: 'unauthorized' }, 401, cors);
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413, cors);
      let sealed;
      try {
        ({ sealed } = JSON.parse(raw));
      } catch {
        sealed = null;
      }
      if (!sealed?.key || !sealed?.iv || !sealed?.data) return json({ error: 'bad request' }, 400, cors);
      await env.LOGINS.put(`${PREFIX}${crypto.randomUUID()}`, JSON.stringify(sealed), { expirationTtl: TTL_SECONDS });
      return json({ queued: true }, 200, cors);
    }

    if (!hasKey(request, env.READ_KEY)) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/logins' && request.method === 'GET') {
      const { keys } = await env.LOGINS.list({ prefix: PREFIX });
      const logins = await Promise.all(
        keys.map(async ({ name }) => ({ id: name.slice(PREFIX.length), sealed: JSON.parse(await env.LOGINS.get(name)) })),
      );
      return json({ logins: logins.filter((login) => login.sealed) }, 200);
    }

    const id = url.pathname.match(/^\/logins\/([\w-]+)$/)?.[1];
    if (id && request.method === 'DELETE') {
      await env.LOGINS.delete(`${PREFIX}${id}`);
      return json({ removed: true }, 200);
    }
    return json({ error: 'not found' }, 404);
  },
};
