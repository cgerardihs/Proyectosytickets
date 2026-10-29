// Rutas de la integración con Microsoft 365.
import { waitUntil } from '../wait-until.js';
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { requireUser, isManager } from '../auth.js';
import { audit } from '../audit.js';
import { bad, HttpError, int, isEmail } from '../http.js';
import { v, parse } from '../validate.js';
import { getSetting } from '../settings.js';
import { appUrl } from '../mail.js';
import { logActivity } from '../tickets-core.js';
import { getByNumber } from './tickets.js';
import { canSeeTicket } from '../visibility.js';
import {
  m365Config, saveM365Config, testConnection, syncDirectory, pollMailbox, teamsNotify, testSharepoint, userDevices, deviceAction, m365Log,
  REQUIRED_PERMISSIONS, clearTokenCache, teamsUrlAllowed,
} from '../m365.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function publicConfig(c) {
  const { hasSecret, connected, tenant, client, ...rest } = c;
  return { ...rest, effective: { tenant, client, hasSecret, connected, tenantFromEnv: !c.tenant_id && Boolean(process.env.MS_TENANT_ID), clientFromEnv: !c.client_id && Boolean(process.env.MS_CLIENT_ID) } };
}

export function m365Routes(r) {
  r.get('/admin/m365', async ({ req }) => {
    await requireUser(req, ['admin']);
    const [cfg, status, log] = await Promise.all([
      m365Config(),
      getSetting('m365_status', null),
      q('select * from m365_log order by created_at desc limit 40'),
    ]);
    return {
      config: publicConfig(cfg), status, log, permissions: REQUIRED_PERMISSIONS,
      redirect_uri: `${appUrl(req)}/api/auth/ms/callback`, poll_url: `${appUrl(req)}/api/m365/poll`,
      secret_expires: process.env.MS_CLIENT_SECRET_EXPIRES || null,
    };
  });

  r.put('/admin/m365', async ({ req, body }) => {
    await requireUser(req, ['admin']);
    const guid = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9.-]+\.[a-z]{2,})?$/i;
    const name = (o = {}) => v.string({ max: 120, ...o, optional: true });
    const patch = parse(v.object({
      tenant_id: v.string({ max: 100, pattern: guid, optional: true }),
      client_id: v.string({ max: 100, pattern: /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i, optional: true }),
      login: v.object({ enabled: v.bool({ optional: true }), only_microsoft: v.bool({ optional: true }), required_group: name(), auto_create_agents: v.bool({ optional: true }) }, { optional: true }),
      mailbox: v.object({
        enabled: v.bool({ optional: true }), address: v.string({ max: 254, optional: true }), send_replies: v.bool({ optional: true }), mark_read: v.bool({ optional: true }),
        processed_folder: name({ max: 80 }), interval_min: v.int({ min: 1, max: 60, optional: true }),
      }, { optional: true }),
      directory: v.object({ enabled: v.bool({ optional: true }), agent_group: name(), create_agents: v.bool({ optional: true }), deactivate_missing: v.bool({ optional: true }) }, { optional: true }),
      teams: v.object({
        enabled: v.bool({ optional: true }), webhook_url: v.string({ max: 2000, optional: true }),
        notify_urgent: v.bool({ optional: true }), notify_overdue: v.bool({ optional: true }), notify_unassigned: v.bool({ optional: true }),
      }, { optional: true }),
      intune: v.object({ enabled: v.bool({ optional: true }), allow_actions: v.bool({ optional: true }) }, { optional: true }),
      sharepoint: v.object({ enabled: v.bool({ optional: true }), site_url: v.string({ max: 500, optional: true }), library: name(), folder: name({ max: 200 }) }, { optional: true }),
    }), body);
    if (patch.teams?.webhook_url) {
      // Solo dominios de webhooks de Microsoft (evita usar la integración para llamar a cualquier servidor)
      if (!teamsUrlAllowed(patch.teams.webhook_url)) throw bad('La URL del webhook tiene que ser de Microsoft (Workflows de Teams / Power Automate)');
    }
    if (patch.sharepoint?.site_url && !/^https:\/\/[a-z0-9-]+\.sharepoint\.com\/\S*$/i.test(patch.sharepoint.site_url)) throw bad('La URL del sitio tiene que ser del tipo https://empresa.sharepoint.com/sites/Nombre');
    if (patch.mailbox?.address) {
      patch.mailbox.address = patch.mailbox.address.toLowerCase();
      if (!isEmail(patch.mailbox.address)) throw bad('El buzón tiene que ser un correo válido');
    }
    clearTokenCache();
    const cfg = await saveM365Config(patch);
    return { config: publicConfig(cfg) };
  });

  const run = async (req, fn, module) => {
    const u = await requireUser(req, ['admin']);
    try {
      return await fn(u);
    } catch (e) {
      await m365Log(module, e.message, {}, 'error');
      throw new HttpError(400, e.message);
    }
  };

  r.post('/admin/m365/test', async ({ req }) => run(req, () => testConnection(), 'conexion'));
  r.post('/admin/m365/sync-directory', async ({ req }) => run(req, () => syncDirectory(), 'directorio'));
  r.post('/admin/m365/poll', async ({ req }) => run(req, () => pollMailbox({ force: true, req }), 'buzon'));
  r.post('/admin/m365/sharepoint-test', async ({ req }) => run(req, () => testSharepoint(), 'sharepoint'));
  r.post('/admin/m365/teams-test', async ({ req }) => run(req, async (u) => {
    const out = await teamsNotify('test', { title: 'Prueba desde la Mesa de Ayuda', text: `Enviado por ${u.name}. Si ves este mensaje, los avisos a Teams funcionan.`, url: appUrl(req) });
    if (!out.sent) throw new Error(out.error || 'Activá el módulo y cargá la URL del webhook');
    return out;
  }, 'teams'));

  // Lectura del buzón desde un programador externo (cron-job.org, Power Automate "Recurrencia", etc.)
  r.post('/m365/poll', async ({ req }) => {
    // Solo por encabezado (los secretos en la URL quedan en los logs)
    const given = req.headers['x-cron-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(given, process.env.CRON_SECRET)) throw new HttpError(401, 'Clave inválida');
    return pollMailbox({ req });
  });

  // ---------- Intune ----------
  r.get('/tickets/:num/devices', async ({ req, params }) => {
    const u = await requireUser(req);
    const cfg = await m365Config();
    if (!cfg.connected || !cfg.intune.enabled) throw bad('El módulo Intune no está activo');
    const t = await getByNumber(params.num);
    const c = t.contact_id ? await one('select email from contacts where id=$1', [t.contact_id]) : null;
    if (!c) return { devices: [], allow_actions: cfg.intune.allow_actions };
    try {
      return { devices: await userDevices(c.email), allow_actions: Boolean(cfg.intune.allow_actions) };
    } catch (e) {
      if (e.status === 404) return { devices: [], allow_actions: cfg.intune.allow_actions, notice: 'El solicitante no es un usuario de Microsoft 365' };
      // Falta el permiso de Intune en la app de Azure (no es que el solicitante no tenga equipos)
      if (e.status === 403) {
        return {
          devices: [], allow_actions: false, notice_kind: 'permission',
          notice: isManager(u)
            ? 'No se pudieron consultar los equipos: a la app de Azure le falta el permiso de aplicación DeviceManagementManagedDevices.Read.All (con consentimiento de administrador). Se revisa en Configuración → Microsoft 365 → Probar conexión.'
            : 'No se pudieron consultar los equipos en Intune: falta un permiso en Microsoft 365. Avisale a un administrador.',
        };
      }
      throw new HttpError(400, e.message);
    }
  });

  r.post('/devices/:id/action', async ({ req, params, body: raw }) => {
    // Solo supervisores y administradores, y solo sobre un equipo del solicitante del ticket
    const u = await requireUser(req, ['admin', 'supervisor']);
    const cfg = await m365Config();
    if (!cfg.connected || !cfg.intune.enabled || !cfg.intune.allow_actions) throw bad('Las acciones remotas están desactivadas');
    const body = parse(v.object({ action: v.enum(['sync', 'reboot']), ticket: v.id(), device_name: v.string({ max: 120, optional: true }) }), raw);
    if (!/^[0-9a-f-]{36}$/i.test(String(params.id))) throw bad('Identificador de equipo inválido');
    const t = await getByNumber(body.ticket);
    if (!(await canSeeTicket(u, t))) throw bad('No existe el ticket');
    const c = t.contact_id ? await one('select email from contacts where id=$1', [t.contact_id]) : null;
    const owned = c ? await userDevices(c.email).catch(() => []) : [];
    if (!owned.some((d) => d.id === params.id)) throw bad('Ese equipo no pertenece al solicitante del ticket');
    try {
      await deviceAction(params.id, body.action);
    } catch (e) {
      if (e.status === 403) throw new HttpError(400, 'No se pudo enviar la acción: a la app de Azure le falta el permiso DeviceManagementManagedDevices.PrivilegedOperations.All (con consentimiento de administrador).');
      throw new HttpError(400, e.message);
    }
    await audit(req, u, 'intune_action', { device: params.id, action: body.action, ticket: body.ticket });
    await logActivity(t.id, u.id, 'intune_action', { action: body.action, device: owned.find((d) => d.id === params.id)?.name || params.id });
    return { ok: true };
  });
}

/** Tareas diarias de Microsoft 365 (se llaman desde /cron/daily). */
export async function m365Daily(overdue, req) {
  const out = {};
  const cfg = await m365Config().catch(() => null);
  if (!cfg) return out;
  await q(`delete from m365_log where created_at < now() - interval '30 days'`).catch(() => {});
  if (cfg.connected && cfg.directory.enabled) {
    try { out.directory = await syncDirectory(); } catch (e) { out.directory = { error: e.message }; await m365Log('directorio', e.message, {}, 'error'); }
  }
  if (cfg.connected && cfg.mailbox.enabled) {
    try { out.mailbox = await pollMailbox({ force: true, req }); } catch (e) { out.mailbox = { error: e.message }; }
  }
  if (overdue?.length) {
    out.teams = await teamsNotify('overdue', {
      title: `${overdue.length} ticket(s) con SLA vencido`,
      text: overdue.slice(0, 10).map((t) => `#${t.number} ${t.subject}`).join('\n'),
      url: `${appUrl(req)}/#/tickets?view=overdue`,
    });
  }
  return out;
}

/** Lectura "perezosa" del buzón: cuando los agentes usan la app, a lo sumo una vez por intervalo. */
export async function lazyPoll(req) {
  try {
    const cfg = await m365Config();
    if (!cfg.connected || !cfg.mailbox.enabled) return null;
    // Se espera hasta 6 s para poder avisarle a la pantalla qué entró. Si tarda más, la lectura sigue después de
    // responder (waitUntil: sin eso, Vercel congela la función y el correo queda a medio procesar hasta otra petición).
    const run = pollMailbox({ req });
    waitUntil(run);
    let timer;
    const out = await Promise.race([run, new Promise((res) => { timer = setTimeout(() => res(null), 6000); })]);
    clearTimeout(timer);
    return inboxSummary(out);
  } catch { return null; /* nunca rompe la respuesta */ }
}

/** Qué entró por correo en esta lectura: tickets nuevos y mensajes agregados (para refrescar la pantalla). */
export function inboxSummary(out) {
  const results = Array.isArray(out?.results) ? out.results : [];
  const created = results.filter((x) => x?.created).map((x) => x.ticket);
  const updated = results.filter((x) => x?.appended).map((x) => x.ticket);
  return created.length || updated.length ? { created, updated } : null;
}

