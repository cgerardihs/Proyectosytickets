// v1.9: sin grupos (pasan a la categoría técnica), nombres de campos editables por el superadmin y orden por columna.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { MIGRATIONS } = await import('../lib/migrations.js');

const admin = makeClient();
const sup = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const T = {};
const G = {};

test('instalación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: 'Super-Clave-Muy-Larga-2026' }));
  assert.equal((await one('select count(*)::int as n from agent_groups')).n, 0, 'la instalación ya no crea grupos');
  assert.equal((await admin.get('/meta')).data.groups.length, 0);
});

test('migración 12: el grupo de cada ticket pasa a la categoría técnica (y subcategoría), y las reglas también', async () => {
  // Configuración como la de producción: 5 categorías técnicas, Equis con subcategorías; los 6 grupos de antes
  await q('delete from tech_subcategories');
  await q('delete from tech_categories');
  for (const [i, n] of ['Soporte', 'Altas de Usuarios', 'Aplicaciones', 'Equis', 'Reporting'].entries()) T[n] = (await one('insert into tech_categories(name,sort) values ($1,$2) returning id', [n, i])).id;
  const subUso = (await one(`insert into tech_subcategories(tech_category_id,name) values ($1,'Uso diario') returning id`, [T.Equis])).id;
  const subDev = (await one(`insert into tech_subcategories(tech_category_id,name) values ($1,'Desarrollos') returning id`, [T.Equis])).id;
  for (const n of ['Soporte', 'Aplicaciones - CRM, portales, otras apps', 'EQUIS - Uso diario de EQUIS', 'EQUIS - DESARROLLOS - Bugs o mejoras EQUIS', 'Solamente para nuevos ingresos de Personal', 'Reporting']) {
    G[n] = (await one('insert into agent_groups(name) values ($1) returning id', [n])).id;
  }
  const contact = (await one(`insert into contacts(name,email) values ('Ana','ana@hanseatica.com') returning id`)).id;
  const status = (await one('select id from statuses where is_default')).id;
  const mk = async (subject, group, tech = null) => (await one(`insert into tickets(subject,channel,contact_id,status_id,priority,group_id,tech_category_id) values ($1,'email',$2,$3,1,$4,$5) returning id`,
    [subject, contact, status, group, tech])).id;
  const t1 = await mk('Impresora', G.Soporte);
  const t2 = await mk('CRM lento', G['Aplicaciones - CRM, portales, otras apps']);
  const t3 = await mk('Cierre de siniestro', G['EQUIS - Uso diario de EQUIS']);
  const t4 = await mk('Reporte nuevo en Equis', G['EQUIS - DESARROLLOS - Bugs o mejoras EQUIS']);
  const t5 = await mk('Alta de ingresante', G['Solamente para nuevos ingresos de Personal']);
  const t6 = await mk('Ya tenía categoría', G.Reporting, T.Soporte);
  const r1 = (await one(`insert into automation_rules(name,match,conditions,actions) values ('A Equis','all',$1::jsonb,$2::jsonb) returning id`, [
    JSON.stringify([{ field: 'subject', op: 'contains', value: 'siniestro' }]), JSON.stringify([{ field: 'group_id', value: String(G['EQUIS - Uso diario de EQUIS']) }, { field: 'add_tag', value: 'x' }])])).id;
  const r2 = (await one(`insert into automation_rules(name,match,conditions,actions) values ('Por grupo','all',$1::jsonb,$2::jsonb) returning id`, [
    JSON.stringify([{ field: 'group_id', op: 'equals', value: String(G.Reporting) }]), JSON.stringify([{ field: 'priority', value: '3' }])])).id;
  const r3 = (await one(`insert into automation_rules(name,match,conditions,actions) values ('Ingresos','all',$1::jsonb,$2::jsonb) returning id`, [
    JSON.stringify([{ field: 'subject', op: 'contains', value: 'alta' }]), JSON.stringify([{ field: 'group_id', value: String(G['Solamente para nuevos ingresos de Personal']) }])])).id;
  await q('update tech_categories set group_id=$1 where id=$2', [G.Reporting, T.Reporting]);
  // Casos raros que no tienen que trabar la migración: reglas con formato no-lista, vistas y exclusiones de IA por grupo, límite de palabra
  T.Red = (await one(`insert into tech_categories(name,sort) values ('Red',9) returning id`)).id;
  G.redes = (await one(`insert into agent_groups(name) values ('Redes sociales') returning id`)).id;
  const t7 = await mk('Post de Instagram', G.redes);
  const r4 = (await one(`insert into automation_rules(name,match,conditions,actions) values ('Rara','all','{"all":[]}'::jsonb,'null'::jsonb) returning id`)).id;
  const v1 = (await one(`insert into custom_views(name,owner_id,shared,filters) values ('Equis diario',null,true,$1::jsonb) returning id`, [JSON.stringify({ group: String(G['EQUIS - Uso diario de EQUIS']), status: '1' })])).id;
  const v2 = (await one(`insert into custom_views(name,owner_id,shared,filters) values ('Ingresos',null,true,$1::jsonb) returning id`, [JSON.stringify({ group: String(G['Solamente para nuevos ingresos de Personal']) })])).id;
  await q(`insert into app_settings(key,value) values ('ai', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify({ exclusions: { group_ids: [G['EQUIS - Uso diario de EQUIS']] } })]);

  const m12 = MIGRATIONS.find((m) => m.version === 12);
  const { tx } = await import('../lib/db.js');
  const run = () => tx(async () => { for (const s of m12.statements) await q(s); });
  await run();

  const tk = async (id) => one('select tech_category_id as tech, tech_subcategory_id as sub, group_id from tickets where id=$1', [id]);
  assert.deepEqual(await tk(t1), { tech: T.Soporte, sub: null, group_id: G.Soporte }, 'mismo nombre');
  assert.equal((await tk(t2)).tech, T.Aplicaciones, '"Aplicaciones - CRM…" empieza con "Aplicaciones"');
  assert.deepEqual(await tk(t3), { tech: T.Equis, sub: subUso, group_id: G['EQUIS - Uso diario de EQUIS'] }, 'y la subcategoría por nombre');
  assert.deepEqual(await tk(t4), { tech: T.Equis, sub: subDev, group_id: G['EQUIS - DESARROLLOS - Bugs o mejoras EQUIS'] });
  assert.equal((await tk(t5)).tech, null, 'sin equivalente: queda para asignar a mano');
  assert.equal((await tk(t6)).tech, T.Soporte, 'la que ya tenía categoría no se pisa');
  const rule = async (id) => one('select name, active, conditions, actions from automation_rules where id=$1', [id]);
  const a = await rule(r1);
  assert.equal(a.active, true);
  assert.equal(a.actions[0].field, 'tech_category_id');
  const b = await rule(r2);
  assert.deepEqual(b.conditions, [{ field: 'tech_category_id', op: 'equals', value: String(T.Reporting) }], 'la categoría atada al grupo');
  const c = await rule(r3);
  assert.equal(c.active, false, 'una regla con un grupo sin equivalente se desactiva');
  assert.match(c.name, /revisar: usaba grupo/);
  assert.equal((await one('select count(*)::int as n from tech_categories where group_id is not null')).n, 0);
  assert.equal((await tk(t7)).tech, null, '"Redes sociales" no cae en "Red"');
  assert.ok(await one('select id from automation_rules where id=$1', [r4]), 'la regla rara sigue ahí');
  const va = await one('select name, filters from custom_views where id=$1', [v1]);
  assert.deepEqual(va.filters, { status: '1', tech: String(T.Equis) });
  assert.equal(va.name, 'Equis diario');
  const vb = await one('select name, filters from custom_views where id=$1', [v2]);
  assert.match(vb.name, /revisar: usaba grupo/);
  assert.ok(!('group' in vb.filters));
  assert.deepEqual((await one(`select value from app_settings where key='ai'`)).value.exclusions.tech_ids, [T.Equis]);
  // La acción de la regla suma la subcategoría
  assert.deepEqual((await rule(r1)).actions, [{ field: 'tech_category_id', value: String(T.Equis) }, { field: 'tech_subcategory_id', value: String(subUso) }, { field: 'add_tag', value: 'x' }]);
  // Correr dos veces (ej. al restaurar un respaldo) no duplica la marca
  await run();
  assert.equal((await rule(r3)).name.match(/revisar/g).length, 1);
  assert.equal(await one(`select 1 as x from pg_proc where proname like 'hd_v19_%'`), null, 'no quedan funciones temporales');
  // Una regla vieja con grupo que quedó (desactivada) no rompe la creación de tickets
  await q('update automation_rules set active=true where id=$1', [r3]);
  const nt = await admin.post('/tickets', { subject: 'alta de usuario', contact_email: 'ana@hanseatica.com' });
  ok(nt);
  assert.equal(nt.data.group_id, null);
  await q('update automation_rules set active=false where id=$1', [r3]);
  T.left = t5;
});

test('tickets que quedaron sin categoría: se asignan por grupo anterior y la equivalencia la usa el importador', async () => {
  const left = (await admin.get('/admin/group-leftovers')).data;
  const g = left.find((x) => x.name.startsWith('Solamente para nuevos ingresos'));
  assert.equal(g.n, 1);
  assert.equal((await admin.post('/admin/group-leftovers', { group_id: g.id, tech_category_id: T.Equis, tech_subcategory_id: 999999 })).status, 400, 'subcategoría de otra categoría');
  ok(await admin.post('/admin/group-leftovers', { group_id: g.id, tech_category_id: T['Altas de Usuarios'] }));
  assert.equal((await one('select tech_category_id from tickets where id=$1', [T.left])).tech_category_id, T['Altas de Usuarios']);
  assert.ok(!(await admin.get('/admin/group-leftovers')).data.some((x) => x.id === g.id));
  // Desk365: la columna Grupo usa la equivalencia elegida a mano, o el nombre
  const csv = ['Número de ticket,Asunto,Estado,Prioridad,Grupo,Fecha de creación',
    '9001,Alta ingresante,Abierto,Baja,Solamente para nuevos ingresos de Personal,10/10/2026 10:00',
    '9002,Error Equis,Abierto,Baja,EQUIS - DESARROLLOS - Bugs o mejoras EQUIS,10/10/2026 10:00'].join('\n');
  const r = await admin.post('/admin/import/desk365', { filename: 't.csv', data: Buffer.from(csv).toString('base64'), dry: false });
  ok(r);
  const i1 = await one('select tech_category_id, tech_subcategory_id, group_id from tickets where number=9001');
  assert.equal(i1.tech_category_id, T['Altas de Usuarios']);
  assert.equal(i1.group_id, null);
  const i2 = await one('select tech_category_id, tech_subcategory_id from tickets where number=9002');
  assert.equal(i2.tech_category_id, T.Equis);
  assert.ok(i2.tech_subcategory_id, 'subcategoría "Desarrollos" por nombre');
});

test('nombres de los campos: solo el superadmin los cambia; vacío vuelve al original', async () => {
  assert.equal((await admin.put('/super/field-labels', { category: 'Área' })).status, 403);
  ok(await sup.put('/super/field-labels', { category: 'Área que pide', tech: 'Tema', otra: 'x' }));
  let meta = (await admin.get('/meta')).data;
  assert.deepEqual(meta.fieldLabels, { category: 'Área que pide', tech: 'Tema' }, 'claves desconocidas no se guardan');
  ok(await sup.put('/super/field-labels', { tech: '' }));
  meta = (await admin.get('/meta')).data;
  assert.deepEqual(meta.fieldLabels, { category: 'Área que pide' });
  assert.equal((await sup.put('/super/field-labels', { category: 'x'.repeat(61) })).status, 400);
  assert.equal((await sup.put('/super/field-labels', { category: '<img src=x onerror=alert(1)>' })).status, 400, 'sin < ni >');
});

test('lista de tickets: orden por cada columna', async () => {
  const mk = (subject, email, name, extra = {}) => admin.post('/tickets', { subject, contact_email: email, contact_name: name, ...extra });
  const users = (await admin.get('/meta')).data.users.filter((u) => u.active);
  ok(await mk('Zeta', 'zz@hanseatica.com', 'Zulma', { tech_category_id: T.Reporting, assignee_id: users[0].id }));
  ok(await mk('Alfa', 'aa@hanseatica.com', 'Abel', { tech_category_id: T.Aplicaciones, assignee_id: users[1].id }));
  const names = async (sort, order, field) => (await admin.get(`/tickets?view=all&sort=${sort}&order=${order}&limit=200`)).data.items.map((x) => x[field]);
  const subjects = await names('subject', 'asc', 'subject');
  assert.deepEqual(subjects, [...subjects].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
  const contacts = (await names('contact', 'asc', 'contact_name')).filter(Boolean);
  assert.equal(contacts[0], 'Abel');
  assert.equal((await names('contact', 'desc', 'contact_name'))[0], 'Zulma');
  const techs = (await admin.get('/tickets?view=all&sort=tech&order=asc&limit=200')).data.items.map((x) => x.tech_category_id).filter(Boolean);
  const techName = Object.fromEntries(Object.entries(T).filter(([k]) => k !== 'left').map(([k, v]) => [v, k.toLowerCase()]));
  assert.deepEqual(techs.map((id) => techName[id]), techs.map((id) => techName[id]).sort());
  for (const s of ['channel', 'status', 'assignee', 'category', 'subtech', 'type', 'priority', 'created']) ok(await admin.get(`/tickets?view=all&sort=${s}&order=asc`), s);
  ok(await admin.get('/tickets?view=all&sort=desconocido;drop'), 'un orden inválido usa el de siempre');
  for (const s of ['constructor', '__proto__', 'toString']) ok(await admin.get(`/tickets?view=all&sort=${s}`), s);
  // Filtro "sin categoría técnica"
  const none = (await admin.get('/tickets?view=all&tech=none&limit=200')).data.items;
  assert.ok(none.length && none.every((x) => x.tech_category_id === null));
});
