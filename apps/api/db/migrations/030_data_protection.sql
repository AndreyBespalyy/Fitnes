-- Защита базы клиентов, персональные данные (152-ФЗ) и состояние системы.

-- Пороги защиты по клубу. Если строки нет, действуют значения по умолчанию
create table data_protection_settings (
  tenant_id uuid not null references tenants(id),
  club_id uuid primary key references clubs(id),
  export_rows_limit int not null default 200 check (export_rows_limit between 0 and 100000),   -- строк с данными клиентов в одной выгрузке без согласования
  reveals_per_hour int not null default 40 check (reveals_per_hour between 1 and 1000),        -- полных номеров и договоров в час на сотрудника
  card_views_alert int not null default 150 check (card_views_alert between 10 and 10000),     -- открытых карточек в час: сообщить управляющему
  searches_alert int not null default 150 check (searches_alert between 10 and 10000),         -- поисков по базе в час: сообщить управляющему
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- Выгрузки сверх лимита ждут согласования управляющего; одобренной выгрузкой можно воспользоваться один раз в течение суток
create table export_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid references clubs(id),
  user_id uuid not null references users(id),
  report text not null,
  title text not null,
  params jsonb not null,
  params_hash text not null,
  rows int not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'used')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_comment text,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index export_requests_pending on export_requests (tenant_id, status, created_at desc);

-- Счётчики обращений к данным клиентов по часам: полный номер, карточка, поиск
create table pd_access_counters (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('reveal', 'card', 'search')),
  hour timestamptz not null,
  club_id uuid references clubs(id),
  n int not null default 0,
  primary key (user_id, kind, hour)
);

-- Подозрительная активность: всплеск просмотров, поисков или попытки превысить лимит номеров
create table pd_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid references clubs(id),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('reveal', 'card', 'search', 'export')),
  count int not null,
  threshold int not null,
  hour timestamptz not null,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, kind, hour)
);
create index pd_alerts_open on pd_alerts (tenant_id, created_at desc) where reviewed_at is null;

-- Тексты согласий с версиями: согласие на обработку ПДн и на рекламные рассылки
create table consent_texts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('pd', 'marketing')),
  version int not null,
  title text not null,
  body text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, kind, version)
);

-- Журнал согласий клиента: только добавление, действующее — последнее по виду
create table person_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('pd', 'marketing')),
  granted boolean not null,
  text_id uuid references consent_texts(id),
  channel text not null check (channel in ('paper', 'tablet', 'site', 'messenger', 'staff', 'import')),
  note text,
  actor_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index person_consents_person on person_consents (person_id, kind, created_at desc);

-- Обращения клиентов по персональным данным: срок ответа 10 рабочих дней (152-ФЗ, ст. 14, 20, 21)
create table pd_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('access', 'delete', 'revoke', 'correct')),
  received_on date not null,
  due_on date not null,
  status text not null default 'open' check (status in ('open', 'done', 'rejected')),
  note text,
  result text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  done_by uuid references users(id),
  done_at timestamptz
);
create index pd_requests_open on pd_requests (tenant_id, status, due_on);

alter table persons add column anonymized_at timestamptz;

-- Состояние системы: последнее значение каждой проверки и когда о нём сообщили
create table monitor_state (
  scope text not null,                         -- 'platform' или id сети
  check_code text not null,
  status text not null check (status in ('ok', 'warn', 'bad')),
  value numeric,
  detail text,
  since timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (scope, check_code)
);

alter table data_protection_settings enable row level security;
create policy t_dps on data_protection_settings using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
alter table export_requests enable row level security;
create policy t_export_requests on export_requests using (tenant_id = app_tenant() and (club_id is null or app_club_visible(club_id))) with check (tenant_id = app_tenant());
alter table pd_access_counters enable row level security;
create policy t_pd_access_counters on pd_access_counters using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table pd_alerts enable row level security;
create policy t_pd_alerts on pd_alerts using (tenant_id = app_tenant() and (club_id is null or app_club_visible(club_id))) with check (tenant_id = app_tenant());
alter table consent_texts enable row level security;
create policy t_consent_texts on consent_texts using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table person_consents enable row level security;
create policy t_person_consents on person_consents using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table pd_requests enable row level security;
create policy t_pd_requests on pd_requests using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Для проверки состояния без пользователя: очереди и сбои по каждой сети
create function monitor_tenant_counts() returns table (tenant_id uuid, receipts_stuck int, receipts_failed int, msg_stuck int, autopay_failed int, online_stuck int)
language sql stable security definer set search_path = public as $$
  select t.id,
    (select count(*)::int from receipts r where r.tenant_id = t.id and r.status in ('pending', 'sent') and r.created_at < now() - interval '30 minutes'),
    (select count(*)::int from receipts r where r.tenant_id = t.id and r.status = 'failed' and r.updated_at > now() - interval '24 hours'),
    (select count(*)::int from msg_messages m where m.tenant_id = t.id and m.status = 'queued' and m.created_at < now() - interval '15 minutes'),
    (select count(*)::int from online_payments o where o.tenant_id = t.id and o.purpose = 'autopay' and o.status = 'failed' and o.created_at > now() - interval '24 hours'),
    (select count(*)::int from online_payments o where o.tenant_id = t.id and o.status in ('created', 'pending') and o.created_at < now() - interval '2 hours' and o.purpose = 'autopay')
  from tenants t
$$;
