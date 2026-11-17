// Статистика сотрудников для собственника: кто заходил за сутки, что открывал и делал, какие оставил замечания.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';
import { actionLabel } from '../src/modules/activity.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('понятные названия действий', () => {
  assert.equal(actionLabel('shift.opened'), 'Открыл кассовую смену');
  assert.equal(actionLabel('promo.created'), 'Акции: создал');
  assert.equal(actionLabel('loyalty.settings'), 'Бонусы: изменил настройки');
});

test('собственник видит по ролям: входы, разделы, действия, замечания; остальным нельзя', async () => {
  const centr = (await req('GET', '/api/clubs', 'd.lis')).json()[0].id;
  await req('POST', '/api/usage/view', 'd.lis', { tab: 'desk', label: 'Ресепшн' });
  await req('POST', '/api/usage/view', 'd.lis', { tab: 'finance', label: 'Финансы' });
  assert.equal((await req('POST', '/api/shifts/open', 'd.lis', { clubId: centr, openingCashKop: 500000 })).statusCode, 200);
  assert.equal((await req('POST', '/api/test-notes', 'a.kim', { pageKey: 'schedule', pageLabel: 'Расписание', kind: 'idea', body: 'Хочу видеть свободные окна' })).statusCode, 201);

  const gm = await req('GET', '/api/activity', 'o.smirnov'); // управляющему — только сотрудники своих клубов (проверка CRM 17.11.2026)
  assert.equal(gm.statusCode, 200, gm.body);
  assert.ok(!JSON.stringify(gm.json()).includes('Беспалый'), 'сетевых руководителей управляющий не видит');
  assert.equal((await req('GET', '/api/activity', 'd.lis')).statusCode, 403);
  const r = await req('GET', '/api/activity?hours=24', 'a.bespalyy');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.hours, 24);
  const names = d.roles.map((x: { name: string }) => x.name);
  for (const n of ['Собственник', 'Управляющий', 'Администратор ресепшн', 'Тренер', 'Менеджер ОП']) assert.ok(names.includes(n), n);
  const all = d.roles.flatMap((x: { people: unknown[] }) => x.people) as { fullName: string; active: boolean; logins: unknown[]; views: { tab: string }[]; actions: { label: string }[]; notes: { body: string; kindLabel: string }[] }[];
  const lis = all.find((p) => p.fullName === 'Дарья Лис')!;
  assert.ok(lis.active && lis.logins.length >= 1, 'вход ресепшна виден');
  assert.deepEqual(lis.views.map((v) => v.tab), ['desk', 'finance']);
  assert.ok(lis.actions.some((a) => a.label === 'Открыл кассовую смену'));
  const kim = all.find((p) => p.fullName === 'Артём Ким')!;
  assert.equal(kim.notes[0].body, 'Хочу видеть свободные окна');
  assert.equal(kim.notes[0].kindLabel, 'Пожелание');
  const quiet = all.find((p) => p.fullName === 'Игорь Зуев')!;
  assert.equal(quiet.active, false, 'кто не заходил — не активен');
  const desk = d.roles.find((x: { code: string }) => x.code === 'desk');
  assert.equal(desk.staff, 2); assert.equal(desk.active, 1);
});
