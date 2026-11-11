// Правила «если — то»: через версии настроек (проверка на истории, утверждение), запуск цепочки, задача, пропуск сообщения, остановка при покупке.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { processRules, ruleText, validateRules, normRules } from '../src/modules/rules.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenantId = '';
const products: Record<string, string> = {};
const today = () => sql(`select to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM-DD') as d`).then((r) => r[0].d as string);
const run = async () => withCtx(t.pool, { tenantId, allClubs: true, clubIds: [] } as never, async (db) => processRules(db, null, { tenantId, userId: null }, centr, await today()));

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenantId = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  for (const p of (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json()) products[p.name] = p.id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

const RULE = { id: 'r_lost10', name: 'Пропал на 10 дней', enabled: true, conditions: [{ type: 'inactive_days', n: 10 }, { type: 'has_active' }],
  steps: [{ action: 'task', afterDays: 0, title: 'Позвонить {имя}: давно не был', dueHours: 24 }, { action: 'message', afterDays: 2, text: '{имя}, ждём вас в {клуб}!' }],
  stopOnVisit: true, stopOnPurchase: true, cooldownDays: 30, marketing: false };

test('проверка правил: понятные ошибки и текст правила', () => {
  const bad = normRules([{ name: '', conditions: [{ type: 'inactive_days', n: 0 }], steps: [{ action: 'message', afterDays: 3, text: 'hi' }, { action: 'task', afterDays: 1, title: 'x' }] }]);
  const e = validateRules(bad);
  assert.ok(e.some((x) => x.includes('укажите название')));
  assert.ok(e.some((x) => x.includes('число от 1 до 365')));
  assert.ok(e.some((x) => x.includes('текст сообщения')));
  assert.ok(e.some((x) => x.includes('задержка не меньше предыдущего')));
  assert.equal(validateRules(normRules([RULE])).length, 0);
  assert.equal(ruleText(normRules([RULE])[0]), 'Если не был в клубе 10 дней и больше и есть действующий абонемент, то задача «Позвонить {имя}: давно не был», затем через 2 дн. сообщение клиенту');
});

test('правило проходит черновик, проверку на истории, утверждение и работает', async () => {
  // Клиент с абонементом, последний визит 15 дней назад
  const lead = async (name: string, phone: string) => (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: name, phone, sourceCode: 'walk_in' })).json().personId as string;
  const a = await lead('Пропавший Клиент', '+79003330001');
  const b = await lead('Вернувшийся Клиент', '+79003330002');
  for (const p of [a, b]) {
    await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: products['Полгода безлимит'] });
    await sql(`insert into visits(tenant_id, club_id, person_id, visited_at, source) values ($1,$2,$3, now() - interval '15 days', 'manual')`, [tenantId, centr, p]);
  }
  // Невалидное правило не проходит проверку
  const badV = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, title: 'Плохое правило', changes: [{ path: 'rules.list', value: [{ ...RULE, steps: [] }] }] })).json();
  const badC = (await req('POST', `/api/config/versions/${badV.id}/check`, 'o.smirnov')).json();
  assert.equal(badC.ok, false);
  assert.ok(badC.items.find((i: { code: string }) => i.code === 'data').details.some((d: string) => d.includes('хотя бы один шаг')));

  const v = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, title: 'Правило: пропал', changes: [{ path: 'rules.list', value: [RULE] }] })).json();
  assert.equal(v.diff[0].path, 'rules.list');
  const c = (await req('POST', `/api/config/versions/${v.id}/check`, 'o.smirnov')).json();
  assert.equal(c.ok, true, JSON.stringify(c.items));
  const h = c.history.find((x: { path: string }) => x.path === 'rules.r_lost10');
  assert.match(h.summary, /Сразу после публикации подойдут \d+ клиентов/);
  assert.ok(h.sample.includes('Пропавший Клиент'));
  // До публикации правило не действует
  assert.equal((await run()).started, 0);
  assert.equal((await req('POST', `/api/config/versions/${v.id}/approve`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('POST', `/api/config/versions/${v.id}/publish`, 'o.smirnov')).statusCode, 200);

  const s1 = await run();
  assert.ok(s1.started >= 2);
  const runA = (await sql(`select * from rule_runs where person_id = $1`, [a]))[0];
  assert.equal(runA.next_step, 1);
  const task = (await sql(`select title from tasks where person_id = $1 and title like 'Позвонить%'`, [a]))[0];
  assert.equal(task.title, 'Позвонить Пропавший: давно не был (правило «Пропал на 10 дней»)');
  assert.equal((await run()).started, 0); // повторно не запускается

  // Второй клиент купил — цепочка останавливается; первому через 2 дня сообщение (мессенджера нет — пропуск с причиной)
  await req('POST', '/api/memberships', 'm.volkova', { personId: b, productId: products['Месяц безлимит'], confirmDuplicate: true });
  await sql(`update memberships set created_at = created_at - interval '3 days' where person_id = any($1)`, [[a, b]]);
  await sql(`update rule_runs set started_at = started_at - interval '2 days', next_due_at = now() - interval '1 minute' where club_id = $1`, [centr]);
  await sql(`update memberships set created_at = now() where person_id = $1 and product_name = 'Месяц безлимит'`, [b]);
  await run();
  assert.deepEqual((await sql(`select status, stop_reason from rule_runs where person_id = $1`, [b]))[0], { status: 'stopped', stop_reason: 'клиент купил' });
  const act = await sql(`select action, result, details from rule_actions where person_id = $1 order by created_at`, [a]);
  assert.deepEqual(act.map((x) => [x.action, x.result]), [['task', 'done'], ['message', 'done']]);
  const msg = (await sql(`select m.body, m.auto from msg_messages m join rule_actions a on a.ref_id = m.id where a.person_id = $1 and a.action = 'message'`, [a]))[0];
  assert.deepEqual(msg, { body: 'Пропавший, ждём вас в Клуб «Центр»!', auto: true });
  assert.equal((await sql(`select status from rule_runs where person_id = $1`, [a]))[0].status, 'done');

  const j = (await req('GET', `/api/rules/runs?clubId=${centr}`, 'o.smirnov')).json();
  assert.equal(j.rules[0].id, 'r_lost10');
  assert.ok(j.rules[0].goal >= 1);
  assert.ok(j.recent.length >= 2);
});
