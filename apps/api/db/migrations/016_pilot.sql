-- Шаг 17. Доработки по приёмочным тестам перед пилотом.

-- AT01: попытка открыть клиента или сделку чужого клуба. Функция только отвечает «запись есть в сети, но не в ваших клубах»,
-- сами данные не возвращает. По ответу приложение пишет отказ в журнал аудита.
create function access_probe(p_kind text, p_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_kind = 'person' then return exists (select 1 from persons where id = p_id and tenant_id = app_tenant());
  elsif p_kind = 'opportunity' then return exists (select 1 from opportunities where id = p_id and tenant_id = app_tenant());
  end if;
  return false;
end $$;

-- AT23: сделку закрыли как продажу, а оплаты от клиента нет — пометка и задача РОПу
alter table opportunities add column won_unpaid boolean not null default false;

-- AT24: проверочная заявка от источника не создаёт клиента и сделку, только отмечает, что подключение работает
alter table lead_sources add column last_test_at timestamptz;
