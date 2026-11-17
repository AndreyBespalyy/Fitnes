-- Статистика сотрудников за сутки для собственника (17.11.2026): какие разделы и когда открывал сотрудник.
-- usage_daily хранит только счётчики за день; здесь — каждое открытие со временем. Хранится 30 дней.
create table usage_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  at timestamptz not null default now(),
  tab text not null,
  label text
);
create index usage_events_at on usage_events (tenant_id, at);
create index usage_events_user on usage_events (user_id, at);
alter table usage_events enable row level security;
create policy t_usage_events on usage_events using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
