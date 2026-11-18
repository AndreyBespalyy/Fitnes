-- «Мой месяц» на рабочем столе менеджера (замечание №34): добавляем окно и тем, кто уже настроил свой стол
update dash_role_layouts set widgets = array_append(widgets, 'my_month')
  where role_code = 'manager' and not ('my_month' = any(widgets));
update dash_layouts l set widgets = array_append(l.widgets, 'my_month')
  where not ('my_month' = any(l.widgets))
    and exists (select 1 from user_assignments a where a.user_id = l.user_id and a.role_code = 'manager');
