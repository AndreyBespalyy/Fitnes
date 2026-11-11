// Шаг 18, часть 4. Тиражирование (ТЗ 2.2): подключение клуба по чек-листу за 10 рабочих дней,
// демо-клуб с учебными данными, обращения в поддержку, договор сети с платформой и ограничения тарифа.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { applyClubPreset } from '../presets.ts';
import { createLead } from './crm.ts';
import { addDays, sellMembership } from './memberships.ts';

type Check = (db: Db, clubId: string, today: string) => Promise<boolean>;
type Item = { code: string; title: string; hint: string; tab: string; day: number; optional?: boolean; auto?: Check };
const exists = (sql: string): Check => async (db, clubId, today) => !!(await db.query(sql, sql.includes('$2') ? [clubId, today] : [clubId])).rowCount;

// Порядок — как подключать клуб: за 10 рабочих дней (шаг 18 плана: «подключение второго клуба с нуля за 10 рабочих дней»)
export const ITEMS: Item[] = [
  { code: 'card', day: 1, tab: 'clubs', title: 'Карточка клуба: адрес, часовой пояс, модель продаж', hint: 'Раздел «Клубы»',
    auto: exists(`select 1 from clubs where id = $1 and coalesce(address, '') <> ''`) },
  { code: 'legal', day: 1, tab: 'contracts', title: 'Юрлицо и реквизиты для договора', hint: 'Раздел «Договоры»: ИНН, банк, кто подписывает',
    auto: exists(`select 1 from legal_entities where club_id = $1`) },
  { code: 'config', day: 1, tab: 'config', title: 'Выбран готовый набор настроек и опубликован', hint: 'Раздел «Настройки клуба»: премиальный, массовый, студия или свои значения',
    auto: exists(`select 1 from config_versions where club_id = $1 and status = 'published'`) },
  { code: 'pipelines', day: 1, tab: 'pipelines', title: 'Воронки продаж и этапы', hint: 'Создаются по модели продаж, при необходимости поправьте этапы в «Воронках»',
    auto: exists(`select 1 from pipelines p join pipeline_stages s on s.pipeline_id = p.id where p.club_id = $1`) },
  { code: 'tariffs', day: 2, tab: 'tariffs', title: 'Прейскурант: цены клуба проверены', hint: 'Раздел «Тарифы». Готовые тарифы создаются с типовыми ценами, поменяйте их на свои',
    auto: exists(`select 1 from price_versions where club_id = $1 and created_by is not null`) },
  { code: 'gm', day: 2, tab: 'staff', title: 'Назначен управляющий клуба', hint: 'Раздел «Сотрудники»',
    auto: exists(`select 1 from user_assignments a join users u on u.id = a.user_id where a.club_id = $1 and a.role_code = 'gm' and u.status = 'active' and (a.active_to is null or a.active_to >= $2::date)`) },
  { code: 'staff', day: 2, tab: 'staff', title: 'Заведены менеджеры и администраторы ресепшн', hint: 'Раздел «Сотрудники»: у каждого свой логин и временный пароль',
    auto: async (db, clubId, today) => (await db.query(`select count(distinct a.role_code)::int as n from user_assignments a join users u on u.id = a.user_id
      where a.club_id = $1 and a.role_code in ('manager', 'desk') and u.status = 'active' and (a.active_to is null or a.active_to >= $2::date)`, [clubId, today])).rows[0].n === 2 },
  { code: 'fiscal', day: 3, tab: 'fiscal', title: 'Касса: облачная или в клубе', hint: 'Раздел «Касса». Проверка — пробный чек',
    auto: exists(`select 1 from club_fiscal_settings where club_id = $1 and mode <> 'none'`) },
  { code: 'acquiring', day: 3, tab: 'finance', optional: true, title: 'Онлайн-оплата: договор с банком подключён', hint: 'Финансы → Онлайн-оплата. Пока стоит тестовый банк',
    auto: exists(`select 1 from club_acquiring where club_id = $1 and provider <> 'test'`) },
  { code: 'messaging', day: 4, tab: 'messaging', optional: true, title: 'Мессенджеры: Telegram или WhatsApp', hint: 'Раздел «Сообщения» → каналы',
    auto: exists(`select 1 from msg_channels where club_id = $1 and status = 'active' and kind <> 'test'`) },
  { code: 'access', day: 4, tab: 'access', optional: true, title: 'Турникеты: шлюз на связи', hint: 'Проходы → Настройка. Шлюз ставится на компьютер ресепшн',
    auto: exists(`select 1 from access_gateways where club_id = $1 and status = 'active' and last_seen_at is not null`) },
  { code: 'import', day: 6, tab: 'import', optional: true, title: 'Клиенты и абонементы перенесены из прежней системы', hint: 'Раздел «Перенос из 1С»: пробный перенос, сверка, применение',
    auto: exists(`select 1 from import_batches where club_id = $1 and status in ('applied', 'accepted')`) },
  { code: 'plan', day: 6, tab: 'dash', title: 'План продаж на текущий месяц', hint: 'Рабочий стол → План',
    auto: exists(`select 1 from plan_targets where club_id = $1 and user_id is null and month = date_trunc('month', $2::date)::date and amount_kop > 0`) },
  { code: 'schedule', day: 7, tab: 'stafftime', title: 'График смен на неделю вперёд', hint: 'Раздел «График и зарплата». От графика зависят нормы KPI и заявки в нерабочее время',
    auto: exists(`select 1 from staff_shifts where club_id = $1 and day between $2::date and $2::date + 7`) },
  { code: 'training', day: 8, tab: 'help', title: 'Обучение сотрудников по ролям', hint: 'Раздел «Помощь»: инструкции. Потренироваться можно в демо-клубе' },
  { code: 'test_sale', day: 9, tab: 'tariffs', title: 'Пробная продажа, чек и договор', hint: 'Продайте тестовый абонемент сотруднику, проверьте чек и печать договора, затем сделайте возврат',
    auto: exists(`select 1 from memberships m where m.club_id = $1 and exists (select 1 from contracts c where c.membership_id = m.id)`) },
  { code: 'launch', day: 10, tab: 'dash', title: 'Первый рабочий день: клуб работает в системе', hint: 'Отметьте вручную, когда клуб перешёл на новую систему' },
];

/** Рабочий день n (1…) от даты старта, без суббот и воскресений. Старт в выходной — первый рабочий день следующий понедельник */
export function workDay(start: string, n: number) {
  let d = start; let k = 0;
  for (;;) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) { k++; if (k === n) return d; }
    d = addDays(d, 1);
  }
}

export async function onboardingState(db: Db, clubId: string) {
  const club = (await db.query(`select id, name, is_demo as "isDemo", to_char(coalesce(onboarding_started_on, (created_at at time zone timezone)::date), 'YYYY-MM-DD') as start,
    to_char(now() at time zone timezone, 'YYYY-MM-DD') as today from clubs where id = $1`, [clubId])).rows[0];
  if (!club) throw notFound('Клуб не найден');
  const marks = new Map((await db.query(`select o.item, o.status, o.note, to_char(o.marked_at, 'YYYY-MM-DD') as at, u.full_name as by
    from club_onboarding o left join users u on u.id = o.marked_by where o.club_id = $1`, [clubId])).rows.map((r) => [r.item, r]));
  const items = [];
  for (const it of ITEMS) {
    const autoDone = it.auto ? await it.auto(db, clubId, club.today) : false;
    const m = marks.get(it.code);
    const status = autoDone ? 'done' : m?.status ?? 'todo';
    const due = workDay(club.start, it.day);
    items.push({ code: it.code, title: it.title, hint: it.hint, tab: it.tab, day: it.day, due, optional: !!it.optional, manualOnly: !it.auto,
      status, by: autoDone ? 'система' : m ? m.by : null, at: autoDone ? null : m?.at ?? null, note: m?.note ?? null,
      overdue: status === 'todo' && due < club.today });
  }
  const done = items.filter((i) => i.status !== 'todo').length;
  const finish = workDay(club.start, 10);
  return { clubId, name: club.name, isDemo: club.isDemo, start: club.start, finish, today: club.today, items, done, total: items.length,
    percent: Math.round((done * 100) / items.length), overdue: items.filter((i) => i.overdue).length,
    next: items.find((i) => i.status === 'todo') ?? null };
}

// ——— Ограничения тарифа платформы ———
export async function contractOf(db: Db) {
  return (await db.query(`select number, to_char(signed_on, 'YYYY-MM-DD') as "signedOn", plan, clubs_limit as "clubsLimit", users_limit as "usersLimit",
    to_char(valid_to, 'YYYY-MM-DD') as "validTo", fee_kop as "feeKop", note from tenant_contracts limit 1`)).rows[0] ?? null;
}
async function usage(db: Db) {
  return (await db.query(`select (select count(*)::int from clubs where status = 'active' and not is_demo) as clubs,
    (select count(*)::int from users where status = 'active') as users`)).rows[0] as { clubs: number; users: number };
}
/** Проверка перед созданием клуба или сотрудника: при исчерпании тарифа — понятная ошибка (в работе клуба ничего не блокируется) */
export async function checkLimit(db: Db, what: 'clubs' | 'users') {
  const c = await contractOf(db);
  const lim = what === 'clubs' ? c?.clubsLimit : c?.usersLimit;
  if (!lim) return;
  const u = await usage(db);
  if (u[what] >= lim) {
    throw badRequest(what === 'clubs'
      ? `По тарифу «${c.plan}» можно подключить клубов: ${lim}. Чтобы добавить ещё, свяжитесь с поддержкой платформы`
      : `По тарифу «${c.plan}» можно завести активных сотрудников: ${lim}. Заблокируйте уволенных или свяжитесь с поддержкой платформы`, 'plan_limit');
  }
}

// ——— Демо-клуб ———
const DEMO_FIRST = ['Анна', 'Иван', 'Мария', 'Дмитрий', 'Ольга', 'Максим', 'Юлия', 'Артём', 'Дарья', 'Никита', 'Полина', 'Егор'];
const DEMO_LAST = ['Демидов', 'Учебнов', 'Пробный', 'Тестов', 'Образцов', 'Примеров'];

/** Создаёт демо-клуб: тарифы, реквизиты (вымышленные), месяц заявок, встреч, продаж и посещений. Только учебные данные */
export async function createDemoClub(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, model: 'term' | 'subscription') {
  const name = model === 'term' ? 'Демо-клуб (абонементы)' : 'Демо-клуб (подписка)';
  const had = (await db.query(`select id from clubs where name = $1`, [name])).rows[0];
  if (had) throw badRequest('Такой демо-клуб уже есть. Его можно закрыть и создать заново', 'demo_exists');
  const t = ctx.tenantId;
  const clubId = (await db.query(`insert into clubs(tenant_id, name, address, timezone, sales_model, is_demo) values ($1,$2,'Учебный адрес, д. 1','Europe/Moscow',$3,true) returning id`,
    [t, name, model])).rows[0].id as string;
  await db.query('insert into club_sales_model_history(tenant_id, club_id, old_model, new_model, apply_from, changed_by) values ($1,$2,null,$3,$4,$5)', [t, clubId, model, 'now', ctx.userId]);
  await applyClubPreset(db, t, clubId, model);
  await db.query(`insert into legal_entities(club_id, tenant_id, full_name, inn, address, signer_name, signer_basis, contract_prefix)
    values ($1,$2,'ООО «Демо» (учебные данные)','7700000000','Учебный адрес, д. 1','Учебный И. И.','устава','Д')`, [clubId, t]);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const today = (await db.query(`select to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM-DD') as d`)).rows[0].d as string;
  const products = (await db.query(`select id, kind from products where club_id = $1 and kind in ('term', 'visits', 'subscription') order by sort`, [clubId])).rows;
  const stages = (await db.query(`select s.id, s.kind from pipeline_stages s join pipelines p on p.id = s.pipeline_id where p.club_id = $1 and p.is_default_for_leads`, [clubId])).rows;
  const won = stages.find((s) => s.kind === 'won')?.id;
  const actor = { tenantId: t, userId: ctx.userId };
  let sold = 0; let n = 0;
  for (let back = 28; back >= 0; back--) {
    const day = addDays(today, -back);
    for (let k = 0; k < 2; k++) {
      const at = new Date(Date.parse(`${day}T07:00:00Z`) + Math.floor(rnd() * 600) * 60_000);
      if (at.getTime() > Date.now() - 30 * 60_000) continue;
      const fullName = `${pick(DEMO_FIRST)} ${pick(DEMO_LAST)} (демо)`;
      const phone = `+7900000${String(1000 + n++).slice(-4)}`;
      const lead = await createLead(db, actor, { clubId, fullName, phone, sourceCode: pick(['site', 'yandex_direct', 'telegram', 'walk_in']), assignedTo: ctx.userId ?? undefined, comment: 'Учебная заявка' });
      await db.query(`update leads set created_at = $2, first_response_due_at = $2::timestamptz + interval '5 minutes', first_response_at = $2::timestamptz + interval '3 minutes' where id = $1`, [lead.leadId, at]);
      await db.query(`update tasks set created_at = $2, due_at = $2::timestamptz + interval '5 minutes', done_at = $2::timestamptz + interval '3 minutes', result = 'Учебный звонок' where lead_id = $1`, [lead.leadId, at]);
      await db.query(`update opportunities set created_at = $2, updated_at = $2 where id = $1`, [lead.opportunityId, at]);
      if (rnd() < 0.4 && back > 0 && products.length) {
        const prod = model === 'subscription' ? products.find((p) => p.kind === 'subscription') ?? products[0] : pick(products.filter((p) => p.kind !== 'subscription'));
        const sale = await sellMembership(db, actor, { personId: lead.personId, productId: prod.id, confirmDuplicate: true });
        const saleAt = new Date(at.getTime() + 86_400_000);
        const shift = Math.max(0, back - 1);
        await db.query('update memberships set created_at = $2, starts_on = starts_on - $3::int, ends_on = ends_on - $3::int, next_charge_on = next_charge_on - $3::int where id = $1', [sale.id, saleAt, shift]);
        await db.query('update charges set due_on = due_on - $2::int, created_at = $3 where membership_id = $1', [sale.id, shift, saleAt]);
        await db.query('update contracts set contract_date = contract_date - $2::int, created_at = $3 where membership_id = $1', [sale.id, shift, saleAt]);
        // Журнал операций абонемента не переписывается: в нём остаётся настоящее время создания учебных данных
        await db.query(`update charges set status = 'paid', paid_at = $2, paid_method = 'card_terminal' where membership_id = $1 and due_on <= $3`, [sale.id, saleAt, today]);
        await db.query(`insert into payments(tenant_id, club_id, direction, kind, amount_kop, method, person_id, charge_id, sale_category, created_by, created_at)
          select ch.tenant_id, ch.club_id, 'in', 'charge', ch.amount_kop, ch.paid_method, ch.person_id, ch.id, m.sale_category, $2, ch.paid_at
          from charges ch join memberships m on m.id = ch.membership_id where ch.membership_id = $1 and ch.status = 'paid'`, [sale.id, ctx.userId]);
        if (won) await db.query(`update opportunities set status = 'won', stage_id = $2, closed_at = $3, updated_at = $3 where id = $1`, [lead.opportunityId, won, saleAt]);
        for (let d = shift; d >= 0; d -= 3) {
          const v = new Date(Date.parse(`${addDays(today, -d)}T06:00:00Z`) + Math.floor(rnd() * 700) * 60_000);
          if (v.getTime() < Date.now()) await db.query(`insert into visits(tenant_id, club_id, person_id, membership_id, visited_at, source) values ($1,$2,$3,$4,$5,'manual')`, [t, clubId, lead.personId, sale.id, v]);
        }
        sold++;
      }
    }
  }
  const month = `${today.slice(0, 7)}-01`;
  const cats = model === 'term' ? [['new', 30_000_000], ['renewal', 8_000_000]] : [['subscription', 15_000_000], ['new', 4_000_000]];
  for (const [cat, kop] of cats) await db.query('insert into plan_targets(tenant_id, club_id, month, category, amount_kop) values ($1,$2,$3,$4,$5) on conflict do nothing', [t, clubId, month, cat, kop]);
  await audit(db, { tenantId: t, userId: ctx.userId }, 'club.demo_created', 'club', clubId, null, { name, model, leads: n, sold });
  return { id: clubId, name, leads: n, sold };
}

// ——— Поддержка ———
const KINDS = ['question', 'bug', 'idea', 'access'];
const TICKET = `select t.id, t.number, t.subject, t.kind, t.status, t.page, t.club_id as "clubId", c.name as "clubName", t.author_id as "authorId", u.full_name as "author",
  t.escalated_at as "escalatedAt", t.created_at as "createdAt", t.updated_at as "updatedAt",
  (select count(*)::int from support_messages m where m.ticket_id = t.id) as messages
  from support_tickets t join users u on u.id = t.author_id left join clubs c on c.id = t.club_id`;
const answerer = (ctx: Ctx) => can(ctx, P.supportAnswer);

/** Технические сведения из экрана: только время, вид, короткий текст без данных клиентов (адреса запросов — без параметров) */
function cleanTechLog(x: unknown) {
  if (!Array.isArray(x)) return null;
  const out = x.slice(-30).filter((e) => e && typeof e === 'object').map((e) => {
    const r = e as Record<string, unknown>;
    return { at: String(r.at ?? '').slice(0, 30), kind: String(r.kind ?? '').slice(0, 20),
      text: String(r.text ?? '').replace(/\?[^\s]*/g, '').replace(/\+?\d[\d\s()-]{9,}\d/g, '[номер]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[почта]').slice(0, 300) };
  });
  return out.length ? out : null;
}

export function onboardingRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/onboarding', async (req) => {
    const ctx = requirePerm(req, P.clubsManage);
    return withCtx(pool, ctx, async (db) => {
      const clubs = (await db.query(`select id from clubs where status = 'active' order by is_demo, created_at`)).rows;
      const list = [];
      for (const c of clubs) list.push(await onboardingState(db, c.id));
      return { clubs: list, contract: await contractOf(db), usage: await usage(db) };
    });
  });

  app.get('/api/onboarding/:clubId', async (req) => {
    const ctx = requirePerm(req, P.clubsManage);
    const { clubId } = req.params as { clubId: string };
    return withCtx(pool, ctx, (db) => onboardingState(db, clubId));
  });

  app.post('/api/onboarding/:clubId/items/:item', async (req) => {
    const ctx = requirePerm(req, P.clubsManage);
    const { clubId, item } = req.params as { clubId: string; item: string };
    const b = (req.body ?? {}) as { status?: string; note?: string };
    const it = ITEMS.find((i) => i.code === item);
    if (!it) throw badRequest('Неизвестный пункт');
    if (!['done', 'skipped', 'todo'].includes(b.status ?? '')) throw badRequest('Отметка: сделано, не нужно или вернуть в работу');
    // Пункты, которые система проверяет по данным, вручную «сделанными» не отмечаются — только «не нужно» для необязательных
    if (b.status === 'done' && it.auto) throw badRequest('Этот пункт отметится сам, когда данные появятся в системе');
    if (b.status === 'skipped' && !it.optional) throw badRequest('Этот пункт обязателен для запуска клуба');
    if (b.status === 'skipped' && !b.note?.trim()) throw badRequest('Напишите, почему пункт не нужен');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw notFound('Клуб не найден');
      const before = (await db.query('select status, note from club_onboarding where club_id = $1 and item = $2', [clubId, item])).rows[0] ?? null;
      if (b.status === 'todo') await db.query('delete from club_onboarding where club_id = $1 and item = $2', [clubId, item]);
      else await db.query(`insert into club_onboarding(tenant_id, club_id, item, status, note, marked_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (club_id, item) do update set status = excluded.status, note = excluded.note, marked_by = excluded.marked_by, marked_at = now()`,
        [ctx.tenantId, clubId, item, b.status, b.note?.trim() || null, ctx.userId]);
      await audit(db, ctx, 'onboarding.marked', 'club', clubId, before, { item, status: b.status, note: b.note ?? null });
      return onboardingState(db, clubId);
    });
  });

  app.patch('/api/onboarding/:clubId', async (req) => {
    const ctx = requirePerm(req, P.clubsManage);
    const { clubId } = req.params as { clubId: string };
    const b = (req.body ?? {}) as { start?: string };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start ?? '')) throw badRequest('Укажите дату начала подключения');
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query('update clubs set onboarding_started_on = $2 where id = $1', [clubId, b.start]);
      if (!r.rowCount) throw notFound('Клуб не найден');
      await audit(db, ctx, 'onboarding.start_set', 'club', clubId, null, { start: b.start });
      return onboardingState(db, clubId);
    });
  });

  app.post('/api/clubs/demo', async (req, reply) => {
    const ctx = requirePerm(req, P.clubsManage);
    if (!ctx.allClubs) throw forbidden('Демо-клуб создаёт собственник или администратор системы');
    const b = (req.body ?? {}) as { salesModel?: string };
    const model = b.salesModel === 'subscription' ? 'subscription' : 'term';
    const r = await withCtx(pool, ctx, (db) => createDemoClub(db, ctx, model));
    reply.code(201);
    return r;
  });

  app.post('/api/clubs/:id/close-demo', async (req) => {
    const ctx = requirePerm(req, P.clubsManage);
    if (!ctx.allClubs) throw forbidden('Закрыть демо-клуб может собственник или администратор системы');
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select name, is_demo from clubs where id = $1', [id])).rows[0];
      if (!c) throw notFound('Клуб не найден');
      if (!c.is_demo) throw badRequest('Закрыть так можно только демо-клуб');
      // Данные не удаляются (деньги не переписываются), клуб просто скрывается; имя освобождается для нового демо-клуба
      await db.query(`update clubs set status = 'closed', name = name || ' — закрыт ' || to_char(now(), 'DD.MM.YYYY HH24:MI'), updated_at = now() where id = $1`, [id]);
      await audit(db, ctx, 'club.demo_closed', 'club', id, { name: c.name }, null);
      return { ok: true };
    });
  });

  app.get('/api/platform/contract', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, '*') && !can(ctx, P.clubsManage)) throw forbidden('Нет доступа');
    return withCtx(pool, ctx, async (db) => ({ contract: await contractOf(db), usage: await usage(db) }));
  });

  // Поддержка: пишет любой сотрудник, видит своё; собственник и администратор системы видят все обращения сети и отвечают
  app.get('/api/support', async (req) => {
    const ctx = requireCtx(req);
    const q = (req.query ?? {}) as { status?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`${TICKET} where ($1::boolean or t.author_id = $2) and ($3::text is null or t.status = $3)
      order by (t.status = 'closed'), t.updated_at desc limit 200`, [answerer(ctx), ctx.userId, q.status || null])).rows);
  });

  app.post('/api/support', async (req, reply) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { subject?: string; body?: string; kind?: string; clubId?: string; page?: string; clientInfo?: string; techLog?: unknown; appVersion?: string };
    const subject = b.subject?.trim(); const body = b.body?.trim();
    if (!subject) throw badRequest('Коротко напишите, о чём вопрос');
    if (!body) throw badRequest('Опишите вопрос подробнее');
    const kind = KINDS.includes(b.kind ?? '') ? b.kind : 'question';
    const r = await withCtx(pool, ctx, async (db) => {
      const clubId = b.clubId && b.clubId !== 'all' && (await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount ? b.clubId : null;
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`support:${ctx.tenantId}`]);
      const number = (await db.query('select coalesce(max(number), 0) + 1 as n from support_tickets')).rows[0].n;
      const id = (await db.query(`insert into support_tickets(tenant_id, club_id, number, author_id, subject, kind, page, client_info, tech_log, app_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [ctx.tenantId, clubId, number, ctx.userId, subject.slice(0, 200), kind, b.page?.slice(0, 60) ?? null, b.clientInfo?.slice(0, 300) ?? null,
          JSON.stringify(cleanTechLog(b.techLog)), b.appVersion?.slice(0, 40) ?? null])).rows[0].id;
      await db.query('insert into support_messages(tenant_id, ticket_id, author_id, body) values ($1,$2,$3,$4)', [ctx.tenantId, id, ctx.userId, body.slice(0, 5000)]);
      await audit(db, ctx, 'support.created', 'support_ticket', id, null, { number, subject, kind });
      return (await db.query(`${TICKET} where t.id = $1`, [id])).rows[0];
    });
    reply.code(201);
    return r;
  });

  const loadTicket = async (db: Db, ctx: Ctx, id: string) => {
    const t = (await db.query(`${TICKET} where t.id = $1`, [id])).rows[0];
    if (!t || (!answerer(ctx) && t.authorId !== ctx.userId)) throw notFound('Обращение не найдено');
    return t;
  };

  app.get('/api/support/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const t = await loadTicket(db, ctx, id);
      const messages = (await db.query(`select m.id, m.body, m.from_support as "fromSupport", m.created_at as "createdAt", coalesce(u.full_name, 'Поддержка платформы') as author
        from support_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.created_at`, [id])).rows;
      const tech = answerer(ctx) ? (await db.query(`select tech_log as "techLog", client_info as "clientInfo", app_version as "appVersion" from support_tickets where id = $1`, [id])).rows[0] : {};
      return { ...t, ...tech, messagesList: messages, canAnswer: answerer(ctx) };
    });
  });

  app.post('/api/support/:id/messages', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const body = ((req.body ?? {}) as { body?: string }).body?.trim();
    if (!body) throw badRequest('Напишите сообщение');
    return withCtx(pool, ctx, async (db) => {
      const t = await loadTicket(db, ctx, id);
      const fromSupport = answerer(ctx) && t.authorId !== ctx.userId;
      await db.query('insert into support_messages(tenant_id, ticket_id, author_id, from_support, body) values ($1,$2,$3,$4,$5)', [ctx.tenantId, id, ctx.userId, fromSupport, body.slice(0, 5000)]);
      await db.query(`update support_tickets set status = $2, updated_at = now() where id = $1`, [id, fromSupport ? 'answered' : 'open']);
      return { ok: true };
    });
  });

  app.post('/api/support/:id/status', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: string; escalate?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const t = await loadTicket(db, ctx, id);
      if (b.escalate) {
        if (!answerer(ctx)) throw forbidden('Передать разработчикам может собственник или администратор системы');
        await db.query('update support_tickets set escalated_at = coalesce(escalated_at, now()), updated_at = now() where id = $1', [id]);
        await audit(db, ctx, 'support.escalated', 'support_ticket', id, null, { number: t.number });
        return { ok: true };
      }
      if (!['open', 'closed'].includes(b.status ?? '')) throw badRequest('Статус: открыть или закрыть');
      await db.query('update support_tickets set status = $2, updated_at = now() where id = $1', [id, b.status]);
      await audit(db, ctx, `support.${b.status === 'closed' ? 'closed' : 'reopened'}`, 'support_ticket', id, { status: t.status }, { status: b.status });
      return { ok: true };
    });
  });
}
