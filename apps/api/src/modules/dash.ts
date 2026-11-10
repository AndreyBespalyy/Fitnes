// Шаг 13. Рабочий стол из виджетов, дашборды собственника, управляющего и РОПа, план продаж по клубу и менеджерам,
// KPI сотрудников с нормами, конверсия «лид → контакт → встреча → покупка», выгрузки в CSV и XLSX, словарь метрик.
// Все цифры считаются при открытии прямо из базы (задержка — время запроса), поэтому «онлайн».
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { toCsv, toXlsx, type Cell, type Table } from '../lib/xlsx.ts';
import { daysBetween } from './memberships.ts';

export const CATS = ['new', 'renewal', 'return', 'subscription'] as const;
export const CAT_NAME: Record<string, string> = { new: 'Новые клиенты', renewal: 'Продления', return: 'Возобновление бывших', subscription: 'Подписки' };
export const SALES_ROLES = ['manager', 'rop'];

/* ---------- словарь метрик (FR-DASH-08) ---------- */
export const METRICS: { id: string; name: string; definition: string; formula: string; source: string; delay: string }[] = [
  { id: 'sales', name: 'Продажи', definition: 'Деньги, полученные за абонементы, подписки и пакеты, за вычетом возвратов', formula: 'Σ поступлений по начислениям − Σ возвратов за период', source: 'Журнал платежей', delay: 'Онлайн: пересчёт при открытии и каждые 60 секунд' },
  { id: 'inflow', name: 'Поступления', definition: 'Все деньги, пришедшие в клуб: продажи и прочие поступления', formula: 'Σ платежей «приход»', source: 'Журнал платежей', delay: 'Онлайн' },
  { id: 'expenses', name: 'Расходы', definition: 'Оплаченные расходы клуба', formula: 'Σ платежей «расход»', source: 'Журнал платежей', delay: 'Онлайн' },
  { id: 'plan', name: 'План', definition: 'План продаж на месяц по категориям. Устанавливает собственник или управляющий; менеджерам — управляющий', formula: 'Задан вручную; клиенты = сумма ÷ плановый средний чек', source: 'План продаж', delay: 'Сразу после сохранения' },
  { id: 'percent', name: 'Выполнение плана', definition: 'Какая доля месячного плана уже выполнена', formula: 'Факт ÷ план × 100 %. Без плана — «план не задан», не ноль', source: 'План и журнал платежей', delay: 'Онлайн' },
  { id: 'forecast', name: 'Прогноз на конец месяца', definition: 'Сколько будет к концу месяца, если продавать в том же темпе', formula: 'Факт ÷ прошедшие дни × дней в месяце', source: 'Журнал платежей', delay: 'Онлайн' },
  { id: 'deficit', name: 'Дефицит', definition: 'Сколько не хватит до плана при текущем темпе', formula: 'План − прогноз (если больше нуля)', source: 'План и журнал платежей', delay: 'Онлайн' },
  { id: 'day_plan', name: 'План на сегодня', definition: 'Сколько нужно продать сегодня, чтобы выйти на план', formula: '(План − факт до сегодня) ÷ оставшиеся дни, включая сегодня', source: 'План и журнал платежей', delay: 'Онлайн' },
  { id: 'light', name: 'Светофор', definition: 'Идёт ли менеджер в темпе плана', formula: 'Факт ÷ (план × прошедшая доля месяца): по умолчанию зелёный ≥ 100 %, жёлтый ≥ 85 %, красный ниже (пороги клуб меняет в нормах KPI)', source: 'План и журнал платежей', delay: 'Онлайн' },
  { id: 'clients', name: 'Продажи в клиентах', definition: 'Сколько клиентов купили абонемент, пакет или подписку (без гостевых визитов и расторгнутых)', formula: 'Число проданных абонементов', source: 'Абонементы', delay: 'Онлайн' },
  { id: 'leads', name: 'Лиды', definition: 'Новые обращения за период из всех каналов', formula: 'Число лидов', source: 'Лиды', delay: 'Онлайн' },
  { id: 'contacted', name: 'Связались', definition: 'Лиды, по которым менеджер выполнил первый контакт', formula: 'Лиды с отметкой первого ответа', source: 'Лиды и задачи', delay: 'Онлайн' },
  { id: 'meeting_set', name: 'Встреча назначена', definition: 'Лиды, которым после обращения назначили встречу', formula: 'Лиды, у клиента которых после обращения есть встреча', source: 'Встречи', delay: 'Онлайн' },
  { id: 'meeting_done', name: 'Встреча состоялась', definition: 'Лиды, которые пришли на встречу', formula: 'Лиды со встречей в статусе «состоялась»', source: 'Встречи', delay: 'Онлайн' },
  { id: 'bought', name: 'Покупка', definition: 'Лиды, которые купили абонемент, пакет или подписку после обращения', formula: 'Лиды, у клиента которых после обращения есть продажа (кроме гостевого визита)', source: 'Абонементы', delay: 'Онлайн' },
  { id: 'conversion', name: 'Конверсия в покупку', definition: 'Доля лидов, дошедших до покупки', formula: 'Покупки ÷ лиды × 100 %. Без лидов — «нет данных»', source: 'Лиды и абонементы', delay: 'Онлайн' },
  { id: 'visits', name: 'Посещения', definition: 'Проходы клиентов в клуб за день (повторный вход не считается)', formula: 'Число посещений', source: 'Посещения (турникет, ручной проход, перенос из 1С)', delay: 'Онлайн; при работе шлюза без интернета — после восстановления связи' },
  { id: 'calls', name: 'Звонки', definition: 'Выполненные задачи «позвонить» и «первый ответ». После подключения телефонии — фактические звонки', formula: 'Число выполненных задач', source: 'Задачи', delay: 'Онлайн' },
  { id: 'messages', name: 'Сообщения', definition: 'Сообщения, отправленные сотрудником клиентам в WhatsApp и Telegram', formula: 'Число исходящих сообщений сотрудника', source: 'Переписка', delay: 'Онлайн' },
  { id: 'meetings_set', name: 'Назначено встреч', definition: 'Встречи, назначенные сотрудником за период', formula: 'Число встреч', source: 'Встречи', delay: 'Онлайн' },
  { id: 'meetings_done', name: 'Проведено встреч', definition: 'Назначенные сотрудником встречи, которые состоялись', formula: 'Встречи в статусе «состоялась»', source: 'Встречи', delay: 'Онлайн' },
  { id: 'refusals', name: 'Отказы', definition: 'Сделки сотрудника, закрытые с отказом', formula: 'Число сделок со статусом «отказ»', source: 'Сделки', delay: 'Онлайн' },
  { id: 'tasks_done', name: 'Задач выполнено', definition: 'Все выполненные задачи сотрудника', formula: 'Число задач с отметкой выполнения', source: 'Задачи', delay: 'Онлайн' },
  { id: 'tasks_overdue', name: 'Просрочено задач', definition: 'Невыполненные задачи со сроком в прошлом на текущий момент', formula: 'Число открытых задач со сроком раньше текущего момента', source: 'Задачи', delay: 'Онлайн' },
  { id: 'first_response', name: 'Время до первого ответа', definition: 'Среднее время от поступления лида до первого контакта менеджера', formula: 'Среднее (первый ответ − поступление), минуты', source: 'Лиды', delay: 'Онлайн' },
  { id: 'debts', name: 'Долги', definition: 'Неоплаченные начисления со сроком в прошлом', formula: 'Σ просроченных начислений', source: 'Начисления', delay: 'Онлайн' },
];

/** Метрики KPI сотрудника и их подписи; нормы задаются клубом на один рабочий день */
export const KPI: { id: string; name: string; higherIsBetter: boolean }[] = [
  { id: 'calls', name: 'Звонки', higherIsBetter: true },
  { id: 'messages', name: 'Сообщения', higherIsBetter: true },
  { id: 'meetings_set', name: 'Назначено встреч', higherIsBetter: true },
  { id: 'meetings_done', name: 'Проведено встреч', higherIsBetter: true },
  { id: 'sales', name: 'Продажи, шт.', higherIsBetter: true },
  { id: 'refusals', name: 'Отказы', higherIsBetter: false },
  { id: 'tasks_done', name: 'Задач выполнено', higherIsBetter: true },
  { id: 'tasks_overdue', name: 'Просрочено задач', higherIsBetter: false },
  { id: 'first_response', name: 'Первый ответ, мин', higherIsBetter: false },
];
export const DEFAULT_NORMS: Record<string, number> = { calls: 40, messages: 20, meetings_set: 4, meetings_done: 3, sales: 1, tasks_overdue: 0, first_response: 5 };

/* ---------- виджеты рабочего стола (FR-DASH-01) ---------- */
type W = { id: string; title: string; description: string; perm: string; network?: boolean };
export const WIDGETS: W[] = [
  { id: 'day', title: 'Эффективность дня', description: 'Продажи, поступления, расходы, лиды, посещения сегодня и план-факт месяца', perm: P.dashView },
  { id: 'clubs', title: 'Сравнение клубов', description: 'Выручка, план, прогноз, конверсия и долги по каждому клубу', perm: P.dashView, network: true },
  { id: 'plan', title: 'План-факт месяца', description: 'По категориям продаж: план, факт, прогноз, дефицит, план на сегодня', perm: P.dashView },
  { id: 'team', title: 'План менеджеров', description: 'Личные планы, факт, прогноз и светофор по каждому менеджеру', perm: P.dashView },
  { id: 'funnel_sources', title: 'Конверсия по каналам', description: 'Лид → контакт → встреча → покупка по каждому рекламному каналу', perm: P.dashView },
  { id: 'funnel_managers', title: 'Конверсия по менеджерам', description: 'Лид → контакт → встреча → покупка по каждому менеджеру и в среднем', perm: P.dashView },
  { id: 'kpi', title: 'KPI сотрудников', description: 'Звонки, сообщения, встречи, продажи, отказы, задачи и первый ответ в сравнении с нормой', perm: P.dashView },
  { id: 'risks', title: 'Отклонения и риски', description: 'Пропущенные первые ответы, просроченные задачи, долги, неудачные автосписания, уходящие клиенты', perm: P.dashView },
  { id: 'my_plan', title: 'Мой план', description: 'Личный план на месяц и на сегодня, факт, процент, дефицит по категориям', perm: P.crmWork },
  { id: 'my_kpi', title: 'Мои показатели', description: 'Мои звонки, встречи, продажи и задачи за сегодня в сравнении с нормой', perm: P.crmWork },
];
const ROLE_DEFAULTS: Record<string, string[]> = {
  owner: ['day', 'clubs', 'plan', 'risks', 'funnel_sources'],
  gm: ['day', 'plan', 'team', 'risks', 'kpi'],
  rop: ['team', 'funnel_managers', 'funnel_sources', 'kpi', 'my_plan'],
  manager: ['my_plan', 'my_kpi'],
  fin: ['day', 'plan', 'risks'],
};
const available = (ctx: Ctx) => WIDGETS.filter((w) => can(ctx, w.perm) && (!w.network || ctx.allClubs));

/* ---------- общие вычисления ---------- */
type Club = { id: string; name: string; timezone: string };
const isMonth = (s?: string) => /^\d{4}-\d{2}$/.test(s ?? '');
const isDate = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a * 1000) / b) / 10 : null);

async function scope(db: Db, clubId?: string): Promise<Club[]> {
  const rows = (await db.query(`select id, name, timezone from clubs where status = 'active' and (($1::uuid is null and not is_demo) or id = $1) order by created_at`, [clubId && clubId !== 'all' ? clubId : null])).rows as Club[];
  if (clubId && clubId !== 'all' && !rows.length) throw badRequest('Клуб не найден');
  return rows;
}
async function today(db: Db, clubs: Club[]) {
  const tz = clubs[0]?.timezone ?? 'Europe/Moscow';
  return (await db.query(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz])).rows[0].d as string;
}
/** Месяц: границы, сколько дней прошло (включая сегодня) и сколько осталось */
export function monthInfo(month: string, t: string) {
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(days).padStart(2, '0')}`;
  const passed = t < from ? 0 : t > to ? days : daysBetween(from, t) + 1;
  return { from, to, days, passed, left: Math.max(0, days - passed + (t >= from && t <= to ? 1 : 0)), current: t >= from && t <= to, green: 1, yellow: 0.85 };
}
function period(q: { from?: string; to?: string }, t: string) {
  const from = isDate(q.from) ? q.from! : `${t.slice(0, 7)}-01`;
  const to = isDate(q.to) ? q.to! : t;
  if (from > to) throw badRequest('Начало периода позже конца');
  if (daysBetween(from, to) > 400) throw badRequest('Период не больше 400 дней');
  return { from, to, days: daysBetween(from, to) + 1 };
}

/** Факт продаж в деньгах по клубу, менеджеру-продавцу и категории за период (местные даты клуба).
 *  Менеджеру засчитываются оплаты проданных им абонементов; у подписки — только первый месяц, дальше это автосписание. */
export async function salesFact(db: Db, clubIds: string[], from: string, to: string) {
  return (await db.query(`
    select p.club_id as "clubId", m.created_by as "userId", coalesce(p.sale_category, 'new') as category,
      (m.kind = 'subscription' and coalesce(ch.due_on, (p.created_at at time zone c.timezone)::date) > (m.created_at at time zone c.timezone)::date + 3) as recurring,
      ((p.created_at at time zone c.timezone)::date = $4::date) as "isToday",
      sum(case when p.direction = 'in' then p.amount_kop else -p.amount_kop end)::bigint as kop
    from payments p join clubs c on c.id = p.club_id
      left join charges ch on ch.id = p.charge_id
      left join refunds r on r.id = p.refund_id
      left join memberships m on m.id = coalesce(ch.membership_id, r.membership_id)
    where p.kind in ('charge', 'refund') and p.club_id = any($1) and (p.created_at at time zone c.timezone)::date between $2 and $3
    group by 1, 2, 3, 4, 5`, [clubIds, from, to, to])).rows.map((r) => ({ ...r, kop: Number(r.kop) })) as
    { clubId: string; userId: string | null; category: string; recurring: boolean; isToday: boolean; kop: number }[];
}
export async function clientsFact(db: Db, clubIds: string[], from: string, to: string) {
  return (await db.query(`select m.club_id as "clubId", m.created_by as "userId", coalesce(m.sale_category, 'new') as category, count(*)::int as n
    from memberships m join clubs c on c.id = m.club_id
    where m.club_id = any($1) and m.kind <> 'guest' and m.status <> 'cancelled' and (m.created_at at time zone c.timezone)::date between $2 and $3
    group by 1, 2, 3`, [clubIds, from, to])).rows as { clubId: string; userId: string | null; category: string; n: number }[];
}
export async function targets(db: Db, clubIds: string[], month: string) {
  return (await db.query(`select club_id as "clubId", user_id as "userId", category, amount_kop::bigint as "amountKop", avg_check_kop::bigint as "avgCheckKop"
    from plan_targets where club_id = any($1) and month = $2`, [clubIds, `${month}-01`])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop), avgCheckKop: r.avgCheckKop == null ? null : Number(r.avgCheckKop) })) as
    { clubId: string; userId: string | null; category: string; amountKop: number; avgCheckKop: number | null }[];
}

type PlanRow = { category: string; name: string; planKop: number | null; factKop: number; todayKop: number; percent: number | null; forecastKop: number; deficitKop: number | null;
  dayPlanKop: number | null; planClients: number | null; factClients: number; light: 'green' | 'yellow' | 'red' | 'none' };
function light(fact: number, plan: number | null, mi: ReturnType<typeof monthInfo>): PlanRow['light'] {
  if (!plan) return 'none';
  const expected = plan * (mi.passed / mi.days);
  if (expected <= 0) return 'green';
  const r = fact / expected;
  return r >= mi.green ? 'green' : r >= mi.yellow ? 'yellow' : 'red';
}
/** План-факт по категориям для выбранного среза (клубы и, если задан, продавец) */
export function planFact(mi: ReturnType<typeof monthInfo>, tg: Awaited<ReturnType<typeof targets>>, sf: Awaited<ReturnType<typeof salesFact>>, cf: Awaited<ReturnType<typeof clientsFact>>,
  filter: { userId?: string | null }) {
  const personal = filter.userId !== undefined;
  const rows: PlanRow[] = CATS.map((cat) => {
    const t = tg.filter((x) => x.category === cat && (personal ? x.userId === filter.userId : x.userId === null));
    const planKop = t.length ? t.reduce((a, x) => a + x.amountKop, 0) : null;
    const avg = t.find((x) => x.avgCheckKop)?.avgCheckKop ?? null;
    const s = sf.filter((x) => x.category === cat && (!personal || (x.userId === filter.userId && !x.recurring)));
    const factKop = s.reduce((a, x) => a + x.kop, 0);
    const todayKop = s.filter((x) => x.isToday && mi.current).reduce((a, x) => a + x.kop, 0);
    const factClients = cf.filter((x) => x.category === cat && (!personal || x.userId === filter.userId)).reduce((a, x) => a + x.n, 0);
    const forecastKop = mi.passed ? Math.round((factKop / mi.passed) * mi.days / 100) * 100 : 0;
    const before = factKop - todayKop;
    return {
      category: cat, name: CAT_NAME[cat], planKop, factKop, todayKop, percent: planKop ? pct(factKop, planKop) : null, forecastKop,
      deficitKop: planKop === null ? null : Math.max(0, planKop - forecastKop),
      dayPlanKop: planKop === null || !mi.current ? null : Math.max(0, Math.round((planKop - before) / Math.max(1, mi.left) / 100) * 100),
      planClients: planKop !== null && avg ? Math.ceil(planKop / avg) : null, factClients, light: light(factKop, planKop, mi),
    };
  });
  const sum = (f: (r: PlanRow) => number | null) => { const v = rows.map(f).filter((x): x is number => x !== null); return v.length ? v.reduce((a, x) => a + x, 0) : null; };
  const planKop = sum((r) => r.planKop); const factKop = sum((r) => r.factKop) ?? 0;
  const forecastKop = sum((r) => r.forecastKop) ?? 0;
  const total = { planKop, factKop, todayKop: sum((r) => r.todayKop) ?? 0, percent: planKop ? pct(factKop, planKop) : null, forecastKop,
    deficitKop: planKop === null ? null : Math.max(0, planKop - forecastKop), dayPlanKop: sum((r) => r.dayPlanKop),
    planClients: sum((r) => r.planClients), factClients: sum((r) => r.factClients) ?? 0, light: light(factKop, planKop, mi) };
  return { rows: rows.filter((r) => r.planKop !== null || r.factKop !== 0 || r.factClients !== 0), total };
}

export async function salesStaff(db: Db, clubIds: string[]) {
  return (await db.query(`select distinct on (u.id, a.club_id) u.id, u.full_name as name, a.club_id as "clubId", a.role_code as role, r.name as "roleName"
    from user_assignments a join users u on u.id = a.user_id join roles r on r.code = a.role_code
    where a.club_id = any($1) and a.role_code = any($2) and u.status = 'active' and (a.active_to is null or a.active_to >= current_date)
    order by u.id, a.club_id, r.sort`, [clubIds, SALES_ROLES])).rows as { id: string; name: string; clubId: string; role: string; roleName: string }[];
}

/** Воронка лидов за период: лид → связались → встреча назначена → встреча состоялась → покупка */
export async function funnel(db: Db, clubIds: string[], from: string, to: string, by: 'source' | 'manager', userId?: string) {
  const rows = (await db.query(`
    with l as (
      select l.id, l.club_id, l.person_id, l.created_at, l.assigned_to, l.first_response_at,
        coalesce(s.name, 'Без источника') as source
      from leads l join clubs c on c.id = l.club_id left join lead_sources s on s.id = l.source_id
      where l.club_id = any($1) and (l.created_at at time zone c.timezone)::date between $2 and $3 and ($4::uuid is null or l.assigned_to = $4)
    )
    select ${by === 'source' ? 'l.source' : `coalesce(u.full_name, 'Не назначен')`} as name, ${by === 'source' ? 'null' : 'l.assigned_to'} as "userId",
      count(*)::int as leads,
      count(*) filter (where l.first_response_at is not null)::int as contacted,
      count(*) filter (where exists (select 1 from meetings m where m.person_id = l.person_id and m.club_id = l.club_id and m.created_at >= l.created_at))::int as "meetingSet",
      count(*) filter (where exists (select 1 from meetings m where m.person_id = l.person_id and m.club_id = l.club_id and m.created_at >= l.created_at and m.status = 'attended'))::int as "meetingDone",
      count(*) filter (where exists (select 1 from memberships ms where ms.person_id = l.person_id and ms.club_id = l.club_id and ms.created_at >= l.created_at and ms.kind <> 'guest' and ms.status <> 'cancelled'))::int as bought
    from l left join users u on u.id = l.assigned_to
    group by 1, 2 order by 3 desc`, [clubIds, from, to, userId ?? null])).rows as { name: string; userId: string | null; leads: number; contacted: number; meetingSet: number; meetingDone: number; bought: number }[];
  const conv = <R extends { leads: number; contacted: number; meetingSet: number; meetingDone: number; bought: number }>(r: R) => ({
    ...r, contactedPct: pct(r.contacted, r.leads), meetingSetPct: pct(r.meetingSet, r.leads), meetingDonePct: pct(r.meetingDone, r.leads), boughtPct: pct(r.bought, r.leads),
  });
  const t = rows.reduce((a, r) => ({ leads: a.leads + r.leads, contacted: a.contacted + r.contacted, meetingSet: a.meetingSet + r.meetingSet, meetingDone: a.meetingDone + r.meetingDone, bought: a.bought + r.bought }),
    { leads: 0, contacted: 0, meetingSet: 0, meetingDone: 0, bought: 0 });
  return { rows: rows.map(conv), total: conv({ name: by === 'source' ? 'Все каналы' : 'В среднем по отделу', userId: null, ...t }) };
}

/** KPI сотрудников за период; нормы — на рабочий день, умножаются на число дней периода */
export async function kpi(db: Db, clubIds: string[], from: string, to: string, userIds: string[]) {
  if (!userIds.length) return [];
  const q = async (sql: string) => new Map((await db.query(sql, [clubIds, from, to, userIds])).rows.map((r) => [r.u as string, Number(r.v)]));
  const local = (col: string) => `(${col} at time zone c.timezone)::date between $2 and $3`;
  const [calls, messages, mSet, mDone, sales, refusals, tDone, tOver, fr] = await Promise.all([
    q(`select t.assignee_id as u, count(*) as v from tasks t join clubs c on c.id = t.club_id where t.club_id = any($1) and t.assignee_id = any($4) and t.kind in ('call', 'first_response') and t.done_at is not null and ${local('t.done_at')} group by 1`),
    q(`select m.author_id as u, count(*) as v from msg_messages m join clubs c on c.id = m.club_id where m.club_id = any($1) and m.author_id = any($4) and m.direction = 'out' and ${local('m.created_at')} group by 1`),
    q(`select m.created_by as u, count(*) as v from meetings m join clubs c on c.id = m.club_id where m.club_id = any($1) and m.created_by = any($4) and ${local('m.created_at')} group by 1`),
    q(`select m.created_by as u, count(*) as v from meetings m join clubs c on c.id = m.club_id where m.club_id = any($1) and m.created_by = any($4) and m.status = 'attended' and ${local('m.scheduled_at')} group by 1`),
    q(`select m.created_by as u, count(*) as v from memberships m join clubs c on c.id = m.club_id where m.club_id = any($1) and m.created_by = any($4) and m.kind <> 'guest' and m.status <> 'cancelled' and ${local('m.created_at')} group by 1`),
    q(`select o.owner_id as u, count(*) as v from opportunities o join clubs c on c.id = o.club_id where o.club_id = any($1) and o.owner_id = any($4) and o.status = 'lost' and o.closed_at is not null and ${local('o.closed_at')} group by 1`),
    q(`select t.assignee_id as u, count(*) as v from tasks t join clubs c on c.id = t.club_id where t.club_id = any($1) and t.assignee_id = any($4) and t.done_at is not null and ${local('t.done_at')} group by 1`),
    q(`select t.assignee_id as u, count(*) as v from tasks t where t.club_id = any($1) and t.assignee_id = any($4) and t.done_at is null and t.due_at < now() and $2::date is not null and $3::date is not null group by 1`),
    q(`select l.assigned_to as u, round(avg(extract(epoch from (l.first_response_at - l.created_at)) / 60)::numeric, 1) as v from leads l join clubs c on c.id = l.club_id
       where l.club_id = any($1) and l.assigned_to = any($4) and l.first_response_at is not null and ${local('l.created_at')} group by 1`),
  ]);
  const src: Record<string, Map<string, number>> = { calls, messages, meetings_set: mSet, meetings_done: mDone, sales, refusals, tasks_done: tDone, tasks_overdue: tOver, first_response: fr };
  return userIds.map((u) => ({ userId: u, values: Object.fromEntries(KPI.map((k) => [k.id, k.id === 'first_response' ? (src[k.id].get(u) ?? null) : (src[k.id].get(u) ?? 0)])) as Record<string, number | null> }));
}
export async function norms(db: Db, clubIds: string[]) {
  const rows = (await db.query('select club_id as "clubId", metric, per_day::float as v from kpi_norms where club_id = any($1)', [clubIds])).rows as { clubId: string; metric: string; v: number }[];
  const out: Record<string, Record<string, number | null>> = {};
  for (const c of clubIds) out[c] = Object.fromEntries(KPI.map((k) => [k.id, rows.find((r) => r.clubId === c && r.metric === k.id)?.v ?? DEFAULT_NORMS[k.id] ?? null]));
  return out;
}
/** Пороги светофора клуба (FR-AI-11): доля от плана на сегодня, выше которой «зелёный» и «жёлтый». Задаются в «Нормы KPI» */
export const LIGHT_DEFAULT = { green: 100, yellow: 85 };
export async function lightOf(db: Db, clubIds: string[]) {
  if (clubIds.length !== 1) return { green: LIGHT_DEFAULT.green / 100, yellow: LIGHT_DEFAULT.yellow / 100 };
  const r = (await db.query(`select metric, per_day::float as v from kpi_norms where club_id = $1 and metric in ('light_green', 'light_yellow')`, [clubIds[0]])).rows;
  const v = (m: string, d: number) => (r.find((x) => x.metric === m)?.v ?? d) / 100;
  return { green: v('light_green', LIGHT_DEFAULT.green), yellow: v('light_yellow', LIGHT_DEFAULT.yellow) };
}
/** Норма за период: суммарные показатели × дни; «просрочено» и «первый ответ» — не накапливаются */
export const normFor = (metric: string, perDay: number | null, days: number) => (perDay === null ? null : ['tasks_overdue', 'first_response'].includes(metric) ? perDay : Math.round(perDay * days * 10) / 10);
export function kpiStatus(metric: string, value: number | null, norm: number | null) {
  if (value === null || norm === null) return 'none';
  const k = KPI.find((x) => x.id === metric)!;
  if (k.higherIsBetter) return norm === 0 ? 'green' : value >= norm ? 'green' : value >= norm * 0.7 ? 'yellow' : 'red';
  return value <= norm ? 'green' : value <= norm * 1.5 + 1 ? 'yellow' : 'red';
}

/* ---------- виджеты ---------- */
type Q = { clubId?: string; month?: string; from?: string; to?: string };
export async function widgetData(db: Db, ctx: Ctx, id: string, q: Q) {
  const w = available(ctx).find((x) => x.id === id);
  if (!w) throw forbidden('Этот виджет вам недоступен');
  const clubs = await scope(db, q.clubId);
  const ids = clubs.map((c) => c.id);
  const t = await today(db, clubs);
  const month = isMonth(q.month) ? q.month! : t.slice(0, 7);
  const mi = { ...monthInfo(month, t), ...(await lightOf(db, ids)) };
  const base = { widget: id, title: w.title, updatedAt: new Date().toISOString(), today: t, month, clubs: clubs.map((c) => ({ id: c.id, name: c.name })) };

  if (id === 'day' || id === 'clubs') {
    const per = await Promise.all(clubs.map(async (c) => {
      const d = (await db.query(`
        select
          (select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) from payments where club_id = $1 and kind in ('charge', 'refund') and (created_at at time zone $2)::date = $3::date)::bigint as sales,
          (select coalesce(sum(amount_kop), 0) from payments where club_id = $1 and direction = 'in' and (created_at at time zone $2)::date = $3::date)::bigint as inflow,
          (select coalesce(sum(amount_kop), 0) from payments where club_id = $1 and kind = 'expense' and (created_at at time zone $2)::date = $3::date)::bigint as expenses,
          (select count(*) from memberships where club_id = $1 and kind <> 'guest' and status <> 'cancelled' and (created_at at time zone $2)::date = $3::date)::int as "salesCount",
          (select count(*) from leads where club_id = $1 and (created_at at time zone $2)::date = $3::date)::int as leads,
          (select count(*) from meetings where club_id = $1 and (scheduled_at at time zone $2)::date = $3::date and status <> 'cancelled')::int as meetings,
          (select count(*) from visits where club_id = $1 and (visited_at at time zone $2)::date = $3::date)::int as visits,
          (select count(*) > 0 from visits where club_id = $1) or (select count(*) > 0 from access_gateways where club_id = $1) as "hasVisits",
          (select coalesce(sum(amount_kop), 0) from charges where club_id = $1 and status = 'due' and due_on < $3::date)::bigint as debts,
          (select count(*) from leads where club_id = $1 and (created_at at time zone $2)::date between $4 and $3)::int as "monthLeads"`,
      [c.id, c.timezone, t, mi.from])).rows[0];
      const f = await funnel(db, [c.id], mi.from, t, 'source');
      return { clubId: c.id, name: c.name, salesKop: Number(d.sales), inflowKop: Number(d.inflow), expensesKop: Number(d.expenses), salesCount: d.salesCount, leads: d.leads,
        meetings: d.meetings, visits: d.hasVisits ? d.visits : null, debtsKop: Number(d.debts), conversion: f.total.boughtPct };
    }));
    const [tg, sf, cf] = await Promise.all([targets(db, ids, month), salesFact(db, ids, mi.from, mi.current ? t : mi.to), clientsFact(db, ids, mi.from, mi.current ? t : mi.to)]);
    const byClub = clubs.map((c) => ({ clubId: c.id, ...planFact(mi, tg.filter((x) => x.clubId === c.id), sf.filter((x) => x.clubId === c.id), cf.filter((x) => x.clubId === c.id), {}).total }));
    const total = planFact(mi, tg, sf, cf, {}).total;
    const sum = (k: 'salesKop' | 'inflowKop' | 'expensesKop' | 'salesCount' | 'leads' | 'meetings' | 'debtsKop') => per.reduce((a, x) => a + x[k], 0);
    const visits = per.some((x) => x.visits !== null) ? per.reduce((a, x) => a + (x.visits ?? 0), 0) : null;
    const allF = await funnel(db, ids, mi.from, t, 'source');
    return { ...base, day: { salesKop: sum('salesKop'), inflowKop: sum('inflowKop'), expensesKop: sum('expensesKop'), salesCount: sum('salesCount'), leads: sum('leads'), meetings: sum('meetings'), visits, debtsKop: sum('debtsKop'), conversion: allF.total.boughtPct },
      monthPlan: total, perClub: per.map((p) => ({ ...p, ...byClub.find((b) => b.clubId === p.clubId) })) };
  }

  if (id === 'plan' || id === 'my_plan') {
    const [tg, sf, cf] = await Promise.all([targets(db, ids, month), salesFact(db, ids, mi.from, mi.current ? t : mi.to), clientsFact(db, ids, mi.from, mi.current ? t : mi.to)]);
    const pf = planFact(mi, tg, sf, cf, id === 'my_plan' ? { userId: ctx.userId } : {});
    return { ...base, daysInMonth: mi.days, daysPassed: mi.passed, ...pf, personal: id === 'my_plan' };
  }

  if (id === 'team') {
    const [tg, sf, cf, staff] = await Promise.all([targets(db, ids, month), salesFact(db, ids, mi.from, mi.current ? t : mi.to), clientsFact(db, ids, mi.from, mi.current ? t : mi.to), salesStaff(db, ids)]);
    const users = [...new Map(staff.map((s) => [s.id, s])).values()];
    const rows = users.map((u) => ({ userId: u.id, name: u.name, role: u.roleName, club: clubs.find((c) => c.id === u.clubId)?.name, ...planFact(mi, tg, sf, cf, { userId: u.id }).total }))
      .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
    return { ...base, daysInMonth: mi.days, daysPassed: mi.passed, rows };
  }

  if (id === 'funnel_sources' || id === 'funnel_managers') {
    const p = period(q, t);
    return { ...base, from: p.from, to: p.to, ...(await funnel(db, ids, p.from, p.to, id === 'funnel_sources' ? 'source' : 'manager')) };
  }

  if (id === 'kpi' || id === 'my_kpi') {
    const p = id === 'my_kpi' ? { from: t, to: t, days: 0 } : period(q, t);
    p.days = daysBetween(p.from, p.to) + 1;
    const staff = id === 'my_kpi' ? [{ id: ctx.userId!, name: 'Я', clubId: ids[0] }] : await salesStaff(db, ids);
    const users = [...new Map(staff.map((s) => [s.id, s])).values()];
    const vals = await kpi(db, ids, p.from, p.to, users.map((u) => u.id));
    const nm = await norms(db, ids);
    const rows = users.map((u) => {
      const v = vals.find((x) => x.userId === u.id)!.values;
      return { userId: u.id, name: u.name, club: clubs.find((c) => c.id === u.clubId)?.name,
        metrics: KPI.map((k) => { const norm = normFor(k.id, nm[u.clubId]?.[k.id] ?? null, p.days); return { id: k.id, name: k.name, value: v[k.id], norm, status: kpiStatus(k.id, v[k.id], norm) }; }) };
    });
    return { ...base, from: p.from, to: p.to, days: p.days, metrics: KPI, rows };
  }

  if (id === 'risks') {
    const per = await Promise.all(clubs.map(async (c) => {
      const r = (await db.query(`
        select
          (select count(*) from leads where club_id = $1 and first_response_at is null and first_response_due_at < now())::int as "missedResponse",
          (select count(*) from tasks where club_id = $1 and done_at is null and due_at < now())::int as "overdueTasks",
          (select count(*) from charges where club_id = $1 and status = 'due' and due_on < $2::date)::int as "debtsCount",
          (select coalesce(sum(amount_kop), 0) from charges where club_id = $1 and status = 'due' and due_on < $2::date)::bigint as "debtsKop",
          (select count(*) from charges where club_id = $1 and status = 'due' and autopay_error is not null)::int as "autopayFailed",
          (select count(*) from memberships m where m.club_id = $1 and m.status = 'active' and m.kind = 'term' and m.ends_on between $2::date and $2::date + 14
             and not exists (select 1 from memberships n where n.renewed_from_id = m.id))::int as "endingSoon",
          (select count(distinct m.person_id) from memberships m where m.club_id = $1 and m.status = 'active' and m.starts_on <= $2::date - 14 and coalesce(m.ends_on, $2::date) >= $2::date
             and not exists (select 1 from visits v where v.person_id = m.person_id and v.visited_at > now() - interval '14 days'))::int as "noVisits",
          (select count(*) > 0 from visits where club_id = $1) or (select count(*) > 0 from access_gateways where club_id = $1) as "hasVisits"`, [c.id, t])).rows[0];
      return { clubId: c.id, name: c.name, ...r, debtsKop: Number(r.debtsKop), noVisits: r.hasVisits ? r.noVisits : null };
    }));
    const items = [
      { id: 'missedResponse', title: 'Лиды без первого ответа сверх нормы', hint: 'Откройте «Лиды»: просроченные выделены красным' },
      { id: 'overdueTasks', title: 'Просроченные задачи', hint: '«Задачи» → фильтр «просрочено»' },
      { id: 'debtsCount', title: 'Просроченные платежи клиентов', hint: '«Финансы» → «Долги»', money: 'debtsKop' },
      { id: 'autopayFailed', title: 'Неудачные автосписания подписки', hint: 'Причина в карточке клиента; отправьте ссылку на оплату' },
      { id: 'endingSoon', title: 'Абонементы заканчиваются в ближайшие 14 дней, продления нет', hint: 'Кандидаты в план продлений' },
      { id: 'noVisits', title: 'Действующие клиенты не ходят 14+ дней', hint: 'Риск ухода: позвонить, пригласить на тренировку' },
    ].map((it) => {
      const vals = per.map((p) => (p as unknown as Record<string, number | null>)[it.id]);
      const value = vals.every((v) => v === null) ? null : vals.reduce((a: number, v) => a + (v ?? 0), 0);
      return { ...it, value, moneyKop: it.money ? per.reduce((a, p) => a + p.debtsKop, 0) : null, perClub: per.map((p) => ({ name: p.name, value: (p as unknown as Record<string, number | null>)[it.id] })) };
    });
    return { ...base, items };
  }
  throw badRequest('Неизвестный виджет');
}

/* ---------- таблицы для выгрузки ---------- */
const rub = (kop: number | null) => (kop === null ? null : Math.round(kop) / 100);
const LIGHT: Record<string, string> = { green: 'зелёный', yellow: 'жёлтый', red: 'красный', none: 'план не задан' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function widgetTable(d: any): Table {
  const title = d.title as string;
  if (d.widget === 'day' || d.widget === 'clubs') return { title, columns: ['Клуб', 'Продажи сегодня, ₽', 'Поступления, ₽', 'Расходы, ₽', 'Лиды', 'Встречи', 'Посещения', 'План месяца, ₽', 'Факт месяца, ₽', 'Выполнение, %', 'Прогноз, ₽', 'Конверсия, %', 'Долги, ₽'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: d.perClub.map((c: any) => [c.name, rub(c.salesKop), rub(c.inflowKop), rub(c.expensesKop), c.leads, c.meetings, c.visits, rub(c.planKop), rub(c.factKop), c.percent, rub(c.forecastKop), c.conversion, rub(c.debtsKop)]) };
  if (d.widget === 'plan' || d.widget === 'my_plan') return { title: `${title} ${d.month}`, columns: ['Категория', 'План, ₽', 'Факт, ₽', 'Выполнение, %', 'Прогноз, ₽', 'Дефицит, ₽', 'План на сегодня, ₽', 'План, клиентов', 'Факт, клиентов'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: [...d.rows.map((r: any) => [r.name, rub(r.planKop), rub(r.factKop), r.percent, rub(r.forecastKop), rub(r.deficitKop), rub(r.dayPlanKop), r.planClients, r.factClients]),
      ['Итого', rub(d.total.planKop), rub(d.total.factKop), d.total.percent, rub(d.total.forecastKop), rub(d.total.deficitKop), rub(d.total.dayPlanKop), d.total.planClients, d.total.factClients]] };
  if (d.widget === 'team') return { title: `${title} ${d.month}`, columns: ['Менеджер', 'Клуб', 'План, ₽', 'Факт, ₽', 'Выполнение, %', 'Прогноз, ₽', 'Дефицит, ₽', 'План на сегодня, ₽', 'Клиентов', 'Светофор'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: d.rows.map((r: any) => [r.name, r.club, rub(r.planKop), rub(r.factKop), r.percent, rub(r.forecastKop), rub(r.deficitKop), rub(r.dayPlanKop), r.factClients, LIGHT[r.light]]) };
  if (d.widget === 'funnel_sources' || d.widget === 'funnel_managers') return { title: `${title} ${d.from}–${d.to}`, columns: [d.widget === 'funnel_sources' ? 'Канал' : 'Менеджер', 'Лиды', 'Связались', 'Встреча назначена', 'Встреча состоялась', 'Покупка', 'Конверсия в покупку, %'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: [...d.rows, d.total].map((r: any) => [r.name, r.leads, r.contacted, r.meetingSet, r.meetingDone, r.bought, r.boughtPct]) };
  if (d.widget === 'kpi' || d.widget === 'my_kpi') return { title: `${title} ${d.from}–${d.to}`, columns: ['Сотрудник', ...KPI.flatMap((k) => [k.name, `${k.name}: норма`])],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: d.rows.map((r: any) => [r.name, ...r.metrics.flatMap((m: any) => [m.value, m.norm])]) };
  if (d.widget === 'risks') return { title, columns: ['Показатель', 'Значение', 'Сумма, ₽', 'Что делать'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: d.items.map((i: any) => [i.title, i.value, rub(i.moneyKop), i.hint]) };
  return { title, columns: [], rows: [] };
}

export async function sendTable(reply: FastifyReply, t: Table, format: string, name: string) {
  const safe = encodeURIComponent(name);
  if (format === 'xlsx') {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="report.xlsx"; filename*=UTF-8''${safe}.xlsx`);
    return reply.send(toXlsx(t));
  }
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="report.csv"; filename*=UTF-8''${safe}.csv`);
  return reply.send(toCsv(t));
}

/* ---------- маршруты ---------- */
export function dashRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/dash/layout', async (req) => {
    const ctx = requireCtx(req);
    const av = available(ctx);
    return withCtx(pool, ctx, async (db) => {
      const own = (await db.query('select widgets from dash_layouts where user_id = $1', [ctx.userId])).rows[0]?.widgets as string[] | undefined;
      const roleRows = (await db.query('select role_code, widgets from dash_role_layouts where role_code = any($1)', [ctx.roles])).rows;
      const roleCode = ['owner', 'gm', 'rop', 'fin', 'manager', 'admin', 'desk', 'trainer'].find((r) => ctx.roles.includes(r)) ?? ctx.roles[0];
      const roleDefault = (roleRows.find((r) => r.role_code === roleCode)?.widgets as string[] | undefined) ?? ROLE_DEFAULTS[roleCode] ?? av.slice(0, 3).map((w) => w.id);
      const ok = (ids: string[]) => ids.filter((x) => av.some((w) => w.id === x));
      return { widgets: ok(own ?? roleDefault), custom: !!own, role: roleCode, available: av.map(({ id, title, description }) => ({ id, title, description })),
        canSetRoleDefaults: can(ctx, P.planManage) && ctx.allClubs, roles: Object.keys(ROLE_DEFAULTS) };
    });
  });

  app.put('/api/dash/layout', async (req) => {
    const ctx = requireCtx(req);
    const { widgets } = (req.body ?? {}) as { widgets?: string[] | null };
    return withCtx(pool, ctx, async (db) => {
      if (widgets === null) { await db.query('delete from dash_layouts where user_id = $1', [ctx.userId]); return { ok: true }; }
      if (!Array.isArray(widgets) || widgets.some((w) => !available(ctx).some((a) => a.id === w))) throw badRequest('Неизвестный или недоступный виджет');
      await db.query(`insert into dash_layouts(user_id, tenant_id, widgets) values ($1,$2,$3) on conflict (user_id) do update set widgets = excluded.widgets, updated_at = now()`,
        [ctx.userId, ctx.tenantId, [...new Set(widgets)]]);
      return { ok: true };
    });
  });

  app.put('/api/dash/role-layout', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.planManage) || !ctx.allClubs) throw forbidden('Стандартные рабочие столы ролей задаёт руководитель сети');
    const { role, widgets } = (req.body ?? {}) as { role?: string; widgets?: string[] };
    if (!role || !(role in ROLE_DEFAULTS)) throw badRequest('Выберите роль');
    if (!Array.isArray(widgets) || widgets.some((w) => !WIDGETS.some((a) => a.id === w))) throw badRequest('Неизвестный виджет');
    return withCtx(pool, ctx, async (db) => {
      await db.query(`insert into dash_role_layouts(tenant_id, role_code, widgets, updated_by) values ($1,$2,$3,$4)
        on conflict (tenant_id, role_code) do update set widgets = excluded.widgets, updated_by = excluded.updated_by, updated_at = now()`, [ctx.tenantId, role, [...new Set(widgets)], ctx.userId]);
      await audit(db, ctx, 'dash.role_layout_changed', 'role', role, null, { widgets });
      return { ok: true };
    });
  });

  app.get('/api/dash/widget/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => widgetData(db, ctx, id, req.query as Q));
  });

  app.get('/api/dash/widget/:id/export', async (req, reply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const q = req.query as Q & { format?: string };
    const t = await withCtx(pool, ctx, async (db) => {
      const d = await widgetData(db, ctx, id, q);
      await audit(db, ctx, 'report.exported', 'widget', id, null, { format: q.format ?? 'csv', clubId: q.clubId ?? null, month: q.month ?? null, from: q.from ?? null, to: q.to ?? null });
      return widgetTable(d);
    });
    return sendTable(reply, t, q.format ?? 'csv', t.title);
  });

  app.get('/api/dash/metrics', async (req) => { requireCtx(req); return METRICS; });

  /* --- план продаж: клуб и менеджеры --- */
  app.get('/api/plans', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.dashView) && !can(ctx, P.planManage)) throw forbidden();
    const { clubId, month } = req.query as { clubId?: string; month?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const clubs = await scope(db, clubId);
      const t = await today(db, clubs);
      const m = isMonth(month) ? month! : t.slice(0, 7);
      const tg = await targets(db, [clubId], m);
      const staff = await salesStaff(db, [clubId]);
      const pack = (userId: string | null) => Object.fromEntries(CATS.map((c) => { const x = tg.find((r) => r.userId === userId && r.category === c); return [c, x ? { amountKop: x.amountKop, avgCheckKop: x.avgCheckKop } : null]; }));
      // Подсказка среднего чека: средняя цена проданных за 90 дней абонементов категории
      const avg = (await db.query(`select coalesce(sale_category, 'new') as c, (round(avg(amount_kop) / 100) * 100)::bigint as a from memberships
        where club_id = $1 and kind <> 'guest' and created_at > now() - interval '90 days' group by 1`, [clubId])).rows;
      return { month: m, categories: CATS.map((c) => ({ id: c, name: CAT_NAME[c], suggestedAvgCheckKop: avg.find((a) => a.c === c) ? Number(avg.find((a) => a.c === c)!.a) : null })),
        club: pack(null), managers: staff.map((s) => ({ userId: s.id, name: s.name, role: s.roleName, targets: pack(s.id) })), canEdit: can(ctx, P.planManage) };
    });
  });

  app.put('/api/plans', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.planManage)) throw forbidden('План устанавливает собственник или управляющий');
    type T = Record<string, { amountKop: number; avgCheckKop?: number | null } | null>;
    const b = (req.body ?? {}) as { clubId?: string; month?: string; club?: T; managers?: Record<string, T> };
    if (!b.clubId || !isMonth(b.month)) throw badRequest('Выберите клуб и месяц');
    return withCtx(pool, ctx, async (db) => {
      await scope(db, b.clubId);
      const staff = new Set((await salesStaff(db, [b.clubId!])).map((s) => s.id));
      for (const u of Object.keys(b.managers ?? {})) if (!staff.has(u)) throw badRequest('Сотрудник не работает в отделе продаж этого клуба');
      const save = async (userId: string | null, tt: T | undefined) => {
        for (const [cat, v] of Object.entries(tt ?? {})) {
          if (!CATS.includes(cat as typeof CATS[number])) throw badRequest('Неизвестная категория плана');
          if (v === null) { await db.query(`delete from plan_targets where club_id = $1 and month = $2 and category = $3 and user_id is not distinct from $4`, [b.clubId, `${b.month}-01`, cat, userId]); continue; }
          if (!Number.isInteger(v.amountKop) || v.amountKop < 0) throw badRequest('Сумма плана указана неверно');
          if (v.avgCheckKop != null && (!Number.isInteger(v.avgCheckKop) || v.avgCheckKop <= 0)) throw badRequest('Средний чек указан неверно');
          await db.query(`insert into plan_targets(tenant_id, club_id, month, user_id, category, amount_kop, avg_check_kop, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
            on conflict (club_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
            do update set amount_kop = excluded.amount_kop, avg_check_kop = excluded.avg_check_kop, updated_by = excluded.updated_by, updated_at = now()`,
          [ctx.tenantId, b.clubId, `${b.month}-01`, userId, cat, v.amountKop, v.avgCheckKop ?? null, ctx.userId]);
        }
      };
      await save(null, b.club);
      for (const [u, tt] of Object.entries(b.managers ?? {})) await save(u, tt);
      await audit(db, ctx, 'plan.changed', 'club', b.clubId!, null, { month: b.month, club: b.club ?? null, managers: b.managers ?? null });
      return { ok: true };
    });
  });

  /* --- нормы KPI --- */
  app.get('/api/kpi-norms', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.dashView) && !can(ctx, P.crmWork)) throw forbidden();
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      await scope(db, clubId);
      const l = await lightOf(db, [clubId]);
      return { metrics: KPI, norms: (await norms(db, [clubId]))[clubId], light: { green: Math.round(l.green * 100), yellow: Math.round(l.yellow * 100) }, canEdit: can(ctx, P.planManage) };
    });
  });
  app.put('/api/kpi-norms', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.planManage)) throw forbidden();
    const b = (req.body ?? {}) as { clubId?: string; norms?: Record<string, number>; light?: { green?: number; yellow?: number } };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (b.light) {
      const { green, yellow } = b.light;
      if (!Number.isInteger(green) || !Number.isInteger(yellow) || yellow! < 1 || green! > 200 || yellow! >= green!) throw badRequest('Пороги светофора: жёлтый меньше зелёного, от 1 до 200 %');
    }
    return withCtx(pool, ctx, async (db) => {
      await scope(db, b.clubId);
      for (const [k, v] of Object.entries(b.norms ?? {})) {
        if (!KPI.some((x) => x.id === k) || typeof v !== 'number' || !(v >= 0) || v > 10000) throw badRequest('Норма указана неверно');
        await db.query(`insert into kpi_norms(tenant_id, club_id, metric, per_day, updated_by) values ($1,$2,$3,$4,$5)
          on conflict (club_id, metric) do update set per_day = excluded.per_day, updated_by = excluded.updated_by, updated_at = now()`, [ctx.tenantId, b.clubId, k, v, ctx.userId]);
      }
      if (b.light) for (const [m, v] of [['light_green', b.light.green], ['light_yellow', b.light.yellow]] as const)
        await db.query(`insert into kpi_norms(tenant_id, club_id, metric, per_day, updated_by) values ($1,$2,$3,$4,$5)
          on conflict (club_id, metric) do update set per_day = excluded.per_day, updated_by = excluded.updated_by, updated_at = now()`, [ctx.tenantId, b.clubId, m, v, ctx.userId]);
      await audit(db, ctx, 'kpi.norms_changed', 'club', b.clubId!, null, { ...(b.norms ?? {}), light: b.light });
      return { ok: true };
    });
  });

  /* --- выгрузка факта продаж по параметрам (FR-PLAN-09) --- */
  app.get('/api/reports/sales', async (req, reply) => {
    const ctx = requireCtx(req);
    const own = !can(ctx, P.dashView) && !can(ctx, P.financeView);
    if (own && !can(ctx, P.crmWork)) throw forbidden();
    const q = req.query as { clubId?: string; from?: string; to?: string; userId?: string; category?: string; format?: string };
    const res = await withCtx(pool, ctx, async (db) => {
      const clubs = await scope(db, q.clubId);
      const p = period(q, await today(db, clubs));
      const userId = own ? ctx.userId : q.userId || null;
      const rows = (await db.query(`
        select to_char(p.created_at at time zone c.timezone, 'YYYY-MM-DD HH24:MI') as at, c.name as club, coalesce(pp.full_name, '—') as person, m.product_name as product,
          coalesce(p.sale_category, 'new') as category, coalesce(u.full_name, '—') as seller,
          (case when p.direction = 'in' then p.amount_kop else -p.amount_kop end)::bigint as kop, p.method, p.kind
        from payments p join clubs c on c.id = p.club_id
          left join charges ch on ch.id = p.charge_id left join refunds r on r.id = p.refund_id
          left join memberships m on m.id = coalesce(ch.membership_id, r.membership_id)
          left join users u on u.id = m.created_by left join persons pp on pp.id = p.person_id
        where p.kind in ('charge', 'refund') and p.club_id = any($1) and (p.created_at at time zone c.timezone)::date between $2 and $3
          and ($4::uuid is null or m.created_by = $4) and ($5::text is null or p.sale_category = $5)
        order by p.created_at limit 20000`, [clubs.map((c) => c.id), p.from, p.to, userId, q.category || null])).rows;
      if (q.format === 'csv' || q.format === 'xlsx') await audit(db, ctx, 'report.exported', 'report', 'sales', null, { ...q, userId });
      return { from: p.from, to: p.to, rows: rows.map((r) => ({ ...r, amountKop: Number(r.kop), categoryName: CAT_NAME[r.category] ?? r.category })) };
    });
    if (q.format === 'csv' || q.format === 'xlsx') {
      const METHOD: Record<string, string> = { cash: 'наличные', card_terminal: 'карта (терминал)', sbp: 'СБП', online: 'онлайн', bank_transfer: 'перевод' };
      const t: Table = { title: `Продажи ${res.from}–${res.to}`, columns: ['Дата и время', 'Клуб', 'Клиент', 'Тариф', 'Категория', 'Менеджер', 'Сумма, ₽', 'Способ', 'Операция'],
        rows: res.rows.map((r) => [r.at, r.club, r.person, r.product, r.categoryName, r.seller, r.amountKop / 100, METHOD[r.method] ?? r.method, r.kind === 'refund' ? 'возврат' : 'оплата'] as Cell[]) };
      return sendTable(reply, t, q.format, t.title);
    }
    return { ...res, total: res.rows.reduce((a, r) => a + r.amountKop, 0) };
  });
}

