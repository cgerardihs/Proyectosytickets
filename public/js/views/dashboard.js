import { state, api, esc, icon, techName, fieldLabel, userName, categoryName, PRIORITY, PRIORITY_COLOR, fmtNum, fmtShortDate, relTime, isManager, options } from '../core.js';
import { setCrumbs } from '../app.js';
import { hbars, lineChart } from '../charts.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function render(el, _p, query) {
  const scope = query.scope === 'team' ? 'team' : 'mine';
  const agent = scope === 'team' && query.agent ? Number(query.agent) : null;
  setCrumbs([{ label: 'Inicio' }]);
  const [h, work, team] = await Promise.all([
    api(`/home?scope=${scope}${agent ? `&agent=${agent}` : ''}`),
    api('/my-work'),
    scope === 'team' && !agent ? api('/dashboard?scope=all') : null,
  ]);
  const mineQ = scope === 'mine' ? '&assignee=me' : agent ? `&assignee=${agent}` : '';
  const first = state.me.name.split(' ')[0];
  const today = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const who = scope === 'mine' ? 'tus tickets' : agent ? `los tickets de ${userName(agent)}` : 'los tickets del equipo';

  el.innerHTML = `<div class="page home">
    <div class="page-head">
      <div><h1>Hola, ${esc(first)}</h1><p class="muted">Tablero de control · ${esc(today)}</p></div>
      <div class="row gap wrap">
        ${scope === 'team' && isManager() ? `<select class="input sm" id="agentSel" aria-label="Agente"><option value="">Todos los agentes</option>${options(state.meta.users.filter((u) => u.active && !u.system), agent)}</select>` : ''}
        <div class="seg">
          <a href="#/?scope=mine" class="${scope === 'mine' ? 'on' : ''}">Mis tickets</a>
          <a href="#/?scope=team" class="${scope === 'team' ? 'on' : ''}">Todo el equipo</a>
        </div>
      </div>
    </div>
    ${alertsHtml(h, mineQ)}
    <div class="kpis six">
      ${kpi('Abiertos asignados', fmtNum(h.kpis.open), `#/tickets?view=unresolved${mineQ}`)}
      ${kpi('Antigüedad promedio', `${fmtNum(h.kpis.avg_age)} d`, null, h.kpis.avg_age > h.config.amber_days ? 'danger' : h.kpis.avg_age > h.config.green_days ? 'warn' : 'ok')}
      ${kpi('SLA vencido', fmtNum(h.kpis.overdue), `#/tickets?view=overdue${mineQ}`, h.kpis.overdue ? 'danger' : '')}
      ${kpi(`Sin actividad > ${h.config.inactive_days} d`, fmtNum(h.kpis.inactive), `#/tickets?view=unresolved${mineQ}&sort=activity&order=asc`, h.kpis.inactive ? 'warn' : '')}
      ${kpi('Esperando al usuario', fmtNum(h.kpis.pending), `#/tickets?view=unresolved&status_kind=pending${mineQ}`, 'muted')}
      ${kpi('Resueltos esta semana', fmtNum(h.kpis.resolved_week), '#/tickets?view=archived&sort=updated', 'ok')}
    </div>
    <section class="card">
      <div class="sec-head"><h3>${icon('chart', 16)} Antigüedad de ${esc(who)} abiertos</h3>
        <span class="muted small">Verde hasta ${h.config.green_days} d · ámbar hasta ${h.config.amber_days} d · rojo después · alerta crítica más de ${h.config.critical_days} d${state.me.role === 'admin' || state.me.role === 'superadmin' ? ' · <a href="#/settings/aging">configurar</a>' : ''}</span></div>
      ${histogramHtml(h.histogram)}
    </section>
    <div class="dash-grid two">
      <section class="card">
        <div class="sec-head"><h3>${icon('clock', 16)} ${scope === 'mine' ? 'Mis tickets' : 'Tickets'} más viejos</h3><a class="link-btn" href="#/tickets?view=unresolved${mineQ}&sort=created&order=asc">Ver todos</a></div>
        ${h.oldest.length ? `<table class="tbl compact aging"><thead><tr><th>Ticket</th><th class="r">Edad</th><th>Última actividad</th></tr></thead><tbody>
          ${h.oldest.map((t) => `<tr><td><a href="#/tickets/${t.number}"><b>#${t.number}</b> ${esc(t.subject)}</a><small class="muted block">${esc(t.contact_name || '')} · ${esc(t.status_name)}${scope === 'team' && t.assignee_id ? ` · ${esc(userName(t.assignee_id))}` : ''}</small></td>
            <td class="r"><span class="age ${ageLevel(t.age_days, h.config)}">${fmtNum(t.age_days)} d</span></td>
            <td class="nowrap ${t.idle_days > h.config.inactive_days ? 'warn-text' : 'muted'}">${relTime(t.last_activity_at)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small">No hay tickets abiertos.</p>'}
      </section>
      <section class="card">
        <div class="sec-head"><h3>${icon('zap', 16)} ${scope === 'mine' ? 'Mis tickets' : 'Tickets'} más importantes</h3><span class="muted small">Ordenados por puntaje</span></div>
        ${h.important.length ? `<ul class="imp-list">${h.important.map(impHtml).join('')}</ul>
          <p class="hint">El puntaje suma prioridad, SLA, antigüedad, respuestas pendientes, reaperturas, usuarios VIP y seguidores.</p>` : '<p class="muted small">No hay tickets abiertos.</p>'}
      </section>
    </div>
    ${scope === 'mine' ? `<div class="dash-grid two">
      <section class="card">
        <h3>${icon('checkbox', 16)} Mis tareas de proyecto</h3>
        ${work.issues.length ? `<ul class="mini-list">${work.issues.slice(0, 8).map((i) => `<li><a href="#/issue/${esc(i.key)}"><b style="color:${esc(i.project_color)}">${esc(i.key)}</b> ${esc(i.title)}</a><small>${esc(i.status_name || '')}${i.due_date ? ` · vence ${fmtShortDate(i.due_date)}` : ''}</small></li>`).join('')}</ul>` : '<p class="muted small">Sin tareas asignadas.</p>'}
        <a class="link-btn" href="#/my-work">Ver todo mi trabajo →</a>
      </section>
      <section class="card">
        <h3>${icon('ticket', 16)} Por vencer</h3>
        ${work.tickets.filter((t) => t.resolution_due).length ? `<table class="tbl compact"><tbody>${work.tickets.filter((t) => t.resolution_due).slice(0, 8).map((t) => `<tr><td><a href="#/tickets/${t.number}"><b>#${t.number}</b> ${esc(t.subject)}</a></td><td class="nowrap ${new Date(t.resolution_due) < new Date() ? 'danger-text' : 'muted'}">vence ${relTime(t.resolution_due)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No tenés tickets con vencimiento.</p>'}
      </section>
    </div>` : ''}
    ${team ? teamHtml(team) : ''}
  </div>`;

  el.querySelector('#agentSel')?.addEventListener('change', (e) => {
    location.hash = `#/?scope=team${e.target.value ? `&agent=${e.target.value}` : ''}`;
  });
}

function kpi(label, value, href, cls = '') {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${cls}" ${href ? `href="${href}"` : ''}><span>${esc(label)}</span><b>${value}</b></${tag}>`;
}

const ageLevel = (d, c) => (d > c.critical_days ? 'critical' : d > c.amber_days ? 'danger' : d > c.green_days ? 'warn' : 'ok');

function alertsHtml(h, mineQ) {
  const a = h.alerts;
  const items = [];
  if (a.critical.n) {
    items.push(`<a class="alert critical" href="#/tickets/${a.critical.oldest?.number || ''}">${icon('alert', 20)}<div><b>${plural(a.critical.n, 'ticket', 'tickets')} con más de ${h.config.critical_days} días</b>
      ${a.critical.oldest ? `<span>El más viejo: #${a.critical.oldest.number} · ${fmtNum(a.critical.oldest.age_days)} días</span>` : ''}</div></a>`);
  }
  if (a.overdue.n || a.due_today.n) {
    const parts = [];
    if (a.overdue.n) parts.push(`${a.overdue.n} con SLA vencido`);
    if (a.due_today.n) parts.push(`${a.due_today.n} ${a.due_today.n === 1 ? 'vence' : 'vencen'} hoy${a.due_today.first ? ` ${new Date(a.due_today.first.resolution_due).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} hs` : ''}`);
    const f = a.overdue.first || a.due_today.first;
    items.push(`<a class="alert warn" href="#/tickets?view=${a.overdue.n ? 'overdue' : 'unresolved&sort=due&order=asc'}${mineQ}">${icon('clock', 20)}<div><b>${esc(parts.join(' · '))}</b>
      ${f ? `<span>#${f.number} ${a.overdue.first ? `vencido ${relTime(f.resolution_due)}` : esc(f.subject)}</span>` : ''}</div></a>`);
  }
  if (a.waiting.n) {
    items.push(`<a class="alert info" href="#/tickets/${a.waiting.first.number}">${icon('message', 20)}<div><b>${plural(a.waiting.n, 'usuario espera', 'usuarios esperan')} respuesta</b>
      <span>Respondieron y nadie contestó hace más de ${h.config.waiting_hours} h</span></div></a>`);
  }
  if (!items.length) return `<div class="alerts"><div class="alert ok">${icon('check', 20)}<div><b>Sin alertas</b><span>No hay tickets críticos por antigüedad, vencidos ni usuarios esperando.</span></div></div></div>`;
  return `<div class="alerts">${items.join('')}</div>`;
}

function histogramHtml(hist) {
  const max = Math.max(1, ...hist.map((b) => b.n));
  return `<div class="age-hist" role="img" aria-label="${esc(hist.map((b) => `${b.n} de ${b.to === null ? `más de ${b.from - 1}` : `${b.from} a ${b.to}`} días`).join(', '))}">
    ${hist.map((b) => `<div class="age-col ${b.level}">
      <b>${b.n}</b>
      <span class="bar" style="height:${b.n ? Math.max(6, Math.round((b.n / max) * 100)) : 2}%"></span>
      <small>${b.to === null ? `Más de ${b.from - 1} días` : `${b.from} a ${b.to} días`}</small>
    </div>`).join('')}
  </div>`;
}

function impHtml(t) {
  const lvl = t.score >= 70 ? 'danger' : t.score >= 45 ? 'warn' : 'info';
  return `<li>
    <span class="score ${lvl}" title="Puntaje de importancia">${t.score}</span>
    <div class="grow">
      <a href="#/tickets/${t.number}"><b>#${t.number}</b> ${esc(t.subject)}</a>
      <div class="reasons">${t.reasons.slice(0, 4).map((r) => `<span class="rchip ${r.kind}">${esc(r.label)}</span>`).join('')}${t.project_key ? `<span class="rchip">Proyecto ${esc(t.project_key)}</span>` : ''}</div>
    </div>
  </li>`;
}

function teamHtml(d) {
  const pct = d.perf.with_sla ? Math.round((d.perf.within_sla / d.perf.with_sla) * 100) : null;
  return `<h2 class="sec-title">Panorama de la mesa</h2>
  <div class="dash-grid">
    <section class="card span2">
      <h3>Tickets creados y resueltos · últimos 30 días</h3>
      ${lineChart(d.trend.map((x) => fmtShortDate(x.day)), [
    { name: 'Creados', color: 'var(--brand)', values: d.trend.map((x) => x.created) },
    { name: 'Resueltos', color: '#059669', values: d.trend.map((x) => x.resolved) },
  ])}
    </section>
    <section class="card">
      <h3>Desempeño · últimos 30 días</h3>
      <div class="perf">
        <div><span>1ª respuesta promedio</span><b>${d.perf.avg_first_response_h !== null ? `${fmtNum(d.perf.avg_first_response_h, 1)} h` : '—'}</b></div>
        <div><span>Resolución promedio</span><b>${d.perf.avg_resolution_h !== null ? `${fmtNum(d.perf.avg_resolution_h, 1)} h` : '—'}</b></div>
        <div><span>Cumplimiento de SLA</span><b class="${pct !== null && pct < 80 ? 'danger-text' : ''}">${pct !== null ? `${pct}%` : '—'}</b><small>${d.perf.with_sla ? `${d.perf.within_sla} de ${d.perf.with_sla} con SLA` : 'sin tickets con SLA resueltos'}</small></div>
      </div>
    </section>
    <section class="card">
      <h3>Sin resolver por ${esc(fieldLabel('tech').toLowerCase())}</h3>
      ${hbars(d.byTech.map((r) => ({ label: techName(r.id) || `Sin ${fieldLabel('tech').toLowerCase()}`, value: r.n, href: `#/tickets?view=unresolved&tech=${r.id ?? 'none'}` })))}
    </section>
    <section class="card">
      <h3>Sin resolver por agente</h3>
      ${hbars(d.byAssignee.map((r) => ({ label: userName(r.id) || 'Sin asignar', value: r.n, color: '#475569', href: `#/?scope=team&agent=${r.id ?? ''}` })))}
    </section>
    <section class="card">
      <h3>Sin resolver por área</h3>
      ${hbars(d.byCategory.map((r) => ({ label: categoryName(r.id) || 'Sin categoría', value: r.n, color: 'var(--accent)', href: r.id ? `#/tickets?view=unresolved&category=${r.id}` : '' })))}
      <h3 style="margin-top:18px">Por prioridad</h3>
      ${hbars(d.byPriority.map((r) => ({ label: PRIORITY[r.id], value: r.n, color: PRIORITY_COLOR[r.id], href: `#/tickets?view=unresolved&priority=${r.id}` })))}
    </section>
  </div>`;
}

