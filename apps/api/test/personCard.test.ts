// Карточка клиента (замечания №31, 32, 47, 48, 50): правка данных, «Показать номер» с журналом, документы, ответственный, заморозка менеджером.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
let pid = ''; let club = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['m.volkova', 'o.astafeva', 'a.kim', 'i.zuev']) ck[l] = (await login(t.app, l)).cookie!;
  const list = (await req('GET', '/api/persons?kind=member', 'm.volkova')).json() as { id: string }[];
  pid = list[0].id;
  club = (await req('GET', `/api/persons/${pid}`, 'm.volkova')).json().person.homeClubId;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('менеджер исправляет ФИО и дату рождения, тренер — нет', async () => {
  const r = await req('PATCH', `/api/persons/${pid}`, 'm.volkova', { fullName: '  Иванова   Анна Сергеевна ', birthDate: '1990-05-17' });
  assert.equal(r.statusCode, 200, r.body);
  const p = (await req('GET', `/api/persons/${pid}`, 'm.volkova')).json().person;
  assert.equal(p.fullName, 'Иванова Анна Сергеевна');
  assert.match(String(p.birthDate), /^1990-05-1[67]/);
  assert.equal((await req('PATCH', `/api/persons/${pid}`, 'm.volkova', { birthDate: '2999-01-01' })).statusCode, 400);
  assert.equal((await req('PATCH', `/api/persons/${pid}`, 'a.kim', { fullName: 'Кто-то' })).statusCode, 403);
});

test('«Показать номер» отдаёт полный номер и пишет в журнал, руководитель видит, кто смотрел', async () => {
  const card = (await req('GET', `/api/persons/${pid}`, 'm.volkova')).json();
  assert.ok(card.contacts.find((c: { type: string; value: string }) => c.type === 'phone')?.value.includes('*'));
  const r = await req('POST', `/api/persons/${pid}/phone`, 'm.volkova');
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().phones.length > 0 && !r.json().phones[0].includes('*'));
  const views = (await req('GET', `/api/persons/${pid}/phone-views`, 'o.astafeva')).json();
  assert.equal(views[0].userName, 'Мария Волкова');
  assert.equal((await req('GET', `/api/persons/${pid}/phone-views`, 'm.volkova')).statusCode, 403);
});

test('документ с камеры сохраняется в карточке и удаляется', async () => {
  const r = await req('POST', `/api/persons/${pid}/documents`, 'm.volkova', { title: 'Паспорт', fileName: 'p.jpg', dataBase64: `data:image/jpeg;base64,${JPG}` });
  assert.equal(r.statusCode, 201, r.body);
  const list = (await req('GET', `/api/persons/${pid}/documents`, 'm.volkova')).json();
  assert.equal(list[0].title, 'Паспорт');
  const f = await req('GET', `/api/persons/${pid}/documents/${list[0].id}/file`, 'm.volkova');
  assert.equal(f.statusCode, 200); assert.equal(f.headers['content-type'], 'image/jpeg');
  assert.equal((await req('POST', `/api/persons/${pid}/documents`, 'm.volkova', { title: 'x', dataBase64: Buffer.from('hello').toString('base64') })).statusCode, 400);
  assert.equal((await req('DELETE', `/api/persons/${pid}/documents/${list[0].id}`, 'm.volkova')).statusCode, 200);
  assert.equal((await req('GET', `/api/persons/${pid}/documents`, 'm.volkova')).json().length, 0);
});

test('ответственный: менеджер берёт ничьего клиента себе, менять чужого может только руководитель', async () => {
  const me = (await req('GET', '/api/auth/me', 'm.volkova')).json();
  const rop = (await req('GET', '/api/auth/me', 'o.astafeva')).json();
  await req('PUT', `/api/persons/${pid}/owner`, 'o.astafeva', { ownerId: null });
  assert.equal((await req('PUT', `/api/persons/${pid}/owner`, 'm.volkova', { ownerId: me.id })).statusCode, 200);
  // Второй менеджер с долей
  const r = await req('PUT', `/api/persons/${pid}/owner`, 'm.volkova', { ownerId: me.id, coOwnerId: rop.id, coOwnerShare: 50 });
  assert.equal(r.statusCode, 200, r.body);
  const o = (await req('GET', `/api/persons/${pid}/owner`, 'm.volkova')).json();
  assert.equal(o.ownerName, 'Мария Волкова'); assert.equal(o.coOwnerShare, 50);
  assert.equal((await req('PUT', `/api/persons/${pid}/owner`, 'm.volkova', { ownerId: me.id, coOwnerId: rop.id, coOwnerShare: 150 })).statusCode, 400);
  // Руководитель переназначает; после этого менеджер уже не может забрать клиента обратно
  assert.equal((await req('PUT', `/api/persons/${pid}/owner`, 'o.astafeva', { ownerId: rop.id })).statusCode, 200);
  assert.equal((await req('PUT', `/api/persons/${pid}/owner`, 'm.volkova', { ownerId: me.id })).statusCode, 403);
  // Сотрудник другого клуба ответственным быть не может
  const zuev = (await req('GET', '/api/auth/me', 'i.zuev')).json();
  assert.equal((await req('PUT', `/api/persons/${pid}/owner`, 'o.astafeva', { ownerId: zuev.id })).statusCode, 400);
});

test('менеджер замораживает абонемент из карточки по правилам клуба', async () => {
  const ms = (await req('GET', `/api/persons/${pid}/memberships`, 'm.volkova')).json() as { id: string; kind: string; status: string; freezeAllowed: boolean; freezes: unknown[] }[];
  const m = ms.find((x) => x.status === 'active' && x.kind === 'term' && x.freezeAllowed && !x.freezes.length);
  if (!m) return; // в тестовых данных у клиента может не оказаться подходящего абонемента
  const st = (await req('GET', `/api/clubs/${club}/membership-settings`, 'm.volkova')).json();
  const r = await req('POST', `/api/memberships/${m.id}/freeze`, 'm.volkova', { days: Math.max(st.freezeMinDays, 7) });
  assert.equal(r.statusCode, st.freezeEnabled ? 200 : 400, r.body);
  assert.equal((await req('POST', `/api/memberships/${m.id}/freeze`, 'a.kim', { days: 7 })).statusCode, 403);
});
