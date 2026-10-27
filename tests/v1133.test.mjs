// v1.13.3: un ticket que entra por correo aparece en pantalla sin recargar.
// La consulta de notificaciones (cada minuto) lee el buzón y devuelve qué entró, para que la lista se actualice.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.MS_CLIENT_SECRET = 'secreto';
let unread = [];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://login.microsoftonline.com/')) return json({ access_token: jwt({ roles: ['Mail.ReadWrite', 'Mail.Send'] }), expires_in: 3600 });
  if (u.startsWith('https://graph.microsoft.com/v1.0')) {
    const p = decodeURIComponent(u.replace('https://graph.microsoft.com/v1.0', ''));
    const m = opts.method || 'GET';
    if (p.includes('/mailFolders/inbox/messages')) { const v = unread; unread = []; return json({ value: v }); }
    if (p.includes('/mailFolders?$filter')) return json({ value: [] });
    if (p.endsWith('/mailFolders') && m === 'POST') return json({ id: 'FOLDER1' });
    if (p.includes('/messages/') && (m === 'PATCH' || p.endsWith('/move'))) return json({});
    if (p.endsWith('/sendMail')) return new Response(null, { status: 202 });
    return json({ error: { message: `No simulado: ${m} ${p}` } }, 404);
  }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const { inboxSummary } = await import('../lib/routes/m365.js');
const { waitUntil } = await import('../lib/wait-until.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const mail = (id, subject, extra = {}) => ({ id, subject, from: { emailAddress: { address: 'rmoreno@hanseatica.com', name: 'Rodrigo Moreno' } }, body: { contentType: 'html', content: '<p>Hola</p>' }, internetMessageId: `<${id}@x>`, hasAttachments: false, internetMessageHeaders: [], ...extra });
// La lectura "perezosa" respeta el intervalo del buzón: para la prueba, se libera el turno
const freePoll = () => q(`update app_settings set updated_at = now() - interval '1 day' where key='m365_mail_poll'`);

test('preparación: buzón conectado', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await admin.put('/admin/m365', { tenant_id: '8f1c2a4e-1b2c-4d5e-9f00-112233445566', client_id: '0a1b2c3d-4e5f-4061-8a9b-cdef01234567', mailbox: { enabled: true, address: 'ayuda@hanseatica.com' } }));
});

let num;
test('correo nuevo: las notificaciones avisan qué ticket se creó', async () => {
  await freePoll();
  unread = [mail('A1', 'No anda la VPN')];
  const r = await admin.get('/notifications');
  ok(r);
  assert.equal(r.data.inbox.created.length, 1);
  num = r.data.inbox.created[0];
  assert.deepEqual(r.data.inbox.updated, []);
  const t = await admin.get(`/tickets/${num}`);
  assert.equal(t.data.ticket?.subject ?? t.data.subject, 'No anda la VPN');
  const list = await admin.get('/tickets');
  assert.ok(JSON.stringify(list.data).includes('No anda la VPN'), 'ya está en la lista');
});

test('respuesta a un ticket: aparece en "updated"', async () => {
  await freePoll();
  unread = [mail('A2', `RE: [#${num}] No anda la VPN`)];
  const r = await admin.get('/notifications');
  assert.deepEqual(r.data.inbox, { created: [], updated: [num] });
});

test('sin correo nuevo (o lectura reciente): inbox es null', async () => {
  await freePoll();
  assert.equal((await admin.get('/notifications')).data.inbox, null);
  unread = [mail('A3', 'Otro')];
  assert.equal((await admin.get('/notifications')).data.inbox, null, 'dentro del intervalo no se vuelve a leer');
  unread = [];
  assert.equal(inboxSummary(null), null);
  assert.equal(inboxSummary({ skipped: 'recent' }), null);
  assert.deepEqual(inboxSummary({ results: [{ ticket: 5, created: true }, { ticket: 6, appended: true }, { duplicate: true }] }), { created: [5], updated: [6] });
});

test('waitUntil: usa el contexto de Vercel si existe, y si no, no rompe', async () => {
  assert.equal(waitUntil(Promise.resolve(1)), false);
  const kept = [];
  const sym = Symbol.for('@vercel/request-context');
  globalThis[sym] = { get: () => ({ waitUntil: (p) => kept.push(p) }) };
  try {
    assert.equal(waitUntil(Promise.reject(new Error('x'))), true);
    assert.equal(kept.length, 1);
    await kept[0]; // el error queda atrapado
  } finally { delete globalThis[sym]; }
});
