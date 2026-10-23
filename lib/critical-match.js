// Problema conocido (v1.13.1): un ticket nuevo que menciona un sistema crítico con un problema informado se vincula solo
// a ese problema y el usuario recibe el aviso "ya lo sabemos, resolución estimada…" en lugar del correo genérico.
import { q, one } from './db.js';
import { getSetting } from './settings.js';

export const normText = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim()} `;

/**
 * Palabras para reconocer un sistema. Con palabras configuradas (Configuración → Sistemas críticos), se buscan en el
 * asunto y en el texto. Sin palabras, se usa el nombre (completo y su primera palabra) y solo en el asunto: así un
 * sistema llamado "Correo" no se engancha con cualquier mensaje que diga "les envío este correo".
 */
export function systemWords(sys) {
  const own = (sys.keywords || []).map((k) => normText(k).trim()).filter((k) => k.length >= 2);
  if (own.length) return { subject: own, body: own };
  const name = normText(String(sys.name || '').replace(/\(.*?\)/g, ' ')).trim();
  const first = name.split(' ')[0];
  return { subject: [...new Set([name, ...(first && first.length >= 3 ? [first] : [])])].filter(Boolean), body: [] };
}

const has = (hay, words) => words.some((w) => hay.includes(` ${w} `));

/** Sistema con un problema informado al que apunta el ticket (o null). */
export async function findKnownIssue({ subject = '', text = '', techCategoryId = null, exclude = [] }) {
  const systems = await q(`select * from critical_systems where active and state<>'ok' order by
    case state when 'down' then 0 when 'degraded' then 1 else 2 end, sort, id`);
  const { withoutSignature } = await import('./ai.js');
  const S = normText(subject);
  const B = normText(withoutSignature(text));
  for (const s of systems) {
    if (exclude.includes(s.id)) continue;
    const w = systemWords(s);
    if ((techCategoryId && s.tech_category_id === Number(techCategoryId)) || has(S, w.subject) || has(B, w.body)) return s;
  }
  return null;
}

/** "hoy 14:30 hs", "mañana 09:00 hs" o "vie 24 oct 10:00 hs", en la zona horaria de la mesa. */
export function etaLabel(eta, tz = 'America/Argentina/Buenos_Aires') {
  if (!eta) return 'a confirmar';
  const d = new Date(eta);
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: tz });
  const hour = d.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const now = new Date();
  if (day(d) === day(now)) return `hoy ${hour} hs`;
  if (day(d) === day(new Date(now.getTime() + 86400000))) return `mañana ${hour} hs`;
  return `${d.toLocaleDateString('es-AR', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' })} ${hour} hs`;
}

export const STATE_TEXT = { down: 'caído', degraded: 'funcionando con problemas', maint: 'en mantenimiento' };

/**
 * Si el ticket nuevo menciona un sistema con un problema informado, lo vincula (marcado como automático).
 * dismissed: sistemas que la persona descartó en el portal ("Mi problema es otro"). Devuelve el sistema o null.
 */
export async function linkKnownIssue(ticket, { text = '', dismissed = [] } = {}) {
  const hd = (await getSetting('helpdesk')) || {};
  if (hd.critical_auto_link === false || ticket.channel === 'agent') return null;
  const sys = await findKnownIssue({ subject: ticket.subject, text, techCategoryId: ticket.tech_category_id, exclude: dismissed.map(Number) });
  if (!sys) return null;
  const done = await one(`insert into critical_system_tickets(system_id,ticket_id,auto) values ($1,$2,true) on conflict do nothing returning system_id`, [sys.id, ticket.id]);
  if (!done) return null;
  const { logActivity } = await import('./tickets-core.js');
  await logActivity(ticket.id, null, 'critical_linked', { system: sys.name, auto: true });
  return sys;
}
