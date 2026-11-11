-- Прогноз ухода и сценарии удержания (список «20 новых возможностей», п. 4).
-- Клиенты с высоким риском ухода (горячие в оценке «Удержание») получают мягкое сообщение, а ответственному ставится звонок с подсказкой, что сказать.
alter table club_retention_settings add column churn_enabled boolean not null default true;
alter table club_retention_settings add column churn_message boolean not null default true;
alter table club_retention_settings add column churn_cooldown_days int not null default 30 check (churn_cooldown_days between 7 and 120);
alter table club_retention_settings add column churn_template text;

create table churn_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  score numeric not null,
  reasons jsonb not null default '[]',
  script text,
  message_id uuid,
  task_id uuid references tasks(id) on delete set null,
  -- итог через 14 дней: returned — пришёл в клуб, renewed — продлил или купил, none — без изменений
  outcome text check (outcome in ('returned', 'renewed', 'none')),
  outcome_at timestamptz,
  created_at timestamptz not null default now()
);
create index churn_actions_person on churn_actions (club_id, person_id, created_at desc);

alter table churn_actions enable row level security;
create policy t_churn_actions on churn_actions using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
