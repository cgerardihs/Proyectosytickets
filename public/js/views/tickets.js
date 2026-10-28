import {
  state, api, esc, icon, avatar, toast, toastError, modal, popover, relTime, fmtDateTime, navigate, options, debounce, buildQuery, parseHashQuery,
  priorityBadge, statusById, categoryName, techName, subtechName, fieldLabel, userName, slaState, richEditor, PRIORITY, PRIORITY_COLOR, CHANNEL, CHANNEL_ICON, confirmDialog,
  emptyState, canPurge, downloadUrl, isManager,
  newKey,
} from '../core.js';
import { setCrumbs, refreshMeta } from '../app.js';

const VIEWS = [
  ['all', 'Todos los tickets'],
  ['mine', 'Mis abiertos y pendientes'],
  ['unassigned_mine', 'Sin asignar y mis abiertos'],
  ['following', 'Tickets que sigo'],
  ['unresolved', 'Todos sin resolver'],
  ['overdue', 'SLA vencido'],
  ['archived', 'Resueltos y cerrados'],
  ['spam', 'Spam'],
  ['trash', 'Papelera'],
];
const FILTER_KEYS = ['status', 'priority', 'assignee', 'category', 'type', 'tech', 'subtech', 'channel', 'created_from', 'created_to', 'tag'];
const SORTS = [['created', 'Hora de creación'], ['activity', 'Última actividad'], ['updated', 'Última modificación'], ['priority', 'Prioridad'], ['due', 'Vencimiento SLA'], ['number', 'Número']];
// Columnas de la tabla: [clave de orden, nombre (o campo con nombre configurable), clase]
const COLS = [['channel', 'channel', 'ch'], ['subject', 'Asunto'], ['contact', 'contact'], ['priority', 'priority'], ['status', 'status'], ['tech', 'tech'],
  ['assignee', 'assignee'], ['created', 'Creado'], ['category', 'category']];
const colLabel = (l) => (/^[a-z]+$/.test(l) ? fieldLabel(l) : l);
// Orden por defecto al tocar una columna: las fechas y la prioridad empiezan de mayor a menor; el resto, A → Z
const DESC_FIRST = new Set(['created', 'priority', 'number', 'activity', 'updated'])

let panelOpen = true;
try { panelOpen = localStorage.getItem('views-panel') !== '0'; } catch { /* */ }

// Filtros, búsqueda y orden que se recuerdan por vista (v1.13.5): al recargar, al volver desde el menú o en otra pestaña
const STICKY = [...FILTER_KEYS, 'q', 'sort', 'order'];
const stickyKey = (view) => `tickets-filters:${view}`;
function saveSticky(view, obj) {
  const keep = Object.fromEntries(STICKY.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '').map((k) => [k, String(obj[k])]));
  try {
    if (Object.keys(keep).length) localStorage.setItem(stickyKey(view), JSON.stringify(keep));
    else localStorage.removeItem(stickyKey(view));
  } catch { /* sin almacenamiento: la URL sigue mandando */ }
}
function loadSticky(view) {
  try {
    const v = JSON.parse(localStorage.getItem(stickyKey(view)) || 'null');
    if (!v || typeof v !== 'object') return null;
    const keep = Object.fromEntries(STICKY.filter((k) => typeof v[k] === 'string' && v[k]).map((k) => [k, v[k]]));
    return Object.keys(keep).length ? keep : null;
  } catch { return null; }
}

export async function render(el) {
  const q = parseHashQuery();
  const view = q.view || 'all';
  // Sin filtros en la dirección: se recuperan los últimos de esta vista. Con filtros: esos quedan guardados.
  if (STICKY.some((k) => q[k])) saveSticky(view, q);
  else {
    const saved = loadSticky(view);
    if (saved) { location.replace(`#/tickets${buildQuery({ ...q, ...saved })}`); return; }
  }
  const viewName = view.startsWith('custom:')
    ? state.meta.views.find((v) => `custom:${v.id}` === view)?.name || 'Vista'
    : VIEWS.find((v) => v[0] === view)?.[1] || 'Tickets';
  setCrumbs([{ label: 'Tickets', href: '#/tickets' }, { label: viewName }]);
  el.className = 'view tickets-view';
  el.innerHTML = `
    <aside class="views-panel ${panelOpen ? '' : 'collapsed'}">
      <div class="vp-head"><b>Vistas</b><button class="icon-btn sm" data-act="collapse" title="Ocultar vistas">${icon('left', 16)}</button></div>
      <nav class="vp-list">
        ${VIEWS.map(([k, label]) => `<a href="#/tickets?view=${k}" class="${view === k ? 'active' : ''}"><span>${esc(label)}</span><b data-count="${k}"></b></a>`).join('')}
        <div class="vp-sub"><span>Vistas personalizadas</span><button class="icon-btn sm" data-act="newview" title="Nueva vista">${icon('plus', 14)}</button></div>
        ${state.meta.views.map((v) => `<a href="#/tickets?view=custom:${v.id}" class="${view === `custom:${v.id}` ? 'active' : ''}"><span>${v.shared ? icon('users', 12) + ' ' : ''}${esc(v.name)}</span><b data-count="custom:${v.id}"></b></a>`).join('') || '<p class="muted small" style="padding:4px 12px">Guardá filtros como vista.</p>'}
      </nav>
    </aside>
    <section class="list-area">
      <div class="toolbar">
        <button class="icon-btn" data-act="expand" title="Mostrar vistas" ${panelOpen ? 'hidden' : ''}>${icon('panel', 18)}</button>
        <label class="sortsel">Ordenar por <select class="input sm" data-act="sort">${[...SORTS, ...COLS.filter(([k]) => !SORTS.some((s) => s[0] === k)).map(([k, l]) => [k, colLabel(l)])].map(([k, l]) => `<option value="${k}" ${(q.sort || 'created') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <button class="icon-btn" data-act="order" title="Invertir orden">${icon((q.order || 'desc') === 'desc' ? 'arrowDown' : 'arrowUp', 16)}</button>
        <div class="searchbox">${icon('search', 15)}<input data-act="q" placeholder="Buscar en esta vista" value="${esc(q.q || '')}"></div>
        <button class="btn ${FILTER_KEYS.some((k) => q[k]) ? 'active' : ''}" data-act="filters">${icon('filter', 15)} Filtros${FILTER_KEYS.filter((k) => q[k]).length ? ` <b class="pill">${FILTER_KEYS.filter((k) => q[k]).length}</b>` : ''}</button>
        ${FILTER_KEYS.some((k) => q[k]) || q.q ? '<button class="link-btn" data-act="clear-filters" title="Quitar filtros y búsqueda">Limpiar</button>' : ''}
        <div class="bulk" hidden><span class="bulk-count"></span><button class="btn" data-act="bulk">Acciones ${icon('down', 14)}</button></div>
        <span class="grow"></span>
        <span class="pager"></span>
        ${isManager() ? `<button class="icon-btn" data-act="export" title="Exportar CSV">${icon('download', 17)}</button>` : ''}
        <button class="icon-btn" data-act="reload" title="Actualizar">${icon('refresh', 17)}</button>
        <label class="auto-refresh" title="Actualizar la lista sola">${icon('clock', 13)}<select class="input sm" data-act="every" aria-label="Actualizar la lista sola">
          ${[[0, 'Sin actualizar'], [30, 'Cada 30 s'], [60, 'Cada 1 min'], [120, 'Cada 2 min'], [300, 'Cada 5 min']].map(([v, l]) => `<option value="${v}" ${refreshEvery() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="table-wrap"><table class="tbl tickets-tbl">
        <thead><tr>
          <th class="cb"><input type="checkbox" data-act="all" aria-label="Seleccionar todos"></th>
          ${COLS.map(([k, l, cls]) => { const on = (q.sort || 'created') === k; const dir = q.order || 'desc'; return `<th class="sortable ${cls || ''} ${on ? 'sorted' : ''}" data-sort="${k}" aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}" title="Ordenar por ${esc(colLabel(l).toLowerCase())}"><span class="th-sort">${esc(colLabel(l))}<i class="sort-arrow">${on ? (dir === 'asc' ? '▲' : '▼') : '↕'}</i></span></th>`; }).join('')}
        </tr></thead>
        <tbody><tr><td colspan="10"><div class="loading"><span class="spinner"></span></div></td></tr></tbody>
      </table></div>
    </section>`;

  const selected = new Set();
  let data = { items: [], total: 0, page: 1, limit: 50 };
  const tbody = el.querySelector('tbody');
  const setQ = (patch) => {
    const next = { ...parseHashQuery(), page: '', ...patch };
    saveSticky(next.view || 'all', next); // también cuando se limpian (así no se vuelven a aplicar solos)
    navigate(`#/tickets${buildQuery(next)}`);
  };

  let lastLoad = 0;
  let known = null; // números que ya se vieron (para marcar los nuevos)
  async function load({ silent = false } = {}) {
    try {
      const next = await api(`/tickets${buildQuery({ ...q, limit: 50 })}`);
      lastLoad = Date.now();
      const fresh = known ? next.items.filter((t) => !known.has(t.number)).map((t) => t.number) : [];
      known = new Set([...(known || []), ...next.items.map((t) => t.number)]);
      data = next;
      draw(fresh);
      if (silent && fresh.length) toast(fresh.length === 1 ? `Entró el ticket #${fresh[0]}` : `Entraron ${fresh.length} tickets nuevos`);
      el.querySelector('[data-act=reload]').title = `Actualizar · última vez ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
    } catch (e) {
      if (silent) return; // una falla de red en la actualización automática no borra la lista
      tbody.innerHTML = `<tr><td colspan="10">${emptyState('No se pudieron cargar los tickets', e.message, 'alert')}</td></tr>`;
    }
    api('/tickets/counts').then((c) => {
      state.counts = c;
      for (const [k, n] of Object.entries(c)) {
        const b = el.querySelector(`[data-count="${k}"]`);
        if (b) b.textContent = n.toLocaleString('es-AR');
      }
    }).catch(() => {});
  }

  function rowHtml(t) {
    const sla = slaState(t);
    const st = statusById(t.status_id);
    return `<tr data-num="${t.number}" class="${selected.has(t.number) ? 'sel' : ''}">
      <td class="cb"><input type="checkbox" data-sel="${t.number}" ${selected.has(t.number) ? 'checked' : ''} aria-label="Seleccionar #${t.number}"></td>
      <td class="ch" title="${esc(CHANNEL[t.channel] || t.channel)}">${icon(CHANNEL_ICON[t.channel] || 'ticket', 15)}</td>
      <td class="subj"><a href="#/tickets/${t.number}"><b>#${t.number}:</b> ${esc(t.subject)}</a>
        <div class="sub">${sla ? `<span class="sla ${sla.cls}">${icon('clock', 11)} ${esc(sla.label)}</span>` : ''}${t.project_key ? `<span class="chip sm proj-chip" title="Convertido en proyecto de desarrollo">${icon('projects', 11)} ${esc(t.project_key)}</span>` : ''}${(t.tags || []).map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div></td>
      <td><span class="ellip" title="${esc(t.contact_email || '')}">${esc(t.contact_name || '')}</span></td>
      <td><button class="cell-edit" data-edit="priority">${priorityBadge(t.priority)}${icon('down', 12)}</button></td>
      <td><button class="cell-edit" data-edit="status_id"><span class="badge" style="--c:${esc(st?.color || '#64748b')}">${esc(st?.name || '—')}</span>${icon('down', 12)}</button></td>
      <td><button class="cell-edit" data-edit="tech_category_id"><span class="cell-stack"><span class="ellip">${esc(techName(t.tech_category_id) || '—')}</span>${t.tech_subcategory_id ? `<small class="muted ellip">${esc(subtechName(t.tech_subcategory_id))}</small>` : ''}</span>${icon('down', 12)}</button></td>
      <td><button class="cell-edit" data-edit="assignee_id">${t.assignee_id ? `${avatar(t.assignee_id, 20)}<span class="ellip">${esc(userName(t.assignee_id))}</span>` : '<span class="muted">Sin asignar</span>'}${icon('down', 12)}</button></td>
      <td title="${esc(fmtDateTime(t.created_at))}" class="nowrap">${relTime(t.created_at)}</td>
      <td><button class="cell-edit" data-edit="category_id"><span class="ellip">${esc(categoryName(t.category_id) || '—')}</span>${icon('down', 12)}</button></td>
    </tr>`;
  }

  function draw(fresh = []) {
    const from = data.total ? (data.page - 1) * data.limit + 1 : 0;
    const to = Math.min(data.page * data.limit, data.total);
    el.querySelector('.pager').innerHTML = `${from} – ${to} de ${data.total.toLocaleString('es-AR')}
      <button class="icon-btn sm" data-act="prev" ${data.page <= 1 ? 'disabled' : ''} aria-label="Anterior">${icon('left', 16)}</button>
      <button class="icon-btn sm" data-act="next" ${to >= data.total ? 'disabled' : ''} aria-label="Siguiente">${icon('right', 16)}</button>`;
    tbody.innerHTML = data.items.length
      ? data.items.map((t) => (fresh.includes(t.number) ? rowHtml(t).replace('<tr ', '<tr data-new ') : rowHtml(t))).join('')
      : `<tr><td colspan="10">${emptyState(q.q || FILTER_KEYS.some((k) => q[k]) ? 'Ningún ticket coincide' : 'No hay tickets en esta vista', '', 'inbox')}</td></tr>`;
    syncBulk();
  }

  function syncBulk() {
    const bulk = el.querySelector('.bulk');
    bulk.hidden = selected.size === 0;
    el.querySelector('.bulk-count').textContent = `${selected.size} seleccionado${selected.size === 1 ? '' : 's'}`;
    const all = el.querySelector('[data-act=all]');
    all.checked = data.items.length > 0 && data.items.every((t) => selected.has(t.number));
  }

  async function patchTicket(num, body) {
    try {
      await api(`/tickets/${num}`, { method: 'PATCH', body });
      const i = data.items.findIndex((t) => t.number === num);
      if (i >= 0) {
        Object.assign(data.items[i], body);
        if (body.status_id) data.items[i].status_kind = statusById(body.status_id)?.kind;
        tbody.querySelector(`tr[data-num="${num}"]`).outerHTML = rowHtml(data.items[i]);
      }
      toast(`Ticket #${num} actualizado`);
    } catch (e) { toastError(e); }
  }

  function editMenu(btn, field, current, onPick) {
    let html = '';
    if (field === 'priority') html = Object.entries(PRIORITY).map(([k, v]) => `<button class="menu-item ${Number(k) === current ? 'on' : ''}" data-value="${k}">${priorityBadgeInline(k)} ${v}</button>`).join('');
    if (field === 'status_id') html = state.meta.statuses.filter((s) => s.active).map((s) => `<button class="menu-item ${s.id === current ? 'on' : ''}" data-value="${s.id}"><span class="dotc" style="background:${esc(s.color)}"></span>${esc(s.name)}</button>`).join('');
    if (field === 'assignee_id') html = `<div class="menu-filter"><input placeholder="Buscar agente" class="input sm"></div><button class="menu-item" data-value="">${avatar(null, 18)} Sin asignar</button>` +
      state.meta.users.filter((u) => u.active).map((u) => `<button class="menu-item ${u.id === current ? 'on' : ''}" data-value="${u.id}" data-name="${esc(u.name.toLowerCase())}">${avatar(u, 18, false)} ${esc(u.name)}</button>`).join('');
    // Categoría técnica: elige categoría o directamente una subcategoría (queda la categoría de esa subcategoría)
    if (field === 'tech_category_id') {
      const subs = state.meta.techSubcategories || [];
      html = `<div class="menu-filter"><input placeholder="Buscar" class="input sm"></div><button class="menu-item" data-value="">— Sin ${esc(fieldLabel('tech').toLowerCase())}</button>` + state.meta.techCategories.filter((c) => c.active || c.id === current).map((c) => `<button class="menu-item ${c.id === current ? 'on' : ''}" data-value="${c.id}" data-name="${esc(c.name.toLowerCase())}"><b>${esc(c.name)}</b></button>${subs.filter((x) => x.tech_category_id === c.id && x.active).map((x) => `<button class="menu-item sub" data-value="${c.id}:${x.id}" data-name="${esc(`${c.name} ${x.name}`.toLowerCase())}">› ${esc(x.name)}</button>`).join('')}`).join('');
    }
    if (field === 'category_id') html = `<div class="menu-filter"><input placeholder="Buscar" class="input sm"></div><button class="menu-item" data-value="">— Sin ${esc(fieldLabel('category').toLowerCase())}</button>` + state.meta.categories.filter((c) => c.active || c.id === current).map((c) => `<button class="menu-item ${c.id === current ? 'on' : ''}" data-value="${c.id}" data-name="${esc(c.name.toLowerCase())}">${esc(c.name)}</button>`).join('');
    const p = popover(btn, `<div class="menu-scroll">${html}</div>`, { onClick: (v) => onPick(v === '' ? null : String(v).includes(':') ? String(v) : Number(v)) });
    const f = p.el.querySelector('.menu-filter input');
    if (f) {
      f.focus();
      f.addEventListener('input', () => p.el.querySelectorAll('[data-name]').forEach((b) => { b.hidden = !b.dataset.name.includes(f.value.toLowerCase()); }));
    }
  }

  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      e.preventDefault();
      const num = Number(edit.closest('tr').dataset.num);
      const t = data.items.find((x) => x.number === num);
      const field = edit.dataset.edit;
      return editMenu(edit, field, t[field], (v) => {
        if (field === 'tech_category_id') {
          // "cat:sub" = subcategoría; solo la categoría = sin subcategoría
          const [cat, sub] = typeof v === 'string' ? v.split(':').map(Number) : [v, null];
          return patchTicket(num, { tech_category_id: cat ?? null, tech_subcategory_id: sub || null });
        }
        return patchTicket(num, { [field]: v });
      });
    }
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      const cur = q.sort || 'created';
      const order = cur === k ? ((q.order || 'desc') === 'desc' ? 'asc' : 'desc') : (DESC_FIRST.has(k) ? 'desc' : 'asc');
      return setQ({ sort: k, order });
    }
    const row = e.target.closest('tbody tr[data-num]');
    if (row && !e.target.closest('a,button,input,label')) {
      return navigate(`#/tickets/${row.dataset.num}`);
    }
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'collapse' || act === 'expand') {
      panelOpen = act === 'expand';
      try { localStorage.setItem('views-panel', panelOpen ? '1' : '0'); } catch { /* */ }
      el.querySelector('.views-panel').classList.toggle('collapsed', !panelOpen);
      el.querySelector('[data-act=expand]').hidden = panelOpen;
    }
    if (act === 'order') setQ({ order: (q.order || 'desc') === 'desc' ? 'asc' : 'desc' });
    if (act === 'prev') setQ({ page: data.page - 1 });
    if (act === 'next') setQ({ page: data.page + 1 });
    if (act === 'reload') load({ silent: true });
    if (act === 'filters') openFilters(q, setQ);
    if (act === 'clear-filters') setQ(Object.fromEntries([...FILTER_KEYS, 'q'].map((k) => [k, ''])));
    if (act === 'newview') saveView(q);
    if (act === 'export') downloadUrl(`/api/tickets/export${buildQuery({ ...q, page: '' })}`);
    if (act === 'bulk') bulkMenu(a);
  });

  el.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-sel]');
    if (sel) {
      const n = Number(sel.dataset.sel);
      if (sel.checked) selected.add(n); else selected.delete(n);
      sel.closest('tr').classList.toggle('sel', sel.checked);
      return syncBulk();
    }
    if (e.target.matches('[data-act=all]')) {
      for (const t of data.items) { if (e.target.checked) selected.add(t.number); else selected.delete(t.number); }
      draw();
    }
    if (e.target.matches('[data-act=sort]')) setQ({ sort: e.target.value });
  });

  el.querySelector('[data-act=q]').addEventListener('input', debounce((e) => setQ({ q: e.target.value.trim() }), 450));

  function bulkMenu(btn) {
    const trash = q.view === 'trash';
    const spam = q.view === 'spam';
    popover(btn, `
      <button class="menu-item" data-value="assign">${icon('user', 15)} Asignar a…</button>
      <button class="menu-item" data-value="status">${icon('flag', 15)} Cambiar estado…</button>
      <button class="menu-item" data-value="priority">${icon('arrowUp', 15)} Cambiar prioridad…</button>
      <button class="menu-item" data-value="tech">${icon('layers', 15)} Cambiar ${esc(fieldLabel('tech').toLowerCase())}…</button>
      <button class="menu-item" data-value="category">${icon('building', 15)} Cambiar ${esc(fieldLabel('category').toLowerCase())}…</button>
      <button class="menu-item" data-value="follow">${icon('eye', 15)} Seguir</button>
      ${spam ? `<button class="menu-item" data-value="notspam">${icon('undo', 15)} No es spam</button>` : `<button class="menu-item" data-value="spam">${icon('alert', 15)} Marcar como spam</button>`}
      ${trash ? `<button class="menu-item" data-value="restore">${icon('undo', 15)} Restaurar</button>${canPurge() ? `<button class="menu-item danger" data-value="delete">${icon('trash', 15)} Eliminar definitivamente</button>` : ''}`
    : `<button class="menu-item danger" data-value="trash">${icon('trash', 15)} Enviar a la papelera</button>`}`, {
      onClick: async (v) => {
        const numbers = [...selected];
        const run = async (action, patch) => {
          try {
            const r = await api('/tickets/bulk', { method: 'POST', body: { numbers, action, patch } });
            toast(`${r.done} ticket(s) actualizados`);
            selected.clear();
            load();
          } catch (er) { toastError(er); }
        };
        const fieldMap = { assign: 'assignee_id', status: 'status_id', priority: 'priority', tech: 'tech_category_id', category: 'category_id' };
        if (fieldMap[v]) {
          return editMenu(btn, fieldMap[v], null, (val) => {
            if (v === 'tech') {
              const [cat, sub] = typeof val === 'string' ? val.split(':').map(Number) : [val, null];
              return run('update', { tech_category_id: cat ?? null, tech_subcategory_id: sub || null });
            }
            return run('update', { [fieldMap[v]]: val });
          });
        }
        if (v === 'delete' && !(await confirmDialog(`Se eliminarán definitivamente ${numbers.length} ticket(s). No se puede deshacer.`, { danger: true, okText: 'Eliminar' }))) return;
        run(v);
      },
    });
  }

  // ---------- Actualización automática ----------
  // Cada tanto se vuelve a pedir la lista, salvo que el agente esté haciendo algo (tickets tildados, un menú o una
  // ventana abiertos, o escribiendo en la búsqueda) o la pestaña esté oculta. Al volver a la pestaña, se pone al día.
  const busy = () => document.hidden || selected.size > 0 || document.querySelector('.popover, .modal-backdrop')
    || (document.activeElement?.matches?.('input, textarea, select') && el.contains(document.activeElement) && document.activeElement.dataset.act !== 'every');
  const tick = () => {
    if (!el.isConnected) { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('hd:inbox', onInbox); return; }
    const every = refreshEvery();
    if (busy()) return;
    if ((every && Date.now() - lastLoad >= every * 1000 - 500) || lastLoad === 0) load({ silent: true });
  };
  const onVisible = () => { if (!document.hidden) tick(); };
  // Entró algo por correo (lo avisa la consulta de notificaciones): se actualiza ya, o en la próxima vuelta si el
  // agente está haciendo algo
  const onInbox = () => {
    if (!el.isConnected) { window.removeEventListener('hd:inbox', onInbox); return; }
    if (busy()) lastLoad = 0; else load({ silent: true });
  };
  window.addEventListener('hd:inbox', onInbox);
  const timer = setInterval(tick, 10000);
  document.addEventListener('visibilitychange', onVisible);
  el.querySelector('[data-act=every]').addEventListener('change', (e) => {
    try { localStorage.setItem('tickets-refresh', e.target.value); } catch { /* */ }
    e.target.blur();
    toast(Number(e.target.value) ? `La lista se actualiza sola ${e.target.selectedOptions[0].textContent.toLowerCase()}` : 'Actualización automática apagada');
  });

  load();
}

/** Cada cuántos segundos se actualiza sola la lista (preferencia de cada agente; de fábrica, 1 minuto). */
function refreshEvery() {
  let v = null;
  try { v = localStorage.getItem('tickets-refresh'); } catch { /* */ }
  const n = v === null ? 60 : Number(v);
  return [0, 30, 60, 120, 300].includes(n) ? n : 60;
}

function priorityBadgeInline(p) {
  return `<span class="dotc" style="background:${PRIORITY_COLOR[p]}"></span>`;
}

function openFilters(q, setQ) {
  const m = state.meta;
  const multi = (name, list, label, extra = '') => `<label class="field"><span>${esc(label)}</span><select class="input" name="${name}" multiple size="5">${extra}${options(list, (q[name] || '').split(','))}</select></label>`;
  const md = modal({
    title: 'Filtrar tickets',
    wide: true,
    body: `<div class="grid3">
      ${multi('status', m.statuses, fieldLabel('status'))}
      ${multi('priority', Object.entries(PRIORITY).map(([id, name]) => ({ id, name })), fieldLabel('priority'))}
      ${multi('assignee', m.users.filter((u) => u.active), fieldLabel('assignee'), `<option value="me" ${(q.assignee || '').split(',').includes('me') ? 'selected' : ''}>Yo</option><option value="none" ${(q.assignee || '').split(',').includes('none') ? 'selected' : ''}>Sin asignar</option>`)}
      ${multi('category', m.categories, fieldLabel('category'), `<option value="none" ${(q.category || '').split(',').includes('none') ? 'selected' : ''}>— Sin ${esc(fieldLabel('category').toLowerCase())}</option>`)}
      ${multi('tech', m.techCategories, fieldLabel('tech'), `<option value="none" ${(q.tech || '').split(',').includes('none') ? 'selected' : ''}>— Sin ${esc(fieldLabel('tech').toLowerCase())}</option>`)}
      ${(m.techSubcategories || []).length ? multi('subtech', m.techSubcategories.map((x) => ({ id: x.id, name: `${m.techCategories.find((c) => c.id === x.tech_category_id)?.name?.split(' - ')[0] || ''} › ${x.name}` })), fieldLabel('subtech')) : ''}
      ${multi('type', m.types, fieldLabel('type'))}
      ${multi('channel', Object.entries(CHANNEL).map(([id, name]) => ({ id, name })), fieldLabel('channel'))}
      <div>
        <label class="field"><span>Creado desde</span><input class="input" type="date" name="created_from" value="${esc(q.created_from || '')}"></label>
        <label class="field"><span>Creado hasta</span><input class="input" type="date" name="created_to" value="${esc(q.created_to || '')}"></label>
        <label class="field"><span>Etiqueta</span><input class="input" name="tag" value="${esc(q.tag || '')}"></label>
      </div>
    </div><p class="hint">Ctrl/Cmd + clic para elegir varios valores.</p>`,
    footer: `<button class="btn" data-clear>Limpiar</button><span class="grow"></span><button class="btn" data-save>Guardar como vista</button><button class="btn primary" data-apply>Aplicar</button>`,
  });
  const collect = () => {
    const out = {};
    for (const k of FILTER_KEYS) {
      const f = md.el.querySelector(`[name="${k}"]`);
      if (!f) continue;
      out[k] = f.multiple ? [...f.selectedOptions].map((o) => o.value).join(',') : f.value;
    }
    return out;
  };
  md.el.querySelector('[data-apply]').addEventListener('click', () => { const f = collect(); md.close(); setQ(f); });
  md.el.querySelector('[data-clear]').addEventListener('click', () => { md.close(); setQ(Object.fromEntries(FILTER_KEYS.map((k) => [k, '']))); });
  md.el.querySelector('[data-save]').addEventListener('click', () => { const f = collect(); md.close(); saveView({ ...q, ...f }); });
}

async function saveView(q) {
  const filters = Object.fromEntries(FILTER_KEYS.filter((k) => q[k]).map((k) => [k, q[k]]));
  if (q.q) filters.q = q.q;
  if (q.view && !q.view.startsWith('custom:') && q.view !== 'all') filters.view = q.view;
  const md = modal({
    title: 'Nueva vista personalizada',
    body: `<label class="field"><span>Nombre</span><input class="input" name="name" placeholder="Ej. Equis alta prioridad"></label>
      <label class="check"><input type="checkbox" name="shared"> Compartir con todo el equipo</label>
      <p class="hint">${Object.keys(filters).length ? `Guarda los filtros actuales (${Object.keys(filters).join(', ')}).` : 'No hay filtros activos: aplicá filtros primero para que la vista sea útil.'}</p>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>',
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try {
      const v = await api('/views', { method: 'POST', body: { name: md.el.querySelector('[name=name]').value, shared: md.el.querySelector('[name=shared]').checked, filters } });
      md.close();
      await refreshMeta();
      navigate(`#/tickets?view=custom:${v.id}`);
    } catch (e) { toastError(e); }
  });
}

/** Modal de alta de ticket (también usado desde el botón "Nuevo"). */
export function openNewTicket(prefill = {}) {
  const opKey = newKey();
  const m = state.meta;
  const md = modal({
    title: 'Nuevo ticket',
    wide: true,
    body: `<form class="ticket-form">
      <div class="grid2">
        <label class="field"><span>Solicitante (correo) *</span><input class="input" name="contact_email" list="contactList" autocomplete="off" placeholder="nombre@empresa.com" value="${esc(prefill.contact_email || '')}"><datalist id="contactList"></datalist></label>
        <label class="field"><span>Nombre del solicitante</span><input class="input" name="contact_name" placeholder="Se completa si el contacto ya existe" value="${esc(prefill.contact_name || '')}"></label>
      </div>
      <label class="field"><span>Asunto *</span><input class="input" name="subject" value="${esc(prefill.subject || '')}"></label>
      <div class="field"><span>Descripción</span><div class="editor"></div></div>
      <div class="grid3">
        <label class="field"><span>${esc(fieldLabel('channel'))}</span><select class="input" name="channel">${['agent', 'phone', 'email', 'teams', 'chat'].map((c) => `<option value="${c}">${CHANNEL[c]}</option>`).join('')}</select></label>
        <label class="field"><span>${esc(fieldLabel('status'))}</span><select class="input" name="status_id">${options(m.statuses.filter((s) => s.active), m.statuses.find((s) => s.is_default)?.id)}</select></label>
        <label class="field"><span>${esc(fieldLabel('priority'))}</span><select class="input" name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="field"><span>${esc(fieldLabel('tech'))}</span><select class="input" name="tech_category_id">${options(m.techCategories.filter((t) => t.active), prefill.tech_category_id, { empty: '—' })}</select></label>
        <label class="field" data-subwrap hidden><span>${esc(fieldLabel('subtech'))}</span><select class="input" name="tech_subcategory_id"></select></label>
        <label class="field"><span>${esc(fieldLabel('assignee'))}</span><select class="input" name="assignee_id"><option value="">— Sin asignar</option>${options(m.users.filter((u) => u.active), null)}</select></label>
        <label class="field"><span>${esc(fieldLabel('category'))}</span><select class="input" name="category_id">${options(m.categories.filter((c) => c.active), null, { empty: '—' })}</select></label>
        <label class="field"><span>${esc(fieldLabel('type'))}</span><select class="input" name="type_id">${options(m.types.filter((c) => c.active), null, { empty: '—' })}</select></label>
        <label class="field"><span>${esc(fieldLabel('sla'))}</span><select class="input" name="sla_id">${options(m.slas.filter((s) => s.active), m.slas.find((s) => s.is_default)?.id)}</select></label>
      </div>
      <div class="grid2">
        <label class="field"><span>CC (separados por coma)</span><input class="input" name="cc"></label>
        <label class="field"><span>Etiquetas (separadas por coma)</span><input class="input" name="tags"></label>
      </div>
      <label class="check"><input type="checkbox" name="send_email"> Enviar la descripción por correo al solicitante ${m.mailEnabled ? '' : '<small class="muted">(correo saliente no configurado)</small>'}</label>
    </form>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Crear ticket</button>',
  });
  const f = md.el.querySelector('form');
  const editor = richEditor(md.el.querySelector('.editor'), { placeholder: 'Detalle del pedido o problema', minHeight: 110 });
  const syncSubs = () => {
    const subs = (m.techSubcategories || []).filter((x) => x.active && x.tech_category_id === Number(f.tech_category_id.value));
    f.tech_subcategory_id.innerHTML = options(subs, null, { empty: '—' });
    md.el.querySelector('[data-subwrap]').hidden = !subs.length;
  };
  f.tech_category_id.addEventListener('change', syncSubs);
  syncSubs();
  const dl = md.el.querySelector('#contactList');
  f.contact_email.addEventListener('input', debounce(async () => {
    const v = f.contact_email.value.trim();
    if (v.length < 2) return;
    const r = await api(`/contacts?q=${encodeURIComponent(v)}&limit=8`).catch(() => ({ items: [] }));
    dl.innerHTML = r.items.map((c) => `<option value="${esc(c.email)}">${esc(c.name)}</option>`).join('');
    const exact = r.items.find((c) => c.email === v.toLowerCase());
    if (exact) f.contact_name.value = exact.name;
  }, 250));
  md.el.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const split = (s) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const body = {
      contact_email: f.contact_email.value.trim(), contact_name: f.contact_name.value.trim(), subject: f.subject.value.trim(),
      body_html: editor.getHTML(), attachments: editor.getFiles(), channel: f.channel.value, status_id: Number(f.status_id.value),
      priority: Number(f.priority.value), tech_category_id: Number(f.tech_category_id.value) || null,
      tech_subcategory_id: Number(f.tech_subcategory_id.value) || null, assignee_id: Number(f.assignee_id.value) || null, category_id: Number(f.category_id.value) || null, type_id: Number(f.type_id.value) || null,
      sla_id: Number(f.sla_id.value) || null, cc: split(f.cc.value), tags: split(f.tags.value), send_email: f.send_email.checked,
    };
    if (!body.contact_email || !body.subject) return toast('Completá solicitante y asunto', 'error');
    btn.disabled = true;
    try {
      const t = await api('/tickets', { method: 'POST', body, idempotencyKey: opKey });
      md.close();
      toast(`Ticket #${t.number} creado`);
      navigate(`#/tickets/${t.number}`);
    } catch (er) { toastError(er); btn.disabled = false; }
  });
}

