import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { inflateRawSync } from 'node:zlib';
import { setupTestApp, login } from './helpers.ts';
import { seedDemoHistory } from '../db/scripts/demoHistory.ts';
import type { Db } from '../src/db.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; let c2: string;
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const uid = async (login: string) => (await sql('select id from users where login = $1', [login]))[0].id as string;
const month = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 's.pavlov', 'o.astafeva', 'm.volkova', 'i.zuev', 'd.lis', 'e.orlova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  c1 = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  c2 = clubs.find((c: { name: string }) => c.name.includes('Север')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('рабочий стол: стандартные наборы ролей, свой набор, права на виджеты', async () => {
  const own = (await req('GET', '/api/dash/layout', 'a.bespalyy')).json();
  assert.ok(own.widgets.includes('clubs'));
  assert.equal(own.canSetRoleDefaults, true);
  const mgr = (await req('GET', '/api/dash/layout', 'm.volkova')).json();
  assert.deepEqual(mgr.widgets, ['my_plan', 'my_kpi']);
  assert.ok(!mgr.available.some((w: { id: string }) => w.id === 'day'));
  assert.equal((await req('GET', '/api/dash/widget/day', 'm.volkova')).statusCode, 403);
  // управляющий не видит «сравнение клубов» (только свой клуб) и не задаёт наборы для ролей сети
  const gm = (await req('GET', '/api/dash/layout', 'o.smirnov')).json();
  assert.ok(!gm.available.some((w: { id: string }) => w.id === 'clubs'));
  assert.equal((await req('PUT', '/api/dash/role-layout', 'o.smirnov', { role: 'manager', widgets: ['my_plan'] })).statusCode, 403);
  // свой набор и возврат стандартного
  assert.equal((await req('PUT', '/api/dash/layout', 'm.volkova', { widgets: ['day'] })).statusCode, 400);
  assert.equal((await req('PUT', '/api/dash/layout', 'm.volkova', { widgets: ['my_kpi'] })).statusCode, 200);
  assert.deepEqual((await req('GET', '/api/dash/layout', 'm.volkova')).json().widgets, ['my_kpi']);
  await req('PUT', '/api/dash/layout', 'm.volkova', { widgets: null });
  // собственник меняет стандартный набор менеджера
  assert.equal((await req('PUT', '/api/dash/role-layout', 'a.bespalyy', { role: 'manager', widgets: ['my_kpi', 'my_plan'] })).statusCode, 200);
  assert.deepEqual((await req('GET', '/api/dash/layout', 'i.zuev')).json().widgets, ['my_kpi', 'my_plan']);
});

test('план клуба и менеджеров: права, проверки, клиенты через средний чек, план-факт финансов', async () => {
  const m = month();
  const volkova = await uid('m.volkova');
  const zuev = await uid('i.zuev');
  const body = { clubId: c1, month: m, club: { new: { amountKop: 10_000_000, avgCheckKop: 650_000 } }, managers: { [volkova]: { new: { amountKop: 7_000_000 } } } };
  assert.equal((await req('PUT', '/api/plans', 'm.volkova', body)).statusCode, 403);
  assert.equal((await req('PUT', '/api/plans', 'o.astafeva', body)).statusCode, 403);
  assert.equal((await req('PUT', '/api/plans', 'o.smirnov', { ...body, managers: { [zuev]: { new: { amountKop: 1 } } } })).statusCode, 400);
  assert.equal((await req('PUT', '/api/plans', 'o.smirnov', { ...body, club: { new: { amountKop: -5 } } })).statusCode, 400);
  assert.equal((await req('PUT', '/api/plans', 's.pavlov', body)).statusCode, 400); // чужой клуб не виден
  assert.equal((await req('PUT', '/api/plans', 'o.smirnov', body)).statusCode, 200);
  const p = (await req('GET', `/api/plans?clubId=${c1}&month=${m}`, 'o.astafeva')).json();
  assert.equal(p.club.new.amountKop, 10_000_000);
  assert.equal(p.canEdit, false);
  assert.equal(p.managers.find((x: { userId: string }) => x.userId === volkova).targets.new.amountKop, 7_000_000);
  const pf = (await req('GET', `/api/dash/widget/plan?clubId=${c1}&month=${m}`, 'o.smirnov')).json();
  const nw = pf.rows.find((r: { category: string }) => r.category === 'new');
  assert.equal(nw.planKop, 10_000_000);
  assert.equal(nw.planClients, Math.ceil(10_000_000 / 650_000));
  const fin = (await req('GET', `/api/finance/plan-fact?clubId=${c1}&month=${m}`, 'e.orlova')).json();
  assert.equal(fin.items.find((x: { category: string }) => x.category === 'new').planKop, 10_000_000);
  // удаление категории из плана
  assert.equal((await req('PUT', '/api/plans', 'o.smirnov', { clubId: c1, month: m, club: { return: null } })).statusCode, 200);
  // без плана — «план не задан», а не ноль
  const empty = (await req('GET', `/api/dash/widget/plan?clubId=${c1}&month=2030-01`, 'o.smirnov')).json();
  assert.equal(empty.total.planKop, null);
  assert.equal(empty.total.percent, null);
});

test('продажа менеджера попадает в личный план, план отдела и отчёт по продажам; светофор', async () => {
  const before = (await req('GET', '/api/dash/widget/my_plan', 'm.volkova')).json();
  const person = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Тест Дашбордов', phone: '+79001112233', sourceCode: 'site' })).json();
  const prod = (await sql(`select id from products where club_id = $1 and name = 'Месяц безлимит'`, [c1]))[0].id;
  const sale = await req('POST', '/api/memberships', 'm.volkova', { personId: person.personId, productId: prod });
  assert.equal(sale.statusCode, 201, sale.body);
  const ch = (await sql('select id from charges where membership_id = $1', [sale.json().id]))[0].id;
  assert.equal((await req('POST', `/api/charges/${ch}/mark-paid`, 'd.lis', { method: 'card_terminal' })).statusCode, 200);
  const after = (await req('GET', '/api/dash/widget/my_plan', 'm.volkova')).json();
  assert.equal(after.total.factKop - before.total.factKop, 650_000);
  assert.equal(after.total.todayKop - before.total.todayKop, 650_000);
  assert.ok(after.total.dayPlanKop !== null);
  const team = (await req('GET', `/api/dash/widget/team?clubId=${c1}`, 'o.astafeva')).json();
  const v = team.rows.find((r: { name: string }) => r.name === 'Мария Волкова');
  assert.ok(v.factKop >= 650_000);
  assert.ok(['green', 'yellow', 'red'].includes(v.light));
  // отчёт по продажам: менеджер видит только свои продажи
  const mine = (await req('GET', `/api/reports/sales?clubId=${c1}`, 'm.volkova')).json();
  assert.ok(mine.rows.length > 0 && mine.rows.every((r: { seller: string }) => r.seller === 'Мария Волкова'));
  const all = (await req('GET', `/api/reports/sales?clubId=${c1}`, 'o.smirnov')).json();
  assert.ok(all.rows.length > mine.rows.length);
});

test('конверсия лид → контакт → встреча → покупка по каналу и менеджеру', async () => {
  const f0 = (await req('GET', `/api/dash/widget/funnel_managers?clubId=${c2}`, 's.pavlov')).json();
  const z0 = f0.rows.find((r: { name: string }) => r.name === 'Игорь Зуев');
  const lead = (await req('POST', '/api/leads', 's.pavlov', { clubId: c2, fullName: 'Воронка Тестовая', phone: '+79001112244', sourceCode: 'telegram', assignedTo: await uid('i.zuev') })).json();
  const task = (await sql(`select id from tasks where lead_id = $1`, [lead.leadId]))[0].id;
  const done = await req('POST', `/api/tasks/${task}/complete`, 'i.zuev', { result: 'Связался', nextTask: { title: 'Встреча', dueAt: new Date(Date.now() + 86_400_000).toISOString(), kind: 'meeting' } });
  assert.equal(done.statusCode, 200, done.body);
  const mt = await req('POST', '/api/meetings', 'i.zuev', { opportunityId: lead.opportunityId, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(mt.statusCode, 201, mt.body);
  assert.equal((await req('POST', `/api/meetings/${mt.json().id}/status`, 'i.zuev', { status: 'attended' })).statusCode, 200);
  const prod = (await sql(`select id from products where club_id = $1 and name = 'Подписка «Безлимит»'`, [c2]))[0].id;
  assert.equal((await req('POST', '/api/memberships', 'i.zuev', { personId: lead.personId, productId: prod })).statusCode, 201);
  const f1 = (await req('GET', `/api/dash/widget/funnel_managers?clubId=${c2}`, 's.pavlov')).json();
  const z1 = f1.rows.find((r: { name: string }) => r.name === 'Игорь Зуев');
  assert.deepEqual([z1.leads - (z0?.leads ?? 0), z1.contacted - (z0?.contacted ?? 0), z1.meetingSet - (z0?.meetingSet ?? 0), z1.meetingDone - (z0?.meetingDone ?? 0), z1.bought - (z0?.bought ?? 0)], [1, 1, 1, 1, 1]);
  const src = (await req('GET', `/api/dash/widget/funnel_sources?clubId=${c2}`, 's.pavlov')).json();
  assert.ok(src.rows.find((r: { name: string }) => r.name === 'Telegram').bought >= 1);
  assert.equal(src.total.leads, src.rows.reduce((a: number, r: { leads: number }) => a + r.leads, 0));
  // KPI Зуева: встречи и продажа видны, норма задаётся клубом
  assert.equal((await req('PUT', '/api/kpi-norms', 'o.astafeva', { clubId: c2, norms: { calls: 10 } })).statusCode, 403);
  assert.equal((await req('PUT', '/api/kpi-norms', 's.pavlov', { clubId: c2, norms: { calls: -1 } })).statusCode, 400);
  assert.equal((await req('PUT', '/api/kpi-norms', 's.pavlov', { clubId: c2, norms: { meetings_set: 1, sales: 1 } })).statusCode, 200);
  const k = (await req('GET', '/api/dash/widget/my_kpi', 'i.zuev')).json();
  const m = (id: string) => k.rows[0].metrics.find((x: { id: string }) => x.id === id);
  assert.ok(m('meetings_set').value >= 1);
  assert.equal(m('meetings_set').norm, 1);
  assert.equal(m('meetings_set').status, 'green');
  assert.ok(m('sales').value >= 1);
  assert.ok(m('calls').value >= 1);
});

test('риски, сравнение клубов, эффективность дня', async () => {
  const r = (await req('GET', '/api/dash/widget/risks', 'a.bespalyy')).json();
  const debts = r.items.find((i: { id: string }) => i.id === 'debtsCount');
  assert.ok(debts.value >= 1 && debts.moneyKop > 0); // долг Ахметова
  assert.ok(r.items.find((i: { id: string }) => i.id === 'missedResponse').value >= 1);
  const day = (await req('GET', '/api/dash/widget/day', 'a.bespalyy')).json();
  assert.equal(day.perClub.length, 2);
  assert.ok(day.day.salesKop > 0);
  assert.ok(typeof day.updatedAt === 'string');
  assert.equal((await req('GET', '/api/dash/widget/clubs', 'o.smirnov')).statusCode, 403);
  const gmDay = (await req('GET', '/api/dash/widget/day', 'o.smirnov')).json();
  assert.equal(gmDay.perClub.length, 1); // управляющий видит только свой клуб
});

test('выгрузки XLSX и CSV журналируются; словарь метрик', async () => {
  const x = await req('GET', `/api/dash/widget/plan/export?clubId=${c1}&format=xlsx`, 'o.smirnov');
  assert.equal(x.statusCode, 200);
  assert.match(String(x.headers['content-type']), /spreadsheetml/);
  const buf = x.rawPayload;
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  // лист читается: распаковываем sheet1.xml
  const name = 'xl/worksheets/sheet1.xml';
  const i = buf.indexOf(Buffer.from(name));
  const hdr = i - 30;
  const size = buf.readUInt32LE(hdr + 18);
  const xml = inflateRawSync(buf.subarray(i + name.length, i + name.length + size)).toString('utf8');
  assert.match(xml, /Новые клиенты/);
  const c = await req('GET', `/api/dash/widget/funnel_sources/export?clubId=${c1}&format=csv`, 'o.smirnov');
  assert.equal(c.rawPayload.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.match(c.body, /Канал;Лиды;/);
  const s = await req('GET', `/api/reports/sales?clubId=${c1}&format=xlsx`, 'e.orlova');
  assert.equal(s.statusCode, 200);
  const logged = await sql(`select count(*)::int as n from audit_log where action = 'report.exported'`);
  assert.ok(logged[0].n >= 3);
  const metrics = (await req('GET', '/api/dash/metrics', 'm.volkova')).json();
  assert.ok(metrics.length > 15 && metrics.every((m: { formula: string; source: string }) => m.formula && m.source));
});

test('демо-история добавляется один раз и наполняет дашборды', async () => {
  const c = new pg.Client(t.ownerUrl); await c.connect();
  try {
    const tid = (await c.query('select id from tenants limit 1')).rows[0].id;
    assert.equal(await seedDemoHistory(c as unknown as Db, tid), true);
    assert.equal(await seedDemoHistory(c as unknown as Db, tid), false);
  } finally { await c.end(); }
  const r = (await req('GET', `/api/dash/widget/funnel_sources?clubId=${c1}&from=${new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)}`, 'o.smirnov')).json();
  assert.ok(r.total.leads > 30 && r.total.bought > 0);
  const k = (await req('GET', `/api/dash/widget/kpi?clubId=${c1}`, 'o.smirnov')).json();
  assert.ok(k.rows.some((row: { metrics: { id: string; value: number }[] }) => row.metrics.find((m) => m.id === 'calls')!.value > 0));
});
