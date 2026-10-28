// Formulario de alta de proyecto (también para convertir un ticket): tipo, etapas y datos del portfolio.
import { state, api, esc, icon, toast, toastError, modal, options, newKey, PRIORITY, dmy, guardDates, businessDays, dayHours, fmtNum } from '../core.js';

export const PSTATUS = { planned: 'No iniciado', active: 'En curso', paused: 'En pausa', done: 'Finalizado', cancelled: 'Cancelado' };
export const PSTATUS_COLOR = { planned: '#64748b', active: '#2563eb', paused: '#d97706', done: '#059669', cancelled: '#9ca3af' };
export const WORKFLOW_LABEL = {
  scrum: 'Por hacer → En curso → En revisión → Hecho',
  kanban: 'Kanban: Pendiente → En curso → Hecho',
  dev: 'Backlog → Análisis → Desarrollo → Testing → Producción',
  simple: 'Simple: Pendiente → En curso → Hecho',
};

export function suggestKey(name) {
  const words = String(name || '').normalize('NFD').replace(/[^\w\s]/g, '').trim().split(/\s+/).filter((w) => w.length > 2 || /\d/.test(w));
  const k = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || '').slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return /^[A-Z]/.test(k) ? k : `P${k}`.slice(0, 6);
}

const activeTypes = () => (state.meta.projectTypes || []).filter((t) => t.active);
const defaultType = () => activeTypes().find((t) => t.is_default) || activeTypes()[0] || null;

/**
 * Problemas de fechas de las etapas (mismas reglas que el servidor):
 * errores (bloquean): una etapa que termina antes de empezar, o una etapa posterior que termina antes de que empiece una anterior;
 * avisos (no bloquean): una etapa que cae fuera de las fechas del proyecto.
 */
export function phaseDateIssues(phases, { start = null, end = null } = {}) {
  const errors = [];
  const warnings = [];
  phases.forEach((f, j) => {
    const name = f.name?.trim() || `Etapa ${j + 1}`;
    if (f.start_date && f.due_date && f.due_date < f.start_date) {
      errors.push({ i: j, field: 'due_date', text: `"${name}" termina (${dmy(f.due_date)}) antes de empezar (${dmy(f.start_date)})` });
      return;
    }
    if (f.due_date) {
      const prev = phases.slice(0, j).findIndex((x) => x.start_date && f.due_date < x.start_date);
      if (prev >= 0) errors.push({ i: j, field: 'due_date', text: `"${name}" termina (${dmy(f.due_date)}) antes de que empiece "${phases[prev].name?.trim() || `Etapa ${prev + 1}`}" (${dmy(phases[prev].start_date)})` });
    }
    if (start && f.start_date && f.start_date < start) warnings.push({ i: j, field: 'start_date', text: `"${name}" empieza antes que el proyecto (${dmy(start)})` });
    if (end && f.due_date && f.due_date > end) warnings.push({ i: j, field: 'due_date', text: `"${name}" termina después que el proyecto (${dmy(end)})` });
  });
  return { errors, warnings };
}

/**
 * Reparte el período entre las etapas sin fecha, igual que el servidor (spreadPhaseDates): partes iguales entre
 * el inicio de la primera y el fin de la última; respeta las fechas cargadas a mano. Devuelve los campos que completó.
 */
export function spreadPhases(list, { start: pStart = null, end: pEnd = null } = {}) {
  const filled = [];
  if (!list.length) return filled;
  const set = (f, k, v) => { f[k] = v; filled.push([f, k]); };
  if (pStart && !list[0].start_date) set(list[0], 'start_date', pStart);
  if (pEnd && !list[list.length - 1].due_date) set(list[list.length - 1], 'due_date', pEnd);
  const s0 = list[0].start_date;
  const e0 = list[list.length - 1].due_date;
  if (!s0 || !e0) return filled;
  const day = 86400000;
  const start = Date.parse(`${s0}T12:00:00Z`);
  const end = Date.parse(`${e0}T12:00:00Z`);
  if (!(end > start)) return filled;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const span = Math.round((end - start) / day) + 1;
  const n = list.length;
  list.forEach((f, i) => {
    const s = start + Math.floor((span * i) / n) * day;
    const e = start + (Math.floor((span * (i + 1)) / n) - 1) * day;
    if (!f.start_date) set(f, 'start_date', iso(s));
    if (!f.due_date) set(f, 'due_date', iso(e < s ? s : e));
  });
  return filled;
}

/**
 * Editor de etapas: se cargan las del tipo; se pueden destildar, renombrar, ordenar o agregar propias.
 * Las fechas que no se cargan a mano se calculan solas (se ven en gris) a partir del inicio de la primera
 * etapa y el fin de la última. requireDates: esas dos son obligatorias.
 */
export function phaseEditor(host, initial = [], { range = () => ({}), fallback = () => ({}), requireDates = false, onChange = () => {} } = {}) {
  let phases = initial.map((p) => ({ on: true, auto: {}, ...p }));
  let showMissing = false; // las fechas faltantes se marcan recién después del primer intento de guardar
  // Solo cuentan las etapas incluidas y con nombre (las mismas que se envían)
  const active = () => phases.map((f, i) => ({ f, idx: i })).filter((x) => x.f.on && String(x.f.name || '').trim());
  // Recalcula las fechas automáticas (borra las calculadas antes y vuelve a repartir)
  const autofill = () => {
    for (const f of phases) {
      for (const k of ['start_date', 'due_date']) if (f.auto?.[k]) { f[k] = ''; f.auto[k] = false; }
    }
    const act = active().map((x) => x.f);
    for (const [f, k] of spreadPhases(act, fallback())) { f.auto = f.auto || {}; f.auto[k] = true; }
    // Encadena las calculadas con las cargadas a mano: una etapa calculada arranca el día después de que termina la anterior
    // y termina el día antes de que empieza la siguiente (si eso no la deja al revés)
    const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    act.forEach((f, i) => {
      const prev = act[i - 1];
      const next = act[i + 1];
      if (f.auto?.start_date && prev?.due_date) { const v = shift(prev.due_date, 1); if (!f.due_date || v <= f.due_date) f.start_date = v; }
      if (f.auto?.due_date && next?.start_date && !next.auto?.start_date) { const v = shift(next.start_date, -1); if (!f.start_date || v >= f.start_date) f.due_date = v; }
    });
    phases.forEach((f, i) => {
      const r = host.querySelector(`.phase-row[data-i="${i}"]`);
      if (!r) return;
      for (const k of ['start_date', 'due_date']) {
        const el = r.querySelector(`[data-p=${k}]`);
        if (el !== document.activeElement || f.auto?.[k]) el.value = f[k] || '';
        el.classList.toggle('auto', Boolean(f.auto?.[k]));
        el.title = f.auto?.[k] ? 'Calculada: la podés cambiar' : k === 'start_date' ? 'Inicio' : 'Fin';
      }
    });
  };
  // Marca en rojo/amarillo las fechas con problemas y explica debajo (sin redibujar: no se pierde el foco)
  const validate = ({ strict = false } = {}) => {
    if (strict) showMissing = true;
    const actX = active();
    const act = actX.map((x) => ({ ...x.f, idx: x.idx }));
    const { errors, warnings } = phaseDateIssues(act, range());
    if (requireDates && act.length) {
      const missing = [];
      const first = act[0];
      const last = act[act.length - 1];
      if (!first.start_date) missing.push({ i: 0, field: 'start_date', text: `Falta la fecha de inicio de la primera etapa ("${first.name.trim()}")` });
      if (!last.due_date) missing.push({ i: act.length - 1, field: 'due_date', text: `Falta la fecha de fin de la última etapa ("${last.name.trim()}")` });
      if (missing.length) {
        if (showMissing) errors.unshift(...missing);
        else errors.unshift({ i: -1, hidden: true, text: missing[0].text });
      }
    }
    host.querySelectorAll('.phase-row input[type=date]').forEach((el) => { el.classList.remove('invalid', 'warn', 'required-mark'); el.removeAttribute('aria-invalid'); });
    if (requireDates && act.length) {
      host.querySelector(`.phase-row[data-i="${act[0].idx}"] [data-p=start_date]`)?.classList.add('required-mark');
      host.querySelector(`.phase-row[data-i="${act[act.length - 1].idx}"] [data-p=due_date]`)?.classList.add('required-mark');
    }
    for (const [list, cls] of [[warnings, 'warn'], [errors, 'invalid']]) {
      for (const x of list) {
        if (x.hidden) continue;
        const el = host.querySelector(`.phase-row[data-i="${act[x.i].idx}"] [data-p=${x.field}]`);
        if (el) { el.classList.remove('warn'); el.classList.add(cls); if (cls === 'invalid') el.setAttribute('aria-invalid', 'true'); }
      }
    }
    // Calendario: el fin de cada etapa no puede ser anterior a su inicio
    phases.forEach((f, i) => {
      const r = host.querySelector(`.phase-row[data-i="${i}"]`);
      if (!r) return;
      r.querySelector('[data-p=due_date]').min = f.start_date || '';
      r.querySelector('[data-p=start_date]').max = f.due_date || '';
    });
    const box = host.querySelector('.phase-msg');
    box.innerHTML = [...errors.filter((x) => !x.hidden).map((x) => `<div class="date-warn">${icon('alert', 13)} ${esc(x.text)}</div>`),
      ...warnings.map((x) => `<div class="date-warn soft">${icon('alert', 13)} ${esc(x.text)}</div>`)].join('');
    return errors;
  };
  const refresh = () => { autofill(); validate(); };
  const draw = () => {
    host.innerHTML = `${phases.map((f, i) => `<div class="phase-row ${f.on ? '' : 'off'}" data-i="${i}">
      <label class="ph-check" title="Incluir esta etapa"><input type="checkbox" data-p="on" ${f.on ? 'checked' : ''}><span class="ph-num">${i + 1}</span></label>
      <input class="input sm grow" data-p="name" value="${esc(f.name)}" placeholder="Nombre de la etapa" ${f.on ? '' : 'disabled'}>
      <input class="input sm" type="date" data-p="start_date" value="${esc(f.start_date || '')}" aria-label="Inicio de la etapa ${i + 1}" ${f.on ? '' : 'disabled'}>
      <input class="input sm" type="date" data-p="due_date" value="${esc(f.due_date || '')}" aria-label="Fin de la etapa ${i + 1}" ${f.on ? '' : 'disabled'}>
      <button type="button" class="icon-btn sm" data-up ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('up', 13)}</button>
      <button type="button" class="icon-btn sm" data-rm aria-label="Quitar">${icon('x', 13)}</button></div>`).join('')
      || '<p class="muted small">Sin etapas. Agregá al menos una.</p>'}<div class="phase-msg" aria-live="polite"></div>`;
    refresh();
  };
  const onEdit = (e) => {
    const r = e.target.closest('.phase-row');
    if (!r || !e.target.dataset.p) return;
    const f = phases[r.dataset.i];
    const k = e.target.dataset.p;
    if (k === 'on') { f.on = e.target.checked; draw(); onChange(); return; }
    if (e.type === 'change' && f[k] === e.target.value && !(f.auto?.[k])) return;
    f[k] = e.target.value;
    if (e.target.type === 'date') { f.auto = f.auto || {}; f.auto[k] = false; } // escrita a mano: ya no se recalcula
    refresh();
    onChange();
  };
  host.addEventListener('input', onEdit);
  host.addEventListener('change', onEdit);
  host.addEventListener('click', (e) => {
    const r = e.target.closest('.phase-row');
    if (!r) return;
    const i = Number(r.dataset.i);
    if (e.target.closest('[data-rm]')) { phases.splice(i, 1); draw(); onChange(); }
    if (e.target.closest('[data-up]') && i > 0) { [phases[i - 1], phases[i]] = [phases[i], phases[i - 1]]; draw(); onChange(); }
  });
  draw();
  return {
    set(list) { phases = list.map((p) => ({ on: true, auto: {}, ...(typeof p === 'string' ? { name: p } : p) })); showMissing = false; draw(); onChange(); },
    add() { phases.push({ on: true, auto: {}, name: '' }); draw(); [...host.querySelectorAll('.phase-row [data-p=name]')].pop()?.focus(); },
    validate,
    refresh,
    /** Primer inicio y último fin de las etapas incluidas (para las fechas del proyecto). */
    span: () => {
      const act = active().map((x) => x.f);
      const starts = act.map((f) => f.start_date).filter(Boolean).sort();
      const ends = act.map((f) => f.due_date).filter(Boolean).sort();
      return { start: starts[0] || null, end: ends.pop() || null };
    },
    value: () => phases.filter((f) => f.on && String(f.name || '').trim()).map((f) => ({
      name: f.name.trim(), start_date: f.start_date || null, due_date: f.due_date || null,
    })),
  };
}

/** Campos del portfolio (origen, sector, área, prioridad, estado, fechas, horas). */
export function portfolioFieldsHtml(p = {}, { required = false, derived = false } = {}) {
  const m = state.meta;
  const d = (x) => (x ? String(x).slice(0, 10) : '');
  return `<div class="grid3">
    <label class="field"><span>Origen${required ? ' *' : ''}</span><select class="input" name="origin_id" ${required ? 'required' : ''}>${options(m.origins.filter((o) => o.active || o.id === p.origin_id), p.origin_id, { empty: '—' })}</select></label>
    <label class="field"><span>Sector IT${required ? ' *' : ''}</span><select class="input" name="sector_id" ${required ? 'required' : ''}>${options(m.sectors.filter((o) => o.active || o.id === p.sector_id), p.sector_id, { empty: '—' })}</select></label>
    <label class="field"><span>Área solicitante</span><select class="input" name="area_id">${options(m.categories.filter((o) => o.active || o.id === p.area_id), p.area_id, { empty: '—' })}</select></label>
    <label class="field"><span>Prioridad</span><select class="input" name="priority">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(p.priority || 2) === n ? 'selected' : ''}>${PRIORITY[n]}</option>`).join('')}</select></label>
    <label class="field"><span>Estado</span><select class="input" name="portfolio_status">${Object.entries(PSTATUS).map(([k, v]) => `<option value="${k}" ${(p.portfolio_status || 'active') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field"><span>Horas estimadas</span><input class="input" type="number" min="0" step="any" name="estimated_hours" value="${p.estimated_hours ?? ''}"><small class="hint" data-hours-hint></small></label>
    <label class="field"><span>Fecha de inicio</span><input class="input" type="date" name="start_date" value="${d(p.start_date)}" ${derived ? 'readonly tabindex="-1"' : ''}>${derived ? '<small class="hint">Primer inicio de las etapas</small>' : ''}</label>
    <label class="field"><span>Fecha de fin</span><input class="input" type="date" name="end_date" value="${d(p.end_date)}" ${derived ? 'readonly tabindex="-1"' : ''}>${derived ? '<small class="hint">Último fin de las etapas</small>' : ''}</label>
    <label class="check" style="align-self:end;margin-bottom:12px"><input type="checkbox" name="recurring" ${p.recurring ? 'checked' : ''}> Recurrente (sin fin)</label>
  </div>`;
}

export function readPortfolioFields(root) {
  const g = (n) => root.querySelector(`[name=${n}]`);
  const n = (x) => (x === '' || x === null || x === undefined ? null : Number(x));
  return {
    origin_id: n(g('origin_id').value), sector_id: n(g('sector_id').value), area_id: n(g('area_id').value), priority: Number(g('priority').value),
    portfolio_status: g('portfolio_status').value, estimated_hours: n(g('estimated_hours').value),
    start_date: g('start_date').value || null, end_date: g('end_date').value || null, recurring: g('recurring').checked,
  };
}

/**
 * Abre el formulario. Con ticket: convierte el ticket en proyecto (POST /tickets/:n/project); sin ticket: alta normal.
 * Devuelve una promesa con el proyecto creado (o null si se canceló).
 */
export function openProjectForm({ ticket = null, ruleText = '', canConfigure = false } = {}) {
  return new Promise((resolve) => {
    const types = activeTypes();
    let type = defaultType();
    const opKey = newKey();
    const users = state.meta.users.filter((u) => u.active);
    const md = modal({
      title: ticket ? `Convertir el ticket #${ticket.number} en proyecto` : 'Crear proyecto',
      wide: true,
      onClose: () => resolve(null),
      body: `${ticket ? '<p class="muted small" style="margin-bottom:12px">Se crea el proyecto con una épica por etapa, se copia la descripción del pedido y el ticket queda vinculado mostrando el avance.</p>' : ''}
      <div class="type-pick">${types.map((t) => `<button type="button" class="type-opt ${t.id === type?.id ? 'on' : ''}" data-type="${t.id}" style="--c:${esc(t.color)}">
        <b>${esc(t.name)}</b><small>${esc(t.description || (t.phases || []).join(' → '))}</small></button>`).join('')}</div>
      <div class="grid3">
        <label class="field" style="grid-column:span 2"><span>Nombre *</span><input class="input" name="name" value="${esc(ticket?.subject || '')}" placeholder="Ej. Nuevo CRM"></label>
        <label class="field"><span>Clave * <small class="muted">(prefijo de las tareas)</small></span><input class="input" name="key" maxlength="10" value="${esc(ticket ? suggestKey(ticket.subject) : '')}" placeholder="CRM" style="text-transform:uppercase"></label>
      </div>
      ${ticket ? '' : '<label class="field"><span>Descripción</span><textarea class="input" name="description" rows="2"></textarea></label>'}
      <div class="grid3">
        <label class="field"><span>Responsable</span><select class="input" name="lead_id">${options(users, ticket?.assignee_id || state.me.id)}</select></label>
        <label class="field"><span>Flujo de las tareas</span><select class="input" name="template">${Object.entries(WORKFLOW_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="field"><span>Color</span><input class="input" type="color" name="color" value="${esc(type?.color || '#C41230')}"></label>
      </div>
      <div class="field"><span>${ticket ? 'Etapas * <small class="muted">— obligatorias: el <b>inicio de la primera etapa</b> y el <b>fin de la última</b>. Las fechas del medio se reparten solas (en gris; las podés cambiar) y las del proyecto y las horas se calculan solas.</small>' : 'Etapas <small class="muted">— destildá las que no apliquen. Con el inicio de la primera etapa y el fin de la última, las del medio se reparten solas (en gris; las podés cambiar) y el proyecto toma esas fechas.</small>'}</span>
        <div class="phase-editor"></div>
        <button type="button" class="btn sm" data-addphase>${icon('plus', 13)} Agregar etapa</button>
      </div>
      <details class="pf-more" ${state.meta.canPortfolio || ticket ? 'open' : ''}><summary>Datos para el portfolio${ticket ? ' <small class="muted">(origen y sector IT obligatorios)</small>' : ''}</summary>${portfolioFieldsHtml({ area_id: ticket?.category_id || null, priority: ticket ? Math.max(2, Number(ticket.priority) || 2) : 2 }, { required: Boolean(ticket), derived: Boolean(ticket) })}</details>
      <label class="field"><span>Equipo <small class="muted">— el responsable se suma solo</small></span><select class="input" name="members" multiple size="4">${options(users, [ticket?.assignee_id].filter(Boolean))}</select></label>
      ${ticket ? `<div class="grid2">
        <div class="rule-info">${icon('zap', 15)}<span>Según las reglas de negocio, el ticket ${ruleText}.${canConfigure ? ' <a href="#/settings/dev" data-close>Configurar reglas</a>' : ''}</span></div>
        <label class="check" style="align-self:center"><input type="checkbox" name="notify_contact"> Avisar al solicitante que se gestiona como proyecto ${state.meta.mailEnabled ? '' : '<small class="muted">(queda en el ticket; correo no configurado)</small>'}</label>
      </div>` : ''}`,
      footer: `<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>${ticket ? 'Crear proyecto' : 'Crear'}</button>`,
    });
    const f = (n) => md.el.querySelector(`[name=${n}]`);
    const conversion = Boolean(ticket);
    const pfRange = () => ({ start: f('start_date')?.value || null, end: f('end_date')?.value || null });
    // Fechas del proyecto: salen de las etapas (al convertir, siempre; en el alta, hasta que se escriban a mano).
    // Horas: días hábiles × horas por día, hasta que se escriban a mano.
    let datesManual = false;
    let hoursManual = false;
    const hint = () => md.el.querySelector('[data-hours-hint]');
    const recalcHours = () => {
      const { start, end } = pfRange();
      const days = businessDays(start, end);
      const h = dayHours();
      if (!hoursManual) f('estimated_hours').value = days ? Math.round(days * h * 10) / 10 : '';
      hint().innerHTML = !days ? 'Se calculan con las fechas (días hábiles × horas por día)'
        : hoursManual ? `Cargadas a mano · el cálculo da ${fmtNum(days * h, 1)} h <button type="button" class="link-btn" data-hours-auto>Usar el cálculo</button>`
          : `${days} días hábiles × ${fmtNum(h, 1)} h por día`;
    };
    let datesOk = () => true;
    const sync = () => {
      if (!ed) return;
      if (conversion || !datesManual) {
        const { start, end } = ed.span();
        f('start_date').value = start || '';
        f('end_date').value = end || '';
      }
      datesOk();
      ed.validate();
      recalcHours();
    };
    let ed = null;
    // En el alta manual, si se escribieron a mano las fechas del proyecto, la primera y la última etapa las toman (como el servidor)
    const fallback = () => (!conversion && datesManual ? pfRange() : {});
    ed = phaseEditor(md.el.querySelector('.phase-editor'), (type?.phases || []).map((name) => ({ name })), { range: pfRange, fallback, requireDates: conversion, onChange: sync });
    datesOk = guardDates(f('start_date'), f('end_date'), 'El proyecto no puede terminar antes de empezar');
    for (const n of ['start_date', 'end_date']) {
      f(n).addEventListener('input', () => { datesManual = true; });
      f(n).addEventListener('change', () => { datesManual = true; ed.refresh(); recalcHours(); });
    }
    f('estimated_hours').addEventListener('input', () => { hoursManual = f('estimated_hours').value !== ''; recalcHours(); });
    md.el.addEventListener('click', (e) => { if (e.target.closest('[data-hours-auto]')) { hoursManual = false; recalcHours(); } });
    for (const n of ['origin_id', 'sector_id']) f(n).addEventListener('change', () => f(n).classList.toggle('invalid', conversion && !f(n).value));
    sync();
    const applyType = (t) => {
      type = t;
      md.el.querySelectorAll('.type-opt').forEach((b) => b.classList.toggle('on', Number(b.dataset.type) === t?.id));
      ed.set((t?.phases || []).map((name) => ({ name })));
      if (t) { f('template').value = t.workflow; f('color').value = t.color; }
    };
    if (type) f('template').value = type.workflow;
    md.el.querySelector('.type-pick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (b) applyType(types.find((t) => t.id === Number(b.dataset.type)));
    });
    md.el.querySelector('[data-addphase]').addEventListener('click', () => ed.add());
    f('name').addEventListener('input', () => { if (!f('key').dataset.touched) f('key').value = suggestKey(f('name').value); });
    f('key').addEventListener('input', () => { f('key').dataset.touched = '1'; });
    md.el.querySelector('[data-ok]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const phases = ed.value();
      if (!phases.length) return toast('Definí al menos una etapa', 'error');
      if (!f('name').value.trim()) return toast('El nombre es obligatorio', 'error');
      const pf = readPortfolioFields(md.el);
      if (!datesOk()) {
        md.el.querySelector('.pf-more').open = true;
        f('end_date').focus();
        return toast('La fecha de fin del proyecto no puede ser anterior a la de inicio', 'error');
      }
      const errs = ed.validate({ strict: true });
      if (errs.length) {
        md.el.querySelector('.phase-row input.invalid')?.focus();
        return toast(`Revisá las fechas de las etapas: ${errs[0].text}`, 'error');
      }
      if (conversion) {
        const miss = ['origin_id', 'sector_id'].filter((n) => !f(n).value);
        miss.forEach((n) => f(n).classList.add('invalid'));
        if (miss.length) {
          md.el.querySelector('.pf-more').open = true;
          f(miss[0]).focus();
          return toast(miss.length === 2 ? 'Elegí el origen y el sector IT del proyecto' : miss[0] === 'origin_id' ? 'Elegí el origen del proyecto' : 'Elegí el sector IT', 'error');
        }
      }
      btn.disabled = true;
      const body = {
        name: f('name').value.trim(), key: f('key').value.trim().toUpperCase(), lead_id: Number(f('lead_id').value) || null, template: f('template').value,
        color: f('color').value, type_id: type?.id || null, phases, member_ids: [...f('members').selectedOptions].map((o) => Number(o.value)),
      };
      try {
        let out;
        if (ticket) {
          out = await api(`/tickets/${ticket.number}/project`, { method: 'POST', idempotencyKey: opKey, body: { ...body, ...pf, notify_contact: f('notify_contact').checked } });
        } else {
          out = { project: await api('/projects', { method: 'POST', idempotencyKey: opKey, body: { ...body, ...pf, description: f('description').value } }) };
        }
        resolve({ ...out, phases: phases.length });
        md.close();
      } catch (er) { toastError(er); btn.disabled = false; }
    });
  });
}
