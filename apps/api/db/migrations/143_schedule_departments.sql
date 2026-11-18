-- Расписание по подразделениям (замечание №37): ТЗ — тренажёрный зал, ГП — групповые программы, БК и другие — как назовёт клуб.
alter table class_types add column department text check (length(department) between 1 and 40);
update class_types set department = case when kind = 'personal' then 'ТЗ' else 'ГП' end where department is null;
