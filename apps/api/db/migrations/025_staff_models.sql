-- Персонал (FR-STAFF-04, 06): модели оплаты тренера — за занятие, процент от стоимости персональных, аренда; норма нагрузки.
alter table pay_schemes add column trainer_model text not null default 'per_session' check (trainer_model in ('per_session', 'percent', 'rent'));
alter table pay_schemes add column trainer_percent numeric not null default 0 check (trainer_percent between 0 and 100); -- % от стоимости проведённых персональных
alter table pay_schemes add column rent_kop bigint not null default 0 check (rent_kop >= 0);                          -- аренда зала в месяц (тренер платит клубу)
alter table pay_schemes add column sessions_norm int check (sessions_norm between 1 and 1000);                        -- норма занятий в месяц для показателя нагрузки
