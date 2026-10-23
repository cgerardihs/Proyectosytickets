import crypto from 'node:crypto';
import { q, one, tx } from '../db.js';
import { SCHEMA_VERSION } from '../migrations.js';
import { migrate } from '../migrate.js';
import { seedConfig, seedDemo, seedAiRules } from '../seed.js';
import { getSetting, setSetting, clearSettingsCache } from '../settings.js';
import { requireUser, currentUser, hashPassword, createSession, isSuper, superadminEnabled, revokeUserSessions } from '../auth.js';
import { canPortfolio, norm } from '../portfolio.js';
import { canSeeTicket } from '../visibility.js';
import { audit } from '../audit.js';
import { bad, notFound, forbidden, HttpError, int } from '../http.js';
import { v, parse, checkPasswordPolicy, idParam } from '../validate.js';
import { msLogin } from './auth.js';
import { limitIp } from '../ratelimit.js';

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
import { crud } from '../crud.js';
import { mailEnabled, appUrl } from '../mail.js';
import { PRIORITIES } from '../tickets-core.js';
import { m365Config } from '../m365.js';

// Si no hay superadmin configurado, los administradores siguen gestionando administradores (sin bloqueo).
const canManageAdmins = (me) => isSuper(me) || !superadminEnabled();

/** Qué funciones de IA y Microsoft 365 están activas (para mostrar u ocultar botones). */
async function integrationFlags() {
  const out = { ai: { copilot: false, available: false }, m365: { intune: false, intune_actions: false, mailbox: false } };
  try {
    const { aiConfig, aiAvailable } = await import('../ai.js');
    const c = await aiConfig();
    out.ai = { copilot: Boolean(c.features.copilot), available: await aiAvailable(c), auto_reply: Boolean(c.features.auto_reply) };
  } catch { /* */ }
  try {
    const m = await m365Config();
    out.m365 = { connected: m.connected, intune: m.connected && m.intune.enabled, intune_actions: m.connected && m.intune.enabled && m.intune.allow_actions, mailbox: m.connected && m.mailbox.enabled ? m.mailbox.address : false };
  } catch { /* */ }
  return out;
}

const msEnabled = async () => Boolean(await msLogin());

/** Instalado = hay una marca permanente o hay algún usuario. Ante cualquier error que no sea "tabla inexistente", falla cerrado. */
async function installed() {
  try {
    const mark = await one(`select 1 as x from app_settings where key='installed_at'`);
    const r = await one('select count(*)::int as n from users');
    const v = await getSetting('schema_version', 0);
    return { installed: Boolean(mark) || r.n > 0, schemaVersion: v };
  } catch (e) {
    if (e.code === '42P01') return { installed: false, schemaVersion: 0 };
    throw e;
  }
}

export function coreRoutes(r) {
  // ---------- Instalación ----------
  r.get('/setup/status', async () => {
    const s = await installed();
    return { ...s, needsSetup: !s.installed, needsKey: Boolean(process.env.SETUP_KEY), schemaTarget: SCHEMA_VERSION, dbConfigured: Boolean(process.env.DATABASE_URL || process.env.PGLITE) };
  });

  r.post('/setup', async ({ body, req }) => {
    await limitIp(req, 'setup', 10, 3600, 'Demasiados intentos de instalación. Esperá un rato.');
    const s = await installed();
    if (s.installed) throw forbidden('El sistema ya está instalado');
    const b = parse(v.object({
      setup_key: v.string({ max: 200, trim: false, optional: true }),
      preset: v.enum(['hanseatica', 'generic'], { default: 'hanseatica' }),
      domain: v.string({ max: 120, optional: true }),
      start_number: v.int({ min: 1, max: 99999999, default: 1 }),
      demo: v.bool({ default: false }),
      admin: v.object({ name: v.string({ min: 1, max: 120 }), email: v.email(), password: v.string({ min: 1, max: 256, trim: false }) }),
    }), body);
    if (process.env.VERCEL && !process.env.SETUP_KEY) throw forbidden('Para instalar en Vercel definí la variable SETUP_KEY y volvé a desplegar.');
    if (process.env.SETUP_KEY && !safeEqual(b.setup_key || '', process.env.SETUP_KEY)) throw forbidden('La clave de instalación no es correcta');
    checkPasswordPolicy(b.admin.password, b.admin);
    await migrate({ seed: false });
    const hash = await hashPassword(b.admin.password);
    const admin = await tx(async () => {
      await seedConfig(b.preset, b.domain || '');
      await seedAiRules();
      if (b.start_number > 1) {
        const maxT = await one('select coalesce(max(number),0)::int as m from tickets');
        await q(`select setval('ticket_number_seq', $1, false)`, [Math.max(b.start_number, maxT.m + 1)]);
      }
      // Marca permanente (y bloqueo): una segunda instalación concurrente falla acá.
      const mark = await one(`insert into app_settings(key,value) values ('installed_at', to_jsonb(now()::text)) on conflict (key) do nothing returning key`);
      if (!mark) throw forbidden('El sistema ya está instalado');
      // Si el preset ya cargó a esa persona como agente EN ESTA MISMA transacción (created_at = now()), se la promueve;
      // nunca se toca un usuario existente de antes.
      const row = await one(`insert into users(name,email,password_hash,role,color) values ($1,$2,$3,'admin','#C41230')
        on conflict (email) do update set name=excluded.name, password_hash=excluded.password_hash, role='admin', active=true
        where users.created_at = now() and users.password_hash is null returning id`, [b.admin.name, b.admin.email, hash]);
      if (!row) throw forbidden('Ese correo ya existe');
      if (b.demo) await seedDemo(row.id);
      return row;
    });
    clearSettingsCache();
    await audit(req, { id: admin.id, name: b.admin.name, email: b.admin.email }, 'setup', { preset: b.preset });
    return { ok: true, cookie: await createSession(req, admin.id, 'password') };
  }, { setCookie: true });

  r.post('/admin/migrate', async ({ req }) => {
    await requireUser(req, ['admin']);
    await migrate();
    return { ok: true, version: SCHEMA_VERSION };
  });

  // ---------- Perfil ----------
  r.patch('/me', async ({ req, body }) => {
    const u = await requireUser(req);
    const b = parse(v.object({
      name: v.string({ min: 1, max: 120, optional: true }),
      signature_html: v.html({ max: 20000, optional: true }),
      color: v.string({ max: 20, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
    }), body);
    return one(
      `update users set name=$2, signature_html=coalesce($3,signature_html), color=coalesce($4,color) where id=$1 returning id,name,email,role,color,signature_html`,
      [u.id, b.name ?? u.name, b.signature_html ?? null, b.color ?? null],
    );
  });

  // ---------- Metadatos para la app ----------
  r.get('/meta', async ({ req }) => {
    const u = await requireUser(req);
    const [users, categories, tech, types, statuses, slas, projects, views, brand, helpdesk, subtech, projectTypes, pOptions, fieldLabels] = await Promise.all([
      q('select id,name,email,role,active,color from users order by name'),
      q('select * from categories order by sort, name'),
      q('select * from tech_categories order by sort, name'),
      q('select * from ticket_types order by sort, name'),
      q('select * from statuses order by sort, id'),
      q('select id,name,is_default,no_sla,business_hours,targets,active from sla_policies order by sort, id'),
      q(`select p.id,p.key,p.name,p.color,p.archived,p.lead_id,p.type_id from projects p order by p.archived, p.name`),
      q('select * from custom_views where owner_id=$1 or shared order by name', [u.id]),
      getSetting('brand', {}),
      getSetting('helpdesk', {}),
      q('select * from tech_subcategories order by tech_category_id, sort, name'),
      q('select * from project_types order by sort, id'),
      q('select * from portfolio_options order by kind, sort, name'),
      getSetting('field_labels', {}),
    ]);
    // El superadmin es una cuenta técnica: figura para mostrar nombres, pero no se ofrece para asignar.
    for (const x of users) if (x.role === 'superadmin') Object.assign(x, { active: false, system: true });
    return {
      // groups: vacío desde la v1.9 (se eliminaron los grupos); fieldLabels: nombres de los campos que eligió el superadmin
      me: u, users, groups: [], fieldLabels: fieldLabels || {}, categories, techCategories: tech, techSubcategories: subtech, types, statuses, slas, projects, views, brand, helpdesk,
      projectTypes, origins: pOptions.filter((o) => o.kind === 'origin'), sectors: pOptions.filter((o) => o.kind === 'sector'), canPortfolio: canPortfolio(u),
      priorities: PRIORITIES, mailEnabled: await mailEnabled(), msEnabled: await msEnabled(), superadminEnabled: superadminEnabled(),
      inboundConfigured: Boolean(process.env.INBOUND_SECRET),
      ...(await integrationFlags()),
    };
  });

  // ---------- Notificaciones ----------
  r.get('/notifications', async ({ req }) => {
    const u = await requireUser(req);
    // El buzón de Microsoft 365 se lee mientras los agentes usan la app (a lo sumo una vez por intervalo)
    await (await import('./m365.js')).lazyPoll(req);
    const [items, unread] = await Promise.all([
      q('select * from notifications where user_id=$1 order by created_at desc limit 40', [u.id]),
      one('select count(*)::int as n from notifications where user_id=$1 and read_at is null', [u.id]),
    ]);
    return { items, unread: unread.n };
  });

  r.post('/notifications/read', async ({ req, body }) => {
    const u = await requireUser(req);
    const b = parse(v.object({ ids: v.array(v.id(), { max: 500, optional: true }) }), body);
    if (b.ids?.length) {
      await q('update notifications set read_at=now() where user_id=$1 and id = any($2::int[])', [u.id, b.ids]);
    } else {
      await q('update notifications set read_at=now() where user_id=$1 and read_at is null', [u.id]);
    }
    return { ok: true };
  });

  // ---------- Adjuntos ----------
  r.get('/attachments/:id', async ({ req, res, params, query }) => {
    const a = await one(`select a.*, m.ticket_id, m.kind as message_kind, t.contact_id, t.deleted_at as ticket_deleted, t.group_id, t.assignee_id
      from attachments a left join ticket_messages m on m.id=a.ticket_message_id left join tickets t on t.id=m.ticket_id where a.id=$1`, [idParam(params.id)]);
    if (!a) throw notFound('Adjunto no encontrado');
    const u = await currentUser(req);
    if (u && a.ticket_id && !(await canSeeTicket(u, a))) throw notFound('Adjunto no encontrado');
    if (!u) {
      // Acceso del portal: solo con el enlace del ticket, del contacto actual, y solo mensajes públicos
      // v1.9.6: solo con un enlace de 5 minutos para ese adjunto ('pa'); el enlace del ticket ya no se acepta en la URL
      const { verifyPortalToken } = await import('../tickets-core.js');
      const tok = await verifyPortalToken(query.token, ['pa']);
      if (!tok || tok.a !== a.id || tok.t !== a.ticket_id || tok.c !== a.contact_id || a.ticket_deleted) throw new HttpError(401, 'El enlace del adjunto venció: volvé a abrirlo desde el ticket');
      if (!['customer', 'reply'].includes(a.message_kind)) throw forbidden();
    }
    const tc = await import('../tickets-core.js');
    tc.sendAttachment(res, a, await tc.attachmentBuffer(a), { download: query.download === '1' });
    return undefined;
  }, { raw: true });

  // ---------- Administración: usuarios ----------
  r.get('/admin/users', async ({ req }) => {
    const me = await requireUser(req, ['admin', 'supervisor']);
    return q(`select id,name,email,role,active,color,last_login_at,created_at,can_portfolio,can_manage_projects,(password_hash is not null) as has_password,
        exists(select 1 from webauthn_credentials w where w.user_id=users.id) as has_passkey
      from users where role<>'superadmin' or $1::boolean order by (role='superadmin') desc, active desc, name`, [isSuper(me)]);
  });

  const userSchema = (create) => v.object({
    name: v.string({ min: 1, max: 120, optional: !create }),
    email: create ? v.email() : v.email({ optional: true }),
    role: v.enum(['admin', 'supervisor', 'agent'], { optional: true }),
    password: v.string({ max: 256, trim: false, optional: true }),
    color: v.string({ max: 20, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
    active: v.bool({ optional: true }),
    group_ids: v.array(v.id(), { max: 100, optional: true }),
    can_portfolio: v.bool({ optional: true }),
    can_manage_projects: v.bool({ optional: true }),
  });

  r.post('/admin/users', async ({ req, body }) => {
    const me = await requireUser(req, ['admin']);
    const b = parse(userSchema(true), body);
    const role = b.role || 'agent';
    if (role === 'admin' && !canManageAdmins(me)) throw forbidden('Solo el superadministrador puede crear administradores');
    if (b.can_portfolio && !isSuper(me)) throw forbidden('Solo el superadministrador asigna el permiso "Ver portfolio"');
    let hash = null;
    if (b.password) {
      checkPasswordPolicy(b.password, b);
      hash = await hashPassword(b.password);
    }
    try {
      return await tx(async () => {
        const u = await one(
          `insert into users(name,email,role,password_hash,color,must_change_password,can_portfolio,can_manage_projects) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id,name,email,role,active,color,can_portfolio,can_manage_projects`,
          [b.name, b.email, role, hash, b.color || '#475569', Boolean(b.password), Boolean(b.can_portfolio), Boolean(b.can_manage_projects)],
        );
        return u;
      });
    } catch (e) {
      if (e.code === '23505' || String(e.message).includes('unique')) throw bad('Ya existe un usuario con ese correo');
      throw e;
    }
  });

  r.patch('/admin/users/:id', async ({ req, body: raw, params }) => {
    const me = await requireUser(req, ['admin']);
    const id = idParam(params.id);
    if (raw?.role === 'superadmin') throw bad('Rol inválido');
    const body = parse(userSchema(false), raw);
    const cur = await one('select * from users where id=$1', [id]);
    if (!cur) throw notFound();
    if (cur.role === 'superadmin') throw forbidden('El superadmin se administra desde las variables de Vercel');
    if ((cur.role === 'admin' || body.role === 'admin') && !canManageAdmins(me) && id !== me.id) throw forbidden('Solo el superadministrador puede modificar administradores: ingresá con el usuario del superadmin');
    if (id === me.id && (body.active === false || (body.role && body.role !== 'admin'))) throw bad('No podés desactivarte ni quitarte el rol de administrador');
    if (body.can_portfolio !== undefined && body.can_portfolio !== cur.can_portfolio && !isSuper(me)) throw forbidden('Solo el superadministrador asigna el permiso "Ver portfolio"');
    let hash = cur.password_hash;
    let mustChange = cur.must_change_password;
    if (body.password) {
      checkPasswordPolicy(body.password, { email: body.email ?? cur.email, name: body.name ?? cur.name });
      hash = await hashPassword(body.password);
      mustChange = id !== me.id;
    }
    const role = body.role || cur.role;
    const u = await tx(async () => {
      const row = await one(
        `update users set name=$2,email=$3,role=$4,active=$5,color=$6,password_hash=$7,must_change_password=$8,can_portfolio=$9,can_manage_projects=$10 where id=$1 returning id,name,email,role,active,color,can_portfolio,can_manage_projects`,
        [id, body.name ?? cur.name, body.email ?? cur.email, role, body.active ?? cur.active, body.color ?? cur.color, hash, mustChange, body.can_portfolio ?? cur.can_portfolio, body.can_manage_projects ?? cur.can_manage_projects],
      );
      // Clave nueva, baja o cambio de rol: se cierran las sesiones abiertas de ese usuario.
      if (body.password || body.active === false || (body.role && body.role !== cur.role)) await revokeUserSessions(id);
      return row;
    });
    return u;
  });

  r.del('/admin/users/:id', async ({ req, params }) => {
    const me = await requireUser(req, ['admin']);
    if (int(params.id) === me.id) throw bad('No podés eliminar tu propio usuario');
    const target = await one('select role,name,email from users where id=$1', [int(params.id)]);
    if (!target) throw notFound();
    if (target.role === 'superadmin') throw forbidden('El superadmin se administra desde las variables de Vercel');
    if (target.role === 'admin' && !canManageAdmins(me)) throw forbidden('Solo el superadministrador puede eliminar administradores');
    await q('delete from users where id=$1', [int(params.id)]);
    return { ok: true };
  });

  // ---------- Tickets que tenían grupo (v1.9 sin grupos) ----------
  // Los que no se pudieron pasar solos a una categoría técnica se asignan acá, por grupo anterior.
  r.get('/admin/group-leftovers', async ({ req }) => {
    await requireUser(req, ['admin']);
    return q(`select g.id, g.name, count(t.id)::int as n from agent_groups g join tickets t on t.group_id = g.id
      where t.tech_category_id is null and t.deleted_at is null group by g.id, g.name order by count(t.id) desc, g.name`);
  });
  r.post('/admin/group-leftovers', async ({ req, body }) => {
    await requireUser(req, ['admin']);
    const b = parse(v.object({ group_id: v.id(), tech_category_id: v.id(), tech_subcategory_id: v.id({ optional: true, nullable: true }) }), body);
    const g = await one('select id, name from agent_groups where id=$1', [b.group_id]);
    if (!g) throw notFound('Ese grupo ya no existe');
    if (!(await one('select id from tech_categories where id=$1', [b.tech_category_id]))) throw bad('La categoría técnica no existe');
    if (b.tech_subcategory_id && !(await one('select id from tech_subcategories where id=$1 and tech_category_id=$2', [b.tech_subcategory_id, b.tech_category_id]))) {
      throw bad('La subcategoría no es de esa categoría técnica');
    }
    const rows = await q(`update tickets set tech_category_id=$2, tech_subcategory_id=$3, updated_at=now() where group_id=$1 and tech_category_id is null returning id`,
      [g.id, b.tech_category_id, b.tech_subcategory_id || null]);
    // Se recuerda la equivalencia: la usa el importador de Desk365 para la columna "Grupo"
    const map = (await getSetting('group_to_tech', {})) || {};
    map[norm(g.name)] = { tech_category_id: b.tech_category_id, tech_subcategory_id: b.tech_subcategory_id || null, name: g.name };
    await setSetting('group_to_tech', map);
    return { updated: rows.length };
  }, { tx: true });

  // ---------- Tablas de configuración ----------
  crud(r, '/admin/categories', 'categories', { name: 'text', description: 'text', active: 'bool', sort: 'int', aliases: 'text[]' });
  // Área solicitante desde el área del contacto (v1.12.1): áreas sin equivalencia y completar los tickets que no la tienen
  r.get('/admin/area-mapping', async ({ req }) => {
    await requireUser(req, ['admin']);
    const { unmatchedAreas, fillMissingAreas } = await import('../areas.js');
    const filled = await fillMissingAreas();
    return { unmatched: await unmatchedAreas(), filled };
  });
  r.post('/admin/area-mapping', async ({ req, body: raw }) => {
    await requireUser(req, ['admin']);
    const b = parse(v.object({ area: v.string({ min: 1, max: 120 }), category_id: v.id({ optional: true, nullable: true }), create: v.bool({ default: false }) }), raw);
    const { normArea, fillMissingAreas } = await import('../areas.js');
    const area = b.area.trim();
    if (b.create) {
      const exists = (await q('select id, name from categories')).find((c) => normArea(c.name) === normArea(area));
      if (!exists) await q('insert into categories(name, description, sort) values ($1, $2, (select coalesce(max(sort), 0) + 1 from categories))', [area.slice(0, 160), '']);
      else await q('update categories set active=true where id=$1', [exists.id]);
    } else {
      if (!b.category_id) throw bad('Elegí el área');
      const c = await one('select id, aliases from categories where id=$1', [b.category_id]);
      if (!c) throw notFound('No existe el área');
      const aliases = [...new Set([...(c.aliases || []), area])].slice(0, 50);
      await q('update categories set aliases=$2, active=true where id=$1', [c.id, aliases]);
    }
    return { ok: true, filled: await fillMissingAreas() };
  });
  crud(r, '/admin/tech-categories', 'tech_categories', { name: 'text', active: 'bool', sort: 'int' });
  // Subcategorías técnicas: un nivel debajo de cada categoría técnica
  crud(r, '/admin/tech-subcategories', 'tech_subcategories', { tech_category_id: 'int', name: 'text', active: 'bool', sort: 'int' }, {
    required: ['name', 'tech_category_id'], order: 'tech_category_id, sort, name',
    schema: v.object({
      tech_category_id: v.id({ optional: true }), name: v.string({ min: 1, max: 120, optional: true }), active: v.bool({ optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }),
    }),
    validate: async (b) => {
      if (b.tech_category_id && !(await one('select 1 as x from tech_categories where id=$1', [b.tech_category_id]))) throw bad('La categoría técnica no existe');
    },
  });
  // Tipos de proyecto: plantilla de etapas y flujo de tareas
  crud(r, '/admin/project-types', 'project_types', {
    name: 'text', description: 'text', phases: 'json', workflow: 'text', uses_sprints: 'bool', color: 'text', is_default: 'bool', active: 'bool', sort: 'int',
  }, {
    readRoles: null,
    schema: v.object({
      name: v.string({ min: 1, max: 80, optional: true }), description: v.string({ max: 500, optional: true }),
      phases: v.array(v.string({ min: 1, max: 120 }), { max: 15, optional: true }),
      workflow: v.enum(['scrum', 'kanban', 'dev', 'simple'], { optional: true }), uses_sprints: v.bool({ optional: true }),
      color: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }), is_default: v.bool({ optional: true }),
      active: v.bool({ optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }),
    }),
    validate: async (b, id) => {
      if (b.phases && !b.phases.length) throw bad('El tipo necesita al menos una etapa');
      // Un solo tipo predeterminado (es el que se usa al convertir un ticket)
      if (b.is_default) await q('update project_types set is_default=false where id is distinct from $1', [id]);
    },
  });
  // Listas del portfolio: origen y sector IT (el área solicitante son las categorías)
  // Cuántos proyectos usan cada origen / sector (para la pantalla de configuración)
  r.get('/admin/portfolio-options/usage', async ({ req }) => {
    await requireUser(req, ['admin']);
    const rows = await q(`select o.id, (select count(*)::int from projects p where p.origin_id=o.id or p.sector_id=o.id) as n from portfolio_options o`);
    return Object.fromEntries(rows.map((x) => [x.id, x.n]));
  });
  crud(r, '/admin/portfolio-options', 'portfolio_options', { kind: 'text', name: 'text', color: 'text', active: 'bool', sort: 'int' }, {
    readRoles: null, required: ['name', 'kind'], order: 'kind, sort, name',
    // Borrar uno en uso dejaría proyectos sin origen o sector: en ese caso se desactiva
    beforeDelete: async (id) => {
      const n = (await one('select count(*)::int as n from projects where origin_id=$1 or sector_id=$1', [id])).n;
      if (n) throw bad(`Está en uso en ${n} proyecto${n === 1 ? '' : 's'}: desactivalo para que no se ofrezca más`);
    },
    schema: v.object({
      kind: v.enum(['origin', 'sector'], { optional: true }), name: v.string({ min: 1, max: 80, optional: true }),
      color: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }), active: v.bool({ optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }),
    }),
  });
  crud(r, '/admin/types', 'ticket_types', { name: 'text', active: 'bool', sort: 'int' });
  crud(r, '/admin/statuses', 'statuses', { name: 'text', kind: 'text', color: 'text', pauses_sla: 'bool', is_default: 'bool', active: 'bool', sort: 'int' }, {
    schema: v.object({
      name: v.string({ min: 1, max: 60, optional: true }), kind: v.enum(['open', 'pending', 'resolved', 'closed'], { optional: true }),
      color: v.string({ max: 20, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }), pauses_sla: v.bool({ optional: true }), is_default: v.bool({ optional: true }),
      active: v.bool({ optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }),
    }),
    validate: async (b) => {
      if (b.is_default) await q('update statuses set is_default=false');
    },
  });
  const slaTarget = v.object({ first: v.number({ min: 0, max: 8760, optional: true, nullable: true }), resolve: v.number({ min: 0, max: 8760, optional: true, nullable: true }) }, { optional: true });
  crud(r, '/admin/slas', 'sla_policies', { name: 'text', is_default: 'bool', no_sla: 'bool', business_hours: 'bool', targets: 'json', active: 'bool', sort: 'int' }, {
    schema: v.object({
      name: v.string({ min: 1, max: 80, optional: true }), is_default: v.bool({ optional: true }), no_sla: v.bool({ optional: true }), business_hours: v.bool({ optional: true }),
      targets: v.object({ 1: slaTarget, 2: slaTarget, 3: slaTarget, 4: slaTarget }, { optional: true }), active: v.bool({ optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }),
    }),
    validate: async (b) => {
      if (b.is_default) await q('update sla_policies set is_default=false');
    },
  });
  crud(r, '/admin/rules', 'automation_rules', { name: 'text', event: 'text', match: 'text', conditions: 'json', actions: 'json', active: 'bool', stop: 'bool', sort: 'int' }, {
    schema: v.object({
      name: v.string({ min: 1, max: 120, optional: true }), event: v.enum(['ticket_created'], { optional: true }), match: v.enum(['all', 'any'], { optional: true }),
      conditions: v.array(v.object({
        field: v.enum(['subject', 'description', 'from_email', 'from_domain', 'channel', 'priority', 'category_id', 'type_id', 'tech_category_id', 'tech_subcategory_id', 'contact_area']),
        op: v.enum(['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'is_empty']),
        value: v.string({ max: 300, optional: true }),
      }), { max: 30, optional: true }),
      actions: v.array(v.object({
        field: v.enum(['assignee_id', 'priority', 'status_id', 'type_id', 'category_id', 'tech_category_id', 'tech_subcategory_id', 'sla_id', 'add_tag']),
        value: v.string({ max: 120, optional: true, nullable: true }),
      }), { max: 30, optional: true }),
      active: v.bool({ optional: true }), stop: v.bool({ optional: true }), sort: v.int({ min: 0, max: 10000, optional: true }),
    }),
  });
  crud(r, '/admin/companies', 'companies', { name: 'text', domain: 'text', notes: 'text' }, { roles: ['admin', 'supervisor', 'agent'], readRoles: null, order: 'name' });

  // ---------- Ajustes generales ----------
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const SETTING_SCHEMAS = {
    brand: v.object({
      name: v.string({ max: 120, optional: true }),
      product: v.string({ max: 120, optional: true }),
      color: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
      accent: v.string({ max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
      logo: v.string({ max: 700000, trim: false, pattern: /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, optional: true, nullable: true }),
      // Mascota en las pantallas de ingreso (encendida de fábrica)
      login_mascot: v.bool({ optional: true }),
    }),
    helpdesk: v.object({
      support_email: v.email({ optional: true }),
      timezone: v.string({ max: 64, pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, optional: true }),
      auto_close_days: v.int({ min: 0, max: 365, optional: true }),
      portal_title: v.string({ max: 120, optional: true }),
      portal_enabled: v.bool({ optional: true }),
      // Ingreso de empleados al portal con su cuenta de Microsoft (ven solo sus tickets)
      portal_microsoft: v.bool({ optional: true }),
      // Portal (v1.12): acceso y partes que se muestran
      portal_access: v.enum(['microsoft', 'open'], { optional: true }),
      portal_show_kb: v.bool({ optional: true }),
      portal_show_lookup: v.bool({ optional: true }),
      portal_show_create: v.bool({ optional: true }),
      portal_show_my_tickets: v.bool({ optional: true }),
      // Sistemas críticos (v1.11)
      critical_portal: v.bool({ optional: true }),
      critical_ticket_warning: v.bool({ optional: true }),
      critical_late_notify: v.bool({ optional: true }),
      critical_managers_only: v.bool({ optional: true }),
      critical_resolve_tickets: v.bool({ optional: true }),
      notify_contact_on_create: v.bool({ optional: true }),
      notify_contact_on_resolve: v.bool({ optional: true }),
      notify_agent_on_assign: v.bool({ optional: true }),
      // Dominios de confianza: solo esos correos pueden usar el portal y recibir correos automáticos
      portal_trusted_domains: v.array(v.string({ min: 3, max: 253, pattern: /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i }), { max: 50, optional: true }),
      portal_allow_directory_contacts: v.bool({ optional: true }),
      portal_ai_daily_limit: v.int({ min: 0, max: 100000, optional: true }),
      business: v.object({
        days: v.array(v.int({ min: 0, max: 6 }), { max: 7 }),
        start: v.string({ pattern: hhmm }),
        end: v.string({ pattern: hhmm }),
      }, { optional: true }),
      holidays: v.array(v.date(), { max: 200, optional: true }),
      dev_phases: v.array(v.string({ min: 1, max: 80 }), { max: 20, optional: true }),
      dev_rules: v.object({
        on_convert_status_id: v.id({ optional: true, nullable: true }),
        on_start_status_id: v.id({ optional: true, nullable: true }),
        on_finish_status_id: v.id({ optional: true, nullable: true }),
        phase_rules: v.array(v.object({ phase: v.string({ min: 1, max: 80 }), status_id: v.id() }), { max: 30, default: () => [] }),
        pause_sla: v.bool({ default: false }),
        notify_contact_phase: v.bool({ default: false }),
        notify_contact_finish: v.bool({ default: false }),
        issues_done_note: v.bool({ default: true }),
        issues_done_reopen: v.bool({ default: true }),
        waiting_status_ids: v.array(v.id(), { max: 30, optional: true, nullable: true }),
        issues_done_status_id: v.id({ optional: true, nullable: true }),
      }, { optional: true }),
      portfolio_month_hours: v.int({ min: 1, max: 744, optional: true }),
      portfolio_day_hours: v.number({ min: 0.5, max: 24, optional: true }),
      aging: v.object({
        green_days: v.int({ min: 1, max: 3650, optional: true }), amber_days: v.int({ min: 1, max: 3650, optional: true }), critical_days: v.int({ min: 1, max: 3650, optional: true }),
        inactive_days: v.int({ min: 1, max: 3650, optional: true }), waiting_hours: v.int({ min: 1, max: 8760, optional: true }),
        list_size: v.int({ min: 3, max: 20, optional: true }), buckets: v.array(v.int({ min: 1, max: 3650 }), { max: 12, optional: true }),
        weights: v.object(Object.fromEntries(['urgent', 'high', 'medium', 'overdue', 'due_soon', 'waiting', 'vip', 'reopened', 'age_week', 'age_max', 'needs_agent', 'followers']
          .map((k) => [k, v.int({ min: 0, max: 100, optional: true })])), { optional: true }),
      }, { optional: true }),
    }),
  };
  const hasSetting = (k) => Object.hasOwn(SETTING_SCHEMAS, k);
  // Anula todos los enlaces del portal enviados hasta ahora (por ejemplo, si un correo con enlaces se reenvió por error)
  r.post('/admin/portal/revoke-links', async ({ req }) => {
    const u = await requireUser(req, ['admin']);
    const row = await one(`insert into app_settings(key,value,updated_at) values ('helpdesk', '{"portal_token_epoch":1}'::jsonb, now())
      on conflict (key) do update set value = jsonb_set(app_settings.value, '{portal_token_epoch}', to_jsonb(coalesce((app_settings.value->>'portal_token_epoch')::int, 0) + 1)), updated_at=now()
      returning (value->>'portal_token_epoch')::int as epoch`);
    clearSettingsCache();
    await audit(req, u, 'portal_links_revoked', { epoch: row.epoch });
    return { ok: true, epoch: row.epoch };
  });

  r.get('/admin/settings/:key', async ({ req, params }) => {
    await requireUser(req, ['admin']);
    if (!hasSetting(params.key)) throw notFound();
    return (await getSetting(params.key, {})) || {};
  });
  r.put('/admin/settings/:key', async ({ req, params, body }) => {
    await requireUser(req, ['admin']);
    if (!hasSetting(params.key)) throw notFound();
    const patch = parse(SETTING_SCHEMAS[params.key], body);
    return tx(async () => {
      // Se lee de la base con la fila bloqueada (no del caché de esta instancia): así no se pisan cambios hechos al mismo
      // tiempo desde otro lado (ej. anular los enlaces del portal)
      await q(`insert into app_settings(key,value) values ($1,'{}'::jsonb) on conflict (key) do nothing`, [params.key]);
      const cur = (await one('select value from app_settings where key=$1 for update', [params.key]))?.value || {};
      const next = { ...cur, ...patch };
      // Los objetos anidados se combinan (un cambio parcial no borra el resto)
      // Solo los campos que vinieron en el pedido: un guardado parcial no vuelve a los valores por defecto el resto
      const sent = (obj, raw) => Object.fromEntries(Object.entries(obj || {}).filter(([key]) => raw && typeof raw === 'object' && Object.hasOwn(raw, key)));
      for (const k of ['aging', 'business', 'dev_rules']) {
        if (patch[k] && cur[k] && typeof cur[k] === 'object') {
          const part = sent(patch[k], body[k]);
          next[k] = { ...cur[k], ...part, ...(part.weights ? { weights: { ...(cur[k].weights || {}), ...sent(part.weights, body[k].weights) } } : {}) };
        }
      }
      await setSetting(params.key, next);
      return next;
    });
  });

  r.post('/admin/ticket-number', async ({ req, body }) => {
    await requireUser(req, ['admin']);
    const n = parse(v.object({ next: v.int({ min: 1, max: 99999999 }) }), body).next;
    const maxT = await one('select coalesce(max(number),0)::int as m from tickets');
    if (!n || n <= maxT.m) throw bad(`El próximo número debe ser mayor a ${maxT.m}`);
    await q(`select setval('ticket_number_seq', $1, false)`, [n]);
    return { ok: true };
  });

  // ---------- Respuestas predefinidas ----------
  const cannedSchema = (create) => v.object({
    title: v.string({ min: 1, max: 160, optional: !create }),
    folder: v.string({ max: 80, optional: true }),
    body_html: v.html({ max: 100000, optional: true }),
    shared: v.bool({ optional: true }),
  });
  const ownCanned = async (u, id) => {
    const c = await one('select * from canned_responses where id=$1', [idParam(id)]);
    if (!c) throw notFound();
    if (c.owner_id !== u.id && !['admin', 'superadmin'].includes(u.role)) throw forbidden();
    return c;
  };
  r.get('/canned', async ({ req }) => {
    const u = await requireUser(req);
    return q('select * from canned_responses where shared or owner_id=$1 order by folder, title', [u.id]);
  });
  r.post('/canned', async ({ req, body }) => {
    const u = await requireUser(req);
    const b = parse(cannedSchema(true), body);
    return one('insert into canned_responses(title,folder,body_html,owner_id,shared) values ($1,$2,$3,$4,$5) returning *', [b.title, b.folder || 'General', b.body_html || '', u.id, b.shared !== false]);
  });
  r.patch('/canned/:id', async ({ req, body, params }) => {
    const u = await requireUser(req);
    const c = await ownCanned(u, params.id);
    const b = parse(cannedSchema(false), body);
    return one('update canned_responses set title=$2,folder=$3,body_html=$4,shared=$5 where id=$1 returning *', [c.id, b.title ?? c.title, b.folder ?? c.folder, b.body_html ?? c.body_html, b.shared ?? c.shared]);
  });
  r.del('/canned/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const c = await ownCanned(u, params.id);
    await q('delete from canned_responses where id=$1', [c.id]);
    return { ok: true };
  });

  // ---------- Vistas personalizadas ----------
  const VIEW_FILTERS = v.object(Object.fromEntries(
    ['view', 'status', 'status_kind', 'priority', 'assignee', 'category', 'tech', 'subtech', 'type', 'channel', 'tag', 'q', 'sort', 'order', 'from', 'to', 'contact', 'company', 'sla']
      .map((k) => [k, v.string({ max: 200, optional: true })]),
  ), { optional: true });
  const viewSchema = (create) => v.object({ name: v.string({ min: 1, max: 80, optional: !create }), shared: v.bool({ optional: true }), filters: VIEW_FILTERS });
  const ownView = async (u, id) => {
    const row = await one('select * from custom_views where id=$1', [idParam(id)]);
    if (!row) throw notFound();
    if (row.owner_id !== u.id && !['admin', 'superadmin'].includes(u.role)) throw forbidden();
    return row;
  };
  r.post('/views', async ({ req, body }) => {
    const u = await requireUser(req);
    const b = parse(viewSchema(true), body);
    return one('insert into custom_views(name,owner_id,shared,filters) values ($1,$2,$3,$4::jsonb) returning *', [b.name, u.id, Boolean(b.shared), JSON.stringify(b.filters || {})]);
  });
  r.patch('/views/:id', async ({ req, body, params }) => {
    const u = await requireUser(req);
    const cur = await ownView(u, params.id);
    const b = parse(viewSchema(false), body);
    return one('update custom_views set name=$2,shared=$3,filters=$4::jsonb where id=$1 returning *', [cur.id, b.name ?? cur.name, b.shared ?? cur.shared, JSON.stringify(b.filters ?? cur.filters)]);
  });
  r.del('/views/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const cur = await ownView(u, params.id);
    await q('delete from custom_views where id=$1', [cur.id]);
    return { ok: true };
  });
}
