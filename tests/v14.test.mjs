// v1.4: tablero por antigüedad, IA (copiloto, respuesta automática, reglas) e integración con Microsoft 365.
// Las llamadas externas (Claude, Microsoft Graph, Teams) se simulan reemplazando fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from './helpers.mjs';

const admin = makeClient();
const portal = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

// ---------- Simulación de servicios externos ----------
const realFetch = globalThis.fetch;
const calls = [];
let unread = [];
const sent = [];
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body && typeof opts.body === 'string' ? opts.body : '';
  calls.push({ url: u, method: opts.method || 'GET', body });
  if (u.startsWith('https://api.anthropic.com/')) {
    const prompt = JSON.parse(body).messages[0].content;
    let text = 'Hola Martín, ya regeneramos el comprobante con el CAE y te lo adjuntamos.';
    if (prompt.includes('"confianza"')) text = '{"confianza": 92, "pasos": "1. Reinicie la computadora.\\n2. Ingrese a outlook.office.com."}';
    else if (prompt.includes('"resumen"')) text = '```json\n{"resumen": ["Factura sin CAE", "El cliente la necesita hoy"], "pasos": ["Verificar CAE", "Regenerar PDF"], "clasificacion": {"tech_category_id": 1, "priority": 3}, "motivo": "Facturación"}\n```';
    else if (prompt.includes('Clasificá')) text = '{"tech_category_id": 1, "priority": 2, "motivo": "Correo"}';
    else if (prompt.includes('El agente')) text = 'Revisá el CAE en Equis.';
    return json({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 40 } });
  }
  if (u.startsWith('https://login.microsoftonline.com/')) {
    return json({ access_token: jwt({ roles: ['Mail.ReadWrite', 'Mail.Send', 'User.Read.All', 'GroupMember.Read.All', 'DeviceManagementManagedDevices.Read.All', 'Sites.ReadWrite.All'] }), expires_in: 3600 });
  }
  if (u.startsWith('https://hanseatica.webhook.office.com/')) return new Response('', { status: 202 });
  if (u.startsWith('https://graph.microsoft.com/v1.0')) {
    const p = decodeURIComponent(u.replace('https://graph.microsoft.com/v1.0', ''));
    const m = opts.method || 'GET';
    if (p.startsWith('/organization')) return json({ value: [{ displayName: 'Hanseatica', verifiedDomains: [{ name: 'hanseatica.onmicrosoft.com', isInitial: true }] }] });
    if (p.includes('/mailFolders/inbox/messages')) { const v = unread; unread = []; return json({ value: v }); }
    if (p.includes('/mailFolders?$filter')) return json({ value: [] });
    if (p.endsWith('/mailFolders') && m === 'POST') return json({ id: 'FOLDER1' });
    if (p.includes('/messages/') && (m === 'PATCH' || p.endsWith('/move'))) return json({});
    if (p.endsWith('/sendMail')) { sent.push(JSON.parse(body)); return new Response(null, { status: 202 }); }
    if (p.startsWith('/users?')) return json({ value: [
      { id: 'u1', displayName: 'Noelia Gonzalez', mail: 'ngonzalez@hanseatica.com', department: 'Siniestros', jobTitle: 'Analista', mobilePhone: '11-5555', accountEnabled: true, manager: { displayName: 'Jefe Siniestros' } },
      { id: 'u2', displayName: 'Nuevo Empleado', mail: 'nuevo@hanseatica.com', department: 'Comercial', accountEnabled: true },
      { id: 'u3', displayName: 'Baja', mail: 'baja@hanseatica.com', accountEnabled: false },
    ] });
    if (p.startsWith('/groups?$filter')) return json({ value: [{ id: '11111111-2222-3333-4444-555555555555', displayName: 'IT-MesaDeAyuda' }] });
    if (p.includes('/members')) return json({ value: [{ id: 'm1', displayName: 'Agente Nuevo', mail: 'agente.nuevo@hanseatica.com' }] });
    if (p.includes('/managedDevices')) return json({ value: [{ id: 'd1', deviceName: 'NB-HANSA-0142', operatingSystem: 'Windows', osVersion: '11 23H2', complianceState: 'compliant', lastSyncDateTime: new Date().toISOString(), isEncrypted: true }] });
    if (p.startsWith('/sites/hanseatica.sharepoint.com:')) return json({ id: 'SITE1' });
    if (p.startsWith('/sites/SITE1/drives')) return json({ value: [{ id: 'DRIVE1', name: 'Documentos' }] });
    if (p.startsWith('/drives/DRIVE1/root:') && m === 'PUT') return json({ id: 'ITEM1', webUrl: 'https://hanseatica.sharepoint.com/x' });
    if (p.startsWith('/drives/DRIVE1/items/ITEM1/content')) return new Response(Buffer.from('hola sharepoint'), { status: 200 });
    return json({ error: { message: `No simulado: ${m} ${p}` } }, 404);
  }
  return realFetch(url, opts);
};

let meta;
test('instalación con reglas de IA de ejemplo', async () => {
  let r = await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'clave-segura-1' }, start_number: 3500, demo: true });
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }); // estas pruebas usan el portal abierto (de fábrica es solo con Microsoft)
  ok(r, 'setup');
  meta = (await admin.get('/meta')).data;
  assert.equal(meta.ai.available, false, 'sin AI_API_KEY la IA no está disponible');
  r = await admin.get('/admin/ai');
  ok(r);
  assert.equal(r.data.rules.length, 4, 'cuatro reglas de ejemplo');
  const outlook = r.data.rules.find((x) => x.name === 'Correo / Outlook');
  assert.equal(outlook.tech_category_ids.length, 1, 'regla vinculada a la categoría técnica');
});

test('tablero del agente: antigüedad, alertas e importancia', async () => {
  let r = await admin.post('/tickets', { subject: 'Reporte viejo de siniestros', contact_email: 'fsoto@hanseatica.com', contact_name: 'Facundo Soto', body_html: '<p>x</p>', priority: 2, assignee_id: meta.me.id });
  ok(r);
  const old = r.data.number;
  r = await admin.post('/tickets', { subject: 'Factura sin CAE', contact_email: 'mpalacios@hanseatica.com', contact_name: 'Martin Palacios', body_html: '<p>urgente</p>', priority: 4, assignee_id: meta.me.id });
  const urgent = r.data.number;
  // Envejecer un ticket y vencer el SLA de otro directamente en la base
  const { q } = await import('../lib/db.js');
  await q(`update tickets set created_at = now() - interval '120 days', last_activity_at = now() - interval '40 days' where number=$1`, [old]);
  await q(`update tickets set resolution_due = now() - interval '2 days' where number=$1`, [urgent]);
  await q(`update contacts set vip=true where email='mpalacios@hanseatica.com'`);
  r = await admin.get('/home?scope=mine');
  ok(r, 'home');
  const h = r.data;
  assert.ok(h.kpis.open >= 2);
  assert.equal(h.alerts.critical.n, 1);
  assert.equal(h.alerts.critical.oldest.number, old);
  assert.ok(h.alerts.overdue.n >= 1);
  assert.ok(h.kpis.inactive >= 1);
  assert.equal(h.histogram.length, 6);
  assert.equal(h.histogram[5].n, 1, 'más de 90 días');
  assert.equal(h.histogram[5].level, 'critical');
  assert.equal(h.oldest[0].number, old);
  assert.equal(h.important[0].number, urgent, 'el urgente, vencido y VIP es el más importante');
  assert.ok(h.important[0].reasons.some((x) => x.label.startsWith('SLA vencido')));
  assert.ok(h.important[0].reasons.some((x) => x.label === 'Usuario VIP'));
  r = await admin.put('/admin/settings/helpdesk', { aging: { critical_days: 200 } });
  ok(r);
  const { clearSettingsCache } = await import('../lib/settings.js');
  clearSettingsCache();
  r = await admin.get('/home?scope=team');
  assert.equal(r.data.alerts.critical.n, 0, 'el umbral es configurable');
  assert.ok(r.data.kpis.open >= 2, 'todo el equipo incluye los demo');
});

test('sin IA: sugerencia del portal y respuesta automática con la guía fija', async () => {
  let r = await portal.post('/portal/suggest', { subject: 'No puedo ver mis correos', body_text: 'Abro Outlook y la bandeja está vacía', email: 'ngonzalez@hanseatica.com' });
  ok(r);
  assert.equal(r.data.suggestion.rule.name, 'Correo / Outlook');
  assert.match(r.data.suggestion.html, /<ol><li>Cierre Outlook/);
  assert.equal(r.data.suggestion.used_ai, false);
  r = await portal.post('/portal/deflect', { rule_id: r.data.suggestion.rule.id, subject: 'No puedo ver mis correos', email: 'ngonzalez@hanseatica.com' });
  ok(r);
  r = await portal.post('/portal/tickets', { name: 'Noelia Gonzalez', email: 'ngonzalez@hanseatica.com', subject: 'No puedo ver mis correos', body_text: 'Outlook vacío desde la mañana' });
  ok(r, 'crear desde portal');
  const token = r.data.token;
  r = await portal.post('/portal/ticket', { token });
  const auto = r.data.messages.find((m) => m.kind === 'reply');
  assert.ok(auto, 'hay respuesta automática');
  assert.equal(auto.meta.auto, true);
  assert.match(auto.body_html, /recibimos su ticket/);
  assert.equal(r.data.ticket.auto_reply, true);
  // "¿Le sirvió?" → Sí: la regla resuelve el ticket
  r = await portal.post('/portal/ticket/feedback', { token, helpful: true });
  ok(r, 'feedback');
  r = await portal.post('/portal/ticket', { token });
  assert.equal(r.data.ticket.status_kind, 'resolved');
  assert.equal(r.data.ticket.feedback, 'yes');
  r = await admin.get('/admin/ai');
  const rule = r.data.rules.find((x) => x.name === 'Correo / Outlook');
  assert.equal(rule.deflected, 1);
  assert.equal(rule.confirmed, 1);
  assert.ok(rule.hits >= 2);
  assert.equal(r.data.month.helpful, 1);
});

test('exclusiones: urgente o VIP no recibe respuesta automática', async () => {
  let r = await portal.post('/portal/tickets', { name: 'Martin Palacios', email: 'mpalacios@hanseatica.com', subject: 'Outlook no abre', body_text: 'no abre el correo' });
  ok(r);
  r = await portal.post('/portal/ticket', { token: r.data.token });
  assert.ok(!r.data.messages.some((m) => m.kind === 'reply'), 'VIP excluido');
  r = await admin.post('/admin/ai/test', { subject: 'Outlook no abre', body_text: 'correo', email: 'mpalacios@hanseatica.com' });
  assert.equal(r.data.excluded, 'Usuario VIP');
  r = await admin.post('/admin/ai/test', { subject: 'Se trabó la impresora', body_text: 'no imprime', priority: 2 });
  assert.equal(r.data.reply.rule.name, 'Impresoras');
});

test('reglas: alta, validación y modificación', async () => {
  let r = await admin.post('/admin/ai/rules', { name: 'VPN', keywords: 'vpn, forticlient', mode: 'fixed', guide: '' });
  assert.equal(r.status, 400, 'texto fijo sin texto');
  r = await admin.post('/admin/ai/rules', { name: 'VPN', keywords: 'vpn, forticlient', mode: 'fixed', guide: '1. Desconecte y vuelva a conectar FortiClient.', on_confirm: 'keep_open' });
  ok(r);
  assert.deepEqual(r.data.keywords, ['vpn', 'forticlient']);
  r = await admin.patch(`/admin/ai/rules/${r.data.id}`, { active: false });
  ok(r);
  assert.equal(r.data.active, false);
  r = await admin.post('/admin/ai/test', { subject: 'No conecta la VPN', body_text: '' });
  assert.equal(r.data.reply, null, 'regla inactiva no responde');
});

let copilotTicket;
test('con IA: copiloto, borrador, pregunta y respuesta automática generada', async () => {
  process.env.AI_API_KEY = 'test-key';
  let r = await admin.put('/admin/ai', { provider: 'anthropic', tier: 'fast', tone: 'usted', prompts: { system: 'Sos el asistente de {empresa}.' } });
  ok(r);
  r = await admin.get('/admin/ai');
  assert.equal(r.data.status.keyConfigured, true);
  assert.equal(r.data.config.prompts.system, 'Sos el asistente de {empresa}.');
  assert.ok(r.data.config.prompts.copilot.includes('{historial}'), 'los demás prompts quedan con el valor por defecto');

  r = await admin.post('/tickets', { subject: 'Despacho de factura sin CAE', contact_email: 'mpalacios@hanseatica.com', body_html: '<p>Factura sin CAE impreso</p>', priority: 1 });
  copilotTicket = r.data.number;
  r = await admin.post(`/tickets/${copilotTicket}/ai/copilot`, {});
  ok(r, 'copiloto');
  assert.equal(r.data.ai, true);
  assert.deepEqual(r.data.summary, ['Factura sin CAE', 'El cliente la necesita hoy']);
  assert.equal(r.data.classification.tech_category_id, 1);
  assert.equal(r.data.classification.group_id, undefined, 'la IA ya no clasifica grupo');
  assert.equal(r.data.classification.priority, 3);
  assert.ok(r.data.classification.names.tech_category);
  const before = calls.filter((c) => c.url.includes('anthropic')).length;
  r = await admin.post(`/tickets/${copilotTicket}/ai/copilot`, {});
  assert.equal(r.data.cached, true, 'sin mensajes nuevos usa el resultado guardado');
  assert.equal(calls.filter((c) => c.url.includes('anthropic')).length, before);

  r = await admin.post(`/tickets/${copilotTicket}/ai/draft`, { mode: 'new' });
  ok(r, 'borrador');
  assert.match(r.data.html, /regeneramos el comprobante/);
  r = await admin.post(`/tickets/${copilotTicket}/ai/draft`, { mode: 'shorter', current_text: 'Hola, texto largo' });
  ok(r);
  const lastPrompt = JSON.parse(calls.filter((c) => c.url.includes('anthropic')).at(-1).body);
  assert.match(lastPrompt.messages[0].content, /más corto/);
  assert.ok(lastPrompt.system.startsWith('Sos el asistente de Hanseatica.'), 'variables reemplazadas en el prompt de sistema');
  assert.match(lastPrompt.system, /REGLAS DE SEGURIDAD/, 'el sistema incluye las reglas contra instrucciones inyectadas');
  assert.match(lastPrompt.messages[0].content, /<historial>/);
  r = await admin.post(`/tickets/${copilotTicket}/ai/ask`, { question: '¿Qué reviso primero?' });
  ok(r);
  assert.match(r.data.text, /CAE/);

  // Respuesta automática generada por IA (portal), con la guía de la regla
  r = await portal.post('/portal/tickets', { name: 'Ana Ruiz', email: 'aruiz@hanseatica.com', subject: 'No veo mis correos', body_text: 'Outlook vacío' });
  r = await portal.post('/portal/ticket', { token: r.data.token });
  const auto = r.data.messages.find((m) => m.kind === 'reply');
  assert.match(auto.body_html, /<li>Reinicie la computadora.<\/li>/);
  assert.equal(auto.meta.used_ai, true);
  // Sin regla: responde solo con confianza suficiente (92 ≥ 80)
  r = await admin.post('/admin/ai/test', { subject: 'El sistema de cotizaciones anda lento', body_text: 'tarda mucho', classify: true });
  ok(r);
  assert.equal(r.data.reply.rule, null);
  assert.equal(r.data.reply.used_ai, true);
  assert.ok(r.data.classification.tech_category_id);
  r = await admin.put('/admin/ai', { fallback: { min_confidence: 95 } });
  r = await admin.post('/admin/ai/test', { subject: 'El sistema de cotizaciones anda lento', body_text: 'tarda mucho', classify: false });
  assert.equal(r.data.reply, null, 'confianza por debajo del mínimo: no responde');
  r = await admin.get('/admin/ai');
  assert.ok(r.data.usage.calls >= 6);
  assert.ok(r.data.usage.input_tokens > 0);
});

test('tope mensual de IA', async () => {
  let r = await admin.put('/admin/ai', { monthly_limit: 1 });
  ok(r);
  r = await admin.post(`/tickets/${copilotTicket}/ai/draft`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /tope mensual/);
  await admin.put('/admin/ai', { monthly_limit: 0 });
});

test('Microsoft 365: conexión, permisos, directorio, buzón, Teams, Intune y SharePoint', async () => {
  process.env.MS_CLIENT_SECRET = 'secreto';
  let r = await admin.put('/admin/m365', { tenant_id: '8f1c2a4e-1b2c-4d5e-9f00-112233445566', client_id: '0a1b2c3d-4e5f-4061-8a9b-cdef01234567', mailbox: { enabled: true, address: 'Ayuda@Hanseatica.com' } });
  ok(r, 'guardar');
  assert.equal(r.data.config.effective.connected, true);
  assert.equal(r.data.config.mailbox.address, 'ayuda@hanseatica.com');
  r = await admin.put('/admin/m365', { teams: { webhook_url: 'http://inseguro' } });
  assert.equal(r.status, 400);

  r = await admin.post('/admin/m365/test');
  ok(r, 'probar conexión');
  assert.equal(r.data.organization, 'Hanseatica');
  assert.equal(r.data.domain, 'hanseatica.onmicrosoft.com');
  assert.ok(r.data.permissions.find((p) => p.perm === 'Mail.Send').granted);
  assert.equal(r.data.permissions.find((p) => p.perm === 'DeviceManagementManagedDevices.PrivilegedOperations.All').granted, false);

  // Directorio
  r = await admin.put('/admin/m365', { directory: { enabled: true, agent_group: 'IT-MesaDeAyuda', create_agents: true } });
  r = await admin.post('/admin/m365/sync-directory');
  ok(r, 'directorio');
  assert.equal(r.data.contacts, 2);
  assert.equal(r.data.agents, 1);
  r = await admin.get('/contacts?q=ngonzalez');
  assert.equal(r.data.items[0].area, 'Siniestros');
  assert.equal(r.data.items[0].job_title, 'Analista');
  assert.equal(r.data.items[0].manager, 'Jefe Siniestros');
  meta = (await admin.get('/meta')).data;
  assert.ok(meta.users.some((u) => u.email === 'agente.nuevo@hanseatica.com'));

  // Buzón: un correo nuevo se convierte en ticket y la respuesta sale por Graph
  unread = [{ id: 'M1', subject: 'No funciona la impresora del 3er piso', from: { emailAddress: { address: 'rmoreno@hanseatica.com', name: 'Rodrigo Moreno' } }, body: { contentType: 'html', content: '<p>No imprime</p>' }, internetMessageId: '<m1@x>', hasAttachments: false, internetMessageHeaders: [] }];
  r = await admin.post('/admin/m365/poll');
  ok(r, 'leer buzón');
  assert.equal(r.data.read, 1);
  assert.ok(r.data.results[0].created);
  const num = r.data.results[0].ticket;
  assert.ok(calls.some((c) => c.url.includes('/messages/M1/move')), 'se movió a Procesados');
  assert.ok(sent.some((m) => m.message.toRecipients[0].emailAddress.address === 'rmoreno@hanseatica.com'), 'confirmación enviada desde el buzón');
  r = await admin.post(`/tickets/${num}/messages`, { kind: 'reply', body_html: '<p>Vamos a revisarla</p>' });
  ok(r);
  assert.equal(r.data.mail.sent, true);
  assert.equal(r.data.mail.via, 'm365');
  r = await admin.post('/m365/poll', {}, { 'x-cron-key': 'mala' });
  assert.equal(r.status, 401);
  r = await admin.post('/m365/poll', {}, { 'x-cron-key': 'cron-de-prueba' });
  ok(r);

  // Teams
  r = await admin.post('/admin/m365/teams-test');
  assert.equal(r.status, 400, 'sin webhook');
  r = await admin.put('/admin/m365', { teams: { enabled: true, webhook_url: 'https://hanseatica.webhook.office.com/hook' } });
  r = await admin.post('/admin/m365/teams-test');
  ok(r, 'teams');
  const before = calls.filter((c) => c.url.startsWith('https://hanseatica.webhook.office.com')).length;
  await admin.post('/tickets', { subject: 'Caída general de Equis', contact_email: 'rmoreno@hanseatica.com', body_html: '<p>x</p>', priority: 4 });
  assert.equal(calls.filter((c) => c.url.startsWith('https://hanseatica.webhook.office.com')).length, before + 1, 'aviso por urgente');

  // Intune
  r = await admin.get(`/tickets/${num}/devices`);
  assert.equal(r.status, 400, 'módulo apagado');
  await admin.put('/admin/m365', { intune: { enabled: true } });
  r = await admin.get(`/tickets/${num}/devices`);
  ok(r, 'equipos');
  assert.equal(r.data.devices[0].name, 'NB-HANSA-0142');
  assert.equal(r.data.devices[0].compliance, 'compliant');
  r = await admin.post('/devices/d1/action', { action: 'reboot' });
  assert.equal(r.status, 400, 'acciones remotas desactivadas');

  // SharePoint: el adjunto va a la biblioteca y se descarga desde ahí
  await admin.put('/admin/m365', { sharepoint: { enabled: true, site_url: 'https://hanseatica.sharepoint.com/sites/IT', library: 'Documentos' } });
  r = await admin.post(`/tickets/${num}/messages`, { kind: 'note', body_html: '<p>adjunto</p>', attachments: [{ name: 'log.txt', type: 'text/plain', data: Buffer.from('hola').toString('base64') }] });
  ok(r);
  const att = r.data.detail.messages.at(-1).attachments[0];
  const { one } = await import('../lib/db.js');
  const row = await one('select storage, data_b64, external_ref from attachments where id=$1', [att.id]);
  assert.equal(row.storage, 'sharepoint');
  assert.equal(row.data_b64, null);
  assert.equal(row.external_ref.item_id, 'ITEM1');
  r = await admin.get(`/attachments/${att.id}`);
  assert.equal(String(r.data), 'hola sharepoint');

  r = await admin.get('/admin/m365');
  ok(r);
  assert.ok(r.data.log.length >= 4, 'registro de actividad');
  assert.ok(r.data.status.ok);
});

test('Microsoft 365: ingreso solo con Microsoft', async () => {
  let r = await admin.put('/admin/m365', { login: { only_microsoft: true } });
  ok(r);
  const other = makeClient();
  r = await other.get('/auth/me');
  assert.equal(r.data.msEnabled, true);
  assert.equal(r.data.msOnly, true);
  r = await other.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'clave-segura-1' });
  assert.equal(r.status, 403);
  await admin.put('/admin/m365', { login: { only_microsoft: false } });
  r = await other.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'clave-segura-1' });
  ok(r);
});
