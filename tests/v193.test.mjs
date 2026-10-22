// v1.9.3: convertir un ticket en proyecto exige fechas en cada etapa, origen y sector IT; el proyecto toma
// las fechas de las etapas y calcula las horas (días hábiles × horas por día). Origen y sector IT con ABM.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { businessDays, estimateHours } = await import('../lib/workdays.js');

const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const rejects = (r, re) => { assert.equal(r.status, 400, JSON.stringify(r.data)); if (re) assert.match(r.data.error, re); };
let meta;
const O = {};
const newTicket = async (subject) => (await admin.post('/tickets', { subject, contact_email: 'cobranzas@hanseatica.com' })).data;
const phases = [
  { name: 'Planificación', start_date: '2026-10-19', due_date: '2026-10-21' },
  { name: 'Dictado', start_date: '2026-10-22', due_date: '2026-10-22' },
  { name: 'Evaluación', start_date: '2026-10-23', due_date: '2026-10-30' },
];

test('días hábiles y horas', () => {
  const cfg = { business: { days: [1, 2, 3, 4, 5] }, holidays: [] };
  assert.equal(businessDays('2026-10-19', '2026-10-30', cfg), 10, 'dos semanas de lunes a viernes');
  assert.equal(businessDays('2026-10-17', '2026-10-18', cfg), 0, 'fin de semana');
  assert.equal(businessDays('2026-10-19', '2026-10-30', { ...cfg, holidays: ['2026-10-23'] }), 9, 'descuenta feriados');
  assert.equal(businessDays('2026-10-30', '2026-10-19', cfg), 0);
  assert.equal(estimateHours('2026-10-19', '2026-10-30', cfg), 80, '8 h por día por defecto');
  assert.equal(estimateHours('2026-10-19', '2026-10-30', { ...cfg, portfolio_day_hours: 6 }), 60);
});

test('instalación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  meta = (await admin.get('/meta')).data;
  O.origin = meta.origins[0].id;
  O.sector = meta.sectors[0].id;
});

test('convertir sin origen, sin sector o con etapas sin fechas → 400 y no se crea nada', async () => {
  const t = await newTicket('La batería de la notebook no carga');
  rejects(await admin.post(`/tickets/${t.number}/project`, { key: 'BN', phases, sector_id: O.sector }), /origen/);
  rejects(await admin.post(`/tickets/${t.number}/project`, { key: 'BN', phases, origin_id: O.origin }), /sector/);
  rejects(await admin.post(`/tickets/${t.number}/project`, { key: 'BN', origin_id: O.origin, sector_id: O.sector,
    phases: [{ name: 'Planificación' }, { name: 'Dictado' }, { name: 'Evaluación', due_date: '2026-10-22' }] }), /inicio de la primera etapa \("Planificación"\)/);
  rejects(await admin.post(`/tickets/${t.number}/project`, { key: 'BN', origin_id: O.origin, sector_id: O.sector,
    phases: [{ name: 'Planificación', start_date: '2026-10-19' }, { name: 'Dictado', due_date: '2026-10-20' }, { name: 'Evaluación' }] }), /fin de la última etapa \("Evaluación"\)/);
  rejects(await admin.post(`/tickets/${t.number}/project`, { key: 'BN', origin_id: O.origin, sector_id: O.sector, phases: [{ name: 'Única' }] }), /"Única"/);
  assert.equal((await admin.get('/projects/BN')).status, 404);
});

test('convertir: fechas del proyecto desde las etapas y horas calculadas', async () => {
  const t = await newTicket('La batería de la notebook no carga');
  const r = await admin.post(`/tickets/${t.number}/project`, { key: 'BN', name: 'La Batería Notebook', origin_id: O.origin, sector_id: O.sector, phases,
    start_date: '2026-01-01', end_date: '2027-12-31' }); // lo que venga del proyecto no manda: se toman las etapas
  ok(r);
  const p = (await admin.get('/projects/BN')).data.project;
  assert.equal(String(p.start_date).slice(0, 10) === '2026-10-19' || new Date(p.start_date).toISOString().slice(0, 10) === '2026-10-19', true, 'primer inicio');
  const end = p.end_date instanceof Date ? p.end_date.toISOString() : String(p.end_date);
  assert.equal(end.slice(0, 10), '2026-10-30', 'último fin');
  assert.equal(Number(p.estimated_hours), 80, '10 días hábiles × 8 h');
  assert.equal(p.origin_id, O.origin);
  assert.equal(p.sector_id, O.sector);
});

test('convertir: alcanza con el inicio de la primera etapa y el fin de la última (las del medio se reparten)', async () => {
  const t = await newTicket('La Batería Notebook');
  ok(await admin.post(`/tickets/${t.number}/project`, { key: 'BAT', origin_id: O.origin, sector_id: O.sector,
    phases: [{ name: 'Planificación', start_date: '2026-10-19' }, { name: 'Dictado' }, { name: 'Evaluación', due_date: '2026-10-27' }] }));
  const pj = (await admin.get('/projects/BAT')).data;
  const d = (x) => (x instanceof Date ? x.toISOString() : String(x)).slice(0, 10);
  assert.deepEqual(pj.epics.map((e) => [d(e.start_date), d(e.due_date)]), [['2026-10-19', '2026-10-21'], ['2026-10-22', '2026-10-24'], ['2026-10-25', '2026-10-27']]);
  assert.equal(d(pj.project.start_date), '2026-10-19');
  assert.equal(d(pj.project.end_date), '2026-10-27');
  assert.equal(Number(pj.project.estimated_hours), 56, '7 días hábiles × 8 h');
});

test('convertir: respeta las horas cargadas, las horas por día configuradas y los feriados', async () => {
  const t1 = await newTicket('Otro pedido');
  ok(await admin.post(`/tickets/${t1.number}/project`, { key: 'BN2', origin_id: O.origin, sector_id: O.sector, phases, estimated_hours: 35 }));
  assert.equal(Number((await admin.get('/projects/BN2')).data.project.estimated_hours), 35);
  ok(await admin.put('/admin/settings/helpdesk', { portfolio_day_hours: 4, holidays: ['2026-10-23'] }));
  assert.equal((await admin.get('/meta')).data.helpdesk.portfolio_day_hours, 4, 'llega a la app para calcular en el formulario');
  const t2 = await newTicket('Un pedido más');
  ok(await admin.post(`/tickets/${t2.number}/project`, { key: 'BN3', origin_id: O.origin, sector_id: O.sector, phases }));
  assert.equal(Number((await admin.get('/projects/BN3')).data.project.estimated_hours), 36, '9 días hábiles × 4 h');
  rejects(await admin.put('/admin/settings/helpdesk', { portfolio_day_hours: 30 }));
});

test('el alta manual de proyectos no exige origen ni sector', async () => {
  ok(await admin.post('/projects', { key: 'LIBRE', name: 'Sin datos de portfolio', phases: [{ name: 'Única' }] }));
});

test('ABM de origen y sector IT', async () => {
  const add = await admin.post('/admin/portfolio-options', { kind: 'origin', name: 'Normativa SSN', color: '#0891b2', sort: 99 });
  ok(add);
  const id = add.data.id;
  ok(await admin.patch(`/admin/portfolio-options/${id}`, { name: 'Normativa SSN 2027' }));
  let usage = (await admin.get('/admin/portfolio-options/usage')).data;
  assert.equal(usage[id], 0);
  assert.ok(usage[O.origin] >= 3, 'cuenta los proyectos que lo usan');
  rejects(await admin.del(`/admin/portfolio-options/${O.origin}`), /desactivalo/);
  ok(await admin.patch(`/admin/portfolio-options/${O.origin}`, { active: false }), 'en uso: se desactiva');
  assert.equal((await admin.get('/meta')).data.origins.find((o) => o.id === O.origin).active, false);
  ok(await admin.del(`/admin/portfolio-options/${id}`), 'sin uso: se elimina');
  usage = (await admin.get('/admin/portfolio-options/usage')).data;
  assert.equal(usage[id], undefined);
  const agent = makeClient();
  assert.equal((await agent.get('/admin/portfolio-options/usage')).status, 401);
});
