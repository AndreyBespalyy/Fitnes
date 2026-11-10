import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login, PASSWORD } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
before(async () => { t = await setupTestApp(); });
after(async () => { await t.app.close(); await t.pool.end(); });

const get = (url: string, cookies?: Record<string, string>) => t.app.inject({ method: 'GET', url, cookies });
const post = (url: string, payload: unknown, cookies?: Record<string, string>) => t.app.inject({ method: 'POST', url, payload: payload as object, cookies });

test('вход по логину и паролю, выход', async () => {
  const { res, cookie } = await login(t.app, 'a.bespalyy');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().roles[0].code, 'owner');
  assert.equal((await get('/api/auth/me', cookie)).statusCode, 200);
  await post('/api/auth/logout', {}, cookie);
  assert.equal((await get('/api/auth/me', cookie)).statusCode, 401);
});

test('без входа данные недоступны', async () => {
  assert.equal((await get('/api/clubs')).statusCode, 401);
});

test('неверный пароль и блокировка после 5 попыток', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await login(t.app, 'a.kim', 'wrong-password')).res.statusCode, 401);
  assert.equal((await login(t.app, 'a.kim', 'wrong-password')).res.statusCode, 401);
  const locked = await login(t.app, 'a.kim');
  assert.equal(locked.res.statusCode, 423, 'правильный пароль не пускает во время блокировки');
});

test('собственник видит оба клуба, менеджер «Центра» только свой', async () => {
  const owner = await login(t.app, 'a.bespalyy');
  const all = (await get('/api/clubs', owner.cookie)).json();
  assert.equal(all.length, 2);
  const mgr = await login(t.app, 'm.volkova');
  const mine = (await get('/api/clubs', mgr.cookie)).json();
  assert.deepEqual(mine.map((c: { name: string }) => c.name), ['Клуб «Центр»']);
  const persons = (await get('/api/persons', mgr.cookie)).json();
  assert.ok(persons.length > 0);
  assert.ok(persons.every((p: { clubName: string }) => p.clubName === 'Клуб «Центр»'), 'клиенты «Севера» не видны');
  const sever = all.find((c: { name: string }) => c.name === 'Клуб «Север»');
  const direct = (await get(`/api/persons?clubId=${sever.id}`, mgr.cookie)).json();
  assert.equal(direct.length, 0, 'запрос чужого клуба напрямую ничего не отдаёт');
});

test('изоляция работает на уровне базы, даже без фильтров в коде', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL!.replace(/\/fitnes$/, '/fitnes_test') });
  await c.connect();
  assert.equal((await c.query('select count(*)::int as n from persons')).rows[0].n, 0, 'без контекста строк нет');
  await c.end();
});

test('менеджер не может создавать клубы и сотрудников', async () => {
  const mgr = await login(t.app, 'm.volkova');
  assert.equal((await post('/api/clubs', { name: 'X', salesModel: 'term' }, mgr.cookie)).statusCode, 403);
  assert.equal((await get('/api/staff', mgr.cookie)).statusCode, 403);
});

test('администратор создаёт клуб: модель продаж обязательна', async () => {
  const adm = await login(t.app, 'i.kotova');
  const noModel = await post('/api/clubs', { name: 'Клуб «Юг»' }, adm.cookie);
  assert.equal(noModel.statusCode, 400);
  assert.equal(noModel.json().error, 'sales_model_required');
  const ok = await post('/api/clubs', { name: 'Клуб «Юг»', address: 'Москва', salesModel: 'subscription' }, adm.cookie);
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().salesModel, 'subscription');
  const dup = await post('/api/clubs', { name: 'клуб «юг»', salesModel: 'term' }, adm.cookie);
  assert.equal(dup.statusCode, 400);
});

test('смена модели продаж пишется в историю и журнал', async () => {
  const adm = await login(t.app, 'i.kotova');
  const club = (await get('/api/clubs', adm.cookie)).json().find((c: { name: string }) => c.name === 'Клуб «Центр»');
  const res = await t.app.inject({ method: 'PATCH', url: `/api/clubs/${club.id}`, payload: { salesModel: 'subscription' }, cookies: adm.cookie });
  assert.equal(res.json().salesModel, 'subscription');
  const hist = (await get(`/api/clubs/${club.id}/model-history`, adm.cookie)).json();
  assert.equal(hist[0].oldModel, 'term');
  assert.equal(hist[0].newModel, 'subscription');
  assert.equal(hist[0].applyFrom, 'next_period');
  await t.app.inject({ method: 'PATCH', url: `/api/clubs/${club.id}`, payload: { salesModel: 'term' }, cookies: adm.cookie });
});

test('новый сотрудник получает временный пароль и обязан его сменить', async () => {
  const adm = await login(t.app, 'i.kotova');
  const clubs = (await get('/api/clubs', adm.cookie)).json();
  const res = await post('/api/staff', { fullName: 'Пётр Носов', role: 'manager', clubId: clubs[0].id }, adm.cookie);
  assert.equal(res.statusCode, 201);
  const { user, tempPassword } = res.json();
  assert.equal(user.login, 'p.nosov');
  const first = await login(t.app, 'p.nosov', tempPassword);
  assert.equal(first.res.json().mustChangePassword, true);
  assert.equal((await get('/api/clubs', first.cookie)).statusCode, 403, 'до смены пароля работать нельзя');
  const weak = await post('/api/auth/change-password', { currentPassword: tempPassword, newPassword: '123' }, first.cookie);
  assert.equal(weak.statusCode, 400);
  const ch = await post('/api/auth/change-password', { currentPassword: tempPassword, newPassword: 'Nosov-secure-2026' }, first.cookie);
  assert.equal(ch.statusCode, 200);
  assert.equal((await get('/api/clubs', first.cookie)).statusCode, 200);
  // Сетевой роли клуб не нужен, клубной — обязателен
  assert.equal((await post('/api/staff', { fullName: 'Без Клуба', role: 'rop' }, adm.cookie)).statusCode, 400);
  // Администратор не может назначить собственника
  assert.equal((await post('/api/staff', { fullName: 'Второй Собственник', role: 'owner' }, adm.cookie)).statusCode, 403);
});

test('блокировка сотрудника закрывает его сессии и вход', async () => {
  const adm = await login(t.app, 'i.kotova');
  const desk = await login(t.app, 'd.lis');
  assert.equal((await get('/api/auth/me', desk.cookie)).statusCode, 200);
  const staff = (await get('/api/staff', adm.cookie)).json();
  const target = staff.find((s: { login: string }) => s.login === 'd.lis');
  assert.equal((await post(`/api/staff/${target.id}/block`, {}, adm.cookie)).json().status, 'blocked');
  assert.equal((await get('/api/auth/me', desk.cookie)).statusCode, 401, 'открытая сессия закрыта');
  assert.equal((await login(t.app, 'd.lis')).res.statusCode, 403);
  const owner = staff.find((s: { login: string }) => s.login === 'a.bespalyy');
  assert.equal((await post(`/api/staff/${owner.id}/block`, {}, adm.cookie)).statusCode, 403, 'собственника блокировать нельзя');
  await post(`/api/staff/${target.id}/unblock`, {}, adm.cookie);
  assert.equal((await login(t.app, 'd.lis', PASSWORD)).res.statusCode, 200);
});

test('управляющий видит только сотрудников своего клуба', async () => {
  const gm = await login(t.app, 's.pavlov');
  const staff = (await get('/api/staff', gm.cookie)).json();
  assert.ok(staff.length > 0);
  assert.ok(staff.every((s: { assignments: { clubName: string | null }[] }) => s.assignments.some((a) => a.clubName === 'Клуб «Север»')));
});

test('журнал аудита нельзя изменить из приложения', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL!.replace(/\/fitnes$/, '/fitnes_test') });
  await c.connect();
  await assert.rejects(c.query('delete from audit_log'), /permission denied/);
  await c.end();
});
