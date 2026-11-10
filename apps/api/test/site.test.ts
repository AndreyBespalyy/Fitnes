import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: { id: string }, sever: { id: string };
let siteKey = '';
before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'd.lis', 'i.kotova']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: ck['a.bespalyy'] })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
  sever = clubs.find((c: { name: string }) => c.name === 'Клуб «Север»');
  const src = (await t.app.inject({ method: 'GET', url: '/api/lead-sources', cookies: ck['i.kotova'] })).json().find((s: { code: string }) => s.code === 'site');
  siteKey = (await t.app.inject({ method: 'POST', url: `/api/lead-sources/${src.id}/api-key`, cookies: ck['i.kotova'] })).json().apiKey;
});
after(async () => { await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const feed = () => t.app.inject({ method: 'GET', url: '/api/public/v1/offers', headers: { authorization: `Bearer ${siteKey}` } });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString('base64');

test('управляющий готовит предложение своего клуба; на сайт попадает только опубликованное', async () => {
  const r = await req('POST', '/api/site/offers', 'o.smirnov', { clubId: centr.id, title: 'Год со скидкой 20 %', priceKop: 3_360_000, oldPriceKop: 4_200_000,
    priceNote: 'за год', description: 'До конца месяца', image: { fileName: 'баннер.png', dataBase64: PNG } });
  assert.equal(r.statusCode, 201);
  const id = r.json().id;
  assert.equal(r.json().status, 'draft');
  const draftFeed = (await feed()).json();
  assert.equal(draftFeed.offers.some((o: { id: string }) => o.id === id), false);
  assert.equal((await t.app.inject({ method: 'GET', url: `/api/public/v1/offers/${id}/image` })).statusCode, 404);
  assert.equal((await req('PATCH', `/api/site/offers/${id}`, 'o.smirnov', { status: 'published' })).statusCode, 200);
  const o = (await feed()).json().offers.find((x: { id: string }) => x.id === id);
  assert.equal(o.price, 33_600);
  assert.equal(o.oldPrice, 42_000);
  assert.equal(o.clubName, 'Клуб «Центр»');
  const img = await t.app.inject({ method: 'GET', url: `/api/public/v1/offers/${id}/image` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  // снятое с сайта пропадает из выгрузки
  await req('PATCH', `/api/site/offers/${id}`, 'o.smirnov', { status: 'archived' });
  assert.equal((await feed()).json().offers.some((x: { id: string }) => x.id === id), false);
});

test('чужой клуб, ресепшн и выгрузка без ключа', async () => {
  assert.notEqual((await req('POST', '/api/site/offers', 'o.smirnov', { clubId: sever.id, title: 'Чужое' })).statusCode, 201);
  assert.equal((await req('POST', '/api/site/offers', 'd.lis', { clubId: centr.id, title: 'Без права' })).statusCode, 403);
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/public/v1/offers' })).statusCode, 401);
  assert.equal((await t.app.inject({ method: 'GET', url: '/api/public/v1/offers', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
});

test('предложение с датами показывается только в свой срок', async () => {
  const future = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const r = await req('POST', '/api/site/offers', 'a.bespalyy', { clubId: sever.id, title: 'Летняя подписка', validFrom: future });
  await req('PATCH', `/api/site/offers/${r.json().id}`, 'a.bespalyy', { status: 'published' });
  assert.equal((await feed()).json().offers.some((x: { id: string }) => x.id === r.json().id), false);
  assert.equal((await req('PATCH', `/api/site/offers/${r.json().id}`, 'a.bespalyy', { validTo: '2020-01-01' })).statusCode, 400);
});
