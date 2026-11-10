import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processPush, allowedEndpoint } from '../src/modules/mobile.ts';
import { loadVapid } from '../src/lib/webpush.ts';

type Sent = { url: string; headers: Record<string, string>; body: Buffer };
const sent: Sent[] = [];
const gone = new Set<string>();
const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
  sent.push({ url, headers: init.headers, body: Buffer.from(init.body) });
  return new Response(null, { status: gone.has(url) ? 410 : 201 });
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string;
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };

// «Телефон»: своя пара ключей, как у браузера
function device(name: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, sub: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${randomBytes(4).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
function decrypt(d: ReturnType<typeof device>, body: Buffer) {
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const shared = d.ecdh.computeSecret(asPub);
  const ikm = hmac(hmac(d.auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), d.ecdh.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const dc = createDecipheriv('aes-128-gcm', cek, nonce); dc.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dc.update(ct.subarray(0, ct.length - 16)), dc.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  c1 = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('подписка: только службы доставки уведомлений, ключи проверяются', async () => {
  assert.equal(allowedEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(allowedEndpoint('https://web.push.apple.com/abc'), true);
  assert.equal(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(allowedEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(allowedEndpoint('https://evil.example.com/x'), false);
  assert.equal(allowedEndpoint('https://127.0.0.1/x'), false);
  const key = (await req('GET', '/api/push/key', 'm.volkova')).json();
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/push/key' })).statusCode, 401);
  const d = device('bad');
  assert.equal((await req('POST', '/api/push/subscribe', 'm.volkova', { ...d.sub, endpoint: 'https://evil.example.com/x' })).statusCode, 400);
  assert.equal((await req('POST', '/api/push/subscribe', 'm.volkova', { ...d.sub, keys: { p256dh: 'abc', auth: 'x' } })).statusCode, 400);
});

test('новый лид и напоминание о задаче приходят на телефон зашифрованными; повторно не приходят', async () => {
  const d = device('volkova');
  assert.equal((await req('POST', '/api/push/subscribe', 'm.volkova', d.sub)).statusCode, 200);
  // Тестовое уведомление
  sent.length = 0;
  const tr = (await req('POST', '/api/push/test', 'm.volkova')).json();
  assert.equal(tr.sent, 1);
  assert.equal(decrypt(d, sent[0].body).body, 'Проверка: уведомления на этом устройстве работают');
  // Подпись VAPID проверяется открытым ключом сервера
  const auth = sent[0].headers.Authorization;
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
  const raw = Buffer.from(m[4], 'base64url');
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');

  // Новый лид, назначенный менеджеру
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Пуш Проверкин', phone: '+79007780001', sourceCode: 'site' })).json();
  // Задача через 5 минут
  await req('POST', '/api/tasks', 'm.volkova', { opportunityId: lead.opportunityId, title: 'Перезвонить по цене', dueAt: new Date(Date.now() + 5 * 60_000).toISOString(), kind: 'call' });
  sent.length = 0;
  const vapid = await loadVapid(t.pool);
  await processPush(t.pool, vapid, fakeFetch);
  const mine = sent.filter((s) => s.url === d.sub.endpoint).map((s) => decrypt(d, s.body));
  const leadNote = mine.find((p) => p.title === 'Новый лид' && p.body.startsWith('Пуш П.'));
  assert.ok(leadNote, JSON.stringify(mine));
  assert.match(leadNote.body, /^Пуш П\. · ответить до \d\d:\d\d$/);
  assert.ok(!JSON.stringify(mine).includes('79007780001'), 'телефон клиента в уведомление не попадает');
  const taskNote = mine.find((p) => p.title.startsWith('Задача в'));
  assert.ok(taskNote && taskNote.body.includes('Перезвонить по цене'));
  // Повторный проход ничего не шлёт
  sent.length = 0;
  await processPush(t.pool, vapid, fakeFetch);
  assert.equal(sent.filter((s) => s.url === d.sub.endpoint).length, 0);
});

test('настройки: можно отключить уведомления о задачах', async () => {
  const p = (await req('PUT', '/api/me/prefs', 'o.astafeva', { pushTasks: false })).json();
  assert.deepEqual(p, { pushTasks: false, pushLeads: true, pushMessages: true });
  const d = device('rop');
  await req('POST', '/api/push/subscribe', 'o.astafeva', d.sub);
  const opp = (await req('POST', '/api/leads', 'o.astafeva', { clubId: c1, fullName: 'Без Напоминаний', phone: '+79007780002', sourceCode: 'site' })).json();
  await req('POST', '/api/opportunities/' + opp.opportunityId + '/owner', 'o.astafeva', { ownerId: (await sql(`select id from users where login = 'o.astafeva'`))[0].id }).catch(() => null);
  await sql(`update tasks set done_at = now(), result = 'тест' where opportunity_id = $1 and kind = 'first_response'`, [opp.opportunityId]);
  await req('POST', '/api/tasks', 'o.astafeva', { opportunityId: opp.opportunityId, title: 'Не напоминать', dueAt: new Date(Date.now() + 3 * 60_000).toISOString(), kind: 'call' });
  sent.length = 0;
  await processPush(t.pool, await loadVapid(t.pool), fakeFetch);
  const got = sent.filter((s) => s.url === d.sub.endpoint).map((s) => decrypt(d, s.body));
  assert.ok(!got.some((g) => g.body.includes('Не напоминать')), JSON.stringify(got));
});

test('устройства: список, завершение сеанса на другом телефоне, уведомления на него прекращаются', async () => {
  const phone = (await login(t.app, 'm.volkova')).cookie!;
  const d = device('lost');
  await t.app.inject({ method: 'POST', url: '/api/push/subscribe', cookies: phone, payload: d.sub });
  const list = (await req('GET', '/api/me/sessions', 'm.volkova')).json();
  assert.ok(list.length >= 2);
  assert.equal(list[0].current, true);
  const lost = list.find((s: { current: boolean; push: boolean; id: string }) => !s.current && s.push);
  assert.ok(lost);
  assert.equal((await req('POST', `/api/me/sessions/${list[0].id}/revoke`, 'm.volkova')).statusCode, 400);
  assert.equal((await req('POST', `/api/me/sessions/${lost.id}/revoke`, 'm.volkova')).statusCode, 200);
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: phone })).statusCode, 401);
  assert.equal((await sql('select count(*)::int as n from push_subscriptions where endpoint = $1', [d.sub.endpoint]))[0].n, 0);
  // Чужой сеанс завершить нельзя
  const other = (await req('GET', '/api/me/sessions', 'o.smirnov')).json()[0].id;
  assert.equal((await req('POST', `/api/me/sessions/${other}/revoke`, 'm.volkova')).statusCode, 404);
});

test('увольнение или утеря телефона: управляющий завершает все сеансы сотрудника', async () => {
  const phone = (await login(t.app, 'm.volkova')).cookie!;
  const vid = (await sql(`select id from users where login = 'm.volkova'`))[0].id;
  const s = (await req('GET', `/api/staff/${vid}/sessions`, 'o.smirnov')).json();
  assert.ok(s.length >= 2);
  assert.equal((await req('GET', `/api/staff/${vid}/sessions`, 'm.volkova')).statusCode, 403);
  const r = (await req('POST', `/api/staff/${vid}/sessions/revoke`, 'o.smirnov')).json();
  assert.ok(r.revoked >= 2);
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: phone })).statusCode, 401);
  assert.equal((await sql(`select count(*)::int as n from push_subscriptions where user_id = $1`, [vid]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'staff.sessions_revoked' and object_id = $1`, [vid]))[0].n, 1);
  ck['m.volkova'] = (await login(t.app, 'm.volkova')).cookie!;
});

test('звонок в один клик: полный номер только по запросу и с записью в журнал; служба отписала устройство — подписка удаляется', async () => {
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Звонок Клик', phone: '+79007780003', sourceCode: 'site' })).json();
  const card = (await req('GET', `/api/persons/${lead.personId}`, 'm.volkova')).json();
  assert.ok(!JSON.stringify(card).includes('79007780003'), 'в карточке номер скрыт');
  const r = (await req('POST', `/api/persons/${lead.personId}/dial`, 'm.volkova')).json();
  assert.equal(r.phone, '+79007780003');
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'person.dial' and object_id = $1`, [lead.personId]))[0].n, 1);

  const d = device('gone');
  await req('POST', '/api/push/subscribe', 'm.volkova', d.sub);
  gone.add(d.sub.endpoint);
  await req('POST', '/api/push/test', 'm.volkova');
  assert.equal((await sql('select count(*)::int as n from push_subscriptions where endpoint = $1', [d.sub.endpoint]))[0].n, 0);
});
