// Шаг 15. ИИ-функции продаж: горячие списки (FR-AI-06), план дня менеджера (FR-AI-07), расчётный план продаж,
// маршрутизация неприоритетных в автосообщения (FR-AI-05), «теневой режим» для приёмки.
// Всё — рекомендации с основанием, периодом и уверенностью (FR-AI-16); цены берутся из действующего прейскуранта, ИИ их не меняет.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { maskPhone } from './crm.ts';
import { CATS, CAT_NAME, funnel, monthInfo, salesFact, widgetData } from './dash.ts';
import { addDays, clubToday } from './memberships.ts';
import { KIND_NAME, scoreClub, trainClub, type Kind } from './scoring.ts';

const KINDS: Kind[] = ['purchase', 'renewal', 'return', 'churn'];
const onlyMine = (ctx: Ctx) => !can(ctx, P.crmViewAll);
const rub = (kop: number) => `${new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100))} ₽`;

/* ---------- фоновый пересчёт ---------- */
export async function processScoring(pool: pg.Pool) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select c.id, (select trained_at from ai_models m where m.club_id = c.id and m.kind = 'purchase') as trained
      from clubs c where c.status = 'active'`)).rows);
    for (const c of clubs) {
      await withCtx(pool, sys, async (db) => {
        if (!c.trained || Date.now() - new Date(c.trained).getTime() > 20 * 3600_000) await trainClub(db, tenantId, c.id);
        await scoreClub(db, tenantId, c.id);
      }).catch((e) => console.error('Оценка клиентов:', (e as Error).message));
    }
  }
}
export function startScoringWorker(pool: pg.Pool, everyMs = 15 * 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processScoring(pool); } catch (e) { console.error('Ошибка оценки:', (e as Error).message); } finally { busy = false; } };
  const first = setTimeout(run, 20_000); first.unref();
  const t = setInterval(run, everyMs); t.unref();
  return () => { clearTimeout(first); clearInterval(t); };
}

/* ---------- горячий список ---------- */
const LIST_SELECT = `select s.person_id as "personId", p.full_name as "personName", s.kind, s.score::float, s.segment, s.owner_id as "ownerId", u.full_name as "ownerName",
  s.opportunity_id as "opportunityId", s.reasons, s.offer, s.model, s.computed_at as "computedAt", s.club_id as "clubId",
  (select normalized_value from person_contacts pc where pc.person_id = s.person_id and pc.type = 'phone' order by is_primary desc limit 1) as phone,
  (select max(t.due_at) from tasks t where t.person_id = s.person_id and t.done_at is null) as "nextTaskAt",
  greatest((select max(t.done_at) from tasks t where t.person_id = s.person_id), (select max(c.started_at) from calls c where c.person_id = s.person_id)) as "lastContactAt"
  from client_scores s join persons p on p.id = s.person_id left join users u on u.id = s.owner_id`;

async function hotList(db: Db, ctx: Ctx, q: { clubId?: string; kind?: string; segment?: string; mine?: boolean; userId?: string; limit?: number }) {
  const segs = q.segment === 'all' ? ['hot', 'warm', 'auto', 'low', 'excluded'] : q.segment ? [q.segment] : ['hot', 'warm'];
  const mine = onlyMine(ctx) || q.mine;
  const rows = (await db.query(
    `${LIST_SELECT} where ($1::uuid is null or s.club_id = $1) and ($2::text is null or s.kind = $2) and s.segment = any($3)
       and ($4::uuid is null or s.owner_id = $4 or s.owner_id is null)
     order by (s.segment = 'hot') desc, s.score desc limit $5`,
    [q.clubId || null, q.kind && KINDS.includes(q.kind as Kind) ? q.kind : null, segs, mine ? q.userId ?? ctx.userId : null, q.limit ?? 200])).rows;
  return rows.map((r) => ({ ...r, phone: maskPhone(r.phone), kindName: KIND_NAME[r.kind as Kind], priority: Math.round(r.score * 100) }));
}

/* ---------- план дня ---------- */
async function dayPlan(db: Db, ctx: Ctx, clubId: string) {
  const today = await clubToday(db, clubId);
  const my = await widgetData(db, ctx, 'my_plan', { clubId }) as unknown as { rows: { category: string; name: string; planKop: number | null; planClients: number | null; dayPlanKop: number | null; factKop: number }[]; total: { dayPlanKop: number | null; planKop: number | null; factKop: number } };
  const from = addDays(today, -60);
  const mineF = (await funnel(db, [clubId], from, today, 'manager', ctx.userId)).total;
  const clubF = (await funnel(db, [clubId], from, today, 'manager')).total;
  const own = mineF.leads >= 20 && mineF.bought >= 3;
  const f = own ? mineF : clubF;
  const avg = (await db.query(`select coalesce(sale_category, 'new') as c, avg(amount_kop)::float as a from memberships where club_id = $1 and kind <> 'guest' and status <> 'cancelled'
    and created_at > now() - interval '90 days' group by 1`, [clubId])).rows;
  const needs = my.rows.filter((r) => r.dayPlanKop && r.dayPlanKop > 0).map((r) => {
    const check = r.planKop && r.planClients ? r.planKop / r.planClients : avg.find((a) => a.c === r.category)?.a ?? null;
    return { category: r.category, name: r.name, needKop: r.dayPlanKop!, clients: check ? Math.max(1, Math.round(r.dayPlanKop! / check)) : null };
  });
  const clients = needs.reduce((a, n) => a + (n.clients ?? 0), 0);
  const perSale = { calls: f.bought ? f.contacted / f.bought : null, meetings: f.bought ? f.meetingDone / f.bought : null };
  const targets = clients ? { calls: perSale.calls ? Math.ceil(clients * perSale.calls * 3) : null, meetings: perSale.meetings ? Math.ceil(clients * perSale.meetings) : null } : { calls: null, meetings: null };
  const tasks = (await db.query(`select count(*) filter (where due_at < now())::int as overdue,
      count(*) filter (where due_at >= now() and (due_at at time zone (select timezone from clubs where id = $1))::date = $3::date)::int as today,
      count(*) filter (where call_id is not null)::int as reviews
    from tasks where club_id = $1 and assignee_id = $2 and done_at is null`, [clubId, ctx.userId, today])).rows[0];
  const meetings = (await db.query(`select m.scheduled_at as at, p.full_name as name from meetings m join persons p on p.id = m.person_id join clubs c on c.id = m.club_id
    where m.club_id = $1 and m.created_by = $2 and m.status = 'scheduled' and (m.scheduled_at >= ($3::date)::date::timestamp at time zone c.timezone and m.scheduled_at < (($3::date)::date + 1)::timestamp at time zone c.timezone) order by m.scheduled_at`, [clubId, ctx.userId, today])).rows;
  const list = await hotList(db, ctx, { clubId, mine: true, limit: 40 });
  const callFirst = list.filter((r) => r.segment === 'hot').slice(0, 10);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, list.filter((r) => r.kind === k).length]));
  // Распределение дня: рабочие часы клуба, звонок ≈ 7 минут с подготовкой и итогом
  const s = (await db.query(`select work_from, work_to from club_msg_settings where club_id = $1`, [clubId])).rows[0] ?? { work_from: 9, work_to: 21 };
  const nowH = Number((await db.query(`select extract(hour from now() at time zone timezone) + extract(minute from now() at time zone timezone) / 60 as h from clubs where id = $1`, [clubId])).rows[0].h);
  let t = Math.max(s.work_from, Math.ceil(nowH * 4) / 4);
  const hm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const blocks: { from: string; to: string; title: string; detail: string }[] = [];
  const add = (hours: number, title: string, detail: string) => { if (hours <= 0 || t >= s.work_to) return; const end = Math.min(s.work_to, t + hours); blocks.push({ from: hm(t), to: hm(end), title, detail }); t = end; };
  if (tasks.overdue || tasks.reviews) add(0.5, 'Просроченные задачи и итоги звонков', `просрочено задач: ${tasks.overdue}, итогов на проверку: ${tasks.reviews}`);
  if (callFirst.length) add(Math.max(0.5, (callFirst.length * 7) / 60), 'Звонки горячим клиентам', `${callFirst.length} клиентов из списка «Звонить первым»`);
  const renew = list.filter((r) => r.kind === 'renewal' || r.kind === 'churn').length;
  if (renew) add(Math.max(0.5, (Math.min(renew, 12) * 6) / 60), 'Продления и удержание', `${renew} клиентов: заканчивается абонемент или перестали ходить`);
  if (meetings.length) blocks.push({ from: '', to: '', title: 'Встречи в клубе', detail: meetings.map((m) => `${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(m.at)} ${m.name}`).join(', ') });
  const warm = list.filter((r) => r.segment === 'warm').length;
  if (warm) add(Math.max(0.5, (Math.min(warm, 15) * 7) / 60), 'Тёплые клиенты и возвраты', `${warm} клиентов: вечером дозвониться проще`);
  const basis = [
    my.total.planKop ? `личный план месяца ${rub(my.total.planKop)}, факт ${rub(my.total.factKop)}` : 'личный план на месяц не задан',
    `конверсия ${own ? 'ваших' : 'клуба'} лидов за 60 дней: ${f.leads} лидов, ${f.bought} покупок`,
    `оценка клиентов: ${list[0]?.model ?? 'ещё не рассчитана'}`,
  ];
  const confidence = !my.total.planKop || f.leads < 20 ? 'низкая' : f.bought < 10 ? 'средняя' : 'высокая';
  return { date: today, needs, needKop: my.total.dayPlanKop, clients, targets, perSale, tasks, meetings, callFirst, byKind, blocks, basis, confidence, own };
}

/* ---------- расчётный план продаж ---------- */
async function planSuggestion(db: Db, clubId: string, month: string) {
  const today = await clubToday(db, clubId);
  const club = (await db.query(`select sales_model from clubs where id = $1`, [clubId])).rows[0];
  const months: string[] = [];
  for (let i = 1; i <= 3; i++) { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); months.push(d.toISOString().slice(0, 7)); }
  const hist: Record<string, number[]> = Object.fromEntries(CATS.map((c) => [c, []]));
  let monthsWithData = 0;
  for (const m of months) {
    const mi = monthInfo(m, today);
    if (mi.passed < mi.days) continue; // только полные прошедшие месяцы
    const sf = await salesFact(db, [clubId], mi.from, mi.to);
    if (sf.length) monthsWithData++;
    for (const c of CATS) hist[c].push(sf.filter((x) => x.category === c).reduce((a, x) => a + x.kop, 0));
  }
  const avgCheck = Object.fromEntries((await db.query(`select coalesce(sale_category, 'new') as c, avg(amount_kop)::float as a from memberships where club_id = $1 and kind <> 'guest' and status <> 'cancelled' and created_at > now() - interval '180 days' group by 1`, [clubId])).rows.map((r) => [r.c, r.a as number]));
  const sc = (await db.query(`select kind, count(*)::int as n, coalesce(sum(score), 0)::float as s from client_scores where club_id = $1 and segment <> 'excluded' group by 1`, [clubId])).rows;
  const sum = (k: string) => sc.find((x) => x.kind === k) ?? { n: 0, s: 0 };
  const mi = monthInfo(month, today);
  const ending = (await db.query(`select count(*)::int as n from memberships where club_id = $1 and kind in ('term', 'visits') and status = 'active' and ends_on between $2 and $3`, [clubId, mi.from, mi.to])).rows[0].n;
  const renewRate = (await db.query(`select count(*) filter (where exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = m.club_id and n.id <> m.id and n.created_at >= m.ends_on - 30))::float / nullif(count(*), 0) as r
    from memberships m where m.club_id = $1 and m.kind in ('term', 'visits') and m.ends_on between $2::date - 90 and $2::date`, [clubId, today])).rows[0].r as number | null;
  const subs = (await db.query(`select coalesce(sum(amount_kop), 0)::float as s, count(*)::int as n from memberships where club_id = $1 and kind = 'subscription' and status = 'active'`, [clubId])).rows[0];
  const round = (kop: number) => Math.round(kop / 1_000_000) * 1_000_000; // до 10 000 ₽
  const cats = (club.sales_model === 'subscription' ? ['subscription', 'new'] : ['new', 'renewal', 'return']) as string[];
  const rows = cats.map((c) => {
    const h = hist[c].filter((v) => v > 0);
    const hAvg = h.length ? h.reduce((a, v) => a + v, 0) / h.length : null;
    let pipe: number | null = null; let pipeText = '';
    const check = avgCheck[c] ?? null;
    if (c === 'new' && check) { const p = sum('purchase'); pipe = p.s * check * 0.6; pipeText = `${p.n} лидов в работе, ожидаемо купят ≈${Math.round(p.s * 0.6)} (с учётом новых заявок), средний чек ${rub(check)}`; }
    if (c === 'renewal' && check) { const r = renewRate ?? 0.5; pipe = ending * r * check; pipeText = `заканчивается абонементов: ${ending}, продлевают ${Math.round(r * 100)} %, средний чек ${rub(check)}`; }
    if (c === 'return' && check) { const p = sum('return'); pipe = p.s * check; pipeText = `бывших клиентов в базе: ${p.n}, ожидаемо вернутся ≈${Math.round(p.s)}`; }
    if (c === 'subscription') { pipe = Number(subs.s); pipeText = `действующих подписок: ${subs.n} на ${rub(Number(subs.s))} в месяц`; }
    const parts = [hAvg, pipe].filter((v): v is number => v !== null && v > 0);
    const suggested = parts.length ? round(parts.reduce((a, v) => a + v, 0) / parts.length) : null;
    const basis = [hAvg !== null ? `в среднем за ${h.length} полных мес.: ${rub(hAvg)}` : 'истории продаж за полные месяцы нет', pipe !== null && pipe > 0 ? `${pipeText} → ${rub(pipe)}` : pipeText, parts.length > 1 ? 'итог — среднее двух оценок' : ''].filter(Boolean);
    return { category: c, name: CAT_NAME[c], suggestedKop: suggested, historyKop: hAvg === null ? null : Math.round(hAvg), pipelineKop: pipe === null ? null : Math.round(pipe), avgCheckKop: check ? Math.round(check / 10_000) * 10_000 : null, basis };
  });
  return { month, rows, confidence: monthsWithData >= 3 ? 'средняя' : 'низкая', note: 'Расчёт ИИ — ориентир, а не факт: план утверждает собственник или управляющий.' };
}

/* ---------- теневой режим ---------- */
async function shadow(db: Db, clubId: string | null, from: string, to: string) {
  const args = [clubId, from, to];
  const days = (await db.query(`select count(distinct day)::int as n, min(day)::text as first from ai_score_history where ($1::uuid is null or club_id = $1) and day between $2 and $3`, args)).rows[0];
  // Кто купил за период и был ли он в горячем или тёплом списке в течение 14 дней до покупки
  const bought = (await db.query(
    `with b as (
       select distinct on (m.person_id, m.club_id) m.person_id, m.club_id, (m.created_at at time zone c.timezone)::date as d, coalesce(m.sale_category, 'new') as cat
       from memberships m join clubs c on c.id = m.club_id
       where ($1::uuid is null or m.club_id = $1) and m.kind <> 'guest' and m.status <> 'cancelled' and m.import_batch_id is null
         and (m.created_at >= ($2)::date::timestamp at time zone c.timezone and m.created_at < (($3)::date + 1)::timestamp at time zone c.timezone)
       order by m.person_id, m.club_id, m.created_at)
     select b.cat,
       count(*)::int as bought,
       count(*) filter (where exists (select 1 from ai_score_history h where h.person_id = b.person_id and h.club_id = b.club_id and h.day between b.d - 14 and b.d))::int as scored,
       count(*) filter (where exists (select 1 from ai_score_history h where h.person_id = b.person_id and h.club_id = b.club_id and h.day between b.d - 14 and b.d and h.segment in ('hot', 'warm')))::int as listed,
       count(*) filter (where exists (select 1 from ai_score_history h where h.person_id = b.person_id and h.club_id = b.club_id and h.day between b.d - 14 and b.d and h.segment = 'hot'))::int as hot
     from b group by 1`, args)).rows;
  // Конверсия горячих против всех оценённых: первая оценка клиента в периоде → купил ли в течение 14 дней
  const lift = (await db.query(
    `with f as (
       select distinct on (h.person_id, h.club_id, h.kind) h.person_id, h.club_id, h.kind, h.day, h.segment
       from ai_score_history h where ($1::uuid is null or h.club_id = $1) and h.day between $2 and $3 and h.kind in ('purchase', 'return') and h.segment <> 'excluded'
       order by h.person_id, h.club_id, h.kind, h.day),
     o as (select f.*, exists (select 1 from memberships m join clubs c on c.id = m.club_id where m.person_id = f.person_id and m.club_id = f.club_id and m.kind <> 'guest'
             and m.status <> 'cancelled' and (m.created_at >= (f.day)::date::timestamp at time zone c.timezone and m.created_at < ((f.day + 14)::date + 1)::timestamp at time zone c.timezone)) as won,
           exists (select 1 from tasks t where t.person_id = f.person_id and t.done_at::date between f.day and f.day + 2)
             or exists (select 1 from calls c where c.person_id = f.person_id and c.started_at::date between f.day and f.day + 2) as contacted
           from f)
     select segment, count(*)::int as n, count(*) filter (where won)::int as won, count(*) filter (where contacted)::int as contacted from o group by 1`, args)).rows;
  const tot = lift.reduce((a, r) => ({ n: a.n + r.n, won: a.won + r.won }), { n: 0, won: 0 });
  const hot = lift.find((r) => r.segment === 'hot') ?? { n: 0, won: 0, contacted: 0 };
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const hotRate = rate(hot.won, hot.n); const allRate = rate(tot.won, tot.n);
  const b = bought.reduce((a, r) => ({ bought: a.bought + r.bought, scored: a.scored + r.scored, listed: a.listed + r.listed, hot: a.hot + r.hot }), { bought: 0, scored: 0, listed: 0, hot: 0 });
  return {
    days: days.n, firstDay: days.first, enough: days.n >= 14,
    buyers: { ...b, listedPct: rate(b.listed, b.scored), hotPct: rate(b.hot, b.scored), byCategory: bought.map((r) => ({ ...r, name: CAT_NAME[r.cat] ?? r.cat, listedPct: rate(r.listed, r.scored) })) },
    lift: { hotRate, allRate, x: hotRate !== null && allRate ? Math.round((hotRate / allRate) * 10) / 10 : null, target: 2, segments: lift.map((r) => ({ ...r, rate: rate(r.won, r.n), contactedPct: rate(r.contacted, r.n) })) },
  };
}

/* ---------- маршруты ---------- */
export function aiSalesRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/ai/hot-list', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const q = req.query as { clubId?: string; kind?: string; segment?: string; mine?: string };
    const t0 = Date.now();
    return withCtx(pool, ctx, async (db) => {
      const rows = await hotList(db, ctx, { clubId: q.clubId, kind: q.kind, segment: q.segment, mine: q.mine === '1' });
      const models = (await db.query(`select club_id as "clubId", version, metrics, trained_at as "trainedAt" from ai_models where ($1::uuid is null or club_id = $1)`, [q.clubId || null])).rows;
      return { rows, models, ms: Date.now() - t0, computedAt: rows[0]?.computedAt ?? null };
    });
  });

  // «Взять в работу»: задача на звонок сегодня; если сделка ничья — менеджер становится ответственным
  app.post('/api/ai/hot-list/take', async (req, reply) => {
    const ctx = requirePerm(req, P.crmWork);
    const b = (req.body ?? {}) as { clubId?: string; personId?: string; kind?: string };
    const id = await withCtx(pool, ctx, async (db) => {
      const s = (await db.query(`select * from client_scores where club_id = $1 and person_id = $2 and kind = $3`, [b.clubId ?? null, b.personId ?? null, b.kind ?? null])).rows[0];
      if (!s || (onlyMine(ctx) && s.owner_id && s.owner_id !== ctx.userId)) throw notFound('Клиента нет в вашем списке');
      if (s.segment === 'excluded') throw badRequest('Клиент исключён из обзвона: он отказался');
      const o = s.opportunity_id ? (await db.query(`select id, owner_id, status from opportunities where id = $1`, [s.opportunity_id])).rows[0] : null;
      if (o?.status === 'open' && !o.owner_id) await db.query(`update opportunities set owner_id = $2, updated_at = now() where id = $1`, [o.id, ctx.userId]);
      const title: Record<string, string> = { purchase: 'Позвонить: горячий клиент', renewal: 'Предложить продление', return: 'Пригласить вернуться', churn: 'Удержание: узнать, почему не ходит' };
      const offer = s.offer?.text ? `. ${s.offer.text}` : '';
      const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, opportunity_id, kind, title, due_at, created_by)
        values ($1,$2,$3,$4,$5,'call',$6, now() + interval '1 hour', $3) returning id`,
      [ctx.tenantId, s.club_id, ctx.userId, s.person_id, o?.status === 'open' ? o.id : null, `${title[s.kind]} (ИИ)${offer}`.slice(0, 300)])).rows[0].id;
      await audit(db, ctx, 'ai.recommendation_taken', 'person', s.person_id, null, { kind: s.kind, score: Number(s.score), segment: s.segment, model: s.model, taskId: tid });
      return tid;
    });
    reply.code(201);
    return { taskId: id };
  });

  app.post('/api/ai/scores/recompute', async (req) => {
    const ctx = requirePerm(req, P.aiReview);
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query(`select 1 from clubs where id = $1`, [clubId ?? null])).rowCount) throw badRequest('Выберите клуб');
      const model = await trainClub(db, ctx.tenantId, clubId!);
      const counts = await scoreClub(db, ctx.tenantId, clubId!);
      await audit(db, ctx, 'ai.scores_recomputed', 'club', clubId!, null, { counts, model });
      return { counts, model };
    });
  });

  app.get('/api/ai/day-plan', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query(`select 1 from clubs where id = $1`, [clubId ?? null])).rowCount) throw badRequest('Выберите клуб');
      return dayPlan(db, ctx, clubId!);
    });
  });

  app.get('/api/ai/plan-suggestion', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const { clubId, month } = req.query as { clubId?: string; month?: string };
    if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw badRequest('Укажите месяц');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query(`select 1 from clubs where id = $1`, [clubId ?? null])).rowCount) throw badRequest('Выберите клуб');
      return planSuggestion(db, clubId!, month!);
    });
  });

  app.get('/api/ai/shadow', async (req) => {
    const ctx = requirePerm(req, P.aiReview);
    const q = req.query as { clubId?: string; from?: string; to?: string };
    const d = (s?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? s! : null);
    return withCtx(pool, ctx, async (db) => {
      const today = new Date().toISOString().slice(0, 10);
      return shadow(db, q.clubId && q.clubId !== 'all' ? q.clubId : null, d(q.from) ?? addDays(today, -14), d(q.to) ?? today);
    });
  });
}
