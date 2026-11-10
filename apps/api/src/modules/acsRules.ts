// Шаг 11. Общие правила прохода, которые одинаково работают на сервере и в шлюзе клуба без интернета.
// Шлюз получает «снимок правил»: по каждой карте — пускать или нет, до какой даты, в какие часы.

export type Direction = 'in' | 'out';
export type Window = { from: string | null; to: string | null };
export type RuleEntry = {
  code: string; kind: string; holder: 'person' | 'staff'; name: string; personId: string | null; userId: string | null;
  allow: boolean; reasonCode: string; reason: string;
  validUntil: string | null;            // последний день, когда можно пускать без связи (дата клуба)
  windows: Window[] | null;             // часы тарифа; null — в любое время работы клуба
  warn?: string | null;                 // например, долг в льготный период
};
export type Snapshot = {
  version: string; generatedAt: string; clubId: string; clubName: string; timezone: string;
  openFrom: string; openTo: string; offlineHours: number;
  points: { id: string; name: string; direction: string }[];
  entries: RuleEntry[];
  commands: { id: string; pointId: string; kind: string }[];
};
export type Verdict = { allow: boolean; reasonCode: string; reason: string; name: string | null; personId: string | null; userId: string | null; warn?: string | null };

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
export const ruDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** Дата и время по часам клуба. */
export function localParts(at: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** Попадает ли время в окно «с — до». Окно через полночь (22:00–06:00) тоже поддерживается. */
export function inWindow(t: string, from: string | null, to: string | null) {
  const f = hm(from); const e = hm(to);
  if (!f && !e) return true;
  if (f && e && f === e) return true; // круглосуточно
  if (f && e && f > e) return t >= f || t < e;
  return (!f || t >= f) && (!e || t < e);
}
export const windowText = (w: Window) => (w.from && w.to && hm(w.from) === hm(w.to) ? 'круглосуточно' : w.from && w.to ? `с ${hm(w.from)} до ${hm(w.to)}` : w.from ? `с ${hm(w.from)}` : `до ${hm(w.to)}`);

/** Решение о проходе по снимку правил — так шлюз решает, когда нет связи с системой. */
export function offlineDecide(s: Snapshot, code: string, direction: Direction, at: Date): Verdict {
  const e = s.entries.find((x) => x.code === code.trim());
  if (!e) return { allow: false, reasonCode: 'unknown_card', reason: 'Карта не зарегистрирована', name: null, personId: null, userId: null };
  const who = { name: e.name, personId: e.personId, userId: e.userId };
  if (direction === 'out') return { allow: true, reasonCode: 'exit', reason: 'Выход', ...who };
  if (!e.allow) return { allow: false, reasonCode: e.reasonCode, reason: e.reason, ...who };
  if (e.holder === 'staff') return { allow: true, reasonCode: e.reasonCode, reason: e.reason, ...who };
  const { date, hm: now } = localParts(at, s.timezone);
  if (!inWindow(now, s.openFrom, s.openTo)) return { allow: false, reasonCode: 'club_closed', reason: `Клуб закрыт: работаем ${windowText({ from: s.openFrom, to: s.openTo })}`, ...who };
  if (e.validUntil && date > e.validUntil) return { allow: false, reasonCode: 'expired', reason: `Закончился ${ruDate(e.validUntil)}`, ...who };
  if (e.windows && !e.windows.some((w) => inWindow(now, w.from, w.to))) {
    return { allow: false, reasonCode: 'wrong_time', reason: `Не то время: тариф действует ${e.windows.map(windowText).join(', ')}`, ...who };
  }
  return { allow: true, reasonCode: e.reasonCode, reason: e.reason, warn: e.warn ?? null, ...who };
}

export const REASON_TITLES: Record<string, string> = {
  ok: 'Пропущен', staff: 'Сотрудник', exit: 'Выход', manual: 'Ручной проход',
  unknown_card: 'Карта не зарегистрирована', card_replaced: 'Карта заменена', card_lost: 'Карта утеряна', card_blocked: 'Карта заблокирована',
  no_membership: 'Нет абонемента', other_club: 'Абонемент другого клуба', expired: 'Абонемент закончился', frozen: 'Заморожен',
  not_started: 'Ещё не начался', used_up: 'Посещения закончились', debt: 'Долг', unsigned: 'Договор не подписан', cancelled: 'Расторгнут',
  wrong_time: 'Не то время', club_closed: 'Клуб закрыт', staff_other_club: 'Сотрудник другого клуба', staff_inactive: 'Сотрудник отключён',
};
