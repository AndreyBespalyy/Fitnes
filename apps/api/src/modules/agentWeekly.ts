// ИИ-агент, этап 7 (выбор Андрея 14.11.2026, 4Б): еженедельный разбор узких мест.
// Каждый понедельник утром (местное время клуба) агент сравнивает прошлую неделю с позапрошлой по всем данным CRM:
// заявки и скорость ответа, задачи и эскалации, переписка с клиентами, вопросы коллегам во внутреннем мессенджере,
// пропущенные звонки, сделки без движения, занятия (заполняемость, неявки), бизнес-процессы и собрания.
// Находит главные узкие места (по весу потерь для клуба), пишет руководителям разбор с тем, что сделать,
// и присылает каждому сотруднику в «ИИ-помощник» его цифры за неделю и одну подсказку по его роли.
// Если подключён YandexGPT — он пишет вводный абзац «Главное», остальное собирается по правилам.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireCtx } from '../auth.ts';
import { withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { ygptComplete, yandexConfigFromEnv, type YandexConfig } from '../lib/yandex.ts';
import { botSay } from './agentMeetings.ts';
import { isLeader } from './agentOwner.ts';
import { card } from './agentReminders.ts';
import { salesFact } from './dash.ts';
import { staffOf } from './salesOps.ts';

type Actor = { tenantId: string; userId: string | null };
type Role = 'manager' | 'rop' | 'desk' | 'trainer' | 'gm';

export type WeekMetrics = {
  salesKop: number;
  leads: { total: number; noAnswer: number; late: number; reassigned: number; median: number | null };
  leadsBy: { id: string; name: string; n: number; median: number | null }[];
  tasks: { total: number; late: number; escalations: number };
  tasksBy: { id: string; name: string; total: number; late: number }[];
  waits: { over: number; over3: number };
  questions: { total: number; slow: number };
  slowBy: { id: string; name: string; n: number }[];
  calls: { missed: number; noCallback: number };
  deals: { stuck: number; slowStage: { name: string; days: number } | null };
  classes: { sessions: number; cap: number; booked: number; came: number; noShow: number; cancelled: number };
  classesBy: { id: string; name: string; sessions: number; cap: number; booked: number; came: number; noShow: number }[];
  processes: { started: number; done: number; late: number; slowStep: { title: string; n: number } | null };
  meetings: { invited: number; confirmed: number; declined: number };
};

export type Bottleneck = { key: string; title: string; fact: string; todo: string; roles: Role[]; score: number };

const ROLE_TITLE: Record<Role, string> = { manager: 'Менеджеры', rop: 'РОП', desk: 'Администраторы', trainer: 'Тренеры', gm: 'Управляющий' };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;
const was = (cur: number | null, prev: number | null, unit = '') => (prev == null || cur === prev ? '' : ` (неделей раньше ${prev}${unit})`);
const first = (name: string) => name.split(' ')[0];

/* ---------- границы недели ---------- */
/** Понедельник прошлой полной недели по местному времени клуба */
export async function lastWeekStart(db: Db, tz: string): Promise<string> {
  return (await db.query(`select to_char(date_trunc('week', now() at time zone $1)::date - 7, 'YYYY-MM-DD') as ws`, [tz])).rows[0].ws;
}
const addDays = (ws: string, n: number) => { const d = new Date(`${ws}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function weekLabel(ws: string) {
  const a = new Date(`${ws}T00:00:00Z`); const b = new Date(`${addDays(ws, 6)}T00:00:00Z`);
  const m = (d: Date) => d.toLocaleDateString('ru-RU', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${m(b)}` : `${m(a)} – ${m(b)}`;
}

/* ---------- цифры недели ---------- */
export async function weekMetrics(db: Db, clubId: string, tz: string, ws: string): Promise<WeekMetrics> {
  const b = (await db.query(`select ($1::date)::timestamp at time zone $2 as f, ($1::date + 7)::timestamp at time zone $2 as t`, [ws, tz])).rows[0];
  const p = [clubId, b.f, b.t];
  const one = async (q: string, args: unknown[] = p) => (await db.query(q, args)).rows[0];
  const all = async (q: string, args: unknown[] = p) => (await db.query(q, args)).rows;

  const sales = (await salesFact(db, [clubId], ws, addDays(ws, 6))).reduce((a, x) => a + x.kop, 0);

  const leads = await one(`select count(*)::int as total,
      count(*) filter (where first_response_at is null)::int as no_answer,
      count(*) filter (where first_response_at > first_response_due_at or (first_response_at is null and first_response_due_at < least($3, now())))::int as late,
      count(*) filter (where agent_reassigned_at is not null)::int as reassigned,
      round((percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at) / 60) filter (where first_response_at is not null))::numeric)::int as median
    from leads where club_id = $1 and created_at >= $2 and created_at < $3`);
  const leadsBy = (await all(`select u.id, u.full_name as name, count(*)::int as n,
      round((percentile_cont(0.5) within group (order by extract(epoch from l.first_response_at - l.created_at) / 60) filter (where l.first_response_at is not null))::numeric)::int as median
    from leads l join users u on u.id = coalesce(l.taken_by, l.assigned_to)
    where l.club_id = $1 and l.created_at >= $2 and l.created_at < $3 and not u.is_bot group by u.id, u.full_name order by n desc`))
    .map((r) => ({ id: r.id, name: r.name, n: r.n, median: r.median }));

  const tasksBy = (await all(`select u.id, u.full_name as name, count(*)::int as total,
      count(*) filter (where (t.done_at is not null and t.done_at > t.due_at + interval '5 minutes') or (t.done_at is null and t.due_at < least($3, now())))::int as late
    from tasks t join users u on u.id = t.assignee_id
    where t.club_id = $1 and t.due_at >= $2 and t.due_at < $3 and not u.is_bot group by u.id, u.full_name order by late desc, total desc`))
    .map((r) => ({ id: r.id, name: r.name, total: r.total, late: r.late }));
  const esc = await one(`select count(*) filter (where key like 'task:%' and key not like '%:1')::int as esc,
      count(*) filter (where key like 'reply:%:1')::int as w1, count(*) filter (where key like 'reply:%:2')::int as w3
    from agent_sent where club_id = $1 and sent_at >= $2 and sent_at < $3`);

  // Внутренний мессенджер: вопросы коллегам (сообщения со знаком «?» в рабочее время), на которые никто не ответил за 2 часа
  const qs = await all(`select q.*, (q.answered is null and q.created_at < least($3, now()) - interval '2 hours') or q.answered - q.created_at > interval '2 hours' as slow
    from (select m.created_at, ch.kind,
        (select min(r.created_at) from team_messages r join users ru on ru.id = r.user_id
          where r.chat_id = m.chat_id and r.created_at > m.created_at and r.user_id <> m.user_id and not ru.is_bot and r.deleted_at is null) as answered,
        case when ch.kind = 'direct' then (select tm.user_id from team_members tm where tm.chat_id = m.chat_id and tm.user_id <> m.user_id limit 1) end as peer
      from team_messages m join team_chats ch on ch.id = m.chat_id join users u on u.id = m.user_id
      where m.created_at >= $2 and m.created_at < $3 and m.deleted_at is null and not u.is_bot and m.body like '%?%'
        and extract(hour from m.created_at at time zone $4) between 8 and 19
        and exists (select 1 from user_assignments a where a.user_id = m.user_id and a.club_id = $1)
        and not exists (select 1 from team_members tm join users bu on bu.id = tm.user_id where tm.chat_id = m.chat_id and bu.is_bot)) q`, [...p, tz]);
  const slowPeers = new Map<string, number>();
  for (const q of qs) if (q.slow && q.peer) slowPeers.set(q.peer, (slowPeers.get(q.peer) ?? 0) + 1);
  const slowBy: WeekMetrics['slowBy'] = [];
  for (const [id, n] of [...slowPeers].sort((a, b) => b[1] - a[1])) {
    const u = (await db.query(`select full_name from users where id = $1`, [id])).rows[0];
    if (u) slowBy.push({ id, name: u.full_name, n });
  }

  const calls = await one(`select count(*)::int as missed,
      count(*) filter (where not exists (select 1 from calls o where o.club_id = c.club_id and o.direction = 'out' and o.phone = c.phone
        and o.started_at > c.started_at and o.started_at < c.started_at + interval '2 hours'))::int as no_callback
    from calls c where c.club_id = $1 and c.direction = 'in' and coalesce(c.duration_sec, 0) = 0 and c.started_at >= $2 and c.started_at < $3`);

  const stuck = await one(`select count(*)::int as n from opportunities o where o.club_id = $1 and o.status = 'open' and o.created_at < $3 and $2::timestamptz is not null
      and coalesce((select max(h.at) from opportunity_stage_history h where h.opportunity_id = o.id and h.at < $3), o.created_at) < $3 - interval '7 days'`);
  const slowStage = await one(`select s.name, round(avg(extract(epoch from h.at - coalesce((select max(x.at) from opportunity_stage_history x
        where x.opportunity_id = h.opportunity_id and x.at < h.at), o.created_at)) / 86400)::numeric, 1)::float as days
    from opportunity_stage_history h join opportunities o on o.id = h.opportunity_id join pipeline_stages s on s.id = h.from_stage_id
    where h.club_id = $1 and h.at >= $2 and h.at < $3 group by s.name order by days desc limit 1`);

  const cls = await all(`select u.id, coalesce(u.full_name, 'без тренера') as name, count(*)::int as sessions, sum(x.capacity)::int as cap,
      sum(x.booked)::int as booked, sum(x.came)::int as came, sum(x.no_show)::int as no_show
    from (select s.id, s.trainer_id, s.capacity,
        (select count(*) from class_bookings b where b.session_id = s.id and b.status in ('booked', 'attended', 'no_show')) as booked,
        (select count(*) from class_bookings b where b.session_id = s.id and b.status = 'attended') as came,
        (select count(*) from class_bookings b where b.session_id = s.id and b.status = 'no_show') as no_show
      from class_sessions s where s.club_id = $1 and s.starts_at >= $2 and s.starts_at < $3 and s.status <> 'cancelled') x
      left join users u on u.id = x.trainer_id group by u.id, u.full_name order by sessions desc`);
  const cancelled = (await one(`select count(*)::int as n from class_sessions where club_id = $1 and starts_at >= $2 and starts_at < $3 and status = 'cancelled'`)).n;
  const classesBy = cls.map((r) => ({ id: r.id, name: r.name, sessions: r.sessions, cap: r.cap, booked: r.booked, came: r.came, noShow: r.no_show }));
  const sum = (k: 'sessions' | 'cap' | 'booked' | 'came' | 'noShow') => classesBy.reduce((a, x) => a + x[k], 0);

  const pr = await one(`select count(*) filter (where started_at >= $2 and started_at < $3)::int as started,
      count(*) filter (where status = 'done' and finished_at >= $2 and finished_at < $3)::int as done,
      count(*) filter (where status <> 'cancelled' and due_at >= $2 and due_at < $3 and (finished_at is null or finished_at > due_at))::int as late
    from processes where club_id = $1`);
  const slowStep = await one(`select title, count(*)::int as n from process_steps
    where club_id = $1 and due_at >= $2 and due_at < $3 and ((done_at is not null and done_at > due_at) or (done_at is null and status = 'active' and due_at < now()))
    group by title order by n desc limit 1`);

  const mt = await one(`select count(*) filter (where mm.user_id <> sm.created_by)::int as invited,
      count(*) filter (where mm.user_id <> sm.created_by and mm.status = 'confirmed')::int as confirmed,
      count(*) filter (where mm.status = 'declined')::int as declined
    from staff_meetings sm join staff_meeting_members mm on mm.meeting_id = sm.id
    where sm.club_id = $1 and sm.starts_at >= $2 and sm.starts_at < $3 and sm.status = 'planned'`);

  return {
    salesKop: sales,
    leads: { total: leads.total, noAnswer: leads.no_answer, late: leads.late, reassigned: leads.reassigned, median: leads.median },
    leadsBy,
    tasks: { total: tasksBy.reduce((a, x) => a + x.total, 0), late: tasksBy.reduce((a, x) => a + x.late, 0), escalations: esc.esc },
    tasksBy,
    waits: { over: esc.w1, over3: esc.w3 },
    questions: { total: qs.length, slow: qs.filter((q) => q.slow).length },
    slowBy,
    calls: { missed: calls.missed, noCallback: calls.no_callback },
    deals: { stuck: stuck.n, slowStage: slowStage ? { name: slowStage.name, days: slowStage.days } : null },
    classes: { sessions: sum('sessions'), cap: sum('cap'), booked: sum('booked'), came: sum('came'), noShow: sum('noShow'), cancelled },
    classesBy,
    processes: { started: pr.started, done: pr.done, late: pr.late, slowStep: slowStep ? { title: slowStep.title, n: slowStep.n } : null },
    meetings: { invited: mt.invited, confirmed: mt.confirmed, declined: mt.declined },
  };
}

/* ---------- узкие места ---------- */
/** Кандидаты в узкие места с весом потерь для клуба: чем дороже для денег и клиентов, тем выше */
export function findBottlenecks(m: WeekMetrics, prev: WeekMetrics | null): Bottleneck[] {
  const out: Bottleneck[] = [];
  const L = m.leads;
  if (L.noAnswer || L.late || (L.median ?? 0) > 15) {
    const slowest = m.leadsBy.filter((x) => x.median != null && x.n >= 2).sort((a, b) => (b.median ?? 0) - (a.median ?? 0))[0];
    out.push({ key: 'leads', title: 'Заявки ждут ответа', roles: ['manager', 'rop'],
      score: L.noAnswer * 6 + L.late * 3 + Math.max(0, (L.median ?? 0) - 15) / 5,
      fact: `заявок ${L.total}, ответ в среднем через ${L.median ?? '—'} мин${was(L.median, prev?.leads.median ?? null, ' мин')}, позже нормы — ${L.late}, без ответа — ${L.noAnswer}${slowest && (slowest.median ?? 0) > 15 ? `; дольше всех отвечает ${slowest.name} (${slowest.median} мин)` : ''}.`,
      todo: 'первый ответ на заявку — в течение 15 минут: дежурный менеджер на каждую смену, push о заявке включён на телефонах, авто-передача заявки другому менеджеру не выключена.' });
  }
  if (m.waits.over) out.push({ key: 'waits', title: 'Клиенты ждут ответа в переписке', roles: ['manager', 'desk', 'rop'],
    score: m.waits.over * 3 + m.waits.over3 * 4,
    fact: `${m.waits.over} раз клиент ждал ответа дольше нормы${was(m.waits.over, prev?.waits.over ?? null)}, из них втрое дольше — ${m.waits.over3}.`,
    todo: 'закрепите переписку за ответственными (вкладка «Переписка»), администратор на ресепшене отвечает на простые вопросы сразу, менеджер — на вопросы о покупке.' });
  if (m.calls.noCallback) out.push({ key: 'calls', title: 'Пропущенные звонки без перезвона', roles: ['desk', 'manager'],
    score: m.calls.noCallback * 4,
    fact: `пропущено ${m.calls.missed}, не перезвонили в течение 2 часов — ${m.calls.noCallback}${was(m.calls.noCallback, prev?.calls.noCallback ?? null)}.`,
    todo: 'перезванивать на пропущенный в течение 15 минут; если линия занята — администратор берёт трубку вторым.' });
  const T = m.tasks;
  if (T.late && pct(T.late, T.total) >= 15) {
    const top = m.tasksBy.filter((x) => x.late >= 2).slice(0, 2);
    out.push({ key: 'tasks', title: 'Задачи выполняются с опозданием', roles: ['manager', 'rop', 'gm'],
      score: T.late * 1.2 + T.escalations,
      fact: `просрочено ${T.late} из ${T.total} (${pct(T.late, T.total)} %)${was(pct(T.late, T.total), prev ? pct(prev.tasks.late, prev.tasks.total) : null, ' %')}, сигналов руководителям — ${T.escalations}${top.length ? `; больше всего у: ${top.map((x) => `${x.name} — ${x.late}`).join(', ')}` : ''}.`,
      todo: 'утром каждый сотрудник разбирает «Задачи на сегодня» и сразу переносит нереальные сроки; у кого просрочек больше всего — РОП разбирает загрузку и передаёт часть задач.' });
  }
  if (m.questions.slow >= 2) out.push({ key: 'team', title: 'Вопросы коллегам висят без ответа', roles: ['gm', 'rop'],
    score: m.questions.slow * 1.5,
    fact: `${m.questions.slow} из ${m.questions.total} вопросов в мессенджере сотрудников остались без ответа 2 часа и дольше${m.slowBy.length ? `; дольше всех отвечают: ${m.slowBy.slice(0, 3).map((x) => `${x.name} (${x.n})`).join(', ')}` : ''}.`,
    todo: 'договоритесь о правиле «ответ коллеге в течение часа в рабочее время»; срочное — с пометкой «Важно» или задачей, а не сообщением.' });
  if (m.deals.stuck) out.push({ key: 'deals', title: 'Сделки стоят без движения', roles: ['manager', 'rop'],
    score: m.deals.stuck,
    fact: `без движения 7 дней и больше — ${m.deals.stuck}${m.deals.slowStage ? `; дольше всего сделки стоят на этапе «${m.deals.slowStage.name}» — в среднем ${m.deals.slowStage.days} дн.` : '.'}`,
    todo: 'по каждой застрявшей сделке — звонок и решение «двигаем дальше или закрываем с причиной»; этап, на котором сделки стоят дольше всего, разберите на планёрке.' });
  const C = m.classes;
  const noShowRate = pct(C.noShow, C.came + C.noShow);
  if (C.sessions && C.noShow >= 3 && noShowRate >= 12) {
    const worst = m.classesBy.filter((x) => x.came + x.noShow >= 5).sort((a, b) => pct(b.noShow, b.came + b.noShow) - pct(a.noShow, a.came + a.noShow))[0];
    out.push({ key: 'noshow', title: 'Клиенты не приходят на занятия', roles: ['trainer', 'desk'],
      score: C.noShow * 1.5,
      fact: `неявок ${C.noShow} — ${noShowRate} % записей${was(noShowRate, prev ? pct(prev.classes.noShow, prev.classes.came + prev.classes.noShow) : null, ' %')}${worst && m.classesBy.length > 1 ? `; больше всего у тренера ${worst.name} — ${pct(worst.noShow, worst.came + worst.noShow)} %` : ''}.`,
      todo: 'напоминание клиенту за 2 часа до занятия, тренер лично пишет новичкам накануне; после двух неявок подряд — звонок менеджера.' });
  }
  const fill = pct(C.booked, C.cap);
  if (C.sessions >= 3 && fill < 40) out.push({ key: 'fill', title: 'Занятия заполнены слабо', roles: ['trainer', 'gm'],
    score: (40 - fill) / 2 + C.cancelled * 2,
    fact: `заполняемость ${fill} %${was(fill, prev && prev.classes.cap ? pct(prev.classes.booked, prev.classes.cap) : null, ' %')}, отменено занятий — ${C.cancelled}.`,
    todo: 'загляните в раздел «Загрузка»: пустые слоты перенесите на время повыше загрузки или замените формат; тренеры приглашают своих клиентов на групповые.' });
  if (m.processes.late) out.push({ key: 'proc', title: 'Бизнес-процессы выходят за срок', roles: ['gm', 'rop'],
    score: m.processes.late * 3,
    fact: `вышли за срок — ${m.processes.late}${m.processes.slowStep ? `; чаще всего задерживается шаг «${m.processes.slowStep.title}» (${m.processes.slowStep.n})` : ''}.`,
    todo: 'проверьте, реален ли срок у задерживающегося шага и тот ли исполнитель за него отвечает; срок и роль меняются в шаблоне процесса.' });
  if (m.meetings.invited && m.meetings.declined >= 2) out.push({ key: 'meet', title: 'Сотрудники не приходят на собрания', roles: ['gm'],
    score: m.meetings.declined,
    fact: `подтвердили ${m.meetings.confirmed} из ${m.meetings.invited}, отказались — ${m.meetings.declined}.`,
    todo: 'назначайте собрания через помощника — он подбирает время по расписанию каждого; важные собрания — с повесткой.' });
  return out.sort((a, b) => b.score - a.score);
}

/* ---------- подсказки по ролям и личные итоги ---------- */
/** Что делать каждой роли по каждому узкому месту — у каждой роли свой шаг */
const ROLE_TODO: Record<string, Partial<Record<Role, string>>> = {
  leads: { manager: 'отвечайте на новую заявку в течение 15 минут — держите push о заявках включённым на телефоне.', rop: 'назначьте дежурного по заявкам на каждую смену и дважды в день проверяйте заявки без ответа.', gm: 'проверьте, что на каждой смене есть менеджер на заявках.' },
  waits: { manager: 'начинайте и заканчивайте день разбором «Переписки»: ни одного клиента без ответа.', desk: 'на простые вопросы в переписке (расписание, цены, заморозка) отвечайте сразу, не передавая менеджеру.', rop: 'закрепите переписку за ответственными и проверяйте зависшие диалоги в обед.' },
  calls: { desk: 'перезванивайте на пропущенный в течение 15 минут; если линия занята — берите трубку вторым.', manager: 'пропущенные звонки по своим клиентам перезванивайте до конца часа.' },
  tasks: { manager: 'утром разберите «Задачи на сегодня» и сразу перенесите нереальные сроки — просрочка хуже переноса.', rop: 'у кого больше всего просрочек — разберите загрузку и передайте часть задач.', gm: 'поговорите лично с теми, у кого больше всего просрочек, а не в общем чате.' },
  team: { gm: 'введите правило «ответ коллеге в течение часа в рабочее время»; срочное — с пометкой «Важно» или задачей.', rop: 'вопросы по клиентам оформляйте задачей с исполнителем и сроком, а не сообщением.' },
  deals: { manager: 'пройдите свои сделки без движения: по каждой звонок и решение «двигаем дальше или закрываем с причиной».', rop: 'разберите застрявшие сделки на планёрке, начиная с этапа, где они стоят дольше всего.' },
  noshow: { trainer: 'накануне напишите новичкам, что ждёте их, и отмечайте явку на каждом занятии.', desk: 'после двух неявок подряд передавайте клиента менеджеру на звонок.', manager: 'звоните клиентам после двух неявок подряд: узнайте, что мешает, и запишите на удобное время.' },
  fill: { trainer: 'приглашайте своих персональных клиентов на групповые занятия.', gm: 'в разделе «Загрузка» перенесите пустые слоты на время повыше загрузки или замените формат.' },
  proc: { gm: 'проверьте срок и исполнителя у шага, который задерживается чаще всего, — они меняются в шаблоне процесса.', rop: 'по процессам, вышедшим за срок, передайте застрявший шаг свободному сотруднику.' },
  meet: { gm: 'назначайте собрания через помощника — он подберёт время по расписанию каждого; важные — с повесткой.' },
};
const ROLE_DEFAULT: Record<Role, string> = {
  manager: 'начинайте день с «Кому звонить» — помощник уже расставил клиентов по шансу покупки.',
  rop: 'разберите на планёрке два звонка лучшего менеджера недели — это самый быстрый способ подтянуть остальных.',
  desk: 'отмечайте приход каждого клиента — от этого зависят напоминания и возврат клиентов.',
  trainer: 'отмечайте явку на каждом занятии и приглашайте новичков на следующую тренировку прямо в зале.',
  gm: 'просмотрите цифры по сотрудникам: у кого просрочек больше всего — поговорите лично.',
};

function roleTips(m: WeekMetrics, bn: Bottleneck[]): Record<Role, string> {
  const out = {} as Record<Role, string>;
  const best = m.leadsBy.filter((x) => x.median != null && x.n >= 2).sort((a, b) => (a.median ?? 0) - (b.median ?? 0))[0];
  for (const r of Object.keys(ROLE_TITLE) as Role[]) {
    const b = bn.find((x) => ROLE_TODO[x.key]?.[r]);
    out[r] = b ? `${b.title.toLowerCase()} — ${ROLE_TODO[b.key][r]}`
      : r === 'manager' && best ? `держите скорость ответа на уровне лучшего: ${best.name} отвечает на заявку за ${best.median} мин.` : ROLE_DEFAULT[r];
  }
  return out;
}

function personalText(u: { id: string; name: string; role: string }, m: WeekMetrics, tips: Record<Role, string>, label: string) {
  const lines: string[] = [];
  const l = m.leadsBy.find((x) => x.id === u.id);
  if (l) {
    const best = m.leadsBy.filter((x) => x.median != null && x.n >= 2).sort((a, b) => (a.median ?? 0) - (b.median ?? 0))[0];
    lines.push(`• Заявок: ${l.n}, ответ в среднем через ${l.median ?? '—'} мин${best && best.id !== u.id && best.median != null ? ` (лучший в клубе — ${best.median} мин)` : ''}`);
  }
  const t = m.tasksBy.find((x) => x.id === u.id);
  if (t) lines.push(`• Задач со сроком на неделе: ${t.total}, с опозданием: ${t.late}${t.late ? '' : ' 👍'}`);
  const c = m.classesBy.find((x) => x.id === u.id);
  if (c) lines.push(`• Занятий: ${c.sessions}, заполняемость ${pct(c.booked, c.cap)} %, неявки ${pct(c.noShow, c.came + c.noShow)} %`);
  const s = m.slowBy.find((x) => x.id === u.id);
  if (s) lines.push(`• Вопросы коллег, оставшиеся без ответа 2 часа и дольше: ${s.n}`);
  if (!lines.length) return null;
  const role = (['manager', 'rop', 'desk', 'trainer', 'gm'] as Role[]).includes(u.role as Role) ? (u.role as Role) : 'manager';
  return `**Ваша неделя, ${label}**\n${lines.join('\n')}\n\n**Подсказка:** ${tips[role]}`;
}

/* ---------- текст разбора ---------- */
const INTRO_PROMPT = `Ты — ИИ-помощник руководителя фитнес-клуба. По цифрам недели и списку узких мест напиши 2–3 коротких предложения «Главное за неделю»:
что стало лучше или хуже и на чём сосредоточиться в первую очередь. Без приветствий, без списков, без выдуманных цифр.`;

export async function buildReview(db: Db, clubId: string, ws: string, yandex: YandexConfig | null) {
  const club = (await db.query(`select id, name, timezone from clubs where id = $1`, [clubId])).rows[0];
  if (!club) throw notFound('Клуб не найден');
  const m = await weekMetrics(db, clubId, club.timezone, ws);
  const prev = await weekMetrics(db, clubId, club.timezone, addDays(ws, -7));
  const bn = findBottlenecks(m, prev);
  const top = bn.slice(0, 3);
  const tips = roleTips(m, bn);
  const label = weekLabel(ws);

  let intro = top.length
    ? `Главное узкое место недели — **${top[0].title.toLowerCase()}**${top[1] ? `, следом — ${top[1].title.toLowerCase()}` : ''}. Начните с него: ниже — что именно сделать.`
    : 'Явных узких мест на этой неделе не видно — процессы идут в норме. Ниже цифры для сравнения.';
  let engine = 'rules';
  if (yandex && top.length) {
    try {
      const facts = [`Продажи: ${rub(m.salesKop)} (неделей раньше ${rub(prev.salesKop)})`, ...top.map((b) => `${b.title}: ${b.fact}`)].join('\n');
      const t = (await ygptComplete(yandex, INTRO_PROMPT, facts, { temperature: 0.3, maxTokens: 300 })).trim();
      if (t) { intro = t.slice(0, 700); engine = 'yandexgpt'; }
    } catch { /* остаёмся на правилах */ }
  }

  const L = m.leads; const T = m.tasks; const C = m.classes;
  const better: string[] = [];
  const improved = (cur: number, old: number, lowerIsBetter: boolean) => old > 0 && (lowerIsBetter ? cur <= old * 0.8 : cur >= old * 1.2);
  if (improved(m.salesKop, prev.salesKop, false)) better.push(`продажи выросли до ${rub(m.salesKop)} (было ${rub(prev.salesKop)})`);
  if (L.median != null && prev.leads.median != null && improved(L.median, prev.leads.median, true)) better.push(`ответ на заявку ускорился до ${L.median} мин (было ${prev.leads.median})`);
  if (improved(T.late, prev.tasks.late, true)) better.push(`просроченных задач меньше: ${T.late} (было ${prev.tasks.late})`);
  if (improved(m.waits.over, prev.waits.over, true)) better.push(`клиенты реже ждут ответа: ${m.waits.over} (было ${prev.waits.over})`);
  if (improved(C.noShow, prev.classes.noShow, true)) better.push(`неявок меньше: ${C.noShow} (было ${prev.classes.noShow})`);

  const parts: string[] = [];
  parts.push(`**Разбор недели · ${club.name}, ${label}**`, '', intro, '');
  parts.push('**Главные узкие места**');
  if (top.length) top.forEach((b, i) => parts.push(`${i + 1}. **${b.title}**: ${b.fact}\n   Что сделать: ${b.todo}`));
  else parts.push('Нет — все показатели в пределах нормы.');
  const more = bn.slice(3);
  if (more.length) parts.push(`Ещё стоит посмотреть: ${more.map((b) => b.title.toLowerCase()).join('; ')}.`);
  parts.push('', '**Цифры недели**');
  parts.push(`• Продажи: ${rub(m.salesKop)}${prev.salesKop !== m.salesKop ? ` (неделей раньше ${rub(prev.salesKop)})` : ''}`);
  parts.push(`• Заявки: ${L.total}${was(L.total, prev.leads.total)}; ответ в среднем через ${L.median ?? '—'} мин; позже нормы — ${L.late}; без ответа — ${L.noAnswer}; помощник передал другому менеджеру — ${L.reassigned}`);
  parts.push(`• Задачи со сроком на неделе: ${T.total}; с опозданием — ${T.late} (${pct(T.late, T.total)} %); сигналов руководителям — ${T.escalations}`);
  parts.push(`• Клиент ждал ответа в переписке дольше нормы: ${m.waits.over}${was(m.waits.over, prev.waits.over)}`);
  parts.push(`• Вопросы коллегам без ответа 2 часа и дольше: ${m.questions.slow} из ${m.questions.total}`);
  parts.push(`• Пропущенные звонки: ${m.calls.missed}; не перезвонили — ${m.calls.noCallback}`);
  parts.push(`• Сделки без движения 7+ дней: ${m.deals.stuck}${m.deals.slowStage ? `; дольше всего стоят на этапе «${m.deals.slowStage.name}» — ${m.deals.slowStage.days} дн.` : ''}`);
  parts.push(`• Занятия: ${C.sessions}; заполняемость ${pct(C.booked, C.cap)} %; неявки ${pct(C.noShow, C.came + C.noShow)} %; отменено — ${C.cancelled}`);
  parts.push(`• Бизнес-процессы: запущено ${m.processes.started}, завершено ${m.processes.done}, вышли за срок ${m.processes.late}${m.processes.slowStep ? `; чаще всего задерживается шаг «${m.processes.slowStep.title}»` : ''}`);
  if (m.meetings.invited) parts.push(`• Собрания: подтвердили ${m.meetings.confirmed} из ${m.meetings.invited}, отказались ${m.meetings.declined}`);
  if (better.length) parts.push('', '**Что стало лучше**', ...better.map((x) => `• ${x[0].toUpperCase()}${x.slice(1)}`));
  parts.push('', '**Подсказки по ролям**', ...(Object.keys(ROLE_TITLE) as Role[]).map((r) => `• ${ROLE_TITLE[r]}: ${tips[r]}`));
  parts.push('', 'Каждый сотрудник получает свои цифры за неделю и подсказку в «ИИ-помощнике».');
  const body = parts.join('\n').slice(0, 12000);
  return { club, ws, label, body, engine, metrics: m, prev, bottlenecks: bn, tips };
}

/** Короткая версия для сообщения в чат (до 4000 знаков) */
export function shortReview(r: { club: { name: string }; label: string; bottlenecks: Bottleneck[] }) {
  const top = r.bottlenecks.slice(0, 3);
  return [`**Разбор недели · ${r.club.name}, ${r.label}**`, '',
    top.length ? top.map((b, i) => `${i + 1}. **${b.title}**: ${b.fact}\n   Что сделать: ${b.todo}`).join('\n') : 'Явных узких мест нет — показатели в норме.',
    '', 'Полный разбор с цифрами и подсказками по ролям — раздел «Разбор недели».'].join('\n').slice(0, 3900);
}

/* ---------- сохранение и рассылка ---------- */
export async function saveReview(db: Db, actor: Actor, r: Awaited<ReturnType<typeof buildReview>>) {
  const data = { metrics: r.metrics, prev: r.prev, bottlenecks: r.bottlenecks, tips: r.tips };
  return (await db.query(`insert into agent_weekly_reviews(tenant_id, club_id, week_start, body, data, engine, created_by)
      values (app_tenant(), $1, $2, $3, $4, $5, $6)
    on conflict (club_id, week_start) do update set body = excluded.body, data = excluded.data, engine = excluded.engine, created_at = now()
    returning id, delivered_at`, [r.club.id, r.ws, r.body, JSON.stringify(data), r.engine, actor.userId])).rows[0] as { id: string; delivered_at: string | null };
}

export async function deliverReview(db: Db, actor: Actor, r: Awaited<ReturnType<typeof buildReview>>, reviewId: string) {
  const heads = await staffOf(db, r.club.id, ['owner', 'gm', 'rop']);
  const top = r.bottlenecks[0];
  await card(db, r.club.id, heads.map((u) => u.id), { kind: 'agent_weekly', title: `Разбор недели · ${r.club.name}, ${r.label}`,
    body: top ? `Главное узкое место: ${top.title.toLowerCase()}. ${top.fact}`.slice(0, 900) : 'Явных узких мест нет — показатели в норме.',
    objectType: null, objectId: null, actions: ['open'], link: { tab: 'weekly', p: { id: reviewId } } });
  const short = shortReview(r);
  for (const u of heads) await botSay(db, actor.tenantId, u.id, short, { kind: 'weekly_review', reviewId }, true);
  const headIds = new Set(heads.filter((u) => u.role === 'owner').map((u) => u.id));
  const staff = await staffOf(db, r.club.id, ['manager', 'rop', 'desk', 'trainer', 'gm']);
  const seen = new Set<string>();
  let personal = 0;
  for (const u of staff) {
    if (seen.has(u.id) || headIds.has(u.id)) continue;
    seen.add(u.id);
    const t = personalText(u, r.metrics, r.tips, r.label);
    if (t) { await botSay(db, actor.tenantId, u.id, t, { kind: 'weekly_personal' }, false); personal++; }
  }
  await db.query(`update agent_weekly_reviews set delivered_at = now() where id = $1`, [reviewId]);
  return { heads: heads.length, personal };
}

/** Проход агента: в понедельник с 9 до 14 по местному времени — разбор прошлой недели (один раз) */
export async function processWeeklyReview(db: Db, actor: Actor, clubId: string, yandex: YandexConfig | null = yandexConfigFromEnv()) {
  const c = (await db.query(`select timezone, extract(isodow from now() at time zone timezone)::int as dow, extract(hour from now() at time zone timezone)::int as h
    from clubs where id = $1`, [clubId])).rows[0];
  if (!c || c.dow !== 1 || c.h < 9 || c.h >= 14) return null;
  const ws = await lastWeekStart(db, c.timezone);
  const got = await db.query(`insert into agent_sent(tenant_id, club_id, key) values (app_tenant(), $1, $2) on conflict do nothing`, [clubId, `weekly:${ws}`]);
  if (!got.rowCount) return null;
  const r = await buildReview(db, clubId, ws, yandex);
  const saved = await saveReview(db, actor, r);
  return deliverReview(db, actor, r, saved.id);
}

/* ---------- чат: «разбор недели» ---------- */
export const WEEKLY_RE = /(разбор\S*\s+(прошл\S+\s+)?недел|итог\S*\s+(прошл\S+\s+)?недел|недельн\S*\s+(разбор|отч[её]т|итог)|узк\S*\s+мест\S*\s+(за|на|прошл)\S*\s*(прошл\S+\s+)?недел)/i;

export async function weeklyChatAnswer(db: Db, ctx: Ctx, text: string, yandex: YandexConfig | null) {
  const { visibleClubs, pickClubs } = await import('./agentOwner.ts');
  const clubs = pickClubs(text, await visibleClubs(db)).slice(0, 4);
  if (!clubs.length) return 'Не вижу ни одного клуба.';
  const out: string[] = [];
  for (const c of clubs) {
    const ws = await lastWeekStart(db, c.timezone);
    const r = await buildReview(db, c.id, ws, yandex);
    await saveReview(db, { tenantId: ctx.tenantId, userId: ctx.userId }, r);
    out.push(shortReview(r));
  }
  return out.join('\n\n').slice(0, 3900);
}

/* ---------- маршруты ---------- */
export function weeklyRoutes(app: FastifyInstance, pool: pg.Pool, yandex: YandexConfig | null) {
  const leader = (ctx: Ctx) => { if (!isLeader(ctx)) throw forbidden('Разбор недели доступен руководителям'); };

  app.get('/api/agent/weekly', async (req) => {
    const ctx = requireCtx(req); leader(ctx);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId) throw badRequest('Укажите клуб');
    return withCtx(pool, ctx, async (db) => {
      const items = (await db.query(`select id, to_char(week_start, 'YYYY-MM-DD') as "weekStart", engine, created_at as "createdAt", delivered_at as "deliveredAt",
          (select coalesce(json_agg(b->>'title'), '[]'::json) from (select b from jsonb_array_elements(data->'bottlenecks') b limit 3) x) as top
        from agent_weekly_reviews where club_id = $1 order by week_start desc limit 26`, [clubId])).rows;
      return { items: items.map((x) => ({ ...x, label: weekLabel(x.weekStart) })) };
    });
  });

  app.get('/api/agent/weekly/:id', async (req) => {
    const ctx = requireCtx(req); leader(ctx);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query(`select id, club_id as "clubId", to_char(week_start, 'YYYY-MM-DD') as "weekStart", body, engine, data, created_at as "createdAt", delivered_at as "deliveredAt"
        from agent_weekly_reviews where id = $1`, [id])).rows[0];
      if (!r) throw notFound('Разбор не найден');
      return { ...r, label: weekLabel(r.weekStart) };
    });
  });

  // Собрать разбор сейчас (за прошлую неделю или указанную); рассылку делает только понедельничный проход агента
  app.post('/api/agent/weekly/run', async (req) => {
    const ctx = requireCtx(req); leader(ctx);
    const b = (req.body ?? {}) as { clubId?: string; weekStart?: string };
    if (!b.clubId) throw badRequest('Укажите клуб');
    if (b.weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(b.weekStart)) throw badRequest('Неделя в формате ГГГГ-ММ-ДД');
    return withCtx(pool, ctx, async (db) => {
      const club = (await db.query(`select timezone from clubs where id = $1`, [b.clubId])).rows[0];
      if (!club) throw notFound('Клуб не найден');
      let ws = b.weekStart ?? (await lastWeekStart(db, club.timezone));
      ws = (await db.query(`select to_char(date_trunc('week', $1::date)::date, 'YYYY-MM-DD') as ws`, [ws])).rows[0].ws;
      const r = await buildReview(db, b.clubId!, ws, yandex);
      const saved = await saveReview(db, { tenantId: ctx.tenantId, userId: ctx.userId }, r);
      return { id: saved.id, weekStart: ws, label: r.label, body: r.body, engine: r.engine };
    });
  });
}

