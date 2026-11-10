// Шаг 6. Настройки клуба по абонементам, тарифы с версиями цен, продажа, заморозка, продление, график платежей, право прохода.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { contractsByMembership, createContract } from './contracts.ts';
import { receiptForCharge } from './fiscal.ts';

/* ---------- даты (строки YYYY-MM-DD, без часовых сдвигов) ---------- */
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const addMonths = (s: string, n: number) => {
  const d = D(s); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
};
const ru = (s: string | null) => (s ? s.split('-').reverse().join('.') : '');
export const daysBetween = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / 86_400_000);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(D(s).getTime());
export async function clubToday(db: Db, clubId: string): Promise<string> {
  return (await db.query(`select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from clubs where id = $1`, [clubId])).rows[0].d;
}

export type Settings = {
  freezeEnabled: boolean; freezeMaxDaysPerYear: number; freezeMaxTimesPerYear: number; freezeMinDays: number; freezePaid: boolean; freezePriceKop: number;
  installmentsEnabled: boolean; installmentsMaxPayments: number; overdueBlockAfterDays: number;
  subscriptionRetryAttempts: number; subscriptionRetryIntervalDays: number; renewalReminderDays: number; contractRequiredForAccess: boolean;
};
const SETTINGS_COLS: [keyof Settings, string, 'bool' | 'int'][] = [
  ['freezeEnabled', 'freeze_enabled', 'bool'], ['freezeMaxDaysPerYear', 'freeze_max_days_per_year', 'int'], ['freezeMaxTimesPerYear', 'freeze_max_times_per_year', 'int'],
  ['freezeMinDays', 'freeze_min_days', 'int'], ['freezePaid', 'freeze_paid', 'bool'], ['freezePriceKop', 'freeze_price_kop', 'int'],
  ['installmentsEnabled', 'installments_enabled', 'bool'], ['installmentsMaxPayments', 'installments_max_payments', 'int'],
  ['overdueBlockAfterDays', 'overdue_block_after_days', 'int'], ['subscriptionRetryAttempts', 'subscription_retry_attempts', 'int'],
  ['subscriptionRetryIntervalDays', 'subscription_retry_interval_days', 'int'], ['renewalReminderDays', 'renewal_reminder_days', 'int'],
  ['contractRequiredForAccess', 'contract_required_for_access', 'bool'],
];

export async function getSettings(db: Db, clubId: string): Promise<Settings> {
  const r = (await db.query(`select ${SETTINGS_COLS.map(([k, c]) => `${c} as "${k}"`).join(', ')} from club_membership_settings where club_id = $1`, [clubId])).rows[0];
  if (!r) throw notFound('Настройки клуба не найдены');
  r.freezePriceKop = Number(r.freezePriceKop);
  return r;
}

/* ---------- состояние абонемента и право прохода ---------- */
type MRow = { id: string; kind: string; status: string; starts_on: string; ends_on: string | null; visits_left: number | null; product_name: string };
type Freeze = { starts_on: string; ends_on: string; ended_early_on: string | null };
type Charge = { due_on: string; status: string; amount_kop: string | number };

export function membershipState(m: MRow, freezes: Freeze[], charges: Charge[], s: Settings, today: string, contractStatus?: string) {
  if (m.status === 'cancelled') return { state: 'cancelled', access: false, reason: 'Абонемент расторгнут' };
  if (m.starts_on > today) return { state: 'not_started', access: false, reason: `Начнёт действовать с ${ru(m.starts_on)}` };
  const fr = freezes.find((f) => f.starts_on <= today && (f.ended_early_on ? f.ended_early_on > today : f.ends_on >= today));
  if (fr) return { state: 'frozen', access: false, reason: `Заморожен до ${ru(fr.ended_early_on ?? fr.ends_on)}` };
  if (m.ends_on && m.ends_on < today) return { state: 'expired', access: false, reason: `Закончился ${ru(m.ends_on)}` };
  if (m.visits_left !== null && m.visits_left <= 0) return { state: 'used_up', access: false, reason: 'Посещения закончились' };
  const overdue = charges.filter((c) => c.status === 'due' && c.due_on < today);
  const worst = overdue.reduce((mx, c) => Math.max(mx, daysBetween(c.due_on, today)), 0);
  const debt = overdue.reduce((sum, c) => sum + Number(c.amount_kop), 0);
  if (overdue.length && worst > s.overdueBlockAfterDays) return { state: 'debt_blocked', access: false, reason: `Долг ${(debt / 100).toLocaleString('ru-RU')} ₽, просрочка ${worst} дн.`, debtKop: debt };
  if (overdue.length) return { state: 'debt_grace', access: true, reason: `Долг ${(debt / 100).toLocaleString('ru-RU')} ₽: проход закроется через ${s.overdueBlockAfterDays - worst + 1} дн.`, debtKop: debt };
  if (s.contractRequiredForAccess && contractStatus !== 'signed') return { state: 'unsigned', access: false, reason: 'Договор не подписан' };
  return { state: 'active', access: true, reason: m.ends_on ? `Действует до ${ru(m.ends_on)}` : 'Действует' };
}

async function loadMembership(db: Db, id: string) {
  const m = (await db.query(`select *, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
    to_char(next_charge_on, 'YYYY-MM-DD') as next_charge_on from memberships where id = $1`, [id])).rows[0];
  if (!m) throw notFound('Абонемент не найден');
  return m;
}
const freezesOf = async (db: Db, ids: string[]) => (await db.query(
  `select id, membership_id, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
     to_char(ended_early_on, 'YYYY-MM-DD') as ended_early_on, days, created_at from freezes where membership_id = any($1) order by starts_on`, [ids])).rows;
const chargesOf = async (db: Db, ids: string[]) => (await db.query(
  `select id, membership_id, kind, title, to_char(due_on, 'YYYY-MM-DD') as due_on, amount_kop, status, paid_at, paid_method
   from charges where membership_id = any($1) order by due_on, created_at`, [ids])).rows;

export async function personMemberships(db: Db, personId: string) {
  const ms = (await db.query(`select m.*, to_char(m.starts_on, 'YYYY-MM-DD') as starts_on, to_char(m.ends_on, 'YYYY-MM-DD') as ends_on,
      to_char(m.next_charge_on, 'YYYY-MM-DD') as next_charge_on, c.name as club_name, p.freeze_allowed
    from memberships m join clubs c on c.id = m.club_id join products p on p.id = m.product_id
    where m.person_id = $1 order by m.starts_on desc`, [personId])).rows;
  if (!ms.length) return [];
  const ids = ms.map((m) => m.id);
  const [fr, ch, ct] = [await freezesOf(db, ids), await chargesOf(db, ids), await contractsByMembership(db, ids)];
  const out = [];
  for (const m of ms) {
    const s = await getSettings(db, m.club_id);
    const today = await clubToday(db, m.club_id);
    const f = fr.filter((x) => x.membership_id === m.id);
    const c = ch.filter((x) => x.membership_id === m.id);
    out.push({
      id: m.id, clubId: m.club_id, clubName: m.club_name, kind: m.kind, productName: m.product_name, amountKop: Number(m.amount_kop),
      startsOn: m.starts_on, endsOn: m.ends_on, visitsLeft: m.visits_left, installments: m.installments, nextChargeOn: m.next_charge_on,
      status: m.status, freezeAllowed: m.freeze_allowed && s.freezeEnabled, ...membershipState(m, f, c, s, today, ct.get(m.id)?.status),
      contract: ct.get(m.id) ?? null,
      freezes: f.map((x) => ({ id: x.id, startsOn: x.starts_on, endsOn: x.ends_on, endedEarlyOn: x.ended_early_on, days: x.days })),
      charges: c.map((x) => ({ id: x.id, kind: x.kind, title: x.title, dueOn: x.due_on, amountKop: Number(x.amount_kop), status: x.status,
        paidAt: x.paid_at, paidMethod: x.paid_method, overdue: x.status === 'due' && x.due_on < today })),
    });
  }
  return out;
}

/* ---------- продажа и продление ---------- */
type SaleInput = { personId?: string; productId?: string; startsOn?: string; installments?: number; renewFromId?: string };

async function currentPrice(db: Db, productId: string) {
  return (await db.query('select id, amount_kop from price_versions where product_id = $1 and valid_from <= now() order by valid_from desc limit 1', [productId])).rows[0];
}

export async function sellMembership(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId' | 'ip'>, b: SaleInput) {
  const prod = (await db.query('select * from products where id = $1', [b.productId])).rows[0];
  if (!prod) throw badRequest('Тариф не найден');
  if (!prod.is_active) throw badRequest('Тариф снят с продажи');
  if (!(await db.query('select 1 from persons where id = $1', [b.personId])).rowCount) throw badRequest('Клиент не найден');
  const price = await currentPrice(db, prod.id);
  if (!price) throw badRequest('У тарифа нет цены');
  const s = await getSettings(db, prod.club_id);
  const today = await clubToday(db, prod.club_id);
  let startsOn = b.startsOn ?? today;
  if (!isDate(startsOn)) throw badRequest('Дата начала указана неверно');
  if (startsOn < today) throw badRequest('Дата начала не может быть в прошлом');

  let renewedFrom: string | null = null;
  if (b.renewFromId) {
    const prev = await loadMembership(db, b.renewFromId);
    if (prev.person_id !== b.personId) throw badRequest('Абонемент другого клиента');
    if (prev.club_id !== prod.club_id) throw badRequest('Продление оформляется в том же клубе');
    // Продление считается от даты окончания текущего абонемента: клиент не теряет дни
    if (prev.ends_on && prev.ends_on >= today) startsOn = addDays(prev.ends_on, 1);
    renewedFrom = prev.id;
  }

  const n = Math.max(1, Math.floor(b.installments ?? 1));
  if (n > 1) {
    if (prod.kind === 'subscription') throw badRequest('Подписка оплачивается помесячно, рассрочка к ней не применяется');
    if (!s.installmentsEnabled || !prod.installments_allowed) throw badRequest('Для этого тарифа рассрочка не предусмотрена');
    if (n > s.installmentsMaxPayments) throw badRequest(`Рассрочка не больше ${s.installmentsMaxPayments} платежей`);
  }
  const amount = Number(price.amount_kop);
  let endsOn: string | null = null;
  let visits: number | null = null;
  let nextCharge: string | null = null;
  if (prod.kind === 'term') endsOn = addDays(startsOn, prod.duration_days - 1);
  if (prod.kind === 'visits' || prod.kind === 'personal' || prod.kind === 'guest') {
    visits = prod.kind === 'guest' ? 1 : prod.visits_count;
    endsOn = addDays(startsOn, (prod.validity_days ?? (prod.kind === 'guest' ? 1 : 90)) - 1);
  }
  if (prod.kind === 'subscription') { endsOn = addDays(addMonths(startsOn, 1), -1); nextCharge = addMonths(startsOn, 1); }

  const id = (await db.query(
    `insert into memberships(tenant_id, club_id, person_id, product_id, price_version_id, kind, product_name, amount_kop, starts_on, ends_on, visits_left,
       installments, next_charge_on, renewed_from_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [ctx.tenantId, prod.club_id, b.personId, prod.id, price.id, prod.kind, prod.name, amount, startsOn, endsOn, visits, n, nextCharge, renewedFrom, ctx.userId])).rows[0].id;

  // График платежей: первый платёж в день продажи, остальные помесячно
  const part = Math.floor(amount / n);
  for (let i = 0; i < n; i++) {
    const sum = i === n - 1 ? amount - part * (n - 1) : part;
    const kind = prod.kind === 'subscription' ? 'subscription' : n > 1 ? 'installment' : 'full';
    const title = prod.kind === 'subscription' ? `${prod.name}: первый месяц` : n > 1 ? `${prod.name}: платёж ${i + 1} из ${n}` : prod.name;
    await db.query('insert into charges(tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [ctx.tenantId, prod.club_id, id, b.personId, kind, title, i === 0 ? today : addMonths(today, i), sum]);
  }
  await db.query('insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,$4,$5,$6)',
    [ctx.tenantId, prod.club_id, id, renewedFrom ? 'renewal' : 'sale', JSON.stringify({ productId: prod.id, priceVersionId: price.id, amountKop: amount, installments: n, startsOn, renewedFrom }), ctx.userId]);
  const contract = await createContract(db, ctx, id);
  await db.query(`update persons set segment = case when $2 = 'subscription' then 'активный подписчик' else 'действующий' end, updated_at = now() where id = $1`, [b.personId, prod.kind]);
  await audit(db, ctx, renewedFrom ? 'membership.renewed' : 'membership.sold', 'membership', id, null, { productId: prod.id, amountKop: amount, installments: n, startsOn, endsOn });
  return { id, startsOn, endsOn, contractId: contract.id, contractNumber: contract.number };
}

/* ---------- заморозка ---------- */
export async function freezeMembership(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId' | 'ip'>, id: string, b: { startsOn?: string; days?: number }) {
  const m = await loadMembership(db, id);
  const prod = (await db.query('select freeze_allowed, kind from products where id = $1', [m.product_id])).rows[0];
  const s = await getSettings(db, m.club_id);
  const today = await clubToday(db, m.club_id);
  if (m.status !== 'active') throw badRequest('Абонемент не действует');
  if (m.kind === 'subscription') throw badRequest('Подписку не замораживают: её можно приостановить отменой следующего списания (появится в шаге оплат)');
  if (!s.freezeEnabled) throw badRequest('В клубе заморозка отключена');
  if (!prod.freeze_allowed) throw badRequest('Для этого тарифа заморозка не предусмотрена');
  const startsOn = b.startsOn ?? today;
  const days = Math.floor(b.days ?? 0);
  if (!isDate(startsOn) || startsOn < today) throw badRequest('Дата начала заморозки: сегодня или позже');
  if (m.ends_on && startsOn > m.ends_on) throw badRequest('Заморозка должна начаться до окончания абонемента');
  if (days < s.freezeMinDays) throw badRequest(`Минимальный срок заморозки ${s.freezeMinDays} дн.`);
  const all = await freezesOf(db, [id]);
  if (all.some((f) => (f.ended_early_on ?? addDays(f.ends_on, 1)) > startsOn && f.starts_on <= addDays(startsOn, days - 1))) throw badRequest('Заморозки пересекаются');
  // Лимит считается за год действия абонемента
  const yearStart = (() => { let y = m.starts_on; while (addMonths(y, 12) <= startsOn) y = addMonths(y, 12); return y; })();
  const inYear = all.filter((f) => f.starts_on >= yearStart && f.starts_on < addMonths(yearStart, 12));
  const used = inYear.reduce((sum, f) => sum + (f.ended_early_on ? daysBetween(f.starts_on, f.ended_early_on) : f.days), 0);
  if (inYear.length + 1 > s.freezeMaxTimesPerYear) throw badRequest(`Заморозить можно не больше ${s.freezeMaxTimesPerYear} раз за год абонемента`);
  if (used + days > s.freezeMaxDaysPerYear) throw badRequest(`Осталось дней заморозки в этом году: ${Math.max(0, s.freezeMaxDaysPerYear - used)}`);
  const endsOn = addDays(startsOn, days - 1);
  await db.query('insert into freezes(tenant_id, club_id, membership_id, starts_on, ends_on, days, created_by) values ($1,$2,$3,$4,$5,$6,$7)',
    [ctx.tenantId, m.club_id, id, startsOn, endsOn, days, ctx.userId]);
  await db.query('update memberships set ends_on = ends_on + $2::int, updated_at = now() where id = $1', [id, days]);
  if (s.freezePaid && s.freezePriceKop > 0) {
    await db.query(`insert into charges(tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop) values ($1,$2,$3,$4,'freeze_fee',$5,$6,$7)`,
      [ctx.tenantId, m.club_id, id, m.person_id, `Заморозка ${days} дн.`, today, s.freezePriceKop]);
  }
  await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'freeze',$4,$5)`,
    [ctx.tenantId, m.club_id, id, JSON.stringify({ startsOn, days }), ctx.userId]);
  await audit(db, ctx, 'membership.frozen', 'membership', id, { endsOn: m.ends_on }, { startsOn, days, endsOn: addDays(m.ends_on, days) });
  return { startsOn, endsOn, membershipEndsOn: addDays(m.ends_on, days) };
}

export async function unfreezeMembership(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId' | 'ip'>, id: string) {
  const m = await loadMembership(db, id);
  const today = await clubToday(db, m.club_id);
  const f = (await freezesOf(db, [id])).find((x) => !x.ended_early_on && x.ends_on >= today);
  if (!f) throw badRequest('Действующей или будущей заморозки нет');
  // Неиспользованные дни снимаются с конца абонемента
  const endOn = f.starts_on > today ? f.starts_on : today;
  const unused = daysBetween(endOn, addDays(f.ends_on, 1));
  if (f.starts_on > today) await db.query('update freezes set ended_early_on = starts_on where id = $1', [f.id]);
  else await db.query('update freezes set ended_early_on = $2 where id = $1', [f.id, today]);
  await db.query('update memberships set ends_on = ends_on - $2::int, updated_at = now() where id = $1', [id, unused]);
  await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'unfreeze',$4,$5)`,
    [ctx.tenantId, m.club_id, id, JSON.stringify({ returnedDays: unused }), ctx.userId]);
  await audit(db, ctx, 'membership.unfrozen', 'membership', id, { endsOn: m.ends_on }, { returnedDays: unused });
  return { returnedDays: unused };
}

/* ---------- маршруты ---------- */
const PRODUCT_SELECT = `select p.id, p.club_id as "clubId", p.kind, p.name, p.duration_days as "durationDays", p.visits_count as "visitsCount",
  p.validity_days as "validityDays", p.freeze_allowed as "freezeAllowed", p.installments_allowed as "installmentsAllowed", p.is_active as "isActive", p.sort,
  (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by v.valid_from desc limit 1)::bigint as "priceKop",
  coalesce((select json_agg(json_build_object('amountKop', v.amount_kop, 'validFrom', v.valid_from) order by v.valid_from desc)
     from price_versions v where v.product_id = p.id), '[]') as prices
  from products p`;

const KINDS = ['term', 'subscription', 'visits', 'personal', 'guest'];
type ProductIn = { clubId?: string; kind?: string; name?: string; durationDays?: number; visitsCount?: number; validityDays?: number;
  freezeAllowed?: boolean; installmentsAllowed?: boolean; isActive?: boolean; priceKop?: number };

function checkProduct(b: ProductIn, kind: string) {
  if (kind === 'term' && !(Number.isInteger(b.durationDays) && b.durationDays! > 0)) throw badRequest('Укажите срок абонемента в днях');
  if ((kind === 'visits' || kind === 'personal') && !(Number.isInteger(b.visitsCount) && b.visitsCount! > 0)) throw badRequest('Укажите количество посещений');
}

export function membershipRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/clubs/:id/membership-settings', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => getSettings(db, id));
  });

  app.put('/api/clubs/:id/membership-settings', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Partial<Settings>;
    return withCtx(pool, ctx, async (db) => {
      const before = await getSettings(db, id);
      const sets: string[] = []; const vals: unknown[] = [id];
      for (const [k, col, t] of SETTINGS_COLS) {
        if (b[k] === undefined) continue;
        if (t === 'bool' && typeof b[k] !== 'boolean') throw badRequest(`Неверное значение: ${k}`);
        if (t === 'int' && !Number.isInteger(b[k])) throw badRequest(`Неверное значение: ${k}`);
        vals.push(b[k]); sets.push(`${col} = $${vals.length}`);
      }
      if (!sets.length) return before;
      vals.push(ctx.userId);
      try {
        await db.query(`update club_membership_settings set ${sets.join(', ')}, updated_by = $${vals.length}, updated_at = now() where club_id = $1`, vals);
      } catch (e) {
        if ((e as { code?: string }).code === '23514') throw badRequest('Значение вне допустимого диапазона');
        throw e;
      }
      const after = await getSettings(db, id);
      await audit(db, ctx, 'club.membership_settings_changed', 'club', id, before, after);
      return after;
    });
  });

  app.get('/api/products', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { clubId, active } = req.query as { clubId?: string; active?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `${PRODUCT_SELECT} where ($1::uuid is null or p.club_id = $1) and ($2::boolean is null or p.is_active = $2) order by p.club_id, p.sort, p.name`,
      [clubId || null, active === '1' ? true : null])).rows.map((r) => ({ ...r, priceKop: r.priceKop === null ? null : Number(r.priceKop) })));
  });

  app.post('/api/products', async (req, reply) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const b = (req.body ?? {}) as ProductIn;
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!KINDS.includes(b.kind ?? '')) throw badRequest('Выберите тип тарифа');
    if (!b.name?.trim()) throw badRequest('Укажите название тарифа');
    if (!Number.isInteger(b.priceKop) || b.priceKop! < 0) throw badRequest('Укажите цену');
    checkProduct(b, b.kind!);
    const res = await withCtx(pool, ctx, async (db) => {
      const club = (await db.query('select sales_model from clubs where id = $1', [b.clubId])).rows[0];
      if (!club) throw badRequest('Клуб не найден');
      if ((b.kind === 'term' && club.sales_model === 'subscription') || (b.kind === 'subscription' && club.sales_model === 'term')) {
        throw badRequest(`Клуб работает по модели «${club.sales_model === 'term' ? 'абонементы на срок' : 'подписка'}». Смените модель клуба или выберите другой тип тарифа`);
      }
      if ((await db.query('select 1 from products where club_id = $1 and lower(name) = lower($2)', [b.clubId, b.name!.trim()])).rowCount) throw badRequest('Тариф с таким названием уже есть');
      const id = (await db.query(
        `insert into products(tenant_id, club_id, kind, name, duration_days, visits_count, validity_days, freeze_allowed, installments_allowed)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, b.clubId, b.kind, b.name!.trim(), b.kind === 'term' ? b.durationDays : null, ['visits', 'personal'].includes(b.kind!) ? b.visitsCount : null,
          b.validityDays ?? null, b.freezeAllowed ?? b.kind === 'term', b.installmentsAllowed ?? false])).rows[0].id;
      await db.query('insert into price_versions(tenant_id, club_id, product_id, amount_kop, created_by) values ($1,$2,$3,$4,$5)', [ctx.tenantId, b.clubId, id, b.priceKop, ctx.userId]);
      const row = (await db.query(`${PRODUCT_SELECT} where p.id = $1`, [id])).rows[0];
      await audit(db, ctx, 'product.created', 'product', id, null, row);
      return row;
    });
    reply.code(201);
    return res;
  });

  app.patch('/api/products/:id', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as ProductIn;
    return withCtx(pool, ctx, async (db) => {
      const before = (await db.query(`${PRODUCT_SELECT} where p.id = $1`, [id])).rows[0];
      if (!before) throw notFound('Тариф не найден');
      if (b.name !== undefined && !b.name.trim()) throw badRequest('Название не может быть пустым');
      checkProduct({ durationDays: before.durationDays, visitsCount: before.visitsCount, ...b }, before.kind);
      await db.query(
        `update products set name = coalesce($2, name), duration_days = coalesce($3, duration_days), visits_count = coalesce($4, visits_count),
           validity_days = coalesce($5, validity_days), freeze_allowed = coalesce($6, freeze_allowed), installments_allowed = coalesce($7, installments_allowed),
           is_active = coalesce($8, is_active) where id = $1`,
        [id, b.name?.trim() ?? null, b.durationDays ?? null, b.visitsCount ?? null, b.validityDays ?? null, b.freezeAllowed ?? null, b.installmentsAllowed ?? null, b.isActive ?? null]);
      if (b.priceKop !== undefined) {
        if (!Number.isInteger(b.priceKop) || b.priceKop < 0) throw badRequest('Неверная цена');
        if (Number(before.priceKop) !== b.priceKop) {
          await db.query('insert into price_versions(tenant_id, club_id, product_id, amount_kop, created_by) values ($1,$2,$3,$4,$5)', [ctx.tenantId, before.clubId, id, b.priceKop, ctx.userId]);
        }
      }
      const after = (await db.query(`${PRODUCT_SELECT} where p.id = $1`, [id])).rows[0];
      await audit(db, ctx, 'product.updated', 'product', id, before, after);
      return after;
    });
  });

  app.get('/api/persons/:id/memberships', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => personMemberships(db, id));
  });

  app.post('/api/memberships', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const res = await withCtx(pool, ctx, (db) => sellMembership(db, ctx, (req.body ?? {}) as SaleInput));
    reply.code(201);
    return res;
  });

  app.post('/api/memberships/:id/renew', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as SaleInput;
    const res = await withCtx(pool, ctx, async (db) => {
      const m = await loadMembership(db, id);
      return sellMembership(db, ctx, { personId: m.person_id, productId: b.productId ?? m.product_id, installments: b.installments, renewFromId: id });
    });
    reply.code(201);
    return res;
  });

  app.post('/api/memberships/:id/freeze', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => freezeMembership(db, ctx, id, (req.body ?? {}) as { startsOn?: string; days?: number }));
  });

  app.post('/api/memberships/:id/unfreeze', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => unfreezeMembership(db, ctx, id));
  });

  app.post('/api/memberships/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason?.trim()) throw badRequest('Укажите причину расторжения');
    return withCtx(pool, ctx, async (db) => {
      const m = await loadMembership(db, id);
      if (m.status === 'cancelled') throw badRequest('Абонемент уже расторгнут');
      await db.query(`update memberships set status = 'cancelled', cancel_reason = $2, next_charge_on = null, updated_at = now() where id = $1`, [id, reason.trim()]);
      await db.query(`update charges set status = 'cancelled' where membership_id = $1 and status = 'due' and due_on > (select (now() at time zone timezone)::date from clubs where id = $2)`, [id, m.club_id]);
      await db.query(`update contracts set status = 'cancelled' where membership_id = $1 and status <> 'cancelled'`, [id]);
      await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'cancel',$4,$5)`,
        [ctx.tenantId, m.club_id, id, JSON.stringify({ reason: reason.trim() }), ctx.userId]);
      if (m.kind === 'subscription') await db.query(`update persons set segment = 'отписавшийся' where id = $1`, [m.person_id]);
      await audit(db, ctx, 'membership.cancelled', 'membership', id, { status: m.status }, { status: 'cancelled', reason: reason.trim() });
      return { ok: true };
    });
  });

  // Временно, до подключения кассы и эквайринга (шаг 8): отметка оплаты на ресепшн с записью в журнал
  app.post('/api/charges/:id/mark-paid', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const { method } = (req.body ?? {}) as { method?: string };
    if (!['cash', 'card_terminal', 'sbp'].includes(method ?? '')) throw badRequest('Выберите способ оплаты');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select * from charges where id = $1', [id])).rows[0];
      if (!c) throw notFound('Платёж не найден');
      if (c.status !== 'due') throw badRequest('Платёж уже оплачен или отменён');
      await db.query(`update charges set status = 'paid', paid_at = now(), paid_method = $2, paid_by = $3 where id = $1`, [id, method, ctx.userId]);
      if (c.membership_id) {
        await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'charge_paid',$4,$5)`,
          [ctx.tenantId, c.club_id, c.membership_id, JSON.stringify({ chargeId: id, method, amountKop: Number(c.amount_kop) }), ctx.userId]);
      }
      const receiptId = await receiptForCharge(db, ctx, id, method!);
      await audit(db, ctx, 'charge.marked_paid', 'charge', id, { status: 'due' }, { status: 'paid', method, receiptId });
      return { ok: true, receiptId };
    });
  });

  // Проверка права прохода (для ресепшн; турникеты подключатся в шаге СКУД)
  app.get('/api/persons/:id/access', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const ms = (await personMemberships(db, id)).filter((m) => !clubId || m.clubId === clubId);
      const ok = ms.find((m) => m.access);
      if (ok) return { allowed: true, membershipId: ok.id, reason: ok.reason, productName: ok.productName };
      const best = ms.find((m) => ['frozen', 'debt_blocked', 'not_started'].includes(m.state)) ?? ms[0];
      return { allowed: false, reason: best ? best.reason : 'Нет абонемента в этом клубе', productName: best?.productName ?? null };
    });
  });
}
