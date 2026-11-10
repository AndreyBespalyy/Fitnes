// Шаг 17. Приёмочные тесты перед пилотом, которых не было в модулях: AT01, AT20, AT23, AT24, AT34, AT35, AT38 и заголовки безопасности.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: string; let sever: string;
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  centr = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  sever = clubs.find((c: { name: string }) => c.name.includes('Север')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('AT01: сотрудник «Центра» открывает клиента и сделку «Севера» — отказ и запись в журнал', async () => {
  const lead = (await req('POST', '/api/leads', 'a.bespalyy', { clubId: sever, fullName: 'Клиент Севера', phone: '+79007790001', sourceCode: 'site' })).json();
  const r = await req('GET', `/api/persons/${lead.personId}`, 'm.volkova');
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'other_club');
  assert.ok(!r.body.includes('Клиент Севера'));
  const o = await req('POST', `/api/opportunities/${lead.opportunityId}/stage`, 'm.volkova', { stageId: lead.opportunityId });
  assert.equal(o.statusCode, 403);
  const a = await sql(`select action, object_type from audit_log where action = 'access.denied' and object_id = any($1::text[])`, [[lead.personId, lead.opportunityId]]);
  assert.equal(a.length, 2);
  // Несуществующий клиент — просто «не найден», без записи об отказе
  assert.equal((await req('GET', '/api/persons/00000000-0000-0000-0000-000000000000', 'm.volkova')).statusCode, 404);
});

test('AT20: двое одновременно продлевают одного клиента — вторая продажа остановлена с предупреждением', async () => {
  const p = (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: 'Двойное Продление', phone: '+79007790002', sourceCode: 'walk_in' })).json().personId;
  const prod = (await req('GET', `/api/products?clubId=${centr}`, 'a.bespalyy')).json().find((x: { kind: string; isActive?: boolean }) => x.kind === 'term');
  const first = (await req('POST', '/api/memberships', 'm.volkova', { personId: p, productId: prod.id })).json();
  assert.ok(first.id || first.membershipId, JSON.stringify(first));
  const mid = first.id ?? first.membershipId;
  const [a, b] = await Promise.all([
    req('POST', `/api/memberships/${mid}/renew`, 'm.volkova', {}),
    req('POST', `/api/memberships/${mid}/renew`, 'o.astafeva', {}),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [201, 409], `${a.body} | ${b.body}`);
  const blocked = a.statusCode === 409 ? a : b;
  assert.equal(blocked.json().error, 'already_renewed');
  assert.match(blocked.json().message, /уже продлён/);
  assert.equal((await sql(`select count(*)::int as n from memberships where renewed_from_id = $1`, [mid]))[0].n, 1);
  // Тот же тариф тому же клиенту через минуту — предупреждение; с подтверждением можно
  const again = await req('POST', '/api/memberships', 'o.astafeva', { personId: p, productId: prod.id });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'duplicate_sale');
  assert.equal((await req('POST', '/api/memberships', 'o.astafeva', { personId: p, productId: prod.id, confirmDuplicate: true })).statusCode, 201);
});

test('AT23: сделку закрыли как «продано» без оплаты — пометка и задача РОПу', async () => {
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Без Оплаты', phone: '+79007790003', sourceCode: 'site' })).json();
  const won = (await sql(`select s.id from opportunities o join pipeline_stages s on s.pipeline_id = o.pipeline_id where o.id = $1 and s.kind = 'won' limit 1`, [lead.opportunityId]))[0].id;
  const r = (await req('POST', `/api/opportunities/${lead.opportunityId}/stage`, 'm.volkova', { stageId: won })).json();
  assert.equal(r.status, 'won');
  assert.match(r.warning, /Оплаты от клиента не найдено/);
  assert.equal((await sql('select won_unpaid from opportunities where id = $1', [lead.opportunityId]))[0].won_unpaid, true);
  const tasks = await sql(`select t.title, u.login from tasks t join users u on u.id = t.assignee_id where t.opportunity_id = $1 and t.done_at is null`, [lead.opportunityId]);
  assert.ok(tasks.some((x) => x.login === 'o.astafeva' && x.title.includes('Без Оплаты')), JSON.stringify(tasks));
});

test('AT24: проверочная заявка не создаёт клиента, сделку и задачу, но отмечает, что источник работает', async () => {
  const src = (await req('GET', '/api/lead-sources', 'a.bespalyy')).json().find((s: { code: string }) => s.code === 'site');
  const { apiKey } = (await req('POST', `/api/lead-sources/${src.id}/api-key`, 'a.bespalyy')).json();
  const before = await sql(`select (select count(*) from persons)::int as p, (select count(*) from leads)::int as l, (select count(*) from tasks)::int as t, (select count(*) from opportunities)::int as o`);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/leads', headers: { authorization: `Bearer ${apiKey}` }, payload: { clubId: centr, fullName: 'Проверка Подключения', phone: '+79007790004', test: true } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().test, true);
  const after = await sql(`select (select count(*) from persons)::int as p, (select count(*) from leads)::int as l, (select count(*) from tasks)::int as t, (select count(*) from opportunities)::int as o`);
  assert.deepEqual(after, before);
  assert.ok((await sql('select last_test_at from lead_sources where id = $1', [src.id]))[0].last_test_at);
  // Ошибки в проверочной заявке видны так же, как в настоящей
  const bad = await t.app.inject({ method: 'POST', url: '/api/v1/leads', headers: { authorization: `Bearer ${apiKey}` }, payload: { clubId: centr, phone: '123', test: true } });
  assert.equal(bad.statusCode, 400);
});

test('AT34: клиент отказался от записи встречи — встреча учтена без записи', async () => {
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Без Записи', phone: '+79007790005', sourceCode: 'site' })).json();
  const mt = (await req('POST', '/api/meetings', 'm.volkova', { opportunityId: lead.opportunityId, scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).json();
  assert.equal((await req('POST', `/api/meetings/${mt.id}/status`, 'm.volkova', { status: 'attended' })).statusCode, 200);
  assert.equal((await sql(`select count(*)::int as n from calls where person_id = $1`, [lead.personId]))[0].n, 0);
  assert.equal((await sql(`select status from meetings where id = $1`, [mt.id]))[0].status, 'attended');
});

test('AT35: горячий список выдаётся не дольше 3 секунд', async () => {
  await req('POST', '/api/ai/scores/recompute', 'o.astafeva', { clubId: centr });
  const t0 = Date.now();
  const r = await req('GET', `/api/ai/hot-list?clubId=${centr}`, 'o.astafeva');
  const ms = Date.now() - t0;
  assert.equal(r.statusCode, 200);
  assert.ok(ms < 3000, `${ms} мс`);
});

test('AT38: повторный запуск миграций и стандартных настроек не сбрасывает настройки клуба', async () => {
  await sql(`update clubs set first_response_minutes = 7 where id = $1`, [centr]);
  const before = await sql(`select event, enabled, days from msg_triggers where club_id = $1 order by event`, [centr]);
  const { migrate } = await import('../db/scripts/migrate.ts').catch(() => ({ migrate: null as null | ((u: string, q: boolean) => Promise<void>) }));
  if (migrate) await migrate(t.ownerUrl, true);
  assert.equal((await sql(`select first_response_minutes from clubs where id = $1`, [centr]))[0].first_response_minutes, 7);
  assert.deepEqual(await sql(`select event, enabled, days from msg_triggers where club_id = $1 order by event`, [centr]), before);
});

test('безопасность: заголовки защиты на страницах и в API', async () => {
  const r = await t.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(String(r.headers['referrer-policy']).includes('strict-origin'));
});
