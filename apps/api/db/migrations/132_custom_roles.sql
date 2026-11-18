-- Свои роли сети (18.11.2026, роль «Технический администратор»). Встроенные роли общие для всех сетей (tenant_id пустой),
-- свои роли принадлежат одной сети и видны только ей. Приложение не пишет в roles напрямую: только через функции ниже.
alter table roles add column tenant_id uuid references tenants(id);
alter table roles add column description text;
alter table roles add column created_by uuid references users(id);
alter table roles add column created_at timestamptz;
alter table roles add column updated_at timestamptz;

alter table roles enable row level security;
create policy t_roles on roles using (tenant_id is null or tenant_id = app_tenant());

-- Создать или изменить свою роль текущей сети. Код своей роли всегда начинается с «c_», встроенные роли не меняются.
create function custom_role_save(p_code text, p_name text, p_permissions text[], p_network_wide boolean, p_description text, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t uuid := app_tenant(); r roles;
begin
  if t is null then raise exception 'Нет сети' using errcode = 'P0001'; end if;
  if p_code !~ '^c_[a-z0-9]{6,32}$' then raise exception 'Неверный код роли' using errcode = 'P0001'; end if;
  if '*' = any(p_permissions) then raise exception 'Полный доступ есть только у собственника' using errcode = 'P0001'; end if;
  select * into r from roles where code = p_code;
  if found and r.tenant_id is distinct from t then raise exception 'Роль не найдена' using errcode = 'P0002'; end if;
  if found then
    update roles set name = p_name, permissions = p_permissions, network_wide = p_network_wide, description = p_description, updated_at = now() where code = p_code;
  else
    insert into roles(code, name, permissions, network_wide, sort, tenant_id, description, created_by, created_at, updated_at)
    values (p_code, p_name, p_permissions, p_network_wide, 100, t, p_description, p_actor, now(), now());
  end if;
end $$;

-- Удалить свою роль, если она никому не назначена
create function custom_role_delete(p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare t uuid := app_tenant();
begin
  if not exists (select 1 from roles where code = p_code and tenant_id = t) then raise exception 'Роль не найдена' using errcode = 'P0002'; end if;
  if exists (select 1 from user_assignments where role_code = p_code) then raise exception 'Роль назначена сотрудникам: сначала смените им роль' using errcode = 'P0001'; end if;
  delete from dash_role_layouts where role_code = p_code;
  delete from roles where code = p_code and tenant_id = t;
end $$;
