// v1.19: versión de la solución en los tickets de Equis (texto con formato fijo, filtros, orden, exportación e informes).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { normalizeVersion } = await import('../lib/ticket-version.js');
const admin = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let equis;
let soporte;
const nums = [];

test('formato: siempre "versión N AAAA"', () => {
  for (const x of ['versión 11 2026', 'Version 11 2026', 'version 11/2026', '11-2026', 'v 11 2026', '  versión   11   2026 ']) assert.equal(normalizeVersion(x), 'versión 11 2026', x);
  assert.equal(normalizeVersion('versión 9 2027'), 'versión 9 2027');
  assert.equal(normalizeVersion(''), null);
  assert.equal(normalizeVersion(null), null);
  for (const x of ['la próxima', '14.10', 'versión 2026', 'versión 0 2026', 'versión 11 26']) assert.throws(() => normalizeVersion(x), /número y año/, x);
});

test('preparación: las categorías de Equis piden versión', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const meta = (await admin.get('/meta')).data;
  equis = meta.techCategories.find((c) => /equis/i.test(c.name));
  soporte = meta.techCategories.find((c) => /^soporte/i.test(c.name));
  assert.ok(equis.has_version, 'Equis pide versión');
  assert.ok(!soporte.has_version, 'Soporte no');
  for (const [s, tech] of [['Factura B en cliente del exterior', equis.id], ['Notas de débito', equis.id], ['Impresora', soporte.id], ['Riesgo 2588', equis.id]]) {
    const r = await admin.post('/tickets', { subject: s, contact_email: 'usuario@hanseatica.com', tech_category_id: tech });
    ok(r);
    nums.push(r.data.number ?? r.data.ticket?.number);
  }
});

test('se carga en tickets de Equis, normalizada y con historial; no en otras categorías', async () => {
  ok(await admin.patch(`/tickets/${nums[0]}`, { version: 'version 11/2026' }));
  let d = (await admin.get(`/tickets/${nums[0]}`)).data;
  assert.equal(d.ticket.version, 'versión 11 2026');
  assert.ok(d.activities.some((a) => a.details?.changes?.version || a.details?.version || JSON.stringify(a.details).includes('versión 11 2026')), 'queda en el historial');
  ok(await admin.patch(`/tickets/${nums[1]}`, { version: 'versión 9 2026' }));
  ok(await admin.patch(`/tickets/${nums[3]}`, { version: 'versión 2 2027' }));
  const bad1 = await admin.patch(`/tickets/${nums[2]}`, { version: 'versión 11 2026' });
  assert.equal(bad1.status, 400, 'Soporte no pide versión');
  const bad2 = await admin.patch(`/tickets/${nums[0]}`, { version: 'la próxima' });
  assert.equal(bad2.status, 400);
  assert.match(bad2.data.error, /versión 11 2026/);
  ok(await admin.patch(`/tickets/${nums[1]}`, { version: '' }));
  d = (await admin.get(`/tickets/${nums[1]}`)).data;
  assert.equal(d.ticket.version, null, 'se puede borrar');
  ok(await admin.patch(`/tickets/${nums[1]}`, { version: 'versión 9 2026' }));
});

test('filtro, orden por versión y lista de versiones para sugerir', async () => {
  const list = (await admin.get('/tickets?view=all&version=versión 11 2026')).data;
  const rows = list.items || list.tickets || list.rows || list;
  assert.deepEqual(rows.map((t) => t.number), [nums[0]]);
  const none = (await admin.get('/tickets?view=all&version=none')).data;
  assert.ok((none.items || none.tickets || none.rows || none).some((t) => t.number === nums[2]));
  const sorted = (await admin.get('/tickets?view=all&sort=version&order=asc&version=versión 9 2026,versión 11 2026,versión 2 2027')).data;
  assert.deepEqual((sorted.items || sorted.tickets || sorted.rows || sorted).map((t) => t.version), ['versión 9 2026', 'versión 11 2026', 'versión 2 2027'], 'orden por año y número, no alfabético');
  const meta = (await admin.get('/meta')).data;
  assert.deepEqual(meta.ticketVersions, ['versión 2 2027', 'versión 11 2026', 'versión 9 2026']);
});

test('sale en la exportación, en el Explorador y se configura por categoría', async () => {
  const csv = await admin.get('/tickets/export?view=all');
  assert.equal(csv.status, 200);
  assert.match(String(csv.data || csv.text || ''), /Versión/);
  const ex = await admin.get('/reports/explorer?sources=ticket&period=30');
  ok(ex);
  const tk = (ex.data.ticket?.rows || ex.data.ticket || ex.data.data?.ticket || []).find((t) => t.number === nums[0]);
  assert.equal(tk.version, 'versión 11 2026');
  ok(await admin.patch(`/admin/tech-categories/${soporte.id}`, { has_version: true }));
  ok(await admin.patch(`/tickets/${nums[2]}`, { version: 'versión 12 2026' }), 'al habilitarla, Soporte también la acepta');
});
