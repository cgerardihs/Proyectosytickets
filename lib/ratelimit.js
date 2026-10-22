// Límites de uso.
// - Por instancia (memoria): techo general por IP y de pedidos simultáneos, sin tocar la base.
// - Compartidos (Postgres): login, portal y otras rutas sensibles; valen para todas las instancias.
import { q, one } from './db.js';
import { HttpError } from './http.js';
import { clientIp } from './audit.js';

export class TooManyRequests extends HttpError {
  constructor(message, retryAfter = 60) {
    super(429, message);
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

// ---------- En memoria (por instancia) ----------
const buckets = new Map();
let lastSweep = Date.now();

/** Ventana fija en memoria. Devuelve segundos de espera o 0 si se permite. */
export function memoryHit(key, max, windowSec) {
  const now = Date.now();
  if (now - lastSweep > 60000) {
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
    lastSweep = now;
  }
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { n: 0, reset: now + windowSec * 1000 };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n > max ? (b.reset - now) / 1000 : 0;
}

let inFlight = 0;
/** Limita los pedidos simultáneos por instancia; si se satura, 429 en lugar de encolar hasta el timeout. */
export async function withConcurrency(max, fn) {
  if (inFlight >= max) throw new TooManyRequests('El servidor está atendiendo demasiados pedidos. Probá de nuevo en unos segundos.', 2);
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}

// ---------- Compartidos (Postgres) ----------
/** Suma un intento a la clave y devuelve { count, reset } (reset en segundos). */
export async function hit(key, windowSec) {
  const r = await one(
    `insert into rate_limits(key, count, window_start) values ($1, 1, now())
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count, greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => $2) - now()))))::int as reset`,
    [String(key).slice(0, 300), windowSec],
  ).catch((e) => {
    // Antes de la instalación (o de migrar) la tabla no existe: se usa el límite en memoria.
    if (e.code === '42P01') return null;
    throw e;
  });
  if (!r) {
    memoryHit(key, Infinity, windowSec);
    const b = buckets.get(key);
    return { count: b.n, reset: Math.ceil((b.reset - Date.now()) / 1000) };
  }
  return { count: r.count, reset: r.reset };
}

/** Descuenta un intento (por ejemplo, el de un ingreso correcto que se había contado antes de verificar). */
export async function undoHit(key) {
  await q('update rate_limits set count = greatest(count - 1, 0) where key=$1', [String(key).slice(0, 300)]).catch(() => {});
}

/** Cuenta actual sin sumar. */
export async function peek(key, windowSec) {
  const r = await one(
    `select count, greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => $2) - now()))))::int as reset
     from rate_limits where key=$1 and window_start >= now() - make_interval(secs => $2)`,
    [String(key).slice(0, 300), windowSec],
  ).catch((e) => { if (e.code === '42P01') return null; throw e; });
  return r ? { count: r.count, reset: r.reset } : { count: 0, reset: 0 };
}

export async function reset(key) {
  await q('delete from rate_limits where key=$1', [String(key).slice(0, 300)]);
}

/** Suma `amount` de una vez (ej. cantidad de destinatarios) y corta con 429 si se pasa del máximo. Si se pasa, no cuenta. */
export async function limitAmount(key, amount, max, windowSec, message) {
  const n = Math.max(1, Math.floor(amount));
  const r = await one(
    `insert into rate_limits(key, count, window_start) values ($1, $3, now())
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then $3 else rate_limits.count + $3 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count, greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => $2) - now()))))::int as reset`,
    [String(key).slice(0, 300), windowSec, n],
  ).catch((e) => { if (e.code === '42P01') return null; throw e; });
  if (r && r.count > max) {
    await q('update rate_limits set count = greatest(count - $2, 0) where key=$1', [String(key).slice(0, 300), n]).catch(() => {});
    throw new TooManyRequests(message, r.reset);
  }
  return r;
}

/** Suma y corta con 429 si se pasa del máximo. */
export async function limit(key, max, windowSec, message = 'Demasiados pedidos. Esperá un momento y probá de nuevo.') {
  const r = await hit(key, windowSec);
  if (r.count > max) throw new TooManyRequests(message, r.reset);
  return r;
}

/** Límite por IP para rutas públicas. */
export const limitIp = (req, name, max, windowSec, message) => limit(`${name}:ip:${clientIp(req)}`, max, windowSec, message);

export async function cleanupRateLimits() {
  await q(`delete from rate_limits where window_start < now() - interval '1 day'`);
}
