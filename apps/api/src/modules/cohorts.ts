// Удержание по месяцам прихода и ценность клиента по каналам (список «20 новых возможностей», п. 17).
// Когорта — месяц первой покупки в клубе (гостевые визиты не считаются). Клиент «остался» в месяце, если в этом месяце
// у него действовал абонемент или было посещение. Ценность клиента — сколько денег он принёс за всё время (оплаты минус возвраты).
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { withCtx, type Db } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OFFSETS = [1, 2, 3, 6, 12];
const monthAdd = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/**
 * Клиенты с первой покупкой и тем, в каких месяцах они «были с нами».
 * Возвращает по человеку: когорту, первый тариф, продавца, канал, акцию, деньги и месяцы активности.
 */
export async function cohortPeople(db: Db, clubId: string | null, fromMonth: string, today: string) {
  return (await db.query(`with first as (
      select distinct on (m.person_id, m.club_id) m.person_id, m.club_id, m.id, m.product_name, m.created_by, m.promo_id, m.kind,
        to_char(m.created_at at time zone c.timezone, 'YYYY-MM') as cohort
      from memberships m join clubs c on c.id = m.club_id
      where m.kind <> 'guest' and ($1::uuid is null or m.club_id = $1)
      order by m.person_id, m.club_id, m.created_at),
    people as (select * from first where cohort >= $2),
    -- месяцы, когда у клиента действовал абонемент (для расторгнутых — до даты расторжения)
    cover as (
      select distinct p.person_id, p.club_id, to_char(g, 'YYYY-MM') as month
      from people p join memberships m on m.person_id = p.person_id and m.club_id = p.club_id and m.kind <> 'guest'
      cross join lateral generate_series(date_trunc('month', m.starts_on),
        date_trunc('month', least(coalesce(m.ends_on, $3::date), case when m.status = 'cancelled' then m.updated_at::date else $3::date end, $3::date)), interval '1 month') g
      where m.starts_on <= $3::date),
    seen as (
      select distinct p.person_id, p.club_id, to_char(v.visited_at at time zone c.timezone, 'YYYY-MM') as month
      from people p join visits v on v.person_id = p.person_id and v.club_id = p.club_id join clubs c on c.id = p.club_id),
    money as (
      select p.person_id, p.club_id, coalesce(sum(case when y.direction = 'in' then y.amount_kop else -y.amount_kop end), 0)::bigint as kop
      from people p join payments y on y.person_id = p.person_id and y.club_id = p.club_id and y.expense_id is null
      group by 1, 2),
    src as (
      select distinct on (l.person_id, l.club_id) l.person_id, l.club_id, s.name
      from leads l left join lead_sources s on s.id = l.source_id order by l.person_id, l.club_id, l.created_at),
    coach as (
      select distinct on (b.person_id, s.club_id) b.person_id, s.club_id, u.full_name as name
      from class_bookings b join class_sessions s on s.id = b.session_id join class_types t on t.id = s.type_id join users u on u.id = s.trainer_id
      where t.kind = 'personal' and b.status = 'attended'
      group by b.person_id, s.club_id, u.full_name order by b.person_id, s.club_id, count(*) desc)
    select p.person_id as "personId", p.club_id as "clubId", p.cohort, p.product_name as tariff, p.promo_id is not null as promo,
      coalesce(u.full_name, 'Онлайн и импорт') as seller, coalesce(src.name, 'Источник не указан') as channel, coach.name as trainer,
      coalesce(money.kop, 0)::bigint as kop,
      coalesce((select array_agg(distinct x.month) from (select month from cover where cover.person_id = p.person_id and cover.club_id = p.club_id
        union select month from seen where seen.person_id = p.person_id and seen.club_id = p.club_id) x), '{}') as months
    from people p left join users u on u.id = p.created_by left join money on money.person_id = p.person_id and money.club_id = p.club_id
      left join src on src.person_id = p.person_id and src.club_id = p.club_id left join coach on coach.person_id = p.person_id and coach.club_id = p.club_id`,
  [clubId, fromMonth, today])).rows.map((r) => ({ ...r, kop: Number(r.kop), months: r.months as string[] })) as {
    personId: string; clubId: string; cohort: string; tariff: string; promo: boolean; seller: string; channel: string; trainer: string | null; kop: number; months: string[] }[];
}

/** Матрица удержания: доля клиентов когорты, которые были с нами через k месяцев. null — месяц ещё не наступил. */
export function retentionMatrix(people: Awaited<ReturnType<typeof cohortPeople>>, curMonth: string) {
  const by = new Map<string, typeof people>();
  for (const p of people) by.set(p.cohort, [...(by.get(p.cohort) ?? []), p]);
  return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([cohort, ps]) => ({
    cohort, clients: ps.length, avgKop: Math.round(ps.reduce((s, p) => s + p.kop, 0) / ps.length),
    retained: OFFSETS.map((k) => {
      const m = monthAdd(cohort, k);
      if (m > curMonth) return null;
      return Math.round((100 * ps.filter((p) => p.months.includes(m)).length) / ps.length);
    }),
  }));
}

/** Ценность по разрезу: клиентов, средние деньги, доля оставшихся через 3 и 6 месяцев (среди тех, у кого этот срок уже прошёл). */
export function valueBy(people: Awaited<ReturnType<typeof cohortPeople>>, key: (p: (typeof people)[number]) => string | null, curMonth: string) {
  const by = new Map<string, typeof people>();
  for (const p of people) { const k = key(p); if (k) by.set(k, [...(by.get(k) ?? []), p]); }
  const share = (ps: typeof people, k: number) => {
    const ripe = ps.filter((p) => monthAdd(p.cohort, k) <= curMonth);
    return ripe.length ? { pct: Math.round((100 * ripe.filter((p) => p.months.includes(monthAdd(p.cohort, k))).length) / ripe.length), n: ripe.length } : null;
  };
  return [...by.entries()].map(([name, ps]) => ({
    name, clients: ps.length, avgKop: Math.round(ps.reduce((s, p) => s + p.kop, 0) / ps.length), totalKop: ps.reduce((s, p) => s + p.kop, 0),
    avgMonths: Math.round((10 * ps.reduce((s, p) => s + p.months.filter((m) => m >= p.cohort && m <= curMonth).length, 0)) / ps.length) / 10,
    after3: share(ps, 3), after6: share(ps, 6),
  })).sort((a, b) => b.totalKop - a.totalKop);
}

export function cohortRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/cohorts', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    if (!can(ctx, P.dashView) && !can(ctx, P.financeView)) throw forbidden();
    const q = req.query as { clubId?: string; months?: string };
    if (q.clubId && q.clubId !== 'all' && !UUID.test(q.clubId)) throw badRequest('Клуб не найден');
    const clubId = q.clubId && q.clubId !== 'all' ? q.clubId : null;
    const span = Math.min(Math.max(Number(q.months) || 13, 3), 36);
    return withCtx(pool, ctx, async (db) => {
      const today = (await db.query(`select to_char(now() at time zone coalesce((select timezone from clubs where id = $1), 'Europe/Moscow'), 'YYYY-MM-DD') as d`, [clubId])).rows[0].d as string;
      const cur = today.slice(0, 7);
      const from = monthAdd(cur, -(span - 1));
      const people = await cohortPeople(db, clubId, from, today);
      const total = people.reduce((s, p) => s + p.kop, 0);
      return {
        today, from, offsets: OFFSETS, clients: people.length, avgKop: people.length ? Math.round(total / people.length) : 0,
        cohorts: retentionMatrix(people, cur),
        by: {
          channel: valueBy(people, (p) => p.channel, cur),
          tariff: valueBy(people, (p) => p.tariff, cur),
          seller: valueBy(people, (p) => p.seller, cur),
          trainer: valueBy(people, (p) => p.trainer, cur),
          promo: valueBy(people, (p) => (p.promo ? 'Первая покупка по акции или промокоду' : 'Первая покупка по полной цене'), cur),
        },
        months: monthsBetween(from, cur) + 1,
      };
    });
  });
}
