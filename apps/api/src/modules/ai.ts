// Шаг 14. Записи разговоров → расшифровка → резюме в карточку (FR-AI-01, 02), контроль заполнения (FR-AI-03), оценка качества.
// Правило «ИИ только предлагает»: резюме — черновик с пометкой «ИИ», в карточку его переносит менеджер.
// Если менеджер не успел за N часов (настройка клуба), система переносит черновик сама и сообщает РОПу.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { guardExport } from './privacy.ts';
import { aiHealth, aiSummarize, aiTranscribe, editRatio, MINOR_EDIT, normalizeSummary, summaryText, type AiConfig, type Summary, type Transcript } from '../lib/aiClient.ts';
import { saveFile } from './contracts.ts';
import { maskPhone, normalizePhone } from './crm.ts';
import { sendTable } from './dash.ts';
import type { Table } from '../lib/xlsx.ts';

type Actor = { tenantId: string; userId: string | null; ip?: string };
const MAX_AUDIO = 60 * 1024 * 1024;
const AUDIO_LIMIT = { bodyLimit: Math.ceil(MAX_AUDIO * 1.37) + 4096 };
const MAX_ATTEMPTS = 3;
const SHORT_WORDS = 12;   // разговор короче — итог не нужен (недозвон, автоответчик, «перезвоню»)
const onlyMine = (ctx: Ctx) => !can(ctx, P.crmViewAll);

/* ---------- файл записи ---------- */
const AUDIO: [string, string, (b: Buffer) => boolean][] = [
  ['audio/mpeg', 'mp3', (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  ['audio/wav', 'wav', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE'],
  ['audio/ogg', 'ogg', (b) => b.subarray(0, 4).toString('latin1') === 'OggS'],
  ['audio/mp4', 'm4a', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'],
  ['audio/webm', 'webm', (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  ['audio/flac', 'flac', (b) => b.subarray(0, 4).toString('latin1') === 'fLaC'],
];
function decodeAudio(fileName: string | undefined, dataBase64: string | undefined) {
  if (!dataBase64) throw badRequest('Файл не передан');
  const buf = Buffer.from(dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
  if (buf.length < 16) throw badRequest('Файл пустой');
  if (buf.length > MAX_AUDIO) throw badRequest('Запись больше 60 МБ');
  const t = AUDIO.find(([, , test]) => test(buf));
  if (!t) throw badRequest('Нужна запись разговора: MP3, WAV, OGG, M4A, WEBM или FLAC');
  return { buf, mime: t[0], ext: t[1], name: (fileName || `запись.${t[1]}`).slice(0, 200) };
}

/** Из имени файла АТС: телефон, дата-время (местное время клуба), направление. Например «out-79001234567-20261110-143512.mp3» */
export function parseRecordName(name: string) {
  let s = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const dm = s.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[ T_-]{0,3}([01]\d|2[0-3])[-_.:]?([0-5]\d)(?:[-_.:]?([0-5]\d))?/);
  let local: string | null = null;
  if (dm) {
    local = `${dm[1]}-${dm[2]}-${dm[3]} ${dm[4]}:${dm[5]}:${dm[6] ?? '00'}`;
    s = s.replace(dm[0], ' ');
  }
  let phone: string | null = null;
  for (const run of s.match(/\+?\d[\d\s()-]{8,16}\d/g) ?? []) { phone = normalizePhone(run); if (phone) break; }
  const low = s.toLowerCase();
  const direction = /(^|[^a-zа-я])(in|incoming|inbound|вход\p{L}*)([^a-zа-я]|$)/u.test(low) ? 'in' : /(^|[^a-zа-я])(out|outgoing|outbound|исход\p{L}*)([^a-zа-я]|$)/u.test(low) ? 'out' : null;
  return { phone, local, direction: direction as 'in' | 'out' | null };
}

/* ---------- задачи по звонку ---------- */
async function callInfo(db: Db, id: string) {
  return (await db.query(
    `select c.*, p.full_name as person_name, u.full_name as user_name, cl.name as club_name, cl.timezone,
       coalesce(st.fill_control_hours, 2) as hours
     from calls c join clubs cl on cl.id = c.club_id left join persons p on p.id = c.person_id left join users u on u.id = c.user_id
     left join ai_settings st on st.club_id = c.club_id where c.id = $1`, [id])).rows[0];
}

async function addCallTask(db: Db, tenantId: string, c: { id: string; club_id: string; person_id: string | null }, assignee: string, title: string, dueAt: Date) {
  await db.query(
    `insert into tasks(tenant_id, club_id, assignee_id, person_id, call_id, kind, title, due_at) values ($1,$2,$3,$4,$5,'other',$6,$7)`,
    [tenantId, c.club_id, assignee, c.person_id, c.id, title.slice(0, 300), dueAt]);
}

async function ropsOf(db: Db, clubId: string) {
  const rows = (await db.query(
    `select distinct a.user_id, a.role_code from user_assignments a join users u on u.id = a.user_id
     where a.club_id = $1 and a.role_code in ('rop', 'gm') and u.status = 'active' and (a.active_to is null or a.active_to >= current_date)`, [clubId])).rows;
  const rops = rows.filter((r) => r.role_code === 'rop');
  return (rops.length ? rops : rows).map((r) => r.user_id as string);
}

/** Следующий шаг из итога разговора → задача в сделке (или по клиенту) */
async function nextStepTask(db: Db, tenantId: string, c: { id: string; club_id: string; person_id: string | null; opportunity_id: string | null; user_id: string | null }, s: Summary, actorId: string | null) {
  if (!s.nextStep?.dueAt) return null;
  const o = c.opportunity_id ? (await db.query(`select id, owner_id, status from opportunities where id = $1`, [c.opportunity_id])).rows[0] : null;
  const assignee = (o?.status === 'open' ? o.owner_id : null) ?? c.user_id ?? actorId;
  if (!assignee) return null;
  return (await db.query(
    `insert into tasks(tenant_id, club_id, assignee_id, person_id, opportunity_id, call_id, kind, title, due_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [tenantId, c.club_id, assignee, c.person_id, o?.status === 'open' ? o.id : null, c.id, s.nextStep.kind, s.nextStep.title, s.nextStep.dueAt, actorId])).rows[0].id as string;
}

const closeManagerTasks = (db: Db, callId: string, userId: string | null, result: string) =>
  db.query(`update tasks set done_at = now(), result = $3 where call_id = $1 and done_at is null and assignee_id is not distinct from $2 and opportunity_id is null and kind = 'other'`, [callId, userId, result]);

/* ---------- регистрация звонка ---------- */
export async function registerCall(db: Db, actor: Actor, b: {
  clubId: string; userId: string | null; personId?: string | null; phone?: string | null; startedAt?: string | null; startedLocal?: string | null;
  direction?: 'in' | 'out' | null; durationSec?: number | null; source: 'upload' | 'pbx' | 'demo'; externalId?: string | null; fileId?: string | null;
  transcript?: Transcript | null; aiOn: boolean;
}) {
  if (b.externalId) {
    const dup = (await db.query(`select id from calls where club_id = $1 and external_id = $2`, [b.clubId, b.externalId])).rows[0];
    if (dup) return { id: dup.id as string, duplicate: true };
  }
  let personId = b.personId ?? null;
  if (!personId && b.phone) {
    personId = (await db.query(
      `select pc.person_id from person_contacts pc join persons p on p.id = pc.person_id
       where pc.type = 'phone' and pc.normalized_value = $1 order by (p.home_club_id = $2) desc, p.created_at desc limit 1`, [b.phone, b.clubId])).rows[0]?.person_id ?? null;
  }
  const opp = personId ? (await db.query(
    `select id, owner_id from opportunities where person_id = $1 and club_id = $2 order by (status = 'open') desc, created_at desc limit 1`, [personId, b.clubId])).rows[0] : null;
  const startedAt = b.startedAt ? new Date(b.startedAt) : null;
  const status = b.transcript ? 'queued' : !b.fileId ? 'no_audio' : b.aiOn ? 'queued' : 'waiting_ai';
  const id = (await db.query(
    `insert into calls(tenant_id, club_id, person_id, opportunity_id, user_id, direction, phone, started_at, duration_sec, source, external_id, file_id, transcript, asr_status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,
       coalesce($8::timestamptz, ($9::timestamp at time zone (select timezone from clubs where id = $2)), now()),
       $10,$11,$12,$13,$14,$15,$16) returning id, started_at`,
    [actor.tenantId, b.clubId, personId, opp?.id ?? null, b.userId ?? opp?.owner_id ?? actor.userId, b.direction ?? 'out', b.phone ?? null,
      startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt.toISOString() : null, b.startedLocal ?? null, b.durationSec ?? b.transcript?.durationSec ?? null,
      b.source, b.externalId ?? null, b.fileId ?? null, b.transcript ? JSON.stringify(b.transcript) : null, status, actor.userId])).rows[0];
  // Разговор с новым лидом — это первый ответ
  if (personId) await db.query(`update leads set first_response_at = $3 where person_id = $1 and club_id = $2 and first_response_at is null and created_at <= $3`, [personId, b.clubId, id.started_at]);
  await audit(db, actor, 'call.registered', 'call', id.id, null, { source: b.source, personId, status });
  return { id: id.id as string, duplicate: false, personId, status };
}

/* ---------- обработка очереди ИИ ---------- */
function localStamp(d: Date, tz: string) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(d);
}

async function processCall(pool: pg.Pool, sys: Pick<Ctx, 'tenantId' | 'allClubs' | 'clubIds'>, ai: AiConfig, storage: string, id: string) {
  const c = await withCtx(pool, sys, async (db) => {
    const r = (await db.query(`update calls set asr_status = 'processing', attempts = attempts + 1, next_try_at = now() + interval '30 minutes'
      where id = $1 and asr_status = 'queued' returning id`, [id])).rows[0];
    return r ? callInfo(db, id) : null;
  });
  if (!c) return;
  const actor = { tenantId: sys.tenantId, userId: null };
  try {
    let tr = c.transcript as (Transcript & { engine?: string }) | null;
    let asrEngine = c.engine as string | null;
    if (!tr) {
      const f = await withCtx(pool, sys, async (db) => (await db.query(`select storage_path, original_name, mime from files where id = $1`, [c.file_id])).rows[0]);
      if (!f) throw new Error('Файл записи не найден');
      const r = await aiTranscribe(ai, readFileSync(join(storage, f.storage_path)), f.original_name, f.mime);
      tr = { text: String(r.text ?? ''), segments: Array.isArray(r.segments) ? r.segments : [], language: r.language, durationSec: r.durationSec };
      asrEngine = r.engine;
      await withCtx(pool, sys, (db) => db.query(`update calls set transcript = $2, duration_sec = coalesce(duration_sec, $3), engine = $4 where id = $1`,
        [id, JSON.stringify(tr), r.durationSec ? Math.round(r.durationSec) : null, r.engine ?? null]));
    }
    const words = tr.text.split(/\s+/).filter(Boolean).length;
    if (words < SHORT_WORDS) {
      await withCtx(pool, sys, (db) => db.query(`update calls set asr_status = 'done', asr_error = null where id = $1`, [id]));
      return;
    }
    const startedAt = new Date(c.started_at);
    const r = await aiSummarize(ai, tr, {
      clubName: c.club_name, managerName: c.user_name, clientName: c.person_name, direction: c.direction,
      callTime: localStamp(startedAt, c.timezone), now: new Date().toISOString(), timezone: c.timezone,
    });
    const s = normalizeSummary(r.summary);
    const conf = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : null;
    await withCtx(pool, sys, async (db) => {
      const engine = [asrEngine, r.engine].filter(Boolean).join(' + ');
      await db.query(`update calls set asr_status = 'done', asr_error = null, engine = $2 where id = $1`, [id, engine || null]);
      const ins = await db.query(
        `insert into call_summaries(tenant_id, club_id, call_id, draft, engine, confidence, status) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (call_id) do nothing returning id`,
        [sys.tenantId, c.club_id, id, s ? JSON.stringify(s) : null, r.engine ?? null, conf, s ? 'draft' : 'needs_manual']);
      if (!ins.rowCount) return;
      const due = new Date(Date.now() + Number(c.hours) * 3600_000);
      const who = c.person_name ?? (c.phone ? maskPhone(c.phone) : 'клиентом');
      if (c.user_id) await addCallTask(db, sys.tenantId, c, c.user_id, s ? `Проверьте итог разговора с ${who} (черновик ИИ)` : `ИИ не смог составить итог разговора с ${who}: напишите его сами`, due);
      await audit(db, actor, s ? 'ai.summary_drafted' : 'ai.summary_failed', 'call', id, null, { engine: r.engine, confidence: conf, reason: s ? undefined : r.reason ?? 'данных недостаточно' });
    });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await withCtx(pool, sys, async (db) => {
      if (c.attempts < MAX_ATTEMPTS) {
        await db.query(`update calls set asr_status = 'queued', asr_error = $2, next_try_at = now() + make_interval(mins => $3) where id = $1`, [id, msg, 2 ** c.attempts]);
        return;
      }
      await db.query(`update calls set asr_status = 'failed', asr_error = $2 where id = $1`, [id, msg]);
      const ins = await db.query(`insert into call_summaries(tenant_id, club_id, call_id, status) values ($1,$2,$3,'needs_manual') on conflict (call_id) do nothing`, [sys.tenantId, c.club_id, id]);
      if (ins.rowCount && c.user_id) {
        const who = c.person_name ?? (c.phone ? maskPhone(c.phone) : 'клиентом');
        await addCallTask(db, sys.tenantId, c, c.user_id, `Запись разговора с ${who} не распозналась: напишите итог вручную`, new Date(Date.now() + Number(c.hours) * 3600_000));
      }
      await audit(db, actor, 'ai.asr_failed', 'call', id, null, { error: msg });
    });
  }
}

/** Контроль заполнения (FR-AI-03): черновик не подтверждён за N часов → переносим в карточку и сообщаем РОПу */
export async function fillControl(db: Db, tenantId: string) {
  const actor = { tenantId, userId: null };
  const rows = (await db.query(
    `select s.id as summary_id, s.status, s.draft, c.id, c.club_id, c.person_id, c.opportunity_id, c.user_id, c.phone, p.full_name as person_name, u.full_name as user_name
     from call_summaries s join calls c on c.id = s.call_id left join ai_settings st on st.club_id = c.club_id
     left join persons p on p.id = c.person_id left join users u on u.id = c.user_id
     where s.status in ('draft', 'needs_manual') and s.rop_notified_at is null
       and s.created_at < now() - make_interval(hours => coalesce(st.fill_control_hours, 2))
     order by s.created_at limit 100`)).rows;
  for (const r of rows) {
    const who = r.person_name ?? (r.phone ? maskPhone(r.phone) : 'клиентом');
    const mgr = r.user_name ?? 'Менеджер';
    if (r.status === 'draft') {
      await db.query(`update call_summaries set status = 'auto_applied', final = draft, confirmed_at = now(), rop_notified_at = now() where id = $1`, [r.summary_id]);
      await nextStepTask(db, tenantId, r, r.draft as Summary, null);
      await closeManagerTasks(db, r.id, r.user_id, 'Не проверено вовремя: ИИ перенёс черновик в карточку');
    } else {
      await db.query(`update call_summaries set rop_notified_at = now() where id = $1`, [r.summary_id]);
    }
    const title = r.status === 'draft'
      ? `${mgr} не проверил итог разговора с ${who}: ИИ перенёс черновик в карточку, проверьте`
      : `${mgr} не написал итог разговора с ${who}`;
    for (const rop of await ropsOf(db, r.club_id)) if (rop !== r.user_id) await addCallTask(db, tenantId, r, rop, title, new Date(Date.now() + 4 * 3600_000));
    await audit(db, actor, r.status === 'draft' ? 'ai.summary_auto_applied' : 'ai.summary_missing', 'call', r.id, null, { userId: r.user_id });
  }
  return rows.length;
}

export async function processCalls(pool: pg.Pool, ai: AiConfig | null, storage: string) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const ids = await withCtx(pool, sys, async (db) => {
      // Подвисшие (сервер перезапускался во время обработки) возвращаем в очередь
      await db.query(`update calls set asr_status = 'queued' where asr_status = 'processing' and next_try_at < now()`);
      if (!ai) { await db.query(`update calls set asr_status = 'waiting_ai' where asr_status = 'queued' and transcript is null`); }
      else await db.query(`update calls set asr_status = 'queued', next_try_at = now() where asr_status = 'waiting_ai'`);
      return (await db.query(`select id from calls where asr_status = 'queued' and next_try_at <= now() order by started_at limit 10`)).rows.map((r) => r.id as string);
    });
    if (ai) for (const id of ids) await processCall(pool, sys, ai, storage, id);
    await withCtx(pool, sys, (db) => fillControl(db, tenantId)).catch((e) => console.error('Контроль заполнения:', (e as Error).message));
  }
}

export function startAiWorker(pool: pg.Pool, ai: AiConfig | null, storage: string, everyMs = 30_000) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processCalls(pool, ai, storage); } catch (e) { console.error('Ошибка ИИ:', (e as Error).message); } finally { busy = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/* ---------- маршруты ---------- */
const CALL_SELECT = `select c.id, c.club_id as "clubId", c.started_at as "startedAt", c.direction, c.duration_sec as "durationSec", c.phone,
  c.person_id as "personId", p.full_name as "personName", c.user_id as "userId", u.full_name as "userName", c.source,
  c.asr_status as "asrStatus", c.asr_error as "asrError", c.engine, c.file_id is not null as "hasAudio",
  s.status as "summaryStatus", coalesce(s.final, s.draft) ->> 'essence' as essence, s.edit_ratio as "editRatio", s.rop_rating as "ropRating",
  s.confidence, (c.transcript is not null) as "hasTranscript",
  coalesce(array_length(regexp_split_to_array(trim(c.transcript ->> 'text'), '\\s+'), 1), 0) < ${SHORT_WORDS} and c.asr_status = 'done' and s.id is null as short
  from calls c left join persons p on p.id = c.person_id left join users u on u.id = c.user_id left join call_summaries s on s.call_id = c.id`;

const maskRow = <T extends { phone?: string | null }>(r: T) => ({ ...r, phone: r.phone ? maskPhone(r.phone) : null });

export function aiRoutes(app: FastifyInstance, pool: pg.Pool, storage: string, ai: AiConfig | null) {
  let health: { at: number; v: unknown } | null = null;

  app.get('/api/ai/status', async (req) => {
    requirePerm(req, P.crmWork);
    if (!ai) return { connected: false, message: 'Записи сохраняются и будут расшифрованы после подключения. Итог разговора можно написать вручную.' };
    if (!health || Date.now() - health.at > 60_000) {
      try { health = { at: Date.now(), v: { connected: true, ...(await aiHealth(ai)) } }; }
      catch (e) { health = { at: Date.now(), v: { connected: false, message: `ИИ-сервер не отвечает: ${(e as Error).message}. Записи ждут в очереди.` } }; }
    }
    return health.v;
  });

  app.get('/api/ai/settings', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const club = (await db.query(`select id from clubs where id = $1`, [clubId ?? null])).rows[0];
      if (!club) throw notFound('Клуб не найден');
      const s = (await db.query(`select fill_control_hours from ai_settings where club_id = $1`, [clubId])).rows[0];
      return { clubId, fillControlHours: s?.fill_control_hours ?? 2, canEdit: can(ctx, P.planManage) };
    });
  });

  app.put('/api/ai/settings', async (req) => {
    const ctx = requirePerm(req, P.planManage);
    const b = (req.body ?? {}) as { clubId?: string; fillControlHours?: number };
    const h = Number(b.fillControlHours);
    if (!Number.isInteger(h) || h < 1 || h > 72) throw badRequest('Срок проверки итога — от 1 до 72 часов');
    return withCtx(pool, ctx, async (db) => {
      const club = (await db.query(`select id from clubs where id = $1`, [b.clubId ?? null])).rows[0];
      if (!club) throw notFound('Клуб не найден');
      const before = (await db.query(`select fill_control_hours from ai_settings where club_id = $1`, [b.clubId])).rows[0] ?? null;
      await db.query(`insert into ai_settings(club_id, tenant_id, fill_control_hours, updated_by) values ($1,$2,$3,$4)
        on conflict (club_id) do update set fill_control_hours = excluded.fill_control_hours, updated_by = excluded.updated_by, updated_at = now()`, [b.clubId, ctx.tenantId, h, ctx.userId]);
      await audit(db, ctx, 'ai.settings_changed', 'club', b.clubId!, before, { fillControlHours: h });
      return { ok: true };
    });
  });

  // Загрузка записи разговора (по одной; интерфейс загружает пачку файлами по очереди)
  app.post('/api/calls/upload', AUDIO_LIMIT, async (req, reply) => {
    const ctx = requirePerm(req, P.crmWork);
    const b = (req.body ?? {}) as { clubId?: string; fileName?: string; dataBase64?: string; userId?: string; personId?: string; phone?: string; startedAt?: string; direction?: string };
    const f = decodeAudio(b.fileName, b.dataBase64);
    const parsed = parseRecordName(f.name);
    const res = await withCtx(pool, ctx, async (db) => {
      const club = (await db.query(`select id from clubs where id = $1`, [b.clubId ?? null])).rows[0];
      if (!club) throw badRequest('Выберите клуб');
      let userId: string | null = ctx.userId;
      if (b.userId && b.userId !== ctx.userId) {
        if (onlyMine(ctx)) throw badRequest('Загружать записи других сотрудников может РОП или управляющий');
        const ok = (await db.query(`select 1 from user_assignments where user_id = $1 and club_id = $2`, [b.userId, b.clubId])).rowCount;
        if (!ok) throw badRequest('Сотрудник не работает в этом клубе');
        userId = b.userId;
      } else if (!b.userId && !onlyMine(ctx)) userId = null; // РОП грузит записи АТС: сотрудник — ответственный по сделке
      if (b.personId && !(await db.query(`select 1 from persons where id = $1`, [b.personId])).rowCount) throw badRequest('Клиент не найден');
      const sha = createHash('sha256').update(f.buf).digest('hex');
      const dup = (await db.query(`select id from calls where club_id = $1 and external_id = $2`, [b.clubId, `upload:${sha}`])).rows[0];
      if (dup) return { id: dup.id as string, duplicate: true, personId: null, status: null };
      const file = await saveFile(db, storage, ctx, b.clubId!, 'call_record', f);
      return registerCall(db, ctx, {
        clubId: b.clubId!, userId, personId: b.personId ?? null, phone: normalizePhone(b.phone) ?? parsed.phone,
        startedAt: b.startedAt ?? null, startedLocal: parsed.local, direction: b.direction === 'in' || b.direction === 'out' ? b.direction : parsed.direction,
        source: 'upload', externalId: `upload:${sha}`, fileId: file.id, aiOn: !!ai,
      });
    });
    reply.code(res.duplicate ? 200 : 201);
    return res;
  });

  app.get('/api/calls', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const q = req.query as { clubId?: string; scope?: string; mine?: string; personId?: string; userId?: string; from?: string; to?: string };
    const mine = onlyMine(ctx) || q.mine === '1';
    return withCtx(pool, ctx, async (db) => (await db.query(
      `${CALL_SELECT} where ($1::uuid is null or c.club_id = $1) and ($2::uuid is null or c.user_id = $2) and ($3::uuid is null or c.person_id = $3)
         and ($4::date is null or c.started_at >= $4::date) and ($5::date is null or c.started_at < $5::date + 1)
         and ($6 <> 'review' or s.status in ('draft', 'needs_manual', 'auto_applied') or (c.asr_status = 'waiting_ai' and s.id is null))
       order by (s.status in ('draft', 'needs_manual')) desc nulls last, c.started_at desc limit 300`,
      [q.clubId || null, mine ? ctx.userId : q.userId || null, q.personId || null, q.from || null, q.to || null, q.scope ?? 'all'])).rows.map(maskRow));
  });

  async function loadCall(db: Db, ctx: Ctx, id: string) {
    const c = await callInfo(db, id);
    if (!c || (onlyMine(ctx) && c.user_id !== ctx.userId)) throw notFound('Разговор не найден');
    return c;
  }

  app.get('/api/calls/:id', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadCall(db, ctx, id);
      const s = (await db.query(`select s.*, u.full_name as confirmed_name, r.full_name as rated_name from call_summaries s
        left join users u on u.id = s.confirmed_by left join users r on r.id = s.rated_by where s.call_id = $1`, [id])).rows[0];
      return {
        id: c.id, clubId: c.club_id, clubName: c.club_name, startedAt: c.started_at, direction: c.direction, durationSec: c.duration_sec, phone: c.phone ? maskPhone(c.phone) : null,
        personId: c.person_id, personName: c.person_name, userId: c.user_id, userName: c.user_name, source: c.source, asrStatus: c.asr_status, asrError: c.asr_error,
        engine: c.engine, hasAudio: !!c.file_id, transcript: c.transcript, fillControlHours: Number(c.hours),
        summary: s ? {
          status: s.status, draft: s.draft, final: s.final, engine: s.engine, confidence: s.confidence === null ? null : Number(s.confidence),
          editRatio: s.edit_ratio === null ? null : Number(s.edit_ratio), confirmedBy: s.confirmed_name, confirmedAt: s.confirmed_at, createdAt: s.created_at,
          ropRating: s.rop_rating, ropComment: s.rop_comment, ratedBy: s.rated_name,
        } : null,
        canRate: can(ctx, P.aiReview),
      };
    });
  });

  app.get('/api/calls/:id/audio', async (req, reply) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const f = await withCtx(pool, ctx, async (db) => {
      const c = await loadCall(db, ctx, id);
      return c.file_id ? (await db.query(`select storage_path, mime from files where id = $1`, [c.file_id])).rows[0] : null;
    });
    if (!f) throw notFound('Записи нет');
    reply.header('content-type', f.mime).header('cache-control', 'private, max-age=3600');
    return reply.send(readFileSync(join(storage, f.storage_path)));
  });

  // Менеджер подтверждает черновик ИИ (с правками или без) или пишет итог сам
  app.post('/api/calls/:id/summary', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const final = normalizeSummary(req.body);
    if (!final) throw badRequest('Коротко напишите суть разговора');
    const raw = (req.body ?? {}) as { nextStep?: { title?: string; dueAt?: string } };
    if (raw.nextStep?.title?.trim() && !final.nextStep?.dueAt) throw badRequest('Укажите дату и время следующего шага');
    return withCtx(pool, ctx, async (db) => {
      const c = await loadCall(db, ctx, id);
      const s = (await db.query(`select * from call_summaries where call_id = $1`, [id])).rows[0];
      if (s && ['confirmed', 'manual'].includes(s.status)) throw badRequest('Итог уже подтверждён');
      const status = s?.draft ? 'confirmed' : 'manual';
      const ratio = s?.draft ? editRatio(summaryText(s.draft), summaryText(final)) : null;
      if (s) await db.query(`update call_summaries set final = $2, status = $3, edit_ratio = $4, confirmed_by = $5, confirmed_at = now() where id = $1`,
        [s.id, JSON.stringify(final), status, ratio, ctx.userId]);
      else await db.query(`insert into call_summaries(tenant_id, club_id, call_id, final, status, confirmed_by, confirmed_at) values ($1,$2,$3,$4,'manual',$5,now())`,
        [ctx.tenantId, c.club_id, id, JSON.stringify(final), ctx.userId]);
      // После автопереноса задача следующего шага уже есть — не дублируем
      const taskId = s?.status === 'auto_applied' ? null : await nextStepTask(db, ctx.tenantId, c, final, ctx.userId);
      await closeManagerTasks(db, id, c.user_id, status === 'confirmed' ? 'Итог разговора подтверждён' : 'Итог разговора записан');
      await audit(db, ctx, 'call.summary_saved', 'call', id, s ? { status: s.status, draft: s.draft } : null, { status, editRatio: ratio, final });
      return { ok: true, status, editRatio: ratio, taskId };
    });
  });

  app.post('/api/calls/:id/link', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const { personId } = (req.body ?? {}) as { personId?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadCall(db, ctx, id);
      if (!(await db.query(`select 1 from persons where id = $1`, [personId ?? null])).rowCount) throw badRequest('Клиент не найден');
      const opp = (await db.query(`select id from opportunities where person_id = $1 and club_id = $2 order by (status = 'open') desc, created_at desc limit 1`, [personId, c.club_id])).rows[0];
      await db.query(`update calls set person_id = $2, opportunity_id = $3 where id = $1`, [id, personId, opp?.id ?? null]);
      await db.query(`update tasks set person_id = $2 where call_id = $1 and person_id is null`, [id, personId]);
      await audit(db, ctx, 'call.linked', 'call', id, { personId: c.person_id }, { personId });
      return { ok: true };
    });
  });

  app.post('/api/calls/:id/retry', async (req) => {
    const ctx = requirePerm(req, P.aiReview);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadCall(db, ctx, id);
      if (!['failed', 'done'].includes(c.asr_status) || !c.file_id) throw badRequest('Повторить можно только для записи, которую ИИ не обработал');
      const s = (await db.query(`select status from call_summaries where call_id = $1`, [id])).rows[0];
      if (s && s.status !== 'needs_manual') throw badRequest('Итог уже есть');
      await db.query(`delete from call_summaries where call_id = $1 and status = 'needs_manual'`, [id]);
      await db.query(`update tasks set done_at = now(), result = 'Запись отправлена ИИ повторно' where call_id = $1 and done_at is null and opportunity_id is null and kind = 'other'`, [id]);
      await db.query(`update calls set asr_status = $2, attempts = 0, next_try_at = now(), asr_error = null, transcript = null where id = $1`, [id, ai ? 'queued' : 'waiting_ai']);
      await audit(db, ctx, 'call.retry', 'call', id, null, null);
      return { ok: true };
    });
  });

  // Оценка РОПа: принято без правок / мелкие правки / существенные
  app.post('/api/calls/:id/rating', async (req) => {
    const ctx = requirePerm(req, P.aiReview);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { rating?: string; comment?: string };
    if (!['ok', 'minor', 'major'].includes(b.rating ?? '')) throw badRequest('Выберите оценку');
    return withCtx(pool, ctx, async (db) => {
      await loadCall(db, ctx, id);
      const r = await db.query(`update call_summaries set rop_rating = $2, rop_comment = $3, rated_by = $4, rated_at = now() where call_id = $1 and draft is not null returning id`,
        [id, b.rating, b.comment?.trim().slice(0, 500) || null, ctx.userId]);
      if (!r.rowCount) throw badRequest('Оценивать можно только резюме, которое составил ИИ');
      await audit(db, ctx, 'ai.summary_rated', 'call', id, null, { rating: b.rating, comment: b.comment });
      return { ok: true };
    });
  });

  /* Качество ИИ: доля резюме без существенных правок (цель ≥ 80 %), по менеджерам и версиям */
  async function quality(db: Db, q: { clubId?: string; from?: string; to?: string }) {
    const args = [q.clubId || null, q.from || null, q.to || null];
    const where = `($1::uuid is null or c.club_id = $1) and ($2::date is null or c.started_at >= $2::date) and ($3::date is null or c.started_at < $3::date + 1)`;
    const agg = `count(*)::int as calls,
      count(*) filter (where c.asr_status = 'done')::int as recognized,
      count(*) filter (where c.asr_status = 'failed')::int as failed,
      count(*) filter (where c.asr_status in ('waiting_ai', 'queued', 'processing'))::int as waiting,
      count(*) filter (where c.asr_status = 'done' and s.id is null)::int as short,
      count(s.draft)::int as drafted,
      count(*) filter (where s.status = 'draft')::int as pending,
      count(*) filter (where s.status = 'confirmed')::int as confirmed,
      count(*) filter (where s.status = 'confirmed' and s.edit_ratio <= ${MINOR_EDIT})::int as accepted,
      count(*) filter (where s.status = 'auto_applied')::int as "autoApplied",
      count(*) filter (where s.status in ('manual', 'needs_manual'))::int as manual,
      round(avg(s.edit_ratio) filter (where s.status = 'confirmed') * 100, 1)::float as "avgEditPct",
      count(s.rop_rating)::int as rated,
      count(*) filter (where s.rop_rating in ('ok', 'minor'))::int as "ratedOk"`;
    const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a * 1000) / b) / 10 : null);
    const fin = <R extends { confirmed: number; accepted: number; rated: number; ratedOk: number }>(r: R) => ({ ...r, acceptedPct: pctOf(r.accepted, r.confirmed), ratedOkPct: pctOf(r.ratedOk, r.rated) });
    const total = (await db.query(`select ${agg} from calls c left join call_summaries s on s.call_id = c.id where ${where}`, args)).rows[0];
    const byUser = (await db.query(`select coalesce(u.full_name, 'Не указан') as name, ${agg} from calls c left join call_summaries s on s.call_id = c.id
      left join users u on u.id = c.user_id where ${where} group by 1 order by 2 desc`, args)).rows;
    const byEngine = (await db.query(`select coalesce(s.engine, 'нет') as name, ${agg} from calls c join call_summaries s on s.call_id = c.id
      where ${where} and s.draft is not null group by 1 order by 2 desc`, args)).rows;
    return { target: 80, minorEditPct: MINOR_EDIT * 100, total: fin(total), byUser: byUser.map(fin), byEngine: byEngine.map(fin) };
  }

  app.get('/api/ai/quality', async (req) => {
    const ctx = requirePerm(req, P.aiReview);
    return withCtx(pool, ctx, (db) => quality(db, req.query as { clubId?: string; from?: string; to?: string }));
  });

  // Выгрузка резюме на согласование: черновик ИИ против итога менеджера, правки, оценка РОПа
  app.get('/api/ai/summaries/export', async (req, reply) => {
    const ctx = requirePerm(req, P.aiReview);
    const q = req.query as { clubId?: string; from?: string; to?: string; format?: string };
    const rows = await withCtx(pool, ctx, async (db) => {
      const r = (await db.query(
        `select c.started_at, cl.timezone, u.full_name as manager, p.full_name as client, s.status, s.draft, s.final, s.edit_ratio, s.rop_rating, s.rop_comment, s.engine, s.confidence
         from call_summaries s join calls c on c.id = s.call_id join clubs cl on cl.id = c.club_id left join users u on u.id = c.user_id left join persons p on p.id = c.person_id
         where ($1::uuid is null or c.club_id = $1) and ($2::date is null or c.started_at >= $2::date) and ($3::date is null or c.started_at < $3::date + 1)
         order by c.started_at desc limit 5000`, [q.clubId || null, q.from || null, q.to || null])).rows;
      return r;
    });
    const ST: Record<string, string> = { draft: 'ждёт менеджера', needs_manual: 'нужен ручной итог', confirmed: 'подтверждено', auto_applied: 'перенесено автоматически', manual: 'написано вручную' };
    const RT: Record<string, string> = { ok: 'без правок', minor: 'мелкие правки', major: 'существенные правки' };
    const t: Table = {
      title: 'Резюме звонков',
      columns: ['Дата', 'Менеджер', 'Клиент', 'Статус', 'Резюме ИИ', 'Итог в карточке', 'Правки, %', 'Оценка РОПа', 'Комментарий РОПа', 'Уверенность ИИ, %', 'Версия ИИ'],
      rows: rows.map((r) => [
        new Intl.DateTimeFormat('ru-RU', { timeZone: r.timezone, dateStyle: 'short', timeStyle: 'short' }).format(r.started_at), r.manager, r.client, ST[r.status] ?? r.status,
        r.draft ? summaryText(r.draft).trim() : null, r.final ? summaryText(r.final).trim() : null,
        r.edit_ratio === null ? null : Math.round(Number(r.edit_ratio) * 100), r.rop_rating ? RT[r.rop_rating] : null, r.rop_comment,
        r.confidence === null ? null : Math.round(Number(r.confidence) * 100), r.engine,
      ]),
    };
    // В резюме имена клиентов и содержание разговоров: сверх лимита клуба — только с согласованием (защита базы)
    const sign = await guardExport(pool, ctx, { report: 'ai_summaries', title: 'Резюме звонков', clubId: q.clubId || null, params: { ...q }, rows: t.rows.length, format: q.format === 'xlsx' ? 'xlsx' : 'csv' });
    t.rows.push([], [sign]);
    return sendTable(reply, t, q.format === 'xlsx' ? 'xlsx' : 'csv', 'Резюме звонков');
  });
}
