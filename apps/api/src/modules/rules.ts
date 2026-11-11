// Конструктор правил «если — то» (список «20 новых возможностей», п. 20).
// Управляющий собирает правило из готовых условий («не был 10 дней», «абонемент кончается через 30 дней»…) и цепочки шагов
// («отправить сообщение», «через 2 дня — задача менеджеру», «начислить баллы»). Правила живут в версиях настроек клуба:
// черновик → проверка на истории (сколько клиентов попало бы за 30 дней) → утверждение → публикация.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest } from '../errors.ts';
import { addDays } from './memberships.ts';
import { conversationFor, deliver, firstName, queueMessage } from './messaging.ts';

type Fetch = typeof fetch;
type Actor = { tenantId: string; userId: string | null };

export type Cond = { type: string; n?: number };
export type Step = { action: 'message' | 'task' | 'points'; afterDays: number; text?: string; title?: string; points?: number; dueHours?: number };
export type Rule = { id: string; name: string; enabled: boolean; conditions: Cond[]; steps: Step[]; stopOnVisit: boolean; stopOnPurchase: boolean; cooldownDays: number; marketing: boolean };

/** Каталог условий. n — число из формы; SQL проверяет клиента p на дату $2 в клубе $1 (c — клуб). */
export const CONDITIONS: Record<string, { label: string; unit?: string; min?: number; max?: number; sql: (n: number) => string }> = {
  inactive_days: { label: 'Не был в клубе', unit: 'дней и больше', min: 1, max: 365,
    sql: (n) => `(select max((v.visited_at at time zone c.timezone)::date) from visits v where v.person_id = p.id and v.club_id = $1 and (v.visited_at at time zone c.timezone)::date <= $2::date) <= $2::date - ${n}` },
  ends_within: { label: 'Абонемент кончается в ближайшие', unit: 'дней', min: 0, max: 120,
    sql: (n) => `exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind in ('term', 'visits', 'subscription') and m.status <> 'cancelled'
      and m.starts_on <= $2::date and m.ends_on between $2::date and $2::date + ${n})
      and not exists (select 1 from memberships m2 where m2.person_id = p.id and m2.club_id = $1 and m2.kind <> 'guest' and m2.status <> 'cancelled' and m2.starts_on > $2::date)` },
  ended_ago: { label: 'Абонемент закончился и не продлён, не позже чем', unit: 'дней назад', min: 1, max: 365,
    sql: (n) => `exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind <> 'guest' and m.ends_on between $2::date - ${n} and $2::date - 1)
      and not exists (select 1 from memberships m2 where m2.person_id = p.id and m2.club_id = $1 and m2.kind <> 'guest' and m2.status <> 'cancelled' and coalesce(m2.ends_on, $2::date) >= $2::date)` },
  has_active: { label: 'Есть действующий абонемент',
    sql: () => `exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind <> 'guest' and m.status <> 'cancelled' and m.starts_on <= $2::date and coalesce(m.ends_on, $2::date) >= $2::date)` },
  no_active: { label: 'Нет действующего абонемента',
    sql: () => `not exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind <> 'guest' and m.status <> 'cancelled' and m.starts_on <= $2::date and coalesce(m.ends_on, $2::date) >= $2::date)` },
  visits_left_lte: { label: 'В пакете осталось посещений не больше', unit: 'шт.', min: 0, max: 50,
    sql: (n) => `exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind in ('visits', 'personal') and m.status <> 'cancelled'
      and coalesce(m.ends_on, $2::date) >= $2::date and m.visits_left <= ${n})` },
  debt_days: { label: 'Долг просрочен', unit: 'дней и больше', min: 1, max: 365,
    sql: (n) => `exists (select 1 from charges ch where ch.person_id = p.id and ch.club_id = $1 and ch.due_on <= $2::date - ${n} and ch.company_id is null
      and (ch.status = 'due' or (ch.status = 'paid' and (ch.paid_at at time zone c.timezone)::date > $2::date)))` },
  first_purchase_days: { label: 'С первой покупки прошло ровно', unit: 'дней', min: 0, max: 730,
    sql: (n) => `(select min((m.created_at at time zone c.timezone)::date) from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind <> 'guest') = $2::date - ${n}` },
  lead_days: { label: 'Заявка без покупки, прошло ровно', unit: 'дней', min: 0, max: 365,
    sql: (n) => `exists (select 1 from leads l where l.person_id = p.id and l.club_id = $1 and (l.created_at at time zone c.timezone)::date = $2::date - ${n})
      and not exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1 and m.kind <> 'guest')` },
  birthday: { label: 'Сегодня день рождения', sql: () => `to_char(p.birth_date, 'MM-DD') = to_char($2::date, 'MM-DD')` },
};
export const ACTIONS: Record<Step['action'], string> = { message: 'Отправить сообщение клиенту', task: 'Поставить задачу ответственному', points: 'Начислить бонусные баллы' };

const rid = () => `r${Math.random().toString(36).slice(2, 10)}`;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? x : d; };

/** Приводит правила к форме (без проверки смысла — её делает validateRules). */
export function normRules(v: unknown): Rule[] {
  if (!Array.isArray(v)) throw badRequest('Правила: нужен список');
  return v.map((x) => {
    const o = isObj(x) ? x : {};
    return {
      id: typeof o.id === 'string' && /^[a-z0-9_-]{2,40}$/i.test(o.id) ? o.id : rid(),
      name: String(o.name ?? '').trim().slice(0, 80),
      enabled: o.enabled !== false,
      conditions: (Array.isArray(o.conditions) ? o.conditions : []).filter(isObj).map((c) => ({ type: String(c.type ?? ''), ...(c.n !== undefined && c.n !== null && c.n !== '' ? { n: int(c.n, 0) } : {}) })),
      steps: (Array.isArray(o.steps) ? o.steps : []).filter(isObj).map((s) => {
        const action = (['message', 'task', 'points'].includes(String(s.action)) ? s.action : 'message') as Step['action'];
        const st: Step = { action, afterDays: Math.max(0, int(s.afterDays, 0)) };
        if (action === 'message') st.text = String(s.text ?? '').trim().slice(0, 1000);
        if (action === 'task') { st.title = String(s.title ?? '').trim().slice(0, 200); st.dueHours = Math.max(1, int(s.dueHours, 24)); }
        if (action === 'points') st.points = int(s.points, 0);
        return st;
      }),
      stopOnVisit: o.stopOnVisit === true, stopOnPurchase: o.stopOnPurchase !== false,
      cooldownDays: int(o.cooldownDays, 30), marketing: o.marketing !== false,
    };
  });
}

export function validateRules(rules: Rule[]): string[] {
  const errs: string[] = [];
  if (rules.length > 30) errs.push('Правил не больше 30');
  if (new Set(rules.map((r) => r.id)).size !== rules.length) errs.push('Правила повторяются');
  rules.forEach((r, i) => {
    const nm = `Правило «${r.name || i + 1}»`;
    if (!r.name) errs.push(`Правило ${i + 1}: укажите название`);
    if (!r.conditions.length) errs.push(`${nm}: нужно хотя бы одно условие «если»`);
    if (r.conditions.length > 6) errs.push(`${nm}: условий не больше 6`);
    for (const c of r.conditions) {
      const d = CONDITIONS[c.type];
      if (!d) { errs.push(`${nm}: неизвестное условие`); continue; }
      if (d.unit && (c.n === undefined || c.n < (d.min ?? 0) || c.n > (d.max ?? 1e6))) errs.push(`${nm}: «${d.label}» — число от ${d.min} до ${d.max}`);
    }
    if (r.conditions.some((c) => c.type === 'has_active') && r.conditions.some((c) => c.type === 'no_active')) errs.push(`${nm}: «есть абонемент» и «нет абонемента» вместе не бывают`);
    if (!r.steps.length) errs.push(`${nm}: нужен хотя бы один шаг «то»`);
    if (r.steps.length > 5) errs.push(`${nm}: шагов не больше 5`);
    r.steps.forEach((s, j) => {
      if (s.afterDays > 60) errs.push(`${nm}, шаг ${j + 1}: задержка не больше 60 дней`);
      if (j > 0 && s.afterDays < r.steps[j - 1].afterDays) errs.push(`${nm}, шаг ${j + 1}: шаги идут по порядку, задержка не меньше предыдущего`);
      if (s.action === 'message' && (!s.text || s.text.length < 5)) errs.push(`${nm}, шаг ${j + 1}: напишите текст сообщения`);
      if (s.action === 'task' && !s.title) errs.push(`${nm}, шаг ${j + 1}: напишите, что сделать`);
      if (s.action === 'points' && !(s.points! >= 1 && s.points! <= 10000)) errs.push(`${nm}, шаг ${j + 1}: баллов от 1 до 10 000`);
    });
    if (r.cooldownDays < 1 || r.cooldownDays > 365) errs.push(`${nm}: повторно для того же клиента — не чаще раза в 1–365 дней`);
  });
  return errs;
}

export async function readRules(db: Db, clubId: string): Promise<Rule[]> {
  return ((await db.query('select rules from club_rules where club_id = $1', [clubId])).rows[0]?.rules as Rule[]) ?? [];
}

/** Публикация из утверждённой версии настроек. Действующие запуски удалённых или выключенных правил останавливаются. */
export async function writeRules(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, clubId: string, rules: Rule[], versionId: string) {
  await db.query(`insert into club_rules(club_id, tenant_id, rules, config_version_id, updated_by) values ($1,$2,$3,$4,$5)
    on conflict (club_id) do update set rules = excluded.rules, config_version_id = excluded.config_version_id, updated_by = excluded.updated_by, updated_at = now()`,
  [clubId, ctx.tenantId, JSON.stringify(rules), versionId, ctx.userId]);
  const live = rules.filter((r) => r.enabled).map((r) => r.id);
  await db.query(`update rule_runs set status = 'stopped', stop_reason = 'правило выключено или удалено', finished_at = now() where club_id = $1 and status = 'active' and not (rule_id = any($2))`, [clubId, live]);
}

/** Кто подходит под все условия правила на дату (по домашнему клубу). */
export async function matchPersons(db: Db, clubId: string, r: Pick<Rule, 'conditions'>, date: string, limit = 500) {
  const where = r.conditions.map((c) => `(${CONDITIONS[c.type].sql(Math.round(c.n ?? 0))})`).join(' and ');
  return (await db.query(`select p.id as "personId", p.full_name as name from persons p join clubs c on c.id = $1
    where p.home_club_id = $1 and p.merged_into_id is null and ${where || 'false'} order by p.full_name limit ${limit}`, [clubId, date])).rows as { personId: string; name: string }[];
}

/** Проверка на истории: если бы правило действовало последние 30 дней — сколько раз сработало бы (с учётом «не чаще раза в N дней»). */
export async function backtestRule(db: Db, clubId: string, r: Rule, today: string, days = 30) {
  const last = new Map<string, string>(); let fires = 0; const names = new Map<string, string>();
  for (let i = days; i >= 1; i--) {
    const d = addDays(today, -i);
    for (const p of await matchPersons(db, clubId, r, d, 2000)) {
      const prev = last.get(p.personId);
      if (prev && addDays(prev, r.cooldownDays) > d) continue;
      last.set(p.personId, d); fires++; names.set(p.personId, p.name);
    }
  }
  const ids = [...names.keys()];
  const blocked = ids.length ? Number((await db.query(`select count(*)::int as n from persons where id = any($1) and (messaging_opt_out or ($2 and not marketing_consent))`, [ids, r.marketing])).rows[0].n) : 0;
  const msgSteps = r.steps.filter((s) => s.action === 'message').length;
  const taskSteps = r.steps.filter((s) => s.action === 'task').length;
  const nowList = await matchPersons(db, clubId, r, today, 2000);
  // Примеры: кто попал бы за 30 дней, а если никто — кто подойдёт сразу после публикации
  const sample = (names.size ? [...names.values()] : nowList.map((x) => x.name)).slice(0, 8);
  return { fires, persons: ids.length, messages: msgSteps * Math.max(0, fires - blocked), tasks: taskSteps * fires, blocked, now: nowList.length, sample };
}

/** Понятный текст правила: «Если …, то …». */
export function ruleText(r: Rule) {
  const cond = r.conditions.map((c) => { const d = CONDITIONS[c.type]; return d ? `${d.label.toLowerCase()}${d.unit ? ` ${c.n} ${d.unit}` : ''}` : c.type; }).join(' и ');
  const steps = r.steps.map((s) => `${s.afterDays ? `через ${s.afterDays} дн. ` : ''}${s.action === 'message' ? 'сообщение клиенту' : s.action === 'task' ? `задача «${s.title}»` : `+${s.points} баллов`}`).join(', затем ');
  return `Если ${cond}, то ${steps}`;
}

const render = (text: string, name: string, clubName: string) => text.replace(/\{имя\}/gi, firstName(name)).replace(/\{клуб\}/gi, clubName);

/**
 * Фоновый запуск: новые совпадения стартуют цепочку, наступившие шаги выполняются.
 * Сообщения — только в рабочее время (вызывается из блока рабочего времени), с учётом отписки, согласия и лимита автосообщений в неделю.
 */
export async function processRules(db: Db, f: Fetch | null, actor: Actor, clubId: string, today: string) {
  const rules = (await readRules(db, clubId)).filter((r) => r.enabled && !validateRules([r]).length);
  const stat = { started: 0, done: 0, skipped: 0, stopped: 0 };
  for (const r of rules) {
    for (const p of await matchPersons(db, clubId, r, today, 100)) {
      const recent = (await db.query(`select 1 from rule_runs where club_id = $1 and rule_id = $2 and person_id = $3 and (status = 'active' or started_at > now() - make_interval(days => $4))`,
        [clubId, r.id, p.personId, r.cooldownDays])).rowCount;
      if (recent) continue;
      await db.query(`insert into rule_runs(tenant_id, club_id, rule_id, rule_name, person_id, next_step, next_due_at) values ($1,$2,$3,$4,$5,0, now() + make_interval(days => $6)) on conflict do nothing`,
        [actor.tenantId, clubId, r.id, r.name, p.personId, r.steps[0].afterDays]);
      stat.started++;
    }
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  const club = (await db.query('select name from clubs where id = $1', [clubId])).rows[0]?.name ?? '';
  const limit = Number((await db.query('select max_auto_per_week from club_msg_settings where club_id = $1', [clubId])).rows[0]?.max_auto_per_week ?? 2);
  for (const run of (await db.query(`select * from rule_runs where club_id = $1 and status = 'active' and next_due_at <= now() order by next_due_at limit 300`, [clubId])).rows) {
    const r = byId.get(run.rule_id);
    if (!r) { await db.query(`update rule_runs set status = 'stopped', stop_reason = 'правило выключено', finished_at = now() where id = $1`, [run.id]); stat.stopped++; continue; }
    // Цель достигнута — клиент пришёл или купил после старта: дальше не беспокоим
    const came = r.stopOnVisit && (await db.query('select 1 from visits where person_id = $1 and club_id = $2 and visited_at > $3', [run.person_id, clubId, run.started_at])).rowCount;
    const bought = r.stopOnPurchase && (await db.query(`select 1 from memberships where person_id = $1 and club_id = $2 and kind <> 'guest' and created_at > $3`, [run.person_id, clubId, run.started_at])).rowCount;
    if (came || bought) {
      await db.query(`update rule_runs set status = 'stopped', stop_reason = $2, finished_at = now() where id = $1`, [run.id, came ? 'клиент пришёл' : 'клиент купил']);
      stat.stopped++; continue;
    }
    const s = r.steps[run.next_step];
    if (!s) { await db.query(`update rule_runs set status = 'done', finished_at = now() where id = $1`, [run.id]); continue; }
    const p = (await db.query('select full_name, marketing_consent, messaging_opt_out from persons where id = $1', [run.person_id])).rows[0];
    const log = (result: 'done' | 'skipped', details: string | null, refId: string | null = null) => db.query(`insert into rule_actions(tenant_id, club_id, run_id, person_id, step, action, result, details, ref_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [actor.tenantId, clubId, run.id, run.person_id, run.next_step, s.action, result, details, refId]);
    if (s.action === 'message') {
      const week = Number((await db.query(`select (select count(*) from msg_trigger_sends where person_id = $1 and club_id = $2 and created_at > now() - interval '7 days')
        + (select count(*) from rule_actions where person_id = $1 and club_id = $2 and action = 'message' and result = 'done' and created_at > now() - interval '7 days') as n`, [run.person_id, clubId])).rows[0].n);
      const reason = p.messaging_opt_out ? 'клиент отписался от сообщений' : r.marketing && !p.marketing_consent ? 'нет согласия на рекламные сообщения'
        : week >= limit ? `лимит: уже ${week} автосообщ. за неделю` : null;
      const conv = reason ? null : await conversationFor(db, actor, run.person_id, clubId, true);
      if (reason || !conv || conv === 'new') { await log('skipped', reason ?? 'нет мессенджера: клиент не писал в Telegram и в клубе не подключён WhatsApp'); stat.skipped++; }
      else {
        const mid = await queueMessage(db, actor, conv, render(s.text!, p.full_name, club), { auto: true });
        await db.query('update msg_conversations set last_message_at = now() where id = $1', [conv]);
        if (f) await deliver(db, f, mid);
        await log('done', null, mid); stat.done++;
      }
    } else if (s.action === 'task') {
      const { task } = await import('./retention.ts');
      const tid = await task(db, actor, clubId, run.person_id, `${render(s.title!, p.full_name, club)} (правило «${r.name}»)`, s.dueHours ?? 24);
      await log('done', null, tid); stat.done++;
    } else if (s.action === 'points') {
      const on = (await db.query('select enabled from club_loyalty where club_id = $1', [clubId])).rows[0]?.enabled;
      if (!on) { await log('skipped', 'бонусная программа выключена'); stat.skipped++; }
      else {
        const exp = (await db.query('select expire_days from club_loyalty where club_id = $1', [clubId])).rows[0].expire_days;
        const id = (await db.query(`insert into loyalty_moves(tenant_id, club_id, person_id, kind, points, expires_on, comment) values ($1,$2,$3,'correction',$4,$5,$6) returning id`,
          [actor.tenantId, clubId, run.person_id, s.points, addDays(today, exp), `Правило «${r.name}»`])).rows[0].id;
        await log('done', null, id); stat.done++;
      }
    }
    const next = r.steps[run.next_step + 1];
    if (next) await db.query(`update rule_runs set next_step = next_step + 1, next_due_at = started_at + make_interval(days => $2) where id = $1`, [run.id, next.afterDays]);
    else await db.query(`update rule_runs set status = 'done', next_step = next_step + 1, finished_at = now() where id = $1`, [run.id]);
  }
  return stat;
}

/* ---------- справочник для конструктора и журнал запусков ---------- */

export const TEMPLATES: Omit<Rule, 'id'>[] = [
  { name: 'Пропал перед окончанием абонемента', enabled: true, conditions: [{ type: 'inactive_days', n: 10 }, { type: 'ends_within', n: 30 }],
    steps: [{ action: 'message', afterDays: 0, text: '{имя}, давно вас не видели в клубе! Всё в порядке? Если нужна помощь с расписанием или тренером — напишите, подберём удобное время.' },
      { action: 'task', afterDays: 2, title: 'Позвонить {имя}: не ходит 10+ дней, абонемент скоро закончится', dueHours: 24 }], stopOnVisit: true, stopOnPurchase: true, cooldownDays: 30, marketing: false },
  { name: 'Осталось 2 посещения', enabled: true, conditions: [{ type: 'visits_left_lte', n: 2 }],
    steps: [{ action: 'task', afterDays: 0, title: 'Предложить {имя} продлить пакет посещений', dueHours: 48 }], stopOnVisit: false, stopOnPurchase: true, cooldownDays: 30, marketing: false },
  { name: 'Заявка без покупки 3 дня', enabled: true, conditions: [{ type: 'lead_days', n: 3 }],
    steps: [{ action: 'message', afterDays: 0, text: '{имя}, приглашаем на бесплатное пробное посещение в {клуб}! Напишите, когда удобно прийти.' }],
    stopOnVisit: true, stopOnPurchase: true, cooldownDays: 60, marketing: true },
  { name: 'Месяц с нами — спасибо', enabled: true, conditions: [{ type: 'first_purchase_days', n: 30 }],
    steps: [{ action: 'points', afterDays: 0, points: 200 }, { action: 'message', afterDays: 0, text: '{имя}, вы с нами уже месяц! Дарим 200 бонусных баллов — их можно потратить на ресепшне.' }],
    stopOnVisit: false, stopOnPurchase: false, cooldownDays: 365, marketing: false },
];

export function rulesRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/rules/meta', async (req) => {
    requirePerm(req, P.clubsView);
    return {
      conditions: Object.entries(CONDITIONS).map(([type, d]) => ({ type, label: d.label, unit: d.unit ?? null, min: d.min ?? null, max: d.max ?? null })),
      actions: Object.entries(ACTIONS).map(([action, label]) => ({ action, label })),
      templates: TEMPLATES,
    };
  });

  app.get('/api/rules/runs', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const q = req.query as { clubId?: string };
    if (!q.clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const rules = await readRules(db, q.clubId!);
      const stats = (await db.query(`select rule_id as "ruleId", count(*)::int as runs, count(*) filter (where status = 'active')::int as active,
          count(*) filter (where status = 'stopped' and stop_reason in ('клиент пришёл', 'клиент купил'))::int as goal
        from rule_runs where club_id = $1 and started_at > now() - interval '30 days' group by 1`, [q.clubId])).rows;
      const recent = (await db.query(`select a.created_at as "at", r.rule_name as rule, p.full_name as person, a.person_id as "personId", a.action, a.result, a.details
        from rule_actions a join rule_runs r on r.id = a.run_id join persons p on p.id = a.person_id where a.club_id = $1 order by a.created_at desc limit 30`, [q.clubId])).rows;
      return { rules: rules.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, text: ruleText(r), ...(stats.find((s) => s.ruleId === r.id) ?? { runs: 0, active: 0, goal: 0 }) })), recent };
    });
  });
}
