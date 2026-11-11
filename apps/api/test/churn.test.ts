// Прогноз ухода и сценарии удержания: причины риска, подсказка, звонок ответственному, итог через визит, настройки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processScoring } from '../src/modules/aiSales.ts';
import { churnScript } from '../src/modules/scoring.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';
let risky = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  // Клиент, который ходил 2 раза в неделю, месяц не был и поставил клубу 3 из 10
  risky = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Уходящий Клиент', phone: '+79009990001', sourceCode: 'walk_in' })).json().personId;
  const p = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json().find((x: { name: string }) => x.name === 'Годовой безлимит');
  const s = await req('POST', '/api/memberships', 'm.volkova', { personId: risky, productId: p.id });
  await sql(`update memberships set starts_on = starts_on - 90, ends_on = ends_on - 90, created_at = created_at - interval '90 days' where id = $1`, [s.json().id]);
  for (let d = 32; d < 60; d += 3) await sql(`insert into visits(tenant_id, club_id, person_id, visited_at) values ($1,$2,$3, now() - make_interval(days => $4::int))`, [tenant, centr, risky, d]);
  await sql(`insert into surveys(tenant_id, club_id, person_id, kind, period_key, status, score, answered_at) values ($1,$2,$3,'quarterly','t','answered', 3, now() - interval '5 days')`, [tenant, centr, risky]);
  await processScoring(t.pool);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('подсказка начинается с главной причины', () => {
  assert.match(churnScript({ complaint: 1, idle: 30 }, true), /^Начните с его оценки.*Спросите, что мешает ходить.*заморозку/);
  assert.match(churnScript({ debt: 1 }, false), /оплатить по ссылке/);
  assert.match(churnScript({}, false), /Позвоните/);
});

test('риск ухода: причины и подсказка, звонок ответственному, повторно не беспокоим, итог по визиту', async () => {
  const sc = (await sql(`select segment, reasons, offer from client_scores where person_id = $1 and kind = 'churn'`, [risky]))[0];
  assert.equal(sc.segment, 'hot');
  const texts = sc.reasons.map((r: { text: string }) => r.text).join('; ');
  assert.match(texts, /низкую оценку клубу: 3 из 10/);
  assert.match(sc.offer.text, /^Начните с его оценки/);

  assert.equal((await req('POST', '/api/churn/run', 'm.volkova', { clubId: centr })).statusCode, 403);
  const r = await req('POST', '/api/churn/run', 'o.smirnov', { clubId: centr });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().calls >= 1);
  const task = (await sql(`select t.title, t.assignee_id from churn_actions a join tasks t on t.id = a.task_id where a.person_id = $1`, [risky]))[0];
  assert.match(task.title, /^Риск ухода: .*Что сказать: Начните с его оценки/);
  assert.ok(task.assignee_id);

  // Второй запуск в пределах 30 дней клиента не трогает
  await req('POST', '/api/churn/run', 'o.smirnov', { clubId: centr });
  assert.equal((await sql(`select count(*)::int as n from churn_actions where person_id = $1`, [risky]))[0].n, 1);

  // Клиент пришёл — сценарий сработал
  await sql(`insert into visits(tenant_id, club_id, person_id, visited_at) values ($1,$2,$3, now())`, [tenant, centr, risky]);
  await req('POST', '/api/churn/run', 'o.smirnov', { clubId: centr });
  const g = (await req('GET', `/api/churn?clubId=${centr}`, 'm.volkova')).json();
  const row = g.list.find((x: { personId: string }) => x.personId === risky);
  assert.equal(row.outcome, 'returned');
  assert.ok(g.stats.returned >= 1);
  assert.equal(g.canManage, false);
});

test('настройки сценария', async () => {
  assert.equal((await req('PUT', '/api/churn/settings', 'o.smirnov', { clubId: centr, cooldownDays: 3 })).statusCode, 400);
  const r = await req('PUT', '/api/churn/settings', 'o.smirnov', { clubId: centr, message: false, cooldownDays: 45, template: '{имя}, ждём вас!' });
  assert.equal(r.statusCode, 200, r.body);
  const s = (await req('GET', `/api/churn?clubId=${centr}`, 'o.smirnov')).json().settings;
  assert.deepEqual([s.message, s.cooldownDays, s.template], [false, 45, '{имя}, ждём вас!']);
  await req('PUT', '/api/churn/settings', 'o.smirnov', { clubId: centr, enabled: false });
  assert.deepEqual((await req('POST', '/api/churn/run', 'o.smirnov', { clubId: centr })).json(), { calls: 0, messages: 0 });
});
