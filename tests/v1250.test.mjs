// v1.25: Informes → Comparativa (ingresados, cerrados, abiertos al cierre, tiempo de resolución, por mes y por dimensión).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const { shiftMonth } = await import('../lib/compare.js');
const admin = makeClient();
const agente = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let ids;
let cur;
let prev;
const at = (month, day, hour = 13) => `${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

test('preparación: tickets con fechas de creación y cierre controladas', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const meta = (await admin.get('/meta')).data;
  ids = { jm: meta.users.find((u) => /Juan Manuel/.test(u.name)).id, mt: meta.users.find((u) => /Tamburrini/.test(u.name)).id, area: meta.categories[0].id, soporte: meta.techCategories.find((c) => /^soporte/i.test(c.name)).id };
  const today = (await admin.get('/ops/agenda')).data.today;
  cur = today.slice(0, 7);
  prev = shiftMonth(cur, -1);
  // Mes anterior: 3 ingresados (2 de Juan Manuel, 1 de Martín); 1 se cierra ese mes (2 días hábiles después) y 1 se cierra este mes
  // Este mes: 2 ingresados de Juan Manuel, ninguno cerrado. Uno en spam y uno combinado no cuentan.
  const mk = async (subject, assignee, created, solved, extra = {}) => {
    const r = await admin.post('/tickets', { subject, contact_email: `${subject.toLowerCase().replace(/\W+/g, '')}@hanseatica.com`, assignee_id: assignee, category_id: ids.area, tech_category_id: ids.soporte });
    ok(r);
    const n = r.data.number ?? r.data.ticket?.number;
    await q('update tickets set created_at=$2, resolved_at=$3, spam=$4, merged_into=$5 where number=$1', [n, created, solved, Boolean(extra.spam), extra.merged || null]);
    return n;
  };
  await mk('Uno', ids.jm, at(prev, 2), at(prev, 6));
  await mk('Dos', ids.jm, at(prev, 9), at(cur, 1));
  await mk('Tres', ids.mt, at(prev, 10), null);
  await mk('Cuatro', ids.jm, at(cur, 1), null);
  await mk('Cinco', ids.jm, at(cur, 1), null);
  await mk('Spam', ids.jm, at(cur, 1), null, { spam: true });
  await mk('Combinado', ids.jm, at(cur, 1), null, { merged: 1 });
});

test('serie mensual: ingresados, cerrados y abiertos al cierre', async () => {
  const r = await admin.get('/reports/compare?range=12&dim=agent');
  ok(r);
  const d = r.data;
  assert.equal(d.months.length, 12);
  assert.equal(d.months.at(-1), cur);
  const i = d.all.indexOf(cur);
  const p = d.all.indexOf(prev);
  assert.deepEqual([d.series.in[p], d.series.out[p], d.series.open[p]], [3, 1, 2], 'mes anterior');
  assert.deepEqual([d.series.in[i], d.series.out[i], d.series.open[i]], [2, 1, 3], 'este mes: spam y combinado no cuentan');
  assert.ok(d.series.ttr_n[p] === 1 && d.series.ttr_sum[p] > 0, 'tiempo de resolución en horas laborales');
});

test('detalle por agente y por área; filtros', async () => {
  let d = (await admin.get('/reports/compare?range=12&dim=agent')).data;
  const p = d.all.indexOf(prev);
  const jm = d.rows.find((r) => r.key === String(ids.jm));
  assert.equal(jm.name, 'Juan Manuel Torres');
  assert.equal(jm.in[p], 2);
  assert.equal(d.rows.find((r) => r.key === String(ids.mt)).in[p], 1);
  d = (await admin.get('/reports/compare?range=12&dim=area')).data;
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].in[p], 3);
  d = (await admin.get(`/reports/compare?range=12&dim=user&agent=${ids.mt}`)).data;
  assert.equal(d.series.in[p], 1, 'filtrado por agente');
  assert.equal(d.rows.length, 1);
  d = (await admin.get('/reports/compare?range=all&dim=prio')).data;
  assert.equal(d.rows[0].name, 'Baja');
});

test('solo supervisores y administradores', async () => {
  ok(await admin.post('/admin/users', { name: 'Agente Comp', email: 'comp.agente@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await agente.post('/auth/login', { email: 'comp.agente@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  assert.equal((await agente.get('/reports/compare')).status, 403);
});
