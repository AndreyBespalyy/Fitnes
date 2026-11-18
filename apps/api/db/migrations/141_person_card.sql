-- Карточка клиента по замечаниям тестировщиков 18.11.2026 (№31, 32, 47, 48).
-- №31: фото документов клиента с камеры телефона (паспорт, справка) — файлы в общем хранилище, список в карточке.
alter table files drop constraint files_kind_check;
alter table files add constraint files_kind_check check (kind in ('club_document', 'contract_scan', 'signature', 'site_image', 'call_record', 'person_document'));

create table person_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id) on delete cascade,
  file_id uuid not null references files(id),
  title text not null check (length(title) between 1 and 120),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index person_documents_person on person_documents (person_id, created_at desc);
alter table person_documents enable row level security;
create policy t_person_documents on person_documents using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- №48: ответственный менеджер клиента; если продавали вдвоём — второй менеджер и его доля (в процентах).
alter table persons add column owner_id uuid references users(id);
alter table persons add column co_owner_id uuid references users(id);
alter table persons add column co_owner_share int check (co_owner_share between 1 and 99);
alter table persons add constraint persons_co_owner_check check (co_owner_id is null or (owner_id is not null and co_owner_id <> owner_id and co_owner_share is not null));
