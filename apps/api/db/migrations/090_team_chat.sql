-- Корпоративный мессенджер сотрудников внутри CRM (решение Андрея 12.11.2026: вся рабочая связь — в CRM, не в Telegram).
-- Личные чаты, группы, общий чат клуба и чаты отделов (заполняются сами по ролям), объявления с отметкой «прочитано»,
-- вложения, отдельное приложение-мессенджер для телефона и ссылки-приглашения с инструкцией по установке.

create table team_chats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('direct', 'group', 'club', 'dept')),
  title text,                                   -- для личного чата пусто: показываем имя собеседника
  club_id uuid references clubs(id),            -- общий чат клуба и чаты отделов
  dept text check (dept in ('sales', 'desk', 'trainers', 'managers')),
  direct_key text,                              -- личный чат: «меньший id:больший id», чтобы не было двух чатов на пару
  only_admins_post boolean not null default false, -- канал объявлений: пишут только руководители чата
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  archived_at timestamptz,
  check ((kind = 'direct') = (direct_key is not null)),
  check (kind not in ('club', 'dept') or club_id is not null),
  check ((kind = 'dept') = (dept is not null))
);
create unique index team_chats_direct on team_chats (tenant_id, direct_key) where direct_key is not null;
create unique index team_chats_club on team_chats (club_id) where kind = 'club';
create unique index team_chats_dept on team_chats (club_id, dept) where kind = 'dept';

create table team_members (
  chat_id uuid not null references team_chats(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  is_admin boolean not null default false,
  auto boolean not null default false,          -- добавлен автоматически по роли (общий чат клуба, отдел)
  muted boolean not null default false,         -- без push; объявления всё равно приходят
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index team_members_user on team_members (user_id);

create table team_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  chat_id uuid not null references team_chats(id) on delete cascade,
  name text not null,
  mime text not null,
  size_bytes int not null,
  storage_path text not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table team_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  chat_id uuid not null references team_chats(id) on delete cascade,
  user_id uuid references users(id),            -- пусто — служебное сообщение («Иван добавил Олега»)
  body text not null default '' check (length(body) <= 4000),
  important boolean not null default false,     -- объявление: push даже в заглушённом чате, видно, кто прочитал
  reply_to uuid references team_messages(id) on delete set null,
  file_id uuid references team_files(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index team_messages_chat on team_messages (chat_id, created_at desc);

-- Подписки на push именно приложения-мессенджера (отдельно от приложения CRM, чтобы туда не приходили лиды и задачи)
create table team_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  failures int not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index team_push_subscriptions_user on team_push_subscriptions (user_id);

-- Что уже прислано push: одно уведомление на чат за 2 минуты (и каждое объявление отдельно)
create table team_push_log (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  ref text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, ref)
);

-- Кто поставил приложение-мессенджер на телефон (видно управляющему)
create table team_app_installs (
  user_id uuid primary key references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  platform text not null default 'other' check (platform in ('ios', 'android', 'desktop', 'other')),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);

-- Ссылки-приглашения: управляющий отправляет сотруднику ссылку со страницей-инструкцией по установке
create table team_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  token_hash text not null unique,
  token text not null,                          -- нужен, чтобы управляющий мог скопировать ссылку ещё раз
  club_id uuid references clubs(id),
  user_id uuid references users(id) on delete cascade, -- кому; пусто — общая ссылка для всех сотрудников клуба
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  opened_at timestamptz,
  open_count int not null default 0,
  revoked_at timestamptz
);
create index team_invites_user on team_invites (user_id);

do $$ declare t text; begin
  foreach t in array array['team_chats', 'team_members', 'team_files', 'team_messages', 'team_push_subscriptions', 'team_push_log', 'team_app_installs', 'team_invites'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t, t);
  end loop;
end $$;

-- Страница-инструкция открывается без входа: по ссылке находим только имя, логин, клуб и кто пригласил
create function team_invite_open(p_hash text) returns table (tenant_id uuid, full_name text, login text, club_name text, inviter text)
language plpgsql security definer set search_path = public as $$
begin
  update team_invites i set opened_at = coalesce(i.opened_at, now()), open_count = i.open_count + 1
   where i.token_hash = p_hash and i.revoked_at is null and i.expires_at > now();
  return query
    select i.tenant_id, u.full_name, u.login, c.name, b.full_name
      from team_invites i left join users u on u.id = i.user_id and u.status = 'active'
      left join clubs c on c.id = i.club_id left join users b on b.id = i.created_by
     where i.token_hash = p_hash and i.revoked_at is null and i.expires_at > now();
end $$;
revoke all on function team_invite_open(text) from public;
