// Бонусная программа: правила клуба, начисления за покупку, визит и продление один раз, уровни, трата на дни и товары, сгорание.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { processLoyalty } from '../src/modules/loyalty.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenantId = '';
const products: Record<string, string> = {};
const run = () => withCtx(t.pool, { tenantId, allClubs: true, clubIds: [] } as never, (db) => processLoyalty(db, tenantId, centr));
const payAll = async (membershipId: string) => {
  for (const c of await sql(`select id from charges where membership_id = $1 and status = 'due'`, [membershipId])) {
    const r = await req('POST', `/api/charges/${c.id}/mark-paid`, 'd.lis', { method: 'card_terminal' }); assert.equal(r.statusCode, 200, r.body);
  }
};

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenantId = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  for (const p of (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json()) products[p.name] = p.id;
  await sql(`insert into club_access_settings(tenant_id, club_id, open_from, open_to) select tenant_id, id, '00:00', '23:59' from clubs where id = $1
    on conflict (club_id) do update set open_from = '00:00', open_to = '23:59'`, [centr]);
  await sql(`update club_membership_settings set contract_required_for_access = false where club_id = $1`, [centr]).catch(() => null);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('правила: задаёт управляющий, ресепшн не может; первый уровень без условий', async () => {
  assert.equal((await req('PUT', '/api/loyalty/settings', 'd.lis', { clubId: centr, enabled: true })).statusCode, 403);
  const bad = await req('PUT', '/api/loyalty/settings', 'o.smirnov', { clubId: centr, levels: [{ name: 'Серебро', minMonths: 3, minSpendKop: 0, bonusPercent: 10 }] });
  assert.equal(bad.statusCode, 400);
  assert.equal((await req('PUT', '/api/loyalty/settings', 'o.smirnov', { clubId: centr, purchasePercent: 90 })).statusCode, 400);
  const r = await req('PUT', '/api/loyalty/settings', 'o.smirnov', { clubId: centr, enabled: true, visitPoints: 10, purchasePercent: 5, renewalPoints: 300, pointValueKop: 100, dayPricePoints: 300 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().enabled, true);
  assert.ok(r.json().enabledAt);
});

test('начисления один раз, трата на дни и товары, нехватка баллов, сгорание', async () => {
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Баллов Много', phone: '+79004440001', sourceCode: 'walk_in' })).json().personId;
  const m1 = (await req('POST', '/api/memberships', 'm.volkova', { personId, productId: products['Месяц безлимит'] })).json().id;
  await payAll(m1);
  assert.equal((await req('POST', '/api/desk/pass', 'd.lis', { clubId: centr, personId })).json().ok, true);
  await run(); await run(); // второй запуск ничего не удваивает
  let l = (await req('GET', `/api/persons/${personId}/loyalty?clubId=${centr}`, 'd.lis')).json();
  assert.equal(l.balance, 325 + 10); // 5 % от 6 500 ₽ = 325 баллов + 10 за визит
  assert.equal(l.level.code, 'base');
  assert.equal(l.next.code, 'silver');

  const m2 = (await req('POST', `/api/memberships/${m1}/renew`, 'm.volkova', {})).json().id;
  await payAll(m2);
  await run();
  l = (await req('GET', `/api/persons/${personId}/loyalty?clubId=${centr}`, 'd.lis')).json();
  assert.equal(l.balance, 335 + 325 + 300);

  const ends = (await sql(`select to_char(ends_on, 'YYYY-MM-DD') as e from memberships where id = $1`, [m1]))[0].e;
  const sp = await req('POST', `/api/persons/${personId}/loyalty/spend`, 'd.lis', { clubId: centr, kind: 'days', membershipId: m1, qty: 2 });
  assert.equal(sp.statusCode, 200, sp.body);
  assert.equal(sp.json().points, 600);
  assert.equal(sp.json().balance, 360);
  const d = new Date(`${ends}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 2);
  assert.equal(sp.json().endsOn, d.toISOString().slice(0, 10));
  assert.equal((await req('POST', `/api/persons/${personId}/loyalty/spend`, 'd.lis', { clubId: centr, kind: 'days', membershipId: m1, qty: 2 })).json().error, 'points_low');

  // Товар баллами: платежа и чека нет
  const gr = await req('POST', '/api/goods', 'o.smirnov', { clubId: centr, name: 'Полотенце за баллы', kind: 'service', priceKop: 10000 });
  assert.equal(gr.statusCode, 201, gr.body);
  const water = gr.json();
  const payBefore = (await sql(`select count(*)::int as n from payments`))[0].n;
  const g = await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, personId, method: 'points', items: [{ goodsId: water.id, qty: 1 }] });
  assert.equal(g.statusCode, 201, g.body);
  assert.equal((await sql(`select count(*)::int as n from payments`))[0].n, payBefore);
  const after1 = (await req('GET', `/api/persons/${personId}/loyalty?clubId=${centr}`, 'd.lis')).json().balance;
  assert.equal(after1, 360 - 100); // 100 ₽ при цене балла 1 ₽

  // Корректировка — только с причиной
  assert.equal((await req('POST', `/api/persons/${personId}/loyalty/adjust`, 'o.smirnov', { clubId: centr, points: 50 })).statusCode, 400);
  assert.equal((await req('POST', `/api/persons/${personId}/loyalty/adjust`, 'd.lis', { clubId: centr, points: 50, comment: 'x' })).statusCode, 403);

  // Срок начислений истёк — остаток сгорает
  await sql(`update loyalty_moves set expires_on = current_date - 1 where person_id = $1 and points > 0`, [personId]);
  const r = await run();
  assert.equal(r.expired, 1);
  l = (await req('GET', `/api/persons/${personId}/loyalty?clubId=${centr}`, 'd.lis')).json();
  assert.equal(l.balance, 0);
  assert.equal(l.moves[0].kind, 'expire');
});
