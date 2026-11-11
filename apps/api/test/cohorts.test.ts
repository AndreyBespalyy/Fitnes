// Удержание по месяцам прихода и ценность клиента: когорты, доля оставшихся через 1–12 месяцев, деньги по каналам и тарифам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { valueBy, retentionMatrix } from '../src/modules/cohorts.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = '';
const products: Record<string, string> = {};

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'm.volkova', 'd.lis', 'e.orlova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  for (const p of (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json()) products[p.name] = p.id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

async function sale(personId: string, created: string, starts: string, ends: string) {
  const id = (await req('POST', '/api/memberships', 'm.volkova', { personId, productId: products['Месяц безлимит'], confirmDuplicate: true })).json().id;
  for (const c of await sql(`select id from charges where membership_id = $1`, [id])) await req('POST', `/api/charges/${c.id}/mark-paid`, 'd.lis', { method: 'card_terminal' });
  await sql(`update memberships set created_at = $2::timestamptz, starts_on = $3, ends_on = $4 where id = $1`, [id, `${created}T12:00:00+03:00`, starts, ends]);
  return id;
}

test('когорта: доля оставшихся по месяцам и деньги клиента', async () => {
  const lead = async (name: string, phone: string) => (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: name, phone, sourceCode: 'walk_in' })).json().personId as string;
  const a = await lead('Когорта Первый', '+79005550001');
  const b = await lead('Когорта Второй', '+79005550002');
  await sale(a, '2025-12-10', '2025-12-10', '2026-01-09');
  await sale(a, '2026-02-01', '2026-02-01', '2026-03-31');
  await sale(b, '2025-12-12', '2025-12-12', '2025-12-31');

  assert.equal((await req('GET', `/api/cohorts?clubId=${centr}`, 'd.lis')).statusCode, 403); // ресепшну не нужно
  const r = await req('GET', `/api/cohorts?clubId=${centr}&months=13`, 'e.orlova');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  const dec = d.cohorts.find((c: { cohort: string }) => c.cohort === '2025-12');
  assert.ok(dec, JSON.stringify(d.cohorts.map((c: { cohort: string }) => c.cohort)));
  assert.equal(dec.clients, 2);
  assert.deepEqual(dec.retained, [50, 50, 50, 0, null]); // январь, февраль, март — первый с нами; июнь — никого; декабрь 2026 ещё не наступил
  assert.equal(dec.avgKop, 975000); // (6 500 × 2 + 6 500) / 2
  assert.ok(d.by.tariff.some((x: { name: string }) => x.name === 'Месяц безлимит'));
  assert.ok(d.by.seller.some((x: { name: string }) => x.name.includes('Волкова')));
});

test('разрезы: средние деньги, доля оставшихся только среди тех, у кого срок прошёл', () => {
  const p = (cohort: string, channel: string, kop: number, months: string[]) => ({ personId: '', clubId: '', cohort, tariff: 'Т', promo: false, seller: 'С', channel, trainer: null, kop, months });
  const people = [
    p('2026-01', 'Яндекс', 3000000, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-07']),
    p('2026-01', 'Яндекс', 650000, ['2026-01']),
    p('2026-10', 'Яндекс', 650000, ['2026-10']), // 3 месяца ещё не прошло
    p('2026-01', 'Акция ВК', 300000, ['2026-01']),
  ];
  const v = valueBy(people, (x) => x.channel, '2026-11');
  const y = v.find((x) => x.name === 'Яндекс')!;
  assert.equal(y.clients, 3);
  assert.equal(y.avgKop, Math.round(4300000 / 3));
  assert.deepEqual(y.after3, { pct: 50, n: 2 });
  assert.deepEqual(y.after6, { pct: 50, n: 2 });
  assert.equal(v[0].name, 'Яндекс'); // сортировка по общей сумме
  assert.deepEqual(v.find((x) => x.name === 'Акция ВК')!.after3, { pct: 0, n: 1 });
  const m = retentionMatrix(people, '2026-11');
  assert.deepEqual(m.find((x) => x.cohort === '2026-10')!.retained, [0, null, null, null, null]);
});
