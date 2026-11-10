-- Шаг 12. Онлайн-оплата (карта и СБП) по ссылке, сохранённая карта и автосписание подписки, сверка с банковской выпиской.
-- Банк выберем к запуску: сейчас работает встроенный «Тестовый банк», настоящий подключается выбором провайдера и вводом ключей.

create table club_acquiring (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  provider text not null default 'test' check (provider in ('test', 'yookassa', 'tbank')),
  live boolean not null default false,          -- false: песочница банка (тестовые ключи), true: настоящие деньги
  shop_id text,                                 -- ЮKassa: shopId; Т-Банк: TerminalKey
  secret_enc text,                              -- ЮKassa: секретный ключ; Т-Банк: пароль терминала (зашифровано)
  sbp_enabled boolean not null default true,
  autopay_enabled boolean not null default true,
  link_hours int not null default 72 check (link_hours between 1 and 720),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table online_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  charge_id uuid references charges(id),
  purpose text not null check (purpose in ('link', 'autopay')),
  amount_kop bigint not null check (amount_kop > 0),
  description text not null,
  provider text not null,
  live boolean not null default false,
  status text not null default 'created' check (status in ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired')),
  method text,                                  -- card / sbp
  external_id text,
  confirmation_url text,
  save_method boolean not null default false,
  payment_method_id uuid,
  error text,
  conflict text,                                -- деньги пришли, а начисление уже оплачено другим способом
  expires_at timestamptz,
  last_checked_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create unique index online_payments_external on online_payments (provider, external_id) where external_id is not null;
create index online_payments_pending on online_payments (status, created_at) where status in ('created', 'pending');
create index online_payments_charge on online_payments (charge_id);

create table person_payment_methods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  provider text not null,
  live boolean not null default false,
  token_enc text not null,                      -- идентификатор сохранённой карты у банка (зашифрован)
  title text not null,                          -- «Карта •••• 4242»
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references users(id)
);
alter table online_payments add constraint online_payments_pm foreign key (payment_method_id) references person_payment_methods(id);

-- Автосписание: попытки по начислению подписки
alter table charges add column autopay_attempts int not null default 0;
alter table charges add column autopay_next_on date;
alter table charges add column autopay_error text;

-- Выписка банка (формат 1CClientBankExchange — его выгружает любой банк)
create table bank_statements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  file_name text not null,
  account text,
  date_from date,
  date_to date,
  opening_kop bigint,
  closing_kop bigint,
  lines int not null default 0,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table bank_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  statement_id uuid not null references bank_statements(id),
  fingerprint text not null,                    -- одна и та же операция из двух выписок не задвоится
  op_date date not null,
  doc_number text,
  direction text not null check (direction in ('in', 'out')),
  amount_kop bigint not null check (amount_kop > 0),
  counterparty text,
  counterparty_inn text,
  purpose text,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  match_kind text check (match_kind in ('payment', 'acquiring', 'expense', 'bank_fee', 'other')),
  payment_id uuid references payments(id),
  expense_id uuid references expenses(id),
  acquiring_day date,                           -- возмещение эквайринга за этот день
  acquiring_gross_kop bigint,
  matched_auto boolean,
  matched_by uuid references users(id),
  note text,
  created_at timestamptz not null default now(),
  unique (club_id, fingerprint)
);
create index bank_lines_club on bank_lines (club_id, op_date);

do $$
declare t text;
begin
  foreach t in array array['club_acquiring', 'online_payments', 'person_payment_methods', 'bank_statements', 'bank_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Фоновые списания и проверка оплат: по каким сетям работать
create function billing_tenants() returns table (tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select id from tenants
$$;
-- Страница оплаты по короткой ссылке и уведомления банка приходят без пользователя
create function online_payment_tenant(p_id uuid) returns table (tenant_id uuid, club_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, club_id from online_payments where id = p_id
$$;
create function acquiring_club_tenant(p_club uuid) returns table (tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id from clubs where id = p_club
$$;

insert into club_acquiring(club_id, tenant_id) select id, tenant_id from clubs on conflict do nothing;
