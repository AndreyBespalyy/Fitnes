-- Журнал замечаний тестировщика (просьба Андрея 13.11.2026): на каждой странице CRM окно, где тестировщик пишет
-- замечания и пожелания именно к этой странице. Запись привязана к странице (раздел + вкладка, карточка — одна на тип) и роли.
-- Каждый день Claude забирает новые записи по ключу, раскладывает их по смыслу и кладёт сводку по каждой странице обратно в CRM.

-- Кому показывать окно журнала. Тестовым сотрудникам — сразу; настоящим сотрудникам клубов окно не показывается
alter table users add column is_tester boolean not null default false;
update users set is_tester = true where lower(login) in (
  'a.bespalyy', 'i.kotova', 'o.smirnov', 'o.astafeva', 'm.volkova', 'd.lis', 'e.orlova', 'a.kim',
  's.pavlov', 'n.belova', 'i.zuev', 'a.morozova', 'v.gusev', 'p.ershova');

create table test_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number int not null,                          -- короткий номер для разговора: «замечание № 17»
  user_id uuid not null references users(id),
  role_code text not null,                      -- роль, в которой тестировали (главная роль сотрудника)
  club_id uuid references clubs(id),
  page_key text not null check (page_key ~ '^[a-z0-9_-]{1,40}(:.{1,80})?$'), -- раздел и вкладка: «finance:Сверка», карточка: «card:person»
  page_label text not null check (length(page_label) <= 160), -- «Финансы → Сверка»
  kind text check (kind in ('bug', 'ux', 'idea')),             -- ошибка / неудобно / пожелание (необязательно)
  body text not null check (length(body) between 1 and 4000),
  shot_path text,                               -- скриншот на диске (storage/test-notes/…)
  shot_mime text,
  status text not null default 'new' check (status in ('new', 'in_work', 'done', 'rejected')),
  status_note text check (length(status_note) <= 1000),        -- ответ тестировщику: что сделано или почему нет
  status_at timestamptz,
  created_at timestamptz not null default now()
);
create index test_notes_page on test_notes (tenant_id, page_key, created_at);
create index test_notes_user on test_notes (user_id, page_key);
create index test_notes_new on test_notes (tenant_id, created_at) where status = 'new';

-- Сводный файл по странице: Claude разбирает записи по смыслу и кладёт сюда текст (Markdown)
create table test_note_summaries (
  tenant_id uuid not null references tenants(id),
  page_key text not null,
  page_label text not null,
  body_md text not null check (length(body_md) <= 100000),
  notes_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, page_key)
);

-- Ключ выгрузки для ежедневного разбора: хранится только отпечаток
create table test_note_keys (
  tenant_id uuid primary key references tenants(id),
  key_hash text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

do $$ declare t text; begin
  foreach t in array array['test_notes', 'test_note_summaries', 'test_note_keys'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t, t);
  end loop;
end $$;

-- Выгрузка по ключу: до проверки ключа сеть ещё неизвестна
create function auth_test_notes_key(p_key_hash text)
returns table (tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select k.tenant_id from test_note_keys k where k.key_hash = p_key_hash
$$;
