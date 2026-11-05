// Horas del equipo "calculadas" (v1.22): lo que le toca a cada persona en un período sin depender de que registre horas.
//   - Proyectos: las horas estimadas de cada proyecto, repartidas igual que en el calendario del Portfolio (parejo por día
//     entre su inicio y su fin y en partes iguales entre el responsable y quienes tienen tareas asignadas).
//   - Operación: lo planificado de las rutinas (frecuencia × tiempo estimado, con los turnos); si ya se hizo, lo registrado.
//   - Tickets: cada ticket resuelto en el período suma a quien lo tenía asignado las horas registradas en él o, si no hay,
//     el tiempo típico de su categoría técnica (Configuración → Categorías técnicas; si no tiene, 30 minutos).
// Aparte, el tiempo de resolución (horas laborales entre que se abrió y se resolvió) como indicador de demora.
import { q } from './db.js';
import { portfolioRows, derive } from './portfolio.js';
import { calendarFrom, occurrences, assigneeFor } from './ops.js';
import { businessDays } from './workdays.js';
import { businessMinutesBetween } from './sla.js';

export const DEFAULT_TICKET_MINUTES = 30;
const DAY = 86400000;
const utc = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const cfgOf = (hd) => ({ ...(hd || {}), holidays: (hd?.holidays || []).map((h) => (typeof h === 'string' ? h : h?.date)).filter(Boolean) });

/** Días hábiles entre dos fechas (para repartir las horas de un proyecto en la semana). */
function workdaysList(from, to, hd) {
  const out = [];
  const cfg = cfgOf(hd);
  for (let t = utc(from); t <= utc(to); t += DAY) if (businessDays(isoOf(t), isoOf(t), cfg) > 0) out.push(isoOf(t));
  return out;
}

/** Proyectos: entradas por persona y día hábil del período. */
async function projectEntries(from, to, hd, today, projectId) {
  const out = [];
  const a = utc(from);
  const b = utc(to) + DAY;
  for (const raw of await portfolioRows()) {
    if (projectId && raw.id !== projectId) continue;
    const p = derive(raw, today);
    if (!p.start || !p.end) continue;
    if (['done', 'cancelled'].includes(p.portfolio_status) || p.archived) continue;
    const est = Number(p.estimated_hours || 0);
    if (!est) continue;
    const s = utc(p.start);
    const e = utc(p.end) + DAY;
    if (e <= s) continue;
    const ov = Math.min(b, e) - Math.max(a, s);
    if (ov <= 0) continue;
    const ids = [...new Set([p.lead_id, ...(p.worker_ids || [])].filter(Boolean).map(Number))];
    const ppl = ids.length ? ids : [...new Set((p.member_ids || []).map(Number))];
    if (!ppl.length) continue;
    const minutes = ((est * (ov / (e - s))) / ppl.length) * 60;
    // El total del período es el del Portfolio; para ver la semana día por día se reparte en los días hábiles del tramo
    const days = workdaysList(isoOf(Math.max(a, s)), isoOf(Math.min(b, e) - DAY), hd);
    const spread = days.length ? days : [isoOf(Math.min(b, e) - DAY)];
    for (const id of ppl) {
      for (const d of spread) {
        out.push({ user_id: id, date: d, minutes: minutes / spread.length, source: 'P', label: `${p.key} ${p.name}`, link: `#/projects/${p.key}`, how: 'estimado' });
      }
    }
  }
  return out;
}

/** Operación: lo planificado de cada ocurrencia del período; si ya se registró, lo real. */
async function opsEntries(from, to, hd, today) {
  const c = calendarFrom(hd);
  const routines = await q('select * from ops_routines where active');
  if (!routines.length) return [];
  const recs = await q(`select routine_id, due_date::text as due_date, status, minutes, done_by from ops_records where routine_id = any($1::int[]) and due_date between $2::date and $3::date`,
    [routines.map((r) => r.id), from, to]);
  const byKey = new Map(recs.map((r) => [`${r.routine_id}|${r.due_date}`, r]));
  const out = [];
  for (const r of routines) {
    for (const o of occurrences(r.rule, from, to, c)) {
      const rec = byKey.get(`${r.id}|${o.date}`);
      if (rec?.status === 'skipped') continue;
      if (!rec && o.date < today && r.rule.freq === 'daily') continue; // diaria que pasó sin hacerse: no cuenta
      const who = rec?.done_by || assigneeFor(r, o.date);
      if (!who) continue;
      out.push({ user_id: who, date: o.date, minutes: rec ? rec.minutes : r.est_minutes, source: 'O', label: r.name, link: '#/ops', how: rec ? 'registrado' : 'planificado' });
    }
  }
  return out;
}

/** Tickets resueltos en el período: horas registradas o el tiempo típico de su categoría; y su tiempo de resolución. */
async function ticketData(from, to, hd, techId) {
  const tz = hd?.timezone || 'America/Argentina/Buenos_Aires';
  const rows = await q(`select t.id, t.number, t.subject, t.assignee_id, t.created_at, coalesce(t.resolved_at, t.closed_at) as solved_at,
      to_char(coalesce(t.resolved_at, t.closed_at) at time zone $3, 'YYYY-MM-DD') as solved_on,
      tc.name as tech, tc.std_minutes, coalesce((select sum(minutes) from time_entries te where te.ticket_id = t.id), 0)::int as logged
    from tickets t left join tech_categories tc on tc.id = t.tech_category_id
    where coalesce(t.resolved_at, t.closed_at) is not null
      and (coalesce(t.resolved_at, t.closed_at) at time zone $3)::date between $1::date and $2::date
      and t.deleted_at is null and not coalesce(t.spam, false) and t.merged_into is null and t.assignee_id is not null
      ${techId ? 'and t.tech_category_id = $4' : ''}
    order by solved_at`, techId ? [from, to, tz, techId] : [from, to, tz]);
  const cfg = cfgOf(hd);
  const entries = [];
  const resolution = [];
  for (const t of rows) {
    const std = Number(t.std_minutes) > 0 ? Number(t.std_minutes) : DEFAULT_TICKET_MINUTES;
    entries.push({
      user_id: t.assignee_id, date: t.solved_on, minutes: t.logged || std, source: 'T', label: `#${t.number} ${t.subject}`, link: `#/tickets/${t.number}`,
      how: t.logged ? 'registrado' : `típico de ${t.tech || 'un ticket'}`,
    });
    resolution.push({ user_id: t.assignee_id, number: t.number, subject: t.subject, minutes: businessMinutesBetween(t.created_at, t.solved_at, cfg) });
  }
  return { entries, resolution };
}

/**
 * Horas calculadas del período, con filtros: user (id), source ('T' | 'P' | 'O'), projectId, techId (solo tickets).
 * Devuelve entradas con la misma forma que las registradas y el tiempo de resolución de los tickets.
 */
export async function calculatedHours({ from, to, hd, today, source = '', projectId = null, techId = null }) {
  const want = (s) => !source || source === s;
  const [proj, ops, tk] = await Promise.all([
    want('P') && !techId ? projectEntries(from, to, hd, today, projectId) : [],
    want('O') && !projectId && !techId ? opsEntries(from, to, hd, today) : [],
    want('T') && !projectId ? ticketData(from, to, hd, techId) : { entries: [], resolution: [] },
  ]);
  return { entries: [...proj, ...ops, ...tk.entries], resolution: tk.resolution };
}

/** Tiempo de resolución de tickets resueltos en el período (también para el modo "registrado"). */
export async function resolutionTimes({ from, to, hd, techId = null }) {
  return (await ticketData(from, to, hd, techId)).resolution;
}
