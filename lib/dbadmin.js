// Explorador de la base de datos para el superadministrador: ver, buscar, modificar y borrar registros.
// Los nombres de tablas y columnas nunca salen del pedido: se validan contra el catálogo de Postgres
// y recién ahí se citan como identificadores. Los valores van siempre como parámetros.
import { q, one } from './db.js';
import { HttpError } from './http.js';
import { sanitizeHtml } from './sanitize.js';

// Tablas técnicas que no se muestran (se regeneran solas o tienen su propia pantalla).
export const HIDDEN_TABLES = new Set(['sessions', 'webauthn_challenges', 'idempotency_keys', 'rate_limits']);
// Solo lectura: el historial de la auditoría y de las migraciones no se toca; las claves de API se revocan desde su sección.
export const READ_ONLY_TABLES = new Set(['audit_log', 'schema_migrations', 'api_keys']);
// Se pueden borrar registros pero no editarlos (ej. quitar una passkey perdida o un adjunto).
export const DELETE_ONLY_TABLES = new Set(['webauthn_credentials', 'attachments']);
// Columnas con secretos o hashes: no se muestran ni se editan.
export const isSecretColumn = (name) => /^password$|(^|_)(secret|token)(_|$)|hash$|^public_key$/i.test(name);
// Valores de sistema que, mal cambiados, dejan a todos afuera o rompen las migraciones: se manejan desde la app.
export const PROTECTED_SETTINGS = new Set(['session_epoch', 'schema_version', 'installed_at', 'ai_rules_seeded']);
const COUNT_CAP = 100000;
// Columnas con archivos: se muestra el tamaño, no el contenido.
const isBlobColumn = (table, name, type) => type === 'bytea' || (table === 'attachments' && name === 'data_b64');

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const SAFE_TYPE = /^[a-z0-9_ ,()[\]"]+$/i;
export const MAX_PAGE = 200;
const LIST_TEXT = 300;

/** Tipo de dato simplificado para la pantalla y la validación. */
export function kindOf(type) {
  if (type.endsWith('[]')) return 'array';
  if (type === 'boolean') return 'bool';
  if (['smallint', 'integer', 'bigint'].includes(type)) return 'int';
  if (/^(numeric|double precision|real)/.test(type)) return 'num';
  if (type === 'date') return 'date';
  if (type.startsWith('timestamp')) return 'ts';
  if (type === 'json' || type === 'jsonb') return 'json';
  return 'text';
}

export async function listTables() {
  const rows = await q(`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=current_schema() and c.relkind='r' order by c.relname`);
  const names = rows.map((r) => r.name).filter((n) => IDENT.test(n) && !HIDDEN_TABLES.has(n));
  if (!names.length) return [];
  // Conteo en una sola consulta, con tope para que una tabla enorme no frene la pantalla (los nombres salen del catálogo)
  const counts = await q(names.map((n) => `select '${n}' as name, (select count(*) from (select 1 from ${quote(n)} limit ${COUNT_CAP + 1}) x)::bigint as n`).join(' union all '));
  const byName = Object.fromEntries(counts.map((c) => [c.name, Number(c.n)]));
  // Todas las claves primarias en una consulta
  const pks = await q(`select c.relname as table, count(*)::int as n from pg_index i join pg_class c on c.oid=i.indrelid
    join pg_namespace s on s.oid=c.relnamespace where s.nspname=current_schema() and i.indisprimary group by c.relname`);
  const hasPk = new Set(pks.map((p) => p.table));
  return names.map((n) => ({ name: n, rows: Math.min(byName[n] ?? 0, COUNT_CAP), capped: (byName[n] ?? 0) > COUNT_CAP, mode: tableMode(n, hasPk.has(n) ? ['pk'] : []) }));
}

async function primaryKey(table) {
  const rows = await q(`select a.attname as name from pg_index i
    join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey)
    where n.nspname=current_schema() and c.relname=$1 and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`, [table]);
  return rows.map((r) => r.name);
}

function tableMode(table, pk) {
  if (READ_ONLY_TABLES.has(table) || !pk.length) return 'read';
  if (DELETE_ONLY_TABLES.has(table)) return 'delete';
  return 'edit';
}

/** Estructura de una tabla: columnas con su tipo, clave primaria, referencias y qué se borra en cascada. */
export async function tableMeta(table) {
  const name = String(table || '');
  if (!IDENT.test(name) || HIDDEN_TABLES.has(name)) throw new HttpError(404, 'No existe esa tabla');
  const exists = await one(`select c.oid::int as oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=current_schema() and c.relkind='r' and c.relname=$1`, [name]);
  if (!exists) throw new HttpError(404, 'No existe esa tabla');
  const [cols, pk, fks, refs] = await Promise.all([
    q(`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
        pg_get_expr(d.adbin, d.adrelid) as "default"
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [exists.oid]),
    primaryKey(name),
    q(`select a.attname as col, rc.relname as ref_table, ra.attname as ref_col
      from pg_constraint k join pg_class rc on rc.oid=k.confrelid
      join pg_attribute a on a.attrelid=k.conrelid and a.attnum=k.conkey[1]
      join pg_attribute ra on ra.attrelid=k.confrelid and ra.attnum=k.confkey[1]
      where k.conrelid=$1 and k.contype='f' and array_length(k.conkey,1)=1`, [exists.oid]),
    q(`select c.relname as table, a.attname as col, k.confdeltype as on_delete
      from pg_constraint k join pg_class c on c.oid=k.conrelid
      join pg_attribute a on a.attrelid=k.conrelid and a.attnum=k.conkey[1]
      where k.confrelid=$1 and k.contype='f' order by c.relname`, [exists.oid]),
  ]);
  const fkBy = Object.fromEntries(fks.map((f) => [f.col, { table: f.ref_table, column: f.ref_col }]));
  const columns = cols.filter((c) => IDENT.test(c.name)).map((c) => ({
    name: c.name, type: c.type, kind: kindOf(c.type), nullable: c.nullable, default: c.default, pk: pk.includes(c.name),
    secret: isSecretColumn(c.name), blob: isBlobColumn(name, c.name, c.type),
    fk: fkBy[c.name] && !HIDDEN_TABLES.has(fkBy[c.name].table) ? fkBy[c.name] : null,
  }));
  const ON_DELETE = { c: 'cascade', n: 'set null', d: 'set default', r: 'restrict', a: 'restrict' };
  return {
    name, pk, mode: tableMode(name, pk), columns,
    referencedBy: refs.filter((r) => IDENT.test(r.table)).map((r) => ({ table: r.table, column: r.col, onDelete: ON_DELETE[r.on_delete] || 'restrict' })),
  };
}

const visible = (meta) => meta.columns.filter((c) => !c.secret);
const editable = (meta) => (meta.mode === 'edit' ? meta.columns.filter((c) => !c.secret && !c.blob && !c.pk) : []);

/** Expresión del SELECT para una columna: los archivos como tamaño, los textos largos recortados en el listado. */
function selectExpr(meta, c, list) {
  if (c.blob) return `length(${quote(c.name)})::bigint as ${quote(c.name)}`;
  if (list && ['text', 'json', 'array'].includes(c.kind)) return `left(${quote(c.name)}::text, ${LIST_TEXT}) as ${quote(c.name)}`;
  return quote(c.name);
}

/** Condición por clave primaria: { col: valor } → "col = $n::tipo and …" (con el tipo de la columna, así usa el índice). */
function pkWhere(meta, pk, params) {
  if (!pk || typeof pk !== 'object' || Array.isArray(pk)) throw new HttpError(400, 'Falta la clave del registro');
  const parts = meta.pk.map((col) => {
    const v = pk[col];
    if (v === undefined || v === null || (typeof v === 'object')) throw new HttpError(400, `Falta el valor de la clave «${col}»`);
    const c = meta.columns.find((x) => x.name === col);
    if (!c || !SAFE_TYPE.test(c.type)) throw new HttpError(400, 'Tipo de clave no soportado');
    if (c.kind === 'int' && !/^-?\d{1,19}$/.test(String(v))) throw new HttpError(404, 'El registro ya no existe');
    params.push(c.kind === 'ts' ? new Date(String(v)).toISOString() : String(v));
    return `${quote(col)} = $${params.length}::${c.type}`;
  });
  return parts.join(' and ');
}

export async function tableRows(meta, { page = 1, size = 50, q: text = '', sort = '', dir = 'asc', col = '', val, isnull = false } = {}) {
  const cols = visible(meta);
  const params = [];
  const where = [];
  const term = String(text || '').trim().slice(0, 200);
  if (term) {
    const searchable = cols.filter((c) => !c.blob);
    params.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(${searchable.map((c) => `${quote(c.name)}::text ilike $${params.length}`).join(' or ')})`);
  }
  if (col) {
    const c = cols.find((x) => x.name === col && !x.blob);
    if (!c) throw new HttpError(400, 'Columna inválida para filtrar');
    if (isnull) where.push(`${quote(c.name)} is null`);
    else {
      params.push(String(val ?? '').slice(0, 1000));
      where.push(`${quote(c.name)}::text = $${params.length}`);
    }
  }
  const w = where.length ? `where ${where.join(' and ')}` : '';
  const sortCol = cols.find((c) => c.name === sort && !c.blob) || (meta.pk.length === 1 ? cols.find((c) => c.name === meta.pk[0]) : null) || cols[0];
  const direction = String(dir).toLowerCase() === 'desc' ? 'desc' : 'asc';
  const per = Math.max(1, Math.min(MAX_PAGE, Number(size) || 50));
  const pg = Math.max(1, Math.min(100000, Number(page) || 1));
  const order = sortCol ? `order by ${quote(sortCol.name)} ${direction} nulls last${meta.pk.filter((k) => k !== sortCol.name).map((k) => `, ${quote(k)}`).join('')}` : '';
  const [total, rows] = await Promise.all([
    one(`select count(*)::bigint as n from ${quote(meta.name)} ${w}`, params),
    q(`select ${cols.map((c) => selectExpr(meta, c, true)).join(', ')} from ${quote(meta.name)} ${w} ${order} limit ${per} offset ${(pg - 1) * per}`, params),
  ]);
  return { total: Number(total.n), page: pg, size: per, sort: sortCol?.name || null, dir: direction, rows, truncatedAt: LIST_TEXT };
}

export async function tableRow(meta, pk) {
  const params = [];
  const w = pkWhere(meta, pk, params);
  const row = await one(`select ${visible(meta).map((c) => selectExpr(meta, c, false)).join(', ')} from ${quote(meta.name)} where ${w}`, params);
  if (!row) throw new HttpError(404, 'El registro ya no existe');
  return row;
}

/** Convierte el valor que llega del formulario según el tipo de la columna (lo demás lo valida Postgres). */
function coerce(c, v) {
  if (v === null) {
    if (!c.nullable) throw new HttpError(400, `«${c.name}» no puede quedar vacío`);
    return null;
  }
  const bad = (what) => new HttpError(400, `«${c.name}»: ${what}`);
  switch (c.kind) {
    case 'bool':
      if (typeof v !== 'boolean') throw bad('tiene que ser verdadero o falso');
      return v;
    case 'int':
    case 'num': {
      // Se pasa como texto (sin pasar por Number) para no perder precisión en bigint o numeric grandes
      const s = String(v).trim().replace(',', '.');
      const re = c.kind === 'int' ? /^-?\d{1,19}$/ : /^-?\d{1,30}(\.\d{1,20})?$/;
      if (!re.test(s)) throw bad(c.kind === 'int' ? 'tiene que ser un número entero' : 'tiene que ser un número');
      return s;
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad('fecha inválida (AAAA-MM-DD)');
      return String(v);
    case 'ts':
      if (Number.isNaN(Date.parse(String(v)))) throw bad('fecha y hora inválidas');
      return new Date(String(v)).toISOString();
    case 'json':
      return JSON.stringify(v);
    case 'array':
      if (!Array.isArray(v) || v.length > 1000) throw bad('tiene que ser una lista');
      return v.map((x) => (x === null ? null : String(x)));
    default:
      if (typeof v !== 'string' && typeof v !== 'number') throw bad('tiene que ser texto');
      if (String(v).length > 1_000_000) throw bad('es demasiado largo');
      // El HTML guardado se muestra en la app: se limpia igual que cuando se carga desde las pantallas
      return /_html$/.test(c.name) ? sanitizeHtml(String(v)) : String(v);
  }
}

const AUDIT_CHARS = 2000;
const short = (v) => {
  if (v === null || v === undefined) return v ?? null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= AUDIT_CHARS) return v;
  // Corte por caracteres completos (no parte un emoji: un medio carácter rompe el JSON de la auditoría)
  return `${Array.from(s).slice(0, AUDIT_CHARS).join('')}… (${s.length} caracteres)`;
};
const same = (a, b) => JSON.stringify(a instanceof Date ? a.toISOString() : a) === JSON.stringify(b instanceof Date ? b.toISOString() : b);

/** Modifica un registro. Devuelve el registro nuevo y el detalle de cambios (para la auditoría). */
export async function updateRow(meta, pk, values, { superUserId } = {}) {
  if (meta.mode !== 'edit') throw new HttpError(403, 'Esta tabla no se puede modificar desde acá');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, 'No hay cambios');
  const cols = editable(meta);
  const before = await tableRow(meta, pk);
  guardProtectedRow(meta, before, superUserId);
  const sets = [];
  const params = [];
  const changes = {};
  for (const [k, raw] of Object.entries(values)) {
    const c = meta.columns.find((x) => x.name === k);
    if (!c) throw new HttpError(400, `No existe la columna «${k}»`);
    if (!cols.includes(c)) throw new HttpError(400, `«${k}» no se puede modificar${c.pk ? ' (es la clave)' : ''}`);
    if (meta.name === 'users' && k === 'role' && raw === 'superadmin') throw new HttpError(400, 'El rol de superadministrador no se asigna desde la base');
    if (meta.name === 'app_settings' && k === 'value' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new HttpError(400, 'La configuración tiene que ser un objeto JSON');
    const val = coerce(c, raw);
    if (!SAFE_TYPE.test(c.type)) throw new HttpError(400, `Tipo de columna no soportado: ${c.type}`);
    params.push(val);
    sets.push(`${quote(c.name)} = $${params.length}::${c.type}`);
    changes[k] = { from: short(before[k]), to: short(raw) };
  }
  if (!sets.length) return { row: before, changes: {} };
  const w = pkWhere(meta, pk, params);
  await q(`update ${quote(meta.name)} set ${sets.join(', ')} where ${w}`, params);
  const after = await tableRow(meta, pk);
  for (const k of Object.keys(changes)) if (same(before[k], after[k])) delete changes[k];
  return { row: after, changes };
}

/** El usuario superadmin (y su sesión) no se modifican ni se borran desde el explorador. */
function guardProtectedRow(meta, row, superUserId) {
  if (meta.name === 'users' && (row.role === 'superadmin' || (superUserId && Number(row.id) === Number(superUserId)))) {
    throw new HttpError(403, 'El usuario superadministrador no se modifica desde la base: se configura en Vercel');
  }
  if (meta.name === 'app_settings' && PROTECTED_SETTINGS.has(row.key)) {
    throw new HttpError(403, `«${row.key}» es un valor del sistema: se maneja desde la aplicación`);
  }
}

/** Borra registros por clave primaria (máximo 200 por vez). Devuelve una copia de lo borrado para la auditoría. */
export async function deleteRows(meta, pks, { superUserId } = {}) {
  if (!['edit', 'delete'].includes(meta.mode)) throw new HttpError(403, 'En esta tabla no se pueden borrar registros');
  if (!Array.isArray(pks) || !pks.length) throw new HttpError(400, 'No elegiste registros');
  if (pks.length > MAX_PAGE) throw new HttpError(400, `Se pueden borrar hasta ${MAX_PAGE} registros por vez`);
  const removed = [];
  for (const pk of pks) {
    const params = [];
    const w = pkWhere(meta, pk, params);
    const row = await one(`select ${visible(meta).map((c) => selectExpr(meta, c, false)).join(', ')} from ${quote(meta.name)} where ${w}`, params);
    if (!row) continue;
    guardProtectedRow(meta, row, superUserId);
    try {
      await q(`delete from ${quote(meta.name)} where ${w}`, params);
    } catch (e) {
      if ((e?.code || e?.sourceError?.code) === '23503') {
        const t = e.table || e.sourceError?.table;
        throw new HttpError(400, `No se puede borrar: hay registros${t ? ` en «${t}»` : ''} que lo usan. Borralos o cambialos primero.`);
      }
      throw e;
    }
    removed.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, short(v)])));
  }
  return removed;
}
