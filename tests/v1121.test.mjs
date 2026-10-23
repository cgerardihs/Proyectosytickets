// v1.12.1: el área solicitante del ticket sale del área del contacto (ficha o directorio de Microsoft 365).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const admin = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const catOf = async (n) => (await one('select c.name from tickets t left join categories c on c.id=t.category_id where t.number=$1', [n]))?.name ?? null;
const newTicket = async (email, extra = {}) => {
  const r = await anon.post('/portal/tickets', { name: 'Persona', email, subject: `Pedido ${email}`, body_text: 'Hola', ...extra });
  ok(r, email);
  return r.data.number;
};

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' });
  for (const [name, email, area] of [
    ['Richards Pulgar', 'rpulgar@hanseatica.com', 'Sistemas'],
    ['Lucía Díaz', 'ldiaz@hanseatica.com', 'recursos   HUMANOS'], // coincide con la descripción de "RRHH"
    ['Marcos Paz', 'mpaz@hanseatica.com', 'Comercial'],
    ['Sofía Ríos', 'srios@hanseatica.com', 'Siniestros'],
    ['Sin Área', 'sinarea@hanseatica.com', ''],
  ]) ok(await admin.post('/contacts', { name, email, area }), email);
});

test('al crear el ticket toma el área del contacto (nombre o descripción, sin mayúsculas ni tildes)', async () => {
  assert.equal(await catOf(await newTicket('mpaz@hanseatica.com')), 'Comercial');
  assert.equal(await catOf(await newTicket('ldiaz@hanseatica.com')), 'RRHH');
  assert.equal(await catOf(await newTicket('sinarea@hanseatica.com')), null);
  // Si se elige un área, gana la elegida
  const presi = await one(`select id from categories where name='Presidencia'`);
  assert.equal(await catOf(await newTicket('mpaz@hanseatica.com', { category_id: presi.id })), 'Presidencia');
});

test('áreas sin equivalencia: se listan y, al asignarlas o crearlas, se completan los tickets', async () => {
  const tSis = await newTicket('rpulgar@hanseatica.com');
  const tSin = await newTicket('srios@hanseatica.com');
  assert.equal(await catOf(tSis), null);
  let r = await admin.get('/admin/area-mapping');
  ok(r);
  const sis = r.data.unmatched.find((a) => a.area === 'Sistemas');
  assert.deepEqual([sis.contacts, sis.tickets], [1, 1]);
  assert.ok(r.data.unmatched.some((a) => a.area === 'Siniestros'));
  // Crear "Sistemas" como área nueva
  ok(await admin.post('/admin/area-mapping', { area: 'Sistemas', create: true }));
  assert.equal(await catOf(tSis), 'Sistemas');
  // "Siniestros" corresponde a una existente: queda como otro nombre
  const sl = await one(`select id from categories where name='Siniestros y Legales'`);
  r = await admin.post('/admin/area-mapping', { area: 'Siniestros', category_id: sl.id });
  ok(r);
  assert.equal(r.data.filled, 1);
  assert.equal(await catOf(tSin), 'Siniestros y Legales');
  assert.deepEqual((await one('select aliases from categories where id=$1', [sl.id])).aliases, ['Siniestros']);
  assert.equal((await admin.get('/admin/area-mapping')).data.unmatched.length, 0);
  // Los próximos tickets de esas personas ya salen con el área
  assert.equal(await catOf(await newTicket('srios@hanseatica.com')), 'Siniestros y Legales');
  // Otros nombres también se cargan desde la tabla de áreas
  const rrhh = await one(`select id from categories where name='RRHH'`);
  ok(await admin.patch(`/admin/categories/${rrhh.id}`, { aliases: ['Personal', 'Capital Humano'] }));
  ok(await admin.post('/contacts', { name: 'Ana Gil', email: 'agil@hanseatica.com', area: 'Capital humano' }));
  assert.equal(await catOf(await newTicket('agil@hanseatica.com')), 'RRHH');
  assert.equal((await admin.post('/admin/area-mapping', { area: 'X' })).status, 400, 'sin área elegida');
});

test('al cambiar el contacto de un ticket sin área, toma la del nuevo contacto', async () => {
  const n = await newTicket('sinarea@hanseatica.com');
  const c = await one(`select id from contacts where email='mpaz@hanseatica.com'`);
  ok(await admin.patch(`/tickets/${n}`, { contact_id: c.id }));
  assert.equal(await catOf(n), 'Comercial');
  // Con área ya puesta, cambiar el contacto no la toca
  const otro = await one(`select id from contacts where email='ldiaz@hanseatica.com'`);
  ok(await admin.patch(`/tickets/${n}`, { contact_id: otro.id }));
  assert.equal(await catOf(n), 'Comercial');
});

test('la tarea diaria completa los que quedaron sin área (ej. el área llegó después desde el directorio)', async () => {
  const n = await newTicket('sinarea@hanseatica.com');
  await q(`update contacts set area='Marketing' where email='sinarea@hanseatica.com'`);
  ok(await admin.post('/admin/cron/run', {}));
  assert.equal(await catOf(n), 'Marketing');
});
