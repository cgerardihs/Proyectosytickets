import { Readable } from 'node:stream';

process.env.PGLITE = 'memory';
process.env.LOG_SILENT = '1';
process.env.INBOUND_SECRET = 'secreto-de-prueba';
process.env.CRON_SECRET = 'cron-de-prueba';

const { default: handler } = await import('../api/router.js');

export function makeClient() {
  let cookie = '';
  async function call(method, path, body, extraHeaders = {}) {
    const json = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(json ? [Buffer.from(json)] : []);
    req.method = method;
    req.url = `/api${path}`;
    req.headers = { 'content-type': 'application/json', host: 'localhost:3000', ...(cookie ? { cookie } : {}), ...extraHeaders };
    const headers = {};
    let resolveEnd;
    const done = new Promise((r) => (resolveEnd = r));
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      end(data) { this.headersSent = true; resolveEnd(data); },
    };
    await handler(req, res);
    const data = await done;
    if (headers['set-cookie']) {
      // Frasco de cookies: se guardan todas (sesión y dispositivo) por nombre
      const jar = new Map(cookie ? cookie.split('; ').map((c) => [c.split('=')[0], c]) : []);
      for (const c of [].concat(headers['set-cookie'])) { const kv = String(c).split(';')[0]; jar.set(kv.split('=')[0], kv); }
      cookie = [...jar.values()].join('; ');
    }
    let parsed = data;
    if (typeof data === 'string' && String(headers['content-type'] || '').includes('json')) parsed = JSON.parse(data);
    return { status: res.statusCode, data: parsed, headers };
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    del: (p) => call('DELETE', p),
    setCookie: (c) => (cookie = c),
    getCookie: () => cookie,
  };
}
