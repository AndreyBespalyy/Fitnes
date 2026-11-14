// ИИ-агент, этап 5: «Назначить собрание» — подбор времени с наименьшими потерями, переносы, приглашения с кнопкой.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { chooseSlots, parseMeeting, processMeetingReminders, zoned } from '../src/modules/agentMeetings.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const chats: Record<string, string> = {};
const msk = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);

async function ask(text: string, who = 'a.bespalyy') {
  const chat = chats[who] ??= (await req('POST', '/api/agent/chat', who)).json().id;
  const before = (await sql(`select count(*)::int as n from team_messages where chat_id = $1`, [chat]))[0].n;
  const r = await req('POST', `/api/team/chats/${chat}/messages`, who, { body: text });
  assert.equal(r.statusCode, 200, r.body);
  for (let i = 0; i < 200; i++) {
    const rows = await sql(`select m.body, u.is_bot from team_messages m join users u on u.id = m.user_id where m.chat_id = $1 order by m.created_at`, [chat]);
    if (rows.length >= before + 2 && rows.at(-1).is_bot) return rows.at(-1).body as string;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('Помощник не ответил');
}
const botMsgs = async (login: string) => sql(`select m.body, m.meta from team_messages m join users b on b.id = m.user_id and b.is_bot
  join team_members tm on tm.chat_id = m.chat_id join users u on u.id = tm.user_id where u.login = $1 order by m.created_at`, [login]);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'm.volkova', 'a.kim', 'o.smirnov']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор просьбы: группы, окно, длительность, тема, место', () => {
  const d = parseMeeting('Назначь собрание: отдел продаж и Ким, завтра или в понедельник с 10 до 18, на 1,5 часа, тема: план на декабрь, место: переговорная', '2026-11-14');
  assert.deepEqual(d.roles.sort(), ['manager', 'rop']);
  assert.deepEqual(d.days, ['2026-11-15', '2026-11-16']);
  assert.deepEqual([d.fromMin, d.toMin, d.duration], [600, 1080, 90]);
  assert.equal(d.title, 'план на декабрь');
  assert.equal(d.place, 'Переговорная');
  const e = parseMeeting('собери всех тренеров на следующей неделе утром на полчаса', '2026-11-14');
  assert.ok(e.roles.includes('trainer') && e.roles.includes('desk'));
  assert.equal(e.days.length, 5);
  assert.equal(e.days[0], '2026-11-16');
  assert.deepEqual([e.fromMin, e.toMin, e.duration], [540, 720, 30]);
  const f = parseMeeting('планерка завтра в 9', '2026-11-14');
  assert.deepEqual([f.days[0], f.fromMin, f.toMin], ['2026-11-15', 540, 600]);
  assert.equal(zoned('2026-11-15', 600, 'Europe/Moscow').toISOString(), '2026-11-15T07:00:00.000Z');
});

test('подбор времени: тренировка дороже звонка, отпуск исключает день', () => {
  const tz = 'Europe/Moscow';
  const d = parseMeeting('собрание 16.11 или 17.11 с 10 до 13 на час', '2026-11-14');
  const people = [{ type: 'employee' as const, id: 'a', label: 'Тренер' }, { type: 'employee' as const, id: 'b', label: 'Менеджер' }];
  const at = (day: string, h: number) => zoned(day, h * 60, tz).getTime();
  const busy = [
    { userId: 'a', who: 'Тренер', type: 'personal' as const, id: 's1', start: at('2026-11-16', 10), end: at('2026-11-16', 11), cost: 100, label: 'персональная' },
    { userId: 'b', who: 'Менеджер', type: 'call' as const, id: 'c1', start: at('2026-11-16', 11) + 600_000, end: at('2026-11-16', 11) + 1_500_000, cost: 8, label: 'звонок' },
  ];
  const off = [{ userId: 'b', who: 'Менеджер', day: '2026-11-17', reason: 'отпуск' }];
  const r = chooseSlots(d, people, tz, Date.parse('2026-11-14T00:00:00Z'), busy, off, []);
  // Лучший — 16.11 в 11:30 (всё свободно); 10:00 (тренировка) дороже 11:00 (только звонок)
  assert.equal(r.options[0].start, new Date(at('2026-11-16', 11) + 1_800_000).toISOString());
  assert.equal(r.options[0].cost, 0);
  assert.ok(r.options.every((o, i) => i === 0 || o.cost >= r.options[i - 1].cost));
  assert.ok(!r.options.some((o) => o.start === new Date(at('2026-11-16', 10)).toISOString() && o.cost < 100));
  assert.ok(r.options.every((o) => !o.start.startsWith('2026-11-17') || o.missing.length));
});

test('собственник назначает собрание: варианты, переносы, календари, приглашения, подтверждение', async () => {
  const centr = (await sql(`select id, tenant_id from clubs where name like '%Центр%'`))[0];
  const kim = (await sql(`select id from users where login = 'a.kim'`))[0].id;
  const mv = (await sql(`select id from users where login = 'm.volkova'`))[0].id;
  const tomorrow = msk(new Date(Date.now() + 86_400_000));
  await sql(`update tasks set done_at = now(), result = 'тест'`);
  const type = (await sql(`insert into class_types(tenant_id, club_id, name, kind, capacity) values ($1,$2,'Персональная (тест)','personal',1) returning id`, [centr.tenant_id, centr.id]))[0].id;
  await sql(`insert into class_sessions(tenant_id, club_id, type_id, trainer_id, starts_at, ends_at, capacity) values ($1,$2,$3,$4,$5,$6,1)`,
    [centr.tenant_id, centr.id, type, kim, zoned(tomorrow, 660, 'Europe/Moscow'), zoned(tomorrow, 720, 'Europe/Moscow')]);
  await sql(`delete from staff_shifts`);
  const call = (await sql(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'call','Позвонить Иванову',$4) returning id`,
    [centr.tenant_id, centr.id, mv, zoned(tomorrow, 675, 'Europe/Moscow')]))[0].id;

  const p = await ask('Назначь собрание: отдел продаж и Ким, завтра с 11 до 13, на час, тема: план на декабрь, место: переговорная, в Центре');
  assert.match(p, /\*\*Собрание «план на декабрь»\*\* · 60 мин · место: Переговорная/);
  assert.match(p, /Артём Ким/);
  assert.match(p, /\*\*1 — .*12:00–13:00\*\* · без потерь: все свободны/);
  assert.match(p, /\*\*2 — .*11:00–12:00\*\* · потери заметные/);
  assert.match(p, /Артём Ким: персональная тренировка 11:00 → нужно перенести/);
  assert.match(p, /Мария Волкова: звонок «Позвонить Иванову» 11:15 → сдвину после собрания/);

  // Выбираем вариант с переносами, чтобы проверить их
  const ok = await ask('2');
  assert.match(ok, /Готово: \*\*собрание «план на декабрь» — .*11:00–12:00\*\*, место: Переговорная/);
  assert.match(ok, /разослал \d+ приглашений/);
  const meet = (await sql(`select id, moves from staff_meetings`))[0];
  assert.equal(meet.moves.length, 2);
  // Звонок сдвинут после собрания, тренеру — задача перенести тренировку
  const due = (await sql(`select due_at from tasks where id = $1`, [call]))[0].due_at;
  assert.equal(new Date(due).getTime(), zoned(tomorrow, 725, 'Europe/Moscow').getTime());
  assert.equal((await sql(`select count(*)::int as n from tasks where assignee_id = $1 and title like 'Перенести: персональная тренировка%'`, [kim]))[0].n, 1);
  // В календаре каждого участника
  const members = await sql(`select mm.status, t.kind, t.title, u.login from staff_meeting_members mm join tasks t on t.id = mm.task_id join users u on u.id = mm.user_id where mm.meeting_id = $1`, [meet.id]);
  assert.ok(members.length >= 4);
  assert.ok(members.every((m) => m.kind === 'meeting' && /^Собрание «план на декабрь» — Переговорная/.test(m.title)));
  assert.equal(members.find((m) => m.login === 'a.bespalyy').status, 'confirmed');
  // Приглашение в мессенджер с кнопкой
  const inv = (await botMsgs('m.volkova')).find((m) => m.meta?.kind === 'meeting_invite')!;
  assert.match(inv.body, /Собрание: план на декабрь/);
  assert.match(inv.body, /Где: \*\*Переговорная\*\*/);
  assert.match(inv.body, /Ради собрания: звонок «Позвонить Иванову» 11:15 — сдвинуто на 12:05/);
  const vchat = (await req('POST', '/api/agent/chat', 'm.volkova')).json().id;
  const vm = (await req('GET', `/api/team/chats/${vchat}/messages`, 'm.volkova')).json().messages;
  assert.equal(vm.at(-1).meta.kind, 'meeting_invite');
  // Подтверждение: статус, кнопка меняется, организатору — сообщение
  const a = await req('POST', `/api/agent/meetings/${meet.id}/answer`, 'm.volkova', { answer: 'confirmed' });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal((await req('GET', `/api/team/chats/${vchat}/messages`, 'm.volkova')).json().messages.at(-1).meta.status, 'confirmed');
  assert.ok((await botMsgs('a.bespalyy')).some((m) => /✅ Мария Волкова подтвердил\(а\) участие в собрании «план на декабрь»/.test(m.body)));
  assert.equal((await req('POST', `/api/agent/meetings/${meet.id}/answer`, 'a.kim', { answer: 'declined' })).statusCode, 200);
  assert.equal((await req('POST', `/api/agent/meetings/${meet.id}/answer`, 'o.smirnov', { answer: 'confirmed' })).statusCode, 404);
  const st = await ask('кто подтвердил?');
  assert.match(st, /✅ Подтвердили \(2\): .*Мария Волкова/);
  assert.match(st, /❌ Не смогут \(1\): Артём Ким/);
  // Следующее собрание в то же время учитывает уже назначенное
  const again = await ask('Назначь собрание: отдел продаж, завтра с 11 до 12, на час, в Центре');
  assert.match(again, /собрание «план на декабрь» 11:00/);
  await ask('отмена');

  // За час до начала — напоминание тем, кто не ответил, и сводка организатору (один раз)
  await sql(`update staff_meetings set starts_at = now() + interval '50 minutes', ends_at = now() + interval '110 minutes' where id = $1`, [meet.id]);
  const run = () => withCtx(t.pool, { tenantId: centr.tenant_id, allClubs: true, clubIds: [] }, (db) => processMeetingReminders(db, centr.id));
  assert.equal(await run(), 1);
  assert.equal(await run(), 0);
  assert.ok((await botMsgs('a.bespalyy')).some((m) => /⏰ Через час собрание «план на декабрь». Подтвердили: Мария Волкова/.test(m.body)));
});

test('менеджер не назначает собрания, но видит свои; управляющему клуб не уточняется', async () => {
  assert.doesNotMatch(await ask('назначь собрание отдел продаж завтра', 'm.volkova'), /Лучшие варианты/);
  assert.match(await ask('мои собрания', 'm.volkova'), /план на декабрь/);
  const g = await ask('собери тренеров послезавтра с 10 до 12 на полчаса', 'o.smirnov');
  assert.match(g, /Лучшие варианты/);
  assert.match(g, /Артём Ким/);
  assert.doesNotMatch(g, /Полина Ершова/);
});
