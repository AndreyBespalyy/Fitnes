// ИИ-агент, этап 2: лестница по просроченным задачам, клиент ждёт ответа, авто-передача заявки, кнопки в карточках, настройки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { processAgentClub } from '../src/modules/agentReminders.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';
let n = 0;
const run = () => withCtx(t.pool, { tenantId: tenant, allClubs: true, clubIds: [] }, (db) => processAgentClub(db, { tenantId: tenant, userId: null }, { id: centr, h: 12 }));
type Note = { id: string; kind: string; title: string; objectId: string; actions: string[]; acted: string | null };
const notes = async (who: string) => (await req('GET', '/api/notifications', who)).json().items as Note[];
const lead = async () => {
  const r = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: `Клиент Агента ${++n}`, phone: `+7900888${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { leadId: string; personId: string; opportunityId: string };
};

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  // Старые задачи и заявки тестовых данных не мешают
  await sql(`update tasks set done_at = now(), result = 'тест'`);
  await sql(`update leads set taken_at = now()`);
  await sql(`delete from staff_notifications`);
  // Второй менеджер в «Центре» — для передачи заявок
  const u = (await sql(`insert into users(tenant_id, login, password_hash, full_name, must_change_password) select tenant_id, 'k.second', password_hash, 'Ксения Вторая', false from users where login = 'm.volkova' returning id`))[0].id;
  await sql(`insert into user_assignments(tenant_id, user_id, role_code, club_id) values ($1,$2,'manager',$3)`, [tenant, u, centr]);
  ck['k.second'] = (await login(t.app, 'k.second')).cookie!;
});
const loginOf = async (userId: string) => (await sql(`select login from users where id = $1`, [userId]))[0].login as string;
const nameOf = async (login: string) => (await sql(`select full_name from users where login = $1`, [login]))[0].full_name as string;
after(async () => { await t.app.close(); await t.pool.end(); });

test('просроченная задача: карточка исполнителю, через час РОПу, через 4 ч управляющему; кнопки работают', async () => {
  await sql(`update agent_settings set lead_reassign_minutes = 0`); // передачу заявок проверяем отдельно
  await sql(`insert into agent_settings(club_id, tenant_id, lead_reassign_minutes) values ($1,$2,0) on conflict (club_id) do update set lead_reassign_minutes = 0`, [centr, tenant]);
  const l = await lead();
  const tr = (await sql(`select id, assignee_id from tasks where opportunity_id = $1 and done_at is null`, [l.opportunityId]))[0];
  const task = tr.id;
  const who = await loginOf(tr.assignee_id);
  const other = who === 'm.volkova' ? 'k.second' : 'm.volkova';
  await sql(`update tasks set due_at = now() - interval '10 minutes' where id = $1`, [task]);
  await run();
  const mine = (await notes(who)).find((x) => x.objectId === task)!;
  assert.ok(mine, 'карточка исполнителю');
  assert.deepEqual(mine.actions, ['brief', 'open', 'snooze_1h', 'snooze_tomorrow']);
  assert.equal((await notes('o.astafeva')).filter((x) => x.objectId === task).length, 0);
  // Повторный проход не дублирует
  await run();
  assert.equal((await notes(who)).filter((x) => x.objectId === task).length, 1);
  // Через 70 минут — РОП, через 5 часов — управляющий
  await sql(`update tasks set due_at = now() - interval '70 minutes' where id = $1`, [task]);
  await run();
  const rop = (await notes('o.astafeva')).find((x) => x.objectId === task)!;
  assert.equal(rop.title, `${await nameOf(who)}: задача просрочена на 1 ч 10 мин`);
  assert.deepEqual(rop.actions, ['brief', 'open', 'nudge', 'reassign']);
  assert.equal((await notes('o.smirnov')).filter((x) => x.objectId === task).length, 0);
  await sql(`update tasks set due_at = now() - interval '5 hours' where id = $1`, [task]);
  await run();
  assert.equal((await notes('o.smirnov')).filter((x) => x.objectId === task).length, 1);
  // Наблюдение агента попадает в «Коротко о ситуации»
  const brief = (await req('GET', `/api/agent/brief/task/${task}?force=1`, who)).json();
  assert.match(brief.text, /Наблюдения ИИ-помощника/);
  // РОП: «Напомнить исполнителю»
  const nudge = await req('POST', `/api/agent/notifications/${rop.id}/action`, 'o.astafeva', { action: 'nudge' });
  assert.equal(nudge.statusCode, 200, nudge.body);
  assert.ok((await notes(who)).some((x) => /Ольга Астафьева просит выполнить/.test(x.title)));
  // Исполнитель: «Через час» — срок сдвигается
  const sn = await req('POST', `/api/agent/notifications/${mine.id}/action`, who, { action: 'snooze_1h' });
  assert.equal(sn.json().message, 'Перенесено на час');
  const due = (await sql(`select due_at from tasks where id = $1`, [task]))[0].due_at;
  assert.ok(new Date(due).getTime() > Date.now() + 50 * 60_000);
  assert.equal((await notes(who)).find((x) => x.id === mine.id)!.acted, 'snooze_1h');
  // Чужая карточка и недоступное действие
  assert.equal((await req('POST', `/api/agent/notifications/${mine.id}/action`, 'o.astafeva', { action: 'snooze_1h' })).statusCode, 404);
  assert.equal((await req('POST', `/api/agent/notifications/${mine.id}/action`, who, { action: 'reassign' })).statusCode, 400);
  // РОП: «Передать другому» — сделка и задачи уходят менеджеру с меньшей загрузкой
  const rs = await req('POST', `/api/agent/notifications/${rop.id}/action`, 'o.astafeva', { action: 'reassign' });
  assert.equal(rs.statusCode, 200, rs.body);
  assert.equal(rs.json().message, `Передано: ${await nameOf(other)}`);
  assert.equal((await sql(`select u.login from opportunities o join users u on u.id = o.owner_id where o.id = $1`, [l.opportunityId]))[0].login, other);
});

test('клиент написал и ждёт ответа: карточка ответственному, втрое дольше — РОПу; ответ сотрудника снимает', async () => {
  const l = await lead();
  const ch = (await sql(`insert into msg_channels(tenant_id, club_id, kind, messenger, name, webhook_token) values ($1,$2,'test','telegram','Бот','wh-agent') returning id`, [tenant, centr]))[0].id;
  const conv = (await sql(`insert into msg_conversations(tenant_id, club_id, channel_id, person_id, external_chat_id, title, last_inbound_at)
    values ($1,$2,$3,$4,'chat-agent','Клиент', now() - interval '20 minutes') returning id`, [tenant, centr, ch, l.personId]))[0].id;
  await run();
  const owner = (await sql(`select u.login from opportunities o join users u on u.id = o.owner_id where o.id = $1`, [l.opportunityId]))[0].login;
  const card = (await notes(owner)).find((x) => x.kind === 'agent_reply')!;
  assert.match(card.title, /ждёт ответа 20 мин/);
  assert.deepEqual(card.actions, ['chat', 'brief']);
  assert.equal((await notes('o.astafeva')).filter((x) => x.kind === 'agent_escalate' && x.objectId === l.opportunityId).length, 0);
  await sql(`update msg_conversations set last_inbound_at = now() - interval '50 minutes' where id = $1`, [conv]);
  await run();
  assert.equal((await notes('o.astafeva')).filter((x) => x.objectId === l.opportunityId && /ждёт ответа/.test(x.title)).length, 1);
  // Новое сообщение клиента после ответа сотрудника — новый отсчёт; пока ответ есть, сигналов нет
  await sql(`insert into msg_messages(tenant_id, club_id, conversation_id, direction, body, status) values ($1,$2,$3,'out','Здравствуйте!','sent')`, [tenant, centr, conv]);
  await sql(`update msg_conversations set last_inbound_at = now() - interval '40 minutes' where id = $1`, [conv]);
  const before = (await notes(owner)).length;
  await run();
  assert.equal((await notes(owner)).length, before);
});

test('заявку не взяли за 10 минут — агент передаёт её другому менеджеру и сообщает всем', async () => {
  await sql(`update agent_settings set lead_reassign_minutes = 10 where club_id = $1`, [centr]);
  const l = await lead();
  const from = (await sql(`select assigned_to from leads where id = $1`, [l.leadId]))[0].assigned_to;
  await sql(`update leads set created_at = created_at - interval '12 minutes', first_response_due_at = first_response_due_at - interval '12 minutes' where id = $1`, [l.leadId]);
  const r = await run();
  assert.equal(r.reassigned, 1);
  const row = (await sql(`select assigned_to, agent_reassigned_from from leads where id = $1`, [l.leadId]))[0];
  assert.notEqual(row.assigned_to, from);
  assert.equal(row.agent_reassigned_from, from);
  assert.equal((await sql(`select owner_id from opportunities where id = $1`, [l.opportunityId]))[0].owner_id, row.assigned_to);
  assert.ok((await notes('o.astafeva')).some((x) => /Заявка передана/.test(x.title)));
  assert.equal((await run()).reassigned, 0);
});

test('настройки: менеджер видит, управляющий меняет, лестница должна расти; ночью тишина', async () => {
  const g = await req('GET', `/api/agent/settings?clubId=${centr}`, 'm.volkova');
  assert.equal(g.statusCode, 200);
  assert.equal(g.json().canEdit, false);
  assert.equal((await req('PUT', '/api/agent/settings', 'm.volkova', { clubId: centr, taskRopMinutes: 30 })).statusCode, 403);
  assert.equal((await req('PUT', '/api/agent/settings', 'o.smirnov', { clubId: centr, taskRopMinutes: 300 })).statusCode, 400);
  const ok = await req('PUT', '/api/agent/settings', 'o.smirnov', { clubId: centr, taskRopMinutes: 30, replyWaitMinutes: 10 });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().taskRopMinutes, 30);
  const night = await withCtx(t.pool, { tenantId: tenant, allClubs: true, clubIds: [] }, (db) => processAgentClub(db, { tenantId: tenant, userId: null }, { id: centr, h: 23 }));
  assert.deepEqual(night, { tasks: 0, replies: 0, reassigned: 0 });
});
