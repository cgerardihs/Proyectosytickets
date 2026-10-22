// v1.6: tipos de proyecto con etapas, subcategorías técnicas, portfolio (avance, salud, importación y exportación) y API de exportación.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { readXlsx, writeXlsx } = await import('../lib/xlsx.js');
const { derive, parseDate, parsePercent, parseNumber, fuzzyMatch, matchUser } = await import('../lib/portfolio.js');

const admin = makeClient();
const sup = makeClient();
const agent = makeClient();
const ext = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
let meta;
let me;

test('instalación y permisos del portfolio', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: true }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: 'Super-Clave-Muy-Larga-2026' }));
  ok(await admin.post('/admin/users', { name: 'Ana Agente', email: 'ana@hanseatica.com', role: 'agent', password: 'Rio-de-la-Plata-9' }));
  ok(await agent.post('/auth/login', { email: 'ana@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  meta = (await admin.get('/meta')).data;
  me = meta.me;
  assert.equal(meta.canPortfolio, false);
  assert.deepEqual(meta.projectTypes.map((t) => t.name), ['Desarrollo de software', 'Instalación de sistema', 'Infraestructura', 'Capacitación']);
  assert.equal((await admin.get('/portfolio')).status, 403, 'sin permiso no lo ve');
  assert.equal((await admin.patch(`/admin/users/${me.id}`, { can_portfolio: true })).status, 403, 'un admin no se lo asigna');
  ok(await sup.patch(`/admin/users/${me.id}`, { can_portfolio: true }), 'el superadmin lo asigna');
  ok(await sup.get('/portfolio'), 'el superadmin siempre lo ve');
  assert.equal((await admin.get('/meta')).data.canPortfolio, true);
  ok(await admin.get('/portfolio'));
  assert.equal((await agent.get('/portfolio')).status, 403);
});

test('tipos de proyecto: etapas y flujo según el tipo', async () => {
  const inst = meta.projectTypes.find((t) => t.name.startsWith('Instalación'));
  let r = await admin.post('/projects', { key: 'ERP', name: 'Instalación ERP', type_id: inst.id, start_date: '2026-10-01', end_date: '2026-12-30' });
  ok(r);
  r = await admin.get('/projects/ERP');
  assert.equal(r.data.type.name, 'Instalación de sistema');
  assert.deepEqual(r.data.statuses.map((s) => s.name), ['Pendiente', 'En curso', 'Hecho'], 'flujo simple');
  assert.deepEqual(r.data.epics.map((e) => e.title), ['Análisis', 'Instalación', 'Implementación'], 'etapas de la plantilla');
  assert.equal(String(r.data.epics[0].start_date).slice(0, 10), '2026-10-01', 'las fechas del proyecto se reparten entre las etapas');
  assert.equal(String(r.data.epics[2].due_date).slice(0, 10), '2026-12-30');
  // Etapas elegidas a mano (se destildó una y se agregó otra)
  r = await admin.post('/projects', { key: 'CAP', name: 'Capacitación Copilot', type_id: meta.projectTypes.find((t) => t.name === 'Capacitación').id, phases: [{ name: 'Planificación' }, { name: 'Dictado' }, { name: 'Encuesta' }] });
  ok(r);
  assert.deepEqual((await admin.get('/projects/CAP')).data.epics.map((e) => e.title), ['Planificación', 'Dictado', 'Encuesta']);
  // Sin tipo ni etapas: el proyecto arranca vacío (compatibilidad)
  ok(await admin.post('/projects', { key: 'VACIO', name: 'Sin etapas' }));
  assert.equal((await admin.get('/projects/VACIO')).data.epics.length, 0);
  // Validaciones
  assert.equal((await admin.post('/projects', { key: 'X1', name: 'x', type_id: 9999 })).status, 400);
  assert.equal((await admin.post('/projects', { key: 'X2', name: 'x', start_date: '2026-10-10', end_date: '2026-10-01' })).status, 400);
  assert.equal((await admin.post('/projects', { key: 'X3', name: 'x', origin_id: meta.sectors[0].id })).status, 400, 'un sector no sirve como origen');
});

test('tipos de proyecto: administración', async () => {
  let r = await admin.post('/admin/project-types', { name: 'Proveedor', phases: ['Pliego', 'Adjudicación', 'Implementación'], workflow: 'simple', is_default: true });
  ok(r);
  const types = (await admin.get('/admin/project-types')).data;
  assert.equal(types.filter((t) => t.is_default).length, 1, 'un solo predeterminado');
  assert.equal(types.find((t) => t.is_default).name, 'Proveedor');
  assert.equal((await admin.post('/admin/project-types', { name: 'Vacío', phases: [] })).status, 400, 'necesita etapas');
  assert.equal((await admin.post('/admin/project-types', { name: 'Raro', phases: ['A'], workflow: 'cascada' })).status, 400);
  assert.equal((await agent.post('/admin/project-types', { name: 'Agente', phases: ['A'] })).status, 403);
  // Vuelve el predeterminado original
  ok(await admin.patch(`/admin/project-types/${meta.projectTypes[0].id}`, { is_default: true }));
});

test('convertir un ticket en proyecto con tipo y datos del portfolio', async () => {
  const t = (await admin.post('/tickets', { subject: 'Implementar firma digital', contact_email: 'legales@hanseatica.com', priority: 3, category_id: meta.categories[0].id })).data;
  const inst = meta.projectTypes.find((x) => x.name.startsWith('Instalación'));
  const origin = meta.origins[0];
  const r = await admin.post(`/tickets/${t.number}/project`, { key: 'FIRMA', type_id: inst.id, origin_id: origin.id, sector_id: meta.sectors[0].id, estimated_hours: 120, portfolio_status: 'planned',
    phases: [{ name: 'Análisis', start_date: '2026-11-02', due_date: '2026-11-13' }, { name: 'Instalación', start_date: '2026-11-16', due_date: '2026-12-04' }, { name: 'Implementación', start_date: '2026-12-07', due_date: '2026-12-15' }] });
  ok(r);
  const p = (await admin.get('/projects/FIRMA')).data;
  assert.deepEqual(p.epics.map((e) => e.title), ['Análisis', 'Instalación', 'Implementación']);
  assert.equal(p.project.origin_id, origin.id);
  assert.equal(p.project.area_id, meta.categories[0].id, 'toma el área del ticket');
  assert.equal(p.project.priority, 3);
  assert.equal(p.portfolio.portfolio_status, 'planned');
  assert.equal(Number(p.project.estimated_hours), 120);
  assert.equal(p.tickets[0].number, t.number);
});

test('portfolio: avance automático, manual y salud', async () => {
  // Avance automático por etapas: una hecha, otra con tareas a medias, otra con avance manual
  const p = (await admin.get('/projects/CAP')).data;
  const done = p.statuses.find((s) => s.kind === 'done').id;
  const [e1, e2, e3] = p.epics;
  ok(await admin.patch(`/issues/${e1.key}`, { status_id: done }));
  const t1 = (await admin.post('/projects/CAP/issues', { type: 'task', title: 'Armar material', parent_id: e2.id })).data;
  ok(await admin.post('/projects/CAP/issues', { type: 'task', title: 'Reservar sala', parent_id: e2.id }));
  ok(await admin.patch(`/issues/${t1.key}`, { status_id: done }));
  ok(await admin.patch(`/issues/${e3.key}`, { progress: 30 }));
  let row = (await admin.get('/portfolio')).data.rows.find((x) => x.key === 'CAP');
  assert.deepEqual(row.phases.map((f) => f.pct), [100, 50, 30]);
  assert.equal(row.progress, 60, 'promedio de las etapas');
  assert.equal(row.progress_source, 'auto');
  assert.equal(row.current_phase, 'Dictado');
  // Manual pisa al automático; un usuario con permiso de portfolio puede editar aunque no sea líder
  ok(await sup.patch('/projects/CAP', { progress_override: 80, start_date: '2026-01-01', end_date: '2026-02-01' }));
  row = (await admin.get('/portfolio')).data.rows.find((x) => x.key === 'CAP');
  assert.equal(row.progress, 80);
  assert.equal(row.progress_auto, 60);
  assert.equal(row.health, 'late', 'pasó la fecha de fin');
  assert.equal((await agent.patch('/projects/CAP', { progress_override: 5 })).status, 403, 'un agente que no es líder no puede');
  ok(await admin.patch('/projects/CAP', { portfolio_status: 'done', progress_override: null }));
  row = (await admin.get('/portfolio')).data.rows.find((x) => x.key === 'CAP');
  assert.equal(row.progress, 100);
  assert.equal(row.health, 'done');
  // Cálculo puro: riesgo y recurrentes
  const base = { phases: [], total_issues: 0, done_issues: 0, minutes: 90, extra_hours: 2, portfolio_status: 'active', progress_override: 10 };
  const risk = derive({ ...base, start_date: '2026-01-01', end_date: '2026-12-31' }, '2026-10-01');
  assert.equal(risk.health, 'risk');
  assert.equal(risk.hours, 3.5, 'registradas + manuales');
  assert.equal(derive({ ...base, recurring: true }, '2026-10-01').health, 'ok');
  assert.equal(derive({ ...base, start_date: '2026-07-01' }, '2026-10-01').health, 'none', 'solo con inicio no se marca atrasado');
});

test('importación desde Excel: vista previa, alta, actualización y listas nuevas', async () => {
  const head = ['Proyecto', 'Descripción', 'Origen', 'Sector IT', 'Area', 'Responsable', 'Estado', 'Prioridad', 'Fecha Inicio', 'Fecha Fin', 'Horas Estimadas', '% Avance', 'Horas Manuales'];
  const rows = [
    ['Nuevo portal certificados', 'Portal de transporte', 'OKR 26-27', 'Sistemas | Desarrollo', 'Tecnica y Operaciones', 'Charly Gerardi', 'En curso', 'Alta', '2026-02-01', '2026-11-30', 1728, 0.7, null],
    ['Capacitaciones', '', 'OKR 26-27', 'Sistemas | Infra', 'Hanseatica', 'Fulano Inexistente', 'En curso', 'Media', 'RECURRENTE', 'RECURRENTE', null, 0.15, null],
    ['Agentes de siniestros', '', 'Oport Negocio', 'Sistemas | Desarrollo', 'Siniestros', '', 'Finalizado', '', null, null, 0, 1, 5],
    ['Nuevo portal certificados', 'repetida', '', '', '', '', '', '', null, null, null, null, null],
  ];
  const xlsx = writeXlsx([{ name: 'Proyectos', columns: head.map((h) => ({ header: h, type: /Fecha/.test(h) ? 'date' : /Horas/.test(h) ? 'number' : h === '% Avance' ? 'percent' : 'text' })), rows }]);
  const data = xlsx.toString('base64');
  assert.equal((await agent.post('/portfolio/import', { filename: 'p.xlsx', data })).status, 403);
  assert.equal((await admin.post('/portfolio/import', { filename: 'p.csv', data })).status, 400, 'solo .xlsx');
  assert.equal((await admin.post('/portfolio/import', { filename: 'p.xlsx', data: Buffer.from('no es un excel').toString('base64') })).status, 400);
  let r = await admin.post('/portfolio/import', { filename: 'p.xlsx', data, dry: true });
  ok(r);
  const [a, b, c, d] = r.data.rows;
  assert.equal(a.action, 'create');
  assert.equal(a.fields.lead.name, 'Carlos Gerardi', 'reconoce el apodo por el apellido');
  assert.equal(a.fields.area.name, 'Tec y Operaciones', 'tolera nombres parecidos');
  assert.equal(a.fields.progress, 70);
  assert.equal(a.fields.start_date, '2026-02-01');
  assert.equal(b.fields.recurring, true);
  assert.equal(b.fields.type.name, 'Capacitación', 'deduce el tipo');
  assert.ok(b.warnings.some((w) => w.includes('Fulano')));
  assert.equal(c.fields.origin.name, 'Oportunidad de negocio', 'abreviatura');
  assert.equal(c.fields.status, 'done');
  assert.equal(d.action, 'skip', 'nombre repetido');
  assert.deepEqual(r.data.create_options.area, ['Hanseatica']);
  assert.equal((await q(`select count(*)::int as n from projects where name='Capacitaciones'`))[0].n, 0, 'la vista previa no guarda');
  r = await admin.post('/portfolio/import', { filename: 'p.xlsx', data, dry: false });
  ok(r);
  assert.equal(r.data.created, 3);
  const pf = (await admin.get('/portfolio')).data.rows;
  const npc = pf.find((x) => x.name === 'Nuevo portal certificados');
  assert.equal(npc.progress, 70);
  assert.equal(npc.phases.length, 4, 'se crea con las etapas de su tipo');
  assert.equal(npc.phases[0].start_date, '2026-02-01');
  assert.equal(pf.find((x) => x.name === 'Capacitaciones').recurring, true);
  assert.equal(pf.find((x) => x.name === 'Agentes de siniestros').hours, 5);
  assert.ok(await one(`select id from categories where name='Hanseatica'`), 'se crea el área faltante');
  // Reimportar actualiza en lugar de duplicar
  r = await admin.post('/portfolio/import', { filename: 'p.xlsx', data, dry: false });
  ok(r);
  assert.equal(r.data.created, 0);
  assert.equal(r.data.updated, 3);
  assert.equal((await q(`select count(*)::int as n from projects where name='Nuevo portal certificados'`))[0].n, 1);
});

test('exportación del portfolio a Excel (se puede volver a leer)', async () => {
  const r = await admin.get('/portfolio/export');
  ok(r);
  assert.match(r.headers['content-type'], /spreadsheetml/);
  const rows = readXlsx(Buffer.from(r.data, 'binary'));
  assert.equal(rows[0][1], 'Proyecto');
  const npc = rows.find((x) => x[1] === 'Nuevo portal certificados');
  assert.ok(npc);
  assert.deepEqual(npc[10], { date: '2026-02-01' });
  assert.equal(npc[15], 0.7);
  const tpl = await admin.get('/portfolio/template');
  ok(tpl);
  assert.equal(readXlsx(Buffer.from(tpl.data, 'binary'))[0][0], 'Proyecto');
});

test('lectura de celdas: fechas, porcentajes, números y coincidencias', () => {
  assert.equal(parseDate('01/07/26').date, '2026-07-01');
  assert.equal(parseDate('30/11/2026').date, '2026-11-30');
  assert.equal(parseDate(46204).date, '2026-07-01');
  assert.equal(parseDate('RECURRENTE').recurring, true);
  assert.equal(parseDate('31/02/2026').date, null, 'fecha imposible');
  assert.equal(parsePercent(0.39), 39);
  assert.equal(parsePercent('45%'), 45);
  assert.equal(parsePercent(95), 95);
  assert.equal(parseNumber('1.728'), 1728);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(fuzzyMatch('Mejora Proceso', [{ name: 'Mejora evolutiva' }, { name: 'Mejora de proceso' }]).name, 'Mejora de proceso');
  assert.equal(matchUser('Mariano Montero', [{ name: 'Mariano Ruiz', email: 'mruiz@x' }]), null, 'no inventa responsables');
});

test('subcategorías técnicas en tickets, reglas, filtros e informes', async () => {
  const tech = meta.techCategories.find((x) => x.name.startsWith('O365-Outlook'));
  const other = meta.techCategories.find((x) => x.name.startsWith('Red/VPN'));
  const s1 = (await admin.post('/admin/tech-subcategories', { name: 'No recibe correos', tech_category_id: tech.id })).data;
  const s2 = (await admin.post('/admin/tech-subcategories', { name: 'VPN no conecta', tech_category_id: other.id })).data;
  assert.equal((await admin.post('/admin/tech-subcategories', { name: 'Sin categoría' })).status, 400);
  assert.equal((await admin.post('/admin/tech-subcategories', { name: 'X', tech_category_id: 99999 })).status, 400);
  const t = (await admin.post('/tickets', { subject: 'No me llegan los correos', contact_email: 'u1@hanseatica.com', tech_category_id: tech.id, tech_subcategory_id: s1.id })).data;
  assert.equal(t.tech_subcategory_id, s1.id);
  const t2 = (await admin.post('/tickets', { subject: 'Otro', contact_email: 'u1@hanseatica.com', tech_category_id: tech.id, tech_subcategory_id: s2.id })).data;
  assert.equal(t2.tech_subcategory_id, null, 'al crear, una subcategoría de otra categoría se descarta');
  assert.equal((await admin.patch(`/tickets/${t.number}`, { tech_subcategory_id: s2.id })).status, 400, 'no corresponde a la categoría');
  let r = await admin.get(`/tickets?subtech=${s1.id}`);
  assert.deepEqual(r.data.items.map((x) => x.number), [t.number]);
  ok(await admin.patch(`/tickets/${t.number}`, { tech_category_id: other.id }));
  assert.equal((await admin.get(`/tickets/${t.number}`)).data.ticket.tech_subcategory_id, null, 'al cambiar la categoría se limpia');
  // Regla de automatización que asigna la subcategoría
  ok(await admin.post('/admin/rules', {
    name: 'VPN', event: 'ticket_created', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'vpn' }],
    actions: [{ field: 'tech_category_id', value: String(other.id) }, { field: 'tech_subcategory_id', value: String(s2.id) }], active: true,
  }));
  const t3 = (await admin.post('/tickets', { subject: 'La VPN no anda', contact_email: 'u2@hanseatica.com' })).data;
  assert.equal(t3.tech_category_id, other.id);
  assert.equal(t3.tech_subcategory_id, s2.id);
  r = await admin.get('/reports/helpdesk?from=2020-01-01&to=2030-12-31');
  ok(r);
  assert.ok(r.data.bySubtech.some((x) => x.id === s2.id));
  r = await admin.get('/tickets/export');
  assert.ok(String(r.data).includes('Subcategoría'));
  assert.ok(String(r.data).includes('VPN no conecta'));
});

test('API de exportación: claves, permisos, paginación y formatos', async () => {
  for (let i = 0; i < 7; i++) ok(await admin.post('/tickets', { subject: `Ticket API ${i}`, contact_email: `api${i}@hanseatica.com` }));
  assert.equal((await admin.post('/super/api-keys', { name: 'x', scopes: ['tickets'] })).status, 403, 'solo el superadmin crea claves');
  assert.equal((await sup.post('/super/api-keys', { name: 'Sin permisos', scopes: [] })).status, 400);
  let r = await sup.post('/super/api-keys', { name: 'Power BI', scopes: ['tickets', 'projects'], expires_days: 30 });
  ok(r);
  const key = r.data.key;
  assert.match(key, /^hd_[\w-]{43}$/);
  const stored = await one('select key_hash, prefix from api_keys where id=$1', [r.data.id]);
  assert.notEqual(stored.key_hash, key, 'en la base queda solo el hash');
  assert.ok(key.startsWith(stored.prefix));
  assert.equal((await sup.get('/super/api-keys')).data.keys[0].key, undefined, 'la clave no se vuelve a mostrar');
  const H = { authorization: `Bearer ${key}` };
  assert.equal((await ext.get('/v1/tickets')).status, 401);
  assert.equal((await ext.get('/v1/tickets', { authorization: 'Bearer hd_cualquiercosa_que_no_existe_000000000000000' })).status, 401);
  assert.equal((await ext.get('/v1/tickets', { cookie: admin.getCookie() })).status, 401, 'la sesión del navegador no sirve: hace falta la clave');
  ok(await ext.get('/v1', H));
  // Paginación por cursor: recorre todo sin repetir ni saltear
  const total = (await one(`select count(*)::int as n from tickets where deleted_at is null and not spam`)).n;
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    r = await ext.get(`/v1/tickets?limit=3${cursor ? `&cursor=${cursor}` : ''}`, H);
    ok(r);
    for (const t of r.data.data) { assert.ok(!seen.has(t.number), `repetido ${t.number}`); seen.add(t.number); }
    cursor = r.data.next_cursor;
    pages++;
  } while (cursor && pages < 50);
  assert.equal(seen.size, total);
  assert.ok(pages >= 3);
  assert.equal((await ext.get('/v1/tickets?cursor=basura', H)).status, 400);
  assert.equal((await ext.get('/v1/tickets?limit=0', H)).status, 400);
  assert.equal((await ext.get('/v1/tickets?updated_since=ayer', H)).status, 400);
  r = await ext.get('/v1/tickets?updated_since=2099-01-01', H);
  assert.equal(r.data.count, 0);
  r = await ext.get('/v1/tickets?format=csv&limit=2', H);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.ok(r.headers['x-next-cursor']);
  assert.ok(String(r.data).split('\n')[0].includes('tech_subcategory'));
  const n = (await ext.get('/v1/tickets?limit=1', H)).data.data[0].number;
  r = await ext.get(`/v1/tickets/${n}`, H);
  ok(r);
  assert.ok(Array.isArray(r.data.data.messages));
  r = await ext.get('/v1/projects', H);
  ok(r);
  assert.ok(r.data.data.some((p) => p.key === 'CAP' && p.status === 'done'));
  ok(await ext.get('/v1/projects/FIRMA', H));
  ok(await ext.get('/v1/phases?format=csv', H));
  ok(await ext.get('/v1/issues?project=CAP', H));
  ok(await ext.get('/v1/catalog', H));
  assert.equal((await ext.get('/v1/time-entries', H)).status, 403, 'la clave no tiene permiso de horas');
  ok(await ext.get('/v1/openapi.json'));
  // Uso registrado y revocación
  const k = (await sup.get('/super/api-keys')).data.keys.find((x) => x.name === 'Power BI');
  assert.ok(Number(k.use_count) > 5);
  assert.ok(k.last_used_at);
  ok(await sup.del(`/super/api-keys/${k.id}`));
  assert.equal((await ext.get('/v1', H)).status, 401, 'revocada');
  // Vencida
  r = await sup.post('/super/api-keys', { name: 'Vieja', scopes: ['time'], expires_days: 1 });
  await q(`update api_keys set expires_at = now() - interval '1 minute' where id=$1`, [r.data.id]);
  assert.equal((await ext.get('/v1', { authorization: `Bearer ${r.data.key}` })).status, 401);
});

test('API: demasiados intentos con claves inválidas → 429', async () => {
  const atk = makeClient();
  let last;
  for (let i = 0; i < 32; i++) last = await atk.get('/v1/tickets', { authorization: `Bearer hd_${'x'.repeat(43)}`, 'x-real-ip': '203.0.113.9' });
  assert.equal(last.status, 429);
  assert.ok(last.headers['retry-after']);
});

// ---------- Hallazgos de la revisión independiente ----------
test('revisión: quien solo ve el portfolio no toma control del proyecto', async () => {
  const anaId = (await agent.get('/auth/me')).data.user.id;
  ok(await sup.patch(`/admin/users/${anaId}`, { can_portfolio: true }));
  assert.equal((await agent.patch('/projects/ERP', { lead_id: anaId })).status, 403, 'no puede hacerse líder');
  assert.equal((await agent.patch('/projects/ERP', { archived: true })).status, 403);
  ok(await agent.patch('/projects/ERP', { progress_override: 15, estimated_hours: 80 }), 'sí edita los datos del portfolio');
  assert.equal((await agent.del('/projects/ERP')).status, 403, 'ni borrarlo');
  ok(await sup.patch(`/admin/users/${anaId}`, { can_portfolio: false }));
  // Sin permiso, no ve horas ni avance manual
  const list = (await agent.get('/projects')).data.find((p) => p.key === 'ERP');
  assert.equal(list.estimated_hours, undefined);
  const det = (await agent.get('/projects/ERP')).data;
  assert.equal(det.project.estimated_hours, undefined);
  assert.equal(det.portfolio.hours, undefined);
  assert.ok(Array.isArray(det.portfolio.phases), 'el roadmap del proyecto sigue funcionando');
});

test('revisión: importación con valores fuera de rango y sin permiso de administrador', async () => {
  const anaId = (await agent.get('/auth/me')).data.user.id;
  ok(await sup.patch(`/admin/users/${anaId}`, { can_portfolio: true }));
  const cols = ['Proyecto', 'Area', 'Fecha Inicio', 'Horas Manuales', 'Estado'].map((h) => ({ header: h, type: h === 'Fecha Inicio' ? 'date' : h === 'Horas Manuales' ? 'number' : 'text' }));
  const data = writeXlsx([{ name: 'P', columns: cols, rows: [['Proyecto raro', 'Área Inventada Nueva', null, -50, 'En curso']] }]).toString('base64');
  let r = await agent.post('/portfolio/import', { filename: 'p.xlsx', data, dry: true });
  ok(r);
  assert.equal(r.data.rows[0].fields.area, null, 'un agente no crea áreas');
  assert.equal(r.data.rows[0].fields.extra_hours, 0, 'horas negativas → 0');
  // Fecha absurda escrita como número de serie con formato de fecha
  const { zip } = await import('../lib/xlsx.js');
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Proyecto</t></is></c><c r="B1" t="inlineStr"><is><t>Fecha Inicio</t></is></c><c r="C1" t="inlineStr"><is><t>Estado</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>Fecha absurda</t></is></c><c r="B2" s="1"><v>2958466</v></c><c r="C2" t="inlineStr"><is><t>En curso</t></is></c></row></sheetData></worksheet>';
  const bad = zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]).toString('base64');
  r = await admin.post('/portfolio/import', { filename: 'p.xlsx', data: bad, dry: false });
  ok(r, 'no da 500');
  assert.equal((await one(`select start_date from projects where name='Fecha absurda'`)).start_date, null);
  // Reimportar sin columnas de fecha no borra "recurrente"
  const cap = await one(`select id from projects where name='Capacitaciones'`);
  const noDates = writeXlsx([{ name: 'P', columns: [{ header: 'Proyecto' }, { header: 'Estado' }], rows: [['Capacitaciones', 'En curso']] }]).toString('base64');
  ok(await admin.post('/portfolio/import', { filename: 'p.xlsx', data: noDates, dry: false }));
  assert.equal((await one('select recurring from projects where id=$1', [cap.id])).recurring, true);
  ok(await sup.patch(`/admin/users/${anaId}`, { can_portfolio: false }));
});

test('revisión: archivo Excel malicioso no traba el servidor', async () => {
  const { zip } = await import('../lib/xlsx.js');
  const mk = (s) => zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: s },
  ]);
  for (const piece of ['<row>', '<c>', '<si>', '<row><c r="A1"><v>1']) {
    const t = Date.now();
    try { readXlsx(mk(`<worksheet><sheetData>${piece.repeat(300000)}</sheetData></worksheet>`)); } catch { /* puede rechazarlo */ }
    assert.ok(Date.now() - t < 1500, `${piece} tardó ${Date.now() - t} ms`);
  }
});

test('revisión: referencias inválidas → 400, CSV sin fórmulas y sincronización incremental', async () => {
  assert.equal((await admin.post('/projects', { key: 'MEM', name: 'x', member_ids: [99999] })).status, 400);
  assert.equal((await admin.post('/projects', { key: 'MEM2', name: 'x', phases: [{ name: 'A', assignee_id: 99999 }] })).status, 400);
  const { toCsv } = await import('../lib/xlsx.js');
  const csv = toCsv([["-1+1+cmd|' /C calc'!A0", '-12.5', '=SUMA(1)']]);
  assert.ok(csv.includes("'-1+1+cmd"), 'se neutraliza');
  assert.ok(csv.includes(',-12.5,'), 'los números negativos quedan igual');
  assert.ok(csv.includes("'=SUMA"));
  // Crear una tarea marca el proyecto como modificado (la API la ve con updated_since)
  const r = await sup.post('/super/api-keys', { name: 'Sync', scopes: ['projects'] });
  const H = { authorization: `Bearer ${r.data.key}` };
  const before = new Date(Date.now() - 1000).toISOString();
  await q(`update projects set updated_at = now() - interval '1 day' where key='ERP'`);
  assert.ok(!(await ext.get(`/v1/projects?updated_since=${before}`, H)).data.data.some((p) => p.key === 'ERP'));
  ok(await admin.post('/projects/ERP/issues', { type: 'task', title: 'Instalar servidor' }));
  assert.ok((await ext.get(`/v1/projects?updated_since=${before}`, H)).data.data.some((p) => p.key === 'ERP'));
});
