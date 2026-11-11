// Отчёт о прибыли: доходы по видам минус возвраты, расходы по статьям, зарплата по ведомости без задвоения, сигнал собственнику.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { costSignals, pnlAlerts, type MonthPnl } from '../src/modules/pnl.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let sever = ''; let tenantId = '';
const pay = (dir: 'in' | 'out', kind: string, kop: number, at: string, cat: { sale?: string; exp?: string } = {}) => sql(`insert into payments(tenant_id, club_id, direction, kind, amount_kop, method, sale_category, expense_category, created_at)
  values ($1,$2,$3,$4,$5,'card_terminal',$6,$7,$8::timestamptz)`, [tenantId, sever, dir, kind, kop, cat.sale ?? null, cat.exp ?? null, `${at}T12:00:00+03:00`]);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'e.orlova', 'd.lis', 'o.smirnov']) ck[l] = (await login(t.app, l)).cookie!;
  sever = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Север')).id;
  tenantId = (await sql('select tenant_id from clubs where id = $1', [sever]))[0].tenant_id;
  await sql('delete from pay_schemes where club_id = $1', [sever]); // без схем — без оценки зарплаты
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('месяц: доходы, возвраты, расходы, зарплата по выплатам и по ведомости, площадь', async () => {
  await pay('in', 'charge', 100000, '2026-05-10', { sale: 'goods' });
  await pay('in', 'charge', 50000, '2026-05-11', { sale: 'deposit' });
  await pay('out', 'refund', 10000, '2026-05-12');
  await pay('out', 'expense', 30000, '2026-05-13', { exp: 'rent' });
  await pay('out', 'expense', 20000, '2026-05-14', { exp: 'salary' });
  assert.equal((await req('GET', `/api/pnl?clubId=${sever}&month=2026-05`, 'd.lis')).statusCode, 403);
  let d = (await req('GET', `/api/pnl?clubId=${sever}&month=2026-05`, 'a.bespalyy')).json();
  assert.deepEqual(d.cur.revenue.map((r: { code: string; amountKop: number }) => [r.code, r.amountKop]), [['goods', 100000], ['prepaid', 50000]]);
  assert.equal(d.cur.netRevenueKop, 140000);
  assert.deepEqual(d.cur.expenses.map((e: { code: string; amountKop: number; note?: string }) => [e.code, e.amountKop, e.note ?? null]), [['rent', 30000, null], ['salary', 20000, 'по выплатам']]);
  assert.equal(d.cur.profitKop, 90000);
  assert.equal(d.cur.marginPct, 64.3);
  assert.equal(d.trend.length, 6);

  // Ведомость за май утверждена: зарплата по ней, выплата в мае не задваивается
  const per = (await sql(`insert into payroll_periods(tenant_id, club_id, month, status, approved_at) values ($1,$2,'2026-05-01','draft', null) returning id`, [tenantId, sever]))[0].id;
  const u = (await sql(`select id from users where login = 'o.smirnov'`))[0].id;
  await sql(`insert into payroll_lines(tenant_id, club_id, period_id, user_id, items, total_kop) values ($1,$2,$3,$4,'[]',70000)`, [tenantId, sever, per, u]);
  await sql(`update payroll_periods set status = 'approved', approved_at = now() where id = $1`, [per]);
  d = (await req('GET', `/api/pnl?clubId=${sever}&month=2026-05`, 'a.bespalyy')).json();
  assert.deepEqual(d.cur.expenses.find((e: { code: string }) => e.code === 'salary'), { code: 'salary', name: 'Зарплата', amountKop: 70000, note: 'по утверждённой ведомости' });
  assert.equal(d.cur.profitKop, 140000 - 30000 - 70000);

  // Площадь: финансист задаёт, выручка на м²
  assert.equal((await req('PUT', '/api/pnl/area', 'd.lis', { clubId: sever, areaM2: 700 })).statusCode, 403);
  assert.equal((await req('PUT', '/api/pnl/area', 'a.bespalyy', { clubId: sever, areaM2: -5 })).statusCode, 400);
  assert.equal((await req('PUT', '/api/pnl/area', 'a.bespalyy', { clubId: sever, areaM2: 700 })).statusCode, 200);
  d = (await req('GET', `/api/pnl?clubId=${sever}&month=2026-05`, 'a.bespalyy')).json();
  assert.equal(d.perM2Kop, 200);
});

test('сигнал: расходы растут быстрее доходов — задача собственнику один раз', async () => {
  for (const m of ['03', '04', '06', '07', '08']) await pay('in', 'charge', 100000, `2026-${m}-10`, { sale: 'goods' });
  for (const m of ['03', '04']) await pay('out', 'expense', 50000, `2026-${m}-11`, { exp: 'rent' });
  for (const m of ['06', '07', '08']) await pay('out', 'expense', 90000, `2026-${m}-11`, { exp: 'rent' });
  const before1 = (await sql(`select count(*)::int as n from tasks where club_id = $1 and kind = 'other'`, [sever]))[0].n;
  const run = () => withCtx(t.pool, { tenantId, allClubs: true, clubIds: [] } as never, (db) => pnlAlerts(db, null, tenantId, sever, '2026-09-03'));
  assert.ok((await run()) >= 1);
  assert.equal(await run(), 0); // повторно не шлём
  const a = await sql(`select kind, text from pnl_alerts where club_id = $1`, [sever]);
  assert.ok(a.some((x) => x.kind === 'costs_outpace'), JSON.stringify(a));
  assert.ok((await sql(`select count(*)::int as n from tasks where club_id = $1 and kind = 'other'`, [sever]))[0].n > before1);
});

test('правило сигнала на ровных данных молчит', () => {
  const m = (month: string, r: number, e: number) => ({ month, netRevenueKop: r, expensesKop: e, profitKop: r - e }) as MonthPnl;
  assert.deepEqual(costSignals([m('2026-01', 100, 50), m('2026-02', 100, 50), m('2026-03', 100, 50), m('2026-04', 110, 54), m('2026-05', 110, 54), m('2026-06', 110, 54)]), []);
  const s = costSignals([m('2026-01', 100, 50), m('2026-02', 100, 50), m('2026-03', 100, 50), m('2026-04', 100, 70), m('2026-05', 100, 70), m('2026-06', 100, 120)]);
  assert.deepEqual(s.map((x) => x.kind), ['costs_outpace', 'loss']);
});
