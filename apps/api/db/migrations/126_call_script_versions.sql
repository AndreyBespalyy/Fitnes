-- Один стандарт звонка — скрипт (повторная проверка CRM 18.11.2026, п. 6).
-- У скриптов появляются версии, как раньше у чек-листа: каждое сохранение — новая версия, разбор звонка помнит, по какой версии проверяли.
create table club_call_script_versions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  code text not null,
  tenant_id uuid not null references tenants(id),
  version_no int not null,
  data jsonb,                           -- null — вернули стандартный текст
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (club_id, code, version_no)
);
alter table club_call_script_versions enable row level security;
create policy t_club_call_script_versions on club_call_script_versions
  using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));
grant select, insert on club_call_script_versions to fitnes_app;

alter table call_script_checks add column script_version int not null default 0;
