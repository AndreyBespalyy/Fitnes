// Промокоды и акции: скидка в продаже, лимит продавца, согласование акции и разовой скидки, отчёт об окупаемости.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login, PASSWORD } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string };
let products: { id: string; name: string }[];
before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name === 'Клуб «Центр»');
  products = (await req('GET', `/api/products?clubId=${centr.id}`, 'm.volkova')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const prod = (name: string) => products.find((p) => p.name === name)!.id;
let n = 0;
const newClient = async () => (await req('POST', '/api/leads', 'm.volkova', { clubId: centr.id, fullName: `Промо Клиент ${++n}`, phone: `+7900555${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
const amountOf = async (personId: string, id: string) => (await req('GET', `/api/persons/${personId}/memberships`, 'm.volkova')).json().find((m: { id: string }) => m.id === id).amountKop;
const today = new Date().toISOString().slice(0, 10);
const later = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

test('акция в пределах лимита управляющего включается сразу, промокод даёт скидку новому клиенту', async () => {
  const r = await req('POST', '/api/promos', 'o.smirnov', { clubId: centr.id, name: 'Осень с блогером', code: 'osen10', channel: 'блогер', discountPercent: 10,
    productIds: [prod('Месяц безлимит')], condition: 'new', validFrom: today, validTo: later, maxUses: 2 });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().status, 'active');
  assert.equal((await req('POST', '/api/promos', 'o.smirnov', { clubId: centr.id, name: 'Дубль', code: 'OSEN10', discountPercent: 5, validFrom: today, validTo: later })).statusCode, 400);

  const p1 = await newClient();
  const chk = await req('POST', '/api/promos/check', 'm.volkova', { code: 'Osen10', personId: p1, productId: prod('Месяц безлимит') });
  assert.equal(chk.statusCode, 200, chk.body);
  assert.equal(chk.json().totalKop, 585000);
  assert.match((await req('POST', '/api/promos/check', 'm.volkova', { code: 'OSEN10', personId: p1, productId: prod('Годовой безлимит') })).json().message, /не действует на этот тариф/);
  assert.equal((await req('POST', '/api/promos/check', 'm.volkova', { code: 'НЕТТАКОГО', personId: p1, productId: prod('Месяц безлимит') })).json().error, 'promo_not_found');

  const s = await req('POST', '/api/memberships', 'm.volkova', { personId: p1, productId: prod('Месяц безлимит'), promoCode: 'osen10' });
  assert.equal(s.statusCode, 201, s.body);
  assert.equal(await amountOf(p1, s.json().id), 585000);
  // Повторно тот же клиент по акции не купит (он уже не новый, и акция — один раз на клиента)
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: p1, productId: prod('Месяц безлимит'), promoCode: 'osen10', confirmDuplicate: true })).statusCode, 400);
  // Лимит использований
  const p2 = await newClient();
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: p2, productId: prod('Месяц безлимит'), promoCode: 'osen10' })).statusCode, 201);
  const p3 = await newClient();
  assert.equal((await req('POST', '/api/promos/check', 'm.volkova', { code: 'osen10', personId: p3, productId: prod('Месяц безлимит') })).json().error, 'promo_used_up');

  await req('POST', '/api/promos', 'o.smirnov', { clubId: centr.id, name: 'Зима', code: 'ZIMA', discountPercent: 5, validFrom: later, validTo: later });
  const nz = (await req('POST', '/api/promos/check', 'm.volkova', { code: 'ZIMA', personId: p3, productId: prod('Месяц безлимит') })).json();
  assert.equal(nz.error, 'promo_not_started');
  assert.match(nz.message, /^Акция начнётся \d\d\.\d\d\.\d{4}$/);

  const rep = (await req('GET', `/api/promos?clubId=${centr.id}`, 'o.smirnov')).json().find((x: { code: string }) => x.code === 'OSEN10');
  assert.equal(rep.sales, 2);
  assert.equal(rep.revenue, 1170000);
  assert.equal(rep.cost, 130000);
  assert.equal(rep.newClients, 2);
  assert.equal(rep.roi, 9);
});

test('акция больше лимита управляющего ждёт согласования собственника', async () => {
  const r = await req('POST', '/api/promos', 'o.smirnov', { clubId: centr.id, name: 'Чёрная пятница', code: 'BLACK25', discountPercent: 25, validFrom: today, validTo: later });
  assert.equal(r.json().status, 'pending');
  const p = await newClient();
  assert.equal((await req('POST', '/api/promos/check', 'm.volkova', { code: 'BLACK25', personId: p, productId: prod('Месяц безлимит') })).json().error, 'promo_pending');
  const ap = (await req('GET', '/api/approvals?status=pending', 'a.bespalyy')).json().find((a: { summary: string }) => a.summary.includes('Чёрная пятница'));
  assert.equal(ap.kind, 'discount');
  assert.equal(ap.percent, 25);
  assert.equal(ap.canDecide, true);
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'a.bespalyy', { decision: 'approve', password: PASSWORD })).statusCode, 200);
  assert.equal((await req('POST', '/api/promos/check', 'm.volkova', { code: 'BLACK25', personId: p, productId: prod('Месяц безлимит') })).json().totalKop, 487500);
  // Остановленная акция не работает
  assert.equal((await req('POST', `/api/promos/${r.json().id}/status`, 'o.smirnov', { status: 'stopped' })).statusCode, 200);
  assert.equal((await req('POST', '/api/promos/check', 'm.volkova', { code: 'BLACK25', personId: p, productId: prod('Месяц безлимит') })).json().error, 'promo_stopped');
  // Менеджер акции не создаёт
  assert.equal((await req('POST', '/api/promos', 'm.volkova', { clubId: centr.id, name: 'Своя', discountPercent: 5, validFrom: today, validTo: later })).statusCode, 403);
});

test('ручная скидка: в пределах лимита продавца сразу, больше — через согласование', async () => {
  const p = await newClient();
  const pid = prod('10 посещений');
  const over = await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: pid, discountPercent: 8 });
  assert.equal(over.json().error, 'discount_over_limit');
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: pid, discountPercent: 5, promoCode: 'OSEN10' })).statusCode, 400); // скидки не суммируются

  const dr = await req('POST', '/api/discount-requests', 'm.volkova', { personId: p, productId: pid, percent: 8, reason: 'Переходит из другого клуба' });
  assert.equal(dr.json().status, 'pending', dr.body);
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: pid, discountRequestId: dr.json().id })).json().error, 'discount_pending');
  const ap = (await req('GET', '/api/approvals?status=pending', 'o.smirnov')).json().find((a: { summary: string }) => a.summary.includes('Переходит из другого клуба'));
  assert.equal(ap.canDecide, true); // 8 % в пределах 15 % управляющего
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'o.smirnov', { decision: 'approve', password: PASSWORD })).statusCode, 200);
  assert.equal((await req('GET', `/api/persons/${p}/discount-requests`, 'm.volkova')).json()[0].status, 'approved');
  const s = await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: pid, discountRequestId: dr.json().id });
  assert.equal(s.statusCode, 201, s.body);
  assert.equal(await amountOf(p, s.json().id), 828000);
  // Второй раз согласованная скидка не применяется
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: pid, discountRequestId: dr.json().id, confirmDuplicate: true })).statusCode, 400);

  const p2 = await newClient();
  const s2 = await req('POST', '/api/memberships', 'm.volkova', { personId: p2, productId: pid, discountPercent: 5 });
  assert.equal(s2.statusCode, 201, s2.body);
  assert.equal(await amountOf(p2, s2.json().id), 855000);
  assert.equal((await req('GET', `/api/promos/limit?clubId=${centr.id}`, 'm.volkova')).json().percent, 5);
});
