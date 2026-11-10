-- Шаг 18, часть 4. Тиражирование: подключение клуба по чек-листу, демо-клуб, поддержка, договор сети с платформой и ограничения тарифа.

-- Демо-клуб: учебные данные, не входит в цифры сети и в ограничение тарифа
alter table clubs add column is_demo boolean not null default false;
alter table clubs add column onboarding_started_on date;

-- Ручные отметки чек-листа подключения. Пункты, которые система видит по данным, отмечаются сами
create table club_onboarding (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  item text not null,
  status text not null check (status in ('done', 'skipped')),
  note text,
  marked_by uuid references users(id),
  marked_at timestamptz not null default now(),
  primary key (club_id, item)
);

-- Обращения в поддержку
create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid references clubs(id),
  number int not null,
  author_id uuid not null references users(id),
  subject text not null,
  kind text not null default 'question' check (kind in ('question', 'bug', 'idea', 'access')),
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  page text,                                   -- раздел, из которого написали
  client_info text,                            -- версия приложения и браузер, без данных клиентов
  escalated_at timestamptz,                    -- передано разработчикам платформы (npm run support:list на сервере)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index support_tickets_status on support_tickets (tenant_id, status, updated_at desc);

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  author_id uuid references users(id),
  from_support boolean not null default false,
  body text not null,
  created_at timestamptz not null default now()
);
create index support_messages_ticket on support_messages (ticket_id, created_at);

-- Договор сети с платформой: тариф и ограничения. Заполняет оператор платформы (npm run tenant:contract), сеть видит только чтение
create table tenant_contracts (
  tenant_id uuid primary key references tenants(id),
  number text not null,
  signed_on date not null,
  plan text not null,                          -- название тарифа платформы
  clubs_limit int check (clubs_limit > 0),     -- null: без ограничения
  users_limit int check (users_limit > 0),
  valid_to date,
  fee_kop bigint check (fee_kop >= 0),         -- ежемесячная плата
  note text,
  updated_at timestamptz not null default now()
);

alter table club_onboarding enable row level security;
create policy t_club_onboarding on club_onboarding using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
alter table support_tickets enable row level security;
create policy t_support_tickets on support_tickets using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table support_messages enable row level security;
create policy t_support_messages on support_messages using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
alter table tenant_contracts enable row level security;
create policy t_tenant_contracts on tenant_contracts for select using (tenant_id = app_tenant());
