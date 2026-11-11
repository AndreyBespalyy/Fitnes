-- Возврат бывших клиентов (кампании по группам) и досрочное продление с фиксированной ценой.

create table retention_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  filter jsonb not null,                       -- группа: сколько месяцев назад ушёл, тариф, визиты
  template text not null,                      -- текст сообщения с подстановками {имя}, {клуб}, {предложение}
  offer text,                                  -- что предлагаем, словами
  call_without_messenger boolean not null default true,  -- без мессенджера или согласия — задача на звонок
  status text not null default 'draft' check (status in ('draft', 'running', 'finished')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  launched_at timestamptz,
  launched_by uuid references users(id),
  finished_at timestamptz
);

create table campaign_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  campaign_id uuid not null references retention_campaigns(id),
  person_id uuid not null references persons(id),
  left_on date,                                -- когда закончился последний абонемент
  channel text not null check (channel in ('message', 'call', 'skip')),
  skip_reason text,
  message_id uuid references msg_messages(id),
  task_id uuid references tasks(id) on delete set null,
  sent_at timestamptz,
  replied_at timestamptz,
  bought_membership_id uuid references memberships(id),
  bought_at timestamptz,
  bought_kop bigint,
  created_at timestamptz not null default now(),
  unique (campaign_id, person_id)
);
create index campaign_members_open on campaign_members (club_id, person_id) where bought_at is null;

-- Предложение досрочного продления: цена на момент предложения держится до конца абонемента
create table renewal_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  membership_id uuid not null unique references memberships(id),
  person_id uuid not null references persons(id),
  product_id uuid references products(id),
  price_version_id uuid references price_versions(id),
  amount_kop bigint,
  valid_until date not null,
  status text not null check (status in ('sent', 'call', 'skipped', 'used')),
  skip_reason text,
  message_id uuid references msg_messages(id),
  task_id uuid references tasks(id) on delete set null,
  replied_at timestamptz,
  used_membership_id uuid references memberships(id),
  created_at timestamptz not null default now()
);

create table club_retention_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  early_enabled boolean not null default true,
  early_days int not null default 30 check (early_days between 7 and 90),
  early_call_without_messenger boolean not null default true,
  early_template text not null default '{имя}, ваш абонемент «{абонемент}» в клубе {клуб} заканчивается {дата_окончания}. Продлите заранее по текущей цене {цена} — она сохранится за вами до {дата_окончания}, даже если цены вырастут. Ответьте на это сообщение, и мы всё оформим.',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['retention_campaigns', 'campaign_members', 'renewal_offers', 'club_retention_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
