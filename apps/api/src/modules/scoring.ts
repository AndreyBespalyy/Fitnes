// Шаг 15. Оценка приоритета клиентов (FR-AI-04) — классическая модель на табличных данных клуба, без GPU.
// Четыре задачи: покупка (лид в работе), продление, возврат бывшего клиента, риск ухода действующего.
// Модель покупки дообучается на закрытых сделках клуба (логистическая регрессия), пока данных мало — работают правила.
// Каждая оценка объясняется: какие факторы подняли или опустили приоритет (FR-AI-16).
import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import { clubToday } from './memberships.ts';

export type Kind = 'purchase' | 'renewal' | 'return' | 'churn';
export const KIND_NAME: Record<Kind, string> = { purchase: 'Покупка', renewal: 'Продление', return: 'Возврат', churn: 'Удержание' };
type Feat = { id: string; plus: string; minus: string };
type Row = { person_id: string; owner_id: string | null; opportunity_id: string | null; x: Record<string, number>; excluded?: string | null; product_id?: string | null; meta?: Record<string, unknown> };

/* ---------- признаки и правила ---------- */
const PURCHASE_FEATS: Feat[] = [
  { id: 'fast', plus: 'ответили на заявку вовремя', minus: 'на заявку ответили поздно' },
  { id: 'meet_set', plus: 'назначена встреча', minus: 'встреча не назначена' },
  { id: 'meet_done', plus: 'был на встрече в клубе', minus: 'в клубе ещё не был' },
  { id: 'touch', plus: 'много касаний', minus: 'мало касаний' },
  { id: 'age', plus: 'свежая заявка', minus: 'заявка давняя' },
  { id: 'recent', plus: 'недавно общались', minus: 'давно не общались' },
  { id: 'inbound', plus: 'сам писал на этой неделе', minus: 'сам не пишет' },
  { id: 'src', plus: 'канал с высокой конверсией', minus: 'канал с низкой конверсией' },
  { id: 'stage', plus: 'далеко продвинулся по воронке', minus: 'в начале воронки' },
  { id: 'former', plus: 'раньше был клиентом', minus: '' },
  { id: 'interested', plus: 'в разговоре проявил интерес', minus: '' },
  { id: 'thinking', plus: 'в разговоре сказал, что подумает', minus: '' },
];
// Правила (rules-v1): веса подобраны по смыслу, до накопления данных клуба
export const RULES: Record<Kind, { b: number; w: Record<string, number> }> = {
  purchase: { b: -1.9, w: { fast: 0.4, meet_set: 0.9, meet_done: 1.4, touch: 0.25, age: -0.35, recent: 0.6, inbound: 0.8, src: 3, stage: 0.8, former: 0.3, interested: 1, thinking: 0.3 } },
  renewal: { b: -0.8, w: { visits: 0.15, trend: 0.4, tenure: 0.3, debt: -0.9, left: -0.02, interested: 0.8, thinking: 0.2 } },
  return: { b: -1.6, w: { past_visits: 0.6, count: 0.4, months: -0.18, interested: 0.8 } },
  churn: { b: -2.4, w: { idle: 0.11, drop: 1.1, debt: 0.6, new: 0.4, freeze: 0.5, complaint: 1.2 } },
};
const FEATS: Record<Kind, Feat[]> = {
  purchase: PURCHASE_FEATS,
  renewal: [
    { id: 'visits', plus: 'часто ходит', minus: 'редко ходит' }, { id: 'trend', plus: 'ходит не реже, чем раньше', minus: 'стал ходить реже' },
    { id: 'tenure', plus: 'давно с клубом', minus: 'новый клиент' }, { id: 'debt', plus: '', minus: 'есть долг' },
    { id: 'left', plus: 'до окончания мало дней', minus: 'до окончания ещё много дней' }, { id: 'interested', plus: 'в разговоре проявил интерес', minus: '' },
    { id: 'thinking', plus: 'в разговоре сказал, что подумает', minus: '' },
  ],
  return: [
    { id: 'past_visits', plus: 'раньше ходил часто', minus: 'раньше ходил редко' }, { id: 'count', plus: 'брал абонемент не раз', minus: 'был один абонемент' },
    { id: 'months', plus: 'ушёл недавно', minus: 'ушёл давно' }, { id: 'interested', plus: 'в разговоре проявил интерес', minus: '' },
  ],
  churn: [
    { id: 'idle', plus: 'давно не был в клубе', minus: 'ходит' }, { id: 'drop', plus: 'стал ходить заметно реже', minus: '' },
    { id: 'debt', plus: 'есть долг', minus: '' }, { id: 'new', plus: 'клиент первого месяца', minus: '' },
    { id: 'freeze', plus: 'часто замораживает абонемент', minus: '' }, { id: 'complaint', plus: 'недавно поставил низкую оценку клубу', minus: '' },
  ],
};
const TRAINABLE = ['fast', 'meet_set', 'meet_done', 'touch', 'src', 'former', 'interested', 'thinking'];
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const ln1 = (x: number) => Math.log(1 + Math.max(0, x));
const daysAgo = (d: Date | string | null, now: number) => (d ? Math.max(0, (now - new Date(d).getTime()) / 86_400_000) : null);

/* ---------- данные клуба ---------- */
async function sourceRates(db: Db, clubId: string) {
  const rows = (await db.query(
    `select l.source_id, count(*) filter (where o.status = 'won')::int as won, count(*)::int as n
     from opportunities o join leads l on l.opportunity_id = o.id
     where o.club_id = $1 and o.status in ('won', 'lost') and o.closed_at > now() - interval '365 days' group by 1`, [clubId])).rows;
  const W = rows.reduce((a, r) => a + r.won, 0); const N = rows.reduce((a, r) => a + r.n, 0);
  const avg = N ? W / N : 0.3;
  // сглаживание: каналы с малым числом сделок тянутся к среднему клуба
  const m = new Map<string, number>(rows.map((r) => [r.source_id, (r.won + 5 * avg) / (r.n + 5) - avg]));
  return (id: string | null) => (id ? m.get(id) ?? 0 : 0);
}

const OUTCOME_SQL = (person: string, club: string, before = 'now()') => `(select coalesce(s.final, s.draft) ->> 'outcome' from call_summaries s join calls c on c.id = s.call_id
  where c.person_id = ${person} and c.club_id = ${club} and s.status <> 'needs_manual' and c.started_at < ${before} order by c.started_at desc limit 1)`;

async function purchaseRows(db: Db, clubId: string, now: number): Promise<Row[]> {
  const src = await sourceRates(db, clubId);
  const rows = (await db.query(
    `select o.id, o.person_id, o.owner_id, o.created_at, st.sort, (select max(sort) from pipeline_stages s2 where s2.pipeline_id = st.pipeline_id and s2.kind = 'open') as max_sort,
       (select l.source_id from leads l where l.opportunity_id = o.id order by l.created_at limit 1) as source_id,
       coalesce((select bool_or(l.first_response_at <= l.first_response_due_at) from leads l where l.opportunity_id = o.id), false) as fast,
       (select count(*) from meetings m where m.person_id = o.person_id and m.club_id = o.club_id and m.created_at >= o.created_at and m.status <> 'cancelled')::int as meet_set,
       (select count(*) from meetings m where m.person_id = o.person_id and m.club_id = o.club_id and m.created_at >= o.created_at and m.status = 'attended')::int as meet_done,
       (select count(*) from tasks t where t.opportunity_id = o.id and t.done_at is not null)::int as touches,
       greatest((select max(done_at) from tasks t where t.opportunity_id = o.id), (select max(started_at) from calls c where c.person_id = o.person_id and c.club_id = o.club_id),
         (select max(m.created_at) from msg_messages m join msg_conversations cv on cv.id = m.conversation_id where cv.person_id = o.person_id and m.direction = 'out')) as last_contact,
       (select max(m.created_at) from msg_messages m join msg_conversations cv on cv.id = m.conversation_id where cv.person_id = o.person_id and m.direction = 'in') as last_in,
       ${OUTCOME_SQL('o.person_id', 'o.club_id')} as outcome,
       exists (select 1 from memberships m where m.person_id = o.person_id and m.kind <> 'guest' and m.status <> 'cancelled' and m.created_at < o.created_at) as former,
       (select m.product_id from memberships m where m.person_id = o.person_id and m.club_id = o.club_id and m.kind <> 'guest' order by m.created_at desc limit 1) as last_product
     from opportunities o join pipeline_stages st on st.id = o.stage_id
     where o.club_id = $1 and o.status = 'open'
       and not exists (select 1 from memberships m where m.person_id = o.person_id and m.club_id = o.club_id and m.kind <> 'guest' and m.status = 'active'
                       and m.created_at >= o.created_at)`, [clubId])).rows;
  return rows.map((r) => {
    const contact = daysAgo(r.last_contact, now);
    const inn = daysAgo(r.last_in, now);
    return {
      person_id: r.person_id, owner_id: r.owner_id, opportunity_id: r.id, product_id: r.last_product,
      excluded: r.outcome === 'refused' ? 'в последнем разговоре отказался' : null,
      x: {
        fast: r.fast ? 1 : 0, meet_set: r.meet_set > 0 ? 1 : 0, meet_done: r.meet_done > 0 ? 1 : 0, touch: ln1(r.touches), age: ln1(daysAgo(r.created_at, now)!),
        recent: contact === null ? 0 : Math.exp(-contact / 7), inbound: inn !== null && inn <= 7 ? 1 : 0, src: src(r.source_id),
        stage: r.max_sort ? Math.min(1, Number(r.sort) / Number(r.max_sort)) : 0, former: r.former ? 1 : 0,
        interested: r.outcome === 'interested' ? 1 : 0, thinking: r.outcome === 'thinking' ? 1 : 0,
      },
      meta: { days: Math.round(daysAgo(r.created_at, now)!) },
    };
  });
}

/** Признаки закрытых сделок «на момент закрытия» — обучающая выборка модели покупки */
async function closedOpps(db: Db, clubId: string) {
  const src = await sourceRates(db, clubId);
  const rows = (await db.query(
    `select o.id, o.status, (select l.source_id from leads l where l.opportunity_id = o.id order by l.created_at limit 1) as source_id,
       coalesce((select bool_or(l.first_response_at <= l.first_response_due_at) from leads l where l.opportunity_id = o.id), false) as fast,
       (select count(*) from meetings m where m.person_id = o.person_id and m.club_id = o.club_id and m.created_at between o.created_at and o.closed_at and m.status <> 'cancelled')::int as meet_set,
       (select count(*) from meetings m where m.person_id = o.person_id and m.club_id = o.club_id and m.created_at between o.created_at and o.closed_at and m.status = 'attended')::int as meet_done,
       (select count(*) from tasks t where t.opportunity_id = o.id and t.done_at is not null and t.done_at <= o.closed_at)::int as touches,
       ${OUTCOME_SQL('o.person_id', 'o.club_id', 'o.closed_at')} as outcome,
       exists (select 1 from memberships m where m.person_id = o.person_id and m.kind <> 'guest' and m.status <> 'cancelled' and m.created_at < o.created_at) as former
     from opportunities o where o.club_id = $1 and o.status in ('won', 'lost') and o.closed_at > now() - interval '365 days'`, [clubId])).rows;
  return rows.map((r) => ({
    id: r.id as string, y: r.status === 'won' ? 1 : 0,
    x: { fast: r.fast ? 1 : 0, meet_set: r.meet_set > 0 ? 1 : 0, meet_done: r.meet_done > 0 ? 1 : 0, touch: ln1(r.touches), src: src(r.source_id), former: r.former ? 1 : 0,
      interested: r.outcome === 'interested' ? 1 : 0, thinking: r.outcome === 'thinking' ? 1 : 0 } as Record<string, number>,
  }));
}

async function renewalRows(db: Db, clubId: string, today: string): Promise<Row[]> {
  const rows = (await db.query(
    `select m.id, m.person_id, m.product_id, m.created_by, m.starts_on, m.ends_on, ($2::date - m.starts_on) as tenure, (m.ends_on - $2::date) as left_days,
       (select count(*) from visits v where v.person_id = m.person_id and v.club_id = m.club_id and v.visited_at > now() - interval '30 days')::int as v30,
       (select count(*) from visits v where v.person_id = m.person_id and v.club_id = m.club_id and v.visited_at between now() - interval '60 days' and now() - interval '30 days')::int as v60,
       exists (select 1 from charges ch where ch.person_id = m.person_id and ch.club_id = m.club_id and ch.status = 'due' and ch.due_on < $2::date) as debt,
       ${OUTCOME_SQL('m.person_id', 'm.club_id')} as outcome,
       (select o.id from opportunities o where o.person_id = m.person_id and o.club_id = m.club_id and o.status = 'open' order by o.created_at desc limit 1) as opp
     from memberships m
     where m.club_id = $1 and m.status = 'active' and m.kind in ('term', 'visits') and m.ends_on between $2::date and $2::date + 30
       and not exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = m.club_id and n.id <> m.id and n.status = 'active' and n.kind <> 'guest'
                       and (n.ends_on is null or n.ends_on > m.ends_on))`, [clubId, today])).rows;
  return rows.map((r) => ({
    person_id: r.person_id, owner_id: r.created_by, opportunity_id: r.opp, product_id: r.product_id,
    excluded: r.outcome === 'refused' ? 'в последнем разговоре отказался' : null,
    x: { visits: Math.min(16, r.v30), trend: r.v30 >= r.v60 ? 1 : 0, tenure: ln1(r.tenure / 30), debt: r.debt ? 1 : 0, left: r.left_days, interested: r.outcome === 'interested' ? 1 : 0, thinking: r.outcome === 'thinking' ? 1 : 0 },
    meta: { endsOn: r.ends_on, visits30: r.v30 },
  }));
}

async function returnRows(db: Db, clubId: string, today: string): Promise<Row[]> {
  const rows = (await db.query(
    `with last as (
       select distinct on (m.person_id) m.person_id, m.product_id, m.created_by, m.starts_on, m.ends_on
       from memberships m where m.club_id = $1 and m.kind in ('term', 'visits', 'subscription') and m.status <> 'cancelled' and m.ends_on is not null
       order by m.person_id, m.ends_on desc)
     select l.*, ($2::date - l.ends_on) as since,
       (select count(*) from visits v where v.person_id = l.person_id and v.club_id = $1 and (v.visited_at)::date between l.starts_on and l.ends_on)::float
         / greatest(1, (l.ends_on - l.starts_on) / 7.0) as per_week,
       (select count(*) from memberships m where m.person_id = l.person_id and m.club_id = $1 and m.kind <> 'guest' and m.status <> 'cancelled')::int as cnt,
       ${OUTCOME_SQL('l.person_id', '$1')} as outcome,
       exists (select 1 from opportunities o where o.person_id = l.person_id and o.club_id = $1 and o.status = 'lost' and o.closed_at > now() - interval '60 days') as said_no
     from last l
     where l.ends_on between $2::date - 365 and $2::date - 14
       and not exists (select 1 from memberships m where m.person_id = l.person_id and m.club_id = $1 and m.status = 'active' and m.kind <> 'guest' and (m.ends_on is null or m.ends_on >= $2::date))
       and not exists (select 1 from opportunities o where o.person_id = l.person_id and o.club_id = $1 and o.status = 'open')`, [clubId, today])).rows;
  return rows.map((r) => ({
    person_id: r.person_id, owner_id: r.created_by, opportunity_id: null, product_id: r.product_id,
    excluded: r.outcome === 'refused' || r.said_no ? 'недавно отказался' : null,
    x: { past_visits: Math.min(4, Number(r.per_week)), count: ln1(r.cnt), months: r.since / 30, interested: r.outcome === 'interested' ? 1 : 0 },
    meta: { months: Math.round(r.since / 30) },
  }));
}

async function churnRows(db: Db, clubId: string, today: string): Promise<Row[]> {
  // Без данных о посещениях (турникет не подключён) риск ухода не считаем: данных недостаточно
  if (!(await db.query(`select 1 from visits where club_id = $1 limit 1`, [clubId])).rowCount) return [];
  const rows = (await db.query(
    `select m.person_id, min(m.starts_on) as started, (array_agg(m.created_by order by m.created_at desc))[1] as seller, (array_agg(m.product_id order by m.created_at desc))[1] as product_id,
       (select max(v.visited_at) from visits v where v.person_id = m.person_id and v.club_id = m.club_id) as last_visit,
       (select count(*) from visits v where v.person_id = m.person_id and v.club_id = m.club_id and v.visited_at > now() - interval '30 days')::int as v30,
       (select count(*) from visits v where v.person_id = m.person_id and v.club_id = m.club_id and v.visited_at between now() - interval '60 days' and now() - interval '30 days')::int as v60,
       exists (select 1 from charges ch where ch.person_id = m.person_id and ch.club_id = m.club_id and ch.status = 'due' and ch.due_on < $2::date) as debt,
       (select count(*) from freezes f join memberships fm on fm.id = f.membership_id where fm.person_id = m.person_id and f.club_id = m.club_id and f.starts_on > $2::date - 180)::int as freezes,
       (select min(sv.score) from surveys sv where sv.person_id = m.person_id and sv.club_id = m.club_id and sv.status = 'answered' and sv.answered_at > now() - interval '60 days') as low_score
     from memberships m
     where m.club_id = $1 and m.status = 'active' and m.kind in ('term', 'visits', 'subscription') and m.starts_on <= $2::date - 14 and (m.ends_on is null or m.ends_on > $2::date + 30)
     group by m.person_id, m.club_id`, [clubId, today])).rows;
  const now = Date.now();
  return rows.map((r) => {
    const idle = daysAgo(r.last_visit ?? r.started, now)!;
    return {
      person_id: r.person_id, owner_id: r.seller, opportunity_id: null, product_id: r.product_id,
      x: { idle: Math.min(45, idle), drop: r.v60 >= 4 && r.v30 < r.v60 / 2 ? 1 : 0, debt: r.debt ? 1 : 0, new: daysAgo(r.started, now)! < 45 ? 1 : 0,
        freeze: r.freezes >= 2 ? 1 : 0, complaint: r.low_score !== null && r.low_score <= 6 ? 1 : 0 },
      meta: { idle: Math.round(idle), freezes: r.freezes, lowScore: r.low_score },
    };
  });
}

/* ---------- обучение модели покупки ---------- */
const hashSplit = (id: string) => parseInt(createHash('md5').update(id).digest('hex').slice(0, 4), 16) % 4 === 0; // 25 % — проверочная выборка

export function auc(scores: number[], ys: number[]) {
  const pos = scores.filter((_, i) => ys[i] === 1); const neg = scores.filter((_, i) => ys[i] === 0);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return Math.round((s / (pos.length * neg.length)) * 1000) / 1000;
}

export function trainLogistic(data: { x: Record<string, number>; y: number }[], feats: string[], base: { b: number; w: Record<string, number> }) {
  let b = base.b; const w: Record<string, number> = Object.fromEntries(feats.map((f) => [f, base.w[f] ?? 0]));
  const lr = 0.1; const l2 = 0.01;
  for (let it = 0; it < 400; it++) {
    let gb = 0; const gw: Record<string, number> = Object.fromEntries(feats.map((f) => [f, 0]));
    for (const d of data) {
      const e = sigmoid(b + feats.reduce((a, f) => a + w[f] * (d.x[f] ?? 0), 0)) - d.y;
      gb += e; for (const f of feats) gw[f] += e * (d.x[f] ?? 0);
    }
    b -= (lr * gb) / data.length;
    for (const f of feats) w[f] -= lr * (gw[f] / data.length + l2 * (w[f] - (base.w[f] ?? 0)));
  }
  return { b, w };
}

/** Раз в день: модель покупки на закрытых сделках клуба. Применяется, только если на проверке лучше правил */
export async function trainClub(db: Db, tenantId: string, clubId: string) {
  const data = await closedOpps(db, clubId);
  const won = data.filter((d) => d.y === 1).length;
  const metrics: Record<string, unknown> = { samples: data.length, won, lost: data.length - won };
  const rules = RULES.purchase;
  const score = (m: { b: number; w: Record<string, number> }, x: Record<string, number>) => sigmoid(m.b + TRAINABLE.reduce((a, f) => a + (m.w[f] ?? 0) * (x[f] ?? 0), 0));
  let version = 'rules-v1'; let weights = { b: rules.b, w: rules.w };
  if (data.length >= 80 && won >= 20 && data.length - won >= 20) {
    const train = data.filter((d) => !hashSplit(d.id)); const test = data.filter((d) => hashSplit(d.id));
    const m = trainLogistic(train, TRAINABLE, { b: rules.b, w: rules.w });
    const aucModel = auc(test.map((d) => score(m, d.x)), test.map((d) => d.y));
    const aucRules = auc(test.map((d) => score(rules, d.x)), test.map((d) => d.y));
    Object.assign(metrics, { test: test.length, aucModel, aucRules });
    if (aucModel !== null && aucModel >= 0.6 && (aucRules === null || aucModel >= aucRules)) {
      version = `lr-${new Date().toISOString().slice(0, 10)}`;
      weights = { b: m.b, w: { ...rules.w, ...m.w } }; // давность и касания, которых нет на момент закрытия, — по правилам
    }
  } else metrics.note = 'Мало закрытых сделок для обучения (нужно от 80, из них не менее 20 успешных и 20 отказов): работают правила';
  await db.query(`insert into ai_models(tenant_id, club_id, kind, version, weights, metrics) values ($1,$2,'purchase',$3,$4,$5)
    on conflict (club_id, kind) do update set version = excluded.version, weights = excluded.weights, metrics = excluded.metrics, trained_at = now()`,
  [tenantId, clubId, version, JSON.stringify(weights), JSON.stringify(metrics)]);
  return { version, metrics };
}

/* ---------- предложение по прейскуранту ---------- */
type Product = { id: string; name: string; kind: string; price: number; freeze: boolean; sold: number };
async function productsOf(db: Db, clubId: string): Promise<Product[]> {
  return (await db.query(
    `select p.id, p.name, p.kind, p.freeze_allowed as freeze,
       (select amount_kop from price_versions pv where pv.product_id = p.id and pv.valid_from <= now() order by pv.valid_from desc limit 1)::bigint as price,
       (select count(*) from memberships m where m.product_id = p.id and m.created_at > now() - interval '90 days')::int as sold
     from products p where p.club_id = $1 and p.is_active and p.kind in ('term', 'visits', 'subscription')`, [clubId])).rows
    .filter((p) => p.price !== null).map((p) => ({ ...p, price: Number(p.price) }));
}
/** Подсказка, что сказать клиенту с риском ухода: от главной причины к второстепенным */
export function churnScript(x: Record<string, number>, freezeAllowed: boolean) {
  const say: string[] = [];
  if (x.complaint) say.push('Начните с его оценки: извинитесь, спросите, что именно не понравилось, и скажите, что исправили или исправите');
  if (x.debt) say.push('Мягко напомните о платеже и предложите оплатить по ссылке; если трудно — предложите перенести платёж');
  if (x.drop || (x.idle ?? 0) >= 14) say.push('Спросите, что мешает ходить (время, нагрузка, тренер), и пригласите на конкретное занятие на этой неделе');
  if (x.new) say.push('Клиент только начал: предложите вводную тренировку или занятие с тренером, чтобы не бросил');
  if (x.freeze) say.push('Часто замораживает: узнайте, удобно ли расписание, предложите другое время или формат');
  else if (freezeAllowed && (x.idle ?? 0) >= 21) say.push('Если сейчас не до клуба — предложите заморозку вместо того, чтобы терять дни');
  return say.length ? say.join('. ') : 'Позвоните, узнайте, как дела с тренировками, пригласите на занятие';
}
const rub = (kop: number) => `${new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100))} ₽`;
function offerFor(kind: Kind, r: Row, products: Product[], model: string) {
  const own = products.find((p) => p.id === r.product_id);
  const main = products.filter((p) => (model === 'subscription' ? p.kind === 'subscription' : p.kind !== 'subscription'));
  const popular = [...main].sort((a, b) => b.sold - a.sold || a.price - b.price)[0];
  if (kind === 'churn') return { text: churnScript(r.x, !!own?.freeze) };
  const p = own ?? popular;
  if (!p) return null;
  const verb = kind === 'renewal' ? 'Продлить' : kind === 'return' ? 'Вернуться на' : 'Предложить';
  return { productId: p.id, name: p.name, priceKop: p.price, text: `${verb} «${p.name}» за ${rub(p.price)}${p.kind === 'subscription' ? ' в месяц' : ''}` };
}

/* ---------- пересчёт клуба ---------- */
function explain(kind: Kind, x: Record<string, number>, m: { b: number; w: Record<string, number> }, mean: Record<string, number>, meta: Record<string, unknown> = {}) {
  const parts = FEATS[kind].map((f) => ({ f, c: (m.w[f.id] ?? 0) * ((x[f.id] ?? 0) - (mean[f.id] ?? 0)) }))
    .filter((p) => Math.abs(p.c) >= 0.08 && (p.c > 0 ? p.f.plus : p.f.minus)).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 3);
  return parts.map(({ f, c }) => {
    let text = c > 0 ? f.plus : f.minus;
    if (f.id === 'age') text += `: ${meta.days} дн.`;
    if (f.id === 'idle') text += `: ${meta.idle} дн.`;
    if (f.id === 'freeze') text += `: ${meta.freezes} раза за полгода`;
    if (f.id === 'complaint') text += `: ${meta.lowScore} из 10`;
    if (f.id === 'months') text += `: ${meta.months} мес. назад`;
    if (f.id === 'visits') text += `: ${meta.visits30} за 30 дн.`;
    return { effect: c > 0 ? '+' : '-', text };
  });
}

export async function scoreClub(db: Db, tenantId: string, clubId: string) {
  const today = await clubToday(db, clubId);
  const now = Date.now();
  const club = (await db.query(`select sales_model from clubs where id = $1`, [clubId])).rows[0];
  const staff = new Set((await db.query(`select a.user_id from user_assignments a join users u on u.id = a.user_id
    where a.club_id = $1 and a.role_code in ('manager', 'rop') and u.status = 'active' and (a.active_to is null or a.active_to >= current_date)`, [clubId])).rows.map((r) => r.user_id as string));
  const trained = (await db.query(`select version, weights from ai_models where club_id = $1 and kind = 'purchase'`, [clubId])).rows[0];
  const products = await productsOf(db, clubId);
  const sets: [Kind, Row[]][] = [
    ['purchase', await purchaseRows(db, clubId, now)], ['renewal', await renewalRows(db, clubId, today)],
    ['return', await returnRows(db, clubId, today)], ['churn', await churnRows(db, clubId, today)],
  ];
  const counts: Record<string, number> = {};
  await db.query(`delete from client_scores where club_id = $1`, [clubId]);
  for (const [kind, rows] of sets) {
    const model = kind === 'purchase' && trained ? trained.weights as { b: number; w: Record<string, number> } : RULES[kind];
    const version = kind === 'purchase' && trained ? trained.version as string : 'rules-v1';
    const mean: Record<string, number> = {};
    for (const f of FEATS[kind]) mean[f.id] = rows.length ? rows.reduce((a, r) => a + (r.x[f.id] ?? 0), 0) / rows.length : 0;
    const scored = rows.map((r) => ({ r, s: sigmoid(model.b + Object.entries(model.w).reduce((a, [k, w]) => a + w * (r.x[k] ?? 0), 0)) }));
    const ranked = scored.filter((x) => !x.r.excluded).sort((a, b) => b.s - a.s);
    // Горячие — верхние 20 %, тёплые — следующие 30 % (хотя бы один горячий; равные оценки — в одном сегменте)
    const n = ranked.length;
    const hotMin = n ? ranked[Math.max(1, Math.round(n * 0.2)) - 1].s : 1;
    const warmMin = n ? ranked[Math.max(1, Math.round(n * 0.5)) - 1].s : 1;
    const segOf = new Map<string, string>();
    for (const x of ranked) segOf.set(x.r.person_id, x.s >= hotMin ? 'hot' : x.s >= warmMin ? 'warm' : kind === 'purchase' || kind === 'return' ? 'auto' : 'low');
    for (const { r, s } of scored) {
      const segment = r.excluded ? 'excluded' : segOf.get(r.person_id)!;
      const reasons = r.excluded ? [{ effect: '-', text: r.excluded }] : explain(kind, r.x, model, mean, r.meta);
      const owner = r.owner_id && staff.has(r.owner_id) ? r.owner_id : null;
      await db.query(`insert into client_scores(tenant_id, club_id, person_id, kind, score, segment, owner_id, opportunity_id, reasons, offer, model)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (club_id, person_id, kind) do nothing`,
      [tenantId, clubId, r.person_id, kind, Math.round(s * 1000) / 1000, segment, owner, r.opportunity_id, JSON.stringify(reasons),
        JSON.stringify(offerFor(kind, r, products, club.sales_model)), version]);
      await db.query(`insert into ai_score_history(tenant_id, club_id, day, person_id, kind, score, segment, owner_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict do nothing`, [tenantId, clubId, today, r.person_id, kind, Math.round(s * 1000) / 1000, segment, owner]);
    }
    counts[kind] = rows.length;
  }
  return counts;
}

