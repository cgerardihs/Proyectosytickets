import {
  state, api, esc, icon, avatar, toast, toastError, modal, popover, relTime, navigate, applyBrand, isManager, isAdmin, debounce, parseHashQuery,
} from './core.js';

const view = () => document.getElementById('view');
let cleanup = null;

const ROUTES = [
  [/^#?\/?$/, 'home', () => import('./views/dashboard.js')],
  [/^#\/tickets\/(\d+)$/, 'tickets', () => import('./views/ticket.js')],
  [/^#\/tickets$/, 'tickets', () => import('./views/tickets.js')],
  [/^#\/my-work$/, 'mywork', () => import('./views/mywork.js')],
  [/^#\/projects$/, 'projects', () => import('./views/projects.js')],
  [/^#\/portfolio$/, 'portfolio', () => import('./views/portfolio.js')],
  [/^#\/projects\/([A-Za-z0-9]+)(?:\/(\w+))?$/, 'projects', () => import('./views/project.js')],
  [/^#\/issue\/([A-Za-z0-9]+-\d+)$/, 'projects', () => import('./views/issue.js')],
  [/^#\/contacts(?:\/(\d+))?$/, 'contacts', () => import('./views/contacts.js')],
  [/^#\/companies(?:\/(\d+))?$/, 'contacts', () => import('./views/contacts.js')],
  [/^#\/kb(?:\/(\w+))?$/, 'kb', () => import('./views/kb.js')],
  [/^#\/reports$/, 'reports', () => import('./views/reports.js')],
  [/^#\/settings(?:\/([\w-]+))?$/, 'settings', () => import('./views/settings.js')],
  [/^#\/profile$/, 'profile', () => import('./views/profile.js')],
];

export function setCrumbs(items) {
  const el = document.getElementById('crumbs');
  if (!el) return;
  el.innerHTML = items
    .map((c, i) => (c.href && i < items.length - 1 ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`))
    .join(`<span class="sep">›</span>`);
}

export async function refreshMeta() {
  state.meta = await api('/meta');
  state.me = state.meta.me;
  applyBrand(state.meta.brand);
  renderRailBrand();
  return state.meta;
}

function renderRailBrand() {
  const el = document.querySelector('.rail-logo');
  if (!el || !state.meta) return;
  const b = state.meta.brand || {};
  el.innerHTML = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name || '')}">` : '<span class="rail-iso"><img src="/brand/isotipo.svg" alt=""></span>';
  el.title = `${b.name || ''} · ${b.product || 'Mesa de Ayuda'}`;
}

async function route() {
  if (!state.me) return;
  const hash = location.hash.split('?')[0] || '#/';
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  for (const [re, nav, load] of ROUTES) {
    const m = re.exec(hash);
    if (!m) continue;
    document.querySelectorAll('.rail a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    // Contenedor nuevo en cada navegación: así no se acumulan listeners entre vistas.
    const el = document.createElement('main');
    el.id = 'view';
    el.className = 'view';
    view().replaceWith(el);
    el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    try {
      const mod = await load();
      const r = await mod.render(el, m.slice(1), parseHashQuery());
      if (typeof r === 'function') cleanup = r;
    } catch (e) {
      if (e?.status === 401) return;
      el.innerHTML = `<div class="page"><div class="empty">${icon('alert', 36)}<h4>No se pudo cargar</h4><p>${esc(e.message)}</p></div></div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  view().innerHTML = `<div class="page"><div class="empty">${icon('alert', 36)}<h4>Página inexistente</h4><p><a href="#/">Volver al inicio</a></p></div></div>`;
}

function shell() {
  document.getElementById('app').innerHTML = `
  <div class="layout">
    <nav class="rail" aria-label="Navegación principal">
      <a class="rail-logo" href="#/"></a>
      <a data-nav="home" href="#/" title="Inicio">${icon('home', 20)}<span>Inicio</span></a>
      <a data-nav="tickets" href="#/tickets" title="Tickets">${icon('ticket', 20)}<span>Tickets</span></a>
      <a data-nav="mywork" href="#/my-work" title="Mi trabajo">${icon('mywork', 20)}<span>Mi trabajo</span></a>
      <a data-nav="projects" href="#/projects" title="Proyectos">${icon('projects', 20)}<span>Proyectos</span></a>
      ${state.meta.canPortfolio ? `<a data-nav="portfolio" href="#/portfolio" title="Portfolio y roadmap">${icon('portfolio', 20)}<span>Portfolio</span></a>` : ''}
      <a data-nav="contacts" href="#/contacts" title="Contactos">${icon('users', 20)}<span>Contactos</span></a>
      <a data-nav="kb" href="#/kb" title="Base de conocimiento">${icon('book', 20)}<span>Artículos</span></a>
      ${isManager() ? `<a data-nav="reports" href="#/reports" title="Informes">${icon('chart', 20)}<span>Informes</span></a>` : ''}
      <span class="rail-space"></span>
      <a href="/portal" target="_blank" rel="noopener" title="Portal de soporte">${icon('globe', 20)}<span>Portal</span></a>
      ${isAdmin() ? `<a data-nav="settings" href="#/settings" title="Configuración">${icon('settings', 20)}<span>Config.</span></a>` : ''}
    </nav>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn mobile-only" id="railToggle" aria-label="Menú">${icon('menu')}</button>
        <div class="crumbs" id="crumbs"></div>
        <div class="top-actions">
          <div class="gsearch">${icon('search', 16)}<input id="gsearch" placeholder="Buscar #ticket, CLAVE-123 o texto" autocomplete="off" aria-label="Búsqueda global"></div>
          <button class="btn primary" id="btnNew">${icon('plus', 16)}<span>Nuevo</span></button>
          <button class="icon-btn bell" id="btnBell" aria-label="Notificaciones">${icon('bell', 20)}<b class="dot" hidden></b></button>
          <button class="me-btn" id="btnMe" aria-label="Mi cuenta">${avatar(state.me, 30, false)}</button>
        </div>
      </header>
      <div id="banner"></div>
      <main id="view" class="view"></main>
    </div>
  </div>`;
  renderRailBrand();

  document.getElementById('railToggle').addEventListener('click', () => document.querySelector('.layout').classList.toggle('rail-open'));
  document.querySelector('.rail').addEventListener('click', (e) => { if (e.target.closest('a')) document.querySelector('.layout').classList.remove('rail-open'); });

  document.getElementById('btnNew').addEventListener('click', (e) => {
    popover(e.currentTarget, `
      <button class="menu-item" data-value="ticket">${icon('ticket', 16)} Ticket</button>
      <button class="menu-item" data-value="issue">${icon('checkbox', 16)} Tarea de proyecto</button>
      <button class="menu-item" data-value="project">${icon('projects', 16)} Proyecto</button>
      <button class="menu-item" data-value="contact">${icon('user', 16)} Contacto</button>
      <button class="menu-item" data-value="article">${icon('book', 16)} Artículo</button>`, {
      align: 'right',
      onClick: async (v) => {
        if (v === 'ticket') (await import('./views/tickets.js')).openNewTicket();
        if (v === 'issue') (await import('./views/issue.js')).openCreateIssue({});
        if (v === 'project') (await import('./views/projects.js')).openNewProject();
        if (v === 'contact') (await import('./views/contacts.js')).openContactForm();
        if (v === 'article') navigate('#/kb/new');
      },
    });
  });

  document.getElementById('btnMe').addEventListener('click', (e) => {
    popover(e.currentTarget, `
      <div class="menu-head">${avatar(state.me, 34, false)}<div><b>${esc(state.me.name)}</b><small>${esc(state.me.email)}</small>${state.me.role === 'superadmin' ? '<span class="badge super-badge">Superadmin</span>' : ''}</div></div>
      <button class="menu-item" data-value="profile">${icon('user', 16)} Mi perfil y firma</button>
      <button class="menu-item" data-value="logout">${icon('logout', 16)} Cerrar sesión</button>`, {
      align: 'right',
      onClick: async (v) => {
        if (v === 'profile') navigate('#/profile');
        if (v === 'logout') {
          await api('/auth/logout', { method: 'POST' }).catch(() => {});
          location.hash = '#/';
          location.reload();
        }
      },
    });
  });

  document.getElementById('btnBell').addEventListener('click', openNotifications);

  const gs = document.getElementById('gsearch');
  gs.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const v = gs.value.trim();
    if (!v) return;
    if (/^#?\d+$/.test(v)) return navigate(`#/tickets/${v.replace('#', '')}`);
    if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(v)) return navigate(`#/issue/${v.toUpperCase()}`);
    navigate(`#/tickets?view=all&q=${encodeURIComponent(v)}`);
  });
  gs.addEventListener('input', debounce(async () => {
    const v = gs.value.trim();
    if (v.length < 3 || /^#?\d+$/.test(v)) return;
    try {
      const [t, i] = await Promise.all([api(`/tickets?view=all&limit=6&q=${encodeURIComponent(v)}`), api(`/issues/search?q=${encodeURIComponent(v)}`)]);
      if (document.activeElement !== gs) return;
      const html = [
        ...t.items.map((x) => `<a class="menu-item" href="#/tickets/${x.number}">${icon('ticket', 14)} <b>#${x.number}</b> ${esc(x.subject)}</a>`),
        ...i.slice(0, 6).map((x) => `<a class="menu-item" href="#/issue/${esc(x.key)}">${icon('checkbox', 14)} <b>${esc(x.key)}</b> ${esc(x.title)}</a>`),
      ].join('');
      if (html) {
        const p = popover(gs, `<div class="search-results">${html}</div>`);
        p.el.addEventListener('click', () => { p.close(); gs.value = ''; });
      }
    } catch { /* */ }
  }, 350));
}

async function openNotifications(e) {
  const anchor = e.currentTarget;
  const data = await api('/notifications').catch(() => ({ items: [], unread: 0 }));
  const html = data.items.length
    ? data.items.map((n) => `<a class="notif ${n.read_at ? '' : 'unread'}" href="${esc(n.link || '#/')}" data-id="${n.id}"><b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ''}<small>${relTime(n.created_at)}</small></a>`).join('')
    : '<p class="muted small" style="padding:16px">No tenés notificaciones.</p>';
  const p = popover(anchor, `<div class="notif-head"><b>Notificaciones</b>${data.unread ? '<button class="link-btn" data-readall>Marcar todo como leído</button>' : ''}</div><div class="notif-list">${html}</div>`, { align: 'right' });
  p.el.classList.add('notif-pop');
  p.el.querySelector('[data-readall]')?.addEventListener('click', async () => {
    await api('/notifications/read', { method: 'POST', body: {} });
    p.close();
    pollNotifications();
  });
  p.el.addEventListener('click', async (ev) => {
    const a = ev.target.closest('.notif');
    if (!a) return;
    p.close();
    await api('/notifications/read', { method: 'POST', body: { ids: [Number(a.dataset.id)] } }).catch(() => {});
    pollNotifications();
  });
}

async function pollNotifications() {
  if (document.hidden || !state.me) return;
  try {
    const d = await api('/notifications');
    state.unread = d.unread;
    const dot = document.querySelector('#btnBell .dot');
    if (dot) { dot.hidden = !d.unread; dot.textContent = d.unread > 9 ? '9+' : String(d.unread); }
  } catch { /* */ }
}

function forcePasswordChange() {
  const m = modal({
    title: 'Elegí una clave nueva',
    dismissable: false,
    body: `<p class="muted">Un administrador te asignó una clave temporal. Definí la tuya para continuar.</p>
      <label class="field"><span>Clave nueva (mín. 10 caracteres)</span><input class="input" type="password" name="p1" autocomplete="new-password"></label>
      <label class="field"><span>Repetila</span><input class="input" type="password" name="p2" autocomplete="new-password"></label>`,
    footer: '<button class="btn primary" data-ok>Guardar</button>',
  });
  m.el.querySelector('.modal-head [data-close]')?.remove();
  m.el.querySelector('[data-ok]').addEventListener('click', async () => {
    const p1 = m.el.querySelector('[name=p1]').value;
    if (p1 !== m.el.querySelector('[name=p2]').value) return toast('Las claves no coinciden', 'error');
    try {
      await api('/me/password', { method: 'POST', body: { password: p1 } });
      state.me.must_change_password = false;
      m.close();
      toast('Clave actualizada');
    } catch (e) { toastError(e); }
  });
}

async function boot() {
  const app = document.getElementById('app');
  let status;
  try {
    status = await api('/setup/status');
  } catch (e) {
    app.innerHTML = `<div class="center-box"><h2>No se pudo conectar</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (status.needsSetup) {
    const { renderSetup } = await import('./views/auth.js');
    return renderSetup(app, status);
  }
  const me = await api('/auth/me');
  if (!me.user) {
    const { renderLogin } = await import('./views/auth.js');
    return renderLogin(app, me, parseHashQuery());
  }
  state.me = me.user;
  state.passkeys = Boolean(me.passkeys);
  await refreshMeta();
  shell();
  if (me.needsMigration && isAdmin()) {
    document.getElementById('banner').innerHTML = `<div class="banner">Hay una actualización de la base de datos pendiente. <button class="btn sm" id="btnMigrate">Actualizar ahora</button></div>`;
    document.getElementById('btnMigrate').addEventListener('click', async () => {
      try { await api('/admin/migrate', { method: 'POST' }); toast('Base actualizada'); document.getElementById('banner').innerHTML = ''; } catch (e) { toastError(e); }
    });
  }
  if (state.me.must_change_password) forcePasswordChange();
  window.addEventListener('hashchange', route);
  // Imagen externa bloqueada (correo o descripción): un clic sobre ella la carga, sin Referer
  document.addEventListener('click', (e) => {
    const img = e.target.closest?.('img.remote-img[data-remote-src]');
    if (!img) return;
    img.referrerPolicy = 'no-referrer';
    img.src = img.dataset.remoteSrc;
    img.removeAttribute('data-remote-src');
    img.classList.remove('remote-img');
  });
  await route();
  pollNotifications();
  setInterval(pollNotifications, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotifications(); });
}

window.addEventListener('session-expired', () => {
  if (!state.me) return;
  state.me = null;
  toast('Tu sesión venció. Ingresá de nuevo.', 'error');
  setTimeout(() => location.reload(), 1200);
});

boot();
