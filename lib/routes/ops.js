// Operación de IT (v1.16): rutinas, agenda y registro de lo hecho. Ver lib/ops.js.
import { q, one, txRouter } from '../db.js';
import { v, parse, idParam } from '../validate.js';
import { requireUser, isManager } from '../auth.js';
import { bad, notFound, forbidden } from '../http.js';
import { createTicket } from '../tickets-core.js';
import {
  OPS_RESULTS, opsCalendar, normalizeRule, occurrences, ruleText, assigneeFor, opsItems, historyOf, addDays, LATE_LOOKBACK,
} from '../ops.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const canEditRoutine = (u, r) => isManager(u) || r.created_by === u.id;
const dmy = (s) => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

async function activeUserIds(ids) {
  if (!ids.length) return [];
  const rows = await q(`select id from users where id = any($1::int[]) and active and role <> 'superadmin'`, [ids]);
  const ok = new Set(rows.map((x) => x.id));
  const bad0 = ids.filter((x) => !ok.has(x));
  if (bad0.length) throw bad('Hay responsables que no son agentes activos');
  return ids;
}

const routineFields = {
  name: v.string({ min: 1, max: 200 }),
  description: v.string({ max: 5000, default: '' }),
  category: v.string({ max: 60, default: '' }),
  assignee_ids: v.array(v.id(), { max: 10, default: () => [] }),
  est_minutes: v.int({ min: 1, max: 1440, default: 30 }),
  due_time: v.string({ max: 5, default: '18:00' }),
  notice_days: v.int({ min: 0, max: 60, default: 0 }),
  rule: v.any(),
  steps: v.array(v.string({ max: 300 }), { max: 40, default: () => [] }),
  critical_system_id: v.id({ optional: true, nullable: true }),
  tech_category_id: v.id({ optional: true, nullable: true }),
  active: v.bool({ default: true }),
};

async function cleanRoutine(b, c) {
  if (!TIME_RE.test(b.due_time)) throw bad('La hora va en formato 24 h, por ejemplo 18:00');
  const out = {
    name: b.name.trim(), description: b.description.trim(), category: b.category.trim(), assignee_ids: await activeUserIds([...new Set(b.assignee_ids)]),
    est_minutes: b.est_minutes, due_time: b.due_time, notice_days: b.notice_days, rule: normalizeRule(b.rule, c.today),
    steps: b.steps.map((s) => s.trim()).filter(Boolean), critical_system_id: b.critical_system_id || null, tech_category_id: b.tech_category_id || null, active: b.active,
  };
  if (!out.name) throw bad('Escribí qué hay que hacer');
  if (out.tech_category_id && !(await one('select 1 as x from tech_categories where id=$1', [out.tech_category_id]))) throw bad('La categoría técnica no existe');
  return out;
}

/** Rutina con su próxima fecha y su historial corto, para la lista. */
async function routineRows(c, ids = null) {
  const routines = await q(`select * from ops_routines ${ids ? 'where id = any($1::int[])' : ''} order by active desc, name`, ids ? [ids] : []);
  if (!routines.length) return [];
  const recs = await q(`select routine_id, due_date::text as due_date, status, result from ops_records where routine_id = any($1::int[]) and due_date >= $2::date`,
    [routines.map((r) => r.id), addDays(c.today, -400)]);
  const done = new Set(recs.map((x) => `${x.routine_id}|${x.due_date}`));
  return routines.map((r) => {
    const next = occurrences(r.rule, c.today, addDays(c.today, 800), c).find((o) => !done.has(`${r.id}|${o.date}`)) || null;
    return {
      ...r, rule_text: ruleText(r.rule), next_date: next?.date || null, next_assignee_id: next ? assigneeFor(r, next.date) : null,
      history: historyOf(r, recs, c),
    };
  });
}

export function opsRoutes(router) {
  const r = txRouter(router);

  /** Agenda: vencidas, hoy, lo que queda de la semana y las próximas dos semanas (más lo que tiene aviso anticipado). */
  r.get('/ops/agenda', async ({ req, query }) => {
    const u = await requireUser(req);
    const c = await opsCalendar();
    const { routines, items } = await opsItems({ from: addDays(c.today, -LATE_LOOKBACK), to: addDays(c.today, 62), c });
    const user = query.user === 'me' ? u.id : query.user ? Number(query.user) : null;
    const cat = String(query.category || '');
    const list = items.filter((i) => (!user || i.assignee_id === user) && (!cat || i.category === cat));
    const dow = (new Date(`${c.today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const endWeek = addDays(c.today, 6 - dow);
    const horizon = addDays(c.today, 20);
    const groups = {
      late: list.filter((i) => i.late),
      today: list.filter((i) => i.date === c.today),
      week: list.filter((i) => i.date > c.today && i.date <= endWeek),
      next: list.filter((i) => i.date > endWeek && (i.date <= horizon || i.date <= addDays(c.today, i.notice_days))),
    };
    // Horas de operación de la semana por persona (lo planificado o, si ya se registró, lo real)
    const week = {};
    for (const i of items.filter((x) => (x.date >= addDays(c.today, -dow) && x.date <= endWeek) || x.late)) {
      if (i.record?.status === 'skipped') continue;
      const k = i.assignee_id || 0;
      week[k] = (week[k] || 0) + (i.record ? i.record.minutes : i.est_minutes);
    }
    return {
      today: c.today, end_week: endWeek, groups, week_minutes: week,
      categories: [...new Set(routines.map((x) => x.category).filter(Boolean))].sort(),
      daily: [...new Set(list.filter((i) => i.freq === 'daily').map((i) => i.name))],
    };
  });

  /** Para Inicio y Mi trabajo: lo vencido y lo de hoy de quien consulta. */
  r.get('/ops/mine', async ({ req }) => {
    const u = await requireUser(req);
    const c = await opsCalendar();
    const { items } = await opsItems({ from: addDays(c.today, -LATE_LOOKBACK), to: c.today, c });
    const mine = items.filter((i) => i.assignee_id === u.id && !i.record);
    return { today: c.today, late: mine.filter((i) => i.late), due_today: mine.filter((i) => i.date === c.today) };
  });

  r.get('/ops/routines', async ({ req }) => {
    await requireUser(req);
    const c = await opsCalendar();
    return { today: c.today, routines: await routineRows(c) };
  });

  r.get('/ops/routines/:id', async ({ req, params }) => {
    await requireUser(req);
    const c = await opsCalendar();
    const [row] = await routineRows(c, [idParam(params.id)]);
    if (!row) throw notFound('No existe la tarea');
    return row;
  });

  /** Vista previa de la repetición: la regla en palabras y las próximas fechas. */
  r.post('/ops/preview', async ({ req, body }) => {
    await requireUser(req);
    const c = await opsCalendar();
    const rule = normalizeRule(parse(v.object({ rule: v.any() }), body).rule, c.today);
    const dates = occurrences(rule, c.today, addDays(c.today, 800), c).slice(0, 8).map((o) => ({ ...o, holiday: Boolean(o.orig && c.holidays.has(o.orig)) }));
    return { text: ruleText(rule), dates };
  }, { tx: false });

  r.post('/ops/routines', async ({ req, body }) => {
    const u = await requireUser(req);
    const c = await opsCalendar();
    const x = await cleanRoutine(parse(v.object(routineFields), body), c);
    const row = await one(`insert into ops_routines(name,description,category,assignee_ids,est_minutes,due_time,notice_days,rule,steps,critical_system_id,tech_category_id,active,created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) returning id`,
    [x.name, x.description, x.category, x.assignee_ids, x.est_minutes, x.due_time, x.notice_days, JSON.stringify(x.rule), x.steps, x.critical_system_id, x.tech_category_id, x.active, u.id]);
    return (await routineRows(c, [row.id]))[0];
  });

  r.patch('/ops/routines/:id', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const cur = await one('select * from ops_routines where id=$1', [idParam(params.id)]);
    if (!cur) throw notFound('No existe la tarea');
    if (!canEditRoutine(u, cur)) throw forbidden('Solo quien la creó o un supervisor puede cambiarla');
    const c = await opsCalendar();
    // Se aceptan cambios parciales (ej. solo pausar): lo que no viene queda como estaba
    const merged = { ...cur, rule: cur.rule, ...Object.fromEntries(Object.entries(body || {}).filter(([k]) => k in routineFields)) };
    const x = await cleanRoutine(parse(v.object(routineFields), {
      name: merged.name, description: merged.description, category: merged.category, assignee_ids: merged.assignee_ids, est_minutes: merged.est_minutes,
      due_time: merged.due_time, notice_days: merged.notice_days, rule: merged.rule, steps: merged.steps, critical_system_id: merged.critical_system_id,
      tech_category_id: merged.tech_category_id, active: merged.active,
    }), c);
    await q(`update ops_routines set name=$2,description=$3,category=$4,assignee_ids=$5,est_minutes=$6,due_time=$7,notice_days=$8,rule=$9::jsonb,steps=$10,
      critical_system_id=$11,tech_category_id=$12,active=$13,updated_at=now() where id=$1`,
    [cur.id, x.name, x.description, x.category, x.assignee_ids, x.est_minutes, x.due_time, x.notice_days, JSON.stringify(x.rule), x.steps, x.critical_system_id, x.tech_category_id, x.active]);
    return (await routineRows(c, [cur.id]))[0];
  });

  r.del('/ops/routines/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const cur = await one('select * from ops_routines where id=$1', [idParam(params.id)]);
    if (!cur) throw notFound('No existe la tarea');
    if (!canEditRoutine(u, cur)) throw forbidden('Solo quien la creó o un supervisor puede eliminarla');
    const used = await one('select count(*)::int as n from ops_records where routine_id=$1', [cur.id]);
    if (used.n) throw bad(`Tiene ${used.n} registro${used.n === 1 ? '' : 's'} con horas: pausala en lugar de eliminarla para no perder el historial`);
    await q('delete from ops_routines where id=$1', [cur.id]);
    return { ok: true };
  });

  /**
   * Registrar una ocurrencia: hecha (con tiempo, resultado, nota y pasos) u omitida (con motivo). El tiempo se guarda como una
   * hora más de la persona (time_entries), igual que en tickets y proyectos. Si falló, puede abrir un ticket vinculado.
   */
  r.post('/ops/records', async ({ req, body }) => {
    const u = await requireUser(req);
    const b = parse(v.object({
      routine_id: v.id(), date: v.date(), status: v.enum(['done', 'skipped'], { default: 'done' }), result: v.enum(OPS_RESULTS, { default: 'ok' }),
      minutes: v.int({ min: 0, max: 1440, default: 0 }), note: v.string({ max: 5000, default: '' }), steps_done: v.array(v.int({ min: 0, max: 39 }), { max: 40, default: () => [] }),
      done_by: v.id({ optional: true, nullable: true }), open_ticket: v.bool({ default: false }),
    }), body);
    const rt = await one('select * from ops_routines where id=$1', [b.routine_id]);
    if (!rt) throw notFound('No existe la tarea');
    const c = await opsCalendar();
    const date = String(b.date).slice(0, 10);
    if (date > c.today) throw bad('No se puede registrar una tarea antes de su fecha');
    if (!occurrences(rt.rule, date, date, c).length) throw bad(`La tarea no tocaba el ${dmy(date)}`);
    if (b.status === 'skipped' && !b.note.trim()) throw bad('Contá por qué se omite');
    if (b.status === 'done' && !b.minutes) throw bad('Indicá el tiempo dedicado');
    const doneBy = b.done_by || u.id;
    if (b.done_by) await activeUserIds([b.done_by]);
    const prev = await one('select id, ticket_id from ops_records where routine_id=$1 and due_date=$2::date', [rt.id, date]);
    const values = [rt.id, date, b.status, b.status === 'done' ? b.result : null, doneBy, b.status === 'done' ? b.minutes : 0, b.note.trim(), b.status === 'done' ? b.steps_done : [], u.id];
    const rec = prev
      ? await one(`update ops_records set status=$2,result=$3,done_by=$4,minutes=$5,note=$6,steps_done=$7,created_by=$8,done_at=now() where id=$1 returning *`, [prev.id, ...values.slice(2)])
      : await one(`insert into ops_records(routine_id,due_date,status,result,done_by,minutes,note,steps_done,created_by) values ($1,$2::date,$3,$4,$5,$6,$7,$8,$9) returning *`, values);
    // Horas: una sola entrada por registro, con la fecha en que se hizo
    await q('delete from time_entries where ops_record_id=$1', [rec.id]);
    if (b.status === 'done' && b.minutes) {
      await q('insert into time_entries(user_id,minutes,note,spent_on,ops_record_id) values ($1,$2,$3,$4::date,$5)', [doneBy, b.minutes, `Operación: ${rt.name}`.slice(0, 500), c.today, rec.id]);
    }
    let ticket = null;
    if (b.status === 'done' && b.result === 'fail' && b.open_ticket && !prev?.ticket_id) {
      const who = await one('select id, name, email from users where id=$1', [doneBy]);
      ticket = await createTicket({
        subject: `${rt.name}: falló (${dmy(date)})`, channel: 'agent', priority: 3, assignee_id: doneBy, tech_category_id: rt.tech_category_id,
        contact_email: who.email, contact_name: who.name,
        body_html: `<p>Falló la tarea de operación <b>${escapeHtml(rt.name)}</b> del ${dmy(date)}.</p>${b.note.trim() ? `<p>${escapeHtml(b.note.trim()).replace(/\n/g, '<br>')}</p>` : ''}`,
      }, { user: u, req });
      await q('update ops_records set ticket_id=$2 where id=$1', [rec.id, ticket.id]);
    }
    return { record: await one('select *, due_date::text as due_date from ops_records where id=$1', [rec.id]), ticket: ticket ? { id: ticket.id, number: ticket.number } : null };
  });

  /** Deshacer un registro: la ocurrencia vuelve a pendiente y se borran sus horas. */
  r.del('/ops/records/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const rec = await one('select * from ops_records where id=$1', [idParam(params.id)]);
    if (!rec) throw notFound('No existe el registro');
    if (!isManager(u) && rec.done_by !== u.id && rec.created_by !== u.id) throw forbidden('Solo quien la registró o un supervisor puede deshacerlo');
    await q('delete from ops_records where id=$1', [rec.id]);
    return { ok: true };
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
