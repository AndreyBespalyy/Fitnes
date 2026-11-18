// Свой модуль переписки (18.11.2026): Telegram-аккаунт клуба, WhatsApp для бизнеса напрямую, разбор переписки ИИ
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processMessaging } from '../src/modules/messaging.ts';
import { liveSenders } from '../src/modules/msgProviders.ts';
import { tgInbound, tgErrorText } from '../src/modules/tgUser.ts';
import { processChats, chatSummariesOf } from '../src/modules/chatAi.ts';
import { withCtx } from '../src/db.ts';

const sent: { url: string; body: Record<string, unknown> | null }[] = [];
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://graph.facebook.com/v21.0/1234567890?')) return ok({ display_phone_number: '+7 900 000-00-00', verified_name: 'Фитнес Центр' });
  if (url === 'https://graph.facebook.com/v21.0/1234567890/messages') {
    sent.push({ url, body });
    // Клиент давно не писал: текстом нельзя, только шаблоном
    if (body?.type === 'text' && String(body.to).endsWith('0000') ) return ok({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
    return ok({ messages: [{ id: `wamid.${sent.length}` }] });
  }
  if (url.endsWith('/v1/summarize')) {
    return ok({ summary: { essence: 'Клиент спросил цену абонемента, менеджер пригласил на пробную тренировку', need: 'Тренировки утром', objections: ['Дорого'],
      agreements: 'Придёт в субботу', outcome: 'interested', nextStep: { title: 'Напомнить о пробной тренировке', kind: 'message', dueAt: null } }, confidence: 0.9, engine: 'test-llm' });
  }
  return ok({ error: 'unexpected ' + url }, 404);
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
let app2: Awaited<ReturnType<typeof setupTestApp>>['app'];
const ck: Record<string, Record<string, string>> = {};
let c1: string; let tenantId: string;
before(async () => {
  t = await setupTestApp();
  const { buildApp } = await import('../src/app.ts');
  app2 = await buildApp(t.pool, { fetch: fakeFetch });
  for (const l of ['o.smirnov', 'm.volkova', 'a.kim']) ck[l] = (await login(app2, l)).cookie!;
  c1 = (await req('GET', '/api/clubs', 'o.smirnov')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenantId = (await sql('select tenant_id from clubs where id = $1', [c1]))[0].tenant_id;
  await req('PUT', `/api/msg/settings/${c1}`, 'o.smirnov', { workFrom: 0, workTo: 24, autoreplyEnabled: false, autoreplyText: 'Ответим утром', maxAutoPerWeek: 2 });
});
after(async () => { liveSenders.clear(); await app2.close(); await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, who: string, payload?: unknown) => app2.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const freshPerson = async () => (await sql(`select p.id, pc.normalized_value as phone from persons p join person_contacts pc on pc.person_id = p.id and pc.type = 'phone'
  where p.home_club_id = $1 and not exists (select 1 from msg_conversations c where c.person_id = p.id) order by p.created_at limit 1`, [c1]))[0];

test('Telegram-аккаунт клуба: вход только по коду, тренеру недоступен, ошибки понятные', async () => {
  assert.equal((await req('POST', '/api/msg/tg-login/start', 'a.kim', { clubId: c1, phone: '+79000000000' })).statusCode, 403);
  assert.equal((await req('POST', '/api/msg/tg-login/start', 'm.volkova', { clubId: c1, phone: '+79000000000' })).statusCode, 403);
  const r = await req('POST', '/api/msg/tg-login/start', 'o.smirnov', { clubId: c1, phone: '+79000000000' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message ?? r.json().error, /my\.telegram\.org/);
  assert.equal((await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: c1, kind: 'tg_user', messenger: 'telegram', secret: 'x' })).statusCode, 400);
  assert.equal((await req('POST', '/api/msg/tg-login/code', 'o.smirnov', { loginId: 'нет', code: '12345' })).statusCode, 400);
  assert.match(tgErrorText({ errorMessage: 'PEER_FLOOD' }), /ограничил/);
  assert.match(tgErrorText({ errorMessage: 'FLOOD_WAIT_120', seconds: 120 }), /2 мин/);
});

test('Telegram-аккаунт клуба: первое сообщение по номеру, ответ клиента в тот же диалог', async () => {
  const [ch] = await sql(`insert into msg_channels(tenant_id, club_id, kind, messenger, name, settings, webhook_token) values ($1,$2,'tg_user','telegram','Telegram Клуб Центр','{"apiId":"1"}','tok') returning id`, [tenantId, c1]);
  const p = await freshPerson();
  const digits = p.phone.replace(/\D/g, '');
  const w = (await req('POST', `/api/persons/${p.id}/write`, 'm.volkova', { messenger: 'telegram' })).json();
  assert.equal(w.mode, 'crm');
  const conv = (await sql('select channel_id, external_chat_id from msg_conversations where id = $1', [w.conversationId]))[0];
  assert.equal(conv.channel_id, ch.id, 'свой модуль главнее тестового канала');
  assert.equal(conv.external_chat_id, `tel:${digits}`);
  // Соединения в этом процессе нет — сообщение ждёт фоновый процесс, без ошибки
  const m = (await req('POST', `/api/msg/conversations/${w.conversationId}/messages`, 'm.volkova', { text: 'Здравствуйте! Это клуб «Центр»' })).json();
  assert.equal(m.status, 'queued');
  assert.equal((await sql('select error, attempts from msg_messages where id = $1', [m.id]))[0].attempts, 0);
  // Фоновый процесс с живым соединением отправляет и узнаёт идентификатор клиента в Telegram
  const calls: { chatId: string; text: string; phone?: string | null }[] = [];
  liveSenders.set(ch.id, async (chatId, text, o) => { calls.push({ chatId, text, phone: o.phone }); return { externalId: '501', chatId: '424242' }; });
  await processMessaging(t.pool, fakeFetch, { triggers: false });
  assert.deepEqual(calls[0], { chatId: `tel:${digits}`, text: 'Здравствуйте! Это клуб «Центр»', phone: p.phone });
  assert.equal((await sql('select status from msg_messages where id = $1', [m.id]))[0].status, 'sent');
  assert.equal((await sql('select external_chat_id from msg_conversations where id = $1', [w.conversationId]))[0].external_chat_id, '424242');
  // Клиент отвечает с аккаунта, в котором номер скрыт: попадает в тот же диалог по идентификатору
  await tgInbound(t.pool, fakeFetch, tenantId, ch.id, { senderId: '424242', bot: false, self: false, firstName: 'Клиент', messageId: 77, text: 'Добрый день, а сколько стоит?', date: Math.floor(Date.now() / 1000) });
  const msgs = await sql(`select direction, body from msg_messages where conversation_id = $1 order by created_at`, [w.conversationId]);
  assert.deepEqual(msgs.map((x) => x.direction).sort(), ['in', 'out']);
  // Боты и свои сообщения не берём
  await tgInbound(t.pool, fakeFetch, tenantId, ch.id, { senderId: '999', bot: true, self: false, messageId: 78, text: 'spam', date: Math.floor(Date.now() / 1000) });
  assert.equal((await sql(`select count(*)::int as n from msg_conversations where channel_id = $1`, [ch.id]))[0].n, 1);
  liveSenders.delete(ch.id);
});

test('WhatsApp для бизнеса напрямую: подключение, проверка адреса, шаблон для первого сообщения, входящие', async () => {
  const ch = (await req('POST', '/api/msg/channels', 'o.smirnov', { clubId: c1, kind: 'wa_cloud', messenger: 'whatsapp', secret: 'EAAG-token',
    settings: { phoneNumberId: '1234567890', openTemplate: 'club_message', templateLang: 'ru' } })).json();
  assert.ok(ch.id);
  assert.match((await req('POST', `/api/msg/channels/${ch.id}/test`, 'o.smirnov')).json().info, /Фитнес Центр/);
  const list = (await req('GET', `/api/msg/channels?clubId=${c1}`, 'o.smirnov')).json();
  const hook = list.find((c: { id: string }) => c.id === ch.id).webhookUrl as string;
  const path = new URL(hook).pathname; const token = path.split('/').pop()!;
  // Проверка адреса от WhatsApp: ответить challenge только с верным маркером
  assert.equal((await app2.inject({ method: 'GET', url: `${path}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=4242` })).body, '4242');
  assert.equal((await app2.inject({ method: 'GET', url: `${path}?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=4242` })).statusCode, 404);
  // Номер клиента, который не писал больше суток: текст уходит в шаблоне клуба
  const p = await freshPerson();
  await sql(`update person_contacts set normalized_value = '+79161230000', value = '+7 916 123-00-00' where person_id = $1 and type = 'phone'`, [p.id]);
  const w = (await req('POST', `/api/persons/${p.id}/write`, 'm.volkova', { messenger: 'whatsapp' })).json();
  const m = (await req('POST', `/api/msg/conversations/${w.conversationId}/messages`, 'm.volkova', { text: 'Здравствуйте!\nПриглашаем на пробную' })).json();
  assert.equal(m.status, 'sent');
  const last = sent.at(-1)!.body as { type: string; template: { name: string; components: { parameters: { text: string }[] }[] } };
  assert.equal(last.type, 'template');
  assert.equal(last.template.name, 'club_message');
  assert.equal(last.template.components[0].parameters[0].text, 'Здравствуйте! Приглашаем на пробную');
  // Входящее от клиента
  await app2.inject({ method: 'POST', url: path, payload: { entry: [{ changes: [{ value: { metadata: { phone_number_id: '1234567890' },
    contacts: [{ wa_id: '79161230000', profile: { name: 'Ирина' } }], messages: [{ from: '79161230000', id: 'wamid.in1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Спасибо, приду' } }] } }] }] } });
  const ins = await sql(`select body from msg_messages where conversation_id = $1 and direction = 'in'`, [w.conversationId]);
  assert.deepEqual(ins.map((x) => x.body), ['Спасибо, приду']);
  await req('PATCH', `/api/msg/channels/${ch.id}`, 'o.smirnov', { status: 'disabled' });
});

test('разбор переписки ИИ: итог как у звонков, задача на следующий шаг, «Коротко о ситуации»', async () => {
  const [conv] = await sql(`select c.id, c.person_id from msg_conversations c join msg_channels ch on ch.id = c.channel_id where ch.kind = 'tg_user' limit 1`);
  // Пока в чате не затихло — не разбираем
  await processChats(t.pool, { url: 'http://ai', fetch: fakeFetch });
  assert.equal((await sql('select count(*)::int as n from msg_chat_summaries where conversation_id = $1', [conv.id]))[0].n, 0);
  await sql(`update msg_conversations set last_message_at = now() - interval '40 minutes' where id = $1`, [conv.id]);
  await processChats(t.pool, { url: 'http://ai', fetch: fakeFetch });
  const [s] = await sql('select status, messages, summary, engine from msg_chat_summaries where conversation_id = $1', [conv.id]);
  assert.equal(s.status, 'done');
  assert.equal(s.messages, 2);
  assert.equal(s.summary.outcome, 'interested');
  const tasks = await sql(`select title, kind from tasks where person_id = $1 and title like 'Напомнить о пробной%'`, [conv.person_id]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, 'message');
  // Повторно тот же эпизод не разбирается
  await processChats(t.pool, { url: 'http://ai', fetch: fakeFetch });
  assert.equal((await sql('select count(*)::int as n from msg_chat_summaries where conversation_id = $1', [conv.id]))[0].n, 1);
  // Итог виден в переписке и попадает в «Коротко о ситуации»
  const r = (await req('GET', `/api/msg/conversations/${conv.id}/messages`, 'm.volkova')).json();
  assert.match(r.summaries[0].essence, /пробную тренировку/);
  const list = await withCtx(t.pool, { tenantId, allClubs: true, clubIds: [] }, (db) => chatSummariesOf(db, { personId: conv.person_id }));
  assert.equal(list[0].messenger, 'Telegram');
  const brief = (await req('GET', `/api/agent/brief/person/${conv.person_id}?force=1`, 'm.volkova')).json();
  assert.match(brief.text, /Итог переписки/);
  assert.equal(brief.sources.chats, 1);
});

test('тренер пишет в WhatsApp и Telegram только своим клиентам', async () => {
  const kim = (await sql(`select id from users where login = 'a.kim'`))[0].id;
  const type = (await sql(`select id from class_types where club_id = $1 limit 1`, [c1]))[0]?.id
    ?? (await sql(`insert into class_types(tenant_id, club_id, name, kind, description) values ($1, $2, 'Пилатес', 'group', 'Растяжка') returning id`, [tenantId, c1]))[0].id;
  const s = (await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity) values ($1,$2,$3,$4, now() + interval '1 day', now() + interval '1 day 1 hour', 10) returning id`,
    [tenantId, c1, type, kim]))[0].id;
  const mine = await freshPerson();
  await sql(`insert into class_bookings(tenant_id, club_id, session_id, person_id, status) values ($1,$2,$3,$4,'booked')`, [tenantId, c1, s, mine.id]);
  const other = (await sql(`select p.id from persons p join person_contacts pc on pc.person_id = p.id and pc.type = 'phone'
    where p.home_club_id = $1 and p.id <> $2 and not exists (select 1 from class_bookings b where b.person_id = p.id) limit 1`, [c1, mine.id]))[0];
  // Чужому клиенту — нельзя
  assert.equal((await req('POST', `/api/persons/${other.id}/write`, 'a.kim', { messenger: 'whatsapp' })).statusCode, 403);
  // Своему — переписка в CRM, даже если диалог ведёт менеджер
  const w = (await req('POST', `/api/persons/${mine.id}/write`, 'a.kim', { messenger: 'telegram' })).json();
  assert.equal(w.mode, 'crm');
  const r = await req('GET', `/api/msg/conversations/${w.conversationId}/messages`, 'a.kim');
  assert.equal(r.statusCode, 200);
  assert.equal((await req('POST', `/api/msg/conversations/${w.conversationId}/messages`, 'a.kim', { text: 'Жду вас завтра на тренировке!' })).statusCode, 201);
  // Список всей переписки тренеру по-прежнему закрыт, и чужой диалог не открыть
  assert.equal((await req('GET', '/api/msg/conversations', 'a.kim')).statusCode, 403);
  const foreign = (await sql(`select id from msg_conversations where person_id <> $1 and person_id is not null limit 1`, [mine.id]))[0];
  assert.equal((await req('GET', `/api/msg/conversations/${foreign.id}/messages`, 'a.kim')).statusCode, 404);
});
