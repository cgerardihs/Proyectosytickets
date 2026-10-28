// Informes → Explorador (v1.14): grilla a medida que mezcla tickets, proyectos, tareas, contactos y horas, con cualquier campo.
// Los "campos comunes" se completan con el dato equivalente de cada tipo (ej. Responsable = asignado del ticket o líder del
// proyecto), así distintos tipos conviven en una misma lista. También se puede relacionar: tickets con su proyecto y su
// contacto, o tareas con su proyecto.
import { state, api, esc, icon, toast, toastError, modal, confirmDialog, fieldLabel, PRIORITY, CHANNEL } from '../core.js';
import { maxButton } from './reports.js';

const SRC = { ticket: ['Tickets', '#2563eb'], project: ['Proyectos', '#C8102E'], task: ['Tareas y etapas', '#7c3aed'], contact: ['Contactos', '#0f766e'], time: ['Horas registradas', '#d97706'] };
const MODES = { union: 'En una sola lista', 'join:ticket': 'Tickets con su proyecto y contacto', 'join:task': 'Tareas con su proyecto' };
const RELATED = { 'join:ticket': ['ticket', 'project', 'contact'], 'join:task': ['task', 'project'] };
const KIND = { open: 'Abierto', pending: 'Pendiente', resolved: 'Resuelto', closed: 'Cerrado' };
const ISSUE_TYPE = { epic: 'Etapa', story: 'Historia', task: 'Tarea', bug: 'Error', subtask: 'Subtarea' };
const HEALTH = { ok: 'En término', risk: 'En riesgo', late: 'Atrasado', done: 'Finalizado', none: 'Sin fechas' };
const PERIODS = { 30: 'Últimos 30 días', 90: 'Últimos 90 días', 365: 'Último año', year: 'Este año', all: 'Todo' };
const ROW_LIMIT = 1000;
const LS = 'rp-explorer';
const day = (v) => (v ? String(v).slice(0, 10) : null);
const hours = (m) => (m === null || m === undefined ? null : Math.round((Number(m) / 60) * 10) / 10);
const hDiff = (a, b) => (a && b ? Math.round(((Date.parse(b) - Date.parse(a)) / 36e5) * 10) / 10 : null);
const isOpenTicket = (r) => ['open', 'pending'].includes(r.status_kind);
function slaState(r) {
  if (!r.resolution_due) return null;
  if (r.resolved_at) return Date.parse(r.resolved_at) <= Date.parse(r.resolution_due) ? 'Cumplido' : 'Incumplido';
  if (r.sla_paused_at) return 'Pausado';
  const left = Date.parse(r.resolution_due) - Date.now();
  if (left < 0) return 'Vencido';
  return left < 864e5 ? 'Vence hoy' : 'En término';
}

// ---------- Catálogo de campos ----------
// type: text | num | date | datetime | bool | list | pct ; agg: sum (total en el pie)
const COMMON = [
  ['c.type', 'Tipo', 'text', { ticket: () => 'Ticket', project: () => 'Proyecto', task: (r) => ISSUE_TYPE[r.type] || 'Tarea', contact: () => 'Contacto', time: () => 'Horas' }],
  ['c.id', 'Número / clave', 'text', { ticket: (r) => `#${r.number}`, project: (r) => r.key, task: (r) => r.key, time: (r) => (r.ticket ? `#${r.ticket}` : r.issue) }],
  ['c.title', 'Título', 'text', { ticket: (r) => r.subject, project: (r) => r.name, task: (r) => r.title, contact: (r) => r.name, time: (r) => r.note }],
  ['c.status', 'Estado', 'text', { ticket: (r) => r.status, project: (r) => r.status, task: (r) => r.status, contact: (r) => (r.active === false ? 'Inactivo' : 'Activo') }],
  ['c.open', 'Abierto', 'bool', { ticket: isOpenTicket, project: (r) => !['done', 'cancelled'].includes(r.status_kind), task: (r) => r.status_kind !== 'done', contact: (r) => r.open_tickets > 0 }, 'Ticket abierto o pendiente · proyecto no finalizado ni cancelado · tarea no hecha'],
  ['c.owner', 'Responsable', 'text', { ticket: (r) => r.assignee || 'Sin asignar', project: (r) => r.lead || 'Sin responsable', task: (r) => r.assignee || 'Sin asignar', time: (r) => r.user_name }, 'Asignado (tickets y tareas) · Líder (proyectos) · Quién cargó (horas)'],
  ['c.area', 'Área', 'text', { ticket: (r) => r.area, project: (r) => r.area, task: (r) => r.area, contact: (r) => r.area }, 'Área solicitante (del ticket o del proyecto) · área del contacto'],
  ['c.prio', 'Prioridad', 'text', { ticket: (r) => PRIORITY[r.priority], project: (r) => PRIORITY[r.priority], task: (r) => PRIORITY[r.priority] }],
  ['c.start', 'Creado / inicio', 'date', { ticket: (r) => day(r.created_at), project: (r) => r.start, task: (r) => day(r.start_date) || day(r.created_at), contact: (r) => day(r.created_at), time: (r) => day(r.spent_on) }, 'Creación (tickets, contactos) · inicio (proyectos, tareas) · fecha (horas)'],
  ['c.due', 'Vence / fin', 'date', { ticket: (r) => day(r.resolution_due), project: (r) => r.end, task: (r) => day(r.due_date) }, 'Vencimiento del SLA (tickets) · fin (proyectos) · vencimiento (tareas)'],
  ['c.hours', 'Horas registradas', 'num', { ticket: (r) => hours(r.minutes), project: (r) => r.hours, task: (r) => hours(r.minutes), time: (r) => hours(r.minutes) }, null, 'sum'],
  ['c.updated', 'Última modificación', 'datetime', { ticket: (r) => r.updated_at, project: (r) => r.updated_at, task: (r) => r.updated_at, time: (r) => r.created_at }],
];
const SPECIFIC = {
  ticket: [
    ['subject', 'Asunto', 'text', (r) => r.subject], ['number', 'Número', 'text', (r) => `#${r.number}`], ['status', 'Estado', 'text', (r) => r.status],
    ['status_kind', 'Tipo de estado', 'text', (r) => KIND[r.status_kind]], ['priority', 'Prioridad', 'text', (r) => PRIORITY[r.priority]],
    ['channel', 'Canal', 'text', (r) => CHANNEL[r.channel] || r.channel], ['tech', () => fieldLabel('tech'), 'text', (r) => r.tech], ['subtech', () => fieldLabel('subtech'), 'text', (r) => r.subtech],
    ['type', () => fieldLabel('type'), 'text', (r) => r.ticket_type], ['area', () => fieldLabel('category'), 'text', (r) => r.area], ['group', 'Grupo', 'text', (r) => r.group_name],
    ['assignee', () => fieldLabel('assignee'), 'text', (r) => r.assignee], ['contact', 'Contacto', 'text', (r) => r.contact], ['contact_email', 'Email del contacto', 'text', (r) => r.contact_email],
    ['contact_area', 'Área del contacto', 'text', (r) => r.contact_area], ['contact_job', 'Cargo del contacto', 'text', (r) => r.contact_job], ['contact_vip', 'Contacto VIP', 'bool', (r) => r.contact_vip],
    ['company', 'Empresa', 'text', (r) => r.company], ['created_by', 'Creado por', 'text', (r) => r.created_by], ['sla_policy', 'Política de SLA', 'text', (r) => r.sla_policy],
    ['sla', 'Estado del SLA', 'text', slaState], ['created_at', 'Creado', 'datetime', (r) => r.created_at], ['first_response_due', 'Vence 1ª respuesta', 'datetime', (r) => r.first_response_due],
    ['first_responded_at', '1ª respuesta', 'datetime', (r) => r.first_responded_at], ['resolution_due', 'Vence resolución', 'datetime', (r) => r.resolution_due],
    ['resolved_at', 'Resuelto', 'datetime', (r) => r.resolved_at], ['closed_at', 'Cerrado', 'datetime', (r) => r.closed_at], ['last_activity_at', 'Última actividad', 'datetime', (r) => r.last_activity_at],
    ['first_h', 'Horas hasta 1ª respuesta', 'num', (r) => hDiff(r.created_at, r.first_responded_at)], ['resolution_h', 'Horas hasta resolución', 'num', (r) => hDiff(r.created_at, r.resolved_at)],
    ['age_d', 'Antigüedad (días)', 'num', (r) => Math.floor((Date.now() - Date.parse(r.created_at)) / 864e5)], ['hours', 'Horas registradas', 'num', (r) => hours(r.minutes), 'sum'],
    ['messages', 'Mensajes', 'num', (r) => r.messages, 'sum'], ['tags', 'Etiquetas', 'list', (r) => r.tags], ['cc', 'CC', 'list', (r) => r.cc],
    ['projects', 'Proyectos vinculados', 'list', (r) => r.projects], ['critical', 'Sistema crítico vinculado', 'text', (r) => r.critical_system], ['ai', 'Respuesta automática (IA)', 'bool', (r) => r.ai_auto],
  ],
  project: [
    ['key', 'Clave', 'text', (r) => r.key], ['name', 'Proyecto', 'text', (r) => r.name], ['description', 'Descripción', 'text', (r) => r.description], ['type', 'Tipo de proyecto', 'text', (r) => r.type],
    ['origin', 'Origen', 'text', (r) => r.origin], ['sector', 'Sector IT', 'text', (r) => r.sector], ['area', 'Área solicitante', 'text', (r) => r.area], ['lead', 'Líder', 'text', (r) => r.lead],
    ['status', 'Estado', 'text', (r) => r.status], ['priority', 'Prioridad', 'text', (r) => PRIORITY[r.priority]], ['start', 'Inicio', 'date', (r) => r.start], ['end', 'Fin', 'date', (r) => r.end],
    ['baseline_end', 'Fin planificado', 'date', (r) => r.baseline_end], ['deviation', 'Desvío (días)', 'num', (r) => (r.baseline_end && r.end ? Math.round((Date.parse(r.end) - Date.parse(r.baseline_end)) / 864e5) : null)],
    ['progress', 'Avance %', 'pct', (r) => r.progress], ['progress_source', 'Avance calculado o manual', 'text', (r) => ({ auto: 'Calculado', manual: 'Manual', none: 'Sin datos' }[r.progress_source])],
    ['health', 'Salud', 'text', (r) => HEALTH[r.health]], ['phase', 'Etapa actual', 'text', (r) => r.current_phase], ['phases', 'Cantidad de etapas', 'num', (r) => r.phases],
    ['estimated', 'Horas estimadas', 'num', (r) => r.estimated_hours, 'sum'], ['logged', 'Horas registradas en tareas', 'num', (r) => r.logged_hours, 'sum'], ['extra', 'Horas manuales', 'num', (r) => r.extra_hours, 'sum'],
    ['hours', 'Horas totales', 'num', (r) => r.hours, 'sum'], ['tasks', 'Tareas', 'num', (r) => r.total_issues, 'sum'], ['tasks_done', 'Tareas hechas', 'num', (r) => r.done_issues, 'sum'],
    ['tasks_open', 'Tareas abiertas', 'num', (r) => r.total_issues - r.done_issues, 'sum'], ['members', 'Equipo', 'list', (r) => r.members], ['tickets', 'Tickets vinculados', 'list', (r) => r.tickets.map((n) => `#${n}`)],
    ['recurring', 'Recurrente', 'bool', (r) => r.recurring], ['archived', 'Archivado', 'bool', (r) => r.archived], ['created_at', 'Creado', 'datetime', (r) => r.created_at],
  ],
  task: [
    ['key', 'Clave', 'text', (r) => r.key], ['title', 'Título', 'text', (r) => r.title], ['type', 'Tipo', 'text', (r) => ISSUE_TYPE[r.type]], ['status', 'Estado', 'text', (r) => r.status],
    ['done', 'Hecha', 'bool', (r) => r.status_kind === 'done'], ['priority', 'Prioridad', 'text', (r) => PRIORITY[r.priority]], ['assignee', 'Asignado', 'text', (r) => r.assignee], ['reporter', 'Creada por', 'text', (r) => r.reporter],
    ['project', 'Proyecto (clave)', 'text', (r) => r.project], ['project_name', 'Proyecto', 'text', (r) => r.project_name], ['area', 'Área del proyecto', 'text', (r) => r.area],
    ['parent', 'Etapa / tarea madre', 'text', (r) => (r.parent_key ? `${r.parent_key} ${r.parent_title}` : null)], ['sprint', 'Sprint', 'text', (r) => r.sprint], ['sp', 'Story points', 'num', (r) => (r.story_points === null ? null : Number(r.story_points)), 'sum'],
    ['estimate', 'Estimación (h)', 'num', (r) => hours(r.estimate_minutes), 'sum'], ['hours', 'Horas registradas', 'num', (r) => hours(r.minutes), 'sum'], ['labels', 'Etiquetas', 'list', (r) => r.labels],
    ['start', 'Inicio', 'date', (r) => day(r.start_date)], ['due', 'Vence', 'date', (r) => day(r.due_date)], ['overdue', 'Vencida', 'bool', (r) => Boolean(r.due_date && r.status_kind !== 'done' && day(r.due_date) < new Date().toISOString().slice(0, 10))],
    ['progress', 'Avance % (etapas)', 'pct', (r) => r.progress], ['resolved_at', 'Terminada', 'datetime', (r) => r.resolved_at], ['created_at', 'Creada', 'datetime', (r) => r.created_at],
  ],
  contact: [
    ['name', 'Nombre', 'text', (r) => r.name], ['email', 'Email', 'text', (r) => r.email], ['phone', 'Teléfono', 'text', (r) => r.phone], ['area', 'Área', 'text', (r) => r.area],
    ['job', 'Cargo', 'text', (r) => r.job_title], ['manager', 'Jefe', 'text', (r) => r.manager], ['company', 'Empresa', 'text', (r) => r.company], ['vip', 'VIP', 'bool', (r) => r.vip],
    ['active', 'Activo', 'bool', (r) => r.active !== false], ['tickets', 'Tickets', 'num', (r) => r.tickets, 'sum'], ['open', 'Tickets abiertos', 'num', (r) => r.open_tickets, 'sum'], ['created_at', 'Alta', 'datetime', (r) => r.created_at],
  ],
  time: [
    ['user', 'Persona', 'text', (r) => r.user_name], ['hours', 'Horas', 'num', (r) => hours(r.minutes), 'sum'], ['note', 'Nota', 'text', (r) => r.note], ['date', 'Fecha', 'date', (r) => day(r.spent_on)],
    ['ticket', 'Ticket', 'text', (r) => (r.ticket ? `#${r.ticket}` : null)], ['issue', 'Tarea', 'text', (r) => r.issue], ['project', 'Proyecto', 'text', (r) => r.project], ['created_at', 'Cargado', 'datetime', (r) => r.created_at],
  ],
};

const PRESETS = [
  { id: 'p1', name: 'Todo lo abierto: tickets y proyectos', config: { sources: ['ticket', 'project'], mode: 'union', cols: ['c.type', 'c.id', 'c.title', 'c.status', 'c.owner', 'c.area', 'c.due', 'ticket.sla', 'project.progress', 'c.hours'], filters: { 'c.open': 'sí' }, group: '', sort: null } },
  { id: 'p2', name: 'Carga por responsable', config: { sources: ['ticket', 'project', 'task'], mode: 'union', cols: ['c.owner', 'c.type', 'c.id', 'c.title', 'c.status', 'c.due', 'c.hours'], filters: { 'c.open': 'sí' }, group: 'c.owner', sort: { k: 'c.due', dir: 1 } } },
  { id: 'p3', name: 'Tickets con su proyecto', config: { sources: ['ticket', 'project', 'contact'], mode: 'join:ticket', cols: ['ticket.number', 'ticket.subject', 'ticket.contact', 'contact.area', 'ticket.status', 'project.key', 'project.name', 'project.progress', 'project.health'], filters: {}, group: '', sort: null } },
  { id: 'p4', name: 'Proyectos por salud', config: { sources: ['project'], mode: 'union', cols: ['project.key', 'project.name', 'project.lead', 'project.progress', 'project.end', 'project.baseline_end', 'project.deviation', 'project.estimated', 'project.hours'], filters: {}, group: 'project.health', sort: { k: 'project.end', dir: 1 } } },
  { id: 'p5', name: 'Horas por persona', config: { sources: ['time'], mode: 'union', period: '30', cols: ['time.user', 'time.date', 'time.ticket', 'time.issue', 'time.project', 'time.note', 'time.hours'], filters: {}, group: 'time.user', sort: { k: 'time.date', dir: -1 } } },
];

function catalog(customKeys) {
  const F = {};
  for (const [k, l, type, map, note, agg] of COMMON) F[k] = { k, l, type, map, note, agg, common: true };
  for (const [s, list] of Object.entries(SPECIFIC)) for (const [k, l, type, get, agg] of list) F[`${s}.${k}`] = { k: `${s}.${k}`, l: typeof l === 'function' ? l() : l, type, get, agg, s };
  for (const key of customKeys) F[`ticket.cf.${key}`] = { k: `ticket.cf.${key}`, l: key, type: 'text', get: (r) => (r.custom || {})[key], s: 'ticket', custom: true };
  return F;
}

function fmt(f, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (f.type === 'bool') return v ? 'Sí' : 'No';
  if (f.type === 'list') return [].concat(v).join(', ');
  if (f.type === 'date') { const s = String(v).slice(0, 10); return `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; }
  if (f.type === 'datetime') return new Date(v).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (f.type === 'pct') return `${v}%`;
  if (f.type === 'num') return Number(v).toLocaleString('es-AR', { maximumFractionDigits: 1 });
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export async function render(el) {
  let ls = {};
  try { ls = JSON.parse(localStorage.getItem(LS) || '{}'); } catch { /* */ }
  const ui = { sources: ['ticket', 'project'], mode: 'union', cols: [], filters: {}, group: '', sort: null, period: '90', ...structuredClone(PRESETS[0].config), ...structuredClone(ls.config || {}), q: '', fq: '' };
  if (!MODES[ui.mode]) ui.mode = 'union';
  if (!PERIODS[ui.period]) ui.period = '90';
  let current = ls.view || 'p1';
  let views = [];
  let data = null;
  let loadedKey = '';
  let F = catalog([]);

  el.innerHTML = `<div class="rp-card">
    <div class="rp-bar">
      <label class="lbl">Vista <select class="input sm" data-viewsel style="max-width:260px"></select></label><span data-vshared></span>
      <span class="sep"></span>
      <input class="input sm" data-q placeholder="Buscar en la grilla…" style="width:200px">
      <label class="lbl">Agrupar <select class="input sm" data-group></select></label>
      <label class="lbl">Período <select class="input sm" data-period title="Se aplica a los tickets (por fecha de creación) y a las horas">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <span class="grow"></span>
      <span class="rp-maxhint">Esc para salir</span>
      <button class="btn sm" data-act="save">${icon('save', 14)} Guardar</button>
      <button class="btn sm" data-act="saveas">Guardar como…</button>
      <button class="btn sm" data-act="csv">${icon('download', 14)} Excel / CSV</button>
      ${maxButton()}
    </div>
    <div class="rp-body"><div class="ex-wrap">
      <div class="ex-side">
        <div class="ex-sec"><div class="lbl" style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase">Datos</div><div class="ex-src" data-srcs></div>
          <label class="small muted" style="display:flex;gap:6px;align-items:center">Combinar <select class="input sm" data-mode style="flex:1">${Object.entries(MODES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>
        <div class="ex-sec" style="padding-bottom:8px"><input class="input sm" data-fq placeholder="Buscar campo… (ej. SLA, área, horas)"></div>
        <div class="ex-fields" data-fields></div>
      </div>
      <div class="ex-main">
        <div class="ex-cols" data-cols></div>
        <div data-note></div>
        <div class="ex-tbl" data-tbl><div class="loading"><span class="spinner"></span></div></div>
      </div>
    </div></div>
  </div>`;
  const $ = (s) => el.querySelector(s);

  const persist = () => { try { localStorage.setItem(LS, JSON.stringify({ view: current, config: config() })); } catch { /* */ } };
  const config = () => ({ sources: ui.sources, mode: ui.mode, cols: ui.cols, filters: ui.filters, group: ui.group, sort: ui.sort, period: ui.period });
  const allowed = () => (ui.mode === 'union' ? ui.sources : RELATED[ui.mode]);
  const periodRange = () => {
    const t = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    if (ui.period === 'all') return {};
    if (ui.period === 'year') return { from: `${t.getFullYear()}-01-01`, to: iso(t) };
    return { from: iso(new Date(Date.now() - Number(ui.period) * 864e5)), to: iso(t) };
  };

  async function fetchData() {
    const need = [...new Set(allowed())];
    const { from, to } = periodRange();
    const key = `${need.sort().join(',')}|${from || ''}|${to || ''}`;
    if (key === loadedKey) return;
    $('[data-tbl]').innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    data = await api(`/reports/explorer?sources=${need.join(',')}${from ? `&from=${from}&to=${to}` : ''}`);
    loadedKey = key;
    const custom = new Set();
    for (const t of data.ticket || []) for (const k of Object.keys(t.custom || {})) custom.add(k);
    F = catalog([...custom].sort());
    ui.cols = ui.cols.filter((k) => F[k]);
  }

  function items() {
    if (ui.mode === 'union') return ui.sources.flatMap((s) => (data[s] || []).map((r) => ({ s, r, rel: {} })));
    const projects = new Map((data.project || []).map((p) => [p.key, p]));
    if (ui.mode === 'join:task') return (data.task || []).map((r) => ({ s: 'task', r, rel: { project: projects.get(r.project) } }));
    const contacts = new Map((data.contact || []).map((c) => [String(c.email).toLowerCase(), c]));
    return (data.ticket || []).map((r) => ({ s: 'ticket', r, rel: { project: projects.get((r.projects || [])[0]), contact: contacts.get(String(r.contact_email || '').toLowerCase()) } }));
  }
  function val(f, it) {
    if (f.common) { const g = f.map[it.s]; return g ? g(it.r) : null; }
    if (f.s === it.s) return f.get(it.r);
    const rel = it.rel[f.s];
    return rel ? f.get(rel) : null;
  }
  function matches(f, it, text) {
    const v = val(f, it);
    const t = text.trim().toLowerCase();
    if (!t) return true;
    if ((f.type === 'num' || f.type === 'pct') && /^[<>]=?\s*-?\d/.test(t)) {
      const n = Number(t.replace(/^[<>]=?\s*/, '').replace(',', '.'));
      if (v === null || v === undefined) return false;
      return t.startsWith('>=') ? v >= n : t.startsWith('<=') ? v <= n : t.startsWith('>') ? v > n : v < n;
    }
    return fmt(f, v).toLowerCase().includes(t);
  }
  function rowsFiltered() {
    const cols = ui.cols.map((k) => F[k]);
    let list = items();
    for (const [k, text] of Object.entries(ui.filters)) if (F[k] && text) list = list.filter((it) => matches(F[k], it, text));
    if (ui.q) { const t = ui.q.toLowerCase(); list = list.filter((it) => cols.some((f) => fmt(f, val(f, it)).toLowerCase().includes(t))); }
    if (ui.sort && F[ui.sort.k]) {
      const f = F[ui.sort.k];
      const key = (it) => { const v = val(f, it); return v === null || v === undefined || v === '' ? null : Array.isArray(v) ? v.join(', ') : v; };
      list = list.map((it) => [key(it), it]).sort((a, b) => {
        if (a[0] === null) return 1;
        if (b[0] === null) return -1;
        const r = typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]), 'es', { numeric: true });
        return r * ui.sort.dir;
      }).map((x) => x[1]);
    }
    return list;
  }

  function drawSide() {
    $('[data-srcs]').innerHTML = Object.entries(SRC).map(([k, [l, c]]) => {
      const dis = ui.mode !== 'union' && !RELATED[ui.mode].includes(k);
      const on = allowed().includes(k);
      return `<label class="${on ? 'on' : ''} ${dis ? 'dis' : ''}" style="--c:${c}" title="${dis ? 'No se relaciona en este modo' : ''}"><input type="checkbox" data-s="${k}" ${on ? 'checked' : ''} ${dis || ui.mode !== 'union' ? 'disabled' : ''}>${on ? '✓ ' : ''}${l}</label>`;
    }).join('');
    $('[data-mode]').value = ui.mode;
    $('[data-period]').value = ui.period;
    const fq = ui.fq.trim().toLowerCase();
    const ok = (f) => !fq || f.l.toLowerCase().includes(fq) || (f.note || '').toLowerCase().includes(fq);
    const row = (f) => {
      const dis = !f.common && !allowed().includes(f.s);
      const blocked = dis && ui.mode !== 'union';
      return `<label class="ex-f ${dis ? 'dis' : ''}" title="${esc(f.note || (blocked ? 'No se relaciona en este modo' : dis ? 'Al tildarlo se suma este tipo de dato' : ''))}"><input type="checkbox" data-f="${esc(f.k)}" ${ui.cols.includes(f.k) ? 'checked' : ''} ${blocked ? 'disabled' : ''}>${esc(f.l)}${f.custom ? ' <span class="pill">personalizado</span>' : ''}${f.common ? '<small>todos</small>' : ''}</label>`;
    };
    const groups = [['Campos comunes', '#141821', Object.values(F).filter((f) => f.common)], ...Object.entries(SRC).map(([k, [l, c]]) => [l, c, Object.values(F).filter((f) => f.s === k)])];
    $('[data-fields]').innerHTML = groups.map(([l, c, fs]) => {
      const m = fs.filter(ok);
      if (!m.length) return '';
      const sel = m.filter((f) => ui.cols.includes(f.k)).length;
      return `<details class="ex-fg" ${fq || sel || l === 'Campos comunes' ? 'open' : ''}><summary><span class="ex-dot" style="background:${c}"></span>${esc(l)}<em>${sel}/${m.length}</em></summary>${m.map(row).join('')}</details>`;
    }).join('') || '<p class="small muted" style="padding:8px">Ningún campo con ese nombre.</p>';
    const own = views.filter((v) => v.owner_id === state.me.id);
    const others = views.filter((v) => v.owner_id !== state.me.id);
    const opt = (v, extra = '') => `<option value="${esc(v.id)}" ${String(current) === String(v.id) ? 'selected' : ''}>${esc(v.name)}${extra}</option>`;
    $('[data-viewsel]').innerHTML = `${current ? '' : '<option value="" selected>Vista sin guardar</option>'}<optgroup label="Sugeridas">${PRESETS.map((p) => opt(p)).join('')}</optgroup>`
      + (own.length ? `<optgroup label="Mis vistas">${own.map((v) => opt(v, v.shared ? ' (compartida)' : '')).join('')}</optgroup>` : '')
      + (others.length ? `<optgroup label="Compartidas por otros">${others.map((v) => opt(v, ` · ${v.owner_name || ''}`)).join('')}</optgroup>` : '');
    const cv = currentView();
    $('[data-vshared]').innerHTML = cv?.shared ? '<span class="pill">compartida</span>' : '';
    const canEdit = cv && !String(cv.id).startsWith('p') && (cv.owner_id === state.me.id || ['admin', 'superadmin'].includes(state.me.role));
    el.querySelector('[data-act=save]').disabled = !canEdit;
    const del = el.querySelector('[data-act=delview]');
    if (del) del.disabled = !canEdit;
  }
  const currentView = () => PRESETS.find((p) => p.id === current) || views.find((v) => String(v.id) === String(current)) || null;

  function drawGrid() {
    persist();
    const cols = ui.cols.map((k) => F[k]).filter(Boolean);
    $('[data-cols]').innerHTML = `<span class="small muted">Columnas:</span>${cols.map((f) => `<span class="ex-chip" draggable="true" data-c="${esc(f.k)}">${f.common ? '' : `<span class="ex-dot" style="background:${SRC[f.s][1]}"></span>`}${esc(f.l)}<button data-rm="${esc(f.k)}" title="Quitar" aria-label="Quitar ${esc(f.l)}">×</button></span>`).join('') || '<span class="small muted">elegí campos a la izquierda</span>'}${cols.length > 1 ? '<span class="small muted">· arrastrá para reordenar</span>' : ''}${Object.entries(ui.filters).filter(([k, t]) => t && F[k] && !ui.cols.includes(k)).map(([k, t]) => `<span class="ex-chip" style="cursor:default;background:#fff8e6;border-color:#f6dc9c">${icon('filter', 12)} ${esc(F[k].l)}: ${esc(t)}<button data-unfilter="${esc(k)}" title="Quitar filtro" aria-label="Quitar filtro ${esc(F[k].l)}">×</button></span>`).join('')}`;
    const mapped = cols.filter((f) => f.common && f.note);
    const trunc = Object.entries(data.truncated || {}).map(([s, n]) => `${SRC[s][0]}: se muestran los ${data.cap} más recientes de ${n}`);
    $('[data-note]').innerHTML = (ui.mode !== 'union' ? `<div class="ex-note"><b>${esc(MODES[ui.mode])}:</b> una fila por ${ui.mode === 'join:ticket' ? 'ticket, con los datos de su proyecto vinculado (el primero, si tiene varios) y de su contacto' : 'tarea, con los datos de su proyecto'}. Vacío cuando no hay relación.</div>`
      : mapped.length && ui.sources.length > 1 ? `<div class="ex-note"><b>Campos comunes:</b> ${mapped.map((f) => `<b>${esc(f.l)}</b> = ${esc(f.note)}`).join(' · ')}</div>` : '')
      + (trunc.length ? `<div class="ex-note" style="background:#fff8e6;border-color:#f6dc9c">${esc(trunc.join(' · '))}. Acotá el período para ver todo.</div>` : '');
    $('[data-group]').innerHTML = `<option value="">Sin agrupar</option>${cols.map((f) => `<option value="${esc(f.k)}" ${ui.group === f.k ? 'selected' : ''}>${esc(f.l)}</option>`).join('')}`;
    if (!cols.length) { $('[data-tbl]').innerHTML = '<div class="empty" style="padding:40px">Elegí los campos que querés ver.</div>'; return; }
    const list = rowsFiltered();
    const srcLabel = (f) => (f.common ? (ui.mode === 'union' && ui.sources.length > 1 ? 'común' : '') : SRC[f.s][0]);
    const head = `<thead><tr>${cols.map((f) => `<th data-sort="${esc(f.k)}" title="Ordenar">${esc(f.l)} ${ui.sort?.k === f.k ? (ui.sort.dir > 0 ? '▲' : '▼') : ''}<small>${esc(srcLabel(f))}</small></th>`).join('')}</tr>
      <tr class="flt">${cols.map((f) => `<th><input data-flt="${esc(f.k)}" value="${esc(ui.filters[f.k] || '')}" placeholder="${f.type === 'num' || f.type === 'pct' ? 'ej. >5' : f.type === 'bool' ? 'sí / no' : 'filtrar'}" aria-label="Filtrar ${esc(f.l)}"></th>`).join('')}</tr></thead>`;
    const cell = (f, it) => {
      const v = val(f, it);
      const t = fmt(f, v);
      if (!t) return '<td class="na">—</td>';
      const num = f.type === 'num' || f.type === 'pct' ? ' class="num"' : '';
      if (f.k === 'c.type') return `<td><span class="badge" style="--c:${SRC[it.s][1]}">${esc(t)}</span></td>`;
      if (f.type === 'pct') return `<td class="num"><span style="display:inline-block;width:56px;height:6px;background:var(--line-2);border-radius:4px;vertical-align:middle;margin-right:6px"><i style="display:block;height:100%;width:${Math.max(0, Math.min(100, v))}%;background:var(--brand);border-radius:4px"></i></span>${esc(t)}</td>`;
      const link = f.k === 'c.id' || f.k === 'ticket.number' || f.k === 'project.key' || f.k === 'task.key' ? linkOf(f, it) : '';
      return `<td${num} title="${esc(t)}">${link ? `<a href="${link}">${esc(t)}</a>` : esc(t)}</td>`;
    };
    const totals = (rows) => cols.map((f, i) => {
      if (f.agg === 'sum') { const s = rows.reduce((a, it) => a + (Number(val(f, it)) || 0), 0); return `<td class="num">${s.toLocaleString('es-AR', { maximumFractionDigits: 1 })}</td>`; }
      return i === 0 ? `<td>${rows.length.toLocaleString('es-AR')} ${rows.length === 1 ? 'fila' : 'filas'}</td>` : '<td></td>';
    }).join('');
    let body = '';
    let shown = 0;
    if (ui.group && F[ui.group]) {
      const g = F[ui.group];
      const groups = new Map();
      for (const it of list) { const k = fmt(g, val(g, it)) || '(vacío)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
      for (const [k, rows] of groups) {
        body += `<tr class="gr"><td colspan="${cols.length}">${esc(g.l)}: ${esc(k)} <span class="muted">· ${rows.length}</span>${cols.some((f) => f.agg) ? ` <span class="muted">· ${cols.filter((f) => f.agg).map((f) => `${esc(f.l)}: ${rows.reduce((a, it) => a + (Number(val(f, it)) || 0), 0).toLocaleString('es-AR', { maximumFractionDigits: 1 })}`).join(' · ')}</span>` : ''}</td></tr>`;
        for (const it of rows) { if (shown >= ROW_LIMIT) break; body += `<tr>${cols.map((f) => cell(f, it)).join('')}</tr>`; shown += 1; }
      }
    } else for (const it of list.slice(0, ROW_LIMIT)) { body += `<tr>${cols.map((f) => cell(f, it)).join('')}</tr>`; shown += 1; }
    const more = list.length > shown ? `<tr><td colspan="${cols.length}" class="muted small">Se muestran ${shown.toLocaleString('es-AR')} de ${list.length.toLocaleString('es-AR')} filas. Filtrá o exportá a Excel para ver todas.</td></tr>` : '';
    const empty = !list.length ? `<tr><td colspan="${cols.length}" class="muted" style="padding:24px">Ninguna fila con estos filtros.</td></tr>` : '';
    const active = document.activeElement?.dataset?.flt;
    const pos = document.activeElement?.selectionStart;
    $('[data-tbl]').innerHTML = `<table class="ex-g">${head}<tbody>${body}${more}${empty}</tbody><tfoot><tr>${totals(list)}</tr></tfoot></table>`;
    if (active) { const inp = el.querySelector(`[data-flt="${CSS.escape(active)}"]`); if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { /* */ } } }
  }
  const linkOf = (f, it) => {
    const r = f.common ? it.r : f.s === it.s ? it.r : it.rel[f.s];
    const s = f.common ? it.s : f.s;
    if (!r) return '';
    if (s === 'ticket') return `#/tickets/${r.number}`;
    if (s === 'project') return `#/projects/${encodeURIComponent(r.key)}`;
    if (s === 'task') return `#/issue/${encodeURIComponent(r.key)}`;
    if (s === 'time') return r.ticket ? `#/tickets/${r.ticket}` : r.issue ? `#/issue/${encodeURIComponent(r.issue)}` : '';
    return '';
  };

  async function refresh() {
    try { await fetchData(); } catch (e) { $('[data-tbl]').innerHTML = `<div class="empty" style="padding:40px">${esc(e.message)}</div>`; return; }
    drawSide();
    drawGrid();
  }

  function applyView(id) {
    const v = PRESETS.find((p) => p.id === id) || views.find((x) => String(x.id) === String(id));
    if (!v) return;
    current = v.id;
    const c = v.config || {};
    Object.assign(ui, { sources: c.sources?.length ? c.sources : ['ticket'], mode: MODES[c.mode] ? c.mode : 'union', cols: [...(c.cols || [])], filters: { ...(c.filters || {}) }, group: c.group || '', sort: c.sort || null, period: PERIODS[c.period] ? c.period : '90' });
    refresh();
  }

  function saveDialog() {
    const cv = currentView();
    const md = modal({
      title: 'Guardar vista',
      body: `<label class="field"><span>Nombre</span><input class="input" name="name" maxlength="120" value="${esc(cv && !String(cv.id).startsWith('p') ? `${cv.name} (copia)` : '')}" placeholder="ej. Tickets de Siniestros con su proyecto"></label>
        <label class="check"><input type="checkbox" name="shared"> Compartir con los demás supervisores</label>`,
      footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>',
    });
    md.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const name = md.el.querySelector('[name=name]').value.trim();
      if (!name) return toast('Poné un nombre', 'error');
      try {
        const v = await api('/reports/views', { method: 'POST', body: { name, shared: md.el.querySelector('[name=shared]').checked, config: config() } });
        views = await api('/reports/views');
        current = v.id;
        md.close();
        toast('Vista guardada');
        drawSide();
        persist();
      } catch (e) { toastError(e); }
    });
  }

  el.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { ui.cols = ui.cols.filter((k) => k !== rm.dataset.rm); delete ui.filters[rm.dataset.rm]; if (ui.group === rm.dataset.rm) ui.group = ''; drawSide(); return drawGrid(); }
    const uf = e.target.closest('[data-unfilter]');
    if (uf) { delete ui.filters[uf.dataset.unfilter]; return drawGrid(); }
    const th = e.target.closest('[data-sort]');
    if (th) { const k = th.dataset.sort; ui.sort = { k, dir: ui.sort?.k === k ? -ui.sort.dir : 1 }; return drawGrid(); }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'saveas') saveDialog();
    if (a === 'save') {
      const cv = currentView();
      if (!cv || String(cv.id).startsWith('p')) return saveDialog();
      try { await api(`/reports/views/${cv.id}`, { method: 'PUT', body: { name: cv.name, shared: cv.shared, config: config() } }); views = await api('/reports/views'); toast('Vista actualizada'); drawSide(); } catch (err) { toastError(err); }
    }
    if (a === 'delview') {
      const cv = currentView();
      if (!cv || String(cv.id).startsWith('p')) return;
      if (!(await confirmDialog(`¿Eliminar la vista "${cv.name}"?`, { title: 'Eliminar vista', okText: 'Eliminar', danger: true }))) return;
      try { await api(`/reports/views/${cv.id}`, { method: 'DELETE' }); views = await api('/reports/views'); applyView('p1'); } catch (err) { toastError(err); }
    }
    if (a === 'csv') exportCsv();
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.s) { const s = t.dataset.s; ui.sources = t.checked ? [...new Set([...ui.sources, s])] : ui.sources.filter((x) => x !== s); if (!ui.sources.length) ui.sources = [s]; return refresh(); }
    if (t.dataset.f) {
      const k = t.dataset.f;
      if (t.checked) { ui.cols.push(k); if (F[k].s && ui.mode === 'union' && !ui.sources.includes(F[k].s)) { ui.sources.push(F[k].s); return refresh(); } } else { ui.cols = ui.cols.filter((x) => x !== k); delete ui.filters[k]; }
      drawSide();
      return drawGrid();
    }
    if (t.matches('[data-mode]')) {
      ui.mode = t.value;
      if (ui.mode !== 'union') ui.sources = [...RELATED[ui.mode]];
      ui.cols = ui.cols.filter((k) => F[k] && (F[k].common ? ui.mode === 'union' || F[k].map[RELATED[ui.mode]?.[0]] : allowed().includes(F[k].s)));
      return refresh();
    }
    if (t.matches('[data-viewsel]')) { if (t.value) applyView(t.value); return; }
    if (t.matches('[data-group]')) { ui.group = t.value; return drawGrid(); }
    if (t.matches('[data-period]')) { ui.period = t.value; return refresh(); }
  });
  let qTimer;
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-q]')) { ui.q = t.value; clearTimeout(qTimer); qTimer = setTimeout(drawGrid, 200); }
    if (t.matches('[data-fq]')) { ui.fq = t.value; drawSide(); }
    if (t.dataset.flt) { ui.filters[t.dataset.flt] = t.value; if (!t.value) delete ui.filters[t.dataset.flt]; clearTimeout(qTimer); qTimer = setTimeout(drawGrid, 250); }
  });
  // Reordenar columnas arrastrando
  let dragK = null;
  el.addEventListener('dragstart', (e) => { dragK = e.target.closest?.('[data-c]')?.dataset.c || null; });
  el.addEventListener('dragover', (e) => { if (dragK && e.target.closest('[data-c]')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    const to = e.target.closest('[data-c]')?.dataset.c;
    if (!dragK || !to || to === dragK) return;
    e.preventDefault();
    const a = ui.cols.filter((x) => x !== dragK);
    a.splice(a.indexOf(to), 0, dragK);
    ui.cols = a;
    dragK = null;
    drawGrid();
  });

  function exportCsv() {
    const cols = ui.cols.map((k) => F[k]).filter(Boolean);
    if (!cols.length) return toast('Elegí al menos una columna', 'error');
    const list = rowsFiltered();
    const safe = (c) => { const t = String(c ?? ''); const s = /^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t) ? `'${t}` : t; return `"${s.replace(/"/g, '""')}"`; };
    const csv = '﻿' + [cols.map((f) => f.l), ...list.map((it) => cols.map((f) => fmt(f, val(f, it))))].map((r) => r.map(safe).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${(currentView()?.name || 'explorador').replace(/[^\p{L}\d]+/gu, '-').toLowerCase()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  try { views = await api('/reports/views'); } catch { views = []; }
  if (!currentView()) current = null;
  // Botón para borrar la vista propia
  el.querySelector('[data-act=saveas]').insertAdjacentHTML('afterend', `<button class="btn sm" data-act="delview" title="Eliminar la vista">${icon('trash', 14)}</button>`);
  await refresh();
}
