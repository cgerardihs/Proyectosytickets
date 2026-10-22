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
    throw new Error(msg);
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

async function route() {
  const hash = location.hash || '#/';
  root.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  try {
    if (!cfg.enabled) return disabled();
    let m;
    if ((m = /^#\/ticket\/(.+)$/.exec(hash))) return ticketView(decodeURIComponent(m[1]));
    if ((m = /^#\/mis-tickets\/(.+)$/.exec(hash))) return myTickets(decodeURIComponent(m[1]));
    if (hash.startsWith('#/mis-tickets')) return loginView();
    if (hash.startsWith('#/nuevo')) return newTicket();
    if ((m = /^#\/kb\/(\d+)/.exec(hash))) return article(m[1]);
    if (hash.startsWith('#/kb')) return kbList(new URLSearchParams(hash.split('?')[1] || ''));
    return home();
  } catch (e) {
    root.innerHTML = `<div class="p-done">${icon('alert', 36)}<h2>${esc(e.message)}</h2><p><a href="#/">Volver al inicio</a></p></div>`;
  }
  window.scrollTo(0, 0);
}

function disabled() {
  root.innerHTML = '<div class="p-done"><h2>El portal no está disponible</h2><p class="muted">Escríbanos por correo para recibir ayuda.</p></div>';
}

function home() {
  root.innerHTML = `
    <section class="p-hero">
      <h1>¿En qué podemos ayudarlo?</h1>
      <p>Busque una respuesta o cree un ticket para la mesa de ayuda.</p>
      <form class="p-search" data-search>${icon('search', 18)}<input name="q" placeholder="Ej. cómo resetear la clave" aria-label="Buscar artículos"><button class="btn primary">Buscar</button></form>
    </section>
    <div class="p-cards">
      <a class="p-card" href="#/nuevo">${icon('plus', 26)}<div><b>Crear un ticket</b><p>Informe un problema o haga un pedido.</p></div></a>
      <a class="p-card" href="#/mis-tickets">${icon('ticket', 26)}<div><b>Mis tickets</b><p>Consulte el estado de sus solicitudes.</p></div></a>
      <a class="p-card" href="#/kb">${icon('book', 26)}<div><b>Artículos</b><p>Guías y preguntas frecuentes.</p></div></a>
    </div>
    ${cfg.kbCategories.filter((c) => c.articles).length ? `<h2 style="margin-bottom:12px">Categorías</h2><div class="p-cards">${cfg.kbCategories.filter((c) => c.articles).map((c) => `<a class="p-card" href="#/kb?category=${c.id}">${icon('book', 22)}<div><b>${esc(c.name)}</b><p>${c.articles} artículo${c.articles === 1 ? '' : 's'}${c.description ? ` · ${esc(c.description)}` : ''}</p></div></a>`).join('')}</div>` : ''}`;
  root.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/kb?q=${encodeURIComponent(e.target.q.value)}`;
  });
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
      <label class="field"><span>Descripción *</span><textarea class="input" name="body_text" rows="7" required placeholder="Cuéntenos qué pasa, desde cuándo y qué ve en pantalla."></textarea></label>
      <div class="p-suggest" data-suggest hidden aria-live="polite"></div>
      <div class="field"><span>Adjuntos (máx. 5, 3 MB c/u)</span><input type="file" multiple name="files"><div class="atts" data-files></div></div>
      <input class="honey" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button class="btn primary">Enviar</button>
    </form>`;
  const f = root.querySelector('[data-new]');
  const submitBtn = f.querySelector('button:not([type=button])');
  try {
    const saved = JSON.parse(localStorage.getItem('portal-me') || '{}');
    if (saved.name) f.name.value = saved.name;
    if (saved.email) f.email.value = saved.email;
  } catch { /* */ }
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
        category_id: f.category_id.value, tech_category_id: f.tech_category_id.value, attachments: files, website: f.website.value, ai_tried: tried,
      }, { key: opKey });
      try { localStorage.setItem('portal-me', JSON.stringify({ name: f.name.value, email: f.email.value })); } catch { /* */ }
      storeToken(r.number, r.token);
      toast(`Recibimos su solicitud: ticket #${r.number}. Le vamos a responder por correo.`);
      location.hash = `#/ticket/${encodeURIComponent(r.token)}`;
    } catch (er) { toastError(er); btn.disabled = false; btn.textContent = 'Enviar'; }
  });
}

function loginView() {
  const local = storedTickets();
  const nums = Object.keys(local).sort((a, b) => b - a);
  root.innerHTML = `<h1 style="margin-bottom:14px">Mis tickets</h1>
    ${nums.length ? `<h4>Tickets creados desde este navegador</h4><div class="p-list">${nums.map((n) => `<a href="#/ticket/${encodeURIComponent(local[n])}"><span>${icon('ticket', 15)} Ticket #${esc(n)}</span><span class="muted">${icon('right', 15)}</span></a>`).join('')}</div>` : ''}
    <form class="card" data-login><h3>Ver todos mis tickets</h3>
      ${cfg.magicLink ? `<p class="muted">Le enviamos un enlace de acceso a su correo.</p>
      <div class="row gap"><input class="input" type="email" name="email" required placeholder="nombre@empresa.com" autocomplete="email"><button class="btn primary">Enviar enlace</button></div>`
    : '<p class="muted">Use el enlace "Ver el ticket" que recibió por correo para consultar cada ticket.</p>'}
    </form>`;
  root.querySelector('[data-login]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await papi('/portal/login', { email: e.target.email.value });
      root.querySelector('[data-login]').innerHTML = `<div class="p-done" style="border:0">${icon('mail', 36)}<h3>Revise su correo</h3><p class="muted">Si el correo está registrado, le llegará un enlace en unos minutos.</p></div>`;
    } catch (er) { toastError(er); }
  });
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
  const d = await papi('/portal/ticket', { token, number });
  storeToken(d.ticket.number, d.token);
  const t = d.ticket;
  const open = t.status_kind === 'open' || t.status_kind === 'pending';
  let files = [];
  const replyKey = newKey();
  root.innerHTML = `<p><a href="#/mis-tickets" class="muted">← Mis tickets</a></p>
    <div class="card"><div class="row gap" style="justify-content:space-between;flex-wrap:wrap"><div><h1>#${t.number} · ${esc(t.subject)}</h1><p class="muted small">Creado ${fmtDateTime(t.created_at)}</p></div>
      <span class="badge" style="--c:${open ? '#2563eb' : '#059669'}">${esc(t.status || '')}</span></div></div>
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
      await papi('/portal/ticket/reply', { token: d.token, body_text: f.body_text.value, attachments: files }, { key: replyKey });
      toast('Mensaje enviado');
      ticketView(d.token);
    } catch (er) { toastError(er); }
  });
  // Adjuntos: se pide un enlace de 5 minutos para ese archivo (el enlace del ticket no queda en la URL ni en los registros)
  root.querySelectorAll('[data-att]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const w = window.open('', '_blank'); // se abre ya (si no, el navegador lo bloquea por no venir de un clic)
    try {
      const r = await papi('/portal/attachment-link', { token: d.token, number: t.number, id: Number(a.dataset.att) });
      if (w) { w.opener = null; w.location.href = r.url; } else location.href = r.url;
    } catch (er) { if (w) w.close(); toastError(er); }
  }));
  root.querySelectorAll('[data-fb]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await papi('/portal/ticket/feedback', { token: d.token, number, helpful: b.dataset.fb === 'yes' });
      toast(b.dataset.fb === 'yes' ? '¡Gracias! Nos alegra que se haya resuelto' : 'Gracias. Un agente va a continuar el caso');
      ticketView(d.token);
    } catch (er) { toastError(er); }
  }));
  root.querySelector('[data-resolve]')?.addEventListener('click', async () => {
    try { await papi('/portal/ticket/resolve', { token: d.token }); toast('¡Gracias! Marcamos el ticket como resuelto'); ticketView(d.token); } catch (er) { toastError(er); }
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
  window.addEventListener('hashchange', route);
  route();
}

boot();
