// v1.29: solo los dominios (o direcciones) permitidos crean tickets por correo; el resto entra a Spam.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { trustedSender } = await import('../lib/tickets-core.js');
const admin = makeClient();
const agente = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const SECRET = { 'x-inbound-secret': 'secreto-de-prueba' };
let n = 0;
const mail = async (from, subject, extra = {}) => { n += 1; const r = await admin.post('/inbound/email', { From: from, Subject: subject, InternetMessageId: `<al${n}@x>`, Body: `<p>${subject}</p>`, ...extra }, SECRET); ok(r); return r.data.results[0]; };

test('preparación: sin la casilla, todo sigue como antes', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await admin.post('/admin/users', { name: 'Agente AL', email: 'al.agente@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await agente.post('/auth/login', { email: 'al.agente@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  ok(await admin.put('/admin/settings/helpdesk', { portal_trusted_domains: ['hanseatica.com', 'soporte@proveedor.com'] }));
  const r = await mail('Yamiletsy Johnson <yamiletsy.johnson@onboardlogistics.net>', 'Consulta 1');
  const t = (await admin.get(`/tickets/${r.ticket}`)).data.ticket;
  assert.equal(t.spam, false);
});

test('la lista acepta direcciones puntuales y se guarda', async () => {
  assert.equal(await trustedSender('soporte@proveedor.com'), true);
  assert.equal(await trustedSender('ventas@proveedor.com'), false, 'solo esa dirección, no el dominio');
  assert.equal(await trustedSender('juan@sub.hanseatica.com'), true, 'subdominios');
  assert.equal((await admin.put('/admin/settings/helpdesk', { portal_trusted_domains: ['no es dominio'] })).status, 400);
});

test('con la casilla: lo de afuera entra a Spam sin asignar; lo permitido entra normal', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { inbound_allowlist_only: true }));
  const fuera = await mail('Yamiletsy Johnson <yamiletsy.johnson@onboardlogistics.net>', 'Consulta 2');
  assert.equal(fuera.spam, 'sender_not_allowed');
  const d = (await admin.get(`/tickets/${fuera.ticket}`)).data;
  assert.equal(d.ticket.spam, true);
  assert.equal(d.ticket.assignee_id, null);
  assert.ok(d.activities.some((a) => a.action === 'sender_not_allowed'));
  for (const from of ['jperez@hanseatica.com', 'soporte@proveedor.com']) {
    const r = await mail(from, `De ${from}`);
    assert.equal((await admin.get(`/tickets/${r.ticket}`)).data.ticket.spam, false, from);
  }
});

test('las respuestas a un ticket existente entran siempre', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { inbound_allowlist_only: false }));
  const r = await mail('cliente@externo.com', 'Pedido externo');
  ok(await admin.put('/admin/settings/helpdesk', { inbound_allowlist_only: true }));
  const rep = await mail('cliente@externo.com', `RE: [#${r.ticket}] Pedido externo`, { InReplyTo: `<al${n}@x>` });
  assert.equal(rep.appended, true);
  assert.equal(rep.ticket, r.ticket);
});

test('permitir el dominio desde el ticket lo saca de Spam; un agente no puede', async () => {
  const r = await mail('otra@onboardlogistics.net', 'Consulta 3');
  assert.equal((await agente.post(`/tickets/${r.ticket}/allow-sender`, { scope: 'domain' })).status, 403);
  const a = await admin.post(`/tickets/${r.ticket}/allow-sender`, { scope: 'domain' });
  ok(a);
  assert.equal(a.data.entry, 'onboardlogistics.net');
  assert.equal((await admin.get(`/tickets/${r.ticket}`)).data.ticket.spam, false);
  const nuevo = await mail('yamiletsy.johnson@onboardlogistics.net', 'Consulta 4');
  assert.equal((await admin.get(`/tickets/${nuevo.ticket}`)).data.ticket.spam, false, 'el dominio ya puede crear tickets');
  const b = await admin.post(`/tickets/${(await mail('x@otro.com', 'Consulta 5')).ticket}/allow-sender`, { scope: 'email' });
  assert.equal(b.data.entry, 'x@otro.com');
  assert.equal(await trustedSender('y@otro.com'), false);
});
