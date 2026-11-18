// СКУД PocketKey. Протокол — «Pocketkey API СКУД» (статья базы знаний PocketKey и сваггер ACSPocketkey 1.0.0, получены 18.11.2026).
// Сервис PocketKey в клубе сам обращается к CRM (КПО — «клубное программное обеспечение») GET-запросами на адрес вида
// http://адрес/путь_к_сервису/… и ждёт JSON в UTF-8:
//   /devices                         — список терминалов: {"devices":[{"id":1,"ip":"192.168.2.210","port":8080,"biometrics":false,"config_string":"type=pocket"}]}
//   /checkaccess?id=1&uid=5432916C&cells=x:y;x:y — приложили браслет: {"client_id":"…","text":"Проходите","grant_access":1}
//   /event?id=1&uid=5432916C         — турникет провернулся (проход состоялся), достаточно HTTP 200
// Решение о проходе принимает CRM (та же логика, что для любого турникета: абонемент, долг, заморозка, часы, замена карты).
// PocketKey сам решает только в «автономном» режиме, когда нет связи; такие проходы приходят событием и записываются с пометкой.
// Чего в протоколе нет (открыть дверь из CRM, гостевой QR, выгрузка людей, состояние оборудования), CRM не имитирует.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { credentialByCode, decide, holderStatus, recordEvent } from './acs.ts';
import { REASON_TITLES, type Direction } from './acsRules.ts';

const tokenHash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
/** Запросы, которые шлёт PocketKey (адрес сервиса + /имя). */
export const PK_OPS = ['devices', 'checkaccess', 'event'] as const;
/** Чего нет в протоколе PocketKey: показываем как недоступное, не имитируем. */
export const PK_UNSUPPORTED = [
  'Открыть дверь или турникет из CRM',
  'Гостевой и временный QR-пропуск в PocketKey',
  'Выгрузка клиентов и сотрудников в PocketKey',
  'Состояние оборудования',
];
export const PK_PORTS: Record<string, number> = { pocket: 8080, jsp: 8902 };

export type PkSettings = {
  /** Когда считать посещение: по событию прохода от PocketKey (надёжно) или сразу по разрешению. */
  visitBy: 'event' | 'check';
  /** Принимать запросы только с этих адресов (пусто — с любых, защищает ключ в адресе). */
  allowedIps: string[];
  /** Выпускать ли с закрытым шкафчиком (PocketKey сообщает о закрытых замках на выходе). По умолчанию выпускаем. */
  lockerExit: 'allow' | 'deny';
};
export const pkSettings = (s: unknown): PkSettings => {
  const o = (s ?? {}) as Partial<PkSettings>;
  return { visitBy: o.visitBy === 'check' ? 'check' : 'event', allowedIps: Array.isArray(o.allowedIps) ? o.allowedIps.map(String).filter(Boolean) : [],
    lockerExit: o.lockerExit === 'deny' ? 'deny' : 'allow' };
};

/* ---------- разбор запроса PocketKey ---------- */
type In = Record<string, unknown>;
const pick = (b: In, keys: string[]): string | null => {
  for (const k of keys) {
    const v = b[k];
    if (v != null && v !== '' && typeof v !== 'object') return String(v).trim();
  }
  return null;
};
/** Номер браслета как его прислал считыватель: без пробелов, заглавными. */
export const normCode = (v: string | null) => (v ?? '').replace(/\s+/g, '').toUpperCase();
const tail = (code: string) => (code ? `…${code.slice(-4)}` : null);
/** Закрытые шкафчики: «x:y;x:y» (зона:шкаф) или «0», если закрытых нет. */
export const parseCells = (v: string | null) => (!v || v === '0' ? [] : v.split(';').map((x) => x.trim()).filter((x) => x && x !== '0'));

export function parseRequest(b: In) {
  return {
    device: pick(b, ['id', 'device_id', 'deviceId']),
    code: normCode(pick(b, ['uid', 'card', 'cardNumber', 'credential_id'])),
    cells: parseCells(pick(b, ['cells'])),
  };
}

/* ---------- текст на табло считывателя: 5 строк по 16 знаков, перенос — «;» ---------- */
const SHORT: Record<string, string[]> = {
  unknown_card: ['Браслет не', 'зарегистрирован', 'Подойдите', 'на ресепшн'],
  card_replaced: ['Браслет заменён', 'Возьмите новый', 'на ресепшн'],
  card_lost: ['Браслет', 'заблокирован', 'Подойдите', 'на ресепшн'],
  card_blocked: ['Браслет', 'заблокирован', 'Подойдите', 'на ресепшн'],
  no_membership: ['Нет абонемента', 'Подойдите', 'на ресепшн'],
  other_club: ['Абонемент', 'другого клуба', 'Подойдите', 'на ресепшн'],
  expired: ['Абонемент', 'закончился', 'Продлите', 'на ресепшн'],
  frozen: ['Абонемент', 'заморожен', 'Подойдите', 'на ресепшн'],
  not_started: ['Абонемент', 'ещё не начался', 'Подойдите', 'на ресепшн'],
  used_up: ['Посещения', 'закончились', 'Продлите', 'на ресепшн'],
  debt: ['Есть долг', 'Оплатите', 'на ресепшн'],
  unsigned: ['Договор', 'не подписан', 'Подойдите', 'на ресепшн'],
  cancelled: ['Договор', 'расторгнут', 'Подойдите', 'на ресепшн'],
  wrong_time: ['Сейчас не время', 'вашего тарифа', 'Подойдите', 'на ресепшн'],
  club_closed: ['Клуб закрыт'],
  staff_other_club: ['Сотрудник', 'другого клуба'],
  staff_inactive: ['Доступ', 'отключён'],
  point_off: ['Проход закрыт', 'Пройдите через', 'другой турникет'],
  locker: ['Закрыт шкафчик', 'Сдайте ключ', 'на ресепшн'],
};
/** Разбивает фразу на строки до 16 знаков, не больше 5 строк. */
export function screen(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) {
    let cur = '';
    for (const w of l.replace(/;/g, ',').split(/\s+/).filter(Boolean)) {
      const word = w.slice(0, 16);
      if (!cur) cur = word; else if (cur.length + 1 + word.length <= 16) cur += ` ${word}`; else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
  }
  return out.slice(0, 5).join(';');
}
const firstName = (n: string | null) => (n ?? '').trim().split(/\s+/)[0] ?? '';
export function screenText(d: { decision: string; reasonCode: string; reason: string; name: string | null; warn?: string | null }, direction: Direction): string {
  if (d.decision === 'allow') {
    const hello = direction === 'out' ? 'До свидания' : 'Проходите';
    const name = firstName(d.name);
    return screen(d.warn ? [hello, name, 'Есть долг,', 'подойдите', 'на ресепшн'] : name ? [hello, name] : [hello]);
  }
  return screen(SHORT[d.reasonCode] ?? [d.reason]);
}

/* ---------- логика ---------- */
type Conn = { id: string; tenantId: string; clubId: string; settings: PkSettings };

/** Варианты записи номера браслета: как прислали, без ведущих нулей, десятичное число и обратный порядок байт
 * (считыватель на ресепшн и терминал PocketKey часто пишут один и тот же номер по-разному). */
export function codeVariants(code: string): string[] {
  const v = new Set<string>([code]);
  const short = code.replace(/^0+/, '');
  if (short) v.add(short);
  if (/^[0-9A-F]{4,16}$/.test(code)) {
    v.add(BigInt(`0x${code}`).toString(10));
    if (code.length % 2 === 0) v.add(code.match(/../g)!.reverse().join(''));
  }
  return [...v];
}
async function findCode(db: Db, code: string): Promise<string> {
  if (!code) return code;
  for (const x of codeVariants(code)) if (await credentialByCode(db, x)) return x;
  const short = code.replace(/^0+/, '');
  const alt = short ? (await db.query(`select code from access_credentials where ltrim(code, '0') = $1 order by (status = 'active') desc, issued_at desc limit 1`, [short])).rows[0] : null;
  return alt?.code ?? code;
}

type Point = { id: string; name: string; direction: string; isActive: boolean };
/** Устройство CRM по номеру терминала PocketKey. Незнакомый номер заводим сами — администратор потом укажет название и адрес. */
async function pointFor(db: Db, c: Conn, device: string | null): Promise<Point | null> {
  if (!device) return null;
  const ext = device.slice(0, 20);
  const found = (await db.query(`select id, name, direction, is_active as "isActive" from access_points where gateway_id = $1 and external_id = $2`, [c.id, ext])).rows[0];
  if (found) return found;
  return (await db.query(`insert into access_points(tenant_id, club_id, gateway_id, name, direction, external_id) values ($1,$2,$3,$4,'in',$5)
    on conflict (gateway_id, external_id) where external_id is not null do update set external_id = excluded.external_id
    returning id, name, direction, is_active as "isActive"`, [c.tenantId, c.clubId, c.id, `Терминал ${ext}`, ext])).rows[0];
}
/** Направление задаётся устройством: вход или выход (в протоколе PocketKey его нет в запросе). */
const dirFor = (point: { direction: string } | null): Direction => (point?.direction === 'out' ? 'out' : 'in');

async function log(db: Db, c: Conn, op: string, status: string, x: { device?: string | null; code?: string; message?: string | null; ms?: number }) {
  await db.query(`insert into acs_integration_log(tenant_id, club_id, gateway_id, op, status, device, code_tail, message, ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.tenantId, c.clubId, c.id, op, status, x.device?.slice(0, 100) ?? null, x.code ? tail(x.code) : null, x.message?.slice(0, 300) ?? null, x.ms ?? null]);
  // Журнал храним 30 дней
  if (Math.random() < 0.02) await db.query(`delete from acs_integration_log where gateway_id = $1 and at < now() - interval '30 days'`, [c.id]);
}

/** /checkaccess: приложили браслет к терминалу — пускать ли. */
export async function pkCheck(db: Db, c: Conn, body: In) {
  const t0 = Date.now();
  const r = parseRequest(body);
  const pt = await pointFor(db, c, r.device);
  const direction = dirFor(pt);
  const code = await findCode(db, r.code);
  const at = new Date();
  let d = await decide(db, c.clubId, code, direction, at);
  if (pt && !pt.isActive) d = { ...d, decision: 'deny', reasonCode: 'point_off', reason: `Устройство «${pt.name}» выключено в CRM` };
  else if (direction === 'out' && r.cells.length && c.settings.lockerExit === 'deny') {
    d = { ...d, decision: 'deny', reasonCode: 'locker', reason: `Не сдан ключ от шкафчика (${r.cells.join(', ')})` };
  }
  const allow = d.decision === 'allow';
  // Отказ — всегда событие (турникет не открылся). Разрешение — только намерение: проход подтвердит /event,
  // если в настройке не выбрано «считать посещение сразу по разрешению».
  if (!allow || c.settings.visitBy === 'check') {
    await recordEvent(db, c.tenantId, { clubId: c.clubId, pointId: pt?.id ?? null, gatewayId: c.id, at, direction, code: code || null, mode: 'online' }, d);
  }
  const text = screenText(d, direction);
  const note = r.cells.length ? `. Закрытые шкафчики: ${r.cells.join(', ')}` : '';
  await log(db, c, 'check', allow ? 'allow' : 'deny', { device: r.device, code, message: `${d.reason}${note}. На табло: ${text}`, ms: Date.now() - t0 });
  return { client_id: String(d.personId ?? d.userId ?? ''), text, grant_access: allow ? 1 : 0 };
}

/** /event: турникет провернулся — проход состоялся. Повтор того же события ничего не меняет. */
export async function pkEvent(db: Db, c: Conn, body: In) {
  const t0 = Date.now();
  const r = parseRequest(body);
  const pt = await pointFor(db, c, r.device);
  const direction = dirFor(pt);
  const code = await findCode(db, r.code);
  const at = new Date();
  // Номера события в протоколе нет: тот же браслет на том же устройстве в течение минуты — повтор
  // (в том числе проход, уже записанный при проверке в режиме «сразу по разрешению»)
  const seen = (await db.query(`select id from access_events where gateway_id = $1 and point_id is not distinct from $2 and code is not distinct from $3
    and decision = 'allow' and happened_at > now() - interval '60 seconds' limit 1`, [c.id, pt?.id ?? null, code || null])).rows[0];
  if (seen) {
    await log(db, c, 'event', 'duplicate', { device: r.device, code, message: 'Проход уже записан', ms: Date.now() - t0 });
    return { ok: true, duplicate: true, event_id: seen.id };
  }
  const crm = await decide(db, c.clubId, code, direction, at);
  let d = crm;
  if (crm.decision !== 'allow') {
    // Турникет пропустил, хотя CRM бы не пустила (решал сам PocketKey в автономном режиме): проход был — фиксируем его и причину
    const c2 = code ? await credentialByCode(db, code) : null;
    const membershipId = c2?.person_id ? (await holderStatus(db, c.clubId, c2)).membershipId ?? null : null;
    d = { ...crm, decision: 'allow', reasonCode: 'acs_allowed', reason: `Пропустил PocketKey без CRM. По правилам CRM: ${crm.reason}`, membershipId };
  }
  const ev = await recordEvent(db, c.tenantId, { clubId: c.clubId, pointId: pt?.id ?? null, gatewayId: c.id, at, direction, code: code || null, mode: 'online' }, d);
  await log(db, c, 'event', d.reasonCode === 'acs_allowed' ? 'deny' : 'allow', { device: r.device, code, message: d.reason, ms: Date.now() - t0 });
  return { ok: true, duplicate: false, event_id: ev.id, visit: ev.effect };
}

/** /devices: терминалы, с которыми работает PocketKey (включённые и с указанным адресом). */
export async function pkDevices(db: Db, c: Conn) {
  const rows = (await db.query(`select external_id, device_ip, device_port, device_type, biometrics from access_points
    where gateway_id = $1 and is_active and device_ip is not null and external_id ~ '^[0-9]+$' order by external_id::int`, [c.id])).rows;
  const devices = rows.map((x) => ({ id: Number(x.external_id), ip: x.device_ip as string, port: (x.device_port as number | null) ?? PK_PORTS[x.device_type],
    biometrics: !!x.biometrics, config_string: `type=${x.device_type}` }));
  await log(db, c, 'devices', 'ok', { message: `Отдано терминалов: ${devices.length}` });
  return { devices };
}

/** Опознание по браслету (для проверки из окна настройки и для ресепшн): только имя и статус доступа. */
export async function pkIdentify(db: Db, c: Conn, body: In) {
  const r = parseRequest(body);
  const code = await findCode(db, r.code);
  const cred = code ? await credentialByCode(db, code) : null;
  if (!cred) return { found: false, message: REASON_TITLES.unknown_card };
  const h = cred.status === 'active' ? await holderStatus(db, c.clubId, cred) : null;
  return {
    found: true, user_id: cred.person_id ?? cred.user_id, user_type: cred.person_id ? 'client' : 'staff', name: cred.holder_name, code,
    credential_status: cred.status, access_active: !!h?.allow, valid_until: h?.validUntil ?? null,
    message: h ? h.reason : REASON_TITLES[`card_${cred.status}`] ?? 'Браслет не действует',
  };
}

/* ---------- маршруты ---------- */
const publicBase = (req: FastifyRequest) => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.headers.host}`;
/** Адрес сервиса для PocketKey: к нему он сам добавляет /devices, /checkaccess и /event. */
export const pkUrls = (base: string, id: string, token: string) => {
  const service = `${base}/api/pocketkey/${id}/${token}`;
  return { service, ...Object.fromEntries(PK_OPS.map((op) => [op, `${service}/${op}`])) } as { service: string } & Record<(typeof PK_OPS)[number], string>;
};

export function pocketkeyRoutes(app: FastifyInstance, pool: pg.Pool) {
  const sys = (tenantId: string) => ({ tenantId, allClubs: true, clubIds: [] as string[] });

  /* --- запросы от сервера PocketKey: ключ в адресе (так их вписывает специалист PocketKey, как у Fitbase) --- */
  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<Conn | null> => {
    const { id, token } = req.params as { id: string; token: string };
    if (!/^[0-9a-f-]{36}$/i.test(id) || !token) { reply.code(404).send({ error: 'not_found' }); return null; }
    const a = (await pool.query('select * from acs_gateway_by_token($1, $2)', [id, token])).rows[0];
    if (!a || a.kind !== 'pocketkey') { reply.code(401).send({ client_id: '', grant_access: 0, text: 'Ошибка настройки;Подойдите;на ресепшн', error: 'unauthorized' }); return null; }
    const s = (await withCtx(pool, sys(a.tenant_id), (db) => db.query(`update access_gateways set last_seen_at = now() where id = $1 returning settings`, [id]))).rows[0];
    const c: Conn = { id, tenantId: a.tenant_id, clubId: a.club_id, settings: pkSettings(s?.settings) };
    if (c.settings.allowedIps.length && !c.settings.allowedIps.includes(req.ip)) {
      await withCtx(pool, sys(c.tenantId), (db) => log(db, c, 'auth', 'error', { message: `Запрос с чужого адреса ${req.ip}` }));
      reply.code(403).send({ client_id: '', grant_access: 0, text: 'Ошибка настройки;Подойдите;на ресепшн', error: 'forbidden' });
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
      // Ответ в формате PocketKey: «не пускать» с понятным текстом на табло
      return reply.code(known ? status : 503).send({ client_id: '', grant_access: 0, text: known ? 'Ошибка запроса' : 'Нет связи с CRM;Подойдите;на ресепшн', error: msg });
    }
  };

  // Протокол PocketKey: GET-запросы. Старое имя check-access оставлено для совместимости.
  app.get('/api/pocketkey/:id/:token/devices', guard('devices', (db, c) => pkDevices(db, c)));
  for (const path of ['checkaccess', 'check-access']) app.get(`/api/pocketkey/:id/:token/${path}`, guard('check', pkCheck));
  app.get('/api/pocketkey/:id/:token/event', guard('event', pkEvent));
  app.get('/api/pocketkey/:id/:token/health', guard('health', async (db, c) => {
    const club = (await db.query('select name from clubs where id = $1', [c.clubId])).rows[0];
    return { ok: true, service: 'crm', club: club?.name ?? null, time: new Date().toISOString() };
  }));

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
        const devices = (await db.query(`select id, name, direction, external_id as "externalId", is_active as "isActive", device_ip as ip, device_port as port,
          device_type as type, biometrics from access_points where gateway_id = $1 order by nullif(regexp_replace(external_id, '\\D', '', 'g'), '')::int nulls last, name`, [g.id])).rows;
        const journal = (await db.query(`select at, op, status, correlation_id as "correlationId", device, code_tail as "codeTail", message, ms from acs_integration_log
          where gateway_id = $1 order by at desc, id desc limit 50`, [g.id])).rows;
        const stats = (await db.query(`select count(*) filter (where op = 'check')::int as checks, count(*) filter (where op = 'event')::int as events,
            count(*) filter (where status = 'error')::int as errors from acs_integration_log where gateway_id = $1 and at > now() - interval '24 hours'`, [g.id])).rows[0];
        out.push({ ...g, settings: pkSettings(g.settings), devices, journal, stats });
      }
      return { connections: out, unsupported: PK_UNSUPPORTED, ops: PK_OPS, ports: PK_PORTS };
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
    const b = (req.body ?? {}) as { status?: string; visitBy?: string; allowedIps?: string | string[]; name?: string; lockerExit?: string };
    if (b.lockerExit && !['allow', 'deny'].includes(b.lockerExit)) throw badRequest('Выберите, выпускать ли с закрытым шкафчиком');
    if (b.status && !['active', 'disabled'].includes(b.status)) throw badRequest('Неверный статус');
    if (b.visitBy && !['event', 'check'].includes(b.visitBy)) throw badRequest('Выберите, когда считать посещение');
    const ips = b.allowedIps == null ? undefined : (Array.isArray(b.allowedIps) ? b.allowedIps : String(b.allowedIps).split(/[\s,;]+/)).map((x) => x.trim()).filter(Boolean);
    if (ips?.some((x) => !/^[0-9a-f:.]{3,45}$/i.test(x))) throw badRequest('Адреса укажите цифрами через запятую, например 91.200.10.5');
    return withCtx(pool, ctx, async (db) => {
      const g = await connOf(db, id);
      const before = pkSettings(g.settings);
      const after: PkSettings = { visitBy: (b.visitBy as PkSettings['visitBy']) ?? before.visitBy, allowedIps: ips ?? before.allowedIps,
        lockerExit: (b.lockerExit as PkSettings['lockerExit']) ?? before.lockerExit };
      await db.query(`update access_gateways set settings = $2, status = coalesce($3, status), name = coalesce($4, name) where id = $1`,
        [id, JSON.stringify(after), b.status ?? null, b.name?.trim() || null]);
      await audit(db, ctx, 'access.pocketkey_changed', 'club', g.club_id, before, { ...after, status: b.status ?? null });
      return { ok: true, settings: after };
    });
  });

  // Терминалы PocketKey: номер (его PocketKey передаёт в каждом запросе), название, вход или выход, адрес в сети клуба
  type DevIn = { externalId?: string | number; name?: string; direction?: string; isActive?: boolean; ip?: string | null; port?: number | null; type?: string; biometrics?: boolean };
  const checkDev = (b: DevIn) => {
    if (b.direction && !['in', 'out'].includes(b.direction)) throw badRequest('Выберите: вход или выход');
    if (b.type && !PK_PORTS[b.type]) throw badRequest('Выберите вид терминала: Pocketkey или Pocketface');
    if (b.ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(b.ip.trim())) throw badRequest('Адрес терминала укажите цифрами, например 192.168.2.210');
    if (b.port != null && (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535)) throw badRequest('Порт — число от 1 до 65535');
    const ext = b.externalId === undefined ? undefined : String(b.externalId).trim();
    if (ext !== undefined && !/^\d{1,9}$/.test(ext)) throw badRequest('Номер терминала — целое число, например 1');
    return ext;
  };
  app.post('/api/acs/pocketkey/:id/devices', async (req, reply) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as DevIn;
    if (!b.name?.trim()) throw badRequest('Назовите терминал, например «Вход 1»');
    const ext0 = checkDev(b);
    const res = await withCtx(pool, ctx, async (db) => {
      const g = await connOf(db, id);
      const ext = ext0 ?? String((await db.query(`select coalesce(max(external_id::int), 0) + 1 as n from access_points where gateway_id = $1 and external_id ~ '^[0-9]+$'`, [id])).rows[0].n);
      if ((await db.query('select 1 from access_points where gateway_id = $1 and external_id = $2', [id, ext])).rowCount) throw badRequest(`Терминал с номером ${ext} уже есть`);
      const r = (await db.query(`insert into access_points(tenant_id, club_id, gateway_id, name, direction, external_id, device_ip, device_port, device_type, biometrics)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [ctx.tenantId, g.club_id, id, b.name!.trim(), b.direction ?? 'in', ext, b.ip?.trim() || null, b.port ?? null,
        b.type ?? 'pocket', !!b.biometrics])).rows[0];
      await audit(db, ctx, 'access.pocketkey_device_added', 'club', g.club_id, null, { pointId: r.id, externalId: ext });
      return { id: r.id, externalId: ext };
    });
    reply.code(201);
    return res;
  });
  app.patch('/api/acs/pocketkey/:id/devices/:point', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id, point } = req.params as { id: string; point: string };
    const b = (req.body ?? {}) as DevIn;
    const ext = checkDev(b);
    return withCtx(pool, ctx, async (db) => {
      await connOf(db, id);
      if (ext && (await db.query('select 1 from access_points where gateway_id = $1 and external_id = $2 and id <> $3', [id, ext, point])).rowCount) throw badRequest(`Терминал с номером ${ext} уже есть`);
      const r = await db.query(`update access_points set name = coalesce($3, name), direction = coalesce($4, direction), is_active = coalesce($5, is_active),
          external_id = coalesce($6, external_id), device_ip = case when $7 then $8 else device_ip end, device_port = case when $9 then $10::int else device_port end,
          device_type = coalesce($11, device_type), biometrics = coalesce($12, biometrics)
        where id = $1 and gateway_id = $2`,
      [point, id, b.name?.trim() || null, b.direction ?? null, b.isActive ?? null, ext ?? null, b.ip !== undefined, b.ip?.trim() || null, b.port !== undefined, b.port ?? null,
        b.type ?? null, b.biometrics ?? null]);
      if (!r.rowCount) throw notFound('Терминал не найден');
      return { ok: true };
    });
  });

  // Проверка без оборудования: тот же путь, что у запроса от PocketKey, только из окна настройки
  app.post('/api/acs/pocketkey/:id/test', async (req) => {
    const ctx = requirePerm(req, P.acsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { op?: string; device?: string; code?: string; cells?: string };
    const g = await withCtx(pool, ctx, (db) => connOf(db, id));
    const c: Conn = { id, tenantId: ctx.tenantId, clubId: g.club_id, settings: pkSettings(g.settings) };
    const q: In = { id: b.device || '1', uid: b.code ?? '', cells: b.cells || '0' };
    return withCtx(pool, sys(ctx.tenantId), async (db) => {
      if (b.op === 'event') return { op: 'event', response: await pkEvent(db, c, q) };
      if (b.op === 'devices') return { op: 'devices', response: await pkDevices(db, c) };
      if (b.op === 'identify') return { op: 'identify', response: await pkIdentify(db, c, q) };
      return { op: 'checkaccess', response: await pkCheck(db, c, q) };
    });
  });

  // Выгрузка сотрудников клуба для PocketOffice (учёт рабочего времени) — XML в том же виде, что образцы PocketOffice:
  // <HEAD><BODY><Сотрудник>…</Сотрудник></BODY></HEAD>; уволенные — с <ВАрхиве>true</ВАрхиве>.
  app.get('/api/acs/pocketoffice/staff.xml', async (req, reply) => {
    const ctx = requirePerm(req, P.acsManage);
    const { clubId } = req.query as { clubId?: string };
    const rows = await withCtx(pool, ctx, async (db) => {
      if (!clubId || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
      const r = (await db.query(`select u.id, u.login, u.full_name, u.status,
          bool_or(a.active_to is null or a.active_to >= current_date) as working,
          (array_agg(r.code order by r.sort))[1] as dept_code, (array_agg(r.name order by r.sort))[1] as dept_name
        from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code
        where a.club_id = $1 or a.club_id is null group by u.id order by u.full_name`, [clubId])).rows;
      await audit(db, ctx, 'access.pocketoffice_export', 'club', clubId, null, { staff: r.length });
      return r;
    });
    const x = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = rows.map((u) => {
      const archived = u.status !== 'active' || !u.working;
      return ['\t\t<Сотрудник>', `\t\t\t<УникальныйИдентификатор>${x(u.id)}</УникальныйИдентификатор>`, `\t\t\t<Код>${x(u.login)}</Код>`,
        `\t\t\t<Наименование>${x(u.full_name)}</Наименование>`, `\t\t\t<ВАрхиве>${archived}</ВАрхиве>`,
        ...(archived ? [] : [`\t\t\t<КодПодразделения>${x(u.dept_code)}</КодПодразделения>`, `\t\t\t<НаименованиеПодразделения>${x(u.dept_name)}</НаименованиеПодразделения>`]),
        '\t\t</Сотрудник>'].join('\r\n');
    }).join('\r\n');
    const xml = `﻿<?xml version="1.0" encoding="UTF-8"?>\r\n<HEAD>\r\n\t<BODY>\r\n${body}${body ? '\r\n' : ''}\t</BODY>\r\n</HEAD>\r\n`;
    reply.header('content-type', 'application/xml; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="employment_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xml"`);
    return reply.send(xml);
  });
}
