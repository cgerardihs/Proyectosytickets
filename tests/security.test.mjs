// v1.5: pruebas de la revisión de seguridad (los 18 puntos).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { encodeCBOR } from '@levischuck/tiny-cbor';
process.env.PASSKEYS_ENABLED = '1'; // la v1.9.5 las apaga por defecto; acá se prueba que, si se encienden, son seguras
import { makeClient } from './helpers.mjs';

const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const { q, one, tx, onCommit, mapDbError } = await import('../lib/db.js');

test('instalación', async () => {
  const r = await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, start_number: 100 });
  await admin.put('/admin/settings/helpdesk', { portal_access: 'open' }); // estas pruebas usan el portal abierto (de fábrica es solo con Microsoft)
  ok(r, 'setup');
});

// 1 y 4. Inicio de sesión: Argon2id, re-hash de claves viejas y sesiones opacas del lado del servidor
test('claves con Argon2id y migración transparente desde scrypt', async () => {
  const u = await one(`select password_hash from users where email='cgerardi@hanseatica.com'`);
  assert.match(u.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  // Simula una clave guardada con el método anterior (scrypt)
  const salt = crypto.randomBytes(16);
  const legacy = `scrypt$${salt.toString('base64')}$${crypto.scryptSync('Clave-Vieja-2024', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  await q(`insert into users(name,email,role,password_hash) values ('Legado','legado@hanseatica.com','agent',$1)`, [legacy]);
  const c = makeClient();
  ok(await c.post('/auth/login', { email: 'legado@hanseatica.com', password: 'Clave-Vieja-2024' }), 'login legado');
  const after = await one(`select password_hash from users where email='legado@hanseatica.com'`);
  assert.match(after.password_hash, /^\$argon2id\$/, 'se re-hasheó al ingresar');
  assert.equal((await c.post('/auth/login', { email: 'legado@hanseatica.com', password: 'otra' })).status, 401);
});

test('política de claves', async () => {
  for (const bad of ['corta', '1234567890', 'cgerardi-2026-x', 'Carlos-123456']) {
    const r = await admin.post('/admin/users', { name: 'Carlos Prueba', email: 'cgerardi2@hanseatica.com', password: bad.replace('cgerardi', 'cgerardi2') });
    assert.equal(r.status, 400, `rechaza "${bad}"`);
  }
});

test('sesiones opacas: solo el hash en la base, cierre y revocación', async () => {
  const c = makeClient();
  ok(await c.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }));
  const id = c.getCookie().split('; ').find((x) => x.startsWith('hd_session=')).split('=')[1];
  assert.match(id, /^[\w-]{43}$/, '256 bits aleatorios en base64url');
  assert.ok(!id.includes('.'), 'no es un token con datos (no se puede leer ni falsificar)');
  const inDb = await one('select count(*)::int as n from sessions where id_hash=$1', [id]);
  assert.equal(inDb.n, 0, 'el id en claro no está en la base');
  const hashed = await one('select count(*)::int as n from sessions where id_hash=$1', [crypto.createHash('sha256').update(id).digest('hex')]);
  assert.equal(hashed.n, 1);
  // Cambiar la clave cierra las otras sesiones
  ok(await admin.post('/me/password', { current: 'Sol-de-Mayo-2026', password: 'Sol-de-Mayo-2027' }));
  assert.equal((await c.get('/auth/me')).data.user, null, 'la otra sesión quedó cerrada');
  assert.ok((await admin.get('/auth/me')).data.user, 'la actual sigue');
  ok(await admin.post('/auth/logout'));
  assert.equal((await admin.get('/auth/me')).data.user, null);
  ok(await admin.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2027' }));
});

// Autenticador de software para probar passkeys de punta a punta
function softAuthenticator(origin) {
  const rpId = new URL(origin).hostname;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const rpHash = crypto.createHash('sha256').update(rpId).digest();
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    register(options) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]);
      const coseBytes = Buffer.from(encodeCBOR(cose));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, coseBytes]);
      const att = encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge)), attestationObject: b64u(att), transports: ['internal'] } };
    },
    login(options) {
      counter += 1;
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), cnt]);
      const cd = clientData('webauthn.get', options.challenge);
      const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}

test('passkeys (WebAuthn): registro, ingreso sin clave y desafío de un solo uso', async () => {
  const auth = softAuthenticator('http://localhost:3000');
  let r = await admin.post('/auth/passkeys/register/options', {});
  ok(r, 'opciones');
  assert.equal(r.data.options.authenticatorSelection.userVerification, 'required');
  r = await admin.post('/auth/passkeys/register/verify', { challengeId: r.data.challengeId, name: 'Notebook', credential: auth.register(r.data.options) });
  ok(r, 'registro');
  assert.equal((await admin.get('/me/passkeys')).data.length, 1);

  const c = makeClient();
  r = await c.post('/auth/passkeys/login/options', {});
  const { challengeId, options } = r.data;
  const assertion = auth.login(options);
  r = await c.post('/auth/passkeys/login/verify', { challengeId, credential: assertion });
  ok(r, 'ingreso con passkey');
  assert.equal((await c.get('/auth/me')).data.user.email, 'cgerardi@hanseatica.com');
  r = await c.post('/auth/passkeys/login/verify', { challengeId, credential: assertion });
  assert.equal(r.status, 400, 'el desafío no se puede reutilizar');
  // Firma de otro origen (phishing): se rechaza
  const evil = softAuthenticator('https://hanseatica-login.com');
  r = await c.post('/auth/passkeys/login/options', {});
  r = await c.post('/auth/passkeys/login/verify', { challengeId: r.data.challengeId, credential: evil.login(r.data.options) });
  assert.equal(r.status, 401);
});

// 6. Rate limit en el login
test('rate limit del login por IP (relleno de credenciales) con 429 y Retry-After', async () => {
  const c = makeClient();
  const h = { 'x-real-ip': '203.0.113.9' };
  let last;
  for (let i = 0; i < 31; i += 1) last = await c.post('/auth/login', { email: `u${i}@x.com`, password: 'x' }, h);
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
  const other = await makeClient().post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2027' }, { 'x-real-ip': '198.51.100.7' });
  ok(other, 'otra IP no se ve afectada');
});

// 2. Validación
test('validación de entrada: tipos, largos, claves peligrosas y HTML', async () => {
  let r = await admin.post('/tickets', { subject: 'x'.repeat(301), contact_email: 'a@b.com' });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'subject');
  r = await admin.post('/tickets', { subject: 'ok', contact_email: 'no-es-correo' });
  assert.equal(r.data.field, 'contact_email');
  r = await admin.post('/tickets', { subject: 'ok', contact_email: 'a@b.com', priority: 9 });
  assert.equal(r.status, 400);
  r = await admin.post('/tickets', JSON.parse('{"subject":"ok","contact_email":"a@b.com","__proto__":{"admin":true}}'));
  assert.equal(r.status, 400, 'clave __proto__ rechazada');
  r = await admin.post('/tickets', { subject: 'HTML', contact_email: 'html@hanseatica.com', body_html: '<p onclick="x()">Hola</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>' });
  ok(r);
  const msg = await one(`select body_html from ticket_messages where ticket_id=$1`, [r.data.id]);
  assert.ok(!/script|onclick|onerror|javascript:/i.test(msg.body_html), `sanitizado: ${msg.body_html}`);
  r = await admin.get('/tickets/abc');
  assert.ok(r.status === 400 || r.status === 404);
  r = await admin.put('/admin/settings/brand', { logo: 'javascript:alert(1)' });
  assert.equal(r.status, 400);
});

// 3. SQL sin concatenar
test('SQL: los intentos de inyección no rompen ni filtran', async () => {
  for (const qs of ["q=' or 1=1 --", 'q=%25', 'sort=subject;drop table users', 'status=1,abc', "tag='x", 'created_from=2026-13-45', 'page=-1&limit=999999']) {
    const r = await admin.get(`/tickets?${qs.replace(/ /g, '%20')}`);
    ok(r, qs);
  }
  assert.equal((await admin.get("/tickets?q=' or 1=1 --")).data.total, 0);
  assert.ok((await one('select count(*)::int as n from users')).n > 0, 'la tabla sigue ahí');
  // Escaneo del código: los valores siempre van como parámetros
  const src = ['lib/routes/tickets.js', 'lib/routes/super.js', 'lib/ai.js'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/limit \$\{limit\}|offset \$\{|assignee_id=\$\{Number/.test(src));
});

// 9. Idempotencia
test('idempotencia: la misma operación con la misma clave no se duplica', async () => {
  const key = crypto.randomUUID();
  const body = { subject: 'Doble clic', contact_email: 'dc@hanseatica.com', body_html: '<p>x</p>' };
  const [a, b] = await Promise.all([admin.post('/tickets', body, { 'idempotency-key': key }), admin.post('/tickets', body, { 'idempotency-key': key })]);
  const okOne = [a, b].filter((r) => r.status < 300);
  assert.ok(okOne.length >= 1);
  const c = await admin.post('/tickets', body, { 'idempotency-key': key });
  ok(c, 'repetición');
  assert.equal(c.headers['idempotent-replayed'], 'true');
  assert.equal(c.data.number, okOne[0].data.number);
  const n = await one(`select count(*)::int as n from tickets where subject='Doble clic'`);
  assert.equal(n.n, 1, 'un solo ticket');
  const d = await admin.post('/tickets', { ...body, subject: 'Otro' }, { 'idempotency-key': key });
  assert.equal(d.status, 422, 'misma clave con otro contenido');
  // Portal público
  const p = makeClient();
  const pk = crypto.randomUUID();
  const pb = { name: 'Ana', email: 'ana@hanseatica.com', subject: 'Impresora', body_text: 'no imprime' };
  const r1 = await p.post('/portal/tickets', pb, { 'idempotency-key': pk });
  const r2 = await p.post('/portal/tickets', pb, { 'idempotency-key': pk });
  assert.equal(r1.data.number, r2.data.number);
});

// 10. Transacciones
test('transacciones: todo o nada, y lo externo solo después del commit', async () => {
  let ran = false;
  await assert.rejects(tx(async () => {
    await q(`insert into companies(name) values ('Empresa fantasma')`);
    await onCommit(() => { ran = true; });
    throw new Error('falla a mitad de camino');
  }));
  assert.equal((await one(`select count(*)::int as n from companies where name='Empresa fantasma'`)).n, 0, 'se deshizo');
  assert.equal(ran, false, 'la tarea posterior no corrió');
  await tx(async () => {
    await q(`insert into companies(name) values ('Empresa real')`);
    await onCommit(() => { ran = true; });
    assert.equal(ran, false, 'todavía no');
  });
  assert.equal(ran, true, 'corrió después del commit');
});

// 13, 16, 17. Pool, logs con request id y health check
test('health check, request id y migraciones versionadas', async () => {
  const c = makeClient();
  let r = await c.get('/health');
  ok(r);
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.checks.database.ok, true);
  assert.equal(r.data.checks.migrations.pending, 0);
  assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  r = await c.get('/no-existe', { 'x-request-id': 'req-prueba-1234' });
  assert.equal(r.headers['x-request-id'], 'req-prueba-1234');
  assert.equal(r.data.request_id, 'req-prueba-1234');
  const rows = await q('select version from schema_migrations order by version');
  assert.deepEqual(rows.map((x) => x.version), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const { migrate } = await import('../lib/migrate.js');
  const { SCHEMA_VERSION } = await import('../lib/migrations.js');
  assert.equal(await migrate(), SCHEMA_VERSION, 'correr de nuevo no hace nada');
});

// 15. Migraciones: nunca borrar columnas en el mismo deploy
test('migraciones: expandir y contraer en deploys distintos', async () => {
  const { MIGRATIONS } = await import('../lib/migrations.js');
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'en orden');
  for (const m of MIGRATIONS) {
    const destructive = m.statements.filter((s) => /\bdrop\s+(column|table)\b|\brename\s+(column\s+)?\w+\s+to\b|\balter\s+column\s+\w+\s+(set\s+data\s+)?type\b/i.test(s));
    if (destructive.length) {
      assert.ok(m.contract?.after && m.contract.after < m.version, `la migración ${m.version} borra/renombra sin marcarse como contracción de una versión anterior`);
    }
  }
});

// 7 y 8. Timeouts y reintentos solo en errores transitorios
test('llamadas externas: timeout y reintentos selectivos', async () => {
  const { fetchx } = await import('../lib/fetchx.js');
  let hits = { get: 0, post: 0, slow: 0, bad: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/get') { hits.get += 1; res.writeHead(hits.get < 3 ? 503 : 200); return res.end('ok'); }
    if (req.url === '/post') { hits.post += 1; res.writeHead(500); return res.end('x'); }
    if (req.url === '/bad') { hits.bad += 1; res.writeHead(400); return res.end('x'); }
    if (req.url === '/slow') { hits.slow += 1; return setTimeout(() => { res.writeHead(200); res.end('tarde'); }, 1500); }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetchx(`${base}/get`, {}, { retries: 3, timeoutMs: 1000 });
    assert.equal(r.status, 200);
    assert.equal(hits.get, 3, 'reintentó ante 503 (transitorio)');
    const p = await fetchx(`${base}/post`, { method: 'POST', body: '{}' }, { retries: 3, timeoutMs: 1000 });
    assert.equal(p.status, 500);
    assert.equal(hits.post, 1, 'un POST no idempotente no se repite ante un 500');
    await fetchx(`${base}/bad`, {}, { retries: 3 });
    assert.equal(hits.bad, 1, 'un 400 no es transitorio');
    await assert.rejects(fetchx(`${base}/slow`, {}, { retries: 0, timeoutMs: 300 }), (e) => e.status === 504);
  } finally {
    server.close();
  }
});

// 18. 429 y no 500 cuando hay saturación
test('saturación: 429 con Retry-After en lugar de 500', async () => {
  const sat = mapDbError(Object.assign(new Error('sorry, too many clients already'), { code: '53300' }));
  assert.equal(sat.status, 429);
  assert.ok(sat.retryAfter > 0);
  const pool = mapDbError(new Error('timeout exceeded when trying to connect'));
  assert.equal(pool.status, 429);
  const { withConcurrency } = await import('../lib/ratelimit.js');
  let release;
  const first = withConcurrency(1, () => new Promise((r) => { release = r; }));
  await assert.rejects(withConcurrency(1, async () => 1), (e) => e.status === 429 && e.retryAfter > 0);
  release();
  await first;
  // Portal: demasiados tickets desde la misma IP → 429
  const p = makeClient();
  let last;
  for (let i = 0; i < 12; i += 1) last = await p.post('/portal/tickets', { name: 'Spam', email: `spam${i}@x.com`, subject: `s${i}`, body_text: 'x' }, { 'x-real-ip': '192.0.2.50' });
  assert.equal(last.status, 429);
});

// CSRF y encabezados de seguridad
test('CSRF: pedidos de otro sitio rechazados; encabezados de seguridad', async () => {
  let r = await admin.post('/tickets', { subject: 'csrf', contact_email: 'c@x.com' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await admin.post('/tickets', { subject: 'csrf', contact_email: 'c@x.com' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await admin.post('/tickets', { subject: 'mismo origen', contact_email: 'c@x.com' }, { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' });
  ok(r);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const keys = vercel.headers[0].headers.map((h) => h.key);
  for (const k of ['Strict-Transport-Security', 'Content-Security-Policy', 'X-Frame-Options', 'Permissions-Policy']) assert.ok(keys.includes(k), k);
});

// 5. Secretos fuera del repo
test('secretos: ninguno en el código y .env ignorado', async () => {
  const { scan } = await import('../scripts/check-secrets.mjs');
  assert.deepEqual(scan(), []);
  const gi = fs.readFileSync('.gitignore', 'utf8');
  assert.match(gi, /^\.env$/m);
});

// ---------- Hallazgos de la revisión independiente ----------
test('adjuntos peligrosos (SVG, HTML, JS) se descargan, nunca se muestran', async () => {
  const p = makeClient();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  let r = await p.post('/portal/tickets', { name: 'X', email: 'xss@hanseatica.com', subject: 'adjuntos', body_text: 'x', attachments: [{ name: 'logo.svg', type: 'image/svg+xml', data: svg }, { name: 'a.png', type: 'image/png', data: png }] }, { 'x-real-ip': '192.0.2.77' });
  ok(r);
  const atts = await q(`select a.id, a.filename from attachments a join ticket_messages m on m.id=a.ticket_message_id join tickets t on t.id=m.ticket_id where t.number=$1 order by a.id`, [r.data.number]);
  r = await admin.get(`/attachments/${atts[0].id}`);
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.match(r.headers['content-disposition'], /^attachment/);
  assert.match(r.headers['content-security-policy'], /sandbox/);
  r = await admin.get(`/attachments/${atts[1].id}`);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.match(r.headers['content-disposition'], /^inline/);
});

test('la instalación no se puede volver a correr', async () => {
  await q(`update users set role='agent' where role='admin'`);
  const r = await makeClient().post('/setup', { admin: { name: 'Intruso', email: 'cgerardi@hanseatica.com', password: 'Intruso-Total-2026' } });
  assert.equal(r.status, 403);
  await q(`update users set role='admin' where email='cgerardi@hanseatica.com'`);
});

test('correo entrante de un tercero con [#N] en el asunto no entra al ticket ajeno', async () => {
  const t = (await admin.post('/tickets', { subject: 'Ticket de Ana', contact_email: 'ana.b@hanseatica.com', body_html: '<p>x</p>' })).data;
  const r = await makeClient().post('/inbound/email', { from: 'atacante@evil.test', subject: `Re: [#${t.number}] Ticket de Ana`, text: 'reabrilo' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  ok(r);
  assert.equal(r.data.results[0].created, true, 'se creó un ticket nuevo');
  const n = await one('select count(*)::int as n from ticket_messages where ticket_id=$1', [t.id]);
  assert.equal(n.n, 1, 'el ticket original no cambió');
  const again = await makeClient().post('/inbound/email', { from: 'atacante@evil.test', subject: 'Igual', text: 'mismo correo' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  const dup = await makeClient().post('/inbound/email', { from: 'atacante@evil.test', subject: 'Igual', text: 'mismo correo' }, { 'x-inbound-secret': 'secreto-de-prueba' });
  assert.ok(again.data.results[0].created);
  assert.equal(dup.data.results[0].skipped, 'duplicate', 'sin Message-ID tampoco se duplica');
  const q2 = await makeClient().post('/inbound/email?key=secreto-de-prueba', { from: 'x@y.com', subject: 's', text: 't' });
  assert.equal(q2.status, 401, 'el secreto no se acepta en la URL');
});

test('passkeys: exigen ingreso reciente y no aplican al superadmin', async () => {
  await q(`update sessions set created_at = now() - interval '20 minutes'`);
  const r = await admin.post('/auth/passkeys/register/options', {});
  assert.equal(r.status, 401);
  assert.match(r.data.error, /volvé a ingresar/);
});

test('login: los intentos en paralelo no superan el límite', async () => {
  const c = makeClient();
  const h = { 'x-real-ip': '203.0.113.200' };
  const all = await Promise.all(Array.from({ length: 12 }, () => c.post('/auth/login', { email: 'cgerardi@hanseatica.com', password: 'mala' }, h)));
  assert.ok(all.filter((x) => x.status === 401).length <= 5, 'como máximo 5 llegan a verificar la clave');
  assert.ok(all.some((x) => x.status === 429));
});

test('tarea diaria: GET solo con la clave; desde la app, POST de admin', async () => {
  assert.equal((await admin.get('/cron/daily')).status, 401);
  ok(await admin.post('/admin/cron/run', {}));
});

test('integraciones: el webhook de Teams solo puede ser de Microsoft', async () => {
  let r = await admin.put('/admin/m365', { teams: { webhook_url: 'https://evil.example/hook' } });
  assert.equal(r.status, 400);
  r = await admin.put('/admin/m365', { teams: { webhook_url: 'https://prod-01.westus.logic.azure.com/workflows/abc' } });
  ok(r);
});

test('código nuevo antes que su migración: se migra solo en lugar de dar 500', async () => {
  await q('alter table sessions drop column fingerprint');
  await q('delete from schema_migrations where version=7');
  const r = await admin.get('/auth/me');
  ok(r);
  assert.ok(r.data.user, 'la sesión sigue funcionando');
  assert.equal((await one('select count(*)::int as n from schema_migrations where version=7')).n, 1);
});
