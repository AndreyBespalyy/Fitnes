// ИИ-агент, этап 5 (просьба Андрея 14.11.2026): «Назначить собрание».
// Руководитель пишет помощнику: кого позвать (группами — «отдел продаж», «тренеры», «все» — и по фамилиям),
// окно (дни, часы), длительность, тему и место. Помощник сверяет расписание тренировок, встречи с клиентами,
// звонки, задачи, смены и отпуска участников и предлагает до трёх вариантов времени с наименьшими потерями для клуба:
// отменить тренировку дороже всего, встречу с клиентом — меньше, звонок — ещё меньше.
// После выбора: собрание в календаре каждого (раздел «Задачи»), звонки и задачи сдвинуты сами, по тренировкам и встречам
// с клиентами — задача ответственному перенести (клиентам помощник сам не пишет, 2Б), каждому участнику — приглашение
// в мессенджер с местом, временем и кнопкой «Подтвердить участие». Ответы участников приходят организатору.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { ensureBotChat } from './agentChat.ts';
import { card } from './agentReminders.ts';
import { addDays, getPending, norm, orderedEmployees, pickClubs, setPending, todayOf, visibleClubs, type Club, type Who } from './agentOwner.ts';

/* ---------- разбор просьбы ---------- */
export const MEETING_RE = /(назнач|собери|созови|организуй|запланируй|проведи|устрой|поставь|нужн[оа]|хочу|давай)\S*\s.{0,40}(собрани|планерк|совещани|летучк|пятиминутк)|^(собрание|планерка|планёрка|совещание)\b|^(собери|созови|позови)\s/i;
export const MEETING_STATUS_RE = /(кто (подтвердил|придет|придёт|будет)|статус собрани|мои собрания|ближайшие собрания)/i;

const GROUPS: [RegExp, string[], string][] = [
  [/(отдел\S* продаж|менеджер|продажник)/, ['manager', 'rop'], 'отдел продаж'],
  [/тренер/, ['trainer'], 'тренеры'],
  [/(администратор|ресепшн|ресепшен|рецепц)/, ['desk'], 'администраторы'],
  [/управляющ/, ['gm'], 'управляющие'],
  [/(финанс|бухгалт)/, ['fin'], 'финансисты'],
  [/(\bроп\b|руководител\S* (отдела )?продаж)/, ['rop'], 'РОП'],
  [/(всех сотрудник|все сотрудник|весь клуб|всех|всем коллектив|вся команда|всю команду|весь коллектив|общее)/, ['manager', 'rop', 'trainer', 'desk', 'gm', 'fin'], 'все сотрудники'],
];
const DOW_RE: [RegExp, number][] = [[/понедельн/, 1], [/вторн/, 2], [/сред[ауые]/, 3], [/четверг/, 4], [/пятниц/, 5], [/суббот/, 6], [/воскресен/, 7]];
const DOW_SHORT = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export type MeetingDraft = { roles: string[]; groupNames: string[]; days: string[]; fromMin: number; toMin: number; duration: number; title: string; place: string; rest: string };

const isoDow = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function parseMeeting(text: string, today: string): MeetingDraft {
  let t = norm(text);
  // Тема и место — вырезаем, чтобы слова из них не приняли за фамилии
  let title = 'Собрание'; let place = '';
  const tm = t.match(/(?:тема|на тему|по теме|повестка|по поводу)\s*[:—-]?\s*([^,.;\n]+?)(?=\s*(?:[,.;\n]|\sместо\b|$))/);
  if (tm) { const i = norm(text).indexOf(tm[1]); title = text.slice(i, i + tm[1].length).trim(); t = t.replace(tm[0], ' '); }
  const pm = t.match(/место\s*[:—-]?\s*([^,.;\n]+)/) ?? t.match(/\b((?:в|во)\s+(?:переговорн\S*|зале\S*|офисе|кабинет\S*(?:\s+\S+)?|холле)|онлайн|в зуме|по видеосвязи)/);
  if (pm) { const i = norm(text).indexOf(pm[1]); place = text.slice(i, i + pm[1].length).trim().replace(/^в\s+/i, '').replace(/^./, (c) => c.toUpperCase()); t = t.replace(pm[0], ' '); }
  // Дни
  const days = new Set<string>();
  if (/сегодня/.test(t)) days.add(today);
  if (/послезавтра/.test(t)) days.add(addDays(today, 2));
  else if (/завтра/.test(t)) days.add(addDays(today, 1));
  for (const m of t.matchAll(/(\d{1,2})\.(\d{1,2})(?:\.\d{2,4})?/g)) {
    const y = Number(today.slice(0, 4)) + (Number(m[2]) < Number(today.slice(5, 7)) ? 1 : 0);
    const d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(d)) && d >= today) days.add(d);
  }
  const nextWeek = /следующ\S* недел/.test(t);
  for (const [re, dow] of DOW_RE) {
    if (!re.test(t)) continue;
    let d = addDays(today, 1);
    while (isoDow(d) !== dow) d = addDays(d, 1);
    if (nextWeek && daysDiff(today, d) < 7 && isoDow(today) < dow) d = addDays(d, 7);
    days.add(d);
  }
  if (!days.size && nextWeek) { let d = addDays(today, 1); while (isoDow(d) !== 1) d = addDays(d, 1); for (let i = 0; i < 5; i++) days.add(addDays(d, i)); }
  if (!days.size && /(на (этой )?неделе|в ближайш)/.test(t)) for (let i = 0; i < 7; i++) { const d = addDays(today, i); if (isoDow(d) <= 6) days.add(d); }
  if (!days.size) for (let i = 1; days.size < 3 && i < 7; i++) { const d = addDays(today, i); if (isoDow(d) !== 7) days.add(d); }
  // Часы
  let fromMin = 9 * 60; let toMin = 20 * 60;
  const hr = t.match(/с\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:ч\S*\s*)?до\s*(\d{1,2})(?:[:.](\d{2}))?/);
  if (hr) { fromMin = Number(hr[1]) * 60 + Number(hr[2] ?? 0); toMin = Number(hr[3]) * 60 + Number(hr[4] ?? 0); t = t.replace(hr[0], ' '); }
  else if (/утр/.test(t)) { fromMin = 9 * 60; toMin = 12 * 60; }
  else if (/(днем|днём|в обед|после обеда)/.test(t)) { fromMin = 12 * 60; toMin = 17 * 60; }
  else if (/вечер/.test(t)) { fromMin = 17 * 60; toMin = 21 * 60; }
  const at = !hr && t.match(/(?:^|\s)в\s*(\d{1,2})(?:[:.](\d{2}))?(?!\s*(?:минут|мин|час|\.\d))/);
  // Длительность
  let duration = 60;
  if (/полчаса/.test(t)) duration = 30;
  else if (/полтора/.test(t)) duration = 90;
  else {
    const du = t.match(/(?:на|длительност\S*|продолжительност\S*)\s*(\d+(?:[.,]\d)?)\s*(час|ч\b|мин)/) ?? t.match(/(\d+(?:[.,]\d)?)\s*(час\S*|минут\S*)/);
    if (du) duration = Math.round(Number(du[1].replace(',', '.')) * (du[2].startsWith('мин') ? 1 : 60));
  }
  duration = Math.min(480, Math.max(15, duration));
  if (at) { fromMin = Number(at[1]) * 60 + Number(at[2] ?? 0); toMin = fromMin + duration; }
  if (toMin - fromMin < duration) toMin = Math.min(24 * 60, fromMin + duration);
  const roles = new Set<string>(); const groupNames: string[] = [];
  for (const [re, rs, name] of GROUPS) if (re.test(t)) { rs.forEach((r) => roles.add(r)); groupNames.push(name); }
  return { roles: [...roles], groupNames, days: [...days].sort(), fromMin, toMin, duration, title: title.slice(0, 200), place: place.slice(0, 200), rest: t };
}
const daysDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Местное время клуба → момент UTC */
export function zoned(date: string, min: number, tz: string) {
  const guess = new Date(`${date}T${hm(min)}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess).map((x) => [x.type, x.value]));
  const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}
const local = (d: Date | string, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const localDay = (d: Date | string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(d));
const dayLabel = (d: Date | string, tz: string) => { const day = localDay(d, tz); return `${DOW_SHORT[isoDow(day)]} ${day.slice(8, 10)}.${day.slice(5, 7)}`; };

/* ---------- занятость участников ---------- */
type Busy = { userId: string; who: string; type: 'personal' | 'group' | 'client' | 'staff' | 'call' | 'task'; id: string; start: number; end: number; cost: number; label: string };
type Off = { userId: string; who: string; day: string; reason: string };
type Shift = { userId: string; day: string; from: number; to: number };

export const COST = { personal: 100, group: 50, groupPerClient: 3, client: 40, staff: 30, offShift: 15, dayOff: 25, call: 8, task: 2 };

async function busyOf(db: Db, people: Who[], from: Date, to: Date, tz: string) {
  const ids = people.map((p) => p.id);
  const name = new Map(people.map((p) => [p.id, p.label]));
  const busy: Busy[] = [];
  const t = (d: string | Date) => new Date(d).getTime();
  const sessions = (await db.query(`select s.id, s.trainer_id, s.starts_at, s.ends_at, ct.kind, ct.name,
      count(b.id) filter (where b.status in ('booked', 'attended'))::int as n, min(p.full_name) as client
    from class_sessions s join class_types ct on ct.id = s.type_id left join class_bookings b on b.session_id = s.id and b.status in ('booked', 'attended')
      left join persons p on p.id = b.person_id
    where s.trainer_id = any($1) and s.status = 'scheduled' and s.starts_at < $3 and s.ends_at > $2 group by s.id, ct.kind, ct.name`, [ids, from, to])).rows;
  for (const s of sessions) {
    const personal = s.kind === 'personal';
    busy.push({ userId: s.trainer_id, who: name.get(s.trainer_id)!, type: personal ? 'personal' : 'group', id: s.id, start: t(s.starts_at), end: t(s.ends_at),
      cost: personal ? COST.personal : COST.group + COST.groupPerClient * s.n,
      label: personal ? `персональная тренировка ${local(s.starts_at, tz)}${s.client ? ` (клиент ${s.client})` : ''}` : `групповое «${s.name}» ${local(s.starts_at, tz)}, записано ${s.n}` });
  }
  const meetings = (await db.query(`select m.id, m.created_by, m.scheduled_at, p.full_name from meetings m join persons p on p.id = m.person_id
    where m.created_by = any($1) and m.status = 'scheduled' and m.scheduled_at < $3 and m.scheduled_at > $2::timestamptz - interval '1 hour'`, [ids, from, to])).rows;
  for (const m of meetings) busy.push({ userId: m.created_by, who: name.get(m.created_by)!, type: 'client', id: m.id, start: t(m.scheduled_at), end: t(m.scheduled_at) + 3_600_000, cost: COST.client, label: `встреча с клиентом ${m.full_name} ${local(m.scheduled_at, tz)}` });
  const staff = (await db.query(`select sm.id, mm.user_id, sm.starts_at, sm.ends_at, sm.title from staff_meetings sm join staff_meeting_members mm on mm.meeting_id = sm.id
    where mm.user_id = any($1) and sm.status = 'planned' and mm.status <> 'declined' and sm.starts_at < $3 and sm.ends_at > $2`, [ids, from, to])).rows;
  for (const m of staff) busy.push({ userId: m.user_id, who: name.get(m.user_id)!, type: 'staff', id: m.id, start: t(m.starts_at), end: t(m.ends_at), cost: COST.staff, label: `собрание «${m.title}» ${local(m.starts_at, tz)}` });
  const tasks = (await db.query(`select t.id, t.assignee_id, t.due_at, t.kind, t.title from tasks t
    where t.assignee_id = any($1) and t.done_at is null and t.due_at >= $2 and t.due_at < $3
      and not exists (select 1 from staff_meeting_members mm where mm.task_id = t.id)`, [ids, from, to])).rows;
  for (const x of tasks) {
    const call = ['call', 'first_response'].includes(x.kind);
    busy.push({ userId: x.assignee_id, who: name.get(x.assignee_id)!, type: call ? 'call' : 'task', id: x.id, start: t(x.due_at), end: t(x.due_at) + (call ? 15 : 5) * 60_000, cost: call ? COST.call : COST.task, label: `${call ? 'звонок' : 'задача'} «${x.title}» ${local(x.due_at, tz)}` });
  }
  const fromDay = localDay(from, tz); const toDay = localDay(to, tz);
  const off: Off[] = (await db.query(`select user_id, kind, date_from, date_to from staff_absences where user_id = any($1) and date_to >= $2 and date_from <= $3`, [ids, fromDay, toDay])).rows
    .flatMap((a) => { const out: Off[] = []; const f = localDay(a.date_from, 'UTC'); const e = localDay(a.date_to, 'UTC'); for (let d = f; d <= e; d = addDays(d, 1)) out.push({ userId: a.user_id, who: name.get(a.user_id)!, day: d, reason: ({ vacation: 'отпуск', sick: 'больничный', dayoff: 'отгул', unpaid: 'за свой счёт' } as Record<string, string>)[a.kind] ?? 'отсутствует' }); return out; });
  const shifts: Shift[] = (await db.query(`select user_id, to_char(day, 'YYYY-MM-DD') as day, extract(hour from starts)::int * 60 + extract(minute from starts)::int as f,
      extract(hour from ends)::int * 60 + extract(minute from ends)::int as e from staff_shifts where user_id = any($1) and day between $2::date - 7 and $3::date + 7`, [ids, fromDay, toDay])).rows
    .map((s) => ({ userId: s.user_id, day: s.day, from: s.f, to: s.e }));
  return { busy, off, shifts };
}

type Option = { start: string; end: string; cost: number; items: { userId: string; who: string; type: string; id: string; label: string; cost: number }[]; missing: string[] };

/** Перебор окон по 30 минут: сумма потерь по всем участникам, лучшие варианты не пересекаются */
export function chooseSlots(d: MeetingDraft, people: Who[], tz: string, nowMs: number, busy: Busy[], off: Off[], shifts: Shift[]): { options: Option[]; never: string[] } {
  const slots: Option[] = [];
  const hasShifts = new Set(shifts.map((s) => s.userId));
  const never = people.filter((p) => d.days.every((day) => off.some((o) => o.userId === p.id && o.day === day))).map((p) => `${p.label} (${off.find((o) => o.userId === p.id)!.reason})`);
  for (const day of d.days) {
    for (let m = d.fromMin; m + d.duration <= d.toMin; m += 30) {
      const s = zoned(day, m, tz).getTime(); const e = s + d.duration * 60_000;
      if (s < nowMs + 30 * 60_000) continue;
      const items: Option['items'] = []; const missing: string[] = [];
      for (const p of people) {
        const o = off.find((x) => x.userId === p.id && x.day === day);
        if (o) { missing.push(`${p.label} (${o.reason})`); continue; }
        for (const b of busy) if (b.userId === p.id && b.start < e && b.end > s) items.push({ userId: b.userId, who: b.who, type: b.type, id: b.id, label: b.label, cost: b.cost });
        if (hasShifts.has(p.id)) {
          const sh = shifts.find((x) => x.userId === p.id && x.day === day);
          if (!sh) items.push({ userId: p.id, who: p.label, type: 'dayoff', id: p.id, label: 'выходной по графику — придётся выйти', cost: COST.dayOff });
          else if (m < sh.from || m + d.duration > sh.to) items.push({ userId: p.id, who: p.label, type: 'offshift', id: p.id, label: `вне смены (${hm(sh.from)}–${hm(sh.to)})`, cost: COST.offShift });
        }
      }
      // отсутствующего участника считаем дорого, если в другие дни он может
      const cost = items.reduce((a, x) => a + x.cost, 0) + missing.filter((x) => !never.includes(x)).length * 200;
      slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), cost, items, missing: missing.filter((x) => !never.includes(x)) });
    }
  }
  slots.sort((a, b) => a.cost - b.cost || a.start.localeCompare(b.start));
  const out: Option[] = [];
  for (const o of slots) {
    if (out.length >= 3) break;
    if (out.some((x) => Math.abs(Date.parse(x.start) - Date.parse(o.start)) < Math.max(d.duration, 60) * 60_000)) continue;
    out.push(o);
  }
  return { options: out, never };
}

const LOSS = (c: number) => (c === 0 ? 'без потерь' : c <= 10 ? 'потери минимальные' : c <= 45 ? 'потери небольшие' : c < 150 ? 'потери заметные' : 'потери большие');
function optionText(o: Option, i: number, tz: string) {
  const head = `**${i + 1} — ${dayLabel(o.start, tz)}, ${local(o.start, tz)}–${local(o.end, tz)}** · ${LOSS(o.cost)}`;
  if (!o.items.length && !o.missing.length) return `${head}: все свободны ✅`;
  const lines = o.items.sort((a, b) => b.cost - a.cost).map((x) => `   – ${x.who}: ${x.label}${x.type === 'call' || x.type === 'task' ? ' → сдвину после собрания' : x.type === 'personal' || x.type === 'group' || x.type === 'client' ? ' → нужно перенести' : ''}`);
  for (const m of o.missing) lines.push(`   – не сможет: ${m}`);
  return `${head}\n${lines.join('\n')}`;
}

/* ---------- участники ---------- */
async function participants(db: Db, ctx: Ctx, d: MeetingDraft, text: string, clubs: Club[]): Promise<{ people: Who[]; ambiguous: Who[] | null }> {
  const map = new Map<string, Who>();
  if (d.roles.length) {
    const rows = (await db.query(`select distinct on (u.id) u.id, u.full_name, r.name as role from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code
      where a.club_id = any($1) and a.role_code = any($2) and u.status = 'active' and not u.is_bot and (a.active_to is null or a.active_to >= current_date) order by u.id, r.sort`, [clubs.map((c) => c.id), d.roles])).rows;
    for (const u of rows) map.set(u.id, { type: 'employee', id: u.id, label: u.full_name, role: u.role });
  }
  const named = await orderedEmployees(db, d.rest, clubs);
  for (const g of named) {
    if (g.length > 1 && !g.some((x) => map.has(x.id))) return { people: [], ambiguous: g };
    for (const w of g.length === 1 ? g : []) map.set(w.id, w);
  }
  void text;
  const me = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0];
  map.set(ctx.userId, { type: 'employee', id: ctx.userId, label: me?.full_name ?? 'Организатор', role: 'организатор' });
  return { people: [...map.values()], ambiguous: null };
}

type MeetingPending = { draft: MeetingDraft; clubId: string; tz: string; people: Who[]; options: Option[]; text: string };

/** Шаг 1: разобрать просьбу, подобрать время и предложить варианты */
export async function proposeMeeting(db: Db, ctx: Ctx, text: string): Promise<string> {
  const all = await visibleClubs(db);
  if (!all.length) return 'Не вижу ни одного клуба, к которому у вас есть доступ.';
  const explicit = /(по сети|все клубы|обоих|оба клуба|всех клубов)/.test(norm(text));
  const clubs = pickClubs(text, all);
  const tz0 = clubs[0].timezone;
  const today = await todayOf(db, tz0);
  const d = parseMeeting(text, today);
  if (d.roles.length && clubs.length > 1 && !explicit) {
    await setPending(db, ctx, { kind: 'meeting_club', text });
    return `Для какого клуба собрать ${d.groupNames.join(', ')}?\n${all.map((c, i) => `${i + 1} — ${c.name}`).join('\n')}\n${all.length + 1} — все клубы вместе\n\nНапишите номер.`;
  }
  const { people, ambiguous } = await participants(db, ctx, d, text, clubs);
  if (ambiguous) {
    await setPending(db, ctx, { kind: 'meeting_club', text, data: { ambiguous } });
    return `Уточните, кого позвать:\n${ambiguous.map((o, i) => `${i + 1} — ${o.label}${o.role ? ` (${o.role})` : ''}`).join('\n')}\n\nНапишите номер.`;
  }
  if (people.length < 2) return 'Не понял, кого позвать на собрание. Напишите группы или фамилии, например: «назначь собрание: отдел продаж и Ким, завтра или в понедельник с 10 до 18, на час, тема: план на декабрь».';
  const from = zoned(d.days[0], d.fromMin, tz0); const to = zoned(d.days.at(-1)!, d.toMin, tz0);
  const { busy, off, shifts } = await busyOf(db, people, from, to, tz0);
  const { options, never } = chooseSlots(d, people, tz0, Date.now(), busy, off, shifts);
  if (!options.length) return `В это окно (${d.days.map((x) => dayLabel(zoned(x, 600, tz0), tz0)).join(', ')}, ${hm(d.fromMin)}–${hm(d.toMin)}) свободного времени на ${d.duration} мин. нет — оно уже прошло или слишком короткое. Напишите другое окно.`;
  const clubId = clubs.length === 1 ? clubs[0].id : clubs[0].id;
  await setPending(db, ctx, { kind: 'meeting', text, data: { draft: d, clubId, tz: tz0, people, options, text } satisfies MeetingPending });
  const place = d.place || (clubs.length === 1 ? clubs[0].name : 'уточнить');
  return [
    `**Собрание «${d.title}»** · ${d.duration} мин · место: ${place}`,
    `Участники (${people.length}): ${people.map((p) => p.label).join(', ')}.`,
    never.length ? `Не сможет ни в один из дней: ${never.join(', ')}.` : '',
    `Лучшие варианты (сравнил тренировки, встречи с клиентами, звонки, задачи и смены):`,
    options.map((o, i) => optionText(o, i, tz0)).join('\n'),
    `Напишите номер — назначу, внесу в календари и разошлю приглашения. Звонки и задачи сдвину сам; тренировки и встречи с клиентами — поставлю задачу перенести тому, кто их ведёт (клиентам сам не пишу).`,
  ].filter(Boolean).join('\n\n');
}

/** Ответ на уточнение по собранию: номер варианта, клуба или человека */
export async function meetingPendingReply(db: Db, ctx: Ctx, text: string): Promise<string | null> {
  const p = await getPending(db, ctx);
  if (!p || (p.kind !== 'meeting' && p.kind !== 'meeting_club')) return null;
  const n = Number(norm(text.trim()).match(/^(\d)\b/)?.[1] ?? 0);
  if (p.kind === 'meeting_club') {
    const amb = (p.data as { ambiguous?: Who[] } | undefined)?.ambiguous;
    if (amb) {
      if (!(n >= 1 && n <= amb.length)) return null;
      return proposeMeeting(db, ctx, `${p.text} ${amb[n - 1].label}`.replace(/\s+/g, ' '));
    }
    const all = await visibleClubs(db);
    if (!(n >= 1 && n <= all.length + 1)) return null;
    return proposeMeeting(db, ctx, `${p.text} ${n === all.length + 1 ? 'по сети' : all[n - 1].name}`);
  }
  const m = p.data as MeetingPending;
  if (!(n >= 1 && n <= m.options.length)) return /^(нет|отмена|не надо|отмени)/i.test(text.trim()) ? (await setPending(db, ctx, null), 'Хорошо, собрание не назначаю.') : null;
  await setPending(db, ctx, null);
  return createMeeting(db, ctx, m, m.options[n - 1]);
}

/** Шаг 2: назначить — календари, переносы, приглашения */
async function createMeeting(db: Db, ctx: Ctx, m: MeetingPending, o: Option) {
  const { draft: d, tz } = m;
  const club = (await db.query(`select name from clubs where id = $1`, [m.clubId])).rows[0];
  const place = d.place || club?.name || '';
  const meetingId = (await db.query(`insert into staff_meetings(tenant_id, club_id, title, place, starts_at, ends_at, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, m.clubId, d.title, place, o.start, o.end, ctx.userId])).rows[0].id as string;
  const when = `${dayLabel(o.start, tz)}, ${local(o.start, tz)}–${local(o.end, tz)}`;
  const organizer = m.people.find((p) => p.id === ctx.userId)?.label ?? 'Руководитель';
  const moves: { userId: string; who: string; type: string; id: string; label: string; done: string }[] = [];
  for (const x of o.items) {
    if (x.type === 'call' || x.type === 'task') {
      await db.query(`update tasks set due_at = $2::timestamptz + interval '5 minutes' where id = $1 and done_at is null`, [x.id, o.end]);
      moves.push({ ...x, done: `сдвинуто на ${local(new Date(Date.parse(o.end) + 300_000), tz)}` });
    } else if (x.type === 'personal' || x.type === 'group' || x.type === 'client') {
      const clubId = (await db.query(x.type === 'client' ? `select club_id from meetings where id = $1` : `select club_id from class_sessions where id = $1`, [x.id])).rows[0]?.club_id ?? m.clubId;
      const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, created_by) values ($1,$2,$3,'other',$4, least($5::timestamptz, now() + interval '2 hours'), $6) returning id`,
        [ctx.tenantId, clubId, x.userId, `Перенести: ${x.label} — в это время собрание «${d.title}». Договоритесь с клиентами о новом времени`.slice(0, 300), o.start, ctx.userId])).rows[0].id;
      await card(db, clubId, [x.userId], { kind: 'agent_meeting_move', title: `Нужно перенести: ${x.label}`.slice(0, 200), body: `${when} — собрание «${d.title}». Договоритесь с клиентами о новом времени и перенесите в CRM.`, objectType: 'task', objectId: tid, actions: ['open'], link: { tab: 'tasks' } });
      moves.push({ ...x, done: 'поставлена задача перенести' });
    }
  }
  await db.query(`update staff_meetings set moves = $2 where id = $1`, [meetingId, JSON.stringify(moves)]);
  let invited = 0;
  for (const p of m.people) {
    const userClub = (await db.query(`select club_id from user_assignments where user_id = $1 and club_id is not null and (active_to is null or active_to >= current_date) order by active_from limit 1`, [p.id])).rows[0]?.club_id ?? m.clubId;
    const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, created_by) values ($1,$2,$3,'meeting',$4,$5,$6) returning id`,
      [ctx.tenantId, userClub, p.id, `Собрание «${d.title}»${place ? ` — ${place}` : ''}, ${local(o.start, tz)}–${local(o.end, tz)}`.slice(0, 300), o.start, ctx.userId])).rows[0].id;
    const self = p.id === ctx.userId;
    await db.query(`insert into staff_meeting_members(meeting_id, user_id, tenant_id, task_id, status, answered_at) values ($1,$2,$3,$4,$5,$6)`,
      [meetingId, p.id, ctx.tenantId, tid, self ? 'confirmed' : 'invited', self ? new Date() : null]);
    if (self) continue;
    const mine = moves.filter((x) => x.userId === p.id);
    const body = [`📅 **Собрание: ${d.title}**`, `Когда: **${when}**`, `Где: **${place || 'уточнит организатор'}**`, `Созвал: ${organizer}. Участников: ${m.people.length}.`,
      mine.length ? `Ради собрания: ${mine.map((x) => `${x.label} — ${x.done}`).join('; ')}.` : '', 'Собрание уже в вашем календаре (раздел «Задачи»). Подтвердите участие кнопкой ниже.'].filter(Boolean).join('\n');
    await botSay(db, ctx.tenantId, p.id, body, { kind: 'meeting_invite', meetingId });
    invited++;
  }
  await audit(db, ctx, 'agent.meeting_created', 'staff_meeting', meetingId, null, { title: d.title, start: o.start, members: m.people.length, moves: moves.length });
  return [`Готово: **собрание «${d.title}» — ${when}**, место: ${place || '—'}.`,
    `Внёс в календари ${m.people.length} участников и разослал ${invited} приглашений в мессенджер с кнопкой «Подтвердить участие».`,
    moves.length ? `Переносы:\n${moves.map((x) => `   – ${x.who}: ${x.label} — ${x.done}`).join('\n')}` : 'Ничего переносить не пришлось.',
    'Ответы участников буду присылать сюда. Спросить в любой момент: «кто подтвердил».'].join('\n\n');
}

/** Сообщение помощника сотруднику в его чат «ИИ-помощник» (с кнопкой, если есть meta) */
export async function botSay(db: Db, tenantId: string, userId: string, body: string, meta: Record<string, unknown> | null = null, important = true) {
  const { id: chatId, bot } = await ensureBotChat(db, { tenantId, userId });
  await db.query(`insert into team_messages(tenant_id, chat_id, user_id, body, important, meta) values ($1,$2,$3,$4,$5,$6)`, [tenantId, chatId, bot, body.slice(0, 4000), important, meta ? JSON.stringify(meta) : null]);
  await db.query('update team_chats set last_message_at = now() where id = $1', [chatId]);
  await db.query('update team_members set last_read_at = now() where chat_id = $1 and user_id = $2', [chatId, bot]);
}

/** «Кто подтвердил» — ближайшие собрания, где пользователь организатор или участник */
export async function meetingStatus(db: Db, ctx: Ctx) {
  const rows = (await db.query(`select sm.id, sm.title, sm.place, sm.starts_at, sm.ends_at, sm.created_by, c.timezone,
      json_agg(json_build_object('name', u.full_name, 'status', mm.status) order by u.full_name) as members
    from staff_meetings sm join clubs c on c.id = sm.club_id join staff_meeting_members mm on mm.meeting_id = sm.id join users u on u.id = mm.user_id
    where sm.status = 'planned' and sm.ends_at > now() and (sm.created_by = $1 or exists (select 1 from staff_meeting_members x where x.meeting_id = sm.id and x.user_id = $1))
    group by sm.id, c.timezone order by sm.starts_at limit 5`, [ctx.userId])).rows;
  if (!rows.length) return 'Ближайших собраний нет. Назначить: «назначь собрание отдел продаж завтра с 10 до 14, тема: план».';
  return rows.map((r) => {
    const ms = r.members as { name: string; status: string }[];
    const ok = ms.filter((x) => x.status === 'confirmed'); const no = ms.filter((x) => x.status === 'declined'); const wait = ms.filter((x) => x.status === 'invited');
    return [`📅 **${r.title}** — ${dayLabel(r.starts_at, r.timezone)}, ${local(r.starts_at, r.timezone)}–${local(r.ends_at, r.timezone)}${r.place ? `, ${r.place}` : ''}`,
      `✅ Подтвердили (${ok.length}): ${ok.map((x) => x.name).join(', ') || '—'}`, no.length ? `❌ Не смогут (${no.length}): ${no.map((x) => x.name).join(', ')}` : '',
      wait.length ? `⏳ Ещё не ответили (${wait.length}): ${wait.map((x) => x.name).join(', ')}` : ''].filter(Boolean).join('\n');
  }).join('\n\n');
}

/** Участник нажал «Подтвердить участие» / «Не смогу» */
export async function answerMeeting(db: Db, ctx: Ctx, meetingId: string, answer: 'confirmed' | 'declined') {
  const m = (await db.query(`select sm.id, sm.title, sm.created_by, sm.starts_at, c.timezone from staff_meetings sm join clubs c on c.id = sm.club_id
    join staff_meeting_members mm on mm.meeting_id = sm.id and mm.user_id = $2 where sm.id = $1 and sm.status = 'planned'`, [meetingId, ctx.userId])).rows[0];
  if (!m) throw notFound('Собрание не найдено');
  const prev = (await db.query(`update staff_meeting_members mm set status = $3, answered_at = now() from (select status from staff_meeting_members where meeting_id = $1 and user_id = $2) old
    where mm.meeting_id = $1 and mm.user_id = $2 returning old.status`, [meetingId, ctx.userId, answer])).rows[0]?.status;
  await db.query(`update team_messages set meta = meta || jsonb_build_object('status', $2::text) where meta->>'meetingId' = $1
    and chat_id in (select chat_id from team_members where user_id = $3)`, [meetingId, answer, ctx.userId]);
  if (prev !== answer && m.created_by && m.created_by !== ctx.userId) {
    const me = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0]?.full_name ?? 'Сотрудник';
    const cnt = (await db.query(`select count(*) filter (where status = 'confirmed')::int as ok, count(*)::int as n from staff_meeting_members where meeting_id = $1`, [meetingId])).rows[0];
    await botSay(db, ctx.tenantId, m.created_by, answer === 'confirmed'
      ? `✅ ${me} подтвердил(а) участие в собрании «${m.title}» (${dayLabel(m.starts_at, m.timezone)}, ${local(m.starts_at, m.timezone)}). Подтвердили ${cnt.ok} из ${cnt.n}.`
      : `❌ ${me} не сможет прийти на собрание «${m.title}» (${dayLabel(m.starts_at, m.timezone)}, ${local(m.starts_at, m.timezone)}). Подтвердили ${cnt.ok} из ${cnt.n}.`, null, false);
  }
  await audit(db, ctx, 'agent.meeting_answer', 'staff_meeting', meetingId, null, { answer });
  return { status: answer };
}

/** За час до собрания: напомнить тем, кто не ответил, и сообщить организатору, кто подтвердил */
export async function processMeetingReminders(db: Db, clubId: string) {
  const rows = (await db.query(`select sm.id, sm.club_id, sm.title, sm.place, sm.starts_at, sm.created_by, sm.tenant_id, c.timezone from staff_meetings sm join clubs c on c.id = sm.club_id
    where sm.club_id = $1 and sm.status = 'planned' and sm.starts_at between now() and now() + interval '65 minutes'`, [clubId])).rows;
  let n = 0;
  for (const m of rows) {
    const sent = await db.query(`insert into agent_sent(tenant_id, club_id, key) values ($1, $2, $3) on conflict do nothing`, [m.tenant_id, m.club_id, `meeting:${m.id}:h1`]);
    if (!sent.rowCount) continue;
    const wait = (await db.query(`select user_id from staff_meeting_members where meeting_id = $1 and status = 'invited'`, [m.id])).rows.map((r) => r.user_id as string);
    for (const u of wait) await botSay(db, m.tenant_id, u, `⏰ Через час собрание «${m.title}» — ${local(m.starts_at, m.timezone)}${m.place ? `, ${m.place}` : ''}. Вы ещё не подтвердили участие.`, { kind: 'meeting_invite', meetingId: m.id });
    const confirmed = (await db.query(`select u.full_name from staff_meeting_members mm join users u on u.id = mm.user_id where mm.meeting_id = $1 and mm.status = 'confirmed' and mm.user_id <> $2`, [m.id, m.created_by])).rows.map((r) => r.full_name);
    if (m.created_by) await botSay(db, m.tenant_id, m.created_by, `⏰ Через час собрание «${m.title}». Подтвердили: ${confirmed.length ? confirmed.join(', ') : 'пока никто'}${wait.length ? `; не ответили ${wait.length} — напомнил им` : ''}.`, null, false);
    n++;
  }
  return n;
}

export function agentMeetingRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post('/api/agent/meetings/:id/answer', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const a = (req.body as { answer?: string } | null)?.answer;
    if (a !== 'confirmed' && a !== 'declined') throw badRequest('Ответ: confirmed или declined');
    return withCtx(pool, ctx, (db) => answerMeeting(db, ctx, id, a));
  });
  app.get('/api/agent/meetings', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => (await db.query(`select sm.id, sm.title, sm.place, sm.starts_at as "startsAt", sm.ends_at as "endsAt", mm.status
      from staff_meetings sm join staff_meeting_members mm on mm.meeting_id = sm.id and mm.user_id = $1 where sm.status = 'planned' and sm.ends_at > now() order by sm.starts_at`, [ctx.userId])).rows);
  });
}
