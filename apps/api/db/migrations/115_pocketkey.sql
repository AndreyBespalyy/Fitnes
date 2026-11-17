-- СКУД PocketKey (ТЗ от 17.11.2026). Схема «PocketKey спрашивает CRM», как у Fitbase и ImpulseCRM:
-- сервер PocketKey вызывает адреса CRM (проверка прохода, событие прохода, опознание, проверка связи).
-- Подключение — это «шлюз» особого вида: свой ключ, свой клуб, события без дублей по номеру события.

alter table access_gateways add column kind text not null default 'gateway' check (kind in ('gateway', 'pocketkey'));
-- Настройки подключения: когда считать посещение, с каких адресов принимать запросы
alter table access_gateways add column settings jsonb not null default '{}';

-- Номер устройства (турникета, считывателя, терминала) в системе PocketKey
alter table access_points add column external_id text;
create unique index access_points_external on access_points (gateway_id, external_id) where external_id is not null;

-- Журнал обмена с внешней СКУД: без ключей и без полных номеров карт
create table acs_integration_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  gateway_id uuid not null references access_gateways(id) on delete cascade,
  at timestamptz not null default now(),
  op text not null,                      -- check / event / identify / health / devices / sync
  status text not null,                  -- allow / deny / ok / duplicate / error / unsupported
  correlation_id text,                   -- номер запроса или события PocketKey
  device text,
  code_tail text,                        -- последние 4 знака номера карты
  message text,
  ms int
);
create index acs_integration_log_gw on acs_integration_log (gateway_id, at desc);

alter table acs_integration_log enable row level security;
create policy t_acs_integration_log on acs_integration_log using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Вход по ключу теперь сообщает и вид подключения: ключ PocketKey не открывает API шлюза и наоборот
drop function acs_gateway_by_token(uuid, text);
create function acs_gateway_by_token(p_gateway uuid, p_token text) returns table (tenant_id uuid, club_id uuid, kind text)
language sql stable security definer set search_path = public as $$
  select tenant_id, club_id, kind from access_gateways
  where id = p_gateway and status = 'active' and token_hash is not null and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
grant execute on function acs_gateway_by_token(uuid, text) to fitnes_app;

grant select, insert, delete on acs_integration_log to fitnes_app;
