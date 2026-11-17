// Отдел продаж глазами ИИ-агента «Дядя Витя» (17.11.2026): рейтинг менеджеров, утренняя сводка РОПу с кнопкой «Чат с менеджером»,
// сверка разговоров со скриптами — разбор менеджеру, с третьего разбора за 30 дней — РОПу со ссылками, упущения в рейтинге.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { withCtx } from '../src/db.ts';
import { processMorningHints } from '../src/modules/agentMorning.ts';
import { pickScript, scriptCheckCalls } from '../src/modules/agentScripts.ts';
import { rateManagers } from '../src/modules/agentSalesTeam.ts';
import type { AiConfig } from '../src/lib/aiClient.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
let centr = ''; let tenant = ''; let tz = '';
const uid: Record<string, string> = {};
const sys = () => ({ tenantId: tenant, allClubs: true, clubIds: [] });

before(async () => {
  t = await setupTestApp();
  for (const l of ['o.smirnov', 'm.volkova', 'o.astafeva', 'a.kim']) ck[l] = (await login(t.app, l)).cookie!;
  const c = (await sql(`select id, tenant_id, timezone from clubs where name like '%Центр%'`))[0];
  centr = c.id; tenant = c.tenant_id; tz = c.timezone;
  for (const r of await sql(`select id, login from users where login in ('o.smirnov', 'm.volkova', 'o.astafeva', 'a.kim')`)) uid[r.login] = r.id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('рейтинг: менеджер видит только себя, РОП и управляющий — всех, тренер — нет', async () => {
  const mine = await req('GET', '/api/manager-ratings', 'm.volkova');
  assert.equal(mine.statusCode, 200, mine.body);
  const m = mine.json().items as { userId: string; score: number; parts: Record<string, number>; note: string }[];
  assert.ok(m.length >= 1 && m.every((r) => r.userId === uid['m.volkova']), JSON.stringify(m));
  assert.ok(m[0].score >= 0 && m[0].score <= 100);
  assert.deepEqual(Object.keys(m[0].parts).sort(), ['discipline', 'over', 'plan', 'script', 'speed']);
  assert.ok(m[0].note.length > 10);
  for (const who of ['o.astafeva', 'o.smirnov']) {
    const all = (await req('GET', '/api/manager-ratings', who)).json().items as { userId: string }[];
    assert.ok(all.some((r) => r.userId === uid['m.volkova']), who);
  }
  assert.equal((await req('GET', '/api/manager-ratings', 'a.kim')).statusCode, 403);
});

test('утренняя сводка РОПу: план, не сделано / перенесено, рейтинг и «Чат с менеджером» с темой по сводке', async () => {
  await sql(`delete from agent_sent where club_id = $1 and key like 'morning:%'`, [centr]);
  await withCtx(t.pool, sys(), (db) => processMorningHints(db, { tenantId: tenant, userId: null }, centr));
  const msg = (await sql(`select m.body, m.meta from team_messages m join team_members tm on tm.chat_id = m.chat_id and tm.user_id = $1
    where m.meta->>'kind' = 'sales_team' order by m.created_at desc limit 1`, [uid['o.astafeva']]))[0];
  assert.ok(msg, 'РОП не получил сводку');
  assert.match(msg.body, /^\*\*Отдел продаж за \d\d\.\d\d\.\d{4}: выполнение плана менеджерами\*\*/);
  assert.match(msg.body, /\*\*Мария Волкова\*\* — .+; вчера не сделано задач: \d+, перенесено: \d+; рейтинг \*\*\d+\*\*/);
  const a = (msg.meta.actions as { label: string; chat?: { userId: string; text: string } }[]).find((x) => x.chat?.userId === uid['m.volkova']);
  assert.equal(a?.label, 'Чат с менеджером: Волкова');
  assert.match(a!.chat!.text, /(Невыполнение плана|Выполнение плана|Итоги) за \d\d\.\d\d\.\d{4}/);
  // Кнопка открывает личный чат РОПа с менеджером
  const d = await req('POST', '/api/team/direct', 'o.astafeva', { userId: uid['m.volkova'] });
  assert.equal(d.statusCode, 200, d.body);
  // Управляющему (в клубе есть РОП) сводка не приходит
  const gm = await sql(`select 1 from team_messages m join team_members tm on tm.chat_id = m.chat_id and tm.user_id = $1 where m.meta->>'kind' = 'sales_team'`, [uid['o.smirnov']]);
  assert.equal(gm.length, 0);
});

test('скрипт выбирается по разговору', () => {
  assert.equal(pickScript('in', 'Сандов Фитнес, добрый день').code, 'incoming');
  assert.equal(pickScript('out', 'звоню по поводу продления абонемента').code, 'renewal');
  assert.equal(pickScript('out', 'Звоню напомнить: мы встречаемся в четверг').code, 'confirm');
  assert.equal(pickScript('out', 'вы оставляли заявку на сайте').code, 'lead');
});

test('«Дядя Витя»: разбор звонка менеджеру, с третьего — РОПу со ссылками, упущения в рейтинге', async () => {
  // ИИ-сервер: «ожидания» не спрошены, прозвучало «вам актуально?»; телефоны в ИИ не уходят
  const sent: string[] = [];
  const ai: AiConfig = { url: 'http://ai.test', fetch: (async (_u: string, init: RequestInit) => {
    sent.push(String(init.body));
    const items = (JSON.parse(String(init.body)).checklist as { id: string }[]).map((i) => ({ id: i.id, ok: !['expect', 'n_actual'].includes(i.id), quote: i.id === 'n_actual' ? 'вам актуально?' : undefined }));
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch };
  const person = (await req('POST', '/api/leads', 'm.volkova', { clubId: centr, fullName: 'Скриптов Игорь', phone: '+79007770011', sourceCode: 'walk_in' })).json().personId;
  const call = async (minAgo: number) => (await sql(`insert into calls(tenant_id, club_id, person_id, user_id, direction, phone, started_at, source, transcript, asr_status, created_at)
    values ($1,$2,$3,$4,'out','+79007770011', now() - make_interval(mins => $5), 'upload', $6, 'done', now() - interval '1 hour') returning id`,
  [tenant, centr, person, uid['m.volkova'], minAgo, JSON.stringify({ text: 'Добрый день, вы оставляли заявку. Мой номер +7 900 777-00-11. Вам актуально?', segments: [] })]))[0].id as string;

  const c1 = await call(30);
  await sql(`insert into call_summaries(tenant_id, club_id, call_id, draft, status) values ($1,$2,$3,$4,'draft')`, [tenant, centr, c1, JSON.stringify({ essence: 'Клиент спросил цену, договорились созвониться' })]);
  assert.equal(await withCtx(t.pool, sys(), (db) => scriptCheckCalls(db, tenant, ai)), 1);
  assert.ok(!sent.some((b) => b.includes('777-00-11')), 'телефон ушёл в ИИ');
  const w = (await sql(`select m.body, m.meta from team_messages m where m.meta->>'kind' = 'script_check' and m.meta->>'callId' = $1`, [c1]))[0];
  assert.match(w.body, /^\*\*Разбор звонка с Скриптов Игорь, .+\*\* — скрипт «Звонок по заявке»\nКоротко: Клиент спросил цену/);
  assert.match(w.body, /Что упущено:\n1\. Спросил, чего клиент ждёт от занятий .+ Как по скрипту: «А чего вы ждёте от занятий/);
  assert.match(w.body, /Прозвучало то, что нельзя: «вам актуально\?»/);
  assert.deepEqual(w.meta.actions, [{ label: 'Открыть разговор', url: `/?tab=calls&call=${c1}` }]);
  assert.equal((await sql(`select 1 from team_messages where meta->>'kind' = 'script_rop'`)).length, 0);

  // Второй разбор — ещё только менеджеру; третий — РОПу со ссылками на разговоры
  await call(20); await withCtx(t.pool, sys(), (db) => scriptCheckCalls(db, tenant, ai));
  assert.equal((await sql(`select 1 from team_messages where meta->>'kind' = 'script_rop'`)).length, 0);
  const c3 = await call(10); await withCtx(t.pool, sys(), (db) => scriptCheckCalls(db, tenant, ai));
  const rop = (await sql(`select m.body, m.meta from team_messages m join team_members tm on tm.chat_id = m.chat_id and tm.user_id = $1 where m.meta->>'kind' = 'script_rop'`, [uid['o.astafeva']]))[0];
  assert.ok(rop, 'РОП не получил сводку по скриптам');
  assert.match(rop.body, /^\*\*Мария Волкова снова отходит от скрипта продаж\*\* — 3-й разбор за 30 дней/);
  const acts = rop.meta.actions as { label: string; url?: string; chat?: unknown }[];
  assert.equal(acts.filter((a) => a.url?.startsWith('/?tab=calls&call=')).length, 3);
  assert.equal(acts[0].url, `/?tab=calls&call=${c3}`);
  assert.ok(acts.some((a) => a.label === 'Чат с менеджером: Волкова' && a.chat));
  // Повторно тот же звонок не разбирается
  assert.equal(await withCtx(t.pool, sys(), (db) => scriptCheckCalls(db, tenant, ai)), 0);

  // Рейтинг: часть «Скрипты» и вывод агента
  const today = (await sql(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz]))[0].d;
  const r = (await withCtx(t.pool, sys(), (db) => rateManagers(db, centr, today))).find((x) => x.userId === uid['m.volkova'])!;
  assert.equal(r.facts.scriptMisses, 3);
  assert.ok(r.parts.script < 15);
  assert.match(r.note, /отходит от скрипта: 3 из 3 разобранных разговоров/);
});
