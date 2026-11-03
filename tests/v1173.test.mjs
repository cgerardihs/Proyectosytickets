// v1.17.3: las imágenes pegadas en respuestas, notas, descripciones y comentarios quedan en el cuerpo (no como adjuntos).
// Se guardan como adjuntos incrustados y, en los correos, viajan incrustadas (cid:) para que el usuario las vea.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.RESEND_API_KEY = 're_prueba';
process.env.MAIL_FROM = 'Mesa de Ayuda <soporte@hanseatica.com>';
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pasted = `<p>La cuenta sí existe en CRM (ver captura):</p><p><img src="data:image/png;base64,${PNG}" alt="Imagen pegada"></p><p>Saludos</p>`;
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
const imgIds = (html) => [...String(html).matchAll(/src="\/api\/attachments\/(\d+)"/g)].map((m) => Number(m[1]));
let num;

test('preparación: un ticket con contacto', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const t = await admin.post('/tickets', { subject: 'Vinculante 837 no figura en CRM', contact_email: 'jloscerbo@hanseatica.com', body_html: `<p>Pedido</p><img src="data:image/png;base64,${PNG}">` });
  ok(t);
  num = t.data.number ?? t.data.ticket?.number;
  const d = (await admin.get(`/tickets/${num}`)).data;
  assert.equal(imgIds(d.messages[0].body_html).length, 1, 'el ticket creado por un agente también guarda la imagen en el cuerpo');
  assert.doesNotMatch(d.messages[0].body_html, /data:image/);
});

test('una respuesta con una captura pegada: queda en el cuerpo y el correo la lleva incrustada', async () => {
  sent.length = 0;
  const r = await admin.post(`/tickets/${num}/messages`, { kind: 'reply', body_html: pasted });
  ok(r);
  const m = r.data.detail.messages.find((x) => x.id === r.data.message.id);
  const ids = imgIds(m.body_html);
  assert.equal(ids.length, 1);
  assert.doesNotMatch(m.body_html, /data:image/, 'no queda la imagen en texto dentro de la base');
  const att = await q('select inline, content_type, ticket_message_id from attachments where id=$1', [ids[0]]);
  assert.deepEqual([att[0].inline, att[0].content_type, att[0].ticket_message_id], [true, 'image/png', m.id]);
  assert.ok(!m.attachments?.length || m.attachments.every((a) => a.inline), 'no aparece como adjunto suelto');
  assert.equal((await admin.get(`/attachments/${ids[0]}`)).status, 200);
  assert.ok(await until(() => sent.length > 0), 'se mandó el correo');
  const mail = sent.at(-1);
  assert.match(mail.html, /src="cid:img\d+@mesa-de-ayuda"/, 'en el correo la imagen va incrustada');
  assert.doesNotMatch(mail.html, /\/api\/attachments\//);
  const inl = mail.attachments.find((a) => a.content_id);
  assert.ok(inl && inl.content === PNG && inl.content_type === 'image/png');
});

test('notas: al crearlas y al editarlas', async () => {
  const n = await admin.post(`/tickets/${num}/messages`, { kind: 'note', body_html: `<img src="data:image/png;base64,${PNG}">` });
  ok(n, 'una nota con solo una imagen es válida');
  const note = n.data.detail.messages.find((x) => x.id === n.data.message.id);
  assert.equal(imgIds(note.body_html).length, 1);
  const e = await admin.patch(`/tickets/${num}/messages/${note.id}`, { body_html: `${note.body_html}<p>Y otra:</p><img src="data:image/png;base64,${PNG}">` });
  ok(e);
  assert.equal(imgIds(e.data.detail.messages.find((x) => x.id === note.id).body_html).length, 2);
});

test('tareas: descripción y comentarios con imágenes pegadas', async () => {
  ok(await admin.post('/projects', { key: 'CT', name: 'Cotizador de transporte' }));
  const i = await admin.post('/projects/CT/issues', { type: 'story', title: 'Solicitud de alta de usuarios desde el cotizador', description_html: pasted });
  ok(i);
  let d = (await admin.get(`/issues/${i.data.key}`)).data;
  assert.equal(imgIds(d.issue.description_html).length, 1);
  ok(await admin.patch(`/issues/${i.data.key}`, { description_html: `${d.issue.description_html}<img src="data:image/png;base64,${PNG}">` }));
  d = (await admin.get(`/issues/${i.data.key}`)).data;
  assert.equal(imgIds(d.issue.description_html).length, 2);
  const c = await admin.post(`/issues/${i.data.key}/comments`, { body_html: `<img src="data:image/png;base64,${PNG}">` });
  ok(c, 'un comentario con solo una imagen es válido');
  assert.equal(imgIds(c.data.body_html).length, 1);
  d = (await admin.get(`/issues/${i.data.key}`)).data;
  assert.equal(d.attachments.length, 0, 'las imágenes del cuerpo no se listan en Adjuntos');
  assert.equal((await admin.get(`/attachments/${imgIds(c.data.body_html)[0]}`)).status, 200);
});

test('una imagen de más de 3 MB se rechaza con un mensaje claro', async () => {
  const big = 'A'.repeat(4.1 * 1024 * 1024);
  const r = await admin.post(`/tickets/${num}/messages`, { kind: 'note', body_html: `<img src="data:image/png;base64,${big}">` });
  assert.ok([400, 413].includes(r.status));
  assert.match(r.data.error, /3 MB|tamaño|largo/);
});
