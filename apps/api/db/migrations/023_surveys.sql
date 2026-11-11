-- Опросы после визита: оценка 0–10 «порекомендуете ли клуб», задача управляющему на низкую оценку, просьба об отзыве на картах.

create table club_survey_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  enabled boolean not null default true,
  first_visit boolean not null default true,     -- после первого визита
  day30 boolean not null default true,           -- через 30 дней после первой покупки
  quarterly boolean not null default true,       -- раз в квартал действующим клиентам
  question text not null default '{имя}, насколько вероятно, что вы порекомендуете клуб {клуб} друзьям? Ответьте цифрой от 0 до 10, где 10 — точно порекомендую. Можно добавить пару слов, что понравилось или что улучшить.',
  low_max int not null default 6 check (low_max between 0 and 9),     -- 0…low_max — недоволен: задача управляющему
  high_min int not null default 9 check (high_min between 1 and 10),  -- high_min…10 — просим отзыв на картах
  task_hours int not null default 24 check (task_hours between 1 and 168),
  yandex_url text,
  gis_url text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('first_visit', 'day30', 'quarterly')),
  period_key text not null,                    -- за что отправлен: визит, абонемент, квартал — второй раз не отправляется
  conversation_id uuid references msg_conversations(id),
  message_id uuid references msg_messages(id),
  staff_id uuid references users(id),          -- кто продал абонемент: оценка идёт в индекс сотрудника
  status text not null default 'sent' check (status in ('sent', 'answered', 'expired')),
  score int check (score between 0 and 10),
  comment text,
  answered_at timestamptz,
  task_id uuid references tasks(id) on delete set null,
  review_asked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (person_id, kind, period_key)
);
create index surveys_open on surveys (club_id, created_at) where status = 'sent';
create index surveys_answered on surveys (club_id, answered_at) where status = 'answered';

do $$
declare t text;
begin
  foreach t in array array['club_survey_settings', 'surveys'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
