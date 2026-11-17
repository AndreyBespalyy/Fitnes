// Советы ИИ-помощника по переписке в мессенджере (17.11.2026): тема, советы по ролям, кнопка «Начать», доступ только участникам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { ADVICE, adviceFor, analyzeChat, processTeamAdvice, rulesTopic } from '../src/modules/teamAdvice.ts';
import type { AiConfig } from '../src/lib/aiClient.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const uid: Record<string, string> = {};
let tenant = '';
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const sys = () => ({ tenantId: tenant, allClubs: true, clubIds: [] });
const LOGINS = ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'd.lis', 'a.kim', 'e.orlova'];

async function direct(a: string, b: string) { return (await req('POST', '/api/team/direct', a, { userId: uid[b] })).json().id as string; }
async function say(chat: string, who: string, body: string) { assert.equal((await req('POST', `/api/team/chats/${chat}/messages`, who, { body })).statusCode, 200); }

before(async () => {
  t = await setupTestApp({ ai: null, yandex: null });
  for (const l of LOGINS) ck[l] = (await login(t.app, l)).cookie!;
  for (const r of await sql(`select id, login, tenant_id from users where login = any($1)`, [LOGINS])) { uid[r.login] = r.id; tenant = r.tenant_id; }
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('тема по ключевым словам', () => {
  assert.equal(rulesTopic([{ text: 'Привет! Как дела?' }]).topic, 'other');
  assert.equal(rulesTopic([{ text: 'Клиентка жалуется, что в душе холодная вода, очень недовольна' }]).topic, 'complaint');
  assert.equal(rulesTopic([{ text: 'Беговая дорожка №3 сломалась, не включается' }]).topic, 'equipment');
  assert.equal(rulesTopic([{ text: 'У Петрова заканчивается абонемент через неделю, надо продлить' }]).topic, 'renewal');
  assert.equal(rulesTopic([{ text: 'Завтра планерка в 9:00, собрание всех менеджеров' }]).topic, 'meeting');
  assert.equal(rulesTopic([{ text: 'Ким заболел, нужна замена на групповое в 19:00' }]).topic, 'schedule');
  // Свежая тема важнее старой, телефоны в суть не попадают
  const r = rulesTopic([{ text: 'надо сделать отчёт' }, { text: 'Пришла заявка, клиент хочет на пробную тренировку, телефон +7 900 123-45-67' }]);
  assert.equal(r.topic, 'new_client');
  assert.ok(!r.summary.includes('123-45'), r.summary);
});

test('советы по ролям: собственнику — поручить управляющему, тренеру — без процессов продаж', () => {
  assert.equal(adviceFor('complaint', 'owner', 'душ', '', [])[0].action.type, 'task');
  assert.equal((adviceFor('complaint', 'owner', 'душ', '', [])[0].action as { assignee: string }).assignee, 'gm');
  assert.equal(adviceFor('complaint', 'desk', '', '', [])[0].action.type, 'process');
  assert.equal(adviceFor('new_client', 'manager', '', '', [])[0].action.type, 'process');
  assert.equal(adviceFor('new_client', 'trainer', '', '', [])[0].action.type, 'task');
  assert.equal(adviceFor('payment', 'owner', '', '', []).length, 0);
  const m = adviceFor('meeting', 'rop', '', 'Отдел продаж', ['Мария Волкова', 'Олег Смирнов'])[0].action;
  assert.equal(m.type, 'assistant');
  assert.match((m as { prompt: string }).prompt, /^Назначь собрание: Мария Волкова, Олег Смирнов/);
});

test('жалоба в личном чате: советы обоим участникам, посторонний не видит, «Начать» запускает процесс', async () => {
  const chat = await direct('d.lis', 'o.smirnov');
  await say(chat, 'd.lis', 'Олег, клиентка Анна жалуется, что в женской раздевалке холодный душ, очень недовольна, телефон +79001234567');
  await say(chat, 'o.smirnov', 'Понял, разберусь');
  const r = await req('POST', `/api/team/chats/${chat}/advice/refresh`, 'd.lis');
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.topic, 'complaint');
  assert.equal(v.topicName, 'Жалоба клиента');
  assert.ok(!String(v.summary).includes('1234567'));
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].actionType, 'process');

  // Управляющему — свой совет; постороннему сотруднику — «чат не найден»
  const gm = (await req('GET', `/api/team/chats/${chat}/advice`, 'o.smirnov')).json();
  assert.equal(gm.items.length, 1);
  assert.notEqual(gm.items[0].id, v.items[0].id);
  assert.equal((await req('GET', `/api/team/chats/${chat}/advice`, 'm.volkova')).statusCode, 404);
  assert.equal((await req('POST', `/api/team/advice/${v.items[0].id}/start`, 'm.volkova')).statusCode, 404);

  // Метка в списке чатов
  const list = (await req('GET', '/api/team/chats', 'd.lis')).json() as { id: string; advice: number }[];
  assert.equal(list.find((c) => c.id === chat)?.advice, 1);

  const s = await req('POST', `/api/team/advice/${v.items[0].id}/start`, 'd.lis');
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().kind, 'process');
  const p = (await sql(`select title, note from processes where id = $1`, [s.json().id]))[0];
  assert.match(p.title, /Жалоба клиента/);
  assert.match(p.note, /из переписки/);
  // Повторное нажатие не запускает второй процесс
  assert.equal((await req('POST', `/api/team/advice/${v.items[0].id}/start`, 'd.lis')).json().id, s.json().id);
  assert.equal((await req('GET', `/api/team/chats/${chat}/advice`, 'd.lis')).json().items[0].status, 'started');

  // Скрыть свой совет можно, чужой — нет
  assert.equal((await req('POST', `/api/team/advice/${gm.items[0].id}/dismiss`, 'd.lis')).statusCode, 404);
  assert.equal((await req('POST', `/api/team/advice/${gm.items[0].id}/dismiss`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('GET', `/api/team/chats/${chat}/advice`, 'o.smirnov')).json().items.length, 0);

  // Обучение на отзывах: «Начать» — сделано, «Скрыть» — «Не то»
  const sg = await sql(`select s.user_id, s.kind, s.source, s.outcome, s.rating, s.reason from team_advice a join agent_suggestions s on s.id = a.suggestion_id where a.chat_id = $1 order by s.user_id`, [chat]);
  assert.equal(sg.length, 2);
  const lis = sg.find((x) => x.user_id === uid['d.lis']); const gmS = sg.find((x) => x.user_id === uid['o.smirnov']);
  assert.deepEqual([lis.kind, lis.source, lis.outcome], ['msg_complaint', 'advice', 'done']);
  assert.deepEqual([gmS.rating, gmS.reason], [-1, 'not_relevant']);
});

test('поломка в группе через свой ИИ-сервер: менеджер ставит задачу управляющему, телефоны в ИИ не уходят', async () => {
  let sent = '';
  const fakeFetch = (async (url: string, init: RequestInit) => {
    assert.match(String(url), /\/v1\/chat-topic$/);
    sent = String(init.body);
    return new Response(JSON.stringify({ topic: 'equipment', summary: 'Сломалась беговая дорожка №3 в зале', client: '', confidence: 0.9 }), { status: 200 });
  }) as typeof fetch;
  const ai: AiConfig = { url: 'http://ai.test', fetch: fakeFetch };
  const g = (await req('POST', '/api/team/groups', 'm.volkova', { title: 'Зал', memberIds: [uid['a.kim'], uid['o.smirnov']] })).json().id;
  await say(g, 'm.volkova', 'В зале у третьей дорожки что-то стучит, мне клиент написал с номера 8 900 111 22 33');
  await say(g, 'a.kim', 'Да, она не включается с утра');
  const r = await withCtx(t.pool, sys(), (db) => analyzeChat(db, tenant, g, { ai, yandex: null }));
  assert.equal(r?.engine, 'ai');
  assert.equal(r?.topic, 'equipment');
  assert.ok(sent.includes('дорожки') && !sent.includes('111 22 33'), sent);

  const mv = (await req('GET', `/api/team/chats/${g}/advice`, 'm.volkova')).json();
  assert.equal(mv.summary, 'Сломалась беговая дорожка №3 в зале');
  assert.equal(mv.items[0].actionLabel, 'Задача управляющему');
  const s = (await req('POST', `/api/team/advice/${mv.items[0].id}/start`, 'm.volkova')).json();
  const task = (await sql(`select assignee_id, title from tasks where id = $1`, [s.id]))[0];
  assert.equal(task.assignee_id, uid['o.smirnov']);
  assert.match(task.title, /Организовать ремонт: Сломалась беговая дорожка/);
  // Управляющему — задача себе
  const gm = (await req('GET', `/api/team/chats/${g}/advice`, 'o.smirnov')).json();
  assert.equal(gm.items[0].actionLabel, 'Задача себе');

  // Без новых сообщений повторно не разбирается; та же тема — советы не дублируются
  assert.equal(await withCtx(t.pool, sys(), (db) => analyzeChat(db, tenant, g, { ai, yandex: null })), null);
  await say(g, 'o.smirnov', 'Вызвал мастера на завтра, дорожку отключили');
  await withCtx(t.pool, sys(), (db) => analyzeChat(db, tenant, g, { ai, yandex: null }));
  assert.equal((await sql(`select count(*)::int as n from team_advice where chat_id = $1 and user_id = $2`, [g, uid['o.smirnov']]))[0].n, 1);

  // ИИ-сервер недоступен — тема по ключевым словам
  const down: AiConfig = { url: 'http://ai.test', fetch: (async () => new Response('нет', { status: 503 })) as typeof fetch };
  await say(g, 'a.kim', 'Ещё и кондиционер сломался');
  const r2 = await withCtx(t.pool, sys(), (db) => analyzeChat(db, tenant, g, { ai: down, yandex: null }));
  assert.equal(r2?.engine, 'rules');
  assert.equal(r2?.topic, 'equipment');
});

test('фоновый разбор: только затихшие чаты, чат с ИИ-помощником не читается, смена темы убирает старые советы', async () => {
  const chat = await direct('o.astafeva', 'm.volkova');
  await say(chat, 'o.astafeva', 'Мария, у Алексея Громова заканчивается абонемент, займись продлением');
  const bot = (await req('POST', '/api/agent/chat', 'm.volkova')).json().id;
  await say(bot, 'm.volkova', 'клиент жалуется на тренера');
  await new Promise((r) => setTimeout(r, 400)); // помощник отвечает
  // Сразу после сообщения — рано (ждём 2 минуты тишины)
  await processTeamAdvice(t.pool, { ai: null, yandex: null });
  assert.equal((await sql(`select count(*)::int as n from team_chat_insights where chat_id = $1`, [chat]))[0].n, 0);
  const quiet = ADVICE.quietMs; ADVICE.quietMs = 0;
  try {
    await processTeamAdvice(t.pool, { ai: null, yandex: null });
    assert.equal((await sql(`select topic from team_chat_insights where chat_id = $1`, [chat]))[0]?.topic, 'renewal');
    assert.equal((await sql(`select count(*)::int as n from team_chat_insights where chat_id = $1`, [bot]))[0].n, 0);
    const v = (await req('GET', `/api/team/chats/${chat}/advice`, 'm.volkova')).json();
    assert.equal(v.items[0].actionType, 'process');
    // Клиент найден в базе — процесс запустится по нему
    assert.ok((await sql(`select person_id from team_chat_insights where chat_id = $1`, [chat]))[0].person_id);

    await say(chat, 'm.volkova', 'Кстати, в раздевалке грязно, мусор не вынесли, нужна уборка');
    await processTeamAdvice(t.pool, { ai: null, yandex: null });
    const v2 = (await req('GET', `/api/team/chats/${chat}/advice`, 'm.volkova')).json();
    assert.equal(v2.topic, 'cleaning');
    assert.deepEqual(v2.items.map((i: { actionLabel: string }) => i.actionLabel), ['Задача администратору']);
  } finally { ADVICE.quietMs = quiet; }
});
