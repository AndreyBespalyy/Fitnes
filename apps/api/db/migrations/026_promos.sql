-- Промокоды и акции (FR-MEM-10, список «20 новых возможностей», п. 2) и разовые скидки сверх лимита продавца через согласование.
create table promotions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  code text,                                   -- промокод; пусто — акцию выбирает продавец из списка
  channel text,                                -- откуда: реклама, блогер, партнёр (для отчёта)
  discount_percent numeric check (discount_percent > 0 and discount_percent <= 100),
  discount_kop bigint check (discount_kop > 0),
  product_ids uuid[] not null default '{}',    -- пусто — на все тарифы клуба
  condition text not null default 'any' check (condition in ('any', 'new', 'renewal', 'return')),
  valid_from date not null,
  valid_to date not null check (valid_to >= valid_from),
  max_uses int check (max_uses > 0),
  status text not null default 'active' check (status in ('pending', 'active', 'rejected', 'stopped')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((discount_percent is null) <> (discount_kop is null))
);
create unique index promotions_code on promotions (tenant_id, upper(code)) where code is not null;

-- Разовая скидка конкретному клиенту сверх лимита продавца: сначала согласование, потом продажа с этой скидкой
create table discount_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  product_id uuid not null references products(id),
  percent numeric not null check (percent > 0 and percent <= 100),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'used')),
  requested_by uuid references users(id),
  created_at timestamptz not null default now()
);

alter table memberships add column list_price_kop bigint;   -- цена по тарифу до скидки
alter table memberships add column discount_kop bigint not null default 0;
alter table memberships add column promo_id uuid references promotions(id);
alter table memberships add column discount_request_id uuid references discount_requests(id);
create index memberships_promo on memberships (promo_id) where promo_id is not null;

do $$
declare t text;
begin
  foreach t in array array['promotions', 'discount_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Для согласования скидки лимит задан в процентах (approval_limits.max_percent)
alter table approvals add column percent numeric;
