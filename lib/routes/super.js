// Funciones exclusivas del superadministrador.
import zlib from 'node:zlib';
import { q, one, tx, onCommit } from '../db.js';
import { likeTerm } from '../validate.js';
import { SCHEMA_VERSION, fullSchemaSql } from '../migrations.js';
import { migrate } from '../migrate.js';
import { requireSuper, createSession, superadminUser } from '../auth.js';
import { getSetting, setSetting, clearSettingsCache } from '../settings.js';
import { audit } from '../audit.js';
import { bad, int, send } from '../http.js';
import { mailEnabled, appUrl } from '../mail.js';
import { v, parse, idParam } from '../validate.js';
import { generateApiKey, API_SCOPES } from './api.js';
import { listTables, tableMeta, tableRows, tableRow, updateRow, deleteRows, MAX_PAGE } from '../dbadmin.js';

// Orden de restauración respetando claves foráneas.
export const BACKUP_TABLES = [
  'app_settings', 'users', 'webauthn_credentials', 'agent_groups', 'group_members', 'categories', 'tech_categories', 'tech_subcategories', 'ticket_types', 'statuses', 'sla_policies',
  'companies', 'contacts', 'tickets', 'ticket_messages', 'attachments', 'ticket_followers', 'ticket_activities', 'time_entries',
  'canned_responses', 'custom_views', 'notifications', 'automation_rules', 'kb_categories', 'kb_articles', 'project_types', 'portfolio_options', 'projects', 'project_statuses',
  'project_members', 'sprints', 'issues', 'issue_comments', 'issue_links', 'issue_activities', 'ticket_issue_links', 'ticket_projects', 'audit_log',
  'ai_rules', 'ai_deflections', 'critical_systems', 'critical_system_tickets', 'critical_system_log', 'report_views',
];
const SEEDED_BY_MIGRATIONS = new Set(['project_types', 'portfolio_options']);
const NO_ID = new Set(['app_settings', 'group_members', 'ticket_followers', 'project_members', 'ticket_issue_links', 'ticket_projects', 'critical_system_tickets']);
// Tablas con id que no es una secuencia (no llevan setval)
const NO_SEQ = new Set(['webauthn_credentials']);
// No se respaldan a propósito: sesiones, desafíos de passkeys, límites de uso e idempotencia (temporales), consumo de IA
// (estadística) y claves de la API (conviene generarlas de nuevo después de restaurar).
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Columnas de attachments con el contenido vacío (para el respaldo liviano: Postgres ni lee el archivo). */
async function attachmentColsWithoutData() {
  const cols = await q(`select column_name as c from information_schema.columns where table_schema=current_schema() and table_name='attachments' order by ordinal_position`);
  return cols.map(({ c }) => (c === 'data_b64' ? `''::text as data_b64` : `"${String(c).replace(/"/g, '""')}"`)).join(', ');
}

/** Genera un respaldo SQL portable (cualquier Postgres): esquema + datos + secuencias. */
export async function buildBackup({ attachments = false } = {}) {
  const out = [];
  out.push(`-- Respaldo de la Mesa de Ayuda · ${new Date().toISOString()} · esquema v${SCHEMA_VERSION}`);
  out.push('-- Restaurar sobre una base VACÍA: psql "$DATABASE_URL" -f respaldo.sql');
  if (!attachments) out.push('-- Respaldo liviano: los adjuntos quedan registrados (nombre, tipo, tamaño) pero sin su contenido.');
  out.push('-- No incluye sesiones, límites de uso, consumo de IA ni claves de la API (se generan de nuevo).');
  // Los textos van entre comillas simples estándar: se fija cómo los interpreta Postgres para que el respaldo no dependa del servidor
  out.push("SET standard_conforming_strings = on;");
  out.push("SET client_encoding = 'UTF8';");
  out.push(fullSchemaSql());
  out.push('begin;');
  const counts = {};
  for (const table of BACKUP_TABLES) {
    // Tablas que las migraciones crean con valores iniciales: se reemplazan por los del respaldo
    if (SEEDED_BY_MIGRATIONS.has(table)) out.push(`delete from ${table};`);
    const order = NO_ID.has(table) ? 'j' : 'id';
    let offset = 0;
    let total = 0;
    const parents = [];
    for (;;) {
      // table y order salen de la lista fija BACKUP_TABLES; el desplazamiento va como parámetro
      // Respaldo liviano: el contenido de los adjuntos no viaja (se vacía en la base, antes de traerlo)
      const from = table === 'attachments' && !attachments ? `(select ${await attachmentColsWithoutData()} from attachments) t` : `${table} t`;
      const rows = await q(`select row_to_json(t)::text as j from ${from} order by ${order} limit 500 offset $1`, [offset]);
      if (!rows.length) break;
      let objs = rows.map((r) => JSON.parse(r.j));
      if (table === 'issues') {
        // padre/hijo pueden venir en cualquier orden: se cargan sin padre y se enlazan al final
        for (const o of objs) if (o.parent_id) parents.push([o.id, o.parent_id]);
        objs = objs.map((o) => ({ ...o, parent_id: null }));
      }
      out.push(`insert into ${table} select * from json_populate_recordset(null::${table}, ${sqlStr(JSON.stringify(objs))}::json);`);
      total += rows.length;
      offset += 500;
      if (rows.length < 500) break;
    }
    if (parents.length) {
      out.push(`update issues set parent_id = v.p from (values ${parents.map(([a, b]) => `(${Number(a)},${Number(b)})`).join(',')}) as v(id, p) where issues.id = v.id;`);
    }
    if (!NO_ID.has(table) && !NO_SEQ.has(table)) out.push(`select setval(pg_get_serial_sequence('${table}', 'id'), greatest((select coalesce(max(id), 0) from ${table}), 1));`);
    counts[table] = total;
  }
  out.push(`select setval('ticket_number_seq', greatest((select coalesce(max(number), 0) from tickets), 1));`);
  out.push('commit;');
  return { sql: `${out.join('\n')}\n`, counts };
}

/** Campos del ticket cuyo nombre puede cambiar el superadmin (el valor por defecto está en el cliente). */
export const FIELD_LABEL_KEYS = ['status', 'priority', 'category', 'type', 'tech', 'subtech', 'assignee', 'contact', 'channel', 'sla'];

export function superRoutes(r) {
  r.get('/super/info', async ({ req }) => {
    await requireSuper(req);
    // Una sola consulta para todos los conteos
    const counts = await one(`select
      (select count(*)::int from users) as users, (select count(*)::int from tickets) as tickets, (select count(*)::int from ticket_messages) as ticket_messages,
      (select count(*)::int from attachments) as attachments, (select count(*)::int from contacts) as contacts, (select count(*)::int from projects) as projects,
      (select count(*)::int from issues) as issues, (select count(*)::int from kb_articles) as kb_articles, (select count(*)::int from audit_log) as audit_log`);
    let dbSize = null;
    try { dbSize = (await one('select pg_database_size(current_database())::bigint as s')).s; } catch { /* */ }
    const attachBytes = (await one('select coalesce(sum(size),0)::bigint as s from attachments')).s;
    const trash = (await one('select count(*)::int as n from tickets where deleted_at is not null')).n;
    const admins = await q(`select id,name,email,active,last_login_at from users where role='admin' order by name`);
    return {
      schemaVersion: await getSetting('schema_version', 0), schemaTarget: SCHEMA_VERSION, counts, dbSize: dbSize === null ? null : Number(dbSize),
      attachBytes: Number(attachBytes), trash, admins, superUser: superadminUser(),
      sessionEpoch: await getSetting('session_epoch', 0),
      env: {
        database: Boolean(process.env.DATABASE_URL), sessionSecret: Boolean(process.env.SESSION_SECRET), setupKey: Boolean(process.env.SETUP_KEY),
        resend: await mailEnabled(), inbound: Boolean(process.env.INBOUND_SECRET), cron: Boolean(process.env.CRON_SECRET),
        microsoft: Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MS_TENANT_ID), appUrl: process.env.APP_URL || '',
      },
    };
  });

  r.get('/super/audit', async ({ req, query }) => {
    await requireSuper(req);
    const params = [];
    const where = [];
    if (query.action) { params.push(query.action); where.push(`action=$${params.length}`); }
    if (query.q) { params.push(likeTerm(query.q)); where.push(`(actor ilike $${params.length} or path ilike $${params.length} or details::text ilike $${params.length} or ip ilike $${params.length})`); }
    if (query.before) { params.push(int(query.before)); where.push(`id < $${params.length}`); }
    const limit = Math.min(Math.max(int(query.limit, 100), 1), 500);
    params.push(limit);
    const items = await q(`select * from audit_log ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit $${params.length}`, params);
    const actions = await q('select action, count(*)::int as n from audit_log group by 1 order by 2 desc');
    return { items, actions };
  });

  r.get('/super/backup', async ({ req, res, query }) => {
    const u = await requireSuper(req);
    const withFiles = query.attachments === '1';
    const { sql, counts } = await buildBackup({ attachments: withFiles });
    const gz = zlib.gzipSync(Buffer.from(sql, 'utf8'), { level: 9 });
    if (gz.length > 4.2 * 1024 * 1024) {
      throw bad(`El respaldo comprimido pesa ${(gz.length / 1048576).toFixed(1)} MB y supera el límite de descarga de Vercel (4,5 MB). ${withFiles ? 'Descargalo sin adjuntos.' : 'Usá "npm run backup" desde tu PC.'}`);
    }
    await audit(req, u, 'backup', { attachments: withFiles, bytes: gz.length, counts });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    send(res, 200, gz, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="mesa-de-ayuda-${stamp}${withFiles ? '-con-adjuntos' : ''}.sql.gz"`,
    });
    return undefined;
  }, { raw: true });

  r.post('/super/migrate', async ({ req }) => {
    const u = await requireSuper(req);
    await migrate();
    await audit(req, u, 'migrate', { version: SCHEMA_VERSION });
    return { ok: true, version: SCHEMA_VERSION };
  });

  r.post('/super/empty-trash', async ({ req, body }) => {
    const u = await requireSuper(req);
    const spamDays = Math.min(Math.max(int(body.spam_days, 0), 0), 3650);
    const { trashed, spam } = await tx(async () => ({
      trashed: await q('delete from tickets where deleted_at is not null returning number'),
      spam: spamDays > 0 ? await q('delete from tickets where spam and created_at < now() - make_interval(days => $1) returning number', [spamDays]) : [],
    }));
    await audit(req, u, 'empty_trash', { trash: trashed.length, spam: spam.length });
    return { ok: true, trash: trashed.length, spam: spam.length };
  });

  r.post('/super/revoke-sessions', async ({ req }) => {
    const u = await requireSuper(req);
    const gone = await q('delete from sessions returning 1');
    await setSetting('session_epoch', Math.floor(Date.now() / 1000) - 1);
    clearSettingsCache();
    await audit(req, u, 'revoke_sessions', { sessions: gone.length });
    // el superadmin recibe una sesión nueva para no quedar afuera
    return { ok: true, revoked: gone.length, cookie: await createSession(req, u.id, 'superadmin') };
  }, { setCookie: true });

  // ---------- Nombres de los campos del ticket (solo superadmin) ----------
  r.put('/super/field-labels', async ({ req, body }) => {
    await requireSuper(req);
    const b = parse(v.object(Object.fromEntries(FIELD_LABEL_KEYS.map((k) => [k, v.string({ max: 60, pattern: /^[^<>]*$/, optional: true, nullable: true })]))), body);
    const cur = (await getSetting('field_labels', {})) || {};
    const next = { ...cur };
    for (const k of FIELD_LABEL_KEYS) {
      if (!Object.hasOwn(body || {}, k)) continue;
      const val = String(b[k] ?? '').replace(/\s+/g, ' ').trim();
      if (val) next[k] = val; else delete next[k]; // vacío = vuelve al nombre de fábrica
    }
    await setSetting('field_labels', next);
    return next;
  });

  // ---------- Explorador de la base de datos (solo superadmin) ----------
  r.get('/super/db/tables', async ({ req }) => {
    await requireSuper(req);
    return { tables: await listTables() };
  });

  r.get('/super/db/tables/:name', async ({ req, params }) => {
    await requireSuper(req);
    return tableMeta(params.name);
  });

  r.get('/super/db/tables/:name/rows', async ({ req, params, query }) => {
    await requireSuper(req);
    const meta = await tableMeta(params.name);
    return { meta, ...(await tableRows(meta, { ...query, isnull: query.isnull === '1' })) };
  });

  const pkOf = (raw) => {
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw bad('Clave inválida'); }
  };
  r.get('/super/db/tables/:name/row', async ({ req, params, query }) => {
    await requireSuper(req);
    const meta = await tableMeta(params.name);
    return { row: await tableRow(meta, pkOf(query.pk)) };
  });

  r.patch('/super/db/tables/:name/row', async ({ req, params, body }) => {
    const u = await requireSuper(req);
    const meta = await tableMeta(params.name);
    const b = parse(v.object({ pk: v.any(), values: v.any() }), body);
    const { row, changes } = await updateRow(meta, pkOf(b.pk), b.values, { superUserId: u.id });
    if (Object.keys(changes).length) {
      await audit(req, u, 'db_update', { table: meta.name, pk: pkOf(b.pk), changes }, `/super/db/tables/${meta.name}`);
      if (meta.name === 'app_settings') onCommit(clearSettingsCache);
    }
    return { row, changed: Object.keys(changes) };
  }, { tx: true });

  r.post('/super/db/tables/:name/delete', async ({ req, params, body }) => {
    const u = await requireSuper(req);
    const meta = await tableMeta(params.name);
    const b = parse(v.object({ pks: v.array(v.any(), { max: MAX_PAGE }), confirm: v.string({ max: 20 }) }), body);
    if (b.confirm !== 'BORRAR') throw bad('Para borrar, escribí BORRAR');
    const removed = await deleteRows(meta, b.pks.map(pkOf), { superUserId: u.id });
    if (removed.length) {
      // Copia de lo borrado en la auditoría (recortada), para poder reconstruirlo si hiciera falta
      await audit(req, u, 'db_delete', { table: meta.name, count: removed.length, rows: removed.slice(0, 50) }, `/super/db/tables/${meta.name}`);
      if (meta.name === 'app_settings') onCommit(clearSettingsCache);
    }
    return { deleted: removed.length };
  }, { tx: true });

  // ---------- API de exportación: claves ----------
  r.get('/super/api-keys', async ({ req }) => {
    await requireSuper(req);
    const keys = await q(`select k.id, k.name, k.prefix, k.scopes, k.created_at, k.expires_at, k.last_used_at, k.last_ip, k.use_count, k.revoked_at, u.name as created_by_name
      from api_keys k left join users u on u.id = k.created_by order by k.revoked_at nulls first, k.created_at desc`);
    return { keys, scopes: API_SCOPES, base: `${appUrl(req)}/api/v1` };
  });

  r.post('/super/api-keys', async ({ req, body: raw }) => {
    const u = await requireSuper(req);
    const b = parse(v.object({
      name: v.string({ min: 2, max: 80 }),
      scopes: v.array(v.enum(Object.keys(API_SCOPES)), { max: 10 }),
      expires_days: v.int({ min: 0, max: 730, default: 365 }),
    }), raw);
    const scopes = [...new Set(b.scopes)];
    if (!scopes.length) throw bad('Elegí al menos un permiso para la clave');
    const active = await one('select count(*)::int as n from api_keys where revoked_at is null');
    if (active.n >= 50) throw bad('Hay demasiadas claves activas. Revocá las que no se usan.');
    const k = generateApiKey();
    const row = await one(`insert into api_keys(name,prefix,key_hash,scopes,created_by,expires_at)
      values ($1,$2,$3,$4,$5, case when $6::int > 0 then now() + make_interval(days => $6::int) else null end)
      returning id,name,prefix,scopes,created_at,expires_at`, [b.name, k.prefix, k.hash, scopes, u.id, b.expires_days]);
    await audit(req, u, 'api_key_created', { id: row.id, name: row.name, scopes });
    // La clave completa se muestra UNA sola vez: en la base queda solo su hash
    return { ...row, key: k.key };
  });

  r.del('/super/api-keys/:id', async ({ req, params }) => {
    const u = await requireSuper(req);
    const row = await one('update api_keys set revoked_at=now() where id=$1 and revoked_at is null returning id,name', [idParam(params.id)]);
    if (!row) throw bad('La clave no existe o ya estaba revocada');
    await audit(req, u, 'api_key_revoked', { id: row.id, name: row.name });
    return { ok: true };
  });
}
