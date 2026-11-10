-- Шаг 9. Перенос данных из 1С: пакет из пяти отчётов, промежуточные строки, карта полей,
-- таблица соответствия исходных номеров, библиотека проверенных карт, посещения.

-- Посещения. Сейчас их заполняет перенос из 1С, на шаге 11 сюда же пойдут проходы через турникет.
create table visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  membership_id uuid references memberships(id),
  visited_at timestamptz not null,
  source text not null default 'manual' check (source in ('import', 'acs', 'manual')),
  created_at timestamptz not null default now()
);
create index visits_person on visits (person_id, visited_at desc);
create index visits_club_time on visits (club_id, visited_at);

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  source_system text not null default '1c',
  status text not null default 'draft' check (status in ('draft', 'checked', 'applied', 'accepted', 'rolled_back')),
  report jsonb,                 -- отчёт сверки и полноты последнего пробного или настоящего переноса
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  checked_at timestamptz,
  applied_at timestamptz,
  applied_by uuid references users(id),
  accepted_at timestamptz,
  accepted_by uuid references users(id),
  rolled_back_at timestamptz,
  rolled_back_by uuid references users(id)
);

create table import_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  batch_id uuid not null references import_batches(id) on delete cascade,
  original_name text not null,
  sha256 text not null,
  size_bytes bigint not null,
  report_type text check (report_type in ('clients', 'memberships', 'payments', 'visits', 'balances')),
  detected_type text,
  confidence numeric(4, 3),     -- уверенность распознавания типа отчёта, 0…1
  headers jsonb not null,       -- названия колонок как в файле
  header_row int not null,      -- номер строки заголовка в файле (с 1)
  header_signature text not null,
  mapping jsonb not null,       -- наше поле → номер колонки, с уверенностью по каждому полю
  mapping_confirmed boolean not null default false,
  mapping_version int,          -- версия карты из библиотеки, по которой перенесено
  row_count int not null,
  uploaded_by uuid references users(id),
  uploaded_at timestamptz not null default now(),
  unique (batch_id, sha256)
);

create table import_rows (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  batch_id uuid not null references import_batches(id) on delete cascade,
  file_id uuid not null references import_files(id) on delete cascade,
  row_no int not null,          -- номер строки в исходном файле
  cells jsonb not null,         -- исходные значения как в файле, без изменений
  checksum text not null,
  status text not null default 'new' check (status in ('new', 'ok', 'warning', 'excluded', 'conflict', 'imported', 'skipped')),
  issue text,
  conflict_with text,           -- с кем совпало: описание найденной записи
  conflict_person_id uuid references persons(id),
  resolution text check (resolution in ('merge', 'new', 'skip')),
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  unique (file_id, row_no)
);
create index import_rows_batch on import_rows (batch_id, status);

-- Таблица соответствия: какая наша запись получена из какой строки какого отчёта (MIG-15).
create table import_external_ids (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  source_system text not null,
  entity text not null check (entity in ('person', 'membership', 'payment', 'visit', 'debt')),
  external_id text not null,
  target_id uuid not null,
  source_report_type text not null,
  source_file_id uuid not null references import_files(id),
  source_row_id int not null,
  mapping_version int,
  import_batch_id uuid not null references import_batches(id),
  checksum text not null,
  imported_at timestamptz not null default now(),
  unique (club_id, source_system, entity, external_id)
);
create index import_external_target on import_external_ids (target_id);

-- Библиотека проверенных карт полей: тот же формат отчёта у другого клуба идёт по готовой карте (MIG-08).
create table import_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source_system text not null,
  report_type text not null,
  header_signature text not null,
  headers jsonb not null,
  mapping jsonb not null,
  version int not null default 1,
  confirmed_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_system, header_signature)
);

-- Пометка «пришло из переноса» на записях, которые создаёт перенос: по ней работает откат до принятия.
alter table persons add column import_batch_id uuid references import_batches(id);
alter table products add column import_batch_id uuid references import_batches(id);
alter table price_versions add column import_batch_id uuid references import_batches(id);
alter table memberships add column import_batch_id uuid references import_batches(id);
alter table membership_operations add column import_batch_id uuid references import_batches(id);
alter table contracts add column import_batch_id uuid references import_batches(id);
alter table charges add column import_batch_id uuid references import_batches(id);
alter table payments add column import_batch_id uuid references import_batches(id);
alter table visits add column import_batch_id uuid references import_batches(id);

do $$
declare t text;
begin
  foreach t in array array['visits', 'import_batches', 'import_files', 'import_rows', 'import_external_ids'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
alter table import_templates enable row level security;
create policy t_import_templates on import_templates using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Откат переноса до принятия. Журнал платежей приложению удалять нельзя, поэтому удаление
-- делает эта функция и только для записей этого пакета, пока пакет не принят.
create function import_rollback(p_batch uuid, p_actor uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare b import_batches;
begin
  select * into b from import_batches where id = p_batch for update;
  if b.id is null or b.tenant_id <> app_tenant() or not app_club_visible(b.club_id) then
    raise exception 'Перенос не найден' using errcode = 'P0002';
  end if;
  if b.status <> 'applied' then
    raise exception 'Отменить можно только перенесённый, но ещё не принятый пакет' using errcode = 'P0001';
  end if;
  delete from payments where import_batch_id = p_batch;
  delete from visits where import_batch_id = p_batch;
  delete from charges where import_batch_id = p_batch;
  delete from contracts where import_batch_id = p_batch;
  delete from membership_operations where import_batch_id = p_batch;
  delete from memberships where import_batch_id = p_batch;
  delete from price_versions where import_batch_id = p_batch;
  delete from products where import_batch_id = p_batch;
  delete from person_contacts where person_id in (select id from persons where import_batch_id = p_batch);
  delete from persons where import_batch_id = p_batch;
  delete from import_external_ids where import_batch_id = p_batch;
  update import_rows set status = case when status = 'imported' then 'ok' else status end where batch_id = p_batch;
  update import_batches set status = 'rolled_back', rolled_back_at = now(), rolled_back_by = p_actor where id = p_batch;
end $$;
