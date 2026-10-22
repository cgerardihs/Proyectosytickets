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
  const pct = (p) => (p.total_issues ? Math.round((p.done_issues / p.total_issues) * 100) : 0);
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
          ${p.archived ? '<span class="badge">Archivado</span>' : ''}</div>
        <h3>${esc(p.name)}</h3>
        <p class="muted small clamp2">${esc(p.description || 'Sin descripción')}</p>
        <div class="progress"><span style="width:${pct(p)}%;background:${esc(p.color)}"></span></div>
        <div class="proj-foot">
          <span>${p.open_issues} abiertas · ${pct(p)}% hecho${end(p) ? ` · fin ${fmtDate(end(p))}` : ''}</span>
          ${p.active_sprint ? `<span class="chip sm">${icon('play', 10)} ${esc(p.active_sprint)}</span>` : ''}
        </div>
        <div class="proj-foot"><span class="muted small">Líder: ${p.lead_id ? esc(userName(p.lead_id)) : '<span class="warn-text">sin responsable</span>'}</span><span class="avatars">${[...new Set([...(p.member_ids || []), ...(p.assignee_ids || [])])].slice(0, 5).map((x) => avatar(x, 22)).join('')}</span></div>
      </a>`;
  const row = (p) => `<tr class="clickable" data-href="#/projects/${esc(p.key)}/${typeOf(p.type_id)?.uses_sprints === false ? 'roadmap' : 'board'}">
      <td><span class="row gap"><span class="proj-key sm" style="background:${esc(p.color)}">${esc(p.key)}</span><b class="ellip" title="${esc(p.name)}">${esc(p.name)}</b>${p.archived ? ' <span class="badge">Archivado</span>' : ''}</span></td>
      <td class="small">${esc(typeOf(p.type_id)?.name || '—')}</td>
      <td>${p.portfolio_status ? `<span class="badge" style="--c:${PSTATUS_COLOR[p.portfolio_status]}">${PSTATUS[p.portfolio_status]}</span>` : '—'}</td>
      <td class="small nowrap">${p.lead_id ? `${avatar(p.lead_id, 20)} ${esc(userName(p.lead_id))}` : '<span class="warn-text">Sin responsable</span>'}</td>
      <td class="small">${PRIORITY[p.priority] || '—'}</td>
      <td class="num">${p.open_issues}</td>
      <td><div class="pf-prog"><span class="progress"><span style="width:${pct(p)}%;background:${esc(p.color)}"></span></span><b>${pct(p)}%</b></div></td>
      <td class="small nowrap ${end(p) && end(p) < today && !closed(p) ? 'danger-text' : ''}">${end(p) ? fmtDate(end(p)) : '—'}</td>
    </tr>`;
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
      ? `<div class="card flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>Proyecto</th><th>Tipo</th><th>Estado</th><th>Líder</th><th>Prioridad</th><th class="num">Abiertas</th><th>Avance</th><th>Fin</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div></div>`
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
  el.onclick = (e) => {
    const t = e.target;
    if (t.closest('[data-act=new]')) { openNewProject(); return; }
    if (t.closest('[data-act=clear]')) { Object.assign(ui, { ...DEFAULTS, sort: ui.sort, view: ui.view }); syncBar(); draw(); return; }
    if (t.closest('[data-act=mine]')) { ui.person = ui.person === 'me' ? '' : 'me'; if (!ui.person) ui.role = 'any'; syncBar(); draw(); return; }
    const v = t.closest('[data-view]');
    if (v) { e.preventDefault(); ui.view = v.dataset.view; el.querySelectorAll('[data-view]').forEach((a) => a.classList.toggle('on', a === v)); draw(); return; }
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
