// Informes → Calendario (v1.14): capas que se prenden y apagan, vistas de mes, semana y agenda, filtro por persona.
import { state, api, esc, icon, avatar, userName } from '../core.js';
import { maxButton } from './reports.js';

const LAYERS = [
  ['project', 'Inicio y fin de proyectos', '#C8102E'],
  ['phase', 'Etapas (inicio y fin)', '#7c3aed'],
  ['task', 'Tareas que vencen', '#2563eb'],
  ['sla', 'Tickets: vence el SLA', '#d97706'],
  ['sprint', 'Sprints', '#0f766e'],
  ['critical', 'Sistemas críticos (vuelta estimada)', '#475569'],
  ['holiday', 'Feriados', '#ea580c'],
];
const COLOR = Object.fromEntries(LAYERS.map(([k, , c]) => [k, c]));
const LABEL = Object.fromEntries(LAYERS.map(([k, l]) => [k, l]));
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const LS = 'rp-calendar';
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monday = (s) => addDays(s, -((D(s).getUTCDay() + 6) % 7));
const dmy = (s) => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

export async function render(el) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch { /* */ }
  const first = await api('/reports/calendar');
  const today = first.today;
  const ui = { view: saved.view || 'm', person: saved.person || '', on: new Set(saved.on || LAYERS.filter(([k]) => k !== 'sprint').map(([k]) => k)), month: `${today.slice(0, 7)}-01`, week: monday(today) };
  const cache = new Map(); // rango → eventos
  cache.set(`${first.from}|${first.to}`, first.events);
  const expandedDays = new Set();
  const save = () => { try { localStorage.setItem(LS, JSON.stringify({ view: ui.view, person: ui.person, on: [...ui.on] })); } catch { /* */ } };

  el.innerHTML = `<div class="rp-card">
    <div class="rp-bar">
      <button class="btn sm" data-act="prev" aria-label="Anterior">${icon('left', 14)}</button><button class="btn sm" data-act="today">Hoy</button><button class="btn sm" data-act="next" aria-label="Siguiente">${icon('right', 14)}</button>
      <b data-title style="font-size:16px;margin:0 8px;min-width:170px"></b>
      <div class="rp-seg" data-views><button data-v="m">Mes</button><button data-v="w">Semana</button><button data-v="a">Agenda</button></div>
      <span class="sep"></span>
      <label class="lbl">Persona <select class="input sm" data-person><option value="">Todo el equipo</option>${state.meta.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${String(ui.person) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <span class="grow"></span>
      <span class="rp-maxhint">Esc para salir</span>
      ${maxButton()}
    </div>
    <div class="rp-body"><div class="rc-wrap">
      <div class="rc-side"><div><div class="lbl" style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Qué mostrar</div><div data-layers></div></div>
        <p class="small muted">Tocá un evento para abrir el proyecto, la tarea o el ticket. Los feriados salen de Configuración → Horario de atención.</p></div>
      <div class="rc-main" data-main><div class="loading"><span class="spinner"></span></div></div>
    </div></div>
  </div>`;
  const main = el.querySelector('[data-main]');

  function span() {
    if (ui.view === 'm') { const s = monday(ui.month); return [s, addDays(s, 41)]; }
    if (ui.view === 'w') return [ui.week, addDays(ui.week, 6)];
    return [today, addDays(today, 44)];
  }
  async function eventsFor(from, to) {
    for (const [k, evs] of cache) { const [f, t] = k.split('|'); if (f <= from && t >= to) return evs; }
    const r = await api(`/reports/calendar?from=${from}&to=${to}`);
    cache.set(`${r.from}|${r.to}`, r.events);
    return r.events;
  }
  const personOk = (e) => !ui.person || !e.user_id || String(e.user_id) === String(ui.person);
  const href = (e) => (e.ticket ? `#/tickets/${e.ticket}` : e.issue ? `#/issue/${encodeURIComponent(e.issue)}` : e.project ? `#/projects/${encodeURIComponent(e.project)}` : '');
  const evHtml = (e, { cont = false } = {}) => {
    const h = href(e);
    const tag = h ? 'a' : 'span';
    const cls = `rc-ev ${e.end ? 'span' : ''} ${e.done ? 'done' : ''}`;
    const title = `${LABEL[e.layer]}: ${e.title}${e.user_id ? ` · ${userName(e.user_id)}` : ''}${e.note ? `\n${e.note}` : ''}`;
    return `<${tag} class="${cls}" style="--c:${COLOR[e.layer]}" ${h ? `href="${h}"` : ''} title="${esc(title)}">${cont ? '&nbsp;' : `${e.milestone ? '◆ ' : ''}${esc(e.title)}`}</${tag}>`;
  };

  async function draw() {
    save();
    el.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === ui.view));
    const [from, to] = span();
    const all = (await eventsFor(from, to)).filter((e) => (e.end ? e.end >= from && e.date <= to : e.date >= from && e.date <= to) && personOk(e));
    el.querySelector('[data-layers]').innerHTML = LAYERS.map(([k, l, c]) => `<label class="rc-layer" style="--c:${c}"><input type="checkbox" data-l="${k}" ${ui.on.has(k) ? 'checked' : ''}><span class="sw"></span>${l}<em>${all.filter((e) => e.layer === k).length}</em></label>`).join('');
    const evs = all.filter((e) => ui.on.has(e.layer));
    const byDay = {};
    for (const e of evs) {
      if (e.end) for (let d = e.date < from ? from : e.date, i = 0; d <= e.end && d <= to; d = addDays(d, 1), i += 1) (byDay[d] ||= []).push({ ...e, cont: d !== e.date && D(d).getUTCDay() !== 1 });
      else (byDay[e.date] ||= []).push(e);
    }
    const holidays = new Set(evs.filter((e) => e.layer === 'holiday').map((e) => e.date));
    const dow = `<div class="rc-g7 rc-dow">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((x) => `<div>${x}</div>`).join('')}</div>`;
    const title = el.querySelector('[data-title]');
    if (ui.view === 'm') {
      const m = D(ui.month);
      title.textContent = `${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}`;
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const d = addDays(from, i);
        const list = byDay[d] || [];
        const showAll = expandedDays.has(d);
        const shown = showAll ? list : list.slice(0, 3);
        cells += `<div class="rc-day ${d.slice(0, 7) !== ui.month.slice(0, 7) ? 'out' : ''} ${d === today ? 'tod' : ''} ${holidays.has(d) ? 'hol' : ''}"><div class="rc-dn"><b>${Number(d.slice(8))}</b></div>${shown.map((e) => evHtml(e, { cont: e.cont })).join('')}${list.length > 3 ? `<button class="rc-more" data-more="${d}">${showAll ? 'Ver menos' : `+${list.length - 3} más`}</button>` : ''}</div>`;
      }
      main.innerHTML = dow + `<div class="rc-g7">${cells}</div>`;
    } else if (ui.view === 'w') {
      title.textContent = `Semana del ${dmy(ui.week).slice(0, 5)}`;
      main.innerHTML = dow + `<div class="rc-g7">${Array.from({ length: 7 }, (_, i) => { const d = addDays(ui.week, i); const list = byDay[d] || []; return `<div class="rc-day week ${d === today ? 'tod' : ''} ${holidays.has(d) ? 'hol' : ''}"><div class="rc-dn"><b>${Number(d.slice(8))}/${d.slice(5, 7)}</b></div>${list.map((e) => evHtml(e)).join('') || '<span class="small muted">—</span>'}</div>`; }).join('')}</div>`;
    } else {
      title.textContent = 'Próximos 45 días';
      const days = Array.from({ length: 45 }, (_, i) => addDays(today, i)).filter((d) => byDay[d]?.length);
      main.innerHTML = `<div class="rc-agenda">${days.map((d) => `<h4>${DAYS[D(d).getUTCDay()]} ${dmy(d)}${d === today ? ' · hoy' : ''}</h4>${byDay[d].filter((e) => !e.cont).map((e) => `<div class="it"><span class="ex-dot" style="background:${COLOR[e.layer]}"></span><span style="flex:1;min-width:0">${evHtml(e)}</span>${e.user_id ? `${avatar(e.user_id, 20)} <span class="small">${esc(userName(e.user_id))}</span>` : ''}<span class="muted small" style="width:170px;text-align:right">${LABEL[e.layer]}</span></div>`).join('')}`).join('') || '<p class="muted" style="padding:20px">No hay nada en los próximos 45 días con las capas elegidas.</p>'}</div>`;
    }
  }

  el.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-v]');
    if (v) { ui.view = v.dataset.v; return draw(); }
    const more = e.target.closest('[data-more]');
    if (more) { const d = more.dataset.more; expandedDays.has(d) ? expandedDays.delete(d) : expandedDays.add(d); return draw(); }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    const shiftMonth = (n) => { const m = D(ui.month); ui.month = iso(new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + n, 1))); };
    if (a === 'prev') ui.view === 'w' ? (ui.week = addDays(ui.week, -7)) : shiftMonth(-1);
    if (a === 'next') ui.view === 'w' ? (ui.week = addDays(ui.week, 7)) : shiftMonth(1);
    if (a === 'today') { ui.month = `${today.slice(0, 7)}-01`; ui.week = monday(today); }
    if (['prev', 'next', 'today'].includes(a)) draw();
  });
  el.addEventListener('change', (e) => {
    if (e.target.dataset.l) { e.target.checked ? ui.on.add(e.target.dataset.l) : ui.on.delete(e.target.dataset.l); draw(); }
    if (e.target.matches('[data-person]')) { ui.person = e.target.value; draw(); }
  });
  await draw();
}
