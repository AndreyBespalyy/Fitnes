// Шаг 9. Распознавание отчётов 1С: какой это отчёт, где строка заголовка, какая колонка — какое наше поле.
// Распознавание по словарю названий колонок с уровнем уверенности. Решение о спорном всегда за человеком.
import { createHash } from 'node:crypto';
import { normalizePhone } from './crm.ts';

export type ReportType = 'clients' | 'memberships' | 'payments' | 'visits' | 'balances';
export const REPORT_TYPES: ReportType[] = ['clients', 'memberships', 'payments', 'visits', 'balances'];
export const REPORT_NAMES: Record<ReportType, string> = {
  clients: 'Клиенты', memberships: 'Абонементы и договоры', payments: 'Платежи', visits: 'Посещения', balances: 'Остатки и долги',
};

type Kind = 'text' | 'date' | 'datetime' | 'money' | 'int' | 'phone' | 'email';
export type FieldDef = { key: string; label: string; kind: Kind; required?: boolean; weight: number; syn: string[] };

const CLIENT_LINK: FieldDef[] = [
  { key: 'client_ext', label: 'Код клиента', kind: 'text', weight: 1, syn: ['код клиента', 'id клиента', 'клиент код', 'номер клиента', 'код контрагента', 'код физлица'] },
  { key: 'client_name', label: 'Клиент (ФИО)', kind: 'text', weight: 1, syn: ['клиент', 'фио', 'фио клиента', 'контрагент', 'владелец', 'покупатель', 'физическое лицо', 'член клуба'] },
  { key: 'client_phone', label: 'Телефон клиента', kind: 'phone', weight: 0.5, syn: ['телефон', 'телефон клиента', 'мобильный телефон', 'моб телефон'] },
];
const MEMBERSHIP_LINK: FieldDef[] = [
  { key: 'membership_ext', label: 'Код абонемента', kind: 'text', weight: 0.5, syn: ['код абонемента', 'номер абонемента', 'id абонемента', 'абонемент код'] },
  { key: 'contract_number', label: 'Номер договора', kind: 'text', weight: 0.5, syn: ['номер договора', 'договор', 'договор номер', 'договор клиента', 'основание'] },
];

export const FIELDS: Record<ReportType, FieldDef[]> = {
  clients: [
    { key: 'ext_id', label: 'Код клиента', kind: 'text', weight: 1, syn: ['код клиента', 'код', 'id', 'id клиента', 'номер клиента', 'код контрагента', 'код физлица'] },
    { key: 'full_name', label: 'ФИО', kind: 'text', required: true, weight: 2, syn: ['фио', 'клиент', 'фамилия имя отчество', 'контрагент', 'наименование', 'физическое лицо', 'член клуба', 'имя'] },
    { key: 'phone', label: 'Телефон', kind: 'phone', weight: 2, syn: ['телефон', 'мобильный телефон', 'моб телефон', 'телефон мобильный', 'контактный телефон', 'сотовый телефон', 'сотовый'] },
    { key: 'email', label: 'Эл. почта', kind: 'email', weight: 1, syn: ['email', 'e mail', 'электронная почта', 'почта', 'эл почта', 'адрес электронной почты'] },
    { key: 'birth_date', label: 'Дата рождения', kind: 'date', weight: 2, syn: ['дата рождения', 'день рождения', 'др'] },
    { key: 'card', label: 'Номер карты', kind: 'text', weight: 1, syn: ['номер карты', 'карта', 'карта клиента', 'штрихкод', 'штрих код', 'номер браслета'] },
    { key: 'registered_on', label: 'Дата регистрации', kind: 'date', weight: 1, syn: ['дата регистрации', 'дата создания', 'зарегистрирован', 'дата анкеты', 'дата добавления'] },
    { key: 'comment', label: 'Комментарий', kind: 'text', weight: 0.3, syn: ['комментарий', 'примечание'] },
  ],
  memberships: [
    { key: 'ext_id', label: 'Код абонемента', kind: 'text', weight: 1, syn: ['код абонемента', 'номер абонемента', 'id абонемента', 'абонемент код', 'код'] },
    ...CLIENT_LINK,
    { key: 'contract_number', label: 'Номер договора', kind: 'text', weight: 1, syn: ['номер договора', 'договор', 'договор номер', 'договор клиента'] },
    { key: 'contract_date', label: 'Дата договора', kind: 'date', weight: 1, syn: ['дата договора', 'дата продажи', 'дата оформления', 'дата покупки'] },
    { key: 'product_name', label: 'Абонемент (название)', kind: 'text', required: true, weight: 3, syn: ['вид абонемента', 'абонемент', 'услуга', 'номенклатура', 'тариф', 'вид членства', 'членство', 'наименование абонемента', 'вид карты'] },
    { key: 'starts_on', label: 'Дата начала', kind: 'date', required: true, weight: 2, syn: ['дата начала', 'начало', 'действует с', 'дата активации', 'начало действия', 'с'] },
    { key: 'ends_on', label: 'Дата окончания', kind: 'date', weight: 3, syn: ['дата окончания', 'окончание', 'действует по', 'действует до', 'срок действия', 'дата завершения', 'окончание действия', 'по'] },
    { key: 'amount', label: 'Стоимость', kind: 'money', weight: 1, syn: ['стоимость', 'сумма', 'цена', 'сумма договора', 'стоимость абонемента', 'сумма продажи'] },
    { key: 'visits_total', label: 'Всего посещений', kind: 'int', weight: 0.5, syn: ['количество посещений', 'всего посещений', 'посещений всего', 'количество занятий', 'занятий всего'] },
    { key: 'visits_left', label: 'Остаток посещений', kind: 'int', weight: 1, syn: ['остаток посещений', 'осталось посещений', 'остаток занятий', 'осталось занятий', 'остаток'] },
    { key: 'status', label: 'Состояние', kind: 'text', weight: 1, syn: ['статус', 'состояние', 'статус абонемента'] },
  ],
  payments: [
    { key: 'ext_id', label: 'Номер документа', kind: 'text', weight: 1, syn: ['номер документа', 'номер', 'документ', 'номер чека', 'код операции', 'номер платежа'] },
    { key: 'date', label: 'Дата оплаты', kind: 'datetime', required: true, weight: 2, syn: ['дата оплаты', 'дата платежа', 'дата', 'дата операции', 'дата документа', 'период', 'дата и время'] },
    ...CLIENT_LINK,
    ...MEMBERSHIP_LINK,
    { key: 'amount', label: 'Сумма', kind: 'money', required: true, weight: 3, syn: ['сумма', 'сумма оплаты', 'оплачено', 'сумма платежа', 'приход', 'сумма документа', 'сумма руб'] },
    { key: 'method', label: 'Способ оплаты', kind: 'text', weight: 2, syn: ['вид оплаты', 'способ оплаты', 'форма оплаты', 'тип оплаты', 'касса', 'вид расчета'] },
    { key: 'operation', label: 'Операция (оплата или возврат)', kind: 'text', weight: 1, syn: ['операция', 'вид операции', 'тип операции', 'вид документа', 'тип документа', 'вид движения'] },
    { key: 'comment', label: 'Комментарий', kind: 'text', weight: 0.3, syn: ['комментарий', 'примечание', 'назначение'] },
  ],
  visits: [
    { key: 'ext_id', label: 'Код посещения', kind: 'text', weight: 0.5, syn: ['код посещения', 'номер посещения', 'id посещения'] },
    { key: 'visited_at', label: 'Дата и время посещения', kind: 'datetime', required: true, weight: 3, syn: ['дата посещения', 'время входа', 'дата и время посещения', 'дата визита', 'вход', 'время посещения', 'посещение', 'дата и время', 'дата'] },
    { key: 'left_at', label: 'Время выхода', kind: 'datetime', weight: 2, syn: ['время выхода', 'выход', 'дата выхода'] },
    ...CLIENT_LINK,
    ...MEMBERSHIP_LINK,
    { key: 'zone', label: 'Зона или занятие', kind: 'text', weight: 1, syn: ['зона', 'зал', 'занятие', 'услуга', 'вид посещения'] },
  ],
  balances: [
    ...CLIENT_LINK,
    ...MEMBERSHIP_LINK,
    { key: 'debt', label: 'Долг клиента', kind: 'money', weight: 3, syn: ['долг', 'задолженность', 'сумма долга', 'к оплате', 'дебиторская задолженность', 'долг клиента', 'задолженность клиента'] },
    { key: 'advance', label: 'Аванс (деньги клиента)', kind: 'money', weight: 3, syn: ['аванс', 'остаток денег', 'депозит', 'баланс', 'на счете', 'предоплата', 'остаток средств', 'остаток на счете', 'лицевой счет'] },
    { key: 'due_on', label: 'Оплатить до', kind: 'date', weight: 1, syn: ['срок оплаты', 'оплатить до', 'дата долга', 'дата платежа', 'дата'] },
  ],
};

const FILE_HINTS: [ReportType, RegExp][] = [
  ['clients', /клиент|анкет|контрагент|физлиц|client/i],
  ['memberships', /абонем|договор|членств|membership|contract/i],
  ['payments', /оплат|платеж|платёж|касс|поступлен|payment/i],
  ['visits', /посещ|визит|проход|visit/i],
  ['balances', /долг|остат|задолж|баланс|balance|debt/i],
];

export const normHeader = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

function fieldScore(header: string, f: FieldDef): number {
  const h = normHeader(header);
  if (!h) return 0;
  let best = 0;
  for (const s of f.syn) {
    if (h === s) return 1;
    if (s.length >= 3 && (` ${h} `).includes(` ${s} `)) best = Math.max(best, 0.7 * Math.min(1, s.length / h.length + 0.3));
  }
  return best;
}

export type Mapping = Record<string, { col: number; confidence: number } | null>;

/** Сопоставляет колонки с полями отчёта: каждой колонке не больше одного поля. */
export function mapColumns(type: ReportType, headers: string[]): { mapping: Mapping; score: number } {
  const cands: { key: string; col: number; s: number; w: number }[] = [];
  for (const f of FIELDS[type]) headers.forEach((h, col) => { const s = fieldScore(h, f); if (s > 0) cands.push({ key: f.key, col, s, w: f.weight }); });
  cands.sort((a, b) => b.s - a.s || b.w - a.w);
  const mapping: Mapping = Object.fromEntries(FIELDS[type].map((f) => [f.key, null]));
  const usedCols = new Set<number>();
  for (const c of cands) {
    if (mapping[c.key] || usedCols.has(c.col)) continue;
    mapping[c.key] = { col: c.col, confidence: Math.round(c.s * 100) / 100 };
    usedCols.add(c.col);
  }
  const total = FIELDS[type].reduce((x, f) => x + f.weight, 0);
  const got = FIELDS[type].reduce((x, f) => x + (mapping[f.key] ? f.weight * mapping[f.key]!.confidence : 0), 0);
  const requiredOk = FIELDS[type].filter((f) => f.required).every((f) => mapping[f.key]);
  return { mapping, score: requiredOk ? got / total : (got / total) * 0.4 };
}

/** Ищет строку заголовка среди первых строк (в отчётах 1С сверху бывают название отчёта и период). */
export function findHeaderRow(rows: string[][]): number {
  let best = -1; let bestScore = 0;
  const all = Object.values(FIELDS).flat();
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].filter((c) => c !== '');
    if (cells.length < 2) continue;
    const score = cells.filter((c) => all.some((f) => fieldScore(c, f) >= 0.7)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  if (best >= 0 && bestScore >= 2) return best;
  return Math.max(0, rows.findIndex((r) => r.filter((c) => c !== '').length >= 2));
}

export type Detection = { type: ReportType; confidence: number; mapping: Mapping; candidates: { type: ReportType; score: number }[] };

export function detectReport(headers: string[], fileName: string): Detection {
  const scored = REPORT_TYPES.map((type) => {
    const { mapping, score } = mapColumns(type, headers);
    const hint = FILE_HINTS.find(([t, re]) => t === type && re.test(fileName)) ? 0.15 : 0;
    return { type, mapping, score: Math.min(1, score + hint) };
  }).sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  // Уверенность ниже, если второй вариант почти так же хорош
  const margin = first.score - (second?.score ?? 0);
  const confidence = Math.max(0, Math.min(1, first.score * (margin >= 0.2 ? 1 : 0.6 + margin * 2)));
  return { type: first.type, confidence: Math.round(confidence * 1000) / 1000, mapping: first.mapping, candidates: scored.map((s) => ({ type: s.type, score: Math.round(s.score * 100) / 100 })) };
}

export const headerSignature = (headers: string[]) => createHash('sha256').update(headers.map(normHeader).join('|')).digest('hex').slice(0, 32);

/* ---------- разбор значений ---------- */
const pad = (n: number | string) => String(n).padStart(2, '0');

/** «ДД.ММ.ГГГГ», «ДД.ММ.ГГ», «ГГГГ-ММ-ДД», с временем или без → { date: 'ГГГГ-ММ-ДД', time: 'ЧЧ:ММ:СС' | null }. */
export function parseDate(raw: string): { date: string; time: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number; let m: number; let d: number; let rest = '';
  let r = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(.*)$/);
  if (r) { d = +r[1]; m = +r[2]; y = +r[3]; rest = r[4]; if (r[3].length === 2) y += y < 50 ? 2000 : 1900; }
  else {
    r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/);
    if (!r) return null;
    y = +r[1]; m = +r[2]; d = +r[3]; rest = r[4];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  const t = rest.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const time = t && +t[1] < 24 && +t[2] < 60 ? `${pad(t[1])}:${t[2]}:${t[3] ?? '00'}` : null;
  return { date: `${y}-${pad(m)}-${pad(d)}`, time };
}

/** Сумма в копейках без округлений: «1 500,00», «1500.5», «-200», «(200,00)», «1 500 руб.». null — не сумма. */
export function parseMoney(raw: string): number | null {
  let s = raw.replace(/[\s  ]/g, '').replace(/(руб\.?|р\.|₽|rub)$/i, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, ''); // 1,500.00
  s = s.replace(',', '.');
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) {
    // Excel хранит числа с плавающей точкой: 1499.9999999999998
    if (/^\d+\.\d{3,}$/.test(s)) { const k = Math.round(Number(s) * 100); return neg ? -k : k; }
    return null;
  }
  const kop = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(kop)) return null;
  return neg ? -kop : kop;
}

export function parseInt10(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, '').replace(/[.,]0+$/, '');
  return /^-?\d{1,6}$/.test(s) ? Number(s) : null;
}

export const normName = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const normEmail = (s: string) => { const e = s.trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null; };
export { normalizePhone };

export function methodOf(raw: string): string {
  const s = raw.toLowerCase().replace(/ё/g, 'е');
  if (!s) return 'other';
  if (/безнал|карт|эквайр|терминал|pos|visa|мир|mastercard/.test(s)) return 'card_terminal';
  if (/сбп|qr|быстр/.test(s)) return 'sbp';
  if (/нал/.test(s)) return 'cash';
  if (/банк|перевод|расчетн|платежн|счет/.test(s)) return 'bank_transfer';
  if (/онлайн|сайт|интернет|online/.test(s)) return 'online';
  return 'other';
}

export const isFooter = (cells: string[]) => /^(итог|всего)/i.test(cells.find((c) => c !== '') ?? '');
