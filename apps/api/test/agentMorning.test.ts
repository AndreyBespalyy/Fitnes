// ИИ-агент, вариант 4А: утренние «3 подсказки на сегодня» — по ролям, рассылка раз в день, отпуск, команда в чате, настройка.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { HINTS_RE, morningHints, processMorningHints } from '../src/modules/agentMorning.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = ''; let tz = ''; let classToday = false;
const uid: Record<string, string> = {};
const sys = () => ({ tenantId: tenant, allClubs: true, clubIds: [] });
const hintsOf = (login: string, role: string) => withCtx(t.pool, sys(), (db) => morningHints(db, { id: uid[login], name: login, role }, [centr]));

async function ask(text: string, who: string) {
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
  const c = (await sql(`select id, tenant_id, timezone from clubs where name like '%Центр%'`))[0]; centr = c.id; tenant = c.tenant_id; tz = c.timezone;
  for (const r of await sql(`select id, login from users where login in ('a.bespalyy','o.smirnov','m.volkova','a.kim','d.lis')`)) uid[r.login] = r.id;
  await sql(`update tasks set done_at = now(), result = 'тест'`);
  await sql(`update leads set first_response_at = now() where first_response_at is null`);
  await sql(`update msg_conversations set last_inbound_at = now() - interval '5 days'`);

  // Менеджер: заявка без ответа, просроченная задача, горячий клиент
  const l = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Глеб Утренний', phone: '+79007770011', sourceCode: 'walk_in' });
  assert.ok(l.statusCode < 300, l.body);
  await sql(`update leads set assigned_to = $2, first_response_at = null where person_id = $1`, [l.json().personId, uid['m.volkova']]);
  await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1, $2, $3, 'call', 'Перезвонить Глебу по цене', now() - interval '3 hours')`, [tenant, centr, uid['m.volkova']]);
  const hot = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Злата Горячева', phone: '+79007770012', sourceCode: 'walk_in' })).json().personId;
  await sql(`update leads set first_response_at = now() where person_id = $1`, [hot]);
  await sql(`insert into client_scores(tenant_id, club_id, person_id, kind, score, segment, owner_id, model) values ($1, $2, $3, 'purchase', 0.82, 'hot', $4, 'test')
    on conflict (club_id, person_id, kind) do update set score = 0.82, segment = 'hot', owner_id = $4`, [tenant, centr, hot, uid['m.volkova']]);

  // Администратор: пропущенный звонок без перезвона, абонемент заканчивается послезавтра, занятие сегодня с пробным новичком
  await sql(`insert into calls(tenant_id, club_id, direction, phone, started_at, duration_sec, source) values ($1, $2, 'in', '+79007770099', now() - interval '2 hours', 0, 'demo')`, [tenant, centr]);
  const type = (await sql(`select id from class_types where club_id = $1 and kind = 'group' limit 1`, [centr]))[0]?.id
    ?? (await sql(`insert into class_types(tenant_id, club_id, name, kind) values ($1, $2, 'Пилатес', 'group') returning id`, [tenant, centr]))[0].id;
  classToday = (await sql(`select ((now() + interval '40 minutes') at time zone $1)::date = (now() at time zone $1)::date as ok`, [tz]))[0].ok;
  if (classToday) {
    const s = (await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity) values ($1, $2, $3, $4, now() + interval '30 minutes', now() + interval '40 minutes', 10) returning id`,
      [tenant, centr, type, uid['a.kim']]))[0].id;
    await sql(`insert into class_bookings(tenant_id, club_id, session_id, person_id, status, trial) values ($1, $2, $3, $4, 'booked', true)`, [tenant, centr, s, l.json().personId]);
  }
  // Тренер: вчера не пришла клиентка
  const y = (await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity, status)
    values ($1, $2, $3, $4, (((now() at time zone $5)::date - 1)::timestamp + interval '18 hours') at time zone $5, (((now() at time zone $5)::date - 1)::timestamp + interval '19 hours') at time zone $5, 10, 'done') returning id`,
    [tenant, centr, type, uid['a.kim'], tz]))[0].id;
  await sql(`insert into class_bookings(tenant_id, club_id, session_id, person_id, status) values ($1, $2, $3, $4, 'no_show')`, [tenant, centr, y, hot]);
  // Управляющий: процесс вышел за срок
  const p = await req('POST', '/api/processes', 'o.smirnov', { clubId: centr, title: 'Замена зеркал', steps: [{ title: 'Заказать зеркала', role: 'gm', hours: 2 }] });
  assert.equal(p.statusCode, 200, p.body);
  await sql(`update processes set due_at = now() - interval '1 hour' where id = $1`, [p.json().id]);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('подсказки по ролям: самое важное первым, всегда ровно три', async () => {
  const m = await hintsOf('m.volkova', 'manager');
  assert.equal(m.length, 3);
  assert.match(m[0], /^\*\*Ответьте на заявки: 1\*\*/);
  assert.match(m[1], /^\*\*Закройте просроченные задачи: 1\.\*\* Самая старая — «Перезвонить Глебу по цене» \(просрочена на 3 ч\)/);
  assert.match(m[2], /^\*\*Позвоните первыми: Злата Горячева \(82 %\)\*\*/);
  const d = await hintsOf('d.lis', 'desk');
  assert.equal(d.length, 3);
  assert.match(d[0], /^\*\*Перезвоните на пропущенные: 1\*\*/);
  if (classToday) assert.ok(d.some((x) => /Новички на пробном: Глеб Утренний/.test(x)), d.join('\n'));
  const k = await hintsOf('a.kim', 'trainer');
  assert.ok(k.some((x) => /^\*\*Напишите не пришедшим вчера: Злата Горячева\*\*/.test(x)), k.join('\n'));
  if (classToday) assert.match(k[0], /^\*\*Сегодня у вас 1 занятие, первое в \d\d:\d\d, записано 1\.\*\* Новички: Глеб Утренний/);
  const g = await hintsOf('o.smirnov', 'gm');
  assert.ok(g.some((x) => /^\*\*Бизнес-процессы вышли за срок: 1\*\*/.test(x)), g.join('\n'));
  // Нет данных — общие советы роли, всё равно три
  const empty = await withCtx(t.pool, sys(), (db) => morningHints(db, { id: uid['a.bespalyy'], name: 'x', role: 'fin' }, [centr]));
  assert.equal(empty.length, 3);
  for (const s of ['подсказки на сегодня', 'Подсказки', 'с чего начать?', 'что мне делать сегодня', 'чем заняться']) assert.ok(HINTS_RE.test(s), s);
  for (const s of ['подскажи, выполним план?', 'мои задачи']) assert.ok(!HINTS_RE.test(s), s);
});

test('утренняя рассылка: раз в день каждому, кроме тех, кто в отпуске; собственнику — один раз', async () => {
  await sql(`insert into staff_absences(tenant_id, club_id, user_id, kind, date_from, date_to) values ($1, $2, $3, 'vacation', (now() at time zone $4)::date, (now() at time zone $4)::date)`,
    [tenant, centr, uid['a.kim'], tz]);
  const n = await withCtx(t.pool, sys(), (db) => processMorningHints(db, { tenantId: tenant, userId: null }, centr));
  assert.ok(n >= 4, String(n));
  assert.equal(await withCtx(t.pool, sys(), (db) => processMorningHints(db, { tenantId: tenant, userId: null }, centr)), 0);
  const north = (await sql(`select id from clubs where name like '%Север%'`))[0]?.id;
  if (north) await withCtx(t.pool, sys(), (db) => processMorningHints(db, { tenantId: tenant, userId: null }, north));
  const got = await sql(`select u.login, count(*)::int as n, max(m.body) as body from team_messages m join users u on u.id::text = m.meta->>'userId'
    where m.meta->>'kind' = 'morning_hints' group by u.login`);
  const by = Object.fromEntries(got.map((r) => [r.login, r]));
  assert.equal(by['a.bespalyy'].n, 1);
  assert.equal(by['a.kim'], undefined);
  assert.match(by['m.volkova'].body, /^\*\*Доброе утро, m\.volkova|^\*\*Доброе утро, Мария! 3 подсказки на сегодня:\*\*\n1\. \*\*Ответьте на заявки: 1\*\*/);
  assert.equal(by['m.volkova'].body.split('\n').filter((x: string) => /^\d\. /.test(x)).length, 3);
});

test('чат: «подсказки на сегодня»; настройка часа и выключение', async () => {
  const a = await ask('Подсказки на сегодня', 'm.volkova');
  assert.match(a, /^\*\*3 подсказки на сегодня:\*\*\n1\. \*\*Ответьте на заявки/);
  const o = await ask('с чего начать?', 'a.bespalyy');
  assert.match(o, /^\*\*3 подсказки на сегодня:\*\*/);
  const g = (await req('GET', `/api/agent/settings?clubId=${centr}`, 'o.smirnov')).json();
  assert.equal(g.morningHints, true);
  assert.equal(g.morningHour, 9);
  assert.equal((await req('PUT', '/api/agent/settings', 'o.smirnov', { clubId: centr, morningHour: 4 })).statusCode, 400);
  const p = await req('PUT', '/api/agent/settings', 'o.smirnov', { clubId: centr, morningHour: 8, morningHints: false });
  assert.equal(p.statusCode, 200, p.body);
  const g2 = (await req('GET', `/api/agent/settings?clubId=${centr}`, 'o.smirnov')).json();
  assert.equal(g2.morningHour, 8);
  assert.equal(g2.morningHints, false);
});
