// Informes (v1.14): roadmap de todos los proyectos, calendario con capas y explorador de datos con vistas guardadas.
// Solo para supervisores y administradores (los mismos que ven Informes).
import { requireUser } from '../auth.js';
import { q, one } from '../db.js';
import { v, parse } from '../validate.js';
import { bad, forbidden, notFound, int } from '../http.js';
import { portfolioRows, PORTFOLIO_STATUS } from '../portfolio.js';
import { getSetting } from '../settings.js';
import { todayLocal } from './portfolio.js';

const MANAGERS = ['admin', 'supervisor'];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));
const iso = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (s) => { const d = new Date(`${s}T00:00:00Z`); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); return d.toISOString().slice(0, 10); };
const ROW_CAP = 5000;

/** Carga del equipo: tareas abiertas por persona y por semana (una tarea cuenta en cada semana que abarca). */
export async function teamLoad(today, weeks = 12) {
  const start = mondayOf(today);
  const cols = Array.from({ length: weeks }, (_, i) => addDays(start, i * 7));
  const rows = await q(`select i.assignee_id as user_id, i.start_date, i.due_date, i.created_at
    from issues i join users u on u.id=i.assignee_id and u.active
    join projects p on p.id=i.project_id and not p.archived and p.portfolio_status not in ('done','cancelled')
    left join project_statuses s on s.id=i.status_id
    where i.type<>'epic' and coalesce(s.kind,'todo')<>'done'`);
  const out = {};
  for (const r of rows) {
    const due = iso(r.due_date);
    const from = iso(r.start_date) || (due && due < start ? due : start);
    const to = due || from; // sin vencimiento: cuenta en la semana en que arranca (o en la actual)
    const counts = (out[r.user_id] ||= cols.map(() => 0));
    cols.forEach((w, i) => { const we = addDays(w, 6); if (from <= we && (to >= w || (i === 0 && to < w))) counts[i] += 1; });
  }
  return { weeks: cols, users: Object.entries(out).map(([id, counts]) => ({ id: Number(id), counts })) };
}

/** Eventos del calendario entre dos fechas (capas: proyectos, etapas, tareas, SLA, sprints, sistemas críticos, feriados). */
export async function calendarEvents(from, to) {
  const ev = [];
  const inRange = (d) => d && d >= from && d <= to;
  const projects = (await portfolioRows()).filter((p) => !p.archived);
  for (const p of projects) {
    if (inRange(p.start)) ev.push({ layer: 'project', date: p.start, title: `Inicio ${p.key} · ${p.name}`, user_id: p.lead_id, project: p.key, color: p.color });
    if (inRange(p.end)) ev.push({ layer: 'project', date: p.end, title: `Fin ${p.key} · ${p.name}`, user_id: p.lead_id, project: p.key, color: p.color, done: p.portfolio_status === 'done', milestone: true });
    for (const f of p.phases) {
      if (inRange(f.start_date)) ev.push({ layer: 'phase', date: f.start_date, title: `${p.key} · empieza ${f.title}`, user_id: f.assignee_id || p.lead_id, project: p.key, issue: f.key });
      if (inRange(f.due_date)) ev.push({ layer: 'phase', date: f.due_date, title: `${p.key} · termina ${f.title}`, user_id: f.assignee_id || p.lead_id, project: p.key, issue: f.key, done: f.state === 'done' });
    }
  }
  const [tasks, tickets, sprints, crit, hd] = await Promise.all([
    q(`select i.key, i.title, i.due_date, i.assignee_id, p.key as project, coalesce(s.kind,'todo') as kind
       from issues i join projects p on p.id=i.project_id and not p.archived left join project_statuses s on s.id=i.status_id
       where i.type<>'epic' and i.due_date between $1::date and $2::date`, [from, to]),
    q(`select t.number, t.subject, t.resolution_due, t.assignee_id from tickets t join statuses s on s.id=t.status_id
       where t.deleted_at is null and not t.spam and t.merged_into is null and s.kind in ('open','pending')
         and t.resolution_due >= $1::date and t.resolution_due < ($2::date + 1)`, [from, to]),
    q(`select s.id, s.name, s.start_date, s.end_date, s.state, p.key as project, p.lead_id from sprints s join projects p on p.id=s.project_id and not p.archived
       where s.start_date is not null and s.end_date is not null and s.start_date <= $2::date and s.end_date >= $1::date`, [from, to]),
    q(`select name, state, eta, message from critical_systems where active and state<>'ok' and eta is not null and eta >= $1::date and eta < ($2::date + 1)`, [from, to]),
    getSetting('helpdesk'),
  ]);
  for (const t of tasks) ev.push({ layer: 'task', date: iso(t.due_date), title: `${t.key} ${t.title}`, user_id: t.assignee_id, project: t.project, issue: t.key, done: t.kind === 'done' });
  const tz = hd?.timezone || 'America/Argentina/Buenos_Aires';
  const localDay = (d) => todayLocalAt(d, tz);
  for (const t of tickets) ev.push({ layer: 'sla', date: localDay(t.resolution_due), title: `#${t.number} ${t.subject}`, user_id: t.assignee_id, ticket: t.number });
  for (const s of sprints) ev.push({ layer: 'sprint', date: iso(s.start_date), end: iso(s.end_date), title: `${s.name} · ${s.project}`, user_id: s.lead_id, project: s.project, done: s.state === 'closed' });
  const STATE = { degraded: 'con problemas', down: 'caído', maint: 'en mantenimiento' };
  for (const c of crit) ev.push({ layer: 'critical', date: localDay(c.eta), title: `${c.name} ${STATE[c.state] || ''}: vuelve (estimado)`, note: c.message });
  for (const h of hd?.holidays || []) {
    const d = typeof h === 'string' ? h : h?.date;
    if (inRange(d)) ev.push({ layer: 'holiday', date: d, title: (typeof h === 'object' && h?.name) || 'Feriado' });
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}
function todayLocalAt(d, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d)); } catch { return iso(d); }
}

/** Datos crudos para el explorador: una lista por fuente, con los nombres ya resueltos. */
export async function explorerData(sources, { from, to } = {}) {
  const out = { truncated: {} };
  const cap = (k, rows) => { if (rows.length > ROW_CAP) { out.truncated[k] = rows.length; return rows.slice(0, ROW_CAP); } return rows; };
  const dateRange = from && to ? ' and t.created_at >= $1::date and t.created_at < ($2::date + 1)' : '';
  const params = from && to ? [from, to] : [];
  const jobs = {
    ticket: async () => cap('ticket', await q(`select t.number, t.subject, t.channel, t.priority, t.tags, t.cc, t.custom,
        t.created_at, t.updated_at, t.last_activity_at, t.first_response_due, t.resolution_due, t.first_responded_at, t.resolved_at, t.closed_at, t.sla_paused_at,
        s.name as status, s.kind as status_kind, g.name as group_name, tc.name as tech, ts.name as subtech, ty.name as ticket_type, c.name as area,
        u.name as assignee, t.assignee_id, cb.name as created_by, sp.name as sla_policy,
        ct.name as contact, ct.email as contact_email, ct.area as contact_area, ct.job_title as contact_job, ct.vip as contact_vip, co.name as company,
        (t.ai->'auto') is not null as ai_auto,
        coalesce((select sum(minutes) from time_entries e where e.ticket_id=t.id), 0)::int as minutes,
        (select count(*) from ticket_messages m where m.ticket_id=t.id)::int as messages,
        (select array_agg(p.key order by p.key) from ticket_projects tp join projects p on p.id=tp.project_id where tp.ticket_id=t.id) as projects,
        (select min(cs.name) from critical_system_tickets l join critical_systems cs on cs.id=l.system_id where l.ticket_id=t.id) as critical_system
      from tickets t
      left join statuses s on s.id=t.status_id left join agent_groups g on g.id=t.group_id left join tech_categories tc on tc.id=t.tech_category_id
      left join tech_subcategories ts on ts.id=t.tech_subcategory_id left join ticket_types ty on ty.id=t.type_id left join categories c on c.id=t.category_id
      left join users u on u.id=t.assignee_id left join users cb on cb.id=t.created_by left join sla_policies sp on sp.id=t.sla_id
      left join contacts ct on ct.id=t.contact_id left join companies co on co.id=ct.company_id
      where t.deleted_at is null and not t.spam and t.merged_into is null${dateRange}
      order by t.number desc limit ${ROW_CAP + 1}`, params)),
    project: async () => {
      const [rows, members] = await Promise.all([portfolioRows(), q('select m.project_id, u.name from project_members m join users u on u.id=m.user_id order by u.name')]);
      const byP = {};
      for (const m of members) (byP[m.project_id] ||= []).push(m.name);
      const base = Object.fromEntries((await q('select id, baseline_end from projects')).map((x) => [x.id, iso(x.baseline_end)]));
      return rows.map((p) => ({
        id: p.id, key: p.key, name: p.name, description: p.description, type: p.type_name, origin: p.origin_name, sector: p.sector_name, area: p.area_name,
        lead: p.lead_name, lead_id: p.lead_id, status: PORTFOLIO_STATUS[p.portfolio_status] || p.portfolio_status, status_kind: p.portfolio_status, priority: p.priority,
        start: p.start, end: p.end, baseline_end: base[p.id] || null, progress: p.progress, progress_source: p.progress_source, health: p.health, current_phase: p.current_phase,
        estimated_hours: p.estimated_hours === null ? null : Number(p.estimated_hours), logged_hours: p.logged_hours, hours: p.hours, extra_hours: Number(p.extra_hours || 0),
        recurring: p.recurring, archived: p.archived, tickets: p.ticket_numbers || [], phases: p.phases.length, total_issues: Number(p.total_issues), done_issues: Number(p.done_issues),
        members: byP[p.id] || [], created_at: p.created_at, updated_at: p.updated_at,
      }));
    },
    task: async () => cap('task', await q(`select i.key, i.title, i.type, i.priority, i.story_points, i.estimate_minutes, i.labels, i.start_date, i.due_date, i.progress,
        i.resolved_at, i.created_at, i.updated_at, s.name as status, coalesce(s.kind,'todo') as status_kind, u.name as assignee, i.assignee_id, r.name as reporter,
        p.key as project, p.name as project_name, c.name as area, par.key as parent_key, par.title as parent_title, par.type as parent_type, sp.name as sprint,
        coalesce((select sum(minutes) from time_entries e where e.issue_id=i.id), 0)::int as minutes
      from issues i join projects p on p.id=i.project_id left join project_statuses s on s.id=i.status_id left join users u on u.id=i.assignee_id
      left join users r on r.id=i.reporter_id left join issues par on par.id=i.parent_id left join sprints sp on sp.id=i.sprint_id left join categories c on c.id=p.area_id
      order by p.key, i.number limit ${ROW_CAP + 1}`)),
    contact: async () => cap('contact', await q(`select ct.name, ct.email, ct.phone, ct.area, ct.job_title, ct.manager, ct.vip, ct.active, ct.created_at, co.name as company,
        (select count(*) from tickets t where t.contact_id=ct.id and t.deleted_at is null and not t.spam)::int as tickets,
        (select count(*) from tickets t join statuses s on s.id=t.status_id where t.contact_id=ct.id and t.deleted_at is null and not t.spam and s.kind in ('open','pending'))::int as open_tickets
      from contacts ct left join companies co on co.id=ct.company_id order by ct.name limit ${ROW_CAP + 1}`)),
    time: async () => cap('time', await q(`select e.minutes, e.note, e.spent_on, e.created_at, u.name as user_name, e.user_id, t.number as ticket, i.key as issue, p.key as project
      from time_entries e left join users u on u.id=e.user_id left join tickets t on t.id=e.ticket_id left join issues i on i.id=e.issue_id left join projects p on p.id=i.project_id
      ${from && to ? 'where e.spent_on between $1::date and $2::date' : ''} order by e.spent_on desc limit ${ROW_CAP + 1}`, params)),
  };
  for (const s of sources) if (jobs[s]) out[s] = await jobs[s]();
  return out;
}

const viewSchema = v.object({
  name: v.string({ min: 1, max: 120 }),
  shared: v.bool({ default: false }),
  config: v.any(),
});

function checkView(b) {
  if (!b.config || typeof b.config !== 'object' || Array.isArray(b.config)) throw bad('La configuración de la vista no es válida');
  if (JSON.stringify(b.config).length > 20000) throw bad('La vista es demasiado grande');
  return b;
}

export function reportsPlusRoutes(r) {
  r.get('/reports/roadmap', async ({ req }) => {
    await requireUser(req, MANAGERS);
    const hd = await getSetting('helpdesk');
    const today = todayLocal(hd?.timezone);
    const [rows, base, load] = await Promise.all([portfolioRows(), q('select id, baseline_end from projects'), teamLoad(today)]);
    const b = Object.fromEntries(base.map((x) => [x.id, iso(x.baseline_end)]));
    return { today, statuses: PORTFOLIO_STATUS, rows: rows.filter((p) => !p.archived).map((p) => ({ ...p, baseline_end: b[p.id] || null })), load };
  });

  r.get('/reports/calendar', async ({ req, query }) => {
    await requireUser(req, MANAGERS);
    const hd = await getSetting('helpdesk');
    const today = todayLocal(hd?.timezone);
    const from = isDate(query.from) ? query.from : addDays(today, -40);
    let to = isDate(query.to) ? query.to : addDays(today, 60);
    if (to < from) throw bad('El rango de fechas no es válido');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 400) to = addDays(from, 400);
    return { today, from, to, events: await calendarEvents(from, to) };
  });

  r.get('/reports/explorer', async ({ req, query }) => {
    await requireUser(req, MANAGERS);
    const sources = String(query.sources || 'ticket,project').split(',').filter((s) => ['ticket', 'project', 'task', 'contact', 'time'].includes(s));
    if (!sources.length) throw bad('Elegí al menos un tipo de dato');
    const from = isDate(query.from) ? query.from : null;
    const to = isDate(query.to) ? query.to : null;
    if (from && to && to < from) throw bad('El rango de fechas no es válido');
    return { sources, from, to, cap: ROW_CAP, ...(await explorerData(sources, { from, to })) };
  });

  // Vistas guardadas del explorador: propias o compartidas con los demás supervisores
  r.get('/reports/views', async ({ req }) => {
    const u = await requireUser(req, MANAGERS);
    return q(`select v.id, v.name, v.shared, v.config, v.owner_id, u.name as owner_name, v.updated_at from report_views v left join users u on u.id=v.owner_id
      where v.owner_id=$1 or v.shared order by v.name`, [u.id]);
  });
  r.post('/reports/views', async ({ req, body }) => {
    const u = await requireUser(req, MANAGERS);
    const b = checkView(parse(viewSchema, body));
    return one('insert into report_views(owner_id,name,shared,config) values ($1,$2,$3,$4::jsonb) returning *', [u.id, b.name.trim(), b.shared, JSON.stringify(b.config)]);
  });
  const ownView = async (u, id) => {
    const row = await one('select * from report_views where id=$1', [int(id)]);
    if (!row || (row.owner_id !== u.id && !row.shared)) throw notFound('La vista no existe');
    if (row.owner_id !== u.id && !['admin', 'superadmin'].includes(u.role)) throw forbidden('Solo quien creó la vista (o un administrador) puede cambiarla');
    return row;
  };
  r.put('/reports/views/:id', async ({ req, params, body }) => {
    const u = await requireUser(req, MANAGERS);
    await ownView(u, params.id);
    const b = checkView(parse(viewSchema, body));
    return one('update report_views set name=$2, shared=$3, config=$4::jsonb, updated_at=now() where id=$1 returning *', [int(params.id), b.name.trim(), b.shared, JSON.stringify(b.config)]);
  });
  r.del('/reports/views/:id', async ({ req, params }) => {
    const u = await requireUser(req, MANAGERS);
    await ownView(u, params.id);
    await q('delete from report_views where id=$1', [int(params.id)]);
    return { ok: true };
  });
}
