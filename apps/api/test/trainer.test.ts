// Рабочее место тренера: свои занятия и окна, свои клиенты и остатки пакетов, «предложить продление», заработок за месяц.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { freeWindows } from '../src/modules/trainer.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let ids: Record<string, string> = {};
const local = (hoursAhead: number) => sql(`select to_char(now() at time zone 'Europe/Moscow' + make_interval(hours => $1::int), 'YYYY-MM-DD"T"HH24:MI') as v`, [hoursAhead]).then((r) => r[0].v as string);
let n = 0;
async function client(product?: string) {
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Клиент Тренера ${++n}`, phone: `+7900888${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
  let membershipId = '';
  if (product) {
    const p = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === product);
    membershipId = (await req('POST', '/api/memberships', 'm.volkova', { personId, productId: p.id })).json().id;
  }
  return { personId, membershipId };
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'd.lis', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  ids = Object.fromEntries((await sql(`select login, id from users`)).map((r) => [r.login, r.id]));
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('свободные окна: смена минус занятия, промежутки меньше 30 минут не показываются', () => {
  assert.deepEqual(freeWindows([{ starts: '09:00', ends: '15:00' }], [{ from: '10:00', to: '11:00' }, { from: '11:15', to: '12:00' }, { from: '14:00', to: '15:00' }]),
    [{ from: '09:00', to: '10:00' }, { from: '12:00', to: '14:00' }]);
  assert.deepEqual(freeWindows([], [{ from: '10:00', to: '11:00' }]), []);
});

test('стол тренера: занятия, окна, клиенты с остатком, продление, отметка, заработок', async () => {
  const type = (await req('POST', '/api/schedule/types', 'o.smirnov', { clubId: centr, name: 'Персональная тренировка', kind: 'personal', durationMin: 60 })).json().id;
  await req('POST', '/api/payroll/schemes', 'o.smirnov', { clubId: centr, userId: ids['a.kim'], kind: 'trainer', rateKop: 100000, validFrom: '2026-01-01' });
  const p = await client('Персональные тренировки, 10 занятий');
  // занятие через 3 часа и одно прошедшее
  const s1 = (await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: type, trainerId: ids['a.kim'], start: await local(3) })).json().ids[0];
  const s0 = (await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: type, trainerId: ids['a.kim'], start: await local(5) })).json().ids[0];
  await req('POST', `/api/schedule/sessions/${s1}/book`, 'a.kim', { personId: p.personId });
  const b0 = (await req('POST', `/api/schedule/sessions/${s0}/book`, 'a.kim', { personId: p.personId })).json().id;
  await sql(`update class_sessions set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [s0]);
  // смена тренера сегодня на весь день
  const today = (await local(0)).slice(0, 10);
  await sql(`insert into staff_shifts(tenant_id, club_id, user_id, day, starts, ends) select tenant_id, id, $1, $2, '00:00', '23:59' from clubs where id = $3`, [ids['a.kim'], today, centr]);

  assert.equal((await req('GET', `/api/trainer/desk?clubId=${centr}&trainerId=${ids['o.smirnov']}`, 'a.kim')).statusCode, 403); // чужой стол — только управляющему
  const d = (await req('GET', `/api/trainer/desk?clubId=${centr}`, 'a.kim')).json();
  assert.equal(d.trainer.id, ids['a.kim']);
  // Вечером «через 3 часа» уже завтра: считаем занятия по всем дням стола
  assert.ok(d.days.flatMap((x: { sessions: unknown[] }) => x.sessions).length >= 2);
  assert.ok(d.days.flatMap((x: { windows: unknown[] }) => x.windows).length >= 1); // окна вокруг занятий
  assert.equal(d.unmarked.length, 1); // прошедшее не отмечено
  const c = d.clients.find((x: { personId: string }) => x.personId === p.personId);
  assert.equal(c.visitsLeft, 10);
  assert.equal(c.reserved, 2);
  assert.equal(d.renew.length, 0); // свободных занятий ещё 8
  // отмечаем прошедшее — оно списывается из пакета
  assert.equal((await req('POST', `/api/schedule/sessions/${s0}/done`, 'a.kim', { attendance: { [b0]: 'attended' } })).statusCode, 200);
  // у клиента осталось мало занятий — попадает в «предложить продление»
  await sql(`update memberships set visits_left = 2 where id = $1`, [p.membershipId]);
  const d2 = (await req('GET', `/api/trainer/desk?clubId=${centr}`, 'a.kim')).json();
  assert.equal(d2.unmarked.length, 0);
  const r = d2.renew.find((x: { personId: string }) => x.personId === p.personId);
  assert.match(r.reason, /осталось 1 занятие/);
  assert.ok(d2.earnings.totalKop >= 100000, JSON.stringify(d2.earnings));
  assert.equal(d2.done.personal, 1);
  // тренер предложил, клиент согласен — менеджеру задача
  const o = await req('POST', '/api/trainer/offers', 'a.kim', { clubId: centr, personId: p.personId, membershipId: p.membershipId, result: 'agreed', note: 'хочет ещё 10' });
  assert.equal(o.statusCode, 200, o.body);
  assert.match((await sql('select title from tasks where id = $1', [o.json().taskId]))[0].title, /Продлить персональные.*Ким/);
  const d3 = (await req('GET', `/api/trainer/desk?clubId=${centr}`, 'a.kim')).json();
  assert.equal(d3.renew.find((x: { personId: string }) => x.personId === p.personId), undefined); // после ответа неделю не показываем
  // продажа нового пакета засчитывается тренеру
  const prod = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === 'Персональные тренировки, 10 занятий');
  await req('POST', '/api/memberships', 'm.volkova', { personId: p.personId, productId: prod.id, confirmDuplicate: true });
  assert.equal((await req('GET', `/api/trainer/desk?clubId=${centr}`, 'a.kim')).json().offers.renewed, 1);
  // управляющий видит стол тренера
  assert.equal((await req('GET', `/api/trainer/desk?clubId=${centr}&trainerId=${ids['a.kim']}`, 'o.smirnov')).json().trainer.id, ids['a.kim']);
});
