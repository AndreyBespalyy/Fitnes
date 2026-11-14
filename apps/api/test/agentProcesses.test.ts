// ИИ-агент, этап 6: бизнес-процессы — шаблоны, конструктор, «опиши словами», ход процесса, «Коротко о ситуации».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { advanceProcesses, parseProcessText } from '../src/modules/agentProcesses.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';

async function ask(text: string, who = 'a.bespalyy') {
  const chat = (await req('POST', '/api/agent/chat', who)).json().id;
  const before = (await sql(`select count(*)::int as n from team_messages where chat_id = $1`, [chat]))[0].n;
  assert.equal((await req('POST', `/api/team/chats/${chat}/messages`, who, { body: text })).statusCode, 200);
  for (let i = 0; i < 200; i++) {
    const rows = await sql(`select m.body, u.is_bot from team_messages m join users u on u.id = m.user_id where m.chat_id = $1 order by m.created_at`, [chat]);
    if (rows.length >= before + 2 && rows.at(-1).is_bot) return rows.at(-1).body as string;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Помощник не ответил');
}

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'a.kim', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  const c = (await sql(`select id, tenant_id from clubs where name like '%Центр%'`))[0]; centr = c.id; tenant = c.tenant_id;
  await sql(`update tasks set done_at = now(), result = 'тест'`);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('процесс словами: шаги, роли и сроки', () => {
  const p = parseProcessText('Создай процесс Жалоба клиента: администратор принимает жалобу в течение 1 часа; управляющий разбирается за 2 дня; затем менеджер звонит клиенту через неделю');
  assert.equal(p.name, 'Жалоба клиента');
  assert.deepEqual(p.steps.map((s) => [s.role, s.hours]), [['desk', 1], ['gm', 48], ['manager', 168]]);
  assert.equal(p.steps[0].title, 'Администратор принимает жалобу');
  const w = parseProcessText('Жалоба клиента: администратор принимает жалобу в течение часа; управляющий разбирается за сутки; через неделю менеджер уточняет, всё ли в порядке');
  assert.deepEqual(w.steps.map((s) => [s.title, s.hours]), [['Администратор принимает жалобу', 1], ['Управляющий разбирается', 24], ['Менеджер уточняет, всё ли в порядке', 168]]);
  const q = parseProcessText('1. Позвонить клиенту сразу\n2. Тренер проводит вводную на следующий день\n3. Отправить отзыв');
  assert.deepEqual(q.steps.map((s) => [s.role, s.hours]), [['owner', 1], ['trainer', 24], ['owner', 24]]);
});

test('готовые шаблоны, конструктор и права', async () => {
  const g = (await req('GET', '/api/processes/templates', 'm.volkova')).json();
  assert.ok(g.items.length >= 5);
  assert.equal(g.canEdit, false);
  assert.ok(g.items.some((x: { name: string }) => /Новый клиент/.test(x.name)));
  assert.equal((await req('POST', '/api/processes/templates', 'm.volkova', { name: 'X', steps: [{ title: 'a', role: 'manager', hours: 1 }] })).statusCode, 403);
  assert.equal((await req('POST', '/api/processes/templates', 'o.smirnov', { name: 'X', steps: [{ title: 'a', role: 'boss', hours: 1 }] })).statusCode, 400);
  const c = await req('POST', '/api/processes/templates', 'o.smirnov', { name: 'Проверка зала', description: 'тест', steps: [{ title: 'Осмотреть тренажёры', role: 'trainer', hours: 4 }, { title: 'Заказать ремонт', role: 'gm', hours: 24 }] });
  assert.equal(c.statusCode, 200, c.body);
  const ft = await req('POST', '/api/processes/from-text', 'o.smirnov', { text: 'Открытие смены: администратор включает свет и музыку сразу; тренер проверяет зал за 1 час' });
  assert.equal(ft.json().steps.length, 2);
  assert.equal(ft.json().engine, 'rules');
});

test('запуск по шаблону: шаг — задача исполнителя, выполнен — следующий, конец — карточка; «Коротко о ситуации»', async () => {
  const tpl = (await req('GET', '/api/processes/templates', 'o.smirnov')).json().items.find((x: { builtin: string }) => x.builtin === 'new_client');
  const l = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Пётр Процессов', phone: '+79001112299', sourceCode: 'walk_in' });
  const personId = l.json().personId;
  const s = await req('POST', '/api/processes', 'o.smirnov', { clubId: centr, templateId: tpl.id, personId, note: 'хочет похудеть к лету' });
  assert.equal(s.statusCode, 200, s.body);
  const id = s.json().id;
  const st = await sql(`select s.ord, s.status, u.login, t.title, t.kind from process_steps s left join users u on u.id = s.assignee_id left join tasks t on t.id = s.task_id where s.process_id = $1 order by s.ord`, [id]);
  assert.equal(st.length, 5);
  assert.equal(st[0].status, 'active');
  assert.equal(st[0].login, 'm.volkova'); // менеджер клиента
  assert.equal(st[0].kind, 'call');
  assert.match(st[0].title, /процесс «Новый клиент: от заявки до первой тренировки — Пётр Процессов»/);
  assert.ok(st.slice(1).every((x) => x.status === 'pending'));
  // Менеджер видит процесс, где у него шаг; отмечает шаг — агент запускает следующий
  const mine = (await req('GET', `/api/processes?clubId=${centr}`, 'm.volkova')).json().items;
  assert.ok(mine.some((x: { id: string }) => x.id === id));
  assert.equal((await req('POST', `/api/processes/${id}/step-done`, 'm.volkova', { result: 'Записан на экскурсию' })).statusCode, 200);
  // Выполнение задачи в обычном разделе «Задачи» тоже двигает процесс (через проход агента)
  await sql(`update tasks set done_at = now(), result = 'Подтвердил' where id = (select task_id from process_steps where process_id = $1 and ord = 2)`, [id]);
  await withCtx(t.pool, { tenantId: tenant, allClubs: true, clubIds: [] }, (db) => advanceProcesses(db, { tenantId: tenant, userId: null }, centr));
  const st2 = await sql(`select ord, status from process_steps where process_id = $1 order by ord`, [id]);
  assert.deepEqual(st2.map((x) => x.status), ['done', 'done', 'active', 'pending', 'pending']);
  // «Коротко о ситуации» по процессу
  const b = (await req('GET', `/api/agent/brief/process/${id}?force=1`, 'o.smirnov')).json();
  assert.match(b.text, /выполнено \*\*2 из 5\*\* шагов/);
  assert.match(b.text, /\*\*Шаги процесса\*\*/);
  assert.match(b.text, /✅ 1\. Позвонить по заявке.*Итог: Записан на экскурсию/);
  assert.match(b.text, /\*\*Клиент: Пётр Процессов\*\*/);
  assert.equal((b.text.match(/\*\*Что сделать сейчас\*\*/g) ?? []).length, 1);
  assert.match(b.text, /Пометка: хочет похудеть к лету/);
  assert.ok(b.text.length <= 6000);
  // Чужой сотрудник без шага — не видит
  assert.ok([403, 404].includes((await req('GET', `/api/agent/brief/process/${id}`, 'd.lis')).statusCode));
  // Доводим до конца — процесс завершён, ответственному карточка
  for (let i = 0; i < 3; i++) await req('POST', `/api/processes/${id}/step-done`, 'o.smirnov', {});
  assert.equal((await sql(`select status from processes where id = $1`, [id]))[0].status, 'done');
  assert.ok((await req('GET', '/api/notifications', 'o.smirnov')).json().items.some((x: { title: string }) => /Процесс завершён/.test(x.title)));
});

test('выход за срок — карточка ответственному и РОПу; чат: «создай процесс» и «процессы»; отмена', async () => {
  const s = await req('POST', '/api/processes', 'o.smirnov', { clubId: centr, title: 'Ремонт душевой', steps: [{ title: 'Вызвать мастера', role: 'gm', hours: 2 }, { title: 'Проверить работу', role: 'desk', hours: 24 }] });
  const id = s.json().id;
  assert.equal((await req('POST', '/api/processes', 'm.volkova', { clubId: centr, title: 'X', steps: [{ title: 'a', role: 'manager', hours: 1 }] })).statusCode, 403);
  await sql(`update processes set due_at = now() - interval '1 hour' where id = $1`, [id]);
  const run = () => withCtx(t.pool, { tenantId: tenant, allClubs: true, clubIds: [] }, (db) => advanceProcesses(db, { tenantId: tenant, userId: null }, centr));
  assert.equal((await run()).late, 1);
  assert.equal((await run()).late, 0);
  assert.ok((await req('GET', '/api/notifications', 'o.smirnov')).json().items.some((x: { title: string }) => /выходит за срок: Ремонт душевой/.test(x.title)));
  const list = await ask('процессы');
  assert.match(list, /⚠️ \*\*Ремонт душевой\*\* — 0 из 2; сейчас: Вызвать мастера/);
  const w = await ask('Создай процесс Возврат долга: финансист звонит должнику в течение 1 дня; затем управляющий решает вопрос за 3 дня');
  assert.match(w, /Сохранил шаблон процесса \*\*«Возврат долга»\*\*/);
  assert.match(w, /1\. Финансист звонит должнику — финансист, 1 дн\./);
  assert.match(w, /2\. Управляющий решает вопрос — управляющий, 3 дн\./);
  assert.match(await ask('что горит'), /Бизнес-процессы вышли за срок: \*\*1\*\*/);
  assert.equal((await req('POST', `/api/processes/${id}/cancel`, 'o.smirnov')).statusCode, 200);
  assert.equal((await sql(`select count(*)::int as n from tasks t join process_steps s on s.task_id = t.id where s.process_id = $1 and t.done_at is null`, [id]))[0].n, 0);
});
