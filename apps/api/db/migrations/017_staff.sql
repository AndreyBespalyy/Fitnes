-- Шаг 18. Персонал: графики смен и замены (FR-STAFF-01, 08), табель с автофиксацией по СКУД и отметкам (FR-STAFF-02, 03),
-- зарплата по табелю и KPI, ведомость с расшифровкой и утверждением (FR-STAFF-04, 05, 07).

-- Смена в графике. Замена: user_id — кто работает (ему идёт оплата), replaced_user_id — кого заменяет.
create table staff_shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id),
  day date not null,
  starts time not null,
  ends time not null,
  break_minutes int not null default 0 check (break_minutes between 0 and 240),
  replaced_user_id uuid references users(id),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (user_id, day, starts)
);
create index staff_shifts_club_day on staff_shifts (club_id, day);

-- Отпуск, больничный, отгул
create table staff_absences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('vacation', 'sick', 'dayoff', 'unpaid')),
  date_from date not null,
  date_to date not null check (date_to >= date_from),
  comment text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Отметки прихода и ухода, кроме проходов по карте сотрудника (те берутся из access_events): кнопка в приложении и исправления руководителя
create table staff_marks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id),
  at timestamptz not null,
  direction text not null check (direction in ('in', 'out')),
  source text not null check (source in ('app', 'manual')),
  reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index staff_marks_user on staff_marks (user_id, at);

-- Схема оплаты сотрудника в клубе (действует с даты; новая запись — новая схема, старые расчёты не меняются)
create table pay_schemes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id),
  valid_from date not null,
  kind text not null check (kind in ('salary', 'hourly', 'shift', 'trainer')),
  rate_kop bigint not null default 0 check (rate_kop >= 0),          -- оклад в месяц / ставка за час / за смену / за занятие
  sales_percent numeric not null default 0 check (sales_percent between 0 and 100), -- процент от личных продаж
  plan_bonus_kop bigint not null default 0 check (plan_bonus_kop >= 0),           -- премия за выполнение личного плана
  plan_bonus_threshold int not null default 100 check (plan_bonus_threshold between 1 and 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (club_id, user_id, valid_from)
);

-- Ведомость за месяц по клубу. После утверждения не меняется, исправления — корректировкой в следующем месяце.
create table payroll_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  month date not null,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  calculated_at timestamptz,
  approved_by uuid references users(id),
  approved_at timestamptz,
  unique (club_id, month)
);

create table payroll_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  period_id uuid not null references payroll_periods(id) on delete cascade,
  user_id uuid not null references users(id),
  items jsonb not null,          -- [{code, title, basis, amountKop}]
  total_kop bigint not null,
  unique (period_id, user_id)
);

-- Ручные строки ведомости: занятия тренера, разовая премия, удержание, корректировка прошлого месяца
create table payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid not null references users(id),
  month date not null,
  kind text not null check (kind in ('sessions', 'bonus', 'deduction', 'correction')),
  quantity numeric,
  amount_kop bigint,
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Утверждённая ведомость неизменна даже напрямую в базе
create function payroll_locked() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from payroll_periods where id = coalesce(old.period_id, new.period_id);
  if st = 'approved' then raise exception 'Ведомость утверждена: изменения только корректировкой в следующем месяце'; end if;
  return coalesce(new, old);
end $$;
create trigger payroll_lines_locked before insert or update or delete on payroll_lines for each row execute function payroll_locked();
create function payroll_period_locked() returns trigger language plpgsql as $$
begin
  if old.status = 'approved' then raise exception 'Ведомость утверждена: изменения только корректировкой в следующем месяце'; end if;
  return new;
end $$;
create trigger payroll_periods_locked before update on payroll_periods for each row execute function payroll_period_locked();

do $$
declare t text;
begin
  foreach t in array array['staff_shifts', 'staff_absences', 'staff_marks', 'pay_schemes', 'payroll_periods', 'payroll_lines', 'payroll_adjustments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
