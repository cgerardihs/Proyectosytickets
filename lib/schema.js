// Esquema base (v1.0 a v1.4). Idempotente: es la migración 5 del registro de lib/migrations.js.
// No se modifica más: los cambios nuevos van como migraciones numeradas.

export const SCHEMA = `
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id serial primary key,
  name text not null,
  email text not null unique,
  password_hash text,
  role text not null default 'agent' check (role in ('superadmin','admin','supervisor','agent')),
  active boolean not null default true,
  color text,
  signature_html text not null default '',
  must_change_password boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists agent_groups (
  id serial primary key,
  name text not null unique,
  description text not null default '',
  round_robin boolean not null default false,
  rr_last_user_id int,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists group_members (
  group_id int not null references agent_groups(id) on delete cascade,
  user_id int not null references users(id) on delete cascade,
  primary key (group_id, user_id)
);

create table if not exists categories (
  id serial primary key,
  name text not null unique,
  description text not null default '',
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists tech_categories (
  id serial primary key,
  group_id int references agent_groups(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists ticket_types (
  id serial primary key,
  name text not null unique,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists statuses (
  id serial primary key,
  name text not null unique,
  kind text not null check (kind in ('open','pending','resolved','closed')),
  color text not null default '#64748b',
  pauses_sla boolean not null default false,
  is_default boolean not null default false,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists sla_policies (
  id serial primary key,
  name text not null unique,
  is_default boolean not null default false,
  no_sla boolean not null default false,
  business_hours boolean not null default true,
  targets jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists companies (
  id serial primary key,
  name text not null unique,
  domain text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists contacts (
  id serial primary key,
  name text not null,
  email text not null unique,
  phone text not null default '',
  company_id int references companies(id) on delete set null,
  area text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create sequence if not exists ticket_number_seq start 1;

create table if not exists tickets (
  id serial primary key,
  number int not null unique default nextval('ticket_number_seq'),
  subject text not null,
  channel text not null default 'agent',
  contact_id int references contacts(id) on delete set null,
  status_id int references statuses(id),
  priority smallint not null default 1,
  group_id int references agent_groups(id) on delete set null,
  tech_category_id int references tech_categories(id) on delete set null,
  type_id int references ticket_types(id) on delete set null,
  category_id int references categories(id) on delete set null,
  assignee_id int references users(id) on delete set null,
  sla_id int references sla_policies(id) on delete set null,
  first_response_due timestamptz,
  resolution_due timestamptz,
  first_responded_at timestamptz,
  sla_paused_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  spam boolean not null default false,
  deleted_at timestamptz,
  cc text[] not null default '{}',
  tags text[] not null default '{}',
  custom jsonb not null default '{}'::jsonb,
  merged_into int,
  created_by int references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
create index if not exists tickets_status_idx on tickets(status_id);
create index if not exists tickets_assignee_idx on tickets(assignee_id);
create index if not exists tickets_group_idx on tickets(group_id);
create index if not exists tickets_created_idx on tickets(created_at desc);
create index if not exists tickets_contact_idx on tickets(contact_id);

create table if not exists ticket_messages (
  id serial primary key,
  ticket_id int not null references tickets(id) on delete cascade,
  kind text not null check (kind in ('customer','reply','note','forward','system')),
  author_user_id int references users(id) on delete set null,
  author_contact_id int references contacts(id) on delete set null,
  from_email text not null default '',
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  body_html text not null default '',
  message_id text,
  created_at timestamptz not null default now()
);
create index if not exists ticket_messages_ticket_idx on ticket_messages(ticket_id);
create index if not exists ticket_messages_msgid_idx on ticket_messages(message_id);

create table if not exists attachments (
  id serial primary key,
  ticket_message_id int references ticket_messages(id) on delete cascade,
  issue_id int,
  issue_comment_id int,
  filename text not null,
  content_type text not null default 'application/octet-stream',
  size int not null default 0,
  data_b64 text not null,
  uploaded_by int references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_msg_idx on attachments(ticket_message_id);
create index if not exists attachments_issue_idx on attachments(issue_id);

create table if not exists ticket_followers (
  ticket_id int not null references tickets(id) on delete cascade,
  user_id int not null references users(id) on delete cascade,
  primary key (ticket_id, user_id)
);

create table if not exists ticket_activities (
  id serial primary key,
  ticket_id int not null references tickets(id) on delete cascade,
  user_id int references users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ticket_activities_ticket_idx on ticket_activities(ticket_id);

create table if not exists time_entries (
  id serial primary key,
  ticket_id int references tickets(id) on delete cascade,
  issue_id int,
  user_id int references users(id) on delete set null,
  minutes int not null check (minutes > 0),
  note text not null default '',
  spent_on date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists canned_responses (
  id serial primary key,
  title text not null,
  folder text not null default 'General',
  body_html text not null default '',
  owner_id int references users(id) on delete set null,
  shared boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists custom_views (
  id serial primary key,
  name text not null,
  owner_id int references users(id) on delete cascade,
  shared boolean not null default false,
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id serial primary key,
  user_id int not null references users(id) on delete cascade,
  title text not null,
  body text not null default '',
  link text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(user_id, created_at desc);

create table if not exists automation_rules (
  id serial primary key,
  name text not null,
  event text not null default 'ticket_created',
  match text not null default 'all' check (match in ('all','any')),
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  stop boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists kb_categories (
  id serial primary key,
  name text not null unique,
  description text not null default '',
  visibility text not null default 'public' check (visibility in ('public','internal')),
  sort int not null default 0
);

create table if not exists kb_articles (
  id serial primary key,
  category_id int references kb_categories(id) on delete set null,
  title text not null,
  body_html text not null default '',
  status text not null default 'draft' check (status in ('draft','published')),
  views int not null default 0,
  author_id int references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists projects (
  id serial primary key,
  key text not null unique,
  name text not null,
  description text not null default '',
  lead_id int references users(id) on delete set null,
  color text not null default '#C41230',
  archived boolean not null default false,
  issue_seq int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists project_statuses (
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('todo','doing','done')),
  sort int not null default 0,
  wip_limit int
);

create table if not exists project_members (
  project_id int not null references projects(id) on delete cascade,
  user_id int not null references users(id) on delete cascade,
  primary key (project_id, user_id)
);

create table if not exists sprints (
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  name text not null,
  goal text not null default '',
  state text not null default 'planned' check (state in ('planned','active','closed')),
  start_date date,
  end_date date,
  completed_at timestamptz,
  committed_points numeric,
  completed_points numeric,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists issues (
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  number int not null,
  key text not null unique,
  type text not null default 'task' check (type in ('epic','story','task','bug','subtask')),
  title text not null,
  description_html text not null default '',
  status_id int references project_statuses(id) on delete set null,
  priority smallint not null default 2,
  assignee_id int references users(id) on delete set null,
  reporter_id int references users(id) on delete set null,
  parent_id int references issues(id) on delete set null,
  sprint_id int references sprints(id) on delete set null,
  story_points numeric,
  estimate_minutes int,
  labels text[] not null default '{}',
  start_date date,
  due_date date,
  rank double precision not null default 0,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index if not exists issues_project_idx on issues(project_id);
create index if not exists issues_sprint_idx on issues(sprint_id);
create index if not exists issues_parent_idx on issues(parent_id);
create index if not exists issues_assignee_idx on issues(assignee_id);

create table if not exists issue_comments (
  id serial primary key,
  issue_id int not null references issues(id) on delete cascade,
  user_id int references users(id) on delete set null,
  body_html text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists issue_links (
  id serial primary key,
  from_issue_id int not null references issues(id) on delete cascade,
  to_issue_id int not null references issues(id) on delete cascade,
  kind text not null check (kind in ('blocks','relates','duplicates')),
  unique (from_issue_id, to_issue_id, kind)
);

create table if not exists issue_activities (
  id serial primary key,
  issue_id int not null references issues(id) on delete cascade,
  user_id int references users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists issue_activities_issue_idx on issue_activities(issue_id);

create table if not exists ticket_issue_links (
  ticket_id int not null references tickets(id) on delete cascade,
  issue_id int not null references issues(id) on delete cascade,
  primary key (ticket_id, issue_id)
);

-- v2: rol superadmin y registro de auditoría
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('superadmin','admin','supervisor','agent'));

create table if not exists audit_log (
  id bigserial primary key,
  user_id int references users(id) on delete set null,
  actor text not null default '',
  action text not null,
  path text not null default '',
  details jsonb not null default '{}'::jsonb,
  ip text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log(created_at desc);
create index if not exists audit_log_action_idx on audit_log(action, created_at desc);

-- v3: tickets convertidos en proyectos de desarrollo
create table if not exists ticket_projects (
  ticket_id int not null references tickets(id) on delete cascade,
  project_id int not null references projects(id) on delete cascade,
  created_by int references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (ticket_id, project_id)
);
create index if not exists ticket_projects_project_idx on ticket_projects(project_id);

-- v4: último estado/fase conocidos para disparar reglas solo en transiciones
alter table ticket_projects add column if not exists last_state text;
alter table ticket_projects add column if not exists last_phase text;

-- v5: tablero por antigüedad, IA y Microsoft 365
alter table contacts add column if not exists vip boolean not null default false;
alter table contacts add column if not exists job_title text not null default '';
alter table contacts add column if not exists manager text not null default '';
alter table contacts add column if not exists active boolean not null default true;
alter table contacts add column if not exists external_id text;
alter table users add column if not exists external_id text;
alter table tickets add column if not exists ai jsonb not null default '{}'::jsonb;
alter table ticket_messages add column if not exists meta jsonb not null default '{}'::jsonb;
alter table attachments add column if not exists storage text not null default 'db';
alter table attachments add column if not exists external_ref jsonb;
alter table attachments alter column data_b64 drop not null;

create table if not exists ai_rules (
  id serial primary key,
  name text not null,
  keywords text[] not null default '{}',
  category_ids int[] not null default '{}',
  tech_category_ids int[] not null default '{}',
  guide text not null default '',
  kb_article_ids int[] not null default '{}',
  mode text not null default 'guide_ai' check (mode in ('fixed','guide_ai','ai')),
  on_confirm text not null default 'resolve' check (on_confirm in ('resolve','keep_open')),
  active boolean not null default true,
  sort int not null default 0,
  hits int not null default 0,
  deflected int not null default 0,
  confirmed int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists ai_usage (
  id bigserial primary key,
  feature text not null,
  provider text not null default '',
  model text not null default '',
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  ok boolean not null default true,
  error text not null default '',
  ip text not null default '',
  user_id int references users(id) on delete set null,
  ticket_id int references tickets(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_created_idx on ai_usage(created_at desc);

create table if not exists ai_deflections (
  id bigserial primary key,
  rule_id int references ai_rules(id) on delete set null,
  email text not null default '',
  subject text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists m365_log (
  id bigserial primary key,
  module text not null,
  level text not null default 'info',
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists m365_log_created_idx on m365_log(created_at desc);
`;
