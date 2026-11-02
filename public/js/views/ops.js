// Operación de IT (v1.16): tareas que no son tickets ni proyectos. Agenda (vencidas, hoy, semana, próximas) y Rutinas.
import { state, api, esc, icon, avatar, toast, toastError, modal, navigate, buildQuery, userName, isManager, debounce, confirmDialog } from '../core.js';
import { setCrumbs } from '../app.js';

const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DOWL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const RESULT = { ok: 'Bien', obs: 'Con observaciones', fail: 'Falló' };
const LS = 'ops-filters';
const D = (s) => new Date(`${s}T00:00:00Z`);
const dd = (s) => `${DOW[D(s).getUTCDay()]} ${s.slice(8)}/${s.slice(5, 7)}`;
const days = (a, b) => Math.round((D(b) - D(a)) / 86400000);
export const fmtMin = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
const fmtH = (m) => `${(Math.round((m / 60) * 10) / 10).toLocaleString('es-AR')} h`;
const agents = () => state.meta.users.filter((u) => u.active && u.role !== 'superadmin');
const MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480];

export async function render(el, _p, query) {
  setCrumbs([{ label: 'Operación' }]);
  const tab = query.tab === 'routines' ? 'routines' : 'agenda';
  let f = { who: 'all', user: '', category: '' };
  try { f = { ...f, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { /* sin almacenamiento */ }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(f)); } catch { /* sin almacenamiento */ } };
  el.innerHTML = `<div class="page op-page">
    <div class="page-head"><div><h1>Operación</h1><p class="muted">Lo que el equipo hace todos los días, semanas o meses y no es un ticket ni un proyecto: backups, controles, parches, altas y bajas, renovaciones.</p></div>
      <button class="btn primary" data-act="new">${icon('plus', 15)} Nueva tarea</button></div>
    <div class="op-bar">
      <div class="tabs op-tabs"><button data-tab="agenda" class="${tab === 'agenda' ? 'on' : ''}">${icon('list', 14)} Agenda</button><button data-tab="routines" class="${tab === 'routines' ? 'on' : ''}">${icon('refresh', 14)} Rutinas</button></div>
      <div class="op-filters"></div>
    </div>
    <div class="op-body"><div class="loading"><span class="spinner"></span></div></div></div>`;
  const body = el.querySelector('.op-body');
  let data = null;

  const filtersHtml = (cats) => `<div class="seg op-seg"><button data-who="me" class="${f.who === 'me' ? 'on' : ''}">Mías</button><button data-who="all" class="${f.who === 'all' ? 'on' : ''}">Todo el equipo</button></div>
    ${f.who === 'all' ? `<select class="input sm" data-f="user"><option value="">Todas las personas</option>${agents().map((u) => `<option value="${u.id}" ${String(u.id) === String(f.user) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
    <select class="input sm" data-f="category"><option value="">Todas las categorías</option>${cats.map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;

  async function load() {
    try {
      if (tab === 'agenda') {
        data = await api(`/ops/agenda${buildQuery({ user: f.who === 'me' ? 'me' : f.user, category: f.category })}`);
        el.querySelector('.op-filters').innerHTML = filtersHtml(data.categories);
        body.innerHTML = agendaHtml(data);
      } else {
        data = await api('/ops/routines');
        const cats = [...new Set(data.routines.map((r) => r.category).filter(Boolean))].sort();
        el.querySelector('.op-filters').innerHTML = filtersHtml(cats);
        body.innerHTML = routinesHtml(data, f);
      }
    } catch (e) { body.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) return navigate(`#/ops${buildQuery({ tab: t.dataset.tab === 'agenda' ? '' : t.dataset.tab })}`);
    const w = e.target.closest('[data-who]');
    if (w) { f.who = w.dataset.who; if (f.who === 'me') f.user = ''; save(); return load(); }
    if (e.target.closest('[data-act=new]')) return openRoutine(null, load);
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      e.stopPropagation();
      const r = data.routines.find((x) => x.id === Number(tg.dataset.toggle));
      try { await api(`/ops/routines/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); toast(r.active ? 'Tarea pausada: no genera nuevas fechas' : 'Tarea activa de nuevo'); load(); } catch (er) { toastError(er); }
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) return openRoutine(data.routines.find((x) => x.id === Number(ed.dataset.edit)), load);
    const row = e.target.closest('[data-item]');
    if (row && data?.groups) {
      const [rid, date] = row.dataset.item.split('|');
      const all = [...data.groups.late, ...data.groups.today, ...data.groups.week, ...data.groups.next];
      const it = all.find((x) => x.routine_id === Number(rid) && x.date === date);
      if (it) openRecord(it, data.today, load);
    }
  });
  el.addEventListener('change', (e) => {
    const s = e.target.closest('select[data-f]');
    if (s) { f[s.dataset.f] = s.value; save(); load(); }
  });
  await load();
}

// ---------- Agenda ----------
function rowHtml(i, today, { showDate = true } = {}) {
  const r = i.record;
  const state0 = r?.status === 'done' ? 'done' : r?.status === 'skipped' ? 'skipped' : '';
  const late = i.late;
  const due = late ? `Vencida hace ${days(i.date, today)} día${days(i.date, today) === 1 ? '' : 's'}` : `${showDate ? `${dd(i.date)} · ` : ''}${esc(i.due_time)} hs`;
  const left = days(today, i.date);
  return `<div class="op-row ${state0}" data-item="${i.routine_id}|${i.date}" role="button" tabindex="0">
    <span class="op-chk" aria-hidden="true">${icon(state0 === 'skipped' ? 'x' : 'check', 13)}</span>
    <div class="op-main"><div class="op-title">${esc(i.name)}</div>
      <div class="op-meta">${i.category ? `<span class="op-cat">${esc(i.category)}</span>` : ''}<span>${i.freq === 'once' ? 'Una vez' : `${icon('refresh', 11)} ${esc(i.rule_text)}`}</span>
        ${i.orig ? `<span class="op-tag">Movida del ${dd(i.orig)} (${i.holiday ? 'feriado' : 'día no hábil'})</span>` : ''}
        ${!r && i.notice_days >= 3 && left > 6 ? `<span class="op-tag">Faltan ${left} días</span>` : ''}
        ${r?.status === 'done' ? `<span>Hecha por ${esc(userName(r.done_by) || '—')} · ${fmtMin(r.minutes)}</span>${r.result !== 'ok' ? `<span class="op-tag ${r.result}">${RESULT[r.result]}</span>` : ''}${r.ticket_id ? `<span class="op-tag">${icon('ticket', 11)} con ticket</span>` : ''}` : ''}
        ${r?.status === 'skipped' ? `<span>Omitida: ${esc(r.note)}</span>` : ''}</div></div>
    <div class="op-right">${state0 ? '' : `<span class="muted">${fmtMin(i.est_minutes)}</span>`}<span class="op-due ${late ? 'late' : ''}">${due}</span>${avatar(i.assignee_id, 22)}</div>
  </div>`;
}

function agendaHtml(a) {
  const daily = (i) => i.freq === 'daily';
  const group = (title, list, cls = '', o = {}) => {
    const shown = o.hideDaily ? list.filter((i) => !daily(i)) : list;
    if (!shown.length && !(o.hideDaily && list.some(daily))) return '';
    return `<section class="op-group ${cls}"><h3>${title} <small>${shown.length}</small></h3><div class="op-rows">${shown.map((i) => rowHtml(i, a.today, o)).join('')}
      ${o.hideDaily && a.daily.length && list.some(daily) ? `<div class="op-daily">Además, las diarias: ${a.daily.map(esc).join(', ')}.</div>` : ''}</div></section>`;
  };
  const today = [...a.groups.today].sort((x, y) => Boolean(x.record) - Boolean(y.record));
  const weekRows = Object.entries(a.week_minutes).sort((x, y) => y[1] - x[1]);
  const max = Math.max(60, ...weekRows.map((x) => x[1]));
  const total = weekRows.reduce((s, x) => s + x[1], 0);
  const empty = !a.groups.late.length && !a.groups.today.length && !a.groups.week.length && !a.groups.next.length;
  return `<div class="op-agenda"><div>
      ${empty ? `<div class="empty">${icon('refresh', 36)}<h4>No hay tareas con estos filtros</h4><p>Cargá las tareas repetitivas del equipo con "Nueva tarea": el backup mensual, los controles diarios, las bajas del mes.</p></div>` : ''}
      ${group('Vencidas', a.groups.late, 'late')}
      ${group(`Hoy, ${DOWL[D(a.today).getUTCDay()]} ${a.today.slice(8)}/${a.today.slice(5, 7)}`, today, '', { showDate: false })}
      ${group('Lo que queda de la semana', a.groups.week, '', { hideDaily: true })}
      ${group('Próximas 2 semanas y avisos', a.groups.next, '', { hideDaily: true })}
    </div>
    <aside class="op-side"><section class="card"><h4>Horas de operación esta semana</h4>
      <div class="op-big">${fmtH(total)}</div><p class="muted small">Lo planificado y, si ya se hizo, lo registrado. Incluye lo vencido.</p>
      ${weekRows.map(([u, m]) => `<div class="op-load">${avatar(Number(u) || null, 22)}<div class="op-track"><span style="width:${(m / max) * 100}%"></span></div><b>${fmtH(m)}</b></div>`).join('') || '<p class="muted small">Nada esta semana.</p>'}
    </section></aside></div>`;
}

// ---------- Rutinas ----------
const HIST = { ok: ['#10b981', 'Bien'], obs: ['#f59e0b', 'Con observaciones'], fail: ['#f97316', 'Falló'], skipped: ['#cbd2dc', 'Omitida'], missed: ['#dc2626', 'Vencida sin hacer'] };
function routinesHtml(d, f) {
  const me = state.me.id;
  const list = d.routines.filter((r) => (f.who !== 'me' || r.assignee_ids.includes(me)) && (!f.user || r.assignee_ids.includes(Number(f.user))) && (!f.category || r.category === f.category));
  if (!d.routines.length) return `<div class="empty">${icon('refresh', 36)}<h4>Todavía no hay tareas</h4><p>Creá la primera con "Nueva tarea".</p></div>`;
  return `<div class="table-wrap"><table class="tbl op-tbl"><thead><tr><th>Tarea</th><th>Categoría</th><th>Cuándo</th><th>Próxima</th><th>Responsable</th><th>Tiempo</th><th>Últimas</th><th>Estado</th></tr></thead><tbody>
    ${list.map((r) => `<tr data-edit="${r.id}" class="${r.active ? '' : 'op-paused'}">
      <td><b>${esc(r.name)}</b>${r.steps.length ? `<div class="muted small">${r.steps.length} paso${r.steps.length === 1 ? '' : 's'}</div>` : ''}</td>
      <td>${r.category ? `<span class="op-cat">${esc(r.category)}</span>` : '—'}</td>
      <td>${esc(r.rule_text)}<div class="muted small">hasta las ${esc(r.due_time)} hs</div></td>
      <td class="nowrap">${r.active && r.next_date ? dd(r.next_date) : '—'}</td>
      <td class="nowrap">${r.assignee_ids.length ? r.assignee_ids.map((u) => avatar(u, 22)).join(' ') : '<span class="muted small">Sin asignar</span>'}${r.assignee_ids.length > 1 ? '<div class="muted small">se turnan</div>' : ''}</td>
      <td class="nowrap">${fmtMin(r.est_minutes)}</td>
      <td><span class="op-dots">${r.history.map((h) => `<i style="background:${HIST[h.state][0]}" title="${dd(h.date)}: ${HIST[h.state][1]}"></i>`).join('') || '<span class="muted small">—</span>'}</span></td>
      <td><button class="op-pill ${r.active ? 'on' : ''}" data-toggle="${r.id}" title="${r.active ? 'Pausar' : 'Activar'}">${r.active ? 'Activa' : 'Pausada'}</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No hay tareas con estos filtros.</td></tr>'}
    </tbody></table></div><p class="muted small">Pausar una tarea deja de generar fechas (por ejemplo, durante una migración) sin perder su historial.</p>`;
}

// ---------- Registrar una ocurrencia ----------
function openRecord(it, today, reload) {
  const r = it.record;
  const future = it.date > today;
  const est = r?.minutes || it.est_minutes;
  const mins = [...new Set([...MINUTES, est])].sort((a, b) => a - b);
  const md = modal({
    title: it.name,
    body: `<p class="muted small" style="margin-top:0">${dd(it.date)} · hasta las ${esc(it.due_time)} hs · ${esc(it.rule_text)}</p>
      ${future ? '<p class="op-warn">Todavía no es la fecha: se puede registrar desde el día que toca.</p>' : ''}
      ${it.steps.length ? `<div class="field"><span>Pasos <small class="muted" data-cnt></small></span><ul class="op-steps">${it.steps.map((s, k) => `<li><label><input type="checkbox" value="${k}" ${!r || (r.steps_done || []).includes(k) ? (r ? 'checked' : '') : ''}> <span>${esc(s)}</span></label></li>`).join('')}</ul></div>` : ''}
      <div class="grid2">
        <label class="field"><span>Tiempo dedicado</span><select class="input" name="minutes">${mins.map((m) => `<option value="${m}" ${m === est ? 'selected' : ''}>${fmtMin(m)}</option>`).join('')}</select></label>
        <label class="field"><span>Lo hizo</span><select class="input" name="done_by">${agents().map((u) => `<option value="${u.id}" ${u.id === (r?.done_by || it.assignee_id || state.me.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>Resultado</span><div class="seg op-result">${Object.entries(RESULT).map(([k, l]) => `<button type="button" data-r="${k}" class="${k === (r?.result || 'ok') ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="op-ticket" ${r?.result === 'fail' && !r?.ticket_id ? '' : 'hidden'}><label class="check"><input type="checkbox" name="open_ticket" checked> Abrir un ticket con el detalle, asignado a quien la hizo</label></div>
      ${r?.ticket_id ? `<p class="small">${icon('ticket', 13)} <a href="#/tickets?q=${encodeURIComponent(it.name)}" data-close>Tiene un ticket vinculado</a></p>` : ''}
      <label class="field"><span>Nota</span><textarea class="input" name="note" rows="2" placeholder="Ej. el backup pesó 412 GB y tardó 1 h 40 min">${esc(r?.note || '')}</textarea></label>`,
    footer: `${r ? '<button class="btn" data-undo>Volver a pendiente</button>' : `<button class="btn" data-skip ${future ? 'disabled' : ''}>Omitir esta vez</button>`}<span class="grow"></span>
      <button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok ${future ? 'disabled' : ''}>${r?.status === 'done' ? 'Guardar cambios' : 'Marcar como hecha'}</button>`,
  });
  const m = md.el;
  let result = r?.result || 'ok';
  const cnt = () => { const c = m.querySelector('[data-cnt]'); if (c) c.textContent = `${m.querySelectorAll('.op-steps input:checked').length}/${it.steps.length}`; };
  cnt();
  m.querySelector('.op-steps')?.addEventListener('change', cnt);
  m.querySelector('.op-result').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    result = b.dataset.r;
    m.querySelectorAll('.op-result button').forEach((x) => x.classList.toggle('on', x === b));
    m.querySelector('.op-ticket').hidden = result !== 'fail' || Boolean(r?.ticket_id);
  });
  const send = async (status, note) => {
    const body = {
      routine_id: it.routine_id, date: it.date, status, result, minutes: status === 'done' ? Number(m.querySelector('[name=minutes]').value) : 0,
      done_by: Number(m.querySelector('[name=done_by]').value), note: note ?? m.querySelector('[name=note]').value,
      steps_done: [...m.querySelectorAll('.op-steps input:checked')].map((x) => Number(x.value)), open_ticket: status === 'done' && result === 'fail' && Boolean(m.querySelector('[name=open_ticket]')?.checked),
    };
    const x = await api('/ops/records', { method: 'POST', body });
    md.close();
    toast(x.ticket ? `Registrada. Se abrió el ticket #${x.ticket.number}` : status === 'skipped' ? 'Omitida: queda en el historial con el motivo' : 'Registrada como hecha');
    reload();
  };
  m.querySelector('[data-ok]').addEventListener('click', async (e) => {
    if (it.steps.length && result === 'ok' && m.querySelectorAll('.op-steps input:checked').length < it.steps.length
      && !(await confirmDialog('Quedan pasos sin tildar. ¿La marcás como hecha igual?', { okText: 'Marcar como hecha' }))) return;
    e.target.disabled = true;
    try { await send('done'); } catch (er) { toastError(er); e.target.disabled = false; }
  });
  m.querySelector('[data-skip]')?.addEventListener('click', async () => {
    const note = m.querySelector('[name=note]').value.trim();
    if (!note) { m.querySelector('[name=note]').focus(); return toast('Escribí en la nota por qué se omite', 'error'); }
    try { await send('skipped', note); } catch (er) { toastError(er); }
  });
  m.querySelector('[data-undo]')?.addEventListener('click', async () => {
    try { await api(`/ops/records/${r.id}`, { method: 'DELETE' }); md.close(); toast('Volvió a pendiente; se borraron sus horas'); reload(); } catch (er) { toastError(er); }
  });
}

// ---------- Nueva / editar tarea ----------
function openRoutine(rt, reload) {
  const canEdit = !rt || isManager() || rt.created_by === state.me.id;
  const now = new Date();
  const rule = { freq: 'monthly', mode: 'nth', nth: 1, wd: 1, every: 1, start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, day: 1, days: [1], workdays: true, month: 0, date: '', shift: 'next', ...(rt ? structuredClone(rt.rule) : {}) };
  const ests = [...new Set([15, 30, 45, 60, 90, 120, 180, 240, 480, rt?.est_minutes || 60])].sort((a, b) => a - b);
  const techs = state.meta.techCategories || [];
  const md = modal({
    title: rt ? 'Editar tarea' : 'Nueva tarea',
    wide: true,
    body: `<fieldset class="op-form" ${canEdit ? '' : 'disabled'}>
      ${canEdit ? '' : '<p class="op-warn">Solo quien la creó o un supervisor puede cambiarla.</p>'}
      <label class="field"><span>Qué hay que hacer *</span><input class="input" name="name" maxlength="200" value="${esc(rt?.name || '')}" placeholder="Ej. Backup mensual de Equis"></label>
      <div class="grid3">
        <label class="field"><span>Categoría</span><input class="input" name="category" maxlength="60" list="opCats" value="${esc(rt?.category || '')}" placeholder="Ej. Backups"><datalist id="opCats"></datalist></label>
        <label class="field"><span>Tiempo estimado</span><select class="input" name="est">${ests.map((x) => `<option value="${x}" ${x === (rt?.est_minutes || 60) ? 'selected' : ''}>${fmtMin(x)}</option>`).join('')}</select></label>
        <label class="field"><span>Hasta las</span><input class="input" type="time" name="due_time" value="${esc(rt?.due_time || '18:00')}"></label>
      </div>
      <div class="field"><span>Responsables <small class="muted">(si elegís más de uno, se turnan)</small></span>
        <div class="op-people">${agents().map((u) => `<label class="op-person"><input type="checkbox" value="${u.id}" ${(rt?.assignee_ids || [state.me.id]).includes(u.id) ? 'checked' : ''}> ${avatar(u.id, 20)} ${esc(u.name)}</label>`).join('')}</div></div>
      <div class="op-rec">
        <div class="seg op-freq">${[['once', 'Una vez'], ['daily', 'Diaria'], ['weekly', 'Semanal'], ['monthly', 'Mensual'], ['yearly', 'Anual']].map(([k, l]) => `<button type="button" data-freq="${k}">${l}</button>`).join('')}</div>
        <div class="op-freq-opts"></div>
        <div class="op-inline"><span>Si cae en fin de semana o feriado:</span><select class="input sm" name="shift"><option value="none">dejarla ese día</option><option value="prev">pasarla al día hábil anterior</option><option value="next">pasarla al día hábil siguiente</option></select></div>
        <div class="op-inline"><span>Mostrarla en la agenda</span><select class="input sm" name="notice">${[[0, 'en su semana'], [7, '1 semana antes'], [15, '15 días antes'], [30, '1 mes antes']].map(([x, l]) => `<option value="${x}" ${x === (rt?.notice_days || 0) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="op-preview" aria-live="polite"><b data-sum></b><ol data-dates></ol></div>
      </div>
      <label class="field"><span>Pasos (uno por renglón; se tildan al hacerla)</span><textarea class="input" name="steps" rows="4" placeholder="Avisar a los usuarios&#10;Correr el backup completo&#10;Verificar la integridad">${esc((rt?.steps || []).join('\n'))}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Categoría técnica del ticket si falla</span><select class="input" name="tech"><option value="">—</option>${techs.filter((x) => x.active !== false || x.id === rt?.tech_category_id).map((x) => `<option value="${x.id}" ${x.id === rt?.tech_category_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Descripción</span><input class="input" name="description" maxlength="5000" value="${esc(rt?.description || '')}" placeholder="Opcional"></label>
      </div></fieldset>`,
    footer: `${rt && canEdit ? '<button class="btn danger" data-del>Eliminar</button>' : ''}<span class="grow"></span><button class="btn" data-close>Cancelar</button>${canEdit ? `<button class="btn primary" data-ok>${rt ? 'Guardar cambios' : 'Crear tarea'}</button>` : ''}`,
  });
  const m = md.el;
  m.querySelector('[name=shift]').value = rule.shift;
  api('/ops/routines').then((d) => { m.querySelector('#opCats').innerHTML = [...new Set(d.routines.map((x) => x.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join(''); }).catch(() => {});
  const sel = (k, opts, val) => `<select class="input sm" data-k="${k}">${opts.map(([x, l]) => `<option value="${x}" ${String(x) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => [a + i, a + i]);
  const preview = debounce(async () => {
    try {
      const p = await api('/ops/preview', { method: 'POST', body: { rule: { ...rule, shift: m.querySelector('[name=shift]').value } } });
      m.querySelector('[data-sum]').textContent = `${p.text}, hasta las ${m.querySelector('[name=due_time]').value || '18:00'} hs`;
      m.querySelector('[data-dates]').innerHTML = p.dates.map((x) => `<li>${dd(x.date)}/${x.date.slice(2, 4)}${x.orig ? ` <em>(movida del ${dd(x.orig)}${x.holiday ? ', feriado' : ''})</em>` : ''}</li>`).join('') || '<li class="muted">Sin fechas próximas</li>';
    } catch (e) { m.querySelector('[data-sum]').textContent = e.message; m.querySelector('[data-dates]').innerHTML = ''; }
  }, 250);
  const drawFreq = () => {
    m.querySelectorAll('[data-freq]').forEach((b) => b.classList.toggle('on', b.dataset.freq === rule.freq));
    const o = m.querySelector('.op-freq-opts');
    if (rule.freq === 'once') o.innerHTML = `<div class="op-inline"><span>El</span><input class="input sm" type="date" data-k="date" value="${esc(rule.date || '')}"></div>`;
    if (rule.freq === 'daily') o.innerHTML = `<label class="check"><input type="checkbox" data-k="workdays" ${rule.workdays ? 'checked' : ''}> Solo días hábiles (sin fines de semana ni feriados)</label>`;
    if (rule.freq === 'weekly') o.innerHTML = `<div class="op-days">${[1, 2, 3, 4, 5, 6, 0].map((x) => `<button type="button" data-day="${x}" class="${rule.days.includes(x) ? 'on' : ''}" aria-pressed="${rule.days.includes(x)}">${DOW[x]}</button>`).join('')}</div>`;
    if (rule.freq === 'monthly') {
      o.innerHTML = `<div class="op-inline">${sel('every', [[1, 'Todos los meses'], [2, 'Cada 2 meses'], [3, 'Cada 3 meses'], [6, 'Cada 6 meses'], [12, 'Cada 12 meses']], rule.every)}
        ${sel('mode', [['nth', 'el'], ['day', 'el día']], rule.mode)}
        ${rule.mode === 'day' ? sel('day', range(1, 31), rule.day) : `${sel('nth', [[1, 'primer'], [2, 'segundo'], [3, 'tercer'], [4, 'cuarto'], [-1, 'último']], rule.nth)} ${sel('wd', [[1, 'lunes'], [2, 'martes'], [3, 'miércoles'], [4, 'jueves'], [5, 'viernes'], ['bd', 'día hábil']], rule.wd)}`}
        ${rule.every > 1 ? `<span>empezando en</span><input class="input sm" type="month" data-k="start" value="${esc(rule.start)}">` : ''}</div>`;
    }
    if (rule.freq === 'yearly') o.innerHTML = `<div class="op-inline"><span>El</span>${sel('day', range(1, 31), rule.day)}<span>de</span>${sel('month', MONTHS.map((x, i) => [i, x]), rule.month)}</div>`;
    preview();
  };
  m.querySelector('.op-freq').addEventListener('click', (e) => { const b = e.target.closest('[data-freq]'); if (b) { rule.freq = b.dataset.freq; drawFreq(); } });
  m.querySelector('.op-freq-opts').addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    rule[k] = e.target.type === 'checkbox' ? e.target.checked : ['date', 'mode', 'start'].includes(k) || e.target.value === 'bd' ? e.target.value : Number(e.target.value);
    drawFreq();
  });
  m.querySelector('.op-freq-opts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const x = Number(b.dataset.day);
    rule.days = rule.days.includes(x) ? rule.days.filter((y) => y !== x) : [...rule.days, x];
    drawFreq();
  });
  m.querySelector('[name=shift]').addEventListener('change', preview);
  m.querySelector('[name=due_time]').addEventListener('change', preview);
  drawFreq();
  m.querySelector('[data-ok]')?.addEventListener('click', async (e) => {
    const body = {
      name: m.querySelector('[name=name]').value.trim(), category: m.querySelector('[name=category]').value.trim(), est_minutes: Number(m.querySelector('[name=est]').value),
      due_time: m.querySelector('[name=due_time]').value || '18:00', notice_days: Number(m.querySelector('[name=notice]').value),
      assignee_ids: [...m.querySelectorAll('.op-people input:checked')].map((x) => Number(x.value)), rule: { ...rule, shift: m.querySelector('[name=shift]').value },
      steps: m.querySelector('[name=steps]').value.split('\n').map((s) => s.trim()).filter(Boolean), tech_category_id: Number(m.querySelector('[name=tech]').value) || null,
      description: m.querySelector('[name=description]').value.trim(), active: rt ? rt.active : true,
    };
    if (!body.name) { m.querySelector('[name=name]').focus(); return toast('Escribí qué hay que hacer', 'error'); }
    e.target.disabled = true;
    try {
      await api(rt ? `/ops/routines/${rt.id}` : '/ops/routines', { method: rt ? 'PATCH' : 'POST', body });
      md.close();
      toast(rt ? 'Tarea actualizada' : 'Tarea creada');
      reload();
    } catch (er) { toastError(er); e.target.disabled = false; }
  });
  m.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Eliminar "${rt.name}"? Si ya tiene registros, conviene pausarla.`, { danger: true, okText: 'Eliminar' }))) return;
    try { await api(`/ops/routines/${rt.id}`, { method: 'DELETE' }); md.close(); toast('Tarea eliminada'); reload(); } catch (er) { toastError(er); }
  });
}
