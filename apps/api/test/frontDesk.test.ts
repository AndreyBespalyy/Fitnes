// Быстрый режим ресепшна: поиск по телефону и карте, карточка с решением о проходе, пропустить, разовый визит, продлить, долг, фото, замеры.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';
let n = 0;
const products: Record<string, string> = {};
async function client(product?: string) {
  const phone = `+7900777${String(++n).padStart(4, '0')}`;
  const personId = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Гость Ресепшна ${n}`, phone, sourceCode: 'walk_in' })).json().personId as string;
  let membershipId = '';
  if (product) membershipId = (await req('POST', '/api/memberships', 'm.volkova', { personId, productId: products[product] })).json().id;
  return { personId, membershipId, phone };
}
const pay = async (membershipId: string) => {
  const ch = await sql(`select id from charges where membership_id = $1 and status = 'due'`, [membershipId]);
  for (const c of ch) { const r = await req('POST', `/api/charges/${c.id}/mark-paid`, 'd.lis', { method: 'card_terminal' }); assert.equal(r.statusCode, 200, r.body); }
};

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'm.volkova', 'd.lis', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  for (const p of (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json()) products[p.name] = p.id;
  // Тест не должен зависеть от часа запуска: клуб открыт круглосуточно
  await sql(`insert into club_access_settings(tenant_id, club_id, open_from, open_to) select tenant_id, id, '00:00', '23:59' from clubs where id = $1
    on conflict (club_id) do update set open_from = '00:00', open_to = '23:59'`, [centr]);
  await sql(`update club_membership_settings set contract_required_for_access = false where club_id = $1`, [centr]).catch(() => null);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('поиск по телефону, имени и карте; карточка с решением о проходе; пропустить', async () => {
  const a = await client('Месяц безлимит');
  await pay(a.membershipId);
  const byPhone = (await req('GET', `/api/desk/find?clubId=${centr}&q=${a.phone.slice(-7)}`, 'd.lis')).json();
  assert.equal(byPhone[0].id, a.personId);
  assert.match(byPhone[0].phone, /\*\*\*/); // телефон маскирован
  const byName = (await req('GET', `/api/desk/find?clubId=${centr}&q=${encodeURIComponent('Гость Ресепшна 1')}`, 'd.lis')).json();
  assert.ok(byName.some((x: { id: string }) => x.id === a.personId));
  const cred = (await req('POST', `/api/persons/${a.personId}/credentials`, 'd.lis', { kind: 'qr' })).json();
  const byCard = (await req('GET', `/api/desk/find?clubId=${centr}&q=${cred.code}`, 'd.lis')).json();
  assert.equal(byCard[0].id, a.personId);
  assert.equal(byCard[0].byCard, true);

  const card = (await req('GET', `/api/desk/person/${a.personId}?clubId=${centr}`, 'd.lis')).json();
  assert.equal(card.verdict.allow, true, card.verdict.reason);
  assert.equal(card.memberships[0].productName, 'Месяц безлимит');
  assert.equal(card.renew.productName, 'Месяц безлимит');
  assert.equal(card.single.name, 'Гостевой визит');
  assert.equal(card.canTakeMoney, true);

  const p = (await req('POST', '/api/desk/pass', 'd.lis', { clubId: centr, personId: a.personId })).json();
  assert.equal(p.ok, true);
  assert.equal(p.effect, 'new');
  const ev = (await sql(`select mode, decision from access_events where id = $1`, [p.eventId]))[0];
  assert.deepEqual(ev, { mode: 'desk', decision: 'allow' });
  assert.equal((await req('GET', `/api/desk/person/${a.personId}?clubId=${centr}`, 'd.lis')).json().inside, true);
  // Тренер не работает на ресепшне
  assert.equal((await req('GET', `/api/desk/find?clubId=${centr}&q=Гость`, 'a.kim')).statusCode, 403);
});

test('без абонемента не пропускает, разовый визит продаёт, оплачивает и пропускает', async () => {
  const b = await client();
  const no = (await req('POST', '/api/desk/pass', 'd.lis', { clubId: centr, personId: b.personId })).json();
  assert.equal(no.ok, false);
  assert.equal(no.reasonCode, 'no_membership');
  assert.equal((await sql(`select count(*)::int as n from access_events where person_id = $1`, [b.personId]))[0].n, 0);
  assert.equal((await req('POST', '/api/desk/single', 'd.lis', { clubId: centr, personId: b.personId })).statusCode, 400); // без способа оплаты
  const r = await req('POST', '/api/desk/single', 'd.lis', { clubId: centr, personId: b.personId, method: 'card_terminal' });
  assert.equal(r.statusCode, 201, r.body);
  const s = r.json();
  assert.equal(s.pass.ok, true, s.pass.reason);
  const ch = await sql(`select status, paid_method from charges where membership_id = $1`, [s.membershipId]);
  assert.deepEqual(ch, [{ status: 'paid', paid_method: 'card_terminal' }]);
  assert.equal((await sql(`select visits_left from memberships where id = $1`, [s.membershipId]))[0].visits_left, 0); // гостевой списан
});

test('продлить тем же тарифом с оплатой; погасить долг; фото; замеры', async () => {
  const c = await client('10 посещений');
  await pay(c.membershipId);
  const card = (await req('GET', `/api/desk/person/${c.personId}?clubId=${centr}`, 'd.lis')).json();
  assert.equal(card.renew.membershipId, c.membershipId);
  const r = await req('POST', '/api/desk/renew', 'd.lis', { membershipId: c.membershipId, method: 'sbp' });
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual(await sql(`select status from charges where membership_id = $1`, [r.json().membershipId]), [{ status: 'paid' }]);

  // долг: продажа без оплаты, ресепшн гасит одним нажатием
  const d = await client('Месяц безлимит');
  const dc = (await req('GET', `/api/desk/person/${d.personId}?clubId=${centr}`, 'd.lis')).json();
  assert.equal(dc.debts.length, 1);
  const paid = (await req('POST', '/api/desk/pay-debts', 'd.lis', { clubId: centr, personId: d.personId, method: 'card_terminal' })).json();
  assert.equal(paid.paid, 1);
  assert.equal(paid.totalKop, 650000);
  assert.equal((await req('GET', `/api/desk/person/${d.personId}?clubId=${centr}`, 'd.lis')).json().debts.length, 0);

  // фото: только картинка и не больше 400 КБ
  assert.equal((await req('PUT', `/api/persons/${d.personId}/photo`, 'd.lis', { image: 'data:text/html;base64,PGI+' })).statusCode, 400);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await req('PUT', `/api/persons/${d.personId}/photo`, 'd.lis', { image: `data:image/png;base64,${png}` })).statusCode, 200);
  const ph = await req('GET', `/api/persons/${d.personId}/photo`, 'd.lis');
  assert.equal(ph.statusCode, 200);
  assert.equal(ph.headers['content-type'], 'image/png');
  assert.equal((await req('GET', `/api/desk/find?clubId=${centr}&q=${d.phone.slice(-7)}`, 'd.lis')).json()[0].hasPhoto, true);

  for (const [op, ms, taps] of [['pass', 4000, 2], ['pass', 6000, 3], ['single', 15000, 4]] as const) {
    assert.equal((await req('POST', '/api/desk/ops', 'd.lis', { clubId: centr, op, ms, taps })).statusCode, 200);
  }
  assert.equal((await req('POST', '/api/desk/ops', 'd.lis', { clubId: centr, op: 'hack', ms: 1, taps: 1 })).statusCode, 400);
  const st = (await req('GET', `/api/desk/stats?clubId=${centr}`, 'd.lis')).json();
  const ps = st.ops.find((x: { op: string }) => x.op === 'pass');
  assert.equal(ps.n, 2);
  assert.equal(ps.medianMs, 5000);
  assert.equal(ps.avgTaps, 2.5);
});
