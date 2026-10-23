// v1.10.0: portal con consulta por número de ticket e ingreso de empleados con Microsoft (ven solo sus tickets).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
// App de Entra configurada (el portal ofrece ingresar con Microsoft)
const MS = { MS_TENANT_ID: '11111111-2222-3333-4444-555555555555', MS_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', MS_CLIENT_SECRET: 'secreto' };
Object.assign(process.env, MS);
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { portalSign } = await import('../lib/tickets-core.js');
const { isGuestAccount, sessionEmails } = await import('../lib/portal-session.js');
const admin = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

// Sesión del portal como la deja el callback de Microsoft
async function msClient(oid, emails, name) {
  const c = makeClient();
  const tok = await portalSign({ k: 'ps', o: oid, e: emails, n: name }, 3600);
  c.setCookie(`hd_portal=${tok}`);
  return c;
}

let tA; let tB; let tC;

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }); // estas pruebas usan el portal abierto (de fábrica es solo con Microsoft)
  tA = (await anon.post('/portal/tickets', { name: 'Ana Ruiz', email: 'aruiz@hanseatica.com', subject: 'No anda la VPN', body_text: 'Desde ayer' })).data;
  tB = (await anon.post('/portal/tickets', { name: 'Bruno Paz', email: 'bpaz@hanseatica.com', subject: 'Sueldo de marzo', body_text: 'Privado' })).data;
  tC = (await anon.post('/portal/tickets', { name: 'Ana Ruiz', email: 'ana.ruiz@hanseatica.com', subject: 'Impresora', body_text: 'Con el otro correo' })).data;
  assert.ok(tA.number && tB.number && tC.number);
  await q(`update tickets set cc=array['jefe@hanseatica.com'] where number=$1`, [tB.number]);
});

test('consulta por número: con el correo del solicitante o de alguien en copia; si no, el mismo "no encontrado"', async () => {
  let r = await anon.post('/portal/lookup', { number: tA.number, email: 'ARuiz@hanseatica.com' });
  ok(r);
  assert.equal(r.data.subject, 'No anda la VPN');
  assert.deepEqual(r.data.messages.map((m) => m.kind), ['customer']);
  assert.ok(r.data.status && r.data.status_kind);
  assert.equal(r.data.can_open, false, 'sin sesión no abre la conversación');
  // La conversación incluye las respuestas de la mesa, pero nunca las notas internas
  const tk = await one('select id from tickets where number=$1', [tA.number]);
  await q(`insert into ticket_messages(ticket_id,kind,body_html) values ($1,'reply','<p>Estamos viendo la VPN</p>'),($1,'note','<p>NOTA INTERNA</p>')`, [tk.id]);
  r = await anon.post('/portal/lookup', { number: tA.number, email: 'aruiz@hanseatica.com' });
  assert.deepEqual(r.data.messages.map((m) => m.kind), ['customer', 'reply']);
  assert.ok(!JSON.stringify(r.data).includes('NOTA INTERNA'));
  assert.equal(r.data.messages[1].author, 'Mesa de ayuda');
  ok(await anon.post('/portal/lookup', { number: tB.number, email: 'jefe@hanseatica.com' }), 'en copia');
  const wrong = await anon.post('/portal/lookup', { number: tB.number, email: 'aruiz@hanseatica.com' });
  const none = await anon.post('/portal/lookup', { number: 99999, email: 'aruiz@hanseatica.com' });
  assert.equal(wrong.status, 404);
  assert.equal(none.status, 404);
  assert.equal(wrong.data.error, none.data.error, 'no revela qué números existen');
  assert.equal((await anon.post('/portal/lookup', { number: tA.number })).status, 400, 'sin sesión pide el correo');
  // Borrado o spam: no aparece
  await q('update tickets set spam=true where number=$1', [tC.number]);
  assert.equal((await anon.post('/portal/lookup', { number: tC.number, email: 'ana.ruiz@hanseatica.com' })).status, 404);
  await q('update tickets set spam=false where number=$1', [tC.number]);
});

test('consulta por número: tope de intentos fallidos por número; el dueño con sesión no se traba', async () => {
  const c = makeClient();
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/portal/lookup', { number: tB.number, email: `x${i}@hanseatica.com` });
  assert.equal(last.status, 429);
  assert.equal((await c.post('/portal/lookup', { number: tB.number, email: 'bpaz@hanseatica.com' })).status, 429, 'sin sesión, ese número queda trabado un rato');
  const bruno = await msClient('oid-bruno-x', ['bpaz@hanseatica.com'], 'Bruno Paz');
  const r = await bruno.post('/portal/lookup', { number: tB.number });
  ok(r, 'con sesión sí');
  assert.equal(r.data.subject, 'Sueldo de marzo');
  assert.equal(r.data.can_open, true);
  await q(`delete from rate_limits where key like 'portal-lookup%'`);
});

test('Mis tickets con Microsoft: solo los propios (por cualquiera de sus correos o por el id del directorio)', async () => {
  const ana = await msClient('oid-ana', ['aruiz@hanseatica.com', 'ana.ruiz@hanseatica.com'], 'Ana Ruiz');
  const cfg = await ana.get('/portal/config');
  assert.deepEqual(cfg.data.me, { name: 'Ana Ruiz', email: 'aruiz@hanseatica.com' });
  let r = await ana.post('/portal/my-tickets', {});
  ok(r);
  assert.deepEqual(r.data.tickets.map((t) => t.number).sort(), [tA.number, tC.number].sort());
  assert.equal(r.data.session, true);
  // Ver, responder y adjuntos por número, sin enlace
  r = await ana.post('/portal/ticket', { number: tA.number });
  ok(r);
  assert.equal(r.data.token, null, 'con sesión no se emite enlace');
  ok(await ana.post('/portal/ticket/reply', { number: tA.number, body_text: 'Sigue sin andar' }));
  assert.equal((await ana.post('/portal/ticket', { number: tA.number })).data.messages.length, 3, 'mensaje inicial, respuesta de la mesa y la suya (la nota interna no');
  // El ticket de otro: no
  assert.equal((await ana.post('/portal/ticket', { number: tB.number })).status, 404);
  assert.equal((await ana.post('/portal/ticket/reply', { number: tB.number, body_text: 'x' })).status, 404);
  assert.equal((await ana.post('/portal/ticket/resolve', { number: tB.number })).status, 404);
  assert.equal((await ana.post('/portal/ticket/feedback', { number: tB.number, helpful: true })).status, 404);
  // Consulta por número sin correo: con sesión alcanza, y si es suyo puede abrirlo
  r = await ana.post('/portal/lookup', { number: tA.number });
  ok(r);
  assert.equal(r.data.can_open, true);
  assert.equal(r.data.subject, 'No anda la VPN');
  assert.equal((await ana.post('/portal/lookup', { number: tB.number })).status, 404);
  // Por el id del directorio (contacto sincronizado de Entra con otro correo)
  await q(`update contacts set external_id='oid-bruno' where email='bpaz@hanseatica.com'`);
  const bruno = await msClient('oid-bruno', ['bruno.paz@hanseatica.com'], 'Bruno Paz');
  assert.deepEqual((await bruno.post('/portal/my-tickets', {})).data.tickets.map((t) => t.number), [tB.number]);
  // Sin sesión: 401
  assert.equal((await anon.post('/portal/my-tickets', {})).status, 401);
  assert.equal((await anon.post('/portal/ticket', { number: tA.number })).status, 401);
});

test('crear ticket con sesión: queda a nombre de la cuenta', async () => {
  const ana = await msClient('oid-ana', ['aruiz@hanseatica.com'], 'Ana Ruiz');
  const r = await ana.post('/portal/tickets', { name: 'Otra', email: 'bpaz@hanseatica.com', subject: 'Pedido de mouse', body_text: 'Gracias' });
  ok(r);
  assert.equal(r.data.token, null);
  const row = await one('select c.email from tickets t join contacts c on c.id=t.contact_id where t.number=$1', [r.data.number]);
  assert.equal(row.email, 'aruiz@hanseatica.com');
});

test('correo reasignado a otra persona: no ve los tickets del anterior ni abre a su nombre', async () => {
  // El contacto de Bruno quedó vinculado a su cuenta de Entra (oid-bruno); el correo ahora es de otra persona
  const nuevo = await msClient('oid-nuevo', ['bpaz@hanseatica.com'], 'Beatriz Paz');
  assert.deepEqual((await nuevo.post('/portal/my-tickets', {})).data.tickets, []);
  assert.equal((await nuevo.post('/portal/ticket', { number: tB.number })).status, 404);
  assert.equal((await nuevo.post('/portal/lookup', { number: tB.number })).status, 404);
  assert.equal((await nuevo.post('/portal/tickets', { name: 'x', email: 'x@hanseatica.com', subject: 'Hola', body_text: 'x' })).status, 409);
  // Con contacto del directorio, el ticket va a ese contacto aunque la cuenta traiga otro correo primero
  const bruno = await msClient('oid-bruno', ['bruno.paz@hanseatica.com'], 'Bruno Paz');
  const r = await bruno.post('/portal/tickets', { name: 'x', email: 'x@hanseatica.com', subject: 'Teclado', body_text: 'x' });
  ok(r);
  assert.equal((await one('select c.email from tickets t join contacts c on c.id=t.contact_id where t.number=$1', [r.data.number])).email, 'bpaz@hanseatica.com');
});

test('cuentas invitadas y correos de la cuenta', () => {
  const tid = MS.MS_TENANT_ID;
  assert.equal(isGuestAccount({ preferred_username: 'ext_gmail.com#EXT#@hanseatica.onmicrosoft.com' }, tid), true);
  assert.equal(isGuestAccount({ preferred_username: 'a@hanseatica.com', idp: 'https://sts.windows.net/99999999-0000-0000-0000-000000000000/' }, tid), true);
  assert.equal(isGuestAccount({ preferred_username: 'a@hanseatica.com', acct: 1 }, tid), true);
  assert.equal(isGuestAccount({ preferred_username: 'a@hanseatica.com', acct: 0 }, tid), false);
  assert.deepEqual(sessionEmails({ preferred_username: 'cgerardi@hanseatica.com', email: 'Carlos.Gerardi@hanseatica.com' }), ['carlos.gerardi@hanseatica.com', 'cgerardi@hanseatica.com']);
});

test('apagar el ingreso con Microsoft del portal cierra las sesiones abiertas', async () => {
  const ana = await msClient('oid-ana', ['aruiz@hanseatica.com'], 'Ana Ruiz');
  ok(await ana.post('/portal/my-tickets', {}));
  ok(await admin.put('/admin/settings/helpdesk', { portal_microsoft: false }));
  assert.equal((await ana.post('/portal/my-tickets', {})).status, 401);
  ok(await admin.put('/admin/settings/helpdesk', { portal_microsoft: true }));
  ok(await ana.post('/portal/my-tickets', {}));
});

test('anular los enlaces del portal también cierra estas sesiones; salir borra la cookie', async () => {
  const ana = await msClient('oid-ana', ['aruiz@hanseatica.com'], 'Ana Ruiz');
  ok(await ana.post('/portal/my-tickets', {}));
  const out = await ana.post('/portal/logout', {});
  ok(out);
  assert.match(String([].concat(out.headers['set-cookie'])[0]), /^hd_portal=;.*Max-Age=0/);
  assert.equal((await ana.post('/portal/my-tickets', {})).status, 401);
  const again = await msClient('oid-ana', ['aruiz@hanseatica.com'], 'Ana Ruiz');
  ok(await admin.post('/admin/portal/revoke-links', {}));
  assert.equal((await again.post('/portal/my-tickets', {})).status, 401);
  assert.equal((await again.get('/portal/config')).data.me, null);
});

test('ingreso con Microsoft desde el portal: misma app y redirect URI; se puede apagar', async () => {
  for (const k of Object.keys(MS)) delete process.env[k];
  assert.equal((await anon.get('/auth/ms/start?portal=1')).status, 400, 'sin la app de Entra configurada');
  assert.equal((await anon.get('/portal/config')).data.microsoft, false);
  Object.assign(process.env, MS);
  assert.equal((await anon.get('/portal/config')).data.microsoft, true);
  const r = await anon.get('/auth/ms/start?portal=1');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.location);
  assert.equal(loc.host, 'login.microsoftonline.com');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/ms/callback');
  // Si la vuelta falla, vuelve al portal (no a la pantalla de ingreso de agentes)
  const back = await makeClient().get(`/auth/ms/callback?state=${encodeURIComponent(loc.searchParams.get('state'))}&code=x`);
  assert.equal(back.status, 302);
  assert.match(back.headers.location, /^\/portal#\/ingresar\?error=/);
  ok(await admin.put('/admin/settings/helpdesk', { portal_microsoft: false }));
  assert.equal((await anon.get('/portal/config')).data.microsoft, false);
  assert.equal((await anon.get('/auth/ms/start?portal=1')).status, 400);
});
