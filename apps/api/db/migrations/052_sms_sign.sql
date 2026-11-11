-- Подпись договора кодом из СМС — простая электронная подпись (список «20 улучшений», п. 17).
-- В клубе: администратор отправляет код, клиент вводит его на планшете. Удалённо: клиент получает ссылку, читает документы и вводит код.

alter table contracts drop constraint contracts_sign_method_check;
alter table contracts add constraint contracts_sign_method_check check (sign_method in ('paper_scan', 'tablet', 'online_offer', 'sms'));
alter table contracts add column signer_phone text;

-- Отправка СМС: провайдер сети, ключ зашифрован. «Тестовый» ничего не отправляет и показывает код сотруднику
create table sms_settings (
  tenant_id uuid primary key references tenants(id),
  provider text not null default 'test' check (provider in ('test', 'smsru', 'smsc')),
  sender text,
  login text,
  secret_enc text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
alter table sms_settings enable row level security;
create policy t_sms_settings on sms_settings using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Журнал отправленных СМС: код в тексте скрыт
create table sms_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid references clubs(id),
  to_phone text not null,
  text text not null,
  provider text not null,
  status text not null check (status in ('sent', 'failed', 'test')),
  error text,
  created_at timestamptz not null default now()
);
create index sms_outbox_tenant on sms_outbox (tenant_id, created_at desc);
alter table sms_outbox enable row level security;
create policy t_sms_outbox on sms_outbox using (tenant_id = app_tenant() and (club_id is null or app_club_visible(club_id))) with check (tenant_id = app_tenant());

create table contract_sign_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  contract_id uuid not null references contracts(id),
  phone text not null,
  code_hash text,
  code_sent_at timestamptz,
  code_expires_at timestamptz,
  codes_sent integer not null default 0,
  attempts integer not null default 0,
  link_token_hash text unique,
  link_expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'signed', 'cancelled')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index contract_sign_requests_contract on contract_sign_requests (contract_id, created_at desc);
alter table contract_sign_requests enable row level security;
create policy t_contract_sign_requests on contract_sign_requests using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Ссылка для удалённой подписи: по ней ещё неизвестна сеть
create function auth_sign_link(p_token_hash text)
returns table (request_id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select id, tenant_id from contract_sign_requests where link_token_hash = p_token_hash and status = 'active' and link_expires_at > now()
$$;
