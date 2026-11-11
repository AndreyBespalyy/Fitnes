// Утренняя сводка в Telegram (список «20 новых возможностей», п. 7): собственнику и управляющим в 8:00 по времени клуба.
// Выручка за вчера и с начала месяца против плана, продажи и продления, ушедшие, долги, неудачные автосписания, жалобы, отклонения,
// три действия на сегодня и ссылки на разделы.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireCtx } from '../auth.ts';
import { withCtx, type Db } from '../db.ts';
import { badRequest } from '../errors.ts';
import type { Fetch } from './msgProviders.ts';
import { botRow, escapeHtml, pollBot, tgSend } from './staffBot.ts';
import { decrypt } from './fiscal.ts';
import { firstName } from './messaging.ts';

const SUMMARY_ROLES = ['owner', 'gm'];
const appUrl = () => (process.env.PUBLIC_URL || 'https://app.amoglobal.ru').replace(/\/$/, '');
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const human = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const plural = (n: number, one: string, few: string, many: string) => { const a = Math.abs(n) % 100; const b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };

/** Клубы, по которым сотрудник получает сводку: собственник — все действующие, управляющий — свои */
export async function summaryClubs(db: Db, userId: string) {
  const a = (await db.query(`select club_id from user_assignments where user_id = $1 and role_code = any($2) and active_from <= current_date and (active_to is null or active_to >= current_date)`, [userId, SUMMARY_ROLES])).rows;
  if (!a.length) return [];
  const all = a.some((r) => r.club_id === null);
  return (await db.query(`select id, name, timezone from clubs where status = 'active' and not is_demo ${all ? '' : 'and id = any($1)'} order by name`, all ? [] : [a.map((r) => r.club_id)])).rows as { id: string; name: string; timezone: string }[];
}

type Stats = { name: string; dayKop: number; mtdKop: number; planKop: number | null; forecastKop: number; newSales: number; renewals: number; churned: number; ending7: number;
  debtsCount: number; debtsKop: number; autopayFailed: number; lowYesterday: number; lowOpen: number; missedResponse: number; overdueTasks: number; daysLeft: number };
/** Показатели клуба за вчерашний день (day — вчера по времени клуба) */
export async function clubStats(db: Db, club: { id: string; name: string; timezone: string }, day: string): Promise<Stats> {
  const from = `${day.slice(0, 8)}01`;
  const r = (await db.query(`
    select
      (select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) from payments where club_id = $1 and kind in ('charge', 'refund') and (created_at >= ($3::date)::date::timestamp at time zone $2 and created_at < (($3::date)::date + 1)::timestamp at time zone $2))::bigint as day,
      (select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) from payments where club_id = $1 and kind in ('charge', 'refund') and (created_at >= ($4::date)::date::timestamp at time zone $2 and created_at < (($3::date)::date + 1)::timestamp at time zone $2))::bigint as mtd,
      (select sum(amount_kop) from plan_targets where club_id = $1 and month = $4::date and user_id is null)::bigint as plan,
      (select count(*) from memberships where club_id = $1 and kind <> 'guest' and status <> 'cancelled' and renewed_from_id is null and (created_at >= ($3::date)::date::timestamp at time zone $2 and created_at < (($3::date)::date + 1)::timestamp at time zone $2))::int as "newSales",
      (select count(*) from memberships where club_id = $1 and kind <> 'guest' and status <> 'cancelled' and renewed_from_id is not null and (created_at >= ($3::date)::date::timestamp at time zone $2 and created_at < (($3::date)::date + 1)::timestamp at time zone $2))::int as renewals,
      (select count(distinct m.person_id) from memberships m where m.club_id = $1 and m.status = 'active' and m.kind in ('term', 'visits') and m.ends_on = $3::date
         and not exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = $1 and n.status = 'active' and n.id <> m.id and coalesce(n.ends_on, $3::date + 1) > $3::date))::int as churned,
      (select count(*) from memberships m where m.club_id = $1 and m.status = 'active' and m.kind = 'term' and m.ends_on between $3::date + 1 and $3::date + 8
         and not exists (select 1 from memberships n where n.renewed_from_id = m.id))::int as ending7,
      (select count(*) from charges where club_id = $1 and status = 'due' and due_on <= $3::date)::int as "debtsCount",
      (select coalesce(sum(amount_kop), 0) from charges where club_id = $1 and status = 'due' and due_on <= $3::date)::bigint as "debtsKop",
      (select count(*) from charges where club_id = $1 and status = 'due' and autopay_error is not null)::int as "autopayFailed",
      (select count(*) from surveys where club_id = $1 and task_id is not null and (answered_at >= ($3::date)::date::timestamp at time zone $2 and answered_at < (($3::date)::date + 1)::timestamp at time zone $2))::int as "lowYesterday",
      (select count(*) from surveys s join tasks t on t.id = s.task_id where s.club_id = $1 and t.done_at is null)::int as "lowOpen",
      (select count(*) from leads where club_id = $1 and first_response_at is null and first_response_due_at < now())::int as "missedResponse",
      (select count(*) from tasks where club_id = $1 and done_at is null and due_at < now())::int as "overdueTasks"`,
  [club.id, club.timezone, day, from])).rows[0];
  const dim = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
  const passed = Number(day.slice(8, 10));
  const mtd = Number(r.mtd);
  return { name: club.name, dayKop: Number(r.day), mtdKop: mtd, planKop: r.plan === null ? null : Number(r.plan), forecastKop: Math.round((mtd / passed) * dim),
    newSales: r.newSales, renewals: r.renewals, churned: r.churned, ending7: r.ending7, debtsCount: r.debtsCount, debtsKop: Number(r.debtsKop), autopayFailed: r.autopayFailed,
    lowYesterday: r.lowYesterday, lowOpen: r.lowOpen, missedResponse: r.missedResponse, overdueTasks: r.overdueTasks, daysLeft: dim - passed };
}

/** Три действия на сегодня: по важности, из того, что требует внимания */
export function actions(s: Stats) {
  const u = appUrl(); const out: string[] = [];
  const add = (text: string, tab: string) => out.push(`${text} — <a href="${u}/?tab=${tab}">открыть</a>`);
  if (s.lowOpen) add(`Перезвонить недовольным клиентам: ${s.lowOpen}`, 'tasks');
  if (s.autopayFailed) add(`Связаться с клиентами, у кого не прошло автосписание: ${s.autopayFailed}`, 'finance');
  if (s.planKop && s.forecastKop < s.planKop) {
    const need = Math.max(0, s.planKop - s.mtdKop);
    add(`Догнать план: осталось ${rub(need)}${s.daysLeft ? `, это ${rub(Math.round(need / s.daysLeft))} в день` : ''}`, 'dash');
  }
  if (s.missedResponse) add(`Ответить заявкам без первого ответа: ${s.missedResponse}`, 'leads');
  if (s.ending7) add(`Предложить продление: ${s.ending7} ${plural(s.ending7, 'клиент заканчивает', 'клиента заканчивают', 'клиентов заканчивают')} абонемент на неделе`, 'hot');
  if (s.debtsCount) add(`Обзвонить должников: ${s.debtsCount} на ${rub(s.debtsKop)}`, 'finance');
  if (s.overdueTasks) add(`Разобрать просроченные задачи: ${s.overdueTasks}`, 'tasks');
  if (s.churned) add(`Вернуть ушедших вчера: ${s.churned}`, 'retention');
  return out.slice(0, 3);
}

function sum(list: Stats[], name: string): Stats {
  const k = (f: keyof Stats) => list.reduce((a, x) => a + (Number(x[f]) || 0), 0);
  const plans = list.filter((x) => x.planKop !== null);
  return { name, dayKop: k('dayKop'), mtdKop: k('mtdKop'), planKop: plans.length ? plans.reduce((a, x) => a + x.planKop!, 0) : null, forecastKop: k('forecastKop'), newSales: k('newSales'), renewals: k('renewals'),
    churned: k('churned'), ending7: k('ending7'), debtsCount: k('debtsCount'), debtsKop: k('debtsKop'), autopayFailed: k('autopayFailed'), lowYesterday: k('lowYesterday'), lowOpen: k('lowOpen'),
    missedResponse: k('missedResponse'), overdueTasks: k('overdueTasks'), daysLeft: list[0]?.daysLeft ?? 0 };
}

/** Текст сводки (HTML Telegram) */
export function renderSummary(fullName: string, day: string, per: Stats[]) {
  const t = per.length > 1 ? sum(per, 'Все клубы') : per[0];
  const pct = t.planKop ? Math.round((t.mtdKop * 100) / t.planKop) : null;
  const L: string[] = [];
  L.push(`Доброе утро, ${escapeHtml(firstName(fullName))}! Сводка за ${human(day)}${per.length === 1 ? ` — ${escapeHtml(t.name)}` : ''}`);
  L.push('');
  L.push(`💰 <b>Выручка вчера: ${rub(t.dayKop)}</b>`);
  L.push(t.planKop ? `С начала месяца ${rub(t.mtdKop)} из ${rub(t.planKop)} (${pct} %), прогноз ${rub(t.forecastKop)} ${t.forecastKop >= t.planKop ? '✅' : '⚠️'}` : `С начала месяца ${rub(t.mtdKop)}, прогноз ${rub(t.forecastKop)} (план не задан)`);
  if (per.length > 1) for (const c of per) L.push(`   ${escapeHtml(c.name)}: ${rub(c.dayKop)} вчера${c.planKop ? `, ${Math.round((c.mtdKop * 100) / c.planKop)} % плана` : ''}`);
  L.push(`🧾 Продажи вчера: новых ${t.newSales}, продлений ${t.renewals}`);
  L.push(`🚪 Ушли вчера: ${t.churned}${t.ending7 ? ` · заканчивают на неделе без продления: ${t.ending7}` : ''}`);
  L.push(`💳 Долги: ${t.debtsCount ? `${t.debtsCount} на ${rub(t.debtsKop)}` : 'нет'}${t.autopayFailed ? ` · не прошло автосписание: ${t.autopayFailed}` : ''}`);
  L.push(`😕 Жалобы: ${t.lowYesterday ? `низких оценок вчера ${t.lowYesterday}` : 'вчера не было'}${t.lowOpen ? ` · ждут звонка ${t.lowOpen}` : ''}`);
  const dev = [t.missedResponse && `заявок без ответа ${t.missedResponse}`, t.overdueTasks && `просроченных задач ${t.overdueTasks}`].filter(Boolean);
  L.push(`🚦 Отклонения: ${dev.length ? dev.join(', ') : 'нет'}`);
  L.push('');
  const acts = actions(t);
  if (acts.length) { L.push('<b>Что сделать сегодня</b>'); acts.forEach((a, i) => L.push(`${i + 1}. ${a}`)); }
  else L.push('Всё по плану, срочного ничего нет 👍');
  L.push('');
  const u = appUrl();
  L.push(`<a href="${u}/?tab=dash">Рабочий стол</a> · <a href="${u}/?tab=finance">Финансы</a> · <a href="${u}/?tab=tasks">Задачи</a>`);
  return L.join('\n');
}

export async function buildSummary(db: Db, userId: string, day?: string) {
  const clubs = await summaryClubs(db, userId);
  if (!clubs.length) return null;
  const y = day ?? (await db.query(`select to_char((now() at time zone $1)::date - 1, 'YYYY-MM-DD') as d`, [clubs[0].timezone])).rows[0].d as string;
  const per = await Promise.all(clubs.map((c) => clubStats(db, c, y)));
  const u = (await db.query('select full_name from users where id = $1', [userId])).rows[0];
  return { day: y, text: renderSummary(u?.full_name ?? '', y, per) };
}

/** Отправка сводок тем, у кого наступил час сводки по времени их первого клуба */
export async function sendMorning(db: Db, f: Fetch, tenantId: string, force = false) {
  const b = await botRow(db);
  if (!b?.enabled || !b.token_enc || !b.summary_enabled) return 0;
  const tok = decrypt(b.token_enc);
  const people = (await db.query(`select t.user_id, t.chat_id from staff_telegram t join users u on u.id = t.user_id where t.summary and u.status = 'active'`)).rows;
  let sent = 0;
  for (const p of people) {
    const clubs = await summaryClubs(db, p.user_id);
    if (!clubs.length) continue;
    const now = (await db.query(`select to_char(now() at time zone $1, 'YYYY-MM-DD') as d, extract(hour from now() at time zone $1)::int as h`, [clubs[0].timezone])).rows[0];
    if (!force && now.h < b.summary_hour) continue;
    if ((await db.query('select 1 from morning_summaries where user_id = $1 and day = $2', [p.user_id, now.d])).rowCount) continue;
    // Опоздавшую больше чем на 4 часа сводку не шлём: в обед она уже не нужна
    if (!force && now.h > b.summary_hour + 4) continue;
    const s = await buildSummary(db, p.user_id);
    if (!s) continue;
    let err: string | null = null;
    try { await tgSend(f, tok, p.chat_id, s.text); sent++; } catch (e) { err = (e as Error).message.slice(0, 300); }
    await db.query(`insert into morning_summaries(tenant_id, user_id, day, body, status, error) values ($1,$2,$3,$4,$5,$6) on conflict (user_id, day) do nothing`,
      [tenantId, p.user_id, now.d, s.text, err ? 'failed' : 'sent', err]);
  }
  return sent;
}

export async function processStaffBot(pool: pg.Pool, f: Fetch) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    await withCtx(pool, sys, (db) => pollBot(db, f, tenantId)).catch((e) => console.error('Бот сотрудников:', (e as Error).message));
    await withCtx(pool, sys, (db) => sendMorning(db, f, tenantId)).catch((e) => console.error('Утренняя сводка:', (e as Error).message));
  }
}
export function startStaffBotWorker(pool: pg.Pool, f: Fetch = fetch, everyMs = 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processStaffBot(pool, f); } finally { busy = false; } };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

export function morningRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  app.get('/api/morning-summary/preview', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const s = await buildSummary(db, ctx.userId);
      if (!s) throw badRequest('Сводка приходит собственнику и управляющим клубов');
      return s;
    });
  });
  app.post('/api/morning-summary/send-me', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const b = await botRow(db);
      const link = (await db.query('select chat_id from staff_telegram where user_id = $1', [ctx.userId])).rows[0];
      if (!b?.token_enc || !link) throw badRequest('Сначала подключите Telegram в профиле');
      const s = await buildSummary(db, ctx.userId);
      if (!s) throw badRequest('Сводка приходит собственнику и управляющим клубов');
      try { await tgSend(opts.fetch ?? fetch, decrypt(b.token_enc), link.chat_id, s.text); } catch (e) { throw badRequest((e as Error).message); }
      return { ok: true };
    });
  });
}
