-- Бонусная программа лояльности (список «20 новых возможностей», п. 18).
-- Баллы за визиты, покупки, продления, рекомендации и отзывы; уровни клиента; трата на товары, персональные и дни абонемента.
-- Баллы — не деньги: в журнал платежей не попадают, списание — отдельной строкой, ничего не переписывается.
create table club_loyalty (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  enabled boolean not null default false,
  enabled_at timestamptz,
  point_value_kop integer not null default 100 check (point_value_kop between 1 and 10000),   -- сколько стоит 1 балл при трате
  visit_points integer not null default 10 check (visit_points between 0 and 10000),
  purchase_percent numeric(5,2) not null default 3 check (purchase_percent between 0 and 50), -- % от оплаты баллами
  renewal_points integer not null default 300 check (renewal_points between 0 and 100000),
  referral_points integer not null default 1000 check (referral_points between 0 and 100000),
  review_points integer not null default 100 check (review_points between 0 and 100000),
  expire_days integer not null default 365 check (expire_days between 30 and 1825),
  spend_goods boolean not null default true,
  day_price_points integer not null default 300 check (day_price_points between 1 and 100000),
  personal_price_points integer not null default 2500 check (personal_price_points between 1 and 1000000),
  levels jsonb not null default '[{"code":"base","name":"Базовый","minMonths":0,"minSpendKop":0,"bonusPercent":0},{"code":"silver","name":"Серебро","minMonths":6,"minSpendKop":3000000,"bonusPercent":25},{"code":"gold","name":"Золото","minMonths":12,"minSpendKop":6000000,"bonusPercent":50}]',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
alter table club_loyalty enable row level security;
create policy t_club_loyalty on club_loyalty using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));

create table loyalty_moves (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('visit', 'purchase', 'refund', 'renewal', 'referral', 'review', 'spend_goods', 'spend_days', 'spend_personal', 'expire', 'correction')),
  points integer not null check (points <> 0),
  ref_id uuid,                      -- посещение, платёж, абонемент, рекомендация, опрос, продажа
  expires_on date,                  -- для начислений
  level_code text,
  comment text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index loyalty_moves_once on loyalty_moves (club_id, kind, ref_id) where ref_id is not null and kind in ('visit', 'purchase', 'refund', 'renewal', 'referral', 'review');
create index loyalty_moves_person on loyalty_moves (person_id, club_id, created_at desc);
alter table loyalty_moves enable row level security;
create policy t_loyalty_moves on loyalty_moves using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
