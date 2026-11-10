-- Шаг 5. CRM: источники лидов, лиды, воронки и этапы (настраивает администратор), сделки, задачи, встречи.

alter table clubs add column first_response_minutes int not null default 5 check (first_response_minutes between 1 and 1440);

create table lead_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null,
  name text not null,
  channel text not null default 'other', -- site, ads, messenger, phone, maps, walk_in, referral, other
  api_token_hash text unique,           -- для приёма заявок через API
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  purpose text not null default 'custom' check (purpose in ('new', 'renewal', 'former', 'billing_failed', 'churn_risk', 'churned', 'custom')),
  is_default_for_leads boolean not null default false,
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, name)
);
create unique index pipelines_one_default on pipelines (club_id) where is_default_for_leads;

create table pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name text not null,
  kind text not null default 'open' check (kind in ('open', 'won', 'lost')),
  sort int not null,
  created_at timestamptz not null default now()
);

create table opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  pipeline_id uuid not null references pipelines(id),
  stage_id uuid not null references pipeline_stages(id),
  owner_id uuid references users(id),
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  amount_expected_kop bigint,
  lost_reason text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index opp_board on opportunities (club_id, pipeline_id, status);

create table opportunity_stage_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  from_stage_id uuid references pipeline_stages(id),
  to_stage_id uuid not null references pipeline_stages(id),
  actor_id uuid references users(id),
  comment text,
  at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  source_id uuid references lead_sources(id),
  opportunity_id uuid references opportunities(id),
  campaign text,
  utm jsonb,
  comment text,
  external_event_id text,
  is_repeat boolean not null default false, -- повторное обращение уже известного клиента
  assigned_to uuid references users(id),
  first_response_due_at timestamptz not null,
  first_response_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index leads_external_uq on leads (tenant_id, source_id, external_event_id) where external_event_id is not null;

create table tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  assignee_id uuid references users(id),
  person_id uuid references persons(id),
  opportunity_id uuid references opportunities(id) on delete cascade,
  lead_id uuid references leads(id),
  kind text not null default 'call' check (kind in ('first_response', 'call', 'meeting', 'message', 'other')),
  title text not null,
  due_at timestamptz not null,
  done_at timestamptz,
  result text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index tasks_open on tasks (club_id, assignee_id, due_at) where done_at is null;

create table meetings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  opportunity_id uuid references opportunities(id) on delete cascade,
  person_id uuid not null references persons(id),
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'attended', 'no_show', 'cancelled')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Построчная защита
alter table lead_sources enable row level security;
create policy t_ls on lead_sources using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

alter table pipelines enable row level security;
create policy t_pl on pipelines using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));

alter table pipeline_stages enable row level security;
create policy t_ps on pipeline_stages using (tenant_id = app_tenant() and exists (select 1 from pipelines p where p.id = pipeline_id))
  with check (tenant_id = app_tenant());

do $$
declare t text;
begin
  foreach t in array array['opportunities', 'opportunity_stage_history', 'leads', 'tasks', 'meetings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Поиск источника по токену API до того, как известна сеть
create function auth_lead_source(p_token_hash text)
returns table (source_id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select id, tenant_id from lead_sources where api_token_hash = p_token_hash and is_active
$$;

-- Антидубли по всей сети: поиск клиента по телефону без ограничения клубом
create function find_person_by_contact(p_tenant uuid, p_normalized text)
returns table (person_id uuid, home_club_id uuid)
language sql stable security definer set search_path = public as $$
  select p.id, p.home_club_id from person_contacts c join persons p on p.id = c.person_id
  where c.tenant_id = p_tenant and c.normalized_value = p_normalized and p.merged_into_id is null
  order by p.created_at limit 1
$$;

-- Клиент другого клуба виден, если он обратился в ваш клуб (есть лид или сделка)
drop policy t_persons on persons;
create policy t_persons on persons
  using (tenant_id = app_tenant() and (app_club_visible(home_club_id)
         or exists (select 1 from leads l where l.person_id = persons.id)
         or exists (select 1 from opportunities o where o.person_id = persons.id)))
  with check (tenant_id = app_tenant());
