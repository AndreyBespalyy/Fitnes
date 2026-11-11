// «Приведи друга»: ссылка клиента, заявка друга по ссылке, скидка другу, дни привёдшему, отчёт и настройки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string | null, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: who ? ck[who] : undefined, payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';
let products: { id: string; name: string }[] = [];
const prod = (name: string) => products.find((p) => p.name === name)!.id;
let n = 0;
const client = async () => (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Друг Клиента ${++n}`, phone: `+7900666${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
const sell = async (personId: string, product: string, extra: object = {}) => {
  const s = await req('POST', '/api/memberships', 'm.volkova', { personId, productId: prod(product), ...extra });
  assert.equal(s.statusCode, 201, s.body);
  return s.json().id as string;
};
const ms = async (personId: string, id: string) => (await req('GET', `/api/persons/${personId}/memberships`, 'm.volkova')).json().find((m: { id: string }) => m.id === id);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  products = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('друг по ссылке: заявка с источником «Рекомендация», скидка другу, дни привёдшему', async () => {
  const amb = await client();
  const ambM = await sell(amb, 'Годовой безлимит');
  const before = (await ms(amb, ambM)).endsOn;
  const r = (await req('GET', `/api/persons/${amb}/referral`, 'm.volkova')).json();
  assert.match(r.code, /^[A-Z2-9]{6}$/);
  assert.match(r.link, new RegExp(`/r/${r.code}$`));
  assert.equal((await req('GET', `/api/persons/${amb}/referral`, 'm.volkova')).json().code, r.code); // код не меняется

  const page = await req('GET', `/r/${r.code.toLowerCase()}`, null);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /приглашает вас в Клуб «Центр»/);
  assert.match(page.body, /скидка <b>10 %<\/b>/);
  assert.match((await req('GET', '/r/NOPE99', null)).body, /Приглашение не найдено/);

  assert.equal((await req('POST', `/api/public/v1/ref/${r.code}`, null, { name: 'Пётр', phone: '+79006669999' })).statusCode, 400); // без согласия
  const lead = await req('POST', `/api/public/v1/ref/${r.code}`, null, { name: 'Пётр Друг', phone: '+79006669999', consent: true });
  assert.equal(lead.statusCode, 201, lead.body);
  const friend = (await sql(`select p.id, s.code from persons p join leads l on l.person_id = p.id join lead_sources s on s.id = l.source_id where p.full_name = 'Пётр Друг'`))[0];
  assert.equal(friend.code, 'referral');

  const fm = await sell(friend.id, 'Месяц безлимит');
  assert.equal((await ms(friend.id, fm)).amountKop, 585000); // 650 000 − 10 %
  const after = (await ms(amb, ambM)).endsOn;
  assert.equal((Date.parse(after) - Date.parse(before)) / 86400_000, 14);
  const op = (await sql(`select params from membership_operations where membership_id = $1 and kind = 'bonus_days'`, [ambM]))[0];
  assert.equal(op.params.days, 14);

  const card = (await req('GET', `/api/persons/${amb}/referral`, 'm.volkova')).json();
  assert.equal(card.invited[0].status, 'rewarded');
  assert.equal(card.invited[0].friendId, friend.id);
  assert.equal((await req('GET', `/api/persons/${friend.id}/referral`, 'm.volkova')).json().invitedBy.referrerId, amb);

  const rep = (await req('GET', `/api/referrals?clubId=${centr}`, 'o.smirnov')).json();
  const top = rep.top.find((x: { personId: string }) => x.personId === amb);
  assert.deepEqual([top.invited, top.bought, top.revenue, top.days], [1, 1, 585000, 14]);
  // Повторная покупка друга бонус не даёт
  await sell(friend.id, 'Месяц безлимит', { confirmDuplicate: true });
  assert.equal((await ms(amb, ambM)).endsOn, after);
});

test('отметка вручную: нельзя себя и бывшего клиента; без срочного абонемента — задача начислить вручную', async () => {
  const amb = await client();
  await sell(amb, '10 посещений');
  const code = (await req('GET', `/api/persons/${amb}/referral`, 'm.volkova')).json().code;
  assert.equal((await req('POST', '/api/referrals/attach', 'm.volkova', { friendId: amb, code, clubId: centr })).json().error, 'ref_self');
  const old = await client(); await sell(old, 'Месяц безлимит');
  assert.equal((await req('POST', '/api/referrals/attach', 'm.volkova', { friendId: old, code, clubId: centr })).json().error, 'ref_existing');
  const f = await client();
  const a = await req('POST', '/api/referrals/attach', 'm.volkova', { friendId: f, code: code.toLowerCase(), clubId: centr });
  assert.equal(a.statusCode, 201, a.body);
  // Промокод вместо скидки по рекомендации: скидки не суммируются, но рекомендация засчитывается
  await sell(f, 'Месяц безлимит', { discountPercent: 5 });
  const r = (await sql(`select status, task_id, friend_discount_kop from referrals where friend_id = $1`, [f]))[0];
  assert.equal(r.status, 'reward_manual');
  assert.ok(r.task_id);
  assert.equal(Number(r.friend_discount_kop), 32500);
});

test('настройки: выключенная программа не даёт скидку, право только у управляющего', async () => {
  assert.equal((await req('PUT', '/api/referrals/settings', 'm.volkova', { clubId: centr, enabled: false })).statusCode, 403);
  assert.equal((await req('PUT', '/api/referrals/settings', 'o.smirnov', { clubId: centr, friendPercent: 60 })).statusCode, 400);
  const s = await req('PUT', '/api/referrals/settings', 'o.smirnov', { clubId: centr, friendPercent: 0, referrerDays: 7 });
  assert.deepEqual(s.json(), { enabled: true, friendPercent: 0, referrerDays: 7 });
  const amb = await client(); await sell(amb, 'Годовой безлимит');
  const code = (await req('GET', `/api/persons/${amb}/referral`, 'm.volkova')).json().code;
  const f = await client();
  await req('POST', '/api/referrals/attach', 'm.volkova', { friendId: f, code, clubId: centr });
  const fm = await sell(f, 'Месяц безлимит');
  assert.equal((await ms(f, fm)).amountKop, 650000);
  await req('PUT', '/api/referrals/settings', 'o.smirnov', { clubId: centr, enabled: false });
  assert.match((await req('GET', `/r/${code}`, null)).body, /Приглашение не найдено/);
});

test('страница приглашения работает обычной формой, без скриптов', async () => {
  await req('PUT', '/api/referrals/settings', 'o.smirnov', { clubId: centr, enabled: true });
  const amb = await client(); await sell(amb, 'Месяц безлимит');
  const r = (await req('GET', `/api/persons/${amb}/referral`, 'a.bespalyy')).json();
  const page = await req('GET', `/r/${r.code}`, null);
  assert.doesNotMatch(page.body, /<script/); // встроенные скрипты запрещены настройками безопасности: форма работает без них
  const formPost = (o: Record<string, string>) => t.app.inject({ method: 'POST', url: `/r/${r.code}`, payload: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const noConsent = await formPost({ name: 'Анна Форма', phone: '+79006668888' });
  assert.equal(noConsent.statusCode, 400);
  assert.match(noConsent.body, /согласие/);
  assert.match(noConsent.body, /value="Анна Форма"/);
  assert.match((await formPost({ name: 'Анна Форма', phone: '+79006668888', consent: '1' })).body, /Спасибо!/);
});
