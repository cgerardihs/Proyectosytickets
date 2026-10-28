// v1.13.4: el filtro de proyectos por persona no muestra proyectos ajenos.
// Quien carga un proyecto para otro no queda en el equipo, y al cambiar el responsable el anterior sale del equipo
// (salvo que tenga tareas abiertas ahí).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const U = {};
const proj = async (key) => (await admin.get('/projects')).data.find((p) => p.key === key);

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  for (const [k, name] of [['matias', 'Matias Ayala'], ['martin', 'Martin Tamburrini']]) {
    const r = await admin.post('/admin/users', { name, email: `${k}@hanseatica.com`, role: 'agent', password: 'Rio-de-la-Plata-9' });
    ok(r, name);
    U[k] = r.data.id ?? r.data.user?.id;
  }
  U.me = (await admin.get('/me')).data?.id ?? (await admin.get('/meta')).data.me?.id;
  assert.ok(U.matias && U.martin);
});

test('quien carga el proyecto para otro no queda en el equipo', async () => {
  ok(await admin.post('/projects', { key: 'MRE', name: 'Modificar reporte equis', lead_id: U.martin }));
  const p = await proj('MRE');
  assert.equal(p.lead_id, U.martin);
  assert.deepEqual(p.member_ids, [U.martin]);
  // Sin responsable elegido, el que lo carga es el responsable (y está en el equipo)
  ok(await admin.post('/projects', { key: 'PROPIO', name: 'Proyecto propio' }));
  const own = await proj('PROPIO');
  assert.equal(own.lead_id, U.me);
  assert.ok(own.member_ids.includes(U.me));
  // El equipo elegido se respeta
  ok(await admin.post('/projects', { key: 'EQ', name: 'Con equipo', lead_id: U.martin, member_ids: [U.matias] }));
  assert.deepEqual((await proj('EQ')).member_ids.sort(), [U.matias, U.martin].sort());
});

test('al cambiar el responsable, el anterior sale del equipo salvo que tenga tareas abiertas', async () => {
  ok(await admin.post('/projects', { key: 'MC', name: 'Migración de certificados', lead_id: U.matias }));
  ok(await admin.patch('/projects/MC', { lead_id: U.martin }));
  let p = await proj('MC');
  assert.equal(p.lead_id, U.martin);
  assert.deepEqual(p.member_ids, [U.martin], 'Matías ya no figura');
  // Con una tarea abierta asignada, el anterior sigue en el equipo
  ok(await admin.post('/projects', { key: 'TAR', name: 'Con tareas', lead_id: U.matias }));
  ok(await admin.post('/projects/TAR/issues', { type: 'task', title: 'Revisar certificados', assignee_id: U.matias }));
  ok(await admin.patch('/projects/TAR', { lead_id: U.martin }));
  p = await proj('TAR');
  assert.deepEqual(p.member_ids.sort(), [U.matias, U.martin].sort());
  assert.ok(p.assignee_ids.includes(U.matias));
});
