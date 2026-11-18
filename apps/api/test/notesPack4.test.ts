// Замечания тестировщиков 18.11.2026, пакет 4: подписка в клубе «на срок» (№49), подразделения в расписании (№37),
// «Мой месяц» менеджера (№34), воронка «Тренер хаб».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
let centr = ''; let sever = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'm.volkova', 'o.smirnov']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json() as { id: string; salesModel: string }[];
  centr = clubs.find((c) => c.salesModel === 'term')!.id; sever = clubs.find((c) => c.salesModel === 'subscription')!.id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('подписочный тариф можно завести в клубе «на срок»; абонемент на срок в клубе-подписке — нельзя', async () => {
  const ok = await req('POST', '/api/products', 'a.bespalyy', { clubId: centr, kind: 'subscription', name: 'Подписка Центр', priceKop: 350000 });
  assert.equal(ok.statusCode, 201, ok.body);
  const bad = await req('POST', '/api/products', 'a.bespalyy', { clubId: sever, kind: 'term', name: 'Срок Север', priceKop: 350000, durationDays: 30 });
  assert.equal(bad.statusCode, 400);
});

test('виды занятий делятся по подразделениям, подразделение видно в расписании', async () => {
  const r = await req('POST', '/api/schedule/types', 'o.smirnov', { clubId: centr, name: 'Бокс для начинающих', kind: 'group', department: 'БК' });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().department, 'БК');
  const setup = (await req('GET', `/api/schedule/setup?clubId=${centr}`, 'o.smirnov')).json();
  assert.ok(setup.types.every((x: { department: string | null }) => x.department));
  const pt = setup.types.find((x: { kind: string }) => x.kind === 'personal');
  if (pt) assert.equal(pt.department, 'ТЗ');
  assert.equal((await req('PATCH', `/api/schedule/types/${r.json().id}`, 'o.smirnov', { department: 'ГП' })).json().department, 'ГП');
  assert.equal((await req('PATCH', `/api/schedule/types/${r.json().id}`, 'm.volkova', { department: 'ТЗ' })).statusCode, 403);
});

test('«Тренер хаб» — отдельная воронка в каждом клубе; у менеджера на столе «Мой месяц»', async () => {
  for (const c of [centr, sever]) {
    const p = (await req('GET', `/api/pipelines?clubId=${c}`, 'a.bespalyy')).json() as { name: string }[];
    assert.ok(p.some((x) => x.name === 'Тренер хаб'), c);
  }
  const d = await req('GET', `/api/dash/widget/my_month?clubId=${centr}`, 'm.volkova');
  assert.equal(d.statusCode, 200, d.body);
  const w = d.json();
  for (const k of ['factKop', 'newClients', 'renewals', 'recurring', 'calls', 'dialogs']) assert.equal(typeof w[k], 'number', k);
  assert.equal(typeof w.trainerHub.won, 'number');
});
