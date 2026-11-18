-- Свой модуль переписки с клиентами (решение Андрея 18.11.2026): без сторонних сервисов-посредников.
--  tg_user  — Telegram-аккаунт клуба: CRM входит в него по коду из Telegram, как обычное приложение, и может писать клиенту первым по номеру.
--  wa_cloud — официальный канал WhatsApp для бизнеса (WhatsApp Cloud API) напрямую, без посредника.
-- Вся переписка хранится в CRM; ИИ разбирает её так же, как записи звонков, итог попадает в «Коротко о ситуации».

alter table msg_channels drop constraint if exists msg_channels_kind_check;
alter table msg_channels add constraint msg_channels_kind_check check (kind in ('telegram_bot', 'green_api', 'wazzup', 'test', 'tg_user', 'wa_cloud'));

-- Разбор переписки ИИ: один итог на «эпизод» переписки (сообщения после прошлого итога, когда в чате затихло)
create table msg_chat_summaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  conversation_id uuid not null references msg_conversations(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  from_at timestamptz not null,               -- первое сообщение эпизода
  upto timestamptz not null,                  -- последнее учтённое сообщение
  messages int not null,
  summary jsonb,                              -- как у звонков: essence, need, objections, agreements, outcome, nextStep
  engine text,
  status text not null check (status in ('done', 'empty', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index msg_chat_summaries_conv on msg_chat_summaries (conversation_id, upto desc);
create index msg_chat_summaries_person on msg_chat_summaries (person_id, upto desc);
alter table msg_chat_summaries enable row level security;
create policy t_msg_chat_summaries on msg_chat_summaries using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));
