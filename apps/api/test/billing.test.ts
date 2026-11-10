import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { tbankToken } from '../src/modules/payProviders.ts';
import { parseStatement, decodeStatement } from '../src/modules/bank.ts';

// Заглушка ЮKassa
let ykPayment: Record<string, unknown> = {};
const ykCalls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://api.yookassa.ru/v3/')) {
    ykCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/me')) return ok({ account_id: '123', test: true });
    if (url.endsWith('/payments') && init?.method === 'POST') return ok({ id: 'yk-1', status: 'pending', confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=yk-1' } });
    if (url.includes('/payments/yk-1')) return ok(ykPayment);
  }
  return ok({ error: 'unexpected ' + url }, 404);
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
let app: Awaited<ReturnType<typeof setupTestApp>>['app'];
const ck: Record<string, Record<string, string>> = {};
let c1: string; let c2: string;
const req = (method: string, url: string, who: string | null, payload?: unknown, headers?: Record<string, string>) =>
  app.inject({ method: method as 'GET', url, cookies: who ? ck[who] : undefined, payload: payload as object, headers });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const pid = async (name: string) => (await sql('select id from persons where full_name = $1', [name]))[0].id as string;
const form = (o: Record<string, string>) => ({ payload: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const testPay = (id: string, o: Record<string, string>) => app.inject({ method: 'POST', url: `/pay/${id}/test`, ...form(o) });

/** Продажа клиенту и его неоплаченное начисление */
async function dueCharge(person: string, product: string, who = 'o.smirnov') {
  const pr = (await sql('select id from products where name = $1 limit 1', [product]))[0].id;
  const r = await req('POST', '/api/memberships', who, { personId: await pid(person), productId: pr });
  assert.equal(r.statusCode, 201, r.body);
  return (await sql(`select id from charges where membership_id = $1 order by due_on limit 1`, [r.json().id]))[0].id as string;
}

before(async () => {
  t = await setupTestApp();
  const { buildApp } = await import('../src/app.ts');
  app = await buildApp(t.pool, { fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 's.pavlov', 'm.volkova', 'd.lis', 'e.orlova']) ck[l] = (await login(app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  c1 = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  c2 = clubs.find((c: { name: string }) => c.name.includes('Север')).id;
});
after(async () => { await app.close(); await t.app.close(); await t.pool.end(); });

test('настройка банка: по умолчанию тестовый, ключи не возвращаются, права', async () => {
  const s = (await req('GET', `/api/clubs/${c1}/acquiring`, 'o.smirnov')).json();
  assert.deepEqual([s.provider, s.live], ['test', false]);
  assert.equal((await req('GET', `/api/clubs/${c1}/acquiring`, 'm.volkova')).statusCode, 403);
  assert.equal((await req('PUT', `/api/clubs/${c1}/acquiring`, 'o.smirnov', { provider: 'tbank', shopId: '1700000000000DEMO' })).statusCode, 400);
  assert.equal((await req('PUT', `/api/clubs/${c1}/acquiring`, 'o.smirnov', { provider: 'test', live: true })).statusCode, 400);
  const r = await req('POST', `/api/clubs/${c1}/acquiring/test`, 'o.smirnov');
  assert.match(r.json().info, /Тестовый банк/);
});

test('ссылка на оплату в тестовом банке: отказ, потом оплата через СБП, чек и журнал', async () => {
  const ch = await dueCharge('Светлана Юдина', 'Месяц безлимит', 'm.volkova');
  const l1 = (await req('POST', `/api/charges/${ch}/pay-link`, 'm.volkova', {})).json();
  assert.match(l1.url, /\/pay\/[0-9a-f-]{36}$/);
  // Повторный запрос даёт ту же ссылку
  assert.equal((await req('POST', `/api/charges/${ch}/pay-link`, 'm.volkova', {})).json().id, l1.id);
  const pageHtml = (await app.inject({ method: 'GET', url: `/pay/${l1.id}` })).body;
  assert.match(pageHtml, /ТЕСТОВЫЙ БАНК/); assert.match(pageHtml, /6\s500/);
  assert.equal((await testPay(l1.id, { method: 'card', card: '4000 0000 0000 0002', result: 'pay' })).statusCode, 303);
  assert.match((await app.inject({ method: 'GET', url: `/pay/${l1.id}` })).body, /Оплата не прошла/);
  assert.equal((await sql('select status from charges where id = $1', [ch]))[0].status, 'due');
  const l2 = (await req('POST', `/api/charges/${ch}/pay-link`, 'm.volkova', {})).json();
  assert.notEqual(l2.id, l1.id);
  await testPay(l2.id, { method: 'sbp', card: '', result: 'pay' });
  assert.match((await app.inject({ method: 'GET', url: `/pay/${l2.id}` })).body, /Оплата прошла/);
  const c = (await sql('select status, paid_method from charges where id = $1', [ch]))[0];
  assert.deepEqual([c.status, c.paid_method], ['paid', 'sbp']);
  assert.equal((await sql(`select count(*)::int as n from payments where charge_id = $1 and method = 'sbp'`, [ch]))[0].n, 1);
  // Повторная отправка формы ничего не меняет
  await testPay(l2.id, { method: 'sbp', result: 'pay' });
  assert.equal((await sql(`select count(*)::int as n from payments where charge_id = $1`, [ch]))[0].n, 1);
  assert.equal((await req('POST', `/api/charges/${ch}/pay-link`, 'm.volkova', {})).statusCode, 400);
  const list = (await req('GET', `/api/online-payments?clubId=${c1}`, 'e.orlova')).json();
  assert.ok(list.some((o: { id: string; status: string }) => o.id === l2.id && o.status === 'succeeded'));
});

test('ссылка уходит клиенту в мессенджер', async () => {
  const ch = await dueCharge('Павел Рябов', 'Гостевой визит');
  const r = (await req('POST', `/api/charges/${ch}/pay-link`, 'm.volkova', { send: true })).json();
  assert.equal(r.sent, true);
  const m = await sql(`select body, status from msg_messages where body like 'Ссылка на оплату%' order by created_at desc limit 1`);
  assert.match(m[0].body, new RegExp(`/pay/${r.id}`));
  assert.equal(m[0].status, 'sent');
});

test('подписка: новый период, автосписание с карты, отказ банка и повтор через интервал', async () => {
  const fed = await pid('Роман Фёдоров'); const akh = await pid('Тимур Ахметов');
  await sql(`update memberships set next_charge_on = (now() at time zone 'Europe/Moscow')::date where person_id = $1`, [fed]);
  const before = (await sql(`select to_char(ends_on, 'YYYY-MM-DD') as e from memberships where person_id = $1`, [fed]))[0].e;
  assert.equal((await req('POST', '/api/billing/run', 'm.volkova', { clubId: c2 })).statusCode, 403);
  const r = (await req('POST', '/api/billing/run', 's.pavlov', { clubId: c2 })).json();
  assert.equal(r.periods, 1);
  assert.equal(r.charged, 1);
  assert.ok(r.failed >= 1);
  const after1 = (await sql(`select to_char(ends_on, 'YYYY-MM-DD') as e from memberships where person_id = $1`, [fed]))[0].e;
  assert.ok(after1 > before);
  const paid = await sql(`select status, paid_method from charges where person_id = $1 and kind = 'subscription' order by due_on desc limit 1`, [fed]);
  assert.deepEqual([paid[0].status, paid[0].paid_method], ['paid', 'online']);
  const a = (await sql(`select autopay_attempts, autopay_error, autopay_next_on > (now() at time zone 'Europe/Moscow')::date as later from charges where person_id = $1 and status = 'due'`, [akh]))[0];
  assert.deepEqual([a.autopay_attempts, a.autopay_error, a.later], [1, 'Недостаточно средств', true]);
  // Повторный запуск в тот же день: новых попыток нет, новых начислений нет
  const r2 = (await req('POST', '/api/billing/run', 's.pavlov', { clubId: c2 })).json();
  assert.deepEqual([r2.periods, r2.charged, r2.failed], [0, 0, 0]);
  const card = (await req('GET', `/api/persons/${akh}/payment-methods`, 's.pavlov')).json();
  assert.equal(card.autopay[0].error, 'Недостаточно средств');
});

test('карта сохраняется при первой оплате подписки по ссылке и отвязывается', async () => {
  const orl = await pid('Глеб Орлов');
  await sql(`update persons set autopay_enabled = true where id = $1`, [orl]);
  // Первый месяц был оплачен месяц назад, сегодня — дата следующего списания
  await sql(`update charges set due_on = due_on - 30 where person_id = $1`, [orl]);
  await sql(`update memberships set next_charge_on = (now() at time zone 'Europe/Moscow')::date where person_id = $1`, [orl]);
  const r = (await req('POST', '/api/billing/run', 's.pavlov', { clubId: c2 })).json();
  assert.equal(r.noCard, 1);
  const ch = (await sql(`select id, autopay_error from charges where person_id = $1 and status = 'due' and kind = 'subscription'`, [orl]))[0];
  assert.match(ch.autopay_error, /Нет сохранённой карты/);
  const l = (await req('POST', `/api/charges/${ch.id}/pay-link`, 's.pavlov', {})).json();
  assert.match((await app.inject({ method: 'GET', url: `/pay/${l.id}` })).body, /Сохранить карту/);
  await testPay(l.id, { method: 'card', card: '5555 5555 5555 4444', save: '1', result: 'pay' });
  const pm = (await req('GET', `/api/persons/${orl}/payment-methods`, 's.pavlov')).json();
  assert.equal(pm.methods[0].title, 'Карта •••• 4444');
  assert.equal((await req('POST', `/api/payment-methods/${pm.methods[0].id}/remove`, 's.pavlov')).statusCode, 200);
  assert.equal((await req('GET', `/api/persons/${orl}/payment-methods`, 's.pavlov')).json().methods.length, 0);
});

test('ЮKassa: создание оплаты, переход на страницу банка, проверка статуса и уведомление', async () => {
  assert.equal((await req('PUT', `/api/clubs/${c1}/acquiring`, 'o.smirnov', { provider: 'yookassa', shopId: '123456', secret: 'test_secret', live: false })).statusCode, 200);
  const view = (await req('GET', `/api/clubs/${c1}/acquiring`, 'o.smirnov')).json();
  assert.equal(view.hasSecret, true); assert.equal(view.secret, undefined);
  assert.match((await req('POST', `/api/clubs/${c1}/acquiring/test`, 'o.smirnov')).json().info, /тестовый магазин/);
  const ch = await dueCharge('Кирилл Демин', 'Гостевой визит');
  const l = (await req('POST', `/api/charges/${ch}/pay-link`, 'o.smirnov', {})).json();
  const create = ykCalls.find((x) => x.url.endsWith('/payments'))!;
  assert.equal((create.body as { amount: { value: string } }).amount.value, '1000.00');
  assert.equal(create.headers['Idempotence-Key'], l.id);
  const go = await app.inject({ method: 'GET', url: `/pay/${l.id}` });
  assert.equal(go.statusCode, 302); assert.match(String(go.headers.location), /yoomoney\.ru/);
  ykPayment = { id: 'yk-1', status: 'pending' };
  assert.equal((await req('POST', `/api/online-payments/${l.id}/check`, 'o.smirnov')).json().status, 'pending');
  ykPayment = { id: 'yk-1', status: 'succeeded', payment_method: { type: 'bank_card', id: 'pm-1', saved: false, card: { last4: '1111', card_type: 'Visa' } } };
  const hook = await app.inject({ method: 'POST', url: `/api/hooks/pay/${c1}`, payload: { type: 'notification', event: 'payment.succeeded', object: { id: 'yk-1' } } });
  assert.equal(hook.body, 'OK');
  assert.equal((await sql('select status, paid_method from charges where id = $1', [ch]))[0].paid_method, 'online');
  // Вернули тестовый банк
  await req('PUT', `/api/clubs/${c1}/acquiring`, 'o.smirnov', { provider: 'test' });
});

test('подпись запросов Т-Банка', () => {
  const p = { TerminalKey: 'T', Amount: 100, OrderId: '1', DATA: { a: 1 }, Token: 'x' };
  // значения Amount, OrderId, Password, TerminalKey по алфавиту имён полей
  assert.equal(tbankToken(p, 'pw'), tbankToken({ OrderId: '1', TerminalKey: 'T', Amount: 100 }, 'pw'));
  assert.notEqual(tbankToken(p, 'pw'), tbankToken(p, 'pw2'));
});

test('сверка с выпиской: возмещение эквайринга, комиссия, неизвестные операции, без дублей', async () => {
  assert.equal((await req('GET', `/api/bank/sample?clubId=${c1}`, 'd.lis')).statusCode, 403);
  const s = await req('GET', `/api/bank/sample?clubId=${c1}`, 'e.orlova');
  const buf = s.rawPayload;
  const st = parseStatement(decodeStatement(buf));
  assert.ok(st.docs.length >= 4);
  assert.ok(st.docs.some((d) => d.inn === '7750005725' && d.direction === 'in'));
  const up = await req('POST', '/api/bank/statements', 'e.orlova', { clubId: c1, fileName: 'kl_to_1c.txt', dataBase64: buf.toString('base64') });
  assert.equal(up.statusCode, 201, up.body);
  const u = up.json();
  assert.ok(u.matched.acquiring >= 2);
  assert.equal(u.matched.bank_fee, 1);
  assert.equal(u.unmatched, 2);
  const again = (await req('POST', '/api/bank/statements', 'e.orlova', { clubId: c1, fileName: 'kl_to_1c.txt', dataBase64: buf.toString('base64') })).json();
  assert.equal(again.added, 0); assert.equal(again.duplicates, st.docs.length);
  const lines = (await req('GET', `/api/bank/lines?clubId=${c1}`, 'e.orlova')).json();
  const acq = lines.lines.find((l: { matchKind: string }) => l.matchKind === 'acquiring');
  assert.match(acq.note, /комиссия банка/);
  assert.ok(lines.totals.feesKop > 0);
  const romashka = lines.lines.find((l: { counterparty: string }) => /Ромашка/.test(l.counterparty));
  assert.equal(romashka.status, 'unmatched');
  assert.equal((await req('POST', `/api/bank/lines/${romashka.id}/match`, 'e.orlova', { kind: 'other' })).statusCode, 400);
  assert.equal((await req('POST', `/api/bank/lines/${romashka.id}/match`, 'e.orlova', { kind: 'other', note: 'Корпоративный договор, внесём вручную' })).statusCode, 200);
  assert.equal((await req('GET', `/api/bank/lines?clubId=${c1}&status=unmatched`, 'e.orlova')).json().lines.length, 1);
  assert.equal((await req('POST', '/api/bank/statements', 'e.orlova', { clubId: c1, dataBase64: Buffer.from('просто текст').toString('base64') })).statusCode, 400);
});
