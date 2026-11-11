// Сообщение сотрудникам в Telegram через бота для сотрудников (modules/staffBot.ts).
// Текст передаётся обычный: здесь он экранируется, потому что бот отправляет HTML.
import type pg from 'pg';
import { withCtx } from '../db.ts';
import { escapeHtml, notifyStaff } from '../modules/staffBot.ts';

/** Отправляет текст каждому сотруднику из списка. Возвращает, скольким ушло. Ошибки не прерывают работу. */
export async function notifyStaffSafe(pool: pg.Pool, tenantId: string, userIds: string[], text: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!userIds.length) return 0;
  const html = escapeHtml(text);
  let sent = 0;
  for (const id of [...new Set(userIds)]) {
    try {
      const ok = await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, (db) => notifyStaff(db, fetchImpl, id, html));
      if (ok) sent++;
    } catch { /* сотрудник не подключил бота или бот недоступен */ }
  }
  return sent;
}
