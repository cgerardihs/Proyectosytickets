// v1.16: Operación de IT. Rutinas con repetición (días hábiles y feriados), agenda, registro con horas y ticket si falla.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { q, one } = await import('../lib/db.js');
const { occurrences, normalizeRule, ruleText, assigneeFor, opsCalendar } = await import('../lib/ops.js');
const { BACKUP_TABLES } = await import('../lib/routes/super.js');
const admin = makeClient();
const agente = makeClient();
const otro = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);
const U = {};
let today;

// Calendario fijo para las reglas: lunes a viernes, con el 08/12 y el 25/12/2026 feriados
const C = { days: [1, 2, 3, 4, 5], holidays: new Set(['2026-12-08', '2026-12-25']), today: '2026-11-02' };
const dates = (rule, from, to) => occurrences(normalizeRule(rule, '2026-11-02'), from, to, C).map((o) => o.date);

test('reglas: primer lunes, último día hábil, segundo martes con feriado, día 15 corrido, cada 3 meses y semanal', () => {
  assert.deepEqual(dates({ freq: 'monthly', mode: 'nth', nth: 1, wd: 1 }, '2026-11-01', '2027-01-31'), ['2026-11-02', '2026-12-07', '2027-01-04']);
  assert.deepEqual(dates({ freq: 'monthly', mode: 'nth', nth: -1, wd: 'bd' }, '2026-11-01', '2026-12-31'), ['2026-11-30', '2026-12-31']);
  const patch = occurrences(normalizeRule({ freq: 'monthly', mode: 'nth', nth: 2, wd: 2, shift: 'next' }, '2026-11-02'), '2026-11-01', '2026-12-31', C);
  assert.deepEqual(patch, [{ date: '2026-11-10', orig: null }, { date: '2026-12-09', orig: '2026-12-08' }], 'el 08/12 es feriado: pasa al 09/12');
  assert.deepEqual(dates({ freq: 'monthly', mode: 'day', day: 15, shift: 'prev' }, '2026-11-01', '2026-11-30'), ['2026-11-13'], 'el 15/11 es domingo: pasa al viernes');
  assert.deepEqual(dates({ freq: 'monthly', mode: 'nth', nth: 1, wd: 'bd', every: 3, start: '2026-08' }, '2026-09-01', '2027-05-31'), ['2026-11-02', '2027-02-01', '2027-05-03']);
  assert.deepEqual(dates({ freq: 'weekly', days: [1, 4] }, '2026-11-02', '2026-11-08'), ['2026-11-02', '2026-11-05']);
  assert.equal(dates({ freq: 'daily', workdays: true }, '2026-12-21', '2026-12-27').length, 4, 'sin fin de semana ni Navidad');
  assert.deepEqual(dates({ freq: 'yearly', month: 11, day: 1 }, '2026-01-01', '2027-12-31'), ['2026-12-01', '2027-12-01']);
  assert.equal(ruleText(normalizeRule({ freq: 'monthly', mode: 'nth', nth: 1, wd: 1 })), 'Todos los meses, el primer lunes');
  assert.equal(ruleText(normalizeRule({ freq: 'weekly', days: [4, 1] })), 'Todos los lunes y jueves');
  assert.throws(() => normalizeRule({ freq: 'weekly', days: [] }), /al menos un día/);
  assert.throws(() => normalizeRule({ freq: 'cada tanto' }), /cada cuánto/);
  // Rotación: dos personas se turnan mes a mes
  const rot = { assignee_ids: [7, 9], rule: { freq: 'monthly' } };
  assert.notEqual(assigneeFor(rot, '2026-11-10'), assigneeFor(rot, '2026-12-09'));
});

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  for (const [k, name] of [['ops.agente', 'Agente Operación'], ['ops.otro', 'Otro Agente']]) {
    const r = await admin.post('/admin/users', { name, email: `${k}@hanseatica.com`, role: 'agent', password: 'Rio-de-la-Plata-9' });
    ok(r, name);
    U[k] = r.data.id ?? r.data.user?.id;
  }
  ok(await agente.post('/auth/login', { email: 'ops.agente@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  ok(await otro.post('/auth/login', { email: 'ops.otro@hanseatica.com', password: 'Rio-de-la-Plata-9' }));
  today = (await opsCalendar()).today;
});

let backup;
let once;
test('crear rutinas y ver la vista previa', async () => {
  const pv = await agente.post('/ops/preview', { rule: { freq: 'monthly', mode: 'nth', nth: 1, wd: 1 } });
  ok(pv);
  assert.equal(pv.data.text, 'Todos los meses, el primer lunes');
  assert.equal(pv.data.dates.length, 8);
  assert.equal((await agente.post('/ops/preview', { rule: { freq: 'weekly', days: [] } })).status, 400);
  let r = await agente.post('/ops/routines', { name: 'Verificar backups nocturnos', category: 'Backups', assignee_ids: [U['ops.agente']], est_minutes: 15, due_time: '09:30', rule: { freq: 'daily', workdays: false }, steps: ['Revisar el informe', 'Confirmar que no haya fallidos'] });
  ok(r);
  backup = r.data;
  assert.equal(backup.rule_text, 'Todos los días');
  assert.equal(backup.next_date, today);
  r = await agente.post('/ops/routines', { name: 'Migrar la impresora de Recepción', category: 'Mantenimiento', assignee_ids: [U['ops.agente']], est_minutes: 60, rule: { freq: 'once', date: today } });
  ok(r);
  once = r.data;
  assert.equal((await agente.post('/ops/routines', { name: 'Mala', rule: { freq: 'once', date: today }, due_time: '25:00' })).status, 400, 'hora inválida');
  assert.equal((await agente.post('/ops/routines', { name: 'Sin regla', rule: {} })).status, 400);
});

test('la agenda muestra lo de hoy y filtra por persona y categoría', async () => {
  let a = (await agente.get('/ops/agenda')).data;
  assert.deepEqual(a.groups.today.map((i) => i.name).sort(), ['Migrar la impresora de Recepción', 'Verificar backups nocturnos']);
  assert.ok(a.categories.includes('Backups'));
  assert.equal(a.week_minutes[U['ops.agente']] >= 75, true);
  a = (await otro.get('/ops/agenda?user=me')).data;
  assert.equal(a.groups.today.length, 0, 'no es de este agente');
  a = (await agente.get('/ops/agenda?category=Backups')).data;
  assert.deepEqual(a.groups.today.map((i) => i.name), ['Verificar backups nocturnos']);
  const mine = (await agente.get('/ops/mine')).data;
  assert.equal(mine.due_today.length, 2);
});

test('registrar como hecha guarda las horas en la misma tabla que tickets y proyectos', async () => {
  assert.equal((await agente.post('/ops/records', { routine_id: backup.id, date: today, status: 'done', minutes: 0 })).status, 400, 'hace falta el tiempo');
  const r = await agente.post('/ops/records', { routine_id: backup.id, date: today, status: 'done', minutes: 20, result: 'ok', steps_done: [0, 1], note: 'Todo bien' });
  ok(r);
  const te = await q('select * from time_entries where ops_record_id=$1', [r.data.record.id]);
  assert.equal(te.length, 1);
  assert.equal(te[0].minutes, 20);
  assert.equal(te[0].user_id, U['ops.agente']);
  // Volver a guardar no duplica las horas
  ok(await agente.post('/ops/records', { routine_id: backup.id, date: today, status: 'done', minutes: 25, result: 'obs', note: 'Tardó más' }));
  const te2 = await q('select te.minutes from time_entries te join ops_records r on r.id=te.ops_record_id where r.routine_id=$1', [backup.id]);
  assert.deepEqual(te2.map((x) => x.minutes), [25]);
  const a = (await agente.get('/ops/agenda')).data;
  assert.equal(a.groups.today.find((i) => i.routine_id === backup.id).record.result, 'obs');
  assert.equal((await agente.get('/ops/mine')).data.due_today.length, 1);
  // No se registra en una fecha que no tocaba ni a futuro
  assert.equal((await agente.post('/ops/records', { routine_id: once.id, date: '2020-01-01', status: 'done', minutes: 5 })).status, 400);
});

test('si falló, abre un ticket vinculado asignado a quien la hizo', async () => {
  const r = await agente.post('/ops/records', { routine_id: once.id, date: today, status: 'done', minutes: 60, result: 'fail', open_ticket: true, note: 'La impresora no toma la IP' });
  ok(r);
  assert.ok(r.data.ticket?.number);
  const t = (await admin.get(`/tickets/${r.data.ticket.number}`)).data;
  assert.match(t.ticket.subject, /Migrar la impresora de Recepción: falló/);
  assert.equal(t.ticket.assignee_id, U['ops.agente']);
  assert.equal(t.ticket.priority, 3);
  assert.equal((await one('select ticket_id from ops_records where id=$1', [r.data.record.id])).ticket_id, r.data.ticket.id);
});

test('omitir pide motivo; deshacer borra el registro y sus horas', async () => {
  const r2 = await agente.post('/ops/routines', { name: 'Revisar logs del firewall', assignee_ids: [U['ops.agente']], rule: { freq: 'once', date: today } });
  ok(r2);
  assert.equal((await agente.post('/ops/records', { routine_id: r2.data.id, date: today, status: 'skipped' })).status, 400);
  const s = await agente.post('/ops/records', { routine_id: r2.data.id, date: today, status: 'skipped', note: 'Firewall en mantenimiento' });
  ok(s);
  assert.equal((await q('select 1 from time_entries where ops_record_id=$1', [s.data.record.id])).length, 0, 'omitida no suma horas');
  const rec = (await agente.post('/ops/records', { routine_id: r2.data.id, date: today, status: 'done', minutes: 30 })).data.record;
  assert.equal((await otro.del(`/ops/records/${rec.id}`)).status, 403, 'otro agente no lo deshace');
  ok(await agente.del(`/ops/records/${rec.id}`));
  assert.equal((await q('select 1 from time_entries where ops_record_id=$1', [rec.id])).length, 0);
});

test('editar, pausar y eliminar: quien la creó o un supervisor', async () => {
  assert.equal((await otro.patch(`/ops/routines/${backup.id}`, { active: false })).status, 403);
  let r = await admin.patch(`/ops/routines/${backup.id}`, { active: false });
  ok(r);
  assert.equal(r.data.active, false);
  assert.ok(!(await agente.get('/ops/agenda')).data.groups.today.some((i) => i.routine_id === backup.id), 'pausada no aparece');
  r = await agente.patch(`/ops/routines/${backup.id}`, { active: true, est_minutes: 20, rule: { freq: 'weekly', days: [1, 2, 3, 4, 5] } });
  ok(r);
  assert.equal(r.data.rule_text, 'Todos los lunes, martes, miércoles, jueves y viernes');
  assert.equal((await agente.del(`/ops/routines/${backup.id}`)).status, 400, 'con registros se pausa, no se borra');
  const n = await agente.post('/ops/routines', { name: 'Para borrar', rule: { freq: 'once', date: today } });
  ok(await agente.del(`/ops/routines/${n.data.id}`));
  const list = (await agente.get('/ops/routines')).data.routines;
  assert.ok(list.every((x) => x.name !== 'Para borrar'));
});

test('las tablas nuevas entran en el respaldo, antes de las horas', () => {
  assert.ok(BACKUP_TABLES.indexOf('ops_routines') > BACKUP_TABLES.indexOf('tickets'));
  assert.ok(BACKUP_TABLES.indexOf('ops_records') < BACKUP_TABLES.indexOf('time_entries'));
});
