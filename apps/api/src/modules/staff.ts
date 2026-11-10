import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db, type Ctx } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { hashPassword, tempPassword } from '../passwords.ts';
import { PERMISSIONS as P } from '../roles.ts';

const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s: string) => [...s.toLowerCase()].map((ch) => TR[ch] ?? ch).join('').replace(/[^a-z0-9]/g, '');

/** «Мария Волкова» → m.volkova (при совпадении добавляется цифра). */
async function makeLogin(db: Db, fullName: string) {
  const parts = fullName.trim().split(/\s+/);
  const first = translit(parts[0] ?? '');
  const last = translit(parts[1] ?? parts[0] ?? '');
  let base = `${first.slice(0, 1)}.${last}`.replace(/^\./, '') || 'user';
  let login = base;
  for (let i = 2; (await db.query('select 1 from users where lower(login) = lower($1)', [login])).rowCount; i++) login = `${base}${i}`;
  return login;
}

const LIST = `select u.id, u.login, u.full_name as "fullName", u.phone, u.status, u.must_change_password as "mustChangePassword",
  coalesce(json_agg(json_build_object('role', a.role_code, 'roleName', r.name, 'clubId', a.club_id, 'clubName', c.name) order by r.sort)
    filter (where a.id is not null), '[]') as assignments
  from users u
  left join user_assignments a on a.user_id = u.id
  left join roles r on r.code = a.role_code
  left join clubs c on c.id = a.club_id`;

function visibleFilter(ctx: Ctx) {
  // Руководитель клуба видит сотрудников своих клубов; сетевые роли видят всех
  return ctx.allClubs ? '' : `where exists (select 1 from user_assignments x where x.user_id = u.id and x.club_id = any($1::uuid[]))`;
}

async function loadUser(db: Db, id: string) {
  const u = (await db.query(`${LIST} where u.id = $1 group by u.id`, [id])).rows[0];
  if (!u) throw notFound('Сотрудник не найден');
  return u;
}

export function staffRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/roles', async (req) => {
    const ctx = requirePerm(req, P.staffView);
    return withCtx(pool, ctx, async (db) => (await db.query(
      'select code, name, network_wide as "networkWide" from roles order by sort')).rows);
  });

  app.get('/api/staff', async (req) => {
    const ctx = requirePerm(req, P.staffView);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `${LIST} ${visibleFilter(ctx)} group by u.id order by min(r.sort), u.full_name`, ctx.allClubs ? [] : [ctx.clubIds])).rows);
  });

  app.post('/api/staff', async (req, reply) => {
    const ctx = requirePerm(req, P.staffManage);
    const b = (req.body ?? {}) as { fullName?: string; login?: string; phone?: string; role?: string; clubId?: string | null };
    const fullName = b.fullName?.trim();
    if (!fullName) throw badRequest('Укажите ФИО сотрудника');
    if (!b.role) throw badRequest('Выберите роль');
    if (b.role === 'owner' && !can(ctx, '*')) throw forbidden('Назначить собственника может только собственник');
    const res = await withCtx(pool, ctx, async (db) => {
      const role = (await db.query('select code, network_wide from roles where code = $1', [b.role])).rows[0];
      if (!role) throw badRequest('Неизвестная роль');
      let clubId: string | null = b.clubId || null;
      if (role.network_wide && !ctx.allClubs) throw forbidden('Сетевые роли назначает собственник или администратор системы');
      if (role.network_wide) clubId = null;
      else if (!clubId) throw badRequest('Выберите клуб для этой роли');
      if (!ctx.allClubs && clubId && !ctx.clubIds.includes(clubId)) throw forbidden('Можно добавлять сотрудников только в свой клуб');
      if (clubId && !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Клуб не найден');
      let login = b.login?.trim().toLowerCase();
      if (login) {
        if (!/^[a-z0-9._-]{3,40}$/.test(login)) throw badRequest('Логин: латиница, цифры, точка, от 3 до 40 символов');
        if ((await db.query('select 1 from users where lower(login) = $1', [login])).rowCount) throw badRequest('Такой логин уже занят');
      } else {
        login = await makeLogin(db, fullName);
      }
      const pw = tempPassword();
      const id = (await db.query(
        'insert into users(tenant_id, login, password_hash, full_name, phone, must_change_password) values ($1,$2,$3,$4,$5,true) returning id',
        [ctx.tenantId, login, await hashPassword(pw), fullName, b.phone?.trim() || null])).rows[0].id;
      await db.query('insert into user_assignments(tenant_id, user_id, role_code, club_id) values ($1,$2,$3,$4)', [ctx.tenantId, id, role.code, clubId]);
      const user = await loadUser(db, id);
      await audit(db, ctx, 'staff.created', 'user', id, null, user);
      return { user, tempPassword: pw };
    });
    reply.code(201);
    return res;
  });

  const guardTarget = async (db: Db, ctx: Ctx, id: string) => {
    if (id === ctx.userId) throw badRequest('Нельзя выполнить это действие со своей учётной записью');
    const isOwner = (await db.query(`select 1 from user_assignments where user_id = $1 and role_code = 'owner'`, [id])).rowCount;
    if (isOwner && !can(ctx, '*')) throw forbidden('Учётной записью собственника управляет только собственник');
    if (!ctx.allClubs) {
      const a = (await db.query('select club_id from user_assignments where user_id = $1', [id])).rows as { club_id: string | null }[];
      if (a.some((x) => x.club_id === null)) throw forbidden('Сотрудниками сети управляет собственник или администратор системы');
      if (!a.some((x) => x.club_id && ctx.clubIds.includes(x.club_id))) throw forbidden('Сотрудник не из вашего клуба');
    }
  };

  app.post('/api/staff/:id/block', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const before = await loadUser(db, id);
      await guardTarget(db, ctx, id);
      await db.query(`update users set status = 'blocked', updated_at = now() where id = $1`, [id]);
      await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      const after = await loadUser(db, id);
      await audit(db, ctx, 'staff.blocked', 'user', id, { status: before.status }, { status: after.status });
      return after;
    });
  });

  app.post('/api/staff/:id/unblock', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await loadUser(db, id);
      await guardTarget(db, ctx, id);
      await db.query(`update users set status = 'active', failed_attempts = 0, locked_until = null, updated_at = now() where id = $1`, [id]);
      const after = await loadUser(db, id);
      await audit(db, ctx, 'staff.unblocked', 'user', id, null, { status: after.status });
      return after;
    });
  });

  app.post('/api/staff/:id/reset-password', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await loadUser(db, id);
      await guardTarget(db, ctx, id);
      const pw = tempPassword();
      await db.query('update users set password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = null, updated_at = now() where id = $1',
        [id, await hashPassword(pw)]);
      await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(db, ctx, 'staff.password_reset', 'user', id, null, null);
      return { user: await loadUser(db, id), tempPassword: pw };
    });
  });
}
