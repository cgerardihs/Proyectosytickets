// v1.26: columnas de la lista de proyectos (cuáles, orden y ancho por agente) y datos extra de cada proyecto.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { normalizeColumns, columnsFor, PROJECT_COLUMNS } = await import('../lib/view-prefs.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

test('normalización para proyectos: solo columnas de proyectos y "Proyecto" siempre visible', () => {
  const c = normalizeColumns({ order: ['origin', 'subject'], on: ['origin', 'subject'], w: { origin: 30, subject: 200 } }, columnsFor('projects'));
  assert.deepEqual(c.on, ['name', 'origin'], 'subject es de tickets: no vale');
  assert.equal(c.order.length, PROJECT_COLUMNS.length);
  assert.deepEqual(c.w, { origin: 60 });
});

test('preparación y datos nuevos de la lista: origen, fechas reales, salud, horas y tarea actual', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const meta = (await admin.get('/meta')).data;
  const origin = meta.origins?.[0]?.id;
  ok(await admin.post('/projects', { key: 'APF', name: 'Automatización de proceso financiero', template: 'dev', origin_id: origin,
    phases: [{ name: 'Relevamiento', start_date: '2026-11-02' }, { name: 'Desarrollo', due_date: '2026-12-01' }] }));
  const tasks = (await admin.get('/projects/APF/issues')).data.filter((i) => i.type === 'task');
  ok(await admin.patch(`/issues/${tasks[0].key}`, { task_state: 'in_progress' }));
  const p = (await admin.get('/projects')).data.find((x) => x.key === 'APF');
  if (origin) assert.equal(p.origin_id, origin);
  assert.equal(p.p_start, '2026-11-02');
  assert.equal(p.p_end, '2026-12-01');
  assert.ok(['ok', 'risk', 'late', 'none', 'done'].includes(p.health));
  assert.equal(p.current_phase, 'Relevamiento');
  assert.equal(typeof p.logged_hours, 'number');
});

test('las columnas de la lista de proyectos se guardan por agente, aparte de las de tickets', async () => {
  ok(await admin.put('/me/view-prefs/projects', { on: ['name', 'origin', 'progress'], order: ['name', 'origin', 'progress'], w: { name: 400 } }));
  ok(await admin.put('/me/view-prefs/all', { on: ['subject', 'version'] }));
  const vp = (await admin.get('/meta')).data.viewPrefs;
  assert.deepEqual(vp.projects.on, ['name', 'origin', 'progress']);
  assert.equal(vp.projects.w.name, 400);
  assert.deepEqual(vp.all.on, ['subject', 'version']);
  ok(await admin.del('/me/view-prefs/projects'));
  assert.equal((await admin.get('/meta')).data.viewPrefs.projects, undefined);
});
