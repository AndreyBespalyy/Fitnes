// ИИ-агент (просьба Андрея 14.11.2026, вариант 4А): утренние «3 подсказки на сегодня».
// Каждое утро в заданный час (по умолчанию 9:00 местного времени клуба) помощник присылает каждому сотруднику
// в «ИИ-помощник» три самых полезных шага на день — по его роли и его данным в CRM:
// менеджеру — заявки и переписка без ответа, горячие клиенты из «Кому звонить», просрочки;
// РОПу — где команда буксует; администратору — занятия, новички, продления, пропущенные звонки;
// тренеру — его занятия и новички, неявки вчера; управляющему и собственнику — план продаж, процессы, эскалации.
// Подсказки выбираются по пользе для клуба (вес), лишние отбрасываются; если данных мало — добавляются общие советы роли.
import type { Ctx, Db } from '../db.ts';
import { botSay } from './agentMeetings.ts';
import { clientsFact, lightOf, monthInfo, planFact, salesFact, targets } from './dash.ts';
import { staffOf } from './salesOps.ts';

type Actor = { tenantId: string; userId: string | null };
type Hint = { score: number; text: string };
export type Person = { id: string; name: string; role: string };

const ROLE_ORDER = ['owner', 'gm', 'rop', 'manager', 'desk', 'trainer', 'fin'];
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;
const names = (rows: { name: string }[], n = 3) => rows.slice(0, n).map((r) => r.name).join(', ') + (rows.length > n ? ` и ещё ${rows.length - n}` : '');
const ago = (min: number) => (min < 60 ? `${min} мин` : min < 1440 ? `${Math.floor(min / 60)} ч` : `${Math.floor(min / 1440)} дн.`);
const plural = (n: number, one: string, few: string, many: string) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

const DEFAULTS: Record<string, string[]> = {
  manager: ['**Начните с «Кому звонить»** — клиенты уже расставлены по шансу покупки, звоните сверху вниз.', '**После каждого звонка записывайте итог** — по нему помощник подскажет следующий шаг и напомнит вовремя.', '**Отвечайте на новую заявку в течение 15 минут** — так шанс продажи в разы выше.'],
  rop: ['**Послушайте два звонка менеджеров** и разберите их на планёрке — это самый быстрый способ поднять продажи.', '**Проверьте «Отдел продаж»** — у кого план отстаёт, помогите разобрать его список.', '**Дважды в день проверяйте заявки без ответа** — в обед и перед концом смены.'],
  desk: ['**Отмечайте приход каждого клиента** — от этого зависят напоминания, возврат клиентов и отчёты.', '**На простые вопросы в переписке отвечайте сразу** — расписание, цены, заморозка.', '**Встречайте новичков по имени** и предлагайте записаться на следующее занятие прямо на ресепшене.'],
  trainer: ['**Отмечайте явку сразу после занятия** — помощник напомнит не пришедшим и позовёт их снова.', '**Пригласите новичков на следующую тренировку** прямо в зале — это главный шаг, чтобы клиент остался.', '**Спросите у постоянных клиентов, как им занятия**, — хорошие отзывы помогают продлениям.'],
  gm: ['**Загляните в «Разбор недели»** — там главные узкие места клуба и что с ними сделать.', '**Пройдитесь по залу в пиковый час** — посмотрите, как администраторы встречают клиентов.', '**Проверьте «Бизнес-процессы»** — где шаг стоит дольше срока, помогите исполнителю.'],
  owner: ['**Спросите у помощника «выполним план?»** — покажу прогноз с вероятностью по каждому клубу.', '**Загляните в «Разбор недели»** — главные узкие места и что сделать.', '**Напишите «что горит»** — покажу, где сейчас теряются деньги и клиенты.'],
  fin: ['**Проверьте сверку с банком** — расхождения проще разобрать в тот же день.', '**Посмотрите неудачные автосписания** — напомните клиентам обновить карту.', '**Проверьте долги клиентов** и передайте список менеджерам.'],
};

async function tz(db: Db, clubId: string) {
  return (await db.query(`select timezone, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today from clubs where id = $1`, [clubId])).rows[0] as { timezone: string; today: string };
}

/* ---------- кандидаты в подсказки ---------- */
async function common(db: Db, u: Person, clubs: string[], tzName: string): Promise<Hint[]> {
  const out: Hint[] = [];
  const over = (await db.query(`select count(*)::int as n, (array_agg(title order by due_at))[1] as first, floor(extract(epoch from now() - min(due_at)) / 60)::int as late
    from tasks where assignee_id = $1 and done_at is null and due_at < now() and club_id = any($2)`, [u.id, clubs])).rows[0];
  if (over.n) out.push({ score: 90 + Math.min(over.n, 20), text: `**Закройте просроченные задачи: ${over.n}.** Самая старая — «${over.first}» (просрочена на ${ago(over.late)}). Если срок нереальный — перенесите, просрочка хуже переноса.` });
  const today = (await db.query(`select count(*)::int as n, (array_agg(title order by due_at))[1] as first, to_char(min(due_at) at time zone $3, 'HH24:MI') as at
    from tasks where assignee_id = $1 and done_at is null and club_id = any($2) and due_at >= now()
      and (due_at at time zone $3)::date = (now() at time zone $3)::date`, [u.id, clubs, tzName])).rows[0];
  if (today.n) out.push({ score: 55 + Math.min(today.n, 10), text: `**Сегодня ${today.n} ${plural(today.n, 'задача', 'задачи', 'задач')}**, первая в ${today.at} — «${today.first}».` });
  const meet = (await db.query(`select sm.title, sm.place, to_char(sm.starts_at at time zone $2, 'HH24:MI') as at, mm.status
    from staff_meetings sm join staff_meeting_members mm on mm.meeting_id = sm.id
    where mm.user_id = $1 and sm.status = 'planned' and sm.starts_at > now() and (sm.starts_at at time zone $2)::date = (now() at time zone $2)::date order by sm.starts_at limit 1`, [u.id, tzName])).rows[0];
  if (meet) out.push({ score: 75, text: `**Собрание «${meet.title}» в ${meet.at}**${meet.place ? ` — ${meet.place}` : ''}.${meet.status === 'invited' ? ' Подтвердите участие в приглашении.' : ''}` });
  const step = (await db.query(`select s.title, p.title as proc from process_steps s join processes p on p.id = s.process_id
    where s.assignee_id = $1 and s.status = 'active' and p.status = 'active' order by s.due_at limit 1`, [u.id])).rows[0];
  if (step) out.push({ score: 65, text: `**Ваш шаг в процессе «${step.proc}»:** ${step.title}. Отметьте его, когда сделаете, — помощник запустит следующий.` });
  return out;
}

async function manager(db: Db, u: Person, clubs: string[]): Promise<Hint[]> {
  const out: Hint[] = [];
  const leads = (await db.query(`select count(*)::int as n from leads where club_id = any($2) and first_response_at is null and created_at > now() - interval '3 days'
    and coalesce(taken_by, assigned_to) = $1`, [u.id, clubs])).rows[0].n;
  if (leads) out.push({ score: 120, text: `**Ответьте на заявки: ${leads}** — клиенты ждут первого ответа, каждая минута снижает шанс продажи.` });
  const wait = (await db.query(`select p.full_name as name from msg_conversations c left join persons p on p.id = c.person_id
    where c.club_id = any($2) and c.last_inbound_at > now() - interval '2 days'
      and (c.assigned_to = $1 or (c.assigned_to is null and exists (select 1 from opportunities o where o.person_id = c.person_id and o.status = 'open' and o.owner_id = $1)))
      and not exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'out' and not m.auto and m.created_at > c.last_inbound_at)
    order by c.last_inbound_at`, [u.id, clubs])).rows;
  if (wait.length) out.push({ score: 110, text: `**Ответьте в переписке: ${names(wait.map((w) => ({ name: w.name ?? 'клиент' })))}** — написали и ждут ответа.` });
  const hot = (await db.query(`select p.full_name as name, round(s.score * 100)::int as pct from client_scores s join persons p on p.id = s.person_id
    where s.club_id = any($2) and s.owner_id = $1 and s.segment = 'hot' and s.kind in ('purchase', 'renewal', 'return') order by s.score desc limit 3`, [u.id, clubs])).rows;
  if (hot.length) out.push({ score: 85, text: `**Позвоните первыми: ${hot.map((h) => `${h.name} (${h.pct} %)`).join(', ')}** — самые высокие шансы покупки в «Кому звонить».` });
  const stuck = (await db.query(`select count(*)::int as n from opportunities o where o.club_id = any($2) and o.owner_id = $1 and o.status = 'open'
    and coalesce((select max(h.at) from opportunity_stage_history h where h.opportunity_id = o.id), o.created_at) < now() - interval '7 days'`, [u.id, clubs])).rows[0].n;
  if (stuck) out.push({ score: 50 + Math.min(stuck, 20), text: `**Сдвиньте сделки без движения: ${stuck}** — по каждой звонок и решение «двигаем дальше или закрываем с причиной».` });
  return out;
}

async function rop(db: Db, u: Person, clubs: string[]): Promise<Hint[]> {
  const out: Hint[] = [];
  const leads = (await db.query(`select count(*)::int as n from leads where club_id = any($1) and first_response_at is null and created_at > now() - interval '1 day'`, [clubs])).rows[0].n;
  if (leads) out.push({ score: 100, text: `**Заявок без ответа в клубе: ${leads}** — проверьте, кто на смене, и раздайте их сейчас.` });
  const wait = (await db.query(`select count(*)::int as n from msg_conversations c where c.club_id = any($1) and c.last_inbound_at > now() - interval '1 day'
    and not exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'out' and not m.auto and m.created_at > c.last_inbound_at)`, [clubs])).rows[0].n;
  if (wait) out.push({ score: 90, text: `**Клиентов ждут ответа в переписке: ${wait}** — попросите менеджеров разобрать «Переписку» до обеда.` });
  const worst = (await db.query(`select u.full_name as name, count(*)::int as n from tasks t join users u on u.id = t.assignee_id
    where t.club_id = any($1) and t.done_at is null and t.due_at < now() and u.id <> $2 and not u.is_bot group by u.full_name order by n desc limit 1`, [clubs, u.id])).rows[0];
  if (worst && worst.n >= 3) out.push({ score: 80, text: `**Помогите сотруднику ${worst.name}**: у него просрочено задач — ${worst.n}. Разберите загрузку или передайте часть задач (напишите мне «передай задачи ${worst.name.split(' ')[0]}»).` });
  return out;
}

async function desk(db: Db, clubs: string[], tzName: string): Promise<Hint[]> {
  const out: Hint[] = [];
  const cls = (await db.query(`select count(distinct s.id)::int as n, count(b.id) filter (where b.status = 'booked')::int as booked,
      coalesce(json_agg(distinct p.full_name) filter (where b.trial and b.status = 'booked'), '[]') as trial
    from class_sessions s left join class_bookings b on b.session_id = s.id left join persons p on p.id = b.person_id
    where s.club_id = any($1) and s.status = 'scheduled' and s.starts_at > now() and (s.starts_at at time zone $2)::date = (now() at time zone $2)::date`, [clubs, tzName])).rows[0];
  const trial = cls.trial as string[];
  if (cls.n) out.push({ score: trial.length ? 85 : 55, text: `**Сегодня ${cls.n} ${plural(cls.n, 'занятие', 'занятия', 'занятий')}, записано ${cls.booked}.**${trial.length ? ` Новички на пробном: ${names(trial.map((name) => ({ name })))} — встретьте и покажите зал.` : ''}` });
  const ending = (await db.query(`select p.full_name as name from memberships m join persons p on p.id = m.person_id
    where m.club_id = any($1) and m.status = 'active' and m.kind <> 'guest' and m.ends_on between (now() at time zone $2)::date and (now() at time zone $2)::date + 3
      and not exists (select 1 from memberships n where n.person_id = m.person_id and n.created_at > m.created_at and n.status <> 'cancelled')
    order by m.ends_on`, [clubs, tzName])).rows;
  if (ending.length) out.push({ score: 80, text: `**Предложите продление: ${names(ending)}** — абонемент заканчивается в ближайшие 3 дня. Скажите при встрече на ресепшене.` });
  const missed = (await db.query(`select count(*)::int as n from calls c where c.club_id = any($1) and c.direction = 'in' and coalesce(c.duration_sec, 0) = 0
    and c.started_at > now() - interval '1 day'
    and not exists (select 1 from calls o where o.club_id = c.club_id and o.direction = 'out' and o.phone = c.phone and o.started_at > c.started_at)`, [clubs])).rows[0].n;
  if (missed) out.push({ score: 95, text: `**Перезвоните на пропущенные: ${missed}** — за последние сутки, ещё без перезвона.` });
  const wait = (await db.query(`select count(*)::int as n from msg_conversations c where c.club_id = any($1) and c.assigned_to is null and c.last_inbound_at > now() - interval '1 day'
    and not exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'out' and not m.auto and m.created_at > c.last_inbound_at)`, [clubs])).rows[0].n;
  if (wait) out.push({ score: 88, text: `**Ответьте в переписке без ответственного: ${wait}** — на простые вопросы сразу, вопросы о покупке передайте менеджеру.` });
  return out;
}

async function trainer(db: Db, u: Person, clubs: string[], tzName: string): Promise<Hint[]> {
  const out: Hint[] = [];
  const my = (await db.query(`select count(distinct s.id)::int as n, count(b.id) filter (where b.status = 'booked')::int as booked,
      to_char(min(s.starts_at) at time zone $3, 'HH24:MI') as first,
      coalesce(json_agg(distinct p.full_name) filter (where b.status = 'booked' and (b.trial or not exists (select 1 from visits v where v.person_id = b.person_id and v.visited_at < now() - interval '1 day'))), '[]') as newbies
    from class_sessions s left join class_bookings b on b.session_id = s.id left join persons p on p.id = b.person_id
    where s.trainer_id = $1 and s.club_id = any($2) and s.status = 'scheduled' and s.starts_at > now() and (s.starts_at at time zone $3)::date = (now() at time zone $3)::date`, [u.id, clubs, tzName])).rows[0];
  const nb = my.newbies as string[];
  if (my.n) out.push({ score: 90, text: `**Сегодня у вас ${my.n} ${plural(my.n, 'занятие', 'занятия', 'занятий')}, первое в ${my.first}, записано ${my.booked}.**${nb.length ? ` Новички: ${names(nb.map((name) => ({ name })))} — познакомьтесь до начала и пригласите на следующее.` : ''}` });
  const ns = (await db.query(`select distinct p.full_name as name from class_bookings b join class_sessions s on s.id = b.session_id join persons p on p.id = b.person_id
    where s.trainer_id = $1 and b.status = 'no_show' and (s.starts_at at time zone $2)::date = (now() at time zone $2)::date - 1`, [u.id, tzName])).rows;
  if (ns.length) out.push({ score: 75, text: `**Напишите не пришедшим вчера: ${names(ns)}** — спросите, всё ли в порядке, и позовите на следующее занятие.` });
  const idle = (await db.query(`select p.full_name as name from persons p where exists (select 1 from class_bookings b join class_sessions s on s.id = b.session_id
      where b.person_id = p.id and s.trainer_id = $1 and b.status = 'attended' and s.starts_at > now() - interval '60 days')
    and coalesce((select max(v.visited_at) from visits v where v.person_id = p.id), now() - interval '100 days') < now() - interval '14 days' limit 5`, [u.id])).rows;
  if (idle.length) out.push({ score: 60, text: `**Ваши клиенты пропали на 2 недели: ${names(idle)}** — короткое сообщение от тренера часто возвращает лучше любой акции.` });
  return out;
}

async function head(db: Db, u: Person, clubs: string[], today: string): Promise<Hint[]> {
  const out: Hint[] = [];
  const mi = monthInfo(today.slice(0, 7), today);
  const lt = { ...mi, ...(await lightOf(db, clubs)) };
  const tg = await targets(db, clubs, mi.from.slice(0, 7));
  const sf = await salesFact(db, clubs, mi.from, today);
  const cf = await clientsFact(db, clubs, mi.from, today);
  const pf = planFact(lt, tg, sf, cf, {});
  const passed = Math.round((mi.passed / mi.days) * 100);
  if (pf.total.light === 'red') out.push({ score: 95, text: `**План продаж отстаёт: ${pf.total.percent} % при прошедших ${passed} % месяца.** Спросите меня «выполним план?» — покажу прогноз и где добрать.` });
  else if (pf.total.percent != null && pf.total.percent > 0) out.push({ score: 35, text: `**План продаж: ${pf.total.percent} % при прошедших ${passed} % месяца** — идём ${pf.total.light === 'green' ? 'в графике' : 'чуть ниже графика'}.` });
  const yest = (await db.query(`select to_char($1::date - 1, 'YYYY-MM-DD') as d`, [today])).rows[0].d;
  const ys = (await salesFact(db, clubs, yest, yest)).reduce((a, x) => a + x.kop, 0);
  if (ys) out.push({ score: 40, text: `**Вчера продажи: ${rub(ys)}.**` });
  const late = (await db.query(`select count(*)::int as n from processes where club_id = any($1) and status = 'active' and due_at < now()`, [clubs])).rows[0].n;
  if (late) out.push({ score: 80, text: `**Бизнес-процессы вышли за срок: ${late}** — напишите мне «процессы», покажу, на ком застряли.` });
  const esc = (await db.query(`select count(*)::int as n from agent_sent where club_id = any($1) and key like 'task:%' and key not like '%:1' and sent_at > now() - interval '1 day'`, [clubs])).rows[0].n;
  if (esc >= 3) out.push({ score: 70, text: `**За сутки ${esc} сигналов о просроченных задачах дошли до руководителей** — напишите «что горит», покажу, у кого завал.` });
  const leads = (await db.query(`select count(*)::int as n from leads where club_id = any($1) and first_response_at is null and created_at > now() - interval '1 day'`, [clubs])).rows[0].n;
  if (leads && u.role === 'owner') out.push({ score: 85, text: `**Заявок без ответа за сутки: ${leads}** — это потерянные деньги; спросите управляющего, кто на смене.` });
  return out;
}

/** Совет из последнего разбора недели для роли — если он свежий (не старше 8 дней) */
async function weeklyTip(db: Db, clubs: string[], role: string): Promise<Hint[]> {
  const r = (await db.query(`select data->'tips'->>$2 as tip from agent_weekly_reviews where club_id = any($1) and created_at > now() - interval '8 days' order by created_at desc limit 1`, [clubs, role])).rows[0];
  return r?.tip ? [{ score: 30, text: `**Из разбора недели:** ${r.tip}` }] : [];
}

/* ---------- сборка ---------- */
export async function morningHints(db: Db, u: Person, clubIds: string[]) {
  const t = await tz(db, clubIds[0]);
  const role = u.role;
  const hints: Hint[] = [...(await common(db, u, clubIds, t.timezone))];
  if (role === 'manager') hints.push(...(await manager(db, u, clubIds)));
  if (role === 'rop') hints.push(...(await rop(db, u, clubIds)), ...(await manager(db, u, clubIds)));
  if (role === 'desk') hints.push(...(await desk(db, clubIds, t.timezone)));
  if (role === 'trainer') hints.push(...(await trainer(db, u, clubIds, t.timezone)));
  if (role === 'gm' || role === 'owner') hints.push(...(await head(db, u, clubIds, t.today)));
  if (role === 'gm') hints.push(...(await rop(db, u, clubIds)).map((h) => ({ ...h, score: h.score - 15 })));
  const weeklyRole = role === 'owner' ? 'gm' : role;
  if (['manager', 'rop', 'desk', 'trainer', 'gm'].includes(weeklyRole)) hints.push(...(await weeklyTip(db, clubIds, weeklyRole)));
  const top = hints.sort((a, b) => b.score - a.score).slice(0, 3).map((h) => h.text);
  for (const d of DEFAULTS[role] ?? DEFAULTS.manager) { if (top.length >= 3) break; top.push(d); }
  return top;
}

export function hintsText(name: string, hints: string[]) {
  return [`**Доброе утро, ${name.split(' ')[0]}! 3 подсказки на сегодня:**`, ...hints.map((h, i) => `${i + 1}. ${h}`)].join('\n');
}

/** Основная роль сотрудника в клубе (если ролей несколько — самая «старшая») */
async function roleOf(db: Db, userId: string, clubId: string | null) {
  const rows = (await db.query(`select a.role_code from user_assignments a where a.user_id = $1 and (a.club_id = $2 or a.club_id is null or $2::uuid is null)
    and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`, [userId, clubId])).rows.map((r) => r.role_code as string);
  return ROLE_ORDER.find((r) => rows.includes(r)) ?? rows[0] ?? 'manager';
}

/** Утренний проход по клубу: один раз в день каждому сотруднику (собственнику — один раз по всем клубам) */
export async function processMorningHints(db: Db, actor: Actor, clubId: string) {
  const t = await tz(db, clubId);
  const got = await db.query(`insert into agent_sent(tenant_id, club_id, key) values (app_tenant(), $1, $2) on conflict do nothing`, [clubId, `morning:${t.today}`]);
  if (!got.rowCount) return 0;
  const staff = await staffOf(db, clubId, ROLE_ORDER);
  const seen = new Set<string>();
  let sent = 0;
  for (const s of staff) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    // Уже получил сегодня (собственник по другому клубу) или в отпуске / на больничном / выходном
    const already = (await db.query(`select 1 from team_messages m where m.meta->>'kind' = 'morning_hints' and m.meta->>'userId' = $1 and m.meta->>'day' = $2 limit 1`, [s.id, t.today])).rowCount;
    if (already) continue;
    const off = (await db.query(`select 1 from staff_absences where user_id = $1 and $2::date between date_from and date_to limit 1`, [s.id, t.today])).rowCount;
    if (off) continue;
    const role = await roleOf(db, s.id, clubId);
    const clubs = role === 'owner' ? (await db.query(`select id from clubs where status = 'active' and not is_demo order by name`)).rows.map((r) => r.id as string) : [clubId];
    const hints = await morningHints(db, { id: s.id, name: s.name, role }, clubs.length ? clubs : [clubId]);
    await botSay(db, actor.tenantId, s.id, hintsText(s.name, hints), { kind: 'morning_hints', userId: s.id, day: t.today }, false);
    sent++;
  }
  return sent;
}

/* ---------- чат: «подсказки на сегодня», «с чего начать» ---------- */
export const HINTS_RE = /(подсказк\S*\s+на\s+сегодня|^(мои\s+)?подсказки[.!?]*$|с чего (мне )?начать|что (мне )?(сделать|делать) сегодня|чем (мне )?заняться)/i;

export async function hintsChatAnswer(db: Db, ctx: Ctx) {
  const me = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0];
  const role = await roleOf(db, ctx.userId, null);
  let clubs: string[];
  if (role === 'owner') clubs = (await db.query(`select id from clubs where status = 'active' and not is_demo order by name`)).rows.map((r) => r.id);
  else clubs = (await db.query(`select distinct a.club_id from user_assignments a join clubs c on c.id = a.club_id where a.user_id = $1 and a.club_id is not null
    and (a.active_to is null or a.active_to >= current_date) order by a.club_id`, [ctx.userId])).rows.map((r) => r.club_id);
  if (!clubs.length) clubs = (await db.query(`select id from clubs order by name limit 1`)).rows.map((r) => r.id);
  if (!clubs.length) return 'Не вижу клуба, к которому вы привязаны.';
  const hints = await morningHints(db, { id: ctx.userId, name: me?.full_name ?? '', role }, clubs);
  return [`**3 подсказки на сегодня:**`, ...hints.map((h, i) => `${i + 1}. ${h}`)].join('\n');
}
