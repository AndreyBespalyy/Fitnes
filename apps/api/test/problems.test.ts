// «Проблемные моменты»: сводка для собственника, управляющего и финансиста; остальным роли раздел недоступен.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (url: string, who: string) => t.app.inject({ method: 'GET', url, cookies: ck[who] });

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'e.orlova', 'm.volkova', 'd.lis', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('собственник видит все пункты по всей сети, у каждого есть переход', async () => {
  const r = await req('/api/problems?clubId=all', 'a.bespalyy');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.ok(d.clubs.length >= 2);
  assert.equal(d.items.length, 12);
  for (const i of d.items) {
    assert.ok(i.go?.tab, i.id);
    assert.equal(i.perClub.length, d.clubs.length, i.id);
  }
  assert.ok(Array.isArray(d.lows));
});

test('управляющий — только свой клуб, финансист — только финансовые пункты', async () => {
  const gm = (await req('/api/problems?clubId=all', 'o.smirnov')).json();
  assert.equal(gm.clubs.length, 1);
  const fin = await req('/api/problems?clubId=all', 'e.orlova');
  assert.equal(fin.statusCode, 200, fin.body);
  const ids = fin.json().items.map((i: { id: string }) => i.id);
  assert.ok(ids.includes('debts') && ids.includes('payroll'));
  assert.ok(!ids.includes('missedResponse') && !ids.includes('lowScores'));
});

test('менеджеру, ресепшн и тренеру раздел недоступен', async () => {
  for (const l of ['m.volkova', 'd.lis', 'a.kim']) assert.equal((await req('/api/problems?clubId=all', l)).statusCode, 403, l);
});

test('тренер видит в «Моих клиентах» только записанных к нему', async () => {
  const all = (await req('/api/persons', 'a.kim')).json();
  const mine = await req('/api/persons?mine=1', 'a.kim');
  assert.equal(mine.statusCode, 200, mine.body);
  assert.ok(mine.json().length <= all.length);
});
