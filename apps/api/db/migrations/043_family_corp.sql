-- Семейные и корпоративные абонементы (список «20 новых возможностей», п. 13).
-- Семья: один плательщик и несколько участников, у каждого свой абонемент, проход и история; скидка второму и следующим.
-- Компания: договор, список сотрудников, абонементы сотрудникам за счёт компании, счёт юрлицу раз в месяц, отчёт о посещениях.
alter table club_membership_settings add column family_discount_percent int not null default 10 check (family_discount_percent between 0 and 50);
alter table club_membership_settings add column family_max_members int not null default 6 check (family_max_members between 2 and 12);

create table family_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  payer_id uuid not null references persons(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table family_members (
  group_id uuid not null references family_groups(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  relation text,
  added_by uuid references users(id),
  added_at timestamptz not null default now(),
  primary key (group_id, person_id)
);
create unique index family_member_one on family_members (club_id, person_id); -- в клубе человек состоит в одной семье

create table companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  inn text check (inn is null or inn ~ '^\d{10}(\d{2})?$'),
  kpp text,
  address text,
  contact_name text,
  contact_phone text,
  contact_email text,
  contract_number text,
  contract_date date,
  discount_percent int not null default 0 check (discount_percent between 0 and 50),
  payment_days int not null default 10 check (payment_days between 0 and 60),
  max_employees int check (max_employees is null or max_employees > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index companies_name on companies (club_id, lower(name));

create table company_employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  company_id uuid not null references companies(id),
  person_id uuid not null references persons(id),
  position text,
  added_by uuid references users(id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references users(id)
);
create unique index company_employee_active on company_employees (company_id, person_id) where removed_at is null;

create table company_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  company_id uuid not null references companies(id),
  number text not null,
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  amount_kop bigint not null check (amount_kop > 0),
  due_on date not null,
  status text not null default 'issued' check (status in ('issued', 'paid', 'cancelled')),
  paid_at timestamptz,
  paid_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (club_id, number)
);

alter table memberships add column family_group_id uuid references family_groups(id);
alter table memberships add column payer_person_id uuid references persons(id);
alter table memberships add column company_id uuid references companies(id);
alter table charges add column company_id uuid references companies(id);
alter table charges add column invoice_id uuid references company_invoices(id);
create index charges_company on charges (company_id, status) where company_id is not null;

do $$
declare t text;
begin
  foreach t in array array['family_groups', 'family_members', 'companies', 'company_employees', 'company_invoices'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
