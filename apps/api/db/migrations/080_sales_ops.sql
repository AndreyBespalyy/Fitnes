-- Отдел продаж: контроль скорости ответа на заявки, стоп-лист «не звонить», теги клиентов, склейка дублей,
-- списки обзвона по менеджерам, горячее окно продлений, новички за 45 дней, воронка «где теряем», недельная сводка.
-- Процессы из списка Андрея «ИИ в управлении продажами» (11.11.2026), этап А — то, что работает на данных системы.

-- Настройки клуба (управляющий; по умолчанию — как в описании Андрея)
create table sales_ops_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  remind_minutes int not null default 5 check (remind_minutes between 1 and 240),        -- заявка без «Беру в работу» — напоминание менеджеру
  escalate_minutes int not null default 15 check (escalate_minutes between 2 and 1440),  -- сигнал РОПу
  newbie_days int not null default 45 check (newbie_days between 14 and 120),            -- новички за сколько дней
  newbie_min_visits int not null default 4 check (newbie_min_visits between 1 and 30),   -- меньше стольких визитов в первый месяц — в список
  exclude_low_visits boolean not null default true,                                       -- члены клуба с 0–2 посещениями не идут в обзвон базы
  notify_telegram boolean not null default true,                                          -- личные сообщения в Telegram через бота сотрудников
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  check (escalate_minutes > remind_minutes)
);

-- «Беру в работу» и отметки контроля
alter table leads add column taken_at timestamptz;
alter table leads add column taken_by uuid references users(id);
alter table leads add column reminded_at timestamptz;
alter table leads add column escalated_at timestamptz;
create index leads_waiting on leads (club_id, created_at) where taken_at is null and first_response_at is null;

-- Стоп-лист обзвона: почему не звонить и до какого дня (для «отложенных»)
create table person_call_blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  person_id uuid not null references persons(id) on delete cascade,
  reason text not null check (reason in ('staff', 'trainer', 'moved', 'refund', 'irrelevant', 'unfit', 'bad_number', 'refused', 'postponed', 'do_not_call')),
  until date,                         -- только для «отложено»: после этой даты снова в обзвоне
  comment text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  removed_by uuid references users(id),
  removed_at timestamptz
);
create unique index person_call_blocks_active on person_call_blocks (person_id) where removed_at is null;
alter table person_call_blocks enable row level security;
create policy t_pcb on person_call_blocks
  using (tenant_id = app_tenant() and exists (select 1 from persons p where p.id = person_id))
  with check (tenant_id = app_tenant());

-- Теги клиента: свои (поставил сотрудник) и автоматические (пересчитываются каждую ночь)
create table person_tags (
  tenant_id uuid not null references tenants(id),
  person_id uuid not null references persons(id) on delete cascade,
  tag text not null check (length(tag) between 1 and 40),
  auto boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (person_id, tag)
);
create index person_tags_tag on person_tags (tenant_id, tag);
alter table person_tags enable row level security;
create policy t_ptags on person_tags
  using (tenant_id = app_tenant() and exists (select 1 from persons p where p.id = person_id))
  with check (tenant_id = app_tenant());

-- Пары, которые сотрудник отметил «это разные люди»: больше не предлагаем склеить
create table person_not_duplicates (
  tenant_id uuid not null references tenants(id),
  a uuid not null references persons(id) on delete cascade,
  b uuid not null references persons(id) on delete cascade,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
alter table person_not_duplicates enable row level security;
create policy t_pnd on person_not_duplicates using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Что уже отправлено (чтобы сводки и сигналы не дублировались): клуб, вид, период
create table sales_ops_sent (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null,
  period text not null,
  sent_at timestamptz not null default now(),
  recipients int not null default 0,
  primary key (club_id, kind, period)
);
alter table sales_ops_sent enable row level security;
create policy t_sos on sales_ops_sent using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

alter table sales_ops_settings enable row level security;
create policy t_sops on sales_ops_settings using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Склейка: все ссылки на дубль переносятся на основную карточку, дубль помечается merged_into_id.
-- Ссылки ищутся по внешним ключам на persons(id), поэтому новые таблицы подхватываются сами.
-- Если перенос в таблице упирается в уникальность (у основной карточки такая запись уже есть), строки дубля в ней удаляются.
-- Часть таблиц (платежи, чеки) приложение менять не может, поэтому функция работает с правами владельца схемы,
-- а доступ проверяет сама: обе карточки — этой сети и клубов, которые видит сотрудник.
create function merge_person(p_main uuid, p_dup uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; n int; moved jsonb := '{}'; dropped jsonb := '{}';
begin
  if p_main = p_dup then raise exception 'same person'; end if;
  if (select count(*) from persons p where p.id in (p_main, p_dup) and p.tenant_id = app_tenant() and app_club_visible(p.home_club_id) and p.merged_into_id is null) <> 2 then
    raise exception 'merge_person: карточки недоступны' using errcode = '42501';
  end if;
  for r in
    select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'persons'::regclass and array_length(c.conkey, 1) = 1
      and c.conrelid <> 'person_not_duplicates'::regclass
  loop
    begin
      execute format('update %s set %I = $1 where %I = $2', r.tbl, r.col, r.col) using p_main, p_dup;
      get diagnostics n = row_count;
      if n > 0 then moved := moved || jsonb_build_object(r.tbl || '.' || r.col, n); end if;
    exception when unique_violation or exclusion_violation then
      execute format('delete from %s where %I = $1', r.tbl, r.col) using p_dup;
      get diagnostics n = row_count;
      if n > 0 then dropped := dropped || jsonb_build_object(r.tbl || '.' || r.col, n); end if;
    end;
  end loop;
  update persons set merged_into_id = p_main, updated_at = now() where id = p_dup;
  -- контакты могли задвоиться: оставляем по одному значению каждого вида
  delete from person_contacts x using person_contacts y
    where x.person_id = p_main and y.person_id = p_main and x.type = y.type and x.normalized_value = y.normalized_value and x.id > y.id;
  return jsonb_build_object('moved', moved, 'dropped', dropped);
end $$;
