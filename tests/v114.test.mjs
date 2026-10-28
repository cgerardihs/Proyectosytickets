// v1.14: Informes con roadmap de todos los proyectos, calendario con capas y explorador de datos con vistas guardadas.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { teamLoad } = await import('../lib/routes/reports-plus.js');
const admin = makeClient();
const agent = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const today = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const U = {};

test('preparación: proyectos con etapas y tareas, tickets con SLA', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' });
  let r = await admin.post('/admin/users', { name: 'Matias Ayala', email: 'matias@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' });
  U.matias = r.data.id ?? r.data.user?.id;
  ok(await agent.post('/auth/login', { email: 'matias@hanseatica.com', password: 'Rio-de-la-Plata-9' }), 'login agente');
  ok(await admin.post('/projects', { key: 'MC', name: 'Migración de certificados', lead_id: U.matias, start_date: plus(-10), end_date: plus(30), phases: [{ name: 'Análisis', start_date: plus(-10), due_date: plus(2) }, { name: 'Desarrollo', start_date: plus(3), due_date: plus(30) }] }));
  ok(await admin.post('/projects/MC/issues', { type: 'task', title: 'Firmar PDF', assignee_id: U.matias, start_date: today, due_date: plus(9) }));
  ok(await admin.post('/projects/MC/issues', { type: 'task', title: 'Casos de prueba', assignee_id: U.matias, due_date: plus(1) }));
  ok(await makeClient().post('/portal/tickets', { name: 'Ana Ruiz', email: 'aruiz@hanseatica.com', subject: 'Equis anda lento', body_text: 'Muy lento desde temprano' }), 'ticket');
});

test('roadmap: todos los proyectos con etapas, fin planificado (desvío) y carga del equipo', async () => {
  // Se corre el fin: la fecha planificada queda como línea base
  ok(await admin.patch('/projects/MC', { end_date: plus(40) }));
  const r = await admin.get('/reports/roadmap');
  ok(r);
  const p = r.data.rows.find((x) => x.key === 'MC');
  assert.equal(p.baseline_end, plus(30));
  assert.equal(p.end, plus(40));
  assert.equal(p.phases.length, 2);
  const mine = r.data.load.users.find((x) => x.id === U.matias);
  assert.ok(mine.counts[0] >= 2, 'las dos tareas abiertas cuentan esta semana');
  assert.equal(r.data.load.weeks.length, 12);
  assert.equal((await agent.get('/reports/roadmap')).status, 403, 'solo supervisores');
});

test('carga: una tarea cuenta en cada semana que abarca', async () => {
  const l = await teamLoad(today, 4);
  const mine = l.users.find((x) => x.id === U.matias);
  assert.ok(mine.counts[1] >= 1, 'la de 9 días sigue la semana que viene');
});

test('calendario: capas de proyectos, etapas, tareas, SLA, sistemas críticos y feriados', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { holidays: [plus(5)] }));
  await q(`update tickets set resolution_due = now() + interval '1 day' where subject='Equis anda lento'`);
  const sys = await admin.post('/admin/critical-systems', { name: 'Equis' });
  ok(sys);
  ok(await admin.post(`/critical-systems/${sys.data.id}/status`, { state: 'down', eta: new Date(Date.now() + 3 * 3600e3).toISOString() }));
  const r = await admin.get(`/reports/calendar?from=${plus(-15)}&to=${plus(45)}`);
  ok(r);
  const layers = new Set(r.data.events.map((e) => e.layer));
  for (const l of ['project', 'phase', 'task', 'sla', 'critical', 'holiday']) assert.ok(layers.has(l), `capa ${l}`);
  assert.ok(r.data.events.some((e) => e.layer === 'project' && e.milestone && e.date === plus(40)));
  assert.ok(r.data.events.some((e) => e.layer === 'task' && e.title.includes('Firmar PDF') && e.user_id === U.matias));
  assert.equal((await admin.get('/reports/calendar?from=2026-12-01&to=2026-11-01')).status, 400);
});

test('explorador: datos de cada fuente con nombres resueltos', async () => {
  const r = await admin.get('/reports/explorer?sources=ticket,project,task,contact,time');
  ok(r);
  const t = r.data.ticket.find((x) => x.subject === 'Equis anda lento');
  assert.equal(t.contact, 'Ana Ruiz');
  assert.ok(t.status && t.status_kind);
  assert.ok(r.data.project.some((p) => p.key === 'MC' && p.lead === 'Matias Ayala' && p.baseline_end === plus(30)));
  assert.ok(r.data.task.some((x) => x.title === 'Firmar PDF' && x.project === 'MC' && x.assignee === 'Matias Ayala'));
  assert.ok(r.data.task.some((x) => x.type === 'epic' && x.title === 'Análisis'), 'las etapas también');
  assert.ok(r.data.contact.some((c) => c.email === 'aruiz@hanseatica.com' && c.tickets === 1));
  assert.ok(Array.isArray(r.data.time));
  // Período: solo los tickets creados en esas fechas
  const old = await admin.get('/reports/explorer?sources=ticket&from=2020-01-01&to=2020-01-31');
  assert.equal(old.data.ticket.length, 0);
  assert.equal((await admin.get('/reports/explorer?sources=nada')).status, 400);
  assert.equal((await agent.get('/reports/explorer')).status, 403);
});

test('vistas guardadas: propias, compartidas y quién puede cambiarlas', async () => {
  let r = await admin.post('/reports/views', { name: 'Tickets y proyectos', shared: true, config: { sources: ['ticket', 'project'], cols: ['c.title'] } });
  ok(r);
  const id = r.data.id;
  r = await admin.get('/reports/views');
  assert.ok(r.data.some((x) => x.id === id && x.owner_name === 'Carlos Gerardi'));
  ok(await admin.put(`/reports/views/${id}`, { name: 'Tickets y proyectos (2)', shared: true, config: { cols: [] } }));
  assert.equal((await admin.post('/reports/views', { name: 'x', config: [] })).status, 400);
  // Un supervisor ve la compartida pero no la puede borrar
  ok(await admin.post('/admin/users', { name: 'Sofía Supervisora', email: 'sofia@hanseatica.com', role: 'supervisor', password: 'Rio-de-la-Plata-9' }));
  const sup = makeClient();
  ok(await sup.post('/auth/login', { email: 'sofia@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  assert.ok((await sup.get('/reports/views')).data.some((x) => x.id === id));
  assert.equal((await sup.del(`/reports/views/${id}`)).status, 403);
  ok(await admin.del(`/reports/views/${id}`));
  assert.equal(await one('select count(*)::int as n from report_views').then((x) => x.n), 0);
  await q('select 1');
});
