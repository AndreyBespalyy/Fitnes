// Отдел продаж глазами ИИ-агента (просьба Андрея 17.11.2026):
// — рейтинг менеджеров 0–100 каждое утро: темп личного плана, перевыполнение, скорость ответа на заявки и сообщения,
//   дисциплина по наблюдениям агента (просрочки, эскалации до руководителя, клиенты без ответа) и вывод агента — почему такой балл;
// — утренняя сводка РОПу: по каждому менеджеру план к графику, сколько задач вчера не сделано и сколько перенесено,
//   и кнопка «Чат с менеджером» с темой по его сводке.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireCtx } from '../auth.ts';
import { withCtx, type Db } from '../db.ts';
import { scriptStats } from './agentScripts.ts';
import { clientsFact, kpi, monthInfo, planFact, salesFact, targets } from './dash.ts';

const W = { plan: 35, over: 10, speed: 20, discipline: 20, script: 15 };
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU').replace(/[ ,]/g, ' ')} ₽`;
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const surname = (n: string) => n.split(' ').slice(-1)[0];
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export type Rating = {
  userId: string; name: string; score: number;
  parts: { plan: number; over: number; speed: number; discipline: number; script: number };
  facts: { planKop: number | null; factKop: number; percent: number | null; pace: number | null; expectedKop: number | null; forecastPct: number | null;
    leadMin: number | null; leadNorm?: number; msgMin: number | null; overdue: number; escalations: number; waiting: number; notDone: number; moved: number;
    scriptChecks: number; scriptMisses: number; scriptAvg: number | null };
  note: string;
};

/** Менеджеры клуба (роль «менеджер по продажам») */
async function managers(db: Db, clubId: string) {
  return (await db.query(`select distinct u.id, u.full_name as name from users u join user_assignments a on a.user_id = u.id
    where a.club_id = $1 and a.role_code = 'manager' and u.status = 'active' and not u.is_bot and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)
    order by u.full_name`, [clubId])).rows as { id: string; name: string }[];
}

/** Расчёт рейтинга за день `day` (данные месяца по этот день включительно) */
export async function rateManagers(db: Db, clubId: string, day: string): Promise<Rating[]> {
  const ms = await managers(db, clubId);
  if (!ms.length) return [];
  const tz = (await db.query(`select timezone from clubs where id = $1`, [clubId])).rows[0]?.timezone ?? 'Europe/Moscow';
  const month = day.slice(0, 7);
  const mi = monthInfo(month, day);
  const tg = await targets(db, [clubId], month); const sf = await salesFact(db, [clubId], mi.from, day); const cf = await clientsFact(db, [clubId], mi.from, day);
  const weekFrom = (await db.query(`select to_char($1::date - 6, 'YYYY-MM-DD') as d`, [day])).rows[0].d as string;
  const k = await kpi(db, [clubId], weekFrom, day, ms.map((m) => m.id));
  // Норма ответа на заявку — одна на клуб (повторная проверка CRM 18.11.2026, п. 3)
  const leadNorm = Number((await db.query('select first_response_minutes as m from clubs where id = $1', [clubId])).rows[0]?.m ?? 5);
  const out: Rating[] = [];
  for (const m of ms) {
    const t = planFact(mi, tg, sf, cf, { userId: m.id }).total;
    const expected = t.planKop ? Math.round((t.planKop * mi.passed) / mi.days) : null;
    const pace = expected ? t.factKop / expected : null;
    const forecastPct = t.planKop ? Math.round((t.forecastKop * 100) / t.planKop) : null;
    // Скорость ответа: заявки (первый контакт) и сообщения клиентов в переписке, медиана за неделю, минуты
    const leadMin = (k.find((x) => x.userId === m.id)?.values.first_response as number | null | undefined) ?? null;
    const msgMin = (await db.query(`select round(percentile_cont(0.5) within group (order by extract(epoch from o.created_at - i.created_at) / 60))::int as m
      from msg_messages i join msg_conversations c on c.id = i.conversation_id and c.club_id = $1
      join lateral (select o.created_at from msg_messages o where o.conversation_id = i.conversation_id and o.direction = 'out' and not o.auto and o.created_at > i.created_at order by o.created_at limit 1) o on true
      where i.direction = 'in' and c.assigned_to = $2 and i.created_at >= ($3::date)::timestamp at time zone $5 and i.created_at < ($4::date + 1)::timestamp at time zone $5
        and not exists (select 1 from msg_messages p where p.conversation_id = i.conversation_id and p.direction = 'in' and p.created_at < i.created_at and p.created_at > i.created_at - interval '10 minutes')`,
    [clubId, m.id, weekFrom, day, tz])).rows[0]?.m as number | null ?? null;
    // Наблюдения агента: просрочки сейчас, эскалации до руководителя и клиенты, ждавшие ответа, за неделю
    const overdue = (await db.query(`select count(*)::int as n from tasks where assignee_id = $1 and club_id = $2 and done_at is null and due_at < now()`, [m.id, clubId])).rows[0].n as number;
    const escalations = (await db.query(`select count(*)::int as n from agent_sent s join tasks t on t.id::text = split_part(s.key, ':', 2)
      where s.club_id = $1 and s.key like 'task:%' and s.key not like '%:1' and t.assignee_id = $2 and s.sent_at > now() - interval '7 days'`, [clubId, m.id])).rows[0].n as number;
    const waiting = (await db.query(`select count(distinct split_part(s.key, ':', 2))::int as n from agent_sent s join msg_conversations c on c.id::text = split_part(s.key, ':', 2)
      where s.club_id = $1 and s.key like 'reply:%' and c.assigned_to = $2 and s.sent_at > now() - interval '7 days'`, [clubId, m.id])).rows[0].n as number;
    // Вчерашний день (= day): сколько задач со сроком в этот день не сделано и сколько раз сроки перенесены
    const notDone = (await db.query(`select count(*)::int as n from tasks where assignee_id = $1 and club_id = $2 and (due_at at time zone $4)::date = $3::date
      and (done_at is null or done_at > due_at + interval '1 hour')`, [m.id, clubId, day, tz])).rows[0].n as number;
    const moved = (await db.query(`select count(*)::int as n from audit_log a join tasks t on t.id::text = a.object_id where a.action = 'agent.task_snoozed' and t.assignee_id = $1 and t.club_id = $2
      and (a.at at time zone $4)::date = $3::date`, [m.id, clubId, day, tz])).rows[0].n as number;

    const plan = pace === null ? null : clamp(pace) * W.plan;
    const over = pace === null ? 0 : clamp((pace - 1) / 0.5) * W.over;
    const sp = (x: number | null) => (x === null ? null : clamp((60 - x) / 55));
    const speeds = [sp(leadMin), sp(msgMin)].filter((x): x is number => x !== null);
    const speed = (speeds.length ? speeds.reduce((a, x) => a + x, 0) / speeds.length : 0.5) * W.speed;
    const discipline = clamp(1 - (Math.min(overdue, 5) * 3 + escalations * 4 + waiting * 2) / W.discipline) * W.discipline;
    // Разговоры по скриптам («Дядя Витя», 14 дней): средний процент пройденных пунктов; нет разборов — нейтрально
    const ss = await scriptStats(db, clubId, m.id, day);
    const script = (ss.avg === null ? 0.5 : clamp(ss.avg / 100)) * W.script;
    // Без личного плана часть «план» считается по остальным частям, чтобы балл был сравним
    const score = Math.round(plan === null ? ((speed + discipline + script) / (W.speed + W.discipline + W.script)) * 100 : plan + over + speed + discipline + script);
    const facts = { planKop: t.planKop, factKop: t.factKop, percent: t.percent, pace: pace === null ? null : Math.round(pace * 100), expectedKop: expected, forecastPct, leadMin, leadNorm, msgMin, overdue, escalations, waiting, notDone, moved,
      scriptChecks: ss.checks, scriptMisses: ss.misses, scriptAvg: ss.avg };
    out.push({ userId: m.id, name: m.name, score, parts: { plan: Math.round(plan ?? 0), over: Math.round(over), speed: Math.round(speed), discipline: Math.round(discipline), script: Math.round(script) }, facts, note: agentNote(facts) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Вывод агента: что сильнее всего снижает балл и что сделать */
function agentNote(f: Rating['facts']) {
  const bad: string[] = []; const good: string[] = [];
  if (f.pace === null) bad.push('личный план на месяц не задан — балл посчитан без плана');
  else if (f.pace < 85) bad.push(`отстаёт от графика плана на ${100 - f.pace} %${f.forecastPct !== null ? `, прогноз на месяц — ${f.forecastPct} % плана` : ''}`);
  else if (f.pace > 110) good.push(`опережает график на ${f.pace - 100} %`);
  else good.push('идёт по графику плана');
  const norm = f.leadNorm ?? 5;
  if (f.leadMin !== null && f.leadMin > norm) bad.push(`отвечает на заявки за ${f.leadMin} мин (норма ${norm})`);
  else if (f.leadMin !== null) good.push(`быстро отвечает на заявки (${f.leadMin} мин)`);
  if (f.msgMin !== null && f.msgMin > 30) bad.push(`отвечает клиентам в переписке за ${f.msgMin} мин`);
  if (f.overdue) bad.push(`просрочено задач: ${f.overdue}`);
  if (f.escalations) bad.push(`за неделю ${f.escalations} раз просрочка дошла до руководителя`);
  if (f.waiting) bad.push(`клиенты ждали ответа: ${f.waiting}`);
  if (f.scriptMisses) bad.push(`отходит от скрипта: ${f.scriptMisses} из ${f.scriptChecks} разобранных разговоров (в среднем ${f.scriptAvg} % пунктов)`);
  else if (f.scriptChecks) good.push(`разговоры по скрипту (${f.scriptChecks} разобрано)`);
  const todo = f.pace !== null && f.pace < 85 ? 'Что сделать: звонки по горячему списку и продлениям каждый день, пока не догонит график.'
    : f.overdue || f.escalations ? 'Что сделать: разобрать просроченные задачи — закрыть или честно перенести.'
      : f.leadMin !== null && f.leadMin > norm ? `Что сделать: брать заявки сразу, в течение ${norm} мин.`
        : f.scriptMisses ? 'Что сделать: перечитать разборы звонков от Дяди Вити и пройти пропущенные этапы скрипта в следующих разговорах.' : '';
  return [good.length ? `Плюсы: ${good.join(', ')}.` : '', bad.length ? `Снижает балл: ${bad.join('; ')}.` : 'Замечаний нет.', todo].filter(Boolean).join(' ');
}

/** Пересчитать и сохранить рейтинг клуба за день */
export async function saveRatings(db: Db, clubId: string, day: string) {
  const rs = await rateManagers(db, clubId, day);
  for (const r of rs) {
    await db.query(`insert into manager_ratings(tenant_id, club_id, user_id, day, score, parts, facts, note) values (app_tenant(), $1, $2, $3, $4, $5, $6, $7)
      on conflict (club_id, user_id, day) do update set score = excluded.score, parts = excluded.parts, facts = excluded.facts, note = excluded.note, created_at = now()`,
    [clubId, r.userId, day, r.score, JSON.stringify(r.parts), JSON.stringify(r.facts), r.note]);
  }
  return rs;
}

/** Утренняя сводка РОПу: по каждому менеджеру — план к графику, вчера не сделано / перенесено, рейтинг; кнопка «Чат с менеджером» */
export function ropSummary(day: string, rs: Rating[]) {
  if (!rs.length) return null;
  const byLag = [...rs].sort((a, b) => (a.facts.pace ?? 999) - (b.facts.pace ?? 999));
  const lines = [`**Отдел продаж за ${ddmmyyyy(day)}: выполнение плана менеджерами**`];
  for (const r of byLag) {
    const f = r.facts;
    const plan = f.pace === null ? 'личный план не задан' : `план ${f.percent} % (${rub(f.factKop)} из ${rub(f.planKop!)}), ${f.pace < 100 ? `отстаёт от графика на ${100 - f.pace} %` : f.pace > 100 ? `опережает график на ${f.pace - 100} %` : 'по графику'}`;
    lines.push(`• **${r.name}** — ${plan}; вчера не сделано задач: ${f.notDone}, перенесено: ${f.moved}; рейтинг **${r.score}**`);
  }
  const actions = byLag.slice(0, 6).map((r) => ({ label: `Чат с менеджером: ${surname(r.name)}`, chat: { userId: r.userId, text: chatTopic(day, r) } }));
  return { text: lines.join('\n'), actions };
}

/** Тема разговора с менеджером — по его сводке */
export function chatTopic(day: string, r: Rating) {
  const f = r.facts;
  const tasks = f.notDone || f.moved ? ` Вчера не сделано задач: ${f.notDone}, перенесено: ${f.moved}.` : '';
  if (f.pace !== null && f.pace < 100) return `Невыполнение плана за ${ddmmyyyy(day)}: ${f.percent} % плана, отставание от графика ${100 - f.pace} %.${tasks} Давайте разберём, что мешает и как наверстать.`;
  if (f.pace !== null && f.pace > 100) return `Выполнение плана за ${ddmmyyyy(day)}: опережаете график на ${f.pace - 100} % — отлично!${tasks} Что помогает? Поделитесь, пожалуйста, с командой.`;
  return `Итоги за ${ddmmyyyy(day)}: рейтинг ${r.score}.${tasks} Давайте обсудим план на сегодня.`;
}

/** Утром — один раз по клубу: пересчитать рейтинг; РОПу (а если его нет — управляющему) отправляется сводка */
export async function salesTeamMorning(db: Db, clubId: string, today: string) {
  const day = (await db.query(`select to_char($1::date - 1, 'YYYY-MM-DD') as d`, [today])).rows[0].d as string;
  const rs = await saveRatings(db, clubId, day);
  return ropSummary(day, rs);
}

/* ---------- кто видит рейтинг: сам менеджер, РОП, управляющий, собственник ---------- */
async function viewerRoles(db: Db, userId: string) {
  return (await db.query(`select role_code from user_assignments where user_id = $1 and (active_to is null or active_to >= current_date)`, [userId])).rows.map((r) => r.role_code as string);
}
const LEADERS = ['rop', 'gm', 'owner'];

export function salesTeamRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Рейтинг менеджеров: руководителям — все менеджеры видимых клубов, менеджеру — только свой; история за 30 дней
  app.get('/api/manager-ratings', async (req, reply) => {
    const ctx = requireCtx(req);
    const { clubId, userId } = req.query as { clubId?: string; userId?: string };
    return withCtx(pool, ctx, async (db) => {
      const roles = await viewerRoles(db, ctx.userId);
      const leader = roles.some((r) => LEADERS.includes(r));
      if (!leader && !roles.includes('manager')) return reply.code(403).send({ error: 'forbidden', message: 'Рейтинг видят менеджеры, РОП, управляющий и собственник' });
      const only = leader ? userId ?? null : ctx.userId;
      // Рейтинг ещё не считался (новый клуб, первый день) — считаем за вчера сразу
      const clubs = (await db.query(`select id, timezone from clubs where status = 'active' and not is_demo and ($1::uuid is null or id = $1)`, [clubId && clubId !== 'all' ? clubId : null])).rows;
      for (const c of clubs) {
        const day = (await db.query(`select to_char((now() at time zone $1)::date - 1, 'YYYY-MM-DD') as d`, [c.timezone])).rows[0].d as string;
        if (!(await db.query(`select 1 from manager_ratings where club_id = $1 and day = $2 limit 1`, [c.id, day])).rowCount) await saveRatings(db, c.id, day);
      }
      const rows = (await db.query(`select r.user_id as "userId", u.full_name as name, r.club_id as "clubId", c.name as "clubName", to_char(r.day, 'YYYY-MM-DD') as day,
          r.score, r.parts, r.facts, r.note
        from manager_ratings r join users u on u.id = r.user_id join clubs c on c.id = r.club_id
        where ($1::uuid is null or r.club_id = $1) and ($2::uuid is null or r.user_id = $2) and r.day > current_date - 31 and not c.is_demo
        order by r.day desc, r.score desc`, [clubId && clubId !== 'all' ? clubId : null, only])).rows;
      const latest = new Map<string, (typeof rows)[number] & { history: { day: string; score: number }[] }>();
      for (const r of rows) {
        const key = `${r.clubId}:${r.userId}`;
        if (!latest.has(key)) latest.set(key, { ...r, history: [] });
        latest.get(key)!.history.unshift({ day: r.day, score: r.score });
      }
      return { items: [...latest.values()].sort((a, b) => b.score - a.score) };
    });
  });
}

/* ---------- чат: «сводка по менеджерам», «рейтинг менеджеров» ---------- */
export const TEAM_RE = /(сводк\S*|рейтинг\S*|итоги)\s+(по\s+)?менеджер|менеджер\S*\s+(сводк|рейтинг)/i;

export async function teamChatAnswer(db: Db, clubIds: string[]) {
  const parts: { text: string; actions: { label: string; chat: { userId: string; text: string } }[] }[] = [];
  for (const id of clubIds) {
    const tz = (await db.query(`select timezone from clubs where id = $1`, [id])).rows[0]?.timezone ?? 'Europe/Moscow';
    const today = (await db.query(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz])).rows[0].d as string;
    const s = await salesTeamMorning(db, id, today);
    if (s) parts.push(s);
  }
  if (!parts.length) return null;
  return { text: parts.map((p) => p.text).join('\n\n'), actions: parts.flatMap((p) => p.actions).slice(0, 8) };
}
