import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { PGlite } = await import('@electric-sql/pglite');

const admin = makeClient();
const sup = makeClient();
const ok = (r, m = '') => assert.ok(r.status < 300, `${m} → ${r.status} ${JSON.stringify(r.data)}`);

test('instalación y login del superadmin', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Admin', email: 'admin@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: true }));
  let r = await sup.post('/auth/login', { email: 'superadmin', password: 'mala' });
  assert.equal(r.status, 401);
  r = await sup.post('/auth/login', { email: 'SuperAdmin', password: 'Super-Clave-Muy-Larga-2026' });
  ok(r, 'login super');
  r = await sup.get('/auth/me');
  assert.equal(r.data.user.role, 'superadmin');
  r = await sup.post('/me/password', { password: 'otra-clave-123' });
  assert.equal(r.status, 400, 'la clave se cambia en Vercel');
  r = await admin.get('/meta');
  const su = r.data.users.find((u) => u.role === 'superadmin');
  assert.equal(su.active, false, 'no aparece para asignar');
});

test('bloqueo por intentos fallidos', async () => {
  const atk = makeClient();
  for (let i = 0; i < 5; i++) await atk.post('/auth/login', { email: 'nadie@x.com', password: 'x' });
  const r = await atk.post('/auth/login', { email: 'nadie@x.com', password: 'x' });
  assert.equal(r.status, 429);
});

test('solo el superadmin gestiona administradores', async () => {
  let r = await admin.post('/admin/users', { name: 'Otro Admin', email: 'otro@hanseatica.com', role: 'admin', password: 'Rio-de-la-Plata-9' });
  assert.equal(r.status, 403);
  r = await admin.get('/admin/users');
  assert.ok(!r.data.some((u) => u.role === 'superadmin'), 'el admin no ve al superadmin');
  const suId = (await sup.get('/auth/me')).data.user.id;
  r = await admin.patch(`/admin/users/${suId}`, { name: 'hack' });
  assert.equal(r.status, 403);
  r = await sup.post('/admin/users', { name: 'Otro Admin', email: 'otro@hanseatica.com', role: 'admin', password: 'Rio-de-la-Plata-9' });
  ok(r, 'super crea admin');
  const otroId = r.data.id;
  r = await admin.patch(`/admin/users/${otroId}`, { active: false });
  assert.equal(r.status, 403, 'admin no modifica a otro admin');
  r = await admin.post('/admin/users', { name: 'Agente', email: 'agente@hanseatica.com', role: 'agent' });
  ok(r, 'admin sigue creando agentes');
  r = await sup.del(`/admin/users/${otroId}`);
  ok(r, 'super elimina admin');
});

test('borrado definitivo y vaciar papelera', async () => {
  const t1 = (await admin.post('/tickets', { subject: 'Borrar 1', contact_email: 'x@hanseatica.com' })).data.number;
  const t2 = (await admin.post('/tickets', { subject: 'Borrar 2', contact_email: 'x@hanseatica.com' })).data.number;
  await admin.post('/tickets/bulk', { numbers: [t1, t2], action: 'trash' });
  let r = await admin.post('/tickets/bulk', { numbers: [t1], action: 'delete' });
  assert.equal(r.status, 403);
  r = await admin.del(`/tickets/${t1}`);
  assert.equal(r.status, 403);
  r = await sup.del(`/tickets/${t1}`);
  ok(r);
  r = await admin.post('/super/empty-trash', {});
  assert.equal(r.status, 403);
  r = await sup.post('/super/empty-trash', {});
  assert.equal(r.data.trash, 1);
});

test('respaldo restaurable en otra base', async () => {
  let r = await admin.get('/super/backup');
  assert.equal(r.status, 403);
  r = await sup.get('/super/backup');
  assert.equal(r.status, 200);
  const sql = zlib.gunzipSync(Buffer.from(r.data, 'binary')).toString('utf8');
  assert.ok(sql.includes('json_populate_recordset'));
  const db = new PGlite();
  await db.exec(sql);
  const n = await db.query('select count(*)::int as n from tickets');
  const orig = (await sup.get('/super/info')).data.counts.tickets;
  assert.equal(n.rows[0].n, orig);
  const iss = await db.query("select count(*)::int as n from issues where parent_id is not null");
  assert.ok(iss.rows[0].n > 0, 'relaciones padre/hijo restauradas');
  const lab = await db.query('select labels from issues limit 1');
  assert.ok(Array.isArray(lab.rows[0].labels));
});

test('auditoría y cierre de todas las sesiones', async () => {
  let r = await sup.get('/super/audit');
  ok(r);
  const acts = r.data.items.map((x) => x.action);
  for (const a of ['login', 'login_failed', 'config', 'ticket_purged', 'empty_trash', 'backup']) assert.ok(acts.includes(a), `falta ${a}`);
  assert.ok(!JSON.stringify(r.data.items).includes('Rio-de-la-Plata-9'), 'no guarda claves');
  r = await admin.get('/super/audit');
  assert.equal(r.status, 403);
  await new Promise((res) => setTimeout(res, 1100));
  r = await sup.post('/super/revoke-sessions', {});
  ok(r);
  r = await admin.get('/auth/me');
  assert.equal(r.data.user, null, 'el admin quedó afuera');
  r = await sup.get('/auth/me');
  assert.equal(r.data.user.role, 'superadmin', 'el superadmin sigue adentro');
});

test('sin la variable, el superadmin deja de existir', async () => {
  const keep = process.env.SUPERADMIN_PASSWORD;
  delete process.env.SUPERADMIN_PASSWORD;
  const r = await sup.get('/auth/me');
  assert.equal(r.data.user, null);
  process.env.SUPERADMIN_PASSWORD = keep;
});
