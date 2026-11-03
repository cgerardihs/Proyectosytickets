// v1.18: vista previa de la última actividad de un ticket (lista de tickets, al dejar el mouse sobre el asunto).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { messageExcerpt } = await import('../lib/tickets-core.js');
const admin = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let num;

test('el extracto saca el historial citado, las etiquetas y las imágenes, y corta el texto', () => {
  const html = '<p>Buendía Juli!</p><p>La cuenta&nbsp;sí existe <b>en CRM</b>:</p><p><img src="/api/attachments/1"></p><p>Saludos</p><div id="divRplyFwdMsg"><b>De:</b> Julian</div><p>Texto viejo citado</p>';
  const x = messageExcerpt(html);
  assert.equal(x, 'Buendía Juli!\nLa cuenta sí existe en CRM:\n\nSaludos');
  assert.doesNotMatch(x, /viejo/);
  const long = messageExcerpt(`<p>${'palabra '.repeat(100)}</p>`, 50);
  assert.ok(long.length <= 51 && long.endsWith('…'));
  assert.equal(messageExcerpt('<table><tr><td>Tel.:</td><td>11 5353-2600</td></tr></table>'), 'Tel.: 11 5353-2600');
});

test('preparación: un ticket creado por correo', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const r = await admin.post('/inbound/email', {
    From: 'Matias Rivero <mrivero@hanseatica.com>', Subject: 'Acceso portal PAS Scarano Hugo', InternetMessageId: '<pv1@mail>',
    Body: '<p>Estimados, buenas tardes. Les solicito las credenciales para el productor.</p>',
    Attachments: [{ Name: 'pedido.pdf', ContentType: 'application/pdf', ContentBytes: 'JVBERi0xLjQK' }],
  }, { 'x-inbound-secret': 'secreto-de-prueba' });
  ok(r);
  num = r.data.results[0].ticket;
});

test('recién creado: muestra que el usuario creó el ticket y que espera respuesta', async () => {
  const r = await admin.get(`/tickets/${num}/preview`);
  ok(r);
  assert.equal(r.data.number, num);
  assert.equal(r.data.subject, 'Acceso portal PAS Scarano Hugo');
  assert.equal(r.data.messages, 1);
  assert.equal(r.data.files, 1);
  assert.equal(r.data.last.kind, 'created');
  assert.equal(r.data.last.agent, false);
  assert.match(r.data.last.author, /Matias Rivero/);
  assert.match(r.data.last.text, /credenciales para el productor/);
  assert.equal(r.data.waiting, true);
});

test('después de una nota privada: la muestra a ella, y ya no espera respuesta del usuario', async () => {
  ok(await admin.post(`/tickets/${num}/messages`, { kind: 'note', body_html: '<p>Se pidió el alta a Equis.</p>' }));
  const r = (await admin.get(`/tickets/${num}/preview`)).data;
  assert.equal(r.messages, 2);
  assert.equal(r.last.kind, 'note');
  assert.equal(r.last.author, 'Carlos Gerardi');
  assert.equal(r.last.agent, true);
  assert.equal(r.last.text, 'Se pidió el alta a Equis.');
  assert.equal(r.waiting, false);
});

test('una respuesta posterior del usuario se marca como "respondió" y vuelve a esperar', async () => {
  ok(await admin.post('/inbound/email', {
    From: 'mrivero@hanseatica.com', Subject: `RE: [#${num}] Acceso portal PAS Scarano Hugo`, InternetMessageId: '<pv2@mail>', InReplyTo: '<pv1@mail>',
    Body: '<p>Gracias, quedo atento.</p><div class="gmail_quote">El lunes escribió: viejo</div>',
  }, { 'x-inbound-secret': 'secreto-de-prueba' }));
  const r = (await admin.get(`/tickets/${num}/preview`)).data;
  assert.equal(r.last.kind, 'customer');
  assert.equal(r.last.text, 'Gracias, quedo atento.');
  assert.equal(r.waiting, true);
});

test('pide sesión y el ticket tiene que existir', async () => {
  assert.equal((await anon.get(`/tickets/${num}/preview`)).status, 401);
  assert.equal((await admin.get('/tickets/999999/preview')).status, 404);
});
