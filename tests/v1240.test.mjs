// v1.24: lo que se carga en el alta de un proyecto (o al convertir un ticket) se crea como tareas en Standby, no como
// etapas. Roadmap, Portfolio, avance y ciclo con el ticket siguen funcionando con las tareas.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { projectSummary } = await import('../lib/routes/projects.js');
const { one } = await import('../lib/db.js');
const admin = makeClient();
const sup = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let lead;

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: process.env.SUPERADMIN_PASSWORD }));
  lead = (await admin.get('/meta')).data.users.find((u) => /Tamburrini/.test(u.name)).id;
});

test('alta de proyecto: los renglones quedan como tareas en Standby, con fechas y el responsable', async () => {
  ok(await admin.post('/projects', { key: 'RA', name: 'REASEGUROS - Administración', template: 'dev', lead_id: lead, phases: [
    { name: 'Relevamiento y análisis', start_date: '2026-05-11', due_date: '2026-05-23' }, { name: 'Desarrollo' }, { name: 'Testing' },
    { name: 'Implementación', due_date: '2026-07-01' }] }));
  const pj = (await admin.get('/projects/RA')).data;
  assert.equal(pj.epics.length, 0, 'no se crean etapas');
  const tasks = (await admin.get('/projects/RA/issues')).data.filter((i) => i.type === 'task');
  assert.deepEqual(tasks.map((t) => t.title), ['Relevamiento y análisis', 'Desarrollo', 'Testing', 'Implementación']);
  assert.ok(tasks.every((t) => t.task_state === 'standby' && t.assignee_id === lead));
  assert.ok(tasks.every((t) => t.start_date && t.due_date), 'las del medio reciben fechas repartidas');
  assert.equal(pj.portfolio.start, '2026-05-11', 'el proyecto toma el inicio de la primera tarea');
  assert.equal(pj.portfolio.end, '2026-07-01', 'y el fin de la última');
});

test('el Portfolio y el Roadmap usan las tareas: avance por promedio', async () => {
  const tasks = (await admin.get('/projects/RA/issues')).data.filter((i) => i.type === 'task');
  ok(await admin.patch(`/issues/${tasks[0].key}`, { task_state: 'done' }));
  ok(await admin.patch(`/issues/${tasks[1].key}`, { progress: 50 }));
  const row = (await sup.get('/portfolio')).data.rows.find((p) => p.key === 'RA');
  assert.equal(row.phases.length, 4, 'las tareas ocupan el lugar de las etapas');
  assert.ok(row.phases.every((f) => f.is_task));
  assert.equal(row.progress, Math.round((100 + 50) / 4));
  const pj = (await admin.get('/projects/RA')).data;
  assert.ok(pj.portfolio.phases.every((f) => f.is_task), 'el Roadmap del proyecto recibe las tareas');
});

test('ciclo con el ticket: en curso cuando una tarea avanza; la "etapa actual" es la tarea en curso más adelantada', async () => {
  const p = await one(`select id from projects where key='RA'`);
  let s = await projectSummary(p.id);
  assert.equal(s.current.title, 'Desarrollo');
  const tasks = (await admin.get('/projects/RA/issues')).data.filter((i) => i.type === 'task');
  ok(await admin.patch(`/issues/${tasks[2].key}`, { task_state: 'in_progress' }));
  s = await projectSummary(p.id);
  assert.equal(s.current.title, 'Testing', 'las reglas de etapa con nombre "Testing" se aplican cuando esa tarea entra en curso');
  assert.equal(s.finished, false);
});

test('convertir un ticket en proyecto también crea tareas en Standby', async () => {
  const meta = (await admin.get('/meta')).data;
  const t = await admin.post('/tickets', { subject: 'Nuevo reporte de reaseguros', contact_email: 'u@hanseatica.com' });
  const num = t.data.number ?? t.data.ticket?.number;
  const opts = (await sup.get('/portfolio')).data.options || {};
  const origin = (opts.origins || opts.origin || [])[0]?.id;
  const sector = (opts.sectors || opts.sector || [])[0]?.id;
  const r = await admin.post(`/tickets/${num}/project`, { key: 'RR', type_id: meta.projectTypes[0].id, origin_id: origin, sector_id: sector,
    phases: [{ name: 'Relevamiento', start_date: '2026-11-10' }, { name: 'Desarrollo', due_date: '2026-12-15' }] });
  ok(r);
  const pj = (await admin.get('/projects/RR')).data;
  assert.equal(pj.epics.length, 0);
  const tasks = (await admin.get('/projects/RR/issues')).data.filter((i) => i.type === 'task');
  assert.deepEqual(tasks.map((x) => [x.title, x.task_state]), [['Relevamiento', 'standby'], ['Desarrollo', 'standby']]);
});

test('por la API todavía se pueden pedir etapas', async () => {
  ok(await admin.post('/projects', { key: 'EP', name: 'Con etapas', template: 'dev', phase_kind: 'epic', phases: [{ name: 'Uno' }] }));
  assert.equal((await admin.get('/projects/EP')).data.epics.length, 1);
});
