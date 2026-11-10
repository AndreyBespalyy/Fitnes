// Шаг 18, часть 2. Версии настроек клуба: AT08, AT09, AT10, AT39, наборы под тип клуба, откат, стандарт продаж по версиям.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { parseRequest, fieldsFor, DEFAULT_CHECKLIST } from '../src/modules/config.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let centr: string;
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const live = async () => (await req('GET', `/api/config?clubId=${centr}`, 'o.smirnov')).json().live;

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('разбор просьбы словами: типовые фразы', () => {
  const fields = fieldsFor(['birthday', 'inactive', 'membership_ending', 'debt_overdue', 'welcome']);
  const cur = { club: { firstResponseMinutes: 5 }, sales: { items: DEFAULT_CHECKLIST }, messaging: { triggers: {} } };
  const r = parseRequest('Срок первого ответа 10 минут, норма звонков 50 в день. Жёлтый порог 80%. Включи поздравление с днём рождения; давно не были — через 21 день. Заморозка до 60 дней в год и не больше 3 раз', cur, fields);
  const m = Object.fromEntries(r.changes.map((c) => [c.path, c.value]));
  assert.equal(m['club.firstResponseMinutes'], 10);
  assert.equal(m['kpi.norms.calls'], 50);
  assert.equal(m['kpi.lightYellow'], 80);
  assert.equal(m['messaging.triggers.birthday.enabled'], true);
  assert.equal(m['messaging.triggers.inactive.days'], 21);
  assert.equal(m['membership.freezeMaxDaysPerYear'], 60);
  assert.equal(m['membership.freezeMaxTimesPerYear'], 3);
  const c = parseRequest('Норма звонков 45. Добавь в чек-лист пункт «Предложил пробную тренировку»', cur, fields);
  const cm = Object.fromEntries(c.changes.map((x) => [x.path, x.value]));
  assert.equal((cm['sales.items'] as unknown[]).length, DEFAULT_CHECKLIST.length + 1);
  assert.equal(cm['kpi.norms.calls'], 45);
  assert.equal(parseRequest('сделай как в премиальном наборе', cur, fields).preset, 'premium');
  assert.ok(parseRequest('покрась кнопки в синий', cur, fields).changes.length === 0);
});

test('AT08: ИИ предлагает изменение — рабочие настройки не меняются, пока человек не утвердил и не опубликовал', async () => {
  const before = await live();
  const r = await req('POST', '/api/config/assistant', 'o.astafeva', { clubId: centr, text: 'срок первого ответа 12 минут, норма звонков 55' });
  assert.equal(r.statusCode, 201, r.body);
  const a = r.json();
  assert.equal(a.understood, true);
  assert.deepEqual(a.diff.map((d: { path: string }) => d.path).sort(), ['club.firstResponseMinutes', 'kpi.norms.calls']);
  assert.deepEqual(await live(), before);
  assert.equal((await sql('select first_response_minutes from clubs where id = $1', [centr]))[0].first_response_minutes, before.club.firstResponseMinutes);
  // РОП может предложить, но не утвердить; без проверки утвердить нельзя даже управляющему
  assert.equal((await req('POST', `/api/config/versions/${a.versionId}/approve`, 'o.astafeva')).statusCode, 403);
  assert.equal((await req('POST', `/api/config/versions/${a.versionId}/approve`, 'o.smirnov')).json().error, 'check_required');
  assert.equal((await req('POST', `/api/config/versions/${a.versionId}/publish`, 'o.smirnov')).json().error, 'approval_required');
  const ch = (await req('POST', `/api/config/versions/${a.versionId}/check`, 'o.astafeva')).json();
  assert.equal(ch.ok, true, JSON.stringify(ch));
  assert.ok(ch.history.some((h: { path: string }) => h.path === 'club.firstResponseMinutes'));
  assert.equal((await req('POST', `/api/config/versions/${a.versionId}/approve`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('POST', `/api/config/versions/${a.versionId}/publish`, 'o.smirnov')).statusCode, 200);
  const after = await live();
  assert.equal(after.club.firstResponseMinutes, 12);
  assert.equal(after.kpi.norms.calls, 55);
  const log = await sql(`select action from audit_log where object_id = $1 order by at`, [a.versionId]);
  assert.deepEqual(log.map((x) => x.action), ['config.ai_proposed', 'config.approved', 'config.published']);
});

test('AT09: после утверждения ИИ поменял черновик — нужно новое утверждение (и в базе тоже)', async () => {
  const d = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, changes: [{ path: 'membership.renewalReminderDays', value: 21 }] })).json();
  await req('POST', `/api/config/versions/${d.id}/check`, 'o.smirnov');
  assert.equal((await req('POST', `/api/config/versions/${d.id}/approve`, 'o.smirnov')).statusCode, 200);
  const r = (await req('POST', '/api/config/assistant', 'o.astafeva', { clubId: centr, versionId: d.id, text: 'и рассрочку до 6 платежей' })).json();
  assert.equal(r.status, 'draft');
  const p = await req('POST', `/api/config/versions/${d.id}/publish`, 'o.smirnov');
  assert.equal(p.json().error, 'approval_required');
  assert.equal((await live()).membership.renewalReminderDays, 14);
  // Обойти через базу тоже нельзя: правка утверждённого снимает утверждение, публикация без него — ошибка
  const d2 = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, changes: [{ path: 'membership.renewalReminderDays', value: 20 }] })).json();
  await req('POST', `/api/config/versions/${d2.id}/check`, 'o.smirnov');
  await req('POST', `/api/config/versions/${d2.id}/approve`, 'o.smirnov');
  await sql(`update config_versions set data = jsonb_set(data, '{membership,renewalReminderDays}', '45') where id = $1`, [d2.id]);
  assert.equal((await sql('select status, approved_hash from config_versions where id = $1', [d2.id]))[0].status, 'draft');
  await assert.rejects(sql(`update config_versions set status = 'published' where id = $1`, [d2.id]), /без утверждения/);
  // Повторное утверждение после проверки — и публикуется именно новое содержимое
  await req('POST', `/api/config/versions/${d.id}/check`, 'o.smirnov');
  assert.equal((await req('POST', `/api/config/versions/${d.id}/approve`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('POST', `/api/config/versions/${d.id}/publish`, 'o.smirnov')).statusCode, 200);
  const l = await live();
  assert.equal(l.membership.renewalReminderDays, 21);
  assert.equal(l.membership.installmentsMaxPayments, 6);
});

test('AT10: новая версия ломает проверку — публикация заблокирована, рабочая версия остаётся', async () => {
  const before = await live();
  const d = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, changes: [{ path: 'kpi.lightYellow', value: 120 }, { path: 'kpi.lightGreen', value: 100 }] })).json();
  const ch = (await req('POST', `/api/config/versions/${d.id}/check`, 'o.smirnov')).json();
  assert.equal(ch.ok, false);
  assert.ok(ch.items.find((i: { code: string }) => i.code === 'data').details.some((x: string) => x.includes('жёлтый порог')));
  assert.equal((await req('POST', `/api/config/versions/${d.id}/approve`, 'o.smirnov')).json().error, 'checks_failed');
  // Утверждено, а потом рабочие настройки поменяли напрямую: при публикации проверка ловит расхождение
  const d2 = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, changes: [{ path: 'messaging.maxAutoPerWeek', value: 3 }] })).json();
  await req('POST', `/api/config/versions/${d2.id}/check`, 'o.smirnov');
  await req('POST', `/api/config/versions/${d2.id}/approve`, 'o.smirnov');
  await sql('update club_msg_settings set max_auto_per_week = 4 where club_id = $1', [centr]);
  const p = await req('POST', `/api/config/versions/${d2.id}/publish`, 'o.smirnov');
  assert.equal(p.statusCode, 409);
  assert.equal(p.json().checks.items.find((i: { code: string }) => i.code === 'drift').ok, false);
  const after = await live();
  assert.equal(after.messaging.maxAutoPerWeek, 4);
  assert.equal(after.kpi.lightYellow, before.kpi.lightYellow);
  assert.equal((await sql('select status from config_versions where id = $1', [d2.id]))[0].status, 'approved');
});

test('AT39: новое правило сначала проверяется на истории, результат виден до включения', async () => {
  const r = (await req('POST', '/api/config/backtest', 'o.astafeva', { clubId: centr, changes: [{ path: 'messaging.triggers.inactive.enabled', value: true }, { path: 'messaging.triggers.inactive.days', value: 10 }] })).json();
  const bt = r.find((x: { path: string }) => x.path === 'messaging.triggers.inactive');
  assert.ok(bt, JSON.stringify(r));
  assert.match(bt.summary, /последние 30 дней: \d+ сообщ\. \d+ клиентам/);
  // Проверка черновика включает тот же расчёт, и без него утверждение невозможно
  const d = (await req('POST', '/api/config/versions', 'o.astafeva', { clubId: centr, changes: [{ path: 'messaging.triggers.inactive.enabled', value: true }] })).json();
  const ch = (await req('POST', `/api/config/versions/${d.id}/check`, 'o.astafeva')).json();
  assert.ok(ch.history.some((h: { path: string; summary: string }) => h.path === 'messaging.triggers.inactive' && /30 дней/.test(h.summary)));
  assert.equal((await sql(`select enabled from msg_triggers where club_id = $1 and event = 'inactive'`, [centr]))[0].enabled, false);
});

test('наборы под тип клуба, история настройки и откат к прошлой версии', async () => {
  const before = await live();
  const d = (await req('POST', '/api/config/versions', 'o.smirnov', { clubId: centr, preset: 'studio' })).json();
  assert.ok(d.diff.some((x: { path: string }) => x.path === 'membership.installmentsEnabled'));
  await req('POST', `/api/config/versions/${d.id}/check`, 'o.smirnov');
  assert.equal((await req('POST', `/api/config/versions/${d.id}/approve`, 'o.smirnov')).statusCode, 200);
  assert.equal((await req('POST', `/api/config/versions/${d.id}/publish`, 'o.smirnov')).statusCode, 200);
  const s = await live();
  assert.equal(s.club.firstResponseMinutes, 15);
  assert.equal(s.membership.installmentsEnabled, false);
  assert.equal(s.sales.items.length, 4);
  const h = (await req('GET', `/api/config/history?clubId=${centr}&path=club.firstResponseMinutes`, 'o.smirnov')).json();
  assert.ok(h.length >= 2);
  assert.equal(h[h.length - 1].to, 15);
  // Откат к исходным настройкам клуба (версия 0)
  const initial = (await sql(`select id from config_versions where club_id = $1 and number = 0`, [centr]))[0];
  assert.ok(initial);
  const rb = await req('POST', `/api/config/versions/${initial.id}/rollback`, 'o.smirnov');
  assert.equal(rb.statusCode, 200, rb.body);
  const back = await live();
  assert.equal(back.club.firstResponseMinutes, 5);
  assert.equal(back.membership.installmentsEnabled, true);
  const init = (await sql('select data from config_versions where id = $1', [initial.id]))[0].data;
  assert.equal(back.messaging.maxAutoPerWeek, init.messaging.maxAutoPerWeek);
  assert.notEqual(before.messaging.maxAutoPerWeek, init.messaging.maxAutoPerWeek);
  // Прошлое не переписывается: опубликованную версию изменить нельзя
  await assert.rejects(sql(`update config_versions set data = '{}' where id = $1`, [d.id]), /уже не черновик/);
  // Менеджер не видит конструктор настроек
  assert.equal((await req('GET', `/api/config?clubId=${centr}`, 'm.volkova')).statusCode, 403);
});

test('стандарт продаж версионируется: прошлая версия действует для прошлых звонков', async () => {
  const std = (await req('GET', `/api/sales-standards?clubId=${centr}`, 'o.astafeva')).json();
  assert.ok(std.length >= 2, JSON.stringify(std.map((s: { versionNo: number }) => s.versionNo)));
  assert.notDeepEqual(std[0].items, std[1].items);
  await assert.rejects(sql(`update sales_standards set items = '[]' where id = $1`, [std[1].id]), /не меняется/);
  const { standardAt } = await import('../src/modules/config.ts');
  const c = new pg.Client(t.ownerUrl); await c.connect();
  try {
    const old = await standardAt(c as never, centr, new Date(Date.now() - 365 * 864e5));
    assert.equal(old.versionNo, 0);
    assert.equal((await standardAt(c as never, centr, new Date())).versionNo, std[0].versionNo);
  } finally { await c.end(); }
});
