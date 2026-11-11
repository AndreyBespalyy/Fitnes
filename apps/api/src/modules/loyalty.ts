// Бонусная программа лояльности (список «20 новых возможностей», п. 18).
// Начисления идут фоном по уже случившимся событиям (посещение, оплата, продление, рекомендация, отзыв) — один раз на событие.
// Уровень клиента (по стажу или сумме покупок) увеличивает начисления за визиты и покупки. Баллы сгорают через срок, старые — первыми.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { addDays, clubToday } from './memberships.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Level = { code: string; name: string; minMonths: number; minSpendKop: number; bonusPercent: number };
export type LoyaltySettings = {
  enabled: boolean; enabledAt: string | null; pointValueKop: number; visitPoints: number; purchasePercent: number; renewalPoints: number; referralPoints: number;
  reviewPoints: number; expireDays: number; spendGoods: boolean; dayPricePoints: number; personalPricePoints: number; levels: Level[];
};
const DEFAULTS: LoyaltySettings = {
  enabled: false, enabledAt: null, pointValueKop: 100, visitPoints: 10, purchasePercent: 3, renewalPoints: 300, referralPoints: 1000, reviewPoints: 100, expireDays: 365,
  spendGoods: true, dayPricePoints: 300, personalPricePoints: 2500,
  levels: [
    { code: 'base', name: 'Базовый', minMonths: 0, minSpendKop: 0, bonusPercent: 0 },
    { code: 'silver', name: 'Серебро', minMonths: 6, minSpendKop: 3000000, bonusPercent: 25 },
    { code: 'gold', name: 'Золото', minMonths: 12, minSpendKop: 6000000, bonusPercent: 50 },
  ],
};
export const KIND_TITLES: Record<string, string> = {
  visit: 'Посещение', purchase: 'Покупка', refund: 'Возврат покупки', renewal: 'Продление абонемента', referral: 'Рекомендация друга', review: 'Отзыв',
  spend_goods: 'Оплата товаров баллами', spend_days: 'Дни абонемента за баллы', spend_personal: 'Персональная тренировка за баллы', expire: 'Сгорели', correction: 'Корректировка',
};

export async function loyaltySettings(db: Db, clubId: string): Promise<LoyaltySettings> {
  const r = (await db.query('select * from club_loyalty where club_id = $1', [clubId])).rows[0];
  if (!r) return DEFAULTS;
  return {
    enabled: r.enabled, enabledAt: r.enabled_at ? new Date(r.enabled_at).toISOString() : null, pointValueKop: r.point_value_kop, visitPoints: r.visit_points,
    purchasePercent: Number(r.purchase_percent), renewalPoints: r.renewal_points, referralPoints: r.referral_points, reviewPoints: r.review_points, expireDays: r.expire_days,
    spendGoods: r.spend_goods, dayPricePoints: r.day_price_points, personalPricePoints: r.personal_price_points, levels: r.levels,
  };
}

export async function loyaltyBalance(db: Db, personId: string, clubId: string) {
  return Number((await db.query('select coalesce(sum(points), 0)::int as b from loyalty_moves where person_id = $1 and club_id = $2', [personId, clubId])).rows[0].b);
}

/** Уровень: достаточно стажа ИЛИ суммы покупок. Стаж — месяцев с первой покупки, сумма — оплаты минус возвраты за всё время. */
export async function personLevel(db: Db, personId: string, clubId: string, s: LoyaltySettings, today: string) {
  const r = (await db.query(`select (select min(starts_on) from memberships where person_id = $1 and club_id = $2 and kind <> 'guest') as since,
      (select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) from payments where person_id = $1 and club_id = $2 and expense_id is null
        and coalesce(sale_category, '') not in ('deposit', 'gift'))::bigint as spent`, [personId, clubId])).rows[0];
  const since = r.since ? new Date(r.since).toISOString().slice(0, 10) : null;
  const months = since ? Math.max(0, (Number(today.slice(0, 4)) - Number(since.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(since.slice(5, 7)) - (Number(today.slice(8, 10)) < Number(since.slice(8, 10)) ? 1 : 0)) : 0;
  const spentKop = Number(r.spent);
  const levels = [...s.levels].sort((a, b) => a.minMonths - b.minMonths || a.minSpendKop - b.minSpendKop);
  let level = levels[0];
  for (const l of levels) if (months >= l.minMonths || spentKop >= l.minSpendKop) level = l;
  const next = levels[levels.indexOf(level) + 1] ?? null;
  return { level, next, months, spentKop };
}

async function earn(db: Db, tenantId: string, clubId: string, personId: string, kind: string, points: number, refId: string | null, s: LoyaltySettings, today: string, levelCode: string | null, comment: string | null) {
  if (!points) return false;
  const r = await db.query(`insert into loyalty_moves(tenant_id, club_id, person_id, kind, points, ref_id, expires_on, level_code, comment)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning id`,
  [tenantId, clubId, personId, kind, points, refId, points > 0 ? addDays(today, s.expireDays) : null, levelCode, comment]);
  return !!r.rowCount;
}

/**
 * Фоновое начисление и сгорание по клубу. Берём только события после включения программы и не старше 30 дней — историю задним числом не начисляем.
 * Повторный запуск ничего не удваивает: одна строка на событие.
 */
export async function processLoyalty(db: Db, tenantId: string, clubId: string) {
  const s = await loyaltySettings(db, clubId);
  if (!s.enabled || !s.enabledAt) return { earned: 0, expired: 0 };
  const today = await clubToday(db, clubId);
  const since = `greatest($2::timestamptz, now() - interval '30 days')`;
  const levelCache = new Map<string, Awaited<ReturnType<typeof personLevel>>>();
  const lvl = async (pid: string) => { if (!levelCache.has(pid)) levelCache.set(pid, await personLevel(db, pid, clubId, s, today)); return levelCache.get(pid)!; };
  const boost = (n: number, l: Level) => Math.round(n * (1 + l.bonusPercent / 100));
  let earned = 0;
  const has = (kind: string) => `not exists (select 1 from loyalty_moves lm where lm.club_id = $1 and lm.kind = '${kind}' and lm.ref_id = x.id)`;

  if (s.visitPoints) for (const v of (await db.query(`select x.id, x.person_id from visits x where x.club_id = $1 and x.visited_at >= ${since} and ${has('visit')}`, [clubId, s.enabledAt])).rows) {
    const l = (await lvl(v.person_id)).level;
    if (await earn(db, tenantId, clubId, v.person_id, 'visit', boost(s.visitPoints, l), v.id, s, today, l.code, null)) earned++;
  }
  if (s.purchasePercent) {
    for (const p of (await db.query(`select x.id, x.person_id, x.amount_kop from payments x where x.club_id = $1 and x.direction = 'in' and x.person_id is not null and x.expense_id is null
        and coalesce(x.sale_category, '') not in ('deposit', 'gift') and x.created_at >= ${since} and ${has('purchase')}`, [clubId, s.enabledAt])).rows) {
      const l = (await lvl(p.person_id)).level;
      const pts = boost(Math.floor((Number(p.amount_kop) * s.purchasePercent) / 100 / s.pointValueKop), l);
      if (await earn(db, tenantId, clubId, p.person_id, 'purchase', pts, p.id, s, today, l.code, null)) earned++;
    }
    // Возврат денег — забираем баллы, начисленные за эту сумму (без уровня, по базовой ставке с запасом в пользу клиента)
    for (const p of (await db.query(`select x.id, x.person_id, x.amount_kop from payments x where x.club_id = $1 and x.direction = 'out' and x.kind = 'refund' and x.person_id is not null
        and x.created_at >= ${since} and ${has('refund')}`, [clubId, s.enabledAt])).rows) {
      const pts = Math.floor((Number(p.amount_kop) * s.purchasePercent) / 100 / s.pointValueKop);
      if (pts && await earn(db, tenantId, clubId, p.person_id, 'refund', -pts, p.id, s, today, null, null)) earned++;
    }
  }
  if (s.renewalPoints) for (const m of (await db.query(`select x.id, x.person_id from memberships x where x.club_id = $1 and x.renewed_from_id is not null and x.status <> 'cancelled'
      and x.created_at >= ${since} and ${has('renewal')}
      and exists (select 1 from charges c where c.membership_id = x.id and c.status = 'paid')`, [clubId, s.enabledAt])).rows) {
    if (await earn(db, tenantId, clubId, m.person_id, 'renewal', s.renewalPoints, m.id, s, today, null, null)) earned++;
  }
  if (s.referralPoints) for (const r of (await db.query(`select x.id, x.referrer_id from referrals x where x.club_id = $1 and x.status in ('bought', 'rewarded', 'reward_manual')
      and coalesce(x.bought_at, x.created_at) >= ${since} and ${has('referral')}`, [clubId, s.enabledAt])).rows) {
    if (await earn(db, tenantId, clubId, r.referrer_id, 'referral', s.referralPoints, r.id, s, today, null, null)) earned++;
  }
  if (s.reviewPoints) for (const r of (await db.query(`select x.id, x.person_id from surveys x where x.club_id = $1 and x.answered_at is not null and length(trim(coalesce(x.comment, ''))) >= 10
      and x.answered_at >= ${since} and ${has('review')}`, [clubId, s.enabledAt])).rows) {
    if (await earn(db, tenantId, clubId, r.person_id, 'review', s.reviewPoints, r.id, s, today, null, null)) earned++;
  }

  // Сгорание: всё, что сверх ещё не сгоревших начислений, — это старые баллы с истёкшим сроком
  let expired = 0;
  for (const r of (await db.query(`select person_id, sum(points)::int as b,
      coalesce(sum(points) filter (where points > 0 and (expires_on is null or expires_on > $2::date)), 0)::int as u
    from loyalty_moves where club_id = $1 group by person_id
    having sum(points) > coalesce(sum(points) filter (where points > 0 and (expires_on is null or expires_on > $2::date)), 0)`, [clubId, today])).rows) {
    const n = r.b - r.u;
    if (n > 0) {
      await db.query(`insert into loyalty_moves(tenant_id, club_id, person_id, kind, points, comment) values ($1,$2,$3,'expire',$4,$5)`,
        [tenantId, clubId, r.person_id, -n, `Срок баллов ${s.expireDays} дн. истёк`]);
      expired++;
    }
  }
  return { earned, expired };
}

/** Списать баллы (проверяет остаток). Возвращает id строки движения. */
export async function loyaltySpend(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, p: { clubId: string; personId: string; kind: 'spend_goods' | 'spend_days' | 'spend_personal'; points: number; refId: string | null; comment: string }) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`loyalty:${p.personId}:${p.clubId}`]);
  const b = await loyaltyBalance(db, p.personId, p.clubId);
  if (b < p.points) throw badRequest(`Не хватает баллов: есть ${b}, нужно ${p.points}`, 'points_low');
  return (await db.query(`insert into loyalty_moves(tenant_id, club_id, person_id, kind, points, ref_id, comment, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, p.clubId, p.personId, p.kind, -p.points, p.refId, p.comment, ctx.userId])).rows[0].id as string;
}

/** Оплата товаров баллами: сколько баллов нужно на сумму. */
export async function pointsForKop(db: Db, clubId: string, kop: number) {
  const s = await loyaltySettings(db, clubId);
  if (!s.enabled) throw badRequest('Бонусная программа в этом клубе выключена', 'loyalty_off');
  if (!s.spendGoods) throw badRequest('Баллами в этом клубе товары не оплачиваются', 'loyalty_goods_off');
  return Math.ceil(kop / s.pointValueKop);
}

function cleanLevels(x: unknown): Level[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > 6) throw badRequest('Уровней от 1 до 6');
  const out = x.map((l, i) => {
    const o = l as Partial<Level>;
    const name = String(o.name ?? '').trim();
    if (!name) throw badRequest('У каждого уровня должно быть название');
    const lv = { code: String(o.code ?? '').trim() || `l${i}`, name: name.slice(0, 40), minMonths: Math.max(0, Math.floor(Number(o.minMonths) || 0)),
      minSpendKop: Math.max(0, Math.round(Number(o.minSpendKop) || 0)), bonusPercent: Math.round(Number(o.bonusPercent) || 0) };
    if (lv.bonusPercent < 0 || lv.bonusPercent > 200) throw badRequest('Надбавка уровня от 0 до 200 %');
    return lv;
  });
  out.sort((a, b) => a.minMonths - b.minMonths || a.minSpendKop - b.minSpendKop);
  if (out[0].minMonths !== 0 || out[0].minSpendKop !== 0) throw badRequest('Первый уровень должен быть без условий: с него начинают все');
  return out;
}

export function loyaltyRoutes(app: FastifyInstance, pool: pg.Pool) {
  const clubCheck = async (db: Db, clubId?: string) => {
    if (!clubId || !UUID.test(clubId) || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
    return clubId;
  };

  app.get('/api/loyalty/settings', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const q = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, q.clubId);
      const s = await loyaltySettings(db, clubId);
      const stats = (await db.query(`select coalesce(sum(points) filter (where points > 0 and created_at > now() - interval '30 days'), 0)::int as issued,
          coalesce(-sum(points) filter (where kind like 'spend%' and created_at > now() - interval '30 days'), 0)::int as spent,
          coalesce(-sum(points) filter (where kind = 'expire' and created_at > now() - interval '30 days'), 0)::int as expired,
          coalesce(sum(points), 0)::int as outstanding, count(distinct person_id)::int as members
        from loyalty_moves where club_id = $1`, [clubId])).rows[0];
      return { ...s, canEdit: can(ctx, P.tariffsManage), stats: { ...stats, outstandingKop: stats.outstanding * s.pointValueKop } };
    });
  });

  // Правила задаёт собственник по каждому клубу или управляющий по своему
  app.put('/api/loyalty/settings', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const b = (req.body ?? {}) as Partial<LoyaltySettings> & { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      const before = await loyaltySettings(db, clubId);
      const n = (v: unknown, d: number, min: number, max: number, label: string) => {
        if (v === undefined) return d;
        const x = Number(v);
        if (!Number.isFinite(x) || x < min || x > max) throw badRequest(`${label}: от ${min} до ${max}`);
        return x;
      };
      const s: LoyaltySettings = {
        enabled: b.enabled ?? before.enabled, enabledAt: before.enabledAt,
        pointValueKop: Math.round(n(b.pointValueKop, before.pointValueKop, 1, 10000, 'Цена балла, коп.')),
        visitPoints: Math.round(n(b.visitPoints, before.visitPoints, 0, 10000, 'Баллов за посещение')),
        purchasePercent: Math.round(n(b.purchasePercent, before.purchasePercent, 0, 50, 'Процент от покупки') * 100) / 100,
        renewalPoints: Math.round(n(b.renewalPoints, before.renewalPoints, 0, 100000, 'Баллов за продление')),
        referralPoints: Math.round(n(b.referralPoints, before.referralPoints, 0, 100000, 'Баллов за рекомендацию')),
        reviewPoints: Math.round(n(b.reviewPoints, before.reviewPoints, 0, 100000, 'Баллов за отзыв')),
        expireDays: Math.round(n(b.expireDays, before.expireDays, 30, 1825, 'Срок жизни баллов, дней')),
        spendGoods: b.spendGoods ?? before.spendGoods,
        dayPricePoints: Math.round(n(b.dayPricePoints, before.dayPricePoints, 1, 100000, 'Цена дня абонемента в баллах')),
        personalPricePoints: Math.round(n(b.personalPricePoints, before.personalPricePoints, 1, 1000000, 'Цена персональной тренировки в баллах')),
        levels: b.levels !== undefined ? cleanLevels(b.levels) : before.levels,
      };
      await db.query(`insert into club_loyalty(club_id, tenant_id, enabled, enabled_at, point_value_kop, visit_points, purchase_percent, renewal_points, referral_points, review_points,
          expire_days, spend_goods, day_price_points, personal_price_points, levels, updated_by, updated_at)
        values ($1,$2,$3, case when $3 then now() end, $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
        on conflict (club_id) do update set enabled = excluded.enabled,
          enabled_at = case when excluded.enabled and not club_loyalty.enabled then now() when excluded.enabled then club_loyalty.enabled_at else null end,
          point_value_kop = excluded.point_value_kop, visit_points = excluded.visit_points, purchase_percent = excluded.purchase_percent, renewal_points = excluded.renewal_points,
          referral_points = excluded.referral_points, review_points = excluded.review_points, expire_days = excluded.expire_days, spend_goods = excluded.spend_goods,
          day_price_points = excluded.day_price_points, personal_price_points = excluded.personal_price_points, levels = excluded.levels, updated_by = excluded.updated_by, updated_at = now()`,
      [clubId, ctx.tenantId, s.enabled, s.pointValueKop, s.visitPoints, s.purchasePercent, s.renewalPoints, s.referralPoints, s.reviewPoints, s.expireDays, s.spendGoods,
        s.dayPricePoints, s.personalPricePoints, JSON.stringify(s.levels), ctx.userId]);
      await audit(db, ctx, 'loyalty.settings', 'club', clubId, before, s);
      return loyaltySettings(db, clubId);
    });
  });

  app.get('/api/persons/:id/loyalty', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const q = req.query as { clubId?: string };
    if (!UUID.test(id)) throw notFound('Клиент не найден');
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, q.clubId);
      const s = await loyaltySettings(db, clubId);
      if (!s.enabled) return { enabled: false };
      const today = await clubToday(db, clubId);
      const balance = await loyaltyBalance(db, id, clubId);
      const lv = await personLevel(db, id, clubId, s, today);
      const moves = (await db.query(`select m.id, m.kind, m.points, m.comment, m.created_at as "at", to_char(m.expires_on, 'YYYY-MM-DD') as "expiresOn", u.full_name as "by"
        from loyalty_moves m left join users u on u.id = m.created_by where m.person_id = $1 and m.club_id = $2 order by m.created_at desc limit 30`, [id, clubId])).rows;
      // Ближайшее сгорание: старейшие начисления, которые ещё не потрачены (оценка FIFO)
      const soon = (await db.query(`select coalesce(sum(points), 0)::int as n from loyalty_moves where person_id = $1 and club_id = $2 and points > 0 and expires_on > $3::date and expires_on <= $3::date + 30`,
        [id, clubId, today])).rows[0].n;
      const memberships = (await db.query(`select id, product_name as name, kind, to_char(ends_on, 'YYYY-MM-DD') as "endsOn", visits_left as "visitsLeft" from memberships
        where person_id = $1 and club_id = $2 and status <> 'cancelled' and (ends_on is null or ends_on >= $3::date) and kind in ('term', 'visits', 'personal') order by kind, ends_on`, [id, clubId, today])).rows;
      return {
        enabled: true, balance, valueKop: balance * s.pointValueKop, level: lv.level, next: lv.next, months: lv.months, spentKop: lv.spentKop,
        expiringSoon: Math.min(balance, soon), pointValueKop: s.pointValueKop, dayPricePoints: s.dayPricePoints, personalPricePoints: s.personalPricePoints, spendGoods: s.spendGoods,
        moves: moves.map((m) => ({ ...m, title: KIND_TITLES[m.kind] ?? m.kind })), memberships,
        canSpend: can(ctx, P.membershipsSell) || can(ctx, P.shiftsWork), canAdjust: can(ctx, P.tariffsManage),
      };
    });
  });

  // Потратить баллы на дни абонемента или персональную тренировку
  app.post('/api/persons/:id/loyalty/spend', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    if (!can(ctx, P.membershipsSell) && !can(ctx, P.shiftsWork)) throw forbidden();
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { clubId?: string; kind?: string; membershipId?: string; qty?: number };
    const qty = Math.floor(Number(b.qty) || 0);
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      const s = await loyaltySettings(db, clubId);
      if (!s.enabled) throw badRequest('Бонусная программа в этом клубе выключена', 'loyalty_off');
      const m = b.membershipId && UUID.test(b.membershipId) ? (await db.query('select * from memberships where id = $1 and person_id = $2 and club_id = $3 for update', [b.membershipId, id, clubId])).rows[0] : null;
      if (!m || m.status === 'cancelled') throw badRequest('Выберите действующий абонемент клиента');
      if (b.kind === 'days') {
        if (!(qty >= 1 && qty <= 60)) throw badRequest('Дней от 1 до 60');
        if (!['term', 'visits'].includes(m.kind) || !m.ends_on) throw badRequest('Дни можно добавить к абонементу на срок или пакету посещений');
        const pts = qty * s.dayPricePoints;
        const moveId = await loyaltySpend(db, ctx, { clubId, personId: id, kind: 'spend_days', points: pts, refId: m.id, comment: `+${qty} дн. к «${m.product_name}»` });
        const ends = (await db.query(`update memberships set ends_on = ends_on + $2::int, updated_at = now() where id = $1 returning to_char(ends_on, 'YYYY-MM-DD') as e`, [m.id, qty])).rows[0].e;
        await audit(db, ctx, 'loyalty.spend_days', 'membership', m.id, { endsOn: m.ends_on }, { endsOn: ends, points: pts, moveId });
        return { points: pts, endsOn: ends, balance: await loyaltyBalance(db, id, clubId) };
      }
      if (b.kind === 'personal') {
        if (!(qty >= 1 && qty <= 10)) throw badRequest('Тренировок от 1 до 10');
        if (m.kind !== 'personal') throw badRequest('Выберите пакет персональных тренировок');
        const pts = qty * s.personalPricePoints;
        const moveId = await loyaltySpend(db, ctx, { clubId, personId: id, kind: 'spend_personal', points: pts, refId: m.id, comment: `+${qty} перс. к «${m.product_name}»` });
        const left = (await db.query('update memberships set visits_left = coalesce(visits_left, 0) + $2, updated_at = now() where id = $1 returning visits_left', [m.id, qty])).rows[0].visits_left;
        await audit(db, ctx, 'loyalty.spend_personal', 'membership', m.id, { visitsLeft: m.visits_left }, { visitsLeft: left, points: pts, moveId });
        return { points: pts, visitsLeft: left, balance: await loyaltyBalance(db, id, clubId) };
      }
      throw badRequest('Выберите, на что тратить баллы');
    });
  });

  // Ручная корректировка — только с причиной, попадает в журнал действий
  app.post('/api/persons/:id/loyalty/adjust', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { clubId?: string; points?: number; comment?: string };
    const pts = Math.round(Number(b.points) || 0);
    if (!pts || Math.abs(pts) > 100000) throw badRequest('Укажите баллы: от −100 000 до 100 000, не ноль');
    if (!b.comment?.trim()) throw badRequest('Укажите причину');
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      const s = await loyaltySettings(db, clubId);
      if (pts < 0 && (await loyaltyBalance(db, id, clubId)) + pts < 0) throw badRequest('Нельзя списать больше, чем есть на счёте', 'points_low');
      const today = await clubToday(db, clubId);
      const r = (await db.query(`insert into loyalty_moves(tenant_id, club_id, person_id, kind, points, expires_on, comment, created_by) values ($1,$2,$3,'correction',$4,$5,$6,$7) returning id`,
        [ctx.tenantId, clubId, id, pts, pts > 0 ? addDays(today, s.expireDays) : null, b.comment!.trim(), ctx.userId])).rows[0];
      await audit(db, ctx, 'loyalty.adjust', 'person', id, null, { points: pts, comment: b.comment!.trim() });
      return { id: r.id, balance: await loyaltyBalance(db, id, clubId) };
    });
  });
}
