// Подарочные сертификаты и депозит клиента: пополнение, оплата с депозита, сертификат на сумму и на абонемент, аннулирование.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';
let products: { id: string; name: string; priceKop: number }[] = [];
const prod = (n: string) => products.find((p) => p.name === n)!;
const lead = async (name: string, phone: string) => (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: name, phone, sourceCode: 'walk_in' })).json().personId as string;
const payCount = async (cat: string) => Number((await sql(`select count(*) from payments where club_id = $1 and sale_category = $2`, [centr, cat]))[0].count);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  products = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('депозит: пополнение картой, оплата абонемента с депозита без второго платежа, нехватка денег', async () => {
  const p = await lead('Депозит Клиентов', '+79005551101');
  assert.equal((await req('POST', `/api/persons/${p}/deposit/topup`, 'a.kim', { clubId: centr, amountKop: 100000, method: 'card_terminal' })).statusCode, 403);
  assert.equal((await req('POST', `/api/persons/${p}/deposit/topup`, 'd.lis', { clubId: centr, amountKop: 50, method: 'card_terminal' })).statusCode, 400);
  const top = await req('POST', `/api/persons/${p}/deposit/topup`, 'd.lis', { clubId: centr, amountKop: 700000, method: 'card_terminal' });
  assert.equal(top.statusCode, 200, top.body);
  assert.equal(top.json().balanceKop, 700000);
  assert.equal(await payCount('deposit'), 1);
  const m = (await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: prod('Месяц безлимит').id })).json();
  const ch = (await sql(`select id from charges where membership_id = $1`, [m.id]))[0].id;
  const paymentsBefore = Number((await sql(`select count(*) from payments where person_id = $1`, [p]))[0].count);
  const pay = await req('POST', `/api/charges/${ch}/pay-deposit`, 'd.lis');
  assert.equal(pay.statusCode, 200, pay.body);
  assert.equal(pay.json().balanceKop, 50000);
  const c = (await sql(`select status, paid_method from charges where id = $1`, [ch]))[0];
  assert.deepEqual([c.status, c.paid_method], ['paid', 'deposit']);
  assert.equal(Number((await sql(`select count(*) from payments where person_id = $1`, [p]))[0].count), paymentsBefore); // выручка не задвоилась
  assert.equal((await req('POST', `/api/charges/${ch}/pay-deposit`, 'd.lis')).statusCode, 400); // уже оплачено
  const m2 = (await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: prod('Гостевой визит').id })).json();
  const ch2 = (await sql(`select id from charges where membership_id = $1`, [m2.id]))[0].id;
  const low = await req('POST', `/api/charges/${ch2}/pay-deposit`, 'd.lis');
  assert.equal(low.json().error, 'deposit_low');
  const card = (await req('GET', `/api/persons/${p}/deposit?clubId=${centr}`, 'd.lis')).json();
  assert.equal(card.balanceKop, 50000);
  assert.deepEqual(card.moves.map((x: { kind: string }) => x.kind), ['spend', 'topup']);
});

test('депозит: товары с депозита, возврат остатка только управляющим', async () => {
  const p = await lead('Товары Сдепозита', '+79005551102');
  await req('POST', `/api/persons/${p}/deposit/topup`, 'd.lis', { clubId: centr, amountKop: 30000, method: 'card_terminal' });
  const g = (await req('POST', '/api/goods', 'o.smirnov', { clubId: centr, name: 'Полотенце в аренду', kind: 'service', priceKop: 20000 })).json();
  assert.equal((await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, method: 'deposit', items: [{ goodsId: g.id, qty: 1 }] })).statusCode, 400); // без клиента
  const goodsPays = await payCount('goods');
  const s = await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, personId: p, method: 'deposit', items: [{ goodsId: g.id, qty: 1 }] });
  assert.equal(s.json().status, 'paid', s.body);
  assert.equal(await payCount('goods'), goodsPays);
  assert.equal((await req('POST', '/api/goods/sales', 'd.lis', { clubId: centr, personId: p, method: 'deposit', items: [{ goodsId: g.id, qty: 1 }] })).json().error, 'deposit_low');
  assert.equal((await req('POST', `/api/persons/${p}/deposit/refund`, 'd.lis', { clubId: centr, amountKop: 10000, method: 'card_terminal', comment: 'переезд' })).statusCode, 403);
  assert.equal((await req('POST', `/api/persons/${p}/deposit/refund`, 'o.smirnov', { clubId: centr, amountKop: 20000, method: 'card_terminal', comment: 'переезд' })).statusCode, 400);
  const r = await req('POST', `/api/persons/${p}/deposit/refund`, 'o.smirnov', { clubId: centr, amountKop: 10000, method: 'card_terminal', comment: 'переезд' });
  assert.equal(r.json().balanceKop, 0, r.body);
});

test('сертификат на сумму: продажа, проверка кода, зачисление на депозит получателя, повторно нельзя', async () => {
  const buyer = await lead('Даритель Сертификата', '+79005551103');
  const friend = await lead('Получатель Подарка', '+79005551104');
  assert.equal((await req('POST', '/api/gift-certs', 'd.lis', { clubId: centr, kind: 'amount', amountKop: 300000, method: 'card_terminal' })).statusCode, 400); // без покупателя
  const c = await req('POST', '/api/gift-certs', 'd.lis', { clubId: centr, kind: 'amount', amountKop: 300000, method: 'card_terminal', buyerPersonId: buyer, recipientName: 'Маше' });
  assert.equal(c.statusCode, 200, c.body);
  const cert = c.json();
  assert.match(cert.code, /^GIFT-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(cert.status, 'active');
  assert.equal(await payCount('gift'), 1);
  const chk = (await req('GET', `/api/gift-certs/check?code=${cert.code.toLowerCase()}`, 'd.lis')).json();
  assert.equal(chk.amountKop, 300000);
  assert.equal(chk.buyer, 'Даритель Сертификата');
  const r = await req('POST', '/api/gift-certs/redeem', 'd.lis', { code: cert.code, personId: friend });
  assert.equal(r.json().balanceKop, 300000, r.body);
  assert.equal((await req('POST', '/api/gift-certs/redeem', 'd.lis', { code: cert.code, personId: friend })).json().error, 'gift_used');
  assert.equal((await req('POST', '/api/gift-certs/redeem', 'd.lis', { code: 'GIFT-0000-0000', personId: friend })).json().error, 'not_found');
  const list = (await req('GET', `/api/gift-certs?clubId=${centr}`, 'd.lis')).json();
  assert.equal(list.items.find((x: { code: string }) => x.code === cert.code).usedBy, 'Получатель Подарка');
});

test('сертификат на абонемент: погашение оформляет абонемент оплаченным; просроченный и аннулированный не принимаются', async () => {
  const friend = await lead('Абонемент Вподарок', '+79005551105');
  const c = (await req('POST', '/api/gift-certs', 'd.lis', { clubId: centr, kind: 'product', productId: prod('Месяц безлимит').id, method: 'card_terminal', buyerName: 'Иван Петров' })).json();
  assert.equal(c.amountKop, prod('Месяц безлимит').priceKop);
  const r = (await req('POST', '/api/gift-certs/redeem', 'd.lis', { code: c.code, personId: friend })).json();
  assert.ok(r.membershipId, JSON.stringify(r));
  const ch = await sql(`select status, paid_method from charges where membership_id = $1`, [r.membershipId]);
  assert.deepEqual(ch.map((x) => [x.status, x.paid_method]), [['paid', 'gift']]);
  // просрочен
  const old = (await req('POST', '/api/gift-certs', 'd.lis', { clubId: centr, kind: 'amount', amountKop: 100000, method: 'card_terminal', buyerName: 'Старый' })).json();
  await sql(`update gift_certs set valid_to = current_date - 2 where id = $1`, [old.id]);
  assert.equal((await req('POST', '/api/gift-certs/redeem', 'd.lis', { code: old.code, personId: friend })).json().error, 'gift_expired');
  // аннулирование с возвратом
  const x = (await req('POST', '/api/gift-certs', 'd.lis', { clubId: centr, kind: 'amount', amountKop: 100000, method: 'card_terminal', buyerName: 'Передумал' })).json();
  assert.equal((await req('POST', `/api/gift-certs/${x.id}/cancel`, 'd.lis', { method: 'card_terminal', comment: 'ошибка' })).statusCode, 403);
  assert.equal((await req('POST', `/api/gift-certs/${x.id}/cancel`, 'o.smirnov', { method: 'card_terminal', comment: 'ошибка' })).statusCode, 200);
  assert.equal((await req('POST', '/api/gift-certs/redeem', 'd.lis', { code: x.code, personId: friend })).json().error, 'gift_cancelled');
  const out = await sql(`select count(*) from payments where club_id = $1 and sale_category = 'gift' and direction = 'out'`, [centr]);
  assert.equal(Number(out[0].count), 1);
});
