-- Предложения клуба для сайта: управляющий готовит и публикует, сайт забирает их по ключу.
alter table files drop constraint files_kind_check;
alter table files add constraint files_kind_check check (kind in ('club_document', 'contract_scan', 'signature', 'site_image'));

create table site_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  product_id uuid references products(id),
  title text not null check (length(title) between 2 and 120),
  description text check (length(description) <= 2000),
  price_kop bigint check (price_kop >= 0),
  old_price_kop bigint check (old_price_kop >= 0),
  price_note text check (length(price_note) <= 40),     -- «в месяц», «за 10 занятий»
  valid_from date,
  valid_to date,
  image_file_id uuid references files(id),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  sort int not null default 0,
  published_at timestamptz,
  created_by uuid references users(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index site_offers_club on site_offers (club_id, status, sort);

alter table site_offers enable row level security;
create policy t_site_offers on site_offers using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));

-- Картинка опубликованного предложения доступна сайту без входа
create function public_offer_image(p_offer uuid)
returns table (storage_path text, mime text)
language sql stable security definer set search_path = public as $$
  select f.storage_path, f.mime from site_offers o join files f on f.id = o.image_file_id
  where o.id = p_offer and o.status = 'published'
$$;
