// Portfolio de proyectos: listado tipo planilla y roadmap en calendario, con importación y exportación a Excel.
import {
  state, api, esc, icon, avatar, toast, toastError, modal, fmtDate, fmtNum, PRIORITY, PRIORITY_COLOR, downloadUrl, options, debounce, emptyState, isAdmin,
} from '../core.js';
import { setCrumbs, refreshMeta } from '../app.js';
import { PSTATUS, PSTATUS_COLOR, portfolioFieldsHtml, readPortfolioFields, openProjectForm } from './project-form.js';
import { calendarHtml, addMonths } from './portfolio-calendar.js';

const HEALTH = {
  late: { label: 'Atrasado', color: '#dc2626' }, risk: { label: 'En riesgo', color: '#d97706' }, ok: { label: 'En término', color: '#059669' },
  done: { label: 'Finalizado', color: '#059669' }, none: { label: 'Sin fechas', color: '#9ca3af' },
};
const PHASE_STATE = { done: 'Hecha', active: 'En curso', pending: 'Pendiente' };
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const GROUPS = { none: 'Sin agrupar', sector: 'Sector IT', area: 'Área', status: 'Estado', lead: 'Responsable', origin: 'Origen', type: 'Tipo' };

const load = () => { try { return JSON.parse(localStorage.getItem('pf-ui') || '{}'); } catch { return {}; } };
const save = (ui) => { try { localStorage.setItem('pf-ui', JSON.stringify(ui)); } catch { /* sin almacenamiento */ } };

export async function render(el, _p, query) {
  setCrumbs([{ label: 'Proyectos', href: '#/projects' }, { label: 'Portfolio' }]);
  if (!state.meta.canPortfolio) {
    el.innerHTML = `<div class="page">${emptyState('Sin acceso al portfolio', 'Lo habilita el superadministrador desde Configuración → Agentes.', 'portfolio')}</div>`;
    return;
  }
  const ui = {
    tab: 'list', q: '', status: ['planned', 'active', 'paused', 'done'], sector: '', area: '', lead: '', origin: '', type: '', health: '',
    group: 'sector', sort: 'end', dir: 'asc', zoom: 'y', anchor: null, open: {}, ...load(), calFrom: null, calSel: null,
  };
  if (['roadmap', 'list', 'calendar'].includes(query.tab)) ui.tab = query.tab;
  let data = await api('/portfolio');

  const today = data.today;
  const filtered = () => data.rows.filter((p) => {
    if (ui.status.length && !ui.status.includes(p.portfolio_status)) return false;
    for (const [k, col] of [['sector', 'sector_id'], ['area', 'area_id'], ['lead', 'lead_id'], ['origin', 'origin_id'], ['type', 'type_id']]) {
      if (ui[k] && String(p[col] ?? 'none') !== String(ui[k])) return false;
    }
    if (ui.health && p.health !== ui.health) return false;
    if (ui.q) {
      const t = ui.q.toLowerCase();
      if (![p.name, p.key, p.description, p.lead_name, p.current_phase].some((x) => String(x || '').toLowerCase().includes(t))) return false;
    }
    return true;
  });

  el.innerHTML = `<div class="page wide pf-page">
    <div class="page-head">
      <div><h1>${icon('portfolio', 20)} Portfolio de proyectos</h1><p class="muted">Todos los proyectos de IT: estado, avance, horas y cómo calzan en el calendario.</p></div>
      <div class="row gap wrap">
        <button class="btn" data-act="import">${icon('upload', 15)} Importar Excel</button>
        <button class="btn" data-act="export">${icon('download', 15)} Exportar Excel</button>
        <button class="btn primary" data-act="new">${icon('plus', 15)} Nuevo proyecto</button>
      </div>
    </div>
    <div class="kpis" data-kpis></div>
    <div class="pf-bar">
      <div class="seg" data-tabs><a href="#" data-tab="list">${icon('list', 14)} Listado</a><a href="#" data-tab="roadmap">${icon('gantt', 14)} Roadmap</a><a href="#" data-tab="calendar">${icon('calendar', 14)} Calendario</a></div>
      <div class="searchbox">${icon('search', 14)}<input data-f="q" placeholder="Buscar proyecto, clave o responsable" value="${esc(ui.q)}"></div>
      <div class="pf-status" data-statuses>${Object.entries(PSTATUS).map(([k, v]) => `<button type="button" class="pill-toggle ${ui.status.includes(k) ? 'on' : ''}" data-st="${k}" style="--c:${PSTATUS_COLOR[k]}">${v}</button>`).join('')}</div>
    </div>
    <div class="pf-bar pf-filters">
      ${sel('sector', 'Sector IT', data.options.sectors)}
      ${sel('area', 'Área', data.options.areas)}
      ${sel('lead', 'Responsable', data.options.users.filter((u) => u.active))}
      ${sel('origin', 'Origen', data.options.origins)}
      ${sel('type', 'Tipo', data.options.types)}
      <label class="mini-field"><span>Agrupar</span><select class="input sm" data-f="group">${Object.entries(GROUPS).map(([k, v]) => `<option value="${k}" ${ui.group === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <button type="button" class="link-btn" data-act="clear">Limpiar filtros</button>
    </div>
    <div data-body></div>
  </div>`;

  function sel(k, label, list) {
    return `<label class="mini-field"><span>${label}</span><select class="input sm" data-f="${k}"><option value="">Todos</option><option value="none" ${ui[k] === 'none' ? 'selected' : ''}>— Sin ${label.toLowerCase()}</option>${options(list, ui[k] ? Number(ui[k]) : null)}</select></label>`;
  }

  const bodyEl = el.querySelector('[data-body]');
  const draw = () => {
    save({ ...ui, open: ui.open });
    el.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === ui.tab));
    const rows = filtered();
    drawKpis(rows);
    if (ui.tab === 'roadmap') drawRoadmap(bodyEl, rows);
    else if (ui.tab === 'calendar') drawCalendar(bodyEl, rows);
    else drawList(bodyEl, rows);
  };

  function drawKpis(rows) {
    const all = data.rows;
    const open = all.filter((p) => ['active', 'paused', 'planned'].includes(p.portfolio_status));
    const n = (f) => open.filter(f).length;
    const est = rows.reduce((a, p) => a + Number(p.estimated_hours || 0), 0);
    const hrs = rows.reduce((a, p) => a + Number(p.hours || 0), 0);
    const year = today.slice(0, 4);
    const k = (label, value, cls, health, extra = '') => `<button type="button" class="kpi ${cls} ${ui.health === health && health ? 'sel' : ''}" ${health !== undefined ? `data-health="${health}"` : ''}><span>${label}</span><b>${value}</b>${extra}</button>`;
    el.querySelector('[data-kpis]').innerHTML = [
      k('En curso', n((p) => p.portfolio_status === 'active'), '', ''),
      k('Atrasados', n((p) => p.health === 'late'), 'danger', 'late', '<small>pasaron su fecha de fin</small>'),
      k('En riesgo', n((p) => p.health === 'risk'), 'warn', 'risk', '<small>avance 20 pts debajo de lo esperado</small>'),
      k(`Finalizados ${year}`, all.filter((p) => p.portfolio_status === 'done' && String(p.end || p.updated_at).slice(0, 4) === year).length, 'ok', 'done'),
      k('Sin planificar', n((p) => !p.planned), '', 'none', '<small>sin fechas</small>'),
      k('Horas (vista)', `${fmtNum(hrs)} <small>/ ${fmtNum(est)}</small>`, '', undefined, '<small>registradas / estimadas</small>'),
    ].join('');
  }

  // ---------- Listado ----------
  const SORTS = {
    name: (p) => p.name.toLowerCase(), status: (p) => Object.keys(PSTATUS).indexOf(p.portfolio_status), priority: (p) => -p.priority,
    start: (p) => p.start || '9999', end: (p) => (p.recurring ? '9998' : p.end || '9999'), progress: (p) => p.progress, lead: (p) => String(p.lead_name || '~'),
    hours: (p) => Number(p.estimated_hours || 0), health: (p) => ['late', 'risk', 'ok', 'none', 'done'].indexOf(p.health),
  };
  function sorted(rows) {
    const f = SORTS[ui.sort] || SORTS.end;
    const dir = ui.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => { const x = f(a); const y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * dir || a.name.localeCompare(b.name); });
  }
  function grouped(rows) {
    if (ui.group === 'none') return [{ key: '', label: '', rows }];
    const keyOf = {
      sector: (p) => [p.sector_id, p.sector_name], area: (p) => [p.area_id, p.area_name], status: (p) => [p.portfolio_status, PSTATUS[p.portfolio_status]],
      lead: (p) => [p.lead_id, p.lead_name], origin: (p) => [p.origin_id, p.origin_name], type: (p) => [p.type_id, p.type_name],
    }[ui.group];
    const map = new Map();
    for (const p of rows) {
      const [k, label] = keyOf(p);
      const id = String(k ?? 'none');
      if (!map.has(id)) map.set(id, { key: id, label: label || `Sin ${GROUPS[ui.group].toLowerCase()}`, rows: [] });
      map.get(id).rows.push(p);
    }
    const order = ui.group === 'status' ? (g) => Object.keys(PSTATUS).indexOf(g.key) : (g) => (g.key === 'none' ? 'zzz' : g.label.toLowerCase());
    return [...map.values()].sort((a, b) => (order(a) > order(b) ? 1 : -1));
  }
  const progressCell = (p) => `<div class="pf-prog" title="${p.progress_source === 'manual' ? `Avance cargado a mano${p.progress_auto !== null ? ` (calculado: ${p.progress_auto}%)` : ''}` : p.progress_source === 'auto' ? 'Calculado por etapas y tareas' : 'Sin datos de avance'}">
    <span class="progress"><span style="width:${p.progress}%;background:${p.progress >= 100 ? 'var(--ok)' : p.health === 'late' ? 'var(--danger)' : p.health === 'risk' ? 'var(--warn)' : 'var(--info)'}"></span></span>
    <b>${p.progress}%</b>${p.progress_source === 'manual' ? `<i class="pf-manual">${icon('edit', 10)}</i>` : ''}</div>`;
  const statusPill = (p) => `<span class="badge" style="--c:${PSTATUS_COLOR[p.portfolio_status]}">${PSTATUS[p.portfolio_status]}</span>`;
  const dateCell = (d, p, end) => (p.recurring && !d ? '<span class="muted small">Recurrente</span>' : d ? `<span class="${end && p.health === 'late' ? 'danger-text' : ''}">${fmtDate(d)}</span>` : '<span class="muted">—</span>');

  function drawList(host, rows) {
    if (!rows.length) {
      host.innerHTML = emptyState('No hay proyectos con estos filtros', data.rows.length ? 'Probá limpiar los filtros.' : 'Creá un proyecto o importá tu planilla de Excel.', 'portfolio',
        data.rows.length ? '' : `<button class="btn primary" data-act="import">${icon('upload', 14)} Importar Excel</button>`);
      return;
    }
    const th = (k, label, cls = '') => `<th class="sortable ${cls}" data-sort="${k}">${label}${ui.sort === k ? (ui.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    const groups = grouped(sorted(rows));
    host.innerHTML = `<div class="card flush"><div class="table-wrap pf-table"><table class="tbl">
      <thead><tr>${th('name', 'Proyecto')}<th>Origen</th><th>Sector IT</th><th>Área</th>${th('lead', 'Responsable')}${th('status', 'Estado')}${th('priority', 'Prioridad')}
        ${th('start', 'Inicio')}${th('end', 'Fin')}${th('hours', 'Horas', 'num')}${th('progress', 'Avance')}${th('health', 'Salud')}</tr></thead>
      <tbody>${groups.map((g) => `${g.label ? `<tr class="group-row"><td colspan="12"><b>${esc(g.label)}</b> <span class="muted">${g.rows.length}</span></td></tr>` : ''}
        ${g.rows.map((p) => `<tr class="clickable pf-row" data-key="${esc(p.key)}">
          <td class="pf-name"><div class="row gap"><span class="proj-key sm" style="background:${esc(p.color)}">${esc(p.key)}</span><div class="ellip-box"><b class="ellip" title="${esc(p.name)}">${esc(p.name)}</b>
            <small class="muted ellip">${esc(p.type_name || 'Sin tipo')}${p.current_phase ? ` · ${esc(p.current_phase)}${p.current_phase_by === 'dates' ? ' (por fecha)' : ''}` : ''}${p.ticket_numbers?.length ? ` · ${p.ticket_numbers.map((n) => `#${n}`).join(' ')}` : ''}</small></div></div></td>
          <td class="small">${esc(p.origin_name || '—')}</td><td class="small">${esc(p.sector_name || '—')}</td><td class="small">${esc(p.area_name || '—')}</td>
          <td class="small nowrap">${p.lead_id ? `${avatar(p.lead_id, 20)} ${esc(p.lead_name)}` : '<span class="warn-text">Sin responsable</span>'}</td>
          <td>${statusPill(p)}</td>
          <td><span class="prio-dot" style="--c:${PRIORITY_COLOR[p.priority]}"></span> ${PRIORITY[p.priority]}</td>
          <td class="small nowrap">${dateCell(p.start, p)}</td><td class="small nowrap">${dateCell(p.end, p, true)}</td>
          <td class="num small nowrap" title="Registradas / estimadas">${fmtNum(p.hours, 1)}${p.estimated_hours !== null ? ` <span class="muted">/ ${fmtNum(p.estimated_hours)}</span>` : ''}</td>
          <td>${progressCell(p)}</td>
          <td><span class="health" style="--c:${HEALTH[p.health].color}">${HEALTH[p.health].label}</span></td>
        </tr>`).join('')}`).join('')}</tbody></table></div></div>
      <p class="hint">${rows.length} proyecto(s). Avance automático: el promedio de las etapas (cada etapa vale según sus tareas hechas, o su avance cargado si no tiene tareas). El lápiz indica que el avance se cargó a mano.</p>`;
  }

  // ---------- Roadmap ----------
  function range() {
    const span = { q: 3, s: 6, y: 12 }[ui.zoom];
    if (ui.zoom === 'all') {
      const ds = data.rows.flatMap((p) => [p.start, p.end]).filter(Boolean).sort();
      const a = ds[0] || today;
      const b = ds[ds.length - 1] || today;
      return { from: new Date(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, 1), months: Math.max(3, (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1) };
    }
    const base = ui.anchor ? new Date(`${ui.anchor}T12:00:00`) : new Date(`${today}T12:00:00`);
    const startMonth = ui.zoom === 'y' ? 0 : ui.zoom === 's' ? (base.getMonth() < 6 ? 0 : 6) : Math.floor(base.getMonth() / 3) * 3;
    return { from: new Date(base.getFullYear(), startMonth, 1), months: span };
  }
  function drawRoadmap(host, rows) {
    const { from, months } = range();
    const to = new Date(from.getFullYear(), from.getMonth() + months, 1);
    const t0 = from.getTime();
    const total = to.getTime() - t0;
    const pos = (iso) => ((new Date(`${iso}T00:00:00`).getTime() - t0) / total) * 100;
    const posEnd = (iso) => ((new Date(`${iso}T00:00:00`).getTime() + 86400000 - t0) / total) * 100;
    const clamp = (x) => Math.max(0, Math.min(100, x));
    const monthsArr = Array.from({ length: months }, (_, i) => new Date(from.getFullYear(), from.getMonth() + i, 1));
    const todayPos = pos(today);
    const label = ui.zoom === 'all' ? 'Todo el período' : `${MONTHS[from.getMonth()]} ${from.getFullYear()} – ${MONTHS[(from.getMonth() + months - 1) % 12]} ${new Date(from.getFullYear(), from.getMonth() + months - 1, 1).getFullYear()}`;
    const planned = rows.filter((p) => p.planned);
    const unplanned = rows.filter((p) => !p.planned);
    const groups = grouped(sorted(planned));
    const bar = (p) => {
      if (p.recurring && (!p.start || !p.end)) {
        const l = p.start ? clamp(pos(p.start)) : 0;
        const r = p.end ? clamp(posEnd(p.end)) : 100;
        return `<div class="rmb recurring" style="left:${l}%;width:${Math.max(0.8, r - l)}%;--c:${esc(p.color)}" title="Recurrente · ${p.progress}%"><span class="rmb-label">Recurrente · ${p.progress}%</span></div>`;
      }
      const s = pos(p.start);
      const e = posEnd(p.end);
      if (e <= 0) return `<span class="rm-out left">← terminó ${fmtDate(p.end)}</span>`;
      if (s >= 100) return `<span class="rm-out right">empieza ${fmtDate(p.start)} →</span>`;
      const l = clamp(s);
      const w = Math.max(0.8, clamp(e) - l);
      const ticks = p.phases.filter((f) => f.start_date && f.start_date > p.start && f.start_date <= p.end).map((f) => {
        const x = ((pos(f.start_date) - s) / (e - s)) * 100;
        return x > 0 && x < 100 ? `<i class="rmb-tick" style="left:${x}%" title="${esc(f.title)}"></i>` : '';
      }).join('');
      const tip = `${p.name} · ${fmtDate(p.start)} → ${fmtDate(p.end)} · ${p.progress}%${p.current_phase ? ` · ${p.current_phase}` : ''}`;
      return `<div class="rmb h-${p.health} ${s < 0 ? 'cut-l' : ''} ${e > 100 ? 'cut-r' : ''}" style="left:${l}%;width:${w}%;--c:${esc(p.color)}" title="${esc(tip)}">
        <span class="rmb-fill" style="width:${p.progress}%"></span>${ticks}<span class="rmb-label">${p.progress}%${p.current_phase ? ` · ${esc(p.current_phase)}` : ''}</span></div>`;
    };
    const phaseRows = (p) => p.phases.map((f) => {
      const has = f.start_date && f.due_date;
      const s = has ? clamp(pos(f.start_date)) : 0;
      const e = has ? clamp(posEnd(f.due_date)) : 0;
      return `<div class="rm2-row phase"><div class="rm2-label"><span class="ph-state st-${f.state}"></span><span class="ellip">${esc(f.title)}</span><small class="muted">${f.pct}%</small></div>
        <div class="rm2-track">${months > 0 ? '' : ''}${has && e > 0 && s < 100 ? `<div class="rmp st-${f.state}" style="left:${s}%;width:${Math.max(0.6, e - s)}%" title="${esc(f.title)} · ${fmtDate(f.start_date)} → ${fmtDate(f.due_date)} · ${PHASE_STATE[f.state]} ${f.pct}%"><span style="width:${f.pct}%"></span></div>`
    : has ? '' : '<span class="muted small rm-nodate">Sin fechas</span>'}</div></div>`;
    }).join('');
    host.innerHTML = `<div class="rm2-tools">
        <div class="seg">${[['q', 'Trimestre'], ['s', 'Semestre'], ['y', 'Año'], ['all', 'Todo']].map(([k, v]) => `<a href="#" data-zoom="${k}" class="${ui.zoom === k ? 'on' : ''}">${v}</a>`).join('')}</div>
        ${ui.zoom === 'all' ? '' : `<div class="row gap"><button class="icon-btn" data-shift="-1" aria-label="Anterior">${icon('left', 16)}</button><b class="rm2-range">${label}</b><button class="icon-btn" data-shift="1" aria-label="Siguiente">${icon('right', 16)}</button><button class="btn sm" data-shift="0">Hoy</button></div>`}
        <span class="grow"></span>
        <span class="rm2-legend"><i class="lg h-ok"></i> En término <i class="lg h-risk"></i> En riesgo <i class="lg h-late"></i> Atrasado <i class="lg h-done"></i> Finalizado <i class="lg rec"></i> Recurrente</span>
      </div>
      <div class="rm2">
        <div class="rm2-head"><div class="rm2-label">Proyecto</div><div class="rm2-track">${monthsArr.map((m, i) => `<span class="rm2-month ${m.getMonth() === 0 ? 'year' : ''}" style="left:${(i / months) * 100}%;width:${100 / months}%">${months > 18 ? MONTHS[m.getMonth()][0].toUpperCase() : MONTHS[m.getMonth()]}${m.getMonth() === 0 || i === 0 ? ` <small>${m.getFullYear()}</small>` : ''}</span>`).join('')}</div></div>
        <div class="rm2-body" style="--grid:${100 / months}%">
        ${todayPos >= 0 && todayPos <= 100 ? `<i class="rm2-today" style="left:calc(var(--lw) + (100% - var(--lw)) * ${todayPos / 100})" title="Hoy"></i>` : ''}
        ${groups.map((g) => `${g.label ? `<div class="rm2-group"><b>${esc(g.label)}</b> <span class="muted">${g.rows.length}</span></div>` : ''}
          ${g.rows.map((p) => `<div class="rm2-row" data-key="${esc(p.key)}">
            <div class="rm2-label"><button type="button" class="icon-btn xs" data-toggle="${esc(p.key)}" aria-label="Ver etapas" ${p.phases.length ? '' : 'disabled'}>${icon(ui.open[p.key] ? 'down' : 'right', 12)}</button>
              <span class="proj-key sm" style="background:${esc(p.color)}">${esc(p.key)}</span><span class="ellip pf-open" title="${esc(p.name)}">${esc(p.name)}</span>${p.lead_id ? avatar(p.lead_id, 18) : ''}</div>
            <div class="rm2-track">${bar(p)}</div></div>${ui.open[p.key] ? phaseRows(p) : ''}`).join('')}`).join('') || '<p class="muted pad">No hay proyectos con fechas en esta vista.</p>'}
        </div>
      </div>
      ${unplanned.length ? `<div class="card rm2-unplanned"><h3>${icon('alert', 15)} Sin planificar (${unplanned.length})</h3><p class="hint">Les falta la fecha de inicio, la de fin o ambas. Hacé clic para completarlas.</p>
        <div class="chips">${unplanned.map((p) => `<button type="button" class="chip pf-row" data-key="${esc(p.key)}"><span class="proj-key xs" style="background:${esc(p.color)}">${esc(p.key)}</span> ${esc(p.name)} <small>${PSTATUS[p.portfolio_status]} · ${p.progress}%</small></button>`).join('')}</div></div>` : ''}`;
  }

  // ---------- Calendario ----------
  function drawCalendar(host, rows) {
    const from = ui.calFrom || today.slice(0, 7);
    host.innerHTML = calendarHtml(rows, {
      today, capacity: data.capacity || 80, from, selected: ui.calSel || today.slice(0, 7), canEditCapacity: isAdmin(), health: HEALTH,
    });
  }

  // ---------- Edición rápida ----------
  function editProject(key) {
    const p = data.rows.find((x) => x.key === key);
    if (!p) return;
    const types = (state.meta.projectTypes || []).filter((t) => t.active || t.id === p.type_id);
    const md = modal({
      title: `${p.key} · ${p.name}`,
      wide: true,
      body: `<div class="grid3">
          <label class="field" style="grid-column:span 2"><span>Nombre</span><input class="input" name="name" value="${esc(p.name)}"></label>
          <label class="field"><span>Tipo</span><select class="input" name="type_id">${options(types, p.type_id, { empty: '—' })}</select></label>
        </div>
        <label class="field"><span>Descripción</span><textarea class="input" name="description" rows="2">${esc(p.description || '')}</textarea></label>
        <div class="grid3"><label class="field"><span>Responsable</span><select class="input" name="lead_id">${options(state.meta.users.filter((u) => u.active || u.id === p.lead_id), p.lead_id, { empty: '—' })}</select></label></div>
        ${portfolioFieldsHtml({ ...p, start_date: p.start_date, end_date: p.end_date })}
        <div class="grid3">
          <div class="field"><span>Avance</span>
            <label class="check"><input type="radio" name="pmode" value="auto" ${p.progress_override === null ? 'checked' : ''}> Automático ${p.progress_auto !== null ? `(${p.progress_auto}%)` : '<small class="muted">(sin etapas ni tareas)</small>'}</label>
            <label class="check"><input type="radio" name="pmode" value="manual" ${p.progress_override !== null ? 'checked' : ''}> Manual <input class="input sm inline-num" type="number" min="0" max="100" name="progress_override" value="${p.progress_override ?? p.progress}"> %</label>
          </div>
          <label class="field"><span>Horas manuales <small class="muted">(se suman a las registradas)</small></span><input class="input" type="number" min="0" step="0.5" name="extra_hours" value="${Number(p.extra_hours || 0)}"></label>
          <div class="field"><span>Horas registradas en tareas</span><b class="pf-big">${fmtNum(p.logged_hours, 1)} h</b></div>
        </div>
        ${p.phases.length ? `<h4>Etapas</h4><div class="pf-phases">${p.phases.map((f) => `<div class="pf-phase"><span class="ph-state st-${f.state}"></span><b>${esc(f.title)}</b>
          <small class="muted">${f.start_date ? fmtDate(f.start_date) : '—'} → ${f.due_date ? fmtDate(f.due_date) : '—'}</small><span class="grow"></span><small>${PHASE_STATE[f.state]} · ${f.pct}%</small></div>`).join('')}</div>` : ''}
        <p class="hint">Si el proyecto tiene fechas y etapas sin fecha, se reparten al ver el roadmap del proyecto. Las fechas, el avance de cada etapa y las tareas se editan desde el proyecto.</p>`,
      footer: `<a class="btn ghost" href="#/projects/${esc(p.key)}/roadmap" data-close>${icon('external', 14)} Abrir proyecto</a><span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>`,
    });
    const g = (n) => md.el.querySelector(`[name=${n}]`);
    md.el.querySelector('[data-ok]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const pf = readPortfolioFields(md.el);
      if (pf.start_date && pf.end_date && pf.end_date < pf.start_date) return toast('La fecha de fin no puede ser anterior al inicio', 'error');
      const manual = md.el.querySelector('[name=pmode]:checked').value === 'manual';
      btn.disabled = true;
      try {
        await api(`/projects/${encodeURIComponent(p.key)}`, {
          method: 'PATCH',
          body: {
            ...pf, name: g('name').value.trim(), description: g('description').value, type_id: Number(g('type_id').value) || null, lead_id: Number(g('lead_id').value) || null,
            progress_override: manual ? Math.max(0, Math.min(100, Number(g('progress_override').value) || 0)) : null, extra_hours: Number(g('extra_hours').value) || 0,
          },
        });
        md.close();
        toast('Proyecto actualizado');
        data = await api('/portfolio');
        draw();
      } catch (er) { toastError(er); btn.disabled = false; }
    });
  }

  // ---------- Importar ----------
  function importDialog() {
    const md = modal({
      title: 'Importar portfolio desde Excel',
      wide: true,
      body: `<p class="muted small">Subí tu planilla (.xlsx). Se reconocen las columnas <b>Proyecto</b>, Descripción, Tipo, Origen, Sector IT, Área, Responsable, Estado, Prioridad, Fecha Inicio, Fecha Fin, Horas Estimadas, % Avance y Horas Manuales (en cualquier orden; alcanza con que el encabezado empiece así).
        Los proyectos que ya existen (mismo nombre o clave) se actualizan; los nuevos se crean con las etapas de su tipo. Primero vas a ver una vista previa: no se guarda nada hasta que confirmes.</p>
        <div class="row gap wrap"><label class="btn">${icon('upload', 14)} Elegir archivo<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden data-file></label>
          <input class="input sm" data-sheet placeholder="Hoja (opcional; si no, la primera)" style="max-width:240px">
          <a class="link-btn" href="/api/portfolio/template" data-tpl>Descargar plantilla</a></div>
        <div data-preview></div>`,
      footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok disabled>Importar</button>',
    });
    let payload = null;
    const pv = md.el.querySelector('[data-preview]');
    const ok = md.el.querySelector('[data-ok]');
    md.el.querySelector('[data-file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) return toast('El archivo supera 4 MB', 'error');
      pv.innerHTML = '<div class="loading"><span class="spinner"></span> Leyendo la planilla…</div>';
      ok.disabled = true;
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
      payload = { filename: file.name, data: b64, sheet: md.el.querySelector('[data-sheet]').value.trim() || undefined };
      try {
        const plan = await api('/portfolio/import', { method: 'POST', body: { ...payload, dry: true } });
        const c = plan.rows.filter((r) => r.action === 'create').length;
        const u = plan.rows.filter((r) => r.action === 'update').length;
        const w = plan.rows.filter((r) => r.warnings.length).length;
        const created = Object.entries({ origin: 'Origen', sector: 'Sector IT', area: 'Área' }).flatMap(([k, l]) => plan.create_options[k].map((x) => `${l}: ${x}`));
        pv.innerHTML = `<div class="imp-sum"><span class="badge" style="--c:#059669">${c} nuevos</span> <span class="badge" style="--c:#2563eb">${u} se actualizan</span> ${w ? `<span class="badge" style="--c:#d97706">${w} con advertencias</span>` : ''}
            ${created.length ? `<span class="muted small">Se agregan a las listas: ${esc(created.join(' · '))}</span>` : ''}</div>
          <div class="table-wrap imp-table"><table class="tbl compact"><thead><tr><th>Fila</th><th></th><th>Clave</th><th>Proyecto</th><th>Tipo</th><th>Responsable</th><th>Estado</th><th>Fechas</th><th>Avance</th><th>Advertencias</th></tr></thead><tbody>
          ${plan.rows.map((r) => `<tr class="${r.action === 'skip' ? 'inactive' : ''}"><td class="muted">${r.row}</td><td>${r.action === 'create' ? '<span class="badge" style="--c:#059669">Nuevo</span>' : r.action === 'update' ? '<span class="badge" style="--c:#2563eb">Actualiza</span>' : '<span class="badge">Se omite</span>'}</td>
            <td><code>${esc(r.key || '')}</code></td><td>${esc(r.name)}</td><td class="small">${esc(r.fields.type?.name || '')}</td><td class="small">${esc(r.fields.lead?.name || '—')}</td>
            <td class="small">${r.fields.status ? PSTATUS[r.fields.status] : '—'}</td>
            <td class="small nowrap">${r.fields.recurring ? 'Recurrente' : `${r.fields.start_date ? fmtDate(r.fields.start_date) : '—'} → ${r.fields.end_date ? fmtDate(r.fields.end_date) : '—'}`}</td>
            <td class="small">${r.fields.progress ?? '—'}${r.fields.progress !== null && r.fields.progress !== undefined ? '%' : ''}</td>
            <td class="small warn-text">${esc(r.warnings.join(' · '))}</td></tr>`).join('')}</tbody></table></div>`;
        ok.disabled = false;
        ok.textContent = `Importar ${c + u} proyecto(s)`;
      } catch (er) {
        pv.innerHTML = `<div class="callout warn">${icon('alert', 16)} ${esc(er.message)}</div>`;
      }
    });
    ok.addEventListener('click', async () => {
      if (!payload) return;
      ok.disabled = true;
      try {
        const r = await api('/portfolio/import', { method: 'POST', body: { ...payload, dry: false } });
        md.close();
        toast(`Listo: ${r.created} proyectos nuevos y ${r.updated} actualizados`);
        await refreshMeta();
        data = await api('/portfolio');
        ui.status = Object.keys(PSTATUS).filter((k) => k !== 'cancelled');
        draw();
      } catch (er) { toastError(er); ok.disabled = false; }
    });
  }

  // ---------- Eventos ----------
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const tab = t.closest('[data-tab]');
    if (tab) { e.preventDefault(); ui.tab = tab.dataset.tab; draw(); return; }
    const st = t.closest('[data-st]');
    if (st) { const k = st.dataset.st; ui.status = ui.status.includes(k) ? ui.status.filter((x) => x !== k) : [...ui.status, k]; st.classList.toggle('on'); draw(); return; }
    const h = t.closest('[data-health]');
    if (h) {
      ui.health = ui.health === h.dataset.health ? '' : h.dataset.health;
      if (ui.health === 'done') ui.status = [...new Set([...ui.status, 'done'])];
      draw();
      return;
    }
    const s = t.closest('[data-sort]');
    if (s) { ui.dir = ui.sort === s.dataset.sort && ui.dir === 'asc' ? 'desc' : 'asc'; ui.sort = s.dataset.sort; draw(); return; }
    const z = t.closest('[data-zoom]');
    if (z) { e.preventDefault(); ui.zoom = z.dataset.zoom; ui.anchor = null; draw(); return; }
    const sh = t.closest('[data-shift]');
    if (sh) {
      const n = Number(sh.dataset.shift);
      if (!n) ui.anchor = null;
      else {
        const { from } = range();
        const step = { q: 3, s: 6, y: 12 }[ui.zoom];
        const d = new Date(from.getFullYear(), from.getMonth() + n * step, 15);
        ui.anchor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
      }
      draw();
      return;
    }
    const cm = t.closest('[data-cal-month]');
    if (cm) { ui.calSel = cm.dataset.calMonth; draw(); el.querySelector(`[data-cal-month="${ui.calSel}"]`)?.focus(); return; }
    const cs = t.closest('[data-cal-shift]');
    if (cs) {
      const n = Number(cs.dataset.calShift);
      ui.calFrom = n ? addMonths(ui.calFrom || today.slice(0, 7), n) : null;
      if (!n) ui.calSel = null;
      draw();
      return;
    }
    if (t.closest('[data-cal-cap-save]')) {
      const v = Math.round(Number(el.querySelector('[data-cal-cap]').value));
      if (!(v >= 1 && v <= 744)) return toast('La capacidad tiene que estar entre 1 y 744 horas', 'error');
      try {
        await api('/admin/settings/helpdesk', { method: 'PUT', body: { portfolio_month_hours: v } });
        data.capacity = v;
        toast('Capacidad guardada');
        draw();
      } catch (er) { toastError(er); }
      return;
    }
    const tg = t.closest('[data-toggle]');
    if (tg) { ui.open[tg.dataset.toggle] = !ui.open[tg.dataset.toggle]; draw(); return; }
    const row = t.closest('.pf-row, .rm2-row[data-key], .cal-chip[data-key], .cal-endrow[data-key]');
    if (row) { editProject(row.dataset.key); return; }
    const a = t.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'import') importDialog();
    if (a.dataset.act === 'export') {
      const params = new URLSearchParams();
      if (ui.status.length) params.set('status', ui.status.join(','));
      for (const k of ['sector', 'area', 'origin', 'type', 'lead', 'health', 'q']) if (ui[k]) params.set(k, ui[k]);
      downloadUrl(`/api/portfolio/export?${params}`);
    }
    if (a.dataset.act === 'clear') {
      Object.assign(ui, { q: '', sector: '', area: '', lead: '', origin: '', type: '', health: '', status: ['planned', 'active', 'paused', 'done'] });
      el.querySelector('[data-f=q]').value = '';
      el.querySelectorAll('select[data-f]').forEach((x) => { if (x.dataset.f !== 'group') x.value = ''; });
      el.querySelectorAll('[data-st]').forEach((x) => x.classList.toggle('on', ui.status.includes(x.dataset.st)));
      draw();
    }
    if (a.dataset.act === 'new') {
      const r = await openProjectForm();
      if (!r) return;
      await refreshMeta();
      toast(`Proyecto ${r.project.key} creado`);
      data = await api('/portfolio');
      draw();
    }
  });
  el.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (f && f !== 'q') { ui[f] = e.target.value; draw(); }
  });
  el.querySelector('[data-f=q]').addEventListener('input', debounce((e) => { ui.q = e.target.value.trim(); draw(); }, 200));
  draw();
}
