import {
  state, api, esc, icon, avatar, toast, toastError, modal, navigate, options, PRIORITY, confirmDialog, richEditor, sanitize, relTime, applyBrand,
  isAdmin, isSuper, canManageAdmins, ROLE_LABEL, promptDialog, fieldLabel, FIELD_LABEL_DEFAULTS,
} from '../core.js';
import { superadmin } from './superadmin.js';
import { dbAdmin } from './dbadmin.js';
import { setCrumbs, refreshMeta } from '../app.js';

const SECTIONS = [
  ['general', 'General y marca', 'settings'],
  ['agents', 'Agentes', 'user'],
  ['fields', 'Campos del ticket', 'list'],
  ['sla', 'SLA y horario', 'clock'],
  ['rules', 'Automatización', 'zap'],
  ['aging', 'Alertas de antigüedad', 'clock'],
  ['ai', 'Inteligencia artificial', 'sparkles'],
  ['m365', 'Microsoft 365', 'layers'],
  ['dev', 'Proyectos y portfolio', 'projects'],
  ['portfolio', 'Origen, sector IT y horas', 'list'],
  ['canned', 'Respuestas predefinidas', 'sparkles'],
  ['channels', 'Correo e integraciones', 'mail'],
  ['import', 'Importar datos', 'upload'],
  ['superadmin', 'Superadmin', 'shield'],
  ['database', 'Base de datos', 'layers'],
];
const SUPER_ONLY = new Set(['superadmin', 'database']);

export async function render(el, [section = 'general']) {
  if (!isAdmin()) {
    el.innerHTML = '<div class="page"><div class="empty"><h4>Solo para administradores</h4></div></div>';
    return;
  }
  const sections = SECTIONS.filter(([k]) => !SUPER_ONLY.has(k) || isSuper());
  const s = sections.find((x) => x[0] === section) || sections[0];
  setCrumbs([{ label: 'Configuración', href: '#/settings' }, { label: s[1] }]);
  el.innerHTML = `<div class="page settings">
    <nav class="settings-nav">${sections.map(([k, l, ic]) => `<a href="#/settings/${k}" class="${k === s[0] ? 'on' : ''}">${icon(ic, 16)} ${l}</a>`).join('')}</nav>
    <div class="settings-body"></div></div>`;
  const body = el.querySelector('.settings-body');
  await RENDER[s[0]](body);
}

const reloadSection = () => navigate(location.hash);

/**
 * El logo se guarda como imagen de mapa de bits (PNG/JPG/WebP): un SVG puede llevar código adentro, así que se dibuja
 * en un lienzo y se guarda como PNG (hasta 512 px de lado).
 */
function logoToRaster(dataUrl) {
  if (!/^data:image\/svg/i.test(dataUrl)) return Promise.resolve(dataUrl);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 512;
      const h = img.naturalHeight || 512;
      const sc = 512 / Math.max(w, h); // un SVG es vectorial: se dibuja a 512 px de lado mayor
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * sc));
      c.height = Math.max(1, Math.round(h * sc));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ---------- General ----------
async function general(body) {
  const [brand, hd] = await Promise.all([api('/admin/settings/brand'), api('/admin/settings/helpdesk')]);
  const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  body.innerHTML = `
  <form class="card" data-form="brand">
    <h3>Marca</h3>
    <p class="hint">El sistema es white-label: nombre, colores y logo se aplican a la app, al portal y a los correos.</p>
    <div class="grid2">
      <label class="field"><span>Empresa</span><input class="input" name="name" value="${esc(brand.name || '')}"></label>
      <label class="field"><span>Nombre del producto</span><input class="input" name="product" value="${esc(brand.product || '')}"></label>
      <label class="field"><span>Color principal</span><input class="input" type="color" name="color" value="${esc(brand.color || '#C8102E')}"></label>
      <label class="field"><span>Color de acento</span><input class="input" type="color" name="accent" value="${esc(brand.accent || '#F2A900')}"></label>
    </div>
    <div class="field"><span>Logo (cuadrado, PNG/SVG, máx. 500 KB)</span>
      <div class="row gap"><div class="logo-prev">${brand.logo ? `<img src="${esc(brand.logo)}" alt="Logo">` : '<img src="/brand/isotipo.svg" alt="Hanseatica">'}</div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" name="logo_file"><button type="button" class="link-btn" data-act="nologo">Quitar logo</button></div></div>
    <label class="check"><input type="checkbox" name="login_mascot" ${brand.login_mascot !== false ? 'checked' : ''}> Mascota en el inicio de sesión <small class="muted">— el isotipo mira mientras se escribe el usuario y se tapa los ojos en la clave</small></label>
    <button class="btn primary">Guardar marca</button>
  </form>
  <form class="card" data-form="helpdesk">
    <h3>Mesa de ayuda</h3>
    <div class="grid2">
      <label class="field"><span>Correo de soporte (respuestas vuelven acá)</span><input class="input" name="support_email" type="email" value="${esc(hd.support_email || '')}"></label>
      <label class="field"><span>Zona horaria</span><input class="input" name="timezone" value="${esc(hd.timezone || 'America/Argentina/Buenos_Aires')}"></label>
      <label class="field"><span>Cerrar automáticamente resueltos después de (días, 0 = nunca)</span><input class="input" type="number" min="0" name="auto_close_days" value="${hd.auto_close_days ?? 7}"></label>
      <label class="field"><span>Título del portal</span><input class="input" name="portal_title" value="${esc(hd.portal_title || 'Centro de ayuda')}"></label>
    </div>
    <label class="check"><input type="checkbox" name="portal_enabled" ${hd.portal_enabled !== false ? 'checked' : ''}> Portal de soporte habilitado</label>
    <label class="check"><input type="checkbox" name="notify_contact_on_create" ${hd.notify_contact_on_create !== false ? 'checked' : ''}> Avisar al contacto cuando se crea su ticket</label>
    <label class="check"><input type="checkbox" name="notify_contact_on_resolve" ${hd.notify_contact_on_resolve !== false ? 'checked' : ''}> Avisar al contacto cuando se resuelve</label>
    <label class="check"><input type="checkbox" name="notify_agent_on_assign" ${hd.notify_agent_on_assign !== false ? 'checked' : ''}> Enviar correo al agente cuando se le asigna un ticket</label>
    <h4>Horario laboral (para SLA)</h4>
    <div class="row gap wrap">${days.map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${(hd.business?.days || [1, 2, 3, 4, 5]).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
    <div class="grid2">
      <label class="field"><span>Desde</span><input class="input" type="time" name="start" value="${esc(hd.business?.start || '09:00')}"></label>
      <label class="field"><span>Hasta</span><input class="input" type="time" name="end" value="${esc(hd.business?.end || '18:00')}"></label>
    </div>
    <label class="field"><span>Feriados (una fecha AAAA-MM-DD por línea)</span><textarea class="input" name="holidays" rows="4">${esc((hd.holidays || []).join('\n'))}</textarea></label>
    <button class="btn primary">Guardar</button>
  </form>
  <form class="card" data-form="trust">
    <h3>${icon('shield', 16)} Dominios de confianza</h3>
    <p class="hint" style="margin-top:-6px">Si cargás dominios, solo los correos de esos dominios (y sus subdominios) pueden abrir tickets desde el portal, pedir el enlace de acceso y recibir las sugerencias de la IA. Los tickets que lleguen por correo desde otros dominios se crean igual, pero no se les manda la respuesta automática ni el aviso de alta: así nadie puede usar la mesa para enviar spam en nombre de la empresa. Los agentes pueden responderles normalmente. Sin dominios, el portal queda abierto a cualquier correo.</p>
    <div class="grid2">
      <label class="field"><span>Dominios (uno por línea)</span><textarea class="input" name="trusted_domains" rows="4" placeholder="hanseatica.com&#10;otra-empresa.com.ar">${esc((hd.portal_trusted_domains || []).join('\n'))}</textarea></label>
      <div>
        <label class="check"><input type="checkbox" name="allow_directory" ${hd.portal_allow_directory_contacts !== false ? 'checked' : ''}> Aceptar también a los contactos del directorio de Microsoft 365 aunque tengan otro dominio</label>
        <label class="field" style="margin-top:10px"><span>Tope diario de consultas de IA desde el portal (0 = sin tope)</span><input class="input" type="number" min="0" name="portal_ai_daily_limit" value="${hd.portal_ai_daily_limit ?? 150}"></label>
        <p class="hint">Separado del tope mensual: si alguien abusa del portal, se corta ahí y los agentes siguen teniendo el copiloto.</p>
      </div>
    </div>
    ${(hd.portal_trusted_domains || []).length ? '' : `<p class="warn-text small">${icon('alert', 13)} Sin dominios configurados: cualquier persona puede abrir tickets desde el portal y recibir correos automáticos de la mesa.</p>`}
    <button class="btn primary">Guardar</button>
    <h4 style="margin-top:18px">Enlaces del portal</h4>
    <p class="hint">Cada enlace a un ticket del portal vence a los 30 días de enviado (no se renueva solo). Si un correo con enlaces se reenvió a quien no correspondía, podés anularlos todos: los solicitantes reciben uno nuevo con la próxima respuesta.</p>
    <button type="button" class="btn danger" data-act="revoke-portal">${icon('shield', 14)} Anular todos los enlaces del portal</button>
  </form>
  <form class="card" data-form="number">
    <h3>Numeración de tickets</h3>
    <div class="row gap"><label class="field inline"><span>Próximo número</span><input class="input" type="number" min="1" name="next"></label><button class="btn">Aplicar</button></div>
    <p class="hint">Útil para continuar la numeración del sistema anterior.</p>
  </form>`;
  let logo = brand.logo || '';
  body.querySelector('[name=logo_file]').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 500000) return toast('El logo supera los 500 KB', 'error');
    const r = new FileReader();
    r.onload = async () => {
      try { logo = await logoToRaster(r.result); } catch { return toast('No se pudo leer la imagen', 'error'); }
      body.querySelector('.logo-prev').innerHTML = `<img src="${esc(logo)}" alt="Logo">`;
    };
    r.readAsDataURL(f);
  });
  body.querySelector('[data-act=revoke-portal]').addEventListener('click', async () => {
    if (!(await confirmDialog('Se anulan todos los enlaces del portal enviados hasta ahora. Los solicitantes no van a poder abrir sus tickets con esos enlaces. ¿Seguir?', { danger: true, okText: 'Anular enlaces' }))) return;
    try { await api('/admin/portal/revoke-links', { method: 'POST', body: {} }); toast('Listo: los enlaces anteriores ya no funcionan'); } catch (er) { toastError(er); }
  });
  body.querySelector('[data-act=nologo]').addEventListener('click', () => { logo = ''; body.querySelector('.logo-prev').innerHTML = '<span class="slash"><i></i><i></i><i></i><i></i></span>'; });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.dataset.form === 'brand') {
        if (/^data:image\/svg/i.test(logo)) logo = await logoToRaster(logo); // un logo SVG cargado antes de la v1.9.6 pasa a PNG
        const b = await api('/admin/settings/brand', { method: 'PUT', body: { name: f.name.value, product: f.product.value, color: f.color.value, accent: f.accent.value, logo, login_mascot: f.login_mascot.checked } });
        applyBrand(b);
        await refreshMeta();
      }
      if (f.dataset.form === 'helpdesk') {
        await api('/admin/settings/helpdesk', {
          method: 'PUT',
          body: {
            support_email: f.support_email.value.trim(), timezone: f.timezone.value.trim(), auto_close_days: Number(f.auto_close_days.value) || 0,
            portal_title: f.portal_title.value, portal_enabled: f.portal_enabled.checked, notify_contact_on_create: f.notify_contact_on_create.checked,
            notify_contact_on_resolve: f.notify_contact_on_resolve.checked, notify_agent_on_assign: f.notify_agent_on_assign.checked,
            business: { days: [...f.querySelectorAll('[name=day]:checked')].map((x) => Number(x.value)), start: f.start.value, end: f.end.value },
            holidays: f.holidays.value.split(/\s+/).map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)),
          },
        });
        await refreshMeta();
      }
      if (f.dataset.form === 'trust') {
        const domains = [...new Set(f.trusted_domains.value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^.*@/, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean))];
        const badOne = domains.find((d) => !/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d));
        if (badOne) return toast(`"${badOne}" no es un dominio válido (ej. hanseatica.com)`, 'error');
        await api('/admin/settings/helpdesk', {
          method: 'PUT',
          body: { portal_trusted_domains: domains, portal_allow_directory_contacts: f.allow_directory.checked, portal_ai_daily_limit: f.portal_ai_daily_limit.value === '' ? 150 : Math.max(0, Number(f.portal_ai_daily_limit.value) || 0) },
        });
        await refreshMeta();
        toast('Guardado');
        return reloadSection();
      }
      if (f.dataset.form === 'number') await api('/admin/ticket-number', { method: 'POST', body: { next: Number(f.next.value) } });
      toast('Guardado');
    } catch (er) { toastError(er); }
  });
}

// ---------- Agentes ----------
async function agents(body) {
  const users = await api('/admin/users');
  const ROLE = ROLE_LABEL;
  // Cómo puede ingresar cada uno (clave, passkey, Microsoft) y cuándo entró por última vez
  const access = (u) => {
    if (u.role === 'superadmin') return 'Clave en Vercel';
    const ways = [u.has_password && 'Clave', u.has_passkey && 'Passkey', state.meta.msEnabled && 'Microsoft'].filter(Boolean);
    if (!ways.length) return u.last_login_at ? `Sin método activo · ingresó ${relTime(u.last_login_at)}` : '<span class="warn-text">Sin clave</span>';
    return `${ways.join(' · ')}${u.last_login_at ? ` · ${relTime(u.last_login_at)}` : ' · sin ingresos'}`;
  };
  const blocked = state.meta.superadminEnabled && !canManageAdmins();
  body.innerHTML = `${blocked ? `<div class="callout warn">${icon('alert', 16)} <div>Estás ingresado como <b>${esc(state.me.name)}</b> (${ROLE[state.me.role]}). Podés crear y editar supervisores y agentes, y tus propios datos. Para modificar otros <b>administradores</b>, cerrá sesión e ingresá con el usuario del superadministrador (<code>SUPERADMIN_USER</code>, por defecto <code>superadmin</code>) y la clave de <code>SUPERADMIN_PASSWORD</code>.</div></div>` : ''}<div class="card">
    <div class="sec-head"><h3>Agentes (${users.filter((u) => u.active && u.role !== 'superadmin').length} activos)</h3><button class="btn primary sm" data-act="new">${icon('plus', 14)} Agregar agente</button></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Acceso</th><th>Estado</th></tr></thead>
    <tbody>${users.map((u) => `<tr class="clickable ${u.active ? '' : 'inactive'} ${u.role === 'superadmin' ? 'super-row' : ''}" data-id="${u.id}"><td><span class="row gap">${avatar(u, 24, false)} <b>${esc(u.name)}</b>${u.id === state.me.id ? ' <span class="badge" style="--c:#2563eb">Vos</span>' : ''}${u.can_portfolio ? ` <span class="badge" style="--c:#7c3aed" title="Ve el portfolio">${icon('chart', 11)} Portfolio</span>` : ''}${u.can_manage_projects ? ` <span class="badge" style="--c:#0891b2" title="Configura cualquier proyecto">${icon('settings', 11)} Proyectos</span>` : ''}</span></td><td>${esc(u.email)}</td><td>${ROLE[u.role]}</td>
      <td class="small">${access(u)}</td>
      <td>${u.active ? '<span class="badge" style="--c:#059669">Activo</span>' : '<span class="badge" style="--c:#64748b">Inactivo</span>'}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">Roles: <b>Administrador</b> configura la mesa · <b>Supervisor</b> ve informes y gestiona proyectos · <b>Agente</b> atiende tickets y trabaja en proyectos.${state.meta.superadminEnabled ? ' Los administradores solo los crea y modifica el <b>superadministrador</b>.' : ''}</p>
  </div>`;
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) {
      const u = users.find((x) => x.id === Number(tr.dataset.id));
      if (u.role === 'superadmin') return toast('El superadmin se configura con las variables SUPERADMIN_USER y SUPERADMIN_PASSWORD de Vercel', 'error');
      if (u.role === 'admin' && !canManageAdmins() && u.id !== state.me.id) return toast(`Estás como ${state.me.name} (administrador). Para modificar administradores ingresá con el usuario del superadmin.`, 'error');
      return agentForm(u);
    }
    if (e.target.closest('[data-act=new]')) agentForm(null);
  });
}

function agentForm(u) {
  const colors = ['#C41230', '#2563EB', '#059669', '#D97706', '#7C3AED', '#DB2777', '#0891B2', '#65A30D', '#EA580C', '#4F46E5', '#475569'];
  const md = modal({
    title: u ? `Editar ${u.name}` : 'Agregar agente',
    body: `<div class="grid2">
      <label class="field"><span>Nombre *</span><input class="input" name="name" value="${esc(u?.name || '')}"></label>
      <label class="field"><span>Correo *</span><input class="input" name="email" type="email" value="${esc(u?.email || '')}"></label>
      <label class="field"><span>Rol</span><select class="input" name="role"><option value="agent">Agente</option><option value="supervisor">Supervisor</option>${canManageAdmins() || u?.role === 'admin' ? '<option value="admin">Administrador</option>' : ''}</select></label>
      <label class="field"><span>Color</span><select class="input" name="color">${colors.map((c) => `<option value="${c}" ${c === u?.color ? 'selected' : ''} style="background:${c};color:#fff">${c}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>${u ? 'Nueva clave temporal (opcional)' : 'Clave temporal'}</span><input class="input" name="password" type="text" autocomplete="off" placeholder="mín. 10 caracteres — se le pedirá cambiarla"></label>
    ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Activo</label>` : ''}
    ${isSuper() ? `<label class="check"><input type="checkbox" name="can_portfolio" ${u?.can_portfolio ? 'checked' : ''}> Puede ver el portfolio y el roadmap de proyectos</label>` : ''}
    <label class="check"><input type="checkbox" name="can_manage_projects" ${u?.can_manage_projects ? 'checked' : ''}> Puede configurar todos los proyectos <small class="muted">(supervisores, administradores y el líder de cada proyecto ya pueden)</small></label>
    ${state.meta.msEnabled ? '<p class="hint">Con el ingreso de Microsoft habilitado, alcanza con que el correo coincida con su cuenta de Office 365.</p>' : ''}`,
    footer: `${u ? '<button class="btn danger ghost" data-del>Eliminar</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>`,
  });
  if (u) md.el.querySelector('[name=role]').value = u.role;
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => md.el.querySelector(`[name=${n}]`);
    const body = {
      name: v('name').value.trim(), email: v('email').value.trim(), role: v('role').value, color: v('color').value,
      password: v('password').value || undefined,
    };
    if (u) body.active = v('active').checked;
    if (v('can_portfolio')) body.can_portfolio = v('can_portfolio').checked;
    body.can_manage_projects = v('can_manage_projects').checked;
    try {
      await api(u ? `/admin/users/${u.id}` : '/admin/users', { method: u ? 'PATCH' : 'POST', body });
      md.close();
      await refreshMeta();
      toast('Agente guardado');
      reloadSection();
    } catch (e) { toastError(e); }
  });
  md.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Eliminar a ${u.name}? Sus tickets quedan sin asignar. Si solo deja de trabajar, conviene desactivarlo.`, { danger: true, okText: 'Eliminar' }))) return;
    try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); md.close(); await refreshMeta(); reloadSection(); } catch (e) { toastError(e); }
  });
}

// ---------- Campos ----------
// Título de cada tabla = nombre del campo; el superadmin lo cambia con el lápiz (se usa en toda la app)
const labelTitle = (key, extra = '') => `<span data-lbl="${key}">${esc(fieldLabel(key))}</span>${extra}${isSuper() ? ` <button type="button" class="icon-btn xs" data-rename="${key}" title="Cambiar el nombre de este campo">${icon('edit', 13)}</button>` : ''}`;

async function fields(body) {
  const [statuses, types, cats, techs, subs, leftovers] = await Promise.all([api('/admin/statuses'), api('/admin/types'), api('/admin/categories'), api('/admin/tech-categories'), api('/admin/tech-subcategories'),
    api('/admin/group-leftovers').catch(() => [])]);
  const subCount = (id) => subs.filter((x) => x.tech_category_id === id).length;
  let subCat = Number(sessionStorage.getItem('subCat')) || techs[0]?.id || null;
  if (!techs.some((t) => t.id === subCat)) subCat = techs[0]?.id || null;
  const KIND = { open: 'Abierto', pending: 'En espera', resolved: 'Resuelto', closed: 'Cerrado' };
  const leftCard = leftovers.length ? `<div class="card callout-card">
    <h3>${icon('alert', 16)} Tickets que tenían grupo y quedaron sin ${esc(fieldLabel('tech').toLowerCase())}</h3>
    <p class="hint">Los grupos se eliminaron. La mayoría de los tickets pasaron solos a la ${esc(fieldLabel('tech').toLowerCase())} equivalente; estos no tenían una con nombre parecido. Elegí a cuál van (también lo usa el importador de Desk365 para la columna "Grupo").</p>
    <table class="tbl compact"><thead><tr><th>Grupo anterior</th><th class="num">Tickets</th><th>${esc(fieldLabel('tech'))}</th><th>${esc(fieldLabel('subtech'))}</th><th></th></tr></thead><tbody>
    ${leftovers.map((g) => `<tr data-left="${g.id}"><td><b>${esc(g.name)}</b></td><td class="num">${g.n}</td>
      <td><select class="input sm" name="lt_tech">${options(techs.filter((t) => t.active), null, { empty: 'Elegí…' })}</select></td>
      <td><select class="input sm" name="lt_sub"><option value="">—</option></select></td>
      <td><button class="btn sm primary" data-left-apply>Asignar</button></td></tr>`).join('')}</tbody></table></div>` : '';
  const LBL_OTHER = ['priority', 'assignee', 'contact', 'channel', 'sla'];
  const labelsCard = isSuper() ? `<form class="card" data-form="labels">
    <h3>${icon('edit', 15)} Nombres de otros campos</h3>
    <p class="hint">Solo el superadmin. Los nombres se usan en la lista de tickets, el detalle, los filtros y los informes. Dejá vacío para volver al nombre original.</p>
    <div class="grid3">${LBL_OTHER.map((k) => `<label class="field"><span>${esc(FIELD_LABEL_DEFAULTS[k])}</span><input class="input" name="${k}" maxlength="60" value="${esc(state.meta.fieldLabels?.[k] || '')}" placeholder="${esc(FIELD_LABEL_DEFAULTS[k])}"></label>`).join('')}</div>
    <button class="btn primary">Guardar nombres</button></form>` : '';
  body.innerHTML = `${leftCard}
  <div class="card">
    <h3>${labelTitle('status')}</h3>
    <p class="hint">El tipo define el comportamiento: "En espera" puede pausar el SLA; "Resuelto" y "Cerrado" salen de las vistas sin resolver. Si el contacto responde, el ticket vuelve a un estado "Abierto".</p>
    <table class="tbl compact edit-tbl" data-table="statuses"><thead><tr><th>Nombre</th><th>Tipo</th><th>Color</th><th>Pausa SLA</th><th>Predeterminado</th><th>Activo</th><th>Orden</th><th></th></tr></thead><tbody>
    ${statuses.map((s) => `<tr data-id="${s.id}"><td><input class="input sm" name="name" value="${esc(s.name)}"></td>
      <td><select class="input sm" name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${k === s.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><input type="color" name="color" value="${esc(s.color)}"></td><td><input type="checkbox" name="pauses_sla" ${s.pauses_sla ? 'checked' : ''}></td>
      <td><input type="radio" name="is_default" ${s.is_default ? 'checked' : ''}></td><td><input type="checkbox" name="active" ${s.active ? 'checked' : ''}></td>
      <td><input class="input sm" type="number" name="sort" value="${s.sort}" style="width:64px"></td><td class="row"><button class="btn sm" data-save>Guardar</button><button class="icon-btn sm" data-del title="Eliminar">${icon('trash', 13)}</button></td></tr>`).join('')}
    </tbody></table><button class="btn sm" data-add="statuses">${icon('plus', 13)} Agregar estado</button>
  </div>
  ${simpleTable(labelTitle('category'), 'categories', cats)}
  ${simpleTable(labelTitle('type'), 'types', types)}
  <div class="card">
    <h3>${labelTitle('tech')}</h3>
    <p class="hint">Clasifican el tema del ticket. Cada una puede tener subcategorías (un nivel más abajo).</p>
    <table class="tbl compact edit-tbl" data-table="tech-categories"><thead><tr><th>Nombre</th><th>Subcategorías</th><th>Activo</th><th>Orden</th><th></th></tr></thead><tbody>
    ${techs.map((t) => `<tr data-id="${t.id}"><td><input class="input sm" name="name" value="${esc(t.name)}"></td>
      <td><button type="button" class="link-btn" data-subof="${t.id}">${subCount(t.id) ? `${subCount(t.id)} subcategoría${subCount(t.id) > 1 ? 's' : ''}` : 'Agregar'}</button></td>
      <td><input type="checkbox" name="active" ${t.active ? 'checked' : ''}></td><td><input class="input sm" type="number" name="sort" value="${t.sort}" style="width:64px"></td>
      <td class="row"><button class="btn sm" data-save>Guardar</button><button class="icon-btn sm" data-del title="Eliminar">${icon('trash', 13)}</button></td></tr>`).join('')}
    </tbody></table><button class="btn sm" data-add="tech-categories">${icon('plus', 13)} Agregar</button>
  </div>
  <div class="card" id="subcats">
    <h3>${labelTitle('subtech')}</h3>
    <p class="hint">Un nivel debajo de cada categoría técnica. En el ticket se elige primero la categoría y después la subcategoría. Sirven para filtrar, en las vistas, en las reglas de automatización, en los informes y en la API.</p>
    ${techs.length ? `<label class="field" style="max-width:520px"><span>Categoría técnica</span><select class="input" data-subcat>${options(techs, subCat)}</select></label>
    <table class="tbl compact edit-tbl" data-table="tech-subcategories"><thead><tr><th>Subcategoría</th><th>Activo</th><th>Orden</th><th></th></tr></thead><tbody>
    ${subs.filter((x) => x.tech_category_id === subCat).map((x) => `<tr data-id="${x.id}"><td><input class="input sm" name="name" value="${esc(x.name)}"></td>
      <td><input type="checkbox" name="active" ${x.active ? 'checked' : ''}></td><td><input class="input sm" type="number" name="sort" value="${x.sort}" style="width:64px"></td>
      <td class="row"><button class="btn sm" data-save>Guardar</button><button class="icon-btn sm" data-del title="Eliminar">${icon('trash', 13)}</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted small">Esta categoría todavía no tiene subcategorías.</td></tr>'}
    </tbody></table><button class="btn sm" data-addsub>${icon('plus', 13)} Agregar subcategoría</button>` : '<p class="muted small">Primero creá una categoría técnica.</p>'}
  </div>`;
  body.insertAdjacentHTML('beforeend', labelsCard);
  // Tickets sin categoría técnica que tenían grupo: subcategorías según la categoría elegida
  body.querySelectorAll('[data-left]').forEach((tr) => {
    const t = tr.querySelector('[name=lt_tech]');
    const s = tr.querySelector('[name=lt_sub]');
    t.addEventListener('change', () => { s.innerHTML = `<option value="">—</option>${options(subs.filter((x) => x.active && x.tech_category_id === Number(t.value)), null)}`; });
    tr.querySelector('[data-left-apply]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!t.value) return toast(`Elegí la ${fieldLabel('tech').toLowerCase()}`, 'error');
      btn.disabled = true;
      try {
        const r = await api('/admin/group-leftovers', { method: 'POST', body: { group_id: Number(tr.dataset.left), tech_category_id: Number(t.value), tech_subcategory_id: Number(s.value) || null } });
        toast(`${r.updated} ticket(s) actualizados`);
        reloadSection();
      } catch (er) { toastError(er); btn.disabled = false; }
    });
  });
  const saveLabels = async (patch) => {
    try {
      await api('/super/field-labels', { method: 'PUT', body: patch });
      await refreshMeta();
      toast('Nombre guardado');
      reloadSection();
    } catch (er) { toastError(er); }
  };
  body.addEventListener('click', async (e) => {
    const rn = e.target.closest('[data-rename]');
    if (!rn) return;
    const k = rn.dataset.rename;
    const name = await promptDialog(`Nombre del campo (vacío = "${FIELD_LABEL_DEFAULTS[k]}")`, { title: 'Cambiar nombre', value: fieldLabel(k), okText: 'Guardar' });
    if (name === null) return;
    saveLabels({ [k]: name });
  });
  body.querySelector('form[data-form=labels]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveLabels(Object.fromEntries(LBL_OTHER.map((k) => [k, e.target[k].value.trim()])));
  });
  body.querySelector('[data-subcat]')?.addEventListener('change', (e) => { try { sessionStorage.setItem('subCat', e.target.value); } catch { /* */ } reloadSection(); });
  body.addEventListener('click', async (e) => {
    const of = e.target.closest('[data-subof]');
    if (of) {
      try { sessionStorage.setItem('subCat', of.dataset.subof); } catch { /* */ }
      await reloadSection();
      document.getElementById('subcats')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!e.target.closest('[data-addsub]')) return;
    const name = await promptDialog('Nombre de la subcategoría', { title: techs.find((t) => t.id === subCat)?.name || '' });
    if (!name) return;
    try {
      await api('/admin/tech-subcategories', { method: 'POST', body: { name, tech_category_id: subCat, sort: subs.filter((x) => x.tech_category_id === subCat).length } });
      await refreshMeta();
      reloadSection();
    } catch (er) { toastError(er); }
  });
  wireEditTables(body);
}

function simpleTable(title, table, rows) {
  return `<div class="card"><h3>${title}</h3>
    <table class="tbl compact edit-tbl" data-table="${table}"><thead><tr><th>Nombre</th>${table === 'categories' ? '<th>Descripción</th>' : ''}<th>Activo</th><th>Orden</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-id="${r.id}"><td><input class="input sm" name="name" value="${esc(r.name)}"></td>${table === 'categories' ? `<td><input class="input sm" name="description" value="${esc(r.description || '')}"></td>` : ''}
      <td><input type="checkbox" name="active" ${r.active ? 'checked' : ''}></td><td><input class="input sm" type="number" name="sort" value="${r.sort}" style="width:64px"></td>
      <td class="row"><button class="btn sm" data-save>Guardar</button><button class="icon-btn sm" data-del title="Eliminar">${icon('trash', 13)}</button></td></tr>`).join('')}
    </tbody></table><button class="btn sm" data-add="${table}">${icon('plus', 13)} Agregar</button></div>`;
}

function rowValues(tr) {
  const out = {};
  tr.querySelectorAll('[name]').forEach((i) => {
    if (i.type === 'checkbox' || i.type === 'radio') out[i.name] = i.checked;
    else if (i.type === 'number') out[i.name] = Number(i.value);
    else out[i.name] = i.value;
  });
  return out;
}

function wireEditTables(body) {
  body.addEventListener('click', async (e) => {
    const save = e.target.closest('[data-save]');
    const del = e.target.closest('[data-del]');
    const add = e.target.closest('[data-add]');
    try {
      if (save) {
        const tr = save.closest('tr');
        const table = tr.closest('table').dataset.table;
        await api(`/admin/${table}/${tr.dataset.id}`, { method: 'PATCH', body: rowValues(tr) });
        await refreshMeta();
        toast('Guardado');
        if (table === 'statuses') reloadSection();
      }
      if (del) {
        const tr = del.closest('tr');
        if (!(await confirmDialog('¿Eliminar este valor? Si está en uso, conviene desactivarlo.', { danger: true, okText: 'Eliminar' }))) return;
        await api(`/admin/${tr.closest('table').dataset.table}/${tr.dataset.id}`, { method: 'DELETE' });
        await refreshMeta();
        reloadSection();
      }
      if (add) {
        const t = add.dataset.add;
        const name = window.prompt('Nombre');
        if (!name) return;
        await api(`/admin/${t}`, { method: 'POST', body: t === 'statuses' ? { name, kind: 'open', sort: 99 } : { name, sort: 99 } });
        await refreshMeta();
        reloadSection();
      }
    } catch (er) { toastError(er); }
  });
}

// ---------- SLA ----------
async function sla(body) {
  const list = await api('/admin/slas');
  body.innerHTML = `<div class="card">
    <div class="sec-head"><h3>Políticas de SLA</h3><button class="btn primary sm" data-act="new">${icon('plus', 14)} Agregar política</button></div>
    <p class="hint">Tiempos en horas. Con "horario laboral", solo cuentan los días y horas definidos en <a href="#/settings/general">General</a> (descontando feriados). Los estados que pausan el SLA extienden el vencimiento.</p>
    ${list.map((s) => `<form class="sla-card" data-id="${s.id}">
      <div class="row gap"><input class="input" name="name" value="${esc(s.name)}" style="max-width:280px">
        <label class="check"><input type="radio" name="is_default" ${s.is_default ? 'checked' : ''}> Predeterminada</label>
        <label class="check"><input type="checkbox" name="no_sla" ${s.no_sla ? 'checked' : ''}> Sin SLA</label>
        <label class="check"><input type="checkbox" name="business_hours" ${s.business_hours ? 'checked' : ''}> Horario laboral</label>
        <label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Activa</label></div>
      ${s.no_sla ? '' : `<table class="tbl compact"><thead><tr><th>Prioridad</th><th>1ª respuesta (h)</th><th>Resolución (h)</th></tr></thead><tbody>
        ${Object.entries(PRIORITY).map(([k, v]) => `<tr><td>${v}</td><td><input class="input sm" type="number" min="0" step="0.5" name="first_${k}" value="${s.targets?.[k]?.first ?? ''}"></td><td><input class="input sm" type="number" min="0" step="0.5" name="resolve_${k}" value="${s.targets?.[k]?.resolve ?? ''}"></td></tr>`).join('')}</tbody></table>`}
      <div class="row gap"><button class="btn sm primary">Guardar</button><button type="button" class="btn sm danger ghost" data-del>Eliminar</button></div>
    </form>`).join('')}
  </div>`;
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const targets = {};
    for (const k of Object.keys(PRIORITY)) {
      if (f[`first_${k}`]) targets[k] = { first: Number(f[`first_${k}`].value) || 0, resolve: Number(f[`resolve_${k}`].value) || 0 };
    }
    try {
      await api(`/admin/slas/${f.dataset.id}`, { method: 'PATCH', body: { name: f.name.value, is_default: f.is_default.checked, no_sla: f.no_sla.checked, business_hours: f.business_hours.checked, active: f.active.checked, targets } });
      await refreshMeta();
      toast('SLA guardado');
      reloadSection();
    } catch (er) { toastError(er); }
  });
  body.addEventListener('click', async (e) => {
    try {
      if (e.target.closest('[data-act=new]')) {
        await api('/admin/slas', { method: 'POST', body: { name: `Nueva política ${list.length + 1}`, business_hours: true, targets: { 1: { first: 8, resolve: 72 }, 2: { first: 4, resolve: 24 }, 3: { first: 2, resolve: 8 }, 4: { first: 1, resolve: 4 } }, sort: list.length } });
        await refreshMeta();
        reloadSection();
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (!(await confirmDialog('¿Eliminar la política?', { danger: true, okText: 'Eliminar' }))) return;
        await api(`/admin/slas/${del.closest('form').dataset.id}`, { method: 'DELETE' });
        await refreshMeta();
        reloadSection();
      }
    } catch (er) { toastError(er); }
  });
}

// ---------- Automatización ----------
const COND_FIELDS = {
  subject: 'Asunto', description: 'Descripción', from_email: 'Correo del solicitante', from_domain: 'Dominio del solicitante', contact_area: 'Área del contacto',
  channel: 'Canal', priority: 'Prioridad', category_id: 'Área solicitante', tech_category_id: 'Categoría técnica', tech_subcategory_id: 'Subcategoría técnica', type_id: 'Tipo',
};
const OPS = { contains: 'contiene', not_contains: 'no contiene', equals: 'es igual a', not_equals: 'es distinto de', starts_with: 'empieza con', ends_with: 'termina con', is_empty: 'está vacío' };
const ACT_FIELDS = { assignee_id: 'Asignar agente', priority: 'Prioridad', status_id: 'Estado', type_id: 'Tipo', category_id: 'Categoría', tech_category_id: 'Categoría técnica', tech_subcategory_id: 'Subcategoría técnica', sla_id: 'SLA', add_tag: 'Agregar etiqueta' };

function valueInput(field, value, prefix) {
  const m = state.meta;
  const lists = {
    assignee_id: m.users.filter((u) => u.active), status_id: m.statuses, type_id: m.types, category_id: m.categories, tech_category_id: m.techCategories, sla_id: m.slas,
    tech_subcategory_id: (m.techSubcategories || []).map((x) => ({ id: x.id, name: `${m.techCategories.find((c) => c.id === x.tech_category_id)?.name || ''} › ${x.name}` })),
    priority: Object.entries(PRIORITY).map(([id, name]) => ({ id, name })),
    channel: Object.entries({ email: 'Correo', portal: 'Portal', phone: 'Teléfono', agent: 'Agente', teams: 'Teams' }).map(([id, name]) => ({ id, name })),
  };
  if (lists[field]) return `<select class="input sm" name="${prefix}value">${options(lists[field], value)}</select>`;
  return `<input class="input sm" name="${prefix}value" value="${esc(value ?? '')}">`;
}

async function rules(body) {
  const list = await api('/admin/rules');
  body.innerHTML = `<div class="card">
    <div class="sec-head"><h3>Reglas al crear un ticket</h3><button class="btn primary sm" data-act="new">${icon('plus', 14)} Nueva regla</button></div>
    <p class="hint">Se evalúan en orden cuando entra un ticket (correo, portal o agente). Ejemplo: si el asunto contiene "equis" → grupo "EQUIS - Uso diario". Lo que el agente elige a mano tiene prioridad sobre la regla.</p>
    ${list.length ? `<table class="tbl"><thead><tr><th>Orden</th><th>Regla</th><th>Condiciones</th><th>Acciones</th><th>Activa</th></tr></thead><tbody>
    ${list.map((r) => `<tr class="clickable" data-id="${r.id}"><td>${r.sort}</td><td><b>${esc(r.name)}</b>${r.stop ? ' <small class="muted">(detiene)</small>' : ''}</td>
      <td class="small">${(r.conditions || []).map((c) => `${COND_FIELDS[c.field] || 'Grupo (ya no existe)'} ${OPS[c.op]} "${esc(c.value)}"`).join(r.match === 'any' ? ' <b>o</b> ' : ' <b>y</b> ')}</td>
      <td class="small">${(r.actions || []).map((a) => esc(ACT_FIELDS[a.field] || 'Grupo (ya no existe)')).join(', ')}</td><td>${r.active ? 'Sí' : 'No'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No hay reglas.</p>'}
  </div>`;
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) ruleForm(list.find((r) => r.id === Number(tr.dataset.id)));
    if (e.target.closest('[data-act=new]')) ruleForm(null, list.length);
  });
}

function ruleForm(r, n = 0) {
  const rule = r || { name: '', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: '' }], actions: [{ field: 'tech_category_id', value: '' }], active: true, stop: false, sort: n };
  // Reglas de antes de la v1.9: se descartan las condiciones y acciones sobre grupos (ya no existen)
  rule.conditions = (rule.conditions || []).filter((c) => c.field !== 'group_id');
  rule.actions = (rule.actions || []).filter((a) => a.field !== 'group_id');
  const condRow = (c, i) => `<div class="rule-row" data-c="${i}"><select class="input sm" name="c${i}field">${Object.entries(COND_FIELDS).map(([k, v]) => `<option value="${k}" ${k === c.field ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select class="input sm" name="c${i}op">${Object.entries(OPS).map(([k, v]) => `<option value="${k}" ${k === c.op ? 'selected' : ''}>${v}</option>`).join('')}</select>${valueInput(c.field, c.value, `c${i}`)}<button type="button" class="icon-btn sm" data-rmc="${i}">${icon('x', 13)}</button></div>`;
  const actRow = (a, i) => `<div class="rule-row" data-a="${i}"><select class="input sm" name="a${i}field">${Object.entries(ACT_FIELDS).map(([k, v]) => `<option value="${k}" ${k === a.field ? 'selected' : ''}>${v}</option>`).join('')}</select>${valueInput(a.field, a.value, `a${i}`)}<button type="button" class="icon-btn sm" data-rma="${i}">${icon('x', 13)}</button></div>`;
  const md = modal({ title: r ? 'Editar regla' : 'Nueva regla', wide: true, body: '<div class="rule-form"></div>', footer: `${r ? '<button class="btn danger ghost" data-del>Eliminar</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>` });
  const host = md.el.querySelector('.rule-form');
  const read = () => {
    const v = (n2) => host.querySelector(`[name="${n2}"]`);
    rule.name = v('name').value;
    rule.match = v('match').value;
    rule.sort = Number(v('sort').value) || 0;
    rule.active = v('active').checked;
    rule.stop = v('stop').checked;
    rule.conditions = rule.conditions.map((_, i) => ({ field: v(`c${i}field`).value, op: v(`c${i}op`).value, value: v(`c${i}value`).value }));
    rule.actions = rule.actions.map((_, i) => ({ field: v(`a${i}field`).value, value: v(`a${i}value`).value }));
  };
  const draw = () => {
    host.innerHTML = `<div class="grid3"><label class="field"><span>Nombre</span><input class="input" name="name" value="${esc(rule.name)}"></label>
      <label class="field"><span>Se cumple si</span><select class="input" name="match"><option value="all" ${rule.match === 'all' ? 'selected' : ''}>Todas las condiciones</option><option value="any" ${rule.match === 'any' ? 'selected' : ''}>Alguna condición</option></select></label>
      <label class="field"><span>Orden</span><input class="input" type="number" name="sort" value="${rule.sort}"></label></div>
      <h4>Condiciones</h4>${rule.conditions.map(condRow).join('')}<button type="button" class="btn sm" data-addc>${icon('plus', 13)} Condición</button>
      <h4>Acciones</h4>${rule.actions.map(actRow).join('')}<button type="button" class="btn sm" data-adda>${icon('plus', 13)} Acción</button>
      <div class="row gap" style="margin-top:12px"><label class="check"><input type="checkbox" name="active" ${rule.active ? 'checked' : ''}> Activa</label><label class="check"><input type="checkbox" name="stop" ${rule.stop ? 'checked' : ''}> No evaluar más reglas si se cumple</label></div>`;
  };
  draw();
  host.addEventListener('change', (e) => { if (/^[ca]\d+field$/.test(e.target.name)) { read(); draw(); } });
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-addc]')) { read(); rule.conditions.push({ field: 'subject', op: 'contains', value: '' }); draw(); }
    if (e.target.closest('[data-adda]')) { read(); rule.actions.push({ field: 'tech_category_id', value: '' }); draw(); }
    const rc = e.target.closest('[data-rmc]');
    if (rc) { read(); rule.conditions.splice(Number(rc.dataset.rmc), 1); draw(); }
    const ra = e.target.closest('[data-rma]');
    if (ra) { read(); rule.actions.splice(Number(ra.dataset.rma), 1); draw(); }
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    read();
    if (!rule.name) return toast('Poné un nombre', 'error');
    try {
      await api(r ? `/admin/rules/${r.id}` : '/admin/rules', { method: r ? 'PATCH' : 'POST', body: { name: rule.name, match: rule.match, sort: rule.sort, active: rule.active, stop: rule.stop, conditions: rule.conditions, actions: rule.actions } });
      md.close();
      reloadSection();
    } catch (e) { toastError(e); }
  });
  md.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    await api(`/admin/rules/${r.id}`, { method: 'DELETE' }).catch(toastError);
    md.close();
    reloadSection();
  });
}

// ---------- Respuestas predefinidas ----------
async function canned(body) {
  const list = await api('/canned');
  body.innerHTML = `<div class="card">
    <div class="sec-head"><h3>Respuestas predefinidas</h3><button class="btn primary sm" data-act="new">${icon('plus', 14)} Nueva respuesta</button></div>
    <p class="hint">Variables: <code>{{contacto.nombre}}</code> <code>{{ticket.numero}}</code> <code>{{ticket.asunto}}</code> <code>{{agente.nombre}}</code></p>
    <table class="tbl"><thead><tr><th>Carpeta</th><th>Título</th><th>Vista previa</th><th>Compartida</th></tr></thead>
    <tbody>${list.map((c) => `<tr class="clickable" data-id="${c.id}"><td>${esc(c.folder)}</td><td><b>${esc(c.title)}</b></td><td class="muted small ellip-cell">${esc(sanitize(c.body_html).replace(/<[^>]+>/g, ' ').slice(0, 120))}</td><td>${c.shared ? 'Sí' : 'No'}</td></tr>`).join('')}</tbody></table></div>`;
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) cannedForm(list.find((c) => c.id === Number(tr.dataset.id)));
    if (e.target.closest('[data-act=new]')) cannedForm(null);
  });
}

function cannedForm(c) {
  const md = modal({
    title: c ? 'Editar respuesta' : 'Nueva respuesta',
    wide: true,
    body: `<div class="grid2"><label class="field"><span>Título</span><input class="input" name="title" value="${esc(c?.title || '')}"></label><label class="field"><span>Carpeta</span><input class="input" name="folder" value="${esc(c?.folder || 'General')}"></label></div>
      <div class="ed"></div><label class="check"><input type="checkbox" name="shared" ${!c || c.shared ? 'checked' : ''}> Compartida con todo el equipo</label>`,
    footer: `${c ? '<button class="btn danger ghost" data-del>Eliminar</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>`,
  });
  const ed = richEditor(md.el.querySelector('.ed'), { value: c?.body_html || '', attachments: false });
  md.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const v = (n) => md.el.querySelector(`[name=${n}]`);
    try {
      await api(c ? `/canned/${c.id}` : '/canned', { method: c ? 'PATCH' : 'POST', body: { title: v('title').value, folder: v('folder').value, shared: v('shared').checked, body_html: ed.getHTML() } });
      md.close();
      reloadSection();
    } catch (e) { toastError(e); }
  });
  md.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    await api(`/canned/${c.id}`, { method: 'DELETE' }).catch(toastError);
    md.close();
    reloadSection();
  });
}

// ---------- Canales ----------
async function channels(body) {
  const m = state.meta;
  const origin = location.origin;
  const ok = (b) => (b ? `<span class="badge" style="--c:#059669">Configurado</span>` : `<span class="badge" style="--c:#d97706">Pendiente</span>`);
  body.innerHTML = `
  <div class="card">
    <div class="sec-head"><h3>${icon('mail', 16)} Correo saliente (Resend)</h3>${ok(m.mailEnabled)}</div>
    <p>Se usa para responder a los contactos, avisos de asignación y enlaces al portal. Variables en Vercel: <code>RESEND_API_KEY</code>, <code>MAIL_FROM</code> (ej. <code>Mesa de Ayuda &lt;ayuda@hanseatica.com&gt;</code>, con el dominio verificado en Resend). Las respuestas vuelven al correo de soporte definido en <a href="#/settings/general">General</a>.</p>
  </div>
  <div class="card">
    <div class="sec-head"><h3>${icon('inbox', 16)} Correo entrante → tickets</h3>${ok(m.inboundConfigured || m.m365?.mailbox)}</div>
    ${m.m365?.mailbox ? `<p class="rule-info">${icon('check', 15)}<span>El buzón <b>${esc(m.m365.mailbox)}</b> se lee directo desde Microsoft 365 (<a href="#/settings/m365">configuración</a>). El webhook de abajo queda como alternativa.</span></p>` : ''}
    <p>Cada correo que llega al buzón de soporte se convierte en ticket (o se agrega al ticket existente si el asunto trae <code>[#número]</code>). Definí <code>INBOUND_SECRET</code> en Vercel y enviá los correos a este webhook:</p>
    <div class="copybox"><code>${esc(origin)}/api/inbound/email</code><button class="icon-btn sm" data-copy="${esc(origin)}/api/inbound/email">${icon('copy', 14)}</button></div>
    <p class="small">Encabezado: <code>x-inbound-secret: (tu INBOUND_SECRET)</code> · Cuerpo JSON: <code>from, subject, html|text, cc, message_id, attachments[{name, contentType, contentBytes}]</code></p>
    <h4>Con Power Automate (Office 365)</h4>
    <ol class="steps">
      <li>Flujo automatizado con el disparador <b>"Cuando llega un correo nuevo en un buzón compartido (V2)"</b> sobre ayuda@hanseatica.com, con "Incluir datos adjuntos" en Sí.</li>
      <li>Acción <b>HTTP</b> · Método POST · URI: la de arriba · Encabezados: <code>Content-Type: application/json</code> y <code>x-inbound-secret</code>.</li>
      <li>Cuerpo: <code>{"From": De, "Subject": Asunto, "Body": Cuerpo, "Cc": CC, "InternetMessageId": Id. de mensaje de Internet, "Attachments": Datos adjuntos}</code>.</li>
      <li>Probá enviando un correo: tiene que aparecer como ticket con canal "Correo".</li>
    </ol>
  </div>
  <div class="card">
    <div class="sec-head"><h3>${icon('shield', 16)} Ingreso con Microsoft (Entra ID)</h3>${ok(m.msEnabled)}</div>
    <p>Se configura en <a href="#/settings/m365">Microsoft 365</a>, junto con el buzón de soporte, el directorio, Teams, Intune y SharePoint. Solo ingresan los agentes cuyo correo esté dado de alta y activo.</p>
  </div>
  <div class="card">
    <div class="sec-head"><h3>${icon('globe', 16)} Portal de soporte</h3></div>
    <p>Los empleados pueden crear tickets, seguirlos y leer artículos en <a href="/portal" target="_blank" rel="noopener">${esc(origin)}/portal</a>.</p>
    <div class="copybox"><code>${esc(origin)}/portal</code><button class="icon-btn sm" data-copy="${esc(origin)}/portal">${icon('copy', 14)}</button></div>
  </div>
  <div class="card">
    <div class="sec-head"><h3>${icon('clock', 16)} Tarea diaria</h3></div>
    <p>Vercel Cron ejecuta todos los días <code>/api/cron/daily</code>: cierra los tickets resueltos según los días configurados y avisa a cada agente sus tickets con SLA vencido. Definí <code>CRON_SECRET</code> en Vercel.</p>
    <button class="btn sm" data-act="cron">Ejecutar ahora</button>
  </div>`;
  body.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Copiado'); } catch { toast(c.dataset.copy); } }
    if (e.target.closest('[data-act=cron]')) {
      try { const r = await api('/admin/cron/run', { method: 'POST', body: {} }); toast(`Listo: ${r.closed} cerrados, ${r.overdueNotified} agentes avisados`); } catch (er) { toastError(er); }
    }
  });
}

// ---------- Proyectos: tipos, listas del portfolio y reglas ticket ↔ proyecto ----------
const WF_LABEL = { scrum: 'Scrum', kanban: 'Kanban: Pendiente → En curso → Hecho', dev: 'Desarrollo', simple: 'Simple' };
async function dev(body) {
  const [hd, types] = await Promise.all([api('/admin/settings/helpdesk'), api('/admin/project-types')]);
  const typesCard = `<div class="card">
    <div class="sec-head"><h3>${icon('projects', 16)} Tipos de proyecto</h3><button class="btn primary sm" data-type-new>${icon('plus', 14)} Agregar tipo</button></div>
    <p class="hint" style="margin-top:-6px">Cada tipo define sus etapas (por ejemplo, un desarrollo tiene Relevamiento, Desarrollo, Testing e Implementación; una instalación, Análisis, Instalación e Implementación). Al crear un proyecto se elige el tipo y se pueden destildar o agregar etapas. El tipo predeterminado es el que se usa al convertir un ticket.</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Tipo</th><th>Etapas</th><th>Flujo de tareas</th><th>Sprints</th><th>Estado</th></tr></thead><tbody>
    ${types.map((t) => `<tr class="clickable ${t.active ? '' : 'inactive'}" data-type="${t.id}"><td><span class="row gap"><i class="dot-c" style="--c:${esc(t.color)}"></i><b>${esc(t.name)}</b>${t.is_default ? ' <span class="badge" style="--c:#C41230">Predeterminado</span>' : ''}</span>${t.description ? `<small class="muted block">${esc(t.description)}</small>` : ''}</td>
      <td class="small">${(t.phases || []).map((x, i) => `<span class="chip sm">${i + 1}. ${esc(x)}</span>`).join(' ')}</td><td class="small">${WF_LABEL[t.workflow] || t.workflow}</td><td>${t.uses_sprints ? 'Sí' : 'No'}</td><td>${t.active ? 'Activo' : 'Inactivo'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  const listsHtml = `<p class="hint">El <b>origen</b>, el <b>sector IT</b> y las horas por día para estimar se configuran en <a href="#/settings/portfolio">Origen, sector IT y horas</a>.</p>`;
  const r = {
    on_convert_status_id: null, on_start_status_id: null, on_finish_status_id: null, phase_rules: [], pause_sla: false, notify_contact_phase: false, notify_contact_finish: false,
    issues_done_note: true, issues_done_reopen: true, waiting_status_ids: null, issues_done_status_id: null, ...(hd.dev_rules || {}),
  };
  const phases = [...new Set(types.flatMap((t) => t.phases || []))];
  const statuses = state.meta.statuses.filter((x) => x.active);
  const sel = (name, value) => `<select class="input" name="${name}"><option value="">Mantener el estado actual</option>${options(statuses, value)}</select>`;
  const phaseRow = (pr, i) => `<div class="rule-row" data-pr="${i}"><span class="muted small nowrap">Al pasar a la fase</span>
    <input class="input sm" name="pr_phase" list="phaseNames" value="${esc(pr.phase || '')}" placeholder="Nombre de la fase">
    <span class="muted small nowrap">el ticket pasa a</span>
    <select class="input sm" name="pr_status">${options(statuses, pr.status_id)}</select>
    <button type="button" class="icon-btn sm" data-rmpr="${i}" aria-label="Quitar">${icon('x', 13)}</button></div>`;
  let phaseRules = [...(r.phase_rules || [])];
  // Sin configurar: cuentan como "en espera de desarrollo" los estados que se llaman así
  const waiting = Array.isArray(r.waiting_status_ids) ? r.waiting_status_ids : statuses.filter((x) => /espera.*desarrollo/i.test(x.name)).map((x) => x.id);
  body.innerHTML = `${typesCard}${listsHtml}<form class="card" data-form="dev">
    <h3>${icon('zap', 16)} Reglas ticket ↔ proyecto</h3>
    <p class="hint" style="margin-top:-6px">Cuando un ticket se convierte en proyecto, cada etapa es una épica. Estas reglas definen qué le pasa al ticket mientras avanza el proyecto. Si no configurás nada, el ticket mantiene su estado.</p>
    <datalist id="phaseNames">${phases.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <h4>Estado del ticket</h4>
    <div class="grid2">
      <label class="field"><span>Al convertir el ticket en proyecto</span>${sel('on_convert_status_id', r.on_convert_status_id)}</label>
      <label class="field"><span>Cuando arranca el desarrollo (primera tarea en curso)</span>${sel('on_start_status_id', r.on_start_status_id)}</label>
      <label class="field"><span>Cuando se completan todas las fases</span>${sel('on_finish_status_id', r.on_finish_status_id)}</label>
    </div>
    <div class="field"><span>Por fase (opcional)</span><div class="phase-rules"></div>
      <button type="button" class="btn sm" data-addpr>${icon('plus', 13)} Agregar regla por fase</button>
      <small class="hint">Ej.: al pasar a "Testing / UAT", el ticket pasa a "Pendiente" para que el solicitante pruebe. Si varias reglas aplican a la vez, gana la última (terminar &gt; fase &gt; arranque).</small></div>
    <h4>Otras reglas</h4>
    <label class="check"><input type="checkbox" name="pause_sla" ${r.pause_sla ? 'checked' : ''}> Pausar el SLA del ticket mientras el desarrollo está abierto (se reanuda al terminar, aunque el estado no pause)</label>
    <label class="check"><input type="checkbox" name="notify_contact_phase" ${r.notify_contact_phase ? 'checked' : ''}> Avisar al solicitante por correo cada vez que el desarrollo cambia de fase</label>
    <label class="check"><input type="checkbox" name="notify_contact_finish" ${r.notify_contact_finish ? 'checked' : ''}> Avisar al solicitante cuando termina el desarrollo</label>
    <p class="hint">El responsable del ticket recibe una notificación en la app en cada cambio de fase y al terminar. Las reglas solo se disparan en las transiciones, no en cada movimiento de tareas, y quedan registradas en las actividades del ticket.</p>
    <h4>Tareas vinculadas a un ticket (cierre de ciclo)</h4>
    <p class="hint" style="margin-top:-4px">Para tickets vinculados a una o más tareas de proyecto (botón “Vincular a tarea” del ticket). Se dispara cuando la última tarea vinculada pasa a Finalizado. Al usuario no se le responde solo: lo hace el agente después de validar.</p>
    <label class="check"><input type="checkbox" name="issues_done_note" ${r.issues_done_note ? 'checked' : ''}> Agregar una nota privada en el ticket y avisar al agente asignado <small class="muted">(si no tiene asignado, a sus seguidores)</small></label>
    <label class="check"><input type="checkbox" name="issues_done_reopen" ${r.issues_done_reopen ? 'checked' : ''}> Reabrir el ticket si estaba en espera de desarrollo</label>
    <div class="grid2">
      <div class="field"><span>Estados que significan “en espera de desarrollo”</span><div class="check-list">${statuses.map((x) => `<label class="check"><input type="checkbox" name="waiting_status" value="${x.id}" ${waiting.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div></div>
      <label class="field"><span>Al reabrir, el ticket pasa a</span><select class="input" name="issues_done_status_id"><option value="">El estado abierto por defecto</option>${options(statuses.filter((x) => x.kind === 'open'), r.issues_done_status_id)}</select></label>
    </div>
    <button class="btn primary">Guardar reglas</button>
  </form>`;
  const box = body.querySelector('.phase-rules');
  const read = () => { phaseRules = [...box.querySelectorAll('[data-pr]')].map((row) => ({ phase: row.querySelector('[name=pr_phase]').value.trim(), status_id: Number(row.querySelector('[name=pr_status]').value) || null })); };
  const draw = () => { box.innerHTML = phaseRules.map(phaseRow).join('') || '<p class="muted small">Sin reglas por fase.</p>'; };
  draw();
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-addpr]')) { read(); phaseRules.push({ phase: '', status_id: statuses[0]?.id }); draw(); }
    const rm = e.target.closest('[data-rmpr]');
    if (rm) { read(); phaseRules.splice(Number(rm.dataset.rmpr), 1); draw(); }
  });
  wireEditTables(body);
  body.addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-type]');
    if (tr || e.target.closest('[data-type-new]')) return typeForm(tr ? types.find((t) => t.id === Number(tr.dataset.type)) : null);
  });
  body.querySelector('form[data-form=dev]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    read();
    const n = (v) => (v ? Number(v) : null);
    try {
      await api('/admin/settings/helpdesk', {
        method: 'PUT',
        body: {
          dev_rules: {
            on_convert_status_id: n(f.on_convert_status_id.value), on_start_status_id: n(f.on_start_status_id.value), on_finish_status_id: n(f.on_finish_status_id.value),
            phase_rules: phaseRules.filter((x) => x.phase && x.status_id),
            pause_sla: f.pause_sla.checked, notify_contact_phase: f.notify_contact_phase.checked, notify_contact_finish: f.notify_contact_finish.checked,
            issues_done_note: f.issues_done_note.checked, issues_done_reopen: f.issues_done_reopen.checked,
            waiting_status_ids: [...f.querySelectorAll('[name=waiting_status]:checked')].map((x) => Number(x.value)), issues_done_status_id: n(f.issues_done_status_id.value),
          },
        },
      });
      await refreshMeta();
      toast('Reglas guardadas');
    } catch (er) { toastError(er); }
  });
}

function typeForm(t) {
  let phases = [...(t?.phases || ['Análisis', 'Ejecución', 'Cierre'])];
  const md = modal({
    title: t ? `Tipo: ${t.name}` : 'Nuevo tipo de proyecto',
    body: `<div class="grid2">
      <label class="field"><span>Nombre *</span><input class="input" name="name" value="${esc(t?.name || '')}" placeholder="Ej. Implementación de proveedor"></label>
      <label class="field"><span>Color</span><input class="input" type="color" name="color" value="${esc(t?.color || '#475569')}"></label>
    </div>
    <label class="field"><span>Descripción</span><input class="input" name="description" value="${esc(t?.description || '')}" placeholder="Cuándo se usa este tipo"></label>
    <div class="field"><span>Etapas (en orden)</span><div class="type-phases"></div><button type="button" class="btn sm" data-addph>${icon('plus', 13)} Agregar etapa</button></div>
    <div class="grid2">
      <label class="field"><span>Flujo de las tareas</span><select class="input" name="workflow">${Object.entries({ scrum: 'Scrum: Por hacer → En curso → En revisión → Hecho', kanban: 'Kanban', dev: 'Desarrollo: Backlog → Análisis → Desarrollo → Testing → Producción', simple: 'Simple: Pendiente → En curso → Hecho' }).map(([k, v]) => `<option value="${k}" ${(t?.workflow || 'simple') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Orden</span><input class="input" type="number" name="sort" value="${t?.sort ?? 99}"></label>
    </div>
    <label class="check"><input type="checkbox" name="uses_sprints" ${t ? (t.uses_sprints ? 'checked' : '') : ''}> Usa sprints y backlog (para desarrollos ágiles)</label>
    <label class="check"><input type="checkbox" name="is_default" ${t?.is_default ? 'checked' : ''}> Tipo predeterminado (se usa al convertir un ticket en proyecto)</label>
    ${t ? `<label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Activo</label>` : ''}
    <p class="hint">Los cambios valen para los proyectos nuevos; los que ya existen conservan sus etapas.</p>`,
    footer: `${t ? '<button class="btn danger ghost" data-del>Eliminar</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>`,
  });
  const box = md.el.querySelector('.type-phases');
  const read = () => { phases = [...box.querySelectorAll('input')].map((i) => i.value); };
  const draw = () => {
    box.innerHTML = phases.map((p, i) => `<div class="phase-row" data-i="${i}"><span class="ph-num">${i + 1}</span><input class="input sm grow" value="${esc(p)}" placeholder="Nombre de la etapa">
      <button type="button" class="icon-btn sm" data-up ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('up', 13)}</button><button type="button" class="icon-btn sm" data-rm aria-label="Quitar">${icon('x', 13)}</button></div>`).join('');
  };
  draw();
  md.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-addph]')) { read(); phases.push(''); draw(); box.querySelector('.phase-row:last-child input').focus(); return; }
    const row = e.target.closest('.phase-row');
    if (row) {
      read();
      const i = Number(row.dataset.i);
      if (e.target.closest('[data-rm]')) { phases.splice(i, 1); draw(); }
      if (e.target.closest('[data-up]') && i > 0) { [phases[i - 1], phases[i]] = [phases[i], phases[i - 1]]; draw(); }
      return;
    }
    if (e.target.closest('[data-del]')) {
      if (!(await confirmDialog(`¿Eliminar el tipo "${t.name}"? Los proyectos que lo usan quedan sin tipo. Si ya no se usa, conviene desactivarlo.`, { danger: true, okText: 'Eliminar' }))) return;
      try { await api(`/admin/project-types/${t.id}`, { method: 'DELETE' }); md.close(); await refreshMeta(); reloadSection(); } catch (er) { toastError(er); }
      return;
    }
    if (!e.target.closest('[data-ok]')) return;
    read();
    const g = (n) => md.el.querySelector(`[name=${n}]`);
    const list = phases.map((x) => x.trim()).filter(Boolean);
    if (!list.length) return toast('Agregá al menos una etapa', 'error');
    const payload = {
      name: g('name').value.trim(), color: g('color').value, description: g('description').value.trim(), phases: list, workflow: g('workflow').value,
      sort: Number(g('sort').value) || 0, uses_sprints: g('uses_sprints').checked, is_default: g('is_default').checked,
    };
    if (t) payload.active = g('active').checked;
    try {
      await api(t ? `/admin/project-types/${t.id}` : '/admin/project-types', { method: t ? 'PATCH' : 'POST', body: payload });
      md.close();
      await refreshMeta();
      toast('Tipo guardado');
      reloadSection();
    } catch (er) { toastError(er); }
  });
}

// ---------- Importar datos: tickets de Desk365 ----------
async function importData(body) {
  body.innerHTML = `<div class="card">
    <h3>${icon('upload', 16)} Tickets de Desk365</h3>
    <p class="hint" style="margin-top:-6px">Trae los tickets con su <b>número original</b>, asunto, descripción, estado, prioridad, origen, grupo, agente, área, tipo y fechas. Los tickets nuevos siguen numerándose después del más alto. Se puede repetir: los que ya se importaron se actualizan, no se duplican. No se mandan correos ni se aplican reglas.</p>
    <ol class="small steps">
      <li>En Desk365, abrí <b>Todos los tickets</b> → <b>Exportar</b>, elegí <i>Hora de creación</i> y un rango que abarque todos.</li>
      <li>Tildá <b>todos</b> los campos del ticket y, en <b>Campos del contacto</b>, al menos <b>Nombre</b> y <b>Correo electrónico</b> (sin eso, los tickets quedan con un solicitante genérico).</li>
      <li>Si tenés tickets archivados, exportalos también desde la vista de archivados.</li>
      <li>Subí acá el CSV que te llega por correo. Primero vas a ver una vista previa.</li>
    </ol>
    <div class="row gap wrap"><label class="btn primary">${icon('upload', 14)} Elegir archivo (.csv o .xlsx)<input type="file" accept=".csv,.xlsx,text/csv" hidden data-dfile></label></div>
    <div data-dprev></div>
    <p class="hint">La exportación de Desk365 no incluye las respuestas ni las notas de cada ticket: cada ticket importado tiene una nota interna con la cantidad de conversaciones que tenía, para que sepas cuáles revisar.</p>
  </div>`;
  const pv = body.querySelector('[data-dprev]');
  let payload = null;
  body.querySelector('[data-dfile]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast('El archivo supera 4 MB', 'error');
    pv.innerHTML = '<div class="loading"><span class="spinner"></span> Leyendo el archivo…</div>';
    const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(file); });
    payload = { filename: file.name, data: b64 };
    try {
      const plan = await api('/admin/import/desk365', { method: 'POST', body: { ...payload, dry: true } });
      const n = (a) => plan.rows.filter((r) => r.action === a).length;
      const generic = plan.rows.filter((r) => r.fields.contact?.how === 'placeholder').length;
      const created = [...plan.create_options.area.map((x) => `Área: ${x}`), ...plan.create_options.type.map((x) => `Tipo: ${x}`)];
      const ST = { open: '#2563eb', pending: '#d97706', resolved: '#059669', closed: '#475569' };
      pv.innerHTML = `${!plan.contact_columns ? `<div class="callout warn">${icon('alert', 16)} <div>El archivo <b>no trae el solicitante</b> (nombre y correo del contacto). Si importás así, los ${generic} tickets quedan con un solicitante genérico y no se les puede responder por correo hasta cambiarlo. Te conviene exportar de nuevo tildando los campos del contacto.</div></div>` : generic ? `<div class="callout warn">${icon('alert', 16)} ${generic} ticket(s) sin solicitante identificable: quedan con uno genérico.</div>` : ''}
        <div class="imp-sum"><span class="badge" style="--c:#059669">${n('create')} nuevos</span> <span class="badge" style="--c:#2563eb">${n('update')} se actualizan</span> ${n('skip') ? `<span class="badge" style="--c:#9ca3af">${n('skip')} se omiten</span>` : ''}
          ${created.length ? `<span class="muted small">Se crean: ${esc(created.join(' · '))}</span>` : ''}</div>
        <div class="table-wrap imp-table"><table class="tbl compact"><thead><tr><th>#</th><th></th><th>Asunto</th><th>Estado</th><th>Prioridad</th><th>Categoría técnica</th><th>Agente</th><th>Área</th><th>Solicitante</th><th>Creado</th><th>Avisos</th></tr></thead><tbody>
        ${plan.rows.map((r) => `<tr class="${r.action === 'skip' ? 'inactive' : ''}"><td><b>${esc(r.number ?? '')}</b></td>
          <td>${r.action === 'create' ? '<span class="badge" style="--c:#059669">Nuevo</span>' : r.action === 'update' ? '<span class="badge" style="--c:#2563eb">Actualiza</span>' : '<span class="badge">Se omite</span>'}</td>
          <td style="min-width:260px">${esc(r.subject || '')}</td><td>${r.fields.status ? `<span class="badge" style="--c:${ST[r.fields.status.kind] || '#475569'}">${esc(r.fields.status.name)}</span>` : '—'}</td>
          <td class="small">${r.fields.priority ? PRIORITY[r.fields.priority] : '—'}</td><td class="small">${esc(r.fields.tech?.name || '—')}${r.fields.subtech ? ` › ${esc(r.fields.subtech.name)}` : ''}</td><td class="small">${esc(r.fields.assignee?.name || '—')}</td>
          <td class="small">${esc(r.fields.category?.name || '—')}</td><td class="small">${r.fields.contact ? (r.fields.contact.how === 'placeholder' ? '<span class="warn-text">Genérico</span>' : esc(r.fields.contact.name || r.fields.contact.email)) : '—'}</td>
          <td class="small nowrap">${r.fields.created_at ? fmtDateTimeShort(r.fields.created_at) : '—'}</td>
          <td class="small warn-text">${esc(r.warnings.filter((w) => !/solicitante genérico|no trae el solicitante/.test(w)).join(' · '))}</td></tr>`).join('')}</tbody></table></div>
        <div class="row gap" style="margin-top:12px"><span class="grow"></span><button class="btn primary" data-dok ${n('create') + n('update') ? '' : 'disabled'}>Importar ${n('create') + n('update')} ticket(s)</button></div>`;
    } catch (er) {
      pv.innerHTML = `<div class="callout warn">${icon('alert', 16)} ${esc(er.message)}</div>`;
    }
  });
  pv.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dok]');
    if (!b || !payload) return;
    b.disabled = true;
    try {
      const r = await api('/admin/import/desk365', { method: 'POST', body: { ...payload, dry: false } });
      await refreshMeta();
      pv.innerHTML = `<div class="callout ok">${icon('check', 16)} <div>Listo: <b>${r.created}</b> tickets nuevos y <b>${r.updated}</b> actualizados. El próximo ticket va a ser el <b>#${r.next_number}</b>. <a href="#/tickets?tag=desk365">Ver los tickets importados</a></div></div>`;
      toast('Importación terminada');
    } catch (er) { toastError(er); b.disabled = false; }
  });
}
const fmtDateTimeShort = (d) => new Date(d).toLocaleString('es-AR', { timeZone: state.meta?.helpdesk?.timezone || 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

import { aging, ai, m365 } from './settings-v14.js';

// ---------- Portfolio: origen, sector IT y horas para estimar ----------
async function portfolioLists(body) {
  const [hd, opts, usage] = await Promise.all([api('/admin/settings/helpdesk'), api('/admin/portfolio-options'), api('/admin/portfolio-options/usage')]);
  const PALETTE = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#0891b2', '#C8102E', '#64748b'];
  const optTable = (kind, title, hint) => {
    const rows = opts.filter((o) => o.kind === kind);
    return `<div class="card"><h3>${title}</h3><p class="hint">${hint}</p>
    <div class="table-wrap"><table class="tbl compact edit-tbl pf-opt-tbl" data-table="portfolio-options"><thead><tr><th>Nombre</th><th>Color</th><th>Activo</th><th>Orden</th><th class="num">Proyectos</th><th></th></tr></thead><tbody>
    ${rows.map((o) => `<tr data-id="${o.id}" class="${o.active ? '' : 'inactive'}"><td><input class="input sm" name="name" value="${esc(o.name)}" maxlength="80" aria-label="Nombre"></td><td><input type="color" name="color" value="${esc(o.color || '#64748b')}" aria-label="Color"></td>
      <td><input type="checkbox" name="active" ${o.active ? 'checked' : ''} aria-label="Activo"></td><td><input class="input sm" type="number" min="0" name="sort" value="${o.sort}" style="width:64px" aria-label="Orden"></td>
      <td class="num">${usage[o.id] || 0}</td>
      <td class="row nowrap"><button class="btn sm" data-save>Guardar</button>${usage[o.id] ? `<button class="icon-btn sm" disabled title="En uso: desactivalo para que no se ofrezca más">${icon('trash', 13)}</button>` : `<button class="icon-btn sm" data-del title="Eliminar">${icon('trash', 13)}</button>`}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted small">Sin valores todavía.</td></tr>'}
    </tbody></table></div>
    <form class="row gap opt-add" data-addopt="${kind}"><input class="input sm grow" name="name" maxlength="80" placeholder="${kind === 'origin' ? 'Nuevo origen (ej. OKR 2027)' : 'Nuevo sector (ej. Sistemas | Desarrollo)'}" required>
      <input type="color" name="color" value="${PALETTE[rows.length % PALETTE.length]}" aria-label="Color"><button class="btn sm primary">${icon('plus', 13)} Agregar</button></form></div>`;
  };
  body.innerHTML = `<div class="pf-lists">${optTable('origin', 'Origen de los proyectos', 'De dónde sale cada proyecto: OKR del año, mejora evolutiva, oportunidad de negocio, normativa… Es obligatorio al convertir un ticket en proyecto.')}
    ${optTable('sector', 'Sector IT', 'Qué parte del equipo de IT lo lleva adelante. Es obligatorio al convertir un ticket en proyecto.')}</div>
    <p class="hint">Un valor desactivado deja de ofrecerse pero se mantiene en los proyectos que ya lo usan. Solo se pueden eliminar los que no usa ningún proyecto. El <b>área solicitante</b> usa las categorías de los tickets (<a href="#/settings/fields">Campos del ticket</a>).</p>
    <form class="card" data-form="hours">
      <h3>${icon('clock', 16)} Horas de los proyectos</h3>
      <p class="hint" style="margin-top:-6px">Al crear un proyecto (o convertir un ticket), las horas estimadas se calculan solas: <b>días hábiles</b> entre el inicio y el fin × <b>horas por día</b>. Los días hábiles y los feriados son los del horario de atención (<a href="#/settings/general">General</a>). Las horas se pueden corregir a mano en cada proyecto.</p>
      <div class="grid2">
        <label class="field"><span>Horas por día hábil para estimar</span><input class="input" type="number" name="portfolio_day_hours" min="0.5" max="24" step="0.5" value="${esc(hd.portfolio_day_hours ?? 8)}"></label>
        <label class="field"><span>Capacidad para proyectos por persona por mes (h)</span><input class="input" type="number" name="portfolio_month_hours" min="1" max="744" step="1" value="${esc(hd.portfolio_month_hours ?? 80)}"><small class="hint">La usa el calendario del roadmap para marcar sobrecarga.</small></label>
      </div>
      <button class="btn primary">Guardar</button>
    </form>`;
  wireEditTables(body);
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.dataset.addopt) {
        const name = f.querySelector('[name=name]').value.trim();
        if (!name) return;
        await api('/admin/portfolio-options', { method: 'POST', body: { kind: f.dataset.addopt, name, color: f.querySelector('[name=color]').value, sort: 99 } });
        await refreshMeta();
        toast(`${f.dataset.addopt === 'origin' ? 'Origen' : 'Sector'} agregado`);
        reloadSection();
      } else if (f.dataset.form === 'hours') {
        const day = Number(f.portfolio_day_hours.value);
        const month = Math.round(Number(f.portfolio_month_hours.value));
        if (!(day >= 0.5 && day <= 24)) return toast('Las horas por día van de 0,5 a 24', 'error');
        await api('/admin/settings/helpdesk', { method: 'PUT', body: { portfolio_day_hours: day, portfolio_month_hours: month } });
        await refreshMeta();
        toast('Guardado');
      }
    } catch (er) { toastError(er); }
  });
}

const RENDER = { general, agents, fields, sla, rules, canned, channels, superadmin, database: dbAdmin, dev, portfolio: portfolioLists, aging, ai, m365, import: importData };
