// API de exportación (solo lectura), versionada en /api/v1. Se usa con una clave que crea el superadmin.
// Pensada para Power BI, el BI propio u otros sistemas: paginación por cursor, filtro updated_since y salida JSON o CSV.
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { HttpError, send, int } from '../http.js';
import { hit, TooManyRequests } from '../ratelimit.js';
import { clientIp } from '../audit.js';
import { appUrl } from '../mail.js';
import { portfolioRows, PORTFOLIO_STATUS } from '../portfolio.js';
import { toCsv } from '../xlsx.js';
import { stripHtml } from '../tickets-core.js';

export const API_SCOPES = {
  tickets: 'Tickets (con su conversación)',
  projects: 'Proyectos, etapas, tareas y portfolio',
  time: 'Horas registradas',
};
const PER_MINUTE = Number(process.env.API_RATE_PER_MINUTE || 240);
const MAX_LIMIT = 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Clave nueva: hd_ + 43 caracteres aleatorios (256 bits). En la base queda solo el SHA-256. */
export function generateApiKey() {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { key: `hd_${secret}`, prefix: `hd_${secret.slice(0, 6)}`, hash: sha256(`hd_${secret}`) };
}

async function apiAuth(req, scope) {
  const auth = String(req.headers.authorization || '');
  const key = (auth.match(/^Bearer\s+(\S+)$/i)?.[1] || String(req.headers['x-api-key'] || '')).trim();
  const ip = clientIp(req);
  const fail = async (status, msg) => {
    // Intentos con claves inválidas: límite por IP
    const r = await hit(`api:fail:${ip}`, 900);
    if (r.count > 30) throw new TooManyRequests('Demasiados intentos con claves inválidas. Esperá unos minutos.', r.reset);
    throw new HttpError(status, msg);
  };
  if (!key) return fail(401, 'Falta la clave de API. Mandala en el encabezado "Authorization: Bearer hd_…" (o "X-API-Key").');
  if (!/^hd_[\w-]{40,64}$/.test(key)) return fail(401, 'Clave de API con formato inválido');
  const row = await one('select * from api_keys where key_hash=$1', [sha256(key)]);
  if (!row || row.revoked_at) return fail(401, 'Clave de API inválida o revocada');
  if (row.expires_at && new Date(row.expires_at) < new Date()) return fail(401, 'La clave de API venció. Pedile una nueva al superadministrador.');
  if (scope && !row.scopes.includes(scope)) throw new HttpError(403, `La clave no tiene permiso para "${scope}"`);
  const r = await hit(`api:key:${row.id}`, 60);
  if (r.count > PER_MINUTE) throw new TooManyRequests(`Límite de ${PER_MINUTE} pedidos por minuto para esta clave`, r.reset);
  await q('update api_keys set last_used_at=now(), last_ip=$2, use_count=use_count+1 where id=$1', [row.id, ip]);
  req._apiKey = row;
  return row;
}

// ---------- Paginación ----------
const encodeCursor = (ts, id) => Buffer.from(JSON.stringify([ts instanceof Date ? ts.toISOString() : ts, id])).toString('base64url');
function decodeCursor(c) {
  if (!c) return null;
  try {
    const [ts, id] = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
    if (Number.isNaN(Date.parse(ts)) || !Number.isInteger(id)) throw new Error('x');
    return { ts, id };
  } catch {
    throw new HttpError(400, 'El parámetro cursor es inválido');
  }
}
function dateParam(query, name) {
  const v = query[name];
  if (v === undefined || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(String(v)) || Number.isNaN(Date.parse(v))) {
    throw new HttpError(400, `El parámetro ${name} tiene que ser una fecha ISO 8601 (ej. 2026-10-01 o 2026-10-01T00:00:00Z)`);
  }
  return new Date(v).toISOString();
}
function limitParam(query) {
  if (query.limit === undefined || query.limit === '') return 200;
  const n = Number(query.limit);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'El parámetro limit tiene que ser un entero positivo');
  return Math.min(MAX_LIMIT, n);
}

/**
 * Consulta paginada por (columna de orden, id). where: condiciones extra ya parametrizadas.
 * Devuelve { data, next_cursor, has_more }.
 */
async function page({ select, from, where = [], params = [], col, query }) {
  const limit = limitParam(query);
  const cur = decodeCursor(query.cursor);
  const p = [...params];
  const w = [...where];
  const since = dateParam(query, 'updated_since');
  if (since) { p.push(since); w.push(`${col} >= $${p.length}::timestamptz`); }
  if (cur) { p.push(cur.ts, cur.id); w.push(`(${col}, ${from.alias}.id) > ($${p.length - 1}::timestamptz, $${p.length}::int)`); }
  p.push(limit + 1);
  // El cursor lleva la marca de tiempo con microsegundos (si se redondeara a milisegundos, una fila podría repetirse sin fin)
  const rows = await q(`select ${select}, to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _cursor_ts from ${from.sql} ${w.length ? `where ${w.join(' and ')}` : ''} order by ${col}, ${from.alias}.id limit $${p.length}`, p);
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, has_more: more, next_cursor: more && last ? encodeCursor(last._cursor_ts, last.id) : null };
}

/** Responde JSON o CSV (?format=csv). Quita los campos internos de paginación. */
function respond(ctx, out, { csvColumns = null } = {}) {
  const clean = (r) => { const { _cursor_ts: _c, ...rest } = r; return rest; };
  const data = out.data.map(clean);
  const fmt = String(ctx.query.format || 'json').toLowerCase();
  if (fmt === 'csv') {
    const cols = csvColumns || [...new Set(data.flatMap((r) => Object.keys(r)))].filter((k) => !data.some((r) => r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]) && !(r[k] instanceof Date)));
    const csv = toCsv([cols, ...data.map((r) => cols.map((c) => (r[c] instanceof Date ? r[c].toISOString() : r[c])))]);
    const headers = { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `inline; filename="${ctx.name || 'export'}.csv"` };
    if (out.next_cursor) headers['X-Next-Cursor'] = out.next_cursor;
    send(ctx.res, 200, csv, headers);
    return undefined;
  }
  if (fmt !== 'json') throw new HttpError(400, 'format admite json o csv');
  send(ctx.res, 200, { data, count: data.length, has_more: out.has_more ?? false, next_cursor: out.next_cursor ?? null }, { 'Content-Type': 'application/json; charset=utf-8' });
  return undefined;
}

const TICKET_SELECT = `t.id, t.number, t.subject, t.channel, t.priority,
  case t.priority when 1 then 'Baja' when 2 then 'Media' when 3 then 'Alta' when 4 then 'Urgente' end as priority_label,
  s.name as status, s.kind as status_kind, null::text as group_name, a.name as assignee, a.email as assignee_email,
  c.name as contact_name, c.email as contact_email, c.area as contact_area, co.name as company,
  cat.name as area, tc.name as tech_category, ts.name as tech_subcategory, ty.name as type, sla.name as sla,
  t.tags, t.created_at, t.updated_at, t.first_response_due, t.first_responded_at, t.resolution_due, t.resolved_at, t.closed_at,
  case when t.resolution_due is null then null
       when t.resolved_at is not null then t.resolved_at > t.resolution_due
       else t.resolution_due < now() end as sla_breached,
  round(extract(epoch from (t.first_responded_at - t.created_at)) / 3600, 2) as first_response_hours,
  round(extract(epoch from (t.resolved_at - t.created_at)) / 3600, 2) as resolution_hours,
  coalesce(tm.minutes, 0) as time_minutes`;
const TICKET_FROM = `tickets t
  left join statuses s on s.id = t.status_id left join users a on a.id = t.assignee_id
  left join contacts c on c.id = t.contact_id left join companies co on co.id = c.company_id left join categories cat on cat.id = t.category_id
  left join tech_categories tc on tc.id = t.tech_category_id left join tech_subcategories ts on ts.id = t.tech_subcategory_id
  left join ticket_types ty on ty.id = t.type_id left join sla_policies sla on sla.id = t.sla_id
  left join lateral (select sum(minutes)::int as minutes from time_entries te where te.ticket_id = t.id) tm on true`;

const PROJECT_FIELDS = (p) => ({
  id: p.id, key: p.key, name: p.name, description: p.description, type: p.type_name, origin: p.origin_name, sector: p.sector_name, area: p.area_name,
  lead: p.lead_name, lead_email: p.lead_email, status: p.portfolio_status, status_label: p.status_label, priority: p.priority, priority_label: p.priority_label,
  start_date: p.start, end_date: p.end, recurring: p.recurring, estimated_hours: p.estimated_hours === null ? null : Number(p.estimated_hours),
  logged_hours: p.logged_hours, manual_hours: Number(p.extra_hours || 0), total_hours: p.hours, progress: p.progress, progress_auto: p.progress_auto,
  progress_source: p.progress_source, expected_progress: p.expected, health: p.health, current_phase: p.current_phase,
  phase_count: p.phases.length, open_issues: Number(p.total_issues) - Number(p.done_issues), total_issues: Number(p.total_issues),
  tickets: p.ticket_numbers, archived: p.archived, created_at: p.created_at, updated_at: p.updated_at,
});

export function openApiSpec(base) {
  const listParams = [
    { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Solo lo creado o modificado desde esa fecha (para sincronizar incrementalmente)' },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 200 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Valor next_cursor de la página anterior' },
    { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
  ];
  const listResp = (desc) => ({ 200: { description: desc, content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } }, count: { type: 'integer' }, has_more: { type: 'boolean' }, next_cursor: { type: 'string', nullable: true } } } }, 'text/csv': {} } }, 401: { description: 'Sin clave o clave inválida' }, 403: { description: 'La clave no tiene ese permiso' }, 429: { description: 'Límite de pedidos (ver Retry-After)' } });
  return {
    openapi: '3.0.3',
    info: { title: 'Mesa de Ayuda · API de exportación', version: '1.0.0', description: 'API de solo lectura. Autenticación: encabezado Authorization: Bearer <clave>. Las claves las crea el superadministrador en Configuración → Superadmin → API.' },
    servers: [{ url: `${base}/api/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/tickets': { get: { summary: 'Tickets', description: 'Permiso: tickets. Orden: updated_at, id.', parameters: [...listParams, { name: 'status_kind', in: 'query', schema: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] } }, { name: 'created_since', in: 'query', schema: { type: 'string', format: 'date-time' } }], responses: listResp('Tickets') } },
      '/tickets/{number}': { get: { summary: 'Un ticket con su conversación', description: 'Permiso: tickets. Incluye notas internas.', parameters: [{ name: 'number', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Ticket' }, 404: { description: 'No existe' } } } },
      '/projects': { get: { summary: 'Proyectos con datos del portfolio y avance', description: 'Permiso: projects.', parameters: [listParams[0], listParams[3], { name: 'status', in: 'query', schema: { type: 'string', enum: Object.keys(PORTFOLIO_STATUS) } }], responses: listResp('Proyectos') } },
      '/projects/{key}': { get: { summary: 'Un proyecto con sus etapas', description: 'Permiso: projects.', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Proyecto' }, 404: { description: 'No existe' } } } },
      '/phases': { get: { summary: 'Etapas de todos los proyectos (una fila por etapa)', description: 'Permiso: projects.', parameters: [listParams[3]], responses: listResp('Etapas') } },
      '/issues': { get: { summary: 'Tareas de proyectos', description: 'Permiso: projects.', parameters: [...listParams, { name: 'project', in: 'query', schema: { type: 'string' }, description: 'Clave del proyecto' }], responses: listResp('Tareas') } },
      '/time-entries': { get: { summary: 'Horas registradas', description: 'Permiso: time. updated_since filtra por fecha de carga.', parameters: [...listParams, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: listResp('Horas') } },
      '/catalog': { get: { summary: 'Listas de referencia (estados, categorías, categorías técnicas, usuarios, tipos de proyecto). "groups" queda vacío desde la v1.9', responses: { 200: { description: 'Catálogo' } } } },
    },
  };
}

export function apiRoutes(r) {
  r.get('/v1', async ({ req, res }) => {
    const k = await apiAuth(req, null);
    send(res, 200, {
      name: 'Mesa de Ayuda · API de exportación', version: 1, key: { name: k.name, prefix: k.prefix, scopes: k.scopes, expires_at: k.expires_at },
      endpoints: ['/api/v1/tickets', '/api/v1/tickets/{number}', '/api/v1/projects', '/api/v1/projects/{key}', '/api/v1/phases', '/api/v1/issues', '/api/v1/time-entries', '/api/v1/catalog'],
      docs: `${appUrl(req)}/api/v1/openapi.json`,
    });
  }, { raw: true });

  r.get('/v1/openapi.json', async ({ req, res }) => {
    send(res, 200, openApiSpec(appUrl(req)));
  }, { raw: true });

  r.get('/v1/tickets', async (ctx) => {
    await apiAuth(ctx.req, 'tickets');
    const where = ['t.deleted_at is null', 'not t.spam'];
    const params = [];
    const kind = String(ctx.query.status_kind || '');
    if (kind) {
      if (!['open', 'pending', 'resolved', 'closed'].includes(kind)) throw new HttpError(400, 'status_kind admite open, pending, resolved o closed');
      params.push(kind);
      where.push(`s.kind = $${params.length}`);
    }
    const created = dateParam(ctx.query, 'created_since');
    if (created) { params.push(created); where.push(`t.created_at >= $${params.length}::timestamptz`); }
    const out = await page({ select: TICKET_SELECT, from: { sql: TICKET_FROM, alias: 't' }, where, params, col: 't.updated_at', query: ctx.query });
    return respond({ ...ctx, name: 'tickets' }, out);
  }, { raw: true });

  r.get('/v1/tickets/:number', async ({ req, res, params }) => {
    await apiAuth(req, 'tickets');
    const t = await one(`select ${TICKET_SELECT} from ${TICKET_FROM} where t.number = $1 and t.deleted_at is null and not t.spam`, [int(params.number)]);
    if (!t) throw new HttpError(404, 'No existe el ticket');
    const messages = await q(`select m.id, m.kind, m.created_at, m.from_email, m.to_emails, m.cc_emails, u.name as author_user, c.name as author_contact, m.body_html,
        (select coalesce(array_agg(a.filename order by a.id), '{}') from attachments a where a.ticket_message_id = m.id) as attachments
      from ticket_messages m left join users u on u.id = m.author_user_id left join contacts c on c.id = m.author_contact_id
      where m.ticket_id = $1 order by m.created_at, m.id`, [t.id]);
    const ticket = t;
    send(res, 200, { data: { ...ticket, messages: messages.map(({ body_html: html, ...m }) => ({ ...m, body_text: stripHtml(html || '') })) } });
  }, { raw: true });

  r.get('/v1/projects', async (ctx) => {
    await apiAuth(ctx.req, 'projects');
    let rows = await portfolioRows();
    const since = dateParam(ctx.query, 'updated_since');
    if (since) rows = rows.filter((p) => new Date(p.updated_at) >= new Date(since));
    const st = String(ctx.query.status || '');
    if (st) {
      if (!PORTFOLIO_STATUS[st]) throw new HttpError(400, `status admite ${Object.keys(PORTFOLIO_STATUS).join(', ')}`);
      rows = rows.filter((p) => p.portfolio_status === st);
    }
    return respond({ ...ctx, name: 'projects' }, { data: rows.map(PROJECT_FIELDS) });
  }, { raw: true });

  r.get('/v1/projects/:key', async ({ req, res, params }) => {
    await apiAuth(req, 'projects');
    if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(String(params.key))) throw new HttpError(400, 'Clave inválida');
    const [p] = await portfolioRows({ keys: [params.key] });
    if (!p) throw new HttpError(404, 'No existe el proyecto');
    send(res, 200, {
      data: {
        ...PROJECT_FIELDS(p),
        phases: p.phases.map((f, i) => ({ order: i + 1, key: f.key, name: f.title, start_date: f.start_date, due_date: f.due_date, progress: f.pct, state: f.state, tasks: Number(f.children), tasks_done: Number(f.children_done) })),
      },
    });
  }, { raw: true });

  r.get('/v1/phases', async (ctx) => {
    await apiAuth(ctx.req, 'projects');
    const rows = await portfolioRows();
    const data = rows.flatMap((p) => p.phases.map((f, i) => ({
      project_key: p.key, project: p.name, order: i + 1, phase_key: f.key, phase: f.title, start_date: f.start_date, due_date: f.due_date,
      progress: f.pct, state: f.state, tasks: Number(f.children), tasks_done: Number(f.children_done),
    })));
    return respond({ ...ctx, name: 'phases' }, { data });
  }, { raw: true });

  r.get('/v1/issues', async (ctx) => {
    await apiAuth(ctx.req, 'projects');
    const where = [];
    const params = [];
    if (ctx.query.project) {
      if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(String(ctx.query.project))) throw new HttpError(400, 'project tiene que ser la clave de un proyecto');
      params.push(String(ctx.query.project).toUpperCase());
      where.push(`upper(p.key) = $${params.length}`);
    }
    const out = await page({
      select: `i.id, i.key, p.key as project_key, p.name as project, i.type, i.title, ps.name as status, ps.kind as status_kind, i.priority,
        a.name as assignee, a.email as assignee_email, rp.name as reporter, par.key as parent_key, sp.name as sprint, i.story_points, i.estimate_minutes,
        i.labels, i.start_date, i.due_date, i.progress, i.resolved_at, i.created_at, i.updated_at, coalesce(tm.minutes, 0) as time_minutes`,
      from: {
        alias: 'i',
        sql: `issues i join projects p on p.id = i.project_id left join project_statuses ps on ps.id = i.status_id left join users a on a.id = i.assignee_id
          left join users rp on rp.id = i.reporter_id left join issues par on par.id = i.parent_id left join sprints sp on sp.id = i.sprint_id
          left join lateral (select sum(minutes)::int as minutes from time_entries te where te.issue_id = i.id) tm on true`,
      },
      where, params, col: 'i.updated_at', query: ctx.query,
    });
    return respond({ ...ctx, name: 'issues' }, out);
  }, { raw: true });

  r.get('/v1/time-entries', async (ctx) => {
    await apiAuth(ctx.req, 'time');
    const where = [];
    const params = [];
    for (const [name, op] of [['from', '>='], ['to', '<=']]) {
      const v = ctx.query[name];
      if (!v) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${name} tiene que ser una fecha AAAA-MM-DD`);
      params.push(v);
      where.push(`e.spent_on ${op} $${params.length}::date`);
    }
    const out = await page({
      select: `e.id, e.spent_on, e.minutes, round(e.minutes / 60.0, 2) as hours, u.name as user_name, u.email as user_email, t.number as ticket_number,
        i.key as issue_key, p.key as project_key, e.note, e.created_at`,
      from: {
        alias: 'e',
        sql: `time_entries e left join users u on u.id = e.user_id left join tickets t on t.id = e.ticket_id
          left join issues i on i.id = e.issue_id left join projects p on p.id = i.project_id`,
      },
      where, params, col: 'e.created_at', query: ctx.query,
    });
    return respond({ ...ctx, name: 'time-entries' }, out);
  }, { raw: true });

  r.get('/v1/catalog', async ({ req, res }) => {
    await apiAuth(req, null);
    const [statuses, categories, tech, sub, types, users, ptypes, opts] = await Promise.all([
      q('select id, name, kind, active from statuses order by sort, id'),
      q('select id, name, description, active from categories order by sort, name'),
      q('select id, name, active from tech_categories order by sort, name'),
      q('select id, tech_category_id, name, active from tech_subcategories order by tech_category_id, sort, name'),
      q('select id, name, active from ticket_types order by sort, name'),
      q(`select id, name, email, role, active from users where role <> 'superadmin' order by name`),
      q('select id, name, phases, active from project_types order by sort, id'),
      q('select id, kind, name, active from portfolio_options order by kind, sort, name'),
    ]);
    send(res, 200, {
      data: {
        statuses, groups: [], areas: categories, tech_categories: tech, tech_subcategories: sub, ticket_types: types, users, project_types: ptypes,
        origins: opts.filter((o) => o.kind === 'origin'), sectors: opts.filter((o) => o.kind === 'sector'),
        project_statuses: Object.entries(PORTFOLIO_STATUS).map(([id, name]) => ({ id, name })),
      },
    });
  }, { raw: true });
}
