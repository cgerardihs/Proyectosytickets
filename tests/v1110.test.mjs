// v1.11: sistemas críticos — los informa un agente (estado y hora estimada), se ven en el Inicio, en los tickets y en el portal.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const admin = makeClient();
const agent = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const S = {};
const T = {};
let agentId;

test('preparación: sistemas en Configuración', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }); // estas pruebas usan el portal abierto (de fábrica es solo con Microsoft)
  const u = await admin.post('/admin/users', { name: 'Agente Prueba', email: 'agente.prueba@hanseatica.com', password: 'Tango-Sur-Riachuelo-26', role: 'agent' });
  ok(u);
  agentId = u.data.id;
  ok(await agent.post('/auth/login', { email: 'agente.prueba@hanseatica.com', password: 'Tango-Sur-Riachuelo-26' }));
  for (const [name, pub, sort] of [['CRM comercial', true, 1], ['Equis', true, 2], ['Power BI', false, 3]]) {
    const r = await admin.post('/admin/critical-systems', { name, description: `Sistema ${name}`, public: pub, sort });
    ok(r, name);
    S[name] = r.data.id;
  }
  assert.equal((await admin.post('/admin/critical-systems', { name: 'crm COMERCIAL' })).status, 400, 'nombre repetido');
  assert.equal((await agent.post('/admin/critical-systems', { name: 'Otro' })).status, 403, 'solo administradores configuran');
  assert.equal((await agent.get('/admin/critical-systems')).status, 403);
  for (const k of ['a', 'b', 'c']) T[k] = (await anon.post('/portal/tickets', { name: `Usuario ${k}`, email: `${k}@hanseatica.com`, subject: `No entra el CRM ${k}`, body_text: 'Error 503' })).data.number;
  const r = await agent.get('/critical-systems');
  ok(r);
  assert.deepEqual(r.data.systems.map((s) => s.state), ['ok', 'ok', 'ok']);
  assert.equal(r.data.can_report, true);
  assert.equal((await anon.get('/critical-systems')).status, 401);
});

test('informar un problema: validaciones', async () => {
  const url = `/critical-systems/${S['CRM comercial']}/status`;
  assert.equal((await agent.post(url, { state: 'down' })).status, 400, 'sin hora estimada');
  assert.equal((await agent.post(url, { state: 'down', eta: inMin(-30) })).status, 400, 'hora pasada');
  assert.equal((await agent.post(url, { state: 'down', eta: inMin(60 * 24 * 40) })).status, 400, 'más de 30 días');
  assert.equal((await agent.post(url, { state: 'roto', eta: inMin(60) })).status, 400);
  assert.equal((await agent.post(url, { state: 'down', eta: inMin(60), tickets: [999999] })).status, 400, 'ticket inexistente');
  assert.equal((await agent.post('/critical-systems/99999/status', { state: 'down', eta: inMin(60) })).status, 404);
});

test('CRM caído: se ve en el Inicio, en el portal (solo públicos) y avisa al equipo', async () => {
  const r = await agent.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'down', eta: inMin(180), message: 'No se puede ingresar. Trabajando con el proveedor.', tickets: [T.a] });
  ok(r);
  const crm = r.data.systems.find((s) => s.id === S['CRM comercial']);
  assert.equal(crm.state, 'down');
  assert.equal(crm.tickets, 1);
  assert.equal(crm.reported_by_name, 'Agente Prueba');
  assert.ok(crm.since);
  // Portal: público y sin datos internos
  let p = await anon.get('/portal/status');
  ok(p);
  assert.equal(p.data.enabled, true);
  assert.deepEqual(p.data.systems.map((s) => s.name), ['CRM comercial', 'Equis']);
  const pc = p.data.systems[0];
  assert.equal(pc.state, 'down');
  assert.equal(pc.message, 'No se puede ingresar. Trabajando con el proveedor.');
  assert.equal(pc.reported_by, undefined, 'el portal no muestra quién lo informó');
  // Power BI es interno: aunque falle, no aparece en el portal
  ok(await agent.post(`/critical-systems/${S['Power BI']}/status`, { state: 'degraded', eta: inMin(60) }));
  p = await anon.get('/portal/status');
  assert.ok(!p.data.systems.some((s) => s.name === 'Power BI'));
  // Aviso al resto del equipo (no al que lo informó)
  const n = await admin.get('/notifications');
  assert.ok(n.data.items.some((x) => x.title === 'CRM comercial: caído'));
  assert.ok(!(await agent.get('/notifications')).data.items.some((x) => x.title === 'CRM comercial: caído'));
  // Actualizar la estimación no vuelve a avisar ni cambia quién lo informó ni desde cuándo
  const before = await one('select since from critical_systems where id=$1', [S['CRM comercial']]);
  ok(await admin.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'degraded', eta: inMin(60), message: 'Ya entra, pero lento.', tickets: [T.a] }));
  const after = await one('select since, reported_by, state from critical_systems where id=$1', [S['CRM comercial']]);
  assert.equal(after.state, 'degraded');
  assert.equal(after.reported_by, agentId);
  assert.equal(String(after.since), String(before.since));
  const d = await agent.get(`/critical-systems/${S['CRM comercial']}`);
  assert.equal(d.data.log.length, 2);
  assert.deepEqual(d.data.tickets.map((t) => t.number), [T.a]);
});

test('desde un ticket: vincular y desvincular', async () => {
  ok(await agent.post(`/tickets/${T.b}/critical`, { system_id: S['CRM comercial'] }));
  let d = await agent.get(`/tickets/${T.b}`);
  assert.equal(d.data.critical.name, 'CRM comercial');
  assert.ok(d.data.activities.some((a) => a.action === 'critical_linked'));
  assert.equal((await agent.post(`/tickets/${T.c}/critical`, { system_id: S.Equis })).status, 400, 'Equis está operativo: primero se informa');
  ok(await agent.post(`/tickets/${T.c}/critical`, { system_id: S['CRM comercial'] }));
  ok(await agent.post(`/tickets/${T.c}/critical`, { system_id: null }));
  d = await agent.get(`/tickets/${T.c}`);
  assert.equal(d.data.critical, null);
  assert.equal((await agent.get('/critical-systems')).data.systems.find((s) => s.id === S['CRM comercial']).tickets, 2);
});

test('estimación vencida: avisa una vez a quien lo informó', async () => {
  await q(`update critical_systems set eta=now() - interval '5 minutes' where id=$1`, [S['CRM comercial']]);
  await admin.get('/critical-systems');
  await admin.get('/critical-systems');
  const mine = (await agent.get('/notifications')).data.items.filter((x) => x.title === 'Venció la estimación de CRM comercial');
  assert.equal(mine.length, 1);
});

test('solo supervisores y administradores (opcional)', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { critical_managers_only: true }));
  assert.equal((await agent.get('/critical-systems')).data.can_report, false);
  assert.equal((await agent.post(`/critical-systems/${S.Equis}/status`, { state: 'down', eta: inMin(30) })).status, 403);
  ok(await admin.post(`/critical-systems/${S.Equis}/status`, { state: 'maint', eta: inMin(30) }));
  ok(await admin.put('/admin/settings/helpdesk', { critical_managers_only: false }));
  ok(await agent.post(`/critical-systems/${S.Equis}/status`, { state: 'ok' }));
});

test('resuelto: responde y resuelve los tickets vinculados, limpia el problema y avisa', async () => {
  const r = await agent.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'ok', resolve_tickets: true, tickets: [T.a, T.b] });
  ok(r);
  assert.equal(r.data.resolved, 2);
  for (const n of [T.a, T.b]) {
    const d = (await agent.get(`/tickets/${n}`)).data;
    assert.equal(d.critical, null);
    const reply = d.messages.find((m) => m.kind === 'reply');
    assert.match(reply.body_html, /CRM comercial<\/b> ya funciona normalmente/);
    const st = await one('select s.kind from tickets t join statuses s on s.id=t.status_id where t.number=$1', [n]);
    assert.equal(st.kind, 'resolved');
  }
  const c = await one('select s.kind from tickets t join statuses s on s.id=t.status_id where t.number=$1', [T.c]);
  assert.equal(c.kind, 'open', 'el desvinculado no se toca');
  const sys = await one('select state, eta, message, since from critical_systems where id=$1', [S['CRM comercial']]);
  assert.deepEqual([sys.state, sys.eta, sys.message, sys.since], ['ok', null, '', null]);
  assert.ok((await admin.get('/notifications')).data.items.some((x) => x.title === 'CRM comercial volvió a funcionar'));
  // Sin tildar "responder", los tickets quedan como estaban
  ok(await agent.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'down', eta: inMin(30), tickets: [T.c] }));
  ok(await agent.post(`/critical-systems/${S['CRM comercial']}/status`, { state: 'ok', resolve_tickets: false }));
  assert.equal((await one('select s.kind from tickets t join statuses s on s.id=t.status_id where t.number=$1', [T.c])).kind, 'open');
});

test('portal: se puede ocultar el estado; con el portal apagado no se publica nada', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { critical_portal: false }));
  assert.equal((await anon.get('/portal/status')).data.enabled, false);
  ok(await admin.put('/admin/settings/helpdesk', { critical_portal: true, portal_enabled: false }));
  const r = await anon.get('/portal/status');
  assert.equal(r.data.enabled, false);
  assert.deepEqual(r.data.systems, []);
  ok(await admin.put('/admin/settings/helpdesk', { portal_enabled: true }));
  // Un sistema desactivado no aparece en ningún lado
  ok(await admin.patch(`/admin/critical-systems/${S.Equis}`, { active: false }));
  assert.ok(!(await anon.get('/portal/status')).data.systems.some((s) => s.name === 'Equis'));
  assert.ok(!(await agent.get('/critical-systems')).data.systems.some((s) => s.name === 'Equis'));
});
