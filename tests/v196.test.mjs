// v1.9.6: revisión de seguridad (informe externo). Correo entrante que no se traba, permisos del agente, enlaces del
// portal, IA, topes de envío, CSRF, respaldo y logo.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { sanitizeHtml } = await import('../lib/sanitize.js');
const { signToken } = await import('../lib/auth.js');
const { scrubAiText } = await import('../lib/ai.js');
const { failedTooOften } = await import('../lib/m365.js');
const { MAIL_LIMITS } = await import('../lib/routes/tickets.js');

const admin = makeClient();
const sup = makeClient();
const agent = makeClient();
const supervisor = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const U = {};

test('instalación y usuarios', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }); // estas pruebas usan el portal abierto (de fábrica es solo con Microsoft)
  ok(await sup.post('/auth/login', { email: 'superadmin', password: 'Super-Clave-Muy-Larga-2026' }));
  for (const [k, c, role] of [['agente', agent, 'agent'], ['super', supervisor, 'supervisor']]) {
    const r = await admin.post('/admin/users', { name: `Usuario ${k}`, email: `${k}@hanseatica.com`, password: 'Tango-Sur-Riachuelo-26', role });
    ok(r, k);
    U[k] = r.data;
    ok(await c.post('/auth/login', { email: `${k}@hanseatica.com`, password: 'Tango-Sur-Riachuelo-26' }));
  }
});

test('correo entrante: una entidad fuera de Unicode no tira error; un correo que falla 3 veces va a cuarentena', async () => {
  for (const html of ['<a href="&#9999999;">x</a>', '<a href="&#x110000;">x</a>', '<p title="&#55296;">x</p>', '<img src="&#99999999999;">']) {
    assert.doesNotThrow(() => sanitizeHtml(html), html);
  }
  assert.equal(sanitizeHtml('<a href="&#106;avascript:alert(1)">a</a>').includes('href'), false, 'sigue bloqueando javascript:');
  // Por el webhook de correo entrante también entra sin error
  const r = await admin.post('/inbound/email', { From: 'Externo <x@otra.com>', Subject: 'Raro', Body: '<p>Hola <a href="&#9999999;">link</a></p>', InternetMessageId: '<raro@mail>' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  ok(r, 'inbound');
  assert.equal(await failedTooOften('msg-1'), false);
  assert.equal(await failedTooOften('msg-1'), false);
  assert.equal(await failedTooOften('msg-1'), true, 'al tercer intento');
  assert.equal(await failedTooOften('msg-1'), false, 'y vuelve a empezar');
});

test('permisos del agente: masivos acotados, combinar y exportar para supervisores; sprints para quien configura', async () => {
  const nums = [];
  for (let i = 0; i < 12; i++) nums.push((await admin.post('/tickets', { subject: `Masivo ${i}`, contact_email: 'ana@hanseatica.com' })).data.number);
  let r = await agent.post('/tickets/bulk', { numbers: nums, action: 'trash' });
  assert.equal(r.status, 403, 'más de 10 a la papelera');
  ok(await agent.post('/tickets/bulk', { numbers: nums.slice(0, 3), action: 'spam' }), 'de a pocos sí');
  ok(await supervisor.post('/tickets/bulk', { numbers: nums, action: 'restore' }), 'el supervisor sin tope');
  assert.equal((await agent.post(`/tickets/${nums[0]}/merge`, { into: nums[1] })).status, 403);
  ok(await supervisor.post(`/tickets/${nums[0]}/merge`, { into: nums[1] }));
  assert.equal((await agent.get('/tickets/export')).status, 403);
  assert.equal((await supervisor.get('/tickets/export')).status, 200);
  ok(await admin.post('/projects', { key: 'SPR', name: 'Con sprints', template: 'scrum', member_ids: [U.agente.id] }));
  assert.equal((await agent.post('/projects/SPR/sprints', {})).status, 403);
  const s = await admin.post('/projects/SPR/sprints', {});
  ok(s);
  assert.equal((await agent.patch(`/sprints/${s.data.id}`, { name: 'X' })).status, 403);
  assert.equal((await agent.post(`/sprints/${s.data.id}/start`, {})).status, 403);
  assert.equal((await agent.del(`/sprints/${s.data.id}`)).status, 403);
  ok(await supervisor.post(`/sprints/${s.data.id}/start`, {}));
  assert.equal((await agent.post(`/sprints/${s.data.id}/complete`, { move_to: 'backlog' })).status, 403);
});

test('portal: el enlace no se renueva, vence a los 30 días, se puede anular y no viaja en la URL de los adjuntos', async () => {
  const p = makeClient();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const r = await p.post('/portal/tickets', { name: 'Facundo Soto', email: 'fsoto@hanseatica.com', subject: 'Portal', body_text: 'Hola', attachments: [{ name: 'a.png', type: 'image/png', data: png }] });
  ok(r);
  const token = r.data.token;
  const v1 = await p.post('/portal/ticket', { token });
  ok(v1);
  assert.equal(v1.data.token, token, 'devuelve el mismo enlace (sin renovar)');
  const body = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.ok(body.exp - body.iat <= 30 * 86400 + 5, '30 días');

  // Adjuntos: el enlace del ticket ya no sirve en la URL; se pide uno de 5 minutos
  const att = (await q(`select a.id from attachments a join ticket_messages m on m.id=a.ticket_message_id join tickets t on t.id=m.ticket_id where t.number=$1`, [r.data.number]))[0];
  assert.equal((await p.get(`/attachments/${att.id}?token=${encodeURIComponent(token)}`)).status, 401);
  const link = await p.post('/portal/attachment-link', { token, id: att.id });
  ok(link);
  assert.equal((await p.get(link.data.url.replace(/^\/api/, ''))).status, 200);
  const other = (await admin.post('/tickets', { subject: 'Ajeno', contact_email: 'otro@hanseatica.com' })).data;
  void other;
  assert.equal((await p.post('/portal/attachment-link', { token, id: att.id + 999 })).status, 404);

  // Enlaces de antes de la v1.9.6 (180 días, sin fecha de emisión): solo los emitidos hace menos de 30 días
  const t = await one('select id, contact_id from tickets where number=$1', [r.data.number]);
  const legacyOld = signToken({ k: 'pt', t: t.id, c: t.contact_id }, 140 * 86400); // emitido hace 40 días
  const legacyNew = signToken({ k: 'pt', t: t.id, c: t.contact_id }, 170 * 86400); // emitido hace 10 días
  assert.equal((await p.post('/portal/ticket', { token: legacyOld })).status, 401);
  ok(await p.post('/portal/ticket', { token: legacyNew }));

  // Feedback: solo el solicitante actual
  await q('update tickets set contact_id=(select id from contacts where email=$2) where id=$1', [t.id, 'otro@hanseatica.com']);
  assert.equal((await p.post('/portal/ticket/feedback', { token, helpful: true })).status, 401, 'igual que ver o responder: el enlace ya no vale para ese ticket');
  await q('update tickets set contact_id=$2 where id=$1', [t.id, t.contact_id]);

  // Anular todos los enlaces
  assert.equal((await agent.post('/admin/portal/revoke-links', {})).status, 403);
  ok(await admin.post('/admin/portal/revoke-links', {}));
  const { clearSettingsCache } = await import('../lib/settings.js');
  clearSettingsCache();
  assert.equal((await p.post('/portal/ticket', { token })).status, 401, 'anulado');
  const fresh = await p.post('/portal/tickets', { name: 'Facundo Soto', email: 'fsoto@hanseatica.com', subject: 'Otro', body_text: 'Hola' });
  ok(await p.post('/portal/ticket', { token: fresh.data.token }), 'los nuevos sí');
  // Guardar la configuración general no vuelve atrás la anulación
  ok(await admin.put('/admin/settings/helpdesk', { portal_title: 'Centro de ayuda' }));
  clearSettingsCache();
  assert.equal((await p.post('/portal/ticket', { token })).status, 401);
});

test('IA: lo que escribe se limpia de enlaces ajenos y teléfonos', async () => {
  ok(await admin.put('/admin/settings/helpdesk', { portal_trusted_domains: ['hanseatica.com'] }));
  const { clearSettingsCache } = await import('../lib/settings.js');
  clearSettingsCache();
  const out = await scrubAiText('1. Entrá a https://evil.example/login\n2. Mirá https://intranet.hanseatica.com/ayuda\n3. Llamá al +54 11 4444-5555 y dictá el código\n4. Reiniciá 2 veces');
  assert.ok(!out.includes('evil.example'));
  assert.ok(out.includes('https://intranet.hanseatica.com/ayuda'));
  assert.ok(!out.includes('4444-5555'));
  assert.ok(out.includes('Reiniciá 2 veces'), 'los números cortos quedan');
});

test('topes de envío por agente', async () => {
  const t = (await admin.post('/tickets', { subject: 'Reenviar', contact_email: 'ana@hanseatica.com' })).data;
  const many = Array.from({ length: 11 }, (_, i) => `p${i}@otra.com`);
  assert.equal((await agent.post(`/tickets/${t.number}/messages`, { kind: 'forward', to: many, body_html: '<p>x</p>' })).status, 400);
  const prev = MAIL_LIMITS.forwards;
  MAIL_LIMITS.forwards = 1;
  try {
    ok(await agent.post(`/tickets/${t.number}/messages`, { kind: 'forward', to: ['uno@otra.com'], body_html: '<p>x</p>' }));
    assert.equal((await agent.post(`/tickets/${t.number}/messages`, { kind: 'forward', to: ['dos@otra.com'], body_html: '<p>y</p>' })).status, 429);
  } finally { MAIL_LIMITS.forwards = prev; }
  ok(await agent.post(`/tickets/${t.number}/messages`, { kind: 'note', body_html: '<p>las notas no cuentan</p>' }));
});

test('CSRF: Origin null y cuerpos que no son JSON se rechazan', async () => {
  assert.equal((await admin.post('/tickets', { subject: 'x', contact_email: 'a@hanseatica.com' }, { origin: 'null' })).status, 403);
  assert.equal((await admin.post('/tickets', { subject: 'x', contact_email: 'a@hanseatica.com' }, { 'content-type': 'text/plain', 'content-length': '50' })).status, 415);
  assert.equal((await admin.post('/tickets', { subject: 'x', contact_email: 'a@hanseatica.com' }, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '50' })).status, 415);
  ok(await admin.post('/tickets', { subject: 'ok', contact_email: 'a@hanseatica.com' }, { 'content-type': 'application/json; charset=utf-8', 'content-length': '50' }));
});

test('logo: solo PNG, JPG o WebP', async () => {
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
  assert.equal((await admin.put('/admin/settings/brand', { logo: svg })).status, 400);
  ok(await admin.put('/admin/settings/brand', { logo: `data:image/png;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }));
});

test('respaldo: fija el escape de textos, incluye passkeys y deja registrados los adjuntos en el liviano', async () => {
  await q(`insert into webauthn_credentials(id,user_id,public_key,name) values ('cred-1',$1,'pk','Notebook')`, [U.agente.id]);
  const r = await sup.get('/super/backup');
  assert.equal(r.status, 200);
  const sql = zlib.gunzipSync(Buffer.from(r.data, 'binary')).toString('utf8');
  assert.ok(sql.includes('SET standard_conforming_strings = on;'));
  assert.ok(sql.includes('insert into webauthn_credentials'));
  assert.ok(sql.includes('insert into attachments'), 'metadatos de adjuntos');
  assert.ok(!sql.includes('89504e470d0a1a0a') && !sql.includes('iVBORw0KGgo'), 'sin el contenido');
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(sql);
  const n = (await db.query('select count(*)::int as n from attachments')).rows[0].n;
  assert.ok(n >= 1, 'se restaura');
});

test('revisión: anular no se pierde al guardar la configuración, el filtro de IA no rompe datos técnicos y el adjunto vacío avisa', async () => {
  const { clearSettingsCache } = await import('../lib/settings.js');
  const before = (await one(`select (value->>'portal_token_epoch')::int as e from app_settings where key='helpdesk'`)).e;
  await Promise.all([admin.post('/admin/portal/revoke-links', {}), admin.put('/admin/settings/helpdesk', { portal_title: 'Ayuda' })]);
  clearSettingsCache();
  const after = (await one(`select (value->>'portal_token_epoch')::int as e from app_settings where key='helpdesk'`)).e;
  assert.equal(after, before + 1);
  for (const x of ['IP 192.168.10.25', 'fecha 2026-10-18', 'Error 0x80070005', 'tickets 1234 5678', 'versión 10.0.19045.3803', 'soporte@hanseatica.com']) {
    assert.equal(await scrubAiText(x), x, x);
  }
  assert.equal(await scrubAiText('Entrá a evil-site.com/login'), 'Entrá a [enlace quitado]');
  assert.equal(await scrubAiText('escribí a ayuda@evil.com'), 'escribí a [correo quitado]');
  // Adjunto restaurado sin contenido
  const a = (await q(`select id from attachments limit 1`))[0];
  await q(`update attachments set data_b64='' where id=$1`, [a.id]);
  assert.equal((await admin.get(`/attachments/${a.id}`)).status, 410);
});
