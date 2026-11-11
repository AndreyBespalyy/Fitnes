-- Рабочее место тренера в приложении (список «20 новых возможностей», п. 14).
-- Тренер предлагает клиенту продлить пакет персональных и отмечает результат; согласие уходит менеджеру задачей на оформление.
create table trainer_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  trainer_id uuid not null references users(id),
  person_id uuid not null references persons(id),
  membership_id uuid references memberships(id),
  result text not null check (result in ('agreed', 'thinking', 'refused')),
  note text,
  task_id uuid,
  renewed_membership_id uuid references memberships(id),
  created_at timestamptz not null default now()
);
create index trainer_offers_trainer on trainer_offers (trainer_id, created_at desc);
create index trainer_offers_person on trainer_offers (person_id, created_at desc);

alter table trainer_offers enable row level security;
create policy t_trainer_offers on trainer_offers using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
