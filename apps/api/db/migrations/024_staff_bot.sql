-- Бот сотрудников в Telegram и утренняя сводка (список «20 новых возможностей», п. 7).
-- Один бот на сеть: токен хранится зашифрованным и в интерфейс не возвращается.
-- Сотрудник привязывает свой Telegram сам: в профиле получает ссылку с одноразовым кодом и нажимает «Старт» в боте.

create table staff_bot (
  tenant_id uuid primary key references tenants(id),
  token_enc text,
  bot_username text,
  enabled boolean not null default true,
  summary_enabled boolean not null default true,
  summary_hour int not null default 8 check (summary_hour between 5 and 12),
  last_update_id bigint,
  last_error text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table staff_telegram (
  user_id uuid primary key references users(id),
  tenant_id uuid not null references tenants(id),
  chat_id text not null,
  tg_name text,
  summary boolean not null default true,
  linked_at timestamptz not null default now()
);

create table staff_link_codes (
  code text primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  expires_at timestamptz not null
);

-- Журнал отправленных сводок: не больше одной в день каждому
create table morning_summaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  day date not null,
  body text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (user_id, day)
);

do $$
declare t text;
begin
  foreach t in array array['staff_bot', 'staff_telegram', 'staff_link_codes', 'morning_summaries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t, t);
  end loop;
end $$;
