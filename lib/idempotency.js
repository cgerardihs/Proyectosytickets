// Idempotencia: si el cliente repite una operación con la misma clave (doble clic, reintento por corte de red),
// se devuelve la respuesta original en lugar de ejecutarla dos veces.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { HttpError } from './http.js';
import { clientIp } from './audit.js';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

export function idempotencyKey(req) {
  const k = req.headers['idempotency-key'];
  if (k === undefined) return null;
  if (!KEY.test(String(k))) throw new HttpError(400, 'Idempotency-Key inválida (8 a 100 caracteres: letras, números, - o _)');
  return String(k);
}

const hashBody = (method, path, body) => crypto.createHash('sha256').update(`${method} ${path}\n${JSON.stringify(body ?? {})}`).digest('hex');

/**
 * Ejecuta handler una sola vez por (alcance, clave).
 * Alcance: el usuario logueado, o la IP en rutas públicas.
 */
export async function runIdempotent(req, { path, body, scope }, handler) {
  const key = idempotencyKey(req);
  if (!key) return { out: await handler(), replayed: false };
  const sc = scope || `ip:${clientIp(req)}`;
  const hash = hashBody(req.method, path, body);
  const claimed = await one(
    `insert into idempotency_keys(scope, key, request_hash) values ($1,$2,$3) on conflict (scope, key) do nothing returning key`,
    [sc, key, hash],
  );
  if (!claimed) {
    const prev = await one('select request_hash, status, response, created_at from idempotency_keys where scope=$1 and key=$2', [sc, key]);
    if (prev && prev.request_hash !== hash) throw new HttpError(422, 'Esa clave de idempotencia ya se usó con otro contenido');
    if (prev && prev.status) return { out: prev.response, replayed: true, status: prev.status };
    // Un intento que quedó colgado (la instancia se cortó) se puede retomar después de 2 minutos.
    if (prev && Date.now() - new Date(prev.created_at).getTime() > 120000) {
      await q('delete from idempotency_keys where scope=$1 and key=$2 and status is null', [sc, key]);
      return runIdempotent(req, { path, body, scope }, handler);
    }
    throw new HttpError(409, 'La misma operación ya se está procesando. Esperá unos segundos.');
  }
  try {
    const out = await handler();
    await q('update idempotency_keys set status=200, response=$3::jsonb where scope=$1 and key=$2', [sc, key, JSON.stringify(out ?? null)]);
    return { out, replayed: false };
  } catch (e) {
    // Si falló, se libera la clave para que el cliente pueda reintentar.
    await q('delete from idempotency_keys where scope=$1 and key=$2', [sc, key]).catch(() => {});
    throw e;
  }
}

export async function cleanupIdempotency() {
  await q(`delete from idempotency_keys where created_at < now() - interval '24 hours'`);
}
