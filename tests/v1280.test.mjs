// v1.28: exportar la lista de proyectos a Excel (los que se ven, con las columnas y el orden de la Lista).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { readXlsx } = await import('../lib/xlsx.js');
const admin = makeClient();
const agente = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
const sheet = (r) => readXlsx(Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data, 'binary'));

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  const meta = (await admin.get('/meta')).data;
  const mt = meta.users.find((u) => /Tamburrini/.test(u.name)).id;
  ok(await admin.post('/projects', { key: 'APF', name: 'Automatización de proceso financiero', template: 'dev', lead_id: mt, origin_id: meta.origins?.[0]?.id, estimated_hours: 120, contact_email: 'vcastaner@hanseatica.com',
    phases: [{ name: 'Relevamiento', start_date: '2026-11-02' }, { name: 'Desarrollo', due_date: '2026-12-01' }] }));
  ok(await admin.post('/projects', { key: 'CT', name: 'Cotizador de transporte V2', template: 'dev' }));
  ok(await admin.post('/projects', { key: 'DL', name: 'Dashboard Legales', template: 'dev' }));
  ok(await admin.post('/admin/users', { name: 'Agente Exp', email: 'exp.agente@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await agente.post('/auth/login', { email: 'exp.agente@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
});

test('Excel con los proyectos que se ven, en ese orden, y las columnas elegidas', async () => {
  const r = await admin.get('/projects/export.xlsx?keys=DL,APF&cols=name,origin,lead,hours,start,end,progress,contact');
  ok(r);
  assert.match(r.headers['content-type'], /spreadsheetml/);
  assert.match(r.headers['content-disposition'], /proyectos-\d{4}-\d{2}-\d{2}\.xlsx/);
  const rows = sheet(r);
  assert.deepEqual(rows[0], ['Clave', 'Proyecto', 'Origen', 'Líder', 'Horas estimadas', 'Inicio', 'Fin', 'Avance', 'Contacto del área']);
  assert.deepEqual(rows.slice(1).map((x) => x[0]), ['DL', 'APF'], 'solo los que se ven, en el orden de la pantalla');
  const apf = rows[2];
  assert.equal(apf[1], 'Automatización de proceso financiero');
  assert.equal(apf[3], 'Martin Tamburrini');
  assert.equal(Number(apf[4]), 120);
  const iso = (x) => (x?.date || (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)));
  assert.equal(iso(apf[5]), '2026-11-02', 'fecha de inicio real');
  assert.equal(iso(apf[6]), '2026-12-01');
  assert.ok(String(apf[8]).includes('vcastaner'), 'el contacto');
});

test('columnas desconocidas se ignoran; sin columnas, las de fábrica', async () => {
  const rows = sheet(await admin.get('/projects/export.xlsx?keys=CT&cols=hackeo,name'));
  assert.deepEqual(rows[0], ['Clave', 'Proyecto']);
  const def = sheet(await admin.get('/projects/export.xlsx?keys=CT'));
  assert.deepEqual(def[0], ['Clave', 'Proyecto', 'Tipo', 'Estado', 'Líder', 'Prioridad', 'Abiertas', 'Avance', 'Fin']);
});

test('las horas estimadas no salen para quien no gestiona el portfolio', async () => {
  const r = await agente.get('/projects/export.xlsx?keys=APF&cols=name,hours');
  ok(r);
  const rows = sheet(r);
  assert.ok(rows[1][2] === undefined || rows[1][2] === '' || rows[1][2] === null, `sin horas: ${JSON.stringify(rows[1])}`);
});
