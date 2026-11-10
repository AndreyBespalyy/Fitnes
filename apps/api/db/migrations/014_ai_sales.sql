-- Шаг 15. ИИ-функции продаж: приоритет клиентов (FR-AI-04), горячие списки (FR-AI-06), маршрутизация (FR-AI-05),
-- история оценок для «теневого режима» и автосообщения неприоритетным клиентам.

-- Текущая оценка клиента по задаче: покупка (лид в работе), продление, возврат бывшего, риск ухода.
-- segment: hot — звонить первым; warm — звонить после горячих; auto — неприоритетный, ему автосообщение;
-- low — продление и удержание без срочности; excluded — сказал «нет» или не может купить, из обзвона исключён.
create table client_scores (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  person_id uuid not null references persons(id),
  kind text not null check (kind in ('purchase', 'renewal', 'return', 'churn')),
  score numeric not null check (score between 0 and 1),
  segment text not null check (segment in ('hot', 'warm', 'auto', 'low', 'excluded')),
  owner_id uuid references users(id),           -- ответственный менеджер; null — общий список клуба
  opportunity_id uuid references opportunities(id) on delete set null,
  reasons jsonb not null default '[]',          -- почему такая оценка: [{text, effect: + | -}]
  offer jsonb,                                  -- индивидуальное предложение по действующему прейскуранту
  model text not null,                          -- версия модели
  computed_at timestamptz not null default now(),
  primary key (club_id, person_id, kind)
);
create index client_scores_list on client_scores (club_id, kind, score desc);
create index client_scores_owner on client_scores (owner_id, score desc);

-- Обученные модели клуба (логистическая регрессия на закрытых сделках клуба) и их качество на отложенной выборке
create table ai_models (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  kind text not null,
  version text not null,
  weights jsonb not null,
  metrics jsonb not null,
  trained_at timestamptz not null default now(),
  primary key (club_id, kind)
);

-- Ежедневный снимок оценок (первый расчёт дня): по нему в «теневом режиме» сравниваем, кто купил и был ли он в списке
create table ai_score_history (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  day date not null,
  person_id uuid not null references persons(id),
  kind text not null,
  score numeric not null,
  segment text not null,
  owner_id uuid references users(id),
  primary key (club_id, day, person_id, kind)
);

do $$
declare t text;
begin
  foreach t in array array['client_scores', 'ai_models', 'ai_score_history'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;

-- Автосообщение неприоритетным клиентам по оценке ИИ (FR-AI-05)
alter table msg_triggers drop constraint msg_triggers_event_check;
alter table msg_triggers add constraint msg_triggers_event_check check (event in ('membership_ending', 'debt_overdue', 'inactive', 'birthday', 'welcome', 'ai_nurture'));
