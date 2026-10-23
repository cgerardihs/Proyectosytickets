// Portal público: crear tickets, seguirlos y leer artículos.
import { esc, icon, sanitize, toast, toastError, readFiles, fmtSize, fmtDateTime, relTime, applyBrand } from './core.js';

const root = document.getElementById('portal');
let cfg = null;

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

async function papi(path, body, { key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`/api${path}`, body !== undefined ? { method: 'POST', headers, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.error || `Error ${res.status}`;
    const wait = Number(res.headers.get('Retry-After'));
    if (res.status === 429 && wait) msg += ` (podés reintentar en ${wait > 90 ? `${Math.ceil(wait / 60)} min` : `${wait} s`})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function storeToken(number, token) {
  try {
    const all = JSON.parse(localStorage.getItem('portal-tickets') || '{}');
    all[number] = token;
    localStorage.setItem('portal-tickets', JSON.stringify(all));
  } catch { /* */ }
}
function storedTickets() {
  try { return JSON.parse(localStorage.getItem('portal-tickets') || '{}'); } catch { return {}; }
}

const MS_LOGO = '<svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';
/** Ingreso con Microsoft: vuelve a la pantalla actual (ej. el enlace de un ticket que llegó por correo). */
const msStart = () => {
  const here = location.hash && !/^#\/(ingresar|$)/.test(location.hash) ? location.hash : '#/';
  return `/api/auth/ms/start?portal=1&next=${encodeURIComponent(here.slice(0, 1500))}`;
};
/** ¿Hace falta ingresar? (acceso solo con Microsoft y sin sesión) */
const needsLogin = () => cfg.access === 'microsoft' && !cfg.me;
const part = (k) => cfg.parts?.[k] !== false;
const ST_COLOR = { open: '#2563eb', pending: '#d97706', resolved: '#059669', closed: '#6b7280' };
const ST_HINT = {
  open: 'La mesa de ayuda está trabajando en su solicitud.',
  pending: 'Está en espera: puede que necesitemos una respuesta suya.',
  resolved: 'Lo dimos por resuelto. Si no está de acuerdo, responda y se reabre.',
  closed: 'El ticket está cerrado.',
};
const stBadge = (name, kind) => `<span class="badge" style="--c:${ST_COLOR[kind] || '#6b7280'}">${esc(name || '')}</span>`;
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Encabezado: quién ingresó (o el botón para ingresar con Microsoft). */
function renderSession() {
  const box = document.getElementById('pSession');
  if (!box) return;
  if (cfg.me) {
    box.innerHTML = `<span class="p-me" title="${esc(cfg.me.email)}">${icon('user', 15)} ${esc(cfg.me.name || cfg.me.email)}</span><button type="button" class="btn sm" data-logout>Salir</button>`;
    box.querySelector('[data-logout]').addEventListener('click', async () => {
      try { await papi('/portal/logout', {}); } catch { /* igual se limpia la pantalla */ }
      cfg.me = null;
      renderSession();
      toast('Cerró la sesión');
      if (location.hash === '#/' || !location.hash) route(); else location.hash = '#/';
    });
  } else {
    box.innerHTML = cfg.microsoft && !needsLogin() ? `<a class="btn sm p-ms" href="${msStart()}">${MS_LOGO} Ingresar</a>` : '';
  }
  // Menú: solo las partes habilitadas, y nada hasta ingresar si el acceso es con Microsoft
  document.querySelectorAll('.p-top nav [data-part]').forEach((a) => { a.hidden = needsLogin() || !part(a.dataset.part); });
}

/** Pantalla de ingreso: el portal es solo para la gente de la empresa, con su cuenta de Microsoft. */
function loginGate(query = new URLSearchParams()) {
  const err = query.get('error');
  root.innerHTML = `<section class="p-gate">
    <div class="p-gate-card">
      <div class="p-gate-logo">${document.querySelector('.p-logo')?.innerHTML || ''}</div>
      <h1>${esc(cfg.title || 'Centro de ayuda')}</h1>
      <p class="muted">Para crear y seguir sus pedidos a la mesa de ayuda, ingrese con su cuenta de la empresa.</p>
      ${err ? `<p class="callout danger">${icon('alert', 16)} <span><b>No se pudo ingresar con Microsoft.</b> ${esc(err.slice(0, 200))}</span></p>` : ''}
      ${cfg.microsoft ? `<a class="btn primary p-ms-btn p-gate-btn" href="${msStart()}">${MS_LOGO} Ingresar con Microsoft</a>`
        : `<p class="callout warn">${icon('alert', 16)} <span>El ingreso con Microsoft todavía no está configurado. ${cfg.support_email ? `Mientras tanto, escríbanos a <b>${esc(cfg.support_email)}</b>.` : 'Avísele a la mesa de ayuda.'}</span></p>`}
      <small class="muted">Solo cuentas de ${esc(cfg.brand?.name || 'la empresa')}. Ve únicamente sus propios tickets.</small>
    </div>
  </section>`;
}

/** Consulta rápida: número de ticket (+ correo si no ingresó) → estado. */
function lookupBox(prefill = '') {
  let saved = '';
  try { saved = JSON.parse(localStorage.getItem('portal-me') || '{}').email || ''; } catch { /* */ }
  return `<section class="p-lookup" data-lookup-box>
    <div class="p-lookup-head">${icon('search', 20)}<div><h2>Consultar el estado de un ticket</h2>
      <p class="muted">${cfg.me ? 'Ingrese el número de ticket.' : 'Ingrese el número de ticket y el correo con el que lo abrió.'}</p></div></div>
    <form class="p-lookup-form" data-lookup novalidate>
      <label class="field"><span>Nº de ticket</span><input class="input" name="number" inputmode="numeric" autocomplete="off" placeholder="Ej. 1234" value="${esc(prefill)}" required></label>
      ${cfg.me ? '' : `<label class="field grow"><span>Correo</span><input class="input" name="email" type="email" autocomplete="email" placeholder="nombre@hanseatica.com" value="${esc(saved)}" required></label>`}
      <button class="btn primary">Consultar</button>
    </form>
    <div data-lookup-out aria-live="polite"></div>
  </section>`;
}

function bindLookup(scope) {
  const f = scope.querySelector('[data-lookup]');
  const out = scope.querySelector('[data-lookup-out]');
  if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const number = String(f.number.value).replace(/\D/g, '');
    if (!number) { f.number.focus(); return toast('Escriba el número de ticket', 'error'); }
    const email = f.email ? f.email.value.trim() : '';
    if (f.email && !f.email.checkValidity()) { f.email.focus(); return toast('Escriba el correo con el que abrió el ticket', 'error'); }
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      const r = await papi('/portal/lookup', { number: Number(number), email });
      out.innerHTML = lookupResult(r);
    } catch (er) {
      out.innerHTML = `<div class="p-lk-empty">${icon('alert', 18)} ${esc(er.message)}</div>`;
    } finally { btn.disabled = false; }
  });
}

function lookupResult(t) {
  const next = t.can_open ? `<a class="btn" href="#/t/${t.number}">Responder o adjuntar ${icon('right', 14)}</a>`
    : cfg.microsoft && !cfg.me ? `Para responder o descargar adjuntos, <a href="${msStart()}">ingrese con su cuenta de Microsoft</a> o use el enlace “Ver el ticket” del correo.`
      : 'Para responder o descargar adjuntos, use el enlace “Ver el ticket” que recibió por correo, o responda ese correo.';
  const msgs = t.messages || [];
  return `<div class="p-lk-res">
    <div class="p-lk-top"><div class="grow">${t.subject ? `<small class="muted">Ticket #${t.number}</small><b>${esc(t.subject)}</b>` : `<b>Ticket #${t.number}</b>`}</div>${stBadge(t.status, t.status_kind)}</div>
    ${ST_HINT[t.status_kind] ? `<p class="p-lk-hint">${ST_HINT[t.status_kind]}</p>` : ''}
    ${t.merged_into ? `<p class="callout">Este ticket se unificó con el #${t.merged_into}. Las novedades siguen en ese ticket.</p>` : ''}
    <dl class="p-lk-meta">
      <div><dt>Creado</dt><dd>${fmtDay(t.created_at)}</dd></div>
      <div><dt>Última novedad</dt><dd>${relTime(t.updated_at)}</dd></div>
      ${t.last_reply_at ? `<div><dt>Última respuesta de la mesa</dt><dd>${relTime(t.last_reply_at)}</dd></div>` : ''}
      ${t.resolved_at ? `<div><dt>Resuelto</dt><dd>${fmtDay(t.resolved_at)}</dd></div>` : ''}
    </dl>
    ${(t.development || []).map((p) => `<div class="p-lk-dev"><span>${esc(p.name || 'Avance del desarrollo')}</span><span class="progress"><span style="width:${p.progress}%"></span></span><b>${p.finished ? 'Finalizado' : `${p.progress}%`}</b></div>`).join('')}
    ${msgs.length ? `<h3 class="p-lk-conv">Conversación <small class="muted">${msgs.length} mensaje${msgs.length === 1 ? '' : 's'}</small></h3>
    <div class="thread p-lk-thread">${msgs.map((m) => `<article class="msg ${m.kind === 'reply' ? 'reply' : 'customer'} ${m.auto ? 'auto' : ''}"><div class="msg-body">
      <header><b>${esc(m.auto ? 'Asistente de la Mesa de Ayuda' : m.author || 'Usted')}</b>${m.auto ? '<span class="msg-kind">Respuesta automática</span>' : m.kind === 'reply' ? '<span class="msg-kind">Mesa de ayuda</span>' : ''}<time>${fmtDateTime(m.created_at)}</time></header>
      <div class="msg-html">${sanitize(m.body_html)}</div>
      ${m.attachments.length ? `<div class="atts">${m.attachments.map((a) => `<span class="chip" title="Para descargarlo, ingrese o use el enlace del correo">${icon('clip', 12)} ${esc(a.filename)} <small>${fmtSize(a.size)}</small></span>`).join('')}</div>` : ''}
    </div></article>`).join('')}</div>` : ''}
    <p class="p-lk-next">${next}</p>
  </div>`;
}

// ---------- Estado de los sistemas críticos (v1.11) ----------
const CRIT = {
  ok: ['Operativo', '#059669'], degraded: ['Degradado', '#d97706'], down: ['Caído', '#dc2626'], maint: ['En mantenimiento', '#7c3aed'],
};
const critPill = (st) => `<span class="badge" style="--c:${CRIT[st][1]}"><i class="p-dot" style="--c:${CRIT[st][1]}"></i>${CRIT[st][0]}</span>`;
const hhmm = (d) => new Date(d).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' hs';
function whenLabel(d) {
  const x = new Date(d);
  const tom = new Date();
  tom.setDate(tom.getDate() + 1);
  if (x.toDateString() === new Date().toDateString()) return `hoy ${hhmm(x)}`;
  if (x.toDateString() === tom.toDateString()) return `mañana ${hhmm(x)}`;
  return `${x.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(x)}`;
}
function inLabel(d) {
  let m = Math.round((new Date(d) - Date.now()) / 60000);
  if (m <= 0) return '';
  if (m < 60) return `en ${m} min`;
  const h = Math.floor(m / 60);
  m %= 60;
  return h >= 48 ? `en ${Math.round(h / 24)} días` : `en ${h} h${m ? ` ${m} min` : ''}`;
}
const critLate = (s) => s.state !== 'ok' && s.eta && new Date(s.eta) < new Date();
let statusCache = null;
async function loadStatus() {
  try { statusCache = await papi('/portal/status'); } catch { statusCache = null; }
  return statusCache;
}

function statusHtml(st) {
  if (!st?.enabled || !st.systems.length) return '';
  const bad = st.systems.filter((x) => x.state !== 'ok');
  const okList = st.systems.filter((x) => x.state === 'ok');
  const tone = bad.some((x) => x.state === 'down') ? 'issue' : bad.length ? 'warn' : 'all-ok';
  return `<section class="p-status" aria-live="polite">
    <div class="p-status-head ${tone}">
      ${bad.length ? icon('alert', 22) : icon('check', 22)}
      <div class="grow"><h2>${bad.length ? (bad.length === 1 ? 'Un sistema tiene problemas' : `${bad.length} sistemas tienen problemas`) : 'Todos los sistemas funcionan con normalidad'}</h2>
        ${bad.length ? '<p>Ya lo sabemos y estamos trabajando. No hace falta crear un ticket por esto.</p>' : ''}</div>
      <small class="muted">Actualizado ${hhmm(st.now || new Date())}</small>
    </div>
    ${bad.map((x) => `<div class="p-status-row">
      <div class="p-status-name"><i class="p-dot pulse-${x.state}" style="--c:${CRIT[x.state][1]}"></i><b>${esc(x.name)}</b>${critPill(x.state)}</div>
      <div class="p-status-detail">
        ${x.message ? `<p>${esc(x.message)}</p>` : x.description ? `<p class="muted">${esc(x.description)}</p>` : ''}
        <p>${critLate(x) ? '<b class="p-late">Demorado: estamos actualizando la estimación.</b>' : `Resolución estimada: <b>${whenLabel(x.eta)}</b> <span class="muted">(${inLabel(x.eta)})</span>`}</p>
        ${x.since ? `<small class="muted">Informado ${relTime(x.since)}</small>` : ''}
      </div></div>`).join('')}
    ${okList.length ? `<div class="p-status-ok">${okList.map((x) => `<span title="${esc(x.description || '')}"><i class="p-dot" style="--c:#059669"></i>${esc(x.name)}</span>`).join('')}</div>` : ''}
  </section>`;
}

/** Al crear un ticket: si el tema o el asunto apuntan a un sistema con un problema informado, se avisa. */
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function knownIssue(st, { subject, text, techId, skip = [] }) {
  if (!st?.enabled || st.ticket_warning === false) return null;
  // Mismas reglas que el servidor: palabras propias del sistema en asunto o texto; sin palabras, el nombre solo en el asunto
  const words = (x) => ` ${norm(x).replace(/[^a-z0-9ñ]+/g, ' ').trim()} `;
  const S = words(subject);
  const B = words(text);
  const has = (hay, list) => (list || []).some((w) => hay.includes(` ${w} `));
  return st.systems.find((x) => x.state !== 'ok' && !skip.includes(x.id) && ((x.tech_category_id && String(x.tech_category_id) === String(techId))
    || has(S, x.words?.subject) || has(B, x.words?.body))) || null;
}

async function route() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
  const query = new URLSearchParams(qs || '');
  root.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  try {
    if (!cfg.enabled) return disabled();
    if (needsLogin()) return loginGate(path === '#/ingresar' ? query : undefined);
    if (path === '#/ingresar') {
      if (cfg.me) { location.replace('#/'); return; }
      return cfg.access === 'microsoft' ? loginGate(query) : loginView(query);
    }
    // Partes apagadas en Configuración → Portal: vuelven al inicio
    const off = (path.startsWith('#/kb') && !part('kb')) || (path === '#/consultar' && !part('lookup')) || (path.startsWith('#/nuevo') && !part('create'))
      || (path.startsWith('#/mis-tickets') && !part('my_tickets'));
    if (off) { location.replace('#/'); return; }
    let m;
    if ((m = /^#\/ticket\/(.+)$/.exec(hash))) return await ticketView(decodeURIComponent(m[1]));
    if ((m = /^#\/t\/(\d{1,9})$/.exec(path))) return await ticketView(null, Number(m[1]));
    if ((m = /^#\/mis-tickets\/(.+)$/.exec(hash))) return await myTickets(decodeURIComponent(m[1]));
    if (path === '#/mis-tickets') return cfg.me ? await mySessionTickets(query) : loginView(query);
    if (path === '#/consultar') return lookupView(query.get('n') || '');
    if (hash.startsWith('#/nuevo')) return newTicket();
    if ((m = /^#\/kb\/(\d+)/.exec(hash))) return await article(m[1]);
    if (hash.startsWith('#/kb')) return await kbList(new URLSearchParams(hash.split('?')[1] || ''));
    return home();
  } catch (e) {
    // La sesión de Microsoft venció: se refleja en el encabezado (y, si el acceso es solo con Microsoft, se pide ingresar)
    if ((e.status === 401 || /sesión venció/.test(e.message)) && cfg.me) { cfg.me = null; renderSession(); }
    if (e.status === 401 && cfg.access === 'microsoft') { cfg.me = null; renderSession(); return loginGate(); }
    root.innerHTML = `<div class="p-done">${icon('alert', 36)}<h2>${esc(e.message)}</h2><p><a href="#/">Volver al inicio</a></p></div>`;
  }
  window.scrollTo(0, 0);
}

function disabled() {
  root.innerHTML = '<div class="p-done"><h2>El portal no está disponible</h2><p class="muted">Escríbanos por correo para recibir ayuda.</p></div>';
}

function home() {
  const kbCats = part('kb') ? cfg.kbCategories.filter((c) => c.articles) : [];
  const cards = [
    part('create') ? `<a class="p-card" href="#/nuevo">${icon('plus', 26)}<div><b>Crear un ticket</b><p>Informe un problema o haga un pedido.</p></div></a>` : '',
    part('my_tickets') ? `<a class="p-card" href="#/mis-tickets">${icon('ticket', 26)}<div><b>Mis tickets</b><p>${cfg.me ? 'Vea todas sus solicitudes y responda.' : cfg.microsoft ? 'Ingrese con su cuenta de Microsoft y vea todas sus solicitudes.' : 'Consulte el estado de sus solicitudes.'}</p></div></a>` : '',
    part('kb') ? `<a class="p-card" href="#/kb">${icon('book', 26)}<div><b>Artículos</b><p>Guías y preguntas frecuentes.</p></div></a>` : '',
  ].filter(Boolean);
  const first = cfg.me?.name ? cfg.me.name.split(' ')[0] : '';
  root.innerHTML = `
    <section class="p-hero">
      <h1>${first ? `Hola, ${esc(first)}. ` : ''}¿En qué podemos ayudarlo?</h1>
      <p>${part('kb') && part('create') ? 'Busque una respuesta o cree un ticket para la mesa de ayuda.' : part('kb') ? 'Busque una respuesta en las guías de la mesa de ayuda.' : part('create') ? 'Cree un ticket para la mesa de ayuda.' : 'Centro de ayuda de la mesa de ayuda.'}</p>
      ${part('kb') ? `<form class="p-search" data-search>${icon('search', 18)}<input name="q" placeholder="Ej. cómo resetear la clave" aria-label="Buscar artículos"><button class="btn primary">Buscar</button></form>` : ''}
    </section>
    ${part('status') ? `<div data-status>${statusHtml(statusCache)}</div>` : ''}
    ${part('lookup') ? lookupBox() : ''}
    ${cards.length ? `<div class="p-cards">${cards.join('')}</div>` : ''}
    ${kbCats.length ? `<h2 style="margin-bottom:12px">Categorías</h2><div class="p-cards">${kbCats.map((c) => `<a class="p-card" href="#/kb?category=${c.id}">${icon('book', 22)}<div><b>${esc(c.name)}</b><p>${c.articles} artículo${c.articles === 1 ? '' : 's'}${c.description ? ` · ${esc(c.description)}` : ''}</p></div></a>`).join('')}</div>` : ''}
    ${!cards.length && !part('lookup') && !part('status') ? `<div class="p-done"><p class="muted">Para pedir ayuda, escríbanos${cfg.support_email ? ` a <b>${esc(cfg.support_email)}</b>` : ' por correo'}.</p></div>` : ''}`;
  root.querySelector('[data-search]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/kb?q=${encodeURIComponent(e.target.q.value)}`;
  });
  if (part('lookup')) bindLookup(root);
  // El estado se refresca cada vez que se entra al inicio (y cada minuto mientras está abierto)
  const slot = root.querySelector('[data-status]');
  if (!slot) return;
  const refresh = async () => { if (!slot.isConnected) return clearInterval(timer); slot.innerHTML = statusHtml(await loadStatus()); };
  const timer = setInterval(refresh, 60000);
  refresh();
}

function lookupView(prefill) {
  root.innerHTML = lookupBox(prefill);
  bindLookup(root);
  const f = root.querySelector('[data-lookup]');
  if (prefill && (!f.email || f.email.value)) f.requestSubmit();
  else (prefill && f.email ? f.email : f.number).focus();
}

async function kbList(params) {
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const list = await papi(`/portal/kb?${new URLSearchParams({ q, category })}`);
  const cat = cfg.kbCategories.find((c) => String(c.id) === category);
  root.innerHTML = `<h1 style="margin-bottom:14px">${cat ? esc(cat.name) : q ? `Resultados para “${esc(q)}”` : 'Artículos'}</h1>
    <form class="p-search" style="margin:0 0 18px;max-width:none;box-shadow:var(--shadow)" data-search>${icon('search', 18)}<input name="q" value="${esc(q)}" placeholder="Buscar artículos"><button class="btn primary">Buscar</button></form>
    ${list.length ? `<div class="p-list">${list.map((a) => `<a href="#/kb/${a.id}"><span>${icon('book', 15)} ${esc(a.title)}</span><small class="muted">${esc(a.category || '')}</small></a>`).join('')}</div>` : '<div class="p-done"><p>No encontramos artículos. ¿Quiere <a href="#/nuevo">crear un ticket</a>?</p></div>'}`;
  root.querySelector('[data-search]').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/kb?q=${encodeURIComponent(e.target.q.value)}`; });
}

async function article(id) {
  const a = await papi(`/portal/kb/${id}`);
  root.innerHTML = `<p><a href="#/kb${a.category_id ? `?category=${a.category_id}` : ''}" class="muted">← ${esc(a.category || 'Artículos')}</a></p>
    <article class="p-art"><h1>${esc(a.title)}</h1><p class="muted small">Actualizado ${relTime(a.updated_at)}</p><div class="msg-html">${sanitize(a.body_html)}</div></article>
    <div class="p-done" style="margin-top:16px"><p>¿No resolvió su consulta?</p><a class="btn primary" href="#/nuevo">Crear un ticket</a></div>`;
}

function newTicket() {
  let files = [];
  const opKey = newKey(); // misma clave si el envío se reintenta: no se duplica el ticket
  root.innerHTML = `<h1 style="margin-bottom:6px">Crear un ticket</h1><p class="muted" style="margin-bottom:18px">Complete los datos y le responderemos por correo.</p>
    <form class="card" data-new>
      <div class="grid2">
        <label class="field"><span>Nombre y apellido *</span><input class="input" name="name" required autocomplete="name"></label>
        <label class="field"><span>Correo *</span><input class="input" name="email" type="email" required autocomplete="email"></label>
      </div>
      <label class="field"><span>Asunto *</span><input class="input" name="subject" required maxlength="200"></label>
      <div class="grid2">
        <label class="field"><span>Área</span><select class="input" name="category_id"><option value="">Seleccione…</option>${cfg.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Tema</span><select class="input" name="tech_category_id"><option value="">Seleccione…</option>${cfg.techCategories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="p-known" data-known hidden aria-live="polite"></div>
      <label class="field"><span>Descripción *</span><textarea class="input" name="body_text" rows="7" required placeholder="Cuéntenos qué pasa, desde cuándo y qué ve en pantalla."></textarea></label>
      <div class="p-suggest" data-suggest hidden aria-live="polite"></div>
      <div class="field"><span>Adjuntos (máx. 5, 3 MB c/u)</span><input type="file" multiple name="files"><div class="atts" data-files></div></div>
      <input class="honey" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button class="btn primary">Enviar</button>
    </form>`;
  const f = root.querySelector('[data-new]');
  const submitBtn = f.querySelector('button:not([type=button])');
  // Área de quien ingresó (según su contacto o el directorio): queda elegida, se puede cambiar
  if (cfg.my_category_id && [...f.category_id.options].some((o) => o.value === String(cfg.my_category_id))) f.category_id.value = String(cfg.my_category_id);
  if (cfg.me) {
    // Con sesión de Microsoft el ticket queda a nombre de la cuenta
    f.name.value = cfg.me.name || '';
    f.email.value = cfg.me.email;
    f.email.readOnly = true;
    f.email.title = 'El ticket se crea a nombre de la cuenta con la que ingresó';
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem('portal-me') || '{}');
      if (saved.name) f.name.value = saved.name;
      if (saved.email) f.email.value = saved.email;
    } catch { /* */ }
  }
  // Sugerencias antes de enviar ("Antes de enviar, pruebe esto")
  const box = root.querySelector('[data-suggest]');
  let sugg = null;
  let lastKey = '';
  let timer = null;
  let seq = 0;
  async function suggest() {
    const subject = f.subject.value.trim();
    const text = f.body_text.value.trim();
    const key = `${subject}|${text}|${f.tech_category_id.value}|${f.category_id.value}`;
    if (key === lastKey || (subject + text).length < 15) return;
    lastKey = key;
    const my = ++seq;
    try {
      const r = await papi('/portal/suggest', { subject, body_text: text, email: f.email.value, category_id: f.category_id.value, tech_category_id: f.tech_category_id.value });
      if (my !== seq) return;
      sugg = r.suggestion;
      if (!sugg || (!sugg.html && !sugg.articles.length)) { box.hidden = true; box.innerHTML = ''; return; }
      box.innerHTML = `<div class="p-sg-head">${icon('sparkles', 18)}<b>Antes de enviar, pruebe esto</b></div>
        ${sanitize(sugg.html)}
        ${sugg.articles.length ? `<p class="small">Artículos que pueden servirle: ${sugg.articles.map((a) => `<a href="#/kb/${a.id}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join(' · ')}</p>` : ''}
        <div class="row gap wrap"><button type="button" class="btn" data-solved>Se resolvió, no crear el ticket</button><button type="button" class="btn primary" data-notsolved>No se resolvió, crear el ticket</button></div>`;
      box.hidden = false;
    } catch { /* las sugerencias son opcionales */ }
  }
  // Problema ya informado en un sistema crítico: se avisa antes de crear un ticket repetido
  const known = root.querySelector('[data-known]');
  const dismissed = []; // sistemas que descartó: el ticket no se vincula a esos problemas
  const checkKnown = () => {
    const sys = knownIssue(statusCache, { subject: f.subject.value, text: f.body_text.value, techId: f.tech_category_id.value, skip: dismissed });
    if (!sys) { known.hidden = true; known.innerHTML = ''; return; }
    known.innerHTML = `${icon('alert', 22)}<div><b>${esc(sys.name)}: ${CRIT[sys.state][0].toLowerCase()}. Ya lo estamos resolviendo.</b>
      <p>${sys.message ? `${esc(sys.message)} ` : ''}Resolución estimada: <b>${critLate(sys) ? 'demorada, estamos actualizando la estimación' : whenLabel(sys.eta)}</b>. No hace falta crear un ticket por esto; si su problema es otro, siga igual.</p>
      <div class="row gap wrap"><button type="button" class="btn sm primary" data-known-ok>Entendido, no crear el ticket</button><button type="button" class="btn sm" data-known-other>Mi problema es otro</button></div></div>`;
    known.hidden = false;
    known.querySelector('[data-known-ok]').onclick = () => {
      root.innerHTML = `<div class="p-done">${icon('check', 40)}<h2>Gracias por avisar</h2><p>Ya estamos trabajando en ${esc(sys.name)}. Puede seguir el estado en el inicio del centro de ayuda.</p><p><a class="btn" href="#/">Volver al inicio</a></p></div>`;
    };
    known.querySelector('[data-known-other]').onclick = () => { dismissed.push(sys.id); checkKnown(); };
  };
  if (!statusCache) loadStatus().then(checkKnown);
  f.subject.addEventListener('input', checkKnown);
  f.body_text.addEventListener('input', checkKnown);
  f.tech_category_id.addEventListener('change', checkKnown);
  const later = () => { clearTimeout(timer); timer = setTimeout(suggest, 1200); };
  f.subject.addEventListener('input', later);
  f.body_text.addEventListener('input', later);
  f.body_text.addEventListener('blur', suggest);
  f.tech_category_id.addEventListener('change', suggest);
  let tried = '';
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-solved]')) {
      papi('/portal/deflect', { rule_id: sugg?.rule?.id || null, subject: f.subject.value, email: f.email.value }).catch(() => {});
      root.innerHTML = `<div class="p-done">${icon('check', 40)}<h2>¡Qué bueno que se resolvió!</h2><p>No creamos ningún ticket. Si vuelve a pasar, puede escribirnos cuando quiera.</p><p><a class="btn" href="#/">Volver al inicio</a></p></div>`;
    }
    if (e.target.closest('[data-notsolved]')) {
      tried = sugg?.text || '';
      if (f.reportValidity()) f.requestSubmit();
    }
  });

  f.files.addEventListener('change', async () => {
    try {
      files = (await readFiles(f.files.files)).slice(0, 5);
      root.querySelector('[data-files]').innerHTML = files.map((x) => `<span class="chip">${icon('clip', 12)} ${esc(x.name)} <small>${fmtSize(x.size)}</small></span>`).join('');
    } catch (e) { toastError(e); f.files.value = ''; files = []; }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = submitBtn;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await papi('/portal/tickets', {
        name: f.name.value, email: f.email.value, subject: f.subject.value, body_text: f.body_text.value,
        category_id: f.category_id.value, tech_category_id: f.tech_category_id.value, attachments: files, website: f.website.value, ai_tried: tried, critical_dismissed: dismissed,
      }, { key: opKey });
      try { localStorage.setItem('portal-me', JSON.stringify({ name: f.name.value, email: f.email.value })); } catch { /* */ }
      toast(`Recibimos su solicitud: ticket #${r.number}. Le vamos a responder por correo.`);
      if (r.token) {
        storeToken(r.number, r.token);
        location.hash = `#/ticket/${encodeURIComponent(r.token)}`;
      } else location.hash = `#/t/${r.number}`;
    } catch (er) { toastError(er); btn.disabled = false; btn.textContent = 'Enviar'; }
  });
}

function loginView(query = new URLSearchParams()) {
  const local = storedTickets();
  const nums = Object.keys(local).sort((a, b) => b - a);
  const err = query.get('error');
  root.innerHTML = `<h1 style="margin-bottom:14px">Mis tickets</h1>
    ${err ? `<p class="callout danger">${icon('alert', 16)} <span><b>No se pudo ingresar con Microsoft.</b> ${esc(err.slice(0, 200))}</span></p>` : ''}
    ${cfg.microsoft ? `<div class="card p-signin">${icon('ticket', 30)}<div class="grow"><h3>Ingrese con su cuenta de la empresa</h3>
      <p class="muted">Vea todos sus tickets, las respuestas de la mesa de ayuda y el avance de cada pedido.</p></div>
      <a class="btn primary p-ms-btn" href="${msStart()}">${MS_LOGO} Ingresar con Microsoft</a></div>` : ''}
    ${nums.length ? `<h4>Tickets creados desde este navegador</h4><div class="p-list">${nums.map((n) => `<a href="#/ticket/${encodeURIComponent(local[n])}"><span>${icon('ticket', 15)} Ticket #${esc(n)}</span><span class="muted">${icon('right', 15)}</span></a>`).join('')}</div>` : ''}
    ${cfg.magicLink ? `<form class="card" data-login><h3>${cfg.microsoft ? '¿No puede ingresar con Microsoft?' : 'Ver todos mis tickets'}</h3>
      <p class="muted">Le enviamos un enlace de acceso a su correo.</p>
      <div class="row gap"><input class="input" type="email" name="email" required placeholder="nombre@empresa.com" autocomplete="email"><button class="btn primary">Enviar enlace</button></div>
    </form>` : cfg.microsoft ? '' : '<div class="card"><p class="muted">Use el enlace "Ver el ticket" que recibió por correo para consultar cada ticket.</p></div>'}
    <p class="muted small">¿Solo quiere saber cómo va un pedido? <a href="#/consultar">Consulte por número de ticket</a>.</p>`;
  root.querySelector('[data-login]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await papi('/portal/login', { email: e.target.email.value });
      root.querySelector('[data-login]').innerHTML = `<div class="p-done" style="border:0">${icon('mail', 36)}<h3>Revise su correo</h3><p class="muted">Si el correo está registrado, le llegará un enlace en unos minutos.</p></div>`;
    } catch (er) { toastError(er); }
  });
}

/** Mis tickets con la sesión de Microsoft: solo los de esa persona, con filtro y búsqueda. */
async function mySessionTickets(query) {
  const r = await papi('/portal/my-tickets', {});
  const openKinds = ['open', 'pending'];
  const counts = { open: r.tickets.filter((t) => openKinds.includes(t.status_kind)).length };
  counts.done = r.tickets.length - counts.open;
  let filter = query.get('f') || (counts.open ? 'open' : 'all');
  let text = '';
  root.innerHTML = `<div class="p-mine-head"><div><h1>Mis tickets</h1><p class="muted">${esc(r.contact.name)} · ${esc(r.contact.email)}</p></div>
      <a class="btn primary" href="#/nuevo">${icon('plus', 15)} Crear ticket</a></div>
    <div class="p-mine-bar">
      <div class="seg" role="tablist">
        <button type="button" data-f="open">Abiertos <small>${counts.open}</small></button>
        <button type="button" data-f="done">Resueltos <small>${counts.done}</small></button>
        <button type="button" data-f="all">Todos <small>${r.tickets.length}</small></button>
      </div>
      <label class="p-mine-search">${icon('search', 16)}<input name="q" placeholder="Buscar por número o asunto" aria-label="Buscar en mis tickets"></label>
    </div>
    <div data-rows></div>`;
  const rows = root.querySelector('[data-rows]');
  const draw = () => {
    root.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('active', b.dataset.f === filter));
    const needle = text.trim().toLowerCase().replace(/^#/, '');
    const list = r.tickets.filter((t) => (filter === 'all' || (filter === 'open') === openKinds.includes(t.status_kind))
      && (!needle || String(t.number).startsWith(needle) || t.subject.toLowerCase().includes(needle)));
    if (!r.tickets.length) {
      rows.innerHTML = `<div class="p-done">${icon('ticket', 34)}<h3>Todavía no tiene tickets</h3><p class="muted">Los pedidos que haga con ${esc(r.contact.email)} van a aparecer acá.</p><p><a class="btn primary" href="#/nuevo">Crear un ticket</a></p></div>`;
      return;
    }
    rows.innerHTML = list.length ? `<div class="p-list p-mine">${list.map((t) => `<a href="#/t/${t.number}">
        <span class="p-mine-main"><b>#${t.number}</b> <span class="p-mine-subj">${esc(t.subject)}</span>
          <small class="muted">Creado ${fmtDay(t.created_at)} · Última novedad ${relTime(t.updated_at)}</small></span>
        ${stBadge(t.status, t.status_kind)}</a>`).join('')}</div>`
      : `<div class="p-done"><p class="muted">${needle ? 'Ningún ticket coincide con la búsqueda.' : filter === 'open' ? 'No tiene tickets abiertos.' : 'No hay tickets resueltos.'}</p></div>`;
  };
  root.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    history.replaceState(null, '', `#/mis-tickets?f=${filter}`);
    draw();
  }));
  root.querySelector('[name=q]').addEventListener('input', (e) => { text = e.target.value; draw(); });
  draw();
}

async function myTickets(token) {
  const r = await papi('/portal/my-tickets', { token });
  root.innerHTML = `<h1 style="margin-bottom:4px">Mis tickets</h1><p class="muted" style="margin-bottom:16px">${esc(r.contact.name)} · ${esc(r.contact.email)}</p>
    ${r.tickets.length ? `<div class="p-list">${r.tickets.map((t) => `<a href="#/ticket-n/${t.number}"><span><b>#${t.number}</b> ${esc(t.subject)}</span><span class="badge st-${esc(t.status_kind)}">${esc(t.status)}</span></a>`).join('')}</div>` : '<div class="p-done"><p>No tiene tickets.</p></div>'}`;
  root.querySelectorAll('a[href^="#/ticket-n/"]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    ticketView(token, Number(a.getAttribute('href').split('/').pop()));
  }));
}

async function ticketView(token, number) {
  const d = await papi('/portal/ticket', { token: token || undefined, number });
  if (d.token) storeToken(d.ticket.number, d.token);
  const t = d.ticket;
  const open = t.status_kind === 'open' || t.status_kind === 'pending';
  let files = [];
  const replyKey = newKey();
  root.innerHTML = `<p><a href="#/mis-tickets" class="muted">← Mis tickets</a></p>
    <div class="card"><div class="row gap" style="justify-content:space-between;flex-wrap:wrap"><div><h1>#${t.number} · ${esc(t.subject)}</h1><p class="muted small">Creado ${fmtDateTime(t.created_at)}</p></div>
      ${stBadge(t.status, t.status_kind)}</div></div>
    ${(d.development || []).map((p) => `<div class="card dev-card portal-dev"><header><div><b>Avance del desarrollo</b><small class="muted">${esc(p.name)}${p.due_date ? ` · Fin previsto ${new Date(String(p.due_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-AR')}` : ''}</small></div>
      <div class="dev-progress"><span class="dev-pct">${p.progress}%</span><span class="progress"><span style="width:${p.progress}%"></span></span></div></header>
      <ol class="phases">${p.phases.map((f) => `<li class="ph ${f.state}"><span class="ph-dot">${f.state === 'done' ? icon('check', 13) : f.state === 'active' ? '<i class="pulse"></i>' : ''}</span><span class="ph-name">${esc(f.title)}</span><span class="ph-meta">${f.state === 'done' ? 'Completa' : f.state === 'active' ? `En curso · ${f.pct}%` : 'Pendiente'}</span></li>`).join('')}</ol>
      <footer><span class="small">${p.finished ? '<b class="ok-text">Desarrollo finalizado</b>' : p.current ? `Fase actual: <b>${esc(p.current)}</b>` : ''}</span></footer></div>`).join('')}
    <div class="thread">${d.messages.map((m) => { const auto = Boolean(m.meta?.auto); return `<article class="msg ${m.kind === 'reply' ? 'reply' : 'customer'} ${auto ? 'auto' : ''}"><div class="msg-body">
      <header><b>${esc(auto ? 'Asistente de la Mesa de Ayuda' : m.kind === 'reply' ? m.agent_name || 'Mesa de ayuda' : m.contact_name || 'Usted')}</b>${auto ? '<span class="msg-kind">Respuesta automática</span>' : m.kind === 'reply' ? '<span class="msg-kind">Mesa de ayuda</span>' : ''}<time>${fmtDateTime(m.created_at)}</time></header>
      <div class="msg-html">${sanitize(m.body_html)}</div>
      ${auto && t.auto_reply ? (t.feedback ? `<p class="p-fb-done">${icon('check', 14)} ${t.feedback === 'yes' ? 'Gracias por confirmarlo.' : 'Gracias. Un agente va a continuar el caso.'}</p>` : open ? `<div class="p-fb"><span>¿Le sirvió?</span><button type="button" class="btn sm ok" data-fb="yes">Sí, se resolvió</button><button type="button" class="btn sm" data-fb="no">No, necesito un agente</button></div>` : '') : ''}
      ${m.attachments.length ? `<div class="atts">${m.attachments.map((a) => `<a class="chip" href="#" data-att="${a.id}">${icon('clip', 12)} ${esc(a.filename)}</a>`).join('')}</div>` : ''}
    </div></article>`; }).join('')}</div>
    <form class="card" data-reply style="margin-top:14px">
      <h3>${open ? 'Responder' : 'Reabrir con un mensaje'}</h3>
      <textarea class="input" name="body_text" rows="4" placeholder="Escriba su mensaje"></textarea>
      <div class="row gap" style="margin-top:8px;flex-wrap:wrap"><input type="file" multiple name="files"><span class="grow"></span>
        ${open ? '<button type="button" class="btn" data-resolve>Ya está resuelto</button>' : ''}<button class="btn primary">Enviar</button></div>
    </form>`;
  const f = root.querySelector('[data-reply]');
  f.files.addEventListener('change', async () => {
    try { files = (await readFiles(f.files.files)).slice(0, 5); } catch (e) { toastError(e); f.files.value = ''; files = []; }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!f.body_text.value.trim() && !files.length) return toast('Escriba un mensaje', 'error');
    try {
      await papi('/portal/ticket/reply', { token: d.token || undefined, number: t.number, body_text: f.body_text.value, attachments: files }, { key: replyKey });
      toast('Mensaje enviado');
      ticketView(d.token, t.number);
    } catch (er) { toastError(er); }
  });
  // Adjuntos: se pide un enlace de 5 minutos para ese archivo (el enlace del ticket no queda en la URL ni en los registros)
  root.querySelectorAll('[data-att]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const w = window.open('', '_blank'); // se abre ya (si no, el navegador lo bloquea por no venir de un clic)
    try {
      const r = await papi('/portal/attachment-link', { token: d.token || undefined, number: t.number, id: Number(a.dataset.att) });
      if (w) { w.opener = null; w.location.href = r.url; } else location.href = r.url;
    } catch (er) { if (w) w.close(); toastError(er); }
  }));
  root.querySelectorAll('[data-fb]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await papi('/portal/ticket/feedback', { token: d.token || undefined, number: t.number, helpful: b.dataset.fb === 'yes' });
      toast(b.dataset.fb === 'yes' ? '¡Gracias! Nos alegra que se haya resuelto' : 'Gracias. Un agente va a continuar el caso');
      ticketView(d.token, t.number);
    } catch (er) { toastError(er); }
  }));
  root.querySelector('[data-resolve]')?.addEventListener('click', async () => {
    try { await papi('/portal/ticket/resolve', { token: d.token || undefined, number: t.number }); toast('¡Gracias! Marcamos el ticket como resuelto'); ticketView(d.token, t.number); } catch (er) { toastError(er); }
  });
}

async function boot() {
  try {
    cfg = await papi('/portal/config');
  } catch (e) {
    root.innerHTML = `<div class="p-done"><h2>No se pudo cargar el portal</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  applyBrand({ ...cfg.brand, product: cfg.title });
  document.getElementById('pBrand').textContent = cfg.title || 'Centro de ayuda';
  document.getElementById('pProduct').textContent = cfg.brand.name || '';
  document.getElementById('pFoot').textContent = `${cfg.brand.name || ''} · ${cfg.brand.product || 'Mesa de Ayuda'}`;
  if (cfg.brand.logo) document.querySelector('.p-logo').innerHTML = `<img src="${esc(cfg.brand.logo)}" alt="">`;
  renderSession();
  window.addEventListener('hashchange', route);
  route();
}

boot();
