// Шаг 18. Персонал: графики и замены, табель по проходам и отметкам, зарплата по табелю и KPI, ведомость (FR-STAFF-01…08).
import { trainerSessions } from './schedule.ts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { toCsv, toXlsx, type Table } from '../lib/xlsx.ts';
import { monthInfo, salesFact, targets } from './dash.ts';

const GRACE_MIN = 5;          // опоздание считается после 5 минут
const OVERTIME_MIN = 15;      // переработка — от 15 минут сверх графика
const isDate = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const isMonth = (s?: string) => /^\d{4}-\d{2}$/.test(s ?? '');
const isTime = (s?: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s ?? '');
const toMin = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;
const hours = (min: number) => `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ''}`;
const ABS: Record<string, string> = { vacation: 'отпуск', sick: 'больничный', dayoff: 'отгул', unpaid: 'без сохранения' };

async function clubTz(db: Db, clubId: string) {
  const c = (await db.query('select timezone from clubs where id = $1', [clubId])).rows[0];
  if (!c) throw badRequest('Клуб не найден');
  return c.timezone as string;
}
function addDays(d: string, n: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function days(from: string, to: string) { const r: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) r.push(d); return r; }

export type DayRow = {
  day: string; planned: { starts: string; ends: string; minutes: number; breakMinutes: number; replaces: string | null } | null; absence: string | null;
  firstIn: string | null; lastOut: string | null; workedMin: number; breakMin: number; lateMin: number; earlyMin: number; overtimeMin: number;
  marks: { at: string; direction: string; source: string }[]; status: 'ok' | 'late' | 'absent' | 'no_out' | 'extra' | 'off' | 'absence' | 'planned';
};

/** Табель сотрудников клуба за период: план из графика, факт из проходов по карте сотрудника и отметок. */
export async function timesheet(db: Db, clubId: string, from: string, to: string, userIds: string[] | null, today: string) {
  const tz = await clubTz(db, clubId);
  const shifts = (await db.query(
    `select s.user_id, to_char(s.day, 'YYYY-MM-DD') as day, to_char(s.starts, 'HH24:MI') as starts, to_char(s.ends, 'HH24:MI') as ends, s.break_minutes, r.full_name as replaces
     from staff_shifts s left join users r on r.id = s.replaced_user_id where s.club_id = $1 and s.day between $2 and $3 and ($4::uuid[] is null or s.user_id = any($4))`,
    [clubId, from, to, userIds])).rows;
  const abs = (await db.query(`select user_id, kind, to_char(date_from, 'YYYY-MM-DD') as f, to_char(date_to, 'YYYY-MM-DD') as t from staff_absences
    where club_id = $1 and date_to >= $2 and date_from <= $3 and ($4::uuid[] is null or user_id = any($4))`, [clubId, from, to, userIds])).rows;
  const marks = (await db.query(
    `select user_id, at, direction, source, to_char(at at time zone $5, 'YYYY-MM-DD') as day, to_char(at at time zone $5, 'HH24:MI') as hm from (
       select user_id, happened_at as at, direction, 'turnstile' as source from access_events
         where club_id = $1 and user_id is not null and decision = 'allow' and (happened_at at time zone $5)::date between $2 and $3
       union all
       select user_id, at, direction, source from staff_marks where club_id = $1 and (at at time zone $5)::date between $2 and $3
     ) x where ($4::uuid[] is null or user_id = any($4)) order by at`, [clubId, from, to, userIds, tz])).rows;
  const users = new Set<string>([...shifts.map((s) => s.user_id), ...marks.map((m) => m.user_id), ...abs.map((a) => a.user_id), ...(userIds ?? [])]);
  const out: Record<string, { days: DayRow[]; totals: { plannedMin: number; workedMin: number; lateMin: number; lateCount: number; earlyMin: number; overtimeMin: number; shifts: number; workedShifts: number; absentDays: number; absences: Record<string, number> } }> = {};
  for (const u of users) {
    const rows: DayRow[] = [];
    const tot = { plannedMin: 0, workedMin: 0, lateMin: 0, lateCount: 0, earlyMin: 0, overtimeMin: 0, shifts: 0, workedShifts: 0, absentDays: 0, absences: {} as Record<string, number> };
    for (const d of days(from, to)) {
      const sh = shifts.find((s) => s.user_id === u && s.day === d);
      const ab = abs.find((a) => a.user_id === u && a.f <= d && a.t >= d);
      const mk = marks.filter((m) => m.user_id === u && m.day === d);
      if (!sh && !ab && !mk.length) continue;
      // Пары «вход → выход»; промежутки между выходом и следующим входом — перерывы (обед по считывателю)
      let worked = 0; let brk = 0; let open: Date | null = null; let lastOut: Date | null = null;
      for (const m of mk) {
        const at = new Date(m.at);
        if (m.direction === 'in') { if (!open) { if (lastOut) brk += (at.getTime() - lastOut.getTime()) / 60000; open = at; } }
        else if (open) { worked += (at.getTime() - open.getTime()) / 60000; open = null; lastOut = at; }
      }
      const firstIn = mk.find((m) => m.direction === 'in')?.hm ?? null;
      const lastOutHm = [...mk].reverse().find((m) => m.direction === 'out')?.hm ?? null;
      let plannedMin = 0; let late = 0; let early = 0;
      const planned = sh ? { starts: sh.starts, ends: sh.ends, minutes: 0, breakMinutes: sh.break_minutes, replaces: sh.replaces } : null;
      if (planned) {
        let len = toMin(planned.ends) - toMin(planned.starts); if (len <= 0) len += 1440;
        plannedMin = Math.max(0, len - planned.breakMinutes); planned.minutes = plannedMin;
        if (firstIn) { const l = toMin(firstIn) - toMin(planned.starts); if (l > GRACE_MIN) late = l; }
        if (lastOutHm && !open) { const e = toMin(planned.ends) - toMin(lastOutHm); if (e > GRACE_MIN && e < 720) early = e; }
      }
      // Обед не отмечен на считывателе — вычитаем плановый перерыв смены
      if (planned && worked > 0 && brk < 1) worked = Math.max(0, worked - planned.breakMinutes);
      worked = Math.round(worked); brk = Math.round(brk);
      const over = planned && worked - plannedMin >= OVERTIME_MIN ? worked - plannedMin : !planned && worked > 0 ? worked : 0;
      let status: DayRow['status'] = 'ok';
      if (ab) status = 'absence';
      else if (sh && !mk.length) status = d < today ? 'absent' : 'planned';
      else if (open && d < today) status = 'no_out';
      else if (!sh && mk.length) status = 'extra';
      else if (late) status = 'late';
      rows.push({ day: d, planned, absence: ab ? ABS[ab.kind] : null, firstIn, lastOut: lastOutHm, workedMin: worked, breakMin: brk, lateMin: late, earlyMin: early, overtimeMin: over,
        marks: mk.map((m) => ({ at: m.at, direction: m.direction, source: m.source })), status });
      if (sh && !ab) { tot.shifts++; tot.plannedMin += plannedMin; if (worked > 0) tot.workedShifts++; }
      if (ab) tot.absences[ABS[ab.kind]] = (tot.absences[ABS[ab.kind]] ?? 0) + 1;
      if (status === 'absent') tot.absentDays++;
      tot.workedMin += worked; tot.lateMin += late; if (late) tot.lateCount++; tot.earlyMin += early; tot.overtimeMin += over;
    }
    out[u] = { days: rows, totals: tot };
  }
  return out;
}

type Item = { code: string; title: string; basis: string; amountKop: number };

/** Расчёт зарплаты за месяц: каждая строка с расшифровкой, по которой сотрудник может проверить сумму. */
/** Стоимость проведённых персональных тренировок по тренерам: цена пакета клиента ÷ число тренировок в пакете */
export async function personalValue(db: Db, clubId: string, from: string, to: string) {
  return (await db.query(`select s.trainer_id as "userId", count(*)::int as n, coalesce(sum(m.amount_kop::numeric / nullif(p.visits_count, 0)), 0)::bigint as "valueKop"
    from class_bookings b join class_sessions s on s.id = b.session_id join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id
      join memberships m on m.id = b.membership_id join products p on p.id = m.product_id
    where s.club_id = $1 and t.kind = 'personal' and s.status = 'done' and s.trainer_id is not null and (b.status = 'attended' or b.charged)
      and (s.starts_at at time zone c.timezone)::date between $2 and $3 group by s.trainer_id`, [clubId, from, to])).rows.map((r) => ({ userId: r.userId as string, n: r.n as number, valueKop: Number(r.valueKop) }));
}

export async function calcPayroll(db: Db, clubId: string, month: string, today: string) {
  const mi = monthInfo(month, today);
  const schemes = (await db.query(
    `select distinct on (user_id) * from pay_schemes where club_id = $1 and valid_from <= $2 order by user_id, valid_from desc`, [clubId, mi.to])).rows;
  const adj = (await db.query(`select * from payroll_adjustments where club_id = $1 and month = $2`, [clubId, mi.from])).rows;
  const userIds = [...new Set([...schemes.map((s) => s.user_id as string), ...adj.map((a) => a.user_id as string)])];
  if (!userIds.length) return [];
  const ts = await timesheet(db, clubId, mi.from, mi.to, userIds, today);
  const sales = await salesFact(db, [clubId], mi.from, mi.to);
  const plan = await targets(db, [clubId], month);
  const done = await trainerSessions(db, clubId, mi.from, mi.to);
  const personal = await personalValue(db, clubId, mi.from, mi.to);
  const lines: { userId: string; items: Item[]; totalKop: number }[] = [];
  for (const u of userIds) {
    const s = schemes.find((x) => x.user_id === u);
    const t = ts[u]?.totals ?? { plannedMin: 0, workedMin: 0, shifts: 0, workedShifts: 0, lateCount: 0, overtimeMin: 0 };
    const items: Item[] = [];
    if (s) {
      const rate = Number(s.rate_kop);
      if (s.kind === 'salary') {
        const share = t.plannedMin > 0 ? Math.min(1, t.workedMin / t.plannedMin) : 1;
        items.push({ code: 'salary', title: 'Оклад', basis: t.plannedMin > 0 ? `${rub(rate)} × отработано ${hours(t.workedMin)} из ${hours(t.plannedMin)} по графику` : `${rub(rate)}, графика нет — полный оклад`, amountKop: Math.round(rate * share) });
      }
      if (s.kind === 'hourly') items.push({ code: 'hours', title: 'Часы по табелю', basis: `${rub(rate)} в час × ${hours(t.workedMin)}`, amountKop: Math.round((rate * t.workedMin) / 60) });
      if (s.kind === 'shift') items.push({ code: 'shifts', title: 'Смены', basis: `${rub(rate)} за смену × ${t.workedShifts} отработанных из ${t.shifts} по графику`, amountKop: rate * t.workedShifts });
      if (s.kind === 'trainer') {
        const manual = adj.filter((a) => a.user_id === u && a.kind === 'sessions').reduce((x, a) => x + Number(a.quantity ?? 0), 0);
        const sch = done.find((x) => x.userId === u);
        const model = (s.trainer_model ?? 'per_session') as 'per_session' | 'percent' | 'rent';
        if (model === 'per_session') {
          const n = manual + (sch?.n ?? 0);
          const parts = [sch ? `по расписанию ${sch.n} (групповых ${sch.group}, персональных ${sch.personal})` : '', manual ? `вручную ${manual}` : ''].filter(Boolean).join(', ');
          items.push({ code: 'sessions', title: 'Проведённые занятия', basis: `${rub(rate)} за занятие × ${n}${parts ? `: ${parts}` : ''}`, amountKop: Math.round(rate * n) });
        } else {
          // Процент или аренда: групповые и внесённые вручную — по ставке за занятие, персональные — процент от их стоимости по пакету клиента
          const groupN = (sch?.group ?? 0) + manual;
          if (rate > 0 || groupN) items.push({ code: 'sessions', title: 'Групповые занятия', basis: `${rub(rate)} за занятие × ${groupN}${manual ? ` (вручную ${manual})` : ''}`, amountKop: Math.round(rate * groupN) });
          const pv = personal.find((x) => x.userId === u) ?? { n: 0, valueKop: 0 };
          const tp = Number(s.trainer_percent);
          items.push({ code: 'personal', title: 'Персональные тренировки', basis: `${String(tp).replace('.', ',')} % от стоимости ${pv.n} проведённых персональных (${rub(pv.valueKop)} по ценам пакетов клиентов)`, amountKop: Math.round((pv.valueKop * tp) / 100) });
          if (model === 'rent' && Number(s.rent_kop) > 0) items.push({ code: 'rent', title: 'Аренда зала', basis: `аренда за месяц по договору с тренером`, amountKop: -Number(s.rent_kop) });
        }
      }
      const pct = Number(s.sales_percent);
      const mySales = sales.filter((x) => x.userId === u).reduce((a, x) => a + x.kop, 0);
      if (pct > 0) items.push({ code: 'sales', title: 'Процент от продаж', basis: `${String(pct).replace('.', ',')} % от личных продаж ${rub(mySales)} (за вычетом возвратов)`, amountKop: Math.round((mySales * pct) / 100) });
      const bonus = Number(s.plan_bonus_kop);
      if (bonus > 0) {
        const myPlan = plan.filter((x) => x.userId === u).reduce((a, x) => a + x.amountKop, 0);
        const done = myPlan > 0 ? Math.round((mySales / myPlan) * 100) : 0;
        items.push({ code: 'plan_bonus', title: 'Премия за план', basis: myPlan > 0 ? `план ${rub(myPlan)}, выполнено ${done} %, премия от ${s.plan_bonus_threshold} %` : 'личный план на месяц не задан', amountKop: myPlan > 0 && done >= s.plan_bonus_threshold ? bonus : 0 });
      }
    }
    for (const a of adj.filter((x) => x.user_id === u && x.kind !== 'sessions')) {
      const amt = Number(a.amount_kop ?? 0) * (a.kind === 'deduction' ? -1 : 1);
      items.push({ code: a.kind, title: a.kind === 'bonus' ? 'Разовая премия' : a.kind === 'deduction' ? 'Удержание' : 'Корректировка прошлых месяцев', basis: a.reason, amountKop: amt });
    }
    lines.push({ userId: u, items, totalKop: items.reduce((x, i) => x + i.amountKop, 0) });
  }
  return lines;
}

async function clubToday(db: Db, clubId: string) {
  return (await db.query(`select to_char(now() at time zone timezone, 'YYYY-MM-DD') as d from clubs where id = $1`, [clubId])).rows[0]?.d as string;
}
function requireClub(ctx: Ctx, clubId?: string) {
  if (!clubId || !/^[0-9a-f-]{36}$/i.test(clubId)) throw badRequest('Выберите клуб');
  if (!ctx.allClubs && !ctx.clubIds.includes(clubId)) throw forbidden('Не ваш клуб');
  return clubId;
}
async function clubUser(db: Db, clubId: string, userId?: string) {
  if (!userId) throw badRequest('Выберите сотрудника');
  const u = (await db.query(`select u.id, u.full_name from users u where u.id = $1 and exists (select 1 from user_assignments a where a.user_id = u.id and (a.club_id = $2 or a.club_id is null))`, [userId, clubId])).rows[0];
  if (!u) throw badRequest('Сотрудник не работает в этом клубе');
  return u;
}

export function staffTimeRoutes(app: FastifyInstance, pool: pg.Pool) {
  /* ---------- график ---------- */
  app.get('/api/staff-time/schedule', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { clubId?: string; from?: string; to?: string };
    const clubId = requireClub(ctx, q.clubId);
    if (!isDate(q.from) || !isDate(q.to) || q.to! < q.from!) throw badRequest('Укажите период');
    const all = can(ctx, P.staffSchedule) || can(ctx, P.staffView);
    return withCtx(pool, ctx, async (db) => {
      const staff = (await db.query(
        `select distinct u.id, u.full_name as "fullName", (select r.name from user_assignments a2 join roles r on r.code = a2.role_code where a2.user_id = u.id and (a2.club_id = $1 or a2.club_id is null) order by r.sort limit 1) as role
         from users u join user_assignments a on a.user_id = u.id where (a.club_id = $1) and u.status = 'active' and ($2::uuid is null or u.id = $2) order by 2`, [clubId, all ? null : ctx.userId])).rows;
      const shifts = (await db.query(
        `select s.id, s.user_id as "userId", to_char(s.day, 'YYYY-MM-DD') as day, to_char(s.starts, 'HH24:MI') as starts, to_char(s.ends, 'HH24:MI') as ends, s.break_minutes as "breakMinutes",
           s.replaced_user_id as "replacedUserId", r.full_name as "replacedName", s.note
         from staff_shifts s left join users r on r.id = s.replaced_user_id where s.club_id = $1 and s.day between $2 and $3 and ($4::uuid is null or s.user_id = $4) order by s.day, s.starts`,
        [clubId, q.from, q.to, all ? null : ctx.userId])).rows;
      const absences = (await db.query(`select id, user_id as "userId", kind, to_char(date_from, 'YYYY-MM-DD') as "from", to_char(date_to, 'YYYY-MM-DD') as "to", comment
        from staff_absences where club_id = $1 and date_to >= $2 and date_from <= $3 and ($4::uuid is null or user_id = $4)`, [clubId, q.from, q.to, all ? null : ctx.userId])).rows;
      return { staff, shifts, absences, canEdit: can(ctx, P.staffSchedule) };
    });
  });

  // Смены: одна или серия по дням недели («2/2», «5/2» задаются выбором дней)
  app.post('/api/staff-time/shifts', async (req, reply) => {
    const ctx = requirePerm(req, P.staffSchedule);
    const b = (req.body ?? {}) as { clubId?: string; userId?: string; days?: string[]; starts?: string; ends?: string; breakMinutes?: number; note?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (!Array.isArray(b.days) || !b.days.length || b.days.length > 62 || !b.days.every((d) => isDate(d))) throw badRequest('Выберите дни смен');
    if (!isTime(b.starts) || !isTime(b.ends) || b.starts === b.ends) throw badRequest('Укажите время начала и окончания смены');
    const brk = Math.max(0, Math.min(240, Math.floor(b.breakMinutes ?? 0)));
    const res = await withCtx(pool, ctx, async (db) => {
      await clubUser(db, clubId, b.userId);
      let created = 0; const conflicts: string[] = [];
      for (const d of b.days!) {
        const busy = (await db.query(`select 1 from staff_shifts where user_id = $1 and day = $2`, [b.userId, d])).rowCount;
        if (busy) { conflicts.push(d); continue; }
        await db.query(`insert into staff_shifts(tenant_id, club_id, user_id, day, starts, ends, break_minutes, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ctx.tenantId, clubId, b.userId, d, b.starts, b.ends, brk, b.note?.trim() || null, ctx.userId]);
        created++;
      }
      await audit(db, ctx, 'staff.shifts_created', 'user', b.userId!, null, { days: b.days, starts: b.starts, ends: b.ends });
      return { created, conflicts };
    });
    reply.code(201);
    return res;
  });

  app.delete('/api/staff-time/shifts/:id', async (req) => {
    const ctx = requirePerm(req, P.staffSchedule);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query('delete from staff_shifts where id = $1 returning user_id, day', [id])).rows[0];
      if (!s) throw notFound('Смена не найдена');
      await audit(db, ctx, 'staff.shift_deleted', 'user', s.user_id, s, null);
      return { ok: true };
    });
  });

  // Замена: смену отрабатывает другой сотрудник, оплата за неё идёт ему
  app.post('/api/staff-time/shifts/:id/replace', async (req) => {
    const ctx = requirePerm(req, P.staffSchedule);
    const { id } = req.params as { id: string };
    const { userId } = (req.body ?? {}) as { userId?: string };
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query('select * from staff_shifts where id = $1', [id])).rows[0];
      if (!s) throw notFound('Смена не найдена');
      await clubUser(db, s.club_id, userId);
      if (userId === s.user_id) throw badRequest('Выберите другого сотрудника');
      if ((await db.query('select 1 from staff_shifts where user_id = $1 and day = $2', [userId, s.day])).rowCount) throw badRequest('У заменяющего в этот день уже есть смена');
      await db.query('update staff_shifts set user_id = $2, replaced_user_id = coalesce(replaced_user_id, $3) where id = $1', [id, userId, s.user_id]);
      await audit(db, ctx, 'staff.shift_replaced', 'user', s.user_id, { userId: s.user_id }, { userId });
      return { ok: true };
    });
  });

  app.post('/api/staff-time/absences', async (req, reply) => {
    const ctx = requirePerm(req, P.staffSchedule);
    const b = (req.body ?? {}) as { clubId?: string; userId?: string; kind?: string; from?: string; to?: string; comment?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (!ABS[b.kind ?? '']) throw badRequest('Выберите: отпуск, больничный, отгул или без сохранения');
    if (!isDate(b.from) || !isDate(b.to) || b.to! < b.from!) throw badRequest('Укажите период');
    const r = await withCtx(pool, ctx, async (db) => {
      await clubUser(db, clubId, b.userId);
      const id = (await db.query(`insert into staff_absences(tenant_id, club_id, user_id, kind, date_from, date_to, comment, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, clubId, b.userId, b.kind, b.from, b.to, b.comment?.trim() || null, ctx.userId])).rows[0].id;
      const clash = (await db.query(`select to_char(day, 'YYYY-MM-DD') as d from staff_shifts where user_id = $1 and club_id = $2 and day between $3 and $4 order by day`, [b.userId, clubId, b.from, b.to])).rows.map((x) => x.d);
      await audit(db, ctx, 'staff.absence_added', 'user', b.userId!, null, { kind: b.kind, from: b.from, to: b.to });
      return { id, shiftsToReplace: clash };
    });
    reply.code(201);
    return r;
  });

  app.delete('/api/staff-time/absences/:id', async (req) => {
    const ctx = requirePerm(req, P.staffSchedule);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const a = (await db.query('delete from staff_absences where id = $1 returning user_id, kind', [id])).rows[0];
      if (!a) throw notFound('Запись не найдена');
      await audit(db, ctx, 'staff.absence_deleted', 'user', a.user_id, a, null);
      return { ok: true };
    });
  });

  /* ---------- отметки ---------- */
  // Сотрудник сам отмечает приход и уход в приложении (если у клуба нет считывателя или забыл карту)
  app.post('/api/staff-time/mark', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { clubId?: string; direction?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (b.direction !== 'in' && b.direction !== 'out') throw badRequest('Приход или уход?');
    return withCtx(pool, ctx, async (db) => {
      const last = (await db.query(`select at from staff_marks where user_id = $1 and direction = $2 and at > now() - interval '2 minutes'`, [ctx.userId, b.direction])).rowCount;
      if (!last) await db.query(`insert into staff_marks(tenant_id, club_id, user_id, at, direction, source, created_by) values ($1,$2,$3, now(), $4, 'app', $3)`, [ctx.tenantId, clubId, ctx.userId, b.direction]);
      return { ok: true, at: new Date().toISOString() };
    });
  });

  // Исправление табеля руководителем: только с причиной, пишется в журнал
  app.post('/api/staff-time/marks', async (req, reply) => {
    const ctx = requirePerm(req, P.staffSchedule);
    const b = (req.body ?? {}) as { clubId?: string; userId?: string; at?: string; direction?: string; reason?: string };
    const clubId = requireClub(ctx, b.clubId);
    const at = b.at ? new Date(b.at) : null;
    if (!at || Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000) throw badRequest('Укажите время отметки (не в будущем)');
    if (b.direction !== 'in' && b.direction !== 'out') throw badRequest('Приход или уход?');
    if (!b.reason?.trim()) throw badRequest('Укажите причину исправления', 'reason_required');
    const r = await withCtx(pool, ctx, async (db) => {
      await clubUser(db, clubId, b.userId);
      const id = (await db.query(`insert into staff_marks(tenant_id, club_id, user_id, at, direction, source, reason, created_by) values ($1,$2,$3,$4,$5,'manual',$6,$7) returning id`,
        [ctx.tenantId, clubId, b.userId, at, b.direction, b.reason!.trim(), ctx.userId])).rows[0].id;
      await audit(db, ctx, 'staff.mark_corrected', 'user', b.userId!, null, { at, direction: b.direction, reason: b.reason });
      return { id };
    });
    reply.code(201);
    return r;
  });

  /* ---------- табель ---------- */
  app.get('/api/staff-time/timesheet', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { clubId?: string; month?: string; userId?: string };
    const clubId = requireClub(ctx, q.clubId);
    if (!isMonth(q.month)) throw badRequest('Укажите месяц');
    const all = can(ctx, P.staffSchedule) || can(ctx, P.payrollManage);
    if (q.userId && q.userId !== ctx.userId && !all) throw forbidden('Табель других сотрудников видит руководитель');
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const mi = monthInfo(q.month!, today);
      const ids = all ? (q.userId ? [q.userId] : null) : [ctx.userId];
      const ts = await timesheet(db, clubId, mi.from, mi.to, ids, today);
      const names = Object.fromEntries((await db.query('select id, full_name from users where id = any($1)', [Object.keys(ts)])).rows.map((r) => [r.id, r.full_name]));
      return { month: q.month, rows: Object.entries(ts).map(([userId, v]) => ({ userId, name: names[userId] ?? '—', ...v })).sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
    });
  });

  /* ---------- нагрузка от нормы (FR-STAFF-06): сколько должен и сколько сделал ---------- */
  app.get('/api/staff-time/load', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { clubId?: string; month?: string; mine?: string };
    const clubId = requireClub(ctx, q.clubId);
    if (!/^\d{4}-\d{2}$/.test(q.month ?? '')) throw badRequest('Укажите месяц');
    const all = (can(ctx, P.staffSchedule) || can(ctx, P.payrollManage) || can(ctx, P.dashView)) && !q.mine;
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const mi = monthInfo(q.month!, today);
      const to = mi.current ? today : mi.to;
      const staff = (await db.query(`select distinct u.id, u.full_name as name,
          (select r.name from user_assignments a2 join roles r on r.code = a2.role_code where a2.user_id = u.id and (a2.club_id = $1 or a2.club_id is null) order by r.sort limit 1) as role,
          (select a2.role_code from user_assignments a2 join roles r on r.code = a2.role_code where a2.user_id = u.id and (a2.club_id = $1 or a2.club_id is null) order by r.sort limit 1) as code
        from users u join user_assignments a on a.user_id = u.id where a.club_id = $1 and u.status = 'active' and ($2::uuid is null or u.id = $2) order by 2`, [clubId, all ? null : ctx.userId])).rows;
      if (!staff.length) return { month: q.month, rows: [] };
      const ids = staff.map((x) => x.id as string);
      const ts = await timesheet(db, clubId, mi.from, to, ids, today);
      const schemes = (await db.query(`select distinct on (user_id) user_id, sessions_norm from pay_schemes where club_id = $1 and valid_from <= $2 order by user_id, valid_from desc`, [clubId, mi.to])).rows;
      const done = await trainerSessions(db, clubId, mi.from, to);
      const sales = await salesFact(db, [clubId], mi.from, to);
      const plan = await targets(db, [clubId], q.month!);
      // Норма за прошедшую часть месяца — пропорционально дням
      const share = mi.current ? mi.passed / mi.days : 1;
      const pct = (f: number, p: number) => (p > 0 ? Math.round((f * 100) / p) : null);
      const rows = staff.map((u) => {
        const t = ts[u.id]?.totals;
        const metrics: { name: string; plan: string; fact: string; pct: number | null }[] = [];
        if (t && t.plannedMin) metrics.push({ name: 'Часы по графику', plan: hours(t.plannedMin), fact: hours(t.workedMin), pct: pct(t.workedMin, t.plannedMin) });
        if (t && t.shifts) metrics.push({ name: 'Смены', plan: String(t.shifts), fact: String(t.workedShifts), pct: pct(t.workedShifts, t.shifts) });
        const norm = schemes.find((x) => x.user_id === u.id)?.sessions_norm as number | null | undefined;
        const d = done.find((x) => x.userId === u.id);
        if (u.code === 'trainer' || d || norm) {
          const planN = norm ? Math.round(norm * share) : 0;
          metrics.push({ name: 'Проведено занятий', plan: norm ? `${planN} из ${norm} в месяц` : 'норма не задана', fact: String(d?.n ?? 0), pct: norm ? pct(d?.n ?? 0, planN) : null });
        }
        const myPlan = plan.filter((x) => x.userId === u.id).reduce((a, x) => a + x.amountKop, 0);
        const mySales = sales.filter((x) => x.userId === u.id).reduce((a, x) => a + x.kop, 0);
        if (myPlan || mySales) {
          const planNow = Math.round(myPlan * share);
          metrics.push({ name: 'Продажи', plan: myPlan ? `${rub(planNow)} из ${rub(myPlan)}` : 'план не задан', fact: rub(mySales), pct: myPlan ? pct(mySales, planNow) : null });
        }
        const issues = [t?.lateCount ? `опозданий ${t.lateCount}` : '', t?.absentDays ? `прогулов ${t.absentDays}` : '', t?.earlyMin ? `ушёл раньше на ${hours(t.earlyMin)}` : '', t?.overtimeMin ? `переработка ${hours(t.overtimeMin)}` : ''].filter(Boolean);
        const worst = metrics.map((m) => m.pct).filter((x): x is number => x !== null);
        const level = worst.length ? Math.min(...worst) : null;
        return { userId: u.id, name: u.name, role: u.role, metrics, issues, level, light: level === null ? 'none' : level >= 95 ? 'green' : level >= 80 ? 'yellow' : 'red' };
      });
      return { month: q.month, from: mi.from, to, rows };
    });
  });

  /* ---------- зарплата ---------- */
  app.get('/api/payroll/schemes', async (req) => {
    const ctx = requirePerm(req, P.payrollManage);
    const clubId = requireClub(ctx, (req.query as { clubId?: string }).clubId);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select s.id, s.user_id as "userId", u.full_name as "name", to_char(s.valid_from, 'YYYY-MM-DD') as "validFrom", s.kind, s.rate_kop::bigint as "rateKop", s.sales_percent::float as "salesPercent",
         s.plan_bonus_kop::bigint as "planBonusKop", s.plan_bonus_threshold as "planBonusThreshold", s.trainer_model as "trainerModel", s.trainer_percent::float as "trainerPercent",
         s.rent_kop::bigint as "rentKop", s.sessions_norm as "sessionsNorm"
       from pay_schemes s join users u on u.id = s.user_id where s.club_id = $1 order by u.full_name, s.valid_from desc`, [clubId])).rows
      .map((r) => ({ ...r, rateKop: Number(r.rateKop), planBonusKop: Number(r.planBonusKop), rentKop: Number(r.rentKop) })));
  });

  app.post('/api/payroll/schemes', async (req, reply) => {
    const ctx = requirePerm(req, P.payrollManage);
    const b = (req.body ?? {}) as { clubId?: string; userId?: string; validFrom?: string; kind?: string; rateKop?: number; salesPercent?: number; planBonusKop?: number; planBonusThreshold?: number; trainerModel?: string; trainerPercent?: number; rentKop?: number; sessionsNorm?: number | null };
    const clubId = requireClub(ctx, b.clubId);
    const model = b.kind === 'trainer' ? b.trainerModel ?? 'per_session' : 'per_session';
    if (!['per_session', 'percent', 'rent'].includes(model)) throw badRequest('Выберите модель оплаты тренера');
    if (b.sessionsNorm != null && !(Number.isInteger(b.sessionsNorm) && b.sessionsNorm >= 1 && b.sessionsNorm <= 1000)) throw badRequest('Норма занятий — целое число от 1 до 1000');
    if (!['salary', 'hourly', 'shift', 'trainer'].includes(b.kind ?? '')) throw badRequest('Выберите вид оплаты');
    if (!isDate(b.validFrom)) throw badRequest('С какой даты действует схема?');
    const n = (v: unknown, max: number) => { const x = Number(v ?? 0); if (!Number.isFinite(x) || x < 0 || x > max) throw badRequest('Проверьте суммы и проценты'); return x; };
    const r = await withCtx(pool, ctx, async (db) => {
      await clubUser(db, clubId, b.userId);
      const closed = (await db.query(`select 1 from payroll_periods where club_id = $1 and status = 'approved' and month >= date_trunc('month', $2::date)`, [clubId, b.validFrom])).rowCount;
      if (closed) throw badRequest('За этот месяц ведомость уже утверждена: схема может действовать только со следующего');
      const id = (await db.query(
        `insert into pay_schemes(tenant_id, club_id, user_id, valid_from, kind, rate_kop, sales_percent, plan_bonus_kop, plan_bonus_threshold, created_by, trainer_model, trainer_percent, rent_kop, sessions_norm)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (club_id, user_id, valid_from) do update set kind = excluded.kind, rate_kop = excluded.rate_kop, sales_percent = excluded.sales_percent,
           plan_bonus_kop = excluded.plan_bonus_kop, plan_bonus_threshold = excluded.plan_bonus_threshold, trainer_model = excluded.trainer_model,
           trainer_percent = excluded.trainer_percent, rent_kop = excluded.rent_kop, sessions_norm = excluded.sessions_norm returning id`,
        [ctx.tenantId, clubId, b.userId, b.validFrom, b.kind, Math.round(n(b.rateKop, 1e11)), n(b.salesPercent, 100), Math.round(n(b.planBonusKop, 1e11)), Math.round(n(b.planBonusThreshold ?? 100, 200)) || 100, ctx.userId,
          model, n(b.trainerPercent, 100), Math.round(n(b.rentKop, 1e11)), b.sessionsNorm ?? null])).rows[0].id;
      await audit(db, ctx, 'payroll.scheme_saved', 'user', b.userId!, null, b);
      return { id };
    });
    reply.code(201);
    return r;
  });

  app.get('/api/payroll/adjustments', async (req) => {
    const ctx = requirePerm(req, P.payrollManage);
    const q = req.query as { clubId?: string; month?: string };
    const clubId = requireClub(ctx, q.clubId);
    if (!isMonth(q.month)) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, async (db) => (await db.query(`select a.id, a.user_id as "userId", u.full_name as name, a.kind, a.quantity::float, a.amount_kop::bigint as "amountKop", a.reason
      from payroll_adjustments a join users u on u.id = a.user_id where a.club_id = $1 and a.month = $2 order by a.created_at`, [clubId, `${q.month}-01`])).rows.map((r) => ({ ...r, amountKop: r.amountKop == null ? null : Number(r.amountKop) })));
  });

  app.post('/api/payroll/adjustments', async (req, reply) => {
    const ctx = requirePerm(req, P.payrollManage);
    const b = (req.body ?? {}) as { clubId?: string; userId?: string; month?: string; kind?: string; quantity?: number; amountKop?: number; reason?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (!isMonth(b.month)) throw badRequest('Укажите месяц');
    if (!['sessions', 'bonus', 'deduction', 'correction'].includes(b.kind ?? '')) throw badRequest('Выберите вид строки');
    if (!b.reason?.trim()) throw badRequest('Укажите основание', 'reason_required');
    if (b.kind === 'sessions' && !(Number(b.quantity) > 0)) throw badRequest('Укажите число занятий');
    if (b.kind !== 'sessions' && !(Number.isFinite(Number(b.amountKop)) && Number(b.amountKop) !== 0)) throw badRequest('Укажите сумму');
    if (b.kind !== 'correction' && b.kind !== 'sessions' && Number(b.amountKop) < 0) throw badRequest('Сумма премии или удержания указывается положительной');
    const r = await withCtx(pool, ctx, async (db) => {
      await clubUser(db, clubId, b.userId);
      const p = (await db.query(`select status from payroll_periods where club_id = $1 and month = $2`, [clubId, `${b.month}-01`])).rows[0];
      if (p?.status === 'approved') throw badRequest('Ведомость за этот месяц утверждена. Внесите корректировку в следующем месяце', 'period_approved');
      const id = (await db.query(`insert into payroll_adjustments(tenant_id, club_id, user_id, month, kind, quantity, amount_kop, reason, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, clubId, b.userId, `${b.month}-01`, b.kind, b.kind === 'sessions' ? Number(b.quantity) : null, b.kind === 'sessions' ? null : Math.round(Number(b.amountKop)), b.reason!.trim(), ctx.userId])).rows[0].id;
      await audit(db, ctx, 'payroll.adjustment_added', 'user', b.userId!, null, b);
      return { id };
    });
    reply.code(201);
    return r;
  });

  const loadPeriod = async (db: Db, clubId: string, month: string) => {
    const p = (await db.query(`select p.id, p.status, p.calculated_at as "calculatedAt", p.approved_at as "approvedAt", u.full_name as "approvedBy"
      from payroll_periods p left join users u on u.id = p.approved_by where p.club_id = $1 and p.month = $2`, [clubId, `${month}-01`])).rows[0] ?? null;
    const lines = p ? (await db.query(`select l.user_id as "userId", u.full_name as name, l.items, l.total_kop::bigint as "totalKop" from payroll_lines l join users u on u.id = l.user_id
      where l.period_id = $1 order by u.full_name`, [p.id])).rows.map((r) => ({ ...r, totalKop: Number(r.totalKop) })) : [];
    return { period: p, lines, totalKop: lines.reduce((a, l) => a + l.totalKop, 0) };
  };

  app.get('/api/payroll', async (req) => {
    const ctx = requirePerm(req, P.payrollManage);
    const q = req.query as { clubId?: string; month?: string };
    const clubId = requireClub(ctx, q.clubId);
    if (!isMonth(q.month)) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, (db) => loadPeriod(db, clubId, q.month!));
  });

  app.post('/api/payroll/calculate', async (req) => {
    const ctx = requirePerm(req, P.payrollManage);
    const b = (req.body ?? {}) as { clubId?: string; month?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (!isMonth(b.month)) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      let p = (await db.query(`select id, status from payroll_periods where club_id = $1 and month = $2 for update`, [clubId, `${b.month}-01`])).rows[0];
      if (p?.status === 'approved') throw badRequest('Ведомость утверждена: пересчёт невозможен. Исправления — корректировкой в следующем месяце', 'period_approved');
      if (!p) p = (await db.query(`insert into payroll_periods(tenant_id, club_id, month) values ($1,$2,$3) returning id, status`, [ctx.tenantId, clubId, `${b.month}-01`])).rows[0];
      const lines = await calcPayroll(db, clubId, b.month!, today);
      await db.query('delete from payroll_lines where period_id = $1', [p.id]);
      for (const l of lines) await db.query(`insert into payroll_lines(tenant_id, club_id, period_id, user_id, items, total_kop) values ($1,$2,$3,$4,$5,$6)`,
        [ctx.tenantId, clubId, p.id, l.userId, JSON.stringify(l.items), l.totalKop]);
      await db.query('update payroll_periods set calculated_at = now() where id = $1', [p.id]);
      await audit(db, ctx, 'payroll.calculated', 'club', clubId, null, { month: b.month, lines: lines.length });
      return loadPeriod(db, clubId, b.month!);
    });
  });

  app.post('/api/payroll/approve', async (req) => {
    const ctx = requirePerm(req, P.payrollManage);
    const b = (req.body ?? {}) as { clubId?: string; month?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (!isMonth(b.month)) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query(`select id, status, calculated_at from payroll_periods where club_id = $1 and month = $2 for update`, [clubId, `${b.month}-01`])).rows[0];
      if (!p?.calculated_at) throw badRequest('Сначала рассчитайте ведомость');
      if (p.status === 'approved') throw badRequest('Ведомость уже утверждена');
      await db.query(`update payroll_periods set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [p.id, ctx.userId]);
      const r = await loadPeriod(db, clubId, b.month!);
      await audit(db, ctx, 'payroll.approved', 'club', clubId, null, { month: b.month, totalKop: r.totalKop });
      return r;
    });
  });

  app.get('/api/payroll/export', async (req, reply) => {
    const ctx = requirePerm(req, P.payrollManage);
    const q = req.query as { clubId?: string; month?: string; format?: string };
    const clubId = requireClub(ctx, q.clubId);
    if (!isMonth(q.month)) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, async (db) => {
      const r = await loadPeriod(db, clubId, q.month!);
      if (!r.period) throw badRequest('Ведомость за этот месяц не рассчитана');
      const t: Table = { title: `Ведомость ${q.month}`, columns: ['Сотрудник', 'Начисление', 'Основание', 'Сумма, ₽'], rows: [] };
      for (const l of r.lines) {
        for (const i of l.items as Item[]) t.rows.push([l.name, i.title, i.basis, i.amountKop / 100]);
        t.rows.push([l.name, 'Итого', r.period.status === 'approved' ? 'утверждено' : 'черновик', l.totalKop / 100]);
      }
      await audit(db, ctx, 'payroll.exported', 'club', clubId, null, { month: q.month, format: q.format });
      const csv = q.format === 'csv';
      reply.header('Content-Type', csv ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="payroll-${q.month}.${csv ? 'csv' : 'xlsx'}"`);
      return reply.send(csv ? toCsv(t) : toXlsx(t));
    });
  });

  // Сотрудник видит свой табель и свою ведомость с расшифровкой каждой строки
  app.get('/api/payroll/my', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { month?: string };
    if (!isMonth(q.month)) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select c.name as "clubName", p.status, l.items, l.total_kop::bigint as "totalKop" from payroll_lines l join payroll_periods p on p.id = l.period_id join clubs c on c.id = l.club_id
       where l.user_id = $1 and p.month = $2`, [ctx.userId, `${q.month}-01`])).rows.map((r) => ({ ...r, totalKop: Number(r.totalKop) })));
  });
}

/** AT27: заявка пришла, когда ответственного нет на смене.
 *  Если в клубе ведётся график: передаём тому продавцу, кто сейчас на смене («дежурному»),
 *  иначе срок первого ответа переносится на начало ближайшей смены. Без графика ничего не меняется. */
export async function routeByShifts(db: Db, clubId: string, assignee: string | null, explicit: boolean, firstResponseMin: number) {
  const shifts = (await db.query(`
    select s.user_id, (s.day + s.starts) at time zone c.timezone as st,
      (s.day + s.ends + case when s.ends <= s.starts then interval '1 day' else interval '0' end) at time zone c.timezone as en
    from staff_shifts s join clubs c on c.id = s.club_id
    where s.club_id = $1 and s.day between (now() at time zone c.timezone)::date - 1 and (now() at time zone c.timezone)::date + 7
      and exists (select 1 from user_assignments a join users u on u.id = a.user_id where a.user_id = s.user_id and a.club_id = $1 and a.role_code in ('manager', 'rop') and u.status = 'active')
      and not exists (select 1 from staff_absences b where b.user_id = s.user_id and b.club_id = $1 and s.day between b.date_from and b.date_to)
    order by st`, [clubId])).rows as { user_id: string; st: Date; en: Date }[];
  if (!shifts.length) return null;
  const now = Date.now();
  const onNow = shifts.filter((s) => s.st.getTime() <= now && s.en.getTime() > now);
  if (assignee && onNow.some((s) => s.user_id === assignee)) return null;
  if (!explicit && onNow.length) {
    // Дежурный: из тех, кто на смене, — у кого меньше открытых сделок
    const ids = [...new Set(onNow.map((s) => s.user_id))];
    const duty = (await db.query(`select u, (select count(*) from opportunities o where o.owner_id = u and o.status = 'open') as n from unnest($1::uuid[]) u order by 2, 1 limit 1`, [ids])).rows[0].u as string;
    return { assignee: duty, dueAt: null as Date | null, note: 'дежурному' };
  }
  const future = shifts.filter((s) => s.st.getTime() > now);
  const mineNext = future.find((s) => s.user_id === assignee);
  const next = explicit ? mineNext : mineNext && future[0] && mineNext.st.getTime() === future[0].st.getTime() ? mineNext : future[0];
  if (!next) return null;
  return { assignee: explicit ? assignee : next.user_id, dueAt: new Date(next.st.getTime() + firstResponseMin * 60_000), note: 'на начало смены' };
}
