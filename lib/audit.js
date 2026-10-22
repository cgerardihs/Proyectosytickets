// Registro de auditoría (visible solo para el superadmin).
import { q, one } from './db.js';
import { ctx } from './context.js';

/**
 * IP del cliente. En Vercel, x-real-ip y x-vercel-forwarded-for los pone la plataforma (no el cliente);
 * x-forwarded-for queda como último recurso.
 */
export function clientIp(req) {
  const h = req?.headers || {};
  const raw = h['x-real-ip'] || h['x-vercel-forwarded-for'] || String(h['x-forwarded-for'] || '').split(',')[0] || req?.socket?.remoteAddress || '';
  return String(raw).trim().replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) || 'desconocida';
}

export async function audit(req, user, action, details = {}, path = '') {
  // Dentro de una transacción, un error acá la dejaría abortada y el commit la desharía en silencio: va en un savepoint
  const inTx = Boolean(ctx().tx);
  try {
    if (inTx) await q('savepoint audit_entry');
    await q('insert into audit_log(user_id,actor,action,path,details,ip) values ($1,$2,$3,$4,$5::jsonb,$6)', [
      user?.id || null, user ? `${user.name} <${user.email}>` : String(details.login || ''), action, path, JSON.stringify(details), clientIp(req),
    ]);
    if (inTx) await q('release savepoint audit_entry');
  } catch {
    // la auditoría nunca debe romper la operación (ej. tabla todavía no migrada)
    if (inTx) await q('rollback to savepoint audit_entry').catch(() => {});
  }
}
