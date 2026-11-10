import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login, PASSWORD } from './helpers.ts';
import { samples, xlsx, csv1251 } from '../db/scripts/importSamples.ts';
import { readTable } from '../src/lib/tables.ts';
import { detectReport, findHeaderRow, parseMoney, parseDate } from '../src/modules/importMap.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Record<string, string>;
let gm: Record<string, string>;
let c1: string;
let c2: string;

before(async () => {
  t = await setupTestApp();
  owner = (await login(t.app, 'a.bespalyy')).cookie!;
  gm = (await login(t.app, 'o.smirnov')).cookie!;
  const clubs = (await t.app.inject({ method: 'GET', url: '/api/clubs', cookies: owner })).json();
  c1 = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  c2 = clubs.find((c: { name: string }) => c.name.includes('Север')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

const api = (method: string, url: string, cookies: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, cookies, payload: payload as object });
const owner$ = async <T>(fn: (c: pg.Client) => Promise<T>) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return await fn(c); } finally { await c.end(); } };

async function uploadAll(batchId: string, cookies = gm) {
  const out: Record<string, { reportType: string; confidence: number; fromTemplate: boolean }> = {};
  for (const [name, buf] of Object.entries(samples())) {
    const r = await api('POST', `/api/import/batches/${batchId}/files`, cookies, { fileName: name, dataBase64: buf.toString('base64') });
    assert.equal(r.statusCode, 201, r.body);
    out[name] = r.json();
  }
  return out;
}
async function confirmAll(batchId: string) {
  const b = (await api('GET', `/api/import/batches/${batchId}`, gm)).json();
  for (const f of b.files) {
    const mapping = Object.fromEntries(Object.entries(f.mapping as Record<string, { col: number } | null>).map(([k, v]) => [k, v ? v.col : null]));
    const r = await api('PUT', `/api/import/files/${f.id}`, gm, { reportType: f.reportType, mapping });
    assert.equal(r.statusCode, 200, r.body);
  }
}

test('чтение таблиц и разбор значений', () => {
  const s = samples();
  const csv = readTable(s['Оплаты.csv'], 'Оплаты.csv');
  assert.equal(csv[findHeaderRow(csv)][0], 'Дата');
  assert.ok(csv.some((r) => r.includes('Банковская карта')), 'кодировка Windows-1251 прочитана');
  const x = readTable(s['Клиенты.xlsx'], 'Клиенты.xlsx');
  const h = findHeaderRow(x);
  assert.deepEqual(x[h], ['Код', 'ФИО', 'Телефон', 'E-mail', 'Дата рождения', 'Номер карты']);
  assert.match(x[h + 1][4], /^\d{2}\.\d{2}\.\d{4}$/, 'дата из Excel превращена в ДД.ММ.ГГГГ');
  const v = readTable(s['Посещения.xlsx'], 'Посещения.xlsx');
  assert.match(v[findHeaderRow(v) + 1][1], /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
  assert.equal(parseMoney('1 500,50'), 150050);
  assert.equal(parseMoney('-11 000,00'), -1100000);
  assert.equal(parseMoney('(200,00)'), -20000);
  assert.equal(parseMoney('1,500.00'), 150000);
  assert.equal(parseMoney('18000.5'), 1800050);
  assert.equal(parseMoney('1499.9999999999998'), 150000);
  assert.equal(parseMoney('абв'), null);
  assert.deepEqual(parseDate('05.03.2026 9:07'), { date: '2026-03-05', time: '09:07:00' });
  assert.equal(parseDate('31.02.2026'), null);
  assert.throws(() => readTable(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'старый.xls'), /старом формате Excel/);
  // Распознавание по заголовкам даже без подсказки в названии файла
  assert.equal(detectReport(['Код', 'ФИО', 'Телефон', 'Дата рождения'], 'файл1.xlsx').type, 'clients');
  assert.equal(detectReport(['Дата', 'Номер документа', 'Клиент', 'Сумма', 'Вид оплаты'], 'файл2.xlsx').type, 'payments');
  assert.equal(detectReport(['Клиент', 'Вид абонемента', 'Дата начала', 'Дата окончания', 'Стоимость'], 'файл3.xlsx').type, 'memberships');
  assert.equal(detectReport(['Клиент', 'Дата посещения', 'Зона'], 'файл4.xlsx').type, 'visits');
  assert.equal(detectReport(['Клиент', 'Задолженность', 'Аванс'], 'файл5.xlsx').type, 'balances');
  assert.ok(xlsx([['a']]).length > 0 && csv1251([['б']]).length > 0);
});

test('права: перенос доступен собственнику, управляющему, администратору и финансисту, но не менеджеру', async () => {
  const mgr = (await login(t.app, 'm.volkova')).cookie!;
  assert.equal((await api('GET', '/api/import/batches', mgr)).statusCode, 403);
  const fin = (await login(t.app, 'e.orlova')).cookie!;
  assert.equal((await api('GET', '/api/import/batches', fin)).statusCode, 200);
  // Управляющий «Центра» не видит и не создаёт перенос «Севера»
  assert.equal((await api('POST', '/api/import/batches', gm, { clubId: c2 })).statusCode, 400);
});

test('полный перенос: распознавание, конфликты, сверка, перенос, повтор без дублей, отмена и принятие', async () => {
  const b = (await api('POST', '/api/import/batches', gm, { clubId: c1 })).json();

  // Без пяти отчётов перенос не начинается
  const early = (await api('POST', `/api/import/batches/${b.id}/check`, gm)).json();
  assert.equal(early.canApply, false);
  assert.equal(early.blockers.filter((x: string) => x.startsWith('Не загружен отчёт')).length, 5);

  const up = await uploadAll(b.id);
  assert.equal(up['Клиенты.xlsx'].reportType, 'clients');
  assert.equal(up['Абонементы.csv'].reportType, 'memberships');
  assert.equal(up['Оплаты.csv'].reportType, 'payments');
  assert.equal(up['Посещения.xlsx'].reportType, 'visits');
  assert.equal(up['Остатки_и_долги.csv'].reportType, 'balances');
  for (const f of Object.values(up)) assert.ok(f.confidence >= 0.5, `уверенность ${f.confidence}`);
  // Тот же файл второй раз не принимается
  const dup = await api('POST', `/api/import/batches/${b.id}/files`, gm, { fileName: 'Клиенты.xlsx', dataBase64: samples()['Клиенты.xlsx'].toString('base64') });
  assert.equal(dup.statusCode, 400);

  // Карты не подтверждены → перенос заблокирован
  let rep = (await api('POST', `/api/import/batches/${b.id}/check`, gm)).json();
  assert.ok(rep.blockers.some((x: string) => x.startsWith('Не подтверждена карта полей')));
  await confirmAll(b.id);

  rep = (await api('POST', `/api/import/batches/${b.id}/check`, gm)).json();
  // Конфликты: телефон Рябова уже в системе, у Морозовых один телефон
  assert.equal(rep.counts.clients.conflict, 2);
  assert.equal(rep.canApply, false);
  assert.equal(rep.counts.clients.source, 11);
  assert.equal(rep.counts.clients.skipped, 1, 'повтор строки К-0005');
  // Абонемент клиента, которого нет в отчёте клиентов, исключён с объяснением
  const memIssue = rep.issues.find((i: { type: string; group: string }) => i.type === 'memberships' && i.group === 'Клиент не найден');
  assert.equal(memIssue.count, 1);
  assert.match(memIssue.examples[0].issue, /К-0099/);

  // Ничего не записано в рабочие таблицы при пробном переносе
  assert.equal(await owner$(async (c) => Number((await c.query(`select count(*) from persons where full_name = 'Иванова Мария Сергеевна'`)).rows[0].count)), 0);

  const conflicts = (await api('GET', `/api/import/batches/${b.id}/rows?status=conflict`, gm)).json();
  assert.equal(conflicts.length, 2);
  const ryabov = conflicts.find((r: { cells: string[] }) => r.cells[0] === 'К-0003');
  assert.ok(ryabov.conflictPersonId, 'указан найденный клиент в системе');
  const morozova = conflicts.find((r: { cells: string[] }) => r.cells[0] === 'К-0008');
  assert.equal((await api('POST', `/api/import/rows/${ryabov.id}/resolve`, gm, { resolution: 'merge' })).statusCode, 200);
  assert.equal((await api('POST', `/api/import/rows/${morozova.id}/resolve`, gm, { resolution: 'new' })).statusCode, 200);

  // После решения без пробного переноса — нельзя
  assert.equal((await api('POST', `/api/import/batches/${b.id}/apply`, gm, { password: PASSWORD })).statusCode, 400);
  rep = (await api('POST', `/api/import/batches/${b.id}/check`, gm)).json();
  assert.equal(rep.canApply, true, JSON.stringify(rep.blockers));
  assert.equal(rep.counts.clients.load, 10);
  assert.equal(rep.counts.memberships.load, 8);
  assert.equal(rep.counts.memberships.excluded, 1);
  assert.equal(rep.counts.payments.source, 11);
  assert.equal(rep.counts.payments.load, 10);
  assert.equal(rep.counts.visits.load, 5, 'повтор и чужой клиент не переносятся');
  assert.equal(rep.counts.visits.skipped, 1);
  assert.equal(rep.counts.visits.excluded, 1);
  // Сверка денег: итог отчёта 1С = приход − возврат по всем строкам; исключённый платёж виден отдельно
  const m = rep.money;
  assert.equal(m.totals.inSourceKop - m.totals.outSourceKop, m.paymentsFooterKop);
  assert.equal(m.totals.inSourceKop - m.totals.inLoadKop, 500000, 'исключён платёж клиента К-0099');
  assert.equal(m.totals.outLoadKop, 1100000);
  assert.equal(m.debts.sourceKop, 400000);
  assert.equal(m.debts.loadKop, 400000);
  assert.equal(m.advances.sourceKop, 150000);

  // Перенос требует пароль
  assert.equal((await api('POST', `/api/import/batches/${b.id}/apply`, gm, { password: 'неверный' })).statusCode, 400);
  const applied = await api('POST', `/api/import/batches/${b.id}/apply`, gm, { password: PASSWORD });
  assert.equal(applied.statusCode, 200, applied.body);
  const a = applied.json().applied;
  assert.equal(a.persons, 9, '10 клиентов, один объединён с Рябовым');
  assert.equal(a.merged, 1);
  assert.equal(a.memberships, 8);
  assert.equal(a.contracts, 8);
  assert.equal(a.payments, 10);
  assert.equal(a.visits, 5);
  assert.equal(a.debts, 1);

  const db = await owner$(async (c) => ({
    paidIn: Number((await c.query(`select coalesce(sum(amount_kop), 0) as s from payments where import_batch_id = $1 and direction = 'in'`, [b.id])).rows[0].s),
    paidOut: Number((await c.query(`select coalesce(sum(amount_kop), 0) as s from payments where import_batch_id = $1 and direction = 'out'`, [b.id])).rows[0].s),
    ryabovPhones: Number((await c.query(`select count(*) from person_contacts pc join persons p on p.id = pc.person_id where p.full_name = 'Павел Рябов'`)).rows[0].count),
    ryabovEmail: (await c.query(`select pc.value from person_contacts pc join persons p on p.id = pc.person_id where p.full_name = 'Павел Рябов' and pc.type = 'email'`)).rows[0]?.value,
    ivanova: (await c.query(`select segment from persons where full_name = 'Иванова Мария Сергеевна'`)).rows[0],
    petrov: (await c.query(`select id, segment from persons where full_name = 'Петров Илья Андреевич'`)).rows[0],
    lebedev: (await c.query(`select p.id from persons p where full_name = 'Лебедев Константин Юрьевич'`)).rows[0],
    a106: (await c.query(`select m.status, ct.status as contract from memberships m join contracts ct on ct.membership_id = m.id where ct.number = 'ЦФ-2026-0106'`)).rows[0],
    payDate: (await c.query(`select to_char(created_at at time zone 'Europe/Moscow', 'HH24:MI') as t from payments where import_batch_id = $1 order by created_at limit 1`, [b.id])).rows[0].t,
    ext: Number((await c.query(`select count(*) from import_external_ids where import_batch_id = $1`, [b.id])).rows[0].count),
    extFields: (await c.query(`select source_report_type, source_row_id, mapping_version, checksum from import_external_ids where import_batch_id = $1 and entity = 'person' limit 1`, [b.id])).rows[0],
  }));
  assert.equal(db.paidIn, m.totals.inLoadKop, 'в журнал попало ровно то, что в отчёте сверки');
  assert.equal(db.paidOut, m.totals.outLoadKop);
  assert.equal(db.ryabovEmail, 'p.ryabov@example.ru', 'почта из 1С добавлена к найденной карточке');
  assert.equal(db.ivanova.segment, 'действующий');
  assert.equal(db.a106.status, 'cancelled');
  assert.equal(db.a106.contract, 'cancelled');
  assert.ok(db.extFields.source_report_type && db.extFields.source_row_id && db.extFields.mapping_version && db.extFields.checksum);

  // Карточка клиента: долг по абонементу из остатков и расчёт возврата по оплаченному
  const pm = (await api('GET', `/api/persons/${db.petrov.id}/memberships`, gm)).json();
  const a103 = pm.find((x: { endsOn: string; status: string }) => x.status === 'active');
  assert.ok(a103.charges.some((c: { status: string; amountKop: number }) => c.status === 'due' && Number(c.amountKop) === 400000));
  const q = (await api('GET', `/api/memberships/${a103.id}/refund-quote`, gm)).json();
  assert.equal(q.paidKop, 800000);
  const lm = (await api('GET', `/api/persons/${db.lebedev.id}/memberships`, gm)).json();
  assert.equal(Number(lm[0].amountKop), 1800050, 'копейки не округлены');

  // Повторный перенос того же пакета невозможен
  assert.equal((await api('POST', `/api/import/batches/${b.id}/apply`, gm, { password: PASSWORD })).statusCode, 400);

  // Новый пакет с теми же файлами: карты из библиотеки, всё «уже перенесено раньше», дублей и удвоения денег нет
  const b2 = (await api('POST', '/api/import/batches', gm, { clubId: c1 })).json();
  const up2 = await uploadAll(b2.id);
  assert.ok(Object.values(up2).every((f) => f.fromTemplate), 'карта полей взята из библиотеки');
  const rep2 = (await api('POST', `/api/import/batches/${b2.id}/check`, gm)).json();
  assert.equal(rep2.counts.clients.earlier, 10);
  assert.equal(rep2.counts.payments.load, 0);
  assert.equal(rep2.counts.memberships.load, 0);
  assert.equal(rep2.counts.visits.load, 0);
  assert.equal(rep2.money.totals.inLoadKop, rep.money.totals.inLoadKop, 'ранее перенесённые суммы учтены как перенесённые');

  // Отмена первого переноса до принятия удаляет всё, что он создал
  assert.equal((await api('POST', `/api/import/batches/${b.id}/rollback`, gm, { password: PASSWORD })).statusCode, 200);
  const left = await owner$(async (c) => ({
    persons: Number((await c.query(`select count(*) from persons where import_batch_id = $1`, [b.id])).rows[0].count),
    payments: Number((await c.query(`select count(*) from payments where import_batch_id = $1`, [b.id])).rows[0].count),
    ryabov: Number((await c.query(`select count(*) from persons where full_name = 'Павел Рябов'`)).rows[0].count),
    status: (await c.query(`select status from import_batches where id = $1`, [b.id])).rows[0].status,
  }));
  assert.deepEqual(left, { persons: 0, payments: 0, ryabov: 1, status: 'rolled_back' });

  // Второй пакет теперь переносит всё заново и принимается; после принятия отмена невозможна
  rep = (await api('POST', `/api/import/batches/${b2.id}/check`, gm)).json();
  assert.equal(rep.counts.payments.load, 10);
  const conf2 = (await api('GET', `/api/import/batches/${b2.id}/rows?status=conflict`, gm)).json();
  for (const r of conf2) await api('POST', `/api/import/rows/${r.id}/resolve`, gm, { resolution: r.cells[0] === 'К-0003' ? 'merge' : 'skip' });
  rep = (await api('POST', `/api/import/batches/${b2.id}/check`, gm)).json();
  assert.equal(rep.canApply, true, JSON.stringify(rep.blockers));
  assert.equal(rep.counts.clients.load, 9, 'Морозова пропущена по решению');
  assert.equal((await api('POST', `/api/import/batches/${b2.id}/apply`, gm, { password: PASSWORD })).statusCode, 200);
  assert.equal((await api('POST', `/api/import/batches/${b2.id}/accept`, gm, { password: PASSWORD })).statusCode, 200);
  assert.equal((await api('POST', `/api/import/batches/${b2.id}/rollback`, gm, { password: PASSWORD })).statusCode, 400);

  // Приложение не может удалить платежи переноса напрямую
  await assert.rejects(t.pool.query('delete from payments'), /permission denied/);
});

test('ручная карта полей: обязательные поля и одна колонка на одно поле', async () => {
  const b = (await api('POST', '/api/import/batches', gm, { clubId: c1 })).json();
  const f = (await api('POST', `/api/import/batches/${b.id}/files`, gm, { fileName: 'выгрузка.csv',
    dataBase64: csv1251([['Покупатель', 'Когда', 'Сколько'], ['Иванов И.', '01.02.2026', '100']]).toString('base64') })).json();
  assert.equal((await api('PUT', `/api/import/files/${f.id}`, gm, { reportType: 'payments', mapping: { client_name: 0 } })).statusCode, 400);
  assert.equal((await api('PUT', `/api/import/files/${f.id}`, gm, { reportType: 'payments', mapping: { client_name: 0, date: 1, amount: 1 } })).statusCode, 400);
  assert.equal((await api('PUT', `/api/import/files/${f.id}`, gm, { reportType: 'payments', mapping: { client_name: 0, date: 1, amount: 2 } })).statusCode, 200);
  assert.equal((await api('DELETE', `/api/import/files/${f.id}`, gm)).statusCode, 200);
});
