// Программа первых 30 дней новичка (список «20 новых возможностей», п. 3).
// Первая покупка в клубе запускает программу: по шагам ставятся задачи менеджеру или тренеру.
// Шаг «вводная тренировка» закрывается сам, если клиент уже записан на занятие; шаг «визиты» — если визитов хватает.
// Шаги и сроки настраивает управляющий (право «возврат клиентов и удержание»).
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { addDays, clubToday } from './memberships.ts';
import { responsibleFor } from './retention.ts';

type Actor = { tenantId: string; userId: string | null };
export type Step = { key: string; title: string; day: number; kind: 'intro' | 'call' | 'visits'; minVisits?: number; assignTo: 'manager' | 'trainer' };
export const DEFAULT_STEPS: Step[] = [
  { key: 'intro', title: 'Записать на вводную тренировку', day: 1, kind: 'intro', assignTo: 'manager' },
  { key: 'call7', title: 'Позвонить: как прошли первые занятия?', day: 7, kind: 'call', assignTo: 'manager' },
  { key: 'visits14', title: 'Мало визитов за первые 2 недели: позвонить и пригласить на занятие', day: 14, kind: 'visits', minVisits: 3, assignTo: 'trainer' },
  { key: 'call30', title: 'Итог первого месяца: что понравилось, предложить персональные тренировки', day: 30, kind: 'call', assignTo: 'manager' },
];
const KINDS = ['intro', 'call', 'visits'];

export async function newbieSettings(db: Db, clubId: string) {
  const r = (await db.query('select enabled, steps from newbie_settings where club_id = $1', [clubId])).rows[0];
  return { enabled: r ? r.enabled as boolean : true, steps: (r?.steps as Step[] | undefined) ?? DEFAULT_STEPS, custom: !!r };
}

export function validateSteps(steps: unknown): Step[] {
  if (!Array.isArray(steps) || !steps.length || steps.length > 10) throw badRequest('Нужно от 1 до 10 шагов');
  const keys = new Set<string>();
  return steps.map((s: Partial<Step>, i) => {
    const title = String(s.title ?? '').trim();
    const day = Number(s.day);
    if (!title) throw badRequest(`Шаг ${i + 1}: укажите, что сделать`);
    if (!Number.isInteger(day) || day < 0 || day > 90) throw badRequest(`Шаг ${i + 1}: день от 0 до 90`);
    if (!KINDS.includes(s.kind as string)) throw badRequest(`Шаг ${i + 1}: неизвестный вид шага`);
    const minVisits = s.kind === 'visits' ? Number(s.minVisits) : undefined;
    if (s.kind === 'visits' && (!Number.isInteger(minVisits) || minVisits! < 1 || minVisits! > 60)) throw badRequest(`Шаг ${i + 1}: сколько визитов нужно — от 1 до 60`);
    const key = String(s.key || `s${i + 1}`).slice(0, 30);
    if (keys.has(key)) throw badRequest('Шаги повторяются');
    keys.add(key);
    return { key, title, day, kind: s.kind as Step['kind'], ...(minVisits ? { minVisits } : {}), assignTo: s.assignTo === 'trainer' ? 'trainer' : 'manager' };
  });
}

/** Тренер клиента: кто вёл или ведёт его ближайшие занятия. Нет такого — ответственный менеджер. */
async function trainerFor(db: Db, personId: string, clubId: string) {
  const t = (await db.query(`select s.trainer_id from class_bookings b join class_sessions s on s.id = b.session_id join users u on u.id = s.trainer_id
    where b.person_id = $1 and s.club_id = $2 and b.status in ('booked', 'attended') and u.status = 'active' order by s.starts_at desc limit 1`, [personId, clubId])).rows[0]?.trainer_id;
  return (t as string | undefined) ?? await responsibleFor(db, personId, clubId);
}
const visitsSince = async (db: Db, personId: string, clubId: string, from: string, to: string) =>
  (await db.query(`select count(distinct (v.visited_at at time zone c.timezone)::date)::int as n from visits v join clubs c on c.id = v.club_id
    where v.person_id = $1 and v.club_id = $2 and (v.visited_at at time zone c.timezone)::date between $3 and $4`, [personId, clubId, from, to])).rows[0].n as number;

/** Записывает новых клиентов в программу и продвигает шаги, срок которых наступил. Возвращает, сколько задач поставлено. */
export async function processNewbies(db: Db, actor: Actor, clubId: string, today: string) {
  const s = await newbieSettings(db, clubId);
  let tasks = 0;
  if (s.enabled) {
    // Новые клиенты: первая покупка в клубе (не гостевой визит) за последние 30 дней
    const fresh = (await db.query(`select m.id, m.person_id, m.starts_on::text as starts from memberships m
      where m.club_id = $1 and m.sale_category in ('new', 'subscription') and m.kind <> 'guest' and m.status <> 'cancelled'
        and m.starts_on > $2::date - 30 and m.starts_on <= $2::date
        and not exists (select 1 from memberships o where o.person_id = m.person_id and o.club_id = m.club_id and o.id <> m.id and o.created_at < m.created_at and o.kind <> 'guest')
        and not exists (select 1 from newbie_programs p where p.person_id = m.person_id and p.club_id = m.club_id)`, [clubId, today])).rows;
    for (const m of fresh) {
      const pid = (await db.query(`insert into newbie_programs(tenant_id, club_id, person_id, membership_id, started_on) values ($1,$2,$3,$4,$5) on conflict do nothing returning id`,
        [actor.tenantId, clubId, m.person_id, m.id, m.starts])).rows[0]?.id;
      if (!pid) continue;
      for (const st of s.steps) {
        // Клиент попал в программу с опозданием (например, сразу после включения): давно прошедшие шаги пропускаем, а не ставим задним числом
        const dueOn = addDays(m.starts, st.day);
        await db.query(`insert into newbie_steps(tenant_id, club_id, program_id, key, kind, title, due_on, min_visits, assign_to, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [actor.tenantId, clubId, pid, st.key, st.kind, st.title, dueOn, st.minVisits ?? null, st.assignTo, dueOn < addDays(today, -3) ? 'skipped' : 'pending']);
      }
    }
  }
  // Выполненные задачи закрывают шаги
  await db.query(`update newbie_steps s set status = 'done', closed_at = t.done_at from tasks t where t.id = s.task_id and s.status = 'task' and t.done_at is not null and s.club_id = $1`, [clubId]);
  // Шаги, срок которых наступил
  const due = (await db.query(`select s.*, p.person_id, p.started_on::text as started, per.full_name from newbie_steps s join newbie_programs p on p.id = s.program_id
      join persons per on per.id = p.person_id
    where s.club_id = $1 and s.status = 'pending' and s.due_on <= $2 and p.status = 'active' order by s.due_on`, [clubId, today])).rows;
  for (const st of due) {
    if (st.kind === 'intro') {
      const booked = (await db.query(`select 1 from class_bookings where person_id = $1 and club_id = $2 and status in ('booked', 'attended') and created_at::date >= $3::date - 7`,
        [st.person_id, clubId, st.started])).rowCount;
      if (booked) { await db.query(`update newbie_steps set status = 'ok', closed_at = now() where id = $1`, [st.id]); continue; }
    }
    let title = `Новичок ${st.full_name}: ${st.title}`;
    if (st.kind === 'visits') {
      const n = await visitsSince(db, st.person_id, clubId, st.started, today);
      if (n >= st.min_visits) { await db.query(`update newbie_steps set status = 'ok', visits = $2, closed_at = now() where id = $1`, [st.id, n]); continue; }
      title = `Новичок ${st.full_name}: ${n} ${n === 1 ? 'визит' : n >= 2 && n <= 4 ? 'визита' : 'визитов'} с ${st.started.split('-').reverse().join('.')} вместо ${st.min_visits}. ${st.title}`;
      await db.query('update newbie_steps set visits = $2 where id = $1', [st.id, n]);
    }
    const assignee = st.assign_to === 'trainer' ? await trainerFor(db, st.person_id, clubId) : await responsibleFor(db, st.person_id, clubId);
    const taskId = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,'call',$5, now() + interval '1 day', $6) returning id`,
      [actor.tenantId, clubId, assignee, st.person_id, title, actor.userId])).rows[0].id;
    await db.query(`update newbie_steps set status = 'task', task_id = $2 where id = $1`, [st.id, taskId]);
    tasks++;
  }
  // Программа закончена, когда не осталось открытых шагов
  await db.query(`update newbie_programs p set status = 'done' where p.club_id = $1 and p.status = 'active'
    and not exists (select 1 from newbie_steps s where s.program_id = p.id and s.status in ('pending', 'task'))`, [clubId]);
  return { tasks };
}

export async function newbieList(db: Db, clubId: string, today: string) {
  const rows = (await db.query(`select p.id, p.person_id as "personId", per.full_name as name, p.started_on::text as "startedOn", p.status, m.product_name as product,
      (select json_agg(json_build_object('key', s.key, 'title', s.title, 'kind', s.kind, 'dueOn', s.due_on::text, 'status', s.status, 'visits', s.visits, 'minVisits', s.min_visits,
        'taskId', s.task_id, 'assignee', u.full_name) order by s.due_on) from newbie_steps s left join tasks t on t.id = s.task_id left join users u on u.id = t.assignee_id where s.program_id = p.id) as steps
    from newbie_programs p join persons per on per.id = p.person_id join memberships m on m.id = p.membership_id
    where p.club_id = $1 and (p.status = 'active' or p.started_on > $2::date - 60) order by p.started_on desc limit 300`, [clubId, today])).rows;
  const out = [];
  for (const r of rows) {
    const visits = await visitsSince(db, r.personId, clubId, r.startedOn, today);
    const day = Math.round((Date.parse(today) - Date.parse(r.startedOn)) / 86400_000) + 1;
    // В зоне риска: прошла неделя, а визитов меньше одного в неделю, или есть невыполненная задача по шагу «визиты»
    const risk = r.status === 'active' && ((day >= 8 && visits < Math.floor(day / 7)) || (r.steps ?? []).some((s: { kind: string; status: string }) => s.kind === 'visits' && s.status === 'task'));
    out.push({ ...r, steps: r.steps ?? [], visits, day, risk });
  }
  return out;
}

/* ---------- маршруты ---------- */
export function newbieRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/newbie', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const list = await newbieList(db, clubId, today);
      const active = list.filter((x) => x.status === 'active');
      return { settings: await newbieSettings(db, clubId), canManage: can(ctx, P.retentionManage), list,
        stats: { active: active.length, risk: active.filter((x) => x.risk).length, done: list.filter((x) => x.status === 'done').length } };
    });
  });

  app.put('/api/newbie/settings', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as { clubId?: string; enabled?: boolean; steps?: unknown };
    if (!b.clubId) throw badRequest('Выберите клуб');
    const steps = b.steps === undefined ? null : validateSteps(b.steps);
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      const before = await newbieSettings(db, b.clubId!);
      const after = { enabled: b.enabled ?? before.enabled, steps: steps ?? before.steps };
      await db.query(`insert into newbie_settings(club_id, tenant_id, enabled, steps, updated_by) values ($1,$2,$3,$4,$5)
        on conflict (club_id) do update set enabled = excluded.enabled, steps = excluded.steps, updated_by = excluded.updated_by, updated_at = now()`,
        [b.clubId, ctx.tenantId, after.enabled, JSON.stringify(after.steps), ctx.userId]);
      await audit(db, ctx, 'newbie.settings', 'club', b.clubId!, { enabled: before.enabled, steps: before.steps }, after);
      return after;
    });
  });

  // Запустить сейчас, не дожидаясь фоновой проверки (новые шаги применяются к новым программам)
  app.post('/api/newbie/run', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => processNewbies(db, ctx, clubId, await clubToday(db, clubId)));
  });
}
