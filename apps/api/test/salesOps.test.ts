// Отдел продаж: «Беру в работу» и сигналы по заявкам, окно продлений, новички, стоп-лист, теги, дубли, списки обзвона, воронка, сводки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { processLeadSla, processSalesOpsClub } from '../src/modules/salesOps.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = '';
let products: { id: string; name: string }[] = [];
let n = 0;
const sys = () => ({ tenantId: tenant, allClubs: true, clubIds: [] as string[] });
const today = async () => (await sql(`select to_char(now() at time zone timezone, 'YYYY-MM-DD') as d from clubs where id = $1`, [centr]))[0].d as string;

async function lead(name = `Клиент Продаж ${++n}`) {
  const r = await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: name, phone: `+7900777${String(++n).padStart(4, '0')}`, sourceCode: 'walk_in' });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { leadId: string; personId: string; opportunityId: string };
}
async function sell(personId: string, opts: { startedDaysAgo?: number; endsInDays?: number; product?: string } = {}) {
  const s = await req('POST', '/api/memberships', 'm.volkova', { personId, productId: products.find((p) => p.name === (opts.product ?? 'Месяц безлимит'))!.id });
  assert.equal(s.statusCode, 201, s.body);
  const id = s.json().id as string;
  if (opts.startedDaysAgo) await sql(`update memberships set starts_on = starts_on - $2::int, ends_on = ends_on - $2::int, created_at = created_at - make_interval(days => $2::int) where id = $1`, [id, opts.startedDaysAgo]);
  if (opts.endsInDays !== undefined) await sql(`update memberships set ends_on = current_date + $2::int where id = $1`, [id, opts.endsInDays]);
  return id;
}
const visits = async (personId: string, k: number, from = 1) => { for (let i = 0; i < k; i++) await sql(`insert into visits(tenant_id, club_id, person_id, visited_at) values ($1,$2,$3, now() - make_interval(days => $4::int))`, [tenant, centr, personId, from + i]); };
/** Сдвигает заявку в прошлое на min минут */
const age = (leadId: string, min: number) => sql(`update leads set created_at = created_at - make_interval(mins => $2), first_response_due_at = first_response_due_at - make_interval(mins => $2) where id = $1`, [leadId, min]);

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'i.zuev']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
  tenant = (await sql('select tenant_id from clubs where id = $1', [centr]))[0].tenant_id;
  products = (await req('GET', `/api/products?clubId=${centr}`, 'm.volkova')).json();
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('заявка: через 5 минут — напоминание, через 15 — сигнал РОПу с задачей; «Беру в работу» останавливает', async () => {
  // Уведомления приходят в CRM (колокольчик): смотрим их через API от лица сотрудника
  const notes = async (login: string) => (await req('GET', '/api/notifications', login)).json() as { items: { id: string; kind: string; title: string; body: string; link: { tab: string; p?: { view?: string } } }[]; unread: number };
  await sql(`delete from staff_notifications`);
  await sql(`update leads set taken_at = now()`); // заявки из тестовых данных уже в работе
  const a = await lead();
  const b = await lead();
  const run = () => withCtx(t.pool, sys(), (db) => processLeadSla(db, { tenantId: tenant, userId: null }, centr));
  assert.deepEqual(await run(), { reminded: 0, escalated: 0 });
  await age(a.leadId, 6); await age(b.leadId, 6);
  // b взяли в работу — по нему сигналов нет
  const tk = await req('POST', `/api/sales-ops/leads/${b.leadId}/take`, 'm.volkova');
  assert.equal(tk.statusCode, 200, tk.body);
  assert.equal(tk.json().already, false);
  assert.equal((await req('POST', `/api/sales-ops/leads/${b.leadId}/take`, 'm.volkova')).json().already, true);
  assert.deepEqual(await run(), { reminded: 1, escalated: 0 });
  const mv = await notes('m.volkova');
  const rem = mv.items.find((x) => x.kind === 'lead_remind');
  assert.ok(rem && /ждёт 6 мин/.test(rem.title), JSON.stringify(mv));
  assert.deepEqual(rem!.link, { tab: 'sales', p: { view: 'leads' } });
  assert.ok(mv.unread >= 1);
  assert.deepEqual(await run(), { reminded: 0, escalated: 0 }, 'повторно не напоминаем');
  await age(a.leadId, 10);
  assert.deepEqual(await run(), { reminded: 0, escalated: 1 });
  const rop = await notes('o.astafeva');
  assert.ok(rop.items.some((x) => x.kind === 'lead_escalate' && /16 мин без ответа/.test(x.title)), JSON.stringify(rop));
  assert.ok(!(await notes('m.volkova')).items.some((x) => x.kind === 'lead_escalate'), 'сигнал РОПу менеджеру не виден');
  // Прочитано: счётчик обнуляется, чужие уведомления не трогаются
  assert.equal((await req('POST', '/api/notifications/read', 'm.volkova', { ids: [rem!.id] })).statusCode, 200);
  assert.equal((await notes('m.volkova')).unread, mv.unread - 1);
  await req('POST', '/api/notifications/read', 'm.volkova', {});
  assert.equal((await notes('m.volkova')).unread, 0);
  assert.ok((await notes('o.astafeva')).unread >= 1);
  const task = await sql(`select t.title, u.login from tasks t join users u on u.id = t.assignee_id where t.lead_id = $1 and t.kind = 'other'`, [a.leadId]);
  assert.equal(task.length, 1);
  assert.equal(task[0].login, 'o.astafeva');

  // Экран заявок: ждёт одна, за день две, одна в норме, одна просрочена и ушла РОПу
  const scr = await req('GET', `/api/sales-ops/leads?clubId=${centr}`, 'o.astafeva');
  assert.equal(scr.statusCode, 200, scr.body);
  const d = scr.json();
  assert.ok(d.waiting.some((w: { id: string; escalated: boolean }) => w.id === a.leadId && w.escalated));
  assert.ok(!d.waiting.some((w: { id: string }) => w.id === b.leadId));
  assert.ok(d.speed.total.total >= 2);
  assert.ok(d.speed.total.escalated >= 1);
  assert.ok(d.speed.total.late >= 2, 'b взяли через 6 минут — тоже дольше нормы');
  // Тренер заявки не видит
  assert.equal((await req('GET', `/api/sales-ops/leads?clubId=${centr}`, 'i.zuev')).statusCode, 400, 'чужой клуб');
});

test('окно продлений: кто заканчивается и не продлил; продлил — пропал; отметка «звонили»', async () => {
  const x = await lead(); const y = await lead(); const z = await lead();
  const mx = await sell(x.personId, { startedDaysAgo: 20, endsInDays: 10 });
  await sell(y.personId, { startedDaysAgo: 20, endsInDays: 12 });
  await sell(z.personId, { startedDaysAgo: 5, endsInDays: 200 });
  const r1 = (await req('GET', `/api/sales-ops/renewals?clubId=${centr}`, 'o.astafeva')).json();
  const has = (r: { list: { personId: string }[] }, id: string) => r.list.some((m) => m.personId === id);
  assert.ok(has(r1, x.personId) && has(r1, y.personId));
  assert.ok(!has(r1, z.personId));
  assert.equal(r1.list.find((m: { personId: string }) => m.personId === x.personId).called, false);
  // y продлил
  const ren = await req('POST', '/api/memberships', 'm.volkova', { personId: y.personId, productId: products.find((p) => p.name === 'Месяц безлимит')!.id, renewFromId: (await sql('select id from memberships where person_id = $1', [y.personId]))[0].id });
  assert.equal(ren.statusCode, 201, ren.body);
  // x звонили
  await sql(`insert into tasks(tenant_id, club_id, person_id, kind, title, due_at, done_at) values ($1,$2,$3,'call','Продление', now(), now())`, [tenant, centr, x.personId]);
  const r2 = (await req('GET', `/api/sales-ops/renewals?clubId=${centr}`, 'o.astafeva')).json();
  assert.ok(!has(r2, y.personId));
  assert.equal(r2.list.find((m: { personId: string }) => m.personId === x.personId).called, true);
  assert.ok(mx);
});

test('новички за 45 дней с меньше чем 4 визитами в первый месяц', async () => {
  const lazy = await lead(); const ok = await lead(); const old = await lead();
  await sell(lazy.personId, { startedDaysAgo: 35 }); await visits(lazy.personId, 2, 6);
  await sell(ok.personId, { startedDaysAgo: 35 }); await visits(ok.personId, 5, 6);
  await sell(old.personId, { startedDaysAgo: 60 });
  const r = (await req('GET', `/api/sales-ops/newbies?clubId=${centr}`, 'o.astafeva')).json();
  const ids = r.list.map((x: { personId: string }) => x.personId);
  assert.ok(ids.includes(lazy.personId));
  assert.ok(!ids.includes(ok.personId));
  assert.ok(!ids.includes(old.personId));
  const row = r.list.find((x: { personId: string }) => x.personId === lazy.personId);
  assert.equal(row.visits, 2);
  assert.equal(row.firstMonthOver, true);
});

test('стоп-лист и теги: причина, «отложено до», снятие; автотеги и свои', async () => {
  const p = await lead();
  const bad = await req('PUT', `/api/persons/${p.personId}/call-block`, 'm.volkova', { reason: 'postponed' });
  assert.equal(bad.statusCode, 400, 'нужна дата');
  assert.equal((await req('PUT', `/api/persons/${p.personId}/call-block`, 'm.volkova', { reason: 'do_not_call', comment: 'попросил' })).statusCode, 200);
  let fl = (await req('GET', `/api/persons/${p.personId}/call-flags`, 'm.volkova')).json();
  assert.equal(fl.block.reason, 'do_not_call');
  assert.equal(fl.block.title, 'Просил не звонить');
  // Повторная отметка заменяет прежнюю
  assert.equal((await req('PUT', `/api/persons/${p.personId}/call-block`, 'm.volkova', { reason: 'postponed', until: '2099-01-01' })).statusCode, 200);
  assert.equal((await sql('select count(*)::int as n from person_call_blocks where person_id = $1 and removed_at is null', [p.personId]))[0].n, 1);
  const lists = async () => (await req('GET', `/api/sales-ops/call-lists?clubId=${centr}`, 'o.astafeva')).json();
  const inLists = (l: { managers: { blocks: Record<string, { rows: { personId: string }[] }> }[] }, id: string) =>
    l.managers.some((m) => Object.values(m.blocks).some((b) => b.rows.some((r) => r.personId === id)));
  let l = await lists();
  assert.ok(!inLists(l, p.personId));
  assert.ok(l.excluded['Отложено до даты'] >= 1);
  // «Отложено» с прошедшей датой — снова в обзвоне
  await sql(`update person_call_blocks set until = current_date - 1 where person_id = $1`, [p.personId]);
  l = await lists();
  assert.ok(inLists(l, p.personId));
  assert.equal((await req('DELETE', `/api/persons/${p.personId}/call-block`, 'm.volkova')).statusCode, 200);
  fl = (await req('GET', `/api/persons/${p.personId}/call-flags`, 'm.volkova')).json();
  assert.equal(fl.block, null);

  assert.equal((await req('POST', `/api/persons/${p.personId}/tags`, 'm.volkova', { tag: '  Утро  ' })).statusCode, 200);
  assert.equal((await req('POST', `/api/persons/${p.personId}/tags`, 'm.volkova', { tag: 'новичок' })).statusCode, 400, 'автотег руками не ставится');
  const rc = await req('POST', '/api/sales-ops/tags/recompute', 'o.astafeva', { clubId: centr });
  assert.equal(rc.statusCode, 200, rc.body);
  fl = (await req('GET', `/api/persons/${p.personId}/call-flags`, 'm.volkova')).json();
  const tags = fl.tags.map((x: { tag: string }) => x.tag);
  assert.ok(tags.includes('утро'));
  assert.ok(tags.includes('лид'));
  assert.ok(tags.includes('ни рубля'));
  // Пересчёт не трогает свои теги
  await req('POST', '/api/sales-ops/tags/recompute', 'o.astafeva', { clubId: centr });
  assert.ok((await req('GET', `/api/persons/${p.personId}/call-flags`, 'm.volkova')).json().tags.some((x: { tag: string }) => x.tag === 'утро'));
  assert.equal((await req('DELETE', `/api/persons/${p.personId}/tags/${encodeURIComponent('утро')}`, 'm.volkova')).statusCode, 200);
  const blocks = (await req('GET', `/api/sales-ops/blocks?clubId=${centr}`, 'o.astafeva'));
  assert.equal(blocks.statusCode, 200, blocks.body);
  assert.equal((await req('GET', `/api/sales-ops/blocks?clubId=${centr}`, 'm.volkova')).statusCode, 403);
});

test('списки обзвона: новые, продления, база, «ни рубля»; менеджер видит только свой; выгрузка Excel', async () => {
  const fresh = await lead();
  const ending = await lead(); await sell(ending.personId, { startedDaysAgo: 20, endsInDays: 7 });
  const former = await lead(); await sell(former.personId, { startedDaysAgo: 100 }); await visits(former.personId, 5, 70);
  const lowVisits = await lead(); await sell(lowVisits.personId, { startedDaysAgo: 100 }); await visits(lowVisits.personId, 1, 70);
  // Бывший клиент заплатил: продажа в тестах идёт в долг, отметим оплату
  await sql(`insert into payments(tenant_id, club_id, direction, kind, amount_kop, method, person_id) values ($1,$2,'in','charge',300000,'cash',$3)`, [tenant, centr, former.personId]);
  await sql(`update opportunities set status = 'won' where person_id = any($1)`, [[ending.personId, former.personId, lowVisits.personId]]);
  const r = await req('GET', `/api/sales-ops/call-lists?clubId=${centr}`, 'o.astafeva');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  const blockOf = (id: string) => { for (const m of d.managers) for (const [k, b] of Object.entries(m.blocks as Record<string, { rows: { personId: string }[] }>)) if (b.rows.some((x) => x.personId === id)) return k; return null; };
  assert.equal(blockOf(fresh.personId), 'new');
  assert.equal(blockOf(ending.personId), 'renewal');
  assert.equal(blockOf(former.personId), 'base');
  assert.equal(blockOf(lowVisits.personId), null, 'член клуба с 0–2 посещениями не идёт в обзвон');
  assert.ok(d.excluded['Член клуба с 0–2 посещениями'] >= 1);
  assert.ok(d.zero, 'РОП видит «ни рубля»');
  // Менеджер видит только свой список
  const m = (await req('GET', `/api/sales-ops/call-lists?clubId=${centr}`, 'm.volkova')).json();
  assert.equal(m.managers.length, 1);
  assert.equal(m.zero, null);
  const ex = await req('GET', `/api/sales-ops/call-lists/export?clubId=${centr}&who=${d.managers[0].id}`, 'o.astafeva');
  assert.equal(ex.statusCode, 200, ex.body);
  assert.match(String(ex.headers['content-type']), /spreadsheetml/);
  assert.equal((await req('GET', `/api/sales-ops/call-lists/export?clubId=${centr}&who=zero`, 'm.volkova')).statusCode, 400);
  assert.equal((await req('GET', `/api/sales-ops/call-lists/export?clubId=${centr}&who=zero&format=csv`, 'o.astafeva')).statusCode, 200);
});

test('дубли: находятся по ФИО и дате рождения, склейка переносит историю, «разные люди» убирает пару', async () => {
  const a = await lead('Дублев Иван Петрович'); const b = await lead('Дублев Иван Петрович');
  await sql(`update persons set birth_date = '1990-05-05' where id = any($1)`, [[a.personId, b.personId]]);
  const mb = await sell(b.personId); await visits(b.personId, 3);
  const pairs = (await req('GET', `/api/sales-ops/duplicates?clubId=${centr}`, 'o.astafeva')).json().pairs;
  const pair = pairs.find((p: { main: { id: string }; dup: { id: string } }) => [p.main.id, p.dup.id].sort().join() === [a.personId, b.personId].sort().join());
  assert.ok(pair, JSON.stringify(pairs));
  assert.equal(pair.main.id, b.personId, 'основная — та, где больше истории');
  assert.equal((await req('POST', '/api/sales-ops/merge', 'm.volkova', { mainId: b.personId, dupId: a.personId })).statusCode, 403);
  const mg = await req('POST', '/api/sales-ops/merge', 'o.astafeva', { mainId: b.personId, dupId: a.personId });
  assert.equal(mg.statusCode, 200, mg.body);
  assert.equal((await sql('select merged_into_id from persons where id = $1', [a.personId]))[0].merged_into_id, b.personId);
  assert.equal((await sql('select count(*)::int as n from opportunities where person_id = $1', [b.personId]))[0].n, 2, 'сделка дубля перенесена');
  assert.equal((await sql('select person_id from memberships where id = $1', [mb]))[0].person_id, b.personId);
  assert.equal((await sql('select count(*)::int as n from person_contacts where person_id = $1 and type = $2', [b.personId, 'phone']))[0].n, 2, 'оба телефона на основной карточке');
  assert.equal((await req('POST', '/api/sales-ops/merge', 'o.astafeva', { mainId: b.personId, dupId: a.personId })).statusCode, 400, 'повторно нельзя');

  const c = await lead('Разнов Пётр'); const e = await lead('Разнов Пётр');
  await sql(`update persons set birth_date = '1985-01-01' where id = any($1)`, [[c.personId, e.personId]]);
  assert.equal((await req('POST', '/api/sales-ops/not-duplicate', 'o.astafeva', { a: c.personId, b: e.personId })).statusCode, 200);
  const after = (await req('GET', `/api/sales-ops/duplicates?clubId=${centr}`, 'o.astafeva')).json().pairs;
  assert.ok(!after.some((p: { main: { id: string }; dup: { id: string } }) => [p.main.id, p.dup.id].includes(c.personId)));
});

test('воронка «где теряем»: шаги накопительные, по каналам; источник; сводки уходят один раз', async () => {
  const r = await req('GET', `/api/sales-ops/funnel?clubId=${centr}`, 'o.astafeva');
  assert.equal(r.statusCode, 200, r.body);
  const f = r.json();
  const st = f.total.steps;
  assert.equal(st.length, 5);
  assert.ok(st[0].count >= 10);
  for (let i = 1; i < 5; i++) assert.ok(st[i].count <= st[i - 1].count, `шаг ${i} не больше предыдущего`);
  assert.ok(st[4].count >= 1, 'продажи этого месяца видны');
  assert.ok(f.groups.length >= 1);
  assert.equal((await req('GET', `/api/sales-ops/funnel?clubId=${centr}&by=manager`, 'o.astafeva')).statusCode, 200);
  assert.equal((await req('GET', `/api/sales-ops/funnel?clubId=${centr}`, 'm.volkova')).statusCode, 403);
  const pv = (await req('GET', `/api/sales-ops/digest-preview?clubId=${centr}&kind=weekly`, 'o.smirnov')).json();
  assert.match(pv.text, /Обращений: \d+/);
  assert.match((await req('GET', `/api/sales-ops/digest-preview?clubId=${centr}&kind=marketing`, 'o.smirnov')).json().text, /маркетинг за/);

  const noteCount = async () => Number((await sql(`select count(*) as n from staff_notifications where club_id = $1 and kind in ('lead_daily', 'marketing')`, [centr]))[0].n);
  const day = await today();
  const c = { id: centr, today: day, h: 21, m: 0, dow: 1 };
  await withCtx(t.pool, sys(), (db) => processSalesOpsClub(db, { tenantId: tenant, userId: null }, c));
  const kinds = (await sql('select kind from sales_ops_sent where club_id = $1 and period = $2 order by kind', [centr, day])).map((x) => x.kind);
  assert.deepEqual(kinds, ['lead_daily', 'marketing']);
  const n1 = await noteCount();
  assert.ok(n1 >= 2);
  const sm = (await req('GET', '/api/notifications', 'o.smirnov')).json();
  assert.ok(sm.items.some((x: { kind: string; title: string }) => x.kind === 'marketing' && /маркетинг за/.test(x.title)), 'управляющему — маркетинг');
  await withCtx(t.pool, sys(), (db) => processSalesOpsClub(db, { tenantId: tenant, userId: null }, c));
  assert.equal(await noteCount(), n1, 'второй раз не отправляем');
});

test('настройки: управляющий меняет нормы; РОП не может; сигнал РОПу позже напоминания', async () => {
  assert.equal((await req('PUT', '/api/sales-ops/settings', 'o.astafeva', { clubId: centr, remindMinutes: 3 })).statusCode, 403);
  assert.equal((await req('PUT', '/api/sales-ops/settings', 'o.smirnov', { clubId: centr, remindMinutes: 20, escalateMinutes: 10 })).statusCode, 400);
  const ok = await req('PUT', '/api/sales-ops/settings', 'o.smirnov', { clubId: centr, remindMinutes: 3, escalateMinutes: 10, newbieMinVisits: 6 });
  assert.equal(ok.statusCode, 200, ok.body);
  const s = (await req('GET', `/api/sales-ops/settings?clubId=${centr}`, 'm.volkova')).json();
  assert.equal(s.settings.remindMinutes, 3);
  assert.equal(s.settings.newbieMinVisits, 6);
  assert.equal(s.canManage, false);
});
