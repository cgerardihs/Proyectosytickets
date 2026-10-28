// Portfolio de proyectos: avance automático (por etapas o tareas), salud, horas y fechas del roadmap.
import { q, one } from './db.js';
import { isSuper } from './auth.js';

export const PORTFOLIO_STATUS = { planned: 'No iniciado', active: 'En curso', paused: 'En pausa', done: 'Finalizado', cancelled: 'Cancelado' };
export const PRIORITY_LABEL = { 1: 'Baja', 2: 'Media', 3: 'Alta', 4: 'Urgente' };

/** Quién ve el portfolio: el superadmin y quien tenga el permiso "Ver portfolio". */
export const canPortfolio = (u) => Boolean(u && (isSuper(u) || u.can_portfolio));

const todayIso = () => new Date().toISOString().slice(0, 10);
const iso = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);

/** Avance de una etapa: hecha 100; con tareas, el % de tareas hechas; sin tareas, el avance manual. */
export function phasePct(f) {
  if (f.status_kind === 'done') return 100;
  if (Number(f.children) > 0) return Math.round((Number(f.children_done) / Number(f.children)) * 100);
  if (f.progress !== null && f.progress !== undefined) return Math.max(0, Math.min(100, Number(f.progress)));
  return 0;
}

export function phaseState(f) {
  const pct = phasePct(f);
  if (pct >= 100) return 'done';
  if (f.status_kind === 'doing' || pct > 0 || Number(f.children_doing) > 0) return 'active';
  return 'pending';
}

/** Calcula los campos derivados de una fila de proyecto (avance, fechas efectivas, horas y salud). */
export function derive(p, today = todayIso()) {
  const phases = (p.phases || []).map((f) => ({ ...f, start_date: iso(f.start_date), due_date: iso(f.due_date), pct: phasePct(f), state: phaseState(f) }));
  let auto = null;
  if (phases.length) auto = Math.round(phases.reduce((a, f) => a + f.pct, 0) / phases.length);
  else if (Number(p.total_issues) > 0) auto = Math.round((Number(p.done_issues) / Number(p.total_issues)) * 100);
  const manual = p.progress_override === null || p.progress_override === undefined ? null : Number(p.progress_override);
  let progress = manual ?? auto ?? 0;
  if (p.portfolio_status === 'done') progress = 100;
  // Fechas efectivas: las del proyecto o, si no tiene, la primera y la última de sus etapas
  const starts = phases.map((f) => f.start_date).filter(Boolean).sort();
  const ends = phases.map((f) => f.due_date).filter(Boolean).sort();
  const start = iso(p.start_date) || starts[0] || null;
  const end = iso(p.end_date) || ends[ends.length - 1] || null;
  const logged = Math.round((Number(p.minutes || 0) / 60) * 10) / 10;
  const hours = Math.round((logged + Number(p.extra_hours || 0)) * 10) / 10;
  // Salud: atrasado si pasó la fecha de fin sin terminar; en riesgo si el avance va 20 puntos por debajo de lo esperado por el tiempo
  let health = 'none';
  let expected = null;
  const open = !['done', 'cancelled'].includes(p.portfolio_status);
  if (p.recurring) health = open ? 'ok' : 'none';
  else if (open && start && end) {
    const s = Date.parse(start);
    const e = Date.parse(end);
    const t = Date.parse(today);
    expected = e > s ? Math.max(0, Math.min(100, Math.round(((t - s) / (e - s)) * 100))) : (t >= e ? 100 : 0);
    if (end < today) health = 'late';
    else if (p.portfolio_status === 'active' && expected - progress >= 20) health = 'risk';
    else health = 'ok';
  } else if (open && end && end < today) health = 'late';
  if (p.portfolio_status === 'done') health = 'done';
  // Etapa actual: la primera sin terminar si las etapas tienen avance; si no tienen datos (avance cargado a mano), la que corresponde por fecha
  let current = null;
  let currentBy = null;
  if (open && phases.length) {
    if (phases.some((f) => f.state !== 'pending')) { current = phases.find((f) => f.state !== 'done') || null; currentBy = 'progress'; }
    else if (phases.some((f) => f.start_date || f.due_date)) {
      current = phases.find((f) => f.start_date && f.due_date && f.start_date <= today && today <= f.due_date)
        || (phases[0].start_date && today < phases[0].start_date ? phases[0] : null)
        || [...phases].reverse().find((f) => f.due_date && f.due_date < today) || null;
      currentBy = current ? 'dates' : null;
    }
  }
  return {
    ...p, phases, progress, progress_auto: auto, progress_source: manual !== null ? 'manual' : auto !== null ? 'auto' : 'none',
    start, end, logged_hours: logged, hours, expected, health, planned: Boolean(start && end) || Boolean(p.recurring),
    current_phase: current ? current.title : null, current_phase_by: currentBy, status_label: PORTFOLIO_STATUS[p.portfolio_status] || p.portfolio_status,
    priority_label: PRIORITY_LABEL[p.priority] || '',
  };
}

/** Proyectos con todo lo necesario para el portfolio y el roadmap, en una sola consulta. */
export async function portfolioRows({ ids = null, keys = null } = {}) {
  const params = [];
  let where = '';
  if (ids) { params.push(ids); where = `where p.id = any($${params.length}::int[])`; }
  if (keys) { params.push(keys.map((k) => String(k).toUpperCase())); where = `where upper(p.key) = any($${params.length}::text[])`; }
  const rows = await q(`
    select p.id, p.key, p.name, p.description, p.color, p.lead_id, p.archived, p.type_id, p.origin_id, p.sector_id, p.area_id, p.priority,
      p.start_date, p.end_date, p.estimated_hours, p.extra_hours, p.progress_override, p.portfolio_status, p.recurring, p.auto_done, p.created_at, p.updated_at,
      pt.name as type_name, pt.color as type_color, o.name as origin_name, o.color as origin_color, s.name as sector_name, s.color as sector_color,
      c.name as area_name, u.name as lead_name, u.email as lead_email,
      coalesce(ph.list, '[]'::json) as phases, coalesce(ic.total, 0) as total_issues, coalesce(ic.done, 0) as done_issues,
      coalesce(tm.minutes, 0) as minutes, coalesce(tk.nums, '{}') as ticket_numbers, coalesce(pm.ids, '{}') as member_ids, coalesce(pw.ids, '{}') as worker_ids
    from projects p
    left join project_types pt on pt.id = p.type_id
    left join portfolio_options o on o.id = p.origin_id
    left join portfolio_options s on s.id = p.sector_id
    left join categories c on c.id = p.area_id
    left join users u on u.id = p.lead_id
    left join lateral (
      select json_agg(json_build_object(
        'id', e.id, 'key', e.key, 'title', e.title, 'start_date', e.start_date, 'due_date', e.due_date, 'assignee_id', e.assignee_id,
        'status_kind', es.kind, 'progress', e.progress,
        'children', coalesce(ch.n, 0), 'children_done', coalesce(ch.done, 0), 'children_doing', coalesce(ch.doing, 0)
      ) order by e.rank, e.id) as list
      from issues e
      left join project_statuses es on es.id = e.status_id
      left join lateral (
        select count(*)::int as n, count(*) filter (where cs.kind = 'done')::int as done, count(*) filter (where cs.kind = 'doing')::int as doing
        from issues x left join project_statuses cs on cs.id = x.status_id where x.parent_id = e.id
      ) ch on true
      where e.project_id = p.id and e.type = 'epic'
    ) ph on true
    left join lateral (
      select count(*)::int as total, count(*) filter (where ps.kind = 'done')::int as done
      from issues i left join project_statuses ps on ps.id = i.status_id where i.project_id = p.id and i.type <> 'epic'
    ) ic on true
    left join lateral (
      select sum(te.minutes)::int as minutes from time_entries te join issues i on i.id = te.issue_id where i.project_id = p.id
    ) tm on true
    left join lateral (
      select array_agg(t.number order by t.number) as nums from ticket_projects tp join tickets t on t.id = tp.ticket_id where tp.project_id = p.id
    ) tk on true
    left join lateral (
      select array_agg(m.user_id order by m.user_id) as ids from project_members m where m.project_id = p.id
    ) pm on true
    left join lateral (
      select array_agg(distinct w.assignee_id) as ids from issues w
      join users wu on wu.id = w.assignee_id and wu.active
      left join project_statuses ws on ws.id = w.status_id
      where w.project_id = p.id and w.type <> 'epic' and coalesce(ws.kind, 'todo') <> 'done'
    ) pw on true
    ${where}
    order by p.name`, params);
  const today = todayIso();
  return rows.map((r) => derive(r, today));
}

export async function portfolioOptions() {
  const [types, opts, areas, users] = await Promise.all([
    q('select * from project_types order by sort, id'),
    q('select * from portfolio_options order by kind, sort, name'),
    q('select id,name,description,active from categories order by sort, name'),
    q(`select id,name,email,active from users where role<>'superadmin' order by name`),
  ]);
  return { types, origins: opts.filter((o) => o.kind === 'origin'), sectors: opts.filter((o) => o.kind === 'sector'), areas, users };
}

// ---------- Importación desde Excel ----------
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9%|]+/g, ' ').trim();

/** Columnas reconocidas: el encabezado se compara por prefijo (tolera "Fecha Inic.", "Horas Est.", etc.). */
const HEADERS = [
  ['name', ['proyecto', 'nombre del proyecto', 'nombre']],
  ['key', ['clave']],
  ['description', ['descripcion', 'detalle']],
  ['origin', ['origen']],
  ['sector', ['sector']],
  ['area', ['area']],
  ['type', ['tipo']],
  ['lead', ['responsable', 'lider']],
  ['status', ['estado']],
  ['priority', ['prioridad']],
  ['start', ['fecha ini', 'inicio', 'fecha desde']],
  ['end', ['fecha fi', 'fin', 'fecha hasta']],
  ['estimated', ['horas es', 'horas estim', 'estimad']],
  ['progress', ['% av', 'avance', '%']],
  ['extra', ['horas man', 'horas manuales', 'horas reales', 'horas registradas']],
];

export function mapHeaders(row) {
  const map = {};
  (row || []).forEach((cell, i) => {
    const h = norm(typeof cell === 'object' && cell ? cell.date : cell);
    if (!h) return;
    for (const [field, prefixes] of HEADERS) {
      if (map[field] !== undefined) continue;
      if (prefixes.some((p) => h === p || h.startsWith(p))) { map[field] = i; break; }
    }
  });
  return map;
}

const STATUS_WORDS = [
  ['done', ['finaliz', 'termin', 'complet', 'cerrad', 'hecho']],
  ['paused', ['paus', 'stand', 'deten', 'suspend']],
  ['cancelled', ['cancel', 'descart', 'anulad']],
  ['planned', ['no inic', 'pendient', 'planif', 'por inic', 'backlog']],
  ['active', ['en curso', 'curso', 'en progreso', 'progreso', 'activo', 'iniciad']],
];
export function parseStatus(s) {
  const n = norm(s);
  if (!n) return null;
  for (const [k, words] of STATUS_WORDS) if (words.some((w) => n.includes(w))) return k;
  return null;
}
export function parsePriority(s) {
  const n = norm(s);
  if (!n) return null;
  if (/^\d$/.test(n)) return Math.max(1, Math.min(4, Number(n)));
  if (n.startsWith('baj')) return 1;
  if (n.startsWith('med') || n.startsWith('norm')) return 2;
  if (n.startsWith('alt')) return 3;
  if (n.startsWith('urg') || n.startsWith('crit')) return 4;
  return null;
}
/** Fecha de una celda: serie de Excel, objeto { date }, "dd/mm/aa", "dd/mm/aaaa" o "aaaa-mm-dd". */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return { date: null };
  if (typeof v === 'object') {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v.date || ''));
    return d ? { date: valid(d[1], d[2], d[3]) } : { date: null, invalid: String(v.date || '') };
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return { date: new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) };
    return { date: null, invalid: String(v) };
  }
  const s = String(v).trim();
  if (/recurr|perman|continu/i.test(s)) return { date: null, recurring: true };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { date: valid(m[1], m[2], m[3]) };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return { date: valid(y, m[2], m[1]) };
  }
  return { date: null, invalid: s };
}
function valid(y, mo, d) {
  if (Number(y) < 1990 || Number(y) > 2200) return null;
  const out = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${out}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== out ? null : out;
}
export function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, '');
  // "1.728" (miles) o "12,5" (decimal) al estilo argentino
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
export function parsePercent(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Math.round(Math.max(0, Math.min(100, v <= 1 ? v * 100 : v)));
  const s = String(v).trim();
  const n = parseNumber(s.replace('%', ''));
  if (n === null) return null;
  return Math.round(Math.max(0, Math.min(100, s.includes('%') || n > 1 ? n : n * 100)));
}

/** Compara textos tolerando abreviaturas: cada palabra del texto tiene que ser el comienzo de una palabra del candidato, en orden. */
export function fuzzyMatch(text, candidates, fields = ['name']) {
  const a = norm(text);
  if (!a) return null;
  const vals = (c) => fields.map((f) => norm(c[f])).filter(Boolean);
  const exact = candidates.filter((c) => vals(c).includes(a));
  if (exact.length) return exact[0];
  const ta = a.split(' ').filter((w) => w !== 'y' && w !== 'de' && w !== '|');
  const tokenPrefix = (b) => {
    const tb = b.split(' ').filter((w) => w !== 'y' && w !== 'de' && w !== '|');
    let j = 0;
    for (const w of ta) {
      while (j < tb.length && !(tb[j].startsWith(w) || w.startsWith(tb[j]))) j++;
      if (j >= tb.length) return false;
      j++;
    }
    return true;
  };
  const hits = candidates.filter((c) => vals(c).some((b) => b.startsWith(a) || a.startsWith(b) || tokenPrefix(b)));
  return hits.length === 1 ? hits[0] : hits.length > 1 ? hits.sort((x, y) => norm(x[fields[0]]).length - norm(y[fields[0]]).length)[0] : null;
}

/** Busca un usuario por nombre: exacto, o por apellido si hay uno solo con ese apellido. */
export function matchUser(name, users) {
  const n = norm(name);
  if (!n) return null;
  const raw = String(name).trim().toLowerCase();
  const exact = users.find((u) => norm(u.name) === n || String(u.email).toLowerCase() === raw || String(u.email).toLowerCase().split('@')[0] === raw);
  if (exact) return exact;
  const last = n.split(' ').pop();
  const first = n.split(' ')[0];
  const bySurname = users.filter((u) => norm(u.name).split(' ').pop() === last);
  if (bySurname.length === 1) return bySurname[0];
  const both = bySurname.filter((u) => norm(u.name).startsWith(first.slice(0, 3)));
  return both.length === 1 ? both[0] : null;
}

/** Clave de proyecto sugerida a partir del nombre (ej. "Nuevo portal certificados" → NPC). */
export function suggestKey(name, taken) {
  const words = norm(name).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2 || /\d/.test(w));
  let base = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || 'PRY').slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(base)) base = `P${base}`;
  base = base.slice(0, 6);
  if (base.length < 2) base = `${base}X`.slice(0, 2).padEnd(2, 'X');
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base.slice(0, 8)}${i}`;
  taken.add(key);
  return key;
}

/**
 * Interpreta las filas de la planilla y arma el plan de importación (sin escribir nada).
 * Cada fila dice si crea o actualiza (por nombre o clave), con qué valores y qué advertencias tiene.
 */
export async function planImport(matrix, { canCreateAreas = false } = {}) {
  const headerIdx = matrix.findIndex((r) => {
    const m = mapHeaders(r);
    return m.name !== undefined && Object.keys(m).length >= 2;
  });
  if (headerIdx < 0) throw new Error('No encontré la fila de encabezados. La planilla tiene que tener la columna "Proyecto" y al menos otra (Estado, Responsable, Fechas, etc.).');
  const map = mapHeaders(matrix[headerIdx]);
  const opts = await portfolioOptions();
  const existing = await q('select id, key, name from projects');
  const taken = new Set(existing.map((p) => p.key));
  const byName = new Map(existing.map((p) => [norm(p.name), p]));
  const byKey = new Map(existing.map((p) => [p.key.toUpperCase(), p]));
  const defaultType = opts.types.find((t) => t.is_default) || opts.types[0];
  const created = { origin: new Map(), sector: new Map(), area: new Map() };
  const cell = (r, f) => (map[f] === undefined ? undefined : r[map[f]]);
  const str = (x) => (x === null || x === undefined ? '' : typeof x === 'object' ? x.date || '' : String(x)).trim();
  const out = [];
  const seen = new Set();
  for (let i = headerIdx + 1; i < matrix.length && out.length < 1000; i++) {
    const r = matrix[i] || [];
    const name = str(cell(r, 'name')).replace(/\s+/g, ' ').slice(0, 120);
    if (!name) continue;
    const warnings = [];
    const keyCell = str(cell(r, 'key')).toUpperCase();
    const match = (keyCell && byKey.get(keyCell)) || byName.get(norm(name));
    if (seen.has(norm(name))) { warnings.push('Nombre repetido en la planilla: se toma solo la primera fila'); out.push({ row: i + 1, name, action: 'skip', warnings, fields: {} }); continue; }
    seen.add(norm(name));
    const f = { name };
    const desc = str(cell(r, 'description'));
    if (map.description !== undefined) f.description = desc.slice(0, 4000);
    // Listas: se busca la opción existente; si no está, se crea
    const pick = (kind, list, text, label) => {
      const t = str(text);
      if (!t) return null;
      const hit = fuzzyMatch(t, list, kind === 'area' ? ['name', 'description'] : ['name']);
      if (hit) return { id: hit.id, name: hit.name };
      // Las áreas son las categorías de los tickets: solo un administrador puede crear nuevas
      if (kind === 'area' && !canCreateAreas) { warnings.push(`${label} "${t}" no existe: queda sin área (solo un administrador puede crear áreas)`); return null; }
      const k = norm(t);
      if (!created[kind].has(k)) created[kind].set(k, t.slice(0, 80));
      warnings.push(`${label} "${t}" no existe: se crea`);
      return { id: null, name: created[kind].get(k) };
    };
    if (map.origin !== undefined) f.origin = pick('origin', opts.origins, cell(r, 'origin'), 'Origen');
    if (map.sector !== undefined) f.sector = pick('sector', opts.sectors, cell(r, 'sector'), 'Sector IT');
    if (map.area !== undefined) f.area = pick('area', opts.areas, cell(r, 'area'), 'Área');
    if (map.lead !== undefined) {
      const ln = str(cell(r, 'lead'));
      const u = ln ? matchUser(ln, opts.users.filter((x) => x.active)) : null;
      if (ln && !u) warnings.push(`No encontré a "${ln}" entre los agentes: queda sin responsable`);
      f.lead = u ? { id: u.id, name: u.name } : null;
    }
    if (map.status !== undefined) {
      const st = str(cell(r, 'status'));
      f.status = parseStatus(st) || (st ? 'active' : null);
      if (st && !parseStatus(st)) warnings.push(`Estado "${st}" no reconocido: queda En curso`);
    }
    if (map.priority !== undefined) f.priority = parsePriority(str(cell(r, 'priority')));
    const tName = str(cell(r, 'type'));
    let type = tName ? fuzzyMatch(tName, opts.types) : null;
    if (tName && !type) warnings.push(`Tipo "${tName}" no existe: se usa ${defaultType?.name}`);
    if (!type) {
      const hay = norm(`${name} ${desc}`);
      if (/capacit|curso|taller|formacion/.test(hay)) type = opts.types.find((t) => /capacit/i.test(t.name));
      else if (/instalac|implementac de|licenc/.test(hay)) type = opts.types.find((t) => /instalac/i.test(t.name));
      else if (/infra/.test(norm(f.sector?.name))) type = opts.types.find((t) => /infra/i.test(t.name));
    }
    f.type = type || defaultType ? { id: (type || defaultType).id, name: (type || defaultType).name } : null;
    const s = parseDate(cell(r, 'start'));
    const e = parseDate(cell(r, 'end'));
    if (s.invalid) warnings.push(`Fecha de inicio "${s.invalid}" no reconocida`);
    if (e.invalid) warnings.push(`Fecha de fin "${e.invalid}" no reconocida`);
    if (map.start !== undefined) f.start_date = s.date;
    if (map.end !== undefined) f.end_date = e.date;
    if (map.start !== undefined || map.end !== undefined) f.recurring = Boolean(s.recurring || e.recurring);
    if (f.start_date && f.end_date && f.end_date < f.start_date) { warnings.push('La fecha de fin es anterior al inicio: se ignora el fin'); f.end_date = null; }
    const hours = (x) => { const n = parseNumber(x); return n === null ? null : Math.min(1e6, Math.max(0, n)); };
    if (map.estimated !== undefined) f.estimated_hours = hours(cell(r, 'estimated'));
    if (map.extra !== undefined) f.extra_hours = hours(cell(r, 'extra')) ?? 0;
    if (map.progress !== undefined) f.progress = parsePercent(cell(r, 'progress'));
    if (!match && !f.start_date && !f.end_date && !f.recurring) warnings.push('Sin fechas: va a figurar en "Sin planificar"');
    const key = match ? match.key : keyCell && /^[A-Z][A-Z0-9]{1,9}$/.test(keyCell) && !taken.has(keyCell) ? (taken.add(keyCell), keyCell) : suggestKey(name, taken);
    out.push({ row: i + 1, name, key, action: match ? 'update' : 'create', project_id: match?.id || null, fields: f, warnings });
  }
  return {
    columns: Object.keys(map), rows: out,
    create_options: {
      origin: [...created.origin.values()], sector: [...created.sector.values()], area: [...created.area.values()],
    },
  };
}

/** Aplica el plan dentro de una transacción (la llama la ruta). Devuelve cuántos creó y actualizó. */
export async function applyImport(plan, user, { createProject, handOverLead }) {
  const ensure = async (kind, name) => {
    if (kind === 'area') {
      const ex = await one('select id from categories where lower(name)=lower($1)', [name]);
      return ex ? ex.id : (await one('insert into categories(name,sort) values ($1,99) returning id', [name.slice(0, 80)])).id;
    }
    const ex = await one('select id from portfolio_options where kind=$1 and lower(name)=lower($2)', [kind, name]);
    return ex ? ex.id : (await one('insert into portfolio_options(kind,name,sort) values ($1,$2,99) returning id', [kind, name.slice(0, 80)])).id;
  };
  const idOf = async (kind, v) => (!v ? null : v.id || ensure(kind, v.name));
  let created = 0;
  let updated = 0;
  for (const r of plan.rows) {
    if (r.action === 'skip') continue;
    const f = r.fields;
    const vals = {
      origin_id: f.origin === undefined ? undefined : await idOf('origin', f.origin),
      sector_id: f.sector === undefined ? undefined : await idOf('sector', f.sector),
      area_id: f.area === undefined ? undefined : await idOf('area', f.area),
      lead_id: f.lead === undefined ? undefined : f.lead?.id || null,
      portfolio_status: f.status || undefined,
      priority: f.priority || undefined,
      start_date: f.start_date,
      end_date: f.end_date,
      estimated_hours: f.estimated_hours,
      extra_hours: f.extra_hours,
      progress_override: f.progress,
      recurring: f.recurring,
      description: f.description,
      type_id: f.type?.id,
    };
    let id = r.project_id;
    if (r.action === 'create') {
      const p = await createProject({
        key: r.key, name: r.name, description: vals.description || '', lead_id: vals.lead_id || null, type_id: vals.type_id || null,
        start_date: vals.start_date || null, end_date: vals.end_date || null,
      }, user, { skipMemberLead: !vals.lead_id });
      id = p.id;
      created++;
    } else updated++;
    const set = Object.entries(vals).filter(([k, v]) => v !== undefined && !(r.action === 'update' && k === 'type_id'));
    const before = r.action === 'update' && vals.lead_id !== undefined ? await one('select lead_id from projects where id=$1', [id]) : null;
    if (set.length) {
      await q(`update projects set ${set.map(([k], i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() where id=$1`, [id, ...set.map(([, v]) => v)]);
    }
    // Cambió el responsable desde la planilla: el equipo acompaña (igual que al cambiarlo en pantalla)
    if (before && before.lead_id !== vals.lead_id) await handOverLead(id, before.lead_id, vals.lead_id);
  }
  return { created, updated };
}
