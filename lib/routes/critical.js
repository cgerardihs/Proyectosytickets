// Sistemas críticos (v1.11): un agente informa que un sistema está caído, degradado o en mantenimiento y cuándo se
// estima que vuelve. Se ve en el Inicio de los agentes, en cada ticket vinculado y en el estado del portal público.
// No es un monitoreo automático: lo que se publica es lo que informa la mesa de ayuda.
import { q, one, tx } from '../db.js';
import { v, parse, idParam } from '../validate.js';
import { requireUser, isManager } from '../auth.js';
import { bad, notFound, forbidden } from '../http.js';
import { getSetting } from '../settings.js';
import { crud } from '../crud.js';
import { notify, logActivity, emailContact, ticketSubjectTag } from '../tickets-core.js';
import { escapeHtml } from '../mail.js';
import { getByNumber, updateTicket, limitOutgoing } from './tickets.js';

export const CRITICAL_STATES = ['ok', 'degraded', 'down', 'maint'];
export const STATE_LABEL = { ok: 'Operativo', degraded: 'Degradado', down: 'Caído', maint: 'En mantenimiento' };
const MAX_TICKETS = 100;
const MAX_ETA_DAYS = 30;

const helpdesk = async () => (await getSetting('helpdesk')) || {};

/** Opciones (en Configuración → Sistemas críticos). */
export async function criticalOptions() {
  const hd = await helpdesk();
  return {
    portal: hd.critical_portal !== false, // estado en el inicio del portal
    ticket_warning: hd.critical_ticket_warning !== false, // aviso al crear un ticket en el portal
    late_notify: hd.critical_late_notify !== false, // avisar a quien lo informó cuando vence la estimación
    managers_only: hd.critical_managers_only === true, // solo supervisores y administradores informan
    resolve_tickets: hd.critical_resolve_tickets !== false, // al resolver, responder y resolver los tickets vinculados (tildado de fábrica)
  };
}

/** Avisa (una vez) a quien informó el problema que pasó la hora estimada. */
async function notifyLate(opts) {
  if (!opts.late_notify) return;
  const late = await q(`update critical_systems set late_notified_at=now()
    where active and state<>'ok' and eta < now() and (late_notified_at is null or late_notified_at < eta) and reported_by is not null
    returning id, name, reported_by`);
  for (const s of late) {
    await notify([s.reported_by], `Venció la estimación de ${s.name}`, 'Actualizá la hora estimada o marcalo resuelto: el portal muestra "Demorado".', '#/');
  }
}

async function listForAgents() {
  return q(`select s.id,s.name,s.description,s.sort,s.public,s.state,s.eta,s.message,s.since,s.updated_at,s.tech_category_id,
      s.reported_by, u.name as reported_by_name,
      (select count(*)::int from critical_system_tickets l join tickets t on t.id=l.ticket_id where l.system_id=s.id and t.deleted_at is null) as tickets
    from critical_systems s left join users u on u.id=s.reported_by
    where s.active order by s.sort, s.name`);
}

const statusSchema = v.object({
  state: v.enum(CRITICAL_STATES),
  eta: v.string({ max: 40, optional: true, nullable: true }),
  message: v.string({ max: 280, multiline: true, default: '' }),
  tickets: v.array(v.int({ min: 1, max: 999999999 }), { max: MAX_TICKETS, default: () => [] }),
  resolve_tickets: v.bool({ default: false }),
});

/** Al volver a operativo: responde a los solicitantes de los tickets vinculados y los deja resueltos. */
async function resolveLinkedTickets(sys, u, req) {
  const st = await one(`select id from statuses where kind='resolved' and active order by sort limit 1`);
  if (!st) return 0;
  const rows = await q(`select t.* from critical_system_tickets l join tickets t on t.id=l.ticket_id join statuses s on s.id=t.status_id
    where l.system_id=$1 and t.deleted_at is null and not t.spam and s.kind in ('open','pending') order by t.number limit ${MAX_TICKETS}`, [sys.id]);
  if (!rows.length) return 0;
  const withContact = rows.filter((t) => t.contact_id).length;
  if (withContact) await limitOutgoing(u, { recipients: withContact });
  let done = 0;
  for (const t of rows) {
    const contact = t.contact_id ? await one('select * from contacts where id=$1', [t.contact_id]) : null;
    const html = `<p>Hola${contact?.name ? ` ${escapeHtml(contact.name)}` : ''},</p><p>El sistema <b>${escapeHtml(sys.name)}</b> ya funciona normalmente. Damos por resuelto este ticket; si el problema sigue, respondé este correo y lo reabrimos.</p>`;
    const msg = await tx(async () => {
      const m = await one(`insert into ticket_messages(ticket_id,kind,author_user_id,from_email,to_emails,body_html,meta) values ($1,'reply',$2,$3,$4,$5,$6::jsonb) returning id`,
        [t.id, u.id, u.email, contact ? [contact.email] : [], html, JSON.stringify({ critical_system: sys.id })]);
      await q('update tickets set updated_at=now(), last_activity_at=now(), first_responded_at=coalesce(first_responded_at, case when $2 then now() end) where id=$1', [t.id, Boolean(contact)]);
      await updateTicket(await getByNumber(t.number), { status_id: st.id }, u, req, { quietContact: true });
      return m;
    });
    if (contact) {
      await emailContact(t, contact, { subject: `Re: ${await ticketSubjectTag(t)}`, html, req, cc: t.cc || [], idempotencyKey: `msg-${msg.id}` }).catch(() => null);
    }
    await logActivity(t.id, u.id, 'replied', { critical_system: sys.name, resolved: true });
    done += 1;
  }
  return done;
}

export function criticalRoutes(r) {
  // ---------- Agentes ----------
  r.get('/critical-systems', async ({ req }) => {
    const u = await requireUser(req);
    const opts = await criticalOptions();
    await notifyLate(opts);
    return { systems: await listForAgents(), can_report: !opts.managers_only || isManager(u), resolve_tickets: opts.resolve_tickets, now: new Date() };
  });

  r.get('/critical-systems/:id', async ({ req, params }) => {
    await requireUser(req);
    const s = await one('select s.*, u.name as reported_by_name from critical_systems s left join users u on u.id=s.reported_by where s.id=$1', [idParam(params.id)]);
    if (!s) throw notFound('No existe el sistema');
    const [log, tickets] = await Promise.all([
      q(`select l.state,l.eta,l.message,l.tickets,l.created_at,u.name as user_name from critical_system_log l left join users u on u.id=l.user_id
         where l.system_id=$1 order by l.created_at desc, l.id desc limit 20`, [s.id]),
      q(`select t.number,t.subject,st.kind as status_kind from critical_system_tickets l join tickets t on t.id=l.ticket_id left join statuses st on st.id=t.status_id
         where l.system_id=$1 and t.deleted_at is null order by t.number`, [s.id]),
    ]);
    return { system: s, log, tickets };
  });

  r.post('/critical-systems/:id/status', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const opts = await criticalOptions();
    if (opts.managers_only && !isManager(u)) throw forbidden('Solo supervisores y administradores pueden informar problemas de sistemas críticos');
    const b = parse(statusSchema, raw);
    const id = idParam(params.id);
    const sys = await one('select * from critical_systems where id=$1 and active', [id]);
    if (!sys) throw notFound('No existe el sistema');
    let eta = null;
    if (b.state !== 'ok') {
      eta = b.eta ? new Date(b.eta) : null;
      if (!eta || Number.isNaN(eta.getTime())) throw bad('Indicá en cuánto tiempo se estima resolverlo');
      if (eta.getTime() < Date.now() - 60000) throw bad('La hora estimada ya pasó: elegí una hora futura');
      if (eta.getTime() > Date.now() + MAX_ETA_DAYS * 86400000) throw bad(`La estimación puede ser de hasta ${MAX_ETA_DAYS} días`);
    }
    // Tickets: por número; tienen que existir
    const numbers = [...new Set(b.tickets)];
    const found = numbers.length ? await q('select id, number from tickets where number = any($1::int[]) and deleted_at is null', [numbers]) : [];
    const missing = numbers.filter((n) => !found.some((t) => t.number === n));
    if (missing.length) throw bad(`No existe el ticket ${missing.map((n) => `#${n}`).join(', ')}`);

    const wasOk = sys.state === 'ok';
    let resolved = 0;
    if (b.state === 'ok') {
      // Primero se vinculan los tickets que vinieron en el pedido, así también reciben la respuesta
      if (found.length) {
        await q(`insert into critical_system_tickets(system_id,ticket_id,created_by) select $1, unnest($2::int[]), $3 on conflict do nothing`, [id, found.map((t) => t.id), u.id]);
      }
      if (b.resolve_tickets && !wasOk) resolved = await resolveLinkedTickets(sys, u, req);
    }
    await tx(async () => {
      if (b.state === 'ok') {
        await q('delete from critical_system_tickets where system_id=$1', [id]);
        await q(`update critical_systems set state='ok', eta=null, message='', since=null, late_notified_at=null, updated_at=now(), updated_by=$2 where id=$1`, [id, u.id]);
      } else {
        await q('delete from critical_system_tickets where system_id=$1 and not (ticket_id = any($2::int[]))', [id, found.map((t) => t.id)]);
        if (found.length) await q(`insert into critical_system_tickets(system_id,ticket_id,created_by) select $1, unnest($2::int[]), $3 on conflict do nothing`, [id, found.map((t) => t.id), u.id]);
        await q(`update critical_systems set state=$2, eta=$3, message=$4, since=coalesce(case when state='ok' then null else since end, now()),
            reported_by=case when state='ok' then $5 else coalesce(reported_by, $5) end, late_notified_at=null, updated_at=now(), updated_by=$5 where id=$1`,
        [id, b.state, eta, b.message.trim(), u.id]);
      }
      await q('insert into critical_system_log(system_id,user_id,state,eta,message,tickets) values ($1,$2,$3,$4,$5,$6)',
        [id, u.id, b.state, eta, b.state === 'ok' ? '' : b.message.trim(), b.state === 'ok' ? resolved : found.length]);
      // Al equipo: cuando un sistema empieza a fallar y cuando vuelve (no en cada actualización)
      if (wasOk !== (b.state === 'ok')) {
        const agents = await q(`select id from users where active and role<>'superadmin'`);
        await notify(agents.map((a) => a.id), b.state === 'ok' ? `${sys.name} volvió a funcionar` : `${sys.name}: ${STATE_LABEL[b.state].toLowerCase()}`,
          b.state === 'ok' ? (resolved ? `Se respondieron y resolvieron ${resolved} tickets vinculados.` : '') : `Informado por ${u.name}. ${b.message.trim()}`.trim(), '#/', u.id);
      }
    });
    return { ok: true, resolved, systems: await listForAgents() };
  });

  // Vincular un ticket a un sistema con un problema en curso (o desvincularlo)
  r.post('/tickets/:num/critical', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const b = parse(v.object({ system_id: v.id({ optional: true, nullable: true }) }), raw);
    const t = await getByNumber(params.num);
    if (t.deleted_at) throw notFound('No existe el ticket');
    await tx(async () => {
      const prev = await one('select s.name from critical_system_tickets l join critical_systems s on s.id=l.system_id where l.ticket_id=$1 limit 1', [t.id]);
      await q('delete from critical_system_tickets where ticket_id=$1', [t.id]);
      if (b.system_id) {
        const s = await one('select id,name,state from critical_systems where id=$1 and active', [b.system_id]);
        if (!s) throw notFound('No existe el sistema');
        if (s.state === 'ok') throw bad(`${s.name} figura operativo: primero informá el problema`);
        await q('insert into critical_system_tickets(system_id,ticket_id,created_by) values ($1,$2,$3)', [s.id, t.id, u.id]);
        await logActivity(t.id, u.id, 'critical_linked', { system: s.name });
      } else if (prev) {
        await logActivity(t.id, u.id, 'critical_unlinked', { system: prev.name });
      }
    });
    return { ok: true };
  });

  // ---------- Configuración ----------
  crud(r, '/admin/critical-systems', 'critical_systems', { name: 'name', description: 'text', sort: 'int', public: 'bool', active: 'bool', tech_category_id: 'int' }, {
    roles: ['admin'], readRoles: ['admin'],
    schema: v.object({
      name: v.string({ min: 1, max: 80, optional: true }),
      description: v.string({ max: 200, optional: true }),
      sort: v.int({ min: 0, max: 10000, optional: true }),
      public: v.bool({ optional: true }),
      active: v.bool({ optional: true }),
      tech_category_id: v.id({ optional: true, nullable: true }),
    }),
  });

  // ---------- Portal (público) ----------
  r.get('/portal/status', async () => {
    const [hd, opts] = await Promise.all([helpdesk(), criticalOptions()]);
    if (hd.portal_enabled === false || !opts.portal) return { enabled: false, systems: [], now: new Date() };
    const systems = await q(`select id,name,description,state,eta,message,since,tech_category_id from critical_systems
      where active and public order by sort, name`);
    return { enabled: true, ticket_warning: opts.ticket_warning, systems, now: new Date() };
  });
}
