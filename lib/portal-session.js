// Sesión del portal para empleados que ingresan con su cuenta de Microsoft (v1.10.0).
// No es una sesión de agente: solo deja ver y responder los tickets propios en el portal.
// Vive en una cookie HttpOnly firmada con la misma época que los enlaces del portal:
// "Anular todos los enlaces del portal" también cierra estas sesiones.
import { q, one } from './db.js';
import { HttpError, notFound, parseCookies, int, isEmail } from './http.js';
import { isSecure } from './auth.js';
import { portalSign, verifyPortalToken } from './tickets-core.js';
import { getSetting } from './settings.js';
import { m365Config } from './m365.js';

export const PORTAL_SESSION_HOURS = 12;
const NAME_SECURE = '__Host-hd_portal';
const NAME_DEV = 'hd_portal';

const cookieName = (req) => (isSecure(req) ? NAME_SECURE : NAME_DEV);

function buildCookie(req, value, maxAge) {
  return `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}; Max-Age=${maxAge}`;
}

/** ¿El portal ofrece ingresar con Microsoft? Hace falta la app de Entra conectada y la opción encendida. */
export async function portalMicrosoft() {
  const [c, hd] = await Promise.all([m365Config().catch(() => null), getSetting('helpdesk').catch(() => null)]);
  if (!c || !c.connected || hd?.portal_enabled === false || hd?.portal_microsoft === false) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.tenant)) return null;
  return c;
}

/**
 * ¿Es una cuenta invitada (B2B)? Las invitadas no entran al portal: su atributo "email" puede venir de otro
 * tenant sin verificar. Se reconocen por el #EXT# del UPN, el proveedor de identidad (idp) de otro tenant o acct=1.
 */
export function isGuestAccount(claims, tenant) {
  const upn = String(claims.preferred_username || claims.upn || '').toLowerCase();
  if (upn.includes('#ext#')) return true;
  if (Number(claims.acct) === 1) return true;
  if (claims.idp && !String(claims.idp).toLowerCase().includes(String(tenant || '').toLowerCase())) return true;
  return false;
}

/**
 * Correos de la cuenta (solo miembros del tenant: los administra la empresa). Primero el correo principal (mail),
 * que es el que usa la sincronización del directorio; después el nombre de usuario (UPN) si es distinto.
 */
export function sessionEmails(claims) {
  const list = [claims.email, claims.preferred_username, claims.upn]
    .map((x) => String(x || '').trim().toLowerCase().slice(0, 254))
    .filter((x) => isEmail(x) && !x.includes('#ext#'));
  return [...new Set(list)].slice(0, 3);
}

/** Abre la sesión del portal. Devuelve el Set-Cookie. */
export async function createPortalSession(req, { oid, emails, name }) {
  const token = await portalSign({ k: 'ps', o: String(oid).slice(0, 64), e: emails, n: String(name || '').slice(0, 120) }, PORTAL_SESSION_HOURS * 3600);
  return buildCookie(req, token, PORTAL_SESSION_HOURS * 3600);
}

export const clearPortalSession = (req) => buildCookie(req, '', 0);

/** Sesión vigente del portal o null. */
export async function portalSession(req) {
  const raw = parseCookies(req)[cookieName(req)];
  if (!raw) return null;
  const t = await verifyPortalToken(raw, ['ps']);
  if (!t || !t.o || !Array.isArray(t.e) || !t.e.length) return null;
  // Si se apaga el ingreso con Microsoft del portal (o se desconecta Microsoft 365), las sesiones abiertas dejan de valer
  if (!(await portalMicrosoft())) return null;
  return { oid: t.o, emails: t.e, name: t.n || '', email: t.e[0] };
}

/**
 * Contactos que son esa persona: por el identificador de Entra (directorio) o, si el contacto no está vinculado a
 * ninguna cuenta, por sus correos. Un contacto vinculado a OTRA cuenta no se toma aunque el correo coincida
 * (correo reasignado a otra persona: no ve los tickets del anterior).
 */
export async function sessionContactIds(s) {
  if (!s) return [];
  const rows = await q('select id from contacts where external_id=$1 or (external_id is null and email = any($2::text[]))', [s.oid, s.emails]);
  return rows.map((r) => r.id);
}

/** Correo y nombre con los que la sesión abre tickets: el contacto del directorio si existe; si no, su correo principal. */
export async function sessionRequester(s) {
  const own = await one('select email,name from contacts where external_id=$1 and coalesce(active, true) order by id limit 1', [s.oid]);
  if (own) return { email: own.email, name: own.name || s.name };
  const clash = await one('select external_id from contacts where email=$1', [s.email]);
  if (clash?.external_id && clash.external_id !== s.oid) {
    throw new HttpError(409, 'Su cuenta no coincide con el contacto registrado con ese correo. Avise a la mesa de ayuda.');
  }
  return { email: s.email, name: s.name };
}

/**
 * Acceso a un ticket desde el portal: con el enlace del ticket ('pt'), con el enlace de "mis tickets" por correo ('pc')
 * o, sin enlace, con la sesión de Microsoft (el ticket tiene que ser de esa persona). Devuelve { ticket, contact, tok }.
 */
export async function portalAccess(req, token, number) {
  if (token) {
    const t = await verifyPortalToken(token, ['pt', 'pc']);
    if (!t) throw new HttpError(401, 'El enlace venció o no es válido. Pedí uno nuevo.');
    if (t.k === 'pt') {
      const ticket = await one('select * from tickets where id=$1 and deleted_at is null', [t.t]);
      if (!ticket) throw notFound('No existe el ticket');
      // El enlace vale solo para el solicitante actual del ticket
      if (ticket.contact_id !== t.c) throw new HttpError(401, 'Este enlace ya no es válido para el ticket. Pedí uno nuevo.');
      const contact = await one('select * from contacts where id=$1', [t.c]);
      return { ticket, contact, tok: { ...t, raw: token } };
    }
    if (t.k === 'pc' && number) {
      const ticket = await one('select * from tickets where number=$1 and contact_id=$2 and deleted_at is null', [int(number), t.c]);
      if (!ticket) throw notFound('No existe el ticket');
      const contact = await one('select * from contacts where id=$1', [t.c]);
      return { ticket, contact, tok: { ...t, raw: token } };
    }
    throw new HttpError(401, 'Enlace inválido');
  }
  const s = await portalSession(req);
  if (!s) throw new HttpError(401, 'Tu sesión venció. Volvé a ingresar con tu cuenta de Microsoft.');
  if (!number) throw notFound('No existe el ticket');
  const ids = await sessionContactIds(s);
  const ticket = ids.length
    ? await one('select * from tickets where number=$1 and contact_id = any($2::int[]) and deleted_at is null and not spam', [int(number), ids])
    : null;
  if (!ticket) throw notFound('No encontramos ese ticket entre sus solicitudes');
  const contact = await one('select * from contacts where id=$1', [ticket.contact_id]);
  return { ticket, contact, tok: { k: 'ps' } };
}
