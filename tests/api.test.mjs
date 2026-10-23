import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from './helpers.mjs';

const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let meta;
// Al convertir un ticket en proyecto: origen y sector obligatorios y cada etapa con inicio y fin (v1.9.3)
const pfReq = () => ({ origin_id: meta.origins[0].id, sector_id: meta.sectors[0].id });
const ph = (...names) => names.map((name, i) => ({ name, start_date: `2026-11-${String(2 + i * 7).padStart(2, '0')}`, due_date: `2026-11-${String(8 + i * 7).padStart(2, '0')}` }));

test('instalación inicial y login', async () => {
  let r = await admin.get('/setup/status');
  ok(r);
  assert.equal(r.data.needsSetup, true);
  r = await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'clave-segura-1' }, start_number: 3500, demo: true });
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }); // estas pruebas usan el portal abierto (de fábrica es solo con Microsoft)
  ok(r, 'setup');
  r = await admin.post('/setup', { admin: { name: 'X', email: 'x@x.com', password: '12345678' } });
  assert.equal(r.status, 403, 'no se puede reinstalar');
  r = await admin.get('/auth/me');
  assert.equal(r.data.user.email, 'cgerardi@hanseatica.com');
  r = await admin.post('/auth/logout');
  r = await admin.get('/auth/me');
  assert.equal(r.data.user, null);
  r = await admin.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'mala' });
  assert.equal(r.status, 401);
  r = await admin.post('/auth/login', { email: 'CGerardi@hanseatica.com', password: 'clave-segura-1' });
  ok(r, 'login');
  meta = (await admin.get('/meta')).data;
  assert.equal(meta.groups.length, 0, 'sin grupos desde la v1.9');
  assert.equal(meta.categories.length, 9);
  assert.ok(meta.statuses.find((s) => s.name === 'Stdby'));
  assert.ok(meta.users.length >= 12);
});

let ticketNum;
test('alta de ticket por agente con SLA y reglas', async () => {
  const sla = meta.slas.find((s) => !s.no_sla);
  const grp = meta.techCategories.find((g) => g.name.startsWith('Aplicaciones'));
  let r = await admin.post('/admin/rules', {
    name: 'CRM a Aplicaciones', match: 'any', conditions: [{ field: 'subject', op: 'contains', value: 'crm' }],
    actions: [{ field: 'tech_category_id', value: String(grp.id) }, { field: 'add_tag', value: 'crm' }],
  });
  ok(r, 'regla');
  r = await admin.post('/tickets', { subject: 'CRM - no carga el panel de cuentas', contact_email: 'mpalacios@hanseatica.com', contact_name: 'Martin Palacios', body_html: '<p>No carga</p>', priority: 3, sla_id: sla.id });
  ok(r, 'crear');
  ticketNum = r.data.number;
  assert.ok(ticketNum >= 3500, 'numeración desde 3500');
  assert.equal(r.data.tech_category_id, grp.id, 'regla aplicó la categoría técnica');
  assert.equal(r.data.group_id, null, 'los tickets nuevos no tienen grupo');
  assert.deepEqual(r.data.tags, ['crm']);
  assert.ok(r.data.resolution_due, 'tiene vencimiento SLA');
  assert.ok(new Date(r.data.first_response_due) <= new Date(r.data.resolution_due));
});

test('listado, vistas y contadores', async () => {
  let r = await admin.get('/tickets?view=unresolved');
  ok(r);
  assert.ok(r.data.items.some((t) => t.number === ticketNum));
  r = await admin.get(`/tickets?q=${ticketNum}`);
  assert.equal(r.data.items[0].number, ticketNum);
  r = await admin.get('/tickets?q=panel de cuentas');
  assert.equal(r.data.total, 1);
  r = await admin.get('/tickets?view=unassigned_mine&priority=3');
  assert.ok(r.data.total >= 1);
  r = await admin.get('/tickets/counts');
  ok(r);
  assert.ok(r.data.all >= 2);
  r = await admin.post('/views', { name: 'Alta prioridad', filters: { priority: '3,4' } });
  ok(r);
  r = await admin.get(`/tickets?view=custom:${r.data.id}`);
  assert.ok(r.data.items.every((t) => t.priority >= 3));
});

test('actualizar, responder, nota, seguir, tiempo', async () => {
  const pend = meta.statuses.find((s) => s.name === 'Pendiente');
  const jt = meta.users.find((u) => u.email === 'jtorres@hanseatica.com');
  let r = await admin.patch(`/tickets/${ticketNum}`, { assignee_id: jt.id, status_id: pend.id, category_id: meta.categories[3].id });
  ok(r);
  assert.equal(r.data.ticket.assignee_id, jt.id);
  assert.ok(r.data.ticket.sla_paused_at, 'pendiente pausa SLA');
  r = await admin.post(`/tickets/${ticketNum}/messages`, { kind: 'reply', body_html: '<p>Hola, lo estamos viendo</p>' });
  ok(r);
  assert.equal(r.data.mail.sent, false, 'sin Resend no envía pero no falla');
  assert.ok(r.data.detail.ticket.first_responded_at);
  r = await admin.post(`/tickets/${ticketNum}/messages`, { kind: 'note', body_html: '<p>Nota interna</p>', notify_user_ids: [jt.id], attachments: [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('hola').toString('base64') }] });
  ok(r);
  const note = r.data.detail.messages.find((m) => m.kind === 'note');
  assert.equal(note.attachments.length, 1);
  r = await admin.get(`/attachments/${note.attachments[0].id}`);
  assert.equal(r.status, 200);
  assert.equal(String(r.data), 'hola');
  r = await admin.post(`/tickets/${ticketNum}/time`, { minutes: 45, note: 'Análisis' });
  ok(r);
  assert.equal(r.data.timeTotal, 45);
  r = await admin.del(`/tickets/${ticketNum}/follow`);
  ok(r);
  r = await admin.get('/tickets?view=following');
  assert.ok(!r.data.items.some((t) => t.number === ticketNum));
});

test('correo entrante: ticket nuevo y respuesta encadenada que reabre', async () => {
  let r = await admin.post('/inbound/email', { From: 'Facundo Soto <fsoto@hanseatica.com>', Subject: 'EQUIS - cierre stro 8209', Body: '<p>No puedo cerrar el siniestro</p>', InternetMessageId: '<abc@mail>' }, { 'x-inbound-secret': 'mal' });
  assert.equal(r.status, 401);
  r = await admin.post('/inbound/email', { From: 'Facundo Soto <fsoto@hanseatica.com>', Subject: 'EQUIS - cierre stro 8209', Body: '<p>No puedo cerrar el siniestro</p>', InternetMessageId: '<abc@mail>', Attachments: [{ Name: 'cap.png', ContentType: 'image/png', ContentBytes: 'iVBORw0KGgo=' }] }, { 'x-inbound-secret': 'secreto-de-prueba' });
  ok(r, 'inbound');
  const num = r.data.results[0].ticket;
  assert.ok(r.data.results[0].created);
  r = await admin.post('/inbound/email', { From: 'fsoto@hanseatica.com', Subject: 'EQUIS - cierre stro 8209', Body: 'x', InternetMessageId: '<abc@mail>' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  assert.equal(r.data.results[0].skipped, 'duplicate');
  const resolved = meta.statuses.find((s) => s.kind === 'resolved');
  r = await admin.patch(`/tickets/${num}`, { status_id: resolved.id });
  assert.ok(r.data.ticket.resolved_at);
  r = await admin.post('/inbound/email', { from: 'fsoto@hanseatica.com', subject: `RE: [#${num}] EQUIS - cierre stro 8209`, text: 'Sigue fallando\n\nEl lun, 12 oct escribió: bla' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  ok(r);
  assert.equal(r.data.results[0].appended, true);
  r = await admin.get(`/tickets/${num}`);
  const st = meta.statuses.find((s) => s.id === r.data.ticket.status_id);
  assert.equal(st.kind, 'open', 'se reabrió');
  assert.equal(r.data.messages.length, 2);
  assert.ok(!r.data.messages[1].body_html.includes('escribió'), 'quita lo citado');
  assert.equal(r.data.messages[0].attachments.length, 1);
  r = await admin.post('/inbound/email', { from: 'x@y.com', subject: 'Respuesta automática: fuera de la oficina', text: 'x' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  assert.equal(r.data.results[0].skipped, 'auto-reply');
});

test('portal: alta, consulta, respuesta y resolución por el contacto', async () => {
  const pub = makeClient();
  let r = await pub.get('/portal/config');
  ok(r);
  assert.equal(r.data.brand.name, 'Hanseatica');
  r = await pub.post('/portal/tickets', { name: 'Noelia Gonzalez', email: 'ngonzalez@hanseatica.com', subject: 'Agregar número de certificado', body_text: 'Necesito el número\nen los endosos', category_id: meta.categories[0].id });
  ok(r, 'portal alta');
  const { token, number } = r.data;
  r = await pub.get('/tickets');
  assert.equal(r.status, 401, 'público no ve tickets');
  r = await pub.post('/portal/ticket', { token });
  ok(r);
  assert.equal(r.data.ticket.number, number);
  await admin.post(`/tickets/${number}/messages`, { kind: 'note', body_html: '<p>secreto</p>' });
  await admin.post(`/tickets/${number}/messages`, { kind: 'reply', body_html: '<p>Hola Noelia</p>' });
  r = await pub.post('/portal/ticket', { token });
  assert.equal(r.data.messages.length, 2, 'no ve notas internas');
  r = await pub.post('/portal/ticket/reply', { token, body_text: 'Gracias!' });
  assert.equal(r.data.messages.length, 3);
  r = await pub.post('/portal/ticket/resolve', { token });
  assert.equal(r.data.ticket.status_kind, 'resolved');
  r = await pub.post('/portal/ticket', { token: token + 'x' });
  assert.equal(r.status, 401);
});

test('acciones masivas, combinar, papelera y exportación', async () => {
  const a = (await admin.post('/tickets', { subject: 'Duplicado A', contact_email: 'a@hanseatica.com' })).data.number;
  const b = (await admin.post('/tickets', { subject: 'Duplicado B', contact_email: 'a@hanseatica.com' })).data.number;
  let r = await admin.post(`/tickets/${b}/merge`, { into: a });
  ok(r);
  r = await admin.get(`/tickets/${a}`);
  assert.ok(r.data.messages.length >= 3);
  const prio = await admin.post('/tickets/bulk', { numbers: [a, b], action: 'update', patch: { priority: 4 } });
  assert.equal(prio.data.done, 2);
  r = await admin.post('/tickets/bulk', { numbers: [b], action: 'trash' });
  r = await admin.get('/tickets?view=trash');
  assert.ok(r.data.items.some((t) => t.number === b));
  r = await admin.post('/tickets/bulk', { numbers: [b], action: 'delete' });
  r = await admin.get(`/tickets/${b}`);
  assert.equal(r.status, 404);
  r = await admin.get('/tickets/export?view=all');
  assert.equal(r.status, 200);
  assert.ok(String(r.data).includes('Número,Asunto'));
});

test('sin grupos: no hay rutas de grupos y un group_id que llegue se ignora', async () => {
  assert.equal((await admin.get('/admin/groups')).status, 404);
  const r1 = await admin.post('/tickets', { subject: 'Con grupo viejo', contact_email: 'rr@hanseatica.com', group_id: 1 });
  ok(r1);
  assert.equal(r1.data.group_id, null);
  assert.equal(r1.data.assignee_id, null, 'sin round robin');
});

test('contactos, empresas y base de conocimiento', async () => {
  let r = await admin.post('/contacts/import', { rows: [{ name: 'Ana', email: 'ana@hanseatica.com', area: 'RRHH' }, { email: 'malo' }] });
  assert.equal(r.data.created, 1);
  assert.equal(r.data.skipped, 1);
  r = await admin.get('/contacts?q=ana');
  assert.equal(r.data.items[0].area, 'RRHH');
  r = await admin.get('/kb/categories');
  const cat = r.data[0];
  r = await admin.post('/kb/articles', { title: 'Cómo resetear tu clave', body_html: '<p>Paso 1</p>', category_id: cat.id, status: 'published' });
  ok(r);
  const pub = makeClient();
  r = await pub.get('/portal/kb?q=clave');
  assert.equal(r.data.length, 1);
  r = await pub.get(`/portal/kb/${r.data[0].id}`);
  assert.equal(r.data.title, 'Cómo resetear tu clave');
});

test('proyectos: issues, sprint, tablero, completar sprint e informes', async () => {
  let r = await admin.post('/projects', { key: 'crm', name: 'Nuevo CRM', template: 'dev' });
  ok(r);
  r = await admin.get('/projects/CRM');
  const st = r.data.statuses;
  assert.equal(st.length, 5);
  const epic = (await admin.post('/projects/CRM/issues', { type: 'epic', title: 'Módulo de casos', start_date: '2026-10-01', due_date: '2026-12-15' })).data;
  assert.equal(epic.key, 'CRM-1');
  const story = (await admin.post('/projects/CRM/issues', { type: 'story', title: 'Alta de caso', parent_id: epic.id, story_points: 5 })).data;
  const bad1 = await admin.post('/projects/CRM/issues', { type: 'subtask', title: 'Sin padre' });
  assert.equal(bad1.status, 400);
  const sub = (await admin.post('/projects/CRM/issues', { type: 'subtask', title: 'API', parent_id: story.id })).data;
  assert.equal(sub.key, 'CRM-3');
  const bug = (await admin.post('/projects/CRM/issues', { type: 'bug', title: 'Error al guardar', story_points: 2, priority: 4 })).data;
  const sp = (await admin.post('/projects/CRM/sprints', { goal: 'Primer incremento' })).data;
  r = await admin.post('/issues/reorder', { moved_id: story.id, sprint_id: sp.id, order: [story.id] });
  ok(r);
  r = await admin.post('/issues/reorder', { moved_id: bug.id, sprint_id: sp.id, order: [bug.id, story.id] });
  r = await admin.get(`/issues/${sub.key}`);
  assert.equal(r.data.issue.sprint_id, sp.id, 'subtarea sigue al padre al sprint');
  r = await admin.post(`/sprints/${sp.id}/start`, {});
  ok(r);
  assert.equal(Number(r.data.committed_points), 7);
  const done = st.find((s) => s.kind === 'done');
  r = await admin.post('/issues/reorder', { moved_id: bug.id, status_id: done.id, order: [bug.id] });
  r = await admin.get(`/issues/${bug.key}`);
  assert.ok(r.data.issue.resolved_at);
  r = await admin.post(`/issues/${bug.key}/comments`, { body_html: '<p>Listo</p>' });
  ok(r);
  r = await admin.post(`/issues/${bug.key}/links`, { to_key: story.key, kind: 'blocks' });
  assert.equal(r.data.links.length, 1);
  r = await admin.get('/projects/CRM/reports');
  ok(r);
  assert.equal(r.data.burndown.total, 7);
  r = await admin.post(`/sprints/${sp.id}/complete`, { move_to: 'new' });
  ok(r);
  assert.equal(r.data.moved, 2, 'historia y subtarea pasan al nuevo sprint');
  assert.equal(Number(r.data.completed_points), 2);
  r = await admin.get('/projects/CRM');
  assert.equal(r.data.sprints.filter((s) => s.state === 'planned').length, 1);
  assert.equal(r.data.epics[0].child_count, 1);
  r = await admin.get('/projects/CRM/issues?sprint=open&exclude_type=epic');
  assert.ok(r.data.length >= 2);
  r = await admin.put('/projects/CRM/statuses', { statuses: [{ id: st[0].id, name: 'Backlog', kind: 'todo' }, { id: done.id, name: 'Hecho', kind: 'done' }] });
  ok(r);
  assert.equal(r.data.length, 2);
  r = await admin.get('/my-work');
  ok(r);
});

test('ticket ↔ issue', async () => {
  const p = (await admin.get('/projects/CRM')).data.project;
  let r = await admin.post(`/tickets/${ticketNum}/issues`, { project_id: p.id, type: 'bug' });
  ok(r);
  assert.equal(r.data.issues.length, 1);
  r = await admin.get(`/issues/${r.data.issues[0].key}`);
  assert.equal(r.data.tickets[0].number, ticketNum);
  r = await admin.post(`/tickets/${ticketNum}/issues`, { issue_key: 'DEMO-1' });
  assert.equal(r.data.issues.length, 2);
});

test('panel, informes, cron y permisos', async () => {
  let r = await admin.get('/dashboard');
  ok(r);
  assert.equal(r.data.trend.length, 30);
  assert.ok(r.data.counters.unresolved >= 1);
  r = await admin.get('/reports/helpdesk');
  ok(r);
  r = await admin.get('/cron/daily', { authorization: 'Bearer cron-de-prueba' });
  ok(r);
  // agente sin permisos de admin
  const jt = meta.users.find((u) => u.email === 'mpiris@hanseatica.com');
  await admin.patch(`/admin/users/${jt.id}`, { password: 'clave-agente-1' });
  const agent = makeClient();
  r = await agent.post('/auth/login', { email: 'mpiris@hanseatica.com', password: 'clave-agente-1' });
  ok(r);
  r = await agent.get('/auth/me');
  assert.equal(r.data.user.must_change_password, true);
  r = await agent.post('/admin/categories', { name: 'X' });
  assert.equal(r.status, 403);
  r = await agent.get('/tickets');
  ok(r);
  r = await agent.get('/notifications');
  ok(r);
  r = await agent.post('/me/password', { password: 'nueva-clave-1' });
  ok(r);
  r = await admin.get('/notifications');
  ok(r);
});

test('ticket convertido en proyecto de desarrollo con fases', async () => {
  const me = (await admin.get('/auth/me')).data.user;
  const t = (await admin.post('/tickets', { subject: 'Automatización de cobranzas prelegales en CRM', contact_email: 'igraneros@hanseatica.com', contact_name: 'Ignacio Graneros', body_html: '<p>Necesitamos automatizar las cobranzas prelegales</p>', assignee_id: me.id })).data;
  const stdby = meta.statuses.find((s) => s.name === 'Stdby');
  let r = await admin.post(`/tickets/${t.number}/project`, {
    key: 'cob', name: 'Cobranzas prelegales', template: 'scrum', notify_contact: true, ...pfReq(),
    phases: [{ name: 'Análisis', start_date: '2026-10-13', due_date: '2026-10-24' }, { name: 'Desarrollo', start_date: '2026-10-26', due_date: '2026-11-30' }, { name: 'Implementación', start_date: '2026-12-01', due_date: '2026-12-15' }],
  });
  ok(r, 'convertir');
  let p = r.data.detail.projects[0];
  assert.equal(p.key, 'COB');
  assert.equal(p.phases.length, 3);
  assert.deepEqual(p.phases.map((f) => f.state), ['pending', 'pending', 'pending']);
  assert.equal(p.current.title, 'Análisis');
  assert.equal(String(p.due_date).slice(0, 10), '2026-12-15');
  assert.ok(p.phases[1].start_date && p.phases[1].due_date, 'cada fase con sus fechas');
  assert.equal(r.data.detail.ticket.status_id, t.status_id, 'por defecto mantiene el estado');
  assert.equal(r.data.detail.ticket.sla_paused_at, null);
  void stdby;
  assert.ok(r.data.detail.messages.some((m) => m.kind === 'note' && m.body_html.includes('COB')), 'nota interna');
  assert.ok(r.data.detail.messages.some((m) => m.kind === 'reply'), 'aviso al solicitante');
  const epic1 = p.phases[0];
  assert.ok(epic1.key.startsWith('COB-'));
  r = await admin.get(`/issues/${epic1.key}`);
  assert.ok(r.data.issue.description_html.includes('cobranzas prelegales'), 'copia la descripción');

  // avance: una historia hecha en la fase 1 la completa
  const proj = (await admin.get('/projects/COB')).data;
  assert.equal(proj.tickets[0].number, t.number, 'el proyecto muestra su ticket de origen');
  const done = proj.statuses.find((s) => s.kind === 'done');
  const doing = proj.statuses.find((s) => s.kind === 'doing');
  const s1 = (await admin.post('/projects/COB/issues', { type: 'story', title: 'Relevar reglas', parent_id: epic1.id })).data;
  const s2 = (await admin.post('/projects/COB/issues', { type: 'story', title: 'Diagrama de estados', parent_id: epic1.id })).data;
  await admin.patch(`/issues/${s1.key}`, { status_id: done.id });
  await admin.patch(`/issues/${s2.key}`, { status_id: doing.id });
  r = await admin.get(`/tickets/${t.number}`);
  p = r.data.projects[0];
  assert.equal(p.phases[0].state, 'active');
  assert.equal(p.phases[0].pct, 50);
  await admin.patch(`/issues/${s2.key}`, { status_id: done.id });
  r = await admin.get(`/tickets/${t.number}`);
  p = r.data.projects[0];
  assert.equal(p.phases[0].state, 'done');
  assert.equal(p.current.title, 'Desarrollo');
  assert.equal(p.progress, 33);

  // lista de tickets marca el proyecto
  r = await admin.get(`/tickets?q=${t.number}`);
  assert.equal(r.data.items[0].project_key, 'COB');

  // al terminar todas las fases avisa al responsable del ticket
  const tamb = meta.users.find((u) => u.email === 'mtamburrini@hanseatica.com');
  await admin.patch(`/tickets/${t.number}`, { assignee_id: tamb.id });
  await admin.patch(`/admin/users/${tamb.id}`, { password: 'clave-tamb-123' });
  for (const f of p.phases.slice(1)) await admin.patch(`/issues/${f.key}`, { status_id: done.id });
  r = await admin.get(`/tickets/${t.number}`);
  assert.equal(r.data.projects[0].finished, true);
  const tc = makeClient();
  await tc.post('/auth/login', { email: 'mtamburrini@hanseatica.com', password: 'clave-tamb-123' });
  r = await tc.get('/notifications');
  assert.ok(r.data.items.some((n) => n.title.includes(`Terminó el desarrollo del ticket #${t.number}`)), 'aviso de fin');

  // vincular a otro existente y desvincular
  r = await admin.post(`/tickets/${t.number}/project`, { project_key: 'DEMO' });
  assert.equal(r.data.detail.projects.length, 2);
  const demoId = r.data.detail.projects.find((x) => x.key === 'DEMO').id;
  r = await admin.del(`/tickets/${t.number}/project/${demoId}`);
  assert.equal(r.data.projects.length, 1);

  // clave repetida
  r = await admin.post(`/tickets/${t.number}/project`, { key: 'COB', phases: ['X'] });
  assert.equal(r.status, 400);
});

test('el portal muestra el avance del desarrollo', async () => {
  const pub = makeClient();
  let r = await pub.post('/portal/tickets', { name: 'Marina Mendez', email: 'mmendez@hanseatica.com', subject: 'Pagos en lote ICBC', body_text: 'Desarrollo pagos en lote' });
  const { number, token } = r.data;
  await admin.post(`/tickets/${number}/project`, { key: 'ICBC', phases: ph('Análisis', 'Desarrollo'), ...pfReq() });
  r = await pub.post('/portal/ticket', { token });
  assert.equal(r.data.development.length, 1);
  assert.deepEqual(r.data.development[0].phases.map((f) => f.title), ['Análisis', 'Desarrollo']);
  assert.equal(r.data.development[0].phases[0].key, undefined, 'no expone datos internos');
});

test('reglas de negocio ticket ↔ proyecto de desarrollo', async () => {
  const st = (n) => meta.statuses.find((s) => s.name === n);
  let r = await admin.put('/admin/settings/helpdesk', { dev_rules: {
    on_convert_status_id: null, on_start_status_id: st('Pendiente').id, on_finish_status_id: st('Resuelto').id,
    phase_rules: [{ phase: 'testing', status_id: st('Stdby').id }], pause_sla: true, notify_contact_phase: true, notify_contact_finish: true,
  } });
  ok(r, 'guardar reglas');
  const sla = meta.slas.find((s) => !s.no_sla);
  const t = (await admin.post('/tickets', { subject: 'Nuevo reporte de reaseguros', contact_email: 'fsoto@hanseatica.com', sla_id: sla.id })).data;
  r = await admin.post(`/tickets/${t.number}/project`, { key: 'REA', phases: ph('Análisis', 'Testing', 'Implementación'), ...pfReq() });
  ok(r);
  let tk = r.data.detail.ticket;
  assert.equal(tk.status_id, t.status_id, 'convertir: mantiene');
  assert.ok(tk.sla_paused_at, 'pausa el SLA mientras dure el desarrollo');
  const dueBefore = new Date(tk.resolution_due).getTime();
  const proj = (await admin.get('/projects/REA')).data;
  const done = proj.statuses.find((s) => s.kind === 'done');
  const doing = proj.statuses.find((s) => s.kind === 'doing');
  const [f1, f2, f3] = r.data.detail.projects[0].phases;
  const a = (await admin.post('/projects/REA/issues', { type: 'story', title: 'Relevar', parent_id: f1.id })).data;
  await admin.patch(`/issues/${a.key}`, { status_id: doing.id });
  tk = (await admin.get(`/tickets/${t.number}`)).data;
  assert.equal(tk.ticket.status_id, st('Pendiente').id, 'arranque → Pendiente');
  await admin.patch(`/issues/${a.key}`, { status_id: doing.id }); // sin transición: no vuelve a disparar
  await admin.patch(`/tickets/${t.number}`, { status_id: st('Abierto').id });
  await admin.patch(`/issues/${a.key}`, { status_id: done.id });
  tk = (await admin.get(`/tickets/${t.number}`)).data;
  assert.equal(tk.ticket.status_id, st('Stdby').id, 'entra a Testing → Stdby');
  assert.ok(tk.messages.some((m) => m.kind === 'reply' && m.body_html.includes('Testing')), 'avisa al solicitante el cambio de fase');
  assert.ok(tk.activities.some((x) => x.action === 'dev_rule' && x.details.event === 'phase'));
  await admin.patch(`/issues/${f2.key}`, { status_id: done.id });
  await admin.patch(`/issues/${f3.key}`, { status_id: done.id });
  tk = (await admin.get(`/tickets/${t.number}`)).data;
  assert.equal(tk.ticket.status_id, st('Resuelto').id, 'fin → Resuelto');
  assert.equal(tk.ticket.sla_paused_at, null, 'reanuda el SLA');
  assert.ok(new Date(tk.ticket.resolution_due).getTime() >= dueBefore, 'el vencimiento se corre por el tiempo en pausa');
  assert.ok(tk.messages.some((m) => m.kind === 'reply' && m.body_html.includes('terminamos el desarrollo')));
  // regla al convertir
  await admin.put('/admin/settings/helpdesk', { dev_rules: { on_convert_status_id: st('Stdby').id } });
  const t2 = (await admin.post('/tickets', { subject: 'Otro desarrollo', contact_email: 'fsoto@hanseatica.com' })).data;
  r = await admin.post(`/tickets/${t2.number}/project`, { key: 'OTRO', phases: ph('Única'), ...pfReq() });
  assert.equal(r.data.detail.ticket.status_id, st('Stdby').id, 'convertir → regla configurada');
  await admin.put('/admin/settings/helpdesk', { dev_rules: {} });
});
