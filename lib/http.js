// Utilidades HTTP compartidas por el router único.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, msg);
export const forbidden = (msg = 'No tenés permisos para esta acción') => new HttpError(403, msg);

const MAX_BODY = 6 * 1024 * 1024;

export async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  // En Vercel req.body ya viene parseado según el Content-Type.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body ? safeJson(req.body) : {};
    if (Buffer.isBuffer(req.body)) return safeJson(req.body.toString('utf8'));
    return req.body;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'El contenido supera el tamaño máximo permitido');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return safeJson(raw);
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    throw bad('El cuerpo de la solicitud no es JSON válido');
  }
}

export function send(res, status, data, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (data === undefined || data === null) return res.end();
  if (Buffer.isBuffer(data) || typeof data === 'string') return res.end(data);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function redirect(res, location, headers = {}) {
  send(res, 302, null, { Location: location, ...headers });
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure = true, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

/** Router simple por patrón: '/tickets/:num/messages'. */
export class Router {
  constructor() {
    this.routes = [];
  }
  on(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern
          .replace(/\//g, '\\/')
          .replace(/:(\w+)/g, (_, k) => {
            keys.push(k);
            return '([^\\/]+)';
          }) +
        '\\/?$',
    );
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }
  get(p, h, o) { return this.on('GET', p, h, o); }
  post(p, h, o) { return this.on('POST', p, h, o); }
  patch(p, h, o) { return this.on('PATCH', p, h, o); }
  put(p, h, o) { return this.on('PUT', p, h, o); }
  del(p, h, o) { return this.on('DELETE', p, h, o); }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export const int = (v, def = null) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

export const str = (v, max = 10000) => (v === undefined || v === null ? '' : String(v).slice(0, max));

export const isEmail = (s) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s || '').trim());
