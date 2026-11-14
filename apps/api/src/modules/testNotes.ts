// Журнал замечаний тестировщика (13.11.2026): на каждой странице CRM тестировщик пишет замечания именно к этой странице.
// Запись привязана к странице (раздел + вкладка; карточка — одна на тип) и к роли. Собственник видит всё в разделе
// «Журнал замечаний». Раз в сутки Claude забирает новые записи по ключу выгрузки, раскладывает их по смыслу
// и возвращает сводку по каждой странице (Markdown) — она видна в том же разделе.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.ts';
import { notify } from './salesOps.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ROLE_ORDER = ['owner', 'admin', 'gm', 'rop', 'manager', 'desk', 'fin', 'trainer'];
const KINDS = new Set(['bug', 'ux', 'idea']);
const STATUSES = new Set(['new', 'in_work', 'done', 'rejected']);
const STATUS_TEXT: Record<string, string> = { new: 'новое', in_work: 'взято в работу', done: 'сделано', rejected: 'не будем делать' };
const PAGE_KEY = /^[a-z0-9_-]{1,40}(:.{1,80})?$/;
const MAX_SHOT = 6 * 1024 * 1024;
const SHOT_LIMIT = { bodyLimit: Math.ceil(MAX_SHOT * 1.4) + 32_768 };

/** Главная роль сотрудника — от неё зависит, чей это журнал («Касса / управляющий») */
export const mainRole = (roles: string[]) => [...roles].sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))[0] ?? 'unknown';
const isOwner = (ctx: Ctx) => can(ctx, '*');

async function requireTester(db: Db, ctx: Ctx) {
  const u = (await db.query('select is_tester from users where id = $1', [ctx.userId])).rows[0];
  if (!u?.is_tester) throw forbidden('Журнал замечаний включён только тестировщикам');
}

function decodeShot(dataBase64: string) {
  const buf = Buffer.from(dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw badRequest('Скриншот пустой');
  if (buf.length > MAX_SHOT) throw badRequest('Скриншот больше 6 МБ');
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { buf, mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { buf, mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { buf, mime: 'image/webp', ext: 'webp' };
  throw badRequest('Скриншот должен быть картинкой PNG, JPG или WEBP');
}

const NOTE_COLS = `n.id, n.number, n.page_key as "pageKey", n.page_label as "pageLabel", n.role_code as "role", r.name as "roleName",
  n.user_id as "userId", u.full_name as "author", c.name as "clubName", n.kind, n.body, n.shot_path is not null as "hasShot",
  n.status, n.status_note as "statusNote", n.status_at as "statusAt", n.created_at as "createdAt"`;
const NOTE_FROM = `test_notes n join users u on u.id = n.user_id left join roles r on r.code = n.role_code left join clubs c on c.id = n.club_id`;

/** Смена статуса записей: тестировщику приходит уведомление в колокольчик, когда замечание сделано или отклонено */
async function setStatus(db: Db, ids: string[], status: string, statusNote: string | null) {
  if (!STATUSES.has(status)) throw badRequest('Неизвестный статус');
  if (!ids.length || ids.length > 500) throw badRequest('Не выбраны записи');
  const rows = (await db.query(`update test_notes set status = $2, status_note = coalesce($3, status_note), status_at = now()
    where id = any($1::uuid[]) and status is distinct from $2 returning id, number, user_id, club_id, page_key, page_label`, [ids, status, statusNote?.slice(0, 1000) || null])).rows;
  if (status === 'done' || status === 'rejected' || status === 'in_work') {
    for (const r of rows) {
      const tab = String(r.page_key).split(':')[0];
      await notify(db, r.club_id, [r.user_id], 'test_note', `Замечание № ${r.number}: ${STATUS_TEXT[status]}`,
        `${r.page_label}${statusNote ? `. ${statusNote.slice(0, 300)}` : ''}`, tab === 'card' ? null : { tab });
    }
  }
  return rows.length;
}

export function testNoteRoutes(app: FastifyInstance, pool: pg.Pool, storage: string) {
  /* ----- Окно журнала на странице ----- */
  // Мои записи по этой странице (в моей роли)
  app.get('/api/test-notes/mine', async (req) => {
    const ctx = requireCtx(req);
    const { page } = req.query as { page?: string };
    if (!page || !PAGE_KEY.test(page)) throw badRequest('Страница не указана');
    return withCtx(pool, ctx, async (db) => {
      await requireTester(db, ctx);
      return (await db.query(`select ${NOTE_COLS} from ${NOTE_FROM} where n.user_id = $1 and n.page_key = $2 and n.role_code = $3 order by n.created_at desc limit 100`,
        [ctx.userId, page, mainRole(ctx.roles)])).rows;
    });
  });

  app.post('/api/test-notes', SHOT_LIMIT, async (req, reply) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { pageKey?: string; pageLabel?: string; kind?: string | null; body?: string; clubId?: string; shot?: string | null };
    const body = (b.body ?? '').trim();
    if (!b.pageKey || !PAGE_KEY.test(b.pageKey)) throw badRequest('Страница не указана');
    if (!body) throw badRequest('Напишите замечание');
    if (body.length > 4000) throw badRequest('Слишком длинная запись: до 4000 символов');
    if (b.kind && !KINDS.has(b.kind)) throw badRequest('Неизвестный тип записи');
    const label = (b.pageLabel ?? b.pageKey).trim().slice(0, 160) || b.pageKey;
    const shot = b.shot ? decodeShot(b.shot) : null;
    const row = await withCtx(pool, ctx, async (db) => {
      await requireTester(db, ctx);
      const clubId = b.clubId && b.clubId !== 'all' && (ctx.allClubs || ctx.clubIds.includes(b.clubId)) ? b.clubId : (ctx.clubIds[0] ?? null);
      let shotPath: string | null = null;
      if (shot) {
        const hash = sha256(shot.buf.toString('base64'));
        shotPath = join('test-notes', ctx.tenantId, hash.slice(0, 2), `${hash}.${shot.ext}`);
        const abs = join(storage, shotPath);
        if (!existsSync(abs)) { mkdirSync(join(storage, 'test-notes', ctx.tenantId, hash.slice(0, 2)), { recursive: true }); writeFileSync(abs, shot.buf); }
      }
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`test_notes:${ctx.tenantId}`]);
      const number = (await db.query('select coalesce(max(number), 0) + 1 as n from test_notes')).rows[0].n;
      const id = (await db.query(`insert into test_notes(tenant_id, number, user_id, role_code, club_id, page_key, page_label, kind, body, shot_path, shot_mime)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [ctx.tenantId, number, ctx.userId, mainRole(ctx.roles), clubId, b.pageKey, label, b.kind || null, body, shotPath, shot?.mime ?? null])).rows[0].id;
      return (await db.query(`select ${NOTE_COLS} from ${NOTE_FROM} where n.id = $1`, [id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  // Удалить свою запись, пока её не взяли в работу
  app.delete('/api/test-notes/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const n = (await db.query('select user_id, status from test_notes where id = $1', [id])).rows[0];
      if (!n) throw notFound('Запись не найдена');
      if (n.user_id !== ctx.userId && !isOwner(ctx)) throw forbidden('Удалить можно только свою запись');
      if (n.status !== 'new' && !isOwner(ctx)) throw badRequest('Запись уже взята в работу, её нельзя удалить');
      await db.query('delete from test_notes where id = $1', [id]);
      return { ok: true };
    });
  });

  app.get('/api/test-notes/:id/shot', async (req, reply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const n = await withCtx(pool, ctx, async (db) => {
      const n = (await db.query('select user_id, shot_path, shot_mime from test_notes where id = $1', [id])).rows[0];
      if (!n?.shot_path) throw notFound('Скриншота нет');
      if (n.user_id !== ctx.userId && !isOwner(ctx)) throw forbidden();
      return n;
    });
    return sendShot(reply, n);
  });

  function sendShot(reply: import('fastify').FastifyReply, n: { shot_path: string; shot_mime: string }) {
    const abs = join(storage, n.shot_path);
    if (!existsSync(abs)) throw notFound('Скриншот не найден');
    reply.header('Content-Type', n.shot_mime);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(readFileSync(abs));
  }

  /* ----- Раздел «Журнал замечаний» для собственника ----- */
  const owner = (req: FastifyRequest) => {
    const ctx = requireCtx(req);
    if (!isOwner(ctx)) throw forbidden('Журнал замечаний целиком видит собственник');
    return ctx;
  };

  app.get('/api/test-notes', async (req) => {
    const ctx = owner(req);
    const q = req.query as { page?: string; role?: string; status?: string };
    return withCtx(pool, ctx, async (db) => {
      const notes = (await db.query(`select ${NOTE_COLS} from ${NOTE_FROM}
        where ($1::text is null or n.page_key = $1) and ($2::text is null or n.role_code = $2) and ($3::text is null or n.status = $3)
        order by n.created_at desc limit 1000`, [q.page || null, q.role || null, q.status || null])).rows;
      const pages = (await db.query(`select p.page_key as "pageKey", p.label as "pageLabel", p.total, p.fresh, s.updated_at as "summaryAt", s.notes_count as "summaryCount"
        from (select page_key, max(page_label) as label, count(*)::int as total, count(*) filter (where status = 'new')::int as fresh, max(created_at) as last
              from test_notes group by page_key) p
        left join test_note_summaries s on s.page_key = p.page_key
        union all
        select s.page_key, s.page_label, 0, 0, s.updated_at, s.notes_count from test_note_summaries s where not exists (select 1 from test_notes n where n.page_key = s.page_key)
        order by 4 desc, 2`)).rows;
      const key = (await db.query('select created_at as "createdAt", last_used_at as "lastUsedAt" from test_note_keys')).rows[0] ?? null;
      return { notes, pages, key };
    });
  });

  app.get('/api/test-notes/summaries', async (req) => {
    const ctx = owner(req);
    const { page } = req.query as { page?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`select page_key as "pageKey", page_label as "pageLabel", body_md as "bodyMd", notes_count as "notesCount", updated_at as "updatedAt"
      from test_note_summaries where ($1::text is null or page_key = $1) order by page_label`, [page || null])).rows);
  });

  app.patch('/api/test-notes/status', async (req) => {
    const ctx = owner(req);
    const b = (req.body ?? {}) as { ids?: string[]; status?: string; statusNote?: string | null };
    return withCtx(pool, ctx, async (db) => ({ updated: await setStatus(db, b.ids ?? [], b.status ?? '', b.statusNote ?? null) }));
  });

  // Тестировщики: кому показывать окно журнала
  app.get('/api/test-notes/testers', async (req) => {
    const ctx = owner(req);
    return withCtx(pool, ctx, async (db) => (await db.query(`select u.id, u.full_name as "fullName", u.login, u.is_tester as "isTester",
        (select string_agg(distinct r.name, ', ') from user_assignments a join roles r on r.code = a.role_code where a.user_id = u.id) as roles,
        (select count(*)::int from test_notes n where n.user_id = u.id) as notes
      from users u where u.status = 'active' and not u.is_bot order by u.is_tester desc, u.full_name`)).rows);
  });

  app.patch('/api/test-notes/testers/:id', async (req) => {
    const ctx = owner(req);
    const { id } = req.params as { id: string };
    const on = !!((req.body ?? {}) as { isTester?: boolean }).isTester;
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query('update users set is_tester = $2 where id = $1', [id, on]);
      if (!r.rowCount) throw notFound('Сотрудник не найден');
      await audit(db, ctx, on ? 'test_notes.tester_on' : 'test_notes.tester_off', 'user', id, null, null);
      return { ok: true };
    });
  });

  // Ключ выгрузки для ежедневного разбора: показывается один раз, в базе — только отпечаток
  app.post('/api/test-notes/key', async (req) => {
    const ctx = owner(req);
    const key = `tn_${randomBytes(24).toString('base64url')}`;
    await withCtx(pool, ctx, async (db) => {
      await db.query(`insert into test_note_keys(tenant_id, key_hash, created_by) values ($1, $2, $3)
        on conflict (tenant_id) do update set key_hash = excluded.key_hash, created_by = excluded.created_by, created_at = now(), last_used_at = null`, [ctx.tenantId, sha256(key), ctx.userId]);
      await audit(db, ctx, 'test_notes.key_issued', 'tenant', ctx.tenantId, null, null);
    });
    return { key };
  });

  app.delete('/api/test-notes/key', async (req) => {
    const ctx = owner(req);
    await withCtx(pool, ctx, (db) => db.query('delete from test_note_keys'));
    return { ok: true };
  });

  /* ----- Выгрузка по ключу: ежедневный разбор ----- */
  const byKey = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? '';
    const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!key) throw unauthorized();
    const t = (await pool.query('select tenant_id from auth_test_notes_key($1)', [sha256(key)])).rows[0];
    if (!t) throw unauthorized();
    const ctx = { tenantId: t.tenant_id as string, allClubs: true, clubIds: [] as string[] };
    await withCtx(pool, ctx, (db) => db.query(`update test_note_keys set last_used_at = now() where last_used_at is null or last_used_at < now() - interval '1 minute'`));
    return ctx;
  };

  app.get('/api/test-notes/export', async (req) => {
    const ctx = await byKey(req);
    const q = req.query as { since?: string; all?: string };
    const since = q.since && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since).toISOString() : null;
    return withCtx(pool, ctx, async (db) => {
      const notes = (await db.query(`select ${NOTE_COLS} from ${NOTE_FROM}
        where ($1::timestamptz is null or n.created_at >= $1 or n.status_at >= $1) order by n.page_key, n.created_at`, [q.all ? null : since])).rows;
      const summaries = (await db.query(`select page_key as "pageKey", page_label as "pageLabel", body_md as "bodyMd", notes_count as "notesCount", updated_at as "updatedAt" from test_note_summaries order by page_key`)).rows;
      return { at: new Date().toISOString(), notes, summaries };
    });
  });

  app.get('/api/test-notes/export/shot/:id', async (req, reply) => {
    const ctx = await byKey(req);
    const { id } = req.params as { id: string };
    const n = await withCtx(pool, ctx, async (db) => (await db.query('select shot_path, shot_mime from test_notes where id = $1', [id])).rows[0]);
    if (!n?.shot_path) throw notFound('Скриншота нет');
    return sendShot(reply, n);
  });

  app.put('/api/test-notes/export/summaries', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const ctx = await byKey(req);
    const list = ((req.body ?? {}) as { summaries?: { pageKey?: string; pageLabel?: string; bodyMd?: string; notesCount?: number }[] }).summaries ?? [];
    if (!Array.isArray(list) || !list.length || list.length > 300) throw badRequest('Нет сводок');
    return withCtx(pool, ctx, async (db) => {
      for (const s of list) {
        if (!s.pageKey || !PAGE_KEY.test(s.pageKey) || !s.bodyMd?.trim()) throw badRequest(`Сводка без страницы или текста: ${s.pageKey ?? ''}`);
        await db.query(`insert into test_note_summaries(tenant_id, page_key, page_label, body_md, notes_count) values ($1,$2,$3,$4,$5)
          on conflict (tenant_id, page_key) do update set page_label = excluded.page_label, body_md = excluded.body_md, notes_count = excluded.notes_count, updated_at = now()`,
          [ctx.tenantId, s.pageKey, (s.pageLabel || s.pageKey).slice(0, 160), s.bodyMd.slice(0, 100000), Math.max(0, Math.trunc(s.notesCount ?? 0))]);
      }
      return { saved: list.length };
    });
  });

  app.patch('/api/test-notes/export/status', async (req) => {
    const ctx = await byKey(req);
    const b = (req.body ?? {}) as { ids?: string[]; status?: string; statusNote?: string | null };
    return withCtx(pool, ctx, async (db) => ({ updated: await setStatus(db, b.ids ?? [], b.status ?? '', b.statusNote ?? null) }));
  });
}
