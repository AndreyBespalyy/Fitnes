// Сообщение сотруднику в Telegram через бота для сотрудников (modules/staffBot.ts).
// Бот появляется вместе с утренней сводкой; пока его нет, функция тихо ничего не делает.
import type pg from 'pg';
import { withCtx } from '../db.ts';

type NotifyFn = (db: pg.PoolClient, fetchImpl: typeof fetch, userId: string, text: string) => Promise<boolean>;
let cached: NotifyFn | null | undefined;

async function load(): Promise<NotifyFn | null> {
  if (cached !== undefined) return cached;
  try {
    const path = '../modules/staffBot.ts';
    const m = await import(path) as { notifyStaff?: NotifyFn };
    cached = typeof m.notifyStaff === 'function' ? m.notifyStaff : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Отправляет текст каждому сотруднику из списка. Возвращает, скольким ушло. Ошибки не прерывают работу. */
export async function notifyStaffSafe(pool: pg.Pool, tenantId: string, userIds: string[], text: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const fn = await load();
  if (!fn || !userIds.length) return 0;
  let sent = 0;
  for (const id of [...new Set(userIds)]) {
    try {
      const ok = await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, (db) => fn(db, fetchImpl, id, text));
      if (ok) sent++;
    } catch { /* сотрудник не подключил бота или бот недоступен */ }
  }
  return sent;
}
