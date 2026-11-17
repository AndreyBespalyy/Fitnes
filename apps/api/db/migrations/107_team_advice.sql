-- ИИ-помощник читает переписку в мессенджере сотрудников (просьба Андрея 17.11.2026): личные чаты, группы, чаты клуба и отделов.
-- Пачками (раз в несколько минут, когда в чате затихло) определяет тему переписки и даёт каждому участнику
-- короткие советы по его роли с кнопкой «Начать»: запустить бизнес-процесс, поставить задачу, назначить собрание.
-- Советы видит только тот участник чата, кому они адресованы (152-ФЗ: переписку не видят посторонние).

-- Итог разбора чата: тема и одна фраза сути. Видят только участники чата
create table team_chat_insights (
  chat_id uuid primary key references team_chats(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  topic text not null,                          -- код темы (complaint, new_client, equipment, ...) или other
  summary text,                                 -- суть одной фразой, без телефонов и почты
  person_id uuid references persons(id) on delete set null, -- клиент, о котором переписка (если нашли)
  engine text not null,                         -- ai (свой сервер), yandexgpt или rules
  upto timestamptz not null,                    -- до какого сообщения переписка учтена
  requested_at timestamptz,                     -- сотрудник нажал «Разобрать сейчас»
  analyzed_at timestamptz not null default now()
);

-- Советы: у каждого участника свои, по его роли. Кнопка «Начать» выполняет action
create table team_advice (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  chat_id uuid not null references team_chats(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  club_id uuid references clubs(id),
  topic text not null,
  body text not null check (length(body) <= 400),
  action jsonb not null,                        -- {type: process|task|assistant, ...}
  status text not null default 'new' check (status in ('new', 'started', 'dismissed', 'expired')),
  result jsonb,                                 -- что запущено: {label, tab, id}
  created_at timestamptz not null default now(),
  acted_at timestamptz
);
create index team_advice_user on team_advice (user_id, status);
create index team_advice_chat on team_advice (chat_id, user_id);

do $$ declare t text; begin
  foreach t in array array['team_chat_insights', 'team_advice'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t, t);
  end loop;
end $$;
