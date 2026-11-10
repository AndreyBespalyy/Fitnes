// Шаг 11. Проходы и посещения. Модель турникета пока не выбрана (решение Андрея: уточним на финише),
// поэтому система общается не с турникетом, а со «шлюзом» клуба: шлюз спрашивает решение, хранит правила
// на случай пропажи интернета и выгружает накопленные проходы без дублей. Драйвер конкретного контроллера
// подключается к шлюзу на финишном этапе.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { personMemberships } from './memberships.ts';
import { inWindow, localParts, REASON_TITLES, windowText, type Direction, type RuleEntry, type Snapshot, type Window } from './acsRules.ts';

type Actor = { tenantId: string; userId: string | null; ip?: string };
type Decision = { decision: 'allow' | 'deny'; reasonCode: string; reason: string; name: string | null; personId: string | null; userId: string | null;
  credentialId: string | null; membershipId: string | null; warn?: string | null };

const CRED_KINDS: Record<string, string> = { card: 'Карта', bracelet: 'Браслет', qr: 'QR-код' };
export const MANUAL_REASONS: Record<string, string> = {
  turnstile_fault: 'Турникет не работает', card_not_read: 'Карта не считывается', forgot_card: 'Забыл карту',
  guest: 'Гость по приглашению', admin_decision: 'Решение администратора', other: 'Другое',
};
const tokenHash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const sha = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);

/* ---------- настройки клуба ---------- */
export async function accessSettings(db: Db, clubId: string) {
  const r = (await db.query(`select c.name, c.timezone, to_char(s.open_from, 'HH24:MI') as "openFrom", to_char(s.open_to, 'HH24:MI') as "openTo",
      s.repeat_entry_minutes as "repeatEntryMinutes", s.offline_hours as "offlineHours"
    from clubs c left join club_access_settings s on s.club_id = c.id where c.id = $1`, [clubId])).rows[0];
  if (!r) throw notFound('Клуб не найден');
  return { clubName: r.name as string, timezone: r.timezone as string, openFrom: r.openFrom ?? '07:00', openTo: r.openTo ?? '23:00',
    repeatEntryMinutes: r.repeatEntryMinutes ?? 30, offlineHours: r.offlineHours ?? 24 };
}

/* ---------- кто приложил карту и можно ли ему ---------- */
async function credentialByCode(db: Db, code: string) {
  return (await db.query(`select c.*, coalesce(p.full_name, u.full_name) as holder_name, u.status as user_status
    from access_credentials c left join persons p on p.id = c.person_id left join users u on u.id = c.user_id
    where c.code = $1 order by (c.status = 'active') desc, c.issued_at desc limit 1`, [code.trim()])).rows[0];
}

const STATE_CODE: Record<string, string> = { debt_blocked: 'debt', frozen: 'frozen', unsigned: 'unsigned', used_up: 'used_up', not_started: 'not_started', expired: 'expired', cancelled: 'cancelled' };
const STATE_ORDER = ['debt_blocked', 'frozen', 'unsigned', 'used_up', 'not_started', 'expired', 'cancelled'];
type M = Awaited<ReturnType<typeof personMemberships>>[number];
type Holder = { allow: boolean; reasonCode: string; reason: string; windows: Window[] | null; validUntil: string | null; membershipId: string | null; warn?: string | null; ms?: M[] };

/** Статус держателя карты на дату клуба (без учёта часов) — основа и онлайн-решения, и снимка правил для шлюза. */
async function holderStatus(db: Db, clubId: string, cred: { person_id: string | null; user_id: string | null; holder_name: string; user_status?: string }): Promise<Holder> {
  if (cred.user_id) {
    if (cred.user_status !== 'active') return { allow: false, reasonCode: 'staff_inactive', reason: 'Сотрудник отключён в системе', windows: null, validUntil: null, membershipId: null };
    const ok = (await db.query(`select 1 from user_assignments a join roles r on r.code = a.role_code
      where a.user_id = $1 and (a.club_id = $2 or a.club_id is null)`, [cred.user_id, clubId])).rowCount;
    return ok ? { allow: true, reasonCode: 'staff', reason: 'Сотрудник', windows: null, validUntil: null, membershipId: null }
      : { allow: false, reasonCode: 'staff_other_club', reason: 'Сотрудник другого клуба', windows: null, validUntil: null, membershipId: null };
  }
  const all = (await personMemberships(db, cred.person_id!)).filter((m) => m.kind !== 'personal');
  const here = all.filter((m) => m.clubId === clubId || m.networkAccess);
  const ok = here.filter((m) => m.access).sort((a, b) => (a.clubId === clubId ? -1 : 1) - (b.clubId === clubId ? -1 : 1));
  if (ok.length) {
    const any = ok.some((m) => !m.accessFrom && !m.accessTo);
    const windows: Window[] | null = any ? null : ok.map((m) => ({ from: m.accessFrom, to: m.accessTo }));
    const until = ok.some((m) => !m.endsOn) ? null : ok.map((m) => m.endsOn!).sort().pop()!;
    const m = ok[0];
    const warn = ok.find((x) => x.state === 'debt_grace')?.reason ?? null;
    return { allow: true, reasonCode: 'ok', reason: `${m.productName}: ${m.reason.charAt(0).toLowerCase()}${m.reason.slice(1)}`, windows, validUntil: until, membershipId: m.id, warn, ms: ok };
  }
  if (here.length) {
    const m = [...here].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))[0];
    return { allow: false, reasonCode: STATE_CODE[m.state] ?? 'no_membership', reason: `${m.productName}: ${m.reason.charAt(0).toLowerCase()}${m.reason.slice(1)}`, windows: null, validUntil: null, membershipId: m.id };
  }
  const other = all.find((m) => m.access);
  if (other) return { allow: false, reasonCode: 'other_club', reason: `Абонемент клуба ${other.clubName}: в этот клуб проход не входит`, windows: null, validUntil: null, membershipId: other.id };
  return { allow: false, reasonCode: 'no_membership', reason: 'Нет действующего абонемента', windows: null, validUntil: null, membershipId: null };
}

/** Решение о проходе прямо сейчас (или на время at). */
export async function decide(db: Db, clubId: string, code: string, direction: Direction, at: Date): Promise<Decision> {
  const blank = { name: null, personId: null, userId: null, credentialId: null, membershipId: null };
  if (!code?.trim()) return { decision: 'deny', reasonCode: 'unknown_card', reason: 'Карта не зарегистрирована', ...blank };
  const c = await credentialByCode(db, code);
  if (!c) return { decision: 'deny', reasonCode: 'unknown_card', reason: 'Карта не зарегистрирована', ...blank };
  const who = { name: c.holder_name, personId: c.person_id, userId: c.user_id, credentialId: c.id, membershipId: null };
  if (c.status !== 'active') {
    const code2 = c.status === 'replaced' ? 'card_replaced' : c.status === 'lost' ? 'card_lost' : 'card_blocked';
    return { decision: 'deny', reasonCode: code2, reason: `${REASON_TITLES[code2]}${c.status === 'replaced' ? ': выдана новая, старую заберите' : ''}`, ...who };
  }
  if (direction === 'out') return { decision: 'allow', reasonCode: 'exit', reason: 'Выход', ...who };
  const h = await holderStatus(db, clubId, c);
  if (!h.allow) return { decision: 'deny', reasonCode: h.reasonCode, reason: h.reason, ...who, membershipId: h.membershipId };
  if (c.user_id) return { decision: 'allow', reasonCode: 'staff', reason: 'Сотрудник', ...who };
  const s = await accessSettings(db, clubId);
  const now = localParts(at, s.timezone).hm;
  if (!inWindow(now, s.openFrom, s.openTo)) return { decision: 'deny', reasonCode: 'club_closed', reason: `Клуб закрыт: работаем ${windowText({ from: s.openFrom, to: s.openTo })}`, ...who };
  const fit = (h.ms ?? []).find((m) => inWindow(now, m.accessFrom, m.accessTo));
  if (!fit) {
    return { decision: 'deny', reasonCode: 'wrong_time', reason: `Не то время: ${h.ms![0].productName} действует ${windowText({ from: h.ms![0].accessFrom, to: h.ms![0].accessTo })}`, ...who, membershipId: h.membershipId };
  }
  return { decision: 'allow', reasonCode: 'ok', reason: `${fit.productName}: ${fit.reason.charAt(0).toLowerCase()}${fit.reason.slice(1)}`, warn: h.warn, ...who, membershipId: fit.id };
}

/* ---------- событие прохода и посещение ---------- */
type EventIn = { clubId: string; pointId?: string | null; gatewayId?: string | null; externalId?: string | null; at: Date; direction: Direction; code?: string | null;
  mode: 'online' | 'offline' | 'manual' | 'emulator'; manualBy?: string | null; manualReason?: string | null };

/** Пересчитывает посещение по событию. Повторное прикладывание и возврат через несколько минут не создают новое посещение. */
async function visitFor(db: Db, tenantId: string, e: EventIn, d: Decision): Promise<{ visitId: string | null; effect: string }> {
  if (d.decision !== 'allow' || !d.personId) return { visitId: null, effect: 'none' };
  const at = e.at.toISOString();
  if (e.direction === 'out') {
    const open = (await db.query(`select id from visits where person_id = $1 and club_id = $2 and exit_at is null and visited_at <= $3 and visited_at > $3::timestamptz - interval '16 hours'
      order by visited_at desc limit 1`, [d.personId, e.clubId, at])).rows[0];
    if (!open) return { visitId: null, effect: 'none' };
    await db.query('update visits set exit_at = $2 where id = $1', [open.id, at]);
    return { visitId: open.id, effect: 'exit' };
  }
  const open = (await db.query(`select id from visits where person_id = $1 and club_id = $2 and exit_at is null and visited_at <= $3 and visited_at > $3::timestamptz - interval '16 hours'
    order by visited_at desc limit 1`, [d.personId, e.clubId, at])).rows[0];
  if (open) return { visitId: open.id, effect: 'repeat' };
  const s = await accessSettings(db, e.clubId);
  const back = (await db.query(`select id from visits where person_id = $1 and club_id = $2 and exit_at is not null and exit_at <= $3 and exit_at >= $3::timestamptz - make_interval(mins => $4)
    order by exit_at desc limit 1`, [d.personId, e.clubId, at, s.repeatEntryMinutes])).rows[0];
  if (back) { await db.query('update visits set exit_at = null where id = $1', [back.id]); return { visitId: back.id, effect: 'reopen' }; }
  const v = (await db.query(`insert into visits(tenant_id, club_id, person_id, membership_id, visited_at, source, point_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [tenantId, e.clubId, d.personId, d.membershipId, at, e.mode === 'manual' ? 'manual' : 'acs', e.pointId ?? null])).rows[0].id;
  // Пакет посещений и гостевой визит: списываем одно посещение
  if (d.membershipId) await db.query(`update memberships set visits_left = visits_left - 1, updated_at = now() where id = $1 and kind in ('visits', 'guest') and visits_left > 0`, [d.membershipId]);
  return { visitId: v, effect: 'new' };
}

/** Записывает событие (если такого ещё не было) и пересчитывает посещение. */
export async function recordEvent(db: Db, tenantId: string, e: EventIn, d: Decision) {
  if (e.gatewayId && e.externalId) {
    const dup = (await db.query('select id, decision, reason from access_events where gateway_id = $1 and external_id = $2', [e.gatewayId, e.externalId])).rows[0];
    if (dup) return { id: dup.id as string, duplicate: true, effect: 'none' };
  }
  const v = await visitFor(db, tenantId, e, d);
  const id = (await db.query(`insert into access_events(tenant_id, club_id, point_id, gateway_id, external_id, happened_at, direction, code, credential_id, person_id, user_id,
      membership_id, decision, reason_code, reason, mode, manual_by, manual_reason, visit_id, visit_effect)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
  [tenantId, e.clubId, e.pointId ?? null, e.gatewayId ?? null, e.externalId ?? null, e.at.toISOString(), e.direction, e.code?.trim() || null, d.credentialId, d.personId, d.userId,
    d.membershipId, d.decision, d.reasonCode, d.reason, e.mode, e.manualBy ?? null, e.manualReason ?? null, v.visitId, v.effect])).rows[0].id;
  return { id: id as string, duplicate: false, effect: v.effect };
}

/* ---------- снимок правил для шлюза ---------- */
export async function buildSnapshot(db: Db, gatewayId: string, clubId: string): Promise<Snapshot> {
  const s = await accessSettings(db, clubId);
  const today = localParts(new Date(), s.timezone).date;
  const points = (await db.query(`select id, name, direction from access_points where club_id = $1 and is_active order by name`, [clubId])).rows;
  // Действующие карты сети и недавно погашенные (чтобы и без связи показать «карта заменена»)
  const creds = (await db.query(`select c.id, c.code, c.kind, c.status, c.person_id, c.user_id, coalesce(p.full_name, u.full_name) as holder_name, u.status as user_status
    from access_credentials c left join persons p on p.id = c.person_id left join users u on u.id = c.user_id
    where c.status = 'active' or c.revoked_at > now() - interval '180 days' order by c.status = 'active', c.issued_at`)).rows;
  const byCode = new Map<string, RuleEntry>();
  const cache = new Map<string, Holder>();
  for (const c of creds) {
    const base = { code: c.code, kind: c.kind, holder: (c.user_id ? 'staff' : 'person') as 'staff' | 'person', name: c.holder_name, personId: c.person_id, userId: c.user_id };
    if (c.status !== 'active') {
      const code = c.status === 'replaced' ? 'card_replaced' : c.status === 'lost' ? 'card_lost' : 'card_blocked';
      byCode.set(c.code, { ...base, allow: false, reasonCode: code, reason: REASON_TITLES[code], validUntil: null, windows: null });
      continue;
    }
    const key = c.person_id ?? `u:${c.user_id}`;
    if (!cache.has(key)) cache.set(key, await holderStatus(db, clubId, c));
    const h = cache.get(key)!;
    // Без связи пускаем не дольше, чем на offline_hours вперёд: дата окончания не позже сегодняшней + запас
    byCode.set(c.code, { ...base, allow: h.allow, reasonCode: h.reasonCode, reason: h.reason, validUntil: h.allow ? h.validUntil : null, windows: h.windows, warn: h.warn ?? null });
  }
  const commands = (await db.query(`select id, point_id as "pointId", kind from access_commands where gateway_id = $1 and status = 'pending' and created_at > now() - interval '2 minutes'`, [gatewayId])).rows;
  const entries = [...byCode.values()];
  return { version: sha(JSON.stringify([s, points, entries, today])), generatedAt: new Date().toISOString(), clubId, clubName: s.clubName, timezone: s.timezone,
    openFrom: s.openFrom, openTo: s.openTo, offlineHours: s.offlineHours, points, entries, commands };
}

/* ---------- маршруты ---------- */
const GW_ONLINE_SEC = 180;
function genCode() { return `QR${randomBytes(6).toString('hex').toUpperCase()}`; }

export function acsRoutes(app: FastifyInstance, pool: pg.Pool) {
  const tenantWide = (ctx: Pick<Ctx, 'tenantId'>) => ({ tenantId: ctx.tenantId, allClubs: true, clubIds: [] as string[] });
  const clubCheck = async (db: Db, clubId?: string) => {
    if (!clubId || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
    return clubId;
  };

  /* --- лента и экран ресепшн --- */
  app.get('/api/acs/feed', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const { clubId, limit } = req.query as { clubId?: string; limit?: string };
    return withCtx(pool, ctx, async (db) => {
      await clubCheck(db, clubId);
      const events = (await db.query(`select e.id, e.happened_at as "at", e.direction, e.decision, e.reason_code as "reasonCode", e.reason, e.mode, e.code, e.person_id as "personId",
          e.user_id as "userId", coalesce(p.full_name, u.full_name) as name, pt.name as point, mb.full_name as "manualBy", e.manual_reason as "manualReason", e.visit_effect as "visitEffect"
        from access_events e left join persons p on p.id = e.person_id left join users u on u.id = e.user_id left join access_points pt on pt.id = e.point_id
        left join users mb on mb.id = e.manual_by
        where e.club_id = $1 order by e.happened_at desc limit $2`, [clubId, Math.min(Number(limit) || 50, 200)])).rows;
      const inside = (await db.query(`select count(*)::int as n from visits where club_id = $1 and exit_at is null and visited_at > now() - interval '16 hours' and source <> 'import'`, [clubId])).rows[0].n;
      const today = (await db.query(`select count(*)::int as n from visits v join clubs c on c.id = v.club_id where v.club_id = $1 and (v.visited_at at time zone c.timezone)::date = (now() at time zone c.timezone)::date`, [clubId])).rows[0].n;
      const gateways = (await db.query(`select id, name, status, last_seen_at as "lastSeenAt", queued, extract(epoch from now() - last_seen_at)::int as ago from access_gateways where club_id = $1 order by name`, [clubId])).rows
        .map((g) => ({ ...g, online: g.lastSeenAt != null && g.ago < GW_ONLINE_SEC }));
      const points = (await db.query(`select id, name, direction, gateway_id as "gatewayId" from access_points where club_id = $1 and is_active order by name`, [clubId])).rows;
      // Тревоги: шлюз без связи, турникет не работает (ручные проходы с этой причиной за последний час)
      const alerts: string[] = [];
      for (const g of gateways) if (g.status === 'active' && !g.online) alerts.push(g.lastSeenAt ? `Шлюз «${g.name}» не на связи ${Math.round(g.ago / 60)} мин. Турникеты пускают по сохранённым правилам, проходы выгрузятся после восстановления связи` : `Шлюз «${g.name}» ещё ни разу не подключался`);
      const faults = (await db.query(`select count(*)::int as n from access_events where club_id = $1 and manual_reason like 'turnstile_fault%' and happened_at > now() - interval '1 hour'`, [clubId])).rows[0].n;
      if (faults) alerts.push(`Ручных проходов за последний час с причиной «Турникет не работает»: ${faults}. Управляющий увидит это в отчёте`);
      return { events, inside, today, gateways, points, alerts };
    });
  });

  app.post('/api/acs/emulate', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const b = (req.body ?? {}) as { pointId?: string; code?: string; direction?: Direction };
    if (!b.code?.trim()) throw badRequest('Введите номер карты или QR-кода');
    const pt = await withCtx(pool, ctx, async (db) => (await db.query('select id, club_id, direction from access_points where id = $1', [b.pointId])).rows[0]);
    if (!pt) throw badRequest('Выберите турникет');
    const direction: Direction = b.direction === 'out' ? 'out' : pt.direction === 'out' ? 'out' : 'in';
    return withCtx(pool, tenantWide(ctx), async (db) => {
      const at = new Date();
      const d = await decide(db, pt.club_id, b.code!, direction, at);
      const r = await recordEvent(db, ctx.tenantId, { clubId: pt.club_id, pointId: pt.id, at, direction, code: b.code, mode: 'emulator' }, d);
      return { ...d, eventId: r.id, visitEffect: r.effect };
    });
  });

  /** Проверка «пустит ли сейчас» для карточки клиента. */
  app.get('/api/persons/:id/passes', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    const { clubId } = req.query as { clubId?: string };
    const canWork = ctx.permissions.has('*') || ctx.permissions.has(P.acsWork) || ctx.permissions.has(P.acsManage);
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select id, home_club_id from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      const club = clubId && clubId !== 'all' ? clubId : p.home_club_id;
      const creds = (await db.query(`select c.id, c.kind, c.code, c.status, c.issued_at as "issuedAt", c.revoked_at as "revokedAt", c.revoke_reason as "revokeReason",
          u.full_name as "issuedBy", cl.name as club from access_credentials c left join users u on u.id = c.issued_by join clubs cl on cl.id = c.club_id
        where c.person_id = $1 order by c.status = 'active' desc, c.issued_at desc`, [id])).rows;
      const visits = (await db.query(`select v.id, v.visited_at as "at", v.exit_at as "exitAt", v.source, cl.name as club,
          case when v.exit_at is not null then extract(epoch from v.exit_at - v.visited_at)::int / 60 end as minutes
        from visits v join clubs cl on cl.id = v.club_id where v.person_id = $1 order by v.visited_at desc limit 20`, [id])).rows;
      const stats = (await db.query(`select count(*) filter (where visited_at > now() - interval '30 days')::int as "last30", count(*)::int as total,
          round(avg(extract(epoch from exit_at - visited_at) / 60) filter (where exit_at is not null))::int as "avgMinutes", max(visited_at) as "lastAt"
        from visits where person_id = $1`, [id])).rows[0];
      const now = club ? await withCtx(pool, tenantWide(ctx), async (db2) => {
        const active = creds.find((c) => c.status === 'active');
        if (active) { const d = await decide(db2, club, active.code, 'in', new Date()); return { allow: d.decision === 'allow', reason: d.reason, warn: d.warn ?? null }; }
        const h = await holderStatus(db2, club, { person_id: id, user_id: null, holder_name: '' });
        return { allow: h.allow, reason: h.allow ? `${h.reason}. Карта не выдана` : h.reason, warn: null };
      }) : null;
      return { credentials: canWork ? creds : creds.map((c) => ({ ...c, code: c.kind === 'qr' ? c.code : `•••${String(c.code).slice(-4)}` })), visits, stats, now, canWork };
    });
  });

  /* --- карты, браслеты, QR --- */
  const issue = async (req: FastifyRequest, holder: { personId?: string; userId?: string }) => {
    const ctx = requirePerm(req, P.acsWork);
    const b = (req.body ?? {}) as { kind?: string; code?: string; clubId?: string; replaceId?: string; reason?: string };
    if (!CRED_KINDS[b.kind ?? '']) throw badRequest('Выберите: карта, браслет или QR-код');
    const code = b.kind === 'qr' ? genCode() : (b.code ?? '').replace(/\s+/g, '').toUpperCase();
    if (b.kind !== 'qr' && !/^[0-9A-F:,-]{4,32}$/.test(code)) throw badRequest('Номер карты: от 4 до 32 цифр или латинских букв A–F (как пишет считыватель)');
    return withCtx(pool, ctx, async (db) => {
      const owner = holder.personId
        ? (await db.query('select id, home_club_id as club from persons where id = $1', [holder.personId])).rows[0]
        : (await db.query(`select u.id, (select club_id from user_assignments a where a.user_id = u.id order by club_id nulls last limit 1) as club from users u where u.id = $1`, [holder.userId])).rows[0];
      if (!owner) throw notFound(holder.personId ? 'Клиент не найден' : 'Сотрудник не найден');
      const clubId = b.clubId && b.clubId !== 'all' ? b.clubId : owner.club ?? ctx.clubIds[0];
      if (!clubId) throw badRequest('Выберите клуб');
      const busy = (await withCtx(pool, tenantWide(ctx), async (db2) => (await db2.query(`select coalesce(p.full_name, u.full_name) as name from access_credentials c
        left join persons p on p.id = c.person_id left join users u on u.id = c.user_id where c.code = $1 and c.status = 'active'`, [code])).rows[0]));
      if (busy) throw badRequest(`Эта карта уже выдана: ${busy.name}. Сначала отметьте её утерянной или заменённой`);
      let replaced: { id: string } | undefined;
      if (b.replaceId) {
        replaced = (await db.query(`select id from access_credentials where id = $1 and status = 'active' and ${holder.personId ? 'person_id' : 'user_id'} = $2`, [b.replaceId, holder.personId ?? holder.userId])).rows[0];
        if (!replaced) throw badRequest('Заменяемая карта не найдена или уже не действует');
        await db.query(`update access_credentials set status = 'replaced', revoked_by = $2, revoked_at = now(), revoke_reason = $3 where id = $1`, [replaced.id, ctx.userId, b.reason?.trim() || 'Перевыпуск']);
      }
      const id = (await db.query(`insert into access_credentials(tenant_id, club_id, person_id, user_id, kind, code, issued_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, clubId, holder.personId ?? null, holder.userId ?? null, b.kind, code, ctx.userId])).rows[0].id;
      if (replaced) await db.query('update access_credentials set replaced_by_id = $2 where id = $1', [replaced.id, id]);
      await audit(db, ctx, replaced ? 'access.credential_reissued' : 'access.credential_issued', holder.personId ? 'person' : 'user', holder.personId ?? holder.userId!,
        replaced ? { credentialId: replaced.id } : null, { credentialId: id, kind: b.kind, code: b.kind === 'qr' ? 'QR' : `…${code.slice(-4)}` });
      return { id, code, kind: b.kind };
    });
  };
  app.post('/api/persons/:id/credentials', async (req, reply) => { const r = await issue(req, { personId: (req.params as { id: string }).id }); reply.code(201); return r; });
  app.post('/api/staff/:id/credentials', async (req, reply) => {
    requirePerm(req, P.acsManage);
    const r = await issue(req, { userId: (req.params as { id: string }).id }); reply.code(201); return r;
  });

  app.post('/api/acs/credentials/:id/revoke', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: string; reason?: string };
    if (!['lost', 'blocked'].includes(b.status ?? '')) throw badRequest('Укажите: утеряна или заблокирована');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query(`select id, status, person_id, user_id from access_credentials where id = $1`, [id])).rows[0];
      if (!c) throw notFound('Карта не найдена');
      if (c.status !== 'active') throw badRequest('Карта уже не действует');
      await db.query(`update access_credentials set status = $2, revoked_by = $3, revoked_at = now(), revoke_reason = $4 where id = $1`, [id, b.status, ctx.userId, b.reason?.trim() || null]);
      await audit(db, ctx, 'access.credential_revoked', c.person_id ? 'person' : 'user', c.person_id ?? c.user_id, { status: 'active' }, { status: b.status, reason: b.reason ?? null });
      return { ok: true };
    });
  });

  /* --- ручной проход --- */
  app.post('/api/acs/manual', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const b = (req.body ?? {}) as { clubId?: string; pointId?: string; personId?: string; reason?: string; comment?: string; direction?: Direction };
    if (!MANUAL_REASONS[b.reason ?? '']) throw badRequest('Выберите причину ручного прохода');
    if ((b.reason === 'other' || b.reason === 'admin_decision') && !b.comment?.trim()) throw badRequest('Опишите причину в комментарии');
    const direction: Direction = b.direction === 'out' ? 'out' : 'in';
    const pre = await withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      const pt = b.pointId ? (await db.query('select id, gateway_id from access_points where id = $1 and club_id = $2', [b.pointId, clubId])).rows[0] : null;
      if (b.pointId && !pt) throw badRequest('Турникет не найден');
      const person = b.personId ? (await db.query('select id, full_name from persons where id = $1', [b.personId])).rows[0] : null;
      if (b.personId && !person) throw notFound('Клиент не найден');
      return { clubId, pt, person };
    });
    return withCtx(pool, tenantWide(ctx), async (db) => {
      const at = new Date();
      // Что решила бы система — записываем рядом, чтобы в отчёте было видно, кого пустили вопреки правилам
      let would: Decision | null = null;
      if (pre.person) {
        const cred = (await db.query(`select code from access_credentials where person_id = $1 and status = 'active' order by issued_at desc limit 1`, [pre.person.id])).rows[0];
        if (cred) would = await decide(db, pre.clubId, cred.code, direction, at);
        else {
          const h = await holderStatus(db, pre.clubId, { person_id: pre.person.id, user_id: null, holder_name: pre.person.full_name });
          would = { decision: h.allow ? 'allow' : 'deny', reasonCode: h.reasonCode, reason: h.reason, name: pre.person.full_name, personId: pre.person.id, userId: null, credentialId: null, membershipId: h.membershipId };
        }
      }
      const label = MANUAL_REASONS[b.reason!];
      const reason = `Ручной проход: ${label}${b.comment?.trim() ? ` (${b.comment.trim()})` : ''}${would && would.decision === 'deny' ? `. Система бы не пустила: ${would.reason}` : ''}`;
      const d: Decision = { decision: 'allow', reasonCode: 'manual', reason, name: pre.person?.full_name ?? null, personId: pre.person?.id ?? null, userId: null,
        credentialId: would?.credentialId ?? null, membershipId: would?.decision === 'allow' ? would.membershipId : null };
      const r = await recordEvent(db, ctx.tenantId, { clubId: pre.clubId, pointId: pre.pt?.id ?? null, at, direction, mode: 'manual', manualBy: ctx.userId,
        manualReason: `${b.reason}${b.comment?.trim() ? `: ${b.comment.trim()}` : ''}` }, d);
      if (pre.pt?.gateway_id) {
        await db.query(`insert into access_commands(tenant_id, club_id, gateway_id, point_id, kind, event_id, created_by) values ($1,$2,$3,$4,'open',$5,$6)`,
          [ctx.tenantId, pre.clubId, pre.pt.gateway_id, pre.pt.id, r.id, ctx.userId]);
      }
      await audit(db, ctx, 'access.manual_pass', pre.person ? 'person' : 'club', pre.person?.id ?? pre.clubId, null, { reason: b.reason, comment: b.comment ?? null, would: would?.reason ?? null });
      return { ok: true, eventId: r.id, reason, wouldDeny: would?.decision === 'deny' ? would.reason : null };
    });
  });

  /* --- настройки: часы, турникеты, шлюзы --- */
  app.get('/api/acs/setup', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      await clubCheck(db, clubId);
      const settings = await accessSettings(db, clubId!);
      const gateways = (await db.query(`select id, name, status, last_seen_at as "lastSeenAt", last_sync_at as "lastSyncAt", version, queued, token_hash is not null as "hasKey",
          extract(epoch from now() - last_seen_at)::int as ago from access_gateways where club_id = $1 order by created_at`, [clubId])).rows.map((g) => ({ ...g, online: g.lastSeenAt != null && g.ago < GW_ONLINE_SEC }));
      const points = (await db.query(`select id, name, direction, gateway_id as "gatewayId", is_active as "isActive" from access_points where club_id = $1 order by name`, [clubId])).rows;
      const staff = (await db.query(`select u.id, u.full_name as name, string_agg(distinct r.name, ', ') as roles,
          (select json_agg(json_build_object('id', c.id, 'kind', c.kind, 'code', c.code)) from access_credentials c where c.user_id = u.id and c.status = 'active') as credentials
        from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code
        where u.status = 'active' and (a.club_id = $1 or a.club_id is null) group by u.id order by u.full_name`, [clubId])).rows;
      return { settings, gateways, points, staff };
    });
  });

  app.put('/api/acs/settings/:clubId', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { clubId } = req.params as { clubId: string };
    const b = (req.body ?? {}) as { openFrom?: string; openTo?: string; repeatEntryMinutes?: number; offlineHours?: number };
    const T = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!T.test(b.openFrom ?? '') || !T.test(b.openTo ?? '')) throw badRequest('Часы работы укажите в формате ЧЧ:ММ');
    if (!Number.isInteger(b.repeatEntryMinutes) || b.repeatEntryMinutes! < 0 || b.repeatEntryMinutes! > 720) throw badRequest('Повторный вход: от 0 до 720 минут');
    if (!Number.isInteger(b.offlineHours) || b.offlineHours! < 1 || b.offlineHours! > 168) throw badRequest('Работа без связи: от 1 до 168 часов');
    return withCtx(pool, ctx, async (db) => {
      await clubCheck(db, clubId);
      const before = await accessSettings(db, clubId);
      await db.query(`insert into club_access_settings(club_id, tenant_id, open_from, open_to, repeat_entry_minutes, offline_hours, updated_by, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,now()) on conflict (club_id) do update set open_from = excluded.open_from, open_to = excluded.open_to,
        repeat_entry_minutes = excluded.repeat_entry_minutes, offline_hours = excluded.offline_hours, updated_by = excluded.updated_by, updated_at = now()`,
      [clubId, ctx.tenantId, b.openFrom, b.openTo, b.repeatEntryMinutes, b.offlineHours, ctx.userId]);
      const after = await accessSettings(db, clubId);
      await audit(db, ctx, 'club.access_settings_changed', 'club', clubId, before, after);
      return after;
    });
  });

  app.post('/api/acs/gateways', async (req, reply) => {
    const ctx = requirePerm(req, P.acsManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string };
    const token = randomBytes(24).toString('base64url');
    const res = await withCtx(pool, ctx, async (db) => {
      await clubCheck(db, b.clubId);
      const id = (await db.query(`insert into access_gateways(tenant_id, club_id, name, token_hash, created_by) values ($1,$2,$3,$4,$5) returning id`,
        [ctx.tenantId, b.clubId, b.name?.trim() || 'Шлюз ресепшн', tokenHash(token), ctx.userId])).rows[0].id;
      await audit(db, ctx, 'access.gateway_created', 'club', b.clubId!, null, { gatewayId: id });
      return { id, token };
    });
    reply.code(201);
    return res;
  });

  app.post('/api/acs/gateways/:id/key', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const token = randomBytes(24).toString('base64url');
    return withCtx(pool, ctx, async (db) => {
      const g = (await db.query('select club_id from access_gateways where id = $1', [id])).rows[0];
      if (!g) throw notFound('Шлюз не найден');
      await db.query('update access_gateways set token_hash = $2 where id = $1', [id, tokenHash(token)]);
      await audit(db, ctx, 'access.gateway_key_changed', 'club', g.club_id, null, { gatewayId: id });
      return { id, token };
    });
  });

  app.patch('/api/acs/gateways/:id', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; status?: string };
    if (b.status && !['active', 'disabled'].includes(b.status)) throw badRequest('Неверный статус');
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query('update access_gateways set name = coalesce($2, name), status = coalesce($3, status) where id = $1 returning club_id', [id, b.name?.trim() || null, b.status ?? null]);
      if (!r.rowCount) throw notFound('Шлюз не найден');
      return { ok: true };
    });
  });

  app.post('/api/acs/points', async (req, reply) => {
    const ctx = requirePerm(req, P.acsManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string; direction?: string; gatewayId?: string | null };
    if (!b.name?.trim()) throw badRequest('Назовите турникет, например «Вход 1»');
    if (!['in', 'out', 'both'].includes(b.direction ?? '')) throw badRequest('Выберите направление');
    const res = await withCtx(pool, ctx, async (db) => {
      await clubCheck(db, b.clubId);
      if (b.gatewayId && !(await db.query('select 1 from access_gateways where id = $1 and club_id = $2', [b.gatewayId, b.clubId])).rowCount) throw badRequest('Шлюз не найден');
      return (await db.query(`insert into access_points(tenant_id, club_id, name, direction, gateway_id) values ($1,$2,$3,$4,$5) returning id`,
        [ctx.tenantId, b.clubId, b.name!.trim(), b.direction, b.gatewayId || null])).rows[0];
    });
    reply.code(201);
    return res;
  });

  app.patch('/api/acs/points/:id', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; direction?: string; gatewayId?: string | null; isActive?: boolean };
    if (b.direction && !['in', 'out', 'both'].includes(b.direction)) throw badRequest('Неверное направление');
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query(`update access_points set name = coalesce($2, name), direction = coalesce($3, direction), is_active = coalesce($4, is_active),
          gateway_id = case when $5 then $6::uuid else gateway_id end where id = $1`,
      [id, b.name?.trim() || null, b.direction ?? null, b.isActive ?? null, b.gatewayId !== undefined, b.gatewayId || null]);
      if (!r.rowCount) throw notFound('Турникет не найден');
      return { ok: true };
    });
  });

  /* --- отчёт --- */
  app.get('/api/acs/report', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { clubId, from, to } = req.query as { clubId?: string; from?: string; to?: string };
    const D = /^\d{4}-\d{2}-\d{2}$/;
    if (!D.test(from ?? '') || !D.test(to ?? '')) throw badRequest('Укажите период');
    return withCtx(pool, ctx, async (db) => {
      await clubCheck(db, clubId);
      const tz = (await db.query('select timezone from clubs where id = $1', [clubId])).rows[0].timezone;
      const range = [clubId, from, to, tz];
      const local = (col: string) => `(${col} at time zone $4)::date`;
      const summary = (await db.query(`select count(*)::int as visits, count(distinct person_id)::int as people,
          round(avg(extract(epoch from exit_at - visited_at) / 60) filter (where exit_at is not null))::int as "avgMinutes",
          count(*) filter (where exit_at is null)::int as "noExit"
        from visits where club_id = $1 and ${local('visited_at')} between $2 and $3`, range)).rows[0];
      const byDay = (await db.query(`select to_char(${local('visited_at')}, 'YYYY-MM-DD') as day, count(*)::int as visits from visits
        where club_id = $1 and ${local('visited_at')} between $2 and $3 group by 1 order by 1`, range)).rows;
      const byHour = (await db.query(`select extract(hour from visited_at at time zone $4)::int as hour, count(*)::int as visits from visits
        where club_id = $1 and ${local('visited_at')} between $2 and $3 group by 1 order by 1`, range)).rows;
      const manual = (await db.query(`select e.happened_at as at, e.direction, e.reason, e.manual_reason as "manualReason", mb.full_name as "manualBy", p.full_name as person, pt.name as point
        from access_events e left join users mb on mb.id = e.manual_by left join persons p on p.id = e.person_id left join access_points pt on pt.id = e.point_id
        where e.club_id = $1 and e.mode = 'manual' and ${local('e.happened_at')} between $2 and $3 order by e.happened_at desc`, range)).rows;
      const denials = (await db.query(`select reason_code as "reasonCode", count(*)::int as n, count(distinct coalesce(person_id::text, code))::int as people
        from access_events where club_id = $1 and decision = 'deny' and ${local('happened_at')} between $2 and $3 group by 1 order by 2 desc`, range)).rows
        .map((r) => ({ ...r, title: REASON_TITLES[r.reasonCode] ?? r.reasonCode }));
      const offline = (await db.query(`select count(*)::int as n from access_events where club_id = $1 and mode = 'offline' and ${local('happened_at')} between $2 and $3`, range)).rows[0].n;
      const staff = (await db.query(`select u.full_name as name, to_char(${local('e.happened_at')}, 'YYYY-MM-DD') as day,
          min(e.happened_at) filter (where e.direction = 'in') as "firstIn", max(e.happened_at) filter (where e.direction = 'out') as "lastOut", count(*)::int as events
        from access_events e join users u on u.id = e.user_id
        where e.club_id = $1 and e.decision = 'allow' and ${local('e.happened_at')} between $2 and $3 group by u.full_name, 2 order by 2 desc, 1`, range)).rows;
      return { summary, byDay, byHour, manual, denials, offline, staff };
    });
  });

  /* ---------- API шлюза (без пользователя, по ключу шлюза) ---------- */
  const gw = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const token = String(req.headers['x-gateway-key'] ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !token) return null;
    const a = (await pool.query('select * from acs_gateway_by_token($1, $2)', [id, token])).rows[0];
    if (!a) return null;
    const queued = Number(req.headers['x-gateway-queued'] ?? 0);
    await withCtx(pool, { tenantId: a.tenant_id, allClubs: true, clubIds: [] }, (db) => db.query(`update access_gateways set last_seen_at = now(), version = coalesce($2, version), queued = $3 where id = $1`,
      [id, String(req.headers['x-gateway-version'] ?? '') || null, Number.isFinite(queued) ? queued : 0]));
    return { id, tenantId: a.tenant_id as string, clubId: a.club_id as string };
  };
  const denyGw = { error: 'unauthorized', message: 'Неверный ключ шлюза' };

  app.get('/api/acs/gw/:id/rules', async (req, reply) => {
    const g = await gw(req);
    if (!g) return reply.code(401).send(denyGw);
    return withCtx(pool, { tenantId: g.tenantId, allClubs: true, clubIds: [] }, async (db) => {
      const snap = await buildSnapshot(db, g.id, g.clubId);
      await db.query('update access_gateways set last_sync_at = now() where id = $1', [g.id]);
      return snap;
    });
  });

  app.post('/api/acs/gw/:id/decide', async (req, reply) => {
    const g = await gw(req);
    if (!g) return reply.code(401).send(denyGw);
    const b = (req.body ?? {}) as { pointId?: string; code?: string; direction?: Direction; externalId?: string; at?: string };
    return withCtx(pool, { tenantId: g.tenantId, allClubs: true, clubIds: [] }, async (db) => {
      const pt = (await db.query('select id, direction from access_points where id = $1 and club_id = $2', [b.pointId, g.clubId])).rows[0];
      if (!pt) throw badRequest('Турникет не найден');
      const direction: Direction = b.direction === 'out' || pt.direction === 'out' ? 'out' : 'in';
      const at = new Date();
      const d = await decide(db, g.clubId, b.code ?? '', direction, at);
      const r = await recordEvent(db, g.tenantId, { clubId: g.clubId, pointId: pt.id, gatewayId: g.id, externalId: b.externalId ?? null, at, direction, code: b.code, mode: 'online' }, d);
      return { allow: d.decision === 'allow', reasonCode: d.reasonCode, reason: d.reason, name: d.name, warn: d.warn ?? null, eventId: r.id, duplicate: r.duplicate };
    });
  });

  // Выгрузка проходов, накопленных без связи. Повторная выгрузка того же события ничего не меняет.
  app.post('/api/acs/gw/:id/events', async (req, reply) => {
    const g = await gw(req);
    if (!g) return reply.code(401).send(denyGw);
    const b = (req.body ?? {}) as { events?: { externalId?: string; pointId?: string; code?: string; direction?: Direction; at?: string; allow?: boolean; reasonCode?: string; reason?: string }[] };
    const list = (b.events ?? []).filter((e) => e.externalId && e.at && !Number.isNaN(Date.parse(e.at))).sort((x, y) => Date.parse(x.at!) - Date.parse(y.at!));
    if (list.length > 2000) throw badRequest('Не больше 2000 событий за раз');
    return withCtx(pool, { tenantId: g.tenantId, allClubs: true, clubIds: [] }, async (db) => {
      const points = new Set((await db.query('select id from access_points where club_id = $1', [g.clubId])).rows.map((r) => r.id));
      let accepted = 0; let duplicates = 0;
      for (const e of list) {
        const direction: Direction = e.direction === 'out' ? 'out' : 'in';
        const c = e.code ? await credentialByCode(db, e.code) : null;
        const d: Decision = { decision: e.allow ? 'allow' : 'deny', reasonCode: String(e.reasonCode ?? (e.allow ? 'ok' : 'unknown_card')).slice(0, 40),
          reason: String(e.reason ?? (e.allow ? 'Пропущен без связи' : 'Отказ без связи')).slice(0, 300),
          name: c?.holder_name ?? null, personId: c?.person_id ?? null, userId: c?.user_id ?? null, credentialId: c?.id ?? null, membershipId: null };
        if (d.personId && d.decision === 'allow' && direction === 'in') {
          d.membershipId = (await holderStatus(db, g.clubId, c)).membershipId ?? null;
        }
        const r = await recordEvent(db, g.tenantId, { clubId: g.clubId, pointId: points.has(e.pointId) ? e.pointId : null, gatewayId: g.id, externalId: String(e.externalId).slice(0, 100),
          at: new Date(e.at!), direction, code: e.code ?? null, mode: 'offline' }, d);
        if (r.duplicate) duplicates++; else accepted++;
      }
      return { accepted, duplicates };
    });
  });

  app.post('/api/acs/gw/:id/commands/:cmd/done', async (req, reply) => {
    const g = await gw(req);
    if (!g) return reply.code(401).send(denyGw);
    const { cmd } = req.params as { cmd: string };
    await withCtx(pool, { tenantId: g.tenantId, allClubs: true, clubIds: [] }, (db) =>
      db.query(`update access_commands set status = 'done', done_at = now() where id = $1 and gateway_id = $2`, [cmd, g.id]));
    return { ok: true };
  });
}

