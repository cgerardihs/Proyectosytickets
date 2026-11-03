// v1.20: columnas de la lista de tickets por agente y por vista (cuáles, orden y ancho).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { normalizeColumns, TICKET_COLUMNS } = await import('../lib/view-prefs.js');
const admin = makeClient();
const otro = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let vid;

test('normalización: solo columnas conocidas, Asunto siempre visible, anchos entre 60 y 1000 px', () => {
  const c = normalizeColumns({ order: ['version', 'subject', 'hackeo'], on: ['version', 'xx'], w: { subject: 20, version: 5000, tech: 'abc', nope: 100 } });
  assert.deepEqual(c.order.slice(0, 2), ['version', 'subject']);
  assert.equal(c.order.length, TICKET_COLUMNS.length, 'las que faltan se agregan al final');
  assert.deepEqual(c.on, ['subject', 'version']);
  assert.deepEqual(c.w, { subject: 60, version: 1000 });
});

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const u = await admin.post('/admin/users', { name: 'Otro Agente', email: 'cols.otro@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' });
  ok(u);
  ok(await otro.post('/auth/login', { email: 'cols.otro@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
});

test('cada agente guarda sus columnas por vista; vuelven en /meta; restablecer las borra', async () => {
  ok(await admin.put('/me/view-prefs/all', { order: ['subject', 'version', 'status'], on: ['subject', 'version', 'status', 'sla'], w: { subject: 420 } }));
  ok(await admin.put('/me/view-prefs/mine', { on: ['subject', 'activity'] }));
  const m = (await admin.get('/meta')).data;
  assert.deepEqual(m.viewPrefs.all.on, ['subject', 'version', 'status', 'sla']);
  assert.equal(m.viewPrefs.all.w.subject, 420);
  assert.deepEqual(m.viewPrefs.mine.on, ['subject', 'activity']);
  assert.deepEqual((await otro.get('/meta')).data.viewPrefs, {}, 'no afecta a los demás');
  ok(await admin.del('/me/view-prefs/mine'));
  assert.equal((await admin.get('/meta')).data.viewPrefs.mine, undefined);
  assert.equal((await admin.put('/me/view-prefs/..%2Fotra', { on: [] })).status, 400, 'clave de vista inválida');
});

test('vista compartida: las columnas de quien la creó son el punto de partida de los demás', async () => {
  const v = await admin.post('/views', { name: 'Equis por versión', shared: true, filters: { view: 'all', version: 'versión 11 2026' } });
  ok(v);
  vid = v.data.id;
  assert.equal(v.data.filters.version, 'versión 11 2026', 'la vista guarda el filtro de versión');
  ok(await admin.put(`/me/view-prefs/${encodeURIComponent(`custom:${vid}`)}`, { on: ['subject', 'version', 'assignee'] }));
  const seen = (await otro.get('/meta')).data.views.find((x) => x.id === vid);
  assert.deepEqual(seen.columns.on, ['subject', 'version', 'assignee']);
  // Lo que ajusta otro agente queda para él y no cambia la vista
  ok(await otro.put(`/me/view-prefs/${encodeURIComponent(`custom:${vid}`)}`, { on: ['subject', 'contact'] }));
  assert.deepEqual((await admin.get('/meta')).data.views.find((x) => x.id === vid).columns.on, ['subject', 'version', 'assignee']);
  assert.deepEqual((await otro.get('/meta')).data.viewPrefs[`custom:${vid}`].on, ['subject', 'contact']);
});

test('las columnas nuevas se pueden ordenar: empresa', async () => {
  for (const [s, mail] of [['Uno', 'zeta@zeta.com'], ['Dos', 'alfa@alfa.com']]) ok(await admin.post('/tickets', { subject: s, contact_email: mail }));
  const r = await admin.get('/tickets?view=all&sort=company&order=asc');
  ok(r);
});
