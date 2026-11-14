-- ИИ-агент, этап 5 (просьба Андрея 14.11.2026): «Назначить собрание».
-- Собственник пишет помощнику, кого позвать (группами и по фамилиям) и в какое окно (дни, часы).
-- Помощник сверяет расписание тренировок, встречи с клиентами, звонки и задачи участников, предлагает время
-- с наименьшими потерями для клуба, после выбора вносит собрание в календарь каждого и рассылает приглашения
-- в мессенджер с кнопкой «Подтвердить участие».
create table staff_meetings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  title text not null check (length(title) between 1 and 200),
  place text not null default '' check (length(place) <= 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'planned' check (status in ('planned', 'cancelled')),
  moves jsonb not null default '[]',            -- что пришлось сдвинуть ради собрания (для истории и разбора)
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index staff_meetings_time on staff_meetings (tenant_id, starts_at);

create table staff_meeting_members (
  meeting_id uuid not null references staff_meetings(id) on delete cascade,
  user_id uuid not null references users(id),
  tenant_id uuid not null references tenants(id),
  status text not null default 'invited' check (status in ('invited', 'confirmed', 'declined')),
  answered_at timestamptz,
  task_id uuid references tasks(id) on delete set null,   -- запись в календаре участника (раздел «Задачи»)
  primary key (meeting_id, user_id)
);

alter table staff_meetings enable row level security;
alter table staff_meeting_members enable row level security;
create policy t_staff_meetings on staff_meetings using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_staff_meeting_members on staff_meeting_members using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Сообщение помощника с кнопкой: приглашение на собрание и ответ участника
alter table team_messages add column meta jsonb;
