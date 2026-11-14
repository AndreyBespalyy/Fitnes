// ИИ-агент, этап 4: помощник собственника — вопросы словами, уточнения, прогноз с вероятностью, вмешательство.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { normCdf, parsePeriod, parseTopics, planChance } from '../src/modules/agentOwner.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const chats: Record<string, string> = {};

async function ask(text: string, who = 'a.bespalyy') {
  const chat = chats[who] ??= (await req('POST', '/api/agent/chat', who)).json().id;
  const before = (await sql(`select count(*)::int as n from team_messages where chat_id = $1`, [chat]))[0].n;
  const r = await req('POST', `/api/team/chats/${chat}/messages`, who, { body: text });
  assert.equal(r.statusCode, 200, r.body);
  for (let i = 0; i < 200; i++) {
    const rows = await sql(`select m.body, u.is_bot from team_messages m join users u on u.id = m.user_id where m.chat_id = $1 order by m.created_at`, [chat]);
    if (rows.length >= before + 2 && rows.at(-1).is_bot) return rows.at(-1).body as string;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Помощник не ответил');
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор: темы, период, вероятность', () => {
  assert.deepEqual(parseTopics('как продажи и посещаемость?'), ['sales', 'attendance']);
  assert.deepEqual(parseTopics('выполним план к концу месяца?'), ['sales', 'forecast']);
  assert.deepEqual(parseTopics('как дела в целом'), ['sales', 'attendance', 'problems']);
  assert.deepEqual(parseTopics('где узкие места, что посоветуешь'), ['problems', 'advice']);
  assert.equal(parsePeriod('за неделю', '2026-11-14').from, '2026-11-08');
  assert.equal(parsePeriod('вчера', '2026-11-14').from, '2026-11-13');
  assert.deepEqual([parsePeriod('в октябре', '2026-11-14').from, parsePeriod('в октябре', '2026-11-14').to], ['2026-10-01', '2026-10-31']);
  assert.equal(parsePeriod('прошлый месяц', '2026-01-10').month, '2025-12');
  assert.equal(parsePeriod('как продажи', '2026-11-14').month, '2026-11');
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6 && Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  // Ровный темп 10 000 в день, 14 дней из 30: к концу ≈ 300 000; план 250 000 — почти наверняка, план 400 000 — почти нет
  const daily = Array.from({ length: 14 }, (_, i) => 1_000_000 + (i % 2 ? 100_000 : -100_000));
  const fact = daily.reduce((a, x) => a + x, 0);
  const hi = planChance(daily, fact, 25_000_000, 16)!; const lo = planChance(daily, fact, 40_000_000, 16)!;
  assert.ok(Math.abs(hi.expected - 30_000_000) < 1); assert.ok(hi.p > 0.9); assert.ok(lo.p < 0.1);
  assert.equal(planChance(daily, fact, 10_000_000, 16)!.p, 0.99);
});

test('собственник: продажи и прогноз с вероятностью, посещаемость, тренеры, отдел продаж', async () => {
  const s = await ask('Как продажи в этом месяце и выполним ли план?');
  assert.match(s, /^\*\*Продажи\*\* · вся сеть, ноябрь/); assert.doesNotMatch(s, /Понял вопрос/);
  assert.match(s, /\*\*Продажи\*\*/);
  assert.match(s, /\*\*Прогноз\*\*/);
  assert.match(s, /Шанс выполнить план .*\*\*(≈ \d+|меньше 5|больше 95) %|план на месяц не задан/);
  const a = await ask('посещаемость за неделю в Центре');
  assert.match(a, /^\*\*Посещаемость\*\* · Клуб «Центр», последние 7 дней/);
  assert.match(a, /Посещений: \*\*\d+\*\*/);
  const tr = await ask('как работают тренеры за месяц');
  assert.match(tr, /\*\*Тренеры\*\*/);
  const st = await ask('покажи отдел продаж');
  assert.match(st, /\*\*Отдел продаж\*\*/);
  assert.match(st, /Мария Волкова/);
});

test('сотрудник и клиент по имени, уточнение при неясности', async () => {
  const m = await ask('как работает Волкова?');
  assert.match(m, /Сотрудник: Мария Волкова/);
  assert.match(m, /Задачи: выполнено/);
  // Клиент по имени
  const p = (await sql(`select full_name from persons p where exists (select 1 from memberships m where m.person_id = p.id) order by full_name limit 1`))[0].full_name as string;
  const c = await ask(`что с клиентом ${p}`);
  assert.match(c, new RegExp(`Клиент: ${p}`));
  // Непонятный вопрос — помощник переспрашивает, ответ номером продолжает разговор
  const q = await ask('ну и как оно?');
  assert.match(q, /О чём рассказать\?/);
  const ans = await ask('3');
  assert.match(ans, /^\*\*Посещаемость\*\*/);
  // Два человека с одним именем — уточнение
  await sql(`insert into users(tenant_id, login, password_hash, full_name, must_change_password) select tenant_id, 'm.volkova2', password_hash, 'Мария Петрова', false from users where login = 'm.volkova'`);
  await sql(`insert into user_assignments(tenant_id, user_id, role_code, club_id) select u.tenant_id, u.id, 'manager', c.id from users u, clubs c where u.login = 'm.volkova2' and c.name like '%Центр%'`);
  const w = await ask('как работает Мария?');
  assert.match(w, /уточните, о ком/);
  const pick = await ask('2');
  assert.match(pick, /Сотрудник: Мария (Волкова|Петрова)/);
});

test('вмешательство: напомни и передай задачи; менеджеру это недоступно', async () => {
  await sql(`update tasks set done_at = now(), result = 'тест'`);
  const centr = (await sql(`select id, tenant_id from clubs where name like '%Центр%'`))[0];
  const mv = (await sql(`select id from users where login = 'm.volkova'`))[0].id;
  for (const n of [1, 2]) await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'other',$4, now() - interval '2 hours')`, [centr.tenant_id, centr.id, mv, `Старая задача ${n}`]);
  const r = await ask('напомни Марии Волковой');
  assert.match(r, /отправил сотруднику \*\*Мария Волкова\*\*.*просрочено задач: 2/);
  const notes = (await req('GET', '/api/notifications', 'm.volkova')).json().items;
  assert.ok(notes.some((x: { title: string }) => /Андрей Беспалый просит разобрать задачи/.test(x.title)));
  const g = await ask('передай задачи Волковой Петровой');
  assert.match(g, /2 просроченных задач сотрудника \*\*Мария Волкова\*\*.*\*\*Мария Петрова\*\*/);
  assert.equal((await sql(`select count(*)::int as n from tasks t join users u on u.id = t.assignee_id where u.login = 'm.volkova2' and t.done_at is null`))[0].n, 2);
  // Менеджеру — обычный помощник: «напомни …» ставит задачу себе, сводка недоступна
  assert.match(await ask('как продажи в сети?', 'm.volkova'), /Пока я понимаю/);
});

test('управляющий видит только свой клуб; «что горит» с советами', async () => {
  const d = await ask('что горит, что посоветуешь?', 'o.smirnov');
  assert.match(d, /Клуб «Центр»/);
  assert.doesNotMatch(d, /Север/);
  assert.match(d, /\*\*Что горит сейчас\*\*/);
  const h = await ask('помощь', 'o.smirnov');
  assert.match(h, /Как руководителю мне можно задавать/);
});

test('разбор: отдел продаж и тренеры не путаются с продажами и сотрудниками', () => {
  assert.deepEqual(parseTopics('покажи отдел продаж'), ['staff']);
  assert.deepEqual(parseTopics('как работают тренеры'), ['trainers']);
  assert.deepEqual(parseTopics('как работают менеджеры и тренеры'), ['trainers', 'staff']);
});
