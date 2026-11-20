// v1.27: contacto del área solicitante en los proyectos y resumen diario de tareas finalizadas.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.RESEND_API_KEY = 're_prueba';
process.env.MAIL_FROM = 'Mesa de Ayuda <soporte@hanseatica.com>';
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 're_x' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const { sendProjectDigests } = await import('../lib/project-digest.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let tasks;
const to = (m) => [].concat(m.to).join();

test('preparación: proyecto con contacto del área y tareas', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await admin.post('/projects', { key: 'CT', name: 'Cotizador de transporte V2', template: 'dev', contact_email: 'Valeria.Castaner@hanseatica.com',
    phases: [{ name: 'Relevamiento con el área comercial' }, { name: 'Prototipo de la pantalla' }, { name: 'Desarrollo' }] }));
  const pj = (await admin.get('/projects/CT')).data;
  assert.equal(pj.contact.email, 'valeria.castaner@hanseatica.com');
  assert.equal(pj.project.notify_contact, true);
  tasks = (await admin.get('/projects/CT/issues')).data.filter((i) => i.type === 'task');
  ok(await admin.post('/projects/CT/issues', { type: 'subtask', title: 'Subtarea', parent_id: tasks[0].id, task_state: 'done' }));
});

test('sin tareas finalizadas no se manda nada', async () => {
  sent.length = 0;
  const r = await sendProjectDigests();
  assert.equal(r.tasks, 0);
  assert.equal(sent.length, 0, 'la subtarea finalizada no cuenta');
});

test('un solo correo por día con todas las tareas finalizadas, y cada tarea se avisa una vez', async () => {
  ok(await admin.patch(`/issues/${tasks[0].key}`, { task_state: 'done' }));
  ok(await admin.patch(`/issues/${tasks[1].key}`, { progress: 100 }));
  sent.length = 0;
  const r = await sendProjectDigests();
  assert.deepEqual([r.projects, r.tasks], [1, 2]);
  assert.equal(sent.length, 1, 'un solo correo');
  assert.equal(to(sent[0]), 'valeria.castaner@hanseatica.com');
  assert.match(sent[0].subject, /Novedades del proyecto Cotizador de transporte V2/);
  assert.doesNotMatch(sent[0].subject, /\[#/, 'no es un ticket');
  assert.match(sent[0].html, /Relevamiento con el área comercial/);
  assert.match(sent[0].html, /Prototipo de la pantalla/);
  assert.match(sent[0].html, /Avance del proyecto: <b>\d+ %<\/b>/);
  // Al otro día no se repite; si se reabre y se vuelve a finalizar, tampoco
  ok(await admin.patch(`/issues/${tasks[0].key}`, { task_state: 'in_progress' }));
  ok(await admin.patch(`/issues/${tasks[0].key}`, { task_state: 'done' }));
  sent.length = 0;
  assert.equal((await sendProjectDigests()).tasks, 0);
  assert.equal(sent.length, 0);
  const d = (await admin.get(`/issues/${tasks[1].key}`)).data;
  assert.ok(d.activities.some((a) => a.action === 'digest_sent'), 'queda en el historial de la tarea');
});

test('apagar el resumen, cambiar el contacto y mandarlo a mano', async () => {
  ok(await admin.patch('/projects/CT', { contact_digest: false }));
  ok(await admin.patch(`/issues/${tasks[2].key}`, { task_state: 'done' }));
  assert.equal((await admin.post('/projects/CT/digest')).status, 400, 'apagado');
  assert.equal((await sendProjectDigests()).tasks, 0);
  // Cambiar de contacto: lo ya finalizado no se le manda al nuevo
  ok(await admin.patch('/projects/CT', { contact_digest: true, contact_email: 'otra.persona@hanseatica.com' }));
  sent.length = 0;
  assert.equal((await sendProjectDigests()).tasks, 0);
  const n = await admin.post('/projects/CT/issues', { type: 'task', title: 'Pruebas con el área', task_state: 'done' });
  ok(n);
  const r = await admin.post('/projects/CT/digest');
  ok(r);
  assert.equal(r.data.tasks, 1);
  assert.equal(to(sent.at(-1)), 'otra.persona@hanseatica.com');
  ok(await admin.patch('/projects/CT', { contact_email: '' }));
  assert.equal((await admin.get('/projects/CT')).data.contact, null, 'se puede quitar');
  assert.equal((await admin.patch('/projects/CT', { contact_email: 'no-es-correo' })).status, 400);
});

test('al convertir un ticket, el contacto es quien lo pidió', async () => {
  const t = await admin.post('/tickets', { subject: 'Nuevo reporte', contact_email: 'jloscerbo@hanseatica.com' });
  const num = t.data.number ?? t.data.ticket?.number;
  const meta = (await admin.get('/meta')).data;
  const r = await admin.post(`/tickets/${num}/project`, { key: 'NR', type_id: meta.projectTypes[0].id, origin_id: meta.origins?.[0]?.id, sector_id: meta.sectors?.[0]?.id,
    phases: [{ name: 'Relevamiento', start_date: '2026-11-23' }, { name: 'Desarrollo', due_date: '2026-12-15' }] });
  ok(r);
  assert.equal((await admin.get('/projects/NR')).data.contact.email, 'jloscerbo@hanseatica.com');
});

test('la plantilla se prueba sin número de ticket ni botón', async () => {
  sent.length = 0;
  ok(await admin.post('/admin/mail-templates/test', { key: 'project_digest', to: 'prueba@hanseatica.com' }));
  assert.match(sent.at(-1).subject, /^\[Prueba\] Novedades del proyecto/);
  assert.doesNotMatch(sent.at(-1).html, /Ver el ticket/);
  assert.match(sent.at(-1).html, /Relevamiento con el área comercial/);
});

test('el texto del resumen se edita en Configuración y se usa al mandarlo', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { mail_templates: { project_digest: { subject: 'Avances de {{proyecto.nombre}}', body: 'Hola {{contacto.nombre}}:\n\n{{tareas}}' } } }));
  ok(await admin.post('/projects/CT/issues', { type: 'task', title: 'Capacitación al área', task_state: 'done' }));
  ok(await admin.patch('/projects/CT', { contact_email: 'valeria.castaner@hanseatica.com' }));
  ok(await admin.post('/projects/CT/issues', { type: 'task', title: 'Puesta en producción', task_state: 'done' }));
  sent.length = 0;
  ok(await admin.post('/projects/CT/digest'));
  assert.equal(sent.at(-1).subject, 'Avances de Cotizador de transporte V2');
  assert.match(sent.at(-1).html, /Puesta en producción/);
});
