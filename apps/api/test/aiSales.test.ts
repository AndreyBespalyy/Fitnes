import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { auc, trainLogistic } from '../src/modules/scoring.ts';
import { processScoring } from '../src/modules/aiSales.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string;
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const uid = async (l: string) => (await sql('select id from users where login = $1', [l]))[0].id as string;
let hot: { personId: string; opportunityId: string }; let refused: { personId: string };

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'i.zuev', 'e.orlova', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  c1 = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  // Горячий: ответили вовремя, был на встрече, проявил интерес
  hot = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Горячий Клиент', phone: '+79007770001', sourceCode: 'site' })).json();
  const task = (await sql(`select id from tasks where opportunity_id = $1`, [hot.opportunityId]))[0].id;
  await req('POST', `/api/tasks/${task}/complete`, 'm.volkova', { result: 'Связался', nextTask: { title: 'Встреча', dueAt: new Date(Date.now() + 86_400_000).toISOString(), kind: 'meeting' } });
  const mt = (await req('POST', '/api/meetings', 'm.volkova', { opportunityId: hot.opportunityId, scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).json();
  await req('POST', `/api/meetings/${mt.id}/status`, 'm.volkova', { status: 'attended' });
  // Отказался в разговоре — исключается из обзвона
  refused = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Сказал Нет', phone: '+79007770002', sourceCode: 'site' })).json();
  const tn = (await sql(`select tenant_id from clubs where id = $1`, [c1]))[0].tenant_id;
  const call = (await sql(`insert into calls(tenant_id, club_id, person_id, user_id, started_at, source, asr_status) values ($1,$2,$3,$4, now() - interval '1 hour', 'demo', 'done') returning id`,
    [tn, c1, refused.personId, await uid('m.volkova')]))[0].id;
  await sql(`insert into call_summaries(tenant_id, club_id, call_id, status, final) values ($1,$2,$3,'manual',$4)`, [tn, c1, call, JSON.stringify({ essence: 'Отказ', outcome: 'refused' })]);
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('обучение: логистическая регрессия различает классы, AUC считается верно', () => {
  let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const data = Array.from({ length: 400 }, () => { const a = rnd() < 0.5 ? 1 : 0; const b = rnd(); return { x: { a, b }, y: rnd() < (a ? 0.75 : 0.15) ? 1 : 0 }; });
  const m = trainLogistic(data, ['a', 'b'], { b: 0, w: {} });
  assert.ok(m.w.a > 1, `вес признака ${m.w.a}`);
  assert.ok(Math.abs(m.w.b) < 0.6);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  assert.equal(auc([0.5, 0.5], [1, 0]), 0.5);
});

test('оценка клиентов: приоритет с причинами, предложение по прейскуранту, исключение отказавшихся', async () => {
  assert.equal((await req('POST', '/api/ai/scores/recompute', 'm.volkova', { clubId: c1 })).statusCode, 403);
  const r = (await req('POST', '/api/ai/scores/recompute', 'o.astafeva', { clubId: c1 })).json();
  assert.ok(r.counts.purchase >= 2);
  assert.equal(r.model.version, 'rules-v1'); // в тестовой базе мало закрытых сделок
  assert.match(r.model.metrics.note, /Мало закрытых сделок/);
  const all = (await req('GET', `/api/ai/hot-list?clubId=${c1}&kind=purchase&segment=all`, 'o.astafeva')).json();
  assert.ok(all.ms < 3000);
  const h = all.rows.find((x: { personId: string }) => x.personId === hot.personId);
  const n = all.rows.find((x: { personId: string }) => x.personId === refused.personId);
  assert.equal(h.segment, 'hot');
  assert.ok(h.priority > 50, String(h.priority));
  assert.ok(h.reasons.some((x: { text: string; effect: string }) => x.effect === '+' && /встрече/.test(x.text)), JSON.stringify(h.reasons));
  assert.match(h.offer.text, /^Предложить «.+» за [\d\s ]+₽/);
  assert.match(h.phone, /\*\*\*/);
  assert.equal(n.segment, 'excluded');
  assert.equal(n.reasons[0].text, 'в последнем разговоре отказался');
  // По умолчанию в списке только горячие и тёплые
  const def = (await req('GET', `/api/ai/hot-list?clubId=${c1}`, 'o.astafeva')).json();
  assert.ok(def.rows.every((x: { segment: string }) => ['hot', 'warm'].includes(x.segment)));
  // Менеджер видит своих и общий список, чужих — нет
  const zuev = await uid('i.zuev');
  const mine = (await req('GET', `/api/ai/hot-list?segment=all`, 'm.volkova')).json();
  assert.ok(mine.rows.length > 0 && mine.rows.every((x: { ownerId: string | null }) => x.ownerId === null || x.ownerId === mine.rows.find((y: { ownerId: string | null }) => y.ownerId)?.ownerId));
  assert.ok(!mine.rows.some((x: { ownerId: string | null }) => x.ownerId === zuev));
  // Снимок дня для теневого режима
  assert.ok((await sql(`select count(*)::int as n from ai_score_history where club_id = $1 and person_id = $2`, [c1, hot.personId]))[0].n === 1);
  await processScoring(t.pool); // фоновый пересчёт: снимок дня не дублируется, модель обучена
  assert.equal((await sql(`select count(*)::int as n from ai_score_history where club_id = $1 and person_id = $2`, [c1, hot.personId]))[0].n, 1);
});

test('«взять в работу»: задача на звонок с предложением; отказавшегося взять нельзя', async () => {
  const r = await req('POST', '/api/ai/hot-list/take', 'm.volkova', { clubId: c1, personId: hot.personId, kind: 'purchase' });
  assert.equal(r.statusCode, 201, r.body);
  const task = (await sql(`select title, kind, opportunity_id, assignee_id from tasks where id = $1`, [r.json().taskId]))[0];
  assert.match(task.title, /^Позвонить: горячий клиент \(ИИ\)\. Предложить «/);
  assert.equal(task.opportunity_id, hot.opportunityId);
  assert.equal(task.kind, 'call');
  assert.equal((await req('POST', '/api/ai/hot-list/take', 'm.volkova', { clubId: c1, personId: refused.personId, kind: 'purchase' })).statusCode, 400);
  assert.equal((await req('POST', '/api/ai/hot-list/take', 'i.zuev', { clubId: c1, personId: hot.personId, kind: 'purchase' })).statusCode, 404);
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'ai.recommendation_taken'`))[0].n, 1);
});

test('план дня менеджера: что продать, сколько звонков, кому звонить первым, основание и уверенность', async () => {
  const m = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
  await req('PUT', '/api/plans', 'o.smirnov', { clubId: c1, month: m, club: { new: { amountKop: 30_000_000, avgCheckKop: 650_000 } }, managers: { [await uid('m.volkova')]: { new: { amountKop: 20_000_000 } } } });
  const d = (await req('GET', `/api/ai/day-plan?clubId=${c1}`, 'm.volkova')).json();
  assert.ok(d.needKop > 0);
  assert.ok(d.clients >= 1);
  assert.equal(d.needs[0].category, 'new');
  assert.ok(d.callFirst.some((r: { personId: string }) => r.personId === hot.personId));
  assert.ok(d.basis.length === 3 && /личный план месяца/.test(d.basis[0]));
  assert.ok(['низкая', 'средняя', 'высокая'].includes(d.confidence));
  assert.equal((await req('GET', `/api/ai/day-plan`, 'm.volkova')).statusCode, 400);
});

test('расчётный план продаж: только для тех, кто задаёт план; основание по каждой категории', async () => {
  const m = new Date(Date.now() + 35 * 86_400_000).toISOString().slice(0, 7);
  assert.equal((await req('GET', `/api/ai/plan-suggestion?clubId=${c1}&month=${m}`, 'm.volkova')).statusCode, 403);
  const s = (await req('GET', `/api/ai/plan-suggestion?clubId=${c1}&month=${m}`, 'o.smirnov')).json();
  assert.deepEqual(s.rows.map((r: { category: string }) => r.category), ['new', 'renewal', 'return']);
  assert.ok(s.rows.every((r: { basis: string[] }) => r.basis.length >= 1));
  assert.match(s.note, /ориентир, а не факт/);
  assert.equal(s.confidence, 'низкая'); // полных месяцев с продажами в тестовой базе нет
});

test('теневой режим: покупатель был в горячем списке; горячие против всех', async () => {
  const prod = (await sql(`select id from products where club_id = $1 and name = 'Месяц безлимит'`, [c1]))[0].id;
  assert.equal((await req('POST', '/api/memberships', 'm.volkova', { personId: hot.personId, productId: prod })).statusCode, 201);
  assert.equal((await req('GET', `/api/ai/shadow?clubId=${c1}`, 'm.volkova')).statusCode, 403);
  const s = (await req('GET', `/api/ai/shadow?clubId=${c1}`, 'o.astafeva')).json();
  assert.equal(s.days, 1);
  assert.equal(s.enough, false);
  assert.ok(s.buyers.bought >= 1 && s.buyers.listed >= 1 && s.buyers.hot >= 1);
  const hotSeg = s.lift.segments.find((x: { segment: string }) => x.segment === 'hot');
  assert.ok(hotSeg.won >= 1);
  assert.equal(s.lift.target, 2);
  assert.ok(s.lift.x === null || s.lift.x > 0);
});

test('автосообщение неприоритетным: появляется у настроенного клуба, предложение по прейскуранту', async () => {
  const list = (await req('GET', `/api/msg/triggers?clubId=${c1}`, 'o.smirnov')).json();
  const ai = list.find((x: { event: string }) => x.event === 'ai_nurture');
  assert.ok(ai, 'автосообщение ai_nurture создано');
  assert.equal(ai.enabled, false); // включает руководитель
  assert.equal(ai.marketing, true); // только клиентам с согласием на рассылки
  const auto = await sql(`select s.person_id from client_scores s where s.club_id = $1 and s.segment = 'auto' and s.kind in ('purchase', 'return')`, [c1]);
  const p = (await req('GET', `/api/msg/triggers/${ai.id}/preview`, 'o.smirnov')).json();
  assert.equal(p.ready.length + p.skipped.length, new Set(auto.map((a) => a.person_id)).size);
  if (p.ready.length) assert.match(p.ready[0].text, /можно оформить «.+» за [\d\s ]+₽/);
});

test('пороги светофора задаёт клуб', async () => {
  assert.equal((await req('PUT', '/api/kpi-norms', 'o.smirnov', { clubId: c1, light: { green: 80, yellow: 90 } })).statusCode, 400);
  assert.equal((await req('PUT', '/api/kpi-norms', 'o.astafeva', { clubId: c1, light: { green: 95, yellow: 70 } })).statusCode, 403);
  assert.equal((await req('PUT', '/api/kpi-norms', 'o.smirnov', { clubId: c1, light: { green: 95, yellow: 70 } })).statusCode, 200);
  assert.deepEqual((await req('GET', `/api/kpi-norms?clubId=${c1}`, 'm.volkova')).json().light, { green: 95, yellow: 70 });
});
