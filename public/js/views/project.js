import {
  state, api, esc, icon, avatar, toast, toastError, modal, navigate, options, fmtDate, fmtShortDate, emptyState, userName, debounce,
  confirmDialog, isManager, isAdmin, fmtNum, promptDialog, guardDates,
} from '../core.js';
import { PSTATUS, portfolioFieldsHtml, readPortfolioFields, phaseDateIssues } from './project-form.js';
import { setCrumbs, refreshMeta } from '../app.js';
import { sortable } from '../dnd.js';
import { ISSUE_TYPES, ISSUE_PRIO, typeIcon, prioIcon, statusPill, openIssueModal, openCreateIssue } from './issue.js';
import { lineChart, columns, hbars, stackBar } from '../charts.js';

const TABS = [
  ['board', 'Tablero', 'board'],
  ['backlog', 'Backlog', 'backlog'],
  ['list', 'Lista', 'list'],
  ['roadmap', 'Roadmap', 'calendar'],
  ['reports', 'Informes', 'chart'],
  ['settings', 'Configuración', 'settings'],
];

export async function render(el, [key, tabArg]) {
  let pj = await api(`/projects/${encodeURIComponent(key)}`);
  const p = pj.project;
  // Los tipos sin sprints (instalaciones, capacitaciones…) no muestran el backlog de sprints
  // Configuración: solo quien tiene permiso (líder, supervisor, administrador o el permiso "Configurar proyectos")
  const tabs = TABS.filter(([k]) => (k !== 'backlog' || pj.type?.uses_sprints !== false) && (k !== 'settings' || pj.can_configure));
  const tab = tabs.some((t) => t[0] === tabArg) ? tabArg : pj.type?.uses_sprints === false ? 'roadmap' : 'board';
  setCrumbs([{ label: 'Proyectos', href: '#/projects' }, { label: p.name, href: `#/projects/${p.key}/board` }, { label: TABS.find((t) => t[0] === tab)[1] }]);
  el.className = 'view project-view';
  el.innerHTML = `
    <div class="proj-head">
      <div class="row gap"><span class="proj-key" style="background:${esc(p.color)}">${esc(p.key)}</span><div><h1>${esc(p.name)}
        ${pj.type ? `<span class="badge" style="--c:${esc(pj.type.color)}">${esc(pj.type.name)}</span>` : ''}${p.portfolio_status && p.portfolio_status !== 'active' ? ` <span class="badge">${PSTATUS[p.portfolio_status]}</span>` : ''}</h1>${p.description ? `<p class="muted small clamp2" title="${esc(p.description)}">${esc(p.description)}</p>` : ''}
        ${pj.tickets?.length ? `<p class="small origin">${icon('ticket', 12)} Origen: ${pj.tickets.map((t) => `<a href="#/tickets/${t.number}">#${t.number} ${esc(t.subject)}</a>${t.status_name ? ` <span class="muted">(${esc(t.status_name)})</span>` : ''}`).join(' · ')}</p>` : ''}</div></div>
      <button class="btn primary" data-act="create">${icon('plus', 15)} Crear tarea</button>
    </div>
    <nav class="proj-tabs">${tabs.map(([k, label, ic]) => `<a href="#/projects/${esc(p.key)}/${k}" class="${k === tab ? 'on' : ''}">${icon(ic, 15)} ${label}</a>`).join('')}</nav>
    <div class="proj-body"></div>`;
  let body = el.querySelector('.proj-body');
  // Cada recarga usa un contenedor nuevo para no arrastrar listeners con datos viejos.
  const reload = async () => {
    pj = await api(`/projects/${encodeURIComponent(key)}`);
    const fresh = document.createElement('div');
    fresh.className = 'proj-body';
    body.replaceWith(fresh);
    body = fresh;
    await TAB_RENDER[tab](body, pj, reload);
  };
  el.querySelector('[data-act=create]').addEventListener('click', () => {
    const active = pj.sprints.find((s) => s.state === 'active');
    openCreateIssue({ projectKey: p.key, sprintId: tab === 'board' && active ? active.id : null, onCreated: () => reload() });
  });
  await TAB_RENDER[tab](body, pj, reload);
}

// ---------- Tarjeta y fila ----------
/** Tarjeta de una etapa en el tablero: número, nombre, fechas y avance. */
function phaseCard(e, order = 0) {
  const pct = e.child_count ? Math.round((e.child_done / e.child_count) * 100) : e.status_kind === 'done' ? 100 : Number(e.progress || 0);
  const d = (x) => (x ? fmtShortDate(String(x).slice(0, 10)) : '');
  return `<div class="kcard phase-card" draggable="true" data-id="${e.id}" data-key="${esc(e.key)}">
    <div class="pc-top"><span class="pc-num">Etapa ${order + 1}</span>${e.start_date || e.due_date ? `<span class="pc-dates">${d(e.start_date)} → ${d(e.due_date)}</span>` : ''}</div>
    <div class="kc-title">${esc(e.title)}</div>
    <div class="progress"><span style="width:${pct}%"></span></div>
    <div class="kc-foot">${typeIcon('epic', 15)}<span class="kc-key">${esc(e.key)}</span>
      <span class="kc-sub">${e.child_count ? `${e.child_done}/${e.child_count} tareas · ` : ''}${pct}%</span><span class="grow"></span>${avatar(e.assignee_id, 22)}</div>
  </div>`;
}

function card(i, epicsById) {
  const epic = i.parent_id && epicsById[i.parent_id];
  return `<div class="kcard" draggable="true" data-id="${i.id}" data-key="${esc(i.key)}">
    <div class="kc-title">${esc(i.title)}</div>
    ${epic ? `<span class="epic-chip">${esc(epic.title)}</span>` : ''}
    ${(i.labels || []).length ? `<div class="kc-labels">${i.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</div>` : ''}
    <div class="kc-foot">
      ${typeIcon(i.type, 15)}<span class="kc-key ${i.status_kind === 'done' ? 'done-text' : ''}">${esc(i.key)}</span>
      ${i.child_count ? `<span class="kc-sub" title="Subtareas">${icon('subtask', 12)} ${i.child_done}/${i.child_count}</span>` : ''}
      ${i.comment_count ? `<span class="kc-sub">${icon('message', 12)} ${i.comment_count}</span>` : ''}
      <span class="grow"></span>
      ${i.due_date ? `<span class="kc-due ${i.status_kind !== 'done' && String(i.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10) ? 'late' : ''}">${fmtShortDate(String(i.due_date).slice(0, 10))}</span>` : ''}
      ${prioIcon(i.priority, 14)}
      ${i.story_points !== null && i.story_points !== undefined ? `<span class="pts">${fmtNum(i.story_points, 1)}</span>` : ''}
      ${avatar(i.assignee_id, 22)}
    </div>
  </div>`;
}

function blRow(i, epicsById) {
  const epic = i.parent_id && epicsById[i.parent_id];
  return `<div class="bl-row" draggable="true" data-id="${i.id}" data-key="${esc(i.key)}">
    <span class="grip">${icon('grip', 14)}</span>${typeIcon(i.type, 15)}
    <span class="bl-key ${i.status_kind === 'done' ? 'done-text' : ''}">${esc(i.key)}</span>
    <span class="bl-title ellip">${esc(i.title)}</span>
    ${epic ? `<span class="epic-chip">${esc(epic.title)}</span>` : ''}
    ${statusPill(i.status_name, i.status_kind)}
    ${prioIcon(i.priority, 14)}
    <span class="pts ${i.story_points === null || i.story_points === undefined ? 'empty' : ''}">${i.story_points !== null && i.story_points !== undefined ? fmtNum(i.story_points, 1) : '-'}</span>
    ${avatar(i.assignee_id, 22)}
  </div>`;
}

const epicMap = (pj) => Object.fromEntries(pj.epics.map((e) => [e.id, e]));

function filterBar(pj, f, { epics = true } = {}) {
  return `<div class="pfilters">
    <div class="searchbox">${icon('search', 15)}<input data-f="q" placeholder="Buscar" value="${esc(f.q || '')}"></div>
    <div class="avatar-filter">${pj.members.map((m) => `<button class="${f.assignee === String(m) ? 'on' : ''}" data-f-assignee="${m}" title="${esc(userName(m))}">${avatar(m, 28, false)}</button>`).join('')}
      <button class="${f.assignee === 'none' ? 'on' : ''}" data-f-assignee="none" title="Sin asignar">${avatar(null, 28, false)}</button></div>
    ${epics && pj.epics.length ? `<select class="input sm" data-f="epic"><option value="">Todas las etapas</option>${pj.epics.map((e) => `<option value="${e.id}" ${String(e.id) === f.epic ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select>` : ''}
    <select class="input sm" data-f="type"><option value="">Todos los tipos</option>${Object.entries(ISSUE_TYPES).filter(([k]) => k !== 'epic').map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
    ${pj.labels.length ? `<select class="input sm" data-f="label"><option value="">Etiquetas</option>${pj.labels.map((l) => `<option ${f.label === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
    ${Object.values(f).some(Boolean) ? '<button class="link-btn" data-f-clear>Limpiar filtros</button>' : ''}
  </div>`;
}

function wireFilters(root, f, redraw) {
  root.querySelector('[data-f=q]')?.addEventListener('input', debounce((e) => { f.q = e.target.value; redraw(); }, 300));
  root.querySelectorAll('select[data-f]').forEach((s) => s.addEventListener('change', () => { f[s.dataset.f] = s.value; redraw(); }));
  root.querySelectorAll('[data-f-assignee]').forEach((b) => b.addEventListener('click', () => { f.assignee = f.assignee === b.dataset.fAssignee ? '' : b.dataset.fAssignee; redraw(); }));
  root.querySelector('[data-f-clear]')?.addEventListener('click', () => { for (const k of Object.keys(f)) f[k] = ''; redraw(); });
}

function applyLocalFilters(list, f) {
  const q = (f.q || '').toLowerCase();
  return list.filter((i) => {
    if (q && !`${i.key} ${i.title}`.toLowerCase().includes(q)) return false;
    if (f.assignee === 'none' && i.assignee_id) return false;
    if (f.assignee && f.assignee !== 'none' && String(i.assignee_id) !== f.assignee) return false;
    if (f.type && i.type !== f.type) return false;
    if (f.label && !(i.labels || []).includes(f.label)) return false;
    if (f.epic) {
      const parent = list.find((x) => x.id === i.parent_id) || null;
      if (String(i.parent_id) !== f.epic && !(parent && String(parent.parent_id) === f.epic)) return false;
    }
    return true;
  });
}

// ---------- Tablero ----------
const boardFilters = {};
async function renderBoard(body, pj, reload) {
  const p = pj.project;
  const active = pj.sprints.find((s) => s.state === 'active');
  const f = boardFilters[p.key] || (boardFilters[p.key] = { q: '', assignee: '', epic: '', type: '', label: '' });
  const [issues, phases] = await Promise.all([
    api(`/projects/${encodeURIComponent(p.key)}/issues?sprint=${active ? 'active' : 'open'}&exclude_type=epic`),
    api(`/projects/${encodeURIComponent(p.key)}/issues?type=epic`),
  ]);
  const epics = epicMap(pj);
  // Las etapas del proyecto (Relevamiento, Desarrollo, Testing…) se ven en el tablero por defecto y se mueven como las tareas
  let showPhases = true;
  try { showPhases = localStorage.getItem('board-phases') !== '0'; } catch { /* sin almacenamiento */ }
  const phaseOrder = new Map(pj.epics.map((e, i) => [e.id, i]));
  phases.sort((a, b) => (phaseOrder.get(a.id) ?? 99) - (phaseOrder.get(b.id) ?? 99));
  const phaseVisible = (e) => {
    const q = (f.q || '').toLowerCase();
    if (q && !`${e.key} ${e.title}`.toLowerCase().includes(q)) return false;
    if (f.assignee === 'none' && e.assignee_id) return false;
    if (f.assignee && f.assignee !== 'none' && String(e.assignee_id) !== f.assignee) return false;
    if (f.type && f.type !== 'epic') return false;
    if (f.label && !(e.labels || []).includes(f.label)) return false;
    if (f.epic && String(e.id) !== f.epic) return false;
    return true;
  };
  const uses = pj.type?.uses_sprints !== false;
  const draw = () => {
    const list = applyLocalFilters(issues, f, pj);
    const shownPhases = showPhases ? phases.filter(phaseVisible) : [];
    body.innerHTML = `
      <div class="board-head">
        ${active ? `<div><h2>${esc(active.name)}</h2><p class="muted small">${active.goal ? `${esc(active.goal)} · ` : ''}${fmtDate(active.start_date)} → ${fmtDate(active.end_date)} · ${daysLeft(active.end_date)}</p></div>
          ${pj.can_configure ? `<button class="btn" data-act="complete">${icon('check', 15)} Completar sprint</button>` : ''}`
    : `<div><h2>Tablero Kanban</h2><p class="muted small">${uses ? `No hay un sprint activo: se muestran todas las tareas abiertas. Iniciá un sprint desde el <a href="#/projects/${esc(p.key)}/backlog">backlog</a> para trabajar con Scrum.` : 'Mové las etapas y las tareas entre los estados a medida que avanzan.'}</p></div>`}
        ${phases.length ? `<label class="check sm board-phases"><input type="checkbox" data-show-phases ${showPhases ? 'checked' : ''}> Mostrar etapas (${phases.length})</label>` : ''}
      </div>
      ${filterBar(pj, f)}
      <div class="board" style="--cols:${pj.statuses.length}">
        ${pj.statuses.map((s) => {
    const col = list.filter((i) => i.status_id === s.id).sort((a, b) => a.rank - b.rank);
    const ph = shownPhases.filter((e) => e.status_id === s.id);
    const over = s.wip_limit && col.length > s.wip_limit;
    return `<div class="bcol ${over ? 'over-wip' : ''}">
            <div class="bcol-head st-${s.kind}"><span>${esc(s.name)}</span><b>${col.length + ph.length}${s.wip_limit ? ` / ${s.wip_limit}` : ''}</b></div>
            <div class="bcol-body" data-drop data-status="${s.id}">${ph.map((e) => phaseCard(e, phaseOrder.get(e.id))).join('')}${col.map((i) => card(i, epics)).join('')}<div class="drop-empty"></div></div>
            ${s.kind === 'todo' ? `<button class="bcol-add" data-add-status="${s.id}">${icon('plus', 14)} Crear</button>` : ''}
          </div>`;
  }).join('')}
      </div>`;
    wireFilters(body, f, draw);
    body.querySelector('[data-show-phases]')?.addEventListener('change', (e) => {
      showPhases = e.target.checked;
      try { localStorage.setItem('board-phases', showPhases ? '1' : '0'); } catch { /* sin almacenamiento */ }
      draw();
    });
  };
  draw();
  if (!body.dataset.wired) {
    body.dataset.wired = '1';
    sortable(body, {
      itemSelector: '.kcard',
      onDrop: async ({ id, container, order, changedContainer }) => {
        const statusId = Number(container.dataset.status);
        const phase = phases.find((x) => x.id === id);
        try {
          if (phase) {
            // Una etapa solo cambia de estado: su orden es el del proyecto (Roadmap)
            if (changedContainer) {
              await api('/issues/reorder', { method: 'POST', body: { moved_id: id, status_id: statusId, order: [] } });
              const s = pj.statuses.find((x) => x.id === statusId);
              Object.assign(phase, { status_id: statusId, status_kind: s.kind, status_name: s.name });
            }
            draw();
            return;
          }
          const taskOrder = order.filter((oid) => !phases.some((x) => x.id === oid));
          await api('/issues/reorder', { method: 'POST', body: { moved_id: id, status_id: changedContainer ? statusId : undefined, order: taskOrder } });
          const it = issues.find((x) => x.id === id);
          if (it && changedContainer) {
            const s = pj.statuses.find((x) => x.id === statusId);
            it.status_id = statusId;
            it.status_kind = s.kind;
            it.status_name = s.name;
          }
          taskOrder.forEach((oid, idx) => { const x = issues.find((y) => y.id === oid); if (x) x.rank = idx; });
          draw();
        } catch (e) { toastError(e); draw(); }
      },
    });
    body.addEventListener('click', async (e) => {
      const c = e.target.closest('.kcard');
      if (c) return openIssueModal(c.dataset.key, { onChange: reload });
      const add = e.target.closest('[data-add-status]');
      if (add) return openCreateIssue({ projectKey: pj.project.key, sprintId: pj.sprints.find((s) => s.state === 'active')?.id || null, statusId: Number(add.dataset.addStatus), onCreated: reload });
      if (e.target.closest('[data-act=complete]')) completeSprint(pj, pj.sprints.find((s) => s.state === 'active'), reload);
    });
  }
}

function daysLeft(end) {
  if (!end) return '';
  const n = Math.ceil((new Date(`${String(end).slice(0, 10)}T23:59:59`) - Date.now()) / 86400000);
  return n < 0 ? `<span class="danger-text">venció hace ${-n} días</span>` : n === 0 ? 'último día' : `quedan ${n} días`;
}

function completeSprint(pj, sprint, reload) {
  if (!sprint) return;
  const planned = pj.sprints.filter((s) => s.state === 'planned');
  const md = modal({
    title: `Completar ${sprint.name}`,
    body: `<p>Las tareas que no estén en un estado "Hecho" se van a mover a:</p>
      <label class="field"><select class="input" name="move">${planned.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}<option value="new">Un sprint nuevo</option><option value="backlog">El backlog</option></select></label>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Completar sprint</button>',
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try {
      const r = await api(`/sprints/${sprint.id}/complete`, { method: 'POST', body: { move_to: md.el.querySelector('[name=move]').value } });
      md.close();
      toast(`Sprint completado: ${r.completed} tareas hechas, ${r.moved} movidas`);
      reload();
    } catch (e) { toastError(e); }
  });
}

// ---------- Backlog ----------
const backlogFilters = {};
async function renderBacklog(body, pj, reload) {
  const p = pj.project;
  const f = backlogFilters[p.key] || (backlogFilters[p.key] = { q: '', assignee: '', epic: '', type: '', label: '' });
  const issues = await api(`/projects/${encodeURIComponent(p.key)}/issues?sprint=open&exclude_type=epic,subtask`);
  const epics = epicMap(pj);
  const sprints = pj.sprints.filter((s) => s.state !== 'closed');
  const draw = () => {
    const list = applyLocalFilters(issues, f, pj);
    const section = (s) => {
      const items = list.filter((i) => (s ? i.sprint_id === s.id : !i.sprint_id)).sort((a, b) => a.rank - b.rank);
      const pts = items.reduce((a, i) => a + Number(i.story_points || 0), 0);
      const byKind = (k) => items.filter((i) => i.status_kind === k).reduce((a, i) => a + Number(i.story_points || 0), 0);
      return `<section class="bl-section ${s?.state === 'active' ? 'active' : ''}">
        <header>
          <div class="grow"><b>${s ? esc(s.name) : 'Backlog'}</b>
            ${s ? `<span class="muted small">${s.start_date ? `${fmtDate(s.start_date)} → ${fmtDate(s.end_date)}` : 'sin fechas'}${s.goal ? ` · ${esc(s.goal)}` : ''}</span>` : ''}
            <span class="muted small">(${items.length} tareas)</span></div>
          <span class="pts-sum" title="Por hacer / En curso / Hecho"><i class="todo">${fmtNum(byKind('todo'), 1)}</i><i class="doing">${fmtNum(byKind('doing'), 1)}</i><i class="done">${fmtNum(byKind('done'), 1)}</i></span>
          ${pj.can_configure ? `${s && s.state === 'planned' ? `<button class="btn sm" data-start="${s.id}" ${pj.sprints.some((x) => x.state === 'active') ? 'disabled title="Ya hay un sprint activo"' : ''}>Iniciar sprint</button>` : ''}
          ${s && s.state === 'active' ? `<button class="btn sm" data-complete="${s.id}">Completar sprint</button>` : ''}
          ${s ? `<button class="icon-btn sm" data-editsprint="${s.id}" title="Editar sprint">${icon('edit', 14)}</button>` : `<button class="btn sm" data-act="new-sprint">Crear sprint</button>`}
          ${s && s.state === 'planned' ? `<button class="icon-btn sm" data-delsprint="${s.id}" title="Eliminar sprint">${icon('trash', 14)}</button>` : ''}` : ''}
        </header>
        <div class="bl-list" data-drop data-sprint="${s ? s.id : 'backlog'}">${items.map((i) => blRow(i, epics)).join('')}<div class="drop-empty">${items.length ? '' : s ? 'Arrastrá tareas acá para planificar el sprint' : 'El backlog está vacío'}</div></div>
        <form class="quick-add" data-sprint="${s ? s.id : ''}">
          <select class="input sm" name="type">${['story', 'task', 'bug'].map((k) => `<option value="${k}">${ISSUE_TYPES[k].label}</option>`).join('')}</select>
          <input class="input sm grow" name="title" placeholder="+ Crear tarea ${s ? `en ${esc(s.name)}` : 'en el backlog'} (Enter)">
        </form>
        <footer class="muted small">${fmtNum(pts, 1)} puntos</footer>
      </section>`;
    };
    body.innerHTML = `<div class="backlog">
      <aside class="epic-panel">
        <div class="sec-head"><h4>Épicas</h4><button class="icon-btn sm" data-act="new-epic" title="Crear épica">${icon('plus', 14)}</button></div>
        <button class="epic-item ${!f.epic ? 'on' : ''}" data-epic="">Todas las tareas</button>
        ${pj.epics.map((e) => `<button class="epic-item ${String(e.id) === f.epic ? 'on' : ''}" data-epic="${e.id}"><span class="ellip">${esc(e.title)}</span><small>${esc(e.key)} · ${e.child_done}/${e.child_count}</small><span class="progress thin"><span style="width:${e.child_count ? (e.child_done / e.child_count) * 100 : 0}%"></span></span></button>`).join('')}
      </aside>
      <div class="bl-main">
        ${filterBar(pj, f, { epics: false })}
        ${sprints.map(section).join('')}
        ${section(null)}
      </div>
    </div>`;
    wireFilters(body, f, draw);
  };
  draw();
  if (!body.dataset.wired) {
    body.dataset.wired = '1';
    sortable(body, {
      itemSelector: '.bl-row',
      onDrop: async ({ id, container, order, changedContainer }) => {
        const sprint = container.dataset.sprint;
        try {
          await api('/issues/reorder', { method: 'POST', body: { moved_id: id, sprint_id: changedContainer ? (sprint === 'backlog' ? null : Number(sprint)) : undefined, order } });
          const it = issues.find((x) => x.id === id);
          if (it && changedContainer) it.sprint_id = sprint === 'backlog' ? null : Number(sprint);
          order.forEach((oid, idx) => { const x = issues.find((y) => y.id === oid); if (x) x.rank = idx; });
          draw();
        } catch (e) { toastError(e); draw(); }
      },
    });
    body.addEventListener('click', async (e) => {
      const row = e.target.closest('.bl-row');
      if (row) return openIssueModal(row.dataset.key, { onChange: reload });
      const ep = e.target.closest('[data-epic]');
      if (ep) { f.epic = ep.dataset.epic; return draw(); }
      const start = e.target.closest('[data-start]');
      if (start) return startSprint(pj.sprints.find((s) => s.id === Number(start.dataset.start)), reload);
      const comp = e.target.closest('[data-complete]');
      if (comp) return completeSprint(pj, pj.sprints.find((s) => s.id === Number(comp.dataset.complete)), reload);
      const ed = e.target.closest('[data-editsprint]');
      if (ed) return editSprint(pj.sprints.find((s) => s.id === Number(ed.dataset.editsprint)), reload);
      const del = e.target.closest('[data-delsprint]');
      if (del) {
        if (!(await confirmDialog('Se elimina el sprint y sus tareas vuelven al backlog.', { okText: 'Eliminar', danger: true }))) return;
        await api(`/sprints/${del.dataset.delsprint}`, { method: 'DELETE' }).catch(toastError);
        return reload();
      }
      const a = e.target.closest('[data-act]');
      if (a?.dataset.act === 'new-sprint') {
        await api(`/projects/${encodeURIComponent(pj.project.key)}/sprints`, { method: 'POST', body: {} }).catch(toastError);
        return reload();
      }
      if (a?.dataset.act === 'new-epic') return openCreateIssue({ projectKey: pj.project.key, type: 'epic', onCreated: reload });
    });
    body.addEventListener('submit', async (e) => {
      const form = e.target.closest('.quick-add');
      if (!form) return;
      e.preventDefault();
      const title = form.title.value.trim();
      if (!title) return;
      try {
        const it = await api(`/projects/${encodeURIComponent(pj.project.key)}/issues`, {
          method: 'POST', body: { type: form.type.value, title, sprint_id: form.dataset.sprint ? Number(form.dataset.sprint) : null, parent_id: f.epic ? Number(f.epic) : null },
        });
        const st = pj.statuses.find((s) => s.id === it.status_id);
        issues.push({ ...it, status_kind: st?.kind, status_name: st?.name, child_count: 0, child_done: 0, comment_count: 0 });
        draw();
        body.querySelector(`.quick-add[data-sprint="${form.dataset.sprint}"] [name=title]`)?.focus();
      } catch (er) { toastError(er); }
    });
  }
}

function sprintForm(s) {
  return `<label class="field"><span>Nombre</span><input class="input" name="name" value="${esc(s?.name || '')}"></label>
    <label class="field"><span>Objetivo del sprint</span><textarea class="input" name="goal" rows="2">${esc(s?.goal || '')}</textarea></label>
    <div class="grid2"><label class="field"><span>Inicio</span><input class="input" type="date" name="start_date" value="${esc(s?.start_date ? String(s.start_date).slice(0, 10) : '')}"></label>
    <label class="field"><span>Fin</span><input class="input" type="date" name="end_date" value="${esc(s?.end_date ? String(s.end_date).slice(0, 10) : '')}"></label></div>`;
}

function startSprint(s, reload) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const md = modal({
    title: `Iniciar ${s.name}`,
    body: sprintForm({ ...s, start_date: s.start_date || today, end_date: s.end_date || end }) + `<p class="hint">${s.issue_count} tareas · ${fmtNum(s.points, 1)} puntos comprometidos</p>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Iniciar</button>',
  });
  const datesOk = guardDates(md.el.querySelector('[name=start_date]'), md.el.querySelector('[name=end_date]'), 'El sprint no puede terminar antes de empezar');
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => md.el.querySelector(`[name=${n}]`).value;
    if (!datesOk()) return toast('El sprint no puede terminar antes de empezar', 'error');
    try {
      await api(`/sprints/${s.id}`, { method: 'PATCH', body: { name: v('name') } });
      await api(`/sprints/${s.id}/start`, { method: 'POST', body: { goal: v('goal'), start_date: v('start_date'), end_date: v('end_date') } });
      md.close();
      toast('Sprint iniciado');
      reload();
    } catch (e) { toastError(e); }
  });
}

function editSprint(s, reload) {
  const md = modal({ title: 'Editar sprint', body: sprintForm(s), footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>' });
  const datesOk = guardDates(md.el.querySelector('[name=start_date]'), md.el.querySelector('[name=end_date]'), 'El sprint no puede terminar antes de empezar');
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => md.el.querySelector(`[name=${n}]`).value;
    if (!datesOk()) return toast('El sprint no puede terminar antes de empezar', 'error');
    try {
      await api(`/sprints/${s.id}`, { method: 'PATCH', body: { name: v('name'), goal: v('goal'), start_date: v('start_date') || null, end_date: v('end_date') || null } });
      md.close();
      reload();
    } catch (e) { toastError(e); }
  });
}

// ---------- Lista ----------
async function renderList(body, pj, reload) {
  const p = pj.project;
  const f = { q: '', assignee: '', epic: '', type: '', label: '', status: '' };
  // Por defecto, agrupada: cada etapa con sus tareas debajo. Tocando un encabezado se ordena como lista plana.
  let sort = { k: 'tree', dir: 1 };
  let showDone = true;
  // Las etapas se muestran junto con las tareas (se puede ocultar; se recuerda en cada navegador)
  let showPhases = true;
  try { showPhases = localStorage.getItem('list-phases') !== '0'; } catch { /* sin almacenamiento */ }
  const issues = await api(`/projects/${encodeURIComponent(p.key)}/issues`);
  const sprintName = (id) => pj.sprints.find((s) => s.id === id)?.name || '';
  const phaseOrder = new Map(pj.epics.map((e, i) => [e.id, i]));
  // Etapa: la épica padre o, para una subtarea, la del padre de su padre
  const byId = new Map(issues.map((x) => [x.id, x]));
  const phaseOf = (i) => {
    if (i.type === 'epic') return i.id;
    for (let cur = i, n = 0; cur?.parent_id && n < 3; n++) {
      if (phaseOrder.has(cur.parent_id)) return cur.parent_id;
      cur = byId.get(cur.parent_id);
    }
    return null;
  };
  const phaseName = (i) => pj.epics.find((e) => e.id === phaseOf(i))?.title || '';
  const draw = () => {
    let list = applyLocalFilters(issues, f, pj).filter((i) => (showDone || i.status_kind !== 'done') && (!f.status || String(i.status_id) === f.status) && (showPhases || i.type !== 'epic'));
    // Filtrar por etapa también deja ver la etapa misma
    if (f.epic && showPhases) {
      const e = issues.find((x) => String(x.id) === f.epic);
      if (e && !list.includes(e)) list.unshift(e);
    }
    const phasesTotal = issues.filter((i) => i.type === 'epic').length;
    if (sort.k === 'tree') {
      // Etapas en el orden del proyecto, cada una seguida de sus tareas (por rango); al final, las tareas sin etapa
      const tasks = list.filter((i) => i.type !== 'epic').sort((x, y) => x.rank - y.rank);
      const out = [];
      const phases = (showPhases ? list.filter((i) => i.type === 'epic') : []).sort((x, y) => (phaseOrder.get(x.id) ?? 99) - (phaseOrder.get(y.id) ?? 99));
      for (const e of phases) out.push(e, ...tasks.filter((t) => phaseOf(t) === e.id));
      const placed = new Set(out);
      // Tareas cuya etapa no se ve (filtrada u oculta): van agrupadas igual por etapa, después
      for (const e of pj.epics) for (const t of tasks) if (!placed.has(t) && phaseOf(t) === e.id) { out.push(t); placed.add(t); }
      out.push(...tasks.filter((t) => !placed.has(t)));
      list = out;
    } else {
      const val = (i) => ({ rank: i.rank, key: i.number, title: i.title.toLowerCase(), status: i.status_name, priority: i.priority, assignee: userName(i.assignee_id), points: Number(i.story_points || 0), due: i.due_date || '9999', sprint: sprintName(i.sprint_id), phase: phaseName(i).toLowerCase() || '~' })[sort.k];
      list = list.slice().sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
    }
    const nPhases = list.filter((i) => i.type === 'epic').length;
    const nTasks = list.length - nPhases;
    const tree = sort.k === 'tree';
    const th = (k, label) => `<th data-sort="${k}" class="sortable">${label}${sort.k === k ? icon(sort.dir > 0 ? 'up' : 'down', 12) : ''}</th>`;
    const row = (i) => {
      const isPhase = i.type === 'epic';
      const nested = tree && !isPhase && showPhases && phaseOf(i);
      return `<tr data-key="${esc(i.key)}" class="${isPhase ? 'phase-row-list' : ''} ${nested ? 'nested' : ''}">
        <td>${typeIcon(i.type, 15)}</td><td class="nowrap"><b>${esc(i.key)}</b></td>
        <td class="ellip-cell">${nested ? '<span class="tree-pad"></span>' : ''}${i.parent_id && i.type === 'subtask' ? `<span class="muted small">${esc(byId.get(i.parent_id)?.key || '')} / </span>` : ''}${isPhase ? `<b>${esc(i.title)}</b>` : esc(i.title)}${isPhase && (i.start_date || i.due_date) ? ` <span class="muted small">· ${i.start_date ? fmtDate(String(i.start_date).slice(0, 10)) : '…'} → ${i.due_date ? fmtDate(String(i.due_date).slice(0, 10)) : '…'}</span>` : ''}</td>
        ${pj.epics.length ? `<td class="small">${isPhase ? `<span class="phase-tag">Etapa ${(phaseOrder.get(i.id) ?? 0) + 1}</span>` : esc(phaseName(i) || '—')}</td>` : ''}
        <td>${statusPill(i.status_name, i.status_kind)}</td><td>${prioIcon(i.priority, 14)} ${ISSUE_PRIO[i.priority].label}</td>
        <td>${avatar(i.assignee_id, 20)} ${esc(userName(i.assignee_id) || '')}</td><td>${esc(sprintName(i.sprint_id))}</td>
        <td>${i.story_points ?? ''}</td><td class="nowrap">${i.due_date ? fmtDate(String(i.due_date).slice(0, 10)) : ''}</td></tr>`;
    };
    body.innerHTML = `${filterBar(pj, f)}
      <div class="row gap list-opts"><select class="input sm" data-status><option value="">Todos los estados</option>${options(pj.statuses, f.status)}</select>
        <label class="check sm"><input type="checkbox" data-done ${showDone ? 'checked' : ''}> Mostrar hechas</label>
        ${phasesTotal ? `<label class="check sm" title="Las etapas del proyecto (ej. Relevamiento, Desarrollo, Testing)"><input type="checkbox" data-phases ${showPhases ? 'checked' : ''}> Mostrar etapas (${phasesTotal})</label>` : ''}
        ${!tree && pj.epics.length ? '<button type="button" class="link-btn" data-tree>Agrupar por etapa</button>' : ''}
        <span class="grow"></span><span class="muted small">${showPhases && nPhases ? `${nPhases} etapa${nPhases === 1 ? '' : 's'} · ` : ''}${nTasks} tarea${nTasks === 1 ? '' : 's'}</span></div>
      <div class="table-wrap"><table class="tbl issues-tbl"><thead><tr>
        <th></th>${th('key', 'Clave')}${th('title', 'Resumen')}${pj.epics.length ? th('phase', 'Etapa') : ''}${th('status', 'Estado')}${th('priority', 'Prioridad')}${th('assignee', 'Responsable')}${th('sprint', 'Sprint')}${th('points', 'Pts')}${th('due', 'Vence')}
      </tr></thead><tbody>${list.map(row).join('') || `<tr><td colspan="10">${emptyState('Sin tareas', phasesTotal && !showPhases ? 'Todavía no se cargaron tareas: solo están las etapas del proyecto. Creá una con "Crear tarea".' : '', 'list')}</td></tr>`}</tbody></table></div>`;
    wireFilters(body, f, draw);
    body.querySelector('[data-status]').addEventListener('change', (e) => { f.status = e.target.value; draw(); });
    body.querySelector('[data-done]').addEventListener('change', (e) => { showDone = e.target.checked; draw(); });
    body.querySelector('[data-phases]')?.addEventListener('change', (e) => {
      showPhases = e.target.checked;
      try { localStorage.setItem('list-phases', showPhases ? '1' : '0'); } catch { /* sin almacenamiento */ }
      draw();
    });
    body.querySelector('[data-tree]')?.addEventListener('click', () => { sort = { k: 'tree', dir: 1 }; draw(); });
    body.querySelectorAll('[data-sort]').forEach((t) => t.addEventListener('click', () => { sort = { k: t.dataset.sort, dir: sort.k === t.dataset.sort ? -sort.dir : 1 }; draw(); }));
    body.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openIssueModal(tr.dataset.key, { onChange: reload })));
  };
  draw();
}

// ---------- Roadmap ----------
async function renderRoadmap(body, pj, reload) {
  const pf = pj.portfolio || { phases: [], progress: 0 };
  const byId = Object.fromEntries((pf.phases || []).map((f) => [f.id, f]));
  const epics = pj.epics.map((e) => ({ ...e, pct: byId[e.id]?.pct ?? 0, state: byId[e.id]?.state || 'pending', progress: byId[e.id]?.progress ?? null }));
  const canEdit = pj.can_configure || isManager() || pj.project.lead_id === state.me.id || state.meta.canPortfolio;
  const dated = epics.filter((e) => e.start_date || e.due_date);
  const today = new Date();
  const toD = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00`);
  const d10 = (x) => (x ? String(x).slice(0, 10) : '');
  let min = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  let max = new Date(today.getFullYear(), today.getMonth() + 4, 0);
  for (const e of dated) {
    const s = toD(e.start_date || e.due_date);
    const en = toD(e.due_date || e.start_date);
    if (s < min) min = new Date(s.getFullYear(), s.getMonth(), 1);
    if (en > max) max = new Date(en.getFullYear(), en.getMonth() + 1, 0);
  }
  const span = max - min;
  const pos = (d) => Math.max(0, Math.min(100, ((d - min) / span) * 100));
  const months = [];
  for (let d = new Date(min); d <= max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(new Date(d));
  const kindStatus = (kind) => pj.statuses.find((x) => x.kind === kind)?.id;
  const STATE_KIND = { pending: 'todo', active: 'doing', done: 'done' };
  const HEALTH = { late: ['Atrasado', '#dc2626'], risk: ['En riesgo', '#d97706'], ok: ['En término', '#059669'], done: ['Finalizado', '#059669'], none: ['Sin fechas', '#9ca3af'] };
  body.innerHTML = `<div class="proj-summary card">
      <div><span>Tipo</span><b>${esc(pj.type?.name || 'Sin tipo')}</b></div>
      <div><span>Estado</span><b>${esc(pf.status_label || '—')}</b></div>
      <div><span>Avance</span><b>${pf.progress ?? 0}%</b><small class="muted">${pf.progress_source === 'manual' ? 'cargado a mano' : 'por etapas'}</small></div>
      <div><span>Fechas</span><b>${pf.recurring && !pf.end ? 'Recurrente' : pf.start || pf.end ? `${pf.start ? fmtDate(pf.start) : '—'} → ${pf.end ? fmtDate(pf.end) : '—'}` : 'Sin definir'}</b></div>
      <div><span>Horas</span><b>${fmtNum(pf.hours || 0, 1)}${pf.estimated_hours !== null && pf.estimated_hours !== undefined ? ` / ${fmtNum(pf.estimated_hours)}` : ''}</b><small class="muted">registradas / estimadas</small></div>
      <div><span>Salud</span><b style="color:${(HEALTH[pf.health] || HEALTH.none)[1]}">${(HEALTH[pf.health] || HEALTH.none)[0]}</b></div>
      ${canEdit ? '<a class="btn sm" href="#" data-goto-settings>Editar datos</a>' : ''}
    </div>
    <div class="roadmap">
    <div class="rm-head"><div class="rm-label">Etapa</div><div class="rm-track">${months.map((m) => `<span style="left:${pos(m)}%">${m.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' })}</span>`).join('')}<i class="today" style="left:${pos(today)}%"></i></div></div>
    ${epics.map((e) => {
    const has = e.start_date || e.due_date;
    const st = has ? toD(e.start_date || e.due_date) : null;
    const en = has ? toD(e.due_date || e.start_date) : null;
    return `<div class="rm-row" data-key="${esc(e.key)}">
        <div class="rm-label">${typeIcon('epic', 14)} <span class="ellip">${esc(e.title)}</span><small class="muted">${e.pct}%</small></div>
        <div class="rm-track">${has ? `<div class="rm-bar ${e.state === 'done' ? 'done' : ''}" style="left:${pos(st)}%;width:${Math.max(1.5, pos(en) - pos(st))}%" title="${esc(fmtDate(e.start_date))} → ${esc(fmtDate(e.due_date))}"><span style="width:${e.pct}%"></span></div>` : '<span class="muted small rm-nodate">Sin fechas</span>'}<i class="today" style="left:${pos(today)}%"></i></div>
      </div>`;
  }).join('') || emptyState('Sin etapas', 'Agregá las etapas del proyecto para planificarlo.', 'calendar')}
    </div>
    <section class="card phases-card">
      <div class="sec-head"><h3>Etapas</h3>${canEdit ? `<button class="btn sm" data-addphase>${icon('plus', 13)} Agregar etapa</button>` : ''}</div>
      <p class="hint">El avance de una etapa sale de sus tareas hechas. Si la etapa no tiene tareas (por ejemplo, el dictado de una capacitación), cargá el estado y el porcentaje acá.</p>
      <div class="table-wrap"><table class="tbl compact"><thead><tr><th></th><th>Etapa</th><th>Inicio</th><th>Fin</th><th>Responsable</th><th>Estado</th><th>Avance</th><th></th></tr></thead><tbody>
      ${epics.map((e, i) => `<tr data-ph="${esc(e.key)}" data-id="${e.id}">
        <td class="nowrap">${canEdit ? `<button class="icon-btn xs" data-phup ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('up', 12)}</button>` : ''}</td>
        <td><input class="input sm" name="title" value="${esc(e.title)}" ${canEdit ? '' : 'disabled'}></td>
        <td><input class="input sm" type="date" name="start_date" value="${d10(e.start_date)}" ${canEdit ? '' : 'disabled'}></td>
        <td><input class="input sm" type="date" name="due_date" value="${d10(e.due_date)}" ${canEdit ? '' : 'disabled'}></td>
        <td><select class="input sm" name="assignee_id" ${canEdit ? '' : 'disabled'}>${options(state.meta.users.filter((u) => u.active || u.id === e.assignee_id), e.assignee_id, { empty: '—' })}</select></td>
        <td><select class="input sm" name="state" ${canEdit ? '' : 'disabled'}>${Object.entries({ pending: 'Pendiente', active: 'En curso', done: 'Hecha' }).map(([k, v]) => `<option value="${k}" ${e.state === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="nowrap">${e.child_count ? `<span title="Tareas hechas">${e.child_done}/${e.child_count} tareas · <b>${e.pct}%</b></span>` : `<input class="input sm inline-num" type="number" min="0" max="100" name="progress" value="${e.progress ?? e.pct}" ${canEdit ? '' : 'disabled'}> %`}</td>
        <td>${canEdit ? '<button class="btn sm" data-phsave>Guardar</button>' : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="phase-msg" aria-live="polite"></div>
    </section>`;
  body.querySelectorAll('.rm-row').forEach((r) => r.addEventListener('click', () => openIssueModal(r.dataset.key, { onChange: reload })));
  // Fechas de las etapas: mismas reglas que al crear el proyecto (se revisan mientras se editan)
  const phRows = [...body.querySelectorAll('.phases-card tr[data-ph]')];
  const d10p = (x) => (x ? String(x).slice(0, 10) : null);
  const checkPhases = () => {
    const list = phRows.map((tr) => ({ name: tr.querySelector('[name=title]').value, start_date: tr.querySelector('[name=start_date]').value || null, due_date: tr.querySelector('[name=due_date]').value || null }));
    const res = phaseDateIssues(list, { start: d10p(pj.project.start_date), end: d10p(pj.project.end_date) });
    phRows.forEach((tr, i) => {
      for (const n of ['start_date', 'due_date']) tr.querySelector(`[name=${n}]`).classList.remove('invalid', 'warn');
      tr.querySelector('[name=due_date]').min = list[i].start_date || '';
      tr.querySelector('[name=start_date]').max = list[i].due_date || '';
    });
    for (const [arr, cls] of [[res.warnings, 'warn'], [res.errors, 'invalid']]) for (const x of arr) phRows[x.i]?.querySelector(`[name=${x.field}]`).classList.add(cls);
    const box = body.querySelector('.phases-card .phase-msg');
    if (box) box.innerHTML = [...res.errors.map((x) => `<div class="date-warn">${icon('alert', 13)} ${esc(x.text)}</div>`), ...res.warnings.map((x) => `<div class="date-warn soft">${icon('alert', 13)} ${esc(x.text)}</div>`)].join('');
    return res;
  };
  body.querySelector('.phases-card')?.addEventListener('input', (e) => { if (e.target.type === 'date' || e.target.name === 'title') checkPhases(); });
  if (phRows.length) checkPhases();
  body.querySelector('[data-goto-settings]')?.addEventListener('click', (e) => { e.preventDefault(); navigate(`#/projects/${pj.project.key}/settings`); });
  body.querySelector('[data-addphase]')?.addEventListener('click', async () => {
    const title = await promptDialog('Nombre de la etapa', { title: 'Nueva etapa' });
    if (!title) return;
    try { await api(`/projects/${encodeURIComponent(pj.project.key)}/issues`, { method: 'POST', body: { type: 'epic', title } }); toast('Etapa agregada'); reload(); } catch (er) { toastError(er); }
  });
  body.querySelector('.phases-card').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-ph]');
    if (!tr) return;
    try {
      if (e.target.closest('[data-phup]')) {
        const ids = epics.map((x) => x.id);
        const i = ids.indexOf(Number(tr.dataset.id));
        if (i <= 0) return;
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        await api('/issues/reorder', { method: 'POST', body: { moved_id: ids[i - 1], order: ids } });
        reload();
        return;
      }
      if (!e.target.closest('[data-phsave]')) return;
      const g = (n) => tr.querySelector(`[name=${n}]`);
      const bad = checkPhases().errors.find((x) => phRows[x.i] === tr);
      if (bad) return toast(`Revisá las fechas: ${bad.text}`, 'error');
      const ep = epics.find((x) => x.key === tr.dataset.ph);
      const stateSel = g('state').value;
      const patch = {
        title: g('title').value.trim(), start_date: g('start_date').value || null, due_date: g('due_date').value || null, assignee_id: Number(g('assignee_id').value) || null,
      };
      if (stateSel !== ep.state || !ep.child_count) {
        const sid = kindStatus(STATE_KIND[stateSel]);
        if (sid) patch.status_id = sid;
      }
      if (g('progress')) {
        let pr = Math.max(0, Math.min(100, Number(g('progress').value) || 0));
        if (stateSel === 'done') pr = 100;
        patch.progress = pr;
      }
      await api(`/issues/${encodeURIComponent(tr.dataset.ph)}`, { method: 'PATCH', body: patch });
      toast('Etapa guardada');
      reload();
    } catch (er) { toastError(er); }
  });
}

// ---------- Informes ----------
async function renderReports(body, pj) {
  const p = pj.project;
  const closed = pj.sprints.filter((s) => s.state !== 'planned');
  const draw = async (sprintId) => {
    const r = await api(`/projects/${encodeURIComponent(p.key)}/reports${sprintId ? `?sprint=${sprintId}` : ''}`);
    const kindColor = { todo: '#94a3b8', doing: '#2563eb', done: '#059669' };
    const b = r.burndown;
    body.innerHTML = `<div class="dash-grid">
      <section class="card span2">
        <div class="sec-head"><h3>Burndown ${b ? `· ${esc(b.sprint.name)}` : ''}</h3>
          ${closed.length ? `<select class="input sm" data-sprint>${closed.map((s) => `<option value="${s.id}" ${b && b.sprint.id === s.id ? 'selected' : ''}>${esc(s.name)}${s.state === 'active' ? ' (activo)' : ''}</option>`).join('')}</select>` : ''}</div>
        ${b ? (b.total > 0 ? lineChart(b.days.map((x) => fmtShortDate(x.day)), [
    { name: 'Ideal', color: '#94a3b8', values: b.days.map((x) => x.ideal), dashed: true, dots: false },
    { name: 'Puntos restantes', color: 'var(--brand)', values: b.days.map((x) => x.remaining) },
  ]) : lineChart(b.days.map((x) => fmtShortDate(x.day)), [
    { name: 'Ideal', color: '#94a3b8', values: b.days.map((x) => Math.round(b.totalCount - (b.totalCount * i0(b, x)) / (b.days.length - 1))), dashed: true, dots: false },
    { name: 'Tareas restantes', color: 'var(--brand)', values: b.days.map((x) => x.remainingCount) },
  ]) + '<p class="hint">El sprint no tiene puntos estimados: se grafica por cantidad de tareas.</p>') : '<p class="muted">Iniciá un sprint para ver el burndown.</p>'}
      </section>
      <section class="card">
        <h3>Distribución por estado</h3>
        ${stackBar(r.byStatus.map((s) => ({ label: s.name, value: s.n, color: kindColor[s.kind] })))}
        <h3 style="margin-top:18px">Por tipo</h3>
        ${hbars(r.byType.map((t) => ({ label: ISSUE_TYPES[t.type]?.label || t.type, value: t.n, color: ISSUE_TYPES[t.type]?.color })))}
      </section>
      <section class="card span2">
        <h3>Velocidad (puntos por sprint)</h3>
        ${r.velocity.length ? columns(r.velocity.map((v) => v.name), [
    { name: 'Comprometidos', color: '#cbd5e1', values: r.velocity.map((v) => Number(v.committed)) },
    { name: 'Completados', color: 'var(--brand)', values: r.velocity.map((v) => Number(v.completed)) },
  ]) : '<p class="muted">Se calcula cuando completes el primer sprint.</p>'}
      </section>
      <section class="card">
        <h3>Trabajo abierto por responsable</h3>
        ${hbars(r.byAssignee.map((a) => ({ label: userName(a.id) || 'Sin asignar', value: a.n, color: '#475569' })))}
      </section>
      <section class="card span3">
        <h3>Creadas y resueltas · últimos 30 días</h3>
        ${lineChart(r.trend.map((x) => fmtShortDate(x.day)), [
    { name: 'Creadas', color: 'var(--accent)', values: r.trend.map((x) => x.created) },
    { name: 'Resueltas', color: '#059669', values: r.trend.map((x) => x.resolved) },
  ], { height: 200, width: 1300 })}
      </section>
    </div>`;
    body.querySelector('[data-sprint]')?.addEventListener('change', (e) => draw(e.target.value));
  };
  await draw();
}
const i0 = (b, x) => b.days.indexOf(x);

// ---------- Configuración del proyecto ----------
async function renderSettings(body, pj, reload) {
  const p = pj.project;
  const canEdit = Boolean(pj.can_configure);
  const canDelete = isAdmin() || p.lead_id === state.me.id;
  const canPf = canEdit || state.meta.canPortfolio;
  let statuses = pj.statuses.map((s) => ({ ...s }));
  const drawStatuses = () => statuses.map((s, i) => `<div class="wf-row" data-i="${i}">
      <div class="wf-move"><button class="icon-btn sm" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('up', 13)}</button><button class="icon-btn sm" data-down="${i}" ${i === statuses.length - 1 ? 'disabled' : ''} aria-label="Bajar">${icon('down', 13)}</button></div>
      <input class="input sm grow" data-name="${i}" value="${esc(s.name)}">
      <select class="input sm" data-kind="${i}"><option value="todo" ${s.kind === 'todo' ? 'selected' : ''}>Por hacer</option><option value="doing" ${s.kind === 'doing' ? 'selected' : ''}>En curso</option><option value="done" ${s.kind === 'done' ? 'selected' : ''}>Hecho</option></select>
      <input class="input sm" type="number" min="0" data-wip="${i}" value="${s.wip_limit || ''}" placeholder="WIP" style="width:70px" title="Límite de trabajo en curso">
      <button class="icon-btn sm" data-rm="${i}" aria-label="Quitar">${icon('trash', 13)}</button>
    </div>`).join('');
  body.innerHTML = `<div class="settings-grid">
    <section class="card">
      <h3>Datos del proyecto</h3>
      <form data-form="project">
        <label class="field"><span>Nombre</span><input class="input" name="name" value="${esc(p.name)}" ${canEdit ? '' : 'disabled'}></label>
        <label class="field"><span>Descripción</span><textarea class="input" name="description" rows="3" ${canEdit ? '' : 'disabled'}>${esc(p.description)}</textarea></label>
        <div class="grid2">
          <label class="field"><span>Líder (responsable)</span><select class="input" name="lead_id" ${canEdit ? '' : 'disabled'}>${options(state.meta.users.filter((u) => u.active || u.id === p.lead_id), p.lead_id, { empty: '—' })}</select></label>
          <label class="field"><span>Color</span><input class="input" type="color" name="color" value="${esc(p.color)}" ${canEdit ? '' : 'disabled'}></label>
        </div>
        <label class="check"><input type="checkbox" name="archived" ${p.archived ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Proyecto archivado</label>
        ${canEdit ? '<button class="btn primary">Guardar</button>' : '<p class="hint">Solo el líder o un supervisor puede modificarlo.</p>'}
      </form>
    </section>
    <section class="card span2">
      <h3>Portfolio</h3>
      <form data-form="portfolio">
        <div class="grid3"><label class="field"><span>Tipo de proyecto</span><select class="input" name="type_id" ${canPf ? '' : 'disabled'}>${options((state.meta.projectTypes || []).filter((t) => t.active || t.id === p.type_id), p.type_id, { empty: '—' })}</select></label></div>
        <fieldset ${canPf ? '' : 'disabled'} class="plain">${portfolioFieldsHtml(p)}
        <div class="grid3">
          <div class="field"><span>Avance</span>
            <label class="check"><input type="radio" name="pmode" value="auto" ${p.progress_override === null || p.progress_override === undefined ? 'checked' : ''}> Automático (${pj.portfolio?.progress_auto ?? 0}%)</label>
            <label class="check"><input type="radio" name="pmode" value="manual" ${p.progress_override !== null && p.progress_override !== undefined ? 'checked' : ''}> Manual <input class="input sm inline-num" type="number" min="0" max="100" name="progress_override" value="${p.progress_override ?? pj.portfolio?.progress ?? 0}"> %</label>
          </div>
          <label class="field"><span>Horas manuales</span><input class="input" type="number" min="0" step="0.5" name="extra_hours" value="${Number(p.extra_hours || 0)}"></label>
          <div class="field"><span>Horas registradas en tareas</span><b>${fmtNum(pj.portfolio?.logged_hours || 0, 1)} h</b></div>
        </div></fieldset>
        ${canPf ? '<button class="btn primary">Guardar portfolio</button>' : ''}
        <p class="hint">Cambiar el tipo no modifica las etapas existentes: agregalas o quitalas desde la pestaña Roadmap.</p>
      </form>
    </section>
    <section class="card">
      <h3>Miembros</h3>
      ${!p.lead_id ? `<div class="callout warn small" style="margin-bottom:8px">${icon('alert', 14)} <span>Este proyecto no tiene <b>responsable</b> (es el que aparece como Líder en la lista y como Responsable en el portfolio). ${canEdit ? 'Si guardás un solo miembro, queda como responsable; si no, <button type="button" class="link-btn" data-act="pick-lead">elegilo en Datos del proyecto</button>.' : ''}</span></div>` : ''}
      <select class="input" name="members" multiple size="8" ${canEdit ? '' : 'disabled'}>${options(state.meta.users.filter((u) => u.active), pj.members)}</select>
      ${canEdit ? '<button class="btn" data-act="save-members" style="margin-top:8px">Guardar miembros</button>' : ''}
    </section>
    <section class="card span2">
      <h3>Flujo de trabajo (columnas del tablero)</h3>
      <p class="hint">El tipo define el comportamiento: "Hecho" cierra la tarea y cuenta para el burndown.</p>
      <div class="wf">${drawStatuses()}</div>
      ${canEdit ? `<div class="row gap"><button class="btn sm" data-act="add-status">${icon('plus', 13)} Agregar estado</button><span class="grow"></span><button class="btn primary" data-act="save-wf">Guardar flujo</button></div>` : ''}
    </section>
    ${canDelete ? `<section class="card span2 danger-zone"><h3>Zona de riesgo</h3><p class="muted small">Eliminar el proyecto borra todas sus tareas, sprints y comentarios.</p><button class="btn danger" data-act="delete">${icon('trash', 14)} Eliminar proyecto</button></section>` : ''}
  </div>`;
  const pfForm = body.querySelector('[data-form=portfolio]');
  if (pfForm) guardDates(pfForm.querySelector('[name=start_date]'), pfForm.querySelector('[name=end_date]'), 'El proyecto no puede terminar antes de empezar');
  const wf = body.querySelector('.wf');
  const sync = () => {
    wf.querySelectorAll('[data-name]').forEach((x) => { statuses[x.dataset.name].name = x.value; });
    wf.querySelectorAll('[data-kind]').forEach((x) => { statuses[x.dataset.kind].kind = x.value; });
    wf.querySelectorAll('[data-wip]').forEach((x) => { statuses[x.dataset.wip].wip_limit = x.value ? Number(x.value) : null; });
  };
  wf.addEventListener('click', (e) => {
    const up = e.target.closest('[data-up]');
    const down = e.target.closest('[data-down]');
    const rm = e.target.closest('[data-rm]');
    sync();
    if (up) { const i = Number(up.dataset.up); [statuses[i - 1], statuses[i]] = [statuses[i], statuses[i - 1]]; }
    if (down) { const i = Number(down.dataset.down); [statuses[i + 1], statuses[i]] = [statuses[i], statuses[i + 1]]; }
    if (rm) statuses.splice(Number(rm.dataset.rm), 1);
    if (up || down || rm) wf.innerHTML = drawStatuses();
  });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form === 'portfolio') {
      const pf = readPortfolioFields(f);
      if (pf.start_date && pf.end_date && pf.end_date < pf.start_date) return toast('La fecha de fin no puede ser anterior al inicio', 'error');
      const manual = f.querySelector('[name=pmode]:checked').value === 'manual';
      try {
        await api(`/projects/${encodeURIComponent(p.key)}`, {
          method: 'PATCH',
          body: { ...pf, type_id: Number(f.type_id.value) || null, extra_hours: Number(f.extra_hours.value) || 0, progress_override: manual ? Math.max(0, Math.min(100, Number(f.progress_override.value) || 0)) : null },
        });
        await refreshMeta();
        toast('Portfolio actualizado');
        reload();
      } catch (er) { toastError(er); }
      return;
    }
    try {
      await api(`/projects/${encodeURIComponent(p.key)}`, { method: 'PATCH', body: { name: f.name.value, description: f.description.value, lead_id: Number(f.lead_id.value) || null, color: f.color.value, archived: f.archived.checked } });
      await refreshMeta();
      toast('Proyecto actualizado');
      reload();
    } catch (er) { toastError(er); }
  });
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    try {
      if (a.dataset.act === 'add-status') { sync(); statuses.push({ name: 'Nuevo estado', kind: 'doing' }); wf.innerHTML = drawStatuses(); }
      if (a.dataset.act === 'save-wf') {
        sync();
        statuses = await api(`/projects/${encodeURIComponent(p.key)}/statuses`, { method: 'PUT', body: { statuses } });
        toast('Flujo guardado');
        reload();
      }
      if (a.dataset.act === 'pick-lead') {
        const sel = body.querySelector('[name=lead_id]');
        sel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        sel?.focus();
        return;
      }
      if (a.dataset.act === 'save-members') {
        const ids = [...body.querySelector('[name=members]').selectedOptions].map((o) => Number(o.value));
        const r = await api(`/projects/${encodeURIComponent(p.key)}/members`, { method: 'PUT', body: { user_ids: ids } });
        toast(r.lead_id ? `Miembros actualizados · ${userName(r.lead_id)} quedó como responsable` : !p.lead_id && ids.length > 1 ? 'Miembros actualizados. Falta elegir el responsable en Datos del proyecto' : 'Miembros actualizados');
        await refreshMeta();
        reload();
      }
      if (a.dataset.act === 'delete') {
        const ok = await confirmDialog(`Vas a eliminar ${p.key} con todas sus tareas. Esta acción no se puede deshacer.`, { danger: true, okText: 'Eliminar proyecto' });
        if (!ok) return;
        await api(`/projects/${encodeURIComponent(p.key)}`, { method: 'DELETE' });
        await refreshMeta();
        navigate('#/projects');
      }
    } catch (er) { toastError(er); }
  });
}

const TAB_RENDER = { board: renderBoard, backlog: renderBacklog, list: renderList, roadmap: renderRoadmap, reports: renderReports, settings: renderSettings };
