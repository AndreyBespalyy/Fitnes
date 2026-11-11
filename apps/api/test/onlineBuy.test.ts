// Покупка онлайн без менеджера: настройка, страница покупки, оплата, автоматическое оформление абонемента, договора, QR и задачи.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const form = (url: string, o: Record<string, string>) => t.app.inject({ method: 'POST', url, payload: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const PDF = Buffer.from('%PDF-1.4\n% договор-оферта\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF').toString('base64');
let centr = '';
let month = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  month = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json().find((p: { name: string }) => p.name === 'Месяц безлимит').id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('настройка: без договора-оферты и без тарифов не включить, ресепшн не настраивает', async () => {
  assert.match((await t.app.inject({ url: `/buy/${centr}` })).body, /Покупка недоступна/);
  assert.equal((await req('PUT', '/api/online-buy/settings', 'd.lis', { clubId: centr, enabled: true, productIds: [month] })).statusCode, 403);
  const noDoc = await req('PUT', '/api/online-buy/settings', 'o.smirnov', { clubId: centr, enabled: true, productIds: [month] });
  if ((await sql(`select 1 from club_documents where club_id = $1 and kind = 'contract' and is_current`, [centr])).length === 0) assert.match(noDoc.json().message, /договор-оферту/);
  assert.equal((await req('POST', `/api/clubs/${centr}/documents`, 'o.smirnov', { kind: 'contract', fileName: 'Оферта.pdf', dataBase64: PDF })).statusCode, 201);
  assert.equal((await req('PUT', '/api/online-buy/settings', 'o.smirnov', { clubId: centr, enabled: true, productIds: [] })).statusCode, 400);
  assert.equal((await req('PUT', '/api/online-buy/settings', 'o.smirnov', { clubId: centr, enabled: true, productIds: [month], note: 'Скидок онлайн нет' })).statusCode, 200);
  const s = (await req('GET', `/api/online-buy?clubId=${centr}`, 'd.lis')).json();
  assert.equal(s.settings.enabled, true);
  assert.equal(s.products.find((p: { id: string }) => p.id === month).sellOnline, true);
  assert.match(s.link, new RegExp(`/buy/${centr}$`));
});

test('покупка: страница, ошибки формы, оплата → абонемент, договор, QR, задача, сделка выиграна', async () => {
  const pageRes = await t.app.inject({ url: `/buy/${centr}` });
  assert.equal(pageRes.statusCode, 200);
  assert.match(pageRes.body, /Месяц безлимит/);
  assert.doesNotMatch(pageRes.body, /Годовой безлимит/); // не отмечен для продажи онлайн
  assert.match(pageRes.body, /договор-оферту/);
  const bad = await form(`/buy/${centr}`, { productId: month, name: 'Онлайн Покупатель', phone: '+79005558801', consent: '1' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /принять договор-оферту/);
  const ok = await form(`/buy/${centr}`, { productId: month, name: 'Онлайн Покупатель', phone: '+7 900 555-88-01', email: 'buyer@example.com', offer: '1', consent: '1' });
  assert.equal(ok.statusCode, 303, ok.body);
  const payUrl = ok.headers.location as string;
  assert.match(payUrl, /^\/pay\/[0-9a-f-]{36}$/);
  const person = (await sql(`select p.id from persons p join person_contacts c on c.person_id = p.id where c.value like '%9005558801%' limit 1`))[0].id;
  assert.equal((await sql('select count(*) from memberships where person_id = $1', [person]))[0].count, '0'); // до оплаты абонемента нет
  // повторная отправка формы — та же ссылка
  assert.equal((await form(`/buy/${centr}`, { productId: month, name: 'Онлайн Покупатель', phone: '+79005558801', offer: '1', consent: '1' })).headers.location, payUrl);
  const opId = payUrl.split('/').pop()!;
  await form(`/pay/${opId}/test`, { method: 'card', card: '4242424242424242', result: 'pay' });
  const back = await t.app.inject({ url: payUrl });
  assert.equal(back.statusCode, 303);
  const orderUrl = back.headers.location as string;
  const done = await t.app.inject({ url: orderUrl });
  assert.match(done.body, /абонемент оформлен/);
  assert.match(done.body, /<svg/);
  assert.match(done.body, /QR[0-9A-F]{12}/);
  const m = await sql(`select m.id, m.status, m.product_name from memberships m where m.person_id = $1`, [person]);
  assert.equal(m.length, 1);
  const ch = (await sql(`select status, paid_method from charges where membership_id = $1`, [m[0].id]))[0];
  assert.deepEqual([ch.status, ch.paid_method], ['paid', 'online']);
  assert.equal(Number((await sql(`select count(*) from payments where person_id = $1 and direction = 'in'`, [person]))[0].count), 1);
  const ct = (await sql(`select status, sign_method, signed_docs_sha256 from contracts where membership_id = $1`, [m[0].id]))[0];
  assert.deepEqual([ct.status, ct.sign_method], ['signed', 'online_offer']);
  assert.match(ct.signed_docs_sha256, /^contract:v\d+:[0-9a-f]{64}/);
  assert.equal((await sql(`select count(*) from access_credentials where person_id = $1 and kind = 'qr' and status = 'active'`, [person]))[0].count, '1');
  assert.match((await sql(`select title from tasks where person_id = $1 order by created_at desc limit 1`, [person]))[0].title, /Купил\(а\) онлайн «Месяц безлимит»/);
  assert.equal((await sql(`select status from opportunities where person_id = $1`, [person]))[0].status, 'won');
  await t.app.inject({ url: orderUrl }); // повторное открытие ничего не создаёт
  assert.equal((await sql('select count(*) from memberships where person_id = $1', [person]))[0].count, '1');
  const list = (await req('GET', `/api/online-buy?clubId=${centr}`, 'o.smirnov')).json();
  assert.equal(list.orders[0].status, 'paid');
  assert.equal(list.stats.paid, 1);
});

test('банк отказал: заказ закрыт, абонемента нет, можно купить заново; выключенная продажа недоступна', async () => {
  const ok = await form(`/buy/${centr}`, { productId: month, name: 'Отказ Банка', phone: '+79005558802', offer: '1', consent: '1' });
  const opId = (ok.headers.location as string).split('/').pop()!;
  await form(`/pay/${opId}/test`, { method: 'card', card: '4000000000000002', result: 'pay' });
  const order = await t.app.inject({ url: (await t.app.inject({ url: `/pay/${opId}` })).headers.location as string });
  assert.match(order.body, /Оплата не прошла/);
  assert.match(order.body, /Купить заново/);
  const person = (await sql(`select person_id from online_orders where online_payment_id = $1`, [opId]))[0].person_id;
  assert.equal((await sql('select count(*) from memberships where person_id = $1', [person]))[0].count, '0');
  await req('PUT', '/api/online-buy/settings', 'o.smirnov', { clubId: centr, enabled: false });
  assert.match((await t.app.inject({ url: `/buy/${centr}` })).body, /Покупка недоступна/);
  assert.match((await form(`/buy/${centr}`, { productId: month, name: 'Поздно', phone: '+79005558803', offer: '1', consent: '1' })).body, /Покупка недоступна/);
});
