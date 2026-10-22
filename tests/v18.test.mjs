// v1.8: explorador de la base de datos (solo superadmin) y marca Hanseatica.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');

const admin = makeClient();
const sup = makeClient();
const anon = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let meta;
let ticketNo;

test('instalación y permisos: solo el superadmin entra al explorador', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: 'Super-Clave-Muy-Larga-2026' }));
  meta = (await admin.get('/meta')).data;
  const r = await admin.post('/tickets', { subject: 'Impresora del 2do piso', contact_email: 'pmendez@hanseatica.com', contact_name: 'Pablo Méndez', body_html: '<p>No imprime</p>' });
  ok(r);
  ticketNo = r.data.number ?? r.data.ticket?.number;
  for (const path of ['/super/db/tables', '/super/db/tables/users', '/super/db/tables/users/rows']) {
    assert.equal((await admin.get(path)).status, 403, `un administrador no entra a ${path}`);
    assert.equal((await anon.get(path)).status, 401, `sin sesión no entra a ${path}`);
  }
  assert.equal((await admin.post('/super/db/tables/tickets/delete', { pks: [{ id: 1 }], confirm: 'BORRAR' })).status, 403);
  assert.equal((await admin.patch('/super/db/tables/tickets/row', { pk: { id: 1 }, values: { subject: 'x' } })).status, 403);
});

test('tablas: técnicas ocultas, modos y columnas secretas', async () => {
  const { tables } = (await sup.get('/super/db/tables')).data;
  const names = tables.map((t) => t.name);
  for (const hidden of ['sessions', 'webauthn_challenges', 'idempotency_keys', 'rate_limits']) assert.ok(!names.includes(hidden), `${hidden} no aparece`);
  const mode = Object.fromEntries(tables.map((t) => [t.name, t.mode]));
  assert.equal(mode.users, 'edit');
  assert.equal(mode.audit_log, 'read');
  assert.equal(mode.schema_migrations, 'read');
  assert.equal(mode.api_keys, 'read');
  assert.equal(mode.attachments, 'delete');
  assert.equal(tables.find((t) => t.name === 'tickets').rows, 1);
  // Nombres raros o técnicos: 404 (nunca llegan al SQL)
  for (const bad of ['sessions', 'pg_class', 'users;drop table users', 'USERS', '../users', 'information_schema.tables']) {
    assert.equal((await sup.get(`/super/db/tables/${encodeURIComponent(bad)}/rows`)).status, 404, bad);
  }
  const m = (await sup.get('/super/db/tables/users')).data;
  assert.deepEqual(m.pk, ['id']);
  assert.ok(m.columns.find((c) => c.name === 'password_hash').secret);
  const rows = (await sup.get('/super/db/tables/users/rows?size=500')).data;
  assert.equal(rows.size, 200, 'como mucho 200 por página');
  assert.ok(rows.rows.length >= 2);
  assert.ok(rows.rows.every((r) => !('password_hash' in r)), 'el hash de la clave nunca sale');
  const tk = (await sup.get('/super/db/tables/tickets')).data;
  assert.ok(tk.referencedBy.some((x) => x.table === 'ticket_messages' && x.onDelete === 'cascade'));
  assert.deepEqual(tk.columns.find((c) => c.name === 'status_id').fk, { table: 'statuses', column: 'id' });
});

test('filas: búsqueda, filtro por columna, null y orden', async () => {
  let r = (await sup.get('/super/db/tables/statuses/rows?q=espera')).data;
  assert.deepEqual(r.rows.map((x) => x.name), ['En espera de desarrollo']);
  r = (await sup.get('/super/db/tables/statuses/rows?col=kind&val=pending&sort=name&dir=desc')).data;
  assert.deepEqual(r.rows.map((x) => x.name), ['Stdby', 'Pendiente', 'En espera de desarrollo']);
  r = (await sup.get('/super/db/tables/tickets/rows?col=assignee_id&isnull=1')).data;
  assert.equal(r.total, 1);
  // Un patrón de LIKE se busca literal
  r = (await sup.get(`/super/db/tables/statuses/rows?q=${encodeURIComponent('%')}`)).data;
  assert.equal(r.total, 0);
  assert.equal((await sup.get('/super/db/tables/users/rows?col=password_hash&val=x')).status, 400, 'no se filtra por columnas secretas');
  assert.equal((await sup.get('/super/db/tables/users/rows?sort=password_hash')).data.sort, 'id', 'tampoco se ordena por ellas');
});

test('modificar: cambia el registro, valida tipos y queda en la auditoría', async () => {
  const t = await one('select id, subject from tickets where number=$1', [ticketNo]);
  let r = await sup.patch('/super/db/tables/tickets/row', { pk: { id: t.id }, values: { subject: 'Impresora del 2do piso (corregido)', priority: 3, tags: ['hardware', 'piso 2'], custom: { origen: 'db' } } });
  ok(r);
  assert.deepEqual(r.data.changed.sort(), ['custom', 'priority', 'subject', 'tags']);
  const after = await one('select subject, priority, tags, custom from tickets where id=$1', [t.id]);
  assert.equal(after.subject, 'Impresora del 2do piso (corregido)');
  assert.equal(after.priority, 3);
  assert.deepEqual(after.tags, ['hardware', 'piso 2']);
  assert.deepEqual(after.custom, { origen: 'db' });
  const a = await one(`select * from audit_log where action='db_update' order by id desc limit 1`);
  assert.equal(a.details.table, 'tickets');
  assert.deepEqual(a.details.changes.subject, { from: 'Impresora del 2do piso', to: 'Impresora del 2do piso (corregido)' });
  assert.equal(await one(`select count(*)::int as n from audit_log where action='config' and path like '/super/db/%'`).then((x) => x.n), 0, 'sin doble registro');
  // Validaciones
  const bad = async (values, msg) => assert.equal((await sup.patch('/super/db/tables/tickets/row', { pk: { id: t.id }, values })).status, 400, msg);
  await bad({ id: 99 }, 'la clave no se cambia');
  await bad({ no_existe: 1 }, 'columna inexistente');
  await bad({ priority: 'alta' }, 'número inválido');
  await bad({ priority: 2.5 }, 'entero');
  await bad({ subject: null }, 'obligatorio');
  await bad({ tags: 'x' }, 'lista');
  await bad({ created_at: 'ayer' }, 'fecha y hora');
  await bad({ status_id: 99999 }, 'referencia inexistente');
  assert.equal((await sup.patch('/super/db/tables/tickets/row', { pk: { id: 999999 }, values: { subject: 'x' } })).status, 404);
  assert.equal((await sup.patch('/super/db/tables/tickets/row', { pk: {}, values: { subject: 'x' } })).status, 400);
  // Columnas secretas y tablas de solo lectura
  const u = meta.users.find((x) => x.email === 'cgerardi@hanseatica.com');
  assert.equal((await sup.patch('/super/db/tables/users/row', { pk: { id: u.id }, values: { password_hash: 'x' } })).status, 400);
  assert.equal((await sup.patch('/super/db/tables/users/row', { pk: { id: u.id }, values: { role: 'superadmin' } })).status, 400);
  ok(await sup.patch('/super/db/tables/users/row', { pk: { id: u.id }, values: { name: 'Carlos A. Gerardi' } }));
  const superRow = await one(`select id from users where role='superadmin'`);
  assert.equal((await sup.patch('/super/db/tables/users/row', { pk: { id: superRow.id }, values: { name: 'x' } })).status, 403, 'el superadmin no se toca');
  const audit = await one('select id from audit_log order by id limit 1');
  assert.equal((await sup.patch('/super/db/tables/audit_log/row', { pk: { id: audit.id }, values: { action: 'x' } })).status, 403);
  assert.equal((await sup.patch('/super/db/tables/attachments/row', { pk: { id: 1 }, values: { filename: 'x' } })).status, 403);
});

test('revisión: texto con emoji en el corte de la auditoría, valores del sistema protegidos', async () => {
  const t = await one('select id from tickets where number=$1', [ticketNo]);
  const original = (await one('select subject from tickets where id=$1', [t.id])).subject;
  const long = `${'a'.repeat(1999)}😀${'b'.repeat(10)}`;
  const n0 = (await one(`select count(*)::int as n from audit_log where action='db_update'`)).n;
  ok(await sup.patch('/super/db/tables/tickets/row', { pk: { id: t.id }, values: { subject: long } }));
  assert.equal((await one('select subject from tickets where id=$1', [t.id])).subject, long, 'el cambio quedó guardado');
  assert.equal((await one(`select count(*)::int as n from audit_log where action='db_update'`)).n, n0 + 1, 'y auditado');
  ok(await sup.patch('/super/db/tables/tickets/row', { pk: { id: t.id }, values: { subject: original } }));
  // Valores del sistema
  const pk = encodeURIComponent(JSON.stringify({ key: 'session_epoch' }));
  if ((await sup.get(`/super/db/tables/app_settings/row?pk=${pk}`)).status === 200) {
    assert.equal((await sup.patch('/super/db/tables/app_settings/row', { pk: { key: 'session_epoch' }, values: { value: 9999999999 } })).status, 403);
  }
  assert.equal((await sup.patch('/super/db/tables/app_settings/row', { pk: { key: 'brand' }, values: { value: 'texto' } })).status, 400, 'la configuración es un objeto');
  // must_change_password no es un secreto
  const m = (await sup.get('/super/db/tables/users')).data;
  assert.equal(m.columns.find((c) => c.name === 'must_change_password').secret, false);
  // El HTML se limpia
  const u = meta.users.find((x) => x.email === 'cgerardi@hanseatica.com');
  ok(await sup.patch('/super/db/tables/users/row', { pk: { id: u.id }, values: { signature_html: '<p>Saludos</p><img src=x onerror=alert(1)><script>alert(2)</script>' } }));
  const sig = (await one('select signature_html from users where id=$1', [u.id])).signature_html;
  assert.ok(!/onerror|<script/i.test(sig), sig);
  // bigint sin perder precisión
  const big = '9007199254740993';
  const a = await one('select id from audit_log order by id limit 1');
  assert.equal((await sup.get(`/super/db/tables/audit_log/row?pk=${encodeURIComponent(JSON.stringify({ id: a.id }))}`)).status, 200);
  assert.equal((await sup.get(`/super/db/tables/audit_log/row?pk=${encodeURIComponent(JSON.stringify({ id: big }))}`)).status, 404);
  assert.equal((await sup.get(`/super/db/tables/audit_log/row?pk=${encodeURIComponent(JSON.stringify({ id: '1 or 1=1' }))}`)).status, 404);
});

test('configuración guardada en la base: el cambio se ve enseguida', async () => {
  const row = (await sup.get(`/super/db/tables/app_settings/row?pk=${encodeURIComponent(JSON.stringify({ key: 'brand' }))}`)).data.row;
  ok(await sup.patch('/super/db/tables/app_settings/row', { pk: { key: 'brand' }, values: { value: { ...row.value, product: 'Mesa de Ayuda IT' } } }));
  assert.equal((await admin.get('/meta')).data.brand.product, 'Mesa de Ayuda IT');
});

test('borrar: confirmación, cascada, referencias y auditoría', async () => {
  const t = await one('select id from tickets where number=$1', [ticketNo]);
  assert.ok((await one('select count(*)::int as n from ticket_messages where ticket_id=$1', [t.id])).n > 0);
  assert.equal((await sup.post('/super/db/tables/tickets/delete', { pks: [{ id: t.id }], confirm: 'si' })).status, 400, 'sin escribir BORRAR no borra');
  // Un estado en uso no se puede borrar: el error lo explica y no se borra nada
  const st = await one('select status_id from tickets where id=$1', [t.id]);
  const other = await one(`select id from statuses where name='Stdby'`);
  const r = await sup.post('/super/db/tables/statuses/delete', { pks: [{ id: other.id }, { id: st.status_id }], confirm: 'BORRAR' });
  assert.equal(r.status, 400);
  assert.match(r.data.error || r.data.message || JSON.stringify(r.data), /tickets/);
  assert.ok(await one('select id from statuses where id=$1', [other.id]), 'todo o nada: Stdby sigue');
  ok(await sup.post('/super/db/tables/tickets/delete', { pks: [{ id: t.id }], confirm: 'BORRAR' }));
  assert.equal((await one('select count(*)::int as n from ticket_messages where ticket_id=$1', [t.id])).n, 0, 'cascada');
  const a = await one(`select * from audit_log where action='db_delete' order by id desc limit 1`);
  assert.equal(a.details.table, 'tickets');
  assert.equal(a.details.count, 1);
  assert.equal(a.details.rows[0].subject, 'Impresora del 2do piso (corregido)', 'copia de lo borrado');
  assert.equal((await sup.post('/super/db/tables/audit_log/delete', { pks: [{ id: a.id }], confirm: 'BORRAR' })).status, 403, 'la auditoría no se borra');
  const superRow = await one(`select id from users where role='superadmin'`);
  assert.equal((await sup.post('/super/db/tables/users/delete', { pks: [{ id: superRow.id }], confirm: 'BORRAR' })).status, 403);
  assert.equal((await sup.post('/super/db/tables/tickets/delete', { pks: Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })), confirm: 'BORRAR' })).status, 400, 'tope por vez');
  // Composite key
  const tk = (await admin.post('/tickets', { subject: 'Para seguir', contact_email: 'x@hanseatica.com' })).data;
  const g = await one('select ticket_id, user_id from ticket_followers where ticket_id=$1', [tk.id]);
  assert.ok(g, 'el que crea el ticket lo sigue');
  ok(await sup.post('/super/db/tables/ticket_followers/delete', { pks: [{ ticket_id: g.ticket_id, user_id: g.user_id }], confirm: 'BORRAR' }));
  assert.equal(await one('select 1 as x from ticket_followers where ticket_id=$1 and user_id=$2', [g.ticket_id, g.user_id]), null);
});

test('marca: colores nuevos (migración 11 solo si eran los anteriores) y datos para la pantalla de ingreso', async () => {
  const { MIGRATIONS } = await import('../lib/migrations.js');
  const m11 = MIGRATIONS.find((m) => m.version === 11);
  await q(`update app_settings set value = value || '{"color":"#C41230","accent":"#E8A317"}'::jsonb where key='brand'`);
  for (const s of m11.statements) await q(s);
  let b = (await one(`select value from app_settings where key='brand'`)).value;
  assert.equal(b.color, '#C8102E');
  assert.equal(b.accent, '#F2A900');
  await q(`update app_settings set value = value || '{"color":"#123456"}'::jsonb where key='brand'`);
  for (const s of m11.statements) await q(s);
  b = (await one(`select value from app_settings where key='brand'`)).value;
  assert.equal(b.color, '#123456', 'un color elegido a mano no se pisa');
  const me = (await anon.get('/auth/me')).data;
  assert.equal(me.user, null);
  assert.equal(me.brand.name, 'Hanseatica');
  assert.equal(me.brand.product, 'Mesa de Ayuda IT');
  assert.ok(!('support_email' in me.brand));
});
