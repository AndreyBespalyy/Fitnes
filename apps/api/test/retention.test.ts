// Возврат бывших клиентов (группы, кампания, ответы, покупки) и досрочное продление с фиксированной ценой.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { earlyRenewals, trackResults } from '../src/modules/retention.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
let centr = ''; let tenant = ''; let today = '';
let n = 0;
async function sold(product: string, shiftDays: number, consent: boolean, phone = true) {
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Удержание Клиент ${++n}`, phone: phone ? `+7900888${String(n).padStart(4, '0')}` : undefined, sourceCode: 'walk_in' })).json().personId as string;
  const p = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === product);
  const s = await req('POST', '/api/memberships', 'm.volkova', { personId, productId: p.id, confirmDuplicate: true });
  assert.equal(s.statusCode, 201, s.body);
  const id = s.json().id;
  await sql(`update memberships set starts_on = starts_on - $2::int, ends_on = ends_on - $2::int, created_at = created_at - make_interval(days => $2::int) where id = $1`, [id, shiftDays]);
  await sql(`update persons set marketing_consent = $2 where id = $1`, [personId, consent]);
  return { personId, membershipId: id as string, productId: p.id as string };
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  const r = (await sql(`select tenant_id, to_char(now() at time zone timezone, 'YYYY-MM-DD') as d from clubs where id = $1`, [centr]))[0];
  tenant = r.tenant_id; today = r.d;
});
after(async () => { await t.app.close(); await t.pool.end(); });

let a: Awaited<ReturnType<typeof sold>>; let b: Awaited<ReturnType<typeof sold>>; let c: Awaited<ReturnType<typeof sold>>;
test('бывшие клиенты делятся на группы по давности ухода и по тому, как с ними связаться', async () => {
  a = await sold('Месяц безлимит', 100, true);   // ушёл ~2 месяца назад, есть согласие → сообщение
  b = await sold('Месяц безлимит', 110, false);  // без согласия → звонок
  c = await sold('Месяц безлимит', 250, true);   // ~7 месяцев назад
  assert.equal((await req('GET', `/api/retention/segments?clubId=${centr}`, 'm.volkova')).statusCode, 403);
  const s = (await req('GET', `/api/retention/segments?clubId=${centr}`, 'o.astafeva')).json();
  const m1 = s.groups.find((g: { key: string }) => g.key === 'm1');
  assert.ok(m1.count >= 2, JSON.stringify(s.groups));
  assert.ok(s.groups.find((g: { key: string }) => g.key === 'm6').count >= 1);
  const pv = (await req('POST', '/api/retention/preview', 'o.astafeva', { clubId: centr, monthsFrom: 1, monthsTo: 3 })).json();
  const ra = pv.sample.find((x: { personId: string }) => x.personId === a.personId);
  const rb = pv.sample.find((x: { personId: string }) => x.personId === b.personId);
  assert.equal(ra.channel, 'message');
  assert.equal(rb.channel, 'call');
  assert.match(rb.reason, /согласия/);
  assert.ok(!pv.sample.some((x: { personId: string }) => x.personId === c.personId));
  assert.equal((await req('POST', '/api/retention/preview', 'o.astafeva', { clubId: centr, monthsFrom: 3, monthsTo: 2 })).statusCode, 400);
});

test('кампания: сообщения с согласием, звонки остальным; ответ — задача менеджеру, покупка засчитывается', async () => {
  const cr = await req('POST', '/api/retention/campaigns', 'o.astafeva', { clubId: centr, name: 'Возвращение осень', monthsFrom: 1, monthsTo: 3, offer: 'первый месяц за 3 900 ₽' });
  assert.equal(cr.statusCode, 201, cr.body);
  const id = cr.json().id;
  const st = (await req('POST', `/api/retention/campaigns/${id}/launch`, 'o.astafeva')).json();
  assert.ok(st.message >= 1 && st.call >= 1, JSON.stringify(st));
  assert.equal((await req('POST', `/api/retention/campaigns/${id}/launch`, 'o.astafeva')).statusCode, 400);
  const msg = await sql(`select m.body from campaign_members cm join msg_messages m on m.id = cm.message_id where cm.person_id = $1`, [a.personId]);
  assert.match(msg[0].body, /первый месяц за 3 900 ₽/);
  assert.match(msg[0].body, /Центр/);
  const callTask = await sql(`select t.title, t.assignee_id from campaign_members cm join tasks t on t.id = cm.task_id where cm.person_id = $1`, [b.personId]);
  assert.match(callTask[0].title, /Возврат: Возвращение осень/);
  assert.ok(callTask[0].assignee_id);
  // Клиент ответил в мессенджере → задача «позвонить»
  await sql(`insert into msg_messages(tenant_id, club_id, conversation_id, direction, body, status)
    select m.tenant_id, m.club_id, m.conversation_id, 'in', 'Интересно, а когда можно прийти?', 'received' from campaign_members cm join msg_messages m on m.id = cm.message_id where cm.person_id = $1`, [a.personId]);
  await asOwner((c) => trackResults(c as never, { tenantId: tenant, userId: null }, centr));
  const replied = await sql(`select cm.replied_at, t.title from campaign_members cm join tasks t on t.id = cm.task_id where cm.person_id = $1`, [a.personId]);
  assert.ok(replied[0].replied_at);
  assert.match(replied[0].title, /Ответил на предложение/);
  // Купил → в отчёте кампании
  const p = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === 'Месяц безлимит');
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: a.personId, productId: p.id })).statusCode, 201);
  const list = (await req('GET', `/api/retention/campaigns?clubId=${centr}`, 'o.astafeva')).json();
  const camp = list.find((x: { id: string }) => x.id === id);
  assert.equal(camp.bought, 1);
  assert.equal(camp.replied, 1);
  assert.ok(Number(camp.revenueKop) > 0);
  const det = (await req('GET', `/api/retention/campaigns/${id}`, 'o.astafeva')).json();
  assert.ok(det.members.length >= 2);
  // Повторно в другую кампанию в течение 30 дней не попадает
  const pv = (await req('POST', '/api/retention/preview', 'o.astafeva', { clubId: centr, monthsFrom: 1, monthsTo: 3 })).json();
  assert.equal(pv.sample.find((x: { personId: string }) => x.personId === b.personId).channel, 'skip');
});

test('досрочное продление: предложение за 30 дней по текущей цене, цена держится при подорожании', async () => {
  const m = await sold('Месяц безлимит', 10, false); // заканчивается через ~20 дней
  const noPhone = await sold('Месяц безлимит', 12, false);
  await sql(`update persons set messaging_opt_out = true where id = $1`, [noPhone.personId]);
  const cnt = await asOwner((c) => earlyRenewals(c as never, null, { tenantId: tenant, userId: null }, centr, today));
  assert.ok(cnt >= 2);
  const offer = (await sql(`select * from renewal_offers where membership_id = $1`, [m.membershipId]))[0];
  assert.equal(offer.status, 'sent'); // в клубе подключён WhatsApp — сообщение, это не реклама, согласие не нужно
  assert.equal(Number(offer.amount_kop), 650_000);
  const body = (await sql(`select body from msg_messages where id = $1`, [offer.message_id]))[0].body;
  assert.match(body, /6\s500 ₽/u);
  const opt = (await sql(`select status, skip_reason, task_id from renewal_offers where membership_id = $1`, [noPhone.membershipId]))[0];
  assert.equal(opt.status, 'call');
  assert.ok(opt.task_id);
  // Второй раз не предлагается
  assert.equal(await asOwner((c) => earlyRenewals(c as never, null, { tenantId: tenant, userId: null }, centr, today)), 0);
  // Тариф подорожал — продление по цене из предложения
  assert.equal((await req('PATCH', `/api/products/${m.productId}`, 'o.smirnov', { priceKop: 720_000 })).statusCode, 200);
  const r = await req('POST', '/api/memberships', 'm.volkova', { personId: m.personId, productId: m.productId, renewFromId: m.membershipId });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(Number((await sql('select amount_kop from memberships where id = $1', [r.json().id]))[0].amount_kop), 650_000);
  assert.equal((await sql(`select status from renewal_offers where membership_id = $1`, [m.membershipId]))[0].status, 'used');
  // Новый клиент платит уже новую цену
  const fresh = await sold('Месяц безлимит', 0, false);
  assert.equal(Number((await sql('select amount_kop from memberships where id = $1', [fresh.membershipId]))[0].amount_kop), 720_000);
  const early = (await req('GET', `/api/retention/early?clubId=${centr}`, 'o.astafeva')).json();
  assert.ok(early.renewed >= 1);
  assert.equal((await req('PUT', '/api/retention/early', 'o.astafeva', { clubId: centr, enabled: true, days: 5 })).statusCode, 400);
});
