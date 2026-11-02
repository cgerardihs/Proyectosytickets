// v1.15.1: las notas privadas de un ticket se pueden editar (quien la escribió o un supervisor). El texto anterior no se guarda.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const admin = makeClient();
const tomas = makeClient();
const otro = makeClient();
const sup = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let num;
let noteId;
let replyId;

test('preparación: agentes, un supervisor, un ticket con una nota y una respuesta', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  for (const [k, name, role] of [['prueba.autor', 'Autor Prueba', 'agent'], ['prueba.otro', 'Otro Agente', 'agent'], ['prueba.super', 'Supervisora Prueba', 'supervisor']]) {
    ok(await admin.post('/admin/users', { name, email: `${k}@hanseatica.com`, role, password: 'Rio-de-la-Plata-9' }), name);
  }
  ok(await tomas.post('/auth/login', { email: 'prueba.autor@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  ok(await otro.post('/auth/login', { email: 'prueba.otro@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  ok(await sup.post('/auth/login', { email: 'prueba.super@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  const t = await admin.post('/tickets', { subject: 'Alta de usuario en Equis', contact_email: 'nuevo@hanseatica.com' });
  ok(t);
  num = t.data.number ?? t.data.ticket?.number;
  const n = await tomas.post(`/tickets/${num}/messages`, { kind: 'note', body_html: '<p>Usuario generado en EQUIS</p><p>Clave: Prueba-Secreta-123</p>' });
  ok(n);
  noteId = n.data.message.id;
  const r = await tomas.post(`/tickets/${num}/messages`, { kind: 'reply', body_html: '<p>Ya tiene su usuario.</p>' });
  ok(r);
  replyId = r.data.message.id;
});

test('quien escribió la nota la edita: se reemplaza el texto y queda marcada como editada', async () => {
  const r = await tomas.patch(`/tickets/${num}/messages/${noteId}`, { body_html: '<p>Usuario generado en EQUIS (clave enviada por canal seguro)</p>' });
  ok(r);
  const m = r.data.detail.messages.find((x) => x.id === noteId);
  assert.match(m.body_html, /canal seguro/);
  assert.ok(m.meta.edited_at);
  assert.ok(m.meta.edited_by);
  // El texto anterior no queda en ningún lado: ni en el mensaje ni en el historial
  const rows = await q(`select 1 from ticket_messages where body_html ilike '%Prueba-Secreta-123%'
    union all select 1 from ticket_activities where details::text ilike '%Prueba-Secreta-123%'`);
  assert.equal(rows.length, 0);
  const act = r.data.detail.activities.find((a) => a.action === 'note_edited');
  assert.ok(act, 'queda en el historial');
  assert.equal(act.details.message_id, noteId);
});

test('otro agente no puede editarla; un supervisor sí', async () => {
  assert.equal((await otro.patch(`/tickets/${num}/messages/${noteId}`, { body_html: '<p>Cambio ajeno</p>' })).status, 403);
  ok(await sup.patch(`/tickets/${num}/messages/${noteId}`, { body_html: '<p>Corregida por la supervisora</p>' }));
  const d = (await admin.get(`/tickets/${num}`)).data;
  assert.match(d.messages.find((x) => x.id === noteId).body_html, /supervisora/);
});

test('las respuestas no se editan, la nota no puede quedar vacía y el número tiene que ser del ticket', async () => {
  assert.equal((await tomas.patch(`/tickets/${num}/messages/${replyId}`, { body_html: '<p>Otra cosa</p>' })).status, 400, 'una respuesta ya salió por correo');
  assert.equal((await tomas.patch(`/tickets/${num}/messages/${noteId}`, { body_html: '<p> </p>' })).status, 400);
  const t2 = await admin.post('/tickets', { subject: 'Otro ticket', contact_email: 'otro@hanseatica.com' });
  const num2 = t2.data.number ?? t2.data.ticket?.number;
  assert.equal((await tomas.patch(`/tickets/${num2}/messages/${noteId}`, { body_html: '<p>x</p>' })).status, 404, 'la nota es de otro ticket');
  assert.equal((await tomas.patch(`/tickets/${num}/messages/999999`, { body_html: '<p>x</p>' })).status, 404);
});

test('si no cambia el texto no se registra una edición', async () => {
  const d0 = (await admin.get(`/tickets/${num}`)).data;
  const before = d0.activities.filter((a) => a.action === 'note_edited').length;
  const html = d0.messages.find((x) => x.id === noteId).body_html;
  ok(await sup.patch(`/tickets/${num}/messages/${noteId}`, { body_html: html }));
  const d1 = (await admin.get(`/tickets/${num}`)).data;
  assert.equal(d1.activities.filter((a) => a.action === 'note_edited').length, before);
});
