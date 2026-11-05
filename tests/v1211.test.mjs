// v1.21.1: la agenda de Operación mira hacia adelante lo que elige cada agente (2 semanas, 30, 60 o 90 días).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { opsCalendar, addDays } = await import('../lib/ops.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let today;
let me;
const all = (a) => [...a.groups.late, ...a.groups.today, ...a.groups.week, ...a.groups.next].map((i) => i.name);

test('preparación: una tarea dentro de 25 días y otra dentro de 70', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  me = (await admin.get('/meta')).data.me.id;
  today = (await opsCalendar()).today;
  ok(await admin.post('/ops/routines', { name: 'Capacitaciones Seguridad', category: 'Capacitación', assignee_ids: [me], rule: { freq: 'once', date: addDays(today, 25) } }));
  ok(await admin.post('/ops/routines', { name: 'Renovar licencias', category: 'Licencias', assignee_ids: [me], rule: { freq: 'once', date: addDays(today, 70) } }));
});

test('de entrada mira 30 días', async () => {
  const a = (await admin.get('/ops/agenda')).data;
  assert.equal(a.days, 30);
  assert.equal(a.horizon, addDays(today, 30));
  assert.deepEqual(all(a), ['Capacitaciones Seguridad']);
});

test('con 2 semanas no hay nada y avisa cuál es la próxima', async () => {
  const a = (await admin.get('/ops/agenda?days=14')).data;
  assert.deepEqual(all(a), []);
  assert.equal(a.next_beyond.name, 'Capacitaciones Seguridad');
  assert.equal(a.next_beyond.date, addDays(today, 25));
  const f = (await admin.get('/ops/agenda?days=14&category=Licencias')).data;
  assert.equal(f.next_beyond.name, 'Renovar licencias', 'respeta los filtros');
});

test('con 90 días aparecen las dos; el período se acota entre 7 y 120 días', async () => {
  assert.deepEqual(all((await admin.get('/ops/agenda?days=90')).data), ['Capacitaciones Seguridad', 'Renovar licencias']);
  assert.equal((await admin.get('/ops/agenda?days=999')).data.days, 120);
  assert.equal((await admin.get('/ops/agenda?days=1')).data.days, 7);
});
