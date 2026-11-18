-- Перенос из 1С: седьмой отчёт «Сотрудники» (18.11.2026). Учётные записи с ролью по должности; отмена переноса их убирает.
alter table import_files drop constraint if exists import_files_report_type_check;
alter table import_files add constraint import_files_report_type_check
  check (report_type in ('clients', 'memberships', 'payments', 'visits', 'balances', 'tasks', 'staff'));
alter table import_external_ids drop constraint if exists import_external_ids_entity_check;
alter table import_external_ids add constraint import_external_ids_entity_check
  check (entity in ('person', 'membership', 'payment', 'visit', 'debt', 'task', 'staff'));
alter table users add column import_batch_id uuid references import_batches(id);
create index users_import_batch on users (import_batch_id) where import_batch_id is not null;

create or replace function import_rollback(p_batch uuid, p_actor uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare b import_batches; u record;
begin
  select * into b from import_batches where id = p_batch for update;
  if b.id is null or b.tenant_id <> app_tenant() or not app_club_visible(b.club_id) then
    raise exception 'Перенос не найден' using errcode = 'P0002';
  end if;
  if b.status <> 'applied' then
    raise exception 'Отменить можно только перенесённый, но ещё не принятый пакет' using errcode = 'P0001';
  end if;
  delete from tasks where import_batch_id = p_batch;
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
  -- Сотрудники: удаляем учётную запись; если сотрудник уже успел поработать (есть ссылки на него), только блокируем и снимаем роли
  for u in select id from users where import_batch_id = p_batch loop
    begin
      delete from sessions where user_id = u.id;
      delete from user_assignments where user_id = u.id;
      delete from users where id = u.id;
    exception when foreign_key_violation then
      update users set status = 'blocked' where id = u.id;
      delete from user_assignments where user_id = u.id;
      delete from sessions where user_id = u.id;
    end;
  end loop;
  delete from import_external_ids where import_batch_id = p_batch;
  update import_rows set status = case when status = 'imported' then 'ok' else status end where batch_id = p_batch;
  update import_batches set status = 'rolled_back', rolled_back_at = now(), rolled_back_by = p_actor where id = p_batch;
end $$;
