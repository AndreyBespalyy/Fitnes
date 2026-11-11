-- Приём заявок с сайта, Tilda, VK и Авито (список «20 улучшений», п. 16).
-- У каждого подключения своя секретная ссылка: её вставляют в настройки формы или сообщества.

-- Клиент из VK или Авито может прийти без телефона: связь по его странице
alter table person_contacts drop constraint person_contacts_type_check;
alter table person_contacts add constraint person_contacts_type_check check (type in ('phone', 'email', 'telegram', 'whatsapp', 'vk', 'avito'));

create table lead_intakes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  source_id uuid not null references lead_sources(id),
  kind text not null check (kind in ('site', 'tilda', 'vk', 'avito')),
  name text not null,
  token_hash text not null unique,
  token_hint text not null,
  settings jsonb not null default '{}',   -- vk: confirmation, groupId, secretEnc; avito: clientId, clientSecretEnc, userId; site: origins
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  last_at timestamptz,
  leads integer not null default 0,
  errors integer not null default 0
);
create index lead_intakes_club on lead_intakes (club_id);
alter table lead_intakes enable row level security;
create policy t_lead_intakes on lead_intakes using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Журнал приёма: что пришло и чем закончилось (без содержимого заявки — оно в лиде)
create table lead_intake_log (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  intake_id uuid not null references lead_intakes(id) on delete cascade,
  at timestamptz not null default now(),
  status text not null check (status in ('lead', 'duplicate', 'test', 'skipped', 'error', 'limited')),
  message text,
  lead_id uuid references leads(id),
  ip text
);
create index lead_intake_log_intake on lead_intake_log (intake_id, at desc);
alter table lead_intake_log enable row level security;
create policy t_lead_intake_log on lead_intake_log using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

create function auth_lead_intake(p_token_hash text)
returns table (intake_id uuid, tenant_id uuid, club_id uuid)
language sql stable security definer set search_path = public as $$
  select id, tenant_id, club_id from lead_intakes where token_hash = p_token_hash and is_active
$$;
