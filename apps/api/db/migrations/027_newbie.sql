-- Программа первых 30 дней новичка (список «20 новых возможностей», п. 3).
-- После первой покупки система по шагам ставит задачи: вводная тренировка, звонок через неделю, проверка визитов за 2 недели, итог месяца.
create table newbie_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  enabled boolean not null default true,
  steps jsonb not null,               -- [{key, title, day, kind: 'intro'|'call'|'visits', minVisits?, assignTo: 'manager'|'trainer'}]
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table newbie_programs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  membership_id uuid not null references memberships(id),
  started_on date not null,
  status text not null default 'active' check (status in ('active', 'done', 'stopped')),
  created_at timestamptz not null default now(),
  unique (membership_id)
);
create index newbie_programs_club on newbie_programs (club_id, status);

create table newbie_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  program_id uuid not null references newbie_programs(id) on delete cascade,
  key text not null,
  kind text not null check (kind in ('intro', 'call', 'visits')),
  title text not null,
  due_on date not null,
  min_visits int,
  assign_to text not null default 'manager' check (assign_to in ('manager', 'trainer')),
  -- pending — срок не наступил; task — поставлена задача; done — задача выполнена; ok — шаг выполнен сам (визитов хватило, уже записан)
  status text not null default 'pending' check (status in ('pending', 'task', 'done', 'ok', 'skipped')),
  task_id uuid references tasks(id) on delete set null,
  visits int,
  closed_at timestamptz,
  unique (program_id, key)
);
create index newbie_steps_due on newbie_steps (club_id, status, due_on);

do $$
declare t text;
begin
  foreach t in array array['newbie_settings', 'newbie_programs', 'newbie_steps'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
