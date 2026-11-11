// Шаг 8 (финансы). Журнал платежей, кассовые смены, согласования по лимитам с повторным вводом пароля,
// возвраты с расчётом суммы, расходы, долги, ДДС (движение денег) и план-факт по категориям продаж.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm, can } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { verifyPassword } from '../passwords.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { receiptForRefund } from './fiscal.ts';
import { addDays, clubToday, daysBetween } from './memberships.ts';
import { applyDiscountDecision, discountLimit } from './promos.ts';

type Actor = Pick<Ctx, 'tenantId' | 'userId' | 'ip'> & Partial<Pick<Ctx, 'permissions' | 'roles'>>;
const rubs = (kop: number) => `${(kop / 100).toLocaleString('ru-RU')} ₽`;

/* ---------- журнал платежей ---------- */
export async function openShift(db: Db, clubId: string) {
  return (await db.query(`select id from cash_shifts where club_id = $1 and status = 'open'`, [clubId])).rows[0]?.id as string | undefined;
}
export async function recordPayment(db: Db, ctx: Actor, p: { clubId: string; direction: 'in' | 'out'; kind: 'charge' | 'refund' | 'expense'; amountKop: number; method: string;
  personId?: string | null; chargeId?: string; refundId?: string; expenseId?: string; saleCategory?: string | null; expenseCategory?: string }) {
  let shiftId: string | null = null;
  if (p.method === 'cash') {
    shiftId = (await openShift(db, p.clubId)) ?? null;
    if (!shiftId) throw badRequest('Для операции наличными откройте кассовую смену в разделе «Финансы»');
  }
  await db.query(
    `insert into payments(tenant_id, club_id, direction, kind, amount_kop, method, person_id, charge_id, refund_id, expense_id, sale_category, expense_category, shift_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [ctx.tenantId, p.clubId, p.direction, p.kind, p.amountKop, p.method, p.personId ?? null, p.chargeId ?? null, p.refundId ?? null, p.expenseId ?? null,
      p.saleCategory ?? null, p.expenseCategory ?? null, shiftId, ctx.userId]);
  return shiftId;
}

/* ---------- согласования ---------- */
const KIND_NAME: Record<string, string> = { refund: 'возврат', expense: 'расход', discount: 'скидка' };

/** Лимит сотрудника на вид операции: null — без ограничений (собственник), 0 — нет права. */
async function limitOf(db: Db, userId: string, clubId: string, kind: string): Promise<number | null> {
  const roles = (await db.query(`select a.role_code, r.permissions from user_assignments a join roles r on r.code = a.role_code
    where a.user_id = $1 and (a.club_id is null or a.club_id = $2)`, [userId, clubId])).rows;
  if (roles.some((r) => (r.permissions as string[]).includes('*'))) return null;
  const lim = (await db.query(`select max(max_amount_kop) as m from approval_limits where kind = $1 and role_code = any($2)`, [kind, roles.map((r) => r.role_code)])).rows[0].m;
  return lim === null ? 0 : Number(lim);
}

/** Может ли сотрудник утвердить: для скидки сравнивается процент, для возврата и расхода — сумма. */
async function withinLimit(db: Db, userId: string, clubId: string, kind: string, amountKop: number, percent: unknown) {
  if (kind === 'discount') { const l = await discountLimit(db, userId, clubId); return l === null || l >= Number(percent ?? 0); }
  const lim = await limitOf(db, userId, clubId, kind);
  return lim === null || lim >= amountKop;
}

/** Создаёт согласование. Если сумма в пределах лимита самого сотрудника, оно утверждается сразу. */
async function requestApproval(db: Db, ctx: Actor, a: { clubId: string; kind: 'refund' | 'expense'; objectId: string; amountKop: number; summary: string }) {
  const lim = await limitOf(db, ctx.userId, a.clubId, a.kind);
  const auto = lim === null || lim >= a.amountKop;
  const id = (await db.query(
    `insert into approvals(tenant_id, club_id, kind, object_id, amount_kop, summary, status, requested_by, auto, decided_by, decided_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, a.clubId, a.kind, a.objectId, a.amountKop, a.summary, auto ? 'approved' : 'pending', ctx.userId, auto, auto ? ctx.userId : null, auto ? new Date() : null])).rows[0].id as string;
  await audit(db, ctx, auto ? 'approval.auto_approved' : 'approval.requested', 'approval', id, null, { kind: a.kind, amountKop: a.amountKop, limitKop: lim });
  return { id, approved: auto };
}

/* ---------- возвраты ---------- */
/** Сколько вернуть клиенту: оплачено минус стоимость уже использованной части (по дням или занятиям). */
export async function refundQuote(db: Db, membershipId: string) {
  const m = (await db.query(`select m.*, to_char(m.starts_on, 'YYYY-MM-DD') as s, to_char(m.ends_on, 'YYYY-MM-DD') as e, p.visits_count
    from memberships m join products p on p.id = m.product_id where m.id = $1`, [membershipId])).rows[0];
  if (!m) throw notFound('Абонемент не найден');
  const today = await clubToday(db, m.club_id);
  const paid = Number((await db.query(`select coalesce(sum(amount_kop), 0) as s from charges where membership_id = $1 and status = 'paid' and kind <> 'freeze_fee'`, [membershipId])).rows[0].s);
  const refunded = Number((await db.query(`select coalesce(sum(amount_kop), 0) as s from refunds where membership_id = $1 and status in ('pending', 'approved', 'paid')`, [membershipId])).rows[0].s);
  const price = Number(m.amount_kop);
  let used = 0; let explain = '';
  if (m.visits_left !== null && m.visits_count) {
    const usedVisits = Math.max(0, m.visits_count - m.visits_left);
    used = Math.round(price * usedVisits / m.visits_count);
    explain = `использовано занятий ${usedVisits} из ${m.visits_count}`;
  } else if (m.e) {
    const frozen = (await db.query(`select to_char(starts_on, 'YYYY-MM-DD') as s, to_char(coalesce(ended_early_on - 1, ends_on), 'YYYY-MM-DD') as e from freezes where membership_id = $1`, [membershipId])).rows;
    const frozenTotal = frozen.reduce((x, f) => x + Math.max(0, daysBetween(f.s, f.e) + 1), 0);
    const total = Math.max(1, daysBetween(m.s, m.e) + 1 - frozenTotal);
    const upTo = today < m.s ? addDays(m.s, -1) : today > m.e ? m.e : today;
    const frozenPassed = frozen.reduce((x, f) => x + Math.max(0, daysBetween(f.s, upTo < f.e ? upTo : f.e) + 1), 0);
    const usedDays = Math.min(total, Math.max(0, daysBetween(m.s, upTo) + 1 - frozenPassed));
    used = Math.round(price * usedDays / total);
    explain = `использовано дней ${usedDays} из ${total}${frozenTotal ? ` (дни заморозки не считаются)` : ''}`;
  }
  const suggested = Math.max(0, paid - used - refunded);
  return { paidKop: paid, usedKop: used, refundedKop: refunded, suggestedKop: suggested, maxKop: Math.max(0, paid - refunded),
    explanation: `Оплачено ${rubs(paid)}, ${explain || 'расчёт по использованию недоступен'}, стоимость использованного ${rubs(used)}${refunded ? `, уже возвращено ${rubs(refunded)}` : ''}` };
}

async function executeRefund(db: Db, ctx: Actor, refundId: string) {
  const r = (await db.query('select * from refunds where id = $1', [refundId])).rows[0];
  await recordPayment(db, ctx, { clubId: r.club_id, direction: 'out', kind: 'refund', amountKop: Number(r.amount_kop), method: r.method, personId: r.person_id, refundId });
  await db.query(`update refunds set status = 'paid', paid_at = now() where id = $1`, [refundId]);
  if (r.cancel_membership) {
    await db.query(`update memberships set status = 'cancelled', cancel_reason = $2, next_charge_on = null, updated_at = now() where id = $1 and status = 'active'`, [r.membership_id, `Возврат: ${r.reason}`]);
    await db.query(`update charges set status = 'cancelled' where membership_id = $1 and status = 'due'`, [r.membership_id]);
    await db.query(`update contracts set status = 'cancelled' where membership_id = $1 and status <> 'cancelled'`, [r.membership_id]);
  }
  await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'cancel',$4,$5)`,
    [ctx.tenantId, r.club_id, r.membership_id, JSON.stringify({ refundId, amountKop: Number(r.amount_kop), reason: r.reason }), ctx.userId]);
  if (r.method !== 'bank_transfer') await receiptForRefund(db, ctx, refundId);
  await audit(db, ctx, 'refund.paid', 'refund', refundId, { status: r.status }, { status: 'paid', amountKop: Number(r.amount_kop), method: r.method });
}

async function applyDecision(db: Db, ctx: Actor, ap: { kind: string; object_id: string }, approved: boolean) {
  if (ap.kind === 'discount') await applyDiscountDecision(db, ap.object_id, approved);
  if (ap.kind === 'refund') {
    if (approved) { await db.query(`update refunds set status = 'approved' where id = $1`, [ap.object_id]); await executeRefund(db, ctx, ap.object_id); }
    else await db.query(`update refunds set status = 'rejected' where id = $1`, [ap.object_id]);
  }
  if (ap.kind === 'expense') {
    if (approved) {
      const e = (await db.query('select * from expenses where id = $1', [ap.object_id])).rows[0];
      const shift = await recordPayment(db, ctx, { clubId: e.club_id, direction: 'out', kind: 'expense', amountKop: Number(e.amount_kop), method: e.method, expenseId: e.id, expenseCategory: e.category });
      await db.query(`update expenses set status = 'approved', shift_id = $2 where id = $1`, [e.id, shift]);
    } else await db.query(`update expenses set status = 'rejected' where id = $1`, [ap.object_id]);
  }
}

/* ---------- отчёты ---------- */
const monthRange = (month?: string) => {
  const m = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : new Date().toISOString().slice(0, 7);
  const [y, mm] = m.split('-').map(Number);
  const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  return { month: m, from: `${m}-01`, to: `${next}-01` };
};
const CAT_NAME: Record<string, string> = { new: 'Новые продажи', renewal: 'Продления', return: 'Возобновления', subscription: 'Подписки' };

export function financeRoutes(app: FastifyInstance, pool: pg.Pool) {
  /* смены */
  app.get('/api/shifts', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select s.id, s.club_id as "clubId", s.status, s.opened_at as "openedAt", s.closed_at as "closedAt", s.opening_cash_kop::int as "openingCashKop",
         s.expected_cash_kop::int as "expectedCashKop", s.counted_cash_kop::int as "countedCashKop", s.note, uo.full_name as "openedBy", uc.full_name as "closedBy",
         coalesce((select sum(case when p.direction = 'in' then p.amount_kop else -p.amount_kop end) from payments p where p.shift_id = s.id), 0)::int as "cashMovementKop"
       from cash_shifts s join users uo on uo.id = s.opened_by left join users uc on uc.id = s.closed_by
       where ($1::uuid is null or s.club_id = $1) order by s.opened_at desc limit 30`, [clubId || null])).rows);
  });

  app.post('/api/shifts/open', async (req) => {
    const ctx = requirePerm(req, P.shiftsWork);
    const { clubId, openingCashKop } = (req.body ?? {}) as { clubId?: string; openingCashKop?: number };
    if (!clubId) throw badRequest('Выберите клуб');
    if (!Number.isInteger(openingCashKop) || openingCashKop! < 0) throw badRequest('Укажите сумму наличных в кассе на начало смены');
    return withCtx(pool, ctx, async (db) => {
      if (await openShift(db, clubId)) throw badRequest('Смена уже открыта');
      const last = (await db.query(`select counted_cash_kop from cash_shifts where club_id = $1 and status = 'closed' order by closed_at desc limit 1`, [clubId])).rows[0];
      const id = (await db.query(`insert into cash_shifts(tenant_id, club_id, opened_by, opening_cash_kop) values ($1,$2,$3,$4) returning id`, [ctx.tenantId, clubId, ctx.userId, openingCashKop])).rows[0].id;
      const mismatch = last && Number(last.counted_cash_kop) !== openingCashKop;
      await audit(db, ctx, 'shift.opened', 'cash_shift', id, null, { openingCashKop, previousClosingKop: last ? Number(last.counted_cash_kop) : null });
      return { id, warning: mismatch ? `На закрытии прошлой смены было ${rubs(Number(last.counted_cash_kop))}, сейчас указано ${rubs(openingCashKop!)}` : null };
    });
  });

  app.post('/api/shifts/:id/close', async (req) => {
    const ctx = requirePerm(req, P.shiftsWork);
    const { id } = req.params as { id: string };
    const { countedCashKop, note } = (req.body ?? {}) as { countedCashKop?: number; note?: string };
    if (!Number.isInteger(countedCashKop) || countedCashKop! < 0) throw badRequest('Пересчитайте наличные и укажите сумму');
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query(`select * from cash_shifts where id = $1`, [id])).rows[0];
      if (!s) throw notFound('Смена не найдена');
      if (s.status !== 'open') throw badRequest('Смена уже закрыта');
      const move = Number((await db.query(`select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) as m from payments where shift_id = $1`, [id])).rows[0].m);
      const expected = Number(s.opening_cash_kop) + move;
      const diff = countedCashKop! - expected;
      if (diff !== 0 && !note?.trim()) throw badRequest(`Расхождение ${rubs(diff)}: ожидалось ${rubs(expected)}. Укажите причину в комментарии`);
      await db.query(`update cash_shifts set status = 'closed', closed_by = $2, closed_at = now(), expected_cash_kop = $3, counted_cash_kop = $4, note = $5 where id = $1`,
        [id, ctx.userId, expected, countedCashKop, note?.trim() || null]);
      await audit(db, ctx, 'shift.closed', 'cash_shift', id, { status: 'open' }, { expectedKop: expected, countedKop: countedCashKop, diffKop: diff });
      return { expectedCashKop: expected, countedCashKop, differenceKop: diff };
    });
  });

  /* согласования */
  app.get('/api/approvals', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { status, clubId } = req.query as { status?: string; clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(`select a.id, a.club_id as "clubId", c.name as "clubName", a.kind, a.amount_kop::bigint as "amountKop", a.summary, a.status, a.auto,
          a.requested_at as "requestedAt", ur.full_name as "requestedBy", a.requested_by as "requestedById", ud.full_name as "decidedBy", a.decided_at as "decidedAt", a.decision_comment as "comment", a.percent::float as percent
        from approvals a join clubs c on c.id = a.club_id left join users ur on ur.id = a.requested_by left join users ud on ud.id = a.decided_by
        where ($1::text is null or a.status = $1) and ($2::uuid is null or a.club_id = $2) order by a.requested_at desc limit 100`, [status || null, clubId || null])).rows;
      const out = [];
      for (const r of rows) {
        let canDecide = false;
        if (r.status === 'pending' && can(ctx, P.approvalsDecide) && r.requestedById !== ctx.userId) {
          canDecide = await withinLimit(db, ctx.userId, r.clubId, r.kind, Number(r.amountKop), r.percent);
        }
        out.push({ ...r, amountKop: Number(r.amountKop), canDecide });
      }
      return out;
    });
  });

  // Решение по согласованию подтверждается повторным вводом пароля (решение Андрея 10.11.2026)
  app.post('/api/approvals/:id/decide', async (req) => {
    const ctx = requirePerm(req, P.approvalsDecide);
    const { id } = req.params as { id: string };
    const { decision, password, comment } = (req.body ?? {}) as { decision?: string; password?: string; comment?: string };
    if (!['approve', 'reject'].includes(decision ?? '')) throw badRequest('Выберите решение');
    if (!password) throw badRequest('Введите свой пароль для подтверждения');
    if (decision === 'reject' && !comment?.trim()) throw badRequest('Укажите причину отказа');
    return withCtx(pool, ctx, async (db) => {
      const u = (await db.query('select password_hash from users where id = $1', [ctx.userId])).rows[0];
      if (!(await verifyPassword(u.password_hash, password))) throw badRequest('Пароль введён неверно', 'wrong_password');
      const ap = (await db.query('select * from approvals where id = $1 for update', [id])).rows[0];
      if (!ap) throw notFound('Согласование не найдено');
      if (ap.status !== 'pending') throw badRequest('По этому запросу уже принято решение');
      if (ap.requested_by === ctx.userId) throw forbidden('Свой запрос утверждает другой сотрудник');
      if (ap.kind === 'discount' && !(await withinLimit(db, ctx.userId, ap.club_id, ap.kind, 0, ap.percent)))
        throw forbidden(`Скидка ${Number(ap.percent)} % больше вашего лимита. Решение принимает собственник`);
      const lim = ap.kind === 'discount' ? null : await limitOf(db, ctx.userId, ap.club_id, ap.kind);
      if (lim !== null && lim < Number(ap.amount_kop)) throw forbidden(`Сумма ${rubs(Number(ap.amount_kop))} больше вашего лимита на ${KIND_NAME[ap.kind]} (${rubs(lim)}). Решение принимает собственник`);
      const approved = decision === 'approve';
      await db.query(`update approvals set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 where id = $1`, [id, approved ? 'approved' : 'rejected', ctx.userId, comment?.trim() || null]);
      await applyDecision(db, ctx, ap, approved);
      await audit(db, ctx, approved ? 'approval.approved' : 'approval.rejected', 'approval', id, { status: 'pending' }, { status: approved ? 'approved' : 'rejected', comment: comment ?? null });
      return { ok: true, status: approved ? 'approved' : 'rejected' };
    });
  });

  /* возвраты */
  app.get('/api/memberships/:id/refund-quote', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => refundQuote(db, id));
  });

  app.post('/api/memberships/:id/refund', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { amountKop?: number; method?: string; reason?: string; cancelMembership?: boolean };
    if (!Number.isInteger(b.amountKop) || b.amountKop! <= 0) throw badRequest('Укажите сумму возврата');
    if (!['cash', 'card_terminal', 'sbp', 'bank_transfer'].includes(b.method ?? '')) throw badRequest('Выберите, как вернуть деньги');
    if (!b.reason?.trim()) throw badRequest('Укажите причину возврата');
    const res = await withCtx(pool, ctx, async (db) => {
      const m = (await db.query('select club_id, person_id, product_name from memberships where id = $1', [id])).rows[0];
      if (!m) throw notFound('Абонемент не найден');
      const q = await refundQuote(db, id);
      if (b.amountKop! > q.maxKop) throw badRequest(`Вернуть можно не больше оплаченного: ${rubs(q.maxKop)}`);
      if ((await db.query(`select 1 from refunds where membership_id = $1 and status = 'pending'`, [id])).rowCount) throw badRequest('По этому абонементу уже есть возврат на согласовании');
      const refundId = (await db.query(`insert into refunds(tenant_id, club_id, membership_id, person_id, amount_kop, method, reason, cancel_membership, requested_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [ctx.tenantId, m.club_id, id, m.person_id, b.amountKop, b.method, b.reason!.trim(), b.cancelMembership !== false, ctx.userId])).rows[0].id;
      const person = (await db.query('select full_name from persons where id = $1', [m.person_id])).rows[0].full_name;
      const ap = await requestApproval(db, ctx, { clubId: m.club_id, kind: 'refund', objectId: refundId, amountKop: b.amountKop!,
        summary: `Возврат ${rubs(b.amountKop!)} клиенту ${person} за «${m.product_name}». Причина: ${b.reason!.trim()}. Расчёт: ${q.explanation}` });
      await db.query('update refunds set approval_id = $2 where id = $1', [refundId, ap.id]);
      await audit(db, ctx, 'refund.requested', 'refund', refundId, null, { amountKop: b.amountKop, method: b.method, suggestedKop: q.suggestedKop });
      if (ap.approved) { await db.query(`update refunds set status = 'approved' where id = $1`, [refundId]); await executeRefund(db, ctx, refundId); }
      return { refundId, status: ap.approved ? 'paid' : 'pending', approvalId: ap.id };
    });
    reply.code(201);
    return res;
  });

  /* расходы */
  app.get('/api/expense-categories', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    return withCtx(pool, ctx, async (db) => (await db.query('select code, name from expense_categories order by sort')).rows);
  });

  app.post('/api/expenses', async (req, reply) => {
    const ctx = requirePerm(req, P.financeWork);
    const b = (req.body ?? {}) as { clubId?: string; category?: string; amountKop?: number; description?: string; method?: string; spentOn?: string };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!Number.isInteger(b.amountKop) || b.amountKop! <= 0) throw badRequest('Укажите сумму');
    if (!b.description?.trim()) throw badRequest('Опишите расход');
    if (!['cash', 'bank_transfer', 'card'].includes(b.method ?? '')) throw badRequest('Выберите способ оплаты');
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from expense_categories where code = $1', [b.category])).rowCount) throw badRequest('Выберите статью расхода');
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      const spentOn = b.spentOn && /^\d{4}-\d{2}-\d{2}$/.test(b.spentOn) ? b.spentOn : await clubToday(db, b.clubId!);
      if (b.method === 'cash' && !(await openShift(db, b.clubId!))) throw badRequest('Для расхода наличными откройте кассовую смену');
      const id = (await db.query(`insert into expenses(tenant_id, club_id, category, amount_kop, description, method, spent_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, b.clubId, b.category, b.amountKop, b.description!.trim(), b.method, spentOn, ctx.userId])).rows[0].id;
      const ap = await requestApproval(db, ctx, { clubId: b.clubId!, kind: 'expense', objectId: id, amountKop: b.amountKop!, summary: `Расход ${rubs(b.amountKop!)}: ${b.description!.trim()}` });
      await db.query('update expenses set approval_id = $2 where id = $1', [id, ap.id]);
      if (ap.approved) await applyDecision(db, ctx, { kind: 'expense', object_id: id }, true);
      await audit(db, ctx, 'expense.created', 'expense', id, null, { amountKop: b.amountKop, category: b.category, approved: ap.approved });
      return { id, status: ap.approved ? 'approved' : 'pending' };
    });
    reply.code(201);
    return res;
  });

  app.get('/api/expenses', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId, month } = req.query as { clubId?: string; month?: string };
    const r = monthRange(month);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select e.id, e.club_id as "clubId", e.category, ec.name as "categoryName", e.amount_kop::int as "amountKop", e.description, e.method, to_char(e.spent_on, 'YYYY-MM-DD') as "spentOn",
         e.status, u.full_name as "createdBy" from expenses e join expense_categories ec on ec.code = e.category left join users u on u.id = e.created_by
       where ($1::uuid is null or e.club_id = $1) and e.spent_on >= $2 and e.spent_on < $3 order by e.spent_on desc, e.created_at desc`, [clubId || null, r.from, r.to])).rows);
  });

  /* отчёты */
  app.get('/api/finance/payments', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId, month } = req.query as { clubId?: string; month?: string };
    const r = monthRange(month);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select p.id, p.created_at as "at", p.direction, p.kind, p.amount_kop::int as "amountKop", p.method, p.sale_category as "saleCategory", p.expense_category as "expenseCategory",
         pe.full_name as "personName", coalesce(ch.title, e.description, 'Возврат') as "title", u.full_name as "createdBy"
       from payments p left join persons pe on pe.id = p.person_id left join charges ch on ch.id = p.charge_id left join expenses e on e.id = p.expense_id left join users u on u.id = p.created_by
       join clubs c on c.id = p.club_id
       where ($1::uuid is null or p.club_id = $1) and (p.created_at at time zone c.timezone)::date >= $2 and (p.created_at at time zone c.timezone)::date < $3
       order by p.created_at desc limit 500`, [clubId || null, r.from, r.to])).rows);
  });

  app.get('/api/finance/debts', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select ch.person_id as "personId", pe.full_name as "personName", c.name as "clubName", sum(ch.amount_kop)::int as "debtKop", count(*)::int as "charges",
         to_char(min(ch.due_on), 'YYYY-MM-DD') as "oldestDueOn", ((now() at time zone c.timezone)::date - min(ch.due_on))::int as "daysOverdue"
       from charges ch join persons pe on pe.id = ch.person_id join clubs c on c.id = ch.club_id
       where ch.status = 'due' and ch.due_on < (now() at time zone c.timezone)::date and ($1::uuid is null or ch.club_id = $1)
       group by ch.person_id, pe.full_name, c.name, c.timezone order by "daysOverdue" desc`, [clubId || null])).rows);
  });

  // ДДС: поступления и выплаты за месяц по способам, категориям продаж и статьям расходов
  app.get('/api/finance/cashflow', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId, month } = req.query as { clubId?: string; month?: string };
    const r = monthRange(month);
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(
        `select p.direction, p.kind, p.method, p.sale_category, p.expense_category, ec.name as expense_name, sum(p.amount_kop)::bigint as s
         from payments p join clubs c on c.id = p.club_id left join expense_categories ec on ec.code = p.expense_category
         where ($1::uuid is null or p.club_id = $1) and (p.created_at at time zone c.timezone)::date >= $2 and (p.created_at at time zone c.timezone)::date < $3
         group by 1,2,3,4,5,6`, [clubId || null, r.from, r.to])).rows.map((x) => ({ ...x, s: Number(x.s) }));
      const sum = (f: (x: typeof rows[number]) => boolean) => rows.filter(f).reduce((a, x) => a + x.s, 0);
      const inflow = sum((x) => x.direction === 'in');
      const refunds = sum((x) => x.kind === 'refund');
      const expenses = sum((x) => x.kind === 'expense');
      const group = (f: (x: typeof rows[number]) => boolean, key: (x: typeof rows[number]) => string) => {
        const m = new Map<string, number>(); for (const x of rows.filter(f)) m.set(key(x), (m.get(key(x)) ?? 0) + x.s);
        return [...m.entries()].map(([name, amountKop]) => ({ name, amountKop })).sort((a, b) => b.amountKop - a.amountKop);
      };
      const METHOD: Record<string, string> = { cash: 'Наличные', card_terminal: 'Карта (терминал)', sbp: 'СБП', bank_transfer: 'Банковский перевод', card: 'Карта' };
      return {
        month: r.month, inflowKop: inflow, refundsKop: refunds, expensesKop: expenses, netKop: inflow - refunds - expenses,
        inflowByMethod: group((x) => x.direction === 'in', (x) => METHOD[x.method] ?? x.method),
        inflowByCategory: group((x) => x.direction === 'in', (x) => CAT_NAME[x.sale_category] ?? (x.sale_category === 'goods' ? 'Товары и услуги' : 'Прочее')),
        expensesByCategory: group((x) => x.kind === 'expense', (x) => x.expense_name ?? x.expense_category),
      };
    });
  });

  app.get('/api/finance/plan-fact', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId, month } = req.query as { clubId?: string; month?: string };
    const r = monthRange(month);
    return withCtx(pool, ctx, async (db) => {
      const plan = (await db.query(`select category, sum(amount_kop)::bigint as s from plan_targets where user_id is null and ($1::uuid is null or club_id = $1) and month = $2 group by category`, [clubId || null, r.from])).rows;
      const fact = (await db.query(`select p.sale_category as category, sum(case when p.direction = 'in' then p.amount_kop else -p.amount_kop end)::bigint as s
        from payments p join clubs c on c.id = p.club_id
        where p.kind in ('charge', 'refund') and ($1::uuid is null or p.club_id = $1) and (p.created_at at time zone c.timezone)::date >= $2 and (p.created_at at time zone c.timezone)::date < $3
        group by 1`, [clubId || null, r.from, r.to])).rows;
      const cats = ['new', 'renewal', 'return', 'subscription'];
      const items = cats.map((k) => {
        const p = Number(plan.find((x) => x.category === k)?.s ?? 0); const f = Number(fact.find((x) => x.category === k)?.s ?? 0);
        return { category: k, name: CAT_NAME[k], planKop: p, factKop: f, percent: p ? Math.round(f * 100 / p) : null };
      });
      const tp = items.reduce((a, x) => a + x.planKop, 0); const tf = items.reduce((a, x) => a + x.factKop, 0);
      return { month: r.month, items, totalPlanKop: tp, totalFactKop: tf, totalPercent: tp ? Math.round(tf * 100 / tp) : null };
    });
  });

  app.put('/api/finance/plan', async (req) => {
    const ctx = requirePerm(req, P.financeWork);
    const b = (req.body ?? {}) as { clubId?: string; month?: string; amounts?: Record<string, number> };
    if (!b.clubId || !/^\d{4}-\d{2}$/.test(b.month ?? '')) throw badRequest('Выберите клуб и месяц');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      for (const [k, v] of Object.entries(b.amounts ?? {})) {
        if (!(k in CAT_NAME) || !Number.isInteger(v) || v < 0) throw badRequest('Неверная сумма плана');
        await db.query(`insert into plan_targets(tenant_id, club_id, month, user_id, category, amount_kop, updated_by) values ($1,$2,$3,null,$4,$5,$6)
          on conflict (club_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
          do update set amount_kop = excluded.amount_kop, updated_by = excluded.updated_by, updated_at = now()`,
          [ctx.tenantId, b.clubId, `${b.month}-01`, k, v, ctx.userId]);
      }
      await audit(db, ctx, 'finance.plan_changed', 'club', b.clubId!, null, { month: b.month, amounts: b.amounts });
      return { ok: true };
    });
  });
}
