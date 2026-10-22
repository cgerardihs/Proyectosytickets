// Importación de tickets exportados de Desk365 (formato real de la exportación, con datos de prueba).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from './helpers.mjs';

const { parseCsv } = await import('../lib/csv.js');
const { parseDeskDate, mapDeskHeaders } = await import('../lib/desk365.js');
const { q, one } = await import('../lib/db.js');

const admin = makeClient();
const agent = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const b64 = (s) => Buffer.from(`﻿${s}`, 'utf8').toString('base64');

const HEAD = '"Número de ticket","Asunto","Descripción","Estado","Prioridad","Origen","Tipo","Categoría","Subcategoría","Asignar a","Grupo","Hora de creación","Hora de resolución","Hora de cierre","Cerrado por","Tipo de cierre por","Tiempo facturable (min)","Tiempo total (min)","SLA","Fecha límite","Hora de actualización","Actualizado por","Tipo de actualización por","Hora de primera respuesta","Hora de primera asignación","Duración primera respuesta (min)","Duración primera asignación (min)","Duración de resolución (min)","Duración de cierre (min)","Número de conversaciones"';
const row = (n, subj, desc, st, prio, src, type, cat, agent, group, created, extra = {}) => [
  n, subj, desc, st, prio, src, type, cat, '', agent, group, created, extra.resolved || '', extra.closed || '', '', '', '', extra.minutes || '', 'No SLA Policy', '',
  extra.updated || created, extra.updatedBy || agent, extra.updatedByType || 'Agente', '', '', '', '', '', '', extra.conv ?? '2',
].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',');

test('lectura de CSV y fechas de Desk365', () => {
  const rows = parseCsv('a;b;c\n"1;x";"con ""comillas""";"línea\nnueva"\n\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1;x', 'con "comillas"', 'línea\nnueva']]);
  assert.equal(parseDeskDate('13/10/2026 01:17 PM'), '2026-10-13T16:17:00.000Z', 'hora de Buenos Aires');
  assert.equal(parseDeskDate('13/10/2026 12:05 AM'), '2026-10-13T03:05:00.000Z');
  assert.equal(parseDeskDate('01/02/2026 18:30'), '2026-02-01T21:30:00.000Z');
  assert.equal(parseDeskDate('32/13/2026 10:00 AM'), null);
  const m = mapDeskHeaders(parseCsv(HEAD)[0]);
  assert.equal(m.number, 0);
  assert.equal(m.type, 6, '"Tipo de actualización por" no pisa a "Tipo"');
  assert.equal(m.updated_by_type, 22);
  assert.equal(m.conversations, 29);
});

test('importar la exportación: números, estados, agentes, fechas y nota', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false, start_number: 3500 }));
  ok(await admin.post('/admin/users', { name: 'Ana Agente', email: 'ana@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await agent.post('/auth/login', { email: 'ana@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  const csv = [HEAD,
    row(3441, 'Riesgo 9999 - condiciones', '"Buenos días, una consulta sobre el riesgo 9999. Saludos"', 'Abierto', 'Baja', 'Correo', '', 'Tec y Operaciones', 'Nicolas Coton', 'EQUIS - Uso diario de EQUIS', '13/10/2026 01:17 PM', { conv: 3 }),
    row(3440, '"Firma en el frente del riesgo"', 'Necesito la firma', 'Pendiente', 'Alta', 'Microsoft Teams', 'Request', 'Comercial', 'Martin Tamburrini', 'Aplicaciones - CRM, portales, otras apps', '12/10/2026 09:00 AM', { minutes: 45 }),
    row(3305, 'Automatización de direcciones', 'Detalle', 'Stdby', 'Baja', 'Correo', 'Issue', 'Área Que No Existe', 'Persona Desconocida', 'Grupo Inexistente', '17/09/2026 05:27 PM'),
    row(2900, 'Ya cerrado', 'Viejo', 'Cerrado', 'Baja', 'Correo', 'Question', 'Admin y Finanzas', 'Juan Manuel Torres', 'Reporting', '01/07/2026 10:00 AM', { closed: '05/07/2026 11:00 AM' }),
    row(3441, 'Repetido', 'x', 'Abierto', 'Baja', 'Correo', '', '', '', '', '13/10/2026 01:17 PM'),
  ].join('\r\n');
  assert.equal((await agent.post('/admin/import/desk365', { filename: 't.csv', data: b64(csv) })).status, 403, 'solo administradores');
  let r = await admin.post('/admin/import/desk365', { filename: 't.csv', data: b64(csv), dry: true });
  ok(r);
  assert.equal(r.data.contact_columns, false);
  const [a, b, c, d, e] = r.data.rows;
  assert.equal(a.action, 'create');
  assert.equal(a.fields.description, 'Buenos días, una consulta sobre el riesgo 9999. Saludos', 'saca las comillas de más');
  assert.equal(b.fields.subject, 'Firma en el frente del riesgo');
  assert.equal(b.fields.channel, 'teams');
  assert.equal(b.fields.priority, 3);
  assert.equal(b.fields.type.name, 'Solicitud', 'Request → Solicitud');
  assert.equal(c.fields.status.name, 'Stdby');
  assert.equal(c.fields.assignee, null);
  assert.equal(c.fields.groupTech, null, 'un grupo sin equivalente no inventa categoría técnica');
  assert.ok(c.warnings.some((w) => w.includes('Grupo Inexistente')));
  assert.equal(a.fields.tech?.name, 'EQUIS - Uso diario de EQUIS', 'el grupo de Desk365 pasa a la categoría técnica');
  assert.equal(c.fields.type.name, 'Problema');
  assert.ok(c.warnings.some((w) => w.includes('Área Que No Existe') && w.includes('se crea')));
  assert.equal(d.fields.status.kind, 'closed');
  assert.ok(d.fields.resolved_at, 'un cerrado queda con fecha de resolución');
  assert.equal(e.action, 'skip', 'número repetido');
  assert.equal((await one('select count(*)::int as n from tickets')).n, 0, 'la vista previa no guarda');
  r = await admin.post('/admin/import/desk365', { filename: 't.csv', data: b64(csv), dry: false });
  ok(r);
  assert.equal(r.data.created, 4);
  assert.equal(r.data.next_number, 3500, 'respeta el primer número configurado');
  const t = (await admin.get('/tickets/3441')).data;
  assert.equal(t.ticket.created_at, '2026-10-13T16:17:00.000Z');
  assert.equal(t.ticket.channel, 'email');
  assert.ok(t.ticket.tags.includes('desk365'));
  assert.deepEqual(t.messages.map((m) => m.kind), ['customer', 'note']);
  assert.ok(t.messages[1].body_html.includes('<b>3</b>'), 'nota con la cantidad de conversaciones');
  assert.equal(t.contact.email, 'solicitante-sin-datos@desk365.invalid');
  // No se le escribe al solicitante genérico
  const reply = await admin.post('/tickets/3441/messages', { kind: 'reply', body_html: '<p>Hola</p>' });
  ok(reply);
  const t2 = (await admin.get('/tickets/3440')).data;
  assert.equal(t2.time.reduce((s, x) => s + x.minutes, 0), 45, 'tiempo registrado');
  assert.ok(await one(`select id from categories where name='Área Que No Existe'`));
  // Reimportar no duplica
  r = await admin.post('/admin/import/desk365', { filename: 't.csv', data: b64(csv), dry: false });
  ok(r);
  assert.equal(r.data.created, 0);
  assert.equal(r.data.updated, 4);
  assert.equal((await one(`select count(*)::int as n from ticket_messages m join tickets t on t.id=m.ticket_id where t.number=3441 and m.kind<>'reply'`)).n, 2);
  // Los tickets nuevos siguen la numeración
  const nuevo = (await admin.post('/tickets', { subject: 'Nuevo', contact_email: 'x@hanseatica.com' })).data;
  assert.equal(nuevo.number, 3500);
});

test('con datos del contacto (exportación en inglés) y conflicto de número', async () => {
  const head = '"Ticket Number","Subject","Description","Status","Priority","Source","Type","Category","Assign To","Group","Created Time","Contact Name","Contact Email"';
  const csv = [head,
    '"3600","VPN no conecta","No puedo entrar","Open","Medium","Email","Incident","Tec y Operaciones","Matias Ayala","Soporte","2026-10-01 10:00","Valeria Prueba","valeria.prueba@hanseatica.com"',
    '"3500","Choca con uno creado acá","x","Open","Low","Email","","","","","2026-10-01 10:00","Otro","otro@hanseatica.com"',
  ].join('\n');
  const r = await admin.post('/admin/import/desk365', { filename: 'en.csv', data: b64(csv), dry: false });
  ok(r);
  assert.equal(r.data.created, 1);
  const t = (await admin.get('/tickets/3600')).data;
  assert.equal(t.contact.email, 'valeria.prueba@hanseatica.com');
  assert.equal(t.contact.name, 'Valeria Prueba');
  assert.equal(t.ticket.priority, 2);
  assert.equal((await one('select subject from tickets where number=3500')).subject, 'Nuevo', 'no pisa un ticket propio');
  assert.equal((await admin.post('/admin/import/desk365', { filename: 'x.pdf', data: b64('hola') })).status, 400);
  assert.equal((await admin.post('/admin/import/desk365', { filename: 'x.csv', data: b64('a,b\n1,2') })).status, 400, 'no es una exportación de Desk365');
  const next = (await admin.post('/tickets', { subject: 'Sigue', contact_email: 'x@hanseatica.com' })).data;
  assert.equal(next.number, 3601);
  void q;
});
