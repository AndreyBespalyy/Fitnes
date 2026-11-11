// Клиентский Telegram-бот: узнаёт клиента только по своему номеру, показывает абонемент, замораживает, продлевает с оплатой.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processMessaging } from '../src/modules/messaging.ts';

type Sent = { chat_id: string; text: string; reply_markup?: { keyboard?: { text: string; request_contact?: boolean }[][]; remove_keyboard?: boolean } };
const sent: Sent[] = [];
let updates: unknown[] = [];
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/getUpdates')) {
    const off = Number(new URL(url).searchParams.get('offset') ?? 0);
    return ok({ ok: true, result: (updates as { update_id: number }[]).filter((u) => u.update_id >= off) });
  }
  if (url.endsWith('/sendMessage')) { sent.push(JSON.parse(String(init!.body))); return ok({ ok: true, result: { message_id: 5000 + sent.length } }); }
  return ok({ ok: true, result: { username: 'club_bot' } });
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const PDF = Buffer.from('%PDF-1.4\n% оферта\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF').toString('base64');
const CHAT = 880001;
const ME = 42;
let centr = ''; let bot = ''; let upd = 1000; let msgId = 1;

/** Клиент пишет боту; возвращает ответы бота на это сообщение. */
async function say(m: { text?: string; contact?: { phone_number: string; user_id?: number } }) {
  const before = sent.length;
  updates = [{ update_id: ++upd, message: { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' }, from: { id: ME, first_name: 'Павел' }, ...m } }];
  await processMessaging(t.pool, fakeFetch, { triggers: false });
  return sent.slice(before);
}
const buttons = (s: Sent) => (s.reply_markup?.keyboard ?? []).flat().map((b) => b.text);

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  bot = (await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: centr, kind: 'telegram_bot', messenger: 'telegram', name: 'Бот клуба', secret: '1:TOKEN' })).json().id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('включение: только управляющий, только Telegram-бот клуба', async () => {
  assert.equal((await req('PATCH', `/api/msg/channels/${bot}`, 'm.volkova', { clientBot: true })).statusCode, 403);
  const wa = (await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: centr, kind: 'test', messenger: 'whatsapp' })).json().id;
  assert.match((await req('PATCH', `/api/msg/channels/${wa}`, 'o.smirnov', { clientBot: true })).json().message, /только в собственном Telegram-боте/);
  assert.equal((await req('PATCH', `/api/msg/channels/${bot}`, 'o.smirnov', { clientBot: true })).statusCode, 200);
  assert.equal((await req('GET', `/api/msg/channels?clubId=${centr}`, 'o.smirnov')).json().find((c: { id: string }) => c.id === bot).clientBot, true);
});

test('узнаёт клиента только по своему номеру, чужой контакт не подходит', async () => {
  const [hello] = await say({ text: '/start' });
  assert.match(hello.text, /Поделиться номером/);
  assert.equal(hello.reply_markup!.keyboard![0][0].request_contact, true);
  // Без номера кнопки не работают
  assert.match((await say({ text: 'Мой абонемент' }))[0].text, /Сначала поделитесь номером/);
  // Переслал чужой контакт — бот молчит, сообщение ждёт менеджера, клиент не привязан
  assert.equal((await say({ contact: { phone_number: '+79260000155', user_id: 777 } })).length, 0);
  assert.equal((await sql('select bot_person_id from msg_conversations where external_chat_id = $1', [String(CHAT)]))[0].bot_person_id, null);
  // Свой номер незнакомого клиента — честный ответ
  assert.match((await say({ contact: { phone_number: '+79009998877', user_id: ME } }))[0].text, /Не нашли клиента/);
  const [done] = await say({ contact: { phone_number: '79260000155', user_id: ME } });
  assert.match(done.text, /^Готово, Павел!/);
  assert.deepEqual(buttons(done), ['Мой абонемент', 'Продлить', 'Заморозить', 'Написать в клуб']);
  const conv = (await sql(`select c.bot_person_id, p.full_name from msg_conversations c join persons p on p.id = c.bot_person_id where c.external_chat_id = $1`, [String(CHAT)]))[0];
  assert.equal(conv.full_name, 'Павел Рябов');
});

test('мой абонемент и заморозка по правилам клуба', async () => {
  const [my] = await say({ text: 'Мой абонемент' });
  assert.match(my.text, /«Годовой безлимит», действует до \d\d\.\d\d\.\d{4} \(осталось \d+ дн\.\)/);
  const before = (await sql(`select m.id, to_char(m.ends_on, 'YYYY-MM-DD') as ends from memberships m join persons p on p.id = m.person_id where p.full_name = 'Павел Рябов' and m.product_name = 'Годовой безлимит'`))[0];
  assert.match((await say({ text: 'Заморозить' }))[0].text, /На сколько дней заморозить «Годовой безлимит»/);
  assert.match((await say({ text: 'много' }))[0].text, /Напишите число дней/);
  const [ask] = await say({ text: '14' });
  assert.match(ask.text, /Заморозить «Годовой безлимит» с .* по .*\? Абонемент продлится до/);
  assert.deepEqual(buttons(ask), ['Да, заморозить', 'Отмена']);
  assert.match((await say({ text: 'Да, заморозить' }))[0].text, /^Готово: абонемент заморожен/);
  const after = (await sql(`select to_char(ends_on, 'YYYY-MM-DD') as ends, (select count(*)::int from freezes f where f.membership_id = m.id) as n from memberships m where id = $1`, [before.id]))[0];
  assert.equal(after.n, 1);
  assert.equal(new Date(after.ends).getTime() - new Date(before.ends).getTime(), 14 * 86_400_000);
  // Лимит клуба проверяется так же, как на ресепшне
  await say({ text: 'Заморозить' });
  await say({ text: '365' });
  assert.match((await say({ text: 'Да, заморозить' }))[0].text, /^Не получилось: /);
});

test('продление: тариф, оферта, оплата по ссылке банка, абонемент оформлен, подтверждение в боте', async () => {
  // Онлайн-покупка в клубе выключена — бот отправляет к менеджеру
  assert.match((await say({ text: 'Продлить' }))[0].text, /Продлить можно на ресепшне/);
  await req('POST', `/api/clubs/${centr}/documents`, 'o.smirnov', { kind: 'contract', fileName: 'Оферта.pdf', dataBase64: PDF });
  const month = (await req('GET', `/api/products?clubId=${centr}`, 'o.smirnov')).json().find((p: { name: string }) => p.name === 'Месяц безлимит').id;
  assert.equal((await req('PUT', '/api/online-buy/settings', 'o.smirnov', { clubId: centr, enabled: true, productIds: [month] })).statusCode, 200);
  const [list] = await say({ text: 'Продлить' });
  assert.match(list.text, /1\. Месяц безлимит — /);
  const [offer] = await say({ text: '1' });
  assert.match(offer.text, /договор-оферту и правила клуба \(.*\/buy\/.*\/doc\/contract\)/);
  const [link] = await say({ text: 'Принимаю и оплачиваю' });
  const opId = /\/pay\/([0-9a-f-]{36})/.exec(link.text)![1];
  // Клиент не новый: заявка в воронку не создаётся
  assert.equal((await sql(`select count(*)::int as n from leads l join persons p on p.id = l.person_id where p.full_name = 'Павел Рябов' and l.comment like 'Покупка онлайн%'`))[0].n, 0);
  await t.app.inject({ method: 'POST', url: `/pay/${opId}/test`, payload: 'method=card&card=4242424242424242&result=pay', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const back = await t.app.inject({ url: `/pay/${opId}` });
  if (back.headers.location) await t.app.inject({ url: String(back.headers.location) });
  const m = await sql(`select m.status, c.sign_method from memberships m join persons p on p.id = m.person_id join contracts c on c.membership_id = m.id where p.full_name = 'Павел Рябов' and m.product_name = 'Месяц безлимит'`);
  assert.deepEqual(m.map((x) => [x.status, x.sign_method]), [['active', 'online_offer']]);
  updates = [];
  const before = sent.length;
  await processMessaging(t.pool, fakeFetch, { triggers: false });
  assert.match(sent.slice(before).map((s) => s.text).join('\n'), /Оплата получена, спасибо! Абонемент «Месяц безлимит» оформлен/);
});

test('обычный вопрос уходит менеджеру, бот не перебивает', async () => {
  assert.equal((await say({ text: 'Есть ли у вас парковка?' })).length, 0);
  assert.match((await say({ text: 'Написать в клуб' }))[0].text, /менеджер клуба ответит здесь/);
  assert.equal((await say({ text: 'Можно прийти с ребёнком?' })).length, 0);
  const conv = (await sql(`select unread from msg_conversations where external_chat_id = $1`, [String(CHAT)]))[0];
  assert.ok(conv.unread >= 2);
});
