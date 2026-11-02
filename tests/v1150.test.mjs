// v1.15: las tareas y subtareas tienen su propio estado (Standby, En curso, Test, Finalizada). Las etapas (épicas) siguen con
// el flujo del proyecto. Cada estado de tarea guarda por detrás un estado del flujo equivalente, para que el avance, el
// portfolio, el Finalizado automático y el cierre de ciclo con los tickets sigan funcionando.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { stateFromStatus, statusForState } = await import('../lib/task-states.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const issue = async (key) => (await admin.get(`/issues/${key}`)).data.issue;
const statusName = async (key) => { const d = (await admin.get(`/issues/${key}`)).data; return d.statuses.find((s) => s.id === d.issue.status_id)?.name; };
let epic;

test('preparación: proyecto de desarrollo con una etapa y cuatro tareas', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await admin.post('/projects', { key: 'SPMC', name: 'Sistema para el manejo de Comisiones', template: 'dev', phases: [{ name: 'Relevamiento y análisis' }] }));
  const pj = (await admin.get('/projects/SPMC')).data;
  assert.deepEqual(pj.statuses.map((s) => s.name), ['Backlog', 'Análisis', 'Desarrollo', 'Testing', 'Producción']);
  epic = pj.epics[0];
  for (const title of ['Relevar el circuito mensual de PAS', 'Relevar Caución y productores', 'Relevar Integral de Consorcio', 'Conseguir acceso a Equis TEST']) {
    ok(await admin.post('/projects/SPMC/issues', { type: 'task', title, parent_id: epic.id }), title);
  }
});

test('una tarea nueva arranca en Standby; la etapa no usa estados de tarea', async () => {
  const t = await issue('SPMC-2');
  assert.equal(t.task_state, 'standby');
  assert.equal(await statusName('SPMC-2'), 'Backlog');
  const d = (await admin.get(`/issues/${epic.key}`)).data;
  assert.equal(d.children.length, 4);
  assert.ok(d.children.every((c) => c.task_state === 'standby'));
  // A la etapa no se le puede poner un estado de tarea: sigue con el flujo
  ok(await admin.patch(`/issues/${epic.key}`, { task_state: 'done' }));
  assert.notEqual((await admin.get(`/issues/${epic.key}`)).data.issue.status_kind, 'done');
});

test('cada estado guarda el estado del flujo equivalente', async () => {
  ok(await admin.patch('/issues/SPMC-2', { task_state: 'in_progress' }));
  assert.equal((await issue('SPMC-2')).task_state, 'in_progress');
  assert.equal(await statusName('SPMC-2'), 'Desarrollo');
  ok(await admin.patch('/issues/SPMC-2', { task_state: 'test' }));
  assert.equal(await statusName('SPMC-2'), 'Testing');
  ok(await admin.patch('/issues/SPMC-2', { task_state: 'standby' }));
  assert.equal(await statusName('SPMC-2'), 'Backlog');
  assert.equal((await admin.patch('/issues/SPMC-2', { task_state: 'pausada' })).status, 400, 'estado desconocido');
});

test('Finalizada: queda resuelta, cuenta en el avance de la etapa y recuerda el estado anterior', async () => {
  ok(await admin.patch('/issues/SPMC-3', { task_state: 'test' }));
  ok(await admin.patch('/issues/SPMC-3', { task_state: 'done' }));
  const t = await issue('SPMC-3');
  assert.equal(t.task_state, 'done');
  assert.equal(t.task_state_prev, 'test');
  assert.ok(t.resolved_at);
  assert.equal(await statusName('SPMC-3'), 'Producción');
  const d = (await admin.get(`/issues/${epic.key}`)).data;
  assert.equal(d.children.filter((c) => c.status_kind === 'done').length, 1);
  const pj = (await admin.get('/projects/SPMC')).data;
  const ph = (await admin.get('/projects/SPMC/issues?type=epic')).data.find((e) => e.id === epic.id);
  assert.equal(ph.child_done, 1);
  assert.ok(pj.project);
  // Al volver al estado anterior se quita la resolución
  ok(await admin.patch('/issues/SPMC-3', { task_state: t.task_state_prev }));
  const back = await issue('SPMC-3');
  assert.equal(back.task_state, 'test');
  assert.equal(back.resolved_at, null);
});

test('el historial muestra el estado de la tarea, no el del flujo', async () => {
  const d = (await admin.get('/issues/SPMC-3')).data;
  const updates = d.activities.filter((a) => a.action === 'updated');
  assert.ok(updates.length >= 3);
  for (const a of updates) {
    assert.ok(a.details.task_state, 'registra el estado de la tarea');
    assert.equal(a.details.status_id, undefined, 'no repite el estado del flujo');
  }
  assert.deepEqual(updates.at(-1).details.task_state, { from: 'done', to: 'test' });
});

test('si cambia el estado del flujo por otro camino, el estado de la tarea lo sigue', async () => {
  const pj = (await admin.get('/projects/SPMC')).data;
  const prod = pj.statuses.find((s) => s.name === 'Producción');
  ok(await admin.post('/issues/reorder', { moved_id: (await issue('SPMC-4')).id, status_id: prod.id }));
  assert.equal((await issue('SPMC-4')).task_state, 'done');
  // El tablero mueve por estado de tarea
  ok(await admin.post('/issues/reorder', { moved_id: (await issue('SPMC-4')).id, task_state: 'in_progress', order: [] }));
  assert.equal((await issue('SPMC-4')).task_state, 'in_progress');
  assert.equal(await statusName('SPMC-4'), 'Desarrollo');
});

test('la tarea se puede crear directo en un estado', async () => {
  const r = await admin.post('/projects/SPMC/issues', { type: 'task', title: 'Ya probada', parent_id: epic.id, task_state: 'test' });
  ok(r);
  assert.equal(r.data.task_state, 'test');
  assert.equal(await statusName(r.data.key), 'Testing');
  const sub = await admin.post('/projects/SPMC/issues', { type: 'subtask', title: 'Subtarea hecha', parent_id: r.data.id, task_state: 'done' });
  ok(sub);
  assert.equal((await issue(sub.data.key)).status_kind, 'done');
  assert.ok((await issue(sub.data.key)).resolved_at);
});

test('con todas las tareas Finalizadas el proyecto pasa solo a Finalizado, y vuelve si se reabre una', async () => {
  const d = (await admin.get(`/issues/${epic.key}`)).data;
  for (const c of d.children) ok(await admin.patch(`/issues/${c.key}`, { task_state: 'done' }), c.key);
  // La subtarea de SPMC-6 ya estaba Finalizada
  let p = (await admin.get('/projects')).data.find((x) => x.key === 'SPMC');
  assert.equal(p.portfolio_status, 'done');
  ok(await admin.patch('/issues/SPMC-2', { task_state: 'in_progress' }));
  p = (await admin.get('/projects')).data.find((x) => x.key === 'SPMC');
  assert.equal(p.portfolio_status, 'active');
});

test('en un flujo sin estado de pruebas, Test usa el estado en curso y se conserva', async () => {
  ok(await admin.post('/projects', { key: 'SIMP', name: 'Flujo simple', template: 'simple' }));
  const r = await admin.post('/projects/SIMP/issues', { type: 'task', title: 'Probar algo' });
  ok(r);
  ok(await admin.patch(`/issues/${r.data.key}`, { task_state: 'test' }));
  const t = await issue(r.data.key);
  assert.equal(t.task_state, 'test');
  assert.equal(t.status_kind, 'doing');
  ok(await admin.patch(`/issues/${r.data.key}`, { task_state: 'in_progress' }));
  assert.equal((await issue(r.data.key)).task_state, 'in_progress');
});

test('al cambiar el flujo del proyecto, las tareas conservan su estado', async () => {
  const pj = (await admin.get('/projects/SIMP')).data;
  // Se borra "En curso": la tarea que estaba En curso pasa a otro estado del flujo del mismo tipo
  const keep = pj.statuses.filter((s) => s.name !== 'En curso').map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
  ok(await admin.put('/projects/SIMP/statuses', { statuses: [keep[0], { name: 'Haciendo', kind: 'doing' }, keep[1]] }));
  const t = await issue('SIMP-1');
  assert.equal(t.task_state, 'in_progress');
  assert.equal(t.status_kind, 'doing');
  assert.equal(await statusName('SIMP-1'), 'Haciendo');
});

test('la API de exportación informa el estado de la tarea', async () => {
  const sup = makeClient();
  ok(await sup.post('/auth/login', { email: 'superadmin', password: process.env.SUPERADMIN_PASSWORD }), 'login super');
  const k = await sup.post('/super/api-keys', { name: 'Power BI', scopes: ['projects'] });
  ok(k);
  const r = await makeClient().get('/v1/issues?project=SPMC', { authorization: `Bearer ${k.data.key}` });
  ok(r);
  assert.equal(r.data.data.find((x) => x.key === 'SPMC-2').task_state, 'in_progress');
  assert.equal(r.data.data.find((x) => x.key === epic.key).task_state, null, 'las etapas no tienen estado de tarea');
});

test('equivalencias entre el flujo y los estados de tarea', () => {
  assert.equal(stateFromStatus({ kind: 'doing', name: 'En revisión' }), 'test');
  assert.equal(stateFromStatus({ kind: 'doing', name: 'Análisis' }), 'in_progress');
  assert.equal(stateFromStatus({ kind: 'todo', name: 'Por hacer' }), 'standby');
  assert.equal(stateFromStatus(null), 'standby');
  const sts = [{ id: 1, name: 'Backlog', kind: 'todo', sort: 0 }, { id: 2, name: 'Análisis', kind: 'doing', sort: 1 }, { id: 3, name: 'Desarrollo', kind: 'doing', sort: 2 },
    { id: 4, name: 'Testing', kind: 'doing', sort: 3 }, { id: 5, name: 'Producción', kind: 'done', sort: 4 }];
  assert.equal(statusForState(sts, 'in_progress', 2), 2, 'Análisis ya es En curso: no se pisa');
  assert.equal(statusForState(sts, 'in_progress', 1), 3);
  assert.equal(statusForState(sts, 'test', 1), 4);
  assert.equal(statusForState(sts, 'done', 4), 5);
});
