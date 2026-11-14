// ИИ-агент, этап 4 (просьба Андрея 14.11.2026): помощник собственника и руководителей в чате «ИИ-помощник».
// Принимает вопрос в свободной форме (продажи и план, прогноз, посещаемость, тренеры, сотрудник, клиент, проблемные места),
// если всё понятно — сразу отвечает (без пересказа вопроса), при сомнениях уточняет вопросом с вариантами,
// отвечает по данным CRM, даёт советы и прогнозы с вероятностью. Может вмешаться: «напомни Марии», «передай задачи Марии Ксении».
// Если подключён YandexGPT — понимает свободные формулировки и пишет советы; без него всё работает по правилам.
import { can } from '../auth.ts';
import { audit, type Ctx, type Db } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { ygptComplete, ygptJson, type YandexConfig } from '../lib/yandex.ts';
import { classesText, clientClasses, fmtDate, noContacts, situationBrief } from './agent.ts';
import { card, leastLoaded, reassignOpenWork } from './agentReminders.ts';
import { clientsFact, kpi, lightOf, monthInfo, planFact, salesFact, targets } from './dash.ts';

export type Topic = 'sales' | 'forecast' | 'attendance' | 'trainers' | 'staff' | 'client' | 'problems' | 'advice';
export const TOPIC_NAME: Record<Topic, string> = {
  sales: 'продажи и план', forecast: 'прогноз', attendance: 'посещаемость', trainers: 'тренеры', staff: 'сотрудники',
  client: 'клиент', problems: 'проблемные места', advice: 'советы',
};
const TOPIC_RE: [Topic, RegExp][] = [
  ['sales', /(продаж|выручк|план|деньг|касс|доход|оплат|продал|заработ)/],
  ['forecast', /(прогноз|успеем|успеет|выполним|выполнит|будет ли|вероятн|шанс|к концу месяца|ожида)/],
  ['attendance', /(посещ|приход|визит|загруж|загрузк|ходят|ходит|посетител|проход)/],
  ['trainers', /(тренер|занят|групповы|персональн)/],
  ['staff', /(сотрудник|менеджер|персонал|команд|kpi|кпи|работает|работают|отдел продаж)/],
  ['client', /(клиент[а-я]* по имени|по клиенту|про клиента|клиентк)/],
  ['problems', /(проблем|узк|горит|плохо|не так|просроч|риск|тормоз|завис|застрял)/],
  ['advice', /(совет|что делать|как улучш|посоветуй|рекоменд|подскажи|как поднять|как увелич)/],
];
const OVERVIEW_RE = /(как дела|общ(ая|ую) картин|итоги|статистик|что нового|обстановк|в целом|сводк)/;
const STOP = new Set(['как', 'что', 'где', 'когда', 'сколько', 'почему', 'какая', 'какой', 'какие', 'покажи', 'дай', 'расскажи', 'нужно', 'надо',
  'все', 'всё', 'всех', 'это', 'эту', 'этот', 'этой', 'сегодня', 'вчера', 'завтра', 'неделю', 'неделя', 'неделе', 'месяц', 'месяца', 'месяце',
  'прошлый', 'прошлую', 'прошлом', 'прошлой', 'текущий', 'клуб', 'клубу', 'клубе', 'клуба', 'клубам', 'сети', 'сеть', 'дела', 'там', 'есть',
  'был', 'была', 'были', 'будет', 'дней', 'день', 'дня', 'про', 'для', 'мне', 'нам', 'наш', 'наши', 'нашем', 'очень', 'ещё', 'еще', 'уже',
  'или', 'тоже', 'также', 'его', 'её', 'ему', 'ней', 'него', 'них', 'чем', 'при', 'без', 'так', 'вот', 'пожалуйста', 'хочу', 'знать',
  'напомни', 'поторопи', 'передай', 'передать', 'задачи', 'задачу', 'заявки', 'работу', 'клиента', 'клиенту', 'клиент', 'клиентов', 'сотрудника',
  'сотрудник', 'менеджера', 'менеджер', 'тренера', 'тренер', 'тренеров', 'кто', 'лучше', 'хуже', 'всего', 'итого', 'года', 'год',
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']);
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йея]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

export type Period = { from: string; to: string; label: string; month?: string };
export type Club = { id: string; name: string; timezone: string };
export type Who = { type: 'employee' | 'client'; id: string; label: string; role?: string };
export type Pending = { kind: 'topic' | 'who' | 'meeting' | 'meeting_club'; data?: unknown; text: string; options?: Who[] };
type Section = { title: string; lines: string[]; tips: string[] };

const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU').replace(/[ ,]/g, ' ')} ₽`;
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a * 100) / b) : 0);
const dd = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
export const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const change = (cur: number, prev: number) => (prev === 0 ? (cur ? 'раньше было 0' : 'без изменений') : `${cur >= prev ? '+' : '−'}${Math.abs(Math.round(((cur - prev) * 100) / prev))} % к прошлому периоду`);
export const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/* ---------- статистика: вероятность по нормальному приближению ---------- */
function erf(x: number) {
  const s = Math.sign(x); const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
export const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
/** Вероятность набрать план к концу месяца по дневным продажам: среднее и разброс по прошедшим дням, учитывая неточность среднего */
export function planChance(daily: number[], factKop: number, planKop: number, left: number) {
  const n = daily.length;
  if (!n || planKop <= 0) return null;
  if (factKop >= planKop) return { p: 0.99, expected: factKop, low: factKop, high: factKop };
  const mean = daily.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(daily.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : mean;
  const expected = factKop + mean * left;
  const sdTotal = Math.sqrt(sd * sd * left + (sd * sd / n) * left * left);
  if (left <= 0 || sdTotal === 0) return { p: expected >= planKop ? 0.99 : 0.01, expected, low: expected, high: expected };
  const p = 1 - normCdf((planKop - expected) / sdTotal);
  return { p: Math.min(0.97, Math.max(0.03, p)), expected, low: Math.max(factKop, expected - 1.28 * sdTotal), high: expected + 1.28 * sdTotal };
}
const chance = (p: number) => (p <= 0.03 ? 'меньше 5 %' : p >= 0.97 ? 'больше 95 %' : `≈ ${Math.round(p * 20) * 5} %`);
const rub100 = (kop: number) => rub(Math.round(kop / 10_000) * 10_000);

/* ---------- разбор вопроса ---------- */
export function parsePeriod(text: string, today: string): Period {
  const t = norm(text);
  const month = today.slice(0, 7);
  const monthLabel = (m: string) => { const [y, mm] = m.split('-').map(Number); return `${['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][mm - 1]} ${y}`; };
  const whole = (m: string) => { const mi = monthInfo(m, today); return { from: mi.from, to: mi.to < today ? mi.to : today, label: monthLabel(m), month: m }; };
  if (/сегодня/.test(t)) return { from: today, to: today, label: `сегодня, ${dd(today)}` };
  if (/вчера/.test(t)) { const y = addDays(today, -1); return { from: y, to: y, label: `вчера, ${dd(y)}` }; }
  const n = t.match(/(?:за|последние)\s+(\d{1,3})\s*(?:дн|день|дня)/);
  if (n) { const f = addDays(today, -Number(n[1]) + 1); return { from: f, to: today, label: `последние ${n[1]} дн. (${dd(f)}–${dd(today)})` }; }
  if (/прошл\S* недел/.test(t)) { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; const f = addDays(today, -dow - 7); return { from: f, to: addDays(f, 6), label: `прошлая неделя (${dd(f)}–${dd(addDays(f, 6))})` }; }
  if (/недел/.test(t)) { const f = addDays(today, -6); return { from: f, to: today, label: `последние 7 дней (${dd(f)}–${dd(today)})` }; }
  if (/прошл\S* месяц/.test(t)) { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return whole(d.toISOString().slice(0, 7)); }
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`(?:^|\\s)(?:в|за)\\s+${MONTHS[i]}`).test(t)) {
      const y = Number(today.slice(0, 4)) - (i + 1 > Number(today.slice(5, 7)) ? 1 : 0);
      return whole(`${y}-${String(i + 1).padStart(2, '0')}`);
    }
  }
  return { ...whole(month), label: `${monthLabel(month)} (с ${dd(`${month}-01`)} по ${dd(today)})` };
}

export function parseTopics(text: string): Topic[] {
  const t = norm(text);
  const team = /(отдел\S* продаж|менеджер\S* (по )?продаж)/.test(t);
  let out = TOPIC_RE.filter(([k, re]) => re.test(k === 'sales' ? t.replace(/(отдел\S*|менеджер\S*) (по )?продаж\S*/g, '') : t)).map(([k]) => k);
  if (team && !out.includes('staff')) out.push('staff');
  // «как работают тренеры» — про тренеров, а не про всех сотрудников
  if (out.includes('trainers') && out.includes('staff') && !/(сотрудник|менеджер|персонал|kpi|кпи|отдел)/.test(t)) out = out.filter((x) => x !== 'staff');
  if (!out.length && OVERVIEW_RE.test(t)) return ['sales', 'attendance', 'problems'];
  return out;
}

/** Слова, похожие на имена: всё, что не служебное и не про тему вопроса */
function nameWords(text: string, clubs: Club[]) {
  const clubWords = new Set(clubs.flatMap((c) => norm(c.name).replace(/[«»"]/g, ' ').split(/\s+/)).filter((w) => w.length >= 3 && w !== 'клуб').map((w) => w.slice(0, 4)));
  return norm(text).replace(/[^a-zа-я\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !TOPIC_RE.some(([, re]) => re.test(w)) && !OVERVIEW_RE.test(w) && !clubWords.has(w.slice(0, 4)) && !MONTHS.some((m) => new RegExp(`^${m}`).test(w)));
}
const stemMatch = (word: string, token: string) => { const stem = word.length > 4 ? word.slice(0, word.length - 2) : word.slice(0, 3); return token.startsWith(stem) && token.length - stem.length <= 4; };
function scoreName(words: string[], fullName: string) {
  const tokens = norm(fullName).split(/\s+/);
  return words.filter((w) => tokens.some((tk) => stemMatch(w, tk))).length;
}

export async function visibleClubs(db: Db) {
  return (await db.query(`select id, name, timezone from clubs order by name`)).rows as Club[];
}
export function pickClubs(text: string, clubs: Club[]) {
  const t = norm(text);
  if (/(по сети|все клубы|всем клубам|по всем)/.test(t)) return clubs;
  const hit = clubs.filter((c) => norm(c.name).replace(/[«»"]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && w !== 'клуб')
    .some((w) => new RegExp(`(?:^|[^а-я])${w.slice(0, 4)}`).test(t)));
  return hit.length ? hit : clubs;
}
export async function todayOf(db: Db, tz: string) {
  return (await db.query(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz])).rows[0].d as string;
}

/** Кого упомянул руководитель: сотрудники и (если похоже) клиенты */
async function findWho(db: Db, text: string, clubs: Club[], withClients: boolean): Promise<Who[]> {
  const words = nameWords(text, clubs);
  if (!words.length) return [];
  const staff = (await db.query(`select distinct on (u.id) u.id, u.full_name, r.name as role from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code
    where not u.is_bot and u.status = 'active' and (a.club_id = any($1) or a.club_id is null) and (a.active_to is null or a.active_to >= current_date) order by u.id, r.sort`, [clubs.map((c) => c.id)])).rows;
  const found: (Who & { s: number })[] = staff.map((u) => ({ type: 'employee' as const, id: u.id, label: u.full_name, role: u.role, s: scoreName(words, u.full_name) })).filter((x) => x.s > 0);
  if (withClients) {
    const like = words.map((w) => `%${w.length > 4 ? w.slice(0, w.length - 2) : w.slice(0, 3)}%`);
    const ps = (await db.query(`select id, full_name from persons where home_club_id = any($1) and merged_into_id is null and lower(replace(full_name, 'ё', 'е')) like any($2) limit 50`, [clubs.map((c) => c.id), like])).rows;
    for (const p of ps) { const s = scoreName(words, p.full_name); if (s > 0) found.push({ type: 'client', id: p.id, label: p.full_name, s }); }
  }
  const best = Math.max(0, ...found.map((x) => x.s));
  return found.filter((x) => x.s === best).map(({ s: _s, ...w }) => w);
}

/* ---------- разделы ответа ---------- */
async function dailySales(db: Db, clubIds: string[], from: string, to: string) {
  const rows = (await db.query(`select to_char((p.created_at at time zone c.timezone)::date, 'YYYY-MM-DD') as d,
      sum(case when p.direction = 'in' then p.amount_kop else -p.amount_kop end)::bigint as kop
    from payments p join clubs c on c.id = p.club_id
    where p.kind in ('charge', 'refund') and p.club_id = any($1) and p.created_at >= ($2::date)::timestamp at time zone c.timezone and p.created_at < ($3::date + 1)::timestamp at time zone c.timezone
    group by 1`, [clubIds, from, to])).rows;
  const m = new Map(rows.map((r) => [r.d as string, Number(r.kop)]));
  const out: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(m.get(d) ?? 0);
  return out;
}

async function salesSection(db: Db, clubs: Club[], per: Period, today: string): Promise<Section> {
  const ids = clubs.map((c) => c.id);
  const lines: string[] = []; const tips: string[] = [];
  const sum = async (from: string, to: string) => (await salesFact(db, ids, from, to)).reduce((a, x) => a + x.kop, 0);
  if (per.month) {
    const mi = { ...monthInfo(per.month, today), ...(await lightOf(db, ids)) };
    const upto = mi.current ? today : mi.to;
    const tg = await targets(db, ids, per.month); const sf = await salesFact(db, ids, mi.from, upto); const cf = await clientsFact(db, ids, mi.from, upto);
    const pf = planFact(mi, tg, sf, cf, {});
    const t = pf.total;
    lines.push(`Факт: **${rub(t.factKop)}**${t.planKop ? ` из плана ${rub(t.planKop)} — **${t.percent} %**` : ' (план на месяц не задан)'}. Новых абонементов и подписок: ${t.factClients}.`);
    if (mi.current && t.todayKop) lines.push(`Сегодня: ${rub(t.todayKop)}.`);
    for (const r of pf.rows) lines.push(`• ${r.name}: ${rub(r.factKop)}${r.planKop ? ` из ${rub(r.planKop)} (${r.percent} %)${r.light === 'red' ? ' 🔴' : r.light === 'yellow' ? ' 🟡' : ' 🟢'}` : ''}`);
    if (mi.current && t.planKop && t.dayPlanKop) lines.push(`Чтобы выйти на план, нужно продавать **${rub(t.dayPlanKop)} в день** до конца месяца (осталось ${mi.left} дн.).`);
    const red = pf.rows.filter((r) => r.light === 'red');
    if (red.length) tips.push(`Отстаёт: ${red.map((r) => r.name.toLowerCase()).join(', ')}. Откройте «Кому звонить» по этим категориям и поставьте менеджерам дневную цель на звонки.`);
    if (clubs.length > 1) {
      for (const c of clubs) {
        const cpf = planFact(mi, tg.filter((x) => x.clubId === c.id), sf.filter((x) => x.clubId === c.id), cf.filter((x) => x.clubId === c.id), {});
        lines.push(`• ${c.name}: ${rub(cpf.total.factKop)}${cpf.total.planKop ? ` — ${cpf.total.percent} % плана` : ''}`);
      }
    }
  } else {
    const len = daysBetween(per.from, per.to) + 1;
    const cur = await sum(per.from, per.to); const prev = await sum(addDays(per.from, -len), addDays(per.from, -1));
    lines.push(`Продажи: **${rub(cur)}** (${change(cur, prev)}: было ${rub(prev)}).`);
    if (prev && cur < prev * 0.8) tips.push('Продажи заметно ниже прошлого такого же периода: проверьте, сколько было заявок и встреч — проблема в потоке клиентов или в дожиме.');
  }
  return { title: 'Продажи', lines, tips };
}

async function forecastSection(db: Db, clubs: Club[], today: string): Promise<Section> {
  const lines: string[] = []; const tips: string[] = [];
  const month = today.slice(0, 7);
  const mi = monthInfo(month, today);
  const groups = clubs.length > 1 ? [...clubs.map((c) => [c]), clubs] : [clubs];
  for (const g of groups) {
    const ids = g.map((c) => c.id);
    const label = g.length > 1 ? 'Вся сеть' : g[0].name;
    const tg = await targets(db, ids, month);
    const planKop = tg.filter((x) => x.userId === null).reduce((a, x) => a + x.amountKop, 0);
    const daily = await dailySales(db, ids, mi.from, today);
    const fact = daily.reduce((a, x) => a + x, 0);
    if (!planKop) { lines.push(`• ${label}: план на месяц не задан, прогноз по темпу — ${rub100(fact / Math.max(1, mi.passed) * mi.days)}.`); continue; }
    const c = planChance(daily, fact, planKop, mi.days - mi.passed);
    if (!c) continue;
    lines.push(`• ${label}: к концу месяца ожидаю **${rub100(c.expected)}** (с вероятностью 80 % — от ${rub100(c.low)} до ${rub100(c.high)}). Шанс выполнить план ${rub(planKop)}: **${chance(c.p)}**.`);
    if (g.length === 1 && c.p < 0.5) tips.push(`${label}: план под угрозой (${chance(c.p)}). Не хватает ≈ ${rub100(Math.max(0, planKop - c.expected))} — нужны дополнительные продажи сверх обычного темпа: продления тех, у кого заканчивается абонемент, и горячий список.`);
  }
  // Посещаемость на следующую неделю — по тем же дням недели за последние 4 недели
  const ids = clubs.map((c) => c.id);
  const v = (await db.query(`select to_char((v.visited_at at time zone c.timezone)::date, 'YYYY-MM-DD') as d, count(*)::int as n
    from visits v join clubs c on c.id = v.club_id where v.club_id = any($1) and v.visited_at >= (($2::date - 28)::timestamp at time zone c.timezone) and v.visited_at < ($2::date)::timestamp at time zone c.timezone group by 1`, [ids, today])).rows;
  const byDay = new Map(v.map((r) => [r.d as string, r.n as number]));
  const weeks = [0, 1, 2, 3].map((w) => { let s = 0; for (let i = 0; i < 7; i++) s += byDay.get(addDays(today, -28 + w * 7 + i)) ?? 0; return s; });
  const mean = weeks.reduce((a, x) => a + x, 0) / 4;
  if (mean > 0) {
    const sd = Math.sqrt(weeks.reduce((a, x) => a + (x - mean) ** 2, 0) / 3);
    lines.push(`• Посещения на следующие 7 дней: ожидаю **≈ ${Math.round(mean)}** (с вероятностью 80 % — от ${Math.max(0, Math.round(mean - 1.28 * sd))} до ${Math.round(mean + 1.28 * sd)}).`);
  }
  // Отток по оценке ИИ
  const ch = (await db.query(`select count(*)::int as n, coalesce(sum(score), 0)::float as e from client_scores where club_id = any($1) and kind = 'churn' and segment in ('hot', 'warm')`, [ids])).rows[0];
  if (ch.n) {
    lines.push(`• Отток: в зоне риска ${ch.n} клиентов, по оценке ИИ не продлят ≈ ${Math.round(ch.e)} из них.`);
    tips.push(`Клиенты в зоне риска оттока (${ch.n}): позвоните им до окончания абонемента и предложите продление — это дешевле, чем искать новых.`);
  }
  lines.push(`Прогноз по фактическому темпу за ${mi.passed} дн. ${mi.passed < 7 ? 'Прошло меньше недели — точность низкая.' : mi.passed < 15 ? 'Точность средняя.' : 'Точность высокая.'} Это оценка, не гарантия.`);
  return { title: 'Прогноз', lines, tips };
}

async function attendanceSection(db: Db, clubs: Club[], per: Period, today: string): Promise<Section> {
  const ids = clubs.map((c) => c.id);
  const lines: string[] = []; const tips: string[] = [];
  const len = daysBetween(per.from, per.to) + 1;
  const range = `v.club_id = any($1) and v.visited_at >= ($2::date)::timestamp at time zone c.timezone and v.visited_at < ($3::date + 1)::timestamp at time zone c.timezone`;
  const q = async (from: string, to: string) => (await db.query(`select count(*)::int as n, count(distinct v.person_id)::int as u from visits v join clubs c on c.id = v.club_id where ${range}`, [ids, from, to])).rows[0];
  const cur = await q(per.from, per.to); const prev = await q(addDays(per.from, -len), addDays(per.from, -1));
  lines.push(`Посещений: **${cur.n}** (${change(cur.n, prev.n)}), разных клиентов: ${cur.u}, в среднем ${Math.round((cur.n / len) * 10) / 10} в день.`);
  if (cur.n) {
    const peak = (await db.query(`select extract(isodow from v.visited_at at time zone c.timezone)::int as dow, extract(hour from v.visited_at at time zone c.timezone)::int as h, count(*)::int as n
      from visits v join clubs c on c.id = v.club_id where ${range} group by 1, 2`, [ids, per.from, per.to])).rows;
    const byDow = new Map<number, number>(); const byH = new Map<number, number>();
    for (const r of peak) { byDow.set(r.dow, (byDow.get(r.dow) ?? 0) + r.n); byH.set(r.h, (byH.get(r.h) ?? 0) + r.n); }
    const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    const DOW = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
    const d = top(byDow); const h = top(byH);
    if (d.length > 1) lines.push(`Больше всего приходят: ${DOW[d[0][0]]}; меньше всего — ${DOW[d.at(-1)![0]]}. Пиковый час: ${h[0][0]}:00–${h[0][0] + 1}:00.`);
  }
  const lapsed = (await db.query(`select p.full_name, (current_date - max(v.visited_at)::date) as days
    from memberships m join persons p on p.id = m.person_id left join visits v on v.person_id = m.person_id and v.club_id = m.club_id
    where m.club_id = any($1) and m.status = 'active' and m.kind <> 'guest' and m.starts_on <= $2 and (m.ends_on is null or m.ends_on >= $2)
    group by p.id, p.full_name having max(v.visited_at) is null or max(v.visited_at) < now() - interval '14 days' order by max(v.visited_at) nulls first limit 200`, [ids, today])).rows;
  if (lapsed.length) {
    lines.push(`Перестали ходить (абонемент действует, но не были 14+ дней): **${lapsed.length}**${lapsed.length ? `, например: ${lapsed.slice(0, 4).map((r) => `${r.full_name} (${r.days == null ? 'ни разу' : `${r.days} дн.`})`).join(', ')}` : ''}.`);
    tips.push(`${lapsed.length} клиентов с действующим абонементом перестали ходить — они первые кандидаты на отказ от продления. Раздел «Возврат клиентов» соберёт их в список для звонков.`);
  }
  if (prev.n && cur.n < prev.n * 0.85) tips.push('Посещаемость упала больше чем на 15 %: проверьте расписание (не отменялись ли занятия) и напомните клиентам о групповых через рассылку.');
  return { title: 'Посещаемость', lines, tips };
}

async function trainerRows(db: Db, clubIds: string[], from: string, to: string, trainerId?: string) {
  return (await db.query(`with s as (
      select s.id, s.trainer_id, s.status, s.capacity,
        count(b.id) filter (where b.status = 'attended')::int as att, count(b.id) filter (where b.status = 'no_show')::int as ns,
        count(b.id) filter (where b.status in ('booked', 'attended', 'no_show'))::int as booked
      from class_sessions s join clubs c on c.id = s.club_id left join class_bookings b on b.session_id = s.id
      where s.club_id = any($1) and s.starts_at >= ($2::date)::timestamp at time zone c.timezone and s.starts_at < ($3::date + 1)::timestamp at time zone c.timezone
        and ($4::uuid is null or s.trainer_id = $4) group by s.id)
    select u.id, u.full_name as name, count(*) filter (where s.status <> 'cancelled')::int as n, count(*) filter (where s.status = 'cancelled')::int as cancelled,
      coalesce(sum(s.att), 0)::int as att, coalesce(sum(s.ns), 0)::int as ns, coalesce(sum(s.booked) filter (where s.status <> 'cancelled'), 0)::int as booked,
      coalesce(sum(s.capacity) filter (where s.status <> 'cancelled'), 0)::int as cap
    from s join users u on u.id = s.trainer_id group by u.id, u.full_name order by att desc`, [clubIds, from, to, trainerId ?? null])).rows as
    { id: string; name: string; n: number; cancelled: number; att: number; ns: number; booked: number; cap: number }[];
}
function trainerLine(r: Awaited<ReturnType<typeof trainerRows>>[number]) {
  const fill = pctOf(r.booked, r.cap); const nsr = pctOf(r.ns, r.att + r.ns);
  return { text: `• **${r.name}**: занятий ${r.n}${r.cancelled ? ` (+${r.cancelled} отменено)` : ''}, пришли ${r.att}, не пришли ${r.ns} (${nsr} %), заполняемость ${fill} %`, fill, nsr };
}
async function trainersSection(db: Db, clubs: Club[], per: Period): Promise<Section> {
  const rows = await trainerRows(db, clubs.map((c) => c.id), per.from, per.to);
  const lines: string[] = []; const tips: string[] = [];
  if (!rows.length) return { title: 'Тренеры', lines: ['Занятий с тренерами за этот период нет.'], tips };
  for (const r of rows) {
    const l = trainerLine(r);
    lines.push(l.text);
    if (l.fill < 40 && r.n >= 3) tips.push(`${r.name}: заполняемость ${l.fill} %. Перенесите слабые занятия на пиковые часы или предложите их клиентам, которые ходят в это время.`);
    if (l.nsr >= 20 && r.att + r.ns >= 5) tips.push(`${r.name}: ${l.nsr} % записавшихся не приходят. Включите напоминание за 2 часа и правило списания за неявку в настройках расписания.`);
  }
  return { title: 'Тренеры', lines, tips };
}

async function employeeSection(db: Db, clubs: Club[], per: Period, who: Who): Promise<Section> {
  const ids = clubs.map((c) => c.id);
  const lines: string[] = []; const tips: string[] = [];
  lines.push(`Должность: ${who.role ?? '—'}.`);
  const roles = (await db.query(`select role_code from user_assignments where user_id = $1 and (active_to is null or active_to >= current_date)`, [who.id])).rows.map((r) => r.role_code as string);
  if (roles.some((r) => ['manager', 'rop'].includes(r))) {
    const k = (await kpi(db, ids, per.from, per.to, [who.id]))[0]?.values ?? {};
    const sold = (await salesFact(db, ids, per.from, per.to)).filter((x) => x.userId === who.id && !x.recurring).reduce((a, x) => a + x.kop, 0);
    lines.push(`Продал на **${rub(sold)}**, продаж: ${k.sales ?? 0}. Звонков: ${k.calls ?? 0}, сообщений клиентам: ${k.messages ?? 0}, встреч назначено/пришли: ${k.meetings_set ?? 0}/${k.meetings_done ?? 0}, отказов: ${k.refusals ?? 0}.`);
    if (k.first_response != null) lines.push(`Отвечает на новую заявку в среднем за ${k.first_response} мин.`);
    if ((k.first_response ?? 0) > 15) tips.push(`${who.label} отвечает на заявки дольше 15 минут — за это время клиент уходит к конкурентам. Агент уже передаёт такие заявки другому, но стоит поговорить.`);
    if ((k.meetings_set ?? 0) > 0 && (k.meetings_done ?? 0) / (k.meetings_set ?? 1) < 0.5) tips.push(`${who.label}: на встречи приходит меньше половины. Подтверждение встречи накануне и в день визита обычно поднимает явку.`);
  }
  if (roles.includes('trainer')) {
    const tr = await trainerRows(db, ids, per.from, per.to, who.id);
    if (tr[0]) lines.push(trainerLine(tr[0]).text.replace(/^• /, ''));
    else lines.push('Занятий за период нет.');
  }
  const t = (await db.query(`select count(*) filter (where done_at is not null and done_at >= ($2::date)::timestamp)::int as done,
      count(*) filter (where done_at is null and due_at < now())::int as over, min(due_at) filter (where done_at is null and due_at < now()) as oldest,
      count(*) filter (where done_at is null and due_at >= now())::int as open
    from tasks where assignee_id = $1 and club_id = any($3)`, [who.id, per.from, ids])).rows[0];
  lines.push(`Задачи: выполнено ${t.done}, открыто ${t.open}, **просрочено ${t.over}**${t.oldest ? ` (самая старая — с ${fmtDate(t.oldest, clubs[0].timezone)})` : ''}.`);
  const deals = (await db.query(`select count(*)::int as n from opportunities where owner_id = $1 and status = 'open' and club_id = any($2)`, [who.id, ids])).rows[0].n;
  if (deals) lines.push(`Открытых сделок: ${deals}.`);
  if (t.over >= 3) tips.push(`У сотрудника ${who.label} ${t.over} просроченных задач. Напишите «напомни ${who.label.split(' ')[0]}» — отправлю карточку, или «передай задачи ${who.label.split(' ')[0]} …» — передам другому.`);
  return { title: `Сотрудник: ${who.label}`, lines, tips };
}

async function staffSection(db: Db, clubs: Club[], per: Period): Promise<Section> {
  const ids = clubs.map((c) => c.id);
  const staff = (await db.query(`select distinct on (u.id) u.id, u.full_name from users u join user_assignments a on a.user_id = u.id
    where a.club_id = any($1) and a.role_code in ('manager', 'rop') and u.status = 'active' and not u.is_bot and (a.active_to is null or a.active_to >= current_date) order by u.id`, [ids])).rows;
  const lines: string[] = []; const tips: string[] = [];
  if (!staff.length) return { title: 'Отдел продаж', lines: ['Менеджеров по продажам нет.'], tips };
  const k = await kpi(db, ids, per.from, per.to, staff.map((s) => s.id));
  const sf = await salesFact(db, ids, per.from, per.to);
  const rows = staff.map((s) => ({ name: s.full_name as string, v: k.find((x) => x.userId === s.id)!.values, kop: sf.filter((x) => x.userId === s.id && !x.recurring).reduce((a, x) => a + x.kop, 0) }))
    .sort((a, b) => b.kop - a.kop);
  for (const r of rows) lines.push(`• **${r.name}**: ${rub(r.kop)}, продаж ${r.v.sales ?? 0}, звонков ${r.v.calls ?? 0}, просрочено задач ${r.v.tasks_overdue ?? 0}${r.v.first_response != null ? `, ответ на заявку ${r.v.first_response} мин` : ''}`);
  if (rows.length > 1 && rows[0].kop > 0 && rows.at(-1)!.kop < rows[0].kop * 0.3) tips.push(`Большой разрыв: ${rows[0].name} продаёт в разы больше, чем ${rows.at(-1)!.name}. Разберите звонки лидера на планёрке — это самый быстрый способ подтянуть остальных.`);
  return { title: 'Отдел продаж', lines, tips };
}

async function problemsSection(db: Db, clubs: Club[], today: string): Promise<Section> {
  const ids = clubs.map((c) => c.id);
  const lines: string[] = []; const tips: string[] = [];
  const over = (await db.query(`select u.full_name, count(*)::int as n from tasks t join users u on u.id = t.assignee_id
    where t.club_id = any($1) and t.done_at is null and t.due_at < now() and t.due_at > now() - interval '7 days' group by u.full_name order by n desc limit 8`, [ids])).rows;
  const leads = (await db.query(`select count(*)::int as n from leads where club_id = any($1) and taken_at is null and first_response_at is null and created_at > now() - interval '1 day'`, [ids])).rows[0].n;
  const wait = (await db.query(`select count(*)::int as n from msg_conversations c where c.club_id = any($1) and c.last_inbound_at > now() - interval '1 day'
    and not exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'out' and not m.auto and m.created_at > c.last_inbound_at)`, [ids])).rows[0].n;
  const stuck = (await db.query(`select s.name as stage, count(*)::int as n from opportunities o join pipeline_stages s on s.id = o.stage_id
    where o.club_id = any($1) and o.status = 'open' and coalesce((select max(h.at) from opportunity_stage_history h where h.opportunity_id = o.id), o.created_at) < now() - interval '7 days'
    group by s.name, s.sort order by s.sort`, [ids])).rows;
  lines.push(`• Заявок без ответа за сутки: **${leads}**`);
  lines.push(`• Клиентов ждут ответа в переписке: **${wait}**`);
  lines.push(over.length ? `• Просроченные задачи (за неделю):\n${over.map((o) => `   – ${o.full_name}: ${o.n}`).join('\n')}` : '• Просроченных задач нет');
  const stuckN = stuck.reduce((a, x) => a + x.n, 0);
  const lateProc = (await db.query(`select count(*)::int as n from processes where club_id = any($1) and status = 'active' and due_at < now()`, [ids])).rows[0].n;
  if (lateProc) { lines.push(`• Бизнес-процессы вышли за срок: **${lateProc}** (напишите «процессы» — покажу, где застряли)`); tips.push('Процессы, вышедшие за срок, обычно стоят на одном человеке: откройте «Бизнес-процессы» и передайте застрявший шаг другому.'); }
  if (stuckN) lines.push(`• Сделки без движения больше 7 дней: **${stuckN}** (${stuck.map((s) => `${s.stage} — ${s.n}`).join(', ')})`);
  const mi = monthInfo(today.slice(0, 7), today);
  const lt = { ...mi, ...(await lightOf(db, ids)) };
  const tg = await targets(db, ids, mi.from.slice(0, 7)); const sf = await salesFact(db, ids, mi.from, today); const cf = await clientsFact(db, ids, mi.from, today);
  const pf = planFact(lt, tg, sf, cf, {});
  if (pf.total.light === 'red') lines.push(`• План продаж отстаёт: ${pf.total.percent} % при прошедших ${Math.round((mi.passed / mi.days) * 100)} % месяца 🔴`);
  if (leads) tips.push('Заявки без ответа — потерянные деньги: каждая минута снижает шанс продажи. Проверьте, кто на смене, и включите авто-передачу заявки через 10 минут (уже работает, если не выключена в настройках агента).');
  if (wait) tips.push(`${wait} клиентов ждут ответа в переписке. Попросите РОПа разобрать раздел «Переписка» до конца дня.`);
  if (over[0]?.n >= 3) tips.push(`Больше всего просрочек у сотрудника ${over[0].full_name} (${over[0].n}). Можно написать мне «напомни ${over[0].full_name.split(' ')[0]}» или «передай задачи ${over[0].full_name.split(' ')[0]} …».`);
  if (stuckN) tips.push(`Сделки без движения неделю почти не закрываются сами. Поставьте менеджерам задачу: по каждой — звонок и решение «двигаем или закрываем с причиной».`);
  return { title: 'Что горит сейчас', lines, tips };
}

async function clientSection(db: Db, ctx: Ctx, yandex: YandexConfig | null, who: Who, clubs: Club[]): Promise<Section> {
  const opp = (await db.query(`select id from opportunities where person_id = $1 order by (status = 'open') desc, updated_at desc limit 1`, [who.id])).rows[0];
  if (opp) {
    const b = await situationBrief(db, ctx, yandex, 'opportunity', opp.id);
    return { title: `Клиент: ${who.label}`, lines: [b.text.length > 2600 ? `${b.text.slice(0, 2600)}…\n\nПолностью — кнопка «Коротко о ситуации» в карточке клиента.` : b.text], tips: [] };
  }
  const tz = clubs[0].timezone;
  const m = (await db.query(`select product_name, ends_on, status from memberships where person_id = $1 order by created_at desc limit 2`, [who.id])).rows;
  const v = (await db.query(`select count(*) filter (where visited_at > now() - interval '30 days')::int as n30, max(visited_at) as last from visits where person_id = $1`, [who.id])).rows[0];
  const lines = [
    m.length ? `Абонемент: ${m[0].product_name}${m[0].ends_on ? `, до ${fmtDate(m[0].ends_on, tz, false)}` : ''}${m[0].status === 'cancelled' ? ' (отменён)' : ''}.` : 'Абонементов нет.',
    `Посещений за 30 дней: ${v.n30}${v.last ? `, последнее — ${fmtDate(v.last, tz)}` : ''}.`,
  ];
  const cl = await clientClasses(db, who.id);
  if (cl.length) lines.push('', ...classesText(cl, tz));
  return { title: `Клиент: ${who.label}`, lines, tips: [] };
}

/* ---------- вмешательство ---------- */
async function remindEmployee(db: Db, ctx: Ctx, who: Who, clubs: Club[]) {
  const over = (await db.query(`select id, title, club_id from tasks where assignee_id = $1 and done_at is null and due_at < now() and club_id = any($2) order by due_at`, [who.id, clubs.map((c) => c.id)])).rows;
  const me = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0]?.full_name ?? 'Руководитель';
  const clubId = over[0]?.club_id ?? clubs[0].id;
  const body = over.length ? `Просрочено задач: ${over.length}. Первые: ${over.slice(0, 3).map((t) => `«${t.title}»`).join(', ')}. Выполните или перенесите срок сегодня.` : 'Просроченных задач нет — проверьте открытые задачи на сегодня.';
  await card(db, clubId, [who.id], { kind: 'agent_nudge', title: `${me} просит разобрать задачи`, body, objectType: over[0] ? 'task' : null, objectId: over[0]?.id ?? null, actions: ['open'], link: { tab: 'tasks' } });
  await audit(db, ctx, 'agent.owner_nudge', 'user', who.id, null, { overdue: over.length });
  return `Готово: отправил сотруднику **${who.label}** карточку в колокольчик${over.length ? ` — просрочено задач: ${over.length}` : ' (просрочек нет, попросил проверить задачи на сегодня)'}.`;
}

async function reassignWork(db: Db, ctx: Ctx, from: Who, to: Who | null, clubs: Club[]) {
  const over = (await db.query(`select id, opportunity_id, club_id from tasks where assignee_id = $1 and done_at is null and due_at < now() and club_id = any($2)`, [from.id, clubs.map((c) => c.id)])).rows;
  if (!over.length) return `У сотрудника **${from.label}** нет просроченных задач — передавать нечего.`;
  let target: Who;
  if (to) target = to;
  else {
    const u = await leastLoaded(db, over[0].club_id, from.id);
    if (!u) return 'Не нашёл, кому передать: в клубе нет другого свободного менеджера. Напишите, кому: «передай задачи Марии Ксении».';
    target = { type: 'employee', id: u.id, label: u.full_name };
  }
  const opps = new Set<string>();
  for (const t of over) {
    if (t.opportunity_id) { if (!opps.has(t.opportunity_id)) { opps.add(t.opportunity_id); await reassignOpenWork(db, { opportunityId: t.opportunity_id, from: from.id, to: target.id }); } }
    else await db.query(`update tasks set assignee_id = $2 where id = $1`, [t.id, target.id]);
  }
  await card(db, over[0].club_id, [target.id], { kind: 'agent_reassign', title: `Вам переданы задачи сотрудника ${from.label}`, body: `Просроченных задач: ${over.length}. Они уже в разделе «Задачи» — начните с самых старых.`, objectType: 'task', objectId: over[0].id, actions: ['open'], link: { tab: 'tasks' } });
  await card(db, over[0].club_id, [from.id], { kind: 'agent_reassign', title: `Ваши просроченные задачи переданы: ${target.label}`, body: `Руководитель передал ${over.length} просроченных задач.`, objectType: null, objectId: null, actions: ['open'], link: { tab: 'tasks' } });
  await audit(db, ctx, 'agent.owner_reassign', 'user', from.id, null, { to: target.id, tasks: over.length });
  return `Готово: ${over.length} просроченных задач сотрудника **${from.label}**${opps.size ? ` (и сделки по ним: ${opps.size})` : ''} переданы — **${target.label}**. Оба получили карточки.`;
}

/* ---------- нейросеть: разбор и советы ---------- */
const PARSE_PROMPT = `Ты разбираешь вопрос собственника сети фитнес-клубов своему ИИ-помощнику в CRM.
Верни JSON {topics, period, names, action, clarify}:
topics — массив из: sales (продажи, план, выручка), forecast (прогноз, вероятность), attendance (посещаемость), trainers (тренеры, занятия), staff (сотрудники, KPI), client (конкретный клиент), problems (проблемы, что горит, узкие места), advice (советы);
period — как в вопросе словами по-русски («сегодня», «за неделю», «прошлый месяц», «в октябре») или "";
names — имена людей из вопроса, как написаны; action — remind (напомнить сотруднику), reassign (передать его задачи), или null;
clarify — если вопрос непонятен, короткий уточняющий вопрос по-русски, иначе null.`;
const ADVICE_PROMPT = `Ты — опытный управляющий сетью фитнес-клубов и советник собственника. Ниже данные из CRM по его вопросу.
Дай 3–5 конкретных советов, что сделать на этой неделе, по одному-два предложения. Опирайся только на эти данные, цифры не выдумывай.
Пиши по-русски, простыми словами, каждый совет с новой строки, начиная с «• ». Главное в совете выдели **жирным**.`;

const OWNER_HELP = `Как руководителю мне можно задавать любые вопросы словами:
• «как продажи в этом месяце?», «выполним план?» — план-факт и прогноз с вероятностью;
• «посещаемость за неделю», «как работают тренеры» — посещения, пиковые часы, заполняемость;
• «как работает Мария?», «покажи отдел продаж» — показатели сотрудника и команды;
• «что с клиентом Анна Чатова» — коротко о ситуации по клиенту;
• «что горит», «где проблемы» — узкие места и что с ними сделать;
• «разбор недели» — узкие места прошлой недели по сравнению с позапрошлой и что сделать (сам присылаю по понедельникам в 9:00);
• «напомни Марии», «передай задачи Марии Ксении» — вмешаюсь сам;
• «создай процесс Жалоба: администратор принимает за час; управляющий разбирается за сутки…», «процессы» — бизнес-процессы;
• «назначь собрание: отдел продаж и Ким, завтра с 10 до 18, на час, тема: план» — подберу время с наименьшими потерями и разошлю приглашения; «кто подтвердил» — ответы участников.
Если вопрос понятен не до конца — переспрошу.`;
export { OWNER_HELP };

export const isLeader = (ctx: Ctx) => can(ctx, P.dashView) || can(ctx, P.crmViewAll);

export async function setPending(db: Db, ctx: Ctx, p: Pending | null) {
  await db.query(`insert into agent_chat_state(user_id, tenant_id, pending) values ($1,$2,$3) on conflict (user_id) do update set pending = $3, updated_at = now()`,
    [ctx.userId, ctx.tenantId, p ? JSON.stringify(p) : null]);
}
export async function getPending(db: Db, ctx: Ctx) {
  return (await db.query(`select pending from agent_chat_state where user_id = $1 and updated_at > now() - interval '30 minutes'`, [ctx.userId])).rows[0]?.pending as Pending | null | undefined;
}

const TOPIC_MENU: Topic[] = ['sales', 'forecast', 'attendance', 'trainers', 'staff', 'problems'];
const ACTION_RE = /^(напомни|поторопи|пни|передай|передать|переназначь)\s+/i;

/** Ответ на уточнение («1», «Волкову», «посещаемость»), если помощник ждал его */
export async function ownerPendingReply(db: Db, ctx: Ctx, text: string, yandex: YandexConfig | null): Promise<string | null> {
  const p = await getPending(db, ctx);
  if (!p || (p.kind !== 'topic' && p.kind !== 'who')) return null;
  const t = norm(text.trim());
  if (p.kind === 'topic') {
    const n = Number(t.match(/^(\d)\b/)?.[1] ?? 0);
    const topic = n >= 1 && n <= TOPIC_MENU.length ? TOPIC_MENU[n - 1] : parseTopics(text)[0];
    if (!topic) return null;
    await setPending(db, ctx, null);
    return ownerAnswer(db, ctx, `${p.text} ${text}`, yandex, { topics: [topic] });
  }
  const opts = p.options ?? [];
  const n = Number(t.match(/^(\d)\b/)?.[1] ?? 0);
  const pick = n >= 1 && n <= opts.length ? opts[n - 1] : opts.find((o) => nameWords(text, []).some((w) => norm(o.label).split(/\s+/).some((tk) => stemMatch(w, tk))));
  if (!pick) return null;
  await setPending(db, ctx, null);
  return ownerAnswer(db, ctx, p.text, yandex, { who: pick });
}

/** Главный ответ помощника руководителю */
export async function ownerAnswer(db: Db, ctx: Ctx, text: string, yandex: YandexConfig | null, force: { topics?: Topic[]; who?: Who } = {}): Promise<string> {
  const all = await visibleClubs(db);
  if (!all.length) return 'Не вижу ни одного клуба, к которому у вас есть доступ.';
  const clubs = pickClubs(text, all);
  const today = await todayOf(db, clubs[0].timezone);
  let topics = force.topics ?? parseTopics(text);
  const action = ACTION_RE.test(text.trim()) ? (/^(напомни|поторопи|пни)/i.test(text.trim()) ? 'remind' : 'reassign') : null;
  let periodText = text;
  // Нейросеть помогает, когда правила не поняли тему
  if (!topics.length && !action && !force.who && yandex) {
    try {
      const r = await ygptJson<{ topics?: Topic[]; period?: string; names?: string[]; action?: string | null; clarify?: string | null }>(yandex, PARSE_PROMPT, noContacts(text).slice(0, 1000), 300);
      if (r?.topics?.length) topics = r.topics.filter((x) => x in TOPIC_NAME);
      if (r?.period) periodText = `${text} ${r.period}`;
      if (!topics.length && r?.clarify && !(await findWho(db, text, clubs, true)).length) {
        await setPending(db, ctx, { kind: 'topic', text });
        return `${r.clarify}\n\nИли выберите номер: ${TOPIC_MENU.map((x, i) => `${i + 1} — ${TOPIC_NAME[x]}`).join(', ')}.`;
      }
    } catch { /* по правилам */ }
  }
  const per = parsePeriod(periodText, today);

  // Кого упомянули
  let people: Who[] = force.who ? [force.who] : [];
  if (!force.who) {
    const withClients = topics.includes('client') || /клиент/.test(norm(text)) || (!topics.length && !action) || topics.every((x) => x === 'problems' || x === 'advice');
    people = await findWho(db, text, clubs, withClients && !action);
    if (action) people = people.filter((p) => p.type === 'employee');
  }
  if (action === 'remind' || action === 'reassign') {
    const ordered = await orderedEmployees(db, text, clubs);
    if (!ordered.length) return 'Не понял, о каком сотруднике речь. Напишите имя и фамилию: «напомни Марии Волковой».';
    if (ordered[0].length > 1) {
      await setPending(db, ctx, { kind: 'who', text: `${text.trim().split(/\s+/)[0]} `, options: ordered[0] });
      return `Уточните, кого вы имеете в виду:\n${ordered[0].map((o, i) => `${i + 1} — ${o.label}${o.role ? ` (${o.role})` : ''}`).join('\n')}\n\nНапишите номер.`;
    }
    if (action === 'remind') return remindEmployee(db, ctx, ordered[0][0], clubs);
    return reassignWork(db, ctx, ordered[0][0], ordered[1]?.length === 1 ? ordered[1][0] : null, clubs);
  }
  if (force.who && /^(напомни|поторопи|пни)/i.test(text.trim())) return remindEmployee(db, ctx, force.who, clubs);
  if (force.who && /^(передай|передать|переназначь)/i.test(text.trim())) return reassignWork(db, ctx, force.who, null, clubs);

  // Несколько людей с одним именем — уточняем
  if (people.length > 1) {
    await setPending(db, ctx, { kind: 'who', text, options: people.slice(0, 6) });
    return `Нашёл несколько человек — уточните, о ком вы:\n${people.slice(0, 6).map((o, i) => `${i + 1} — ${o.label} (${o.type === 'client' ? 'клиент' : o.role ?? 'сотрудник'})`).join('\n')}\n\nНапишите номер.`;
  }
  const who = people[0];
  if (who && !topics.length) topics = [who.type === 'client' ? 'client' : 'staff'];
  if (!topics.length) {
    await setPending(db, ctx, { kind: 'topic', text });
    return `Не до конца понял вопрос. О чём рассказать?\n${TOPIC_MENU.map((x, i) => `${i + 1} — ${TOPIC_NAME[x]}`).join('\n')}\n\nНапишите номер или переформулируйте. Можно сразу несколько тем: «продажи и посещаемость за неделю».`;
  }
  await setPending(db, ctx, null);

  const clubLabel = clubs.length === all.length && all.length > 1 ? 'вся сеть' : clubs.map((c) => c.name).join(', ');
  const sections: Section[] = [];
  const onlyAdvice = topics.length === 1 && topics[0] === 'advice';
  const want = new Set<Topic>(onlyAdvice ? ['sales', 'forecast', 'attendance', 'problems'] : topics);
  if (want.has('client')) {
    if (who?.type === 'client') sections.push(await clientSection(db, ctx, yandex, who, clubs));
    else sections.push({ title: 'Клиент', lines: ['Не нашёл клиента с таким именем. Напишите имя и фамилию, как в карточке.'], tips: [] });
  }
  if (want.has('staff')) sections.push(who?.type === 'employee' ? await employeeSection(db, clubs, per, who) : await staffSection(db, clubs, per));
  if (want.has('sales')) sections.push(await salesSection(db, clubs, per, today));
  if (want.has('forecast')) sections.push(await forecastSection(db, clubs, today));
  if (want.has('attendance')) sections.push(await attendanceSection(db, clubs, per, today));
  if (want.has('trainers')) sections.push(await trainersSection(db, clubs, per));
  if (want.has('problems')) sections.push(await problemsSection(db, clubs, today));

  const tipsRule = [...new Set(sections.flatMap((s) => s.tips))].slice(0, 5);
  const body = sections.filter((s) => !onlyAdvice || s.tips.length).map((s) => `**${s.title}**\n${s.lines.join('\n')}`);
  let advice = tipsRule.map((x) => `• ${x}`).join('\n');
  if (yandex && (want.has('advice') || tipsRule.length)) {
    try {
      const facts = noContacts(sections.map((s) => `${s.title}\n${s.lines.join('\n')}`).join('\n\n')).slice(0, 6000);
      const llm = (await ygptComplete(yandex, ADVICE_PROMPT, `Вопрос: ${noContacts(text)}\n\n${facts}`, { temperature: 0.3, maxTokens: 900 })).trim();
      if (llm) advice = llm;
    } catch { /* советы по правилам */ }
  }
  // Сразу ответ, без пересказа вопроса (просьба Андрея 14.11.2026); клуб и период — коротко в заголовке первого раздела
  const ctxLabel = want.has('client') && !want.has('sales') && !want.has('attendance') && !want.has('staff') ? '' : ` · ${clubLabel}, ${per.label}`;
  const shown = onlyAdvice ? [] : body.map((b, i) => (i === 0 ? b.replace(/^\*\*(.+?)\*\*/, `**$1**${ctxLabel}`) : b));
  const parts = [...shown, advice ? `**Советы**${onlyAdvice ? ctxLabel : ''}\n${advice}` : '', onlyAdvice && !advice ? 'Серьёзных проблем по данным не вижу: план, посещаемость и задачи в норме.' : ''].filter(Boolean);
  return fitAnswer(parts.join('\n\n'));
}

/** Сотрудники в порядке упоминания (для «передай задачи Марии Ксении»): для каждого слова-имени — подходящие сотрудники */
export async function orderedEmployees(db: Db, text: string, clubs: Club[]): Promise<Who[][]> {
  const words = nameWords(text, clubs);
  const staff = (await db.query(`select distinct on (u.id) u.id, u.full_name, r.name as role from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code
    where not u.is_bot and u.status = 'active' and (a.club_id = any($1) or a.club_id is null) and (a.active_to is null or a.active_to >= current_date) order by u.id, r.sort`, [clubs.map((c) => c.id)])).rows;
  const out: Who[][] = [];
  const used = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    let m = staff.filter((u) => norm(u.full_name).split(/\s+/).some((tk) => stemMatch(words[i], tk)));
    // «Марии Волковой» — два слова про одного человека
    if (m.length > 1 && words[i + 1]) {
      const both = m.filter((u) => norm(u.full_name).split(/\s+/).some((tk) => stemMatch(words[i + 1], tk)));
      if (both.length) { m = both; i++; }
    } else if (m.length === 1 && words[i + 1] && norm(m[0].full_name).split(/\s+/).some((tk) => stemMatch(words[i + 1], tk))) i++;
    m = m.filter((u) => !used.has(u.id));
    if (!m.length) continue;
    if (m.length === 1) used.add(m[0].id);
    out.push(m.map((u) => ({ type: 'employee' as const, id: u.id, label: u.full_name, role: u.role })));
  }
  return out;
}

function fitAnswer(s: string, max = 3900) {
  if (s.length <= max) return s;
  const lines = s.split('\n'); const out: string[] = []; let n = 0;
  for (const l of lines) { if (n + l.length + 1 > max - 60) break; out.push(l); n += l.length + 1; }
  return `${out.join('\n')}\n\n…ответ длинный — спросите отдельно по одной теме.`;
}

