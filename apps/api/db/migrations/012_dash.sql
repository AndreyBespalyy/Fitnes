-- Шаг 13. План продаж по клубу и менеджерам, нормы KPI, рабочие столы (виджеты).

-- План на месяц: user_id = null — план клуба (отдела), иначе личный план менеджера.
-- В деньгах и в клиентах: количество клиентов = сумма / плановый средний чек.
create table plan_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  month date not null check (extract(day from month) = 1),
  user_id uuid references users(id),
  category text not null check (category in ('new', 'renewal', 'return', 'subscription')),
  amount_kop bigint not null check (amount_kop >= 0),
  avg_check_kop bigint check (avg_check_kop > 0),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create unique index plan_targets_uq on plan_targets (club_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), category);

insert into plan_targets(tenant_id, club_id, month, user_id, category, amount_kop, updated_by, updated_at)
  select tenant_id, club_id, month, null, category, amount_kop, updated_by, updated_at from sales_plans;
drop table sales_plans;

-- Нормы KPI клуба на один рабочий день сотрудника
create table kpi_norms (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  metric text not null,
  per_day numeric not null check (per_day >= 0),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (club_id, metric)
);

-- Рабочий стол: свой у пользователя или стандартный для роли (задаёт руководитель)
create table dash_layouts (
  user_id uuid primary key references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  widgets text[] not null,
  updated_at timestamptz not null default now()
);
create table dash_role_layouts (
  tenant_id uuid not null references tenants(id),
  role_code text not null references roles(code),
  widgets text[] not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, role_code)
);

alter table plan_targets enable row level security;
create policy t_plan_targets on plan_targets using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
alter table kpi_norms enable row level security;
create policy t_kpi_norms on kpi_norms using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
alter table dash_layouts enable row level security;
create policy t_dash_layouts on dash_layouts using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table dash_role_layouts enable row level security;
create policy t_dash_role_layouts on dash_role_layouts using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create index memberships_seller on memberships (created_by, created_at);
create index leads_club_time on leads (club_id, created_at);
create index meetings_person on meetings (person_id, created_at);
