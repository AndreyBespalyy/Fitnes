-- Расписание занятий и запись клиентов (FR-MEM-12): залы, виды занятий, занятия, запись, лист ожидания, напоминания,
-- списание персональных из пакета, проведённые занятия — в зарплату тренера.

create table rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  capacity int check (capacity between 1 and 500),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);

create table class_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  name text not null,
  kind text not null check (kind in ('group', 'personal')),
  duration_min int not null default 60 check (duration_min between 10 and 480),
  capacity int not null default 15 check (capacity between 1 and 500),
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);

create table class_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  type_id uuid not null references class_types(id),
  room_id uuid references rooms(id),
  trainer_id uuid references users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  capacity int not null check (capacity between 1 and 500),
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  series_id uuid,                              -- занятия, созданные одним повтором «каждую неделю»
  note text,
  cancel_reason text,
  done_at timestamptz,
  done_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index class_sessions_club_time on class_sessions (club_id, starts_at);
create index class_sessions_trainer on class_sessions (trainer_id, starts_at);

create table class_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  session_id uuid not null references class_sessions(id),
  person_id uuid not null references persons(id),
  membership_id uuid references memberships(id),  -- null: пробное занятие
  trial boolean not null default false,
  status text not null check (status in ('booked', 'waitlist', 'cancelled', 'attended', 'no_show')),
  waitlist_at timestamptz,
  late_cancel boolean not null default false,
  charged boolean not null default false,      -- списано из пакета персональных
  reminded_24 boolean not null default false,
  reminded_2 boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references users(id),
  marked_at timestamptz,
  marked_by uuid references users(id)
);
create unique index class_bookings_once on class_bookings (session_id, person_id) where status <> 'cancelled';
create index class_bookings_person on class_bookings (person_id, created_at desc);
create index class_bookings_remind on class_bookings (session_id) where status = 'booked' and not reminded_2;

create table club_class_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  late_cancel_hours int not null default 12 check (late_cancel_hours between 0 and 72),
  charge_personal_late boolean not null default true,   -- персональное: поздняя отмена и неявка списываются
  charge_group_no_show boolean not null default false,  -- групповое: неявка списывает посещение из пакета посещений
  no_show_limit int check (no_show_limit between 1 and 20), -- null: не ограничивать запись за неявки
  no_show_block_days int not null default 7 check (no_show_block_days between 1 and 90),
  remind_24 boolean not null default true,
  remind_2 boolean not null default true,
  book_ahead_days int not null default 14 check (book_ahead_days between 1 and 90),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

alter table membership_operations drop constraint membership_operations_kind_check;
alter table membership_operations add constraint membership_operations_kind_check
  check (kind in ('sale', 'renewal', 'freeze', 'unfreeze', 'cancel', 'charge_paid', 'subscription_period', 'class_charge'));

do $$
declare t text;
begin
  foreach t in array array['rooms', 'class_types', 'class_sessions', 'class_bookings', 'club_class_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
