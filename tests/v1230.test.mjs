// v1.23: avance por tarea (el proyecto promedia), administrar vistas y filtro por agente.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const admin = makeClient();
const otro = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const sup = makeClient();
const keys = [];
const projectPct = async (key) => (await sup.get('/portfolio')).data.rows.find((p) => p.key === key).progress;

test('preparación: un proyecto con 4 tareas (sin etapas) y otro con una etapa', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: process.env.SUPERADMIN_PASSWORD }));
  ok(await admin.post('/projects', { key: 'AV', name: 'Avance', template: 'simple' }));
  for (const t of ['Uno', 'Dos', 'Tres', 'Cuatro']) { const r = await admin.post('/projects/AV/issues', { type: 'task', title: t }); ok(r); keys.push(r.data.key); }
});

test('una tarea al 100 % y tres al 0 %: el proyecto va 25 %, y la tarea queda Finalizada', async () => {
  const r = await admin.patch(`/issues/${keys[0]}`, { progress: 100 });
  ok(r);
  assert.equal(r.data.issue.task_state, 'done', '100 % = Finalizada');
  assert.equal(await projectPct('AV'), 25);
});

test('una tarea nueva recalcula el promedio; avances parciales suman', async () => {
  const n = await admin.post('/projects/AV/issues', { type: 'task', title: 'Cinco' });
  ok(n);
  keys.push(n.data.key);
  assert.equal(await projectPct('AV'), 20, '100 / 5 tareas');
  const r = await admin.patch(`/issues/${keys[1]}`, { progress: 50 });
  ok(r);
  assert.equal(r.data.issue.task_state, 'in_progress', 'una tarea en Standby que avanza pasa a En curso');
  assert.equal(await projectPct('AV'), 30, '(100 + 50) / 5');
  // Las subtareas no cuentan como tareas del proyecto
  ok(await admin.post('/projects/AV/issues', { type: 'subtask', title: 'Sub', parent_id: n.data.id }));
  assert.equal(await projectPct('AV'), 30);
});

test('estado y avance van juntos: Finalizada = 100 %; si se reabre la que estaba al 100 %, vuelve a 0 %', async () => {
  let r = await admin.patch(`/issues/${keys[2]}`, { task_state: 'done' });
  assert.equal(r.data.issue.progress, 100);
  r = await admin.patch(`/issues/${keys[2]}`, { task_state: 'in_progress' });
  assert.equal(r.data.issue.progress, 0);
  r = await admin.patch(`/issues/${keys[0]}`, { progress: 80 });
  assert.notEqual(r.data.issue.task_state, 'done', 'bajar de 100 reabre la tarea');
  assert.equal((await admin.patch(`/issues/${keys[0]}`, { progress: 150 })).status, 400, 'el avance va de 0 a 100');
});

test('proyecto con etapas: la etapa promedia sus tareas y el proyecto promedia las etapas', async () => {
  ok(await admin.post('/projects', { key: 'ET', name: 'Con etapas', template: 'dev', phases: [{ name: 'Relevamiento' }, { name: 'Desarrollo' }] }));
  const pj = (await admin.get('/projects/ET')).data;
  const ep = pj.epics[0];
  const t1 = await admin.post('/projects/ET/issues', { type: 'task', title: 'A', parent_id: ep.id });
  ok(await admin.post('/projects/ET/issues', { type: 'task', title: 'B', parent_id: ep.id }));
  ok(await admin.patch(`/issues/${t1.data.key}`, { progress: 60 }));
  const epics = (await admin.get('/projects/ET')).data.epics;
  assert.equal(epics[0].child_progress, 30, 'la etapa: (60 + 0) / 2');
  assert.equal(await projectPct('ET'), 15, 'el proyecto: (30 + 0) / 2 etapas');
});

test('administrar vistas: renombrar, compartir, cambiar filtros y eliminar; otro agente no puede', async () => {
  const v = await admin.post('/views', { name: 'Equis de Juan', filters: { assignee: 'me' } });
  ok(v);
  ok(await admin.patch(`/views/${v.data.id}`, { name: 'Equis del equipo', shared: true, filters: { assignee: 'none', tech: '1' } }));
  const m = (await admin.get('/meta')).data.views.find((x) => x.id === v.data.id);
  assert.equal(m.name, 'Equis del equipo');
  assert.equal(m.shared, true);
  assert.deepEqual(m.filters, { assignee: 'none', tech: '1' });
  ok(await admin.post('/admin/users', { name: 'Otro', email: 'vistas.otro@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await otro.post('/auth/login', { email: 'vistas.otro@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  assert.equal((await otro.del(`/views/${v.data.id}`)).status, 403);
  ok(await admin.del(`/views/${v.data.id}`));
  assert.ok(!(await admin.get('/meta')).data.views.some((x) => x.id === v.data.id));
});
