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

test('v1.13.6: el avance de la lista es el del portfolio (etapas, finalizado = 100 %)', async () => {
  ok(await admin.post('/projects', { key: 'NPDS', name: 'Nuevo proyecto desarrollo de software', lead_id: U.martin, phases: [{ name: 'Análisis' }, { name: 'Desarrollo' }] }));
  let p = await proj('NPDS');
  assert.equal(p.total_issues, 0, 'solo etapas, sin tareas sueltas');
  assert.equal(p.progress, 0);
  ok(await admin.patch('/projects/NPDS', { portfolio_status: 'done' }));
  p = await proj('NPDS');
  assert.equal(p.progress, 100);
  // Etapas: una terminada de dos = 50 %
  ok(await admin.patch('/projects/NPDS', { portfolio_status: 'active' }));
  const epics = (await admin.get('/projects/NPDS/issues')).data;
  const list = Array.isArray(epics) ? epics : epics.items;
  const first = list.find((i) => i.type === 'epic' && i.title === 'Análisis');
  const done = (await admin.get('/projects/NPDS')).data.statuses.find((s) => s.kind === 'done');
  ok(await admin.patch(`/issues/${first.key}`, { status_id: done.id }));
  assert.equal((await proj('NPDS')).progress, 50);
});

test('v1.13.7: con todas las tareas hechas el proyecto pasa solo a Finalizado (y vuelve a En curso si se reabre)', async () => {
  ok(await admin.post('/projects', { key: 'AUTO', name: 'Se finaliza solo', lead_id: U.martin }));
  const t1 = (await admin.post('/projects/AUTO/issues', { type: 'task', title: 'Uno' })).data;
  const t2 = (await admin.post('/projects/AUTO/issues', { type: 'task', title: 'Dos' })).data;
  const sts = (await admin.get('/projects/AUTO')).data.statuses;
  const done = sts.find((s) => s.kind === 'done');
  const todo = sts.find((s) => s.kind === 'todo');
  ok(await admin.patch(`/issues/${t1.key}`, { status_id: done.id }));
  assert.equal((await proj('AUTO')).portfolio_status, 'active', 'falta una');
  ok(await admin.patch(`/issues/${t2.key}`, { status_id: done.id }));
  let p = await proj('AUTO');
  assert.equal(p.portfolio_status, 'done');
  assert.equal(p.progress, 100);
  const { one } = await import('../lib/db.js');
  assert.ok(await one(`select 1 as x from notifications where user_id=$1 and title like 'El proyecto AUTO quedó finalizado'`, [U.martin]), 'se avisa al responsable');
  // Se reabre una tarea → vuelve a En curso
  ok(await admin.patch(`/issues/${t2.key}`, { status_id: todo.id }));
  assert.equal((await proj('AUTO')).portfolio_status, 'active');
  // Una tarea nueva en un proyecto finalizado por el sistema también lo reabre
  ok(await admin.patch(`/issues/${t2.key}`, { status_id: done.id }));
  assert.equal((await proj('AUTO')).portfolio_status, 'done');
  ok(await admin.post('/projects/AUTO/issues', { type: 'task', title: 'Tres' }));
  assert.equal((await proj('AUTO')).portfolio_status, 'active');
  // Un Finalizado puesto a mano no se deshace aunque haya tareas abiertas
  ok(await admin.patch('/projects/AUTO', { portfolio_status: 'done' }));
  ok(await admin.post('/projects/AUTO/issues', { type: 'task', title: 'Cuatro' }));
  assert.equal((await proj('AUTO')).portfolio_status, 'done');
  // Un proyecto sin tareas no se finaliza solo
  ok(await admin.post('/projects', { key: 'VAC', name: 'Vacío', lead_id: U.martin }));
  assert.equal((await proj('VAC')).portfolio_status, 'active');
});

test('v1.13.7: una sola vez, los proyectos que ya estaban al 100 % pasan a Finalizado', async () => {
  const { q } = await import('../lib/db.js');
  // Simula un proyecto viejo: todo hecho pero En curso
  await q(`update projects set portfolio_status='active', auto_done=false where key='AUTO'`);
  await q(`update issues set status_id=(select id from project_statuses s where s.project_id=issues.project_id and s.kind='done' limit 1) where project_id=(select id from projects where key='AUTO')`);
  await q(`update projects set portfolio_status='active' where key='AUTO'`);
  await q(`delete from app_settings where key='projects_autodone_backfill'`);
  assert.equal((await proj('AUTO')).portfolio_status, 'done');
  // Si alguien lo vuelve a poner En curso a mano, la lista no lo pisa
  ok(await admin.patch('/projects/AUTO', { portfolio_status: 'active' }));
  assert.equal((await proj('AUTO')).portfolio_status, 'active');
});
