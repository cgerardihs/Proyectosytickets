import {
  state, api, esc, icon, avatar, toast, toastError, modal, popover, relTime, fmtDateTime, fmtDate, navigate, options, sanitize, richEditor,
  PRIORITY, CHANNEL, CHANNEL_ICON, statusById, userName, groupName, fieldLabel, categoryName, typeName, techName, slaName, slaState, fmtMinutes, fmtSize,
  confirmDialog, promptDialog, canPurge, isAdmin, isManager, todayISO, plain, newKey, showRemoteImages,
} from '../core.js';
import { setCrumbs, refreshMeta } from '../app.js';
import { ticketCriticalHtml, wireTicketCritical } from '../critical.js';

const ACTION_TEXT = {
  created: 'creó el ticket', replied: 'respondió al contacto', note: 'agregó una nota privada', forwarded: 'reenvió el ticket',
  reopened: 'reabrió el ticket', spam: 'lo marcó como spam', notspam: 'lo quitó de spam', trashed: 'lo envió a la papelera', restored: 'lo restauró',
  merged: 'lo combinó en otro ticket', merged_from: 'combinó otro ticket en este', time: 'registró tiempo', issue_linked: 'lo vinculó a una tarea de proyecto', project_linked: 'lo vinculó a un proyecto de desarrollo', project_unlinked: 'lo desvinculó de un proyecto', dev_rule: 'Regla de proyecto de desarrollo',
  resolved_by_contact: 'El contacto lo marcó como resuelto', auto_closed: 'Se cerró automáticamente',
  ai_auto_reply: 'Se envió la respuesta automática', ai_feedback: 'El usuario respondió a la respuesta automática', ai_classified: 'La IA clasificó el ticket al crearlo',
  intune_action: 'envió una acción remota al equipo',
  critical_linked: 'lo vinculó a un sistema crítico', critical_unlinked: 'lo desvinculó de un sistema crítico',
};
// Nombres de los campos (los configurables salen de fieldLabel, así el historial usa el nombre actual)
const FIELD_KEY = { status_id: 'status', priority: 'priority', assignee_id: 'assignee', category_id: 'category', type_id: 'type', tech_category_id: 'tech', tech_subcategory_id: 'subtech', sla_id: 'sla', contact_id: 'contact' };
const FIXED_LABELS = { group_id: 'Grupo (anterior)', subject: 'Asunto', tags: 'Etiquetas', cc: 'CC' };
const FIELD_LABELS = new Proxy({}, { get: (_, k) => (FIELD_KEY[k] ? fieldLabel(FIELD_KEY[k]) : FIXED_LABELS[k]) });
function fieldValue(k, v) {
  if (v === null || v === undefined || v === '') return '—';
  switch (k) {
    case 'status_id': return statusById(v)?.name || v;
    case 'priority': return PRIORITY[v];
    case 'group_id': return groupName(v) || '—';
    case 'assignee_id': return userName(v);
    case 'category_id': return categoryName(v);
    case 'type_id': return typeName(v);
    case 'tech_category_id': return techName(v);
    case 'tech_subcategory_id': return (state.meta.techSubcategories || []).find((x) => x.id === v)?.name || v;
    case 'sla_id': return slaName(v);
    default: return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } };

export async function render(el, [num]) {
  let d;
  let tab = 'conv';
  let composer = null;
  const aiOn = Boolean(state.meta.ai?.copilot);
  let showCopilot = aiOn && lsGet('copilot-open') !== '0';
  let cop = null; // resultado del copiloto { loading, data, error, answer }
  let devices = null; // equipos de Intune
  el.className = 'view ticket-view';

  // El usuario respondió por correo este ticket: se muestra sin recargar (si se está escribiendo, solo se avisa)
  const onInbox = (e) => {
    if (!el.isConnected || !el.classList.contains('ticket-view')) { window.removeEventListener('hd:inbox', onInbox); return; }
    if (!(e.detail?.updated || []).map(String).includes(String(num))) return;
    if (composer || document.querySelector('.modal-backdrop')) toast('Llegó una respuesta nueva en este ticket: se ve al terminar o al actualizar');
    else load().catch(() => {});
  };
  window.addEventListener('hd:inbox', onInbox);

  async function load() {
    d = await api(`/tickets/${num}`);
    draw();
    if (showCopilot && !cop) loadCopilot(false);
    if (state.meta.m365?.intune && !devices) loadDevices();
  }

  async function loadCopilot(refresh) {
    cop = { ...(cop || {}), loading: true, error: null };
    drawCopilot();
    try {
      cop = { data: await api(`/tickets/${num}/ai/copilot`, { method: 'POST', body: { refresh } }) };
    } catch (e) { cop = { error: e.message }; }
    drawCopilot();
  }

  async function loadDevices() {
    devices = { loading: true };
    drawDevices();
    try { devices = await api(`/tickets/${num}/devices`); } catch (e) { devices = { error: e.message }; }
    drawDevices();
  }

  function drawCopilot() {
    const slot = el.querySelector('.copilot-slot');
    if (!slot) return;
    if (!showCopilot) { slot.innerHTML = ''; return; }
    slot.innerHTML = copilotHtml();
  }

  function drawDevices() {
    const slot = el.querySelector('.devices-slot');
    if (slot) slot.innerHTML = devicesHtml();
  }

  function copilotHtml() {
    const c = cop?.data;
    const t = d.ticket;
    const head = `<div class="cop-head"><h3>${icon('sparkles', 15)} Copiloto IA</h3>
      <span class="row gap"><button class="icon-btn sm" data-act="cop-refresh" title="Volver a analizar" ${cop?.loading ? 'disabled' : ''}>${icon('refresh', 14)}</button>
      <button class="icon-btn sm" data-act="copilot" title="Ocultar">${icon('x', 14)}</button></span></div>`;
    if (cop?.loading && !c) return `<div class="card copilot">${head}<div class="cop-loading"><span class="spinner"></span> Analizando el ticket…</div></div>`;
    if (cop?.error) return `<div class="card copilot">${head}<p class="warn-text small">${esc(cop.error)}</p><button class="btn sm" data-act="cop-refresh">Reintentar</button></div>`;
    if (!c) return `<div class="card copilot">${head}<button class="btn sm" data-act="cop-refresh">${icon('sparkles', 13)} Analizar el ticket</button></div>`;
    const cl = c.classification;
    const rows = cl ? [
      ['tech_category_id', fieldLabel('tech'), techName(t.tech_category_id), cl.names.tech_category],
      ['priority', fieldLabel('priority'), PRIORITY[t.priority], cl.priority ? PRIORITY[cl.priority] : null],
      ['type_id', fieldLabel('type'), typeName(t.type_id), cl.names.type],
      ['category_id', fieldLabel('category'), categoryName(t.category_id), cl.names.category],
    ].filter((r) => r[3]) : [];
    const changes = rows.filter((r) => r[2] !== r[3]);
    return `<div class="card copilot ${cop?.loading ? 'busy' : ''}">${head}
      <p class="cop-sub">${c.ai ? `${esc(c.provider)} · usa el ticket, el historial y la base de conocimiento` : esc(c.notice || '')}</p>
      ${c.summary?.length ? `<h4>Resumen</h4><ul class="cop-list">${c.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${rows.length ? `<h4>Clasificación sugerida</h4><dl class="cop-class">${rows.map((r) => `<dt>${esc(r[1])}</dt><dd>${r[2] && r[2] !== r[3] ? `<s>${esc(r[2])}</s> → ` : ''}<b>${esc(r[3])}</b></dd>`).join('')}</dl>
        ${cl.motivo ? `<p class="muted small">${esc(cl.motivo)}</p>` : ''}
        ${changes.length ? '<button class="btn sm" data-act="cop-apply">Aplicar clasificación</button>' : '<p class="muted small">La clasificación actual coincide.</p>'}` : ''}
      ${c.steps?.length ? `<h4>Pasos sugeridos</h4><ol class="cop-list">${c.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
      ${c.related?.length || c.articles?.length ? `<h4>Relacionados</h4><ul class="mini-list">
        ${c.related.map((x) => `<li><a href="#/tickets/${x.number}">#${x.number} ${esc(x.subject)}</a><small>${esc(x.status_name || '')}</small></li>`).join('')}
        ${c.articles.map((a) => `<li><a href="#/kb/${a.id}">${icon('book', 12)} ${esc(a.title)}</a></li>`).join('')}</ul>` : ''}
      ${c.ai !== false || state.meta.ai?.available ? `<h4>Preguntale al copiloto</h4>
      <form class="cop-ask row gap"><input class="input sm grow" name="q" placeholder="Ej.: ¿qué reviso primero?" autocomplete="off"><button class="btn sm">Preguntar</button></form>
      ${cop?.answer ? `<div class="cop-answer">${sanitize(cop.answer)}</div>` : ''}` : ''}
      ${c.generated_at ? `<p class="hint">Analizado ${relTime(c.generated_at)}${c.cached ? ' · sin mensajes nuevos desde entonces' : ''}</p>` : ''}
    </div>`;
  }

  function devicesHtml() {
    if (!devices) return '';
    const head = `<h3>${icon('layers', 15)} Equipos del solicitante <small class="muted">Intune</small></h3>`;
    if (devices.loading) return `<div class="card">${head}<p class="muted small">Consultando Intune…</p></div>`;
    if (devices.error) return `<div class="card">${head}<p class="warn-text small">${esc(devices.error)}</p></div>`;
    if (!devices.devices.length) return `<div class="card">${head}<p class="${devices.notice_kind === 'permission' ? 'warn-text' : 'muted'} small">${esc(devices.notice || 'El solicitante no tiene equipos administrados en Intune.')}</p></div>`;
    const comp = { compliant: ['Cumple', 'ok'], noncompliant: ['No cumple', 'danger'], inGracePeriod: ['En gracia', 'warn'] };
    return `<div class="card">${head}<ul class="dev-list">${devices.devices.map((x) => `<li>
      <div class="row gap"><b class="grow">${esc(x.name)}</b><span class="badge" style="--c:var(--${(comp[x.compliance] || ['', 'muted'])[1]})">${esc((comp[x.compliance] || [x.compliance || 'Sin dato'])[0])}</span></div>
      <small>${esc(x.os)}${x.model ? ` · ${esc(x.model)}` : ''}</small>
      <small class="muted">Último contacto ${x.last_sync ? relTime(x.last_sync) : '—'}${x.encrypted ? ' · BitLocker activo' : ''}</small>
      ${devices.allow_actions ? `<span class="row gap"><button class="btn sm" data-devact="sync" data-dev="${esc(x.id)}" data-devname="${esc(x.name)}">Sincronizar</button><button class="btn sm" data-devact="reboot" data-dev="${esc(x.id)}" data-devname="${esc(x.name)}">Reiniciar</button></span>` : ''}
    </li>`).join('')}</ul></div>`;
  }

  function draw() {
    const t = d.ticket;
    const st = statusById(t.status_id);
    const sla = slaState({ ...t, status_kind: st?.kind });
    setCrumbs([{ label: 'Tickets', href: '#/tickets' }, { label: `#${t.number}` }]);
    el.innerHTML = `
    <div class="tk-actions">
      <button class="btn" data-act="reply">${icon('reply', 15)} Responder</button>
      <button class="btn" data-act="forward">${icon('forward', 15)} Reenviar</button>
      <button class="btn" data-act="note">${icon('note', 15)} Agregar nota</button>
      ${aiOn ? `<button class="btn ai-btn ${showCopilot ? 'active' : ''}" data-act="copilot">${icon('sparkles', 15)} Copiloto IA</button>` : ''}
      <button class="btn ${d.following ? 'active' : ''}" data-act="follow" title="${d.following ? 'Dejar de seguir' : 'Seguir'}">${icon('eye', 15)} ${d.following ? 'Siguiendo' : 'Seguir'}</button>
      ${d.projects.length ? '' : `<button class="btn" data-act="to-project">${icon('projects', 15)} Convertir en proyecto</button>`}
      <button class="btn" data-act="more">Más ${icon('down', 14)}</button>
      <span class="grow"></span>
      ${t.ai?.feedback === 'yes' ? `<span class="badge" style="--c:#059669">${icon('check', 12)} Le sirvió la respuesta automática</span>` : ''}${t.ai?.feedback === 'no' ? `<span class="badge" style="--c:#d97706">Pidió un agente</span>` : ''}
      ${t.deleted_at ? `<span class="badge" style="--c:#dc2626">En la papelera</span>` : ''}${t.spam ? `<span class="badge" style="--c:#d97706">Spam</span>` : ''}${t.merged_into ? `<a class="badge" style="--c:#475569" href="#/tickets/${t.merged_into}">Combinado en #${t.merged_into}</a>` : ''}
      <a class="btn ghost" href="#/tickets">${icon('left', 15)} Volver</a>
    </div>
    <div class="tk-grid">
      <section class="tk-main">
        <div class="tk-head">
          <div class="tk-avatar">${esc((d.contact?.name || '?')[0].toUpperCase())}</div>
          <div class="grow">
            <h1 class="tk-subject" data-act="subject" title="Clic para editar">${esc(t.subject)}</h1>
            <div class="tk-meta">
              <span>${icon('user', 13)} ${esc(d.contact?.name || 'Sin contacto')}</span>
              <span>${icon('calendar', 13)} ${fmtDateTime(t.created_at)}</span>
              <span>${icon(CHANNEL_ICON[t.channel] || 'ticket', 13)} ${esc(CHANNEL[t.channel] || t.channel)}</span>
              <span class="sla ${sla?.cls || 'none'}">${icon('clock', 12)} ${sla ? esc(sla.label) : `${esc(slaName(t.sla_id) || 'Sin SLA')} – sin vencimiento`}</span>
            </div>
            ${(t.cc || []).length ? `<div class="tk-meta"><span>CC: ${esc(t.cc.join(', '))}</span></div>` : ''}
          </div>
        </div>
        ${d.projects.map(devHtml).join('')}
        <div class="tabs">
          <button class="${tab === 'conv' ? 'on' : ''}" data-tab="conv">Conversación <b>${d.messages.length}</b></button>
          <button class="${tab === 'act' ? 'on' : ''}" data-tab="act">Actividades <b>${d.activities.length}</b></button>
        </div>
        <div class="composer-slot"></div>
        <div class="thread">${tab === 'conv' ? d.messages.map(msgHtml).join('') : activitiesHtml()}</div>
      </section>
      <aside class="tk-side">
        <div class="copilot-slot">${showCopilot ? copilotHtml() : ''}</div>
        <div class="crit-slot">${ticketCriticalHtml(d.critical)}</div>
        <div class="card props">
          <h3>Propiedades del ticket</h3>
          ${propsForm(t)}
          <button class="btn primary block" data-act="save" disabled>Actualizar ticket</button>
        </div>
        <div class="card">
          <h3>${icon('user', 15)} Contacto</h3>
          ${d.contact ? `
            <div class="contact-card">
              <a href="#/contacts/${d.contact.id}"><b>${esc(d.contact.name)}</b></a>
              <a href="mailto:${esc(d.contact.email)}" class="muted">${esc(d.contact.email)}</a>
              ${d.contact.phone ? `<span class="muted">${esc(d.contact.phone)}</span>` : ''}
              ${d.contact.company_name ? `<span>${icon('building', 12)} ${esc(d.contact.company_name)}</span>` : ''}
              ${d.contact.area ? `<span>Área: ${esc(d.contact.area)}</span>` : ''}
            </div>
            <button class="link-btn" data-act="change-contact">Cambiar contacto</button>
            ${d.otherTickets.length ? `<h4>Otros tickets</h4><ul class="mini-list">${d.otherTickets.map((o) => `<li><a href="#/tickets/${o.number}">#${o.number} ${esc(o.subject)}</a><small>${esc(o.status_name || '')} · ${relTime(o.created_at)}</small></li>`).join('')}</ul>` : ''}
          ` : '<button class="btn sm" data-act="change-contact">Asignar contacto</button>'}
        </div>
        <div class="devices-slot">${devicesHtml()}</div>
        <div class="card">
          <h3>${icon('projects', 15)} Tareas de proyecto</h3>
          ${d.issues.length ? `<ul class="mini-list">${d.issues.map((i) => `<li class="row"><a href="#/issue/${esc(i.key)}"><b style="color:${esc(i.color)}">${esc(i.key)}</b> ${esc(i.title)}</a><small class="st-${esc(i.status_kind)}">${esc(i.status_name || '')}</small><button class="icon-btn sm" data-unlink="${i.id}" title="Desvincular">${icon('x', 12)}</button></li>`).join('')}</ul>` : '<p class="muted small">Sin tareas vinculadas.</p>'}
          <div class="row gap"><button class="btn sm" data-act="create-issue">${icon('plus', 13)} Crear tarea</button><button class="btn sm" data-act="link-issue">${icon('link', 13)} Vincular existente</button></div>
        </div>
        <div class="card">
          <h3>${icon('timer', 15)} Registros de tiempo <span class="muted">${fmtMinutes(d.timeTotal)}</span></h3>
          ${d.time.length ? `<ul class="mini-list">${d.time.map((x) => `<li class="row"><span>${esc(userName(x.user_id))} · ${fmtMinutes(x.minutes)}${x.note ? ` · ${esc(x.note)}` : ''}</span><small>${fmtDate(x.spent_on)}</small><button class="icon-btn sm" data-deltime="${x.id}" title="Eliminar">${icon('x', 12)}</button></li>`).join('')}</ul>` : ''}
          <form class="time-form row gap"><input class="input sm" name="minutes" type="number" min="1" placeholder="Min." aria-label="Minutos"><input class="input sm grow" name="note" placeholder="Detalle (opcional)"><button class="btn sm">Agregar</button></form>
        </div>
        <div class="card small-info">
          <div><span>1ª respuesta</span><b>${t.first_responded_at ? fmtDateTime(t.first_responded_at) : t.first_response_due ? `vence ${fmtDateTime(t.first_response_due)}` : '—'}</b></div>
          <div><span>Resolución</span><b>${t.resolved_at ? fmtDateTime(t.resolved_at) : t.resolution_due ? `vence ${fmtDateTime(t.resolution_due)}` : '—'}</b></div>
          <div><span>Seguidores</span><b>${d.followers.map((u) => avatar(u, 22)).join('') || '—'}</b></div>
        </div>
      </aside>
    </div>`;
    wireProps();
    wireTicketCritical(el.querySelector('.crit-slot'), t.number, load);
    if (composer) openComposer(composer.kind, true);
  }

  function msgHtml(m) {
    const isAgent = m.kind !== 'customer';
    const auto = Boolean(m.meta?.auto);
    const cycle = Boolean(m.meta?.dev_cycle);
    const who = auto ? 'Asistente de la Mesa de Ayuda' : cycle ? 'Mesa de Ayuda' : isAgent ? userName(m.author_user_id) || m.from_email || 'Sistema' : d.contact && m.author_contact_id === d.contact.id ? d.contact.name : m.from_email || 'Contacto';
    const label = auto ? 'Respuesta automática' : cycle ? 'Nota privada automática' : { customer: '', reply: 'Respuesta', note: 'Nota privada', forward: 'Reenviado', system: 'Sistema' }[m.kind];
    const av = auto ? `<span class="avatar ai" style="width:32px;height:32px">${icon('sparkles', 16)}</span>` : cycle ? `<span class="avatar cycle" style="width:32px;height:32px">${icon('check', 16)}</span>`
      : isAgent ? avatar(m.author_user_id, 32) : `<span class="avatar contact" style="width:32px;height:32px">${esc((who || '?')[0].toUpperCase())}</span>`;
    return `<article class="msg ${m.kind} ${auto ? 'auto' : ''} ${cycle ? 'cycle' : ''}">
      <div class="msg-av">${av}</div>
      <div class="msg-body">
        <header><b>${esc(who)}</b>${label ? `<span class="msg-kind">${label}</span>` : ''}${auto && m.meta.rule_name ? `<span class="muted small">Regla: ${esc(m.meta.rule_name)}${m.meta.used_ai ? ' · adaptada por IA' : ''}</span>` : ''}${m.meta?.ai_assisted ? '<span class="msg-kind ai">Redactada con IA</span>' : ''}
          ${m.kind === 'forward' && m.to_emails?.length ? `<span class="muted small">a ${esc(m.to_emails.join(', '))}</span>` : ''}
          <time title="${esc(fmtDateTime(m.created_at))}">${relTime(m.created_at)}</time></header>
        ${(() => { const body = sanitize(m.body_html, { blockRemote: m.kind === 'customer' }); return `${body.includes('data-remote-src') ? `<div class="remote-note">${icon('shield', 13)} Las imágenes externas de este correo no se cargaron (pueden avisarle al remitente que lo abriste). <button type="button" class="link-btn" data-show-imgs>Mostrar imágenes</button></div>` : ''}<div class="msg-html">${body}</div>`; })()}
        ${m.attachments?.length ? `<div class="atts">${m.attachments.map((a) => `<a class="chip" href="/api/attachments/${a.id}" target="_blank" rel="noopener">${icon('clip', 12)} ${esc(a.filename)} <small>${fmtSize(a.size)}</small></a>`).join('')}</div>` : ''}
      </div>
    </article>`;
  }

  function activitiesHtml() {
    return `<ul class="activity">${d.activities.slice().reverse().map((a) => {
      let text = ACTION_TEXT[a.action] || a.action;
      let extra = '';
      if (a.action === 'updated') {
        text = 'actualizó';
        extra = Object.entries(a.details || {}).filter(([k]) => k !== 'group_id').map(([k, v]) => `<li>${esc(FIELD_LABELS[k] || k)}: <s>${esc(fieldValue(k, v.from))}</s> → <b>${esc(fieldValue(k, v.to))}</b></li>`).join('');
      }
      if (a.action === 'merged') extra = `<li>En <a href="#/tickets/${a.details.into}">#${a.details.into}</a></li>`;
      if (a.action === 'merged_from') extra = `<li>Desde #${a.details.from}</li>`;
      if (a.action === 'critical_linked' || a.action === 'critical_unlinked') extra = `<li>${esc(a.details.system || '')}${a.details.auto ? ' · automático: el ticket menciona el sistema' : ''}</li>`;
      if (a.action === 'dev_rule') {
        const ev = { convert: 'al convertir', start: 'arrancó el desarrollo', phase: 'cambio de fase', finish: 'terminó el desarrollo', issues_done: 'se finalizaron las tareas vinculadas' };
        extra = `<li>${esc(String(a.details.event || '').split(',').map((x) => ev[x] || x).join(' · '))}${a.details.issues?.length ? ` (${a.details.issues.map((k) => `<a href="#/issue/${esc(k)}">${esc(k)}</a>`).join(', ')})` : ''}${a.details.phase ? ` → fase <b>${esc(a.details.phase)}</b>` : ''}${a.details.status ? ` · estado <b>${esc(a.details.status)}</b>` : ' · estado sin cambio'}</li>`;
      }
      if (a.action === 'project_linked') extra = `<li>${a.details.created ? 'Creó el proyecto' : 'Proyecto'} <a href="#/projects/${esc(a.details.key)}/roadmap">${esc(a.details.key)} · ${esc(a.details.name || '')}</a></li>`;
      if (a.action === 'issue_linked') extra = `<li><a href="#/issue/${esc(a.details.key)}">${esc(a.details.key)}</a></li>`;
      if (a.action === 'time') extra = `<li>${fmtMinutes(a.details.minutes)}</li>`;
      if (a.action === 'ai_auto_reply') extra = `<li>${a.details.rule ? `Regla «${esc(a.details.rule)}»` : 'Sin regla'}${a.details.used_ai ? ' · generada con IA' : ' · texto de la regla'}</li>`;
      if (a.action === 'ai_feedback') extra = `<li>${a.details.helpful ? 'Le sirvió' : 'No le sirvió: necesita un agente'}</li>`;
      if (a.action === 'ai_classified' && a.details.motivo) extra = `<li>${esc(a.details.motivo)}</li>`;
      if (a.action === 'intune_action') extra = `<li>${a.details.action === 'reboot' ? 'Reiniciar' : 'Sincronizar'} · ${esc(a.details.device || '')}</li>`;
      if (a.action === 'created' && a.details?.rules?.length) extra = `<li>Reglas aplicadas: ${esc(a.details.rules.join(', '))}</li>`;
      if (a.details?.mail && a.details.mail.sent === false) extra += `<li class="warn-text">No se envió el correo: ${esc(a.details.mail.error || '')}</li>`;
      const who = a.user_id ? `<b>${esc(userName(a.user_id))}</b> ` : '';
      return `<li><span class="act-dot"></span><div>${who}${esc(text)}<time>${fmtDateTime(a.created_at)}</time>${extra ? `<ul>${extra}</ul>` : ''}</div></li>`;
    }).join('')}</ul>`;
  }

  function propsForm(t) {
    const m = state.meta;
    const techs = m.techCategories.filter((x) => x.active || x.id === t.tech_category_id);
    const subs = (m.techSubcategories || []).filter((x) => x.tech_category_id === t.tech_category_id && (x.active || x.id === t.tech_subcategory_id));
    const members = m.users.filter((u) => u.active || u.id === t.assignee_id);
    const L = (k) => esc(fieldLabel(k));
    return `<form class="props-form">
      <label class="field"><span>${L('sla')}</span><select class="input" name="sla_id">${options(m.slas, t.sla_id, { empty: '—' })}</select></label>
      <label class="field"><span>${L('status')} *</span><select class="input" name="status_id">${options(m.statuses.filter((s) => s.active || s.id === t.status_id), t.status_id)}</select></label>
      <label class="field"><span>${L('priority')} *</span><select class="input" name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${Number(k) === t.priority ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>${L('tech')}</span><select class="input" name="tech_category_id">${options(techs, t.tech_category_id, { empty: '—' })}</select></label>
      ${subs.length || t.tech_subcategory_id ? `<label class="field"><span>${L('subtech')}</span><select class="input" name="tech_subcategory_id">${options(subs, t.tech_subcategory_id, { empty: '—' })}</select></label>` : ''}
      <label class="field"><span>${L('type')}</span><select class="input" name="type_id">${options(m.types.filter((x) => x.active || x.id === t.type_id), t.type_id, { empty: '—' })}</select></label>
      <label class="field"><span>${L('assignee')}</span><select class="input" name="assignee_id"><option value="">— Sin asignar</option>${options(members, t.assignee_id)}</select></label>
      <label class="field"><span>${L('category')}</span><select class="input" name="category_id">${options(m.categories.filter((x) => x.active || x.id === t.category_id), t.category_id, { empty: '—' })}</select></label>
      <label class="field"><span>Etiquetas</span><input class="input" name="tags" value="${esc((t.tags || []).join(', '))}" placeholder="separadas por coma"></label>
      <label class="field"><span>CC</span><input class="input" name="cc" value="${esc((t.cc || []).join(', '))}" placeholder="correos separados por coma"></label>
    </form>`;
  }

  function wireProps() {
    const f = el.querySelector('.props-form');
    const btn = el.querySelector('[data-act=save]');
    f.addEventListener('input', () => { btn.disabled = false; });
    f.addEventListener('change', (e) => {
      btn.disabled = false;
      if (e.target.name === 'tech_category_id') {
        // refrescar dependientes manteniendo el resto
        const cur = collect();
        const t = { ...d.ticket, ...cur };
        // La subcategoría depende de la categoría técnica
        if (!(state.meta.techSubcategories || []).some((x) => x.id === t.tech_subcategory_id && x.tech_category_id === t.tech_category_id)) t.tech_subcategory_id = null;
        f.outerHTML = propsForm(t);
        wireProps();
        el.querySelector('[data-act=save]').disabled = false;
      }
    });
  }

  function collect() {
    const f = el.querySelector('.props-form');
    const split = (s) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const n = (v) => (v === '' ? null : Number(v));
    return {
      sla_id: n(f.sla_id.value), status_id: n(f.status_id.value), priority: n(f.priority.value),
      tech_category_id: n(f.tech_category_id.value), tech_subcategory_id: f.tech_subcategory_id ? n(f.tech_subcategory_id.value) : null, type_id: n(f.type_id.value), assignee_id: n(f.assignee_id.value), category_id: n(f.category_id.value),
      tags: split(f.tags.value), cc: split(f.cc.value),
    };
  }

  function openComposer(kind, keep = false) {
    const slot = el.querySelector('.composer-slot');
    const prev = keep && composer?.editor ? { html: composer.editor.getHTML(), cc: composer.cc, aiUsed: composer.aiUsed, key: composer.key } : null;
    composer = { kind, aiUsed: Boolean(prev?.aiUsed), key: prev?.key || newKey() };
    const t = d.ticket;
    const titles = { reply: 'Responder', note: 'Nota privada', forward: 'Reenviar' };
    slot.innerHTML = `<div class="composer ${kind}">
      <div class="composer-head">
        <b>${titles[kind]}</b>
        ${kind === 'reply' ? `<span class="muted small">Para: ${esc(d.contact?.email || '(sin contacto)')}</span>` : ''}
        ${kind === 'note' ? '<span class="muted small">Solo la ven los agentes</span>' : ''}
        <span class="grow"></span>
        <button class="icon-btn sm" data-act="close-composer" aria-label="Cerrar">${icon('x', 15)}</button>
      </div>
      ${kind === 'forward' ? '<label class="field"><span>Para</span><input class="input" name="to" placeholder="correos separados por coma"></label>' : ''}
      ${kind !== 'note' ? `<label class="field"><span>CC</span><input class="input" name="cc" value="${esc(prev?.cc || '')}" placeholder="correos separados por coma"></label>` : `<label class="field"><span>Notificar a</span><select class="input" name="notify" multiple size="3">${options(state.meta.users.filter((u) => u.active && u.id !== state.me.id), [])}</select></label>`}
      <div class="ai-draft-bar" hidden><span>${icon('sparkles', 13)} Borrador sugerido por IA · revisalo antes de enviar</span>
        <span class="row gap"><button class="btn xs" data-draft="shorter">Más corta</button><button class="btn xs" data-draft="formal">Más formal</button><button class="btn xs" data-draft="friendly">Más cercana</button><button class="btn xs" data-draft="regenerate">${icon('refresh', 12)} Regenerar</button></span></div>
      <div class="editor"></div>
      <div class="composer-foot">
        ${kind === 'reply' && state.meta.ai?.copilot ? `<button class="btn sm ai-btn" data-act="ai-draft">${icon('sparkles', 13)} Sugerir respuesta</button><label class="check small ai-internal" title="Por seguridad, el borrador no usa notas internas ni artículos internos salvo que lo pidas"><input type="checkbox" data-ai-internal> Usar notas internas</label>` : ''}
        <button class="btn sm" data-act="canned">${icon('list', 13)} Respuestas predefinidas</button>
        <span class="grow"></span>
        ${kind !== 'forward' ? `<label class="muted small">y pasar a <select class="input sm" name="then_status"><option value="">(sin cambio)</option>${options(state.meta.statuses.filter((s) => s.active), null)}</select></label>` : ''}
        <button class="btn primary" data-act="send">${kind === 'note' ? 'Guardar nota' : 'Enviar'}</button>
      </div>
      ${kind !== 'note' && !state.meta.mailEnabled ? '<p class="hint warn-text">El correo saliente no está configurado: el mensaje queda registrado en el ticket pero no se envía.</p>' : ''}
    </div>`;
    const editor = richEditor(slot.querySelector('.editor'), {
      placeholder: kind === 'note' ? 'Nota interna para el equipo' : 'Escribí tu respuesta… (Ctrl+Enter para enviar)',
      value: prev?.html || (kind === 'reply' && state.me.signature_html ? `<p></p><p></p>${state.me.signature_html}` : ''),
      onSubmit: send,
    });
    composer.editor = editor;
    editor.focus();
    async function send() {
      const btn = slot.querySelector('[data-act=send]');
      const split = (s) => (s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const body = {
        kind, body_html: editor.getHTML(), attachments: editor.getFiles(),
        cc: split(slot.querySelector('[name=cc]')?.value), to: split(slot.querySelector('[name=to]')?.value),
        status_id: Number(slot.querySelector('[name=then_status]')?.value) || null,
        notify_user_ids: [...(slot.querySelector('[name=notify]')?.selectedOptions || [])].map((o) => Number(o.value)),
        ai_assisted: Boolean(composer?.aiUsed),
      };
      if (editor.isEmpty() && !body.attachments.length) return toast('Escribí un mensaje', 'error');
      btn.disabled = true;
      try {
        const r = await api(`/tickets/${t.number}/messages`, { method: 'POST', body, idempotencyKey: composer.key });
        composer = null;
        d = r.detail;
        tab = 'conv';
        draw();
        if (r.mail && r.mail.sent === false && kind !== 'note') toast(`Guardado. No se envió el correo: ${r.mail.error}`, 'error');
        else toast(kind === 'note' ? 'Nota guardada' : 'Mensaje enviado');
      } catch (e) { toastError(e); btn.disabled = false; }
    }
    slot.querySelector('[data-act=send]').addEventListener('click', send);
    const draftBar = slot.querySelector('.ai-draft-bar');
    async function aiDraft(mode, btn) {
      const cur = editor.isEmpty() ? '' : plain(editor.getHTML());
      const buttons = slot.querySelectorAll('[data-draft], [data-act=ai-draft]');
      buttons.forEach((b) => { b.disabled = true; });
      const prevLabel = btn?.innerHTML;
      if (btn) btn.innerHTML = '<span class="spinner sm"></span> Pensando…';
      try {
        const r = await api(`/tickets/${t.number}/ai/draft`, { method: 'POST', body: { mode, current_text: cur, use_internal: Boolean(slot.querySelector('[data-ai-internal]')?.checked) } });
        editor.setHTML(r.html + (state.me.signature_html ? `<p></p>${state.me.signature_html}` : ''));
        composer.aiUsed = true;
        draftBar.hidden = false;
      } catch (e) { toastError(e); }
      buttons.forEach((b) => { b.disabled = false; });
      if (btn) btn.innerHTML = prevLabel;
    }
    slot.querySelector('[data-act=ai-draft]')?.addEventListener('click', (e) => aiDraft(editor.isEmpty() ? 'new' : 'regenerate', e.currentTarget));
    draftBar.addEventListener('click', (e) => { const b = e.target.closest('[data-draft]'); if (b) aiDraft(b.dataset.draft, b); });
    slot.querySelector('[data-act=canned]').addEventListener('click', async (e) => {
      const list = await api('/canned');
      if (!list.length) return toast('No hay respuestas predefinidas. Crealas en Configuración.', 'error');
      popover(e.currentTarget, `<div class="menu-scroll">${list.map((c) => `<button class="menu-item" data-value="${c.id}"><small class="muted">${esc(c.folder)}</small> ${esc(c.title)}</button>`).join('')}</div>`, {
        onClick: (id) => {
          const c = list.find((x) => x.id === Number(id));
          const html = c.body_html
            .replace(/\{\{contacto\.nombre\}\}/g, esc((d.contact?.name || '').split(' ')[0]))
            .replace(/\{\{ticket\.numero\}\}/g, String(t.number))
            .replace(/\{\{ticket\.asunto\}\}/g, esc(t.subject))
            .replace(/\{\{agente\.nombre\}\}/g, esc(state.me.name));
          editor.insertHTML(html);
        },
      });
    });
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function patch(body, msg = 'Ticket actualizado') {
    try {
      d = await api(`/tickets/${num}`, { method: 'PATCH', body });
      draw();
      toast(msg);
    } catch (e) { toastError(e); }
  }

  el.addEventListener('click', async (e) => {
    const imgs = e.target.closest('[data-show-imgs]');
    if (imgs) {
      const body = imgs.closest('.msg-body');
      showRemoteImages(body);
      imgs.closest('.remote-note')?.remove();
      return;
    }
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab; return draw(); }
    const unproj = e.target.closest('[data-unproject]');
    if (unproj) {
      if (!(await confirmDialog('Se quita el vínculo con el proyecto. El proyecto y sus tareas no se borran.', { okText: 'Desvincular' }))) return;
      d = await api(`/tickets/${num}/project/${unproj.dataset.unproject}`, { method: 'DELETE' }).catch(toastError) || d;
      return draw();
    }
    const unlink = e.target.closest('[data-unlink]');
    if (unlink) {
      d = await api(`/tickets/${num}/issues/${unlink.dataset.unlink}`, { method: 'DELETE' }).catch(toastError) || d;
      return draw();
    }
    const delTime = e.target.closest('[data-deltime]');
    if (delTime) {
      await api(`/time/${delTime.dataset.deltime}`, { method: 'DELETE' }).catch(toastError);
      return load();
    }
    const devBtn = e.target.closest('[data-devact]');
    if (devBtn) {
      const what = devBtn.dataset.devact === 'reboot' ? 'reiniciar' : 'sincronizar';
      if (!(await confirmDialog(`Se va a ${what} el equipo ${devBtn.dataset.devname} desde Intune.${what === 'reiniciar' ? ' El usuario puede perder lo que no guardó.' : ''}`, { okText: what === 'reiniciar' ? 'Reiniciar' : 'Sincronizar', danger: what === 'reiniciar' }))) return;
      try {
        await api(`/devices/${encodeURIComponent(devBtn.dataset.dev)}/action`, { method: 'POST', body: { action: devBtn.dataset.devact, ticket: d.ticket.number, device_name: devBtn.dataset.devname } });
        toast(what === 'reiniciar' ? 'Reinicio enviado' : 'Sincronización enviada');
      } catch (er) { toastError(er); }
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    const t = d.ticket;
    if (act === 'copilot') {
      showCopilot = !showCopilot;
      lsSet('copilot-open', showCopilot ? '1' : '0');
      el.querySelector('.ai-btn[data-act=copilot]')?.classList.toggle('active', showCopilot);
      drawCopilot();
      if (showCopilot && !cop) loadCopilot(false);
      return;
    }
    if (act === 'cop-refresh') return loadCopilot(true);
    if (act === 'cop-apply') {
      const cl = cop?.data?.classification;
      if (!cl) return;
      const body = {};
      for (const k of ['tech_category_id', 'type_id', 'category_id', 'priority']) if (cl[k] && cl[k] !== t[k]) body[k] = cl[k];
      return patch(body, 'Clasificación aplicada');
    }
    if (['reply', 'note', 'forward'].includes(act)) openComposer(act);
    if (act === 'close-composer') { composer = null; el.querySelector('.composer-slot').innerHTML = ''; }
    if (act === 'save') patch(collect());
    if (act === 'follow') {
      await api(`/tickets/${num}/follow`, { method: d.following ? 'DELETE' : 'POST' }).catch(toastError);
      d.following = !d.following;
      if (d.following) d.followers.push(state.me.id); else d.followers = d.followers.filter((x) => x !== state.me.id);
      draw();
    }
    if (act === 'subject') {
      const v = await promptDialog('Asunto', { value: t.subject, title: 'Editar asunto' });
      if (v && v !== t.subject) patch({ subject: v });
    }
    if (act === 'change-contact') changeContact();
    if (act === 'create-issue') createIssueFromTicket();
    if (act === 'to-project') convertToProject();
    if (act === 'link-issue') {
      const key = await promptDialog('Clave de la tarea (ej. CRM-12)', { title: 'Vincular tarea existente' });
      if (!key) return;
      try { d = await api(`/tickets/${num}/issues`, { method: 'POST', body: { issue_key: key } }); draw(); toast('Tarea vinculada'); } catch (er) { toastError(er); }
    }
    if (act === 'more') {
      popover(a, `
        <button class="menu-item" data-value="to-project">${icon('projects', 15)} Convertir en proyecto de desarrollo</button>
        <button class="menu-item" data-value="link-project">${icon('link', 15)} Vincular a un proyecto existente</button>
        ${isManager() ? `<button class="menu-item" data-value="merge">${icon('merge', 15)} Combinar con otro ticket</button>` : ''}
        <button class="menu-item" data-value="print">${icon('note', 15)} Imprimir</button>
        ${t.spam ? `<button class="menu-item" data-value="notspam">${icon('undo', 15)} No es spam</button>` : `<button class="menu-item" data-value="spam">${icon('alert', 15)} Marcar como spam</button>`}
        ${t.deleted_at ? `<button class="menu-item" data-value="restore">${icon('undo', 15)} Restaurar</button>${canPurge() ? `<button class="menu-item danger" data-value="purge">${icon('trash', 15)} Eliminar definitivamente</button>` : ''}`
    : `<button class="menu-item danger" data-value="trash">${icon('trash', 15)} Enviar a la papelera</button>`}`, {
        onClick: async (v) => {
          try {
            if (v === 'to-project') return convertToProject();
            if (v === 'link-project') return linkProject();
            if (v === 'merge') {
              const into = await promptDialog(`Número del ticket principal (se moverá la conversación de #${t.number} a ese ticket)`, { title: 'Combinar tickets' });
              if (!into) return;
              const r = await api(`/tickets/${num}/merge`, { method: 'POST', body: { into: into.replace('#', '') } });
              toast('Tickets combinados');
              return navigate(`#/tickets/${r.into}`);
            }
            if (v === 'print') return window.print();
            if (v === 'spam' || v === 'notspam') await api(`/tickets/${num}/spam`, { method: 'POST', body: { spam: v === 'spam' } });
            if (v === 'trash') { await api(`/tickets/${num}`, { method: 'DELETE' }); toast('Enviado a la papelera'); return navigate('#/tickets'); }
            if (v === 'restore') await api(`/tickets/${num}/restore`, { method: 'POST' });
            if (v === 'purge') {
              if (!(await confirmDialog('Se eliminará el ticket definitivamente.', { danger: true, okText: 'Eliminar' }))) return;
              await api(`/tickets/${num}`, { method: 'DELETE' });
              return navigate('#/tickets?view=trash');
            }
            load();
          } catch (er) { toastError(er); }
        },
      });
    }
  });

  el.addEventListener('submit', async (e) => {
    if (e.target.matches('.cop-ask')) {
      e.preventDefault();
      const input = e.target.q;
      const question = input.value.trim();
      if (!question) return;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner sm"></span>';
      try {
        const r = await api(`/tickets/${num}/ai/ask`, { method: 'POST', body: { question } });
        cop.answer = `<p class="muted small"><b>${esc(question)}</b></p>${r.html}`;
      } catch (er) { toastError(er); }
      drawCopilot();
      return;
    }
    if (!e.target.matches('.time-form')) return;
    e.preventDefault();
    const f = e.target;
    try {
      d = await api(`/tickets/${num}/time`, { method: 'POST', body: { minutes: Number(f.minutes.value), note: f.note.value, spent_on: todayISO() } });
      draw();
      toast('Tiempo registrado');
    } catch (er) { toastError(er); }
  });

  function changeContact() {
    const md = modal({
      title: 'Cambiar contacto',
      body: `<label class="field"><span>Correo</span><input class="input" name="email" list="ccList" autocomplete="off"><datalist id="ccList"></datalist></label>
        <label class="field"><span>Nombre (si es nuevo)</span><input class="input" name="name"></label>`,
      footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>',
    });
    const email = md.el.querySelector('[name=email]');
    email.addEventListener('input', async () => {
      const r = await api(`/contacts?q=${encodeURIComponent(email.value)}&limit=8`).catch(() => ({ items: [] }));
      md.el.querySelector('#ccList').innerHTML = r.items.map((c) => `<option value="${esc(c.email)}">${esc(c.name)}</option>`).join('');
    });
    md.el.querySelector('[data-ok]').addEventListener('click', async () => {
      try {
        const r = await api(`/contacts?q=${encodeURIComponent(email.value.trim())}&limit=5`);
        let c = r.items.find((x) => x.email === email.value.trim().toLowerCase());
        if (!c) c = await api('/contacts', { method: 'POST', body: { email: email.value.trim(), name: md.el.querySelector('[name=name]').value.trim() || email.value.split('@')[0] } });
        md.close();
        patch({ contact_id: c.id }, 'Contacto actualizado');
      } catch (er) { toastError(er); }
    });
  }

  // ---------- Proyecto de desarrollo ----------
  function devHtml(p) {
    const stateIcon = { done: icon('check', 13), active: '<i class="pulse"></i>', pending: '' };
    const stateLabel = { done: 'Completa', active: 'En curso', pending: 'Pendiente' };
    return `<section class="dev-card">
      <header>
        <div class="row gap"><span class="proj-key sm" style="background:${esc(p.color)}">${esc(p.key)}</span>
          <div><b>${esc(p.name)}</b><small class="muted">Proyecto de desarrollo${p.lead_id ? ` · Líder: ${esc(userName(p.lead_id))}` : ''}${p.active_sprint ? ` · ${esc(p.active_sprint)}` : ''}${p.due_date ? ` · Fin previsto ${fmtDate(String(p.due_date).slice(0, 10))}` : ''}</small></div></div>
        <div class="dev-progress"><span class="dev-pct">${p.progress}%</span><span class="progress"><span style="width:${p.progress}%"></span></span></div>
      </header>
      ${p.phases.length ? `<ol class="phases">${p.phases.map((f) => `<li class="ph ${f.state}" title="${esc(f.title)} · ${stateLabel[f.state]} · ${f.pct}%${f.child_count ? ` (${f.child_done}/${f.child_count} tareas)` : ''}">
          <span class="ph-dot">${stateIcon[f.state]}</span>
          <a class="ph-name" href="#/issue/${esc(f.key)}">${esc(f.title)}</a>
          <span class="ph-meta">${f.state === 'pending' ? (f.start_date ? `desde ${fmtDate(String(f.start_date).slice(0, 10))}` : 'Pendiente') : `${f.pct}%${f.child_count ? ` · ${f.child_done}/${f.child_count}` : ''}`}</span>
        </li>`).join('')}</ol>` : '<p class="muted small">El proyecto todavía no tiene fases (épicas).</p>'}
      <footer>
        <span class="small">${p.finished ? `<b class="ok-text">${icon('check', 13)} Desarrollo finalizado</b>` : p.current ? `Fase actual: <b>${esc(p.current.title)}</b> (${p.current.pct}%)` : ''}
          <span class="muted"> · ${p.issues.done}/${p.issues.total} tareas hechas</span></span>
        <span class="row gap"><a class="btn sm" href="#/projects/${esc(p.key)}/roadmap">${icon('calendar', 13)} Roadmap</a><a class="btn sm" href="#/projects/${esc(p.key)}/board">${icon('board', 13)} Tablero</a>
          <button class="icon-btn sm" data-unproject="${p.id}" title="Desvincular del ticket">${icon('x', 13)}</button></span>
      </footer>
    </section>`;
  }

  async function convertToProject() {
    const t = d.ticket;
    const rules = state.meta.helpdesk?.dev_rules || {};
    const convertStatus = rules.on_convert_status_id ? statusById(rules.on_convert_status_id)?.name : null;
    const ruleText = convertStatus ? `pasa a <b>${esc(convertStatus)}</b>` : `mantiene su estado actual (<b>${esc(statusById(t.status_id)?.name || '—')}</b>)`;
    const { openProjectForm } = await import('./project-form.js');
    const r = await openProjectForm({ ticket: t, ruleText, canConfigure: isAdmin() });
    if (!r) return;
    await refreshMeta();
    d = r.detail;
    draw();
    toast(`Proyecto ${r.project.key} creado con ${r.phases} etapas`);
  }

  async function linkProject() {
    const projects = state.meta.projects.filter((p) => !p.archived);
    if (!projects.length) return toast('Todavía no hay proyectos', 'error');
    const md = modal({
      title: 'Vincular a un proyecto existente',
      body: `<label class="field"><span>Proyecto</span><select class="input" name="key">${projects.map((p) => `<option value="${esc(p.key)}">${esc(p.key)} · ${esc(p.name)}</option>`).join('')}</select></label>
        <p class="hint">El ticket va a mostrar el avance por fases (épicas) de ese proyecto.</p>`,
      footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Vincular</button>',
    });
    md.el.querySelector('[data-ok]').addEventListener('click', async () => {
      try {
        const r = await api(`/tickets/${num}/project`, { method: 'POST', body: { project_key: md.el.querySelector('[name=key]').value } });
        md.close();
        d = r.detail;
        draw();
        toast('Proyecto vinculado');
      } catch (er) { toastError(er); }
    });
  }

  async function createIssueFromTicket() {
    const opKey = newKey();
    const projects = state.meta.projects.filter((p) => !p.archived);
    if (!projects.length) return toast('Primero creá un proyecto', 'error');
    const t = d.ticket;
    const md = modal({
      title: 'Crear tarea de proyecto desde el ticket',
      body: `<div class="grid2">
        <label class="field"><span>Proyecto</span><select class="input" name="project_id">${options(projects, projects[0].id, { label: (p) => `${p.key} · ${p.name}` })}</select></label>
        <label class="field"><span>Tipo</span><select class="input" name="type"><option value="task">Tarea</option><option value="bug">Bug</option><option value="story">Historia</option></select></label>
      </div>
      <label class="field"><span>Título</span><input class="input" name="title" value="${esc(`#${t.number} ${t.subject}`)}"></label>
      <label class="field"><span>Asignar a</span><select class="input" name="assignee_id"><option value="">— Sin asignar</option>${options(state.meta.users.filter((u) => u.active), t.assignee_id)}</select></label>
      <p class="hint">Se copia la descripción original y el ticket queda vinculado.</p>`,
      footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Crear</button>',
    });
    md.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const f = (n) => md.el.querySelector(`[name=${n}]`).value;
      try {
        d = await api(`/tickets/${num}/issues`, { method: 'POST', idempotencyKey: opKey, body: { project_id: Number(f('project_id')), type: f('type'), title: f('title'), assignee_id: Number(f('assignee_id')) || null } });
        md.close();
        draw();
        toast('Tarea creada y vinculada');
      } catch (er) { toastError(er); }
    });
  }

  await load();
}
