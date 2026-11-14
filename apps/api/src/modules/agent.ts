// ИИ-агент управления процессами (выбор Андрея 14.11.2026). Этап 1: кнопка «Коротко о ситуации» в задаче и сделке.
// Агент собирает всё, что известно о ситуации: задачу и соседние задачи с результатами, сделку и её этапы, обращения,
// встречи, звонки (итоги и расшифровки), переписку с клиентом, обсуждения в корпоративном мессенджере (все чаты, решение 1Б),
// абонементы, долги, посещения и собственные наблюдения агента. Получается текст до 6000 знаков, главное — жирным.
// Если подключён YandexGPT — текст пишет он; если нет — система собирает его сама по правилам (без выдумок, только факты).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { ygptComplete, type YandexConfig } from '../lib/yandex.ts';

export const BRIEF_MAX = 6000;
const onlyMine = (ctx: Ctx) => !can(ctx, P.crmViewAll);
const rub = (kop: number | string | null | undefined) => `${Math.round(Number(kop ?? 0) / 100).toLocaleString('ru-RU')} ₽`;
/** Телефоны и e-mail в текстах заменяются: в сводку и в YandexGPT они не попадают */
const noContacts = (s: string) => s.replace(/\+?\d[\d\s()-]{8,}\d/g, '[телефон]').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail]');
const cut = (s: unknown, n: number) => { const t = noContacts(String(s ?? '')).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/* ---------- сбор фактов ---------- */
export type Facts = {
  now: string; timezone: string; clubName: string;
  target: { type: 'task' | 'opportunity'; id: string };
  task: null | { title: string; kind: string; dueAt: string; doneAt: string | null; result: string | null; overdueHours: number; assignee: string | null; createdAt: string };
  person: null | { id: string; name: string; segment: string; since: string; homeClub: string | null };
  opportunity: null | { id: string; pipeline: string; stage: string; status: string; owner: string | null; amountExpected: string | null; createdAt: string;
    lostReason: string | null; daysInStage: number; stageHistory: { at: string; from: string | null; to: string; actor: string | null; comment: string | null }[] };
  tasks: { title: string; kind: string; dueAt: string; doneAt: string | null; result: string | null; assignee: string | null; overdue: boolean }[];
  leads: { at: string; source: string | null; comment: string | null; firstResponseMin: number | null }[];
  meetings: { at: string; status: string }[];
  calls: { at: string; direction: string; manager: string | null; durationSec: number | null; essence: string | null; need: string | null; objections: string[];
    agreements: string | null; outcome: string | null; nextStep: string | null; transcript: string | null }[];
  clientMessages: { at: string; from: string; text: string }[];
  waitingReplySince: string | null;
  memberships: { product: string; status: string; startsOn: string; endsOn: string | null; visitsLeft: number | null; nextChargeOn: string | null }[];
  debts: { title: string; dueOn: string; amount: string }[];
  visits: { last: string | null; last30: number };
  team: { at: string; chat: string; personal: boolean; author: string | null; text: string }[];
  observations: { at: string; text: string }[];
};

const MEETING: Record<string, string> = { scheduled: 'назначена', attended: 'пришёл', no_show: 'не пришёл', cancelled: 'отменена' };
const KIND: Record<string, string> = { first_response: 'первый ответ', call: 'звонок', meeting: 'встреча', message: 'сообщение', other: 'задача' };
const OUTCOME: Record<string, string> = { interested: 'интересно', thinking: 'думает', refused: 'отказ', bought: 'купил', other: 'другое' };

async function personFacts(db: Db, personId: string, oppId: string | null, f: Facts) {
  const p = (await db.query(`select p.id, p.full_name, p.segment, p.created_at, c.name as club from persons p left join clubs c on c.id = p.home_club_id where p.id = $1`, [personId])).rows[0];
  if (!p) return;
  f.person = { id: p.id, name: p.full_name, segment: p.segment, since: p.created_at, homeClub: p.club };
  f.tasks = (await db.query(
    `select t.title, t.kind, t.due_at, t.done_at, t.result, u.full_name as assignee, (t.done_at is null and t.due_at < now()) as overdue
     from tasks t left join users u on u.id = t.assignee_id where t.person_id = $1 or ($2::uuid is not null and t.opportunity_id = $2)
     order by coalesce(t.done_at, t.due_at) desc limit 20`, [personId, oppId])).rows
    .map((r) => ({ title: r.title, kind: KIND[r.kind] ?? r.kind, dueAt: r.due_at, doneAt: r.done_at, result: r.result, assignee: r.assignee, overdue: r.overdue }));
  f.leads = (await db.query(
    `select l.created_at, s.name as source, l.comment, extract(epoch from l.first_response_at - l.created_at) / 60 as frm
     from leads l left join lead_sources s on s.id = l.source_id where l.person_id = $1 order by l.created_at desc limit 5`, [personId])).rows
    .map((r) => ({ at: r.created_at, source: r.source, comment: r.comment, firstResponseMin: r.frm == null ? null : Math.round(Number(r.frm)) }));
  f.meetings = (await db.query(`select scheduled_at, status from meetings where person_id = $1 order by scheduled_at desc limit 5`, [personId])).rows
    .map((r) => ({ at: r.scheduled_at, status: MEETING[r.status] ?? r.status }));
  f.calls = (await db.query(
    `select c.started_at, c.direction, u.full_name as manager, c.duration_sec, coalesce(s.final, s.draft) as s, c.transcript ->> 'text' as tr
     from calls c left join users u on u.id = c.user_id left join call_summaries s on s.call_id = c.id
     where c.person_id = $1 order by c.started_at desc limit 6`, [personId])).rows
    .map((r, i) => ({
      at: r.started_at, direction: r.direction === 'in' ? 'входящий' : 'исходящий', manager: r.manager, durationSec: r.duration_sec,
      essence: r.s?.essence || null, need: r.s?.need || null, objections: Array.isArray(r.s?.objections) ? r.s.objections : [],
      agreements: r.s?.agreements || null, outcome: r.s?.outcome ? OUTCOME[r.s.outcome] ?? r.s.outcome : null, nextStep: r.s?.nextStep?.title ?? null,
      // Полная расшифровка — только у двух последних разговоров, у остальных хватает итога
      transcript: r.tr ? cut(r.tr, i < 2 ? 3000 : 400) : null,
    }));
  const msgs = (await db.query(
    `select m.created_at, m.direction, m.body, m.auto, u.full_name as author from msg_messages m join msg_conversations c on c.id = m.conversation_id
     left join users u on u.id = m.author_id where c.person_id = $1 order by m.created_at desc limit 30`, [personId])).rows;
  f.clientMessages = msgs.reverse().map((m) => ({ at: m.created_at, from: m.direction === 'in' ? 'клиент' : m.auto ? 'автосообщение' : (m.author ?? 'клуб'), text: cut(m.body, 500) }));
  const lastIn = msgs.filter((m) => m.direction === 'in').at(-1);
  const lastOut = msgs.filter((m) => m.direction === 'out' && !m.auto).at(-1);
  f.waitingReplySince = lastIn && (!lastOut || new Date(lastOut.created_at) < new Date(lastIn.created_at)) ? lastIn.created_at : null;
  f.memberships = (await db.query(
    `select product_name, status, starts_on, ends_on, visits_left, next_charge_on from memberships where person_id = $1 order by starts_on desc limit 4`, [personId])).rows
    .map((r) => ({ product: r.product_name, status: r.status === 'active' ? 'действует' : 'расторгнут', startsOn: r.starts_on, endsOn: r.ends_on, visitsLeft: r.visits_left, nextChargeOn: r.next_charge_on }));
  f.debts = (await db.query(`select title, due_on, amount_kop from charges where person_id = $1 and status = 'due' and due_on <= current_date order by due_on limit 5`, [personId])).rows
    .map((r) => ({ title: r.title, dueOn: r.due_on, amount: rub(r.amount_kop) }));
  const v = (await db.query(`select max(visited_at) as last, count(*) filter (where visited_at > now() - interval '30 days')::int as n from visits where person_id = $1`, [personId])).rows[0];
  f.visits = { last: v?.last ?? null, last30: v?.n ?? 0 };
  // Обсуждения в мессенджере сотрудников: по имени клиента, по последним цифрам телефона или по ссылке на карточку
  const phones = (await db.query(`select right(normalized_value, 10) as d from person_contacts where person_id = $1 and type = 'phone'`, [personId])).rows.map((r) => r.d as string).filter((d) => d.length >= 10);
  const name = String(p.full_name).trim();
  const short = name.split(/\s+/).slice(0, 2).join(' ');
  f.team = (await db.query(
    `select m.created_at, m.body, u.full_name as author, ch.kind, coalesce(ch.title, case ch.kind when 'direct' then 'личная переписка' when 'club' then 'общий чат клуба' else 'чат отдела' end) as chat
     from team_messages m join team_chats ch on ch.id = m.chat_id left join users u on u.id = m.user_id
     where m.deleted_at is null and m.created_at > now() - interval '90 days' and (
       m.body ilike '%' || $1 || '%' or ($2 <> $1 and length($2) > 5 and m.body ilike '%' || $2 || '%') or m.body like '%' || $3 || '%'
       or (cardinality($4::text[]) > 0 and regexp_replace(m.body, '\\D', '', 'g') ~ any (select right(x, 10) from unnest($4::text[]) x)))
     order by m.created_at desc limit 15`, [name, short, personId, phones])).rows.reverse()
    .map((r) => ({ at: r.created_at, chat: r.chat, personal: r.kind === 'direct', author: r.author, text: cut(r.body, 400) }));
  f.observations = (await db.query(
    `select created_at, body from agent_observations where person_id = $1 or ($2::uuid is not null and opportunity_id = $2) order by created_at desc limit 10`, [personId, oppId])).rows
    .map((r) => ({ at: r.created_at, text: r.body }));
}

async function oppFacts(db: Db, oppId: string, f: Facts) {
  const o = (await db.query(
    `select o.id, o.status, o.amount_expected_kop, o.created_at, o.lost_reason, pl.name as pipeline, st.name as stage, u.full_name as owner,
       extract(epoch from now() - coalesce((select max(at) from opportunity_stage_history h where h.opportunity_id = o.id), o.created_at)) / 86400 as days
     from opportunities o join pipelines pl on pl.id = o.pipeline_id join pipeline_stages st on st.id = o.stage_id left join users u on u.id = o.owner_id where o.id = $1`, [oppId])).rows[0];
  if (!o) return;
  const hist = (await db.query(
    `select h.at, fs.name as from_name, ts.name as to_name, u.full_name as actor, h.comment from opportunity_stage_history h
     left join pipeline_stages fs on fs.id = h.from_stage_id join pipeline_stages ts on ts.id = h.to_stage_id left join users u on u.id = h.actor_id
     where h.opportunity_id = $1 order by h.at desc limit 10`, [oppId])).rows.reverse();
  f.opportunity = {
    id: o.id, pipeline: o.pipeline, stage: o.stage, status: o.status === 'open' ? 'в работе' : o.status === 'won' ? 'успешно' : 'отказ', owner: o.owner,
    amountExpected: o.amount_expected_kop ? rub(o.amount_expected_kop) : null, createdAt: o.created_at, lostReason: o.lost_reason, daysInStage: Math.floor(Number(o.days)),
    stageHistory: hist.map((h) => ({ at: h.at, from: h.from_name, to: h.to_name, actor: h.actor, comment: h.comment })),
  };
}

function emptyFacts(type: Facts['target']['type'], id: string, club: { name: string; timezone: string }): Facts {
  return { now: new Date().toISOString(), timezone: club.timezone, clubName: club.name, target: { type, id }, task: null, person: null, opportunity: null,
    tasks: [], leads: [], meetings: [], calls: [], clientMessages: [], waitingReplySince: null, memberships: [], debts: [], visits: { last: null, last30: 0 }, team: [], observations: [] };
}

export async function collectFacts(db: Db, ctx: Ctx, type: 'task' | 'opportunity', id: string): Promise<{ facts: Facts; clubId: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Не найдено');
  if (type === 'task') {
    const t = (await db.query(
      `select t.*, u.full_name as assignee, c.name as club_name, c.timezone, extract(epoch from now() - t.due_at) / 3600 as over_h
       from tasks t join clubs c on c.id = t.club_id left join users u on u.id = t.assignee_id where t.id = $1`, [id])).rows[0];
    if (!t || (onlyMine(ctx) && t.assignee_id !== ctx.userId)) throw notFound('Задача не найдена');
    const f = emptyFacts('task', id, { name: t.club_name, timezone: t.timezone });
    f.task = { title: t.title, kind: KIND[t.kind] ?? t.kind, dueAt: t.due_at, doneAt: t.done_at, result: t.result,
      overdueHours: t.done_at ? 0 : Math.max(0, Math.floor(Number(t.over_h))), assignee: t.assignee, createdAt: t.created_at };
    if (t.opportunity_id) await oppFacts(db, t.opportunity_id, f);
    if (t.person_id) await personFacts(db, t.person_id, t.opportunity_id, f);
    else if (t.call_id) {
      // Служебная задача по звонку (проверить итог): берём сам звонок
      const c = (await db.query(`select person_id from calls where id = $1`, [t.call_id])).rows[0];
      if (c?.person_id) await personFacts(db, c.person_id, t.opportunity_id, f);
    }
    f.observations.push(...(await db.query(`select created_at, body from agent_observations where task_id = $1 order by created_at desc limit 5`, [id])).rows
      .map((r) => ({ at: r.created_at, text: r.body })));
    return { facts: f, clubId: t.club_id };
  }
  const o = (await db.query(`select o.id, o.club_id, o.owner_id, o.person_id, c.name, c.timezone from opportunities o join clubs c on c.id = o.club_id where o.id = $1`, [id])).rows[0];
  if (!o || (onlyMine(ctx) && o.owner_id !== ctx.userId)) throw notFound('Сделка не найдена');
  const f = emptyFacts('opportunity', id, { name: o.name, timezone: o.timezone });
  await oppFacts(db, id, f);
  await personFacts(db, o.person_id, id, f);
  return { facts: f, clubId: o.club_id };
}

/* ---------- текст без нейросети ---------- */
export function fmtDate(s: string | Date | null | undefined, tz: string, withTime = true) {
  if (!s) return '—';
  const d = new Date(s);
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(d);
}
const plural = (n: number, a: string, b: string, c: string) => { const m = Math.abs(n) % 100; const k = m % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c; };
const ago = (s: string, now: Date) => {
  const h = Math.floor((now.getTime() - new Date(s).getTime()) / 3_600_000);
  if (h < 1) return 'меньше часа назад';
  if (h < 48) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.floor(h / 24);
  return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
};

/** Последний контакт с клиентом: звонок, сообщение от сотрудника или выполненная задача */
function lastContact(f: Facts) {
  const xs: { at: string; what: string }[] = [];
  if (f.calls[0]) xs.push({ at: f.calls[0].at, what: `${f.calls[0].direction} звонок${f.calls[0].manager ? ` (${f.calls[0].manager})` : ''}` });
  const out = [...f.clientMessages].reverse().find((m) => m.from !== 'клиент' && m.from !== 'автосообщение');
  if (out) xs.push({ at: out.at, what: `сообщение клиенту (${out.from})` });
  const done = f.tasks.find((t) => t.doneAt);
  if (done) xs.push({ at: done.doneAt!, what: `выполнена задача «${done.title}»` });
  return xs.sort((a, b) => +new Date(b.at) - +new Date(a.at))[0] ?? null;
}

/** Что сделать прямо сейчас — по фактам, от самого срочного */
export function actionsFrom(f: Facts) {
  const now = new Date(f.now);
  const a: string[] = [];
  if (f.waitingReplySince) a.push(`**Ответьте клиенту: он написал ${ago(f.waitingReplySince, now)} и ждёт ответа.**`);
  if (f.task && !f.task.doneAt && f.task.overdueHours > 0) a.push(`**Задача просрочена на ${f.task.overdueHours >= 48 ? `${Math.floor(f.task.overdueHours / 24)} дн.` : `${f.task.overdueHours} ч`}** — выполните её сейчас или перенесите срок с причиной.`);
  if (f.debts.length) a.push(`**Долг клиента: ${f.debts.map((d) => `${d.amount} (${d.title}, срок ${fmtDate(d.dueOn, f.timezone, false)})`).join('; ')}.** Напомните об оплате.`);
  const active = f.memberships.find((m) => m.status === 'действует');
  if (active?.endsOn) {
    const days = Math.ceil((new Date(active.endsOn).getTime() - now.getTime()) / 86_400_000);
    if (days >= 0 && days <= 14) a.push(`**Абонемент «${active.product}» заканчивается через ${days} ${plural(days, 'день', 'дня', 'дней')}** — предложите продление.`);
  }
  const lastCall = f.calls.find((c) => c.nextStep || c.agreements);
  if (lastCall?.nextStep) a.push(`По последнему разговору договорились: «${cut(lastCall.nextStep, 160)}». Проверьте, что это сделано.`);
  const lc = lastContact(f);
  if (f.opportunity?.status === 'в работе') {
    if (!lc || now.getTime() - new Date(lc.at).getTime() > 3 * 86_400_000) a.push(`**С клиентом не было контакта ${lc ? ago(lc.at, now) : 'ни разу'}** — свяжитесь сегодня.`);
    if (f.opportunity.daysInStage >= 7) a.push(`Сделка стоит на этапе «${f.opportunity.stage}» ${f.opportunity.daysInStage} ${plural(f.opportunity.daysInStage, 'день', 'дня', 'дней')}: решите, двигать дальше или закрывать.`);
    if (!f.tasks.some((t) => !t.doneAt)) a.push('**У сделки нет следующего шага** — поставьте задачу.');
  }
  const objections = [...new Set(f.calls.flatMap((c) => c.objections))].slice(0, 3);
  if (objections.length) a.push(`Подготовьте ответ на возражения клиента: ${objections.map((o) => `«${cut(o, 80)}»`).join(', ')}.`);
  if (!a.length) a.push('Срочного ничего нет: действуйте по задаче.');
  return a;
}

export function rulesBrief(f: Facts) {
  const tz = f.timezone;
  const now = new Date(f.now);
  const out: string[] = [];
  // Главное — одной-двумя фразами
  const head: string[] = [];
  if (f.task) head.push(`Задача «${f.task.title}» (${f.task.kind}) ${f.task.doneAt ? `выполнена ${fmtDate(f.task.doneAt, tz)}` : `до ${fmtDate(f.task.dueAt, tz)}`}${f.task.assignee ? `, исполнитель ${f.task.assignee}` : ''}.`);
  if (f.person) head.push(`Клиент **${f.person.name}** — ${f.person.segment}, в базе с ${fmtDate(f.person.since, tz, false)}.`);
  if (f.opportunity) head.push(`Сделка «${f.opportunity.pipeline}»: этап **«${f.opportunity.stage}»** (${f.opportunity.status}), ответственный ${f.opportunity.owner ?? 'не назначен'}${f.opportunity.amountExpected ? `, ожидаемая сумма ${f.opportunity.amountExpected}` : ''}.`);
  const lc = lastContact(f);
  if (lc) head.push(`Последний контакт: ${lc.what}, ${ago(lc.at, now)}.`);
  out.push('**Главное**', head.join(' '), '');
  out.push('**Что сделать сейчас**', ...actionsFrom(f).map((x) => `• ${x}`), '');

  const lastCall = f.calls.find((c) => c.essence);
  if (lastCall) {
    out.push('**Последний разговор**');
    out.push(`• ${fmtDate(lastCall.at, tz)}, ${lastCall.direction}${lastCall.manager ? `, ${lastCall.manager}` : ''}: ${cut(lastCall.essence, 400)}`);
    if (lastCall.need) out.push(`• Потребность: ${cut(lastCall.need, 200)}`);
    if (lastCall.objections.length) out.push(`• Возражения: ${lastCall.objections.map((o) => cut(o, 80)).join('; ')}`);
    if (lastCall.agreements) out.push(`• Договорились: ${cut(lastCall.agreements, 200)}`);
    if (lastCall.outcome) out.push(`• Итог: ${lastCall.outcome}`);
    out.push('');
  }
  if (f.memberships.length || f.debts.length || f.visits.last) {
    out.push('**Абонемент и посещения**');
    for (const m of f.memberships.slice(0, 2)) out.push(`• ${m.product} — ${m.status}, с ${fmtDate(m.startsOn, tz, false)}${m.endsOn ? ` по ${fmtDate(m.endsOn, tz, false)}` : ''}${m.visitsLeft != null ? `, осталось посещений: ${m.visitsLeft}` : ''}${m.nextChargeOn ? `, следующее списание ${fmtDate(m.nextChargeOn, tz, false)}` : ''}`);
    out.push(`• Посещений за 30 дней: ${f.visits.last30}${f.visits.last ? `, последнее ${fmtDate(f.visits.last, tz)}` : ''}`);
    out.push('');
  }
  if (f.clientMessages.length) {
    out.push('**Переписка с клиентом** (последние сообщения)');
    for (const m of f.clientMessages.slice(-5)) out.push(`• ${fmtDate(m.at, tz)}, ${m.from}: ${cut(m.text, 200)}`);
    out.push('');
  }
  const doneTasks = f.tasks.filter((t) => t.doneAt && t.result).slice(0, 5);
  if (doneTasks.length) {
    out.push('**Что уже делали** (результаты задач)');
    for (const t of doneTasks) out.push(`• ${fmtDate(t.doneAt, tz)}, ${t.assignee ?? '—'}: «${t.title}» — ${cut(t.result, 200)}`);
    out.push('');
  }
  if (f.opportunity?.stageHistory.length) {
    out.push('**Движение по этапам**');
    for (const h of f.opportunity.stageHistory.slice(-4)) out.push(`• ${fmtDate(h.at, tz)}: ${h.from ? `${h.from} → ` : ''}${h.to}${h.actor ? ` (${h.actor})` : ''}${h.comment ? ` — ${cut(h.comment, 120)}` : ''}`);
    out.push('');
  }
  if (f.leads.length) {
    const l = f.leads[0];
    out.push('**Обращение**', `• ${fmtDate(l.at, tz)}, источник: ${l.source ?? 'не указан'}${l.comment ? `, «${cut(l.comment, 160)}»` : ''}${l.firstResponseMin != null ? `, первый ответ через ${l.firstResponseMin} мин` : ', первого ответа не было'}`, '');
  }
  const team = f.team.filter((t) => !t.personal).slice(-4);
  if (team.length) {
    out.push('**Обсуждали в команде**');
    for (const t of team) out.push(`• ${fmtDate(t.at, tz)}, ${t.chat}, ${t.author ?? 'система'}: ${cut(t.text, 200)}`);
    out.push('');
  }
  if (f.observations.length) {
    out.push('**Наблюдения ИИ-помощника**');
    for (const o of f.observations.slice(0, 4)) out.push(`• ${fmtDate(o.at, tz)}: ${cut(o.text, 200)}`);
  }
  return fitBrief(out.join('\n'));
}

/** Не длиннее 6000 знаков: лишнее отрезается по строкам */
export function fitBrief(text: string) {
  const t = text.replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= BRIEF_MAX) return t;
  const lines = t.split('\n');
  let s = '';
  for (const l of lines) { if (s.length + l.length + 2 > BRIEF_MAX - 2) break; s += (s ? '\n' : '') + l; }
  return `${s}\n…`;
}

/* ---------- текст от YandexGPT ---------- */
const BRIEF_PROMPT = `Ты — ИИ-помощник в CRM сети фитнес-клубов. Сотрудник нажал «Коротко о ситуации» по задаче или сделке.
По фактам из CRM (JSON) напиши сводку, чтобы за минуту понять ситуацию и что делать дальше.
Правила:
- Только по-русски, простыми словами, без канцелярита. Не больше 5000 знаков.
- Разделы с заголовками в отдельной строке, выделенными **жирным**: **Главное**, **Что сделать сейчас**, затем по необходимости **Клиент и абонемент**, **Разговоры**, **Переписка**, **Что уже делали**, **Риски**.
- В «Главном» 2–4 предложения: кто клиент, на каком шаге, что сейчас важно.
- «Что сделать сейчас» — 1–5 пунктов списком «• », от самого срочного, конкретно (что, кому, до какого времени).
- **Жирным** выделяй только самое важное: сроки, просрочки, суммы долга, ключевые возражения, договорённости.
- Пиши только то, что есть в фактах. Не выдумывай имена, суммы, даты. Даты — в часовом поясе клуба, кратко (14.11 15:30).
- Личную переписку сотрудников (personal: true) не цитируй дословно — только суть, если она важна для дела.
- Не пиши телефоны и e-mail.`;

export async function llmBrief(y: YandexConfig, f: Facts) {
  const text = await ygptComplete(y, BRIEF_PROMPT, `Сейчас: ${fmtDate(f.now, f.timezone)} (${f.timezone}).\nПодсказки системы о срочном: ${JSON.stringify(actionsFrom(f))}\nФакты: ${JSON.stringify(f).slice(0, 60_000)}`,
    { temperature: 0.2, maxTokens: 3000 });
  return fitBrief(text);
}

/* ---------- сводка с кэшем ---------- */
export async function situationBrief(db: Db, ctx: Ctx, yandex: YandexConfig | null, type: 'task' | 'opportunity', id: string, force = false) {
  const { facts, clubId } = await collectFacts(db, ctx, type, id);
  // Отпечаток без «сейчас»: сводка обновляется, когда изменились данные, или раз в 3 часа (сроки и «давно не связывались» сдвигаются)
  const { now, ...stable } = facts;
  const hash = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
  const engineWanted = yandex ? 'yandexgpt' : 'rules';
  if (!force) {
    const c = (await db.query(`select body, engine, created_at from agent_briefs where object_type = $1 and object_id = $2 and input_hash = $3 and engine = $4
      and created_at > now() - interval '3 hours' order by created_at desc limit 1`, [type, id, hash, engineWanted])).rows[0];
    if (c) return { text: c.body as string, engine: c.engine as string, createdAt: c.created_at as string, cached: true, sources: sourcesOf(facts) };
  }
  let text: string; let engine = engineWanted; let note: string | null = null;
  if (yandex) {
    try { text = await llmBrief(yandex, facts); }
    catch (e) { text = rulesBrief(facts); engine = 'rules'; note = `YandexGPT не ответил (${(e as Error).message.slice(0, 120)}), сводка собрана без нейросети`; }
  } else text = rulesBrief(facts);
  const row = (await db.query(`insert into agent_briefs(tenant_id, club_id, object_type, object_id, input_hash, body, engine, facts, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning created_at`, [ctx.tenantId, clubId, type, id, hash, text, engine, JSON.stringify(sourcesOf(facts)), ctx.userId])).rows[0];
  return { text, engine, createdAt: row.created_at as string, cached: false, sources: sourcesOf(facts), note };
}

const sourcesOf = (f: Facts) => ({
  tasks: f.tasks.length, calls: f.calls.length, clientMessages: f.clientMessages.length, team: f.team.length,
  stages: f.opportunity?.stageHistory.length ?? 0, observations: f.observations.length,
});

/* ---------- маршруты ---------- */
export function agentRoutes(app: FastifyInstance, pool: pg.Pool, yandex: YandexConfig | null) {
  app.get('/api/agent/brief/:type/:id', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { type, id } = req.params as { type: string; id: string };
    const { force } = req.query as { force?: string };
    if (type !== 'task' && type !== 'opportunity') throw badRequest('Неизвестный тип');
    return withCtx(pool, ctx, (db) => situationBrief(db, ctx, yandex, type, id, force === '1'));
  });

  app.get('/api/agent/status', async (req) => {
    requirePerm(req, P.crmWork);
    return { llm: yandex ? 'YandexGPT' : null, message: yandex ? 'Сводки пишет YandexGPT' : 'YandexGPT не подключён: сводки собираются по правилам, только факты' };
  });
}
