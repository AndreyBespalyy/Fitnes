-- Упрощённый управленческий отчёт о прибыли (список «20 новых возможностей», п. 19).
-- Площадь клуба — для выручки на квадратный метр. Сигналы собственнику — один раз на клуб и месяц.
create table club_finance_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  area_m2 numeric(10,1) check (area_m2 is null or area_m2 > 0),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
alter table club_finance_settings enable row level security;
create policy t_club_finance_settings on club_finance_settings using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

create table pnl_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  month date not null,
  kind text not null check (kind in ('costs_outpace', 'loss')),
  text text not null,
  task_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (club_id, month, kind)
);
alter table pnl_alerts enable row level security;
create policy t_pnl_alerts on pnl_alerts using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
