// Рабочее место тренера в приложении (список «20 новых возможностей», п. 14).
// Тренер видит свои занятия и свободные окна, своих клиентов и остатки их пакетов, предварительный заработок за месяц
// и список «предложить продление»: у кого персональные скоро закончатся. Согласие клиента уходит менеджеру задачей.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { addDays, clubToday } from './memberships.ts';
import { task } from './retention.ts';
import { calcPayroll } from './staffTime.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Свободные окна в смене: время смены минус занятия тренера (только промежутки от 30 минут). */
export function freeWindows(shifts: { starts: string; ends: string }[], busy: { from: string; to: string }[]) {
  const out: { from: string; to: string }[] = [];
  const b = busy.map((x) => [toMin(x.from), toMin(x.to)] as const).sort((x, y) => x[0] - y[0]);
  for (const s of shifts) {
    let cur = toMin(s.starts); const end = toMin(s.ends);
    for (const [f, t] of b) {
      if (t <= cur || f >= end) continue;
      if (f - cur >= 30) out.push({ from: hhmm(cur), to: hhmm(f) });
      cur = Math.max(cur, t);
    }
    if (end - cur >= 30) out.push({ from: hhmm(cur), to: hhmm(end) });
  }
  return out;
}

/** Клиенты тренера: занимались у него персонально за 120 дней или записаны вперёд. С остатками пакетов персональных в клубе. */
async function myClients(db: Db, trainerId: string, clubId: string, today: string) {
  return (await db.query(`with mine as (
      select b.person_id, max(s.starts_at) filter (where s.starts_at <= now()) as last_at, min(s.starts_at) filter (where s.starts_at > now() and b.status = 'booked') as next_at,
        count(*) filter (where b.status = 'attended' and s.starts_at > now() - interval '30 days')::int as sessions30
      from class_bookings b join class_sessions s on s.id = b.session_id join class_types t on t.id = s.type_id
      where s.trainer_id = $1 and s.club_id = $2 and t.kind = 'personal' and b.status in ('booked', 'attended', 'no_show') and s.starts_at > now() - interval '120 days'
      group by b.person_id)
    select p.id as "personId", p.full_name as name, mine.last_at as "lastAt", mine.next_at as "nextAt", mine.sessions30 as "sessions30",
      pk.id as "membershipId", pk.product_name as package, pk.visits_left as "visitsLeft", to_char(pk.ends_on, 'YYYY-MM-DD') as "endsOn",
      (select count(*)::int from class_bookings b2 where b2.membership_id = pk.id and b2.status = 'booked' and not b2.charged) as reserved,
      (select json_build_object('result', o.result, 'at', o.created_at) from trainer_offers o where o.person_id = p.id and o.trainer_id = $1 order by o.created_at desc limit 1) as "lastOffer"
    from mine join persons p on p.id = mine.person_id
    left join lateral (select m.* from memberships m where m.person_id = p.id and m.club_id = $2 and m.kind = 'personal' and m.status = 'active'
      and (m.ends_on is null or m.ends_on >= $3) order by m.ends_on nulls last limit 1) pk on true
    order by p.full_name`, [trainerId, clubId, today])).rows as {
      personId: string; name: string; lastAt: string | null; nextAt: string | null; sessions30: number; membershipId: string | null; package: string | null;
      visitsLeft: number | null; endsOn: string | null; reserved: number; lastOffer: { result: string; at: string } | null }[];
}

/** Пора предложить продление: осталось 2 занятия и меньше (с учётом записей вперёд), пакет закончится в 14 дней или пакета уже нет, а клиент недавно ходил. */
export function renewalDue(c: Awaited<ReturnType<typeof myClients>>[number], today: string) {
  const recentOffer = c.lastOffer && Date.now() - new Date(c.lastOffer.at).getTime() < 7 * 864e5 && c.lastOffer.result !== 'thinking';
  if (recentOffer) return null;
  if (!c.membershipId) return c.lastAt && Date.now() - new Date(c.lastAt).getTime() < 30 * 864e5 ? 'пакет закончился' : null;
  const free = (c.visitsLeft ?? 0) - c.reserved;
  if (free <= 2) return free <= 0 ? 'все занятия пакета расписаны' : `осталось ${free} ${free === 1 ? 'занятие' : 'занятия'}`;
  if (c.endsOn && c.endsOn <= addDays(today, 14)) return `пакет действует до ${c.endsOn.split('-').reverse().join('.')}`;
  return null;
}

export function trainerRoutes(app: FastifyInstance, pool: pg.Pool) {
  const clubOf = (ctx: Ctx, clubId?: string) => {
    if (clubId && clubId !== 'all') { if (!UUID.test(clubId)) throw badRequest('Выберите клуб'); return clubId; }
    if (ctx.clubIds.length) return ctx.clubIds[0];
    throw badRequest('Выберите клуб');
  };

  app.get('/api/trainer/desk', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const q = req.query as { clubId?: string; date?: string; trainerId?: string };
    const clubId = clubOf(ctx, q.clubId);
    // Управляющий может посмотреть стол любого тренера своего клуба
    const trainerId = q.trainerId && q.trainerId !== ctx.userId ? (can(ctx, P.scheduleManage) ? q.trainerId : (() => { throw forbidden(); })()) : ctx.userId;
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date! : today;
      const tz = (await db.query('select timezone from clubs where id = $1', [clubId])).rows[0]?.timezone ?? 'Europe/Moscow';
      const sessions = (await db.query(`select s.id, t.name as "typeName", t.kind, r.name as "roomName", s.status, s.capacity,
          to_char(s.starts_at at time zone $4, 'YYYY-MM-DD') as day, to_char(s.starts_at at time zone $4, 'HH24:MI') as "from", to_char(s.ends_at at time zone $4, 'HH24:MI') as "to",
          s.starts_at <= now() as started,
          coalesce((select json_agg(json_build_object('id', b.id, 'personId', b.person_id, 'name', p.full_name, 'status', b.status, 'trial', b.trial,
              'visitsLeft', m.visits_left, 'package', m.product_name) order by p.full_name)
            from class_bookings b join persons p on p.id = b.person_id left join memberships m on m.id = b.membership_id
            where b.session_id = s.id and b.status in ('booked', 'attended', 'no_show')), '[]') as people
        from class_sessions s join class_types t on t.id = s.type_id left join rooms r on r.id = s.room_id
        where s.trainer_id = $1 and s.club_id = $2 and s.status <> 'cancelled' and (s.starts_at >= ($3::date)::date::timestamp at time zone $4 and s.starts_at < (($3::date + 6)::date + 1)::timestamp at time zone $4)
        order by s.starts_at`, [trainerId, clubId, date, tz])).rows;
      const shifts = (await db.query(`select to_char(day, 'YYYY-MM-DD') as day, to_char(starts, 'HH24:MI') as starts, to_char(ends, 'HH24:MI') as ends
        from staff_shifts where user_id = $1 and club_id = $2 and day between $3::date and $3::date + 6 order by day, starts`, [trainerId, clubId, date])).rows;
      const days = Array.from({ length: 7 }, (_, i) => addDays(date, i)).map((d) => {
        const ss = sessions.filter((s) => s.day === d);
        const sh = shifts.filter((s) => s.day === d);
        return { day: d, shifts: sh.map((s) => ({ from: s.starts, to: s.ends })), windows: freeWindows(sh, ss.map((s) => ({ from: s.from, to: s.to }))), sessions: ss };
      });
      // Не отмеченные прошедшие занятия: тренер должен отметить, иначе они не попадут в зарплату
      const unmarked = (await db.query(`select s.id, t.name as "typeName", to_char(s.starts_at at time zone $3, 'DD.MM HH24:MI') as at
        from class_sessions s join class_types t on t.id = s.type_id where s.trainer_id = $1 and s.club_id = $2 and s.status = 'scheduled' and s.starts_at < now()
          and s.starts_at > now() - interval '30 days' order by s.starts_at`, [trainerId, clubId, tz])).rows;
      const clients = await myClients(db, trainerId, clubId, today);
      const renew = clients.map((c) => ({ ...c, reason: renewalDue(c, today) })).filter((c) => c.reason);
      const month = today.slice(0, 7);
      const line = (await calcPayroll(db, clubId, month, today)).find((l) => l.userId === trainerId) ?? null;
      const done = (await db.query(`select count(*) filter (where t.kind = 'personal')::int as personal, count(*) filter (where t.kind = 'group')::int as "group"
        from class_sessions s join class_types t on t.id = s.type_id where s.trainer_id = $1 and s.club_id = $2 and s.status = 'done'
          and to_char(s.starts_at at time zone $4, 'YYYY-MM') = $3`, [trainerId, clubId, month, tz])).rows[0];
      const offers = (await db.query(`select count(*)::int as n, count(*) filter (where result = 'agreed')::int as agreed, count(*) filter (where renewed_membership_id is not null)::int as renewed
        from trainer_offers where trainer_id = $1 and club_id = $2 and created_at > now() - interval '30 days'`, [trainerId, clubId])).rows[0];
      const name = (await db.query('select full_name from users where id = $1', [trainerId])).rows[0]?.full_name ?? '';
      return { trainer: { id: trainerId, name }, clubId, today, date, days, unmarked, clients, renew,
        earnings: line ? { month, items: line.items, totalKop: line.totalKop, estimate: true } : null, done, offers };
    });
  });

  // Тренер предложил продление: согласие — менеджеру задача оформить, «подумает» — напомним тренеру позже, отказ — запоминаем
  app.post('/api/trainer/offers', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const b = (req.body ?? {}) as { clubId?: string; personId?: string; membershipId?: string | null; result?: string; note?: string };
    if (!UUID.test(b.personId ?? '')) throw badRequest('Выберите клиента');
    if (!['agreed', 'thinking', 'refused'].includes(b.result ?? '')) throw badRequest('Отметьте результат: согласен, подумает или отказался');
    const clubId = clubOf(ctx, b.clubId);
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select full_name from persons where id = $1', [b.personId])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      const pk = b.membershipId && UUID.test(b.membershipId) ? (await db.query('select product_name from memberships where id = $1 and person_id = $2', [b.membershipId, b.personId])).rows[0] : null;
      const me = (await db.query('select full_name from users where id = $1', [ctx.userId])).rows[0]?.full_name ?? 'тренер';
      const note = b.note?.trim().slice(0, 300) || null;
      let taskId: string | null = null;
      if (b.result === 'agreed') {
        taskId = await task(db, ctx as never, clubId, b.personId!, `Продлить персональные${pk ? ` («${pk.product_name}»)` : ''}: клиент согласился, предложил тренер ${me}${note ? `. ${note}` : ''}`, 4);
      }
      const id = (await db.query(`insert into trainer_offers(tenant_id, club_id, trainer_id, person_id, membership_id, result, note, task_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, clubId, ctx.userId, b.personId, pk ? b.membershipId : null, b.result, note, taskId])).rows[0].id as string;
      await audit(db, ctx, 'trainer.offer', 'person', b.personId!, null, { result: b.result, membershipId: pk ? b.membershipId : null, taskId });
      return { id, taskId };
    });
  });
}

/** Продажа пакета персональных клиенту, которому тренер предлагал продление: засчитываем тренеру. Вызывается из продажи. */
export async function creditTrainerOffer(db: Db, personId: string, clubId: string, membershipId: string, productKind: string) {
  if (productKind !== 'personal') return;
  await db.query(`update trainer_offers set renewed_membership_id = $3 where id = (select id from trainer_offers where person_id = $1 and club_id = $2 and result in ('agreed', 'thinking')
    and renewed_membership_id is null and created_at > now() - interval '30 days' order by created_at desc limit 1)`, [personId, clubId, membershipId]);
}
