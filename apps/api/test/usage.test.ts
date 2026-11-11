// «Сообщить о проблеме» с техническими сведениями и статистика использования разделов.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('обращение с экрана: раздел, версия и сбои без телефонов, почты и параметров адреса', async () => {
  const r = await req('POST', '/api/support', 'd.lis', {
    subject: 'Ресепшн: не проходит оплата', body: 'Нажала оплатить — ошибка', kind: 'bug', page: 'desk', appVersion: '2026-11-11 10:00',
    clientInfo: 'web; 1280×800; Chrome',
    techLog: [{ at: '2026-11-11T10:00:00Z', kind: 'api', text: 'POST /api/desk/renew?phone=+79161234567 → 400 bad: клиент +7 916 123-45-67 ivan@mail.ru' }],
  });
  assert.equal(r.statusCode, 201);
  // Автор не видит технические сведения, собственник (поддержка сети) видит очищенные
  const mine = (await req('GET', `/api/support/${r.json().id}`, 'd.lis')).json();
  assert.equal(mine.techLog, undefined);
  const full = (await req('GET', `/api/support/${r.json().id}`, 'a.bespalyy')).json();
  assert.equal(full.page, 'desk');
  assert.equal(full.appVersion, '2026-11-11 10:00');
  const text = full.techLog[0].text as string;
  assert.ok(!text.includes('7916') && !text.includes('916 123') && !text.includes('ivan@'), text);
  assert.match(text, /POST \/api\/desk\/renew → 400/);
  assert.match(text, /\[номер\].*\[почта\]/);
});

test('статистика использования: открытия разделов, роли, кто не заходил', async () => {
  for (const tab of ['desk', 'desk', 'home']) await req('POST', '/api/usage/view', 'd.lis', { tab, label: tab === 'desk' ? 'Ресепшн' : 'Клиенты' });
  await req('POST', '/api/usage/view', 'o.smirnov', { tab: 'dash', label: 'Рабочий стол' });
  assert.equal((await req('POST', '/api/usage/view', 'd.lis', { tab: 'bad tab!' })).statusCode, 400);
  // Управляющий клуба статистику сети не видит
  assert.equal((await req('GET', '/api/usage', 'o.smirnov')).statusCode, 403);
  const u = (await req('GET', '/api/usage?days=7', 'a.bespalyy')).json();
  assert.equal(u.days, 7);
  const desk = u.sections.find((s: { tab: string }) => s.tab === 'desk');
  assert.deepEqual([desk.opens, desk.users, desk.label], [2, 1, 'Ресепшн']);
  const lis = u.people.find((p: { fullName: string }) => p.fullName === 'Дарья Лис');
  assert.deepEqual([lis.activeDays, lis.opens], [1, 3]);
  assert.ok(u.people.some((p: { activeDays: number }) => p.activeDays === 0), 'есть сотрудники, которые не заходили');
  const deskRole = u.roles.find((r: { role: string }) => r.role === 'Администратор ресепшн');
  assert.equal(deskRole.active, 1);
  assert.equal(deskRole.top[0].tab, 'desk');
  assert.equal(u.daily.length, 1);
});
