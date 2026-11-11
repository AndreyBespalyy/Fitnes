// Состояние системы и оповещения о сбоях. Раз в минуту проверяются база, место на диске, ночная резервная копия,
// ошибки сервера, очереди чеков и сообщений, автосписания. О переходе в «плохо» и о восстановлении сообщаем в Telegram:
// — сбои платформы (диск, копии, ошибки) — в служебный чат оператора (ALERT_TELEGRAM_BOT_TOKEN и ALERT_TELEGRAM_CHAT_ID в .env);
// — сбои сети клубов (чеки, автосписания, рассылки) — собственнику и администратору через бота для сотрудников.
import { statfsSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { audit, withCtx } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { notifyStaffSafe } from '../lib/staffNotify.ts';

export type Status = 'ok' | 'warn' | 'bad';
export type Check = { code: string; title: string; status: Status; value: number | null; detail: string; scope: string };
type MonitorOpts = { storage: string; backupDir?: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv };

const REPEAT_MS = 6 * 3600_000; // пока проблема не решена — напоминание раз в 6 часов

/* --- ошибки сервера за последние 10 минут (считаются в app.ts) --- */
const errors: number[] = [];
let requests = 0;
export function recordResponse(status: number) {
  requests++;
  if (status >= 500) errors.push(Date.now());
}
function recentErrors(now = Date.now()) {
  while (errors.length && errors[0] < now - 10 * 60_000) errors.shift();
  return errors.length;
}
export function resetMonitorCounters() { errors.length = 0; requests = 0; }

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} ГБ`;
const hoursAgo = (t: number) => Math.round((Date.now() - t) / 3600_000);

export async function runChecks(pool: pg.Pool, opts: MonitorOpts): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Omit<Check, 'scope'>, scope = 'platform') => out.push({ ...c, scope });

  // База данных
  const t0 = Date.now();
  try {
    await pool.query('select 1');
    const ms = Date.now() - t0;
    add({ code: 'db', title: 'База данных', status: ms > 2000 ? 'warn' : 'ok', value: ms, detail: `отвечает за ${ms} мс` });
  } catch (e) {
    add({ code: 'db', title: 'База данных', status: 'bad', value: null, detail: `не отвечает: ${(e as Error).message}` });
    return out;
  }

  // Место на диске (папка с файлами договоров, сканами и записями звонков)
  try {
    const s = statfsSync(opts.storage);
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
    const pct = total ? Math.round((free / total) * 100) : 100;
    add({ code: 'disk', title: 'Место на диске', status: pct < 5 || free < 1024 ** 3 ? 'bad' : pct < 15 ? 'warn' : 'ok', value: pct, detail: `свободно ${gb(free)} из ${gb(total)} (${pct} %)` });
  } catch {
    add({ code: 'disk', title: 'Место на диске', status: 'warn', value: null, detail: 'не удалось проверить папку с файлами' });
  }

  // Ночная резервная копия: сервер пишет отметку last-ok после каждой успешной копии (deploy/backup.sh)
  if (opts.backupDir) {
    const mark = join(opts.backupDir, 'last-ok');
    if (!existsSync(mark)) add({ code: 'backup', title: 'Резервная копия', status: 'bad', value: null, detail: 'ни одной успешной копии не найдено' });
    else {
      const h = hoursAgo(statSync(mark).mtimeMs);
      add({ code: 'backup', title: 'Резервная копия', status: h > 30 ? 'bad' : h > 26 ? 'warn' : 'ok', value: h, detail: `последняя успешная ${h} ч назад` });
    }
  } else {
    add({ code: 'backup', title: 'Резервная копия', status: 'warn', value: null, detail: 'проверка не подключена: на сервере не указана папка копий (BACKUP_DIR)' });
  }

  // Ошибки сервера
  const e = recentErrors();
  add({ code: 'errors', title: 'Ошибки сервера', status: e >= 20 ? 'bad' : e >= 5 ? 'warn' : 'ok', value: e, detail: `${e} за последние 10 минут` });

  // Память процесса
  const rss = process.memoryUsage().rss;
  add({ code: 'memory', title: 'Память приложения', status: rss > 2 * 1024 ** 3 ? 'warn' : 'ok', value: Math.round(rss / 1024 ** 2), detail: `${Math.round(rss / 1024 ** 2)} МБ` });

  // Очереди и сбои по каждой сети клубов
  const rows = (await pool.query('select * from monitor_tenant_counts()')).rows;
  for (const r of rows) {
    const scope = r.tenant_id as string;
    add({ code: 'receipts', title: 'Чеки в кассу', status: r.receipts_stuck > 0 ? 'bad' : r.receipts_failed > 0 ? 'warn' : 'ok', value: r.receipts_stuck,
      detail: r.receipts_stuck > 0 ? `${r.receipts_stuck} чеков не ушли в кассу дольше 30 минут` : r.receipts_failed > 0 ? `${r.receipts_failed} чеков с ошибкой за сутки` : 'все чеки уходят' }, scope);
    add({ code: 'messages', title: 'Сообщения клиентам', status: r.msg_stuck > 5 ? 'bad' : r.msg_stuck > 0 ? 'warn' : 'ok', value: r.msg_stuck,
      detail: r.msg_stuck > 0 ? `${r.msg_stuck} сообщений ждут отправки дольше 15 минут` : 'очередь пуста' }, scope);
    add({ code: 'autopay', title: 'Автосписания', status: r.online_stuck > 0 ? 'bad' : r.autopay_failed > 0 ? 'warn' : 'ok', value: r.autopay_failed,
      detail: r.online_stuck > 0 ? `${r.online_stuck} списаний без ответа банка дольше 2 часов` : r.autopay_failed > 0 ? `${r.autopay_failed} неудачных списаний за сутки (повтор по правилам клуба)` : 'без сбоев' }, scope);
  }
  return out;
}

/* --- оповещения --- */
export async function sendOperatorAlert(text: string, opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  const token = env.ALERT_TELEGRAM_BOT_TOKEN, chat = env.ALERT_TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await (opts.fetch ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch { return false; }
}

const ICON: Record<Status, string> = { ok: '✅', warn: '🟡', bad: '🔴' };
const host = (env: NodeJS.ProcessEnv) => env.PUBLIC_URL || env.APP_HOST || 'Клубная ОС';

/** Сохраняет результаты и рассылает оповещения о переходах (стало плохо / восстановилось) и напоминания. */
export async function processChecks(pool: pg.Pool, checks: Check[], opts: MonitorOpts) {
  const env = opts.env ?? process.env;
  const notes: { scope: string; text: string }[] = [];
  for (const c of checks) {
    const prev = (await pool.query('select status, since, notified_at from monitor_state where scope = $1 and check_code = $2', [c.scope, c.code])).rows[0];
    const changed = !prev || prev.status !== c.status;
    let notify = false;
    if (c.status === 'bad' && (changed || !prev?.notified_at || Date.now() - new Date(prev.notified_at).getTime() > REPEAT_MS)) notify = true;
    if (c.status === 'ok' && prev && prev.status === 'bad' && prev.notified_at) notify = true; // восстановилось — после сообщения о сбое
    await pool.query(
      `insert into monitor_state(scope, check_code, status, value, detail, since, checked_at, notified_at) values ($1,$2,$3,$4,$5, now(), now(), $6)
       on conflict (scope, check_code) do update set status = excluded.status, value = excluded.value, detail = excluded.detail, checked_at = now(),
         since = case when monitor_state.status = excluded.status then monitor_state.since else now() end,
         notified_at = case when $7 then excluded.notified_at when excluded.status = 'ok' then null else monitor_state.notified_at end`,
      [c.scope, c.code, c.status, c.value, c.detail, notify ? new Date() : null, notify]);
    if (notify) notes.push({ scope: c.scope, text: c.status === 'ok' ? `${ICON.ok} Восстановлено: ${c.title} — ${c.detail}` : `${ICON.bad} ${c.title}: ${c.detail}` });
  }
  const platform = notes.filter((n) => n.scope === 'platform').map((n) => n.text);
  if (platform.length) await sendOperatorAlert(`${host(env)}\n${platform.join('\n')}`, opts);
  for (const scope of [...new Set(notes.filter((n) => n.scope !== 'platform').map((n) => n.scope))]) {
    const text = notes.filter((n) => n.scope === scope).map((n) => n.text).join('\n');
    const ids = await withCtx(pool, { tenantId: scope, allClubs: true, clubIds: [] }, async (db) => (await db.query(
      `select distinct a.user_id from user_assignments a join users u on u.id = a.user_id where a.role_code in ('owner', 'admin') and u.status = 'active'`)).rows.map((r) => r.user_id as string));
    await notifyStaffSafe(pool, scope, ids, `Состояние системы\n${text}\nПодробности — в разделе «Состояние системы»`, opts.fetch ?? fetch);
    await sendOperatorAlert(`${host(env)} · сеть ${scope.slice(0, 8)}\n${text}`, opts);
  }
  return notes;
}

export function startMonitorWorker(pool: pg.Pool, opts: MonitorOpts, everyMs = 60_000) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { await processChecks(pool, await runChecks(pool, opts), opts); } catch (e) { console.error('Ошибка проверки состояния:', (e as Error).message); } finally { busy = false; }
  };
  const first = setTimeout(run, 30_000); first.unref();
  const t = setInterval(run, everyMs); t.unref();
  return () => { clearTimeout(first); clearInterval(t); };
}

const started = Date.now();
export function monitorRoutes(app: FastifyInstance, pool: pg.Pool, opts: MonitorOpts) {
  // Состояние: проверки платформы и своей сети. Обновить можно кнопкой — проверка выполнится сразу
  app.get('/api/system/status', async (req) => {
    const ctx = requirePerm(req, P.systemMonitor);
    const { refresh } = req.query as { refresh?: string };
    if (refresh === '1') await processChecks(pool, await runChecks(pool, opts), opts);
    const rows = (await pool.query(
      `select scope, check_code as code, status, value, detail, since, checked_at as "checkedAt", notified_at as "notifiedAt" from monitor_state
       where scope in ('platform', $1) order by scope = 'platform' desc, check_code`, [ctx.tenantId])).rows;
    const env = opts.env ?? process.env;
    return {
      checks: rows, version: env.APP_VERSION ?? null, startedAt: new Date(started).toISOString(), requests,
      operatorAlerts: !!(env.ALERT_TELEGRAM_BOT_TOKEN && env.ALERT_TELEGRAM_CHAT_ID),
    };
  });

  app.post('/api/system/test-alert', async (req) => {
    const ctx = requirePerm(req, P.systemMonitor);
    const text = `${ICON.ok} Проверка оповещений: сообщение из раздела «Состояние системы». Если вы его видите, оповещения о сбоях работают`;
    const operator = await sendOperatorAlert(`${host(opts.env ?? process.env)}\n${text}`, opts);
    const staff = await notifyStaffSafe(pool, ctx.tenantId, [ctx.userId], text, opts.fetch ?? fetch);
    await withCtx(pool, ctx, (db) => audit(db, ctx, 'system.test_alert', 'user', ctx.userId, null, { operator, staff }));
    return { operator, staff };
  });
}
