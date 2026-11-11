-- Конструктор правил «если — то» (список «20 новых возможностей», п. 20).
-- Правила клуба — часть версий настроек: меняются только через черновик, проверку на истории и утверждение.
create table club_rules (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  rules jsonb not null default '[]',
  config_version_id uuid,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
alter table club_rules enable row level security;
create policy t_club_rules on club_rules using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Запуск правила для клиента: цепочка шагов с задержками, может остановиться, если клиент пришёл или купил
create table rule_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  rule_id text not null,
  rule_name text not null,
  person_id uuid not null references persons(id),
  status text not null default 'active' check (status in ('active', 'done', 'stopped')),
  stop_reason text,
  next_step integer not null default 0,
  next_due_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index rule_runs_one_active on rule_runs (club_id, rule_id, person_id) where status = 'active';
create index rule_runs_due on rule_runs (club_id, next_due_at) where status = 'active';
create index rule_runs_person on rule_runs (person_id, rule_id, started_at desc);
alter table rule_runs enable row level security;
create policy t_rule_runs on rule_runs using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Что сделал каждый шаг: для журнала и для лимита автосообщений в неделю
create table rule_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  run_id uuid not null references rule_runs(id),
  person_id uuid not null references persons(id),
  step integer not null,
  action text not null check (action in ('message', 'task', 'points')),
  result text not null check (result in ('done', 'skipped')),
  details text,
  ref_id uuid,
  created_at timestamptz not null default now()
);
create index rule_actions_person on rule_actions (person_id, club_id, created_at desc);
alter table rule_actions enable row level security;
create policy t_rule_actions on rule_actions using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
