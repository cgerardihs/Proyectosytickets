// v1.13: correos a los usuarios editables, y la regla de respuesta automática que mejor encaja (no la primera).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
// Correo saliente "de mentira": se capturan los envíos a Resend
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
const { one } = await import('../lib/db.js');
const { firstName, renderSubject, renderBody } = await import('../lib/mail-templates.js');
const { matchRule, withoutSignature } = await import('../lib/ai.js');
const admin = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const inbound = (from, subject, body) => admin.post('/inbound/email', { From: from, Subject: subject, Body: body, InternetMessageId: `<${Math.random()}@mail>` }, { 'x-inbound-secret': 'secreto-de-prueba' });
const lastTo = (email) => [...sent].reverse().find((m) => m.to.includes(email));

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' });
});

test('nombre de pila presentable', () => {
  assert.equal(firstName({ name: 'admin.', email: 'admin@hanseatica.com' }), '', 'el usuario del correo no es un nombre');
  assert.equal(firstName({ name: 'rpulgar', email: 'rpulgar@hanseatica.com' }), '');
  assert.equal(firstName({ name: 'richards pulgar', email: 'rpulgar@hanseatica.com' }), 'Richards');
  assert.equal(firstName({ name: '"Lucía" Díaz', email: 'l@x.com' }), 'Lucía');
  assert.equal(renderBody('Hola {{contacto.nombre}},\n\nListo.', { contact: { name: 'admin', email: 'admin@x.com' } }), '<p>Hola,</p><p>Listo.</p>');
});

test('asunto con [#número] siempre; variables escapadas; {{sugerencias}} como bloque', () => {
  const ctx = { contact: { name: 'Ana Ruiz', email: 'a@x.com' }, ticket: { number: 77, subject: 'No anda <b>nada</b>\nSegunda línea' }, sugerencias: '<ol><li>Paso</li></ol>' };
  assert.equal(renderSubject('Recibimos su pedido', ctx), '[#77] Recibimos su pedido', 'si se borra el número, se agrega');
  assert.equal(renderSubject('[#{{ticket.numero}}] {{ticket.asunto}}', ctx), '[#77] No anda <b>nada</b> Segunda línea', 'el asunto es texto plano, una línea');
  const html = renderBody('Hola {{contacto.nombre}}: {{ticket.asunto}}\n\n{{sugerencias}}\n\n{{variable.rara}}', ctx);
  assert.equal(html, '<p>Hola Ana: No anda &lt;b&gt;nada&lt;/b&gt; Segunda línea</p><ol><li>Paso</li></ol><p>{{variable.rara}}</p>');
});

test('la regla de respuesta automática: la que mejor encaja (asunto pesa más; la firma no cuenta)', async () => {
  assert.equal(withoutSignature('No imprime\n\nEnviado desde Outlook para iOS\nmi correo'), 'No imprime\n');
  let r = await matchRule({ subject: 'tengo problemas con la impresora', text: 'No me imprime nada.\n\nEnviado desde Outlook para Android' });
  assert.equal(r.name, 'Impresoras');
  r = await matchRule({ subject: 'tengo problemas con la impresora', text: 'Les escribo este correo porque la impresora no anda' });
  assert.equal(r.name, 'Impresoras', 'una palabra en la descripción no le gana al asunto');
  r = await matchRule({ subject: 'No me llegan los correos', text: '' });
  assert.equal(r.name, 'Correo / Outlook');
  assert.equal(await matchRule({ subject: 'Pedido de silla', text: 'nada que ver' }), null);
  // Por correo entrante: el ticket de impresora recibe la guía de impresoras
  ok(await inbound('Admin <admin@hanseatica.com>', 'tengo problemas con la impresora', '<p>No imprime.</p><p>Enviado desde Outlook para iOS</p>'));
  const t = await one(`select id, ai from tickets where subject='tengo problemas con la impresora'`);
  assert.equal(t.ai.auto.rule_name, 'Impresoras');
  const m = lastTo('admin@hanseatica.com');
  assert.match(m.html, /Hola, recibimos su ticket #\d+/, 'sin "Hola admin.,"');
  assert.match(m.html, /impresora esté encendida/);
});

test('plantillas editables: ticket recibido (correo y portal), respuesta automática y resuelto', async () => {
  ok(await admin.put('/admin/settings/helpdesk', {
    mail_templates: {
      created: { subject: 'Recibimos tu pedido: {{ticket.asunto}}', body: 'Hola {{contacto.nombre}}!\n\nTu número es {{ticket.numero}}.\nTe escribimos pronto. — {{mesa}}' },
      created_portal: { subject: '[#{{ticket.numero}}] Tu pedido desde el portal', body: 'Hola {{contacto.nombre}}, cargaste el {{ticket.numero}}.' },
      auto_reply: { body: 'Probá esto:\n\n{{sugerencias}}\n\nAvisanos.' },
      resolved: { subject: '[#{{ticket.numero}}] Resuelto', body: 'Listo, {{contacto.nombre}}.' },
      button: 'Abrir mi ticket', footer: '',
    },
  }));
  const g = await admin.get('/admin/mail-templates');
  ok(g);
  assert.equal(g.data.templates.created.subject, 'Recibimos tu pedido: {{ticket.asunto}}');
  assert.ok(g.data.defaults.created.body.includes('Recibimos su solicitud'));
  // Por correo, sin regla que aplique
  ok(await inbound('Marcos Paz <mpaz@hanseatica.com>', 'Pedido de silla nueva', '<p>Gracias</p>'));
  let n = (await one(`select number from tickets where subject='Pedido de silla nueva'`)).number;
  let m = lastTo('mpaz@hanseatica.com');
  assert.equal(m.subject, `[#${n}] Recibimos tu pedido: Pedido de silla nueva`);
  assert.match(m.html, new RegExp(`<p style="margin:0 0 12px">Hola Marcos!</p><p style="margin:0 0 12px">Tu número es ${n}.<br>Te escribimos pronto. — Mesa de Ayuda</p>`));
  assert.match(m.html, /Abrir mi ticket/);
  assert.ok(!m.html.includes('sin modificar el asunto'), 'nota al pie vacía = sin nota');
  // Respuesta automática con el texto propio alrededor de los pasos
  ok(await inbound('Marcos Paz <mpaz@hanseatica.com>', 'No me imprime la impresora', '<p>Nada</p>'));
  m = lastTo('mpaz@hanseatica.com');
  assert.match(m.html, /<p style="margin:0 0 12px">Probá esto:<\/p><ol[^>]*>/);
  assert.match(m.subject, /^\[#\d+\] Recibimos tu pedido: No me imprime la impresora$/);
  // Portal
  ok(await anon.post('/portal/tickets', { name: 'Lucía Díaz', email: 'ldiaz@hanseatica.com', subject: 'Alta de usuario', body_text: 'Para la nueva analista' }));
  n = (await one(`select number from tickets where subject='Alta de usuario'`)).number;
  m = lastTo('ldiaz@hanseatica.com');
  assert.equal(m.subject, `[#${n}] Tu pedido desde el portal`);
  assert.match(m.html, new RegExp(`Hola Lucía, cargaste el ${n}.`));
  // Resuelto
  const st = await one(`select id from statuses where kind='resolved' order by sort limit 1`);
  ok(await admin.patch(`/tickets/${n}`, { status_id: st.id }));
  m = lastTo('ldiaz@hanseatica.com');
  assert.equal(m.subject, `[#${n}] Resuelto`);
  assert.match(m.html, /Listo, Lucía\./);
  // Apagar el aviso de "recibido"
  const before = sent.length;
  ok(await admin.put('/admin/settings/helpdesk', { notify_contact_on_create: false }));
  ok(await inbound('Marcos Paz <mpaz@hanseatica.com>', 'Otro pedido de mouse', '<p>x</p>'));
  assert.equal(sent.slice(before).filter((x) => x.to.includes('mpaz@hanseatica.com')).length, 0);
  ok(await admin.put('/admin/settings/helpdesk', { notify_contact_on_create: true }));
});

test('prueba al propio correo y validaciones', async () => {
  const r = await admin.post('/admin/mail-templates/test', { key: 'created', subject: 'Hola {{contacto.nombre}}', body: 'Prueba {{ticket.numero}}', button: 'Ver', footer: 'Pie' });
  ok(r);
  const m = lastTo('cgerardi@hanseatica.com');
  assert.equal(m.subject, '[Prueba] [#1234] Hola Carlos');
  assert.match(m.html, /Prueba 1234/);
  assert.equal((await admin.put('/admin/settings/helpdesk', { mail_templates: { created: { body: 'x'.repeat(5000) } } })).status, 400);
  const agent = makeClient();
  assert.equal((await agent.get('/admin/mail-templates')).status, 401);
});
