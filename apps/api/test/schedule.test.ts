// Расписание занятий и запись клиентов: лист ожидания, отмена, списание персональных, напоминания, занятия в зарплату тренера.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { sendReminders } from '../src/modules/schedule.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = ''; let ids: Record<string, string> = {};
const local = (hoursAhead: number) => sql(`select to_char(now() at time zone 'Europe/Moscow' + make_interval(hours => $1::int), 'YYYY-MM-DD"T"HH24:MI') as v`, [hoursAhead]).then((r) => r[0].v as string);
let n = 0;
async function client(product?: string) {
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Расписание Клиент ${++n}`, phone: `+7900777${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
  if (product) {
    const p = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === product);
    const s = await req('POST', '/api/memberships', 'm.volkova', { personId, productId: p.id });
    assert.equal(s.statusCode, 201, s.body);
    return { personId, membershipId: s.json().id as string };
  }
  return { personId, membershipId: '' };
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'd.lis', 'a.kim', 'p.ershova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  ids = Object.fromEntries((await sql(`select login, id from users`)).map((r) => [r.login, r.id]));
});
after(async () => { await t.app.close(); await t.pool.end(); });

let yoga = ''; let personal = ''; let room = '';
test('управляющий заводит залы, виды занятий и расписание с повтором; тренер и зал не занимаются дважды', async () => {
  assert.equal((await req('POST', '/api/schedule/types', 'm.volkova', { clubId: centr, name: 'Йога', kind: 'group' })).statusCode, 403);
  room = (await req('POST', '/api/schedule/rooms', 'o.smirnov', { clubId: centr, name: 'Большой зал', capacity: 20 })).json().id;
  yoga = (await req('POST', '/api/schedule/types', 'o.smirnov', { clubId: centr, name: 'Йога', kind: 'group', durationMin: 60, capacity: 2 })).json().id;
  personal = (await req('POST', '/api/schedule/types', 'o.smirnov', { clubId: centr, name: 'Персональная', kind: 'personal', durationMin: 60 })).json().id;
  const start = await local(26);
  const r = await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: yoga, roomId: room, trainerId: ids['a.kim'], start, repeatWeeks: 3 });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().created, 3);
  // Тот же тренер в то же время — занят
  const busy = await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: personal, trainerId: ids['a.kim'], start });
  assert.equal(busy.statusCode, 400);
  assert.match(busy.json().message, /занят тренер/);
  const setup = (await req('GET', `/api/schedule/setup?clubId=${centr}`, 'd.lis')).json();
  assert.ok(setup.trainers.some((x: { id: string }) => x.id === ids['a.kim']));
  const day = start.slice(0, 10);
  const list = (await req('GET', `/api/schedule?clubId=${centr}&from=${day}&to=${day}`, 'm.volkova')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].typeName, 'Йога');
});

test('запись: нужен абонемент на дату занятия, пробное — один раз, мест нет — лист ожидания, отмена освобождает место', async () => {
  const day = (await local(26)).slice(0, 10);
  const sid = (await req('GET', `/api/schedule?clubId=${centr}&from=${day}&to=${day}`, 'd.lis')).json()[0].id;
  const a = await client('Месяц безлимит'); const b = await client('Месяц безлимит'); const c = await client('Месяц безлимит'); const lead = await client();
  const noM = await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: lead.personId });
  assert.equal(noM.statusCode, 400);
  assert.equal(noM.json().error, 'no_membership');
  const ra = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: a.personId })).json();
  assert.equal(ra.status, 'booked');
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: a.personId })).statusCode, 400);
  const trial = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'm.volkova', { personId: lead.personId, trial: true })).json();
  assert.equal(trial.status, 'booked');
  const rb = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: b.personId })).json();
  assert.equal(rb.status, 'waitlist');
  assert.equal(rb.position, 1);
  const rc = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: c.personId })).json();
  assert.equal(rc.position, 2);
  // Отмена записанного: первый из листа ожидания записывается сам
  const cancel = (await req('POST', `/api/schedule/bookings/${ra.id}/cancel`, 'd.lis')).json();
  assert.equal(cancel.promoted, rb.id);
  const s = (await req('GET', `/api/schedule/sessions/${sid}`, 'd.lis')).json();
  assert.equal(s.booked, 2);
  assert.equal(s.waitlist, 1);
  assert.equal(s.bookings.find((x: { id: string }) => x.id === rb.id).status, 'booked');
  // Больше мест — подтягивается следующий
  await req('PATCH', `/api/schedule/sessions/${sid}`, 'o.smirnov', { capacity: 3 });
  assert.equal((await req('GET', `/api/schedule/sessions/${sid}`, 'd.lis')).json().waitlist, 0);
  // Второе пробное — нельзя
  const day2 = (await local(26 + 168)).slice(0, 10);
  const sid2 = (await req('GET', `/api/schedule?clubId=${centr}&from=${day2}&to=${day2}`, 'd.lis')).json()[0].id;
  assert.equal((await req('POST', `/api/schedule/sessions/${sid2}/book`, 'd.lis', { personId: lead.personId, trial: true })).statusCode, 400);
});

test('персональные: остаток пакета резервируется, поздняя отмена и проведённое занятие списываются, занятие идёт в зарплату тренера', async () => {
  const p = await client('Персональные тренировки, 10 занятий');
  const start = await local(3);
  const r = await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: personal, trainerId: ids['a.kim'], start });
  const sid = r.json().ids[0];
  // Обычный абонемент на персональное не подходит
  const g = await client('Месяц безлимит');
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: g.personId })).json().error, 'no_membership');
  const bk = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'a.kim', { personId: p.personId })).json();
  assert.equal(bk.status, 'booked');
  // Отмена за 3 часа при правиле 12 часов — поздняя, занятие списывается
  const c = (await req('POST', `/api/schedule/bookings/${bk.id}/cancel`, 'd.lis')).json();
  assert.equal(c.late, true);
  assert.equal(c.charged, true);
  assert.equal((await sql('select visits_left from memberships where id = $1', [p.membershipId]))[0].visits_left, 9);
  assert.equal((await sql(`select count(*)::int as n from membership_operations where membership_id = $1 and kind = 'class_charge'`, [p.membershipId]))[0].n, 1);
  // Снова записываем и проводим занятие
  const bk2 = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'a.kim', { personId: p.personId })).json();
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/done`, 'a.kim', { attendance: { [bk2.id]: 'attended' } })).statusCode, 400); // ещё не началось
  await sql(`update class_sessions set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [sid]);
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/done`, 'p.ershova', { attendance: { [bk2.id]: 'attended' } })).statusCode, 404); // тренер другого клуба занятие не видит
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/done`, 'a.kim', { attendance: {} })).statusCode, 400); // не отмечен клиент
  const done = (await req('POST', `/api/schedule/sessions/${sid}/done`, 'a.kim', { attendance: { [bk2.id]: 'attended' } })).json();
  assert.equal(done.attended, 1);
  assert.equal((await sql('select visits_left from memberships where id = $1', [p.membershipId]))[0].visits_left, 8);
  // Зарплата тренера: схема «за занятие», занятия по расписанию считаются сами
  const month = (await sql(`select to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM') as m`))[0].m;
  assert.equal((await req('POST', '/api/payroll/schemes', 'o.smirnov', { clubId: centr, userId: ids['a.kim'], validFrom: `${month}-01`, kind: 'trainer', rateKop: 150_000 })).statusCode, 201);
  const pr = (await req('POST', '/api/payroll/calculate', 'o.smirnov', { clubId: centr, month })).json();
  const line = pr.lines.find((l: { userId: string }) => l.userId === ids['a.kim']);
  const item = line.items.find((i: { code: string }) => i.code === 'sessions');
  assert.equal(item.amountKop, 150_000);
  assert.match(item.basis, /по расписанию 1/);
  // Аренда: 50 % от стоимости персональной по цене пакета клиента минус аренда зала; норма занятий — в нагрузке
  const one = Number((await sql(`select m.amount_kop / p.visits_count as v from memberships m join products p on p.id = m.product_id where m.id = $1`, [p.membershipId]))[0].v);
  assert.equal((await req('POST', '/api/payroll/schemes', 'o.smirnov', { clubId: centr, userId: ids['a.kim'], validFrom: `${month}-01`, kind: 'trainer', rateKop: 0, trainerModel: 'rent', trainerPercent: 50, rentKop: 1_000_000, sessionsNorm: 40 })).statusCode, 201);
  assert.equal((await req('POST', '/api/payroll/schemes', 'o.smirnov', { clubId: centr, userId: ids['a.kim'], validFrom: `${month}-01`, kind: 'trainer', trainerModel: 'lease' })).statusCode, 400);
  const pr2 = (await req('POST', '/api/payroll/calculate', 'o.smirnov', { clubId: centr, month })).json();
  const l2 = pr2.lines.find((l: { userId: string }) => l.userId === ids['a.kim']);
  // Персональными засчитываются проведённое и поздно отменённое (списанное) занятие
  const pers = l2.items.find((i: { code: string }) => i.code === 'personal');
  assert.ok(pers.amountKop > 0 && pers.amountKop % Math.round(one / 2) <= 1, JSON.stringify(pers));
  assert.equal(l2.items.find((i: { code: string }) => i.code === 'rent').amountKop, -1_000_000);
  const load = (await req('GET', `/api/staff-time/load?clubId=${centr}&month=${month}`, 'o.smirnov')).json();
  const kim = load.rows.find((r: { userId: string }) => r.userId === ids['a.kim']);
  assert.match(kim.metrics.find((m: { name: string }) => m.name === 'Проведено занятий').plan, /из 40 в месяц/);
  const mine = (await req('GET', `/api/staff-time/load?clubId=${centr}&month=${month}`, 'a.kim')).json();
  assert.equal(mine.rows.length, 1);
  // История клиента
  const hist = (await req('GET', `/api/persons/${p.personId}/bookings`, 'd.lis')).json();
  assert.equal(hist.length, 2);
});

test('напоминания за сутки и за 2 часа уходят один раз; отмена занятия сообщает записанным', async () => {
  const day = (await local(26)).slice(0, 10);
  const sid = (await req('GET', `/api/schedule?clubId=${centr}&from=${day}&to=${day}`, 'd.lis')).json()[0].id;
  // Клиент с диалогом в мессенджере (тестовый канал)
  const pid = (await sql(`select c.person_id from msg_conversations c join persons p on p.id = c.person_id join memberships m on m.person_id = p.id
    where c.club_id = $1 and m.status = 'active' and m.kind = 'term' limit 1`, [centr]))[0].person_id;
  await req('PATCH', `/api/schedule/sessions/${sid}`, 'o.smirnov', { capacity: 10 });
  const bk = await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: pid });
  assert.equal(bk.statusCode, 201, bk.body);
  assert.equal(bk.json().status, 'booked');
  await sql(`update class_sessions set starts_at = now() + interval '20 hours', ends_at = now() + interval '21 hours' where id = $1`, [sid]);
  const before = (await sql(`select count(*)::int as n from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.person_id = $1`, [pid]))[0].n;
  const c = new pg.Client(t.ownerUrl); await c.connect();
  try {
    assert.ok(await sendReminders(c as never, null, tenant) >= 1);
    assert.equal(await sendReminders(c as never, null, tenant), 0);
  } finally { await c.end(); }
  const msgs = await sql(`select m.body from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.person_id = $1 order by m.created_at desc`, [pid]);
  assert.equal(msgs.length, before + 1, JSON.stringify(msgs));
  assert.match(msgs[0].body, /завтра/);
  // Отмена занятия: причина обязательна, записанные получают сообщение
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/cancel`, 'o.smirnov', {})).statusCode, 400);
  const r = (await req('POST', `/api/schedule/sessions/${sid}/cancel`, 'o.smirnov', { reason: 'тренер заболел' })).json();
  assert.ok(r.cancelled >= 1 && r.notified >= 1);
  assert.match((await sql(`select m.body from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.person_id = $1 order by m.created_at desc limit 1`, [pid]))[0].body, /тренер заболел/);
});

test('правила клуба: запрет записи после неявок', async () => {
  const r = await req('PUT', '/api/schedule/settings', 'o.smirnov', { clubId: centr, noShowLimit: 1, noShowBlockDays: 7 });
  assert.equal(r.statusCode, 200, r.body);
  const p = await client('Месяц безлимит');
  const start = await local(30);
  const sid = (await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: yoga, start: start.slice(0, 11) + '06:00' })).json().ids[0];
  const bk = (await req('POST', `/api/schedule/sessions/${sid}/book`, 'd.lis', { personId: p.personId })).json();
  await sql(`update class_sessions set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id = $1`, [sid]);
  assert.equal((await req('POST', `/api/schedule/sessions/${sid}/done`, 'o.smirnov', { attendance: { [bk.id]: 'no_show' } })).statusCode, 200);
  const day = (await local(26 + 168)).slice(0, 10);
  const next = (await req('GET', `/api/schedule?clubId=${centr}&from=${day}&to=${day}`, 'd.lis')).json()[0].id;
  const x = await req('POST', `/api/schedule/sessions/${next}/book`, 'd.lis', { personId: p.personId });
  assert.equal(x.statusCode, 400);
  assert.equal(x.json().error, 'no_show_block');
});
