// Защита базы клиентов от увода: лимит полных номеров в час, сигналы о всплеске просмотров и поисков,
// выгрузки с данными клиентов сверх лимита — только с согласованием управляющего, подпись выгрузившего в каждом файле.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { notifyStaffSafe } from '../lib/staffNotify.ts';

export const PROTECTION_DEFAULTS = { exportRowsLimit: 200, revealsPerHour: 40, cardViewsAlert: 150, searchesAlert: 150 };
export type Protection = typeof PROTECTION_DEFAULTS;
type Kind = 'reveal' | 'card' | 'search';

const KIND_TEXT: Record<Kind | 'export', string> = {
  reveal: 'полных номеров и договоров клиентов',
  card: 'карточек клиентов',
  search: 'поисков по базе клиентов',
  export: 'строк в выгрузке с данными клиентов',
};

export async function protectionSettings(db: Db, clubId: string | null): Promise<Protection> {
  if (!clubId) return { ...PROTECTION_DEFAULTS };
  const r = (await db.query(`select export_rows_limit as "exportRowsLimit", reveals_per_hour as "revealsPerHour", card_views_alert as "cardViewsAlert",
      searches_alert as "searchesAlert" from data_protection_settings where club_id = $1`, [clubId])).rows[0];
  return r ?? { ...PROTECTION_DEFAULTS };
}

/** Клуб, по порогам которого считаем сотрудника: явно указанный, клуб клиента или первый клуб сотрудника. */
function staffClub(ctx: Ctx, explicit: string | null | undefined) {
  return explicit ?? ctx.clubIds[0] ?? null;
}

const fmtTime = (d: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(d);

/** Руководители клуба, которым приходят сигналы: управляющие клуба, а для сетевых сотрудников — собственники. */
async function leadersOf(db: Db, clubId: string | null): Promise<string[]> {
  const rows = (await db.query(
    `select distinct a.user_id from user_assignments a join users u on u.id = a.user_id
     where u.status = 'active' and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)
       and ((a.role_code = 'gm' and $1::uuid is not null and a.club_id = $1) or a.role_code = 'owner')`, [clubId])).rows;
  return rows.map((r) => r.user_id as string);
}

async function raiseAlert(pool: pg.Pool, db: Db, ctx: Ctx, kind: Kind | 'export', clubId: string | null, count: number, threshold: number, hour: Date) {
  const ins = (await db.query(
    `insert into pd_alerts(tenant_id, club_id, user_id, kind, count, threshold, hour) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (user_id, kind, hour) do nothing returning id`, [ctx.tenantId, clubId, ctx.userId, kind, count, threshold, hour])).rows[0];
  if (!ins) return;
  const who = (await db.query('select full_name from users where id = $1', [ctx.userId])).rows[0]?.full_name ?? 'Сотрудник';
  const text = kind === 'export'
    ? `${who} запросил выгрузку: ${count} ${KIND_TEXT.export} (без согласования можно до ${threshold}). Решение — в разделе «Защита данных».`
    : `${who} за час открыл больше ${threshold} ${KIND_TEXT[kind]} (уже ${count}). Проверьте, нет ли попытки выгрузить базу. Подробности — в разделе «Защита данных».`;
  const leaders = (await leadersOf(db, clubId)).filter((id) => id !== ctx.userId);
  if (clubId) {
    for (const id of leaders) {
      const isGm = (await db.query(`select 1 from user_assignments where user_id = $1 and role_code = 'gm' and club_id = $2`, [id, clubId])).rowCount;
      if (!isGm) continue; // задачу ставим управляющему клуба; собственнику — только сообщение
      await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'other',$4, now() + interval '2 hours')`,
        [ctx.tenantId, clubId, id, `Защита данных: ${text}`.slice(0, 500)]);
    }
  }
  await audit(db, ctx, 'pd.alert', 'user', ctx.userId, null, { kind, count, threshold, clubId });
  // Сообщение в Telegram после фиксации транзакции
  setImmediate(() => { void notifyStaffSafe(pool, ctx.tenantId, leaders, `⚠️ ${text}`); });
}

/**
 * Считает обращение к данным клиентов в отдельной транзакции (чтобы счётчик и сигнал сохранились, даже если запрос будет отклонён).
 * Возвращает blocked = true, если сотрудник исчерпал лимит полных номеров на этот час.
 */
export async function trackAccess(pool: pg.Pool, ctx: Ctx, kind: Kind, where: { personId?: string; clubId?: string | null } = {}): Promise<{ blocked: boolean; limit: number; n: number }> {
  return withCtx(pool, ctx, async (db) => {
    let clubId = where.clubId ?? null;
    if (!clubId && where.personId) clubId = (await db.query('select home_club_id from persons where id = $1', [where.personId])).rows[0]?.home_club_id ?? null;
    clubId = staffClub(ctx, clubId);
    const hour = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
    const n = (await db.query(
      `insert into pd_access_counters(tenant_id, user_id, kind, hour, club_id, n) values ($1,$2,$3,$4,$5,1)
       on conflict (user_id, kind, hour) do update set n = pd_access_counters.n + 1 returning n`, [ctx.tenantId, ctx.userId, kind, hour, clubId])).rows[0].n as number;
    const s = await protectionSettings(db, clubId);
    const limit = kind === 'reveal' ? s.revealsPerHour : kind === 'card' ? s.cardViewsAlert : s.searchesAlert;
    // Руководители с правом защиты данных не ограничиваются и не порождают сигналов о себе
    if (can(ctx, P.dataProtect)) return { blocked: false, limit, n };
    if (n === limit + 1) await raiseAlert(pool, db, ctx, kind, clubId, n, limit, hour);
    return { blocked: kind === 'reveal' && n > limit, limit, n };
  });
}

/** Проверка перед раскрытием полного номера или договора: при исчерпании лимита — отказ с понятным текстом. */
export async function guardReveal(pool: pg.Pool, ctx: Ctx, where: { personId?: string; clubId?: string | null }) {
  const r = await trackAccess(pool, ctx, 'reveal', where);
  if (r.blocked) {
    throw new HttpError(429, `За этот час вы уже открыли ${r.limit} полных номеров и договоров клиентов — это лимит клуба. `
      + 'Продолжить можно в начале следующего часа. Если лимит мешает работе, попросите управляющего его поднять', 'reveal_limit');
  }
}

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== '')
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

/**
 * Выгрузка с данными клиентов. В пределах лимита клуба (по умолчанию 200 строк) — сразу. Больше — нужен одобренный запрос
 * (действует сутки, один раз). Руководители с правом защиты данных выгружают без ограничений. Всё пишется в журнал.
 * Возвращает подпись, которую нужно добавить в конец файла.
 */
export async function guardExport(pool: pg.Pool, ctx: Ctx, e: { report: string; title: string; clubId?: string | null; params: Record<string, unknown>; rows: number; format: string }) {
  const params = { ...e.params };
  delete params.format;
  const hash = createHash('sha256').update(`${e.report}|${stable(params)}`).digest('hex');
  const res = await withCtx(pool, ctx, async (db) => {
    const clubId = staffClub(ctx, e.clubId);
    const s = await protectionSettings(db, clubId);
    const who = (await db.query('select full_name, login from users where id = $1', [ctx.userId])).rows[0];
    const sign = `Выгрузил: ${who?.full_name ?? '—'} (${who?.login ?? '—'}), ${fmtTime(new Date())} МСК. Данные клиентов: только для работы в клубе, передавать третьим лицам запрещено`;
    let approvedId: string | null = null;
    if (e.rows > s.exportRowsLimit && !can(ctx, P.dataProtect)) {
      const ok = (await db.query(
        `update export_requests set status = 'used', used_at = now() where id = (select id from export_requests where user_id = $1 and params_hash = $2 and status = 'approved'
           and decided_at > now() - interval '24 hours' order by decided_at desc limit 1) returning id`, [ctx.userId, hash])).rows[0];
      if (!ok) {
        const pending = (await db.query(`select id from export_requests where user_id = $1 and params_hash = $2 and status = 'pending'`, [ctx.userId, hash])).rows[0];
        if (!pending) {
          await db.query(`insert into export_requests(tenant_id, club_id, user_id, report, title, params, params_hash, rows) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ctx.tenantId, clubId, ctx.userId, e.report, e.title, JSON.stringify(params), hash, e.rows]);
          const hour = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
          await raiseAlert(pool, db, ctx, 'export', clubId, e.rows, s.exportRowsLimit, hour);
          await audit(db, ctx, 'report.export_requested', 'report', null, null, { report: e.report, rows: e.rows, limit: s.exportRowsLimit, ...params });
        }
        return { blocked: true as const, rows: e.rows, limit: s.exportRowsLimit, again: !!pending };
      }
      approvedId = ok.id;
    }
    await audit(db, ctx, 'report.exported', 'report', e.report, null, { ...params, format: e.format, rows: e.rows, approvalId: approvedId });
    return { blocked: false as const, sign };
  });
  if (res.blocked) {
    throw new HttpError(403, `В выгрузке ${res.rows} строк с данными клиентов, без согласования можно до ${res.limit}. `
      + (res.again ? 'Запрос уже ждёт решения управляющего.' : 'Запрос отправлен управляющему.')
      + ' После одобрения скачайте отчёт с теми же условиями ещё раз в течение суток. Или сузьте период, тогда строк станет меньше', 'export_needs_approval');
  }
  return res.sign;
}

/* ---------- маршруты раздела «Защита данных» ---------- */
export function privacyRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/privacy/settings', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    return withCtx(pool, ctx, async (db) => {
      const clubs = (await db.query(`select id, name from clubs where status <> 'closed' order by name`)).rows;
      const out = [];
      for (const c of clubs) out.push({ clubId: c.id, clubName: c.name, ...(await protectionSettings(db, c.id)) });
      return { clubs: out, defaults: PROTECTION_DEFAULTS };
    });
  });

  app.put('/api/privacy/settings/:clubId', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { clubId } = req.params as { clubId: string };
    const b = (req.body ?? {}) as Partial<Protection>;
    const num = (v: unknown, min: number, max: number, name: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name}: целое число от ${min} до ${max}`);
      return n;
    };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw notFound('Клуб не найден');
      const before = await protectionSettings(db, clubId);
      const v = {
        exportRowsLimit: num(b.exportRowsLimit ?? before.exportRowsLimit, 0, 100000, 'Строк в выгрузке без согласования'),
        revealsPerHour: num(b.revealsPerHour ?? before.revealsPerHour, 1, 1000, 'Полных номеров в час'),
        cardViewsAlert: num(b.cardViewsAlert ?? before.cardViewsAlert, 10, 10000, 'Карточек в час'),
        searchesAlert: num(b.searchesAlert ?? before.searchesAlert, 10, 10000, 'Поисков в час'),
      };
      await db.query(`insert into data_protection_settings(tenant_id, club_id, export_rows_limit, reveals_per_hour, card_views_alert, searches_alert, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict (club_id) do update set export_rows_limit = excluded.export_rows_limit, reveals_per_hour = excluded.reveals_per_hour,
        card_views_alert = excluded.card_views_alert, searches_alert = excluded.searches_alert, updated_by = excluded.updated_by, updated_at = now()`,
      [ctx.tenantId, clubId, v.exportRowsLimit, v.revealsPerHour, v.cardViewsAlert, v.searchesAlert, ctx.userId]);
      await audit(db, ctx, 'privacy.settings_changed', 'club', clubId, before, v);
      return v;
    });
  });

  // Запросы на выгрузку: свои видит каждый, все запросы клуба — руководитель
  app.get('/api/privacy/export-requests', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const all = can(ctx, P.dataProtect);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select r.id, r.report, r.title, r.rows, r.status, r.created_at as "createdAt", r.decided_at as "decidedAt", r.used_at as "usedAt", r.decision_comment as "comment",
         u.full_name as "userName", d.full_name as "deciderName", c.name as "clubName", r.params
       from export_requests r join users u on u.id = r.user_id left join users d on d.id = r.decided_by left join clubs c on c.id = r.club_id
       where ($1 or r.user_id = $2) order by (r.status = 'pending') desc, r.created_at desc limit 200`, [all, ctx.userId])).rows);
  });

  app.post('/api/privacy/export-requests/:id/decide', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { approve?: boolean; comment?: string };
    if (typeof b.approve !== 'boolean') throw badRequest('Укажите решение');
    if (!b.approve && !b.comment?.trim()) throw badRequest('Напишите причину отказа');
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query(`select * from export_requests where id = $1 for update`, [id])).rows[0];
      if (!r) throw notFound('Запрос не найден');
      if (r.status !== 'pending') throw badRequest('По запросу уже принято решение');
      if (r.user_id === ctx.userId) throw forbidden('Свой запрос согласует другой руководитель');
      await db.query(`update export_requests set status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 where id = $1`,
        [id, b.approve ? 'approved' : 'rejected', ctx.userId, b.comment?.trim() || null]);
      await audit(db, ctx, b.approve ? 'report.export_approved' : 'report.export_rejected', 'export_request', id, null, { comment: b.comment ?? null, rows: r.rows, report: r.report });
      const club = r.club_id ?? (await db.query(`select id from clubs order by name limit 1`)).rows[0]?.id;
      if (club) await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at) values ($1,$2,$3,'other',$4, now() + interval '1 hour')`,
        [ctx.tenantId, club, r.user_id, b.approve ? `Выгрузка «${r.title}» одобрена: скачайте её в течение суток` : `Выгрузка «${r.title}» не одобрена: ${b.comment!.trim()}`]);
      return { ok: true };
    });
  });

  app.get('/api/privacy/alerts', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { all } = req.query as { all?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select a.id, a.kind, a.count, a.threshold, a.hour, a.created_at as "createdAt", a.reviewed_at as "reviewedAt", a.note,
         u.full_name as "userName", u.login, r.full_name as "reviewerName", c.name as "clubName"
       from pd_alerts a join users u on u.id = a.user_id left join users r on r.id = a.reviewed_by left join clubs c on c.id = a.club_id
       where ($1 or a.reviewed_at is null) order by a.created_at desc limit 200`, [all === '1'])).rows);
  });

  app.post('/api/privacy/alerts/:id/review', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as { note?: string };
    if (!note?.trim()) throw badRequest('Напишите, что выяснили: например, «обзванивал список продлений по заданию»');
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query(`update pd_alerts set reviewed_by = $2, reviewed_at = now(), note = $3 where id = $1 and reviewed_at is null returning id`, [id, ctx.userId, note.trim()])).rows[0];
      if (!r) throw notFound('Сигнал не найден или уже разобран');
      await audit(db, ctx, 'pd.alert_reviewed', 'pd_alert', id, null, { note: note.trim() });
      return { ok: true };
    });
  });

  // Кто сколько смотрел и выгружал: за последние 7 дней по сотрудникам
  app.get('/api/privacy/activity', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    return withCtx(pool, ctx, async (db) => {
      const access = (await db.query(
        `select u.full_name as "userName", u.login,
           coalesce(sum(n) filter (where kind = 'reveal'), 0)::int as reveals, coalesce(sum(n) filter (where kind = 'card'), 0)::int as cards,
           coalesce(sum(n) filter (where kind = 'search'), 0)::int as searches, max(n) filter (where kind = 'card')::int as "maxCardsHour"
         from pd_access_counters k join users u on u.id = k.user_id
         where k.hour > now() - interval '7 days' and (k.club_id is null or app_club_visible(k.club_id))
         group by u.id order by cards desc limit 100`)).rows;
      const exports = (await db.query(
        `select a.at, u.full_name as "userName", a.object_id as report, a.after
         from audit_log a left join users u on u.id = a.actor_id
         where a.tenant_id = app_tenant() and a.action = 'report.exported' and a.at > now() - interval '30 days' order by a.at desc limit 100`)).rows
        .map((r) => ({ at: r.at, userName: r.userName, report: r.report, rows: r.after?.rows ?? null, format: r.after?.format ?? null, approved: !!r.after?.approvalId }));
      return { access, exports };
    });
  });
}
