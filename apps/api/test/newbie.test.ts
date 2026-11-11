// Программа первых 30 дней новичка: запись в программу после первой покупки, задачи по шагам, проверка визитов, настройки шагов.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { validateSteps } from '../src/modules/newbie.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';
let products: { id: string; name: string }[] = [];
let n = 0;
/** Новичок, купивший абонемент daysAgo дней назад, с visits визитами в разные дни */
async function newbie(daysAgo: number, visits: number, product = 'Месяц безлимит') {
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Новичок Тестов ${++n}`, phone: `+7900888${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
  const s = await req('POST', '/api/memberships', 'm.volkova', { personId, productId: products.find((p) => p.name === product)!.id });
  assert.equal(s.statusCode, 201, s.body);
  await sql(`update memberships set starts_on = starts_on - $2::int, ends_on = ends_on - $2::int, created_at = created_at - make_interval(days => $2::int) where id = $1`, [s.json().id, daysAgo]);
  for (let i = 0; i < visits; i++) await sql(`insert into visits(tenant_id, club_id, person_id, visited_at) values ($1,$2,$3, now() - make_interval(days => $4::int))`, [tenant, centr, personId, i + 1]);
  return personId;
}
const run = () => req('POST', '/api/newbie/run', 'o.smirnov', { clubId: centr });
const list = async () => (await req('GET', `/api/newbie?clubId=${centr}`, 'o.smirnov')).json();
const prog = async (personId: string) => (await list()).list.find((x: { personId: string }) => x.personId === personId);
const step = (p: { steps: { key: string }[] }, key: string) => p.steps.find((s) => s.key === key) as unknown as { status: string; taskId: string | null; visits: number | null };

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  products = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('первая покупка запускает программу: задачи по наступившим шагам, мало визитов — задача', async () => {
  const lazy = await newbie(15, 1);
  const active = await newbie(15, 4);
  const fresh = await newbie(0, 0);
  const week = await newbie(8, 2);
  const r = await run();
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().tasks >= 2);

  const a = await prog(lazy);
  assert.equal(a.day, 16);
  // Попал в программу с опозданием: давно прошедшие шаги пропущены, а не поставлены задним числом
  assert.equal(step(a, 'intro').status, 'skipped');
  assert.equal(step(a, 'call7').status, 'skipped');
  assert.equal(step(a, 'visits14').status, 'task');
  assert.equal(step(a, 'visits14').visits, 1);
  assert.equal(step(a, 'call30').status, 'pending');
  assert.equal(a.risk, true);
  const task = (await sql('select title, person_id from tasks where id = $1', [step(a, 'visits14').taskId]))[0];
  assert.match(task.title, /1 визит с .* вместо 3/);

  const b = await prog(active);
  assert.equal(step(b, 'visits14').status, 'ok');
  assert.equal(b.risk, false);
  const w = await prog(week);
  assert.equal(step(w, 'intro').status, 'skipped');
  assert.equal(step(w, 'call7').status, 'task');
  const c = await prog(fresh);
  assert.ok(c.steps.every((s: { status: string }) => s.status === 'pending'));

  // Повторный запуск не плодит задачи
  const before = (await sql('select count(*)::int as n from tasks where person_id = $1', [lazy]))[0].n;
  await run();
  assert.equal((await sql('select count(*)::int as n from tasks where person_id = $1', [lazy]))[0].n, before);

  // Выполненная задача закрывает шаг
  const done = await req('POST', `/api/tasks/${step(w, 'call7').taskId}/complete`, 'o.smirnov', { result: 'Всё нравится, ходит' });
  assert.equal(done.statusCode, 200, done.body);
  await run();
  assert.equal(step(await prog(week), 'call7').status, 'done');
});

test('гостевой визит программу не запускает', async () => {
  const guest = await newbie(3, 0, 'Гостевой визит');
  await run();
  assert.equal(await prog(guest), undefined);
});

test('настройки шагов: проверка и сохранение, право только у управляющего', async () => {
  assert.throws(() => validateSteps([]), /от 1 до 10/);
  assert.throws(() => validateSteps([{ title: 'x', day: 5, kind: 'visits', assignTo: 'trainer' }]), /визитов/);
  const steps = [{ key: 'call3', title: 'Позвонить на третий день', day: 3, kind: 'call', assignTo: 'manager' }, { key: 'v10', title: 'Проверить визиты', day: 10, kind: 'visits', minVisits: 2, assignTo: 'trainer' }];
  assert.equal((await req('PUT', '/api/newbie/settings', 'm.volkova', { clubId: centr, steps })).statusCode, 403);
  const r = await req('PUT', '/api/newbie/settings', 'o.smirnov', { clubId: centr, steps });
  assert.equal(r.statusCode, 200, r.body);
  const s = (await list()).settings;
  assert.equal(s.steps.length, 2);
  assert.equal(s.custom, true);
  // Новые шаги применяются к новым новичкам
  const p = await newbie(5, 1);
  await run();
  const pr = await prog(p);
  assert.deepEqual(pr.steps.map((x: { key: string; status: string }) => `${x.key}:${x.status}`), ['call3:task', 'v10:pending']);
  assert.equal((await req('PUT', '/api/newbie/settings', 'o.smirnov', { clubId: centr, enabled: false })).json().enabled, false);
});
