import { state, api, esc, icon, userName, fieldLabel, categoryName, techName, CHANNEL, fmtNum, navigate, buildQuery } from '../core.js';
import { setCrumbs } from '../app.js';
import { hbars } from '../charts.js';

// v1.14: Informes con pestañas. Roadmap, Calendario y Explorador se pueden maximizar (botón, tecla F; Esc vuelve).
const TABS = [['summary', 'Resumen', 'chart'], ['roadmap', 'Roadmap', 'gantt'], ['calendar', 'Calendario', 'calendar'], ['explorer', 'Explorador', 'layers']];

/** Pantalla completa para la pestaña: oculta el menú, la barra superior y los encabezados. */
export function maximizer(host) {
  const set = (on) => {
    document.body.classList.toggle('rp-max', on);
    host.querySelectorAll('[data-max]').forEach((b) => { b.innerHTML = on ? `${icon('minimize', 14)} Salir` : `${icon('maximize', 14)} Maximizar`; b.title = on ? 'Salir de pantalla completa (Esc)' : 'Usar toda la pantalla (F)'; });
    window.dispatchEvent(new Event('rp:resize'));
  };
  const onKey = (e) => {
    const a = document.activeElement;
    if ((a?.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)) || /SELECT|TEXTAREA/.test(a?.tagName) || a?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && document.body.classList.contains('rp-max') && !document.querySelector('.modal-backdrop, .rp-drawer.open')) set(false);
    if (e.key === 'f' || e.key === 'F') set(!document.body.classList.contains('rp-max'));
  };
  host.addEventListener('click', (e) => { if (e.target.closest('[data-max]')) set(!document.body.classList.contains('rp-max')); });
  document.addEventListener('keydown', onKey);
  return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('rp-max'); };
}
export const maxButton = () => `<button class="btn sm" data-max title="Usar toda la pantalla (F)">${icon('maximize', 14)} Maximizar</button>`;

export async function render(el, _p, query) {
  setCrumbs([{ label: 'Informes' }]);
  const tab = TABS.some((t) => t[0] === query.tab) ? query.tab : 'summary';
  el.innerHTML = `<div class="page rp-page ${tab === 'summary' ? '' : 'wide'}">
    <div class="page-head rp-head"><div><h1>Informes</h1><p class="muted">${{ summary: 'Indicadores de la mesa de ayuda en el período elegido.', roadmap: 'Todos los proyectos en una línea de tiempo, con etapas, desvíos y la carga del equipo.', calendar: 'Fechas de proyectos, etapas, tareas, vencimientos de SLA, sprints, sistemas críticos y feriados.', explorer: 'Armá tu propia grilla mezclando tickets, proyectos, tareas, contactos y horas, con cualquier campo.' }[tab]}</p></div></div>
    <div class="tabs rp-tabs">${TABS.map(([k, l, ic]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${icon(ic, 14)} ${l}</button>`).join('')}</div>
    <div data-tab-body></div></div>`;
  el.querySelector('.rp-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) navigate(`#/reports${buildQuery({ tab: b.dataset.tab === 'summary' ? '' : b.dataset.tab, from: b.dataset.tab === 'summary' ? query.from : '', to: b.dataset.tab === 'summary' ? query.to : '' })}`);
  });
  const body = el.querySelector('[data-tab-body]');
  if (tab === 'summary') return renderSummary(body, query);
  const mod = await import({ roadmap: './reports-roadmap.js', calendar: './reports-calendar.js', explorer: './reports-explorer.js' }[tab]);
  const stopMax = maximizer(body);
  const stop = await mod.render(body, query);
  return () => { stopMax(); if (typeof stop === 'function') stop(); };
}

async function renderSummary(el, query) {
  const r = await api(`/reports/helpdesk${buildQuery({ from: query.from, to: query.to })}`);
  const sla = (x) => (x.with_sla ? `${Math.round((x.within_sla / x.with_sla) * 100)}%` : '—');
  const table = (title, rows, nameFn, key) => `<section class="card span3">
    <div class="sec-head"><h3>${esc(title)}</h3><button class="link-btn" data-csv="${key}">${icon('download', 13)} CSV</button></div>
    <div class="table-wrap"><table class="tbl compact num"><thead><tr><th></th><th>Creados</th><th>Resueltos</th><th>% resueltos</th><th>1ª respuesta prom. (h)</th><th>Resolución prom. (h)</th><th>Cumplimiento SLA</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td>${esc(nameFn(x.id))}</td><td>${x.created}</td><td>${x.resolved}</td><td>${x.created ? Math.round((x.resolved / x.created) * 100) : 0}%</td><td>${x.avg_first_h ?? '—'}</td><td>${x.avg_resolution_h ?? '—'}</td><td>${sla(x)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin datos en el período.</td></tr>'}</tbody></table></div></section>`;
  const subName = (id) => {
    const sub = (state.meta.techSubcategories || []).find((x) => x.id === id);
    return sub ? `${techName(sub.tech_category_id).split(' - ')[0]} › ${sub.name}` : 'Sin subcategoría';
  };
  const sets = {
    agent: [r.byAgent, (id) => userName(id) || 'Sin asignar'],
    category: [r.byCategory, (id) => categoryName(id) || 'Sin categoría'],
    tech: [r.byTech, (id) => techName(id) || 'Sin categoría técnica'],
    subtech: [r.bySubtech || [], subName],
    channel: [r.byChannel, (id) => CHANNEL[id] || id],
  };
  el.innerHTML = `<div>
    <div class="page-head"><div><h2>Mesa de ayuda</h2><p class="muted">Tickets creados entre las fechas elegidas.</p></div>
      <form class="row gap" data-range><label class="field inline"><span>Desde</span><input class="input sm" type="date" name="from" value="${esc(r.from)}"></label>
      <label class="field inline"><span>Hasta</span><input class="input sm" type="date" name="to" value="${esc(r.to)}"></label><button class="btn sm">Aplicar</button></form></div>
    <div class="kpis">
      <div class="kpi"><span>Creados</span><b>${fmtNum(r.totals.created)}</b></div>
      <div class="kpi ok"><span>Resueltos</span><b>${fmtNum(r.totals.resolved)}</b></div>
      <div class="kpi"><span>Tasa de resolución</span><b>${r.totals.created ? Math.round((r.totals.resolved / r.totals.created) * 100) : 0}%</b></div>
      <div class="kpi"><span>Horas registradas</span><b>${fmtNum(r.time.reduce((a, x) => a + x.minutes, 0) / 60, 1)}</b></div>
    </div>
    <div class="dash-grid">
      ${table('Por agente', r.byAgent, sets.agent[1], 'agent')}
      ${table(`Por ${fieldLabel('tech').toLowerCase()}`, r.byTech, sets.tech[1], 'tech')}
      <section class="card"><h3>Por ${esc(fieldLabel('category').toLowerCase())}</h3>${hbars(r.byCategory.map((x) => ({ label: categoryName(x.id) || 'Sin categoría', value: x.created, color: 'var(--accent)' })))}</section>
      <section class="card"><h3>Por ${esc(fieldLabel('tech').toLowerCase())}</h3>${hbars(r.byTech.map((x) => ({ label: techName(x.id) || 'Sin categoría técnica', value: x.created })))}</section>
      ${(r.bySubtech || []).some((x) => x.id) ? `<section class="card"><h3>Por ${esc(fieldLabel('subtech').toLowerCase())}</h3>${hbars(r.bySubtech.filter((x) => x.id).map((x) => ({ label: subName(x.id), value: x.created, color: '#7c3aed' })))}</section>` : ''}
      <section class="card"><h3>Por canal</h3>${hbars(r.byChannel.map((x) => ({ label: CHANNEL[x.id] || x.id, value: x.created, color: '#475569' })))}
        <h3 style="margin-top:18px">Tiempo registrado por agente</h3>${hbars(r.time.map((x) => ({ label: userName(x.id), value: Math.round((x.minutes / 60) * 10) / 10, color: '#0891b2' })), { unit: ' h' })}</section>
      ${table(`Por ${fieldLabel('category').toLowerCase()}`, r.byCategory, sets.category[1], 'category')}
    </div></div>`;
  el.querySelector('[data-range]').addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(`#/reports${buildQuery({ from: e.target.from.value, to: e.target.to.value })}`);
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-csv]');
    if (!b) return;
    const [rows, nameFn] = sets[b.dataset.csv];
    const head = ['Nombre', 'Creados', 'Resueltos', '1a respuesta prom (h)', 'Resolucion prom (h)', 'Con SLA', 'Dentro de SLA'];
    const csv = '﻿' + [head, ...rows.map((x) => [nameFn(x.id), x.created, x.resolved, x.avg_first_h ?? '', x.avg_resolution_h ?? '', x.with_sla, x.within_sla])]
      .map((r2) => r2.map((c) => { const t = String(c ?? ''); const safe = /^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t) ? `'${t}` : t; return `"${safe.replace(/"/g, '""')}"`; }).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `informe-${b.dataset.csv}-${r.from}-${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
