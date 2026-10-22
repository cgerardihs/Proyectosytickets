// Aplica las migraciones pendientes en orden, cada una en su transacción y con lock (advisory lock).
import crypto from 'node:crypto';
import { q, one, tx } from './db.js';
import { setSetting, clearSettingsCache } from './settings.js';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { seedAiRules } from './seed.js';
import { logInfo, logWarn } from './log.js';

const LOCK_ID = 7418529;
export const checksum = (m) => crypto.createHash('sha256').update(m.statements.join(';\n')).digest('hex').slice(0, 16);

export async function migrationStatus() {
  try {
    const rows = await q('select version, name, applied_at from schema_migrations order by version');
    const applied = new Set(rows.map((r) => r.version));
    return { current: rows.length ? Math.max(...rows.map((r) => r.version)) : 0, latest: SCHEMA_VERSION, pending: MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version), applied: rows };
  } catch {
    return { current: 0, latest: SCHEMA_VERSION, pending: MIGRATIONS.map((m) => m.version), applied: [] };
  }
}

export async function migrate({ seed = true } = {}) {
  await q(`create table if not exists schema_migrations (
    version int primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
  const ran = [];
  for (const m of MIGRATIONS) {
    await tx(async () => {
      await q('select pg_advisory_xact_lock($1)', [LOCK_ID]);
      const done = await one('select checksum from schema_migrations where version=$1', [m.version]);
      if (done) {
        if (done.checksum !== checksum(m)) logWarn('una migración aplicada fue modificada: no se vuelve a correr', { version: m.version });
        return;
      }
      for (const stmt of m.statements) await q(stmt);
      await q('insert into schema_migrations(version,name,checksum) values ($1,$2,$3)', [m.version, m.name, checksum(m)]);
      ran.push(m.version);
    });
  }
  clearSettingsCache();
  await setSetting('schema_version', SCHEMA_VERSION);
  // Datos de ejemplo de cada versión: solo en instalaciones ya hechas (en una base vacía los carga la instalación)
  if (seed && (await one('select count(*)::int as n from users')).n > 0) await seedAiRules();
  if (ran.length) logInfo('migraciones aplicadas', { versions: ran });
  return SCHEMA_VERSION;
}

/** Versión aplicada (0 si la base está vacía). */
export async function appliedVersion() {
  try {
    const r = await one('select max(version)::int as v from schema_migrations');
    if (r?.v) return r.v;
  } catch { /* tabla inexistente: instalación anterior a v1.5 */ }
  try {
    const r = await one(`select value from app_settings where key='schema_version'`);
    return Number(r?.value) || 0;
  } catch {
    return 0;
  }
}
