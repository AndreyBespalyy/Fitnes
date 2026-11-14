-- ИИ-агент управления процессами (выбор Андрея 14.11.2026). Этап 1: «Коротко о ситуации» по задаче и сделке.
-- Агент собирает всё, что известно о ситуации: задачи и их результаты, этапы сделки, звонки (итоги и расшифровки),
-- переписку с клиентом, обсуждения в корпоративном мессенджере, абонементы, долги, посещения и свои наблюдения.
-- Текст пишет YandexGPT (если подключён ключ Яндекса), иначе система собирает его сама по правилам.

-- Готовые сводки: пересчитываются, только если что-то изменилось (отпечаток исходных данных)
create table agent_briefs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  object_type text not null check (object_type in ('task', 'opportunity', 'process')),
  object_id uuid not null,
  input_hash text not null,
  body text not null check (length(body) <= 6000),
  engine text not null,                      -- yandexgpt / rules
  facts jsonb,                               -- сколько источников учтено: звонков, сообщений и т.д.
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index agent_briefs_obj on agent_briefs (object_type, object_id, created_at desc);

-- Наблюдения агента о ходе процессов (просрочки, эскалации, узкие места). Попадают в «Коротко о ситуации».
create table agent_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid references persons(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  kind text not null,
  body text not null check (length(body) <= 1000),
  created_at timestamptz not null default now()
);
create index agent_observations_person on agent_observations (person_id, created_at desc);
create index agent_observations_opp on agent_observations (opportunity_id, created_at desc);
create index agent_observations_task on agent_observations (task_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['agent_briefs', 'agent_observations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
