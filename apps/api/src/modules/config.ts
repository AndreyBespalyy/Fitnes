// Шаг 18, часть 2. Настройки клуба как версии (FR-CFG-03/05/06/08/09/12; AT08–AT10, AT39).
// Черновик → проверка (данные, права, не поменялось ли рабочее, проверка на истории) → утверждение → публикация → откат.
// ИИ-помощник только готовит черновик: рабочие настройки меняет человек, утвердив конкретное содержимое.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { aiConfigFromEnv, aiConfigSuggest } from '../lib/aiClient.ts';
import { DEFAULT_NORMS, KPI } from './dash.ts';
import { candidates } from './messaging.ts';

/* ---------- что настраивается ---------- */
type FieldType = 'int' | 'num' | 'bool' | 'text' | 'checklist' | 'money';
export type Field = { path: string; section: string; label: string; type: FieldType; min?: number; max?: number; unit?: string; nullable?: boolean; hint?: string };
export type ChecklistItem = { id: string; text: string; weight: number };

export const SECTIONS: { id: string; title: string; perm: string }[] = [
  { id: 'club', title: 'Работа с заявками', perm: P.clubsManage },
  { id: 'membership', title: 'Абонементы: заморозка, рассрочка, долги', perm: P.tariffsManage },
  { id: 'kpi', title: 'Нормы KPI и светофор плана', perm: P.planManage },
  { id: 'messaging', title: 'Сообщения клиентам', perm: P.messagesManage },
  { id: 'ai', title: 'Звонки и ИИ', perm: P.planManage },
  { id: 'sales', title: 'Стандарт продаж: чек-лист разговора', perm: P.planManage },
];

export const EVENT_NAMES: Record<string, { name: string; days: string }> = {
  membership_ending: { name: 'Окончание абонемента', days: 'за сколько дней до окончания' },
  debt_overdue: { name: 'Напоминание о долге', days: 'через сколько дней просрочки' },
  inactive: { name: 'Давно не были', days: 'после скольких дней без визитов' },
  birthday: { name: 'День рождения', days: 'дней (не используется)' },
  welcome: { name: 'Добро пожаловать', days: 'дней (не используется)' },
  ai_nurture: { name: 'Подогрев от ИИ', days: 'не чаще раза в N дней' },
};

const MEMBERSHIP: [key: string, col: string, label: string, type: FieldType, min: number, max: number, unit?: string][] = [
  ['freezeEnabled', 'freeze_enabled', 'Заморозка разрешена', 'bool', 0, 1],
  ['freezeMaxDaysPerYear', 'freeze_max_days_per_year', 'Заморозка: дней в год', 'int', 0, 365, 'дн.'],
  ['freezeMaxTimesPerYear', 'freeze_max_times_per_year', 'Заморозка: раз в год', 'int', 0, 52, 'раз'],
  ['freezeMinDays', 'freeze_min_days', 'Заморозка: минимум дней за раз', 'int', 1, 365, 'дн.'],
  ['freezePaid', 'freeze_paid', 'Заморозка платная', 'bool', 0, 1],
  ['freezePriceKop', 'freeze_price_kop', 'Стоимость заморозки', 'money', 0, 1e9],
  ['installmentsEnabled', 'installments_enabled', 'Рассрочка разрешена', 'bool', 0, 1],
  ['installmentsMaxPayments', 'installments_max_payments', 'Рассрочка: платежей не больше', 'int', 2, 24, 'шт.'],
  ['overdueBlockAfterDays', 'overdue_block_after_days', 'Закрыть проход при долге через', 'int', 0, 60, 'дн.'],
  ['subscriptionRetryAttempts', 'subscription_retry_attempts', 'Подписка: попыток списания', 'int', 1, 10, 'шт.'],
  ['subscriptionRetryIntervalDays', 'subscription_retry_interval_days', 'Подписка: дней между попытками', 'int', 1, 15, 'дн.'],
  ['renewalReminderDays', 'renewal_reminder_days', 'Напомнить о продлении за', 'int', 1, 90, 'дн.'],
];
const MSG: [key: string, col: string, label: string, type: FieldType, min: number, max: number, unit?: string][] = [
  ['workFrom', 'work_from', 'Рабочее время: с', 'int', 0, 23, 'ч'],
  ['workTo', 'work_to', 'Рабочее время: до', 'int', 1, 24, 'ч'],
  ['autoreplyEnabled', 'autoreply_enabled', 'Автоответ в нерабочее время', 'bool', 0, 1],
  ['autoreplyText', 'autoreply_text', 'Текст автоответа', 'text', 1, 500],
  ['maxAutoPerWeek', 'max_auto_per_week', 'Автосообщений одному клиенту в неделю, не больше', 'int', 0, 14, 'шт.'],
];

export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { id: 'greet', text: 'Поздоровался, представился и назвал клуб', weight: 1 },
  { id: 'need', text: 'Выяснил цель, опыт и удобное время тренировок', weight: 3 },
  { id: 'present', text: 'Рассказал о клубе под потребность клиента', weight: 2 },
  { id: 'objections', text: 'Отработал возражения, а не согласился с ними', weight: 2 },
  { id: 'offer', text: 'Предложил конкретный тариф и цену', weight: 2 },
  { id: 'next', text: 'Договорился о следующем шаге: дата и время визита или звонка', weight: 3 },
  { id: 'close', text: 'Подвёл итог и попрощался', weight: 1 },
];

export function fieldsFor(events: string[]): Field[] {
  const f: Field[] = [
    { path: 'club.firstResponseMinutes', section: 'club', label: 'Срок первого ответа на заявку', type: 'int', min: 1, max: 1440, unit: 'мин' },
  ];
  for (const [k, , label, type, min, max, unit] of MEMBERSHIP) f.push({ path: `membership.${k}`, section: 'membership', label, type, min, max, unit });
  for (const k of KPI) f.push({ path: `kpi.norms.${k.id}`, section: 'kpi', label: `Норма в день: ${k.name.toLowerCase()}`, type: 'num', min: 0, max: 10000, nullable: true, hint: 'пусто — без нормы' });
  f.push({ path: 'kpi.lightGreen', section: 'kpi', label: 'Светофор: зелёный от', type: 'int', min: 1, max: 200, unit: '% темпа плана' });
  f.push({ path: 'kpi.lightYellow', section: 'kpi', label: 'Светофор: жёлтый от', type: 'int', min: 1, max: 200, unit: '% темпа плана' });
  for (const [k, , label, type, min, max, unit] of MSG) f.push({ path: `messaging.${k}`, section: 'messaging', label, type, min, max, unit });
  for (const e of events) {
    const n = EVENT_NAMES[e]?.name ?? e;
    f.push({ path: `messaging.triggers.${e}.enabled`, section: 'messaging', label: `«${n}»: отправлять`, type: 'bool' });
    if (!['birthday', 'welcome'].includes(e)) f.push({ path: `messaging.triggers.${e}.days`, section: 'messaging', label: `«${n}»: ${EVENT_NAMES[e]?.days ?? 'дней'}`, type: 'int', min: 0, max: 365, unit: 'дн.' });
    f.push({ path: `messaging.triggers.${e}.sendHour`, section: 'messaging', label: `«${n}»: не раньше`, type: 'int', min: 0, max: 23, unit: 'ч' });
  }
  f.push({ path: 'ai.fillControlHours', section: 'ai', label: 'Итог звонка проверить через', type: 'int', min: 1, max: 72, unit: 'ч' });
  f.push({ path: 'sales.items', section: 'sales', label: 'Пункты чек-листа разговора', type: 'checklist' });
  return f;
}

/* ---------- чтение и запись рабочих настроек ---------- */
export type ConfigDoc = Record<string, unknown>;

export async function readLive(db: Db, clubId: string): Promise<ConfigDoc> {
  const club = (await db.query('select first_response_minutes from clubs where id = $1', [clubId])).rows[0];
  if (!club) throw notFound('Клуб не найден');
  const m = (await db.query('select * from club_membership_settings where club_id = $1', [clubId])).rows[0] ?? {};
  const kpiRows = (await db.query('select metric, per_day::float as v from kpi_norms where club_id = $1', [clubId])).rows as { metric: string; v: number }[];
  const kv = (k: string) => kpiRows.find((r) => r.metric === k)?.v;
  const ms = (await db.query('select * from club_msg_settings where club_id = $1', [clubId])).rows[0] ?? {};
  const trig = (await db.query('select event, enabled, days, send_hour from msg_triggers where club_id = $1 order by event', [clubId])).rows;
  const ai = (await db.query('select fill_control_hours from ai_settings where club_id = $1', [clubId])).rows[0];
  const std = (await db.query('select items from sales_standards where club_id = $1 order by version_no desc limit 1', [clubId])).rows[0];
  const mdef: Record<string, unknown> = { freeze_enabled: true, freeze_max_days_per_year: 30, freeze_max_times_per_year: 2, freeze_min_days: 7, freeze_paid: false, freeze_price_kop: 0,
    installments_enabled: true, installments_max_payments: 3, overdue_block_after_days: 3, subscription_retry_attempts: 3, subscription_retry_interval_days: 2, renewal_reminder_days: 14 };
  const msdef: Record<string, unknown> = { work_from: 9, work_to: 21, autoreply_enabled: true, autoreply_text: 'Здравствуйте! Мы получили ваше сообщение. Сейчас клуб не работает, менеджер ответит утром.', max_auto_per_week: 2 };
  return {
    club: { firstResponseMinutes: club.first_response_minutes },
    membership: Object.fromEntries(MEMBERSHIP.map(([k, col]) => [k, col === 'freeze_price_kop' ? Number(m[col] ?? mdef[col]) : m[col] ?? mdef[col]])),
    kpi: {
      norms: Object.fromEntries(KPI.map((k) => [k.id, kv(k.id) ?? DEFAULT_NORMS[k.id] ?? null])),
      lightGreen: kv('light_green') ?? 100, lightYellow: kv('light_yellow') ?? 85,
    },
    messaging: {
      ...Object.fromEntries(MSG.map(([k, col]) => [k, ms[col] ?? msdef[col]])),
      triggers: Object.fromEntries(trig.map((t) => [t.event, { enabled: t.enabled, days: t.days, sendHour: t.send_hour }])),
    },
    ai: { fillControlHours: ai?.fill_control_hours ?? 2 },
    sales: { items: (std?.items as ChecklistItem[]) ?? DEFAULT_CHECKLIST },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function flatten(doc: unknown, prefix = '', out: Record<string, unknown> = {}) {
  if (isObj(doc)) { for (const [k, v] of Object.entries(doc)) flatten(v, prefix ? `${prefix}.${k}` : k, out); }
  else out[prefix] = doc;
  return out;
}
export function getPath(doc: ConfigDoc, path: string) {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), doc);
}
function setPath(doc: ConfigDoc, path: string, value: unknown) {
  const ks = path.split('.'); let o = doc as Record<string, unknown>;
  for (const k of ks.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k] as Record<string, unknown>; }
  o[ks[ks.length - 1]] = value;
}
const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export const hashOf = (doc: ConfigDoc) => createHash('sha256').update(stable(doc)).digest('hex');
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

export type DiffRow = { path: string; label: string; section: string; from: unknown; to: unknown };
export function diffDocs(a: ConfigDoc, b: ConfigDoc, fields: Field[]): DiffRow[] {
  const fa = flatten(a); const fb = flatten(b);
  const out: DiffRow[] = [];
  for (const f of fields) if (!same(fa[f.path], fb[f.path]) && f.path in fb) out.push({ path: f.path, label: f.label, section: f.section, from: fa[f.path] ?? null, to: fb[f.path] ?? null });
  return out;
}

/** Приводит значение к типу поля; ошибку типа возвращает словами */
export function coerce(f: Field, v: unknown): unknown {
  if (f.type === 'bool') { if (typeof v === 'boolean') return v; if (v === 'true' || v === 1) return true; if (v === 'false' || v === 0) return false; throw badRequest(`${f.label}: да или нет`); }
  if (f.type === 'text') { if (typeof v !== 'string') throw badRequest(`${f.label}: нужен текст`); return v.trim(); }
  if (f.type === 'checklist') return normChecklist(v);
  if ((v === null || v === '') && f.nullable) return null;
  const n = typeof v === 'string' ? Number(v.replace(',', '.').replace(/\s/g, '')) : Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${f.label}: нужно число`);
  return f.type === 'num' ? Math.round(n * 10) / 10 : Math.round(n);
}
function normChecklist(v: unknown): ChecklistItem[] {
  if (!Array.isArray(v)) throw badRequest('Чек-лист: список пунктов');
  return v.map((x, i) => {
    const o = (isObj(x) ? x : {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, 200) : '';
    const id = typeof o.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(o.id) ? o.id : `p${i + 1}_${createHash('md5').update(text).digest('hex').slice(0, 6)}`;
    return { id, text, weight: Math.round(Number(o.weight ?? 1)) };
  });
}

/** Проверка данных: диапазоны и согласованность. Пустой список — всё в порядке. */
export function validateDoc(doc: ConfigDoc, fields: Field[]): string[] {
  const errs: string[] = []; const fl = flatten(doc);
  for (const f of fields) {
    const v = fl[f.path];
    if (f.type === 'checklist') {
      const items = getPath(doc, f.path) as ChecklistItem[];
      if (!Array.isArray(items) || !items.length || items.length > 20) { errs.push('Чек-лист разговора: от 1 до 20 пунктов'); continue; }
      if (items.some((i) => !i.text)) errs.push('Чек-лист разговора: у каждого пункта должен быть текст');
      if (items.some((i) => !(Number.isInteger(i.weight) && i.weight >= 1 && i.weight <= 10))) errs.push('Чек-лист разговора: вес пункта от 1 до 10');
      if (new Set(items.map((i) => i.id)).size !== items.length) errs.push('Чек-лист разговора: пункты повторяются');
      continue;
    }
    if (v === undefined) continue;
    if (v === null) { if (!f.nullable) errs.push(`${f.label}: не заполнено`); continue; }
    if (f.type === 'bool') { if (typeof v !== 'boolean') errs.push(`${f.label}: да или нет`); continue; }
    if (f.type === 'text') { if (typeof v !== 'string' || v.length < (f.min ?? 0) || v.length > (f.max ?? 1e6)) errs.push(`${f.label}: от ${f.min} до ${f.max} символов`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { errs.push(`${f.label}: нужно число`); continue; }
    if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) errs.push(`${f.label}: допустимо от ${f.min} до ${f.max}${f.unit ? ` ${f.unit}` : ''}, указано ${v}`);
  }
  const g = fl['kpi.lightGreen'] as number; const y = fl['kpi.lightYellow'] as number;
  if (typeof g === 'number' && typeof y === 'number' && y >= g) errs.push(`Светофор: жёлтый порог (${y} %) должен быть меньше зелёного (${g} %)`);
  const wf = fl['messaging.workFrom'] as number; const wt = fl['messaging.workTo'] as number;
  if (typeof wf === 'number' && typeof wt === 'number' && wf >= wt) errs.push(`Рабочее время: начало (${wf} ч) должно быть раньше конца (${wt} ч)`);
  if (fl['membership.freezePaid'] === true && !(Number(fl['membership.freezePriceKop']) > 0)) errs.push('Заморозка платная, но стоимость не указана');
  if (fl['membership.freezeEnabled'] === true && Number(fl['membership.freezeMinDays']) > Number(fl['membership.freezeMaxDaysPerYear'])) errs.push('Заморозка: минимум за раз больше, чем дней в год');
  return errs;
}

/** Записывает в рабочие таблицы только изменённые настройки (остальное мог поменять кто-то другой) */
async function applyPaths(db: Db, ctx: Ctx, clubId: string, doc: ConfigDoc, paths: string[], versionId: string) {
  const v = (p: string) => getPath(doc, p);
  for (const p of paths) {
    const [sec, ...rest] = p.split('.');
    if (p === 'club.firstResponseMinutes') await db.query('update clubs set first_response_minutes = $2, updated_at = now() where id = $1', [clubId, v(p)]);
    else if (sec === 'membership') {
      const col = MEMBERSHIP.find((x) => x[0] === rest[0])?.[1]; if (!col) continue;
      await db.query('insert into club_membership_settings(club_id, tenant_id) values ($1,$2) on conflict (club_id) do nothing', [clubId, ctx.tenantId]);
      await db.query(`update club_membership_settings set ${col} = $2, updated_by = $3, updated_at = now() where club_id = $1`, [clubId, v(p), ctx.userId]);
    } else if (sec === 'kpi') {
      const metric = rest[0] === 'norms' ? rest[1] : rest[0] === 'lightGreen' ? 'light_green' : 'light_yellow';
      const val = v(p);
      if (val === null) await db.query('delete from kpi_norms where club_id = $1 and metric = $2', [clubId, metric]);
      else await db.query(`insert into kpi_norms(tenant_id, club_id, metric, per_day, updated_by) values ($1,$2,$3,$4,$5)
        on conflict (club_id, metric) do update set per_day = excluded.per_day, updated_by = excluded.updated_by, updated_at = now()`, [ctx.tenantId, clubId, metric, val, ctx.userId]);
    } else if (sec === 'messaging' && rest[0] === 'triggers') {
      const col = { enabled: 'enabled', days: 'days', sendHour: 'send_hour' }[rest[2]]; if (!col) continue;
      await db.query(`update msg_triggers set ${col} = $3, updated_by = $4, updated_at = now() where club_id = $1 and event = $2`, [clubId, rest[1], v(p), ctx.userId]);
    } else if (sec === 'messaging') {
      const col = MSG.find((x) => x[0] === rest[0])?.[1]; if (!col) continue;
      await db.query('insert into club_msg_settings(club_id, tenant_id) values ($1,$2) on conflict (club_id) do nothing', [clubId, ctx.tenantId]);
      await db.query(`update club_msg_settings set ${col} = $2, updated_at = now() where club_id = $1`, [clubId, v(p)]);
    } else if (p === 'ai.fillControlHours') {
      await db.query(`insert into ai_settings(club_id, tenant_id, fill_control_hours, updated_by) values ($1,$2,$3,$4)
        on conflict (club_id) do update set fill_control_hours = excluded.fill_control_hours, updated_by = excluded.updated_by, updated_at = now()`, [clubId, ctx.tenantId, v(p), ctx.userId]);
    } else if (p === 'sales.items') {
      const no = Number((await db.query('select coalesce(max(version_no), 0) + 1 as n from sales_standards where club_id = $1', [clubId])).rows[0].n);
      await db.query('insert into sales_standards(tenant_id, club_id, version_no, items, config_version_id, created_by) values ($1,$2,$3,$4,$5,$6)',
        [ctx.tenantId, clubId, no, JSON.stringify(v(p)), versionId, ctx.userId]);
    }
  }
}

/** Стандарт продаж, действовавший в момент события (для оценки звонка по своей версии) */
export async function standardAt(db: Db, clubId: string, at: Date | string) {
  const r = (await db.query(`select id, version_no as "versionNo", items from sales_standards where club_id = $1 and valid_from <= $2 order by valid_from desc limit 1`, [clubId, at])).rows[0];
  return (r ?? { id: null, versionNo: 0, items: DEFAULT_CHECKLIST }) as { id: string | null; versionNo: number; items: ChecklistItem[] };
}

/* ---------- готовые наборы под тип клуба (FR-CFG-03) и возврат к шаблону (FR-CFG-09) ---------- */
type Preset = { id: string; name: string; description: string; values: Record<string, unknown> };
const triggerDays = (ending: number, debt: number, inactive: number) => ({ 'messaging.triggers.membership_ending.days': ending, 'messaging.triggers.debt_overdue.days': debt, 'messaging.triggers.inactive.days': inactive });
export const PRESETS: Preset[] = [
  { id: 'standard', name: 'Стандартные значения', description: 'Вернуть настройки к шаблону платформы. Включённые автосообщения остаются включёнными.',
    values: { 'club.firstResponseMinutes': 5, 'membership.freezeEnabled': true, 'membership.freezeMaxDaysPerYear': 30, 'membership.freezeMaxTimesPerYear': 2, 'membership.freezeMinDays': 7,
      'membership.freezePaid': false, 'membership.freezePriceKop': 0, 'membership.installmentsEnabled': true, 'membership.installmentsMaxPayments': 3, 'membership.overdueBlockAfterDays': 3,
      'membership.subscriptionRetryAttempts': 3, 'membership.subscriptionRetryIntervalDays': 2, 'membership.renewalReminderDays': 14,
      ...Object.fromEntries(KPI.map((k) => [`kpi.norms.${k.id}`, DEFAULT_NORMS[k.id] ?? null])), 'kpi.lightGreen': 100, 'kpi.lightYellow': 85,
      'messaging.workFrom': 9, 'messaging.workTo': 21, 'messaging.maxAutoPerWeek': 2, ...triggerDays(7, 3, 14), 'ai.fillControlHours': 2, 'sales.items': DEFAULT_CHECKLIST } },
  { id: 'premium', name: 'Премиальный клуб', description: 'Меньше звонков, больше внимания каждому: длинная заморозка, рассрочка до 6 платежей, ранние напоминания о продлении, экскурсия в стандарте продаж.',
    values: { 'club.firstResponseMinutes': 5, 'membership.freezeMaxDaysPerYear': 60, 'membership.freezeMaxTimesPerYear': 3, 'membership.installmentsEnabled': true, 'membership.installmentsMaxPayments': 6,
      'membership.overdueBlockAfterDays': 7, 'membership.renewalReminderDays': 30, 'kpi.norms.calls': 25, 'kpi.norms.messages': 20, 'kpi.norms.meetings_set': 3, 'kpi.norms.meetings_done': 2, 'kpi.norms.sales': 1,
      'kpi.lightGreen': 100, 'kpi.lightYellow': 90, 'messaging.maxAutoPerWeek': 1, ...triggerDays(30, 5, 10),
      'sales.items': [...DEFAULT_CHECKLIST.slice(0, 3), { id: 'tour', text: 'Пригласил на экскурсию по клубу и знакомство с тренером', weight: 3 }, ...DEFAULT_CHECKLIST.slice(3)] } },
  { id: 'mass', name: 'Массовый клуб', description: 'Поток заявок: быстрый первый ответ, высокие нормы звонков и встреч, короткая заморозка, рассрочка до 3 платежей.',
    values: { 'club.firstResponseMinutes': 3, 'membership.freezeMaxDaysPerYear': 30, 'membership.freezeMaxTimesPerYear': 2, 'membership.installmentsMaxPayments': 3, 'membership.overdueBlockAfterDays': 3,
      'membership.renewalReminderDays': 14, 'kpi.norms.calls': 60, 'kpi.norms.messages': 30, 'kpi.norms.meetings_set': 5, 'kpi.norms.meetings_done': 4, 'kpi.norms.sales': 2,
      'kpi.lightGreen': 100, 'kpi.lightYellow': 85, 'messaging.maxAutoPerWeek': 2, ...triggerDays(7, 3, 14) } },
  { id: 'studio', name: 'Студия', description: 'Небольшой зал, один-два сотрудника: мягкие нормы, ответ в течение 15 минут, без рассрочки, короткий чек-лист.',
    values: { 'club.firstResponseMinutes': 15, 'membership.freezeMaxDaysPerYear': 14, 'membership.freezeMaxTimesPerYear': 1, 'membership.freezeMinDays': 7, 'membership.installmentsEnabled': false,
      'membership.overdueBlockAfterDays': 1, 'membership.renewalReminderDays': 7, 'kpi.norms.calls': 15, 'kpi.norms.messages': 15, 'kpi.norms.meetings_set': 2, 'kpi.norms.meetings_done': 2, 'kpi.norms.sales': 1,
      'kpi.lightGreen': 100, 'kpi.lightYellow': 80, 'messaging.maxAutoPerWeek': 1, ...triggerDays(5, 1, 7),
      'sales.items': [DEFAULT_CHECKLIST[0], DEFAULT_CHECKLIST[1], DEFAULT_CHECKLIST[4], DEFAULT_CHECKLIST[5]] } },
];

/* ---------- проверка на истории (FR-CFG-08, AT39) ---------- */
export type Backtest = { path: string; title: string; summary: string; before?: string; sample?: string[] };
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function backtestTrigger(db: Db, clubId: string, event: string, days: number, marketing: boolean, today: string, periodDays = 30) {
  const keys = new Map<string, { personId: string; name: string }>();
  const runs = event === 'welcome' ? [today] : Array.from({ length: periodDays }, (_, i) => addDays(today, -periodDays + i));
  for (const d of runs) for (const c of await candidates(db, { event, days, club_id: clubId }, d)) if (!keys.has(`${c.personId}|${c.key}`)) keys.set(`${c.personId}|${c.key}`, { personId: c.personId, name: c.name });
  const ids = [...new Set([...keys.values()].map((x) => x.personId))];
  const blocked = new Set((await db.query(`select id from persons where id = any($1) and (messaging_opt_out or ($2 and not marketing_consent))`, [ids, marketing])).rows.map((r) => r.id));
  const ok = [...keys.values()].filter((x) => !blocked.has(x.personId));
  return { messages: ok.length, persons: new Set(ok.map((x) => x.personId)).size, blocked: blocked.size, sample: [...new Set(ok.map((x) => x.name))].slice(0, 8) };
}

export async function runBacktests(db: Db, clubId: string, base: ConfigDoc, next: ConfigDoc, diff: DiffRow[]): Promise<Backtest[]> {
  const out: Backtest[] = [];
  const today = (await db.query(`select to_char(now() at time zone timezone, 'YYYY-MM-DD') as d from clubs where id = $1`, [clubId])).rows[0].d as string;
  const events = new Set(diff.filter((d) => /^messaging\.triggers\.[a-z_]+\.(enabled|days)$/.test(d.path)).map((d) => d.path.split('.')[2]));
  for (const e of events) {
    const now = getPath(next, `messaging.triggers.${e}`) as { enabled: boolean; days: number } | undefined;
    const was = getPath(base, `messaging.triggers.${e}`) as { enabled: boolean; days: number } | undefined;
    if (!now) continue;
    const mk = (await db.query('select marketing from msg_triggers where club_id = $1 and event = $2', [clubId, e])).rows[0]?.marketing ?? false;
    const name = EVENT_NAMES[e]?.name ?? e;
    if (!now.enabled) { out.push({ path: `messaging.triggers.${e}`, title: `«${name}»`, summary: 'Автосообщение будет выключено: новых отправок не будет.' }); continue; }
    const r = await backtestTrigger(db, clubId, e, now.days, mk, today);
    const b = was?.enabled ? await backtestTrigger(db, clubId, e, was.days, mk, today) : null;
    out.push({ path: `messaging.triggers.${e}`, title: `«${name}»`,
      summary: e === 'welcome' ? `Сейчас под правило попадают ${r.persons} новых клиентов${r.blocked ? `, ещё ${r.blocked} без согласия или отписались` : ''}.`
        : `Если бы правило действовало последние 30 дней: ${r.messages} сообщ. ${r.persons} клиентам${r.blocked ? `; ${r.blocked} клиентов пропущено (нет согласия или отписались)` : ''}.`,
      before: b ? `По действующему правилу за то же время: ${b.messages} сообщ. ${b.persons} клиентам.` : 'Сейчас это автосообщение выключено.',
      sample: r.sample });
  }
  if (diff.some((d) => d.path === 'club.firstResponseMinutes')) {
    const nv = Number(getPath(next, 'club.firstResponseMinutes')); const ov = Number(getPath(base, 'club.firstResponseMinutes'));
    const r = (await db.query(`select count(*)::int as total,
        count(*) filter (where first_response_at is null or first_response_at - created_at > make_interval(mins => $2))::int as late_new,
        count(*) filter (where first_response_at is null or first_response_at - created_at > make_interval(mins => $3))::int as late_old
      from leads where club_id = $1 and created_at > now() - interval '30 days'`, [clubId, nv, ov])).rows[0];
    out.push({ path: 'club.firstResponseMinutes', title: 'Срок первого ответа',
      summary: `За 30 дней ${r.total} заявок: с новым сроком ${nv} мин просроченными были бы ${r.late_new}.`, before: `С действующим сроком ${ov} мин: ${r.late_old}.` });
  }
  if (diff.some((d) => d.path === 'kpi.lightGreen' || d.path === 'kpi.lightYellow')) {
    out.push({ path: 'kpi.light', title: 'Светофор плана', summary: `Зелёный от ${getPath(next, 'kpi.lightGreen')} %, жёлтый от ${getPath(next, 'kpi.lightYellow')} % темпа плана. Прошлые месяцы не пересчитываются.` });
  }
  return out;
}

/* ---------- проверки перед утверждением и публикацией ---------- */
export type CheckItem = { code: 'data' | 'rights' | 'drift' | 'history' | 'empty'; ok: boolean; title: string; details: string[] };
export type Checks = { ok: boolean; at: string; items: CheckItem[]; history: Backtest[] };

function rightsMissing(ctx: Ctx, diff: DiffRow[]) {
  const miss: string[] = [];
  if (!can(ctx, P.configApprove)) miss.push('утверждение настроек');
  for (const s of new Set(diff.map((d) => d.section))) {
    const sec = SECTIONS.find((x) => x.id === s);
    if (sec && !can(ctx, sec.perm)) miss.push(sec.title);
  }
  return miss;
}

async function runChecks(db: Db, ctx: Ctx, clubId: string, v: { data: ConfigDoc; base_data: ConfigDoc }, live: ConfigDoc, fields: Field[]): Promise<Checks> {
  const diff = diffDocs(v.base_data, v.data, fields);
  const items: CheckItem[] = [];
  items.push({ code: 'empty', ok: diff.length > 0, title: diff.length ? `Изменений: ${diff.length}` : 'Изменений нет: черновик совпадает с рабочими настройками', details: [] });
  const errs = validateDoc(v.data, fields);
  items.push({ code: 'data', ok: !errs.length, title: errs.length ? 'Ошибки в значениях' : 'Значения в допустимых пределах и согласованы', details: errs });
  const drift = diff.filter((d) => !same(getPath(live, d.path), getPath(v.base_data, d.path)));
  items.push({ code: 'drift', ok: !drift.length, title: drift.length ? 'Пока готовился черновик, эти настройки поменяли в рабочей версии' : 'Рабочие настройки не менялись с момента черновика, откат возможен',
    details: drift.map((d) => `${d.label}: в черновике исходно ${fmt(getPath(v.base_data, d.path))}, сейчас ${fmt(getPath(live, d.path))}. Создайте черновик заново`) });
  const miss = rightsMissing(ctx, diff);
  items.push({ code: 'rights', ok: true, title: miss.length ? 'Утвердить может управляющий клуба или собственник' : 'У вас есть права утвердить все изменения', details: miss.map((m) => `Нужно право: ${m}`) });
  const history = await runBacktests(db, clubId, v.base_data, v.data, diff);
  items.push({ code: 'history', ok: true, title: history.length ? 'Проверка на истории: результат ниже' : 'Проверка на истории не требуется для этих изменений', details: history.map((h) => `${h.title}: ${h.summary}`) });
  return { ok: items.every((i) => i.ok), at: new Date().toISOString(), items, history };
}

export function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (Array.isArray(v)) return `${v.length} пункт.`;
  return String(v);
}

/* ---------- ИИ-помощник настройки: из слов в черновик ---------- */
type Change = { path: string; value: unknown };
const NUM = /(-?\d+(?:[.,]\d+)?)/;
const ON = /(включ|разреш|запуст|добав|отправля|нужн)/i;
const OFF = /(выключ|отключ|запрет|убер|не отправ|не нужн|отмен|останов)/i;
const RULES: { re: RegExp; path: string | ((t: string) => string | null); kind?: 'bool' | 'num' | 'trigger' | 'freeze' }[] = [
  { re: /(ж[её]лт)/i, path: 'kpi.lightYellow' },
  { re: /зел[её]н/i, path: 'kpi.lightGreen' },
  { re: /норм\S*.*перв\S* ответ|перв\S* ответ\S*.*норм/i, path: 'kpi.norms.first_response' },
  { re: /перв\S* ответ|ответ\S* на (заявк|лид)|скорост\S* ответ/i, path: 'club.firstResponseMinutes' },
  { re: /звон(ок|ки|ков|ка)(?![а-я])(?!.*итог)/i, path: 'kpi.norms.calls' },
  { re: /назнач\S* встреч|встреч\S* назнач/i, path: 'kpi.norms.meetings_set' },
  { re: /провед\S* встреч|встреч\S* провед/i, path: 'kpi.norms.meetings_done' },
  { re: /просроч\S* задач/i, path: 'kpi.norms.tasks_overdue' },
  { re: /выполн\S* задач|задач\S* выполн/i, path: 'kpi.norms.tasks_done' },
  { re: /норм\S*.*отказ|отказ\S*.*норм/i, path: 'kpi.norms.refusals' },
  { re: /норм\S*.*продаж|продаж\S*.*(в день|норм)/i, path: 'kpi.norms.sales' },
  { re: /(день рожд|дн[её]м рожд|днем рожд)/i, path: 'messaging.triggers.birthday', kind: 'trigger' },
  { re: /(давно не (был|ход|приход)|не ход\S*|неактивн)/i, path: 'messaging.triggers.inactive', kind: 'trigger' },
  { re: /(оконч\S* абонем|абонем\S* заканч|заканчива)/i, path: 'messaging.triggers.membership_ending', kind: 'trigger' },
  { re: /(добро пожал|приветств\S* нов)/i, path: 'messaging.triggers.welcome', kind: 'trigger' },
  { re: /подогрев/i, path: 'messaging.triggers.ai_nurture', kind: 'trigger' },
  { re: /(закры|блок)\S*.*проход|проход\S*.*(закры|блок)/i, path: 'membership.overdueBlockAfterDays' },
  { re: /(напомин\S* о долг|долг\S*.*напомин|напоминан\S* о долг|о долге)/i, path: 'messaging.triggers.debt_overdue', kind: 'trigger' },
  { re: /заморозк|заморож/i, path: 'membership.freeze', kind: 'freeze' },
  { re: /рассрочк/i, path: (t) => (NUM.test(t) ? 'membership.installmentsMaxPayments' : 'membership.installmentsEnabled') },
  { re: /(попыт\S*.*списан|списан\S*.*попыт|повторн\S* списан)/i, path: (t) => (/(между|интервал|кажд)/i.test(t) ? 'membership.subscriptionRetryIntervalDays' : 'membership.subscriptionRetryAttempts') },
  { re: /(продлен\S*.*напомин|напомин\S*.*продлен|о продлении)/i, path: 'membership.renewalReminderDays' },
  { re: /автоответ/i, path: 'messaging.autoreplyEnabled', kind: 'bool' },
  { re: /(в неделю|за неделю).*(автосообщ|сообщ)|(автосообщ|сообщ)\S*.*(в неделю|за неделю)/i, path: 'messaging.maxAutoPerWeek' },
  { re: /сообщен/i, path: 'kpi.norms.messages' },
  { re: /(итог\S* звонк|провер\S* итог|заполн\S* итог)/i, path: 'ai.fillControlHours' },
];

export function parseRequest(text: string, cur: ConfigDoc, fields: Field[]): { changes: Change[]; notes: string[]; unknown: string[]; preset?: string } {
  const changes: Change[] = []; const notes: string[] = []; const unknown: string[] = [];
  const t0 = text.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
  // Готовый набор целиком
  const presetRe: [RegExp, string][] = [[/премиальн|премиум/i, 'premium'], [/массов/i, 'mass'], [/студи/i, 'studio'], [/(стандартн\S* знач|по умолчанию|к шаблону|сброс)/i, 'standard']];
  if (/(набор|шаблон|как у|как в|сделай как|по умолчанию|сброс)/i.test(t0)) for (const [re, id] of presetRe) if (re.test(t0)) return { changes: [], notes: [`Готовый набор «${PRESETS.find((p) => p.id === id)!.name}»`], unknown: [], preset: id };
  const has = (p: string) => fields.some((f) => f.path === p);
  const add = (path: string, value: unknown) => { const f = fields.find((x) => x.path === path); if (!f) return false; changes.push({ path, value: coerce(f, value) }); return true; };
  // Чек-лист разговора: предложения с «пунктом в кавычках» разбираем отдельно, остальное — как обычно
  let t1 = t0;
  const listSentences = t0.split(/(?<=[.;!?\n])\s*/).filter((x) => /(чек-?лист|стандарт\S* продаж|пункт)/i.test(x) && /[«"“]/.test(x));
  if (listSentences.length) {
    let items = [...(getPath(cur, 'sales.items') as ChecklistItem[])];
    for (const sentence of listSentences) {
      t1 = t1.replace(sentence, ' ');
      const remove = OFF.test(sentence) || /(удал|убер)/i.test(sentence);
      for (const q of [...sentence.matchAll(/[«"“]([^»"”]{3,200})[»"”]/g)].map((m) => m[1].trim())) {
        if (remove) { const n = items.length; items = items.filter((i) => !i.text.toLowerCase().includes(q.toLowerCase())); if (items.length === n) unknown.push(`пункт «${q}» не найден в чек-листе`); }
        else items.push({ id: `p_${createHash('md5').update(q).digest('hex').slice(0, 8)}`, text: q, weight: Math.min(10, Math.max(1, Number(sentence.match(/вес\S*\s*(\d+)/i)?.[1] ?? 2))) });
      }
    }
    changes.push({ path: 'sales.items', value: items });
  }
  // Рабочее время «с 8 до 22»
  const wh = t1.match(/рабоч\S* (?:время|часы|день)[^0-9]*с\s*(\d{1,2})\D+до\s*(\d{1,2})/i);
  let rest = t1;
  if (wh) { add('messaging.workFrom', Number(wh[1])); add('messaging.workTo', Number(wh[2])); rest = rest.replace(wh[0], ' '); }
  const clauses = rest.split(/[.;\n!?]+|,\s*(?=[а-яa-z])|\s+и\s+(?=[^0-9]*?(?:включ|выключ|отключ|постав|сдела|измени|норм|срок|порог|заморозк|рассрочк|автоответ|жел|зел))/i).map((s) => s.trim()).filter((s) => s.length > 2);
  let prev = '';
  for (const c of clauses) {
    let matched = false;
    for (const ctxText of [c, `${prev} ${c}`]) {
      const r = RULES.find((x) => x.re.test(ctxText));
      if (!r) continue;
      const path = typeof r.path === 'function' ? r.path(ctxText) : r.path;
      if (!path) continue;
      const num = c.match(NUM)?.[1];
      if (r.kind === 'freeze') {
        // «Заморозка до 60 дней в год, не больше 2 раз, минимум 7 дней, платная 500 ₽» — всё из одной фразы
        let x = c; let any = false;
        const take = (re: RegExp) => { const m = x.match(re); if (m) x = x.replace(m[0], ' '); return m ? Number(m[1].replace(',', '.')) : null; };
        const price = take(/(\d+(?:[.,]\d+)?)\s*(?:руб|₽|р\.)/i); if (price !== null) { any = add('membership.freezePriceKop', Math.round(price * 100)) || any; add('membership.freezePaid', price > 0); }
        const min = take(/(?:миним\S*|не меньше|от|за раз)\D{0,12}(\d+)\s*дн/i) ?? take(/(\d+)\s*дн\S*\s*за раз/i); if (min !== null) any = add('membership.freezeMinDays', min) || any;
        const times = take(/(\d+)\s*раз(?!мер)/i); if (times !== null) any = add('membership.freezeMaxTimesPerYear', times) || any;
        const days = take(/(\d+)\s*(?:дн|день|дня)/i) ?? (any ? null : take(NUM)); if (days !== null) any = add('membership.freezeMaxDaysPerYear', days) || any;
        if (/бесплатн/i.test(c)) any = add('membership.freezePaid', false) || any; else if (/платн/i.test(c) && price === null) any = add('membership.freezePaid', true) || any;
        if (OFF.test(c)) any = add('membership.freezeEnabled', false) || any; else if (ON.test(c) || any) add('membership.freezeEnabled', true);
        if (!any && !OFF.test(c) && !ON.test(c)) continue;
        matched = true; break;
      }
      if (r.kind === 'trigger') {
        if (!has(`${path}.enabled`)) { unknown.push(`в клубе нет автосообщения: ${c}`); matched = true; break; }
        const hour = c.match(/(?:в|после|не раньше)\s*(\d{1,2})\s*(?:ч|час|:00)/i)?.[1];
        if (hour) add(`${path}.sendHour`, Number(hour));
        const dayNum = hour ? c.replace(hour, '').match(NUM)?.[1] : num;
        if (dayNum && has(`${path}.days`)) add(`${path}.days`, Number(dayNum.replace(',', '.')));
        if (OFF.test(c)) add(`${path}.enabled`, false); else if (ON.test(c) || dayNum) add(`${path}.enabled`, true);
        matched = true; break;
      }
      const f = fields.find((x) => x.path === path);
      if (!f) continue;
      if (f.type === 'bool') { if (OFF.test(c)) add(path, false); else if (ON.test(c) || /(да|можно)/i.test(c)) add(path, true); else continue; matched = true; break; }
      if (!num) { if (/(убер|без норм|не нужн)/i.test(c) && f.nullable) { add(path, null); matched = true; break; } continue; }
      let val: number = Number(num.replace(',', '.'));
      if (f.type === 'money') val = Math.round(val * 100);
      if (f.type === 'int' && /час/i.test(c) && f.unit === 'мин') val *= 60;
      add(path, val); matched = true; break;
    }
    if (!matched) unknown.push(c);
    prev = c;
  }
  // Повтор одного пути: побеждает последнее упоминание
  const last = new Map(changes.map((x) => [x.path, x]));
  return { changes: [...last.values()], notes, unknown };
}

/* ---------- версии ---------- */
type VersionRow = { id: string; club_id: string; number: number; status: string; source: string; title: string; data: ConfigDoc; base_data: ConfigDoc; data_hash: string; checks: Checks | null;
  checked_hash: string | null; approved_hash: string | null; approved_by: string | null; ai_request: string | null };

async function nextNumber(db: Db, clubId: string) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`config:${clubId}`]);
  return Number((await db.query('select coalesce(max(number), 0) + 1 as n from config_versions where club_id = $1', [clubId])).rows[0].n);
}
async function eventsOf(db: Db, clubId: string) {
  return (await db.query('select event from msg_triggers where club_id = $1 order by event', [clubId])).rows.map((r) => r.event as string);
}
function applyChanges(doc: ConfigDoc, changes: Change[], fields: Field[]) {
  const next = structuredClone(doc);
  for (const ch of changes) {
    const f = fields.find((x) => x.path === ch.path);
    if (!f) throw badRequest(`Такой настройки нет: ${ch.path}`);
    setPath(next, ch.path, coerce(f, ch.value));
  }
  return next;
}
function presetChanges(id: string, fields: Field[]): Change[] {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw badRequest('Такого набора нет');
  return Object.entries(p.values).filter(([k]) => fields.some((f) => f.path === k)).map(([path, value]) => ({ path, value }));
}
async function createVersion(db: Db, ctx: Ctx, clubId: string, o: { title: string; source: VersionRow['source']; data: ConfigDoc; base: ConfigDoc; aiRequest?: string | null; rolledBackFrom?: string | null }) {
  const number = await nextNumber(db, clubId);
  const id = (await db.query(`insert into config_versions(tenant_id, club_id, number, source, title, ai_request, data, base_data, data_hash, rolled_back_from, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
  [ctx.tenantId, clubId, number, o.source, o.title.slice(0, 200), o.aiRequest ?? null, JSON.stringify(o.data), JSON.stringify(o.base), hashOf(o.data), o.rolledBackFrom ?? null, ctx.userId])).rows[0].id as string;
  return { id, number };
}
async function loadVersion(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Версия не найдена');
  const v = (await db.query('select * from config_versions where id = $1', [id])).rows[0] as VersionRow | undefined;
  if (!v) throw notFound('Версия не найдена');
  return v;
}

async function publish(db: Db, ctx: Ctx, v: VersionRow, fields: Field[]) {
  const live = await readLive(db, v.club_id);
  const checks = await runChecks(db, ctx, v.club_id, v, live, fields);
  await db.query('update config_versions set checks = $2, checked_hash = $3 where id = $1', [v.id, JSON.stringify(checks), v.data_hash]);
  if (!checks.ok) return { ok: false as const, checks };
  const diff = diffDocs(v.base_data, v.data, fields);
  // Исходные настройки клуба — отдельной версией, чтобы к ним можно было вернуться
  const any = (await db.query(`select 1 from config_versions where club_id = $1 and status in ('published', 'superseded')`, [v.club_id])).rowCount;
  if (!any) await db.query(`insert into config_versions(tenant_id, club_id, number, status, source, title, data, base_data, data_hash, created_by)
    values ($1,$2,0,'superseded','initial','Исходные настройки клуба',$3,$3,$4,$5) on conflict (club_id, number) do nothing`, [ctx.tenantId, v.club_id, JSON.stringify(v.base_data), hashOf(v.base_data), ctx.userId]);
  await applyPaths(db, ctx, v.club_id, v.data, diff.map((d) => d.path), v.id);
  await db.query(`update config_versions set status = 'superseded' where club_id = $1 and status = 'published'`, [v.club_id]);
  await db.query(`update config_versions set status = 'published', published_by = $2, published_at = now() where id = $1`, [v.id, ctx.userId]);
  await audit(db, ctx, 'config.published', 'config_version', v.id, null, { number: v.number, source: v.source, diff: diff.map((d) => ({ path: d.path, from: d.from, to: d.to })) });
  return { ok: true as const, checks, diff };
}

function requireClub(ctx: Ctx, clubId?: string) {
  if (!clubId || !/^[0-9a-f-]{36}$/i.test(clubId)) throw badRequest('Выберите клуб');
  if (!ctx.allClubs && !ctx.clubIds.includes(clubId)) throw forbidden('Не ваш клуб');
  return clubId;
}

const VERSION_LIST = `select v.id, v.number, v.status, v.source, v.title, v.created_at as "createdAt", cu.full_name as "createdBy", v.approved_at as "approvedAt", au.full_name as "approvedBy",
    v.published_at as "publishedAt", pu.full_name as "publishedBy", v.ai_request as "aiRequest", (v.checks ->> 'ok')::boolean as "checksOk", v.checked_hash = v.data_hash as "checkedCurrent"
  from config_versions v left join users cu on cu.id = v.created_by left join users au on au.id = v.approved_by left join users pu on pu.id = v.published_by`;

export function configRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/config', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    const clubId = requireClub(ctx, (req.query as { clubId?: string }).clubId);
    return withCtx(pool, ctx, async (db) => {
      const live = await readLive(db, clubId);
      const fields = fieldsFor(await eventsOf(db, clubId));
      const versions = (await db.query(`${VERSION_LIST} where v.club_id = $1 order by v.number desc limit 50`, [clubId])).rows;
      return { live, fields, sections: SECTIONS.map(({ id, title }) => ({ id, title })), versions, presets: PRESETS.map(({ id, name, description }) => ({ id, name, description })),
        canApprove: can(ctx, P.configApprove), aiServer: !!aiConfigFromEnv() };
    });
  });

  app.get('/api/config/versions/:id', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    return withCtx(pool, ctx, async (db) => {
      const v = await loadVersion(db, (req.params as { id: string }).id);
      const fields = fieldsFor(await eventsOf(db, v.club_id));
      const row = (await db.query(`${VERSION_LIST} where v.id = $1`, [v.id])).rows[0];
      const live = await readLive(db, v.club_id);
      return { ...row, diff: diffDocs(v.base_data, v.data, fields), checks: v.checks, checksCurrent: v.checked_hash === v.data_hash, approvedCurrent: v.approved_hash === v.data_hash,
        data: v.data, differsFromLive: diffDocs(live, v.data, fields).length, canApprove: can(ctx, P.configApprove) };
    });
  });

  // Новый черновик: из правок, из готового набора или пустой (от рабочих настроек)
  app.post('/api/config/versions', async (req, reply) => {
    const ctx = requirePerm(req, P.configManage);
    const b = (req.body ?? {}) as { clubId?: string; title?: string; changes?: Change[]; preset?: string };
    const clubId = requireClub(ctx, b.clubId);
    const r = await withCtx(pool, ctx, async (db) => {
      const live = await readLive(db, clubId);
      const fields = fieldsFor(await eventsOf(db, clubId));
      const changes = [...(b.preset ? presetChanges(b.preset, fields) : []), ...(Array.isArray(b.changes) ? b.changes : [])];
      const data = applyChanges(live, changes, fields);
      const title = b.title?.trim() || (b.preset ? `Набор «${PRESETS.find((p) => p.id === b.preset)!.name}»` : 'Изменение настроек');
      const v = await createVersion(db, ctx, clubId, { title, source: b.preset ? 'preset' : 'human', data, base: live });
      await audit(db, ctx, 'config.draft_created', 'config_version', v.id, null, { number: v.number, changes: diffDocs(live, data, fields).length });
      return { ...v, diff: diffDocs(live, data, fields) };
    });
    reply.code(201);
    return r;
  });

  // Правка черновика. Утверждённый после правки снова становится черновиком (AT09) — это делает и база
  app.put('/api/config/versions/:id', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    const b = (req.body ?? {}) as { changes?: Change[]; title?: string };
    return withCtx(pool, ctx, async (db) => {
      const v = await loadVersion(db, (req.params as { id: string }).id);
      if (!['draft', 'approved'].includes(v.status)) throw badRequest('Эта версия уже не черновик: создайте новую', 'not_draft');
      const fields = fieldsFor(await eventsOf(db, v.club_id));
      const data = applyChanges(v.data, Array.isArray(b.changes) ? b.changes : [], fields);
      const h = hashOf(data);
      const r = (await db.query(`update config_versions set data = $2, data_hash = $3, title = coalesce($4, title) where id = $1 returning status`, [v.id, JSON.stringify(data), h, b.title?.trim() || null])).rows[0];
      if (v.status === 'approved' && h !== v.data_hash) await audit(db, ctx, 'config.approval_reset', 'config_version', v.id, { hash: v.approved_hash }, { hash: h });
      return { ok: true, status: r.status, diff: diffDocs(v.base_data, data, fields) };
    });
  });

  app.post('/api/config/versions/:id/check', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    return withCtx(pool, ctx, async (db) => {
      const v = await loadVersion(db, (req.params as { id: string }).id);
      if (!['draft', 'approved'].includes(v.status)) throw badRequest('Проверяются только черновики');
      const fields = fieldsFor(await eventsOf(db, v.club_id));
      const checks = await runChecks(db, ctx, v.club_id, v, await readLive(db, v.club_id), fields);
      await db.query('update config_versions set checks = $2, checked_hash = $3 where id = $1', [v.id, JSON.stringify(checks), v.data_hash]);
      return checks;
    });
  });

  app.post('/api/config/versions/:id/approve', async (req) => {
    const ctx = requirePerm(req, P.configApprove);
    return withCtx(pool, ctx, async (db) => {
      const v = await loadVersion(db, (req.params as { id: string }).id);
      if (v.status !== 'draft') throw badRequest(v.status === 'approved' ? 'Уже утверждено' : 'Утверждаются только черновики');
      if (!v.checks || v.checked_hash !== v.data_hash) throw badRequest('Сначала проверьте черновик: после последней проверки его меняли', 'check_required');
      if (!v.checks.ok) throw badRequest('Проверка не пройдена: исправьте ошибки и проверьте снова', 'checks_failed');
      const fields = fieldsFor(await eventsOf(db, v.club_id));
      const miss = rightsMissing(ctx, diffDocs(v.base_data, v.data, fields));
      if (miss.length) throw forbidden(`Не хватает прав: ${miss.join(', ')}`);
      await db.query(`update config_versions set status = 'approved', approved_by = $2, approved_at = now(), approved_hash = data_hash where id = $1`, [v.id, ctx.userId]);
      await audit(db, ctx, 'config.approved', 'config_version', v.id, null, { number: v.number, hash: v.data_hash, source: v.source });
      return { ok: true };
    });
  });

  app.post('/api/config/versions/:id/reject', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    return withCtx(pool, ctx, async (db) => {
      const v = await loadVersion(db, (req.params as { id: string }).id);
      if (!['draft', 'approved'].includes(v.status)) throw badRequest('Отклонить можно только черновик');
      await db.query(`update config_versions set status = 'rejected' where id = $1`, [v.id]);
      await audit(db, ctx, 'config.rejected', 'config_version', v.id, null, { number: v.number });
      return { ok: true };
    });
  });

  // Публикация: проверки ещё раз; если не прошли — рабочая версия остаётся как была (AT10)
  app.post('/api/config/versions/:id/publish', async (req, reply) => {
    const ctx = requirePerm(req, P.configApprove);
    return withCtx(pool, ctx, async (db) => {
      const v = await loadVersion(db, (req.params as { id: string }).id);
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`config:${v.club_id}`]);
      if (v.status !== 'approved' || v.approved_hash !== v.data_hash) throw badRequest('Опубликовать можно только утверждённое содержимое', 'approval_required');
      const fields = fieldsFor(await eventsOf(db, v.club_id));
      const r = await publish(db, ctx, v, fields);
      if (!r.ok) { reply.code(409); return { error: 'checks_failed', message: 'Публикация остановлена: проверка не пройдена. Рабочие настройки не изменились', checks: r.checks }; }
      return { ok: true, number: v.number, changed: r.diff.length };
    });
  });

  // Откат: новая версия с содержимым выбранной, сразу проверяется, утверждается и публикуется тем, кто откатывает
  app.post('/api/config/versions/:id/rollback', async (req, reply) => {
    const ctx = requirePerm(req, P.configApprove);
    return withCtx(pool, ctx, async (db) => {
      const target = await loadVersion(db, (req.params as { id: string }).id);
      if (!['superseded', 'published'].includes(target.status)) throw badRequest('Вернуться можно к версии, которая была рабочей');
      const live = await readLive(db, target.club_id);
      const fields = fieldsFor(await eventsOf(db, target.club_id));
      // Берём из старой версии только то, что в ней было настраиваемым сейчас
      const data = applyChanges(live, fields.map((f) => ({ path: f.path, value: getPath(target.data, f.path) })).filter((c) => c.value !== undefined), fields);
      const v = await createVersion(db, ctx, target.club_id, { title: `Откат к версии ${target.number}`, source: 'rollback', data, base: live, rolledBackFrom: target.id });
      const row = await loadVersion(db, v.id);
      const checks = await runChecks(db, ctx, row.club_id, row, live, fields);
      await db.query('update config_versions set checks = $2, checked_hash = data_hash where id = $1', [v.id, JSON.stringify(checks)]);
      if (!checks.ok) { reply.code(409); return { error: 'checks_failed', message: 'Откат не опубликован: проверка не пройдена', checks, versionId: v.id }; }
      const miss = rightsMissing(ctx, diffDocs(live, data, fields));
      if (miss.length) throw forbidden(`Не хватает прав: ${miss.join(', ')}`);
      await db.query(`update config_versions set status = 'approved', approved_by = $2, approved_at = now(), approved_hash = data_hash where id = $1`, [v.id, ctx.userId]);
      const r = await publish(db, ctx, await loadVersion(db, v.id), fields);
      if (!r.ok) { reply.code(409); return { error: 'checks_failed', message: 'Откат не опубликован', checks: r.checks, versionId: v.id }; }
      await audit(db, ctx, 'config.rolled_back', 'config_version', v.id, null, { to: target.number });
      return { ok: true, versionId: v.id, number: v.number, changed: r.diff.length };
    });
  });

  // История одной настройки по опубликованным версиям (FR-CFG-09)
  app.get('/api/config/history', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    const q = req.query as { clubId?: string; path?: string };
    const clubId = requireClub(ctx, q.clubId);
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(`select v.number, v.title, v.source, v.published_at as "publishedAt", u.full_name as "by", v.data, v.base_data
        from config_versions v left join users u on u.id = v.published_by where v.club_id = $1 and v.published_at is not null order by v.published_at`, [clubId])).rows;
      return rows.filter((r) => !q.path || !same(getPath(r.base_data, q.path), getPath(r.data, q.path)))
        .map((r) => ({ number: r.number, title: r.title, source: r.source, publishedAt: r.publishedAt, by: r.by, from: q.path ? getPath(r.base_data, q.path) : undefined, to: q.path ? getPath(r.data, q.path) : undefined }));
    });
  });

  // ИИ-помощник: понимает просьбу словами и готовит черновик. Рабочие настройки не меняет (AT08)
  app.post('/api/config/assistant', async (req, reply) => {
    const ctx = requirePerm(req, P.configManage);
    const b = (req.body ?? {}) as { clubId?: string; text?: string; versionId?: string };
    const clubId = requireClub(ctx, b.clubId);
    const text = (b.text ?? '').trim().slice(0, 1000);
    if (text.length < 3) throw badRequest('Опишите, что поменять, например: «срок первого ответа 10 минут, норма звонков 50»');
    const r = await withCtx(pool, ctx, async (db) => {
      const live = await readLive(db, clubId);
      const fields = fieldsFor(await eventsOf(db, clubId));
      const target = b.versionId ? await loadVersion(db, b.versionId) : null;
      if (target && (target.club_id !== clubId || !['draft', 'approved'].includes(target.status))) throw badRequest('Дополнять можно только черновик этого клуба');
      const cur = target?.data ?? live;
      let parsed: ReturnType<typeof parseRequest> = { changes: [], notes: [], unknown: [] };
      let engine = 'правила';
      const aiCfg = aiConfigFromEnv();
      if (aiCfg) {
        // На ИИ-сервер уходят только названия и значения настроек — без данных клиентов (ТЗ 6.3)
        try {
          const s = await aiConfigSuggest(aiCfg, text, fields.map((f) => ({ path: f.path, label: f.label, type: f.type, min: f.min, max: f.max, value: getPath(cur, f.path) })));
          const ok = (s.changes ?? []).filter((c) => fields.some((f) => f.path === c.path));
          if (ok.length || s.preset) { parsed = { changes: ok, notes: s.explanation ? [s.explanation] : [], unknown: s.unknown ?? [], preset: s.preset }; engine = s.engine ?? 'ИИ-сервер'; }
        } catch { /* ИИ-сервер недоступен: разбираем сами */ }
      }
      if (engine === 'правила') parsed = parseRequest(text, cur, fields);
      const changes = [...(parsed.preset ? presetChanges(parsed.preset, fields) : []), ...parsed.changes];
      if (!changes.length) return { understood: false, unknown: parsed.unknown.length ? parsed.unknown : [text], engine };
      const data = applyChanges(cur, changes, fields);
      const errs = validateDoc(data, fields);
      let id: string; let number: number; let status = 'draft';
      if (target) {
        const h = hashOf(data);
        status = (await db.query('update config_versions set data = $2, data_hash = $3, source = $4, ai_request = coalesce(ai_request || $5, $6) where id = $1 returning status',
          [target.id, JSON.stringify(data), h, 'ai', `\n${text}`, text])).rows[0].status;
        if (target.status === 'approved' && h !== target.data_hash) await audit(db, ctx, 'config.approval_reset', 'config_version', target.id, { hash: target.approved_hash }, { hash: h, by: 'ai' });
        ({ id, number } = target);
      } else {
        ({ id, number } = await createVersion(db, ctx, clubId, { title: `Предложение ИИ: ${text.slice(0, 80)}`, source: 'ai', data, base: live, aiRequest: text }));
      }
      await audit(db, ctx, 'config.ai_proposed', 'config_version', id, null, { text, changes: changes.length, engine });
      const base = target?.base_data ?? live;
      return { understood: true, versionId: id, number, status, diff: diffDocs(base, data, fields), unknown: parsed.unknown, notes: parsed.notes, errors: errs, engine };
    });
    if (r.understood) reply.code(201);
    return r;
  });

  // Проверка на истории без черновика: «что было бы, если…»
  app.post('/api/config/backtest', async (req) => {
    const ctx = requirePerm(req, P.configManage);
    const b = (req.body ?? {}) as { clubId?: string; changes?: Change[] };
    const clubId = requireClub(ctx, b.clubId);
    return withCtx(pool, ctx, async (db) => {
      const live = await readLive(db, clubId);
      const fields = fieldsFor(await eventsOf(db, clubId));
      const next = applyChanges(live, Array.isArray(b.changes) ? b.changes : [], fields);
      return runBacktests(db, clubId, live, next, diffDocs(live, next, fields));
    });
  });

  app.get('/api/sales-standards', async (req) => {
    const ctx = requireCtx(req);
    const clubId = requireClub(ctx, (req.query as { clubId?: string }).clubId);
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(`select s.id, s.version_no as "versionNo", s.items, s.valid_from as "validFrom", u.full_name as "createdBy" from sales_standards s left join users u on u.id = s.created_by
        where s.club_id = $1 order by s.version_no desc`, [clubId])).rows;
      return rows.length ? rows : [{ id: null, versionNo: 0, items: DEFAULT_CHECKLIST, validFrom: null, createdBy: 'шаблон платформы' }];
    });
  });
}
