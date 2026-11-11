// Защита входа: личные пароли обязательны (общий или не сменённый пароль — на смену), ограничение попыток с одного адреса, сигнал о переборе.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login, PASSWORD } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const tryLogin = (l: string, password: string, ip: string) => t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: l, password }, remoteAddress: ip });

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('личные пароли: включение, принудительная смена, выдача временных паролей', async () => {
  // Управляющий клуба не управляет защитой сети
  assert.equal((await req('GET', '/api/security/login', 'o.smirnov')).statusCode, 403);
  let s = (await req('GET', '/api/security/login', 'a.bespalyy')).json();
  assert.equal(s.required, false);
  assert.ok(s.users.length >= 6 && s.users.every((u: { own: boolean }) => !u.own), 'тестовые учётки ни разу не меняли пароль');

  // Пока выключено — вход по общему паролю без смены
  const before = (await login(t.app, 'm.volkova')).res.json();
  assert.equal(before.mustChangePassword, false);

  assert.equal((await req('PUT', '/api/security/login', 'a.bespalyy', { required: true })).json().required, true);
  const forced = await login(t.app, 'm.volkova');
  assert.equal(forced.res.json().mustChangePassword, true, 'не сменённый пароль — на смену');
  // До смены пароля работать нельзя
  const blocked = await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: forced.cookie });
  assert.equal(blocked.statusCode, 403);
  // Свой пароль: после смены вход обычный
  const ch = await t.app.inject({ method: 'POST', url: '/api/auth/change-password', cookies: forced.cookie, payload: { currentPassword: PASSWORD, newPassword: 'Volkova-Own-Pass-7' } });
  assert.equal(ch.statusCode, 200);
  const again = await login(t.app, 'm.volkova', 'Volkova-Own-Pass-7');
  assert.equal(again.res.json().mustChangePassword, false);

  // Массовая выдача временных паролей: себя и собственника управляющий не трогает; пароль показывается один раз
  s = (await req('GET', '/api/security/login', 'a.bespalyy')).json();
  assert.equal(s.users.find((u: { login: string }) => u.login === 'm.volkova').own, true);
  const ids = s.users.filter((u: { login: string }) => ['d.lis', 'a.kim', 'a.bespalyy'].includes(u.login)).map((u: { id: string }) => u.id);
  const r = (await req('POST', '/api/security/login/reset', 'a.bespalyy', { userIds: ids })).json();
  assert.deepEqual(r.issued.map((x: { login: string }) => x.login).sort(), ['a.kim', 'd.lis']);
  const kim = r.issued.find((x: { login: string }) => x.login === 'a.kim');
  assert.equal((await login(t.app, 'a.kim')).res.statusCode, 401, 'общий пароль больше не подходит');
  assert.equal((await login(t.app, 'a.kim', kim.tempPassword)).res.json().mustChangePassword, true);
  await req('PUT', '/api/security/login', 'a.bespalyy', { required: false });
});

test('перебор с одного адреса: пауза после 20 неудач, сигнал о многих логинах', async () => {
  const ip = '203.0.113.7';
  const logins = ['o.smirnov', 'd.lis', 'e.orlova', 'nobody1', 'nobody2', 'a.kim'];
  for (let i = 0; i < 20; i++) {
    const r = await tryLogin(logins[i % logins.length], 'Wrong-password-1', ip);
    assert.equal(r.statusCode, 401, `попытка ${i + 1}`);
  }
  const stopped = await tryLogin('m.volkova', 'Volkova-Own-Pass-7', ip);
  assert.equal(stopped.statusCode, 429, 'даже верный пароль с этого адреса — пауза');
  assert.match(stopped.json().message, /с этого адреса.*через \d+ мин/);
  // С другого адреса вход работает
  assert.equal((await tryLogin('m.volkova', 'Volkova-Own-Pass-7', '198.51.100.2')).statusCode, 200);

  // Сигнал собственнику записан один раз и виден в разделе
  const al = await sql(`select count(*)::int as n from login_alerts where ip = $1`, [ip]);
  assert.equal(al[0].n, 1);
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'auth.ip_attack'`))[0].n, 1);
  const s = (await req('GET', '/api/security/login', 'a.bespalyy')).json();
  const row = s.ips.find((x: { ip: string }) => x.ip === ip);
  assert.ok(row.stopped && row.suspicious && row.logins >= 5);

  // Через окно адрес снова может входить
  await sql(`update login_attempts set at = at - interval '11 minutes' where ip = $1`, [ip]);
  assert.equal((await tryLogin('m.volkova', 'Volkova-Own-Pass-7', ip)).statusCode, 200);
});
