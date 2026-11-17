-- Советы по переписке учатся на отзывах (17.11.2026): каждый совет записывается в agent_suggestions (kind msg_<тема>),
-- «Начать» засчитывается как сделано, «Скрыть» — как «Не то». Тип, который в клубе отключён или выключился сам, больше не показывается.
alter table team_advice add column suggestion_id uuid references agent_suggestions(id) on delete set null;
