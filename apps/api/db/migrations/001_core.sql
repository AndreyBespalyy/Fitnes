-- Шаг 4. Ядро: сеть, клубы, модель продаж, роли, сотрудники, сессии, клиенты, аудит.
-- Изоляция: построчная защита (RLS) по сети (tenant_id) и по доступным клубам.

create type sales_model as enum ('term', 'subscription');

-- Контекст текущего запроса (заполняется приложением в каждой транзакции)
create function app_tenant() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
create function app_club_visible(c uuid) returns boolean language sql stable as $$
  select coalesce(current_setting('app.all_clubs', true), '') = 'on'
      or c::text = any(string_to_array(coalesce(current_setting('app.club_ids', true), ''), ','))
$$;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table clubs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  address text,
  timezone text not null default 'Europe/Moscow',
  sales_model sales_model not null,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table club_sales_model_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  old_model sales_model,
  new_model sales_model not null,
  apply_from text not null default 'next_period' check (apply_from in ('now', 'next_period')),
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create table roles (
  code text primary key,
  name text not null,
  permissions text[] not null,
  network_wide boolean not null default false,
  sort int not null default 0
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  login text not null,
  password_hash text not null,
  full_name text not null,
  phone text,
  status text not null default 'active' check (status in ('active', 'blocked')),
  must_change_password boolean not null default true,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_login_uq on users (lower(login));

create table user_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  role_code text not null references roles(code),
  club_id uuid references clubs(id), -- null = вся сеть
  active_from date not null default current_date,
  active_to date
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  device text,
  ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table approval_limits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  role_code text not null references roles(code),
  kind text not null check (kind in ('refund', 'discount', 'expense')),
  max_amount_kop bigint,
  max_percent numeric(5,2),
  unique (tenant_id, role_code, kind)
);

create table persons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  home_club_id uuid not null references clubs(id),
  full_name text not null,
  birth_date date,
  segment text not null, -- лид, новый, действующий, на продление, бывший, гость, подписчик ...
  merged_into_id uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table person_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  person_id uuid not null references persons(id) on delete cascade,
  type text not null check (type in ('phone', 'email', 'telegram', 'whatsapp')),
  value text not null,
  normalized_value text not null,
  is_primary boolean not null default false
);
create index person_contacts_norm on person_contacts (tenant_id, normalized_value);

create table audit_log (
  id bigserial primary key,
  tenant_id uuid not null,
  actor_id uuid,
  action text not null,
  object_type text not null,
  object_id text,
  before jsonb,
  after jsonb,
  ip text,
  at timestamptz not null default now()
);

-- Построчная защита
alter table tenants enable row level security;
create policy t_tenant on tenants using (id = app_tenant());

alter table clubs enable row level security;
create policy t_clubs on clubs using (tenant_id = app_tenant() and app_club_visible(id))
  with check (tenant_id = app_tenant());

alter table club_sales_model_history enable row level security;
create policy t_csmh on club_sales_model_history using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant());

alter table users enable row level security;
create policy t_users on users using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

alter table user_assignments enable row level security;
create policy t_ua on user_assignments using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

alter table sessions enable row level security;
create policy t_sessions on sessions using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

alter table approval_limits enable row level security;
create policy t_al on approval_limits using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

alter table persons enable row level security;
create policy t_persons on persons using (tenant_id = app_tenant() and app_club_visible(home_club_id))
  with check (tenant_id = app_tenant() and app_club_visible(home_club_id));

alter table person_contacts enable row level security;
create policy t_pc on person_contacts
  using (tenant_id = app_tenant() and exists (select 1 from persons p where p.id = person_id))
  with check (tenant_id = app_tenant());

alter table audit_log enable row level security;
create policy t_audit_read on audit_log for select using (tenant_id = app_tenant());
create policy t_audit_ins on audit_log for insert with check (tenant_id = app_tenant());

-- Функции входа: работают до того, как известна сеть пользователя (владелец схемы обходит RLS)
create function auth_find_user(p_login text)
returns table (id uuid, tenant_id uuid, password_hash text, status text, must_change_password boolean,
               failed_attempts int, locked_until timestamptz)
language sql stable security definer set search_path = public as $$
  select id, tenant_id, password_hash, status, must_change_password, failed_attempts, locked_until
  from users where lower(login) = lower(p_login)
$$;

create function auth_session(p_token_hash text)
returns table (session_id uuid, user_id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, s.tenant_id
  from sessions s join users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now() and u.status = 'active'
$$;
