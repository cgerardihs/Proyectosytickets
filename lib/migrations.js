// Migraciones versionadas. Reglas:
//  1. Una migración aplicada no se edita: se agrega otra con el número siguiente.
//  2. Expandir y contraer en deploys distintos: nunca DROP/RENAME de columnas o tablas en la misma versión
//     que deja de usarlas. Una migración de "contracción" se marca con contract: { after: <versión> } y solo
//     puede salir cuando el código de esa versión ya no usa lo que se borra (lo controla tests/migrations.test.mjs).
//  3. Cada migración corre en una transacción, con un lock para que dos instancias no la apliquen a la vez.
import { SCHEMA } from './schema.js';
import { splitSql } from './db.js';

export const MIGRATIONS = [
  {
    version: 5,
    name: 'Esquema base v1.0–v1.4 (tickets, proyectos, superadmin, IA, Microsoft 365)',
    statements: splitSql(SCHEMA),
  },
  {
    version: 6,
    name: 'v1.5 seguridad: sesiones, passkeys, límites, idempotencia e índices',
    statements: [
      // Sesiones del lado del servidor (id aleatorio de 256 bits; en la base solo el hash)
      `create table if not exists sessions (
        id_hash text primary key,
        user_id int not null references users(id) on delete cascade,
        method text not null default 'password',
        ip text not null default '',
        user_agent text not null default '',
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null
      )`,
      'create index if not exists sessions_user_idx on sessions(user_id)',
      'create index if not exists sessions_expires_idx on sessions(expires_at)',
      // Passkeys (WebAuthn / FIDO2)
      'alter table users add column if not exists webauthn_user_id text',
      `create table if not exists webauthn_credentials (
        id text primary key,
        user_id int not null references users(id) on delete cascade,
        public_key text not null,
        counter bigint not null default 0,
        transports text[] not null default '{}',
        device_type text not null default '',
        backed_up boolean not null default false,
        name text not null default 'Passkey',
        created_at timestamptz not null default now(),
        last_used_at timestamptz
      )`,
      'create index if not exists webauthn_credentials_user_idx on webauthn_credentials(user_id)',
      `create table if not exists webauthn_challenges (
        id text primary key,
        challenge text not null,
        user_id int references users(id) on delete cascade,
        kind text not null,
        expires_at timestamptz not null
      )`,
      'create index if not exists webauthn_challenges_expires_idx on webauthn_challenges(expires_at)',
      // Límites de uso compartidos entre instancias
      `create table if not exists rate_limits (
        key text primary key,
        count int not null default 0,
        window_start timestamptz not null default now()
      )`,
      'create index if not exists rate_limits_window_idx on rate_limits(window_start)',
      // Idempotencia de operaciones que no se pueden repetir (alta de tickets, mensajes, etc.)
      `create table if not exists idempotency_keys (
        scope text not null,
        key text not null,
        request_hash text not null,
        status int,
        response jsonb,
        created_at timestamptz not null default now(),
        primary key (scope, key)
      )`,
      'create index if not exists idempotency_keys_created_idx on idempotency_keys(created_at)',
      // Correo entrante: el mismo Message-ID no puede generar dos mensajes (se limpian duplicados previos)
      `update ticket_messages m set message_id = null
        where m.message_id is not null and exists (select 1 from ticket_messages m2 where m2.message_id = m.message_id and m2.id < m.id)`,
      'create unique index if not exists ticket_messages_msgid_uidx on ticket_messages(message_id) where message_id is not null',
      // Índices en lo que se filtra y ordena
      'create index if not exists tickets_assignee_status_idx on tickets(assignee_id, status_id) where deleted_at is null',
      'create index if not exists tickets_activity_idx on tickets(last_activity_at desc)',
      'create index if not exists tickets_updated_idx on tickets(updated_at desc)',
      'create index if not exists tickets_due_idx on tickets(resolution_due) where resolution_due is not null',
      'create index if not exists tickets_category_idx on tickets(category_id)',
      'create index if not exists tickets_tech_idx on tickets(tech_category_id)',
      'create index if not exists tickets_type_idx on tickets(type_id)',
      'create index if not exists tickets_priority_idx on tickets(priority)',
      'create index if not exists tickets_deleted_idx on tickets(deleted_at) where deleted_at is not null',
      'create index if not exists tickets_tags_idx on tickets using gin(tags)',
      'create index if not exists ticket_messages_ticket_created_idx on ticket_messages(ticket_id, created_at)',
      'create index if not exists ticket_activities_ticket_action_idx on ticket_activities(ticket_id, action)',
      'create index if not exists ticket_followers_user_idx on ticket_followers(user_id)',
      'create index if not exists ticket_issue_links_issue_idx on ticket_issue_links(issue_id)',
      'create index if not exists time_entries_ticket_idx on time_entries(ticket_id)',
      'create index if not exists time_entries_issue_idx on time_entries(issue_id)',
      'create index if not exists time_entries_spent_idx on time_entries(spent_on)',
      'create index if not exists issues_status_idx on issues(status_id)',
      'create index if not exists issues_due_idx on issues(due_date) where due_date is not null',
      'create index if not exists issues_project_rank_idx on issues(project_id, rank)',
      'create index if not exists issue_comments_issue_idx on issue_comments(issue_id)',
      'create index if not exists issue_links_to_idx on issue_links(to_issue_id)',
      'create index if not exists sprints_project_idx on sprints(project_id, state)',
      'create index if not exists contacts_company_idx on contacts(company_id)',
      'create index if not exists contacts_external_idx on contacts(external_id) where external_id is not null',
      'create index if not exists users_external_idx on users(external_id) where external_id is not null',
      'create index if not exists notifications_unread_idx on notifications(user_id) where read_at is null',
      'create index if not exists audit_log_ip_idx on audit_log(ip, created_at desc)',
      'create index if not exists audit_log_user_idx on audit_log(user_id, created_at desc)',
      'create index if not exists ai_usage_ip_idx on ai_usage(ip, created_at desc)',
      'create index if not exists ai_usage_ticket_idx on ai_usage(ticket_id)',
      'create index if not exists ai_deflections_created_idx on ai_deflections(created_at desc)',
      'create index if not exists kb_articles_status_idx on kb_articles(status, category_id)',
      'create index if not exists group_members_user_idx on group_members(user_id)',
      'create index if not exists custom_views_owner_idx on custom_views(owner_id)',
      'create index if not exists canned_owner_idx on canned_responses(owner_id)',
      'create index if not exists automation_rules_event_idx on automation_rules(event, active)',
      // Búsqueda de texto (ilike '%…%') con trigramas, si la base lo permite (Neon sí; PGlite no lo trae)
      `do $$ begin
        create extension if not exists pg_trgm;
      exception when others then
        raise notice 'pg_trgm no disponible: la búsqueda sigue funcionando sin índice';
      end $$`,
      `do $$ begin
        if exists (select 1 from pg_extension where extname = 'pg_trgm') then
          execute 'create index if not exists tickets_subject_trgm_idx on tickets using gin (subject gin_trgm_ops)';
          execute 'create index if not exists contacts_name_trgm_idx on contacts using gin (name gin_trgm_ops)';
          execute 'create index if not exists contacts_email_trgm_idx on contacts using gin (email gin_trgm_ops)';
          execute 'create index if not exists kb_articles_title_trgm_idx on kb_articles using gin (title gin_trgm_ops)';
          execute 'create index if not exists issues_title_trgm_idx on issues using gin (title gin_trgm_ops)';
        end if;
      end $$`,
    ],
  },
  {
    version: 7,
    name: 'v1.5 ajustes de la revisión: sesiones del superadmin, OIDC por oid e índices funcionales',
    statements: [
      // Huella de la clave del superadmin en su sesión: si cambia SUPERADMIN_PASSWORD, la sesión deja de valer
      "alter table sessions add column if not exists fingerprint text not null default ''",
      'create index if not exists projects_key_upper_idx on projects(upper(key))',
      'create index if not exists issues_key_upper_idx on issues(upper(key))',
      `do $$ begin
        if exists (select 1 from pg_extension where extname = 'pg_trgm') then
          execute 'create index if not exists ticket_messages_body_trgm_idx on ticket_messages using gin (body_html gin_trgm_ops)';
        end if;
      end $$`,
    ],
  },
  {
    version: 8,
    name: 'v1.6 tipos de proyecto, portfolio, subcategorías técnicas y API',
    statements: [
      // Tipos de proyecto: cada uno con su plantilla de etapas (épicas) y su flujo de tareas
      `create table if not exists project_types (
        id serial primary key,
        name text not null unique,
        description text not null default '',
        phases jsonb not null default '[]',
        workflow text not null default 'scrum' check (workflow in ('scrum','kanban','dev','simple')),
        uses_sprints boolean not null default true,
        color text not null default '#475569',
        is_default boolean not null default false,
        active boolean not null default true,
        sort int not null default 0
      )`,
      `insert into project_types(name,description,phases,workflow,uses_sprints,color,is_default,sort) values
        ('Desarrollo de software','Desarrollos propios: nuevos sistemas, mejoras y pedidos que vienen de un ticket',
          '["Relevamiento y análisis","Desarrollo","Testing","Implementación"]','scrum',true,'#C41230',true,0),
        ('Instalación de sistema','Implementación de un producto comprado o de un proveedor',
          '["Análisis","Instalación","Implementación"]','simple',false,'#2563eb',false,1),
        ('Infraestructura','Equipamiento, redes, servidores, licencias y servicios',
          '["Relevamiento","Ejecución","Puesta en marcha"]','simple',false,'#0891b2',false,2),
        ('Capacitación','Capacitaciones internas o de proveedores',
          '["Planificación","Dictado","Evaluación"]','simple',false,'#7c3aed',false,3)
        on conflict (name) do nothing`,
      // Listas del portfolio (el área solicitante reutiliza las categorías de los tickets)
      `create table if not exists portfolio_options (
        id serial primary key,
        kind text not null check (kind in ('origin','sector')),
        name text not null,
        color text not null default '#64748b',
        active boolean not null default true,
        sort int not null default 0,
        unique (kind, name)
      )`,
      `insert into portfolio_options(kind,name,color,sort) values
        ('origin','OKR 26-27','#C41230',0), ('origin','Mejora evolutiva','#2563eb',1), ('origin','Mejora de proceso','#0891b2',2), ('origin','Oportunidad de negocio','#E8A317',3),
        ('sector','Sistemas | Desarrollo','#C41230',0), ('sector','Sistemas | Infra','#0891b2',1), ('sector','Sistemas | Core','#7c3aed',2)
        on conflict (kind, name) do nothing`,
      'alter table projects add column if not exists type_id int references project_types(id) on delete set null',
      'alter table projects add column if not exists origin_id int references portfolio_options(id) on delete set null',
      'alter table projects add column if not exists sector_id int references portfolio_options(id) on delete set null',
      'alter table projects add column if not exists area_id int references categories(id) on delete set null',
      'alter table projects add column if not exists priority smallint not null default 2',
      'alter table projects add column if not exists start_date date',
      'alter table projects add column if not exists end_date date',
      'alter table projects add column if not exists estimated_hours numeric',
      'alter table projects add column if not exists extra_hours numeric not null default 0',
      'alter table projects add column if not exists progress_override smallint',
      "alter table projects add column if not exists portfolio_status text not null default 'active'",
      'alter table projects add column if not exists recurring boolean not null default false',
      'alter table projects add column if not exists updated_at timestamptz not null default now()',
      // Avance manual de una etapa que no tiene tareas (ej. el dictado de una capacitación)
      'alter table issues add column if not exists progress smallint',
      // Proyectos existentes: tipo "Desarrollo de software"; los archivados figuran como finalizados
      `update projects set type_id = (select id from project_types where is_default order by id limit 1) where type_id is null`,
      `update projects set portfolio_status = 'done' where archived and portfolio_status = 'active'`,
      // Subcategorías técnicas (un nivel debajo de cada categoría técnica)
      `create table if not exists tech_subcategories (
        id serial primary key,
        tech_category_id int not null references tech_categories(id) on delete cascade,
        name text not null,
        active boolean not null default true,
        sort int not null default 0,
        unique (tech_category_id, name)
      )`,
      'alter table tickets add column if not exists tech_subcategory_id int references tech_subcategories(id) on delete set null',
      // Permiso para ver el portfolio (lo asigna el superadmin)
      'alter table users add column if not exists can_portfolio boolean not null default false',
      // Claves de la API de exportación (se guarda solo el hash)
      `create table if not exists api_keys (
        id serial primary key,
        name text not null,
        prefix text not null unique,
        key_hash text not null unique,
        scopes text[] not null default '{}',
        created_by int references users(id) on delete set null,
        created_at timestamptz not null default now(),
        expires_at timestamptz,
        last_used_at timestamptz,
        last_ip text not null default '',
        use_count bigint not null default 0,
        revoked_at timestamptz
      )`,
      'create index if not exists tickets_tech_sub_idx on tickets(tech_subcategory_id)',
      'create index if not exists tech_subcategories_cat_idx on tech_subcategories(tech_category_id, sort)',
      'create index if not exists projects_type_idx on projects(type_id)',
      'create index if not exists projects_status_idx on projects(portfolio_status)',
      'create index if not exists projects_updated_idx on projects(updated_at, id)',
      'create index if not exists tickets_updated_id_idx on tickets(updated_at, id)',
      'create index if not exists issues_updated_id_idx on issues(updated_at, id)',
      'create index if not exists issues_project_type_idx on issues(project_id, type)',
      'create index if not exists time_entries_created_id_idx on time_entries(created_at, id)',
    ],
  },
  {
    version: 9,
    name: 'v1.6.2 grupos privados',
    statements: [
      // Grupo privado: sus tickets los ven solo sus miembros, el asignado, supervisores y administradores
      'alter table agent_groups add column if not exists private boolean not null default false',
      'create index if not exists agent_groups_private_idx on agent_groups(id) where private',
    ],
  },
  {
    version: 10,
    name: 'v1.7 cierre de ciclo ticket ↔ tareas',
    statements: [
      // Estado para los tickets que esperan a desarrollo. Solo en bases que ya tienen estados
      // (en una instalación nueva lo crea el alta inicial junto con los demás).
      `insert into statuses(name,kind,color,pauses_sla,is_default,sort)
        select 'En espera de desarrollo','pending','#0891B2',true,false,coalesce(max(sort),0)+1 from statuses having count(*) > 0
        on conflict (name) do nothing`,
    ],
  },
  {
    version: 11,
    name: 'v1.8 colores de la marca Hanseatica',
    statements: [
      // Rojo y amarillo de la marca (Pantone 186 y 130). Solo si nadie los cambió desde Configuración.
      `update app_settings set value = jsonb_set(value, '{color}', '"#C8102E"'), updated_at = now() where key = 'brand' and upper(value->>'color') = '#C41230'`,
      `update app_settings set value = jsonb_set(value, '{accent}', '"#F2A900"'), updated_at = now() where key = 'brand' and upper(value->>'accent') = '#E8A317'`,
    ],
  },
  {
    version: 12,
    name: 'v1.9 sin grupos: el grupo de cada ticket pasa a la categoría técnica',
    statements: [
      // Equivalencia grupo → categoría técnica, calculada UNA vez por grupo (no por ticket):
      // la que estaba atada al grupo, la de igual nombre o la que es el comienzo del nombre del grupo hasta un límite de palabra
      // (ej. "EQUIS - DESARROLLOS - Bugs…" → "Equis"; "Redes sociales" no cae en "Red"). Prefiere las activas y la más larga.
      // Subcategoría: la de esa categoría cuyo nombre aparece en el del grupo (ej. "Uso diario").
      `create temp table hd_v19_map on commit drop as
        select g.id as gid, g.name as gname, m.tid,
          (select s.id from tech_subcategories s where s.tech_category_id = m.tid and length(s.name) >= 3 and position(lower(s.name) in lower(g.name)) > 0
            order by length(s.name) desc, s.id limit 1) as sid
        from agent_groups g
        left join lateral (
          select tc.id as tid from tech_categories tc
          where tc.group_id = g.id or lower(tc.name) = lower(g.name)
            or (length(tc.name) >= 3 and left(lower(g.name), length(tc.name)) = lower(tc.name) and substr(lower(g.name), length(tc.name) + 1, 1) !~ '[[:alnum:]]')
            or (length(g.name) >= 3 and left(lower(tc.name), length(g.name)) = lower(g.name) and substr(lower(tc.name), length(g.name) + 1, 1) !~ '[[:alnum:]]')
          order by tc.active desc, (tc.group_id is not distinct from g.id) desc, (lower(tc.name) = lower(g.name)) desc, length(tc.name) desc, tc.id
          limit 1
        ) m on true`,
      `update tickets t set tech_category_id = m.tid, tech_subcategory_id = coalesce(t.tech_subcategory_id, m.sid), updated_at = now()
        from hd_v19_map m where m.gid = t.group_id and t.tech_category_id is null and m.tid is not null`,
      `update tickets t set tech_subcategory_id = m.sid, updated_at = now()
        from hd_v19_map m where m.gid = t.group_id and t.tech_category_id = m.tid and t.tech_subcategory_id is null and m.sid is not null`,
      // Reglas: las que usaban un grupo sin equivalente se desactivan para revisarlas; las demás pasan a la categoría técnica
      // (y la acción suma la subcategoría). Solo reglas con conditions/actions en forma de lista.
      `update automation_rules r set active = false, name = left(r.name || ' (revisar: usaba grupo)', 120)
        where jsonb_typeof(r.conditions) = 'array' and jsonb_typeof(r.actions) = 'array' and r.name not like '%(revisar: usaba grupo)%'
          and (exists (select 1 from jsonb_array_elements(r.conditions) c where c->>'field' = 'group_id'
                and not exists (select 1 from hd_v19_map m where m.gid::text = c->>'value' and m.tid is not null))
            or exists (select 1 from jsonb_array_elements(r.actions) a where a->>'field' = 'group_id' and coalesce(a->>'value', '') <> ''
                and not exists (select 1 from hd_v19_map m where m.gid::text = a->>'value' and m.tid is not null)))`,
      `update automation_rules r set
          conditions = (select coalesce(jsonb_agg(case when m.tid is not null then c || jsonb_build_object('field', 'tech_category_id', 'value', m.tid::text) else c end order by o), '[]'::jsonb)
            from jsonb_array_elements(r.conditions) with ordinality as x(c, o)
            left join hd_v19_map m on c->>'field' = 'group_id' and m.gid::text = c->>'value'),
          actions = (select coalesce(jsonb_agg(e order by o, k), '[]'::jsonb)
            from jsonb_array_elements(r.actions) with ordinality as x(a, o)
            left join hd_v19_map m on a->>'field' = 'group_id' and m.gid::text = a->>'value'
            cross join lateral (
              select 1 as k, case when m.tid is not null then a || jsonb_build_object('field', 'tech_category_id', 'value', m.tid::text) else a end as e
              union all
              select 2, jsonb_build_object('field', 'tech_subcategory_id', 'value', m.sid::text) where m.tid is not null and m.sid is not null
            ) y)
        where jsonb_typeof(r.conditions) = 'array' and jsonb_typeof(r.actions) = 'array'
          and (r.conditions::text like '%group_id%' or r.actions::text like '%group_id%')`,
      // Vistas guardadas que filtraban por grupo: pasan a filtrar por categoría técnica; si algún grupo no tiene equivalente, se marcan
      `update custom_views v set name = left(v.name || ' (revisar: usaba grupo)', 80)
        where coalesce(v.filters->>'group', '') <> '' and v.name not like '%(revisar: usaba grupo)%'
          and exists (select 1 from unnest(string_to_array(v.filters->>'group', ',')) as u(gv)
            where not exists (select 1 from hd_v19_map m where m.gid::text = trim(u.gv) and m.tid is not null))`,
      `update custom_views v set filters = (v.filters - 'group') || coalesce((
          select jsonb_build_object('tech', string_agg(distinct m.tid::text, ','))
          from unnest(string_to_array(v.filters->>'group', ',')) as u(gv) join hd_v19_map m on m.gid::text = trim(u.gv) and m.tid is not null
          having count(*) > 0), '{}'::jsonb)
        where coalesce(v.filters->>'group', '') <> '' and coalesce(v.filters->>'tech', '') = ''`,
      `update custom_views v set filters = v.filters - 'group' where v.filters ? 'group'`,
      // Exclusiones de la respuesta automática de IA por grupo → por categoría técnica
      `update app_settings a set value = jsonb_set(a.value, '{exclusions,tech_ids}', coalesce((
          select jsonb_agg(distinct m.tid) from jsonb_array_elements_text(a.value->'exclusions'->'group_ids') as u(gv) join hd_v19_map m on m.gid::text = u.gv and m.tid is not null), '[]'::jsonb)), updated_at = now()
        where a.key = 'ai' and jsonb_typeof(a.value->'exclusions'->'group_ids') = 'array' and jsonb_array_length(a.value->'exclusions'->'group_ids') > 0`,
      'update tech_categories set group_id = null where group_id is not null',
    ],
  },
  {
    version: 13,
    name: 'v1.9.1 permiso para configurar proyectos',
    statements: [
      // Además del líder, supervisores y administradores: agentes con permiso para configurar cualquier proyecto
      'alter table users add column if not exists can_manage_projects boolean not null default false',
    ],
  },
  {
    version: 14,
    name: 'v1.9.5 kanban con tres estados',
    statements: [
      // Los proyectos con el flujo Kanban original (Pendiente → Seleccionado → En curso → Hecho, sin tocar) pasan a
      // Pendiente → En curso → Hecho: lo que estaba en "Seleccionado" vuelve a "Pendiente".
      `create temp table hd_v195_kanban on commit drop as
         select p.id as project_id,
           (select id from project_statuses where project_id=p.id and name='Pendiente' and kind='todo' order by id limit 1) as pend,
           (select id from project_statuses where project_id=p.id and name='Seleccionado' and kind='todo' order by id limit 1) as sel
         from projects p
         where (select array_agg(name order by sort, id) from project_statuses where project_id=p.id) = array['Pendiente','Seleccionado','En curso','Hecho']::text[]`,
      'update issues i set status_id=k.pend from hd_v195_kanban k where i.status_id=k.sel and k.pend is not null',
      'delete from project_statuses s using hd_v195_kanban k where s.id=k.sel and k.pend is not null',
      `update project_statuses s set sort=x.n from (
         select s2.id, row_number() over (partition by s2.project_id order by s2.sort, s2.id) - 1 as n
         from project_statuses s2 join hd_v195_kanban k on k.project_id=s2.project_id where k.pend is not null) x
       where s.id=x.id`,
    ],
  },
  {
    version: 15,
    name: 'v1.11 sistemas críticos',
    statements: [
      // Sistemas que se muestran en el Inicio y en el estado del portal. El estado lo informa un agente (no es automático).
      `create table if not exists critical_systems (
        id serial primary key,
        name text not null,
        description text not null default '',
        sort int not null default 0,
        public boolean not null default true,
        active boolean not null default true,
        tech_category_id int references tech_categories(id) on delete set null,
        state text not null default 'ok' check (state in ('ok','degraded','down','maint')),
        eta timestamptz,
        message text not null default '',
        since timestamptz,
        reported_by int references users(id) on delete set null,
        late_notified_at timestamptz,
        updated_at timestamptz not null default now(),
        updated_by int references users(id) on delete set null
      )`,
      'create unique index if not exists critical_systems_name_uq on critical_systems(lower(name))',
      // Tickets vinculados al problema en curso de cada sistema
      `create table if not exists critical_system_tickets (
        system_id int not null references critical_systems(id) on delete cascade,
        ticket_id int not null references tickets(id) on delete cascade,
        created_at timestamptz not null default now(),
        created_by int references users(id) on delete set null,
        primary key (system_id, ticket_id)
      )`,
      'create index if not exists critical_system_tickets_ticket_idx on critical_system_tickets(ticket_id)',
      // Historial: quién cambió el estado, a qué y con qué estimación
      `create table if not exists critical_system_log (
        id serial primary key,
        system_id int not null references critical_systems(id) on delete cascade,
        user_id int references users(id) on delete set null,
        state text not null,
        eta timestamptz,
        message text not null default '',
        tickets int not null default 0,
        created_at timestamptz not null default now()
      )`,
      'create index if not exists critical_system_log_sys_idx on critical_system_log(system_id, created_at desc)',
    ],
  },
  {
    version: 16,
    name: 'v1.12.1 área solicitante desde el área del contacto',
    statements: [
      // Otros nombres con que aparece el área en el directorio (ej. "Recursos Humanos" para RRHH)
      "alter table categories add column if not exists aliases text[] not null default '{}'",
    ],
  },
  {
    version: 17,
    name: 'v1.13.1 problema conocido en tickets nuevos',
    statements: [
      // Palabras para reconocer cada sistema crítico en el asunto o el texto de un ticket (ej. "crm")
      "alter table critical_systems add column if not exists keywords text[] not null default '{}'",
      // El ticket lo vinculó el sistema al crearse (no un agente)
      'alter table critical_system_tickets add column if not exists auto boolean not null default false',
    ],
  },
  {
    version: 18,
    name: 'v1.13.7 proyectos que se finalizan solos',
    statements: [
      // El sistema lo pasó a Finalizado porque todas sus tareas/etapas quedaron hechas (si se reabre una, vuelve a En curso)
      'alter table projects add column if not exists auto_done boolean not null default false',
    ],
  },
  {
    version: 19,
    name: 'v1.14 roadmap, calendario y explorador en Informes',
    statements: [
      // Fecha de fin con la que se planificó el proyecto (para mostrar el desvío en el roadmap)
      'alter table projects add column if not exists baseline_end date',
      'update projects set baseline_end = end_date where baseline_end is null and end_date is not null',
      `create table if not exists report_views (
        id serial primary key,
        owner_id int references users(id) on delete cascade,
        name text not null,
        shared boolean not null default false,
        config jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      'create index if not exists report_views_owner_idx on report_views(owner_id)',
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** SQL completo del esquema actual (para los respaldos). */
export function fullSchemaSql() {
  return MIGRATIONS.map((m) => `-- Migración ${m.version}: ${m.name}\n${m.statements.join(';\n')};`).join('\n\n');
}
