// Рабочие столы ролей: окна «состояние дел» для управляющего, собственника, РОПа, менеджера, ресепшн, финансиста, тренера и администратора системы.
// Каждое окно — плитки и списки; у каждой плитки и строки есть переход (go: раздел и фильтр) или карточка клиента (personId).
import type { Ctx, Db } from '../db.ts';

export type Go = { tab: string; p?: Record<string, string> };
export type Tile = { label: string; value: number | string; sub?: string; tone?: 'ok' | 'warn' | 'bad'; go?: Go; money?: boolean };
export type Row = { text: string; sub?: string; right?: string; tone?: 'ok' | 'warn' | 'bad'; go?: Go; personId?: string };
export type Panel = { tiles: Tile[]; lists: { title: string; rows: Row[]; empty: string; more?: Go }[] };
type Club = { id: string; name: string; timezone: string };

// Сегодня по времени клуба
const TODAY = (col: string) => `(${col} at time zone c.timezone)::date = (now() at time zone c.timezone)::date`;
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;
const hhmm = (d: Date, tz: string) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
const bad = (n: number, warnOnly = false) => (n > 0 ? (warnOnly ? 'warn' : 'bad') : 'ok') as Tile['tone'];

async function one(db: Db, sql: string, p: unknown[]) { return (await db.query(sql, p)).rows[0]; }

/** Занятия сегодня: список с заполненностью */
async function classesToday(db: Db, ids: string[], trainerId: string | null) {
  const r = (await db.query(`select s.id, s.starts_at, s.capacity, s.status, t.name as type, u.full_name as trainer, c.timezone, c.name as club,
      (select count(*) from class_bookings b where b.session_id = s.id and b.status in ('booked', 'attended'))::int as booked,
      (select count(*) from class_bookings b where b.session_id = s.id and b.status = 'waitlist')::int as waitlist
    from class_sessions s join clubs c on c.id = s.club_id join class_types t on t.id = s.type_id left join users u on u.id = s.trainer_id
    where s.club_id = any($1) and s.status <> 'cancelled' and ${TODAY('s.starts_at')} and ($2::uuid is null or s.trainer_id = $2)
    order by s.starts_at`, [ids, trainerId])).rows;
  return r;
}
const classRows = (list: Awaited<ReturnType<typeof classesToday>>, multi: boolean, mine = false): Row[] => list.slice(0, 8).map((s) => ({
  text: `${hhmm(new Date(s.starts_at), s.timezone)} ${s.type}`, sub: [mine ? null : s.trainer, multi ? s.club : null].filter(Boolean).join(' · '),
  right: `${s.booked}/${s.capacity}${s.waitlist ? ` +${s.waitlist} в ожидании` : ''}`, tone: s.status === 'done' ? 'ok' : s.booked >= s.capacity ? 'warn' : undefined,
  go: { tab: 'schedule', p: { session: s.id, date: new Date(s.starts_at).toISOString().slice(0, 10) } },
}));

/* ---------- Клуб сегодня (управляющий, собственник) ---------- */
async function clubToday(db: Db, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const d = await one(db, `select
      (select count(*) from visits v join clubs c on c.id = v.club_id where v.club_id = any($1) and ${TODAY('v.visited_at')})::int as visits,
      (select count(*) from leads l join clubs c on c.id = l.club_id where l.club_id = any($1) and ${TODAY('l.created_at')})::int as leads,
      (select count(*) from memberships m join clubs c on c.id = m.club_id where m.club_id = any($1) and m.kind <> 'guest' and m.status <> 'cancelled' and ${TODAY('m.created_at')})::int as sales,
      (select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) from payments p join clubs c on c.id = p.club_id where p.club_id = any($1) and p.kind in ('charge', 'refund') and ${TODAY('p.created_at')})::bigint as "salesKop",
      (select count(*) from cash_shifts where club_id = any($1) and status = 'open')::int as shifts,
      (select coalesce(sum(unread), 0) from msg_conversations where club_id = any($1))::int as unread,
      (select count(*) from approvals where club_id = any($1) and status = 'pending')::int as approvals`, [ids]);
  const cls = await classesToday(db, ids, null);
  const booked = cls.reduce((a, s) => a + s.booked, 0); const cap = cls.reduce((a, s) => a + s.capacity, 0);
  return {
    tiles: [
      { label: 'Посещения сегодня', value: d.visits, go: { tab: 'access', p: { view: 'report' } } },
      { label: 'Занятия сегодня', value: cls.length, sub: cls.length ? `записано ${booked} из ${cap}` : 'нет в расписании', go: { tab: 'schedule' } },
      { label: 'Новые лиды', value: d.leads, go: { tab: 'leads' } },
      { label: 'Продажи сегодня', value: d.sales, sub: rub(Number(d.salesKop)), go: { tab: 'finance', p: { view: 'payments' } } },
      { label: 'Ждут согласования', value: d.approvals, tone: bad(d.approvals, true), go: { tab: 'finance', p: { view: 'approvals' } } },
      { label: 'Непрочитанные сообщения', value: d.unread, tone: bad(d.unread, true), go: { tab: 'chats', p: { filter: 'unread' } } },
      { label: 'Открытые кассовые смены', value: d.shifts, go: { tab: 'finance', p: { view: 'shift' } } },
    ],
    lists: [{ title: 'Занятия сегодня', rows: classRows(cls, clubs.length > 1), empty: 'Сегодня занятий нет', more: { tab: 'schedule' } }],
  };
}

/* ---------- Удержание клиентов (собственник, управляющий, РОП) ---------- */
async function retentionPanel(db: Db, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const d = await one(db, `select
      (select count(*) from memberships m join clubs c on c.id = m.club_id where m.club_id = any($1) and m.status = 'active' and m.kind = 'term'
         and m.ends_on between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 14 and not exists (select 1 from memberships n where n.renewed_from_id = m.id))::int as ending,
      (select count(*) from renewal_offers where club_id = any($1) and status in ('sent', 'call') and valid_until >= current_date)::int as offers,
      (select count(*) from renewal_offers where club_id = any($1) and status = 'used' and created_at > now() - interval '30 days')::int as renewed,
      (select count(*) from retention_campaigns where club_id = any($1) and status = 'running')::int as campaigns,
      (select count(*) from campaign_members cm join retention_campaigns rc on rc.id = cm.campaign_id where rc.club_id = any($1) and rc.status = 'running' and cm.replied_at is not null)::int as replied,
      (select count(*) from campaign_members cm join retention_campaigns rc on rc.id = cm.campaign_id where rc.club_id = any($1) and rc.status = 'running' and cm.bought_membership_id is not null)::int as bought,
      (select count(*) from surveys s join tasks t on t.id = s.task_id where s.club_id = any($1) and t.done_at is null)::int as "lowOpen",
      (select count(distinct m.person_id) from memberships m where m.club_id = any($1) and m.kind <> 'guest' and m.status <> 'cancelled' and m.ends_on between current_date - 90 and current_date - 1
         and not exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = m.club_id and n.status = 'active' and coalesce(n.ends_on, current_date) >= current_date))::int as former`, [ids]);
  const sc = (await db.query(`select score from surveys where club_id = any($1) and status = 'answered' and answered_at > now() - interval '30 days'`, [ids])).rows.map((r) => r.score as number);
  const nps = sc.length ? Math.round(((sc.filter((x) => x >= 9).length - sc.filter((x) => x <= 6).length) * 100) / sc.length) : null;
  return {
    tiles: [
      { label: 'Заканчивают за 14 дней без продления', value: d.ending, tone: bad(d.ending, true), go: { tab: 'hot', p: { tab: 'list' } } },
      { label: 'Предложения досрочного продления', value: d.offers, sub: `продлили за 30 дней: ${d.renewed}`, go: { tab: 'retention', p: { view: 'early' } } },
      { label: 'Кампании возврата идут', value: d.campaigns, sub: `ответили ${d.replied}, купили ${d.bought}`, go: { tab: 'retention', p: { view: 'campaigns' } } },
      { label: 'Индекс лояльности, 30 дней', value: nps === null ? '—' : nps > 0 ? `+${nps}` : String(nps), sub: `оценок ${sc.length}`, tone: nps === null ? undefined : nps >= 50 ? 'ok' : nps >= 0 ? 'warn' : 'bad', go: { tab: 'retention', p: { view: 'surveys' } } },
      { label: 'Недовольные ждут звонка', value: d.lowOpen, tone: bad(d.lowOpen), go: { tab: 'tasks', p: { scope: 'all' } } },
      { label: 'Ушли за последние 3 месяца', value: d.former, sub: 'кого вернуть', tone: bad(d.former, true), go: { tab: 'retention', p: { view: 'groups' } } },
    ],
    lists: [],
  };
}

/* ---------- Мой день (менеджер, РОП) ---------- */
async function myDay(db: Db, ctx: Ctx, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const d = await one(db, `select
      (select count(*) from tasks where assignee_id = $2 and done_at is null and due_at < now())::int as overdue,
      (select count(*) from tasks t join clubs c on c.id = t.club_id where t.assignee_id = $2 and t.done_at is null and t.due_at >= now() and ${TODAY('t.due_at')})::int as today,
      (select count(*) from leads where club_id = any($1) and first_response_at is null and (assigned_to = $2 or assigned_to is null))::int as "noResponse",
      (select count(*) from leads where club_id = any($1) and first_response_at is null and (assigned_to = $2 or assigned_to is null) and first_response_due_at < now())::int as "noResponseLate",
      (select count(*) from opportunities where club_id = any($1) and owner_id = $2 and status = 'open')::int as deals,
      (select count(*) from meetings m join clubs c on c.id = m.club_id left join opportunities o on o.id = m.opportunity_id
         where m.club_id = any($1) and m.status = 'scheduled' and (o.owner_id = $2 or m.created_by = $2) and ${TODAY('m.scheduled_at')})::int as meetings,
      (select coalesce(sum(unread), 0) from msg_conversations where club_id = any($1) and assigned_to = $2)::int as unread`, [ids, ctx.userId]);
  const next = (await db.query(`select t.id, t.title, t.due_at, t.person_id, p.full_name, c.timezone, t.due_at < now() as late
    from tasks t join clubs c on c.id = t.club_id left join persons p on p.id = t.person_id
    where t.assignee_id = $1 and t.done_at is null order by t.due_at limit 6`, [ctx.userId])).rows;
  return {
    tiles: [
      { label: 'Просроченные задачи', value: d.overdue, tone: bad(d.overdue), go: { tab: 'tasks', p: { scope: 'mine' } } },
      { label: 'Задачи на сегодня', value: d.today, go: { tab: 'tasks', p: { scope: 'mine' } } },
      { label: 'Лиды ждут первого ответа', value: d.noResponse, sub: d.noResponseLate ? `просрочено ${d.noResponseLate}` : undefined, tone: bad(d.noResponseLate), go: { tab: 'leads', p: { filter: 'noresponse' } } },
      { label: 'Кому звонить сегодня', value: 'план дня', sub: 'горячие клиенты от ИИ', go: { tab: 'hot', p: { tab: 'day' } } },
      { label: 'Встречи сегодня', value: d.meetings, go: { tab: 'board' } },
      { label: 'Мои открытые сделки', value: d.deals, go: { tab: 'board' } },
      { label: 'Непрочитанные в моих чатах', value: d.unread, tone: bad(d.unread, true), go: { tab: 'chats', p: { filter: 'mine' } } },
    ],
    lists: [{ title: 'Ближайшие задачи', empty: 'Задач нет', more: { tab: 'tasks' },
      rows: next.map((t) => ({ text: t.title, sub: t.full_name ?? undefined, right: new Date(t.due_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: t.timezone }),
        tone: t.late ? 'bad' : undefined, ...(t.person_id ? { personId: t.person_id } : { go: { tab: 'tasks' } }) })) }],
  };
}

/* ---------- Ресепшн ---------- */
async function deskDay(db: Db, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const d = await one(db, `select
      (select count(*) from visits v join clubs c on c.id = v.club_id where v.club_id = any($1) and ${TODAY('v.visited_at')})::int as visits,
      (select count(*) from cash_shifts where club_id = any($1) and status = 'open')::int as shifts,
      (select coalesce(sum(unread), 0) from msg_conversations where club_id = any($1))::int as unread,
      (select count(*) from leads l join clubs c on c.id = l.club_id where l.club_id = any($1) and ${TODAY('l.created_at')})::int as leads`, [ids]);
  const cls = await classesToday(db, ids, null);
  const ending = (await db.query(`select m.person_id, p.full_name, m.ends_on, pr.name as product from memberships m join clubs c on c.id = m.club_id join persons p on p.id = m.person_id
      left join products pr on pr.id = m.product_id
    where m.club_id = any($1) and m.status = 'active' and m.kind = 'term' and m.ends_on between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 3
      and not exists (select 1 from memberships n where n.renewed_from_id = m.id) order by m.ends_on limit 8`, [ids])).rows;
  const debtors = (await db.query(`select distinct on (v.person_id) v.person_id, p.full_name, v.visited_at, c.timezone,
      (select sum(amount_kop) from charges ch where ch.person_id = v.person_id and ch.status = 'due' and ch.due_on < current_date)::bigint as debt
    from visits v join clubs c on c.id = v.club_id join persons p on p.id = v.person_id
    where v.club_id = any($1) and ${TODAY('v.visited_at')} and exists (select 1 from charges ch where ch.person_id = v.person_id and ch.status = 'due' and ch.due_on < current_date)
    order by v.person_id, v.visited_at desc limit 8`, [ids])).rows;
  return {
    tiles: [
      { label: 'Посещения сегодня', value: d.visits, go: { tab: 'access', p: { view: 'desk' } } },
      { label: 'Занятия сегодня', value: cls.length, sub: cls.length ? `записано ${cls.reduce((a, s) => a + s.booked, 0)}` : undefined, go: { tab: 'schedule' } },
      { label: 'Кассовая смена', value: d.shifts ? 'открыта' : 'закрыта', tone: d.shifts ? 'ok' : 'warn', go: { tab: 'finance', p: { view: 'shift' } } },
      { label: 'Заканчиваются за 3 дня', value: ending.length, tone: bad(ending.length, true), go: { tab: 'home' } },
      { label: 'Должники пришли сегодня', value: debtors.length, tone: bad(debtors.length), go: { tab: 'access', p: { view: 'desk' } } },
      { label: 'Новые лиды сегодня', value: d.leads, go: { tab: 'leads' } },
      { label: 'Непрочитанные сообщения', value: d.unread, tone: bad(d.unread, true), go: { tab: 'chats', p: { filter: 'unread' } } },
    ],
    lists: [
      { title: 'Занятия сегодня', rows: classRows(cls, clubs.length > 1), empty: 'Сегодня занятий нет', more: { tab: 'schedule' } },
      { title: 'Предложите продление: абонемент заканчивается', empty: 'Ни у кого не заканчивается в ближайшие 3 дня',
        rows: ending.map((m) => ({ text: m.full_name, sub: m.product ?? undefined, right: `до ${String(m.ends_on instanceof Date ? m.ends_on.toISOString().slice(0, 10) : m.ends_on).split('-').reverse().join('.')}`, personId: m.person_id })) },
      { title: 'Пришли с долгом: напомните об оплате', empty: 'Сегодня должников не было',
        rows: debtors.map((x) => ({ text: x.full_name, right: rub(Number(x.debt)), tone: 'bad' as const, personId: x.person_id })) },
    ],
  };
}

/* ---------- Финансист ---------- */
async function finDay(db: Db, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const d = await one(db, `select
      (select coalesce(sum(amount_kop), 0) from payments p join clubs c on c.id = p.club_id where p.club_id = any($1) and p.direction = 'in' and ${TODAY('p.created_at')})::bigint as inflow,
      (select coalesce(sum(amount_kop), 0) from payments p join clubs c on c.id = p.club_id where p.club_id = any($1) and p.kind = 'expense' and ${TODAY('p.created_at')})::bigint as expenses,
      (select count(*) from charges where club_id = any($1) and status = 'due' and due_on < current_date)::int as "debtsCount",
      (select coalesce(sum(amount_kop), 0) from charges where club_id = any($1) and status = 'due' and due_on < current_date)::bigint as "debtsKop",
      (select count(*) from charges where club_id = any($1) and status = 'due' and autopay_error is not null)::int as autopay,
      (select count(*) from approvals where club_id = any($1) and status = 'pending')::int as approvals,
      (select count(*) from cash_shifts where club_id = any($1) and status = 'open')::int as shifts,
      (select count(*) from cash_shifts where club_id = any($1) and status = 'open' and opened_at < now() - interval '16 hours')::int as "staleShifts",
      (select count(*) from bank_lines where club_id = any($1) and status = 'unmatched')::int as unmatched`, [ids]);
  return {
    tiles: [
      { label: 'Поступления сегодня', value: rub(Number(d.inflow)), go: { tab: 'finance', p: { view: 'payments' } } },
      { label: 'Расходы сегодня', value: rub(Number(d.expenses)), go: { tab: 'finance', p: { view: 'expenses' } } },
      { label: 'Просроченные долги', value: d.debtsCount, sub: rub(Number(d.debtsKop)), tone: bad(d.debtsCount, true), go: { tab: 'finance', p: { view: 'debts' } } },
      { label: 'Не прошло автосписание', value: d.autopay, tone: bad(d.autopay), go: { tab: 'finance', p: { view: 'online' } } },
      { label: 'Ждут согласования', value: d.approvals, tone: bad(d.approvals, true), go: { tab: 'finance', p: { view: 'approvals' } } },
      { label: 'Открытые кассовые смены', value: d.shifts, sub: d.staleShifts ? `не закрыты больше 16 ч: ${d.staleShifts}` : undefined, tone: d.staleShifts ? 'bad' : undefined, go: { tab: 'finance', p: { view: 'shift' } } },
      { label: 'Банк: не сверено', value: d.unmatched, tone: bad(d.unmatched, true), go: { tab: 'finance', p: { view: 'bank' } } },
      { label: 'Зарплата за месяц', value: 'ведомость', go: { tab: 'stafftime', p: { tab: 'payroll' } } },
    ],
    lists: [],
  };
}

/* ---------- Тренер ---------- */
async function trainerDay(db: Db, ctx: Ctx, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const cls = await classesToday(db, ids, ctx.userId);
  const d = await one(db, `select
      (select count(*) from class_sessions s where s.trainer_id = $2 and s.club_id = any($1) and s.status <> 'cancelled' and s.starts_at between now() and now() + interval '7 days')::int as week,
      (select count(*) from class_sessions s join clubs c on c.id = s.club_id where s.trainer_id = $2 and s.status = 'done'
         and date_trunc('month', s.starts_at at time zone c.timezone) = date_trunc('month', now() at time zone c.timezone))::int as month,
      (select count(*) from class_sessions s where s.trainer_id = $2 and s.status = 'scheduled' and s.ends_at < now())::int as unmarked`, [ids, ctx.userId]);
  return {
    tiles: [
      { label: 'Мои занятия сегодня', value: cls.length, sub: cls.length ? `клиентов ${cls.reduce((a, s) => a + s.booked, 0)}` : undefined, go: { tab: 'schedule', p: { mine: '1' } } },
      { label: 'На 7 дней вперёд', value: d.week, go: { tab: 'schedule', p: { mine: '1' } } },
      { label: 'Отметить посещение', value: d.unmarked, sub: 'прошедшие занятия без отметки', tone: bad(d.unmarked), go: { tab: 'schedule', p: { mine: '1' } } },
      { label: 'Проведено в этом месяце', value: d.month, sub: 'идут в зарплату', go: { tab: 'stafftime', p: { tab: 'my' } } },
    ],
    lists: [{ title: 'Мои занятия сегодня', rows: classRows(cls, clubs.length > 1, true), empty: 'Сегодня занятий нет', more: { tab: 'schedule', p: { mine: '1' } } }],
  };
}

/* ---------- Администратор системы ---------- */
async function systemPanel(db: Db, clubs: Club[]): Promise<Panel> {
  const ids = clubs.map((c) => c.id);
  const d = await one(db, `select
      (select count(*) from clubs where status = 'active' and not is_demo)::int as clubs,
      (select count(*) from clubs c where c.status = 'active' and not c.is_demo and (select count(*) from club_onboarding o where o.club_id = c.id) < 17)::int as onboarding,
      (select count(*) from users where status = 'active')::int as staff,
      (select count(*) from users where status = 'active' and must_change_password)::int as "mustChange",
      (select count(*) from users u where u.status = 'active' and not exists (select 1 from user_assignments a where a.user_id = u.id and (a.active_to is null or a.active_to >= current_date)))::int as "noRole",
      (select count(*) from support_tickets where status = 'open')::int as tickets,
      (select count(*) from import_batches where club_id = any($1) and status in ('draft', 'checked'))::int as imports`, [ids]);
  return {
    tiles: [
      { label: 'Клубы', value: d.clubs, go: { tab: 'clubs' } },
      { label: 'Подключение не завершено', value: d.onboarding, tone: bad(d.onboarding, true), go: { tab: 'onboarding' } },
      { label: 'Сотрудники', value: d.staff, sub: d.noRole ? `без роли: ${d.noRole}` : undefined, tone: d.noRole ? 'warn' : undefined, go: { tab: 'staff' } },
      { label: 'Не сменили временный пароль', value: d.mustChange, tone: bad(d.mustChange, true), go: { tab: 'staff' } },
      { label: 'Открытые обращения в поддержку', value: d.tickets, tone: bad(d.tickets, true), go: { tab: 'help', p: { view: 'support' } } },
      { label: 'Перенос из 1С не завершён', value: d.imports, tone: bad(d.imports, true), go: { tab: 'import' } },
    ],
    lists: [],
  };
}

export const ROLE_PANELS = ['club_today', 'retention', 'my_day', 'desk_day', 'fin_day', 'trainer_day', 'system'] as const;
export async function rolePanel(db: Db, ctx: Ctx, id: string, clubs: Club[]): Promise<Panel> {
  if (id === 'club_today') return clubToday(db, clubs);
  if (id === 'retention') return retentionPanel(db, clubs);
  if (id === 'my_day') return myDay(db, ctx, clubs);
  if (id === 'desk_day') return deskDay(db, clubs);
  if (id === 'fin_day') return finDay(db, clubs);
  if (id === 'trainer_day') return trainerDay(db, ctx, clubs);
  return systemPanel(db, clubs);
}
