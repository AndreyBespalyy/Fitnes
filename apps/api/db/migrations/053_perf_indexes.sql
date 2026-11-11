-- Индексы для объёма настоящей сети (п. 14 списка «20 улучшений»): 30 тыс. клиентов, 1 млн посещений, 3 года оплат.
-- Подобраны по замерам npm run perf на базе fitnes_perf.
create extension if not exists pg_trgm;

-- Телефон клиента берётся почти в каждом списке: без индекса — полный просмотр контактов на каждую строку
create index if not exists person_contacts_person on person_contacts (person_id) include (is_primary, type, value);
-- Поиск по части телефона и по части фамилии
create index if not exists person_contacts_norm_trgm on person_contacts using gin (normalized_value gin_trgm_ops);
create index if not exists persons_name_trgm on persons using gin (full_name gin_trgm_ops);
create index if not exists persons_club_name on persons (home_club_id, full_name) where merged_into_id is null;

create index if not exists memberships_club_created on memberships (club_id, created_at);
create index if not exists memberships_renewed_from on memberships (renewed_from_id) where renewed_from_id is not null;
create index if not exists memberships_club_ends on memberships (club_id, ends_on) where status = 'active';
create index if not exists charges_membership on charges (membership_id);
create index if not exists charges_club_due on charges (club_id, status, due_on);
create index if not exists payments_charge on payments (charge_id) where charge_id is not null;
create index if not exists payments_person on payments (person_id, created_at) where person_id is not null;
create index if not exists opportunities_person on opportunities (person_id, status);
create index if not exists leads_person on leads (person_id);
create index if not exists tasks_person on tasks (person_id) where person_id is not null;
create index if not exists visits_membership on visits (membership_id) where membership_id is not null;
create index if not exists audit_log_object on audit_log (object_id, at);
create index if not exists audit_log_tenant_at on audit_log (tenant_id, at);

-- JIT-компиляция запросов на наших коротких запросах только мешает: на поиске по телефону 300 мс из 500 уходили на неё
do $$ begin execute format('alter database %I set jit = off', current_database()); end $$;

-- Поиск по части телефона или имени. Под защитой строк (RLS) индекс по частям текста не используется,
-- поэтому кандидатов ищем функцией с явным условием на сеть; видимость клиента по клубам затем проверяет RLS на persons
create or replace function person_ids_by_phone(p_digits text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct person_id from person_contacts
  where tenant_id = app_tenant() and length(p_digits) >= 4 and normalized_value like '%' || p_digits || '%'
$$;
create or replace function person_ids_by_name(p_text text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from persons
  where tenant_id = app_tenant() and length(p_text) >= 2 and merged_into_id is null
    and full_name ilike '%' || replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;
