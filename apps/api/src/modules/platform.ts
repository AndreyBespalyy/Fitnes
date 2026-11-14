// Кабинет оператора платформы (список «20 улучшений», п. 19). Раньше всё делалось командой npm run platform на сервере,
// теперь в браузере по адресу /platform: сети-клиенты и их клубы, договор и лимиты тарифа, подключение новой сети,
// счета за подписку, приостановка доступа при долге, обращения в поддержку со всех сетей.
// Оператор — не сотрудник сети: отдельные учётные записи (создаются командой npm run platform -- operator add) и отдельная cookie.
// Кабинет работает подключением владельца базы, как и команда; приложению сетей таблицы оператора недоступны.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createPool, withCtx } from '../db.ts';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../errors.ts';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../passwords.ts';
import { ensureLeadSources } from '../presets.ts';
import { requireCtx } from '../auth.ts';

export const PCOOKIE = 'psid';
const SESSION_HOURS = 12;
const MAX_FAILS = 10; const WINDOW_MIN = 15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const LOGIN = /^[a-z][a-z0-9._-]{2,40}$/;
type Op = { id: string; login: string; fullName: string; mustChange: boolean };

/** Временный пароль: читаемый, без похожих символов */
export function tempPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => a[randomInt(a.length)]).join('');
}

/** Демо-ограничения сети при подключении: такие же, как в пилоте */
const DEFAULT_LIMITS: [string, string, number | null, number | null][] = [
  ['manager', 'discount', null, 5], ['rop', 'discount', null, 10],
  ['gm', 'refund', 1_500_000, null], ['gm', 'discount', null, 15], ['gm', 'expense', 5_000_000, null],
];

export function platformRoutes(app: FastifyInstance, appPool: pg.Pool, opts: { ownerUrl?: string; secureCookie: boolean }) {
  const pool = opts.ownerUrl ? createPool(opts.ownerUrl) : null; // соединения открываются только при первом обращении к кабинету
  if (pool) app.addHook('onClose', async () => { await pool.end(); });
  const db = () => { if (!pool) throw new HttpError(503, 'Кабинет оператора не настроен на этом сервере', 'platform_off'); return pool; };
  const fails = new Map<string, { n: number; first: number }>();

  async function op(req: FastifyRequest, allowMustChange = false): Promise<Op> {
    const token = req.cookies?.[PCOOKIE];
    if (!token) throw unauthorized();
    const r = (await db().query(`select o.id, o.login, o.full_name as "fullName", o.must_change_password as "mustChange"
      from platform_sessions s join platform_operators o on o.id = s.operator_id
      where s.token_hash = $1 and s.expires_at > now() and o.status = 'active'`, [sha256(token)])).rows[0] as Op | undefined;
    if (!r) throw unauthorized();
    if (r.mustChange && !allowMustChange) throw new HttpError(403, 'Сначала смените временный пароль', 'must_change_password');
    return r;
  }
  const log = (o: Op, tenantId: string, action: string, objectType: string, objectId: string | null, after: Record<string, unknown>) =>
    db().query(`insert into audit_log(tenant_id, actor_id, action, object_type, object_id, after, ip) values ($1, null, $2, $3, $4, $5, null)`,
      [tenantId, `platform.${action}`, objectType, objectId, JSON.stringify({ ...after, operator: o.login })]);

  /* ---------- вход ---------- */
  app.post('/api/platform/login', async (req, reply) => {
    const b = (req.body ?? {}) as { login?: string; password?: string };
    const ip = req.ip;
    const f = fails.get(ip);
    if (f && Date.now() - f.first < WINDOW_MIN * 60_000 && f.n >= MAX_FAILS) throw new HttpError(429, `Слишком много неудачных попыток. Попробуйте через ${WINDOW_MIN} мин.`, 'ip_limited');
    const u = (await db().query('select * from platform_operators where login = $1', [(b.login ?? '').trim().toLowerCase()])).rows[0];
    if (!u || u.status !== 'active' || !(await verifyPassword(u.password_hash, b.password ?? ''))) {
      const cur = f && Date.now() - f.first < WINDOW_MIN * 60_000 ? f : { n: 0, first: Date.now() };
      fails.set(ip, { n: cur.n + 1, first: cur.first });
      throw new HttpError(401, 'Неверный логин или пароль', 'invalid_credentials');
    }
    fails.delete(ip);
    const token = randomBytes(32).toString('base64url');
    await db().query(`insert into platform_sessions(operator_id, token_hash, ip, expires_at) values ($1,$2,$3, now() + make_interval(hours => $4))`, [u.id, sha256(token), ip, SESSION_HOURS]);
    await db().query('update platform_operators set last_login_at = now() where id = $1', [u.id]);
    reply.setCookie(PCOOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: opts.secureCookie, maxAge: SESSION_HOURS * 3600 });
    return { login: u.login, fullName: u.full_name, mustChange: u.must_change_password };
  });
  app.post('/api/platform/logout', async (req, reply) => {
    const token = req.cookies?.[PCOOKIE];
    if (token && pool) await pool.query('delete from platform_sessions where token_hash = $1', [sha256(token)]);
    reply.clearCookie(PCOOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/platform/me', async (req) => op(req, true));
  app.post('/api/platform/password', async (req) => {
    const o = await op(req, true);
    const b = (req.body ?? {}) as { current?: string; newPassword?: string };
    const u = (await db().query('select password_hash from platform_operators where id = $1', [o.id])).rows[0];
    if (!(await verifyPassword(u.password_hash, b.current ?? ''))) throw badRequest('Текущий пароль неверный');
    const err = checkPasswordPolicy(b.newPassword ?? '', o.login);
    if (err) throw badRequest(err);
    await db().query('update platform_operators set password_hash = $2, must_change_password = false where id = $1', [o.id, await hashPassword(b.newPassword!)]);
    return { ok: true };
  });

  /* ---------- сети ---------- */
  const TENANT_LIST = `select t.id, t.name, t.status, t.status_reason as "statusReason", t.created_at as "createdAt",
      c.number as "contractNumber", c.plan, c.clubs_limit as "clubsLimit", c.users_limit as "usersLimit", c.fee_kop::float as "feeKop",
      to_char(c.valid_to, 'YYYY-MM-DD') as "validTo", to_char(c.signed_on, 'YYYY-MM-DD') as "signedOn", c.note,
      (select count(*)::int from clubs x where x.tenant_id = t.id and x.status = 'active' and not x.is_demo) as clubs,
      (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active' and not u.is_bot) as users,
      (select count(*)::int from persons p where p.tenant_id = t.id and p.merged_into_id is null) as persons,
      (select max(s.last_seen_at) from sessions s where s.tenant_id = t.id) as "lastActivity",
      (select count(*)::int from support_tickets k where k.tenant_id = t.id and k.status = 'open') as "openTickets",
      (select coalesce(sum(i.amount_kop), 0)::float from platform_invoices i where i.tenant_id = t.id and i.status = 'issued') as "unpaidKop",
      (select coalesce(sum(i.amount_kop), 0)::float from platform_invoices i where i.tenant_id = t.id and i.status = 'issued' and i.due_on < current_date) as "overdueKop"
    from tenants t left join tenant_contracts c on c.tenant_id = t.id`;
  app.get('/api/platform/tenants', async (req) => {
    await op(req);
    return (await db().query(`${TENANT_LIST} order by t.created_at`)).rows;
  });

  app.get('/api/platform/tenants/:id', async (req) => {
    await op(req);
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw notFound('Сеть не найдена');
    const t = (await db().query(`${TENANT_LIST} where t.id = $1`, [id])).rows[0];
    if (!t) throw notFound('Сеть не найдена');
    // Состояние клубов: работают ли, есть ли сбои подключений
    const clubs = (await db().query(`select c.id, c.name, c.sales_model as "salesModel", c.status, c.is_demo as "isDemo",
        (select count(*)::int from memberships m where m.club_id = c.id and m.status = 'active' and (m.ends_on is null or m.ends_on >= current_date)) as "activeMemberships",
        (select count(*)::int from visits v where v.club_id = c.id and v.visited_at > now() - interval '7 days') as "visits7d",
        (select max(v.visited_at) from visits v where v.club_id = c.id) as "lastVisit",
        (select coalesce(sum(case when p.direction = 'in' then p.amount_kop else -p.amount_kop end), 0)::float from payments p
          where p.club_id = c.id and p.kind in ('charge', 'refund') and p.created_at > now() - interval '30 days') as "revenue30dKop",
        (select count(*)::int from msg_channels ch where ch.club_id = c.id and ch.status = 'active' and ch.last_error is not null) as "channelErrors",
        (select count(*)::int from access_gateways g where g.club_id = c.id and g.status = 'active' and (g.last_seen_at is null or g.last_seen_at < now() - interval '10 minutes')) as "gatewaysOffline"
      from clubs c where c.tenant_id = $1 order by c.is_demo, c.name`, [id])).rows;
    const invoices = (await db().query(`select id, number, to_char(period_from, 'YYYY-MM-DD') as "periodFrom", to_char(period_to, 'YYYY-MM-DD') as "periodTo",
        amount_kop::float as "amountKop", status, to_char(due_on, 'YYYY-MM-DD') as "dueOn", issued_at as "issuedAt", paid_at as "paidAt", paid_note as "paidNote", cancelled_reason as "cancelledReason"
      from platform_invoices where tenant_id = $1 order by period_from desc, issued_at desc limit 36`, [id])).rows;
    const owners = (await db().query(`select u.login, u.full_name as "fullName", u.status, (select max(s.last_seen_at) from sessions s where s.user_id = u.id) as "lastSeen"
      from users u join user_assignments a on a.user_id = u.id where u.tenant_id = $1 and a.role_code in ('owner', 'admin') group by u.id order by u.created_at`, [id])).rows;
    return { ...t, clubsList: clubs, invoices, owners };
  });

  // Подключение новой сети: сеть, собственник с временным паролем, источники заявок и лимиты согласования по умолчанию.
  // Клубы собственник добавляет сам в разделе «Клубы» (там же выбирается модель продаж).
  app.post('/api/platform/tenants', async (req, reply) => {
    const o = await op(req);
    const b = (req.body ?? {}) as { name?: string; ownerLogin?: string; ownerName?: string; ownerPhone?: string };
    const name = (b.name ?? '').trim();
    const login = (b.ownerLogin ?? '').trim().toLowerCase();
    const ownerName = (b.ownerName ?? '').trim();
    if (name.length < 2) throw badRequest('Укажите название сети');
    if (!LOGIN.test(login)) throw badRequest('Логин собственника: латиница, цифры, точка, от 3 символов');
    if (ownerName.length < 2) throw badRequest('Укажите ФИО собственника');
    const c = await db().connect();
    try {
      await c.query('begin');
      if ((await c.query('select 1 from tenants where lower(name) = lower($1)', [name])).rowCount) throw badRequest('Сеть с таким названием уже есть');
      if ((await c.query('select 1 from users where login = $1', [login])).rowCount) throw badRequest('Такой логин уже занят');
      const tenantId = (await c.query('insert into tenants(name) values ($1) returning id', [name])).rows[0].id as string;
      const pw = tempPassword();
      const userId = (await c.query(`insert into users(tenant_id, login, password_hash, full_name, phone, must_change_password) values ($1,$2,$3,$4,$5,true) returning id`,
        [tenantId, login, await hashPassword(pw), ownerName, b.ownerPhone?.trim() || null])).rows[0].id as string;
      await c.query(`insert into user_assignments(tenant_id, user_id, role_code, club_id) values ($1,$2,'owner',null)`, [tenantId, userId]);
      await ensureLeadSources(c, tenantId);
      for (const [role, kind, kop, pct] of DEFAULT_LIMITS) {
        await c.query('insert into approval_limits(tenant_id, role_code, kind, max_amount_kop, max_percent) values ($1,$2,$3,$4,$5)', [tenantId, role, kind, kop, pct]);
      }
      await c.query(`insert into audit_log(tenant_id, actor_id, action, object_type, object_id, after) values ($1, null, 'platform.tenant_created', 'tenant', $2, $3)`,
        [tenantId, tenantId, JSON.stringify({ name, ownerLogin: login, operator: o.login })]);
      await c.query('commit');
      reply.code(201);
      // Временный пароль показывается один раз: оператор передаёт его собственнику, при входе система попросит сменить
      return { id: tenantId, ownerLogin: login, tempPassword: pw };
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  });

  app.put('/api/platform/tenants/:id/contract', async (req) => {
    const o = await op(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { number?: string; signedOn?: string; plan?: string; clubsLimit?: number | null; usersLimit?: number | null; validTo?: string | null; feeKop?: number | null; note?: string | null };
    if (!UUID.test(id) || !(await db().query('select 1 from tenants where id = $1', [id])).rowCount) throw notFound('Сеть не найдена');
    if (!b.number?.trim() || !b.plan?.trim()) throw badRequest('Укажите номер договора и тариф');
    if (!DATE.test(b.signedOn ?? '')) throw badRequest('Укажите дату договора');
    if (b.validTo && !DATE.test(b.validTo)) throw badRequest('Неверная дата окончания');
    const posInt = (v: number | null | undefined, what: string) => { if (v == null) return null; if (!Number.isInteger(v) || v < 1) throw badRequest(`${what}: целое число от 1 или пусто`); return v; };
    const clubs = posInt(b.clubsLimit, 'Лимит клубов'); const users = posInt(b.usersLimit, 'Лимит сотрудников');
    if (b.feeKop != null && (!Number.isInteger(b.feeKop) || b.feeKop < 0)) throw badRequest('Плата в месяц указана неверно');
    const before = (await db().query('select * from tenant_contracts where tenant_id = $1', [id])).rows[0] ?? null;
    await db().query(`insert into tenant_contracts(tenant_id, number, signed_on, plan, clubs_limit, users_limit, valid_to, fee_kop, note)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id) do update set number = excluded.number, signed_on = excluded.signed_on, plan = excluded.plan,
      clubs_limit = excluded.clubs_limit, users_limit = excluded.users_limit, valid_to = excluded.valid_to, fee_kop = excluded.fee_kop, note = excluded.note, updated_at = now()`,
    [id, b.number.trim(), b.signedOn, b.plan.trim(), clubs, users, b.validTo || null, b.feeKop ?? null, b.note?.trim() || null]);
    await log(o, id, 'contract_set', 'tenant', id, { before: before && { plan: before.plan, clubs: before.clubs_limit, users: before.users_limit, feeKop: before.fee_kop }, plan: b.plan, clubs, users, feeKop: b.feeKop ?? null });
    return { ok: true };
  });

  app.post('/api/platform/tenants/:id/status', async (req) => {
    const o = await op(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: string; reason?: string };
    if (!['active', 'suspended'].includes(b.status ?? '')) throw badRequest('Неверное состояние');
    if (b.status === 'suspended' && !b.reason?.trim()) throw badRequest('Укажите причину приостановки: её увидит поддержка');
    const r = await db().query('update tenants set status = $2, status_reason = $3, updated_at = now() where id = $1 returning id', [id, b.status, b.status === 'suspended' ? b.reason!.trim() : null]);
    if (!r.rowCount) throw notFound('Сеть не найдена');
    if (b.status === 'suspended') await db().query('update sessions set revoked_at = now() where tenant_id = $1 and revoked_at is null', [id]);
    await log(o, id, b.status === 'suspended' ? 'tenant_suspended' : 'tenant_resumed', 'tenant', id, { reason: b.reason ?? null });
    return { ok: true };
  });

  /* ---------- счета ---------- */
  async function issue(o: Op, tenantId: string, periodFrom: string, amountKop: number, dueDays: number) {
    const from = new Date(`${periodFrom}T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const year = periodFrom.slice(0, 4);
    const n = Number((await db().query(`select count(*) as n from platform_invoices where number like $1`, [`СЧ-${year}-%`])).rows[0].n) + 1;
    const number = `СЧ-${year}-${String(n).padStart(4, '0')}`;
    try {
      const id = (await db().query(`insert into platform_invoices(tenant_id, number, period_from, period_to, amount_kop, due_on, issued_by)
        values ($1,$2,$3,$4,$5, current_date + $6::int, $7) returning id`, [tenantId, number, periodFrom, to, amountKop, dueDays, o.id])).rows[0].id as string;
      await log(o, tenantId, 'invoice_issued', 'platform_invoice', id, { number, periodFrom, amountKop });
      return { id, number };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return null; // за этот месяц счёт уже есть
      throw e;
    }
  }
  const monthStart = (s?: string) => (s && /^\d{4}-\d{2}/.test(s) ? `${s.slice(0, 7)}-01` : `${new Date().toISOString().slice(0, 7)}-01`);

  app.post('/api/platform/tenants/:id/invoices', async (req, reply) => {
    const o = await op(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { month?: string; amountKop?: number; dueDays?: number };
    const c = (await db().query('select fee_kop from tenant_contracts where tenant_id = $1', [id])).rows[0];
    const amount = b.amountKop ?? (c?.fee_kop ? Number(c.fee_kop) : 0);
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Укажите сумму счёта или плату в месяц в договоре');
    const r = await issue(o, id, monthStart(b.month), amount, b.dueDays ?? 10);
    if (!r) throw badRequest('За этот месяц счёт уже выставлен');
    reply.code(201);
    return r;
  });

  // Ежемесячное выставление всем сетям с платой по договору (действующие договоры, сеть не приостановлена)
  app.post('/api/platform/invoices/monthly', async (req) => {
    const o = await op(req);
    const month = monthStart((req.body as { month?: string } | undefined)?.month);
    const rows = (await db().query(`select c.tenant_id, c.fee_kop from tenant_contracts c join tenants t on t.id = c.tenant_id
      where c.fee_kop > 0 and t.status = 'active' and (c.valid_to is null or c.valid_to >= $1::date) and c.signed_on <= ($1::date + interval '1 month' - interval '1 day')`, [month])).rows;
    let issued = 0;
    for (const r of rows) if (await issue(o, r.tenant_id, month, Number(r.fee_kop), 10)) issued++;
    return { issued, skipped: rows.length - issued };
  });

  const invoiceOf = async (id: string) => {
    if (!UUID.test(id)) throw notFound('Счёт не найден');
    const i = (await db().query('select * from platform_invoices where id = $1', [id])).rows[0];
    if (!i) throw notFound('Счёт не найден');
    if (i.status !== 'issued') throw badRequest(i.status === 'paid' ? 'Счёт уже оплачен' : 'Счёт аннулирован');
    return i;
  };
  app.post('/api/platform/invoices/:id/paid', async (req) => {
    const o = await op(req);
    const i = await invoiceOf((req.params as { id: string }).id);
    const note = ((req.body ?? {}) as { note?: string }).note?.trim();
    if (!note) throw badRequest('Укажите, как пришла оплата: номер платёжки или дату выписки');
    await db().query(`update platform_invoices set status = 'paid', paid_at = now(), paid_note = $2 where id = $1`, [i.id, note]);
    await log(o, i.tenant_id, 'invoice_paid', 'platform_invoice', i.id, { number: i.number, note });
    return { ok: true };
  });
  app.post('/api/platform/invoices/:id/cancel', async (req) => {
    const o = await op(req);
    const i = await invoiceOf((req.params as { id: string }).id);
    const reason = ((req.body ?? {}) as { reason?: string }).reason?.trim();
    if (!reason) throw badRequest('Укажите причину аннулирования');
    await db().query(`update platform_invoices set status = 'cancelled', cancelled_reason = $2 where id = $1`, [i.id, reason]);
    await log(o, i.tenant_id, 'invoice_cancelled', 'platform_invoice', i.id, { number: i.number, reason });
    return { ok: true };
  });

  /* ---------- поддержка ---------- */
  app.get('/api/platform/support', async (req) => {
    await op(req);
    const all = (req.query as { all?: string }).all === '1';
    return (await db().query(`select k.id, k.number, k.subject, k.kind, k.status, k.page, k.created_at as "createdAt", k.updated_at as "updatedAt",
        k.escalated_at as "escalatedAt", t.name as "tenantName", t.id as "tenantId", c.name as "clubName", u.full_name as author
      from support_tickets k join tenants t on t.id = k.tenant_id join users u on u.id = k.author_id left join clubs c on c.id = k.club_id
      where k.status <> 'closed' and ($1 or k.escalated_at is not null) order by k.status = 'open' desc, k.updated_at desc limit 300`, [all])).rows;
  });
  app.get('/api/platform/support/:id', async (req) => {
    await op(req);
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw notFound('Обращение не найдено');
    const k = (await db().query(`select k.id, k.number, k.subject, k.kind, k.status, k.page, k.client_info as "clientInfo", k.app_version as "appVersion", k.tech_log as "techLog",
        t.name as "tenantName", c.name as "clubName", u.full_name as author, u.login as "authorLogin"
      from support_tickets k join tenants t on t.id = k.tenant_id join users u on u.id = k.author_id left join clubs c on c.id = k.club_id where k.id = $1`, [id])).rows[0];
    if (!k) throw notFound('Обращение не найдено');
    const messages = (await db().query(`select m.body, m.from_support as "fromSupport", m.created_at as "createdAt", u.full_name as author
      from support_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.created_at`, [id])).rows;
    return { ...k, messages };
  });
  app.post('/api/platform/support/:id/answer', async (req) => {
    const o = await op(req);
    const { id } = req.params as { id: string };
    const text = ((req.body ?? {}) as { text?: string }).text?.trim();
    if (!text) throw badRequest('Напишите ответ');
    if (!UUID.test(id)) throw notFound('Обращение не найдено');
    const k = (await db().query('select id, tenant_id, number from support_tickets where id = $1', [id])).rows[0];
    if (!k) throw notFound('Обращение не найдено');
    await db().query(`insert into support_messages(tenant_id, ticket_id, author_id, from_support, body) values ($1,$2,null,true,$3)`, [k.tenant_id, id, text]);
    await db().query(`update support_tickets set status = 'answered', updated_at = now() where id = $1`, [id]);
    await log(o, k.tenant_id, 'support_answered', 'support_ticket', id, { number: k.number });
    return { ok: true };
  });

  /* ---------- сеть видит свои счета ---------- */
  app.get('/api/platform-invoices', async (req) => {
    const ctx = requireCtx(req);
    if (!ctx.roles.some((r) => r === 'owner' || r === 'admin' || r === 'fin')) throw forbidden();
    return withCtx(appPool, ctx, async (d) => (await d.query(`select number, to_char(period_from, 'YYYY-MM-DD') as "periodFrom", to_char(period_to, 'YYYY-MM-DD') as "periodTo",
        amount_kop::float as "amountKop", status, to_char(due_on, 'YYYY-MM-DD') as "dueOn", paid_at as "paidAt"
      from platform_invoices where status <> 'cancelled' order by period_from desc limit 24`)).rows);
  });
}
