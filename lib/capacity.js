// Horas del equipo (v1.17): horas disponibles de cada persona de IT y capacidad para proyectos.
//   disponibles = días hábiles del período × horas por día × % dedicado a IT
//   para proyectos = disponibles − operación planificada (rutinas) − tickets esperados (promedio de los últimos 3 meses)
import { q } from './db.js';
import { businessDays, dayHours } from './workdays.js';
import { calendarFrom, occurrences, assigneeFor, addDays } from './ops.js';

const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
/** Los feriados pueden venir como texto o como { date, name }: businessDays espera texto. */
const cfgOf = (hd) => ({ ...(hd || {}), holidays: (hd?.holidays || []).map((h) => (typeof h === 'string' ? h : h?.date)).filter(Boolean) });

/** Personas de IT: agentes, supervisores y administradores activos (el superadministrador técnico no cuenta). */
export const itPeople = () => q(`select id, name, role, it_pct from users where active and role in ('admin','supervisor','agent') order by name`);

/** Minutos disponibles de una persona entre dos fechas. */
export function availableMinutes(person, from, to, hd) {
  const cfg = cfgOf(hd);
  return Math.round(businessDays(from, to, cfg) * dayHours(cfg) * 60 * (Number(person.it_pct ?? 100) / 100));
}

/** Minutos de operación planificados por persona entre dos fechas (frecuencia × tiempo estimado, con los turnos). */
export async function opsPlanned(from, to, hd) {
  const c = calendarFrom(hd);
  const out = {};
  for (const r of await q('select * from ops_routines where active')) {
    for (const o of occurrences(r.rule, from, to, c)) {
      const who = assigneeFor(r, o.date);
      if (who) out[who] = (out[who] || 0) + r.est_minutes;
    }
  }
  return out;
}

/**
 * Capacidad para proyectos por persona y por mes, en horas: { 'AAAA-MM': { userId: { available, ops, tickets, cap } } }.
 * Los tickets esperados son el promedio mensual de horas registradas en tickets en los 3 meses completos anteriores al actual.
 */
export async function projectCapacity(months, hd, today) {
  const people = await itPeople();
  const cur = today.slice(0, 7);
  const tk = await q(`select user_id, sum(minutes)::int as minutes from time_entries
    where ticket_id is not null and spent_on >= $1::date and spent_on <= $2::date group by user_id`, [`${shiftMonth(cur, -3)}-01`, lastDay(shiftMonth(cur, -1))]);
  const ticketsAvg = Object.fromEntries(tk.map((x) => [x.user_id, x.minutes / 3 / 60]));
  const out = {};
  for (const ym of months) {
    const from = `${ym}-01`;
    const to = lastDay(ym);
    const ops = await opsPlanned(from, to, hd);
    out[ym] = {};
    for (const p of people) {
      const available = availableMinutes(p, from, to, hd) / 60;
      const o = (ops[p.id] || 0) / 60;
      const t = ticketsAvg[p.id] || 0;
      out[ym][p.id] = { available: round1(available), ops: round1(o), tickets: round1(t), cap: round1(Math.max(0, available - o - t)), it_pct: p.it_pct };
    }
  }
  return out;
}

/** Los meses que muestra el calendario del Portfolio (desde 6 meses atrás hasta 12 adelante). */
export const capacityMonths = (today) => Array.from({ length: 19 }, (_, i) => shiftMonth(today.slice(0, 7), i - 6));
const round1 = (x) => Math.round(x * 10) / 10;
export { addDays };
