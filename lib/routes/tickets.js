import { q, one, Where, tx, txRouter } from '../db.js';
import { v, parse, idParam, likeTerm } from '../validate.js';
import { requireUser, isManager, isSuper, superadminEnabled } from '../auth.js';
import { audit } from '../audit.js';

// Borrado definitivo: exclusivo del superadmin (o de administradores si no hay superadmin configurado).
const canPurge = (u) => isSuper(u) || (!superadminEnabled() && u.role === 'admin');
const PURGE_MSG = 'Solo el superadministrador puede eliminar tickets definitivamente';
// Un agente puede mandar a la papelera o a spam de a pocos tickets; las acciones masivas grandes, combinar y exportar son de supervisores o más
const AGENT_BULK_MAX = 10;
import { bad, notFound, forbidden, int, isEmail, send } from '../http.js';
import { getSetting } from '../settings.js';
import {
  createTicket, logActivity, notify, saveAttachments, recomputeDues, emailContact, emailAgentAssignment,
  ticketSubjectTag, upsertContact, PRIORITIES, CHANNELS, stripHtml,
} from '../tickets-core.js';
import { sendMail, layout, escapeHtml } from '../mail.js';
import { csvCell } from '../xlsx.js';
import { seesAllTickets, visibleTicketsSql, canSeeTicket } from '../visibility.js';
import { createIssue, createProject, projectSummary, spreadPhaseDates, projectType } from './projects.js';
import { onTicketLinked } from '../dev-rules.js';
import { limit, limitAmount } from '../ratelimit.js';

// Correos que salen en nombre de la empresa: tope por agente y por hora (una cuenta robada no puede mandar spam masivo)
export const MAIL_LIMITS = { mails: 120, forwards: 20, recipients: 300, forwardRecipients: 10 };
export async function limitOutgoing(u, { forward = false, recipients = 1 } = {}) {
  const wait = 'Esperá un rato o pedile a un administrador que lo revise.';
  await limit(`mail-out:user:${u.id}`, MAIL_LIMITS.mails, 3600, `Llegaste al tope de ${MAIL_LIMITS.mails} correos por hora. ${wait}`);
  if (forward) await limit(`mail-fwd:user:${u.id}`, MAIL_LIMITS.forwards, 3600, `Llegaste al tope de ${MAIL_LIMITS.forwards} reenvíos por hora. ${wait}`);
  await limitAmount(`mail-rcpt:user:${u.id}`, recipients, MAIL_LIMITS.recipients, 3600, `Llegaste al tope de ${MAIL_LIMITS.recipients} destinatarios por hora. ${wait}`);
}

const DEFAULT_PHASES = ['Relevamiento y análisis', 'Desarrollo', 'Testing', 'Implementación'];
export { spreadPhaseDates };

// Orden de la lista: cada columna de la tabla se puede ordenar (por nombre, no por id)
const SORTS = {
  created: 't.created_at', updated: 't.updated_at', activity: 't.last_activity_at', priority: 't.priority', number: 't.number', due: 't.resolution_due', subject: 'lower(t.subject)',
  channel: 't.channel', contact: 'lower(c.name)', status: 's.sort',
  assignee: '(select lower(su.name) from users su where su.id = t.assignee_id)',
  category: '(select lower(sc.name) from categories sc where sc.id = t.category_id)',
  tech: '(select lower(st.name) from tech_categories st where st.id = t.tech_category_id)',
  subtech: '(select lower(ss.name) from tech_subcategories ss where ss.id = t.tech_subcategory_id)',
  type: '(select lower(sy.name) from ticket_types sy where sy.id = t.type_id)',
};

const list = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(','));
const ids = (v) => list(v).map((x) => Number(x)).filter(Number.isFinite);

/** Aplica vista + filtros al WHERE. */
function applyFilters(w, f, user) {
  const view = f.view || 'all';
  if (view === 'trash') w.add('t.deleted_at is not null');
  else {
    w.add('t.deleted_at is null');
    w.add(view === 'spam' ? 't.spam' : 'not t.spam');
  }
  const unresolved = `s.kind in ('open','pending')`;
  switch (view) {
    case 'mine': w.add(`t.assignee_id=${w.p(user.id)}`).add(unresolved); break;
    case 'unassigned_mine': w.add(`(t.assignee_id is null or t.assignee_id=${w.p(user.id)})`).add(unresolved); break;
    case 'unassigned': w.add('t.assignee_id is null').add(unresolved); break;
    case 'following': w.add(`exists (select 1 from ticket_followers tf where tf.ticket_id=t.id and tf.user_id=${w.p(user.id)})`); break;
    case 'unresolved': w.add(unresolved); break;
    case 'archived': w.add(`s.kind in ('resolved','closed')`); break;
    case 'overdue': w.add(unresolved).add(`(t.resolution_due < now() or (t.first_responded_at is null and t.first_response_due < now()))`); break;
    default: break;
  }
  const st = ids(f.status);
  if (st.length) w.add(`t.status_id = any(${w.p(st)}::int[])`);
  const kinds = list(f.status_kind).filter((k) => ['open', 'pending', 'resolved', 'closed'].includes(k));
  if (kinds.length) w.add(`s.kind = any(${w.p(kinds)}::text[])`);
  const pr = ids(f.priority);
  if (pr.length) w.add(`t.priority = any(${w.p(pr)}::int[])`);
  const as = list(f.assignee);
  if (as.length) {
    const nums = ids(as.map((x) => (x === 'me' ? user.id : x)));
    const parts = [];
    if (as.includes('none')) parts.push('t.assignee_id is null');
    if (nums.length) parts.push(`t.assignee_id = any(${w.p(nums)}::int[])`);
    w.add(`(${parts.join(' or ')})`);
  }
  for (const [key, col] of [['category', 'category_id'], ['type', 'type_id'], ['tech', 'tech_category_id'], ['subtech', 'tech_subcategory_id'], ['sla', 'sla_id']]) {
    // "none" = sin valor (ej. tickets sin categoría técnica, desde el inicio o los informes)
    const raw = list(f[key]);
    const v = ids(raw);
    const parts = [];
    if (raw.includes('none')) parts.push(`t.${col} is null`);
    if (v.length) parts.push(`t.${col} = any(${w.p(v)}::int[])`);
    if (parts.length) w.add(`(${parts.join(' or ')})`);
  }
  const ch = list(f.channel).filter((c) => CHANNELS.includes(c));
  if (ch.length) w.add(`t.channel = any(${w.p(ch)}::text[])`);
  if (f.contact) w.add(`t.contact_id=${w.p(int(f.contact))}`);
  if (f.company) w.add(`c.company_id=${w.p(int(f.company))}`);
  if (f.tag) w.add(`t.tags @> array[${w.p(String(f.tag).slice(0, 80))}]::text[]`);
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));
  if (isDate(f.created_from)) w.add(`t.created_at >= ${w.p(f.created_from)}::date`);
  if (isDate(f.created_to)) w.add(`t.created_at < (${w.p(f.created_to)}::date + 1)`);
  if (f.overdue === '1' || f.overdue === true) w.add(`${unresolved} and t.resolution_due < now()`);
  if (f.q) {
    const term = String(f.q).trim().slice(0, 200).replace(/[\\%_]/g, (c) => `\\${c}`);
    const num = term.replace(/^#/, '');
    if (/^\d+$/.test(num)) w.add(`(t.number=${w.p(Number(num))} or t.subject ilike ${w.p('%' + term + '%')})`);
    else {
      const p = w.p('%' + term + '%');
      w.add(`(t.subject ilike ${p} or c.name ilike ${p} or c.email ilike ${p} or exists (select 1 from ticket_messages m where m.ticket_id=t.id and m.body_html ilike ${p}))`);
    }
  }
}

async function resolveFilters(query, user) {
  let f = { ...query };
  if (String(f.view || '').startsWith('custom:')) {
    const v = await one('select * from custom_views where id=$1 and (owner_id=$2 or shared)', [int(f.view.split(':')[1]), user.id]);
    f = { ...(v?.filters || {}), ...Object.fromEntries(Object.entries(query).filter(([k, val]) => k !== 'view' && val !== '' && val !== undefined)), view: v?.filters?.view || 'all' };
  }
  return f;
}

const LIST_FROM = `from tickets t
  left join statuses s on s.id=t.status_id
  left join contacts c on c.id=t.contact_id
  left join companies co on co.id=c.company_id`;

export async function listTickets(query, user, { all = false } = {}) {
  const f = await resolveFilters(query, user);
  const w = new Where();
  applyFilters(w, f, user);
  const sortCol = Object.hasOwn(SORTS, String(f.sort)) ? SORTS[f.sort] : SORTS.created;
  const dir = String(f.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const limit = all ? 10000 : Math.min(Math.max(int(f.limit, 50), 1), 200);
  const page = Math.max(int(f.page, 1), 1);
  const [items, total] = await Promise.all([
    q(
      `select t.id,t.number,t.subject,t.channel,t.priority,t.status_id,t.assignee_id,t.category_id,t.type_id,t.tech_category_id,t.tech_subcategory_id,t.sla_id,
              t.created_at,t.updated_at,t.last_activity_at,t.first_response_due,
              (select p.key from ticket_projects tp join projects p on p.id=tp.project_id where tp.ticket_id=t.id order by tp.created_at limit 1) as project_key,t.resolution_due,t.first_responded_at,t.resolved_at,t.tags,t.spam,t.deleted_at,
              c.id as contact_id,c.name as contact_name,c.email as contact_email,co.name as company_name,s.kind as status_kind
       ${LIST_FROM} ${w} order by ${sortCol} ${dir} nulls last, t.id desc limit $${w.params.length + 1} offset $${w.params.length + 2}`,
      [...w.params, limit, (page - 1) * limit],
    ),
    one(`select count(*)::int as n ${LIST_FROM} ${w}`, w.params),
  ]);
  return { items, total: total.n, page, limit };
}

async function countView(view, user) {
  const w = new Where();
  applyFilters(w, await resolveFilters({ view }, user), user);
  return (await one(`select count(*)::int as n ${LIST_FROM} ${w}`, w.params)).n;
}

export async function getByNumber(num) {
  // Estricto: solo dígitos (sin "1x", "+1", "1.0", espacios ni ceros de más). Evita que una forma rara del número esquive controles.
  const s = String(num ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(s)) throw notFound('No existe el ticket');
  const t = await one('select * from tickets where number=$1', [Number(s)]);
  if (!t) throw notFound('No existe el ticket');
  return t;
}

const FIELD_LABELS = {
  status_id: 'Estado', priority: 'Prioridad', group_id: 'Grupo (anterior)', assignee_id: 'Asignado a', category_id: 'Categoría', type_id: 'Tipo',
  tech_category_id: 'Categoría técnica', tech_subcategory_id: 'Subcategoría', sla_id: 'SLA', subject: 'Asunto', contact_id: 'Contacto', tags: 'Etiquetas', cc: 'CC',
};

/** Actualiza campos con auditoría, SLA y notificaciones, en una transacción (los correos salen después del commit). */
export function updateTicket(t, patch, user, req, opts = {}) {
  return tx(() => updateTicketTx(t, patch, user, req, opts));
}

// opts.quietContact: no manda el correo de "resuelto" al contacto (quien llama ya le escribió)
async function updateTicketTx(t, patch, user, req, opts = {}) {
  const allowedInt = ['status_id', 'priority', 'assignee_id', 'category_id', 'type_id', 'tech_category_id', 'tech_subcategory_id', 'sla_id', 'contact_id'];
  const changes = {};
  for (const k of allowedInt) {
    if (patch[k] === undefined) continue;
    const v = patch[k] === null || patch[k] === '' ? null : Number(patch[k]);
    if (k === 'priority' && ![1, 2, 3, 4].includes(v)) throw bad('Prioridad inválida');
    if ((k === 'status_id' || k === 'contact_id') && !v) throw bad(`${FIELD_LABELS[k]} es obligatorio`);
    if (v !== t[k]) changes[k] = v;
  }
  // La subcategoría tiene que ser de la categoría técnica del ticket; si cambia la categoría, se limpia
  const techId = changes.tech_category_id !== undefined ? changes.tech_category_id : t.tech_category_id;
  const subId = changes.tech_subcategory_id !== undefined ? changes.tech_subcategory_id : t.tech_subcategory_id;
  if (subId) {
    const sub = await one('select tech_category_id from tech_subcategories where id=$1', [subId]);
    if (!sub) throw bad('La subcategoría no existe');
    if (sub.tech_category_id !== techId) {
      if (changes.tech_subcategory_id) throw bad('La subcategoría no corresponde a la categoría técnica');
      changes.tech_subcategory_id = null;
    }
  }
  if (patch.subject !== undefined) {
    const s = String(patch.subject).trim().slice(0, 300);
    if (!s) throw bad('El asunto es obligatorio');
    if (s !== t.subject) changes.subject = s;
  }
  if (Array.isArray(patch.tags)) changes.tags = [...new Set(patch.tags.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20);
  if (Array.isArray(patch.cc)) changes.cc = patch.cc.filter(isEmail).map((x) => x.toLowerCase());
  if (patch.custom && typeof patch.custom === 'object') changes.custom = JSON.stringify({ ...(t.custom || {}), ...patch.custom });
  if (!Object.keys(changes).length) return t;

  const sets = [];
  const vals = [t.id];
  for (const [k, v] of Object.entries(changes)) {
    vals.push(v);
    sets.push(`${k}=$${vals.length}${k === 'custom' ? '::jsonb' : ''}`);
  }
  if (changes.status_id) {
    const [oldS, newS] = await Promise.all([
      one('select * from statuses where id=$1', [t.status_id]),
      one('select * from statuses where id=$1', [changes.status_id]),
    ]);
    if (!newS) throw bad('Estado inexistente');
    if (newS.kind === 'resolved') sets.push('resolved_at=coalesce(resolved_at,now())');
    if (newS.kind === 'closed') sets.push('closed_at=now(), resolved_at=coalesce(resolved_at,now())');
    if (['open', 'pending'].includes(newS.kind)) sets.push('resolved_at=null, closed_at=null');
    // Pausa de SLA
    if (newS.pauses_sla && !oldS?.pauses_sla) sets.push('sla_paused_at=now()');
    if (!newS.pauses_sla && oldS?.pauses_sla && t.sla_paused_at) {
      const ms = Date.now() - new Date(t.sla_paused_at).getTime();
      vals.push(`${Math.round(ms / 1000)} seconds`);
      sets.push(`resolution_due = resolution_due + $${vals.length}::interval, sla_paused_at=null`);
    }
  }
  sets.push('updated_at=now()', 'last_activity_at=now()');
  await q(`update tickets set ${sets.join(', ')} where id=$1`, vals);
  const updated = await one('select * from tickets where id=$1', [t.id]);
  if (changes.priority || changes.sla_id !== undefined) await recomputeDues(updated);

  const diff = {};
  for (const k of Object.keys(changes)) diff[k] = { from: t[k] ?? null, to: k === 'custom' ? patch.custom : changes[k] };
  await logActivity(t.id, user?.id, 'updated', diff);

  const link = `#/tickets/${t.number}`;
  if (changes.assignee_id) {
    await notify([changes.assignee_id], `Te asignaron el ticket #${t.number}`, updated.subject, link, user?.id);
    await emailAgentAssignment(updated, changes.assignee_id, req);
  }
  if (changes.status_id) {
    const followers = await q('select user_id from ticket_followers where ticket_id=$1', [t.id]);
    const s = await one('select name,kind from statuses where id=$1', [changes.status_id]);
    await notify([updated.assignee_id, ...followers.map((f) => f.user_id)], `#${t.number} pasó a ${s.name}`, updated.subject, link, user?.id);
    const cfg = (await getSetting('helpdesk')) || {};
    if (s.kind === 'resolved' && cfg.notify_contact_on_resolve !== false && updated.contact_id && !opts.quietContact) {
      const contact = await one('select * from contacts where id=$1', [updated.contact_id]);
      await emailContact(updated, contact, {
        subject: await ticketSubjectTag(updated),
        html: `<p>Hola ${escapeHtml(contact.name)},</p><p>Marcamos como <b>resuelto</b> tu ticket <b>#${updated.number}</b>. Si necesitás algo más, respondé este correo y lo reabrimos.</p>`,
        req,
      });
    }
  }
  return one('select * from tickets where id=$1', [t.id]);
}

async function ticketDetail(t, user) {
  const [contact, messages, attachments, activities, followers, time, issues, otherTickets, projLinks, critical] = await Promise.all([
    t.contact_id ? one('select c.*, co.name as company_name from contacts c left join companies co on co.id=c.company_id where c.id=$1', [t.contact_id]) : null,
    q('select * from ticket_messages where ticket_id=$1 order by created_at, id', [t.id]),
    q('select a.id,a.ticket_message_id,a.filename,a.content_type,a.size from attachments a join ticket_messages m on m.id=a.ticket_message_id where m.ticket_id=$1', [t.id]),
    q('select * from ticket_activities where ticket_id=$1 order by created_at, id', [t.id]),
    q('select user_id from ticket_followers where ticket_id=$1', [t.id]),
    q('select * from time_entries where ticket_id=$1 order by spent_on desc, id desc', [t.id]),
    q(`select i.id,i.key,i.title,i.type,ps.name as status_name,ps.kind as status_kind,i.assignee_id,p.color
       from ticket_issue_links l join issues i on i.id=l.issue_id join projects p on p.id=i.project_id left join project_statuses ps on ps.id=i.status_id where l.ticket_id=$1`, [t.id]),
    t.contact_id ? q(`select t2.number,t2.subject,t2.created_at,s.name as status_name,s.kind as status_kind from tickets t2 left join statuses s on s.id=t2.status_id
       where t2.contact_id=$1 and t2.id<>$2 and t2.deleted_at is null ${seesAllTickets(user) ? '' : `and ${visibleTicketsSql('t2', '$3')}`} order by t2.created_at desc limit 6`,
    seesAllTickets(user) ? [t.contact_id, t.id] : [t.contact_id, t.id, user.id]) : [],
    q('select project_id from ticket_projects where ticket_id=$1 order by created_at', [t.id]),
    // Sistema crítico al que está vinculado (problema en curso)
    one(`select s.id,s.name,s.state,s.eta,s.since from critical_system_tickets l join critical_systems s on s.id=l.system_id
      where l.ticket_id=$1 order by l.created_at desc limit 1`, [t.id]),
  ]);
  const projects = (await Promise.all(projLinks.map((l) => projectSummary(l.project_id)))).filter(Boolean);
  for (const m of messages) m.attachments = attachments.filter((a) => a.ticket_message_id === m.id);
  return {
    ticket: t, contact, messages, activities, followers: followers.map((f) => f.user_id), following: followers.some((f) => f.user_id === user.id),
    time, timeTotal: time.reduce((a, x) => a + x.minutes, 0), issues, otherTickets, projects, critical: critical || null,
  };
}


export function ticketRoutes(router) {
  // Todas las rutas que escriben, en transacción. Excepto las que llaman a la IA antes de escribir (manejan su propia transacción).
  const r = txRouter(router, ['/tickets', '/tickets/:num/messages']);
  r.get('/tickets', async ({ req, query }) => listTickets(query, await requireUser(req)));

  r.get('/tickets/counts', async ({ req }) => {
    const u = await requireUser(req);
    // Las 9 vistas fijas en UNA consulta con FILTER (antes: una consulta por vista)
    const unresolved = `s.kind in ('open','pending')`;
    const live = 't.deleted_at is null and not t.spam';
    const [fixed, custom] = await Promise.all([
      one(`select
          count(*) filter (where ${live})::int as all,
          count(*) filter (where ${live} and t.assignee_id=$1 and ${unresolved})::int as mine,
          count(*) filter (where ${live} and (t.assignee_id is null or t.assignee_id=$1) and ${unresolved})::int as unassigned_mine,
          count(*) filter (where ${live} and exists (select 1 from ticket_followers tf where tf.ticket_id=t.id and tf.user_id=$1))::int as following,
          count(*) filter (where ${live} and ${unresolved})::int as unresolved,
          count(*) filter (where ${live} and ${unresolved} and (t.resolution_due < now() or (t.first_responded_at is null and t.first_response_due < now())))::int as overdue,
          count(*) filter (where ${live} and s.kind in ('resolved','closed'))::int as archived,
          count(*) filter (where t.deleted_at is null and t.spam)::int as spam,
          count(*) filter (where t.deleted_at is not null)::int as trash
        from tickets t left join statuses s on s.id=t.status_id ${seesAllTickets(u) ? '' : `where ${visibleTicketsSql('t', '$1')}`}`, [u.id]),
      q('select id from custom_views where owner_id=$1 or shared', [u.id]),
    ]);
    const out = { ...fixed };
    await Promise.all(custom.map(async (c) => (out[`custom:${c.id}`] = await countView(`custom:${c.id}`, u))));
    return out;
  });

  r.get('/tickets/export', async ({ req, res, query }) => {
    const u = await requireUser(req, ['admin', 'supervisor']);
    const { items } = await listTickets(query, u, { all: true });
    const [statuses, users, cats, types, techs, subs] = await Promise.all([
      q('select id,name from statuses'), q('select id,name from users'),
      q('select id,name from categories'), q('select id,name from ticket_types'), q('select id,name from tech_categories'),
      q('select id,name from tech_subcategories'),
    ]);
    const nm = (arr, id) => arr.find((x) => x.id === id)?.name || '';
    const head = ['Número', 'Asunto', 'Contacto', 'Correo', 'Empresa', 'Canal', 'Prioridad', 'Estado', 'Categoría técnica', 'Subcategoría', 'Tipo', 'Asignado a', 'Categoría', 'Creado', 'Actualizado', 'Resuelto', 'Vence resolución', 'Etiquetas'];
    const rows = items.map((t) => [
      t.number, t.subject, t.contact_name, t.contact_email, t.company_name, t.channel, PRIORITIES[t.priority], nm(statuses, t.status_id),
      nm(techs, t.tech_category_id), nm(subs, t.tech_subcategory_id), nm(types, t.type_id), nm(users, t.assignee_id), nm(cats, t.category_id), t.created_at, t.updated_at, t.resolved_at, t.resolution_due, t.tags,
    ]);
    const csv = '﻿' + [head, ...rows].map((r2) => r2.map(csvCell).join(',')).join('\n');
    send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tickets-${new Date().toISOString().slice(0, 10)}.csv"` });
    return undefined;
  }, { raw: true });

  const optId = () => v.id({ optional: true, nullable: true });
  const ticketFields = {
    status_id: optId(), assignee_id: optId(), category_id: optId(), type_id: optId(), tech_category_id: optId(), tech_subcategory_id: optId(), sla_id: optId(), contact_id: optId(),
    priority: v.int({ min: 1, max: 4, optional: true }),
    tags: v.list(v.string({ max: 60 }), { max: 20, optional: true }),
    cc: v.list(v.email(), { max: 20, optional: true }),
    custom: v.object({}, { optional: true, unknown: 'strip' }),
  };
  const newTicketSchema = v.object({
    ...ticketFields,
    subject: v.string({ min: 1, max: 300 }),
    channel: v.enum(CHANNELS, { default: 'agent' }),
    contact_email: v.email({ optional: true }),
    contact_name: v.string({ max: 120, optional: true }),
    body_html: v.html({ max: 500000, default: '' }),
    attachments: v.array(v.attachment(), { max: 5, optional: true }),
    send_email: v.bool({ default: false }),
  });
  const patchTicketSchema = v.object({ ...ticketFields, subject: v.string({ min: 1, max: 300, optional: true }) });

  r.post('/tickets', async ({ req, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(newTicketSchema, raw);
    if (body.send_email) await limitOutgoing(u, { recipients: 1 + (Array.isArray(body.cc) ? body.cc.length : 0) });
    const t = await createTicket(body, { user: u, req });
    if (body.send_email && t.contact_id) {
      const contact = await one('select * from contacts where id=$1', [t.contact_id]);
      await emailContact(t, contact, { subject: await ticketSubjectTag(t), html: body.body_html || '', req, cc: t.cc, idempotencyKey: `ticket-${t.id}-agent-created` });
    }
    return t;
  }, { idempotent: true });

  r.post('/tickets/bulk', async ({ req, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(v.object({
      numbers: v.array(v.id(), { max: 1000 }),
      action: v.enum(['update', 'spam', 'notspam', 'trash', 'restore', 'delete', 'follow']),
      patch: v.object(ticketFields, { optional: true }),
    }), raw);
    let nums = body.numbers;
    // Solo los tickets que el usuario puede ver
    if (!seesAllTickets(u)) nums = (await q(`select t.number from tickets t where t.number = any($1::int[]) and ${visibleTicketsSql('t', '$2')}`, [nums, u.id])).map((x) => x.number);
    if (!nums.length) throw bad('Seleccioná al menos un ticket');
    if (body.action === 'update' && nums.length > 100) throw bad('Para cambiar campos, seleccioná hasta 100 tickets por vez');
    if (['spam', 'notspam', 'trash', 'restore'].includes(body.action) && !isManager(u) && nums.length > AGENT_BULK_MAX) {
      throw forbidden(`Como agente podés mover a la papelera o a spam hasta ${AGENT_BULK_MAX} tickets por vez. Para más, pedíselo a un supervisor.`);
    }
    // Acciones simples: una sentencia para todos (sin N+1) + un INSERT de actividades
    const act = async (sql, action) => {
      const rows = await q(sql, [nums]);
      if (action && rows.length) await q(`insert into ticket_activities(ticket_id,user_id,action) select unnest($1::int[]), $2, $3`, [rows.map((x) => x.id), u.id, action]);
      return rows.length;
    };
    let done = 0;
    switch (body.action) {
      case 'spam': done = await act('update tickets set spam=true, updated_at=now() where number = any($1::int[]) returning id', 'spam'); break;
      case 'notspam': done = await act('update tickets set spam=false, updated_at=now() where number = any($1::int[]) returning id', 'notspam'); break;
      case 'trash': done = await act('update tickets set deleted_at=now() where number = any($1::int[]) and deleted_at is null returning id', 'trashed'); break;
      case 'restore': done = await act('update tickets set deleted_at=null, spam=false where number = any($1::int[]) returning id', 'restored'); break;
      case 'follow':
        done = (await q('insert into ticket_followers(ticket_id,user_id) select id, $2 from tickets where number = any($1::int[]) on conflict do nothing returning ticket_id', [nums, u.id])).length;
        break;
      case 'delete': {
        if (!canPurge(u)) throw forbidden(PURGE_MSG);
        const gone = await q('delete from tickets where number = any($1::int[]) and deleted_at is not null returning number, subject', [nums]);
        if (gone.length) await audit(req, u, 'ticket_purged', { numbers: gone.map((x) => x.number) });
        done = gone.length;
        break;
      }
      case 'update': {
        // Cada ticket pasa por las mismas reglas que una edición individual (SLA, avisos, auditoría)
        const tickets = await q('select * from tickets where number = any($1::int[])', [nums]);
        // Cambiar el estado en masa puede mandar un correo por ticket (ej. "resuelto"): cuenta para el tope de envíos
        if (body.patch?.status_id && !isManager(u)) await limitOutgoing(u, { recipients: tickets.length });
        for (const t of tickets) await updateTicket(t, body.patch || {}, u, req);
        done = tickets.length;
        break;
      }
      default: throw bad('Acción desconocida');
    }
    return { ok: true, done };
  }, { tx: true });

  r.get('/tickets/:num', async ({ req, params }) => {
    const u = await requireUser(req);
    return ticketDetail(await getByNumber(params.num), u);
  });

  r.patch('/tickets/:num', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    await updateTicket(t, parse(patchTicketSchema, body), u, req);
    return ticketDetail(await getByNumber(params.num), u);
  });

  const messageSchema = v.object({
    kind: v.enum(['reply', 'note', 'forward'], { default: 'reply' }),
    body_html: v.html({ max: 500000, default: '' }),
    attachments: v.array(v.attachment(), { max: 5, default: () => [] }),
    cc: v.list(v.email(), { max: 20, default: () => [] }),
    to: v.list(v.email(), { max: 20, default: () => [] }),
    status_id: v.id({ optional: true, nullable: true }),
    notify_user_ids: v.array(v.id(), { max: 50, default: () => [] }),
    ai_assisted: v.bool({ default: false }),
  });

  r.post('/tickets/:num/messages', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(messageSchema, raw);
    const t = await getByNumber(params.num);
    const { kind, attachments: files } = body;
    const html = body.body_html.trim();
    if (!stripHtml(html) && !files.length) throw bad('El mensaje está vacío');
    if (kind === 'forward' && !body.to.length) throw bad('Indicá a quién reenviar');
    if (kind === 'forward' && body.to.length + body.cc.length > MAIL_LIMITS.forwardRecipients) throw bad(`Podés reenviar a hasta ${MAIL_LIMITS.forwardRecipients} personas por vez (sumando las de copia)`);
    const contact = t.contact_id ? await one('select * from contacts where id=$1', [t.contact_id]) : null;
    const to = kind === 'reply' ? (contact ? [contact.email] : []) : kind === 'forward' ? body.to : [];
    if (kind === 'forward' || (kind === 'reply' && contact)) {
      await limitOutgoing(u, { forward: kind === 'forward', recipients: to.length + new Set([...(kind === 'reply' ? t.cc || [] : []), ...body.cc]).size });
    }
    // 1) Escrituras en una transacción
    const msg = await tx(async () => {
      const m = await one(
        `insert into ticket_messages(ticket_id,kind,author_user_id,from_email,to_emails,cc_emails,body_html,meta) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) returning *`,
        [t.id, kind, u.id, u.email, to, body.cc, html, JSON.stringify(body.ai_assisted ? { ai_assisted: true } : {})],
      );
      if (files.length) await saveAttachments(files, { messageId: m.id, userId: u.id });
      await q(`update tickets set updated_at=now(), last_activity_at=now(), first_responded_at = case when $2 and first_responded_at is null then now() else first_responded_at end where id=$1`,
        [t.id, kind === 'reply' && Boolean(contact)]);
      if (kind === 'note' && body.notify_user_ids.length) {
        await notify(body.notify_user_ids, `${u.name} te mencionó en #${t.number}`, stripHtml(html).slice(0, 200), `#/tickets/${t.number}`, u.id);
      }
      if (body.status_id) await updateTicket(await getByNumber(params.num), { status_id: body.status_id }, u, req);
      return m;
    });
    // 2) Correo después del commit, con clave de idempotencia (un reintento no lo duplica)
    let mail = null;
    if (kind === 'reply' && contact) {
      const sig = u.signature_html ? `<div style="margin-top:16px;color:#4b5563">${u.signature_html}</div>` : '';
      mail = await emailContact(t, contact, { subject: `Re: ${await ticketSubjectTag(t)}`, html: html + sig, req, cc: [...new Set([...(t.cc || []), ...body.cc])], attachments: files, idempotencyKey: `msg-${msg.id}` });
    } else if (kind === 'forward') {
      mail = await sendMail({
        to, cc: body.cc, subject: `Fwd: ${await ticketSubjectTag(t)}`,
        html: await layout(`${html}<hr><p style="color:#6b7280;font-size:12px">Reenviado desde el ticket #${t.number} por ${escapeHtml(u.name)}</p>`),
        attachments: files, idempotencyKey: `msg-${msg.id}`,
      });
    }
    await logActivity(t.id, u.id, kind === 'note' ? 'note' : kind === 'forward' ? 'forwarded' : 'replied', { mail: mail ? { sent: mail.sent, error: mail.error || null } : null });
    return { message: msg, mail, detail: await ticketDetail(await getByNumber(params.num), u) };
  }, { idempotent: true });

  r.post('/tickets/:num/follow', async ({ req, params }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    await q('insert into ticket_followers values ($1,$2) on conflict do nothing', [t.id, u.id]);
    return { following: true };
  });
  r.del('/tickets/:num/follow', async ({ req, params }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    await q('delete from ticket_followers where ticket_id=$1 and user_id=$2', [t.id, u.id]);
    return { following: false };
  });

  r.post('/tickets/:num/time', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    const b = parse(v.object({ minutes: v.int({ min: 1, max: 1440 }), note: v.string({ max: 500, default: '' }), spent_on: v.date({ optional: true, nullable: true }) }), body);
    const minutes = b.minutes;
    await q('insert into time_entries(ticket_id,user_id,minutes,note,spent_on) values ($1,$2,$3,$4,coalesce($5::date,current_date))', [t.id, u.id, minutes, b.note, b.spent_on || null]);
    await logActivity(t.id, u.id, 'time', { minutes });
    return ticketDetail(t, u);
  });
  r.del('/time/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const e = await one('select * from time_entries where id=$1', [idParam(params.id)]);
    if (!e) throw notFound();
    if (e.user_id !== u.id && !isManager(u)) throw forbidden();
    await q('delete from time_entries where id=$1', [e.id]);
    return { ok: true };
  });

  r.post('/tickets/:num/spam', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    const { spam } = parse(v.object({ spam: v.bool({ default: true }) }), body);
    await q('update tickets set spam=$2, updated_at=now() where id=$1', [t.id, spam]);
    await logActivity(t.id, u.id, spam ? 'spam' : 'notspam', {});
    return { ok: true };
  });

  r.del('/tickets/:num', async ({ req, params }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    if (t.deleted_at) {
      if (!canPurge(u)) throw forbidden(PURGE_MSG);
      await q('delete from tickets where id=$1', [t.id]);
      await audit(req, u, 'ticket_purged', { number: t.number, subject: t.subject });
      return { ok: true, deleted: true };
    }
    await q('update tickets set deleted_at=now() where id=$1', [t.id]);
    await logActivity(t.id, u.id, 'trashed', {});
    return { ok: true, trashed: true };
  });

  r.post('/tickets/:num/restore', async ({ req, params }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    await q('update tickets set deleted_at=null, spam=false where id=$1', [t.id]);
    await logActivity(t.id, u.id, 'restored', {});
    return { ok: true };
  });

  r.post('/tickets/:num/merge', async ({ req, params, body }) => {
    const u = await requireUser(req, ['admin', 'supervisor']);
    const src = await getByNumber(params.num);
    const dst = await getByNumber(parse(v.object({ into: v.id() }), body).into);
    if (!(await canSeeTicket(u, dst))) throw notFound('No existe el ticket');
    if (src.id === dst.id) throw bad('No podés combinar un ticket consigo mismo');
    await q('update ticket_messages set ticket_id=$2 where ticket_id=$1', [src.id, dst.id]);
    await q(`insert into ticket_messages(ticket_id,kind,author_user_id,body_html) values ($1,'note',$2,$3)`,
      [dst.id, u.id, `<p>Se combinó el ticket <b>#${src.number}</b> (${escapeHtml(src.subject)}) en este ticket.</p>`]);
    const closed = await one(`select id from statuses where kind='closed' order by sort limit 1`);
    await q('update tickets set merged_into=$2, status_id=coalesce($3,status_id), closed_at=now() where id=$1', [src.id, dst.number, closed?.id || null]);
    await q('insert into ticket_issue_links(ticket_id,issue_id) select $2, issue_id from ticket_issue_links where ticket_id=$1 on conflict do nothing', [src.id, dst.id]);
    await logActivity(src.id, u.id, 'merged', { into: dst.number });
    await logActivity(dst.id, u.id, 'merged_from', { from: src.number });
    return { ok: true, into: dst.number };
  }, { tx: true });

  // Vincular / crear issue de proyecto desde un ticket
  r.post('/tickets/:num/issues', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(v.object({
      issue_key: v.string({ max: 30, pattern: /^[A-Za-z][A-Za-z0-9]*-\d+$/, optional: true }),
      project_id: v.id({ optional: true }), type: v.enum(['task', 'bug', 'story', 'epic', 'subtask'], { optional: true }),
      title: v.string({ max: 200, optional: true }), description_html: v.html({ max: 200000, optional: true }),
      priority: v.int({ min: 1, max: 4, optional: true }), assignee_id: v.id({ optional: true, nullable: true }), parent_id: v.id({ optional: true, nullable: true }),
    }), raw);
    const t = await getByNumber(params.num);
    let issue;
    if (body.issue_key) {
      issue = await one('select id,key from issues where upper(key)=upper($1)', [String(body.issue_key).trim()]);
      if (!issue) throw notFound('No existe esa tarea');
    } else {
      const msgs = await q(`select body_html from ticket_messages where ticket_id=$1 and kind='customer' order by id limit 1`, [t.id]);
      issue = await createIssue({
        project_id: body.project_id, type: body.type || 'task', title: body.title || `#${t.number} ${t.subject}`,
        description_html: (body.description_html || msgs[0]?.body_html || '') + `<p><i>Origen: ticket #${t.number}</i></p>`,
        priority: body.priority || Math.min(4, Math.max(1, t.priority)), assignee_id: body.assignee_id ?? t.assignee_id, parent_id: body.parent_id || null,
      }, u);
    }
    await q('insert into ticket_issue_links(ticket_id,issue_id) values ($1,$2) on conflict do nothing', [t.id, issue.id]);
    await logActivity(t.id, u.id, 'issue_linked', { key: issue.key });
    await q(`insert into issue_activities(issue_id,user_id,action,details) values ($1,$2,'ticket_linked',$3::jsonb)`, [issue.id, u.id, JSON.stringify({ number: t.number })]);
    return ticketDetail(t, u);
  }, { tx: true, idempotent: true });
  // Convertir el ticket en un proyecto de desarrollo (o vincularlo a uno existente)
  r.post('/tickets/:num/project', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const phase = v.object({ name: v.string({ min: 1, max: 200 }), start_date: v.date({ optional: true, nullable: true }), due_date: v.date({ optional: true, nullable: true }), assignee_id: v.id({ optional: true, nullable: true }) });
    const body = parse(v.object({
      project_key: v.string({ max: 10, pattern: /^[A-Za-z][A-Za-z0-9]{0,9}$/, optional: true }),
      key: v.string({ max: 10, pattern: /^[A-Za-z][A-Za-z0-9]{0,9}$/, optional: true }),
      name: v.string({ max: 200, optional: true }), color: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
      template: v.enum(['scrum', 'kanban', 'dev', 'simple'], { optional: true }), lead_id: v.id({ optional: true, nullable: true }),
      type_id: v.id({ optional: true, nullable: true }),
      origin_id: v.id({ optional: true, nullable: true }), sector_id: v.id({ optional: true, nullable: true }), area_id: v.id({ optional: true, nullable: true }),
      priority: v.int({ min: 1, max: 4, optional: true }), portfolio_status: v.enum(['planned', 'active', 'paused', 'done', 'cancelled'], { optional: true }),
      estimated_hours: v.number({ min: 0, max: 1000000, optional: true, nullable: true }), recurring: v.bool({ optional: true }),
      start_date: v.date({ optional: true, nullable: true }), end_date: v.date({ optional: true, nullable: true }),
      description: v.string({ max: 5000, multiline: true, optional: true }), member_ids: v.array(v.id(), { max: 100, optional: true }),
      phases: v.array(v.any(), { max: 20, optional: true }), notify_contact: v.bool({ default: false }), message: v.html({ max: 20000, optional: true }),
    }), raw);
    if (body.phases) body.phases = body.phases.map((f, i) => (typeof f === 'string' ? { name: v.string({ min: 1, max: 200 })(f, `phases[${i}]`) } : phase(f, `phases[${i}]`)));
    const t = await getByNumber(params.num);
    let p;
    let created = false;
    if (body.project_key) {
      p = await one('select * from projects where upper(key)=upper($1)', [String(body.project_key).trim()]);
      if (!p) throw notFound('No existe ese proyecto');
    } else {
      const first = await one(`select body_html from ticket_messages where ticket_id=$1 and kind='customer' order by id limit 1`, [t.id]);
      const cfg = (await getSetting('helpdesk')) || {};
      const type = await projectType(body.type_id || null);
      const template = Array.isArray(type?.phases) && type.phases.length ? type.phases : cfg.dev_phases?.length ? cfg.dev_phases : DEFAULT_PHASES;
      const phases = (Array.isArray(body.phases) && body.phases.length ? body.phases : template.map((name) => ({ name })))
        .map((f) => (typeof f === 'string' ? { name: f } : f))
        .filter((f) => String(f.name || '').trim());
      if (!phases.length) throw bad('Definí al menos una fase');
      const lead = int(body.lead_id) || t.assignee_id || u.id;
      p = await createProject({
        key: body.key, name: body.name || t.subject, color: body.color, template: body.template, lead_id: lead, type_id: type?.id || null,
        description: body.description ?? `Origen: ticket #${t.number}. ${stripHtml(first?.body_html || '').slice(0, 1500)}`,
        member_ids: [...(body.member_ids || []), ...(t.assignee_id ? [t.assignee_id] : [])], phases,
        area_id: body.area_id === undefined ? t.category_id || null : body.area_id, priority: body.priority || Math.min(4, Math.max(2, Number(t.priority) || 2)),
        origin_id: body.origin_id || null, sector_id: body.sector_id || null, portfolio_status: body.portfolio_status, estimated_hours: body.estimated_hours ?? null,
        recurring: body.recurring, start_date: body.start_date || null, end_date: body.end_date || null,
      }, u, { firstPhaseHtml: `${first?.body_html || ''}<p><i>Origen: ticket #${t.number} · ${escapeHtml(t.subject)}</i></p>`, strict: cfg });
      created = true;
    }
    await q('insert into ticket_projects(ticket_id,project_id,created_by) values ($1,$2,$3) on conflict do nothing', [t.id, p.id, u.id]);
    await q('update projects set updated_at=now() where id=$1', [p.id]);
    await q(`insert into ticket_messages(ticket_id,kind,author_user_id,body_html) values ($1,'note',$2,$3)`, [
      t.id, u.id, `<p>${created ? 'Este ticket se convirtió en el proyecto de desarrollo' : 'Este ticket se vinculó al proyecto'} <b>${escapeHtml(p.key)} · ${escapeHtml(p.name)}</b>. El avance por fases se ve en el ticket.</p>`,
    ]);
    await logActivity(t.id, u.id, 'project_linked', { key: p.key, name: p.name, created });
    // El estado del ticket lo deciden las reglas de negocio (Configuración → Proyectos de desarrollo); por defecto se mantiene.
    await onTicketLinked(await getByNumber(params.num), await projectSummary(p.id), u, req, { updateTicket });
    if (body.notify_contact && t.contact_id) {
      await limitOutgoing(u, { recipients: 1 });
      const contact = await one('select * from contacts where id=$1', [t.contact_id]);
      const html = String(body.message || '').trim()
        || `<p>Hola ${escapeHtml((contact.name || '').split(' ')[0])}, tu pedido requiere un desarrollo, así que lo gestionamos como proyecto. Podés seguir el avance por fases desde el enlace del ticket.</p>`;
      await q(`insert into ticket_messages(ticket_id,kind,author_user_id,from_email,to_emails,body_html) values ($1,'reply',$2,$3,$4,$5)`, [t.id, u.id, u.email, [contact.email], html]);
      await emailContact(t, contact, { subject: `Re: ${await ticketSubjectTag(t)}`, html, req });
    }
    await q('update tickets set updated_at=now(), last_activity_at=now() where id=$1', [t.id]);
    return { project: p, detail: await ticketDetail(await getByNumber(params.num), u) };
  }, { tx: true, idempotent: true });
  r.del('/tickets/:num/project/:projectId', async ({ req, params }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    await q('delete from ticket_projects where ticket_id=$1 and project_id=$2', [t.id, idParam(params.projectId)]);
    await logActivity(t.id, u.id, 'project_unlinked', { project_id: idParam(params.projectId) });
    return ticketDetail(t, u);
  }, { tx: true });

  r.del('/tickets/:num/issues/:issueId', async ({ req, params }) => {
    const u = await requireUser(req);
    const t = await getByNumber(params.num);
    await q('delete from ticket_issue_links where ticket_id=$1 and issue_id=$2', [t.id, int(params.issueId)]);
    return ticketDetail(t, u);
  });

  // ---------- Contactos ----------
  r.get('/contacts', async ({ req, query }) => {
    await requireUser(req);
    const w = new Where();
    if (query.q) {
      const p = w.p(likeTerm(query.q));
      w.add(`(c.name ilike ${p} or c.email ilike ${p} or c.area ilike ${p})`);
    }
    if (query.company) w.add(`c.company_id=${w.p(int(query.company))}`);
    const limit = Math.min(Math.max(int(query.limit, 50), 1), 200);
    const page = Math.min(Math.max(int(query.page, 1), 1), 100000);
    const [items, total] = await Promise.all([
      q(`select c.*, co.name as company_name,
           (select count(*)::int from tickets t where t.contact_id=c.id and t.deleted_at is null) as ticket_count
         from contacts c left join companies co on co.id=c.company_id ${w} order by c.name limit $${w.params.length + 1} offset $${w.params.length + 2}`, [...w.params, limit, (page - 1) * limit]),
      one(`select count(*)::int as n from contacts c ${w}`, w.params),
    ]);
    return { items, total: total.n, page, limit };
  });

  r.get('/contacts/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const c = await one('select c.*, co.name as company_name from contacts c left join companies co on co.id=c.company_id where c.id=$1', [int(params.id)]);
    if (!c) throw notFound();
    c.tickets = await q(`select t.number,t.subject,t.created_at,t.priority,s.name as status_name,s.kind as status_kind from tickets t left join statuses s on s.id=t.status_id
      where t.contact_id=$1 and t.deleted_at is null ${seesAllTickets(u) ? '' : `and ${visibleTicketsSql('t', '$2')}`} order by t.created_at desc limit 100`, seesAllTickets(u) ? [c.id] : [c.id, u.id]);
    return c;
  });

  const contactSchema = (create) => v.object({
    name: v.string({ min: 1, max: 120, optional: !create }), email: create ? v.email() : v.email({ optional: true }),
    phone: v.string({ max: 40, optional: true }), company_id: v.id({ optional: true, nullable: true }), area: v.string({ max: 120, optional: true }),
    notes: v.string({ max: 4000, multiline: true, optional: true }), vip: v.bool({ optional: true }), job_title: v.string({ max: 120, optional: true }),
  });
  r.post('/contacts', async ({ req, body: raw }) => {
    await requireUser(req);
    const body = parse(contactSchema(true), raw);
    try {
      return await one('insert into contacts(name,email,phone,company_id,area,notes,vip,job_title) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
        [body.name, body.email, body.phone || '', body.company_id || null, body.area || '', body.notes || '', Boolean(body.vip), body.job_title || '']);
    } catch (e) {
      if (e.code === '23505' || String(e.message).includes('unique')) throw bad('Ya existe un contacto con ese correo');
      throw e;
    }
  });
  r.patch('/contacts/:id', async ({ req, params, body: raw }) => {
    await requireUser(req);
    const body = parse(contactSchema(false), raw);
    const c = await one('select * from contacts where id=$1', [idParam(params.id)]);
    if (!c) throw notFound();
    try {
      return await one('update contacts set name=$2,email=$3,phone=$4,company_id=$5,area=$6,notes=$7,vip=$8,job_title=$9 where id=$1 returning *', [
        c.id, body.name ?? c.name, body.email ?? c.email, body.phone ?? c.phone, body.company_id === undefined ? c.company_id : body.company_id, body.area ?? c.area, body.notes ?? c.notes,
        body.vip ?? c.vip, body.job_title ?? c.job_title,
      ]);
    } catch (e) {
      if (e.code === '23505') throw bad('Ya existe un contacto con ese correo');
      throw e;
    }
  });

  r.del('/contacts/:id', async ({ req, params }) => {
    await requireUser(req, ['admin', 'supervisor']);
    await q('delete from contacts where id=$1', [int(params.id)]);
    return { ok: true };
  });

  r.post('/contacts/import', async ({ req, body }) => {
    await requireUser(req, ['admin', 'supervisor']);
    const rows = parse(v.object({ rows: v.array(v.object({
      email: v.string({ max: 254, optional: true }), name: v.string({ max: 120, optional: true }), phone: v.string({ max: 40, optional: true }),
      area: v.string({ max: 120, optional: true }), company: v.string({ max: 160, optional: true }),
    }), { max: 5000 }) }), body).rows;
    // Se normaliza y deduplica en memoria; después son 3 sentencias en total, no 3 por fila (sin N+1).
    const byEmail = new Map();
    let skipped = 0;
    for (const r0 of rows) {
      const email = String(r0.email || '').trim().toLowerCase();
      if (!isEmail(email)) { skipped += 1; continue; }
      byEmail.set(email, { email, name: r0.name || '', phone: r0.phone || '', area: r0.area || '', company: r0.company || '' });
    }
    const list = [...byEmail.values()];
    if (!list.length) return { created: 0, updated: 0, skipped };
    const cols = ['email', 'name', 'phone', 'area', 'company'].map((k) => list.map((x) => x[k]));
    const input = `select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) as x(email, name, phone, area, company)`;
    const result = await tx(async () => {
      await q(`insert into companies(name) select distinct company from (${input}) i where company <> '' on conflict (name) do nothing`, cols);
      const upd = await q(`update contacts c set name = coalesce(nullif(i.name,''), c.name), phone = coalesce(nullif(i.phone,''), c.phone),
          area = coalesce(nullif(i.area,''), c.area), company_id = coalesce((select id from companies co where co.name = i.company), c.company_id)
        from (${input}) i where c.email = i.email returning c.id`, cols);
      const ins = await q(`insert into contacts(email, name, phone, area, company_id)
        select i.email, coalesce(nullif(i.name,''), split_part(i.email,'@',1)), i.phone, i.area,
               coalesce((select id from companies co where co.name = i.company), (select id from companies co where lower(co.domain) = split_part(i.email,'@',2) limit 1))
        from (${input}) i where not exists (select 1 from contacts c where c.email = i.email)
        on conflict (email) do nothing returning id`, cols);
      return { created: ins.length, updated: upd.length };
    });
    return { ...result, skipped };
  });

  r.get('/companies/:id', async ({ req, params }) => {
    await requireUser(req);
    const c = await one('select * from companies where id=$1', [int(params.id)]);
    if (!c) throw notFound();
    c.contacts = await q('select id,name,email,area from contacts where company_id=$1 order by name', [c.id]);
    return c;
  });

  // ---------- Panel e informes ----------
  r.get('/dashboard', async ({ req, query }) => {
    const u = await requireUser(req);
    const cfg = (await getSetting('helpdesk')) || {};
    const tz = cfg.timezone || 'America/Argentina/Buenos_Aires';
    // $1 = zona horaria, $2 = agente (null = todo el equipo). Nada se concatena.
    const params = [tz, query.scope === 'mine' ? u.id : null];
    const scope = 'and ($2::int is null or t.assignee_id = $2::int)';
    const base = `from tickets t join statuses s on s.id=t.status_id where t.deleted_at is null and not t.spam ${scope} and $1::text is not null`;
    const [counters, byTech, byAssignee, byCategory, byPriority, trend, perf] = await Promise.all([
      one(`select
          count(*) filter (where s.kind in ('open','pending'))::int as unresolved,
          count(*) filter (where s.kind='open')::int as open,
          count(*) filter (where s.kind='pending')::int as pending,
          count(*) filter (where s.kind in ('open','pending') and t.assignee_id is null)::int as unassigned,
          count(*) filter (where s.kind in ('open','pending') and (t.resolution_due < now() or (t.first_responded_at is null and t.first_response_due < now())))::int as overdue,
          count(*) filter (where s.kind in ('open','pending') and (t.resolution_due at time zone $1)::date = (now() at time zone $1)::date)::int as due_today,
          count(*) filter (where (t.created_at at time zone $1)::date = (now() at time zone $1)::date)::int as created_today,
          count(*) filter (where (t.resolved_at at time zone $1)::date = (now() at time zone $1)::date)::int as resolved_today
        ${base}`, params),
      q(`select t.tech_category_id as id, count(*)::int as n ${base} and s.kind in ('open','pending') group by 1 order by 2 desc`, params),
      q(`select t.assignee_id as id, count(*)::int as n ${base} and s.kind in ('open','pending') group by 1 order by 2 desc`, params),
      q(`select t.category_id as id, count(*)::int as n ${base} and s.kind in ('open','pending') group by 1 order by 2 desc`, params),
      q(`select t.priority as id, count(*)::int as n ${base} and s.kind in ('open','pending') group by 1 order by 1`, params),
      // Una sola pasada por tickets (antes: dos subconsultas por cada uno de los 30 días)
      q(`with days as (select generate_series((now() at time zone $1)::date - 29, (now() at time zone $1)::date, interval '1 day')::date as d),
           c as (select (t.created_at at time zone $1)::date as d, count(*)::int as n from tickets t
                 where t.deleted_at is null and not t.spam ${scope} and t.created_at > now() - interval '31 days' group by 1),
           r as (select (t.resolved_at at time zone $1)::date as d, count(*)::int as n from tickets t
                 where t.deleted_at is null and not t.spam ${scope} and t.resolved_at > now() - interval '31 days' group by 1)
         select to_char(days.d,'YYYY-MM-DD') as day, coalesce(c.n,0) as created, coalesce(r.n,0) as resolved
         from days left join c on c.d = days.d left join r on r.d = days.d order by days.d`, params),
      one(`select
          round(avg(extract(epoch from (t.first_responded_at - t.created_at))/3600) filter (where t.first_responded_at is not null)::numeric, 1) as avg_first_response_h,
          round(avg(extract(epoch from (t.resolved_at - t.created_at))/3600) filter (where t.resolved_at is not null)::numeric, 1) as avg_resolution_h,
          count(*) filter (where t.resolved_at is not null and t.resolution_due is not null)::int as with_sla,
          count(*) filter (where t.resolved_at is not null and t.resolution_due is not null and t.resolved_at <= t.resolution_due)::int as within_sla
        ${base} and t.created_at > now() - interval '30 days'`, params),
    ]);
    return { counters, byTech, byAssignee, byCategory, byPriority, trend, perf };
  });

  r.get('/reports/helpdesk', async ({ req, query }) => {
    await requireUser(req, ['admin', 'supervisor']);
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));
    const from = isDate(query.from) ? query.from : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = isDate(query.to) ? query.to : new Date().toISOString().slice(0, 10);
    const params = [from, to];
    const range = `t.deleted_at is null and not t.spam and t.created_at >= $1::date and t.created_at < ($2::date + 1)`;
    const metric = (col) => q(`select t.${col} as id, count(*)::int as created,
        count(*) filter (where t.resolved_at is not null)::int as resolved,
        round(avg(extract(epoch from (t.first_responded_at - t.created_at))/3600) filter (where t.first_responded_at is not null)::numeric,1) as avg_first_h,
        round(avg(extract(epoch from (t.resolved_at - t.created_at))/3600) filter (where t.resolved_at is not null)::numeric,1) as avg_resolution_h,
        count(*) filter (where t.resolution_due is not null and t.resolved_at is not null)::int as with_sla,
        count(*) filter (where t.resolution_due is not null and t.resolved_at is not null and t.resolved_at<=t.resolution_due)::int as within_sla
      from tickets t where ${range} group by 1 order by 2 desc`, params);
    const [byAgent, byCategory, byTech, bySubtech, byChannel, totals, time] = await Promise.all([
      metric('assignee_id'), metric('category_id'), metric('tech_category_id'), metric('tech_subcategory_id'), metric('channel'),
      one(`select count(*)::int as created, count(*) filter (where t.resolved_at is not null)::int as resolved from tickets t where ${range}`, params),
      q(`select e.user_id as id, sum(e.minutes)::int as minutes from time_entries e where e.spent_on between $1::date and $2::date group by 1 order by 2 desc`, params),
    ]);
    return { from, to, byAgent, byCategory, byTech, bySubtech, byChannel, totals, time };
  });
}
