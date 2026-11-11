// Промокоды и акции (список «20 новых возможностей», п. 2).
// Скидка в продаже бывает трёх видов: по промокоду или акции, ручная в пределах лимита продавца, разовая сверх лимита после согласования.
// Акция со скидкой больше лимита создателя включается только после согласования (вид согласования «скидка»).
// Отчёт по акции: сколько продаж, выручка, во что обошлась скидка, сколько клиентов потом продлили — окупаемость кампании.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { clubToday } from './memberships.ts';

type Actor = Pick<Ctx, 'tenantId' | 'userId' | 'ip'>;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const rubs = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;
export const CONDITION_NAME: Record<string, string> = { any: 'всем', new: 'только новым клиентам', renewal: 'только при продлении', return: 'только вернувшимся' };

/** Лимит скидки сотрудника в процентах: null — без ограничений (собственник), 0 — скидки давать нельзя. */
export async function discountLimit(db: Db, userId: string, clubId: string): Promise<number | null> {
  const roles = (await db.query(`select a.role_code, r.permissions from user_assignments a join roles r on r.code = a.role_code
    where a.user_id = $1 and (a.club_id is null or a.club_id = $2)`, [userId, clubId])).rows;
  if (roles.some((r) => (r.permissions as string[]).includes('*'))) return null;
  const lim = (await db.query(`select max(max_percent) as m from approval_limits where kind = 'discount' and role_code = any($1)`, [roles.map((r) => r.role_code)])).rows[0].m;
  return lim === null ? 0 : Number(lim);
}

async function priceOf(db: Db, productId: string): Promise<number> {
  const r = (await db.query('select amount_kop from price_versions where product_id = $1 and valid_from <= now() order by valid_from desc limit 1', [productId])).rows[0];
  return r ? Number(r.amount_kop) : 0;
}

/** Самая большая скидка акции в процентах (для фиксированной суммы — относительно самого дешёвого тарифа акции). */
async function promoMaxPercent(db: Db, p: { club_id: string; discount_percent: unknown; discount_kop: unknown; product_ids: string[] }) {
  if (p.discount_percent != null) return Number(p.discount_percent);
  const ids = p.product_ids.length ? p.product_ids
    : (await db.query(`select id from products where club_id = $1 and is_active and kind <> 'guest'`, [p.club_id])).rows.map((r) => r.id as string);
  let max = 0;
  for (const id of ids) { const price = await priceOf(db, id); if (price > 0) max = Math.max(max, Math.min(100, Number(p.discount_kop) * 100 / price)); }
  return Math.round(max * 10) / 10;
}

/** Создаёт согласование скидки: если процент в пределах лимита самого сотрудника — утверждено сразу. */
async function requestDiscountApproval(db: Db, ctx: Actor, a: { clubId: string; objectId: string; percent: number; amountKop: number; summary: string }) {
  const lim = await discountLimit(db, ctx.userId, a.clubId);
  const auto = lim === null || lim >= a.percent;
  const id = (await db.query(
    `insert into approvals(tenant_id, club_id, kind, object_id, amount_kop, percent, summary, status, requested_by, auto, decided_by, decided_at)
     values ($1,$2,'discount',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, a.clubId, a.objectId, a.amountKop, a.percent, a.summary, auto ? 'approved' : 'pending', ctx.userId, auto, auto ? ctx.userId : null, auto ? new Date() : null])).rows[0].id as string;
  await audit(db, ctx, auto ? 'approval.auto_approved' : 'approval.requested', 'approval', id, null, { kind: 'discount', percent: a.percent, limitPercent: lim });
  return { id, approved: auto };
}

/** Решение по согласованию скидки: включает акцию или разрешает разовую скидку. Вызывается из finance.ts. */
export async function applyDiscountDecision(db: Db, objectId: string, approved: boolean) {
  const promo = await db.query(`update promotions set status = $2 where id = $1 and status = 'pending' returning id`, [objectId, approved ? 'active' : 'rejected']);
  if (promo.rowCount) return;
  await db.query(`update discount_requests set status = $2 where id = $1 and status = 'pending'`, [objectId, approved ? 'approved' : 'rejected']);
}

/* ---------- скидка в продаже ---------- */
export type DiscountInput = { promoCode?: string; promoId?: string; discountPercent?: number; discountRequestId?: string };
export type Discount = { discountKop: number; promoId: string | null; requestId: string | null; label: string | null };

type PromoCheck = { personId: string; productId: string; clubId: string; category: string; amountKop: number; today: string };

/** Ищет акцию по коду или id и проверяет, что она подходит к этой продаже. Ошибка объясняет, почему не подходит. */
export async function findPromo(db: Db, by: { code?: string; id?: string }, s: PromoCheck) {
  const p = by.id
    ? (await db.query('select *, valid_from::text as vf, valid_to::text as vt from promotions where id = $1', [by.id])).rows[0]
    : (await db.query('select *, valid_from::text as vf, valid_to::text as vt from promotions where upper(code) = upper($1)', [String(by.code ?? '').trim()])).rows[0];
  if (!p) throw badRequest('Такого промокода нет', 'promo_not_found');
  if (p.club_id !== s.clubId) throw badRequest('Промокод действует в другом клубе', 'promo_other_club');
  if (p.status === 'pending') throw badRequest('Акция ещё ждёт согласования', 'promo_pending');
  if (p.status !== 'active') throw badRequest('Акция остановлена', 'promo_stopped');
  if (s.today < p.vf) throw badRequest(`Акция начнётся ${p.vf.split('-').reverse().join('.')}`, 'promo_not_started');
  if (s.today > p.vt) throw badRequest('Срок акции закончился', 'promo_expired');
  if (p.product_ids.length && !p.product_ids.includes(s.productId)) throw badRequest('Промокод не действует на этот тариф', 'promo_product');
  const cat = s.category === 'subscription' ? 'new' : s.category;
  if (p.condition !== 'any' && p.condition !== cat) throw badRequest(`Промокод действует ${CONDITION_NAME[p.condition]}`, 'promo_condition');
  if (p.max_uses) {
    const used = (await db.query(`select count(*)::int as n from memberships where promo_id = $1 and status <> 'cancelled'`, [p.id])).rows[0].n;
    if (used >= p.max_uses) throw badRequest('Промокод уже использован максимальное число раз', 'promo_used_up');
  }
  if ((await db.query(`select 1 from memberships where promo_id = $1 and person_id = $2 and status <> 'cancelled'`, [p.id, s.personId])).rowCount)
    throw badRequest('Клиент уже покупал по этой акции', 'promo_once');
  const discountKop = p.discount_percent != null ? Math.round(s.amountKop * Number(p.discount_percent) / 100) : Math.min(s.amountKop, Number(p.discount_kop));
  return { promo: p, discountKop };
}

/** Считает скидку для продажи. Ручная скидка больше лимита продавца не проходит: нужна разовая скидка через согласование. */
export async function resolveDiscount(db: Db, ctx: Actor, b: DiscountInput, s: PromoCheck): Promise<Discount> {
  const kinds = [b.promoCode?.trim() || b.promoId, b.discountPercent, b.discountRequestId].filter((x) => x !== undefined && x !== null && x !== '' && x !== 0);
  if (!kinds.length) return { discountKop: 0, promoId: null, requestId: null, label: null };
  if (kinds.length > 1) throw badRequest('Скидки не суммируются: выберите одну — промокод, ручную скидку или согласованную');
  if (b.promoCode?.trim() || b.promoId) {
    const { promo, discountKop } = await findPromo(db, { code: b.promoCode, id: b.promoId }, s);
    return { discountKop, promoId: promo.id, requestId: null, label: `акция «${promo.name}»` };
  }
  if (b.discountRequestId) {
    const r = (await db.query('select * from discount_requests where id = $1 for update', [b.discountRequestId])).rows[0];
    if (!r) throw notFound('Запрос на скидку не найден');
    if (r.person_id !== s.personId || r.product_id !== s.productId) throw badRequest('Согласованная скидка выдана на другого клиента или тариф');
    if (r.status === 'pending') throw badRequest('Скидка ещё ждёт согласования', 'discount_pending');
    if (r.status === 'used') throw badRequest('Эта скидка уже использована');
    if (r.status !== 'approved') throw badRequest('В скидке отказано');
    await db.query(`update discount_requests set status = 'used' where id = $1`, [r.id]);
    return { discountKop: Math.round(s.amountKop * Number(r.percent) / 100), promoId: null, requestId: r.id, label: `согласованная скидка ${Number(r.percent)} %` };
  }
  const pct = Number(b.discountPercent);
  if (!(pct > 0 && pct <= 100)) throw badRequest('Скидка указывается в процентах от 0 до 100');
  const lim = await discountLimit(db, ctx.userId, s.clubId);
  if (lim !== null && pct > lim) throw new HttpError(400, lim === 0 ? 'У вас нет права давать скидку. Запросите согласование' : `Скидка больше вашего лимита (${lim} %). Запросите согласование`, 'discount_over_limit');
  return { discountKop: Math.round(s.amountKop * pct / 100), promoId: null, requestId: null, label: `скидка ${pct} %` };
}

/* ---------- отчёт по акциям ---------- */
export async function promoReport(db: Db, clubId: string | null) {
  return (await db.query(
    `select p.id, p.name, p.code, p.channel, p.status, p.valid_from::text as "validFrom", p.valid_to::text as "validTo", p.discount_percent as "discountPercent", p.discount_kop as "discountKop",
       p.condition, p.max_uses as "maxUses", p.club_id as "clubId", c.name as "clubName", p.product_ids as "productIds", u.full_name as "createdBy",
       count(m.id)::int as sales,
       coalesce(sum(m.amount_kop), 0)::bigint as revenue,
       coalesce(sum(m.discount_kop), 0)::bigint as cost,
       count(distinct m.person_id)::int as clients,
       count(distinct m.person_id) filter (where m.sale_category in ('new', 'subscription'))::int as "newClients",
       count(distinct m.person_id) filter (where exists (select 1 from memberships r where r.renewed_from_id = m.id and r.status <> 'cancelled'))::int as renewed,
       count(distinct m.person_id) filter (where m.ends_on < current_date)::int as ended
     from promotions p join clubs c on c.id = p.club_id left join users u on u.id = p.created_by
       left join memberships m on m.promo_id = p.id and m.status <> 'cancelled'
     where ($1::uuid is null or p.club_id = $1)
     group by p.id, c.name, u.full_name order by p.created_at desc`, [clubId])).rows.map((r) => ({
    ...r, discountPercent: r.discountPercent == null ? null : Number(r.discountPercent), discountKop: r.discountKop == null ? null : Number(r.discountKop),
    revenue: Number(r.revenue), cost: Number(r.cost),
    // Доля продлений среди тех, у кого абонемент по акции уже закончился или был продлён
    renewalPct: r.ended + r.renewed > 0 ? Math.round(r.renewed * 100 / Math.max(r.ended, r.renewed)) : null,
    // Окупаемость: выручка на рубль скидки
    roi: Number(r.cost) > 0 ? Math.round(Number(r.revenue) / Number(r.cost) * 10) / 10 : null,
  }));
}

/* ---------- маршруты ---------- */
type PromoBody = { clubId?: string; name?: string; code?: string | null; channel?: string | null; discountPercent?: number | null; discountKop?: number | null;
  productIds?: string[]; condition?: string; validFrom?: string; validTo?: string; maxUses?: number | null };

export function promoRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/promos', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const rows = await promoReport(db, clubId && clubId !== 'all' ? clubId : null);
      return rows.map((r) => ({ ...r, canManage: can(ctx, P.tariffsManage) }));
    });
  });

  app.get('/api/promos/limit', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId) throw badRequest('Не указан клуб');
    return withCtx(pool, ctx, async (db) => ({ percent: await discountLimit(db, ctx.userId, clubId) }));
  });

  // Проверка промокода в форме продажи: показывает цену со скидкой до оформления
  app.post('/api/promos/check', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const b = (req.body ?? {}) as { code?: string; personId?: string; productId?: string; renewFromId?: string };
    if (!b.code?.trim() || !b.personId || !b.productId) throw badRequest('Укажите промокод, клиента и тариф');
    return withCtx(pool, ctx, async (db) => {
      const prod = (await db.query('select id, club_id, kind from products where id = $1', [b.productId])).rows[0];
      if (!prod) throw badRequest('Тариф не найден');
      const before = (await db.query('select count(*)::int as n from memberships where person_id = $1 and club_id = $2', [b.personId, prod.club_id])).rows[0].n;
      const category = prod.kind === 'subscription' ? 'subscription' : b.renewFromId ? 'renewal' : before > 0 ? 'return' : 'new';
      const amountKop = await priceOf(db, prod.id);
      const { promo, discountKop } = await findPromo(db, { code: b.code }, { personId: b.personId!, productId: prod.id, clubId: prod.club_id, category, amountKop, today: await clubToday(db, prod.club_id) });
      return { promoId: promo.id, name: promo.name, priceKop: amountKop, discountKop, totalKop: amountKop - discountKop };
    });
  });

  app.post('/api/promos', async (req, reply) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const b = (req.body ?? {}) as PromoBody;
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!b.name?.trim()) throw badRequest('Укажите название акции');
    const pct = b.discountPercent == null ? null : Number(b.discountPercent);
    const kop = b.discountKop == null ? null : Math.round(Number(b.discountKop));
    if ((pct == null) === (kop == null)) throw badRequest('Укажите скидку: процент или сумму');
    if (pct != null && !(pct > 0 && pct <= 100)) throw badRequest('Процент скидки от 0 до 100');
    if (kop != null && !(kop > 0)) throw badRequest('Сумма скидки должна быть больше нуля');
    if (!isDate(b.validFrom) || !isDate(b.validTo) || b.validTo < b.validFrom) throw badRequest('Укажите срок действия акции');
    const condition = b.condition ?? 'any';
    if (!(condition in CONDITION_NAME)) throw badRequest('Неизвестное условие');
    const code = b.code?.trim() ? b.code.trim().toUpperCase() : null;
    if (code && !/^[A-ZА-ЯЁ0-9_-]{3,30}$/.test(code)) throw badRequest('Промокод: от 3 до 30 букв и цифр без пробелов');
    const maxUses = b.maxUses ? Math.floor(Number(b.maxUses)) : null;
    if (maxUses !== null && !(maxUses > 0)) throw badRequest('Ограничение по числу использований должно быть больше нуля');
    return withCtx(pool, ctx, async (db) => {
      if (code && (await db.query('select 1 from promotions where upper(code) = $1', [code])).rowCount) throw badRequest('Такой промокод уже есть');
      const productIds = (b.productIds ?? []).filter(Boolean);
      if (productIds.length) {
        const ok = (await db.query('select count(*)::int as n from products where id = any($1) and club_id = $2', [productIds, b.clubId])).rows[0].n;
        if (ok !== productIds.length) throw badRequest('Тарифы акции должны быть из этого клуба');
      }
      const id = (await db.query(
        `insert into promotions(tenant_id, club_id, name, code, channel, discount_percent, discount_kop, product_ids, condition, valid_from, valid_to, max_uses, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13) returning *`,
        [ctx.tenantId, b.clubId, b.name!.trim(), code, b.channel?.trim() || null, pct, kop, productIds, condition, b.validFrom, b.validTo, maxUses, ctx.userId])).rows[0];
      const percent = await promoMaxPercent(db, id);
      const ap = await requestDiscountApproval(db, ctx, { clubId: b.clubId!, objectId: id.id, percent, amountKop: kop ?? 0,
        summary: `Акция «${id.name}»: скидка ${pct != null ? `${pct} %` : rubs(kop!)}${code ? `, промокод ${code}` : ''}` });
      if (ap.approved) await db.query(`update promotions set status = 'active' where id = $1`, [id.id]);
      await audit(db, ctx, 'promo.created', 'promotion', id.id, null, { name: id.name, code, discountPercent: pct, discountKop: kop, maxPercent: percent, approved: ap.approved });
      reply.code(201);
      return { id: id.id, status: ap.approved ? 'active' : 'pending', approvalId: ap.approved ? null : ap.id };
    });
  });

  // Остановить или снова включить акцию. Удалять нельзя: по ней есть продажи и отчёт
  app.post('/api/promos/:id/status', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (!['active', 'stopped'].includes(status ?? '')) throw badRequest('Неизвестный статус');
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select * from promotions where id = $1', [id])).rows[0];
      if (!p) throw notFound('Акция не найдена');
      if (!['active', 'stopped'].includes(p.status)) throw badRequest('Акция ещё не согласована или в ней отказано');
      await db.query('update promotions set status = $2 where id = $1', [id, status]);
      await audit(db, ctx, 'promo.status', 'promotion', id, { status: p.status }, { status });
      return { ok: true };
    });
  });

  // Разовая скидка конкретному клиенту сверх своего лимита: уходит на согласование
  app.post('/api/discount-requests', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const b = (req.body ?? {}) as { personId?: string; productId?: string; percent?: number; reason?: string };
    const pct = Number(b.percent);
    if (!b.personId || !b.productId) throw badRequest('Укажите клиента и тариф');
    if (!(pct > 0 && pct <= 100)) throw badRequest('Скидка в процентах от 0 до 100');
    if (!b.reason?.trim()) throw badRequest('Укажите причину скидки');
    return withCtx(pool, ctx, async (db) => {
      const prod = (await db.query('select id, club_id, name from products where id = $1', [b.productId])).rows[0];
      if (!prod) throw badRequest('Тариф не найден');
      const person = (await db.query(`select full_name as name from persons where id = $1`, [b.personId])).rows[0];
      if (!person) throw badRequest('Клиент не найден');
      const price = await priceOf(db, prod.id);
      const id = (await db.query(`insert into discount_requests(tenant_id, club_id, person_id, product_id, percent, reason, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, prod.club_id, b.personId, prod.id, pct, b.reason!.trim(), ctx.userId])).rows[0].id as string;
      const ap = await requestDiscountApproval(db, ctx, { clubId: prod.club_id, objectId: id, percent: pct, amountKop: Math.round(price * pct / 100),
        summary: `Скидка ${pct} % клиенту ${person.name} на «${prod.name}»: ${b.reason!.trim()}` });
      if (ap.approved) await db.query(`update discount_requests set status = 'approved' where id = $1`, [id]);
      reply.code(201);
      return { id, status: ap.approved ? 'approved' : 'pending' };
    });
  });

  // Согласованные скидки клиента, которые ещё можно применить (форма продажи)
  app.get('/api/persons/:id/discount-requests', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select d.id, d.product_id as "productId", p.name as "productName", d.percent::float as percent, d.reason, d.status, d.created_at as "createdAt"
       from discount_requests d join products p on p.id = d.product_id where d.person_id = $1 and d.status in ('pending', 'approved') order by d.created_at desc`, [id])).rows);
  });

}
