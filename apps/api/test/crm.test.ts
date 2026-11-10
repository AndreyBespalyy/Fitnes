import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let adm: Record<string, string>, mgr: Record<string, string>, rop: Record<string, string>, mgrSever: Record<string, string>;
let centr: { id: string }, sever: { id: string };
before(async () => {
  t = await setupTestApp();
  adm = (await login(t.app, 'i.kotova')).cookie!;
  mgr = (await login(t.app, 'm.volkova')).cookie!;
  rop = (await login(t.app, 'o.astafeva')).cookie!;
  mgrSever = (await login(t.app, 'i.zuev')).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: adm })).json();
  centr = clubs.find((c: { name: string }) => c.name === 'Клуб «Центр»');
  sever = clubs.find((c: { name: string }) => c.name === 'Клуб «Север»');
});
after(async () => { await t.app.close(); await t.pool.end(); });

const req = (method: string, url: string, cookies: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies, payload: payload as object });
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

test('у клубов есть готовые воронки по своей модели продаж', async () => {
  const c = (await req('GET', `/api/pipelines?clubId=${centr.id}`, adm)).json();
  const s = (await req('GET', `/api/pipelines?clubId=${sever.id}`, adm)).json();
  assert.ok(c.some((p: { name: string }) => p.name === 'Продление'));
  assert.ok(s.some((p: { name: string }) => p.name === 'Неуспешное списание'));
  assert.equal(c.find((p: { isDefaultForLeads: boolean }) => p.isDefaultForLeads).name, 'Новые клиенты');
});

test('новый клуб из мастера сразу получает воронки', async () => {
  const club = (await req('POST', '/api/clubs', adm, { name: 'Клуб «Тест»', salesModel: 'subscription' })).json();
  const p = (await req('GET', `/api/pipelines?clubId=${club.id}`, adm)).json();
  assert.equal(p.length, 4);
});

test('лид: создаётся клиент, сделка, назначение менеджеру и задача первого ответа', async () => {
  const r = await req('POST', '/api/leads', rop, { clubId: centr.id, fullName: 'Иван Новиков', phone: '8 (916) 123-45-67', sourceCode: 'site' });
  assert.equal(r.statusCode, 201);
  const lead = r.json();
  assert.equal(lead.duplicate, false);
  const tasks = (await req('GET', '/api/tasks', mgr)).json();
  const task = tasks.find((x: { personId: string }) => x.personId === lead.personId);
  assert.ok(task, 'задача первого ответа у менеджера');
  assert.equal(task.kind, 'first_response');
  const due = new Date(task.dueAt).getTime();
  assert.ok(Math.abs(due - Date.now() - 5 * 60_000) < 60_000, 'норма 5 минут');
});

test('без источника лид не создаётся', async () => {
  const r = await req('POST', '/api/leads', mgr, { clubId: centr.id, fullName: 'Без источника', phone: '+79160000001' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'source_required');
});

test('антидубль: тот же телефон в другом формате не создаёт второго клиента и вторую сделку', async () => {
  const a = (await req('POST', '/api/leads', mgr, { clubId: centr.id, fullName: 'Ольга Дубль', phone: '+7 926 555-11-22', sourceCode: 'telegram' })).json();
  const b = (await req('POST', '/api/leads', mgr, { clubId: centr.id, fullName: 'Ольга Д.', phone: '89265551122', sourceCode: 'site' })).json();
  assert.equal(b.duplicate, true);
  assert.equal(b.personId, a.personId);
  assert.equal(b.opportunityId, a.opportunityId);
  const card = (await req('GET', `/api/persons/${a.personId}`, mgr)).json();
  assert.equal(card.leads.length, 2, 'оба обращения сохранены');
  assert.equal(card.opportunities.length, 1);
});

test('антидубль по всей сети: клиент «Центра» обратился в «Север»', async () => {
  const a = (await req('POST', '/api/leads', mgr, { clubId: centr.id, fullName: 'Сетевой Клиент', phone: '+79035550000', sourceCode: 'site' })).json();
  const b = (await req('POST', '/api/leads', mgrSever, { clubId: sever.id, fullName: 'Сетевой', phone: '+79035550000', sourceCode: 'site' })).json();
  assert.equal(b.personId, a.personId);
  assert.equal(b.otherClub, true);
  assert.notEqual(b.opportunityId, a.opportunityId, 'в каждом клубе своя сделка');
  const card = await req('GET', `/api/persons/${a.personId}`, mgrSever);
  assert.equal(card.statusCode, 200, 'менеджер «Севера» видит карточку обратившегося клиента');
  assert.equal(card.json().opportunities.length, 1, 'но только сделку своего клуба');
});

test('нельзя закрыть задачу без следующего шага; с новой задачей можно, первый ответ отмечается', async () => {
  const lead = (await req('POST', '/api/leads', mgr, { clubId: centr.id, fullName: 'Шаг Проверка', phone: '+79161112233', sourceCode: 'site' })).json();
  const task = (await req('GET', '/api/tasks', mgr)).json().find((x: { personId: string }) => x.personId === lead.personId);
  const bad = await req('POST', `/api/tasks/${task.id}/complete`, mgr, { result: 'Дозвонился' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'next_task_required');
  const ok = await req('POST', `/api/tasks/${task.id}/complete`, mgr, { result: 'Дозвонился', nextTask: { title: 'Перезвонить', dueAt: inAnHour() } });
  assert.equal(ok.statusCode, 200);
  const leads = (await req('GET', `/api/leads?clubId=${centr.id}`, rop)).json();
  assert.equal(leads.find((l: { personId: string }) => l.personId === lead.personId).responseState, 'in_time');
});

test('движение по воронке: отказ требует причину, выигрыш закрывает задачи', async () => {
  const lead = (await req('POST', '/api/leads', mgr, { clubId: centr.id, fullName: 'Воронка Тест', phone: '+79162223344', sourceCode: 'site' })).json();
  const card = (await req('GET', `/api/persons/${lead.personId}`, mgr)).json();
  const opp = card.opportunities[0];
  const stage = (name: string) => opp.stages.find((s: { name: string }) => s.name === name).id;
  assert.equal((await req('POST', `/api/opportunities/${opp.id}/stage`, mgr, { stageId: stage('Встреча назначена') })).statusCode, 200);
  const lost = await req('POST', `/api/opportunities/${opp.id}/stage`, mgr, { stageId: stage('Отказ') });
  assert.equal(lost.json().error, 'lost_reason_required');
  await req('POST', '/api/meetings', mgr, { opportunityId: opp.id, scheduledAt: inAnHour() });
  const won = await req('POST', `/api/opportunities/${opp.id}/stage`, mgr, { stageId: stage('Купил') });
  assert.equal(won.json().status, 'won');
  const after = (await req('GET', `/api/persons/${lead.personId}`, mgr)).json();
  // Остаётся только контрольная задача РОПу «продано без оплаты» (AT23)
  assert.ok(after.tasks.every((x: { doneAt: string | null; title: string }) => x.doneAt || x.title.startsWith('Проверить: сделка')), 'открытых задач менеджера не осталось');
  assert.ok(after.history.length >= 3, 'история этапов');
});

test('менеджер видит только свои сделки, РОП — все сделки клуба', async () => {
  const pipes = (await req('GET', `/api/pipelines?clubId=${centr.id}`, rop)).json();
  const pid = pipes.find((p: { isDefaultForLeads: boolean }) => p.isDefaultForLeads).id;
  const all = (await req('GET', `/api/opportunities?pipelineId=${pid}`, rop)).json();
  const mine = (await req('GET', `/api/opportunities?pipelineId=${pid}`, mgr)).json();
  assert.ok(all.length >= mine.length);
  assert.ok(mine.every((o: { ownerName: string }) => o.ownerName === 'Мария Волкова'));
});

test('администратор настраивает цепочку этапов', async () => {
  const created = await req('POST', '/api/pipelines', adm, { clubId: centr.id, name: 'Корпоративные клиенты', stages: [
    { name: 'Заявка', kind: 'open' }, { name: 'Коммерческое предложение', kind: 'open' }, { name: 'Договор', kind: 'won' }, { name: 'Отказ', kind: 'lost' }] });
  assert.equal(created.statusCode, 201);
  const p = created.json();
  assert.equal(p.stages.length, 4);
  const noWon = await req('PUT', `/api/pipelines/${p.id}/stages`, adm, { stages: [{ name: 'A', kind: 'open' }, { name: 'B', kind: 'open' }, { name: 'C', kind: 'lost' }] });
  assert.equal(noWon.statusCode, 400);
  const stages = [...p.stages.map((s: { id: string; name: string; kind: string }) => ({ id: s.id, name: s.name, kind: s.kind }))];
  stages.splice(2, 0, { name: 'Переговоры', kind: 'open' });
  stages[0].name = 'Входящая заявка';
  const upd = (await req('PUT', `/api/pipelines/${p.id}/stages`, adm, { stages })).json();
  assert.deepEqual(upd.stages.map((s: { name: string }) => s.name), ['Входящая заявка', 'Коммерческое предложение', 'Переговоры', 'Договор', 'Отказ']);
  assert.equal((await req('POST', '/api/pipelines', mgr, { clubId: centr.id, name: 'X', stages })).statusCode, 403, 'менеджер не настраивает воронки');
});

test('этап с открытыми сделками удалить нельзя', async () => {
  const pipes = (await req('GET', `/api/pipelines?clubId=${centr.id}`, adm)).json();
  const p = pipes.find((x: { isDefaultForLeads: boolean }) => x.isDefaultForLeads);
  const used = p.stages.find((s: { openCount: number }) => s.openCount > 0);
  const stages = p.stages.filter((s: { id: string }) => s.id !== used.id).map((s: { id: string; name: string; kind: string }) => ({ id: s.id, name: s.name, kind: s.kind }));
  const r = await req('PUT', `/api/pipelines/${p.id}/stages`, adm, { stages });
  assert.equal(r.statusCode, 400);
});

test('заявка через API источника: по ключу, повтор с тем же номером события не дублирует', async () => {
  const sources = (await req('GET', '/api/lead-sources', adm)).json();
  const site = sources.find((s: { code: string }) => s.code === 'site');
  const { apiKey } = (await req('POST', `/api/lead-sources/${site.id}/api-key`, adm)).json();
  const send = () => t.app.inject({ method: 'POST', url: '/api/v1/leads', headers: { authorization: `Bearer ${apiKey}` },
    payload: { clubId: sever.id, fullName: 'С Сайта', phone: '+79998887766', externalEventId: 'form-42', utm: { utm_source: 'yandex' } } });
  const first = await send();
  assert.equal(first.statusCode, 201);
  const again = await send();
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().leadId, first.json().leadId);
  const wrong = await t.app.inject({ method: 'POST', url: '/api/v1/leads', headers: { authorization: 'Bearer nope' }, payload: {} });
  assert.equal(wrong.statusCode, 401);
});

test('ресепшн может создать лид, но не видит сделки', async () => {
  const desk = (await login(t.app, 'd.lis')).cookie!;
  assert.equal((await req('POST', '/api/leads', desk, { clubId: centr.id, fullName: 'Гость Ресепшн', phone: '+79163334455', sourceCode: 'walk_in' })).statusCode, 201);
  assert.equal((await req('GET', '/api/tasks', desk)).statusCode, 403);
});

test('норму первого ответа меняет администратор', async () => {
  const r = await req('PATCH', `/api/clubs/${centr.id}`, adm, { firstResponseMinutes: 10 });
  assert.equal(r.json().firstResponseMinutes, 10);
  assert.equal((await req('PATCH', `/api/clubs/${centr.id}`, adm, { firstResponseMinutes: 0 })).statusCode, 400);
  await req('PATCH', `/api/clubs/${centr.id}`, adm, { firstResponseMinutes: 5 });
});
