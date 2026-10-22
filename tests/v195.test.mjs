// v1.9.5: Kanban con tres estados (y migración de los proyectos Kanban existentes), etapas en el tablero
// e ingreso solo con usuario y clave o con Microsoft (passkeys apagadas).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
delete process.env.PASSKEYS_ENABLED;
const { makeClient } = await import('./helpers.mjs');
const { q, one, tx } = await import('../lib/db.js');
const { MIGRATIONS } = await import('../lib/migrations.js');

const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let meta;

test('instalación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  meta = (await admin.get('/meta')).data;
});

test('un proyecto Kanban nuevo tiene Pendiente, En curso y Hecho', async () => {
  ok(await admin.post('/projects', { key: 'KAN', name: 'Kanban nuevo', template: 'kanban', type_id: meta.projectTypes[0].id }));
  const pj = (await admin.get('/projects/KAN')).data;
  assert.deepEqual(pj.statuses.map((s) => [s.name, s.kind]), [['Pendiente', 'todo'], ['En curso', 'doing'], ['Hecho', 'done']]);
});

test('migración 14: los Kanban de cuatro estados pasan a tres y lo "Seleccionado" vuelve a Pendiente', async () => {
  ok(await admin.post('/projects', { key: 'VIEJO', name: 'Kanban viejo', template: 'kanban' }));
  ok(await admin.post('/projects', { key: 'TOCADO', name: 'Kanban personalizado', template: 'kanban' }));
  const ids = {};
  for (const k of ['VIEJO', 'TOCADO']) {
    ids[k] = (await one('select id from projects where key=$1', [k])).id;
    // Estado como en las versiones anteriores
    await q(`update project_statuses set sort=sort+1 where project_id=$1 and name<>'Pendiente'`, [ids[k]]);
    await q(`insert into project_statuses(project_id,name,kind,sort) values ($1,'Seleccionado','todo',1)`, [ids[k]]);
  }
  await q(`update project_statuses set name='En desarrollo' where project_id=$1 and name='En curso'`, [ids.TOCADO]);
  const sel = (await one(`select id from project_statuses where project_id=$1 and name='Seleccionado'`, [ids.VIEJO])).id;
  const t = (await admin.post('/projects/VIEJO/issues', { title: 'Elegida para hacer', type: 'task', status_id: sel })).data;
  assert.equal(t.status_id, sel);

  const m14 = MIGRATIONS.find((m) => m.version === 14);
  const run = () => tx(async () => { for (const s of m14.statements) await q(s); });
  await run();
  await run(); // idempotente

  const names = async (id) => (await q('select name from project_statuses where project_id=$1 order by sort, id', [id])).map((x) => x.name);
  assert.deepEqual(await names(ids.VIEJO), ['Pendiente', 'En curso', 'Hecho']);
  assert.deepEqual(await names(ids.TOCADO), ['Pendiente', 'Seleccionado', 'En desarrollo', 'Hecho'], 'los flujos personalizados no se tocan');
  const after = (await admin.get(`/issues/${t.key}`)).data;
  assert.equal((after.issue || after).status_name, 'Pendiente');
});

test('tablero: las etapas vienen con su avance', async () => {
  ok(await admin.post('/projects', { key: 'CAPA', name: 'Capacitación', type_id: meta.projectTypes.find((x) => x.name === 'Capacitación').id }));
  const pj = (await admin.get('/projects/CAPA')).data;
  ok(await admin.patch(`/issues/${pj.epics[0].key}`, { progress: 40 }));
  const phases = (await admin.get('/projects/CAPA/issues?type=epic')).data;
  assert.equal(phases.length, pj.epics.length);
  assert.equal(phases.find((e) => e.id === pj.epics[0].id).progress, 40);
  // Mover una etapa en el tablero solo cambia su estado
  const doing = pj.statuses.find((s) => s.kind === 'doing');
  ok(await admin.post('/issues/reorder', { moved_id: pj.epics[1].id, status_id: doing.id, order: [] }));
  assert.equal((await admin.get('/projects/CAPA/issues?type=epic')).data.find((e) => e.id === pj.epics[1].id).status_id, doing.id);
});

test('ingreso: sin passkeys (solo usuario y clave o Microsoft)', async () => {
  const anon = makeClient();
  const me = (await anon.get('/auth/me')).data;
  assert.equal(me.passkeys, false);
  assert.equal((await anon.post('/auth/passkeys/login/options', {})).status, 403);
  assert.equal((await admin.post('/auth/passkeys/register/options', {})).status, 403);
  assert.equal((await admin.get('/auth/me')).data.passkeys, false);
  ok(await anon.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }), 'usuario y clave');
});
