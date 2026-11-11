// Подсказки для допродаж: новичку — персональная, кончается пакет, частый гость, дневной тариф, длинный абонемент.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const clubs: Record<string, string> = {};
let tenant = '';
const prods: Record<string, { id: string; name: string }[]> = {};
let n = 0;
async function client(club: string) {
  return (await req('POST', '/api/leads', 'a.bespalyy', { clubId: clubs[club], fullName: `Допродажа Клиент ${++n}`, phone: `+7900777${String(n + 500).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId as string;
}
async function sell(club: string, personId: string, product: string, shift = 0) {
  const s = await req('POST', '/api/memberships', 'a.bespalyy', { personId, productId: prods[club].find((p) => p.name === product)!.id, confirmDuplicate: true });
  assert.equal(s.statusCode, 201, s.body);
  if (shift) await sql(`update memberships set starts_on = starts_on - $2::int, ends_on = ends_on - $2::int, created_at = created_at - make_interval(days => $2::int) where id = $1`, [s.json().id, shift]);
  return s.json().id as string;
}
const visits = (club: string, personId: string, list: [number, number][]) => Promise.all(list.map(([daysAgo, hour]) =>
  sql(`insert into visits(tenant_id, club_id, person_id, visited_at) select $1, c.id, $3, ((now() at time zone c.timezone)::date - $4::int + make_interval(hours => $5::int)) at time zone c.timezone from clubs c where c.id = $2`,
    [tenant, clubs[club], personId, daysAgo, hour])));
const hints = async (club: string, personId: string) => (await req('GET', `/api/persons/${personId}/upsell?clubId=${clubs[club]}`, 'a.bespalyy')).json().map((h: { text: string }) => ({ ...h, text: h.text.replace(/\s/g, ' ') })) as { key: string; text: string; productId: string }[];

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  for (const c of (await req('GET', '/api/clubs', 'a.bespalyy')).json()) clubs[c.name.includes('Центр') ? 'c' : 's'] = c.id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [clubs.c]))[0].tenant_id;
  for (const k of ['c', 's']) prods[k] = (await req('GET', `/api/products?clubId=${clubs[k]}`, 'a.bespalyy')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('новичку — вводная персональная; кончается пакет персональных — новый пакет', async () => {
  const p = await client('c');
  await sell('c', p, 'Месяц безлимит', 5);
  const h = await hints('c', p);
  assert.ok(h.find((x) => x.key === 'intro_pt'), JSON.stringify(h));
  assert.match(h.find((x) => x.key === 'intro_pt')!.text, /в клубе 6 дней/);
  const pt = await sell('c', p, 'Персональные тренировки, 10 занятий');
  await sql('update memberships set visits_left = 1 where id = $1', [pt]);
  const h2 = await hints('c', p);
  assert.equal(h2.some((x) => x.key === 'intro_pt'), false);
  assert.match(h2.find((x) => x.key === 'pt_renew')!.text, /осталось 1 занятие/);
});

test('пакет посещений кончается, а ходит часто — безлимит выгоднее', async () => {
  const p = await client('c');
  const m = await sell('c', p, '10 посещений', 40);
  await sql('update memberships set visits_left = 1 where id = $1', [m]);
  await visits('c', p, Array.from({ length: 9 }, (_, i) => [i * 3 + 1, 19] as [number, number]));
  const h = await hints('c', p);
  assert.match(h.find((x) => x.key === 'visits_to_unlimited')!.text, /ходит 9 раз в месяц: по пакету это 8 100 ₽. «Месяц безлимит» за 6 500 ₽ выгоднее/);
});

test('частый гость — абонемент; ходит днём — дневная подписка; регулярно с месячным — длинный', async () => {
  const g = await client('c');
  await sell('c', g, 'Гостевой визит', 20); await sell('c', g, 'Гостевой визит', 10); await sell('c', g, 'Гостевой визит');
  assert.match((await hints('c', g)).find((x) => x.key === 'guest_to_member')!.text, /Приходил разово 3 раза за 2 месяца и заплатил 3 000 ₽/);

  const d = await client('s');
  await sell('s', d, 'Подписка «Безлимит»', 20);
  await visits('s', d, [[1, 9], [3, 10], [5, 11], [8, 9], [10, 14], [12, 19]]);
  assert.match((await hints('s', d)).find((x) => x.key === 'daytime')!.text, /83 % визитов — до 17:00.*Подписка «Дневная»/);

  const r = await client('c');
  await sell('c', r, 'Месяц безлимит', 20);
  await visits('c', r, [[1, 18], [3, 18], [5, 18], [7, 18], [9, 18], [11, 18], [13, 18]]);
  const lt = (await hints('c', r)).find((x) => x.key === 'longer_term')!;
  assert.match(lt.text, /Годовой безлимит/);

  const b = await req('POST', '/api/upsell/batch', 'm.volkova', { clubId: clubs.c, personIds: [g, r] });
  assert.equal(b.statusCode, 200);
  assert.ok(b.json()[g].length && b.json()[r].length);
  const list = (await req('GET', `/api/upsell?clubId=${clubs.c}&who=trainer`, 'm.volkova')).json();
  assert.ok(list.rows.every((x: { hints: { who: string }[] }) => x.hints.every((h) => h.who === 'trainer')));
});
