// Семейные и корпоративные абонементы (список «20 новых возможностей», п. 13).
// Семья: плательщик и участники, у каждого свой абонемент и проход, скидка второму и следующим, оплата всех долгов семьи разом.
// Компания: договор и реквизиты, сотрудники, абонементы за счёт компании без оплаты на ресепшне, счёт юрлицу за месяц, отчёт о посещениях.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { addDays, clubToday, payCharge } from './memberships.ts';

export type PayerInput = { payer?: 'self' | 'family' | 'company'; companyId?: string };
type Payer = { familyGroupId: string | null; payerPersonId: string | null; companyId: string | null; percent: number; label: string | null; dueOn: string | null; sharePercent: number };
const SELF: Payer = { familyGroupId: null, payerPersonId: null, companyId: null, percent: 0, label: null, dueOn: null, sharePercent: 100 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
const monthEnd = (d: string) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Семья клиента в клубе: группа, плательщик, участники. */
async function familyOf(db: Db, personId: string, clubId: string) {
  return (await db.query(`select g.id, g.payer_id from family_members m join family_groups g on g.id = m.group_id where m.person_id = $1 and m.club_id = $2`, [personId, clubId])).rows[0] as
    { id: string; payer_id: string } | undefined;
}
async function activeEmployee(db: Db, companyId: string, personId: string) {
  return (await db.query(`select e.id from company_employees e where e.company_id = $1 and e.person_id = $2 and e.removed_at is null`, [companyId, personId])).rowCount! > 0;
}

/** Кто платит за продаваемый абонемент. Вызывается из продажи. */
export async function resolvePayer(db: Db, b: PayerInput, a: { personId: string; clubId: string; productKind: string; installments: number; today: string }): Promise<Payer> {
  if (!b.payer || b.payer === 'self') return SELF;
  if (b.payer === 'family') {
    const g = await familyOf(db, a.personId, a.clubId);
    if (!g) throw badRequest('Клиент не состоит в семье в этом клубе: сначала добавьте его в семью в карточке плательщика');
    const s = (await db.query('select family_discount_percent as p from club_membership_settings where club_id = $1', [a.clubId])).rows[0];
    // Скидка второму и следующим: у кого-то ещё из семьи уже есть действующий абонемент
    const others = (await db.query(`select 1 from memberships m join family_members f on f.person_id = m.person_id and f.group_id = $1
      where m.person_id <> $2 and m.club_id = $3 and m.status = 'active' and (m.ends_on is null or m.ends_on >= $4) limit 1`, [g.id, a.personId, a.clubId, a.today])).rowCount;
    const percent = others ? Number(s?.p ?? 0) : 0;
    return { ...SELF, familyGroupId: g.id, payerPersonId: g.payer_id, percent, label: percent ? `семейная скидка ${percent} %` : null };
  }
  if (b.payer === 'company') {
    if (!UUID.test(b.companyId ?? '')) throw badRequest('Выберите компанию');
    const c = (await db.query(`select id, name, club_id, status, discount_percent, payment_days, share_percent from companies where id = $1`, [b.companyId])).rows[0];
    if (!c || c.club_id !== a.clubId || c.status !== 'active') throw badRequest('Компания не найдена в этом клубе');
    if (!(await activeEmployee(db, c.id, a.personId))) throw badRequest(`Клиент не в списке сотрудников «${c.name}»`);
    if (a.productKind === 'subscription') throw badRequest('За счёт компании продаются абонементы на срок и пакеты: подписка списывается с карты клиента каждый месяц');
    if (a.installments > 1) throw badRequest('За счёт компании — без рассрочки: компания платит по счёту за месяц');
    return { ...SELF, companyId: c.id, percent: Number(c.discount_percent), label: Number(c.discount_percent) ? `корпоративная скидка ${c.discount_percent} % (${c.name})` : null,
      dueOn: addDays(monthEnd(a.today), Number(c.payment_days)), sharePercent: Number(c.share_percent) };
  }
  throw badRequest('Неизвестный плательщик');
}

/* ---------- общий семейный абонемент: места ---------- */
/** Кому из семьи покупателя дать места в общем абонементе. Возвращает семью и список людей без покупателя. */
export async function checkSeatHolders(db: Db, a: { buyerId: string; clubId: string; seats: number; personIds: string[] }) {
  const g = await familyOf(db, a.buyerId, a.clubId);
  if (!g) throw badRequest('Общий семейный абонемент оформляется на семью: сначала создайте семью в карточке клиента и добавьте её членов');
  const ids = [...new Set(a.personIds)].filter((x) => x !== a.buyerId);
  if (ids.some((x) => !UUID.test(x))) throw badRequest('Выберите членов семьи');
  if (ids.length > a.seats - 1) throw badRequest(`В тарифе ${a.seats} чел. вместе с покупателем: можно выбрать не больше ${a.seats - 1} членов семьи`);
  if (ids.length) {
    const inFam = (await db.query('select person_id from family_members where group_id = $1 and person_id = any($2)', [g.id, ids])).rows.length;
    if (inFam !== ids.length) throw badRequest('Места даются только членам семьи покупателя: добавьте человека в семью');
  }
  return { groupId: g.id, personIds: ids };
}

/** Создать места в общем абонементе: свой абонемент-место у каждого, без платежей, по срокам основного. */
export async function createSeats(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, parentId: string, personIds: string[]) {
  const p = (await db.query(`select *, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on from memberships where id = $1`, [parentId])).rows[0];
  for (const pid of personIds) {
    const id = (await db.query(`insert into memberships(tenant_id, club_id, person_id, product_id, price_version_id, kind, product_name, amount_kop, starts_on, ends_on, installments,
        created_by, network_access, access_from, access_to, list_price_kop, discount_kop, family_group_id, payer_person_id, parent_membership_id)
      values ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,1,$10,$11,$12,$13,0,0,$14,$15,$16) returning id`,
    [p.tenant_id, p.club_id, pid, p.product_id, p.price_version_id, p.kind, p.product_name, p.starts_on, p.ends_on, ctx.userId, p.network_access, p.access_from, p.access_to,
      p.family_group_id, p.person_id, parentId])).rows[0].id;
    await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'seat_added',$4,$5)`,
      [ctx.tenantId, p.club_id, parentId, JSON.stringify({ seatId: id, personId: pid }), ctx.userId]);
    await db.query(`update persons set segment = 'действующий', updated_at = now() where id = $1`, [pid]);
  }
}

/** Для карточки клиента: у основного абонемента — кто на местах, у места — чей это абонемент. */
export async function seatsOf(db: Db, ms: { id: string; parent_membership_id: string | null; product_id: string }[]) {
  const out = new Map<string, Record<string, unknown>>();
  const parents = ms.filter((m) => !m.parent_membership_id).map((m) => m.id);
  const seatParents = ms.filter((m) => m.parent_membership_id).map((m) => m.parent_membership_id!);
  if (parents.length) {
    const fam = (await db.query(`select m.id, p.family_seats from memberships m join products p on p.id = m.product_id where m.id = any($1) and p.family_seats is not null`, [parents])).rows;
    if (fam.length) {
      const seats = (await db.query(`select s.id, s.parent_membership_id as parent, s.person_id as "personId", pe.full_name as name from memberships s join persons pe on pe.id = s.person_id
        where s.parent_membership_id = any($1) and s.status = 'active' order by s.created_at`, [fam.map((f) => f.id)])).rows;
      for (const f of fam) out.set(f.id, { familySeats: Number(f.family_seats), seats: seats.filter((x) => x.parent === f.id).map(({ parent: _p, ...x }) => x) });
    }
  }
  if (seatParents.length) {
    const ps = (await db.query(`select m.id, m.person_id, pe.full_name from memberships m join persons pe on pe.id = m.person_id where m.id = any($1)`, [seatParents])).rows;
    for (const m of ms) if (m.parent_membership_id) {
      const p = ps.find((x) => x.id === m.parent_membership_id);
      if (p) out.set(m.id, { seatOf: { membershipId: p.id, holderId: p.person_id, holderName: p.full_name } });
    }
  }
  return out;
}

/** Счёт компании: все неоплаченные начисления сотрудников, ещё не попавшие в счёт, по конец месяца. */
async function createInvoice(db: Db, ctx: { tenantId: string; userId: string | null }, companyId: string, period: string, auto = false, on?: string) {
  const c = (await db.query('select * from companies where id = $1', [companyId])).rows[0];
  if (!c) throw notFound('Компания не найдена');
  const end = monthEnd(`${period}-01`);
  const charges = (await db.query(`select ch.id, ch.amount_kop from charges ch join memberships m on m.id = ch.membership_id
    where ch.company_id = $1 and ch.status = 'due' and ch.invoice_id is null and m.created_at < ($2::date + 1) for update of ch`, [companyId, end])).rows;
  if (!charges.length) throw badRequest('За этот период нечего выставлять: все абонементы сотрудников уже в счетах или оплачены');
  const total = charges.reduce((s, x) => s + Number(x.amount_kop), 0);
  const year = period.slice(0, 4);
  const n = (await db.query(`select count(*)::int + 1 as n from company_invoices where club_id = $1 and number like $2`, [c.club_id, `СЧ-${year}-%`])).rows[0].n;
  const number = `СЧ-${year}-${String(n).padStart(4, '0')}`;
  const today = on ?? await clubToday(db, c.club_id);
  // НДС по ставке юрлица клуба, «в том числе» (цены абонементов уже с НДС)
  const vat = (await db.query('select invoice_vat from legal_entities where club_id = $1', [c.club_id])).rows[0]?.invoice_vat as string | null | undefined;
  const rate = vat == null ? null : Number(vat);
  const vatKop = rate ? Math.round(total * rate / (100 + rate)) : 0;
  const id = (await db.query(`insert into company_invoices(tenant_id, club_id, company_id, number, period, amount_kop, due_on, created_by, vat_rate, vat_kop, auto)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, c.club_id, companyId, number, period, total, addDays(today, Number(c.payment_days)), ctx.userId, rate, vatKop, auto])).rows[0].id as string;
  await db.query('update charges set invoice_id = $2 where id = any($1)', [charges.map((x) => x.id), id]);
  await audit(db, ctx, 'company.invoice_issued', 'company_invoice', id, null, { companyId, number, period, amountKop: total, vatRate: rate, vatKop, charges: charges.length, auto });
  return { id, number, amountKop: total, vatKop };
}

const prevMonth = (d: string) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - 1); return x.toISOString().slice(0, 7); };

/**
 * Фоновая работа по компаниям клуба (раз в 15 минут из воркера удержания):
 * с 1-го по 5-е число — счёт за прошлый месяц компаниям с автовыставлением и задача отправить его;
 * неоплаченный в срок счёт — одна задача ответственному за компанию.
 */
export async function processCompanyInvoices(db: Db, actor: { tenantId: string; userId: null }, clubId: string, today: string) {
  const created: string[] = [];
  if (Number(today.slice(8, 10)) <= 5) {
    const period = prevMonth(today);
    const cs = (await db.query(`select c.id, c.name, c.manager_id, c.created_by from companies c where c.club_id = $1 and c.status = 'active' and c.auto_invoice
      and not exists (select 1 from company_invoices i where i.company_id = c.id and i.period = $2 and i.auto and i.status <> 'cancelled')
      and exists (select 1 from charges ch join memberships m on m.id = ch.membership_id where ch.company_id = c.id and ch.status = 'due' and ch.invoice_id is null and m.created_at < ($3::date + 1))`,
    [clubId, period, monthEnd(`${period}-01`)])).rows;
    for (const c of cs) {
      const inv = await createInvoice(db, actor, c.id, period, true, today);
      created.push(inv.id);
      await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'message',$4, now() + interval '1 day')`,
        [actor.tenantId, clubId, c.manager_id ?? c.created_by, `Отправить компании «${c.name}» счёт ${inv.number} на ${rub(inv.amountKop)} (раздел «Компании» → «Печать»)`]);
    }
  }
  const overdue = (await db.query(`select i.id, i.number, i.amount_kop, to_char(i.due_on, 'DD.MM.YYYY') as due, c.name, coalesce(c.manager_id, i.created_by, c.created_by) as who
    from company_invoices i join companies c on c.id = i.company_id where i.club_id = $1 and i.status = 'issued' and i.due_on < $2 and i.overdue_task_id is null`, [clubId, today])).rows;
  for (const i of overdue) {
    const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'call',$4, now() + interval '1 day') returning id`,
      [actor.tenantId, clubId, i.who, `Компания «${i.name}» не оплатила счёт ${i.number} на ${rub(Number(i.amount_kop))} (срок был ${i.due}). Позвонить контактному лицу`])).rows[0].id;
    await db.query('update company_invoices set overdue_task_id = $2 where id = $1', [i.id, tid]);
    await audit(db, actor, 'company.invoice_overdue', 'company_invoice', i.id, null, { taskId: tid });
  }
  return { issued: created.length, overdue: overdue.length };
}

export function familyCorpRoutes(app: FastifyInstance, pool: pg.Pool) {
  /* ================= семья ================= */
  app.get('/api/persons/:id/family', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') return { group: null, canManage: false };
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query('select family_discount_percent as p, family_max_members as m from club_membership_settings where club_id = $1', [clubId])).rows[0];
      const g = await familyOf(db, id, clubId);
      const base = { discountPercent: Number(s?.p ?? 0), maxMembers: Number(s?.m ?? 6), canManage: can(ctx, P.membershipsSell) };
      if (!g) return { ...base, group: null };
      const today = await clubToday(db, clubId);
      const members = (await db.query(`select f.person_id as "personId", p.full_name as name, f.relation, (f.person_id = $2) as payer,
          (select json_agg(json_build_object('product', m.product_name, 'endsOn', to_char(m.ends_on, 'YYYY-MM-DD'), 'visitsLeft', m.visits_left) order by m.starts_on desc)
             from memberships m where m.person_id = f.person_id and m.club_id = $3 and m.status = 'active' and (m.ends_on is null or m.ends_on >= $4)) as active
        from family_members f join persons p on p.id = f.person_id where f.group_id = $1 order by (f.person_id = $2) desc, f.added_at`, [g.id, g.payer_id, clubId, today])).rows;
      const due = (await db.query(`select ch.id, ch.title, ch.amount_kop::bigint as "amountKop", to_char(ch.due_on, 'YYYY-MM-DD') as "dueOn", p.full_name as person
        from charges ch join family_members f on f.person_id = ch.person_id and f.group_id = $1 join persons p on p.id = ch.person_id
        where ch.status = 'due' and ch.club_id = $2 and ch.company_id is null and ch.due_on <= $3 order by ch.due_on`, [g.id, clubId, today])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop) }));
      return { ...base, group: { id: g.id, payerId: g.payer_id, members, due, dueKop: due.reduce((x, r) => x + r.amountKop, 0) } };
    });
  });

  app.post('/api/families', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const b = (req.body ?? {}) as { clubId?: string; payerId?: string };
    if (!b.clubId || b.clubId === 'all' || !UUID.test(b.payerId ?? '')) throw badRequest('Выберите клуб и плательщика');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from persons where id = $1', [b.payerId])).rowCount) throw notFound('Клиент не найден');
      if (await familyOf(db, b.payerId!, b.clubId!)) throw badRequest('Клиент уже состоит в семье в этом клубе');
      const id = (await db.query('insert into family_groups(tenant_id, club_id, payer_id, created_by) values ($1,$2,$3,$4) returning id', [ctx.tenantId, b.clubId, b.payerId, ctx.userId])).rows[0].id as string;
      await db.query(`insert into family_members(group_id, tenant_id, club_id, person_id, relation, added_by) values ($1,$2,$3,$4,'плательщик',$5)`, [id, ctx.tenantId, b.clubId, b.payerId, ctx.userId]);
      await audit(db, ctx, 'family.created', 'family_group', id, null, { payerId: b.payerId });
      return { id };
    });
  });

  app.post('/api/families/:id/members', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { personId?: string; relation?: string };
    if (!UUID.test(b.personId ?? '')) throw badRequest('Выберите клиента');
    return withCtx(pool, ctx, async (db) => {
      const g = (await db.query('select * from family_groups where id = $1', [id])).rows[0];
      if (!g) throw notFound('Семья не найдена');
      if (!(await db.query('select 1 from persons where id = $1', [b.personId])).rowCount) throw notFound('Клиент не найден');
      const ex = await familyOf(db, b.personId!, g.club_id);
      if (ex) throw badRequest(ex.id === id ? 'Клиент уже в этой семье' : 'Клиент уже состоит в другой семье в этом клубе');
      const s = (await db.query('select family_max_members as m from club_membership_settings where club_id = $1', [g.club_id])).rows[0];
      const cnt = (await db.query('select count(*)::int as n from family_members where group_id = $1', [id])).rows[0].n;
      if (cnt >= Number(s?.m ?? 6)) throw badRequest(`В семье может быть не больше ${s?.m ?? 6} человек`);
      await db.query('insert into family_members(group_id, tenant_id, club_id, person_id, relation, added_by) values ($1,$2,$3,$4,$5,$6)',
        [id, ctx.tenantId, g.club_id, b.personId, b.relation?.trim().slice(0, 40) || null, ctx.userId]);
      await audit(db, ctx, 'family.member_added', 'family_group', id, null, { personId: b.personId, relation: b.relation ?? null });
      return { ok: true };
    });
  });

  app.post('/api/families/:id/members/:personId/remove', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id, personId } = req.params as { id: string; personId: string };
    return withCtx(pool, ctx, async (db) => {
      const g = (await db.query('select * from family_groups where id = $1', [id])).rows[0];
      if (!g) throw notFound('Семья не найдена');
      if (g.payer_id === personId) throw badRequest('Плательщика нельзя убрать из семьи. Если семья распалась, уберите остальных участников');
      const r = await db.query('delete from family_members where group_id = $1 and person_id = $2', [id, personId]);
      if (!r.rowCount) throw notFound('Участник не найден');
      await audit(db, ctx, 'family.member_removed', 'family_group', id, { personId }, null);
      return { ok: true };
    });
  });

  // Оплатить разом все долги семьи (плательщик платит за всех)
  app.post('/api/families/:id/pay', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const { method } = (req.body ?? {}) as { method?: string };
    if (!['cash', 'card_terminal', 'sbp'].includes(method ?? '')) throw badRequest('Выберите способ оплаты');
    return withCtx(pool, ctx, async (db) => {
      const g = (await db.query('select * from family_groups where id = $1', [id])).rows[0];
      if (!g) throw notFound('Семья не найдена');
      const today = await clubToday(db, g.club_id);
      const due = (await db.query(`select ch.id, ch.amount_kop from charges ch join family_members f on f.person_id = ch.person_id and f.group_id = $1
        where ch.status = 'due' and ch.club_id = $2 and ch.company_id is null and ch.due_on <= $3 order by ch.due_on`, [id, g.club_id, today])).rows;
      if (!due.length) throw badRequest('У семьи нет платежей к оплате');
      for (const c of due) await payCharge(db, ctx, c.id, method!);
      const total = due.reduce((s, c) => s + Number(c.amount_kop), 0);
      await audit(db, ctx, 'family.paid', 'family_group', id, null, { method, amountKop: total, charges: due.length });
      return { ok: true, paid: due.length, amountKop: total };
    });
  });

  /* ================= компании ================= */
  // Договоры с компаниями и счета: собственник, управляющий, финансист, руководитель продаж
  const canCorp = (ctx: Ctx) => can(ctx, P.tariffsManage) || can(ctx, P.financeWork) || can(ctx, P.crmViewAll);
  const manageCompanies = (ctx: Ctx) => { if (!canCorp(ctx)) throw forbidden(); };
  type CompanyIn = { clubId?: string; name?: string; inn?: string | null; kpp?: string | null; address?: string | null; contactName?: string | null; contactPhone?: string | null;
    contactEmail?: string | null; contractNumber?: string | null; contractDate?: string | null; discountPercent?: number; paymentDays?: number; maxEmployees?: number | null; status?: string;
    sharePercent?: number; autoInvoice?: boolean; managerId?: string | null };
  const clean = (b: CompanyIn) => {
    const t = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
    const inn = t(b.inn);
    if (inn && !/^\d{10}(\d{2})?$/.test(inn)) throw badRequest('ИНН: 10 цифр у организации, 12 у ИП');
    if (b.contractDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.contractDate)) throw badRequest('Дата договора указана неверно');
    const disc = b.discountPercent ?? 0; const days = b.paymentDays ?? 10;
    if (!(Number.isInteger(disc) && disc >= 0 && disc <= 50)) throw badRequest('Скидка компании от 0 до 50 %');
    if (!(Number.isInteger(days) && days >= 0 && days <= 60)) throw badRequest('Срок оплаты счёта от 0 до 60 дней');
    if (b.maxEmployees != null && !(Number.isInteger(b.maxEmployees) && b.maxEmployees > 0)) throw badRequest('Лимит сотрудников — целое число больше нуля');
    const share = b.sharePercent ?? 100;
    if (!(Number.isInteger(share) && share >= 10 && share <= 100)) throw badRequest('Доля компании в оплате от 10 до 100 %');
    if (b.managerId && !UUID.test(b.managerId)) throw badRequest('Выберите ответственного');
    return { share, auto: b.autoInvoice ?? false, managerId: b.managerId || null, inn, kpp: t(b.kpp), address: t(b.address), contactName: t(b.contactName), contactPhone: t(b.contactPhone), contactEmail: t(b.contactEmail),
      contractNumber: t(b.contractNumber), contractDate: b.contractDate || null, disc, days, max: b.maxEmployees ?? null };
  };

  app.get('/api/companies', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => ({
      items: (await db.query(`select c.id, c.name, c.inn, c.contract_number as "contractNumber", c.discount_percent as "discountPercent", c.status, c.max_employees as "maxEmployees",
          (select count(*)::int from company_employees e where e.company_id = c.id and e.removed_at is null) as employees,
          (select coalesce(sum(ch.amount_kop), 0)::bigint from charges ch where ch.company_id = c.id and ch.status = 'due' and ch.invoice_id is null) as "uninvoicedKop",
          (select coalesce(sum(i.amount_kop), 0)::bigint from company_invoices i where i.company_id = c.id and i.status = 'issued') as "unpaidKop"
        from companies c where c.club_id = $1 order by c.status, c.name`, [clubId])).rows.map((r) => ({ ...r, uninvoicedKop: Number(r.uninvoicedKop), unpaidKop: Number(r.unpaidKop) })),
      canManage: canCorp(ctx),
      // Кого можно назначить ответственным за компанию: сотрудники клуба и сети
      staff: (await db.query(`select distinct u.id, u.full_name as name from users u join user_assignments a on a.user_id = u.id
        where u.status = 'active' and (a.club_id = $1 or a.club_id is null) and (a.active_to is null or a.active_to >= current_date) order by u.full_name`, [clubId])).rows,
    }));
  });

  app.post('/api/companies', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsView); manageCompanies(ctx);
    const b = (req.body ?? {}) as CompanyIn;
    if (!b.clubId || b.clubId === 'all') throw badRequest('Выберите клуб');
    if (!b.name?.trim()) throw badRequest('Укажите название компании');
    const v = clean(b);
    return withCtx(pool, ctx, async (db) => {
      if ((await db.query('select 1 from companies where club_id = $1 and lower(name) = lower($2)', [b.clubId, b.name!.trim()])).rowCount) throw badRequest('Компания с таким названием уже есть');
      const id = (await db.query(`insert into companies(tenant_id, club_id, name, inn, kpp, address, contact_name, contact_phone, contact_email, contract_number, contract_date, discount_percent, payment_days, max_employees, created_by,
          share_percent, auto_invoice, manager_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
      [ctx.tenantId, b.clubId, b.name!.trim(), v.inn, v.kpp, v.address, v.contactName, v.contactPhone, v.contactEmail, v.contractNumber, v.contractDate, v.disc, v.days, v.max, ctx.userId,
        v.share, v.auto, v.managerId])).rows[0].id;
      await audit(db, ctx, 'company.created', 'company', id, null, { name: b.name, discountPercent: v.disc, sharePercent: v.share, autoInvoice: v.auto });
      reply.code(201);
      return { id };
    });
  });

  app.patch('/api/companies/:id', async (req) => {
    const ctx = requirePerm(req, P.membershipsView); manageCompanies(ctx);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as CompanyIn;
    if (!b.name?.trim()) throw badRequest('Укажите название компании');
    if (b.status && !['active', 'archived'].includes(b.status)) throw badRequest('Неизвестный статус');
    const v = clean(b);
    return withCtx(pool, ctx, async (db) => {
      const before = (await db.query('select * from companies where id = $1', [id])).rows[0];
      if (!before) throw notFound('Компания не найдена');
      await db.query(`update companies set name = $2, inn = $3, kpp = $4, address = $5, contact_name = $6, contact_phone = $7, contact_email = $8, contract_number = $9, contract_date = $10,
        discount_percent = $11, payment_days = $12, max_employees = $13, status = coalesce($14, status), share_percent = $15, auto_invoice = $16, manager_id = $17 where id = $1`,
      [id, b.name!.trim(), v.inn, v.kpp, v.address, v.contactName, v.contactPhone, v.contactEmail, v.contractNumber, v.contractDate, v.disc, v.days, v.max, b.status ?? null, v.share, v.auto, v.managerId]);
      await audit(db, ctx, 'company.updated', 'company', id, { name: before.name, discountPercent: before.discount_percent, status: before.status, sharePercent: before.share_percent, autoInvoice: before.auto_invoice },
        { name: b.name, discountPercent: v.disc, status: b.status ?? before.status, sharePercent: v.share, autoInvoice: v.auto });
      return { ok: true };
    });
  });

  app.get('/api/companies/:id', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query(`select id, club_id as "clubId", name, inn, kpp, address, contact_name as "contactName", contact_phone as "contactPhone", contact_email as "contactEmail",
          contract_number as "contractNumber", to_char(contract_date, 'YYYY-MM-DD') as "contractDate", discount_percent as "discountPercent", payment_days as "paymentDays",
          max_employees as "maxEmployees", status, share_percent as "sharePercent", auto_invoice as "autoInvoice", manager_id as "managerId",
          (select full_name from users u where u.id = companies.manager_id) as "managerName" from companies where id = $1`, [id])).rows[0];
      if (!c) throw notFound('Компания не найдена');
      const today = await clubToday(db, c.clubId);
      const m = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : today.slice(0, 7);
      const employees = (await db.query(`select e.id, e.person_id as "personId", p.full_name as name, e.position, e.added_at as "addedAt",
          (select m.product_name || coalesce(' до ' || to_char(m.ends_on, 'DD.MM.YYYY'), '') from memberships m where m.person_id = e.person_id and m.club_id = e.club_id and m.status = 'active'
             and (m.ends_on is null or m.ends_on >= $3) order by m.starts_on desc limit 1) as membership,
          (select count(*)::int from visits v join clubs cl on cl.id = v.club_id where v.person_id = e.person_id and v.club_id = e.club_id
             and to_char(v.visited_at at time zone cl.timezone, 'YYYY-MM') = $2) as visits,
          (select max(v.visited_at) from visits v where v.person_id = e.person_id and v.club_id = e.club_id) as "lastVisit"
        from company_employees e join persons p on p.id = e.person_id where e.company_id = $1 and e.removed_at is null order by p.full_name`, [id, m, today])).rows;
      const invoices = (await db.query(`select id, number, period, amount_kop::bigint as "amountKop", to_char(due_on, 'YYYY-MM-DD') as "dueOn", status, created_at as "createdAt", paid_at as "paidAt",
          vat_rate as "vatRate", vat_kop::bigint as "vatKop", auto, (status = 'issued' and due_on < $2) as overdue
        from company_invoices where company_id = $1 order by created_at desc limit 24`, [id, today])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop), vatKop: Number(r.vatKop) }));
      const pending = (await db.query(`select ch.id, ch.title, ch.amount_kop::bigint as "amountKop", p.full_name as person, to_char(ch.due_on, 'YYYY-MM-DD') as "dueOn"
        from charges ch join persons p on p.id = ch.person_id where ch.company_id = $1 and ch.status = 'due' and ch.invoice_id is null order by ch.created_at`, [id])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop) }));
      return { company: c, month: m, employees, invoices, pending, canManage: canCorp(ctx) };
    });
  });

  app.post('/api/companies/:id/employees', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { personId?: string; position?: string };
    if (!UUID.test(b.personId ?? '')) throw badRequest('Выберите клиента');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select * from companies where id = $1', [id])).rows[0];
      if (!c) throw notFound('Компания не найдена');
      if (c.status !== 'active') throw badRequest('Компания в архиве');
      if (!(await db.query('select 1 from persons where id = $1', [b.personId])).rowCount) throw notFound('Клиент не найден');
      if (await activeEmployee(db, id, b.personId!)) throw badRequest('Клиент уже в списке сотрудников');
      const n = (await db.query('select count(*)::int as n from company_employees where company_id = $1 and removed_at is null', [id])).rows[0].n;
      if (c.max_employees && n >= c.max_employees) throw badRequest(`По договору не больше ${c.max_employees} сотрудников. Измените лимит в карточке компании`);
      const eid = (await db.query('insert into company_employees(tenant_id, club_id, company_id, person_id, position, added_by) values ($1,$2,$3,$4,$5,$6) returning id',
        [ctx.tenantId, c.club_id, id, b.personId, b.position?.trim().slice(0, 80) || null, ctx.userId])).rows[0].id;
      await audit(db, ctx, 'company.employee_added', 'company', id, null, { personId: b.personId });
      return { id: eid };
    });
  });

  app.post('/api/companies/:id/employees/:eid/remove', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id, eid } = req.params as { id: string; eid: string };
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query('update company_employees set removed_at = now(), removed_by = $3 where id = $1 and company_id = $2 and removed_at is null returning person_id', [eid, id, ctx.userId]);
      if (!r.rowCount) throw notFound('Сотрудник не найден');
      await audit(db, ctx, 'company.employee_removed', 'company', id, { personId: r.rows[0].person_id }, null);
      return { ok: true };
    });
  });

  app.post('/api/companies/:id/invoices', async (req) => {
    const ctx = requirePerm(req, P.membershipsView); manageCompanies(ctx);
    const { id } = req.params as { id: string };
    const { period } = (req.body ?? {}) as { period?: string };
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period ?? '')) throw badRequest('Укажите месяц счёта');
    return withCtx(pool, ctx, (db) => createInvoice(db, ctx, id, period!));
  });

  app.post('/api/company-invoices/:id/paid', async (req) => {
    const ctx = requirePerm(req, P.membershipsView); manageCompanies(ctx);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const inv = (await db.query('select * from company_invoices where id = $1 for update', [id])).rows[0];
      if (!inv) throw notFound('Счёт не найден');
      if (inv.status !== 'issued') throw badRequest('Счёт уже оплачен или отменён');
      const charges = (await db.query(`select id from charges where invoice_id = $1 and status = 'due'`, [id])).rows;
      for (const c of charges) await payCharge(db, ctx, c.id, 'bank_transfer');
      await db.query(`update company_invoices set status = 'paid', paid_at = now(), paid_by = $2 where id = $1`, [id, ctx.userId]);
      await audit(db, ctx, 'company.invoice_paid', 'company_invoice', id, { status: 'issued' }, { status: 'paid', charges: charges.length });
      return { ok: true, charges: charges.length };
    });
  });

  app.post('/api/company-invoices/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.membershipsView); manageCompanies(ctx);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const inv = (await db.query('select * from company_invoices where id = $1 for update', [id])).rows[0];
      if (!inv) throw notFound('Счёт не найден');
      if (inv.status !== 'issued') throw badRequest('Отменить можно только неоплаченный счёт');
      await db.query(`update charges set invoice_id = null where invoice_id = $1 and status = 'due'`, [id]);
      await db.query(`update company_invoices set status = 'cancelled' where id = $1`, [id]);
      await audit(db, ctx, 'company.invoice_cancelled', 'company_invoice', id, { status: 'issued' }, { status: 'cancelled' });
      return { ok: true };
    });
  });

  // Счёт для печати и отправки компании
  app.get('/api/company-invoices/:id/print', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const d = await withCtx(pool, ctx, async (db) => {
      const inv = (await db.query(`select i.*, to_char(i.due_on, 'DD.MM.YYYY') as due, to_char(i.created_at, 'DD.MM.YYYY') as dt, c.name as company, c.inn, c.kpp, c.address,
          c.contract_number, to_char(c.contract_date, 'DD.MM.YYYY') as contract_date, cl.name as club from company_invoices i join companies c on c.id = i.company_id join clubs cl on cl.id = i.club_id where i.id = $1`, [id])).rows[0];
      if (!inv) throw notFound('Счёт не найден');
      const le = (await db.query('select * from legal_entities where club_id = $1', [inv.club_id])).rows[0];
      const lines = (await db.query(`select ch.title, ch.amount_kop, p.full_name from charges ch join persons p on p.id = ch.person_id where ch.invoice_id = $1 order by p.full_name`, [id])).rows;
      return { inv, le, lines };
    });
    const { inv, le, lines } = d;
    const seller = le ? `${esc(le.full_name)}${le.inn ? `, ИНН ${esc(le.inn)}` : ''}${le.kpp ? `, КПП ${esc(le.kpp)}` : ''}${le.address ? `, ${esc(le.address)}` : ''}` : esc(inv.club);
    const bank = le?.account ? `<p>Р/с ${esc(le.account)}${le.bank_name ? ` в ${esc(le.bank_name)}` : ''}${le.bik ? `, БИК ${esc(le.bik)}` : ''}${le.corr_account ? `, к/с ${esc(le.corr_account)}` : ''}</p>` : '';
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Счёт ${esc(inv.number)}</title><style>body{font:14px/1.4 system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111}
table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:6px;text-align:left}th{background:#f2f2f2}.r{text-align:right}@media print{button{display:none}}</style></head><body>
<h2>Счёт № ${esc(inv.number)} от ${esc(inv.dt)}</h2>
<p><b>Исполнитель:</b> ${seller}</p>${bank}
<p><b>Заказчик:</b> ${esc(inv.company)}${inv.inn ? `, ИНН ${esc(inv.inn)}` : ''}${inv.kpp ? `, КПП ${esc(inv.kpp)}` : ''}${inv.address ? `, ${esc(inv.address)}` : ''}</p>
${inv.contract_number ? `<p><b>Основание:</b> договор № ${esc(inv.contract_number)}${inv.contract_date ? ` от ${esc(inv.contract_date)}` : ''}</p>` : ''}
<table><thead><tr><th>№</th><th>Услуга</th><th>Сотрудник</th><th class="r">Сумма</th></tr></thead><tbody>
${lines.map((l, i) => `<tr><td>${i + 1}</td><td>Фитнес-услуги: ${esc(l.title)}</td><td>${esc(l.full_name)}</td><td class="r">${rub(Number(l.amount_kop))}</td></tr>`).join('')}
</tbody><tfoot><tr><th colspan="3" class="r">Итого</th><th class="r">${rub(Number(inv.amount_kop))}</th></tr>
<tr><th colspan="3" class="r">${inv.vat_rate == null ? 'Без НДС' : `В том числе НДС ${inv.vat_rate} %`}</th><th class="r">${inv.vat_rate == null ? '—' : rub(Number(inv.vat_kop))}</th></tr></tfoot></table>
<p>Период: ${esc(inv.period.slice(5, 7))}.${esc(inv.period.slice(0, 4))}. Оплатить до ${esc(inv.due)}.</p>
<button onclick="print()">Печать</button></body></html>`;
  });

  // Сотрудники компании, в которых состоит клиент: для выбора «платит компания» при продаже
  app.get('/api/persons/:id/payers', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') return { family: null, companies: [] };
    return withCtx(pool, ctx, async (db) => {
      const g = await familyOf(db, id, clubId);
      let family = null;
      if (g) {
        const today = await clubToday(db, clubId);
        const s = (await db.query('select family_discount_percent as p from club_membership_settings where club_id = $1', [clubId])).rows[0];
        const others = (await db.query(`select 1 from memberships m join family_members f on f.person_id = m.person_id and f.group_id = $1
          where m.person_id <> $2 and m.club_id = $3 and m.status = 'active' and (m.ends_on is null or m.ends_on >= $4) limit 1`, [g.id, id, clubId, today])).rowCount;
        const members = (await db.query(`select f.person_id as "personId", p.full_name as name, f.relation from family_members f join persons p on p.id = f.person_id
          where f.group_id = $1 and f.person_id <> $2 order by f.added_at`, [g.id, id])).rows;
        family = { payerName: (await db.query('select full_name from persons where id = $1', [g.payer_id])).rows[0].full_name, discountPercent: others ? Number(s?.p ?? 0) : 0, isPayer: g.payer_id === id, members };
      }
      const companies = (await db.query(`select c.id, c.name, c.discount_percent as "discountPercent", c.share_percent as "sharePercent" from company_employees e join companies c on c.id = e.company_id
        where e.person_id = $1 and e.removed_at is null and c.club_id = $2 and c.status = 'active' order by c.name`, [id, clubId])).rows;
      return { family, companies };
    });
  });

  /* ================= места в общем семейном абонементе ================= */
  const loadParent = async (db: Db, id: string) => {
    const m = (await db.query(`select m.*, to_char(m.ends_on, 'YYYY-MM-DD') as ends_on, p.family_seats from memberships m join products p on p.id = m.product_id where m.id = $1`, [id])).rows[0];
    if (!m) throw notFound('Абонемент не найден');
    if (!m.family_seats || m.parent_membership_id) throw badRequest('Это не общий семейный абонемент');
    if (m.status !== 'active') throw badRequest('Абонемент не действует');
    return m;
  };

  app.post('/api/memberships/:id/seats', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    const { personId } = (req.body ?? {}) as { personId?: string };
    if (!UUID.test(personId ?? '')) throw badRequest('Выберите члена семьи');
    return withCtx(pool, ctx, async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`seats:${id}`]);
      const m = await loadParent(db, id);
      const today = await clubToday(db, m.club_id);
      if (m.ends_on && m.ends_on < today) throw badRequest('Срок абонемента закончился');
      const taken = (await db.query(`select person_id from memberships where parent_membership_id = $1 and status = 'active'`, [id])).rows.map((r) => r.person_id as string);
      if (personId === m.person_id || taken.includes(personId!)) throw badRequest('У этого человека уже есть место в абонементе');
      if (taken.length + 1 >= Number(m.family_seats)) throw badRequest(`Все места заняты: в тарифе ${m.family_seats} чел. вместе с покупателем. Сначала освободите место`);
      await checkSeatHolders(db, { buyerId: m.person_id, clubId: m.club_id, seats: Number(m.family_seats), personIds: [personId!] });
      await createSeats(db, ctx, id, [personId!]);
      await audit(db, ctx, 'membership.seat_added', 'membership', id, null, { personId });
      return { ok: true };
    });
  });

  app.post('/api/memberships/:id/seats/:seatId/remove', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id, seatId } = req.params as { id: string; seatId: string };
    return withCtx(pool, ctx, async (db) => {
      const m = await loadParent(db, id);
      const r = await db.query(`update memberships set status = 'cancelled', cancel_reason = 'место освобождено', updated_at = now() where id = $1 and parent_membership_id = $2 and status = 'active' returning person_id`, [seatId, id]);
      if (!r.rowCount) throw notFound('Место не найдено');
      await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'seat_removed',$4,$5)`,
        [ctx.tenantId, m.club_id, id, JSON.stringify({ seatId, personId: r.rows[0].person_id }), ctx.userId]);
      await audit(db, ctx, 'membership.seat_removed', 'membership', id, { personId: r.rows[0].person_id }, null);
      return { ok: true };
    });
  });
}
