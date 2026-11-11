-- «Сообщить о проблеме» и статистика использования (список «20 улучшений», п. 15).

-- Обращение из любого экрана: технические сведения без данных клиентов (последние ошибки и сбои запросов, версия, экран)
alter table support_tickets add column tech_log jsonb, add column app_version text;

-- Сколько раз сотрудник открывал раздел за день: какие разделы нужны, а какие никто не открывает
create table usage_daily (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  day date not null,
  tab text not null,
  label text,
  opens integer not null default 0,
  primary key (user_id, day, tab)
);
create index usage_daily_tenant on usage_daily (tenant_id, day);
alter table usage_daily enable row level security;
create policy t_usage_daily on usage_daily using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
