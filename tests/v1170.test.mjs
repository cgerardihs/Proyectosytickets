// v1.17: Informes → Horas (tickets, proyectos y operación por persona), capa Operación en el calendario, origen en el
// explorador y capacidad para proyectos de cada persona en el calendario del Portfolio.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q } = await import('../lib/db.js');
const { opsCalendar } = await import('../lib/ops.js');
const { projectCapacity } = await import('../lib/capacity.js');
const admin = makeClient();
const agente = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let uid;
let today;
let ticketNum;

test('preparación: un agente con horas en un ticket, una tarea de proyecto y una tarea de operación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const u = await admin.post('/admin/users', { name: 'Horas Agente', email: 'horas.agente@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' });
  ok(u);
  uid = u.data.id ?? u.data.user?.id;
  ok(await agente.post('/auth/login', { email: 'horas.agente@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  today = (await opsCalendar()).today;
  const t = await agente.post('/tickets', { subject: 'VPN no conecta', contact_email: 'usuario@hanseatica.com' });
  ok(t);
  ticketNum = t.data.number ?? t.data.ticket?.number;
  ok(await agente.post(`/tickets/${ticketNum}/time`, { minutes: 90, note: 'Diagnóstico', spent_on: today }));
  ok(await admin.post('/projects', { key: 'HRS', name: 'Proyecto con horas' }));
  const i = await admin.post('/projects/HRS/issues', { type: 'task', title: 'Instalar el switch', assignee_id: uid });
  ok(i);
  ok(await agente.post(`/issues/${i.data.key}/time`, { minutes: 120, note: 'Armado', spent_on: today }));
  const r = await agente.post('/ops/routines', { name: 'Verificar backups', category: 'Backups', assignee_ids: [uid], est_minutes: 15, rule: { freq: 'daily', workdays: false } });
  ok(r);
  ok(await agente.post('/ops/records', { routine_id: r.data.id, date: today, status: 'done', minutes: 30 }));
});

test('Horas: suma tickets, proyectos y operación de cada persona contra sus horas disponibles', async () => {
  assert.equal((await agente.get('/reports/hours')).status, 403, 'solo supervisores y administradores');
  for (const period of ['week', 'month']) {
    const r = await admin.get(`/reports/hours?period=${period}&date=${today}`);
    ok(r);
    const mine = r.data.entries.filter((e) => e.user_id === uid);
    const by = (s) => mine.filter((e) => e.source === s).reduce((t, e) => t + e.minutes, 0);
    assert.equal(by('T'), 90, period);
    assert.equal(by('P'), 120);
    assert.equal(by('O'), 30);
    assert.ok(mine.find((e) => e.source === 'O').label === 'Verificar backups');
    assert.ok(mine.find((e) => e.source === 'T').link === `#/tickets/${ticketNum}`);
    const p = r.data.people.find((x) => x.id === uid);
    assert.equal(p.it_pct, 100);
    assert.equal(p.available_minutes, r.data.workdays * r.data.day_hours * 60);
    assert.ok(r.data.from <= today && r.data.to >= today);
  }
});

test('el porcentaje dedicado a IT lo cambia un administrador y recalcula las horas disponibles', async () => {
  assert.equal((await agente.patch(`/reports/hours/people/${uid}`, { it_pct: 50 })).status, 403);
  ok(await admin.patch(`/reports/hours/people/${uid}`, { it_pct: 50 }));
  const r = (await admin.get('/reports/hours?period=month')).data;
  const p = r.people.find((x) => x.id === uid);
  assert.equal(p.it_pct, 50);
  assert.equal(p.available_minutes, Math.round(r.workdays * r.day_hours * 60 * 0.5));
  assert.equal((await admin.patch(`/reports/hours/people/${uid}`, { it_pct: 150 })).status, 400);
  ok(await admin.patch(`/reports/hours/people/${uid}`, { it_pct: 100 }));
});

test('el calendario de Informes tiene la capa Operación', async () => {
  const r = await admin.get(`/reports/calendar?from=${today}&to=${today}`);
  ok(r);
  const ev = r.data.events.filter((e) => e.layer === 'ops');
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /Verificar backups/);
  assert.equal(ev[0].done, true);
  assert.equal(ev[0].user_id, uid);
});

test('el explorador marca el origen de cada hora', async () => {
  const r = await admin.get('/reports/explorer?sources=time&period=30');
  ok(r);
  const rows = (r.data.time || r.data.data?.time || []).filter((x) => x.user_id === uid);
  assert.deepEqual(rows.map((x) => x.origin).sort(), ['Operación', 'Proyecto', 'Ticket']);
  assert.equal(rows.find((x) => x.origin === 'Operación').routine, 'Verificar backups');
});

test('Portfolio: la capacidad para proyectos de cada persona descuenta la operación y los tickets', async () => {
  const month = today.slice(0, 7);
  const hd = (await q(`select value from app_settings where key='helpdesk'`))[0]?.value || {};
  const caps = await projectCapacity([month], typeof hd === 'string' ? JSON.parse(hd) : hd, today);
  const c = caps[month][uid];
  assert.ok(c.available > 0);
  assert.ok(c.ops > 0, 'la rutina diaria suma operación planificada');
  assert.equal(c.cap, Math.max(0, Math.round((c.available - c.ops - c.tickets) * 10) / 10));
  const sup = makeClient();
  ok(await sup.post('/auth/login', { email: 'superadmin', password: process.env.SUPERADMIN_PASSWORD }));
  const r = await sup.get('/portfolio');
  ok(r);
  assert.ok(r.data.caps[month][uid].cap >= 0);
  assert.equal(r.data.caps[month][uid].it_pct, 100);
});
