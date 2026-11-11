-- Подарочные сертификаты и депозит клиента (список «20 новых возможностей», п. 11).
-- Депозит — внутренний счёт клиента в клубе: пополняется деньгами или сертификатом, тратится на абонементы, персональные и товары.
-- Деньги приходят один раз — при пополнении или продаже сертификата. Трата с депозита не создаёт второй приход.
create table deposit_moves (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('topup', 'cert', 'spend', 'refund', 'correction')),
  amount_kop bigint not null check (amount_kop <> 0),   -- пополнение +, трата −
  method text,                                          -- для пополнения: cash, card_terminal
  charge_id uuid references charges(id),
  goods_sale_id uuid references goods_sales(id),
  gift_cert_id uuid,
  comment text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index deposit_moves_person on deposit_moves (club_id, person_id, created_at desc);

create table gift_certs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  code text not null unique,
  kind text not null check (kind in ('amount', 'product')),
  amount_kop bigint not null check (amount_kop > 0),    -- номинал; для сертификата на абонемент — цена абонемента при продаже
  product_id uuid references products(id),
  product_name text,
  valid_to date not null,
  status text not null default 'active' check (status in ('active', 'used', 'cancelled')),
  buyer_person_id uuid references persons(id),
  buyer_name text,
  recipient_name text,
  method text not null,
  receipt_id uuid,
  sold_by uuid references users(id),
  sold_at timestamptz not null default now(),
  used_person_id uuid references persons(id),
  used_membership_id uuid references memberships(id),
  used_at timestamptz,
  used_by uuid references users(id),
  check ((kind = 'product') = (product_id is not null))
);
create index gift_certs_club on gift_certs (club_id, sold_at desc);
alter table deposit_moves add constraint deposit_moves_cert_fk foreign key (gift_cert_id) references gift_certs(id);
alter table receipts add column gift_cert_id uuid references gift_certs(id);
alter table receipts add column deposit_move_id uuid references deposit_moves(id);

do $$
declare t text;
begin
  foreach t in array array['deposit_moves', 'gift_certs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
