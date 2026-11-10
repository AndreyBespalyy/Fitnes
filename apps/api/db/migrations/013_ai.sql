-- Шаг 14. ИИ-контур: записи разговоров, расшифровка, резюме в карточку, контроль заполнения, оценка качества.
-- Сам ИИ (распознавание речи и языковая модель) работает на отдельном сервере; здесь — учёт и правила «ИИ только предлагает».

alter table files drop constraint files_kind_check;
alter table files add constraint files_kind_check check (kind in ('club_document', 'contract_scan', 'signature', 'site_image', 'call_record'));

create table calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid references persons(id),
  opportunity_id uuid references opportunities(id) on delete set null,
  user_id uuid references users(id),                -- сотрудник, который разговаривал
  direction text not null default 'out' check (direction in ('in', 'out')),
  phone text,
  started_at timestamptz not null,
  duration_sec int check (duration_sec >= 0),
  source text not null check (source in ('upload', 'pbx', 'demo')),
  external_id text,                                  -- идентификатор звонка в АТС: повторная загрузка не создаёт дубль
  file_id uuid references files(id),
  transcript jsonb,                                  -- {text, segments: [{speaker, start, end, text}], language}
  asr_status text not null default 'queued'
    check (asr_status in ('queued', 'processing', 'done', 'failed', 'waiting_ai', 'no_audio')),
  asr_error text,
  attempts int not null default 0,
  next_try_at timestamptz not null default now(),
  engine text,                                       -- какие модели обработали звонок (версия для оценки качества)
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index calls_external on calls (club_id, external_id) where external_id is not null;
create index calls_queue on calls (asr_status, next_try_at) where asr_status in ('queued', 'processing', 'waiting_ai');
create index calls_person on calls (person_id, started_at desc);
create index calls_user on calls (club_id, user_id, started_at desc);

-- Резюме разговора. draft — что предложил ИИ, final — что попало в карточку.
-- status: draft — ждёт менеджера; confirmed — менеджер подтвердил (с правками или без);
-- needs_manual — ИИ не смог (запись не распозналась, данных недостаточно), ждём итог от менеджера;
-- auto_applied — менеджер не успел, система перенесла черновик и сообщила РОПу; manual — ИИ не справился, итог написал менеджер.
create table call_summaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  call_id uuid not null unique references calls(id) on delete cascade,
  draft jsonb,
  engine text,
  confidence numeric check (confidence between 0 and 1),
  status text not null check (status in ('draft', 'needs_manual', 'confirmed', 'auto_applied', 'manual')),
  rop_notified_at timestamptz,                       -- РОП уже получил задачу по контролю заполнения
  final jsonb,
  edit_ratio numeric check (edit_ratio between 0 and 1),  -- доля изменённого текста: 0 — принято как есть
  confirmed_by uuid references users(id),
  confirmed_at timestamptz,
  rop_rating text check (rop_rating in ('ok', 'minor', 'major')),
  rop_comment text,
  rated_by uuid references users(id),
  rated_at timestamptz,
  created_at timestamptz not null default now()
);
create index call_summaries_status on call_summaries (status, created_at);

-- Настройки ИИ по клубу
create table ai_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  fill_control_hours int not null default 2 check (fill_control_hours between 1 and 72),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- Задача может появиться из звонка (проверить итог, заполнить вручную, сообщение РОПу)
alter table tasks add column call_id uuid references calls(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['calls', 'call_summaries', 'ai_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
