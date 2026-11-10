// Шаг 18, часть 3. AT27, AT30, AT31, AT32, AT36 и обзоры менеджеров.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { checkPlanAlert, evaluateDueRecommendations } from '../src/modules/insights.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: string; let ids: Record<string, string> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const asOwner = async <T>(fn: (c: pg.Client) => Promise<T>) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
let today = ''; let tenant = '';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  ids = Object.fromEntries((await sql(`select login, id from users`)).map((r) => [r.login, r.id]));
  const r = (await sql(`select to_char(now() at time zone timezone, 'YYYY-MM-DD') as d, tenant_id from clubs where id = $1`, [centr]))[0];
  today = r.d; tenant = r.tenant_id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

let n = 0;
async function paidSale(who = 'm.volkova', product = 'Месяц безлимит') {
  const personId = (await req('POST', '/api/leads', who, { clubId: centr, fullName: `Аналитика Клиент ${++n}`, phone: `+7900555${String(n).padStart(4, '0')}`, sourceCode: 'walk_in' })).json().personId;
  const p = (await req('GET', `/api/products?clubId=${centr}`, 'd.lis')).json().find((x: { name: string }) => x.name === product);
  const s = (await req('POST', '/api/memberships', who, { personId, productId: p.id })).json();
  const ch = (await sql(`select id from charges where membership_id = $1 order by due_on limit 1`, [s.id]))[0].id;
  assert.equal((await req('POST', `/api/charges/${ch}/mark-paid`, 'd.lis', { method: 'card_terminal' })).statusCode, 200);
  return { personId, membershipId: s.id as string };
}

test('AT36: цифра плана раскрывается до клиентов и показывает, кто может закрыть дефицит', async () => {
  const s = await paidSale();
  const d = (await req('GET', `/api/plan/drill?clubId=${centr}&category=new`, 'o.astafeva')).json();
  assert.ok(d.sales.some((x: { personId: string; seller: string }) => x.personId === s.personId && x.seller.includes('Волкова')), JSON.stringify(d.sales));
  assert.ok(d.totalKop > 0);
  assert.ok(Array.isArray(d.candidates));
  // Менеджер видит только свои продажи
  const mine = (await req('GET', `/api/plan/drill?clubId=${centr}&userId=${ids['o.astafeva']}`, 'm.volkova')).json();
  assert.ok(mine.sales.every((x: { seller: string }) => x.seller.includes('Волкова')));
});

test('AT30: дефицит плана виден заранее (не позднее 20-го) с рекомендациями, руководителям ставится задача', async () => {
  const month = today.slice(0, 7);
  assert.equal((await req('PUT', '/api/plans', 'o.smirnov', { clubId: centr, month, club: { new: { amountKop: 900_000_000, avgCheckKop: 650_000 }, renewal: { amountKop: 300_000_000 } } })).statusCode, 200);
  const f = (await req('GET', `/api/plan/forecast?clubId=${centr}`, 'o.astafeva')).json();
  assert.ok(f.total.deficitKop > 0);
  assert.ok(f.recommendations.length >= 1);
  assert.match(f.recommendations[0], /не хватит/);
  assert.ok(f.basis.includes('Прогноз'));
  // Проверка 15-го числа: предупреждение создаётся один раз
  const mid = `${month}-15`;
  const first = await asOwner((c) => checkPlanAlert(c as never, tenant, centr, mid));
  assert.ok(first);
  assert.equal(await asOwner((c) => checkPlanAlert(c as never, tenant, centr, mid)), null);
  const tasks = await sql(`select u.login from tasks t join users u on u.id = t.assignee_id where t.club_id = $1 and t.title like 'Прогноз плана:%'`, [centr]);
  assert.ok(tasks.some((x) => x.login === 'o.astafeva') && tasks.some((x) => x.login === 'o.smirnov'), JSON.stringify(tasks));
  // До 10-го прогноз ещё шумный — предупреждения нет
  assert.equal(await asOwner((c) => checkPlanAlert(c as never, tenant, centr, `${month}-05`)), null);
});

test('AT31: невыполненная рекомендация видна РОПу и в обратной связи менеджера', async () => {
  const r = await req('POST', '/api/recommendations', 'o.astafeva', { clubId: centr, userId: ids['m.volkova'], title: 'Делать 100 звонков в день', metric: 'calls', target: 100, days: 3 });
  assert.equal(r.statusCode, 201, r.body);
  const id = r.json().id;
  assert.equal((await req('POST', '/api/recommendations', 'm.volkova', { clubId: centr, userId: ids['m.volkova'], title: 'x', metric: 'calls' })).statusCode, 403);
  assert.equal((await req('POST', `/api/recommendations/${id}/mark`, 'm.volkova', { mark: 'failed' })).statusCode, 400);
  assert.equal((await req('POST', `/api/recommendations/${id}/mark`, 'o.smirnov', { mark: 'done' })).statusCode, 403);
  assert.equal((await req('POST', `/api/recommendations/${id}/mark`, 'm.volkova', { mark: 'failed', comment: 'Весь день на встречах' })).statusCode, 200);
  // Срок прошёл: система сама сверяет показатель
  await sql(`update recommendations set starts_on = $2::date - 3, due_on = $2::date - 1 where id = $1`, [id, today]);
  await asOwner((c) => evaluateDueRecommendations(c as never, centr, today));
  const rop = (await req('GET', `/api/recommendations?clubId=${centr}`, 'o.astafeva')).json().find((x: { id: string }) => x.id === id);
  assert.equal(rop.status, 'not_done');
  assert.equal(rop.userMark, 'failed');
  assert.equal(rop.userComment, 'Весь день на встречах');
  assert.equal(typeof rop.result, 'number');
  const task = await sql(`select title from tasks where assignee_id = $1 and title like 'Рекомендация не выполнена%'`, [ids['o.astafeva']]);
  assert.equal(task.length, 1);
  // Менеджер видит свои рекомендации и только их
  const mine = (await req('GET', `/api/recommendations?clubId=${centr}`, 'm.volkova')).json();
  assert.ok(mine.length >= 1 && mine.every((x: { userId: string }) => x.userId === ids['m.volkova']));
});

test('AT32: стандарт продаж поменяли — старые оценки звонков остались по своей версии', async () => {
  const mkCall = async (daysAgo: number) => (await sql(`insert into calls(tenant_id, club_id, user_id, started_at, source, asr_status, duration_sec) values ($1,$2,$3, now() - make_interval(days => $4), 'upload', 'done', 120) returning id`,
    [tenant, centr, ids['m.volkova'], daysAgo]))[0].id as string;
  const old = await mkCall(3);
  const e0 = (await req('GET', `/api/calls/${old}/evaluation`, 'o.astafeva')).json();
  assert.equal(e0.standard.versionNo, 0);
  const items = e0.standard.items.map((i: { id: string }, k: number) => ({ id: i.id, ok: k % 2 === 0 }));
  const s0 = (await req('POST', `/api/calls/${old}/evaluation`, 'o.astafeva', { items })).json();
  assert.equal(s0.standardVersion, 0);
  assert.equal((await req('POST', `/api/calls/${old}/evaluation`, 'm.volkova', { items })).statusCode, 403);
  // Публикуем новый стандарт из двух пунктов
  const d = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, changes: [{ path: 'sales.items', value: [{ id: 'a', text: 'Назвал цену', weight: 1 }, { id: 'b', text: 'Записал на визит', weight: 1 }] }] })).json();
  await req('POST', `/api/config/versions/${d.id}/check`, 'o.smirnov');
  assert.equal((await req('POST', `/api/config/versions/${d.id}/approve`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('POST', `/api/config/versions/${d.id}/publish`, 'o.smirnov')).statusCode, 200);
  const fresh = await mkCall(0);
  const e1 = (await req('GET', `/api/calls/${fresh}/evaluation`, 'o.astafeva')).json();
  assert.equal(e1.standard.versionNo, 1);
  assert.equal(e1.standard.items.length, 2);
  // Старый звонок по-прежнему по версии 0, оценка та же; переоценка тоже идёт по версии 0
  const again = (await req('GET', `/api/calls/${old}/evaluation`, 'o.astafeva')).json();
  assert.equal(again.evaluations[0].standardVersion, 0);
  assert.equal(again.evaluations[0].score, s0.score);
  assert.equal((await req('POST', `/api/calls/${old}/evaluation`, 'o.astafeva', { items })).json().standardVersion, 0);
  await assert.rejects(sql(`update call_evaluations set standard_version = 1 where call_id = $1`, [old]), /версии стандарта/);
  const q = (await req('GET', `/api/quality?clubId=${centr}`, 'o.astafeva')).json();
  assert.ok(q.byUser.some((u: { userId: string; n: number }) => u.userId === ids['m.volkova'] && u.n >= 1));
});

test('обзор менеджера: показатели, сравнение с отделом, сильные и слабые места, рекомендации с данными и уверенностью', async () => {
  const r = await req('GET', `/api/reviews?clubId=${centr}&period=week`, 'm.volkova');
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json();
  assert.equal(v.user.id, ids['m.volkova']);
  assert.equal(v.metrics.length, 9);
  assert.ok(v.basis.includes('Данные'));
  assert.ok(typeof v.confidence === 'string');
  assert.ok(Array.isArray(v.recommendations));
  assert.equal((await req('GET', `/api/reviews?clubId=${centr}&userId=${ids['o.astafeva']}`, 'm.volkova')).statusCode, 403);
  const m = (await req('GET', `/api/reviews?clubId=${centr}&userId=${ids['m.volkova']}&period=month`, 'o.astafeva')).json();
  assert.ok(m.weaknesses.length >= 1, JSON.stringify(m.weaknesses));
  const team = (await req('GET', `/api/reviews/team?clubId=${centr}`, 'o.astafeva')).json();
  assert.ok(team.rows.some((x: { userId: string }) => x.userId === ids['m.volkova']));
  assert.equal((await req('GET', `/api/reviews/team?clubId=${centr}`, 'm.volkova')).statusCode, 403);
});

test('AT27: заявка, когда ответственного нет на смене, — дежурному или на начало смены', async () => {
  const tomorrow = (await sql(`select to_char((now() at time zone 'Europe/Moscow')::date + 1, 'YYYY-MM-DD') as d`))[0].d;
  // Ольга на смене весь день, Мария — завтра с 9:00
  const s1 = await req('POST', '/api/staff-time/shifts', 'o.smirnov', { clubId: centr, userId: ids['o.astafeva'], days: [today], starts: '00:00', ends: '23:59' });
  assert.equal(s1.statusCode, 201, s1.body);
  await req('POST', '/api/staff-time/shifts', 'o.smirnov', { clubId: centr, userId: ids['m.volkova'], days: [tomorrow], starts: '09:00', ends: '18:00' });
  const a = (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: 'Поздняя Заявка', phone: '+79005559001', sourceCode: 'site' })).json();
  const ta = (await sql(`select u.login from tasks t join users u on u.id = t.assignee_id where t.lead_id = $1`, [a.leadId]))[0];
  assert.equal(ta.login, 'o.astafeva');
  // Дежурного нет — срок переносится на начало смены Марии
  await sql(`delete from staff_shifts where user_id = $1`, [ids['o.astafeva']]);
  const b = (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: 'Ночная Заявка', phone: '+79005559002', sourceCode: 'site' })).json();
  const tb = (await sql(`select u.login, t.title, to_char(t.due_at at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') as due from tasks t join users u on u.id = t.assignee_id where t.lead_id = $1`, [b.leadId]))[0];
  assert.equal(tb.login, 'm.volkova');
  assert.equal(tb.due, `${tomorrow} 09:05`);
  assert.match(tb.title, /нерабочее время/);
  // Без графика в клубе всё как раньше
  await sql(`delete from staff_shifts`);
  const c = (await req('POST', '/api/leads', 'd.lis', { clubId: centr, fullName: 'Обычная Заявка', phone: '+79005559003', sourceCode: 'site' })).json();
  const tc = (await sql(`select t.title, t.due_at - t.created_at < interval '10 minutes' as soon from tasks t where t.lead_id = $1`, [c.leadId]))[0];
  assert.equal(tc.soon, true);
  assert.doesNotMatch(tc.title, /нерабочее/);
});
