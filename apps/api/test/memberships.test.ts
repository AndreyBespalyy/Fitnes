import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string }, sever: { id: string };
before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova', 'i.kotova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: ck['a.bespalyy'] })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
  sever = clubs.find((c: { name: string }) => c.name === 'Клуб «Север»');
});
after(async () => { await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const person = async (name: string) =>
  (await req('GET', `/api/persons?q=${encodeURIComponent(name)}`, 'a.bespalyy')).json()[0].id as string;
const product = async (clubId: string, name: string) =>
  (await req('GET', `/api/products?clubId=${clubId}`, 'a.bespalyy')).json().find((p: { name: string }) => p.name === name);
const newPerson = async (fullName: string, phone: string) =>
  (await req('POST', '/api/leads', 'd.lis', { clubId: centr.id, fullName, phone, sourceCode: 'walk_in' })).json().personId as string;

test('управляющий меняет настройки и тарифы своего клуба, но не чужого', async () => {
  const ok = await req('PUT', `/api/clubs/${centr.id}/membership-settings`, 'o.smirnov', { freezeMaxDaysPerYear: 45 });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().freezeMaxDaysPerYear, 45);
  const other = await req('PUT', `/api/clubs/${sever.id}/membership-settings`, 'o.smirnov', { freezeMaxDaysPerYear: 45 });
  assert.notEqual(other.statusCode, 200);
  const p = await req('POST', '/api/products', 'o.smirnov', { clubId: sever.id, kind: 'guest', name: 'Чужой', priceKop: 100 });
  assert.notEqual(p.statusCode, 201);
  const own = await req('POST', '/api/products', 'o.smirnov', { clubId: centr.id, kind: 'term', name: '3 месяца', durationDays: 90, priceKop: 1_500_000 });
  assert.equal(own.statusCode, 201);
  await req('PUT', `/api/clubs/${centr.id}/membership-settings`, 'o.smirnov', { freezeMaxDaysPerYear: 30 });
});

test('управляющий не создаёт клубы и сетевые роли; ресепшн не меняет тарифы', async () => {
  assert.equal((await req('POST', '/api/clubs', 'o.smirnov', { name: 'Клуб «Ещё»', salesModel: 'term' })).statusCode, 403);
  const s = await req('POST', '/api/staff', 'o.smirnov', { fullName: 'Пётр Сетевой', role: 'admin', clubId: centr.id });
  assert.notEqual(s.statusCode, 201);
  const m = await req('POST', '/api/staff', 'o.smirnov', { fullName: 'Пётр Менеджеров', role: 'manager', clubId: centr.id });
  assert.equal(m.statusCode, 201);
  const p = await product(centr.id, 'Месяц безлимит');
  assert.equal((await req('PATCH', `/api/products/${p.id}`, 'd.lis', { priceKop: 1 })).statusCode, 403);
  assert.equal((await req('PUT', `/api/clubs/${centr.id}/membership-settings`, 'm.volkova', { freezeMinDays: 1 })).statusCode, 403);
});

test('новая цена не меняет уже проданный абонемент', async () => {
  const pid = await newPerson('Цена Тестова', '+79001110001');
  const p = await product(centr.id, 'Месяц безлимит');
  const sold = await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: p.id });
  assert.equal(sold.statusCode, 201);
  await req('PATCH', `/api/products/${p.id}`, 'o.smirnov', { priceKop: 700_000 });
  const ms = (await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json();
  assert.equal(ms[0].amountKop, 650_000);
  assert.equal((await product(centr.id, 'Месяц безлимит')).priceKop, 700_000);
  assert.equal((await product(centr.id, 'Месяц безлимит')).prices.length, 2);
});

test('рассрочка: равные платежи раз в месяц, не больше разрешённого', async () => {
  const pid = await newPerson('Рассрочка Платёжная', '+79001110002');
  const p = await product(centr.id, 'Годовой безлимит');
  assert.equal((await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: p.id, installments: 4 })).statusCode, 400);
  const m = await product(centr.id, 'Месяц безлимит');
  assert.equal((await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: m.id, installments: 2 })).statusCode, 400);
  assert.equal((await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: p.id, installments: 3 })).statusCode, 201);
  const ms = (await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json();
  const sums = ms[0].charges.map((c: { amountKop: number }) => c.amountKop);
  assert.deepEqual(sums, [1_400_000, 1_400_000, 1_400_000]);
  assert.equal(ms[0].state, 'active');
});

test('заморозка: минимальный срок, годовой лимит, сдвиг окончания и разморозка', async () => {
  const pid = await newPerson('Заморозка Холодова', '+79001110003');
  const p = await product(centr.id, 'Годовой безлимит');
  const { id, endsOn } = (await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: p.id })).json();
  assert.equal((await req('POST', `/api/memberships/${id}/freeze`, 'd.lis', { days: 3 })).statusCode, 400);
  const f = await req('POST', `/api/memberships/${id}/freeze`, 'd.lis', { days: 20 });
  assert.equal(f.statusCode, 200);
  let m = (await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json()[0];
  assert.equal(m.state, 'frozen');
  assert.equal(m.access, false);
  assert.equal(m.endsOn > endsOn, true);
  assert.equal((await req('GET', `/api/persons/${pid}/access`, 'd.lis')).json().allowed, false);
  const u = (await req('POST', `/api/memberships/${id}/unfreeze`, 'd.lis')).json();
  assert.equal(u.returnedDays, 20);
  m = (await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json()[0];
  assert.equal(m.endsOn, endsOn);
  assert.equal(m.state, 'active');
  // Лимит 30 дней в год
  const startsOn = m.startsOn;
  const later = new Date(`${startsOn}T00:00:00Z`); later.setUTCDate(later.getUTCDate() + 40);
  assert.equal((await req('POST', `/api/memberships/${id}/freeze`, 'd.lis', { startsOn: later.toISOString().slice(0, 10), days: 31 })).statusCode, 400);
  // Менеджер не замораживает
  assert.equal((await req('POST', `/api/memberships/${id}/freeze`, 'm.volkova', { days: 10 })).statusCode, 403);
});

test('продление считается от даты окончания, а не от сегодня', async () => {
  const pid = await person('Алексей Громов');
  const cur = (await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json()[0];
  assert.equal(cur.state, 'active');
  const r = await req('POST', `/api/memberships/${cur.id}/renew`, 'd.lis', {});
  assert.equal(r.statusCode, 201);
  const d = new Date(`${cur.endsOn}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  assert.equal(r.json().startsOn, d.toISOString().slice(0, 10));
});

test('проход закрыт при долге по подписке дольше разрешённого и открывается после оплаты', async () => {
  const pid = await person('Тимур Ахметов');
  const s = (await login(t.app, 'a.morozova')).cookie!;
  const get = (url: string) => t.app.inject({ method: 'GET', url, cookies: s });
  let a = (await get(`/api/persons/${pid}/access`)).json();
  assert.equal(a.allowed, false);
  assert.match(a.reason, /Долг/);
  const m = (await get(`/api/persons/${pid}/memberships`)).json()[0];
  const due = m.charges.find((c: { status: string }) => c.status === 'due');
  const r = await t.app.inject({ method: 'POST', url: `/api/charges/${due.id}/mark-paid`, cookies: s, payload: { method: 'card_terminal' } });
  assert.equal(r.statusCode, 200);
  a = (await get(`/api/persons/${pid}/access`)).json();
  assert.equal(a.allowed, true);
  // Ресепшн Центра не видит клиента Севера
  assert.notEqual((await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json().length, 1);
});

test('демо-клиенты: действующий, истёкший, расторгнутый', async () => {
  const st = async (n: string) => (await req('GET', `/api/persons/${await person(n)}/memberships`, 'a.bespalyy')).json()[0].state;
  assert.equal(await st('Павел Рябов'), 'active');
  assert.equal(await st('Елена Миронова'), 'expired');
  assert.equal(await st('Ксения Лаптева'), 'cancelled');
  assert.equal(await st('Роман Фёдоров'), 'active');
});
