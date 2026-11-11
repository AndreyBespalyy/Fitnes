// Упрощённый управленческий отчёт о прибыли (список «20 новых возможностей», п. 19).
// Доходы — оплаты клиентов за месяц по видам (абонементы, персональные, товары…) минус возвраты; расходы — по статьям,
// зарплата — по утверждённой ведомости месяца (если её нет — по выплатам, а если и их нет — оценка по схемам оплаты).
// Это основа: полная управленческая отчётность по ТЗ — в Этапе 2.1.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { notifyStaff } from './staffBot.ts';
import { calcPayroll } from './staffTime.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Fetch = typeof fetch;
const monthAdd = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const nextMonthStart = (m: string) => `${monthAdd(m, 1)}-01`;
const REV: Record<string, string> = { memberships: 'Абонементы', personal: 'Персональные тренировки', single: 'Разовые визиты', goods: 'Товары и услуги', prepaid: 'Депозиты и сертификаты', other: 'Прочие поступления' };

export type MonthPnl = {
  month: string; revenue: { code: string; name: string; amountKop: number }[]; revenueKop: number; refundsKop: number; netRevenueKop: number;
  expenses: { code: string; name: string; amountKop: number; note?: string }[]; expensesKop: number; profitKop: number; marginPct: number | null;
  payrollSource: 'approved' | 'paid' | 'estimate' | 'none'; activeClients: number;
};

/** Отчёт за один месяц по клубу (или по всем видимым, если clubId = null). */
export async function monthPnl(db: Db, clubId: string | null, month: string, today: string): Promise<MonthPnl> {
  const from = `${month}-01`; const to = nextMonthStart(month);
  const pays = (await db.query(`select p.direction, p.kind, p.expense_category as cat, ec.name as cat_name, p.sale_category,
      case when p.sale_category in ('deposit', 'gift') then 'prepaid' when p.sale_category = 'goods' or ch.kind = 'goods' then 'goods'
        when m.kind = 'personal' then 'personal' when m.kind = 'guest' then 'single' when m.kind is not null then 'memberships' else 'other' end as rev,
      sum(p.amount_kop)::bigint as s
    from payments p join clubs c on c.id = p.club_id left join charges ch on ch.id = p.charge_id left join memberships m on m.id = ch.membership_id
      left join expense_categories ec on ec.code = p.expense_category
    where ($1::uuid is null or p.club_id = $1) and (p.created_at at time zone c.timezone)::date >= $2::date and (p.created_at at time zone c.timezone)::date < $3::date
    group by 1, 2, 3, 4, 5, 6`, [clubId, from, to])).rows.map((r) => ({ ...r, s: Number(r.s) }));
  const revMap = new Map<string, number>();
  for (const r of pays.filter((x) => x.direction === 'in')) revMap.set(r.rev, (revMap.get(r.rev) ?? 0) + r.s);
  const revenue = Object.keys(REV).filter((k) => revMap.get(k)).map((k) => ({ code: k, name: REV[k], amountKop: revMap.get(k)! }));
  const revenueKop = revenue.reduce((s, r) => s + r.amountKop, 0);
  const refundsKop = pays.filter((x) => x.kind === 'refund').reduce((s, r) => s + r.s, 0);

  // Зарплата по каждому клубу: утверждённая ведомость месяца важнее выплат (выплаты тогда не считаем, чтобы не задвоить),
  // нет ведомости — берём выплаты по статье «Зарплата», нет и их — оценка по схемам оплаты
  const clubs = clubId ? [clubId] : (await db.query('select id from clubs')).rows.map((r) => r.id as string);
  let payrollKop = 0; const sources = new Set<'approved' | 'paid' | 'estimate'>();
  for (const c of clubs) {
    const sheet = (await db.query(`select coalesce(sum(l.total_kop), 0)::bigint as s from payroll_periods p left join payroll_lines l on l.period_id = p.id
      where p.club_id = $1 and p.month = $2::date and p.status = 'approved' group by p.id`, [c, from])).rows[0];
    if (sheet) { payrollKop += Number(sheet.s); sources.add('approved'); continue; }
    const paid = Number((await db.query(`select coalesce(sum(p.amount_kop), 0)::bigint as s from payments p join clubs cl on cl.id = p.club_id
      where p.club_id = $1 and p.kind = 'expense' and p.expense_category = 'salary'
        and (p.created_at at time zone cl.timezone)::date >= $2::date and (p.created_at at time zone cl.timezone)::date < $3::date`, [c, from, to])).rows[0].s);
    if (paid) { payrollKop += paid; sources.add('paid'); continue; }
    const est = (await calcPayroll(db, c, month, today)).reduce((s2, l) => s2 + l.totalKop, 0);
    if (est) { payrollKop += est; sources.add('estimate'); }
  }
  const expMap = new Map<string, { name: string; s: number }>();
  for (const r of pays.filter((x) => x.kind === 'expense' && x.cat !== 'salary')) {
    const e = expMap.get(r.cat) ?? { name: r.cat_name ?? r.cat, s: 0 }; e.s += r.s; expMap.set(r.cat, e);
  }
  const expenses: MonthPnl['expenses'] = [...expMap.entries()].map(([code, e]) => ({ code, name: e.name, amountKop: e.s }));
  const NOTE = { approved: 'по утверждённой ведомости', paid: 'по выплатам', estimate: 'оценка по схемам оплаты, ведомость не утверждена' };
  if (payrollKop) expenses.push({ code: 'salary', name: 'Зарплата', amountKop: payrollKop, note: [...sources].map((x) => NOTE[x]).join('; ') });
  expenses.sort((a, b) => b.amountKop - a.amountKop);
  const expensesKop = expenses.reduce((s, e) => s + e.amountKop, 0);
  const netRevenueKop = revenueKop - refundsKop;
  const profitKop = netRevenueKop - expensesKop;
  const activeClients = Number((await db.query(`select count(distinct m.person_id)::int as n from memberships m
    where ($1::uuid is null or m.club_id = $1) and m.kind <> 'guest' and m.starts_on < $3::date and coalesce(m.ends_on, $3::date) >= $2::date
      and (m.status <> 'cancelled' or m.updated_at::date >= $2::date)`, [clubId, from, to])).rows[0].n);
  return {
    month, revenue, revenueKop, refundsKop, netRevenueKop, expenses, expensesKop, profitKop,
    marginPct: netRevenueKop > 0 ? Math.round((1000 * profitKop) / netRevenueKop) / 10 : null,
    payrollSource: sources.size === 1 ? [...sources][0] : sources.size ? 'approved' : 'none', activeClients,
  };
}

/** Сигнал: за последние 3 закрытых месяца расходы росли быстрее доходов (к трём предыдущим), или месяц в убытке. */
export function costSignals(series: MonthPnl[]) {
  const out: { kind: 'costs_outpace' | 'loss'; month: string; text: string }[] = [];
  if (series.length >= 6) {
    const last = series.slice(-3); const prev = series.slice(-6, -3);
    const sum = (xs: MonthPnl[], k: 'netRevenueKop' | 'expensesKop') => xs.reduce((s, x) => s + x[k], 0);
    const r1 = sum(last, 'netRevenueKop'), r0 = sum(prev, 'netRevenueKop'), e1 = sum(last, 'expensesKop'), e0 = sum(prev, 'expensesKop');
    if (e0 > 0 && r0 > 0) {
      const rg = (r1 / r0 - 1) * 100, eg = (e1 / e0 - 1) * 100;
      if (eg - rg >= 5 && e1 > e0) out.push({ kind: 'costs_outpace', month: last[2].month,
        text: `Расходы растут быстрее доходов: за 3 месяца расходы ${eg >= 0 ? '+' : ''}${Math.round(eg)} %, доходы ${rg >= 0 ? '+' : ''}${Math.round(rg)} % к трём месяцам до этого` });
    }
  }
  const lm = series[series.length - 1];
  if (lm && lm.profitKop < 0 && lm.netRevenueKop > 0) out.push({ kind: 'loss', month: lm.month, text: `${lm.month.split('-').reverse().join('.')}: убыток ${Math.round(-lm.profitKop / 100).toLocaleString('ru-RU')} ₽` });
  return out;
}

/** Раз в месяц по закрытым месяцам: сигнал собственнику задачей и в Telegram (если бот подключён). Повторно не шлём. */
export async function pnlAlerts(db: Db, f: Fetch | null, tenantId: string, clubId: string, today: string) {
  const cur = today.slice(0, 7);
  const series: MonthPnl[] = [];
  for (let i = 6; i >= 1; i--) series.push(await monthPnl(db, clubId, monthAdd(cur, -i), today));
  if (!series.some((s) => s.revenueKop || s.expensesKop)) return 0;
  const name = (await db.query('select name from clubs where id = $1', [clubId])).rows[0]?.name ?? '';
  let n = 0;
  for (const s of costSignals(series)) {
    const ins = await db.query(`insert into pnl_alerts(tenant_id, club_id, month, kind, text) values ($1,$2,$3,$4,$5) on conflict do nothing returning id`,
      [tenantId, clubId, `${s.month}-01`, s.kind, s.text]);
    if (!ins.rowCount) continue;
    const owners = (await db.query(`select distinct u.id from users u join user_assignments a on a.user_id = u.id where a.role_code = 'owner' and u.status = 'active'`)).rows.map((r) => r.id as string);
    const tasks: string[] = [];
    for (const u of owners) {
      tasks.push((await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'other',$4, now() + interval '3 days') returning id`,
        [tenantId, clubId, u, `${name}: ${s.text}. Откройте «Прибыль» и разберите статьи`])).rows[0].id);
      if (f) await notifyStaff(db, f, u, `${name}: ${s.text}. Подробности — в разделе «Прибыль».`).catch(() => false);
    }
    await db.query('update pnl_alerts set task_ids = $2 where id = $1', [ins.rows[0].id, tasks]);
    n++;
  }
  return n;
}

export function pnlRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/pnl', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const q = req.query as { clubId?: string; month?: string };
    if (q.clubId && q.clubId !== 'all' && !UUID.test(q.clubId)) throw badRequest('Клуб не найден');
    const clubId = q.clubId && q.clubId !== 'all' ? q.clubId : null;
    return withCtx(pool, ctx, async (db) => {
      const today = (await db.query(`select to_char(now() at time zone coalesce((select timezone from clubs where id = $1), 'Europe/Moscow'), 'YYYY-MM-DD') as d`, [clubId])).rows[0].d as string;
      const month = /^\d{4}-\d{2}$/.test(q.month ?? '') && q.month! <= today.slice(0, 7) ? q.month! : today.slice(0, 7);
      const cur = await monthPnl(db, clubId, month, today);
      const prev = await monthPnl(db, clubId, monthAdd(month, -1), today);
      const lastYear = await monthPnl(db, clubId, monthAdd(month, -12), today);
      const trend: MonthPnl[] = [];
      for (let i = 5; i >= 0; i--) trend.push(i === 0 ? cur : i === 1 ? prev : await monthPnl(db, clubId, monthAdd(month, -i), today));
      const area = clubId ? (await db.query('select area_m2 from club_finance_settings where club_id = $1', [clubId])).rows[0]?.area_m2 : (await db.query('select sum(area_m2) as a from club_finance_settings')).rows[0]?.a;
      const areaM2 = area ? Number(area) : null;
      const alerts = (await db.query(`select a.month, a.kind, a.text, a.created_at as "at", c.name as club from pnl_alerts a join clubs c on c.id = a.club_id
        where ($1::uuid is null or a.club_id = $1) order by a.created_at desc limit 5`, [clubId])).rows;
      return {
        month, today, current: month === today.slice(0, 7), cur, prev, lastYear, trend, areaM2,
        perM2Kop: areaM2 ? Math.round(cur.netRevenueKop / areaM2) : null, perClientKop: cur.activeClients ? Math.round(cur.netRevenueKop / cur.activeClients) : null,
        signals: costSignals(trend.filter((x) => x.month < today.slice(0, 7))), alerts,
        canEditArea: !!clubId && (can(ctx, P.financeWork) || can(ctx, P.tariffsManage)),
      };
    });
  });

  app.put('/api/pnl/area', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    if (!can(ctx, P.financeWork) && !can(ctx, P.tariffsManage)) throw forbidden();
    const b = (req.body ?? {}) as { clubId?: string; areaM2?: number | null };
    if (!b.clubId || !UUID.test(b.clubId)) throw badRequest('Выберите клуб');
    const a = b.areaM2 == null || (b.areaM2 as unknown) === '' ? null : Number(b.areaM2);
    if (a !== null && !(a > 0 && a < 100000)) throw badRequest('Площадь от 1 до 99 999 м²');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      await db.query(`insert into club_finance_settings(club_id, tenant_id, area_m2, updated_by) values ($1,$2,$3,$4)
        on conflict (club_id) do update set area_m2 = excluded.area_m2, updated_by = excluded.updated_by, updated_at = now()`, [b.clubId, ctx.tenantId, a, ctx.userId]);
      await audit(db, ctx, 'pnl.area', 'club', b.clubId!, null, { areaM2: a });
      return { areaM2: a };
    });
  });
}
