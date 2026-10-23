// Sistemas críticos (v1.11): panel del Inicio, aviso para informar o actualizar un problema y recuadro del ticket.
import { api, esc, icon, toast, toastError, modal, isAdmin } from './core.js';

export const STATES = {
  ok: { label: 'Operativo', hint: 'Funciona normal', color: 'var(--ok)' },
  degraded: { label: 'Degradado', hint: 'Lento o con fallas parciales', color: 'var(--warn)' },
  down: { label: 'Caído', hint: 'No se puede usar', color: 'var(--danger)' },
  maint: { label: 'Mantenimiento', hint: 'Corte programado', color: '#7c3aed' },
};

const hhmm = (d) => new Date(d).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' hs';
/** "hoy 19:30 hs", "mañana 09:00 hs" o "vie 24 oct 10:00 hs". */
export function whenLabel(d) {
  const x = new Date(d);
  const today = new Date();
  const tom = new Date();
  tom.setDate(today.getDate() + 1);
  if (x.toDateString() === today.toDateString()) return `hoy ${hhmm(x)}`;
  if (x.toDateString() === tom.toDateString()) return `mañana ${hhmm(x)}`;
  return `${x.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(x)}`;
}
/** "en 2 h 40 min" (null si ya pasó). */
export function inLabel(d) {
  let m = Math.round((new Date(d) - Date.now()) / 60000);
  if (m <= 0) return null;
  if (m < 60) return `en ${m} min`;
  const h = Math.floor(m / 60);
  m %= 60;
  if (h >= 48) return `en ${Math.round(h / 24)} días`;
  return `en ${h} h${m ? ` ${m} min` : ''}`;
}
const since = (d) => {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  if (m < 1440) return `hace ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `hace ${Math.floor(m / 1440)} d`;
};
export const isLate = (s) => s.state !== 'ok' && s.eta && new Date(s.eta) < new Date();
export const critPill = (st) => `<span class="crit-pill" style="--c:${STATES[st].color}"><i class="crit-dot"></i>${STATES[st].label}</span>`;

// ---------- Panel del Inicio ----------
export function criticalPanelHtml(data) {
  if (!data) return '';
  const list = data.systems;
  if (!list.length) {
    return isAdmin() ? `<section class="card crit-empty">${icon('pulse', 16)} <span><b>Sistemas críticos:</b> cargá los sistemas (CRM, Equis, VPN…) para informar caídas y mostrarlas en el portal.</span> <a class="link-btn" href="#/settings/critical">Configurar</a></section>` : '';
  }
  const bad = list.filter((s) => s.state !== 'ok');
  const late = bad.filter(isLate);
  return `<section class="card crit-panel">
    <div class="crit-head"><h3>${icon('pulse', 16)} Sistemas críticos</h3>
      ${bad.length ? `<span class="crit-sum danger-text">${bad.length === 1 ? '1 con problemas' : `${bad.length} con problemas`}</span>` : '<span class="crit-sum ok-text">Todos operativos</span>'}
      <span class="grow"></span>
      ${data.can_report ? `<span class="muted small hide-sm">Lo que marques acá se publica en el portal</span><button class="btn sm" data-crit-open="">${icon('alert', 14)} Informar un problema</button>` : ''}
    </div>
    <div class="crit-grid">${list.map((s) => {
      const lt = isLate(s);
      return `<button type="button" class="crit-sys ${s.state}" style="--c:${STATES[s.state].color}" data-crit-open="${s.id}" ${data.can_report ? '' : 'disabled'} title="${esc(s.description || '')}">
        <span class="crit-name"><i class="crit-dot"></i>${esc(s.name)}</span>
        <span>${critPill(s.state)}${s.public ? '' : ' <small class="muted">· solo interno</small>'}</span>
        <span class="crit-eta ${lt ? 'late' : ''}">${s.state === 'ok' ? '<span class="muted">Sin incidentes</span>'
          : `Resolución estimada <b>${whenLabel(s.eta)}</b>${lt ? ' · <b>vencida</b>' : ` · ${inLabel(s.eta)}`}`}</span>
        ${s.state !== 'ok' ? `<small class="muted">${esc(s.reported_by_name || '')}${s.since ? ` · ${since(s.since)}` : ''}${s.tickets ? ` · ${s.tickets} ticket${s.tickets > 1 ? 's' : ''}` : ''}</small>` : ''}
      </button>`;
    }).join('')}</div>
    ${late.length ? `<div class="crit-late">${icon('alert', 16)}<span><b>Estimación vencida: ${late.map((s) => esc(s.name)).join(', ')}.</b> Pasó la hora prevista y sigue con problemas: actualizá la estimación o marcalo resuelto (el portal muestra "Demorado").</span></div>` : ''}
  </section>`;
}

export function wireCriticalPanel(el, data, onChange) {
  el.querySelectorAll('[data-crit-open]').forEach((b) => b.addEventListener('click', () => {
    openCriticalModal({ systems: data.systems, systemId: Number(b.dataset.critOpen) || null, resolveDefault: data.resolve_tickets, onDone: onChange });
  }));
}

// ---------- Aviso: informar / actualizar / resolver ----------
const PRESETS = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [180, '3 h'], [240, '4 h'], ['tm', 'Mañana 9 hs'], ['c', 'Otra…']];
const toLocalInput = (d) => { const x = new Date(d); return new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const presetDate = (p) => {
  if (p === 'tm') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; }
  return new Date(Date.now() + Number(p) * 60000);
};

/**
 * systems: lista de /critical-systems · systemId: el sistema (o null para elegirlo) · ticketNumber: ticket desde el que se abre
 * (se suma a los vinculados) · onDone(result): después de guardar.
 */
export async function openCriticalModal({ systems, systemId = null, ticketNumber = null, resolveDefault = true, onDone }) {
  const st = { id: systemId, detail: null };
  const m = modal({ title: 'Sistema crítico', body: '<div class="crit-form"><span class="spinner"></span></div>', size: 'crit-modal' });
  const body = m.el.querySelector('.modal-body');
  let form = null;

  async function loadSystem(id) {
    st.id = id;
    st.detail = id ? await api(`/critical-systems/${id}`) : null;
    const s = st.detail?.system;
    const editing = Boolean(s && s.state !== 'ok');
    const linked = (st.detail?.tickets || []).map((t) => t.number);
    if (ticketNumber && !linked.includes(ticketNumber)) linked.push(ticketNumber);
    form = {
      editing,
      state: editing ? s.state : 'down',
      preset: editing ? null : 180,
      eta: editing && s.eta ? new Date(s.eta) : presetDate(180),
      message: editing ? s.message || '' : '',
      tickets: linked,
      resolve: resolveDefault,
    };
    draw();
  }

  function draw() {
    const s = st.detail?.system;
    m.el.querySelector('.modal-head h3').textContent = form.editing ? `Actualizar · ${s.name}` : s ? `Informar un problema · ${s.name}` : 'Informar un problema en un sistema crítico';
    const resolving = form.state === 'ok';
    const late = form.eta < new Date();
    body.innerHTML = `<form class="crit-form" novalidate>
      <label class="field"><span>Sistema</span><select class="input" name="sys" ${systemId && !ticketNumber ? 'disabled' : ''}>
        ${st.id ? '' : '<option value="">Elegí el sistema…</option>'}
        ${systems.map((x) => `<option value="${x.id}" ${x.id === st.id ? 'selected' : ''}>${esc(x.name)}${x.state !== 'ok' ? ` (${STATES[x.state].label.toLowerCase()})` : ''}</option>`).join('')}</select></label>
      ${st.id ? `
      <div class="field"><span>Estado</span><div class="crit-states">
        ${['down', 'degraded', 'maint', ...(form.editing ? ['ok'] : [])].map((k) => `<label style="--c:${STATES[k].color}"><input type="radio" name="state" value="${k}" ${form.state === k ? 'checked' : ''}>
          <b><i class="crit-dot"></i>${k === 'ok' ? 'Resuelto' : STATES[k].label}</b><small>${k === 'ok' ? 'Vuelve a operativo' : STATES[k].hint}</small></label>`).join('')}
      </div></div>
      ${resolving ? '' : `<div class="field"><span>¿En cuánto tiempo se resuelve? (aproximado)</span>
        <div class="crit-chips">${PRESETS.map(([v, l]) => `<button type="button" data-preset="${v}" class="${String(form.preset) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input class="input" type="datetime-local" name="custom" value="${toLocalInput(form.eta)}" ${form.preset === 'c' ? '' : 'hidden'}>
        <div class="crit-preview ${late ? 'late' : ''}">${late ? '<b>La hora estimada ya pasó:</b> elegí una nueva.' : `El portal va a mostrar: <b>Resolución estimada ${whenLabel(form.eta)}</b> (${inLabel(form.eta)})`}</div></div>
      <label class="field"><span>Mensaje para los usuarios <small class="muted">(opcional, se ve en el portal)</small></span>
        <textarea class="input" name="message" rows="2" maxlength="280" placeholder="Ej. No se puede ingresar al CRM. Estamos trabajando con el proveedor.">${esc(form.message)}</textarea></label>`}
      <label class="field"><span>Tickets relacionados <small class="muted">(opcional)</small></span>
        <input class="input" name="tickets" value="${form.tickets.map((n) => `#${n}`).join(', ')}" placeholder="#12, #15" autocomplete="off">
        <small class="hint">${resolving ? 'Al marcarlo resuelto podés responderles a los solicitantes.' : 'Los tickets que lleguen después se suman desde cada ticket ("Es un problema de un sistema crítico").'}</small></label>
      ${resolving ? `<label class="check"><input type="checkbox" name="resolve" ${form.resolve ? 'checked' : ''}> Responder a los solicitantes de los tickets relacionados ("${esc(s.name)} ya funciona normalmente") y dejarlos en Resuelto</label>` : ''}
      ${s && !s.public ? '<p class="hint">Este sistema es solo interno: no se muestra en el portal.</p>' : ''}
      ${st.detail?.log?.length ? `<details class="crit-log"><summary>Historial</summary><ul>${st.detail.log.map((l) => `<li>${new Date(l.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · ${esc(l.user_name || '—')} · ${l.state === 'ok' ? `Resuelto${l.tickets ? ` (${l.tickets} tickets respondidos)` : ''}` : `${STATES[l.state].label}${l.eta ? ` · resolución ${whenLabel(l.eta)}` : ''}`}</li>`).join('')}</ul></details>` : ''}
      ` : '<p class="muted small">Elegí el sistema que tiene el problema.</p>'}
    </form>`;
    let foot = m.el.querySelector('.modal-foot');
    if (!foot) { foot = document.createElement('div'); foot.className = 'modal-foot'; m.el.appendChild(foot); }
    foot.innerHTML = `${form.editing && !resolving ? '<button class="btn ok-btn" data-resolve>Marcar resuelto</button><span class="grow"></span>' : ''}
      <button class="btn" data-close>Cancelar</button>
      <button class="btn primary" data-save ${st.id ? '' : 'disabled'}>${resolving ? 'Marcar resuelto' : form.editing ? 'Actualizar' : 'Publicar'}</button>`;
    wire(foot);
  }

  function readForm() {
    const f = body.querySelector('form');
    if (f.message) form.message = f.message.value;
    form.tickets = String(f.tickets.value).split(/[\s,;]+/).map((x) => Number(x.replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0);
    if (f.resolve) form.resolve = f.resolve.checked;
  }

  function wire(foot) {
    const f = body.querySelector('form');
    f.sys.addEventListener('change', () => loadSystem(Number(f.sys.value) || null).catch(toastError));
    f.querySelectorAll('[name=state]').forEach((r) => r.addEventListener('change', () => { readForm(); form.state = r.value; draw(); }));
    f.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      readForm();
      form.preset = b.dataset.preset;
      if (form.preset !== 'c') form.eta = presetDate(form.preset);
      draw();
      if (form.preset === 'c') body.querySelector('[name=custom]').focus();
    }));
    f.custom?.addEventListener('change', () => { if (f.custom.value) { readForm(); form.eta = new Date(f.custom.value); draw(); } });
    f.addEventListener('submit', (e) => { e.preventDefault(); save(form.state); });
    foot.querySelector('[data-save]').addEventListener('click', () => save(form.state));
    foot.querySelector('[data-resolve]')?.addEventListener('click', () => { readForm(); form.state = 'ok'; draw(); });
  }

  async function save(state) {
    readForm();
    if (!st.id) return;
    if (state !== 'ok' && form.eta < new Date()) return toast('La hora estimada ya pasó: elegí una nueva', 'error');
    const btn = m.el.querySelector('[data-save]');
    btn.disabled = true;
    try {
      const r = await api(`/critical-systems/${st.id}/status`, {
        method: 'POST',
        body: { state, eta: state === 'ok' ? null : form.eta.toISOString(), message: form.message || '', tickets: form.tickets, resolve_tickets: state === 'ok' && form.resolve },
      });
      const name = st.detail.system.name;
      toast(state === 'ok' ? `${name} volvió a operativo${r.resolved ? ` · ${r.resolved} tickets respondidos y resueltos` : ''}` : `${name}: ${STATES[state].label.toLowerCase()}${st.detail.system.public ? ' · publicado en el portal' : ''}`);
      m.close();
      onDone?.(r);
    } catch (e) { toastError(e); btn.disabled = false; }
  }

  try {
    if (systemId) await loadSystem(systemId);
    else { form = { editing: false, state: 'down', preset: 180, eta: presetDate(180), message: '', tickets: ticketNumber ? [ticketNumber] : [], resolve: resolveDefault }; draw(); }
  } catch (e) { m.close(); toastError(e); }
}

// ---------- Recuadro del ticket ----------
export function ticketCriticalHtml(c) {
  if (c) {
    return `<div class="card crit-box linked" style="--c:${STATES[c.state].color}">
      <div class="row gap wrap"><b class="grow">${icon('pulse', 14)} Sistema crítico</b>${critPill(c.state)}</div>
      <p><b>${esc(c.name)}</b>${c.state !== 'ok' && c.eta ? ` · resolución ${isLate(c) ? '<b class="danger-text">vencida</b>' : whenLabel(c.eta)}` : ''}</p>
      ${c.auto ? '<small class="muted">Vinculado automáticamente al crearse (menciona el sistema). Al usuario le llegó el aviso de problema conocido.</small>' : ''}
      <div class="row gap wrap"><button class="btn sm" data-crit-act="update" data-sys="${c.id}">Actualizar estado</button><button class="link-btn" data-crit-act="unlink">Desvincular</button></div>
    </div>`;
  }
  return `<div class="card crit-box"><label class="check"><input type="checkbox" data-crit-act="mark"> <span><b>Es un problema de un sistema crítico</b><small class="hint block">Lo suma al problema informado o abre el aviso para publicarlo en el portal.</small></span></label></div>`;
}

export function wireTicketCritical(slot, number, reload) {
  slot.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-crit-act]');
    if (!b) return;
    try {
      if (b.dataset.critAct === 'unlink') {
        await api(`/tickets/${number}/critical`, { method: 'POST', body: { system_id: null } });
        toast('Desvinculado del sistema crítico');
        return reload();
      }
      const data = await api('/critical-systems');
      if (!data.systems.length) {
        if (b.type === 'checkbox') b.checked = false;
        return toast(isAdmin() ? 'Primero cargá los sistemas en Configuración → Sistemas críticos' : 'Todavía no hay sistemas críticos configurados', 'error');
      }
      if (b.dataset.critAct === 'update') {
        return openCriticalModal({ systems: data.systems, systemId: Number(b.dataset.sys), resolveDefault: data.resolve_tickets, onDone: reload });
      }
      // Tildar: con permiso, el aviso completo (elige el sistema). Sin permiso, solo se vincula a un problema ya informado.
      if (b.type === 'checkbox') b.checked = false;
      if (data.can_report) return openCriticalModal({ systems: data.systems, ticketNumber: Number(number), resolveDefault: data.resolve_tickets, onDone: reload });
      const bad = data.systems.filter((s) => s.state !== 'ok');
      if (!bad.length) return toast('No hay problemas informados. Avisale a un supervisor para que lo informe.', 'error');
      const mm = modal({
        title: 'Vincular a un sistema crítico',
        body: `<p class="muted small">Sistemas con un problema informado:</p><div class="crit-pick">${bad.map((s) => `<button class="btn" data-pick="${s.id}">${critPill(s.state)} ${esc(s.name)}</button>`).join('')}</div>`,
      });
      mm.el.querySelectorAll('[data-pick]').forEach((p) => p.addEventListener('click', async () => {
        try {
          await api(`/tickets/${number}/critical`, { method: 'POST', body: { system_id: Number(p.dataset.pick) } });
          mm.close();
          toast('Ticket vinculado');
          reload();
        } catch (er) { toastError(er); }
      }));
    } catch (er) { toastError(er); }
  });
}
