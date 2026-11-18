-- «Тренер хаб» (замечание №34, пояснение Андрея 18.11.2026): отдельная воронка продаж персональных тренировок
-- рядом с «Новыми клиентами» и «Продлениями». Добавляем во все клубы, где её ещё нет; новым клубам она приходит из готовых настроек.
do $$
declare c record; pid uuid;
begin
  for c in select id, tenant_id from clubs loop
    if not exists (select 1 from pipelines where club_id = c.id and name = 'Тренер хаб') then
      insert into pipelines(tenant_id, club_id, name, purpose, sort)
        values (c.tenant_id, c.id, 'Тренер хаб', 'custom', coalesce((select max(sort) + 1 from pipelines where club_id = c.id), 10)) returning id into pid;
      insert into pipeline_stages(tenant_id, pipeline_id, name, kind, sort) values
        (c.tenant_id, pid, 'Передан тренеру', 'open', 1), (c.tenant_id, pid, 'Вводная назначена', 'open', 2), (c.tenant_id, pid, 'Вводная проведена', 'open', 3),
        (c.tenant_id, pid, 'Купил персональные', 'won', 4), (c.tenant_id, pid, 'Отказ', 'lost', 5);
    end if;
  end loop;
end $$;
