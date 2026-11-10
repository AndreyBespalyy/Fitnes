// Шаг 18, часть 3. Аналитика для руководителя и менеджера:
// недельный и месячный обзор менеджера (FR-AI-08/09, FR-AI-17), рекомендации с обратной связью (FR-AI-10, AT31),
// прогноз дефицита плана с рекомендациями не позднее 20-го (AT30), план до конкретных клиентов (AT36),
// оценка звонков по чек-листу стандарта на момент звонка (FR-AI-12, AT32).
// Честность (FR-AI-16): у каждого вывода — период, какие данные использованы и уверенность.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { aiEvaluateCall, type AiConfig } from '../lib/aiClient.ts';
import { CAT_NAME, CATS, KPI, clientsFact, funnel, kpi, lightOf, monthInfo, normFor, norms, planFact, salesFact, targets } from './dash.ts';
import { standardAt, type ChecklistItem } from './config.ts';
import { timesheet } from './staffTime.ts';

const isDate = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const isMonth = (s?: string) => /^\d{4}-\d{2}$/.test(s ?? '');
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU').replace(/,/g, ' ')} ₽`;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a * 1000) / b) / 10 : null);

async function clubToday(db: Db, clubId: string) {
  const r = (await db.query(`select to_char(now() at time zone timezone, 'YYYY-MM-DD') as d from clubs where id = $1`, [clubId])).rows[0];
  if (!r) throw notFound('Клуб не найден');
  return r.d as string;
}
function requireClub(ctx: Ctx, clubId?: string) {
  if (!clubId || !/^[0-9a-f-]{36}$/i.test(clubId)) throw badRequest('Выберите клуб');
  if (!ctx.allClubs && !ctx.clubIds.includes(clubId)) throw forbidden('Не ваш клуб');
  return clubId;
}
const leader = (ctx: Ctx) => can(ctx, P.dashView) || can(ctx, P.aiReview);
async function leadersOf(db: Db, clubId: string) {
  const rows = (await db.query(`select distinct a.user_id, a.role_code from user_assignments a join users u on u.id = a.user_id
    where a.club_id = $1 and a.role_code in ('rop', 'gm') and u.status = 'active' and (a.active_to is null or a.active_to >= current_date)`, [clubId])).rows;
  return rows.map((r) => r.user_id as string);
}
const confidenceOf = (n: number, lo: number, hi: number) => (n < lo ? 'низкая' : n < hi ? 'средняя' : 'высокая');

/* ---------- прогноз дефицита плана (AT30) и раскрытие до клиентов (AT36) ---------- */
const SCORE_KIND: Record<string, string> = { new: 'purchase', renewal: 'renewal', return: 'return', subscription: 'purchase' };

export async function deficitForecast(db: Db, clubId: string, month: string, today: string) {
  const mi = { ...monthInfo(month, today), ...(await lightOf(db, [clubId])) };
  const upto = mi.current ? today : mi.to;
  const [tg, sf, cf] = await Promise.all([targets(db, [clubId], month), salesFact(db, [clubId], mi.from, upto), clientsFact(db, [clubId], mi.from, upto)]);
  const pf = planFact(mi, tg, sf, cf, {});
  const monthEnd = mi.to;
  const rows = [];
  const recs: string[] = [];
  for (const r of pf.rows) {
    if (!r.deficitKop) { rows.push({ ...r, avgCheckKop: null, needClients: 0, hot: 0, warm: 0, ending: 0 }); continue; }
    const tAvg = tg.find((x) => x.category === r.category && x.userId === null)?.avgCheckKop ?? null;
    const hist = (await db.query(`select coalesce(sum(p.amount_kop), 0)::bigint as kop, count(distinct coalesce(ch.membership_id, p.id))::int as n
      from payments p left join charges ch on ch.id = p.charge_id
      where p.club_id = $1 and p.kind = 'charge' and p.direction = 'in' and coalesce(p.sale_category, 'new') = $2 and p.created_at > now() - interval '90 days'`, [clubId, r.category])).rows[0];
    const avg = tAvg ?? (hist.n ? Math.round(Number(hist.kop) / hist.n) : null);
    const needClients = avg ? Math.ceil(r.deficitKop / avg) : null;
    const sc = (await db.query(`select count(*) filter (where segment = 'hot')::int as hot, count(*) filter (where segment = 'warm')::int as warm
      from client_scores where club_id = $1 and kind = $2`, [clubId, SCORE_KIND[r.category]])).rows[0];
    const ending = r.category === 'renewal' ? (await db.query(`select count(distinct m.person_id)::int as n from memberships m
      where m.club_id = $1 and m.status = 'active' and m.ends_on between $2 and $3 and m.kind <> 'subscription'
        and not exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = m.club_id and n.id <> m.id and n.starts_on >= m.ends_on and n.status <> 'cancelled')`,
    [clubId, today, monthEnd])).rows[0].n : 0;
    rows.push({ ...r, avgCheckKop: avg, needClients, hot: sc.hot, warm: sc.warm, ending });
    const pool = sc.hot + sc.warm + ending;
    const per = needClients ? `≈ ${needClients} продаж${avg ? ` по ${rub(avg)}` : ''}` : 'средний чек неизвестен';
    let tip = `${r.name}: не хватит ${rub(r.deficitKop)} (${per}). `;
    if (r.category === 'renewal' && ending) tip += `До конца месяца заканчиваются абонементы у ${ending} клиентов без продления — позвоните каждому, предложите продление со скидкой за ранний выход. `;
    if (sc.hot || sc.warm) tip += `В горячем списке по категории ${sc.hot} горячих и ${sc.warm} тёплых клиентов: «Кому звонить» → категория «${r.name}». `;
    if (needClients && pool < needClients) tip += `Даже если купит каждый из списка, не хватит ${needClients - pool} клиентов: нужны новые заявки (реклама, рекомендации, возобновление бывших).`;
    else if (needClients && pool) tip += pool / needClients < 2 ? 'Чтобы закрыть дефицит, купить должны почти все из списка: подключите и новые заявки.' : `Чтобы закрыть дефицит, купить должен примерно каждый ${Math.floor(pool / needClients)}-й из списка.`;
    if (r.dayPlanKop) tip += ` Темп на каждый оставшийся день: ${rub(r.dayPlanKop)}.`;
    recs.push(tip.trim());
  }
  return {
    month, today, daysPassed: mi.passed, daysInMonth: mi.days, total: pf.total, rows, recommendations: recs,
    confidence: mi.passed < 7 ? 'низкая: прошло меньше недели' : mi.passed < 15 ? 'средняя' : 'высокая',
    basis: `Прогноз = факт за ${mi.passed} дн. ÷ ${mi.passed} × ${mi.days} дн. месяца. Средний чек — из плана, иначе по оплатам за 90 дней. Списки — из оценки клиентов ИИ и окончаний абонементов. Прогноз — не факт.`,
  };
}

/** Предупреждение руководителям о дефиците: с 10-го числа, один раз в месяц, чтобы успеть до 20-го (AT30) */
export async function checkPlanAlert(db: Db, tenantId: string, clubId: string, today: string) {
  if (Number(today.slice(8, 10)) < 10) return null;
  const month = today.slice(0, 7);
  if ((await db.query(`select 1 from plan_alerts where club_id = $1 and month = $2`, [clubId, `${month}-01`])).rowCount) return null;
  const f = await deficitForecast(db, clubId, month, today);
  if (!f.total.deficitKop || f.total.planKop === null) return null;
  const id = (await db.query(`insert into plan_alerts(tenant_id, club_id, month, deficit_kop, payload) values ($1,$2,$3,$4,$5) on conflict (club_id, month) do nothing returning id`,
    [tenantId, clubId, `${month}-01`, f.total.deficitKop, JSON.stringify({ recommendations: f.recommendations, forecastKop: f.total.forecastKop, planKop: f.total.planKop })])).rows[0]?.id;
  if (!id) return null;
  const due = new Date(Date.now() + 24 * 3600_000);
  for (const u of await leadersOf(db, clubId)) {
    await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'other',$4,$5)`,
      [tenantId, clubId, u, `Прогноз плана: не хватит ${rub(f.total.deficitKop)} (прогноз ${rub(f.total.forecastKop)} из ${rub(f.total.planKop)}). Разбор и что делать — «Обзоры» → «Прогноз плана»`, due]);
  }
  await audit(db, { tenantId, userId: null }, 'plan.deficit_alert', 'club', clubId, null, { month, deficitKop: f.total.deficitKop });
  return id as string;
}

/* ---------- обзор менеджера (FR-AI-08, 09, 17) ---------- */
type Rec = { metric: string; title: string; details: string; higherBetter: boolean; baseline: number | null; target: number | null };
export async function managerReview(db: Db, clubId: string, userId: string, from: string, to: string, today: string) {
  const u = (await db.query(`select u.id, u.full_name as name, (select r.name from user_assignments a join roles r on r.code = a.role_code where a.user_id = u.id and a.club_id = $2 order by r.sort limit 1) as role
    from users u where u.id = $1`, [userId, clubId])).rows[0];
  if (!u) throw notFound('Сотрудник не найден');
  const days = daysBetween(from, to) + 1;
  // Коллеги той же роли — для сравнения (FR-AI-17)
  const peers = (await db.query(`select distinct a.user_id from user_assignments a join users x on x.id = a.user_id
    where a.club_id = $1 and a.role_code in ('manager', 'rop') and x.status = 'active'`, [clubId])).rows.map((r) => r.user_id as string);
  const ids = [...new Set([userId, ...peers])];
  const ts = await timesheet(db, clubId, from, to, ids, today);
  const mine = ts[userId]?.totals;
  const hasSchedule = !!mine && mine.shifts > 0;
  const workDays = hasSchedule ? Math.max(1, mine!.workedShifts) : Math.max(1, Math.round(days * 5 / 7));
  const vals = await kpi(db, [clubId], from, to, ids);
  const nm = (await norms(db, [clubId]))[clubId];
  const myVals = vals.find((v) => v.userId === userId)!.values;
  const peerVals = vals.filter((v) => v.userId !== userId);
  const avgOf = (id: string) => { const xs = peerVals.map((v) => v.values[id]).filter((x): x is number => x !== null && x !== undefined); return xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10 : null; };
  const metrics = KPI.map((k) => {
    const norm = normFor(k.id, nm[k.id] ?? null, workDays);
    const value = myVals[k.id];
    const ok = norm === null || value === null ? null : k.higherIsBetter ? value >= norm : value <= norm;
    return { id: k.id, name: k.name, value, norm, peersAvg: avgOf(k.id), ok, higherIsBetter: k.higherIsBetter };
  });
  // Воронка: я и отдел
  const f = await funnel(db, [clubId], from, to, 'manager');
  const myF = f.rows.find((r) => r.userId === userId) ?? null;
  // План по категориям за месяц конца периода
  const month = to.slice(0, 7);
  const mi = { ...monthInfo(month, today), ...(await lightOf(db, [clubId])) };
  const upto = mi.current ? today : mi.to;
  const [tg, sf, cf] = await Promise.all([targets(db, [clubId], month), salesFact(db, [clubId], mi.from, upto), clientsFact(db, [clubId], mi.from, upto)]);
  const plan = planFact(mi, tg, sf, cf, { userId });
  // Качество разговоров по стандарту
  const q = (await db.query(`select count(*)::int as n, round(avg(score), 1)::float as avg from call_evaluations where club_id = $1 and user_id = $2 and (created_at at time zone 'UTC')::date between $3 and $4`,
    [clubId, userId, from, to])).rows[0];
  const weakItems = (await db.query(`select i ->> 'text' as text, count(*) filter (where (i ->> 'ok')::boolean is false)::int as missed, count(*)::int as total
    from call_evaluations e, jsonb_array_elements(e.items) i where e.club_id = $1 and e.user_id = $2 and (e.created_at at time zone 'UTC')::date between $3 and $4 and i ->> 'ok' is not null
    group by 1 having count(*) filter (where (i ->> 'ok')::boolean is false) > 0 order by 2 desc limit 3`, [clubId, userId, from, to])).rows as { text: string; missed: number; total: number }[];
  // Рабочее время и эфир (FR-AI-17)
  const air = (await db.query(`select coalesce(sum(duration_sec), 0)::int as sec, count(*)::int as n from calls where club_id = $1 and user_id = $2 and (started_at at time zone 'UTC')::date between $3 and $4`,
    [clubId, userId, from, to])).rows[0];
  const workedH = mine ? mine.workedMin / 60 : null;
  const work = {
    hasSchedule, plannedMin: mine?.plannedMin ?? 0, workedMin: mine?.workedMin ?? 0, shifts: mine?.shifts ?? 0, workedShifts: mine?.workedShifts ?? 0, lateCount: mine?.lateCount ?? 0,
    airMin: Math.round(air.sec / 60), recordedCalls: air.n,
    callsPerHour: workedH ? Math.round(((myVals.calls ?? 0) / workedH) * 10) / 10 : null,
    peersCallsPerHour: (() => { const xs = peers.filter((p) => p !== userId).map((p) => { const t = ts[p]?.totals; const v = vals.find((x) => x.userId === p)?.values.calls ?? 0; return t && t.workedMin > 0 ? v / (t.workedMin / 60) : null; }).filter((x): x is number => x !== null); return xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10 : null; })(),
  };

  // Сильные и слабые места, рекомендации
  const strengths: string[] = []; const weaknesses: string[] = []; const recs: Rec[] = [];
  for (const m of metrics) {
    if (m.value === null || m.norm === null) continue;
    if (m.ok && m.higherIsBetter && m.value > 0 && (m.peersAvg === null || m.value >= m.peersAvg)) strengths.push(`${m.name}: ${m.value} при норме ${m.norm}${m.peersAvg !== null ? `, в среднем по отделу ${m.peersAvg}` : ''}`);
    if (m.ok === false) weaknesses.push(`${m.name}: ${m.value} при норме ${m.norm}${m.peersAvg !== null ? ` (в среднем по отделу ${m.peersAvg})` : ''}`);
  }
  const mm = (id: string) => metrics.find((x) => x.id === id)!;
  // Цели рекомендаций — на неделю (5 рабочих дней): так их и проверит система
  const week = (perDay: number | null | undefined) => (perDay === null || perDay === undefined ? null : Math.round(perDay * 5));
  if (mm('calls').ok === false) recs.push({ metric: 'calls', title: `Звонков не меньше ${nm.calls ?? 0} в день`, details: `За период ${mm('calls').value} звонков при норме ${mm('calls').norm}. Начинайте день со списка «Кому звонить». Цель на неделю — ${week(nm.calls)} звонков.`, higherBetter: true, baseline: null, target: week(nm.calls) });
  if (mm('tasks_overdue').value) recs.push({ metric: 'tasks_overdue', title: 'Закрыть просроченные задачи', details: `Сейчас просрочено ${mm('tasks_overdue').value}. Просроченная задача — клиент, которому обещали перезвонить.`, higherBetter: false, baseline: mm('tasks_overdue').value, target: 0 });
  if (mm('first_response').ok === false) recs.push({ metric: 'first_response', title: `Отвечать на новую заявку за ${nm.first_response ?? 5} мин`, details: `Среднее время первого ответа ${mm('first_response').value} мин. Включите push-уведомления о новых заявках в приложении.`, higherBetter: false, baseline: mm('first_response').value, target: nm.first_response ?? 5 });
  if (myF && f.total.leads && myF.leads >= 3) {
    if (myF.meetingSetPct !== null && f.total.meetingSetPct !== null && myF.meetingSetPct + 10 < f.total.meetingSetPct) {
      weaknesses.push(`Встречи назначаются реже, чем в отделе: ${myF.meetingSetPct} % лидов против ${f.total.meetingSetPct} %`);
      recs.push({ metric: 'meetings_set', title: 'Назначать встречу в каждом разговоре', details: `Из ${myF.leads} лидов встреча назначена у ${myF.meetingSet}. В конце разговора предлагайте конкретные дату и время визита. Цель на неделю — ${week(nm.meetings_set) ?? 5} встреч.`, higherBetter: true, baseline: null, target: week(nm.meetings_set) ?? 5 });
    }
    if (myF.meetingDone >= 2 && myF.bought < myF.meetingDone * 0.3) {
      weaknesses.push(`После встречи покупают ${myF.bought} из ${myF.meetingDone}`);
      recs.push({ metric: 'sales', title: 'На встрече предлагать конкретный тариф и цену', details: `Продаж после встреч: ${myF.bought} из ${myF.meetingDone}. Завершайте встречу предложением и вопросом «Оформляем?». Цель на неделю — ${week(nm.sales) ?? 2} продаж.`, higherBetter: true, baseline: null, target: week(nm.sales) ?? 2 });
    }
    if (myF.boughtPct !== null && f.total.boughtPct !== null && myF.boughtPct >= f.total.boughtPct + 5) strengths.push(`Конверсия лида в покупку ${myF.boughtPct} % — выше среднего по отделу (${f.total.boughtPct} %)`);
  }
  const weakCat = plan.rows.filter((r) => r.deficitKop).sort((a, b) => (b.deficitKop ?? 0) - (a.deficitKop ?? 0))[0];
  if (weakCat) {
    weaknesses.push(`Категория «${weakCat.name}» проседает: прогноз ${rub(weakCat.forecastKop)} при плане ${rub(weakCat.planKop ?? 0)}`);
    const weekKop = (weakCat.dayPlanKop ?? 0) * 7;
    recs.push({ metric: `plan:${weakCat.category}`, title: `«${weakCat.name}»: ${rub(weakCat.dayPlanKop ?? 0)} в день до конца месяца`, details: `Не хватает ${rub(weakCat.deficitKop ?? 0)}. Возьмите клиентов категории из «Кому звонить». Цель на неделю — продаж на ${rub(weekKop)}.`, higherBetter: true, baseline: null, target: weekKop ? Math.round(weekKop / 100) : null });
  }
  const strongCat = plan.rows.filter((r) => r.planKop && r.percent !== null && r.light === 'green').sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
  if (strongCat) strengths.push(`Категория «${strongCat.name}» в темпе плана: ${strongCat.percent} %`);
  if (q.n && weakItems.length) {
    const w = weakItems[0];
    weaknesses.push(`Стандарт разговора: чаще всего пропускается «${w.text}» (${w.missed} из ${w.total} оценённых звонков)`);
    recs.push({ metric: 'quality', title: `В каждом разговоре: «${w.text}»`, details: `Средняя оценка разговоров ${q.avg} %. Послушайте лучшие звонки отдела по этому пункту.`, higherBetter: true, baseline: q.avg, target: Math.min(100, Math.round((q.avg ?? 0) + 10)) });
  }
  if (work.callsPerHour !== null && work.peersCallsPerHour !== null && work.callsPerHour < work.peersCallsPerHour * 0.7) weaknesses.push(`Звонков в час работы ${work.callsPerHour} — у коллег в среднем ${work.peersCallsPerHour}`);
  if (work.lateCount) weaknesses.push(`Опозданий на смену: ${work.lateCount}`);

  const activity = (myVals.calls ?? 0) + (myVals.messages ?? 0) + (myVals.meetings_set ?? 0) + (myF?.leads ?? 0);
  return {
    user: u, from, to, days, workDays, metrics, funnel: { mine: myF, dept: f.total }, plan: { month, rows: plan.rows, total: plan.total }, quality: { evaluated: q.n, avg: q.avg, weakItems },
    work, strengths, weaknesses, recommendations: recs,
    confidence: activity < 10 ? 'низкая: мало данных за период' : confidenceOf(days, 7, 28),
    basis: `Данные: задачи и звонки, сообщения, встречи, лиды, оплаты, табель${q.n ? ', оценки разговоров' : ''} за ${from.split('-').reverse().join('.')}–${to.split('-').reverse().join('.')}. Нормы — на ${workDays} ${hasSchedule ? 'отработанных смен' : 'рабочих дн.'}. Сравнение — с менеджерами и РОП клуба.`,
    enoughData: activity >= 3,
  };
}

/* ---------- рекомендации: выполнение и обратная связь (AT31) ---------- */
export async function metricValue(db: Db, clubId: string, userId: string, metric: string, from: string, to: string, today: string) {
  if (metric === 'quality') return Number((await db.query(`select avg(score)::float as v from call_evaluations where club_id = $1 and user_id = $2 and (created_at at time zone 'UTC')::date between $3 and $4`, [clubId, userId, from, to])).rows[0].v ?? 0);
  if (metric.startsWith('plan:')) {
    const cat = metric.slice(5);
    const sf = await salesFact(db, [clubId], from, to <= today ? to : today);
    return sf.filter((x) => x.userId === userId && x.category === cat && !x.recurring).reduce((a, x) => a + x.kop, 0) / 100;
  }
  if (metric === 'tasks_overdue') return Number((await db.query(`select count(*)::int as n from tasks where club_id = $1 and assignee_id = $2 and done_at is null and due_at < now()`, [clubId, userId])).rows[0].n);
  const v = (await kpi(db, [clubId], from, to, [userId]))[0]?.values[metric];
  return v ?? 0;
}

export async function evaluateDueRecommendations(db: Db, clubId: string, today: string) {
  const due = (await db.query(`select *, to_char(starts_on, 'YYYY-MM-DD') as s_on, to_char(due_on, 'YYYY-MM-DD') as d_on from recommendations where club_id = $1 and status = 'open' and due_on < $2`, [clubId, today])).rows;
  for (const r of due) {
    const v = await metricValue(db, clubId, r.user_id, r.metric, r.s_on, r.d_on, today);
    const target = r.target === null ? null : Number(r.target);
    const achieved = target === null ? r.user_mark === 'done' : r.higher_better ? v >= target : v <= target;
    await db.query(`update recommendations set result = $2, status = $3, checked_at = now() where id = $1`, [r.id, v, achieved ? 'done' : 'not_done']);
    if (!achieved && r.author_id) await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'other',$4, now() + interval '1 day')`,
      [r.tenant_id, clubId, r.author_id, `Рекомендация не выполнена: «${r.title}» — ${await nameOf(db, r.user_id)}. Результат ${fmtNum(v)}${target !== null ? ` при цели ${fmtNum(target)}` : ''}. Обсудите на встрече`]);
  }
  return due.length;
}
const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
async function nameOf(db: Db, id: string) { return (await db.query('select full_name from users where id = $1', [id])).rows[0]?.full_name ?? '—'; }

/* ---------- оценка звонков по стандарту ---------- */
type EvalItem = ChecklistItem & { ok: boolean | null; comment?: string };
export function scoreOf(items: EvalItem[]) {
  const rated = items.filter((i) => i.ok !== null);
  const w = rated.reduce((a, i) => a + i.weight, 0);
  return w ? Math.round((rated.filter((i) => i.ok).reduce((a, i) => a + i.weight, 0) / w) * 1000) / 10 : 0;
}

export async function aiEvaluateCalls(db: Db, tenantId: string, ai: AiConfig, limit = 5) {
  const calls = (await db.query(`select c.id, c.club_id, c.user_id, c.started_at, c.transcript from calls c
    where c.transcript is not null and c.asr_status = 'done' and c.started_at > now() - interval '30 days'
      and not exists (select 1 from call_evaluations e where e.call_id = c.id and e.source = 'ai') order by c.started_at desc limit $1`, [limit])).rows;
  let n = 0;
  for (const c of calls) {
    const std = await standardAt(db, c.club_id, c.started_at);
    try {
      const r = await aiEvaluateCall(ai, c.transcript, std.items.map((i) => ({ id: i.id, text: i.text })));
      const items: EvalItem[] = std.items.map((i) => { const x = r.items?.find((y) => y.id === i.id); return { ...i, ok: typeof x?.ok === 'boolean' ? x.ok : null, comment: typeof x?.quote === 'string' ? x.quote.slice(0, 300) : undefined }; });
      if (!items.some((i) => i.ok !== null)) continue;
      await db.query(`insert into call_evaluations(tenant_id, club_id, call_id, user_id, standard_id, standard_version, items, score, source, engine) values ($1,$2,$3,$4,$5,$6,$7,$8,'ai',$9)
        on conflict (call_id, source) do nothing`, [tenantId, c.club_id, c.id, c.user_id, std.id, std.versionNo, JSON.stringify(items), scoreOf(items), r.engine ?? 'ИИ-сервер']);
      n++;
    } catch { /* ИИ-сервер недоступен — попробуем в следующий раз */ }
  }
  return n;
}

/* ---------- фоновая работа ---------- */
export async function processInsights(pool: pg.Pool, ai: AiConfig | null) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    await withCtx(pool, sys, async (db) => {
      const clubs = (await db.query(`select id, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today from clubs where status = 'active'`)).rows;
      for (const c of clubs) {
        await checkPlanAlert(db, tenantId, c.id, c.today);
        await evaluateDueRecommendations(db, c.id, c.today);
      }
      if (ai) await aiEvaluateCalls(db, tenantId, ai);
    });
  }
}
export function startInsightsWorker(pool: pg.Pool, ai: AiConfig | null, everyMs = 10 * 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processInsights(pool, ai); } catch (e) { console.error('Аналитика:', (e as Error).message); } finally { busy = false; } };
  const t = setInterval(run, everyMs); t.unref();
  const first = setTimeout(run, 30_000); first.unref();
  return () => { clearInterval(t); clearTimeout(first); };
}

/* ---------- маршруты ---------- */
export function insightsRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Обзор менеджера: свой — любой продавец, чужой — РОП и руководитель
  app.get('/api/reviews', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { clubId?: string; userId?: string; period?: string; date?: string };
    const clubId = requireClub(ctx, q.clubId);
    const userId = q.userId || ctx.userId;
    if (userId !== ctx.userId && !leader(ctx)) throw forbidden('Обзор другого сотрудника видит руководитель');
    if (userId === ctx.userId && !can(ctx, P.crmWork) && !leader(ctx)) throw forbidden();
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const end = isDate(q.date) ? q.date! : today;
      const from = q.period === 'month' ? `${end.slice(0, 7)}-01` : addDays(end, -6);
      const r = await managerReview(db, clubId, userId, from, end, today);
      const open = (await db.query(`select id, title, status, due_on as "dueOn" from recommendations where club_id = $1 and user_id = $2 and status = 'open'`, [clubId, userId])).rows;
      return { ...r, period: q.period === 'month' ? 'month' : 'week', openRecommendations: open };
    });
  });

  // Сводка по отделу: светофор, отметки, рекомендации — для РОПа
  app.get('/api/reviews/team', async (req) => {
    const ctx = requireCtx(req);
    if (!leader(ctx)) throw forbidden();
    const q = req.query as { clubId?: string; period?: string };
    const clubId = requireClub(ctx, q.clubId);
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const from = q.period === 'month' ? `${today.slice(0, 7)}-01` : addDays(today, -6);
      const staff = (await db.query(`select distinct u.id, u.full_name as name from users u join user_assignments a on a.user_id = u.id
        where a.club_id = $1 and a.role_code in ('manager', 'rop') and u.status = 'active' order by 2`, [clubId])).rows;
      const rows = [];
      for (const s of staff) {
        const r = await managerReview(db, clubId, s.id, from, today, today);
        rows.push({ userId: s.id, name: s.name, weaknesses: r.weaknesses.length, strengths: r.strengths.length, suggestions: r.recommendations.length, quality: r.quality.avg,
          plan: r.plan.total.percent, light: r.plan.total.light, calls: r.metrics.find((m) => m.id === 'calls')?.value ?? 0, sales: r.metrics.find((m) => m.id === 'sales')?.value ?? 0 });
      }
      return { from, to: today, rows };
    });
  });

  app.get('/api/recommendations', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { clubId?: string; userId?: string; status?: string };
    const clubId = requireClub(ctx, q.clubId);
    const mineOnly = !leader(ctx);
    return withCtx(pool, ctx, async (db) => (await db.query(`select r.id, r.user_id as "userId", u.full_name as "userName", a.full_name as "authorName", r.origin, r.title, r.details, r.metric, r.higher_better as "higherBetter",
        r.baseline::float, r.target::float, r.result::float, to_char(r.starts_on, 'YYYY-MM-DD') as "startsOn", to_char(r.due_on, 'YYYY-MM-DD') as "dueOn", r.status,
        r.user_mark as "userMark", r.user_comment as "userComment", r.user_marked_at as "userMarkedAt", r.checked_at as "checkedAt", r.created_at as "createdAt"
      from recommendations r join users u on u.id = r.user_id left join users a on a.id = r.author_id
      where r.club_id = $1 and ($2::uuid is null or r.user_id = $2) and ($3::text is null or r.status = $3) order by (r.status = 'open') desc, r.due_on desc limit 300`,
    [clubId, mineOnly ? ctx.userId : q.userId || null, q.status || null])).rows);
  });

  // РОП назначает рекомендацию (свою или предложенную обзором)
  app.post('/api/recommendations', async (req, reply) => {
    const ctx = requireCtx(req);
    if (!leader(ctx)) throw forbidden('Рекомендации назначает руководитель');
    const b = (req.body ?? {}) as { clubId?: string; userId?: string; title?: string; details?: string; metric?: string; higherBetter?: boolean; target?: number | null; days?: number; origin?: string };
    const clubId = requireClub(ctx, b.clubId);
    if (!b.title?.trim()) throw badRequest('Сформулируйте рекомендацию');
    const metric = b.metric ?? '';
    if (!(KPI.some((k) => k.id === metric) || metric === 'quality' || (metric.startsWith('plan:') && (CATS as readonly string[]).includes(metric.slice(5))))) throw badRequest('Выберите показатель, по которому проверить результат');
    const days = Math.max(1, Math.min(31, Math.floor(b.days ?? 7)));
    const r = await withCtx(pool, ctx, async (db) => {
      const ok = (await db.query(`select 1 from user_assignments where user_id = $1 and club_id = $2`, [b.userId, clubId])).rowCount;
      if (!ok) throw badRequest('Сотрудник не работает в этом клубе');
      const today = await clubToday(db, clubId);
      const due = addDays(today, days - 1);
      const baseline = await metricValue(db, clubId, b.userId!, metric, addDays(today, -days), addDays(today, -1), today);
      const id = (await db.query(`insert into recommendations(tenant_id, club_id, user_id, author_id, origin, title, details, metric, higher_better, baseline, target, starts_on, due_on)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [ctx.tenantId, clubId, b.userId, ctx.userId, b.origin === 'ai' ? 'ai' : 'rop', b.title!.trim().slice(0, 300), b.details?.trim().slice(0, 1000) || null, metric, b.higherBetter !== false,
        baseline, b.target ?? null, today, due])).rows[0].id;
      await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, created_by) values ($1,$2,$3,'other',$4, ($5::date + interval '1 day' - interval '1 minute'), $6)`,
        [ctx.tenantId, clubId, b.userId, `Рекомендация до ${due.split('-').reverse().join('.')}: ${b.title!.trim()}`, due, ctx.userId]);
      await audit(db, ctx, 'recommendation.created', 'recommendation', id, null, { userId: b.userId, metric, target: b.target, due });
      return { id, dueOn: due, baseline };
    });
    reply.code(201);
    return r;
  });

  // Сотрудник отмечает: сделал или не получилось — с комментарием
  app.post('/api/recommendations/:id/mark', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { mark?: string; comment?: string };
    if (b.mark !== 'done' && b.mark !== 'failed') throw badRequest('Сделано или не получилось?');
    if (b.mark === 'failed' && !b.comment?.trim()) throw badRequest('Напишите, что помешало: руководитель увидит это в отчёте');
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query('select * from recommendations where id = $1', [(req.params as { id: string }).id])).rows[0];
      if (!r) throw notFound('Рекомендация не найдена');
      if (r.user_id !== ctx.userId) throw forbidden('Отметить может только тот, кому дана рекомендация');
      await db.query(`update recommendations set user_mark = $2, user_comment = $3, user_marked_at = now() where id = $1`, [r.id, b.mark, b.comment?.trim() || null]);
      await audit(db, ctx, 'recommendation.marked', 'recommendation', r.id, null, { mark: b.mark });
      return { ok: true };
    });
  });

  app.post('/api/recommendations/:id/cancel', async (req) => {
    const ctx = requireCtx(req);
    if (!leader(ctx)) throw forbidden();
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query(`update recommendations set status = 'cancelled' where id = $1 and status = 'open' returning id`, [(req.params as { id: string }).id])).rows[0];
      if (!r) throw notFound('Открытая рекомендация не найдена');
      await audit(db, ctx, 'recommendation.cancelled', 'recommendation', r.id, null, null);
      return { ok: true };
    });
  });

  // Прогноз плана и что делать (AT30)
  app.get('/api/plan/forecast', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.dashView) && !can(ctx, P.planManage)) throw forbidden();
    const q = req.query as { clubId?: string; month?: string };
    const clubId = requireClub(ctx, q.clubId);
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const month = isMonth(q.month) ? q.month! : today.slice(0, 7);
      const f = await deficitForecast(db, clubId, month, today);
      const alert = (await db.query(`select created_at as "createdAt", deficit_kop::bigint as "deficitKop" from plan_alerts where club_id = $1 and month = $2`, [clubId, `${month}-01`])).rows[0] ?? null;
      return { ...f, alert: alert && { ...alert, deficitKop: Number(alert.deficitKop) } };
    });
  });

  // Цифра плана до клиентов (AT36): чьи оплаты дали факт и кто может закрыть дефицит
  app.get('/api/plan/drill', async (req) => {
    const ctx = requireCtx(req);
    const q = req.query as { clubId?: string; month?: string; category?: string; userId?: string };
    const clubId = requireClub(ctx, q.clubId);
    const own = !can(ctx, P.dashView);
    if (own && !can(ctx, P.crmWork)) throw forbidden();
    const userId = own ? ctx.userId : q.userId || null;
    const category = q.category && (CATS as readonly string[]).includes(q.category) ? q.category : null;
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const month = isMonth(q.month) ? q.month! : today.slice(0, 7);
      const mi = monthInfo(month, today);
      const sales = (await db.query(`
        select p.id, to_char(p.created_at at time zone c.timezone, 'YYYY-MM-DD HH24:MI') as at, p.person_id as "personId", coalesce(pp.full_name, '—') as person,
          m.product_name as product, coalesce(p.sale_category, 'new') as category, coalesce(u.full_name, '—') as seller,
          (case when p.direction = 'in' then p.amount_kop else -p.amount_kop end)::bigint as kop, p.kind
        from payments p join clubs c on c.id = p.club_id
          left join charges ch on ch.id = p.charge_id left join refunds r on r.id = p.refund_id
          left join memberships m on m.id = coalesce(ch.membership_id, r.membership_id)
          left join users u on u.id = m.created_by left join persons pp on pp.id = p.person_id
        where p.kind in ('charge', 'refund') and p.club_id = $1 and (p.created_at at time zone c.timezone)::date between $2 and $3
          and ($4::uuid is null or m.created_by = $4) and ($5::text is null or coalesce(p.sale_category, 'new') = $5)
        order by p.created_at desc limit 1000`, [clubId, mi.from, mi.current ? today : mi.to, userId, category])).rows
        .map((r) => ({ ...r, amountKop: Number(r.kop), categoryName: CAT_NAME[r.category] ?? r.category }));
      const kinds = category ? [SCORE_KIND[category]] : ['purchase', 'renewal', 'return'];
      const candidates = (await db.query(`select s.person_id as "personId", p.full_name as name, s.kind, s.segment, round(s.score * 100)::int as score, s.offer, o.full_name as owner
        from client_scores s join persons p on p.id = s.person_id left join users o on o.id = s.owner_id
        where s.club_id = $1 and s.kind = any($2) and s.segment in ('hot', 'warm') and ($3::uuid is null or s.owner_id = $3 or s.owner_id is null)
        order by s.score desc limit 30`, [clubId, kinds, userId])).rows;
      return { month, category, categoryName: category ? CAT_NAME[category] : 'Все категории', sales, totalKop: sales.reduce((a, s) => a + s.amountKop, 0),
        clients: new Set(sales.map((s) => s.personId).filter(Boolean)).size, candidates };
    });
  });

  /* --- оценка звонков по стандарту --- */
  app.get('/api/calls/:id/evaluation', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select id, club_id, user_id, started_at from calls where id = $1', [(req.params as { id: string }).id])).rows[0];
      if (!c) throw notFound('Звонок не найден');
      if (c.user_id !== ctx.userId && !can(ctx, P.aiReview)) throw forbidden();
      const std = await standardAt(db, c.club_id, c.started_at);
      const ev = (await db.query(`select e.source, e.items, e.score::float, e.standard_version as "standardVersion", e.engine, e.comment, u.full_name as "by", e.updated_at as "at"
        from call_evaluations e left join users u on u.id = e.evaluated_by where e.call_id = $1 order by e.source`, [c.id])).rows;
      return { standard: { versionNo: std.versionNo, items: std.items }, evaluations: ev, canEvaluate: can(ctx, P.aiReview) };
    });
  });

  app.post('/api/calls/:id/evaluation', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.aiReview)) throw forbidden('Оценивает РОП или управляющий');
    const b = (req.body ?? {}) as { items?: { id: string; ok: boolean | null; comment?: string }[]; comment?: string };
    if (!Array.isArray(b.items)) throw badRequest('Отметьте пункты чек-листа');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select id, club_id, user_id, started_at from calls where id = $1', [(req.params as { id: string }).id])).rows[0];
      if (!c) throw notFound('Звонок не найден');
      // Существующая оценка остаётся по своей версии стандарта, даже если стандарт уже поменяли
      const prev = (await db.query(`select standard_id, standard_version, items from call_evaluations where call_id = $1 and source = 'rop'`, [c.id])).rows[0];
      const std = prev ? { id: prev.standard_id, versionNo: prev.standard_version, items: (prev.items as EvalItem[]).map(({ id, text, weight }) => ({ id, text, weight })) } : await standardAt(db, c.club_id, c.started_at);
      const items: EvalItem[] = std.items.map((i) => { const x = b.items!.find((y) => y.id === i.id); return { ...i, ok: typeof x?.ok === 'boolean' ? x.ok : null, comment: x?.comment?.trim().slice(0, 300) || undefined }; });
      if (!items.some((i) => i.ok !== null)) throw badRequest('Отметьте хотя бы один пункт');
      const score = scoreOf(items);
      await db.query(`insert into call_evaluations(tenant_id, club_id, call_id, user_id, standard_id, standard_version, items, score, source, evaluated_by, comment)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'rop',$9,$10)
        on conflict (call_id, source) do update set items = excluded.items, score = excluded.score, evaluated_by = excluded.evaluated_by, comment = excluded.comment`,
      [ctx.tenantId, c.club_id, c.id, c.user_id, std.id, std.versionNo, JSON.stringify(items), score, ctx.userId, b.comment?.trim() || null]);
      await audit(db, ctx, 'call.evaluated', 'call', c.id, null, { score, standardVersion: std.versionNo });
      return { score, standardVersion: std.versionNo };
    });
  });

  // Речевая аналитика по отделу: средняя оценка, слабые пункты, лучшие звонки (бенчмаркинг)
  app.get('/api/quality', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.aiReview)) throw forbidden();
    const q = req.query as { clubId?: string; from?: string; to?: string };
    const clubId = requireClub(ctx, q.clubId);
    return withCtx(pool, ctx, async (db) => {
      const today = await clubToday(db, clubId);
      const from = isDate(q.from) ? q.from! : addDays(today, -29); const to = isDate(q.to) ? q.to! : today;
      const byUser = (await db.query(`select e.user_id as "userId", coalesce(u.full_name, '—') as name, count(*)::int as n, round(avg(e.score), 1)::float as avg
        from call_evaluations e left join users u on u.id = e.user_id where e.club_id = $1 and (e.created_at at time zone 'UTC')::date between $2 and $3 group by 1, 2 order by 4 desc`, [clubId, from, to])).rows;
      const items = (await db.query(`select i ->> 'text' as text, count(*)::int as total, count(*) filter (where (i ->> 'ok')::boolean)::int as ok
        from call_evaluations e, jsonb_array_elements(e.items) i where e.club_id = $1 and (e.created_at at time zone 'UTC')::date between $2 and $3 and i ->> 'ok' is not null
        group by 1 order by (count(*) filter (where (i ->> 'ok')::boolean))::float / count(*)`, [clubId, from, to])).rows.map((r) => ({ ...r, pct: pct(r.ok, r.total) }));
      const best = (await db.query(`select e.call_id as "callId", e.score::float, e.source, c.started_at as "startedAt", coalesce(u.full_name, '—') as "userName", e.standard_version as "standardVersion"
        from call_evaluations e join calls c on c.id = e.call_id left join users u on u.id = e.user_id
        where e.club_id = $1 and (e.created_at at time zone 'UTC')::date between $2 and $3 order by e.score desc, c.duration_sec desc nulls last limit 5`, [clubId, from, to])).rows;
      const suggestions = items.filter((i) => i.total >= 3 && (i.pct ?? 100) < 50).map((i) => `«${i.text}» выполняется только в ${i.pct} % оценённых звонков. Разберите на планёрке лучшие звонки по этому пункту; если пункт не подходит клубу — поменяйте формулировку в «Настройки клуба» → «Стандарт продаж».`);
      return { from, to, byUser, items, best, suggestions };
    });
  });
}
