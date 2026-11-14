// Отдел продаж: процессы из списка Андрея «ИИ в управлении продажами» (11.11.2026), этап А — всё, что работает на данных системы,
// без телефонии, GPU и живой 1С:
//  — заявки: «Беру в работу», напоминание менеджеру через 5 мин, сигнал РОПу через 15 мин, отчёт за день;
//  — горячее окно продлений (этот и следующий месяц, не продлил) с отметкой «уже звонили»;
//  — новички за 45 дней, у кого меньше 4 визитов в первый месяц (по понедельникам РОПу);
//  — стоп-лист «не звонить» с причинами, теги, склейка дублей;
//  — списки обзвона на каждого менеджера: новые, продления, база; отдельно рекурренты и «ни рубля»;
//  — воронка «обращение → в работе → встреча → дошёл → продажа» по каналам и менеджерам, источники и «без источника»;
//  — недельная сводка клуба и вечерний маркетинг-дайджест.
// Сигналы и сводки приходят сотрудникам внутри CRM: колокольчик «Уведомления» в шапке и push приложения.
// Решение Андрея 12.11.2026: вся связь — в CRM, без Telegram-групп и личных сообщений бота.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { maskPhone } from './crm.ts';
import { sendTable } from './dash.ts';
import { addDays, clubToday } from './memberships.ts';
import type { Cell } from '../lib/xlsx.ts';

type Actor = { tenantId: string; userId: string | null; ip?: string };
const uuid = (s?: string | null) => !!s && /^[0-9a-f-]{36}$/i.test(s);
const isoDate = (s?: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const onlyMine = (ctx: Ctx) => !can(ctx, P.crmViewAll);
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
const ruDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/* ---------- справочники ---------- */
export const BLOCK_REASONS: Record<string, string> = {
  staff: 'Сотрудник', trainer: 'Тренер', moved: 'Переехал', refund: 'Был возврат', irrelevant: 'Неактуально', unfit: 'Неформат',
  bad_number: 'Битый номер', refused: 'Отказ', postponed: 'Отложено до даты', do_not_call: 'Просил не звонить',
};
export const AUTO_TAGS = ['новичок', 'продление', 'рекуррент', 'ни рубля', 'бывший', 'мало визитов', 'лид'] as const;

/* ---------- настройки ---------- */
export type OpsSettings = { remindMinutes: number; escalateMinutes: number; newbieDays: number; newbieMinVisits: number; excludeLowVisits: boolean };
const DEFAULTS: OpsSettings = { remindMinutes: 5, escalateMinutes: 15, newbieDays: 45, newbieMinVisits: 4, excludeLowVisits: true };
export async function opsSettings(db: Db, clubId: string): Promise<OpsSettings> {
  const r = (await db.query('select * from sales_ops_settings where club_id = $1', [clubId])).rows[0];
  if (!r) return { ...DEFAULTS };
  return { remindMinutes: r.remind_minutes, escalateMinutes: r.escalate_minutes, newbieDays: r.newbie_days, newbieMinVisits: r.newbie_min_visits,
    excludeLowVisits: r.exclude_low_visits };
}

/** Сотрудники клуба в ролях (действующие назначения) */
export async function staffOf(db: Db, clubId: string, roles: string[]) {
  return (await db.query(`select distinct u.id, u.full_name as name, a.role_code as role from users u join user_assignments a on a.user_id = u.id
    where (a.club_id = $1 or (a.club_id is null and a.role_code = 'owner')) and a.role_code = any($2) and u.status = 'active'
      and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date) order by u.full_name`, [clubId, roles])).rows as { id: string; name: string; role: string }[];
}

/** Отправить один раз за период (клуб, вид, период). Возвращает false, если уже отправляли */
async function once(db: Db, clubId: string, kind: string, period: string) {
  const r = await db.query(`insert into sales_ops_sent(tenant_id, club_id, kind, period) values (app_tenant(), $1, $2, $3) on conflict do nothing`, [clubId, kind, period]);
  return !!r.rowCount;
}
export type NoteLink = { tab: string; p?: Record<string, string> };
/** Уведомление сотрудникам внутри CRM (колокольчик + push приложения). Возвращает число получателей */
export async function notify(db: Db, clubId: string | null, userIds: string[], kind: string, title: string, body: string | null, link: NoteLink | null) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;
  await db.query(`insert into staff_notifications(tenant_id, club_id, user_id, kind, title, body, link)
    select app_tenant(), $1, u, $3, $4, $5, $6 from unnest($2::uuid[]) u`, [clubId, ids, kind, title, body, link ? JSON.stringify(link) : null]);
  return ids.length;
}

/* ---------- стоп-лист ---------- */
/** SQL-условие «можно звонить»: нет действующей отметки стоп-листа (у «отложено» срок ещё не прошёл) */
const callable = (personCol: string, todayParam: string) =>
  `not exists (select 1 from person_call_blocks cb where cb.person_id = ${personCol} and cb.removed_at is null and (cb.until is null or cb.until > ${todayParam}::date))`;

/* ========== 1. Заявки и скорость ответа ========== */
// Отсчёт ведётся с момента, когда заявку должны были начать обрабатывать: для заявки в нерабочее время — с начала смены
const LEAD_START = `(l.first_response_due_at - make_interval(mins => c.first_response_minutes))`;
const LEADS: NoteLink = { tab: 'sales', p: { view: 'leads' } };
const RENEWALS: NoteLink = { tab: 'sales', p: { view: 'renewals' } };
const LEAD_DONE = `least(coalesce(l.taken_at, 'infinity'::timestamptz), coalesce(l.first_response_at, 'infinity'::timestamptz))`;

export async function processLeadSla(db: Db, actor: Actor, clubId: string) {
  const s = await opsSettings(db, clubId);
  const rows = (await db.query(`select l.id, l.person_id, l.assigned_to, l.reminded_at, l.escalated_at, p.full_name, ls.name as source,
      extract(epoch from now() - ${LEAD_START}) / 60 as waited
    from leads l join clubs c on c.id = l.club_id join persons p on p.id = l.person_id left join lead_sources ls on ls.id = l.source_id
    where l.club_id = $1 and l.taken_at is null and l.first_response_at is null and l.created_at > now() - interval '2 days'
      and (l.reminded_at is null or l.escalated_at is null) and now() >= ${LEAD_START} + make_interval(mins => $2)`, [clubId, s.remindMinutes])).rows;
  let reminded = 0; let escalated = 0;
  for (const l of rows) {
    const waited = Math.floor(Number(l.waited));
    const who = `${l.full_name}${l.source ? ` (${l.source})` : ''}`;
    if (!l.reminded_at) {
      const to = l.assigned_to ? [l.assigned_to as string] : (await staffOf(db, clubId, ['manager'])).map((u) => u.id);
      await notify(db, clubId, to, 'lead_remind', `Заявка ждёт ${waited} мин`, `${who}: нажмите «Беру в работу»`, LEADS);
      await db.query('update leads set reminded_at = now() where id = $1', [l.id]);
      reminded++;
    }
    if (!l.escalated_at && waited >= s.escalateMinutes) {
      const heads = await staffOf(db, clubId, ['rop']);
      const to = heads.length ? heads : await staffOf(db, clubId, ['gm']);
      const mgr = l.assigned_to ? (await db.query('select full_name from users where id = $1', [l.assigned_to])).rows[0]?.full_name : null;
      await notify(db, clubId, to.map((u) => u.id), 'lead_escalate', `Заявка ${waited} мин без ответа`, `${who}. ${mgr ? `Ответственный: ${mgr}` : 'Ответственного нет'}`, LEADS);
      // Задача руководителю: приходит push на телефон и видна в «Задачах»
      if (to[0]) await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, lead_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,$5,'other',$6, now(), null)`,
        [actor.tenantId, clubId, to[0].id, l.person_id, l.id, `Заявка ${s.escalateMinutes}+ мин без ответа${mgr ? ` (${mgr})` : ''}: проверить, кто берёт`]);
      await db.query('update leads set escalated_at = now() where id = $1', [l.id]);
      escalated++;
    }
  }
  return { reminded, escalated };
}

/** Заявки за день по клубу: сколько, сколько в норме, сколько дольше нормы, по менеджерам */
export async function leadSpeed(db: Db, clubId: string, day: string, userId?: string) {
  const s = await opsSettings(db, clubId);
  const rows = (await db.query(`select l.id, l.assigned_to, u.full_name as manager, l.escalated_at is not null as escalated,
      case when ${LEAD_DONE} = 'infinity' then null else extract(epoch from ${LEAD_DONE} - ${LEAD_START}) / 60 end as minutes,
      extract(epoch from now() - ${LEAD_START}) / 60 as waiting
    from leads l join clubs c on c.id = l.club_id left join users u on u.id = l.assigned_to
    where l.club_id = $1 and (l.created_at at time zone c.timezone)::date = $2::date and ($3::uuid is null or l.assigned_to = $3 or l.assigned_to is null)`,
  [clubId, day, userId ?? null])).rows;
  type Agg = { id: string | null; name: string; total: number; inNorm: number; late: number; waiting: number; escalated: number; sum: number; cnt: number };
  const agg = (list: typeof rows, id: string | null, name: string): Agg => {
    const done = list.filter((r) => r.minutes !== null).map((r) => Math.max(0, Number(r.minutes)));
    return { id, name, total: list.length, inNorm: done.filter((m) => m <= s.remindMinutes).length,
      late: done.filter((m) => m > s.remindMinutes).length + list.filter((r) => r.minutes === null && Number(r.waiting) > s.remindMinutes).length,
      waiting: list.filter((r) => r.minutes === null).length, escalated: list.filter((r) => r.escalated).length,
      sum: done.reduce((a, b) => a + b, 0), cnt: done.length };
  };
  const byId = new Map<string, typeof rows>();
  for (const r of rows) { const k = r.assigned_to ?? ''; byId.set(k, [...(byId.get(k) ?? []), r]); }
  const fin = (a: Agg) => ({ id: a.id, name: a.name, total: a.total, inNorm: a.inNorm, late: a.late, waiting: a.waiting, escalated: a.escalated, avgMinutes: a.cnt ? Math.round((a.sum / a.cnt) * 10) / 10 : null });
  return {
    day, norm: s.remindMinutes, escalateAfter: s.escalateMinutes,
    total: fin(agg(rows, null, 'Всего')),
    managers: [...byId.entries()].map(([k, list]) => fin(agg(list, k || null, k ? list[0].manager : 'Без ответственного'))).sort((a, b) => b.total - a.total),
  };
}

/** Заявки, которые ждут «Беру в работу» */
async function waitingLeads(db: Db, clubId: string, userId?: string) {
  return (await db.query(`select l.id, l.person_id as "personId", p.full_name as name, ls.name as source, l.assigned_to as "assignedTo", u.full_name as manager,
      l.created_at as "createdAt", round(extract(epoch from now() - ${LEAD_START}) / 60)::int as waited, l.escalated_at is not null as escalated,
      (select pc.value from person_contacts pc where pc.person_id = p.id and pc.type = 'phone' order by pc.is_primary desc limit 1) as phone
    from leads l join clubs c on c.id = l.club_id join persons p on p.id = l.person_id left join lead_sources ls on ls.id = l.source_id left join users u on u.id = l.assigned_to
    where l.club_id = $1 and l.taken_at is null and l.first_response_at is null and l.created_at > now() - interval '2 days'
      and ($2::uuid is null or l.assigned_to = $2 or l.assigned_to is null)
    order by l.created_at`, [clubId, userId ?? null])).rows.map((r) => ({ ...r, phone: maskPhone(r.phone) }));
}

/* ========== 2. Горячее окно продлений и новички ========== */
/** Абонементы, которые заканчиваются в этом и следующем месяце (или уже закончились в этом), а клиент ещё не продлил */
export async function renewalWindow(db: Db, clubId: string, today: string, userId?: string) {
  const from = `${today.slice(0, 7)}-01`;
  const nm = new Date(`${from}T00:00:00Z`); nm.setUTCMonth(nm.getUTCMonth() + 2); nm.setUTCDate(0);
  const to = nm.toISOString().slice(0, 10);
  const rows = (await db.query(`select m.id, m.person_id as "personId", p.full_name as name, m.product_name as product, m.ends_on::text as "endsOn",
      (select pc.value from person_contacts pc where pc.person_id = p.id and pc.type = 'phone' order by pc.is_primary desc limit 1) as phone,
      coalesce(op.owner_id, case when sa.ok then m.created_by end) as "ownerId",
      coalesce(ou.full_name, case when sa.ok then su.full_name end) as owner,
      (select max(x.at) from (select cl.started_at as at from calls cl where cl.person_id = m.person_id
         union all select t.done_at from tasks t where t.person_id = m.person_id and t.kind = 'call' and t.done_at is not null) x) as "lastCallAt",
      (select count(*) from visits v where v.person_id = m.person_id and v.visited_at > now() - interval '30 days')::int as "visits30"
    from memberships m join persons p on p.id = m.person_id and p.merged_into_id is null
    left join lateral (select o.owner_id from opportunities o join users uu on uu.id = o.owner_id and uu.status = 'active'
                       where o.person_id = m.person_id and o.club_id = m.club_id order by o.updated_at desc limit 1) op on true
    left join users ou on ou.id = op.owner_id
    left join users su on su.id = m.created_by
    cross join lateral (select exists (select 1 from user_assignments a join users au on au.id = a.user_id and au.status = 'active' where a.user_id = m.created_by and a.club_id = m.club_id
                        and a.role_code in ('manager', 'rop') and (a.active_to is null or a.active_to >= current_date)) as ok) sa
    where m.club_id = $1 and m.status = 'active' and m.kind <> 'subscription' and m.kind <> 'guest' and m.ends_on between $2::date and $3::date and m.starts_on <= $4::date
      and not exists (select 1 from memberships n where n.person_id = m.person_id and n.id <> m.id and n.status = 'active'
                      and (n.renewed_from_id = m.id or (n.created_at > m.created_at and coalesce(n.ends_on, n.starts_on) > m.ends_on)))
      and ${callable('m.person_id', '$4')}
    order by m.ends_on, p.full_name`, [clubId, from, to, today])).rows;
  const list = rows.filter((r) => !userId || r.ownerId === userId || r.ownerId === null)
    .map((r) => ({ ...r, phone: maskPhone(r.phone), expired: r.endsOn < today, called: !!r.lastCallAt && new Date(r.lastCallAt).getTime() > Date.now() - 14 * 86_400_000 }));
  return { from, to, list, stats: { total: list.length, thisMonth: list.filter((r) => r.endsOn.slice(0, 7) === today.slice(0, 7)).length, notCalled: list.filter((r) => !r.called).length } };
}

/** Новички за N дней (первая покупка в клубе), у кого меньше M визитов за первые 30 дней */
export async function newbiesAtRisk(db: Db, clubId: string, today: string) {
  const s = await opsSettings(db, clubId);
  const rows = (await db.query(`select m.id, m.person_id as "personId", p.full_name as name, m.product_name as product, m.starts_on::text as "startedOn",
      ($2::date - m.starts_on) as day,
      (select count(*) from visits v where v.person_id = m.person_id and v.club_id = m.club_id and v.visited_at >= m.starts_on and v.visited_at < m.starts_on + 30)::int as visits,
      (select pc.value from person_contacts pc where pc.person_id = p.id and pc.type = 'phone' order by pc.is_primary desc limit 1) as phone,
      (select u.full_name from opportunities o join users u on u.id = o.owner_id where o.person_id = m.person_id and o.club_id = m.club_id order by o.updated_at desc limit 1) as owner
    from memberships m join persons p on p.id = m.person_id and p.merged_into_id is null
    where m.club_id = $1 and m.status = 'active' and m.kind not in ('guest') and m.starts_on between $2::date - $3::int and $2::date
      and not exists (select 1 from memberships e where e.person_id = m.person_id and e.club_id = m.club_id and e.id <> m.id and e.kind <> 'guest'
                      and (e.starts_on < m.starts_on or (e.starts_on = m.starts_on and e.created_at < m.created_at)))
    order by m.starts_on`, [clubId, today, s.newbieDays])).rows;
  const list = rows.filter((r) => r.visits < s.newbieMinVisits).map((r) => ({ ...r, phone: maskPhone(r.phone), firstMonthOver: r.day >= 30 }));
  return { days: s.newbieDays, minVisits: s.newbieMinVisits, total: rows.length, list };
}

/* ========== 3. Списки обзвона ========== */
type CallRow = { personId: string; name: string; phone: string | null; block: string; why: string; ownerId: string | null; paidKop: number; lastVisit: string | null; tags: string[] };
export const BLOCKS: Record<string, string> = { new: 'Новые', renewal: 'Продления', base: 'Обычная база', recurrent: 'Рекурренты', zero: 'Не заплатили ни рубля' };

/** Делит базу клуба на блоки обзвона и раскладывает по менеджерам. Стоп-лист, дубли, сотрудники и «мало визитов» выпадают с причиной */
export async function callLists(db: Db, clubId: string, today: string) {
  const s = await opsSettings(db, clubId);
  const managers = await staffOf(db, clubId, ['manager']);
  const mIds = new Set(managers.map((m) => m.id));
  const renew = await renewalWindow(db, clubId, today);
  const renewIds = new Set(renew.list.map((r) => r.personId));
  const rows = (await db.query(`select p.id, p.full_name as name,
      (select pc.normalized_value from person_contacts pc where pc.person_id = p.id and pc.type = 'phone' order by pc.is_primary desc limit 1) as phone,
      (select cb.reason from person_call_blocks cb where cb.person_id = p.id and cb.removed_at is null and (cb.until is null or cb.until > $2::date)) as blocked,
      exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.kind <> 'guest' and (m.ends_on is null or m.ends_on >= $2::date)) as active,
      exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest') as ever_member,
      exists (select 1 from memberships m join person_payment_methods pm on pm.person_id = m.person_id and pm.status = 'active'
              where m.person_id = p.id and m.status = 'active' and m.kind = 'subscription') as recurrent,
      exists (select 1 from opportunities o where o.person_id = p.id and o.club_id = $1 and o.status = 'open') as open_deal,
      coalesce((select sum(case when py.direction = 'in' then py.amount_kop else -py.amount_kop end) from payments py where py.person_id = p.id and py.kind in ('charge', 'refund')), 0)::bigint as paid,
      (select count(*) from visits v where v.person_id = p.id)::int as visits,
      (select max(v.visited_at)::date::text from visits v where v.person_id = p.id) as last_visit,
      (select o.owner_id from opportunities o where o.person_id = p.id and o.club_id = $1 and o.owner_id is not null order by o.updated_at desc limit 1) as owner,
      coalesce((select array_agg(t.tag order by t.tag) from person_tags t where t.person_id = p.id), '{}') as tags
    from persons p where p.home_club_id = $1 and p.merged_into_id is null`, [clubId, today])).rows;

  const excluded: Record<string, number> = {};
  const out = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; };
  const list: CallRow[] = [];
  // Ответственный: менеджер сделки, иначе — ровно по кругу среди менеджеров клуба (одно и то же распределение при каждом расчёте)
  const pick = (id: string, owner: string | null) => {
    if (owner && mIds.has(owner)) return owner;
    if (!managers.length) return null;
    let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return managers[h % managers.length].id;
  };
  const ownerOfRenew = new Map(renew.list.map((r) => [r.personId, r.ownerId as string | null]));
  for (const r of rows) {
    if (r.blocked) { out(BLOCK_REASONS[r.blocked] ?? r.blocked); continue; }
    if (!r.phone) { out('Нет телефона'); continue; }
    const base = { personId: r.id, name: r.name, phone: r.phone as string, paidKop: Number(r.paid), lastVisit: r.last_visit, tags: r.tags as string[] };
    if (renewIds.has(r.id)) { list.push({ ...base, block: 'renewal', why: 'Заканчивается абонемент', ownerId: pick(r.id, ownerOfRenew.get(r.id) ?? r.owner) }); continue; }
    if (r.recurrent) { list.push({ ...base, block: 'recurrent', why: 'Подписка с автосписанием', ownerId: null }); continue; }
    if (r.active) { out('Действующий клиент'); continue; }
    if (s.excludeLowVisits && r.ever_member && r.visits <= 2) { out('Член клуба с 0–2 посещениями'); continue; }
    if (r.open_deal && !r.ever_member) { list.push({ ...base, block: 'new', why: 'Открытая сделка, ещё не покупал', ownerId: pick(r.id, r.owner) }); continue; }
    if (Number(r.paid) <= 0) { list.push({ ...base, block: 'zero', why: r.ever_member ? 'Был оформлен, но не платил' : 'Обращался, не покупал', ownerId: pick(r.id, r.owner) }); continue; }
    list.push({ ...base, block: 'base', why: 'Бывший клиент', ownerId: pick(r.id, r.owner) });
  }
  return { managers, list, excluded, renewWindow: { from: renew.from, to: renew.to } };
}

const callTable = (title: string, rows: CallRow[], names: Map<string, string>) => ({
  title, columns: ['Блок', 'Клиент', 'Телефон', 'Почему в списке', 'Менеджер', 'Оплатил, ₽', 'Последний визит', 'Теги'],
  rows: rows.map((r): Cell[] => [BLOCKS[r.block], r.name, r.phone, r.why, r.ownerId ? names.get(r.ownerId) ?? '' : '', Math.round(r.paidKop / 100), r.lastVisit ?? '', r.tags.join(', ')]),
});

/* ========== 4. Теги ========== */
/** Автотеги пересчитываются целиком по клубу; свои теги сотрудников не трогаются */
export async function recomputeTags(db: Db, clubId: string, today: string) {
  await db.query(`delete from person_tags t using persons p where t.person_id = p.id and p.home_club_id = $1 and t.auto`, [clubId]);
  const r = await db.query(`insert into person_tags(tenant_id, person_id, tag, auto)
    select p.tenant_id, p.id, x.tag, true from persons p
    cross join lateral (values
      ('новичок', exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest' and m.starts_on > $2::date - 30)
                  and not exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest' and m.starts_on <= $2::date - 30)),
      ('продление', exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.kind not in ('subscription', 'guest') and m.ends_on between $2::date and $2::date + 30)),
      ('рекуррент', exists (select 1 from memberships m join person_payment_methods pm on pm.person_id = m.person_id and pm.status = 'active' where m.person_id = p.id and m.status = 'active' and m.kind = 'subscription')),
      ('ни рубля', not exists (select 1 from payments py where py.person_id = p.id and py.direction = 'in')),
      ('бывший', exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest')
                 and not exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.kind <> 'guest' and (m.ends_on is null or m.ends_on >= $2::date))),
      ('мало визитов', exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.kind <> 'guest' and m.starts_on <= $2::date - 30)
                       and (select count(*) from visits v where v.person_id = p.id and v.visited_at > $2::date - 30) < 2),
      ('лид', not exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest'))
    ) as x(tag, ok)
    where p.home_club_id = $1 and p.merged_into_id is null and x.ok
    on conflict (person_id, tag) do nothing`, [clubId, today]);
  return r.rowCount ?? 0;
}

/* ========== 5. Дубли ========== */
export async function duplicateCandidates(db: Db, clubId: string, limit = 200) {
  const rows = (await db.query(`with pp as (
      select p.id, p.full_name, p.birth_date, p.created_at from persons p where p.home_club_id = $1 and p.merged_into_id is null),
    byphone as (
      select least(a.person_id, b.person_id) as a, greatest(a.person_id, b.person_id) as b, 'Один телефон' as why
      from person_contacts a join person_contacts b on b.normalized_value = a.normalized_value and b.type = a.type and b.person_id <> a.person_id
      where a.type in ('phone', 'email') and a.person_id in (select id from pp) and b.person_id in (select id from persons where merged_into_id is null)),
    byname as (
      select least(a.id, b.id) as a, greatest(a.id, b.id) as b, 'Одно ФИО и дата рождения' as why
      from pp a join pp b on b.id <> a.id and lower(b.full_name) = lower(a.full_name) and b.birth_date = a.birth_date)
    select x.a, x.b, string_agg(distinct x.why, ', ') as why from (select * from byphone union all select * from byname) x
    where not exists (select 1 from person_not_duplicates n where n.a = x.a and n.b = x.b)
    group by x.a, x.b limit $2`, [clubId, limit])).rows;
  const ids = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
  const info = new Map((await db.query(`select p.id, p.full_name as name, p.birth_date::text as "birthDate", p.created_at as "createdAt", p.segment,
      (select pc.value from person_contacts pc where pc.person_id = p.id and pc.type = 'phone' order by pc.is_primary desc limit 1) as phone,
      (select count(*) from memberships m where m.person_id = p.id)::int as memberships,
      (select count(*) from visits v where v.person_id = p.id)::int as visits
    from persons p where p.id = any($1)`, [ids])).rows.map((r) => [r.id, { ...r, phone: maskPhone(r.phone) }]));
  return rows.filter((r) => info.has(r.a) && info.has(r.b)).map((r) => {
    const [x, y] = [info.get(r.a)!, info.get(r.b)!];
    // Основной предлагаем того, у кого больше истории; при равенстве — более раннюю карточку
    const score = (p: typeof x) => p.memberships * 1000 + p.visits;
    const main = score(x) > score(y) || (score(x) === score(y) && new Date(x.createdAt) <= new Date(y.createdAt)) ? x : y;
    return { why: r.why, main, dup: main === x ? y : x };
  });
}

/* ========== 6. Воронка «где теряем» и источники ========== */
const NO_SOURCE = `(l.source_id is null or ls.code in ('other', 'unknown', 'none') or ls.name ilike 'не указан%')`;
export async function lossFunnel(db: Db, clubIds: string[], from: string, to: string, by: 'source' | 'manager' | 'none') {
  const rows = (await db.query(`with lf as (
      select distinct on (l.person_id, l.club_id) l.id, l.person_id, l.club_id, l.created_at, l.first_response_at, l.taken_at, l.assigned_to,
        coalesce(ls.name, 'Источник не указан') as source, ${NO_SOURCE} as no_source, u.full_name as manager
      from leads l join clubs c on c.id = l.club_id left join lead_sources ls on ls.id = l.source_id left join users u on u.id = l.assigned_to
      where l.club_id = any($1) and (l.created_at at time zone c.timezone)::date between $2::date and $3::date
      order by l.person_id, l.club_id, l.created_at)
    select lf.source, lf.no_source, lf.manager, lf.assigned_to,
      (lf.first_response_at is not null or lf.taken_at is not null) as worked,
      exists (select 1 from meetings mt where mt.person_id = lf.person_id and mt.club_id = lf.club_id and mt.created_at >= lf.created_at) as meeting,
      (exists (select 1 from meetings mt where mt.person_id = lf.person_id and mt.club_id = lf.club_id and mt.created_at >= lf.created_at and mt.status = 'attended')
        or exists (select 1 from visits v where v.person_id = lf.person_id and v.club_id = lf.club_id and v.visited_at >= lf.created_at)) as came,
      exists (select 1 from memberships m where m.person_id = lf.person_id and m.club_id = lf.club_id and m.created_at >= lf.created_at and m.kind <> 'guest') as sold
    from lf`, [clubIds, from, to])).rows;
  const STEPS = [['leads', 'Обращение'], ['worked', 'Взяли в работу'], ['meeting', 'Встреча назначена'], ['came', 'Гость дошёл'], ['sold', 'Продажа']] as const;
  const count = (list: typeof rows) => {
    // Шаги накопительные: кто дошёл или купил без отметки встречи, всё равно считается прошедшим предыдущие шаги
    const c = { leads: list.length, worked: 0, meeting: 0, came: 0, sold: 0 };
    for (const r of list) {
      const sold = r.sold; const came = r.came || sold; const meeting = r.meeting || came; const worked = r.worked || meeting;
      c.worked += +worked; c.meeting += +meeting; c.came += +came; c.sold += +sold;
    }
    const steps = STEPS.map(([k, title], i) => {
      const n = c[k]; const prev = i ? c[STEPS[i - 1][0]] : n;
      return { key: k, title, count: n, fromPrev: prev ? Math.round((n / prev) * 1000) / 10 : null, lost: i ? prev - n : 0 };
    });
    const worst = steps.slice(1).filter((s) => s.lost > 0).sort((a, b) => (a.fromPrev ?? 100) - (b.fromPrev ?? 100))[0];
    return { steps, conversion: c.leads ? Math.round((c.sold / c.leads) * 1000) / 10 : null, worstStep: worst ? worst.title : null };
  };
  const groups = new Map<string, typeof rows>();
  if (by !== 'none') for (const r of rows) { const k = by === 'source' ? r.source : (r.manager ?? 'Без ответственного'); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return {
    total: count(rows),
    noSource: { count: rows.filter((r) => r.no_source).length, share: rows.length ? Math.round((rows.filter((r) => r.no_source).length / rows.length) * 1000) / 10 : 0 },
    groups: [...groups.entries()].map(([name, list]) => ({ name, ...count(list) })).sort((a, b) => b.steps[0].count - a.steps[0].count),
  };
}

/* ========== 7. Сводки по расписанию ========== */
async function weeklyText(db: Db, clubId: string, today: string) {
  const to = addDays(today, -1); const from = addDays(today, -7);
  const club = (await db.query('select name, timezone from clubs where id = $1', [clubId])).rows[0];
  const f = await lossFunnel(db, [clubId], from, to, 'none');
  const money = Number((await db.query(`select coalesce(sum(case when direction = 'in' then amount_kop else -amount_kop end), 0) as s from payments
    where club_id = $1 and kind in ('charge', 'refund') and (created_at at time zone $4)::date between $2::date and $3::date`, [clubId, from, to, club.timezone])).rows[0].s);
  const sales = (await db.query(`select count(*) filter (where renewed_from_id is null)::int as new, count(*) filter (where renewed_from_id is not null)::int as renew from memberships
    where club_id = $1 and kind <> 'guest' and (created_at at time zone $4)::date between $2::date and $3::date`, [clubId, from, to, club.timezone])).rows[0];
  let speedIn = 0; let speedAll = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) { const sp = await leadSpeed(db, clubId, d); speedIn += sp.total.inNorm; speedAll += sp.total.total; }
  const rw = await renewalWindow(db, clubId, today);
  const nb = await newbiesAtRisk(db, clubId, today);
  const st = f.total.steps;
  return { title: `${club.name}: неделя ${ruDate(from)}–${ruDate(to)}`, body: [
    `Выручка: ${rub(money)}`, `Продажи: новых ${sales.new}, продлений ${sales.renew}`,
    `Обращений: ${st[0].count} → в работе ${st[1].count} → встреча ${st[2].count} → дошли ${st[3].count} → купили ${st[4].count}${f.total.worstStep ? ` (больше всего теряем на шаге «${f.total.worstStep}»)` : ''}`,
    `Ответ на заявку в норме: ${speedAll ? Math.round((speedIn / speedAll) * 100) : 0} % (${speedIn} из ${speedAll})`,
    f.noSource.count ? `Без источника: ${f.noSource.count} обращений (${f.noSource.share} %)` : 'Источник указан у всех обращений',
    `Окно продлений: ${rw.stats.total}, не звонили ${rw.stats.notCalled}`, `Новички с малым числом визитов: ${nb.list.length}`,
  ].join('\n') };
}
async function marketingText(db: Db, clubId: string, today: string) {
  const club = (await db.query('select name from clubs where id = $1', [clubId])).rows[0];
  const f = await lossFunnel(db, [clubId], today, today, 'source');
  const mf = await lossFunnel(db, [clubId], `${today.slice(0, 7)}-01`, today, 'none');
  const lines = f.groups.slice(0, 8).map((g) => `• ${g.name}: ${g.steps[0].count}${g.steps[4].count ? `, купили ${g.steps[4].count}` : ''}`);
  return { title: `${club.name}: маркетинг за ${ruDate(today)}`, body: [`Обращений сегодня: ${f.total.steps[0].count}`, ...lines,
    f.noSource.count ? `Без источника: ${f.noSource.count}` : '', `С начала месяца: ${mf.total.steps[0].count} обращений, продаж ${mf.total.steps[4].count}, конверсия ${mf.total.conversion ?? 0} %`,
  ].filter(Boolean).join('\n') };
}

/** Плановые дела клуба: вызывается раз в минуту. Сигналы по заявкам — всегда; сводки — один раз за свой период */
export async function processSalesOpsClub(db: Db, actor: Actor, c: { id: string; today: string; h: number; m: number; dow: number }) {
  const sla = await processLeadSla(db, actor, c.id);
  // Ночью — автотеги
  if (c.h >= 3 && c.h < 6 && (await once(db, c.id, 'tags', c.today))) await recomputeTags(db, c.id, c.today);
  // 9:00 — горячее окно продлений РОПу и менеджерам (каждому — его клиенты)
  if (c.h >= 9 && c.h < 12 && (await once(db, c.id, 'renewals', c.today))) {
    const rw = await renewalWindow(db, c.id, c.today);
    if (rw.stats.total) {
      const heads = await staffOf(db, c.id, ['rop']);
      await notify(db, c.id, heads.map((u) => u.id), 'renewals', `Окно продлений: ${rw.stats.total}`, `В этом месяце ${rw.stats.thisMonth}, не звонили ${rw.stats.notCalled}`, RENEWALS);
      const byOwner = new Map<string, number>();
      for (const r of rw.list) if (r.ownerId && !r.called) byOwner.set(r.ownerId, (byOwner.get(r.ownerId) ?? 0) + 1);
      for (const [uid, n] of byOwner) await notify(db, c.id, [uid], 'renewals', `Ваших клиентов в окне продлений без звонка: ${n}`, null, RENEWALS);
    }
  }
  // Понедельник 10:00 — новички РОПу; 9:00 — недельная сводка клуба
  if (c.dow === 1 && c.h >= 10 && c.h < 13 && (await once(db, c.id, 'newbies', c.today))) {
    const nb = await newbiesAtRisk(db, c.id, c.today);
    if (nb.list.length) {
      const heads = await staffOf(db, c.id, ['rop']);
      const names = nb.list.slice(0, 15).map((r) => `• ${r.name} — ${r.visits} виз. за ${Math.min(r.day, 30)} дн.`);
      await notify(db, c.id, heads.map((u) => u.id), 'newbies', `Новички с малым числом визитов: ${nb.list.length}`,
        [`За ${nb.days} дней, меньше ${nb.minVisits} визитов в первый месяц`, ...names, nb.list.length > 15 ? `…и ещё ${nb.list.length - 15}` : ''].filter(Boolean).join('\n'), { tab: 'sales', p: { view: 'newbies' } });
    }
  }
  if (c.dow === 1 && c.h >= 9 && c.h < 12 && (await once(db, c.id, 'weekly', c.today))) {
    const to = await staffOf(db, c.id, ['owner', 'gm', 'rop']);
    const w = await weeklyText(db, c.id, c.today);
    await notify(db, c.id, to.map((u) => u.id), 'weekly', w.title, w.body, { tab: 'sales' });
  }
  // 20:00 — маркетинг-дайджест; 21:00 — отчёт по скорости ответа за день
  if (c.h >= 20 && c.h < 23 && (await once(db, c.id, 'marketing', c.today))) {
    const to = await staffOf(db, c.id, ['owner', 'gm']);
    const mk = await marketingText(db, c.id, c.today);
    await notify(db, c.id, to.map((u) => u.id), 'marketing', mk.title, mk.body, { tab: 'sales', p: { view: 'funnel' } });
  }
  if (c.h >= 21 && c.h < 24 && (await once(db, c.id, 'lead_daily', c.today))) {
    const sp = await leadSpeed(db, c.id, c.today);
    if (sp.total.total) {
      const heads = await staffOf(db, c.id, ['rop', 'gm']);
      const lines = sp.managers.map((m) => `• ${m.name}: ${m.total}, дольше нормы ${m.late}${m.avgMinutes !== null ? `, в среднем ${m.avgMinutes} мин` : ''}`);
      await notify(db, c.id, heads.map((u) => u.id), 'lead_daily', `Заявки за ${ruDate(c.today)}: ${sp.total.total}, дольше нормы ${sp.total.late}`,
        [`В норме ${sp.total.inNorm}, дольше ${sp.norm} мин — ${sp.total.late}, РОПу ушло ${sp.total.escalated}`, ...lines].join('\n'), LEADS);
    }
  }
  return sla;
}

export async function processSalesOps(pool: pg.Pool) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const actor = { tenantId, userId: null };
    const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select c.id, to_char(now() at time zone c.timezone, 'YYYY-MM-DD') as today,
      extract(hour from now() at time zone c.timezone)::int as h, extract(minute from now() at time zone c.timezone)::int as m,
      extract(isodow from now() at time zone c.timezone)::int as dow
      from clubs c where c.status = 'active' and not c.is_demo`)).rows);
    for (const c of clubs) await withCtx(pool, sys, (db) => processSalesOpsClub(db, actor, c)).catch((e) => console.error('Отдел продаж:', (e as Error).message));
  }
}
export function startSalesOpsWorker(pool: pg.Pool, everyMs = 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processSalesOps(pool); } finally { busy = false; } };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

/* ---------- маршруты ---------- */
export function salesOpsRoutes(app: FastifyInstance, pool: pg.Pool) {
  const club = async (db: Db, id?: string) => { if (!uuid(id) || !(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw badRequest('Выберите клуб'); return id!; };
  const person = async (db: Db, id: string) => { if (!uuid(id) || !(await db.query('select 1 from persons where id = $1', [id])).rowCount) throw notFound('Клиент не найден'); return id; };

  // Уведомления CRM (колокольчик в шапке): свои, последние 50, и сколько непрочитанных
  app.get('/api/notifications', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const items = (await db.query(`select id, kind, title, body, link, created_at as "createdAt", read_at as "readAt", object_type as "objectType", object_id as "objectId", actions, acted, acted_at as "actedAt" from staff_notifications
        where user_id = $1 order by created_at desc limit 50`, [ctx.userId])).rows;
      const unread = (await db.query('select count(*)::int as n from staff_notifications where user_id = $1 and read_at is null', [ctx.userId])).rows[0].n as number;
      return { items, unread };
    });
  });
  app.post('/api/notifications/read', async (req) => {
    const ctx = requireCtx(req);
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(uuid))) throw badRequest('Неверный список');
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query(`update staff_notifications set read_at = now() where user_id = $1 and read_at is null and ($2::uuid[] is null or id = any($2))`, [ctx.userId, ids ?? null]);
      return { ok: true, marked: r.rowCount };
    });
  });

  // Настройки
  app.get('/api/sales-ops/settings', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => ({ settings: await opsSettings(db, await club(db, clubId)), canManage: can(ctx, P.planManage) }));
  });
  app.put('/api/sales-ops/settings', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const b = (req.body ?? {}) as Partial<OpsSettings> & { clubId?: string };
    const n = (v: unknown, lo: number, hi: number, msg: string) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw badRequest(msg); return x; };
    return withCtx(pool, ctx, async (db) => {
      const id = await club(db, b.clubId);
      const cur = await opsSettings(db, id);
      const s: OpsSettings = {
        remindMinutes: b.remindMinutes === undefined ? cur.remindMinutes : n(b.remindMinutes, 1, 240, 'Напоминание: от 1 до 240 минут'),
        escalateMinutes: b.escalateMinutes === undefined ? cur.escalateMinutes : n(b.escalateMinutes, 2, 1440, 'Сигнал РОПу: от 2 до 1440 минут'),
        newbieDays: b.newbieDays === undefined ? cur.newbieDays : n(b.newbieDays, 14, 120, 'Новички: от 14 до 120 дней'),
        newbieMinVisits: b.newbieMinVisits === undefined ? cur.newbieMinVisits : n(b.newbieMinVisits, 1, 30, 'Визитов в первый месяц: от 1 до 30'),
        excludeLowVisits: b.excludeLowVisits === undefined ? cur.excludeLowVisits : !!b.excludeLowVisits,
      };
      if (s.escalateMinutes <= s.remindMinutes) throw badRequest('Сигнал РОПу должен быть позже напоминания менеджеру');
      await db.query(`insert into sales_ops_settings(club_id, tenant_id, remind_minutes, escalate_minutes, newbie_days, newbie_min_visits, exclude_low_visits, updated_by)
        values ($1, app_tenant(), $2,$3,$4,$5,$6,$7) on conflict (club_id) do update set remind_minutes = $2, escalate_minutes = $3, newbie_days = $4, newbie_min_visits = $5,
        exclude_low_visits = $6, updated_by = $7, updated_at = now()`,
      [id, s.remindMinutes, s.escalateMinutes, s.newbieDays, s.newbieMinVisits, s.excludeLowVisits, ctx.userId]);
      await audit(db, ctx, 'sales_ops.settings', 'club', id, cur, s);
      return { settings: s };
    });
  });

  // Заявки: ждут ответа + скорость за день
  app.get('/api/sales-ops/leads', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId, day } = req.query as { clubId?: string; day?: string };
    return withCtx(pool, ctx, async (db) => {
      const id = await club(db, clubId);
      const d = isoDate(day) ? day! : await clubToday(db, id);
      const mine = onlyMine(ctx) ? ctx.userId : undefined;
      return { waiting: await waitingLeads(db, id, mine), speed: await leadSpeed(db, id, d, mine) };
    });
  });
  app.post('/api/sales-ops/leads/:id/take', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    if (!uuid(id)) throw notFound('Заявка не найдена');
    return withCtx(pool, ctx, async (db) => {
      const l = (await db.query('select id, club_id, person_id, opportunity_id, assigned_to, taken_at, taken_by from leads where id = $1', [id])).rows[0];
      if (!l) throw notFound('Заявка не найдена');
      if (l.taken_at) {
        const who = (await db.query('select full_name from users where id = $1', [l.taken_by])).rows[0]?.full_name;
        return { ok: true, already: true, takenBy: who ?? null };
      }
      if (l.assigned_to && l.assigned_to !== ctx.userId && onlyMine(ctx)) throw badRequest('Заявка у другого менеджера. Если он не берёт, скажите РОПу');
      await db.query('update leads set taken_at = now(), taken_by = $2, assigned_to = coalesce(assigned_to, $2) where id = $1', [id, ctx.userId]);
      if (!l.assigned_to) {
        if (l.opportunity_id) await db.query('update opportunities set owner_id = $2 where id = $1 and owner_id is null', [l.opportunity_id, ctx.userId]);
        await db.query(`update tasks set assignee_id = $2 where lead_id = $1 and kind = 'first_response' and assignee_id is null and done_at is null`, [id, ctx.userId]);
      }
      await audit(db, ctx, 'lead.taken', 'lead', id, null, { personId: l.person_id });
      return { ok: true, already: false };
    });
  });

  // Продления и новички
  app.get('/api/sales-ops/renewals', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => { const id = await club(db, clubId); return renewalWindow(db, id, await clubToday(db, id), onlyMine(ctx) ? ctx.userId : undefined); });
  });
  app.get('/api/sales-ops/newbies', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => { const id = await club(db, clubId); return newbiesAtRisk(db, id, await clubToday(db, id)); });
  });

  // Списки обзвона
  app.get('/api/sales-ops/call-lists', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const id = await club(db, clubId);
      const r = await callLists(db, id, await clubToday(db, id));
      const mine = onlyMine(ctx);
      const LIMIT = 300;
      const shape = (rows: CallRow[]) => rows.slice(0, LIMIT).map((x) => ({ ...x, phone: maskPhone(x.phone) }));
      const forUser = (uid: string) => Object.fromEntries(['new', 'renewal', 'base', 'zero'].map((b) => {
        const rows = r.list.filter((x) => x.ownerId === uid && x.block === b);
        return [b, { count: rows.length, rows: shape(rows) }];
      }));
      const managers = (mine ? r.managers.filter((m) => m.id === ctx.userId) : r.managers).map((m) => ({ ...m, blocks: forUser(m.id) }));
      if (mine && !managers.length) managers.push({ id: ctx.userId, name: 'Мой список', role: 'manager', blocks: forUser(ctx.userId) });
      const rec = r.list.filter((x) => x.block === 'recurrent');
      const zero = r.list.filter((x) => x.block === 'zero');
      return { managers, recurrent: mine ? null : { count: rec.length, rows: shape(rec) }, zero: mine ? null : { count: zero.length, rows: shape(zero) },
        excluded: mine ? null : r.excluded, unassigned: mine ? 0 : r.list.filter((x) => !x.ownerId && x.block !== 'recurrent').length,
        renewWindow: r.renewWindow, limit: LIMIT, blocks: BLOCKS };
    });
  });
  // Выгрузка: файл на менеджера (все его блоки) либо отдельные списки рекуррентов и «ни рубля»
  app.get('/api/sales-ops/call-lists/export', async (req, reply) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId, who, format } = req.query as { clubId?: string; who?: string; format?: string };
    const t = await withCtx(pool, ctx, async (db) => {
      const id = await club(db, clubId);
      const r = await callLists(db, id, await clubToday(db, id));
      const names = new Map(r.managers.map((m) => [m.id, m.name]));
      const order = ['new', 'renewal', 'base', 'zero'];
      if (who === 'recurrent' || who === 'zero') {
        if (onlyMine(ctx)) throw badRequest('Этот список доступен руководителю отдела');
        return callTable(BLOCKS[who], r.list.filter((x) => x.block === who), names);
      }
      const uid = onlyMine(ctx) ? ctx.userId : who;
      if (!uuid(uid)) throw badRequest('Выберите менеджера');
      const rows = r.list.filter((x) => x.ownerId === uid && x.block !== 'recurrent').sort((a, b) => order.indexOf(a.block) - order.indexOf(b.block) || a.name.localeCompare(b.name, 'ru'));
      return callTable(`Обзвон: ${names.get(uid!) ?? 'менеджер'}`, rows, names);
    });
    return sendTable(reply, t, format === 'csv' ? 'csv' : 'xlsx', t.title);
  });

  // Стоп-лист, теги — по клиенту
  app.get('/api/persons/:id/call-flags', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await person(db, id);
      const block = (await db.query(`select b.reason, b.until::text, b.comment, b.created_at as "createdAt", u.full_name as "createdBy" from person_call_blocks b
        left join users u on u.id = b.created_by where b.person_id = $1 and b.removed_at is null`, [id])).rows[0] ?? null;
      const tags = (await db.query('select tag, auto from person_tags where person_id = $1 order by auto, tag', [id])).rows;
      return { block: block ? { ...block, title: BLOCK_REASONS[block.reason] } : null, tags, reasons: BLOCK_REASONS, canEdit: can(ctx, P.crmWork) };
    });
  });
  app.put('/api/persons/:id/call-block', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string; until?: string; comment?: string };
    if (!b.reason || !BLOCK_REASONS[b.reason]) throw badRequest('Выберите причину');
    if (b.reason === 'postponed' && !isoDate(b.until)) throw badRequest('Укажите, до какого дня отложить');
    return withCtx(pool, ctx, async (db) => {
      await person(db, id);
      const before = (await db.query('select reason, until from person_call_blocks where person_id = $1 and removed_at is null', [id])).rows[0] ?? null;
      await db.query('update person_call_blocks set removed_at = now(), removed_by = $2 where person_id = $1 and removed_at is null', [id, ctx.userId]);
      await db.query(`insert into person_call_blocks(tenant_id, person_id, reason, until, comment, created_by) values (app_tenant(), $1, $2, $3, $4, $5)`,
        [id, b.reason, b.reason === 'postponed' ? b.until : null, b.comment?.trim().slice(0, 300) || null, ctx.userId]);
      await audit(db, ctx, 'person.call_block', 'person', id, before, { reason: b.reason, until: b.until ?? null });
      return { ok: true };
    });
  });
  app.delete('/api/persons/:id/call-block', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await person(db, id);
      const r = await db.query('update person_call_blocks set removed_at = now(), removed_by = $2 where person_id = $1 and removed_at is null returning reason', [id, ctx.userId]);
      if (r.rowCount) await audit(db, ctx, 'person.call_unblock', 'person', id, { reason: r.rows[0].reason }, null);
      return { ok: true };
    });
  });
  app.post('/api/persons/:id/tags', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const tag = String((req.body as { tag?: string } | undefined)?.tag ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag || tag.length > 40) throw badRequest('Тег: от 1 до 40 символов');
    if ((AUTO_TAGS as readonly string[]).includes(tag)) throw badRequest('Такой тег система ставит сама');
    return withCtx(pool, ctx, async (db) => {
      await person(db, id);
      await db.query(`insert into person_tags(tenant_id, person_id, tag, auto, created_by) values (app_tenant(), $1, $2, false, $3) on conflict do nothing`, [id, tag, ctx.userId]);
      return { ok: true };
    });
  });
  app.delete('/api/persons/:id/tags/:tag', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id, tag } = req.params as { id: string; tag: string };
    return withCtx(pool, ctx, async (db) => {
      await person(db, id);
      await db.query('delete from person_tags where person_id = $1 and tag = $2 and not auto', [id, decodeURIComponent(tag)]);
      return { ok: true };
    });
  });
  // Стоп-лист клуба целиком: сколько по каким причинам, кто
  app.get('/api/sales-ops/blocks', async (req) => {
    const ctx = requirePerm(req, P.crmViewAll);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const id = await club(db, clubId);
      const today = await clubToday(db, id);
      const rows = (await db.query(`select b.person_id as "personId", p.full_name as name, b.reason, b.until::text, b.comment, b.created_at as "createdAt", u.full_name as "createdBy"
        from person_call_blocks b join persons p on p.id = b.person_id left join users u on u.id = b.created_by
        where p.home_club_id = $1 and b.removed_at is null and (b.until is null or b.until > $2::date) order by b.created_at desc limit 500`, [id, today])).rows;
      const byReason = Object.entries(rows.reduce((a, r) => ({ ...a, [r.reason]: (a[r.reason] ?? 0) + 1 }), {} as Record<string, number>))
        .map(([reason, count]) => ({ reason, title: BLOCK_REASONS[reason], count: count as number })).sort((a, b) => b.count - a.count);
      const tags = (await db.query(`select t.tag, t.auto, count(*)::int as count from person_tags t join persons p on p.id = t.person_id
        where p.home_club_id = $1 and p.merged_into_id is null group by 1, 2 order by t.auto, count desc`, [id])).rows;
      return { list: rows.map((r) => ({ ...r, title: BLOCK_REASONS[r.reason] })), byReason, tags, reasons: BLOCK_REASONS };
    });
  });
  app.post('/api/sales-ops/tags/recompute', async (req) => {
    const ctx = requirePerm(req, P.crmViewAll);
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    return withCtx(pool, ctx, async (db) => { const id = await club(db, clubId); return { tagged: await recomputeTags(db, id, await clubToday(db, id)) }; });
  });

  // Дубли и склейка
  app.get('/api/sales-ops/duplicates', async (req) => {
    const ctx = requirePerm(req, P.crmViewAll);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => ({ pairs: await duplicateCandidates(db, await club(db, clubId)) }));
  });
  app.post('/api/sales-ops/merge', async (req) => {
    const ctx = requirePerm(req, P.crmViewAll);
    const { mainId, dupId } = (req.body ?? {}) as { mainId?: string; dupId?: string };
    if (!uuid(mainId) || !uuid(dupId) || mainId === dupId) throw badRequest('Выберите две разные карточки');
    return withCtx(pool, ctx, async (db) => {
      const ps = (await db.query('select id, full_name, merged_into_id from persons where id = any($1)', [[mainId, dupId]])).rows;
      if (ps.length !== 2) throw notFound('Карточка не найдена');
      if (ps.some((p) => p.merged_into_id)) throw badRequest('Одна из карточек уже склеена');
      const r = (await db.query('select merge_person($1, $2) as r', [mainId, dupId])).rows[0].r;
      await audit(db, ctx, 'person.merged', 'person', mainId!, { dupId, dupName: ps.find((p) => p.id === dupId)!.full_name }, r);
      return { ok: true, ...r };
    });
  });
  app.post('/api/sales-ops/not-duplicate', async (req) => {
    const ctx = requirePerm(req, P.crmViewAll);
    const { a, b } = (req.body ?? {}) as { a?: string; b?: string };
    if (!uuid(a) || !uuid(b) || a === b) throw badRequest('Выберите две карточки');
    const [x, y] = a! < b! ? [a, b] : [b, a];
    return withCtx(pool, ctx, async (db) => {
      await person(db, x!); await person(db, y!);
      await db.query('insert into person_not_duplicates(tenant_id, a, b, created_by) values (app_tenant(), $1, $2, $3) on conflict do nothing', [x, y, ctx.userId]);
      await audit(db, ctx, 'person.not_duplicate', 'person', x!, null, { other: y });
      return { ok: true };
    });
  });

  // Воронка «где теряем», источники
  app.get('/api/sales-ops/funnel', async (req) => {
    const ctx = requirePerm(req, P.dashView);
    const { clubId, from, to, by } = req.query as { clubId?: string; from?: string; to?: string; by?: string };
    return withCtx(pool, ctx, async (db) => {
      const id = await club(db, clubId);
      const today = await clubToday(db, id);
      const t = isoDate(to) ? to! : today; const fr = isoDate(from) ? from! : `${t.slice(0, 7)}-01`;
      if (fr > t) throw badRequest('Начало периода позже конца');
      return { from: fr, to: t, ...(await lossFunnel(db, [id], fr, t, by === 'manager' ? 'manager' : 'source')) };
    });
  });
  // Текст недельной сводки и маркетинг-дайджеста — посмотреть, что придёт
  app.get('/api/sales-ops/digest-preview', async (req) => {
    const ctx = requirePerm(req, P.dashView);
    const { clubId, kind } = req.query as { clubId?: string; kind?: string };
    return withCtx(pool, ctx, async (db) => {
      const id = await club(db, clubId);
      const today = await clubToday(db, id);
      const d = kind === 'marketing' ? await marketingText(db, id, today) : await weeklyText(db, id, today);
      return { text: `${d.title}\n\n${d.body}` };
    });
  });
}
