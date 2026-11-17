// Телефония: облачная АТС клуба (первая — OnlinePBX).
//  - АТС присылает события звонков (вебхуки) на адрес с секретом: входящий, ответили, завершён, пропущенный.
//  - Входящий: сотруднику, которому звонят, CRM показывает окно «Звонит клиент» с карточкой.
//  - Пропущенный: задача «Перезвонить» ответственному.
//  - Завершён: CRM сама забирает запись разговора и ставит её в очередь ИИ (расшифровка и итог, шаг 14).
//  - Звонок из карточки: АТС звонит сотруднику на его внутренний номер, затем соединяет с клиентом.
// Вид подключения test — для обучения и проверки без настоящей АТС.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { registerCall } from './ai.ts';
import { saveFile } from './contracts.ts';
import { maskPhone, normalizePhone } from './crm.ts';
import { decrypt, encrypt } from './fiscal.ts';
import { notify } from './salesOps.ts';

type Fetch = typeof fetch;
export class PbxError extends Error {}
export type PbxConn = { id: string; tenant_id: string; club_id: string; kind: 'onlinepbx' | 'test'; domain: string | null; secret: string | null; status: string };

const MAX_AUDIO = 60 * 1024 * 1024;
const MAX_RECORD_ATTEMPTS = 5;
const KINDS: Record<string, string> = { onlinepbx: 'OnlinePBX', test: 'Тестовая АТС (без звонков)' };
// Внутренние номера сотрудников в OnlinePBX: 100–4999
export const isExt = (v: string | null | undefined) => !!v && /^\d{3,4}$/.test(v) && Number(v) >= 100 && Number(v) <= 4999;

/* ---------- OnlinePBX: HTTP API ---------- */
const API = 'https://api2.onlinepbx.ru';
const jsonOf = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; } };
const okStatus = (r: { status?: unknown }) => String(r?.status) === '1';
const keyCache = new Map<string, { auth: string; at: number }>();

/** Ключ сессии API: auth.json по ключу из кабинета (Сервисы → Интеграция → API) */
async function pbxAuth(f: Fetch, c: PbxConn, fresh = false) {
  if (!c.domain) throw new PbxError('Не указан адрес АТС');
  if (!c.secret) throw new PbxError('Не указан ключ API');
  const cached = keyCache.get(c.id);
  if (!fresh && cached && Date.now() - cached.at < 30 * 60_000) return cached.auth;
  const res = await f(`${API}/${c.domain}/auth.json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ auth_key: c.secret }).toString(), signal: AbortSignal.timeout(15_000) });
  const r = await jsonOf(res);
  if (!res.ok || !okStatus(r) || !r.data?.key_id || !r.data?.key) throw new PbxError(`АТС не приняла ключ API${r.comment ? `: ${r.comment}` : ''}`);
  const auth = `${r.data.key_id}:${r.data.key}`;
  keyCache.set(c.id, { auth, at: Date.now() });
  return auth;
}
async function pbxCall(f: Fetch, c: PbxConn, method: string, params: Record<string, string>) {
  for (const fresh of [false, true]) {
    const auth = await pbxAuth(f, c, fresh);
    const res = await f(`${API}/${c.domain}/${method}`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-pbx-authentication': auth },
      body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20_000) });
    const r = await jsonOf(res);
    if (okStatus(r)) return r.data;
    if (!fresh && (res.status === 401 || /auth|key/i.test(String(r.comment ?? r.errorCode ?? '')))) continue; // ключ сессии истёк — берём новый
    throw new PbxError(`АТС: ${r.comment ?? r.errorCode ?? r.raw ?? res.status}`);
  }
  throw new PbxError('АТС не приняла ключ API');
}

/** Проверка подключения. Возвращает сотрудников АТС (внутренние номера), если АТС их отдала */
export async function pbxTest(f: Fetch, c: PbxConn): Promise<{ users: { ext: string; name: string }[] }> {
  if (c.kind === 'test') return { users: [] };
  await pbxAuth(f, c, true);
  try {
    const d = await pbxCall(f, c, 'user/get.json', {});
    const list = Array.isArray(d) ? d : [];
    return { users: list.map((u: Record<string, unknown>) => ({ ext: String(u.num ?? u.number ?? ''), name: String(u.name ?? '') })).filter((u) => isExt(u.ext)) };
  } catch { return { users: [] }; } // список сотрудников — подсказка, без него подключение тоже работает
}

/** Звонок из CRM: АТС звонит на внутренний номер сотрудника, после ответа — клиенту */
export async function pbxOriginate(f: Fetch, c: PbxConn, ext: string, phone: string) {
  if (c.kind === 'test') return { uuid: `test-${Date.now()}` };
  const d = await pbxCall(f, c, 'call/now.json', { from: ext, to: phone.replace(/^\+/, '') });
  return { uuid: d?.uuid ? String(d.uuid) : null };
}

/* ---------- события АТС ---------- */
export type PbxEvent = { event: string; uuid: string; direction: 'in' | 'out' | 'local' | null; phone: string | null; ext: string | null; at: Date;
  talkSec: number | null; downloadUrl: string | null };

/** Разбор вебхука OnlinePBX (POST application/x-www-form-urlencoded) */
export function parsePbxEvent(body: Record<string, unknown>): PbxEvent | null {
  const s = (k: string) => (body[k] === undefined || body[k] === null ? null : String(body[k]).trim() || null);
  const event = s('event'); const uuid = s('uuid');
  if (!event || !uuid) return null;
  const dir = s('direction');
  const direction = dir === 'inbound' ? 'in' : dir === 'outbound' ? 'out' : dir === 'local' ? 'local' : null;
  const caller = s('caller'); const callee = s('callee');
  // Входящий: звонит клиент (caller), отвечает сотрудник (callee). Исходящий — наоборот
  const [client, staff] = direction === 'in' ? [caller, callee] : [callee, caller];
  const date = Number(s('date'));
  const talk = Number(s('dialog_duration'));
  return { event, uuid, direction, phone: normalizePhone(client), ext: isExt(staff) ? staff : null,
    at: Number.isFinite(date) && date > 1e9 ? new Date(date * 1000) : new Date(),
    talkSec: Number.isFinite(talk) ? Math.round(talk) : null, downloadUrl: s('download_url') };
}

async function personByPhone(db: Db, phone: string | null, clubId: string) {
  if (!phone) return null;
  return (await db.query(
    `select pc.person_id as id, p.full_name from person_contacts pc join persons p on p.id = pc.person_id
     where pc.type = 'phone' and pc.normalized_value = $1 order by (p.home_club_id = $2) desc, p.created_at desc limit 1`, [phone, clubId])).rows[0] as { id: string; full_name: string } | undefined ?? null;
}
const userOfExt = async (db: Db, clubId: string, ext: string | null) =>
  ext ? ((await db.query(`select user_id from pbx_extensions where club_id = $1 and ext = $2`, [clubId, ext])).rows[0]?.user_id as string | undefined) ?? null : null;

/** Кому перезванивать по пропущенному: ведущий сделки → сотрудник, кому звонили → менеджеры и РОП клуба */
async function missedAssignees(db: Db, clubId: string, personId: string | null, userId: string | null) {
  if (personId) {
    const o = (await db.query(`select owner_id from opportunities where person_id = $1 and club_id = $2 and status = 'open' and owner_id is not null order by created_at desc limit 1`, [personId, clubId])).rows[0];
    if (o) return [o.owner_id as string];
  }
  if (userId) return [userId];
  return (await db.query(
    `select distinct a.user_id from user_assignments a join users u on u.id = a.user_id
     where a.club_id = $1 and a.role_code in ('manager', 'rop') and u.status = 'active'
       and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`, [clubId])).rows.map((r) => r.user_id as string);
}

export async function handlePbxEvent(db: Db, conn: { id: string; tenant_id: string; club_id: string }, ev: PbxEvent) {
  if (ev.direction === 'local') return { skipped: 'local' };
  const clubId = conn.club_id;
  const person = await personByPhone(db, ev.phone, clubId);
  const userId = await userOfExt(db, clubId, ev.ext);
  const seen = (await db.query(`select event, record_status from pbx_events where connection_id = $1 and uuid = $2`, [conn.id, ev.uuid])).rows;
  // Запись забираем один раз на звонок (при дозвоне на группу АТС присылает «завершён» по каждому сотруднику)
  const wantRecord = ev.event === 'call_end' && !!ev.downloadUrl && (ev.talkSec ?? 1) > 0 && !seen.some((r) => r.record_status);
  await db.query(
    `insert into pbx_events(tenant_id, club_id, connection_id, uuid, event, direction, phone, ext, user_id, person_id, at, payload, record_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [conn.tenant_id, clubId, conn.id, ev.uuid, ev.event, ev.direction, ev.phone, ev.ext, userId, person?.id ?? null, ev.at,
      JSON.stringify({ talkSec: ev.talkSec, downloadUrl: ev.downloadUrl }), wantRecord ? 'pending' : null]);
  await db.query(`update pbx_connections set last_event_at = now() where id = $1`, [conn.id]);

  if (ev.event === 'call_missed' && ev.direction === 'in' && ev.phone && !seen.some((r) => r.event === 'call_missed' || r.event === 'call_answered')) {
    const who = person?.full_name ?? maskPhone(ev.phone);
    const to = await missedAssignees(db, clubId, person?.id ?? null, userId);
    if (to.length) {
      await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at) values ($1,$2,$3,$4,'call',$5, now() + interval '15 minutes')`,
        [conn.tenant_id, clubId, to[0], person?.id ?? null, `Перезвонить: пропущенный звонок от ${who}${person ? '' : ` (${ev.phone})`}`]);
      await notify(db, clubId, to, 'pbx_missed', 'Пропущенный звонок', `${who} · перезвоните в течение 15 минут`, person ? { tab: 'tasks', p: { person: person.id } } : { tab: 'tasks' });
    }
    return { missed: true };
  }
  return { recorded: wantRecord };
}

/* ---------- загрузка записей разговоров ---------- */
const AUDIO_SIG: [string, string, (b: Buffer) => boolean][] = [
  ['audio/mpeg', 'mp3', (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  ['audio/wav', 'wav', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE'],
  ['audio/ogg', 'ogg', (b) => b.subarray(0, 4).toString('latin1') === 'OggS'],
];

async function downloadRecord(f: Fetch, url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new PbxError('Неверная ссылка на запись'); }
  if (u.protocol !== 'https:') throw new PbxError('Ссылка на запись должна быть https');
  const res = await f(u, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new PbxError(`АТС не отдала запись: ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_AUDIO) throw new PbxError('Запись больше 60 МБ');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_AUDIO) throw new PbxError('Запись больше 60 МБ');
  const t = AUDIO_SIG.find(([, , test]) => buf.length > 16 && test(buf));
  if (!t) throw new PbxError('По ссылке не запись разговора');
  return { buf, mime: t[0], ext: t[1] };
}

/** Ссылка из вебхука живёт сутки. Если её нет или она не открылась — просим АТС выдать запись по номеру звонка */
async function freshRecordUrl(f: Fetch, c: PbxConn, uuid: string) {
  if (c.kind !== 'onlinepbx') return null;
  const d = await pbxCall(f, c, 'mongo_history/search.json', { uuid, download: '1' });
  return typeof d === 'string' && d.startsWith('https://') ? d : null;
}

export async function processPbxRecords(pool: pg.Pool, storage: string, f: Fetch, aiOn: boolean) {
  const tenants = (await pool.query('select tenant_id from pbx_tenants()')).rows.map((r) => r.tenant_id as string);
  let done = 0;
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] as string[] };
    const rows = await withCtx(pool, sys, async (db) => (await db.query(
      `select e.*, c.kind, c.domain, c.secret_enc, c.status as conn_status from pbx_events e join pbx_connections c on c.id = e.connection_id
       where e.record_status = 'pending' and e.created_at > now() - interval '3 days'
         and e.created_at < now() - make_interval(secs => 20 * e.record_attempts * e.record_attempts)
       order by e.created_at limit 10`)).rows);
    for (const e of rows) {
      const conn: PbxConn = { id: e.connection_id, tenant_id: tenantId, club_id: e.club_id, kind: e.kind, domain: e.domain, secret: e.secret_enc ? decrypt(e.secret_enc) : null, status: e.conn_status };
      try {
        let url: string | null = e.payload?.downloadUrl ?? null;
        let rec;
        try { rec = await downloadRecord(f, url!); } catch (err) {
          url = await freshRecordUrl(f, conn, e.uuid).catch(() => null);
          if (!url) throw err;
          rec = await downloadRecord(f, url);
        }
        await withCtx(pool, sys, async (db) => {
          const actor = { tenantId, userId: null };
          const file = await saveFile(db, storage, actor, e.club_id, 'call_record', { ...rec, name: `${e.direction === 'in' ? 'in' : 'out'}-${e.phone ?? 'unknown'}-${e.uuid}.${rec.ext}` });
          const startedAt = new Date(new Date(e.at).getTime() - (e.payload?.talkSec ?? 0) * 1000);
          const r = await registerCall(db, actor, {
            clubId: e.club_id, userId: e.user_id ?? null, personId: e.person_id ?? null, phone: e.phone, startedAt: startedAt.toISOString(),
            direction: e.direction === 'in' ? 'in' : 'out', durationSec: e.payload?.talkSec ?? null, source: 'pbx', externalId: `pbx:${e.uuid}`, fileId: file.id, aiOn,
          });
          await db.query(`update pbx_events set record_status = 'done', call_id = $2, record_error = null where id = $1`, [e.id, r.id]);
        });
        done++;
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        await withCtx(pool, sys, (db) => db.query(
          `update pbx_events set record_attempts = record_attempts + 1, record_error = $2,
             record_status = case when record_attempts + 1 >= $3 then 'failed' else 'pending' end where id = $1`, [e.id, msg, MAX_RECORD_ATTEMPTS]));
      }
    }
  }
  return done;
}

export function startPbxWorker(pool: pg.Pool, storage: string, f: Fetch, aiOn: boolean, everyMs = 20_000) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processPbxRecords(pool, storage, f, aiOn); } catch (e) { console.error('Телефония:', (e as Error).message); } finally { busy = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/* ---------- звонок из карточки ---------- */
/** Подключение АТС, через которое звонит сотрудник: клуб клиента, иначе любой клуб, где у сотрудника есть внутренний номер */
export async function pbxForDial(db: Db, ctx: Ctx, personId: string) {
  const r = (await db.query(
    `select c.id, c.tenant_id, c.club_id, c.kind, c.domain, c.secret_enc, c.status, x.ext
     from pbx_extensions x join pbx_connections c on c.club_id = x.club_id and c.status = 'active'
     where x.user_id = $1
     order by (c.club_id = (select home_club_id from persons where id = $2)) desc limit 1`, [ctx.userId, personId])).rows[0];
  if (!r) return null;
  return { conn: { id: r.id, tenant_id: r.tenant_id, club_id: r.club_id, kind: r.kind, domain: r.domain, secret: r.secret_enc ? decrypt(r.secret_enc) : null, status: r.status } as PbxConn, ext: r.ext as string };
}

/* ---------- маршруты ---------- */
const CONN_SELECT = `select id, club_id as "clubId", kind, domain, secret_enc is not null as "hasKey", status, last_error as "lastError", last_ok_at as "lastOkAt",
  last_event_at as "lastEventAt", webhook_token as "webhookToken" from pbx_connections`;

async function loadConn(db: Db, id: string): Promise<PbxConn> {
  const c = (await db.query(`select * from pbx_connections where id = $1`, [id])).rows[0];
  if (!c) throw notFound('Подключение АТС не найдено');
  return { id: c.id, tenant_id: c.tenant_id, club_id: c.club_id, kind: c.kind, domain: c.domain, secret: c.secret_enc ? decrypt(c.secret_enc) : null, status: c.status };
}

export function telephonyRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;
  const base = (req: { protocol: string; headers: Record<string, unknown> }) => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.headers.host}`;
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 20_000 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  }

  // Настройки телефонии клуба: подключение, адрес для событий, внутренние номера сотрудников
  app.get('/api/pbx', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query(`select 1 from clubs where id = $1`, [clubId ?? null])).rowCount) throw notFound('Клуб не найден');
      const c = (await db.query(`${CONN_SELECT} where club_id = $1`, [clubId])).rows[0] ?? null;
      const staff = (await db.query(
        `select distinct on (u.id) u.id, u.full_name as name, a.role_code as role, x.ext from user_assignments a join users u on u.id = a.user_id
         left join pbx_extensions x on x.club_id = a.club_id and x.user_id = u.id
         where a.club_id = $1 and u.status = 'active' and (a.active_to is null or a.active_to >= current_date) order by u.id, a.role_code`, [clubId])).rows
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
      return { kinds: KINDS, connection: c ? { ...c, webhookToken: undefined, webhookUrl: `${base(req)}/api/hooks/pbx/${c.id}/${c.webhookToken}` } : null, staff };
    });
  });

  app.put('/api/pbx', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const b = (req.body ?? {}) as { clubId?: string; kind?: string; domain?: string; apiKey?: string; status?: string };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!KINDS[b.kind ?? '']) throw badRequest('Выберите АТС');
    const domain = (b.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
    if (b.kind === 'onlinepbx' && !(domain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))) throw badRequest('Укажите адрес АТС, например pbx12345.onpbx.ru');
    if (b.status && !['active', 'disabled'].includes(b.status)) throw badRequest('Неверное состояние');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query(`select 1 from clubs where id = $1`, [b.clubId])).rowCount) throw notFound('Клуб не найден');
      const before = (await db.query(`select id, kind, domain, status, secret_enc is not null as has_key from pbx_connections where club_id = $1`, [b.clubId])).rows[0] ?? null;
      if (b.kind === 'onlinepbx' && !b.apiKey?.trim() && !before?.has_key) throw badRequest('Вставьте ключ API из кабинета OnlinePBX');
      const key = b.apiKey?.trim() ? encrypt(b.apiKey.trim()) : null;
      const id = (await db.query(
        `insert into pbx_connections(tenant_id, club_id, kind, domain, secret_enc, webhook_token, status, created_by) values ($1,$2,$3,$4,$5,$6,coalesce($7,'active'),$8)
         on conflict (club_id) do update set kind = excluded.kind, domain = excluded.domain, secret_enc = coalesce($5, pbx_connections.secret_enc),
           status = coalesce($7, pbx_connections.status), last_error = null, updated_at = now() returning id`,
        [ctx.tenantId, b.clubId, b.kind, domain, key, randomBytes(18).toString('base64url'), b.status ?? null, ctx.userId])).rows[0].id as string;
      keyCache.delete(id);
      await audit(db, ctx, 'pbx.saved', 'pbx_connection', id, before, { kind: b.kind, domain, status: b.status ?? before?.status ?? 'active', keyChanged: !!key });
      return { id };
    });
  });

  app.post('/api/pbx/:id/test', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadConn(db, id);
      try {
        const r = await pbxTest(f, c);
        await db.query(`update pbx_connections set last_ok_at = now(), last_error = null where id = $1`, [id]);
        return { ok: true, info: c.kind === 'test' ? 'Тестовая АТС подключена' : `АТС на связи${r.users.length ? `, сотрудников в АТС: ${r.users.length}` : ''}`, users: r.users };
      } catch (e) {
        const msg = e instanceof PbxError ? e.message : 'Нет связи с АТС';
        await db.query(`update pbx_connections set last_error = $2 where id = $1`, [id, msg]);
        return { ok: false, info: msg, users: [] };
      }
    });
  });

  app.put('/api/pbx/:id/extensions', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const { id } = req.params as { id: string };
    const items = ((req.body ?? {}) as { items?: { userId?: string; ext?: string }[] }).items ?? [];
    const clean = items.map((i) => ({ userId: i.userId ?? '', ext: String(i.ext ?? '').trim() })).filter((i) => i.userId && i.ext);
    for (const i of clean) if (!isExt(i.ext)) throw badRequest(`Внутренний номер ${i.ext}: нужен номер сотрудника АТС от 100 до 4999`);
    if (new Set(clean.map((i) => i.ext)).size !== clean.length) throw badRequest('Один внутренний номер указан у двух сотрудников');
    return withCtx(pool, ctx, async (db) => {
      const c = await loadConn(db, id);
      const before = (await db.query(`select user_id, ext from pbx_extensions where club_id = $1`, [c.club_id])).rows;
      await db.query(`delete from pbx_extensions where club_id = $1`, [c.club_id]);
      for (const i of clean) {
        if (!(await db.query(`select 1 from user_assignments where user_id = $1 and club_id = $2`, [i.userId, c.club_id])).rowCount) throw badRequest('Сотрудник не работает в этом клубе');
        await db.query(`insert into pbx_extensions(tenant_id, club_id, ext, user_id) values ($1,$2,$3,$4)`, [ctx.tenantId, c.club_id, i.ext, i.userId]);
      }
      await audit(db, ctx, 'pbx.extensions', 'pbx_connection', id, before, clean);
      return { ok: true, count: clean.length };
    });
  });

  // Тестовая АТС: имитация звонка (для обучения и проверки окна входящего и пропущенных)
  app.post('/api/pbx/:id/simulate', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { event?: string; phone?: string; ext?: string; direction?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadConn(db, id);
      if (c.kind !== 'test') throw badRequest('Имитировать звонок можно только на тестовой АТС');
      const phone = normalizePhone(b.phone);
      if (!phone) throw badRequest('Укажите телефон клиента');
      const ev = parsePbxEvent({ event: b.event ?? 'call_user_start', uuid: `sim-${Date.now()}`, direction: b.direction === 'outbound' ? 'outbound' : 'inbound',
        caller: b.direction === 'outbound' ? b.ext : phone, callee: b.direction === 'outbound' ? phone : b.ext, date: Math.floor(Date.now() / 1000) })!;
      return handlePbxEvent(db, c, ev);
    });
  });

  // Окно «Звонит клиент»: входящие звонки сотруднику за последние 2 минуты, которые ещё не закончились
  app.get('/api/pbx/live', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query(`select 1 from pbx_extensions where user_id = $1`, [ctx.userId])).rowCount) return { enabled: false, calls: [] };
      const rows = (await db.query(
        `select distinct on (e.uuid) e.uuid, e.phone, e.person_id as "personId", p.full_name as "personName", e.at, e.created_at as "createdAt",
           exists (select 1 from pbx_events z where z.connection_id = e.connection_id and z.uuid = e.uuid and z.event = 'call_answered') as answered
         from pbx_events e left join persons p on p.id = e.person_id
         where e.user_id = $1 and e.direction = 'in' and e.event in ('call_user_start', 'call_start', 'call_answered') and e.created_at > now() - interval '2 minutes'
           and not exists (select 1 from pbx_events z where z.connection_id = e.connection_id and z.uuid = e.uuid and z.event in ('call_end', 'call_missed'))
         order by e.uuid, e.created_at desc`, [ctx.userId])).rows;
      return { enabled: true, calls: rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })) };
    });
  });

  // События от АТС. Адрес содержит секрет подключения; АТС ждёт ответ до 90 секунд и повторяет запрос дважды
  app.post('/api/hooks/pbx/:id/:token', async (req, reply) => {
    const { id, token } = req.params as { id: string; token: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: 'not_found' });
    const auth = (await pool.query('select * from pbx_connection_by_token($1, $2)', [id, token])).rows[0];
    if (!auth) return reply.code(404).send({ error: 'not_found' });
    const ev = parsePbxEvent((req.body ?? {}) as Record<string, unknown>);
    if (!ev) return { ok: true, skipped: true }; // тестовый запрос из кабинета АТС
    return withCtx(pool, { tenantId: auth.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const r = await handlePbxEvent(db, { id, tenant_id: auth.tenant_id, club_id: auth.club_id }, ev);
      return { ok: true, ...r };
    });
  });
}
