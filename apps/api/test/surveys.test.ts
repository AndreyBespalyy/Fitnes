// Опросы после визита: отправка, разбор ответа, задача управляющему при низкой оценке, просьба об отзыве при высокой, индекс на рабочем столе.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { collectAnswers, parseScore, sendSurveys, npsOf } from '../src/modules/surveys.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
let centr = ''; let tenant = ''; let today = '';
let n = 0;
async function visitor(hoursAgo: number) {
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Опрос Клиент ${++n}`, phone: `+7900777${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
  await sql(`insert into visits(tenant_id, club_id, person_id, visited_at) values ($1,$2,$3, now() - make_interval(hours => $4::int))`, [tenant, centr, personId, hoursAgo]);
  return personId;
}
const answer = (personId: string, body: string) => sql(`insert into msg_messages(tenant_id, club_id, conversation_id, direction, body, status)
  select s.tenant_id, s.club_id, s.conversation_id, 'in', $2, 'received' from surveys s where s.person_id = $1`, [personId, body]);
const run = () => asOwner(async (c) => { const a = { tenantId: tenant, userId: null }; await collectAnswers(c as never, null, a, centr); });

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.astafeva', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  const r = (await sql(`select tenant_id, to_char(now() at time zone timezone, 'YYYY-MM-DD') as d from clubs where id = $1`, [centr]))[0];
  tenant = r.tenant_id; today = r.d;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор ответа: цифра в начале — оценка, остальное — комментарий', () => {
  assert.deepEqual(parseScore('10'), { score: 10, comment: null });
  assert.deepEqual(parseScore(' 3, душно в зале'), { score: 3, comment: 'душно в зале' });
  assert.deepEqual(parseScore('9 из 10! Отличные тренеры'), { score: 9, comment: 'Отличные тренеры' });
  assert.equal(parseScore('Спасибо, всё хорошо'), null);
  assert.equal(parseScore('100'), null);
  assert.deepEqual(npsOf([10, 9, 8, 3]), { index: 25, n: 4, promoters: 2, passives: 1, detractors: 1 });
});

test('после первого визита уходит опрос; низкая оценка — задача управляющему, высокая — просьба об отзыве', async () => {
  const low = await visitor(5);
  const high = await visitor(10);
  const fresh = await visitor(1); // меньше двух часов — рано
  // Без ссылок на карты — просто «спасибо»; ссылку задаёт управляющий
  assert.equal((await req('PUT', '/api/surveys/settings', 'o.astafeva', { clubId: centr, yandexUrl: 'yandex.ru/maps/org/1' })).statusCode, 400);
  const st = await req('PUT', '/api/surveys/settings', 'o.astafeva', { clubId: centr, yandexUrl: 'https://yandex.ru/maps/org/1', gisUrl: '' });
  assert.equal(st.statusCode, 200, st.body);
  const sent = await asOwner((c) => sendSurveys(c as never, null, { tenantId: tenant, userId: null }, centr, today));
  assert.ok(sent >= 2, String(sent));
  assert.equal((await sql('select count(*)::int as k from surveys where person_id = $1', [fresh]))[0].k, 0);
  const q = (await sql(`select m.body from surveys s join msg_messages m on m.id = s.message_id where s.person_id = $1`, [low]))[0].body;
  assert.match(q, /от 0 до 10/);
  // Повторно не отправляется
  assert.equal(await asOwner((c) => sendSurveys(c as never, null, { tenantId: tenant, userId: null }, centr, today)), 0);

  await answer(low, '4 долго ждал администратора');
  await answer(high, '10');
  await run();
  const sl = (await sql(`select s.score, s.comment, s.status, t.title, t.assignee_id from surveys s join tasks t on t.id = s.task_id where s.person_id = $1`, [low]))[0];
  assert.equal(sl.score, 4);
  assert.equal(sl.comment, 'долго ждал администратора');
  assert.match(sl.title, /Низкая оценка клуба: 4 из 10/);
  const gm = (await sql(`select u.id from users u where u.login = 'o.smirnov'`))[0].id;
  assert.equal(sl.assignee_id, gm);
  const sh = (await sql(`select s.review_asked_at, s.task_id from surveys s where s.person_id = $1`, [high]))[0];
  assert.ok(sh.review_asked_at);
  assert.equal(sh.task_id, null);
  const reply = (await sql(`select m.body from msg_messages m join surveys s on s.conversation_id = m.conversation_id where s.person_id = $1 and m.direction = 'out' order by m.created_at desc limit 1`, [high]))[0].body;
  assert.match(reply, /yandex\.ru\/maps/);

  // Отчёт и виджет на рабочем столе
  const r = (await req('GET', `/api/surveys?clubId=${centr}&from=${today}&to=${today}`, 'o.astafeva')).json();
  assert.equal(r.report.n, 2);
  assert.equal(r.report.index, 0); // один довольный, один недовольный
  assert.equal(r.report.lows.length, 1);
  assert.equal((await req('GET', `/api/surveys?clubId=${centr}&from=${today}&to=${today}`, 'm.volkova')).statusCode, 403);
  const w = (await req('GET', `/api/dash/widget/nps?clubId=${centr}&from=${today}&to=${today}`, 'o.astafeva'));
  assert.equal(w.statusCode, 200, w.body);
  assert.equal(w.json().total.n, 2);
});
