// Свои роли сети и защита от «выдачи себе прав» (роль «Технический администратор», 18.11.2026).
// Правила:
//  - свою роль можно собрать только из прав, которые есть у того, кто её создаёт (собственник — из любых, кроме полного доступа);
//  - менять и удалять можно только ту свою роль, все права которой есть у того, кто меняет;
//  - назначить роль сотруднику (и управлять его учётной записью: пароль, блокировка, сеансы) можно, только если у назначающего
//    есть все права роли, открывающие клиентов и деньги (SENSITIVE_PERMISSIONS); для своих ролей — вообще все её права.
// Так технический администратор не может завести себе учётную запись финансиста или сбросить пароль управляющему.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P, PERMISSION_LABELS, SENSITIVE_PERMISSIONS } from '../roles.ts';

type RoleRow = { code: string; name: string; permissions: string[]; network_wide: boolean; tenant_id: string | null };

const ALL = Object.values(P) as string[];

/** Каких прав роли не хватает у сотрудника, чтобы её выдать (пусто — можно выдать). */
export function missingToGrant(ctx: Ctx, role: Pick<RoleRow, 'permissions' | 'tenant_id' | 'code'>): string[] {
  if (can(ctx, '*')) return [];
  if (role.code === 'owner' || role.permissions.includes('*')) return ['*'];
  const check = role.tenant_id ? role.permissions : role.permissions.filter((p) => SENSITIVE_PERMISSIONS.includes(p));
  return check.filter((p) => !ctx.permissions.has(p));
}

const why = (missing: string[]) => missing.includes('*') ? 'полный доступ'
  : missing.map((p) => `«${PERMISSION_LABELS[p] ?? p}»`).join(', ');

/** Роль, которую сотрудник может выдать, или ошибка «нельзя». */
export async function grantableRole(db: Db, ctx: Ctx, code: string) {
  const role = (await db.query('select code, name, permissions, network_wide, tenant_id from roles where code = $1', [code])).rows[0] as RoleRow | undefined;
  if (!role) throw badRequest('Неизвестная роль');
  const miss = missingToGrant(ctx, role);
  if (miss.length) throw forbidden(`Роль «${role.name}» даёт права, которых у вас нет: ${why(miss)}. Её назначает собственник`);
  return role;
}

/** Можно ли управлять учётной записью сотрудника: все его роли должны быть такими, какие можно выдать. */
export async function assertCanManageUser(db: Db, ctx: Ctx, userId: string) {
  if (can(ctx, '*')) return;
  const roles = (await db.query(`select r.code, r.name, r.permissions, r.network_wide, r.tenant_id from user_assignments a join roles r on r.code = a.role_code
    where a.user_id = $1`, [userId])).rows as RoleRow[];
  for (const r of roles) {
    const miss = missingToGrant(ctx, r);
    if (miss.length) throw forbidden(`У сотрудника роль «${r.name}» с правами, которых у вас нет: ${why(miss)}. Его учётной записью управляет собственник`);
  }
}

const cleanPerms = (list: unknown) => {
  if (!Array.isArray(list)) throw badRequest('Выберите права роли');
  const set = [...new Set(list.map(String))];
  const bad = set.filter((p) => !ALL.includes(p));
  if (bad.length) throw badRequest(`Неизвестные права: ${bad.join(', ')}`);
  if (!set.length) throw badRequest('Выберите хотя бы одно право');
  return set.sort((a, b) => ALL.indexOf(a) - ALL.indexOf(b));
};

const sqlError = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001') return badRequest(err.message ?? 'Нельзя');
  if (err.code === 'P0002') return notFound(err.message ?? 'Роль не найдена');
  return e;
};

export function roleAdminRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Список ролей с составом прав и справочник прав: что можно включить в свою роль
  app.get('/api/roles/catalog', async (req) => {
    const ctx = requirePerm(req, P.rolesManage);
    return withCtx(pool, ctx, async (db) => {
      const roles = (await db.query(`select r.code, r.name, r.permissions, r.network_wide, r.tenant_id, r.description,
          (select count(distinct a.user_id)::int from user_assignments a where a.role_code = r.code) as users
        from roles r order by r.tenant_id nulls first, r.sort, r.name`)).rows as (RoleRow & { description: string | null; users: number })[];
      return {
        roles: roles.map((r) => ({ code: r.code, name: r.name, custom: !!r.tenant_id, networkWide: r.network_wide, description: r.description, users: r.users,
          permissions: r.permissions, canEdit: !!r.tenant_id && missingToGrant(ctx, { ...r, tenant_id: r.tenant_id }).length === 0,
          canAssign: missingToGrant(ctx, r).length === 0 })),
        permissions: ALL.map((p) => ({ code: p, label: PERMISSION_LABELS[p] ?? p, sensitive: SENSITIVE_PERMISSIONS.includes(p), available: can(ctx, '*') || ctx.permissions.has(p) })),
      };
    });
  });

  const save = async (ctx: Ctx, db: Db, code: string, b: { name?: string; permissions?: unknown; networkWide?: boolean; description?: string }) => {
    const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 3 || name.length > 60) throw badRequest('Название роли: от 3 до 60 символов');
    const perms = cleanPerms(b.permissions);
    const notMine = perms.filter((p) => !can(ctx, p));
    if (notMine.length) throw forbidden(`В свою роль можно включить только те права, которые есть у вас. Нет прав: ${why(notMine)}`);
    const networkWide = !!b.networkWide;
    if (networkWide && !ctx.allClubs) throw forbidden('Роль на всю сеть может создать только сотрудник сети');
    if ((await db.query('select 1 from roles where lower(name) = lower($1) and code <> $2', [name, code])).rowCount) throw badRequest('Роль с таким названием уже есть');
    const description = String(b.description ?? '').trim().slice(0, 300) || null;
    try {
      await db.query('select custom_role_save($1, $2, $3, $4, $5, $6)', [code, name, perms, networkWide, description, ctx.userId]);
    } catch (e) { throw sqlError(e); }
    return { code, name, permissions: perms, networkWide, description };
  };

  const editable = async (db: Db, ctx: Ctx, code: string) => {
    const r = (await db.query('select code, name, permissions, network_wide, tenant_id, description from roles where code = $1', [code])).rows[0] as (RoleRow & { description: string | null }) | undefined;
    if (!r) throw notFound('Роль не найдена');
    if (!r.tenant_id) throw badRequest('Встроенные роли не меняются: создайте свою роль на их основе');
    const miss = missingToGrant(ctx, r);
    if (miss.length) throw forbidden(`В роли есть права, которых у вас нет: ${why(miss)}. Её меняет собственник`);
    return r;
  };

  app.post('/api/roles', async (req, reply) => {
    const ctx = requirePerm(req, P.rolesManage);
    const code = `c_${randomBytes(6).toString('hex')}`;
    const res = await withCtx(pool, ctx, async (db) => {
      const r = await save(ctx, db, code, (req.body ?? {}) as Record<string, never>);
      await audit(db, ctx, 'role.created', 'role', code, null, r);
      return r;
    });
    reply.code(201);
    return res;
  });

  app.put('/api/roles/:code', async (req) => {
    const ctx = requirePerm(req, P.rolesManage);
    const { code } = req.params as { code: string };
    return withCtx(pool, ctx, async (db) => {
      const before = await editable(db, ctx, code);
      const r = await save(ctx, db, code, (req.body ?? {}) as Record<string, never>);
      await audit(db, ctx, 'role.updated', 'role', code, { name: before.name, permissions: before.permissions, networkWide: before.network_wide }, r);
      return r;
    });
  });

  app.delete('/api/roles/:code', async (req) => {
    const ctx = requirePerm(req, P.rolesManage);
    const { code } = req.params as { code: string };
    return withCtx(pool, ctx, async (db) => {
      const before = await editable(db, ctx, code);
      try { await db.query('select custom_role_delete($1)', [code]); } catch (e) { throw sqlError(e); }
      await audit(db, ctx, 'role.deleted', 'role', code, { name: before.name, permissions: before.permissions }, null);
      return { ok: true };
    });
  });
}
