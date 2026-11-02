// v1.17.1: las imágenes pegadas en el cuerpo de un correo (capturas, logos de la firma) llegan como adjuntos "inline" con un
// Content-ID. Se guardan y el cuerpo las muestra en su lugar (cid: → /api/attachments/<id>); no se listan como adjuntos sueltos.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const { sanitizeHtml } = await import('../lib/sanitize.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const SECRET = { 'x-inbound-secret': 'secreto-de-prueba' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let num;

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
});

test('un correo con una captura pegada y un adjunto: la captura se ve en el cuerpo y el adjunto queda como siempre', async () => {
  const r = await admin.post('/inbound/email', {
    From: 'Julian Loscerbo <jloscerbo@hanseatica.com>', Subject: 'Vinculante 837 no aparece en CRM', InternetMessageId: '<img1@mail>',
    Body: '<p>El vinculante figura en Equis (captura debajo).</p><p><img src="cid:image001.png@01DC4B9A.E1F2C3D0" width="600"></p><p>Saludos</p><img alt="Logotipo" src="cid:image002.png@01DC4B9A.E1F2C3D0">',
    Attachments: [
      { Name: 'image001.png', ContentType: 'image/png', ContentBytes: PNG, IsInline: true, ContentId: 'image001.png@01DC4B9A.E1F2C3D0' },
      { Name: 'image002.png', ContentType: 'image/png', ContentBytes: PNG, IsInline: true, ContentId: '<image002.png@01DC4B9A.E1F2C3D0>' },
      { Name: 'informe.pdf', ContentType: 'application/pdf', ContentBytes: 'JVBERi0xLjQK' },
      { Name: 'raro.bin', ContentType: 'application/octet-stream', ContentBytes: 'AAAA', IsInline: true, ContentId: 'raro@x' },
    ],
  }, SECRET);
  ok(r);
  assert.ok(r.data.results[0].created, JSON.stringify(r.data));
  num = r.data.results[0].ticket;
  const d = (await admin.get(`/tickets/${num}`)).data;
  const m = d.messages.find((x) => x.kind === 'customer');
  assert.doesNotMatch(m.body_html, /cid:/, 'no queda ningún cid: sin resolver');
  const ids = [...m.body_html.matchAll(/\/api\/attachments\/(\d+)/g)].map((x) => Number(x[1]));
  assert.equal(ids.length, 2, 'las dos imágenes apuntan a su adjunto');
  const atts = d.attachments || m.attachments || [];
  const all = await q('select id, filename, inline, content_id from attachments where ticket_message_id=$1 order by filename', [m.id]);
  assert.deepEqual(all.map((a) => [a.filename, a.inline]), [['image001.png', true], ['image002.png', true], ['informe.pdf', false]], 'el inline que no es imagen se ignora');
  assert.deepEqual(ids.sort(), all.filter((a) => a.inline).map((a) => a.id).sort());
  assert.ok(atts.length === 0 || atts.some((a) => a.inline), 'el detalle marca cuáles son incrustadas');
  const img = await admin.get(`/attachments/${ids[0]}`);
  assert.equal(img.status, 200, 'la imagen se descarga con los permisos del ticket');
});

test('una respuesta con una imagen incrustada también se ve', async () => {
  ok(await admin.post('/inbound/email', {
    From: 'jloscerbo@hanseatica.com', Subject: `RE: [#${num}] Vinculante 837 no aparece en CRM`, InternetMessageId: '<img2@mail>', InReplyTo: '<img1@mail>',
    Body: '<p>Les mando otra captura</p><img src="cid:image003.png@01DC">',
    Attachments: [{ Name: 'image003.png', ContentType: 'image/png', ContentBytes: PNG, IsInline: true, ContentId: 'image003.png@01DC' }],
  }, SECRET));
  const d = (await admin.get(`/tickets/${num}`)).data;
  const last = d.messages.filter((x) => x.kind === 'customer').at(-1);
  assert.match(last.body_html, /<img[^>]+src="\/api\/attachments\/\d+"/);
});

test('una imagen incrustada de más de 3 MB no frena el correo', async () => {
  const big = 'A'.repeat(4.2 * 1024 * 1024);
  const r = await admin.post('/inbound/email', {
    From: 'otro@hanseatica.com', Subject: 'Captura enorme', InternetMessageId: '<img3@mail>',
    Body: '<p>Mirá</p><img src="cid:big@x">', Attachments: [{ Name: 'big.png', ContentType: 'image/png', ContentBytes: big, IsInline: true, ContentId: 'big@x' }],
  }, SECRET);
  ok(r, 'el ticket se crea igual');
});

test('el saneado deja las imágenes propias y saca las rutas internas que no son imágenes', () => {
  assert.match(sanitizeHtml('<img src="/api/attachments/12">'), /src="\/api\/attachments\/12"/);
  assert.doesNotMatch(sanitizeHtml('<img src="/api/users/1">'), /src=/);
  assert.doesNotMatch(sanitizeHtml('<img src="//evil.com/x.png">'), /src=/);
  assert.match(sanitizeHtml('<img src="cid:x onerror=alert(1)">'), /^<img src="[^"]*">$/, 'todo queda dentro del valor de src');
});
