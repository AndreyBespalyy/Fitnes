import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { AcsGateway } from '../src/acsGateway.ts';
import { inWindow, offlineDecide, type Snapshot } from '../src/modules/acsRules.ts';
import { DEMO_GATEWAY_KEYS } from '../db/scripts/seed.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; let c2: string;
let inP: string; let outP: string; let gwId: string;

const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const pass = async (code: string, direction: 'in' | 'out' = 'in', point?: string) =>
  (await req('POST', '/api/acs/emulate', 'd.lis', { pointId: point ?? (direction === 'in' ? inP : outP), code, direction })).json();
const pid = async (name: string) => (await sql('select id from persons where full_name = $1', [name]))[0].id as string;

// Шлюз обращается к системе через тот же маршрут, что и в жизни, только без сети
const injFetch = (async (input: string | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  const r = await t.app.inject({ method: (init?.method ?? 'GET') as 'GET', url: u.pathname + u.search, headers: init?.headers as Record<string, string>, payload: init?.body as string });
  return new Response(r.body, { status: r.statusCode, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova', 'i.kotova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  c1 = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  c2 = clubs.find((c: { name: string }) => c.name.includes('Север')).id;
  // Клуб круглосуточно, чтобы тесты не зависели от часа запуска
  for (const c of [c1, c2]) assert.equal((await req('PUT', `/api/acs/settings/${c}`, 'a.bespalyy', { openFrom: '00:00', openTo: '00:00', repeatEntryMinutes: 30, offlineHours: 24 })).statusCode, 200);
  const feed = (await req('GET', `/api/acs/feed?clubId=${c1}`, 'd.lis')).json();
  inP = feed.points.find((p: { direction: string }) => p.direction === 'in').id;
  outP = feed.points.find((p: { direction: string }) => p.direction === 'out').id;
  gwId = feed.gateways[0].id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('окно времени тарифа, в том числе через полночь и круглосуточно', () => {
  assert.equal(inWindow('10:00', null, '17:00'), true);
  assert.equal(inWindow('17:00', null, '17:00'), false);
  assert.equal(inWindow('23:30', '22:00', '06:00'), true);
  assert.equal(inWindow('12:00', '22:00', '06:00'), false);
  assert.equal(inWindow('03:00', '00:00', '00:00'), true);
});

test('права: ресепшн видит проходы, менеджер нет, настройки только у управляющего и выше', async () => {
  assert.equal((await req('GET', `/api/acs/feed?clubId=${c1}`, 'm.volkova')).statusCode, 403);
  assert.equal((await req('GET', `/api/acs/feed?clubId=${c1}`, 'd.lis')).statusCode, 200);
  assert.equal((await req('GET', `/api/acs/setup?clubId=${c1}`, 'd.lis')).statusCode, 403);
  assert.equal((await req('GET', `/api/acs/setup?clubId=${c1}`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('GET', `/api/acs/setup?clubId=${c1}`, 'i.kotova')).statusCode, 200);
  // Ресепшн «Центра» не видит ленту «Севера»
  assert.equal((await req('GET', `/api/acs/feed?clubId=${c2}`, 'd.lis')).statusCode, 400);
});

test('решение о проходе и понятная причина отказа (FR-ACS-01, 05)', async () => {
  const ok = await pass('100001');
  assert.equal(ok.decision, 'allow');
  assert.match(ok.reason, /Годовой безлимит: действует до/);
  const exp = await pass('100003');
  assert.equal(exp.decision, 'deny'); assert.equal(exp.reasonCode, 'expired'); assert.match(exp.reason, /Месяц безлимит: закончился/);
  const old = await pass('099999');
  assert.equal(old.reasonCode, 'card_replaced'); assert.equal(old.name, 'Павел Рябов');
  assert.equal((await pass('ABCDEF12')).reasonCode, 'unknown_card');
  // Абонемент другого клуба
  const other = await pass('200001');
  assert.equal(other.reasonCode, 'other_club'); assert.match(other.reason, /Север/);
  // Сотрудник клуба проходит
  assert.equal((await pass('900001')).reasonCode, 'staff');
  // Выход всегда открыт
  assert.equal((await pass('100003', 'out')).decision, 'allow');
});

test('проход в другой клуб сети по правилам тарифа (FR-ACS-09) и время тарифа', async () => {
  const fed = await pid('Роман Фёдоров');
  await sql('update memberships set network_access = true where person_id = $1', [fed]);
  assert.equal((await pass('200001')).decision, 'allow');
  // Тариф только утром: сейчас «не то время»
  const demin = await pid('Кирилл Демин');
  const now = (await sql(`select to_char(now() at time zone 'Europe/Moscow', 'HH24:MI') as hm`))[0].hm as string;
  const from = now >= '12:00' ? '06:00' : '13:00'; const to = now >= '12:00' ? '07:00' : '14:00';
  await sql('update memberships set access_from = $2, access_to = $3 where person_id = $1', [demin, from, to]);
  const r = await pass('100004');
  assert.equal(r.reasonCode, 'wrong_time'); assert.match(r.reason, new RegExp(`с ${from} до ${to}`));
  await sql('update memberships set access_from = null, access_to = null where person_id = $1', [demin]);
  assert.equal((await pass('100004')).decision, 'allow');
});

test('посещения: повторы не множатся, выход даёт время в клубе, пакет списывается один раз (FR-ACS-07)', async () => {
  const ush = await pid('Глеб Ушаков');
  const visits = async () => (await sql(`select count(*)::int as n from visits where person_id = $1 and source = 'acs'`, [ush]))[0].n;
  const left = async () => (await sql(`select visits_left from memberships where person_id = $1`, [ush]))[0].visits_left;
  const before = await left();
  await pass('100005'); await pass('100005'); await pass('100005');
  assert.equal(await visits(), 1);
  assert.equal(await left(), before - 1);
  await pass('100005', 'out');
  assert.ok((await sql(`select exit_at from visits where person_id = $1 and source = 'acs'`, [ush]))[0].exit_at);
  // Вернулся через пару минут — то же посещение
  const back = await pass('100005');
  assert.equal(back.visitEffect, 'reopen');
  assert.equal(await visits(), 1);
  assert.equal(await left(), before - 1);
  const card = (await req('GET', `/api/persons/${ush}/passes?clubId=${c1}`, 'd.lis')).json();
  assert.equal(card.visits.length >= 1, true);
  assert.equal(card.now.allow, true);
});

test('перевыпуск карты без второго клиента (FR-ACS-06)', async () => {
  const gromov = await pid('Алексей Громов');
  const persons = (await sql('select count(*)::int as n from persons'))[0].n;
  const acc = (await req('GET', `/api/persons/${gromov}/passes?clubId=${c1}`, 'd.lis')).json();
  const old = acc.credentials.find((c: { status: string }) => c.status === 'active');
  // Нельзя выдать уже занятую карту
  assert.equal((await req('POST', `/api/persons/${gromov}/credentials`, 'd.lis', { kind: 'card', code: '100001', clubId: c1 })).statusCode, 400);
  const r = await req('POST', `/api/persons/${gromov}/credentials`, 'd.lis', { kind: 'card', code: '100777', clubId: c1, replaceId: old.id, reason: 'Потерял браслет' });
  assert.equal(r.statusCode, 201);
  assert.equal((await pass(old.code)).reasonCode, 'card_replaced');
  const now = await pass('100777');
  assert.equal(now.decision, 'allow'); assert.equal(now.personId, gromov);
  assert.equal((await sql('select count(*)::int as n from persons'))[0].n, persons);
  // QR-код генерирует система
  const qr = (await req('POST', `/api/persons/${gromov}/credentials`, 'd.lis', { kind: 'qr', clubId: c1 })).json();
  assert.match(qr.code, /^QR[0-9A-F]{12}$/);
  assert.equal((await pass(qr.code)).decision, 'allow');
  // Утеряна
  assert.equal((await req('POST', `/api/acs/credentials/${qr.id}/revoke`, 'd.lis', { status: 'lost' })).statusCode, 200);
  assert.equal((await pass(qr.code)).reasonCode, 'card_lost');
});

test('ручной проход с причиной и сотрудником, команда турникету, отчёт (FR-ACS-04, AT17)', async () => {
  const mir = await pid('Елена Миронова');
  assert.equal((await req('POST', '/api/acs/manual', 'd.lis', { clubId: c1, pointId: inP, personId: mir, reason: 'other' })).statusCode, 400);
  const r = (await req('POST', '/api/acs/manual', 'd.lis', { clubId: c1, pointId: inP, personId: mir, reason: 'turnstile_fault', comment: 'не реагирует на карты' })).json();
  assert.equal(r.ok, true);
  assert.match(r.wouldDeny, /закончился/);
  const feed = (await req('GET', `/api/acs/feed?clubId=${c1}`, 'd.lis')).json();
  assert.ok(feed.alerts.some((a: string) => a.includes('Турникет не работает')));
  const rep = (await req('GET', `/api/acs/report?clubId=${c1}&from=2020-01-01&to=2099-12-31`, 'o.smirnov')).json();
  const m = rep.manual.find((x: { person: string }) => x.person === 'Елена Миронова');
  assert.equal(m.manualBy, 'Дарья Лис');
  assert.match(m.reason, /Система бы не пустила/);
  assert.ok(rep.denials.some((d: { reasonCode: string }) => d.reasonCode === 'expired'));
  assert.ok(rep.staff.some((s: { name: string }) => s.name === 'Дарья Лис'));
  // Шлюз получает команду «открыть турникет»
  const gw = new AcsGateway({ server: 'http://x', id: gwId, key: DEMO_GATEWAY_KEYS.c1, fetch: injFetch });
  const opened: string[] = [];
  gw.onOpen = (p) => opened.push(p);
  assert.equal(await gw.sync(), true);
  assert.deepEqual(opened, [inP]);
  assert.equal((await sql(`select status from access_commands`))[0].status, 'done');
});

test('шлюз: без интернета пускает по сохранённым правилам, потом выгружает без дублей (AT16, AT07)', async () => {
  assert.equal(await new AcsGateway({ server: 'http://x', id: gwId, key: 'wrong', fetch: injFetch }).sync(), false);
  const gw = new AcsGateway({ server: 'http://x', id: gwId, key: DEMO_GATEWAY_KEYS.c1, fetch: injFetch, timeoutMs: 5000 });
  assert.equal(await gw.sync(), true);
  const online = await gw.pass(inP, '100001');
  assert.equal(online.mode, 'online'); assert.equal(online.allow, true);
  assert.ok(online.ms < 1000);
  const ryab = await pid('Павел Рябов');
  const ryabVisits = async () => (await sql(`select count(*)::int as n from visits where person_id = $1 and visited_at > now() - interval '1 hour'`, [ryab]))[0].n;
  const v0 = await ryabVisits();

  gw.forceOffline = true;
  const a = await gw.pass(outP, '100001', 'out');
  const b = await gw.pass(inP, '100003');
  const c = await gw.pass(inP, '099999');
  const d = await gw.pass(inP, '100001');
  assert.deepEqual([a.mode, a.allow, b.allow, c.reasonCode, d.allow], ['offline', true, false, 'card_replaced', true]);
  assert.equal(gw.state.queue.length, 4);
  assert.equal((await gw.flush()).sent, 0); // связи нет — очередь ждёт

  gw.forceOffline = false;
  const copy = [...gw.state.queue];
  const f1 = await gw.flush();
  assert.deepEqual([f1.accepted, f1.duplicates], [4, 0]);
  assert.equal(gw.state.queue.length, 0);
  // Шлюз прислал те же события ещё раз (например, после перезапуска) — ничего не изменилось
  gw.state.queue = copy;
  const f2 = await gw.flush();
  assert.deepEqual([f2.accepted, f2.duplicates], [0, 4]);
  assert.equal(await ryabVisits(), v0); // выход и возврат в пределах 30 минут — то же посещение
  const offline = (await sql(`select count(*)::int as n from access_events where mode = 'offline'`))[0].n;
  assert.equal(offline, 4);
});

test('снимок правил: без связи не пускает после окончания абонемента', () => {
  const s: Snapshot = { version: '1', generatedAt: '', clubId: 'c', clubName: 'Клуб', timezone: 'Europe/Moscow', openFrom: '07:00', openTo: '23:00', offlineHours: 24, points: [], commands: [],
    entries: [{ code: '1', kind: 'card', holder: 'person', name: 'Иван', personId: 'p', userId: null, allow: true, reasonCode: 'ok', reason: 'ок', validUntil: '2026-11-10', windows: [{ from: null, to: '17:00' }] }] };
  assert.equal(offlineDecide(s, '1', 'in', new Date('2026-11-10T09:00:00Z')).allow, true);   // 12:00 по Москве
  assert.equal(offlineDecide(s, '1', 'in', new Date('2026-11-10T15:00:00Z')).reasonCode, 'wrong_time'); // 18:00
  assert.equal(offlineDecide(s, '1', 'in', new Date('2026-11-11T09:00:00Z')).reasonCode, 'expired');
  assert.equal(offlineDecide(s, '1', 'in', new Date('2026-11-10T02:00:00Z')).reasonCode, 'club_closed'); // 05:00
  assert.equal(offlineDecide(s, '2', 'in', new Date('2026-11-10T09:00:00Z')).reasonCode, 'unknown_card');
});

test('тариф: проход по сети и часы задаются в тарифе и копируются в абонемент при продаже', async () => {
  const r = await req('POST', '/api/products', 'o.smirnov', { clubId: c1, kind: 'term', name: 'Утренний', priceKop: 300000, durationDays: 30, accessFrom: '07:00', accessTo: '12:00', networkAccess: true });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().accessTo, '12:00');
  assert.equal((await req('POST', '/api/products', 'o.smirnov', { clubId: c1, kind: 'term', name: 'Ошибка', priceKop: 1, durationDays: 30, accessFrom: '7 утра' })).statusCode, 400);
  const yud = await pid('Кирилл Демин');
  const sale = await req('POST', '/api/memberships', 'o.smirnov', { personId: yud, productId: r.json().id });
  assert.equal(sale.statusCode, 201);
  const m = (await sql(`select network_access, to_char(access_to, 'HH24:MI') as t from memberships where product_id = $1`, [r.json().id]))[0];
  assert.deepEqual([m.network_access, m.t], [true, '12:00']);
});
