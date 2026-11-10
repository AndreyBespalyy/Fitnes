-- Шаг 8 (финансы). Журнал платежей (только добавление), кассовые смены, согласования по лимитам,
-- возвраты, расходы, план продаж по категориям.

alter table memberships add column sale_category text check (sale_category in ('new', 'renewal', 'return', 'subscription'));

create table cash_shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_by uuid not null references users(id),
  opened_at timestamptz not null default now(),
  opening_cash_kop bigint not null check (opening_cash_kop >= 0),
  closed_by uuid references users(id),
  closed_at timestamptz,
  expected_cash_kop bigint,
  counted_cash_kop bigint check (counted_cash_kop >= 0),
  note text
);
create unique index cash_shifts_one_open on cash_shifts (club_id) where status = 'open';

create table approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null check (kind in ('refund', 'expense', 'discount')),
  object_id uuid not null,
  amount_kop bigint not null,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_comment text,
  auto boolean not null default false     -- в пределах лимита самого сотрудника
);
create index approvals_pending on approvals (club_id, status);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  membership_id uuid not null references memberships(id),
  person_id uuid not null references persons(id),
  amount_kop bigint not null check (amount_kop > 0),
  method text not null check (method in ('cash', 'card_terminal', 'sbp', 'bank_transfer')),
  reason text not null,
  cancel_membership boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  approval_id uuid references approvals(id),
  requested_by uuid references users(id),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table expense_categories (
  code text primary key,
  name text not null,
  sort int not null default 0
);
insert into expense_categories(code, name, sort) values
  ('rent', 'Аренда', 1), ('salary', 'Зарплата', 2), ('utilities', 'Коммунальные услуги', 3), ('marketing', 'Реклама и маркетинг', 4),
  ('household', 'Хозяйственные расходы', 5), ('repair', 'Ремонт и оборудование', 6), ('taxes', 'Налоги и сборы', 7), ('bank', 'Банк и эквайринг', 8), ('other', 'Прочее', 9);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  category text not null references expense_categories(code),
  amount_kop bigint not null check (amount_kop > 0),
  description text not null,
  method text not null check (method in ('cash', 'bank_transfer', 'card')),
  spent_on date not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approval_id uuid references approvals(id),
  shift_id uuid references cash_shifts(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Журнал движения денег: каждое поступление и выплата, только добавление (исправление — обратной записью)
create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  direction text not null check (direction in ('in', 'out')),
  kind text not null check (kind in ('charge', 'refund', 'expense')),
  amount_kop bigint not null check (amount_kop > 0),
  method text not null,
  person_id uuid references persons(id),
  charge_id uuid references charges(id),
  refund_id uuid references refunds(id),
  expense_id uuid references expenses(id),
  sale_category text,
  expense_category text,
  shift_id uuid references cash_shifts(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index payments_club_time on payments (club_id, created_at);

create table sales_plans (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  month date not null check (extract(day from month) = 1),
  category text not null check (category in ('new', 'renewal', 'return', 'subscription')),
  amount_kop bigint not null check (amount_kop >= 0),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (club_id, month, category)
);

do $$
declare t text;
begin
  foreach t in array array['cash_shifts', 'approvals', 'refunds', 'expenses', 'payments', 'sales_plans'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Чек возврата привязан к возврату
alter table receipts add column refund_id uuid references refunds(id);
