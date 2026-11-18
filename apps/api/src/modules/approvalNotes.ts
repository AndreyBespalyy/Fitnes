// Уведомления о согласованиях (повторная проверка CRM 18.11.2026, п. 9): раньше о запросе сверх лимита согласующий узнавал
// только по счётчику на рабочем столе, а тот, кто просил (например, ресепшн с возвратом), не узнавал о решении.
import type { Db } from '../db.ts';
import { notify, staffOf } from './salesOps.ts';

const KIND: Record<string, string> = { refund: 'возврат', expense: 'расход', discount: 'скидка' };
const rub = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;
const what = (a: { kind: string; amountKop: number | null; percent?: number | null }) =>
  a.kind === 'discount' ? `скидка ${Number(a.percent ?? 0)} %` : `${KIND[a.kind] ?? a.kind} ${rub(Number(a.amountKop ?? 0))}`;
const LINK = { tab: 'finance', p: { view: 'approvals' } };

/** Кто решает: управляющий клуба, если запрос в пределах его лимита; иначе (или если управляющего нет) — собственник */
export async function notifyApprovalRequested(db: Db, a: { clubId: string; kind: string; amountKop: number | null; percent?: number | null; summary: string; requestedBy: string }) {
  const lim = (await db.query(`select max(max_amount_kop) as kop, max(max_percent) as pct from approval_limits where role_code = 'gm' and kind = $1`, [a.kind])).rows[0];
  const gmCan = a.kind === 'discount' ? lim?.pct != null && Number(lim.pct) >= Number(a.percent ?? 0) : lim?.kop != null && Number(lim.kop) >= Number(a.amountKop ?? 0);
  const gms = gmCan ? await staffOf(db, a.clubId, ['gm']) : [];
  const to = (gms.length ? gms : await staffOf(db, a.clubId, ['owner'])).map((u) => u.id).filter((id) => id !== a.requestedBy);
  const who = (await db.query('select full_name from users where id = $1', [a.requestedBy])).rows[0]?.full_name ?? 'Сотрудник';
  return notify(db, a.clubId, to, 'approval', `Нужно решение: ${what(a)}`.slice(0, 200), `${a.summary}. Запросил(а): ${who}.`.slice(0, 1000), LINK);
}

/** Тому, кто просил: одобрено или отказано, с комментарием */
export async function notifyApprovalDecided(db: Db, ap: { club_id: string; kind: string; amount_kop: number | null; percent?: number | null; summary: string; requested_by: string },
  approved: boolean, comment: string | null, deciderId: string) {
  if (!ap.requested_by || ap.requested_by === deciderId) return 0;
  const who = (await db.query('select full_name from users where id = $1', [deciderId])).rows[0]?.full_name ?? 'Руководитель';
  const t = `${approved ? 'Согласовано' : 'Отказано'}: ${what({ kind: ap.kind, amountKop: ap.amount_kop, percent: ap.percent })}`;
  return notify(db, ap.club_id, [ap.requested_by], 'approval_decided', t.slice(0, 200),
    `${ap.summary}. Решение: ${who}${comment ? `. Комментарий: ${comment}` : ''}.`.slice(0, 1000), LINK);
}
