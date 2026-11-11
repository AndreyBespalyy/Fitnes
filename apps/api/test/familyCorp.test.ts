// Семейные и корпоративные абонементы: семья со скидкой второму и оплатой разом, компания с сотрудниками, счёт и оплата по счёту.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { processCompanyInvoices } from '../src/modules/familyCorp.ts';

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

test('общий семейный абонемент: один платит, у каждого своё место, сроки и долг — общие', async () => {
  assert.match((await req('POST', '/api/products', 'o.smirnov', { clubId: centr, kind: 'visits', name: 'Семейный пакет', visitsCount: 10, priceKop: 100000, familySeats: 3 })).json().message, /только абонементом на срок/);
  const pr = await req('POST', '/api/products', 'o.smirnov', { clubId: centr, kind: 'term', name: 'Семейный месяц на троих', durationDays: 30, priceKop: 1_200_000, familySeats: 3 });
  assert.equal(pr.statusCode, 201, pr.body);
  assert.equal(pr.json().familySeats, 3);
  products = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json();
  const p = await lead('Отец Общий'); const s1 = await lead('Дочь Общая'); const s2 = await lead('Сын Общий'); const s3 = await lead('Мать Общая'); const x = await lead('Сосед Чужой');
  assert.match((await sell(p, 'Семейный месяц на троих')).json().message, /сначала создайте семью/);
  const g = (await req('POST', '/api/families', 'm.volkova', { clubId: centr, payerId: p })).json();
  for (const id of [s1, s2, s3]) await req('POST', `/api/families/${g.id}/members`, 'm.volkova', { personId: id });
  assert.match((await sell(p, 'Семейный месяц на троих', { familyPersonIds: [s1, x] })).json().message, /только членам семьи/);
  assert.match((await sell(p, 'Семейный месяц на троих', { familyPersonIds: [s1, s2, s3] })).json().message, /не больше 2/);
  assert.match((await sell(p, 'Месяц безлимит', { familyPersonIds: [s1] })).json().message, /только в общем семейном тарифе/);
  const payers = (await req('GET', `/api/persons/${p}/payers?clubId=${centr}`, 'm.volkova')).json();
  assert.deepEqual(payers.family.members.map((m: { name: string }) => m.name).sort(), ['Дочь Общая', 'Мать Общая', 'Сын Общий']);
  const sold = await sell(p, 'Семейный месяц на троих', { familyPersonIds: [s1, s2] });
  assert.equal(sold.statusCode, 201, sold.body);
  const main = sold.json().id;
  const ms = await sql(`select person_id, amount_kop, parent_membership_id, (select count(*)::int from charges c where c.membership_id = m.id) as ch from memberships m where m.id = $1 or m.parent_membership_id = $1 order by parent_membership_id nulls first`, [main]);
  assert.deepEqual(ms.map((m) => [Number(m.amount_kop), m.ch]), [[1_200_000, 1], [0, 0], [0, 0]], 'платит один, места без платежей');
  // Карточка члена семьи: место, без платежей, проход как у основного
  const seat = (await req('GET', `/api/persons/${s1}/memberships`, 'd.lis')).json()[0];
  assert.deepEqual([seat.seatOf.holderName, seat.charges.length, seat.access], ['Отец Общий', 0, true]);
  const own = (await req('GET', `/api/persons/${p}/memberships`, 'd.lis')).json()[0];
  assert.deepEqual([own.familySeats, own.seats.map((x: { name: string }) => x.name)], [3, ['Дочь Общая', 'Сын Общий']]);
  // Долг основного закрывает проход всем
  await sql(`update charges set due_on = current_date - 30 where membership_id = $1`, [main]);
  assert.equal((await req('GET', `/api/persons/${s1}/memberships`, 'd.lis')).json()[0].access, false);
  await sql(`update charges set due_on = current_date where membership_id = $1`, [main]);
  // Заморозка: только на основном, переходит на места
  assert.match((await req('POST', `/api/memberships/${seat.id}/freeze`, 'o.smirnov', { days: 7 })).json().message, /на основном абонементе/);
  const before = (await sql(`select ends_on::text as e from memberships where id = $1`, [seat.id]))[0].e;
  assert.equal((await req('POST', `/api/memberships/${main}/freeze`, 'o.smirnov', { days: 7 })).statusCode, 200);
  const after = (await sql(`select ends_on::text as e from memberships where id = $1`, [seat.id]))[0].e;
  assert.equal((new Date(after).getTime() - new Date(before).getTime()) / 86_400_000, 7);
  assert.equal((await req('GET', `/api/persons/${s1}/memberships`, 'd.lis')).json()[0].state, 'frozen');
  await req('POST', `/api/memberships/${main}/unfreeze`, 'o.smirnov');
  // Места: занято всё — сначала освободить
  assert.match((await req('POST', `/api/memberships/${main}/seats`, 'm.volkova', { personId: s3 })).json().message, /Все места заняты/);
  const s2seat = own.seats.find((x: { name: string }) => x.name === 'Сын Общий').id;
  assert.equal((await req('POST', `/api/memberships/${main}/seats/${s2seat}/remove`, 'm.volkova')).statusCode, 200);
  assert.equal((await req('POST', `/api/memberships/${main}/seats`, 'm.volkova', { personId: s3 })).statusCode, 200);
  assert.equal((await req('GET', `/api/persons/${s2}/memberships`, 'd.lis')).json()[0].state, 'cancelled');
  // Продление основного: места у тех же людей
  assert.match((await req('POST', '/api/memberships', 'm.volkova', { personId: s1, productId: prod('Семейный месяц на троих'), renewFromId: seat.id })).json().message, /продлевается основной/);
  const ren = (await sell(p, 'Семейный месяц на троих', { renewFromId: main })).json();
  const holders = await sql(`select pe.full_name from memberships m join persons pe on pe.id = m.person_id where m.parent_membership_id = $1 order by 1`, [ren.id]);
  assert.deepEqual(holders.map((h) => h.full_name), ['Дочь Общая', 'Мать Общая']);
  // Отмена основного отменяет места
  assert.equal((await req('POST', `/api/memberships/${ren.id}/cancel`, 'o.smirnov', { reason: 'передумали' })).statusCode, 200);
  assert.deepEqual((await sql(`select distinct status from memberships where parent_membership_id = $1`, [ren.id])).map((r) => r.status), ['cancelled']);
});

test('компания платит часть: доля компании в счёт, остальное сотрудник платит сам', async () => {
  assert.match((await req('POST', '/api/companies', 'o.smirnov', { clubId: centr, name: 'ООО Доля', sharePercent: 5 })).json().message, /от 10 до 100/);
  const c = (await req('POST', '/api/companies', 'o.smirnov', { clubId: centr, name: 'ООО Доля', inn: '7709876543', sharePercent: 60, discountPercent: 0, autoInvoice: true })).json();
  const e = await lead('Сотрудник Долевой');
  await req('POST', `/api/companies/${c.id}/employees`, 'm.volkova', { personId: e });
  assert.equal((await req('GET', `/api/persons/${e}/payers?clubId=${centr}`, 'm.volkova')).json().companies[0].sharePercent, 60);
  const m = (await sell(e, 'Месяц безлимит', { payer: 'company', companyId: c.id })).json();
  const ch = await sql(`select id, amount_kop, company_id, title from charges where membership_id = $1 order by amount_kop desc`, [m.id]);
  assert.deepEqual(ch.map((x) => [Number(x.amount_kop), x.company_id]), [[390000, c.id], [260000, null]]);
  assert.equal((await req('POST', `/api/charges/${ch[0].id}/mark-paid`, 'd.lis', { method: 'card_terminal' })).json().error, 'company_pays');
  assert.equal((await req('POST', `/api/charges/${ch[1].id}/mark-paid`, 'd.lis', { method: 'card_terminal' })).statusCode, 200, 'свою долю сотрудник платит на ресепшне');
});

test('счета компаниям сами в начале месяца, с НДС; о неоплаченном — одна задача', async () => {
  const le = (await req('GET', `/api/clubs/${centr}/legal-entity`, 'o.smirnov')).json().legalEntity ?? { fullName: 'ООО «Фитнес Центр»', inn: '7700000001' };
  assert.equal((await req('PUT', `/api/clubs/${centr}/legal-entity`, 'o.smirnov', { ...le, invoiceVat: '18' })).statusCode, 400);
  assert.equal((await req('PUT', `/api/clubs/${centr}/legal-entity`, 'o.smirnov', { ...le, invoiceVat: '20' })).statusCode, 200);
  const tenantId = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  const run = (today: string) => withCtx(t.pool, { tenantId, allClubs: true, clubIds: [] } as never, (db) => processCompanyInvoices(db, { tenantId, userId: null }, centr, today));
  const next = new Date(); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
  const first = `${next.toISOString().slice(0, 7)}-02`;
  assert.deepEqual(await run(first), { issued: 1, overdue: 0 }, 'только компания с автовыставлением');
  assert.deepEqual(await run(first), { issued: 0, overdue: 0 }, 'повторно не выставляется');
  const inv = (await sql(`select i.* from company_invoices i join companies c on c.id = i.company_id where c.name = 'ООО Доля'`))[0];
  assert.deepEqual([inv.auto, inv.vat_rate, Number(inv.amount_kop), Number(inv.vat_kop)], [true, 20, 390000, 65000]);
  assert.equal((await sql(`select count(*)::int as n from tasks where title like 'Отправить компании «ООО Доля» счёт%'`))[0].n, 1);
  const pr = (await req('GET', `/api/company-invoices/${inv.id}/print`, 'e.orlova')).body;
  assert.match(pr, /В том числе НДС 20 %/);
  assert.match(pr, /650,00 ₽/);
  // Срок оплаты прошёл
  const late = `${next.toISOString().slice(0, 7)}-28`;
  assert.deepEqual(await run(late), { issued: 0, overdue: 1 });
  assert.deepEqual(await run(late), { issued: 0, overdue: 0 }, 'одна задача на счёт');
  assert.match((await sql(`select title from tasks where id = $1`, [(await sql('select overdue_task_id from company_invoices where id = $1', [inv.id]))[0].overdue_task_id]))[0].title, /не оплатила счёт/);
  const d = (await req('GET', `/api/companies/${inv.company_id}`, 'o.smirnov')).json();
  assert.equal(d.company.autoInvoice, true);
  assert.equal(d.invoices[0].vatKop, 65000);
});
