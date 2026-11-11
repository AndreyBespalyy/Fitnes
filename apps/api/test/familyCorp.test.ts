// Семейные и корпоративные абонементы: семья со скидкой второму и оплатой разом, компания с сотрудниками, счёт и оплата по счёту.
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
const prod = (n: string) => products.find((p) => p.name === n)!.id;
let n = 0;
const lead = async (name: string) => (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: name, phone: `+7900777${String(++n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
const sell = (personId: string, product: string, extra: Record<string, unknown> = {}) => req('POST', '/api/memberships', 'm.volkova', { personId, productId: prod(product), ...extra });

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova', 'e.orlova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  products = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('семья: плательщик, участники, скидка второму, платёж на плательщика, оплата разом', async () => {
  const mom = await lead('Мама Семейная'); const son = await lead('Сын Семейный'); const dad = await lead('Папа Семейный');
  assert.equal((await sell(son, 'Месяц безлимит', { payer: 'family' })).json().error, 'bad_request'); // не в семье
  const g = (await req('POST', '/api/families', 'm.volkova', { clubId: centr, payerId: mom })).json();
  assert.equal((await req('POST', `/api/families/${g.id}/members`, 'm.volkova', { personId: son, relation: 'сын' })).statusCode, 200);
  await req('POST', `/api/families/${g.id}/members`, 'm.volkova', { personId: dad, relation: 'муж' });
  assert.equal((await req('POST', '/api/families', 'm.volkova', { clubId: centr, payerId: son })).statusCode, 400); // уже в семье
  // первый в семье — без скидки
  const m1 = (await sell(mom, 'Месяц безлимит', { payer: 'family' })).json();
  assert.equal(Number((await sql('select amount_kop from memberships where id = $1', [m1.id]))[0].amount_kop), 650000);
  // второй — со скидкой 10 %
  const m2 = (await sell(son, 'Месяц безлимит', { payer: 'family' })).json();
  const r2 = (await sql('select amount_kop, payer_person_id, family_group_id from memberships where id = $1', [m2.id]))[0];
  assert.equal(Number(r2.amount_kop), 585000);
  assert.equal(r2.payer_person_id, mom);
  await sell(dad, '10 посещений', { payer: 'family' });
  const fam = (await req('GET', `/api/persons/${son}/family?clubId=${centr}`, 'd.lis')).json();
  assert.equal(fam.group.members.length, 3);
  assert.equal(fam.group.members[0].payer, true);
  assert.equal(fam.group.due.length, 3);
  assert.equal(fam.group.dueKop, 650000 + 585000 + 810000);
  const paid = await req('POST', `/api/families/${g.id}/pay`, 'd.lis', { method: 'card_terminal' });
  assert.equal(paid.json().paid, 3, paid.body);
  const pays = await sql(`select person_id, count(*) from payments where person_id = any($1) group by 1`, [[mom, son, dad]]);
  assert.deepEqual(pays.map((x) => x.person_id), [mom]); // все платежи — на плательщика
  assert.equal((await req('POST', `/api/families/${g.id}/members/${mom}/remove`, 'm.volkova')).statusCode, 400);
  assert.equal((await req('POST', `/api/families/${g.id}/members/${dad}/remove`, 'm.volkova')).statusCode, 200);
});

test('компания: сотрудники с лимитом, продажа за счёт компании, на ресепшне не оплатить, счёт и оплата по счёту, отчёт', async () => {
  assert.equal((await req('POST', '/api/companies', 'd.lis', { clubId: centr, name: 'ООО Ромашка' })).statusCode, 403);
  assert.equal((await req('POST', '/api/companies', 'o.smirnov', { clubId: centr, name: 'ООО Ромашка', inn: '123' })).statusCode, 400);
  const c = (await req('POST', '/api/companies', 'o.smirnov', { clubId: centr, name: 'ООО Ромашка', inn: '7701234567', contractNumber: 'К-15', contractDate: '2026-11-01', discountPercent: 15, paymentDays: 10, maxEmployees: 2 })).json();
  const e1 = await lead('Сотрудник Первый'); const e2 = await lead('Сотрудник Второй'); const e3 = await lead('Сотрудник Третий');
  assert.equal((await sell(e1, 'Месяц безлимит', { payer: 'company', companyId: c.id })).statusCode, 400); // ещё не сотрудник
  await req('POST', `/api/companies/${c.id}/employees`, 'm.volkova', { personId: e1, position: 'бухгалтер' });
  await req('POST', `/api/companies/${c.id}/employees`, 'm.volkova', { personId: e2 });
  assert.match((await req('POST', `/api/companies/${c.id}/employees`, 'm.volkova', { personId: e3 })).json().message, /не больше 2/);
  assert.equal((await sell(e1, 'Месяц безлимит', { payer: 'company', companyId: c.id, installments: 2 })).statusCode, 400);
  const m1 = (await sell(e1, 'Месяц безлимит', { payer: 'company', companyId: c.id })).json();
  const m2 = (await sell(e2, 'Полгода безлимит', { payer: 'company', companyId: c.id })).json();
  const ch1 = (await sql('select id, amount_kop, company_id, due_on::text as due from charges where membership_id = $1', [m1.id]))[0];
  assert.equal(Number(ch1.amount_kop), 552500); // 6500 − 15 %
  assert.equal(ch1.company_id, c.id);
  assert.ok(ch1.due > new Date().toISOString().slice(0, 10)); // срок — после конца месяца, проход не закрывается
  const card = (await req('GET', `/api/persons/${e1}/memberships`, 'd.lis')).json();
  assert.equal(card[0].access, true);
  assert.equal(card[0].charges[0].company, 'ООО Ромашка');
  assert.equal((await req('POST', `/api/charges/${ch1.id}/mark-paid`, 'd.lis', { method: 'card_terminal' })).json().error, 'company_pays');
  const payers = (await req('GET', `/api/persons/${e1}/payers?clubId=${centr}`, 'm.volkova')).json();
  assert.equal(payers.companies[0].name, 'ООО Ромашка');
  // счёт за месяц
  const period = new Date().toISOString().slice(0, 7);
  const inv = await req('POST', `/api/companies/${c.id}/invoices`, 'e.orlova', { period });
  assert.equal(inv.statusCode, 200, inv.body);
  assert.equal(inv.json().amountKop, 552500 + 2193000);
  assert.match(inv.json().number, /^СЧ-\d{4}-0001$/);
  assert.equal((await req('POST', `/api/companies/${c.id}/invoices`, 'e.orlova', { period })).statusCode, 400); // уже всё в счёте
  const pr = await req('GET', `/api/company-invoices/${inv.json().id}/print`, 'e.orlova');
  assert.match(pr.body, /ООО Ромашка/);
  assert.match(pr.body, /Сотрудник Первый/);
  const pay = await req('POST', `/api/company-invoices/${inv.json().id}/paid`, 'e.orlova');
  assert.equal(pay.json().charges, 2, pay.body);
  const st = await sql(`select status, paid_method from charges where company_id = $1`, [c.id]);
  assert.deepEqual([...new Set(st.map((x) => `${x.status}/${x.paid_method}`))], ['paid/bank_transfer']);
  // отчёт о посещениях
  await sql(`insert into visits(tenant_id, club_id, person_id, visited_at, source) select tenant_id, club_id, $1, now(), 'manual' from memberships where id = $2`, [e1, m1.id]);
  const d = (await req('GET', `/api/companies/${c.id}`, 'o.smirnov')).json();
  assert.equal(d.employees.find((x: { personId: string }) => x.personId === e1).visits, 1);
  assert.equal(d.invoices[0].status, 'paid');
  assert.equal((await req('POST', `/api/companies/${c.id}/employees/${d.employees[0].id}/remove`, 'm.volkova')).statusCode, 200);
  const list = (await req('GET', `/api/companies?clubId=${centr}`, 'd.lis')).json();
  assert.equal(list.items[0].employees, 1);
  assert.equal(list.items[0].unpaidKop, 0);
});
