// Configuración v1.4: alertas de antigüedad, inteligencia artificial y Microsoft 365.
import { state, api, esc, icon, toast, toastError, modal, options, PRIORITY, confirmDialog, relTime, fmtNum, fmtDateTime, sanitize, fieldLabel } from '../core.js';
import { refreshMeta } from '../app.js';

const sw = (name, checked, label = 'Activo') => `<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
const ck = (name, checked, label) => `<label class="check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
const fld = (label, inner, hint = '') => `<label class="field"><span>${label}</span>${inner}${hint ? `<small class="hint">${hint}</small>` : ''}</label>`;
const inp = (name, value, attrs = '') => `<input class="input" name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
const num = (name, value, attrs = '') => `<input class="input" type="number" name="${name}" value="${esc(value ?? '')}" ${attrs}>`;

// ---------- Alertas de antigüedad ----------
export async function aging(body) {
  const hd = await api('/admin/settings/helpdesk');
  const a = {
    green_days: 7, amber_days: 30, critical_days: 90, inactive_days: 15, waiting_hours: 24, buckets: [7, 15, 30, 60, 90], list_size: 6, ...(hd.aging || {}),
  };
  const w = { urgent: 40, high: 25, medium: 10, overdue: 25, due_soon: 15, waiting: 15, vip: 15, reopened: 5, age_week: 2, age_max: 20, needs_agent: 10, followers: 5, ...(hd.aging?.weights || {}) };
  const WL = [
    ['urgent', 'Prioridad Urgente'], ['high', 'Prioridad Alta'], ['medium', 'Prioridad Media'], ['overdue', 'SLA vencido'], ['due_soon', 'Vence en menos de 24 h'],
    ['waiting', 'El usuario espera respuesta'], ['vip', 'Usuario VIP'], ['reopened', 'Por cada reapertura (máx. 2)'], ['needs_agent', 'La respuesta automática no le sirvió'],
    ['followers', '3 o más seguidores'], ['age_week', 'Por cada semana abierto'], ['age_max', 'Tope por antigüedad'],
  ];
  body.innerHTML = `<form class="card" data-form="aging">
    <h3>${icon('clock', 16)} Alertas de antigüedad</h3>
    <p class="hint" style="margin-top:-6px">Definen los colores del gráfico de antigüedad, las alertas y las listas del tablero de inicio de cada agente.</p>
    <div class="grid3">
      ${fld('Verde hasta (días)', num('green_days', a.green_days, 'min="1"'))}
      ${fld('Ámbar hasta (días)', num('amber_days', a.amber_days, 'min="1"'))}
      ${fld('Alerta crítica desde (días)', num('critical_days', a.critical_days, 'min="1"'))}
      ${fld('"Sin actividad" después de (días)', num('inactive_days', a.inactive_days, 'min="1"'))}
      ${fld('Usuario esperando respuesta después de (horas)', num('waiting_hours', a.waiting_hours, 'min="1"'))}
      ${fld('Tickets en cada lista', num('list_size', a.list_size, 'min="3" max="20"'))}
    </div>
    ${fld('Cortes del gráfico (días, separados por coma)', inp('buckets', a.buckets.join(', ')), 'Ej.: 7, 15, 30, 60, 90 arma las columnas 0–7, 8–15, 16–30, 31–60, 61–90 y más de 90.')}
    <h4>Puntaje de importancia</h4>
    <p class="hint" style="margin-top:-4px">Cada ticket suma estos puntos (tope 100). Los más altos aparecen en "Mis tickets más importantes" con el motivo.</p>
    <div class="grid3">${WL.map(([k, l]) => fld(l, num(`w_${k}`, w[k], 'min="0" max="100"'))).join('')}</div>
    <button class="btn primary">Guardar</button>
  </form>`;
  body.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const n = (k) => Number(f[k].value) || 0;
    const next = {
      green_days: n('green_days'), amber_days: n('amber_days'), critical_days: n('critical_days'), inactive_days: n('inactive_days'), waiting_hours: n('waiting_hours'),
      list_size: n('list_size'), buckets: f.buckets.value.split(/[,;\s]+/).map(Number).filter((x) => x > 0).sort((x, y) => x - y),
      weights: Object.fromEntries(WL.map(([k]) => [k, n(`w_${k}`)])),
    };
    if (!(next.green_days < next.amber_days)) return toast('El límite verde tiene que ser menor que el ámbar', 'error');
    if (!next.buckets.length) return toast('Indicá al menos un corte para el gráfico', 'error');
    try {
      await api('/admin/settings/helpdesk', { method: 'PUT', body: { aging: next } });
      toast('Alertas guardadas');
    } catch (er) { toastError(er); }
  });
}

// ---------- Inteligencia artificial ----------
const MODES = { fixed: 'Texto fijo', guide_ai: 'Guía + IA adapta', ai: 'Generada por IA' };
const PROMPT_TABS = [['auto_reply', 'Respuesta automática'], ['copilot', 'Copiloto del agente'], ['draft', 'Borrador de respuesta'], ['classify', 'Clasificación'], ['ask', 'Preguntas al copiloto'], ['system', 'Instrucciones generales']];

export async function ai(body) {
  const data = await api('/admin/ai');
  const c = data.config;
  const m = state.meta;
  let promptTab = 'auto_reply';
  const prompts = { ...c.prompts };
  const limit = Number(c.monthly_limit) || 0;
  const pct = limit ? Math.min(100, Math.round((data.usage.calls / limit) * 100)) : 0;
  const prov = data.providers[c.provider];
  const keyBadge = data.status.keyConfigured
    ? '<span class="badge" style="--c:#059669">Clave configurada</span>'
    : '<span class="badge" style="--c:#d97706">Falta la clave</span>';

  body.innerHTML = `<form data-form="ai">
  <div class="dash-grid two" style="margin-bottom:16px">
    <section class="card">
      <div class="sec-head"><h3>${icon('sparkles', 16)} Proveedor y modelo</h3>${keyBadge}</div>
      <div class="grid2">
        ${fld('Proveedor', `<select class="input" name="provider">${Object.entries(data.providers).map(([k, p]) => `<option value="${k}" ${k === c.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}
        ${fld('Modelo', `<select class="input" name="tier"><option value="fast" ${c.tier !== 'advanced' ? 'selected' : ''}>Rápido y económico${prov.fast ? ` (${esc(prov.fast)})` : ''}</option><option value="advanced" ${c.tier === 'advanced' ? 'selected' : ''}>Avanzado${prov.advanced ? ` (${esc(prov.advanced)})` : ''}</option></select>`)}
        ${fld('Modelo específico (opcional)', inp('model', c.model, `placeholder="${c.provider === 'azure' ? 'Nombre del deployment' : 'Dejar vacío para usar el de arriba'}"`), c.provider === 'azure' ? 'En Azure OpenAI es el nombre del deployment.' : '')}
        ${fld('Trato con los usuarios', `<select class="input" name="tone"><option value="usted" ${c.tone !== 'vos' ? 'selected' : ''}>Usted</option><option value="vos" ${c.tone === 'vos' ? 'selected' : ''}>Vos</option></select>`)}
      </div>
      <p class="small">La clave va en Vercel como <code>AI_API_KEY</code>${c.provider === 'azure' ? ', junto con <code>AZURE_OPENAI_ENDPOINT</code>' : ''}. Nunca se guarda en la base.${c.provider === 'azure' && !data.status.azureEndpoint ? ' <span class="warn-text">Falta AZURE_OPENAI_ENDPOINT.</span>' : ''}</p>
      <p class="hint">Sin clave, las reglas de texto fijo y las guías siguen respondiendo; el copiloto muestra tickets parecidos y artículos.</p>
    </section>
    <section class="card">
      <h3>${icon('chart', 16)} Consumo del mes</h3>
      <div class="row gap" style="justify-content:space-between"><b style="font-size:22px">${fmtNum(data.usage.calls)} <small class="muted" style="font-size:13px;font-weight:500">consultas${limit ? ` de ${fmtNum(limit)}` : ''}</small></b>${data.usage.errors ? `<span class="badge" style="--c:#d97706">${data.usage.errors} con error</span>` : ''}</div>
      ${limit ? `<div class="usage-bar"><span style="width:${pct}%"></span></div><small class="muted">${pct}% del tope mensual</small>` : '<p class="muted small">Sin tope mensual.</p>'}
      <p class="small" style="margin-top:8px">${fmtNum(data.usage.input_tokens)} tokens de entrada · ${fmtNum(data.usage.output_tokens)} de salida</p>
      ${fld('Tope mensual de consultas (0 = sin tope)', num('monthly_limit', c.monthly_limit, 'min="0"'), 'Al llegar al tope, la IA se pausa hasta el mes siguiente y siguen funcionando las reglas de texto fijo.')}
      <h4>Respuestas automáticas este mes</h4>
      <div class="perf" style="grid-template-columns:repeat(4,1fr);gap:8px">
        <div><span>Enviadas</span><b style="font-size:18px">${data.month.auto_replies}</b></div>
        <div><span>Le sirvieron</span><b style="font-size:18px;color:var(--ok)">${data.month.helpful}</b></div>
        <div><span>Pidieron agente</span><b style="font-size:18px;color:var(--warn)">${data.month.not_helpful}</b></div>
        <div><span>No crearon ticket</span><b style="font-size:18px">${data.month.deflected}</b></div>
      </div>
    </section>
  </div>

  <section class="card">
    <h3>${icon('zap', 16)} Funciones</h3>
    <div class="feat-list">
      <div class="feat"><div><b>Copiloto del agente</b><small>Resumen, clasificación sugerida, pasos, tickets parecidos, borrador de respuesta y preguntas, dentro del ticket.</small></div>${sw('f_copilot', c.features.copilot)}</div>
      <div class="feat"><div><b>Sugerencias en el portal</b><small>Mientras el usuario escribe, el portal muestra "Antes de enviar, pruebe esto". Si se resuelve, no se crea el ticket.</small></div>${sw('f_portal_suggest', c.features.portal_suggest)}</div>
      <div class="feat"><div><b>Primera respuesta automática</b><small>Al crear el ticket, el usuario recibe pasos para probar y puede confirmar si le sirvió.
        <span class="row gap wrap" style="margin-top:4px">${ck('ch_portal', c.auto_reply_channels.includes('portal'), 'Tickets del portal')}${ck('ch_email', c.auto_reply_channels.includes('email'), 'Tickets por correo')}</span></small></div>${sw('f_auto_reply', c.features.auto_reply)}</div>
      <div class="feat"><div><b>Clasificación al crear</b><small>Propone grupo, categoría técnica, tipo, área y prioridad.
        <span class="row gap" style="margin-top:4px"><select class="input sm" name="classify_mode" style="width:auto"><option value="suggest" ${c.features.classify_mode !== 'apply' ? 'selected' : ''}>Solo sugerir en el copiloto</option><option value="apply" ${c.features.classify_mode === 'apply' ? 'selected' : ''}>Aplicar automáticamente a tickets del portal y correo</option></select></span></small></div>${sw('f_classify', c.features.classify)}</div>
      <div class="feat"><div><b>Usar la base de conocimiento</b><small>Las respuestas se apoyan en los artículos publicados y los citan.</small></div>${sw('f_use_kb', c.features.use_kb)}</div>
      <div class="feat"><div><b>Responder aunque ninguna regla coincida</b><small>La IA responde con la base de conocimiento solo si su confianza es suficiente.
        <span class="row gap" style="margin-top:4px">Confianza mínima <input class="input sm" type="number" name="min_confidence" min="50" max="100" value="${c.fallback.min_confidence}" style="width:76px"> %</span></small></div>${sw('fb_enabled', c.fallback.enabled)}</div>
    </div>
  </section>

  <section class="card">
    <div class="sec-head"><h3>${icon('list', 16)} Reglas de respuesta automática</h3><button type="button" class="btn sm primary" data-act="new-rule">${icon('plus', 13)} Nueva regla</button></div>
    <p class="hint" style="margin-top:-4px">Se evalúan en orden; gana la primera que coincide. Valen para las sugerencias del portal y para la primera respuesta.</p>
    <div class="table-wrap"><table class="tbl compact rules-tbl"><thead><tr><th>Regla</th><th>Cuándo</th><th>Qué responde</th><th>Modo</th><th>Si el usuario confirma</th><th class="r">Uso</th><th>Activa</th></tr></thead>
    <tbody>${data.rules.map((r) => `<tr class="clickable ${r.active ? '' : 'inactive'}" data-rule="${r.id}">
      <td><b>${esc(r.name)}</b></td>
      <td><div class="kw">${r.keywords.map((k) => `<span class="chip sm">${esc(k)}</span>`).join('')}${r.tech_category_ids.map((id) => `<span class="chip sm">${esc(m.techCategories.find((x) => x.id === id)?.name || id)}</span>`).join('')}${r.category_ids.map((id) => `<span class="chip sm">${esc(m.categories.find((x) => x.id === id)?.name || id)}</span>`).join('')}</div></td>
      <td class="muted small"><span class="clamp2">${esc(r.guide.replace(/\n/g, ' · ') || 'La IA genera los pasos con la base de conocimiento')}</span></td>
      <td><span class="mode-pill ${r.mode}">${MODES[r.mode]}</span></td>
      <td class="small">${r.on_confirm === 'resolve' ? 'Resolver el ticket' : 'Dejar abierto'}</td>
      <td class="r small nowrap" title="Coincidencias · sin crear ticket · confirmadas">${r.hits} · ${r.deflected} · ${r.confirmed}</td>
      <td>${r.active ? '<span class="badge" style="--c:#059669">Sí</span>' : '<span class="badge">No</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin reglas.</td></tr>'}</tbody></table></div>
    <h4>Nunca responder automáticamente cuando…</h4>
    <div class="grid2">
      <div class="field"><span>Prioridad</span><div class="row gap wrap">${Object.entries(PRIORITY).map(([k, v]) => ck(`ex_p_${k}`, c.exclusions.priorities.map(Number).includes(Number(k)), v)).join('')}</div></div>
      ${fld(`${esc(fieldLabel('tech'))} (no responder)`, `<select class="input" name="ex_techs" multiple size="4">${options(m.techCategories.filter((t) => t.active || (c.exclusions.tech_ids || []).includes(t.id)), c.exclusions.tech_ids || [])}</select>`)}
      ${fld('Áreas del solicitante (separadas por coma)', inp('ex_areas', (c.exclusions.areas || []).join(', '), 'placeholder="Ej.: Presidencia, Directorio"'))}
      <div class="field"><span>Además</span>${ck('ex_vip', c.exclusions.vip, 'El solicitante es VIP')}${ck('ex_same', c.exclusions.open_same_topic, 'Ya tiene otro ticket abierto del mismo tema')}</div>
    </div>
  </section>

  <section class="card">
    <h3>${icon('edit', 16)} Prompts</h3>
    <p class="hint" style="margin-top:-6px">Instrucciones que recibe la IA. Las variables entre llaves se reemplazan con los datos del ticket. El formato de la respuesta lo agrega el sistema.</p>
    <div class="prompt-tabs">${PROMPT_TABS.map(([k, l]) => `<button type="button" data-ptab="${k}" class="${k === promptTab ? 'on' : ''}">${l}</button>`).join('')}</div>
    <textarea class="input prompt-area" name="prompt" rows="10" aria-label="Prompt"></textarea>
    <div class="var-chips">${data.vars.map(([v, d]) => `<button type="button" data-var="${esc(v)}" title="${esc(d)}">${esc(v)}</button>`).join('')}</div>
    <button type="button" class="link-btn" data-act="reset-prompt">Restaurar el texto original de este prompt</button>
  </section>
  <div class="row gap" style="margin-bottom:16px"><button class="btn primary">Guardar configuración de IA</button><span class="muted small">Las reglas se guardan por separado, al editarlas.</span></div>
  </form>

  <section class="card">
    <h3>${icon('play', 16)} Probar</h3>
    <p class="hint" style="margin-top:-6px">Simula un ticket nuevo y muestra qué regla se aplica, qué respondería y cómo lo clasificaría. No crea nada.</p>
    <form data-form="ai-test">
      <div class="grid2">
        ${fld('Asunto', inp('t_subject', 'No puedo ver mis correos'))}
        ${fld('Correo del solicitante (opcional)', inp('t_email', '', 'type="email" placeholder="para probar exclusiones"'))}
      </div>
      ${fld('Descripción', `<textarea class="input" name="t_body" rows="2">Desde esta mañana abro Outlook y la bandeja aparece vacía.</textarea>`)}
      <div class="row gap"><select class="input sm" name="t_priority" style="width:auto">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><button class="btn">Probar respuesta</button></div>
    </form>
    <div class="test-slot"></div>
  </section>`;

  const ta = body.querySelector('[name=prompt]');
  const showPrompt = () => { ta.value = prompts[promptTab] || ''; body.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('on', b.dataset.ptab === promptTab)); };
  showPrompt();
  ta.addEventListener('input', () => { prompts[promptTab] = ta.value; });

  body.addEventListener('click', async (e) => {
    const pt = e.target.closest('[data-ptab]');
    if (pt) { promptTab = pt.dataset.ptab; showPrompt(); return; }
    const v = e.target.closest('[data-var]');
    if (v) {
      const s = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + v.dataset.var + ta.value.slice(ta.selectionEnd ?? s);
      prompts[promptTab] = ta.value;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + v.dataset.var.length;
      return;
    }
    if (e.target.closest('[data-act=reset-prompt]')) { prompts[promptTab] = data.defaults[promptTab]; showPrompt(); toast('Texto original restaurado (falta guardar)'); return; }
    if (e.target.closest('[data-act=new-rule]')) return ruleForm(null);
    const tr = e.target.closest('[data-rule]');
    if (tr) ruleForm(data.rules.find((r) => r.id === Number(tr.dataset.rule)));
  });

  body.querySelector('[data-form=ai]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = {
      provider: f.provider.value, tier: f.tier.value, model: f.model.value.trim(), tone: f.tone.value, monthly_limit: Number(f.monthly_limit.value) || 0,
      features: {
        copilot: f.f_copilot.checked, portal_suggest: f.f_portal_suggest.checked, auto_reply: f.f_auto_reply.checked, classify: f.f_classify.checked,
        classify_mode: f.classify_mode.value, use_kb: f.f_use_kb.checked,
      },
      auto_reply_channels: [f.ch_portal.checked && 'portal', f.ch_email.checked && 'email'].filter(Boolean),
      fallback: { enabled: f.fb_enabled.checked, min_confidence: Number(f.min_confidence.value) || 80 },
      exclusions: {
        priorities: Object.keys(PRIORITY).filter((k) => f[`ex_p_${k}`].checked).map(Number),
        areas: f.ex_areas.value.split(',').map((x) => x.trim()).filter(Boolean),
        tech_ids: [...f.ex_techs.selectedOptions].map((o) => Number(o.value)),
        vip: f.ex_vip.checked, open_same_topic: f.ex_same.checked,
      },
      prompts: Object.fromEntries(PROMPT_TABS.map(([k]) => [k, prompts[k] === data.defaults[k] ? '' : prompts[k]])),
    };
    try {
      await api('/admin/ai', { method: 'PUT', body: patch });
      await refreshMeta();
      toast('Configuración de IA guardada');
      ai(body);
    } catch (er) { toastError(er); }
  });

  body.querySelector('[data-form=ai-test]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const slot = body.querySelector('.test-slot');
    const btn = f.querySelector('button');
    btn.disabled = true;
    slot.innerHTML = '<div class="test-out"><span class="spinner sm"></span> Probando…</div>';
    try {
      const r = await api('/admin/ai/test', { method: 'POST', body: { subject: f.t_subject.value, body_text: f.t_body.value, email: f.t_email.value, priority: Number(f.t_priority.value) } });
      const cl = r.classification;
      slot.innerHTML = `<div class="test-out">
        ${r.excluded ? `<p><b>No se responde automáticamente:</b> ${esc(r.excluded)}</p>` : r.reply ? `
          <p class="small muted">${r.reply.rule ? `Regla aplicada: <b>${esc(r.reply.rule.name)}</b>` : 'Ninguna regla coincidió'} · ${r.reply.used_ai ? `generada con IA${r.reply.confidence !== null ? ` (confianza ${r.reply.confidence} %)` : ''}` : 'texto de la regla'}</p>
          ${sanitize(r.reply.html) || '<p class="muted">Sin pasos: solo se sugieren artículos.</p>'}
          ${r.reply.articles.length ? `<p class="small">Artículos: ${r.reply.articles.map((a) => esc(a.title)).join(' · ')}</p>` : ''}` : '<p><b>No respondería:</b> ninguna regla coincide y la IA no está disponible o no tiene confianza suficiente.</p>'}
        ${cl ? `<p class="small" style="margin-top:8px">Clasificación: ${[cl.names.tech_category, cl.priority && PRIORITY[cl.priority], cl.names.type].filter(Boolean).map(esc).join(' · ')}${cl.motivo ? ` — <span class="muted">${esc(cl.motivo)}</span>` : ''}</p>` : r.classError ? `<p class="warn-text small">Clasificación: ${esc(r.classError)}</p>` : ''}
      </div>`;
    } catch (er) { slot.innerHTML = ''; toastError(er); }
    btn.disabled = false;
  });

  async function ruleForm(r) {
    const articles = await api('/kb/articles?status=published').catch(() => []);
    const m2 = state.meta;
    const md = modal({
      title: r ? `Regla: ${r.name}` : 'Nueva regla de respuesta automática',
      wide: true,
      body: `<div class="grid2">
        ${fld('Nombre', inp('name', r?.name || '', 'placeholder="Ej.: Correo / Outlook"'))}
        ${fld('Orden', num('sort', r?.sort ?? data.rules.length, 'min="0"'), 'Las reglas con número menor se evalúan primero.')}
      </div>
      <h4 style="margin-top:0">Cuándo se aplica <small class="muted">(alcanza con que se cumpla una)</small></h4>
      ${fld('El asunto o la descripción contiene alguna de estas palabras (separadas por coma)', inp('keywords', (r?.keywords || []).join(', '), 'placeholder="correo, outlook, mails"'), 'No distingue mayúsculas ni acentos. "correo" también encuentra "correos".')}
      <div class="grid2">
        ${fld('Categoría técnica', `<select class="input" name="tech" multiple size="5">${options(m2.techCategories.filter((x) => x.active), r?.tech_category_ids || [])}</select>`)}
        ${fld('Área (categoría)', `<select class="input" name="cats" multiple size="5">${options(m2.categories.filter((x) => x.active), r?.category_ids || [])}</select>`)}
      </div>
      <h4>Qué responde</h4>
      ${fld('Guía o texto de la respuesta (un paso por línea)', `<textarea class="input" name="guide" rows="5" placeholder="1. Reinicie la computadora.&#10;2. ...">${esc(r?.guide || '')}</textarea>`, 'Podés usar {contacto.nombre} y {ticket.asunto}.')}
      <div class="grid3">
        ${fld('Modo', `<select class="input" name="mode">${Object.entries(MODES).map(([k, l]) => `<option value="${k}" ${(r?.mode || 'guide_ai') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'Texto fijo no usa IA. Guía + IA adapta los pasos al caso.')}
        ${fld('Si el usuario confirma que le sirvió', `<select class="input" name="on_confirm"><option value="resolve" ${r?.on_confirm !== 'keep_open' ? 'selected' : ''}>Resolver el ticket</option><option value="keep_open" ${r?.on_confirm === 'keep_open' ? 'selected' : ''}>Dejar abierto</option></select>`)}
        ${fld('Artículos a sugerir', `<select class="input" name="kb" multiple size="3">${options(articles, r?.kb_article_ids || [], { label: (a) => a.title })}</select>`)}
      </div>
      ${ck('active', r ? r.active : true, 'Regla activa')}`,
      footer: `${r ? '<button class="btn danger" data-del>Eliminar</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Guardar</button>`,
    });
    const g = (n) => md.el.querySelector(`[name=${n}]`);
    const multi = (n) => [...g(n).selectedOptions].map((o) => Number(o.value));
    md.el.querySelector('[data-ok]').addEventListener('click', async () => {
      const payload = {
        name: g('name').value, sort: Number(g('sort').value) || 0, keywords: g('keywords').value, tech_category_ids: multi('tech'), category_ids: multi('cats'),
        guide: g('guide').value, mode: g('mode').value, on_confirm: g('on_confirm').value, kb_article_ids: multi('kb'), active: g('active').checked,
      };
      try {
        await api(r ? `/admin/ai/rules/${r.id}` : '/admin/ai/rules', { method: r ? 'PATCH' : 'POST', body: payload });
        md.close();
        toast('Regla guardada');
        ai(body);
      } catch (er) { toastError(er); }
    });
    md.el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Se elimina la regla "${r.name}".`, { danger: true, okText: 'Eliminar' }))) return;
      await api(`/admin/ai/rules/${r.id}`, { method: 'DELETE' }).catch(toastError);
      md.close();
      ai(body);
    });
  }
}

// ---------- Microsoft 365 ----------
const MS_LOGO = '<span class="ms-logo" aria-hidden="true"><i style="background:#f25022"></i><i style="background:#7fba00"></i><i style="background:#00a4ef"></i><i style="background:#ffb900"></i></span>';
const MODULE_LABEL = { login: 'Inicio de sesión', mailbox: 'Buzón de soporte', directory: 'Directorio', intune: 'Intune', sharepoint: 'SharePoint', teams: 'Teams' };

export async function m365(body) {
  const data = await api('/admin/m365');
  const c = data.config;
  const eff = c.effective;
  const st = data.status;
  const conn = !eff.connected
    ? '<span class="badge" style="--c:#d97706">Falta configurar</span>'
    : st?.ok ? `<span class="badge" style="--c:#059669">Conectado${st.domain ? ` · ${esc(st.domain)}` : ''}</span>` : '<span class="badge" style="--c:#475569">Sin probar</span>';
  const card = (key, title, desc, inner, actions = '') => `<section class="card ${c[key].enabled ? '' : 'off'}" data-mod="${key}">
    <div class="sec-head"><h3>${title}</h3>${sw(`${key}.enabled`, c[key].enabled)}</div>
    <p class="mod-desc">${desc}</p>${inner}${actions ? `<div class="row gap wrap" style="margin-top:4px">${actions}</div>` : ''}</section>`;
  const perms = st?.permissions || data.permissions.map((p) => ({ ...p, granted: null, needed: c[p.module]?.enabled }));
  const ds = c.directory.last_sync;

  body.innerHTML = `<form data-form="m365">
  <section class="card">
    <div class="sec-head"><h3>${MS_LOGO} Conexión con Microsoft 365</h3>${conn}</div>
    <div class="grid3">
      ${fld('Tenant ID', inp('tenant_id', c.tenant_id, `placeholder="${eff.tenantFromEnv ? 'Tomado de MS_TENANT_ID en Vercel' : 'ID del directorio (tenant)'}"`))}
      ${fld('Client ID (registro de la aplicación)', inp('client_id', c.client_id, `placeholder="${eff.clientFromEnv ? 'Tomado de MS_CLIENT_ID en Vercel' : 'ID de la aplicación (cliente)'}"`))}
      <div class="field"><span>Secreto</span><span style="padding:8px 0;font-size:13px">${eff.hasSecret ? `En Vercel (<code>MS_CLIENT_SECRET</code>)${data.secret_expires ? ` · vence ${esc(data.secret_expires)}` : ''}` : '<span class="warn-text">Falta <code>MS_CLIENT_SECRET</code> en Vercel</span>'}</span></div>
    </div>
    ${st?.ok ? `<p class="small muted">Probado ${relTime(st.tested_at)}${st.organization ? ` · ${esc(st.organization)}` : ''} · ${st.roles.length} permisos concedidos.</p>` : ''}
    <div class="row gap wrap"><button type="button" class="btn sm" data-act="test">Probar conexión</button><button class="btn sm primary">Guardar</button></div>
    <details style="margin-top:10px"><summary class="small"><b>Cómo registrar la aplicación en Entra ID</b></summary>
      <ol class="steps" style="margin-top:8px">
        <li>En <b>Entra ID → Registros de aplicaciones → Nuevo registro</b>, cuentas de este directorio. URI de redirección (Web): <code>${esc(data.redirect_uri)}</code></li>
        <li>Copiá el <b>Id. de directorio (tenant)</b> y el <b>Id. de aplicación (cliente)</b> en los campos de arriba.</li>
        <li>En <b>Certificados y secretos</b>, creá un secreto y cargalo en Vercel como <code>MS_CLIENT_SECRET</code> (y su vencimiento en <code>MS_CLIENT_SECRET_EXPIRES</code>, para verlo acá). Volvé a desplegar.</li>
        <li>En <b>Permisos de API → Microsoft Graph → Permisos de aplicación</b>, agregá los de la tabla de abajo según los módulos que actives y hacé clic en <b>Conceder consentimiento de administrador</b>.</li>
        <li>Para limitar el acceso al buzón de soporte, aplicá una <i>Application Access Policy</i> de Exchange Online sobre la aplicación.</li>
      </ol>
    </details>
  </section>

  <div class="mod-grid">
    ${card('login', 'Inicio de sesión (Entra ID)', 'Los agentes ingresan con su cuenta de Microsoft.', `
      ${ck('login.only_microsoft', c.login.only_microsoft, 'Solo con Microsoft (deshabilitar claves locales; el superadmin sigue entrando con su clave)')}
      ${fld('Exigir que pertenezca al grupo (opcional)', inp('login.required_group', c.login.required_group, 'placeholder="IT-MesaDeAyuda"'))}
      ${ck('login.auto_create_agents', c.login.auto_create_agents, 'Crear el agente automáticamente si pertenece al grupo')}`)}
    ${card('mailbox', 'Buzón de soporte (Outlook)', 'Lee el buzón directo por Microsoft Graph: reemplaza el flujo de Power Automate.', `
      ${fld('Buzón', inp('mailbox.address', c.mailbox.address, 'type="email" placeholder="ayuda@hanseatica.com"'))}
      ${ck('mailbox.send_replies', c.mailbox.send_replies, 'Enviar las respuestas desde este buzón (quedan en Elementos enviados)')}
      ${ck('mailbox.mark_read', c.mailbox.mark_read, 'Marcar como leídos los correos procesados')}
      <div class="grid2">${fld('Mover los procesados a la carpeta', inp('mailbox.processed_folder', c.mailbox.processed_folder))}${fld('Leer cada (minutos)', num('mailbox.interval_min', c.mailbox.interval_min, 'min="1" max="60"'))}</div>
      <small class="hint">Se lee mientras los agentes usan la app y una vez por día. Para leerlo siempre cada minuto, programá un POST a <code>${esc(data.poll_url)}</code> con el encabezado <code>x-cron-key: CRON_SECRET</code> (cron-job.org o Power Automate "Recurrencia").</small>`,
      '<button type="button" class="btn sm" data-act="poll">Leer ahora</button>')}
    ${card('directory', 'Directorio de usuarios', 'Sincroniza los empleados de Entra ID como contactos: nombre, área (Department), cargo, teléfono y jefe. Corre todos los días.', `
      ${fld('Grupo de agentes (opcional)', inp('directory.agent_group', c.directory.agent_group, 'placeholder="IT-MesaDeAyuda"'))}
      ${ck('directory.create_agents', c.directory.create_agents, 'Crear como agentes a los miembros del grupo que no existan')}
      ${ck('directory.deactivate_missing', c.directory.deactivate_missing, 'Desactivar contactos dados de baja en Entra ID')}
      <small class="muted">${ds ? `Última sincronización: ${fmtDateTime(ds.at)} · ${fmtNum(ds.contacts)} contactos (${ds.created} nuevos)${ds.agents ? ` · ${ds.agents} agentes nuevos` : ''}` : 'Todavía no se sincronizó.'}</small>`,
      '<button type="button" class="btn sm" data-act="sync">Sincronizar ahora</button>')}
    ${card('teams', 'Microsoft Teams', 'Avisos al canal del equipo con un webhook de Workflows ("Cuando se recibe una solicitud de webhook de Teams" → publicar en un canal).', `
      ${fld('URL del webhook', inp('teams.webhook_url', c.teams.webhook_url, 'placeholder="https://…"'))}
      ${ck('teams.notify_urgent', c.teams.notify_urgent, 'Tickets urgentes al crearse')}
      ${ck('teams.notify_overdue', c.teams.notify_overdue, 'Resumen diario de SLA vencidos')}
      ${ck('teams.notify_unassigned', c.teams.notify_unassigned, 'Tickets nuevos sin asignar')}`,
      '<button type="button" class="btn sm" data-act="teams">Enviar prueba</button>')}
    ${card('intune', 'Intune (dispositivos)', 'Muestra en el ticket los equipos del solicitante: modelo, sistema, cumplimiento y último contacto.', `
      <div class="mini-device"><b>Así se ve en el ticket</b><div class="row gap"><span class="grow">NB-HANSA-0142 · Windows 11 23H2</span><span class="badge" style="--c:var(--ok)">Cumple</span></div><small class="muted">Último contacto hace 2 h · BitLocker activo</small></div>
      ${ck('intune.allow_actions', c.intune.allow_actions, 'Permitir acciones remotas (sincronizar, reiniciar) con confirmación; quedan en la auditoría')}`)}
    ${card('sharepoint', 'SharePoint (adjuntos)', 'Guarda los adjuntos nuevos en una biblioteca de SharePoint en lugar de la base de datos. El tope por archivo sigue siendo 3 MB por el límite de Vercel.', `
      ${fld('Sitio', inp('sharepoint.site_url', c.sharepoint.site_url, 'placeholder="https://hanseatica.sharepoint.com/sites/IT"'))}
      <div class="grid2">${fld('Biblioteca', inp('sharepoint.library', c.sharepoint.library))}${fld('Carpeta', inp('sharepoint.folder', c.sharepoint.folder))}</div>`,
      '<button type="button" class="btn sm" data-act="sp">Probar biblioteca</button>')}
  </div>
  <div class="row gap" style="margin-bottom:16px"><button class="btn primary">Guardar configuración</button></div>
  </form>

  <section class="card">
    <h3>${icon('shield', 16)} Permisos de la aplicación</h3>
    <div class="table-wrap"><table class="tbl compact"><thead><tr><th>Permiso (Microsoft Graph, aplicación)</th><th>Módulo</th><th>Para qué</th><th>Estado</th></tr></thead><tbody>
    ${perms.map((p) => `<tr><td><code>${esc(p.perm)}</code></td><td>${esc(MODULE_LABEL[p.module] || p.module)}</td><td class="small">${esc(p.use)}</td>
      <td>${p.granted === null ? '<span class="perm-na">Sin probar</span>' : p.granted ? '<span class="perm-ok">Concedido</span>' : p.needed ? '<span class="perm-miss">Falta consentimiento</span>' : '<span class="perm-na">No se usa</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Teams no necesita permisos de Graph: usa el webhook del canal.</p>
  </section>

  <section class="card">
    <div class="sec-head"><h3>${icon('list', 16)} Actividad de la integración</h3><button type="button" class="link-btn" data-act="reload">Actualizar</button></div>
    ${data.log.length ? `<ul class="m365-log">${data.log.map((l) => `<li class="${l.level}"><time>${fmtDateTime(l.created_at).replace(' hs', '')}</time><span>${esc(MODULE_LABEL[l.module] || l.module)} · ${esc(l.message)}</span></li>`).join('')}</ul>` : '<p class="muted small">Sin actividad todavía.</p>'}
  </section>`;

  const form = body.querySelector('[data-form=m365]');
  form.addEventListener('change', (e) => {
    if (e.target.name?.endsWith('.enabled')) e.target.closest('[data-mod]')?.classList.toggle('off', !e.target.checked);
  });

  function collect() {
    const out = { tenant_id: form.tenant_id.value.trim(), client_id: form.client_id.value.trim() };
    for (const el of form.querySelectorAll('[name*="."]')) {
      const [mod, key] = el.name.split('.');
      out[mod] = out[mod] || {};
      out[mod][key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || 0 : el.value.trim();
    }
    return out;
  }
  async function save(silent = false) {
    await api('/admin/m365', { method: 'PUT', body: collect() });
    if (!silent) toast('Configuración guardada');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await save(); await refreshMeta(); m365(body); } catch (er) { toastError(er); }
  });

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'reload') return m365(body);
    const paths = { test: '/admin/m365/test', poll: '/admin/m365/poll', sync: '/admin/m365/sync-directory', teams: '/admin/m365/teams-test', sp: '/admin/m365/sharepoint-test' };
    if (!paths[act]) return;
    const label = b.innerHTML;
    b.disabled = true;
    b.innerHTML = '<span class="spinner sm"></span> Un momento…';
    try {
      await save(true);
      const r = await api(paths[act], { method: 'POST' });
      const msg = {
        test: () => `Conexión correcta${r.organization ? ` con ${r.organization}` : ''}`,
        poll: () => (r.skipped ? 'El buzón no está activo' : `${r.read} correo(s) procesado(s)`),
        sync: () => `${r.contacts} empleados sincronizados (${r.created} nuevos)`,
        teams: () => 'Mensaje de prueba enviado a Teams',
        sp: () => 'Biblioteca encontrada',
      }[act]();
      toast(msg);
      await refreshMeta();
      m365(body);
    } catch (er) {
      toastError(er);
      b.disabled = false;
      b.innerHTML = label;
    }
  });
}
