// Общий поиск: сотрудники по фамилии и договоры по номеру (замечание № 4 из журнала тестировщика).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
before(async () => { t = await setupTestApp(); for (const l of ['a.bespalyy', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!; });
after(async () => { await t.app.close(); await t.pool.end(); });

test('поиск находит сотрудника по фамилии; без права на сотрудников — только договоры', async () => {
  const r = (await t.app.inject({ method: 'GET', url: `/api/search/more?q=${encodeURIComponent('Волкова')}`, cookies: ck['a.bespalyy'] })).json();
  assert.ok(r.staff.some((u: { fullName: string }) => u.fullName.includes('Волкова')), JSON.stringify(r));
  assert.ok(Array.isArray(r.contracts));
  const m = (await t.app.inject({ method: 'GET', url: `/api/search/more?q=${encodeURIComponent('Смирнов')}`, cookies: ck['m.volkova'] })).json();
  assert.deepEqual(m.staff, []);
  const short = (await t.app.inject({ method: 'GET', url: '/api/search/more?q=a', cookies: ck['a.bespalyy'] })).json();
  assert.deepEqual(short, { staff: [], contracts: [] });
});
