// Informes → Horas (v1.17): lo registrado por cada persona de IT en tickets, proyectos y operación, contra sus horas
// disponibles (días hábiles × horas por día × % dedicado a IT). Prefijo CSS rh-.
import { state, api, esc, icon, avatar, toast, toastError, isAdmin, buildQuery, techName } from '../core.js';
import { maxButton } from './reports.js';

const SRC = { T: ['Tickets', 'rh-t'], P: ['Proyectos', 'rh-p'], O: ['Operación', 'rh-o'], X: ['Otras', 'rh-x'] };
const LS = 'rh-hours';
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const D = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dm = (s) => `${s.slice(8)}/${s.slice(5, 7)}`;
const H = (min) => `${(Math.round((min / 60) * 10) / 10).toLocaleString('es-AR')} h`;
const HM = (raw) => { const min = Math.round(raw); return min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '<span class="rh-z">–</span>'; };
const sum = (a) => a.reduce((x, y) => x + y, 0);

export async function render(el) {
  // v1.22: modo (calculado o registrado) y filtros; se recuerdan
  let ui = { period: 'week', date: null, sel: null, mode: 'calc', user: '', source: '', project: '', tech: '' };
  try { ui = { ...ui, ...JSON.parse(localStorage.getItem(LS) || '{}'), date: null, sel: null }; } catch { /* sin almacenamiento */ }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify({ period: ui.period, mode: ui.mode, user: ui.user, source: ui.source, project: ui.project, tech: ui.tech })); } catch { /* sin almacenamiento */ } };
  let d = null;

  async function load() {
    try {
      d = await api(`/reports/hours${buildQuery({ period: ui.period, date: ui.date || '', mode: ui.mode, user: ui.user, source: ui.source, project: ui.project, tech: ui.tech })}`);
      ui.date = d.from;
      draw();
    } catch (e) { el.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
  }

  function totals(uid) {
    const t = { T: 0, P: 0, O: 0, X: 0 };
    for (const e of d.entries) if (e.user_id === uid) t[e.source] += e.minutes;
    return t;
  }

  function draw() {
    const title = d.period === 'week' ? `Semana del ${dm(d.from)} al ${dm(d.to)}` : `${MONTHS[Number(d.from.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase())} ${d.from.slice(0, 4)}`;
    const all = { T: 0, P: 0, O: 0, X: 0 };
    for (const e of d.entries) all[e.source] += e.minutes;
    const reg = sum(Object.values(all));
    const avail = sum(d.people.map((p) => p.available_minutes));
    const people = d.people.map((p) => { const t = totals(p.id); return { ...p, t, total: sum(Object.values(t)) }; })
      .filter((p) => p.available_minutes || p.total).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    if (!ui.sel || !people.some((p) => p.id === ui.sel)) ui.sel = people[0]?.id || null;
    const scale = Math.max(1, ...people.map((p) => Math.max(p.available_minutes, p.total)));
    const kpi = (k) => `<div class="rh-kpi"><span><i class="${SRC[k][1]}"></i>${SRC[k][0]}</span><b>${H(all[k])}</b><small>${reg ? Math.round((all[k] / reg) * 100) : 0} % de lo ${d.mode === 'calc' ? 'calculado' : 'registrado'}</small></div>`;
    const admin = isAdmin();
    const calc = d.mode === 'calc';
    const agents = state.meta.users.filter((u) => u.active && u.role !== 'superadmin');
    const techs = state.meta.techCategories || [];
    const filtered = Boolean(ui.user || ui.source || ui.project || ui.tech);
    el.innerHTML = `<div class="rh">
      <div class="rh-bar">
        <div class="rh-seg" role="group" aria-label="Qué horas mostrar"><button data-mode="calc" class="${calc ? 'on' : ''}" title="Proyectos por estimación, operación por rutinas y tickets resueltos por tiempo típico">Calculado</button><button data-mode="real" class="${calc ? '' : 'on'}" title="Lo que cada persona cargó a mano">Registrado</button></div>
        <div class="rh-seg"><button data-period="week" class="${d.period === 'week' ? 'on' : ''}">Semana</button><button data-period="month" class="${d.period === 'month' ? 'on' : ''}">Mes</button></div>
        <button class="btn sm" data-nav="-1" aria-label="Anterior">${icon('left', 14)}</button><b class="rh-title">${esc(title)}</b><button class="btn sm" data-nav="1" aria-label="Siguiente">${icon('right', 14)}</button>
        <button class="btn sm" data-nav="0">Hoy</button>
        <span class="muted small">${d.workdays} día${d.workdays === 1 ? '' : 's'} hábil${d.workdays === 1 ? '' : 'es'} × ${d.day_hours} h</span>
        <span class="grow"></span>${maxButton()}
      </div>
      <div class="rh-filters">
        <select class="input sm" data-filter="user" aria-label="Persona"><option value="">Todas las personas</option>${agents.map((u) => `<option value="${u.id}" ${String(u.id) === String(ui.user) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <select class="input sm" data-filter="source" aria-label="Origen"><option value="">Tickets, proyectos y operación</option>${['T', 'P', 'O'].map((k) => `<option value="${k}" ${ui.source === k ? 'selected' : ''}>Solo ${SRC[k][0].toLowerCase()}</option>`).join('')}</select>
        <select class="input sm" data-filter="project" aria-label="Proyecto"><option value="">Todos los proyectos</option>${(d.projects || []).map((p) => `<option value="${p.id}" ${String(p.id) === String(ui.project) ? 'selected' : ''}>${esc(p.key)} · ${esc(p.name)}</option>`).join('')}</select>
        <select class="input sm" data-filter="tech" aria-label="Categoría técnica de los tickets"><option value="">Todas las categorías técnicas</option>${techs.map((t) => `<option value="${t.id}" ${String(t.id) === String(ui.tech) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        ${filtered ? '<button class="link-btn small" data-clear>Limpiar filtros</button>' : ''}
      </div>
      <p class="muted small rh-how">${calc
    ? `<b>Calculado:</b> proyectos por sus horas estimadas (el mismo reparto del calendario del Portfolio), operación por lo planificado de las rutinas y tickets resueltos en el período por sus horas registradas o el tiempo típico de su categoría técnica.${ui.project ? ' Con un proyecto elegido, solo se ven sus horas.' : ''}${ui.tech ? ' La categoría técnica filtra solo los tickets.' : ''}`
    : '<b>Registrado:</b> solo lo que cada persona cargó a mano en tickets, tareas de proyectos y operación.'}</p>
      <div class="rh-kpis">${kpi('T')}${kpi('P')}${kpi('O')}${all.X ? kpi('X') : ''}
        <div class="rh-kpi"><span>${calc ? 'Total calculado' : 'Total registrado'}</span><b>${H(reg)}</b><small>de ${H(avail)} disponibles</small></div>
        <div class="rh-kpi"><span><i class="rh-hatch"></i>${calc ? 'Libre' : 'Sin registrar'}</span><b>${H(Math.max(0, avail - reg))}</b><small>${avail ? Math.round((Math.max(0, avail - reg) / avail) * 100) : 0} % de las horas disponibles</small></div></div>
      <div class="rh-legend">${['T', 'P', 'O'].map((k) => `<span><i class="${SRC[k][1]}"></i>${SRC[k][0]}</span>`).join('')}<span><i class="rh-hatch"></i>${calc ? 'Libre' : 'Sin registrar'} (hasta las horas disponibles)</span></div>
      <div class="table-wrap"><table class="tbl rh-tbl"><thead><tr><th>Persona</th><th class="rh-barcol">Distribución</th><th class="num">Tickets</th><th class="num">Proyectos</th><th class="num">Operación</th><th class="num">Total</th><th class="num">${calc ? 'Ocupación' : 'Registrado'}</th></tr></thead><tbody>
        ${people.map((p) => {
    const pct = p.available_minutes ? Math.round((p.total / p.available_minutes) * 100) : null;
    const free = Math.max(0, p.available_minutes - p.total);
    return `<tr data-p="${p.id}" class="${ui.sel === p.id ? 'rh-sel' : ''}" tabindex="0">
            <td><div class="rh-who">${avatar(p.id, 26)}<div><b>${esc(p.name)}</b><small class="muted">${admin ? `<select class="rh-pct" data-pct="${p.id}" aria-label="Dedicación a IT de ${esc(p.name)}" title="Porcentaje de la jornada dedicado a IT">${[100, 75, 50, 25, 0].map((x) => `<option value="${x}" ${x === p.it_pct ? 'selected' : ''}>${x} % a IT</option>`).join('')}</select>` : `${p.it_pct} % a IT`}</small></div></div></td>
            <td class="rh-barcol"><div class="rh-stack" style="width:${(Math.max(p.available_minutes, p.total) / scale) * 100}%">${['T', 'P', 'O', 'X'].map((k) => (p.t[k] ? `<span class="${SRC[k][1]}" style="width:${(p.t[k] / Math.max(p.available_minutes, p.total)) * 100}%" title="${SRC[k][0]}: ${H(p.t[k])}"></span>` : '')).join('')}</div></td>
            <td class="num">${H(p.t.T)}</td><td class="num">${H(p.t.P)}</td><td class="num">${H(p.t.O)}</td>
            <td class="num"><b>${H(p.total)}</b><div class="muted small">de ${H(p.available_minutes)}</div></td>
            <td class="num">${pct === null ? '—' : `<span class="rh-badge ${calc ? (pct > 100 ? 'low' : pct >= 85 ? 'mid' : 'ok') : pct >= 85 ? 'ok' : pct >= 60 ? 'mid' : 'low'}" title="${calc ? (pct > 100 ? 'Sobrecargado' : pct >= 85 ? 'Al límite' : 'Con margen') : ''}">${pct} %</span>`}${free ? `<div class="muted small">${H(free)} ${calc ? 'libres' : 'sin registrar'}</div>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">No hay personas de IT activas.</td></tr>'}
      </tbody></table></div>
      ${ui.sel ? detailHtml(people.find((p) => p.id === ui.sel)) : ''}
      ${resolutionHtml()}
    </div>`;
  }

  /** Tiempo de resolución de los tickets resueltos en el período: indicador de demora, no horas trabajadas. */
  function resolutionHtml() {
    const r = d.resolution || [];
    if (!r.length) return '';
    const by = new Map();
    for (const x of r) { if (!by.has(x.user_id)) by.set(x.user_id, []); by.get(x.user_id).push(x); }
    const med = (arr) => { const v = arr.map((x) => x.minutes).sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
    const all = { n: r.length, avg: sum(r.map((x) => x.minutes)) / r.length, med: med(r) };
    const rows = [...by.entries()].map(([uid, arr]) => ({ uid, arr, avg: sum(arr.map((x) => x.minutes)) / arr.length, med: med(arr), max: arr.reduce((a, b) => (b.minutes > a.minutes ? b : a)) }))
      .sort((a, b) => b.arr.length - a.arr.length);
    return `<section class="card rh-detail"><h3>Tiempo de resolución de tickets</h3>
      <p class="muted small">Horas laborales entre que se abrió y se resolvió cada ticket resuelto en el período. Mide la <b>demora</b>, no las horas trabajadas: no se suma a las horas de arriba. En total: ${all.n} ticket${all.n === 1 ? '' : 's'}, promedio ${H(all.avg)}, la mitad se resolvió en menos de ${H(all.med)}.</p>
      <div class="table-wrap"><table class="rh-ts"><thead><tr><th>Persona</th><th>Resueltos</th><th>Promedio</th><th>Mediana</th><th>El que más tardó</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td class="rh-lbl">${avatar(x.uid, 20)} ${esc(state.meta.users.find((u) => u.id === x.uid)?.name || '—')}</td><td>${x.arr.length}</td><td>${H(x.avg)}</td><td>${H(x.med)}</td>
        <td class="rh-lbl"><a href="#/tickets/${x.max.number}">#${x.max.number}</a> · ${H(x.max.minutes)}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  }

  function detailHtml(p) {
    const list = d.entries.filter((e) => e.user_id === p.id);
    const groups = {};
    for (const e of list) {
      const k = `${e.source}|${e.label}`;
      if (!groups[k]) groups[k] = { source: e.source, label: e.label, link: e.link, how: e.how, byDay: {}, total: 0 };
      groups[k].byDay[e.date] = (groups[k].byDay[e.date] || 0) + e.minutes;
      groups[k].total += e.minutes;
    }
    const items = Object.values(groups).sort((a, b) => b.total - a.total);
    const name = esc(p.name);
    if (d.period === 'week') {
      const days = Array.from({ length: 7 }, (_, i) => addDays(d.from, i)).filter((x, i) => i < 5 || list.some((e) => e.date === x));
      const perDay = (d.day_hours * 60 * p.it_pct) / 100;
      const dayTot = days.map((x) => sum(list.filter((e) => e.date === x).map((e) => e.minutes)));
      const body = ['T', 'P', 'O', 'X'].map((k) => {
        const its = items.filter((i) => i.source === k);
        if (!its.length && k === 'X') return '';
        return `<tr class="rh-grp"><td colspan="${days.length + 2}"><i class="${SRC[k][1]}"></i>${SRC[k][0]} · ${H(sum(its.map((i) => i.total)))}</td></tr>
          ${its.map((i) => `<tr><td class="rh-lbl">${i.link ? `<a href="${esc(i.link)}">${esc(i.label)}</a>` : esc(i.label)}${d.mode === 'calc' && i.how ? ` <small class="muted">(${esc(i.how)})</small>` : ''}</td>${days.map((x) => `<td>${HM(i.byDay[x] || 0)}</td>`).join('')}<td><b>${HM(i.total)}</b></td></tr>`).join('') || `<tr><td class="muted" colspan="${days.length + 2}">Nada registrado</td></tr>`}`;
      }).join('');
      return `<section class="card rh-detail"><h3>${name}: ${esc(`semana del ${dm(d.from)} al ${dm(d.to)}`)}</h3>
        <p class="muted small">Lo que registró cada día, en horas y minutos. ${p.it_pct < 100 ? `Dedica ${p.it_pct} % a IT: ${H(perDay)} por día.` : `${d.day_hours} h por día.`}</p>
        <div class="table-wrap"><table class="rh-ts"><thead><tr><th>Qué</th>${days.map((x) => `<th>${DOW[D(x).getUTCDay()]} ${dm(x)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${body}
          <tr class="rh-tot"><td>Total del día</td>${dayTot.map((m) => `<td>${HM(m)}</td>`).join('')}<td>${HM(sum(dayTot))}</td></tr>
          <tr class="rh-gap"><td>Sin registrar</td>${days.map((x, i) => { const g = [0, 6].includes(D(x).getUTCDay()) ? 0 : Math.max(0, Math.round(perDay - dayTot[i])); return `<td>${HM(g)}</td>`; }).join('')}<td>${HM(Math.max(0, p.available_minutes - sum(dayTot)))}</td></tr>
        </tbody></table></div></section>`;
    }
    return `<section class="card rh-detail"><h3>${name}: ${esc(MONTHS[Number(d.from.slice(5, 7)) - 1])} ${d.from.slice(0, 4)}</h3>
      <p class="muted small">En qué registró horas en el mes, de lo que más tiempo llevó a lo que menos. Disponibles: ${H(p.available_minutes)}.</p>
      <table class="rh-ts rh-month"><thead><tr><th>Qué</th><th>Horas</th></tr></thead><tbody>
      ${['T', 'P', 'O', 'X'].map((k) => {
    const its = items.filter((i) => i.source === k);
    if (!its.length && k === 'X') return '';
    return `<tr class="rh-grp"><td colspan="2"><i class="${SRC[k][1]}"></i>${SRC[k][0]} · ${H(sum(its.map((i) => i.total)))}</td></tr>${its.map((i) => `<tr><td class="rh-lbl">${i.link ? `<a href="${esc(i.link)}">${esc(i.label)}</a>` : esc(i.label)}${d.mode === 'calc' && i.how ? ` <small class="muted">(${esc(i.how)})</small>` : ''}</td><td>${H(i.total)}</td></tr>`).join('') || '<tr><td class="muted" colspan="2">Nada registrado</td></tr>'}`;
  }).join('')}</tbody></table></section>`;
  }

  el.addEventListener('click', (e) => {
    const md = e.target.closest('[data-mode]');
    if (md) { ui.mode = md.dataset.mode; save(); return load(); }
    if (e.target.closest('[data-clear]')) { ui.user = ''; ui.source = ''; ui.project = ''; ui.tech = ''; save(); return load(); }
    const per = e.target.closest('[data-period]');
    if (per) { ui.period = per.dataset.period; ui.date = null; save(); return load(); }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const n = Number(nav.dataset.nav);
      if (n === 0) ui.date = null;
      else if (d.period === 'week') ui.date = addDays(d.from, 7 * n);
      else { const [y, m] = d.from.split('-').map(Number); ui.date = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); }
      return load();
    }
    if (e.target.closest('select, a')) return;
    const row = e.target.closest('[data-p]');
    if (row) { ui.sel = Number(row.dataset.p); draw(); }
  });
  el.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-p]');
    if (row && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('select')) { e.preventDefault(); ui.sel = Number(row.dataset.p); draw(); }
  });
  el.addEventListener('change', async (e) => {
    const fl = e.target.closest('[data-filter]');
    if (fl) { ui[fl.dataset.filter] = fl.value; ui.sel = null; save(); return load(); }
    const s = e.target.closest('[data-pct]');
    if (!s) return;
    try {
      await api(`/reports/hours/people/${s.dataset.pct}`, { method: 'PATCH', body: { it_pct: Number(s.value) } });
      const u = state.meta.users.find((x) => x.id === Number(s.dataset.pct));
      toast(`${u?.name || 'La persona'}: ${s.value} % dedicado a IT`);
      load();
    } catch (er) { toastError(er); }
  });
  await load();
}
