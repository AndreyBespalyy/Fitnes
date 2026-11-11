// Опросы после визита (список «20 новых возможностей», п. 6). Клиенту приходит вопрос «порекомендуете ли клуб» с ответом цифрой 0–10:
// после первого визита, через 30 дней после первой покупки и раз в квартал действующим клиентам.
// Низкая оценка — задача управляющему со сроком, высокая — просьба оставить отзыв на Яндекс Картах или в 2ГИС. Индекс по клубу и сотрудникам.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { conversationFor, deliver, firstName, queueMessage, renderTemplate } from './messaging.ts';
import type { Fetch } from './msgProviders.ts';

type Actor = { tenantId: string; userId: string | null };
const uuid = (s?: string | null) => !!s && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

export const DEFAULT_SURVEY = { enabled: true, firstVisit: true, day30: true, quarterly: true, lowMax: 6, highMin: 9, taskHours: 24, yandexUrl: null as string | null, gisUrl: null as string | null,
  question: '{имя}, насколько вероятно, что вы порекомендуете клуб {клуб} друзьям? Ответьте цифрой от 0 до 10, где 10 — точно порекомендую. Можно добавить пару слов, что понравилось или что улучшить.' };
export async function surveySettings(db: Db, clubId: string) {
  const r = (await db.query(`select enabled, first_visit as "firstVisit", day30, quarterly, question, low_max as "lowMax", high_min as "highMin", task_hours as "taskHours",
    yandex_url as "yandexUrl", gis_url as "gisUrl" from club_survey_settings where club_id = $1`, [clubId])).rows[0];
  return (r ?? DEFAULT_SURVEY) as typeof DEFAULT_SURVEY;
}

/** Ответ клиента: первая цифра 0–10 в начале сообщения — оценка, остальное — комментарий */
export function parseScore(text: string): { score: number; comment: string | null } | null {
  const m = text.trim().match(/^(10|[0-9])(?![0-9])\s*(?:из\s*10|\/\s*10)?[\s,.!:;—–-]*([\s\S]*)$/i);
  if (!m) return null;
  return { score: Number(m[1]), comment: m[2].trim() || null };
}

/** Кому и какой опрос отправить сегодня */
async function due(db: Db, clubId: string, today: string, s: typeof DEFAULT_SURVEY) {
  const out: { personId: string; kind: 'first_visit' | 'day30' | 'quarterly'; key: string; staffId: string | null }[] = [];
  const seller = `(select m.created_by from memberships m where m.person_id = x.person_id and m.club_id = $1 and m.status <> 'cancelled' order by m.created_at desc limit 1)`;
  if (s.firstVisit) {
    // Первый визит в клуб был от 2 до 48 часов назад
    out.push(...(await db.query(`select x.person_id, x.id::text as key, ${seller} as staff from (
        select distinct on (v.person_id) v.person_id, v.id, v.visited_at from visits v where v.club_id = $1 order by v.person_id, v.visited_at) x
      where x.visited_at between now() - interval '48 hours' and now() - interval '2 hours'`, [clubId])).rows.map((r) => ({ personId: r.person_id, kind: 'first_visit' as const, key: r.key, staffId: r.staff })));
  }
  if (s.day30) {
    // Первая покупка в клубе была 30–33 дня назад
    out.push(...(await db.query(`select x.person_id, x.id::text as key, x.created_by as staff from (
        select distinct on (m.person_id) m.person_id, m.id, m.starts_on, m.created_by from memberships m where m.club_id = $1 and m.kind <> 'guest' and m.status <> 'cancelled'
        order by m.person_id, m.created_at) x
      where x.starts_on between $2::date - 33 and $2::date - 30`, [clubId, today])).rows.map((r) => ({ personId: r.person_id, kind: 'day30' as const, key: r.key, staffId: r.staff })));
  }
  if (s.quarterly) {
    // Действующие клиенты, которые ходили за последние 30 дней, с абонементом старше 60 дней; не чаще раза в квартал. Не больше 30 в день, чтобы растянуть
    const q = `${today.slice(0, 4)}-Q${Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1}`;
    out.push(...(await db.query(`select x.person_id, ${seller} as staff from (
        select distinct m.person_id from memberships m where m.club_id = $1 and m.status = 'active' and m.starts_on <= $2::date - 60 and (m.ends_on is null or m.ends_on >= $2::date)
          and exists (select 1 from visits v where v.person_id = m.person_id and v.club_id = $1 and v.visited_at > now() - interval '30 days')) x
      where not exists (select 1 from surveys s where s.person_id = x.person_id and s.club_id = $1 and s.created_at > now() - interval '80 days')
      order by x.person_id limit 30`, [clubId, today])).rows.map((r) => ({ personId: r.person_id, kind: 'quarterly' as const, key: q, staffId: r.staff })));
  }
  return out;
}

/** Отправка опросов. Не чаще одного опроса клиенту за 30 дней, только тем, кто не отказался от сообщений */
export async function sendSurveys(db: Db, f: Fetch | null, actor: Actor, clubId: string, today: string) {
  const s = await surveySettings(db, clubId);
  if (!s.enabled) return 0;
  let sent = 0;
  for (const d of await due(db, clubId, today, s)) {
    if ((await db.query('select 1 from surveys where person_id = $1 and kind = $2 and period_key = $3', [d.personId, d.kind, d.key])).rowCount) continue;
    if ((await db.query(`select 1 from surveys where person_id = $1 and created_at > now() - interval '30 days'`, [d.personId])).rowCount) continue;
    const p = (await db.query('select messaging_opt_out from persons where id = $1 and merged_into_id is null', [d.personId])).rows[0];
    if (!p || p.messaging_opt_out) continue;
    const conv = await conversationFor(db, actor, d.personId, clubId, true);
    if (!conv || conv === 'new') continue;
    const text = await renderTemplate(db, s.question, d.personId, clubId);
    const mid = await queueMessage(db, actor, conv, text, { auto: true });
    await db.query('update msg_conversations set last_message_at = now() where id = $1', [conv]);
    await db.query(`insert into surveys(tenant_id, club_id, person_id, kind, period_key, conversation_id, message_id, staff_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor.tenantId, clubId, d.personId, d.kind, d.key, conv, mid, d.staffId]);
    if (f) await deliver(db, f, mid);
    sent++;
  }
  return sent;
}

/** Разбор ответов: оценка из сообщения клиента; низкая — задача управляющему, высокая — просьба об отзыве */
export async function collectAnswers(db: Db, f: Fetch | null, actor: Actor, clubId: string) {
  const s = await surveySettings(db, clubId);
  await db.query(`update surveys set status = 'expired' where club_id = $1 and status = 'sent' and created_at < now() - interval '3 days'`, [clubId]);
  const open = (await db.query(`select s.id, s.person_id, s.conversation_id, s.created_at, s.kind, p.full_name from surveys s join persons p on p.id = s.person_id
    where s.club_id = $1 and s.status = 'sent' and s.conversation_id is not null`, [clubId])).rows;
  let answered = 0;
  for (const sv of open) {
    const inbound = (await db.query(`select body, created_at from msg_messages where conversation_id = $1 and direction = 'in' and created_at > $2 order by created_at limit 3`,
      [sv.conversation_id, sv.created_at])).rows;
    let res: ReturnType<typeof parseScore> = null; let i = 0;
    for (; i < inbound.length && !res; i++) res = parseScore(inbound[i].body ?? '');
    if (!res) continue;
    // Комментарий может прийти следующим сообщением
    const comment = res.comment ?? (inbound[i]?.body?.trim() || null);
    await db.query(`update surveys set status = 'answered', score = $2, comment = $3, answered_at = now() where id = $1`, [sv.id, res.score, comment]);
    answered++;
    const name = firstName(sv.full_name);
    const reply = async (text: string) => { const mid = await queueMessage(db, actor, sv.conversation_id, text, { auto: true }); if (f) await deliver(db, f, mid); };
    if (res.score <= s.lowMax) {
      const gm = (await db.query(`select u.id from users u join user_assignments a on a.user_id = u.id where a.club_id = $1 and a.role_code = 'gm' and u.status = 'active' limit 1`, [clubId])).rows[0]?.id ?? null;
      const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at) values ($1,$2,$3,$4,'call',$5, now() + make_interval(hours => $6::int)) returning id`,
        [actor.tenantId, clubId, gm, sv.person_id, `Низкая оценка клуба: ${res.score} из 10. Связаться и разобраться${comment ? `: «${comment.slice(0, 200)}»` : ''}`, s.taskHours])).rows[0].id;
      await db.query('update surveys set task_id = $2 where id = $1', [sv.id, tid]);
      await reply(`${name}, спасибо за честный ответ. Нам жаль, что что-то пошло не так — управляющий клуба свяжется с вами и разберётся.`);
    } else if (res.score >= s.highMin) {
      const links = [s.yandexUrl && `Яндекс Карты: ${s.yandexUrl}`, s.gisUrl && `2ГИС: ${s.gisUrl}`].filter(Boolean);
      if (links.length) {
        await reply(`${name}, спасибо! Нам очень приятно. Если не трудно, оставьте пару слов о клубе — это помогает другим нас найти.\n${links.join('\n')}`);
        await db.query('update surveys set review_asked_at = now() where id = $1', [sv.id]);
      } else await reply(`${name}, спасибо! Нам очень приятно, ждём вас на тренировках.`);
    } else {
      await reply(`${name}, спасибо за оценку! Если есть идея, что улучшить, просто напишите — мы читаем каждое сообщение.`);
    }
  }
  return answered;
}

/** Индекс: % поставивших high_min…10 минус % поставивших 0…low_max */
export function npsOf(scores: number[], lowMax = 6, highMin = 9) {
  if (!scores.length) return { index: null as number | null, n: 0, promoters: 0, passives: 0, detractors: 0 };
  const pr = scores.filter((x) => x >= highMin).length; const de = scores.filter((x) => x <= lowMax).length;
  return { index: Math.round(((pr - de) * 100) / scores.length), n: scores.length, promoters: pr, passives: scores.length - pr - de, detractors: de };
}
export async function npsReport(db: Db, clubIds: string[], from: string, to: string) {
  const rows = (await db.query(`select s.club_id, s.staff_id, u.full_name as staff, s.score, s.kind from surveys s left join users u on u.id = s.staff_id
    where s.club_id = any($1) and s.status = 'answered' and (s.answered_at >= ($2)::date::timestamp at time zone 'Europe/Moscow' and s.answered_at < (($3)::date + 1)::timestamp at time zone 'Europe/Moscow')`, [clubIds, from, to])).rows;
  const sent = Number((await db.query(`select count(*) from surveys where club_id = any($1) and (created_at >= ($2)::date::timestamp at time zone 'Europe/Moscow' and created_at < (($3)::date + 1)::timestamp at time zone 'Europe/Moscow')`, [clubIds, from, to])).rows[0].count);
  const staff = new Map<string, number[]>();
  for (const r of rows) if (r.staff) staff.set(r.staff, [...(staff.get(r.staff) ?? []), r.score]);
  const lows = (await db.query(`select s.id, s.person_id as "personId", p.full_name as name, s.score, s.comment, s.answered_at as "answeredAt", t.done_at as "taskDoneAt", t.result as "taskResult"
    from surveys s join persons p on p.id = s.person_id left join tasks t on t.id = s.task_id
    where s.club_id = any($1) and s.status = 'answered' and s.task_id is not null and (s.answered_at >= ($2)::date::timestamp at time zone 'Europe/Moscow' and s.answered_at < (($3)::date + 1)::timestamp at time zone 'Europe/Moscow') order by s.answered_at desc limit 50`, [clubIds, from, to])).rows;
  return { ...npsOf(rows.map((r) => r.score)), sent, answeredPct: sent ? Math.round((rows.length * 100) / sent) : null,
    byKind: ['first_visit', 'day30', 'quarterly'].map((k) => ({ kind: k, ...npsOf(rows.filter((r) => r.kind === k).map((r) => r.score)) })),
    byStaff: [...staff.entries()].map(([name, sc]) => ({ name, ...npsOf(sc) })).sort((a, b) => b.n - a.n), lows };
}

export async function processSurveys(pool: pg.Pool, f: Fetch | null) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const actor = { tenantId, userId: null };
    const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select c.id, to_char(now() at time zone c.timezone, 'YYYY-MM-DD') as today,
      extract(hour from now() at time zone c.timezone)::int as h, coalesce(s.work_from, 9) as wf, coalesce(s.work_to, 21) as wt
      from clubs c left join club_msg_settings s on s.club_id = c.id where c.status = 'active' and not c.is_demo`)).rows);
    for (const c of clubs) {
      await withCtx(pool, sys, async (db) => {
        await collectAnswers(db, f, actor, c.id);
        if (c.h >= Math.max(11, c.wf) && c.h < Math.min(20, c.wt)) await sendSurveys(db, f, actor, c.id, c.today);
      }).catch((e) => console.error('Опросы:', (e as Error).message));
    }
  }
}
export function startSurveyWorker(pool: pg.Pool, f: Fetch = fetch, everyMs = 5 * 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processSurveys(pool, f); } finally { busy = false; } };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

export function surveyRoutes(app: FastifyInstance, pool: pg.Pool) {
  const club = async (db: Db, id?: string) => { if (!uuid(id) || !(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw badRequest('Выберите клуб'); return id!; };
  app.get('/api/surveys', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const q = req.query as { clubId?: string; from?: string; to?: string };
    if (!isDate(q.from) || !isDate(q.to)) throw badRequest('Укажите период');
    return withCtx(pool, ctx, async (db) => {
      await club(db, q.clubId);
      const recent = (await db.query(`select s.id, s.person_id as "personId", p.full_name as name, s.kind, s.status, s.score, s.comment, s.created_at as "createdAt", s.answered_at as "answeredAt",
          s.review_asked_at as "reviewAskedAt", u.full_name as staff from surveys s join persons p on p.id = s.person_id left join users u on u.id = s.staff_id
        where s.club_id = $1 and (s.created_at >= ($2)::date::timestamp at time zone 'Europe/Moscow' and s.created_at < (($3)::date + 1)::timestamp at time zone 'Europe/Moscow') order by coalesce(s.answered_at, s.created_at) desc limit 200`, [q.clubId, q.from, q.to])).rows;
      return { report: await npsReport(db, [q.clubId!], q.from!, q.to!), settings: await surveySettings(db, q.clubId!), recent };
    });
  });
  app.put('/api/surveys/settings', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as Partial<typeof DEFAULT_SURVEY> & { clubId?: string };
    const s = { ...DEFAULT_SURVEY, ...b };
    if (!(Number.isInteger(s.lowMax) && Number.isInteger(s.highMin) && s.lowMax >= 0 && s.highMin <= 10 && s.lowMax < s.highMin)) throw badRequest('Границы оценок: «недоволен» до N, «доволен» от M, где N меньше M');
    const url = (u: string | null) => { if (!u?.trim()) return null; if (!/^https:\/\/[^\s]+$/.test(u.trim())) throw badRequest('Ссылка на карточку клуба должна начинаться с https://'); return u.trim(); };
    if (!s.question?.trim() || s.question.trim().length < 20) throw badRequest('Текст вопроса слишком короткий');
    return withCtx(pool, ctx, async (db) => {
      await club(db, b.clubId);
      const before = await surveySettings(db, b.clubId!);
      await db.query(`insert into club_survey_settings(club_id, tenant_id, enabled, first_visit, day30, quarterly, question, low_max, high_min, task_hours, yandex_url, gis_url, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (club_id) do update set enabled = excluded.enabled, first_visit = excluded.first_visit, day30 = excluded.day30,
          quarterly = excluded.quarterly, question = excluded.question, low_max = excluded.low_max, high_min = excluded.high_min, task_hours = excluded.task_hours,
          yandex_url = excluded.yandex_url, gis_url = excluded.gis_url, updated_by = excluded.updated_by, updated_at = now()`,
      [b.clubId, ctx.tenantId, !!s.enabled, !!s.firstVisit, !!s.day30, !!s.quarterly, s.question.trim(), s.lowMax, s.highMin, Math.max(1, Math.min(168, Number(s.taskHours) || 24)), url(s.yandexUrl), url(s.gisUrl), ctx.userId]);
      const after = await surveySettings(db, b.clubId!);
      await audit(db, ctx, 'surveys.settings_changed', 'club', b.clubId!, before, after);
      return after;
    });
  });
}
