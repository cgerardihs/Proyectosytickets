// Núcleo del front: API, estado, formato, componentes básicos (modal, toast, editor, íconos).

export const state = { meta: null, me: null, counts: {}, unread: 0 };

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** Clave de idempotencia: se genera una por formulario/acción, así un doble clic o un reintento no duplica. */
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export async function api(path, { method = 'GET', body, raw = false, idempotencyKey } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (idempotencyKey) opts.headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`/api${path}`, opts);
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/setup')) {
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
    let msg = data?.error || `Error ${res.status}`;
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After'));
      if (wait) msg += ` (podés reintentar en ${wait > 90 ? `${Math.ceil(wait / 60)} min` : `${wait} s`})`;
    }
    if (res.status >= 500 && data?.request_id) msg += ` · Código: ${String(data.request_id).slice(0, 8)}`;
    throw new ApiError(res.status, msg, data);
  }
  return data;
}

// ---------- Texto y HTML ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG', 'SPAN', 'DIV', 'HR', 'SUB', 'SUP', 'FONT', 'CENTER', 'SMALL']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'META', 'LINK', 'HEAD', 'TITLE', 'SVG', 'MATH', 'NOSCRIPT', 'TEMPLATE']);

/**
 * Sanitiza HTML (correos entrantes, notas) con lista blanca.
 * blockRemote: las imágenes de otros sitios no se cargan solas (un "píxel" avisaría al remitente cuándo y desde qué IP se abrió);
 * quedan en data-remote-src hasta que alguien toca "Mostrar imágenes" (ver showRemoteImages).
 */
export function sanitize(html, { blockRemote = false } = {}) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstChild;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      if (DROP.has(child.tagName)) { child.remove(); continue; }
      if (!ALLOWED.has(child.tagName)) {
        walk(child);
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase();
        const v = attr.value.trim();
        const keep =
          (n === 'href' && child.tagName === 'A' && /^(https?:|mailto:|#)/i.test(v)) ||
          (n === 'src' && child.tagName === 'IMG' && /^(https:|data:image\/(png|jpe?g|gif|webp);)/i.test(v)) ||
          ['colspan', 'rowspan', 'alt', 'title'].includes(n);
        if (!keep) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
      if (child.tagName === 'IMG') {
        child.setAttribute('referrerpolicy', 'no-referrer');
        const src = child.getAttribute('src') || '';
        if (blockRemote && /^https:/i.test(src)) {
          child.removeAttribute('src');
          child.setAttribute('data-remote-src', src);
          child.setAttribute('class', 'remote-img');
          if (!child.getAttribute('alt')) child.setAttribute('alt', 'Imagen externa');
        }
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

/** Carga las imágenes externas bloqueadas de un mensaje (sin enviar de qué página viene el pedido). */
export function showRemoteImages(container) {
  for (const img of container.querySelectorAll('img[data-remote-src]')) {
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.src = img.dataset.remoteSrc;
    img.removeAttribute('data-remote-src');
    img.classList.remove('remote-img');
  }
}

export const plain = (html) => {
  const d = document.createElement('div');
  d.innerHTML = sanitize(html);
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
};

// ---------- Fechas ----------
const TZ = () => state.meta?.helpdesk?.timezone || 'America/Argentina/Buenos_Aires';
export function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('es-AR', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' hs';
}
export function fmtDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d;
  return new Date(s).toLocaleDateString('es-AR', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function fmtShortDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d;
  return new Date(s).toLocaleDateString('es-AR', { timeZone: TZ(), day: 'numeric', month: 'short' });
}
export function relTime(d) {
  if (!d) return '';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  const fut = diff < 0;
  const a = Math.abs(diff);
  let s;
  if (a < 60) return fut ? 'en menos de 1 min' : 'recién';
  else if (a < 3600) s = `${Math.round(a / 60)} min`;
  else if (a < 86400) { const h = Math.round(a / 3600); s = `${h} ${h === 1 ? 'hora' : 'horas'}`; }
  else if (a < 86400 * 45) { const dd = Math.round(a / 86400); s = `${dd} ${dd === 1 ? 'día' : 'días'}`; }
  else { const m = Math.round(a / (86400 * 30)); s = `${m} ${m === 1 ? 'mes' : 'meses'}`; }
  return fut ? `en ${s}` : `hace ${s}`;
}
export const fmtMinutes = (m) => {
  m = Number(m || 0);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
};
export const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ() });
export const fmtNum = (n, dec = 0) => Number(n ?? 0).toLocaleString('es-AR', { maximumFractionDigits: dec, minimumFractionDigits: 0 });

// ---------- Lookups ----------
const byId = (list, id) => (list || []).find((x) => x.id === Number(id));
export const userById = (id) => byId(state.meta?.users, id);
export const userName = (id) => userById(id)?.name || '';
export const groupName = (id) => byId(state.meta?.groups, id)?.name || '';
export const subtechName = (id) => byId(state.meta?.techSubcategories, id)?.name || '';

/** Nombre de cada campo del ticket. El superadmin lo puede cambiar (Configuración → Campos del ticket). */
export const FIELD_LABEL_DEFAULTS = {
  status: 'Estado', priority: 'Prioridad', category: 'Área solicitante', type: 'Tipo de ticket', tech: 'Categoría técnica', subtech: 'Subcategoría técnica',
  assignee: 'Asignado a', contact: 'Contacto', channel: 'Canal', sla: 'SLA',
};
export const fieldLabel = (key) => state.meta?.fieldLabels?.[key] || FIELD_LABEL_DEFAULTS[key] || key;
export const categoryName = (id) => byId(state.meta?.categories, id)?.name || '';
export const typeName = (id) => byId(state.meta?.types, id)?.name || '';
export const techName = (id) => byId(state.meta?.techCategories, id)?.name || '';
export const statusById = (id) => byId(state.meta?.statuses, id);
export const slaName = (id) => byId(state.meta?.slas, id)?.name || '';
export const PRIORITY = { 1: 'Baja', 2: 'Media', 3: 'Alta', 4: 'Urgente' };
export const PRIORITY_COLOR = { 1: '#16a34a', 2: '#2563eb', 3: '#ea580c', 4: '#dc2626' };
export const CHANNEL = { email: 'Correo', portal: 'Portal', phone: 'Teléfono', agent: 'Agente', teams: 'Teams', api: 'API', chat: 'Chat' };
export const CHANNEL_ICON = { email: 'mail', portal: 'globe', phone: 'phone', agent: 'user', teams: 'message', api: 'zap', chat: 'message' };
export const isSuper = () => state.me?.role === 'superadmin';
export const isManager = () => ['superadmin', 'admin', 'supervisor'].includes(state.me?.role);
export const isAdmin = () => ['superadmin', 'admin'].includes(state.me?.role);
/** Borrado definitivo: superadmin (o admin si no hay superadmin configurado). */
export const canPurge = () => isSuper() || (isAdmin() && !state.meta?.superadminEnabled);
export const canManageAdmins = () => isSuper() || (isAdmin() && !state.meta?.superadminEnabled);
export const ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Administrador', supervisor: 'Supervisor', agent: 'Agente' };

export function priorityBadge(p) {
  return `<span class="prio prio-${Number(p)}"><i style="background:${PRIORITY_COLOR[p]}"></i>${PRIORITY[p] || '—'}</span>`;
}
export function statusBadge(statusId) {
  const s = statusById(statusId);
  if (!s) return '<span class="badge">—</span>';
  return `<span class="badge" style="--c:${esc(s.color)}">${esc(s.name)}</span>`;
}
export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
}
export function avatar(userOrId, size = 26, title = true) {
  const u = typeof userOrId === 'object' ? userOrId : userById(userOrId);
  if (!u) return `<span class="avatar none" style="width:${size}px;height:${size}px" ${title ? 'title="Sin asignar"' : ''}>${icon('user', size * 0.55)}</span>`;
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${esc(u.color || '#475569')}" ${title ? `title="${esc(u.name)}"` : ''}>${esc(initials(u.name))}</span>`;
}

/** Estado del SLA para mostrar: { label, cls } */
export function slaState(t) {
  const st = statusById(t.status_id);
  const kind = t.status_kind || st?.kind;
  if (!t.resolution_due && !t.first_response_due) return null;
  if (kind === 'resolved' || kind === 'closed') {
    if (t.resolution_due && t.resolved_at) return new Date(t.resolved_at) <= new Date(t.resolution_due) ? { label: 'Dentro del SLA', cls: 'ok' } : { label: 'Fuera del SLA', cls: 'late' };
    return null;
  }
  const now = Date.now();
  if (!t.first_responded_at && t.first_response_due) {
    const d = new Date(t.first_response_due).getTime();
    if (d < now) return { label: '1ª respuesta vencida', cls: 'late' };
  }
  if (t.resolution_due) {
    const d = new Date(t.resolution_due).getTime();
    if (d < now) return { label: 'Vencido', cls: 'late' };
    if (d - now < 4 * 3600 * 1000) return { label: `Vence ${relTime(t.resolution_due)}`, cls: 'warn' };
    return { label: `Vence ${relTime(t.resolution_due)}`, cls: 'fine' };
  }
  return null;
}

// ---------- Íconos (trazos estilo Lucide) ----------
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  projects: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M8 10v4M12 10v2M16 10v6"/>',
  mywork: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  forward: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  board: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18M15 3v18"/>',
  backlog: '<rect width="18" height="4" x="3" y="3" rx="1"/><rect width="18" height="4" x="3" y="10" rx="1"/><rect width="18" height="4" x="3" y="17" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bug: '<path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkbox: '<rect width="18" height="18" x="3" y="3" rx="3"/><path d="m8 12 3 3 5-6"/>',
  subtask: '<path d="M4 4v10a2 2 0 0 0 2 2h8"/><path d="m11 12 4 4-4 4"/><rect width="7" height="6" x="13" y="2" rx="1"/>',
  grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  play: '<path d="M6 3l14 9-14 9V3z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  equal: '<path d="M5 9h14M5 15h14"/>',
  timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  portfolio: '<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  gantt: '<path d="M3 3v18h18"/><path d="M7 7h7M10 12h9M7 17h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};
export function icon(name, size = 18, cls = '') {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------- Toast ----------
export function toast(msg, type = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `${icon(type === 'error' ? 'alert' : 'check', 16)}<span>${esc(msg)}</span>`;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}
export const toastError = (e) => toast(e?.message || String(e), 'error');

// ---------- Modal ----------
export function modal({ title, body = '', wide = false, size = '', footer = '', onClose, dismissable = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${size}" role="dialog" aria-modal="true" aria-label="${esc(title || '')}">
    ${title !== null ? `<div class="modal-head"><h3>${esc(title || '')}</h3><button class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button></div>` : ''}
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
  </div>`;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable && document.querySelector('.modal-backdrop:last-of-type') === wrap) close(); };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && dismissable) close(); });
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  const first = wrap.querySelector('input:not([type=hidden]),textarea,select,[contenteditable]');
  setTimeout(() => first?.focus(), 30);
  return { el: wrap.querySelector('.modal'), root: wrap, close };
}

export function confirmDialog(message, { title = 'Confirmar', okText = 'Aceptar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p class="confirm-text">${esc(message)}</p>`,
      footer: `<button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { done = true; m.close(); resolve(true); });
    setTimeout(() => m.el.querySelector('[data-ok]').focus(), 40);
  });
}

export function promptDialog(label, { title = '', value = '', okText = 'Aceptar', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: title || label,
      body: `<label class="field"><span>${esc(label)}</span><input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
      footer: `<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>${esc(okText)}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const input = m.el.querySelector('input');
    const ok = () => { done = true; const v = input.value.trim(); m.close(); resolve(v); };
    m.el.querySelector('[data-ok]').addEventListener('click', ok);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  });
}

// ---------- Menú contextual ----------
export function popover(anchor, html, { align = 'left', onClick } = {}) {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  const p = document.createElement('div');
  p.className = 'popover';
  p.innerHTML = html;
  document.body.appendChild(p);
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + p.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - p.offsetHeight - 4);
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
  const close = () => { p.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key); };
  const outside = (e) => { if (!p.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key); });
  p.addEventListener('click', (e) => {
    const item = e.target.closest('[data-value]');
    if (item && onClick) { onClick(item.dataset.value, item); close(); }
  });
  return { el: p, close };
}

// ---------- Archivos ----------
export const MAX_FILE = 3 * 1024 * 1024;
export function readFiles(fileList) {
  return Promise.all(
    [...fileList].map(
      (f) => new Promise((resolve, reject) => {
        if (f.size > MAX_FILE) return reject(new Error(`${f.name} supera los 3 MB`));
        const r = new FileReader();
        r.onload = () => resolve({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, data: String(r.result).split(',')[1] });
        r.onerror = () => reject(new Error(`No se pudo leer ${f.name}`));
        r.readAsDataURL(f);
      }),
    ),
  );
}
export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------- Editor enriquecido ----------
export function richEditor(host, { placeholder = 'Escribí acá…', value = '', minHeight = 120, attachments = true, onSubmit } = {}) {
  host.classList.add('rte');
  host.innerHTML = `
    <div class="rte-bar">
      <button type="button" data-cmd="bold" title="Negrita">B</button>
      <button type="button" data-cmd="italic" title="Cursiva"><i>I</i></button>
      <button type="button" data-cmd="underline" title="Subrayado"><u>U</u></button>
      <span class="rte-sep"></span>
      <button type="button" data-cmd="insertUnorderedList" title="Viñetas">•</button>
      <button type="button" data-cmd="insertOrderedList" title="Numeración">1.</button>
      <button type="button" data-cmd="formatBlock" data-arg="blockquote" title="Cita">❝</button>
      <button type="button" data-cmd="formatBlock" data-arg="pre" title="Código">&lt;/&gt;</button>
      <button type="button" data-cmd="createLink" title="Enlace">${icon('link', 14)}</button>
      <button type="button" data-cmd="removeFormat" title="Quitar formato">${icon('x', 14)}</button>
      ${attachments ? `<span class="rte-sep"></span><label class="rte-attach" title="Adjuntar archivos">${icon('clip', 14)}<input type="file" multiple hidden></label>` : ''}
    </div>
    <div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="${esc(placeholder)}" style="min-height:${minHeight}px"></div>
    <div class="rte-files"></div>`;
  const area = host.querySelector('.rte-area');
  const filesBox = host.querySelector('.rte-files');
  let files = [];
  area.innerHTML = sanitize(value);
  const renderFiles = () => {
    filesBox.innerHTML = files.map((f, i) => `<span class="chip">${icon('clip', 12)} ${esc(f.name)} <small>${fmtSize(f.size)}</small><button type="button" data-rm="${i}" aria-label="Quitar">${icon('x', 12)}</button></span>`).join('');
  };
  host.querySelector('.rte-bar').addEventListener('mousedown', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (!b) return;
    e.preventDefault();
    const cmd = b.dataset.cmd;
    if (cmd === 'createLink') {
      const url = window.prompt('Dirección del enlace (https://…)');
      if (url && /^(https?:|mailto:)/i.test(url)) document.execCommand('createLink', false, url);
      return;
    }
    document.execCommand(cmd, false, b.dataset.arg || null);
    area.focus();
  });
  const fileInput = host.querySelector('input[type=file]');
  fileInput?.addEventListener('change', async () => {
    try {
      files = files.concat(await readFiles(fileInput.files));
      renderFiles();
    } catch (e) { toastError(e); }
    fileInput.value = '';
  });
  filesBox.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { files.splice(Number(rm.dataset.rm), 1); renderFiles(); }
  });
  area.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file');
    if (items.length && attachments) {
      e.preventDefault();
      try {
        const got = await readFiles(items.map((i) => i.getAsFile()).filter(Boolean));
        files = files.concat(got.map((f, i) => ({ ...f, name: f.name === 'image.png' ? `captura-${Date.now()}-${i}.png` : f.name })));
        renderFiles();
      } catch (er) { toastError(er); }
      return;
    }
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitize(html));
    }
  });
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit) { e.preventDefault(); onSubmit(); }
  });
  return {
    area,
    getHTML: () => sanitize(area.innerHTML),
    isEmpty: () => !plain(area.innerHTML) && !area.querySelector('img'),
    setHTML: (h) => { area.innerHTML = sanitize(h); },
    insertHTML: (h) => { area.focus(); document.execCommand('insertHTML', false, sanitize(h)); },
    getFiles: () => files,
    clear: () => { area.innerHTML = ''; files = []; renderFiles(); },
    focus: () => area.focus(),
  };
}

// ---------- Utilidades ----------
export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function options(list, selected, { empty = null, label = (x) => x.name, value = (x) => x.id } = {}) {
  const sel = Array.isArray(selected) ? selected.map(String) : [String(selected ?? '')];
  return (empty !== null ? `<option value="">${esc(empty)}</option>` : '') +
    list.map((x) => `<option value="${esc(value(x))}" ${sel.includes(String(value(x))) ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
}
export function parseHashQuery(hash = location.hash) {
  const i = hash.indexOf('?');
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(hash.slice(i + 1)));
}
export function buildQuery(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
/** Días hábiles entre dos fechas AAAA-MM-DD, ambas incluidas (días laborales y feriados del horario de atención). Igual que lib/workdays.js */
export function businessDays(start, end, cfg = state.meta?.helpdesk) {
  if (!start || !end || end < start) return 0;
  const days = cfg?.business?.days?.length ? cfg.business.days.map(Number) : [1, 2, 3, 4, 5];
  const holidays = new Set(cfg?.holidays || []);
  let n = 0;
  const last = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`), i = 0; t <= last && i < 3700; t += 86400000, i++) {
    const d = new Date(t);
    if (days.includes(d.getUTCDay()) && !holidays.has(d.toISOString().slice(0, 10))) n += 1;
  }
  return n;
}
/** Horas por día hábil para estimar proyectos (Configuración → Portfolio; 8 si no se configuró). */
export const dayHours = (cfg = state.meta?.helpdesk) => { const h = Number(cfg?.portfolio_day_hours); return h > 0 && h <= 24 ? h : 8; };

/** dd/mm/aaaa a partir de aaaa-mm-dd (sin pasar por Date: no cambia de día por la zona horaria). */
export const dmy = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');

/**
 * Par de fechas inicio/fin: el calendario del fin no deja elegir días anteriores al inicio (y al revés)
 * y, si igual quedan cruzadas, se marcan en rojo con un aviso. Devuelve una función que dice si están bien.
 */
export function guardDates(startEl, endEl, msg = 'La fecha de fin no puede ser anterior a la de inicio') {
  if (!startEl || !endEl) return () => true;
  let note = null;
  const check = () => {
    const s = startEl.value;
    const e = endEl.value;
    endEl.min = s || '';
    startEl.max = e || '';
    const wrong = Boolean(s && e && e < s);
    for (const el of [startEl, endEl]) { el.classList.toggle('invalid', wrong); el.setAttribute('aria-invalid', String(wrong)); }
    if (wrong && !note) {
      note = document.createElement('div');
      note.className = 'date-warn';
      note.setAttribute('role', 'alert');
      const host = endEl.closest('.field') || endEl.parentElement;
      host.append(note);
    }
    if (note) { note.hidden = !wrong; note.textContent = wrong ? `${msg}: empieza el ${dmy(s)}` : ''; }
    return !wrong;
  };
  for (const el of [startEl, endEl]) { el.addEventListener('input', check); el.addEventListener('change', check); }
  check();
  return check;
}

export function emptyState(title, text = '', iconName = 'inbox', action = '') {
  return `<div class="empty">${icon(iconName, 36)}<h4>${esc(title)}</h4>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}
export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
/** Aplica la marca (color, nombre) como variables CSS. */
export function applyBrand(brand) {
  const root = document.documentElement;
  if (brand?.color) root.style.setProperty('--brand', brand.color);
  if (brand?.accent) root.style.setProperty('--accent', brand.accent);
  document.title = `${brand?.product || 'Mesa de Ayuda'} · ${brand?.name || ''}`;
}
