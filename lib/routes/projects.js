// Gestión de proyectos estilo Jira: proyectos, issues, sprints, tablero, backlog e informes.
import { sanitizeHtml } from '../sanitize.js';
import { v, parse, likeTerm } from '../validate.js';
import { q, one, Where, txRouter } from '../db.js';
import { requireUser, isManager, isAdminRole } from '../auth.js';
import { audit } from '../audit.js';
import { bad, notFound, forbidden, int } from '../http.js';
import { notify, saveAttachments, stripHtml } from '../tickets-core.js';
import { canPortfolio, portfolioRows } from '../portfolio.js';
import { ctx } from '../context.js';
import { estimateHours } from '../workdays.js';
import { logError } from '../log.js';

/** Tickets vinculados visibles: desde la v1.9 todos ven todos los tickets (no hay grupos privados). */
const ticketVis = () => 'true';

const TYPES = ['epic', 'story', 'task', 'bug', 'subtask'];
const TYPE_LABEL = { epic: 'Épica', story: 'Historia', task: 'Tarea', bug: 'Bug', subtask: 'Subtarea' };

async function projectByKey(key) {
  const p = await one('select * from projects where upper(key)=upper($1)', [String(key)]);
  if (!p) throw notFound('No existe el proyecto');
  return p;
}

async function issueByKey(key) {
  const i = await one('select * from issues where upper(key)=upper($1)', [String(key)]);
  if (!i) throw notFound('No existe la tarea');
  return i;
}

// Configurar un proyecto: supervisores y administradores, su líder y quien tenga el permiso "Configurar proyectos"
const canAdmin = (u, p) => isManager(u) || Boolean(u.can_manage_projects) || p.lead_id === u.id;
// Datos del portfolio que solo ven quienes lo gestionan (horas y avance cargado a mano)
const PORTFOLIO_PRIVATE = ['estimated_hours', 'extra_hours', 'progress_override'];
const hidePortfolio = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !PORTFOLIO_PRIVATE.includes(k)));

async function logIssue(issueId, userId, action, details = {}) {
  await q('insert into issue_activities(issue_id,user_id,action,details) values ($1,$2,$3,$4::jsonb)', [issueId, userId || null, action, JSON.stringify(details)]);
}

const ISSUE_COLS = `i.id,i.project_id,i.number,i.key,i.type,i.title,i.status_id,i.priority,i.assignee_id,i.reporter_id,i.parent_id,i.sprint_id,
  i.story_points,i.estimate_minutes,i.labels,i.start_date,i.due_date,i.progress,i.rank,i.resolved_at,i.created_at,i.updated_at,
  ps.kind as status_kind, ps.name as status_name`;

async function validateParent(projectId, type, parentId) {
  if (!parentId) {
    if (type === 'subtask') throw bad('Una subtarea necesita una tarea padre');
    return null;
  }
  const p = await one('select id,type,project_id from issues where id=$1', [parentId]);
  if (!p || p.project_id !== projectId) throw bad('La tarea padre no es válida');
  if (type === 'epic') throw bad('Una épica no puede tener padre');
  if (type === 'subtask' && (p.type === 'epic' || p.type === 'subtask')) throw bad('El padre de una subtarea debe ser una historia, tarea o bug');
  if (type !== 'subtask' && p.type !== 'epic') throw bad('El padre de una historia, tarea o bug debe ser una épica');
  return p.id;
}

export async function createIssue(data, user, req = null) {
  const project = data.project_id ? await one('select * from projects where id=$1', [int(data.project_id)]) : await projectByKey(data.project_key);
  if (!project) throw notFound('No existe el proyecto');
  const type = TYPES.includes(data.type) ? data.type : 'task';
  const title = String(data.title || '').trim().slice(0, 300);
  if (!title) throw bad('El título es obligatorio');
  {
    const s0 = isoDate(data.start_date);
    const e0 = isoDate(data.due_date);
    if (s0 && e0 && e0 < s0) throw bad(`La fecha de fin (${dmy(e0)}) no puede ser anterior a la de inicio (${dmy(s0)})`);
  }
  const parentId = await validateParent(project.id, type, data.parent_id ? int(data.parent_id) : null);
  let statusId = data.status_id ? int(data.status_id) : null;
  if (statusId) {
    const s = await one('select id from project_statuses where id=$1 and project_id=$2', [statusId, project.id]);
    if (!s) statusId = null;
  }
  if (!statusId) statusId = (await one(`select id from project_statuses where project_id=$1 order by case kind when 'todo' then 0 when 'doing' then 1 else 2 end, sort limit 1`, [project.id]))?.id || null;
  let sprintId = data.sprint_id ? int(data.sprint_id) : null;
  if (type === 'epic') sprintId = null;
  if (type === 'subtask' && parentId && !sprintId) sprintId = (await one('select sprint_id from issues where id=$1', [parentId]))?.sprint_id || null;
  const seq = await one('update projects set issue_seq=issue_seq+1 where id=$1 returning issue_seq', [project.id]);
  const rank = (await one('select coalesce(max(rank),0)+1000 as r from issues where project_id=$1', [project.id])).r;
  const priority = [1, 2, 3, 4].includes(Number(data.priority)) ? Number(data.priority) : 2;
  const issue = await one(
    `insert into issues(project_id,number,key,type,title,description_html,status_id,priority,assignee_id,reporter_id,parent_id,sprint_id,story_points,estimate_minutes,labels,start_date,due_date,rank)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
    [project.id, seq.issue_seq, `${project.key}-${seq.issue_seq}`, type, title, sanitizeHtml(String(data.description_html || '').slice(0, 500000)), statusId, priority,
      data.assignee_id ? int(data.assignee_id) : null, user.id, parentId, sprintId, data.story_points === '' || data.story_points == null ? null : Number(data.story_points),
      data.estimate_minutes ? int(data.estimate_minutes) : null, Array.isArray(data.labels) ? data.labels.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 20) : [],
      isoDate(data.start_date), isoDate(data.due_date), Number(rank)],
  );
  await logIssue(issue.id, user.id, 'created', { type });
  await touchProject(project.id);
  if (parentId && !data.skipRules) await runDevRules(project.id, user, req);
  if (issue.assignee_id) await notify([issue.assignee_id], `Te asignaron ${issue.key}`, issue.title, `#/issue/${issue.key}`, user.id);
  return issue;
}

async function issueDetail(i) {
  const [project, statuses, children, comments, activities, linksOut, linksIn, tickets, attachments, time, parent] = await Promise.all([
    one('select id,key,name,color from projects where id=$1', [i.project_id]),
    q('select * from project_statuses where project_id=$1 order by sort, id', [i.project_id]),
    q(`select ${ISSUE_COLS} from issues i left join project_statuses ps on ps.id=i.status_id where i.parent_id=$1 order by i.rank, i.id`, [i.id]),
    q('select * from issue_comments where issue_id=$1 order by created_at', [i.id]),
    q('select * from issue_activities where issue_id=$1 order by created_at, id', [i.id]),
    q(`select l.id,l.kind,'out' as dir,i2.key,i2.title,i2.type,ps.kind as status_kind,ps.name as status_name from issue_links l join issues i2 on i2.id=l.to_issue_id left join project_statuses ps on ps.id=i2.status_id where l.from_issue_id=$1`, [i.id]),
    q(`select l.id,l.kind,'in' as dir,i2.key,i2.title,i2.type,ps.kind as status_kind,ps.name as status_name from issue_links l join issues i2 on i2.id=l.from_issue_id left join project_statuses ps on ps.id=i2.status_id where l.to_issue_id=$1`, [i.id]),
    q(`select t.id,t.number,t.subject,s.name as status_name,s.kind as status_kind from ticket_issue_links l join tickets t on t.id=l.ticket_id left join statuses s on s.id=t.status_id where ${ticketVis('t')} and l.issue_id=$1`, [i.id]),
    q('select id,filename,content_type,size,created_at,uploaded_by from attachments where issue_id=$1 order by id', [i.id]),
    q('select * from time_entries where issue_id=$1 order by spent_on desc, id desc', [i.id]),
    i.parent_id ? one('select id,key,title,type from issues where id=$1', [i.parent_id]) : null,
  ]);
  const status = statuses.find((s) => s.id === i.status_id);
  return {
    issue: { ...i, status_kind: status?.kind, status_name: status?.name }, project, statuses, children, comments, activities,
    links: [...linksOut, ...linksIn], tickets, attachments, time, timeTotal: time.reduce((a, x) => a + x.minutes, 0), parent,
  };
}

const ISSUE_INT = ['status_id', 'priority', 'assignee_id', 'parent_id', 'sprint_id', 'estimate_minutes', 'progress'];

async function updateIssue(i, b, user, req = null) {
  const changes = {};
  for (const k of ISSUE_INT) {
    if (b[k] === undefined) continue;
    const v = b[k] === null || b[k] === '' ? null : int(b[k]);
    if (v !== i[k]) changes[k] = v;
  }
  if (b.title !== undefined) {
    const t = String(b.title).trim().slice(0, 300);
    if (!t) throw bad('El título es obligatorio');
    if (t !== i.title) changes.title = t;
  }
  if (b.description_html !== undefined) {
    const clean = sanitizeHtml(String(b.description_html || '').slice(0, 500000));
    if (clean !== i.description_html) changes.description_html = clean;
  }
  if (b.type !== undefined && TYPES.includes(b.type) && b.type !== i.type) changes.type = b.type;
  if (b.story_points !== undefined) {
    const v = b.story_points === null || b.story_points === '' ? null : Number(b.story_points);
    if (v !== (i.story_points === null ? null : Number(i.story_points))) changes.story_points = v;
  }
  if (Array.isArray(b.labels)) changes.labels = [...new Set(b.labels.map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  for (const d of ['start_date', 'due_date']) if (b[d] !== undefined) changes[d] = isoDate(b[d]);
  if (!Object.keys(changes).length) return i;
  // Solo si cambió alguna fecha (los datos viejos con fechas cruzadas no traban otras ediciones)
  if (changes.start_date !== undefined || changes.due_date !== undefined) {
    const s0 = changes.start_date !== undefined ? changes.start_date : isoDate(i.start_date);
    const e0 = changes.due_date !== undefined ? changes.due_date : isoDate(i.due_date);
    if (s0 && e0 && e0 < s0) throw bad(`La fecha de fin (${dmy(e0)}) no puede ser anterior a la de inicio (${dmy(s0)})`);
  }

  const type = changes.type || i.type;
  if (changes.parent_id !== undefined || changes.type) {
    const pid = changes.parent_id !== undefined ? changes.parent_id : i.parent_id;
    if (pid === i.id) throw bad('Una tarea no puede ser su propio padre');
    changes.parent_id = await validateParent(i.project_id, type, pid);
  }
  if (type === 'epic') changes.sprint_id = null;
  let finished = false;
  if (changes.status_id) {
    const s = await one('select kind from project_statuses where id=$1 and project_id=$2', [changes.status_id, i.project_id]);
    if (!s) throw bad('Estado inválido para este proyecto');
    changes.resolved_at = s.kind === 'done' ? new Date().toISOString() : null;
    // Estado actual con la fila bloqueada: si dos pedidos la finalizan a la vez (doble clic, dos personas), solo el primero la "termina"
    const cur = await one('select ps.kind from issues x left join project_statuses ps on ps.id=x.status_id where x.id=$1 for update of x', [i.id]);
    finished = s.kind === 'done' && cur?.kind !== 'done';
  }
  if (changes.sprint_id) {
    const sp = await one('select id from sprints where id=$1 and project_id=$2', [changes.sprint_id, i.project_id]);
    if (!sp) throw bad('Sprint inválido');
  }
  const keys = Object.keys(changes);
  await q(`update issues set ${keys.map((k, idx) => `${k}=$${idx + 2}`).join(', ')}, updated_at=now() where id=$1`, [i.id, ...keys.map((k) => changes[k])]);
  if (changes.sprint_id !== undefined && i.type !== 'subtask') {
    await q('update issues set sprint_id=$2 where parent_id=$1 and type=$3', [i.id, changes.sprint_id, 'subtask']);
  }
  const diff = {};
  for (const k of keys) if (k !== 'resolved_at' && k !== 'description_html') diff[k] = { from: i[k] ?? null, to: changes[k] };
  if (changes.description_html !== undefined) diff.description = true;
  await logIssue(i.id, user.id, 'updated', diff);
  await touchProject(i.project_id);
  if (changes.assignee_id) await notify([changes.assignee_id], `Te asignaron ${i.key}`, changes.title || i.title, `#/issue/${i.key}`, user.id);
  if (changes.status_id) {
    const s = await one('select name from project_statuses where id=$1', [changes.status_id]);
    await notify([i.assignee_id, i.reporter_id], `${i.key} pasó a ${s.name}`, i.title, `#/issue/${i.key}`, user.id);
  }
  if (changes.status_id || changes.parent_id !== undefined || changes.type) await runDevRules(i.project_id, user, req);
  if (finished) await runIssueDoneRules(i, user, req);
  return one('select * from issues where id=$1', [i.id]);
}

const DEFAULT_WORKFLOWS = {
  scrum: [['Por hacer', 'todo'], ['En curso', 'doing'], ['En revisión', 'doing'], ['Hecho', 'done']],
  kanban: [['Pendiente', 'todo'], ['En curso', 'doing'], ['Hecho', 'done']],
  dev: [['Backlog', 'todo'], ['Análisis', 'doing'], ['Desarrollo', 'doing'], ['Testing', 'doing'], ['Producción', 'done']],
  simple: [['Pendiente', 'todo'], ['En curso', 'doing'], ['Hecho', 'done']],
};
export const WORKFLOWS = Object.keys(DEFAULT_WORKFLOWS);
export const PORTFOLIO_STATUSES = ['planned', 'active', 'paused', 'done', 'cancelled'];

/** Fecha AAAA-MM-DD válida o null (evita errores de casteo en la base). */
function isoDate(d) {
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    // Una columna date llega como medianoche UTC (PGlite) o medianoche local (driver pg): se lee en la que corresponda
    if (!d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds()) return d.toISOString().slice(0, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(d || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}
const dmy = (s) => s.split('-').reverse().join('/');
function sprintDates(start, end) {
  if (start && end && end < start) throw bad(`El sprint no puede terminar (${dmy(end)}) antes de empezar (${dmy(start)})`);
}

/**
 * Fechas de las etapas: ninguna puede terminar antes de empezar, ni una etapa posterior terminar
 * antes de que empiece una anterior. Devuelve el primer problema (texto) o null.
 */
export function phaseDateProblem(phases) {
  const list = phases.map((f) => ({ name: String(f.name || f.title || '').trim(), s: isoDate(f.start_date), e: isoDate(f.due_date) }));
  for (const f of list) if (f.s && f.e && f.e < f.s) return `La etapa "${f.name}" termina (${dmy(f.e)}) antes de empezar (${dmy(f.s)})`;
  for (let j = 1; j < list.length; j++) {
    if (!list[j].e) continue;
    for (let i = 0; i < j; i++) {
      if (list[i].s && list[j].e < list[i].s) return `La etapa "${list[j].name}" termina (${dmy(list[j].e)}) antes de que empiece "${list[i].name}" (${dmy(list[i].s)})`;
    }
  }
  return null;
}

/**
 * Si se indicó cuándo empieza la primera fase y cuándo termina la última, reparte el período
 * en partes iguales entre las fases que no tienen fechas (respeta las que se cargaron a mano).
 */
export function spreadPhaseDates(phases, { start: pStart = null, end: pEnd = null } = {}) {
  if (!phases.length) return phases;
  if (pStart && !phases[0].start_date) phases[0].start_date = pStart;
  if (pEnd && !phases[phases.length - 1].due_date) phases[phases.length - 1].due_date = pEnd;
  const iso = (d) => d.toISOString().slice(0, 10);
  const start = phases[0]?.start_date ? new Date(`${phases[0].start_date}T12:00:00Z`) : null;
  const end = phases[phases.length - 1]?.due_date ? new Date(`${phases[phases.length - 1].due_date}T12:00:00Z`) : null;
  if (!start || !end || end <= start) return phases;
  const day = 86400000;
  const span = Math.round((end - start) / day) + 1;
  const n = phases.length;
  phases.forEach((f, i) => {
    const s = new Date(start.getTime() + Math.floor((span * i) / n) * day);
    const e = new Date(start.getTime() + (Math.floor((span * (i + 1)) / n) - 1) * day);
    if (!f.start_date) f.start_date = iso(s);
    if (!f.due_date) f.due_date = iso(e < s ? s : e);
  });
  return phases;
}

/** Tipo de proyecto (el indicado, o el predeterminado). */
export async function projectType(typeId) {
  if (typeId) {
    const t = await one('select * from project_types where id=$1', [typeId]);
    if (!t) throw bad('El tipo de proyecto no existe');
    return t;
  }
  return one('select * from project_types where active order by is_default desc, sort, id limit 1');
}

/** Valida que las referencias del portfolio existan y sean del tipo correcto. */
export async function checkProjectRefs(b) {
  const chk = async (id, sql, msg) => { if (id && !(await one(sql, [id]))) throw bad(msg); };
  await chk(b.type_id, 'select 1 as x from project_types where id=$1', 'El tipo de proyecto no existe');
  await chk(b.origin_id, `select 1 as x from portfolio_options where id=$1 and kind='origin'`, 'El origen no existe');
  await chk(b.sector_id, `select 1 as x from portfolio_options where id=$1 and kind='sector'`, 'El sector no existe');
  await chk(b.area_id, 'select 1 as x from categories where id=$1', 'El área no existe');
  await chk(b.lead_id, 'select 1 as x from users where id=$1', 'El responsable no existe');
  const ids = [...new Set([...(b.member_ids || []), ...(b.phases || []).map((f) => f?.assignee_id).filter(Boolean)].map(Number))];
  if (ids.length) {
    const found = await one('select count(*)::int as n from users where id = any($1::int[])', [ids]);
    if (found.n !== ids.length) throw bad('Algún integrante o responsable de etapa no existe');
  }
}

/** Marca el proyecto como modificado (la API lo usa para sincronizar solo lo que cambió). */
export async function touchProject(projectId) {
  if (projectId) await q('update projects set updated_at=now() where id=$1', [projectId]);
}

/**
 * Crea un proyecto con el flujo y las etapas de su tipo.
 * body.phases (opcional): [{ name, start_date, due_date, assignee_id }]; si no viene, se usan las del tipo.
 * Las etapas son épicas: tienen fechas, responsable y avance, y alimentan el roadmap y el portfolio.
 */
/**
 * strict (al convertir un ticket): cada etapa con inicio y fin (después de repartir las del proyecto), origen y sector IT
 * obligatorios; las fechas del proyecto salen de las etapas y, si no vinieron horas, se calculan con los días hábiles.
 */
/**
 * Cambio de responsable (v1.13.4): el nuevo pasa a estar en el equipo y el anterior sale, salvo que todavía tenga tareas
 * abiertas asignadas en el proyecto (sigue trabajando ahí). Antes quedaba en el equipo para siempre y el filtro por
 * persona lo mostraba en proyectos que ya no eran suyos.
 */
export async function handOverLead(projectId, oldLead, newLead) {
  if (newLead) await q('insert into project_members(project_id,user_id) values ($1,$2) on conflict do nothing', [projectId, newLead]);
  if (oldLead && oldLead !== newLead) {
    await q(`delete from project_members m where m.project_id=$1 and m.user_id=$2 and not exists (
        select 1 from issues i left join project_statuses ps on ps.id=i.status_id
        where i.project_id=$1 and i.assignee_id=$2 and coalesce(ps.kind,'todo')<>'done')`, [projectId, oldLead]);
  }
}

export async function createProject(body, u, { firstPhaseHtml = '', skipMemberLead = false, strict = null } = {}) {
  const key = String(body.key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw bad('La clave debe tener de 2 a 10 letras o números y empezar con letra (ej. CRM)');
  if (!String(body.name || '').trim()) throw bad('El nombre es obligatorio');
  const exists = await one('select id from projects where key=$1', [key]);
  if (exists) throw bad(`Ya existe un proyecto con la clave ${key}`);
  await checkProjectRefs(body);
  const type = await projectType(body.type_id || null).catch((e) => { if (body.type_id) throw e; return null; });
  const lead = body.lead_id === undefined ? u.id : body.lead_id || (skipMemberLead ? null : u.id);
  let start = isoDate(body.start_date);
  let end = isoDate(body.end_date);
  if (start && end && end < start) throw bad('La fecha de fin no puede ser anterior al inicio');
  // Etapas: las elegidas o, si se indicó el tipo, las de su plantilla (sin tipo ni etapas, el proyecto arranca vacío, como antes)
  const source = Array.isArray(body.phases) ? body.phases : body.type_id && Array.isArray(type?.phases) ? type.phases.map((name) => ({ name })) : [];
  const phases = source.map((f) => (typeof f === 'string' ? { name: f } : { ...f })).filter((f) => String(f.name || '').trim()).slice(0, 20);
  const before = phaseDateProblem(phases);
  if (before) throw bad(before);
  if (strict) {
    if (!body.origin_id) throw bad('Elegí el origen del proyecto');
    if (!body.sector_id) throw bad('Elegí el sector IT');
    if (!phases.length) throw bad('Definí al menos una etapa');
    // Obligatorias: el inicio de la primera etapa y el fin de la última; las del medio se reparten solas
    if (!isoDate(phases[0].start_date)) throw bad(`Cargá la fecha de inicio de la primera etapa ("${String(phases[0].name).trim()}")`);
    if (!isoDate(phases[phases.length - 1].due_date)) throw bad(`Cargá la fecha de fin de la última etapa ("${String(phases[phases.length - 1].name).trim()}")`);
  }
  spreadPhaseDates(phases, { start, end });
  const after = phaseDateProblem(phases);
  if (after) throw bad(`${after}. Revisá las fechas de inicio y fin del proyecto`);
  let hours = body.estimated_hours ?? null;
  if (strict) {
    start = phases.map((f) => isoDate(f.start_date)).filter(Boolean).sort()[0];
    end = phases.map((f) => isoDate(f.due_date)).filter(Boolean).sort().pop();
    if (hours === null || hours === undefined) hours = estimateHours(start, end, strict);
  }
  const p = await one(`insert into projects(key,name,description,lead_id,color,type_id,origin_id,sector_id,area_id,priority,start_date,end_date,estimated_hours,portfolio_status,recurring)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`, [
    key, String(body.name).trim().slice(0, 120), String(body.description || '').slice(0, 4000), lead, body.color || type?.color || '#C41230',
    type?.id || null, body.origin_id || null, body.sector_id || null, body.area_id || null, [1, 2, 3, 4].includes(Number(body.priority)) ? Number(body.priority) : 2,
    start, end, hours, PORTFOLIO_STATUSES.includes(body.portfolio_status) ? body.portfolio_status : 'active', Boolean(body.recurring),
  ]);
  const wf = DEFAULT_WORKFLOWS[body.template] || DEFAULT_WORKFLOWS[type?.workflow] || DEFAULT_WORKFLOWS.scrum;
  // Un INSERT por tabla (sin N+1)
  await q(`insert into project_statuses(project_id,name,kind,sort) select $1, n, k, ord - 1 from unnest($2::text[], $3::text[]) with ordinality as x(n, k, ord)`,
    [p.id, wf.map((x) => x[0]), wf.map((x) => x[1])]);
  // Equipo = el responsable + los que se eligieron. Quien carga el proyecto NO se suma solo (v1.13.4): si lo carga para
  // otro, no tiene por qué aparecer en "Persona: …" ni en "Mis proyectos" (si no elige responsable, lo es él).
  const members = [...new Set([...(lead ? [Number(lead)] : []), ...(body.member_ids || []).map(Number)])].filter(Number.isInteger);
  if (members.length) await q('insert into project_members(project_id,user_id) select $1, unnest($2::int[]) on conflict do nothing', [p.id, members]);
  for (const [i, f] of phases.entries()) {
    await createIssue({
      project_id: p.id, type: 'epic', title: String(f.name).trim().slice(0, 200), start_date: f.start_date || null, due_date: f.due_date || null,
      assignee_id: f.assignee_id || lead || null, description_html: i === 0 ? firstPhaseHtml : '', skipRules: true,
    }, u);
  }
  return p;
}

/**
 * Resumen de fases de un proyecto (las épicas, en orden) para mostrar en el ticket y en el portal.
 * Estado de cada fase: hecha, en curso o pendiente, según la épica y sus tareas.
 */
export async function projectSummary(projectId) {
  const p = await one('select id,key,name,color,lead_id,archived from projects where id=$1', [projectId]);
  if (!p) return null;
  const [phases, totals, sprint] = await Promise.all([
    q(`select i.id,i.key,i.title,i.start_date,i.due_date,ps.kind as status_kind,ps.name as status_name,
         (select count(*)::int from issues c where c.parent_id=i.id) as child_count,
         (select count(*)::int from issues c join project_statuses cs on cs.id=c.status_id where c.parent_id=i.id and cs.kind='done') as child_done,
         (select count(*)::int from issues c join project_statuses cs on cs.id=c.status_id where c.parent_id=i.id and cs.kind='doing') as child_doing
       from issues i left join project_statuses ps on ps.id=i.status_id where i.project_id=$1 and i.type='epic' order by i.rank, i.id`, [projectId]),
    one(`select count(*)::int as total, count(*) filter (where ps.kind='done')::int as done from issues i left join project_statuses ps on ps.id=i.status_id
         where i.project_id=$1 and i.type<>'epic'`, [projectId]),
    one(`select name,end_date from sprints where project_id=$1 and state='active' limit 1`, [projectId]),
  ]);
  for (const f of phases) {
    if (f.status_kind === 'done') { f.state = 'done'; f.pct = 100; continue; }
    f.pct = f.child_count ? Math.round((f.child_done / f.child_count) * 100) : 0;
    if (f.child_count && f.child_done === f.child_count) f.state = 'done';
    else if (f.status_kind === 'doing' || f.child_done > 0 || f.child_doing > 0) f.state = 'active';
    else f.state = 'pending';
  }
  const current = phases.find((f) => f.state !== 'done') || null;
  const progress = phases.length ? Math.round(phases.reduce((a, f) => a + f.pct, 0) / phases.length) : totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
  const lastDue = phases.map((f) => f.due_date).filter(Boolean).sort((x, y) => new Date(x) - new Date(y)).pop() || null;
  return {
    ...p, phases, progress, finished: phases.length > 0 && !current, current: current ? { key: current.key, title: current.title, pct: current.pct } : null,
    issues: totals, active_sprint: sprint?.name || null, due_date: lastDue,
  };
}

/** Aplica las reglas de negocio ticket ↔ proyecto (lib/dev-rules.js) tras un cambio en el proyecto. */
export async function runDevRules(projectId, user, req) {
  const linked = await one('select 1 as x from ticket_projects where project_id=$1 limit 1', [projectId]);
  if (!linked) return;
  const [{ evaluateDevRules }, { updateTicket }] = await Promise.all([import('../dev-rules.js'), import('./tickets.js')]);
  await evaluateDevRules(projectId, user, req, { projectSummary, updateTicket });
}

/** Cierre de ciclo ticket ↔ tarea (lib/dev-rules.js): la tarea pasó a Finalizado. */
export async function runIssueDoneRules(issue, user, req) {
  const linked = await one('select 1 as x from ticket_issue_links where issue_id=$1 limit 1', [issue.id]);
  if (!linked) return [];
  const [{ onIssueDone }, { updateTicket }] = await Promise.all([import('../dev-rules.js'), import('./tickets.js')]);
  // Si la regla falla, no tiene que frenar el cambio de estado de la tarea: corre en un savepoint
  const inTx = Boolean(ctx().tx);
  if (inTx) await q('savepoint issue_done_rules');
  try {
    const r = await onIssueDone(issue, user, req, { updateTicket });
    if (inTx) await q('release savepoint issue_done_rules');
    return r;
  } catch (e) {
    if (!inTx) throw e;
    await q('rollback to savepoint issue_done_rules');
    logError('falló el cierre de ciclo ticket ↔ tarea', { error: e, issue: issue.key });
    return [];
  }
}

export function projectRoutes(router) {
  // Todas las rutas que escriben corren en una transacción (lo externo, como correos, sale después del commit).
  const r = txRouter(router);
  const optId = () => v.id({ optional: true, nullable: true });
  const issueFields = {
    type: v.enum(TYPES, { optional: true }), title: v.string({ min: 1, max: 300, optional: true }), description_html: v.html({ max: 500000, optional: true }),
    status_id: optId(), priority: v.int({ min: 1, max: 4, optional: true }), assignee_id: optId(), parent_id: optId(), sprint_id: optId(),
    story_points: v.number({ min: 0, max: 1000, optional: true, nullable: true }), estimate_minutes: v.int({ min: 0, max: 100000, optional: true, nullable: true }),
    labels: v.list(v.string({ max: 60 }), { max: 20, optional: true }), start_date: v.date({ optional: true, nullable: true }), due_date: v.date({ optional: true, nullable: true }),
    progress: v.int({ min: 0, max: 100, optional: true, nullable: true }),
  };
  const issueSchema = v.object(issueFields);
  // Campos del portfolio (comunes al alta y a la edición)
  const portfolioFields = {
    type_id: optId(), origin_id: optId(), sector_id: optId(), area_id: optId(),
    priority: v.int({ min: 1, max: 4, optional: true }),
    start_date: v.date({ optional: true, nullable: true }), end_date: v.date({ optional: true, nullable: true }),
    estimated_hours: v.number({ min: 0, max: 1000000, optional: true, nullable: true }),
    extra_hours: v.number({ min: 0, max: 1000000, optional: true, nullable: true }),
    progress_override: v.int({ min: 0, max: 100, optional: true, nullable: true }),
    portfolio_status: v.enum(PORTFOLIO_STATUSES, { optional: true }), recurring: v.bool({ optional: true }),
  };
  const phaseSchema = v.object({
    name: v.string({ min: 1, max: 200 }), start_date: v.date({ optional: true, nullable: true }), due_date: v.date({ optional: true, nullable: true }), assignee_id: optId(),
  });
  const projectSchema = v.object({
    key: v.string({ min: 2, max: 10, pattern: /^[A-Za-z][A-Za-z0-9]{1,9}$/ }), name: v.string({ min: 1, max: 120 }),
    description: v.string({ max: 4000, multiline: true, optional: true }), lead_id: optId(), color: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
    template: v.enum(WORKFLOWS, { optional: true }), member_ids: v.array(v.id(), { max: 200, optional: true }),
    phases: v.array(phaseSchema, { max: 20, optional: true }),
    ...portfolioFields,
  });

  r.get('/projects', async ({ req }) => {
    const u = await requireUser(req);
    const rows = await q(`select p.*,
        (select count(*)::int from issues i left join project_statuses ps on ps.id=i.status_id where i.project_id=p.id and coalesce(ps.kind,'todo')<>'done' and i.type<>'epic') as open_issues,
        (select count(*)::int from issues i where i.project_id=p.id and i.type<>'epic') as total_issues,
        (select count(*)::int from issues i left join project_statuses ps on ps.id=i.status_id where i.project_id=p.id and ps.kind='done' and i.type<>'epic') as done_issues,
        (select name from sprints s where s.project_id=p.id and s.state='active' order by s.start_date limit 1) as active_sprint,
        (select coalesce(array_agg(user_id), '{}') from project_members m where m.project_id=p.id) as member_ids,
        (select coalesce(array_agg(distinct i.assignee_id), '{}') from issues i where i.project_id=p.id and i.assignee_id is not null and i.type<>'epic') as assignee_ids
      from projects p order by p.archived, p.name`);
    // Avance (v1.13.6): el mismo del portfolio (etapas, tareas, avance manual; finalizado = 100 %). Antes se contaban
    // solo las tareas sueltas: un proyecto armado por etapas, o finalizado, figuraba con 0 %.
    const prog = new Map((await portfolioRows()).map((x) => [x.id, x.progress]));
    for (const p of rows) p.progress = prog.get(p.id) ?? 0;
    return canPortfolio(u) || isManager(u) ? rows : rows.map(hidePortfolio);
  });

  r.post('/projects', async ({ req, body: raw }) => {
    const u = await requireUser(req);
    return createProject(parse(projectSchema, raw), u);
  }, { idempotent: true });

  r.get('/projects/:key', async ({ req, params }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    const [statuses, members, sprints, epics, labels] = await Promise.all([
      q('select * from project_statuses where project_id=$1 order by sort, id', [p.id]),
      q('select user_id from project_members where project_id=$1', [p.id]),
      q(`select s.*,
           (select count(*)::int from issues i where i.sprint_id=s.id and i.type<>'subtask') as issue_count,
           (select coalesce(sum(i.story_points),0) from issues i where i.sprint_id=s.id and i.type<>'subtask') as points
         from sprints s where s.project_id=$1 order by case s.state when 'active' then 0 when 'planned' then 1 else 2 end, s.sort, s.id`, [p.id]),
      q(`select i.id,i.key,i.title,i.start_date,i.due_date,i.status_id,ps.kind as status_kind,
           (select count(*)::int from issues c where c.parent_id=i.id) as child_count,
           (select count(*)::int from issues c join project_statuses cs on cs.id=c.status_id where c.parent_id=i.id and cs.kind='done') as child_done
         from issues i left join project_statuses ps on ps.id=i.status_id where i.project_id=$1 and i.type='epic' order by i.rank, i.id`, [p.id]),
      q(`select distinct unnest(labels) as l from issues where project_id=$1 order by 1`, [p.id]),
    ]);
    const [tickets, type, portfolio] = await Promise.all([
      q(`select t.number,t.subject,s.name as status_name from ticket_projects tp join tickets t on t.id=tp.ticket_id left join statuses s on s.id=t.status_id where ${ticketVis('t')} and tp.project_id=$1 order by t.number`, [p.id]),
      p.type_id ? one('select * from project_types where id=$1', [p.type_id]) : null,
      portfolioRows({ ids: [p.id] }).then((x) => x[0]),
    ]);
    const full = canPortfolio(u) || canAdmin(u, p);
    const pf = full || !portfolio ? portfolio : {
      phases: portfolio.phases, progress: portfolio.progress, progress_source: portfolio.progress_source, progress_auto: portfolio.progress_auto,
      status_label: portfolio.status_label, start: portfolio.start, end: portfolio.end, recurring: portfolio.recurring, health: portfolio.health, current_phase: portfolio.current_phase,
    };
    return { project: full ? p : hidePortfolio(p), can_configure: canAdmin(u, p), type, portfolio: pf, statuses, members: members.map((m) => m.user_id), sprints, epics, labels: labels.map((x) => x.l), tickets };
  });

  r.patch('/projects/:key', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    if (!canAdmin(u, p) && !canPortfolio(u)) throw forbidden('Solo el líder del proyecto, un supervisor o quien gestiona el portfolio puede modificarlo');
    const b = parse(v.object({
      name: v.string({ min: 1, max: 120, optional: true }), description: v.string({ max: 4000, multiline: true, optional: true }),
      lead_id: v.id({ optional: true, nullable: true }), color: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }), archived: v.bool({ optional: true }),
      ...portfolioFields,
    }), body);
    // Quien solo gestiona el portfolio no puede cambiar el líder ni archivar: eso daría permisos sobre el proyecto (miembros, flujo, borrado)
    if (!canAdmin(u, p)) {
      if (b.lead_id !== undefined && b.lead_id !== p.lead_id) throw forbidden('Solo el líder del proyecto o un supervisor puede cambiar el responsable');
      if (b.archived !== undefined && b.archived !== p.archived) throw forbidden('Solo el líder del proyecto o un supervisor puede archivarlo');
      delete b.lead_id;
      delete b.archived;
    }
    await checkProjectRefs(b);
    // Columnas fijas del código; solo se actualizan las que vinieron
    const COLS = ['name', 'description', 'lead_id', 'color', 'archived', 'type_id', 'origin_id', 'sector_id', 'area_id', 'priority', 'start_date', 'end_date',
      'estimated_hours', 'extra_hours', 'progress_override', 'portfolio_status', 'recurring'];
    const use = COLS.filter((c) => b[c] !== undefined);
    if (b.extra_hours === null) b.extra_hours = 0;
    const start = b.start_date !== undefined ? b.start_date : p.start_date && String(p.start_date instanceof Date ? p.start_date.toISOString() : p.start_date).slice(0, 10);
    const end = b.end_date !== undefined ? b.end_date : p.end_date && String(p.end_date instanceof Date ? p.end_date.toISOString() : p.end_date).slice(0, 10);
    if (start && end && end < start) throw bad('La fecha de fin no puede ser anterior al inicio');
    if (!use.length) return p;
    const row = await one(`update projects set ${use.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() where id=$1 returning *`, [p.id, ...use.map((c) => b[c])]);
    if (b.portfolio_status && b.portfolio_status !== p.portfolio_status) await audit(req, u, 'project_status', { key: p.key, from: p.portfolio_status, to: b.portfolio_status });
    if (b.lead_id !== undefined && b.lead_id !== p.lead_id) await handOverLead(p.id, p.lead_id, b.lead_id);
    return row;
  });

  r.del('/projects/:key', async ({ req, params }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    if (!(isAdminRole(u) || p.lead_id === u.id)) throw forbidden('Solo un administrador o el líder puede eliminar el proyecto');
    await q('delete from projects where id=$1', [p.id]);
    await audit(req, u, 'project_deleted', { key: p.key, name: p.name });
    return { ok: true };
  });

  r.put('/projects/:key/members', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    if (!canAdmin(u, p)) throw forbidden();
    const ids = parse(v.object({ user_ids: v.array(v.id(), { max: 500, default: () => [] }) }), body).user_ids;
    await q('delete from project_members where project_id=$1', [p.id]);
    if (ids.length) await q('insert into project_members(project_id,user_id) select $1, unnest($2::int[]) on conflict do nothing', [p.id, ids]);
    // Proyecto sin responsable (ej. importado de una planilla con alguien que no es agente) y un único miembro: ese miembro
    // pasa a ser el responsable, que es el que se ve como Líder en la lista y como Responsable en el portfolio.
    let lead = null;
    if (!p.lead_id && ids.length === 1) {
      lead = (await one('update projects set lead_id=$2, updated_at=now() where id=$1 and lead_id is null returning lead_id', [p.id, ids[0]]))?.lead_id || null;
    } else await touchProject(p.id);
    return { ok: true, lead_id: lead };
  });

  r.put('/projects/:key/statuses', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    if (!canAdmin(u, p)) throw forbidden();
    const list = parse(v.object({ statuses: v.array(v.object({
      id: optId(), name: v.string({ min: 1, max: 60 }), kind: v.enum(['todo', 'doing', 'done']), wip_limit: v.int({ min: 0, max: 999, optional: true, nullable: true }),
    }), { max: 30 }) }), body).statuses;
    if (!list.length) throw bad('El flujo necesita al menos un estado');
    if (!list.some((s) => s.kind === 'done')) throw bad('El flujo necesita al menos un estado de tipo "Hecho"');
    // Solo se aceptan ids de estados de ESTE proyecto
    const own = new Set((await q('select id from project_statuses where project_id=$1', [p.id])).map((x) => x.id));
    const foreign = list.filter((s) => s.id && !own.has(s.id));
    if (foreign.length) throw bad('Hay estados que no pertenecen a este proyecto');
    const keep = [];
    for (const [i, s] of list.entries()) {
      const wip = s.wip_limit || null;
      if (s.id) {
        await q('update project_statuses set name=$3,kind=$4,sort=$5,wip_limit=$6 where id=$1 and project_id=$2', [s.id, p.id, s.name, s.kind, i, wip]);
        keep.push(s.id);
      } else {
        const n = await one('insert into project_statuses(project_id,name,kind,sort,wip_limit) values ($1,$2,$3,$4,$5) returning id', [p.id, s.name, s.kind, i, wip]);
        keep.push(n.id);
      }
    }
    const fallback = keep[0];
    await q('update issues set status_id=$2 where project_id=$1 and (status_id is null or not (status_id = any($3::int[])))', [p.id, fallback, keep]);
    await q('delete from project_statuses where project_id=$1 and not (id = any($2::int[]))', [p.id, keep]);
    return q('select * from project_statuses where project_id=$1 order by sort, id', [p.id]);
  });

  // ---------- Issues ----------
  r.get('/projects/:key/issues', async ({ req, params, query }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    const w = new Where([p.id]);
    w.add('i.project_id=$1');
    if (query.sprint === 'backlog') w.add('i.sprint_id is null');
    else if (query.sprint === 'active') w.add(`i.sprint_id in (select id from sprints where project_id=$1 and state='active')`);
    else if (query.sprint === 'open') w.add(`(i.sprint_id is null or i.sprint_id in (select id from sprints where project_id=$1 and state<>'closed'))`);
    else if (query.sprint) w.add(`i.sprint_id=${w.p(int(query.sprint))}`);
    const types = (x) => String(x).split(',').filter((t) => TYPES.includes(t));
    if (query.type) w.add(`i.type = any(${w.p(types(query.type))}::text[])`);
    if (query.exclude_type) w.add(`not (i.type = any(${w.p(types(query.exclude_type))}::text[]))`);
    if (query.assignee) {
      const a = String(query.assignee).split(',');
      const nums = a.map((x) => (x === 'me' ? u.id : Number(x))).filter(Number.isFinite);
      const parts = [];
      if (a.includes('none')) parts.push('i.assignee_id is null');
      if (nums.length) parts.push(`i.assignee_id = any(${w.p(nums)}::int[])`);
      w.add(`(${parts.join(' or ')})`);
    }
    if (query.epic) w.add(`(i.parent_id=${w.p(int(query.epic))} or i.parent_id in (select id from issues where parent_id=${w.p(int(query.epic))}))`);
    if (query.label) w.add(`i.labels @> array[${w.p(String(query.label).slice(0, 60))}]::text[]`);
    if (query.status) w.add(`i.status_id = any(${w.p(String(query.status).split(',').map(Number).filter(Number.isInteger).slice(0, 50))}::int[])`);
    if (query.done === '0') w.add(`coalesce(ps.kind,'todo')<>'done'`);
    if (query.q) {
      const t = w.p(likeTerm(query.q));
      w.add(`(i.title ilike ${t} or i.key ilike ${t})`);
    }
    return q(`select ${ISSUE_COLS},
        (select count(*)::int from issues c where c.parent_id=i.id) as child_count,
        (select count(*)::int from issues c join project_statuses cs on cs.id=c.status_id where c.parent_id=i.id and cs.kind='done') as child_done,
        (select count(*)::int from issue_comments cm where cm.issue_id=i.id) as comment_count
      from issues i left join project_statuses ps on ps.id=i.status_id ${w} order by i.rank, i.id limit 2000`, w.params);
  });

  r.post('/projects/:key/issues', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const p = await projectByKey(params.key);
    return createIssue({ ...parse(issueSchema, body), project_id: p.id }, u, req);
  }, { idempotent: true });

  r.get('/issues/search', async ({ req, query }) => {
    await requireUser(req);
    const t = likeTerm(query.q || '', 100);
    return q(`select i.id,i.key,i.title,i.type,p.name as project_name from issues i join projects p on p.id=i.project_id
      where (i.key ilike $1 or i.title ilike $1) order by i.updated_at desc limit 20`, [t]);
  });

  r.get('/issues/:key', async ({ req, params }) => {
    await requireUser(req);
    return issueDetail(await issueByKey(params.key));
  });

  r.patch('/issues/:key', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const i = await issueByKey(params.key);
    await updateIssue(i, parse(issueSchema, body), u, req);
    return issueDetail(await issueByKey(params.key));
  });

  r.del('/issues/:key', async ({ req, params }) => {
    const u = await requireUser(req);
    const i = await issueByKey(params.key);
    const p = await one('select * from projects where id=$1', [i.project_id]);
    if (!(canAdmin(u, p) || i.reporter_id === u.id)) throw forbidden('Solo quien la creó, el líder o un supervisor puede eliminarla');
    await q(`delete from issues where parent_id=$1 and type='subtask'`, [i.id]);
    await q('delete from issues where id=$1', [i.id]);
    await touchProject(i.project_id);
    await runDevRules(i.project_id, u, req);
    return { ok: true };
  });

  /** Mueve una issue (tablero o backlog) y reescribe el orden del contenedor destino. */
  r.post('/issues/reorder', async ({ req, body: raw }) => {
    let body = raw;
    const u = await requireUser(req);
    body = parse(v.object({
      moved_id: v.id(), status_id: optId(), sprint_id: v.any({ optional: true }), order: v.array(v.id(), { max: 2000, default: () => [] }),
    }), body);
    if (body.sprint_id !== undefined && body.sprint_id !== null && body.sprint_id !== 'backlog' && !/^\d{1,9}$/.test(String(body.sprint_id))) throw bad('Sprint inválido');
    const moved = await one('select * from issues where id=$1', [body.moved_id]);
    if (!moved) throw notFound('No existe la tarea');
    const patch = {};
    if (body.status_id !== undefined && body.status_id !== null) patch.status_id = int(body.status_id);
    if (body.sprint_id !== undefined) patch.sprint_id = body.sprint_id === 'backlog' || body.sprint_id === null ? null : int(body.sprint_id);
    if (Object.keys(patch).length) await updateIssue(moved, patch, u, req);
    const order = (body.order || []).map(Number).filter(Number.isFinite);
    if (order.length) {
      const existing = await q('select id, rank from issues where id = any($1::int[]) and project_id=$2', [order, moved.project_id]);
      const ranks = existing.map((e) => Number(e.rank)).sort((a, b) => a - b);
      const base = ranks.length ? ranks[0] : 0;
      // Un solo UPDATE con el orden nuevo (antes: uno por tarea)
      await q(`update issues i set rank = $2::float8 + (x.ord - 1) * 10 from unnest($1::int[]) with ordinality as x(id, ord)
        where i.id = x.id and i.project_id = $3`, [order.slice(0, 2000), base, moved.project_id]);
    }
    return { ok: true };
  });

  r.post('/issues/:key/comments', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const i = await issueByKey(params.key);
    const b = parse(v.object({ body_html: v.html({ max: 200000, default: '' }), notify_user_ids: v.array(v.id(), { max: 50, default: () => [] }) }), body);
    const html = b.body_html.trim();
    if (!stripHtml(html)) throw bad('El comentario está vacío');
    const c = await one('insert into issue_comments(issue_id,user_id,body_html) values ($1,$2,$3) returning *', [i.id, u.id, html]);
    await q('update issues set updated_at=now() where id=$1', [i.id]);
    const mentioned = b.notify_user_ids;
    await notify([i.assignee_id, i.reporter_id, ...mentioned], `${u.name} comentó en ${i.key}`, stripHtml(html).slice(0, 200), `#/issue/${i.key}`, u.id);
    return c;
  });
  r.patch('/issue-comments/:id', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const c = await one('select * from issue_comments where id=$1', [int(params.id)]);
    if (!c) throw notFound();
    if (c.user_id !== u.id) throw forbidden('Solo podés editar tus comentarios');
    return one('update issue_comments set body_html=$2, updated_at=now() where id=$1 returning *', [c.id, parse(v.object({ body_html: v.html({ max: 200000 }) }), body).body_html]);
  });
  r.del('/issue-comments/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const c = await one('select * from issue_comments where id=$1', [int(params.id)]);
    if (!c) throw notFound();
    if (c.user_id !== u.id && !isManager(u)) throw forbidden();
    await q('delete from issue_comments where id=$1', [c.id]);
    return { ok: true };
  });

  r.post('/issues/:key/links', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const i = await issueByKey(params.key);
    const to = await issueByKey(parse(v.object({ to_key: v.string({ min: 3, max: 30, pattern: /^[A-Za-z][A-Za-z0-9]*-\d+$/ }), kind: v.enum(['blocks', 'relates', 'duplicates'], { optional: true }) }), body).to_key);
    if (to.id === i.id) throw bad('No podés vincular una tarea consigo misma');
    const kind = ['blocks', 'relates', 'duplicates'].includes(body.kind) ? body.kind : 'relates';
    void kind;
    await q('insert into issue_links(from_issue_id,to_issue_id,kind) values ($1,$2,$3) on conflict do nothing', [i.id, to.id, kind]);
    await logIssue(i.id, u.id, 'linked', { kind, key: to.key });
    return issueDetail(i);
  });
  r.del('/issue-links/:id', async ({ req, params }) => {
    await requireUser(req);
    await q('delete from issue_links where id=$1', [int(params.id)]);
    return { ok: true };
  });

  r.post('/issues/:key/attachments', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const i = await issueByKey(params.key);
    const files = parse(v.object({ attachments: v.array(v.attachment(), { max: 5, default: () => [] }) }), body).attachments;
    await saveAttachments(files, { issueId: i.id, userId: u.id });
    await logIssue(i.id, u.id, 'attachment', { count: files.length });
    return issueDetail(i);
  });
  r.get('/issue-attachments/:id', async ({ req, res, params }) => {
    await requireUser(req);
    const a = await one('select * from attachments where id=$1 and issue_id is not null', [int(params.id)]);
    if (!a) throw notFound();
    const tc = await import('../tickets-core.js');
    tc.sendAttachment(res, a, await tc.attachmentBuffer(a));
    return undefined;
  }, { raw: true });
  r.del('/issue-attachments/:id', async ({ req, params }) => {
    await requireUser(req);
    await q('delete from attachments where id=$1 and issue_id is not null', [int(params.id)]);
    return { ok: true };
  });

  r.post('/issues/:key/time', async ({ req, params, body }) => {
    const u = await requireUser(req);
    const i = await issueByKey(params.key);
    const b = parse(v.object({ minutes: v.int({ min: 1, max: 1440 }), note: v.string({ max: 500, default: '' }), spent_on: v.date({ optional: true, nullable: true }) }), body);
    const minutes = b.minutes;
    await q('insert into time_entries(issue_id,user_id,minutes,note,spent_on) values ($1,$2,$3,$4,coalesce($5::date,current_date))', [i.id, u.id, minutes, b.note, b.spent_on || null]);
    await logIssue(i.id, u.id, 'time', { minutes });
    await touchProject(i.project_id);
    return issueDetail(i);
  });

  // ---------- Sprints ----------
  const sprintSchema = v.object({
    name: v.string({ min: 1, max: 80, optional: true }), goal: v.string({ max: 1000, multiline: true, optional: true, nullable: true }),
    start_date: v.date({ optional: true, nullable: true }), end_date: v.date({ optional: true, nullable: true }),
    move_to: v.string({ max: 20, pattern: /^(new|backlog|\d{1,9})$/, optional: true }),
  });
  // Sprints: los maneja quien puede configurar el proyecto (líder, supervisores/admins o permiso "configurar proyectos")
  const sprintGuard = async (u, projectId) => {
    const p = await one('select * from projects where id=$1', [projectId]);
    if (!p || !canAdmin(u, p)) throw forbidden('Solo el líder del proyecto, un supervisor o quien puede configurar proyectos maneja los sprints');
    return p;
  };

  r.post('/projects/:key/sprints', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(sprintSchema, raw);
    const p = await projectByKey(params.key);
    await sprintGuard(u, p.id);
    const n = await one('select count(*)::int as n from sprints where project_id=$1', [p.id]);
    const name = String(body.name || `${p.key} Sprint ${n.n + 1}`).slice(0, 80);
    const sort = (await one('select coalesce(max(sort),0)+1 as s from sprints where project_id=$1', [p.id])).s;
    sprintDates(isoDate(body.start_date), isoDate(body.end_date));
    return one('insert into sprints(project_id,name,goal,start_date,end_date,sort) values ($1,$2,$3,$4,$5,$6) returning *', [p.id, name, String(body.goal || '').slice(0, 1000), isoDate(body.start_date), isoDate(body.end_date), sort]);
  });

  r.patch('/sprints/:id', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(sprintSchema, raw);
    const s = await one('select * from sprints where id=$1', [int(params.id)]);
    if (!s) throw notFound();
    await sprintGuard(u, s.project_id);
    if (body.start_date !== undefined || body.end_date !== undefined) {
      sprintDates(body.start_date === undefined ? isoDate(s.start_date) : isoDate(body.start_date), body.end_date === undefined ? isoDate(s.end_date) : isoDate(body.end_date));
    }
    return one('update sprints set name=$2,goal=$3,start_date=$4,end_date=$5 where id=$1 returning *', [
      s.id, body.name !== undefined ? String(body.name).slice(0, 80) : s.name, body.goal !== undefined ? String(body.goal).slice(0, 1000) : s.goal,
      body.start_date === undefined ? s.start_date : isoDate(body.start_date), body.end_date === undefined ? s.end_date : isoDate(body.end_date),
    ]);
  });

  r.post('/sprints/:id/start', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(sprintSchema, raw);
    const s = await one('select * from sprints where id=$1', [int(params.id)]);
    if (!s) throw notFound();
    await sprintGuard(u, s.project_id);
    if (s.state !== 'planned') throw bad('El sprint ya fue iniciado');
    const active = await one(`select id from sprints where project_id=$1 and state='active'`, [s.project_id]);
    if (active) throw bad('Ya hay un sprint activo en este proyecto. Completalo antes de iniciar otro.');
    const start = isoDate(body.start_date) || new Date().toISOString().slice(0, 10);
    const stored = isoDate(s.end_date);
    const end = isoDate(body.end_date) || (stored && stored >= start ? stored : new Date(Date.parse(`${start}T12:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10));
    sprintDates(start, end);
    const pts = await one(`select coalesce(sum(story_points),0) as p from issues where sprint_id=$1 and type<>'subtask'`, [s.id]);
    return one(`update sprints set state='active', start_date=$2, end_date=$3, goal=coalesce($4,goal), committed_points=$5 where id=$1 returning *`, [s.id, start, end, body.goal ?? null, pts.p]);
  });

  r.post('/sprints/:id/complete', async ({ req, params, body: raw }) => {
    const u = await requireUser(req);
    const body = parse(sprintSchema, raw);
    const s = await one('select * from sprints where id=$1', [int(params.id)]);
    if (!s) throw notFound();
    await sprintGuard(u, s.project_id);
    if (s.state !== 'active') throw bad('Solo se puede completar un sprint activo');
    const done = await one(`select coalesce(sum(i.story_points),0) as p, count(*)::int as n from issues i join project_statuses ps on ps.id=i.status_id where i.sprint_id=$1 and ps.kind='done' and i.type<>'subtask'`, [s.id]);
    let target = null;
    if (body.move_to === 'new') {
      const n = await one('select count(*)::int as n from sprints where project_id=$1', [s.project_id]);
      const p = await one('select key from projects where id=$1', [s.project_id]);
      target = (await one('insert into sprints(project_id,name,sort) values ($1,$2,(select coalesce(max(sort),0)+1 from sprints where project_id=$1)) returning id', [s.project_id, `${p.key} Sprint ${n.n + 1}`])).id;
    } else if (body.move_to && body.move_to !== 'backlog') {
      // El sprint destino tiene que ser del mismo proyecto
      const dest = await one(`select id from sprints where id=$1 and project_id=$2 and state<>'closed'`, [int(body.move_to), s.project_id]);
      if (!dest) throw bad('El sprint destino no es válido');
      target = dest.id;
    }
    // Un solo UPDATE para mover lo pendiente (antes: uno por tarea)
    const undone = await q(`update issues i set sprint_id=$2 from issues x left join project_statuses ps on ps.id=x.status_id
      where i.id=x.id and x.sprint_id=$1 and coalesce(ps.kind,'todo')<>'done' returning i.id`, [s.id, target]);
    await q(`update sprints set state='closed', completed_at=now(), completed_points=$2 where id=$1`, [s.id, done.p]);
    return { ok: true, moved: undone.length, completed: done.n, completed_points: done.p };
  });

  r.del('/sprints/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const s = await one('select * from sprints where id=$1', [int(params.id)]);
    if (!s) throw notFound();
    await sprintGuard(u, s.project_id);
    if (s.state === 'active') throw bad('No se puede eliminar un sprint activo');
    await q('update issues set sprint_id=null where sprint_id=$1', [s.id]);
    await q('delete from sprints where id=$1', [s.id]);
    return { ok: true };
  });

  // ---------- Informes de proyecto ----------
  r.get('/projects/:key/reports', async ({ req, params, query }) => {
    await requireUser(req);
    const p = await projectByKey(params.key);
    const sprint = query.sprint
      ? await one('select * from sprints where id=$1 and project_id=$2', [int(query.sprint), p.id])
      : await one(`select * from sprints where project_id=$1 and state in ('active','closed') order by case state when 'active' then 0 else 1 end, completed_at desc nulls last limit 1`, [p.id]);
    let burndown = null;
    if (sprint && sprint.start_date) {
      const start = new Date(sprint.start_date);
      const end = new Date(sprint.end_date || Date.now());
      const issues = await q(`select i.story_points, i.resolved_at, ps.kind from issues i left join project_statuses ps on ps.id=i.status_id where i.sprint_id=$1 and i.type<>'subtask'`, [sprint.id]);
      const total = issues.reduce((a, x) => a + Number(x.story_points || 0), 0);
      const totalCount = issues.length;
      const days = [];
      const dayMs = 86400000;
      const nDays = Math.max(1, Math.round((end - start) / dayMs));
      for (let d = 0; d <= nDays; d++) {
        const dayEnd = new Date(start.getTime() + (d + 1) * dayMs);
        const isFuture = dayEnd.getTime() - dayMs > Date.now();
        const doneBy = issues.filter((x) => x.kind === 'done' && x.resolved_at && new Date(x.resolved_at) < dayEnd);
        days.push({
          day: new Date(start.getTime() + d * dayMs).toISOString().slice(0, 10),
          ideal: Math.round((total - (total * d) / nDays) * 10) / 10,
          remaining: isFuture ? null : total - doneBy.reduce((a, x) => a + Number(x.story_points || 0), 0),
          remainingCount: isFuture ? null : totalCount - doneBy.length,
        });
      }
      burndown = { sprint, total, totalCount, days };
    }
    const [velocity, byStatus, byAssignee, byType, trend] = await Promise.all([
      q(`select name, coalesce(committed_points,0) as committed, coalesce(completed_points,0) as completed from sprints where project_id=$1 and state='closed' order by completed_at desc limit 8`, [p.id]),
      q(`select ps.name, ps.kind, count(i.id)::int as n from project_statuses ps left join issues i on i.status_id=ps.id and i.type<>'epic' where ps.project_id=$1 group by ps.id order by ps.sort`, [p.id]),
      q(`select i.assignee_id as id, count(*)::int as n, coalesce(sum(i.story_points),0) as points from issues i left join project_statuses ps on ps.id=i.status_id where i.project_id=$1 and coalesce(ps.kind,'todo')<>'done' and i.type<>'epic' group by 1 order by 2 desc`, [p.id]),
      q(`select type, count(*)::int as n from issues where project_id=$1 group by 1`, [p.id]),
      q(`with days as (select generate_series(current_date - 29, current_date, interval '1 day')::date as d)
         select to_char(d,'YYYY-MM-DD') as day,
           (select count(*)::int from issues i where i.project_id=$1 and i.created_at::date=d.d and i.type<>'epic') as created,
           (select count(*)::int from issues i where i.project_id=$1 and i.resolved_at::date=d.d and i.type<>'epic') as resolved
         from days d order by d.d`, [p.id]),
    ]);
    return { burndown, velocity: velocity.reverse(), byStatus, byAssignee, byType, trend };
  });

  // ---------- Mi trabajo ----------
  r.get('/my-work', async ({ req }) => {
    const u = await requireUser(req);
    const [issues, tickets] = await Promise.all([
      q(`select ${ISSUE_COLS}, p.key as project_key, p.name as project_name, p.color as project_color from issues i
         join projects p on p.id=i.project_id left join project_statuses ps on ps.id=i.status_id
         where i.assignee_id=$1 and coalesce(ps.kind,'todo')<>'done' and not p.archived order by i.due_date nulls last, i.priority desc, i.updated_at desc limit 200`, [u.id]),
      q(`select t.number,t.subject,t.priority,t.resolution_due,t.created_at,s.name as status_name,s.kind as status_kind from tickets t join statuses s on s.id=t.status_id
         where t.assignee_id=$1 and s.kind in ('open','pending') and t.deleted_at is null and not t.spam order by t.resolution_due nulls last, t.created_at limit 200`, [u.id]),
    ]);
    return { issues, tickets };
  });
}

export { TYPE_LABEL };
