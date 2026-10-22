// v1.9.8: proyecto sin responsable (ej. importado): al guardar un único miembro, ese miembro pasa a ser el responsable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

test('miembros y responsable', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const users = (await admin.get('/meta')).data.users.filter((u) => u.active);
  const [a, b] = users;
  ok(await admin.post('/projects', { key: 'DL', name: 'Dashboard Legales' }));
  await q(`update projects set lead_id=null where key='DL'`);
  // Dos miembros: no se elige responsable solo
  let r = await admin.put('/projects/DL/members', { user_ids: [a.id, b.id] });
  ok(r);
  assert.equal(r.data.lead_id, null);
  assert.equal((await admin.get('/projects/DL')).data.project.lead_id, null);
  // Uno solo: queda como responsable y se ve en la lista y el portfolio
  r = await admin.put('/projects/DL/members', { user_ids: [b.id] });
  assert.equal(r.data.lead_id, b.id);
  assert.equal((await admin.get('/projects')).data.find((p) => p.key === 'DL').lead_id, b.id);
  // Con responsable ya puesto, cambiar miembros no lo toca
  r = await admin.put('/projects/DL/members', { user_ids: [a.id] });
  assert.equal(r.data.lead_id, null);
  assert.equal((await admin.get('/projects/DL')).data.project.lead_id, b.id);
});
