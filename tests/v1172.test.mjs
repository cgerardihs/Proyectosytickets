// v1.17.2: correos que no llegaban a ser tickets.
//  - Con carpeta de procesados, se toma todo lo que está en la Bandeja de entrada (aunque alguien lo haya abierto en Outlook).
//  - Adjuntos de cualquier tipo: un correo adjunto ("Elemento de Outlook") se guarda como .eml; nada hace fallar el pedido.
//  - Si los adjuntos fallan 3 veces, el correo entra igual con un aviso. Un adjunto de más de 3 MB ya no frena el correo.
//  - Las imágenes pegadas se piden aunque Graph diga hasAttachments=false.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.MS_CLIENT_SECRET = 'secreto';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const realFetch = globalThis.fetch;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let inbox = [];
const atts = {};
let lastFilter = '';
let selectUsed = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://login.microsoftonline.com/')) return json({ access_token: jwt({ roles: ['Mail.ReadWrite', 'Mail.Send'] }), expires_in: 3600 });
  if (u.startsWith('https://graph.microsoft.com/v1.0')) {
    const p = decodeURIComponent(u.replace('https://graph.microsoft.com/v1.0', ''));
    const m = opts.method || 'GET';
    if (p.includes('/mailFolders/inbox/messages')) { lastFilter = /\$filter=([^&]+)/.exec(p)?.[1] || ''; return json({ value: inbox }); }
    if (p.includes('/mailFolders?$filter')) return json({ value: [{ id: 'PROC', displayName: 'Procesados' }] });
    const am = /\/messages\/([^/]+)\/attachments(?:\/([^/?]+)\/\$value)?(\?.*)?$/.exec(p);
    if (am && m === 'GET') {
      if (am[3]) selectUsed = true;
      const a = atts[am[1]];
      if (a === 'error') return json({ error: { code: 'RequestBroker--ParseUri', message: 'Could not find a property named contentId on type microsoft.graph.attachment' } }, 400);
      if (am[2]) return new Response(Buffer.from('From: portal@hanseatica.com\r\nSubject: Bienvenido - Portal Web Hanseatica\r\n\r\nHola'), { status: 200, headers: { 'content-type': 'message/rfc822' } });
      return json({ value: a || [] });
    }
    if (p.endsWith('/move') && m === 'POST') { const id = /\/messages\/([^/]+)\/move/.exec(p)[1]; inbox = inbox.filter((x) => x.id !== id); return json({}); }
    if (p.includes('/messages/') && m === 'PATCH') return json({});
    if (p.endsWith('/sendMail')) return new Response(null, { status: 202 });
    return json({ error: { message: `No simulado: ${m} ${p}` } }, 404);
  }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const { pollMailbox } = await import('../lib/m365.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const mail = (id, subject, extra = {}) => ({ id, subject, isRead: true, from: { emailAddress: { address: 'ddiprimio@hanseatica.com', name: 'Daniel Di Primio' } }, body: { contentType: 'html', content: '<p>Estimados, les pido un blanqueo de clave.</p>' }, internetMessageId: `<${id}@x>`, hasAttachments: true, internetMessageHeaders: [], ...extra });
const ticketBy = (subject) => q(`select t.number, m.body_html, m.id as mid from tickets t join ticket_messages m on m.ticket_id=t.id and m.kind='customer' where t.subject=$1`, [subject]);

test('preparación: buzón conectado con carpeta de procesados', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await admin.put('/admin/m365', { tenant_id: '8f1c2a4e-1b2c-4d5e-9f00-112233445566', client_id: '0a1b2c3d-4e5f-4061-8a9b-cdef01234567', mailbox: { enabled: true, address: 'soporte@hanseatica.com' } }));
});

test('un correo ya leído, con un correo adjunto y un PDF, entra como ticket', async () => {
  atts.M1 = [
    { '@odata.type': '#microsoft.graph.itemAttachment', id: 'IA1', name: 'Bienvenido - Portal Web Hanseatica', contentType: null, size: 52000, isInline: false },
    { '@odata.type': '#microsoft.graph.fileAttachment', id: 'FA1', name: 'captura.pdf', contentType: 'application/pdf', size: 9, isInline: false, contentBytes: 'JVBERi0xLjQK' },
  ];
  inbox = [mail('M1', 'RV: OVERSEAS NVOCC CORP USA')];
  await pollMailbox({ force: true });
  assert.match(decodeURIComponent(lastFilter), /^receivedDateTime ge \d{4}-\d{2}-\d{2}T/, 'con carpeta de procesados no se filtra por no leído');
  assert.equal(selectUsed, false, 'los adjuntos se piden sin $select');
  const [t] = await ticketBy('RV: OVERSEAS NVOCC CORP USA');
  assert.ok(t, 'se creó el ticket');
  const files = await q('select filename, content_type from attachments where ticket_message_id=$1 order by filename', [t.mid]);
  assert.deepEqual(files.map((f) => [f.filename, f.content_type]), [['Bienvenido - Portal Web Hanseatica.eml', 'message/rfc822'], ['captura.pdf', 'application/pdf']]);
  assert.equal(inbox.length, 0, 'se movió a Procesados');
});

test('si los adjuntos fallan, se reintenta y al tercer intento entra igual con un aviso', async () => {
  atts.M2 = 'error';
  inbox = [mail('M2', 'Rastreo usuario de impresión 29/10/2026', { from: { emailAddress: { address: 'gbottin@hanseatica.com', name: 'Guido Bottin' } } })];
  await pollMailbox({ force: true });
  await pollMailbox({ force: true });
  assert.equal((await ticketBy('Rastreo usuario de impresión 29/10/2026')).length, 0, 'todavía reintenta');
  await pollMailbox({ force: true });
  const [t] = await ticketBy('Rastreo usuario de impresión 29/10/2026');
  assert.ok(t, 'entró al tercer intento');
  assert.match(t.body_html, /No se pudieron leer los adjuntos/);
});

test('un adjunto de más de 3 MB no frena el correo: queda anotado', async () => {
  atts.M3 = [
    { '@odata.type': '#microsoft.graph.fileAttachment', name: 'video.mp4', contentType: 'video/mp4', size: 4400000, isInline: false, contentBytes: 'A'.repeat(4.4 * 1024 * 1024) },
    { '@odata.type': '#microsoft.graph.fileAttachment', name: 'nota.pdf', contentType: 'application/pdf', size: 9, isInline: false, contentBytes: 'JVBERi0xLjQK' },
    { '@odata.type': '#microsoft.graph.referenceAttachment', name: 'Planilla compartida.xlsx', isInline: false },
  ];
  inbox = [mail('M3', 'Video del error')];
  await pollMailbox({ force: true });
  const [t] = await ticketBy('Video del error');
  assert.ok(t);
  assert.match(t.body_html, /video\.mp4.*supera los 3 MB/);
  assert.match(t.body_html, /Planilla compartida\.xlsx/);
  assert.deepEqual((await q('select filename from attachments where ticket_message_id=$1', [t.mid])).map((x) => x.filename), ['nota.pdf']);
});

test('las imágenes pegadas se piden aunque Graph diga que no hay adjuntos', async () => {
  atts.M4 = [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'image001.png', contentType: 'image/png', size: 70, isInline: true, contentId: 'image001.png@01DC', contentBytes: PNG }];
  inbox = [mail('M4', 'Con captura pegada', { hasAttachments: false, body: { contentType: 'html', content: '<p>Miren</p><img src="cid:image001.png@01DC">' } })];
  await pollMailbox({ force: true });
  const [t] = await ticketBy('Con captura pegada');
  assert.match(t.body_html, /src="\/api\/attachments\/\d+"/);
});

test('sin carpeta de procesados se sigue usando "no leído"', async () => {
  ok(await admin.put('/admin/m365', { mailbox: { processed_folder: '' } }));
  inbox = [];
  await pollMailbox({ force: true });
  assert.equal(decodeURIComponent(lastFilter), 'isRead eq false');
});
