// Integración con Microsoft 365 vía Microsoft Graph (permisos de aplicación).
// El secreto vive solo en Vercel (MS_CLIENT_SECRET); tenant y client se pueden cargar desde Configuración.
import { q, one, tx, inTransaction, onCommit } from './db.js';
import { getSetting, setSetting } from './settings.js';
import { fetchx } from './fetchx.js';

export const M365_DEFAULTS = {
  tenant_id: '',
  client_id: '',
  login: { enabled: true, only_microsoft: false, required_group: '', auto_create_agents: false },
  mailbox: { enabled: false, address: '', send_replies: true, mark_read: true, processed_folder: 'Procesados', interval_min: 1 },
  directory: { enabled: false, agent_group: '', create_agents: false, deactivate_missing: true },
  teams: { enabled: false, webhook_url: '', notify_urgent: true, notify_overdue: true, notify_unassigned: false },
  intune: { enabled: false, allow_actions: false },
  sharepoint: { enabled: false, site_url: '', library: 'Documentos', folder: 'Mesa de Ayuda' },
};

/** Permisos de aplicación que necesita cada módulo. */
export const REQUIRED_PERMISSIONS = [
  { perm: 'GroupMember.Read.All', module: 'login', use: 'Validar que el agente esté en el grupo requerido' },
  { perm: 'Mail.ReadWrite', module: 'mailbox', use: 'Leer el buzón de soporte y mover los correos procesados' },
  { perm: 'Mail.Send', module: 'mailbox', use: 'Enviar las respuestas desde el buzón de soporte' },
  { perm: 'User.Read.All', module: 'directory', use: 'Sincronizar empleados como contactos' },
  { perm: 'GroupMember.Read.All', module: 'directory', use: 'Leer el grupo de agentes' },
  { perm: 'DeviceManagementManagedDevices.Read.All', module: 'intune', use: 'Ver los equipos del solicitante en el ticket' },
  { perm: 'DeviceManagementManagedDevices.PrivilegedOperations.All', module: 'intune', use: 'Sincronizar o reiniciar un equipo (opcional)', optional: true },
  { perm: 'Sites.ReadWrite.All', module: 'sharepoint', use: 'Guardar los adjuntos en la biblioteca', alt: ['Sites.Selected'] },
];

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
  }
  return out;
}

export async function m365Config() {
  const s = merge(M365_DEFAULTS, (await getSetting('m365')) || {});
  s.tenant = String(s.tenant_id || process.env.MS_TENANT_ID || '').trim();
  s.client = String(s.client_id || process.env.MS_CLIENT_ID || '').trim();
  s.hasSecret = Boolean(process.env.MS_CLIENT_SECRET);
  s.connected = Boolean(s.tenant && s.client && s.hasSecret);
  return s;
}

export async function saveM365Config(patch) {
  const cur = (await getSetting('m365')) || {};
  const next = merge(merge(M365_DEFAULTS, cur), patch || {});
  delete next.tenant; delete next.client; delete next.hasSecret; delete next.connected;
  await setSetting('m365', next);
  return m365Config();
}

export async function m365Log(module, message, details = {}, level = 'info') {
  try {
    await q('insert into m365_log(module,level,message,details) values ($1,$2,$3,$4::jsonb)', [module, level, String(message).slice(0, 500), JSON.stringify(details || {})]);
  } catch { /* el registro nunca rompe el flujo */ }
}

// ---------- Token y llamadas a Graph ----------
let tokenCache = null;

export function clearTokenCache() {
  tokenCache = null;
}

export async function appToken(cfg = null) {
  const c = cfg || (await m365Config());
  if (!c.connected) throw new Error('Microsoft 365 no está configurado: falta Tenant ID, Client ID o MS_CLIENT_SECRET en Vercel');
  const key = `${c.tenant}|${c.client}`;
  if (tokenCache && tokenCache.key === key && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const r = await fetchx(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.client, client_secret: process.env.MS_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  }, { service: 'Microsoft Entra ID', timeoutMs: 8000, retries: 2, idempotent: true });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error_description?.split('\r\n')[0] || data.error || `Microsoft respondió ${r.status}`);
  tokenCache = { key, token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return data.access_token;
}

export function tokenRoles(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Array.isArray(claims.roles) ? claims.roles : [];
  } catch {
    return [];
  }
}

export class GraphError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Llama a Microsoft Graph. path empieza con "/" (relativo a v1.0) o es una URL completa (@odata.nextLink). */
/**
 * idempotent: si se puede reintentar ante errores transitorios. Por defecto GET/PATCH/PUT sí; POST no
 * (ej. enviar un correo o reiniciar un equipo no se repite; Graph solo se reintenta si respondió 429/503).
 */
/**
 * Mensaje legible de un error de Graph. Intune devuelve en error.message otro JSON con "Message", un "Operation ID",
 * la URL, etc.: se queda solo con el texto (antes se mostraba todo el bloque en pantalla).
 */
export function graphMessage(data) {
  let m = data?.error?.message;
  if (typeof m !== 'string' || !m.trim()) return '';
  const t = m.trim();
  if (t.startsWith('{')) { try { const inner = JSON.parse(t); m = inner.Message || inner.message || inner.error?.message || t; } catch { /* queda el original */ } }
  return String(m).replace(/\s+-\s+Operation ID[\s\S]*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export async function graph(path, { method = 'GET', body, headers = {}, raw = false, binary = null, contentType, idempotent, timeoutMs = 15000 } = {}) {
  const token = await appToken();
  const url = /^https:\/\//.test(path) ? path : `https://graph.microsoft.com/v1.0${path}`;
  const opts = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (binary) {
    opts.body = binary;
    opts.headers['Content-Type'] = contentType || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const r = await fetchx(url, opts, { service: 'Microsoft Graph', timeoutMs, retries: 2, idempotent: idempotent ?? ['GET', 'PATCH', 'PUT', 'DELETE'].includes(method) });
  if (raw) return r;
  if (r.status === 202 || r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = graphMessage(data) || `Graph respondió ${r.status}`;
    throw new GraphError(r.status, r.status === 403 ? `Sin permiso en Microsoft 365: ${msg}` : msg, data?.error?.code);
  }
  return data;
}

async function graphAll(path, max = 20) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < max; i += 1) {
    const page = await graph(next);
    out.push(...(page?.value || []));
    next = page?.['@odata.nextLink'] || null;
  }
  return out;
}

// ---------- Prueba de conexión ----------
export async function testConnection() {
  const cfg = await m365Config();
  clearTokenCache();
  const token = await appToken(cfg);
  const roles = tokenRoles(token);
  let organization = null;
  let domain = '';
  try {
    const org = await graph('/organization?$select=displayName,verifiedDomains');
    const o = org?.value?.[0];
    if (o) {
      organization = o.displayName;
      domain = (o.verifiedDomains || []).find((d) => d.isInitial)?.name || (o.verifiedDomains || [])[0]?.name || '';
    }
  } catch { /* Organization.Read.All es opcional */ }
  const permissions = REQUIRED_PERMISSIONS.map((p) => ({
    ...p,
    granted: roles.includes(p.perm) || (p.alt || []).some((a) => roles.includes(a)),
    needed: Boolean(cfg[p.module]?.enabled) && !(p.module === 'login' && !cfg.login.required_group),
  }));
  const status = { ok: true, tested_at: new Date().toISOString(), organization, domain, roles, permissions };
  await setSetting('m365_status', status);
  await m365Log('conexion', `Conexión correcta${organization ? ` con ${organization}` : ''}`, { roles: roles.length });
  return status;
}

// ---------- Inicio de sesión: pertenencia a grupo ----------
async function findGroup(nameOrId) {
  const v = String(nameOrId || '').trim();
  if (!v) return null;
  if (/^[0-9a-f-]{36}$/i.test(v)) return { id: v, displayName: v };
  const r = await graph(`/groups?$filter=${encodeURIComponent(`displayName eq '${v.replace(/'/g, "''")}'`)}&$select=id,displayName`);
  return r?.value?.[0] || null;
}

export async function userInGroup(email, group) {
  const g = await findGroup(group);
  if (!g) throw new Error(`No existe el grupo "${group}" en Entra ID`);
  const r = await graph(`/users/${encodeURIComponent(email)}/checkMemberGroups`, { method: 'POST', body: { groupIds: [g.id] }, idempotent: true });
  return (r?.value || []).includes(g.id);
}

// ---------- Buzón de soporte ----------
async function processedFolderId(address, name) {
  if (!name) return null;
  const enc = encodeURIComponent(address);
  const filter = encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`);
  const found = await graph(`/users/${enc}/mailFolders?$filter=${filter}&$select=id,displayName`);
  if (found?.value?.[0]) return found.value[0].id;
  const created = await graph(`/users/${enc}/mailFolders`, { method: 'POST', body: { displayName: name } });
  return created?.id || null;
}

export const QUARANTINE_FOLDER = 'Mesa de ayuda - No procesados';

/** Cuenta los intentos fallidos de un correo; true al tercero (y lo olvida). Guarda como mucho 200 ids. */
export async function failedTooOften(messageId, max = 3) {
  return tx(async () => {
    await q(`insert into app_settings(key,value) values ('m365_mail_failures','{}'::jsonb) on conflict (key) do nothing`);
    const row = await one(`select value from app_settings where key='m365_mail_failures' for update`);
    const map = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
    const n = (Number(map[messageId]) || 0) + 1;
    if (n >= max) delete map[messageId];
    else map[messageId] = n;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete map[k];
    await q(`update app_settings set value=$1::jsonb where key='m365_mail_failures'`, [JSON.stringify(map)]);
    return n >= max;
  });
}

/** Reclama el turno de lectura del buzón (evita lecturas simultáneas). */
async function claimPoll(minutes) {
  await q(`insert into app_settings(key,value,updated_at) values ('m365_mail_poll','{}'::jsonb, now() - interval '1 day') on conflict (key) do nothing`);
  const row = await one(
    `update app_settings set updated_at=now() where key='m365_mail_poll' and updated_at < now() - ($1 || ' seconds')::interval returning key`,
    [String(Math.max(20, Math.round(minutes * 60) - 5))],
  );
  return Boolean(row);
}

export async function pollMailbox({ force = false, req = null } = {}) {
  const cfg = await m365Config();
  if (!cfg.connected || !cfg.mailbox.enabled || !cfg.mailbox.address) return { skipped: 'disabled' };
  if (!force && !(await claimPoll(Number(cfg.mailbox.interval_min) || 1))) return { skipped: 'recent' };
  const address = cfg.mailbox.address.trim().toLowerCase();
  const enc = encodeURIComponent(address);
  const { processInbound } = await import('./routes/portal.js');
  const select = 'id,subject,from,ccRecipients,body,internetMessageId,hasAttachments,isRead,internetMessageHeaders';
  const list = await graph(`/users/${enc}/mailFolders/inbox/messages?$filter=isRead eq false&$top=20&$orderby=receivedDateTime asc&$select=${select}`);
  const msgs = list?.value || [];
  let folder = null;
  const results = [];
  for (const m of msgs) {
    // 1) Adjuntos: si Graph falla un momento (429/5xx), se reintenta en la próxima vuelta sin contar como correo roto
    let attachments = [];
    try {
      if (m.hasAttachments) {
        const a = await graph(`/users/${enc}/messages/${m.id}/attachments?$select=name,contentType,size,isInline,contentBytes`);
        attachments = (a?.value || []).filter((x) => x['@odata.type'] === '#microsoft.graph.fileAttachment' && !x.isInline && x.contentBytes)
          .map((x) => ({ name: x.name, contentType: x.contentType, contentBytes: x.contentBytes }));
      }
    } catch (e) {
      await m365Log('buzon', `No se pudieron leer los adjuntos de "${m.subject || ''}" (se reintenta): ${e.message}`, {}, 'error');
      results.push({ error: e.message, retry: true });
      continue;
    }
    // 2) Procesar: solo este paso cuenta como "correo que no se puede procesar" (al tercer intento va a cuarentena)
    let out;
    try {
      const header = (n) => (m.internetMessageHeaders || []).find((h) => h.name.toLowerCase() === n)?.value || '';
      const html = m.body?.contentType === 'html' ? m.body.content : '';
      const text = m.body?.contentType !== 'html' ? m.body?.content : '';
      out = await processInbound({
        from: m.from?.emailAddress, subject: m.subject, html, text,
        cc: (m.ccRecipients || []).map((c) => c.emailAddress?.address).filter(Boolean),
        message_id: m.internetMessageId, in_reply_to: header('in-reply-to'), attachments,
      }, req, { ownAddresses: [address] });
    } catch (e) {
      await m365Log('buzon', `No se pudo procesar "${m.subject || ''}": ${e.message}`, {}, 'error');
      results.push({ error: e.message });
      // Un correo que falla siempre no puede trabar la lectura (se leen los 20 no leídos más viejos):
      // al tercer intento se marca como leído, con bandera, y se mueve a una carpeta de cuarentena para revisarlo a mano.
      try {
        if (await failedTooOften(m.id)) {
          await graph(`/users/${enc}/messages/${m.id}`, { method: 'PATCH', body: { isRead: true, flag: { flagStatus: 'flagged' } } });
          const qf = await processedFolderId(address, QUARANTINE_FOLDER).catch(() => null);
          if (qf) await graph(`/users/${enc}/messages/${m.id}/move`, { method: 'POST', body: { destinationId: qf } });
          await m365Log('buzon', `Correo "${m.subject || ''}" movido a "${QUARANTINE_FOLDER}" después de 3 intentos fallidos`, { from: m.from?.emailAddress?.address }, 'error');
        }
      } catch (e2) {
        await m365Log('buzon', `No se pudo poner en cuarentena "${m.subject || ''}": ${e2.message}`, {}, 'error');
      }
      continue;
    }
    // 3) Ya procesado: marcarlo y moverlo. Si esto falla, el ticket existe igual (el reintento lo reconoce por Message-ID)
    try {
      if (cfg.mailbox.mark_read !== false) await graph(`/users/${enc}/messages/${m.id}`, { method: 'PATCH', body: { isRead: true } });
      if (cfg.mailbox.processed_folder) {
        if (folder === null) folder = (await processedFolderId(address, cfg.mailbox.processed_folder)) || '';
        if (folder) await graph(`/users/${enc}/messages/${m.id}/move`, { method: 'POST', body: { destinationId: folder } });
      }
    } catch (e) {
      await m365Log('buzon', `El correo "${m.subject || ''}" se procesó pero no se pudo marcar como leído o mover: ${e.message}`, {}, 'error');
    }
    results.push(out);
    if (out.created || out.appended) await m365Log('buzon', out.created ? `Correo nuevo → ticket #${out.ticket}` : `Respuesta agregada al ticket #${out.ticket}`, { from: m.from?.emailAddress?.address });
  }
  return { read: msgs.length, results };
}

/** Envía un correo desde el buzón de soporte. Devuelve { sent, error } como sendMail. */
export async function sendViaGraph({ to, cc = [], subject, html, replyTo, attachments = [] }) {
  const cfg = await m365Config();
  const address = cfg.mailbox.address.trim();
  const rcpt = (list) => [].concat(list || []).filter(Boolean).map((a) => ({ emailAddress: { address: a } }));
  try {
    await graph(`/users/${encodeURIComponent(address)}/sendMail`, {
      method: 'POST',
      body: {
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: rcpt(to),
          ccRecipients: rcpt(cc),
          replyTo: replyTo ? rcpt(replyTo) : undefined,
          attachments: attachments.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.name || a.filename || 'adjunto',
            contentType: a.type || a.contentType || 'application/octet-stream',
            contentBytes: String(a.data || a.content || '').replace(/^data:[^;]+;base64,/, ''),
          })),
        },
        saveToSentItems: true,
      },
    });
    return { sent: true, via: 'm365' };
  } catch (e) {
    await m365Log('buzon', `No se pudo enviar "${subject}": ${e.message}`, {}, 'error');
    return { sent: false, error: e.message };
  }
}

export async function graphSendEnabled() {
  try {
    const cfg = await m365Config();
    return Boolean(cfg.connected && cfg.mailbox.enabled && cfg.mailbox.send_replies && cfg.mailbox.address);
  } catch {
    return false;
  }
}

// ---------- Directorio ----------
export async function syncDirectory() {
  const cfg = await m365Config();
  if (!cfg.connected) throw new Error('Microsoft 365 no está configurado');
  const users = await graphAll('/users?$select=id,displayName,mail,userPrincipalName,department,jobTitle,mobilePhone,businessPhones,accountEnabled&$expand=manager($select=displayName)&$top=999');
  // Sin N+1: se arman listas y se actualiza/inserta todo en tres sentencias dentro de una transacción.
  const rows = [];
  const seenEmail = new Set();
  for (const u of users) {
    const email = String(u.mail || '').trim().toLowerCase().slice(0, 254);
    if (!email || u.accountEnabled === false || seenEmail.has(email)) continue;
    seenEmail.add(email);
    rows.push({
      id: String(u.id), email, name: String(u.displayName || email).slice(0, 120), area: String(u.department || '').slice(0, 120), title: String(u.jobTitle || '').slice(0, 120),
      phone: String(u.mobilePhone || (u.businessPhones || [])[0] || '').slice(0, 40), manager: String(u.manager?.displayName || '').slice(0, 120),
    });
  }
  const seen = rows.map((r) => r.id);
  const cols = ['id', 'email', 'name', 'area', 'title', 'phone', 'manager'].map((k) => rows.map((r) => r[k]));
  const input = 'select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) as x(ext, email, name, area, title, phone, manager)';
  const { updated, created, deactivated } = await tx(async () => {
    const upd = rows.length ? await q(`update contacts c set name = i.name,
        email = case when exists (select 1 from contacts c2 where c2.email = i.email and c2.id <> c.id) then c.email else i.email end,
        area = coalesce(nullif(i.area,''), c.area), job_title = i.title, phone = coalesce(nullif(i.phone,''), c.phone), manager = i.manager, external_id = i.ext, active = true
      from (${input}) i where c.external_id = i.ext or (c.external_id is null and c.email = i.email) returning c.id`, cols) : [];
    const ins = rows.length ? await q(`insert into contacts(name, email, phone, area, job_title, manager, external_id, company_id)
        select i.name, i.email, i.phone, i.area, i.title, i.manager, i.ext, (select id from companies co where lower(co.domain) = split_part(i.email,'@',2) limit 1)
        from (${input}) i where not exists (select 1 from contacts c where c.email = i.email or c.external_id = i.ext)
        on conflict (email) do nothing returning id`, cols) : [];
    const off = cfg.directory.deactivate_missing && seen.length
      ? await q('update contacts set active=false where external_id is not null and active and not (external_id = any($1::text[])) returning id', [seen])
      : [];
    return { updated: upd.length, created: ins.length, deactivated: off.length };
  });
  let agents = 0;
  if (cfg.directory.agent_group) {
    const g = await findGroup(cfg.directory.agent_group);
    if (!g) throw new Error(`No existe el grupo "${cfg.directory.agent_group}" en Entra ID`);
    const members = await graphAll(`/groups/${g.id}/members?$select=id,displayName,mail&$top=999`, 5);
    const list = members.filter((m) => m.mail).map((m) => ({ email: String(m.mail).toLowerCase().slice(0, 254), name: String(m.displayName || m.mail).slice(0, 120), id: String(m.id) }));
    if (list.length) {
      const cols2 = [list.map((m) => m.email), list.map((m) => m.name), list.map((m) => m.id)];
      await tx(async () => {
        await q(`update users u set external_id = i.id from unnest($1::text[], $2::text[], $3::text[]) as i(email, name, id) where u.email = i.email`, cols2);
        if (cfg.directory.create_agents) {
          const r = await q(`insert into users(name, email, role, active, external_id) select i.name, i.email, 'agent', true, i.id
            from unnest($1::text[], $2::text[], $3::text[]) as i(email, name, id) on conflict (email) do nothing returning id`, cols2);
          agents = r.length;
        }
      });
    }
  }
  const summary = { contacts: seen.length, created, updated, deactivated, agents, at: new Date().toISOString() };
  const cur = (await getSetting('m365')) || {};
  await setSetting('m365', { ...cur, directory: { ...(cur.directory || {}), last_sync: summary } });
  await m365Log('directorio', `Sincronización: ${seen.length} empleados (${created} nuevos, ${deactivated} desactivados${agents ? `, ${agents} agentes nuevos` : ''})`, summary);
  return summary;
}

// ---------- Teams (webhook de Workflows) ----------
/** Solo dominios de webhooks de Microsoft (Workflows de Teams / Power Automate / Logic Apps). */
export function teamsUrlAllowed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && ['.webhook.office.com', '.logic.azure.com', '.powerplatform.com', '.api.powerplatform.com', '.environment.api.powerplatform.com'].some((d) => host.endsWith(d));
  } catch {
    return false;
  }
}

export async function teamsNotify(event, payload) {
  if (inTransaction()) {
    await onCommit(() => teamsNotify(event, payload));
    return { sent: true, queued: true };
  }
  const { title, text, url, facts = [] } = payload;
  const cfg = await m365Config();
  if (!cfg.teams.enabled || !cfg.teams.webhook_url) return { sent: false };
  if (!teamsUrlAllowed(cfg.teams.webhook_url)) return { sent: false, error: 'La URL del webhook de Teams no es de Microsoft' };
  const allowed = { urgent: cfg.teams.notify_urgent, overdue: cfg.teams.notify_overdue, unassigned: cfg.teams.notify_unassigned, test: true };
  if (!allowed[event]) return { sent: false };
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
          ...(text ? [{ type: 'TextBlock', text, wrap: true }] : []),
          ...(facts.length ? [{ type: 'FactSet', facts: facts.map(([t, v]) => ({ title: t, value: String(v ?? '') })) }] : []),
        ],
        actions: url ? [{ type: 'Action.OpenUrl', title: 'Abrir en la mesa de ayuda', url }] : [],
      },
    }],
  };
  try {
    const r = await fetchx(cfg.teams.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) }, { service: 'Teams', timeoutMs: 8000, retries: 1, idempotent: false });
    if (!r.ok) throw new Error(`Teams respondió ${r.status}`);
    await m365Log('teams', `Aviso enviado: ${title}`);
    return { sent: true };
  } catch (e) {
    await m365Log('teams', `No se pudo avisar en Teams: ${e.message}`, {}, 'error');
    return { sent: false, error: e.message };
  }
}

// ---------- Intune ----------
export async function userDevices(email) {
  const sel = 'id,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,model,manufacturer,serialNumber,isEncrypted,managedDeviceOwnerType';
  const r = await graph(`/users/${encodeURIComponent(email)}/managedDevices?$select=${sel}`);
  return (r?.value || []).map((d) => ({
    id: d.id, name: d.deviceName, os: [d.operatingSystem, d.osVersion].filter(Boolean).join(' '), compliance: d.complianceState,
    last_sync: d.lastSyncDateTime, model: [d.manufacturer, d.model].filter(Boolean).join(' '), serial: d.serialNumber, encrypted: d.isEncrypted,
  }));
}

export async function deviceAction(id, action) {
  const map = { sync: 'syncDevice', reboot: 'rebootNow' };
  if (!map[action]) throw new Error('Acción inválida');
  await graph(`/deviceManagement/managedDevices/${encodeURIComponent(id)}/${map[action]}`, { method: 'POST' });
  await m365Log('intune', `Acción ${action === 'sync' ? 'sincronizar' : 'reiniciar'} enviada al equipo ${id}`);
  return { ok: true };
}

// ---------- SharePoint ----------
async function sharepointTarget(cfg) {
  const sp = cfg.sharepoint;
  if (sp.site_id && sp.drive_id && sp.resolved_for === `${sp.site_url}|${sp.library}`) return { siteId: sp.site_id, driveId: sp.drive_id };
  const u = new URL(sp.site_url);
  const site = await graph(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, '') || '/'}`);
  const drives = await graph(`/sites/${site.id}/drives?$select=id,name`);
  const drive = (drives?.value || []).find((d) => d.name.toLowerCase() === String(sp.library || '').toLowerCase()) || drives?.value?.[0];
  if (!drive) throw new Error('No se encontró la biblioteca de documentos');
  const cur = (await getSetting('m365')) || {};
  await setSetting('m365', { ...cur, sharepoint: { ...(cur.sharepoint || {}), site_id: site.id, drive_id: drive.id, resolved_for: `${sp.site_url}|${sp.library}` } });
  return { siteId: site.id, driveId: drive.id };
}

export async function sharepointEnabled() {
  try {
    const cfg = await m365Config();
    return Boolean(cfg.connected && cfg.sharepoint.enabled && cfg.sharepoint.site_url);
  } catch {
    return false;
  }
}

const safeName = (s) => String(s || 'archivo').replace(/[\\/:*?"<>|#%]+/g, '_').replace(/^\.+/, '').slice(0, 150) || 'archivo';

export async function uploadToSharepoint(subfolder, filename, buffer, contentType) {
  const cfg = await m365Config();
  const { driveId } = await sharepointTarget(cfg);
  const base = String(cfg.sharepoint.folder || '').split('/').map((p) => safeName(p)).filter(Boolean).join('/');
  const path = [base, safeName(subfolder), `${Date.now().toString(36)}-${safeName(filename)}`].filter(Boolean).map(encodeURIComponent).join('/');
  const item = await graph(`/drives/${driveId}/root:/${path}:/content`, { method: 'PUT', binary: buffer, contentType, timeoutMs: 20000 });
  return { drive_id: driveId, item_id: item.id, web_url: item.webUrl };
}

export async function downloadFromSharepoint(ref) {
  const r = await graph(`/drives/${ref.drive_id}/items/${ref.item_id}/content`, { raw: true });
  if (!r.ok) throw new Error(`SharePoint respondió ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function testSharepoint() {
  const cfg = await m365Config();
  const t = await sharepointTarget({ ...cfg, sharepoint: { ...cfg.sharepoint, site_id: null } });
  await m365Log('sharepoint', 'Biblioteca encontrada', t);
  return t;
}
