// ИИ-агент, этап 3 (выбор Андрея 14.11.2026, 3В): с «ИИ-помощником» можно переписываться в корпоративном мессенджере.
// Понимает простые просьбы словами: «мои задачи», «что просрочено», «перенеси Анну на завтра», «перенеси 2 через час»,
// «коротко про Анну», «поставь задачу позвонить поставщику завтра в 12», «сводка» (для руководителя).
// Если подключён YandexGPT — понимает и свободные формулировки. Делает только безопасное внутри CRM (2Б): клиентам не пишет.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { ygptJson, type YandexConfig } from '../lib/yandex.ts';
import { fmtDate, situationBrief } from './agent.ts';
import { MEETING_RE, MEETING_STATUS_RE, meetingPendingReply, meetingStatus, proposeMeeting } from './agentMeetings.ts';
import { OWNER_HELP, isLeader, ownerAnswer, ownerPendingReply } from './agentOwner.ts';

export const BOT_NAME = 'ИИ-помощник';

export async function ensureBot(db: Db, tenantId: string) {
  const cur = (await db.query(`select id from users where tenant_id = $1 and is_bot`, [tenantId])).rows[0];
  if (cur) return cur.id as string;
  // Войти под помощником нельзя: заблокирован и без пароля (в поле — случайная строка, а не хеш)
  await db.query(`insert into users(tenant_id, login, password_hash, full_name, status, must_change_password, is_bot)
    values ($1, $2, $3, $4, 'blocked', false, true) on conflict do nothing`, [tenantId, `ai-helper-${tenantId.slice(0, 8)}`, `bot:${randomBytes(24).toString('hex')}`, BOT_NAME]);
  return (await db.query(`select id from users where tenant_id = $1 and is_bot`, [tenantId])).rows[0].id as string;
}

const WELCOME = `Здравствуйте! Я ИИ-помощник. Пишите мне простыми словами:
• «мои задачи» — что у вас на сегодня;
• «что просрочено»;
• «перенеси 2 на завтра» или «перенеси Анну через час»;
• «коротко про 1» или «коротко про Анну» — суть ситуации по клиенту;
• «поставь задачу позвонить поставщику завтра в 12»;
• «сводка» — для руководителя: что горит в клубе.`;

export async function ensureBotChat(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>) {
  const bot = await ensureBot(db, ctx.tenantId);
  const key = [ctx.userId, bot].sort().join(':');
  const ins = await db.query(`insert into team_chats(tenant_id, kind, direct_key, created_by) values ($1,'direct',$2,$3)
    on conflict (tenant_id, direct_key) where direct_key is not null do nothing returning id`, [ctx.tenantId, key, ctx.userId]);
  const id = (await db.query('select id from team_chats where tenant_id = $1 and direct_key = $2', [ctx.tenantId, key])).rows[0].id as string;
  for (const u of [ctx.userId, bot]) await db.query('insert into team_members(chat_id, user_id, tenant_id) values ($1,$2,$3) on conflict do nothing', [id, u, ctx.tenantId]);
  if (ins.rowCount) await say(db, ctx.tenantId, id, bot, WELCOME);
  return { id, bot };
}

async function say(db: Db, tenantId: string, chatId: string, bot: string, text: string) {
  await db.query(`insert into team_messages(tenant_id, chat_id, user_id, body) values ($1,$2,$3,$4)`, [tenantId, chatId, bot, text.slice(0, 4000)]);
  await db.query('update team_chats set last_message_at = now() where id = $1', [chatId]);
  await db.query('update team_members set last_read_at = now() where chat_id = $1 and user_id = $2', [chatId, bot]);
}

/** Чат сотрудника с помощником? Тогда возвращает id помощника */
export async function botPeer(db: Db, chatId: string, userId: string) {
  return (await db.query(`select u.id from team_chats c join team_members m on m.chat_id = c.id join users u on u.id = m.user_id
    where c.id = $1 and c.kind = 'direct' and u.is_bot and exists (select 1 from team_members x where x.chat_id = c.id and x.user_id = $2)`, [chatId, userId])).rows[0]?.id as string | undefined;
}

/* ---------- задачи сотрудника ---------- */
type T = { id: string; title: string; due_at: string; person: string | null; overdue: boolean; club_id: string; timezone: string };
async function myTasks(db: Db, userId: string, onlyOverdue = false): Promise<T[]> {
  return (await db.query(`select t.id, t.title, t.due_at, p.full_name as person, t.due_at < now() as overdue, t.club_id, c.timezone
    from tasks t join clubs c on c.id = t.club_id left join persons p on p.id = t.person_id
    where t.assignee_id = $1 and t.done_at is null and ($2 = false or t.due_at < now()) and t.due_at < now() + interval '2 days'
    order by t.due_at limit 15`, [userId, onlyOverdue])).rows;
}

async function remember(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, ids: string[]) {
  await db.query(`insert into agent_chat_state(user_id, tenant_id, task_ids) values ($1,$2,$3) on conflict (user_id) do update set task_ids = $3, updated_at = now()`, [ctx.userId, ctx.tenantId, ids]);
}

function listText(ts: T[], head: string) {
  if (!ts.length) return `${head}: ничего нет 👍`;
  return `${head}:\n${ts.map((t, i) => `${i + 1}. ${t.overdue ? '⚠️ ' : ''}${t.title}${t.person ? ` — ${t.person}` : ''} (до ${fmtDate(t.due_at, t.timezone)})`).join('\n')}\n\nНапишите, например: «перенеси 1 на завтра» или «коротко про 1».`;
}

/** Задача по номеру из последнего списка или по имени клиента («Анну», «Петрова») */
async function findTask(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, ref: string): Promise<T | null | 'many'> {
  const n = ref.match(/^\s*(\d{1,2})\b/);
  if (n) {
    const st = (await db.query(`select task_ids from agent_chat_state where user_id = $1`, [ctx.userId])).rows[0];
    const id = st?.task_ids?.[Number(n[1]) - 1];
    if (!id) return null;
    return (await db.query(`select t.id, t.title, t.due_at, p.full_name as person, t.due_at < now() as overdue, t.club_id, c.timezone
      from tasks t join clubs c on c.id = t.club_id left join persons p on p.id = t.person_id where t.id = $1 and t.assignee_id = $2 and t.done_at is null`, [id, ctx.userId])).rows[0] ?? null;
  }
  // Основа слова: «Анну» → «Ан», «Петрова» → «Петро» — чтобы находить имя в любом падеже
  const stems = ref.toLowerCase().split(/[^а-яёa-z]+/i).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, Math.max(2, Math.min(w.length - 2, 6))));
  if (!stems.length) return null;
  const rows = (await db.query(`select t.id, t.title, t.due_at, p.full_name as person, t.due_at < now() as overdue, t.club_id, c.timezone
    from tasks t join clubs c on c.id = t.club_id join persons p on p.id = t.person_id
    where t.assignee_id = $1 and t.done_at is null and exists (select 1 from unnest($2::text[]) s, regexp_split_to_table(lower(p.full_name), '\\s+') w where w like s || '%')
    order by t.due_at`, [ctx.userId, stems])).rows as T[];
  if (rows.length > 1 && new Set(rows.map((r) => r.person)).size > 1) return 'many';
  return rows[0] ?? null;
}
const STOP = new Set(['перенеси', 'перенести', 'коротко', 'про', 'задачу', 'задача', 'клиента', 'клиент', 'завтра', 'через', 'час', 'часа', 'часов', 'минут', 'послезавтра', 'что', 'как', 'там', 'утро', 'утром', 'вечером']);

/** «завтра», «послезавтра», «через час», «через 3 часа», «через 30 минут», «в 15:00», «завтра в 12» → время (в поясе клуба) */
export function parseWhen(text: string, tz: string, now = new Date()): Date | null {
  const t = text.toLowerCase();
  const rel = t.match(/через\s+(\d+)?\s*(час|часа|часов|ч\b|минут|мин)/);
  if (rel) { const k = Number(rel[1] ?? 1); return new Date(now.getTime() + k * (rel[2].startsWith('м') ? 60_000 : 3_600_000)); }
  const day = /послезавтра/.test(t) ? 2 : /завтра/.test(t) ? 1 : /сегодня/.test(t) ? 0 : null;
  const hm = t.match(/(?:^|\s)(?:в|на)\s*(\d{1,2})(?:[:.](\d{2}))?(?!\d)(?!\s*(?:минут|мин|час|дн))/);
  if (day === null && !hm) return null;
  // Местная дата клуба
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const h = hm ? Number(hm[1]) : 10;
  const m = hm?.[2] ? Number(hm[2]) : 0;
  if (h > 23 || m > 59) return null;
  let add = day ?? 0;
  if (day === null && (h < Number(parts.hour) || (h === Number(parts.hour) && m <= Number(parts.minute)))) add = 1; // «в 9» вечером — значит завтра
  // Смещение пояса клуба относительно UTC в этот момент
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offset = asUtc - Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + add, h, m) - offset);
}

async function snooze(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, t: T, at: Date) {
  await db.query('update tasks set due_at = $2 where id = $1', [t.id, at]);
  await audit(db, { tenantId: ctx.tenantId, userId: ctx.userId }, 'agent.task_snoozed', 'task', t.id, { dueAt: t.due_at }, { dueAt: at, via: 'chat' });
  return `Готово: «${t.title}»${t.person ? ` — ${t.person}` : ''} перенесена на ${fmtDate(at, t.timezone)}.`;
}

async function clubOf(db: Db, userId: string) {
  return (await db.query(`select c.id, c.timezone from user_assignments a join clubs c on c.id = a.club_id where a.user_id = $1 and a.club_id is not null
    and (a.active_to is null or a.active_to >= current_date) order by a.active_from limit 1`, [userId])).rows[0] as { id: string; timezone: string } | undefined;
}

/** Сводка для руководителя: просрочки по сотрудникам, заявки без ответа, клиенты ждут ответа */
async function leaderDigest(db: Db, ctx: Ctx) {
  const over = (await db.query(`select u.full_name, count(*)::int as n from tasks t join users u on u.id = t.assignee_id
    where t.done_at is null and t.due_at < now() and t.due_at > now() - interval '7 days' group by u.full_name order by n desc limit 8`)).rows;
  const leads = (await db.query(`select count(*)::int as n from leads where taken_at is null and first_response_at is null and created_at > now() - interval '1 day'`)).rows[0].n;
  const wait = (await db.query(`select count(*)::int as n from msg_conversations c where c.last_inbound_at > now() - interval '1 day'
    and not exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'out' and not m.auto and m.created_at > c.last_inbound_at)`)).rows[0].n;
  const lines = ['Что горит сейчас:'];
  lines.push(`• Заявок без ответа за сутки: ${leads}`);
  lines.push(`• Клиентов ждут ответа в переписке: ${wait}`);
  lines.push(over.length ? `• Просроченные задачи (за неделю):\n${over.map((o) => `   – ${o.full_name}: ${o.n}`).join('\n')}` : '• Просроченных задач нет');
  void ctx;
  return lines.join('\n');
}

/* ---------- разбор сообщения ---------- */
type Intent = { kind: 'help' | 'list' | 'overdue' | 'snooze' | 'brief' | 'create' | 'digest' | 'unknown'; ref?: string; when?: string; title?: string };

export function ruleIntent(text: string): Intent {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е');
  if (/^(\/start|привет|помощь|help|что (ты )?умеешь|команды)/.test(t)) return { kind: 'help' };
  if (/(сводк|что горит|по клубу|итоги дня)/.test(t)) return { kind: 'digest' };
  if (/просроч/.test(t) && !/перенес/.test(t)) return { kind: 'overdue' };
  if (/^(мои )?задачи|что у меня|план на|что сегодня|^список/.test(t)) return { kind: 'list' };
  const sn = t.match(/^(?:перенеси|перенести|отложи|сдвинь)\s+(.+?)\s+((?:на |через |в |завтра|послезавтра|сегодня).*)$/);
  if (sn) return { kind: 'snooze', ref: sn[1].replace(/^задачу\s+/, ''), when: sn[2] };
  const br = t.match(/^(?:коротко|кратко|суть|что с|что по|расскажи про)\s*(?:про|о|об|по)?\s+(.+)$/);
  if (br) return { kind: 'brief', ref: br[1] };
  const cr = text.trim().match(/^(?:поставь|создай|добавь|напомни)(?:\s+мне)?\s+(?:задачу\s+)?(.+)$/i);
  if (cr) {
    const w = cr[1].match(/\s((?:сегодня|завтра|послезавтра|через|в\s+\d).*)$/i);
    return { kind: 'create', title: (w ? cr[1].slice(0, w.index) : cr[1]).trim(), when: w?.[1] ?? 'завтра' };
  }
  return { kind: 'unknown' };
}

const LLM_PROMPT = `Ты разбираешь сообщение сотрудника фитнес-клуба своему ИИ-помощнику в CRM. Определи намерение.
Верни JSON {kind, ref, when, title, reply}:
kind — list (показать задачи), overdue (просроченные), snooze (перенести задачу), brief (суть ситуации по задаче/клиенту), create (поставить себе задачу), digest (сводка по клубу), help, unknown;
ref — номер задачи из списка или имя клиента, как написал сотрудник; when — когда, словами по-русски («завтра в 12», «через 2 часа»); title — текст новой задачи;
reply — если kind=unknown: короткий дружелюбный ответ по делу (без выдумок о данных CRM).`;

export async function botReply(db: Db, ctx: Ctx, text: string, yandex: YandexConfig | null): Promise<string> {
  const leader = isLeader(ctx);
  // Руководитель: сначала — ответ на уточняющий вопрос помощника и команды «напомни Марии» / «передай задачи Марии Ксении»
  if (MEETING_STATUS_RE.test(text)) return meetingStatus(db, ctx);
  if (leader) {
    const mp = await meetingPendingReply(db, ctx, text);
    if (mp) return mp;
    if (MEETING_RE.test(text.trim())) return proposeMeeting(db, ctx, text);
    const p = await ownerPendingReply(db, ctx, text, yandex);
    if (p) return p;
    if (/^(напомни|поторопи|пни|передай|передать|переназначь)\s+(?!мне\b)/i.test(text.trim())) {
      const a = await ownerAnswer(db, ctx, text, yandex);
      if (!/^Не понял, о каком сотруднике/.test(a) || /^(передай|передать|переназначь)/i.test(text.trim())) return a;
    }
  }
  let it = ruleIntent(text);
  if (leader && it.kind === 'brief') {
    const t = await findTask(db, ctx, it.ref ?? '');
    if (!t || t === 'many') return ownerAnswer(db, ctx, text, yandex);
  }
  if (leader && (it.kind === 'digest' || it.kind === 'unknown')) return ownerAnswer(db, ctx, text, yandex);
  let llmReply = '';
  if (it.kind === 'unknown' && yandex) {
    try {
      const r = await ygptJson<Intent & { reply?: string }>(yandex, LLM_PROMPT, text.slice(0, 1000), 400);
      if (r?.kind) { it = { kind: r.kind, ref: r.ref ? String(r.ref) : undefined, when: r.when, title: r.title }; llmReply = r.reply ?? ''; }
    } catch { /* без нейросети — по правилам */ }
  }
  switch (it.kind) {
    case 'help': return leader ? `${WELCOME}\n\n${OWNER_HELP}` : WELCOME;
    case 'list': case 'overdue': {
      const ts = await myTasks(db, ctx.userId, it.kind === 'overdue');
      await remember(db, ctx, ts.map((t) => t.id));
      return listText(ts, it.kind === 'overdue' ? 'Просроченные задачи' : 'Ваши задачи на сегодня и завтра');
    }
    case 'snooze': {
      const t = await findTask(db, ctx, it.ref ?? '');
      if (t === 'many') return `Нашёл несколько клиентов с таким именем. Напишите «мои задачи» и укажите номер: «перенеси 2 ${it.when ?? 'на завтра'}».`;
      if (!t) return 'Не нашёл такую задачу среди ваших открытых. Напишите «мои задачи», чтобы увидеть список с номерами.';
      const at = parseWhen(it.when ?? '', t.timezone);
      if (!at) return 'Не понял, на когда перенести. Например: «на завтра», «через 2 часа», «завтра в 15:00».';
      return snooze(db, ctx, t, at);
    }
    case 'brief': {
      const t = await findTask(db, ctx, it.ref ?? '');
      if (t === 'many') return 'Нашёл несколько клиентов с таким именем. Напишите «мои задачи» и укажите номер: «коротко про 2».';
      if (!t) return 'Не нашёл такую задачу среди ваших открытых. Напишите «мои задачи», чтобы увидеть список с номерами.';
      const b = await situationBrief(db, ctx, yandex, 'task', t.id);
      return b.text.length > 3900 ? `${b.text.slice(0, 3900)}…\n\nПолностью — кнопка «Коротко о ситуации» в задаче.` : b.text;
    }
    case 'create': {
      const club = await clubOf(db, ctx.userId);
      if (!club) return 'Не нашёл ваш клуб, поставьте задачу в CRM.';
      if (!it.title || it.title.length < 3) return 'Напишите, что сделать. Например: «поставь задачу позвонить поставщику завтра в 12».';
      const at = parseWhen(it.when ?? 'завтра', club.timezone) ?? parseWhen('завтра', club.timezone)!;
      const id = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, created_by) values ($1,$2,$3,'other',$4,$5,$3) returning id`,
        [ctx.tenantId, club.id, ctx.userId, it.title.slice(0, 300), at])).rows[0].id;
      await audit(db, ctx, 'task.created', 'task', id, null, { title: it.title, via: 'agent_chat' });
      return `Поставил задачу «${it.title}» на ${fmtDate(at, club.timezone)}. Она в разделе «Задачи».`;
    }
    case 'digest':
      if (!can(ctx, P.crmViewAll)) return 'Сводка по клубу — для руководителей. Вам могу показать ваши задачи: напишите «мои задачи».';
      return leaderDigest(db, ctx);
    default:
      return llmReply || 'Пока я понимаю такие просьбы:\n• «мои задачи», «что просрочено»\n• «перенеси 2 на завтра»\n• «коротко про Анну»\n• «поставь задачу … завтра в 12»\n• «сводка» (для руководителя)';
  }
}

/** Ответ помощника на новое сообщение сотрудника (вызывается после сохранения сообщения) */
export async function handleBotMessage(pool: pg.Pool, ctx: Ctx, chatId: string, text: string, yandex: YandexConfig | null) {
  try {
    await withCtx(pool, ctx, async (db) => {
      const bot = await botPeer(db, chatId, ctx.userId);
      if (!bot) return;
      await db.query('update team_members set last_read_at = now() where chat_id = $1 and user_id = $2', [chatId, bot]);
      const reply = await botReply(db, ctx, text, yandex);
      await say(db, ctx.tenantId, chatId, bot, reply);
    });
  } catch (e) { console.error('ИИ-помощник в мессенджере:', (e as Error).message); }
}

export function agentChatRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Открыть чат с помощником (создаётся при первом обращении, помощник здоровается)
  app.post('/api/agent/chat', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => ({ id: (await ensureBotChat(db, ctx)).id }));
  });
}
