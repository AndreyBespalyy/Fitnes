-- Шаг 16. Мобильное рабочее место (FR-MOB): push-уведомления, устройства и удалённое завершение сеансов.

-- Ключи VAPID для web push. Создаются сервером автоматически при первом запуске, если не заданы в .env.
-- Закрытый ключ не возвращается ни в один ответ API.
create table push_config (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_pem text not null,
  created_at timestamptz not null default now()
);

-- Подписка телефона или браузера на уведомления. Привязана к сеансу: завершили сеанс — уведомления на это устройство прекращаются.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  failures int not null default 0,
  last_ok_at timestamptz,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user on push_subscriptions (user_id);

-- Что присылать: задачи (напоминание за 10 минут), новые лиды, входящие сообщения
create table user_prefs (
  user_id uuid primary key references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  push_tasks boolean not null default true,
  push_leads boolean not null default true,
  push_messages boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Журнал отправленных уведомлений: чтобы одно событие не приходило дважды
create table push_log (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  ref text not null,
  kind text not null,
  title text not null,
  delivered int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, ref)
);

-- Когда устройство последний раз обращалось к системе
alter table sessions add column last_seen_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'user_prefs', 'push_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t, t);
  end loop;
end $$;
