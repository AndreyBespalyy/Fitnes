// Роль «Технический администратор» (18.11.2026): полный доступ к технической части, но без клиентов и финансов.
// Главная проверка — обход всех GET-адресов сервера под техадмином: ни в одном ответе нет ФИО и телефонов клиентов и денежных сумм.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const TA = 't.sokolov';

before(async () => {
  t = await setupTestApp();
  for (const l of ['a.bespalyy', TA, 'o.smirnov', 'i.kotova']) ck[l] = (await login(t.app, l)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

/** Все GET-адреса из исходников модулей */
function getRoutes() {
  const dir = join(import.meta.dirname, '../src/modules');
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/app\.get\(\s*[`'](\/api\/[^`']+)[`']/g)) out.add(m[1]);
  }
  return [...out].sort();
}

// Цены прейскуранта и настройки (стоимость балла) публичны — это не финансовые показатели; ищем выручку, платежи, долги, зарплаты
const MONEY_KEY = /^(?!price|pointValue|minPrice|maxPrice|oldPrice)\w*(kop|rub|amount|revenue|balance|salary|payout|cash|income|expense|profit)$|^(sum|total)$/i;

// Прейскурант, предложения сайта и пороги уровней лояльности — настройки, которые видит любой сотрудник (и клиенты на сайте)
const PRICE_LIST = ['/api/products', '/api/site/offers', '/api/loyalty/settings'];

function findMoney(v: unknown, path = ''): string | null {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = findMoney(v[i], `${path}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEY.test(k) && typeof x === 'number' && x !== 0) return `${path}.${k}=${x}`;
      const r = findMoney(x, `${path}.${k}`); if (r) return r;
    }
  }
  return null;
}

test('обход всех GET-адресов: техадмин не видит клиентов и денег', async () => {
  const persons = await sql(`select p.id, p.full_name, (select c.normalized_value from person_contacts c where c.person_id = p.id and c.type = 'phone' limit 1) as phone from persons p`);
  assert.ok(persons.length > 5);
  const names = persons.map((p) => p.full_name as string);
  const phones = persons.map((p) => String(p.phone ?? '').replace(/\D/g, '')).filter((p) => p.length >= 10);
  const ids: Record<string, string> = {
    clubId: (await sql(`select id from clubs order by name limit 1`))[0].id,
    personId: persons[0].id,
  };
  const leaks: string[] = [];
  const opened: string[] = [];
  for (const route of getRoutes()) {
    if (route.includes('/hooks/') || route.includes('/public/') || route.includes('/pocketkey/:id/:token') || route.includes('/gw/')) continue;
    let url = route.replace(':clubId', ids.clubId);
    if (/\/persons\/:id/.test(url)) url = url.replace(':id', ids.personId);
    url = url.replace(/:[a-zA-Z]+/g, '00000000-0000-0000-0000-000000000000');
    const sep = url.includes('?') ? '&' : '?';
    const res = await req('GET', `${url}${sep}clubId=${ids.clubId}&from=2020-01-01&to=2030-12-31&period=month&q=${encodeURIComponent(names[0].split(' ')[0])}`, TA);
    if (res.statusCode >= 400) continue;
    opened.push(route);
    const body = res.body;
    const name = names.find((n) => body.includes(n));
    const phone = phones.find((p) => body.replace(/\D/g, '').includes(p));
    let money: string | null = null;
    try { money = findMoney(JSON.parse(body)); } catch { /* не JSON */ }
    if (name) leaks.push(`${route}: клиент «${name}»`);
    if (phone) leaks.push(`${route}: телефон клиента`);
    if (money && !PRICE_LIST.includes(route)) leaks.push(`${route}: сумма ${money}`);
  }
  console.log(`Открыто техадмину: ${opened.length}\n${opened.join('\n')}`);
  assert.deepEqual(leaks, []);
});

test('виджеты рабочего стола: техадмину не открывается ни один денежный или клиентский', async () => {
  const src = readFileSync(join(import.meta.dirname, '../src/modules/dash.ts'), 'utf8');
  const widgets = [...src.matchAll(/\{ id: '([a-z_]+)', title: '[^']+', description: '[^']*', perm: (P\.\w+)/g)].map((m) => ({ id: m[1], perm: m[2] }));
  assert.ok(widgets.length > 5);
  const club = (await sql(`select id from clubs order by name limit 1`))[0].id;
  for (const w of widgets) {
    const r = await req('GET', `/api/dash/widget/${w.id}?clubId=${club}`, TA);
    assert.notEqual(r.statusCode, 200, `виджет ${w.id} (${w.perm}) открылся техадмину`);
  }
});

test('техадмин не может завести себе финансиста, управляющего, менеджера и не может сбросить им пароль', async () => {
  const club = (await sql(`select id from clubs order by name limit 1`))[0].id;
  for (const role of ['fin', 'gm', 'rop', 'manager', 'desk', 'trainer', 'owner', 'admin']) {
    const r = await req('POST', '/api/staff', TA, { fullName: `Проверка ${role}`, role, clubId: club });
    assert.equal(r.statusCode, 403, `${role}: ${r.body}`);
  }
  // Свою же роль и другую техническую — можно
  const ok = await req('POST', '/api/staff', TA, { fullName: 'Второй Техник', role: 'techadmin' });
  assert.equal(ok.statusCode, 201, ok.body);
  // Список ролей подсказывает, какие можно выдать
  const roles = (await req('GET', '/api/roles', TA)).json() as { code: string; canAssign: boolean }[];
  assert.deepEqual(roles.filter((r) => r.canAssign).map((r) => r.code), ['techadmin']);
  // Чужие учётные записи с доступом к клиентам и деньгам: ни пароля, ни блокировки, ни сеансов
  for (const login of ['e.orlova', 'o.smirnov', 'm.volkova', 'a.kim']) {
    const id = (await sql(`select id from users where login = $1`, [login]))[0].id;
    for (const path of ['reset-password', 'block']) {
      const r = await req('POST', `/api/staff/${id}/${path}`, TA);
      assert.equal(r.statusCode, 403, `${login} ${path}: ${r.body}`);
    }
    assert.equal((await req('GET', `/api/staff/${id}/sessions`, TA)).statusCode, 403);
  }
  // Массовая выдача паролей пропускает тех, кем техадмин управлять не может
  const fin = (await sql(`select id from users where login = 'e.orlova'`))[0].id;
  const bulk = await req('POST', '/api/security/login/reset', TA, { userIds: [fin, ok.json().user.id] });
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.deepEqual(bulk.json().issued.map((x: { id: string }) => x.id), [ok.json().user.id]);
  // Собственник по-прежнему может всё; управляющий — сотрудников своего клуба
  const byOwner = await req('POST', '/api/staff', 'a.bespalyy', { fullName: 'Новый Финансист', role: 'fin', clubId: club });
  assert.equal(byOwner.statusCode, 201, byOwner.body);
  const centr = (await sql(`select id from clubs where name like '%Центр%'`))[0].id;
  const byGm = await req('POST', '/api/staff', 'o.smirnov', { fullName: 'Новый Менеджер', role: 'manager', clubId: centr });
  assert.equal(byGm.statusCode, 201, byGm.body);
});

test('свои роли: техадмин собирает роль только из своих прав, чужую роль с доступом к деньгам не меняет и не выдаёт', async () => {
  const cat = (await req('GET', '/api/roles/catalog', TA)).json();
  assert.ok(cat.permissions.find((p: { code: string; available: boolean }) => p.code === 'acs.manage').available);
  assert.equal(cat.permissions.find((p: { code: string; available: boolean }) => p.code === 'finance.view').available, false);
  assert.equal((await req('GET', '/api/roles/catalog', 'o.smirnov')).statusCode, 403, 'управляющий своих ролей не создаёт');

  const bad = await req('POST', '/api/roles', TA, { name: 'Техник с финансами', permissions: ['acs.manage', 'finance.view'], networkWide: true });
  assert.equal(bad.statusCode, 403, bad.body);
  assert.equal((await req('POST', '/api/roles', TA, { name: 'Хитрый', permissions: ['*'], networkWide: true })).statusCode, 400);
  const tech = await req('POST', '/api/roles', TA, { name: 'Инженер СКУД', permissions: ['acs.manage', 'clubs.view'], networkWide: false, description: 'Турникеты одного клуба' });
  assert.equal(tech.statusCode, 201, tech.body);
  const code = tech.json().code as string;
  assert.match(code, /^c_[0-9a-f]{12}$/);
  // Добавить себе в роль финансы нельзя
  assert.equal((await req('PUT', `/api/roles/${code}`, TA, { name: 'Инженер СКУД', permissions: ['acs.manage', 'finance.view'] })).statusCode, 403);
  // Встроенные роли не меняются
  assert.equal((await req('PUT', '/api/roles/techadmin', TA, { name: 'Технический администратор', permissions: ['acs.manage'] })).statusCode, 400);

  // Назначить свою роль новому сотруднику клуба, войти и проверить права
  const club = (await sql(`select id from clubs order by name limit 1`))[0].id;
  const st = await req('POST', '/api/staff', TA, { fullName: 'Инженер Турникетов', role: code, clubId: club });
  assert.equal(st.statusCode, 201, st.body);
  const lg = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: st.json().user.login, password: st.json().tempPassword } });
  assert.equal(lg.statusCode, 200);
  assert.deepEqual(lg.json().permissions.sort(), ['acs.manage', 'clubs.view']);

  // Роль собственника с доступом к клиентам: техадмин не может её ни поменять, ни удалить, ни выдать
  const own = await req('POST', '/api/roles', 'a.bespalyy', { name: 'Старший администратор', permissions: ['persons.view', 'acs.work', 'clubs.view'], networkWide: false });
  assert.equal(own.statusCode, 201, own.body);
  const oc = own.json().code;
  assert.equal((await req('PUT', `/api/roles/${oc}`, TA, { name: 'Старший администратор', permissions: ['acs.work'] })).statusCode, 403);
  assert.equal((await req('DELETE', `/api/roles/${oc}`, TA)).statusCode, 403);
  assert.equal((await req('POST', '/api/staff', TA, { fullName: 'Кто-то', role: oc, clubId: club })).statusCode, 403);
  // Роль назначена — удалить нельзя; не назначена — можно
  assert.equal((await req('DELETE', `/api/roles/${code}`, TA)).statusCode, 400);
  const free = (await req('POST', '/api/roles', TA, { name: 'Временная', permissions: ['system.monitor'] })).json().code;
  assert.equal((await req('DELETE', `/api/roles/${free}`, TA)).statusCode, 200);
  // В меню собственника своя роль видна, в чужой сети — нет (свои роли привязаны к сети)
  assert.ok(((await req('GET', '/api/roles', 'a.bespalyy')).json() as { code: string }[]).some((r) => r.code === code));
  const other = await sql(`select count(*)::int as n from roles where code = $1 and tenant_id = (select tenant_id from users where login = 'a.bespalyy')`, [code]);
  assert.equal(other[0].n, 1);
});

test('техническая часть открыта: СКУД, телефония, мессенджеры, СМС, заявки, состояние системы, защита входа', async () => {
  const club = (await sql(`select id from clubs order by name limit 1`))[0].id;
  for (const url of [`/api/acs/setup?clubId=${club}`, `/api/acs/pocketkey?clubId=${club}`, `/api/pbx?clubId=${club}`, `/api/msg/channels?clubId=${club}`,
    '/api/sms/settings', '/api/intake', '/api/system/status', '/api/security/login', '/api/import/batches', '/api/staff', '/api/roles/catalog']) {
    const r = await req('GET', url, TA);
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  }
  // Подключить телефонию (тестовая АТС) и канал мессенджера
  assert.equal((await req('PUT', '/api/pbx', TA, { clubId: club, kind: 'test' })).statusCode, 200);
  assert.equal((await req('POST', '/api/msg/channels', TA, { clubId: club, kind: 'test', messenger: 'telegram' })).statusCode, 201);
  // Клиенты, финансы, переписка, звонки, отчёты — закрыты
  for (const url of [`/api/persons?clubId=${club}`, '/api/finance/payments', '/api/msg/conversations', '/api/calls', '/api/problems', `/api/plans?clubId=${club}`, '/api/activity']) {
    const r = await req('GET', url, TA);
    assert.ok(r.statusCode === 403 || r.statusCode === 404, `${url}: ${r.statusCode} ${r.body.slice(0, 200)}`);
  }
});

test('перенос из 1С техадмином: только счётчики и ошибки, без ФИО, телефонов, строк файлов и сумм', async () => {
  const { samples, xlsx } = await import('../db/scripts/importSamples.ts');
  const club = (await sql(`select id from clubs where name like '%Север%'`))[0].id;
  const bodies: string[] = [];
  const call = async (method: string, url: string, payload?: unknown) => { const r = await req(method, url, TA, payload); bodies.push(r.body); return r; };
  const b = (await call('POST', '/api/import/batches', { clubId: club })).json();
  for (const [name, buf] of Object.entries(samples())) {
    const r = await call('POST', `/api/import/batches/${b.id}/files`, { fileName: name, dataBase64: buf.toString('base64') });
    assert.equal(r.statusCode, 201, r.body);
  }
  const detail = (await call('GET', `/api/import/batches/${b.id}`)).json();
  assert.equal(detail.dataHidden, true);
  assert.ok(detail.files.every((f: { sample: unknown[]; headers: string[] }) => f.sample.length === 0 && f.headers.length > 0), 'заголовки колонок видны, строки — нет');
  for (const f of detail.files) {
    const mapping = Object.fromEntries(Object.entries(f.mapping as Record<string, { col: number } | null>).map(([k, v]) => [k, v ? v.col : null]));
    assert.equal((await call('PUT', `/api/import/files/${f.id}`, { reportType: f.reportType, mapping })).statusCode, 200);
  }
  const rep1 = (await call('POST', `/api/import/batches/${b.id}/check`)).json();
  assert.equal(rep1.money, null, 'суммы скрыты');
  assert.deepEqual(rep1.dataHidden, { people: true, money: true });
  assert.ok(rep1.counts.clients.source > 0, 'счётчики видны');
  assert.ok(rep1.issues.every((i: { group: string; examples: { issue: string; rowNo: number }[] }) => i.examples.every((e) => e.issue === i.group && e.rowNo > 0)));
  const rows = (await call('GET', `/api/import/batches/${b.id}/rows?status=conflict`)).json() as { cells: unknown; conflictWith: unknown }[];
  assert.ok(rows.every((r) => r.cells === null && r.conflictWith === null));
  const conflict = await sql(`select id::text from import_rows where batch_id = $1 and conflict_with is not null limit 1`, [b.id]);
  if (conflict[0]) assert.equal((await call('POST', `/api/import/rows/${conflict[0].id}/resolve`, { resolution: 'merge' })).statusCode, 403);
  await call('POST', `/api/import/batches/${b.id}/resolve-conflicts`, { resolution: 'new' });
  const rep = (await call('POST', `/api/import/batches/${b.id}/check`)).json();
  assert.equal(rep.canApply, true, JSON.stringify(rep.blockers));
  const ap = await call('POST', `/api/import/batches/${b.id}/apply`, { password: 'Fitnes-2026' });
  assert.equal(ap.statusCode, 200, ap.body);
  assert.ok(ap.json().applied.persons > 0);
  assert.equal(ap.json().money, null);
  // Ни в одном ответе нет перенесённых клиентов, их телефонов и сумм
  const people = await sql(`select p.full_name, (select c.normalized_value from person_contacts c where c.person_id = p.id and c.type = 'phone' limit 1) as phone
    from persons p where p.import_batch_id = $1`, [b.id]);
  assert.ok(people.length > 0);
  const all = bodies.join('\n');
  for (const p of people) {
    assert.ok(!all.includes(p.full_name), `ФИО «${p.full_name}» в ответе`);
    if (p.phone) assert.ok(!all.replace(/\D/g, '').includes(String(p.phone).replace(/\D/g, '')), 'телефон клиента в ответе');
  }
  for (const body of bodies) { try { assert.equal(findMoney(JSON.parse(body)), null); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
  // Собственник видит тот же перенос полностью
  const full = (await req('GET', `/api/import/batches/${b.id}`, 'a.bespalyy')).json();
  assert.ok(full.report.money && full.files.some((f: { sample: unknown[] }) => f.sample.length > 0));

  // Отчёт «Сотрудники» с менеджером техадмин перенести не может: такие учётные записи создаёт собственник или управляющий
  const b2 = (await req('POST', '/api/import/batches', TA, { clubId: club })).json();
  const staff = xlsx([['Сотрудники'], ['Код', 'Сотрудник', 'Должность', 'Телефон', 'Дата увольнения', 'Роль'], ['000101', 'Новикова Ольга', 'Менеджер отдела продаж', '', '', '']]);
  assert.equal((await req('POST', `/api/import/batches/${b2.id}/files`, TA, { fileName: 'Сотрудники.xlsx', dataBase64: staff.toString('base64') })).statusCode, 201);
  const d2 = (await req('GET', `/api/import/batches/${b2.id}`, TA)).json();
  for (const f of d2.files) {
    const mapping = Object.fromEntries(Object.entries(f.mapping as Record<string, { col: number } | null>).map(([k, v]) => [k, v ? v.col : null]));
    await req('PUT', `/api/import/files/${f.id}`, TA, { reportType: f.reportType, mapping });
  }
  const c2 = (await req('POST', `/api/import/batches/${b2.id}/check`, TA)).json();
  assert.equal(c2.canApply, true, JSON.stringify(c2.blockers));
  const ap2 = await req('POST', `/api/import/batches/${b2.id}/apply`, TA, { password: 'Fitnes-2026' });
  assert.equal(ap2.statusCode, 403, ap2.body);
  assert.match(ap2.json().message, /Менеджер ОП/);
});
