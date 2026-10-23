// v1.13.1: un ticket nuevo que menciona un sistema crítico con un problema informado se vincula solo y el usuario
// recibe el aviso de "problema conocido" (con la hora estimada) en lugar del "recibido" o la respuesta automática.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.RESEND_API_KEY = 're_prueba';
process.env.MAIL_FROM = 'Soporte <soporte@hanseatica.com>';
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: `m${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { one, q } = await import('../lib/db.js');
const { systemWords } = await import('../lib/critical-match.js');
const admin = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const inbound = (from, subject, body) => admin.post('/inbound/email', { From: from, Subject: subject, Body: body, InternetMessageId: `<${Math.random()}@mail>` }, { 'x-inbound-secret': 'secreto-de-prueba' });
const lastTo = (email) => [...sent].reverse().find((m) => m.to.includes(email));
const linkOf = async (subject) => (await one(`select s.name, l.auto from tickets t join critical_system_tickets l on l.ticket_id=t.id join critical_systems s on s.id=l.system_id where t.subject=$1`, [subject])) ?? undefined;
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const S = {};

test('preparación: CRM caído, Correo operativo', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' });
  for (const [name, keywords] of [['CRM comercial', []], ['Correo (Microsoft 365)', ['outlook', 'correo electronico']], ['Equis', ['equis', 'core']]]) {
    const r = await admin.post('/admin/critical-systems', { name, keywords });
    ok(r, name);
    S[name] = r.data.id;
  }
  ok(await admin.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'down', eta: inMin(180), message: 'No se puede ingresar. Trabajando con el proveedor.' }));
});

test('palabras para reconocer: sin palabras, el nombre y solo en el asunto', () => {
  assert.deepEqual(systemWords({ name: 'CRM comercial', keywords: [] }), { subject: ['crm comercial', 'crm'], body: [] });
  assert.deepEqual(systemWords({ name: 'Correo (Microsoft 365)', keywords: [] }), { subject: ['correo'], body: [] });
  assert.deepEqual(systemWords({ name: 'X', keywords: ['Salesforce', ' CRM '] }), { subject: ['salesforce', 'crm'], body: ['salesforce', 'crm'] });
});

test('por correo: "tengo problemas con el CRM" se vincula solo y recibe el aviso de problema conocido', async () => {
  ok(await inbound('Richards Pulgar <rpulgar@hanseatica.com>', 'tengo problemas con el CRM', '<p>No me deja entrar desde las 10.</p>'));
  const t = await one(`select id, number, ai from tickets where subject='tengo problemas con el CRM'`);
  assert.deepEqual(await linkOf('tengo problemas con el CRM'), { name: 'CRM comercial', auto: true });
  const m = lastTo('rpulgar@hanseatica.com');
  assert.equal(m.subject, `[#${t.number}] tengo problemas con el CRM`);
  assert.match(m.html, /Ya sabemos que CRM comercial está caído y lo estamos resolviendo\./);
  assert.match(m.html, /<p>No se puede ingresar\. Trabajando con el proveedor\.<\/p>/);
  assert.match(m.html, /Resolución estimada: (hoy|mañana) \d\d:\d\d hs\./);
  assert.equal(t.ai?.auto, undefined, 'no se manda además la respuesta automática');
  const d = (await admin.get(`/tickets/${t.number}`)).data;
  assert.equal(d.critical.auto, true);
  assert.ok(d.activities.some((a) => a.action === 'critical_linked' && a.details.auto));
  assert.equal((await admin.get('/critical-systems')).data.systems.find((s) => s.id === S['CRM comercial']).tickets, 1);
});

test('no se engancha de más', async () => {
  // El nombre sin palabras propias solo cuenta en el asunto
  ok(await inbound('Ana Ruiz <aruiz@hanseatica.com>', 'Pedido de silla', '<p>Lo cargo también en el CRM después.</p>'));
  assert.equal(await linkOf('Pedido de silla'), undefined);
  // Un sistema operativo no se vincula aunque se lo nombre
  ok(await inbound('Ana Ruiz <aruiz@hanseatica.com>', 'No anda outlook', '<p>x</p>'));
  assert.equal(await linkOf('No anda outlook'), undefined);
  assert.doesNotMatch(lastTo('aruiz@hanseatica.com').html, /Ya sabemos/);
  // "crmx" no es "crm"
  ok(await inbound('Ana Ruiz <aruiz@hanseatica.com>', 'Consulta crmx', '<p>x</p>'));
  assert.equal(await linkOf('Consulta crmx'), undefined);
});

test('palabras propias: también en el texto; y por tema del ticket', async () => {
  ok(await admin.post(`/critical-systems/${S.Equis}/status`, { state: 'degraded', eta: inMin(60) }));
  ok(await inbound('Lucía Díaz <ldiaz@hanseatica.com>', 'No puedo emitir', '<p>El core está lentísimo.</p>'));
  assert.deepEqual(await linkOf('No puedo emitir'), { name: 'Equis', auto: true });
  assert.match(lastTo('ldiaz@hanseatica.com').html, /Ya sabemos que Equis está funcionando con problemas/);
  assert.doesNotMatch(lastTo('ldiaz@hanseatica.com').html, /<p><\/p>/, 'sin mensaje, el párrafo no aparece');
  // Por tema: el sistema tiene asociado un tema y el ticket del portal lo eligió
  const tech = await one('select id from tech_categories order by id limit 1');
  ok(await admin.patch(`/admin/critical-systems/${S['CRM comercial']}`, { tech_category_id: tech.id }));
  ok(await anon.post('/portal/tickets', { name: 'Marcos Paz', email: 'mpaz@hanseatica.com', subject: 'Error 503', body_text: 'Sale una pantalla de error', tech_category_id: tech.id }));
  assert.deepEqual(await linkOf('Error 503'), { name: 'CRM comercial', auto: true });
  assert.match(lastTo('mpaz@hanseatica.com').html, /Ya sabemos que CRM comercial está caído/);
  // En el portal, "Mi problema es otro" evita el vínculo con ese sistema
  ok(await anon.post('/portal/tickets', { name: 'Marcos Paz', email: 'mpaz@hanseatica.com', subject: 'Otra cosa del CRM', body_text: 'x', critical_dismissed: [S['CRM comercial']] }));
  assert.equal(await linkOf('Otra cosa del CRM'), undefined);
});

test('al volver a funcionar, los vinculados solos reciben el "ya funciona" y se resuelven', async () => {
  const r = await admin.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'ok', resolve_tickets: true });
  ok(r);
  assert.equal(r.data.resolved, 2);
  const st = await one(`select s.kind from tickets t join statuses s on s.id=t.status_id where t.subject='tengo problemas con el CRM'`);
  assert.equal(st.kind, 'resolved');
  assert.match(lastTo('rpulgar@hanseatica.com').html, /CRM comercial<\/b> ya funciona normalmente/);
});

test('se puede apagar, y el texto es editable', async () => {
  ok(await admin.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'down', eta: inMin(120) }));
  ok(await admin.put('/admin/settings/helpdesk', { critical_auto_link: false }));
  ok(await inbound('Sofía Ríos <srios@hanseatica.com>', 'El CRM no abre', '<p>x</p>'));
  assert.equal(await linkOf('El CRM no abre'), undefined);
  assert.doesNotMatch(lastTo('srios@hanseatica.com').html, /Ya sabemos/);
  ok(await admin.put('/admin/settings/helpdesk', { critical_auto_link: true, mail_templates: { known_issue: { subject: '[#{{ticket.numero}}] {{sistema.nombre}} {{sistema.estado}}', body: 'Vuelve {{sistema.resolucion}}.' } } }));
  ok(await inbound('Sofía Ríos <srios@hanseatica.com>', 'Sigue sin abrir el CRM', '<p>x</p>'));
  const m = lastTo('srios@hanseatica.com');
  assert.match(m.subject, /^\[#\d+\] CRM comercial caído$/);
  assert.match(m.html, /<p>Vuelve (hoy|mañana) \d\d:\d\d hs\.<\/p>/);
  const p = await anon.get('/portal/status');
  assert.deepEqual(p.data.systems.find((s) => s.name === 'Equis').words, { subject: ['equis', 'core'], body: ['equis', 'core'] });
  await q('select 1');
});
