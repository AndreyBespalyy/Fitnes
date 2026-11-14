-- ИИ-агент, этап 7 (выбор Андрея 14.11.2026, 4Б): еженедельный разбор узких мест.
-- Каждый понедельник утром агент сравнивает прошлую неделю с позапрошлой (заявки, задачи, переписка с клиентами,
-- внутренний мессенджер, звонки, сделки, занятия, бизнес-процессы, собрания), находит главные узкие места,
-- пишет руководителям разбор и даёт каждому сотруднику подсказку по его цифрам.
create table agent_weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  week_start date not null,                  -- понедельник разбираемой недели (местное время клуба)
  body text not null check (length(body) <= 12000),
  data jsonb not null,                       -- цифры недели и позапрошлой недели, узкие места
  engine text not null,                      -- yandexgpt / rules
  delivered_at timestamptz,                  -- когда разослан руководителям и сотрудникам
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (club_id, week_start)
);

alter table agent_weekly_reviews enable row level security;
create policy t_agent_weekly_reviews on agent_weekly_reviews
  using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));
