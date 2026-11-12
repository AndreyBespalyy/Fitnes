import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { audit, withCtx, type Ctx } from './db.ts';
import { badRequest, forbidden, HttpError, unauthorized } from './errors.ts';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './passwords.ts';

export const COOKIE = 'sid';
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Ограничение по адресу: столько неудачных попыток за окно, дальше пауза; столько разных логинов — сигнал собственнику
export const IP_MAX_FAILS = 20;
export const IP_WINDOW_MIN = 10;
export const IP_ALERT_LOGINS = 5;
const MOBILE_ROLES = new Set(['manager', 'desk', 'trainer']);
const HOURS = 3600_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: Ctx;
    mustChangePassword?: boolean;
  }
}

export async function loadCtx(pool: pg.Pool, token: string | undefined, ip?: string): Promise<{ ctx: Ctx; mustChange: boolean } | null> {
  if (!token) return null;
  const s = (await pool.query('select * from auth_session($1)', [sha256(token)])).rows[0];
  if (!s) return null;
  const base = { tenantId: s.tenant_id, allClubs: true, clubIds: [] as string[] };
  return withCtx(pool, base, async (db) => {
    const rows = (await db.query(
      `select a.role_code, a.club_id, r.permissions from user_assignments a join roles r on r.code = a.role_code
       where a.user_id = $1 and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`,
      [s.user_id],
    )).rows;
    const u = (await db.query('select must_change_password from users where id = $1', [s.user_id])).rows[0];
    const perms = new Set<string>(rows.flatMap((r) => r.permissions));
    const roles = [...new Set(rows.map((r) => r.role_code as string))];
    const allClubs = rows.some((r) => r.club_id === null);
    const clubIds = [...new Set(rows.filter((r) => r.club_id).map((r) => r.club_id as string))];
    await db.query(`update sessions set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`, [s.session_id]);
    // Скользящее продление сессии для веб-кабинета (12 часов без активности)
    if (!roles.some((r) => MOBILE_ROLES.has(r))) {
      await db.query(
        `update sessions set expires_at = now() + interval '12 hours' where id = $1 and expires_at < now() + interval '11 hours'`,
        [s.session_id],
      );
    }
    return {
      ctx: { userId: s.user_id, tenantId: s.tenant_id, sessionId: s.session_id, roles, allClubs, clubIds, permissions: perms, ip },
      mustChange: u?.must_change_password ?? false,
    };
  });
}

export function can(ctx: Ctx, perm: string) {
  return ctx.permissions.has('*') || ctx.permissions.has(perm);
}

export function requireCtx(req: FastifyRequest): Ctx {
  if (!req.ctx) throw unauthorized();
  if (req.mustChangePassword) throw new HttpError(403, 'Сначала смените временный пароль', 'must_change_password');
  return req.ctx;
}

export function requirePerm(req: FastifyRequest, perm: string): Ctx {
  const ctx = requireCtx(req);
  if (!can(ctx, perm)) throw forbidden();
  return ctx;
}

export async function me(pool: pg.Pool, ctx: Ctx, mustChange: boolean) {
  return withCtx(pool, ctx, async (db) => {
    const u = (await db.query('select id, login, full_name, is_tester as "isTester" from users where id = $1', [ctx.userId])).rows[0];
    const roles = (await db.query(
      `select a.role_code as code, r.name, a.club_id from user_assignments a join roles r on r.code = a.role_code
       where a.user_id = $1 order by r.sort`, [ctx.userId])).rows;
    return { ...u, roles, allClubs: ctx.allClubs, permissions: [...ctx.permissions], mustChangePassword: mustChange };
  });
}

export function authRoutes(app: FastifyInstance, pool: pg.Pool, opts: { secureCookie: boolean }) {
  app.post('/api/auth/login', async (req, reply) => {
    const { login, password } = (req.body ?? {}) as { login?: string; password?: string };
    if (!login || !password) throw badRequest('Введите логин и пароль');
    const ip = req.ip;
    const ipf = (await pool.query('select * from auth_ip_fails($1, $2)', [ip, IP_WINDOW_MIN])).rows[0];
    if (ipf.fails >= IP_MAX_FAILS) {
      const wait = Math.max(1, Math.ceil((new Date(ipf.first_at).getTime() + IP_WINDOW_MIN * 60_000 - Date.now()) / 60_000));
      throw new HttpError(429, `Слишком много неудачных попыток входа с этого адреса. Попробуйте через ${wait} мин.`, 'ip_limited');
    }
    const u = (await pool.query('select * from auth_find_user($1)', [login.trim()])).rows[0];
    const invalid = new HttpError(401, 'Неверный логин или пароль', 'invalid_credentials');
    const failed = async (tenantId: string | null) => {
      await pool.query('select auth_note_attempt($1, $2, $3, false)', [ip, login.trim(), tenantId]);
      await ipAlert(pool, ip).catch(() => null);
    };
    if (!u) { await failed(null); throw invalid; }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      const t = new Date(u.locked_until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
      throw new HttpError(423, `Слишком много неудачных попыток. Вход заблокирован до ${t}`, 'locked');
    }
    const tctx = { tenantId: u.tenant_id, allClubs: true, clubIds: [] as string[] };
    const actx = { tenantId: u.tenant_id, userId: u.id, ip: req.ip };
    const ok = await verifyPassword(u.password_hash, password);
    if (!ok) {
      await withCtx(pool, tctx, async (db) => {
        const fails = u.failed_attempts + 1;
        if (fails >= MAX_FAILS) {
          await db.query(`update users set failed_attempts = 0, locked_until = now() + make_interval(mins => $2) where id = $1`, [u.id, LOCK_MINUTES]);
        } else {
          await db.query('update users set failed_attempts = $2 where id = $1', [u.id, fails]);
        }
        await audit(db, actx, fails >= MAX_FAILS ? 'auth.locked' : 'auth.failed', 'user', u.id, null, { fails });
      });
      await failed(u.tenant_id);
      throw invalid;
    }
    if (u.status !== 'active') throw new HttpError(403, 'Учётная запись заблокирована. Обратитесь к администратору', 'blocked');
    if (!(await pool.query('select auth_tenant_active($1) as ok', [u.tenant_id])).rows[0].ok) {
      throw new HttpError(403, 'Доступ сети к системе приостановлен. Свяжитесь с поддержкой платформы', 'tenant_suspended');
    }
    const token = randomBytes(32).toString('base64url');
    const result = await withCtx(pool, tctx, async (db) => {
      await db.query('update users set failed_attempts = 0, locked_until = null where id = $1', [u.id]);
      // Личные пароли обязательны: общий, простой или ни разу не сменённый пароль — сразу на смену
      if (u.require_personal && !u.must_change_password && (!u.password_changed_at || checkPasswordPolicy(password, login.trim()))) {
        await db.query('update users set must_change_password = true where id = $1', [u.id]);
        await audit(db, actx, 'auth.must_change_forced', 'user', u.id, null, null);
      }
      const roles = (await db.query('select role_code from user_assignments where user_id = $1', [u.id])).rows.map((r) => r.role_code);
      const ttl = roles.some((r: string) => MOBILE_ROLES.has(r)) ? 30 * 24 * HOURS : 12 * HOURS;
      await db.query(
        'insert into sessions(tenant_id, user_id, token_hash, device, ip, expires_at) values ($1,$2,$3,$4,$5,$6)',
        [u.tenant_id, u.id, sha256(token), String(req.headers['user-agent'] ?? '').slice(0, 200), req.ip, new Date(Date.now() + ttl)],
      );
      await audit(db, actx, 'auth.login', 'user', u.id, null, null);
      return ttl;
    });
    await pool.query('select auth_note_attempt($1, $2, $3, true)', [ip, login.trim(), u.tenant_id]);
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: opts.secureCookie, maxAge: result / 1000 });
    const loaded = await loadCtx(pool, token, req.ip);
    return me(pool, loaded!.ctx, loaded!.mustChange);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.ctx) {
      await withCtx(pool, req.ctx, async (db) => {
        await db.query('update sessions set revoked_at = now() where id = $1', [req.ctx!.sessionId]);
        await db.query('delete from push_subscriptions where session_id = $1', [req.ctx!.sessionId]);
      });
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.ctx) throw unauthorized();
    return me(pool, req.ctx, !!req.mustChangePassword);
  });

  app.post('/api/auth/change-password', async (req) => {
    const ctx = req.ctx;
    if (!ctx) throw unauthorized();
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) throw badRequest('Введите текущий и новый пароль');
    await withCtx(pool, ctx, async (db) => {
      const u = (await db.query('select login, password_hash from users where id = $1', [ctx.userId])).rows[0];
      if (!(await verifyPassword(u.password_hash, currentPassword))) throw badRequest('Текущий пароль введён неверно', 'wrong_password');
      if (currentPassword === newPassword) throw badRequest('Новый пароль должен отличаться от текущего');
      const err = checkPasswordPolicy(newPassword, u.login);
      if (err) throw badRequest(err, 'weak_password');
      await db.query('update users set password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now() where id = $1',
        [ctx.userId, await hashPassword(newPassword)]);
      await db.query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [ctx.userId, ctx.sessionId]);
      await audit(db, ctx, 'auth.password_changed', 'user', ctx.userId, null, null);
    });
    return { ok: true };
  });
}

/** Перебор по многим логинам с одного адреса: сигнал собственникам каждой затронутой сети, не чаще раза в час */
async function ipAlert(pool: pg.Pool, ip: string) {
  const f = (await pool.query('select * from auth_ip_fails($1, $2)', [ip, IP_WINDOW_MIN])).rows[0];
  if (f.logins < IP_ALERT_LOGINS) return;
  for (const tenantId of f.tenants as string[]) {
    await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, async (db) => {
      const sent = (await db.query(`select 1 from login_alerts where ip = $1 and at > now() - interval '1 hour'`, [ip])).rows[0];
      if (sent) return;
      await db.query('insert into login_alerts(ip, tenant_id) values ($1, $2)', [ip, tenantId]);
      await audit(db, { tenantId, userId: null, ip }, 'auth.ip_attack', 'ip', null, null, { ip, fails: f.fails, logins: f.logins });
      const owners = (await db.query(`select distinct a.user_id from user_assignments a join users u on u.id = a.user_id
        where a.role_code in ('owner', 'admin') and u.status = 'active'`)).rows;
      const { notifyStaff } = await import('./modules/staffBot.ts');
      const text = `⚠ Подбор паролей: с адреса ${ip} за ${IP_WINDOW_MIN} минут ${f.fails} неудачных попыток входа по ${f.logins} разным логинам. Адрес временно остановлен. Подробности: Сотрудники → Защита входа.`;
      for (const o of owners) await notifyStaff(db, fetch, o.user_id, text);
    });
  }
}
