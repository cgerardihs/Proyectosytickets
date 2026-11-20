// Columnas de la lista de tickets por agente y por vista (v1.20): cuáles se ven, en qué orden y con qué ancho.
import { bad } from './http.js';

/** Columnas que puede tener la lista (mantener alineado con COLDEFS de public/js/views/tickets.js). */
export const TICKET_COLUMNS = ['channel', 'subject', 'contact', 'priority', 'status', 'tech', 'version', 'assignee', 'created', 'category',
  'number', 'company', 'subtech', 'type', 'activity', 'updated', 'sla', 'tags'];
const VIEW_KEY = /^(?:[a-z_]{1,30}|custom:\d{1,9})$/;
/** Columnas de la lista de proyectos (v1.26). Mantener alineado con PCOLDEFS de public/js/views/projects.js. */
export const PROJECT_COLUMNS = ['name', 'type', 'status', 'lead', 'priority', 'open', 'progress', 'end',
  'origin', 'sector', 'area', 'start', 'health', 'hours', 'logged', 'current', 'members', 'tasks', 'sprint', 'created'];
/** Qué columnas valen para cada lista y cuál queda siempre visible. */
export const columnsFor = (key) => (key === 'projects' ? { cols: PROJECT_COLUMNS, lock: 'name' } : { cols: TICKET_COLUMNS, lock: 'subject' });

export function viewKey(raw) {
  const k = String(raw || '');
  if (!VIEW_KEY.test(k)) throw bad('Vista inválida');
  return k;
}

/** Deja solo columnas conocidas, Asunto siempre visible y anchos razonables (60 a 1000 px). */
export function normalizeColumns(raw, { cols = TICKET_COLUMNS, lock = 'subject' } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const known = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => cols.includes(k)))];
  const order = known(r.order);
  for (const k of cols) if (!order.includes(k)) order.push(k);
  const on = known(r.on);
  if (!on.includes(lock)) on.unshift(lock);
  const w = {};
  for (const [k, v] of Object.entries(r.w && typeof r.w === 'object' ? r.w : {})) {
    const n = Math.round(Number(v));
    if (cols.includes(k) && Number.isFinite(n)) w[k] = Math.min(1000, Math.max(60, n));
  }
  return { order, on, w };
}
