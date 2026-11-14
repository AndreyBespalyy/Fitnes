// ИИ-агент, этап 6 (выбор Андрея 14.11.2026, 6АБ): бизнес-процессы — готовые шаблоны, конструктор и «опиши процесс словами».
// Запущенный процесс ведёт агент: текущий шаг — задача исполнителя (по роли), выполнили — сам запускает следующий,
// просрочки шагов идут по лестнице эскалации (это обычные задачи), выход процесса за срок — карточка ответственному и РОПу.
// В каждом процессе — кнопка «Коротко о ситуации»: ход процесса + всё по клиенту (звонки, переписка, занятия, наблюдения).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { ygptComplete, ygptJson, type YandexConfig } from '../lib/yandex.ts';
import { collectFacts, fitBrief, fmtDate, noContacts, rulesBrief } from './agent.ts';
import { card, leastLoaded } from './agentReminders.ts';

export type Step = { title: string; role: string; hours: number };
export const ROLE_NAME: Record<string, string> = { owner: 'ответственный за процесс', manager: 'менеджер', rop: 'РОП', trainer: 'тренер', desk: 'администратор', gm: 'управляющий', fin: 'финансист' };

export const BUILTIN: { code: string; name: string; description: string; steps: Step[] }[] = [
  { code: 'new_client', name: 'Новый клиент: от заявки до первой тренировки', description: 'Чтобы заявка не остыла: звонок за 15 минут, визит, вводная тренировка и звонок после первой недели.',
    steps: [{ title: 'Позвонить по заявке, узнать цель, пригласить на экскурсию', role: 'manager', hours: 0.25 }, { title: 'Подтвердить визит накануне', role: 'manager', hours: 24 },
      { title: 'Провести экскурсию и пробную тренировку, предложить абонемент', role: 'manager', hours: 72 }, { title: 'Вводная тренировка и программа на месяц', role: 'trainer', hours: 120 },
      { title: 'Позвонить после первой недели: всё ли нравится, что улучшить', role: 'manager', hours: 168 }] },
  { code: 'renewal', name: 'Продление абонемента', description: 'Запускать за 30 дней до окончания: звонок, предложение, оплата, благодарность.',
    steps: [{ title: 'Позвонить: как результаты, напомнить об окончании абонемента', role: 'manager', hours: 48 }, { title: 'Сделать персональное предложение по продлению', role: 'manager', hours: 120 },
      { title: 'Оформить продление и принять оплату', role: 'manager', hours: 240 }, { title: 'Поблагодарить за продление, предложить привести друга', role: 'desk', hours: 48 }] },
  { code: 'return', name: 'Возврат ушедшего клиента', description: 'Для бывших клиентов: узнать причину ухода и вернуть с понятным предложением.',
    steps: [{ title: 'Позвонить: узнать, почему перестал ходить', role: 'manager', hours: 48 }, { title: 'Предложить гостевой визит или специальные условия', role: 'manager', hours: 72 },
      { title: 'Провести визит, подобрать программу', role: 'trainer', hours: 168 }, { title: 'Оформить абонемент', role: 'manager', hours: 72 }] },
  { code: 'complaint', name: 'Жалоба клиента', description: 'Ответ клиенту в течение суток, разбор причины и проверка через неделю.',
    steps: [{ title: 'Принять жалобу, извиниться, записать суть', role: 'desk', hours: 1 }, { title: 'Разобраться в причине, решить, что исправить', role: 'gm', hours: 24 },
      { title: 'Связаться с клиентом и рассказать о решении', role: 'gm', hours: 24 }, { title: 'Через неделю уточнить, всё ли в порядке', role: 'manager', hours: 168 }] },
  { code: 'new_staff', name: 'Приём нового сотрудника', description: 'Первые две недели: оформление, доступы, обучение и наставник.',
    steps: [{ title: 'Оформить документы и график', role: 'gm', hours: 24 }, { title: 'Выдать доступ в CRM и мессенджер', role: 'gm', hours: 24 },
      { title: 'Обучить работе в CRM и стандартам звонков', role: 'rop', hours: 72 }, { title: 'Закрепить наставника на 2 недели', role: 'gm', hours: 24 },
      { title: 'Аттестация: проверить знания и первые результаты', role: 'gm', hours: 240 }] },
];

/* ---------- «опиши процесс словами» ---------- */
const ROLE_WORDS: [RegExp, string][] = [[/(\bроп\b|руководител\S* (отдела )?продаж)/, 'rop'], [/менеджер/, 'manager'], [/тренер/, 'trainer'], [/(администратор|ресепшн|ресепшен)/, 'desk'],
  [/управляющ/, 'gm'], [/(финансист|бухгалтер)/, 'fin'], [/(ответственн|организатор|я\b|сам)/, 'owner']];
function hoursOf(t: string): number | null {
  const n = t.match(/(?:в течение|за|через|не позже чем через|до)\s*(\d+(?:[.,]\d)?)\s*(мин|час|ч\b|дн|день|дня|сут|недел)/);
  if (n) { const v = Number(n[1].replace(',', '.')); const u = n[2]; return u.startsWith('мин') ? Math.max(0.25, v / 60) : u.startsWith('ч') ? v : u.startsWith('недел') ? v * 168 : v * 24; }
  if (/(сразу|немедленно|в течение часа|за час)/.test(t)) return 1;
  if (/(в тот же день|сегодня|до конца дня)/.test(t)) return 8;
  if (/(на следующий день|завтра|в течение суток|за сутки)/.test(t)) return 24;
  if (/(через неделю|в течение недели|за неделю)/.test(t)) return 168;
  return null;
}
export function parseProcessText(text: string): { name: string; steps: Step[] } {
  let src = text.trim().replace(/^(создай|сделай|добавь|запиши|опиши)?\s*(новый\s+)?(бизнес[- ]?)?процесс\s*/i, '');
  let name = '';
  const head = src.match(/^«?([^:\n«»]{3,120})»?\s*:\s*/);
  if (head) { name = head[1].trim(); src = src.slice(head[0].length); }
  const parts = src.split(/\n+|;|(?:^|\s)\d+[.)]\s+|\s*(?:→|->)\s*|,?\s+(?:затем|потом|после этого|далее|и после|в конце)\s+/i).map((x) => x?.trim()).filter((x): x is string => !!x && x.length > 2);
  const steps = parts.map((p) => {
    const t = p.toLowerCase().replace(/ё/g, 'е');
    const role = ROLE_WORDS.find(([re]) => re.test(t))?.[1] ?? 'owner';
    const title = p.replace(/\s*(?:в течение|за|через|не позже чем через)\s*\d+(?:[.,]\d)?\s*(?:минут\S*|мин|час\S*|ч\b|дн\S*|день|сут\S*|недел\S*)/i, '')
      .replace(/\s*(?:в течение часа|за час|в течение суток|за сутки|в течение дня|в тот же день|до конца дня|на следующий день|в течение недели|за неделю|сразу|немедленно)(?![а-яё])/gi, '')
      .replace(/^через неделю\s+/i, '').replace(/\s+через неделю(?![а-яё])/i, '')
      .replace(/^(?:сначала|первым делом|потом|затем)\s+/i, '').replace(/[.,]+$/, '').replace(/\s{2,}/g, ' ').trim();
    return { title: (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 200), role, hours: hoursOf(t) ?? 24 };
  }).filter((s) => s.title.length > 2).slice(0, 20);
  return { name: name || (steps[0] ? `Процесс: ${steps[0].title.slice(0, 60)}` : 'Новый процесс'), steps };
}
const TEXT_PROMPT = `Ты помогаешь руководителю фитнес-клуба описать бизнес-процесс. Из его текста составь шаги.
Верни JSON {name, steps:[{title, role, hours}]}: name — короткое название процесса; title — что сделать (глагол в начале, до 120 знаков);
role — кто делает: manager (менеджер по продажам), rop (руководитель отдела продаж), trainer, desk (администратор), gm (управляющий), fin (финансист), owner (ответственный за процесс, если не сказано);
hours — за сколько часов после начала шага его нужно сделать (сутки = 24, неделя = 168; если не сказано — 24). Не добавляй шагов, которых нет в тексте.`;
export async function processFromText(text: string, yandex: YandexConfig | null) {
  if (yandex) {
    try {
      const r = await ygptJson<{ name?: string; steps?: Step[] }>(yandex, TEXT_PROMPT, noContacts(text).slice(0, 3000), 1200);
      const steps = (r?.steps ?? []).filter((s) => s?.title).map((s) => ({ title: String(s.title).slice(0, 200), role: s.role in ROLE_NAME ? s.role : 'owner', hours: Math.max(0.25, Math.min(2000, Number(s.hours) || 24)) }));
      if (steps.length) return { name: String(r?.name || parseProcessText(text).name).slice(0, 200), steps, engine: 'yandexgpt' };
    } catch { /* по правилам */ }
  }
  return { ...parseProcessText(text), engine: 'rules' };
}

/* ---------- шаблоны ---------- */
export async function ensureBuiltins(db: Db, tenantId: string) {
  for (const b of BUILTIN) await db.query(`insert into process_templates(tenant_id, name, description, steps, builtin) values ($1,$2,$3,$4,$5) on conflict (tenant_id, builtin) where builtin is not null do nothing`,
    [tenantId, b.name, b.description, JSON.stringify(b.steps), b.code]);
}
function cleanSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || !raw.length) throw badRequest('Добавьте хотя бы один шаг');
  if (raw.length > 30) throw badRequest('Не больше 30 шагов');
  return raw.map((s, i) => {
    const x = s as Partial<Step>;
    const title = String(x.title ?? '').trim();
    if (!title) throw badRequest(`Шаг ${i + 1}: напишите, что сделать`);
    if (!(String(x.role) in ROLE_NAME)) throw badRequest(`Шаг ${i + 1}: неизвестная роль`);
    const hours = Number(x.hours);
    if (!(hours > 0 && hours <= 2000)) throw badRequest(`Шаг ${i + 1}: срок — от 15 минут до 83 дней`);
    return { title: title.slice(0, 200), role: String(x.role), hours };
  });
}

/* ---------- запуск и ход процесса ---------- */
async function assigneeFor(db: Db, clubId: string, role: string, ownerId: string | null, personId: string | null) {
  if (role === 'owner') return ownerId;
  if (role === 'manager') {
    if (personId) { // менеджер клиента, если он есть
      const own = (await db.query(`select o.owner_id from opportunities o join user_assignments a on a.user_id = o.owner_id and a.club_id = o.club_id and a.role_code = 'manager'
        where o.person_id = $1 and o.club_id = $2 and o.owner_id is not null order by (o.status = 'open') desc, o.updated_at desc limit 1`, [personId, clubId])).rows[0]?.owner_id;
      if (own) return own as string;
    }
    return (await leastLoaded(db, clubId, null))?.id ?? ownerId;
  }
  const u = (await db.query(`select u.id from users u join user_assignments a on a.user_id = u.id
    where a.club_id = $1 and a.role_code = $2 and u.status = 'active' and not u.is_bot and (a.active_to is null or a.active_to >= current_date)
    order by (select count(*) from tasks t where t.assignee_id = u.id and t.done_at is null), u.full_name limit 1`, [clubId, role])).rows[0]?.id;
  return (u as string | undefined) ?? ownerId;
}

async function activateStep(db: Db, actor: { tenantId: string; userId: string | null }, processId: string, ord: number) {
  const p = (await db.query(`select id, club_id, title, person_id, owner_id from processes where id = $1`, [processId])).rows[0];
  const s = (await db.query(`select id, title, role, hours from process_steps where process_id = $1 and ord = $2`, [processId, ord])).rows[0];
  if (!p || !s) return null;
  const who = await assigneeFor(db, p.club_id, s.role, p.owner_id, p.person_id);
  const kind = /^(позвон|созвон|перезвон)/i.test(s.title) ? 'call' : 'other';
  const task = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at, created_by)
    values ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7), $8) returning id, due_at`,
  [actor.tenantId, p.club_id, who, p.person_id, kind, `${s.title} · процесс «${p.title}»`.slice(0, 300), Math.round(Number(s.hours) * 60), actor.userId])).rows[0];
  await db.query(`update process_steps set status = 'active', assignee_id = $2, task_id = $3, started_at = now(), due_at = $4 where id = $1`, [s.id, who, task.id, task.due_at]);
  return { stepId: s.id as string, taskId: task.id as string, assignee: who };
}

export async function startProcess(db: Db, ctx: Ctx, o: { clubId: string; templateId?: string; title?: string; steps?: Step[]; personId?: string | null; ownerId?: string | null; note?: string }) {
  let title = o.title?.trim() ?? ''; let steps = o.steps;
  if (o.templateId) {
    const t = (await db.query(`select name, steps from process_templates where id = $1 and is_active`, [o.templateId])).rows[0];
    if (!t) throw notFound('Шаблон не найден');
    title ||= t.name; steps = t.steps;
  }
  const clean = cleanSteps(steps);
  if (!title) throw badRequest('Назовите процесс');
  if (o.personId) {
    const p = (await db.query(`select full_name from persons where id = $1`, [o.personId])).rows[0];
    if (!p) throw notFound('Клиент не найден');
    if (!title.includes(p.full_name)) title = `${title} — ${p.full_name}`;
  }
  const total = clean.reduce((a, s) => a + s.hours, 0);
  const id = (await db.query(`insert into processes(tenant_id, club_id, template_id, title, note, person_id, owner_id, due_at, created_by)
    values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8), $9) returning id`,
  [ctx.tenantId, o.clubId, o.templateId ?? null, title.slice(0, 300), (o.note ?? '').slice(0, 2000), o.personId ?? null, o.ownerId ?? ctx.userId, Math.round(total * 60), ctx.userId])).rows[0].id as string;
  for (const [i, s] of clean.entries()) await db.query(`insert into process_steps(tenant_id, club_id, process_id, ord, title, role, hours) values ($1,$2,$3,$4,$5,$6,$7)`, [ctx.tenantId, o.clubId, id, i + 1, s.title, s.role, s.hours]);
  await activateStep(db, ctx, id, 1);
  await audit(db, ctx, 'process.started', 'process', id, null, { title, steps: clean.length });
  return id;
}

/** Ход процессов клуба: выполненный шаг → следующий; конец → итог; выход за срок → карточка */
export async function advanceProcesses(db: Db, actor: { tenantId: string; userId: string | null }, clubId: string) {
  const done = (await db.query(`select s.id, s.process_id, s.ord from process_steps s join tasks t on t.id = s.task_id join processes p on p.id = s.process_id
    where s.club_id = $1 and s.status = 'active' and t.done_at is not null and p.status = 'active'`, [clubId])).rows;
  let moved = 0;
  for (const s of done) {
    await db.query(`update process_steps set status = 'done', done_at = (select done_at from tasks where id = (select task_id from process_steps where id = $1)) where id = $1`, [s.id]);
    const next = await activateStep(db, actor, s.process_id, s.ord + 1);
    if (!next) {
      const p = (await db.query(`update processes set status = 'done', finished_at = now() where id = $1 returning title, owner_id, started_at`, [s.process_id])).rows[0];
      if (p?.owner_id) await card(db, clubId, [p.owner_id], { kind: 'agent_process', title: `Процесс завершён: ${p.title}`.slice(0, 200), body: 'Все шаги выполнены.', objectType: null, objectId: null, actions: ['open'], link: { tab: 'processes' } });
    }
    moved++;
  }
  const late = (await db.query(`select p.id, p.title, p.owner_id from processes p where p.club_id = $1 and p.status = 'active' and p.due_at < now()
    and not exists (select 1 from agent_sent x where x.club_id = p.club_id and x.key = 'process_late:' || p.id)`, [clubId])).rows;
  for (const p of late) {
    await db.query(`insert into agent_sent(tenant_id, club_id, key) values (app_tenant(), $1, $2) on conflict do nothing`, [clubId, `process_late:${p.id}`]);
    const rop = (await db.query(`select a.user_id from user_assignments a where a.club_id = $1 and a.role_code = 'rop' and (a.active_to is null or a.active_to >= current_date)`, [clubId])).rows.map((r) => r.user_id);
    const cur = (await db.query(`select s.title, u.full_name from process_steps s left join users u on u.id = s.assignee_id where s.process_id = $1 and s.status = 'active'`, [p.id])).rows[0];
    await card(db, clubId, [p.owner_id, ...rop].filter(Boolean), { kind: 'agent_process', title: `Процесс выходит за срок: ${p.title}`.slice(0, 200),
      body: cur ? `Застрял на шаге «${cur.title}»${cur.full_name ? ` (${cur.full_name})` : ''}.` : 'Проверьте шаги.', objectType: null, objectId: null, actions: ['open'], link: { tab: 'processes' } });
    await db.query(`insert into agent_observations(tenant_id, club_id, kind, body) values (app_tenant(), $1, 'process_late', $2)`, [clubId, `Процесс «${p.title}» вышел за срок${cur ? `, шаг «${cur.title}»` : ''}`]);
  }
  return { moved, late: late.length };
}

/* ---------- «Коротко о ситуации» по процессу ---------- */
async function processFacts(db: Db, id: string) {
  const p = (await db.query(`select p.*, c.timezone, c.name as club, u.full_name as owner, pe.full_name as person, t.name as template
    from processes p join clubs c on c.id = p.club_id left join users u on u.id = p.owner_id left join persons pe on pe.id = p.person_id left join process_templates t on t.id = p.template_id where p.id = $1`, [id])).rows[0];
  if (!p) throw notFound('Процесс не найден');
  const steps = (await db.query(`select s.ord, s.title, s.role, s.hours, s.status, s.started_at, s.due_at, s.done_at, u.full_name as assignee, t.result
    from process_steps s left join users u on u.id = s.assignee_id left join tasks t on t.id = s.task_id where s.process_id = $1 order by s.ord`, [id])).rows;
  return { p, steps };
}
function processRules(p: Record<string, any>, steps: Record<string, any>[], clientBrief: string | null) {
  const tz = p.timezone as string;
  const done = steps.filter((s) => s.status === 'done').length;
  const cur = steps.find((s) => s.status === 'active');
  const late = cur && new Date(cur.due_at) < new Date();
  const out = ['**Главное**'];
  out.push(`Процесс **«${p.title}»** — ${p.status === 'done' ? '**завершён**' : p.status === 'cancelled' ? 'отменён' : `выполнено **${done} из ${steps.length}** шагов`}. Ответственный: ${p.owner ?? '—'}. Запущен ${fmtDate(p.started_at, tz)}, срок всего процесса — ${fmtDate(p.due_at, tz)}${p.status === 'active' && new Date(p.due_at) < new Date() ? ' — **срок прошёл**' : ''}.`);
  if (cur) out.push(`Сейчас шаг ${cur.ord}: «${cur.title}» — ${cur.assignee ?? 'исполнитель не назначен'}, срок ${fmtDate(cur.due_at, tz)}${late ? ' — **просрочен**' : ''}.`);
  if (p.note) out.push(`Пометка: ${noContacts(String(p.note)).slice(0, 400)}`);
  out.push('');
  if (cur) {
    out.push('**Что сделать сейчас**');
    out.push(late ? `• **${cur.assignee ?? 'Исполнитель'}: выполнить «${cur.title}» — шаг просрочен.** Если не успевает — передайте шаг другому в задаче.` : `• ${cur.assignee ?? 'Исполнитель'}: «${cur.title}» до ${fmtDate(cur.due_at, tz)}.`);
    const next = steps.find((s) => s.ord === cur.ord + 1);
    if (next) out.push(`• Дальше: «${next.title}» (${ROLE_NAME[next.role] ?? next.role}) — запущу сам, когда этот шаг отметят выполненным.`);
    out.push('');
  }
  out.push('**Шаги процесса**');
  for (const s of steps) out.push(`• ${s.status === 'done' ? '✅' : s.status === 'active' ? (new Date(s.due_at) < new Date() ? '⚠️' : '▶️') : '○'} ${s.ord}. ${s.title} — ${s.assignee ?? ROLE_NAME[s.role] ?? s.role}${s.done_at ? `, выполнен ${fmtDate(s.done_at, tz)}` : s.due_at ? `, срок ${fmtDate(s.due_at, tz)}` : `, ${s.hours} ч`}${s.result ? `. Итог: ${noContacts(String(s.result)).slice(0, 200)}` : ''}`);
  out.push('');
  // По клиенту — без его собственного «Что сделать сейчас»: что делать, говорит текущий шаг процесса
  if (clientBrief) out.push(clientBrief.replace(/^\*\*Что сделать сейчас\*\*\n(?:.+\n)*?\n/m, '').replace(/^\*\*Главное\*\*/m, `**Клиент: ${p.person}**`));
  return fitBrief(out.join('\n').trim());
}
const PROCESS_PROMPT = `Ты — ИИ-помощник в CRM сети фитнес-клубов. Сотрудник нажал «Коротко о ситуации» в бизнес-процессе.
По фактам (ход процесса и всё по клиенту) напиши сводку до 5000 знаков по-русски, простыми словами.
Разделы — заголовки в отдельной строке **жирным**: **Главное** (2–4 предложения: что за процесс, на каком шаге, что важно), **Что сделать сейчас** (1–5 пунктов «• »), **Шаги процесса**, затем по необходимости **Клиент**, **Занятия**, **Разговоры**, **Переписка**, **Риски**.
**Жирным** — только самое важное: просрочки, сроки, суммы, договорённости. Только то, что есть в фактах.`;

export async function processBrief(db: Db, ctx: Ctx, yandex: YandexConfig | null, id: string, force = false) {
  const { p, steps } = await processFacts(db, id);
  if (!can(ctx, P.crmViewAll) && p.owner_id !== ctx.userId &&
    !(await db.query(`select 1 from process_steps where process_id = $1 and assignee_id = $2`, [id, ctx.userId])).rowCount) throw notFound('Процесс не найден');
  let clientBrief: string | null = null; let clientFacts: unknown = null;
  if (p.person_id) {
    const opp = (await db.query(`select id from opportunities where person_id = $1 order by (status = 'open') desc, updated_at desc limit 1`, [p.person_id])).rows[0];
    if (opp) {
      try { const { facts } = await collectFacts(db, { ...ctx, permissions: new Set([...ctx.permissions, P.crmViewAll]) }, 'opportunity', opp.id); clientFacts = facts; clientBrief = rulesBrief(facts); }
      catch { /* без клиента */ }
    }
  }
  const { now: _n, ...stable } = (clientFacts ?? {}) as Record<string, unknown>;
  const hash = createHash('sha256').update(JSON.stringify({ p: { ...p, timezone: undefined }, steps, stable })).digest('hex').slice(0, 32);
  const engineWanted = yandex ? 'yandexgpt' : 'rules';
  if (!force) {
    const c = (await db.query(`select body, engine, created_at from agent_briefs where object_type = 'process' and object_id = $1 and input_hash = $2 and engine = $3 and created_at > now() - interval '3 hours' order by created_at desc limit 1`,
      [id, hash, engineWanted])).rows[0];
    if (c) return { text: c.body as string, engine: c.engine as string, createdAt: c.created_at as string, cached: true, sources: { steps: steps.length } };
  }
  let text = processRules(p, steps, clientBrief); let engine = engineWanted; let note: string | null = null;
  if (yandex) {
    try { text = fitBrief(await ygptComplete(yandex, PROCESS_PROMPT, noContacts(JSON.stringify({ now: new Date(), process: p, steps, client: clientFacts })).slice(0, 60_000), { temperature: 0.2, maxTokens: 3000 })); }
    catch (e) { engine = 'rules'; note = `YandexGPT не ответил (${(e as Error).message.slice(0, 120)}), сводка собрана без нейросети`; }
  }
  const row = (await db.query(`insert into agent_briefs(tenant_id, club_id, object_type, object_id, input_hash, body, engine, facts, created_by) values ($1,$2,'process',$3,$4,$5,$6,$7,$8) returning created_at`,
    [ctx.tenantId, p.club_id, id, hash, text, engine, JSON.stringify({ steps: steps.length }), ctx.userId])).rows[0];
  return { text, engine, createdAt: row.created_at as string, cached: false, sources: { steps: steps.length }, note };
}

/** Короткий список для руководителя в чате и «что горит» */
export async function processDigest(db: Db, clubIds: string[]) {
  const rows = (await db.query(`select p.title, p.due_at < now() as late, c.timezone,
      (select count(*) from process_steps s where s.process_id = p.id and s.status = 'done')::int as done, (select count(*) from process_steps s where s.process_id = p.id)::int as total,
      (select s.title || ' — ' || coalesce(u.full_name, '—') || case when s.due_at < now() then ' ⚠️ просрочен' else '' end from process_steps s left join users u on u.id = s.assignee_id where s.process_id = p.id and s.status = 'active') as cur
    from processes p join clubs c on c.id = p.club_id where p.club_id = any($1) and p.status = 'active' order by p.due_at limit 15`, [clubIds])).rows;
  return rows;
}

export function processRoutes(app: FastifyInstance, pool: pg.Pool, yandex: YandexConfig | null) {
  const canEdit = (ctx: Ctx) => can(ctx, P.crmViewAll) || can(ctx, P.configManage);
  app.get('/api/processes/templates', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    return withCtx(pool, ctx, async (db) => {
      await ensureBuiltins(db, ctx.tenantId);
      const rows = (await db.query(`select id, name, description, steps, builtin, updated_at as "updatedAt" from process_templates where is_active order by builtin is null, name`)).rows;
      return { items: rows, canEdit: canEdit(ctx), roles: ROLE_NAME };
    });
  });
  app.post('/api/processes/templates', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    if (!canEdit(ctx)) throw forbidden('Шаблоны процессов меняют руководители');
    const b = (req.body ?? {}) as { id?: string; name?: string; description?: string; steps?: unknown };
    const name = String(b.name ?? '').trim(); if (!name) throw badRequest('Назовите процесс');
    const steps = cleanSteps(b.steps);
    return withCtx(pool, ctx, async (db) => {
      if (b.id) {
        const r = await db.query(`update process_templates set name = $2, description = $3, steps = $4, updated_at = now() where id = $1 and is_active returning id`, [b.id, name.slice(0, 200), String(b.description ?? '').slice(0, 1000), JSON.stringify(steps)]);
        if (!r.rowCount) throw notFound('Шаблон не найден');
        await audit(db, ctx, 'process.template_updated', 'process_template', b.id, null, { name, steps: steps.length });
        return { id: b.id };
      }
      const id = (await db.query(`insert into process_templates(tenant_id, name, description, steps, created_by) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, name.slice(0, 200), String(b.description ?? '').slice(0, 1000), JSON.stringify(steps), ctx.userId])).rows[0].id;
      await audit(db, ctx, 'process.template_created', 'process_template', id, null, { name, steps: steps.length });
      return { id };
    });
  });
  app.delete('/api/processes/templates/:id', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    if (!canEdit(ctx)) throw forbidden('Шаблоны процессов меняют руководители');
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => { await db.query(`update process_templates set is_active = false where id = $1`, [id]); return { ok: true }; });
  });
  app.post('/api/processes/from-text', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const text = String((req.body as { text?: string } | null)?.text ?? '').trim();
    if (text.length < 10) throw badRequest('Опишите процесс подробнее: какие шаги, кто делает, за какое время');
    void ctx;
    return processFromText(text, yandex);
  });
  app.get('/api/processes', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId, status } = req.query as { clubId?: string; status?: string };
    return withCtx(pool, ctx, async (db) => {
      if (clubId) await advanceProcesses(db, ctx, clubId);
      const mineOnly = !can(ctx, P.crmViewAll);
      const rows = (await db.query(`select p.id, p.title, p.status, p.started_at as "startedAt", p.due_at as "dueAt", p.finished_at as "finishedAt", p.person_id as "personId", pe.full_name as person,
          u.full_name as owner, p.owner_id = $3 as "isOwner",
          coalesce((select json_agg(json_build_object('ord', s.ord, 'title', s.title, 'role', s.role, 'status', s.status, 'assignee', su.full_name, 'assigneeId', s.assignee_id, 'dueAt', s.due_at, 'doneAt', s.done_at, 'taskId', s.task_id) order by s.ord)
            from process_steps s left join users su on su.id = s.assignee_id where s.process_id = p.id), '[]') as steps
        from processes p left join persons pe on pe.id = p.person_id left join users u on u.id = p.owner_id
        where ($1::uuid is null or p.club_id = $1) and p.status = coalesce($2, 'active')
          and (not $4 or p.owner_id = $3 or exists (select 1 from process_steps s where s.process_id = p.id and s.assignee_id = $3))
        order by p.due_at limit 200`, [clubId ?? null, ['active', 'done', 'cancelled'].includes(status ?? '') ? status : null, ctx.userId, mineOnly])).rows;
      return { items: rows, canEdit: canEdit(ctx) };
    });
  });
  app.post('/api/processes', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const b = (req.body ?? {}) as { clubId?: string; templateId?: string; title?: string; steps?: Step[]; personId?: string; ownerId?: string; note?: string };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!b.templateId && !canEdit(ctx)) throw forbidden('Процесс без шаблона запускают руководители');
    return withCtx(pool, ctx, async (db) => ({ id: await startProcess(db, ctx, { ...b, clubId: b.clubId! }) }));
  });
  app.post('/api/processes/:id/step-done', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const result = String((req.body as { result?: string } | null)?.result ?? 'Сделано').slice(0, 1000);
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query(`select s.task_id, s.assignee_id, p.owner_id, p.club_id from process_steps s join processes p on p.id = s.process_id where s.process_id = $1 and s.status = 'active'`, [id])).rows[0];
      if (!s) throw notFound('Нет активного шага');
      if (s.assignee_id !== ctx.userId && s.owner_id !== ctx.userId && !can(ctx, P.crmViewAll)) throw forbidden('Отметить шаг может исполнитель, ответственный или руководитель');
      await db.query(`update tasks set done_at = now(), result = $2 where id = $1 and done_at is null`, [s.task_id, result]);
      await advanceProcesses(db, ctx, s.club_id);
      return { ok: true };
    });
  });
  app.post('/api/processes/:id/cancel', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query(`select owner_id from processes where id = $1 and status = 'active'`, [id])).rows[0];
      if (!p) throw notFound('Процесс не найден');
      if (p.owner_id !== ctx.userId && !can(ctx, P.crmViewAll)) throw forbidden('Отменить процесс может ответственный или руководитель');
      await db.query(`update tasks set done_at = now(), result = 'Процесс отменён' where id in (select task_id from process_steps where process_id = $1 and status = 'active') and done_at is null`, [id]);
      await db.query(`update process_steps set status = 'skipped' where process_id = $1 and status in ('pending', 'active')`, [id]);
      await db.query(`update processes set status = 'cancelled', finished_at = now() where id = $1`, [id]);
      await audit(db, ctx, 'process.cancelled', 'process', id, null, null);
      return { ok: true };
    });
  });
}
