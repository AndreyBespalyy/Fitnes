-- Шаг 10. Переписка с клиентами в Telegram и WhatsApp: каналы клуба, диалоги, сообщения,
-- шаблоны, автосообщения (триггеры), согласия и отписка. Телефония подключается позже.

create table msg_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null check (kind in ('telegram_bot', 'green_api', 'wazzup', 'test')),
  messenger text not null check (messenger in ('telegram', 'whatsapp')),
  name text not null,
  settings jsonb not null default '{}',   -- открытые параметры: имя бота, номер инстанса, канал Wazzup
  secret_enc text,                         -- токен или ключ API в зашифрованном виде
  webhook_token text not null,             -- случайная часть адреса для входящих от провайдера
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_error text,
  last_ok_at timestamptz,
  poll_offset bigint,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table msg_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  channel_id uuid not null references msg_channels(id),
  person_id uuid references persons(id),
  external_chat_id text not null,          -- id чата в Telegram или номер WhatsApp
  title text not null,                     -- как клиент подписан в мессенджере
  assigned_to uuid references users(id),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_autoreply_at timestamptz,
  unread int not null default 0,
  created_at timestamptz not null default now(),
  unique (channel_id, external_chat_id)
);
create index msg_conv_person on msg_conversations (person_id);
create index msg_conv_club on msg_conversations (club_id, last_message_at desc);

create table msg_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  body text not null check (length(body) between 1 and 2000),
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table msg_triggers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  event text not null check (event in ('membership_ending', 'debt_overdue', 'inactive', 'birthday', 'welcome')),
  days int not null default 0 check (days between 0 and 365),
  template_id uuid not null references msg_templates(id),
  marketing boolean not null default false, -- рекламное: только клиентам с согласием на рассылки
  enabled boolean not null default false,
  send_hour int not null default 11 check (send_hour between 0 and 23),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (club_id, event)
);

create table msg_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  conversation_id uuid not null references msg_conversations(id),
  direction text not null check (direction in ('in', 'out')),
  body text not null,
  status text not null check (status in ('received', 'queued', 'sent', 'failed')),
  error text,
  external_id text,
  author_id uuid references users(id),     -- null: клиент, автоответ или автосообщение
  template_id uuid references msg_templates(id),
  trigger_id uuid references msg_triggers(id),
  auto boolean not null default false,
  attempts int not null default 0,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index msg_messages_conv on msg_messages (conversation_id, created_at);
create unique index msg_messages_ext on msg_messages (conversation_id, direction, external_id) where external_id is not null;
create index msg_messages_due on msg_messages (next_attempt_at) where status = 'queued';

create table msg_trigger_sends (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  trigger_id uuid not null references msg_triggers(id),
  person_id uuid not null references persons(id),
  period_key text not null,                -- за что отправлено: абонемент, начисление, год — второй раз не отправляется
  message_id uuid references msg_messages(id),
  created_at timestamptz not null default now(),
  unique (trigger_id, person_id, period_key)
);

create table club_msg_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  work_from int not null default 9 check (work_from between 0 and 23),
  work_to int not null default 21 check (work_to between 1 and 24),
  autoreply_enabled boolean not null default true,
  autoreply_text text not null default 'Здравствуйте! Мы получили ваше сообщение. Сейчас клуб не работает, менеджер ответит утром.',
  max_auto_per_week int not null default 2 check (max_auto_per_week between 0 and 14),
  updated_at timestamptz not null default now()
);

alter table persons add column marketing_consent boolean not null default false;
alter table persons add column messaging_opt_out boolean not null default false;
alter table persons add column messaging_changed_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['msg_channels', 'msg_conversations', 'msg_templates', 'msg_triggers', 'msg_messages', 'msg_trigger_sends', 'club_msg_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Для фоновой работы без пользователя: какие сети обрабатывать и чей канал пришёл во входящем запросе
create function msg_tenants() returns table (tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select distinct tenant_id from msg_channels where status = 'active'
$$;
create function msg_channel_by_token(p_channel uuid, p_token text) returns table (tenant_id uuid, club_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, club_id from msg_channels where id = p_channel and webhook_token = p_token and status = 'active'
$$;
