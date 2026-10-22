// fetch con timeout en cada llamada externa y reintentos SOLO ante errores transitorios.
// - Pedidos idempotentes (GET, PUT, PATCH, o POST con clave de idempotencia): reintenta ante red caída, timeout, 408, 425, 429, 5xx.
// - Pedidos NO idempotentes: reintenta solo cuando es seguro que el servidor no lo procesó (429, 503, o no se pudo conectar).
import { logWarn } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const MAYBE_SENT = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export class ExternalError extends Error {
  constructor(message, { status = 502, service, cause } = {}) {
    super(message);
    this.status = status;
    this.service = service;
    this.cause = cause;
  }
}

function errCode(e) {
  return e?.cause?.code || e?.code || '';
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

/**
 * @param {string} url
 * @param {RequestInit} opts
 * @param {{service?: string, timeoutMs?: number, budgetMs?: number, retries?: number, idempotent?: boolean}} o
 */
export async function fetchx(url, opts = {}, { service = 'externo', timeoutMs = 10000, budgetMs, retries = 2, idempotent } = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const isIdem = idempotent ?? ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method);
  const deadline = Date.now() + (budgetMs || timeoutMs * (retries + 1) + 3000);
  const retryStatus = isIdem ? [408, 425, 429, 500, 502, 503, 504, 529] : [429, 503];
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 250) throw new ExternalError(`${service} no respondió a tiempo`, { status: 504, service });
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)) });
      if (retryStatus.includes(res.status) && attempt < retries) {
        const wait = Math.min(retryAfterMs(res) ?? 300 * 2 ** attempt + Math.random() * 200, 8000);
        if (Date.now() + wait < deadline - 500) {
          logWarn('reintento externo', { service, status: res.status, attempt: attempt + 1 });
          await res.body?.cancel().catch(() => {});
          await sleep(wait);
          continue;
        }
      }
      return res;
    } catch (e) {
      const code = errCode(e);
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      const transient = NEVER_SENT.has(code) || (isIdem && (timeout || MAYBE_SENT.has(code) || e.message === 'fetch failed'));
      if (transient && attempt < retries && Date.now() + 500 < deadline) {
        logWarn('reintento externo', { service, error: code || e.name, attempt: attempt + 1 });
        await sleep(300 * 2 ** attempt + Math.random() * 200);
        continue;
      }
      if (timeout) throw new ExternalError(`${service} no respondió a tiempo`, { status: 504, service, cause: e });
      throw new ExternalError(`No se pudo conectar con ${service}`, { status: 502, service, cause: e });
    }
  }
}
