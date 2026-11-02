// Operación de IT (v1.16): tareas que no son tickets ni proyectos (backups, controles, parches, altas y bajas, renovaciones).
// Una rutina define qué hay que hacer, quién, cada cuánto y cuánto lleva. Las ocurrencias no se guardan por adelantado: se
// calculan con la regla de repetición (días hábiles y feriados de la mesa) y solo se guarda lo registrado (hecha u omitida).
import { q } from './db.js';
import { getSetting } from './settings.js';
import { bad } from './http.js';

export const OPS_FREQ = ['once', 'daily', 'weekly', 'monthly', 'yearly'];
export const OPS_SHIFT = ['none', 'prev', 'next'];
export const OPS_RESULTS = ['ok', 'obs', 'fail'];
/** Cuántos días hacia atrás se buscan tareas vencidas sin registrar. */
export const LATE_LOOKBACK = 60;

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s) => typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(D(s).getTime()) && iso(D(s)) === s;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Fecha de hoy en la zona horaria de la mesa. */
export function todayIn(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return iso(new Date()); }
}

/** Días laborales y feriados de la mesa (Configuración → Horario de atención). */
export async function opsCalendar() {
  return calendarFrom((await getSetting('helpdesk')) || {});
}
/** Lo mismo a partir de la configuración ya leída (los feriados pueden venir como texto o como { date, name }). */
export function calendarFrom(hd) {
  return {
    days: hd?.business?.days?.length ? hd.business.days.map(Number) : [1, 2, 3, 4, 5],
    holidays: new Set((hd?.holidays || []).map((h) => (typeof h === 'string' ? h : h?.date)).filter(Boolean)),
    today: todayIn(hd?.timezone),
  };
}
export const isWorkday = (s, c) => c.days.includes(D(s).getUTCDay()) && !c.holidays.has(s);

function shift(s, how, c) {
  if ((how !== 'prev' && how !== 'next') || isWorkday(s, c)) return s;
  let x = s;
  for (let i = 0; i < 31 && !isWorkday(x, c); i++) x = addDays(x, how === 'prev' ? -1 : 1);
  return x;
}

function nthOf(y, m, nth, wd, c) {
  const first = iso(new Date(Date.UTC(y, m, 1)));
  const last = iso(new Date(Date.UTC(y, m + 1, 0)));
  if (wd === 'bd') {
    const list = [];
    for (let s = first; s <= last; s = addDays(s, 1)) if (isWorkday(s, c)) list.push(s);
    return (nth > 0 ? list[nth - 1] : list[list.length + nth]) || null;
  }
  if (nth > 0) {
    let s = first;
    while (D(s).getUTCDay() !== wd) s = addDays(s, 1);
    const r = addDays(s, 7 * (nth - 1));
    return r <= last ? r : null;
  }
  let s = last;
  while (D(s).getUTCDay() !== wd) s = addDays(s, -1);
  return s;
}

/** Valida y normaliza la regla de repetición que manda el navegador. */
export function normalizeRule(raw, today = iso(new Date())) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!OPS_FREQ.includes(r.freq)) throw bad('Elegí cada cuánto se repite');
  const out = { freq: r.freq, shift: OPS_SHIFT.includes(r.shift) ? r.shift : 'none' };
  const int = (x, min, max, msg) => { const n = Number(x); if (!Number.isInteger(n) || n < min || n > max) throw bad(msg); return n; };
  if (r.freq === 'once') {
    if (!validIso(r.date)) throw bad('Indicá la fecha');
    out.date = r.date;
  } else if (r.freq === 'daily') {
    out.workdays = r.workdays !== false;
  } else if (r.freq === 'weekly') {
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!days.length) throw bad('Elegí al menos un día de la semana');
    out.days = days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  } else if (r.freq === 'monthly') {
    out.every = r.every === undefined ? 1 : int(r.every, 1, 12, 'Cada cuántos meses: entre 1 y 12');
    out.start = MONTH_RE.test(String(r.start || '')) ? String(r.start) : today.slice(0, 7);
    out.mode = r.mode === 'day' ? 'day' : 'nth';
    if (out.mode === 'day') out.day = int(r.day, 1, 31, 'El día del mes va de 1 a 31');
    else {
      out.nth = int(r.nth, -1, 4, 'Elegí primer, segundo, tercer, cuarto o último');
      if (out.nth === 0) throw bad('Elegí primer, segundo, tercer, cuarto o último');
      out.wd = r.wd === 'bd' ? 'bd' : int(r.wd, 0, 6, 'Elegí el día de la semana');
    }
  } else if (r.freq === 'yearly') {
    out.month = int(r.month, 0, 11, 'Elegí el mes');
    out.day = int(r.day, 1, 31, 'El día va de 1 a 31');
  }
  return out;
}

/**
 * Ocurrencias de una regla entre dos fechas (AAAA-MM-DD, ambas incluidas): [{ date, orig }]. orig es la fecha original cuando
 * se movió por caer en un día no hábil o feriado.
 */
export function occurrences(rule, from, to, c) {
  const out = [];
  const push = (s) => {
    if (!s) return;
    const moved = shift(s, rule.shift, c);
    if (moved >= from && moved <= to) out.push({ date: moved, orig: moved !== s ? s : null });
  };
  if (rule.freq === 'once') push(rule.date);
  else if (rule.freq === 'daily') {
    for (let s = from, i = 0; s <= to && i < 800; s = addDays(s, 1), i++) if (!rule.workdays || isWorkday(s, c)) out.push({ date: s, orig: null });
  } else if (rule.freq === 'weekly') {
    for (let s = addDays(from, -7), i = 0; s <= addDays(to, 7) && i < 900; s = addDays(s, 1), i++) if (rule.days.includes(D(s).getUTCDay())) push(s);
  } else if (rule.freq === 'monthly') {
    const [sy, sm] = rule.start.split('-').map(Number);
    const anchor = sy * 12 + (sm - 1);
    const fy = Number(from.slice(0, 4));
    const fm = Number(from.slice(5, 7)) - 1;
    for (let k = fy * 12 + fm - 1, i = 0; i < 40; k++, i++) {
      const y = Math.floor(k / 12);
      const m = k % 12;
      if (iso(new Date(Date.UTC(y, m, 1))) > addDays(to, 31)) break;
      if (k < anchor || (k - anchor) % rule.every !== 0) continue;
      push(rule.mode === 'day' ? iso(new Date(Date.UTC(y, m, Math.min(rule.day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())))) : nthOf(y, m, rule.nth, rule.wd, c));
    }
  } else if (rule.freq === 'yearly') {
    for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)) + 1; y++) {
      push(iso(new Date(Date.UTC(y, rule.month, Math.min(rule.day, new Date(Date.UTC(y, rule.month + 1, 0)).getUTCDate())))));
    }
  }
  const seen = new Set();
  return out.filter((o) => (seen.has(o.date) ? false : seen.add(o.date))).sort((a, b) => (a.date < b.date ? -1 : 1));
}

const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DOWS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
const NTH = { 1: 'primer', 2: 'segundo', 3: 'tercer', 4: 'cuarto', '-1': 'último' };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dmy = (s) => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** La regla en palabras: "Todos los meses, el primer lunes". */
export function ruleText(r) {
  if (r.freq === 'once') return `Una vez, el ${dmy(r.date)}`;
  if (r.freq === 'daily') return r.workdays ? 'Todos los días hábiles' : 'Todos los días';
  if (r.freq === 'weekly') {
    const ds = r.days.map((d) => DOWS[d]);
    return `Todos los ${ds.length > 1 ? `${ds.slice(0, -1).join(', ')} y ${ds.at(-1)}` : ds[0]}`;
  }
  if (r.freq === 'monthly') {
    const every = r.every > 1 ? `Cada ${r.every} meses` : 'Todos los meses';
    return r.mode === 'day' ? `${every}, el día ${r.day}` : `${every}, el ${NTH[r.nth]} ${r.wd === 'bd' ? 'día hábil' : DOW[r.wd]}`;
  }
  return `Todos los años, el ${r.day} de ${MONTHS[r.month]}`;
}

/** A quién le toca una ocurrencia: si la rutina tiene varias personas, se turnan. */
export function assigneeFor(routine, date) {
  const ids = routine.assignee_ids || [];
  if (ids.length <= 1) return ids[0] || null;
  const f = routine.rule.freq;
  const n = f === 'monthly' ? Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7))
    : f === 'yearly' ? Number(date.slice(0, 4))
      : f === 'weekly' ? Math.floor((D(date) - D('2024-01-01')) / (7 * 86400000))
        : Math.floor((D(date) - D('2024-01-01')) / 86400000);
  return ids[((n % ids.length) + ids.length) % ids.length];
}

/**
 * Ocurrencias de las rutinas en un período, con lo registrado. Las diarias que pasaron sin registrar no quedan vencidas
 * (se consideran omitidas); las demás sí, hasta LATE_LOOKBACK días atrás y nunca antes de que se creara la rutina.
 */
export async function opsItems({ from, to, c, routineIds = null, includeInactive = false }) {
  const routines = await q(`select * from ops_routines where ${includeInactive ? 'true' : 'active'} ${routineIds ? 'and id = any($1::int[])' : ''} order by name`, routineIds ? [routineIds] : []);
  if (!routines.length) return { routines, items: [] };
  const recs = await q(`select id, routine_id, due_date::text as due_date, status, result, done_by, done_at, minutes, note, steps_done, ticket_id from ops_records where routine_id = any($1::int[]) and due_date between $2::date and $3::date`, [routines.map((r) => r.id), from, to]);
  const byKey = new Map(recs.map((x) => [`${x.routine_id}|${iso(new Date(x.due_date))}`, x]));
  const items = [];
  for (const r of routines) {
    const created = iso(new Date(r.created_at));
    for (const o of occurrences(r.rule, from, to, c)) {
      const record = byKey.get(`${r.id}|${o.date}`) || null;
      const past = o.date < c.today;
      if (past && !record && (r.rule.freq === 'daily' || o.date < created || o.date < addDays(c.today, -LATE_LOOKBACK))) continue;
      items.push({
        routine_id: r.id, name: r.name, category: r.category, est_minutes: r.est_minutes, due_time: r.due_time, notice_days: r.notice_days,
        freq: r.rule.freq, rule_text: ruleText(r.rule), steps: r.steps, date: o.date, orig: o.orig, holiday: o.orig && c.holidays.has(o.orig),
        assignee_id: record?.done_by || assigneeFor(r, o.date), late: past && !record, record,
      });
    }
  }
  items.sort((a, b) => (a.date === b.date ? String(a.due_time).localeCompare(String(b.due_time)) : a.date < b.date ? -1 : 1));
  return { routines, items };
}

/** Historial corto de una rutina: el estado de sus últimas ocurrencias (hecha, con observaciones, falló, omitida, vencida). */
export function historyOf(routine, recs, c, n = 6) {
  const created = iso(new Date(routine.created_at));
  const from = addDays(c.today, -400) < created ? created : addDays(c.today, -400);
  const occ = occurrences(routine.rule, from, addDays(c.today, -1), c).slice(-n);
  const map = new Map(recs.filter((x) => x.routine_id === routine.id).map((x) => [iso(new Date(x.due_date)), x]));
  return occ.map((o) => {
    const x = map.get(o.date);
    return { date: o.date, state: !x ? (routine.rule.freq === 'daily' ? 'skipped' : 'missed') : x.status === 'skipped' ? 'skipped' : x.result || 'ok' };
  });
}
