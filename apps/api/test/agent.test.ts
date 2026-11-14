// ИИ-агент: «Коротко о ситуации» по задаче и сделке — сбор фактов из всех источников, текст по правилам и через YandexGPT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { collectFacts, llmBrief, fitBrief, BRIEF_MAX } from '../src/modules/agent.ts';
import { parseRecognition } from '../src/lib/yandex.ts';
import { aiSummarize } from '../src/lib/aiClient.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';
let lead: { leadId: string; personId: string; opportunityId: string };
let taskId = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'm.volkova', 'i.zuev', 'o.astafeva']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  const r = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Анна Сводкина', phone: '+79007770011', sourceCode: 'walk_in', comment: 'хочу утренние тренировки' });
  assert.equal(r.statusCode, 201, r.body);
  lead = r.json();
  taskId = (await sql(`select id from tasks where opportunity_id = $1`, [lead.opportunityId]))[0].id;
  const manager = (await sql(`select id from users where login = 'm.volkova'`))[0].id;
  // Разговор с итогом
  const call = (await sql(`insert into calls(tenant_id, club_id, person_id, opportunity_id, user_id, direction, started_at, source, transcript, asr_status)
    values ($1,$2,$3,$4,$5,'out', now() - interval '2 days','demo', '{"text":"Здравствуйте, это клуб. Дорого, я подумаю до пятницы"}','done') returning id`,
    [tenant, centr, lead.personId, lead.opportunityId, manager]))[0].id;
  await sql(`insert into call_summaries(tenant_id, club_id, call_id, status, final) values ($1,$2,$3,'confirmed',$4)`, [tenant, centr, call, JSON.stringify({
    essence: 'Клиентка интересуется утренними тренировками, сомневается из-за цены', need: 'утро, 3 раза в неделю', objections: ['дорого'],
    agreements: 'перезвонить в пятницу', outcome: 'thinking', nextStep: { title: 'Перезвонить в пятницу с рассрочкой', kind: 'call', dueAt: null } })]);
  // Клиент написал в мессенджер и ждёт ответа
  const ch = (await sql(`insert into msg_channels(tenant_id, club_id, kind, messenger, name, webhook_token) values ($1,$2,'test','telegram','Бот клуба','wh-svod') returning id`, [tenant, centr]))[0].id;
  {
    const conv = (await sql(`insert into msg_conversations(tenant_id, club_id, channel_id, person_id, external_chat_id, title) values ($1,$2,$3,$4,'chat-svod','Анна') returning id`,
      [tenant, centr, ch, lead.personId]))[0].id;
    await sql(`insert into msg_messages(tenant_id, club_id, conversation_id, direction, body, status, created_at) values ($1,$2,$3,'in','А рассрочка есть?','received', now() - interval '3 hours')`, [tenant, centr, conv]);
  }
  // Обсуждение в общем чате клуба и в личной переписке
  const club = (await sql(`insert into team_chats(tenant_id, kind, club_id, title) values ($1,'club',$2,'Центр') on conflict do nothing returning id`, [tenant, centr]))[0]?.id
    ?? (await sql(`select id from team_chats where club_id = $1 and kind = 'club'`, [centr]))[0].id;
  await sql(`insert into team_messages(tenant_id, chat_id, user_id, body) values ($1,$2,$3,'Анна Сводкина просит скидку, РОП, согласуешь 10%?')`, [tenant, club, manager]);
  const rop = (await sql(`select id from users where login = 'o.astafeva'`))[0].id;
  const dm = (await sql(`insert into team_chats(tenant_id, kind, direct_key) values ($1,'direct',$2) returning id`, [tenant, [manager, rop].sort().join(':')]))[0].id;
  await sql(`insert into team_messages(tenant_id, chat_id, user_id, body) values ($1,$2,$3,'по 9007770011 — личное: она подруга директора')`, [tenant, dm, rop]);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('«Коротко о ситуации» по задаче: факты из задач, звонков, переписки и мессенджера, главное жирным', async () => {
  const r = await req('GET', `/api/agent/brief/task/${taskId}`, 'm.volkova');
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.engine, 'rules');
  assert.ok(b.text.length <= BRIEF_MAX);
  assert.match(b.text, /\*\*Главное\*\*/);
  assert.match(b.text, /\*\*Анна Сводкина\*\*/);
  assert.match(b.text, /Что сделать сейчас/);
  assert.match(b.text, /Перезвонить в пятницу с рассрочкой/);
  assert.match(b.text, /«дорого»/);
  assert.match(b.text, /просит скидку/);
  assert.match(b.text, /Ответьте клиенту/);
  assert.match(b.text, /рассрочка есть/);
  // Личная переписка сотрудников в сводку по правилам дословно не попадает
  assert.doesNotMatch(b.text, /подруга директора/);
  assert.equal(b.sources.team, 2);
  // Повторное открытие — из кэша
  const again = (await req('GET', `/api/agent/brief/task/${taskId}`, 'm.volkova')).json();
  assert.equal(again.cached, true);
  assert.equal((await req('GET', `/api/agent/brief/task/${taskId}?force=1`, 'm.volkova')).json().cached, false);
});

test('сводка по сделке; чужой клуб и неизвестный тип — отказ', async () => {
  const r = await req('GET', `/api/agent/brief/opportunity/${lead.opportunityId}`, 'o.astafeva');
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().text, /этап \*\*«/);
  assert.equal((await req('GET', `/api/agent/brief/opportunity/${lead.opportunityId}`, 'i.zuev')).statusCode, 404);
  assert.equal((await req('GET', `/api/agent/brief/task/${taskId}`, 'i.zuev')).statusCode, 404);
  assert.equal((await req('GET', `/api/agent/brief/person/${lead.personId}`, 'm.volkova')).statusCode, 400);
});

test('YandexGPT: получает факты без телефонов, ответ обрезается до 6000 знаков', async () => {
  let sent = '';
  const fake = (async (_url: string, init: RequestInit) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ result: { alternatives: [{ message: { role: 'assistant', text: `**Главное**\n${'x'.repeat(7000)}` } }] } }), { status: 200 });
  }) as typeof fetch;
  const ctx = { userId: '', tenantId: tenant, sessionId: '', roles: [], allClubs: true, clubIds: [], permissions: new Set(['*']) };
  const { facts } = await withCtx(t.pool, ctx, (db) => collectFacts(db, ctx, 'task', taskId));
  const text = await llmBrief({ apiKey: 'k', folderId: 'f', fetch: fake }, facts);
  assert.ok(text.length <= BRIEF_MAX);
  const body = JSON.parse(sent);
  assert.equal(body.modelUri, 'gpt://f/yandexgpt/latest');
  assert.doesNotMatch(body.messages[1].text, /9007770011/);
  assert.match(body.messages[1].text, /Анна Сводкина/);
});

test('fitBrief режет по строкам', () => {
  const s = fitBrief(Array.from({ length: 400 }, (_, i) => `строка ${i} ${'а'.repeat(20)}`).join('\n'));
  assert.ok(s.length <= BRIEF_MAX && s.endsWith('…'));
});

test('SpeechKit: разбор ответа getRecognition и итог разговора через YandexGPT', async () => {
  const raw = [
    { result: { channelTag: '0', final: { alternatives: [{ text: 'алло здравствуйте', startTimeMs: '0', endTimeMs: '1500' }] } } },
    { result: { channelTag: '0', finalRefinement: { normalizedText: { alternatives: [{ text: 'Алло, здравствуйте!', startTimeMs: '0', endTimeMs: '1500' }] } } } },
    { result: { channelTag: '1', final: { alternatives: [{ text: 'Добрый день', startTimeMs: '1600', endTimeMs: '2500' }] } } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const tr = parseRecognition(raw);
  assert.equal(tr.segments.length, 2);
  assert.equal(tr.segments[0].text, 'Алло, здравствуйте!');
  assert.equal(tr.durationSec, 3);
  const fake = (async () => new Response(JSON.stringify({ result: { alternatives: [{ message: { text: '```json\n{"essence":"Клиент спросил про цены","need":"","objections":["дорого"],"agreements":"","outcome":"thinking","nextStep":null}\n```' } }] } }))) as unknown as typeof fetch;
  const r = await aiSummarize({ url: '', fetch: fake, yandex: { apiKey: 'k', folderId: 'f', fetch: fake } }, tr, {});
  assert.equal(r.summary?.essence, 'Клиент спросил про цены');
  assert.deepEqual(r.summary?.objections, ['дорого']);
  assert.match(r.engine, /yandexgpt/);
});
