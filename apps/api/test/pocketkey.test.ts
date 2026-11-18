// СКУД PocketKey: протокол «Pocketkey API СКУД» — GET /devices, /checkaccess?id=&uid=&cells=, /event?id=&uid=
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { codeVariants, parseCells, parseRequest, screen, screenText } from '../src/modules/pocketkey.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; let conn: string; let token: string; let service: string;
let entry: string; let exit: string;
const req = (method: string, url: string, who: string | null, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: who ? ck[who] : undefined, payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const pk = (pathAndQuery: string) => t.app.inject({ method: 'GET', url: `${service}/${pathAndQuery}` });
const check = async (id: number, uid: string, cells = '0') => (await pk(`checkaccess?id=${id}&uid=${uid}&cells=${encodeURIComponent(cells)}`)).json();

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  c1 = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  assert.equal((await req('PUT', `/api/acs/settings/${c1}`, 'a.bespalyy', { openFrom: '00:00', openTo: '00:00', repeatEntryMinutes: 30, offlineHours: 24 })).statusCode, 200);
  const r = await req('POST', '/api/acs/pocketkey', 'o.smirnov', { clubId: c1 });
  assert.equal(r.statusCode, 201);
  ({ id: conn, token } = r.json());
  service = new URL(r.json().urls.service).pathname;
  assert.match(r.json().urls.checkaccess, /\/checkaccess$/);
  // Терминалы: 1 — вход, 2 — выход (так их описывает PocketKey)
  const a = await req('POST', `/api/acs/pocketkey/${conn}/devices`, 'o.smirnov', { name: 'Вход', direction: 'in', ip: '192.168.2.210', type: 'pocket' });
  assert.equal(a.statusCode, 201); assert.equal(a.json().externalId, '1'); entry = a.json().id;
  const b = await req('POST', `/api/acs/pocketkey/${conn}/devices`, 'o.smirnov', { name: 'Выход', direction: 'out', ip: '192.168.2.211', type: 'jsp', biometrics: true });
  assert.equal(b.json().externalId, '2'); exit = b.json().id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор запроса и текст на табло: не больше 5 строк по 16 знаков', () => {
  assert.deepEqual(parseRequest({ id: '1', uid: '5432916c', cells: '1:12;2:5' }), { device: '1', code: '5432916C', cells: ['1:12', '2:5'] });
  assert.deepEqual(parseCells('0'), []);
  assert.ok(codeVariants('5432916C').includes(String(0x5432916c)));
  assert.ok(codeVariants('5432916C').includes('6C913254'));
  for (const code of ['unknown_card', 'expired', 'wrong_time', 'locker', 'whatever']) {
    const txt = screenText({ decision: 'deny', reasonCode: code, reason: 'Очень длинная причина отказа, которую придётся переносить по строкам табло', name: null }, 'in');
    const lines = txt.split(';');
    assert.ok(lines.length <= 5 && lines.every((l) => l.length <= 16), txt);
  }
  assert.equal(screenText({ decision: 'allow', reasonCode: 'ok', reason: '', name: 'Павел Рябов' }, 'in'), 'Проходите;Павел');
  assert.equal(screen(['Абонемент закончился']), 'Абонемент;закончился');
});

test('права и ключ: настраивает управляющий; чужой ключ — отказ в формате PocketKey', async () => {
  assert.equal((await req('GET', `/api/acs/pocketkey?clubId=${c1}`, 'd.lis')).statusCode, 403);
  assert.equal((await req('POST', '/api/acs/pocketkey', 'o.smirnov', { clubId: c1 })).statusCode, 400);
  const bad = await t.app.inject({ method: 'GET', url: `/api/pocketkey/${conn}/wrong-key/checkaccess?id=1&uid=100001` });
  assert.equal(bad.statusCode, 401); assert.equal(bad.json().grant_access, 0);
  // Ключ PocketKey не открывает API шлюза турникетов
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/acs/gw/${conn}/rules`, headers: { 'x-gateway-key': token } })).statusCode, 401);
});

test('/devices — список терминалов в формате PocketKey', async () => {
  const r = (await pk('devices')).json();
  assert.deepEqual(r.devices, [
    { id: 1, ip: '192.168.2.210', port: 8080, biometrics: false, config_string: 'type=pocket' },
    { id: 2, ip: '192.168.2.211', port: 8902, biometrics: true, config_string: 'type=jsp' },
  ]);
});

test('/checkaccess: действующий браслет — 1, просроченный и незнакомый — 0 с понятным текстом', async () => {
  const ok = await check(1, '100001');
  assert.equal(ok.grant_access, 1); assert.equal(ok.text, 'Проходите;Павел'); assert.ok(ok.client_id);
  const exp = await check(1, '100003');
  assert.equal(exp.grant_access, 0); assert.equal(exp.text, 'Абонемент;закончился;Продлите;на ресепшн');
  assert.equal((await check(1, 'FFFF0000')).text, 'Браслет не;зарегистрирован;Подойдите;на ресепшн');
  // Номер с ведущими нулями находится
  assert.equal((await check(1, '000100001')).grant_access, 1);
  // Незнакомый терминал заводится сам (входом), администратор потом поправит
  assert.equal((await check(7, '100001')).grant_access, 1);
  assert.equal((await sql(`select name from access_points where gateway_id = $1 and external_id = '7'`, [conn]))[0].name, 'Терминал 7');
  // Разрешение — ещё не проход: в ленте только отказы
  const ev = await sql(`select decision from access_events where gateway_id = $1`, [conn]);
  assert.ok(ev.length > 0 && ev.every((e) => e.decision === 'deny'));
});

test('/event: проход создаёт посещение, повтор не создаёт дубль, выход по терминалу выхода закрывает посещение', async () => {
  const person = (await sql(`select id from persons where full_name = 'Павел Рябов'`))[0].id;
  await sql('update access_events set visit_id = null where person_id = $1', [person]);
  await sql(`delete from visits where person_id = $1 and visited_at > now() - interval '1 day'`, [person]);
  const r1 = await pk('event?id=1&uid=100001');
  assert.equal(r1.statusCode, 200); assert.equal(r1.json().visit, 'new');
  assert.equal((await pk('event?id=1&uid=100001')).json().duplicate, true);
  const out = (await pk('event?id=2&uid=100001')).json();
  assert.equal(out.visit, 'exit');
});

test('PocketKey пропустил сам (без связи): проход записан с причиной', async () => {
  const r = (await pk('event?id=1&uid=100003')).json();
  const ev = (await sql('select decision, reason_code, reason from access_events where id = $1', [r.event_id]))[0];
  assert.equal(ev.decision, 'allow'); assert.equal(ev.reason_code, 'acs_allowed'); assert.match(ev.reason, /По правилам CRM: Месяц безлимит: закончился/);
});

test('шкафчики на выходе, выключенный терминал, «посещение сразу по разрешению», журнал', async () => {
  // По умолчанию выпускаем и с закрытым шкафчиком
  assert.equal((await check(2, '100001', '1:12')).grant_access, 1);
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { lockerExit: 'deny' })).statusCode, 200);
  const locked = await check(2, '100001', '1:12');
  assert.equal(locked.grant_access, 0); assert.equal(locked.text, 'Закрыт шкафчик;Сдайте ключ;на ресепшн');
  assert.equal((await check(2, '100001', '0')).grant_access, 1);
  // Выключенный терминал не пускает и пропадает из /devices
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}/devices/${entry}`, 'o.smirnov', { isActive: false })).statusCode, 200);
  assert.equal((await check(1, '100001')).grant_access, 0);
  assert.deepEqual((await pk('devices')).json().devices.map((d: { id: number }) => d.id), [2]);
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}/devices/${entry}`, 'o.smirnov', { isActive: true, ip: '10.0.0.5', port: 8081 })).statusCode, 200);
  assert.equal((await pk('devices')).json().devices[0].port, 8081);
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}/devices/${exit}`, 'o.smirnov', { externalId: '1' })).statusCode, 400);
  // Режим «сразу по разрешению»: проход записан при проверке, событие его не задваивает
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { visitBy: 'check' })).statusCode, 200);
  assert.equal((await check(1, '900001')).grant_access, 1);
  assert.equal((await pk('event?id=1&uid=900001')).json().duplicate, true);
  // Журнал без полных номеров
  const s = (await req('GET', `/api/acs/pocketkey?clubId=${c1}`, 'o.smirnov')).json();
  const j = s.connections[0].journal;
  assert.ok(j.length > 5); assert.ok(j.every((x: { codeTail: string | null }) => !x.codeTail || x.codeTail.length <= 5));
  // Ограничение по адресам
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { allowedIps: '10.1.1.1' })).statusCode, 200);
  assert.equal((await pk('devices')).statusCode, 403);
  assert.equal((await req('PATCH', `/api/acs/pocketkey/${conn}`, 'o.smirnov', { allowedIps: '' })).statusCode, 200);
  // Проверка из окна настройки
  assert.equal((await req('POST', `/api/acs/pocketkey/${conn}/test`, 'o.smirnov', { op: 'identify', code: '100001' })).json().response.found, true);
  // Новый ключ: старый адрес больше не действует
  const k = (await req('POST', `/api/acs/pocketkey/${conn}/key`, 'o.smirnov')).json();
  assert.equal((await pk('devices')).statusCode, 401);
  service = new URL(k.urls.service).pathname;
  assert.equal((await pk('devices')).statusCode, 200);
});

test('выгрузка сотрудников для PocketOffice в XML', async () => {
  assert.equal((await req('GET', `/api/acs/pocketoffice/staff.xml?clubId=${c1}`, 'd.lis')).statusCode, 403);
  const r = await req('GET', `/api/acs/pocketoffice/staff.xml?clubId=${c1}`, 'o.smirnov');
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-disposition']), /employment_\d{8}\.xml/);
  assert.match(r.body, /^\uFEFF<\?xml version="1.0" encoding="UTF-8"\?>\r\n<HEAD>\r\n\t<BODY>/);
  assert.match(r.body, /<Наименование>Олег Смирнов<\/Наименование>\r\n\t\t\t<ВАрхиве>false<\/ВАрхиве>\r\n\t\t\t<КодПодразделения>/);
});
