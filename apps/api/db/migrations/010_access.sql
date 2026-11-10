-- Шаг 11. Проходы и посещения без привязки к модели турникета: карты, браслеты и QR, точки прохода,
-- шлюз в клубе (работает и без интернета), сырые события проходов отдельно от посещений, ручной проход.

-- Условия тарифа для прохода: в какие клубы сети и в какое время
alter table products add column network_access boolean not null default false;  -- проход во все клубы сети
alter table products add column access_from time;                                -- тариф действует с (например, дневной до 17:00)
alter table products add column access_to time;
alter table memberships add column network_access boolean not null default false; -- снимок условий на момент продажи
alter table memberships add column access_from time;
alter table memberships add column access_to time;
update products set access_to = '17:00' where name like '%Дневная%';

create table club_access_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  open_from time not null default '07:00',               -- часы работы клуба: клиентов вне них не пускаем
  open_to time not null default '23:00',
  repeat_entry_minutes int not null default 30 check (repeat_entry_minutes between 0 and 720), -- вернулся в течение N минут после выхода — то же посещение
  offline_hours int not null default 24 check (offline_hours between 1 and 168),             -- сколько шлюз пускает по сохранённым правилам без связи
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- Шлюз: программа на компьютере клуба между турникетами и системой. Хранит правила, работает без интернета.
create table access_gateways (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  token_hash text,                                       -- ключ шлюза хранится только в виде отпечатка
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  version text,
  queued int not null default 0,                         -- сколько событий шлюз ещё не выгрузил
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table access_points (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  gateway_id uuid references access_gateways(id),
  name text not null,
  direction text not null default 'both' check (direction in ('in', 'out', 'both')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Карта, браслет или QR. Клиенту или сотруднику. Перевыпуск — новая запись, старая гасится, клиент тот же.
create table access_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),            -- где выдана
  person_id uuid references persons(id),
  user_id uuid references users(id),
  kind text not null check (kind in ('card', 'bracelet', 'qr')),
  code text not null,
  status text not null default 'active' check (status in ('active', 'replaced', 'lost', 'blocked')),
  replaced_by_id uuid references access_credentials(id),
  issued_by uuid references users(id),
  issued_at timestamptz not null default now(),
  revoked_by uuid references users(id),
  revoked_at timestamptz,
  revoke_reason text,
  check ((person_id is null) <> (user_id is null))
);
create unique index access_credentials_active_code on access_credentials (tenant_id, code) where status = 'active';
create index access_credentials_code on access_credentials (tenant_id, code);

-- Сырое событие прохода: всё, что прислал шлюз или отметил сотрудник. Только добавление.
create table access_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  point_id uuid references access_points(id),
  gateway_id uuid references access_gateways(id),
  external_id text,                                      -- номер события на шлюзе: повтор не создаёт второе событие
  happened_at timestamptz not null,
  received_at timestamptz not null default now(),
  direction text not null check (direction in ('in', 'out')),
  code text,
  credential_id uuid references access_credentials(id),
  person_id uuid references persons(id),
  user_id uuid references users(id),
  membership_id uuid references memberships(id),
  decision text not null check (decision in ('allow', 'deny')),
  reason_code text not null,
  reason text not null,
  mode text not null check (mode in ('online', 'offline', 'manual', 'emulator')),
  manual_by uuid references users(id),
  manual_reason text,
  visit_id uuid references visits(id),
  visit_effect text                                      -- new / repeat / reopen / exit / none
);
create unique index access_events_external on access_events (gateway_id, external_id) where external_id is not null;
create index access_events_club_time on access_events (club_id, happened_at desc);
create index access_events_person on access_events (person_id, happened_at desc);
create index access_events_user on access_events (user_id, happened_at desc);

-- Команды шлюзу (открыть турникет по кнопке ресепшн)
create table access_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  gateway_id uuid not null references access_gateways(id),
  point_id uuid not null references access_points(id),
  kind text not null default 'open' check (kind in ('open')),
  event_id uuid references access_events(id),
  status text not null default 'pending' check (status in ('pending', 'done', 'expired')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  done_at timestamptz
);

-- Посещение: расчётная запись. Время в клубе — только когда есть выход.
alter table visits add column exit_at timestamptz;
alter table visits add column point_id uuid references access_points(id);
create index visits_open on visits (person_id, club_id) where exit_at is null;

do $$
declare t text;
begin
  foreach t in array array['club_access_settings', 'access_gateways', 'access_points', 'access_credentials', 'access_events', 'access_commands'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Шлюз входит по своему ключу, без пользователя: узнаём сеть и клуб
create function acs_gateway_by_token(p_gateway uuid, p_token text) returns table (tenant_id uuid, club_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, club_id from access_gateways
  where id = p_gateway and status = 'active' and token_hash is not null and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

insert into club_access_settings(club_id, tenant_id) select id, tenant_id from clubs on conflict do nothing;
