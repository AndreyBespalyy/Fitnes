-- Шаг 18, часть 2. Версии настроек клуба (FR-CFG-05/06/09/12, AT08–AT10, AT39).
-- Изменение настроек — это версия: черновик → проверка → утверждение → публикация; откат — новая версия из старой.
-- Утверждение привязано к содержимому (хешу): если черновик поменяли после утверждения, нужно утвердить заново.

create table config_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  number int not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'published', 'superseded', 'rejected')),
  source text not null check (source in ('human', 'ai', 'preset', 'rollback', 'initial')),
  title text not null,
  ai_request text,                 -- что попросили у ИИ-помощника словами
  data jsonb not null,             -- полный набор настроек этой версии
  base_data jsonb not null,        -- рабочие настройки в момент создания черновика: с чем сравнивать и куда откатываться
  data_hash text not null,
  checks jsonb,                    -- результат последней проверки
  checked_hash text,               -- для какого содержимого проверка
  approved_by uuid references users(id),
  approved_at timestamptz,
  approved_hash text,              -- что именно утвердили
  published_by uuid references users(id),
  published_at timestamptz,
  rolled_back_from uuid references config_versions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, number)
);
create index config_versions_club on config_versions (club_id, number desc);
-- Опубликованная (рабочая) версия у клуба одна
create unique index config_versions_published on config_versions (club_id) where status = 'published';

-- Защита в базе: опубликованное не переписывается; правка утверждённого снимает утверждение
create function config_version_guard() returns trigger language plpgsql as $$
begin
  if old.status in ('published', 'superseded', 'rejected') and new.data is distinct from old.data then
    raise exception 'Версия настроек % уже не черновик: изменения — только новой версией', old.number;
  end if;
  if new.data is distinct from old.data then
    new.updated_at := now();
    if old.status = 'approved' then
      new.status := 'draft'; new.approved_by := null; new.approved_at := null; new.approved_hash := null;
    end if;
  end if;
  if new.status = 'published' and old.status <> 'published' and (new.approved_hash is null or new.approved_hash <> new.data_hash) then
    raise exception 'Публикация без утверждения этого содержимого невозможна';
  end if;
  return new;
end $$;
create trigger config_versions_guard before update on config_versions for each row execute function config_version_guard();

-- Стандарт продаж (чек-лист разговора) с версиями: звонок оценивается по версии, действовавшей в момент звонка (FR-CFG-05/06)
create table sales_standards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  version_no int not null,
  items jsonb not null,            -- [{ id, text, weight }]
  config_version_id uuid references config_versions(id),
  valid_from timestamptz not null default now(),
  created_by uuid references users(id),
  unique (club_id, version_no)
);
create function sales_standard_locked() returns trigger language plpgsql as $$
begin
  raise exception 'Версия стандарта продаж не меняется: создайте новую';
end $$;
create trigger sales_standards_locked before update or delete on sales_standards for each row execute function sales_standard_locked();

do $$
declare t text;
begin
  foreach t in array array['config_versions', 'sales_standards'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
