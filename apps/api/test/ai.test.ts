import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processCalls, parseRecordName } from '../src/modules/ai.ts';
import { editRatio } from '../src/lib/aiClient.ts';
import type { AiConfig } from '../src/lib/aiClient.ts';

// Заглушка ИИ-сервера: режим задаётся тестом
let mode: 'ok' | 'down' | 'insufficient' = 'ok';
const seen: { path: string; auth: string | null; body?: unknown }[] = [];
const TEXT = 'Менеджер: Добрый день, фитнес-клуб Центр.\nКлиент: Хочу годовой абонемент, но дорого. Давайте в четверг приду на пробную тренировку вечером.';
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const path = new URL(u).pathname;
  const h = new Headers(init?.headers);
  seen.push({ path, auth: h.get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (mode === 'down') return json(503, { detail: 'GPU занят' });
  if (path === '/health') return json(200, { ok: true, asr: 'whisper-large-v3', llm: 'Qwen2.5-32B/summary-v1', promptVersion: 'summary-v1' });
  if (path === '/v1/transcribe') {
    const f = (init!.body as FormData).get('file') as File;
    assert.ok(f.size > 0);
    return json(200, { text: TEXT, segments: [{ speaker: 'manager', start: 0, end: 2, text: 'Добрый день' }], language: 'ru', durationSec: 75.4, engine: 'whisper-large-v3' });
  }
  if (path === '/v1/summarize') {
    if (mode === 'insufficient') return json(200, { summary: null, confidence: null, engine: 'qwen/summary-v1', reason: 'Разговор не о клубе' });
    return json(200, {
      engine: 'qwen/summary-v1', confidence: 0.9,
      summary: { essence: 'Клиент хочет годовой абонемент, записан на пробную тренировку.', need: 'Годовой абонемент, вечер', objections: ['дорого'],
        agreements: 'Пробная тренировка в четверг вечером', outcome: 'interested',
        nextStep: { title: 'Пробная тренировка', kind: 'meeting', dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() } },
    });
  }
  return json(404, {});
}) as typeof fetch;
const AI: AiConfig = { url: 'http://ai.local', token: 'tok', fetch: fakeFetch };

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
let c1: string; let c2: string;
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
// Минимальный WAV: заголовок RIFF/WAVE и немного тишины
const wav = (n = 1) => { const b = Buffer.alloc(44 + 800 * n); b.write('RIFF', 0); b.writeUInt32LE(36 + 800 * n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(n, 40); return b.toString('base64'); };

before(async () => {
  t = await setupTestApp({ ai: AI });
  for (const l of ['a.bespalyy', 'o.smirnov', 'o.astafeva', 'm.volkova', 'i.zuev', 's.pavlov', 'd.lis']) ck[l] = (await login(t.app, l)).cookie!;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json();
  c1 = clubs.find((c: { name: string }) => c.name.includes('Центр')).id;
  c2 = clubs.find((c: { name: string }) => c.name.includes('Север')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('имя файла АТС: телефон, время, направление', () => {
  assert.deepEqual(parseRecordName('out-79001234567-20261110-143512.mp3'), { phone: '+79001234567', local: '2026-11-10 14:35:12', direction: 'out' });
  assert.deepEqual(parseRecordName('2026-11-09_09.05 входящий 8 (900) 765-43-21.wav'), { phone: '+79007654321', local: '2026-11-09 09:05:00', direction: 'in' });
  assert.deepEqual(parseRecordName('запись.ogg'), { phone: null, local: null, direction: null });
  assert.equal(editRatio('клиент хочет годовой абонемент', 'клиент хочет годовой абонемент'), 0);
  assert.ok(editRatio('клиент хочет годовой абонемент', 'клиент хочет абонемент на месяц') > 0.2);
});

test('запись → расшифровка → черновик ИИ → менеджер подтверждает с правкой → задача следующего шага', async () => {
  // Клиент с телефоном из имени файла
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Звонков Пётр', phone: '+79005550011', sourceCode: 'site' })).json();
  assert.equal((await req('POST', '/api/calls/upload', 'm.volkova', { clubId: c1, fileName: 'x.txt', dataBase64: Buffer.from('просто текст, не запись').toString('base64') })).statusCode, 400);
  const up = await req('POST', '/api/calls/upload', 'm.volkova', { clubId: c1, fileName: 'in-79005550011.wav', dataBase64: wav() });
  assert.equal(up.statusCode, 201, up.body);
  assert.equal(up.json().personId, lead.personId);
  assert.equal(up.json().status, 'queued');
  // повторная загрузка того же файла не создаёт дубль
  assert.equal((await req('POST', '/api/calls/upload', 'm.volkova', { clubId: c1, fileName: 'копия.wav', dataBase64: wav() })).json().duplicate, true);
  const id = up.json().id;
  // разговор с новым лидом — это первый ответ
  assert.ok((await sql('select first_response_at from leads where id = $1', [lead.leadId]))[0].first_response_at);

  await processCalls(t.pool, AI, t.storage);
  assert.ok(seen.some((s) => s.path === '/v1/transcribe' && s.auth === 'Bearer tok'));
  const ctxSent = seen.find((s) => s.path === '/v1/summarize')!.body as { context: { clientName: string; managerName: string } };
  assert.equal(ctxSent.context.clientName, 'Звонков Пётр');
  assert.equal(ctxSent.context.managerName, 'Мария Волкова');

  const d = (await req('GET', `/api/calls/${id}`, 'm.volkova')).json();
  assert.equal(d.asrStatus, 'done');
  assert.equal(d.durationSec, 75);
  assert.equal(d.summary.status, 'draft');
  assert.equal(d.summary.confidence, 0.9);
  assert.match(d.engine, /whisper-large-v3 \+ qwen\/summary-v1/);
  assert.match(d.phone, /\*\*\*/); // телефон замаскирован
  // задача «проверьте итог» и её нельзя закрыть в обход подтверждения
  const task = (await sql(`select id, title from tasks where call_id = $1 and done_at is null`, [id]))[0];
  assert.match(task.title, /Проверьте итог разговора с Звонков Пётр/);
  const bypass = await req('POST', `/api/tasks/${task.id}/complete`, 'm.volkova', { result: 'ок' });
  assert.equal(bypass.json().error, 'call_summary_required');
  // список «на проверку»
  assert.ok((await req('GET', `/api/calls?clubId=${c1}&scope=review`, 'm.volkova')).json().some((c: { id: string }) => c.id === id));
  // другой менеджер чужой разговор не видит
  assert.equal((await req('GET', `/api/calls/${id}`, 'i.zuev')).statusCode, 404);
  // аудио отдаётся
  assert.equal((await req('GET', `/api/calls/${id}/audio`, 'm.volkova')).headers['content-type'], 'audio/wav');

  // менеджер правит: без даты следующего шага нельзя
  const final = { ...d.summary.draft, objections: ['дорого', 'далеко от дома'] };
  assert.equal((await req('POST', `/api/calls/${id}/summary`, 'm.volkova', { ...final, nextStep: { title: 'Позвонить', kind: 'call', dueAt: '' } })).statusCode, 400);
  assert.equal((await req('POST', `/api/calls/${id}/summary`, 'm.volkova', { ...final, essence: '  ' })).statusCode, 400);
  const ok = (await req('POST', `/api/calls/${id}/summary`, 'm.volkova', final)).json();
  assert.equal(ok.status, 'confirmed');
  assert.ok(ok.editRatio > 0 && ok.editRatio <= 0.2, String(ok.editRatio));
  const next = (await sql(`select title, kind, opportunity_id, assignee_id from tasks where id = $1`, [ok.taskId]))[0];
  assert.equal(next.title, 'Пробная тренировка');
  assert.equal(next.kind, 'meeting');
  assert.equal(next.opportunity_id, lead.opportunityId);
  assert.equal((await sql(`select done_at from tasks where id = $1`, [task.id]))[0].done_at !== null, true);
  assert.equal((await req('POST', `/api/calls/${id}/summary`, 'm.volkova', final)).statusCode, 400); // второй раз нельзя
  const audit = await sql(`select after from audit_log where action = 'call.summary_saved' and object_id = $1`, [id]);
  assert.equal(audit.length, 1);

  // РОП оценивает, менеджер — нет
  assert.equal((await req('POST', `/api/calls/${id}/rating`, 'm.volkova', { rating: 'ok' })).statusCode, 403);
  assert.equal((await req('POST', `/api/calls/${id}/rating`, 'o.astafeva', { rating: 'minor', comment: 'добавила возражение' })).statusCode, 200);
  const q = (await req('GET', `/api/ai/quality?clubId=${c1}`, 'o.astafeva')).json();
  assert.equal(q.target, 80);
  assert.equal(q.total.confirmed, 1);
  assert.equal(q.total.accepted, 1);
  assert.equal(q.total.acceptedPct, 100);
  assert.equal(q.total.ratedOkPct, 100);
  assert.equal((await req('GET', `/api/ai/quality`, 'm.volkova')).statusCode, 403);
  const x = await req('GET', `/api/ai/summaries/export?clubId=${c1}&format=xlsx`, 'o.astafeva');
  assert.equal(x.rawPayload.subarray(0, 2).toString(), 'PK');
  const csv = await req('GET', `/api/ai/summaries/export?clubId=${c1}`, 'o.astafeva');
  assert.match(csv.body, /мелкие правки;добавила возражение/);
});

test('ИИ недоступен: повторы, затем «напишите итог вручную»; ручной итог', async () => {
  mode = 'down';
  const up = (await req('POST', '/api/calls/upload', 'o.astafeva', { clubId: c1, fileName: 'out-79005550099.wav', dataBase64: wav(2), userId: (await sql(`select id from users where login = 'm.volkova'`))[0].id })).json();
  assert.equal(up.personId, null); // такого телефона нет — разговор без клиента
  for (let i = 0; i < 3; i++) {
    await processCalls(t.pool, AI, t.storage);
    await sql(`update calls set next_try_at = now() where id = $1`, [up.id]);
  }
  const d = (await req('GET', `/api/calls/${up.id}`, 'm.volkova')).json();
  assert.equal(d.asrStatus, 'failed');
  assert.match(d.asrError, /503/);
  assert.equal(d.summary.status, 'needs_manual');
  assert.match((await sql(`select title from tasks where call_id = $1`, [up.id]))[0].title, /не распозналась/);
  // привязать к клиенту и написать итог самому
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Ручной Итог', phone: '+79005550098', sourceCode: 'site' })).json();
  assert.equal((await req('POST', `/api/calls/${up.id}/link`, 'm.volkova', { personId: lead.personId })).statusCode, 200);
  const r = (await req('POST', `/api/calls/${up.id}/summary`, 'm.volkova', { essence: 'Клиент перезвонит после отпуска', outcome: 'thinking' })).json();
  assert.equal(r.status, 'manual');
  assert.equal(r.editRatio, null);
  // повторная отправка ИИ: только для необработанных, и только РОПу
  assert.equal((await req('POST', `/api/calls/${up.id}/retry`, 'o.astafeva')).statusCode, 400);
  mode = 'ok';
});

test('контроль заполнения: черновик не проверен за N часов → в карточку и задача РОПу', async () => {
  assert.equal((await req('PUT', '/api/ai/settings', 'o.astafeva', { clubId: c1, fillControlHours: 3 })).statusCode, 403);
  assert.equal((await req('PUT', '/api/ai/settings', 'o.smirnov', { clubId: c1, fillControlHours: 0 })).statusCode, 400);
  assert.equal((await req('PUT', '/api/ai/settings', 'o.smirnov', { clubId: c1, fillControlHours: 1 })).statusCode, 200);
  assert.equal((await req('GET', `/api/ai/settings?clubId=${c1}`, 'm.volkova')).json().fillControlHours, 1);
  const lead = (await req('POST', '/api/leads', 'm.volkova', { clubId: c1, fullName: 'Забытый Звонок', phone: '+79005550077', sourceCode: 'site' })).json();
  const up = (await req('POST', '/api/calls/upload', 'm.volkova', { clubId: c1, fileName: '79005550077.wav', dataBase64: wav(3) })).json();
  await processCalls(t.pool, AI, t.storage);
  assert.equal((await req('GET', `/api/calls/${up.id}`, 'm.volkova')).json().summary.status, 'draft');
  await processCalls(t.pool, AI, t.storage); // час ещё не прошёл
  assert.equal((await req('GET', `/api/calls/${up.id}`, 'm.volkova')).json().summary.status, 'draft');
  await sql(`update call_summaries set created_at = now() - interval '61 minutes' where call_id = $1`, [up.id]);
  await processCalls(t.pool, AI, t.storage);
  const d = (await req('GET', `/api/calls/${up.id}`, 'm.volkova')).json();
  assert.equal(d.summary.status, 'auto_applied');
  assert.deepEqual(d.summary.final, d.summary.draft);
  const tasks = await sql(`select t.title, u.login, t.done_at, t.opportunity_id from tasks t join users u on u.id = t.assignee_id where t.call_id = $1 order by t.created_at`, [up.id]);
  assert.ok(tasks.some((x) => x.login === 'o.astafeva' && /Мария Волкова не проверил итог разговора с Забытый Звонок/.test(x.title)));
  assert.ok(tasks.some((x) => x.title === 'Пробная тренировка' && x.opportunity_id === lead.opportunityId));
  assert.ok(tasks.filter((x) => x.login === 'm.volkova' && /Проверьте итог/.test(x.title)).every((x) => x.done_at));
  // повторный проход не создаёт новых задач РОПу
  await processCalls(t.pool, AI, t.storage);
  assert.equal((await sql(`select count(*)::int as n from tasks where call_id = $1`, [up.id]))[0].n, tasks.length);
  // менеджер может поправить автоперенос: следующий шаг не дублируется
  const fix = (await req('POST', `/api/calls/${up.id}/summary`, 'm.volkova', { ...d.summary.draft, essence: 'Клиент хочет годовой абонемент, пробная в четверг.' })).json();
  assert.equal(fix.taskId, null);
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'ai.summary_auto_applied' and object_id = $1`, [up.id]))[0].n, 1);
});

test('недостаточно данных: ИИ не выдумывает, итог пишет менеджер; короткий разговор итога не требует', async () => {
  mode = 'insufficient';
  const up = (await req('POST', '/api/calls/upload', 'i.zuev', { clubId: c2, fileName: 'a.wav', dataBase64: wav(4) })).json();
  await processCalls(t.pool, AI, t.storage);
  const d = (await req('GET', `/api/calls/${up.id}`, 'i.zuev')).json();
  assert.equal(d.summary.status, 'needs_manual');
  assert.equal(d.summary.draft, null);
  assert.equal((await sql(`select after->>'reason' as r from audit_log where action = 'ai.summary_failed' and object_id = $1`, [up.id]))[0].r, 'Разговор не о клубе');
  mode = 'ok';
  // Нет ИИ-сервера: запись ждёт, РОП видит её в списке на проверку
  const off = await setupTestAppOff();
  try {
    const st = (await off.app.inject({ method: 'GET', url: '/api/ai/status', cookies: off.ck })).json();
    assert.equal(st.connected, false);
    const u = (await off.app.inject({ method: 'POST', url: '/api/calls/upload', cookies: off.ck, payload: { clubId: c2, fileName: 'b.wav', dataBase64: wav(5) } })).json();
    assert.equal(u.status, 'waiting_ai');
    await processCalls(t.pool, null, t.storage);
    assert.equal((await sql(`select asr_status from calls where id = $1`, [u.id]))[0].asr_status, 'waiting_ai');
    // ИИ подключили — запись уходит в работу
    await processCalls(t.pool, AI, t.storage);
    assert.equal((await sql(`select asr_status from calls where id = $1`, [u.id]))[0].asr_status, 'done');
  } finally { await off.app.close(); }
  const st = (await req('GET', '/api/ai/status', 'm.volkova')).json();
  assert.equal(st.connected, true);
  assert.equal(st.promptVersion, 'summary-v1');
});

// Второе приложение на той же базе, но без ИИ-сервера
async function setupTestAppOff() {
  const { buildApp } = await import('../src/app.ts');
  const app = await buildApp(t.pool, { storageDir: t.storage, ai: null });
  const ck = (await login(app as never, 'i.zuev')).cookie!;
  return { app, ck };
}
