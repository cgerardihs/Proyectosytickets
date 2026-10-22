// Logs estructurados (una línea JSON) con el request id del contexto. Nunca registra cuerpos ni secretos.
import { ctx } from './context.js';

const SECRET_KEYS = /pass|secret|token|key|authorization|cookie|signature/i;

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    out[k] = SECRET_KEYS.test(k) ? '[oculto]' : v instanceof Error ? { message: v.message, code: v.code, status: v.status } : v;
  }
  return out;
}

export function log(level, msg, fields = {}) {
  const c = ctx();
  const line = JSON.stringify({ ts: new Date().toISOString(), level, rid: c.rid, msg, ...clean(fields) });
  if (process.env.LOG_SILENT && level !== 'error') return;
  (level === 'error' ? console.error : console.log)(line);
}

export const logInfo = (msg, f) => log('info', msg, f);
export const logWarn = (msg, f) => log('warn', msg, f);
export const logError = (msg, f) => log('error', msg, f);
