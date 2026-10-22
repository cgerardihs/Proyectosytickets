// Gráficos SVG livianos (sin dependencias).
import { esc, fmtNum } from './core.js';

/** Barras horizontales: [{ label, value, color, href }] */
export function hbars(rows, { max, unit = '', empty = 'Sin datos' } = {}) {
  if (!rows.length) return `<p class="muted small">${esc(empty)}</p>`;
  const top = max || Math.max(...rows.map((r) => Number(r.value) || 0), 1);
  return `<div class="hbars">${rows.map((r) => {
    const pct = Math.max(2, ((Number(r.value) || 0) / top) * 100);
    const label = `<span class="hb-label" title="${esc(r.label)}">${esc(r.label)}</span>`;
    return `<div class="hb-row">${r.href ? `<a href="${esc(r.href)}">${label}</a>` : label}
      <span class="hb-track"><span class="hb-bar" style="width:${pct}%;background:${esc(r.color || 'var(--brand)')}"></span></span>
      <span class="hb-val">${fmtNum(r.value, 1)}${esc(unit)}</span></div>`;
  }).join('')}</div>`;
}

/** Líneas: labels[], series [{ name, color, values[] (null = sin dato), dashed }] */
export function lineChart(labels, series, { height = 220, width = 760, yLabel = '' } = {}) {
  const W = width, H = height, pl = 34, pr = 10, pt = 10, pb = 26;
  const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined).map(Number));
  const maxV = Math.max(1, ...all);
  const integer = all.every((v) => Number.isInteger(v));
  const niceMax = integer && maxV <= 4 ? Math.max(1, Math.ceil(maxV)) : Math.ceil(maxV / niceStep(maxV)) * niceStep(maxV);
  const x = (i) => pl + (labels.length <= 1 ? 0 : (i * (W - pl - pr)) / (labels.length - 1));
  const y = (v) => pt + (H - pt - pb) * (1 - v / niceMax);
  let ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f * 10) / 10);
  if (integer) ticks = [...new Set(ticks.map(Math.round))];
  const every = Math.ceil(labels.length / Math.max(2, Math.floor(W / 95)));
  const last = labels.length - 1;
  const showLabel = (i) => i === last || (i % every === 0 && last - i >= every * 0.6);
  const grid = ticks.map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${fmtNum(t, 1)}</text>`).join('');
  const xl = labels.map((l, i) => (showLabel(i) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(l)}</text>` : '')).join('');
  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(v)).toFixed(1)} `;
      pen = true;
    });
    const dots = s.dots === false ? '' : s.values.map((v, i) => (v === null || v === undefined ? '' : `<circle cx="${x(i)}" cy="${y(Number(v))}" r="2.6" fill="${esc(s.color)}"><title>${esc(labels[i])}: ${fmtNum(v, 1)} ${esc(s.name)}</title></circle>`)).join('');
    return `<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="5 4"' : ''}/>${dots}`;
  }).join('');
  const legend = series.map((s) => `<span class="lg"><i style="background:${esc(s.color)}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel || series.map((s) => s.name).join(', '))}">${grid}${xl}${paths}</svg><div class="legend">${legend}</div></div>`;
}

/** Columnas agrupadas: labels[], series [{name,color,values[]}] */
export function columns(labels, series, { height = 220, width = 760 } = {}) {
  const W = width, H = height, pl = 34, pr = 10, pt = 10, pb = 26;
  const maxV = Math.max(1, ...series.flatMap((s) => s.values.map(Number)));
  const niceMax = Math.ceil(maxV / niceStep(maxV)) * niceStep(maxV);
  const band = (W - pl - pr) / Math.max(1, labels.length);
  const bw = Math.min(28, (band * 0.7) / series.length);
  const y = (v) => pt + (H - pt - pb) * (1 - v / niceMax);
  const ticks = [0, 0.5, 1].map((f) => Math.round(niceMax * f));
  const grid = ticks.map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${t}</text>`).join('');
  const bars = labels.map((l, i) => {
    const cx = pl + band * i + band / 2;
    const start = cx - (bw * series.length) / 2;
    return series.map((s, j) => {
      const v = Number(s.values[i] || 0);
      return `<rect x="${start + j * bw}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, H - pb - y(v))}" rx="2" fill="${esc(s.color)}"><title>${esc(l)} · ${esc(s.name)}: ${fmtNum(v, 1)}</title></rect>`;
    }).join('') + `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="axis">${esc(String(l).slice(0, 14))}</text>`;
  }).join('');
  const legend = series.map((s) => `<span class="lg"><i style="background:${esc(s.color)}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}</svg><div class="legend">${legend}</div></div>`;
}

/** Barra apilada única (distribución): [{label,value,color}] */
export function stackBar(parts) {
  const total = parts.reduce((a, p) => a + Number(p.value || 0), 0) || 1;
  return `<div class="stack">${parts.filter((p) => p.value > 0).map((p) => `<span style="width:${(p.value / total) * 100}%;background:${esc(p.color)}" title="${esc(p.label)}: ${p.value}"></span>`).join('')}</div>
    <div class="legend">${parts.map((p) => `<span class="lg"><i style="background:${esc(p.color)}"></i>${esc(p.label)} <b>${fmtNum(p.value)}</b></span>`).join('')}</div>`;
}

function niceStep(v) {
  const raw = v / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
