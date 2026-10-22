// Tablero de control del agente: alertas por antigüedad, tickets más viejos y más importantes.
import { seesAllTickets, visibleTicketsSql } from '../visibility.js';
import { q, one } from '../db.js';
import { requireUser } from '../auth.js';
import { getSetting } from '../settings.js';
import { int } from '../http.js';

export const AGING_DEFAULTS = {
  green_days: 7, // hasta acá, verde
  amber_days: 30, // hasta acá, ámbar; después, rojo
  critical_days: 90, // alerta crítica
  inactive_days: 15, // "sin actividad"
  waiting_hours: 24, // el usuario respondió y nadie contestó
  buckets: [7, 15, 30, 60, 90],
  list_size: 6,
  weights: { urgent: 40, high: 25, medium: 10, overdue: 25, due_soon: 15, waiting: 15, vip: 15, reopened: 5, age_week: 2, age_max: 20, needs_agent: 10, followers: 5 },
};

export async function agingConfig() {
  const hd = (await getSetting('helpdesk')) || {};
  const a = hd.aging || {};
  const cfg = { ...AGING_DEFAULTS, ...a, weights: { ...AGING_DEFAULTS.weights, ...(a.weights || {}) } };
  cfg.buckets = (Array.isArray(cfg.buckets) && cfg.buckets.length ? cfg.buckets : AGING_DEFAULTS.buckets).map(Number).filter((n) => n > 0).sort((x, y) => x - y);
  return cfg;
}

const DAY = 86400000;

/** Puntaje de importancia (0–100) con los motivos que lo explican. */
export function importance(t, cfg, now = Date.now()) {
  const w = cfg.weights;
  const reasons = [];
  const add = (pts, label, kind = '') => { if (pts > 0) reasons.push({ pts, label, kind }); };
  add({ 4: w.urgent, 3: w.high, 2: w.medium }[t.priority] || 0, `Prioridad ${{ 4: 'Urgente', 3: 'Alta', 2: 'Media' }[t.priority] || ''}`.trim(), t.priority >= 3 ? 'danger' : '');
  const due = t.resolution_due ? new Date(t.resolution_due).getTime() : null;
  if (due && !t.sla_paused_at) {
    if (due < now) add(w.overdue, `SLA vencido hace ${Math.max(1, Math.round((now - due) / DAY))} d`, 'danger');
    else if (due - now < DAY) add(w.due_soon, 'Vence en menos de 24 h', 'warn');
  }
  if (t.waiting) add(w.waiting, `El usuario respondió ${t.waiting_hours < 48 ? `hace ${Math.round(t.waiting_hours)} h` : `hace ${Math.round(t.waiting_hours / 24)} d`}`, 'info');
  if (t.vip) add(w.vip, 'Usuario VIP', 'info');
  if (t.reopened) add(Math.min(w.reopened * t.reopened, w.reopened * 2), t.reopened === 1 ? 'Reabierto' : `Reabierto ${t.reopened} veces`, 'warn');
  if (t.needs_agent) add(w.needs_agent, 'La respuesta automática no le sirvió', 'warn');
  if (t.followers >= 3) add(w.followers, `${t.followers} seguidores`, '');
  const ageDays = (now - new Date(t.created_at).getTime()) / DAY;
  add(Math.min(w.age_max, Math.round((ageDays / 7) * w.age_week)), `${Math.floor(ageDays)} días abierto`, '');
  reasons.sort((a, b) => b.pts - a.pts);
  return { score: Math.min(100, reasons.reduce((s, r) => s + r.pts, 0)), reasons };
}

export function homeRoutes(r) {
  r.get('/home', async ({ req, query }) => {
    const u = await requireUser(req);
    const cfg = await agingConfig();
    const scope = query.scope === 'team' ? 'team' : 'mine';
    const agent = scope === 'mine' ? u.id : int(query.agent);
    const params = [];
    let filter = '';
    if (agent) { params.push(agent); filter = `and t.assignee_id=$${params.length}`; }
    // Grupos privados: en "Todo el equipo" un agente no ve los de grupos privados ajenos
    if (!seesAllTickets(u)) { params.push(u.id); filter += ` and ${visibleTicketsSql('t', `$${params.length}`)}`; }
    const rows = await q(`
      select t.id,t.number,t.subject,t.priority,t.created_at,t.last_activity_at,t.resolution_due,t.sla_paused_at,t.assignee_id,t.ai,
        s.name as status_name, s.kind as status_kind, s.color as status_color, c.name as contact_name, coalesce(c.vip,false) as vip,
        lm.kind as last_kind, lm.created_at as last_at,
        (select count(*)::int from ticket_activities a where a.ticket_id=t.id and a.action='reopened') as reopened,
        (select count(*)::int from ticket_followers f where f.ticket_id=t.id) as followers,
        (select p.key from ticket_projects tp join projects p on p.id=tp.project_id where tp.ticket_id=t.id limit 1) as project_key
      from tickets t
      join statuses s on s.id=t.status_id
      left join contacts c on c.id=t.contact_id
      left join lateral (select m.kind, m.created_at from ticket_messages m where m.ticket_id=t.id and m.kind in ('customer','reply')
                         and coalesce((m.meta->>'auto')::boolean,false)=false order by m.created_at desc, m.id desc limit 1) lm on true
      where t.deleted_at is null and not t.spam and t.merged_into is null and s.kind in ('open','pending') ${filter}
      order by t.created_at asc limit 3000`, params);
    const now = Date.now();
    for (const t of rows) {
      t.age_days = Math.floor((now - new Date(t.created_at).getTime()) / DAY);
      t.idle_days = Math.floor((now - new Date(t.last_activity_at).getTime()) / DAY);
      t.waiting_hours = t.last_kind === 'customer' ? (now - new Date(t.last_at).getTime()) / 3600000 : 0;
      t.waiting = t.status_kind === 'open' && t.last_kind === 'customer' && t.waiting_hours >= cfg.waiting_hours;
      t.overdue = Boolean(t.resolution_due && !t.sla_paused_at && new Date(t.resolution_due).getTime() < now);
      t.needs_agent = Boolean(t.ai?.needs_agent);
    }
    const tz = ((await getSetting('helpdesk')) || {}).timezone || 'America/Argentina/Buenos_Aires';
    const todayEnd = await one(`select ((date_trunc('day', now() at time zone $1) + interval '1 day') at time zone $1) as e`, [tz]);
    const dueToday = rows.filter((t) => !t.overdue && t.resolution_due && !t.sla_paused_at && new Date(t.resolution_due) < new Date(todayEnd.e))
      .sort((a, b) => new Date(a.resolution_due) - new Date(b.resolution_due));
    const overdue = rows.filter((t) => t.overdue).sort((a, b) => new Date(a.resolution_due) - new Date(b.resolution_due));
    const critical = rows.filter((t) => t.age_days > cfg.critical_days);
    const waiting = rows.filter((t) => t.waiting).sort((a, b) => b.waiting_hours - a.waiting_hours);

    const edges = [0, ...cfg.buckets];
    const histogram = edges.map((from, i) => {
      const to = cfg.buckets[i];
      const n = rows.filter((t) => t.age_days >= (i === 0 ? 0 : from + 1) && (to === undefined || t.age_days <= to)).length;
      const top = to ?? Infinity;
      const level = top <= cfg.green_days ? 'ok' : top <= cfg.amber_days ? 'warn' : from >= cfg.critical_days ? 'critical' : 'danger';
      return { from: i === 0 ? 0 : from + 1, to: to ?? null, n, level };
    });

    const resolvedWeek = await one(`select count(*)::int as n from tickets t where t.resolved_at >= date_trunc('week', now() at time zone $1) at time zone $1 ${agent ? 'and t.assignee_id=$2' : ''}`,
      agent ? [tz, agent] : [tz]);

    const slim = (t) => ({
      number: t.number, subject: t.subject, priority: t.priority, created_at: t.created_at, last_activity_at: t.last_activity_at, resolution_due: t.resolution_due,
      status_name: t.status_name, status_kind: t.status_kind, status_color: t.status_color, contact_name: t.contact_name, assignee_id: t.assignee_id,
      age_days: t.age_days, idle_days: t.idle_days, overdue: t.overdue, waiting: t.waiting, project_key: t.project_key,
    });
    const important = rows.map((t) => ({ ...slim(t), ...importance(t, cfg, now) })).sort((a, b) => b.score - a.score || a.created_at - b.created_at);
    const n = Math.max(3, Math.min(20, Number(cfg.list_size) || 6));
    const avgAge = rows.length ? Math.round(rows.reduce((s, t) => s + t.age_days, 0) / rows.length) : 0;
    return {
      scope, agent: agent || null,
      config: { green_days: cfg.green_days, amber_days: cfg.amber_days, critical_days: cfg.critical_days, inactive_days: cfg.inactive_days, waiting_hours: cfg.waiting_hours },
      alerts: {
        critical: { n: critical.length, oldest: rows[0] && rows[0].age_days > cfg.critical_days ? slim(rows[0]) : null },
        overdue: { n: overdue.length, first: overdue[0] ? slim(overdue[0]) : null },
        due_today: { n: dueToday.length, first: dueToday[0] ? slim(dueToday[0]) : null },
        waiting: { n: waiting.length, first: waiting[0] ? slim(waiting[0]) : null },
      },
      kpis: {
        open: rows.length,
        avg_age: avgAge,
        overdue: overdue.length,
        inactive: rows.filter((t) => t.idle_days > cfg.inactive_days).length,
        pending: rows.filter((t) => t.status_kind === 'pending').length,
        resolved_week: resolvedWeek.n,
      },
      histogram,
      oldest: rows.slice(0, n).map(slim),
      important: important.slice(0, n),
    };
  });
}
