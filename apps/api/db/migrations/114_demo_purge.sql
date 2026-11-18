-- Удаление демо-данных клуба (решение Андрея 18.11.2026): после переноса настоящей базы из 1С в клубе остаются
-- выдуманные клиенты из тестового наполнения. Удаляются клиенты клуба, не перенесённые из 1С, и всё, что на них
-- ссылается (абонементы, посещения, оплаты, задачи, звонки, переписка и т.д.). Данные из 1С защищены проверкой:
-- если удаление задело хоть одну перенесённую запись, всё отменяется.

-- Удаляет строки таблицы по id и, сначала, всё, что на них ссылается (по внешним ключам). Возвращает счётчики по таблицам.
create or replace function purge_rows(p_tab regclass, p_ids uuid[], p_depth int, p_acc jsonb)
returns jsonb
language plpgsql set search_path = public as $$
declare fk record; child uuid[]; n int; acc jsonb := p_acc;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return acc; end if;
  if p_depth > 12 then raise exception 'Слишком глубокие связи у таблицы %', p_tab; end if;
  for fk in
    select c.conrelid::regclass as tab, a.attname as col,
      exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'id' and not x.attisdropped) as has_id
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pk on pk.attrelid = c.confrelid and pk.attnum = c.confkey[1]
    where c.contype = 'f' and c.confrelid = p_tab and cardinality(c.conkey) = 1 and pk.attname = 'id'
      and c.confdeltype in ('a', 'r', 'c')
  loop
    if fk.has_id then
      execute format('select array_agg(id) from %s where %I = any($1)', fk.tab, fk.col) into child using p_ids;
      if fk.tab = p_tab then child := array(select unnest(child) except select unnest(p_ids)); end if;
      acc := purge_rows(fk.tab, child, p_depth + 1, acc);
    else
      execute format('delete from %s where %I = any($1)', fk.tab, fk.col) using p_ids;
      get diagnostics n = row_count;
      if n > 0 then acc := jsonb_set(acc, array[fk.tab::text], to_jsonb(coalesce((acc ->> fk.tab::text)::int, 0) + n)); end if;
    end if;
  end loop;
  execute format('delete from %s where id = any($1)', p_tab) using p_ids;
  get diagnostics n = row_count;
  if n > 0 then acc := jsonb_set(acc, array[p_tab::text], to_jsonb(coalesce((acc ->> p_tab::text)::int, 0) + n)); end if;
  return acc;
end $$;
revoke all on function purge_rows(regclass, uuid[], int, jsonb) from public;

create or replace function demo_purge(p_club uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; before jsonb; after jsonb; acc jsonb;
begin
  if not exists (select 1 from clubs where id = p_club and tenant_id = app_tenant()) or not app_club_visible(p_club) then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  ids := array(select id from persons where tenant_id = app_tenant() and home_club_id = p_club and import_batch_id is null);
  before := jsonb_build_object(
    'persons', (select count(*) from persons where home_club_id = p_club and import_batch_id is not null),
    'memberships', (select count(*) from memberships where club_id = p_club and import_batch_id is not null),
    'payments', (select count(*) from payments where club_id = p_club and import_batch_id is not null),
    'visits', (select count(*) from visits where club_id = p_club and import_batch_id is not null));
  acc := purge_rows('persons'::regclass, ids, 0, '{}'::jsonb);
  after := jsonb_build_object(
    'persons', (select count(*) from persons where home_club_id = p_club and import_batch_id is not null),
    'memberships', (select count(*) from memberships where club_id = p_club and import_batch_id is not null),
    'payments', (select count(*) from payments where club_id = p_club and import_batch_id is not null),
    'visits', (select count(*) from visits where club_id = p_club and import_batch_id is not null));
  if before <> after then
    raise exception 'Удаление задело данные, перенесённые из 1С: ничего не удалено' using errcode = 'P0001';
  end if;
  return acc;
end $$;
