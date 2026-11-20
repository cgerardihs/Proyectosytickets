// Informes → Comparativa (v1.25): tickets por mes, trimestre o año. Ingresados, cerrados, abiertos al cierre y tiempo de
// resolución, con comparación contra el período anterior o el año anterior, y el detalle por agente, área, usuario,
// categoría técnica, canal, tipo o prioridad. Prefijo CSS cmp-.
import { state, api, esc, icon, navigate, buildQuery } from '../core.js';
import { maxButton } from './reports.js';

const LS = 'cmp-report';
const MN = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIM_LABEL = { agent: 'Agente', area: 'Área solicitante', user: 'Usuario', tech: 'Categoría técnica', channel: 'Canal', type: 'Tipo de ticket', prio: 'Prioridad' };
const METRIC_LABEL = { in: 'Ingresados', out: 'Cerrados', open: 'Abiertos al cierre', ttr: 'Tiempo de resolución (promedio, horas laborales)' };
// Filtro de la lista de tickets que corresponde a cada dimensión (para abrir los tickets de una celda)
const DIM_FILTER = { agent: 'assignee', area: 'category', user: 'contact', tech: 'tech', channel: 'channel', type: 'type', prio: 'priority' };
const fmt = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 1 });
const sum = (a) => a.reduce((t, v) => t + v, 0);

export async function render(el) {
  let ui = { group: 'month', range: '12', yoy: false, dim: 'agent', metric: 'in', agent: '', area: '', tech: '' };
  try { ui = { ...ui, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { /* sin almacenamiento */ }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(ui)); } catch { /* sin almacenamiento */ } };
  let d = null;

  async function load() {
    el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    try {
      d = await api(`/reports/compare${buildQuery({ range: ui.range, dim: ui.dim, agent: ui.agent, area: ui.area, tech: ui.tech })}`);
      draw();
    } catch (e) { el.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
  }

  // Períodos (mes, trimestre o año) a partir de índices de meses de d.all
  const labelOf = (k) => { const y = k.slice(0, 4); const m = Number(k.slice(5)); return ui.group === 'month' ? `${MN[m - 1]} ${y.slice(2)}` : ui.group === 'quarter' ? `T${Math.ceil(m / 3)} ${y}` : y; };
  function periodsOf(idxs) {
    const out = [];
    for (const i of idxs) {
      const label = labelOf(d.all[i]);
      const last = out.at(-1);
      if (last && last.label === label) last.idx.push(i); else out.push({ label, idx: [i] });
    }
    return out;
  }
  /** Valor de una métrica en un grupo de meses: suma, el último mes (abiertos) o promedio ponderado (tiempo). */
  function agg(src, ix, metric) {
    if (!ix.length) return null;
    if (metric === 'open') return src.open[ix.at(-1)];
    if (metric === 'ttr') { const n = sum(ix.map((i) => src.ttr_n[i])); return n ? Math.round((sum(ix.map((i) => src.ttr_sum[i])) / n / 60) * 10) / 10 : 0; }
    return sum(ix.map((i) => src[metric][i]));
  }
  const rangeIdx = () => d.all.map((_, i) => i).filter((i) => i >= d.from);
  const compIdx = () => (ui.yoy ? rangeIdx().map((i) => i - 12) : rangeIdx().map((i) => i - rangeIdx().length)).filter((i) => i >= 0);

  function delta(cur, prev, goodWhenUp) {
    if (prev === null || prev === undefined || !prev) return '';
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (!pct) return `<span class="cmp-delta">= igual que ${ui.yoy ? 'el año anterior' : 'el período anterior'}</span>`;
    const good = (pct > 0) === goodWhenUp;
    return `<span class="cmp-delta ${good ? 'good' : 'bad'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)} % vs ${ui.yoy ? 'año anterior' : 'período anterior'}</span>`;
  }

  function draw() {
    const ix = rangeIdx();
    const cx = compIdx();
    const S = d.series;
    const ci = agg(S, ix, 'in'); const co = agg(S, ix, 'out'); const oe = agg(S, ix, 'open'); const tr = agg(S, ix, 'ttr');
    const full = cx.length === ix.length;
    const agents = state.meta.users.filter((u) => u.active && u.role !== 'superadmin');
    const yr = new Date().getFullYear();
    el.innerHTML = `<div class="cmp">
      <div class="cmp-bar">
        <div class="cmp-seg" role="group" aria-label="Agrupar por">${[['month', 'Mes'], ['quarter', 'Trimestre'], ['year', 'Año']].map(([k, l]) => `<button data-group="${k}" class="${ui.group === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="input sm" data-ui="range" aria-label="Período">${[['12', 'Últimos 12 meses'], ...[0, 1, 2].map((n) => [String(yr - n), `Año ${yr - n}`]), ['all', 'Desde el comienzo']].map(([v, l]) => `<option value="${v}" ${ui.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="check sm"><input type="checkbox" data-yoy ${ui.yoy ? 'checked' : ''}> Comparar con el año anterior</label>
        <span class="grow"></span><button class="btn sm" data-csv>${icon('download', 14)} Excel</button>${maxButton()}
      </div>
      <div class="cmp-filters">
        <select class="input sm" data-ui="agent" aria-label="Agente"><option value="">Todos los agentes</option>${agents.map((u) => `<option value="${u.id}" ${String(u.id) === String(ui.agent) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <select class="input sm" data-ui="area" aria-label="Área solicitante"><option value="">Todas las áreas</option>${(state.meta.categories || []).map((c) => `<option value="${c.id}" ${String(c.id) === String(ui.area) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <select class="input sm" data-ui="tech" aria-label="Categoría técnica"><option value="">Todas las categorías técnicas</option>${(state.meta.techCategories || []).map((c) => `<option value="${c.id}" ${String(c.id) === String(ui.tech) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        ${ui.agent || ui.area || ui.tech ? '<button class="link-btn small" data-clear>Limpiar filtros</button>' : ''}
      </div>
      <div class="cmp-kpis">
        <div class="cmp-kpi"><span><i class="cmp-in"></i>Ingresados</span><b>${fmt(ci)}</b>${full ? delta(ci, agg(S, cx, 'in'), false) : ''}</div>
        <div class="cmp-kpi"><span><i class="cmp-out"></i>Cerrados</span><b>${fmt(co)}</b>${full ? delta(co, agg(S, cx, 'out'), true) : ''}</div>
        <div class="cmp-kpi"><span>Diferencia</span><b class="${co >= ci ? 'cmp-good' : 'cmp-bad'}">${co >= ci ? '−' : '+'}${fmt(Math.abs(ci - co))}</b><span class="muted small">${co >= ci ? 'se cerraron más de los que entraron' : 'entraron más de los que se cerraron'}</span></div>
        <div class="cmp-kpi"><span><i class="cmp-open"></i>Abiertos al cierre</span><b>${fmt(oe)}</b><span class="muted small">al último día del período</span></div>
        <div class="cmp-kpi"><span>Tiempo de resolución</span><b>${fmt(tr)} h</b>${full ? delta(tr, agg(S, cx, 'ttr'), false) : ''}</div>
      </div>
      <section class="card cmp-card"><h3>Ingresados y cerrados</h3>
        <div class="cmp-legend"><span><i class="cmp-in"></i>Ingresados</span><span><i class="cmp-out"></i>Cerrados</span><span><i class="cmp-open line"></i>Abiertos al cierre</span>${ui.yoy ? '<span><i class="dash"></i>Ingresados el año anterior</span>' : ''}</div>
        <div class="cmp-chart">${chartSvg()}</div></section>
      <section class="card cmp-card">
        <div class="cmp-pivot-head"><h3>Detalle</h3><span class="muted small">Ver por</span>
          <select class="input sm" data-ui="dim" aria-label="Ver por">${Object.entries(DIM_LABEL).map(([k, l]) => `<option value="${k}" ${ui.dim === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="muted small">Contar</span>
          <select class="input sm" data-ui="metric" aria-label="Qué contar">${Object.entries(METRIC_LABEL).map(([k, l]) => `<option value="${k}" ${ui.metric === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${ui.metric === 'in' ? '<span class="muted small">Tocá una celda para ver esos tickets.</span>' : ''}</div>
        <div class="table-wrap">${pivotHtml()}</div></section>
    </div>`;
  }

  function chartSvg() {
    const ps = periodsOf(rangeIdx());
    if (!ps.length) return '<p class="muted">Sin datos.</p>';
    const S = d.series;
    const H = 260; const P = { l: 40, r: 50, t: 14, b: 30 };
    const W = Math.max(700, ps.length * 64 + P.l + P.r);
    const vals = ps.map((p) => {
      const prev = p.idx.map((i) => i - 12);
      return { in: agg(S, p.idx, 'in'), out: agg(S, p.idx, 'out'), open: agg(S, p.idx, 'open'), py: ui.yoy && prev.every((i) => i >= 0) ? agg(S, prev, 'in') : null };
    });
    const max = Math.max(1, ...vals.flatMap((v) => [v.in, v.out, v.py || 0])) * 1.12;
    const maxO = Math.max(1, ...vals.map((v) => v.open)) * 1.15;
    const bw = (W - P.l - P.r) / ps.length;
    const y = (v) => P.t + (H - P.t - P.b) * (1 - v / max);
    const yo = (v) => P.t + (H - P.t - P.b) * (1 - v / maxO);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(max * f)}" y2="${y(max * f)}" class="cmp-grid"/><text x="${P.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${Math.round(max * f)}</text>
      <text x="${W - P.r + 6}" y="${yo(maxO * f) + 4}" text-anchor="start" class="cmp-axis-o">${Math.round(maxO * f)}</text>`).join('');
    const bars = vals.map((v, i) => {
      const x = P.l + i * bw; const w = Math.min(22, bw * 0.32);
      return `<rect class="cmp-bar-in" x="${x + bw / 2 - w - 2}" y="${y(v.in)}" width="${w}" height="${Math.max(0, y(0) - y(v.in))}" rx="3"><title>${esc(ps[i].label)}: ${v.in} ingresados</title></rect>
        <rect class="cmp-bar-out" x="${x + bw / 2 + 2}" y="${y(v.out)}" width="${w}" height="${Math.max(0, y(0) - y(v.out))}" rx="3"><title>${esc(ps[i].label)}: ${v.out} cerrados</title></rect>
        <text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(ps[i].label)}</text>`;
    }).join('');
    const line = vals.map((v, i) => `${P.l + i * bw + bw / 2},${yo(v.open)}`).join(' ');
    const dots = vals.map((v, i) => `<circle cx="${P.l + i * bw + bw / 2}" cy="${yo(v.open)}" r="3.5" class="cmp-dot"><title>${esc(ps[i].label)}: ${v.open} abiertos al cierre</title></circle>`).join('');
    const py = vals.map((v, i) => (v.py === null ? null : `${P.l + i * bw + bw / 2},${y(v.py)}`)).filter(Boolean).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Ingresados y cerrados por período">${grid}${bars}
      <polyline points="${line}" class="cmp-line"/>${dots}${py ? `<polyline points="${py}" class="cmp-py"/>` : ''}</svg>`;
  }

  function pivotData() {
    const ps = periodsOf(rangeIdx());
    const M = ui.metric;
    const rows = d.rows.map((r) => {
      const cells = ps.map((p) => agg(r, p.idx, M));
      const all = rangeIdx();
      return { key: r.key, name: r.name, cells, total: agg(r, all, M) };
    }).filter((r) => r.cells.some((v) => v) || r.total);
    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const totals = ps.map((p) => agg(d.series, p.idx, M));
    return { ps, rows, totals, grand: agg(d.series, rangeIdx(), M) };
  }

  function pivotHtml() {
    const { ps, rows, totals, grand } = pivotData();
    const M = ui.metric;
    if (!rows.length) return '<p class="muted">No hay tickets en el período con estos filtros.</p>';
    const max = Math.max(1, ...rows.flatMap((r) => r.cells));
    const rgb = { in: '200,16,46', out: '5,150,105', open: '100,116,139', ttr: '217,119,6' }[M];
    const unit = M === 'ttr' ? ' h' : '';
    const spark = (arr) => { const m = Math.max(...arr, 1); const w = 70; const h = 18; const pts = arr.map((v, i) => `${(i / Math.max(1, arr.length - 1)) * w},${h - (v / m) * h}`).join(' '); return `<svg class="cmp-spark" width="${w}" height="${h}" viewBox="0 -1 ${w} ${h + 2}" aria-hidden="true"><polyline points="${pts}"/></svg>`; };
    const trend = (cells) => {
      const a = cells.at(-1); const b = cells.at(-2);
      if (b === undefined || !b) return '<span class="muted">—</span>';
      const pct = Math.round(((a - b) / b) * 100);
      const good = M === 'out' ? pct > 0 : pct < 0;
      return `<span class="cmp-var ${pct === 0 ? '' : good ? 'good' : 'bad'}">${pct > 0 ? '▲' : pct < 0 ? '▼' : '='} ${Math.abs(pct)} %</span>`;
    };
    return `<table class="cmp-tbl"><thead><tr><th>${DIM_LABEL[ui.dim]}</th>${ps.map((p) => `<th>${esc(p.label)}</th>`).join('')}<th>${M === 'ttr' ? 'Promedio' : M === 'open' ? 'Al cierre' : 'Total'}</th><th>Tendencia</th><th title="Último período contra el anterior">Var.</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="cmp-name" title="${esc(r.name)}">${esc(r.name)}</td>${r.cells.map((v, j) => `<td class="${M === 'in' && v && !['none', 'others'].includes(r.key) ? 'cmp-cell' : ''}" style="background: rgba(${rgb}, ${(0.05 + (v / max) * 0.32).toFixed(3)})" ${M === 'in' && v && !['none', 'others'].includes(r.key) ? `data-open="${esc(r.key)}" data-p="${j}" title="Ver estos tickets"` : ''}>${fmt(v)}${unit}</td>`).join('')}
        <td><b>${fmt(r.total)}${unit}</b></td><td>${spark(r.cells)}</td><td>${trend(r.cells)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="cmp-tot"><td>${M === 'ttr' ? 'Promedio' : 'Total'}</td>${totals.map((v) => `<td>${fmt(v)}${unit}</td>`).join('')}<td>${fmt(grand)}${unit}</td><td>${spark(totals)}</td><td></td></tr></tfoot></table>`;
  }

  function csv() {
    const { ps, rows, totals, grand } = pivotData();
    const cell = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const num = (v) => String(v ?? '').replace('.', ',');
    const lines = [[DIM_LABEL[ui.dim], ...ps.map((p) => p.label), 'Total'].map(cell).join(';'),
      ...rows.map((r) => [r.name, ...r.cells.map(num), num(r.total)].map(cell).join(';')),
      ['Total', ...totals.map(num), num(grand)].map(cell).join(';')];
    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `comparativa-${ui.dim}-${ui.metric}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-group]');
    if (g) { ui.group = g.dataset.group; save(); return draw(); }
    if (e.target.closest('[data-csv]')) return csv();
    if (e.target.closest('[data-clear]')) { ui.agent = ''; ui.area = ''; ui.tech = ''; save(); return load(); }
    const c = e.target.closest('[data-open]');
    if (c) {
      // Abre la lista de tickets ingresados en ese período con ese valor
      const p = periodsOf(rangeIdx())[Number(c.dataset.p)];
      const first = d.all[p.idx[0]]; const last = d.all[p.idx.at(-1)];
      const [ly, lm] = last.split('-').map(Number);
      const to = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);
      const qd = { view: 'all', created_from: `${first}-01`, created_to: to, [DIM_FILTER[ui.dim]]: c.dataset.open };
      if (ui.agent) qd.assignee = ui.agent;
      if (ui.area) qd.category = ui.area;
      if (ui.tech) qd.tech = ui.tech;
      navigate(`#/tickets${buildQuery(qd)}`);
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-yoy]')) { ui.yoy = e.target.checked; save(); return draw(); }
    const s = e.target.closest('[data-ui]');
    if (!s) return;
    ui[s.dataset.ui] = s.value;
    save();
    if (['range', 'dim', 'agent', 'area', 'tech'].includes(s.dataset.ui)) load(); else draw();
  });
  await load();
}
