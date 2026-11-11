-- Товары и услуги на ресепшне (список «20 новых возможностей», п. 10): справочник, продажа с чеком, остатки, покупка «на счёт».
create table goods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  kind text not null default 'goods' check (kind in ('goods', 'service')),   -- service: без остатков (аренда шкафчика, солярий)
  category text,
  price_kop bigint not null check (price_kop > 0),
  stock int,                                    -- остаток; для услуг пусто
  min_stock int,                                -- ниже — сигнал «пора заказать»
  is_active boolean not null default true,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);

create table goods_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid references persons(id),        -- пусто — покупатель без карточки (вода на ресепшне)
  total_kop bigint not null check (total_kop > 0),
  method text,                                  -- cash, card_terminal; пусто — на счёт клиента
  status text not null check (status in ('paid', 'on_account', 'cancelled')),
  charge_id uuid references charges(id),        -- для покупки на счёт: долг клиента, оплачивается как обычный платёж
  receipt_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index goods_sales_club_time on goods_sales (club_id, created_at);

create table goods_sale_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  sale_id uuid not null references goods_sales(id) on delete cascade,
  goods_id uuid not null references goods(id),
  name text not null,
  qty int not null check (qty > 0),
  price_kop bigint not null,
  sum_kop bigint not null
);

create table goods_moves (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  goods_id uuid not null references goods(id),
  kind text not null check (kind in ('in', 'sale', 'writeoff', 'cancel', 'count')),
  qty int not null,                             -- со знаком: приход +, продажа и списание −
  stock_after int not null,
  cost_kop bigint,                              -- закупочная сумма прихода
  comment text,
  sale_id uuid references goods_sales(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index goods_moves_goods on goods_moves (goods_id, created_at desc);

alter table charges drop constraint charges_kind_check;
alter table charges add constraint charges_kind_check check (kind in ('full', 'installment', 'subscription', 'freeze_fee', 'goods'));
alter table receipts add column goods_sale_id uuid references goods_sales(id);

do $$
declare t text;
begin
  foreach t in array array['goods', 'goods_sales', 'goods_sale_items', 'goods_moves'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
