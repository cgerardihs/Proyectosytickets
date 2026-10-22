// v1.9.2: ninguna fecha de fin puede ser anterior a su inicio (proyecto, etapas, tareas y sprints).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { phaseDateProblem } = await import('../lib/routes/projects.js');

const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const rejects = (r, re) => { assert.equal(r.status, 400, JSON.stringify(r.data)); if (re) assert.match(r.data.error, re); };
let typeId;

test('instalación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  typeId = (await admin.get('/meta')).data.projectTypes[0].id;
});

test('reglas de las etapas', () => {
  assert.equal(phaseDateProblem([{ name: 'A', start_date: '2026-10-01', due_date: '2026-10-10' }, { name: 'B', start_date: '2026-10-11', due_date: '2026-10-20' }]), null);
  assert.match(phaseDateProblem([{ name: 'A', start_date: '2026-10-10', due_date: '2026-10-01' }]), /"A" termina \(01\/10\/2026\) antes de empezar/);
  // Caso real: la primera empieza el 26/10 y la última termina el 16/10
  assert.match(phaseDateProblem([{ name: 'Relevamiento', start_date: '2026-10-26' }, { name: 'Desarrollo' }, { name: 'Implementación', due_date: '2026-10-16' }]),
    /"Implementación" termina \(16\/10\/2026\) antes de que empiece "Relevamiento"/);
  // Etapas que se superponen están permitidas
  assert.equal(phaseDateProblem([{ name: 'A', start_date: '2026-10-01', due_date: '2026-10-20' }, { name: 'B', start_date: '2026-10-10', due_date: '2026-10-15' }]), null);
});

test('crear proyecto: fechas de etapas cruzadas → 400 y no se crea nada', async () => {
  const phases = [{ name: 'Relevamiento y análisis', start_date: '2026-10-26' }, { name: 'Desarrollo' }, { name: 'Testing' }, { name: 'Implementación', due_date: '2026-10-16' }];
  rejects(await admin.post('/projects', { key: 'BCC', name: 'BOT correo cobranzas', type_id: typeId, phases }), /Implementación/);
  assert.equal((await admin.get('/projects/BCC')).status, 404);
  rejects(await admin.post('/projects', { key: 'BCC', name: 'x', type_id: typeId, phases: [{ name: 'A', start_date: '2026-11-10', due_date: '2026-11-01' }] }), /termina/);
  rejects(await admin.post('/projects', { key: 'BCC', name: 'x', type_id: typeId, start_date: '2026-11-10', end_date: '2026-11-01' }), /anterior al inicio/);
  // Fin del proyecto anterior al inicio cargado a mano en la primera etapa
  rejects(await admin.post('/projects', { key: 'BCC', name: 'x', type_id: typeId, end_date: '2026-10-20', phases: [{ name: 'A', start_date: '2026-11-01' }, { name: 'B' }] }), /fechas de inicio y fin del proyecto/);
  ok(await admin.post('/projects', { key: 'BCC', name: 'BOT correo cobranzas', type_id: typeId, start_date: '2026-10-26', end_date: '2026-12-18', phases: [{ name: 'Relevamiento' }, { name: 'Desarrollo' }, { name: 'Implementación' }] }));
});

test('tareas y etapas: el vencimiento no puede ser anterior al inicio', async () => {
  rejects(await admin.post('/projects/BCC/issues', { title: 'Mal', type: 'task', start_date: '2026-11-10', due_date: '2026-11-01' }), /anterior a la de inicio/);
  const t = (await admin.post('/projects/BCC/issues', { title: 'Bien', type: 'task', start_date: '2026-11-01', due_date: '2026-11-10' })).data;
  rejects(await admin.patch(`/issues/${t.key}`, { due_date: '2026-10-30' }), /30\/10\/2026/);
  rejects(await admin.patch(`/issues/${t.key}`, { start_date: '2026-11-20' }));
  ok(await admin.patch(`/issues/${t.key}`, { start_date: '2026-11-20', due_date: '2026-11-25' }), 'las dos juntas');
  ok(await admin.patch(`/issues/${t.key}`, { start_date: null }), 'sin inicio');
});

test('sprints: no terminan antes de empezar', async () => {
  rejects(await admin.post('/projects/BCC/sprints', { start_date: '2026-11-10', end_date: '2026-11-01' }), /sprint/);
  const s = (await admin.post('/projects/BCC/sprints', { start_date: '2026-11-01', end_date: '2026-11-14' })).data;
  rejects(await admin.patch(`/sprints/${s.id}`, { end_date: '2026-10-20' }));
  rejects(await admin.post(`/sprints/${s.id}/start`, { start_date: '2026-11-20', end_date: '2026-11-14' }), /sprint/);
  ok(await admin.post(`/sprints/${s.id}/start`, { start_date: '2026-11-01', end_date: '2026-11-14' }));
});

test('datos viejos con fechas cruzadas no traban otras ediciones; renombrar un sprint no corre sus fechas', async () => {
  const { q, one } = await import('../lib/db.js');
  const t = (await admin.post('/projects/BCC/issues', { title: 'Vieja', type: 'task' })).data;
  await q(`update issues set start_date='2026-11-10', due_date='2026-11-01' where id=$1`, [t.id]);
  ok(await admin.patch(`/issues/${t.key}`, { title: 'Vieja renombrada' }), 'sin tocar fechas');
  rejects(await admin.patch(`/issues/${t.key}`, { due_date: '2026-11-02' }));
  const s = (await admin.post('/projects/BCC/sprints', { start_date: '2026-12-01', end_date: '2026-12-14' })).data;
  ok(await admin.patch(`/sprints/${s.id}`, { name: 'Renombrado' }));
  const row = await one('select start_date, end_date from sprints where id=$1', [s.id]);
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  assert.deepEqual([iso(row.start_date), iso(row.end_date)], ['2026-12-01', '2026-12-14']);
});
