// Columnas de la lista de tickets por agente y por vista (v1.20): cuáles se ven, en qué orden y con qué ancho.
import { bad } from './http.js';

/** Columnas que puede tener la lista (mantener alineado con COLDEFS de public/js/views/tickets.js). */
export const TICKET_COLUMNS = ['channel', 'subject', 'contact', 'priority', 'status', 'tech', 'version', 'assignee', 'created', 'category',
  'number', 'company', 'subtech', 'type', 'activity', 'updated', 'sla', 'tags'];
const VIEW_KEY = /^(?:[a-z_]{1,30}|custom:\d{1,9})$/;

export function viewKey(raw) {
  const k = String(raw || '');
  if (!VIEW_KEY.test(k)) throw bad('Vista inválida');
  return k;
}

/** Deja solo columnas conocidas, Asunto siempre visible y anchos razonables (60 a 1000 px). */
export function normalizeColumns(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const known = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => TICKET_COLUMNS.includes(k)))];
  const order = known(r.order);
  for (const k of TICKET_COLUMNS) if (!order.includes(k)) order.push(k);
  const on = known(r.on);
  if (!on.includes('subject')) on.unshift('subject');
  const w = {};
  for (const [k, v] of Object.entries(r.w && typeof r.w === 'object' ? r.w : {})) {
    const n = Math.round(Number(v));
    if (TICKET_COLUMNS.includes(k) && Number.isFinite(n)) w[k] = Math.min(1000, Math.max(60, n));
  }
  return { order, on, w };
}
