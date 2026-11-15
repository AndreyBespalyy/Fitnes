// «Проблемные моменты» — экран собственника, управляющего и финансиста (разграничение доступов по ролям, 15.11.2026).
// Одна сводка того, что требует внимания руководителя: деньги, клиенты, команда, касса. По каждому пункту — число по клубам,
// сумма (если про деньги) и куда перейти, чтобы разобраться. Только чтение: данные берутся из уже существующих таблиц.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { withCtx, type Db } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';

type Club = { id: string; name: string; timezone: string };
type Go = { tab: string; p?: Record<string, string> };
type Def = { id: string; group: 'money' | 'clients' | 'team' | 'cash'; title: string; hint: string; go: Go; money?: boolean; finance?: boolean };

/** Порядок и смысл пунктов. finance: пункт виден и финансисту (у него нет dash.view). */
export const PROBLEMS: Def[] = [
  { id: 'debts', group: 'money', title: 'Просроченные платежи клиентов', hint: 'Клиенты не оплатили в срок', go: { tab: 'finance', p: { view: 'debts' } }, money: true, finance: true },
  { id: 'autopayFailed', group: 'money', title: 'Неудачные автосписания подписки', hint: 'Карта не прошла: нужно отправить ссылку на оплату', go: { tab: 'finance', p: { view: 'online' } }, money: true, finance: true },
  { id: 'approvals', group: 'money', title: 'Ждут согласования: возвраты, скидки, расходы сверх лимита', hint: 'Решение за собственником или управляющим', go: { tab: 'finance', p: { view: 'approvals' } }, money: true, finance: true },
  { id: 'cashDiff', group: 'cash', title: 'Расхождения в кассе за 7 дней', hint: 'При закрытии смены пересчитанные наличные не совпали с ожидаемыми', go: { tab: 'finance', p: { view: 'shift' } }, money: true, finance: true },
  { id: 'receiptsFailed', group: 'cash', title: 'Чеки, которые не пробились', hint: 'Касса вернула ошибку: чек нужно пробить повторно', go: { tab: 'fiscal' }, money: true, finance: true },
  { id: 'payroll', group: 'team', title: 'Клубы, где не утверждена зарплата за прошлый месяц', hint: 'Ведомость не рассчитана или ждёт утверждения (с 6-го числа)', go: { tab: 'stafftime', p: { tab: 'payroll' } }, finance: true },
  { id: 'lowScores', group: 'clients', title: 'Низкие оценки клиентов за 30 дней (0–6 из 10)', hint: 'Недовольные клиенты: что случилось и что сделано', go: { tab: 'retention', p: { view: 'surveys' } } },
  { id: 'noVisits', group: 'clients', title: 'Действующие клиенты не ходят 14+ дней', hint: 'Риск ухода', go: { tab: 'retention', p: { view: 'churn' } } },
  { id: 'endingSoon', group: 'clients', title: 'Абонементы заканчиваются в 14 дней, продления нет', hint: 'Кандидаты в продление', go: { tab: 'retention', p: { view: 'early' } } },
  { id: 'missedResponse', group: 'team', title: 'Заявки без первого ответа сверх нормы', hint: 'Клиент ждёт, менеджер не связался вовремя', go: { tab: 'leads', p: { filter: 'noresponse' } } },
  { id: 'overdueTasks', group: 'team', title: 'Просроченные задачи сотрудников', hint: 'Задачи с прошедшим сроком', go: { tab: 'tasks', p: { scope: 'all' } } },
  { id: 'cancelledClasses', group: 'team', title: 'Отменённые занятия за 7 дней', hint: 'Клиенты записались, а занятие не состоялось', go: { tab: 'schedule' } },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function clubsOf(db: Db, clubId?: string): Promise<Club[]> {
  const one = clubId && clubId !== 'all' ? clubId : null;
  if (one && !UUID.test(one)) throw badRequest('Клуб не найден');
  const rows = (await db.query(`select id, name, timezone from clubs where status = 'active' and (($1::uuid is null and not is_demo) or id = $1) order by created_at`, [one])).rows as Club[];
  if (one && !rows.length) throw badRequest('Клуб не найден');
  return rows;
}

async function perClub(db: Db, c: Club) {
  const r = (await db.query(`
    with t as (select (now() at time zone $2)::date as d)
    select
      (select count(*) from charges, t where club_id = $1 and status = 'due' and due_on < t.d)::int as "debts",
      (select coalesce(sum(amount_kop), 0) from charges, t where club_id = $1 and status = 'due' and due_on < t.d)::bigint as "debtsKop",
      (select count(*) from charges where club_id = $1 and status = 'due' and autopay_error is not null)::int as "autopayFailed",
      (select coalesce(sum(amount_kop), 0) from charges where club_id = $1 and status = 'due' and autopay_error is not null)::bigint as "autopayFailedKop",
      (select count(*) from approvals where club_id = $1 and status = 'pending')::int as "approvals",
      (select coalesce(sum(amount_kop), 0) from approvals where club_id = $1 and status = 'pending')::bigint as "approvalsKop",
      (select count(*) from cash_shifts where club_id = $1 and status = 'closed' and closed_at > now() - interval '7 days'
         and counted_cash_kop is not null and expected_cash_kop is not null and counted_cash_kop <> expected_cash_kop)::int as "cashDiff",
      (select coalesce(sum(abs(counted_cash_kop - expected_cash_kop)), 0) from cash_shifts where club_id = $1 and status = 'closed' and closed_at > now() - interval '7 days'
         and counted_cash_kop is not null and expected_cash_kop is not null)::bigint as "cashDiffKop",
      (select count(*) from receipts where club_id = $1 and status = 'failed')::int as "receiptsFailed",
      (select coalesce(sum(amount_kop), 0) from receipts where club_id = $1 and status = 'failed')::bigint as "receiptsFailedKop",
      (select case when extract(day from t.d) < 6 then 0
         when exists (select 1 from payroll_periods p where p.club_id = $1 and p.month = (date_trunc('month', t.d) - interval '1 month')::date and p.status = 'approved') then 0
         when exists (select 1 from staff_shifts s where s.club_id = $1) or exists (select 1 from payroll_periods p where p.club_id = $1) then 1 else 0 end from t)::int as "payroll",
      (select count(*) from surveys where club_id = $1 and status = 'answered' and score <= 6 and answered_at > now() - interval '30 days')::int as "lowScores",
      (select count(distinct m.person_id) from memberships m, t where m.club_id = $1 and m.status = 'active' and m.starts_on <= t.d - 14 and coalesce(m.ends_on, t.d) >= t.d
         and not exists (select 1 from visits v where v.person_id = m.person_id and v.visited_at > now() - interval '14 days'))::int as "noVisits",
      (select count(*) > 0 from visits where club_id = $1) or (select count(*) > 0 from access_gateways where club_id = $1) as "hasVisits",
      (select count(*) from memberships m, t where m.club_id = $1 and m.status = 'active' and m.kind = 'term' and m.ends_on between t.d and t.d + 14
         and not exists (select 1 from memberships n where n.renewed_from_id = m.id))::int as "endingSoon",
      (select count(*) from leads where club_id = $1 and first_response_at is null and first_response_due_at < now())::int as "missedResponse",
      (select count(*) from tasks where club_id = $1 and done_at is null and due_at < now())::int as "overdueTasks",
      (select count(*) from class_sessions where club_id = $1 and status = 'cancelled' and starts_at between now() - interval '7 days' and now() + interval '1 day')::int as "cancelledClasses"
  `, [c.id, c.timezone])).rows[0] as Record<string, number | string | boolean>;
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    clubId: c.id, name: c.name,
    values: {
      debts: n('debts'), autopayFailed: n('autopayFailed'), approvals: n('approvals'), cashDiff: n('cashDiff'), receiptsFailed: n('receiptsFailed'), payroll: n('payroll'),
      lowScores: n('lowScores'), noVisits: r.hasVisits ? n('noVisits') : null, endingSoon: n('endingSoon'),
      missedResponse: n('missedResponse'), overdueTasks: n('overdueTasks'), cancelledClasses: n('cancelledClasses'),
    } as Record<string, number | null>,
    money: { debts: n('debtsKop'), autopayFailed: n('autopayFailedKop'), approvals: n('approvalsKop'), cashDiff: n('cashDiffKop'), receiptsFailed: n('receiptsFailedKop') } as Record<string, number>,
  };
}

export function problemRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/problems', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.dashView) && !can(ctx, P.financeView)) throw forbidden('Раздел для собственника, управляющего и финансиста');
    // Клиенты и команда — для тех, кто видит работу всего клуба (собственник, управляющий); финансисту — только деньги, касса, зарплата
    const full = can(ctx, P.crmViewAll);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const clubs = await clubsOf(db, clubId);
      const per = await Promise.all(clubs.map((c) => perClub(db, c)));
      const defs = PROBLEMS.filter((d) => full || d.finance);
      const items = defs.map((d) => {
        const vals = per.map((p) => p.values[d.id]);
        const value = vals.every((v) => v === null) ? null : vals.reduce((a: number, v) => a + (v ?? 0), 0);
        return { id: d.id, group: d.group, title: d.title, hint: d.hint, go: d.go, value,
          moneyKop: d.money ? per.reduce((a, p) => a + (p.money[d.id] ?? 0), 0) : null,
          perClub: per.map((p) => ({ clubId: p.clubId, name: p.name, value: p.values[d.id], moneyKop: d.money ? p.money[d.id] ?? 0 : null })) };
      });
      // Последние недовольные клиенты: кто, оценка, комментарий — чтобы собственник видел суть, а не только число
      const lows = full ? (await db.query(`
        select s.id, s.person_id as "personId", p.full_name as "name", s.score, s.comment, s.answered_at as "at", c.name as "club",
               t.done_at is not null as "handled"
        from surveys s join persons p on p.id = s.person_id join clubs c on c.id = s.club_id left join tasks t on t.id = s.task_id
        where s.club_id = any($1) and s.status = 'answered' and s.score <= 6 and s.answered_at > now() - interval '30 days'
        order by s.answered_at desc limit 10`, [clubs.map((c) => c.id)])).rows : [];
      return { clubs: clubs.map((c) => ({ id: c.id, name: c.name })), items, lows, total: items.filter((i) => (i.value ?? 0) > 0).length };
    });
  });
}
