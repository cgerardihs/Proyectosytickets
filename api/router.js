// Única función serverless: todas las rutas /api/* pasan por acá (plan Hobby de Vercel: máx. 12 funciones).
import crypto from 'node:crypto';
import { Router, readBody, send, HttpError } from '../lib/http.js';
import { als } from '../lib/context.js';
import { log, logError } from '../lib/log.js';
import { guardBody } from '../lib/validate.js';
import { memoryHit, withConcurrency, TooManyRequests } from '../lib/ratelimit.js';
import { runIdempotent } from '../lib/idempotency.js';
import { currentUser } from '../lib/auth.js';
import { clientIp, audit } from '../lib/audit.js';
import { ping, mapDbError, tx, one } from '../lib/db.js';
import { seesAllTickets, canSeeTicket } from '../lib/visibility.js';
import { migrationStatus } from '../lib/migrate.js';
import { coreRoutes } from '../lib/routes/core.js';
import { authRoutes } from '../lib/routes/auth.js';
import { ticketRoutes } from '../lib/routes/tickets.js';
import { projectRoutes } from '../lib/routes/projects.js';
import { portalRoutes } from '../lib/routes/portal.js';
import { criticalRoutes } from '../lib/routes/critical.js';
import { superRoutes } from '../lib/routes/super.js';
import { homeRoutes } from '../lib/routes/home.js';
import { aiRoutes } from '../lib/routes/ai.js';
import { m365Routes } from '../lib/routes/m365.js';
import { portfolioRoutes } from '../lib/routes/portfolio.js';
import { apiRoutes } from '../lib/routes/api.js';
import { importRoutes } from '../lib/routes/imports.js';
import { reportsPlusRoutes } from '../lib/routes/reports-plus.js';

const router = new Router();
coreRoutes(router);
authRoutes(router);
ticketRoutes(router);
projectRoutes(router);
portalRoutes(router);
criticalRoutes(router);
superRoutes(router);
homeRoutes(router);
aiRoutes(router);
m365Routes(router);
portfolioRoutes(router);
apiRoutes(router);
importRoutes(router);
reportsPlusRoutes(router);

// Health check: revisa la base y las migraciones. 200 si está sano, 503 si no.
router.get('/health', async () => {
  const out = { status: 'ok', time: new Date().toISOString(), version: process.env.npm_package_version || '1.14.0', checks: {} };
  try {
    out.checks.database = { ok: true, latency_ms: await ping() };
    const m = await migrationStatus();
    out.checks.migrations = { ok: m.pending.length === 0, pending: m.pending.length };
    if (m.pending.length) out.status = 'degraded';
  } catch (e) {
    out.status = 'error';
    out.checks.database = { ok: false, error: e.status === 503 || e.status === 429 ? e.message : 'No se pudo conectar con la base de datos' };
  }
  return { __status: out.status === 'error' ? 503 : 200, ...out };
});

const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 64);
const IP_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 600);

// Cambios de configuración que quedan en la auditoría (sin guardar valores sensibles).
const AUDITED = /^\/(admin|views|canned|kb\/categories)\//;
const SECRET_FIELDS = new Set(['password', 'logo', 'setup_key', 'current']);
// Rutas llamadas por servicios (no por el navegador): no aplica el control de origen.
const MACHINE = /^\/(inbound\/email|m365\/poll|cron\/daily)$/;

function resolvePath(req) {
  const url = new URL(req.url, 'http://x');
  let p = req.query?.__path ?? url.searchParams.get('__path');
  if (Array.isArray(p)) p = p.join('/');
  if (p === undefined || p === null || p === '') {
    p = url.pathname.replace(/^\/api\/?/, '').replace(/^router\/?/, '');
  }
  const query = {};
  for (const [k, v] of url.searchParams) if (k !== '__path') query[k] = String(v).slice(0, 2000);
  if (req.query) for (const [k, v] of Object.entries(req.query)) if (k !== '__path' && query[k] === undefined) query[k] = String(Array.isArray(v) ? v.join(',') : v).slice(0, 2000);
  return { path: '/' + String(p).replace(/^\/+|\/+$/g, '').slice(0, 500), query };
}

/** Protección CSRF: un navegador siempre manda Origin o Sec-Fetch-Site en pedidos entre sitios. */
function checkOrigin(req, path) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || MACHINE.test(path)) return;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'Pedido de otro sitio rechazado');
  const origin = req.headers.origin;
  // v1.9.6: "Origin: null" (iframes aislados, data:, redirecciones) no es de este sitio
  if (origin === 'null') throw new HttpError(403, 'Pedido de otro sitio rechazado');
  // Los cambios solo se aceptan en JSON: un formulario de otro sitio (urlencoded, multipart o text/plain) no pasa
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (hasBody && !ct.startsWith('application/json')) throw new HttpError(415, 'El pedido tiene que ser JSON');
  if (origin) {
    const allowed = new Set([req.headers['x-forwarded-host'], req.headers.host].filter(Boolean));
    if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).host);
    let host = '';
    try { host = new URL(origin).host; } catch { /* */ }
    if (!allowed.has(host)) throw new HttpError(403, 'Pedido de otro sitio rechazado');
  }
}

function securityHeaders(res, rid) {
  res.setHeader('X-Request-Id', rid);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export default async function handler(req, res) {
  const started = Date.now();
  const given = String(req.headers['x-request-id'] || '');
  const rid = /^[\w-]{8,64}$/.test(given) ? given : crypto.randomUUID();
  const { path, query } = resolvePath(req);
  const ip = clientIp(req);
  securityHeaders(res, rid);
  return als.run({ rid, ip, path }, async () => {
    let status = 200;
    try {
      await withConcurrency(MAX_INFLIGHT, async () => {
        const m = router.match(req.method, path);
        if (!m) throw new HttpError(404, `Ruta inexistente: ${path}`);
        if (m.methodNotAllowed) throw new HttpError(405, 'Método no permitido');
        if (!m.route.opts.public) {
          const wait = memoryHit(`ip:${ip}`, IP_PER_MINUTE, 60);
          if (wait) throw new TooManyRequests('Demasiados pedidos. Esperá un momento.', wait);
        }
        checkOrigin(req, path);
        // Grupos privados: cualquier ruta de un ticket puntual (/tickets/123/…) se valida acá, en un solo lugar
        // (se decodifica igual que el router y se exige el mismo formato estricto que getByNumber)
        const tm = /^\/tickets\/([^/]+)(\/|$)/.exec(path);
        if (tm && !['export', 'counts', 'bulk'].includes(tm[1])) {
          let seg = '';
          try { seg = decodeURIComponent(tm[1]).trim(); } catch { throw new HttpError(404, 'No existe el ticket'); }
          if (!/^[1-9]\d{0,8}$/.test(seg)) throw new HttpError(404, 'No existe el ticket');
          const u = await currentUser(req);
          if (u && !seesAllTickets(u)) {
            const t = await one('select group_id, assignee_id from tickets where number=$1', [Number(seg)]);
            if (t && !(await canSeeTicket(u, t))) throw new HttpError(404, 'No existe el ticket');
          }
        }
        const body = guardBody(await readBody(req));
        const ctx = { req, res, params: m.params, query, body };
        let out;
        let replayed = false;
        // opts.tx: todas las escrituras de la ruta en una transacción (lo externo sale después del commit)
        const exec = () => (m.route.opts.tx ? tx(() => m.route.handler(ctx)) : m.route.handler(ctx));
        if (m.route.opts.idempotent) {
          const u = await currentUser(req);
          const r = await runIdempotent(req, { path, body, scope: u ? `user:${u.id}` : null }, exec);
          out = r.out;
          replayed = r.replayed;
          if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        } else {
          out = await exec();
        }
        if (!replayed && req.method !== 'GET' && (AUDITED.test(`${path}/`) || path.startsWith('/super/')) && !['/super/revoke-sessions', '/super/migrate', '/super/empty-trash'].includes(path) && !path.startsWith('/super/db/')) {
          const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).filter((k) => !SECRET_FIELDS.has(k)) : [];
          await audit(req, req._user, 'config', { method: req.method, fields, password_changed: Boolean(body?.password) || undefined }, path);
        }
        if (m.route.opts.raw) { status = res.statusCode; return; }
        if (m.route.opts.setCookie && out && out.cookie) {
          res.setHeader('Set-Cookie', Array.isArray(out.cookie) ? out.cookie : [out.cookie]);
          delete out.cookie;
        }
        if (out && out.__status) { status = out.__status; delete out.__status; }
        send(res, status, out ?? { ok: true });
      });
    } catch (raw) {
      const e = mapDbError(raw);
      status = e.status || 500;
      if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
      if (status >= 500) logError('error en la API', { method: req.method, path, status, error: e, cause: e.cause?.message, stack: status === 500 ? String(e.stack || '').split('\n').slice(0, 6).join(' | ') : undefined });
      if (!res.headersSent) {
        send(res, status, {
          error: status === 500 ? 'Error interno del servidor. Si se repite, avisá a soporte con el código de la solicitud.' : e.message,
          field: e.field,
          request_id: rid,
        });
      }
    } finally {
      log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
        method: req.method, path, status, ms: Date.now() - started, uid: req._user?.id, ip, vercel_id: req.headers['x-vercel-id'],
      });
    }
  });
}
