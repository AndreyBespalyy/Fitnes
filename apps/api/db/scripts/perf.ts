// Проверка скорости на объёме настоящей сети (п. 14 списка «20 улучшений»).
//   npm run perf -- --generate   создать отдельную базу fitnes_perf: тестовые данные + 30 000 клиентов, 1 млн посещений, 3 года оплат
//   npm run perf                 замерить главные экраны и отчёты на этой базе
// Рабочую базу не трогает: работает только с базой fitnes_perf.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { need } from './common.ts';
import { migrate } from './migrate.ts';
import { seed } from './seed.ts';
import { buildApp } from '../../src/app.ts';
import { createPool } from '../../src/db.ts';

process.env.FISCAL_SECRET_KEY ||= 'perf-fiscal-secret-key-0123456789';
const DB = 'fitnes_perf';
const withDb = (url: string) => { const u = new URL(url); u.pathname = `/${DB}`; return u.toString(); };
const ownerUrl = withDb(need('OWNER_DATABASE_URL'));
const appUrl = withDb(need('DATABASE_URL'));
const arg = (name: string, def: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };

async function generate() {
  const persons = arg('persons', 30000);
  const visits = arg('visits', 1000000);
  const admin = new pg.Client({ connectionString: need('ADMIN_DATABASE_URL') });
  await admin.connect();
  if (!(await admin.query('select 1 from pg_database where datname = $1', [DB])).rowCount) {
    await admin.query(`create database ${DB} owner fitnes_owner encoding 'UTF8' template template0 locale_provider icu icu_locale 'ru-RU' locale 'C'`);
  }
  await admin.end();
  const o = new pg.Client({ connectionString: ownerUrl });
  await o.connect();
  await o.query('drop schema public cascade; create schema public;');
  await o.end();
  console.log('Схема и тестовые данные…');
  await migrate(ownerUrl, true);
  await seed(ownerUrl, true, false);
  console.log(`Объём: ${persons} клиентов, ${visits} посещений, 3 года оплат…`);
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'perfData.sql'), 'utf8')
    .replace(/:persons\b/g, String(persons)).replace(/:visits\b/g, String(visits));
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  const t = Date.now();
  await c.query(sql);
  const n = (await c.query(`select (select count(*) from persons) p, (select count(*) from memberships) m, (select count(*) from charges) ch,
    (select count(*) from payments) pay, (select count(*) from visits) v, (select count(*) from opportunities) o, (select count(*) from audit_log) a`)).rows[0];
  console.log(`Готово за ${Math.round((Date.now() - t) / 1000)} с: клиентов ${n.p}, абонементов ${n.m}, начислений ${n.ch}, оплат ${n.pay}, посещений ${n.v}, сделок ${n.o}, журнал ${n.a}`);
  await c.end();
}

/** Главные экраны и отчёты: {club}, {month}, {person}, {pipeline}, {from}, {to} подставляются. */
/** Четвёртое поле — свой порог для тяжёлых аналитических отчётов за длинный период (по умолчанию общий порог). */
const SCREENS: [string, string, string, number?][] = [
  ['Рабочий стол', 'a.bespalyy', '/api/dash/metrics'],
  ['Поиск клиента по фамилии', 'm.volkova', '/api/persons?clubId={club}&q=Иванова'],
  ['Поиск клиента по телефону', 'd.lis', '/api/persons?clubId={club}&q=9260012345'],
  ['Список клиентов', 'm.volkova', '/api/persons?clubId={club}'],
  ['Ресепшн: поиск', 'd.lis', '/api/desk/find?clubId={club}&q=12345'],
  ['Ресепшн: карточка', 'd.lis', '/api/desk/person/{person}?clubId={club}'],
  ['Карточка клиента', 'm.volkova', '/api/persons/{person}'],
  ['Абонементы клиента', 'm.volkova', '/api/persons/{person}/memberships'],
  ['Посещения клиента', 'm.volkova', '/api/persons/{person}/passes?clubId={club}'],
  ['Лиды', 'm.volkova', '/api/leads?clubId={club}'],
  ['Воронка', 'm.volkova', '/api/opportunities?pipelineId={pipeline}'],
  ['Воронка: проигранные', 'm.volkova', '/api/opportunities?pipelineId={pipeline}&status=lost'],
  ['Задачи', 'm.volkova', '/api/tasks?scope=all&clubId={club}'],
  ['Кому звонить', 'm.volkova', '/api/ai/day-plan?clubId={club}'],
  ['Рекомендации', 'o.smirnov', '/api/recommendations?clubId={club}'],
  ['Финансы: платежи за месяц', 'e.orlova', '/api/finance/payments?clubId={club}&month={month}'],
  ['Финансы: движение денег', 'e.orlova', '/api/finance/cashflow?clubId={club}&month={month}'],
  ['Финансы: долги', 'e.orlova', '/api/finance/debts?clubId={club}'],
  ['Финансы: план-факт', 'e.orlova', '/api/finance/plan-fact?clubId={club}&month={month}'],
  ['Прибыль', 'a.bespalyy', '/api/pnl?clubId={club}&month={month}', 1500],
  ['План продаж', 'o.smirnov', '/api/plans?clubId={club}&month={month}'],
  ['План: прогноз', 'o.smirnov', '/api/plan/forecast?clubId={club}'],
  ['План: расшифровка', 'o.smirnov', '/api/plan/drill?clubId={club}&month={month}'],
  ['Удержание: когорты', 'a.bespalyy', '/api/cohorts?clubId={club}&months=13', 1500],
  ['Удержание: отток', 'a.bespalyy', '/api/churn?clubId={club}'],
  ['Удержание: сегменты', 'o.smirnov', '/api/retention/segments?clubId={club}'],
  ['Удержание: ранние сигналы', 'o.smirnov', '/api/retention/early?clubId={club}'],
  ['Загрузка клуба', 'a.bespalyy', '/api/load?clubId={club}&month={month}', 1500],
  ['Проходы: лента', 'd.lis', '/api/acs/feed?clubId={club}'],
  ['Проходы: отчёт', 'o.smirnov', '/api/acs/report?clubId={club}&from={from}&to={to}'],
  ['Качество работы', 'o.smirnov', '/api/quality?clubId={club}'],
  ['Обзоры сотрудников', 'o.smirnov', '/api/reviews/team?clubId={club}&period=month'],
  ['Зарплата', 'e.orlova', '/api/payroll?clubId={club}&month={month}'],
  ['Новички', 'o.smirnov', '/api/newbie?clubId={club}'],
  ['Переписка', 'm.volkova', '/api/msg/conversations?filter=all&clubId={club}'],
  ['Звонки', 'o.smirnov', '/api/calls?clubId={club}'],
  ['Расписание', 'd.lis', '/api/schedule?clubId={club}&from={from}&to={to}'],
  ['Утренняя сводка', 'a.bespalyy', '/api/morning-summary/preview'],
  ['Использование', 'a.bespalyy', '/api/usage?days=30'],
];

/** --sql: показать самые долгие запросы к базе на каждом медленном экране */
const slowSql: { ms: number; text: string }[] = [];
if (process.argv.includes('--sql')) {
  const orig = pg.Client.prototype.query as (...a: unknown[]) => unknown;
  (pg.Client.prototype as unknown as { query: unknown }).query = function (this: pg.Client, ...a: unknown[]) {
    const t = performance.now();
    const r = orig.apply(this, a);
    const text = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string })?.text ?? '';
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(() => slowSql.push({ ms: performance.now() - t, text }), () => {});
    return r;
  };
}

async function bench() {
  const runs = arg('runs', 5);
  const limit = arg('limit', 500);
  const pool = createPool(appUrl);
  const app = await buildApp(pool, { storageDir: mkdtempSync(join(tmpdir(), 'fitnes-perf-')) });
  const o = new pg.Client({ connectionString: ownerUrl });
  await o.connect();
  const club = (await o.query(`select id from clubs order by (name like '%Центр%') desc, name limit 1`)).rows[0].id;
  // Клиент с самой длинной историей — худший случай для карточки
  const person = (await o.query(`select person_id from visits where club_id = $1 group by 1 order by count(*) desc limit 1`, [club])).rows[0].person_id;
  const pipeline = (await o.query(`select id from pipelines where club_id = $1 and is_default_for_leads`, [club])).rows[0].id;
  const counts = (await o.query(`select (select count(*) from persons)::int p, (select count(*) from visits)::int v`)).rows[0];
  await o.end();
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const vars: Record<string, string> = { club, person, pipeline, month: iso(today).slice(0, 7), from: iso(new Date(Date.now() - 6 * 864e5)), to: iso(today) };
  const cookies: Record<string, Record<string, string>> = {};
  const pw = process.env.SEED_PASSWORD || 'Fitnes-2026';
  console.log(`База ${DB}: клиентов ${counts.p}, посещений ${counts.v}. Замеров на экран: ${runs}, порог ${limit} мс\n`);
  const rows: { name: string; ms: number; status: number; size: number; lim: number }[] = [];
  const oi = process.argv.indexOf('--only');
  const only = oi > 0 ? process.argv[oi + 1].toLowerCase() : '';
  for (const [name, who, tpl, own] of SCREENS.filter(([n]) => !only || only.split(',').some((o) => n.toLowerCase().includes(o)))) {
    if (!cookies[who]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: who, password: pw } });
      cookies[who] = { sid: r.cookies.find((c) => c.name === 'sid')!.value };
    }
    const url = tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k]));
    const times: number[] = [];
    let status = 0, size = 0;
    for (let i = 0; i < runs + 1; i++) {
      const t = performance.now();
      const r = await app.inject({ method: 'GET', url, cookies: cookies[who] });
      if (i > 0) times.push(performance.now() - t); // первый — прогрев
      status = r.statusCode; size = r.body.length;
      if (i === 0 && status >= 400) console.log(`   ${url}: ${r.body.slice(0, 160)}`);
    }
    times.sort((a, b) => a - b);
    const top = slowSql.splice(0).filter((q) => q.ms > 100).sort((a, b) => b.ms - a.ms).slice(0, 3);
    const ms = Math.round(times[Math.floor(times.length / 2)]);
    const lim = own ?? limit;
    rows.push({ name, ms, status, size, lim });
    console.log(`${ms > lim ? '✗' : '✓'} ${String(ms).padStart(6)} мс  ${status}  ${String(Math.round(size / 1024)).padStart(5)} КБ  ${name}`);
    if (ms > lim) for (const q of top) console.log(`      ${Math.round(q.ms)} мс: ${q.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  const slow = rows.filter((r) => r.ms > r.lim);
  const bad = rows.filter((r) => r.status >= 400);
  console.log(`\nМедленнее порога (${limit} мс, тяжёлые отчёты 1500 мс): ${slow.length ? slow.map((r) => r.name).join(', ') : 'нет'}`);
  if (bad.length) console.log(`С ошибкой: ${bad.map((r) => `${r.name} (${r.status})`).join(', ')}`);
  await app.close(); await pool.end();
  process.exitCode = slow.length || bad.length ? 1 : 0;
}

if (process.argv.includes('--generate')) await generate();
else await bench();
