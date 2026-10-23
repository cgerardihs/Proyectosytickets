// Lógica de negocio de tickets compartida por agentes, portal y correo entrante.
import { q, one, tx, onCommit } from './db.js';
import { logError } from './log.js';
import { getSetting } from './settings.js';
import { computeDues } from './sla.js';
import { sendMail, layout, escapeHtml, appUrl } from './mail.js';
import { signToken, verifyToken } from './auth.js';
import { HttpError, isEmail } from './http.js';
import { sharepointEnabled, uploadToSharepoint, m365Log } from './m365.js';

/** Contenido de un adjunto, esté en la base o en SharePoint. */
export async function attachmentBuffer(a) {
  if (a.storage === 'sharepoint' && a.external_ref) {
    const { downloadFromSharepoint } = await import('./m365.js');
    return downloadFromSharepoint(a.external_ref);
  }
  // Restaurado de un respaldo liviano: el adjunto quedó registrado pero sin su contenido
  if (!a.data_b64 && Number(a.size) > 0) throw new HttpError(410, 'El contenido de este adjunto no está disponible (se restauró de un respaldo sin adjuntos)');
  return Buffer.from(a.data_b64 || '', 'base64');
}

export const PRIORITIES = { 1: 'Baja', 2: 'Media', 3: 'Alta', 4: 'Urgente' };
export const CHANNELS = ['email', 'portal', 'phone', 'agent', 'teams', 'api', 'chat'];
const MAX_ATTACH = 3 * 1024 * 1024;

export async function logActivity(ticketId, userId, action, details = {}) {
  await q('insert into ticket_activities(ticket_id,user_id,action,details) values ($1,$2,$3,$4::jsonb)', [ticketId, userId || null, action, JSON.stringify(details)]);
}

/** Notificaciones en la app: un solo INSERT para todos los destinatarios (sin N+1). */
export async function notify(userIds, title, body = '', link = '', exceptUserId = null) {
  const ids = [...new Set((userIds || []).filter((x) => x && x !== exceptUserId).map(Number))];
  if (!ids.length) return;
  await q('insert into notifications(user_id,title,body,link) select unnest($1::int[]), $2, $3, $4', [ids, String(title).slice(0, 300), String(body).slice(0, 500), String(link).slice(0, 300)]);
}

/** Busca o crea el contacto por email; asocia empresa por dominio. */
export async function upsertContact({ email, name }) {
  const mail = String(email || '').trim().toLowerCase();
  // Sin comas, punto y coma, espacios ni ángulos: una sola dirección (no se puede colar un segundo destinatario)
  if (!isEmail(mail) || mail.length > 254 || /[\s,;<>()"']/.test(mail) || (mail.match(/@/g) || []).length !== 1) throw new HttpError(400, 'El correo del contacto no es válido');
  const nm = String(name || '').trim().slice(0, 120);
  // Atómico: dos correos simultáneos del mismo remitente no duplican el contacto.
  return one(
    `insert into contacts(name,email,company_id)
       values ($1,$2,(select id from companies where lower(domain)=lower($3) limit 1))
     on conflict (email) do update set name = case when $4 <> '' and (contacts.name = '' or contacts.name = contacts.email) then $4 else contacts.name end
     returning *`,
    [nm || mail.split('@')[0], mail, mail.split('@')[1], nm],
  );
}

export async function saveAttachments(list, { messageId = null, issueId = null, commentId = null, userId = null }) {
  const saved = [];
  for (const a of list || []) {
    if (!a || !a.data) continue;
    const b64 = String(a.data).replace(/^data:[^;]+;base64,/, '');
    const size = Math.floor((b64.length * 3) / 4);
    if (size > MAX_ATTACH) throw new HttpError(413, `El adjunto ${a.name} supera los 3 MB`);
    const filename = String(a.name || 'archivo').slice(0, 200);
    const ctype = String(a.type || 'application/octet-stream').slice(0, 120);
    const row = await one(
      `insert into attachments(ticket_message_id,issue_id,issue_comment_id,filename,content_type,size,data_b64,uploaded_by,storage)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'db') returning id,filename,content_type,size`,
      [messageId, issueId, commentId, filename, ctype, size, b64, userId],
    );
    saved.push(row);
    // Con SharePoint activo, el archivo pasa a la biblioteca DESPUÉS del commit (nunca una llamada externa dentro
    // de la transacción) y en la base queda solo la referencia. Si la subida falla, sigue guardado en la base.
    if (await sharepointEnabled()) {
      await onCommit(async () => {
        try {
          let folder = 'otros';
          if (messageId) folder = `ticket-${(await one('select t.number from ticket_messages m join tickets t on t.id=m.ticket_id where m.id=$1', [messageId]))?.number || 'x'}`;
          else if (issueId) folder = `proyectos/${(await one('select key from issues where id=$1', [issueId]))?.key || 'x'}`;
          const ref = await uploadToSharepoint(folder, filename, Buffer.from(b64, 'base64'), ctype);
          await q(`update attachments set storage='sharepoint', external_ref=$2::jsonb, data_b64=null where id=$1`, [row.id, JSON.stringify(ref)]);
        } catch (e) {
          await m365Log('sharepoint', `No se pudo subir ${filename}, quedó guardado en la base: ${e.message}`, {}, 'error');
        }
      });
    }
  }
  return saved;
}

async function helpdeskCfg() {
  return (await getSetting('helpdesk')) || {};
}

export async function ticketRow(id) {
  return one('select * from tickets where id=$1', [id]);
}

export async function recomputeDues(ticket) {
  const policy = ticket.sla_id ? await one('select * from sla_policies where id=$1', [ticket.sla_id]) : null;
  const cfg = await helpdeskCfg();
  const d = computeDues(ticket.created_at, ticket.priority, policy, cfg);
  const firstDue = ticket.first_responded_at ? ticket.first_response_due : d.first_response_due;
  await q('update tickets set first_response_due=$2, resolution_due=$3 where id=$1', [ticket.id, firstDue, d.resolution_due]);
}

// ---------- Reglas de automatización ----------
function fieldValue(field, ctx) {
  const t = ctx.ticket;
  switch (field) {
    case 'subject': return t.subject || '';
    case 'description': return ctx.text || '';
    case 'from_email': return ctx.contact?.email || '';
    case 'from_domain': return (ctx.contact?.email || '').split('@')[1] || '';
    case 'channel': return t.channel || '';
    case 'priority': return String(t.priority);
    case 'category_id': return String(t.category_id || '');
    case 'type_id': return String(t.type_id || '');
    case 'tech_category_id': return String(t.tech_category_id || '');
    case 'tech_subcategory_id': return String(t.tech_subcategory_id || '');
    case 'contact_area': return ctx.contact?.area || '';
    default: return '';
  }
}

function testCondition(c, ctx) {
  const v = fieldValue(c.field, ctx).toLowerCase();
  const target = String(c.value ?? '').toLowerCase();
  switch (c.op) {
    case 'contains': return target ? v.includes(target) : false;
    case 'not_contains': return !v.includes(target);
    case 'equals': return v === target;
    case 'not_equals': return v !== target;
    case 'starts_with': return v.startsWith(target);
    case 'ends_with': return v.endsWith(target);
    case 'is_empty': return v === '';
    default: return false;
  }
}

// Sin grupo desde la v1.9: una regla vieja que fije el grupo se ignora
const RULE_FIELDS = ['assignee_id', 'priority', 'status_id', 'type_id', 'category_id', 'tech_category_id', 'tech_subcategory_id', 'sla_id'];

export async function applyRules(ticket, ctx) {
  const rules = await q(`select * from automation_rules where active and event='ticket_created' order by sort, id`);
  const patch = {};
  const tags = new Set(ticket.tags || []);
  const fired = [];
  for (const r of rules) {
    const conds = Array.isArray(r.conditions) ? r.conditions : [];
    if (!conds.length) continue;
    const merged = { ...ticket, ...patch };
    const results = conds.map((c) => testCondition(c, { ...ctx, ticket: merged }));
    const ok = r.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    if (!ok) continue;
    fired.push(r.name);
    for (const a of Array.isArray(r.actions) ? r.actions : []) {
      if (a.field === 'add_tag' && a.value) tags.add(String(a.value).trim());
      else if (RULE_FIELDS.includes(a.field)) patch[a.field] = a.value === '' || a.value === null ? null : Number(a.value);
    }
    if (r.stop) break;
  }
  return { patch, tags: [...tags], fired };
}


export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export const textToHtml = (t) => '<p>' + escapeHtml(String(t || '')).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';

// Enlaces del portal (v1.9.6): vencen a los 30 días de emitidos y no se renuevan solos. Todos se pueden anular de una vez
// (Configuración → General → "Anular enlaces del portal"), que sube portal_token_epoch.
export const PORTAL_TOKEN_DAYS = 30;
export async function portalEpoch() {
  // Directo de la base (no del caché de 30 s de cada instancia): al anular, vale en el acto para todas
  const row = await one(`select (value->>'portal_token_epoch')::int as e from app_settings where key='helpdesk'`).catch(() => null);
  return Number(row?.e) || 0;
}

/** Token para que el contacto vea y responda su ticket desde el portal. */
export async function portalTicketToken(ticket, contactId) {
  return signToken({ k: 'pt', t: ticket.id, c: contactId, iat: Math.floor(Date.now() / 1000), ep: await portalEpoch() }, PORTAL_TOKEN_DAYS * 86400);
}

/** Otros tokens del portal ('pc' acceso a mis tickets, 'pa' descarga de un adjunto): con la misma época. */
export async function portalSign(payload, ttlSeconds) {
  return signToken({ ...payload, iat: Math.floor(Date.now() / 1000), ep: await portalEpoch() }, ttlSeconds);
}

/** Verifica un token del portal: firma, vencimiento, tipo y que no se hayan anulado los enlaces. */
export async function verifyPortalToken(token, kinds) {
  const t = verifyToken(String(token || ''));
  if (!t || !kinds.includes(t.k)) return null;
  if ((Number(t.ep) || 0) !== (await portalEpoch())) return null;
  // Enlaces anteriores a la v1.9.6 (180 días y sin fecha de emisión): valen como mucho 30 días desde que se emitieron
  if (!t.iat && t.k === 'pt' && t.exp - (180 - PORTAL_TOKEN_DAYS) * 86400 < Date.now() / 1000) return null;
  return t;
}

export async function ticketSubjectTag(ticket) {
  return `[#${ticket.number}] ${ticket.subject}`;
}

/** Crea un ticket completo. */
export async function createTicket(input, { user = null, req = null } = {}) {
  const subject = String(input.subject || '').trim().slice(0, 300);
  if (!subject) throw new HttpError(400, 'El asunto es obligatorio');
  const channel = CHANNELS.includes(input.channel) ? input.channel : user ? 'agent' : 'portal';
  const bodyHtml = String(input.body_html || (input.body_text ? textToHtml(input.body_text) : '')).slice(0, 500000);
  const contactEmail = String(input.contact_email || '').trim().toLowerCase();
  if (!input.contact_id && !contactEmail) throw new HttpError(400, 'Indicá el contacto (solicitante) del ticket');

  // 1) Clasificación con IA ANTES de la transacción (llamada externa; nunca bloquea la creación)
  let aiClass = null;
  try {
    const ai = await import('./ai.js');
    const cfg = await ai.aiConfig();
    if (cfg.features.classify && cfg.features.classify_mode === 'apply' && !user && (await ai.aiAvailable(cfg))) {
      const known = input.contact_id ? await one('select * from contacts where id=$1', [input.contact_id]) : await one('select * from contacts where email=$1', [contactEmail]);
      aiClass = await ai.classifyText(cfg, { subject, text: stripHtml(bodyHtml), contact: known || { name: input.contact_name } });
    }
  } catch (e) {
    logError('clasificación con IA', { error: e });
  }

  // 2) Todas las escrituras en una sola transacción
  let contact;
  let t;
  const row = await tx(async () => {
    contact = input.contact_id ? await one('select * from contacts where id=$1', [input.contact_id]) : await upsertContact({ email: contactEmail, name: input.contact_name });
    if (!contact) throw new HttpError(400, 'Indicá el contacto (solicitante) del ticket');
    const [status, sla] = await Promise.all([
      input.status_id ? one('select id from statuses where id=$1', [input.status_id]) : one('select id from statuses where is_default and active order by sort limit 1'),
      input.sla_id ? one('select id from sla_policies where id=$1', [input.sla_id]) : one('select id from sla_policies where is_default and active limit 1'),
    ]);
    const priority = [1, 2, 3, 4].includes(Number(input.priority)) ? Number(input.priority) : 1;
    const base = {
      subject, channel, contact_id: contact.id, status_id: status?.id || null, priority,
      tech_category_id: input.tech_category_id || null, tech_subcategory_id: input.tech_subcategory_id || null, type_id: input.type_id || null,
      category_id: input.category_id || null, assignee_id: input.assignee_id || null, sla_id: sla?.id || null,
      tags: Array.isArray(input.tags) ? input.tags.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 20) : [],
      cc: Array.isArray(input.cc) ? input.cc.filter(isEmail).map((x) => x.toLowerCase()).slice(0, 20) : [],
    };
    const rules = await applyRules(base, { contact, text: stripHtml(bodyHtml) });
    t = { ...base, ...Object.fromEntries(Object.entries(rules.patch).filter(([k]) => input[k] === undefined || input[k] === null || input[k] === '')), tags: rules.tags };
    // Área solicitante: si no vino ni la puso una regla, la del contacto (antes que la sugerencia de la IA)
    if (!t.category_id && contact.area) t.category_id = (await (await import('./areas.js')).areaMatcher())(contact.area);
    if (aiClass) {
      for (const k of ['tech_category_id', 'type_id', 'category_id']) if (!t[k] && aiClass[k]) t[k] = aiClass[k];
      // La IA no puede marcar Urgente un ticket que vino de afuera (un texto manipulado no dispara alertas ni SLA críticos)
      if (aiClass.priority && !input.priority && !rules.patch.priority) t.priority = Math.min(3, aiClass.priority);
    }
    // La subcategoría solo vale si es de la categoría técnica final del ticket
    if (t.tech_subcategory_id) {
      const sub = await one('select tech_category_id from tech_subcategories where id=$1', [t.tech_subcategory_id]);
      if (!sub || sub.tech_category_id !== t.tech_category_id) t.tech_subcategory_id = null;
    }

    const custom = input.custom && typeof input.custom === 'object' ? input.custom : {};
    const r = await one(
      `insert into tickets(subject,channel,contact_id,status_id,priority,group_id,tech_category_id,type_id,category_id,assignee_id,sla_id,tags,cc,custom,created_by,tech_subcategory_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16) returning *`,
      [t.subject, t.channel, t.contact_id, t.status_id, t.priority, null, t.tech_category_id, t.type_id, t.category_id, t.assignee_id, t.sla_id, t.tags, t.cc, JSON.stringify(custom), user?.id || null, t.tech_subcategory_id || null],
    );
    await recomputeDues(r);
    const msg = await one(
      `insert into ticket_messages(ticket_id,kind,author_contact_id,author_user_id,from_email,to_emails,cc_emails,body_html,message_id)
       values ($1,'customer',$2,$3,$4,$5,$6,$7,$8) returning id`,
      [r.id, contact.id, null, contact.email, input.to ? [].concat(input.to).slice(0, 20) : [], t.cc, bodyHtml || '<p>(sin descripción)</p>', input.message_id || null],
    );
    if (input.attachments?.length) await saveAttachments(input.attachments, { messageId: msg.id, userId: user?.id || null });
    await logActivity(r.id, user?.id, 'created', { channel, rules: rules.fired });
    if (aiClass) await logActivity(r.id, null, 'ai_classified', { motivo: aiClass.motivo });
    if (user) await q('insert into ticket_followers(ticket_id,user_id) values ($1,$2) on conflict do nothing', [r.id, user.id]);
    const link = `#/tickets/${r.number}`;
    if (t.assignee_id) await notify([t.assignee_id], `Te asignaron el ticket #${r.number}`, subject, link, user?.id);
    else {
      // Sin grupos: un ticket nuevo sin asignar avisa a administradores y supervisores (los que reparten)
      const managers = await q(`select id from users where active and role in ('admin','supervisor')`);
      await notify(managers.map((m) => m.id), `Nuevo ticket sin asignar #${r.number}`, subject, link, user?.id);
    }
    // 3) Lo externo (IA, correos, Teams) corre recién después del commit
    await onCommit(() => afterTicketCreated(r, contact, t, { input, req, bodyHtml }));
    return r;
  });
  return one('select * from tickets where id=$1', [row.id]);
}

/**
 * ¿El correo es de confianza? Si no hay dominios configurados, todos lo son (como antes).
 * Con dominios: los de esos dominios (y sus subdominios) y, si se permite, los contactos del directorio de Microsoft 365.
 * (No alcanza con "contacto existente": cualquiera que haya escrito una vez ya es contacto.)
 */
export async function trustedSender(email) {
  const cfg = await helpdeskCfg();
  const list = (cfg.portal_trusted_domains || []).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!list.length) return true;
  const mail = String(email || '').trim().toLowerCase();
  const dom = mail.includes('@') ? mail.split('@').pop() : '';
  if (dom && list.some((d) => dom === d || dom.endsWith(`.${d}`))) return true;
  if (cfg.portal_allow_directory_contacts !== false && mail) {
    const c = await one('select 1 as x from contacts where email=$1 and external_id is not null and coalesce(active, true)', [mail]).catch(() => null);
    if (c) return true;
  }
  return false;
}

async function afterTicketCreated(row, contact, t, { input, req, bodyHtml }) {
  if (t.assignee_id) await emailAgentAssignment(row, t.assignee_id, req).catch((e) => logError('aviso de asignación', { error: e }));
  let autoHtml = null;
  // Remitentes fuera de los dominios de confianza: el ticket se crea, pero no se les escribe solo (evita usar la mesa para mandar spam)
  const trusted = row.channel === 'agent' || (await trustedSender(contact.email));
  if (!trusted) await logActivity(row.id, null, 'auto_mail_skipped', { reason: 'untrusted_sender' });
  if (trusted) {
    try {
      const { autoRespond } = await import('./ai.js');
      autoHtml = await autoRespond(row, contact, stripHtml(bodyHtml), { tried: input.ai_tried || '' });
    } catch (e) {
      logError('respuesta automática', { error: e });
    }
  }
  const cfg = await helpdeskCfg();
  if (trusted && cfg.notify_contact_on_create !== false && row.channel !== 'agent' && input.notify_contact !== false) {
    // Desde el portal cualquiera puede escribir un correo ajeno de la empresa: a ese correo no se le reenvía nada de lo
    // que escribió el que cargó el ticket (ni el asunto ni la sugerencia de la IA, que se ven solo en el portal).
    const fromPortal = row.channel === 'portal';
    const { renderMail } = await import('./mail-templates.js');
    // Portal abierto: el asunto lo escribió quien cargó el ticket (puede no ser el dueño del correo): no se reenvía
    const openPortal = fromPortal && cfg.portal_access === 'open';
    const tpl = await renderMail(fromPortal ? 'created_portal' : 'created', { contact, ticket: openPortal ? { ...row, subject: 'Su solicitud' } : row });
    await emailContact(row, contact, {
      subject: tpl.subject,
      html: (fromPortal ? tpl.html : autoHtml || tpl.html)
        + (openPortal ? '<p style="font-size:12px;color:#6b7280">Si no la cargó usted, avísele a la mesa de ayuda respondiendo este correo.</p>' : ''),
      req, idempotencyKey: `ticket-${row.id}-created`,
    });
  }
  try {
    const { teamsNotify } = await import('./m365.js');
    const url = `${appUrl(req)}/#/tickets/${row.number}`;
    const facts = [['Solicitante', contact.name], ['Prioridad', PRIORITIES[t.priority]]];
    if (t.priority === 4) await teamsNotify('urgent', { title: `Ticket urgente #${row.number}: ${row.subject}`, url, facts });
    else if (!t.assignee_id) await teamsNotify('unassigned', { title: `Nuevo ticket sin asignar #${row.number}: ${row.subject}`, url, facts });
  } catch { /* opcional */ }
}

export async function emailContact(ticket, contact, { subject, html, req, cc = [], attachments = [], idempotencyKey }) {
  if (!contact?.email) return { sent: false };
  // Solicitante genérico de una importación (dominio .invalid): no se le escribe
  if (/\.invalid$/i.test(contact.email)) return { sent: false, error: 'El ticket no tiene un solicitante real: cambialo antes de responder por correo' };
  const cfg = await helpdeskCfg();
  const token = await portalTicketToken(ticket, contact.id);
  const link = `${appUrl(req)}/portal#/ticket/${encodeURIComponent(token)}`;
  // Texto del botón y de la nota al pie: Configuración → Correos a los usuarios
  const tpls = await (await import('./mail-templates.js')).mailTemplates();
  const body = await layout(
    `${html}<p style="margin-top:20px"><a href="${link}" style="background:#1f2937;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:13px">${escapeHtml(tpls.button)}</a></p>
     ${tpls.footer ? `<p style="font-size:12px;color:#6b7280">${escapeHtml(tpls.footer)}</p>` : ''}`,
  );
  // El enlace al portal es personal: las personas en copia reciben el mismo mensaje, pero sin ese enlace.
  const ccList = [...new Set((cc || []).filter((x) => x && x !== contact.email))];
  const main = await sendMail({ to: contact.email, subject, html: body, replyTo: cfg.support_email || undefined, attachments, idempotencyKey });
  if (ccList.length) {
    const ccBody = await layout(`${html}<p style="font-size:12px;color:#6b7280">Recibís este correo porque estás en copia. Para responder, contestá sin modificar el asunto.</p>`);
    await sendMail({ to: ccList, subject, html: ccBody, replyTo: cfg.support_email || undefined, attachments, idempotencyKey: idempotencyKey ? `${idempotencyKey}-cc` : undefined });
  }
  return main;
}

export async function emailAgentAssignment(ticket, userId, req) {
  const cfg = await helpdeskCfg();
  if (cfg.notify_agent_on_assign === false) return;
  const u = await one('select name,email from users where id=$1 and active', [userId]);
  if (!u) return;
  const link = `${appUrl(req)}/#/tickets/${ticket.number}`;
  await sendMail({
    to: u.email,
    subject: `Te asignaron el ticket #${ticket.number}: ${ticket.subject}`,
    html: await layout(`<p>Hola ${escapeHtml(u.name)},</p><p>Se te asignó el ticket <b>#${ticket.number}</b> — ${escapeHtml(ticket.subject)}.</p><p><a href="${link}">Abrir ticket</a></p>`),
  });
}

/** Mensaje entrante del contacto (correo o portal). Reabre si estaba resuelto/cerrado. */
export async function addCustomerMessage(ticket, contact, opts) {
  return tx(() => addCustomerMessageTx(ticket, contact, opts));
}

async function addCustomerMessageTx(ticket, contact, { bodyHtml, attachments = [], messageId = null, cc = [] }) {
  const msg = await one(
    `insert into ticket_messages(ticket_id,kind,author_contact_id,from_email,cc_emails,body_html,message_id) values ($1,'customer',$2,$3,$4,$5,$6) returning id`,
    [ticket.id, contact?.id || null, contact?.email || '', cc, bodyHtml || '<p>(sin contenido)</p>', messageId],
  );
  if (attachments.length) await saveAttachments(attachments, { messageId: msg.id });
  const st = await one('select kind from statuses where id=$1', [ticket.status_id]);
  if (st && st.kind !== 'open') {
    const open = await one(`select id,name from statuses where kind='open' and active order by is_default desc, sort limit 1`);
    if (open) {
      await q('update tickets set status_id=$2, resolved_at=null, closed_at=null, sla_paused_at=null where id=$1', [ticket.id, open.id]);
      await logActivity(ticket.id, null, 'reopened', { by: 'contact', to: open.name });
    }
  }
  await q('update tickets set updated_at=now(), last_activity_at=now() where id=$1', [ticket.id]);
  const followers = await q('select user_id from ticket_followers where ticket_id=$1', [ticket.id]);
  await notify([ticket.assignee_id, ...followers.map((f) => f.user_id)], `Nueva respuesta en #${ticket.number}`, `${contact?.name || 'El contacto'} respondió: ${ticket.subject}`, `#/tickets/${ticket.number}`);
  return msg;
}

// ---------- Descarga segura de adjuntos ----------
// Solo se muestran en línea tipos que el navegador no puede ejecutar. Todo lo demás (SVG, HTML, JS, etc.)
// se descarga como binario, con una CSP que bloquea cualquier script si igual se abriera.
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export function sendAttachment(res, a, buf, { download = false } = {}) {
  const type = String(a.content_type || '').toLowerCase().split(';')[0].trim();
  const inline = INLINE_SAFE.has(type) && !download;
  res.statusCode = 200;
  res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  // El visor de PDF del navegador no funciona en un documento "sandbox"; los PDF no ejecutan scripts con el origen de la app.
  if (type !== 'application/pdf' || !inline) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(buf);
}
