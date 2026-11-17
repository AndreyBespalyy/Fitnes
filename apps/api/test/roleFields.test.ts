// Доступы по ролям внутри страниц (16.11.2026): тренер видит только свои занятия и своих клиентов,
// в карточке клиента ему не отдаются продажные данные; продавцы и руководители видят всё, как раньше.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';
let kim = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['o.smirnov', 'm.volkova', 'd.lis', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'o.smirnov')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  kim = (await sql(`select id from users where login = 'a.kim'`))[0].id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('тренер видит в расписании только свои занятия, чужое занятие не открыть и не записать на него', async () => {
  const type = (await req('POST', '/api/schedule/types', 'o.smirnov', { clubId: centr, name: 'Стретчинг для проверки', kind: 'group', durationMin: 60, capacity: 10 })).json().id;
  const day = (await sql(`select to_char(now() at time zone 'Europe/Moscow' + interval '2 days', 'YYYY-MM-DD') as d`))[0].d as string;
  const other = await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: type, trainerId: null, start: `${day}T07:00`, capacity: 10 });
  assert.equal(other.statusCode, 201, other.body);
  const otherId = (other.json().ids?.[0] ?? other.json().id) as string;
  const mine = await req('POST', '/api/schedule/sessions', 'o.smirnov', { clubId: centr, typeId: type, trainerId: kim, start: `${day}T08:00`, capacity: 10 });
  assert.equal(mine.statusCode, 201, mine.body);
  const mineId = (mine.json().ids?.[0] ?? mine.json().id) as string;

  const q = `/api/schedule?clubId=${centr}&from=${day}&to=${day}`;
  // Даже без фильтра и с чужим trainerId тренер получает только свои занятия
  for (const url of [q, `${q}&trainerId=`]) {
    const list = (await req('GET', url, 'a.kim')).json() as { id: string; trainerId: string | null }[];
    assert.ok(list.some((s) => s.id === mineId), 'своё занятие видно');
    assert.ok(list.every((s) => s.trainerId === kim), 'чужих занятий нет');
  }
  // Ресепшн и управляющий видят все занятия
  for (const who of ['d.lis', 'o.smirnov']) {
    const list = (await req('GET', q, who)).json() as { id: string }[];
    assert.ok(list.some((s) => s.id === otherId), `${who} видит чужое занятие`);
  }
  assert.equal((await req('GET', `/api/schedule/sessions/${otherId}`, 'a.kim')).statusCode, 403);
  assert.equal((await req('GET', `/api/schedule/sessions/${mineId}`, 'a.kim')).statusCode, 200);
  const person = (await sql(`select id from persons where home_club_id = $1 limit 1`, [centr]))[0].id;
  assert.equal((await req('POST', `/api/schedule/sessions/${otherId}/book`, 'a.kim', { personId: person })).statusCode, 403);
  assert.equal((await req('GET', `/api/schedule/sessions/${otherId}`, 'd.lis')).statusCode, 200);
});

test('тренер: в списке клиентов только свои, в карточке нет сделок, задач и обращений', async () => {
  const all = (await req('GET', `/api/persons?clubId=${centr}`, 'm.volkova')).json() as { id: string }[];
  const kimList = (await req('GET', `/api/persons?clubId=${centr}`, 'a.kim')).json() as { id: string }[];
  const own = (await sql(`select distinct b.person_id as id from class_bookings b join class_sessions s on s.id = b.session_id
    where s.trainer_id = $1 and s.starts_at > now() - interval '90 days'`, [kim])).map((r) => r.id as string);
  assert.ok(kimList.length < all.length, 'тренеру — не вся база клуба');
  assert.ok(kimList.every((p) => own.includes(p.id)), 'только клиенты со своих занятий');

  // Клиент со сделкой: менеджер видит сделку, тренер — нет
  const withOpp = (await sql(`select person_id as id from opportunities o join persons p on p.id = o.person_id where p.home_club_id = $1 limit 1`, [centr]))[0].id;
  const forManager = (await req('GET', `/api/persons/${withOpp}`, 'm.volkova')).json();
  assert.ok(forManager.opportunities.length > 0);
  const forTrainer = (await req('GET', `/api/persons/${withOpp}`, 'a.kim')).json();
  assert.equal(forTrainer.person.id, withOpp);
  assert.deepEqual([forTrainer.opportunities, forTrainer.tasks, forTrainer.leads, forTrainer.history], [[], [], [], []]);
});
