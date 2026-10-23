// Portal público de contactos, base de conocimiento, correo entrante y tareas programadas.
import crypto from 'node:crypto';
import { q, one, tx } from '../db.js';
import { v, parse, idParam } from '../validate.js';
import { limitIp, limit as rateLimit, cleanupRateLimits, hit, peek, TooManyRequests } from '../ratelimit.js';
import { cleanupIdempotency } from '../idempotency.js';
import { requireUser } from '../auth.js';
import { bad, notFound, forbidden, HttpError, int, isEmail } from '../http.js';
import { getSetting } from '../settings.js';
import { crud } from '../crud.js';
import { clientIp } from '../audit.js';
import {
  createTicket, addCustomerMessage, upsertContact, logActivity, notify, textToHtml, portalTicketToken, trustedSender, verifyPortalToken, portalSign,
} from '../tickets-core.js';
import { portalAccess, portalSession, sessionContactIds, sessionRequester, portalMicrosoft, clearPortalSession, portalGate, portalMode, portalParts } from '../portal-session.js';
import { sendMail, layout, escapeHtml, appUrl, mailEnabled } from '../mail.js';
import { projectSummary } from './projects.js';
import { sanitizeHtml } from '../sanitize.js';

async function publicTicket(ticket, contact, given = null) {
  const [messages, atts, status] = await Promise.all([
    q(`select m.id,m.kind,m.body_html,m.created_at,m.from_email,m.meta,u.name as agent_name,c.name as contact_name from ticket_messages m
       left join users u on u.id=m.author_user_id left join contacts c on c.id=m.author_contact_id
       where m.ticket_id=$1 and m.kind in ('customer','reply') order by m.created_at, m.id`, [ticket.id]),
    q(`select a.id,a.ticket_message_id,a.filename,a.size,a.content_type from attachments a join ticket_messages m on m.id=a.ticket_message_id where m.ticket_id=$1 and m.kind in ('customer','reply')`, [ticket.id]),
    one('select name,kind from statuses where id=$1', [ticket.status_id]),
  ]);
  // Sin renovación: con un enlace del ticket se devuelve el mismo (vence a los 30 días de emitido). Desde "mis tickets"
  // (enlace por correo de 7 días) o recién creado se emite uno nuevo.
  // Con la sesión de Microsoft no hace falta enlace: se entra por número
  const token = given?.k === 'ps' ? null
    : given && given.k === 'pt' && given.raw ? given.raw : await portalTicketToken(ticket, contact?.id || ticket.contact_id);
  for (const m of messages) m.attachments = atts.filter((a) => a.ticket_message_id === m.id);
  // Avance del desarrollo: solo nombre de fases y porcentajes (sin datos internos del proyecto)
  const links = await q('select project_id from ticket_projects where ticket_id=$1 order by created_at', [ticket.id]);
  const summaries = await Promise.all(links.map((l) => projectSummary(l.project_id)));
  const development = summaries.filter(Boolean).map((s) => ({
    name: s.name, progress: s.progress, finished: s.finished, current: s.current?.title || null, due_date: s.due_date,
    phases: s.phases.map((f) => ({ title: f.title, state: f.state, pct: f.pct })),
  }));
  return {
    ticket: {
      number: ticket.number, subject: ticket.subject, created_at: ticket.created_at, status: status?.name, status_kind: status?.kind, priority: ticket.priority,
      auto_reply: Boolean(ticket.ai?.auto), feedback: ticket.ai?.feedback || null,
    },
    contact: contact ? { name: contact.name, email: contact.email } : null,
    messages,
    development,
    token,
  };
}

// ---------- Correo entrante ----------
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

function parseAddress(v) {
  if (!v) return { email: '', name: '' };
  if (typeof v === 'object') {
    const e = pick(v, 'address', 'email', 'Address', 'Email', 'emailAddress');
    if (e && typeof e === 'object') return parseAddress(e);
    return { email: String(e || '').toLowerCase(), name: String(pick(v, 'name', 'Name') || '') };
  }
  const s = String(v).trim();
  const m = /^(.*)<([^>]+)>$/.exec(s);
  if (m) return { email: m[2].trim().toLowerCase(), name: m[1].trim().replace(/^"|"$/g, '') };
  return { email: s.toLowerCase(), name: '' };
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(parseAddress).map((a) => a.email).filter(isEmail);
  return String(v).split(/[;,]/).map(parseAddress).map((a) => a.email).filter(isEmail);
}

/** Quita la parte citada de una respuesta de correo (heurística). */
function stripQuoted(html) {
  const markers = [
    /<div[^>]*id="?divRplyFwdMsg"?[\s\S]*$/i,
    /<div[^>]*class="?gmail_quote"?[\s\S]*$/i,
    /<blockquote[^>]*type="?cite"?[\s\S]*$/i,
    /<hr[^>]*>\s*<div[^>]*>\s*<font[^>]*>\s*<b>\s*(De|From):[\s\S]*$/i,
    /(<p[^>]*>|<div[^>]*>)?\s*(<b>)?\s*(De|From):\s*(<\/b>)?[^<]*@[\s\S]*?(Enviado|Sent):[\s\S]*$/i,
    /El .{5,80} escribió:[\s\S]*$/i,
    /On .{5,80} wrote:[\s\S]*$/i,
  ];
  let out = html;
  for (const re of markers) {
    const cut = out.replace(re, '');
    if (cut.trim().length > 0 && cut.length < out.length) out = cut;
  }
  return out;
}

const AUTO_REPLY = /^(respuesta autom[aá]tica|automatic reply|auto[- ]?reply|fuera de la oficina|out of (the )?office|undeliverable|no se puede entregar|delivery status notification)/i;

export async function processInbound(body, req, { ownAddresses = [] } = {}) {
  const from = parseAddress(pick(body, 'from', 'From', 'sender', 'Sender'));
  if (!from.name) from.name = String(pick(body, 'from_name', 'fromName', 'FromName') || '');
  const subject = String(pick(body, 'subject', 'Subject') || '(sin asunto)').trim();
  let html = pick(body, 'html', 'body_html', 'Body', 'body', 'HtmlBody');
  const text = pick(body, 'text', 'body_text', 'TextBody', 'BodyPreview');
  if (!html && text) html = textToHtml(String(text).slice(0, 500000));
  html = String(html || '').slice(0, 2000000);
  let messageId = String(pick(body, 'message_id', 'messageId', 'InternetMessageId', 'internetMessageId', 'Id') || '').slice(0, 500) || null;
  const inReplyTo = String(pick(body, 'in_reply_to', 'inReplyTo', 'In-Reply-To') || '');
  const cc = parseList(pick(body, 'cc', 'Cc', 'CC'));
  const rawAtt = pick(body, 'attachments', 'Attachments') || [];
  const attachments = (Array.isArray(rawAtt) ? rawAtt : [])
    .map((a) => ({
      name: pick(a, 'name', 'Name', 'filename', 'fileName') || 'adjunto',
      type: pick(a, 'contentType', 'ContentType', 'type', 'content_type') || 'application/octet-stream',
      data: pick(a, 'contentBytes', 'ContentBytes', 'data', 'content', 'base64'),
      inline: Boolean(pick(a, 'isInline', 'IsInline')),
    }))
    .filter((a) => a.data && !a.inline);

  if (!isEmail(from.email)) throw bad('Falta el remitente (from)');
  // Sin Message-ID, una huella del contenido evita duplicar el correo si el remitente (o Power Automate) reintenta
  if (!messageId) {
    // Con fecha del correo, la huella es exacta; sin fecha, se agrupan reintentos dentro de 10 minutos
    const when = String(pick(body, 'date', 'Date', 'receivedDateTime', 'ReceivedDateTime') || '') || `~${Math.floor(Date.now() / 600000)}`;
    messageId = `sha:${crypto.createHash('sha256').update(`${from.email}\n${subject}\n${when}\n${html.slice(0, 20000)}`).digest('hex').slice(0, 40)}`;
  }
  const own = String(process.env.MAIL_FROM || '').toLowerCase();
  if ((own && own.includes(from.email)) || ownAddresses.includes(from.email)) return { skipped: 'own' };
  if (AUTO_REPLY.test(subject)) return { skipped: 'auto-reply' };
  if (messageId) {
    const dup = await one('select ticket_id from ticket_messages where message_id=$1', [messageId]);
    if (dup) return { skipped: 'duplicate', ticket_id: dup.ticket_id };
  }

  let ticket = null;
  const tag = /\[#(\d+)\]/.exec(subject);
  if (tag) ticket = await one('select * from tickets where number=$1 and deleted_at is null', [int(tag[1])]);
  if (!ticket && inReplyTo) {
    const m = await one('select ticket_id from ticket_messages where message_id=$1', [inReplyTo]);
    if (m) ticket = await one('select * from tickets where id=$1', [m.ticket_id]);
  }
  if (ticket?.merged_into) ticket = (await one('select * from tickets where number=$1', [ticket.merged_into])) || ticket;
  // Solo se agrega al ticket si escribe el solicitante, alguien en copia o un agente; si no, es un ticket nuevo
  let foreignReply = null;
  if (ticket) {
    const owner = ticket.contact_id ? await one('select email from contacts where id=$1', [ticket.contact_id]) : null;
    const agent = await one('select 1 as x from users where email=$1 and active', [from.email]);
    const allowed = owner?.email === from.email || (ticket.cc || []).includes(from.email) || Boolean(agent);
    if (!allowed) { foreignReply = ticket.number; ticket = null; }
  }

  try {
    if (ticket) {
      const contact = await upsertContact({ email: from.email, name: from.name });
      await addCustomerMessage(ticket, contact, { bodyHtml: sanitizeHtml(stripQuoted(html) || html), attachments, messageId, cc });
      return { ticket: ticket.number, appended: true };
    }
    const support = (((await getSetting('helpdesk')) || {}).support_email || '').toLowerCase();
    const created = await createTicket({
      subject: subject.slice(0, 300), channel: 'email', contact_email: from.email, contact_name: from.name,
      body_html: (foreignReply ? `<p><i>Llegó como respuesta al ticket #${foreignReply}, pero el remitente no es el solicitante ni está en copia.</i></p>` : '') + sanitizeHtml(html),
      cc: cc.filter((x) => x !== support).slice(0, 20), attachments: attachments.slice(0, 10), message_id: messageId,
    }, { req });
    return { ticket: created.number, created: true };
  } catch (e) {
    // El índice único de Message-ID corta el caso de dos entregas simultáneas del mismo correo.
    if (e.code === '23505' && String(e.constraint || e.message).includes('msgid')) return { skipped: 'duplicate' };
    throw e;
  }
}

export function portalRoutes(r) {
  r.get('/portal/config', async ({ req }) => {
    const [brand, cfg, ms, me] = await Promise.all([getSetting('brand', {}), getSetting('helpdesk', {}), portalMicrosoft(), portalSession(req)]);
    const access = portalMode(cfg);
    const parts = portalParts(cfg);
    const base = {
      brand: brand || {}, title: cfg?.portal_title || 'Centro de ayuda', enabled: cfg?.portal_enabled !== false,
      access, parts, support_email: cfg?.support_email || '',
      // Ingreso de empleados con Microsoft (solo ven sus tickets) y la sesión actual, si hay
      microsoft: Boolean(ms), me: me ? { name: me.name, email: me.email } : null,
    };
    // Con acceso solo por Microsoft, sin sesión no se muestra nada más que la pantalla de ingreso
    if (!base.enabled || (access === 'microsoft' && !me)) return { ...base, categories: [], techCategories: [], kbCategories: [], magicLink: false };
    const [categories, tech, kbCats] = await Promise.all([
      q('select id,name from categories where active order by sort, name'),
      q('select id,name from tech_categories where active order by sort, name'),
      parts.kb ? q(`select k.id,k.name,k.description,(select count(*)::int from kb_articles a where a.category_id=k.id and a.status='published') as articles
         from kb_categories k where k.visibility='public' order by k.sort, k.name`) : [],
    ]);
    // Área de quien ingresó (para dejarla elegida al crear un ticket)
    let myCategory = null;
    if (me) {
      const ids = await sessionContactIds(me);
      const c = ids.length ? await one(`select area from contacts where id = any($1::int[]) and coalesce(area,'') <> '' order by (external_id is not null) desc, id limit 1`, [ids]) : null;
      if (c) myCategory = (await (await import('../areas.js')).areaMatcher())(c.area);
    }
    return { ...base, categories, techCategories: tech, kbCategories: kbCats, my_category_id: myCategory, magicLink: access === 'open' && parts.my_tickets && (await mailEnabled()) };
  });

  r.post('/portal/tickets', async ({ req, body: raw }) => {
    const { me } = await portalGate(req, 'create');
    const body = parse(v.object({
      name: v.string({ min: 1, max: 120 }), email: v.email(), subject: v.string({ min: 1, max: 200 }),
      body_text: v.string({ max: 20000, multiline: true, default: '' }),
      category_id: v.id({ optional: true }), tech_category_id: v.id({ optional: true }), group_id: v.id({ optional: true }),
      priority: v.int({ min: 1, max: 4, optional: true }), attachments: v.array(v.attachment(), { max: 5, default: () => [] }),
      website: v.string({ max: 200, optional: true }), ai_tried: v.string({ max: 2000, multiline: true, optional: true }),
    }), raw);
    if (body.website) throw bad('Solicitud inválida');
    // Con sesión de Microsoft el ticket queda a nombre de la cuenta (no se puede abrir a nombre de otro)
    if (me) {
      const who = await sessionRequester(me);
      body.email = who.email;
      body.name = who.name || body.name;
    }
    if (!me && !(await trustedSender(body.email))) throw new HttpError(403, 'Para abrir un ticket usá tu correo de la empresa.');
    // Límites del portal público: por IP y por correo
    await limitIp(req, 'portal-ticket', 10, 3600, 'Creaste muchos tickets seguidos. Esperá un rato y probá de nuevo.');
    await rateLimit(`portal-ticket:email:${body.email}`, 5, 600, 'Creaste muchos tickets seguidos. Esperá unos minutos.');
    const desc = body.body_text.trim();
    const t = await createTicket({
      subject: body.subject, channel: 'portal', contact_email: body.email, contact_name: body.name,
      body_html: desc ? textToHtml(desc) : '', category_id: int(body.category_id), tech_category_id: int(body.tech_category_id),
      attachments: body.attachments, ai_tried: body.ai_tried || '',
      priority: body.priority,
    }, { req });
    return { number: t.number, token: me ? null : await portalTicketToken(t, t.contact_id) };
  }, { idempotent: true });

  // ---------- Consulta rápida del estado de un ticket ----------
  // Con el número y el correo del solicitante (o de alguien en copia). Con sesión de Microsoft alcanza el número.
  // Devuelve el estado, las fechas y la conversación con el usuario (sus mensajes y las respuestas de la mesa; nunca las
  // notas internas). Es de solo lectura: para responder o bajar adjuntos hace falta ingresar o el enlace del correo.
  // Topes: consultas por IP y por correo, y sobre todo intentos fallidos por IP y por número (el dueño con sesión no se traba).
  r.post('/portal/lookup', async ({ req, body: raw }) => {
    const { me, required } = await portalGate(req, 'lookup');
    const body = parse(v.object({ number: v.id(), email: v.string({ max: 254, default: '' }) }), raw);
    // Con acceso solo por Microsoft se consultan únicamente los tickets propios (el correo no se usa)
    const email = required ? '' : body.email.trim().toLowerCase();
    if (!email && !me) throw bad('Ingresá el correo con el que abriste el ticket');
    if (email && !isEmail(email)) throw bad('El correo no es válido');
    await limitIp(req, 'portal-lookup', 60, 3600, 'Hiciste muchas consultas seguidas. Esperá un rato.');
    if (email && !me) await rateLimit(`portal-lookup:e:${email}`, 20, 3600, 'Se hicieron muchas consultas con ese correo. Esperá un rato.');
    const failIp = `portal-lookup-fail:ip:${clientIp(req)}`;
    const failNum = `portal-lookup-fail:n:${body.number}`;
    const [fi, fn] = await Promise.all([peek(failIp, 3600), me ? { count: 0 } : peek(failNum, 3600)]);
    if (fi.count >= 20 || fn.count >= 10) throw new TooManyRequests('Demasiadas consultas sin resultado. Esperá un rato y revisá el número y el correo.', Math.max(fi.reset || 0, fn.reset || 0) || 3600);
    const t = await one(`select t.id,t.number,t.subject,t.created_at,t.updated_at,t.resolved_at,t.closed_at,t.merged_into,t.contact_id,t.cc,
        c.email as contact_email, s.name as status, s.kind as status_kind,
        (select max(m.created_at) from ticket_messages m where m.ticket_id=t.id and m.kind='reply') as last_reply_at
      from tickets t left join contacts c on c.id=t.contact_id left join statuses s on s.id=t.status_id
      where t.number=$1 and t.deleted_at is null and not t.spam`, [body.number]);
    const cc = (t?.cc || []).map((x) => String(x).toLowerCase());
    const ids = me ? await sessionContactIds(me) : [];
    const mine = Boolean(t && ids.includes(t.contact_id));
    const bySession = Boolean(t && me && (mine || cc.some((x) => me.emails.includes(x))));
    const byEmail = Boolean(t && email && (t.contact_email === email || cc.includes(email)));
    // Mismo mensaje si el ticket no existe o el correo no coincide (no se revela qué números existen)
    if (!bySession && !byEmail) {
      await Promise.all([hit(failIp, 3600), me ? null : hit(failNum, 3600)]);
      throw notFound('No encontramos un ticket con ese número para ese correo.');
    }
    const [links, messages, atts] = await Promise.all([
      q('select project_id from ticket_projects where ticket_id=$1 order by created_at', [t.id]),
      q(`select m.id,m.kind,m.body_html,m.created_at,m.meta,u.name as agent_name,c.name as contact_name from ticket_messages m
         left join users u on u.id=m.author_user_id left join contacts c on c.id=m.author_contact_id
         where m.ticket_id=$1 and m.kind in ('customer','reply') order by m.created_at, m.id`, [t.id]),
      q(`select a.ticket_message_id,a.filename,a.size from attachments a join ticket_messages m on m.id=a.ticket_message_id
         where m.ticket_id=$1 and m.kind in ('customer','reply') order by a.id`, [t.id]),
    ]);
    const dev = (await Promise.all(links.map((l) => projectSummary(l.project_id)))).filter(Boolean)
      .map((p) => ({ name: p.name, progress: p.progress, finished: p.finished }));
    return {
      number: t.number, subject: t.subject, status: t.status, status_kind: t.status_kind,
      created_at: t.created_at, updated_at: t.updated_at, resolved_at: t.resolved_at, closed_at: t.closed_at, last_reply_at: t.last_reply_at,
      merged_into: t.merged_into || null, development: dev, can_open: mine,
      messages: messages.map((m) => ({
        kind: m.kind, body_html: m.body_html, created_at: m.created_at, auto: Boolean(m.meta?.auto),
        author: m.kind === 'reply' ? m.agent_name || 'Mesa de ayuda' : m.contact_name || '',
        attachments: atts.filter((a) => a.ticket_message_id === m.id).map((a) => ({ filename: a.filename, size: a.size })),
      })),
    };
  });

  r.post('/portal/logout', async ({ req }) => ({ ok: true, cookie: clearPortalSession(req) }), { setCookie: true });

  r.post('/portal/login', async ({ req, body }) => {
    const { required } = await portalGate(req, 'my_tickets');
    if (required) throw new HttpError(403, 'El acceso al centro de ayuda es con la cuenta de Microsoft.');
    const { email } = parse(v.object({ email: v.email() }), body);
    await limitIp(req, 'portal-login', 10, 3600, 'Pediste muchos enlaces. Esperá un rato.');
    await rateLimit(`portal-login:email:${email}`, 3, 3600, 'Ya te enviamos varios enlaces. Revisá tu correo o esperá un rato.');
    if (!(await mailEnabled())) throw bad('El acceso por correo no está habilitado. Usá el enlace que recibiste en tu ticket.');
    const c = await one('select * from contacts where email=$1', [email]);
    // Mismo resultado haya o no contacto (no se revela quién existe); fuera de los dominios de confianza no se envía nada
    if (c && (await trustedSender(email))) {
      const token = await portalSign({ k: 'pc', c: c.id, n: crypto.randomBytes(4).toString('hex') }, 7 * 86400);
      const link = `${appUrl(req)}/portal#/mis-tickets/${encodeURIComponent(token)}`;
      await sendMail({
        to: email,
        subject: 'Tu acceso al centro de ayuda',
        html: await layout(`<p>Hola ${escapeHtml(c.name)},</p><p>Usá este enlace para ver tus tickets. Vence en 7 días.</p><p><a href="${link}" style="background:#1f2937;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Ver mis tickets</a></p>`),
      });
    }
    return { ok: true };
  });

  r.post('/portal/my-tickets', async ({ req, body }) => {
    const { required } = await portalGate(req, 'my_tickets');
    if (required && body?.token) throw new HttpError(403, 'El acceso al centro de ayuda es con la cuenta de Microsoft.');
    const cols = `t.number,t.subject,t.created_at,t.updated_at,t.resolved_at,s.name as status,s.kind as status_kind,
      (select max(m.created_at) from ticket_messages m where m.ticket_id=t.id and m.kind='reply') as last_reply_at`;
    // Sin enlace: la sesión de Microsoft (solo los tickets de esa persona)
    if (!body?.token) {
      const me = await portalSession(req);
      if (!me) throw new HttpError(401, 'Tu sesión venció. Volvé a ingresar con tu cuenta de Microsoft.');
      const ids = await sessionContactIds(me);
      const tickets = ids.length ? await q(`select ${cols} from tickets t left join statuses s on s.id=t.status_id
        where t.contact_id = any($1::int[]) and t.deleted_at is null and not t.spam order by t.created_at desc limit 500`, [ids]) : [];
      return { contact: { name: me.name, email: me.email }, tickets, session: true };
    }
    const t = await verifyPortalToken(body.token, ['pc']);
    if (!t) throw new HttpError(401, 'El enlace venció. Pedí uno nuevo.');
    const c = await one('select id,name,email from contacts where id=$1', [t.c]);
    if (!c) throw notFound();
    const tickets = await q(`select ${cols} from tickets t left join statuses s on s.id=t.status_id
      where t.contact_id=$1 and t.deleted_at is null and not t.spam order by t.created_at desc limit 200`, [c.id]);
    return { contact: c, tickets };
  });

  r.post('/portal/ticket', async ({ req, body }) => {
    await portalGate(req);
    const { ticket, contact, tok } = await portalAccess(req, body.token, body.number);
    return publicTicket(ticket, contact, tok);
  });

  r.post('/portal/ticket/reply', async ({ req, body: raw }) => {
    await portalGate(req);
    const body = parse(v.object({
      token: v.string({ min: 10, max: 4096, optional: true }), number: v.id({ optional: true }), body_text: v.string({ max: 20000, multiline: true, default: '' }),
      attachments: v.array(v.attachment(), { max: 5, default: () => [] }),
    }), raw);
    await limitIp(req, 'portal-reply', 30, 3600);
    const { ticket, contact, tok } = await portalAccess(req, body.token, body.number);
    const text = body.body_text.trim();
    if (!text && !body.attachments.length) throw bad('Escribí un mensaje');
    await addCustomerMessage(ticket, contact, { bodyHtml: textToHtml(text), attachments: body.attachments });
    return publicTicket(await one('select * from tickets where id=$1', [ticket.id]), contact, tok);
  }, { idempotent: true });

  r.post('/portal/ticket/resolve', async ({ req, body }) => {
    await portalGate(req);
    const { ticket, contact, tok } = await portalAccess(req, body.token, body.number);
    const st = await one(`select id from statuses where kind='resolved' and active order by sort limit 1`);
    if (st) {
      await tx(async () => {
        await q('update tickets set status_id=$2, resolved_at=now(), updated_at=now() where id=$1', [ticket.id, st.id]);
        await logActivity(ticket.id, null, 'resolved_by_contact', {});
        await notify([ticket.assignee_id], `#${ticket.number} lo resolvió el contacto`, ticket.subject, `#/tickets/${ticket.number}`);
      });
    }
    return publicTicket(await one('select * from tickets where id=$1', [ticket.id]), contact, tok);
  });

  // Descarga de un adjunto: enlace de 5 minutos para ese archivo (el enlace del ticket no viaja en la URL)
  r.post('/portal/attachment-link', async ({ req, body }) => {
    await portalGate(req);
    await limitIp(req, 'portal-att', 120, 3600);
    const b = parse(v.object({ token: v.string({ min: 10, max: 4096, optional: true }), number: v.id({ optional: true }), id: v.id() }), body);
    const { ticket, contact } = await portalAccess(req, b.token, b.number);
    const a = await one(`select a.id from attachments a join ticket_messages m on m.id=a.ticket_message_id
      where a.id=$1 and m.ticket_id=$2 and m.kind in ('customer','reply')`, [b.id, ticket.id]);
    if (!a) throw notFound('Adjunto no encontrado');
    const tok = await portalSign({ k: 'pa', a: a.id, t: ticket.id, c: contact?.id || ticket.contact_id }, 300);
    return { url: `/api/attachments/${a.id}?token=${encodeURIComponent(tok)}` };
  });

  r.get('/portal/kb', async ({ req, query }) => {
    await portalGate(req, 'kb');
    if (query.q) query.q = String(query.q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
    if (query.category && !/^\d{1,9}$/.test(query.category)) query.category = '';
    const params = [];
    let where = `a.status='published' and coalesce(k.visibility,'public')='public'`;
    if (query.category) {
      params.push(int(query.category));
      where += ` and a.category_id=$${params.length}`;
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      where += ` and (a.title ilike $${params.length} or a.body_html ilike $${params.length})`;
    }
    return q(`select a.id,a.title,a.category_id,a.updated_at,a.views,k.name as category from kb_articles a left join kb_categories k on k.id=a.category_id where ${where} order by a.views desc, a.title limit 100`, params);
  });

  r.get('/portal/kb/:id', async ({ req, params }) => {
    await portalGate(req, 'kb');
    const a = await one(`select a.*, k.name as category from kb_articles a left join kb_categories k on k.id=a.category_id
      where a.id=$1 and a.status='published' and coalesce(k.visibility,'public')='public'`, [idParam(params.id)]);
    if (!a) throw notFound('Artículo no disponible');
    // Una vista por visitante y día (no se infla recargando)
    const seen = await hit(`kb-view:${a.id}:${clientIp(req)}`, 86400).catch(() => ({ count: 1 }));
    if (seen.count === 1) await q('update kb_articles set views=views+1 where id=$1', [a.id]);
    return a;
  });

  // ---------- Base de conocimiento (agentes) ----------
  crud(r, '/kb/categories', 'kb_categories', { name: 'text', description: 'text', visibility: 'text', sort: 'int' }, {
    roles: ['admin', 'supervisor'], readRoles: null,
    schema: v.object({ name: v.string({ min: 1, max: 120, optional: true }), description: v.string({ max: 500, optional: true }), visibility: v.enum(['public', 'internal'], { optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }) }),
  });

  r.get('/kb/articles', async ({ req, query }) => {
    await requireUser(req);
    if (query.q) query.q = String(query.q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
    if (query.category && !/^\d{1,9}$/.test(query.category)) query.category = '';
    if (query.status && !['draft', 'published'].includes(query.status)) query.status = '';
    const params = [];
    let where = 'true';
    if (query.category) { params.push(int(query.category)); where += ` and a.category_id=$${params.length}`; }
    if (query.q) { params.push(`%${query.q}%`); where += ` and (a.title ilike $${params.length} or a.body_html ilike $${params.length})`; }
    if (query.status) { params.push(query.status); where += ` and a.status=$${params.length}`; }
    return q(`select a.id,a.title,a.category_id,a.status,a.views,a.author_id,a.updated_at from kb_articles a where ${where} order by a.updated_at desc limit 500`, params);
  });
  r.get('/kb/articles/:id', async ({ req, params }) => {
    await requireUser(req);
    const a = await one('select * from kb_articles where id=$1', [int(params.id)]);
    if (!a) throw notFound();
    return a;
  });
  const articleSchema = (create) => v.object({
    title: v.string({ min: 1, max: 200, optional: !create }), body_html: v.html({ max: 500000, optional: true }),
    status: v.enum(['draft', 'published'], { optional: true }), category_id: v.id({ optional: true, nullable: true }),
  });
  r.post('/kb/articles', async ({ req, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(articleSchema(true), raw);
    return one('insert into kb_articles(category_id,title,body_html,status,author_id) values ($1,$2,$3,$4,$5) returning *', [
      body.category_id || null, String(body.title).slice(0, 200), body.body_html || '', body.status === 'published' ? 'published' : 'draft', u.id,
    ]);
  });
  r.patch('/kb/articles/:id', async ({ req, params, body: raw }) => {
    await requireUser(req);
    const body = parse(articleSchema(false), raw);
    const a = await one('select * from kb_articles where id=$1', [idParam(params.id)]);
    if (!a) throw notFound();
    return one('update kb_articles set category_id=$2,title=$3,body_html=$4,status=$5,updated_at=now() where id=$1 returning *', [
      a.id, body.category_id === undefined ? a.category_id : body.category_id || null, body.title ?? a.title, body.body_html ?? a.body_html,
      body.status ? (body.status === 'published' ? 'published' : 'draft') : a.status,
    ]);
  });
  r.del('/kb/articles/:id', async ({ req, params }) => {
    await requireUser(req, ['admin', 'supervisor']);
    await q('delete from kb_articles where id=$1', [int(params.id)]);
    return { ok: true };
  });

  // ---------- Webhook de correo entrante (Power Automate, Make, Resend, etc.) ----------
  r.post('/inbound/email', async ({ req, body, query }) => {
    const secret = process.env.INBOUND_SECRET;
    if (!secret) throw forbidden('Configurá INBOUND_SECRET para habilitar el correo entrante');
    const given = req.headers['x-inbound-secret'] || ''; // solo por encabezado: en la URL quedaría en los logs
    const a = Buffer.from(String(given));
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Clave inválida');
    await limitIp(req, 'inbound', 600, 3600);
    const items = Array.isArray(body) ? body : Array.isArray(body.value) ? body.value : [body];
    const results = [];
    for (const item of items.slice(0, 50)) results.push(await processInbound(item, req));
    return { ok: true, results };
  });

  // ---------- Tarea diaria (Vercel Cron) ----------
  // Vercel Cron: GET solo con CRON_SECRET. Desde la app, un admin la corre con POST (protegido contra CSRF).
  r.get('/cron/daily', async ({ req }) => {
    const secret = process.env.CRON_SECRET;
    const auth = String(req.headers.authorization || '');
    const ok = secret && auth.length === secret.length + 7 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${secret}`));
    if (!ok) throw new HttpError(401, 'Falta la clave de la tarea programada');
    return runDaily(req);
  });
  r.post('/admin/cron/run', async ({ req }) => {
    await requireUser(req, ['admin']);
    return runDaily(req);
  });
}

async function runDaily(req) {
  {
    // Área solicitante de los tickets que quedaron sin ella (ej. el contacto recibió su área después, desde el directorio)
    await (await import('../areas.js')).fillMissingAreas().catch(() => 0);
    const cfg = (await getSetting('helpdesk')) || {};
    const days = int(cfg.auto_close_days, 0);
    let closed = 0;
    if (days > 0) {
      const st = await one(`select id from statuses where kind='closed' and active order by sort limit 1`);
      if (st) {
        closed = await tx(async () => {
          const rows = await q(`update tickets t set status_id=$1, closed_at=now() from statuses s
            where s.id=t.status_id and s.kind='resolved' and t.resolved_at < now() - make_interval(days => $2) returning t.id`, [st.id, days]);
          if (rows.length) {
            await q(`insert into ticket_activities(ticket_id, action, details) select unnest($1::int[]), 'auto_closed', $2::jsonb`, [rows.map((x) => x.id), JSON.stringify({ days })]);
          }
          return rows.length;
        });
      }
    }
    const overdue = await q(`select t.number, t.subject, t.assignee_id from tickets t join statuses s on s.id=t.status_id
      where s.kind in ('open','pending') and t.deleted_at is null and not t.spam and t.assignee_id is not null and t.resolution_due < now()`);
    const byUser = new Map();
    for (const t of overdue) byUser.set(t.assignee_id, [...(byUser.get(t.assignee_id) || []), t]);
    if (byUser.size) {
      const entries = [...byUser.entries()];
      await q(`insert into notifications(user_id, title, body, link) select unnest($1::int[]), unnest($2::text[]), unnest($3::text[]), '#/tickets?view=overdue'`, [
        entries.map(([uid]) => uid), entries.map(([, list]) => `Tenés ${list.length} ticket(s) con SLA vencido`), entries.map(([, list]) => list.slice(0, 5).map((t) => `#${t.number}`).join(', ')),
      ]);
    }
    // Limpieza de tablas técnicas
    await Promise.all([
      cleanupRateLimits(), cleanupIdempotency(),
      q(`delete from sessions where expires_at < now() or last_seen_at < now() - interval '7 days'`),
      q('delete from webauthn_challenges where expires_at < now()'),
    ]).catch(() => {});
    const { m365Daily } = await import('./m365.js');
    const m365 = await m365Daily(overdue, req);
    return { ok: true, closed, overdueNotified: byUser.size, m365 };
  }
}
