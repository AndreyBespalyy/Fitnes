// Подарочные сертификаты и депозит клиента (список «20 новых возможностей», п. 11).
// Депозит — внутренний счёт клиента в клубе. Деньги приходят один раз: при пополнении или продаже сертификата (платёж и чек «аванс»).
// Оплата с депозита или сертификатом закрывает начисление без второго платежа в журнале, чтобы выручка не задваивалась.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomInt } from 'node:crypto';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { recordPayment } from './finance.ts';
import { receiptForItems } from './fiscal.ts';
import { clubToday, sellMembership } from './memberships.ts';

type Actor = Pick<Ctx, 'tenantId' | 'userId' | 'ip'>;
const METHODS = ['cash', 'card_terminal'];
const MAX_KOP = 100_000_000; // 1 млн ₽
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const kopOk = (k: unknown) => Number.isInteger(k) && (k as number) >= 100 && (k as number) <= MAX_KOP;

export async function depositBalance(db: Db, personId: string, clubId: string) {
  return Number((await db.query('select coalesce(sum(amount_kop), 0)::bigint as b from deposit_moves where person_id = $1 and club_id = $2', [personId, clubId])).rows[0].b);
}
async function lockPerson(db: Db, personId: string) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`deposit:${personId}`]);
}
async function addMove(db: Db, ctx: Actor, m: { clubId: string; personId: string; kind: string; amountKop: number; method?: string | null; chargeId?: string | null; goodsSaleId?: string | null; giftCertId?: string | null; comment?: string | null }) {
  return (await db.query(`insert into deposit_moves(tenant_id, club_id, person_id, kind, amount_kop, method, charge_id, goods_sale_id, gift_cert_id, comment, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
  [ctx.tenantId, m.clubId, m.personId, m.kind, m.amountKop, m.method ?? null, m.chargeId ?? null, m.goodsSaleId ?? null, m.giftCertId ?? null, m.comment ?? null, ctx.userId])).rows[0].id as string;
}

/** Списать с депозита. Ошибка, если денег не хватает. */
export async function depositSpend(db: Db, ctx: Actor, a: { clubId: string; personId: string; amountKop: number; chargeId?: string; goodsSaleId?: string; comment: string }) {
  await lockPerson(db, a.personId);
  const bal = await depositBalance(db, a.personId, a.clubId);
  if (bal < a.amountKop) throw badRequest(`На депозите ${rub(bal)}, нужно ${rub(a.amountKop)}. Пополните депозит или выберите другой способ оплаты`, 'deposit_low');
  return addMove(db, ctx, { clubId: a.clubId, personId: a.personId, kind: 'spend', amountKop: -a.amountKop, chargeId: a.chargeId, goodsSaleId: a.goodsSaleId, comment: a.comment });
}

/** Закрыть начисление без денежного платежа (депозит или сертификат): деньги уже пришли раньше. */
async function settleCharge(db: Db, ctx: Actor, chargeId: string, method: 'deposit' | 'gift') {
  const c = (await db.query('select * from charges where id = $1 for update', [chargeId])).rows[0];
  if (!c) throw notFound();
  if (c.status !== 'due') throw badRequest('Начисление уже оплачено или отменено');
  await db.query(`update charges set status = 'paid', paid_at = now(), paid_method = $2, paid_by = $3, autopay_error = null where id = $1`, [chargeId, method, ctx.userId]);
  if (c.kind === 'goods') await db.query(`update goods_sales set status = 'paid', method = $2 where charge_id = $1 and status = 'on_account'`, [chargeId, method]);
  if (c.membership_id) {
    await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'charge_paid',$4,$5)`,
      [ctx.tenantId, c.club_id, c.membership_id, JSON.stringify({ chargeId, method, amountKop: Number(c.amount_kop) }), ctx.userId]);
  }
  return c as { club_id: string; person_id: string; amount_kop: string; title: string };
}

/** Оплатить начисление с депозита клиента. */
export async function payChargeFromDeposit(db: Db, ctx: Actor, chargeId: string) {
  const c = (await db.query('select club_id, person_id, amount_kop, title, status from charges where id = $1', [chargeId])).rows[0];
  if (!c) throw notFound();
  if (c.status !== 'due') throw badRequest('Начисление уже оплачено или отменено');
  await depositSpend(db, ctx, { clubId: c.club_id, personId: c.person_id, amountKop: Number(c.amount_kop), chargeId, comment: c.title });
  await settleCharge(db, ctx, chargeId, 'deposit');
  await audit(db, ctx, 'charge.paid_deposit', 'charge', chargeId, { status: 'due' }, { status: 'paid', method: 'deposit' });
  return { ok: true, balanceKop: await depositBalance(db, c.person_id, c.club_id) };
}

/** Код сертификата: без похожих букв и цифр (0/O, 1/I), чтобы легко продиктовать. */
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => A[randomInt(A.length)]).join('');
  return `GIFT-${part()}-${part()}`;
}

const CERT_SELECT = `select c.id, c.code, c.kind, c.amount_kop::bigint as "amountKop", c.product_id as "productId", c.product_name as "productName",
  to_char(c.valid_to, 'YYYY-MM-DD') as "validTo", case when c.status = 'active' and c.valid_to < $2::date then 'expired' else c.status end as status,
  c.buyer_person_id as "buyerId", coalesce(bp.full_name, c.buyer_name) as buyer, c.recipient_name as "recipientName", c.method, c.sold_at as "soldAt",
  c.used_person_id as "usedPersonId", up.full_name as "usedBy", c.used_at as "usedAt", c.club_id as "clubId"
  from gift_certs c left join persons bp on bp.id = c.buyer_person_id left join persons up on up.id = c.used_person_id`;
const certOut = (r: Record<string, unknown>) => ({ ...r, amountKop: Number(r.amountKop) });

export function giftRoutes(app: FastifyInstance, pool: pg.Pool) {
  const sellPerm = (req: Parameters<typeof requirePerm>[0]) => {
    const ctx = requirePerm(req, P.membershipsView);
    if (!can(ctx, P.membershipsSell) && !can(ctx, P.shiftsWork)) throw forbidden();
    return ctx;
  };

  /* ---------- депозит ---------- */
  app.get('/api/persons/:id/deposit', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const balances = (await db.query(`select d.club_id as "clubId", c.name as "clubName", sum(d.amount_kop)::bigint as b from deposit_moves d join clubs c on c.id = d.club_id
        where d.person_id = $1 group by 1, 2 order by 2`, [id])).rows.map((r) => ({ clubId: r.clubId, clubName: r.clubName, balanceKop: Number(r.b) }));
      const moves = (await db.query(`select d.id, d.kind, d.amount_kop::bigint as "amountKop", d.method, d.comment, d.created_at as "createdAt", u.full_name as "by", c.name as "clubName", g.code as "certCode"
        from deposit_moves d join clubs c on c.id = d.club_id left join users u on u.id = d.created_by left join gift_certs g on g.id = d.gift_cert_id
        where d.person_id = $1 and ($2::uuid is null or d.club_id = $2) order by d.created_at desc limit 50`, [id, clubId && clubId !== 'all' ? clubId : null])).rows
        .map((r) => ({ ...r, amountKop: Number(r.amountKop) }));
      const today = clubId && clubId !== 'all' ? await clubToday(db, clubId) : new Date().toISOString().slice(0, 10);
      const certs = (await db.query(`${CERT_SELECT} where c.buyer_person_id = $1 order by c.sold_at desc limit 20`, [id, today])).rows.map(certOut);
      const balanceKop = clubId && clubId !== 'all' ? (balances.find((b) => b.clubId === clubId)?.balanceKop ?? 0) : balances.reduce((s, b) => s + b.balanceKop, 0);
      return { balanceKop, balances, moves, certs, canTopup: can(ctx, P.membershipsSell) || can(ctx, P.shiftsWork), canRefund: can(ctx, P.approvalsDecide) };
    });
  });

  app.post('/api/persons/:id/deposit/topup', async (req) => {
    const ctx = sellPerm(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { clubId?: string; amountKop?: number; method?: string };
    if (!b.clubId || b.clubId === 'all') throw badRequest('Выберите клуб');
    if (!kopOk(b.amountKop)) throw badRequest('Сумма пополнения от 1 ₽ до 1 000 000 ₽');
    if (!METHODS.includes(b.method ?? '')) throw badRequest('Выберите способ оплаты');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from persons where id = $1', [id])).rowCount) throw notFound();
      await lockPerson(db, id);
      await recordPayment(db, ctx as never, { clubId: b.clubId!, direction: 'in', kind: 'charge', amountKop: b.amountKop!, method: b.method!, personId: id, saleCategory: 'deposit' });
      const moveId = await addMove(db, ctx, { clubId: b.clubId!, personId: id, kind: 'topup', amountKop: b.amountKop!, method: b.method, comment: 'Пополнение депозита' });
      const receiptId = await receiptForItems(db, ctx, { clubId: b.clubId!, personId: id, method: b.method!, link: { depositMoveId: moveId },
        items: [{ name: 'Аванс: пополнение депозита', priceKop: b.amountKop!, quantity: 1, sumKop: b.amountKop!, advance: true }] });
      await audit(db, ctx, 'deposit.topup', 'person', id, null, { clubId: b.clubId, amountKop: b.amountKop, method: b.method, receiptId });
      return { ok: true, receiptId, balanceKop: await depositBalance(db, id, b.clubId!) };
    });
  });

  // Возврат остатка депозита клиенту деньгами — только управляющий или собственник
  app.post('/api/persons/:id/deposit/refund', async (req) => {
    const ctx = requirePerm(req, P.approvalsDecide);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { clubId?: string; amountKop?: number; method?: string; comment?: string };
    if (!b.clubId || b.clubId === 'all') throw badRequest('Выберите клуб');
    if (!kopOk(b.amountKop)) throw badRequest('Укажите сумму возврата');
    if (!['cash', 'card_terminal', 'bank_transfer'].includes(b.method ?? '')) throw badRequest('Выберите способ возврата');
    if (!b.comment?.trim()) throw badRequest('Укажите причину возврата');
    return withCtx(pool, ctx, async (db) => {
      await lockPerson(db, id);
      const bal = await depositBalance(db, id, b.clubId!);
      if (bal < b.amountKop!) throw badRequest(`На депозите только ${rub(bal)}`);
      await recordPayment(db, ctx as never, { clubId: b.clubId!, direction: 'out', kind: 'refund', amountKop: b.amountKop!, method: b.method!, personId: id, saleCategory: 'deposit' });
      await addMove(db, ctx, { clubId: b.clubId!, personId: id, kind: 'refund', amountKop: -b.amountKop!, method: b.method, comment: b.comment!.trim() });
      await audit(db, ctx, 'deposit.refund', 'person', id, null, { clubId: b.clubId, amountKop: b.amountKop, method: b.method, comment: b.comment });
      return { ok: true, balanceKop: await depositBalance(db, id, b.clubId!) };
    });
  });

  app.post('/api/charges/:id/pay-deposit', async (req) => {
    const ctx = sellPerm(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => payChargeFromDeposit(db, ctx, id));
  });

  /* ---------- подарочные сертификаты ---------- */
  app.get('/api/gift-certs', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { clubId, q } = req.query as { clubId?: string; q?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const items = (await db.query(`${CERT_SELECT} where c.club_id = $1 and ($3::text is null or c.code ilike '%' || $3 || '%' or c.recipient_name ilike '%' || $3 || '%' or coalesce(bp.full_name, c.buyer_name) ilike '%' || $3 || '%')
        order by c.sold_at desc limit 200`, [clubId, today, q?.trim() || null])).rows.map(certOut);
      const s = (await db.query(`select count(*) filter (where sold_at > now() - interval '30 days')::int as sold30, coalesce(sum(amount_kop) filter (where sold_at > now() - interval '30 days'), 0)::bigint as sum30,
          coalesce(sum(amount_kop) filter (where status = 'active' and valid_to >= $2::date), 0)::bigint as outstanding, count(*) filter (where status = 'active' and valid_to >= $2::date)::int as active,
          count(*) filter (where status = 'used' and used_at > now() - interval '30 days')::int as used30
        from gift_certs where club_id = $1`, [clubId, today])).rows[0];
      const deposits = Number((await db.query('select coalesce(sum(amount_kop), 0)::bigint as b from deposit_moves where club_id = $1', [clubId])).rows[0].b);
      return { items, stats: { sold30: s.sold30, sum30: Number(s.sum30), outstanding: Number(s.outstanding), active: s.active, used30: s.used30, deposits },
        canSell: can(ctx, P.membershipsSell) || can(ctx, P.shiftsWork), canCancel: can(ctx, P.approvalsDecide) };
    });
  });

  app.post('/api/gift-certs', async (req) => {
    const ctx = sellPerm(req);
    const b = (req.body ?? {}) as { clubId?: string; kind?: string; amountKop?: number; productId?: string; buyerPersonId?: string | null; buyerName?: string; recipientName?: string; method?: string; validDays?: number };
    if (!b.clubId || b.clubId === 'all') throw badRequest('Выберите клуб');
    if (!['amount', 'product'].includes(b.kind ?? '')) throw badRequest('Выберите вид сертификата');
    if (!METHODS.includes(b.method ?? '')) throw badRequest('Выберите способ оплаты');
    if (!b.buyerPersonId && !b.buyerName?.trim()) throw badRequest('Укажите покупателя');
    const days = b.validDays ?? 365;
    if (!(Number.isInteger(days) && days >= 30 && days <= 1095)) throw badRequest('Срок действия от 30 дней до 3 лет');
    return withCtx(pool, ctx, async (db) => {
      let amount = b.amountKop ?? 0;
      let productName: string | null = null;
      if (b.kind === 'product') {
        const p = (await db.query(`select p.name, p.kind, p.club_id, p.is_active, (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by v.valid_from desc limit 1)::bigint as price
          from products p where p.id = $1`, [b.productId ?? null])).rows[0];
        if (!p || p.club_id !== b.clubId) throw badRequest('Тариф не найден в этом клубе');
        if (!p.is_active) throw badRequest('Тариф снят с продажи');
        if (p.kind === 'subscription') throw badRequest('Подписку нельзя подарить сертификатом: она оплачивается каждый месяц. Подарите сертификат на сумму');
        if (!p.price) throw badRequest('У тарифа нет цены');
        amount = Number(p.price); productName = p.name;
      } else if (!kopOk(amount)) throw badRequest('Номинал от 1 ₽ до 1 000 000 ₽');
      if (b.buyerPersonId && !(await db.query('select 1 from persons where id = $1', [b.buyerPersonId])).rowCount) throw badRequest('Покупатель не найден');
      const today = await clubToday(db, b.clubId!);
      let code = newCode();
      while ((await db.query('select 1 from gift_certs where code = $1', [code])).rowCount) code = newCode();
      const id = (await db.query(`insert into gift_certs(tenant_id, club_id, code, kind, amount_kop, product_id, product_name, valid_to, buyer_person_id, buyer_name, recipient_name, method, sold_by)
        values ($1,$2,$3,$4,$5,$6,$7,($8::date + $9::int),$10,$11,$12,$13,$14) returning id`,
      [ctx.tenantId, b.clubId, code, b.kind, amount, b.kind === 'product' ? b.productId : null, productName, today, days, b.buyerPersonId ?? null,
        b.buyerPersonId ? null : b.buyerName!.trim(), b.recipientName?.trim() || null, b.method, ctx.userId])).rows[0].id as string;
      await recordPayment(db, ctx as never, { clubId: b.clubId!, direction: 'in', kind: 'charge', amountKop: amount, method: b.method!, personId: b.buyerPersonId ?? null, saleCategory: 'gift' });
      const receiptId = await receiptForItems(db, ctx, { clubId: b.clubId!, personId: b.buyerPersonId ?? null, method: b.method!, link: { giftCertId: id },
        items: [{ name: `Подарочный сертификат ${code}`, priceKop: amount, quantity: 1, sumKop: amount, advance: true }] });
      if (receiptId) await db.query('update gift_certs set receipt_id = $2 where id = $1', [id, receiptId]);
      await audit(db, ctx, 'gift.sold', 'gift_cert', id, null, { code, kind: b.kind, amountKop: amount, productId: b.productId ?? null, method: b.method, receiptId });
      return certOut((await db.query(`${CERT_SELECT} where c.id = $1`, [id, today])).rows[0]);
    });
  });

  app.get('/api/gift-certs/check', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { code } = req.query as { code?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query(`select club_id from gift_certs where code = upper(trim($1))`, [code ?? ''])).rows[0];
      if (!c) throw badRequest('Сертификат с таким кодом не найден', 'not_found');
      return certOut((await db.query(`${CERT_SELECT} where c.code = upper(trim($1))`, [code, await clubToday(db, c.club_id)])).rows[0]);
    });
  });

  // Погашение: сертификат на сумму зачисляется на депозит получателя, сертификат на абонемент оформляет абонемент без доплаты
  app.post('/api/gift-certs/redeem', async (req) => {
    const ctx = sellPerm(req);
    const b = (req.body ?? {}) as { code?: string; personId?: string; startsOn?: string };
    if (!b.personId) throw badRequest('Выберите клиента, который получает подарок');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query(`select *, valid_to::text as vt from gift_certs where code = upper(trim($1)) for update`, [b.code ?? ''])).rows[0];
      if (!c) throw badRequest('Сертификат с таким кодом не найден', 'not_found');
      const today = await clubToday(db, c.club_id);
      if (c.status === 'used') throw badRequest('Сертификат уже использован', 'gift_used');
      if (c.status === 'cancelled') throw badRequest('Сертификат аннулирован', 'gift_cancelled');
      if (c.vt < today) throw badRequest('Срок действия сертификата истёк', 'gift_expired');
      if (!(await db.query('select 1 from persons where id = $1', [b.personId])).rowCount) throw badRequest('Клиент не найден');
      let membershipId: string | null = null;
      if (c.kind === 'amount') {
        await lockPerson(db, b.personId!);
        await addMove(db, ctx, { clubId: c.club_id, personId: b.personId!, kind: 'cert', amountKop: Number(c.amount_kop), giftCertId: c.id, comment: `Сертификат ${c.code}` });
      } else {
        const sale = await sellMembership(db, ctx, { personId: b.personId, productId: c.product_id, startsOn: b.startsOn, confirmDuplicate: true });
        membershipId = sale.id;
        const charges = (await db.query(`select id from charges where membership_id = $1 and status = 'due'`, [membershipId])).rows;
        for (const ch of charges) await settleCharge(db, ctx, ch.id, 'gift');
      }
      await db.query(`update gift_certs set status = 'used', used_person_id = $2, used_membership_id = $3, used_at = now(), used_by = $4 where id = $1`, [c.id, b.personId, membershipId, ctx.userId]);
      await audit(db, ctx, 'gift.redeemed', 'gift_cert', c.id, { status: 'active' }, { status: 'used', personId: b.personId, membershipId });
      return { ok: true, kind: c.kind, membershipId, balanceKop: c.kind === 'amount' ? await depositBalance(db, b.personId!, c.club_id) : null };
    });
  });

  // Аннулировать неиспользованный сертификат с возвратом денег покупателю — только управляющий или собственник
  app.post('/api/gift-certs/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.approvalsDecide);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { method?: string; comment?: string };
    if (!['cash', 'card_terminal', 'bank_transfer'].includes(b.method ?? '')) throw badRequest('Выберите способ возврата денег');
    if (!b.comment?.trim()) throw badRequest('Укажите причину');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select * from gift_certs where id = $1 for update', [id])).rows[0];
      if (!c) throw notFound();
      if (c.status !== 'active') throw badRequest('Аннулировать можно только неиспользованный сертификат');
      await recordPayment(db, ctx as never, { clubId: c.club_id, direction: 'out', kind: 'refund', amountKop: Number(c.amount_kop), method: b.method!, personId: c.buyer_person_id, saleCategory: 'gift' });
      await db.query(`update gift_certs set status = 'cancelled' where id = $1`, [id]);
      await audit(db, ctx, 'gift.cancelled', 'gift_cert', id, { status: 'active' }, { status: 'cancelled', method: b.method, comment: b.comment });
      return { ok: true };
    });
  });
}
