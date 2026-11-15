-- ИИ-агент (просьба Андрея 14.11.2026, вариант 4А): утренние «3 подсказки на сегодня» каждому сотруднику.
-- В заданный час (местное время клуба) помощник присылает в «ИИ-помощник» три самых полезных шага на день
-- по данным CRM: заявки и переписка без ответа, просроченные задачи, горячие клиенты, занятия и новички, план продаж.
alter table agent_settings add column morning_hints boolean not null default true;
alter table agent_settings add column morning_hour int not null default 9 check (morning_hour between 5 and 12);
