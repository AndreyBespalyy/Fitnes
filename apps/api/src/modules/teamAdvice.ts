// ИИ-помощник читает переписку в мессенджере сотрудников (просьба Андрея 17.11.2026).
// Личные чаты, группы, общий чат клуба и чаты отделов разбираются пачками: раз в пару минут берутся чаты, где появились
// новые сообщения и уже 2 минуты тихо. Тему и суть определяет свой ИИ-сервер (Qwen на процессоре, не больше нескольких
// чатов за проход, чтобы не мешать звонкам), запасной вариант — YandexGPT, без ИИ — по ключевым словам.
// Советы собираются по роли каждого участника: что ему сделать и кнопка «Начать» — запустить бизнес-процесс
// (шаблоны агента: новый клиент, продление, возврат, жалоба, новый сотрудник), поставить задачу или назначить собрание через помощника.
// 152-ФЗ: совет и суть переписки видит только участник этого чата; телефоны и почта в ИИ не уходят; чат с ИИ-помощником не разбирается.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { aiChatTopic, type AiConfig } from '../lib/aiClient.ts';
import type { YandexConfig } from '../lib/yandex.ts';
import { noContacts } from './agent.ts';
import { BUILTIN, ensureBuiltins, ROLE_NAME, startProcess } from './agentProcesses.ts';
import { learnedWeight, recordSuggestion } from './agentLearn.ts';

export type TopicCode = 'new_client' | 'renewal' | 'return' | 'complaint' | 'new_staff' | 'meeting' | 'equipment' | 'schedule' | 'payment' | 'cleaning' | 'task' | 'other';
export type Action =
  | { type: 'process'; code: string; label: string }
  | { type: 'task'; title: string; hours: number; assignee: 'self' | 'gm' | 'desk' | 'fin'; tab: string; label: string }
  | { type: 'assistant'; prompt: string; label: string };

/* ---------- темы и ключевые слова (без ИИ и для проверки ответа модели) ---------- */
export const TOPICS: Record<Exclude<TopicCode, 'other'>, { name: string; re: RegExp }> = {
  complaint: { name: 'Жалоба клиента', re: /(жалоб|жалует|недоволен|недовольн|претензи|возмущ|нахамил|грубо|скандал|ругает|ругался|плохой отзыв|негативн\S* отзыв)/g },
  equipment: { name: 'Поломка и ремонт', re: /(сломал|слома[нл]|поломк|не работает|не включается|ремонт|почин|протека|теч[её]т|кондиционер|беговая|дорожк[аеуи]|тренаж[её]р|сантехник|лампа|свет не)/g },
  renewal: { name: 'Продление абонемента', re: /(продлени|продлит|продлева|заканчивается абонемент|абонемент заканчива|истекает|абонемент закончи|срок абонемента)/g },
  return: { name: 'Возврат клиента', re: /(перестал\S* ходить|давно не (ходит|приходит|был)|не ходит|ушедш|вернуть клиент|бывш\S* клиент|пропал\S* клиент)/g },
  new_client: { name: 'Новый клиент', re: /(заявк|\bлид|пробн\S* (трениров|заняти|визит)|экскурси|новый клиент|новая клиентка|гостев|хочет купить|интересуется абонемент|первое заняти|первая трениров|записал\S* на (пробн|экскурс))/g },
  new_staff: { name: 'Новый сотрудник', re: /(новый сотрудник|новая сотрудниц|новенький|новенькая|стаж[её]р|стажир|выходит на работу|выйдет на работу|собеседовани|приняли на работу|оформить сотрудник)/g },
  meeting: { name: 'Собрание', re: /(собрани|планерк|планёрк|совещани|летучк|пятиминутк|собраться всем|собрать всех)/g },
  schedule: { name: 'Расписание и замены', re: /(расписани|замен[аиуы]|подмени|заболел|не выйд|не сможет вести|перенест\S* (заняти|трениров|групп)|отмен\S* (заняти|трениров|групп)|смен[аыу]\b)/g },
  payment: { name: 'Оплата и касса', re: /(оплат|касс[аеуы]|\bчек|возврат денег|вернуть деньги|рассрочк|задолженн|\bдолг|списани|\bсч[её]т\b|предоплат)/g },
  cleaning: { name: 'Чистота и порядок', re: /(уборк|убрать|грязн|мусор|чистот|полотенц|раздевалк\S* грязн|протереть|помыть)/g },
  task: { name: 'Поручение', re: /(сделай|сделайте|нужно сделать|надо сделать|не забудь|поручени|до завтра|к завтра|до конца дня|срочно|проконтролируй)/g },
};
export const topicName = (t: string) => (t in TOPICS ? TOPICS[t as keyof typeof TOPICS].name : 'Без рабочей темы');
// При равенстве счёта важнее то, что раньше в списке (жалоба важнее «поручения»)
const ORDER = Object.keys(TOPICS) as (keyof typeof TOPICS)[];
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Тема по ключевым словам: больше совпадений в последних сообщениях — та и тема. Свежие сообщения весят больше. */
export function rulesTopic(msgs: { text: string }[]): { topic: TopicCode; summary: string } {
  const recent = msgs.slice(-20);
  const score = new Map<string, number>();
  const hits = recent.map((m, i) => {
    const t = norm(m.text); const w = i >= recent.length - 5 ? 2 : 1; const h = new Map<string, number>();
    for (const k of ORDER) {
      const n = (t.match(TOPICS[k].re) ?? []).length;
      if (n) { h.set(k, n); score.set(k, (score.get(k) ?? 0) + n * w * (k === 'task' ? 0.5 : 1)); }
    }
    return h;
  });
  let topic: TopicCode = 'other'; let max = 0;
  for (const k of ORDER) { const s = score.get(k) ?? 0; if (s > max) { max = s; topic = k; } }
  if (topic === 'other') return { topic, summary: '' };
  // Суть — сообщение, где о теме сказано больше всего (из равных — первое: обычно там и описана ситуация)
  let bi = 0; let bn = 0;
  hits.forEach((h, i) => { const n = h.get(topic) ?? 0; if (n > bn) { bn = n; bi = i; } });
  // Без обращения и приветствия в начале: «Олег, добрый день! Клиент жалуется…» → «Клиент жалуется…»
  let summary = noContacts(recent[bi]?.text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^([А-ЯЁ][а-яё]+,\s*)?((добр\S+\s+(день|утро|вечер)|привет|здравствуйте|коллеги)[!,.]?\s*)+/i, '').replace(/^[А-ЯЁ][а-яё]+,\s+/, '');
  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  return { topic, summary: summary.length > 140 ? `${summary.slice(0, 139)}…` : summary };
}

/* ---------- советы по роли ---------- */
const proc = (code: string) => { const b = BUILTIN.find((x) => x.code === code)!; return { type: 'process' as const, code, label: `Процесс «${b.name.split(':')[0]}»` }; };
const task = (title: string, hours: number, tab: string, assignee: 'self' | 'gm' | 'desk' | 'fin' = 'self') =>
  ({ type: 'task' as const, title: title.slice(0, 250), hours, assignee, tab, label: assignee === 'self' ? 'Задача себе' : assignee === 'gm' ? 'Задача управляющему' : assignee === 'desk' ? 'Задача администратору' : 'Задача финансисту' });
const myTab = (role: string) => (role === 'trainer' ? 'trainer' : role === 'desk' ? 'desk' : 'tasks');
const about = (s: string) => (s ? `: ${s.replace(/[.…]+$/, '')}` : '');

/** Один-два совета участнику по теме переписки и его роли. Пусто — по этой теме роли делать нечего. */
export function adviceFor(topic: TopicCode, role: string, summary: string, chatTitle: string, people: string[]): { body: string; action: Action }[] {
  const sales = role === 'manager' || role === 'rop';
  const head = role === 'gm';
  const owner = role === 'owner' || role === 'admin';
  const tab = myTab(role);
  const s = summary;
  switch (topic) {
    case 'complaint':
      if (owner) return [{ body: 'В переписке жалоба клиента. Поручите управляющему разобраться и ответить клиенту за сутки.', action: task(`Разобрать жалобу клиента и ответить ему${about(s)}`, 24, 'tasks', 'gm') }];
      if (role === 'trainer' || role === 'fin') return [{ body: 'Клиент недоволен. Передайте жалобу администратору — он запишет суть и запустит разбор.', action: task(`Принять жалобу клиента${about(s)}`, 1, 'desk', 'desk') }];
      return [{ body: 'Клиент недоволен. Запустите процесс «Жалоба клиента»: суть запишут за час, управляющий разберётся за сутки, через неделю проверим.', action: proc('complaint') }];
    case 'new_client':
      if (sales || head) return [{ body: 'Речь о новом клиенте. Запустите процесс «Новый клиент»: звонок за 15 минут, визит, вводная тренировка, звонок через неделю.', action: proc('new_client') }];
      if (role === 'trainer') return [{ body: 'Придёт новый клиент. Подготовьте вводную тренировку и программу на первый месяц.', action: task(`Подготовить вводную тренировку${about(s)}`, 24, tab) }];
      if (role === 'desk') return [{ body: 'Новый клиент. Запишите его на экскурсию или пробную и передайте менеджеру.', action: proc('new_client') }];
      return [];
    case 'renewal':
      if (sales || head) return [{ body: 'У клиента заканчивается абонемент. Запустите процесс «Продление»: звонок, персональное предложение, оплата.', action: proc('renewal') }];
      if (role === 'trainer' || role === 'desk') return [{ body: 'Клиенту пора продлевать. Напомните ему при встрече и предупредите менеджера.', action: task(`Напомнить клиенту о продлении${about(s)}`, 24, tab) }];
      return [];
    case 'return':
      if (sales || head) return [{ body: 'Клиент перестал ходить. Запустите процесс «Возврат клиента»: узнать причину и пригласить с понятным предложением.', action: proc('return') }];
      if (role === 'trainer') return [{ body: 'Ваш клиент пропал. Напишите или позвоните ему, пригласите на тренировку.', action: task(`Связаться с клиентом и пригласить на тренировку${about(s)}`, 48, tab) }];
      return [];
    case 'new_staff':
      if (head || owner || role === 'rop') return [{ body: 'В клубе новый сотрудник. Запустите процесс «Приём нового сотрудника»: документы, доступы, обучение, наставник.', action: proc('new_staff') }];
      return [{ body: 'Новый коллега. Помогите ему освоиться: покажите CRM и ваши стандарты работы.', action: task(`Помочь новому сотруднику освоиться${about(s)}`, 72, tab) }];
    case 'meeting': {
      const who = people.slice(0, 8).join(', ');
      return [{ body: 'Договариваетесь собраться. Помощник подберёт время по расписанию каждого и разошлёт приглашения.',
        action: { type: 'assistant', prompt: `Назначь собрание${who ? `: ${who}` : ''}, на этой неделе с 10 до 18, 30 минут${chatTitle ? `. Тема: ${chatTitle}` : ''}`.slice(0, 400), label: 'Назначить собрание' } }];
    }
    case 'equipment':
      if (head) return [{ body: 'Что-то сломалось. Поставьте себе задачу организовать ремонт за сутки и повесьте табличку «Не работает».', action: task(`Организовать ремонт${about(s)}`, 24, 'tasks') }];
      if (owner) return [{ body: 'В клубе поломка. Поручите управляющему ремонт со сроком — сутки.', action: task(`Организовать ремонт${about(s)}`, 24, 'tasks', 'gm') }];
      return [{ body: 'Поломка в клубе. Сообщите управляющему задачей — у неё будет срок, и она не потеряется.', action: task(`Организовать ремонт${about(s)}`, 24, 'tasks', 'gm') }];
    case 'schedule':
      if (role === 'trainer') return [{ body: 'Меняется расписание. Договоритесь о замене и предупредите своих клиентов.', action: task(`Договориться о замене и предупредить клиентов${about(s)}`, 4, tab) }];
      if (head || role === 'desk') return [{ body: 'Нужна замена или перенос. Найдите замену и поправьте расписание, чтобы клиенты получили уведомление.', action: task(`Найти замену и поправить расписание${about(s)}`, 4, role === 'desk' ? 'schedule' : 'schedule') }];
      if (owner) return [];
      return [{ body: 'Меняется расписание. Предупредите клиентов, которые записаны на это занятие.', action: task(`Предупредить клиентов об изменении расписания${about(s)}`, 4, tab) }];
    case 'payment':
      if (role === 'fin') return [{ body: 'Вопрос по деньгам. Проверьте оплату или возврат и ответьте в чате.', action: task(`Проверить оплату${about(s)}`, 24, 'finance') }];
      if (owner) return [];
      if (head) return [{ body: 'Вопрос по оплате. Поручите финансисту проверить и закрыть вопрос за сутки.', action: task(`Проверить оплату${about(s)}`, 24, 'finance', 'fin') }];
      return [{ body: 'Вопрос по оплате клиента. Проверьте платёж в кассе, если нужно — подключите финансиста.', action: task(`Проверить оплату клиента${about(s)}`, 4, tab) }];
    case 'cleaning':
      if (role === 'desk' || head) return [{ body: 'Нужна уборка. Поставьте задачу со сроком 2 часа и проверьте результат.', action: task(`Организовать уборку${about(s)}`, 2, tab) }];
      if (owner) return [];
      return [{ body: 'Нужна уборка. Передайте администратору задачей, чтобы не забылось.', action: task(`Организовать уборку${about(s)}`, 2, 'desk', 'desk') }];
    case 'task':
      return [{ body: 'В переписке поручение. Поставьте задачу со сроком, чтобы она не потерялась в чате.', action: task(`Выполнить${about(s) || ': поручение из чата'}`, 24, tab) }];
    default:
      return [];
  }
}

/* ---------- разбор одного чата ---------- */
type Msg = { author: string; text: string; userId: string; at: Date };
async function lastMessages(db: Db, chatId: string) {
  return (await db.query(`select * from (select x.user_id as "userId", u.full_name as author, x.body as text, x.created_at as at from team_messages x join users u on u.id = x.user_id
    where x.chat_id = $1 and x.deleted_at is null and x.body <> '' and not u.is_bot order by x.created_at desc limit 40) t order by at`, [chatId])).rows as Msg[];
}

/** Клиент, о котором переписка: имя и фамилия в любом падеже («у Алексея Громова»). Ровно одно совпадение — иначе без клиента. */
async function findPerson(db: Db, clubIds: string[], name: string, text: string) {
  const hay = norm(`${name} ${text}`);
  const rows = (await db.query(`with p as (select id, lower(replace(split_part(full_name, ' ', 1), 'ё', 'е')) as w1, lower(replace(split_part(full_name, ' ', 2), 'ё', 'е')) as w2
      from persons where merged_into_id is null and ($1::uuid[] is null or home_club_id = any($1)) and full_name ~ '^[А-Яа-яЁё-]{2,} [А-Яа-яЁё-]{2,}')
    , s as (select id, left(w1, greatest(length(w1) - 1, 2)) || '[а-я]{0,3}' as a, left(w2, greatest(length(w2) - 1, 2)) || '[а-я]{0,3}' as b from p)
    select id from s where $2 ~ ('(^|[^а-я])' || a || '\\s+' || b || '([^а-я]|$)') or $2 ~ ('(^|[^а-я])' || b || '\\s+' || a || '([^а-я]|$)') limit 2`,
  [clubIds.length ? clubIds : null, hay])).rows;
  return rows.length === 1 ? rows[0].id as string : null;
}

type Analyzer = { ai: AiConfig | null; yandex: YandexConfig | null };
/** Разбирает чат: тема, суть, советы участникам. useAi=false — только по ключевым словам (лимит ИИ на проход исчерпан). */
export async function analyzeChat(db: Db, tenantId: string, chatId: string, an: Analyzer, useAi = true) {
  const chat = (await db.query(`select c.id, c.kind, c.title, c.club_id, c.last_message_at from team_chats c where c.id = $1 and c.archived_at is null`, [chatId])).rows[0];
  if (!chat) return null;
  if ((await db.query(`select 1 from team_members m join users u on u.id = m.user_id where m.chat_id = $1 and u.is_bot`, [chatId])).rowCount) return null; // чат с ИИ-помощником
  const msgs = await lastMessages(db, chatId);
  const upto = chat.last_message_at ?? new Date();
  const prev = (await db.query(`select topic, upto from team_chat_insights where chat_id = $1`, [chatId])).rows[0];
  const fresh = msgs.filter((m) => !prev || m.at > prev.upto);
  if (!fresh.length && prev) { await db.query(`update team_chat_insights set upto = $2, requested_at = null where chat_id = $1`, [chatId, upto]); return null; }

  const clean = msgs.map((m) => ({ author: m.author, text: noContacts(m.text).slice(0, 600) }));
  let topic: TopicCode = 'other'; let summary = ''; let client = ''; let engine = 'rules';
  const words = clean.slice(-10).reduce((n, m) => n + m.text.split(/\s+/).length, 0);
  const llm = an.ai ?? (an.yandex ? { url: '', fetch, yandex: an.yandex } as AiConfig : null);
  if (useAi && llm && words >= 6) {
    try {
      const r = await aiChatTopic(llm, clean);
      if (r.topic === 'other' || r.topic in TOPICS) { topic = r.topic as TopicCode; summary = noContacts(r.summary).slice(0, 200); client = r.client; engine = r.engine ?? 'ai'; }
    } catch (e) { console.error('Советы по переписке, ИИ:', (e as Error).message.slice(0, 200)); }
  }
  if (engine === 'rules') ({ topic, summary } = rulesTopic(clean));

  const members = (await db.query(`select m.user_id, u.full_name from team_members m join users u on u.id = m.user_id and u.status = 'active' and not u.is_bot where m.chat_id = $1`, [chatId])).rows as { user_id: string; full_name: string }[];
  const asg = (await db.query(`select a.user_id, a.role_code, a.club_id from user_assignments a where a.user_id = any($1::uuid[])
    and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`, [members.map((m) => m.user_id)])).rows as { user_id: string; role_code: string; club_id: string | null }[];
  const clubIds = chat.club_id ? [chat.club_id] : [...new Set(asg.map((a) => a.club_id).filter((x): x is string => !!x))];
  const personId = topic === 'other' ? null : await findPerson(db, clubIds, client, clean.slice(-10).map((m) => m.text).join(' '));

  await db.query(`insert into team_chat_insights(chat_id, tenant_id, topic, summary, person_id, engine, upto) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (chat_id) do update set topic = excluded.topic, summary = excluded.summary, person_id = excluded.person_id, engine = excluded.engine, upto = excluded.upto, requested_at = null, analyzed_at = now()`,
  [chatId, tenantId, topic, summary || null, personId, engine, upto]);
  // Тема сменилась — старые невыполненные советы больше не к месту
  await db.query(`update team_advice set status = 'expired' where chat_id = $1 and status = 'new' and topic <> $2`, [chatId, topic]);
  if (topic === 'other') return { topic, summary, engine, created: 0 };

  // Кто пишет в чате — по ролям; руководитель с несколькими ролями получает совет по старшей
  const RANK = ['gm', 'owner', 'rop', 'manager', 'desk', 'fin', 'trainer', 'admin'];
  let created = 0;
  for (const m of members) {
    const mine = asg.filter((a) => a.user_id === m.user_id && (!chat.club_id || a.club_id === chat.club_id || a.club_id === null));
    const role = RANK.find((r) => mine.some((a) => a.role_code === r)); if (!role) continue;
    const clubId = chat.club_id ?? mine.find((a) => a.club_id)?.club_id ?? clubIds[0] ?? null;
    if (!clubId) continue;
    const people = members.filter((x) => x.user_id !== m.user_id).map((x) => x.full_name);
    for (const a of adviceFor(topic, role, summary, chat.kind === 'direct' ? '' : chat.title ?? '', people)) {
      // Тот же совет уже есть (не выполнен или сделан за последние 3 дня) — не повторяем
      const dup = (await db.query(`select 1 from team_advice where chat_id = $1 and user_id = $2 and topic = $3 and (status = 'new' or acted_at > now() - interval '3 days')`, [chatId, m.user_id, topic])).rowCount;
      if (dup) continue;
      // Обучение на отзывах: тип совета, который в клубе отключили или который сам выключился (одни «Не то»), не показываем
      const kind = `msg_${topic}`;
      if (await learnedWeight(db, clubId, role, kind, m.user_id) <= 0) continue;
      const sid = await recordSuggestion(db, { clubId, userId: m.user_id, role, source: 'advice', kind, body: a.body, targets: personId ? { personIds: [personId] } : {} });
      await db.query(`insert into team_advice(tenant_id, chat_id, user_id, club_id, topic, body, action, suggestion_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, chatId, m.user_id, clubId, topic, a.body.slice(0, 400), JSON.stringify(a.action), sid]);
      created++;
    }
  }
  return { topic, summary, engine, created };
}

/* ---------- фоновый разбор пачками ---------- */
export const ADVICE = { quietMs: 2 * 60_000, aiPerRun: 3, chatsPerRun: 20 };
export async function processTeamAdvice(pool: pg.Pool, an: Analyzer) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  let done = 0; let aiLeft = ADVICE.aiPerRun;
  for (const tenantId of tenants) {
    await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, async (db) => {
      const due = (await db.query(`select c.id from team_chats c left join team_chat_insights i on i.chat_id = c.id
        where c.archived_at is null and c.last_message_at > now() - interval '7 days' and (i.upto is null or c.last_message_at > i.upto or i.requested_at is not null)
          and (c.last_message_at < now() - make_interval(secs => $1) or i.requested_at is not null)
          and not exists (select 1 from team_members m join users u on u.id = m.user_id where m.chat_id = c.id and u.is_bot)
        order by i.requested_at is null, c.last_message_at limit $2`, [ADVICE.quietMs / 1000, ADVICE.chatsPerRun])).rows;
      for (const c of due) {
        const r = await analyzeChat(db, tenantId, c.id, an, aiLeft > 0).catch((e) => { console.error('Советы по переписке:', (e as Error).message); return null; });
        if (r && r.engine !== 'rules') aiLeft--;
        done++;
      }
    }).catch((e) => console.error('Советы по переписке:', (e as Error).message));
  }
  return done;
}

export function startTeamAdviceWorker(pool: pg.Pool, an: Analyzer, everyMs = 60_000) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { await processTeamAdvice(pool, an); } catch (e) { console.error('Советы по переписке:', (e as Error).message); } finally { busy = false; }
  };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

/* ---------- «Начать» ---------- */
async function userOfRole(db: Db, clubId: string, role: string) {
  return (await db.query(`select u.id from users u join user_assignments a on a.user_id = u.id where a.club_id = $1 and a.role_code = $2 and u.status = 'active' and not u.is_bot
    and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)
    order by (select count(*) from tasks t where t.assignee_id = u.id and t.done_at is null), u.full_name limit 1`, [clubId, role])).rows[0]?.id as string | undefined;
}

export async function startAdvice(db: Db, ctx: Ctx, id: string) {
  const a = (await db.query(`select a.*, i.person_id, c.title as chat_title from team_advice a join team_members m on m.chat_id = a.chat_id and m.user_id = a.user_id
    join team_chats c on c.id = a.chat_id left join team_chat_insights i on i.chat_id = a.chat_id where a.id = $1 and a.user_id = $2`, [id, ctx.userId])).rows[0];
  if (!a) throw notFound('Совет не найден');
  if (a.status === 'started') return a.result as Record<string, unknown>;
  if (a.status !== 'new') throw badRequest('Этот совет уже не актуален');
  const act = a.action as Action;
  let result: Record<string, unknown>;
  if (act.type === 'process') {
    await ensureBuiltins(db, ctx.tenantId);
    const tpl = (await db.query(`select id, name from process_templates where builtin = $1 and is_active`, [act.code])).rows[0];
    if (!tpl) throw notFound('Шаблон процесса выключен. Включите его в «Бизнес-процессах»');
    const pid = await startProcess(db, ctx, { clubId: a.club_id, templateId: tpl.id, personId: a.person_id ?? null, note: `Запущен из переписки${a.chat_title ? ` «${a.chat_title}»` : ''} по совету ИИ-помощника` });
    result = { kind: 'process', id: pid, tab: 'processes', label: `Запущен процесс «${tpl.name}»` };
  } else if (act.type === 'task') {
    const byRole = act.assignee === 'self' ? null : await userOfRole(db, a.club_id, act.assignee);
    const to = act.assignee === 'self' ? ctx.userId : byRole ?? ctx.userId;
    // В клубе нет сотрудника нужной роли — задача остаётся у нажавшего, и мы прямо об этом говорим (проверка CRM, п. 14)
    const noRole = act.assignee !== 'self' && !byRole ? `В клубе нет сотрудника с ролью «${ROLE_NAME[act.assignee] ?? act.assignee}» — ` : '';
    const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,'other',$5, now() + make_interval(mins => $6), $7) returning id`,
      [ctx.tenantId, a.club_id, to, a.person_id ?? null, act.title.slice(0, 300), Math.round(act.hours * 60), ctx.userId])).rows[0].id;
    const whom = to === ctx.userId ? 'вам' : ((await db.query(`select full_name from users where id = $1`, [to])).rows[0]?.full_name ?? 'сотруднику');
    result = { kind: 'task', id: tid, tab: to === ctx.userId ? act.tab : 'tasks', label: `${noRole}${noRole ? 'задача' : 'Задача'} поставлена ${to === ctx.userId ? 'вам' : `— ${whom}`}` };
  } else {
    result = { kind: 'assistant', prompt: act.prompt, label: 'Открыт ИИ-помощник — проверьте текст и отправьте' };
  }
  await db.query(`update team_advice set status = 'started', result = $2, acted_at = now() where id = $1`, [id, JSON.stringify(result)]);
  if (a.suggestion_id) await db.query(`update agent_suggestions set outcome = 'done', outcome_note = 'нажали «Начать» в мессенджере', outcome_at = now() where id = $1 and outcome is null`, [a.suggestion_id]);
  await audit(db, ctx, 'team.advice_started', 'team_chat', a.chat_id, null, { topic: a.topic, action: act.type });
  return result;
}

/* ---------- API ---------- */
async function adviceView(db: Db, ctx: Ctx, chatId: string) {
  const m = (await db.query(`select 1 from team_members m join team_chats c on c.id = m.chat_id and c.archived_at is null where m.chat_id = $1 and m.user_id = $2`, [chatId, ctx.userId])).rowCount;
  if (!m) throw notFound('Чат не найден');
  const i = (await db.query(`select topic, summary, engine, analyzed_at, requested_at from team_chat_insights where chat_id = $1`, [chatId])).rows[0];
  const items = (await db.query(`select id, body, action, status, result, created_at as "createdAt" from team_advice
    where chat_id = $1 and user_id = $2 and (status = 'new' or (status = 'started' and acted_at > now() - interval '1 day')) order by created_at`, [chatId, ctx.userId])).rows
    .map((r) => ({ id: r.id, body: r.body, status: r.status, result: r.result, createdAt: r.createdAt, actionType: r.action.type, actionLabel: r.action.label }));
  return {
    topic: i?.topic ?? null, topicName: i ? topicName(i.topic) : null, summary: i?.summary ?? null, engine: i?.engine ?? null,
    analyzedAt: i?.analyzed_at ?? null, pending: !!i?.requested_at, items,
  };
}

export function teamAdviceRoutes(app: FastifyInstance, pool: pg.Pool, an: Analyzer) {
  app.get('/api/team/chats/:id/advice', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => adviceView(db, ctx, id));
  });

  // «Разобрать сейчас»: по ключевым словам — сразу, через ИИ — в ближайший проход фоновой задачи (не дольше минуты)
  app.post('/api/team/chats/:id/advice/refresh', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await adviceView(db, ctx, id);
      const last = (await db.query(`select analyzed_at from team_chat_insights where chat_id = $1`, [id])).rows[0]?.analyzed_at as Date | undefined;
      if (!last || Date.now() - new Date(last).getTime() > 30_000) {
        await analyzeChat(db, ctx.tenantId, id, an, false);
        if (an.ai || an.yandex) await db.query(`update team_chat_insights set requested_at = now() where chat_id = $1`, [id]);
      }
      return adviceView(db, ctx, id);
    });
  });

  app.post('/api/team/advice/:id/start', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => startAdvice(db, ctx, id));
  });

  app.post('/api/team/advice/:id/dismiss', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query(`update team_advice set status = 'dismissed', acted_at = now() where id = $1 and user_id = $2 and status = 'new' returning suggestion_id`, [id, ctx.userId]);
      if (!r.rowCount) throw notFound('Совет не найден');
      // «Скрыть» — это «Не то»: помощник реже предлагает такие советы этой роли в клубе
      const sid = r.rows[0].suggestion_id;
      if (sid) await db.query(`update agent_suggestions set rating = -1, reason = 'not_relevant', rated_at = now() where id = $1 and rating is null`, [sid]);
      return { ok: true };
    });
  });
}
