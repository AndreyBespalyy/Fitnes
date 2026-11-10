import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login, PASSWORD } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string };
before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'e.orlova', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: ck['a.bespalyy'] })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
});
after(async () => { await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
let n = 0;
async function sale(product: string, installments = 1) {
  const personId = (await req('POST', '/api/leads', 'd.lis', { clubId: centr.id, fullName: `Финансы Клиент ${++n}`, phone: `+7900444${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId;
  const p = (await req('GET', `/api/products?clubId=${centr.id}`, 'd.lis')).json().find((x: { name: string }) => x.name === product);
  const s = (await req('POST', '/api/memberships', 'd.lis', { personId, productId: p.id, installments })).json();
  const m = () => req('GET', `/api/persons/${personId}/memberships`, 'd.lis').then((r) => r.json().find((x: { id: string }) => x.id === s.id));
  return { personId, membershipId: s.id as string, m };
}
const pay = (chargeId: string, method = 'card_terminal') => req('POST', `/api/charges/${chargeId}/mark-paid`, 'd.lis', { method });
const approvalFor = async (who: string, objectSummary: string) =>
  (await req('GET', '/api/approvals?status=pending', who)).json().find((a: { summary: string }) => a.summary.includes(objectSummary));

test('наличные только при открытой смене; закрытие смены сверяет кассу', async () => {
  const s = await sale('Гостевой визит');
  const ch = (await s.m()).charges[0];
  assert.equal((await pay(ch.id, 'cash')).statusCode, 400);
  const open = await req('POST', '/api/shifts/open', 'd.lis', { clubId: centr.id, openingCashKop: 500_000 });
  assert.equal(open.statusCode, 200);
  assert.equal((await req('POST', '/api/shifts/open', 'd.lis', { clubId: centr.id, openingCashKop: 0 })).statusCode, 400);
  assert.equal((await pay(ch.id, 'cash')).statusCode, 200);
  const bad = await req('POST', `/api/shifts/${open.json().id}/close`, 'd.lis', { countedCashKop: 590_000 });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /ожидалось 6/);
  const ok = await req('POST', `/api/shifts/${open.json().id}/close`, 'd.lis', { countedCashKop: 600_000 });
  assert.equal(ok.json().differenceKop, 0);
  // открываем снова на весь остальной прогон
  await req('POST', '/api/shifts/open', 'd.lis', { clubId: centr.id, openingCashKop: 600_000 });
});

test('возврат: ресепшн запрашивает, управляющий утверждает с паролем, сумма в его лимите', async () => {
  const s = await sale('Месяц безлимит');
  await pay((await s.m()).charges[0].id);
  const q = (await req('GET', `/api/memberships/${s.membershipId}/refund-quote`, 'd.lis')).json();
  assert.equal(q.paidKop, 650_000);
  assert.ok(q.suggestedKop > 600_000 && q.suggestedKop <= 650_000);
  assert.equal((await req('POST', `/api/memberships/${s.membershipId}/refund`, 'd.lis', { amountKop: 700_000, method: 'card_terminal', reason: 'Переезд' })).statusCode, 400);
  const r = await req('POST', `/api/memberships/${s.membershipId}/refund`, 'd.lis', { amountKop: q.suggestedKop, method: 'card_terminal', reason: 'Переезд' });
  assert.equal(r.json().status, 'pending');
  const ap = await approvalFor('o.smirnov', 'Финансы Клиент');
  assert.equal(ap.canDecide, true);
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'd.lis', { decision: 'approve', password: PASSWORD })).statusCode, 403);
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'o.smirnov', { decision: 'approve', password: 'wrong' })).statusCode, 400);
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'o.smirnov', { decision: 'approve', password: PASSWORD })).statusCode, 200);
  const m = await s.m();
  assert.equal(m.status, 'cancelled');
});

test('возврат больше лимита управляющего (15 000 ₽) утверждает только собственник', async () => {
  const s = await sale('Годовой безлимит');
  await pay((await s.m()).charges[0].id);
  await req('POST', `/api/memberships/${s.membershipId}/refund`, 'd.lis', { amountKop: 2_000_000, method: 'bank_transfer', reason: 'Болезнь' });
  const ap = (await req('GET', '/api/approvals?status=pending', 'o.smirnov')).json().find((a: { amountKop: number }) => a.amountKop === 2_000_000);
  assert.equal(ap.canDecide, false);
  const r = await req('POST', `/api/approvals/${ap.id}/decide`, 'o.smirnov', { decision: 'approve', password: PASSWORD });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().message, /лимита/);
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'a.bespalyy', { decision: 'reject', password: PASSWORD })).statusCode, 400); // без причины
  assert.equal((await req('POST', `/api/approvals/${ap.id}/decide`, 'a.bespalyy', { decision: 'approve', password: PASSWORD })).statusCode, 200);
});

test('расходы: финансист запрашивает, управляющий до 50 000 ₽ сам, выше собственник', async () => {
  const own = await req('POST', '/api/expenses', 'o.smirnov', { clubId: centr.id, category: 'household', amountKop: 4_000_000, description: 'Полотенца', method: 'bank_transfer' });
  assert.equal(own.json().status, 'approved');
  const small = await req('POST', '/api/expenses', 'e.orlova', { clubId: centr.id, category: 'repair', amountKop: 3_000_000, description: 'Ремонт беговой дорожки', method: 'bank_transfer' });
  assert.equal(small.json().status, 'pending');
  const ap1 = await approvalFor('o.smirnov', 'беговой');
  assert.equal((await req('POST', `/api/approvals/${ap1.id}/decide`, 'o.smirnov', { decision: 'approve', password: PASSWORD })).statusCode, 200);
  const big = await req('POST', '/api/expenses', 'e.orlova', { clubId: centr.id, category: 'marketing', amountKop: 8_000_000, description: 'Реклама в Яндексе', method: 'bank_transfer' });
  const ap2 = await approvalFor('o.smirnov', 'Яндексе');
  assert.equal((await req('POST', `/api/approvals/${ap2.id}/decide`, 'o.smirnov', { decision: 'approve', password: PASSWORD })).statusCode, 403);
  assert.equal((await req('POST', `/api/approvals/${ap2.id}/decide`, 'a.bespalyy', { decision: 'approve', password: PASSWORD })).statusCode, 200);
  assert.equal(big.statusCode, 201);
  assert.equal((await req('POST', '/api/expenses', 'm.volkova', { clubId: centr.id, category: 'other', amountKop: 100, description: 'x', method: 'cash' })).statusCode, 403);
  const list = (await req('GET', `/api/expenses?clubId=${centr.id}`, 'e.orlova')).json();
  assert.equal(list.filter((e: { status: string }) => e.status === 'approved').length, 3);
});

test('прогон: продажа → оплата частями → заморозка → возврат, все цифры сходятся', async () => {
  const before = (await req('GET', `/api/finance/cashflow?clubId=${centr.id}`, 'e.orlova')).json();
  const s = await sale('Годовой безлимит', 3);
  let m = await s.m();
  assert.deepEqual(m.charges.map((c: { amountKop: number }) => c.amountKop), [1_400_000, 1_400_000, 1_400_000]);
  // оплачены две части из трёх
  await pay(m.charges[0].id, 'card_terminal');
  await pay(m.charges[1].id, 'sbp');
  m = await s.m();
  const endsBefore = m.endsOn;
  await req('POST', `/api/memberships/${s.membershipId}/freeze`, 'd.lis', { days: 14 });
  m = await s.m();
  assert.notEqual(m.endsOn, endsBefore);
  const q = (await req('GET', `/api/memberships/${s.membershipId}/refund-quote`, 'd.lis')).json();
  assert.equal(q.paidKop, 2_800_000);
  assert.match(q.explanation, /заморозки не считаются/);
  // сегодня — первый день абонемента и первый день заморозки: использованных дней нет
  assert.equal(q.usedKop, 0);
  // возвращаем 10 000 ₽ — в пределах лимита управляющего, он оформляет сам
  const r = await req('POST', `/api/memberships/${s.membershipId}/refund`, 'o.smirnov', { amountKop: 1_000_000, method: 'card_terminal', reason: 'Частичный возврат по договорённости', cancelMembership: true });
  assert.equal(r.json().status, 'paid');
  m = await s.m();
  assert.equal(m.status, 'cancelled');
  assert.equal(m.charges.filter((c: { status: string }) => c.status === 'due').length, 0);  // неоплаченная часть снята
  const after = (await req('GET', `/api/finance/cashflow?clubId=${centr.id}`, 'e.orlova')).json();
  assert.equal(after.inflowKop - before.inflowKop, 2_800_000);
  assert.equal(after.refundsKop - before.refundsKop, 1_000_000);
  assert.equal(after.netKop - before.netKop, 1_800_000);
  // в журнале платежей те же суммы
  const pays = (await req('GET', `/api/finance/payments?clubId=${centr.id}`, 'e.orlova')).json().filter((p: { personName: string }) => p.personName === `Финансы Клиент ${n}`);
  assert.equal(pays.filter((p: { direction: string }) => p.direction === 'in').reduce((a: number, p: { amountKop: number }) => a + p.amountKop, 0), 2_800_000);
  assert.equal(pays.filter((p: { direction: string }) => p.direction === 'out').reduce((a: number, p: { amountKop: number }) => a + p.amountKop, 0), 1_000_000);
  // повторно вернуть больше остатка нельзя (абонемент закрыт, но проверка суммы остаётся)
  const again = (await req('GET', `/api/memberships/${s.membershipId}/refund-quote`, 'd.lis')).json();
  assert.equal(again.maxKop, 1_800_000);
});

test('план-факт по категориям и долги', async () => {
  const month = new Date().toISOString().slice(0, 7);
  assert.equal((await req('PUT', '/api/finance/plan', 'e.orlova', { clubId: centr.id, month, amounts: { new: 10_000_000 } })).statusCode, 200);
  const pf = (await req('GET', `/api/finance/plan-fact?clubId=${centr.id}&month=${month}`, 'e.orlova')).json();
  const nw = pf.items.find((x: { category: string }) => x.category === 'new');
  assert.equal(nw.planKop, 10_000_000);
  assert.ok(nw.factKop > 0);
  const debts = (await req('GET', '/api/finance/debts', 'a.bespalyy')).json();
  assert.ok(debts.some((d: { personName: string }) => d.personName === 'Тимур Ахметов'));
  assert.equal((await req('GET', '/api/finance/debts', 'm.volkova')).statusCode, 403);
});
