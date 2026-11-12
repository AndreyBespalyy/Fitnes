// Журнал замечаний тестировщика: запись привязана к странице и роли, собственник видит всё, выгрузка и сводки по ключу.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string | null, payload?: unknown, headers?: Record<string, string>) =>
  t.app.inject({ method: method as 'GET', url, cookies: who ? ck[who] : undefined, payload: payload as object, headers });
// 1×1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('тестировщик пишет замечание к странице: своё окно на каждую страницу и роль', async () => {
  const me = (await req('GET', '/api/auth/me', 'd.lis')).json();
  assert.equal(me.isTester, true);
  const a = await req('POST', '/api/test-notes', 'd.lis', { pageKey: 'finance:Касса', pageLabel: 'Финансы → Касса', kind: 'bug', body: 'Не видно итог смены', shot: `data:image/png;base64,${PNG}` });
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(a.json().role, 'desk');
  assert.equal(a.json().hasShot, true);
  assert.equal((await req('POST', '/api/test-notes', 'd.lis', { pageKey: 'desk', pageLabel: 'Ресепшн', body: 'Хочу кнопку продления крупнее', kind: 'idea' })).statusCode, 201);
  assert.equal((await req('POST', '/api/test-notes', 'o.smirnov', { pageKey: 'finance:Касса', pageLabel: 'Финансы → Касса', body: 'Неудобный фильтр по датам', kind: 'ux' })).statusCode, 201);
  // В окне на странице — только свои записи по этой странице
  const mine = (await req('GET', `/api/test-notes/mine?page=${encodeURIComponent('finance:Касса')}`, 'd.lis')).json();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].body, 'Не видно итог смены');
  // Пустая запись и чужой формат файла не принимаются
  assert.equal((await req('POST', '/api/test-notes', 'd.lis', { pageKey: 'desk', body: '   ' })).statusCode, 400);
  assert.equal((await req('POST', '/api/test-notes', 'd.lis', { pageKey: 'desk', body: 'x', shot: Buffer.from('hello').toString('base64') })).statusCode, 400);
  // Скриншот видит автор и собственник, другой сотрудник — нет
  assert.equal((await req('GET', `/api/test-notes/${a.json().id}/shot`, 'd.lis')).statusCode, 200);
  assert.equal((await req('GET', `/api/test-notes/${a.json().id}/shot`, 'o.smirnov')).statusCode, 403);
});

test('не тестировщик окна не видит; собственник включает и выключает тестировщиков', async () => {
  const testers = (await req('GET', '/api/test-notes/testers', 'a.bespalyy')).json() as { id: string; login: string; isTester: boolean }[];
  const maria = testers.find((x) => x.login === 'm.volkova')!;
  assert.equal(maria.isTester, true);
  assert.equal((await req('PATCH', `/api/test-notes/testers/${maria.id}`, 'a.bespalyy', { isTester: false })).statusCode, 200);
  assert.equal((await req('POST', '/api/test-notes', 'm.volkova', { pageKey: 'hot', body: 'Тест' })).statusCode, 403);
  assert.equal((await req('PATCH', `/api/test-notes/testers/${maria.id}`, 'o.smirnov', { isTester: true })).statusCode, 403);
  await req('PATCH', `/api/test-notes/testers/${maria.id}`, 'a.bespalyy', { isTester: true });
});

test('собственник видит все записи по страницам, меняет статус — тестировщику приходит уведомление', async () => {
  assert.equal((await req('GET', '/api/test-notes', 'o.smirnov')).statusCode, 403);
  const all = (await req('GET', '/api/test-notes', 'a.bespalyy')).json();
  assert.equal(all.notes.length, 3);
  const kassa = all.pages.find((p: { pageKey: string }) => p.pageKey === 'finance:Касса');
  assert.equal(kassa.total, 2);
  const bug = all.notes.find((n: { body: string }) => n.body === 'Не видно итог смены');
  assert.equal((await req('PATCH', '/api/test-notes/status', 'a.bespalyy', { ids: [bug.id], status: 'done', statusNote: 'Итог смены вынесен наверх' })).json().updated, 1);
  const bell = (await req('GET', '/api/notifications', 'd.lis')).json();
  const items = (Array.isArray(bell) ? bell : bell.items) as { title: string }[];
  assert.ok(items.some((x) => x.title === `Замечание № ${bug.number}: сделано`), JSON.stringify(items));
  // Взятую в работу запись тестировщик уже не удаляет
  assert.equal((await req('DELETE', `/api/test-notes/${bug.id}`, 'd.lis')).statusCode, 400);
});

test('ежедневный разбор: выгрузка по ключу, сводки по страницам обратно в CRM', async () => {
  assert.equal((await req('GET', '/api/test-notes/export', null)).statusCode, 401);
  assert.equal((await req('GET', '/api/test-notes/export', null, undefined, { authorization: 'Bearer wrong' })).statusCode, 401);
  const { key } = (await req('POST', '/api/test-notes/key', 'a.bespalyy')).json();
  assert.match(key, /^tn_/);
  const auth = { authorization: `Bearer ${key}` };
  const ex = (await req('GET', '/api/test-notes/export?all=1', null, undefined, auth)).json();
  assert.equal(ex.notes.length, 3);
  assert.ok(ex.notes[0].roleName && ex.notes[0].author && ex.notes[0].pageLabel);
  const withShot = ex.notes.find((n: { hasShot: boolean }) => n.hasShot);
  assert.equal((await req('GET', `/api/test-notes/export/shot/${withShot.id}`, null, undefined, auth)).headers['content-type'], 'image/png');
  const put = await req('PUT', '/api/test-notes/export/summaries', null, { summaries: [{ pageKey: 'finance:Касса', pageLabel: 'Финансы → Касса', bodyMd: '# Финансы → Касса\n\n- Итог смены не виден', notesCount: 2 }] }, auth);
  assert.equal(put.statusCode, 200, put.body);
  const sums = (await req('GET', '/api/test-notes/summaries', 'a.bespalyy')).json();
  assert.equal(sums[0].bodyMd.includes('Итог смены'), true);
  const idea = ex.notes.find((n: { kind: string }) => n.kind === 'idea');
  assert.equal((await req('PATCH', '/api/test-notes/export/status', null, { ids: [idea.id], status: 'in_work' }, auth)).json().updated, 1);
  // После выпуска нового ключа старый не работает
  await req('POST', '/api/test-notes/key', 'a.bespalyy');
  assert.equal((await req('GET', '/api/test-notes/export', null, undefined, auth)).statusCode, 401);
});
