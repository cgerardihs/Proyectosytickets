// Correos a los usuarios (v1.13): textos editables en Configuración → Correos a los usuarios.
// Texto simple con variables {{...}}; una línea en blanco separa párrafos. Los valores se escapan siempre.
import { getSetting } from './settings.js';
import { escapeHtml } from './mail.js';

export const TEMPLATE_KEYS = ['created', 'created_portal', 'auto_reply', 'resolved'];

export const TEMPLATE_DEFAULTS = {
  created: {
    subject: '[#{{ticket.numero}}] {{ticket.asunto}}',
    body: 'Hola {{contacto.nombre}},\n\nRecibimos su solicitud y le asignamos el número #{{ticket.numero}}. Le vamos a responder por este medio.',
  },
  created_portal: {
    subject: '[#{{ticket.numero}}] Recibimos su solicitud',
    body: 'Hola {{contacto.nombre}},\n\nRecibimos su solicitud desde el centro de ayuda y le asignamos el número #{{ticket.numero}}. Puede seguirla con el botón de abajo.',
  },
  auto_reply: {
    body: 'Hola {{contacto.nombre}}, recibimos su ticket #{{ticket.numero}}. Mientras un agente lo revisa, le sugerimos:\n\n{{sugerencias}}\n\nSi con esto se resolvió, confírmelo desde el enlace del ticket. Si no, un agente va a continuar el caso.',
  },
  resolved: {
    subject: '[#{{ticket.numero}}] {{ticket.asunto}}',
    body: 'Hola {{contacto.nombre}},\n\nMarcamos como resuelto su ticket #{{ticket.numero}}. Si necesita algo más, responda este correo y lo reabrimos.',
  },
  button: 'Ver el ticket',
  footer: 'Para responder, conteste este correo sin modificar el asunto.',
};

export const TEMPLATE_VARS = {
  'contacto.nombre': 'Nombre de pila del solicitante',
  'contacto.nombre_completo': 'Nombre y apellido',
  'contacto.area': 'Área del solicitante',
  'ticket.numero': 'Número del ticket',
  'ticket.asunto': 'Asunto del ticket',
  empresa: 'Nombre de la empresa (marca)',
  mesa: 'Nombre de la mesa de ayuda (marca)',
  sugerencias: 'Los pasos sugeridos (solo en la respuesta automática)',
};

/**
 * Nombre de pila "presentable": sin signos al final y con mayúscula. Si el nombre es solo el usuario del correo
 * (ej. "admin" de admin@empresa.com), no se usa (queda "Hola,").
 */
export function firstName(contact) {
  const full = String(contact?.name || '').replace(/[<>{}\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  const bare = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\d]/gu, '');
  const email = String(contact?.email || '').toLowerCase();
  if (!full || bare(full) === bare(email.split('@')[0]) || full.toLowerCase() === email) return '';
  const w = full.split(' ')[0].replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  return w ? w[0].toLocaleUpperCase('es') + w.slice(1) : '';
}

/** Plantillas vigentes (las guardadas, completadas con las de fábrica). */
export async function mailTemplates() {
  const hd = (await getSetting('helpdesk')) || {};
  const saved = hd.mail_templates || {};
  const out = {};
  for (const k of TEMPLATE_KEYS) out[k] = { ...TEMPLATE_DEFAULTS[k], ...Object.fromEntries(Object.entries(saved[k] || {}).filter(([, val]) => typeof val === 'string' && val.trim())) };
  out.button = String(saved.button || '').trim() || TEMPLATE_DEFAULTS.button;
  out.footer = saved.footer === undefined ? TEMPLATE_DEFAULTS.footer : String(saved.footer || '');
  return out;
}

function values(ctx, brand) {
  const c = ctx.contact || {};
  const t = ctx.ticket || {};
  return {
    'contacto.nombre': firstName(c),
    'contacto.nombre_completo': String(c.name || '').trim(),
    'contacto.area': String(c.area || '').trim(),
    'ticket.numero': String(t.number ?? ''),
    'ticket.asunto': String(t.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
    empresa: brand.name || '',
    mesa: brand.product || 'Mesa de Ayuda',
  };
}

const fill = (text, vals) => String(text || '').replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (m, k) => (Object.hasOwn(vals, k) ? vals[k] : m));

/** "Hola ," → "Hola," (cuando no hay nombre de pila). */
const tidy = (s) => s.replace(/\s+,/g, ',').replace(/ {2,}/g, ' ');

/** Asunto: texto plano, una línea, siempre con [#número] para que las respuestas vuelvan al ticket. */
export function renderSubject(tpl, ctx, brand = {}) {
  let s = tidy(fill(tpl, values(ctx, brand))).replace(/[\r\n]+/g, ' ').trim().slice(0, 250);
  const tag = `[#${ctx.ticket?.number}]`;
  if (ctx.ticket?.number && !s.includes(tag)) s = `${tag} ${s}`.trim();
  return s || tag;
}

/** Cuerpo: párrafos de texto (escapado). {{sugerencias}} se reemplaza por el HTML de los pasos (lo arma el sistema). */
export function renderBody(tpl, ctx, brand = {}) {
  const vals = values(ctx, brand);
  const esc = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, escapeHtml(v)]));
  const parts = String(tpl || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => {
    if (/^\{\{\s*sugerencias\s*\}\}$/i.test(p)) return ctx.sugerencias || '';
    const html = tidy(fill(escapeHtml(p), esc)).replace(/\n/g, '<br>');
    return `<p>${html.replace(/\{\{\s*sugerencias\s*\}\}/gi, ctx.sugerencias || '')}</p>`;
  }).join('');
}

/** Arma { subject, html } de una plantilla. */
export async function renderMail(key, ctx) {
  const [tpls, brand] = await Promise.all([mailTemplates(), getSetting('brand').then((b) => b || {}).catch(() => ({}))]);
  const tpl = tpls[key];
  return { subject: tpl.subject ? renderSubject(tpl.subject, ctx, brand) : null, html: renderBody(tpl.body, ctx, brand) };
}
