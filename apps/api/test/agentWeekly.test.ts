// ИИ-агент, этап 7: еженедельный разбор узких мест — цифры недели, узкие места, подсказки по ролям, рассылка, чат.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { buildReview, deliverReview, findBottlenecks, saveReview, weekLabel, WEEKLY_RE, type WeekMetrics } from '../src/modules/agentWeekly.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = ''; let ws = '';
const uid: Record<string, string> = {};

async function botMessages(login: string) {
  return (await sql(`select m.body from team_messages m join users b on b.id = m.user_id and b.is_bot
    join team_members tm on tm.chat_id = m.chat_id join users u on u.id = tm.user_id where u.login = $1 order by m.created_at`, [login])).map((r) => r.body as string);
}

async function ask(text: string, who = 'a.bespalyy') {
  const chat = (await req('POST', '/api/agent/chat', who)).json().id;
  const before = (await sql(`select count(*)::int as n from team_messages where chat_id = $1`, [chat]))[0].n;
  assert.equal((await req('POST', `/api/team/chats/${chat}/messages`, who, { body: text })).statusCode, 200);
  for (let i = 0; i < 300; i++) {
    const rows = await sql(`select m.body, u.is_bot from team_messages m join users u on u.id = m.user_id where m.chat_id = $1 order by m.created_at`, [chat]);
    if (rows.length >= before + 2 && rows.at(-1).is_bot) return rows.at(-1).body as string;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Помощник не ответил');
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'a.kim', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  const c = (await sql(`select id, tenant_id, timezone from clubs where name like '%Центр%'`))[0]; centr = c.id; tenant = c.tenant_id;
  ws = (await sql(`select to_char(date_trunc('week', now() at time zone $1)::date - 7, 'YYYY-MM-DD') as ws`, [c.timezone]))[0].ws;
  for (const r of await sql(`select id, login from users where login in ('a.bespalyy','o.smirnov','m.volkova','a.kim','d.lis')`)) uid[r.login] = r.id;
  // Среда прошлой недели, 11:00 по местному времени клуба
  const at = (h = 11) => `(('${ws}'::date + 2)::timestamp + interval '${h} hours') at time zone '${c.timezone}'`;

  // Заявки: три без ответа, одна с ответом через 40 минут
  for (const [i, name] of ['Ия Первая', 'Ия Вторая', 'Ия Третья', 'Ия Четвёртая'].entries()) {
    const l = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: name, phone: `+7900333440${i}`, sourceCode: 'walk_in' });
    assert.ok(l.statusCode < 300, l.body);
    await sql(`update leads set created_at = ${at()}, first_response_due_at = ${at()} + interval '15 minutes', assigned_to = $2,
      first_response_at = case when $3 then ${at()} + interval '40 minutes' end where person_id = $1`, [l.json().personId, uid['m.volkova'], i === 3]);
  }
  // Задачи менеджера: 4 со сроком на неделе, 3 просрочены
  for (let i = 0; i < 4; i++) await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, done_at) values ($1, $2, $3, 'call', $4, ${at()}, ${i === 0 ? at(10) : 'null'})`,
    [tenant, centr, uid['m.volkova'], `Тестовая задача недели ${i}`]);
  // Пропущенные звонки без перезвона
  for (let i = 0; i < 2; i++) await sql(`insert into calls(tenant_id, club_id, direction, phone, started_at, duration_sec, source) values ($1, $2, 'in', $3, ${at(12)}, 0, 'demo')`, [tenant, centr, `+7900555000${i}`]);
  // Вопросы тренеру в личном чате без ответа
  const key = [uid['m.volkova'], uid['a.kim']].sort().join(':');
  const chat = (await sql(`insert into team_chats(tenant_id, kind, direct_key, created_by) values ($1, 'direct', $2, $3) on conflict (tenant_id, direct_key) where direct_key is not null do update set kind = 'direct' returning id`, [tenant, key, uid['m.volkova']]))[0].id;
  for (const u of [uid['m.volkova'], uid['a.kim']]) await sql(`insert into team_members(chat_id, user_id, tenant_id) values ($1, $2, $3) on conflict do nothing`, [chat, u, tenant]);
  for (const [h, body] of [[11, 'Артём, когда у Ии Первой вводная?'], [14, 'Ты видел мой вопрос?']] as const)
    await sql(`insert into team_messages(tenant_id, chat_id, user_id, body, created_at) values ($1, $2, $3, $4, ${at(h)})`, [tenant, chat, uid['m.volkova'], body]);
  // Занятие тренера: 2 пришли, 4 не пришли
  const type = (await sql(`select id from class_types where club_id = $1 and kind = 'group' limit 1`, [centr]))[0]?.id
    ?? (await sql(`insert into class_types(tenant_id, club_id, name, kind) values ($1, $2, 'Функциональный тренинг', 'group') returning id`, [tenant, centr]))[0].id;
  const sess = (await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity) values ($1, $2, $3, $4, ${at(18)}, ${at(19)}, 10) returning id`,
    [tenant, centr, type, uid['a.kim']]))[0].id;
  const people = await sql(`select id from persons where tenant_id = $1 and merged_into_id is null limit 6`, [tenant]);
  for (const [i, p] of people.entries()) await sql(`insert into class_bookings(tenant_id, club_id, session_id, person_id, status) values ($1, $2, $3, $4, $5)`,
    [tenant, centr, sess, p.id, i < 2 ? 'attended' : 'no_show']);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('узкие места: вес потерь и порядок, подписи недели, команда в чате', () => {
  const z = { salesKop: 0, leads: { total: 0, noAnswer: 0, late: 0, reassigned: 0, median: null }, leadsBy: [], tasks: { total: 0, late: 0, escalations: 0 }, tasksBy: [],
    waits: { over: 0, over3: 0 }, questions: { total: 0, slow: 0 }, slowBy: [], calls: { missed: 0, noCallback: 0 }, deals: { stuck: 0, slowStage: null },
    classes: { sessions: 0, cap: 0, booked: 0, came: 0, noShow: 0, cancelled: 0 }, classesBy: [], processes: { started: 0, done: 0, late: 0, slowStep: null },
    meetings: { invited: 0, confirmed: 0, declined: 0 } } as WeekMetrics;
  assert.deepEqual(findBottlenecks(z, null), []);
  const m = { ...z, leads: { total: 10, noAnswer: 2, late: 3, reassigned: 1, median: 25 }, calls: { missed: 5, noCallback: 1 }, deals: { stuck: 4, slowStage: { name: 'Встреча', days: 6.5 } } };
  const b = findBottlenecks(m, { ...z, leads: { ...z.leads, median: 9 } });
  assert.deepEqual(b.map((x) => x.key), ['leads', 'calls', 'deals']);
  assert.match(b[0].fact, /через 25 мин \(неделей раньше 9 мин\)/);
  assert.match(b[2].fact, /на этапе «Встреча» — в среднем 6.5 дн/);
  assert.equal(weekLabel('2026-11-09'), '9–15 ноября');
  assert.equal(weekLabel('2026-11-30'), '30 ноября – 6 декабря');
  for (const s of ['разбор недели', 'Итоги прошлой недели', 'узкие места за неделю', 'недельный отчёт']) assert.ok(WEEKLY_RE.test(s), s);
  assert.ok(!WEEKLY_RE.test('что горит'));
});

test('разбор прошлой недели: цифры, главные узкие места, подсказки; права', async () => {
  assert.equal((await req('POST', '/api/agent/weekly/run', 'm.volkova', { clubId: centr })).statusCode, 403);
  const r = await req('POST', '/api/agent/weekly/run', 'o.smirnov', { clubId: centr });
  assert.equal(r.statusCode, 200, r.body);
  const { body, weekStart, id } = r.json();
  assert.equal(weekStart, ws);
  assert.match(body, /^\*\*Разбор недели · .*Центр.*\*\*/);
  assert.match(body, /\*\*Главные узкие места\*\*\n1\. \*\*Заявки ждут ответа\*\*: заявок 4, ответ в среднем через 40 мин, позже нормы — 4, без ответа — 3/);
  assert.match(body, /\*\*Задачи выполняются с опозданием\*\*|задачи выполняются с опозданием/);
  assert.match(body, /Пропущенные звонки без перезвона\*\*: пропущено 2, не перезвонили в течение 2 часов — 2/);
  assert.match(body, /• Вопросы коллегам без ответа 2 часа и дольше: 2 из 2/);
  assert.match(body, /• Занятия: \d+; .*неявки \d+ %/);
  assert.match(body, /\*\*Подсказки по ролям\*\*\n• Менеджеры: заявки ждут ответа — /);
  assert.match(body, /• РОП: заявки ждут ответа — назначьте дежурного/);
  assert.match(body, /• Тренеры: клиенты не приходят на занятия — накануне напишите новичкам/);
  assert.ok(body.length <= 12000);
  // Повторная сборка той же недели — та же запись
  const again = (await req('POST', '/api/agent/weekly/run', 'o.smirnov', { clubId: centr, weekStart: ws })).json();
  assert.equal(again.id, id);
  const list = (await req('GET', `/api/agent/weekly?clubId=${centr}`, 'o.smirnov')).json().items;
  assert.equal(list[0].id, id);
  assert.equal(list[0].top[0], 'Заявки ждут ответа');
  const one = (await req('GET', `/api/agent/weekly/${id}`, 'a.bespalyy')).json();
  assert.equal(one.body, again.body);
  assert.equal((await req('GET', `/api/agent/weekly/${id}`, 'd.lis')).statusCode, 403);
});

test('рассылка: руководителям карточка и короткий разбор, сотрудникам — их цифры и подсказка', async () => {
  const sys = { tenantId: tenant, allClubs: true, clubIds: [] };
  const res = await withCtx(t.pool, sys, async (db) => {
    const r = await buildReview(db, centr, ws, null);
    const saved = await saveReview(db, { tenantId: tenant, userId: null }, r);
    return deliverReview(db, { tenantId: tenant, userId: null }, r, saved.id);
  });
  assert.ok(res.heads >= 2);
  assert.ok(res.personal >= 2);
  const n = (await req('GET', '/api/notifications', 'o.smirnov')).json().items;
  assert.ok(n.some((x: { title: string; body: string }) => /^Разбор недели · .*Центр/.test(x.title) && /Главное узкое место: заявки ждут ответа/.test(x.body)));
  const head = (await botMessages('a.bespalyy')).at(-1)!;
  assert.match(head, /Разбор недели/);
  assert.match(head, /Полный разбор с цифрами и подсказками по ролям — раздел «Разбор недели»/);
  const mv = (await botMessages('m.volkova')).at(-1)!;
  assert.match(mv, /\*\*Ваша неделя, /);
  assert.match(mv, /• Заявок: 4, ответ в среднем через 40 мин/);
  assert.match(mv, /• Задач со сроком на неделе: 4, с опозданием: 3/);
  assert.match(mv, /\*\*Подсказка:\*\* заявки ждут ответа/);
  const ak = (await botMessages('a.kim')).at(-1)!;
  assert.match(ak, /• Занятий: 1, заполняемость 60 %, неявки 67 %/);
  assert.match(ak, /• Вопросы коллег, оставшиеся без ответа 2 часа и дольше: 2/);
  assert.match(ak, /\*\*Подсказка:\*\* клиенты не приходят на занятия/);
  assert.ok((await sql(`select delivered_at from agent_weekly_reviews where club_id = $1 and week_start = $2`, [centr, ws]))[0].delivered_at);
});

test('чат: «разбор недели» — короткий разбор по клубам', async () => {
  const a = await ask('Разбор недели по Центру');
  assert.match(a, /\*\*Разбор недели · .*Центр/);
  assert.match(a, /1\. \*\*Заявки ждут ответа\*\*/);
  assert.match(a, /раздел «Разбор недели»/);
  assert.equal((await ask('разбор недели', 'm.volkova')).includes('Разбор недели ·'), false);
});
