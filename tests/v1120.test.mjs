// v1.12: el portal solo con la cuenta de Microsoft (de fábrica) y partes del portal que se muestran u ocultan.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const MS = { MS_TENANT_ID: '11111111-2222-3333-4444-555555555555', MS_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', MS_CLIENT_SECRET: 'secreto' };
Object.assign(process.env, MS);
const { makeClient } = await import('./helpers.mjs');
const { one } = await import('../lib/db.js');
const { portalSign, portalTicketToken } = await import('../lib/tickets-core.js');
const admin = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

async function msClient(oid, emails, name) {
  const c = makeClient();
  c.setCookie(`hd_portal=${await portalSign({ k: 'ps', o: oid, e: emails, n: name }, 3600)}`);
  return c;
}
let ana;
let tAna;
let tBruno;

test('de fábrica el portal pide Microsoft: sin sesión no hay datos ni acciones', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const cfg = (await anon.get('/portal/config')).data;
  assert.equal(cfg.access, 'microsoft');
  assert.equal(cfg.microsoft, true);
  assert.equal(cfg.me, null);
  assert.deepEqual([cfg.categories, cfg.techCategories, cfg.kbCategories], [[], [], []], 'sin sesión no se listan áreas, temas ni artículos');
  assert.equal(cfg.magicLink, false);
  for (const [m, path, body] of [
    ['get', '/portal/kb'], ['get', '/portal/kb/1'], ['get', '/portal/status'],
    ['post', '/portal/tickets', { name: 'X', email: 'x@hanseatica.com', subject: 'Hola', body_text: 'x' }],
    ['post', '/portal/lookup', { number: 1, email: 'x@hanseatica.com' }], ['post', '/portal/login', { email: 'x@hanseatica.com' }],
    ['post', '/portal/my-tickets', {}], ['post', '/portal/ticket', { number: 1 }], ['post', '/portal/ticket/reply', { number: 1, body_text: 'x' }],
    ['post', '/portal/suggest', { subject: 'No anda la impresora del piso', body_text: 'nada' }], ['post', '/portal/ticket/feedback', { number: 1, helpful: true }],
  ]) {
    const r = m === 'get' ? await anon.get(path) : await anon.post(path, body);
    assert.equal(r.status, 401, `${path} sin sesión`);
  }
});

test('con sesión: crea, ve y consulta solo lo suyo; el enlace del correo vale si el ticket es suyo', async () => {
  ana = await msClient('oid-ana', ['aruiz@hanseatica.com'], 'Ana Ruiz');
  const bruno = await msClient('oid-bruno', ['bpaz@hanseatica.com'], 'Bruno Paz');
  const cfg = (await ana.get('/portal/config')).data;
  assert.ok(cfg.categories.length > 0);
  assert.deepEqual(cfg.parts, { kb: true, status: true, lookup: true, create: true, my_tickets: true });
  let r = await ana.post('/portal/tickets', { name: 'x', email: 'otro@hanseatica.com', subject: 'No anda la VPN', body_text: 'Desde ayer' });
  ok(r);
  assert.equal(r.data.token, null);
  tAna = r.data.number;
  tBruno = (await bruno.post('/portal/tickets', { name: 'x', email: 'x@hanseatica.com', subject: 'Sueldo', body_text: 'Privado' })).data.number;
  ok(await ana.post('/portal/ticket', { number: tAna }));
  assert.equal((await ana.post('/portal/ticket', { number: tBruno })).status, 404);
  // Enlace "Ver el ticket" del correo: solo si el ticket es de quien ingresó
  const rowA = await one('select * from tickets where number=$1', [tAna]);
  const rowB = await one('select * from tickets where number=$1', [tBruno]);
  const linkA = await portalTicketToken(rowA, rowA.contact_id);
  const linkB = await portalTicketToken(rowB, rowB.contact_id);
  r = await ana.post('/portal/ticket', { token: linkA });
  ok(r);
  assert.equal(r.data.ticket.number, tAna);
  assert.equal(r.data.token, null, 'con sesión no se emiten enlaces');
  assert.equal((await ana.post('/portal/ticket', { token: linkB })).status, 404, 'el enlace de otro no alcanza');
  assert.equal((await anon.post('/portal/ticket', { token: linkA })).status, 401, 'ni siquiera el propio enlace sin ingresar');
  // Consulta por número: solo lo propio, el correo no se usa
  ok(await ana.post('/portal/lookup', { number: tAna }));
  assert.equal((await ana.post('/portal/lookup', { number: tBruno, email: 'bpaz@hanseatica.com' })).status, 404);
  // Sin enlaces por correo
  assert.equal((await ana.post('/portal/login', { email: 'aruiz@hanseatica.com' })).status, 403);
  assert.equal((await ana.post('/portal/my-tickets', { token: 'x'.repeat(20) })).status, 403);
  assert.deepEqual((await ana.post('/portal/my-tickets', {})).data.tickets.map((t) => t.number), [tAna]);
  ok(await ana.get('/portal/kb'));
  ok(await ana.get('/portal/status'));
});

test('partes del portal: cada una se apaga y deja de responder', async () => {
  const cases = [
    ['portal_show_kb', 'kb', () => ana.get('/portal/kb')],
    ['portal_show_create', 'create', () => ana.post('/portal/tickets', { name: 'x', email: 'x@hanseatica.com', subject: 'Otro', body_text: 'x' })],
    ['portal_show_lookup', 'lookup', () => ana.post('/portal/lookup', { number: tAna })],
    ['portal_show_my_tickets', 'my_tickets', () => ana.post('/portal/my-tickets', {})],
  ];
  for (const [key, part, call] of cases) {
    ok(await admin.put('/admin/settings/helpdesk', { [key]: false }));
    assert.equal((await ana.get('/portal/config')).data.parts[part], false, part);
    assert.equal((await call()).status, 403, `${part} apagado`);
    ok(await admin.put('/admin/settings/helpdesk', { [key]: true }));
    assert.ok((await call()).status < 300, `${part} encendido`);
  }
  assert.equal((await ana.post('/portal/suggest', { subject: 'x' })).status, 200);
  ok(await admin.put('/admin/settings/helpdesk', { portal_show_create: false }));
  assert.equal((await ana.post('/portal/suggest', { subject: 'x' })).status, 403, 'sin crear tickets no hay sugerencias');
  ok(await admin.put('/admin/settings/helpdesk', { portal_show_create: true, critical_portal: false }));
  assert.equal((await ana.get('/portal/config')).data.parts.status, false);
  assert.equal((await ana.get('/portal/status')).data.enabled, false);
  ok(await admin.put('/admin/settings/helpdesk', { critical_portal: true }));
  // Ver el ticket propio sigue andando aunque se oculte "Mis tickets" (es el enlace del correo)
  ok(await admin.put('/admin/settings/helpdesk', { portal_show_my_tickets: false }));
  ok(await ana.post('/portal/ticket', { number: tAna }));
  ok(await admin.put('/admin/settings/helpdesk', { portal_show_my_tickets: true }));
});

test('ingresar vuelve a donde estaba (solo rutas del portal)', async () => {
  const stateOf = (r) => JSON.parse(Buffer.from(new URL(r.headers.location).searchParams.get('state').split('.')[0], 'base64url').toString());
  let r = await anon.get(`/auth/ms/start?portal=1&next=${encodeURIComponent('#/ticket/abc.DEF-123')}`);
  assert.equal(r.status, 302);
  assert.equal(stateOf(r).r, '#/ticket/abc.DEF-123');
  for (const bad of ['https://otro.com', '//otro.com', '#/<script>', 'javascript:alert(1)']) {
    r = await anon.get(`/auth/ms/start?portal=1&next=${encodeURIComponent(bad)}`);
    assert.equal(stateOf(r).r, '', bad);
  }
});

test('abierto como antes si se elige; sin Microsoft configurado, el portal avisa', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }));
  assert.equal((await anon.get('/portal/config')).data.access, 'open');
  ok(await anon.get('/portal/kb'));
  ok(await admin.put('/admin/settings/helpdesk', { portal_access: 'microsoft' }));
  for (const k of Object.keys(MS)) delete process.env[k];
  try {
    const cfg = (await anon.get('/portal/config')).data;
    assert.equal(cfg.microsoft, false);
    assert.equal(cfg.access, 'microsoft');
    assert.equal((await anon.get('/portal/kb')).status, 401);
  } finally { Object.assign(process.env, MS); }
  assert.equal((await admin.put('/admin/settings/helpdesk', { portal_access: 'publico' })).status, 400);
});
