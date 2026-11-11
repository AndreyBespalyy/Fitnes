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
type Payer = { familyGroupId: string | null; payerPersonId: string | null; companyId: string | null; percent: number; label: string | null; dueOn: string | null };
const SELF: Payer = { familyGroupId: null, payerPersonId: null, companyId: null, percent: 0, label: null, dueOn: null };
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
    const c = (await db.query(`select id, name, club_id, status, discount_percent, payment_days from companies where id = $1`, [b.companyId])).rows[0];
    if (!c || c.club_id !== a.clubId || c.status !== 'active') throw badRequest('Компания не найдена в этом клубе');
    if (!(await activeEmployee(db, c.id, a.personId))) throw badRequest(`Клиент не в списке сотрудников «${c.name}»`);
    if (a.productKind === 'subscription') throw badRequest('За счёт компании продаются абонементы на срок и пакеты: подписка списывается с карты клиента каждый месяц');
    if (a.installments > 1) throw badRequest('За счёт компании — без рассрочки: компания платит по счёту за месяц');
    return { ...SELF, companyId: c.id, percent: Number(c.discount_percent), label: Number(c.discount_percent) ? `корпоративная скидка ${c.discount_percent} % (${c.name})` : null,
      dueOn: addDays(monthEnd(a.today), Number(c.payment_days)) };
  }
  throw badRequest('Неизвестный плательщик');
}

/** Счёт компании: все неоплаченные начисления сотрудников, ещё не попавшие в счёт, по конец месяца. */
async function createInvoice(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, companyId: string, period: string) {
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
  const today = await clubToday(db, c.club_id);
  const id = (await db.query(`insert into company_invoices(tenant_id, club_id, company_id, number, period, amount_kop, due_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, c.club_id, companyId, number, period, total, addDays(today, Number(c.payment_days)), ctx.userId])).rows[0].id as string;
  await db.query('update charges set invoice_id = $2 where id = any($1)', [charges.map((x) => x.id), id]);
  await audit(db, ctx, 'company.invoice_issued', 'company_invoice', id, null, { companyId, number, period, amountKop: total, charges: charges.length });
  return { id, number, amountKop: total };
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
    contactEmail?: string | null; contractNumber?: string | null; contractDate?: string | null; discountPercent?: number; paymentDays?: number; maxEmployees?: number | null; status?: string };
  const clean = (b: CompanyIn) => {
    const t = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
    const inn = t(b.inn);
    if (inn && !/^\d{10}(\d{2})?$/.test(inn)) throw badRequest('ИНН: 10 цифр у организации, 12 у ИП');
    if (b.contractDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.contractDate)) throw badRequest('Дата договора указана неверно');
    const disc = b.discountPercent ?? 0; const days = b.paymentDays ?? 10;
    if (!(Number.isInteger(disc) && disc >= 0 && disc <= 50)) throw badRequest('Скидка компании от 0 до 50 %');
    if (!(Number.isInteger(days) && days >= 0 && days <= 60)) throw badRequest('Срок оплаты счёта от 0 до 60 дней');
    if (b.maxEmployees != null && !(Number.isInteger(b.maxEmployees) && b.maxEmployees > 0)) throw badRequest('Лимит сотрудников — целое число больше нуля');
    return { inn, kpp: t(b.kpp), address: t(b.address), contactName: t(b.contactName), contactPhone: t(b.contactPhone), contactEmail: t(b.contactEmail),
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
      const id = (await db.query(`insert into companies(tenant_id, club_id, name, inn, kpp, address, contact_name, contact_phone, contact_email, contract_number, contract_date, discount_percent, payment_days, max_employees, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [ctx.tenantId, b.clubId, b.name!.trim(), v.inn, v.kpp, v.address, v.contactName, v.contactPhone, v.contactEmail, v.contractNumber, v.contractDate, v.disc, v.days, v.max, ctx.userId])).rows[0].id;
      await audit(db, ctx, 'company.created', 'company', id, null, { name: b.name, discountPercent: v.disc });
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
        discount_percent = $11, payment_days = $12, max_employees = $13, status = coalesce($14, status) where id = $1`,
      [id, b.name!.trim(), v.inn, v.kpp, v.address, v.contactName, v.contactPhone, v.contactEmail, v.contractNumber, v.contractDate, v.disc, v.days, v.max, b.status ?? null]);
      await audit(db, ctx, 'company.updated', 'company', id, { name: before.name, discountPercent: before.discount_percent, status: before.status }, { name: b.name, discountPercent: v.disc, status: b.status ?? before.status });
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
          max_employees as "maxEmployees", status from companies where id = $1`, [id])).rows[0];
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
      const invoices = (await db.query(`select id, number, period, amount_kop::bigint as "amountKop", to_char(due_on, 'YYYY-MM-DD') as "dueOn", status, created_at as "createdAt", paid_at as "paidAt"
        from company_invoices where company_id = $1 order by created_at desc limit 24`, [id])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop) }));
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
</tbody><tfoot><tr><th colspan="3" class="r">Итого, без НДС</th><th class="r">${rub(Number(inv.amount_kop))}</th></tr></tfoot></table>
<p>Период: ${esc(inv.period.slice(5, 7))}.${esc(inv.period.slice(0, 4))}. Оплатить до ${esc(inv.due)}.</p>
<p style="color:#666">Если клуб работает с НДС, укажите ставку в реквизитах юрлица клуба: пока счёт формируется без НДС.</p>
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
        family = { payerName: (await db.query('select full_name from persons where id = $1', [g.payer_id])).rows[0].full_name, discountPercent: others ? Number(s?.p ?? 0) : 0, isPayer: g.payer_id === id };
      }
      const companies = (await db.query(`select c.id, c.name, c.discount_percent as "discountPercent" from company_employees e join companies c on c.id = e.company_id
        where e.person_id = $1 and e.removed_at is null and c.club_id = $2 and c.status = 'active' order by c.name`, [id, clubId])).rows;
      return { family, companies };
    });
  });
}
