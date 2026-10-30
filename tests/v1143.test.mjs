// v1.14.3: contactos activos e inactivos (uno o varios a la vez). Inactivo: no aparece en la lista ni en las
// sugerencias; puesto a mano, la sincronización con Microsoft 365 no lo reactiva.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.MS_CLIENT_SECRET = 'secreto';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://login.microsoftonline.com/')) return json({ access_token: jwt({ roles: ['User.Read.All'] }), expires_in: 3600 });
  if (u.startsWith('https://graph.microsoft.com/v1.0/users?')) return json({ value: [
    { id: 'u-ana', displayName: 'Ana Ruiz', mail: 'aruiz@hanseatica.com', department: 'Siniestros', accountEnabled: true },
    { id: 'u-bot', displayName: 'BC_Ayuda', mail: 'ayuda@hanseatica.com', department: 'Sistemas', accountEnabled: true },
  ] });
  if (u.startsWith('https://graph.microsoft.com/')) return json({ value: [] });
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const admin = makeClient();
const agent = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

test('marcar inactivos y activos', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await admin.put('/admin/m365', { tenant_id: '8f1c2a4e-1b2c-4d5e-9f00-112233445566', client_id: '0a1b2c3d-4e5f-4061-8a9b-cdef01234567', directory: { enabled: true } }));
  ok(await admin.post('/admin/m365/sync-directory'), 'sincronizar');
  let r = await admin.get('/contacts?q=hanseatica');
  const bot = r.data.items.find((c) => c.email === 'ayuda@hanseatica.com');
  const ana = r.data.items.find((c) => c.email === 'aruiz@hanseatica.com');
  assert.ok(bot && ana);
  ok(await admin.post('/contacts/active', { ids: [bot.id], active: false }));
  r = await admin.get('/contacts?q=hanseatica');
  assert.ok(!r.data.items.some((c) => c.id === bot.id), 'por defecto, solo activos');
  assert.equal(r.data.counts.inactive, 1);
  r = await admin.get('/contacts?status=inactive');
  assert.deepEqual(r.data.items.map((c) => c.id), [bot.id]);
  assert.equal(r.data.items[0].inactive_manual, true);
  assert.equal((await admin.get('/contacts?status=all&q=hanseatica')).data.items.length, 2);
  // La sincronización con Microsoft 365 no lo reactiva
  ok(await admin.post('/admin/m365/sync-directory'));
  assert.equal((await admin.get(`/contacts/${bot.id}`)).data.active, false);
  // Reactivar
  ok(await admin.post('/contacts/active', { ids: [bot.id, ana.id], active: true }));
  const c = (await admin.get(`/contacts/${bot.id}`)).data;
  assert.equal(c.active, true);
  assert.equal(c.inactive_manual, false);
  assert.equal((await admin.post('/contacts/active', { ids: [], active: false })).status, 400);
});

test('solo supervisores y administradores', async () => {
  ok(await admin.post('/admin/users', { name: 'Ana Agente', email: 'agente@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await agent.post('/auth/login', { email: 'agente@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  const any = (await admin.get('/contacts')).data.items[0];
  assert.equal((await agent.post('/contacts/active', { ids: [any.id], active: false })).status, 403);
});

test('v1.14.4: la lista de tickets acepta hasta 2000 por página ("Todos")', async () => {
  let r = await admin.get('/tickets?limit=2000');
  ok(r);
  assert.equal(r.data.limit, 2000);
  r = await admin.get('/tickets?limit=99999');
  assert.equal(r.data.limit, 2000);
});
