// Шаг 18, часть 4. Тиражирование: чек-лист подключения клуба, демо-клуб, поддержка, ограничения тарифа.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { workDay } from '../src/modules/onboarding.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'i.kotova', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('рабочие дни подключения считаются без выходных', () => {
  assert.equal(workDay('2026-11-09', 1), '2026-11-09'); // понедельник
  assert.equal(workDay('2026-11-09', 10), '2026-11-20');
  assert.equal(workDay('2026-11-14', 1), '2026-11-16'); // старт в субботу → понедельник
});

let newClub = '';
test('новый клуб подключается по чек-листу: система сама отмечает сделанное, ручные пункты требуют решения', async () => {
  const c = (await req('POST', '/api/clubs', 'a.bespalyy', { name: 'Клуб «Запад»', salesModel: 'term' })).json();
  newClub = c.id;
  let s = (await req('GET', `/api/onboarding/${newClub}`, 'a.bespalyy')).json();
  assert.equal(s.total, 17);
  const st = (code: string) => s.items.find((i: { code: string }) => i.code === code).status;
  assert.equal(st('pipelines'), 'done'); // воронки создаются по модели продаж
  assert.equal(st('card'), 'todo');      // адреса нет
  assert.equal(st('legal'), 'todo');
  assert.equal(s.next.code, 'card');
  // Адрес появился — пункт отметился сам
  await req('PATCH', `/api/clubs/${newClub}`, 'a.bespalyy', { address: 'Москва, ул. Западная, 1' });
  s = (await req('GET', `/api/onboarding/${newClub}`, 'a.bespalyy')).json();
  assert.equal(st('card'), 'done');
  assert.equal(s.items.find((i: { code: string }) => i.code === 'card').by, 'система');
  // Автоматический пункт вручную «сделанным» не отметить, обязательный — не пропустить
  assert.equal((await req('POST', `/api/onboarding/${newClub}/items/legal`, 'a.bespalyy', { status: 'done' })).statusCode, 400);
  assert.equal((await req('POST', `/api/onboarding/${newClub}/items/legal`, 'a.bespalyy', { status: 'skipped', note: 'потом' })).statusCode, 400);
  // Необязательный пункт пропускается с причиной
  assert.equal((await req('POST', `/api/onboarding/${newClub}/items/access`, 'a.bespalyy', { status: 'skipped' })).statusCode, 400);
  s = (await req('POST', `/api/onboarding/${newClub}/items/access`, 'a.bespalyy', { status: 'skipped', note: 'Турникетов нет, вход по администратору' })).json();
  assert.equal(st('access'), 'skipped');
  s = (await req('POST', `/api/onboarding/${newClub}/items/training`, 'a.bespalyy', { status: 'done', note: 'Провели 2 занятия' })).json();
  assert.equal(st('training'), 'done');
  // Срок подключения — 10 рабочих дней от старта, просроченные пункты видны
  s = (await req('PATCH', `/api/onboarding/${newClub}`, 'a.bespalyy', { start: '2026-10-01' })).json();
  assert.equal(s.finish, '2026-10-14');
  assert.ok(s.overdue > 0);
  assert.ok(s.items.find((i: { code: string }) => i.code === 'legal').overdue);
  // Журнал
  assert.ok((await sql(`select 1 from audit_log where action = 'onboarding.marked' and object_id = $1`, [newClub])).length >= 2);
  // Менеджеру чек-лист не виден
  assert.equal((await req('GET', `/api/onboarding/${newClub}`, 'm.volkova')).statusCode, 403);
  const all = (await req('GET', '/api/onboarding', 'a.bespalyy')).json();
  assert.ok(all.clubs.some((x: { clubId: string }) => x.clubId === newClub));
});

test('демо-клуб: учебные данные, не попадает в цифры сети и закрывается', async () => {
  assert.equal((await req('POST', '/api/clubs/demo', 'o.smirnov', { salesModel: 'term' })).statusCode, 403);
  const r = await req('POST', '/api/clubs/demo', 'a.bespalyy', { salesModel: 'term' });
  assert.equal(r.statusCode, 201, r.body);
  const demo = r.json();
  assert.ok(demo.leads > 20 && demo.sold > 0, JSON.stringify(demo));
  assert.equal((await req('POST', '/api/clubs/demo', 'a.bespalyy', { salesModel: 'term' })).statusCode, 400);
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  assert.ok(clubs.find((c: { id: string; isDemo: boolean }) => c.id === demo.id).isDemo);
  const persons = await sql(`select full_name from persons where home_club_id = $1`, [demo.id]);
  assert.ok(persons.every((p) => p.full_name.endsWith('(демо)')));
  // Рабочий стол сети без демо-клуба, по самому демо-клубу — с цифрами
  const net = (await req('GET', '/api/dash/widget/clubs?clubId=all', 'a.bespalyy')).json();
  assert.ok(!JSON.stringify(net).includes(demo.name), 'демо-клуб не должен попадать в цифры сети');
  // Закрытие: данные не удаляются, клуб скрывается, можно создать новый
  assert.equal((await req('POST', `/api/clubs/${newClub}/close-demo`, 'a.bespalyy')).statusCode, 400);
  assert.equal((await req('POST', `/api/clubs/${demo.id}/close-demo`, 'a.bespalyy')).statusCode, 200);
  assert.ok(!(await req('GET', '/api/clubs', 'a.bespalyy')).json().some((c: { id: string }) => c.id === demo.id));
  assert.ok((await sql(`select count(*)::int as n from memberships where club_id = $1`, [demo.id]))[0].n > 0);
  assert.equal((await req('POST', '/api/clubs/demo', 'a.bespalyy', { salesModel: 'term' })).statusCode, 201);
});

test('ограничения тарифа: договор меняет только оператор платформы, лимит клубов и сотрудников проверяется', async () => {
  // Из приложения договор не записать
  const c = await t.pool.connect();
  try {
    await c.query('begin');
    await assert.rejects(c.query(`insert into tenant_contracts(tenant_id, number, signed_on, plan) select id, 'X', now(), 'X' from tenants limit 1`));
    await c.query('rollback');
  } finally { c.release(); }
  const active = (await sql(`select count(*)::int as n from clubs where status = 'active' and not is_demo`))[0].n;
  const users = (await sql(`select count(*)::int as n from users where status = 'active'`))[0].n;
  await sql(`insert into tenant_contracts(tenant_id, number, signed_on, plan, clubs_limit, users_limit) select id, 'П-1', '2026-11-10', 'Пилот', $1, $2 from tenants limit 1`, [active, users]);
  const cr = (await req('GET', '/api/platform/contract', 'a.bespalyy')).json();
  assert.equal(cr.contract.plan, 'Пилот');
  assert.equal(cr.usage.clubs, active);
  const r = await req('POST', '/api/clubs', 'a.bespalyy', { name: 'Клуб «Восток»', salesModel: 'term' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /тарифу «Пилот»/);
  // Демо-клуб в ограничение не входит
  const d = await req('POST', '/api/clubs/demo', 'a.bespalyy', { salesModel: 'subscription' });
  assert.equal(d.statusCode, 201, d.body);
  const s = await req('POST', '/api/staff', 'a.bespalyy', { fullName: 'Лишний Сотрудник', role: 'manager', clubId: newClub });
  assert.equal(s.statusCode, 400);
  await sql(`delete from tenant_contracts`);
  assert.equal((await req('POST', '/api/staff', 'a.bespalyy', { fullName: 'Нужный Сотрудник', role: 'manager', clubId: newClub })).statusCode, 201);
});

test('поддержка: сотрудник пишет, администратор системы отвечает и передаёт разработчикам', async () => {
  const r = await req('POST', '/api/support', 'm.volkova', { subject: 'Не печатается договор', body: 'Нажимаю «Печать», ничего не происходит', kind: 'bug', page: 'tariffs', clientInfo: 'web 1.0; Safari' });
  assert.equal(r.statusCode, 201, r.body);
  const tk = r.json();
  assert.equal(tk.number, 1);
  assert.equal(tk.status, 'open');
  // Другой менеджер не видит, управляющий без права поддержки — тоже
  assert.equal((await req('GET', `/api/support/${tk.id}`, 'o.smirnov')).statusCode, 404);
  assert.ok((await req('GET', '/api/support', 'i.kotova')).json().some((x: { id: string }) => x.id === tk.id));
  assert.equal((await req('POST', `/api/support/${tk.id}/messages`, 'i.kotova', { body: 'Проверьте, разрешены ли всплывающие окна' })).statusCode, 200);
  let v = (await req('GET', `/api/support/${tk.id}`, 'm.volkova')).json();
  assert.equal(v.status, 'answered');
  assert.equal(v.messagesList.length, 2);
  assert.equal(v.messagesList[1].fromSupport, true);
  // Менеджер ответил — снова открыто; передать разработчикам может только администратор
  await req('POST', `/api/support/${tk.id}/messages`, 'm.volkova', { body: 'Разрешены, не помогло' });
  assert.equal((await req('POST', `/api/support/${tk.id}/status`, 'm.volkova', { escalate: true })).statusCode, 403);
  assert.equal((await req('POST', `/api/support/${tk.id}/status`, 'i.kotova', { escalate: true })).statusCode, 200);
  v = (await req('GET', `/api/support/${tk.id}`, 'm.volkova')).json();
  assert.equal(v.status, 'open');
  assert.ok(v.escalatedAt);
  assert.equal((await req('POST', `/api/support/${tk.id}/status`, 'm.volkova', { status: 'closed' })).statusCode, 200);
  // Удалить обращение из приложения нельзя
  const c = await t.pool.connect();
  try { await assert.rejects(c.query('delete from support_messages')); } finally { c.release(); }
});
