-- «Приведи друга» (список «20 новых возможностей», п. 8).
-- У клиента своя ссылка и код. Друг по ссылке оставляет заявку (источник «Рекомендация», видно, кто привёл) и получает скидку на первую покупку,
-- а клиент, когда друг купил, получает дни к абонементу.
alter table persons add column referral_code text;
create unique index persons_referral_code on persons (referral_code) where referral_code is not null;

create table referral_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  enabled boolean not null default true,
  friend_percent numeric not null default 10 check (friend_percent >= 0 and friend_percent <= 50),
  referrer_days int not null default 14 check (referrer_days between 0 and 90),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  referrer_id uuid not null references persons(id),
  friend_id uuid not null references persons(id),
  lead_id uuid references leads(id),
  via text not null default 'link' check (via in ('link', 'staff')),
  -- lead — заявка; bought — друг купил; rewarded — бонус начислен; reward_manual — начислить вручную (нет срочного абонемента)
  status text not null default 'lead' check (status in ('lead', 'bought', 'rewarded', 'reward_manual')),
  membership_id uuid references memberships(id),
  revenue_kop bigint,
  friend_discount_kop bigint,
  reward_days int,
  reward_membership_id uuid references memberships(id),
  task_id uuid references tasks(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  bought_at timestamptz,
  unique (club_id, friend_id),
  check (referrer_id <> friend_id)
);
create index referrals_referrer on referrals (referrer_id);

alter table membership_operations drop constraint membership_operations_kind_check;
alter table membership_operations add constraint membership_operations_kind_check
  check (kind in ('sale', 'renewal', 'freeze', 'unfreeze', 'cancel', 'charge_paid', 'subscription_period', 'class_charge', 'bonus_days'));

do $$
declare t text;
begin
  foreach t in array array['referral_settings', 'referrals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Публичная страница приглашения: по коду найти сеть, клиента и его клуб до того, как известна сеть
create function referral_lookup(p_code text)
returns table (tenant_id uuid, person_id uuid, first_name text, club_id uuid, club_name text)
language sql stable security definer set search_path = public as $$
  select p.tenant_id, p.id, split_part(p.full_name, ' ', 1), c.id, c.name
  from persons p
  join lateral (select m.club_id from memberships m where m.person_id = p.id and m.status <> 'cancelled' order by m.created_at desc limit 1) m on true
  join clubs c on c.id = m.club_id
  where p.referral_code = upper(p_code) and p.merged_into_id is null
$$;
