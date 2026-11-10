-- Шаг 7. Юрлицо клуба, документы клуба (PDF договора и правил с версиями), файлы, договоры клиентов и их подписание.

create table legal_entities (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  full_name text not null,             -- ООО «Фитнес Центр»
  inn text not null check (inn ~ '^\d{10}(\d{2})?$'),
  kpp text check (kpp is null or kpp ~ '^\d{9}$'),
  ogrn text check (ogrn is null or ogrn ~ '^\d{13}(\d{2})?$'),
  address text,
  bank_name text,
  bik text check (bik is null or bik ~ '^\d{9}$'),
  account text check (account is null or account ~ '^\d{20}$'),
  corr_account text check (corr_account is null or corr_account ~ '^\d{20}$'),
  signer_name text,                    -- кто подписывает от клуба
  signer_basis text,                   -- на основании чего: Устава, доверенности №
  contract_prefix text not null default 'Д' check (length(contract_prefix) between 1 and 8),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null check (kind in ('club_document', 'contract_scan', 'signature')),
  original_name text not null,
  mime text not null,
  size_bytes bigint not null,
  sha256 text not null,
  storage_path text not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table club_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null check (kind in ('contract', 'rules')),
  title text not null,
  version int not null,
  file_id uuid not null references files(id),
  is_current boolean not null default true,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (club_id, kind, version)
);
create unique index club_documents_current on club_documents (club_id, kind) where is_current;

create table contract_counters (
  club_id uuid not null references clubs(id),
  tenant_id uuid not null references tenants(id),
  year int not null,
  last_no int not null default 0,
  primary key (club_id, year)
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  membership_id uuid unique references memberships(id),
  number text not null,
  contract_date date not null,
  legal_entity jsonb,                  -- снимок реквизитов на день договора
  contract_doc_id uuid references club_documents(id),
  rules_doc_id uuid references club_documents(id),
  status text not null default 'awaiting_signature' check (status in ('awaiting_signature', 'signed', 'cancelled')),
  sign_method text check (sign_method in ('paper_scan', 'tablet')),
  signed_at timestamptz,
  accepted_by uuid references users(id),   -- сотрудник, принявший подпись
  scan_file_id uuid references files(id),
  signature_file_id uuid references files(id),
  signed_docs_sha256 text,                 -- хеши PDF, с которыми клиент ознакомился
  signer_ip text,
  signer_user_agent text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (club_id, number)
);
create index contracts_person on contracts (person_id);

alter table club_membership_settings add column contract_required_for_access boolean not null default false;

do $$
declare t text;
begin
  foreach t in array array['legal_entities', 'files', 'club_documents', 'contract_counters', 'contracts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Подписанный договор не меняется: разрешено только расторжение
create function guard_signed_contract() returns trigger language plpgsql as $$
begin
  if old.status = 'signed' and (new.status <> 'cancelled' or new.signed_at is distinct from old.signed_at
     or new.scan_file_id is distinct from old.scan_file_id or new.signature_file_id is distinct from old.signature_file_id
     or new.legal_entity is distinct from old.legal_entity or new.number is distinct from old.number) then
    raise exception 'Подписанный договор изменить нельзя';
  end if;
  return new;
end $$;
create trigger contracts_signed_guard before update on contracts for each row execute function guard_signed_contract();
