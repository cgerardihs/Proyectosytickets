import {
  state, api, esc, icon, toast, toastError, modal, relTime, navigate, options, debounce, emptyState, buildQuery, parseHashQuery, isManager, confirmDialog,
  priorityBadge,
} from '../core.js';
import { setCrumbs } from '../app.js';
import { openNewTicket } from './tickets.js';

export async function render(el, [id]) {
  const isCompanies = location.hash.startsWith('#/companies');
  if (isCompanies) return id ? companyDetail(el, id) : companiesList(el);
  return id ? contactDetail(el, id) : contactsList(el);
}

function tabs(active) {
  return `<div class="seg"><a href="#/contacts" class="${active === 'contacts' ? 'on' : ''}">Contactos</a><a href="#/companies" class="${active === 'companies' ? 'on' : ''}">Empresas</a></div>`;
}

async function contactsList(el) {
  setCrumbs([{ label: 'Contactos' }]);
  const q = parseHashQuery();
  const status = ['inactive', 'all'].includes(q.status) ? q.status : 'active';
  const data = await api(`/contacts${buildQuery({ q: q.q, page: q.page, limit: 50, status })}`);
  const canManage = isManager();
  const selected = new Set();
  const stLink = (k, l, n) => `<a href="#/contacts${buildQuery({ q: q.q, status: k === 'active' ? '' : k })}" class="${status === k ? 'on' : ''}">${l}${n !== undefined ? ` <small>${n}</small>` : ''}</a>`;
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Contactos</h1><p class="muted">Personas que piden ayuda a la mesa.</p></div>
      <div class="row gap">${tabs('contacts')}${canManage ? `<button class="btn" data-act="import">${icon('upload', 15)} Importar CSV</button>` : ''}<button class="btn primary" data-act="new">${icon('plus', 15)} Nuevo contacto</button></div></div>
    <div class="toolbar flat"><div class="searchbox">${icon('search', 15)}<input data-q placeholder="Buscar por nombre, correo o área" value="${esc(q.q || '')}"></div>
      <div class="seg">${stLink('active', 'Activos', data.counts?.active)}${stLink('inactive', 'Inactivos', data.counts?.inactive)}${stLink('all', 'Todos')}</div>
      ${canManage ? `<div class="bulk" hidden><span data-count></span>${status !== 'active' ? `<button class="btn sm" data-act="activate">${icon('check', 14)} Marcar activos</button>` : ''}${status !== 'inactive' ? `<button class="btn sm" data-act="deactivate">${icon('x', 14)} Marcar inactivos</button>` : ''}</div>` : ''}
      <span class="grow"></span>
      <span class="pager">${data.total} contactos ${data.page > 1 ? `<a class="icon-btn sm" href="#/contacts${buildQuery({ ...q, page: data.page - 1 })}">${icon('left', 16)}</a>` : ''}${data.page * data.limit < data.total ? `<a class="icon-btn sm" href="#/contacts${buildQuery({ ...q, page: data.page + 1 })}">${icon('right', 16)}</a>` : ''}</span></div>
    <div class="table-wrap"><table class="tbl"><thead><tr>${canManage ? '<th class="cb"><input type="checkbox" data-all aria-label="Seleccionar todos"></th>' : ''}<th>Nombre</th><th>Correo</th><th>Empresa</th><th>Área</th><th>Teléfono</th><th>Tickets</th></tr></thead>
    <tbody>${data.items.map((c) => `<tr data-id="${c.id}" class="clickable ${c.active === false ? 'inactive' : ''}">${canManage ? `<td class="cb"><input type="checkbox" data-sel="${c.id}" aria-label="Seleccionar ${esc(c.name)}"></td>` : ''}<td><b>${esc(c.name)}</b>${c.vip ? ' <span class="badge" style="--c:#b45309">VIP</span>' : ''}${c.active === false ? ` <span class="badge" title="${c.inactive_manual ? 'Marcado inactivo en la mesa' : 'Deshabilitado en Microsoft 365'}">Inactivo</span>` : ''}</td><td>${esc(c.email)}</td><td>${esc(c.company_name || '')}</td><td>${esc(c.area)}</td><td>${esc(c.phone)}</td><td>${c.ticket_count}</td></tr>`).join('') || `<tr><td colspan="7">${emptyState(status === 'inactive' ? 'No hay contactos inactivos' : 'Sin contactos', '', 'users')}</td></tr>`}</tbody></table></div>
  </div>`;
  const syncBulk = () => {
    const bar = el.querySelector('.bulk');
    if (!bar) return;
    bar.hidden = !selected.size;
    bar.querySelector('[data-count]').textContent = `${selected.size} seleccionado${selected.size === 1 ? '' : 's'}`;
    const all = el.querySelector('[data-all]');
    if (all) all.checked = selected.size > 0 && selected.size === data.items.length;
  };
  el.querySelector('[data-q]').addEventListener('input', debounce((e) => navigate(`#/contacts${buildQuery({ q: e.target.value.trim(), status: status === 'active' ? '' : status })}`), 400));
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-sel]')) { e.target.checked ? selected.add(Number(e.target.dataset.sel)) : selected.delete(Number(e.target.dataset.sel)); syncBulk(); }
    if (e.target.matches('[data-all]')) {
      el.querySelectorAll('[data-sel]').forEach((x) => { x.checked = e.target.checked; e.target.checked ? selected.add(Number(x.dataset.sel)) : selected.delete(Number(x.dataset.sel)); });
      syncBulk();
    }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('td.cb, th.cb')) return;
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'activate' || a?.dataset.act === 'deactivate') {
      const active = a.dataset.act === 'activate';
      try {
        const r = await api('/contacts/active', { method: 'POST', body: { ids: [...selected], active } });
        toast(`${r.updated} contacto${r.updated === 1 ? '' : 's'} marcado${r.updated === 1 ? '' : 's'} como ${active ? 'activo' : 'inactivo'}${r.updated === 1 ? '' : 's'}`);
        navigate(location.hash);
      } catch (err) { toastError(err); }
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) return navigate(`#/contacts/${tr.dataset.id}`);
    if (a?.dataset.act === 'new') openContactForm(null, (c) => navigate(`#/contacts/${c.id}`));
    if (a?.dataset.act === 'import') importContacts();
  });
}

export async function openContactForm(contact = null, onSaved) {
  const companies = await api('/admin/companies');
  const c = contact || {};
  const md = modal({
    title: contact ? 'Editar contacto' : 'Nuevo contacto',
    body: `<div class="grid2">
      <label class="field"><span>Nombre *</span><input class="input" name="name" value="${esc(c.name || '')}"></label>
      <label class="field"><span>Correo *</span><input class="input" name="email" type="email" value="${esc(c.email || '')}"></label>
      <label class="field"><span>Teléfono</span><input class="input" name="phone" value="${esc(c.phone || '')}"></label>
      <label class="field"><span>Área</span><input class="input" name="area" value="${esc(c.area || '')}" list="areaList"><datalist id="areaList">${state.meta.categories.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
      <label class="field"><span>Empresa</span><select class="input" name="company_id">${options(companies, c.company_id, { empty: '—' })}</select></label>
      <label class="field"><span>Cargo</span><input class="input" name="job_title" value="${esc(c.job_title || '')}"></label>
    </div>
    <label class="check"><input type="checkbox" name="vip" ${c.vip ? 'checked' : ''}> Usuario VIP <small class="muted">— suma importancia en el tablero y no recibe respuestas automáticas</small></label>
    <label class="field"><span>Notas</span><textarea class="input" name="notes" rows="3">${esc(c.notes || '')}</textarea></label>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>',
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => md.el.querySelector(`[name=${n}]`).value.trim();
    const body = { name: v('name'), email: v('email'), phone: v('phone'), area: v('area'), company_id: Number(v('company_id')) || null, notes: v('notes'), job_title: v('job_title'), vip: md.el.querySelector('[name=vip]').checked };
    try {
      const saved = contact ? await api(`/contacts/${contact.id}`, { method: 'PATCH', body }) : await api('/contacts', { method: 'POST', body });
      md.close();
      toast('Contacto guardado');
      onSaved?.(saved);
    } catch (e) { toastError(e); }
  });
}

async function contactDetail(el, id) {
  const c = await api(`/contacts/${id}`);
  setCrumbs([{ label: 'Contactos', href: '#/contacts' }, { label: c.name }]);
  el.innerHTML = `<div class="page">
    <div class="page-head"><div class="row gap"><span class="avatar contact" style="width:48px;height:48px;font-size:20px">${esc(c.name[0]?.toUpperCase() || '?')}</span>
      <div><h1>${esc(c.name)}${c.vip ? ' <span class="badge" style="--c:#b45309">VIP</span>' : ''}${c.active === false ? ` <span class="badge">${c.inactive_manual ? 'Inactivo' : 'Inactivo en Microsoft 365'}</span>` : ''}</h1><p class="muted">${c.job_title ? `${esc(c.job_title)} · ` : ''}${esc(c.email)}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.company_name ? ` · ${esc(c.company_name)}` : ''}${c.area ? ` · ${esc(c.area)}` : ''}${c.manager ? ` · Jefe: ${esc(c.manager)}` : ''}</p></div></div>
      <div class="row gap">${isManager() ? `<button class="btn" data-act="toggle-active">${c.active === false ? `${icon('check', 15)} Marcar activo` : `${icon('x', 15)} Marcar inactivo`}</button>` : ''}<button class="btn" data-act="edit">${icon('edit', 15)} Editar</button><button class="btn primary" data-act="ticket">${icon('plus', 15)} Nuevo ticket</button>
      ${isManager() ? `<button class="icon-btn" data-act="delete" title="Eliminar">${icon('trash', 16)}</button>` : ''}</div></div>
    ${c.notes ? `<div class="card"><p>${esc(c.notes)}</p></div>` : ''}
    <div class="card"><h3>Tickets (${c.tickets.length})</h3>
      <table class="tbl compact"><tbody>${c.tickets.map((t) => `<tr><td><a href="#/tickets/${t.number}"><b>#${t.number}</b> ${esc(t.subject)}</a></td><td>${priorityBadge(t.priority)}</td><td>${esc(t.status_name || '')}</td><td class="muted nowrap">${relTime(t.created_at)}</td></tr>`).join('') || '<tr><td class="muted">Sin tickets.</td></tr>'}</tbody></table>
    </div></div>`;
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'edit') openContactForm(c, () => navigate(location.hash));
    if (a.dataset.act === 'toggle-active') {
      const active = c.active === false;
      try {
        await api('/contacts/active', { method: 'POST', body: { ids: [c.id], active } });
        toast(active ? 'Contacto activo' : 'Contacto inactivo: ya no aparece en las listas ni en las sugerencias');
        navigate(location.hash);
      } catch (err) { toastError(err); }
    }
    if (a.dataset.act === 'ticket') openNewTicket({ contact_email: c.email, contact_name: c.name });
    if (a.dataset.act === 'delete') {
      if (!(await confirmDialog(`¿Eliminar a ${c.name}? Sus tickets quedan sin contacto.`, { danger: true, okText: 'Eliminar' }))) return;
      await api(`/contacts/${c.id}`, { method: 'DELETE' }).catch(toastError);
      navigate('#/contacts');
    }
  });
}

function importContacts() {
  const md = modal({
    title: 'Importar contactos desde CSV',
    body: `<p class="muted small">Columnas reconocidas (con encabezado): <code>nombre</code>, <code>email</code>, <code>telefono</code>, <code>area</code>, <code>empresa</code>. Separador coma o punto y coma. Si el correo existe, se actualiza.</p>
      <input type="file" accept=".csv,text/csv" class="input" name="file"><div class="preview muted small"></div>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok disabled>Importar</button>',
  });
  let rows = [];
  md.el.querySelector('[name=file]').addEventListener('change', async (e) => {
    const text = await e.target.files[0].text();
    rows = parseCsv(text);
    md.el.querySelector('.preview').textContent = `${rows.length} filas detectadas.`;
    md.el.querySelector('[data-ok]').disabled = !rows.length;
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try {
      const r = await api('/contacts/import', { method: 'POST', body: { rows } });
      md.close();
      toast(`Importación: ${r.created} nuevos, ${r.updated} actualizados, ${r.skipped} omitidos`);
      navigate('#/contacts');
    } catch (e) { toastError(e); }
  });
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; } else if (ch === sep && !quoted) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const norm = (h) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  const map = { nombre: 'name', name: 'name', email: 'email', correo: 'email', mail: 'email', telefono: 'phone', phone: 'phone', area: 'area', empresa: 'company', company: 'company' };
  const head = split(lines[0]).map((h) => map[norm(h)] || null);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const o = {};
    head.forEach((k, i) => { if (k) o[k] = cells[i] || ''; });
    return o;
  }).filter((o) => o.email);
}

async function companiesList(el) {
  setCrumbs([{ label: 'Contactos', href: '#/contacts' }, { label: 'Empresas' }]);
  const list = await api('/admin/companies');
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Empresas</h1><p class="muted">Los contactos se asocian por dominio de correo.</p></div><div class="row gap">${tabs('companies')}<button class="btn primary" data-act="new">${icon('plus', 15)} Nueva empresa</button></div></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Nombre</th><th>Dominio</th><th>Notas</th></tr></thead>
    <tbody>${list.map((c) => `<tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.domain)}</td><td class="muted">${esc(c.notes)}</td></tr>`).join('') || `<tr><td colspan="3">${emptyState('Sin empresas', '', 'building')}</td></tr>`}</tbody></table></div></div>`;
  el.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) return navigate(`#/companies/${tr.dataset.id}`);
    if (e.target.closest('[data-act=new]')) companyForm(null, () => navigate('#/companies'));
  });
}

function companyForm(c, onSaved) {
  const md = modal({
    title: c ? 'Editar empresa' : 'Nueva empresa',
    body: `<label class="field"><span>Nombre *</span><input class="input" name="name" value="${esc(c?.name || '')}"></label>
      <label class="field"><span>Dominio de correo</span><input class="input" name="domain" placeholder="empresa.com" value="${esc(c?.domain || '')}"></label>
      <label class="field"><span>Notas</span><textarea class="input" name="notes" rows="3">${esc(c?.notes || '')}</textarea></label>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>',
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => md.el.querySelector(`[name=${n}]`).value.trim();
    try {
      await api(c ? `/admin/companies/${c.id}` : '/admin/companies', { method: c ? 'PATCH' : 'POST', body: { name: v('name'), domain: v('domain'), notes: v('notes') } });
      md.close();
      onSaved?.();
    } catch (e) { toastError(e); }
  });
}

async function companyDetail(el, id) {
  const c = await api(`/companies/${id}`);
  setCrumbs([{ label: 'Empresas', href: '#/companies' }, { label: c.name }]);
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${esc(c.name)}</h1><p class="muted">${esc(c.domain || 'sin dominio')}</p></div>
      <div class="row gap"><a class="btn" href="#/tickets?view=all&company=${c.id}">${icon('ticket', 15)} Ver tickets</a><button class="btn" data-act="edit">${icon('edit', 15)} Editar</button></div></div>
    <div class="card"><h3>Contactos (${c.contacts.length})</h3><ul class="mini-list">${c.contacts.map((x) => `<li><a href="#/contacts/${x.id}">${esc(x.name)}</a><small>${esc(x.email)}${x.area ? ` · ${esc(x.area)}` : ''}</small></li>`).join('') || '<li class="muted">Sin contactos.</li>'}</ul></div></div>`;
  el.querySelector('[data-act=edit]').addEventListener('click', () => companyForm(c, () => navigate(location.hash)));
}
