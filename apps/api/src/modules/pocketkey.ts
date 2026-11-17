// СКУД PocketKey (ТЗ от 17.11.2026). Схема «PocketKey спрашивает CRM», как в готовых интеграциях Fitbase и ImpulseCRM:
// специалист PocketKey вписывает в свой сервер адреса CRM, и при каждом прикладывании карты СКУД спрашивает, пускать ли человека,
// а после прохода сообщает, что он состоялся. Решение принимает та же логика, что и для любого турникета («Проходы»):
// абонемент, долг, заморозка, часы, карта заменена и т. д. Исполняет решение сама СКУД.
//
// Официальный формат запросов PocketKey пока не получен, поэтому разбор входящих данных собран в одном месте (parse*)
// и понимает разные написания полей. Когда придёт описание протокола, подгоняется только этот файл.
// Чего нет в документации (открыть дверь из CRM, гостевой QR в PocketKey, выгрузка людей, состояние оборудования),
// CRM не имитирует: отвечает «недоступно».
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { credentialByCode, decide, holderStatus, recordEvent } from './acs.ts';
import { REASON_TITLES, type Direction } from './acsRules.ts';

const tokenHash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
export const PK_OPS = ['check-access', 'event', 'identify', 'devices', 'health'] as const;
/** Чего пока нет в API PocketKey (по ТЗ — «требуется документация»): показываем как недоступное, не имитируем. */
export const PK_UNSUPPORTED = [
  'Открыть дверь или турникет из CRM',
  'Гостевой и временный QR-пропуск в PocketKey',
  'Выгрузка клиентов и сотрудников в PocketKey',
  'Состояние оборудования',
];

export type PkSettings = {
  /** Когда считать посещение: по событию прохода от PocketKey (надёжно) или сразу по разрешению (если СКУД событий не присылает). */
  visitBy: 'event' | 'check';
  /** Принимать запросы только с этих адресов (пусто — с любых, защищает ключ в адресе). */
  allowedIps: string[];
};
export const pkSettings = (s: unknown): PkSettings => {
  const o = (s ?? {}) as Partial<PkSettings>;
  return { visitBy: o.visitBy === 'check' ? 'check' : 'event', allowedIps: Array.isArray(o.allowedIps) ? o.allowedIps.map(String).filter(Boolean) : [] };
};

/* ---------- разбор входящих данных PocketKey ---------- */
type In = Record<string, unknown>;
const pick = (b: In, keys: string[]): string | null => {
  for (const k of keys) {
    const v = b[k];
    if (v != null && v !== '' && typeof v !== 'object') return String(v).trim();
  }
  return null;
};
const DEVICE = ['device_id', 'deviceId', 'device', 'reader_id', 'readerId', 'terminal_id', 'terminalId', 'turnstile_id', 'door_id', 'doorId', 'access_point', 'accessPoint', 'point_id', 'controller_id'];
const CODE = ['credential_id', 'credentialId', 'card_number', 'cardNumber', 'card', 'card_id', 'cardId', 'key', 'key_id', 'uid', 'rfid', 'code', 'identifier', 'qr', 'qr_code', 'pass_id'];
const KIND = ['credential_type', 'credentialType', 'identifier_type', 'type'];
const DIR = ['direction', 'dir', 'way', 'passage_direction'];
const EVENT_ID = ['event_id', 'eventId', 'external_id', 'uuid', 'id', 'guid', 'request_id', 'requestId'];
const TIME = ['time', 'timestamp', 'at', 'datetime', 'date_time', 'event_time', 'eventTime', 'date'];
const RESULT = ['result', 'status', 'event_type', 'eventType', 'access_granted', 'granted', 'passed', 'allowed'];

export function parseDirection(v: string | null): Direction | null {
  if (v == null) return null;
  const s = v.toLowerCase();
  if (['in', 'entry', 'enter', 'input', 'вход', '1', 'inside'].includes(s)) return 'in';
  if (['out', 'exit', 'output', 'выход', '2', 'outside', '0'].includes(s)) return 'out';
  return null;
}
export function parseTime(v: string | null): Date | null {
  if (!v) return null;
  if (/^\d{9,13}$/.test(v)) { const n = Number(v); return new Date(v.length <= 10 ? n * 1000 : n); }
  const d = new Date(v.includes('T') || v.includes('Z') ? v : v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Что сообщает СКУД о проходе: состоялся (passed), отказ (denied) или неизвестно. */
export function parseResult(v: string | null): 'passed' | 'denied' | null {
  if (v == null) return null;
  const s = v.toLowerCase();
  if (['true', '1', 'ok', 'pass', 'passed', 'granted', 'allow', 'allowed', 'success', 'access_granted', 'entry', 'exit'].includes(s)) return 'passed';
  if (['false', '0', 'deny', 'denied', 'rejected', 'refused', 'fail', 'failed', 'access_denied', 'error'].includes(s)) return 'denied';
  return null;
}
/** Номер карты как пишет считыватель: без пробелов, заглавными. */
export const normCode = (v: string | null) => (v ?? '').replace(/\s+/g, '').toUpperCase();
const tail = (code: string) => (code ? `…${code.slice(-4)}` : null);

export function parseRequest(b: In) {
  return {
    device: pick(b, DEVICE),
    code: normCode(pick(b, CODE)),
    kind: pick(b, KIND),
    direction: parseDirection(pick(b, DIR)),
    eventId: pick(b, EVENT_ID),
    at: parseTime(pick(b, TIME)),
    result: parseResult(pick(b, RESULT)),
  };
}

/* ---------- логика ---------- */
type Conn = { id: string; tenantId: string; clubId: string; settings: PkSettings };

/** Карта по номеру: точное совпадение, затем без ведущих нулей (СКУД и считыватель ресепшн часто пишут номер по-разному). */
async function findCode(db: Db, code: string): Promise<string> {
  if (!code) return code;
  if (await credentialByCode(db, code)) return code;
  const short = code.replace(/^0+/, '');
  if (!short || short === code) return code;
  const alt = (await db.query(`select code from access_credentials where ltrim(code, '0') = $1 order by (status = 'active') desc, issued_at desc limit 1`, [short])).rows[0];
  return alt?.code ?? code;
}

/** Турникет CRM по номеру устройства PocketKey. Новое устройство заводим сами — администратор потом переименует. */
async function pointFor(db: Db, c: Conn, device: string | null) {
  if (!device) return null;
  const ext = device.slice(0, 100);
  const found = (await db.query(`select id, name, direction, is_active as "isActive" from access_points where gateway_id = $1 and external_id = $2`, [c.id, ext])).rows[0];
  if (found) return found as { id: string; name: string; direction: string; isActive: boolean };
  return (await db.query(`insert into access_points(tenant_id, club_id, gateway_id, name, direction, external_id) values ($1,$2,$3,$4,'both',$5)
    on conflict (gateway_id, external_id) where external_id is not null do update set external_id = excluded.external_id
    returning id, name, direction, is_active as "isActive"`, [c.tenantId, c.clubId, c.id, `PocketKey ${ext}`, ext])).rows[0];
}

const dirFor = (asked: Direction | null, point: { direction: string } | null): Direction =>
  asked ?? (point?.direction === 'out' ? 'out' : 'in');

async function log(db: Db, c: Conn, op: string, status: string, x: { correlationId?: string | null; device?: string | null; code?: string; message?: string | null; ms?: number }) {
  await db.query(`insert into acs_integration_log(tenant_id, club_id, gateway_id, op, status, correlation_id, device, code_tail, message, ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.tenantId, c.clubId, c.id, op, status, x.correlationId?.slice(0, 100) ?? null, x.device?.slice(0, 100) ?? null, x.code ? tail(x.code) : null, x.message?.slice(0, 300) ?? null, x.ms ?? null]);
  // Журнал храним 30 дней
  if (Math.random() < 0.02) await db.query(`delete from acs_integration_log where gateway_id = $1 and at < now() - interval '30 days'`, [c.id]);
}

/** Проверка права прохода: СКУД спрашивает, пускать ли человека с этой картой через это устройство. */
export async function pkCheck(db: Db, c: Conn, body: In) {
  const t0 = Date.now();
  const r = parseRequest(body);
  const pt = await pointFor(db, c, r.device);
  const direction = dirFor(r.direction, pt);
  const code = await findCode(db, r.code);
  const at = new Date();
  let d = await decide(db, c.clubId, code, direction, at);
  if (pt && !pt.isActive) d = { ...d, decision: 'deny', reasonCode: 'point_off', reason: `Устройство «${pt.name}» выключено в CRM` };
  const allow = d.decision === 'allow';
  // Отказ — это всегда событие (турникет не открылся). Разрешение — пока только намерение: проход подтвердит событие от СКУД,
  // если в настройке не выбрано «считать посещение сразу по разрешению».
  let eventId: string | null = null;
  if (!allow || c.settings.visitBy === 'check') {
    const ev = await recordEvent(db, c.tenantId, { clubId: c.clubId, pointId: pt?.id ?? null, gatewayId: c.id, externalId: r.eventId ? `chk:${r.eventId}` : null,
      at, direction, code: code || null, mode: 'online' }, d);
    eventId = ev.id;
  }
  await log(db, c, 'check', allow ? 'allow' : 'deny', { correlationId: r.eventId, device: r.device, code, message: d.reason, ms: Date.now() - t0 });
  return {
    access_granted: allow, allow, result: allow ? 'granted' : 'denied',
    user_id: d.personId ?? d.userId ?? null, user_type: d.personId ? 'client' : d.userId ? 'staff' : null, name: d.name,
    reason_code: d.reasonCode, message: d.warn ? `${d.reason}. ${d.warn}` : d.reason, direction: direction === 'in' ? 'entry' : 'exit', event_id: eventId,
  };
}

/** Событие от СКУД: человек прошёл (или получил отказ). Повтор того же события ничего не меняет. */
export async function pkEvent(db: Db, c: Conn, body: In) {
  const t0 = Date.now();
  const r = parseRequest(body);
  if (!r.eventId) throw badRequest('Нет номера события (event_id): без него не защититься от повторов');
  const pt = await pointFor(db, c, r.device);
  const direction = dirFor(r.direction, pt);
  const code = await findCode(db, r.code);
  const at = r.at && r.at.getTime() <= Date.now() + 5 * 60_000 ? r.at : new Date();
  const passed = r.result !== 'denied';
  const crm = await decide(db, c.clubId, code, direction, at);
  const old = Date.now() - at.getTime() > 10 * 60_000;
  let d = crm;
  if (passed && crm.decision !== 'allow') {
    // СКУД пропустила, хотя CRM бы не пустила (например, решала сама без связи): проход был — фиксируем его и причину
    const c2 = code ? await credentialByCode(db, code) : null;
    const membershipId = c2?.person_id ? (await holderStatus(db, c.clubId, c2)).membershipId ?? null : null;
    d = { ...crm, decision: 'allow', reasonCode: 'acs_allowed', reason: `Пропустила СКУД PocketKey. По правилам CRM: ${crm.reason}`, membershipId };
  } else if (!passed && crm.decision === 'allow') {
    d = { ...crm, decision: 'deny', reasonCode: 'acs_denied', reason: 'Не пропустила СКУД PocketKey' };
  }
  // Отказ, о котором CRM уже знает по проверке, второй раз в ленту не пишем
  if (!passed) {
    const seen = (await db.query(`select id from access_events where gateway_id = $1 and decision = 'deny' and code is not distinct from $2
      and happened_at > $3::timestamptz - interval '2 minutes' and happened_at <= $3::timestamptz + interval '1 minute' limit 1`, [c.id, code || null, at.toISOString()])).rows[0];
    if (seen) {
      await log(db, c, 'event', 'duplicate', { correlationId: r.eventId, device: r.device, code, message: 'Отказ уже записан при проверке', ms: Date.now() - t0 });
      return { ok: true, duplicate: true, event_id: seen.id };
    }
  }
  const ev = await recordEvent(db, c.tenantId, { clubId: c.clubId, pointId: pt?.id ?? null, gatewayId: c.id, externalId: r.eventId.slice(0, 100),
    at, direction, code: code || null, mode: old ? 'offline' : 'online' }, d);
  await log(db, c, 'event', ev.duplicate ? 'duplicate' : d.decision, { correlationId: r.eventId, device: r.device, code, message: d.reason, ms: Date.now() - t0 });
  return { ok: true, duplicate: ev.duplicate, event_id: ev.id, visit: ev.effect };
}

/** Опознание: кто владелец карты и действует ли доступ. Только то, что нужно СКУД: без телефонов и прочих данных. */
export async function pkIdentify(db: Db, c: Conn, body: In) {
  const r = parseRequest(body);
  const code = await findCode(db, r.code);
  const cred = code ? await credentialByCode(db, code) : null;
  if (!cred) {
    await log(db, c, 'identify', 'deny', { device: r.device, code, message: REASON_TITLES.unknown_card });
    return { found: false, message: REASON_TITLES.unknown_card };
  }
  const h = cred.status === 'active' ? await holderStatus(db, c.clubId, cred) : null;
  await log(db, c, 'identify', 'ok', { device: r.device, code, message: cred.holder_name });
  return {
    found: true, user_id: cred.person_id ?? cred.user_id, user_type: cred.person_id ? 'client' : 'staff', name: cred.holder_name,
    credential_status: cred.status, credential_type: cred.kind, access_active: !!h?.allow, valid_until: h?.validUntil ?? null,
    message: h ? h.reason : REASON_TITLES[`card_${cred.status}`] ?? 'Карта не действует',
  };
}

/* ---------- маршруты ---------- */
const publicBase = (req: FastifyRequest) => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.headers.host}`;
export const pkUrls = (base: string, id: string, token: string) =>
  Object.fromEntries(PK_OPS.map((op) => [op, `${base}/api/pocketkey/${id}/${token}/${op}`])) as Record<(typeof PK_OPS)[number], string>;

export function pocketkeyRoutes(app: FastifyInstance, pool: pg.Pool) {
  const sys = (tenantId: string) => ({ tenantId, allClubs: true, clubIds: [] as string[] });

  /* --- запросы от сервера PocketKey: ключ в адресе (так их вписывает специалист PocketKey, как у Fitbase) --- */
  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<Conn | null> => {
    const { id, token } = req.params as { id: string; token: string };
    if (!/^[0-9a-f-]{36}$/i.test(id) || !token) { reply.code(404).send({ error: 'not_found' }); return null; }
    const a = (await pool.query('select * from acs_gateway_by_token($1, $2)', [id, token])).rows[0];
    if (!a || a.kind !== 'pocketkey') { reply.code(401).send({ access_granted: false, error: 'unauthorized', message: 'Неверный ключ подключения' }); return null; }
    const s = (await withCtx(pool, sys(a.tenant_id), (db) => db.query(`update access_gateways set last_seen_at = now() where id = $1 returning settings`, [id]))).rows[0];
    const c: Conn = { id, tenantId: a.tenant_id, clubId: a.club_id, settings: pkSettings(s?.settings) };
    if (c.settings.allowedIps.length && !c.settings.allowedIps.includes(req.ip)) {
      await withCtx(pool, sys(c.tenantId), (db) => log(db, c, 'auth', 'error', { message: `Запрос с чужого адреса ${req.ip}` }));
      reply.code(403).send({ access_granted: false, error: 'forbidden', message: 'Адрес не разрешён' });
      return null;
    }
    return c;
  };
  const input = (req: FastifyRequest): In => ({ ...(req.query as In), ...((req.body && typeof req.body === 'object' ? req.body : {}) as In) });
  // Техническая ошибка: человека не пускаем (ТЗ: не допускать бесконтрольного доступа), ответ — понятный СКУД
  const guard = (op: string, fn: (db: Db, c: Conn, b: In) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const c = await auth(req, reply);
    if (!c) return reply;
    try {
      return await withCtx(pool, sys(c.tenantId), (db) => fn(db, c, input(req)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof HttpError ? e.status : 503;
      await withCtx(pool, sys(c.tenantId), (db) => log(db, c, op, 'error', { message: msg })).catch(() => {});
      const known = status >= 400 && status < 500;
      return reply.code(known ? status : 503).send({ access_granted: false, error: known ? 'bad_request' : 'unavailable', message: known ? msg : 'CRM временно недоступна' });
    }
  };

  for (const m of ['GET', 'POST'] as const) {
    app.route({ method: m, url: '/api/pocketkey/:id/:token/check-access', handler: guard('check', pkCheck) });
    app.route({ method: m, url: '/api/pocketkey/:id/:token/event', handler: guard('event', pkEvent) });
    app.route({ method: m, url: '/api/pocketkey/:id/:token/identify', handler: guard('identify', pkIdentify) });
  }
  app.get('/api/pocketkey/:id/:token/devices', guard('devices', async (db, c) => {
    const points = (await db.query(`select external_id as device_id, name, direction, is_active as active from access_points where gateway_id = $1 and external_id is not null order by name`, [c.id])).rows;
    await log(db, c, 'devices', 'ok', { message: `Устройств: ${points.length}` });
    return { devices: points };
  }));
  app.get('/api/pocketkey/:id/:token/health', guard('health', async (db, c) => {
    const club = (await db.query('select name from clubs where id = $1', [c.clubId])).rows[0];
    await log(db, c, 'health', 'ok', {});
    return { ok: true, service: 'crm', club: club?.name ?? null, time: new Date().toISOString(), visit_by: c.settings.visitBy };
  }));
  // Выгрузка людей в PocketKey — только когда появится официальный API
  app.post('/api/pocketkey/:id/:token/users/sync', async (req, reply) => {
    const c = await auth(req, reply);
    if (!c) return reply;
    await withCtx(pool, sys(c.tenantId), (db) => log(db, c, 'sync', 'unsupported', { message: 'Нет документации PocketKey' }));
    return reply.code(501).send({ ok: false, error: 'not_supported', message: 'Синхронизация пользователей появится после получения документации PocketKey' });
  });

  /* --- настройка в CRM («Проходы → Настройка → PocketKey») --- */
  const connOf = async (db: Db, id: string) => {
    const g = (await db.query(`select id, club_id, settings from access_gateways where id = $1 and kind = 'pocketkey'`, [id])).rows[0];
    if (!g) throw notFound('Подключение PocketKey не найдено');
    return g as { id: string; club_id: string; settings: unknown };
  };

  app.get('/api/acs/pocketkey', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!clubId || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
      const conns = (await db.query(`select id, name, status, settings, last_seen_at as "lastSeenAt", created_at as "createdAt" from access_gateways
        where club_id = $1 and kind = 'pocketkey' order by created_at`, [clubId])).rows;
      const out = [];
      for (const g of conns) {
        const devices = (await db.query(`select id, name, direction, external_id as "externalId", is_active as "isActive" from access_points where gateway_id = $1 order by name`, [g.id])).rows;
        const journal = (await db.query(`select at, op, status, correlation_id as "correlationId", device, code_tail as "codeTail", message, ms from acs_integration_log
          where gateway_id = $1 order by at desc, id desc limit 50`, [g.id])).rows;
        const stats = (await db.query(`select count(*) filter (where op = 'check')::int as checks, count(*) filter (where op = 'event')::int as events,
            count(*) filter (where status = 'error')::int as errors from acs_integration_log where gateway_id = $1 and at > now() - interval '24 hours'`, [g.id])).rows[0];
        out.push({ ...g, settings: pkSettings(g.settings), devices, journal, stats });
      }
      return { connections: out, unsupported: PK_UNSUPPORTED, ops: PK_OPS };
    });
  });

  // Новое подключение: ключ и адреса показываем один раз — их Андрей сам передаёт специалисту PocketKey
  app.post('/api/acs/pocketkey', async (req, reply) => {
    const ctx = requirePerm(req, P.acsManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string };
    const token = randomBytes(24).toString('base64url');
    const res = await withCtx(pool, ctx, async (db) => {
      if (!b.clubId || !(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Выберите клуб');
      if ((await db.query(`select 1 from access_gateways where club_id = $1 and kind = 'pocketkey'`, [b.clubId])).rowCount) throw badRequest('PocketKey в этом клубе уже подключён. Если нужны новые адреса, нажмите «Новый ключ и адреса»');
      const id = (await db.query(`insert into access_gateways(tenant_id, club_id, name, token_hash, created_by, kind, settings) values ($1,$2,$3,$4,$5,'pocketkey',$6) returning id`,
        [ctx.tenantId, b.clubId, b.name?.trim() || 'PocketKey', tokenHash(token), ctx.userId, JSON.stringify(pkSettings({}))])).rows[0].id as string;
      await audit(db, ctx, 'access.pocketkey_created', 'club', b.clubId, null, { gatewayId: id });
      return { id, token, urls: pkUrls(publicBase(req), id, token) };
    });
    reply.code(201);
    return res;
  });

  app.post('/api/acs/pocketkey/:id/key', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const token = randomBytes(24).toString('base64url');
    return withCtx(pool, ctx, async (db) => {
      const g = await connOf(db, id);
      await db.query('update access_gateways set token_hash = $2 where id = $1', [id, tokenHash(token)]);
      await audit(db, ctx, 'access.pocketkey_key_changed', 'club', g.club_id, null, { gatewayId: id });
      return { id, token, urls: pkUrls(publicBase(req), id, token) };
    });
  });

  app.patch('/api/acs/pocketkey/:id', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: string; visitBy?: string; allowedIps?: string | string[]; name?: string };
    if (b.status && !['active', 'disabled'].includes(b.status)) throw badRequest('Неверный статус');
    if (b.visitBy && !['event', 'check'].includes(b.visitBy)) throw badRequest('Выберите, когда считать посещение');
    const ips = b.allowedIps == null ? undefined : (Array.isArray(b.allowedIps) ? b.allowedIps : String(b.allowedIps).split(/[\s,;]+/)).map((x) => x.trim()).filter(Boolean);
    if (ips?.some((x) => !/^[0-9a-f:.]{3,45}$/i.test(x))) throw badRequest('Адреса укажите цифрами через запятую, например 91.200.10.5');
    return withCtx(pool, ctx, async (db) => {
      const g = await connOf(db, id);
      const before = pkSettings(g.settings);
      const after: PkSettings = { visitBy: (b.visitBy as PkSettings['visitBy']) ?? before.visitBy, allowedIps: ips ?? before.allowedIps };
      await db.query(`update access_gateways set settings = $2, status = coalesce($3, status), name = coalesce($4, name) where id = $1`,
        [id, JSON.stringify(after), b.status ?? null, b.name?.trim() || null]);
      await audit(db, ctx, 'access.pocketkey_changed', 'club', g.club_id, before, { ...after, status: b.status ?? null });
      return { ok: true, settings: after };
    });
  });

  // Номер устройства PocketKey у турникета CRM (когда устройство заведено вручную или надо поправить)
  app.patch('/api/acs/pocketkey/:id/devices/:point', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id, point } = req.params as { id: string; point: string };
    const b = (req.body ?? {}) as { externalId?: string; name?: string; direction?: string; isActive?: boolean };
    if (b.direction && !['in', 'out', 'both'].includes(b.direction)) throw badRequest('Неверное направление');
    return withCtx(pool, ctx, async (db) => {
      await connOf(db, id);
      const ext = b.externalId === undefined ? undefined : b.externalId.trim().slice(0, 100) || null;
      if (ext && (await db.query('select 1 from access_points where gateway_id = $1 and external_id = $2 and id <> $3', [id, ext, point])).rowCount) throw badRequest('Такой номер устройства уже привязан к другому турникету');
      const r = await db.query(`update access_points set gateway_id = $2, name = coalesce($3, name), direction = coalesce($4, direction), is_active = coalesce($5, is_active),
          external_id = case when $6 then $7 else external_id end where id = $1 and club_id = (select club_id from access_gateways where id = $2)`,
      [point, id, b.name?.trim() || null, b.direction ?? null, b.isActive ?? null, ext !== undefined, ext ?? null]);
      if (!r.rowCount) throw notFound('Турникет не найден');
      return { ok: true };
    });
  });

  // Проверка без оборудования: тот же путь, что у запроса от PocketKey, только из окна настройки
  app.post('/api/acs/pocketkey/:id/test', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { op?: string; device?: string; code?: string; direction?: string; result?: string };
    const g = await withCtx(pool, ctx, (db) => connOf(db, id));
    const c: Conn = { id, tenantId: ctx.tenantId, clubId: g.club_id, settings: pkSettings(g.settings) };
    const body: In = { device_id: b.device || 'test_device', credential_id: b.code ?? '', direction: b.direction === 'out' ? 'exit' : 'entry' };
    return withCtx(pool, sys(ctx.tenantId), async (db) => {
      if (b.op === 'event') return { op: 'event', response: await pkEvent(db, c, { ...body, event_id: `test-${randomUUID()}`, result: b.result === 'denied' ? 'denied' : 'passed', time: new Date().toISOString() }) };
      if (b.op === 'identify') return { op: 'identify', response: await pkIdentify(db, c, body) };
      return { op: 'check-access', response: await pkCheck(db, c, body) };
    });
  });
}
