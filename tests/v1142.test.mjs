// v1.14.2: "Equipos del solicitante" muestra un mensaje claro cuando a la app de Azure le falta el permiso de Intune
// (antes se veía el error crudo de Graph) y distingue ese caso de "no tiene equipos".
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.MS_CLIENT_SECRET = 'secreto';
let intune = 'forbidden';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const INTUNE_403 = JSON.stringify({ _version: 3, Message: 'Application is not authorized to perform this operation. Application must have one of the following scopes: DeviceManagementManagedDevices.Read.All, DeviceManagementManagedDevices.ReadWrite.All - Operation ID (for customer support): 00000000-0000-0000-0000-000000000000 - Activity ID: 39000685 - Url: https://proxy.msua05.manage.microsoft.com/x', CustomApiErrorPhrase: '' });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://login.microsoftonline.com/')) return json({ access_token: jwt({ roles: ['Mail.Send'] }), expires_in: 3600 });
  if (u.includes('/managedDevices')) {
    if (intune === 'forbidden') return json({ error: { code: 'UnknownError', message: INTUNE_403 } }, 403);
    return json({ value: [] });
  }
  if (u.startsWith('https://graph.microsoft.com/')) return json({ value: [] });
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { graphMessage } = await import('../lib/m365.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

test('el mensaje de Graph se limpia (sin el JSON ni el Operation ID)', () => {
  assert.equal(graphMessage({ error: { message: INTUNE_403 } }), 'Application is not authorized to perform this operation. Application must have one of the following scopes: DeviceManagementManagedDevices.Read.All, DeviceManagementManagedDevices.ReadWrite.All');
  assert.equal(graphMessage({ error: { message: 'Resource not found' } }), 'Resource not found');
  assert.equal(graphMessage({}), '');
});

test('equipos del solicitante: falta de permiso vs. sin equipos', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' });
  ok(await admin.put('/admin/m365', { tenant_id: '8f1c2a4e-1b2c-4d5e-9f00-112233445566', client_id: '0a1b2c3d-4e5f-4061-8a9b-cdef01234567', intune: { enabled: true } }));
  ok(await makeClient().post('/portal/tickets', { name: 'Ana Ruiz', email: 'aruiz@hanseatica.com', subject: 'Equis anda lento', body_text: 'x' }));
  const { one } = await import('../lib/db.js');
  const n = (await one(`select number from tickets where subject='Equis anda lento'`)).number;
  let r = await admin.get(`/tickets/${n}/devices`);
  ok(r);
  assert.equal(r.data.notice_kind, 'permission');
  assert.match(r.data.notice, /DeviceManagementManagedDevices\.Read\.All/);
  assert.doesNotMatch(r.data.notice, /Operation ID|_version/);
  intune = 'empty';
  r = await admin.get(`/tickets/${n}/devices`);
  ok(r);
  assert.deepEqual(r.data.devices, []);
  assert.equal(r.data.notice_kind, undefined);
});
