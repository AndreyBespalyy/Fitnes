-- ИИ-агент, этап 3 (выбор Андрея 14.11.2026, 3В): переписка с «ИИ-помощником» в корпоративном мессенджере.
-- Помощник — служебный пользователь сети: войти под ним нельзя (заблокирован, пароля нет), в списках сотрудников его не видно.
alter table users add column is_bot boolean not null default false;
create unique index users_one_bot on users (tenant_id) where is_bot;

-- Последний список задач, который помощник показал сотруднику: «перенеси 2 на завтра» — это вторая задача из списка
create table agent_chat_state (
  user_id uuid primary key references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  task_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table agent_chat_state enable row level security;
create policy t_agent_chat_state on agent_chat_state using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
