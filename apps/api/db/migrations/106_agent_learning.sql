-- ИИ-помощник учится на отзывах (просьба Андрея 17.11.2026: «чтобы ИИ-помощник обучался и совершенствовался»).
-- Каждая подсказка, карточка и ответ помощника записываются сюда. Сотрудник оценивает их («Полезно» / «Не то» с причиной),
-- а система сама смотрит, чем кончилось: задача закрыта, клиенту позвонили или написали, была продажа — или подсказку проигнорировали.
-- По этим данным помощник чаще показывает то, что помогает, реже — то, что игнорируют, и берёт удачные ответы за образец.
create table agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid references clubs(id),
  user_id uuid not null references users(id) on delete cascade,
  role text,                                    -- роль сотрудника, которому показана подсказка
  source text not null check (source in ('morning', 'card', 'chat', 'advice')),
  kind text not null,                           -- тип подсказки: overdue_tasks, hot_calls, card:agent_task, chat:tasks, msg_complaint …
  body text not null check (length(body) <= 4000),
  question text check (length(question) <= 1000),  -- для ответов в чате: что спросил сотрудник
  targets jsonb not null default '{}',          -- по чему проверять результат: taskIds, personIds, leadIds, conversationIds, opportunityIds
  message_id uuid,                              -- сообщение помощника в мессенджере
  notification_id uuid,                         -- карточка в колокольчике
  rating smallint check (rating in (-1, 1)),
  reason text check (reason in ('done_already', 'not_relevant', 'wrong_data', 'unclear', 'not_mine', 'other')),
  comment text check (length(comment) <= 500),
  rated_at timestamptz,
  outcome text check (outcome in ('done', 'sale', 'ignored')),
  outcome_note text,
  outcome_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_suggestions_learn on agent_suggestions (tenant_id, kind, created_at);
create index agent_suggestions_user on agent_suggestions (user_id, created_at desc);
create index agent_suggestions_open on agent_suggestions (created_at) where outcome is null;
create index agent_suggestions_note on agent_suggestions (notification_id) where notification_id is not null;
alter table agent_suggestions enable row level security;
create policy t_agent_suggestions on agent_suggestions
  using (tenant_id = app_tenant() and (club_id is null or app_club_visible(club_id)))
  with check (tenant_id = app_tenant() and (club_id is null or app_club_visible(club_id)));

-- Ручные решения руководителя по типу подсказки для роли в клубе: «Авто» (как решит помощник), «Чаще», «Не показывать»
create table agent_kind_rules (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  role text not null,
  kind text not null,
  mode text not null check (mode in ('boost', 'off')),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (club_id, role, kind)
);
alter table agent_kind_rules enable row level security;
create policy t_agent_kind_rules on agent_kind_rules
  using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));

alter table agent_settings add column learning boolean not null default true;   -- учиться на отзывах (можно выключить)
