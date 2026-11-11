// Кабинет оператора платформы: отдельный вход, подключение сети, договор и лимиты, счета, приостановка, поддержка.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
const u = new URL(process.env.OWNER_DATABASE_URL!); u.pathname = '/fitnes_test';
process.env.PLATFORM_DATABASE_URL = u.toString();
const { setupTestApp, login } = await import('./helpers.ts');
const { hashPassword } = await import('../src/passwords.ts');

let t: Awaited<ReturnType<typeof setupTestApp>>;
let op: Record<string, string> = {};
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const preq = (method: string, url: string, payload?: unknown, cookies = op) => t.app.inject({ method: method as 'GET', url, cookies, payload: payload as object });
let tenant = ''; let owner = ''; let ownerPw = '';

before(async () => {
  t = await setupTestApp();
  await sql(`insert into platform_operators(login, full_name, password_hash) values ('ops', 'Оператор Платформы', $1)`, [await hashPassword('Temp-Pass-123')]);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('вход оператора: отдельно от сетей, временный пароль нужно сменить', async () => {
  assert.equal((await preq('GET', '/api/platform/tenants', undefined, {})).statusCode, 401);
  // Сотрудник сети в кабинет оператора не попадает
  const staff = (await login(t.app, 'a.bespalyy')).cookie!;
  assert.equal((await t.app.inject({ url: '/api/platform/tenants', cookies: staff })).statusCode, 401);
  assert.equal((await preq('POST', '/api/platform/login', { login: 'ops', password: 'wrong' }, {})).statusCode, 401);
  const r = await preq('POST', '/api/platform/login', { login: 'ops', password: 'Temp-Pass-123' }, {});
  assert.equal(r.json().mustChange, true);
  op = { psid: r.cookies.find((c) => c.name === 'psid')!.value };
  assert.equal((await preq('GET', '/api/platform/tenants')).json().error, 'must_change_password');
  assert.equal((await preq('POST', '/api/platform/password', { current: 'Temp-Pass-123', newPassword: 'Kabinet-Platformy-2026' })).statusCode, 200);
  const list = (await preq('GET', '/api/platform/tenants')).json();
  assert.equal(list[0].name, 'Демо-сеть клубов');
  assert.equal(list[0].clubs, 2);
  // Приложение сетей не видит учётные записи операторов
  await assert.rejects(t.pool.query('select * from platform_operators'), /permission denied/);
});

test('подключение новой сети: собственник входит с временным паролем и видит пустую сеть', async () => {
  assert.match((await preq('POST', '/api/platform/tenants', { name: 'Фитнес Юг', ownerLogin: 'a.bespalyy', ownerName: 'Иван Юг' })).json().message, /логин уже занят/);
  const r = await preq('POST', '/api/platform/tenants', { name: 'Фитнес Юг', ownerLogin: 'i.yug', ownerName: 'Иван Югов', ownerPhone: '+79001112233' });
  assert.equal(r.statusCode, 201, r.body);
  ({ id: tenant, ownerLogin: owner, tempPassword: ownerPw } = r.json());
  assert.match(ownerPw, /^[A-Za-z2-9]{12}$/);
  const l = await login(t.app, owner, ownerPw);
  assert.equal(l.res.statusCode, 200);
  const me = (await t.app.inject({ url: '/api/auth/me', cookies: l.cookie })).json();
  assert.equal(me.mustChangePassword, true);
  assert.equal((await sql('select count(*)::int as n from lead_sources where tenant_id = $1', [tenant]))[0].n > 0, true);
  assert.equal((await sql('select count(*)::int as n from persons where tenant_id = $1', [tenant]))[0].n, 0, 'данные других сетей не копируются');
});

test('договор и лимиты тарифа действуют в сети', async () => {
  assert.match((await preq('PUT', `/api/platform/tenants/${tenant}/contract`, { number: 'П-7', plan: 'Старт' })).json().message, /дату договора/);
  assert.equal((await preq('PUT', `/api/platform/tenants/${tenant}/contract`, { number: 'П-7', signedOn: '2026-11-01', plan: 'Старт', clubsLimit: 1, usersLimit: 5, feeKop: 1_500_000 })).statusCode, 200);
  const d = (await preq('GET', `/api/platform/tenants/${tenant}`)).json();
  assert.deepEqual([d.plan, d.clubsLimit, d.feeKop, d.owners[0].login], ['Старт', 1, 1_500_000, 'i.yug']);
  // Собственник сети: после смены пароля добавляет один клуб, второй — уже нет
  const l = await login(t.app, owner, ownerPw);
  await t.app.inject({ method: 'POST', url: '/api/auth/change-password', cookies: l.cookie, payload: { currentPassword: ownerPw, newPassword: 'Yug-Owner-2026!' } });
  const c2 = (await login(t.app, owner, 'Yug-Owner-2026!')).cookie!;
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/clubs', cookies: c2, payload: { name: 'Юг-1', salesModel: 'term' } })).statusCode, 201);
  const second = await t.app.inject({ method: 'POST', url: '/api/clubs', cookies: c2, payload: { name: 'Юг-2', salesModel: 'term' } });
  assert.match(second.json().message, /По тарифу «Старт» можно подключить клубов: 1/);
  const clubs = (await preq('GET', `/api/platform/tenants/${tenant}`)).json().clubsList;
  assert.deepEqual(clubs.map((c: { name: string }) => c.name), ['Юг-1']);
});

test('счета: ежемесячно по договору, без дублей, оплата и аннулирование, сеть видит свои', async () => {
  const m = await preq('POST', '/api/platform/invoices/monthly', { month: '2026-11' });
  assert.equal(m.json().issued, 1, 'только сети с платой по договору');
  assert.equal((await preq('POST', '/api/platform/invoices/monthly', { month: '2026-11' })).json().issued, 0, 'повторно не выставляется');
  const inv = (await preq('GET', `/api/platform/tenants/${tenant}`)).json().invoices[0];
  assert.deepEqual([inv.periodFrom, inv.periodTo, inv.amountKop, inv.status], ['2026-11-01', '2026-11-30', 1_500_000, 'issued']);
  assert.match(inv.number, /^СЧ-2026-\d{4}$/);
  assert.match((await preq('POST', `/api/platform/invoices/${inv.id}/paid`, {})).json().message, /как пришла оплата/);
  assert.equal((await preq('POST', `/api/platform/invoices/${inv.id}/paid`, { note: 'п/п 15 от 12.11' })).statusCode, 200);
  assert.match((await preq('POST', `/api/platform/invoices/${inv.id}/cancel`, { reason: 'ошибка' })).json().message, /уже оплачен/);
  const dec = (await preq('POST', `/api/platform/tenants/${tenant}/invoices`, { month: '2026-12', amountKop: 700_000 })).json();
  assert.equal((await preq('POST', `/api/platform/invoices/${dec.id}/cancel`, { reason: 'Скидка на декабрь' })).statusCode, 200);
  assert.equal((await preq('POST', `/api/platform/tenants/${tenant}/invoices`, { month: '2026-12' })).statusCode, 201, 'после аннулирования можно выставить заново');
  const own = (await login(t.app, owner, 'Yug-Owner-2026!')).cookie!;
  const mine = (await t.app.inject({ url: '/api/platform-invoices', cookies: own })).json();
  assert.deepEqual(mine.map((i: { periodFrom: string; status: string }) => [i.periodFrom, i.status]), [['2026-12-01', 'issued'], ['2026-11-01', 'paid']]);
  // Другая сеть чужих счетов не видит
  assert.deepEqual((await t.app.inject({ url: '/api/platform-invoices', cookies: (await login(t.app, 'a.bespalyy')).cookie })).json(), []);
  assert.equal((await sql(`select count(*)::int as n from audit_log where tenant_id = $1 and action like 'platform.invoice%'`, [tenant]))[0].n, 5);
});

test('приостановка доступа: вход и открытые сессии сети перестают работать, возобновление', async () => {
  const own = (await login(t.app, owner, 'Yug-Owner-2026!')).cookie!;
  assert.match((await preq('POST', `/api/platform/tenants/${tenant}/status`, { status: 'suspended' })).json().message, /причину/);
  assert.equal((await preq('POST', `/api/platform/tenants/${tenant}/status`, { status: 'suspended', reason: 'Долг за 2 месяца' })).statusCode, 200);
  assert.equal((await t.app.inject({ url: '/api/auth/me', cookies: own })).statusCode, 401);
  assert.match((await login(t.app, owner, 'Yug-Owner-2026!')).res.json().message, /приостановлен/);
  // Другие сети работают
  assert.equal((await login(t.app, 'a.bespalyy')).res.statusCode, 200);
  await preq('POST', `/api/platform/tenants/${tenant}/status`, { status: 'active' });
  assert.equal((await login(t.app, owner, 'Yug-Owner-2026!')).res.statusCode, 200);
});

test('поддержка: обращения всех сетей и ответ оператора', async () => {
  const staff = (await login(t.app, 'o.smirnov')).cookie!;
  const tk = (await t.app.inject({ method: 'POST', url: '/api/support', cookies: staff, payload: { subject: 'Не печатается чек', body: 'Касса пишет ошибку', kind: 'bug' } })).json();
  const list = (await preq('GET', '/api/platform/support?all=1')).json();
  const row = list.find((x: { subject: string }) => x.subject === 'Не печатается чек');
  assert.equal(row.tenantName, 'Демо-сеть клубов');
  const card = (await preq('GET', `/api/platform/support/${row.id}`)).json();
  assert.equal(card.messages[0].body, 'Касса пишет ошибку');
  assert.equal((await preq('POST', `/api/platform/support/${row.id}/answer`, { text: 'Обновите драйвер кассы' })).statusCode, 200);
  const seen = (await t.app.inject({ url: `/api/support/${tk.id ?? row.id}`, cookies: staff })).json();
  assert.equal(seen.status, 'answered');
  assert.ok(JSON.stringify(seen).includes('Обновите драйвер кассы'));
});

test('выход оператора закрывает сессию', async () => {
  await preq('POST', '/api/platform/logout');
  assert.equal((await preq('GET', '/api/platform/tenants')).statusCode, 401);
});
