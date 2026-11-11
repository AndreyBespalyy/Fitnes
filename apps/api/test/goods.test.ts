// Товары и услуги на ресепшне: справочник, приход, продажа с оплатой и на счёт, остатки, отмена, отчёт.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';
const ids: Record<string, string> = {};
const stock = async (name: string) => (await req('GET', `/api/goods?clubId=${centr}`, 'd.lis')).json().items.find((g: { name: string }) => g.name === name);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('справочник и приход: товары с остатком, услуги без', async () => {
  assert.equal((await req('POST', '/api/goods', 'd.lis', { clubId: centr, name: 'Вода', priceKop: 10000 })).statusCode, 403);
  const w = await req('POST', '/api/goods', 'o.smirnov', { clubId: centr, name: 'Вода 0,5 л', category: 'Напитки', priceKop: 10000, stock: 5, minStock: 3 });
  assert.equal(w.statusCode, 201, w.body);
  ids.water = w.json().id;
  ids.locker = (await req('POST', '/api/goods', 'o.smirnov', { clubId: centr, name: 'Аренда шкафчика на день', kind: 'service', priceKop: 15000 })).json().id;
  ids.bar = (await req('POST', '/api/goods', 'o.smirnov', { clubId: centr, name: 'Протеиновый батончик', priceKop: 25000 })).json().id;
  assert.equal((await req('POST', '/api/goods', 'o.smirnov', { clubId: centr, name: 'вода 0,5 л', priceKop: 1 })).statusCode, 400);
  const inn = await req('POST', `/api/goods/${ids.bar}/stock`, 'o.smirnov', { kind: 'in', qty: 10, costKop: 120000 });
  assert.equal(inn.json().stock, 10);
  assert.equal((await stock('Вода 0,5 л')).stock, 5);
  assert.equal((await stock('Аренда шкафчика на день')).stock, null);
});

test('продажа: картой сразу, остаток уменьшается, наличные только при открытой смене, больше остатка нельзя', async () => {
  const s = await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, method: 'card_terminal', items: [{ goodsId: ids.water, qty: 2 }, { goodsId: ids.locker, qty: 1 }, { goodsId: ids.water, qty: 1 }] });
  assert.equal(s.statusCode, 201, s.body);
  assert.equal(s.json().totalKop, 45000);
  const w = await stock('Вода 0,5 л');
  assert.equal(w.stock, 2);
  assert.equal(w.low, true); // ниже минимального остатка
  const pay = (await sql(`select sale_category, amount_kop from payments where club_id = $1 and sale_category = 'goods' order by created_at desc limit 1`, [centr]))[0];
  assert.equal(Number(pay.amount_kop), 45000);
  assert.equal((await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, method: 'card_terminal', items: [{ goodsId: ids.water, qty: 3 }] })).json().error, 'out_of_stock');
  const cash = await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, method: 'cash', items: [{ goodsId: ids.water, qty: 1 }] });
  assert.equal(cash.statusCode, 400);
  assert.match(cash.json().message, /откройте кассовую смену/);
  assert.equal((await stock('Вода 0,5 л')).stock, 2); // неудачная продажа ничего не списала
  assert.equal((await req('POST', '/api/goods/sales', 'a.kim', { clubId: centr, method: 'card_terminal', items: [{ goodsId: ids.locker, qty: 1 }] })).statusCode, 403);
});

test('на счёт клиента: долг, оплата позже обычным платежом, отмена неоплаченной', async () => {
  assert.equal((await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, items: [{ goodsId: ids.bar, qty: 1 }] })).statusCode, 400); // без клиента нельзя
  const personId = (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: 'Покупатель На Счёт', phone: '+79005550101', sourceCode: 'walk_in' })).json().personId;
  const s1 = (await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, personId, items: [{ goodsId: ids.bar, qty: 2 }] })).json();
  assert.equal(s1.status, 'on_account');
  const ch = (await sql('select kind, status, amount_kop from charges where id = $1', [s1.chargeId]))[0];
  assert.deepEqual([ch.kind, ch.status, Number(ch.amount_kop)], ['goods', 'due', 50000]);
  const paid = await req('POST', `/api/charges/${s1.chargeId}/mark-paid`, 'd.lis', { method: 'card_terminal' });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal((await sql('select status, method from goods_sales where id = $1', [s1.id]))[0].status, 'paid');
  assert.equal((await sql(`select sale_category from payments where charge_id = $1`, [s1.chargeId]))[0].sale_category, 'goods');

  const s2 = (await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, personId, items: [{ goodsId: ids.bar, qty: 3 }] })).json();
  assert.equal((await stock('Протеиновый батончик')).stock, 5);
  assert.equal((await req('POST', `/api/goods/sales/${s2.id}/cancel`, 'd.lis', { reason: 'Передумал' })).statusCode, 200);
  assert.equal((await stock('Протеиновый батончик')).stock, 8);
  assert.equal((await sql('select status from charges where id = $1', [s2.chargeId]))[0].status, 'cancelled');
  assert.equal((await req('POST', `/api/goods/sales/${s1.id}/cancel`, 'd.lis', { reason: 'x' })).statusCode, 400); // оплаченную не отменить
});

test('списание и пересчёт, отчёт', async () => {
  assert.equal((await req('POST', `/api/goods/${ids.bar}/stock`, 'o.smirnov', { kind: 'writeoff', qty: 1 })).statusCode, 400); // без причины
  assert.equal((await req('POST', `/api/goods/${ids.bar}/stock`, 'o.smirnov', { kind: 'writeoff', qty: 1, comment: 'Истёк срок' })).json().stock, 7);
  assert.equal((await req('POST', `/api/goods/${ids.bar}/stock`, 'o.smirnov', { kind: 'count', qty: 6, comment: 'Инвентаризация' })).json().stock, 6);
  const moves = (await req('GET', `/api/goods/${ids.bar}/moves`, 'o.smirnov')).json();
  assert.deepEqual(moves.slice(0, 2).map((m: { kind: string; qty: number }) => `${m.kind}${m.qty}`), ['count-1', 'writeoff-1']);
  const r = (await req('GET', `/api/goods/report?clubId=${centr}`, 'o.smirnov')).json();
  assert.equal(r.total, 95000);
  assert.equal(r.byGoods[0].name, 'Протеиновый батончик');
  assert.ok(r.low.some((g: { name: string }) => g.name === 'Вода 0,5 л'));
  assert.equal(r.recent.length, 3);
});
