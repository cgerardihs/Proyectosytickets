// v1.9.7: la preferencia de la mascota del ingreso viaja por el endpoint público (antes de que haya sesión).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

test('mascota: encendida de fábrica, se apaga desde la marca y se informa sin sesión', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const anon = makeClient();
  assert.equal((await anon.get('/auth/me')).data.mascot, true, 'de fábrica');
  ok(await admin.put('/admin/settings/brand', { login_mascot: false }));
  const { clearSettingsCache } = await import('../lib/settings.js');
  clearSettingsCache();
  assert.equal((await anon.get('/auth/me')).data.mascot, false);
  assert.equal((await anon.get('/auth/me')).data.brand.color.toUpperCase(), '#C8102E', 'la marca de fábrica viaja igual');
  ok(await admin.put('/admin/settings/brand', { login_mascot: true }));
  clearSettingsCache();
  assert.equal((await anon.get('/auth/me')).data.mascot, true);
  assert.equal((await anon.put('/admin/settings/brand', { login_mascot: false })).status, 401, 'cambiarla requiere sesión de administrador');
  assert.equal((await admin.put('/admin/settings/brand', { login_mascot: 'no' })).status, 400);
});
