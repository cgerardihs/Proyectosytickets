// Envío de correo: por el buzón de Microsoft 365 (si está activo en Configuración) o por Resend.
// Si no hay ninguno configurado, no envía y lo informa.
import { getSetting } from './settings.js';
import { graphSendEnabled, sendViaGraph } from './m365.js';
import { fetchx } from './fetchx.js';
import { inTransaction, onCommit } from './db.js';
import { logError } from './log.js';
import crypto from 'node:crypto';

export const resendEnabled = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
/** Hay algún medio de envío configurado (Resend o buzón de Microsoft 365). */
export const mailEnabled = async () => resendEnabled() || (await graphSendEnabled());

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * URL pública de la app. En producción NUNCA sale del encabezado Host (lo controla quien hace el pedido):
 * APP_URL, o el dominio de producción que informa Vercel.
 */
export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost:3000';
  const proto = req?.headers?.['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function layout(innerHtml, footer = '') {
  const brand = (await getSetting('brand')) || {};
  const color = brand.color || '#C8102E';
  // Outlook (y el envío por Microsoft 365) les saca el margen a los párrafos: se pone en cada uno, para que las líneas
  // en blanco entre párrafos se vean igual en todos los clientes de correo
  innerHtml = String(innerHtml || '')
    .replace(/<p>/g, '<p style="margin:0 0 12px">')
    .replace(/<(ol|ul)>/g, '<$1 style="margin:0 0 12px;padding-left:22px">')
    .replace(/<li>/g, '<li style="margin:0 0 4px">');
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Montserrat,Segoe UI,Arial,sans-serif;color:#1f2937">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <div style="border-top:4px solid ${escapeHtml(color)};background:#fff;border-radius:8px;padding:24px;font-size:14px;line-height:1.55">
      ${innerHtml}
    </div>
    <p style="font-size:12px;color:#6b7280;margin:16px 4px">${footer || escapeHtml(`${brand.name || ''} · ${brand.product || 'Mesa de Ayuda'}`)}</p>
  </div></body></html>`;
}

/**
 * Envía un correo. Devuelve { sent, id, error }.
 * replyTo: dirección a la que vuelven las respuestas (ej. ayuda@empresa.com).
 */
export async function sendMail(msg) {
  // Dentro de una transacción, el correo sale recién después del commit (si se deshace, no se envía nada).
  if (inTransaction()) {
    await onCommit(async () => {
      const r = await deliver(msg);
      if (!r.sent) logError('no se envió un correo diferido', { subject: msg.subject, error: r.error });
    });
    return { sent: true, queued: true };
  }
  return deliver(msg);
}

async function deliver({ to, cc = [], subject, html, replyTo, headers = {}, attachments = [], idempotencyKey }) {
  const recipients = [].concat(to || []).filter(Boolean);
  if (!recipients.length) return { sent: false, error: 'Sin destinatarios' };
  if (await graphSendEnabled()) return sendViaGraph({ to: recipients, cc: cc.filter(Boolean), subject, html, replyTo, attachments });
  if (!resendEnabled()) return { sent: false, error: 'Correo saliente no configurado (RESEND_API_KEY / MAIL_FROM)' };
  try {
    // Con Idempotency-Key, Resend no duplica el correo aunque se reintente: por eso este POST sí se reintenta.
    const key = idempotencyKey || crypto.randomUUID();
    const r = await fetchx('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': String(key).slice(0, 256) },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: recipients,
        cc: cc.filter(Boolean).length ? cc.filter(Boolean) : undefined,
        subject,
        html,
        reply_to: replyTo || process.env.MAIL_REPLY_TO || undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: attachments.length
          ? attachments.map((a) => ({ filename: a.name || a.filename, content: String(a.data || a.content || '').replace(/^data:[^;]+;base64,/, '') }))
          : undefined,
      }),
    }, { service: 'Resend', timeoutMs: 10000, retries: 2, idempotent: true });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { sent: false, error: data?.message || `Resend respondió ${r.status}` };
    return { sent: true, id: data.id };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}
