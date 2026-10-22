import { api, esc, icon, relTime, fmtShortDate, priorityBadge, emptyState } from '../core.js';
import { setCrumbs } from '../app.js';
import { typeIcon, prioIcon, statusPill, openIssueModal } from './issue.js';

export async function render(el) {
  setCrumbs([{ label: 'Mi trabajo' }]);
  const draw = async () => {
    const w = await api('/my-work');
    const today = new Date().toISOString().slice(0, 10);
    const groups = [
      ['Vencidas', w.issues.filter((i) => i.due_date && String(i.due_date).slice(0, 10) < today)],
      ['En curso', w.issues.filter((i) => i.status_kind === 'doing' && !(i.due_date && String(i.due_date).slice(0, 10) < today))],
      ['Por hacer', w.issues.filter((i) => i.status_kind !== 'doing' && !(i.due_date && String(i.due_date).slice(0, 10) < today))],
    ];
    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Mi trabajo</h1><p class="muted">Tickets y tareas de proyecto asignados a vos.</p></div></div>
      <div class="dash-grid two">
        <section class="card">
          <h3>${icon('ticket', 16)} Tickets abiertos <span class="muted">${w.tickets.length}</span></h3>
          ${w.tickets.length ? `<ul class="work-list">${w.tickets.map((t) => `<li><a href="#/tickets/${t.number}"><b>#${t.number}</b> ${esc(t.subject)}</a>
            <span class="row gap">${priorityBadge(t.priority)}<span class="muted small">${esc(t.status_name)}</span>
            <span class="small ${t.resolution_due && new Date(t.resolution_due) < new Date() ? 'danger-text' : 'muted'}">${t.resolution_due ? `vence ${relTime(t.resolution_due)}` : relTime(t.created_at)}</span></span></li>`).join('')}</ul>` : emptyState('Sin tickets pendientes', '', 'ticket')}
        </section>
        <section class="card">
          <h3>${icon('checkbox', 16)} Tareas de proyecto <span class="muted">${w.issues.length}</span></h3>
          ${w.issues.length ? groups.filter(([, l]) => l.length).map(([title, list]) => `<h4 class="grp-title">${title} <small>${list.length}</small></h4>
            <ul class="work-list">${list.map((i) => `<li data-key="${esc(i.key)}" class="clickable">
              <span class="row gap">${typeIcon(i.type, 15)}<b style="color:${esc(i.project_color)}">${esc(i.key)}</b><span class="ellip">${esc(i.title)}</span></span>
              <span class="row gap">${prioIcon(i.priority, 14)}${statusPill(i.status_name, i.status_kind)}${i.due_date ? `<span class="small muted">${fmtShortDate(String(i.due_date).slice(0, 10))}</span>` : ''}<span class="small muted">${esc(i.project_name)}</span></span></li>`).join('')}</ul>`).join('') : emptyState('Sin tareas asignadas', '', 'checkbox')}
        </section>
      </div></div>`;
  };
  await draw();
  el.addEventListener('click', (e) => {
    const li = e.target.closest('[data-key]');
    if (li) openIssueModal(li.dataset.key, { onChange: draw });
  });
}
