// v1.9.1: configurar proyectos solo con permiso (líder, supervisor/admin o "Puede configurar todos los proyectos")
// y datos para filtrar la lista de proyectos por persona.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');

const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const U = {};
const C = {};

test('instalación y usuarios', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  for (const [k, extra] of [['lider', {}], ['agente', {}], ['gestor', { can_manage_projects: true }]]) {
    const r = await admin.post('/admin/users', { name: `Usuario ${k}`, email: `${k}@hanseatica.com`, password: `Tango-Sur-${k.length}-Riachuelo`, role: 'agent', ...extra });
    ok(r, k);
    U[k] = r.data;
    C[k] = makeClient();
    ok(await C[k].post('/auth/login', { email: `${k}@hanseatica.com`, password: `Tango-Sur-${k.length}-Riachuelo` }), `login ${k}`);
  }
  assert.equal(U.gestor.can_manage_projects, true, 'un admin puede dar el permiso');
  assert.equal(U.agente.can_manage_projects, false);
  const list = (await admin.get('/admin/users')).data;
  assert.equal((list.users || list).find((u) => u.id === U.gestor.id).can_manage_projects, true);
});

test('proyecto: solo líder, admin o con permiso ven y usan la configuración', async () => {
  const r = await admin.post('/projects', { key: 'DEV', name: 'Desarrollo CRM', template: 'dev', type_id: (await admin.get('/meta')).data.projectTypes[0].id, lead_id: U.lider.id, member_ids: [U.agente.id] });
  ok(r);
  const flag = async (c) => (await c.get('/projects/DEV')).data.can_configure;
  assert.equal(await flag(admin), true);
  assert.equal(await flag(C.lider), true);
  assert.equal(await flag(C.gestor), true);
  assert.equal(await flag(C.agente), false, 'un integrante sin permiso no configura');

  assert.equal((await C.agente.patch('/projects/DEV', { name: 'Cambiado' })).status, 403);
  const statuses = (await admin.get('/projects/DEV')).data.statuses;
  const body = { statuses: statuses.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })) };
  assert.equal((await C.agente.put('/projects/DEV/statuses', body)).status, 403);
  assert.equal((await C.agente.put('/projects/DEV/members', { user_ids: [U.agente.id] })).status, 403);

  ok(await C.gestor.patch('/projects/DEV', { name: 'CRM nuevo' }), 'con permiso');
  ok(await C.lider.patch('/projects/DEV', { description: 'Lo configura el líder' }), 'líder');
  assert.equal((await admin.get('/projects/DEV')).data.project.name, 'CRM nuevo');

  // Quitar el permiso lo saca en el acto
  ok(await admin.patch(`/admin/users/${U.gestor.id}`, { can_manage_projects: false }));
  assert.equal(await flag(C.gestor), false);
  assert.equal((await C.gestor.patch('/projects/DEV', { name: 'Otra vez' })).status, 403);
});

test('lista de proyectos: integrantes y responsables de tareas para filtrar por persona', async () => {
  const pj = (await admin.get('/projects/DEV')).data;
  const todo = pj.statuses[0].id;
  ok(await admin.post('/projects/DEV/issues', { title: 'Pantalla de alta', type: 'task', status_id: todo, assignee_id: U.gestor.id }));
  const epic = pj.epics[0];
  assert.ok(epic, 'el tipo crea etapas');
  ok(await admin.patch(`/issues/${epic.key}`, { assignee_id: U.agente.id }));
  const p = (await admin.get('/projects')).data.find((x) => x.key === 'DEV');
  assert.equal(p.lead_id, U.lider.id);
  assert.ok(p.member_ids.includes(U.agente.id));
  assert.deepEqual(p.assignee_ids, [U.gestor.id], 'solo cuenta tareas, no etapas');
});
