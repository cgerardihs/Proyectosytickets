// Informes → Comparativa (v1.25): tickets mes por mes (la pantalla agrupa por trimestre o año).
//   ingresados: creados en el mes · cerrados: resueltos o cerrados en el mes · abiertos: sin resolver el último día del mes
//   tiempo de resolución: horas laborales entre que se abrió y se resolvió, de los cerrados en el mes
// No cuentan spam, papelera ni los tickets combinados en otro (cuentan una vez, en el principal).
import { q } from './db.js';
import { businessMinutesBetween } from './sla.js';

export const COMPARE_DIMS = { agent: 'assignee_id', area: 'category_id', user: 'contact_id', tech: 'tech_category_id', channel: 'channel', type: 'type_id', prio: 'priority' };
const PRIO = { 1: 'Baja', 2: 'Media', 3: 'Alta', 4: 'Urgente' };
const CHANNEL = { email: 'Correo', portal: 'Portal', phone: 'Teléfono', agent: 'Agente', teams: 'Teams', api: 'API', chat: 'Chat', whatsapp: 'WhatsApp' };

const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
export function shiftMonth(k, n) { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return ym(d.getUTCFullYear(), d.getUTCMonth() + 1); }
const monthsBetween = (a, b) => { const out = []; for (let k = a; k <= b && out.length < 400; k = shiftMonth(k, 1)) out.push(k); return out; };
const lastDayIso = (k) => { const [y, m] = k.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** Meses del período elegido: '12' (últimos 12), un año ('2026') o 'all' (desde el primer ticket). */
export async function rangeMonths(range, today, tz) {
  const cur = today.slice(0, 7);
  if (/^\d{4}$/.test(String(range))) { const end = `${range}-12` > cur ? cur : `${range}-12`; return monthsBetween(`${range}-01`, end); }
  if (range === 'all') {
    const first = await q(`select to_char(min(created_at) at time zone $1, 'YYYY-MM') as m from tickets where deleted_at is null`, [tz]);
    return monthsBetween(first[0]?.m && first[0].m < cur ? first[0].m : cur, cur);
  }
  return monthsBetween(shiftMonth(cur, -11), cur);
}

/**
 * Serie mensual del período más los meses anteriores necesarios para comparar (el período anterior de igual largo y el
 * año anterior). Con dim, además, una fila por valor de la dimensión con la métrica pedida.
 */
export async function compareData({ months, hd, dim = 'agent', metric = 'in', filters = {} }) {
  const tz = hd?.timezone || 'America/Argentina/Buenos_Aires';
  const back = Math.max(months.length, 12);
  const all = monthsBetween(shiftMonth(months[0], -back), months.at(-1));
  const start = `${all[0]}-01`;
  const end = lastDayIso(all.at(-1));
  const w = [`t.deleted_at is null`, `not coalesce(t.spam, false)`, `t.merged_into is null`,
    `(t.created_at at time zone $1)::date <= $3::date`,
    `(coalesce(t.resolved_at, t.closed_at) is null or (coalesce(t.resolved_at, t.closed_at) at time zone $1)::date >= $2::date)`];
  const params = [tz, start, end];
  const add = (cond, v) => { params.push(v); w.push(cond.replace('$?', `$${params.length}`)); };
  if (filters.agent) add('t.assignee_id = $?', filters.agent);
  if (filters.area) add('t.category_id = $?', filters.area);
  if (filters.tech) add('t.tech_category_id = $?', filters.tech);
  const rows = await q(`select t.id, t.number, t.created_at, coalesce(t.resolved_at, t.closed_at) as solved_at,
      to_char(t.created_at at time zone $1, 'YYYY-MM') as cm, to_char(coalesce(t.resolved_at, t.closed_at) at time zone $1, 'YYYY-MM') as sm,
      t.assignee_id, t.category_id, t.contact_id, t.tech_category_id, t.channel, t.type_id, t.priority
    from tickets t where ${w.join(' and ')}`, params);
  const idx = new Map(all.map((k, i) => [k, i]));
  const zero = () => all.map(() => 0);
  const series = { in: zero(), out: zero(), open: zero(), ttr_sum: zero(), ttr_n: zero() };
  const col = COMPARE_DIMS[dim] || 'assignee_id';
  const perDim = new Map();
  const cell = (key) => { if (!perDim.has(key)) perDim.set(key, { in: zero(), out: zero(), open: zero(), ttr_sum: zero(), ttr_n: zero() }); return perDim.get(key); };
  for (const t of rows) {
    const key = t[col] === null || t[col] === undefined ? 'none' : String(t[col]);
    const c = cell(key);
    const ci = idx.get(t.cm);
    if (ci !== undefined) { series.in[ci] += 1; c.in[ci] += 1; }
    const si = t.sm ? idx.get(t.sm) : undefined;
    if (si !== undefined) {
      series.out[si] += 1; c.out[si] += 1;
      const mins = businessMinutesBetween(t.created_at, t.solved_at, hd);
      series.ttr_sum[si] += mins; series.ttr_n[si] += 1; c.ttr_sum[si] += mins; c.ttr_n[si] += 1;
    }
    // Abierto al cierre de cada mes: creado hasta ese mes y no resuelto todavía al terminarlo
    for (let i = 0; i < all.length; i++) {
      if (t.cm > all[i]) continue; // todavía no se había creado
      if (t.sm && t.sm <= all[i]) break; // ya estaba resuelto (y lo sigue estando en los meses que siguen)
      series.open[i] += 1; c.open[i] += 1;
    }
  }
  const names = await dimNames(dim, [...perDim.keys()].filter((k) => k !== 'none'));
  const noneLabel = { agent: 'Sin asignar', area: 'Sin área solicitante', user: 'Sin contacto', tech: 'Sin categoría técnica', channel: 'Sin canal', type: 'Sin tipo', prio: 'Sin prioridad' }[dim];
  let dimRows = [...perDim.entries()].map(([key, v]) => ({ key, name: key === 'none' ? noneLabel : names.get(key) || `#${key}`, ...v }));
  // Usuarios: los 10 con más tickets en el período y el resto junto
  if (dim === 'user' && dimRows.length > 11) {
    const from = idx.get(months[0]);
    const score = (r) => r.in.slice(from).reduce((a, b) => a + b, 0) + r.out.slice(from).reduce((a, b) => a + b, 0);
    dimRows.sort((a, b) => score(b) - score(a));
    const rest = dimRows.slice(10);
    const others = { key: 'others', name: `Otros usuarios (${rest.length})`, in: zero(), out: zero(), open: zero(), ttr_sum: zero(), ttr_n: zero() };
    for (const r of rest) for (const k of ['in', 'out', 'open', 'ttr_sum', 'ttr_n']) r[k].forEach((v, i) => { others[k][i] += v; });
    dimRows = [...dimRows.slice(0, 10), others];
  }
  return { all, from: idx.get(months[0]), months, series, rows: dimRows, metric, dim };
}

async function dimNames(dim, keys) {
  const map = new Map();
  if (!keys.length) return map;
  const ids = keys.map(Number).filter(Number.isFinite);
  const by = async (sql) => { for (const r of await q(sql, [ids])) map.set(String(r.id), r.name); };
  if (dim === 'agent') await by('select id, name from users where id = any($1::int[])');
  else if (dim === 'area') await by('select id, name from categories where id = any($1::int[])');
  else if (dim === 'user') await by(`select id, coalesce(nullif(name, ''), email) as name from contacts where id = any($1::int[])`);
  else if (dim === 'tech') await by('select id, name from tech_categories where id = any($1::int[])');
  else if (dim === 'type') await by('select id, name from ticket_types where id = any($1::int[])');
  else if (dim === 'channel') for (const k of keys) map.set(k, CHANNEL[k] || k);
  else if (dim === 'prio') for (const k of keys) map.set(k, PRIO[k] || k);
  return map;
}
