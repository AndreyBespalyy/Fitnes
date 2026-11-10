-- Шаг 6. Тарифы с версиями цен, настройки клуба (заморозка, рассрочка, закрытие прохода при долге),
-- абонементы и подписки, операции с ними, заморозки, график платежей.

create table club_membership_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  freeze_enabled boolean not null default true,
  freeze_max_days_per_year int not null default 30 check (freeze_max_days_per_year between 0 and 365),
  freeze_max_times_per_year int not null default 2 check (freeze_max_times_per_year between 0 and 52),
  freeze_min_days int not null default 7 check (freeze_min_days between 1 and 365),
  freeze_paid boolean not null default false,
  freeze_price_kop bigint not null default 0 check (freeze_price_kop >= 0),
  installments_enabled boolean not null default true,
  installments_max_payments int not null default 3 check (installments_max_payments between 2 and 24),
  overdue_block_after_days int not null default 3 check (overdue_block_after_days between 0 and 60),
  subscription_retry_attempts int not null default 3 check (subscription_retry_attempts between 1 and 10),
  subscription_retry_interval_days int not null default 2 check (subscription_retry_interval_days between 1 and 15),
  renewal_reminder_days int not null default 14 check (renewal_reminder_days between 1 and 90),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null check (kind in ('term', 'subscription', 'visits', 'personal', 'guest')),
  name text not null,
  duration_days int check (duration_days between 1 and 3660),   -- абонемент на срок
  visits_count int check (visits_count between 1 and 1000),     -- пакет посещений или персональных
  validity_days int check (validity_days between 1 and 3660),   -- срок действия пакета
  freeze_allowed boolean not null default true,
  installments_allowed boolean not null default false,
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);

create table price_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  product_id uuid not null references products(id),
  amount_kop bigint not null check (amount_kop >= 0),
  valid_from timestamptz not null default now(),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index price_versions_current on price_versions (product_id, valid_from desc);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  product_id uuid not null references products(id),
  price_version_id uuid not null references price_versions(id),
  kind text not null,
  product_name text not null,          -- снимок условий на момент продажи
  amount_kop bigint not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  starts_on date not null,
  ends_on date,                        -- для абонемента и пакета; у подписки — оплаченный период
  visits_left int,
  installments int not null default 1,
  next_charge_on date,                 -- подписка: дата следующего списания
  renewed_from_id uuid references memberships(id),
  cancel_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memberships_person on memberships (person_id, status);

create table membership_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  membership_id uuid not null references memberships(id),
  kind text not null check (kind in ('sale', 'renewal', 'freeze', 'unfreeze', 'cancel', 'charge_paid', 'subscription_period')),
  params jsonb,
  actor_id uuid references users(id),
  at timestamptz not null default now()
);

create table freezes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  membership_id uuid not null references memberships(id),
  starts_on date not null,
  ends_on date not null,               -- последний день заморозки
  days int not null check (days > 0),
  ended_early_on date,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  membership_id uuid references memberships(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('full', 'installment', 'subscription', 'freeze_fee')),
  title text not null,
  due_on date not null,
  amount_kop bigint not null check (amount_kop >= 0),
  status text not null default 'due' check (status in ('due', 'paid', 'cancelled')),
  paid_at timestamptz,
  paid_method text,
  paid_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index charges_person on charges (person_id, status, due_on);

do $$
declare t text;
begin
  foreach t in array array['club_membership_settings', 'products', 'price_versions', 'memberships', 'membership_operations', 'freezes', 'charges'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Цена версии неизменяема: новая цена — новая версия
create function forbid_price_update() returns trigger language plpgsql as $$
begin
  raise exception 'Версию цены нельзя изменить, создайте новую';
end $$;
create trigger price_versions_immutable before update on price_versions for each row execute function forbid_price_update();
