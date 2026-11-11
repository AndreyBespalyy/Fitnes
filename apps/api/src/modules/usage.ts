// Статистика использования (список «20 улучшений», п. 15): какие разделы открывают, кто и как часто работает в системе.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { withCtx, type Ctx } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';

function viewer(ctx: Ctx) {
  if (!ctx.allClubs || !(can(ctx, '*') || ctx.roles.includes('admin'))) throw forbidden('Статистику использования видит собственник или администратор сети');
}

export function usageRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post('/api/usage/view', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { tab?: string; label?: string };
    if (!b.tab || !/^[a-z0-9_-]{1,40}$/.test(b.tab)) throw badRequest('Раздел не указан');
    await withCtx(pool, ctx, (db) => db.query(`insert into usage_daily(tenant_id, user_id, day, tab, label, opens)
      values ($1, $2, (now() at time zone 'Europe/Moscow')::date, $3, $4, 1)
      on conflict (user_id, day, tab) do update set opens = usage_daily.opens + 1, label = coalesce(excluded.label, usage_daily.label)`,
      [ctx.tenantId, ctx.userId, b.tab, b.label?.slice(0, 60) ?? null]));
    return { ok: true };
  });

  app.get('/api/usage', async (req) => {
    const ctx = requireCtx(req);
    viewer(ctx);
    const days = Math.min(90, Math.max(7, Number((req.query as { days?: string }).days) || 30));
    return withCtx(pool, ctx, async (db) => {
      const from = `(now() at time zone 'Europe/Moscow')::date - ${days - 1}`;
      const sections = (await db.query(`select tab, max(label) as label, sum(opens)::int as opens, count(distinct user_id)::int as users, max(day) as "lastDay"
        from usage_daily where day >= ${from} group by tab order by sum(opens) desc`)).rows;
      // Роли: сколько сотрудников с этой ролью вообще заходили и в какие разделы чаще всего
      const roles = (await db.query(`with r as (select distinct a.user_id, ro.name as role from user_assignments a join roles ro on ro.code = a.role_code join users u on u.id = a.user_id where u.status = 'active')
        select r.role, count(distinct r.user_id)::int as staff, count(distinct d.user_id)::int as active,
          coalesce((select json_agg(x order by x.opens desc) from (select d2.tab, max(d2.label) as label, sum(d2.opens)::int as opens from usage_daily d2 join r r2 on r2.user_id = d2.user_id
             where r2.role = r.role and d2.day >= ${from} group by d2.tab order by sum(d2.opens) desc limit 5) x), '[]') as top
        from r left join usage_daily d on d.user_id = r.user_id and d.day >= ${from} group by r.role order by r.role`)).rows;
      const people = (await db.query(`select u.id, u.full_name as "fullName",
          (select string_agg(distinct ro.name, ', ') from user_assignments a join roles ro on ro.code = a.role_code where a.user_id = u.id) as roles,
          count(distinct d.day)::int as "activeDays", coalesce(sum(d.opens), 0)::int as opens, max(d.day) as "lastDay",
          (select max(s.last_seen_at) from sessions s where s.user_id = u.id) as "lastSeenAt"
        from users u left join usage_daily d on d.user_id = u.id and d.day >= ${from}
        where u.status = 'active' group by u.id order by count(distinct d.day) desc, u.full_name`)).rows;
      const daily = (await db.query(`select day, count(distinct user_id)::int as users, sum(opens)::int as opens from usage_daily where day >= ${from} group by day order by day`)).rows;
      return { days, sections, roles, people, daily };
    });
  });
}
