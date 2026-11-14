// Корпоративный мессенджер сотрудников (решение Андрея 12.11.2026: вся рабочая связь — внутри CRM, а не в Telegram).
// Личные чаты, группы, общий чат клуба и чаты отделов (состав обновляется сам по ролям), объявления с отметкой «прочитали»,
// фото и документы, push в отдельное приложение-мессенджер, ссылки-приглашения со страницей-инструкцией по установке.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { allowedEndpoint } from './mobile.ts';
import { loadVapid, sendPush, type Vapid } from '../lib/webpush.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const base = (req: FastifyRequest) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
const ACTIVE = `a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`;

/* ---------- Общий чат клуба и чаты отделов: состав по ролям ---------- */
export const DEPTS = {
  sales: { name: 'Отдел продаж', roles: ['manager', 'rop'], admins: ['rop'] },
  desk: { name: 'Ресепшн', roles: ['desk'], admins: [] as string[] },
  trainers: { name: 'Тренеры', roles: ['trainer'], admins: [] as string[] },
} as const;
type Dept = keyof typeof DEPTS;

async function syncMembers(db: Db, tenantId: string, chatId: string, desired: Map<string, boolean>) {
  const cur = (await db.query('select user_id, auto, is_admin from team_members where chat_id = $1', [chatId])).rows as { user_id: string; auto: boolean; is_admin: boolean }[];
  const have = new Map(cur.map((r) => [r.user_id, r]));
  for (const [userId, isAdmin] of desired) {
    const h = have.get(userId);
    if (!h) await db.query('insert into team_members(chat_id, user_id, tenant_id, is_admin, auto) values ($1,$2,$3,$4,true) on conflict do nothing', [chatId, userId, tenantId, isAdmin]);
    else if (h.auto && h.is_admin !== isAdmin) await db.query('update team_members set is_admin = $3 where chat_id = $1 and user_id = $2', [chatId, userId, isAdmin]);
  }
  const gone = cur.filter((r) => r.auto && !desired.has(r.user_id)).map((r) => r.user_id);
  if (gone.length) await db.query('delete from team_members where chat_id = $1 and user_id = any($2::uuid[])', [chatId, gone]);
}

async function ensureChat(db: Db, tenantId: string, kind: 'club' | 'dept', clubId: string, dept: Dept | null, title: string) {
  const conflict = kind === 'club' ? `(club_id) where kind = 'club'` : `(club_id, dept) where kind = 'dept'`;
  await db.query(`insert into team_chats(tenant_id, kind, club_id, dept, title) values ($1,$2,$3,$4,$5) on conflict ${conflict} do nothing`, [tenantId, kind, clubId, dept, title]);
  const row = (await db.query(`select id, title from team_chats where club_id = $1 and kind = $2 and dept is not distinct from $3`, [clubId, kind, dept])).rows[0];
  if (row.title !== title) await db.query('update team_chats set title = $2 where id = $1', [row.id, title]);
  return row.id as string;
}

/** Создаёт общий чат каждого клуба и чаты отделов и приводит их состав к текущим назначениям сотрудников. */
export async function syncAutoChats(db: Db, tenantId: string) {
  const clubs = (await db.query(`select id, name, status from clubs order by name`)).rows as { id: string; name: string; status: string }[];
  const asg = (await db.query(`select a.user_id, a.role_code, a.club_id from user_assignments a join users u on u.id = a.user_id where u.status = 'active' and ${ACTIVE}`)).rows as { user_id: string; role_code: string; club_id: string | null }[];
  const owners = [...new Set(asg.filter((a) => a.club_id === null && a.role_code === 'owner').map((a) => a.user_id))];
  for (const club of clubs) {
    const inClub = club.status === 'active' ? asg.filter((a) => a.club_id === club.id) : [];
    const gms = inClub.filter((a) => a.role_code === 'gm').map((a) => a.user_id);
    const all = new Map<string, boolean>();
    for (const a of inClub) all.set(a.user_id, (all.get(a.user_id) ?? false) || a.role_code === 'gm');
    for (const o of owners) all.set(o, true);
    if (club.status !== 'active') all.clear();
    const clubChat = await ensureChat(db, tenantId, 'club', club.id, null, `${club.name} · весь клуб`);
    await syncMembers(db, tenantId, clubChat, all);
    for (const [dept, d] of Object.entries(DEPTS) as [Dept, (typeof DEPTS)[Dept]][]) {
      const members = inClub.filter((a) => (d.roles as readonly string[]).includes(a.role_code));
      const exists = (await db.query(`select id from team_chats where club_id = $1 and kind = 'dept' and dept = $2`, [club.id, dept])).rows[0];
      if (!members.length && !exists) continue;
      const want = new Map<string, boolean>();
      for (const a of members) want.set(a.user_id, (want.get(a.user_id) ?? false) || (d.admins as readonly string[]).includes(a.role_code));
      if (members.length) for (const g of gms) want.set(g, true);
      const id = exists?.id ?? await ensureChat(db, tenantId, 'dept', club.id, dept, `${club.name} · ${d.name}`);
      if (exists) await ensureChat(db, tenantId, 'dept', club.id, dept, `${club.name} · ${d.name}`);
      await syncMembers(db, tenantId, id, want);
    }
  }
}

// Состав авточатов пересчитывается не чаще раза в минуту на сеть (и сразу после изменения сотрудников — по кнопке или в тестах)
const lastSync = new Map<string, number>();
export const resetTeamSync = () => lastSync.clear();
async function maybeSync(pool: pg.Pool, tenantId: string) {
  const t = lastSync.get(tenantId) ?? 0;
  if (Date.now() - t < 60_000) return;
  lastSync.set(tenantId, Date.now());
  await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, (db) => syncAutoChats(db, tenantId)).catch((e) => { lastSync.delete(tenantId); console.error('Мессенджер: состав чатов', (e as Error).message); });
}

/* ---------- Доступ ---------- */
type Member = { chat_id: string; kind: string; club_id: string | null; title: string | null; only_admins_post: boolean; is_admin: boolean; muted: boolean };
async function member(db: Db, ctx: Ctx, chatId: string): Promise<Member> {
  const m = (await db.query(`select c.id as chat_id, c.kind, c.club_id, c.title, c.only_admins_post, m.is_admin, m.muted
    from team_chats c join team_members m on m.chat_id = c.id and m.user_id = $2 where c.id = $1 and c.archived_at is null`, [chatId, ctx.userId])).rows[0];
  if (!m) throw notFound('Чат не найден');
  return m;
}
const canAnnounce = (ctx: Ctx, m: Member) => m.kind !== 'direct' && (m.is_admin || (can(ctx, P.staffManage) && (ctx.allClubs || (!!m.club_id && ctx.clubIds.includes(m.club_id)))));

/** Коллеги, которым можно написать: сотрудники моих клубов и сетевые роли (собственник видит всех). */
async function colleagues(db: Db, ctx: Ctx, ids?: string[]) {
  return (await db.query(
    `select u.id, u.full_name as "fullName", u.login,
       array_agg(distinct r.name) as roles, array_remove(array_agg(distinct c.name), null) as clubs,
       (select platform from team_app_installs i where i.user_id = u.id) as app
     from users u join user_assignments a on a.user_id = u.id and ${ACTIVE} join roles r on r.code = a.role_code left join clubs c on c.id = a.club_id
     where u.status = 'active' and u.id <> $1 and ($2 or a.club_id is null or a.club_id = any($3::uuid[])) and ($4::uuid[] is null or u.id = any($4::uuid[]))
     group by u.id order by u.full_name`, [ctx.userId, ctx.allClubs, ctx.clubIds, ids ?? null])).rows as { id: string; fullName: string; login: string; roles: string[]; clubs: string[]; app: string | null }[];
}

/* ---------- Вложения ---------- */
const MAX_FILE = 10 * 1024 * 1024;
const FILE_LIMIT = { bodyLimit: Math.ceil(MAX_FILE * 1.4) + 16_384 };
const SIGS: [string, number[], string][] = [
  ['image/jpeg', [0xff, 0xd8, 0xff], 'jpg'], ['image/png', [0x89, 0x50, 0x4e, 0x47], 'png'], ['image/gif', [0x47, 0x49, 0x46, 0x38], 'gif'],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46], 'pdf'],
];
function decodeFile(f: { fileName?: string; dataBase64?: string }) {
  if (!f.dataBase64) throw badRequest('Файл не передан');
  const buf = Buffer.from(f.dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw badRequest('Файл пустой');
  if (buf.length > MAX_FILE) throw badRequest('Файл больше 10 МБ');
  const name = (f.fileName || 'файл').replace(/[\\/\r\n"]/g, '_').slice(0, 200);
  let hit = SIGS.find(([, sig]) => sig.every((x, i) => buf[i] === x));
  if (!hit && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') hit = ['image/webp', [], 'webp'];
  if (!hit && buf[0] === 0x50 && buf[1] === 0x4b) {
    const ext = name.toLowerCase().split('.').pop();
    if (ext === 'docx') hit = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', [], 'docx'];
    if (ext === 'xlsx') hit = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', [], 'xlsx'];
  }
  if (!hit) throw badRequest('Можно прислать фото (JPG, PNG, GIF, WEBP), PDF, Word или Excel');
  return { buf, mime: hit[0], ext: hit[2], name };
}

/* ---------- Сообщения ---------- */
const MSG_COLS = `x.id, x.user_id as "userId", u.full_name as "author", x.body, x.important, x.meta, x.created_at as "createdAt", x.edited_at as "editedAt", x.deleted_at is not null as deleted,
  x.reply_to as "replyTo", r.body as "replyBody", ru.full_name as "replyAuthor", r.deleted_at is not null as "replyDeleted",
  case when f.id is null then null else json_build_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size_bytes) end as file`;
const MSG_FROM = `team_messages x left join users u on u.id = x.user_id left join team_messages r on r.id = x.reply_to left join users ru on ru.id = r.user_id left join team_files f on f.id = x.file_id`;
const clean = <T extends { deleted: boolean; body: string; file: unknown; replyBody?: string | null; replyDeleted?: boolean }>(m: T) =>
  ({ ...m, body: m.deleted ? '' : m.body, file: m.deleted ? null : m.file, replyBody: m.replyDeleted ? 'Сообщение удалено' : m.replyBody });

async function sysMessage(db: Db, ctx: Ctx, chatId: string, body: string) {
  await db.query('insert into team_messages(tenant_id, chat_id, user_id, body) values ($1,$2,null,$3)', [ctx.tenantId, chatId, body]);
  await db.query('update team_chats set last_message_at = now() where id = $1', [chatId]);
}
const nameOf = async (db: Db, id: string) => ((await db.query('select full_name from users where id = $1', [id])).rows[0]?.full_name as string | undefined) ?? 'сотрудник';

/* ---------- Push ---------- */
const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstName = (full: string | null) => (full ? full.trim().split(/\s+/).slice(0, 2).join(' ') : 'Сотрудник');

/** Новые сообщения в push: в приложение-мессенджер, а если его нет — в приложение CRM. Заглушённые чаты молчат, кроме объявлений. */
export async function processTeamPush(pool: pg.Pool, vapid: Vapid, fetchFn: typeof fetch) {
  let sent = 0;
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, async (db) => {
      const rows = (await db.query(
        `select x.id, x.chat_id, x.body, x.important, x.created_at, x.file_id, c.kind, c.title, u.full_name as author, m.user_id as to_user
         from team_messages x join team_chats c on c.id = x.chat_id join users u on u.id = x.user_id
         join team_members m on m.chat_id = x.chat_id and m.user_id <> x.user_id and m.last_read_at < x.created_at and (not m.muted or x.important)
         join users tu on tu.id = m.user_id and tu.status = 'active'
         where x.deleted_at is null and x.user_id is not null and x.created_at between now() - interval '10 minutes' and now() - interval '4 seconds'
         order by x.created_at`)).rows;
      for (const r of rows) {
        const ref = r.important ? `imp:${r.id}` : `chat:${r.chat_id}:${Math.floor(new Date(r.created_at).getTime() / 120_000)}`;
        const ins = await db.query('insert into team_push_log(tenant_id, user_id, ref) values ($1,$2,$3) on conflict do nothing', [tenantId, r.to_user, ref]);
        if (!ins.rowCount) continue;
        const title = r.kind === 'direct' ? firstName(r.author) : `${r.important ? '📣 ' : ''}${r.title ?? 'Группа'}`;
        const text = r.body ? short(r.body) : r.file_id ? '📎 Файл' : '';
        const body = r.kind === 'direct' ? text : `${firstName(r.author)}: ${text}`;
        const team = (await db.query(
          `select p.id, p.endpoint, p.p256dh, p.auth from team_push_subscriptions p join sessions s on s.id = p.session_id
           where p.user_id = $1 and s.revoked_at is null and s.expires_at > now()`, [r.to_user])).rows;
        const crm = team.length ? [] : (await db.query(
          `select p.id, p.endpoint, p.p256dh, p.auth from push_subscriptions p join sessions s on s.id = p.session_id
           where p.user_id = $1 and s.revoked_at is null and s.expires_at > now()`, [r.to_user])).rows;
        for (const s of team) {
          const res = await sendPush(fetchFn, vapid, s, { title, body, url: `/team/?chat=${r.chat_id}`, tag: `team-${r.chat_id}` });
          if (res.ok) { sent++; await db.query('update team_push_subscriptions set failures = 0, last_ok_at = now() where id = $1', [s.id]); }
          else if (res.gone) await db.query('delete from team_push_subscriptions where id = $1', [s.id]);
          else await db.query('update team_push_subscriptions set failures = failures + 1 where id = $1', [s.id]);
        }
        for (const s of crm) {
          const res = await sendPush(fetchFn, vapid, s, { title, body, url: `/?tab=team&chat=${r.chat_id}`, tag: `team-${r.chat_id}` });
          if (res.ok) sent++;
        }
      }
      await db.query('delete from team_push_subscriptions where failures >= 20');
      await db.query(`delete from team_push_log where created_at < now() - interval '2 days'`);
    }).catch((e) => console.error('Мессенджер, push:', (e as Error).message));
  }
  return sent;
}

export function startTeamPushWorker(pool: pg.Pool, fetchFn: typeof fetch, everyMs = 10_000) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { await processTeamPush(pool, await loadVapid(pool), fetchFn); } catch (e) { console.error('Мессенджер, push:', (e as Error).message); } finally { busy = false; }
  };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

/* ---------- Приглашения ---------- */
const inviteText = (inviter: string, club: string | null, link: string, login: string | null) =>
  `${inviter} приглашает вас в рабочий мессенджер${club ? ` (${club})` : ''}.\n` +
  `Установите приложение по ссылке: ${link}\n` +
  `На странице — инструкция для iPhone и Android, это займёт минуту.\n` +
  `Вход: ${login ? `логин ${login}` : 'ваш логин'} и пароль от CRM.`;

export function teamRoutes(app: FastifyInstance, pool: pg.Pool, storage: string, onMessage?: (ctx: Ctx, chatId: string, text: string) => Promise<void>) {
  // Короткая ссылка из приглашения: /m/<код> → страница установки приложения
  app.get('/m/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    return reply.redirect(`/team/?i=${encodeURIComponent(token.slice(0, 40))}`);
  });
  app.get('/team', async (_req, reply) => reply.redirect('/team/'));

  app.get('/api/team/unread', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select coalesce(sum((select count(*) from team_messages x where x.chat_id = m.chat_id and x.created_at > m.last_read_at and x.deleted_at is null and x.user_id is distinct from $1)), 0)::int as count
       from team_members m join team_chats c on c.id = m.chat_id and c.archived_at is null where m.user_id = $1 and not m.muted`, [ctx.userId])).rows[0]);
  });

  app.get('/api/team/chats', async (req) => {
    const ctx = requireCtx(req);
    await maybeSync(pool, ctx.tenantId);
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(
        `select c.id, c.kind, c.title, c.club_id as "clubId", c.dept, c.only_admins_post as "onlyAdminsPost", m.is_admin as "isAdmin", m.muted,
           coalesce(c.last_message_at, c.created_at) as "at",
           (select count(*) from team_messages x where x.chat_id = c.id and x.created_at > m.last_read_at and x.deleted_at is null and x.user_id is distinct from $1)::int as unread,
           (select count(*) from team_members y where y.chat_id = c.id)::int as members,
           lm.body as "lastBody", lm.file as "lastFile", lm.author as "lastAuthor", lm.user_id = $1 as "lastMine", lm.user_id is null and lm.at is not null as "lastSystem",
           peer.id as "peerId", peer.full_name as "peerName", peer.app as "peerApp"
         from team_members m join team_chats c on c.id = m.chat_id
         left join lateral (select x.body, x.file_id is not null as file, x.user_id, x.created_at as at, u.full_name as author from team_messages x left join users u on u.id = x.user_id
           where x.chat_id = c.id and x.deleted_at is null order by x.created_at desc limit 1) lm on true
         left join lateral (select u.id, u.full_name, (select platform from team_app_installs i where i.user_id = u.id) as app from team_members y join users u on u.id = y.user_id
           where c.kind = 'direct' and y.chat_id = c.id and y.user_id <> $1 limit 1) peer on true
         where m.user_id = $1 and c.archived_at is null and (c.kind <> 'direct' or c.last_message_at is not null or c.created_by = $1)
         order by coalesce(c.last_message_at, c.created_at) desc`, [ctx.userId])).rows;
      return rows.map((r) => ({ ...r, title: r.kind === 'direct' ? (r.peerName ?? 'Сотрудник') : r.title }));
    });
  });

  app.get('/api/team/people', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, (db) => colleagues(db, ctx));
  });

  // Личный чат с коллегой: один на пару
  app.post('/api/team/direct', async (req) => {
    const ctx = requireCtx(req);
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (!userId || userId === ctx.userId) throw badRequest('Выберите сотрудника');
    return withCtx(pool, ctx, async (db) => {
      if (!(await colleagues(db, ctx, [userId])).length) throw notFound('Сотрудник не найден');
      const key = [ctx.userId, userId].sort().join(':');
      await db.query(`insert into team_chats(tenant_id, kind, direct_key, created_by) values ($1,'direct',$2,$3) on conflict (tenant_id, direct_key) where direct_key is not null do nothing`, [ctx.tenantId, key, ctx.userId]);
      const id = (await db.query('select id from team_chats where tenant_id = $1 and direct_key = $2', [ctx.tenantId, key])).rows[0].id as string;
      for (const u of [ctx.userId, userId]) await db.query('insert into team_members(chat_id, user_id, tenant_id) values ($1,$2,$3) on conflict do nothing', [id, u, ctx.tenantId]);
      return { id };
    });
  });

  app.post('/api/team/groups', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { title?: string; memberIds?: string[]; onlyAdminsPost?: boolean };
    const title = (b.title ?? '').trim().slice(0, 80);
    if (!title) throw badRequest('Назовите группу');
    const ids = [...new Set((b.memberIds ?? []).filter((x) => x !== ctx.userId))].slice(0, 300);
    if (!ids.length) throw badRequest('Добавьте хотя бы одного участника');
    return withCtx(pool, ctx, async (db) => {
      const ok = await colleagues(db, ctx, ids);
      if (ok.length !== ids.length) throw badRequest('Часть сотрудников недоступна');
      const id = (await db.query(`insert into team_chats(tenant_id, kind, title, only_admins_post, created_by) values ($1,'group',$2,$3,$4) returning id`, [ctx.tenantId, title, !!b.onlyAdminsPost, ctx.userId])).rows[0].id as string;
      await db.query('insert into team_members(chat_id, user_id, tenant_id, is_admin) values ($1,$2,$3,true)', [id, ctx.userId, ctx.tenantId]);
      for (const u of ids) await db.query('insert into team_members(chat_id, user_id, tenant_id) values ($1,$2,$3)', [id, u, ctx.tenantId]);
      await sysMessage(db, ctx, id, `${await nameOf(db, ctx.userId)} создал(а) группу «${title}»`);
      await audit(db, ctx, 'team.group_created', 'team_chat', id, null, { title, members: ids.length + 1 });
      return { id };
    });
  });

  app.get('/api/team/chats/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const m = await member(db, ctx, id);
      const members = (await db.query(
        `select u.id, u.full_name as "fullName", m.is_admin as "isAdmin", m.auto, m.last_read_at as "lastReadAt",
           (select string_agg(distinct r.name, ', ') from user_assignments a join roles r on r.code = a.role_code where a.user_id = u.id and ${ACTIVE}) as roles,
           (select platform from team_app_installs i where i.user_id = u.id) as app
         from team_members m join users u on u.id = m.user_id where m.chat_id = $1 order by m.is_admin desc, u.full_name`, [id])).rows;
      const peer = m.kind === 'direct' ? members.find((x) => x.id !== ctx.userId) : null;
      return { id, kind: m.kind, title: m.kind === 'direct' ? peer?.fullName ?? 'Сотрудник' : m.title, clubId: m.club_id, onlyAdminsPost: m.only_admins_post,
        isAdmin: m.is_admin, muted: m.muted, canAnnounce: canAnnounce(ctx, m), canPost: !m.only_admins_post || m.is_admin, canManage: m.kind === 'group' && m.is_admin, members };
    });
  });

  app.patch('/api/team/chats/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { title?: string; onlyAdminsPost?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const m = await member(db, ctx, id);
      if (m.kind !== 'group' || !m.is_admin) throw forbidden();
      if (b.title !== undefined) {
        const t = b.title.trim().slice(0, 80); if (!t) throw badRequest('Назовите группу');
        if (t !== m.title) { await db.query('update team_chats set title = $2 where id = $1', [id, t]); await sysMessage(db, ctx, id, `${await nameOf(db, ctx.userId)} переименовал(а) группу в «${t}»`); }
      }
      if (typeof b.onlyAdminsPost === 'boolean') await db.query('update team_chats set only_admins_post = $2 where id = $1', [id, b.onlyAdminsPost]);
      return { ok: true };
    });
  });

  app.post('/api/team/chats/:id/members', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const ids = [...new Set(((req.body ?? {}) as { userIds?: string[] }).userIds ?? [])].slice(0, 300);
    return withCtx(pool, ctx, async (db) => {
      const m = await member(db, ctx, id);
      if (m.kind !== 'group' || !m.is_admin) throw forbidden();
      const ok = await colleagues(db, ctx, ids);
      if (!ok.length) throw badRequest('Выберите сотрудников');
      const added: string[] = [];
      for (const u of ok) {
        const r = await db.query('insert into team_members(chat_id, user_id, tenant_id) values ($1,$2,$3) on conflict do nothing', [id, u.id, ctx.tenantId]);
        if (r.rowCount) added.push(u.fullName);
      }
      if (added.length) await sysMessage(db, ctx, id, `${await nameOf(db, ctx.userId)} добавил(а): ${added.join(', ')}`);
      return { added: added.length };
    });
  });

  // Убрать участника (руководитель группы) или выйти самому. Из общего чата клуба и отделов не выходят — их можно заглушить
  app.delete('/api/team/chats/:id/members/:userId', async (req) => {
    const ctx = requireCtx(req);
    const { id, userId } = req.params as { id: string; userId: string };
    return withCtx(pool, ctx, async (db) => {
      const m = await member(db, ctx, id);
      if (m.kind !== 'group') throw badRequest('Из этого чата нельзя выйти, его можно заглушить');
      if (userId !== ctx.userId && !m.is_admin) throw forbidden();
      const r = await db.query('delete from team_members where chat_id = $1 and user_id = $2', [id, userId]);
      if (!r.rowCount) throw notFound('Участник не найден');
      const who = await nameOf(db, userId);
      await sysMessage(db, ctx, id, userId === ctx.userId ? `${who} вышел(а) из группы` : `${await nameOf(db, ctx.userId)} убрал(а) из группы: ${who}`);
      // Ушёл последний руководитель — им становится самый давний участник
      const admins = (await db.query('select 1 from team_members where chat_id = $1 and is_admin', [id])).rowCount;
      if (!admins) await db.query('update team_members set is_admin = true where chat_id = $1 and user_id = (select user_id from team_members where chat_id = $1 order by joined_at limit 1)', [id]);
      return { ok: true };
    });
  });

  app.put('/api/team/chats/:id/mute', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const { muted } = (req.body ?? {}) as { muted?: boolean };
    return withCtx(pool, ctx, async (db) => {
      await member(db, ctx, id);
      await db.query('update team_members set muted = $3 where chat_id = $1 and user_id = $2', [id, ctx.userId, !!muted]);
      return { muted: !!muted };
    });
  });

  app.post('/api/team/chats/:id/read', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await member(db, ctx, id);
      await db.query('update team_members set last_read_at = greatest(last_read_at, now()) where chat_id = $1 and user_id = $2', [id, ctx.userId]);
      return { ok: true };
    });
  });

  // Сообщения: последние 60 (или раньше before) либо изменения после since — для обновления открытого чата раз в несколько секунд
  app.get('/api/team/chats/:id/messages', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const q = req.query as { before?: string; since?: string };
    return withCtx(pool, ctx, async (db) => {
      await member(db, ctx, id);
      const now = (await db.query(`select now() - interval '3 seconds' as c`)).rows[0].c as Date;
      let rows;
      if (q.since) {
        rows = (await db.query(`select ${MSG_COLS} from ${MSG_FROM} where x.chat_id = $1 and greatest(x.created_at, x.edited_at, x.deleted_at) > $2 order by x.created_at`, [id, q.since])).rows;
      } else {
        rows = (await db.query(`select * from (select ${MSG_COLS} from ${MSG_FROM} where x.chat_id = $1 and ($2::timestamptz is null or x.created_at < $2) order by x.created_at desc limit 60) t order by "createdAt"`, [id, q.before ?? null])).rows;
      }
      const reads = (await db.query('select user_id as "userId", last_read_at as "lastReadAt" from team_members where chat_id = $1', [id])).rows;
      return { messages: rows.map(clean), reads, cursor: now, more: !q.since && rows.length === 60 };
    });
  });

  app.post('/api/team/chats/:id/messages', FILE_LIMIT, async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { body?: string; replyTo?: string; important?: boolean; file?: { fileName?: string; dataBase64?: string } };
    const text = (b.body ?? '').replace(/\s+$/, '').slice(0, 4000);
    if (!text.trim() && !b.file) throw badRequest('Пустое сообщение');
    const res = await withCtx(pool, ctx, async (db) => {
      const m = await member(db, ctx, id);
      if (m.only_admins_post && !m.is_admin) throw forbidden('В этом канале пишут только руководители');
      if (b.important && !canAnnounce(ctx, m)) throw forbidden('Объявления отправляют руководители');
      if (b.replyTo && !(await db.query('select 1 from team_messages where id = $1 and chat_id = $2', [b.replyTo, id])).rowCount) throw badRequest('Сообщение для ответа не найдено');
      let fileId: string | null = null;
      if (b.file) {
        const f = decodeFile(b.file);
        const hash = createHash('sha256').update(f.buf).digest('hex');
        const rel = join('team', ctx.tenantId, hash.slice(0, 2), `${hash}.${f.ext}`);
        const abs = join(storage, rel);
        if (!existsSync(abs)) { mkdirSync(join(storage, 'team', ctx.tenantId, hash.slice(0, 2)), { recursive: true }); writeFileSync(abs, f.buf); }
        fileId = (await db.query('insert into team_files(tenant_id, chat_id, name, mime, size_bytes, storage_path, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
          [ctx.tenantId, id, f.name, f.mime, f.buf.length, rel, ctx.userId])).rows[0].id;
      }
      const row = (await db.query(`insert into team_messages(tenant_id, chat_id, user_id, body, important, reply_to, file_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, id, ctx.userId, text, !!b.important, b.replyTo ?? null, fileId])).rows[0];
      await db.query('update team_chats set last_message_at = now() where id = $1', [id]);
      await db.query('update team_members set last_read_at = now() where chat_id = $1 and user_id = $2', [id, ctx.userId]);
      if (b.important) await audit(db, ctx, 'team.announcement', 'team_chat', id, null, { message: row.id });
      const msg = (await db.query(`select ${MSG_COLS} from ${MSG_FROM} where x.id = $1`, [row.id])).rows[0];
      return { msg: clean(msg), direct: m.kind === 'direct' };
    });
    // Личный чат с ИИ-помощником: помощник отвечает после сохранения сообщения
    if (res.direct && text.trim() && onMessage) void onMessage(ctx, id, text);
    return res.msg;
  });

  app.patch('/api/team/messages/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const text = (((req.body ?? {}) as { body?: string }).body ?? '').replace(/\s+$/, '').slice(0, 4000);
    return withCtx(pool, ctx, async (db) => {
      const x = (await db.query('select chat_id, user_id, created_at, deleted_at, file_id from team_messages where id = $1', [id])).rows[0];
      if (!x) throw notFound('Сообщение не найдено');
      await member(db, ctx, x.chat_id);
      if (x.user_id !== ctx.userId || x.deleted_at) throw forbidden('Изменить можно только своё сообщение');
      if (Date.now() - new Date(x.created_at).getTime() > 48 * 3600_000) throw badRequest('Сообщение старше 48 часов, его уже нельзя изменить');
      if (!text.trim() && !x.file_id) throw badRequest('Пустое сообщение');
      await db.query('update team_messages set body = $2, edited_at = now() where id = $1', [id, text]);
      return { ok: true };
    });
  });

  // Удалить: автор — своё; руководитель чата — любое (например, лишнее в общем чате клуба)
  app.delete('/api/team/messages/:id', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const x = (await db.query('select chat_id, user_id, deleted_at from team_messages where id = $1', [id])).rows[0];
      if (!x) throw notFound('Сообщение не найдено');
      const m = await member(db, ctx, x.chat_id);
      if (x.user_id !== ctx.userId && !(m.is_admin && m.kind !== 'direct')) throw forbidden('Удалить можно только своё сообщение');
      if (!x.deleted_at) await db.query('update team_messages set deleted_at = now() where id = $1', [id]);
      if (x.user_id !== ctx.userId) await audit(db, ctx, 'team.message_deleted', 'team_message', id, null, { author: x.user_id });
      return { ok: true };
    });
  });

  // Кто прочитал объявление и кто ещё нет
  app.get('/api/team/messages/:id/readers', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const x = (await db.query('select chat_id, user_id, created_at from team_messages where id = $1', [id])).rows[0];
      if (!x) throw notFound('Сообщение не найдено');
      await member(db, ctx, x.chat_id);
      const rows = (await db.query(`select u.id, u.full_name as "fullName", m.last_read_at >= $2 as read from team_members m join users u on u.id = m.user_id
        where m.chat_id = $1 and m.user_id is distinct from $3 order by u.full_name`, [x.chat_id, x.created_at, x.user_id])).rows;
      return { read: rows.filter((r) => r.read), unread: rows.filter((r) => !r.read) };
    });
  });

  app.get('/api/team/files/:id', async (req, reply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const f = await withCtx(pool, ctx, async (db) => {
      const f = (await db.query('select chat_id, name, mime, storage_path from team_files where id = $1', [id])).rows[0];
      if (!f) throw notFound('Файл не найден');
      await member(db, ctx, f.chat_id);
      return f;
    });
    const abs = join(storage, f.storage_path);
    if (!existsSync(abs)) throw notFound('Файл не найден');
    const inline = /^image\/|^application\/pdf$/.test(f.mime);
    reply.header('Content-Type', f.mime);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(readFileSync(abs));
  });

  /* ----- Приложение-мессенджер на телефоне ----- */
  app.post('/api/team/installed', async (req) => {
    const ctx = requireCtx(req);
    const p = ((req.body ?? {}) as { platform?: string }).platform;
    const platform = p === 'ios' || p === 'android' || p === 'desktop' ? p : 'other';
    return withCtx(pool, ctx, async (db) => {
      await db.query(`insert into team_app_installs(user_id, tenant_id, platform) values ($1,$2,$3)
        on conflict (user_id) do update set platform = excluded.platform, last_at = now()`, [ctx.userId, ctx.tenantId, platform]);
      return { ok: true };
    });
  });

  app.post('/api/team/push/subscribe', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!b.endpoint || !allowedEndpoint(b.endpoint)) throw badRequest('Этот браузер не поддерживает уведомления');
    const p256dh = b.keys?.p256dh ?? ''; const auth = b.keys?.auth ?? '';
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length < 16) throw badRequest('Неверные ключи подписки');
    return withCtx(pool, ctx, async (db) => {
      await db.query(
        `insert into team_push_subscriptions(tenant_id, user_id, session_id, endpoint, p256dh, auth, device) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (endpoint) do update set tenant_id = excluded.tenant_id, user_id = excluded.user_id, session_id = excluded.session_id,
           p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, failures = 0`,
        [ctx.tenantId, ctx.userId, ctx.sessionId, b.endpoint, p256dh, auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
      return { ok: true };
    });
  });

  app.post('/api/team/push/unsubscribe', async (req) => {
    const ctx = requireCtx(req);
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    return withCtx(pool, ctx, async (db) => {
      await db.query('delete from team_push_subscriptions where endpoint = $1 and user_id = $2', [endpoint ?? '', ctx.userId]);
      return { ok: true };
    });
  });

  /* ----- Приглашения (собственник, администратор, управляющий) ----- */
  const clubScope = (ctx: Ctx, clubId: string | undefined) => {
    if (!clubId || clubId === 'all') { if (!ctx.allClubs) throw badRequest('Выберите клуб'); return null; }
    if (!ctx.allClubs && !ctx.clubIds.includes(clubId)) throw forbidden();
    return clubId;
  };

  app.get('/api/team/invites', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    const clubId = clubScope(ctx, (req.query as { clubId?: string }).clubId);
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(
        `select u.id, u.full_name as "fullName", u.login,
           (select string_agg(distinct r.name, ', ') from user_assignments a join roles r on r.code = a.role_code where a.user_id = u.id and ${ACTIVE} and ($1::uuid is null or a.club_id = $1 or a.club_id is null)) as roles,
           i.platform as "appPlatform", i.first_at as "appFirstAt", i.last_at as "appLastAt",
           exists (select 1 from team_push_subscriptions p where p.user_id = u.id) as push,
           inv.id as "inviteId", inv.token, inv.created_at as "invitedAt", inv.opened_at as "openedAt", inv.open_count as "openCount"
         from users u left join team_app_installs i on i.user_id = u.id
         left join lateral (select * from team_invites v where v.user_id = u.id and v.revoked_at is null and v.expires_at > now() order by v.created_at desc limit 1) inv on true
         where u.status = 'active' and exists (select 1 from user_assignments a where a.user_id = u.id and ${ACTIVE} and ($1::uuid is null or a.club_id = $1))
         order by (i.user_id is null) desc, u.full_name`, [clubId])).rows;
      const general = (await db.query(`select id, token, created_at as "createdAt", open_count as "openCount" from team_invites
        where user_id is null and club_id is not distinct from $1 and revoked_at is null and expires_at > now() order by created_at desc limit 1`, [clubId])).rows[0] ?? null;
      const b = base(req);
      return {
        people: rows.map(({ token, ...r }) => ({ ...r, link: token ? `${b}/m/${token}` : null })),
        general: general ? { id: general.id, link: `${b}/m/${general.token}`, createdAt: general.createdAt, openCount: general.openCount } : null,
        appLink: `${b}/team/`,
      };
    });
  });

  // Создать ссылки: каждому выбранному сотруднику своя (старая отменяется) или одна общая для клуба
  app.post('/api/team/invites', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    const b = (req.body ?? {}) as { clubId?: string; userIds?: string[] };
    const clubId = clubScope(ctx, b.clubId);
    const ids = [...new Set(b.userIds ?? [])].slice(0, 200);
    return withCtx(pool, ctx, async (db) => {
      const inviter = await nameOf(db, ctx.userId);
      const club = clubId ? (await db.query('select name from clubs where id = $1', [clubId])).rows[0]?.name as string | undefined : undefined;
      if (clubId && !club) throw notFound('Клуб не найден');
      const make = async (userId: string | null) => {
        const token = randomBytes(9).toString('base64url');
        await db.query(`update team_invites set revoked_at = now() where revoked_at is null and club_id is not distinct from $1 and user_id is not distinct from $2`, [clubId, userId]);
        await db.query('insert into team_invites(tenant_id, token_hash, token, club_id, user_id, created_by) values ($1,$2,$3,$4,$5,$6)', [ctx.tenantId, sha256(token), token, clubId, userId, ctx.userId]);
        return `${base(req)}/m/${token}`;
      };
      const out: { userId: string | null; fullName: string | null; link: string; text: string }[] = [];
      if (!ids.length) {
        const link = await make(null);
        out.push({ userId: null, fullName: null, link, text: inviteText(inviter, club ?? null, link, null) });
      } else {
        const ok = (await db.query(`select u.id, u.full_name, u.login from users u where u.status = 'active' and u.id = any($1::uuid[])
          and exists (select 1 from user_assignments a where a.user_id = u.id and ${ACTIVE} and ($2::uuid is null or a.club_id = $2 or ($3 and a.club_id is null)))`, [ids, clubId, ctx.allClubs])).rows;
        if (ok.length !== ids.length) throw badRequest('Часть сотрудников не работает в этом клубе');
        for (const u of ok) { const link = await make(u.id); out.push({ userId: u.id, fullName: u.full_name, link, text: inviteText(inviter, club ?? null, link, u.login) }); }
      }
      await audit(db, ctx, 'team.invites_created', 'club', clubId, null, { count: out.length, personal: ids.length > 0 });
      return out;
    });
  });

  app.post('/api/team/invites/:id/revoke', async (req) => {
    const ctx = requirePerm(req, P.staffManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query(`update team_invites set revoked_at = now() where id = $1 and revoked_at is null and ($2 or club_id = any($3::uuid[])) returning id`, [id, ctx.allClubs, ctx.clubIds]);
      if (!r.rowCount) throw notFound('Ссылка не найдена');
      return { ok: true };
    });
  });

  // Страница установки открывается без входа: показываем, кого и кто пригласил
  app.get('/api/team/invite/:token', async (req) => {
    const { token } = req.params as { token: string };
    const r = (await pool.query('select * from team_invite_open($1)', [sha256(String(token))])).rows[0];
    if (!r) throw notFound('Ссылка устарела. Попросите управляющего прислать новую');
    return { fullName: r.full_name, login: r.login, clubName: r.club_name, inviter: r.inviter };
  });
}
