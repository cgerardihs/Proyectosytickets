import { state, api, esc, icon, avatar, toast, navigate, emptyState, userName, options, debounce, fmtDate, PRIORITY } from '../core.js';
import { openProjectForm, PSTATUS, PSTATUS_COLOR } from './project-form.js';
import { setCrumbs, refreshMeta } from '../app.js';

// Filtros de la lista de proyectos (se recuerdan en este navegador)
const DEFAULTS = { q: '', type: '', status: '', person: '', role: 'any', priority: '', origin: '', sector: '', area: '', when: '', sprint: false, archived: false, sort: 'name', view: 'cards' };
const load = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('proj-ui') || '{}') }; } catch { return { ...DEFAULTS }; } };
const save = (ui) => { try { localStorage.setItem('proj-ui', JSON.stringify(ui)); } catch { /* sin almacenamiento */ } };
const ROLES = { any: 'en cualquier rol', lead: 'como líder', member: 'como integrante', tasks: 'con tareas asignadas' };
const WHEN = { late: 'Atrasados', month: 'Terminan este mes', quarter: 'Terminan en los próximos 3 meses', nodate: 'Sin fecha de fin' };
const SORTS = { name: 'Nombre', end: 'Fecha de fin', progress: 'Avance', open: 'Tareas abiertas', recent: 'Actividad reciente' };
// v1.26: columnas de la vista Lista (cada agente elige cuáles, en qué orden y con qué ancho; se guarda en la base).
// Mantener alineado con PROJECT_COLUMNS de lib/view-prefs.js.
const PCOLDEFS = {
  name: { label: 'Proyecto', w: 360, lock: true }, type: { label: 'Tipo', w: 170 }, status: { label: 'Estado', w: 120 }, lead: { label: 'Líder', w: 190 },
  priority: { label: 'Prioridad', w: 100 }, open: { label: 'Abiertas', w: 90, num: true }, progress: { label: 'Avance', w: 170 }, end: { label: 'Fin', w: 110 },
  origin: { label: 'Origen', w: 150, nueva: true }, sector: { label: 'Sector IT', w: 160, nueva: true }, area: { label: 'Área solicitante', w: 160, nueva: true },
  start: { label: 'Inicio', w: 110, nueva: true }, health: { label: 'Salud', w: 120, nueva: true }, hours: { label: 'Horas estimadas', w: 120, num: true, nueva: true },
  logged: { label: 'Horas registradas', w: 130, num: true, nueva: true }, current: { label: 'Etapa o tarea actual', w: 200, nueva: true },
  members: { label: 'Integrantes', w: 110, num: true, nueva: true }, tasks: { label: 'Tareas', w: 90, num: true, nueva: true },
  sprint: { label: 'Sprint activo', w: 150, nueva: true }, created: { label: 'Creado', w: 110, nueva: true },
};
const PDEFAULT_ON = ['name', 'type', 'status', 'lead', 'priority', 'open', 'progress', 'end'];
const HEALTH = { late: ['Atrasado', '#dc2626'], risk: ['En riesgo', '#d97706'], ok: ['En término', '#059669'], done: ['Finalizado', '#059669'], none: ['Sin fechas', '#9ca3af'] };

export async function render(el, _p, query) {
  setCrumbs([{ label: 'Proyectos' }]);
  const list = await api('/projects');
  const ui = load();
  if (query.archived === '1') ui.archived = true;
  const m = state.meta;
  // Un filtro guardado que apunta a algo que ya no existe (tipo borrado, persona inactiva) se descarta
  const valid = (val, arr) => !val || val === 'none' || (arr || []).some((x) => String(x.id) === String(val));
  for (const [k, arr] of [['type', m.projectTypes], ['origin', m.origins], ['sector', m.sectors], ['area', m.categories]]) if (!valid(ui[k], arr)) ui[k] = '';
  if (ui.person && ui.person !== 'me' && !m.users.some((u) => u.active && String(u.id) === ui.person)) { ui.person = ''; ui.role = 'any'; }
  const typeOf = (id) => (m.projectTypes || []).find((t) => t.id === id);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const today = ymd(now); // fecha local (no UTC: en Buenos Aires después de las 21 ya sería "mañana")
  const monthEnd = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const in3 = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const quarterEnd = ymd(new Date(in3.getFullYear(), in3.getMonth(), Math.min(now.getDate(), new Date(in3.getFullYear(), in3.getMonth() + 1, 0).getDate())));
  const pct = (p) => (typeof p.progress === 'number' ? p.progress : p.total_issues ? Math.round((p.done_issues / p.total_issues) * 100) : 0);
  const end = (p) => (p.end_date ? String(p.end_date).slice(0, 10) : '');
  const closed = (p) => ['done', 'cancelled'].includes(p.portfolio_status);

  const matchPerson = (p) => {
    if (!ui.person) return true;
    const id = ui.person === 'me' ? state.me.id : Number(ui.person);
    const lead = p.lead_id === id;
    const member = (p.member_ids || []).includes(id);
    const tasks = (p.assignee_ids || []).includes(id);
    return { any: lead || member || tasks, lead, member, tasks }[ui.role] ?? (lead || member || tasks);
  };
  // Con "Persona" elegida, cada proyecto dice por qué aparece (líder, en el equipo, con tareas)
  const why = (p) => {
    if (!ui.person) return '';
    const id = ui.person === 'me' ? state.me.id : Number(ui.person);
    const r = [];
    if (p.lead_id === id) r.push('líder');
    if (p.lead_id !== id && (p.member_ids || []).includes(id)) r.push('en el equipo');
    if ((p.assignee_ids || []).includes(id)) r.push('con tareas');
    return r.length ? `<span class="chip sm muted" title="Por qué aparece con este filtro">${r.join(' · ')}</span>` : '';
  };
  const matchWhen = (p) => {
    if (!ui.when) return true;
    const e = end(p);
    if (ui.when === 'nodate') return !e;
    if (!e) return false;
    if (ui.when === 'late') return e < today && !closed(p);
    return e >= today && e <= (ui.when === 'month' ? monthEnd : quarterEnd);
  };
  const filtered = () => list.filter((p) => {
    if (!ui.archived && p.archived) return false;
    if (ui.type && String(p.type_id ?? 'none') !== ui.type) return false;
    if (ui.status && p.portfolio_status !== ui.status) return false;
    if (ui.priority && String(p.priority) !== ui.priority) return false;
    for (const [k, col] of [['origin', 'origin_id'], ['sector', 'sector_id'], ['area', 'area_id']]) if (ui[k] && String(p[col] ?? 'none') !== ui[k]) return false;
    if (ui.sprint && !p.active_sprint) return false;
    if (!matchPerson(p) || !matchWhen(p)) return false;
    if (ui.q) {
      const t = ui.q.toLowerCase();
      if (![p.name, p.key, p.description, userName(p.lead_id)].some((x) => String(x || '').toLowerCase().includes(t))) return false;
    }
    return true;
  });
  const sorted = (rows) => {
    const f = { name: (p) => p.name.toLowerCase(), end: (p) => end(p) || '9999', progress: (p) => -pct(p), open: (p) => -p.open_issues, recent: (p) => -new Date(p.updated_at || p.created_at).getTime() }[ui.sort] || ((p) => p.name.toLowerCase());
    return [...rows].sort((a, b) => (f(a) > f(b) ? 1 : f(a) < f(b) ? -1 : 0) || a.name.localeCompare(b.name));
  };

  const sel = (k, label, opts, empty = 'Todos') => `<label class="mini-field"><span>${esc(label)}</span><select class="input sm" data-pf="${k}"><option value="">${esc(empty)}</option>${opts}</select></label>`;
  const optList = (arr, cur, none) => `${none ? `<option value="none" ${cur === 'none' ? 'selected' : ''}>— ${esc(none)}</option>` : ''}${options(arr, cur && cur !== 'none' ? Number(cur) : null)}`;
  const kv = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${String(cur) === String(k) ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const active = () => ['q', 'type', 'status', 'person', 'priority', 'origin', 'sector', 'area', 'when'].filter((k) => ui[k]).length + (ui.sprint ? 1 : 0);

  el.innerHTML = `<div class="page">
    <div class="page-head">
      <div><h1>Proyectos</h1><p class="muted">Desarrollos, instalaciones, infraestructura y capacitaciones: cada uno con sus etapas.</p></div>
      <div class="row gap">
        ${m.canPortfolio ? `<a class="btn" href="#/portfolio">${icon('chart', 15)} Portfolio y roadmap</a>` : ''}
        <button class="btn primary" data-act="new">${icon('plus', 15)} Crear proyecto</button>
      </div>
    </div>
    <div class="pf-bar proj-filters-top">
      <div class="searchbox">${icon('search', 14)}<input data-pf="q" placeholder="Buscar por nombre, clave, descripción o líder" value="${esc(ui.q)}"></div>
      <button type="button" class="pill-toggle ${ui.person === 'me' ? 'on' : ''}" data-act="mine" style="--c:#2563eb">${icon('user', 13)} Mis proyectos</button>
      <span class="grow"></span>
      <label class="mini-field"><span>Ordenar</span><select class="input sm" data-pf="sort">${kv(SORTS, ui.sort)}</select></label>
      <div class="seg" data-views><a href="#" data-view="cards" class="${ui.view === 'cards' ? 'on' : ''}">${icon('board', 14)} Tarjetas</a><a href="#" data-view="table" class="${ui.view === 'table' ? 'on' : ''}">${icon('list', 14)} Lista</a></div>
      <span class="tkc-wrap" data-colwrap ${ui.view === 'table' ? '' : 'hidden'}><button type="button" class="btn sm" data-act="pcols" aria-expanded="false" title="Elegir columnas de la lista">${icon('columns', 15)} Columnas</button></span>
    </div>
    <div class="pf-bar pf-filters">
      ${sel('type', 'Tipo de proyecto', optList(m.projectTypes || [], ui.type, 'Sin tipo'))}
      ${sel('status', 'Estado', kv(PSTATUS, ui.status))}
      <div class="mini-field"><span>Persona</span><span class="row gap"><select class="input sm" data-pf="person"><option value="">Todas</option><option value="me" ${ui.person === 'me' ? 'selected' : ''}>Yo</option>${options(m.users.filter((u) => u.active), ui.person && ui.person !== 'me' ? Number(ui.person) : null)}</select>
        <select class="input sm" data-pf="role" ${ui.person ? '' : 'disabled'}>${kv(ROLES, ui.role)}</select></span></div>
      ${sel('priority', 'Prioridad', kv(PRIORITY, ui.priority), 'Todas')}
      ${sel('when', 'Fechas', kv(WHEN, ui.when), 'Cualquier fecha')}
      ${(m.origins || []).length ? sel('origin', 'Origen', optList(m.origins, ui.origin, 'Sin origen')) : ''}
      ${(m.sectors || []).length ? sel('sector', 'Sector IT', optList(m.sectors, ui.sector, 'Sin sector')) : ''}
      ${sel('area', 'Área solicitante', optList(m.categories || [], ui.area, 'Sin área'), 'Todas')}
      <label class="check sm"><input type="checkbox" data-pf="sprint" ${ui.sprint ? 'checked' : ''}> Con sprint activo</label>
      <label class="check sm"><input type="checkbox" data-pf="archived" ${ui.archived ? 'checked' : ''}> Incluir archivados</label>
    </div>
    <div data-body></div>
  </div>`;

  const bodyEl = el.querySelector('[data-body]');
  const card = (p) => `<a class="proj-card ${p.archived ? 'archived' : ''}" href="#/projects/${esc(p.key)}/${typeOf(p.type_id)?.uses_sprints === false ? 'roadmap' : 'board'}">
        <div class="proj-top"><span class="proj-key" style="background:${esc(p.color)}">${esc(p.key)}</span>
          ${typeOf(p.type_id) ? `<span class="badge" style="--c:${esc(typeOf(p.type_id).color)}">${esc(typeOf(p.type_id).name)}</span>` : ''}
          ${p.portfolio_status && p.portfolio_status !== 'active' ? `<span class="badge" style="--c:${PSTATUS_COLOR[p.portfolio_status]}">${PSTATUS[p.portfolio_status]}</span>` : ''}
          ${p.archived ? '<span class="badge">Archivado</span>' : ''}${why(p)}</div>
        <h3>${esc(p.name)}</h3>
        <p class="muted small clamp2">${esc(p.description || 'Sin descripción')}</p>
        <div class="progress"><span style="width:${pct(p)}%;background:${esc(p.color)}"></span></div>
        <div class="proj-foot">
          <span>${p.open_issues} abiertas · ${pct(p)}% hecho${end(p) ? ` · fin ${fmtDate(end(p))}` : ''}</span>
          ${p.active_sprint ? `<span class="chip sm">${icon('play', 10)} ${esc(p.active_sprint)}</span>` : ''}
        </div>
        <div class="proj-foot"><span class="muted small">Líder: ${p.lead_id ? esc(userName(p.lead_id)) : '<span class="warn-text">sin responsable</span>'}</span><span class="avatars">${[...new Set([...(p.member_ids || []), ...(p.assignee_ids || [])])].slice(0, 5).map((x) => avatar(x, 22)).join('')}</span></div>
      </a>`;
  // ---------- Columnas de la vista Lista (v1.26) ----------
  const normCols = (c) => {
    const order = (c?.order || []).filter((k) => PCOLDEFS[k]);
    for (const k of Object.keys(PCOLDEFS)) if (!order.includes(k)) order.push(k);
    const on = (c?.on || PDEFAULT_ON).filter((k) => PCOLDEFS[k]);
    if (!on.includes('name')) on.unshift('name');
    return { order, on, w: { ...(c?.w || {}) } };
  };
  let cols = normCols(m.viewPrefs?.projects);
  const visible = () => cols.order.filter((k) => cols.on.includes(k));
  const saveCols = debounce(async () => {
    try { const r = await api('/me/view-prefs/projects', { method: 'PUT', body: cols }); m.viewPrefs = { ...(m.viewPrefs || {}), projects: r }; } catch (e) { toast(e.message, 'error'); }
  }, 600);
  const nameOf = (arr, id) => (arr || []).find((x) => x.id === id)?.name || '—';
  const pstart = (p) => (p.p_start || (p.start_date ? String(p.start_date).slice(0, 10) : '')) || '';
  const pend = (p) => (p.p_end || end(p)) || '';
  const cellOf = {
    name: (p) => `<td><span class="row gap"><span class="proj-key sm" style="background:${esc(p.color)}">${esc(p.key)}</span><b class="ellip" title="${esc(p.name)}">${esc(p.name)}</b>${p.archived ? ' <span class="badge">Archivado</span>' : ''}${why(p)}</span></td>`,
    type: (p) => `<td class="small">${esc(typeOf(p.type_id)?.name || '—')}</td>`,
    status: (p) => `<td>${p.portfolio_status ? `<span class="badge" style="--c:${PSTATUS_COLOR[p.portfolio_status]}">${PSTATUS[p.portfolio_status]}</span>` : '—'}</td>`,
    lead: (p) => `<td class="small nowrap">${p.lead_id ? `${avatar(p.lead_id, 20)} ${esc(userName(p.lead_id))}` : '<span class="warn-text">Sin responsable</span>'}</td>`,
    priority: (p) => `<td class="small">${PRIORITY[p.priority] || '—'}</td>`,
    open: (p) => `<td class="num">${p.open_issues}</td>`,
    progress: (p) => `<td><div class="pf-prog"><span class="progress"><span style="width:${pct(p)}%;background:${esc(p.color)}"></span></span><b>${pct(p)}%</b></div></td>`,
    end: (p) => `<td class="small nowrap ${pend(p) && pend(p) < today && !closed(p) ? 'danger-text' : ''}">${pend(p) ? fmtDate(pend(p)) : '—'}</td>`,
    origin: (p) => `<td class="small">${esc(nameOf(m.origins, p.origin_id))}</td>`,
    sector: (p) => `<td class="small">${esc(nameOf(m.sectors, p.sector_id))}</td>`,
    area: (p) => `<td class="small">${esc(nameOf(m.categories, p.area_id ?? p.category_id))}</td>`,
    start: (p) => `<td class="small nowrap">${pstart(p) ? fmtDate(pstart(p)) : '—'}</td>`,
    health: (p) => { const h = HEALTH[p.health] || HEALTH.none; return `<td class="small nowrap"><span class="prj-health" style="--c:${h[1]}"></span>${h[0]}</td>`; },
    hours: (p) => `<td class="num">${p.estimated_hours === undefined || p.estimated_hours === null ? '—' : Number(p.estimated_hours).toLocaleString('es-AR')}</td>`,
    logged: (p) => `<td class="num">${Number(p.logged_hours || 0).toLocaleString('es-AR', { maximumFractionDigits: 1 })}</td>`,
    current: (p) => `<td class="small"><span class="ellip" title="${esc(p.current_phase || '')}">${esc(p.current_phase || '—')}</span></td>`,
    members: (p) => `<td class="num">${(p.member_ids || []).length}</td>`,
    tasks: (p) => `<td class="num">${p.total_issues}</td>`,
    sprint: (p) => `<td class="small">${esc(p.active_sprint || '—')}</td>`,
    created: (p) => `<td class="small nowrap">${p.created_at ? fmtDate(String(p.created_at).slice(0, 10)) : '—'}</td>`,
  };
  const row = (p) => `<tr class="clickable" data-href="#/projects/${esc(p.key)}/${typeOf(p.type_id)?.uses_sprints === false ? 'roadmap' : 'board'}">${visible().map((k) => cellOf[k](p)).join('')}</tr>`;
  const headHtml = () => `<colgroup>${visible().map((k) => `<col data-k="${k}" ${Object.keys(cols.w).length ? `style="width:${cols.w[k] || PCOLDEFS[k].w}px"` : ''}>`).join('')}</colgroup>
    <thead><tr>${visible().map((k) => `<th data-col="${k}" class="${PCOLDEFS[k].num ? 'num' : ''}">${esc(PCOLDEFS[k].label)}<span class="tk-rz" data-rz="${k}" title="Arrastrá para cambiar el ancho; doble clic para ajustarlo al contenido" aria-hidden="true"></span></th>`).join('')}</tr></thead>`;
  const tableWidth = () => (Object.keys(cols.w).length ? `style="width:${visible().reduce((t, k) => t + (cols.w[k] || PCOLDEFS[k].w), 0)}px"` : '');
  const draw = () => {
    save(ui);
    const rows = sorted(filtered());
    const shown = list.filter((p) => ui.archived || !p.archived).length;
    if (!list.length) {
      bodyEl.innerHTML = emptyState('Todavía no hay proyectos', 'Creá el primero para organizar tareas, sprints y tablero.', 'projects', `<button class="btn primary" data-act="new">${icon('plus', 15)} Crear proyecto</button>`);
      return;
    }
    if (!rows.length) {
      bodyEl.innerHTML = emptyState('Ningún proyecto con estos filtros', 'Probá con otros filtros o limpialos.', 'projects', '<button class="btn" data-act="clear">Limpiar filtros</button>');
      return;
    }
    bodyEl.innerHTML = `<p class="muted small row gap" style="margin:0 0 10px">${rows.length} de ${shown} proyecto(s)${active() ? ' · <button type="button" class="link-btn" data-act="clear">Limpiar filtros</button>' : ''}</p>${ui.view === 'table'
      ? `<div class="card flush"><div class="table-wrap"><table class="tbl prj-tbl ${Object.keys(cols.w).length ? 'tk-fixed' : ''}" ${tableWidth()}>${headHtml()}<tbody>${rows.map(row).join('')}</tbody></table></div></div>`
      : `<div class="proj-grid">${rows.map(card).join('')}</div>`}`;
  };
  const syncBar = () => {
    for (const f of el.querySelectorAll('[data-pf]')) {
      const k = f.dataset.pf;
      if (f === document.activeElement && k === 'q') continue;
      if (f.type === 'checkbox') f.checked = Boolean(ui[k]); else f.value = ui[k] ?? '';
    }
    el.querySelector('[data-pf=role]').disabled = !ui.person;
    el.querySelector('[data-act=mine]').classList.toggle('on', ui.person === 'me');
  };
  // onclick/onchange (no addEventListener) para no acumular manejadores si la vista se vuelve a dibujar
  // Panel de columnas (v1.26): mostrar u ocultar, ordenar arrastrando o con las flechas, restablecer
  function colsPanel(anchor) {
    const wrap = anchor.closest('[data-colwrap]');
    let p = wrap.querySelector('.tkc-panel');
    if (p) { p.remove(); anchor.setAttribute('aria-expanded', 'false'); anchor.classList.remove('active'); return; }
    p = document.createElement('div');
    p.className = 'tkc-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Columnas de la lista de proyectos');
    wrap.appendChild(p);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.classList.add('active');
    const paint = () => {
      p.innerHTML = `<div class="tkc-head"><b>Columnas de la lista</b><p>Arrastrá para cambiar el orden. Se guarda para vos.</p></div>
        <ul class="tkc-list">${cols.order.map((k, i) => `<li class="tkc-item" draggable="true" data-k="${k}"><span class="tkc-grip" aria-hidden="true">${icon('grip', 14)}</span>
          <label><input type="checkbox" data-on="${k}" ${cols.on.includes(k) ? 'checked' : ''} ${PCOLDEFS[k].lock ? 'disabled' : ''}> ${esc(PCOLDEFS[k].label)}</label>
          ${PCOLDEFS[k].lock ? '<small class="muted">siempre</small>' : ''}
          <button type="button" class="tkc-mv" data-mv="-1" data-k="${k}" aria-label="Subir ${esc(PCOLDEFS[k].label)}" ${i === 0 ? 'disabled' : ''}>▲</button><button type="button" class="tkc-mv" data-mv="1" data-k="${k}" aria-label="Bajar ${esc(PCOLDEFS[k].label)}" ${i === cols.order.length - 1 ? 'disabled' : ''}>▼</button></li>`).join('')}</ul>
        <div class="tkc-foot"><button type="button" class="link-btn" data-reset>Restablecer columnas y anchos</button><span class="grow"></span><span class="muted">${cols.on.length} de ${cols.order.length} visibles</span></div>`;
    };
    const changed = () => { draw(); saveCols(); paint(); };
    paint();
    p.addEventListener('change', (e) => { const k = e.target.dataset.on; if (!k) return; cols.on = e.target.checked ? [...cols.on, k] : cols.on.filter((x) => x !== k); changed(); });
    p.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mv = e.target.closest('[data-mv]');
      if (mv) {
        const i = cols.order.indexOf(mv.dataset.k); const j = i + Number(mv.dataset.mv);
        if (j < 0 || j >= cols.order.length) return;
        [cols.order[i], cols.order[j]] = [cols.order[j], cols.order[i]];
        changed();
        p.querySelector(`[data-mv="${mv.dataset.mv}"][data-k="${mv.dataset.k}"]`)?.focus();
        return;
      }
      if (e.target.closest('[data-reset]')) {
        try { await api('/me/view-prefs/projects', { method: 'DELETE' }); } catch { /* sin conexión: igual se restablece en pantalla */ }
        if (m.viewPrefs) delete m.viewPrefs.projects;
        cols = normCols(null);
        draw();
        paint();
        toast('Columnas y anchos de fábrica');
      }
    });
    let dragK = null;
    p.addEventListener('dragstart', (e) => { dragK = e.target.closest('.tkc-item')?.dataset.k; e.target.closest('.tkc-item')?.classList.add('dragging'); });
    p.addEventListener('dragover', (e) => { e.preventDefault(); p.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); e.target.closest('.tkc-item')?.classList.add('over'); });
    p.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = e.target.closest('.tkc-item')?.dataset.k;
      if (!dragK || !to || to === dragK) return;
      cols.order = cols.order.filter((x) => x !== dragK);
      cols.order.splice(cols.order.indexOf(to), 0, dragK);
      changed();
    });
    const outside = (e) => { if (!wrap.contains(e.target)) { p.remove(); anchor.setAttribute('aria-expanded', 'false'); anchor.classList.remove('active'); document.removeEventListener('mousedown', outside); } };
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
  }

  // Ancho de las columnas: arrastrando el borde del título; doble clic lo ajusta al contenido
  let rz = null;
  const tip = document.createElement('div');
  tip.className = 'tk-rz-tip';
  const fixAll = () => {
    if (Object.keys(cols.w).length) return;
    el.querySelectorAll('.prj-tbl thead th[data-col]').forEach((th) => { cols.w[th.dataset.col] = Math.max(60, Math.ceil(th.getBoundingClientRect().width) + 4); });
  };
  const applyWidths = () => {
    const tbl = el.querySelector('.prj-tbl');
    if (!tbl) return;
    tbl.classList.toggle('tk-fixed', Object.keys(cols.w).length > 0);
    tbl.querySelectorAll('col[data-k]').forEach((c) => { c.style.width = `${cols.w[c.dataset.k] || PCOLDEFS[c.dataset.k].w}px`; });
    tbl.style.width = `${visible().reduce((t, k) => t + (cols.w[k] || PCOLDEFS[k].w), 0)}px`;
  };
  el.onmousedown = (e) => {
    const h = e.target.closest('[data-rz]');
    if (!h) return;
    e.preventDefault();
    fixAll();
    rz = { k: h.dataset.rz, x: e.clientX, w: cols.w[h.dataset.rz] || PCOLDEFS[h.dataset.rz].w, h };
    h.classList.add('active');
    document.body.classList.add('tk-resizing');
    document.body.appendChild(tip);
    applyWidths();
  };
  const onMove = (e) => {
    if (!el.isConnected) { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); return; }
    if (!rz) return;
    const w = Math.max(60, Math.min(1000, Math.round(rz.w + e.clientX - rz.x)));
    cols.w[rz.k] = w;
    applyWidths();
    tip.textContent = `${PCOLDEFS[rz.k].label}: ${w} px`;
    tip.style.left = `${e.clientX + 12}px`;
    tip.style.top = `${e.clientY + 14}px`;
  };
  const onUp = () => {
    if (!rz) return;
    rz.h.classList.remove('active');
    document.body.classList.remove('tk-resizing');
    tip.remove();
    rz = null;
    saveCols();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  el.ondblclick = (e) => {
    const h = e.target.closest('[data-rz]');
    if (!h) return;
    const k = h.dataset.rz;
    fixAll();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0';
    document.body.appendChild(probe);
    let max = 0;
    const ix = visible().indexOf(k);
    el.querySelectorAll('.prj-tbl tr').forEach((tr) => { const c = tr.children[ix]; if (!c) return; probe.innerHTML = c.innerHTML; max = Math.max(max, probe.scrollWidth); });
    probe.remove();
    cols.w[k] = Math.max(60, Math.min(k === 'name' ? 600 : 420, max + 30));
    applyWidths();
    saveCols();
  };

  el.onclick = (e) => {
    const t = e.target;
    if (t.closest('[data-act=new]')) { openNewProject(); return; }
    if (t.closest('[data-act=clear]')) { Object.assign(ui, { ...DEFAULTS, sort: ui.sort, view: ui.view }); syncBar(); draw(); return; }
    if (t.closest('[data-act=mine]')) { ui.person = ui.person === 'me' ? '' : 'me'; if (!ui.person) ui.role = 'any'; syncBar(); draw(); return; }
    const v = t.closest('[data-view]');
    if (v) { e.preventDefault(); ui.view = v.dataset.view; el.querySelectorAll('[data-view]').forEach((a) => a.classList.toggle('on', a === v)); el.querySelector('[data-colwrap]').hidden = ui.view !== 'table'; draw(); return; }
    if (t.closest('[data-act=pcols]')) { colsPanel(t.closest('[data-act=pcols]')); return; }
    if (t.closest('[data-rz], .tkc-panel')) return;
    const tr = t.closest('tr[data-href]');
    if (tr) navigate(tr.dataset.href);
  };
  el.onchange = (e) => {
    const k = e.target.dataset.pf;
    if (!k || k === 'q') return;
    ui[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'person' && !ui.person) ui.role = 'any';
    syncBar();
    draw();
  };
  el.querySelector('[data-pf=q]').addEventListener('input', debounce((e) => { ui.q = e.target.value.trim(); draw(); }, 200));
  draw();
}

export async function openNewProject() {
  const r = await openProjectForm();
  if (!r) return;
  await refreshMeta();
  toast(`Proyecto ${r.project.key} creado con ${r.phases} etapas`);
  navigate(`#/projects/${r.project.key}/roadmap`);
}
