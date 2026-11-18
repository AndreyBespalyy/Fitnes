// Счётчики в меню (№44) и вкладки «Клиенты»: новые / члены клуба / бывшие (№45, 39) — замечания тестировщиков 18.11.2026.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });

before(async () => {
  t = await setupTestApp();
  for (const l of ['m.volkova', 'a.bespalyy']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('счётчики меню: числа по задачам, перепискам и сообщениям сотрудников', async () => {
  const me = (await req('GET', '/api/auth/me', 'm.volkova')).json();
  const clubId = me.clubs?.[0]?.id ?? me.assignments?.[0]?.clubId;
  const r = await req('GET', `/api/nav/badges${clubId ? `?clubId=${clubId}` : ''}`, 'm.volkova');
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  for (const k of ['team', 'chats', 'tasks']) assert.equal(typeof b[k], 'number', k);
});

test('клиенты делятся на новых, членов клуба и бывших без пересечений', async () => {
  const all = (await req('GET', '/api/persons', 'a.bespalyy')).json();
  const by = async (kind: string) => (await req('GET', `/api/persons?kind=${kind}`, 'a.bespalyy')).json() as { id: string }[];
  const [n, m, f] = [await by('new'), await by('member'), await by('former')];
  const ids = [n, m, f].map((l) => new Set(l.map((x) => x.id)));
  for (const x of ids[0]) { assert.ok(!ids[1].has(x)); assert.ok(!ids[2].has(x)); }
  for (const x of ids[1]) assert.ok(!ids[2].has(x));
  assert.ok(m.length > 0, 'в тестовых данных есть действующие члены клуба');
  assert.ok(n.length + m.length + f.length <= all.length || all.length >= 50);
});

test('задача коллеге — только на день, когда он работает по графику (№46)', async () => {
  const me = (await req('GET', '/api/auth/me', 'm.volkova')).json();
  const club = (await req('GET', '/api/clubs', 'm.volkova')).json()[0].id as string;
  const who = (await req('GET', `/api/tasks/assignees?clubId=${club}`, 'm.volkova')).json() as { id: string; code: string }[];
  const peer = who.find((w) => w.id !== me.id && w.code === 'rop')!;
  const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const other = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);
  // График на коллегу ведётся: смена есть только в «other»
  const c = new pg.Client(t.ownerUrl); await c.connect();
  await c.query(`insert into staff_shifts(tenant_id, club_id, user_id, day, starts, ends) select tenant_id, id, $2, $3, '09:00', '18:00' from clubs where id = $1 on conflict do nothing`, [club, peer.id, other]);
  await c.end();
  const list = (await req('GET', `/api/tasks/assignees?clubId=${club}&day=${day}`, 'm.volkova')).json() as { id: string; works: boolean | null }[];
  assert.equal(list.find((w) => w.id === peer.id)!.works, false);
  const bad = await req('POST', '/api/tasks', 'm.volkova', { clubId: club, assigneeId: peer.id, title: 'Позвонить клиенту', dueAt: `${day}T09:00:00.000Z` });
  assert.equal(bad.statusCode, 400, bad.body);
  const ok = await req('POST', '/api/tasks', 'm.volkova', { clubId: club, assigneeId: peer.id, title: 'Позвонить клиенту', dueAt: `${other}T09:00:00.000Z` });
  assert.equal(ok.statusCode, 201, ok.body);
  // Себе — без проверки графика
  assert.equal((await req('POST', '/api/tasks', 'm.volkova', { clubId: club, title: 'Себе', dueAt: `${day}T09:00:00.000Z` })).statusCode, 201);
});
