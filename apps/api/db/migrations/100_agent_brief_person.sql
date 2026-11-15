-- «Коротко о ситуации» прямо в карточке клиента (замечание тестировщика №18, 15.11.2026):
-- сводка по клиенту целиком — все события, кто с ним работал, разговоры и переписка.
alter table agent_briefs drop constraint agent_briefs_object_type_check;
alter table agent_briefs add constraint agent_briefs_object_type_check check (object_type in ('task', 'opportunity', 'process', 'person'));
