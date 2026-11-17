-- Телефония: подключение облачной АТС клуба (первая — OnlinePBX).
-- АТС присылает события звонков на адрес с секретом, CRM сама забирает запись разговора и отдаёт её ИИ.
-- Звонок из карточки идёт через АТС: она звонит сотруднику на его внутренний номер, потом клиенту.

create table pbx_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id) unique,
  kind text not null check (kind in ('onlinepbx', 'test')),
  domain text,                             -- адрес АТС, например pbx12345.onpbx.ru
  secret_enc text,                         -- ключ API в зашифрованном виде
  webhook_token text not null,             -- случайная часть адреса для событий от АТС
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_error text,
  last_ok_at timestamptz,
  last_event_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Внутренние номера сотрудников в АТС клуба
create table pbx_extensions (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  ext text not null,
  user_id uuid not null references users(id) on delete cascade,
  primary key (club_id, ext),
  unique (club_id, user_id)
);

-- События звонков от АТС: живой звонок (окно «Звонит клиент»), пропущенные, очередь записей
create table pbx_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  connection_id uuid not null references pbx_connections(id) on delete cascade,
  uuid text not null,                      -- идентификатор звонка в АТС
  event text not null,                     -- call_start, call_user_start, call_answered, call_end, call_missed, call_transfer_answered
  direction text,                          -- in, out, local
  phone text,                              -- номер клиента (нормализованный)
  ext text,                                -- внутренний номер сотрудника
  user_id uuid references users(id) on delete set null,
  person_id uuid references persons(id) on delete set null,
  at timestamptz not null default now(),
  payload jsonb not null default '{}',
  -- только для call_end: забрать запись
  record_status text check (record_status in ('pending', 'done', 'no_record', 'failed')),
  record_attempts int not null default 0,
  record_error text,
  call_id uuid references calls(id) on delete set null,
  created_at timestamptz not null default now()
);
create index pbx_events_live on pbx_events (club_id, created_at desc);
create index pbx_events_uuid on pbx_events (connection_id, uuid);
create index pbx_events_records on pbx_events (record_status, created_at) where record_status = 'pending';

do $$
declare t text;
begin
  foreach t in array array['pbx_connections', 'pbx_extensions', 'pbx_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

grant select, insert, update, delete on pbx_connections, pbx_extensions, pbx_events to fitnes_app;

-- Входящий запрос АТС: чьё подключение (адрес содержит секрет)
create function pbx_connection_by_token(p_id uuid, p_token text) returns table (tenant_id uuid, club_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, club_id from pbx_connections where id = p_id and webhook_token = p_token and status = 'active'
$$;
grant execute on function pbx_connection_by_token(uuid, text) to fitnes_app;

-- Фоновая работа: какие сети ждут загрузки записей
create function pbx_tenants() returns table (tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select distinct tenant_id from pbx_events where record_status = 'pending'
$$;
grant execute on function pbx_tenants() to fitnes_app;
