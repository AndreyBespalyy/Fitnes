import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { setupTestApp, login } from './helpers.ts';
import { processCloudReceipts } from '../src/modules/fiscal.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string }, sever: { id: string };
// Заглушка облачной кассы АТОЛ Онлайн v5
let atol: Server; let atolUrl = ''; let failNext = false;
const sent: { path: string; body: any; token?: string }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
before(async () => {
  atol = createServer((rq, rs) => {
    let raw = ''; rq.on('data', (c) => (raw += c));
    rq.on('end', () => {
      const body = raw ? JSON.parse(raw) : null; const url = rq.url ?? '';
      sent.push({ path: url, body, token: rq.headers.token as string });
      rs.setHeader('Content-Type', 'application/json');
      if (url.endsWith('/getToken')) return rs.end(JSON.stringify(body.pass === 'secret' ? { error: null, token: 'tok-1' } : { error: { code: 12, text: 'Неверный логин или пароль' } }));
      if (url.endsWith('/sell')) return rs.end(JSON.stringify({ uuid: `u-${body.external_id}`, status: 'wait', error: null }));
      if (url.includes('/report/')) {
        if (failNext) { failNext = false; return rs.end(JSON.stringify({ status: 'fail', error: { code: 32, text: 'Ошибка валидации чека' } })); }
        return rs.end(JSON.stringify({ status: 'done', error: null, payload: { fn_number: '9999078900001234', fiscal_document_number: 777, fiscal_document_attribute: 123456789,
          fiscal_receipt_number: 5, shift_number: 2, receipt_datetime: '10.11.2026 17:30:00', ecr_registration_number: '0000000001002292', ofd_receipt_url: 'https://ofd.example/r/1' } }));
      }
      rs.statusCode = 404; rs.end('{}');
    });
  });
  await new Promise<void>((r) => atol.listen(0, '127.0.0.1', r));
  atolUrl = `http://127.0.0.1:${(atol.address() as { port: number }).port}/possystem/v5`;
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'e.orlova', 's.pavlov', 'a.morozova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: ck['a.bespalyy'] })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
  sever = clubs.find((c: { name: string }) => c.name === 'Клуб «Север»');
});
after(async () => { await t.app.close(); await t.pool.end(); atol.close(); });

const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const CLOUD = () => ({ mode: 'cloud', taxation: 'usn_income', vat: 'none', inn: '7701000001', companyEmail: 'kassa@club.ru', paymentAddress: 'https://amoglobal.ru',
  apiUrl: atolUrl, groupCode: 'group_1', login: 'club-login', password: 'secret', acquiringProvider: 'sber' });
let phoneN = 0;
async function paidCharge(clubId: string, who: string, product: string, method = 'card_terminal') {
  const personId = (await req('POST', '/api/leads', who, { clubId, fullName: `Чек Клиент ${++phoneN}`, phone: `+7900333${String(phoneN).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId;
  const p = (await req('GET', `/api/products?clubId=${clubId}`, who)).json().find((x: { name: string }) => x.name === product);
  await req('POST', '/api/memberships', who, { personId, productId: p.id });
  const m = (await req('GET', `/api/persons/${personId}/memberships`, who)).json()[0];
  const charge = m.charges[0];
  const r = await req('POST', `/api/charges/${charge.id}/mark-paid`, who, { method });
  return { personId, chargeId: charge.id, receiptId: r.json().receiptId as string | null };
}

test('без подключённой кассы чек не создаётся', async () => {
  const r = await paidCharge(centr.id, 'd.lis', 'Гостевой визит', 'cash');
  assert.equal(r.receiptId, null);
});

test('настройки кассы: управляющий своего клуба, пароль не возвращается, ресепшн и финансист не меняют', async () => {
  const bad = await req('PUT', `/api/clubs/${centr.id}/fiscal`, 'o.smirnov', { ...CLOUD(), inn: '12' });
  assert.equal(bad.statusCode, 400);
  const ok = await req('PUT', `/api/clubs/${centr.id}/fiscal`, 'o.smirnov', CLOUD());
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().hasPassword, true);
  assert.equal(ok.json().password, undefined);
  assert.equal(ok.json().acquiringProvider, 'sber');
  const raw = await t.pool.query('select 1');
  assert.ok(raw);
  assert.notEqual((await req('PUT', `/api/clubs/${sever.id}/fiscal`, 'o.smirnov', CLOUD())).statusCode, 200);
  assert.equal((await req('PUT', `/api/clubs/${centr.id}/fiscal`, 'd.lis', CLOUD())).statusCode, 403);
  assert.equal((await req('PUT', `/api/clubs/${centr.id}/fiscal`, 'e.orlova', CLOUD())).statusCode, 403);
  // повторное сохранение без пароля сохраняет прежний пароль
  const again = await req('PUT', `/api/clubs/${centr.id}/fiscal`, 'o.smirnov', { ...CLOUD(), password: undefined });
  assert.equal(again.json().hasPassword, true);
  assert.equal((await req('POST', `/api/clubs/${centr.id}/fiscal/test`, 'o.smirnov')).statusCode, 200);
});

test('облачная касса: чек отправляется, фискальные данные сохраняются', async () => {
  const r = await paidCharge(centr.id, 'd.lis', 'Месяц безлимит', 'card_terminal');
  assert.ok(r.receiptId);
  sent.length = 0;
  await processCloudReceipts(t.pool);   // отправка
  const sell = sent.find((x) => x.path.endsWith('/group_1/sell'))!;
  assert.equal(sell.token, 'tok-1');
  assert.equal(sell.body.receipt.company.sno, 'usn_income');
  assert.equal(sell.body.receipt.items[0].sum, 6500);
  assert.equal(sell.body.receipt.items[0].payment_method, 'full_prepayment');
  assert.equal(sell.body.receipt.payments[0].type, 1);
  assert.equal(sell.body.external_id, r.receiptId);
  await t.pool.query(`select 1`);
  await new Promise((res) => setTimeout(res, 10));
  // следующая попытка через 5 секунд: подгоняем время
  await ownerExec(`update receipts set next_attempt_at = now() where id = '${r.receiptId}'`);
  await processCloudReceipts(t.pool);   // получение результата
  const list = (await req('GET', `/api/receipts?clubId=${centr.id}`, 'd.lis')).json();
  const rc = list.find((x: { id: string }) => x.id === r.receiptId);
  assert.equal(rc.status, 'done');
  assert.equal(rc.fiscal.fiscalDocumentNumber, 777);
});

test('ошибка кассы: чек с ошибкой можно повторить', async () => {
  const r = await paidCharge(centr.id, 'd.lis', 'Гостевой визит', 'cash');
  await processCloudReceipts(t.pool);
  failNext = true;
  await ownerExec(`update receipts set next_attempt_at = now() where id = '${r.receiptId}'`);
  await processCloudReceipts(t.pool);
  let rc = (await req('GET', `/api/receipts?status=failed`, 'd.lis')).json().find((x: { id: string }) => x.id === r.receiptId);
  assert.match(rc.error, /валидации/);
  assert.equal((await req('POST', `/api/receipts/${r.receiptId}/retry`, 'd.lis')).json().status, 'pending');
  await processCloudReceipts(t.pool);
  await ownerExec(`update receipts set next_attempt_at = now() where id = '${r.receiptId}'`);
  await processCloudReceipts(t.pool);
  rc = (await req('GET', `/api/receipts`, 'd.lis')).json().find((x: { id: string }) => x.id === r.receiptId);
  assert.equal(rc.status, 'done');
});

test('касса в клубе: задание для веб-сервера АТОЛ в очереди ресепшн, результат возвращается', async () => {
  await req('PUT', `/api/clubs/${sever.id}/fiscal`, 's.pavlov', { mode: 'local', provider: 'atol_local', taxation: 'osn', vat: 'vat22', inn: '7713000002' });
  const r = await paidCharge(sever.id, 'a.morozova', 'Гостевой визит', 'cash');
  const q = (await req('GET', `/api/receipts/local-queue?clubId=${sever.id}`, 'a.morozova')).json();
  const job = q.find((x: { id: string }) => x.id === r.receiptId);
  assert.equal(job.localUrl, 'http://127.0.0.1:16732');
  assert.equal(job.payload.type, 'sell');
  assert.equal(job.payload.taxationType, 'osn');
  assert.equal(job.payload.items[0].tax.type, 'vat22');
  assert.equal(job.payload.payments[0].type, 'cash');
  assert.equal(job.payload.operator.name, 'Алина Морозова');
  assert.equal((await req('POST', `/api/receipts/${r.receiptId}/local-sent`, 'a.morozova', { externalId: 'task-1' })).statusCode, 200);
  assert.equal((await req('POST', `/api/receipts/${r.receiptId}/local-result`, 'a.morozova', { ok: true, fiscal: { fiscalDocumentNumber: 42 } })).statusCode, 200);
  assert.equal((await req('GET', `/api/receipts/local-queue?clubId=${sever.id}`, 'a.morozova')).json().some((x: { id: string }) => x.id === r.receiptId), false);
});

test('ручной режим: кассир вписывает номер ФД с чека', async () => {
  await req('PUT', `/api/clubs/${sever.id}/fiscal`, 's.pavlov', { mode: 'local', provider: 'manual', taxation: 'usn_income', vat: 'none', inn: '7713000002' });
  const r = await paidCharge(sever.id, 'a.morozova', 'Гостевой визит', 'card_terminal');
  assert.equal((await req('POST', `/api/receipts/${r.receiptId}/manual`, 'a.morozova', { fiscalDocumentNumber: 'abc' })).statusCode, 400);
  assert.equal((await req('POST', `/api/receipts/${r.receiptId}/manual`, 'a.morozova', { fiscalDocumentNumber: '1234' })).statusCode, 200);
  const rc = (await req('GET', `/api/receipts?clubId=${sever.id}`, 's.pavlov')).json().find((x: { id: string }) => x.id === r.receiptId);
  assert.equal(rc.status, 'done');
  assert.equal(rc.fiscal.manual, true);
});

test('неполные настройки облачной кассы: чек сразу с понятной ошибкой', async () => {
  await req('PUT', `/api/clubs/${sever.id}/fiscal`, 's.pavlov', { mode: 'cloud', inn: '7713000002' });
  const r = await paidCharge(sever.id, 'a.morozova', 'Гостевой визит', 'cash');
  const rc = (await req('GET', `/api/receipts?clubId=${sever.id}`, 's.pavlov')).json().find((x: { id: string }) => x.id === r.receiptId);
  assert.equal(rc.status, 'failed');
  assert.match(rc.error, /логин/);
});

test('галочка автосписания в карточке клиента', async () => {
  const r = await paidCharge(centr.id, 'd.lis', 'Гостевой визит', 'cash');
  assert.equal((await req('GET', `/api/persons/${r.personId}`, 'd.lis')).json().person.autopayEnabled, false);
  assert.equal((await req('POST', `/api/persons/${r.personId}/autopay`, 'e.orlova', { enabled: true })).statusCode, 403);
  assert.equal((await req('POST', `/api/persons/${r.personId}/autopay`, 'd.lis', { enabled: true })).statusCode, 200);
  assert.equal((await req('GET', `/api/persons/${r.personId}`, 'd.lis')).json().person.autopayEnabled, true);
});

import pg from 'pg';
async function ownerExec(sql: string) {
  const c = new pg.Client({ connectionString: t.ownerUrl }); await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
