// v1.22: Informes → Horas "calculado" (proyectos por estimación, operación por rutinas, tickets resueltos por tiempo
// típico o registrado), tiempo de resolución de tickets y filtros.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { businessMinutesBetween } = await import('../lib/sla.js');
const { opsCalendar, addDays } = await import('../lib/ops.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let jm;
let fh;
let today;
let soporte;
const sumBy = (d, uid, src) => d.entries.filter((e) => e.user_id === uid && (!src || e.source === src)).reduce((t, e) => t + e.minutes, 0);

test('minutos laborales entre dos fechas (horario 9 a 18, lunes a viernes)', () => {
  const cfg = { timezone: 'America/Argentina/Buenos_Aires', business: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, holidays: ['2026-11-04'] };
  assert.equal(businessMinutesBetween('2026-11-02T12:00:00Z', '2026-11-02T15:00:00Z', cfg), 180, 'lunes de 9 a 12 hs');
  assert.equal(businessMinutesBetween('2026-11-06T20:00:00Z', '2026-11-09T13:00:00Z', cfg), 60 + 60, 'viernes 17 hs a lunes 10 hs: fin de semana no cuenta');
  assert.equal(businessMinutesBetween('2026-11-03T21:00:00Z', '2026-11-05T13:00:00Z', cfg), 60, 'el feriado del miércoles no cuenta');
});

test('preparación: proyectos con horas estimadas, una rutina y tickets resueltos', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const meta = (await admin.get('/meta')).data;
  jm = meta.users.find((u) => /Juan Manuel/.test(u.name)).id;
  fh = meta.users.find((u) => /Horta/.test(u.name)).id;
  soporte = meta.techCategories.find((c) => /^soporte/i.test(c.name));
  today = (await opsCalendar()).today;
  const month = today.slice(0, 7);
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  // 120 h en el mes entero, de Juan Manuel; y 60 h compartidas con Fernando (tiene una tarea asignada)
  ok(await admin.post('/projects', { key: 'CRM', name: 'CRM Comercial', lead_id: jm, start_date: `${month}-01`, end_date: last, estimated_hours: 120 }));
  ok(await admin.post('/projects', { key: 'SPMC', name: 'Comisiones', lead_id: jm, start_date: `${month}-01`, end_date: last, estimated_hours: 60 }));
  ok(await admin.post('/projects/SPMC/issues', { type: 'task', title: 'Relevar', assignee_id: fh }));
  ok(await admin.post('/projects', { key: 'OLD', name: 'Terminado', lead_id: jm, start_date: `${month}-01`, end_date: last, estimated_hours: 500 }));
  ok(await admin.patch('/projects/OLD', { portfolio_status: 'done' }));
  // Rutina mensual de 2 h de Fernando
  ok(await admin.post('/ops/routines', { name: 'Backup mensual', assignee_ids: [fh], est_minutes: 120, rule: { freq: 'once', date: today } }));
  // Tickets de Juan Manuel resueltos hoy: uno de Soporte (típico 45 min) y otro con 90 min registrados
  ok(await admin.patch(`/admin/tech-categories/${soporte.id}`, { std_minutes: 45 }));
  const st = (await admin.get('/meta')).data.statuses.find((s) => s.kind === 'resolved');
  for (const [s, logged] of [['Impresora', 0], ['VPN', 90]]) {
    const t = await admin.post('/tickets', { subject: s, contact_email: 'u@hanseatica.com', assignee_id: jm, tech_category_id: soporte.id });
    const n = t.data.number ?? t.data.ticket?.number;
    if (logged) ok(await admin.post(`/tickets/${n}/time`, { minutes: logged, spent_on: '2020-01-01' }));
    await q(`update tickets set created_at = now() - interval '3 days' where number=$1`, [n]);
    ok(await admin.patch(`/tickets/${n}`, { status_id: st.id }));
  }
  // Uno sin resolver no suma
  ok(await admin.post('/tickets', { subject: 'Abierto', contact_email: 'u@hanseatica.com', assignee_id: jm, tech_category_id: soporte.id }));
});

test('calculado del mes: proyectos con el reparto del Portfolio, operación y tickets resueltos', async () => {
  const d = (await admin.get(`/reports/hours?period=month&mode=calc&date=${today}`)).data;
  assert.equal(d.mode, 'calc');
  // Juan Manuel: 120 h de CRM + la mitad de 60 h de SPMC = 150 h; el proyecto terminado no carga
  assert.ok(Math.abs(sumBy(d, jm, 'P') / 60 - 150) < 0.5, `proyectos de JM: ${sumBy(d, jm, 'P') / 60}`);
  assert.ok(Math.abs(sumBy(d, fh, 'P') / 60 - 30) < 0.5, 'Fernando tiene la otra mitad de SPMC por su tarea');
  assert.equal(sumBy(d, fh, 'O'), 120, 'la rutina planificada');
  assert.equal(sumBy(d, jm, 'T'), 45 + 90, 'un ticket por tiempo típico y otro por lo registrado');
  assert.ok(d.entries.some((e) => e.source === 'T' && /típico de Soporte/.test(e.how)));
  // Tiempo de resolución: dos tickets de Juan Manuel, en horas laborales (no días corridos)
  const r = d.resolution.filter((x) => x.user_id === jm);
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.minutes > 0 && x.minutes <= 4 * 9 * 60), 'no más de 3 días hábiles de 9 h');
});

test('filtros: persona, origen, proyecto y categoría técnica', async () => {
  let d = (await admin.get(`/reports/hours?period=month&mode=calc&date=${today}&user=${fh}`)).data;
  assert.deepEqual(d.people.map((p) => p.id), [fh]);
  assert.ok(d.entries.every((e) => e.user_id === fh));
  d = (await admin.get(`/reports/hours?period=month&mode=calc&date=${today}&source=T`)).data;
  assert.ok(d.entries.length && d.entries.every((e) => e.source === 'T'));
  const spmc = (await one(`select id from projects where key='SPMC'`)).id;
  d = (await admin.get(`/reports/hours?period=month&mode=calc&date=${today}&project=${spmc}`)).data;
  assert.ok(d.entries.length && d.entries.every((e) => /^SPMC /.test(e.label)));
  d = (await admin.get(`/reports/hours?period=month&mode=calc&date=${today}&tech=${soporte.id}`)).data;
  assert.ok(d.entries.length && d.entries.every((e) => e.source === 'T'), 'la categoría técnica deja solo tickets');
});

test('registrado sigue mostrando solo lo cargado a mano, con los mismos filtros', async () => {
  const d = (await admin.get(`/reports/hours?period=month&mode=real&date=${today}&source=O`)).data;
  assert.equal(d.mode, 'real');
  assert.equal(d.entries.length, 0, 'la rutina no se registró como hecha');
  ok(await admin.get(`/reports/hours?period=week&mode=real&user=${jm}`));
  assert.equal((await admin.get(`/reports/hours?period=week&date=${addDays(today, -400)}`)).status, 200);
});
