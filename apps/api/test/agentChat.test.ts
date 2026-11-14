// ИИ-агент, этап 3: переписка с «ИИ-помощником» в мессенджере сотрудников.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { parseWhen, ruleIntent } from '../src/modules/agentChat.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let chat = '';

/** Отправить помощнику и дождаться ответа */
async function ask(text: string, who = 'm.volkova') {
  const before = (await sql(`select count(*)::int as n from team_messages where chat_id = $1`, [chat]))[0].n;
  const r = await req('POST', `/api/team/chats/${chat}/messages`, who, { body: text });
  assert.equal(r.statusCode, 200, r.body);
  for (let i = 0; i < 100; i++) {
    const rows = await sql(`select m.body, u.is_bot from team_messages m join users u on u.id = m.user_id where m.chat_id = $1 order by m.created_at`, [chat]);
    if (rows.length >= before + 2 && rows.at(-1).is_bot) return rows.at(-1).body as string;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Помощник не ответил');
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.astafeva', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  await sql(`update tasks set done_at = now(), result = 'тест'`);
  const r = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Анна Чатова', phone: '+79007771234', sourceCode: 'walk_in' });
  assert.equal(r.statusCode, 201, r.body);
  await sql(`update tasks set due_at = now() - interval '1 hour' where opportunity_id = $1`, [r.json().opportunityId]);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('чат с помощником: создаётся один раз, помощник здоровается, в списках сотрудников его нет', async () => {
  const a = await req('POST', '/api/agent/chat', 'm.volkova');
  assert.equal(a.statusCode, 200, a.body);
  chat = a.json().id;
  assert.equal((await req('POST', '/api/agent/chat', 'm.volkova')).json().id, chat);
  const msgs = (await req('GET', `/api/team/chats/${chat}/messages`, 'm.volkova')).json().messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].author, 'ИИ-помощник');
  assert.match(msgs[0].body, /мои задачи/);
  const chats = (await req('GET', '/api/team/chats', 'm.volkova')).json();
  assert.ok(chats.some((c: { id: string; title: string }) => c.id === chat && c.title === 'ИИ-помощник'));
  const staff = (await req('GET', '/api/staff', 'a.bespalyy')).json();
  assert.ok(!JSON.stringify(staff).includes('ИИ-помощник'));
  // Под помощником войти нельзя
  const bot = (await sql(`select login from users where is_bot`))[0].login;
  assert.equal((await login(t.app, bot, 'anything')).res.statusCode >= 400, true);
});

test('мои задачи → перенеси по номеру и по имени → коротко → поставь задачу', async () => {
  const list = await ask('Мои задачи');
  assert.match(list, /1\. ⚠️ .*Анна Чатова/);
  const s1 = await ask('перенеси 1 через 2 часа');
  assert.match(s1, /Готово: .*Анна Чатова.* перенесена/);
  const due = (await sql(`select t.due_at from tasks t join persons p on p.id = t.person_id where p.full_name = 'Анна Чатова' and t.done_at is null`))[0].due_at;
  assert.ok(Math.abs(new Date(due).getTime() - (Date.now() + 2 * 3_600_000)) < 120_000);
  const s2 = await ask('перенеси Анну на завтра в 15:30');
  assert.match(s2, /перенесена на \d\d\.\d\d, 15:30/);
  const b = await ask('коротко про Анну');
  assert.match(b, /\*\*Главное\*\*/);
  const c = await ask('поставь задачу позвонить поставщику воды завтра в 12');
  assert.match(c, /Поставил задачу «позвонить поставщику воды» на \d\d\.\d\d, 12:00/);
  assert.equal((await sql(`select count(*)::int as n from tasks where title = 'позвонить поставщику воды' and done_at is null`))[0].n, 1);
  assert.match(await ask('сводка'), /для руководителей/);
  assert.match(await ask('как дела?'), /Пока я понимаю/);
  assert.match(await ask('перенеси Петрова на завтра'), /Не нашёл/);
});

test('разбор слов: намерения и время', () => {
  assert.equal(ruleIntent('что просрочено?').kind, 'overdue');
  assert.deepEqual(ruleIntent('Перенеси Анну на завтра'), { kind: 'snooze', ref: 'анну', when: 'на завтра' });
  assert.equal(ruleIntent('что с Петровым').kind, 'brief');
  assert.equal(ruleIntent('сводка по клубу').kind, 'digest');
  const now = new Date('2026-11-14T09:00:00Z'); // 12:00 по Москве
  assert.equal(parseWhen('завтра', 'Europe/Moscow', now)?.toISOString(), '2026-11-15T07:00:00.000Z');
  assert.equal(parseWhen('в 15:00', 'Europe/Moscow', now)?.toISOString(), '2026-11-14T12:00:00.000Z');
  assert.equal(parseWhen('в 9', 'Europe/Moscow', now)?.toISOString(), '2026-11-15T06:00:00.000Z');
  assert.equal(parseWhen('через 30 минут', 'Europe/Moscow', now)?.toISOString(), '2026-11-14T09:30:00.000Z');
  assert.equal(parseWhen('послезавтра в 18', 'Europe/Moscow', now)?.toISOString(), '2026-11-16T15:00:00.000Z');
  assert.equal(parseWhen('когда-нибудь', 'Europe/Moscow', now), null);
});

test('руководителю — сводка по клубу', async () => {
  const a = await req('POST', '/api/agent/chat', 'o.astafeva');
  chat = a.json().id;
  const d = await ask('что горит', 'o.astafeva');
  assert.match(d, /Что горит сейчас/);
  assert.match(d, /Просроченные задачи|Просроченных задач нет/);
});
