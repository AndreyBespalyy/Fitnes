// «Коротко о ситуации» схемой: лента событий по времени, «сейчас», алгоритм с развилками; для процесса — шаги со статусами.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';
import { situationFlow } from '../src/modules/agentFlow.ts';
import type { Facts } from '../src/modules/agent.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });

before(async () => {
  t = await setupTestApp();
  for (const l of ['o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

const now = new Date('2026-11-15T12:00:00Z');
const d = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const facts = (): Facts => ({
  now: now.toISOString(), timezone: 'Europe/Moscow', clubName: 'Центр', target: { type: 'opportunity', id: 'x' },
  task: { title: 'Перезвонить по цене', kind: 'звонок', dueAt: d(30), doneAt: null, result: null, overdueHours: 30, assignee: 'Мария Волкова', createdAt: d(100) },
  person: { id: 'p', name: 'Ия Схемова', segment: 'лид', since: d(200), homeClub: 'Центр' },
  opportunity: { id: 'o', pipeline: 'Продажи', stage: 'Встреча', status: 'в работе', owner: 'Мария Волкова', amountExpected: null, createdAt: d(200), lostReason: null, daysInStage: 9,
    stageHistory: [{ at: d(190), from: 'Новая', to: 'Встреча', actor: 'Мария Волкова', comment: null }] },
  tasks: [{ title: 'Перезвонить по цене', kind: 'звонок', dueAt: d(30), doneAt: null, result: null, assignee: 'Мария Волкова', overdue: true }],
  leads: [{ at: d(200), source: 'Сайт', comment: 'Хочу абонемент', firstResponseMin: 40 }],
  meetings: [],
  calls: [{ at: d(150), direction: 'исходящий', manager: 'Мария Волкова', durationSec: 120, essence: 'Интересуется годовым', need: null, objections: ['дорого'], agreements: null, outcome: 'думает', nextStep: 'Прислать цены', transcript: null }],
  clientMessages: [{ at: d(2), from: 'клиент', text: 'А скидка будет?' }], waitingReplySince: d(2),
  memberships: [], debts: [], visits: { last: null, last30: 0, recent: [] }, classes: [], team: [], observations: [],
});

test('схема ситуации: события по порядку, срочное первым, развилки, итог в конце', () => {
  const f = situationFlow(facts());
  assert.equal(f.head, 'Ия Схемова · сделка «Продажи» · задача «Перезвонить по цене»');
  assert.deepEqual(f.history.map((e) => e.kind), ['lead', 'stage', 'call', 'message']);
  assert.equal(f.history[0].title, 'Обращение — Сайт');
  assert.equal(f.history[0].bad, true); // ответили через 40 мин
  assert.match(f.now, /^Этап «Встреча» \(в работе\) — 9 дней/);
  assert.equal(f.steps[0].title, 'Ответьте клиенту в переписке');
  assert.equal(f.steps[0].urgent, true);
  assert.equal(f.steps[1].title, 'Выполните задачу «Перезвонить по цене»');
  assert.deepEqual(f.steps[1].branches?.map((b) => b.when), ['не дозвонились', 'клиент просит перенести']);
  assert.ok(f.steps.some((s) => s.title === 'Проверьте договорённость из последнего разговора' && /Прислать цены/.test(s.detail ?? '')));
  assert.ok(f.steps.some((s) => s.title === 'Решите судьбу сделки на этапе «Встреча»'));
  assert.ok(f.steps.some((s) => s.title === 'Подготовьте ответы на возражения'));
  assert.equal(f.steps.at(-1)!.title, 'Запишите итог');
  assert.ok(f.steps.length <= 7);
});

test('ответ сервера: схема для сделки и для процесса (шаги со статусами)', async () => {
  const centr = (await req('GET', '/api/clubs', 'o.smirnov')).json();
  const clubId = (centr.items ?? centr).find((c: { name: string }) => /Центр/.test(c.name)).id;
  const l = await req('POST', '/api/leads', 'm.volkova', { clubId, fullName: 'Роман Схемов', phone: '+79008880011', sourceCode: 'walk_in' });
  const b = (await req('GET', `/api/agent/brief/opportunity/${l.json().opportunityId}`, 'm.volkova')).json();
  assert.ok(b.flow, 'нет схемы');
  assert.equal(b.flow.history[0].kind, 'lead');
  assert.equal(b.flow.steps.at(-1).title, 'Запишите итог');
  assert.ok(b.text.length > 0); // текст остаётся на вкладке «Текстом»
  const p = await req('POST', '/api/processes', 'o.smirnov', { clubId, title: 'Проверка схемы', personId: l.json().personId, steps: [{ title: 'Позвонить клиенту', role: 'manager', hours: 2 }, { title: 'Пригласить на пробное', role: 'manager', hours: 24 }] });
  assert.equal(p.statusCode, 200, p.body);
  const pb = (await req('GET', `/api/agent/brief/process/${p.json().id}?force=1`, 'o.smirnov')).json();
  assert.deepEqual(pb.flow.stages.map((s: { status: string }) => s.status), ['active', 'pending']);
  assert.equal(pb.flow.steps[0].title, 'Выполните шаг «Позвонить клиенту»');
  assert.match(pb.flow.steps[0].branches[0].then, /запустит «Пригласить на пробное»/);
  assert.match(pb.flow.now, /^Выполнено 0 из 2, сейчас: «Позвонить клиенту»/);
});

test('кто работал с клиентом: участники по убыванию участия, события помечены сотрудником', () => {
  const f = facts();
  f.classes = [{ at: d(20), name: 'Йога', kind: 'group', trial: false, trainer: 'Полина Ершова', room: null, club: 'Центр', status: 'пришёл', lateCancel: false } as Facts['classes'][number]];
  const flow = situationFlow(f);
  assert.equal(flow.people?.[0].name, 'Мария Волкова');
  assert.ok(flow.people?.[0].did.includes('ответственный по сделке'));
  assert.ok(flow.people?.some((p) => p.name === 'Полина Ершова' && p.did.includes('занятия как тренер: 1')));
  assert.deepEqual(flow.history.find((e) => e.kind === 'call')?.who, ['Мария Волкова']);
});

test('«Коротко о ситуации» из карточки клиента', async () => {
  const centr = (await req('GET', '/api/clubs', 'o.smirnov')).json();
  const clubId = (centr.items ?? centr).find((c: { name: string }) => /Центр/.test(c.name)).id;
  const l = (await req('POST', '/api/leads', 'm.volkova', { clubId, fullName: 'Пётр Карточкин', phone: '+79008880022', sourceCode: 'walk_in' })).json();
  const r = await req('GET', `/api/agent/brief/person/${l.personId}`, 'm.volkova');
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.match(b.flow.head, /Пётр Карточкин/);
  assert.equal(b.flow.personId, l.personId);
  assert.ok(Array.isArray(b.flow.people));
  assert.ok(b.text.length > 0);
  // Повторный запрос берётся из кэша
  assert.equal((await req('GET', `/api/agent/brief/person/${l.personId}`, 'm.volkova')).json().cached, true);
});
