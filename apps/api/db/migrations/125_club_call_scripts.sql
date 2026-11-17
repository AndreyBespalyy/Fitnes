-- Скрипты звонков по клубу (проверка CRM 17.11.2026, п. 4): раньше тексты были вшиты в программу
-- (название, адрес, цены одного клуба). Теперь РОП или управляющий правит их в «Отдел продаж → Скрипты звонков»,
-- и по ним работают кнопка «Показать скрипт звонка» и разборы звонков Дяди Вити. Нет записи — действует стандартный текст.
create table club_call_scripts (
  club_id uuid not null references clubs(id) on delete cascade,
  code text not null check (code in ('lead', 'incoming', 'base', 'confirm', 'renewal', 'repeat')),
  tenant_id uuid not null references tenants(id),
  data jsonb not null,                  -- { lines: [[этап, текст]], ifSays: [[вопрос, ответ]], never: '…', steps: [{id, text, how}], neverItems: [{id, text, how}] }
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (club_id, code)
);
alter table club_call_scripts enable row level security;
create policy t_club_call_scripts on club_call_scripts
  using (tenant_id = app_tenant() and app_club_visible(club_id))
  with check (tenant_id = app_tenant() and app_club_visible(club_id));
grant select, insert, update, delete on club_call_scripts to fitnes_app;
