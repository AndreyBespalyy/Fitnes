-- «Дядя Витя» (просьба Андрея 17.11.2026): ИИ-агент клуба сверяет разговоры менеджеров со скриптами отдела продаж,
-- пишет менеджеру в мессенджер CRM, что упущено; с третьего разбора за 30 дней — сводка со ссылками на разговоры РОПу.
-- Упущения идут в рейтинг менеджера (часть «Скрипты»).
create table call_script_checks (
  call_id uuid primary key references calls(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  user_id uuid references users(id),
  script_code text not null,            -- какой скрипт применили: lead, incoming, base, confirm, renewal, repeat
  items jsonb not null,                 -- [{ id, text, how, ok, quote }]
  missed int not null default 0,        -- сколько пунктов упущено (этапы + «нельзя»)
  score numeric not null check (score between 0 and 100),
  summary text,                         -- коротко о разговоре
  engine text,
  warned_at timestamptz,                -- написали менеджеру
  rop_sent_at timestamptz,              -- сообщили РОПу
  created_at timestamptz not null default now()
);
create index call_script_checks_user on call_script_checks (club_id, user_id, created_at desc);
alter table call_script_checks enable row level security;
create policy t_call_script_checks on call_script_checks
  using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));
grant select, insert, update, delete on call_script_checks to fitnes_app;

-- ИИ-агента клуба зовут «Дядя Витя»
update users set full_name = 'Дядя Витя' where is_bot;
