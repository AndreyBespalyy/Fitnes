-- Шаг 8. Касса клуба (облачная или в клубе), чеки по 54-ФЗ, выбор банка эквайринга, согласие клиента на автосписание.

create table club_fiscal_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  mode text not null default 'none' check (mode in ('none', 'cloud', 'local')),
  provider text check (provider in ('atol_online', 'atol_local', 'manual')),
  taxation text not null default 'usn_income' check (taxation in ('osn', 'usn_income', 'usn_income_outcome', 'esn', 'patent')),
  vat text not null default 'none' check (vat in ('none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20', 'vat22')),
  payment_method text not null default 'full_prepayment' check (payment_method in ('full_prepayment', 'full_payment', 'advance')),
  inn text check (inn is null or inn ~ '^\d{10}(\d{2})?$'),
  company_email text,
  payment_address text,
  -- облачная касса
  api_url text,
  group_code text,
  login text,
  password_enc text,                   -- зашифровано ключом FISCAL_SECRET_KEY
  -- касса в клубе
  local_url text not null default 'http://127.0.0.1:16732',
  -- эквайринг (банк подключим к запуску)
  acquiring_provider text not null default 'none' check (acquiring_provider in ('none', 'sber', 'tbank', 'yookassa', 'other')),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  charge_id uuid references charges(id),
  person_id uuid references persons(id),
  kind text not null default 'sell' check (kind in ('sell', 'sell_refund')),
  mode text not null check (mode in ('cloud', 'local')),
  provider text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'done', 'failed')),
  amount_kop bigint not null,
  payload jsonb not null,              -- что отправлено в кассу
  external_id text,                    -- номер задания у облачной кассы / в веб-сервере кассы
  fiscal jsonb,                        -- ФН, ФД, ФП, дата, ссылка на чек
  error text,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  manual_by uuid references users(id), -- кассир отметил чек пробитым вручную
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index receipts_queue on receipts (status, next_attempt_at) where status in ('pending', 'sent');
create unique index receipts_charge_sell on receipts (charge_id) where kind = 'sell';

alter table persons add column autopay_enabled boolean not null default false;
alter table persons add column autopay_changed_at timestamptz;
alter table persons add column autopay_changed_by uuid references users(id);

do $$
declare t text;
begin
  foreach t in array array['club_fiscal_settings', 'receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Фоновая отправка чеков в облачную кассу: какие сети и клубы ждут обработки
create function fiscal_due_receipts(p_limit int)
returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select id, tenant_id from receipts
  where mode = 'cloud' and status in ('pending', 'sent') and next_attempt_at <= now()
  order by next_attempt_at limit p_limit
$$;
