// Бот сотрудников и утренняя сводка: токен шифруется, привязка по коду из профиля, сводка собственнику и управляющему раз в день.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { pollBot, notifyStaff } from '../src/modules/staffBot.ts';
import { sendMorning, actions, clubStats } from '../src/modules/morning.ts';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';
const sent: { chat: string; text: string }[] = [];
let updates: unknown[] = [];
const fakeFetch = (async (url: string, init?: { body?: string }) => {
  const u = String(url);
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  if (!u.startsWith(`https://api.telegram.org/bot${TOKEN}/`)) return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
  if (u.includes('/getMe')) return ok({ username: 'club_staff_bot' });
  if (u.includes('/getUpdates')) { const r = updates; updates = []; return ok(r); }
  if (u.includes('/sendMessage')) { const b = JSON.parse(init!.body!); sent.push({ chat: String(b.chat_id), text: b.text }); return ok({ message_id: sent.length }); }
  return ok(null);
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const asTenant = async <T>(fn: (c: pg.Client) => Promise<T>) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { await c.query(`select set_config('app.tenant_id', $1, false), set_config('app.all_clubs', 'on', false)`, [tenant]); return await fn(c); } finally { await c.end(); } };
let tenant = '';

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  tenant = (await sql(`select tenant_id from users where login = 'a.bespalyy'`))[0].tenant_id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

const linkVia = async (who: string, chat: number) => {
  const r = await req('POST', '/api/me/telegram/link', who);
  assert.equal(r.statusCode, 200, r.body);
  const code = new URL(r.json().url).searchParams.get('start')!;
  updates = [{ update_id: 100 + chat, message: { chat: { id: chat, type: 'private' }, from: { first_name: who }, text: `/start ${code}` } }];
  await asTenant((c) => pollBot(c as never, fakeFetch, tenant));
};

test('бот сотрудников: настраивает собственник, токен проверяется и не возвращается', async () => {
  assert.equal((await req('POST', '/api/me/telegram/link', 'o.smirnov')).statusCode, 400); // бот не подключён
  assert.equal((await req('PUT', '/api/staff-bot', 'o.smirnov', { token: TOKEN })).statusCode, 403);
  assert.equal((await req('PUT', '/api/staff-bot', 'a.bespalyy', { token: 'abc' })).statusCode, 400);
  assert.equal((await req('PUT', '/api/staff-bot', 'a.bespalyy', { token: '987654321:AAWrongTokenWrongTokenWrongToken_xyz' })).statusCode, 400);
  const ok = await req('PUT', '/api/staff-bot', 'a.bespalyy', { token: TOKEN, summaryHour: 8 });
  assert.equal(ok.statusCode, 200, ok.body);
  const g = await req('GET', '/api/staff-bot', 'a.bespalyy');
  assert.equal(g.json().username, 'club_staff_bot');
  assert.ok(!g.body.includes('AAFake'));
  const enc = (await sql('select token_enc from staff_bot'))[0].token_enc;
  assert.ok(enc.startsWith('v1:') && !enc.includes('AAFake'));
});

test('привязка по ссылке из профиля; уведомление через notifyStaff', async () => {
  await linkVia('o.smirnov', 5001);
  const me = (await req('GET', '/api/me/telegram', 'o.smirnov')).json();
  assert.ok(me.link);
  assert.equal(me.getsSummary, true);
  assert.match(sent.at(-1)!.text, /Telegram подключён/);
  // Старый код больше не работает
  updates = [{ update_id: 300, message: { chat: { id: 5009, type: 'private' }, text: '/start abcdefghij' } }];
  await asTenant((c) => pollBot(c as never, fakeFetch, tenant));
  assert.match(sent.at(-1)!.text, /устарела/);
  const gm = (await sql(`select id from users where login = 'o.smirnov'`))[0].id;
  const vol = (await sql(`select id from users where login = 'm.volkova'`))[0].id;
  assert.equal(await asTenant((c) => notifyStaff(c as never, fakeFetch, gm, 'Проверка')), true);
  assert.equal(sent.at(-1)!.chat, '5001');
  assert.equal(await asTenant((c) => notifyStaff(c as never, fakeFetch, vol, 'Проверка')), false);
});

test('утренняя сводка: управляющему по своему клубу, раз в день, с действиями и ссылками', async () => {
  await linkVia('a.bespalyy', 5002);
  await linkVia('m.volkova', 5003); // менеджер сводку не получает
  const n0 = sent.length;
  const k = await asTenant((c) => sendMorning(c as never, fakeFetch, tenant, true));
  assert.equal(k, 2);
  const forGm = sent.slice(n0).find((s) => s.chat === '5001')!.text;
  const forOwner = sent.slice(n0).find((s) => s.chat === '5002')!.text;
  assert.ok(!sent.slice(n0).some((s) => s.chat === '5003'));
  assert.match(forGm, /Выручка вчера/);
  assert.match(forGm, /Клуб «Центр»/);
  assert.match(forGm, /\?tab=dash/);
  assert.match(forOwner, /Север/); // собственник видит все клубы
  // Второй раз за день не уходит
  assert.equal(await asTenant((c) => sendMorning(c as never, fakeFetch, tenant, true)), 0);
  assert.equal((await sql('select count(*)::int as n from morning_summaries'))[0].n, 2);
  // /stop отключает сводку
  updates = [{ update_id: 400, message: { chat: { id: 5001, type: 'private' }, text: '/stop' } }];
  await asTenant((c) => pollBot(c as never, fakeFetch, tenant));
  assert.equal((await req('GET', '/api/me/telegram', 'o.smirnov')).json().link.summary, false);
  // Предпросмотр в интерфейсе
  assert.equal((await req('GET', '/api/morning-summary/preview', 'm.volkova')).statusCode, 400);
  assert.match((await req('GET', '/api/morning-summary/preview', 'o.smirnov')).json().text, /Что сделать сегодня|Всё по плану/);
});

test('три действия по важности', async () => {
  const club = (await sql(`select id, name, timezone from clubs where name like '%Центр%'`))[0];
  const s = await asTenant((c) => clubStats(c as never, club, '2026-11-10'));
  const a = actions({ ...s, lowOpen: 2, autopayFailed: 1, planKop: 100_000_00, mtdKop: 10_000_00, forecastKop: 30_000_00, daysLeft: 20, debtsCount: 5, debtsKop: 1_000_00 });
  assert.equal(a.length, 3);
  assert.match(a[0], /недовольным клиентам: 2/);
  assert.match(a[1], /автосписание: 1/);
  assert.match(a[2], /Догнать план: осталось 90 000 ₽, это 4 500 ₽ в день/);
});
