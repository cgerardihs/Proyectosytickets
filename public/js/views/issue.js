import {
  state, api, esc, icon, avatar, toast, toastError, modal, relTime, fmtDateTime, fmtDate, navigate, options, sanitize, richEditor,
  userName, fmtMinutes, fmtSize, confirmDialog, readFiles, todayISO, newKey, guardDates, dmy,
} from '../core.js';
import { setCrumbs } from '../app.js';

export const ISSUE_TYPES = {
  epic: { label: 'Épica', icon: 'zap', color: '#7C3AED' },
  story: { label: 'Historia', icon: 'bookmark', color: '#16A34A' },
  task: { label: 'Tarea', icon: 'checkbox', color: '#2563EB' },
  bug: { label: 'Bug', icon: 'bug', color: '#DC2626' },
  subtask: { label: 'Subtarea', icon: 'subtask', color: '#0891B2' },
};
export const ISSUE_PRIO = {
  1: { label: 'Baja', icon: 'arrowDown', color: '#16A34A' },
  2: { label: 'Media', icon: 'equal', color: '#D97706' },
  3: { label: 'Alta', icon: 'arrowUp', color: '#EA580C' },
  4: { label: 'Crítica', icon: 'arrowUp', color: '#DC2626' },
};
export const typeIcon = (t, size = 15) => {
  const x = ISSUE_TYPES[t] || ISSUE_TYPES.task;
  return `<span class="type-ic" style="background:${x.color}" title="${x.label}">${icon(x.icon, size - 4)}</span>`;
};
export const prioIcon = (p, size = 15) => {
  const x = ISSUE_PRIO[p] || ISSUE_PRIO[2];
  return `<span class="prio-ic" style="color:${x.color}" title="Prioridad ${x.label}">${icon(x.icon, size)}</span>`;
};
export const statusPill = (name, kind) => `<span class="st-pill st-${esc(kind || 'todo')}">${esc(name || '—')}</span>`;

const LINK_KIND = { blocks: ['bloquea a', 'está bloqueada por'], relates: ['se relaciona con', 'se relaciona con'], duplicates: ['duplica a', 'está duplicada por'] };
const FIELD_LABEL = {
  status_id: 'Estado', priority: 'Prioridad', assignee_id: 'Responsable', parent_id: 'Padre', sprint_id: 'Sprint', title: 'Título', type: 'Tipo',
  story_points: 'Puntos', labels: 'Etiquetas', start_date: 'Inicio', due_date: 'Vencimiento', estimate_minutes: 'Estimación',
};

/** Página completa #/issue/KEY */
export async function render(el, [key]) {
  el.className = 'view';
  const page = document.createElement('div');
  page.className = 'page issue-page';
  el.innerHTML = '';
  el.appendChild(page);
  await renderIssueDetail(page, key, {
    onLoaded: (d) => setCrumbs([{ label: 'Proyectos', href: '#/projects' }, { label: d.project.name, href: `#/projects/${d.project.key}/board` }, { label: d.issue.key }]),
  });
}

/** Abre una issue en modal (desde tablero, backlog, listas). */
export function openIssueModal(key, { onChange } = {}) {
  const md = modal({ title: null, wide: true, size: 'xl', body: '<div class="loading"><span class="spinner"></span></div>', onClose: () => onChange?.() });
  const host = md.el.querySelector('.modal-body');
  host.classList.add('issue-modal');
  renderIssueDetail(host, key, { inModal: true, close: md.close }).catch((e) => { host.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; });
  return md;
}

export async function renderIssueDetail(host, key, { inModal = false, close, onLoaded } = {}) {
  let d;
  let tab = 'comments';
  let editingDesc = false;
  let descEditor = null;

  async function load() {
    d = await api(`/issues/${encodeURIComponent(key)}`);
    key = d.issue.key;
    onLoaded?.(d);
    draw();
  }

  async function patch(body) {
    try {
      d = await api(`/issues/${encodeURIComponent(key)}`, { method: 'PATCH', body });
      draw();
    } catch (e) { toastError(e); draw(); }
  }

  let dateCheck = null;
  function draw() {
    const i = d.issue;
    const pj = d.project;
    const canChildren = i.type !== 'subtask';
    const childType = i.type === 'epic' ? 'story' : 'subtask';
    const done = d.children.filter((c) => c.status_kind === 'done').length;
    host.innerHTML = `
    <div class="issue-top">
      <div class="crumbline">
        <a href="#/projects/${esc(pj.key)}/board"><span class="proj-key sm" style="background:${esc(pj.color)}">${esc(pj.key)}</span> ${esc(pj.name)}</a>
        ${d.parent ? `<span class="sep">/</span><a href="#/issue/${esc(d.parent.key)}" data-open="${esc(d.parent.key)}">${typeIcon(d.parent.type, 14)} ${esc(d.parent.key)}</a>` : ''}
        <span class="sep">/</span><span>${typeIcon(i.type, 14)} <b>${esc(i.key)}</b></span>
      </div>
      <div class="row gap">
        ${inModal ? `<a class="icon-btn" href="#/issue/${esc(i.key)}" title="Abrir en página" data-nav>${icon('external', 16)}</a>` : ''}
        <button class="icon-btn" data-act="copy" title="Copiar enlace">${icon('link', 16)}</button>
        <button class="icon-btn" data-act="delete" title="Eliminar">${icon('trash', 16)}</button>
        ${inModal ? `<button class="icon-btn" data-act="close" title="Cerrar">${icon('x', 18)}</button>` : ''}
      </div>
    </div>
    <div class="issue-grid">
      <div class="issue-main">
        <textarea class="issue-title" rows="1" aria-label="Título">${esc(i.title)}</textarea>
        <div class="issue-section">
          <div class="sec-head"><h4>Descripción</h4>${editingDesc ? '' : `<button class="link-btn" data-act="edit-desc">${icon('edit', 13)} Editar</button>`}</div>
          ${editingDesc ? `<div class="desc-editor"></div><div class="row gap end"><button class="btn sm" data-act="cancel-desc">Cancelar</button><button class="btn sm primary" data-act="save-desc">Guardar</button></div>`
    : `<div class="desc ${i.description_html ? '' : 'empty-desc'}" data-act="edit-desc">${i.description_html ? sanitize(i.description_html, { blockRemote: true }) : 'Agregá una descripción…'}</div>`}
        </div>
        ${canChildren ? `<div class="issue-section">
          <div class="sec-head"><h4>${i.type === 'epic' ? 'Tareas de la épica' : 'Subtareas'} ${d.children.length ? `<small class="muted">${done}/${d.children.length}</small>` : ''}</h4></div>
          ${d.children.length ? `<div class="progress thin"><span style="width:${(done / d.children.length) * 100}%"></span></div>` : ''}
          <ul class="child-list">${d.children.map((c) => `<li data-open="${esc(c.key)}">${typeIcon(c.type, 14)}<b>${esc(c.key)}</b><span class="grow ellip ${c.status_kind === 'done' ? 'done-text' : ''}">${esc(c.title)}</span>${prioIcon(c.priority, 14)}${avatar(c.assignee_id, 20)}${statusPill(c.status_name, c.status_kind)}</li>`).join('')}</ul>
          <form class="quick-add row gap" data-form="child">
            ${i.type === 'epic' ? `<select class="input sm" name="type"><option value="story">Historia</option><option value="task">Tarea</option><option value="bug">Bug</option></select>` : `<input type="hidden" name="type" value="${childType}">`}
            <input class="input sm grow" name="title" placeholder="${i.type === 'epic' ? 'Agregar tarea a la épica' : 'Agregar subtarea'}"><button class="btn sm">${icon('plus', 13)}</button>
          </form>
        </div>` : ''}
        <div class="issue-section">
          <div class="sec-head"><h4>Tareas vinculadas</h4><button class="link-btn" data-act="add-link">${icon('plus', 13)} Vincular</button></div>
          ${d.links.length ? `<ul class="child-list">${d.links.map((l) => `<li><small class="muted link-kind">${esc(LINK_KIND[l.kind][l.dir === 'out' ? 0 : 1])}</small><span data-open="${esc(l.key)}" class="grow row gap">${typeIcon(l.type, 14)}<b>${esc(l.key)}</b><span class="ellip">${esc(l.title)}</span></span>${statusPill(l.status_name, l.status_kind)}<button class="icon-btn sm" data-unlink="${l.id}" title="Quitar vínculo">${icon('x', 12)}</button></li>`).join('')}</ul>` : '<p class="muted small">Sin vínculos.</p>'}
        </div>
        ${d.tickets.length ? `<div class="issue-section"><div class="sec-head"><h4>Tickets de la mesa de ayuda</h4></div><ul class="child-list">${d.tickets.map((t) => `<li><a href="#/tickets/${t.number}" class="grow row gap" data-nav>${icon('ticket', 14)}<b>#${t.number}</b><span class="ellip">${esc(t.subject)}</span></a><small class="muted">${esc(t.status_name || '')}</small></li>`).join('')}</ul></div>` : ''}
        <div class="issue-section">
          <div class="sec-head"><h4>Adjuntos</h4><label class="link-btn">${icon('clip', 13)} Adjuntar<input type="file" multiple hidden data-upload></label></div>
          ${d.attachments.length ? `<div class="atts">${d.attachments.map((a) => `<span class="chip"><a href="/api/issue-attachments/${a.id}" target="_blank" rel="noopener">${icon('clip', 12)} ${esc(a.filename)}</a> <small>${fmtSize(a.size)}</small><button data-delatt="${a.id}" aria-label="Eliminar adjunto">${icon('x', 11)}</button></span>`).join('')}</div>` : '<p class="muted small">Sin adjuntos.</p>'}
        </div>
        <div class="tabs">
          <button class="${tab === 'comments' ? 'on' : ''}" data-tab="comments">Comentarios <b>${d.comments.length}</b></button>
          <button class="${tab === 'history' ? 'on' : ''}" data-tab="history">Historial</button>
          <button class="${tab === 'time' ? 'on' : ''}" data-tab="time">Tiempo <b>${fmtMinutes(d.timeTotal)}</b></button>
        </div>
        <div class="tab-body">${tabBody()}</div>
      </div>
      <aside class="issue-side">
        <label class="field"><span>Estado</span><select class="input status-select st-${esc(i.status_kind)}" data-field="status_id">${options(d.statuses, i.status_id)}</select></label>
        <label class="field"><span>Responsable</span><select class="input" data-field="assignee_id"><option value="">— Sin asignar</option>${options(state.meta.users.filter((u) => u.active || u.id === i.assignee_id), i.assignee_id)}</select></label>
        <div class="field"><span>Informante</span><div class="ro">${avatar(i.reporter_id, 20)} ${esc(userName(i.reporter_id) || '—')}</div></div>
        <label class="field"><span>Tipo</span><select class="input" data-field="type">${Object.entries(ISSUE_TYPES).map(([k, v]) => `<option value="${k}" ${k === i.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label class="field"><span>Prioridad</span><select class="input" data-field="priority">${Object.entries(ISSUE_PRIO).map(([k, v]) => `<option value="${k}" ${Number(k) === i.priority ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        ${i.type !== 'epic' ? `<label class="field"><span>${i.type === 'subtask' ? 'Tarea padre' : 'Épica'}</span><select class="input" data-field="parent_id" data-parent-select><option value="${i.parent_id || ''}">${d.parent ? esc(`${d.parent.key} ${d.parent.title}`) : '— Ninguna'}</option></select></label>` : ''}
        ${i.type !== 'epic' ? `<label class="field"><span>Sprint</span><select class="input" data-field="sprint_id" data-sprint-select ${i.type === 'subtask' ? 'disabled title="La subtarea sigue el sprint de su padre"' : ''}><option value="${i.sprint_id || ''}">…</option></select></label>` : ''}
        <div class="grid2 tight">
          <label class="field"><span>Puntos</span><input class="input" type="number" min="0" step="0.5" data-field="story_points" value="${i.story_points ?? ''}"></label>
          <label class="field"><span>Estimación (h)</span><input class="input" type="number" min="0" step="0.5" data-field="estimate_hours" value="${i.estimate_minutes ? i.estimate_minutes / 60 : ''}"></label>
          <label class="field"><span>Inicio</span><input class="input" type="date" data-field="start_date" value="${esc(i.start_date ? String(i.start_date).slice(0, 10) : '')}"></label>
          <label class="field"><span>Vencimiento</span><input class="input" type="date" data-field="due_date" value="${esc(i.due_date ? String(i.due_date).slice(0, 10) : '')}"></label>
        </div>
        <label class="field"><span>Etiquetas</span><input class="input" data-field="labels" value="${esc((i.labels || []).join(', '))}" placeholder="separadas por coma"></label>
        <div class="side-dates">
          <span>Creada ${fmtDateTime(i.created_at)}</span>
          <span>Actualizada ${relTime(i.updated_at)}</span>
          ${i.resolved_at ? `<span>Resuelta ${fmtDateTime(i.resolved_at)}</span>` : ''}
        </div>
      </aside>
    </div>`;
    dateCheck = guardDates(host.querySelector('[data-field=start_date]'), host.querySelector('[data-field=due_date]'), 'El vencimiento no puede ser anterior al inicio');

    const title = host.querySelector('.issue-title');
    const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
    fit();
    title.addEventListener('input', fit);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    title.addEventListener('blur', () => { const v = title.value.trim(); if (v && v !== d.issue.title) patch({ title: v }); });
    if (editingDesc) {
      descEditor = richEditor(host.querySelector('.desc-editor'), { value: i.description_html, attachments: false, minHeight: 140, onSubmit: () => saveDesc() });
      descEditor.focus();
    }
    if (tab === 'comments') {
      const ce = host.querySelector('.comment-editor');
      if (ce) host._commentEditor = richEditor(ce, { placeholder: 'Agregá un comentario… (Ctrl+Enter para enviar)', attachments: false, minHeight: 70, onSubmit: () => addComment() });
    }
    fillLazySelects();
  }

  async function fillLazySelects() {
    const i = d.issue;
    const ps = host.querySelector('[data-parent-select]');
    const ss = host.querySelector('[data-sprint-select]');
    if (!ps && !ss) return;
    try {
      const pj = await api(`/projects/${encodeURIComponent(d.project.key)}`);
      if (ps) {
        let parents;
        if (i.type === 'subtask') parents = await api(`/projects/${encodeURIComponent(d.project.key)}/issues?exclude_type=epic,subtask`);
        else parents = pj.epics;
        ps.innerHTML = `<option value="">— Ninguna</option>${parents.filter((p) => p.id !== i.id).map((p) => `<option value="${p.id}" ${p.id === i.parent_id ? 'selected' : ''}>${esc(`${p.key} ${p.title}`)}</option>`).join('')}`;
      }
      if (ss) {
        const sprints = pj.sprints.filter((s) => s.state !== 'closed' || s.id === i.sprint_id);
        ss.innerHTML = `<option value="">Backlog</option>${sprints.map((s) => `<option value="${s.id}" ${s.id === i.sprint_id ? 'selected' : ''}>${esc(s.name)}${s.state === 'active' ? ' (activo)' : s.state === 'closed' ? ' (cerrado)' : ''}</option>`).join('')}`;
      }
    } catch { /* */ }
  }

  function tabBody() {
    if (tab === 'comments') {
      return `<div class="comment-new">${avatar(state.me, 30)}<div class="grow"><div class="comment-editor"></div><div class="row end"><button class="btn sm primary" data-act="comment">Comentar</button></div></div></div>
        <div class="comments">${d.comments.slice().reverse().map((c) => `<div class="comment">${avatar(c.user_id, 30)}<div class="grow"><header><b>${esc(userName(c.user_id))}</b><time>${relTime(c.created_at)}</time>
          ${c.user_id === state.me.id ? `<button class="link-btn" data-editcomment="${c.id}">Editar</button>` : ''}
          ${c.user_id === state.me.id || ['superadmin', 'admin', 'supervisor'].includes(state.me.role) ? `<button class="link-btn" data-delcomment="${c.id}">Eliminar</button>` : ''}</header>
          <div class="msg-html">${sanitize(c.body_html)}</div></div></div>`).join('') || '<p class="muted small">Sin comentarios todavía.</p>'}</div>`;
    }
    if (tab === 'history') {
      return `<ul class="activity">${d.activities.slice().reverse().map((a) => {
        const who = `<b>${esc(userName(a.user_id) || 'Sistema')}</b>`;
        let txt = { created: 'creó la tarea', linked: 'agregó un vínculo', attachment: 'adjuntó archivos', time: 'registró tiempo', ticket_linked: 'vinculó un ticket' }[a.action] || 'actualizó';
        let extra = '';
        if (a.action === 'updated') {
          extra = Object.entries(a.details || {}).map(([k, v]) => (k === 'description' ? '<li>Descripción</li>' : `<li>${esc(FIELD_LABEL[k] || k)}: <s>${esc(histVal(k, v.from))}</s> → <b>${esc(histVal(k, v.to))}</b></li>`)).join('');
        }
        if (a.action === 'ticket_linked') extra = `<li><a href="#/tickets/${a.details.number}">#${a.details.number}</a></li>`;
        if (a.action === 'time') extra = `<li>${fmtMinutes(a.details.minutes)}</li>`;
        if (a.action === 'linked') txt = `vinculó ${esc(a.details.key)}`;
        return `<li><span class="act-dot"></span><div>${who} ${txt}<time>${fmtDateTime(a.created_at)}</time>${extra ? `<ul>${extra}</ul>` : ''}</div></li>`;
      }).join('')}</ul>`;
    }
    return `<form class="row gap time-form" data-form="time"><input class="input sm" type="number" min="1" name="minutes" placeholder="Minutos"><input class="input sm grow" name="note" placeholder="Detalle"><input class="input sm" type="date" name="spent_on" value="${todayISO()}"><button class="btn sm">Registrar</button></form>
      <ul class="mini-list">${d.time.map((x) => `<li class="row"><span>${esc(userName(x.user_id))} · <b>${fmtMinutes(x.minutes)}</b>${x.note ? ` · ${esc(x.note)}` : ''}</span><small>${fmtDate(x.spent_on)}</small></li>`).join('')}</ul>
      ${d.issue.estimate_minutes ? `<p class="muted small">Estimado ${fmtMinutes(d.issue.estimate_minutes)} · registrado ${fmtMinutes(d.timeTotal)}</p>` : ''}`;
  }

  function histVal(k, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'status_id') return d.statuses.find((s) => s.id === v)?.name || v;
    if (k === 'assignee_id') return userName(v);
    if (k === 'priority') return ISSUE_PRIO[v]?.label;
    if (k === 'type') return ISSUE_TYPES[v]?.label;
    if (k === 'estimate_minutes') return fmtMinutes(v);
    if (Array.isArray(v)) return v.join(', ');
    return String(v).slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/) ? fmtDate(String(v).slice(0, 10)) : String(v);
  }

  async function saveDesc() {
    const html = descEditor.getHTML();
    editingDesc = false;
    await patch({ description_html: html });
  }

  async function addComment() {
    const ed = host._commentEditor;
    if (!ed || ed.isEmpty()) return;
    try {
      await api(`/issues/${encodeURIComponent(key)}/comments`, { method: 'POST', body: { body_html: ed.getHTML() } });
      await load();
    } catch (e) { toastError(e); }
  }

  host.addEventListener('change', async (e) => {
    const f = e.target.closest('[data-field]');
    if (f) {
      const field = f.dataset.field;
      let v = f.value;
      if (field === 'labels') return patch({ labels: v.split(',').map((x) => x.trim()).filter(Boolean) });
      if (field === 'estimate_hours') return patch({ estimate_minutes: v === '' ? null : Math.round(Number(v) * 60) });
      if (['status_id', 'assignee_id', 'priority', 'parent_id', 'sprint_id'].includes(field)) v = v === '' ? null : Number(v);
      if (field === 'start_date' || field === 'due_date') {
        const s0 = host.querySelector('[data-field=start_date]')?.value;
        const e0 = host.querySelector('[data-field=due_date]')?.value;
        if (s0 && e0 && e0 < s0) {
          f.value = f.defaultValue; // vuelve a la fecha que tenía
          dateCheck?.();
          return toast(`El vencimiento (${dmy(e0)}) no puede ser anterior al inicio (${dmy(s0)})`, 'error');
        }
      }
      return patch({ [field]: v });
    }
    if (e.target.matches('[data-upload]')) {
      try {
        const files = await readFiles(e.target.files);
        d = await api(`/issues/${encodeURIComponent(key)}/attachments`, { method: 'POST', body: { attachments: files } });
        draw();
        toast('Adjuntos agregados');
      } catch (er) { toastError(er); }
    }
  });

  host.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      if (form.dataset.form === 'child') {
        const title = form.title.value.trim();
        if (!title) return;
        await api(`/projects/${encodeURIComponent(d.project.key)}/issues`, { method: 'POST', body: { type: form.type.value, title, parent_id: d.issue.id, sprint_id: d.issue.type !== 'epic' ? d.issue.sprint_id : null } });
        await load();
        host.querySelector('[data-form=child] [name=title]')?.focus();
      }
      if (form.dataset.form === 'time') {
        d = await api(`/issues/${encodeURIComponent(key)}/time`, { method: 'POST', body: { minutes: Number(form.minutes.value), note: form.note.value, spent_on: form.spent_on.value } });
        draw();
      }
    } catch (er) { toastError(er); }
  });

  host.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open && !e.target.closest('button')) {
      e.preventDefault();
      key = open.dataset.open;
      editingDesc = false;
      return load();
    }
    if (e.target.closest('[data-nav]') && inModal) { close?.(); return; }
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab; return draw(); }
    const unlink = e.target.closest('[data-unlink]');
    if (unlink) { await api(`/issue-links/${unlink.dataset.unlink}`, { method: 'DELETE' }).catch(toastError); return load(); }
    const delAtt = e.target.closest('[data-delatt]');
    if (delAtt) {
      if (!(await confirmDialog('¿Eliminar el adjunto?', { danger: true, okText: 'Eliminar' }))) return;
      await api(`/issue-attachments/${delAtt.dataset.delatt}`, { method: 'DELETE' }).catch(toastError);
      return load();
    }
    const delC = e.target.closest('[data-delcomment]');
    if (delC) { await api(`/issue-comments/${delC.dataset.delcomment}`, { method: 'DELETE' }).catch(toastError); return load(); }
    const editC = e.target.closest('[data-editcomment]');
    if (editC) {
      const c = d.comments.find((x) => x.id === Number(editC.dataset.editcomment));
      const md = modal({ title: 'Editar comentario', body: '<div class="ed"></div>', footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>' });
      const ed = richEditor(md.el.querySelector('.ed'), { value: c.body_html, attachments: false });
      md.el.querySelector('[data-ok]').addEventListener('click', async () => {
        await api(`/issue-comments/${c.id}`, { method: 'PATCH', body: { body_html: ed.getHTML() } }).catch(toastError);
        md.close();
        load();
      });
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'close') close?.();
    if (act === 'edit-desc' && !editingDesc) { editingDesc = true; draw(); }
    if (act === 'cancel-desc') { editingDesc = false; draw(); }
    if (act === 'save-desc') saveDesc();
    if (act === 'comment') addComment();
    if (act === 'copy') {
      const url = `${location.origin}/#/issue/${d.issue.key}`;
      try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } catch { toast(url); }
    }
    if (act === 'add-link') {
      const md = modal({
        title: 'Vincular tarea',
        body: `<label class="field"><span>Relación</span><select class="input" name="kind"><option value="relates">Se relaciona con</option><option value="blocks">Bloquea a</option><option value="duplicates">Duplica a</option></select></label>
          <label class="field"><span>Tarea (clave o texto)</span><input class="input" name="q" list="issueSearch" autocomplete="off" placeholder="CRM-12"><datalist id="issueSearch"></datalist></label>`,
        footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Vincular</button>',
      });
      const inp = md.el.querySelector('[name=q]');
      inp.addEventListener('input', async () => {
        const r = await api(`/issues/search?q=${encodeURIComponent(inp.value)}`).catch(() => []);
        md.el.querySelector('#issueSearch').innerHTML = r.map((x) => `<option value="${esc(x.key)}">${esc(x.title)}</option>`).join('');
      });
      md.el.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          d = await api(`/issues/${encodeURIComponent(key)}/links`, { method: 'POST', body: { to_key: inp.value.trim().split(' ')[0], kind: md.el.querySelector('[name=kind]').value } });
          md.close();
          draw();
        } catch (er) { toastError(er); }
      });
    }
    if (act === 'delete') {
      const extra = d.children.length && d.issue.type !== 'epic' ? ` y sus ${d.children.length} subtareas` : '';
      if (!(await confirmDialog(`Se eliminará ${d.issue.key}${extra}. No se puede deshacer.`, { danger: true, okText: 'Eliminar' }))) return;
      try {
        await api(`/issues/${encodeURIComponent(key)}`, { method: 'DELETE' });
        toast('Tarea eliminada');
        if (inModal) close?.(); else navigate(`#/projects/${d.project.key}/backlog`);
      } catch (er) { toastError(er); }
    }
  });

  await load();
}

/** Modal de creación de issue. */
export async function openCreateIssue({ projectKey, sprintId = null, parentId = null, type = 'task', statusId = null, onCreated } = {}) {
  const opKey = newKey();
  const projects = state.meta.projects.filter((p) => !p.archived);
  if (!projects.length) return toast('Primero creá un proyecto', 'error');
  const current = projects.find((p) => p.key === projectKey) || projects[0];
  const md = modal({
    title: 'Crear tarea',
    wide: true,
    body: `<form class="issue-form">
      <div class="grid3">
        <label class="field"><span>Proyecto</span><select class="input" name="project">${projects.map((p) => `<option value="${esc(p.key)}" ${p.key === current.key ? 'selected' : ''}>${esc(p.key)} · ${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Tipo</span><select class="input" name="type">${Object.entries(ISSUE_TYPES).map(([k, v]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label class="field"><span>Prioridad</span><select class="input" name="priority">${Object.entries(ISSUE_PRIO).map(([k, v]) => `<option value="${k}" ${k === '2' ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Título *</span><input class="input" name="title"></label>
      <div class="field"><span>Descripción</span><div class="editor"></div></div>
      <div class="grid3">
        <label class="field"><span>Responsable</span><select class="input" name="assignee_id"><option value="">— Sin asignar</option>${options(state.meta.users.filter((u) => u.active), null)}</select></label>
        <label class="field"><span>Padre / épica</span><select class="input" name="parent_id"><option value="">— Ninguno</option></select></label>
        <label class="field"><span>Sprint</span><select class="input" name="sprint_id"><option value="">Backlog</option></select></label>
        <label class="field"><span>Puntos</span><input class="input" type="number" min="0" step="0.5" name="story_points"></label>
        <label class="field"><span>Inicio</span><input class="input" type="date" name="start_date"></label>
        <label class="field"><span>Vencimiento</span><input class="input" type="date" name="due_date"></label>
      </div>
      <label class="field"><span>Etiquetas</span><input class="input" name="labels" placeholder="separadas por coma"></label>
      <label class="check"><input type="checkbox" name="another"> Crear otra a continuación</label>
    </form>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Crear</button>',
  });
  const f = md.el.querySelector('form');
  const editor = richEditor(md.el.querySelector('.editor'), { attachments: false, minHeight: 90 });
  const datesOk = guardDates(f.start_date, f.due_date, 'El vencimiento no puede ser anterior al inicio');
  let proj = null;
  async function loadProject() {
    proj = await api(`/projects/${encodeURIComponent(f.project.value)}`);
    const all = await api(`/projects/${encodeURIComponent(f.project.value)}/issues?exclude_type=subtask`);
    const t = f.type.value;
    const parents = t === 'subtask' ? all.filter((x) => x.type !== 'epic') : t === 'epic' ? [] : all.filter((x) => x.type === 'epic');
    f.parent_id.innerHTML = `<option value="">— Ninguno</option>${parents.map((p) => `<option value="${p.id}" ${p.id === parentId ? 'selected' : ''}>${esc(`${p.key} ${p.title}`)}</option>`).join('')}`;
    f.parent_id.disabled = t === 'epic';
    f.sprint_id.innerHTML = `<option value="">Backlog</option>${proj.sprints.filter((s) => s.state !== 'closed').map((s) => `<option value="${s.id}" ${s.id === sprintId ? 'selected' : ''}>${esc(s.name)}${s.state === 'active' ? ' (activo)' : ''}</option>`).join('')}`;
    f.sprint_id.disabled = t === 'epic' || t === 'subtask';
  }
  f.project.addEventListener('change', loadProject);
  f.type.addEventListener('change', loadProject);
  await loadProject();
  md.el.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const body = {
      type: f.type.value, title: f.title.value.trim(), description_html: editor.getHTML(), priority: Number(f.priority.value),
      assignee_id: Number(f.assignee_id.value) || null, parent_id: Number(f.parent_id.value) || null, sprint_id: Number(f.sprint_id.value) || null,
      story_points: f.story_points.value === '' ? null : Number(f.story_points.value), start_date: f.start_date.value || null, due_date: f.due_date.value || null,
      labels: f.labels.value.split(',').map((x) => x.trim()).filter(Boolean), status_id: statusId,
    };
    if (!body.title) return toast('El título es obligatorio', 'error');
    if (!datesOk()) return toast('El vencimiento no puede ser anterior al inicio', 'error');
    btn.disabled = true;
    try {
      const issue = await api(`/projects/${encodeURIComponent(f.project.value)}/issues`, { method: 'POST', body, idempotencyKey: opKey });
      toast(`${issue.key} creada`);
      onCreated?.(issue);
      if (f.another.checked) {
        f.title.value = '';
        editor.clear();
        f.title.focus();
        btn.disabled = false;
      } else {
        md.close();
        if (!onCreated) navigate(`#/issue/${issue.key}`);
      }
    } catch (er) { toastError(er); btn.disabled = false; }
  });
}
