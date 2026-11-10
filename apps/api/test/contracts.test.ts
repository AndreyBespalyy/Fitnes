import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string }, sever: { id: string };
before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova', 'e.orlova', 'a.morozova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: ck['a.bespalyy'] })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
  sever = clubs.find((c: { name: string }) => c.name === 'Клуб «Север»');
});
after(async () => { await t.app.close(); await t.pool.end(); });

const owner = async <T,>(sql: string, args: unknown[] = []) => {
  const c = new pg.Client({ connectionString: t.ownerUrl }); await c.connect();
  try { return (await c.query(sql, args)).rows as T[]; } finally { await c.end(); }
};
const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const PDF = Buffer.from('%PDF-1.4\n% тестовый договор\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF').toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 1)]).toString('base64');
const sell = async (fullName: string, phone: string) => {
  const personId = (await req('POST', '/api/leads', 'd.lis', { clubId: centr.id, fullName, phone, sourceCode: 'walk_in' })).json().personId;
  const p = (await req('GET', `/api/products?clubId=${centr.id}`, 'd.lis')).json().find((x: { name: string }) => x.name === 'Месяц безлимит');
  const r = (await req('POST', '/api/memberships', 'd.lis', { personId, productId: p.id })).json();
  return { personId, ...r };
};

test('управляющий загружает PDF договора и правил своего клуба, версии сохраняются', async () => {
  const r1 = await req('POST', `/api/clubs/${centr.id}/documents`, 'o.smirnov', { kind: 'contract', fileName: 'Договор.pdf', dataBase64: PDF });
  assert.equal(r1.statusCode, 201);
  const r2 = await req('POST', `/api/clubs/${centr.id}/documents`, 'o.smirnov', { kind: 'contract', fileName: 'Договор_v2.pdf', dataBase64: PDF });
  assert.equal(r2.json().version, 2);
  assert.equal((await req('POST', `/api/clubs/${centr.id}/documents`, 'o.smirnov', { kind: 'rules', fileName: 'Правила.pdf', dataBase64: PDF })).statusCode, 201);
  const docs = (await req('GET', `/api/clubs/${centr.id}/documents`, 'o.smirnov')).json();
  assert.equal(docs.filter((d: { isCurrent: boolean; kind: string }) => d.isCurrent && d.kind === 'contract').length, 1);
  assert.equal(docs.length, 3);
  // не PDF, чужой клуб, ресепшн
  assert.equal((await req('POST', `/api/clubs/${centr.id}/documents`, 'o.smirnov', { kind: 'rules', fileName: 'x.pdf', dataBase64: PNG })).statusCode, 400);
  assert.notEqual((await req('POST', `/api/clubs/${sever.id}/documents`, 'o.smirnov', { kind: 'rules', fileName: 'x.pdf', dataBase64: PDF })).statusCode, 201);
  assert.equal((await req('POST', `/api/clubs/${centr.id}/documents`, 'd.lis', { kind: 'rules', fileName: 'x.pdf', dataBase64: PDF })).statusCode, 403);
  // файл отдаётся своим и не отдаётся чужому клубу
  const fileId = docs[0].fileId;
  const f = await req('GET', `/api/files/${fileId}`, 'd.lis');
  assert.equal(f.statusCode, 200);
  assert.equal(f.headers['content-type'], 'application/pdf');
  assert.equal((await req('GET', `/api/files/${fileId}`, 'a.morozova')).statusCode, 404);
});

test('реквизиты юрлица: проверка ИНН и счёта, только свой клуб', async () => {
  const bad = await req('PUT', `/api/clubs/${centr.id}/legal-entity`, 'o.smirnov', { fullName: 'ООО «Ромашка»', inn: '123' });
  assert.equal(bad.statusCode, 400);
  const badAcc = await req('PUT', `/api/clubs/${centr.id}/legal-entity`, 'o.smirnov', { fullName: 'ООО «Ромашка»', inn: '7701000001', account: '123' });
  assert.equal(badAcc.statusCode, 400);
  const ok = await req('PUT', `/api/clubs/${centr.id}/legal-entity`, 'o.smirnov', { fullName: 'ООО «Фитнес Центр»', inn: '7701 000 001', contractPrefix: 'ЦТ' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().legalEntity.inn, '7701000001');
  assert.notEqual((await req('PUT', `/api/clubs/${sever.id}/legal-entity`, 'o.smirnov', { fullName: 'ООО', inn: '7701000001' })).statusCode, 200);
  assert.equal((await req('PUT', `/api/clubs/${centr.id}/legal-entity`, 'e.orlova', { fullName: 'ООО', inn: '7701000001' })).statusCode, 403);
});

test('при продаже создаётся договор с номером по клубу и снимком реквизитов', async () => {
  const s = await sell('Договор Первый', '+79002220001');
  assert.match(s.contractNumber, /^ЦТ-\d{4}-\d{5}$/);
  const s2 = await sell('Договор Второй', '+79002220002');
  assert.equal(Number(s2.contractNumber.slice(-5)), Number(s.contractNumber.slice(-5)) + 1);
  const c = (await req('GET', `/api/contracts/${s.contractId}`, 'd.lis')).json();
  assert.equal(c.status, 'awaiting_signature');
  assert.equal(c.legalEntity.fullName, 'ООО «Фитнес Центр»');
  assert.equal(c.person.fullName, 'Договор Первый');
  assert.equal(c.contractDoc.version, 2);
  assert.equal(c.membership.amountKop, 650_000);
  // реквизиты поменяли позже: в подписанном/выданном договоре остаются прежние
  await req('PUT', `/api/clubs/${centr.id}/legal-entity`, 'o.smirnov', { fullName: 'ООО «Новое имя»', inn: '7701000001', contractPrefix: 'ЦТ' });
  assert.equal((await req('GET', `/api/contracts/${s.contractId}`, 'd.lis')).json().legalEntity.fullName, 'ООО «Фитнес Центр»');
});

test('бумажный путь: скан подписанного договора, повторно подписать нельзя', async () => {
  const s = await sell('Скан Бумажный', '+79002220003');
  assert.equal((await req('POST', `/api/contracts/${s.contractId}/scan`, 'e.orlova', { fileName: 'скан.pdf', dataBase64: PDF })).statusCode, 403);
  const r = await req('POST', `/api/contracts/${s.contractId}/scan`, 'd.lis', { fileName: 'скан.jpg', dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64') });
  assert.equal(r.statusCode, 200);
  const m = (await req('GET', `/api/persons/${s.personId}/memberships`, 'd.lis')).json()[0];
  assert.equal(m.contract.status, 'signed');
  assert.equal(m.contract.signMethod, 'paper_scan');
  assert.ok(m.contract.scanFileId);
  assert.equal((await req('POST', `/api/contracts/${s.contractId}/scan`, 'd.lis', { fileName: 'скан.pdf', dataBase64: PDF })).statusCode, 400);
});

test('планшет: нужно согласие и подпись, сохраняются хеши документов', async () => {
  const s = await sell('Планшет Подписной', '+79002220004');
  assert.equal((await req('POST', `/api/contracts/${s.contractId}/sign-tablet`, 'd.lis', { signaturePng: PNG })).statusCode, 400);
  assert.equal((await req('POST', `/api/contracts/${s.contractId}/sign-tablet`, 'd.lis', { accepted: true, signaturePng: PNG.slice(0, 40) })).statusCode, 400);
  const r = await req('POST', `/api/contracts/${s.contractId}/sign-tablet`, 'd.lis', { accepted: true, signaturePng: PNG });
  assert.equal(r.statusCode, 200);
  const [row] = await owner<{ signed_docs_sha256: string; sign_method: string }>(`select signed_docs_sha256, sign_method from contracts where id = $1`, [s.contractId]);
  assert.equal(row.sign_method, 'tablet');
  assert.match(row.signed_docs_sha256, /^contract:[0-9a-f]{64};rules:[0-9a-f]{64}$/);
});

test('правило клуба «без подписанного договора не пускать»', async () => {
  const s = await sell('Проход Договорный', '+79002220005');
  assert.equal((await req('GET', `/api/persons/${s.personId}/access`, 'd.lis')).json().allowed, true);
  await req('PUT', `/api/clubs/${centr.id}/membership-settings`, 'o.smirnov', { contractRequiredForAccess: true });
  const a = (await req('GET', `/api/persons/${s.personId}/access`, 'd.lis')).json();
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'Договор не подписан');
  await req('POST', `/api/contracts/${s.contractId}/sign-tablet`, 'd.lis', { accepted: true, signaturePng: PNG });
  assert.equal((await req('GET', `/api/persons/${s.personId}/access`, 'd.lis')).json().allowed, true);
  await req('PUT', `/api/clubs/${centr.id}/membership-settings`, 'o.smirnov', { contractRequiredForAccess: false });
});

test('подписанный договор нельзя изменить даже напрямую в базе', async () => {
  const s = await sell('Неизменный Договор', '+79002220006');
  await req('POST', `/api/contracts/${s.contractId}/sign-tablet`, 'd.lis', { accepted: true, signaturePng: PNG });
  await assert.rejects(owner(`update contracts set number = 'X' where id = $1`, [s.contractId]), /Подписанный договор/);
});
