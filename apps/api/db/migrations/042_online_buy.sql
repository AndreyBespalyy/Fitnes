-- Покупка абонемента онлайн без менеджера (список «20 новых возможностей», п. 12).
-- Клиент сам выбирает тариф по ссылке клуба, принимает договор-оферту и правила, платит онлайн и получает QR-код для прохода.
alter table products add column sell_online boolean not null default false;

create table club_online_buy (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  enabled boolean not null default false,
  max_start_days int not null default 30 check (max_start_days between 0 and 90),
  note text,                                      -- текст для клиента на странице покупки
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table online_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  product_id uuid not null references products(id),
  membership_id uuid references memberships(id),
  charge_id uuid references charges(id),
  online_payment_id uuid references online_payments(id),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'expired')),
  amount_kop bigint not null,
  starts_on date not null,
  autopay boolean not null default false,
  docs_sha256 text,                               -- хеши договора и правил, которые клиент видел при покупке
  ip text,
  user_agent text,
  credential_id uuid references access_credentials(id),
  task_id uuid,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index online_orders_club on online_orders (club_id, created_at desc);
create index online_orders_wait on online_orders (status) where status = 'awaiting_payment';

-- Договор, заключённый оплатой оферты на сайте (ст. 438 ГК РФ)
alter table contracts drop constraint contracts_sign_method_check;
alter table contracts add constraint contracts_sign_method_check check (sign_method in ('paper_scan', 'tablet', 'online_offer'));

do $$
declare t text;
begin
  foreach t in array array['club_online_buy', 'online_orders'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Публичная страница заказа открывается по номеру заказа без входа: узнаём только сеть
create function online_order_tenant(p_id uuid) returns table (tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id from online_orders where id = p_id
$$;

-- Оплата заказа с сайта: начисления ещё нет, абонемент оформляется после оплаты
alter table online_payments drop constraint online_payments_purpose_check;
alter table online_payments add constraint online_payments_purpose_check check (purpose in ('link', 'autopay', 'buy'));
