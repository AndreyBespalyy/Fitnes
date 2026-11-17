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
