// Combinar tickets (v1.21): ventana compartida por la lista (acción masiva) y el detalle del ticket (Más → Combinar).
// Se elige cuál queda como principal; de entrada, el más antiguo. Prefijo CSS tkm-.
import { api, esc, icon, avatar, userName, toast, toastError, modal, fmtDateTime } from './core.js';

/**
 * Abre la ventana con los tickets indicados (al menos uno; desde un ticket se agregan otros).
 * onDone({ into, merged }) se llama después de combinar.
 */
export async function openMergeDialog(numbers, { onDone } = {}) {
  let info;
  try { info = await api(`/ticket-merge/info?numbers=${numbers.join(',')}`); } catch (e) { return toastError(e); }
  let list = info.tickets.filter((t) => !t.merged_into && !t.deleted);
  const skipped = info.tickets.length - list.length;
  let suggestions = info.suggestions;
  // De entrada queda como principal el más antiguo, hasta que el agente elija otro a mano
  const oldest = () => [...list].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.number - b.number)[0]?.number || null;
  let picked = false;
  let main = oldest();
  const md = modal({
    title: 'Combinar tickets',
    wide: true,
    body: '<div class="tkm"></div>',
    footer: '<span class="muted small tkm-warn"></span><span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Combinar</button>',
  });
  const root = md.el.querySelector('.tkm');
  const ok = md.el.querySelector('[data-ok]');
  const card = (t) => {
    const isMain = t.number === main;
    return `<label class="tkm-pick ${isMain ? 'main' : ''}">
      <input type="radio" name="tkm-main" value="${t.number}" ${isMain ? 'checked' : ''}>
      <div class="tkm-info"><div class="tkm-t"><b>#${t.number}</b> ${esc(t.subject)}</div>
        <div class="tkm-meta"><span>${esc(t.contact_name || '—')}</span><span>${esc(fmtDateTime(t.created_at))}</span><span>${t.messages} mensaje${t.messages === 1 ? '' : 's'}</span>${t.files ? `<span>${icon('clip', 11)} ${t.files}</span>` : ''}<span>${esc(t.status)}</span>
          ${t.assignee_id ? `<span>${avatar(t.assignee_id, 16)} ${esc(userName(t.assignee_id))}</span>` : '<span>Sin asignar</span>'}</div>
        ${t.excerpt ? `<div class="tkm-ex">${esc(t.excerpt)}</div>` : ''}</div>
      <div class="tkm-side"><span class="tkm-tag ${isMain ? 'main' : ''}">${isMain ? 'QUEDA COMO PRINCIPAL' : `PASA A #${main}`}</span>
        ${list.length > 1 ? `<button type="button" class="link-btn small" data-rm="${t.number}">Sacar</button>` : ''}</div></label>`;
  };
  function draw() {
    const others = list.filter((t) => t.number !== main);
    const msgs = others.reduce((s, t) => s + t.messages, 0);
    const files = others.reduce((s, t) => s + t.files, 0);
    const sug = suggestions.filter((t) => !list.some((x) => x.number === t.number));
    root.innerHTML = `<p class="muted" style="margin-top:0">Elegí cuál queda como <b>principal</b>. La conversación de los demás pasa a ese ticket y los demás se cierran como combinados.</p>
      ${skipped ? `<p class="tkm-note">${skipped === 1 ? 'Un ticket seleccionado ya estaba combinado o en la papelera y' : `${skipped} tickets seleccionados ya estaban combinados o en la papelera y`} no se incluye${skipped === 1 ? '' : 'n'}.</p>` : ''}
      <div class="tkm-picks" role="radiogroup" aria-label="Ticket principal">${list.map(card).join('')}</div>
      <form class="tkm-add"><input class="input" name="q" placeholder="Agregar otro ticket: número o asunto" autocomplete="off"><button class="btn">Agregar</button></form>
      <div class="tkm-matches"></div>
      ${sug.length ? `<div class="tkm-sugg"><span class="muted small">Otros tickets abiertos del mismo usuario:</span>${sug.map((t) => `<button type="button" class="tkm-chip" data-add="${t.number}">+ #${t.number} ${esc(t.subject.slice(0, 48))}</button>`).join('')}</div>` : ''}
      ${others.length ? `<div class="tkm-what"><b>Qué va a pasar</b><ul>
        <li><b>#${main}</b> recibe ${msgs} mensaje${msgs === 1 ? '' : 's'}${files ? ` y ${files} adjunto${files === 1 ? '' : 's'}` : ''} de ${others.map((t) => `#${t.number}`).join(', ')}, en orden de fecha y marcados con su ticket de origen.</li>
        <li>También pasan las horas registradas, los vínculos con proyectos y tareas, los seguidores, las etiquetas y los CC.</li>
        <li>${others.map((t) => `#${t.number}`).join(', ')} ${others.length === 1 ? 'queda cerrado' : 'quedan cerrados'} como <b>Combinado en #${main}</b>. Si el usuario responde un correo viejo, la respuesta entra a #${main}.</li></ul></div>
      <label class="check tkm-notify"><input type="checkbox" name="notify"> Avisar por correo a los usuarios de los tickets que se combinan que les vamos a seguir respondiendo en #${main}.</label>`
    : '<p class="muted small">Agregá al menos otro ticket para combinar.</p>'}`;
    const contacts = new Set(list.map((t) => t.contact_id || t.contact_name));
    md.el.querySelector('.tkm-warn').textContent = contacts.size > 1 ? `Atención: son de ${contacts.size} usuarios distintos.` : '';
    ok.disabled = list.length < 2;
  }
  const add = (t) => {
    if (!t) return;
    if (list.some((x) => x.number === t.number)) return toast(`#${t.number} ya está en la combinación`);
    if (t.merged_into) return toast(`#${t.number} ya está combinado en #${t.merged_into}`, 'error');
    list.push(t);
    if (!picked) main = oldest();
    draw();
  };
  root.addEventListener('change', (e) => { if (e.target.name === 'tkm-main') { main = Number(e.target.value); picked = true; draw(); } });
  root.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.preventDefault();
      list = list.filter((t) => t.number !== Number(rm.dataset.rm));
      if (main === Number(rm.dataset.rm)) { main = oldest(); picked = false; }
      return draw();
    }
    const ad = e.target.closest('[data-add]');
    if (ad) add([...suggestions, ...matches].find((t) => t.number === Number(ad.dataset.add)));
  });
  let matches = [];
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = e.target.q.value.trim();
    if (!term) return;
    try {
      const r = await api(`/ticket-merge/info?numbers=${list.map((t) => t.number).join(',')}&q=${encodeURIComponent(term)}`);
      matches = r.matches.filter((t) => !list.some((x) => x.number === t.number));
      suggestions = r.suggestions.length ? r.suggestions : suggestions;
      const box = root.querySelector('.tkm-matches');
      if (matches.length === 1 && /^#?\d+$/.test(term)) { add(matches[0]); return; }
      box.innerHTML = matches.length
        ? `<div class="tkm-sugg">${matches.map((t) => `<button type="button" class="tkm-chip" data-add="${t.number}">+ #${t.number} ${esc(t.subject.slice(0, 48))}</button>`).join('')}</div>`
        : '<p class="muted small">No encontré tickets abiertos con eso.</p>';
    } catch (er) { toastError(er); }
  });
  ok.addEventListener('click', async () => {
    if (list.length < 2) return;
    ok.disabled = true;
    try {
      const r = await api('/ticket-merge', { method: 'POST', body: { numbers: list.map((t) => t.number), main, notify: Boolean(root.querySelector('[name=notify]')?.checked) } });
      md.close();
      toast(`Listo: ${r.merged.map((n) => `#${n}`).join(', ')} ${r.merged.length === 1 ? 'se combinó' : 'se combinaron'} en #${r.into}`);
      onDone?.(r);
    } catch (e) { toastError(e); ok.disabled = false; }
  });
  draw();
}
