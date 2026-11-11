// Защита входа (список «20 улучшений», п. 1 и 2): личные пароли для всех и подозрительные попытки входа по адресам.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, IP_ALERT_LOGINS, IP_MAX_FAILS, IP_WINDOW_MIN, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { hashPassword, tempPassword } from '../passwords.ts';
import { PERMISSIONS as P } from '../roles.ts';

/** Настройка сети: только собственник или администратор сети */
function networkAdmin(ctx: Ctx) {
  if (!ctx.allClubs || !(can(ctx, '*') || ctx.roles.includes('admin'))) throw forbidden('Защитой входа управляет собственник или администратор сети');
}

export function loginSecurityRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/security/login', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    networkAdmin(ctx);
    return withCtx(pool, ctx, async (db) => {
      const required = (await db.query('select require_personal_passwords as r from tenants where id = $1', [ctx.tenantId])).rows[0]?.r ?? false;
      const users = (await db.query(`select u.id, u.full_name as "fullName", u.login, u.status, u.must_change_password as "mustChange",
          u.password_changed_at is not null as own, u.password_changed_at as "changedAt",
          (select max(s.created_at) from sessions s where s.user_id = u.id) as "lastLoginAt",
          exists (select 1 from user_assignments a where a.user_id = u.id and a.role_code = 'owner') as owner,
          (select string_agg(distinct r.name, ', ') from user_assignments a join roles r on r.code = a.role_code where a.user_id = u.id) as roles
        from users u order by u.status, (u.password_changed_at is not null), u.full_name`)).rows;
      // Адреса с неудачными попытками за неделю: сколько, по скольким логинам, остановлен ли сейчас
      const ips = (await db.query('select * from auth_ip_report($1, $2)', [ctx.tenantId, IP_WINDOW_MIN])).rows.map((r) => ({ ...r, stopped: r.recent >= IP_MAX_FAILS, suspicious: r.logins >= IP_ALERT_LOGINS }));
      const alerts = (await db.query(`select ip, at from login_alerts where at > now() - interval '7 days' order by at desc limit 20`)).rows;
      return { required, users, ips, alerts, limits: { ipMaxFails: IP_MAX_FAILS, windowMin: IP_WINDOW_MIN, alertLogins: IP_ALERT_LOGINS } };
    });
  });

  app.put('/api/security/login', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    networkAdmin(ctx);
    const { required } = (req.body ?? {}) as { required?: boolean };
    if (typeof required !== 'boolean') throw badRequest('Укажите, включить ли обязательные личные пароли');
    return withCtx(pool, ctx, async (db) => {
      const before = (await db.query('select require_personal_passwords as r from tenants where id = $1', [ctx.tenantId])).rows[0]?.r;
      await db.query('update tenants set require_personal_passwords = $2, updated_at = now() where id = $1', [ctx.tenantId, required]);
      await audit(db, ctx, 'security.personal_passwords', 'tenant', ctx.tenantId, { required: before }, { required });
      return { required };
    });
  });

  // Выдать временные пароли сразу нескольким сотрудникам (например, всем, кто входит по общему тестовому паролю)
  app.post('/api/security/login/reset', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    networkAdmin(ctx);
    const { userIds } = (req.body ?? {}) as { userIds?: string[] };
    if (!Array.isArray(userIds) || !userIds.length) throw badRequest('Выберите сотрудников');
    if (userIds.length > 200) throw badRequest('Не больше 200 сотрудников за раз');
    return withCtx(pool, ctx, async (db) => {
      const out: { id: string; fullName: string; login: string; tempPassword: string }[] = [];
      for (const id of new Set(userIds)) {
        if (id === ctx.userId) continue;
        const u = (await db.query(`select u.id, u.full_name, u.login, u.status,
            exists (select 1 from user_assignments a where a.user_id = u.id and a.role_code = 'owner') as owner from users u where u.id = $1`, [id])).rows[0];
        if (!u || u.status !== 'active' || (u.owner && !can(ctx, '*'))) continue;
        const pw = tempPassword();
        await db.query(`update users set password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = null, updated_at = now() where id = $1`,
          [id, await hashPassword(pw)]);
        await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
        await audit(db, ctx, 'staff.password_reset', 'user', id, null, { bulk: true });
        out.push({ id, fullName: u.full_name, login: u.login, tempPassword: pw });
      }
      return { issued: out };
    });
  });
}
