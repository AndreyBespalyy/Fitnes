import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { parseDirection, parseRequest, parseResult, parseTime } from '../src/modules/pocketkey.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; let conn: string; let token: string;
const req = (method: string, url: string, who: string | null, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: who ? ck[who] : undefined, payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const pk = (op: string, payload?: unknown, method = 'POST') => req(method, `/api/pocketkey/${conn}/${token}/${op}`, null, payload);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  c1 = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  assert.equal((await req('PUT', `/api/acs/settings/${c1}`, 'a.bespalyy', { openFrom: '00:00', openTo: '00:00', repeatEntryMinutes: 30, offlineHours: 24 })).statusCode, 200);
  const r = await req('POST', '/api/acs/pocketkey', 'o.smirnov', { clubId: c1 });
  assert.equal(r.statusCode, 201);
  ({ id: conn, token } = r.json());
  assert.match(r.json().urls['check-access'], new RegExp(`/api/pocketkey/${conn}/.+/check-access$`));
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор полей PocketKey: разные написания', () => {
  assert.equal(parseDirection('entry'), 'in'); assert.equal(parseDirection('EXIT'), 'out'); assert.equal(parseDirection('?'), null);
  assert.equal(parseResult('true'), 'passed'); assert.equal(parseResult('access_denied'), 'denied');
  assert.equal(parseTime('1763400000')?.toISOString(), '2025-11-17T17:20:00.000Z');
  assert.equal(parseTime('2026-11-17 10:00:00Z')?.toISOString(), '2026-11-17T10:00:00.000Z');
  const r = parseRequest({ deviceId: 'T1', cardNumber: ' 00ab 12 ', dir: 'in', eventId: 77 });
  assert.deepEqual([r.device, r.code, r.direction, r.eventId], ['T1', '00AB12', 'in', '77']);
});

test('права: подключение PocketKey настраивает управляющий, ресепшн нет; чужой ключ не пускает', async () => {
  assert.equal((await req('GET', `/api/acs/pocketkey?clubId=${c1}`, 'd.lis')).statusCode, 403);
  assert.equal((await req('GET', `/api/acs/pocketkey?clubId=${c1}`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('POST', '/api/acs/pocketkey', 'o.smirnov', { clubId: c1 })).statusCode, 400);
  assert.equal((await req('POST', `/api/pocketkey/${conn}/wrong-key/check-access`, null, { credential_id: '100001' })).statusCode, 401);
  // Ключ PocketKey не открывает API шлюза турникетов
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/acs/gw/${conn}/rules`, headers: { 'x-gateway-key': token } })).statusCode, 401);
  assert.equal((await pk('health', undefined, 'GET')).json().ok, true);
});

test('проверка доступа: действующая карта — да, просроченная и чужая — нет, причина понятна', async () => {
  const ok = (await pk('check-access', { device_id: 'entrance_01', credential_id: '100001', credential_type: 'rfid', direction: 'entry' })).json();
  assert.equal(ok.access_granted, true); assert.equal(ok.name, 'Павел Рябов'); assert.match(ok.message, /Годовой безлимит/);
  const exp = (await pk('check-access', { device_id: 'entrance_01', credential_id: '100003' })).json();
  assert.equal(exp.access_granted, false); assert.equal(exp.reason_code, 'expired');
  assert.equal((await pk('check-access', { device_id: 'entrance_01', credential_id: 'FFFF0000' })).json().reason_code, 'unknown_card');
  // Номер карты с ведущими нулями находится
  assert.equal((await pk('check-access', { device_id: 'entrance_01', credential_id: '000100001' })).json().access_granted, true);
  // GET с параметрами в адресе тоже понимаем
  assert.equal((await pk('check-access?card=100001&device=entrance_01', undefined, 'GET')).json().access_granted, true);
  // Новое устройство завелось само
  const pts = await sql(`select name, external_id from access_points where gateway_id = $1`, [conn]);
  assert.deepEqual(pts.map((p) => p.external_id), ['entrance_01']);
  // Разрешение без события — ещё не посещение; отказ в ленте есть
  const ev = await sql(`select decision from access_events where gateway_id = $1`, [conn]);
  assert.ok(ev.every((e) => e.decision === 'deny'));
});

test('событие прохода создаёт посещение, повтор не создаёт дубль, выход закрывает посещение', async () => {
  const person = (await sql(`select id from persons where full_name = 'Павел Рябов'`))[0].id;
  await sql('update access_events set visit_id = null where person_id = $1', [person]);
  await sql('delete from visits where person_id = $1 and visited_at > now() - interval \'1 day\'', [person]);
  const before = (await sql('select count(*)::int as n from visits where person_id = $1', [person]))[0].n;
  const e = { event_id: 'pk-1', device_id: 'entrance_01', credential_id: '100001', direction: 'entry', result: 'passed', time: new Date().toISOString() };
  const r1 = (await pk('event', e)).json();
  assert.equal(r1.duplicate, false); assert.equal(r1.visit, 'new');
  assert.equal((await pk('event', e)).json().duplicate, true);
  assert.equal((await sql('select count(*)::int as n from visits where person_id = $1', [person]))[0].n, before + 1);
  const out = (await pk('event', { ...e, event_id: 'pk-2', direction: 'exit' })).json();
  assert.equal(out.visit, 'exit');
  // Без номера события — понятная ошибка, ничего не записано
  assert.equal((await pk('event', { credential_id: '100001' })).statusCode, 400);
});

test('СКУД пропустила вопреки правилам CRM: проход записан с причиной', async () => {
  const r = (await pk('event', { event_id: 'pk-3', device_id: 'entrance_01', credential_id: '100003', direction: 'entry', result: 'granted' })).json();
  const ev = (await sql('select decision, reason_code, reason from access_events where id = $1', [r.event_id]))[0];
  assert.equal(ev.decision, 'allow'); assert.equal(ev.reason_code, 'acs_allowed'); assert.match(ev.reason, /По правилам CRM: Месяц безлимит: закончился/);
});

test('настройка «посещение сразу по разрешению», выключенное устройство и опознание', async () => {
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { visitBy: 'check' })).statusCode, 200);
  const ok = (await pk('check-access', { device_id: 'entrance_01', credential_id: '900001' })).json();
  assert.equal(ok.access_granted, true); assert.ok(ok.event_id);
  const pt = (await sql(`select id from access_points where gateway_id = $1 and external_id = 'entrance_01'`, [conn]))[0].id;
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}/devices/${pt}`, 'o.smirnov', { isActive: false, name: 'Главный вход' })).statusCode, 200);
  const off = (await pk('check-access', { device_id: 'entrance_01', credential_id: '100001' })).json();
  assert.equal(off.access_granted, false); assert.match(off.message, /Главный вход/);
  const who = (await pk('identify', { credential_id: '100001' })).json();
  assert.equal(who.found, true); assert.equal(who.user_type, 'client'); assert.equal(who.phone, undefined);
  assert.equal((await pk('users/sync', {})).statusCode, 501);
  // Журнал без полных номеров карт
  const s = (await req('GET', `/api/acs/pocketkey?clubId=${c1}`, 'o.smirnov')).json();
  const j = s.connections[0].journal;
  assert.ok(j.length > 5); assert.ok(j.every((x: { codeTail: string | null }) => !x.codeTail || x.codeTail.length <= 5));
  assert.equal(s.connections[0].devices[0].name, 'Главный вход');
  // Ограничение по адресам
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { allowedIps: '10.1.1.1', visitBy: 'event' })).statusCode, 200);
  assert.equal((await pk('health', undefined, 'GET')).statusCode, 403);
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { allowedIps: '' })).statusCode, 200);
  // Проверка из окна настройки
  const tst = (await req('POST', `/api/acs/pocketkey/${conn}/test`, 'o.smirnov', { op: 'identify', code: '100001' })).json();
  assert.equal(tst.response.found, true);
  // Новый ключ: старый больше не действует
  const k = (await req('POST', `/api/acs/pocketkey/${conn}/key`, 'o.smirnov')).json();
  assert.equal((await pk('health', undefined, 'GET')).statusCode, 401);
  token = k.token;
  assert.equal((await pk('health', undefined, 'GET')).statusCode, 200);
});
