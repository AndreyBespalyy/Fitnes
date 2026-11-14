-- ИИ-агент, этап 6 (выбор Андрея 14.11.2026, 6АБ): бизнес-процессы.
-- Шаблон процесса — цепочка шагов (что сделать, какая роль, за сколько часов). Готовые шаблоны + конструктор + «опиши словами».
-- Запущенный процесс ведёт агент: шаг становится задачей исполнителя, выполнен — запускается следующий,
-- просрочки идут по лестнице эскалации (это обычные задачи), выход процесса за срок — карточка ответственному.
create table process_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 1 and 200),
  description text not null default '',
  steps jsonb not null,                           -- [{title, role, hours}]
  builtin text,                                   -- код готового шаблона (new_client, renewal, ...) или null — свой
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index process_templates_builtin on process_templates (tenant_id, builtin) where builtin is not null;

create table processes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  template_id uuid references process_templates(id) on delete set null,
  title text not null,
  note text not null default '',
  person_id uuid references persons(id),
  owner_id uuid references users(id),            -- ответственный за процесс целиком
  status text not null default 'active' check (status in ('active', 'done', 'cancelled')),
  started_at timestamptz not null default now(),
  due_at timestamptz not null,
  finished_at timestamptz,
  created_by uuid references users(id)
);
create index processes_active on processes (club_id, status);

create table process_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  process_id uuid not null references processes(id) on delete cascade,
  ord int not null,
  title text not null,
  role text not null,
  hours numeric not null check (hours > 0),
  status text not null default 'pending' check (status in ('pending', 'active', 'done', 'skipped')),
  assignee_id uuid references users(id),
  task_id uuid references tasks(id) on delete set null,
  started_at timestamptz,
  due_at timestamptz,
  done_at timestamptz,
  unique (process_id, ord)
);

alter table process_templates enable row level security;
create policy t_process_templates on process_templates using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table processes enable row level security;
create policy t_processes on processes using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
alter table process_steps enable row level security;
create policy t_process_steps on process_steps using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
