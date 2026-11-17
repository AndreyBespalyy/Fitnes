import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { parsePbxEvent, processPbxRecords } from '../src/modules/telephony.ts';

// Заглушка OnlinePBX: API (auth, звонок, сотрудники) и файл записи
const seen: { url: string; headers: Headers; body: string }[] = [];
let recordMode: 'ok' | 'expired' = 'ok';
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 1)]);
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  seen.push({ url: u.toString(), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' });
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'api2.onlinepbx.ru') {
    if (u.pathname.endsWith('/auth.json')) {
      return new URLSearchParams(String(init?.body)).get('auth_key') === 'good-key'
        ? json({ status: '1', data: { key_id: 'kid', key: 'kkk' } }) : json({ status: '0', comment: 'Неверный ключ' });
    }
    if (u.pathname.endsWith('/user/get.json')) return json({ status: '1', data: [{ num: '101', name: 'Мария Волкова' }, { num: '102', name: 'Ольга' }, { num: '5200', name: 'Очередь' }] });
    if (u.pathname.endsWith('/call/now.json')) return json({ status: '1', data: { uuid: 'orig-1' } });
    if (u.pathname.endsWith('/mongo_history/search.json')) return json({ status: '1', data: 'https://records.onpbx.ru/fresh/rec.mp3' });
  }
  if (u.hostname === 'records.onpbx.ru') {
    if (recordMode === 'expired' && !u.pathname.includes('fresh')) return new Response('gone', { status: 404 });
    return new Response(mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; let connId: string; let hook: string;
const users: Record<string, string> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const event = (fields: Record<string, string | number>) => t.app.inject({
  method: 'POST', url: hook, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString(),
});

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.astafeva', 'm.volkova', 'i.zuev', 'o.smirnov', 's.pavlov']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  c1 = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  for (const r of await sql(`select id, login from users where login in ('m.volkova', 'o.astafeva', 'i.zuev')`)) users[r.login] = r.id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор события АТС: входящий и исходящий', () => {
  const inb = parsePbxEvent({ event: 'call_end', uuid: 'u1', direction: 'inbound', caller: '89030000108', callee: '101', date: '1763380000', dialog_duration: '42', download_url: 'https://x/rec.mp3' })!;
  assert.deepEqual([inb.direction, inb.phone, inb.ext, inb.talkSec, inb.downloadUrl], ['in', '+79030000108', '101', 42, 'https://x/rec.mp3']);
  const out = parsePbxEvent({ event: 'call_user_start', uuid: 'u2', direction: 'outbound', caller: '505', callee: '79111117960' })!;
  assert.deepEqual([out.direction, out.phone, out.ext], ['out', '+79111117960', '505']);
  // Номер группы или очереди — не сотрудник
  assert.equal(parsePbxEvent({ event: 'call_start', uuid: 'u3', direction: 'inbound', caller: '79111117960', callee: '5200' })!.ext, null);
  assert.equal(parsePbxEvent({ event: 'call_start' }), null);
});

test('подключение: ключ API обязателен, ключ проверяется в АТС, номера сотрудников', async () => {
  assert.equal((await req('PUT', '/api/pbx', 'm.volkova', { clubId: c1, kind: 'onlinepbx', domain: 'pbx1.onpbx.ru', apiKey: 'x' })).statusCode, 403);
  assert.equal((await req('PUT', '/api/pbx', 'a.bespalyy', { clubId: c1, kind: 'onlinepbx', domain: 'pbx1.onpbx.ru' })).statusCode, 400);
  assert.equal((await req('PUT', '/api/pbx', 'a.bespalyy', { clubId: c1, kind: 'onlinepbx', domain: 'не адрес', apiKey: 'x' })).statusCode, 400);
  const saved = await req('PUT', '/api/pbx', 'a.bespalyy', { clubId: c1, kind: 'onlinepbx', domain: 'https://PBX1.onpbx.ru/', apiKey: 'bad-key' });
  assert.equal(saved.statusCode, 200);
  connId = saved.json().id;
  const bad = (await req('POST', `/api/pbx/${connId}/test`, 'a.bespalyy')).json();
  assert.equal(bad.ok, false);
  assert.match(bad.info, /не приняла ключ/);
  // Новый ключ, адрес тот же; ключ в базе зашифрован
  await req('PUT', '/api/pbx', 'a.bespalyy', { clubId: c1, kind: 'onlinepbx', domain: 'pbx1.onpbx.ru', apiKey: 'good-key' });
  const ok = (await req('POST', `/api/pbx/${connId}/test`, 'a.bespalyy')).json();
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.users, [{ ext: '101', name: 'Мария Волкова' }, { ext: '102', name: 'Ольга' }]);
  // Номер расставлен по имени и фамилии; «Ольга» без фамилии — не угадываем
  assert.equal(ok.matched, 1);
  assert.deepEqual(await sql(`select ext from pbx_extensions x join users u on u.id = x.user_id where u.login = 'm.volkova'`), [{ ext: '101' }]);
  const [row] = await sql(`select secret_enc, domain from pbx_connections where id = $1`, [connId]);
  assert.equal(row.domain, 'pbx1.onpbx.ru');
  assert.ok(!String(row.secret_enc).includes('good-key'));

  // Управляющий настраивает телефонию только своего клуба
  assert.equal((await req('GET', `/api/pbx?clubId=${c1}`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('GET', `/api/pbx?clubId=${c1}`, 's.pavlov')).statusCode, 404);
  assert.equal((await req('POST', `/api/pbx/${connId}/test`, 's.pavlov')).statusCode, 404);
  const s = (await req('GET', `/api/pbx?clubId=${c1}`, 'a.bespalyy')).json();
  assert.match(s.connection.webhookUrl, new RegExp(`/api/hooks/pbx/${connId}/`));
  assert.equal(s.connection.hasKey, true);
  assert.equal(s.connection.webhookToken, undefined);
  hook = new URL(s.connection.webhookUrl).pathname;

  assert.equal((await req('PUT', `/api/pbx/${connId}/extensions`, 'a.bespalyy', { items: [{ userId: users['m.volkova'], ext: '5200' }] })).statusCode, 400);
  assert.equal((await req('PUT', `/api/pbx/${connId}/extensions`, 'a.bespalyy', { items: [{ userId: users['i.zuev'], ext: '103' }] })).statusCode, 400); // из другого клуба
  const ext = await req('PUT', `/api/pbx/${connId}/extensions`, 'a.bespalyy', { items: [{ userId: users['m.volkova'], ext: '101' }, { userId: users['o.astafeva'], ext: '102' }] });
  assert.equal(ext.json().count, 2);
});

test('вебхук: чужой секрет не принимается, тестовый запрос из кабинета — ок', async () => {
  assert.equal((await t.app.inject({ method: 'POST', url: `/api/hooks/pbx/${connId}/wrong`, payload: { event: 'call_start', uuid: 'x' } })).statusCode, 404);
  const r = await event({});
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().skipped, true);
});

test('входящий звонок: окно «Звонит клиент» у сотрудника, после ответа и завершения — исчезает', async () => {
  const d = Math.floor(Date.now() / 1000);
  await event({ event: 'call_start', uuid: 'in-1', direction: 'inbound', caller: '79030000108', callee: '74950000000', date: d });
  await event({ event: 'call_user_start', uuid: 'in-1', direction: 'inbound', caller: '79030000108', callee: '101', date: d });
  let live = (await req('GET', '/api/pbx/live', 'm.volkova')).json();
  assert.equal(live.enabled, true);
  assert.equal(live.calls.length, 1);
  assert.equal(live.calls[0].personName, 'Светлана Юдина');
  assert.match(live.calls[0].phone, /\*\*\*/);
  // Директор без внутреннего номера окна не получает
  assert.equal((await req('GET', '/api/pbx/live', 'a.bespalyy')).json().enabled, false);

  await event({ event: 'call_answered', uuid: 'in-1', direction: 'inbound', caller: '79030000108', callee: '101', date: d });
  assert.equal((await req('GET', '/api/pbx/live', 'm.volkova')).json().calls[0].answered, true);
  await event({ event: 'call_end', uuid: 'in-1', direction: 'inbound', caller: '79030000108', callee: '101', date: d + 50, call_duration: 55, dialog_duration: 50,
    download_url: 'https://records.onpbx.ru/in-1/rec.mp3' });
  // При дозвоне на группу АТС присылает «завершён» и по второму сотруднику — запись одна
  await event({ event: 'call_end', uuid: 'in-1', direction: 'inbound', caller: '79030000108', callee: '102', date: d + 50, dialog_duration: 50,
    download_url: 'https://records.onpbx.ru/in-1/rec.mp3' });
  live = (await req('GET', '/api/pbx/live', 'm.volkova')).json();
  assert.equal(live.calls.length, 0);
  const pending = await sql(`select count(*)::int as n from pbx_events where uuid = 'in-1' and record_status = 'pending'`);
  assert.equal(pending[0].n, 1);
});

test('запись разговора: CRM забирает файл и ставит звонок в очередь ИИ с клиентом и сотрудником', async () => {
  assert.equal(await processPbxRecords(t.pool, t.storage, fakeFetch, false), 1);
  const [c] = await sql(`select c.*, p.full_name from calls c left join persons p on p.id = c.person_id where external_id = 'pbx:in-1'`);
  assert.equal(c.source, 'pbx');
  assert.equal(c.direction, 'in');
  assert.equal(c.full_name, 'Светлана Юдина');
  assert.equal(c.user_id, users['m.volkova']);
  assert.equal(c.duration_sec, 50);
  assert.equal(c.asr_status, 'waiting_ai'); // ИИ-сервер в тесте не подключён: запись ждёт его
  assert.ok(c.file_id);
  const [e] = await sql(`select record_status, call_id from pbx_events where uuid = 'in-1' and record_status is not null`);
  assert.deepEqual([e.record_status, e.call_id], ['done', c.id]);
  // Повторный проход ничего не дублирует
  assert.equal(await processPbxRecords(t.pool, t.storage, fakeFetch, false), 0);
  // Звонок виден менеджеру в разделе «Звонки»
  const list = (await req('GET', `/api/calls?clubId=${c1}&scope=all`, 'm.volkova')).json();
  assert.ok((list.rows ?? list).some((r: { id: string }) => r.id === c.id));
});

test('ссылка из вебхука истекла: запись берётся заново через API по номеру звонка', async () => {
  recordMode = 'expired';
  const d = Math.floor(Date.now() / 1000);
  await event({ event: 'call_end', uuid: 'out-1', direction: 'outbound', caller: '101', callee: '79150000190', date: d, dialog_duration: 30,
    download_url: 'https://records.onpbx.ru/out-1/rec.mp3' });
  assert.equal(await processPbxRecords(t.pool, t.storage, fakeFetch, false), 1);
  assert.ok(seen.some((s) => s.url.endsWith('/mongo_history/search.json') && new URLSearchParams(s.body).get('uuid') === 'out-1'));
  const [c] = await sql(`select direction, phone from calls where external_id = 'pbx:out-1'`);
  assert.deepEqual([c.direction, c.phone], ['out', '+79150000190']);
  recordMode = 'ok';
});

test('пропущенный звонок: задача «Перезвонить» и уведомление, один раз на звонок', async () => {
  const d = Math.floor(Date.now() / 1000);
  for (const callee of ['101', '102']) await event({ event: 'call_missed', uuid: 'miss-1', direction: 'inbound', caller: '79991112233', callee, date: d });
  const tasks = await sql(`select assignee_id, title, kind from tasks where title like 'Перезвонить: пропущенный%'`);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, 'call');
  assert.match(tasks[0].title, /\+79991112233/);
  assert.equal(tasks[0].assignee_id, users['m.volkova']);
  const notes = await sql(`select count(*)::int as n from staff_notifications where kind = 'pbx_missed'`);
  assert.equal(notes[0].n, 1);
  // Короткий звонок без разговора: записи нет
  await event({ event: 'call_end', uuid: 'miss-1', direction: 'inbound', caller: '79991112233', callee: '101', date: d, dialog_duration: 0, download_url: 'https://records.onpbx.ru/m/rec.mp3' });
  assert.equal((await sql(`select count(*)::int as n from pbx_events where uuid = 'miss-1' and record_status is not null`))[0].n, 0);
});

test('звонок из карточки идёт через АТС на внутренний номер сотрудника', async () => {
  const [p] = await sql(`select id from persons where full_name = 'Кирилл Демин'`);
  seen.length = 0;
  const r = (await req('POST', `/api/persons/${p.id}/dial`, 'm.volkova')).json();
  assert.equal(r.mode, 'pbx');
  assert.equal(r.ext, '101');
  const call = seen.find((s) => s.url.endsWith('/call/now.json'))!;
  assert.equal(call.headers.get('x-pbx-authentication'), 'kid:kkk');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)), { from: '101', to: '79150000190' });
  // У сотрудника без внутреннего номера — как раньше, с телефона
  const [p2] = await sql(`select id from persons where full_name = 'Анна Ковалёва'`);
  const r2 = (await req('POST', `/api/persons/${p2.id}/dial`, 'i.zuev')).json();
  assert.equal(r2.mode, 'device');
  // АТС отключена — тоже с телефона
  await req('PUT', '/api/pbx', 'a.bespalyy', { clubId: c1, kind: 'onlinepbx', domain: 'pbx1.onpbx.ru', status: 'disabled' });
  assert.equal((await req('POST', `/api/persons/${p.id}/dial`, 'm.volkova')).json().mode, 'device');
  assert.equal((await event({ event: 'call_start', uuid: 'z', direction: 'inbound', caller: '79991112233', callee: '101' })).statusCode, 404);
});
