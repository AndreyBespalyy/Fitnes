// Подпись договора кодом из СМС: в клубе и по ссылке, попытки, повтор, провайдер, журнал без кода.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

const sent: { url: string; body: string }[] = [];
const fakeFetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), body: String(init?.body ?? '') });
  return new Response(JSON.stringify({ status: 'OK', sms: { '79165550909': { status: 'OK' } } }), { status: 200 });
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const PDF = Buffer.from('%PDF-1.4\n% договор\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF').toString('base64');
let centr = '';
const sell = async (fullName: string, phone: string) => {
  const personId = (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName, phone, sourceCode: 'walk_in' })).json().personId;
  const p = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === 'Месяц безлимит');
  return (await req('POST', '/api/memberships', 'd.lis', { personId, productId: p.id, confirmDuplicate: true })).json().contractId as string;
};
const form = (url: string, body: Record<string, string>) => t.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  await req('POST', `/api/clubs/${centr}/documents`, 'o.smirnov', { kind: 'contract', fileName: 'Договор.pdf', dataBase64: PDF });
  await req('POST', `/api/clubs/${centr}/documents`, 'o.smirnov', { kind: 'rules', fileName: 'Правила.pdf', dataBase64: PDF });
  await req('PUT', `/api/clubs/${centr}/legal-entity`, 'o.smirnov', { fullName: 'ООО «Фитнес Центр»', inn: '7701000001', signerName: 'Смирнов О. А.', signerBasis: 'Устава' });
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('в клубе: код на телефон клиента, неверный код, повтор не раньше минуты, подпись', async () => {
  const id = await sell('Сергей Смсов', '+7 916 555-08-08');
  // Тестовый провайдер: СМС не уходит, код показывается сотруднику
  const s = (await req('POST', `/api/contracts/${id}/sms/send`, 'd.lis')).json();
  assert.match(s.phoneMasked, /^\+7 ••• •••-08-08$/);
  assert.match(s.testCode, /^\d{6}$/);
  assert.equal((await req('POST', `/api/contracts/${id}/sms/send`, 'd.lis')).statusCode, 429, 'повтор не раньше чем через минуту');
  // Без согласия и с неверным кодом не подписывается
  assert.equal((await req('POST', `/api/contracts/${id}/sms/confirm`, 'd.lis', { code: s.testCode })).statusCode, 400);
  const wrong = await req('POST', `/api/contracts/${id}/sms/confirm`, 'd.lis', { code: '000000', accepted: true });
  assert.match(wrong.json().message, /Неверный код. Осталось попыток: 4/);
  assert.equal((await sql('select attempts from contract_sign_requests where contract_id = $1', [id]))[0].attempts, 1, 'попытка учтена, хотя ответ — ошибка');
  const ok = await req('POST', `/api/contracts/${id}/sms/confirm`, 'd.lis', { code: s.testCode, accepted: true });
  assert.equal(ok.statusCode, 200);
  const c = (await sql('select sign_method, signer_phone, signed_docs_sha256, accepted_by is not null as by from contracts where id = $1', [id]))[0];
  assert.deepEqual([c.sign_method, c.signer_phone, c.by], ['sms', '+79165550808', true]);
  assert.match(c.signed_docs_sha256, /^contract:[0-9a-f]{64};rules:[0-9a-f]{64}$/);
  assert.equal((await req('POST', `/api/contracts/${id}/sms/send`, 'd.lis')).json().message, 'Договор уже подписан');
  // В журнале СМС код скрыт
  const log = await sql(`select text, status from sms_outbox order by created_at`);
  assert.ok(log[0].text.includes('••••••') && !log[0].text.includes(s.testCode));
  assert.equal(log[0].status, 'test');
});

test('пять неверных кодов — нужен новый код', async () => {
  const id = await sell('Анна Пятьпопыток', '+7 916 555-08-09');
  await req('POST', `/api/contracts/${id}/sms/send`, 'd.lis');
  for (let i = 0; i < 5; i++) await req('POST', `/api/contracts/${id}/sms/confirm`, 'd.lis', { code: '111111', accepted: true });
  const r = await req('POST', `/api/contracts/${id}/sms/confirm`, 'd.lis', { code: '111111', accepted: true });
  assert.match(r.json().message, /Слишком много неверных попыток/);
});

test('удалённо по ссылке: документы, код, подпись; ссылка после подписи не работает', async () => {
  const id = await sell('Ольга Удалённая', '+7 916 555-08-10');
  const l = (await req('POST', `/api/contracts/${id}/sms/link`, 'd.lis')).json();
  assert.match(l.testUrl, /\/sign\/sg_/);
  const path = new URL(l.testUrl).pathname;
  let page = await t.app.inject({ method: 'GET', url: path });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Договор № .* от/);
  assert.match(page.body, /Месяц безлимит/);
  assert.match(page.body, /Получить код/);
  const doc = await t.app.inject({ method: 'GET', url: `${path}/doc/contract` });
  assert.equal(doc.headers['content-type'], 'application/pdf');

  page = await form(`${path}/code`, {});
  const code = /код (\d{6})/.exec(page.body)![1];
  assert.match(page.body, /Код отправлен на \+7 ••• •••-08-10/);
  page = await form(`${path}/confirm`, { code });
  assert.match(page.body, /Отметьте, что ознакомились/);
  page = await form(`${path}/confirm`, { code: '999999', accepted: '1' });
  assert.match(page.body, /Неверный код/);
  page = await form(`${path}/confirm`, { code, accepted: '1' });
  assert.match(page.body, /Договор подписан/);
  const c = (await sql('select sign_method, accepted_by from contracts where id = $1', [id]))[0];
  assert.deepEqual([c.sign_method, c.accepted_by], ['sms', null]);
  assert.equal((await t.app.inject({ method: 'GET', url: path })).statusCode, 404);
  assert.equal((await t.app.inject({ method: 'GET', url: '/sign/sg_wrongwrongwrongwrongwrong' })).statusCode, 404);
});

test('настройки СМС: только сеть, ключ не возвращается, отправка через SMS.ru', async () => {
  assert.equal((await req('GET', '/api/sms/settings', 'o.smirnov')).statusCode, 403);
  assert.equal((await req('PUT', '/api/sms/settings', 'a.bespalyy', { provider: 'smsru' })).statusCode, 400, 'без ключа нельзя');
  assert.equal((await req('PUT', '/api/sms/settings', 'a.bespalyy', { provider: 'smsru', secret: 'API-KEY-123', sender: 'FitClub' })).statusCode, 200);
  const s = (await req('GET', '/api/sms/settings', 'a.bespalyy')).json();
  assert.deepEqual([s.provider, s.hasSecret, s.sender], ['smsru', true, 'FitClub']);
  assert.equal(JSON.stringify(s).includes('API-KEY-123'), false);
  const id = await sell('Пётр Настоящий', '+7 916 555-09-09');
  const r = (await req('POST', `/api/contracts/${id}/sms/send`, 'd.lis')).json();
  assert.equal(r.testCode, undefined, 'с настоящим провайдером код сотруднику не показывается');
  const call = sent.find((x) => x.url === 'https://sms.ru/sms/send')!;
  assert.match(call.body, /api_id=API-KEY-123/);
  assert.match(call.body, /to=79165550909/);
  assert.match(decodeURIComponent(call.body.replace(/\+/g, ' ')), /Код \d{6} — подпись договора/);
});
