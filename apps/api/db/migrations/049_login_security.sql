-- Защита входа (список «20 улучшений», п. 1 и 2):
-- личные пароли с обязательной сменой при первом входе и ограничение попыток входа с одного адреса.

-- Сеть может включить «личные пароли обязательны»: кто ни разу не задал свой пароль, при входе обязан его сменить
alter table tenants add column require_personal_passwords boolean not null default false;
alter table users add column password_changed_at timestamptz;

-- Попытки входа по адресам. Логин может не существовать, поэтому сеть известна не всегда:
-- пишем и читаем через функции с правами владельца, как auth_find_user.
create table login_attempts (
  id bigserial primary key,
  ip text not null,
  login text not null,
  tenant_id uuid references tenants(id),
  ok boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_ip on login_attempts (ip, at desc);
create index login_attempts_tenant on login_attempts (tenant_id, at desc);
alter table login_attempts enable row level security;
create policy t_login_attempts on login_attempts using (tenant_id = app_tenant());

-- Уже отправленные сигналы о переборе: не чаще раза в час на адрес
create table login_alerts (
  ip text not null,
  tenant_id uuid not null references tenants(id),
  at timestamptz not null default now(),
  primary key (ip, tenant_id, at)
);
alter table login_alerts enable row level security;
create policy t_login_alerts on login_alerts using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

create function auth_note_attempt(p_ip text, p_login text, p_tenant uuid, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  insert into login_attempts(ip, login, tenant_id, ok) values (p_ip, lower(left(p_login, 100)), p_tenant, p_ok);
  delete from login_attempts where at < now() - interval '30 days' and id % 50 = 0;
$$;

-- Неудачные попытки с адреса за окно: сколько всего, сколько разных логинов, когда первая
create function auth_ip_fails(p_ip text, p_minutes int)
returns table (fails int, logins int, first_at timestamptz, tenants uuid[])
language sql stable security definer set search_path = public as $$
  select count(*)::int, count(distinct login)::int, min(at), coalesce(array_agg(distinct tenant_id) filter (where tenant_id is not null), '{}')
  from login_attempts where ip = p_ip and not ok and at > now() - make_interval(mins => p_minutes)
$$;

drop function auth_find_user(text);
create function auth_find_user(p_login text)
returns table (id uuid, tenant_id uuid, password_hash text, status text, must_change_password boolean,
               failed_attempts int, locked_until timestamptz, password_changed_at timestamptz, require_personal boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.tenant_id, u.password_hash, u.status, u.must_change_password, u.failed_attempts, u.locked_until,
         u.password_changed_at, t.require_personal_passwords
  from users u join tenants t on t.id = u.tenant_id where lower(u.login) = lower(p_login)
$$;

-- Отчёт для сети: адреса, которые пробовали логины этой сети, со всеми их неудачами (включая несуществующие логины)
create function auth_ip_report(p_tenant uuid, p_minutes int)
returns table (ip text, fails int, oks int, logins int, "lastAt" timestamptz, recent int)
language sql stable security definer set search_path = public as $$
  select a.ip, count(*) filter (where not a.ok)::int, count(*) filter (where a.ok and a.tenant_id = p_tenant)::int,
         count(distinct a.login) filter (where not a.ok)::int, max(a.at) filter (where not a.ok),
         count(*) filter (where not a.ok and a.at > now() - make_interval(mins => p_minutes))::int
  from login_attempts a
  where a.at > now() - interval '7 days' and a.ip in (select distinct ip from login_attempts where tenant_id = p_tenant and at > now() - interval '7 days')
  group by a.ip having count(*) filter (where not a.ok) >= 3
  order by max(a.at) desc limit 30
$$;
