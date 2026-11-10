// Шаг 18. Персонал: график, замены, табель, зарплата и ведомость (FR-STAFF).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; const uid: Record<string, string> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const M = '2026-10';
const at = (d: string, hm: string) => `${M}-${d}T${hm}:00+03:00`;

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'e.orlova', 'd.lis', 'a.kim', 's.pavlov']) { ck[l] = (await login(t.app, l)).cookie!; uid[l] = (await sql('select id from users where login = $1', [l]))[0].id; }
  c1 = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('график: управляющий ставит смены, менеджер видит только свои и не меняет; чужой клуб нельзя', async () => {
  const r = (await req('POST', '/api/staff-time/shifts', 'o.smirnov', { clubId: c1, userId: uid['m.volkova'], days: [`${M}-05`, `${M}-06`, `${M}-07`, `${M}-08`], starts: '09:00', ends: '18:00', breakMinutes: 60 })).json();
  assert.equal(r.created, 4);
  const again = (await req('POST', '/api/staff-time/shifts', 'o.smirnov', { clubId: c1, userId: uid['m.volkova'], days: [`${M}-05`], starts: '10:00', ends: '19:00' })).json();
  assert.deepEqual(again.conflicts, [`${M}-05`]);
  await req('POST', '/api/staff-time/shifts', 'o.smirnov', { clubId: c1, userId: uid['d.lis'], days: [`${M}-05`, `${M}-06`], starts: '08:00', ends: '20:00', breakMinutes: 60 });
  assert.equal((await req('POST', '/api/staff-time/shifts', 'm.volkova', { clubId: c1, userId: uid['m.volkova'], days: [`${M}-09`], starts: '09:00', ends: '18:00' })).statusCode, 403);
  const mine = (await req('GET', `/api/staff-time/schedule?clubId=${c1}&from=${M}-01&to=${M}-31`, 'm.volkova')).json();
  assert.ok(mine.shifts.length === 4 && mine.shifts.every((s: { userId: string }) => s.userId === uid['m.volkova']));
  assert.equal(mine.canEdit, false);
  const club = (await req('GET', `/api/staff-time/schedule?clubId=${c1}&from=${M}-01&to=${M}-31`, 'o.smirnov')).json();
  assert.equal(club.shifts.length, 6);
  const sever = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Север')).id;
  assert.equal((await req('POST', '/api/staff-time/shifts', 'o.smirnov', { clubId: sever, userId: uid['m.volkova'], days: [`${M}-09`], starts: '09:00', ends: '18:00' })).statusCode, 403);
});

test('табель: приход по карте и отметкам, обед по считывателю, опоздание, прогул, отпуск', async () => {
  const tn = (await sql('select tenant_id from clubs where id = $1', [c1]))[0].tenant_id;
  const card = async (d: string, hm: string, dir: string) => sql(`insert into access_events(tenant_id, club_id, happened_at, direction, user_id, decision, reason_code, reason, mode) values ($1,$2,$3,$4,$5,'allow','staff','Сотрудник','online')`, [tn, c1, at(d, hm), dir, uid['m.volkova']]);
  // 05: вовремя, обед по карте 13:00–13:40, ушла в 18:30
  await card('05', '08:58', 'in'); await card('05', '13:00', 'out'); await card('05', '13:40', 'in'); await card('05', '18:30', 'out');
  // 06: опоздание на 20 минут, обед не отмечала — вычитается плановый час
  await card('06', '09:20', 'in'); await card('06', '18:00', 'out');
  // 07: прогул. 08: забыла карту — руководитель исправляет с причиной
  assert.equal((await req('POST', '/api/staff-time/marks', 'o.smirnov', { clubId: c1, userId: uid['m.volkova'], at: at('08', '09:00'), direction: 'in' })).statusCode, 400);
  await req('POST', '/api/staff-time/marks', 'o.smirnov', { clubId: c1, userId: uid['m.volkova'], at: at('08', '09:00'), direction: 'in', reason: 'Забыла карту, подтверждаю' });
  await req('POST', '/api/staff-time/marks', 'o.smirnov', { clubId: c1, userId: uid['m.volkova'], at: at('08', '18:00'), direction: 'out', reason: 'Забыла карту, подтверждаю' });
  // Отпуск у ресепшн на 06 — смена в этот день требует замены
  const ab = (await req('POST', '/api/staff-time/absences', 'o.smirnov', { clubId: c1, userId: uid['d.lis'], kind: 'vacation', from: `${M}-06`, to: `${M}-10` })).json();
  assert.deepEqual(ab.shiftsToReplace, [`${M}-06`]);

  const ts = (await req('GET', `/api/staff-time/timesheet?clubId=${c1}&month=${M}`, 'o.smirnov')).json();
  const v = ts.rows.find((r: { userId: string }) => r.userId === uid['m.volkova']);
  const d = (x: string) => v.days.find((r: { day: string }) => r.day === `${M}-${x}`);
  assert.equal(d('05').workedMin, 532); // 08:58–13:00 (242) + 13:40–18:30 (290)
  assert.equal(d('05').breakMin, 40);
  assert.equal(d('05').overtimeMin, 52); // план 9 ч − 1 ч обеда = 480 мин
  assert.equal(d('06').lateMin, 20);
  assert.equal(d('06').workedMin, 520 - 60);
  assert.equal(d('06').status, 'late');
  assert.equal(d('07').status, 'absent');
  assert.equal(d('08').workedMin, 480);
  assert.equal(v.totals.lateCount, 1);
  assert.equal(v.totals.absentDays, 1);
  assert.equal(v.totals.plannedMin, 4 * 480);
  const lis = ts.rows.find((r: { userId: string }) => r.userId === uid['d.lis']);
  assert.equal(lis.days.find((r: { day: string }) => r.day === `${M}-06`).status, 'absence');
  // Менеджер видит только свой табель
  const own = (await req('GET', `/api/staff-time/timesheet?clubId=${c1}&month=${M}`, 'm.volkova')).json();
  assert.deepEqual(own.rows.map((r: { userId: string }) => r.userId), [uid['m.volkova']]);
  assert.equal((await req('GET', `/api/staff-time/timesheet?clubId=${c1}&month=${M}&userId=${uid['d.lis']}`, 'm.volkova')).statusCode, 403);
  // Отметка из приложения
  assert.equal((await req('POST', '/api/staff-time/mark', 'd.lis', { clubId: c1, direction: 'in' })).statusCode, 200);
  assert.equal((await sql(`select count(*)::int as n from staff_marks where user_id = $1 and source = 'app'`, [uid['d.lis']]))[0].n, 1);
});

test('замена: смену отрабатывает другой, оплата идёт ему', async () => {
  const sh = (await req('GET', `/api/staff-time/schedule?clubId=${c1}&from=${M}-06&to=${M}-06`, 'o.smirnov')).json().shifts.find((s: { userId: string }) => s.userId === uid['d.lis']);
  assert.equal((await req('POST', `/api/staff-time/shifts/${sh.id}/replace`, 'o.smirnov', { userId: uid['m.volkova'] })).statusCode, 400, 'у заменяющего уже есть смена');
  assert.equal((await req('POST', `/api/staff-time/shifts/${sh.id}/replace`, 'o.smirnov', { userId: uid['e.orlova'] })).statusCode, 200);
  const after = (await req('GET', `/api/staff-time/schedule?clubId=${c1}&from=${M}-06&to=${M}-06`, 'o.smirnov')).json().shifts.find((s: { id: string }) => s.id === sh.id);
  assert.equal(after.userId, uid['e.orlova']);
  assert.equal(after.replacedUserId, uid['d.lis']);
});

test('зарплата: схемы, расчёт с расшифровкой, утверждение, после него только корректировка', async () => {
  // Права: менеджер не видит ведомость
  assert.equal((await req('GET', `/api/payroll?clubId=${c1}&month=${M}`, 'm.volkova')).statusCode, 403);
  assert.equal((await req('POST', '/api/payroll/schemes', 'e.orlova', { clubId: c1, userId: uid['m.volkova'], validFrom: `${M}-01`, kind: 'hourly', rateKop: 30000, salesPercent: 5, planBonusKop: 1000000, planBonusThreshold: 100 })).statusCode, 201);
  await req('POST', '/api/payroll/schemes', 'e.orlova', { clubId: c1, userId: uid['a.kim'], validFrom: `${M}-01`, kind: 'trainer', rateKop: 150000 });
  await req('POST', '/api/payroll/schemes', 'o.smirnov', { clubId: c1, userId: uid['d.lis'], validFrom: `${M}-01`, kind: 'shift', rateKop: 250000 });
  assert.equal((await req('POST', '/api/payroll/adjustments', 'e.orlova', { clubId: c1, userId: uid['a.kim'], month: M, kind: 'sessions', quantity: 12, reason: 'Журнал тренировок за октябрь' })).statusCode, 201);
  await req('POST', '/api/payroll/adjustments', 'e.orlova', { clubId: c1, userId: uid['m.volkova'], month: M, kind: 'deduction', amountKop: 50000, reason: 'Форма' });
  assert.equal((await req('POST', '/api/payroll/adjustments', 'e.orlova', { clubId: c1, userId: uid['m.volkova'], month: M, kind: 'bonus', amountKop: 100 })).statusCode, 400, 'без основания нельзя');

  const r = (await req('POST', '/api/payroll/calculate', 'e.orlova', { clubId: c1, month: M })).json();
  const v = r.lines.find((l: { userId: string }) => l.userId === uid['m.volkova']);
  const hoursItem = v.items.find((i: { code: string }) => i.code === 'hours');
  assert.equal(hoursItem.amountKop, Math.round((30000 * (532 + 460 + 480)) / 60));
  assert.match(hoursItem.basis, /300 ₽ в час × 24 ч 32 мин/);
  assert.ok(v.items.some((i: { code: string }) => i.code === 'sales'));
  assert.ok(v.items.some((i: { code: string; amountKop: number }) => i.code === 'deduction' && i.amountKop === -50000));
  assert.equal(v.totalKop, v.items.reduce((a: number, i: { amountKop: number }) => a + i.amountKop, 0));
  const kim = r.lines.find((l: { userId: string }) => l.userId === uid['a.kim']);
  assert.equal(kim.totalKop, 12 * 150000);
  const lis = r.lines.find((l: { userId: string }) => l.userId === uid['d.lis']);
  assert.equal(lis.items[0].amountKop, 0, 'смену 06 отработала замена, 05 без отметок');

  // Сотрудник видит свою строку с расшифровкой
  const my = (await req('GET', `/api/payroll/my?month=${M}`, 'm.volkova')).json();
  assert.equal(my.length, 1); assert.equal(my[0].totalKop, v.totalKop); assert.equal(my[0].status, 'draft');

  const ap = (await req('POST', '/api/payroll/approve', 'o.smirnov', { clubId: c1, month: M })).json();
  assert.equal(ap.period.status, 'approved');
  assert.equal((await req('POST', '/api/payroll/calculate', 'e.orlova', { clubId: c1, month: M })).json().error, 'period_approved');
  assert.equal((await req('POST', '/api/payroll/adjustments', 'e.orlova', { clubId: c1, userId: uid['m.volkova'], month: M, kind: 'bonus', amountKop: 100, reason: 'x' })).json().error, 'period_approved');
  await assert.rejects(sql(`update payroll_lines set total_kop = 1 where user_id = $1`, [uid['m.volkova']]), /утверждена/);
  // Ошибку исправляют корректировкой в следующем месяце
  assert.equal((await req('POST', '/api/payroll/adjustments', 'e.orlova', { clubId: c1, userId: uid['m.volkova'], month: '2026-11', kind: 'correction', amountKop: 50000, reason: 'Возврат удержания за форму (октябрь)' })).statusCode, 201);
  const x = await req('GET', `/api/payroll/export?clubId=${c1}&month=${M}&format=xlsx`, 'e.orlova');
  assert.equal(x.statusCode, 200); assert.equal(x.rawPayload.subarray(0, 2).toString(), 'PK');
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'payroll.approved'`))[0].n, 1);
});
