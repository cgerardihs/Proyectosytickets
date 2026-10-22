// Roadmap en modo calendario: 12 meses con los proyectos que terminan en cada uno, la carga del mes
// y, al elegir un mes, cada colaborador con todos sus proyectos y las horas que le tocan.
import { esc, icon, avatar, fmtNum, fmtDate, userName } from '../core.js';

export const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAY = 86400000;
const NONE = 0; // proyectos sin responsable ni tareas asignadas

const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const parseDay = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const monthStart = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1); };
export const addMonths = (key, n) => { const d = monthStart(key); return ym(new Date(d.getFullYear(), d.getMonth() + n, 1)); };

/** Quiénes trabajan en el proyecto: el responsable y quienes tienen tareas asignadas; si no hay, los integrantes. */
export function participants(p) {
  const ids = [...new Set([p.lead_id, ...(p.worker_ids || [])].filter(Boolean).map(Number))];
  if (ids.length) return ids;
  const members = [...new Set((p.member_ids || []).map(Number))];
  return members.length ? members : [NONE];
}

/**
 * Carga de un mes. Las horas estimadas de cada proyecto se reparten parejo por día entre su inicio y su fin
 * y, dentro del mes, en partes iguales entre sus participantes.
 */
export function monthLoad(rows, key, capacity) {
  const [y, m] = key.split('-').map(Number);
  const a = Date.UTC(y, m - 1, 1);
  const b = Date.UTC(y, m, 1);
  const people = new Map();
  const active = [];
  const ends = [];
  let noHours = 0;
  for (const p of rows) {
    if (!p.start || !p.end) continue; // sin fechas (o recurrente sin fechas): no se puede ubicar en el calendario
    const s = parseDay(p.start);
    const e = parseDay(p.end) + DAY;
    if (e <= s) continue;
    const ov = Math.min(b, e) - Math.max(a, s);
    if (ov <= 0) continue;
    const ending = e - DAY >= a && e - DAY < b;
    active.push(p);
    if (ending) ends.push(p);
    // Un proyecto finalizado o cancelado ya no carga a nadie (sigue figurando en el mes en que termina)
    const closed = ['done', 'cancelled'].includes(p.portfolio_status);
    const est = closed ? 0 : Number(p.estimated_hours || 0);
    if (!est && !closed) noHours += 1;
    const ppl = participants(p);
    const h = (est * (ov / (e - s))) / ppl.length;
    for (const id of ppl) {
      if (!people.has(id)) people.set(id, { id, hours: 0, items: [] });
      const x = people.get(id);
      x.hours += h;
      x.items.push({ p, hours: h, ends: ending, estimated: Boolean(est), closed });
    }
  }
  const list = [...people.values()].map((x) => ({ ...x, pct: Math.round((x.hours / capacity) * 100), items: x.items.sort((i, j) => j.hours - i.hours) }))
    .sort((i, j) => (i.id === NONE) - (j.id === NONE) || j.hours - i.hours || String(userName(i.id)).localeCompare(userName(j.id)));
  const named = list.filter((x) => x.id !== NONE);
  const hours = named.reduce((t, x) => t + x.hours, 0);
  return {
    key, active, ends: ends.sort((i, j) => String(i.end).localeCompare(String(j.end))), people: list, hours, noHours,
    pct: named.length ? Math.round((hours / (named.length * capacity)) * 100) : 0,
    over: named.filter((x) => x.hours > capacity).length,
  };
}

const level = (pct) => (pct > 100 ? 'over' : pct >= 85 ? 'limit' : 'ok');
const LEVEL_LABEL = { over: 'Sobrecargado', limit: 'Al límite', ok: 'Con margen' };
const monthTitle = (key) => { const d = monthStart(key); return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`; };

export function calendarHtml(rows, { today, capacity, from, selected, canEditCapacity, health }) {
  const todayKey = today.slice(0, 7);
  const keys = Array.from({ length: 12 }, (_, i) => addMonths(from, i));
  const sel = keys.includes(selected) ? selected : keys.includes(todayKey) ? todayKey : keys[0];
  const loads = keys.map((k) => monthLoad(rows, k, capacity));
  const cur = loads[keys.indexOf(sel)];
  const undated = rows.filter((p) => !p.start || !p.end).length;
  const range = `${monthTitle(keys[0])} – ${monthTitle(keys[11])}`;

  const cell = (L) => {
    const d = monthStart(L.key);
    const lv = level(L.pct);
    const shown = L.ends.slice(0, 3);
    return `<button type="button" class="cal-m ${L.key === sel ? 'on' : ''} ${L.key === todayKey ? 'now' : ''} ${L.key < todayKey ? 'past' : ''}" data-cal-month="${L.key}" aria-pressed="${L.key === sel}">
      <span class="cal-mh"><b>${MONTH_NAMES[d.getMonth()]}</b> <small>${d.getFullYear()}</small>${L.key === todayKey ? '<i class="cal-now">hoy</i>' : ''}</span>
      <span class="cal-meter lv-${lv}"><span style="width:${Math.min(100, L.pct)}%"></span></span>
      <span class="cal-ms"><span>${L.active.length} ${L.active.length === 1 ? 'proyecto' : 'proyectos'}${L.hours ? ` · ${fmtNum(L.hours)} h` : ''}</span><b class="lv-${lv}-text">${L.hours ? `${L.pct}%` : L.active.length ? '<small class="muted">sin estimar</small>' : ''}</b></span>
      ${L.over ? `<span class="cal-over">${icon('alert', 11)} ${L.over} ${L.over === 1 ? 'persona sobrecargada' : 'personas sobrecargadas'}</span>` : ''}
      ${L.ends.length ? `<span class="cal-ends">${shown.map((p) => `<span class="cal-end h-${p.health}" title="${esc(`${p.key} · ${p.name} · termina el ${fmtDate(p.end)} · ${p.progress}%`)}"><b>${esc(p.name)}</b></span>`).join('')}${L.ends.length > 3 ? `<small class="muted">y ${L.ends.length - 3} más</small>` : ''}</span>` : ''}
    </button>`;
  };

  const chip = (it) => `<button type="button" class="cal-chip ${it.ends ? 'ends' : ''}" data-key="${esc(it.p.key)}" title="${esc(`${it.p.name} · ${fmtDate(it.p.start)} → ${fmtDate(it.p.end)} · ${it.p.progress}%`)}">
      <span class="proj-key xs" style="background:${esc(it.p.color)}">${esc(it.p.key)}</span>${esc(it.p.name)}
      <small>${it.closed ? (it.p.portfolio_status === 'done' ? 'finalizado' : 'cancelado') : it.estimated ? `${fmtNum(it.hours, it.hours < 10 ? 1 : 0)} h` : 'sin estimar'}${it.ends ? ' · termina' : ''}</small></button>`;

  const person = (x) => {
    const lv = level(x.pct);
    const name = x.id === NONE ? 'Sin responsable' : userName(x.id) || 'Usuario';
    return `<div class="cal-person">
      <div class="cal-ph">${x.id === NONE ? `<span class="avatar none" style="width:26px;height:26px">${icon('user', 14)}</span>` : avatar(x.id, 26)}<b class="ellip">${esc(name)}</b><span class="grow"></span>
        ${x.id === NONE ? '' : `<b class="tnum">${fmtNum(x.hours)} h</b><span class="lvl lv-${lv}" title="${LEVEL_LABEL[lv]}">${x.pct}%</span>`}</div>
      ${x.id === NONE ? '<p class="hint" style="margin:0">Proyectos sin responsable ni tareas asignadas: sus horas no se cuentan en la carga.</p>' : `<span class="cal-meter lv-${lv}"><span style="width:${Math.min(100, x.pct)}%"></span></span>`}
      <div class="cal-chips">${x.items.map(chip).join('')}</div></div>`;
  };

  const ending = cur.ends.length ? `<div class="cal-endlist">${cur.ends.map((p) => `<button type="button" class="cal-endrow" data-key="${esc(p.key)}">
      <span class="proj-key xs" style="background:${esc(p.color)}">${esc(p.key)}</span><span class="ellip">${esc(p.name)}</span><span class="grow"></span>
      <small class="muted nowrap">${fmtDate(p.end)}</small><span class="health" style="--c:${health[p.health].color}">${health[p.health].label}</span><b class="tnum">${p.progress}%</b></button>`).join('')}</div>`
    : '<p class="muted small" style="margin:0">Ningún proyecto termina este mes.</p>';

  return `<div class="rm2-tools">
      <div class="row gap"><button class="icon-btn" data-cal-shift="-3" aria-label="Tres meses antes">${icon('left', 16)}</button><b class="rm2-range">${esc(range)}</b>
        <button class="icon-btn" data-cal-shift="3" aria-label="Tres meses después">${icon('right', 16)}</button><button class="btn sm" data-cal-shift="0">Hoy</button></div>
      <span class="grow"></span>
      <span class="rm2-legend"><i class="lg cal-lg-ok"></i> Con margen <i class="lg cal-lg-limit"></i> Al límite (85–100%) <i class="lg cal-lg-over"></i> Sobrecargado</span>
    </div>
    <div class="cal-wrap">
      <div class="cal-side">
        <div class="cal-grid">${loads.map(cell).join('')}</div>
        <p class="hint">El % de cada mes es el promedio de las personas con proyectos ese mes contra su capacidad. Debajo, los proyectos que terminan en el mes.${undated ? ` ${undated} proyecto(s) sin fechas no aparecen.` : ''}</p>
      </div>
      <div class="card cal-detail">
        <div class="cal-dh"><h3>${icon('calendar', 16)} ${esc(monthTitle(sel).replace(/^./, (c) => c.toUpperCase()))}</h3><span class="grow"></span>
          ${cur.hours ? `<span class="lvl lv-${level(cur.pct)}">${cur.pct}% del equipo</span>` : ''}${cur.over ? `<span class="lvl lv-over">${cur.over} sobrecargado${cur.over === 1 ? '' : 's'}</span>` : ''}</div>
        <p class="muted small" style="margin:0 0 10px">${cur.active.length} proyecto(s) activos · ${fmtNum(cur.hours)} h estimadas en el mes${cur.noHours ? ` · ${cur.noHours} sin horas estimadas` : ''}</p>
        <h4>Terminan este mes</h4>${ending}
        <h4>Por colaborador</h4>
        ${cur.people.length ? cur.people.map(person).join('') : '<p class="muted small">Nadie tiene proyectos en este mes.</p>'}
        <div class="cal-cap">
          ${canEditCapacity
    ? `<label class="mini-field"><span>Capacidad para proyectos</span><span class="row gap"><input class="input sm inline-num" type="number" min="1" max="744" step="1" data-cal-cap value="${capacity}"> h por persona por mes <button type="button" class="btn sm" data-cal-cap-save>Guardar</button></span></label>`
    : `<span class="muted small">Capacidad para proyectos: <b>${capacity} h</b> por persona por mes.</span>`}
          <p class="hint" style="margin:4px 0 0">El resto de la jornada queda para soporte. Las horas estimadas de cada proyecto se reparten parejo por día entre su inicio y su fin, y en partes iguales entre el responsable y quienes tienen tareas asignadas.</p>
        </div>
      </div>
    </div>`;
}
