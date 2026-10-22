// v1.7: cierre de ciclo ticket ↔ tareas (nota privada, aviso y reapertura) y roadmap en modo calendario.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { monthLoad, participants, addMonths } = await import('../public/js/views/portfolio-calendar.js');

const admin = makeClient();
const sup = makeClient();
const dev = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const strip = (h) => String(h).replace(/<\/p>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
let meta;
let ana;
let lucia;
let statuses;
let waitingId;
let openId;

async function newTicket(subject) {
  const r = await admin.post('/tickets', { subject, contact_email: 'cobranzas@hanseatica.com', contact_name: 'Ana Torres', body_html: '<p>No baja el PDF</p>', assignee_id: ana.id });
  ok(r, 'alta de ticket');
  return r.data.number ?? r.data.ticket?.number;
}
async function newIssue(title) {
  const r = await admin.post('/projects/DEV/issues', { title, type: 'task', assignee_id: lucia.id });
  ok(r, 'alta de tarea');
  return r.data.key ?? r.data.issue?.key;
}
const done = () => statuses.find((s) => s.kind === 'done').id;
const doing = () => statuses.find((s) => s.kind === 'doing').id;
const detail = async (n) => (await admin.get(`/tickets/${n}`)).data;
const cycleNotes = (d) => d.messages.filter((m) => m.meta?.dev_cycle);

test('instalación: estado "En espera de desarrollo" y proyecto de desarrollo', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: 'Super-Clave-Muy-Larga-2026' }));
  ok(await admin.post('/admin/users', { name: 'Ana Agente', email: 'ana@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await admin.post('/admin/users', { name: 'Lucía Fernández', email: 'lucia@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await dev.post('/auth/login', { email: 'lucia@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  meta = (await admin.get('/meta')).data;
  ana = meta.users.find((u) => u.email === 'ana@hanseatica.com');
  lucia = meta.users.find((u) => u.email === 'lucia@hanseatica.com');
  const waiting = meta.statuses.filter((s) => s.name === 'En espera de desarrollo');
  assert.equal(waiting.length, 1, 'el alta inicial crea el estado una sola vez');
  assert.equal(waiting[0].kind, 'pending');
  waitingId = waiting[0].id;
  openId = meta.statuses.find((s) => s.name === 'Abierto').id;
  const dt = meta.projectTypes.find((t) => t.name === 'Desarrollo de software');
  ok(await admin.post('/projects', { key: 'DEV', name: 'Portal de autogestión', type_id: dt.id, member_ids: [lucia.id] }));
  statuses = (await admin.get('/projects/DEV')).data.statuses;
});

test('migración 10: agrega el estado en una base que ya tenía estados, sin duplicarlo', async () => {
  const { MIGRATIONS } = await import('../lib/migrations.js');
  const m10 = MIGRATIONS.find((m) => m.version === 10);
  await q("delete from statuses where name='En espera de desarrollo' and not exists (select 1 from tickets t where t.status_id=statuses.id)");
  for (const s of m10.statements) await q(s);
  for (const s of m10.statements) await q(s);
  const rows = await q("select id,kind,pauses_sla from statuses where name='En espera de desarrollo'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pauses_sla, true);
  waitingId = rows[0].id;
});

test('cierre de ciclo: una tarea vinculada finalizada → nota privada, aviso al asignado y reapertura', async () => {
  const n = await newTicket('No puedo descargar el comprobante en PDF');
  const key = await newIssue('Corregir descarga de comprobantes');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: key }), 'vincular');
  ok(await admin.patch(`/tickets/${n}`, { status_id: waitingId }), 'en espera de desarrollo');
  ok(await dev.patch(`/issues/${key}`, { status_id: doing() }), 'en curso');
  assert.equal(cycleNotes(await detail(n)).length, 0, 'en curso no dispara');
  ok(await dev.patch(`/issues/${key}`, { status_id: done() }), 'finalizada');
  const d = await detail(n);
  const notes = cycleNotes(d);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'note', 'es una nota privada');
  assert.equal(notes[0].author_user_id, null);
  assert.equal(strip(notes[0].body_html),
    `🎉 La tarea de desarrollo ${key} vinculada a este ticket fue finalizada por @Lucía Fernández. Ya podés validar y responder al usuario. El ticket pasó de «En espera de desarrollo» a «Abierto».`);
  assert.equal(d.ticket.status_id, openId, 'se reabrió');
  assert.ok(d.activities.some((a) => a.action === 'dev_rule' && a.details.event === 'issues_done' && a.details.issues[0] === key));
  const notif = await one('select * from notifications where user_id=$1 and link=$2 order by id desc limit 1', [ana.id, `#/tickets/${n}`]);
  assert.ok(notif && notif.title.includes(`#${n}`) && notif.body.includes('Ya podés validar'), 'avisa al agente asignado');
  const replies = d.messages.filter((m) => m.kind === 'reply');
  assert.equal(replies.length, 0, 'al usuario no se le responde solo');
});

test('cierre de ciclo: con varias tareas espera a la última; si el ticket no estaba en espera no cambia el estado', async () => {
  const n = await newTicket('Reporte de cobranzas a Excel');
  const k1 = await newIssue('Nuevo endpoint de cobranzas');
  const k2 = await newIssue('Exportar a Excel');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k1 }));
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k2 }));
  const pending = meta.statuses.find((s) => s.name === 'Pendiente').id;
  ok(await admin.patch(`/tickets/${n}`, { status_id: pending }));
  ok(await dev.patch(`/issues/${k1}`, { status_id: done() }));
  assert.equal(cycleNotes(await detail(n)).length, 0, 'falta una tarea');
  // Desde el tablero (mover la tarjeta) también dispara
  const id2 = (await one('select id from issues where key=$1', [k2])).id;
  ok(await dev.post('/issues/reorder', { moved_id: id2, status_id: done(), order: [id2] }));
  const d = await detail(n);
  const notes = cycleNotes(d);
  assert.equal(notes.length, 1);
  assert.match(strip(notes[0].body_html), new RegExp(`^🎉 Las tareas de desarrollo ${k1}, ${k2} vinculadas a este ticket están todas finalizadas\\. La última \\(${k2}\\) la finalizó @Lucía Fernández\\.`));
  assert.equal(d.ticket.status_id, pending, '"Pendiente" no cuenta como espera de desarrollo');
  // Reabrir una tarea y volver a cerrarla vuelve a avisar (es una transición nueva); moverla dentro de Finalizado no
  ok(await dev.patch(`/issues/${k2}`, { status_id: doing() }));
  ok(await dev.patch(`/issues/${k2}`, { status_id: done() }));
  ok(await dev.patch(`/issues/${k2}`, { title: 'Exportar a Excel (xlsx)' }));
  assert.equal(cycleNotes(await detail(n)).length, 2);
});

test('cierre de ciclo: configuración (estados de espera, estado al reabrir, apagado) y tickets cerrados', async () => {
  const pending = meta.statuses.find((s) => s.name === 'Pendiente').id;
  const resolved = meta.statuses.find((s) => s.kind === 'resolved').id;
  // "Pendiente" como estado de espera; al reabrir pasa a "Abierto" (explícito)
  ok(await admin.put('/admin/settings/helpdesk', { dev_rules: { waiting_status_ids: [pending], issues_done_status_id: openId } }));
  let n = await newTicket('Alta de usuario en el portal');
  let k = await newIssue('Alta en el portal');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k }));
  ok(await admin.patch(`/tickets/${n}`, { status_id: pending }));
  ok(await dev.patch(`/issues/${k}`, { status_id: done() }));
  assert.equal((await detail(n)).ticket.status_id, openId);
  // Un guardado parcial no pisa el resto de las reglas
  ok(await admin.put('/admin/settings/helpdesk', { dev_rules: { pause_sla: false } }));
  let rules = (await admin.get('/admin/settings/helpdesk')).data.dev_rules;
  assert.deepEqual(rules.waiting_status_ids, [pending]);
  assert.equal(rules.issues_done_status_id, openId);
  // Un destino que no es de tipo abierto (ej. Resuelto) se ignora: vuelve al abierto por defecto
  ok(await admin.put('/admin/settings/helpdesk', { dev_rules: { issues_done_status_id: resolved } }));
  n = await newTicket('Destino inválido');
  k = await newIssue('Tarea con destino inválido');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k }));
  ok(await admin.patch(`/tickets/${n}`, { status_id: pending }));
  ok(await dev.patch(`/issues/${k}`, { status_id: done() }));
  assert.equal((await detail(n)).ticket.status_id, openId);
  // Finalizar dos veces la misma tarea (doble clic) no duplica la nota
  ok(await dev.patch(`/issues/${k}`, { status_id: done() }));
  assert.equal(cycleNotes(await detail(n)).length, 1);
  // Apagado: ni nota ni reapertura; un guardado parcial posterior no lo vuelve a prender
  ok(await admin.put('/admin/settings/helpdesk', { dev_rules: { issues_done_note: false, issues_done_reopen: false, waiting_status_ids: [pending] } }));
  ok(await admin.put('/admin/settings/helpdesk', { dev_rules: { pause_sla: false } }));
  rules = (await admin.get('/admin/settings/helpdesk')).data.dev_rules;
  assert.equal(rules.issues_done_note, false);
  assert.equal(rules.issues_done_reopen, false);
  n = await newTicket('Sin reglas');
  k = await newIssue('Tarea sin reglas');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k }));
  ok(await admin.patch(`/tickets/${n}`, { status_id: pending }));
  ok(await dev.patch(`/issues/${k}`, { status_id: done() }));
  let d = await detail(n);
  assert.equal(cycleNotes(d).length, 0);
  assert.equal(d.ticket.status_id, pending);
  // Ticket cerrado: no se toca
  ok(await admin.put('/admin/settings/helpdesk', { dev_rules: { issues_done_note: true, issues_done_reopen: true, waiting_status_ids: null, issues_done_status_id: null } }));
  n = await newTicket('Ya cerrado');
  k = await newIssue('Tarea de ticket cerrado');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k }));
  const closed = meta.statuses.find((s) => s.kind === 'closed').id;
  ok(await admin.patch(`/tickets/${n}`, { status_id: closed }));
  ok(await dev.patch(`/issues/${k}`, { status_id: done() }));
  d = await detail(n);
  assert.equal(cycleNotes(d).length, 0);
  assert.equal(d.ticket.status_id, closed);
  // Resuelto: deja la nota (sirve de registro) pero no lo reabre
  n = await newTicket('Ya resuelto');
  k = await newIssue('Tarea de ticket resuelto');
  ok(await admin.post(`/tickets/${n}/issues`, { issue_key: k }));
  ok(await admin.patch(`/tickets/${n}`, { status_id: resolved }));
  ok(await dev.patch(`/issues/${k}`, { status_id: done() }));
  d = await detail(n);
  assert.equal(cycleNotes(d).length, 1);
  assert.equal(d.ticket.status_id, resolved);
});

test('portfolio: capacidad mensual configurable y participantes de cada proyecto', async () => {
  ok(await sup.patch(`/admin/users/${meta.me.id}`, { can_portfolio: true }));
  // Todas las tareas de Lucía están finalizadas: no cuenta como quien trabaja en el proyecto
  let r = await admin.get('/portfolio');
  assert.ok(!r.data.rows.find((x) => x.key === 'DEV').worker_ids.includes(lucia.id), 'las tareas finalizadas no cuentan');
  await newIssue('Tarea abierta de Lucía');
  r = await admin.get('/portfolio');
  ok(r);
  assert.equal(r.data.capacity, 80, 'por defecto 80 h por persona por mes');
  assert.match(r.data.today, /^\d{4}-\d{2}-\d{2}$/);
  const p = r.data.rows.find((x) => x.key === 'DEV');
  assert.ok(p.member_ids.includes(lucia.id));
  assert.ok(p.worker_ids.includes(lucia.id), 'quien tiene tareas asignadas');
  ok(await admin.put('/admin/settings/helpdesk', { portfolio_month_hours: 120 }));
  assert.equal((await admin.get('/portfolio')).data.capacity, 120);
  assert.equal((await admin.put('/admin/settings/helpdesk', { portfolio_month_hours: 0 })).status, 400);
  assert.equal((await dev.put('/admin/settings/helpdesk', { portfolio_month_hours: 10 })).status, 403, 'un agente no la cambia');
});

test('calendario: reparto de horas por mes y por persona', () => {
  const rows = [
    // 1 oct → 31 dic (92 días), 920 h, dos personas
    { key: 'A', name: 'A', start: '2026-10-01', end: '2026-12-31', estimated_hours: 920, lead_id: 1, worker_ids: [2], member_ids: [1, 2, 3], progress: 10, health: 'ok' },
    // termina en noviembre, una persona, sin horas
    { key: 'B', name: 'B', start: '2026-11-02', end: '2026-11-20', estimated_hours: null, lead_id: 1, worker_ids: [], member_ids: [], progress: 0, health: 'ok' },
    // sin responsable ni tareas: usa los integrantes
    { key: 'C', name: 'C', start: '2026-11-01', end: '2026-11-30', estimated_hours: 60, lead_id: null, worker_ids: [], member_ids: [3], progress: 0, health: 'ok' },
    // sin nadie
    { key: 'D', name: 'D', start: '2026-11-01', end: '2026-11-30', estimated_hours: 30, lead_id: null, worker_ids: [], member_ids: [], progress: 0, health: 'ok' },
    // finalizado antes de tiempo: figura pero no carga horas
    { key: 'F', name: 'F', start: '2026-11-01', end: '2026-11-30', estimated_hours: 500, lead_id: 3, worker_ids: [], member_ids: [], progress: 100, health: 'done', portfolio_status: 'done' },
    // sin fechas: no aparece
    { key: 'E', name: 'E', start: null, end: null, estimated_hours: 100, lead_id: 1, worker_ids: [], member_ids: [], progress: 0, health: 'none' },
  ];
  assert.deepEqual(participants(rows[0]), [1, 2]);
  assert.deepEqual(participants(rows[2]), [3]);
  assert.deepEqual(participants(rows[3]), [0]);
  const nov = monthLoad(rows, '2026-11', 80);
  assert.equal(nov.active.length, 5);
  assert.deepEqual(nov.ends.map((p) => p.key), ['B', 'C', 'D', 'F']);
  assert.equal(nov.noHours, 1);
  const one1 = nov.people.find((x) => x.id === 1);
  assert.ok(Math.abs(one1.hours - 150) < 0.01, `920 h × 30/92 / 2 = 150 (dio ${one1.hours})`);
  assert.equal(one1.pct, 188);
  assert.equal(nov.people.find((x) => x.id === 3).hours, 60);
  assert.equal(nov.people.at(-1).id, 0, '"Sin responsable" va al final');
  assert.equal(nov.over, 2, 'las personas 1 y 2 pasan las 80 h');
  assert.equal(nov.pct, Math.round(((150 + 150 + 60) / (3 * 80)) * 100), 'promedio de las personas con proyectos, sin contar "Sin responsable"');
  const ene = monthLoad(rows, '2027-01', 80);
  assert.equal(ene.active.length, 0);
  assert.equal(ene.pct, 0);
  // Octubre: 31 de 92 días
  const oct = monthLoad(rows, '2026-10', 80);
  assert.ok(Math.abs(oct.people.find((x) => x.id === 2).hours - (920 * 31 / 92) / 2) < 0.01);
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.equal(addMonths('2026-01', -1), '2025-12');
});
