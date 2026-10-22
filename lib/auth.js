// Autenticación.
// - Claves: Argon2id (parámetros OWASP 2024: 19 MiB, 2 iteraciones). Las claves viejas (scrypt) se re-hashean solas al ingresar.
// - Sesiones del lado del servidor: identificador aleatorio de 256 bits en cookie __Host- (HttpOnly, Secure, SameSite=Lax);
//   en la base se guarda solo su SHA-256. Vencen por inactividad y por tiempo total, y se pueden revocar.
// - Tokens firmados (enlaces del portal, estado de OAuth): HMAC-SHA256 con una subclave derivada por HKDF.
import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { q, one } from './db.js';
import { getSetting } from './settings.js';
import { HttpError, parseCookies } from './http.js';
import { als } from './context.js';
import { clientIp } from './audit.js';
import { TooManyRequests } from './ratelimit.js';

// Argon2id usa 19 MiB por cálculo: se limitan los cálculos simultáneos por instancia para que una ráfaga
// de intentos de ingreso devuelva 429 en lugar de agotar la memoria de la función.
const ARGON_MAX = Number(process.env.ARGON_MAX_CONCURRENT || 4);
const ARGON_QUEUE = 32;
let argonActive = 0;
const argonWaiting = [];
async function argonSlot(fn) {
  if (argonActive < ARGON_MAX) {
    argonActive += 1;
  } else {
    if (argonWaiting.length >= ARGON_QUEUE) throw new TooManyRequests('Hay demasiados ingresos al mismo tiempo. Probá de nuevo en unos segundos.', 3);
    await new Promise((resolve) => argonWaiting.push(resolve)); // el lugar se entrega directo: nunca se pasa del máximo
  }
  try {
    return await fn();
  } finally {
    const next = argonWaiting.shift();
    if (next) next();
    else argonActive -= 1;
  }
}

/** Si el código nuevo llega antes que su migración (columna o tabla faltante), migra y reintenta una vez. */
async function withAutoMigrate(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
    const { migrate } = await import('./migrate.js');
    await migrate();
    return fn();
  }
}

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const SESSION_IDLE_HOURS = Number(process.env.SESSION_IDLE_HOURS || 12);
const COOKIE_SECURE = '__Host-hd_session';
const COOKIE_DEV = 'hd_session';

// ---------- Secretos ----------
function rootSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.PGLITE && !process.env.VERCEL) return 'dev-secret-solo-para-pruebas-locales-0000';
  throw new HttpError(503, 'Falta configurar SESSION_SECRET en Vercel (mínimo 32 caracteres aleatorios).');
}

const subkeys = new Map();
function subkey(purpose) {
  const root = rootSecret();
  const id = `${purpose}|${root.length}|${root.slice(0, 4)}`;
  if (!subkeys.has(id)) subkeys.set(id, Buffer.from(crypto.hkdfSync('sha256', root, 'hanseatica-desk', purpose, 32)));
  return subkeys.get(id);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

/** Firma un objeto con HMAC-SHA256 y vencimiento (segundos). */
export function signToken(payload, ttlSeconds) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = b64u(JSON.stringify(body));
  return `${data}.${hmac(subkey('token-v2'), data)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
  const [data, sig] = token.split('.');
  const given = Buffer.from(sig);
  // Solo la clave derivada actual (v1.9.6: se quitó la verificación con la clave anterior a la v1.5)
  const candidates = [hmac(subkey('token-v2'), data)];
  const ok = candidates.some((exp) => {
    const e = Buffer.from(exp);
    return e.length === given.length && crypto.timingSafeEqual(e, given);
  });
  if (!ok) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Date.now() / 1000 || body.k === 'session') return null;
    return body;
  } catch {
    return null;
  }
}

// ---------- Claves ----------
const ARGON = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 };

export async function hashPassword(pw) {
  return argonSlot(() => argon2id({ password: String(pw).normalize('NFKC'), salt: crypto.randomBytes(16), ...ARGON, outputType: 'encoded' }));
}

function checkScrypt(pw, stored) {
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64 || '', 'base64');
  if (!expected.length) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}

// Hash de referencia para que un usuario inexistente tarde lo mismo que uno real (evita enumerar cuentas por tiempo).
let dummyHash = null;

/** Verifica la clave. Devuelve { ok, rehash } (rehash = hay que actualizar a Argon2id). */
export async function verifyPassword(pw, stored) {
  const password = String(pw ?? '').slice(0, 256);
  if (!stored) {
    dummyHash = dummyHash || (await hashPassword('clave-de-referencia-para-tiempos'));
    await argonSlot(() => argon2Verify({ password, hash: dummyHash })).catch((e) => { if (e.status === 429) throw e; });
    return { ok: false, rehash: false };
  }
  if (stored.startsWith('$argon2id$')) {
    const ok = await argonSlot(() => argon2Verify({ password: password.normalize('NFKC'), hash: stored })).catch((e) => { if (e.status === 429) throw e; return false; });
    const params = /m=(\d+),t=(\d+)/.exec(stored);
    const weak = params && (Number(params[1]) < ARGON.memorySize || Number(params[2]) < ARGON.iterations);
    return { ok, rehash: ok && Boolean(weak) };
  }
  if (stored.startsWith('scrypt$')) {
    const ok = checkScrypt(password, stored);
    return { ok, rehash: ok };
  }
  return { ok: false, rehash: false };
}

// ---------- Sesiones ----------
const isSecure = (req) => {
  if (process.env.PGLITE && !process.env.VERCEL) return false;
  const proto = req.headers['x-forwarded-proto'];
  return proto ? String(proto).includes('https') : true;
};
const hashSessionId = (id) => crypto.createHash('sha256').update(id).digest('hex');

function buildCookie(req, value, maxAge) {
  const secure = isSecure(req);
  const name = secure ? COOKIE_SECURE : COOKIE_DEV;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAge}`;
}

// ---------- Cookie de dispositivo (OWASP "device cookies") ----------
// Un navegador donde el usuario ya ingresó bien queda marcado. El bloqueo general de la cuenta por intentos fallidos
// (que un atacante puede provocar desde muchas IPs) no afecta a ese navegador: así no pueden dejar afuera al dueño.
const DEVICE_SECURE = '__Host-hd_device';
const DEVICE_DEV = 'hd_device';
const DEVICE_DAYS = 180;
// La firma se ata a la clave actual (y a "cerrar todas las sesiones"): si se cambia la clave, los navegadores dejan de ser de confianza.
const deviceSig = (payload, binding) => crypto.createHmac('sha256', subkey('device-cookie')).update(`${payload}|${binding}`).digest('base64url').slice(0, 32);
/** Vínculo de la cookie de dispositivo: hash corto de la clave guardada (o de SUPERADMIN_PASSWORD) + época de sesiones. */
export async function deviceBinding(user) {
  const epoch = Number(await getSetting('session_epoch', 0).catch(() => 0)) || 0;
  const secret = user?.role === 'superadmin' ? superFingerprint() : String(user?.password_hash || '');
  return `${epoch}:${crypto.createHash('sha256').update(secret).digest('base64url').slice(0, 16)}`;
}
export function deviceCookie(req, userId, binding) {
  const payload = `${Number(userId)}.${crypto.randomBytes(12).toString('base64url')}`;
  const secure = isSecure(req);
  return `${secure ? DEVICE_SECURE : DEVICE_DEV}=${payload}.${deviceSig(payload, binding)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${DEVICE_DAYS * 86400}`;
}
/** true si el navegador tiene una cookie de dispositivo válida de ese usuario (con su clave actual). */
export function trustedDevice(req, userId, binding) {
  if (!userId || !binding) return false;
  const c = parseCookies(req);
  const v = String((isSecure(req) ? c[DEVICE_SECURE] : c[DEVICE_DEV]) || '');
  const m = /^(\d{1,10})\.([\w-]{16})\.([\w-]{32})$/.exec(v);
  if (!m || Number(m[1]) !== Number(userId)) return false;
  try {
    const a = Buffer.from(deviceSig(`${m[1]}.${m[2]}`, binding));
    const b = Buffer.from(m[3]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/** Crea una sesión nueva (id nuevo en cada ingreso: evita fijación de sesión). Devuelve el Set-Cookie. */
/** Huella de la clave del superadmin (HMAC): si se cambia SUPERADMIN_PASSWORD en Vercel, sus sesiones dejan de valer. */
export function superFingerprint() {
  return crypto.createHmac('sha256', subkey('superadmin-session')).update(String(process.env.SUPERADMIN_PASSWORD || '')).digest('base64url').slice(0, 22);
}

export async function createSession(req, userId, method = 'password') {
  const id = crypto.randomBytes(32).toString('base64url');
  await withAutoMigrate(() => q(`insert into sessions(id_hash,user_id,method,ip,user_agent,expires_at,fingerprint) values ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7)`, [
    hashSessionId(id), userId, method, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), SESSION_DAYS,
    method === 'superadmin' ? superFingerprint() : '',
  ]));
  // Limpieza oportunista de sesiones vencidas
  if (Math.random() < 0.05) await q(`delete from sessions where expires_at < now() or last_seen_at < now() - make_interval(hours => $1)`, [SESSION_IDLE_HOURS]).catch(() => {});
  return buildCookie(req, id, SESSION_DAYS * 86400);
}

function sessionIdFrom(req) {
  const c = parseCookies(req);
  // En producción solo vale la cookie __Host- (no la puede plantar un subdominio)
  const id = isSecure(req) ? c[COOKIE_SECURE] : c[COOKIE_DEV];
  return id && /^[\w-]{40,64}$/.test(id) ? id : null;
}

export function currentSessionHash(req) {
  const id = sessionIdFrom(req);
  return id ? hashSessionId(id) : '';
}

export async function destroySession(req) {
  const id = sessionIdFrom(req);
  if (id) await q('delete from sessions where id_hash=$1', [hashSessionId(id)]);
  return buildCookie(req, '', 0);
}

export function clearSessionCookie(req) {
  return buildCookie(req, '', 0);
}

/** Cierra todas las sesiones de un usuario salvo (opcionalmente) la actual. */
export async function revokeUserSessions(userId, req = null) {
  const keep = req ? sessionIdFrom(req) : null;
  const r = await q('delete from sessions where user_id=$1 and id_hash <> $2 returning 1', [userId, keep ? hashSessionId(keep) : '']);
  return r.length;
}

/** Devuelve el usuario logueado o null. */
export async function currentUser(req) {
  if (req._user !== undefined) return req._user;
  req._user = null;
  const id = sessionIdFrom(req);
  if (!id) return null;
  const row = await withAutoMigrate(() => one(
    `select s.id_hash, s.created_at as session_created, s.last_seen_at, s.method as session_method, s.fingerprint,
            u.id, u.name, u.email, u.role, u.active, u.color, u.signature_html, u.must_change_password, u.can_portfolio, u.can_manage_projects
     from sessions s join users u on u.id = s.user_id
     where s.id_hash = $1 and s.expires_at > now() and s.last_seen_at > now() - make_interval(hours => $2)`,
    [hashSessionId(id), SESSION_IDLE_HOURS],
  ));
  if (!row || !row.active) return null;
  // "Cerrar todas las sesiones" (superadmin)
  const epoch = Number(await getSetting('session_epoch', 0).catch(() => 0)) || 0;
  if (epoch && new Date(row.session_created).getTime() / 1000 < epoch) return null;
  // El superadmin solo existe mientras SUPERADMIN_PASSWORD esté definida en Vercel.
  if (row.role === 'superadmin' && (!superadminEnabled() || row.fingerprint !== superFingerprint())) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60000) {
    await q('update sessions set last_seen_at=now() where id_hash=$1', [row.id_hash]).catch(() => {});
  }
  const { id_hash: _h, session_created: created, last_seen_at: _l, session_method: method, fingerprint: _f, ...user } = row;
  req._session = { created_at: new Date(created), method };
  req._user = user;
  const store = als.getStore();
  if (store) store.user = user;
  return user;
}

export async function requireUser(req, roles = null) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'Tu sesión venció. Ingresá de nuevo.');
  if (roles && u.role !== 'superadmin' && !roles.includes(u.role)) throw new HttpError(403, 'No tenés permisos para esta acción');
  return u;
}

export const isSuper = (u) => Boolean(u && u.role === 'superadmin');
export const isAdminRole = (u) => Boolean(u && (u.role === 'admin' || u.role === 'superadmin'));
export const isManager = (u) => Boolean(u && ['superadmin', 'admin', 'supervisor'].includes(u.role));

export async function requireSuper(req) {
  const u = await requireUser(req);
  if (!isSuper(u)) throw new HttpError(403, 'Solo el superadministrador puede hacer esto');
  return u;
}

// ---------- Superadmin definido por variables de entorno ----------
export const SUPERADMIN_LOGIN = 'superadmin';
export function superadminUser() {
  return String(process.env.SUPERADMIN_USER || SUPERADMIN_LOGIN).trim().toLowerCase();
}
export function superadminEnabled() {
  return String(process.env.SUPERADMIN_PASSWORD || '').length >= 12;
}
export function checkSuperadmin(login, password) {
  if (!superadminEnabled()) return false;
  if (String(login || '').trim().toLowerCase() !== superadminUser()) return false;
  const key = subkey('superadmin-compare');
  const a = crypto.createHmac('sha256', key).update(String(password || '')).digest();
  const b = crypto.createHmac('sha256', key).update(String(process.env.SUPERADMIN_PASSWORD)).digest();
  return crypto.timingSafeEqual(a, b);
}
