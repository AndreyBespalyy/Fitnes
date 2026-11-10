import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { audit, withCtx } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { applyClubPreset } from '../presets.ts';
import { checkLimit } from './onboarding.ts';

const MODELS = ['term', 'subscription'];
const TZ = ['Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk',
  'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka'];

const SELECT = `select c.id, c.name, c.address, c.timezone, c.sales_model as "salesModel", c.status, c.first_response_minutes as "firstResponseMinutes", c.is_demo as "isDemo",
  (select count(distinct a.user_id)::int from user_assignments a join users u on u.id = a.user_id
     where a.club_id = c.id and u.status = 'active') as "staffCount",
  (select count(*)::int from persons p where p.home_club_id = c.id) as "personsCount"
  from clubs c`;

export function clubRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/clubs', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    return withCtx(pool, ctx, async (db) => (await db.query(`${SELECT} where c.status = 'active' order by c.is_demo, c.created_at`)).rows);
  });

  app.post('/api/clubs', async (req, reply) => {
    const ctx = requirePerm(req, P.clubsManage);
    if (!ctx.allClubs) throw forbidden('Создавать клубы может собственник или администратор системы');
    const b = (req.body ?? {}) as { name?: string; address?: string; timezone?: string; salesModel?: string };
    const name = b.name?.trim();
    if (!name) throw badRequest('Укажите название клуба');
    if (!b.salesModel || !MODELS.includes(b.salesModel)) throw badRequest('Выберите модель продаж: абонементы на срок или подписка', 'sales_model_required');
    const tz = b.timezone || 'Europe/Moscow';
    if (!TZ.includes(tz)) throw badRequest('Неизвестный часовой пояс');
    const club = await withCtx(pool, ctx, async (db) => {
      const dup = await db.query('select 1 from clubs where tenant_id = $1 and lower(name) = lower($2)', [ctx.tenantId, name]);
      if (dup.rowCount) throw badRequest('Клуб с таким названием уже есть');
      await checkLimit(db, 'clubs');
      const id = (await db.query(
        'insert into clubs(tenant_id, name, address, timezone, sales_model) values ($1,$2,$3,$4,$5) returning id',
        [ctx.tenantId, name, b.address?.trim() || null, tz, b.salesModel])).rows[0].id;
      await db.query('insert into club_sales_model_history(tenant_id, club_id, old_model, new_model, apply_from, changed_by) values ($1,$2,null,$3,$4,$5)',
        [ctx.tenantId, id, b.salesModel, 'now', ctx.userId]);
      await applyClubPreset(db, ctx.tenantId, id, b.salesModel as 'term' | 'subscription');
      const row = (await db.query(`${SELECT} where c.id = $1`, [id])).rows[0];
      await audit(db, ctx, 'club.created', 'club', id, null, row);
      return row;
    });
    reply.code(201);
    return club;
  });

  app.patch('/api/clubs/:id', async (req) => {
    const ctx = requirePerm(req, P.clubsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; address?: string; timezone?: string; salesModel?: string; applyFrom?: string; firstResponseMinutes?: number };
    return withCtx(pool, ctx, async (db) => {
      const before = (await db.query(`${SELECT} where c.id = $1`, [id])).rows[0];
      if (!before) throw notFound('Клуб не найден');
      if (b.salesModel !== undefined && !MODELS.includes(b.salesModel)) throw badRequest('Неизвестная модель продаж');
      if (b.timezone !== undefined && !TZ.includes(b.timezone)) throw badRequest('Неизвестный часовой пояс');
      if (b.name !== undefined && !b.name.trim()) throw badRequest('Название не может быть пустым');
      const frm = b.firstResponseMinutes;
      if (frm !== undefined && (!Number.isInteger(frm) || frm < 1 || frm > 1440)) throw badRequest('Норма первого ответа: от 1 до 1440 минут');
      await db.query(
        `update clubs set name = coalesce($2, name), address = coalesce($3, address), timezone = coalesce($4, timezone),
           sales_model = coalesce($5::sales_model, sales_model), first_response_minutes = coalesce($6, first_response_minutes), updated_at = now() where id = $1`,
        [id, b.name?.trim() ?? null, b.address?.trim() ?? null, b.timezone ?? null, b.salesModel ?? null, frm ?? null]);
      if (b.salesModel && b.salesModel !== before.salesModel) {
        const applyFrom = b.applyFrom === 'now' ? 'now' : 'next_period';
        await db.query('insert into club_sales_model_history(tenant_id, club_id, old_model, new_model, apply_from, changed_by) values ($1,$2,$3,$4,$5,$6)',
          [ctx.tenantId, id, before.salesModel, b.salesModel, applyFrom, ctx.userId]);
      }
      const after = (await db.query(`${SELECT} where c.id = $1`, [id])).rows[0];
      await audit(db, ctx, b.salesModel && b.salesModel !== before.salesModel ? 'club.sales_model_changed' : 'club.updated', 'club', id, before, after);
      return after;
    });
  });

  app.get('/api/clubs/:id/model-history', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select h.old_model as "oldModel", h.new_model as "newModel", h.apply_from as "applyFrom", h.changed_at as "changedAt", u.full_name as "changedBy"
       from club_sales_model_history h left join users u on u.id = h.changed_by where h.club_id = $1 order by h.changed_at desc`, [id])).rows);
  });
}
