import { api, esc, icon, relTime, fmtShortDate, priorityBadge, emptyState } from '../core.js';
import { setCrumbs } from '../app.js';
import { typeIcon, prioIcon, issuePill, openIssueModal } from './issue.js';

export async function render(el) {
  setCrumbs([{ label: 'Mi trabajo' }]);
  const draw = async () => {
    const [w, ops] = await Promise.all([api('/my-work'), api('/ops/mine').catch(() => null)]);
    const opsList = ops ? [...ops.late.map((i) => ({ ...i, late: true })), ...ops.due_today] : [];
    const today = new Date().toISOString().slice(0, 10);
    // v1.15: las tareas se agrupan por su estado (las etapas, por el tipo de estado del flujo)
    const late = (i) => i.due_date && String(i.due_date).slice(0, 10) < today;
    const st = (i) => (i.type === 'epic' ? { todo: 'standby', doing: 'in_progress' }[i.status_kind] || 'standby' : i.task_state || 'standby');
    const groups = [
      ['Vencidas', w.issues.filter(late)],
      ['En curso', w.issues.filter((i) => !late(i) && st(i) === 'in_progress')],
      ['En test', w.issues.filter((i) => !late(i) && st(i) === 'test')],
      ['En standby', w.issues.filter((i) => !late(i) && st(i) === 'standby')],
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
              <span class="row gap">${prioIcon(i.priority, 14)}${issuePill(i)}${i.due_date ? `<span class="small muted">${fmtShortDate(String(i.due_date).slice(0, 10))}</span>` : ''}<span class="small muted">${esc(i.project_name)}</span></span></li>`).join('')}</ul>`).join('') : emptyState('Sin tareas asignadas', '', 'checkbox')}
        </section>
      </div>
      ${opsList.length ? `<section class="card op-mine"><h3>${icon('refresh', 16)} Operación <span class="muted">${opsList.length}</span><a class="link-btn" href="#/ops" style="margin-left:auto">Ver la agenda</a></h3>
        <ul class="work-list">${opsList.map((i) => `<li><a href="#/ops">${esc(i.name)}</a><span class="row gap"><span class="small ${i.late ? 'danger-text' : 'muted'}">${i.late ? `vencida el ${i.date.slice(8)}/${i.date.slice(5, 7)}` : `hoy hasta las ${esc(i.due_time)} hs`}</span></span></li>`).join('')}</ul></section>` : ''}
      </div>`;
  };
  await draw();
  el.addEventListener('click', (e) => {
    const li = e.target.closest('[data-key]');
    if (li) openIssueModal(li.dataset.key, { onChange: draw });
  });
}
