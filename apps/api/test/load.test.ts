// Загрузка клуба по часам: люди в клубе и входы по дню недели и часу, сравнение с прошлым месяцем, залы, подсказки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { hints } from '../src/modules/load.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'a.kim', 'e.orlova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('сетка загрузки: доля часа в клубе, входы, выход не отмечен — 90 минут', async () => {
  const ps = await sql(`select id from persons where home_club_id = $1 limit 3`, [centr]);
  const ins = (p: string, at: string, exit: string | null) => sql(`insert into visits(tenant_id, club_id, person_id, visited_at, exit_at, source)
    select tenant_id, id, $2, ($3::timestamp at time zone 'Europe/Moscow'), ($4::timestamp at time zone 'Europe/Moscow'), 'manual' from clubs where id = $1`, [centr, p, at, exit]);
  // Понедельник 3 августа 2026 (в августе 5 понедельников)
  await ins(ps[0].id, '2026-08-03 10:00', '2026-08-03 11:00');
  await ins(ps[1].id, '2026-08-03 10:00', '2026-08-03 11:00');
  await ins(ps[2].id, '2026-08-03 10:30', null); // 10:30–12:00
  // Июль: один визит во вторник
  await ins(ps[0].id, '2026-07-07 19:00', '2026-07-07 20:00');

  assert.equal((await req('GET', `/api/load?clubId=${centr}&month=2026-08`, 'a.kim')).statusCode, 403); // тренеру не нужно
  assert.equal((await req('GET', `/api/load?clubId=${centr}&month=2026-08`, 'd.lis')).statusCode, 403);
  const r = await req('GET', `/api/load?clubId=${centr}&month=2026-08`, 'o.smirnov');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.visits, 3);
  assert.equal(d.inside[0][10], 0.5); // (1 + 1 + 0.5) / 5 понедельников
  assert.equal(d.inside[0][11], 0.2); // остался только без отметки выхода
  assert.equal(d.inside[0][12], 0);
  assert.equal(d.entries[0][10], 0.6);
  assert.equal(d.prev.visits, 1);
  assert.equal(d.prev.inside[1][19], 0.3); // в июле 4 вторника: 1 / 4 ≈ 0.3
  assert.equal(d.exitsKnown, 67);
  assert.equal(d.forecast.length, 7);
  assert.ok(d.hints.some((h: { kind: string }) => h.kind === 'peak'));
  assert.equal((await req('GET', `/api/load?clubId=${centr}&month=2030-01`, 'o.smirnov')).statusCode, 400);
});

test('подсказки: пик, пустые будние часы, полные и пустые залы', () => {
  const g = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (let d = 0; d < 7; d++) { for (let h = 7; h < 23; h++) g[d][h] = 10; for (let h = 12; h < 16; h++) g[d][h] = d < 5 ? 1 : 10; g[d][19] = 40; }
  const rooms = [{ id: 'r', name: 'Большой зал', sessions: 8, seats: 80, taken: 50, fill: 62, cells: [{ dow: 0, hr: 19, sessions: 4, fill: 95 }, { dow: 2, hr: 9, sessions: 4, fill: 30 }] }];
  const h = hints(g, '07:00', '23:00', rooms);
  assert.equal(h.peak, 40);
  assert.match(h.out.find((x) => x.kind === 'peak')!.text, /19:00/);
  assert.match(h.out.find((x) => x.kind === 'quiet')!.text, /с 12:00 до 16:00/);
  assert.match(h.out.find((x) => x.kind === 'room_full')!.text, /пн 19:00 \(95 %\)/);
  assert.match(h.out.find((x) => x.kind === 'room_empty')!.text, /ср 9:00 \(30 %\)/);
});
