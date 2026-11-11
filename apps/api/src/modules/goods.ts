// Товары и услуги на ресепшне (список «20 новых возможностей», п. 10).
// Справочник товаров (с остатками) и услуг (без остатков), продажа с чеком через кассу клуба, приход и списание, покупка «на счёт» клиента.
// Деньги не переписываются: оплата идёт в журнал платежей (категория «Товары и услуги»), наличные — только при открытой смене.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { recordPayment } from './finance.ts';
import { receiptForGoods } from './fiscal.ts';
import { clubToday } from './memberships.ts';
import { depositSpend } from './gifts.ts';
import { loyaltySpend, pointsForKop } from './loyalty.ts';

const METHODS = ['cash', 'card_terminal'];
type GoodsIn = { clubId?: string; name?: string; kind?: string; category?: string | null; priceKop?: number; minStock?: number | null; isActive?: boolean; sort?: number };

async function move(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, g: { id: string; club_id: string; stock: number | null }, kind: string, qty: number, extra: { costKop?: number | null; comment?: string | null; saleId?: string | null } = {}) {
  const after = (await db.query('update goods set stock = coalesce(stock, 0) + $2 where id = $1 returning stock', [g.id, qty])).rows[0].stock as number;
  await db.query(`insert into goods_moves(tenant_id, club_id, goods_id, kind, qty, stock_after, cost_kop, comment, sale_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, g.club_id, g.id, kind, qty, after, extra.costKop ?? null, extra.comment ?? null, extra.saleId ?? null, ctx.userId]);
  return after;
}

/** Продажа: позиции, оплата сразу (наличные или карта) или на счёт клиента (долг, оплачивается позже как обычный платёж) */
export async function sellGoods(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId' | 'ip'>, b: { clubId?: string; personId?: string | null; method?: string | null; items?: { goodsId: string; qty: number }[] }) {
  if (!b.clubId) throw badRequest('Выберите клуб');
  const items = (b.items ?? []).filter((i) => i && i.goodsId);
  if (!items.length) throw badRequest('Добавьте товар или услугу');
  const onAccount = !b.method;
  const fromDeposit = b.method === 'deposit';
  const fromPoints = b.method === 'points';
  if (!onAccount && !fromDeposit && !fromPoints && !METHODS.includes(b.method!)) throw badRequest('Выберите способ оплаты');
  if (fromPoints && !b.personId) throw badRequest('Баллами можно оплатить только клиенту: найдите его карточку');
  if (fromDeposit && !b.personId) throw badRequest('С депозита можно оплатить только клиенту: найдите его карточку');
  if (onAccount && !b.personId) throw badRequest('На счёт можно записать только клиенту: найдите его карточку');
  if (b.personId && !(await db.query('select 1 from persons where id = $1', [b.personId])).rowCount) throw badRequest('Клиент не найден');
  const lines: { g: { id: string; club_id: string; name: string; kind: string; stock: number | null; price_kop: string }; qty: number }[] = [];
  for (const i of items) {
    const qty = Math.floor(Number(i.qty));
    if (!(qty >= 1 && qty <= 999)) throw badRequest('Количество от 1 до 999');
    const g = (await db.query('select * from goods where id = $1 for update', [i.goodsId])).rows[0];
    if (!g || g.club_id !== b.clubId) throw badRequest('Товар не найден в этом клубе');
    if (!g.is_active) throw badRequest(`«${g.name}» снят с продажи`);
    const same = lines.find((l) => l.g.id === g.id);
    if (same) same.qty += qty; else lines.push({ g, qty });
  }
  for (const l of lines) if (l.g.kind === 'goods' && (l.g.stock ?? 0) < l.qty) throw badRequest(`«${l.g.name}»: в наличии ${l.g.stock ?? 0} шт. Оформите приход или уменьшите количество`, 'out_of_stock');
  const total = lines.reduce((s, l) => s + Number(l.g.price_kop) * l.qty, 0);
  const title = lines.map((l) => `${l.g.name}${l.qty > 1 ? ` × ${l.qty}` : ''}`).join(', ').slice(0, 200);

  let chargeId: string | null = null;
  if (onAccount) {
    chargeId = (await db.query(`insert into charges(tenant_id, club_id, person_id, kind, title, due_on, amount_kop) values ($1,$2,$3,'goods',$4,$5,$6) returning id`,
      [ctx.tenantId, b.clubId, b.personId, `Покупка на ресепшне: ${title}`, await clubToday(db, b.clubId), total])).rows[0].id;
  }
  const saleId = (await db.query(`insert into goods_sales(tenant_id, club_id, person_id, total_kop, method, status, charge_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, b.clubId, b.personId ?? null, total, onAccount ? null : b.method, onAccount ? 'on_account' : 'paid', chargeId, ctx.userId])).rows[0].id as string;
  for (const l of lines) {
    await db.query(`insert into goods_sale_items(tenant_id, club_id, sale_id, goods_id, name, qty, price_kop, sum_kop) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, b.clubId, saleId, l.g.id, l.g.name, l.qty, l.g.price_kop, Number(l.g.price_kop) * l.qty]);
    if (l.g.kind === 'goods') await move(db, ctx, l.g, 'sale', -l.qty, { saleId });
  }
  let receiptId: string | null = null;
  // С депозита: деньги пришли при пополнении (там и чек), второй платёж в журнал не пишется
  // Баллами: это не деньги — платежа и чека нет, списание баллов отдельной строкой
  if (fromPoints) {
    const pts = await pointsForKop(db, b.clubId, total);
    await loyaltySpend(db, ctx, { clubId: b.clubId, personId: b.personId!, kind: 'spend_goods', points: pts, refId: saleId, comment: `Покупка: ${title}` });
  } else if (fromDeposit) await depositSpend(db, ctx, { clubId: b.clubId, personId: b.personId!, amountKop: total, goodsSaleId: saleId, comment: `Покупка: ${title}` });
  else if (!onAccount) {
    await recordPayment(db, ctx as never, { clubId: b.clubId, direction: 'in', kind: 'charge', amountKop: total, method: b.method!, personId: b.personId ?? null, saleCategory: 'goods' });
    receiptId = await receiptForGoods(db, ctx, { clubId: b.clubId, personId: b.personId ?? null, saleId, method: b.method!,
      items: lines.map((l) => ({ name: l.g.name, priceKop: Number(l.g.price_kop), quantity: l.qty, sumKop: Number(l.g.price_kop) * l.qty, commodity: l.g.kind === 'goods' })) });
    if (receiptId) await db.query('update goods_sales set receipt_id = $2 where id = $1', [saleId, receiptId]);
  }
  await audit(db, ctx, 'goods.sold', 'goods_sale', saleId, null, { totalKop: total, method: b.method ?? 'on_account', personId: b.personId ?? null, items: lines.map((l) => ({ id: l.g.id, qty: l.qty })) });
  return { id: saleId, totalKop: total, status: onAccount ? 'on_account' : 'paid', chargeId, receiptId };
}

export function goodsRoutes(app: FastifyInstance, pool: pg.Pool) {
  const clubOf = (q: { clubId?: string }) => { if (!q.clubId || q.clubId === 'all') throw badRequest('Выберите клуб'); return q.clubId; };

  app.get('/api/goods', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const clubId = clubOf(req.query as { clubId?: string });
    return withCtx(pool, ctx, async (db) => ({
      items: (await db.query(`select id, name, kind, category, price_kop::bigint as "priceKop", stock, min_stock as "minStock", is_active as "isActive", sort,
          (kind = 'goods' and min_stock is not null and coalesce(stock, 0) <= min_stock) as low
        from goods where club_id = $1 order by is_active desc, sort, category nulls last, name`, [clubId])).rows.map((r) => ({ ...r, priceKop: Number(r.priceKop) })),
      canManage: can(ctx, P.tariffsManage), canSell: can(ctx, P.membershipsSell) || can(ctx, P.shiftsWork),
    }));
  });

  app.post('/api/goods', async (req, reply) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const b = (req.body ?? {}) as GoodsIn & { stock?: number };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!b.name?.trim()) throw badRequest('Укажите название');
    const kind = b.kind === 'service' ? 'service' : 'goods';
    if (!(Number(b.priceKop) > 0)) throw badRequest('Укажите цену');
    return withCtx(pool, ctx, async (db) => {
      if ((await db.query('select 1 from goods where club_id = $1 and lower(name) = lower($2)', [b.clubId, b.name!.trim()])).rowCount) throw badRequest('Такой товар уже есть');
      const g = (await db.query(`insert into goods(tenant_id, club_id, name, kind, category, price_kop, stock, min_stock, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [ctx.tenantId, b.clubId, b.name!.trim(), kind, b.category?.trim() || null, Math.round(Number(b.priceKop)), kind === 'goods' ? 0 : null, kind === 'goods' && b.minStock != null ? Math.floor(Number(b.minStock)) : null, b.sort ?? 100])).rows[0];
      if (kind === 'goods' && Number(b.stock) > 0) await move(db, ctx, g, 'in', Math.floor(Number(b.stock)), { comment: 'Начальный остаток' });
      await audit(db, ctx, 'goods.created', 'goods', g.id, null, { name: g.name, kind, priceKop: Number(g.price_kop) });
      reply.code(201);
      return { id: g.id };
    });
  });

  app.patch('/api/goods/:id', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as GoodsIn;
    return withCtx(pool, ctx, async (db) => {
      const g = (await db.query('select * from goods where id = $1', [id])).rows[0];
      if (!g) throw notFound('Товар не найден');
      if (b.priceKop !== undefined && !(Number(b.priceKop) > 0)) throw badRequest('Цена должна быть больше нуля');
      const after = { name: b.name?.trim() || g.name, category: b.category === undefined ? g.category : b.category?.trim() || null, price_kop: b.priceKop === undefined ? g.price_kop : Math.round(Number(b.priceKop)),
        min_stock: b.minStock === undefined ? g.min_stock : b.minStock === null ? null : Math.floor(Number(b.minStock)), is_active: b.isActive ?? g.is_active, sort: b.sort ?? g.sort };
      await db.query('update goods set name = $2, category = $3, price_kop = $4, min_stock = $5, is_active = $6, sort = $7 where id = $1', [id, after.name, after.category, after.price_kop, after.min_stock, after.is_active, after.sort]);
      await audit(db, ctx, 'goods.updated', 'goods', id, { name: g.name, priceKop: Number(g.price_kop), isActive: g.is_active }, { name: after.name, priceKop: Number(after.price_kop), isActive: after.is_active });
      return { ok: true };
    });
  });

  // Приход, списание (бой, просрочка) и пересчёт остатка по факту
  app.post('/api/goods/:id/stock', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { kind?: string; qty?: number; costKop?: number; comment?: string };
    const qty = Math.floor(Number(b.qty));
    if (!['in', 'writeoff', 'count'].includes(b.kind ?? '')) throw badRequest('Выберите операцию');
    if (b.kind === 'count' ? !(qty >= 0) : !(qty >= 1)) throw badRequest('Укажите количество');
    if (b.kind === 'writeoff' && !b.comment?.trim()) throw badRequest('Укажите причину списания');
    return withCtx(pool, ctx, async (db) => {
      const g = (await db.query('select * from goods where id = $1 for update', [id])).rows[0];
      if (!g) throw notFound('Товар не найден');
      if (g.kind !== 'goods') throw badRequest('У услуги нет остатков');
      if (b.kind === 'writeoff' && qty > (g.stock ?? 0)) throw badRequest(`Списать можно не больше остатка (${g.stock ?? 0})`);
      const delta = b.kind === 'in' ? qty : b.kind === 'writeoff' ? -qty : qty - (g.stock ?? 0);
      if (b.kind === 'count' && delta === 0) return { stock: g.stock };
      const stock = await move(db, ctx, g, b.kind!, delta, { costKop: b.kind === 'in' && Number(b.costKop) > 0 ? Math.round(Number(b.costKop)) : null, comment: b.comment?.trim() || null });
      await audit(db, ctx, `goods.stock_${b.kind}`, 'goods', id, { stock: g.stock }, { stock, qty: delta, comment: b.comment ?? null });
      return { stock };
    });
  });

  app.get('/api/goods/:id/moves', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`select m.kind, m.qty, m.stock_after as "stockAfter", m.cost_kop::bigint as "costKop", m.comment, m.created_at as "createdAt", u.full_name as "by"
      from goods_moves m left join users u on u.id = m.created_by where m.goods_id = $1 order by m.created_at desc limit 100`, [id])).rows.map((r) => ({ ...r, costKop: r.costKop == null ? null : Number(r.costKop) })));
  });

  app.post('/api/goods/sales', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsView);
    if (!can(ctx, P.membershipsSell) && !can(ctx, P.shiftsWork)) requirePerm(req, P.membershipsSell);
    const res = await withCtx(pool, ctx, (db) => sellGoods(db, ctx, (req.body ?? {}) as Parameters<typeof sellGoods>[2]));
    reply.code(201);
    return res;
  });

  // Отмена покупки на счёт, пока её не оплатили: товар возвращается на склад, долг снимается
  app.post('/api/goods/sales/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason?.trim()) throw badRequest('Укажите причину отмены');
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query('select * from goods_sales where id = $1 for update', [id])).rows[0];
      if (!s) throw notFound('Продажа не найдена');
      if (s.status !== 'on_account') throw badRequest('Отменить можно только неоплаченную покупку на счёт. Оплаченную возвращайте через возврат');
      const ch = (await db.query('select status from charges where id = $1 for update', [s.charge_id])).rows[0];
      if (ch?.status !== 'due') throw badRequest('Покупку уже оплатили');
      await db.query(`update charges set status = 'cancelled' where id = $1`, [s.charge_id]);
      await db.query(`update goods_sales set status = 'cancelled' where id = $1`, [id]);
      for (const it of (await db.query('select i.goods_id, i.qty, g.kind, g.club_id, g.stock from goods_sale_items i join goods g on g.id = i.goods_id where i.sale_id = $1', [id])).rows)
        if (it.kind === 'goods') await move(db, ctx, { id: it.goods_id, club_id: it.club_id, stock: it.stock }, 'cancel', it.qty, { saleId: id, comment: reason.trim() });
      await audit(db, ctx, 'goods.sale_cancelled', 'goods_sale', id, { status: 'on_account' }, { status: 'cancelled', reason: reason.trim() });
      return { ok: true };
    });
  });

  // Отчёт: продажи за период по товарам, способам оплаты, неоплаченные покупки на счёт, что заканчивается
  app.get('/api/goods/report', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const q = req.query as { clubId?: string; from?: string; to?: string };
    const clubId = clubOf(q);
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from! : `${today.slice(0, 7)}-01`;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to! : today;
      const range = `s.club_id = $1 and s.status <> 'cancelled' and (s.created_at >= ($2)::date::timestamp at time zone c.timezone and s.created_at < (($3)::date + 1)::timestamp at time zone c.timezone)`;
      const byGoods = (await db.query(`select i.goods_id as "goodsId", i.name, sum(i.qty)::int as qty, sum(i.sum_kop)::bigint as sum
        from goods_sale_items i join goods_sales s on s.id = i.sale_id join clubs c on c.id = s.club_id where ${range} group by i.goods_id, i.name order by sum desc`, [clubId, from, to])).rows.map((r) => ({ ...r, sum: Number(r.sum) }));
      const byMethod = (await db.query(`select coalesce(s.method, 'on_account') as method, count(*)::int as n, sum(s.total_kop)::bigint as sum
        from goods_sales s join clubs c on c.id = s.club_id where ${range} group by 1`, [clubId, from, to])).rows.map((r) => ({ ...r, sum: Number(r.sum) }));
      const recent = (await db.query(`select s.id, s.created_at as "createdAt", s.total_kop::bigint as total, s.method, s.status, p.full_name as person, s.person_id as "personId", u.full_name as "by",
          ch.status as "chargeStatus", (select string_agg(i.name || case when i.qty > 1 then ' × ' || i.qty else '' end, ', ') from goods_sale_items i where i.sale_id = s.id) as items
        from goods_sales s left join persons p on p.id = s.person_id left join users u on u.id = s.created_by left join charges ch on ch.id = s.charge_id
        where s.club_id = $1 order by s.created_at desc limit 50`, [clubId])).rows.map((r) => ({ ...r, total: Number(r.total) }));
      const unpaid = (await db.query(`select count(*)::int as n, coalesce(sum(ch.amount_kop), 0)::bigint as sum from goods_sales s join charges ch on ch.id = s.charge_id
        where s.club_id = $1 and s.status = 'on_account' and ch.status = 'due'`, [clubId])).rows[0];
      const low = (await db.query(`select id, name, stock, min_stock as "minStock" from goods where club_id = $1 and is_active and kind = 'goods' and min_stock is not null and coalesce(stock, 0) <= min_stock order by name`, [clubId])).rows;
      return { from, to, total: byMethod.reduce((a, r) => a + r.sum, 0), byGoods, byMethod, recent, unpaid: { n: unpaid.n, sum: Number(unpaid.sum) }, low };
    });
  });
}
