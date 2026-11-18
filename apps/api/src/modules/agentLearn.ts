// ИИ-помощник учится на отзывах (просьба Андрея 17.11.2026: «чтобы ИИ-помощник обучался и совершенствовался»).
// Дообучать саму нейросеть на процессоре сервера нереально, поэтому помощник учится так, как учится новый сотрудник:
// 1) каждая подсказка, карточка и ответ записываются (agent_suggestions);
// 2) сотрудник нажимает «Полезно» или «Не то» и выбирает причину;
// 3) система сама смотрит, чем кончилось: задачу закрыли, клиенту позвонили или написали, была продажа — или подсказку проигнорировали;
// 4) по этим данным у каждого типа подсказки для каждой роли в клубе считается «вес»: полезное показывается выше и чаще,
//    то, что игнорируют, — ниже, совсем бесполезное помощник выключает сам на месяц и потом пробует снова;
// 5) у каждого сотрудника ещё и личная поправка: что полезно лично ему;
// 6) ответы, которые оценили «Полезно», становятся образцами для нейросети (подставляются в задание модели).
// Руководитель видит всё это на странице «Чему научился помощник» и может сам сказать: «чаще» или «не показывать».
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { isLeader } from './agentOwner.ts';

export type Targets = { taskIds?: string[]; personIds?: string[]; leadIds?: string[]; conversationIds?: string[]; opportunityIds?: string[]; sessionIds?: string[]; userIds?: string[] };
export type Source = 'morning' | 'card' | 'chat' | 'advice';
export type Reason = 'done_already' | 'not_relevant' | 'wrong_data' | 'unclear' | 'not_mine' | 'other';

export const REASON_NAME: Record<Reason, string> = {
  done_already: 'Уже сделал', not_relevant: 'Неактуально', wrong_data: 'Неверные данные', unclear: 'Непонятно', not_mine: 'Не моя задача', other: 'Другое',
};

/** Понятные названия типов подсказок для страницы «Чему научился помощник» */
export const KIND_NAME: Record<string, string> = {
  overdue_tasks: 'Закрыть просроченные задачи', today_tasks: 'Задачи на сегодня', meeting: 'Собрание сегодня', process_step: 'Мой шаг в бизнес-процессе',
  leads_reply: 'Ответить на заявки', msg_reply: 'Ответить в переписке', hot_calls: 'Позвонить горячим клиентам', stuck_deals: 'Сдвинуть сделки без движения',
  rop_leads: 'Раздать заявки без ответа', rop_msgs: 'Переписка без ответа в клубе', rop_help: 'Помочь сотруднику с завалом',
  desk_classes: 'Занятия и новички сегодня', desk_renew: 'Предложить продление', desk_missed: 'Перезвонить на пропущенные', desk_msgs: 'Переписка без ответственного',
  trainer_classes: 'Мои занятия и новички', trainer_noshow: 'Написать не пришедшим', trainer_idle: 'Вернуть пропавших клиентов',
  plan_red: 'План продаж отстаёт', plan_status: 'Как идёт план продаж', sales_yesterday: 'Продажи вчера', proc_late: 'Процессы вышли за срок',
  escalations: 'Сигналы о просрочках', owner_leads: 'Заявки без ответа (собственнику)', weekly_tip: 'Совет из разбора недели', weekly_tip_staff: 'Совет из разбора недели', tip: 'Общий совет роли',
  'card:agent_task': 'Карточка: просрочена задача', 'card:agent_reply': 'Карточка: клиент ждёт ответа', 'card:agent_lead': 'Карточка: заявка ждёт или передана',
  'card:agent_process': 'Карточка: бизнес-процесс', 'card:agent_meeting_move': 'Карточка: перенести ради собрания', 'card:agent_escalate': 'Карточка: просрочка дошла до руководителя',
  'card:agent_nudge': 'Карточка: руководитель просит разобрать задачи', 'card:agent_reassign': 'Карточка: задачи переданы', 'card:agent_weekly': 'Карточка: разбор недели',
  'chat:hints': 'Ответ: подсказки на сегодня', 'chat:tasks': 'Ответ: мои задачи', 'chat:brief': 'Ответ: коротко о ситуации', 'chat:owner': 'Ответ руководителю',
  'chat:weekly': 'Ответ: разбор недели', 'chat:meeting': 'Ответ: собрания', 'chat:process': 'Ответ: бизнес-процессы', 'chat:other': 'Ответ на другой вопрос',
  // Советы по переписке в мессенджере (teamAdvice.ts): msg_<тема>
  msg_complaint: 'Совет по переписке: жалоба клиента', msg_new_client: 'Совет по переписке: новый клиент', msg_renewal: 'Совет по переписке: продление',
  msg_return: 'Совет по переписке: возврат клиента', msg_new_staff: 'Совет по переписке: новый сотрудник', msg_meeting: 'Совет по переписке: собрание',
  msg_equipment: 'Совет по переписке: поломка и ремонт', msg_schedule: 'Совет по переписке: расписание и замены', msg_payment: 'Совет по переписке: оплата и касса',
  msg_cleaning: 'Совет по переписке: чистота и порядок', msg_task: 'Совет по переписке: поручение',
};
export const kindName = (k: string) => KIND_NAME[k] ?? (k.startsWith('msg_') ? `Совет по переписке: ${k.slice(4).replace(/_/g, ' ')}` : k.startsWith('tip') ? KIND_NAME.tip : k);

const ROLE_NAME: Record<string, string> = { owner: 'Собственник', gm: 'Управляющий', rop: 'РОП', manager: 'Менеджеры', desk: 'Администраторы', trainer: 'Тренеры', fin: 'Финансист' };

const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const cleanTargets = (t: Targets = {}) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...new Set((v ?? []).filter(uuid))].slice(0, 50)]).filter(([, v]) => v.length));

/** Записать подсказку, которую увидел сотрудник. Возвращает её номер — его кладут в сообщение или карточку для кнопок оценки. */
export async function recordSuggestion(db: Db, s: { clubId: string | null; userId: string; role?: string | null; source: Source; kind: string; body: string;
  question?: string | null; targets?: Targets; messageId?: string | null; notificationId?: string | null }) {
  return (await db.query(`insert into agent_suggestions(tenant_id, club_id, user_id, role, source, kind, body, question, targets, message_id, notification_id)
    values (app_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
  [s.clubId, s.userId, s.role ?? null, s.source, s.kind.slice(0, 80), s.body.slice(0, 4000), s.question?.slice(0, 1000) ?? null, JSON.stringify(cleanTargets(s.targets)),
    s.messageId ?? null, s.notificationId ?? null])).rows[0].id as string;
}

/* ---------- вес типа подсказки ---------- */
export type KindStat = { shown: number; likes: number; dislikes: number; doneAlready: number; done: number; sales: number; ignored: number };
const EMPTY: KindStat = { shown: 0, likes: 0, dislikes: 0, doneAlready: 0, done: 0, sales: 0, ignored: 0 };

/** Доля пользы со сглаживанием: пока данных мало, вес около 1 (как было), с данными — сдвигается. */
export function usefulRate(s: KindStat, prior = 2) {
  const pos = s.likes + s.done + 2 * s.sales + 0.5 * s.doneAlready;
  const neg = (s.dislikes - s.doneAlready) + 0.5 * s.doneAlready + 0.6 * s.ignored;
  return (pos + prior) / (pos + neg + 2 * prior);
}
/** Сколько подсказок уже «оценено» — оценкой сотрудника или результатом */
export const evaluated = (s: KindStat) => s.likes + s.dislikes + s.done + s.sales + s.ignored;

export type Learned = { weight: number; status: 'off' | 'auto_off' | 'boost' | 'up' | 'down' | 'normal'; rate: number; stat: KindStat };

/** Вес по клубу и роли: 0.4…1.6; при 8+ оценённых и пользе ниже 25 % — выключено (на месяц, потом данные «стареют» и помощник пробует снова) */
export function weightFrom(stat: KindStat, mode: 'boost' | 'off' | null): Learned {
  const rate = usefulRate(stat);
  if (mode === 'off') return { weight: 0, status: 'off', rate, stat };
  if (evaluated(stat) >= 8 && rate < 0.25 && mode !== 'boost') return { weight: 0, status: 'auto_off', rate, stat };
  let weight = Math.min(1.6, Math.max(0.4, 0.4 + 1.2 * rate));
  if (mode === 'boost') return { weight: Math.max(weight, 1) * 1.5, status: 'boost', rate, stat };
  const status = weight >= 1.15 ? 'up' : weight <= 0.85 ? 'down' : 'normal';
  weight = Math.round(weight * 100) / 100;
  return { weight, status, rate, stat };
}

const STAT_SQL = `count(*)::int as shown, count(*) filter (where rating = 1)::int as likes, count(*) filter (where rating = -1)::int as dislikes,
  count(*) filter (where rating = -1 and reason = 'done_already')::int as "doneAlready", count(*) filter (where outcome = 'done')::int as done,
  count(*) filter (where outcome = 'sale')::int as sales, count(*) filter (where outcome = 'ignored' and rating is null)::int as ignored`;

export async function learningOn(db: Db, clubId: string) {
  const r = (await db.query(`select learning from agent_settings where club_id = $1`, [clubId])).rows[0];
  return r ? r.learning !== false : true;
}

/** Веса типов подсказок для сотрудника: клуб + роль за 30 дней, плюс личная поправка по его собственным оценкам */
export async function learnedWeights(db: Db, clubIds: string[], role: string, userId?: string | null) {
  const out = new Map<string, Learned & { personal: number }>();
  if (!clubIds.length) return out;
  const on = (await db.query(`select coalesce(bool_and(coalesce(s.learning, true)), true) as on from clubs c left join agent_settings s on s.club_id = c.id where c.id = any($1)`, [clubIds])).rows[0].on;
  const rules = new Map<string, 'boost' | 'off'>();
  // Ручное решение руководителя: если клубов несколько — «не показывать» сильнее «чаще»
  for (const r of (await db.query(`select kind, mode from agent_kind_rules where club_id = any($1) and role = $2`, [clubIds, role])).rows) {
    if (rules.get(r.kind) !== 'off') rules.set(r.kind, r.mode);
  }
  const stats = on ? (await db.query(`select kind, ${STAT_SQL} from agent_suggestions where club_id = any($1) and role = $2 and created_at > now() - interval '30 days' group by kind`, [clubIds, role])).rows : [];
  const mine = on && userId ? (await db.query(`select kind, ${STAT_SQL} from agent_suggestions where user_id = $1 and created_at > now() - interval '30 days' group by kind`, [userId])).rows : [];
  const myMap = new Map(mine.map((r) => [r.kind as string, r as KindStat & { kind: string }]));
  const kinds = new Set([...stats.map((r) => r.kind as string), ...rules.keys(), ...myMap.keys()]);
  const statMap = new Map(stats.map((r) => [r.kind as string, r as KindStat]));
  for (const k of kinds) {
    const l = weightFrom(statMap.get(k) ?? EMPTY, rules.get(k) ?? null);
    const m = myMap.get(k);
    // Личная поправка 0.6…1.4; дважды «Не моя задача» — лично этому сотруднику больше не показывать
    let personal = m ? 0.6 + 0.8 * usefulRate(m, 3) : 1;
    if (m && (await db.query(`select count(*)::int as n from agent_suggestions where user_id = $1 and kind = $2 and reason = 'not_mine' and rated_at > now() - interval '30 days'`, [userId, k])).rows[0].n >= 2) personal = 0;
    out.set(k, { ...l, personal: Math.round(personal * 100) / 100 });
  }
  return out;
}

/** Итоговый множитель для подсказки (1 — если о ней ещё ничего не известно) */
export function weightOf(w: Map<string, Learned & { personal: number }>, kind: string) {
  const x = w.get(kind);
  return x ? x.weight * x.personal : 1;
}

/** Для соседних модулей (например, советы по переписке): вес одного типа подсказки */
export async function learnedWeight(db: Db, clubId: string, role: string, kind: string, userId?: string | null) {
  return weightOf(await learnedWeights(db, [clubId], role, userId), kind);
}

/* ---------- оценка сотрудником ---------- */
export async function rateSuggestion(db: Db, ctx: Ctx, id: string, rating: 1 | -1, reason: Reason | null, comment: string | null) {
  const s = (await db.query(`select id, message_id, outcome from agent_suggestions where id = $1 and user_id = $2`, [id, ctx.userId])).rows[0];
  if (!s) throw notFound('Подсказка не найдена');
  await db.query(`update agent_suggestions set rating = $2, reason = $3, comment = $4, rated_at = now(),
      outcome = case when $3 = 'done_already' and outcome is null then 'done' else outcome end,
      outcome_note = case when $3 = 'done_already' and outcome is null then 'сотрудник: уже сделал' else outcome_note end,
      outcome_at = case when $3 = 'done_already' and outcome is null then now() else outcome_at end
    where id = $1`, [id, rating, rating === 1 ? null : reason, comment?.trim().slice(0, 500) || null]);
  // Запоминаем оценку в самом сообщении: после обновления страницы кнопки показывают выбор
  if (s.message_id) {
    await db.query(`update team_messages set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('rated', coalesce(meta->'rated', '{}'::jsonb) || jsonb_build_object($2::text, $3::int)) where id = $1`, [s.message_id, id, rating]);
  }
  return { ok: true, message: rating === 1 ? 'Спасибо! Буду чаще давать такие подсказки' : 'Понял, учту — такие подсказки буду давать реже' };
}

/* ---------- чем кончилось: проверка результата ---------- */
/** Проверяет свежие подсказки клуба: что сделали после неё. Через 2 суток без действий — «проигнорировано». */
export async function processOutcomes(db: Db, clubId: string) {
  const rows = (await db.query(`select id, user_id, targets, created_at, created_at < now() - interval '2 days' as old from agent_suggestions
    where club_id = $1 and outcome is null and targets <> '{}'::jsonb and created_at < now() - interval '30 minutes' and created_at > now() - interval '4 days'
    order by created_at limit 300`, [clubId])).rows;
  let n = 0;
  for (const s of rows) {
    const t = s.targets as Targets;
    const r = (await db.query(`with p as (
        select unnest($2::uuid[]) as id
        union select person_id from leads where id = any($3) and person_id is not null
        union select person_id from opportunities where id = any($4)
        union select person_id from msg_conversations where id = any($5) and person_id is not null)
      select
        exists (select 1 from memberships m where m.person_id in (select id from p) and m.created_at > $1 and m.status <> 'cancelled')
          or exists (select 1 from opportunities o where (o.id = any($4) or o.person_id in (select id from p)) and o.status = 'won' and o.closed_at > $1) as sale,
        (select count(*) from tasks where id = any($6) and done_at > $1)::int as tasks_done,
        exists (select 1 from leads where id = any($3) and first_response_at > $1) as lead_answered,
        exists (select 1 from calls c where c.person_id in (select id from p) and c.direction = 'out' and c.started_at > $1) as called,
        exists (select 1 from msg_messages mm join msg_conversations mc on mc.id = mm.conversation_id
          where (mc.id = any($5) or mc.person_id in (select id from p)) and mm.direction = 'out' and not mm.auto and mm.created_at > $1) as wrote,
        exists (select 1 from opportunity_stage_history h where h.opportunity_id = any($4) and h.at > $1) as moved`,
    [s.created_at, t.personIds ?? [], t.leadIds ?? [], t.opportunityIds ?? [], t.conversationIds ?? [], t.taskIds ?? []])).rows[0];
    let outcome: 'sale' | 'done' | 'ignored' | null = null; let note = '';
    if (r.sale) { outcome = 'sale'; note = 'после подсказки была продажа'; }
    else if (r.tasks_done || r.lead_answered || r.called || r.wrote || r.moved) {
      outcome = 'done';
      note = [r.tasks_done ? `закрыто задач: ${r.tasks_done}` : '', r.lead_answered ? 'ответили на заявку' : '', r.called ? 'позвонили' : '', r.wrote ? 'написали клиенту' : '', r.moved ? 'сделка сдвинулась' : ''].filter(Boolean).join(', ');
    } else if (s.old) { outcome = 'ignored'; note = 'за 2 дня ничего не сделано'; }
    if (!outcome) continue;
    await db.query(`update agent_suggestions set outcome = $2, outcome_note = $3, outcome_at = now() where id = $1 and outcome is null`, [s.id, outcome, note]);
    n++;
  }
  // Подсказки без проверяемого результата (общие советы) и без оценки за 2 дня — просто «без отклика», в учёт идёт только оценка
  return n;
}

/* ---------- образцы для нейросети ---------- */
/** Удачные ответы помощника (оценены «Полезно») — подставляются в задание модели как образец тона и формы */
export async function goodExamples(db: Db, kinds: string[], n = 3) {
  const rows = (await db.query(`select question, body from agent_suggestions where rating = 1 and kind = any($1) and question is not null
    and rated_at > now() - interval '90 days' order by rated_at desc limit $2`, [kinds, n])).rows;
  const bad = (await db.query(`select reason, count(*)::int as n from agent_suggestions where rating = -1 and kind = any($1) and rated_at > now() - interval '90 days'
    group by reason order by n desc limit 2`, [kinds])).rows;
  const parts: string[] = [];
  if (rows.length) parts.push(`Сотрудники клуба оценили эти ответы как полезные — отвечай в том же духе:\n${rows.map((r, i) => `Пример ${i + 1}. Вопрос: ${r.question}\nОтвет: ${String(r.body).slice(0, 700)}`).join('\n\n')}`);
  if (bad.some((b) => b.reason === 'unclear')) parts.push('Сотрудники жаловались, что ответы непонятны: пиши короче и проще, сначала главное.');
  if (bad.some((b) => b.reason === 'wrong_data')) parts.push('Сотрудники находили неверные данные: опирайся только на переданные факты, ничего не додумывай.');
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/* ---------- отчёт «Чему научился помощник» ---------- */
export async function learningReport(db: Db, clubIds: string[], days: number) {
  const kinds = (await db.query(`select kind, role, ${STAT_SQL} from agent_suggestions where club_id = any($1) and created_at > now() - make_interval(days => $2)
    group by kind, role order by count(*) desc`, [clubIds, days])).rows as (KindStat & { kind: string; role: string | null })[];
  const rules = (await db.query(`select kind, role, mode from agent_kind_rules where club_id = any($1)`, [clubIds])).rows;
  const ruleOf = (kind: string, role: string | null) => rules.find((r) => r.kind === kind && r.role === role)?.mode ?? null;
  const known = new Set(kinds.map((k) => `${k.kind}|${k.role}`));
  for (const r of rules) if (!known.has(`${r.kind}|${r.role}`)) kinds.push({ ...EMPTY, kind: r.kind, role: r.role });
  // Вес — по тем же 30 дням, что использует помощник при отборе
  const w30 = (await db.query(`select kind, role, ${STAT_SQL} from agent_suggestions where club_id = any($1) and created_at > now() - interval '30 days' group by kind, role`, [clubIds])).rows;
  const items = kinds.map((k) => {
    const st = (w30.find((x) => x.kind === k.kind && x.role === k.role) as KindStat | undefined) ?? EMPTY;
    const l = weightFrom(st, ruleOf(k.kind, k.role));
    const ev = evaluated(k);
    return { kind: k.kind, name: kindName(k.kind), role: k.role, roleName: ROLE_NAME[k.role ?? ''] ?? '—', shown: k.shown, likes: k.likes, dislikes: k.dislikes,
      done: k.done, sales: k.sales, ignored: k.ignored, evaluated: ev, usefulPct: ev ? Math.round(usefulRate(k, 0) * 100) : null,
      weight: l.weight, status: l.status, mode: ruleOf(k.kind, k.role) ?? 'auto' };
  });
  const tot = kinds.reduce((a, k) => ({ shown: a.shown + k.shown, likes: a.likes + k.likes, dislikes: a.dislikes + k.dislikes, done: a.done + k.done, sales: a.sales + k.sales, ignored: a.ignored + k.ignored, doneAlready: a.doneAlready + k.doneAlready }), { ...EMPTY });
  const reasons = (await db.query(`select reason, count(*)::int as n from agent_suggestions where club_id = any($1) and rating = -1 and rated_at > now() - make_interval(days => $2)
    group by reason order by n desc`, [clubIds, days])).rows.map((r) => ({ reason: r.reason, name: REASON_NAME[r.reason as Reason] ?? 'Без причины', n: r.n }));
  const comments = (await db.query(`select s.rated_at as at, u.full_name as "user", s.kind, s.rating, s.reason, s.comment, left(s.body, 300) as body from agent_suggestions s
    join users u on u.id = s.user_id where s.club_id = any($1) and s.rated_at > now() - make_interval(days => $2) and (s.comment is not null or s.rating = -1)
    order by s.rated_at desc limit 15`, [clubIds, days])).rows.map((r) => ({ ...r, kindName: kindName(r.kind), reasonName: r.reason ? REASON_NAME[r.reason as Reason] : null }));
  const examples = (await db.query(`select s.question, left(s.body, 600) as body, s.rated_at as at, u.full_name as "user" from agent_suggestions s join users u on u.id = s.user_id
    where s.club_id = any($1) and s.rating = 1 and s.question is not null order by s.rated_at desc limit 5`, [clubIds])).rows;
  const lessons = lessonsOf(items);
  const ev = evaluated(tot);
  return { days, summary: { ...tot, evaluated: ev, usefulPct: ev ? Math.round(usefulRate(tot, 0) * 100) : null }, lessons, items, reasons, comments, examples };
}

type Item = { name: string; roleName: string; shown: number; likes: number; dislikes: number; done: number; sales: number; ignored: number; evaluated: number; status: string; mode: string };
/** Выводы простыми словами: что помощник стал показывать чаще, реже, что выключил */
export function lessonsOf(items: Item[]) {
  const out: string[] = [];
  const who = (i: Item) => (i.roleName === '—' ? '' : ` (${i.roleName.toLowerCase()})`);
  const facts = (i: Item) => [i.likes ? `«Полезно» — ${i.likes}` : '', i.done ? `сделали — ${i.done}` : '', i.sales ? `продажи — ${i.sales}` : '', i.dislikes ? `«Не то» — ${i.dislikes}` : '', i.ignored ? `проигнорировали — ${i.ignored}` : ''].filter(Boolean).join(', ');
  for (const i of items.filter((x) => x.status === 'up').slice(0, 4)) out.push(`Чаще показываю «${i.name}»${who(i)}: ${facts(i)}.`);
  for (const i of items.filter((x) => x.status === 'down').slice(0, 4)) out.push(`Реже показываю «${i.name}»${who(i)}: ${facts(i)}.`);
  for (const i of items.filter((x) => x.status === 'auto_off').slice(0, 4)) out.push(`Перестал показывать «${i.name}»${who(i)} — почти никому не помогало (${facts(i)}). Попробую снова через месяц.`);
  for (const i of items.filter((x) => x.status === 'off')) out.push(`«${i.name}»${who(i)} не показываю — так решил руководитель.`);
  for (const i of items.filter((x) => x.status === 'boost')) out.push(`«${i.name}»${who(i)} показываю чаще — так решил руководитель.`);
  if (!out.length) out.push('Пока данных мало: Дядя Витя показывает подсказки как раньше. Выводы появятся, когда сотрудники оценят подсказки или по ним что-то сделают (обычно через 3–7 дней работы).');
  return out;
}

/* ---------- маршруты ---------- */
export function agentLearnRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Сотрудник оценивает подсказку или ответ помощника
  app.post('/api/agent/suggestions/:id/rate', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { rating?: number; reason?: string; comment?: string };
    if (!uuid(id)) throw notFound('Подсказка не найдена');
    if (b.rating !== 1 && b.rating !== -1) throw badRequest('Оценка: «Полезно» или «Не то»');
    if (b.reason != null && !(b.reason in REASON_NAME)) throw badRequest('Неизвестная причина');
    return withCtx(pool, ctx, (db) => rateSuggestion(db, ctx, id, b.rating as 1 | -1, (b.reason as Reason) ?? null, b.comment ?? null));
  });

  // Оценка карточки в колокольчике (у карточки своя подсказка)
  app.post('/api/agent/notifications/:id/rate', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { rating?: number; reason?: string; comment?: string };
    if (!uuid(id)) throw notFound('Уведомление не найдено');
    if (b.rating !== 1 && b.rating !== -1) throw badRequest('Оценка: «Полезно» или «Не то»');
    if (b.reason != null && !(b.reason in REASON_NAME)) throw badRequest('Неизвестная причина');
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query(`select id from agent_suggestions where notification_id = $1 and user_id = $2`, [id, ctx.userId])).rows[0];
      if (!s) throw notFound('Эту карточку оценить нельзя');
      return rateSuggestion(db, ctx, s.id, b.rating as 1 | -1, (b.reason as Reason) ?? null, b.comment ?? null);
    });
  });

  // «Чему научился помощник»: руководителям; собственник — по любому клубу, управляющий — по своему
  app.get('/api/agent/learning', async (req) => {
    const ctx = requireCtx(req);
    if (!isLeader(ctx)) throw forbidden('Раздел доступен руководителям');
    const q = req.query as { clubId?: string; days?: string };
    const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
    return withCtx(pool, ctx, async (db) => {
      const clubs = q.clubId ? (await db.query('select id from clubs where id = $1', [q.clubId])).rows.map((r) => r.id as string)
        : (await db.query(`select id from clubs where not is_demo`)).rows.map((r) => r.id as string);
      if (!clubs.length) throw badRequest('Клуб не найден');
      const on = q.clubId ? await learningOn(db, q.clubId) : true;
      return { ...(await learningReport(db, clubs, days)), learning: on, canEdit: !!q.clubId && can(ctx, P.tariffsManage) };
    });
  });

  // Ручное решение по типу подсказки: auto / boost / off
  app.put('/api/agent/learning/rule', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.tariffsManage)) throw forbidden('Менять может собственник или управляющий');
    const b = (req.body ?? {}) as { clubId?: string; role?: string; kind?: string; mode?: string };
    if (!uuid(b.clubId) || !b.role || !(b.role in ROLE_NAME) || !b.kind || b.kind.length > 80) throw badRequest('Неверные данные');
    if (!['auto', 'boost', 'off'].includes(b.mode ?? '')) throw badRequest('Режим: авто, чаще или не показывать');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      if (b.mode === 'auto') await db.query(`delete from agent_kind_rules where club_id = $1 and role = $2 and kind = $3`, [b.clubId, b.role, b.kind]);
      else await db.query(`insert into agent_kind_rules(tenant_id, club_id, role, kind, mode, updated_by) values (app_tenant(), $1, $2, $3, $4, $5)
        on conflict (club_id, role, kind) do update set mode = $4, updated_by = $5, updated_at = now()`, [b.clubId, b.role, b.kind, b.mode, ctx.userId]);
      await audit(db, ctx, 'agent.learning_rule', 'club', b.clubId!, null, { role: b.role, kind: b.kind, mode: b.mode });
      return { ok: true };
    });
  });

  // Включить / выключить обучение в клубе
  app.put('/api/agent/learning/settings', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.tariffsManage)) throw forbidden('Менять может собственник или управляющий');
    const b = (req.body ?? {}) as { clubId?: string; learning?: boolean };
    if (!uuid(b.clubId) || typeof b.learning !== 'boolean') throw badRequest('Неверные данные');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      await db.query(`insert into agent_settings(club_id, tenant_id, learning, updated_by) values ($1, app_tenant(), $2, $3)
        on conflict (club_id) do update set learning = $2, updated_by = $3, updated_at = now()`, [b.clubId, b.learning, ctx.userId]);
      await audit(db, ctx, 'agent.learning', 'club', b.clubId!, null, { learning: b.learning });
      return { ok: true };
    });
  });
}
