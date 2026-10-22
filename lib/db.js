// Acceso a datos.
// - Producción (Neon): consultas sueltas por HTTP (sin conexión por request) y un Pool de WebSockets reutilizado
//   entre invocaciones para las transacciones. Cada consulta tiene timeout.
// - Pruebas y desarrollo: PGlite (Postgres embebido).
// Todas las consultas son parametrizadas ($1, $2…). Las transacciones viajan por AsyncLocalStorage:
// cualquier q()/one() que se ejecute dentro de tx() usa la misma conexión, sin pasar el cliente a mano.
import { als } from './context.js';
import { HttpError } from './http.js';
import { logWarn, logError } from './log.js';

export const QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 10000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let driverP = null;

function getDriver() {
  if (!driverP) driverP = makeDriver().catch((e) => { driverP = null; throw e; });
  return driverP;
}

async function makeDriver() {
  if (process.env.PGLITE) {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(process.env.PGLITE === 'memory' ? undefined : process.env.PGLITE);
    const wrap = (c) => ({ query: async (text, params = []) => (await c.query(text, params)).rows });
    return { kind: 'pglite', ...wrap(db), transaction: (fn) => db.transaction((t) => fn(wrap(t))) };
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(503, 'Falta la variable DATABASE_URL (cadena de conexión de Neon).');
  const { neon, Pool, neonConfig } = await import('@neondatabase/serverless');
  if (!neonConfig.webSocketConstructor && globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;
  const http = neon(url);
  // Un solo pool por instancia (se reutiliza mientras la función está "tibia"), con tope de conexiones.
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (e) => logWarn('pool: se descartó una conexión', { error: e.message }));
  return {
    kind: 'neon',
    query: (text, params = []) => http.query(text, params, { fetchOptions: { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) } }),
    transaction: async (fn) => {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('begin');
        await client.query(`select set_config('statement_timeout', $1, true)`, [String(QUERY_TIMEOUT_MS)]);
        const out = await fn({ query: async (text, params = []) => (await client.query(text, params)).rows });
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => { broken = true; });
        throw e;
      } finally {
        client.release(broken);
      }
    },
  };
}

// ---------- Errores ----------
const TRANSIENT = new Set(['08000', '08001', '08003', '08006', '57P01', '57P02', '57P03', '40001', '40P01']);
const SATURATED = new Set(['53300', '53400']);

function isTransient(e) {
  const code = e?.code || e?.sourceError?.code || e?.cause?.code;
  return TRANSIENT.has(code) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code) || /fetch failed|Connection terminated|socket hang up/i.test(e?.message || '');
}

/** Traduce saturación y caídas de la base a 429/503 en lugar de 500. Deja pasar el resto (ej. 23505). */
export function mapDbError(e) {
  if (e instanceof HttpError) return e;
  const code = e?.code || e?.sourceError?.code;
  const msg = String(e?.message || '');
  if (SATURATED.has(code) || /timeout exceeded when trying to connect|too many connections|rate limit/i.test(msg) || e?.status === 429) {
    return Object.assign(new HttpError(429, 'El sistema está con mucha carga. Probá de nuevo en unos segundos.'), { retryAfter: 5, cause: e });
  }
  if (code === '57014' || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.sourceError?.name === 'TimeoutError') {
    return Object.assign(new HttpError(503, 'La base de datos tardó demasiado en responder. Probá de nuevo.'), { retryAfter: 3, cause: e });
  }
  if (isTransient(e)) return Object.assign(new HttpError(503, 'La base de datos no está disponible en este momento.'), { retryAfter: 5, cause: e });
  // Datos inválidos que se escaparon de la validación: 400 (no 500)
  if (code === '23503') return Object.assign(new HttpError(400, 'Hay una referencia a un registro que no existe (por ejemplo, un usuario o una categoría borrados).'), { cause: e });
  if (code === '23505') return Object.assign(new HttpError(400, 'Ya existe un registro con esos datos.'), { cause: e });
  if (code === '22007' || code === '22008' || code === '22009') return Object.assign(new HttpError(400, 'Hay una fecha inválida.'), { cause: e });
  return e;
}

const READ_ONLY = /^\s*(select|with)\b/i;
const WRITES = /\b(insert|update|delete|merge|create|alter|drop|truncate)\b/i;

/** Ejecuta una consulta parametrizada y devuelve las filas. Reintenta solo lecturas ante errores transitorios. */
export async function q(text, params = []) {
  const store = als.getStore();
  if (store?.tx) return store.tx.query(text, params);
  const d = await getDriver();
  const canRetry = READ_ONLY.test(text) && !WRITES.test(text);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await d.query(text, params);
    } catch (e) {
      if (canRetry && attempt < 2 && isTransient(e)) {
        await sleep(100 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      throw mapDbError(e);
    }
  }
}

/** Primera fila o null. */
export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

/**
 * Ejecuta fn dentro de una transacción. Si fn ya corre dentro de una, la reutiliza.
 * Reintenta ante conflictos de serialización o deadlocks. Las tareas registradas con onCommit()
 * (correos, avisos, llamadas externas) se ejecutan solo si la transacción se confirmó.
 */
export async function tx(fn, { retries = 2 } = {}) {
  const outer = als.getStore() || {};
  if (outer.tx) return fn();
  const d = await getDriver();
  for (let attempt = 0; ; attempt += 1) {
    const after = [];
    try {
      const result = await d.transaction((client) => als.run({ ...outer, tx: client, after }, fn));
      for (const task of after) {
        try { await task(); } catch (e) { logError('falló una tarea posterior al commit', { error: e }); }
      }
      return result;
    } catch (e) {
      const code = e?.code;
      if ((code === '40001' || code === '40P01') && attempt < retries) {
        await sleep(50 * 2 ** attempt + Math.random() * 50);
        continue;
      }
      throw mapDbError(e);
    }
  }
}

/** Ejecuta fn después del commit de la transacción en curso (o enseguida si no hay transacción). */
export async function onCommit(fn) {
  const store = als.getStore();
  if (store?.tx && store.after) {
    store.after.push(fn);
    return;
  }
  await fn();
}

export function inTransaction() {
  return Boolean(als.getStore()?.tx);
}

/** Verifica la base para el health check. */
export async function ping() {
  const t = Date.now();
  const d = await getDriver();
  await Promise.race([d.query('select 1 as ok', []), sleep(3000).then(() => { throw new Error('timeout'); })]);
  return Date.now() - t;
}

export function splitSql(text) {
  return text
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

/** Constructor de WHERE dinámico: los valores van siempre como parámetros numerados. */
export class Where {
  constructor(params = []) {
    this.parts = [];
    this.params = params;
  }
  p(value) {
    this.params.push(value);
    return '$' + this.params.length;
  }
  add(sqlFragment) {
    this.parts.push(sqlFragment);
    return this;
  }
  toString() {
    return this.parts.length ? 'where ' + this.parts.join(' and ') : '';
  }
}

/**
 * Envuelve un router para que todas las rutas que escriben (POST/PATCH/PUT/DELETE) corran en una transacción.
 * except: rutas que hacen llamadas externas antes de escribir (IA, etc.) y manejan su propia transacción.
 */
export function txRouter(router, except = []) {
  const wrap = (m) => (p, h, o = {}) => router[m](p, h, { tx: !except.includes(p), ...o });
  return { get: router.get.bind(router), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), del: wrap('del') };
}
