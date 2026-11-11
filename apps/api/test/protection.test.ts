// Защита базы клиентов, персональные данные (152-ФЗ) и состояние системы.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestApp, login } from './helpers.ts';
import { processChecks, runChecks, resetMonitorCounters } from '../src/modules/monitor.ts';
import { dueInWorkingDays } from '../src/modules/pd.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string };
before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'i.kotova', 'o.smirnov', 'o.astafeva', 'm.volkova', 'd.lis', 's.pavlov']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: ck['a.bespalyy'] })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
});
after(async () => { await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const newPerson = async (fullName: string, phone: string) =>
  (await req('POST', '/api/leads', 'd.lis', { clubId: centr.id, fullName, phone, sourceCode: 'walk_in' })).json().personId as string;
const setLimits = (b: Record<string, number>) => req('PUT', `/api/privacy/settings/${centr.id}`, 'o.smirnov', b);
const resetCounters = () => t.pool.query('select 1').then(async () => {
  const o = await import('pg');
  const c = new o.default.Client({ connectionString: t.ownerUrl }); await c.connect();
  await c.query('delete from pd_access_counters'); await c.end();
});

/* ---------- защита базы ---------- */
test('лимит полных номеров в час: сверх лимита отказ, управляющему — сигнал и задача', async () => {
  assert.equal((await setLimits({ revealsPerHour: 2 })).statusCode, 200);
  assert.equal((await req('PUT', `/api/privacy/settings/${centr.id}`, 'm.volkova', { revealsPerHour: 100 })).statusCode, 403);
  const pid = await newPerson('Звонок Лимитов', '+79005550101');
  assert.equal((await req('POST', `/api/persons/${pid}/dial`, 'm.volkova')).statusCode, 200);
  assert.equal((await req('POST', `/api/persons/${pid}/dial`, 'm.volkova')).statusCode, 200);
  const third = await req('POST', `/api/persons/${pid}/dial`, 'm.volkova');
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error, 'reveal_limit');
  // Управляющему лимит не мешает
  assert.equal((await req('POST', `/api/persons/${pid}/dial`, 'o.smirnov')).statusCode, 200);
  const alerts = (await req('GET', '/api/privacy/alerts', 'o.smirnov')).json();
  const a = alerts.find((x: { kind: string; login: string }) => x.kind === 'reveal' && x.login === 'm.volkova');
  assert.ok(a, 'сигнал о превышении лимита');
  const tasks = (await req('GET', `/api/tasks?clubId=${centr.id}`, 'o.smirnov')).json();
  assert.ok(tasks.some((x: { title: string }) => x.title.startsWith('Защита данных')), 'задача управляющему');
  // Разбор сигнала только с пояснением
  assert.equal((await req('POST', `/api/privacy/alerts/${a.id}/review`, 'o.smirnov', {})).statusCode, 400);
  assert.equal((await req('POST', `/api/privacy/alerts/${a.id}/review`, 'o.smirnov', { note: 'обзванивала продления по заданию РОПа' })).statusCode, 200);
  assert.ok(!(await req('GET', '/api/privacy/alerts', 'o.smirnov')).json().some((x: { id: string }) => x.id === a.id));
  // Управляющий другого клуба сигналов «Центра» не видит
  assert.ok(!(await req('GET', '/api/privacy/alerts?all=1', 's.pavlov')).json().some((x: { id: string }) => x.id === a.id));
  await setLimits({ revealsPerHour: 40 });
  await resetCounters();
});

test('договор с полным телефоном тоже считается раскрытием номера', async () => {
  await setLimits({ revealsPerHour: 1 });
  const any = (await t.pool.query(`select 1`)).rowCount;
  assert.equal(any, 1);
  // Достаточно проверить, что второй договор за час упирается в лимит (договор может и не существовать — лимит проверяется раньше)
  const fake = '00000000-0000-0000-0000-000000000000';
  const first = await req('GET', `/api/contracts/${fake}`, 'd.lis');
  assert.notEqual(first.statusCode, 429);
  assert.equal((await req('GET', `/api/contracts/${fake}`, 'd.lis')).statusCode, 429);
  await setLimits({ revealsPerHour: 40 });
  await resetCounters();
});

test('всплеск просмотров карточек: сигнал управляющему, работа не блокируется', async () => {
  await setLimits({ cardViewsAlert: 10 });
  const pid = await newPerson('Просмотр Карточек', '+79005550102');
  for (let i = 0; i < 11; i++) assert.equal((await req('GET', `/api/persons/${pid}`, 'm.volkova')).statusCode, 200);
  const alerts = (await req('GET', '/api/privacy/alerts', 'o.smirnov')).json();
  assert.ok(alerts.some((x: { kind: string; login: string; count: number }) => x.kind === 'card' && x.login === 'm.volkova' && x.count === 11));
  const act = (await req('GET', '/api/privacy/activity', 'o.smirnov')).json();
  assert.ok(act.access.some((x: { login: string; cards: number }) => x.login === 'm.volkova' && x.cards >= 11));
  await setLimits({ cardViewsAlert: 150 });
});

test('выгрузка с данными клиентов сверх лимита: запрос, одобрение управляющим, одна загрузка, подпись в файле', async () => {
  // Одна оплаченная продажа, чтобы в отчёте была строка с клиентом
  const pid = await newPerson('Продажа Отчёт', '+79005550110');
  const prod = (await req('GET', `/api/products?clubId=${centr.id}`, 'd.lis')).json().find((p: { kind: string }) => p.kind === 'term');
  const ms = (await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: prod.id })).json();
  const charge = (await req('GET', `/api/persons/${pid}/memberships`, 'd.lis')).json().find((x: { id: string }) => x.id === ms.id).charges[0];
  assert.equal((await req('POST', `/api/charges/${charge.id}/mark-paid`, 'd.lis', { method: 'card_terminal' })).statusCode, 200);
  await setLimits({ exportRowsLimit: 0 });
  const today = new Date().toISOString().slice(0, 10);
  const url = `/api/reports/sales?clubId=${centr.id}&from=${today.slice(0, 8)}01&to=${today}&format=csv`;
  const blocked = await req('GET', url, 'o.astafeva');
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'export_needs_approval');
  assert.match(blocked.json().message, /Запрос отправлен управляющему/);
  const again = await req('GET', url, 'o.astafeva');
  assert.match(again.json().message, /уже ждёт решения/);
  const list = (await req('GET', '/api/privacy/export-requests', 'o.smirnov')).json();
  const r = list.find((x: { status: string; userName: string }) => x.status === 'pending' && x.userName === 'Ольга Астафьева');
  assert.ok(r);
  // Свои запросы видит и сам сотрудник
  assert.ok((await req('GET', '/api/privacy/export-requests', 'o.astafeva')).json().some((x: { id: string }) => x.id === r.id));
  assert.equal((await req('POST', `/api/privacy/export-requests/${r.id}/decide`, 'o.astafeva', { approve: true })).statusCode, 403);
  assert.equal((await req('POST', `/api/privacy/export-requests/${r.id}/decide`, 'o.smirnov', { approve: false })).statusCode, 400);
  assert.equal((await req('POST', `/api/privacy/export-requests/${r.id}/decide`, 'o.smirnov', { approve: true })).statusCode, 200);
  // Другой формат того же отчёта — то же согласование
  const ok = await req('GET', url.replace('format=csv', 'format=xlsx'), 'o.astafeva');
  assert.equal(ok.statusCode, 200);
  const okCsv = await req('GET', url, 'o.astafeva');
  assert.equal(okCsv.statusCode, 403, 'одобрение действует на одну выгрузку');
  // Управляющий выгружает без согласования, в конце файла — кто выгрузил
  const gm = await req('GET', url, 'o.smirnov');
  assert.equal(gm.statusCode, 200);
  assert.match(gm.body, /Выгрузил: Олег Смирнов \(o\.smirnov\)/);
  // В журнале выгрузок видно одобренную
  const act = (await req('GET', '/api/privacy/activity', 'o.smirnov')).json();
  assert.ok(act.exports.some((x: { report: string; approved: boolean }) => x.report === 'sales' && x.approved));
  await setLimits({ exportRowsLimit: 200 });
});

test('поиск по базе считается и при всплеске даёт сигнал', async () => {
  await setLimits({ searchesAlert: 10 });
  for (let i = 0; i < 11; i++) await req('GET', `/api/persons?q=${encodeURIComponent('Иван')}`, 'm.volkova');
  const alerts = (await req('GET', '/api/privacy/alerts', 'o.smirnov')).json();
  assert.ok(alerts.some((x: { kind: string; login: string }) => x.kind === 'search' && x.login === 'm.volkova'));
  await setLimits({ searchesAlert: 150 });
  await resetCounters();
});

/* ---------- персональные данные ---------- */
test('согласия: текст по умолчанию, журнал согласий, реклама синхронизирует рассылки, новая версия текста', async () => {
  const texts = (await req('GET', '/api/consent-texts', 'm.volkova')).json();
  assert.equal(texts.pd[0].version, 1);
  assert.equal(texts.marketing[0].version, 1);
  const pid = await newPerson('Согласие Клиента', '+79005550103');
  assert.equal((await req('POST', `/api/persons/${pid}/consents`, 'm.volkova', { kind: 'pd', granted: true })).statusCode, 400, 'нужно указать бумагу или планшет');
  assert.equal((await req('POST', `/api/persons/${pid}/consents`, 'm.volkova', { kind: 'pd', granted: true, channel: 'paper' })).statusCode, 200);
  const st = (await req('POST', `/api/persons/${pid}/consents`, 'm.volkova', { kind: 'marketing', granted: true, channel: 'paper' })).json();
  assert.equal(st.pd.granted, true);
  assert.equal(st.pd.version, 1);
  assert.equal(st.marketing.granted, true);
  assert.equal((await req('GET', `/api/persons/${pid}`, 'm.volkova')).json().person.marketingConsent, true);
  // Старая галочка в карточке тоже пишет в журнал
  await req('POST', `/api/persons/${pid}/messaging`, 'm.volkova', { marketingConsent: false });
  const after = (await req('GET', `/api/persons/${pid}/consents`, 'm.volkova')).json();
  assert.equal(after.marketing.granted, false);
  assert.equal(after.history.length, 3);
  // Новый текст публикует только собственник сети
  const body = 'Новый текст согласия на обработку персональных данных с реквизитами оператора ООО «Клуб» и целями обработки.';
  assert.equal((await req('POST', '/api/consent-texts', 'o.smirnov', { kind: 'pd', title: 'Согласие', body })).statusCode, 403);
  const v2 = await req('POST', '/api/consent-texts', 'a.bespalyy', { kind: 'pd', title: 'Согласие на обработку ПДн', body });
  assert.equal(v2.statusCode, 201);
  assert.equal(v2.json().version, 2);
  const pid2 = await newPerson('Второе Согласие', '+79005550104');
  const s2 = (await req('POST', `/api/persons/${pid2}/consents`, 'd.lis', { kind: 'pd', granted: true, channel: 'tablet' })).json();
  assert.equal(s2.pd.version, 2);
  // Тренер согласия не отмечает
  const tr = (await login(t.app, 'a.kim')).cookie!;
  assert.equal((await t.app.inject({ method: 'POST', url: `/api/persons/${pid2}/consents`, cookies: tr, payload: { kind: 'pd', granted: true, channel: 'paper' } })).statusCode, 403);
});

test('согласия из формы на сайте сохраняются вместе с заявкой', async () => {
  const sources = (await req('GET', '/api/lead-sources', 'i.kotova')).json();
  const site = sources.find((s: { code: string }) => s.code === 'site');
  const { apiKey } = (await req('POST', `/api/lead-sources/${site.id}/api-key`, 'i.kotova')).json();
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/leads', headers: { authorization: `Bearer ${apiKey}` },
    payload: { clubId: centr.id, fullName: 'Сайт Согласие', phone: '+79005550105', consents: { pd: true, marketing: false } } });
  assert.equal(r.statusCode, 201);
  const pid = (await req('GET', `/api/persons?q=${encodeURIComponent('Сайт Согласие')}`, 'a.bespalyy')).json()[0].id;
  const st = (await req('GET', `/api/persons/${pid}/consents`, 'm.volkova')).json();
  assert.equal(st.pd.granted, true);
  assert.equal(st.pd.channel, 'site');
  assert.equal(st.marketing.granted, false);
});

test('срок ответа на обращение — 10 рабочих дней', () => {
  assert.equal(dueInWorkingDays('2026-11-11'), '2026-11-25'); // среда → среда через две недели
  assert.equal(dueInWorkingDays('2026-11-14'), '2026-11-27'); // суббота → пятница через две недели
});

test('обращение клиента: срок и задача управляющему; выгрузка сведений; обезличивание только без абонемента и долгов', async () => {
  const pid = await newPerson('Удалить Меня', '+79005550106');
  const created = await req('POST', `/api/persons/${pid}/pd-requests`, 'd.lis', { kind: 'delete', receivedOn: '2026-11-11', note: 'заявление на ресепшн' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().dueOn, '2026-11-25');
  const list = (await req('GET', `/api/pd-requests?clubId=${centr.id}`, 'o.smirnov')).json();
  const r = list.find((x: { personId: string }) => x.personId === pid);
  assert.equal(r.status, 'open');
  const tasks = (await req('GET', `/api/tasks?clubId=${centr.id}`, 'o.smirnov')).json();
  assert.ok(tasks.some((x: { title: string }) => x.title.includes('Обращение по персональным данным: удалить данные')));
  // Выгрузка сведений для клиента
  const ex = await req('GET', `/api/persons/${pid}/pd-export`, 'o.smirnov');
  assert.equal(ex.statusCode, 200);
  assert.equal(ex.json()['Клиент']['ФИО'], 'Удалить Меня');
  assert.equal((await req('GET', `/api/persons/${pid}/pd-export`, 'm.volkova')).statusCode, 403);
  // Действующий абонемент мешает обезличиванию
  const prod = (await req('GET', `/api/products?clubId=${centr.id}`, 'a.bespalyy')).json().find((p: { kind: string }) => p.kind === 'term');
  const sold = await req('POST', '/api/memberships', 'd.lis', { personId: pid, productId: prod.id });
  assert.equal(sold.statusCode, 201);
  const conf = { reason: 'заявление клиента от 11.11.2026', confirm: 'ОБЕЗЛИЧИТЬ', requestId: r.id };
  assert.equal((await req('POST', `/api/persons/${pid}/anonymize`, 'o.smirnov', { ...conf, confirm: 'да' })).statusCode, 400);
  const busy = await req('POST', `/api/persons/${pid}/anonymize`, 'o.smirnov', conf);
  assert.equal(busy.statusCode, 400);
  assert.match(busy.json().error, /has_active_membership|has_debt/);
  // Клиент без абонемента: обезличиваем
  const pid2 = await newPerson('Стереть Данные', '+79005550107');
  const r2 = (await req('POST', `/api/persons/${pid2}/pd-requests`, 'o.smirnov', { kind: 'delete' })).json();
  assert.equal((await req('POST', `/api/persons/${pid2}/anonymize`, 'd.lis', { reason: 'заявление', confirm: 'ОБЕЗЛИЧИТЬ' })).statusCode, 403);
  const done = await req('POST', `/api/persons/${pid2}/anonymize`, 'o.smirnov', { reason: 'заявление клиента', confirm: 'ОБЕЗЛИЧИТЬ', requestId: r2.id });
  assert.equal(done.statusCode, 200);
  const card = (await req('GET', `/api/persons/${pid2}`, 'o.smirnov')).json();
  assert.match(card.person.fullName, /^Обезличенный клиент/);
  assert.equal(card.contacts.length, 0);
  assert.ok(!(await req('GET', `/api/persons?q=${encodeURIComponent('Стереть')}`, 'a.bespalyy')).json().length, 'по старому имени не находится');
  assert.ok(!(await req('GET', '/api/persons?q=5550107', 'a.bespalyy')).json().length, 'по старому телефону не находится');
  const closed = (await req('GET', `/api/pd-requests?clubId=${centr.id}&status=done`, 'o.smirnov')).json();
  assert.ok(closed.some((x: { id: string }) => x.id === r2.id));
  assert.equal((await req('POST', `/api/persons/${pid2}/anonymize`, 'o.smirnov', { reason: 'ещё раз', confirm: 'ОБЕЗЛИЧИТЬ' })).statusCode, 400);
  // Журнал согласий нельзя переписать
  const o = await import('pg');
  const c = new o.default.Client({ connectionString: t.ownerUrl.replace('fitnes_owner:fitnes_owner_ci', 'fitnes_app:fitnes_app_ci') }); await c.connect();
  await c.query(`select set_config('app.tenant_id', (select tenant_id::text from persons where id = $1), false)`, [pid2]);
  await assert.rejects(c.query('delete from person_consents'));
  await c.end();
  // Обращение закрывается с ответом
  assert.equal((await req('POST', `/api/pd-requests/${r.id}/complete`, 'o.smirnov', { status: 'done' })).statusCode, 400);
  assert.equal((await req('POST', `/api/pd-requests/${r.id}/complete`, 'o.smirnov', { status: 'rejected', result: 'Действующий договор: удалим после окончания' })).statusCode, 200);
});

/* ---------- состояние системы ---------- */
test('состояние системы: доступ, проверки, оповещение о сбое и о восстановлении', async () => {
  assert.equal((await req('GET', '/api/system/status', 'o.smirnov')).statusCode, 403);
  const st = await req('GET', '/api/system/status?refresh=1', 'i.kotova');
  assert.equal(st.statusCode, 200);
  const codes = st.json().checks.map((c: { code: string }) => c.code);
  for (const c of ['db', 'disk', 'backup', 'errors', 'receipts', 'messages', 'autopay']) assert.ok(codes.includes(c), c);

  const sent: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body).text); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const env = { ALERT_TELEGRAM_BOT_TOKEN: 'x', ALERT_TELEGRAM_CHAT_ID: '1', PUBLIC_URL: 'test' } as NodeJS.ProcessEnv;
  const backupDir = mkdtempSync(join(tmpdir(), 'fitnes-backups-'));
  const opts = { storage: t.storage, backupDir, fetch: fakeFetch, env };
  resetMonitorCounters();
  await processChecks(t.pool, await runChecks(t.pool, opts), opts);
  assert.ok(sent.some((s) => s.includes('Резервная копия: ни одной успешной копии')), 'сообщение о сбое');
  const n = sent.length;
  await processChecks(t.pool, await runChecks(t.pool, opts), opts);
  assert.equal(sent.length, n, 'повторно сразу не пишем');
  writeFileSync(join(backupDir, 'last-ok'), '');
  await processChecks(t.pool, await runChecks(t.pool, opts), opts);
  assert.ok(sent.some((s) => s.includes('Восстановлено: Резервная копия')), 'сообщение о восстановлении');
  const after = (await req('GET', '/api/system/status', 'i.kotova')).json();
  assert.equal(after.checks.find((c: { code: string; scope: string }) => c.code === 'backup' && c.scope === 'platform').status, 'ok');
});
