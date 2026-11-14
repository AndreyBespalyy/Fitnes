-- ИИ-агент, этап 2 (выбор Андрея 14.11.2026: 2Б, 3АБВ): карточки-напоминания с кнопками, лестница эскалации,
-- авто-передача заявок другому менеджеру. Клиентам агент сам не пишет — только сотрудникам, внутри CRM.

-- Уведомление-карточка: к чему относится и какие кнопки показать
alter table staff_notifications add column object_type text;   -- task / opportunity / lead / conversation
alter table staff_notifications add column object_id uuid;
alter table staff_notifications add column actions jsonb;      -- ["brief", "snooze_1h", "snooze_tomorrow", "nudge", "reassign", "open"]
alter table staff_notifications add column acted_at timestamptz;
alter table staff_notifications add column acted text;         -- что нажали

-- Настройки агента по клубу (меняют собственник и управляющий своего клуба)
create table agent_settings (
  club_id uuid primary key references clubs(id),
  tenant_id uuid not null references tenants(id),
  enabled boolean not null default true,
  task_rop_minutes int not null default 60 check (task_rop_minutes between 5 and 2880),       -- просрочка → РОП
  task_gm_minutes int not null default 240 check (task_gm_minutes between 10 and 10080),      -- → управляющий
  task_owner_minutes int not null default 1440 check (task_owner_minutes between 60 and 20160), -- → собственник
  reply_wait_minutes int not null default 15 check (reply_wait_minutes between 3 and 240),    -- клиент ждёт ответа в переписке
  lead_reassign_minutes int not null default 10 check (lead_reassign_minutes between 0 and 240), -- 0 — не передавать заявку
  quiet_from int not null default 22 check (quiet_from between 0 and 23),                    -- ночью не беспокоить (местное время клуба)
  quiet_to int not null default 8 check (quiet_to between 0 and 23),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- Что агент уже отправил (чтобы не повторяться): ключ «задача:уровень», «переписка:время сообщения:уровень»
create table agent_sent (
  tenant_id uuid not null references tenants(id),
  club_id uuid not null references clubs(id),
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (club_id, key)
);

alter table leads add column agent_reassigned_at timestamptz;
alter table leads add column agent_reassigned_from uuid references users(id);

do $$ declare t text; begin
  foreach t in array array['agent_settings', 'agent_sent'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy t_%s on %I using (tenant_id = app_tenant() and app_club_visible(club_id)) with check (tenant_id = app_tenant() and app_club_visible(club_id))', t, t);
  end loop;
end $$;
