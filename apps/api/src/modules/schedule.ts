// Расписание занятий и запись клиентов (FR-MEM-12, список «20 новых возможностей», п. 1).
// Залы и виды занятий, занятия с повтором по неделям, запись с листом ожидания, отмена с автоматическим
// освобождением места, напоминания за сутки и за 2 часа, списание персональных из пакета, проведённые занятия — в зарплату тренера.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { maskPhone } from './crm.ts';
import { conversationFor, deliver, firstName, queueMessage } from './messaging.ts';
import type { Fetch } from './msgProviders.ts';

type Actor = { tenantId: string; userId: string | null };
const isDate = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const isLocal = (s?: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s ?? '');
const uuid = (s?: string | null) => !!s && /^[0-9a-f-]{36}$/i.test(s);

export const DEFAULT_CLASS_SETTINGS = { lateCancelHours: 12, chargePersonalLate: true, chargeGroupNoShow: false, noShowLimit: null as number | null, noShowBlockDays: 7, remind24: true, remind2: true, bookAheadDays: 14 };
export async function classSettings(db: Db, clubId: string) {
  const r = (await db.query(`select late_cancel_hours as "lateCancelHours", charge_personal_late as "chargePersonalLate", charge_group_no_show as "chargeGroupNoShow",
    no_show_limit as "noShowLimit", no_show_block_days as "noShowBlockDays", remind_24 as "remind24", remind_2 as "remind2", book_ahead_days as "bookAheadDays"
    from club_class_settings where club_id = $1`, [clubId])).rows[0];
  return (r ?? DEFAULT_CLASS_SETTINGS) as typeof DEFAULT_CLASS_SETTINGS;
}

/** Сообщение клиенту в мессенджер (служебное: не реклама). false — нет мессенджера или клиент отписался */
export async function notifyPerson(db: Db, f: Fetch | null, actor: Actor, personId: string, clubId: string, text: string) {
  const p = (await db.query('select messaging_opt_out from persons where id = $1', [personId])).rows[0];
  if (!p || p.messaging_opt_out) return false;
  const conv = await conversationFor(db, actor, personId, clubId, true);
  if (!conv || conv === 'new') return false;
  const mid = await queueMessage(db, actor, conv, text, { auto: true });
  await db.query('update msg_conversations set last_message_at = now() where id = $1', [conv]);
  if (f) await deliver(db, f, mid);
  return true;
}

const SESSION = `select s.id, s.club_id as "clubId", s.type_id as "typeId", t.name as "typeName", t.kind, s.room_id as "roomId", r.name as "roomName",
  s.trainer_id as "trainerId", u.full_name as "trainerName", s.starts_at as "startsAt", s.ends_at as "endsAt",
  to_char(s.starts_at at time zone c.timezone, 'YYYY-MM-DD"T"HH24:MI') as "localStart", to_char(s.ends_at at time zone c.timezone, 'HH24:MI') as "localEnd",
  s.capacity, s.status, s.series_id as "seriesId", s.note, s.cancel_reason as "cancelReason",
  (select count(*)::int from class_bookings b where b.session_id = s.id and b.status in ('booked', 'attended', 'no_show')) as booked,
  (select count(*)::int from class_bookings b where b.session_id = s.id and b.status = 'waitlist') as waitlist
  from class_sessions s join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id
  left join rooms r on r.id = s.room_id left join users u on u.id = s.trainer_id`;

async function loadSession(db: Db, id: string) {
  if (!uuid(id)) throw notFound('Занятие не найдено');
  const s = (await db.query(`${SESSION} where s.id = $1`, [id])).rows[0];
  if (!s) throw notFound('Занятие не найдено');
  return s;
}
const ruTime = (local: string) => `${local.slice(8, 10)}.${local.slice(5, 7)} в ${local.slice(11, 16)}`;

/** Подходящий абонемент на дату занятия. Персональное — пакет персональных с остатком с учётом уже записанных занятий */
async function pickMembership(db: Db, personId: string, clubId: string, kind: string, day: string, excludeBooking?: string) {
  const rows = (await db.query(`select m.id, m.kind, m.visits_left, m.product_name,
      (select count(*)::int from class_bookings b where b.membership_id = m.id and b.status = 'booked' and not b.charged and b.id is distinct from $5) as reserved
    from memberships m where m.person_id = $1 and m.club_id = $2 and m.status = 'active' and m.starts_on <= $3 and (m.ends_on is null or m.ends_on >= $3)
      and not exists (select 1 from freezes f where f.membership_id = m.id and f.starts_on <= $3 and coalesce(f.ended_early_on - 1, f.ends_on) >= $3)
      and m.kind = any($4)
    order by case m.kind when 'subscription' then 0 when 'term' then 1 else 2 end, m.ends_on nulls last`,
  [personId, clubId, day, kind === 'personal' ? ['personal'] : ['subscription', 'term', 'visits'], excludeBooking ?? null])).rows;
  return rows.find((m) => m.visits_left === null || Number(m.visits_left) - (kind === 'personal' ? Number(m.reserved) : 0) > 0) ?? null;
}

/** Списание занятия из пакета: остаток уменьшается, в истории абонемента появляется операция */
async function chargeBooking(db: Db, actor: Actor, b: { id: string; club_id: string; membership_id: string | null }, reason: string, sessionId: string) {
  if (!b.membership_id) return false;
  const r = await db.query(`update memberships set visits_left = visits_left - 1, updated_at = now() where id = $1 and visits_left > 0 returning visits_left`, [b.membership_id]);
  if (!r.rowCount) return false;
  await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'class_charge',$4,$5)`,
    [actor.tenantId, b.club_id, b.membership_id, { sessionId, bookingId: b.id, reason, visitsLeft: r.rows[0].visits_left }, actor.userId]);
  await db.query('update class_bookings set charged = true where id = $1', [b.id]);
  return true;
}

/** Первое место из листа ожидания — записанному; клиенту уходит сообщение */
async function promoteWaitlist(db: Db, f: Fetch | null, actor: Actor, sessionId: string) {
  const s = await loadSession(db, sessionId);
  if (s.status !== 'scheduled' || new Date(s.startsAt) <= new Date()) return null;
  if (s.booked >= s.capacity) return null;
  const w = (await db.query(`select b.id, b.person_id, b.trial from class_bookings b where b.session_id = $1 and b.status = 'waitlist' order by b.waitlist_at, b.created_at limit 1 for update`, [sessionId])).rows[0];
  if (!w) return null;
  const day = s.localStart.slice(0, 10);
  const m = w.trial ? null : await pickMembership(db, w.person_id, s.clubId, s.kind, day, w.id);
  if (!w.trial && !m) {
    // Абонемент закончился, пока клиент ждал: снимаем из листа ожидания и пробуем следующего
    await db.query(`update class_bookings set status = 'cancelled', cancelled_at = now() where id = $1`, [w.id]);
    return promoteWaitlist(db, f, actor, sessionId);
  }
  await db.query(`update class_bookings set status = 'booked', membership_id = $2 where id = $1`, [w.id, m?.id ?? null]);
  const p = (await db.query('select full_name from persons where id = $1', [w.person_id])).rows[0];
  await notifyPerson(db, f, actor, w.person_id, s.clubId, `${firstName(p.full_name)}, освободилось место: вы записаны на «${s.typeName}» ${ruTime(s.localStart)}. Если не сможете прийти, предупредите нас.`);
  return w.id as string;
}

export async function bookPerson(db: Db, f: Fetch | null, ctx: Pick<Ctx, 'tenantId' | 'userId'>, sessionId: string, personId: string, trial = false) {
  const s = await loadSession(db, sessionId);
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`class:${sessionId}`]);
  if (s.status !== 'scheduled') throw badRequest(s.status === 'cancelled' ? 'Занятие отменено' : 'Занятие уже прошло');
  if (new Date(s.startsAt) <= new Date()) throw badRequest('Занятие уже началось');
  const st = await classSettings(db, s.clubId);
  if (new Date(s.startsAt).getTime() > Date.now() + st.bookAheadDays * 864e5) throw badRequest(`Запись открыта на ${st.bookAheadDays} дней вперёд`);
  const p = (await db.query('select id, full_name from persons where id = $1 and merged_into_id is null', [personId])).rows[0];
  if (!p) throw badRequest('Клиент не найден');
  if ((await db.query(`select 1 from class_bookings where session_id = $1 and person_id = $2 and status <> 'cancelled'`, [sessionId, personId])).rowCount) throw badRequest('Клиент уже записан на это занятие');
  if (st.noShowLimit) {
    const ns = (await db.query(`select count(*)::int as n, max(s.starts_at) as last from class_bookings b join class_sessions s on s.id = b.session_id
      where b.person_id = $1 and b.club_id = $2 and b.status = 'no_show' and s.starts_at > now() - interval '30 days'`, [personId, s.clubId])).rows[0];
    if (ns.n >= st.noShowLimit && new Date(ns.last).getTime() + st.noShowBlockDays * 864e5 > Date.now()) {
      throw badRequest(`Запись закрыта до ${new Date(new Date(ns.last).getTime() + st.noShowBlockDays * 864e5).toLocaleDateString('ru-RU')}: ${ns.n} неявки за 30 дней`, 'no_show_block');
    }
  }
  const day = s.localStart.slice(0, 10);
  const m = trial ? null : await pickMembership(db, personId, s.clubId, s.kind, day);
  if (!trial && !m) {
    throw badRequest(s.kind === 'personal' ? 'Нет пакета персональных тренировок с остатком на эту дату' : 'Нет действующего абонемента на дату занятия. Можно записать на пробное занятие', 'no_membership');
  }
  if (trial && (await db.query(`select 1 from class_bookings where person_id = $1 and club_id = $2 and trial and status in ('booked', 'attended')`, [personId, s.clubId])).rowCount) {
    throw badRequest('Пробное занятие у клиента уже было');
  }
  const full = s.booked >= s.capacity;
  const id = (await db.query(`insert into class_bookings(tenant_id, club_id, session_id, person_id, membership_id, trial, status, waitlist_at, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
  [ctx.tenantId, s.clubId, sessionId, personId, m?.id ?? null, trial, full ? 'waitlist' : 'booked', full ? new Date() : null, ctx.userId])).rows[0].id;
  const pos = full ? (await db.query(`select count(*)::int as n from class_bookings where session_id = $1 and status = 'waitlist'`, [sessionId])).rows[0].n : null;
  await notifyPerson(db, f, ctx, personId, s.clubId, full
    ? `${firstName(p.full_name)}, мест на «${s.typeName}» ${ruTime(s.localStart)} нет, вы в листе ожидания (${pos}-й). Напишем, если место освободится.`
    : `${firstName(p.full_name)}, вы записаны на «${s.typeName}» ${ruTime(s.localStart)}${s.trainerName ? `, тренер ${s.trainerName}` : ''}. Напомним заранее.`);
  return { id: id as string, status: full ? 'waitlist' : 'booked', position: pos, membership: m?.product_name ?? null };
}

export async function cancelBooking(db: Db, f: Fetch | null, ctx: Pick<Ctx, 'tenantId' | 'userId'>, bookingId: string, o: { byClient?: boolean } = {}) {
  if (!uuid(bookingId)) throw notFound('Запись не найдена');
  const b = (await db.query('select * from class_bookings where id = $1 for update', [bookingId])).rows[0];
  if (!b) throw notFound('Запись не найдена');
  if (!['booked', 'waitlist'].includes(b.status)) throw badRequest('Эту запись уже нельзя отменить');
  const s = await loadSession(db, b.session_id);
  if (s.status !== 'scheduled') throw badRequest('Занятие уже прошло или отменено');
  const st = await classSettings(db, s.clubId);
  const hoursLeft = (new Date(s.startsAt).getTime() - Date.now()) / 3600_000;
  const late = b.status === 'booked' && hoursLeft < st.lateCancelHours;
  await db.query(`update class_bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, late_cancel = $3 where id = $1`, [bookingId, ctx.userId, late]);
  let charged = false;
  if (late && s.kind === 'personal' && st.chargePersonalLate) charged = await chargeBooking(db, ctx, b, `поздняя отмена (меньше ${st.lateCancelHours} ч до начала)`, s.id);
  const promoted = b.status === 'booked' ? await promoteWaitlist(db, f, ctx, s.id) : null;
  return { late, charged, promoted };
}

/** Отметка проведённого занятия: кто пришёл, кто нет. Персональные списываются, занятие идёт в зарплату тренера */
export async function markSession(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, sessionId: string, attendance: Record<string, string>) {
  const s = await loadSession(db, sessionId);
  if (s.status === 'cancelled') throw badRequest('Занятие отменено');
  if (new Date(s.startsAt) > new Date()) throw badRequest('Отметить посещение можно после начала занятия');
  const st = await classSettings(db, s.clubId);
  const bookings = (await db.query(`select b.*, m.kind as m_kind from class_bookings b left join memberships m on m.id = b.membership_id
    where b.session_id = $1 and b.status in ('booked', 'attended', 'no_show')`, [sessionId])).rows;
  let attended = 0;
  for (const b of bookings) {
    const v = attendance[b.id] ?? (b.status === 'booked' ? null : b.status);
    if (!v) throw badRequest('Отметьте каждого записанного: пришёл или нет');
    if (!['attended', 'no_show'].includes(v)) throw badRequest('Отметка: пришёл или не пришёл');
    if (v !== b.status) await db.query(`update class_bookings set status = $2, marked_at = now(), marked_by = $3 where id = $1`, [b.id, v, ctx.userId]);
    if (v === 'attended') attended++;
    if (b.charged) continue;
    if (s.kind === 'personal' && (v === 'attended' || st.chargePersonalLate)) await chargeBooking(db, ctx, b, v === 'attended' ? 'проведено' : 'неявка', s.id);
    if (s.kind === 'group' && v === 'no_show' && st.chargeGroupNoShow && b.m_kind === 'visits') await chargeBooking(db, ctx, b, 'неявка на групповое', s.id);
  }
  // Лист ожидания после занятия не нужен
  await db.query(`update class_bookings set status = 'cancelled', cancelled_at = now() where session_id = $1 and status = 'waitlist'`, [sessionId]);
  await db.query(`update class_sessions set status = 'done', done_at = coalesce(done_at, now()), done_by = coalesce(done_by, $2) where id = $1`, [sessionId, ctx.userId]);
  await audit(db, ctx, 'class.done', 'class_session', sessionId, { status: s.status }, { attended, total: bookings.length });
  return { attended, total: bookings.length };
}

/** Проведённые занятия тренера за период — для зарплаты */
export async function trainerSessions(db: Db, clubId: string, from: string, to: string) {
  return (await db.query(`select s.trainer_id as "userId", count(*)::int as n,
      count(*) filter (where t.kind = 'personal')::int as personal, count(*) filter (where t.kind = 'group')::int as "group"
    from class_sessions s join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id
    where s.club_id = $1 and s.status = 'done' and s.trainer_id is not null
      and (s.starts_at at time zone c.timezone)::date between $2 and $3
      and (t.kind = 'group' or exists (select 1 from class_bookings b where b.session_id = s.id and b.status = 'attended') or exists (select 1 from class_bookings b where b.session_id = s.id and b.charged))
    group by s.trainer_id`, [clubId, from, to])).rows as { userId: string; n: number; personal: number; group: number }[];
}

/* ---------- напоминания ---------- */
export async function sendReminders(db: Db, f: Fetch | null, tenantId: string) {
  const actor = { tenantId, userId: null };
  const due = (await db.query(`select b.id, b.person_id, b.reminded_24, b.reminded_2, s.id as session_id, s.starts_at, s.club_id,
      coalesce(cs.remind_24, true) as r24, coalesce(cs.remind_2, true) as r2, extract(epoch from s.starts_at - now()) / 3600 as hours
    from class_bookings b join class_sessions s on s.id = b.session_id left join club_class_settings cs on cs.club_id = s.club_id
    where b.status = 'booked' and s.status = 'scheduled' and s.starts_at > now() and s.starts_at <= now() + interval '24 hours' and not b.reminded_2
    order by s.starts_at limit 300`)).rows;
  let sent = 0;
  for (const r of due) {
    const h = Number(r.hours);
    const which = h <= 2 ? '2' : !r.reminded_24 && h > 3 ? '24' : null;
    if (!which) continue;
    const on = which === '2' ? r.r2 : r.r24;
    await db.query(`update class_bookings set reminded_24 = true${which === '2' ? ', reminded_2 = true' : ''} where id = $1`, [r.id]);
    if (!on) continue;
    const s = await loadSession(db, r.session_id);
    const p = (await db.query('select full_name from persons where id = $1', [r.person_id])).rows[0];
    const text = which === '2'
      ? `${firstName(p.full_name)}, через 2 часа «${s.typeName}» (${s.localStart.slice(11, 16)}${s.roomName ? `, ${s.roomName}` : ''}). Ждём вас! Если не получается, напишите нам.`
      : `${firstName(p.full_name)}, напоминаем: завтра ${ruTime(s.localStart).replace(/^.* в /, 'в ')} «${s.typeName}»${s.trainerName ? `, тренер ${s.trainerName}` : ''}. Если планы изменились, напишите нам — освободим место для других.`;
    if (await notifyPerson(db, f, actor, r.person_id, r.club_id, text)) sent++;
  }
  return sent;
}

export async function processSchedule(pool: pg.Pool, f: Fetch | null) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, (db) => sendReminders(db, f, tenantId)).catch((e) => console.error('Напоминания о занятиях:', (e as Error).message));
  }
}
export function startScheduleWorker(pool: pg.Pool, f: Fetch = fetch, everyMs = 5 * 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processSchedule(pool, f); } finally { busy = false; } };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

/* ---------- маршруты ---------- */
export function scheduleRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? null;
  const clubOf = async (db: Db, clubId?: string) => {
    if (!uuid(clubId)) throw badRequest('Выберите клуб');
    const c = (await db.query('select id, timezone from clubs where id = $1', [clubId])).rows[0];
    if (!c) throw badRequest('Клуб не найден');
    return c as { id: string; timezone: string };
  };
  const mayMark = (ctx: Ctx, s: { trainerId: string | null }) => can(ctx, P.scheduleManage) || s.trainerId === ctx.userId;

  app.get('/api/schedule', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const q = req.query as { clubId?: string; from?: string; to?: string; trainerId?: string };
    if (!isDate(q.from) || !isDate(q.to)) throw badRequest('Укажите период');
    return withCtx(pool, ctx, async (db) => {
      await clubOf(db, q.clubId);
      return (await db.query(`${SESSION} where s.club_id = $1 and (s.starts_at at time zone c.timezone)::date between $2 and $3
        and ($4::uuid is null or s.trainer_id = $4) order by s.starts_at`, [q.clubId, q.from, q.to, uuid(q.trainerId) ? q.trainerId : null])).rows;
    });
  });

  app.get('/api/schedule/setup', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      await clubOf(db, clubId);
      return {
        rooms: (await db.query(`select id, name, capacity, is_active as "isActive" from rooms where club_id = $1 order by name`, [clubId])).rows,
        types: (await db.query(`select id, name, kind, duration_min as "durationMin", capacity, description, is_active as "isActive" from class_types where club_id = $1 order by kind, name`, [clubId])).rows,
        trainers: (await db.query(`select distinct u.id, u.full_name as name from users u join user_assignments a on a.user_id = u.id
          where u.status = 'active' and a.role_code = 'trainer' and a.club_id = $1 order by name`, [clubId])).rows,
        settings: await classSettings(db, clubId!),
      };
    });
  });

  app.post('/api/schedule/rooms', async (req, reply) => {
    const ctx = requirePerm(req, P.scheduleManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string; capacity?: number };
    if (!b.name?.trim()) throw badRequest('Укажите название зала');
    const r = await withCtx(pool, ctx, async (db) => {
      await clubOf(db, b.clubId);
      if ((await db.query('select 1 from rooms where club_id = $1 and lower(name) = lower($2)', [b.clubId, b.name!.trim()])).rowCount) throw badRequest('Такой зал уже есть');
      const row = (await db.query('insert into rooms(tenant_id, club_id, name, capacity) values ($1,$2,$3,$4) returning id, name, capacity', [ctx.tenantId, b.clubId, b.name!.trim(), b.capacity || null])).rows[0];
      await audit(db, ctx, 'schedule.room_created', 'room', row.id, null, row);
      return row;
    });
    reply.code(201); return r;
  });

  app.post('/api/schedule/types', async (req, reply) => {
    const ctx = requirePerm(req, P.scheduleManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string; kind?: string; durationMin?: number; capacity?: number; description?: string };
    if (!b.name?.trim()) throw badRequest('Укажите название занятия');
    if (!['group', 'personal'].includes(b.kind ?? '')) throw badRequest('Выберите: групповое или персональное');
    const dur = Number(b.durationMin ?? 60); const cap = b.kind === 'personal' ? Number(b.capacity ?? 1) : Number(b.capacity ?? 15);
    if (!(dur >= 10 && dur <= 480)) throw badRequest('Длительность от 10 до 480 минут');
    if (!(cap >= 1 && cap <= 500)) throw badRequest('Мест от 1 до 500');
    const r = await withCtx(pool, ctx, async (db) => {
      await clubOf(db, b.clubId);
      if ((await db.query('select 1 from class_types where club_id = $1 and lower(name) = lower($2)', [b.clubId, b.name!.trim()])).rowCount) throw badRequest('Такое занятие уже есть');
      const row = (await db.query(`insert into class_types(tenant_id, club_id, name, kind, duration_min, capacity, description) values ($1,$2,$3,$4,$5,$6,$7)
        returning id, name, kind, duration_min as "durationMin", capacity`, [ctx.tenantId, b.clubId, b.name!.trim(), b.kind, dur, cap, b.description?.trim() || null])).rows[0];
      await audit(db, ctx, 'schedule.type_created', 'class_type', row.id, null, row);
      return row;
    });
    reply.code(201); return r;
  });

  app.put('/api/schedule/settings', async (req) => {
    const ctx = requirePerm(req, P.scheduleManage);
    const b = (req.body ?? {}) as Partial<typeof DEFAULT_CLASS_SETTINGS> & { clubId?: string };
    const s = { ...DEFAULT_CLASS_SETTINGS, ...b };
    const int = (v: unknown, lo: number, hi: number, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw badRequest(`${name}: от ${lo} до ${hi}`); return n; };
    int(s.lateCancelHours, 0, 72, 'Поздняя отмена, часов'); int(s.noShowBlockDays, 1, 90, 'Запрет записи, дней'); int(s.bookAheadDays, 1, 90, 'Запись вперёд, дней');
    if (s.noShowLimit !== null && s.noShowLimit !== undefined) int(s.noShowLimit, 1, 20, 'Неявок до запрета');
    return withCtx(pool, ctx, async (db) => {
      await clubOf(db, b.clubId);
      const before = await classSettings(db, b.clubId!);
      await db.query(`insert into club_class_settings(club_id, tenant_id, late_cancel_hours, charge_personal_late, charge_group_no_show, no_show_limit, no_show_block_days, remind_24, remind_2, book_ahead_days, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (club_id) do update set late_cancel_hours = excluded.late_cancel_hours, charge_personal_late = excluded.charge_personal_late,
        charge_group_no_show = excluded.charge_group_no_show, no_show_limit = excluded.no_show_limit, no_show_block_days = excluded.no_show_block_days, remind_24 = excluded.remind_24,
        remind_2 = excluded.remind_2, book_ahead_days = excluded.book_ahead_days, updated_by = excluded.updated_by, updated_at = now()`,
      [b.clubId, ctx.tenantId, s.lateCancelHours, !!s.chargePersonalLate, !!s.chargeGroupNoShow, s.noShowLimit || null, s.noShowBlockDays, !!s.remind24, !!s.remind2, s.bookAheadDays, ctx.userId]);
      const after = await classSettings(db, b.clubId!);
      await audit(db, ctx, 'schedule.settings_changed', 'club', b.clubId!, before, after);
      return after;
    });
  });

  app.post('/api/schedule/sessions', async (req, reply) => {
    const ctx = requirePerm(req, P.scheduleManage);
    const b = (req.body ?? {}) as { clubId?: string; typeId?: string; roomId?: string | null; trainerId?: string | null; start?: string; capacity?: number; repeatWeeks?: number; note?: string };
    if (!isLocal(b.start)) throw badRequest('Укажите дату и время начала');
    const weeks = Math.max(1, Math.min(26, Number(b.repeatWeeks ?? 1) || 1));
    const r = await withCtx(pool, ctx, async (db) => {
      const club = await clubOf(db, b.clubId);
      const t = uuid(b.typeId) ? (await db.query('select * from class_types where id = $1 and club_id = $2 and is_active', [b.typeId, club.id])).rows[0] : null;
      if (!t) throw badRequest('Выберите вид занятия');
      if (b.roomId && !(await db.query('select 1 from rooms where id = $1 and club_id = $2', [b.roomId, club.id])).rowCount) throw badRequest('Зал не найден');
      if (b.trainerId && !(await db.query(`select 1 from user_assignments where user_id = $1 and (club_id = $2 or club_id is null)`, [b.trainerId, club.id])).rowCount) throw badRequest('Тренер не работает в этом клубе');
      const cap = Number(b.capacity ?? t.capacity);
      if (!(cap >= 1 && cap <= 500)) throw badRequest('Мест от 1 до 500');
      const series = weeks > 1 ? randomUUID() : null;
      const ids: string[] = []; const conflicts: string[] = [];
      for (let w = 0; w < weeks; w++) {
        const se = (await db.query(`select ($1::timestamp + make_interval(days => $3::int)) at time zone $2 as s, ($1::timestamp + make_interval(days => $3::int, mins => $4::int)) at time zone $2 as e`,
          [b.start!.replace('T', ' '), club.timezone, w * 7, t.duration_min])).rows[0];
        // Тренер и зал не могут быть заняты в одно время
        const busy = (await db.query(`select to_char(s.starts_at at time zone $4, 'DD.MM HH24:MI') as at, case when s.trainer_id = $2 then 'тренер' else 'зал' end as what
          from class_sessions s where s.club_id = $1 and s.status = 'scheduled' and s.starts_at < $6 and s.ends_at > $5
            and (($2::uuid is not null and s.trainer_id = $2) or ($3::uuid is not null and s.room_id = $3)) limit 1`,
        [club.id, b.trainerId || null, b.roomId || null, club.timezone, se.s, se.e])).rows[0];
        if (busy) { conflicts.push(`${busy.at}: занят ${busy.what}`); continue; }
        ids.push((await db.query(`insert into class_sessions(tenant_id, club_id, type_id, room_id, trainer_id, starts_at, ends_at, capacity, series_id, note, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [ctx.tenantId, club.id, t.id, b.roomId || null, b.trainerId || null, se.s, se.e, cap, series, b.note?.trim() || null, ctx.userId])).rows[0].id);
      }
      if (!ids.length) throw badRequest(`Время занято: ${conflicts.join('; ')}`, 'busy');
      await audit(db, ctx, 'schedule.sessions_created', 'class_session', ids[0], null, { type: t.name, start: b.start, weeks, created: ids.length, conflicts });
      return { created: ids.length, ids, conflicts };
    });
    reply.code(201); return r;
  });

  app.get('/api/schedule/sessions/:id', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const s = await loadSession(db, id);
      const bookings = (await db.query(`select b.id, b.person_id as "personId", p.full_name as "name", b.status, b.trial, b.late_cancel as "lateCancel", b.charged,
          m.product_name as membership, m.visits_left as "visitsLeft", b.created_at as "createdAt",
          (select value from person_contacts pc where pc.person_id = p.id and pc.is_primary limit 1) as phone
        from class_bookings b join persons p on p.id = b.person_id left join memberships m on m.id = b.membership_id
        where b.session_id = $1 order by case b.status when 'waitlist' then 2 when 'cancelled' then 3 else 1 end, b.waitlist_at, b.created_at`, [id])).rows;
      return { ...s, bookings: bookings.map((x) => ({ ...x, phone: maskPhone(x.phone) })), canMark: mayMark(ctx, s), canManage: can(ctx, P.scheduleManage) };
    });
  });

  app.post('/api/schedule/sessions/:id/book', async (req, reply) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { personId?: string; trial?: boolean };
    if (!uuid(b.personId)) throw badRequest('Выберите клиента');
    const r = await withCtx(pool, ctx, async (db) => {
      const res = await bookPerson(db, f, ctx, id, b.personId!, !!b.trial);
      await audit(db, ctx, 'class.booked', 'class_booking', res.id, null, { sessionId: id, personId: b.personId, status: res.status, trial: !!b.trial });
      return res;
    });
    reply.code(201); return r;
  });

  app.post('/api/schedule/bookings/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const res = await cancelBooking(db, f, ctx, id);
      await audit(db, ctx, 'class.booking_cancelled', 'class_booking', id, null, res);
      return res;
    });
  });

  app.post('/api/schedule/sessions/:id/done', async (req) => {
    const ctx = requirePerm(req, P.scheduleBook);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { attendance?: Record<string, string> };
    return withCtx(pool, ctx, async (db) => {
      const s = await loadSession(db, id);
      if (!mayMark(ctx, s)) throw forbidden('Отметить занятие может его тренер или управляющий');
      return markSession(db, ctx, id, b.attendance ?? {});
    });
  });

  app.post('/api/schedule/sessions/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.scheduleManage);
    const { id } = req.params as { id: string };
    const reason = ((req.body ?? {}) as { reason?: string }).reason?.trim();
    if (!reason) throw badRequest('Укажите причину отмены: её увидят записанные клиенты');
    return withCtx(pool, ctx, async (db) => {
      const s = await loadSession(db, id);
      if (s.status !== 'scheduled') throw badRequest('Занятие уже прошло или отменено');
      await db.query(`update class_sessions set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, reason]);
      const list = (await db.query(`update class_bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = $2 where session_id = $1 and status in ('booked', 'waitlist')
        returning person_id`, [id, ctx.userId])).rows;
      let notified = 0;
      for (const r of list) {
        const p = (await db.query('select full_name from persons where id = $1', [r.person_id])).rows[0];
        if (await notifyPerson(db, f, ctx, r.person_id, s.clubId, `${firstName(p.full_name)}, к сожалению, «${s.typeName}» ${ruTime(s.localStart)} отменяется: ${reason}. Запишем вас на другое время — просто ответьте на это сообщение.`)) notified++;
      }
      await audit(db, ctx, 'class.cancelled', 'class_session', id, { status: 'scheduled' }, { reason, bookings: list.length, notified });
      return { cancelled: list.length, notified };
    });
  });

  app.patch('/api/schedule/sessions/:id', async (req) => {
    const ctx = requirePerm(req, P.scheduleManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { trainerId?: string | null; roomId?: string | null; capacity?: number; note?: string };
    return withCtx(pool, ctx, async (db) => {
      const s = await loadSession(db, id);
      if (s.status !== 'scheduled') throw badRequest('Менять можно только будущее занятие');
      if (b.capacity !== undefined && (!(Number(b.capacity) >= 1) || Number(b.capacity) < s.booked)) throw badRequest(`Мест не может быть меньше записанных (${s.booked})`);
      await db.query(`update class_sessions set trainer_id = case when $2 then $3::uuid else trainer_id end, room_id = case when $4 then $5::uuid else room_id end,
        capacity = coalesce($6, capacity), note = coalesce($7, note) where id = $1`,
      [id, b.trainerId !== undefined, b.trainerId || null, b.roomId !== undefined, b.roomId || null, b.capacity ?? null, b.note ?? null]);
      // Мест стало больше — подтягиваем лист ожидания
      if (b.capacity && Number(b.capacity) > s.capacity) for (let i = s.capacity; i < Number(b.capacity); i++) if (!(await promoteWaitlist(db, f, ctx, id))) break;
      const after = await loadSession(db, id);
      await audit(db, ctx, 'class.updated', 'class_session', id, s, after);
      return after;
    });
  });

  // Записи клиента — для карточки клиента
  app.get('/api/persons/:id/bookings', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`select b.id, b.status, b.trial, b.charged, b.late_cancel as "lateCancel", s.id as "sessionId", t.name as "typeName",
        to_char(s.starts_at at time zone c.timezone, 'YYYY-MM-DD"T"HH24:MI') as "localStart", u.full_name as "trainerName", s.status as "sessionStatus"
      from class_bookings b join class_sessions s on s.id = b.session_id join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id left join users u on u.id = s.trainer_id
      where b.person_id = $1 order by s.starts_at desc limit 50`, [id])).rows);
  });
}
