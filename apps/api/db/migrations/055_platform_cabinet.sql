-- Кабинет оператора платформы (п. 19 списка «20 улучшений»): сети-клиенты, договоры и лимиты тарифа,
-- счета за подписку, обращения в поддержку и состояние клубов в веб-кабинете вместо командной строки.
-- Таблицы оператора недоступны приложению сетей: кабинет работает отдельным подключением владельца базы.

create table platform_operators (
  id uuid primary key default gen_random_uuid(),
  login text not null unique,
  full_name text not null,
  password_hash text not null,
  must_change_password boolean not null default true,
  status text not null default 'active' check (status in ('active', 'blocked')),
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table platform_sessions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references platform_operators(id),
  token_hash text not null unique,
  ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Счета сетям за подписку на платформу. Деньги не переписываются: счёт можно только оплатить или аннулировать
create table platform_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null unique,
  period_from date not null,
  period_to date not null,
  amount_kop bigint not null check (amount_kop > 0),
  status text not null default 'issued' check (status in ('issued', 'paid', 'cancelled')),
  due_on date not null,
  issued_at timestamptz not null default now(),
  issued_by uuid references platform_operators(id),
  paid_at timestamptz,
  paid_note text,
  cancelled_reason text
);
-- За один период — один действующий счёт
create unique index platform_invoices_period on platform_invoices (tenant_id, period_from) where status <> 'cancelled';
create index platform_invoices_tenant on platform_invoices (tenant_id, issued_at desc);
-- Сеть видит свои счета только для чтения
alter table platform_invoices enable row level security;
create policy t_platform_invoices on platform_invoices for select using (tenant_id = app_tenant());

alter table tenants add column status_reason text;

-- Оператор может приостановить доступ сети (например, при долге по подписке): вход и открытые сессии перестают работать
create or replace function auth_tenant_active(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'active' from tenants where id = p_tenant), false)
$$;
create or replace function auth_session(p_token_hash text)
returns table (session_id uuid, user_id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, s.tenant_id
  from sessions s join users u on u.id = s.user_id join tenants t on t.id = s.tenant_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now() and u.status = 'active' and t.status = 'active'
$$;
