// Загрузка клуба по часам (список «20 новых возможностей», п. 16).
// По посещениям считаем, сколько людей в клубе в среднем в каждый час каждого дня недели, по входам и по групповым залам;
// сравниваем с прошлым месяцем и даём прогноз на неделю вперёд. Помогает с графиком персонала, дневными тарифами и временем групповых.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { withCtx, type Db } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { accessSettings } from './acs.ts';
import { addDays, clubToday } from './memberships.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Сколько считаем человек в клубе, если выход не отмечен (нет турникета на выход). */
export const DEFAULT_STAY_MIN = 90;
type Grid = number[][]; // [день недели 0=пн..6=вс][час 0..23]
const grid = (): Grid => Array.from({ length: 7 }, () => Array(24).fill(0));
const round1 = (x: number) => Math.round(x * 10) / 10;

const monthBounds = (month: string) => {
  const from = `${month}-01`;
  const d = new Date(`${from}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1);
  return { from, to: d.toISOString().slice(0, 10) }; // [from, to)
};
const prevMonth = (month: string) => { const d = new Date(`${month}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

/** Сколько раз каждый день недели встречается в [from, to). */
function dowCounts(from: string, to: string) {
  const n = Array(7).fill(0);
  for (let d = from; d < to; d = addDays(d, 1)) n[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7]++;
  return n;
}

/**
 * Средняя загрузка за период [from, to) в местном времени клуба:
 * inside — сколько людей одновременно в клубе в среднем за час, entries — сколько входов за этот час.
 */
export async function loadGrid(db: Db, clubId: string, tz: string, from: string, to: string) {
  const inside = grid(); const entries = grid();
  // Каждое посещение раскладываем только на те часы, которые оно занимает (обычно 2–3), а не сравниваем со всеми часами периода:
  // на 1 млн посещений это секунды вместо десятков секунд
  const rows = (await db.query(`with v as (
        select visited_at at time zone $4 as a,
          (case when exit_at is not null then least(exit_at, visited_at + interval '16 hours') else visited_at + make_interval(mins => $5) end) at time zone $4 as b
        from visits where club_id = $1 and visited_at >= ($2::timestamp - interval '16 hours') at time zone $4 and visited_at < $3::timestamp at time zone $4),
      x as (
        select v.a, v.b, h from v cross join lateral generate_series(date_trunc('hour', v.a), v.b, interval '1 hour') h
        where h < v.b and h >= $2::timestamp and h < $3::timestamp)
    select (extract(isodow from h)::int - 1) as dow, extract(hour from h)::int as hr,
      -- доля часа, которую человек провёл в клубе: 30 минут из 60 — это половина человека в этот час
      sum(extract(epoch from (least(b, h + interval '1 hour') - greatest(a, h))) / 3600.0)::float as inside,
      count(*) filter (where a >= h and a < h + interval '1 hour')::int as entries
    from x
    group by 1, 2`, [clubId, from, to, tz, DEFAULT_STAY_MIN])).rows;
  const days = dowCounts(from, to);
  for (const r of rows) {
    const k = days[r.dow] || 1;
    inside[r.dow][r.hr] += r.inside / k;
    entries[r.dow][r.hr] += r.entries / k;
  }
  return { inside: inside.map((d) => d.map(round1)), entries: entries.map((d) => d.map(round1)), visits: rows.reduce((s, r) => s + r.entries, 0), days };
}

/** Входы по турникетам (зонам), если их больше одного на вход. */
async function zones(db: Db, clubId: string, tz: string, from: string, to: string) {
  const rows = (await db.query(`select p.id, p.name, (extract(isodow from e.happened_at at time zone $4)::int - 1) as dow, extract(hour from e.happened_at at time zone $4)::int as hr, count(*)::int as n
    from access_events e join access_points p on p.id = e.point_id
    where e.club_id = $1 and e.direction = 'in' and e.decision = 'allow' and e.happened_at >= $2::timestamp at time zone $4 and e.happened_at < $3::timestamp at time zone $4
    group by 1, 2, 3, 4`, [clubId, from, to, tz])).rows;
  const days = dowCounts(from, to);
  const by = new Map<string, { id: string; name: string; total: number; grid: Grid }>();
  for (const r of rows) {
    const z = by.get(r.id) ?? { id: r.id, name: r.name, total: 0, grid: grid() };
    z.grid[r.dow][r.hr] = round1(z.grid[r.dow][r.hr] + r.n / (days[r.dow] || 1));
    z.total += r.n;
    by.set(r.id, z);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/** Групповые залы: заполняемость занятий по дню недели и часу начала. */
async function rooms(db: Db, clubId: string, tz: string, from: string, to: string) {
  const rows = (await db.query(`select r.id, r.name, (extract(isodow from s.starts_at at time zone $4)::int - 1) as dow, extract(hour from s.starts_at at time zone $4)::int as hr,
      count(*)::int as sessions, sum(s.capacity)::int as seats,
      sum((select count(*) from class_bookings b where b.session_id = s.id and b.status in ('booked', 'attended')))::int as taken
    from class_sessions s join rooms r on r.id = s.room_id join class_types t on t.id = s.type_id
    where s.club_id = $1 and t.kind = 'group' and s.status <> 'cancelled' and s.starts_at >= $2::timestamp at time zone $4 and s.starts_at < $3::timestamp at time zone $4
    group by 1, 2, 3, 4`, [clubId, from, to, tz])).rows;
  const by = new Map<string, { id: string; name: string; sessions: number; seats: number; taken: number; cells: { dow: number; hr: number; sessions: number; fill: number }[] }>();
  for (const r of rows) {
    const x = by.get(r.id) ?? { id: r.id as string, name: r.name as string, sessions: 0, seats: 0, taken: 0, cells: [] as { dow: number; hr: number; sessions: number; fill: number }[] };
    x.sessions += r.sessions; x.seats += r.seats; x.taken += r.taken;
    x.cells.push({ dow: r.dow, hr: r.hr, sessions: r.sessions, fill: r.seats ? Math.round((100 * r.taken) / r.seats) : 0 });
    by.set(r.id, x);
  }
  return [...by.values()].map((x) => ({ ...x, fill: x.seats ? Math.round((100 * x.taken) / x.seats) : 0, cells: x.cells.sort((a, b) => a.dow - b.dow || a.hr - b.hr) }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** Подсказки: пиковые и пустые часы в рабочее время, лучшие и худшие слоты групповых. */
export function hints(inside: Grid, openFrom: string, openTo: string, roomsList: Awaited<ReturnType<typeof rooms>>) {
  const h0 = Number(openFrom.slice(0, 2)); const h1 = Math.max(h0 + 1, Number(openTo.slice(0, 2)) + (openTo.slice(3) === '00' ? 0 : 1));
  const cells: { dow: number; hr: number; v: number }[] = [];
  for (let d = 0; d < 7; d++) for (let h = h0; h < Math.min(h1, 24); h++) cells.push({ dow: d, hr: h, v: inside[d][h] });
  const peak = Math.max(0, ...cells.map((c) => c.v));
  const out: { kind: string; text: string }[] = [];
  if (peak <= 0) return { peak, out };
  const top = [...cells].sort((a, b) => b.v - a.v).slice(0, 3);
  out.push({ kind: 'peak', text: `Пик: ${top.map((c) => `${DOW[c.dow]} ${c.hr}:00 (≈${c.v} чел.)`).join(', ')}. В эти часы нужен полный ресепшн и дежурный тренер в зале.` });
  // Будни: часы, где в среднем меньше 20 % пика, — кандидаты на дневной тариф
  const quiet = [...new Set(cells.filter((c) => c.dow < 5 && c.v < peak * 0.2).map((c) => c.hr))].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const h of quiet) { const last = runs[runs.length - 1]; if (last && last[1] === h) last[1] = h + 1; else runs.push([h, h + 1]); }
  const long = runs.filter(([a, b]) => b - a >= 2 && quiet.filter((h) => h >= a && h < b).every((h) => cells.filter((c) => c.dow < 5 && c.hr === h).every((c) => c.v < peak * 0.2)));
  if (long.length) out.push({ kind: 'quiet', text: `В будни пусто ${long.map(([a, b]) => `с ${a}:00 до ${b}:00`).join(' и ')} — меньше пятой части пика. Можно предложить дневной абонемент на эти часы или поставить групповые.` });
  for (const r of roomsList) {
    const good = r.cells.filter((c) => c.sessions >= 2 && c.fill >= 85);
    const bad = r.cells.filter((c) => c.sessions >= 2 && c.fill < 40);
    if (good.length) out.push({ kind: 'room_full', text: `${r.name}: почти всегда полный ${good.slice(0, 3).map((c) => `${DOW[c.dow]} ${c.hr}:00 (${c.fill} %)`).join(', ')} — стоит добавить занятие рядом по времени.` });
    if (bad.length) out.push({ kind: 'room_empty', text: `${r.name}: мало людей ${bad.slice(0, 3).map((c) => `${DOW[c.dow]} ${c.hr}:00 (${c.fill} %)`).join(', ')} — перенести на время повыше загрузки или заменить формат.` });
  }
  return { peak, out };
}
const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export function loadRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/load', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    if (!can(ctx, P.dashView) && !can(ctx, P.scheduleManage)) throw forbidden();
    const q = req.query as { clubId?: string; month?: string };
    if (!q.clubId || !UUID.test(q.clubId)) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const s = await accessSettings(db, q.clubId!);
      const today = await clubToday(db, q.clubId!);
      const month = /^\d{4}-\d{2}$/.test(q.month ?? '') ? q.month! : today.slice(0, 7);
      const cur = monthBounds(month);
      const to = cur.to > today ? addDays(today, 1) : cur.to; // текущий месяц — по сегодняшний день включительно
      if (cur.from >= to) throw badRequest('Этот месяц ещё не начался');
      const pm = prevMonth(month);
      const prev = monthBounds(pm);
      const [now, before, zs, rs] = [await loadGrid(db, q.clubId!, s.timezone, cur.from, to), await loadGrid(db, q.clubId!, s.timezone, prev.from, prev.to),
        await zones(db, q.clubId!, s.timezone, cur.from, to), await rooms(db, q.clubId!, s.timezone, cur.from, to)];
      // Прогноз на 7 дней: средняя по тем же дню недели и часу за последние 4 недели, плюс уже записанные на групповые
      const recent = await loadGrid(db, q.clubId!, s.timezone, addDays(today, -28), today);
      const booked = (await db.query(`select to_char(s.starts_at at time zone $3, 'YYYY-MM-DD') as day, extract(hour from s.starts_at at time zone $3)::int as hr,
          count(b.id)::int as n
        from class_sessions s join class_bookings b on b.session_id = s.id and b.status = 'booked'
        where s.club_id = $1 and s.status = 'scheduled' and (s.starts_at >= ($2::date)::date::timestamp at time zone $3 and s.starts_at < (($2::date + 6)::date + 1)::timestamp at time zone $3) group by 1, 2`, [q.clubId, today, s.timezone])).rows;
      const forecast = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(today, i);
        const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
        const hours = recent.inside[dow].map((v) => round1(v));
        const classes = booked.filter((b) => b.day === day).reduce((s2, b) => s2 + b.n, 0);
        const sum = round1(recent.entries[dow].reduce((a, b) => a + b, 0));
        return { day, dow, hours, visits: Math.round(sum), peakHour: hours.indexOf(Math.max(...hours)), classes };
      });
      const h = hints(now.inside, s.openFrom, s.openTo, rs);
      return {
        clubId: q.clubId, month, prevMonth: pm, today, openFrom: s.openFrom, openTo: s.openTo, stayMin: DEFAULT_STAY_MIN,
        inside: now.inside, entries: now.entries, visits: now.visits,
        prev: { inside: before.inside, entries: before.entries, visits: before.visits },
        zones: zs.length > 1 ? zs : [], rooms: rs, forecast, peak: h.peak, hints: h.out,
        exitsKnown: Number((await db.query(`select coalesce(round(100.0 * count(exit_at) / nullif(count(*), 0)), 0)::int as p from visits
          where club_id = $1 and visited_at >= $2::timestamp at time zone $4 and visited_at < $3::timestamp at time zone $4`, [q.clubId, cur.from, to, s.timezone])).rows[0].p),
      };
    });
  });
}
