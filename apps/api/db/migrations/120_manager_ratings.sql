-- Рейтинг менеджеров по продажам (просьба Андрея 17.11.2026). Каждое утро ИИ-агент считает балл 0–100 по каждому менеджеру:
-- темп выполнения личного плана, перевыполнение, скорость ответа на заявки и сообщения, дисциплина по наблюдениям агента
-- (просрочки, эскалации до руководителя, клиенты без ответа) и пишет короткий вывод. Видят: сам менеджер, РОП, управляющий, собственник.
create table manager_ratings (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id) on delete cascade,
  day date not null,                 -- за какой день (данные по вчерашний день включительно)
  score smallint not null check (score between 0 and 100),
  parts jsonb not null default '{}', -- баллы по частям: plan, over, speed, discipline
  facts jsonb not null default '{}', -- из чего посчитано: план, факт, темп, прогноз, ответ, просрочки, эскалации…
  note text,                         -- вывод агента: почему такой балл и что подтянуть
  created_at timestamptz not null default now(),
  primary key (club_id, user_id, day)
);
create index manager_ratings_user on manager_ratings (user_id, day desc);
alter table manager_ratings enable row level security;
create policy t_manager_ratings on manager_ratings
  using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));
grant select, insert, update, delete on manager_ratings to fitnes_app;
