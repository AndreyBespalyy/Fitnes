// ИИ-помощник учится на отзывах: оценки «Полезно / Не то», проверка результата, веса типов подсказок, личная поправка,
// ручные решения руководителя, образцы удачных ответов для нейросети, страница «Чему научился помощник».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { morningHints, processMorningHints } from '../src/modules/agentMorning.ts';
import { goodExamples, lessonsOf, processOutcomes, recordSuggestion, weightFrom } from '../src/modules/agentLearn.ts';
import { card } from '../src/modules/agentReminders.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';
const uid: Record<string, string> = {};
const sys = () => ({ tenantId: tenant, allClubs: true, clubIds: [] });
const kinds = async (login: string, role: string) => (await withCtx(t.pool, sys(), (db) => morningHints(db, { id: uid[login], name: login, role }, [centr]))).map((h) => h.kind);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  const c = (await sql(`select id, tenant_id from clubs where name like '%Центр%'`))[0]; centr = c.id; tenant = c.tenant_id;
  for (const r of await sql(`select id, login from users where login in ('a.bespalyy','o.smirnov','m.volkova','d.lis','e.orlova','a.kim')`)) uid[r.login] = r.id;
  await sql(`update tasks set done_at = now(), result = 'тест'`);
  await sql(`update leads set first_response_at = now() where first_response_at is null`);
  await sql(`update msg_conversations set last_inbound_at = now() - interval '5 days'`);
  // Менеджеру: заявка без ответа, просроченная задача, горячий клиент
  const l = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Глеб Учёбный', phone: '+79007771011', sourceCode: 'walk_in' });
  assert.ok(l.statusCode < 300, l.body);
  await sql(`update leads set assigned_to = $2, first_response_at = null where person_id = $1`, [l.json().personId, uid['m.volkova']]);
  await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1, $2, $3, 'call', 'Перезвонить Глебу', now() - interval '3 hours')`, [tenant, centr, uid['m.volkova']]);
  const hot = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Злата Учёная', phone: '+79007771012', sourceCode: 'walk_in' })).json().personId;
  await sql(`update leads set first_response_at = now() where person_id = $1`, [hot]);
  await sql(`insert into client_scores(tenant_id, club_id, person_id, kind, score, segment, owner_id, model) values ($1, $2, $3, 'purchase', 0.82, 'hot', $4, 'test')
    on conflict (club_id, person_id, kind) do update set score = 0.82, segment = 'hot', owner_id = $4`, [tenant, centr, hot, uid['m.volkova']]);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('вес типа подсказки: пока данных мало — как было; польза поднимает, «Не то» и игнор опускают, совсем бесполезное выключается', () => {
  const z = { shown: 0, likes: 0, dislikes: 0, doneAlready: 0, done: 0, sales: 0, ignored: 0 };
  assert.equal(weightFrom(z, null).weight, 1);
  assert.equal(weightFrom(z, null).status, 'normal');
  const good = weightFrom({ ...z, shown: 10, likes: 4, done: 3, sales: 1 }, null);
  assert.equal(good.status, 'up'); assert.ok(good.weight > 1.2, String(good.weight));
  const meh = weightFrom({ ...z, shown: 6, dislikes: 2, ignored: 3 }, null);
  assert.equal(meh.status, 'down'); assert.ok(meh.weight < 0.85, String(meh.weight));
  const bad = weightFrom({ ...z, shown: 12, dislikes: 6, ignored: 4 }, null);
  assert.equal(bad.status, 'auto_off'); assert.equal(bad.weight, 0);
  assert.equal(weightFrom({ ...z, shown: 12, dislikes: 6, ignored: 4 }, 'boost').status, 'boost');
  assert.equal(weightFrom({ ...z, likes: 9 }, 'off').weight, 0);
  // «Уже сделал» — подсказка была верной, это почти не минус
  assert.notEqual(weightFrom({ ...z, shown: 8, dislikes: 8, doneAlready: 8 }, null).status, 'auto_off');
  assert.match(lessonsOf([])[0], /Пока данных мало/);
});

test('утренние подсказки записываются, сотрудник оценивает каждую, оценка видна после обновления', async () => {
  const n = await withCtx(t.pool, sys(), (db) => processMorningHints(db, { tenantId: tenant, userId: null }, centr));
  assert.ok(n >= 3, String(n));
  const msg = (await sql(`select id, meta from team_messages where meta->>'kind' = 'morning_hints' and meta->>'userId' = $1`, [uid['m.volkova']]))[0];
  const sids = msg.meta.sids as string[];
  assert.equal(sids.length, 3);
  const rows = await sql(`select id, kind, role, source, message_id, targets from agent_suggestions where id = any($1)`, [sids]);
  assert.ok(rows.every((r) => r.role === 'manager' && r.source === 'morning' && r.message_id === msg.id), JSON.stringify(rows));
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
  assert.deepEqual(Object.keys(byKind).sort(), ['hot_calls', 'leads_reply', 'overdue_tasks']);
  assert.equal(byKind.overdue_tasks.targets.taskIds.length, 1);
  // Оценить чужую подсказку нельзя
  assert.equal((await req('POST', `/api/agent/suggestions/${sids[0]}/rate`, 'd.lis', { rating: 1 })).statusCode, 404);
  assert.equal((await req('POST', `/api/agent/suggestions/${sids[0]}/rate`, 'm.volkova', { rating: 5 })).statusCode, 400);
  const r = await req('POST', `/api/agent/suggestions/${byKind.hot_calls.id}/rate`, 'm.volkova', { rating: -1, reason: 'not_relevant', comment: 'Злата уже купила' });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().message, /реже/);
  const r2 = await req('POST', `/api/agent/suggestions/${byKind.overdue_tasks.id}/rate`, 'm.volkova', { rating: -1, reason: 'done_already' });
  assert.equal(r2.statusCode, 200);
  const meta = (await sql(`select meta from team_messages where id = $1`, [msg.id]))[0].meta;
  assert.equal(meta.rated[byKind.hot_calls.id], -1);
  const s = (await sql(`select rating, reason, comment, outcome from agent_suggestions where id = $1`, [byKind.overdue_tasks.id]))[0];
  assert.equal(s.outcome, 'done'); // «Уже сделал» засчитывается как сделано
});

test('чем кончилось: задачу закрыли — «сделано», была продажа — «продажа», 2 дня тишины — «проигнорировано»', async () => {
  const task = (await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1, $2, $3, 'call', 'Тест результата', now()) returning id`, [tenant, centr, uid['m.volkova']]))[0].id;
  const person = (await sql(`select id from persons where full_name = 'Злата Учёная'`))[0].id;
  const product = (await sql(`select id from products where club_id = $1 limit 1`, [centr]))[0]?.id;
  const ids = await withCtx(t.pool, sys(), async (db) => [
    await recordSuggestion(db, { clubId: centr, userId: uid['m.volkova'], role: 'manager', source: 'morning', kind: 'today_tasks', body: 'x', targets: { taskIds: [task] } }),
    await recordSuggestion(db, { clubId: centr, userId: uid['m.volkova'], role: 'manager', source: 'morning', kind: 'hot_calls', body: 'y', targets: { personIds: [person] } }),
    await recordSuggestion(db, { clubId: centr, userId: uid['m.volkova'], role: 'manager', source: 'morning', kind: 'stuck_deals', body: 'z', targets: { personIds: [person] } }),
  ]);
  await sql(`update agent_suggestions set created_at = now() - interval '1 hour' where id = any($1)`, [ids.slice(0, 2)]);
  await sql(`update agent_suggestions set created_at = now() - interval '3 days' where id = $1`, [ids[2]]);
  await sql(`update tasks set done_at = now() where id = $1`, [task]);
  if (product) {
    await sql(`insert into memberships(tenant_id, club_id, person_id, product_id, kind, product_name, amount_kop, status, starts_on, ends_on)
      values ($1, $2, $3, $4, 'term', 'Тест', 100000, 'active', current_date, current_date + 30)`, [tenant, centr, person, product]).catch(() => null);
  }
  await withCtx(t.pool, sys(), (db) => processOutcomes(db, centr));
  const got = Object.fromEntries((await sql(`select id, outcome from agent_suggestions where id = any($1)`, [ids])).map((r) => [r.id, r.outcome]));
  assert.equal(got[ids[0]], 'done');
  const sold = (await sql(`select 1 from memberships where person_id = $1`, [person])).length > 0;
  if (sold) assert.equal(got[ids[1]], 'sale');
  // Третья подсказка — 3 дня назад: продажа была уже после неё, значит тоже «продажа», иначе «проигнорировано»
  assert.ok(['sale', 'ignored'].includes(got[ids[2]]), got[ids[2]]);
});

test('помощник учится: тип, который все отклоняют, пропадает из подсказок; личное «не моя задача» — только для этого сотрудника', async () => {
  assert.ok((await kinds('m.volkova', 'manager')).includes('hot_calls'));
  // 9 менеджерских «Не то» по «Позвоните первыми» за месяц от коллеги — тип выключается для роли в клубе
  for (let i = 0; i < 9; i++) {
    await sql(`insert into agent_suggestions(tenant_id, club_id, user_id, role, source, kind, body, rating, reason, rated_at) values ($1, $2, $3, 'manager', 'morning', 'hot_calls', 'x', -1, 'not_relevant', now())`,
      [tenant, centr, uid['a.bespalyy']]);
  }
  const k = await kinds('m.volkova', 'manager');
  assert.ok(!k.includes('hot_calls'), k.join());
  assert.equal(k.length, 3); // место заняла следующая подсказка или общий совет роли
  // Руководитель решил «показывать чаще» — подсказка возвращается
  assert.equal((await req('PUT', '/api/agent/learning/rule', 'm.volkova', { clubId: centr, role: 'manager', kind: 'hot_calls', mode: 'boost' })).statusCode, 403);
  const p = await req('PUT', '/api/agent/learning/rule', 'o.smirnov', { clubId: centr, role: 'manager', kind: 'hot_calls', mode: 'boost' });
  assert.equal(p.statusCode, 200, p.body);
  assert.ok((await kinds('m.volkova', 'manager')).includes('hot_calls'));
  // Выключение обучения в клубе — веса не считаются (ручные решения остаются)
  await req('PUT', '/api/agent/learning/rule', 'o.smirnov', { clubId: centr, role: 'manager', kind: 'hot_calls', mode: 'auto' });
  assert.equal((await req('PUT', '/api/agent/learning/settings', 'o.smirnov', { clubId: centr, learning: false })).statusCode, 200);
  assert.ok((await kinds('m.volkova', 'manager')).includes('hot_calls'));
  await req('PUT', '/api/agent/learning/settings', 'o.smirnov', { clubId: centr, learning: true });
  await sql(`delete from agent_suggestions where kind = 'hot_calls' and user_id = $1`, [uid['a.bespalyy']]);
  // Лично: дважды «Не моя задача» на «Ответьте на заявки»
  for (let i = 0; i < 2; i++) {
    await sql(`insert into agent_suggestions(tenant_id, club_id, user_id, role, source, kind, body, rating, reason, rated_at) values ($1, $2, $3, 'manager', 'morning', 'leads_reply', 'x', -1, 'not_mine', now())`,
      [tenant, centr, uid['m.volkova']]);
  }
  assert.ok(!(await kinds('m.volkova', 'manager')).includes('leads_reply'));
});

test('карточки в колокольчике: оценка, «Не показывать» для роли', async () => {
  const task = (await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1, $2, $3, 'call', 'Карточка', now()) returning id`, [tenant, centr, uid['m.volkova']]))[0].id;
  await withCtx(t.pool, sys(), (db) => card(db, centr, [uid['m.volkova']], { kind: 'agent_task', title: 'Просрочена задача: Карточка', body: '', objectType: 'task', objectId: task, actions: ['open'], link: null }));
  const note = (await sql(`select id from staff_notifications where object_id = $1`, [task]))[0].id;
  const s = (await sql(`select kind, role, targets from agent_suggestions where notification_id = $1`, [note]))[0];
  assert.equal(s.kind, 'card:agent_task'); assert.equal(s.role, 'manager'); assert.deepEqual(s.targets.taskIds, [task]);
  assert.equal((await req('POST', `/api/agent/notifications/${note}/rate`, 'm.volkova', { rating: 1 })).statusCode, 200);
  await req('PUT', '/api/agent/learning/rule', 'o.smirnov', { clubId: centr, role: 'manager', kind: 'card:agent_task', mode: 'off' });
  const sent = await withCtx(t.pool, sys(), (db) => card(db, centr, [uid['m.volkova']], { kind: 'agent_task', title: 'Ещё', body: '', objectType: null, objectId: null, actions: [], link: null }));
  assert.equal(sent, 0);
  await req('PUT', '/api/agent/learning/rule', 'o.smirnov', { clubId: centr, role: 'manager', kind: 'card:agent_task', mode: 'auto' });
});

test('ответ помощника в чате можно оценить, удачные ответы становятся образцами для нейросети', async () => {
  const chat = (await req('POST', '/api/agent/chat', 'm.volkova')).json().id;
  const since = (await sql(`select now() as at`))[0].at;
  assert.equal((await req('POST', `/api/team/chats/${chat}/messages`, 'm.volkova', { body: 'подсказки на сегодня' })).statusCode, 200);
  let m: { meta: { kind: string; sids: string[] } } | undefined;
  for (let i = 0; i < 200 && !m; i++) {
    m = (await sql(`select meta from team_messages where chat_id = $1 and meta->>'kind' = 'morning_hints' and created_at > $2 order by created_at desc limit 1`, [chat, since]))[0];
    if (!m) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(m, 'нет ответа с подсказками');
  assert.equal(m!.meta.sids.length, 3);
  const src = await sql(`select source from agent_suggestions where id = any($1)`, [m!.meta.sids]);
  assert.ok(src.every((r) => r.source === 'chat'));
  // Длинный ответ руководителю — оцениваемый
  const sid = await withCtx(t.pool, sys(), (db) => recordSuggestion(db, { clubId: centr, userId: uid['o.smirnov'], role: 'gm', source: 'chat', kind: 'chat:owner', body: 'План выполним на 92 %: добрать 120 000 ₽ продлениями.', question: 'выполним план?' }));
  assert.equal((await req('POST', `/api/agent/suggestions/${sid}/rate`, 'o.smirnov', { rating: 1 })).statusCode, 200);
  const ex = await withCtx(t.pool, sys(), (db) => goodExamples(db, ['chat:owner']));
  assert.match(ex, /Вопрос: выполним план\?\nОтвет: План выполним на 92 %/);
});

test('страница «Чему научился помощник»: руководителям, с выводами простыми словами', async () => {
  assert.equal((await req('GET', `/api/agent/learning?clubId=${centr}`, 'd.lis')).statusCode, 403);
  const r = await req('GET', `/api/agent/learning?clubId=${centr}&days=30`, 'a.bespalyy');
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.ok(b.summary.shown >= 5, JSON.stringify(b.summary));
  assert.ok(b.items.some((i: { kind: string; name: string }) => i.kind === 'hot_calls' && i.name === 'Позвонить горячим клиентам'));
  assert.ok(b.reasons.some((x: { name: string }) => x.name === 'Неактуально'));
  assert.ok(b.comments.some((c: { comment: string }) => c.comment === 'Злата уже купила'));
  assert.ok(b.examples.some((e: { question: string }) => e.question === 'выполним план?'));
  assert.ok(b.lessons.length >= 1);
  assert.equal(b.canEdit, true);
  const all = await req('GET', '/api/agent/learning', 'a.bespalyy');
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().canEdit, false);
});
