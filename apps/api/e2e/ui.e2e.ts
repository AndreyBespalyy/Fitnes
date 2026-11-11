// Автотесты интерфейса: 10 главных сценариев в настоящем браузере (список «20 улучшений», п. 13).
// Сервер поднимается на чистой тестовой базе с собранным веб-приложением (npm run build), браузер — Chromium из Playwright.
// Запуск: npm run build && npm run test:e2e -w apps/api
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Browser, BrowserContext, Page } from 'playwright';
import { setupTestApp, PASSWORD } from '../test/helpers.ts';

// Playwright берём из окружения (в CI ставится отдельно), в зависимости проекта его не тянем
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

let t: Awaited<ReturnType<typeof setupTestApp>>;
let browser: Browser;
let base = '';
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };

before(async () => {
  assert.ok(existsSync(join(webDist, 'index.html')), 'Сначала соберите веб-приложение: npm run build');
  t = await setupTestApp({ webDist });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
});
after(async () => { await browser?.close(); await t?.app.close(); await t?.pool.end(); });

const errors = new WeakMap<Page, string[]>();
async function open(login: string, opts: { mobile?: boolean; password?: string } = {}): Promise<{ ctx: BrowserContext; p: Page }> {
  const ctx = await browser.newContext({ locale: 'ru-RU', ...(opts.mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } }) });
  const p = await ctx.newPage();
  const errs: string[] = []; errors.set(p, errs);
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(base);
  await p.getByLabel('Логин').fill(login);
  await p.getByLabel('Пароль').fill(opts.password ?? PASSWORD);
  const resp = p.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
  await p.getByRole('button', { name: 'Войти' }).click();
  assert.equal((await resp).status(), 200, `вход ${login}`);
  return { ctx, p };
}
const tab = (p: Page, name: string) => p.locator('.main-tabs').getByRole('button', { name, exact: true }).click();
const noErrors = (p: Page) => assert.deepEqual(errors.get(p), [], 'ошибок на странице нет');
const toast = (p: Page, text: RegExp) => p.locator('.toast').filter({ hasText: text }).first().waitFor({ timeout: 8000 });

test('1. вход с временным паролем: обязательная смена и работа после неё', async () => {
  await sql(`update users set must_change_password = true where login = 'a.kim'`);
  const { ctx, p } = await open('a.kim');
  await p.getByLabel('Временный пароль').fill(PASSWORD);
  await p.getByLabel('Новый пароль', { exact: true }).fill('Kim-New-Pass-2026');
  await p.getByLabel('Повторите новый пароль').fill('Kim-New-Pass-2026');
  await p.getByRole('button', { name: 'Сохранить пароль' }).click();
  await p.locator('.main-tabs').waitFor();
  assert.equal((await sql(`select must_change_password as m from users where login = 'a.kim'`))[0].m, false);
  noErrors(p); await ctx.close();
});

test('2. менеджер создаёт лид: появляется у клиента и задача первого ответа', async () => {
  const { ctx, p } = await open('m.volkova');
  await tab(p, 'Лиды');
  await p.getByPlaceholder('Анна Иванова').fill('Тест Интерфейсов');
  await p.getByPlaceholder('+7 900 000-00-00').fill('+7 916 777-00-01');
  await p.getByLabel('Откуда узнал (обязательно)').selectOption({ index: 1 });
  await p.getByRole('button', { name: 'Создать лид' }).click();
  await toast(p, /Лид создан/);
  const task = await sql(`select t.kind from tasks t join persons pr on pr.id = t.person_id where pr.full_name = 'Тест Интерфейсов'`);
  assert.equal(task[0]?.kind, 'first_response');
  noErrors(p); await ctx.close();
});

test('3. продажа абонемента в карточке и оплата картой', async () => {
  const { ctx, p } = await open('d.lis');
  await tab(p, 'Клиенты');
  await p.getByLabel('Поиск клиента').fill('Тест Интерфейсов');
  await p.getByRole('button', { name: 'Тест Интерфейсов' }).first().click();
  await p.getByRole('button', { name: '+ Продать' }).click();
  const opt = await p.getByLabel('Тариф').locator('option', { hasText: 'Месяц безлимит' }).first().getAttribute('value');
  await p.getByLabel('Тариф').selectOption(opt!);
  await p.getByRole('button', { name: 'Оформить' }).click();
  await toast(p, /Продано/);
  await p.getByRole('button', { name: 'Картой' }).first().click();
  await toast(p, /Оплата картой отмечена/);
  const m = await sql(`select c.status from charges c join memberships m on m.id = c.membership_id join persons pr on pr.id = m.person_id where pr.full_name = 'Тест Интерфейсов'`);
  assert.ok(m.length && m.every((x) => x.status === 'paid'));
  noErrors(p); await ctx.close();
});

test('4. ресепшн: поиск по телефону и проход', async () => {
  // Тест не должен зависеть от времени запуска: в CI ночью по Москве клуб «закрыт». Одинаковые часы — круглосуточно
  await sql(`insert into club_access_settings(club_id, tenant_id, open_from, open_to) select id, tenant_id, '00:00', '00:00' from clubs
    on conflict (club_id) do update set open_from = '00:00', open_to = '00:00'`);
  const { ctx, p } = await open('d.lis');
  await tab(p, 'Ресепшн');
  await p.getByLabel('Поиск клиента').fill('7770001');
  await p.locator('.desk-found').getByText('Тест Интерфейсов').first().click();
  await p.locator('.desk-verdict').waitFor();
  assert.match(await p.locator('.desk-verdict').innerText(), /Можно/);
  await p.getByRole('button', { name: /^Пропустить/ }).click();
  await p.locator('.desk-done.ok').waitFor();
  const v = await sql(`select count(*)::int as n from visits v join persons pr on pr.id = v.person_id where pr.full_name = 'Тест Интерфейсов'`);
  assert.equal(v[0].n, 1);
  noErrors(p); await ctx.close();
});

test('5. ссылка на карточку клиента и кнопка «Назад»', async () => {
  const { ctx, p } = await open('m.volkova');
  await tab(p, 'Клиенты');
  await p.getByLabel('Поиск клиента').fill('Тест Интерфейсов');
  await p.getByRole('button', { name: 'Тест Интерфейсов' }).first().click();
  await p.getByText('Карточка клиента').waitFor();
  assert.match(p.url(), /\?tab=home&person=[0-9a-f-]{36}$/);
  const link = p.url();
  await p.goBack();
  await p.getByText('Карточка клиента').waitFor({ state: 'detached' });
  assert.match(p.url(), /\?tab=home$/);
  // Коллега открывает ссылку — сразу карточка
  const other = await ctx.newPage();
  await other.goto(link);
  await other.getByText('Карточка клиента').waitFor();
  await other.getByText('Тест Интерфейсов').first().waitFor();
  noErrors(p); await ctx.close();
});

test('6. расписание: запись клиента на занятие', async () => {
  // Занятие заводит управляющий (через API, как подготовка), записывает ресепшн — в интерфейсе
  const { ctx: g } = await open('o.smirnov');
  const api = g.request;
  const centr = (await (await api.get(`${base}/api/clubs`)).json()).find((c: { name: string }) => c.name.includes('Центр')).id;
  const room = (await (await api.post(`${base}/api/schedule/rooms`, { data: { clubId: centr, name: 'Зал E2E', capacity: 10 } })).json()).id;
  const type = (await (await api.post(`${base}/api/schedule/types`, { data: { clubId: centr, name: 'Пилатес E2E', kind: 'group', durationMin: 60, capacity: 5 } })).json()).id;
  const start = (await sql(`select to_char(now() at time zone 'Europe/Moscow' + interval '26 hours', 'YYYY-MM-DD"T"HH24:MI') as v`))[0].v;
  const kim = (await sql(`select id from users where login = 'a.kim'`))[0].id;
  const created = await (await api.post(`${base}/api/schedule/sessions`, { data: { clubId: centr, typeId: type, roomId: room, trainerId: kim, start } })).json();
  await g.close();
  const sid = created.ids?.[0] ?? created.id ?? (await sql(`select id from class_sessions order by created_at desc limit 1`))[0].id;

  const { ctx, p } = await open('d.lis');
  await p.goto(`${base}/?tab=schedule&session=${sid}`);
  await p.getByText('Записать клиента').waitFor({ timeout: 8000 });
  await p.getByPlaceholder('Имя или телефон клиента').fill('Тест Интерфейсов');
  await p.getByRole('button', { name: 'Записать', exact: true }).first().click();
  await toast(p, /Записан|листе ожидания/);
  const b = await sql(`select count(*)::int as n from class_bookings b join persons pr on pr.id = b.person_id where pr.full_name = 'Тест Интерфейсов'`);
  assert.equal(b[0].n, 1);
  noErrors(p); await ctx.close();
});

test('7. настройки клуба: черновик, проверка, утверждение и публикация', async () => {
  const { ctx, p } = await open('o.smirnov');
  await tab(p, 'Настройки клуба');
  await p.getByRole('button', { name: 'Нормы KPI и светофор плана' }).click();
  const input = p.locator('.card').filter({ hasText: 'Изменить вручную' }).locator('input[inputmode=decimal]').first();
  const was = await input.inputValue();
  await input.fill(String(Number(was || 0) + 5));
  await p.getByRole('button', { name: /Сохранить как черновик/ }).click();
  await p.getByRole('button', { name: /^Проверить$/ }).click();
  await toast(p, /Проверка выполнена/);
  await p.getByRole('button', { name: 'Утвердить' }).click();
  await toast(p, /Утверждено/);
  await p.getByRole('button', { name: 'Опубликовать' }).click();
  await toast(p, /Опубликовано/);
  const v = await sql(`select count(*)::int as n from config_versions where status = 'published' and published_at > now() - interval '2 minutes'`);
  assert.equal(v[0].n, 1, 'новая версия опубликована');
  noErrors(p); await ctx.close();
});

test('8. сообщить о проблеме: обращение с разделом попадает в поддержку', async () => {
  const { ctx, p } = await open('e.orlova');
  await tab(p, 'Финансы');
  await p.getByRole('button', { name: 'Сообщить о проблеме' }).click();
  await p.getByRole('dialog').locator('textarea').fill('Не сходится касса за вчера');
  await p.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
  await toast(p, /Обращение № \d+ отправлено/);
  const r = await sql(`select subject, page from support_tickets order by created_at desc limit 1`);
  assert.deepEqual([r[0].page, r[0].subject], ['finance', 'Финансы: Не сходится касса за вчера']);
  noErrors(p); await ctx.close();
});

test('9. телефон: нижняя панель, «Ещё» и переходы', async () => {
  const { ctx, p } = await open('m.volkova', { mobile: true });
  const nav = p.getByRole('navigation', { name: 'Главные разделы' });
  await nav.waitFor();
  assert.ok(await nav.getByRole('button').count() >= 3);
  await nav.getByRole('button', { name: /Ещё/ }).click();
  await p.locator('.main-tabs.open').waitFor();
  await p.locator('.main-tabs.open').getByRole('button', { name: 'Профиль', exact: true }).click();
  assert.match(p.url(), /\?tab=profile$/);
  noErrors(p); await ctx.close();
});

test('10. собственник: рабочий стол, прибыль, удержание, загрузка открываются без ошибок', async () => {
  const { ctx, p } = await open('a.bespalyy');
  await p.locator('.main-tabs').waitFor();
  for (const name of ['Прибыль', 'Удержание', 'Загрузка', 'Финансы', 'Использование', 'Приём заявок', 'Рабочий стол']) {
    await tab(p, name);
    await p.waitForLoadState('networkidle');
    assert.equal(await p.locator('.main-tabs').getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true', name);
    assert.equal(await p.getByText('Раздел не загрузился').count(), 0, name);
  }
  noErrors(p); await ctx.close();
});
