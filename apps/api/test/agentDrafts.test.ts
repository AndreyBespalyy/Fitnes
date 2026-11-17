// Советы помощника — готовой задачей: кнопка «Поставить задачу» самому свободному менеджеру, руководитель проверяет и ставит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };

async function ask(text: string, who: string) {
  const chat = (await req('POST', '/api/agent/chat', who)).json().id;
  const before = (await sql(`select count(*)::int as n from team_messages where chat_id = $1`, [chat]))[0].n;
  assert.equal((await req('POST', `/api/team/chats/${chat}/messages`, who, { body: text })).statusCode, 200);
  for (let i = 0; i < 300; i++) {
    const rows = await sql(`select m.id, m.body, m.meta, u.is_bot from team_messages m join users u on u.id = m.user_id where m.chat_id = $1 order by m.created_at`, [chat]);
    if (rows.length >= before + 2 && rows.at(-1).is_bot) return rows.at(-1) as { id: string; body: string; meta: { actions?: { label: string; task?: Record<string, unknown> }[] } | null };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Помощник не ответил');
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('«что с продажами»: отстающее направление — кнопка с готовой задачей самому свободному менеджеру', async () => {
  const c = (await sql(`select id, tenant_id, timezone from clubs where name like '%Центр%'`))[0];
  // Огромный план по продлениям — направление точно отстаёт
  await sql(`insert into plan_targets(tenant_id, club_id, month, category, amount_kop) values ($1, $2, date_trunc('month', now() at time zone $3)::date, 'renewal', 900000000)
    on conflict (club_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), category) do update set amount_kop = 900000000`, [c.tenant_id, c.id, c.timezone]);
  const m = await ask('что с продажами', 'o.smirnov');
  if (!/🔴/.test(m.body)) return; // первые дни месяца — светофор ещё не красный
  const btn = m.meta?.actions?.find((a) => a.task);
  assert.ok(btn, JSON.stringify(m.meta));
  assert.match(btn.label, /^Поставить задачу: .+ — цель на звонки$/);
  const d = btn.task as { assigneeId: string; assigneeName: string; title: string; candidates: { id: string; overdue: number; open: number }[]; why: string };
  assert.match(d.title, /^Дневная цель: \d+ звонков за день по отстающим направлениям — .*продления/);
  assert.equal(d.assigneeId, d.candidates[0].id);
  assert.match(d.why, /^Свободнее всех: \d+ задач/);
  assert.match(m.body, /задача уже подготовлена/);
  assert.doesNotMatch(m.body, /Откройте «Кому звонить» по этим категориям/);

  // Менеджер не может поставить задачу из чужого совета
  assert.equal((await req('POST', '/api/agent/advice-task', 'm.volkova', { messageId: m.id, idx: 0, assigneeId: d.assigneeId, title: d.title, dueAt: new Date().toISOString() })).statusCode, 403);
  // Руководитель ставит — задача у менеджера, кнопка меняется на «Поставлено», сотруднику пишет помощник
  const idx = m.meta!.actions!.indexOf(btn);
  const r = await req('POST', '/api/agent/advice-task', 'o.smirnov', { messageId: m.id, idx, assigneeId: d.assigneeId, title: d.title, dueAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(r.statusCode, 200, r.body);
  const task = (await sql(`select assignee_id, title, kind from tasks where id = $1`, [r.json().taskId]))[0];
  assert.equal(task.assignee_id, d.assigneeId);
  assert.equal(task.kind, 'call');
  const meta = (await sql(`select meta from team_messages where id = $1`, [m.id]))[0].meta;
  assert.equal(meta.actions[idx].done.taskId, r.json().taskId);
  assert.equal((await req('POST', '/api/agent/advice-task', 'o.smirnov', { messageId: m.id, idx, assigneeId: d.assigneeId, title: d.title, dueAt: new Date().toISOString() })).statusCode, 409);
  const note = await sql(`select m.body from team_messages m where m.meta->>'kind' = 'advice_task' and m.meta->>'taskId' = $1`, [r.json().taskId]);
  if (d.assigneeId !== (await sql(`select id from users where login = 'o.smirnov'`))[0].id) assert.match(note[0].body, /^\*\*Новая задача от руководителя — Олег Смирнов:\*\* Дневная цель/);
});

test('тренер: «кто не пришёл на последнюю тренировку», кнопки «Позвонить» / «Написать», звонок своему клиенту', async () => {
  ck['a.kim'] ??= (await login(t.app, 'a.kim')).cookie!;
  const c = (await sql(`select id, tenant_id from clubs where name like '%Центр%'`))[0];
  const kim = (await sql(`select id from users where login = 'a.kim'`))[0].id;
  const type = (await sql(`select id from class_types where club_id = $1 limit 1`, [c.id]))[0]?.id
    ?? (await sql(`insert into class_types(tenant_id, club_id, name, kind, description) values ($1, $2, 'Пилатес', 'group', 'Мягкая сила и растяжка') returning id`, [c.tenant_id, c.id]))[0].id;
  const s = (await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity, status) values ($1,$2,$3,$4, now() - interval '10 minutes', now() - interval '5 minutes', 10, 'done') returning id`,
    [c.tenant_id, c.id, type, kim]))[0].id;
  await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity) values ($1,$2,$3,$4, now() + interval '2 days', now() + interval '2 days 1 hour', 10)`, [c.tenant_id, c.id, type, kim]);
  const p1 = (await req('POST', '/api/leads', 'm.volkova', { clubId: c.id, fullName: 'Громов Алексей', phone: '+79006660011', sourceCode: 'walk_in' })).json().personId;
  const p2 = (await req('POST', '/api/leads', 'm.volkova', { clubId: c.id, fullName: 'Пришедший Пётр', phone: '+79006660012', sourceCode: 'walk_in' })).json().personId;
  await sql(`insert into class_bookings(tenant_id, club_id, session_id, person_id, status) values ($1,$2,$3,$4,'no_show'), ($1,$2,$3,$5,'attended')`, [c.tenant_id, c.id, s, p1, p2]);

  const m = await ask('кто не пришел на последнюю тренировку', 'a.kim');
  assert.match(m.body, /^\*\*Прошлое занятие — «.+», .. \d\d\.\d\d в \d\d:\d\d\.\*\*\nНе пришли \(1 из 2\):\n1\. Громов Алексей/);
  const acts = m.meta!.actions as { label: string; call?: { persons: { id: string }[] }; write?: { kind: string; personIds: string[] } }[];
  assert.deepEqual(acts.map((a) => a.label), ['Позвонить клиентам', 'Написать клиентам', 'Открыть занятие']);
  assert.deepEqual(acts[0].call!.persons.map((p) => p.id), [p1]);

  // Тренер звонит своему клиенту, чужому — нет
  assert.equal((await req('POST', `/api/persons/${p1}/dial`, 'a.kim')).statusCode, 200);
  const other = (await req('POST', '/api/leads', 'm.volkova', { clubId: c.id, fullName: 'Чужой Клиент', phone: '+79006660013', sourceCode: 'walk_in' })).json().personId;
  assert.equal((await req('POST', `/api/persons/${other}/dial`, 'a.kim')).statusCode, 400);

  // Приглашение на ближайшее занятие с датой, временем и описанием
  const d = (await req('POST', '/api/agent/invite-draft', 'a.kim', { kind: 'noshow', personIds: [p1, other] })).json();
  assert.match(d.text, /^\{имя\}, здравствуйте! Это .+, ваш тренер\. Не увиделись на прошлом занятии — всё в порядке\? Приглашаю на следующее: «.+», (сегодня|завтра|.. \d\d\.\d\d) в \d\d:\d\d\./);
  assert.deepEqual(d.people.map((p: { id: string }) => p.id), [p1]); // чужого клиента в списке нет
  const r = (await req('POST', '/api/agent/invite-send', 'a.kim', { personIds: [p1, other], text: d.text })).json();
  assert.ok(r.failed.some((f: { name: string; reason: string }) => f.name === 'Чужой Клиент' && f.reason === 'не ваш клиент'));
  // Без подключённого мессенджера — понятная причина; с ним — сообщение с именем клиента
  const ch = await sql(`select id from msg_channels where status = 'active' and messenger = 'whatsapp' limit 1`);
  assert.equal(r.sent.length > 0, ch.length > 0, JSON.stringify(r));
  if (r.sent.length) {
    const msg = await sql(`select m.body from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.person_id = $1 order by m.created_at desc limit 1`, [p1]);
    assert.match(msg[0].body, /^Алексей, здравствуйте!/);
  } else assert.match(r.failed[0].reason, /мессенджер|позвоните/);
});

test('руководитель: «кто из менеджеров отстаёт от плана» — список по отставанию и кнопки «Задачи на сегодня»', async () => {
  const c = (await sql(`select id, tenant_id, timezone from clubs where name like '%Центр%'`))[0];
  const vol = (await sql(`select id from users where login = 'm.volkova'`))[0].id;
  await sql(`insert into plan_targets(tenant_id, club_id, month, user_id, category, amount_kop) values ($1, $2, date_trunc('month', now() at time zone $3)::date, $4, 'new', 500000000)
    on conflict (club_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), category) do update set amount_kop = 500000000`, [c.tenant_id, c.id, c.timezone, vol]);
  const m = await ask('кто самый отстающий от выполнения плана из менеджеров', 'o.smirnov');
  assert.match(m.body, /^\*\*Менеджеры по отставанию от плана\*\* · .+, \d+ из \d+ дн\. месяца\n1\. \*\*Мария Волкова\*\* — отстаёт от графика на \*\*\d+ %\*\*: .+ из .+ \(\d+(\.\d+)? % плана, к сегодняшнему дню нужно .+\)/);
  const a = m.meta!.actions![0] as { label: string; url: string };
  assert.equal(a.label, 'Задачи на сегодня: Волкова');
  assert.equal(a.url, `/?tab=tasks&scope=all&user=${vol}&day=today`);
});

test('советы — кнопками: варианты «напишите номер», «что горит» с готовыми задачами и чатом', async () => {
  const { choiceButtons } = await import('../src/modules/agentChat.ts');
  assert.deepEqual(choiceButtons('Уточните, кого вы имеете в виду:\n1 — Мария Волкова (менеджер)\n2 — Мария Котова (администратор)\n\nНапишите номер.'),
    [{ label: 'Мария Волкова (менеджер)', ask: '1' }, { label: 'Мария Котова (администратор)', ask: '2' }]);
  assert.deepEqual(choiceButtons('1 — без вопроса'), []);

  const c = (await sql(`select id from clubs where name like '%Центр%'`))[0];
  await req('POST', '/api/leads', 'm.volkova', { clubId: c.id, fullName: 'Безответный Лид', phone: '+79006660031', sourceCode: 'walk_in' });
  await sql(`update leads set taken_at = null, first_response_at = null where person_id = (select id from persons where full_name = 'Безответный Лид')`);
  const m = await ask('что горит', 'o.smirnov');
  const acts = m.meta!.actions! as { label: string; task?: { title: string }; url?: string; ask?: string }[];
  const t = acts.find((a) => a.task && /заявки без ответа$/.test(a.label));
  assert.ok(t, JSON.stringify(acts.map((a) => a.label)));
  assert.match(t.task!.title, /^Ответить на заявки без ответа \(\d+\) в течение часа/);
  assert.ok(acts.some((a) => a.url === '/?tab=leads&filter=noresponse'));
  assert.match(m.body, /Задача самому свободному менеджеру подготовлена — кнопка ниже/);
  assert.doesNotMatch(m.body, /Проверьте, кто на смене/);
});
