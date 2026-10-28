// Informes → Roadmap (v1.14): todos los proyectos en una línea de tiempo, con etapas, desvíos, salud y carga del equipo.
import { state, api, esc, icon, avatar, userName, fmtDate } from '../core.js';
import { maxButton } from './reports.js';

const HEALTH = { ok: ['En término', '#059669'], risk: ['En riesgo', '#d97706'], late: ['Atrasado', '#dc2626'], done: ['Finalizado', '#64748b'], none: ['Sin fechas', '#94a3b8'] };
const PX = { w: 26, m: 7, q: 2.6, y: 1.4 };
const ZOOMS = [['w', 'Semanas'], ['m', 'Meses'], ['q', 'Trimestres'], ['y', 'Año']];
const GROUPS = { sector: 'Sector IT', type: 'Tipo de proyecto', lead: 'Líder', status: 'Estado', area: 'Área solicitante', priority: 'Prioridad', '': 'Sin agrupar' };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const LS = 'rp-roadmap';

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const diff = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function load() {
  try { return { zoom: 'm', group: 'sector', status: 'open', color: 'health', phases: false, dev: true, team: true, q: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { zoom: 'm', group: 'sector', status: 'open', color: 'health', phases: false, dev: true, team: true, q: '' }; }
}

export async function render(el) {
  const data = await api('/reports/roadmap');
  const ui = load();
  const open = new Set();
  const today = data.today;
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(ui)); } catch { /* */ } };

  el.innerHTML = `<div class="rp-card">
    <div class="rp-bar">
      <div class="rp-seg" data-zoom>${ZOOMS.map(([k, l]) => `<button data-z="${k}" class="${ui.zoom === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="btn sm" data-act="today">Hoy</button>
      <span class="sep"></span>
      <input class="input sm" data-k="q" placeholder="Buscar proyecto o líder" value="${esc(ui.q)}" style="width:180px">
      <label class="lbl">Agrupar <select class="input sm" data-k="group">${Object.entries(GROUPS).map(([k, l]) => `<option value="${k}" ${ui.group === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="lbl">Estado <select class="input sm" data-k="status"><option value="open" ${ui.status === 'open' ? 'selected' : ''}>Abiertos</option><option value="" ${ui.status === '' ? 'selected' : ''}>Todos</option>${Object.entries(data.statuses).map(([k, l]) => `<option value="${k}" ${ui.status === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="lbl">Color <select class="input sm" data-k="color"><option value="health" ${ui.color === 'health' ? 'selected' : ''}>Salud</option><option value="type" ${ui.color === 'type' ? 'selected' : ''}>Tipo</option><option value="project" ${ui.color === 'project' ? 'selected' : ''}>Proyecto</option></select></label>
      <span class="sep"></span>
      <label class="rp-chk"><input type="checkbox" data-k="phases" ${ui.phases ? 'checked' : ''}> Etapas</label>
      <label class="rp-chk" title="Línea roja: cuánto se corrió el fin respecto de la fecha planificada"><input type="checkbox" data-k="dev" ${ui.dev ? 'checked' : ''}> Desvíos</label>
      <label class="rp-chk"><input type="checkbox" data-k="team" ${ui.team ? 'checked' : ''}> Carga del equipo</label>
      <span class="grow"></span>
      <span class="rp-maxhint">Esc para salir</span>
      <button class="btn sm" data-act="print" title="Imprimir o guardar como PDF (horizontal)">${icon('printer', 14)} Imprimir / PDF</button>
      ${maxButton()}
    </div>
    <div class="rp-body">
      <div class="rg-print-title"><b>Roadmap de proyectos</b> · ${esc(fmtDate(today))}</div>
      <div class="rg-wrap">
        <div class="rg-left"><div class="rg-hdr"><span style="flex:1">Proyecto</span><span>Avance</span></div><div class="rg-lrows" data-left></div></div>
        <div class="rg-right" data-right></div>
      </div>
      <div class="rg-legend" data-legend></div>
      <div class="rg-load" data-load></div>
    </div>
  </div>
  <aside class="rp-drawer" data-drawer><header><div style="flex:1" data-dt></div><button class="icon-btn" data-act="close" aria-label="Cerrar">${icon('x', 16)}</button></header><div class="bd" data-db></div></aside>`;
  // El panel lateral vive en el body (para que no lo tape la pantalla completa)
  const drawer = el.querySelector('[data-drawer]');
  document.body.appendChild(drawer);
  const L = el.querySelector('[data-left]');
  const R = el.querySelector('[data-right]');

  const typeColor = (p) => p.type_color || p.color || '#64748b';
  const barColor = (p) => (ui.color === 'health' ? HEALTH[p.health]?.[1] || '#64748b' : ui.color === 'type' ? typeColor(p) : p.color || '#64748b');
  const keyOf = {
    sector: (p) => p.sector_name || 'Sin sector IT', type: (p) => p.type_name || 'Sin tipo', lead: (p) => p.lead_name || 'Sin responsable', status: (p) => p.status_label,
    area: (p) => p.area_name || 'Sin área', priority: (p) => p.priority_label || 'Sin prioridad', '': () => '',
  };

  function visible() {
    const text = ui.q.trim().toLowerCase();
    return data.rows.filter((p) => (ui.status === 'open' ? !['done', 'cancelled'].includes(p.portfolio_status) : !ui.status || p.portfolio_status === ui.status)
      && (!text || [p.key, p.name, p.lead_name, p.type_name].some((x) => String(x || '').toLowerCase().includes(text))));
  }
  function model() {
    const list = visible();
    const groups = new Map();
    for (const p of list) { const g = keyOf[ui.group](p); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
    const rows = [];
    const nodate = [];
    for (const [g, ps] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'))) {
      const dated = ps.filter((p) => p.start && p.end).sort((a, b) => a.start.localeCompare(b.start));
      nodate.push(...ps.filter((p) => !(p.start && p.end)));
      if (!dated.length) continue;
      if (g) rows.push({ kind: 'grp', label: g, n: dated.length });
      for (const p of dated) {
        rows.push({ kind: 'p', p });
        if (open.has(p.key) || (ui.phases && !open.has(`-${p.key}`))) for (const f of p.phases.filter((x) => x.start_date && x.due_date)) rows.push({ kind: 'ph', p, f });
      }
    }
    return { rows, nodate };
  }
  const expanded = (p) => open.has(p.key) || (ui.phases && !open.has(`-${p.key}`));

  function range(rows) {
    const ps = rows.filter((r) => r.kind === 'p').map((r) => r.p);
    let start = ps.reduce((a, p) => (p.start < a ? p.start : a), addDays(today, -30));
    let end = ps.reduce((a, p) => (p.end > a ? p.end : a), addDays(today, 120));
    start = `${addDays(start, -14).slice(0, 7)}-01`;
    const e = D(addDays(end, 21));
    end = iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0)));
    return [start, end];
  }

  function draw(pxOverride) {
    save();
    const px = pxOverride || PX[ui.zoom];
    const z = pxOverride ? (px < 2 ? 'y' : px < 4 ? 'q' : 'm') : ui.zoom;
    const { rows, nodate } = model();
    const [START, END] = range(rows);
    const days = diff(START, END) + 1;
    const W = days * px;
    const x = (s) => diff(START, s) * px;
    L.innerHTML = rows.map((r) => {
      if (r.kind === 'grp') return `<div class="rg-row grp">${esc(r.label)} <span class="muted" style="font-weight:600">· ${r.n}</span></div>`;
      if (r.kind === 'p') {
        const p = r.p;
        return `<div class="rg-row" data-k="${esc(p.key)}" style="cursor:pointer" title="${esc(p.name)}"><button class="rg-chev" data-tg="${esc(p.key)}" ${p.phases.length ? '' : 'disabled'} aria-label="Ver etapas">${p.phases.length ? (expanded(p) ? '▾' : '▸') : ''}</button><span class="rg-key" style="background:${esc(p.color)}">${esc(p.key)}</span><span class="ellip" style="font-weight:600;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span>${p.lead_id ? avatar(p.lead_id, 20) : ''}<b style="width:38px;text-align:right;font-size:12px">${p.progress}%</b></div>`;
      }
      const f = r.f;
      return `<div class="rg-row rg-ph"><span class="ex-dot" style="background:${f.state === 'done' ? 'var(--ok)' : f.state === 'active' ? 'var(--info)' : '#cbd5e1'}"></span><span class="ellip" style="overflow:hidden;text-overflow:ellipsis">${esc(f.title)}</span><span class="muted" style="width:38px;text-align:right">${f.pct}%</span></div>`;
    }).join('') + (nodate.length ? `<div class="rg-row grp">Sin fechas <span class="muted" style="font-weight:600">· ${nodate.length}</span></div>${nodate.map((p) => `<div class="rg-row nodate" data-k="${esc(p.key)}" style="cursor:pointer"><span class="rg-chev"></span><span class="rg-key" style="background:${esc(p.color)}">${esc(p.key)}</span><span class="ellip" style="overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span><small>cargá inicio y fin</small></div>`).join('')}` : '')
      || '<div class="rg-row muted">No hay proyectos con estos filtros.</div>';

    // Encabezado: meses y semanas (o trimestres)
    let months = '';
    let ticks = '';
    for (let d = D(START); iso(d) <= END;) {
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      const last = iso(new Date(next - 864e5)) > END ? END : iso(new Date(next - 864e5));
      const w = (diff(iso(d), last) + 1) * px;
      const name = z === 'q' || z === 'y' ? cap(MONTHS[d.getUTCMonth()].slice(0, 3)) : cap(MONTHS[d.getUTCMonth()]);
      months += `<div style="width:${w}px">${name}${z === 'y' && d.getUTCMonth() ? '' : ` ${d.getUTCFullYear()}`}</div>`;
      if (z === 'q' && d.getUTCMonth() % 3 === 0) {
        const qEnd = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0)));
        ticks += `<div style="width:${(diff(iso(d), qEnd > END ? END : qEnd) + 1) * px}px">T${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}</div>`;
      }
      d = next;
    }
    let wk = '';
    if (z === 'w' || z === 'm') {
      let s = START;
      while (D(s).getUTCDay() !== 1) s = addDays(s, 1);
      ticks = `<div style="width:${diff(START, s) * px}px;border:0"></div>`;
      for (; s <= END; s = addDays(s, 7)) ticks += `<div style="width:${7 * px}px">${z === 'w' ? 'Sem. ' : ''}${s.slice(8)}/${s.slice(5, 7)}</div>`;
      if (z === 'w') for (let d = START; d <= END; d = addDays(d, 1)) if (D(d).getUTCDay() === 6) wk += `<div class="rg-wkend" style="left:${x(d)}px;width:${2 * px}px"></div>`;
    }
    let bars = '';
    let y = 52;
    for (const r of rows) {
      const h = r.kind === 'p' ? 38 : 30;
      if (r.kind === 'p') {
        const p = r.p;
        const c = barColor(p);
        const w = Math.max(6, (diff(p.start, p.end) + 1) * px);
        bars += `<div class="rg-bar" data-k="${esc(p.key)}" title="${esc(`${p.key} · ${p.name}\n${fmtDate(p.start)} → ${fmtDate(p.end)} · ${p.progress}%`)}" style="--c:${c};left:${x(p.start)}px;width:${w}px;top:${y + 7}px;background:color-mix(in srgb,${c} 38%,white)"><i class="rg-fill" style="width:${p.progress}%"></i><span>${w > 140 ? `${esc(p.name)} · ${p.progress}%` : `${p.progress}%`}</span></div>`;
        bars += `<div class="rg-ms" style="left:${x(p.end) + px - 6}px;top:${y + 12}px"></div>`;
        if (ui.dev && p.baseline_end && p.end > p.baseline_end) bars += `<div class="rg-dev" title="Fin planificado ${fmtDate(p.baseline_end)}: ${diff(p.baseline_end, p.end)} días de desvío" style="left:${x(p.baseline_end) + px}px;width:${diff(p.baseline_end, p.end) * px}px;top:${y + 33}px"></div>`;
      } else if (r.kind === 'ph') {
        const f = r.f;
        const c = barColor(r.p);
        const w = Math.max(4, (diff(f.start_date, f.due_date) + 1) * px);
        bars += `<div class="rg-bar rg-ph" data-k="${esc(r.p.key)}" title="${esc(`${f.title}\n${fmtDate(f.start_date)} → ${fmtDate(f.due_date)} · ${f.pct}%`)}" style="--c:color-mix(in srgb,${c} 80%,white);left:${x(f.start_date)}px;width:${w}px;top:${y + 7}px;background:color-mix(in srgb,${c} 22%,white)"><i class="rg-fill" style="width:${f.pct}%"></i><span>${w > 70 ? esc(f.title) : ''}</span></div>`;
      }
      y += h;
    }
    const height = y + nodate.length * 38 + (nodate.length ? 30 : 0);
    R.innerHTML = `<div class="rg-tl" style="width:${W}px;height:${Math.max(height, 200)}px">
      <div class="rg-hdr"><div class="rg-months">${months}</div><div class="rg-ticks">${ticks}</div></div>
      ${wk}${rows.map((r) => `<div class="rg-row ${r.kind === 'grp' ? 'grp' : r.kind === 'ph' ? 'rg-ph' : ''}"></div>`).join('')}
      ${bars}${today >= START && today <= END ? `<div class="rg-today" style="left:${x(today)}px"></div>` : ''}</div>`;
    R.onscroll = () => { L.scrollTop = R.scrollTop; };
    el.querySelector('[data-legend]').innerHTML = (ui.color === 'health'
      ? Object.entries(HEALTH).filter(([k]) => k !== 'none').map(([, [l, c]]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')
      : ui.color === 'type' ? [...new Map(data.rows.map((p) => [p.type_name || 'Sin tipo', typeColor(p)])).entries()].map(([l, c]) => `<span><i style="background:${esc(c)}"></i>${esc(l)}</span>`).join('') : '<span>Cada proyecto con su color</span>')
      + '<span><i style="border-top:2px dashed var(--danger);height:0;border-radius:0;background:none"></i>Desvío desde el fin planificado (◇)</span><span>◆ Fin del proyecto</span><span>Parte llena de la barra = avance</span>';
    drawLoad();
    return { START, px };
  }

  function drawLoad() {
    const box = el.querySelector('[data-load]');
    if (!ui.team) { box.innerHTML = ''; return; }
    const users = data.load.users.filter((u) => u.counts.some(Boolean)).sort((a, b) => userName(a.id).localeCompare(userName(b.id), 'es'));
    const heat = (n) => (n >= 6 ? ['#fde2e2', '#b91c1c'] : n >= 4 ? ['#fff1d6', '#92400e'] : n > 0 ? ['#e3f5ec', '#065f46'] : ['transparent', '#c0c5cd']);
    box.innerHTML = `<table><thead><tr><th>Carga del equipo · tareas abiertas por semana</th>${data.load.weeks.map((w) => `<th>${w.slice(8)}/${w.slice(5, 7)}</th>`).join('')}</tr></thead>
      <tbody>${users.map((u) => `<tr><td>${avatar(u.id, 20)} ${esc(userName(u.id) || 'Usuario')}</td>${u.counts.map((n) => { const [bg, fg] = heat(n); return `<td><div class="rg-heat" style="background:${bg};color:${fg}">${n || '·'}</div></td>`; }).join('')}</tr>`).join('')
      || `<tr><td colspan="${data.load.weeks.length + 1}" class="muted">Nadie tiene tareas abiertas asignadas.</td></tr>`}</tbody></table>`;
  }

  function scrollToday() {
    const { START, px } = last;
    R.scrollLeft = Math.max(0, diff(START, today) * px - R.clientWidth / 3);
  }

  function openDrawer(p) {
    const [hl, hc] = HEALTH[p.health] || HEALTH.none;
    drawer.querySelector('[data-dt]').innerHTML = `<span class="rg-key" style="background:${esc(p.color)}">${esc(p.key)}</span> <b style="font-size:16px">${esc(p.name)}</b><div class="small muted" style="margin-top:4px">${esc([p.type_name, p.sector_name].filter(Boolean).join(' · '))}</div>`;
    drawer.querySelector('[data-db]').innerHTML = `
      <div class="rp-kv">
        <span>Estado</span><span><span class="badge" style="--c:${hc}">${esc(p.status_label)}</span> <span class="badge" style="--c:${hc}">${hl}</span></span>
        <span>Líder</span><span>${p.lead_id ? `${avatar(p.lead_id, 20)} ${esc(p.lead_name || userName(p.lead_id))}` : '<span class="warn-text">Sin responsable</span>'}</span>
        <span>Fechas</span><span>${p.start ? fmtDate(p.start) : '—'} → ${p.end ? fmtDate(p.end) : '—'}${p.baseline_end && p.end && p.end > p.baseline_end ? `<br><small class="danger-text">Fin planificado ${fmtDate(p.baseline_end)} · ${diff(p.baseline_end, p.end)} días de desvío</small>` : ''}</span>
        <span>Área</span><span>${esc(p.area_name || '—')}</span>
        <span>Prioridad</span><span>${esc(p.priority_label || '—')}</span>
        <span>Horas</span><span>${p.hours} h${p.estimated_hours !== null && p.estimated_hours !== undefined ? ` de ${Number(p.estimated_hours)} estimadas` : ''}</span>
        <span>Etapa actual</span><span>${esc(p.current_phase || '—')}</span>
        <span>Tickets</span><span>${(p.ticket_numbers || []).map((n) => `<a href="#/tickets/${n}">#${n}</a>`).join(', ') || '—'}</span>
      </div>
      <div><div class="small" style="display:flex;justify-content:space-between;margin-bottom:4px"><b>Avance</b><b>${p.progress}%</b></div><div class="progress"><span style="width:${p.progress}%;background:${esc(p.color)}"></span></div></div>
      ${p.phases.length ? `<div><b class="small">Etapas</b>${p.phases.map((f) => `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line-2)"><span style="flex:1">${esc(f.title)}<br><small class="muted">${f.start_date ? fmtDate(f.start_date) : '—'} → ${f.due_date ? fmtDate(f.due_date) : '—'}</small></span><b>${f.pct}%</b></div>`).join('')}</div>` : ''}
      <a class="btn" style="justify-content:center" href="#/projects/${esc(p.key)}">${icon('external', 14)} Abrir el proyecto</a>`;
    drawer.classList.add('open');
  }
  const closeDrawer = () => drawer.classList.remove('open');
  drawer.addEventListener('click', (e) => { if (e.target.closest('[data-act=close]') || e.target.closest('a[href]')) closeDrawer(); });

  let last = draw();
  scrollToday();
  const redraw = () => { const keep = R.scrollLeft; const keepTop = R.scrollTop; last = draw(); R.scrollLeft = keep; R.scrollTop = keepTop; };
  window.addEventListener('rp:resize', redraw);

  el.addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]');
    if (z) { ui.zoom = z.dataset.z; el.querySelectorAll('[data-z]').forEach((b) => b.classList.toggle('on', b === z)); last = draw(); scrollToday(); return; }
    const tg = e.target.closest('[data-tg]');
    if (tg) {
      const k = tg.dataset.tg;
      const p = data.rows.find((x) => x.key === k);
      if (expanded(p)) { open.delete(k); if (ui.phases) open.add(`-${k}`); } else { open.add(k); open.delete(`-${k}`); }
      redraw();
      return;
    }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'today') scrollToday();
    if (a === 'print') {
      // Todo el período en el ancho de una hoja horizontal
      const { rows } = model();
      const [s, en] = range(rows);
      last = draw(Math.max(0.6, 760 / (diff(s, en) + 1)));
      setTimeout(() => { window.print(); last = draw(); scrollToday(); }, 50);
      return;
    }
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k && !e.target.closest('input,select,label')) { const p = data.rows.find((x) => x.key === k); if (p) openDrawer(p); }
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (!k || k === 'q') return;
    ui[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'phases') open.clear();
    redraw();
  });
  el.querySelector('[data-k=q]').addEventListener('input', (e) => { ui.q = e.target.value; redraw(); });
  const onKey = (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer(); };
  document.addEventListener('keydown', onKey);
  return () => { window.removeEventListener('rp:resize', redraw); document.removeEventListener('keydown', onKey); drawer.remove(); };
}
