-- Объём настоящей сети для проверки скорости (п. 14 списка «20 улучшений»).
-- Запускается только на отдельной базе fitnes_perf скриптом perf.ts, никогда на рабочей.
-- :persons — сколько клиентов (по умолчанию 30 000), :visits — сколько посещений (1 000 000).
select setseed(0.42);

create temp table g_clubs as
  select c.id, c.tenant_id, c.sales_model, row_number() over (order by (c.name like $$%Центр%$$) desc, c.name) as n
  from clubs c;

create temp table g_users as select id, row_number() over (order by login) as n from users;

-- Клиенты: 60 % в «Центре», 40 % в «Севере», созданы равномерно за 3 года
create temp table g_persons as
select gen_random_uuid() as id, i,
       (select id from g_clubs where n = case when i % 10 < 6 then 1 else 2 end) as club_id,
       now() - (random() * interval '1095 days') as created_at
from generate_series(1, :persons) i;

insert into persons (id, tenant_id, home_club_id, full_name, birth_date, segment, created_at, updated_at)
select p.id, c.tenant_id, p.club_id,
       (array['Иванов','Смирнов','Кузнецов','Попов','Васильев','Петров','Соколов','Михайлов','Новиков','Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров'])[1 + p.i % 16]
         || case when p.i % 2 = 0 then 'а ' else ' ' end
         || case when p.i % 2 = 0
              then (array['Анна','Мария','Елена','Ольга','Наталья','Татьяна','Ирина','Светлана','Юлия','Дарья'])[1 + (p.i / 2) % 10]
              else (array['Александр','Сергей','Дмитрий','Андрей','Алексей','Максим','Иван','Михаил','Артём','Павел'])[1 + (p.i / 2) % 10] end
         || ' ' || p.i,
       date '1965-01-01' + (random() * 15000)::int,
       (array['действующий','бывший','лид','на продление','отказ','активный подписчик'])[1 + (p.i % 6)],
       p.created_at, p.created_at
from g_persons p join g_clubs c on c.id = p.club_id;

insert into person_contacts (tenant_id, person_id, type, value, normalized_value, is_primary)
select c.tenant_id, p.id, 'phone', '+7926' || lpad(p.i::text, 7, '0'), '+7926' || lpad(p.i::text, 7, '0'), true
from g_persons p join g_clubs c on c.id = p.club_id;

insert into person_contacts (tenant_id, person_id, type, value, normalized_value, is_primary)
select c.tenant_id, p.id, 'email', 'client' || p.i || '@example.ru', 'client' || p.i || '@example.ru', false
from g_persons p join g_clubs c on c.id = p.club_id where p.i % 3 = 0;

-- Абонементы: у 85 % клиентов от 1 до 3 подряд; «Центр» — на срок, «Север» — подписка
create temp table g_products as
select pr.club_id, pr.id as product_id, pv.id as price_version_id, pr.kind, pr.name, coalesce(pr.duration_days, 30) as days,
       row_number() over (partition by pr.club_id order by pr.sort, pr.name) as n
from products pr
join lateral (select id from price_versions where product_id = pr.id order by created_at desc limit 1) pv on true
where pr.kind in ('term', 'subscription') and pr.is_active;

create temp table g_ms as
select gen_random_uuid() as id, p.id as person_id, p.club_id, p.i, k,
       (p.created_at::date + (k - 1) * 200 + (random() * 20)::int) as starts_on
from g_persons p cross join generate_series(1, 3) k
where p.i % 20 <> 0 and k <= 1 + p.i % 3;
delete from g_ms where starts_on > current_date;

insert into memberships (id, tenant_id, club_id, person_id, product_id, price_version_id, kind, product_name, amount_kop,
                         status, starts_on, ends_on, sale_category, created_at, updated_at, list_price_kop, discount_kop)
select m.id, c.tenant_id, m.club_id, m.person_id, pr.product_id, pr.price_version_id, pr.kind, pr.name,
       case when pr.kind = 'subscription' then 390000 else (case when pr.days > 100 then 3600000 else 450000 end) end,
       case when m.i % 17 = 0 then 'cancelled' else 'active' end,
       m.starts_on,
       case when pr.kind = 'subscription' then null else m.starts_on + pr.days end,
       case when pr.kind = 'subscription' then 'subscription' when m.k = 1 then 'new' else 'renewal' end,
       m.starts_on::timestamptz + interval '10 hours', m.starts_on::timestamptz + interval '10 hours',
       case when pr.kind = 'subscription' then 390000 else (case when pr.days > 100 then 3600000 else 450000 end) end, 0
from g_ms m join g_clubs c on c.id = m.club_id
join g_products pr on pr.club_id = m.club_id and pr.n = 1 + m.i % (select count(*) from g_products x where x.club_id = m.club_id);

insert into contracts (tenant_id, club_id, person_id, membership_id, number, contract_date, status, sign_method, signed_at, created_at)
select c.tenant_id, m.club_id, m.person_id, m.id, 'P-' || m.i || '-' || m.k, m.starts_on, 'signed', 'paper_scan',
       m.starts_on::timestamptz + interval '10 hours', m.starts_on::timestamptz + interval '10 hours'
from g_ms m join g_clubs c on c.id = m.club_id;

-- Начисления: на срок — одно; подписка — каждый месяц до сегодня (до 12)
create temp table g_charges as
select gen_random_uuid() as id, m.id as membership_id, m.person_id, m.club_id, ms.kind, ms.amount_kop,
       (m.starts_on + (n * interval '1 month'))::date as due_on, m.i, n
from g_ms m join memberships ms on ms.id = m.id
cross join generate_series(0, 11) n
where (ms.kind = 'subscription' or n = 0) and (m.starts_on + (n * interval '1 month'))::date <= current_date + 5;

insert into charges (id, tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop, status, paid_at, paid_method, created_at)
select g.id, c.tenant_id, g.club_id, g.membership_id, g.person_id,
       case when g.kind = 'subscription' then 'subscription' else 'full' end,
       case when g.kind = 'subscription' then 'Подписка, месяц ' || (g.n + 1) else 'Абонемент' end,
       g.due_on, g.amount_kop,
       case when g.due_on > current_date - 3 and (g.i + g.n) % 4 = 0 then 'due' else 'paid' end,
       case when g.due_on > current_date - 3 and (g.i + g.n) % 4 = 0 then null else g.due_on::timestamptz + interval '11 hours' end,
       case when g.due_on > current_date - 3 and (g.i + g.n) % 4 = 0 then null else (array['card_terminal','sbp','online'])[1 + (g.i + g.n) % 3] end,
       g.due_on::timestamptz + interval '9 hours'
from g_charges g join g_clubs c on c.id = g.club_id;

insert into payments (tenant_id, club_id, direction, kind, amount_kop, method, person_id, charge_id, sale_category, created_at)
select ch.tenant_id, ch.club_id, 'in', 'charge', ch.amount_kop, ch.paid_method, ch.person_id, ch.id, ms.sale_category, ch.paid_at
from charges ch join g_charges g on g.id = ch.id join memberships ms on ms.id = ch.membership_id
where ch.status = 'paid';

-- Посещения: только у клиентов с абонементом, в часы работы клуба, за весь срок абонементов
create temp table g_active as
select m.id as membership_id, m.person_id, m.club_id, ms.starts_on, least(coalesce(ms.ends_on, current_date), current_date) as till,
       row_number() over () as rn
from g_ms m join memberships ms on ms.id = m.id;
create index on g_active (rn);

insert into visits (tenant_id, club_id, person_id, membership_id, visited_at, source, created_at, exit_at)
select c.tenant_id, a.club_id, a.person_id, a.membership_id, t.at, 'acs', t.at, t.at + interval '80 minutes'
from (select (1 + floor(random() * (select count(*) from g_active)))::bigint as rn from generate_series(1, :visits)) r
join g_active a on a.rn = r.rn
join g_clubs c on c.id = a.club_id
cross join lateral (select (a.starts_on + floor(random() * greatest(1, a.till - a.starts_on + 1))::int)::timestamptz
                           + interval '7 hours' + random() * interval '15 hours' + (r.rn * interval '0 second') as at) t
where a.till >= a.starts_on;

-- Заявки и сделки: 12 000 за 3 года, у трети — задачи
create temp table g_leads as
select gen_random_uuid() as lead_id, gen_random_uuid() as opp_id, p.id as person_id, p.club_id, p.created_at, p.i
from g_persons p where p.i % 5 < 2;

insert into opportunities (id, tenant_id, club_id, person_id, pipeline_id, stage_id, owner_id, status, created_at, updated_at, closed_at)
select l.opp_id, c.tenant_id, l.club_id, l.person_id, pl.id, st.id,
       (select id from g_users where n = 1 + l.i % (select count(*) from g_users)),
       st.kind, l.created_at, l.created_at, case when st.kind = 'open' then null else l.created_at + interval '5 days' end
from g_leads l join g_clubs c on c.id = l.club_id
join pipelines pl on pl.club_id = l.club_id and pl.is_default_for_leads
join lateral (select id, kind from pipeline_stages s where s.pipeline_id = pl.id
              order by ((s.kind = 'open') = (l.created_at > now() - interval '60 days')) desc, random() + l.i * 0 limit 1) st on true;

insert into leads (id, tenant_id, club_id, person_id, opportunity_id, comment, first_response_due_at, first_response_at, created_at)
select l.lead_id, c.tenant_id, l.club_id, l.person_id, l.opp_id, 'Заявка с сайта', l.created_at + interval '15 minutes',
       l.created_at + interval '7 minutes', l.created_at
from g_leads l join g_clubs c on c.id = l.club_id;

insert into tasks (tenant_id, club_id, assignee_id, person_id, opportunity_id, kind, title, due_at, done_at, created_at)
select c.tenant_id, l.club_id, (select id from g_users where n = 1 + l.i % (select count(*) from g_users)), l.person_id, l.opp_id,
       'call', 'Перезвонить клиенту', l.created_at + interval '1 day',
       case when l.created_at < now() - interval '14 days' then l.created_at + interval '1 day' end, l.created_at
from g_leads l join g_clubs c on c.id = l.club_id where l.i % 3 = 0;

-- Журнал действий: 200 000 записей
insert into audit_log (tenant_id, actor_id, action, object_type, object_id, after, at)
select c.tenant_id, u.id, (array['person.update','membership.create','payment.create','visit.manual','task.done'])[1 + j % 5], 'person',
       p.id, '{"perf":true}'::jsonb, now() - random() * interval '1095 days'
from generate_series(1, 200000) j
join g_persons p on p.i = 1 + (j % :persons)
join g_clubs c on c.id = p.club_id
join g_users u on u.n = 1 + j % (select count(*) from g_users);

analyze;
