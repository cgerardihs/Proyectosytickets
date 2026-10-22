// Panel exclusivo del superadministrador: sistema, respaldo, mantenimiento y auditoría.
import { api, esc, icon, toast, toastError, confirmDialog, fmtDateTime, relTime, fmtNum, debounce, navigate, modal, fmtDate } from '../core.js';

const ACTION_LABEL = {
  login: 'Ingreso', login_failed: 'Ingreso fallido', config: 'Cambio de configuración', backup: 'Respaldo descargado', migrate: 'Actualización de base',
  empty_trash: 'Papelera vaciada', ticket_purged: 'Ticket eliminado', project_deleted: 'Proyecto eliminado', revoke_sessions: 'Sesiones cerradas',
  api_key_created: 'Clave de API creada', api_key_revoked: 'Clave de API revocada', portfolio_import: 'Portfolio importado', portfolio_export: 'Portfolio exportado',
  project_status: 'Estado de proyecto',
};
const fmtBytes = (n) => (n === null || n === undefined ? '—' : n > 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export async function superadmin(body) {
  const info = await api('/super/info');
  const flag = (v, label) => `<li>${v ? `<span class="ok-text">${icon('check', 14)}</span>` : `<span class="warn-text">${icon('x', 14)}</span>`} ${label}</li>`;
  body.innerHTML = `
  <div class="card super-card">
    <div class="sec-head"><h3>${icon('shield', 16)} Superadministrador</h3><span class="badge super-badge">Usuario: ${esc(info.superUser)}</span></div>
    <p class="muted small">Cuenta técnica definida en Vercel. Es la única que puede crear o modificar administradores, eliminar datos definitivamente, descargar respaldos y ver la auditoría.</p>
  </div>
  <div class="settings-grid">
    <section class="card">
      <h3>Estado del sistema</h3>
      <div class="small-info">
        <div><span>Esquema de base</span><b>v${info.schemaVersion}${info.schemaVersion < info.schemaTarget ? ` <span class="warn-text">(falta v${info.schemaTarget})</span>` : ''}</b></div>
        <div><span>Tamaño de la base</span><b>${fmtBytes(info.dbSize)}</b></div>
        <div><span>Adjuntos guardados</span><b>${fmtBytes(info.attachBytes)}</b></div>
        ${Object.entries({ users: 'Usuarios', tickets: 'Tickets', ticket_messages: 'Mensajes', contacts: 'Contactos', projects: 'Proyectos', issues: 'Tareas', kb_articles: 'Artículos', audit_log: 'Eventos de auditoría' })
    .map(([k, l]) => `<div><span>${l}</span><b>${fmtNum(info.counts[k])}</b></div>`).join('')}
      </div>
    </section>
    <section class="card">
      <h3>Variables de Vercel</h3>
      <ul class="flag-list">
        ${flag(info.env.database, 'DATABASE_URL (Neon)')}
        ${flag(info.env.sessionSecret, 'SESSION_SECRET')}
        ${flag(info.env.setupKey, 'SETUP_KEY (protege la instalación)')}
        ${flag(info.env.cron, 'CRON_SECRET (tarea diaria)')}
        ${flag(info.env.resend, 'RESEND_API_KEY + MAIL_FROM (correo saliente)')}
        ${flag(info.env.inbound, 'INBOUND_SECRET (correo entrante)')}
        ${flag(info.env.microsoft, 'MS_* (ingreso con Microsoft)')}
        ${flag(Boolean(info.env.appUrl), `APP_URL ${info.env.appUrl ? `(${esc(info.env.appUrl)})` : ''}`)}
      </ul>
    </section>
    <section class="card">
      <h3>Administradores (${info.admins.length})</h3>
      <ul class="mini-list">${info.admins.map((a) => `<li class="row"><span>${esc(a.name)} <small class="muted">${esc(a.email)}</small></span><small>${a.active ? (a.last_login_at ? relTime(a.last_login_at) : 'sin ingresos') : 'inactivo'}</small></li>`).join('') || '<li class="muted">Sin administradores.</li>'}</ul>
      <a class="btn sm" href="#/settings/agents">${icon('user', 13)} Gestionar en Agentes</a>
    </section>
    <section class="card">
      <h3>${icon('download', 15)} Respaldo</h3>
      <p class="muted small">Archivo .sql comprimido, portable a cualquier Postgres (esquema + datos). Se restaura sobre una base vacía con <code>psql</code>. Además, Neon guarda historial para restaurar a un punto en el tiempo.</p>
      <div class="row gap wrap"><button class="btn primary sm" data-backup="0">Descargar respaldo</button><button class="btn sm" data-backup="1">Con adjuntos (${fmtBytes(info.attachBytes)})</button></div>
      <p class="hint">Si la base crece y supera el límite de descarga de Vercel, usá <code>npm run backup</code> desde tu PC.</p>
    </section>
    <section class="card span2">
      <h3>${icon('settings', 15)} Mantenimiento</h3>
      <div class="maint">
        <div><b>Actualizar la base</b><p class="muted small">Aplica cambios de esquema pendientes. Es seguro correrlo más de una vez.</p><button class="btn sm" data-act="migrate">Actualizar esquema</button></div>
        <div><b>Vaciar papelera</b><p class="muted small">Elimina definitivamente ${info.trash} ticket(s) en la papelera. Opcional: spam con más de <input class="input sm inline-num" type="number" min="0" value="0" name="spam_days"> días.</p><button class="btn sm danger" data-act="trash">Vaciar papelera</button></div>
        <div><b>Cerrar todas las sesiones</b><p class="muted small">Obliga a todos a volver a ingresar (por ejemplo, si se filtró una clave). Vos seguís adentro.</p><button class="btn sm danger" data-act="revoke">Cerrar sesiones</button></div>
      </div>
    </section>
  </div>
  <section class="card" data-apikeys></section>
  <section class="card">
    <div class="sec-head"><h3>${icon('eye', 15)} Auditoría</h3>
      <div class="row gap"><select class="input sm" data-filter="action"><option value="">Todas las acciones</option></select>
      <div class="searchbox">${icon('search', 14)}<input data-filter="q" placeholder="Usuario, IP, ruta…"></div></div></div>
    <div class="table-wrap"><table class="tbl compact"><thead><tr><th>Fecha</th><th>Acción</th><th>Quién</th><th>Detalle</th><th>IP</th></tr></thead><tbody data-audit></tbody></table></div>
    <div class="row end" style="margin-top:8px"><button class="btn sm" data-act="more" hidden>Ver más</button></div>
  </section>`;

  const tbody = body.querySelector('[data-audit]');
  const filt = { action: '', q: '' };
  let lastId = null;
  const detail = (e) => {
    const d = e.details || {};
    if (e.action === 'config') return `${esc(d.method || '')} ${esc(e.path)}${d.fields?.length ? ` <small class="muted">(${esc(d.fields.join(', '))})</small>` : ''}${d.password_changed ? ' <b>· clave</b>' : ''}`;
    if (e.action === 'login_failed') return `Usuario: ${esc(d.login || '')}${d.superadmin ? ' (superadmin)' : ''}${d.microsoft ? ' (Microsoft)' : ''}`;
    if (e.action === 'login') return d.superadmin ? 'Superadmin' : d.microsoft ? 'Con Microsoft' : 'Con clave';
    if (e.action === 'ticket_purged') return `#${esc(d.number)} ${esc(d.subject || '')}`;
    if (e.action === 'backup') return `${d.attachments ? 'Con adjuntos' : 'Sin adjuntos'} · ${fmtBytes(d.bytes)}`;
    if (e.action === 'empty_trash') return `${d.trash} de papelera, ${d.spam} de spam`;
    if (e.action === 'project_deleted') return `${esc(d.key)} ${esc(d.name || '')}`;
    if (e.action === 'api_key_created') return `${esc(d.name || '')} · ${esc((d.scopes || []).join(', '))}`;
    if (e.action === 'api_key_revoked') return esc(d.name || '');
    if (e.action === 'portfolio_import') return `${esc(d.file || '')} · ${d.created} nuevos, ${d.updated} actualizados`;
    if (e.action === 'project_status') return `${esc(d.key)}: ${esc(d.from)} → ${esc(d.to)}`;
    return esc(JSON.stringify(d)).slice(0, 160);
  };
  async function loadAudit(more = false) {
    const params = new URLSearchParams({ action: filt.action, q: filt.q, limit: 100 });
    if (more && lastId) params.set('before', lastId);
    const r = await api(`/super/audit?${params}`);
    const sel = body.querySelector('[data-filter=action]');
    if (sel.options.length === 1) sel.innerHTML += r.actions.map((a) => `<option value="${esc(a.action)}">${esc(ACTION_LABEL[a.action] || a.action)} (${a.n})</option>`).join('');
    const rows = r.items.map((e) => `<tr class="${e.action === 'login_failed' ? 'warn-row' : ''}"><td class="nowrap">${fmtDateTime(e.created_at)}</td><td>${esc(ACTION_LABEL[e.action] || e.action)}</td>
      <td>${esc(e.actor || '—')}</td><td class="small">${detail(e)}</td><td class="small muted">${esc(e.ip)}</td></tr>`).join('');
    tbody.innerHTML = more ? tbody.innerHTML + rows : rows || '<tr><td colspan="5" class="muted">Sin eventos.</td></tr>';
    lastId = r.items.length ? r.items[r.items.length - 1].id : lastId;
    body.querySelector('[data-act=more]').hidden = r.items.length < 100;
  }
  body.querySelector('[data-filter=action]').addEventListener('change', (e) => { filt.action = e.target.value; loadAudit(); });
  body.querySelector('[data-filter=q]').addEventListener('input', debounce((e) => { filt.q = e.target.value; loadAudit(); }, 400));

  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-backup]');
    if (b) {
      b.disabled = true;
      try {
        const res = await fetch(`/api/super/backup?attachments=${b.dataset.backup}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
        const blob = await res.blob();
        const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'respaldo.sql.gz';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Respaldo descargado');
      } catch (er) { toastError(er); }
      b.disabled = false;
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    try {
      if (a.dataset.act === 'more') return loadAudit(true);
      if (a.dataset.act === 'migrate') {
        const r = await api('/super/migrate', { method: 'POST' });
        toast(`Base actualizada a v${r.version}`);
        navigate(location.hash);
      }
      if (a.dataset.act === 'trash') {
        const spamDays = Number(body.querySelector('[name=spam_days]').value) || 0;
        if (!(await confirmDialog(`Se eliminarán definitivamente los tickets de la papelera${spamDays ? ` y el spam de más de ${spamDays} días` : ''}. No se puede deshacer.`, { danger: true, okText: 'Vaciar' }))) return;
        const r = await api('/super/empty-trash', { method: 'POST', body: { spam_days: spamDays } });
        toast(`Eliminados: ${r.trash} de papelera, ${r.spam} de spam`);
        navigate(location.hash);
      }
      if (a.dataset.act === 'revoke') {
        if (!(await confirmDialog('Todos los usuarios van a tener que volver a ingresar. ¿Continuar?', { danger: true, okText: 'Cerrar sesiones' }))) return;
        await api('/super/revoke-sessions', { method: 'POST', body: {} });
        toast('Se cerraron todas las sesiones');
        loadAudit();
      }
    } catch (er) { toastError(er); }
  });
  await Promise.all([loadAudit(), apiKeys(body.querySelector('[data-apikeys]'))]);
}

// ---------- API de exportación ----------
async function apiKeys(box) {
  const r = await api('/super/api-keys');
  box.innerHTML = `<div class="sec-head"><h3>${icon('zap', 15)} API de exportación</h3><button class="btn primary sm" data-key-new>${icon('plus', 14)} Crear clave</button></div>
    <p class="muted small">Para que Power BI, el BI propio u otro sistema lean tickets, proyectos y horas. Es de solo lectura. Cada clave tiene permisos por tema, vence y se puede revocar en cualquier momento.
      Dirección base: <code>${esc(r.base)}</code> · <a href="/api/v1/openapi.json" target="_blank" rel="noopener">documentación (OpenAPI)</a></p>
    <div class="table-wrap"><table class="tbl compact"><thead><tr><th>Nombre</th><th>Clave</th><th>Permisos</th><th>Vence</th><th>Último uso</th><th>Usos</th><th></th></tr></thead><tbody>
    ${r.keys.map((k) => `<tr class="${k.revoked_at ? 'inactive' : ''}"><td><b>${esc(k.name)}</b><small class="muted block">por ${esc(k.created_by_name || '—')} · ${fmtDate(k.created_at)}</small></td>
      <td><code>${esc(k.prefix)}…</code></td><td class="small">${k.scopes.map((s) => `<span class="chip sm">${esc(s)}</span>`).join(' ')}</td>
      <td class="small">${k.revoked_at ? `<span class="muted">Revocada ${relTime(k.revoked_at)}</span>` : k.expires_at ? (new Date(k.expires_at) < new Date() ? '<span class="warn-text">Vencida</span>' : fmtDate(k.expires_at)) : 'No vence'}</td>
      <td class="small">${k.last_used_at ? `${relTime(k.last_used_at)}<small class="muted block">${esc(k.last_ip)}</small>` : '<span class="muted">Nunca</span>'}</td><td class="small">${fmtNum(k.use_count)}</td>
      <td>${k.revoked_at ? '' : `<button class="btn sm danger ghost" data-revoke="${k.id}" data-name="${esc(k.name)}">Revocar</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Todavía no hay claves.</td></tr>'}
    </tbody></table></div>
    <details class="api-help"><summary>Cómo conectarla con Power BI</summary>
      <ol class="small">
        <li>En Power BI Desktop: <b>Obtener datos → Web → Avanzado</b>.</li>
        <li>URL: <code>${esc(r.base)}/tickets?format=csv&amp;limit=1000</code> (o <code>/projects</code>, <code>/phases</code>, <code>/issues</code>, <code>/time-entries</code>).</li>
        <li>Encabezado HTTP: <code>Authorization</code> con el valor <code>Bearer &lt;tu clave&gt;</code>.</li>
        <li>Para traer todo en tablas grandes, seguí <code>next_cursor</code> (JSON) o el encabezado <code>X-Next-Cursor</code> (CSV). Para actualizar solo lo nuevo, usá <code>updated_since=AAAA-MM-DD</code>.</li>
      </ol></details>`;
  box.querySelector('[data-key-new]').addEventListener('click', () => newKeyForm(r.scopes, () => apiKeys(box)));
  box.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Revocar la clave "${b.dataset.name}"? Lo que la use deja de funcionar en el acto.`, { danger: true, okText: 'Revocar' }))) return;
    try { await api(`/super/api-keys/${b.dataset.revoke}`, { method: 'DELETE' }); toast('Clave revocada'); apiKeys(box); } catch (er) { toastError(er); }
  }));
}

function newKeyForm(scopes, done) {
  const md = modal({
    title: 'Nueva clave de API',
    body: `<label class="field"><span>Nombre (quién la usa) *</span><input class="input" name="name" placeholder="Ej. Power BI · tablero de Presidencia"></label>
      <div class="field"><span>Permisos</span>${Object.entries(scopes).map(([k, label]) => `<label class="check"><input type="checkbox" name="scope" value="${k}" ${k !== 'time' ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>
      <label class="field"><span>Vence en</span><select class="input" name="expires_days"><option value="90">90 días</option><option value="180">6 meses</option><option value="365" selected>1 año</option><option value="730">2 años</option><option value="0">No vence</option></select></label>
      <p class="hint">La clave se muestra una sola vez. Guardala en un lugar seguro (por ejemplo, en el gestor de claves del equipo).</p>`,
    footer: '<button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Crear clave</button>',
  });
  md.el.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const k = await api('/super/api-keys', {
        method: 'POST',
        body: {
          name: md.el.querySelector('[name=name]').value.trim(), expires_days: Number(md.el.querySelector('[name=expires_days]').value),
          scopes: [...md.el.querySelectorAll('[name=scope]:checked')].map((x) => x.value),
        },
      });
      md.close();
      const show = modal({
        title: 'Clave creada',
        body: `<p>Copiala ahora: <b>no se vuelve a mostrar</b>.</p><div class="key-box"><code data-key>${esc(k.key)}</code><button class="btn sm" data-copy>${icon('copy', 13)} Copiar</button></div>
          <p class="hint">Usala en el encabezado <code>Authorization: Bearer …</code>.</p>`,
        footer: '<button class="btn primary" data-close>Listo</button>',
        dismissable: false,
      });
      show.el.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(k.key); toast('Copiada'); } catch { toast('Seleccioná la clave y copiala a mano', 'error'); }
      });
      done();
    } catch (er) { toastError(er); btn.disabled = false; }
  });
}
