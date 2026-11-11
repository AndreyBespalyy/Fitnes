-- Быстрый режим ресепшна (список «20 новых возможностей», п. 15).
-- Проход, отмеченный администратором после проверки системой, — отдельный вид события 'desk' (не путать с ручным проходом вопреки правилам).
alter table access_events drop constraint access_events_mode_check;
alter table access_events add constraint access_events_mode_check check (mode in ('online', 'offline', 'manual', 'emulator', 'desk'));

-- Фото клиента для сверки на ресепшне. Хранится у нас, наружу не уходит (ТЗ 6.3).
create table person_photos (
  person_id uuid primary key references persons(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  image bytea not null,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);
alter table person_photos enable row level security;
create policy t_person_photos on person_photos using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Замер скорости: сколько времени и нажатий заняла операция от поиска клиента до результата
create table desk_ops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid references users(id),
  op text not null check (op in ('pass', 'single', 'renew', 'goods', 'pay_debt', 'new_client', 'manual_pass')),
  ms integer not null check (ms >= 0),
  taps integer not null check (taps >= 0),
  created_at timestamptz not null default now()
);
create index desk_ops_club on desk_ops (club_id, created_at desc);
alter table desk_ops enable row level security;
create policy t_desk_ops on desk_ops using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id));
