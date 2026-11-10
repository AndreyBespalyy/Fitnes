import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processMessaging, firstName } from '../src/modules/messaging.ts';

// Заглушка Telegram Bot API и Green-API
const sent: { url: string; body: unknown }[] = [];
let tgUpdates: unknown[] = [];
let greenFail = false;
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('api.telegram.org/botBAD')) return ok({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
  if (url.endsWith('/getMe')) return ok({ ok: true, result: { username: 'centr_fit_bot' } });
  if (url.includes('/getUpdates')) {
    const off = Number(new URL(url).searchParams.get('offset') ?? 0);
    return ok({ ok: true, result: (tgUpdates as { update_id: number }[]).filter((u) => u.update_id >= off) });
  }
  if (url.endsWith('/sendMessage') && url.includes('telegram')) { sent.push({ url, body }); return ok({ ok: true, result: { message_id: 900 + sent.length } }); }
  if (url.includes('green-api') && url.includes('/sendMessage/')) {
    if (greenFail) return ok({ message: 'Service unavailable' }, 503);
    sent.push({ url, body }); return ok({ idMessage: `GA${sent.length}` });
  }
  if (url.includes('green-api') && url.includes('receiveNotification')) return new Response('null', { status: 200 });
  return ok({ error: 'unexpected ' + url }, 404);
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string;
let app2: Awaited<ReturnType<typeof setupTestApp>>['app'];
before(async () => {
  t = await setupTestApp();
  // Второе приложение на той же базе — с заглушкой мессенджеров
  const { buildApp } = await import('../src/app.ts');
  app2 = await buildApp(t.pool, { fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'a.kim', 'i.zuev']) ck[l] = (await login(app2, l)).cookie!;
  c1 = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  // Рабочее время круглые сутки, чтобы тесты не зависели от часа запуска
  await req('PUT', `/api/msg/settings/${c1}`, 'o.smirnov', { workFrom: 0, workTo: 24, autoreplyEnabled: true, autoreplyText: 'Ответим утром', maxAutoPerWeek: 2 });
});
after(async () => { await app2.close(); await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) => app2.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const channel = async (messenger: string) => (await req('GET', `/api/msg/channels?clubId=${c1}`, 'o.smirnov')).json().find((c: { kind: string; messenger: string }) => c.kind === 'test' && c.messenger === messenger);

test('имя для обращения', () => {
  assert.equal(firstName('Иванова Мария Сергеевна'), 'Мария');
  assert.equal(firstName('Павел Рябов'), 'Павел');
});

test('права: тренер не видит переписку, менеджер не настраивает каналы', async () => {
  assert.equal((await req('GET', '/api/msg/conversations', 'a.kim')).statusCode, 403);
  assert.equal((await req('POST', '/api/msg/channels', 'm.volkova', { clubId: c1, kind: 'test', messenger: 'whatsapp' })).statusCode, 403);
  assert.equal((await req('GET', '/api/msg/conversations', 'm.volkova')).statusCode, 200);
});

test('новый клиент пишет в WhatsApp: лид с меткой источника, ответ менеджера закрывает первый ответ', async () => {
  const wa = await channel('whatsapp');
  const r = await req('POST', `/api/msg/channels/${wa.id}/simulate`, 'm.volkova', { name: 'Ольга Новая', phone: '+7 916 555-00-01', text: 'Хочу записаться на пробную' });
  assert.equal(r.statusCode, 200, r.body);
  const lead = (await sql(`select l.*, s.code from leads l join lead_sources s on s.id = l.source_id join persons p on p.id = l.person_id where p.full_name = 'Ольга Новая'`))[0];
  assert.equal(lead.code, 'whatsapp', 'заявка помечена каналом автоматически');
  assert.match(lead.comment, /пробную/);
  const convs = (await req('GET', `/api/msg/conversations?clubId=${c1}`, 'm.volkova')).json();
  const conv = convs.find((c: { personName: string }) => c.personName === 'Ольга Новая');
  assert.equal(conv.unread, 1);
  // Повторное сообщение из того же чата не создаёт вторую заявку
  await req('POST', `/api/msg/channels/${wa.id}/simulate`, 'm.volkova', { name: 'Ольга Новая', phone: '+79165550001', text: 'Алло?' });
  assert.equal((await sql(`select count(*)::int as n from leads l join persons p on p.id = l.person_id where p.full_name = 'Ольга Новая'`))[0].n, 1);
  // Шаблон с подстановкой имени и клуба
  const tpl = (await req('GET', `/api/msg/templates?clubId=${c1}`, 'm.volkova')).json().find((x: { name: string }) => x.name.startsWith('Приглашение'));
  const text = (await req('POST', `/api/msg/conversations/${conv.id}/render`, 'm.volkova', { templateId: tpl.id })).json().text;
  assert.match(text, /^Здравствуйте, Ольга! Это клуб «Центр»\./);
  const sentR = await req('POST', `/api/msg/conversations/${conv.id}/messages`, 'm.volkova', { text, templateId: tpl.id });
  assert.equal(sentR.statusCode, 201);
  assert.equal(sentR.json().status, 'sent');
  const after = (await sql(`select l.first_response_at, (select done_at from tasks where lead_id = l.id and kind = 'first_response') as done from leads l where l.id = $1`, [lead.id]))[0];
  assert.ok(after.first_response_at, 'время первого ответа записано');
  assert.ok(after.done, 'задача «первый ответ» закрыта');
  const msgs = (await req('GET', `/api/msg/conversations/${conv.id}/messages`, 'm.volkova')).json();
  assert.equal(msgs.messages.length, 3);
  assert.equal(msgs.conversation.unread, 0);
  // Менеджер другого клуба этот диалог не видит
  assert.equal((await req('GET', `/api/msg/conversations/${conv.id}/messages`, 'i.zuev')).statusCode, 404);
});

test('действующий клиент пишет по делу — сделка не создаётся; «СТОП» отключает автосообщения', async () => {
  const wa = await channel('whatsapp');
  const before = (await sql(`select count(*)::int as n from leads l join persons p on p.id = l.person_id where p.full_name = 'Кирилл Демин'`))[0].n;
  await req('POST', `/api/msg/channels/${wa.id}/simulate`, 'm.volkova', { name: 'Кирилл', phone: '+79150000190', text: 'Во сколько сегодня закрываетесь?' });
  assert.equal((await sql(`select count(*)::int as n from leads l join persons p on p.id = l.person_id where p.full_name = 'Кирилл Демин'`))[0].n, before);
  const conv = (await req('GET', `/api/msg/conversations?clubId=${c1}`, 'o.smirnov')).json().find((c: { personName: string }) => c.personName === 'Кирилл Демин');
  assert.ok(conv, 'диалог привязан к карточке клиента по телефону');
  await req('POST', `/api/msg/channels/${wa.id}/simulate`, 'm.volkova', { name: 'Кирилл', phone: '+79150000190', text: 'Стоп' });
  assert.equal((await sql(`select messaging_opt_out from persons where full_name = 'Кирилл Демин'`))[0].messaging_opt_out, true);
});

test('автоответ в нерабочее время — не чаще раза в 12 часов', async () => {
  const wa = await channel('whatsapp');
  const h = Number((await sql(`select extract(hour from now() at time zone 'Europe/Moscow')::int as h`))[0].h);
  // Рабочее время — один час, который сейчас не идёт
  const from = (h + 2) % 23; await req('PUT', `/api/msg/settings/${c1}`, 'o.smirnov', { workFrom: from, workTo: from + 1, autoreplyEnabled: true, autoreplyText: 'Ответим утром', maxAutoPerWeek: 2 });
  await req('POST', `/api/msg/channels/${wa.id}/simulate`, 'm.volkova', { name: 'Ночной Гость', phone: '+79165550099', text: 'Вы работаете?' });
  await req('POST', `/api/msg/channels/${wa.id}/simulate`, 'm.volkova', { name: 'Ночной Гость', phone: '+79165550099', text: 'Ау' });
  const auto = (await sql(`select m.body from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.external_chat_id = '79165550099' and m.direction = 'out'`));
  assert.deepEqual(auto.map((x) => x.body), ['Ответим утром']);
  await req('PUT', `/api/msg/settings/${c1}`, 'o.smirnov', { workFrom: 0, workTo: 24, autoreplyEnabled: true, autoreplyText: 'Ответим утром', maxAutoPerWeek: 2 });
});

test('Telegram-бот: подключение по токену, приём опросом без дублей, ответ клиенту', async () => {
  const bad = (await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: c1, kind: 'telegram_bot', messenger: 'telegram', secret: 'BAD' })).json();
  assert.equal((await req('POST', `/api/msg/channels/${bad.id}/test`, 'o.smirnov')).json().info, 'Токен бота неверный');
  await req('PATCH', `/api/msg/channels/${bad.id}`, 'o.smirnov', { status: 'disabled' });
  const r = await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: c1, kind: 'telegram_bot', messenger: 'telegram', name: 'Бот клуба', secret: '123:SECRET' });
  assert.equal(r.statusCode, 201);
  const ch = r.json();
  assert.equal(ch.secret_enc, undefined); assert.equal(ch.hasSecret, true);
  const list = (await req('GET', `/api/msg/channels?clubId=${c1}`, 'o.smirnov')).body;
  assert.ok(!list.includes('123:SECRET'), 'токен не отдаётся в интерфейс');
  assert.equal((await sql('select secret_enc like $1 as plain from msg_channels where id = $2', ['%SECRET%', ch.id]))[0].plain, false, 'токен в базе зашифрован');
  assert.equal((await req('POST', `/api/msg/channels/${ch.id}/test`, 'o.smirnov')).json().info, 'Бот @centr_fit_bot подключён');

  tgUpdates = [{ update_id: 501, message: { message_id: 11, date: Math.floor(Date.now() / 1000), chat: { id: 777001, type: 'private' }, from: { first_name: 'Антон', last_name: 'Телеграмов' }, text: 'Сколько стоит месяц?' } }];
  await processMessaging(t.pool, fakeFetch, { triggers: false });
  await processMessaging(t.pool, fakeFetch, { triggers: false }); // повторный опрос не дублирует
  const p = (await sql(`select p.id, s.code from persons p join leads l on l.person_id = p.id join lead_sources s on s.id = l.source_id where p.full_name = 'Антон Телеграмов'`));
  assert.equal(p.length, 1);
  assert.equal(p[0].code, 'telegram');
  assert.equal((await sql(`select normalized_value from person_contacts where person_id = $1 and type = 'telegram'`, [p[0].id]))[0].normalized_value, 'tg:777001');
  const conv = (await req('GET', `/api/msg/conversations?personId=${p[0].id}`, 'o.smirnov')).json()[0];
  const m = (await req('GET', `/api/msg/conversations/${conv.id}/messages`, 'o.smirnov')).json().messages;
  assert.equal(m.length, 1);
  assert.equal((await sql(`select poll_offset from msg_channels where id = $1`, [ch.id]))[0].poll_offset, '501');
  await req('POST', `/api/msg/conversations/${conv.id}/messages`, 'o.smirnov', { text: 'Месяц — 6 500 ₽' });
  assert.deepEqual(sent.at(-1)!.body, { chat_id: '777001', text: 'Месяц — 6 500 ₽' });
});

test('WhatsApp через Green-API: при сбое сообщение не теряется, повторяется и помечается «не отправлено»', async () => {
  const r = (await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: c1, kind: 'green_api', messenger: 'whatsapp', settings: { idInstance: '1101000001' }, secret: 'tok' })).json();
  const person = (await sql(`select id from persons where full_name = 'Павел Рябов'`))[0].id;
  const conv = (await req('POST', `/api/persons/${person}/conversations`, 'o.smirnov', { channelId: r.id })).json();
  greenFail = true;
  const m = (await req('POST', `/api/msg/conversations/${conv.id}/messages`, 'o.smirnov', { text: 'Ваша тренировка перенесена на 19:00' })).json();
  assert.equal(m.status, 'queued');
  assert.match(m.error, /Green-API/);
  for (let i = 0; i < 4; i++) { await sql(`update msg_messages set next_attempt_at = now() where id = $1`, [m.id]); await processMessaging(t.pool, fakeFetch, { triggers: false }); }
  assert.equal((await sql(`select status, attempts from msg_messages where id = $1`, [m.id]))[0].status, 'failed');
  greenFail = false;
  assert.equal((await req('POST', `/api/msg/messages/${m.id}/retry`, 'o.smirnov')).json().status, 'sent');
  assert.deepEqual(sent.at(-1)!.body, { chatId: '79260000155@c.us', message: 'Ваша тренировка перенесена на 19:00' });
  // Telegram по телефону начать нельзя
  const tg = await channel('telegram');
  assert.equal((await req('POST', `/api/persons/${person}/conversations`, 'o.smirnov', { channelId: tg.id })).statusCode, 400);
  await req('PATCH', `/api/msg/channels/${r.id}`, 'o.smirnov', { status: 'disabled' });
});

test('автосообщения: предпросмотр, отправка один раз, согласие и отписка', async () => {
  const trig = (await req('GET', `/api/msg/triggers?clubId=${c1}`, 'o.smirnov')).json();
  assert.deepEqual(trig.map((x: { event: string }) => x.event), ['membership_ending', 'debt_overdue', 'inactive', 'birthday', 'welcome', 'ai_nurture']);
  assert.ok(trig.every((x: { enabled: boolean }) => !x.enabled), 'по умолчанию выключены');
  const ending = trig[0];
  assert.equal((await req('POST', `/api/msg/triggers/${ending.id}/run`, 'o.smirnov')).statusCode, 400, 'выключенное не запускается');
  const prev = (await req('GET', `/api/msg/triggers/${ending.id}/preview`, 'o.smirnov')).json();
  const gromov = prev.ready.find((x: { name: string }) => x.name === 'Алексей Громов');
  assert.ok(gromov, JSON.stringify(prev));
  assert.match(gromov.text, /Алексей! Ваш абонемент «Полгода безлимит» в клубе «Центр» заканчивается \d{2}\.\d{2}\.\d{4}/);
  assert.equal((await sql(`select count(*)::int as n from msg_trigger_sends`))[0].n, 0, 'предпросмотр ничего не отправляет');
  await req('PUT', `/api/msg/triggers/${ending.id}`, 'o.smirnov', { enabled: true });
  const run = (await req('POST', `/api/msg/triggers/${ending.id}/run`, 'o.smirnov')).json();
  assert.ok(run.sent >= 1);
  const again = (await req('POST', `/api/msg/triggers/${ending.id}/run`, 'o.smirnov')).json();
  assert.equal(again.sent, 0, 'повторно тому же клиенту за тот же абонемент не отправляется');
  const msg = (await sql(`select m.status, m.auto, c.external_chat_id from msg_messages m join msg_conversations c on c.id = m.conversation_id where m.trigger_id = $1`, [ending.id]));
  assert.ok(msg.some((x) => x.external_chat_id === '79160000121' && x.status === 'sent' && x.auto));

  // День рождения — рекламное: без согласия не уходит, отписавшимся не уходит
  const bday = trig.find((x: { event: string }) => x.event === 'birthday');
  await sql(`update persons set birth_date = (now() at time zone 'Europe/Moscow')::date - interval '25 years' where full_name in ('Кирилл Демин', 'Глеб Ушаков', 'Павел Рябов')`);
  const bp = (await req('GET', `/api/msg/triggers/${bday.id}/preview`, 'o.smirnov')).json();
  const reason = (n: string) => bp.skipped.find((x: { name: string }) => x.name === n)?.reason;
  assert.equal(reason('Кирилл Демин'), 'клиент отписался от сообщений');
  assert.equal(reason('Глеб Ушаков'), 'нет согласия на рекламные сообщения');
  assert.ok(bp.ready.some((x: { name: string }) => x.name === 'Павел Рябов'));
  // Согласие ставится в карточке клиента
  const ushakov = (await sql(`select id from persons where full_name = 'Глеб Ушаков'`))[0].id;
  await req('POST', `/api/persons/${ushakov}/messaging`, 'm.volkova', { marketingConsent: true });
  const bp2 = (await req('GET', `/api/msg/triggers/${bday.id}/preview`, 'o.smirnov')).json();
  assert.ok(bp2.ready.some((x: { name: string }) => x.name === 'Глеб Ушаков'));
});

test('входящие от провайдера на внешний адрес: только с секретом канала', async () => {
  const r = (await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: c1, kind: 'wazzup', messenger: 'whatsapp', settings: { channelId: '11111111-2222-3333-4444-555555555555' }, secret: 'key' })).json();
  const url = (await req('GET', `/api/msg/channels?clubId=${c1}`, 'o.smirnov')).json().find((c: { id: string }) => c.id === r.id).webhookUrl as string;
  const path = new URL(url).pathname;
  const payload = { messages: [{ messageId: 'wz-1', channelId: '11111111-2222-3333-4444-555555555555', chatType: 'whatsapp', chatId: '79165550777', type: 'text', text: 'Есть парковка?', contact: { name: 'Вера Вацап' }, isEcho: false }] };
  assert.equal((await app2.inject({ method: 'POST', url: path.replace(/[^/]+$/, 'wrong'), payload })).statusCode, 404);
  assert.equal((await app2.inject({ method: 'POST', url: path, payload })).statusCode, 200);
  assert.equal((await app2.inject({ method: 'POST', url: path, payload })).statusCode, 200);
  assert.equal((await sql(`select count(*)::int as n from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.external_chat_id = '79165550777'`))[0].n, 1);
  // Эхо собственных исходящих не считается входящим
  await app2.inject({ method: 'POST', url: path, payload: { messages: [{ ...payload.messages[0], messageId: 'wz-2', isEcho: true }] } });
  assert.equal((await sql(`select count(*)::int as n from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.external_chat_id = '79165550777'`))[0].n, 1);
});
