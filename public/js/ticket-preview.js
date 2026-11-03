// Vista previa de la última actividad de un ticket (v1.18): al dejar el mouse sobre el asunto en la lista (0,7 s) o al
// llegar con Tab, aparece un recuadro con quién hizo lo último, qué, cuándo y el texto. Prefijo CSS tpv-.
import { api, esc, icon, relTime, fmtDateTime, navigate, avatar } from './core.js';

const DELAY = 700;
const CACHE_MS = 60 * 1000;
const KIND = {
  created: ['creó el ticket', 'tpv-k-created', 'CORREO'],
  customer: ['respondió', 'tpv-k-customer', 'DEL USUARIO'],
  reply: ['respondió al usuario', 'tpv-k-reply', 'RESPUESTA'],
  note: ['agregó una nota privada', 'tpv-k-note', 'NOTA PRIVADA'],
  forward: ['reenvió el ticket', 'tpv-k-forward', 'REENVÍO'],
};
const cache = new Map();
let box = null;

function el() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'tpv';
  box.id = 'ticket-preview';
  box.setAttribute('role', 'tooltip');
  document.body.appendChild(box);
  return box;
}
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
const hue = (n) => { let h = 0; for (const ch of String(n)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 55% 42%)`; };

/** Se guarda un minuto; la clave incluye la última actividad que muestra la lista, así un ticket con novedades se vuelve a pedir. */
async function load(num, key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await api(`/tickets/${num}/preview`);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function html(d) {
  const l = d.last;
  if (!l) return `<div class="tpv-head"><b>#${d.number} · ${esc(d.subject)}</b></div><p class="tpv-empty">Todavía no tiene mensajes.</p>`;
  const k = KIND[l.kind] || KIND.customer;
  return `<div class="tpv-head"><b>#${d.number} · ${esc(d.subject)}</b><span>${d.messages} mensaje${d.messages === 1 ? '' : 's'}</span></div>
    <div class="tpv-who">${l.user_id ? avatar(l.user_id, 34) : `<span class="tpv-av" style="background:${hue(l.author)}">${esc(initials(l.author))}</span>`}
      <div><div><b>${esc(l.author)}</b> ${k[0]} <span class="tpv-kind ${k[1]}">${k[2]}</span></div>
      <div class="tpv-when">${esc(relTime(l.at))} · ${esc(fmtDateTime(l.at))}</div></div></div>
    ${l.text ? `<div class="tpv-body ${l.kind === 'note' ? 'tpv-note' : ''}">${esc(l.text)}</div>` : '<p class="tpv-empty">(sin texto)</p>'}
    ${d.files || d.images || d.waiting ? `<div class="tpv-meta">${d.files ? `<span>${icon('clip', 12)} ${d.files} adjunto${d.files === 1 ? '' : 's'}</span>` : ''}${d.images ? `<span>${icon('image', 12)} ${d.images} imagen${d.images === 1 ? '' : 'es'}</span>` : ''}${d.waiting ? `<span class="tpv-wait">${icon('clock', 12)} El usuario espera respuesta</span>` : ''}</div>` : ''}
    <div class="tpv-foot"><a href="#/tickets/${d.number}" data-tpv-open>Abrir el ticket</a><span>Esc para cerrar</span></div>`;
}

function place(anchor) {
  const b = el();
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 8;
  if (top + b.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - b.offsetHeight - 8);
  b.style.top = `${top}px`;
  b.style.left = `${Math.min(Math.max(12, r.left), window.innerWidth - b.offsetWidth - 12)}px`;
}

/**
 * Activa la vista previa en una lista: los enlaces que coinciden con `selector` deben apuntar a #/tickets/<número>.
 * Devuelve una función para desactivarla (se llama al salir de la vista).
 */
export function attachTicketPreview(root, selector = '.subj a[href^="#/tickets/"]') {
  if (!window.matchMedia?.('(hover: hover)').matches) return () => {};
  const b = el();
  let timer = null;
  let hideTimer = null;
  let current = null;
  const num = (a) => Number((a.getAttribute('href') || '').replace(/^#\/tickets\//, ''));
  const close = () => { clearTimeout(timer); b.classList.remove('show'); current?.removeAttribute('aria-describedby'); current = null; };
  const open = async (a) => {
    current = a;
    a.setAttribute('aria-describedby', 'ticket-preview');
    const n = num(a);
    const key = `${n}|${a.dataset.pv || ''}`;
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at >= CACHE_MS) {
      b.innerHTML = '<div class="tpv-load"><span class="spinner"></span> Cargando la última actividad…</div>';
      b.classList.add('show');
      place(a);
    }
    try {
      const d = await load(n, key);
      if (current !== a) return;
      b.innerHTML = html(d);
      b.classList.add('show');
      place(a);
    } catch {
      if (current === a) { b.innerHTML = '<p class="tpv-empty">No se pudo cargar la vista previa.</p>'; place(a); }
    }
  };
  const over = (e) => {
    const a = e.target.closest(selector);
    if (a && root.contains(a)) {
      clearTimeout(hideTimer);
      if (current !== a) { clearTimeout(timer); timer = setTimeout(() => open(a), DELAY); }
      return;
    }
    if (e.target.closest('.tpv')) { clearTimeout(hideTimer); return; }
    clearTimeout(timer);
    if (current) { clearTimeout(hideTimer); hideTimer = setTimeout(close, 200); }
  };
  const focusIn = (e) => { const a = e.target.closest(selector); if (a && root.contains(a)) { clearTimeout(timer); open(a); } };
  const focusOut = (e) => { if (e.target.closest(selector)) setTimeout(() => { if (!b.matches(':hover') && !b.contains(document.activeElement)) close(); }, 120); };
  const key = (e) => { if (e.key === 'Escape' && current) close(); };
  const click = (e) => {
    if (e.target.closest(selector)) return close();
    const go = e.target.closest('[data-tpv-open]');
    if (go) { e.preventDefault(); close(); navigate(go.getAttribute('href')); }
  };
  const scroll = () => { if (current) close(); };
  document.addEventListener('mouseover', over);
  root.addEventListener('focusin', focusIn);
  root.addEventListener('focusout', focusOut);
  document.addEventListener('keydown', key);
  document.addEventListener('click', click);
  window.addEventListener('scroll', scroll, true);
  window.addEventListener('hashchange', close);
  return () => {
    close();
    document.removeEventListener('mouseover', over);
    root.removeEventListener('focusin', focusIn);
    root.removeEventListener('focusout', focusOut);
    document.removeEventListener('keydown', key);
    document.removeEventListener('click', click);
    window.removeEventListener('scroll', scroll, true);
    window.removeEventListener('hashchange', close);
  };
}

