-- Шаг 18, часть 3. Обзоры менеджеров, рекомендации РОПа с обратной связью, прогноз дефицита плана, оценка звонков по стандарту.

-- Рекомендация сотруднику: что сделать, к какому сроку, по какому показателю проверить результат (FR-AI-10, AT31)
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id),        -- кому
  author_id uuid references users(id),               -- кто назначил (РОП); предложение ИИ назначает человек
  origin text not null default 'rop' check (origin in ('ai', 'rop')),
  title text not null,
  details text,
  metric text not null,                              -- KPI (calls, meetings_set…), plan:<категория> или quality
  higher_better boolean not null default true,
  baseline numeric,                                  -- значение до рекомендации, за такой же срок
  target numeric,                                    -- к чему прийти за срок
  starts_on date not null,
  due_on date not null,
  status text not null default 'open' check (status in ('open', 'done', 'not_done', 'cancelled')),
  user_mark text check (user_mark in ('done', 'failed')),  -- отметка сотрудника
  user_comment text,
  user_marked_at timestamptz,
  result numeric,                                    -- фактическое значение показателя за срок
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index recommendations_user on recommendations (club_id, user_id, due_on desc);
create index recommendations_due on recommendations (due_on) where status = 'open';

-- Предупреждение о дефиците плана: одно на клуб и месяц (AT30)
create table plan_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  month date not null,
  deficit_kop bigint not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (club_id, month)
);

-- Оценка звонка по чек-листу стандарта, действовавшего в момент звонка (FR-AI-12, AT32)
create table call_evaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  call_id uuid not null references calls(id) on delete cascade,
  user_id uuid references users(id),                 -- чей звонок
  standard_id uuid references sales_standards(id),   -- null: шаблон платформы (версия 0)
  standard_version int not null,
  items jsonb not null,                              -- [{ id, text, weight, ok, comment }]
  score numeric not null check (score between 0 and 100),
  source text not null check (source in ('ai', 'rop')),
  engine text,
  evaluated_by uuid references users(id),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_id, source)
);
create index call_evaluations_user on call_evaluations (club_id, user_id, created_at desc);
-- Версия стандарта у оценки не меняется: смена стандарта не переписывает старые оценки
create function call_evaluation_guard() returns trigger language plpgsql as $$
begin
  if new.standard_version <> old.standard_version or new.standard_id is distinct from old.standard_id or new.call_id <> old.call_id then
    raise exception 'Оценка звонка привязана к версии стандарта на момент звонка';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger call_evaluations_guard before update on call_evaluations for each row execute function call_evaluation_guard();

do $$
declare t text;
begin
  foreach t in array array['recommendations', 'plan_alerts', 'call_evaluations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
