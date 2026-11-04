// v1.21: combinar varios tickets eligiendo cuál queda como principal.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.RESEND_API_KEY = 're_prueba';
process.env.MAIL_FROM = 'Mesa de Ayuda <soporte@hanseatica.com>';
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 're_x' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const admin = makeClient();
const agente = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const SECRET = { 'x-inbound-secret': 'secreto-de-prueba' };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
const T = {};
let agentId;

test('preparación: dos correos de Guido por lo mismo y uno de Valeria', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const u = await admin.post('/admin/users', { name: 'Agente Combina', email: 'combina@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' });
  ok(u);
  agentId = u.data.id ?? u.data.user?.id;
  ok(await agente.post('/auth/login', { email: 'combina@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  const mail = async (k, from, subject, id) => {
    const r = await admin.post('/inbound/email', { From: from, Subject: subject, InternetMessageId: `<${id}@x>`, Body: `<p>${subject}</p>`, Attachments: k === 'a' ? [{ Name: 'captura.pdf', ContentType: 'application/pdf', ContentBytes: 'JVBERi0xLjQK' }] : [] }, SECRET);
    ok(r);
    T[k] = r.data.results[0].ticket;
  };
  await mail('a', 'Guido Bottin <gbottin@hanseatica.com>', 'Alerta de seguridad en sub-dominio de test', 'a1');
  await mail('b', 'Guido Bottin <gbottin@hanseatica.com>', 'RV: Alerta seguridad sub-dominio test', 'b1');
  await mail('c', 'Valeria Castañer <vcastaner@hanseatica.com>', 'Usuario Power BI', 'c1');
  ok(await admin.patch(`/tickets/${T.a}`, { tags: ['seguridad'], cc: ['soc@hanseatica.com'] }));
  ok(await admin.post(`/tickets/${T.a}/time`, { minutes: 30, note: 'Revisión', spent_on: '2026-11-03' }));
  ok(await admin.post(`/tickets/${T.a}/follow`, {}));
});

test('la ventana recibe los tickets y sugiere otros abiertos del mismo usuario', async () => {
  const r = await agente.get(`/ticket-merge/info?numbers=${T.a}`);
  ok(r);
  assert.equal(r.data.tickets[0].number, T.a);
  assert.match(r.data.tickets[0].excerpt, /Alerta de seguridad/);
  assert.deepEqual(r.data.suggestions.map((x) => x.number), [T.b], 'sugiere el otro de Guido, no el de Valeria');
  const s = await agente.get(`/ticket-merge/info?numbers=${T.a}&q=power`);
  assert.deepEqual(s.data.matches.map((x) => x.number), [T.c]);
  const n = await agente.get(`/ticket-merge/info?numbers=${T.a}&q=%23${T.b}`);
  assert.deepEqual(n.data.matches.map((x) => x.number), [T.b]);
});

test('un agente combina tres tickets eligiendo el más nuevo como principal', async () => {
  sent.length = 0;
  assert.equal((await agente.post('/ticket-merge', { numbers: [T.a, T.b], main: T.c })).status, 400, 'el principal tiene que estar en la lista');
  const r = await agente.post('/ticket-merge', { numbers: [T.a, T.b, T.c], main: T.b, notify: true });
  ok(r);
  assert.equal(r.data.into, T.b);
  assert.deepEqual(r.data.merged.sort(), [T.a, T.c].sort());
  const d = (await admin.get(`/tickets/${T.b}`)).data;
  const customer = d.messages.filter((m) => m.kind === 'customer');
  assert.equal(customer.length, 3, 'tiene la conversación de los tres');
  assert.deepEqual(customer.map((m) => m.meta?.from_ticket || T.b), [T.a, T.b, T.c], 'en orden de fecha y con su origen');
  assert.ok(d.messages.some((m) => m.kind === 'note' && /Se combinaron los tickets/.test(m.body_html)));
  for (const n of [T.a, T.c]) {
    const o = (await admin.get(`/tickets/${n}`)).data.ticket;
    assert.equal(o.merged_into, T.b);
    assert.equal((await one('select kind from statuses where id=$1', [o.status_id])).kind, 'closed');
  }
  assert.ok(d.activities.some((a) => a.action === 'merged_from'));
  // Avisó a Valeria (otro usuario); a Guido no hace falta porque el principal ya es suyo
  assert.ok(await until(() => sent.some((m) => [].concat(m.to).join().includes('vcastaner'))));
  assert.ok(!sent.some((m) => [].concat(m.to).join().includes('gbottin') && /unificamos/.test(m.html)));
  assert.match(sent.find((m) => [].concat(m.to).join().includes('vcastaner')).html, new RegExp(`#${T.c}.*#${T.b}`, 's'));
});

test('no se pierde nada: horas, etiquetas, CC, seguidores y adjuntos; las respuestas a un correo viejo van al principal', async () => {
  // Combinar de nuevo en sentido contrario no se puede: ya están combinados
  assert.equal((await admin.post('/ticket-merge', { numbers: [T.a, T.b], main: T.a })).status, 400);
  ok(await admin.post('/inbound/email', { From: 'gbottin@hanseatica.com', Subject: `RE: [#${T.a}] Alerta`, InternetMessageId: '<a2@x>', InReplyTo: '<a1@x>', Body: '<p>¿Novedades?</p>' }, SECRET));
  const d = (await admin.get(`/tickets/${T.b}`)).data;
  assert.ok(d.messages.some((m) => /Novedades/.test(m.body_html)), 'la respuesta entró al principal');
  assert.deepEqual(d.ticket.tags, ['seguridad']);
  assert.ok(d.ticket.cc.includes('soc@hanseatica.com'));
  const main = await one('select id from tickets where number=$1', [T.b]);
  assert.equal((await one('select coalesce(sum(minutes),0)::int as m from time_entries where ticket_id=$1', [main.id])).m, 30, 'las horas quedan en el principal');
  assert.equal((await q('select 1 from ticket_followers where ticket_id=$1', [main.id])).length >= 1, true);
  assert.equal((await one(`select count(*)::int as n from attachments a join ticket_messages m on m.id=a.ticket_message_id where m.ticket_id=$1 and a.filename='captura.pdf'`, [main.id])).n, 1);
});

test('compatibilidad: la ruta vieja combina un ticket en otro', async () => {
  const x = await admin.post('/tickets', { subject: 'Duplicado A', contact_email: 'dup@hanseatica.com' });
  const y = await admin.post('/tickets', { subject: 'Duplicado B', contact_email: 'dup@hanseatica.com' });
  const nx = x.data.number ?? x.data.ticket?.number;
  const ny = y.data.number ?? y.data.ticket?.number;
  const r = await agente.post(`/tickets/${nx}/merge`, { into: ny });
  ok(r);
  assert.equal(r.data.into, ny);
  assert.equal((await admin.get(`/tickets/${nx}`)).data.ticket.merged_into, ny);
});
