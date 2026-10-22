// Rutas de IA: copiloto del agente, sugerencias del portal, respuesta del usuario y configuración.
import { q, one, tx } from '../db.js';
import { limitIp, hit } from '../ratelimit.js';
import { v, parse } from '../validate.js';
import { requireUser } from '../auth.js';
import { bad, notFound, HttpError, int } from '../http.js';
import { getSetting } from '../settings.js';
import { stripHtml, logActivity, notify, trustedSender } from '../tickets-core.js';
import { getByNumber } from './tickets.js';
import {
  aiConfig, saveAiConfig, keyConfigured, aiAvailable, monthUsage, complete, parseJson, render, textToStepsHtml, findArticles, relatedTickets,
  articlesText, matchRule, buildAutoReply, exclusionReason, classificationLists, classificationFormat, cleanClassification, classifyText,
  PROVIDERS, PROMPT_VARS, DEFAULT_PROMPTS, AiError, untrusted, safeName,
} from '../ai.js';

import { clientIp } from '../audit.js';
const aiErr = (e) => (e instanceof AiError ? new HttpError(400, e.message) : e);

async function ticketContext(t, { includeNotes = true } = {}) {
  const [contact, messages] = await Promise.all([
    t.contact_id ? one('select * from contacts where id=$1', [t.contact_id]) : null,
    q(`select m.kind,m.body_html,m.created_at,m.meta,u.name as agent from ticket_messages m left join users u on u.id=m.author_user_id
       where m.ticket_id=$1 order by m.created_at, m.id`, [t.id]),
  ]);
  const label = { customer: safeName(contact?.name) || 'Usuario', reply: 'Agente', note: 'Nota interna', forward: 'Reenvío', system: 'Sistema' };
  const hist = messages
    .filter((m) => includeNotes || m.kind !== 'note')
    .map((m) => {
      const who = m.meta?.ai ? 'Asistente automático' : m.kind === 'reply' && m.agent ? `Agente ${m.agent}` : label[m.kind];
      const text = stripHtml(m.body_html).slice(0, 1500);
      // Lo que escribió el usuario (o llegó reenviado) va marcado como dato no confiable
      // Todo texto (también notas y mensajes del sistema, que pueden citar asuntos del usuario) va sin < ni > para que nada cierre las etiquetas
      const plainText = text.replace(/</g, '‹').replace(/>/g, '›');
      const body = ['customer', 'forward'].includes(m.kind) ? untrusted(text, 'mensaje_usuario') : m.kind === 'note' ? `(INTERNA, no compartir con el usuario) ${plainText}` : plainText;
      return `[${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')}] ${safeName(who)}: ${body}`;
    });
  // Se priorizan el primer y los últimos mensajes si la conversación es larga
  let historial = hist.join('\n');
  if (historial.length > 9000) historial = [hist[0], '…', ...hist.slice(-6)].join('\n').slice(0, 9000);
  const first = messages.find((m) => m.kind === 'customer');
  return { contact, messages, historial: `<historial>\n${historial}\n</historial>`, description: first ? stripHtml(first.body_html) : '' };
}

async function baseVars(t, ctx, user, cfg) {
  const brand = (await getSetting('brand')) || {};
  return {
    empresa: brand.name || 'la empresa', tono: cfg.tone === 'vos' ? 'vos' : 'usted', 'contacto.nombre': safeName(ctx.contact?.name || 'el usuario'), 'contacto.area': ctx.contact?.area || 'sin área',
    'ticket.numero': t.number, 'ticket.asunto': untrusted(t.subject), 'ticket.descripcion': untrusted(ctx.description.slice(0, 3000)), historial: ctx.historial,
    'agente.nombre': user?.name || '', 'regla.guia': '', relacionados: '', articulos: '', pregunta: '',
  };
}

async function namesFor(c) {
  if (!c) return null;
  const [tc, ty, ca] = await Promise.all([
    c.tech_category_id ? one('select name from tech_categories where id=$1', [c.tech_category_id]) : null,
    c.type_id ? one('select name from ticket_types where id=$1', [c.type_id]) : null,
    c.category_id ? one('select name from categories where id=$1', [c.category_id]) : null,
  ]);
  return { ...c, names: { tech_category: tc?.name || null, type: ty?.name || null, category: ca?.name || null } };
}

/** Respuesta del usuario a la respuesta automática ("¿Le sirvió?"). */
export async function applyFeedback(ticket, helpful) {
  const auto = ticket.ai?.auto;
  if (!auto) throw bad('Este ticket no tiene respuesta automática');
  if (ticket.ai?.feedback) return { already: true };
  return tx(() => applyFeedbackTx(ticket, helpful, auto));
}

async function applyFeedbackTx(ticket, helpful, auto) {
  // Bloqueo de la fila: dos clics simultáneos no cuentan dos veces
  const fresh = await one('select ai from tickets where id=$1 for update', [ticket.id]);
  if (fresh?.ai?.feedback) return { already: true };
  await q(`update tickets set ai = ai || $2::jsonb, updated_at=now(), last_activity_at=now() where id=$1`, [ticket.id, JSON.stringify({ feedback: helpful ? 'yes' : 'no', feedback_at: new Date().toISOString(), needs_agent: !helpful })]);
  await logActivity(ticket.id, null, 'ai_feedback', { helpful });
  if (helpful) {
    if (auto.rule_id) await q('update ai_rules set confirmed=confirmed+1 where id=$1', [auto.rule_id]);
    if (auto.on_confirm === 'resolve') {
      const st = await one(`select id from statuses where kind='resolved' and active order by sort limit 1`);
      if (st) await q('update tickets set status_id=$2, resolved_at=now() where id=$1', [ticket.id, st.id]);
    }
    await notify([ticket.assignee_id], `#${ticket.number}: al usuario le sirvió la respuesta automática`, auto.on_confirm === 'resolve' ? 'El ticket se resolvió por autoservicio.' : ticket.subject, `#/tickets/${ticket.number}`);
  } else {
    // Sin asignado: avisa a quienes siguen el ticket
    let to = [ticket.assignee_id];
    if (!ticket.assignee_id) to = (await q('select user_id from ticket_followers where ticket_id=$1', [ticket.id])).map((m) => m.user_id);
    if (!to.filter(Boolean).length) to = (await q(`select id from users where active and role in ('admin','supervisor')`)).map((m) => m.id);
    await notify(to, `#${ticket.number}: el usuario necesita un agente`, 'La respuesta automática no le resolvió el problema.', `#/tickets/${ticket.number}`);
  }
  return { ok: true };
}

export function aiRoutes(r) {
  // ---------- Copiloto ----------
  r.post('/tickets/:num/ai/copilot', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const cfg = await aiConfig();
    if (!cfg.features.copilot) throw bad('El copiloto está desactivado en Configuración');
    const t = await getByNumber(params.num);
    const ctx = await ticketContext(t);
    const [articles, related, rule] = await Promise.all([
      findArticles(`${t.subject} ${ctx.description}`, { limit: 3, publicOnly: false }),
      relatedTickets(t, ctx.description, 4, u),
      matchRule({ text: `${t.subject}\n${ctx.description}`, category_id: t.category_id, tech_category_id: t.tech_category_id }),
    ]);
    const base = {
      related, articles: articles.map((a) => ({ id: a.id, title: a.title })), rule: rule ? { id: rule.id, name: rule.name } : null,
      message_count: ctx.messages.length, provider: PROVIDERS[cfg.provider].label, model: cfg.modelName,
    };
    const cached = t.ai?.copilot;
    const refresh = body?.refresh === true;
    if (!refresh && cached && cached.message_count === ctx.messages.length) return { ...base, ...cached, cached: true };
    if (!(await aiAvailable(cfg))) {
      // Sin IA: datos útiles igual (relacionados, artículos y la guía de la regla)
      const steps = rule?.guide ? rule.guide.split('\n').map((x) => x.replace(/^\s*(\d+[.)-]|[-•*])\s*/, '').trim()).filter(Boolean) : [];
      return {
        ...base, ai: false, summary: [ctx.description.slice(0, 280) || t.subject], steps, classification: null,
        notice: keyConfigured(cfg) ? 'Se alcanzó el tope mensual de IA.' : 'La IA no está configurada: se muestran la guía de la regla, tickets parecidos y artículos.',
      };
    }
    const lists = await classificationLists();
    const vars = { ...(await baseVars(t, ctx, u, cfg)), articulos: articlesText(articles), relacionados: related.length ? untrusted(related.map((x) => `#${x.number} ${x.subject} (${x.status_name || ''})`).join('\n'), 'tickets_parecidos') : '(ninguno)', 'regla.guia': rule?.guide || '' };
    const prompt = `${render(cfg.prompts.copilot, vars)}

Clasificación actual: categoría técnica ${t.tech_category_id || '-'}, tipo ${t.type_id || '-'}, área ${t.category_id || '-'}, prioridad ${t.priority}.
${classificationFormat(lists)}

Respondé SOLO con JSON:
{"resumen": ["2 a 4 frases cortas: qué pasa, qué se sabe y qué urgencia tiene"], "pasos": ["próximos pasos concretos para el agente"], "clasificacion": {"tech_category_id": id o null, "type_id": id o null, "category_id": id o null, "priority": 1-4}, "motivo": "por qué esa clasificación"}`;
    let out;
    try {
      out = await complete(cfg, { prompt, feature: 'copilot', maxTokens: 900, userId: u.id, ticketId: t.id });
    } catch (e) { throw aiErr(e); }
    const j = parseJson(out) || {};
    const cls = cleanClassification({ ...(j.clasificacion || {}), motivo: j.motivo }, lists);
    const result = {
      ai: true,
      summary: (Array.isArray(j.resumen) ? j.resumen : [String(j.resumen || out)]).map(String).filter(Boolean).slice(0, 5),
      steps: (Array.isArray(j.pasos) ? j.pasos : []).map(String).filter(Boolean).slice(0, 6),
      classification: await namesFor(cls),
      generated_at: new Date().toISOString(),
      message_count: ctx.messages.length,
    };
    await q(`update tickets set ai = ai || $2::jsonb where id=$1`, [t.id, JSON.stringify({ copilot: result })]);
    return { ...base, ...result };
  });

  r.post('/tickets/:num/ai/draft', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(v.object({
      mode: v.enum(['new', 'shorter', 'formal', 'friendly', 'regenerate'], { default: 'new' }), current_text: v.string({ max: 8000, multiline: true, default: '' }),
      instruction: v.string({ max: 500, optional: true }), use_internal: v.bool({ default: false }),
    }), raw);
    const cfg = await aiConfig();
    if (!cfg.features.copilot) throw bad('El copiloto está desactivado en Configuración');
    const t = await getByNumber(params.num);
    // El borrador es para el usuario: por defecto, sin notas internas ni artículos internos (el agente puede pedirlos a propósito)
    const ctx = await ticketContext(t, { includeNotes: body.use_internal });
    const articles = await findArticles(`${t.subject} ${ctx.description}`, { limit: 3, publicOnly: !body.use_internal });
    const vars = { ...(await baseVars(t, ctx, u, cfg)), articulos: articlesText(articles) };
    const current = String(body.current_text || '').trim().slice(0, 4000);
    const modes = {
      shorter: 'Reescribí el borrador actual más corto (la mitad o menos), sin perder lo importante.',
      formal: 'Reescribí el borrador actual con un tono más formal.',
      friendly: 'Reescribí el borrador actual con un tono más cercano y cálido.',
    };
    let prompt = render(cfg.prompts.draft, vars);
    if (modes[body.mode] && current) prompt += `\n\n${modes[body.mode]}\nBorrador actual:\n${current}`;
    else if (body.mode === 'regenerate' && current) prompt += `\n\nEscribí una versión distinta a este borrador:\n${current}`;
    if (body.instruction) prompt += `\n\nIndicación del agente: ${String(body.instruction).slice(0, 500)}`;
    if (body.use_internal) prompt += '\n\nEl agente pidió usar el contexto interno: usalo para entender el caso, pero no copies textualmente notas internas ni datos que el usuario no deba ver.';
    prompt += '\n\nDevolvé solo el texto del mensaje, empezando por el saludo. Sin firma ni comentarios.';
    try {
      const text = await complete(cfg, { prompt, feature: 'draft', maxTokens: 800, userId: u.id, ticketId: t.id });
      return { html: textToStepsHtml(text.replace(/^```\w*|```$/g, '').trim()), text };
    } catch (e) { throw aiErr(e); }
  });

  r.post('/tickets/:num/ai/ask', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(v.object({ question: v.string({ min: 1, max: 800 }) }), raw);
    const cfg = await aiConfig();
    if (!cfg.features.copilot) throw bad('El copiloto está desactivado en Configuración');
    const question = String(body.question || '').trim().slice(0, 800);
    if (!question) throw bad('Escribí una pregunta');
    const t = await getByNumber(params.num);
    const ctx = await ticketContext(t);
    const articles = await findArticles(`${question} ${t.subject}`, { limit: 3, publicOnly: false });
    const vars = { ...(await baseVars(t, ctx, u, cfg)), articulos: articlesText(articles), pregunta: question };
    try {
      const text = await complete(cfg, { prompt: render(cfg.prompts.ask, vars), feature: 'ask', maxTokens: 600, userId: u.id, ticketId: t.id });
      return { html: textToStepsHtml(text), text };
    } catch (e) { throw aiErr(e); }
  });

  // ---------- Portal ----------
  r.post('/portal/suggest', async ({ req, body: raw }) => {
    await limitIp(req, 'portal-suggest', 40, 600, 'Demasiadas consultas seguidas. Esperá un momento.');
    const body = parse(v.object({
      subject: v.string({ max: 300, default: '' }), body_text: v.string({ max: 4000, multiline: true, default: '' }), email: v.string({ max: 254, default: '' }),
      priority: v.int({ min: 1, max: 4, optional: true }), group_id: v.id({ optional: true }), category_id: v.id({ optional: true }), tech_category_id: v.id({ optional: true }),
    }), raw);
    const hd = (await getSetting('helpdesk')) || {};
    if (hd.portal_enabled === false) throw new HttpError(403, 'El portal está deshabilitado');
    const cfg = await aiConfig();
    if (!cfg.features.portal_suggest) return { suggestion: null };
    const subject = String(body.subject || '').trim().slice(0, 300);
    const text = String(body.body_text || '').trim().slice(0, 4000);
    if ((subject + text).length < 12) return { suggestion: null };
    const email = String(body.email || '').trim().toLowerCase();
    // Con dominios de confianza configurados, la IA del portal solo responde a esos correos (evita gastar el cupo con bots)
    const domains = (hd.portal_trusted_domains || []).length;
    if (domains && (!email || !(await trustedSender(email)))) return { suggestion: null };
    const contact = email ? await one('select * from contacts where email=$1', [email]) : null;
    const ticket = { id: null, number: '', subject, priority: int(body.priority) || 1, category_id: int(body.category_id), tech_category_id: int(body.tech_category_id), channel: 'portal' };
    const s = await buildAutoReply({ ticket, contact, text, purpose: 'portal_suggest', ip: clientIp(req), cfg });
    if (!s || s.excluded) return { suggestion: null };
    if (s.rule) await q('update ai_rules set hits=hits+1 where id=$1', [s.rule.id]);
    return { suggestion: { html: s.html, text: s.text, rule: s.rule, articles: s.articles.map((a) => ({ id: a.id, title: a.title })), used_ai: s.used_ai } };
  });

  r.post('/portal/deflect', async ({ req, body: raw }) => {
    await limitIp(req, 'portal-deflect', 20, 3600);
    const body = parse(v.object({ rule_id: v.id({ optional: true, nullable: true }), email: v.string({ max: 254, default: '' }), subject: v.string({ min: 1, max: 300 }) }), raw);
    const ruleId = body.rule_id || null;
    // Solo cuenta si viene de un correo de confianza y una vez por visitante y asunto en el día (no se inflan las métricas)
    if (!(await trustedSender(body.email))) return { ok: true };
    const once = await hit(`deflect:${clientIp(req)}:${body.subject.toLowerCase().slice(0, 120)}`, 86400).catch(() => ({ count: 1 }));
    if (once.count > 1) return { ok: true };
    await tx(async () => {
      await q('insert into ai_deflections(rule_id,email,subject) values ($1,$2,$3)', [ruleId, body.email.slice(0, 200), body.subject]);
      if (ruleId) await q('update ai_rules set deflected=deflected+1 where id=$1', [ruleId]);
    });
    return { ok: true };
  });

  r.post('/portal/ticket/feedback', async ({ req, body: raw }) => {
    if ((await getSetting('helpdesk'))?.portal_enabled === false) throw new HttpError(403, 'El portal está deshabilitado');
    await limitIp(req, 'portal-feedback', 30, 3600);
    const body = parse(v.object({ token: v.string({ min: 10, max: 4096, optional: true }), number: v.id({ optional: true }), helpful: v.bool() }), raw);
    // Con el enlace del ticket, el de "mis tickets" o la sesión de Microsoft: siempre el solicitante actual del ticket
    const { portalAccess } = await import('../portal-session.js');
    const { ticket } = await portalAccess(req, body.token, body.number);
    return applyFeedback(ticket, Boolean(body.helpful));
  });

  // ---------- Configuración ----------
  r.get('/admin/ai', async ({ req }) => {
    await requireUser(req, ['admin']);
    const cfg = await aiConfig();
    const [usage, rules, auto, deflections] = await Promise.all([
      monthUsage(),
      q('select * from ai_rules order by sort, id'),
      one(`select count(*) filter (where (ai->'auto') is not null)::int as auto_replies,
             count(*) filter (where ai->>'feedback'='yes')::int as helpful,
             count(*) filter (where ai->>'feedback'='no')::int as not_helpful
           from tickets where created_at >= date_trunc('month', now())`),
      one(`select count(*)::int as n from ai_deflections where created_at >= date_trunc('month', now())`),
    ]);
    const { prompts, ...rest } = cfg;
    return {
      config: { ...rest, prompts: Object.fromEntries(Object.keys(DEFAULT_PROMPTS).map((k) => [k, prompts[k]])) },
      defaults: DEFAULT_PROMPTS, vars: PROMPT_VARS, providers: PROVIDERS,
      status: { keyConfigured: keyConfigured(cfg), azureEndpoint: Boolean(process.env.AZURE_OPENAI_ENDPOINT) },
      usage, rules, month: { ...auto, deflected: deflections.n },
    };
  });

  const aiSchema = v.object({
    provider: v.enum(Object.keys(PROVIDERS), { optional: true }), tier: v.enum(['fast', 'advanced'], { optional: true }),
    model: v.string({ max: 120, pattern: /^[\w.:/-]*$/, optional: true }), tone: v.enum(['usted', 'vos'], { optional: true }),
    monthly_limit: v.int({ min: 0, max: 10000000, optional: true }),
    features: v.object({
      copilot: v.bool({ optional: true }), auto_reply: v.bool({ optional: true }), portal_suggest: v.bool({ optional: true }), classify: v.bool({ optional: true }),
      classify_mode: v.enum(['suggest', 'apply'], { optional: true }), use_kb: v.bool({ optional: true }),
    }, { optional: true }),
    auto_reply_channels: v.array(v.enum(['portal', 'email']), { max: 2, optional: true }),
    fallback: v.object({ enabled: v.bool({ optional: true }), min_confidence: v.int({ min: 50, max: 100, optional: true }) }, { optional: true }),
    exclusions: v.object({
      priorities: v.array(v.int({ min: 1, max: 4 }), { max: 4, optional: true }), tech_ids: v.array(v.id(), { max: 200, optional: true }),
      areas: v.array(v.string({ max: 120 }), { max: 50, optional: true }), vip: v.bool({ optional: true }), open_same_topic: v.bool({ optional: true }),
    }, { optional: true }),
    prompts: v.object(Object.fromEntries(Object.keys(DEFAULT_PROMPTS).map((k) => [k, v.string({ max: 6000, multiline: true, trim: false, optional: true })])), { optional: true }),
  });
  r.put('/admin/ai', async ({ req, body }) => {
    await requireUser(req, ['admin']);
    const patch = parse(aiSchema, body);
    if (patch.provider && !PROVIDERS[patch.provider]) throw bad('Proveedor inválido');
    if (patch.prompts) {
      for (const [k, val] of Object.entries(patch.prompts)) {
        if (!DEFAULT_PROMPTS[k]) delete patch.prompts[k];
        else patch.prompts[k] = String(val || '').slice(0, 6000);
      }
    }
    await saveAiConfig(patch);
    return { ok: true };
  });

  const ruleFields = (b) => ({
    name: String(typeof b.name === 'string' ? b.name : '').trim().slice(0, 120),
    keywords: (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 40),
    category_ids: (Array.isArray(b.category_ids) ? b.category_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100),
    tech_category_ids: (Array.isArray(b.tech_category_ids) ? b.tech_category_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100),
    kb_article_ids: (Array.isArray(b.kb_article_ids) ? b.kb_article_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20),
    guide: String(typeof b.guide === 'string' ? b.guide : '').slice(0, 4000),
    mode: ['fixed', 'guide_ai', 'ai'].includes(b.mode) ? b.mode : 'guide_ai',
    on_confirm: b.on_confirm === 'keep_open' ? 'keep_open' : 'resolve',
    active: b.active !== false,
    sort: Math.min(Math.max(int(b.sort, 0) || 0, 0), 10000),
  });

  r.get('/admin/ai/rules', async ({ req }) => {
    await requireUser(req, ['admin']);
    return q('select * from ai_rules order by sort, id');
  });
  r.post('/admin/ai/rules', async ({ req, body }) => {
    await requireUser(req, ['admin']);
    const f = ruleFields(body);
    if (!f.name) throw bad('Poné un nombre a la regla');
    if (!f.keywords.length && !f.category_ids.length && !f.tech_category_ids.length) throw bad('Indicá palabras clave o categorías para la regla');
    if (f.mode === 'fixed' && !f.guide.trim()) throw bad('Una regla de texto fijo necesita el texto de la respuesta');
    return one(`insert into ai_rules(name,keywords,category_ids,tech_category_ids,kb_article_ids,guide,mode,on_confirm,active,sort)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`, [f.name, f.keywords, f.category_ids, f.tech_category_ids, f.kb_article_ids, f.guide, f.mode, f.on_confirm, f.active, f.sort]);
  });
  r.patch('/admin/ai/rules/:id', async ({ req, params, body }) => {
    await requireUser(req, ['admin']);
    const cur = await one('select * from ai_rules where id=$1', [int(params.id)]);
    if (!cur) throw notFound();
    const f = ruleFields({ ...cur, ...body });
    if (!f.name) throw bad('Poné un nombre a la regla');
    return one(`update ai_rules set name=$2,keywords=$3,category_ids=$4,tech_category_ids=$5,kb_article_ids=$6,guide=$7,mode=$8,on_confirm=$9,active=$10,sort=$11 where id=$1 returning *`,
      [cur.id, f.name, f.keywords, f.category_ids, f.tech_category_ids, f.kb_article_ids, f.guide, f.mode, f.on_confirm, f.active, f.sort]);
  });
  r.del('/admin/ai/rules/:id', async ({ req, params }) => {
    await requireUser(req, ['admin']);
    await q('delete from ai_rules where id=$1', [int(params.id)]);
    return { ok: true };
  });

  // Banco de pruebas: qué respondería el sistema a un ticket de ejemplo (no crea nada)
  r.post('/admin/ai/test', async ({ req, body: raw }) => {
    const u = await requireUser(req, ['admin']);
    const body = parse(v.object({
      subject: v.string({ max: 300, default: '' }), body_text: v.string({ max: 4000, multiline: true, default: '' }), email: v.string({ max: 254, default: '' }),
      priority: v.int({ min: 1, max: 4, optional: true }), category_id: v.id({ optional: true }), tech_category_id: v.id({ optional: true }), classify: v.bool({ default: true }),
    }), raw);
    const cfg = await aiConfig();
    const subject = String(body.subject || '').trim();
    const text = String(body.body_text || '').trim();
    if (!subject && !text) throw bad('Escribí un asunto o una descripción de prueba');
    const email = String(body.email || '').trim().toLowerCase();
    const contact = email ? await one('select * from contacts where email=$1', [email]) : null;
    const ticket = { id: null, number: 'PRUEBA', subject: subject || text.slice(0, 80), priority: int(body.priority) || 1, category_id: int(body.category_id), tech_category_id: int(body.tech_category_id), channel: 'portal' };
    const excluded = await exclusionReason(cfg, ticket, contact);
    const reply = excluded ? null : await buildAutoReply({ ticket, contact, text, purpose: 'test', cfg });
    let classification = null;
    let classError = null;
    if (body.classify !== false && (await aiAvailable(cfg))) {
      try { classification = await namesFor(await classifyText(cfg, { subject: ticket.subject, text, contact, userId: u.id })); } catch (e) { classError = e.message; }
    }
    return { excluded, reply, classification, classError, ai: await aiAvailable(cfg) };
  });
}
