// Бот сотрудников в Telegram: один бот на сеть, сотрудники привязывают свой Telegram из профиля.
// Через него уходят утренняя сводка (morning.ts) и служебные уведомления — notifyStaff().
// Токен бота хранится зашифрованным (как ключи кассы) и в интерфейс не возвращается.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, forbidden } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { decrypt, encrypt } from './fiscal.ts';
import type { Fetch } from './msgProviders.ts';

const API = 'https://api.telegram.org';
const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { ok: false, description: t.slice(0, 200) }; } };
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function botRow(db: Db) {
  return (await db.query('select token_enc, bot_username, enabled, summary_enabled, summary_hour, last_update_id, last_error from staff_bot where tenant_id = app_tenant()')).rows[0] as
    { token_enc: string | null; bot_username: string | null; enabled: boolean; summary_enabled: boolean; summary_hour: number; last_update_id: string | null; last_error: string | null } | undefined;
}
async function token(db: Db) {
  const b = await botRow(db);
  return b?.enabled && b.token_enc ? decrypt(b.token_enc) : null;
}

export async function tgSend(f: Fetch, tok: string, chatId: string, text: string) {
  const r = await json(await f(`${API}/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }) }));
  if (!r.ok) throw new Error(`Telegram: ${r.description ?? 'не удалось отправить'}`);
}

/** Сообщение сотруднику в Telegram. false — бот не настроен или сотрудник не привязал Telegram. Текст — HTML Telegram (экранируйте данные через escapeHtml) */
export async function notifyStaff(db: Db, f: Fetch, userId: string, text: string): Promise<boolean> {
  const tok = await token(db);
  if (!tok) return false;
  const link = (await db.query('select chat_id from staff_telegram where user_id = $1', [userId])).rows[0];
  if (!link) return false;
  try { await tgSend(f, tok, link.chat_id, text); return true; } catch { return false; }
}

/** Обработка входящих сообщений боту: /start КОД — привязка, /stop — отключить сводку */
export async function pollBot(db: Db, f: Fetch, tenantId: string) {
  const b = await botRow(db);
  if (!b?.enabled || !b.token_enc) return 0;
  const tok = decrypt(b.token_enc);
  const off = b.last_update_id ? `&offset=${Number(b.last_update_id) + 1}` : '';
  const r = await json(await f(`${API}/bot${tok}/getUpdates?timeout=0&allowed_updates=${encodeURIComponent('["message"]')}${off}`));
  if (!r.ok) { await db.query('update staff_bot set last_error = $1 where tenant_id = app_tenant()', [String(r.description ?? 'ошибка').slice(0, 300)]); return 0; }
  let n = 0;
  for (const u of r.result as { update_id: number; message?: { chat: { id: number; type: string }; from?: { first_name?: string; last_name?: string; username?: string }; text?: string } }[]) {
    await db.query('update staff_bot set last_update_id = $1, last_error = null where tenant_id = app_tenant()', [u.update_id]);
    const m = u.message;
    if (!m?.text || m.chat.type !== 'private') continue;
    const chat = String(m.chat.id);
    const reply = (t: string) => tgSend(f, tok, chat, t).catch(() => undefined);
    const start = m.text.trim().match(/^\/start(?:\s+([A-Za-z0-9_-]{6,64}))?$/);
    if (start?.[1]) {
      const c = (await db.query(`delete from staff_link_codes where code = $1 returning user_id, expires_at`, [start[1]])).rows[0];
      if (!c || new Date(c.expires_at) < new Date()) { await reply('Ссылка устарела. Откройте «Профиль» в Клубной ОС и нажмите «Подключить Telegram» ещё раз.'); continue; }
      const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') + (m.from?.username ? ` (@${m.from.username})` : '');
      // Один Telegram — один сотрудник: старая привязка этого чата снимается
      await db.query('delete from staff_telegram where chat_id = $1 and user_id <> $2', [chat, c.user_id]);
      await db.query(`insert into staff_telegram(user_id, tenant_id, chat_id, tg_name) values ($1, app_tenant(), $2, $3)
        on conflict (user_id) do update set chat_id = excluded.chat_id, tg_name = excluded.tg_name, linked_at = now()`, [c.user_id, chat, name || null]);
      const u2 = (await db.query('select full_name from users where id = $1', [c.user_id])).rows[0];
      await audit(db, { tenantId, userId: c.user_id }, 'staff_bot.linked', 'user', c.user_id, null, { tgName: name });
      await reply(`Готово, ${escapeHtml(u2?.full_name ?? '')}! Telegram подключён к Клубной ОС. Сюда будут приходить утренняя сводка и важные уведомления. Отключить сводку — /stop, включить снова — /summary.`);
      n++;
    } else if (/^\/stop\b/.test(m.text.trim())) {
      const k = await db.query('update staff_telegram set summary = false where chat_id = $1', [chat]);
      await reply(k.rowCount ? 'Утренняя сводка отключена. Включить снова — /summary.' : 'Этот Telegram не подключён к Клубной ОС.');
    } else if (/^\/summary\b/.test(m.text.trim())) {
      const k = await db.query('update staff_telegram set summary = true where chat_id = $1', [chat]);
      await reply(k.rowCount ? 'Утренняя сводка включена.' : 'Этот Telegram не подключён к Клубной ОС.');
    } else {
      const linked = (await db.query('select 1 from staff_telegram where chat_id = $1', [chat])).rowCount;
      await reply(linked ? 'Это служебный бот Клубной ОС: он присылает сводку и уведомления, но не отвечает на вопросы. Команды: /stop — отключить сводку, /summary — включить.'
        : 'Это служебный бот Клубной ОС для сотрудников. Чтобы подключиться, откройте «Профиль» в Клубной ОС и нажмите «Подключить Telegram».');
    }
  }
  return n;
}

const SUMMARY_ROLES = ['owner', 'gm'];
export function staffBotRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = () => opts.fetch ?? fetch;
  const ownerOnly = (req: Parameters<typeof requireCtx>[0]) => {
    const ctx = requireCtx(req);
    if (!ctx.allClubs || !can(ctx, P.clubsManage)) throw forbidden('Бота сотрудников настраивает собственник');
    return ctx;
  };
  app.get('/api/staff-bot', async (req) => {
    const ctx = ownerOnly(req);
    return withCtx(pool, ctx, async (db) => {
      const b = await botRow(db);
      const staff = (await db.query(`select u.id, u.full_name as name, t.tg_name as "tgName", t.summary, t.linked_at as "linkedAt",
          exists (select 1 from user_assignments a where a.user_id = u.id and a.role_code = any($1) and (a.active_to is null or a.active_to >= current_date)) as "getsSummary"
        from staff_telegram t join users u on u.id = t.user_id order by u.full_name`, [SUMMARY_ROLES])).rows;
      return { configured: !!b?.token_enc, username: b?.bot_username ?? null, enabled: b?.enabled ?? true, summaryEnabled: b?.summary_enabled ?? true, summaryHour: b?.summary_hour ?? 8, lastError: b?.last_error ?? null, staff };
    });
  });
  app.put('/api/staff-bot', async (req) => {
    const ctx = ownerOnly(req);
    const b = (req.body ?? {}) as { token?: string; enabled?: boolean; summaryEnabled?: boolean; summaryHour?: number };
    let username: string | null = null; let enc: string | null = null;
    if (b.token?.trim()) {
      const t = b.token.trim();
      if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t)) throw badRequest('Это не похоже на токен бота. Токен выдаёт @BotFather, он выглядит как 123456789:AA…');
      const r = await json(await f()(`${API}/bot${t}/getMe`)).catch(() => ({ ok: false }));
      if (!r.ok) throw badRequest('Telegram не принял токен. Проверьте, что скопировали его полностью');
      username = r.result.username; enc = encrypt(t);
    }
    const hour = b.summaryHour ?? 8;
    if (!Number.isInteger(hour) || hour < 5 || hour > 12) throw badRequest('Время сводки — с 5 до 12 часов');
    return withCtx(pool, ctx, async (db) => {
      const before = await botRow(db);
      await db.query(`insert into staff_bot(tenant_id, token_enc, bot_username, enabled, summary_enabled, summary_hour, updated_by) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (tenant_id) do update set token_enc = coalesce(excluded.token_enc, staff_bot.token_enc), bot_username = coalesce(excluded.bot_username, staff_bot.bot_username),
          last_update_id = case when excluded.token_enc is null then staff_bot.last_update_id end, enabled = excluded.enabled, summary_enabled = excluded.summary_enabled,
          summary_hour = excluded.summary_hour, last_error = null, updated_by = excluded.updated_by, updated_at = now()`,
      [ctx.tenantId, enc, username, b.enabled ?? true, b.summaryEnabled ?? true, hour, ctx.userId]);
      await audit(db, ctx, 'staff_bot.settings_changed', 'tenant', ctx.tenantId, before ? { username: before.bot_username, enabled: before.enabled, hour: before.summary_hour } : null,
        { username: username ?? before?.bot_username ?? null, tokenChanged: !!enc, enabled: b.enabled ?? true, hour });
      return { ok: true, username: username ?? before?.bot_username ?? null };
    });
  });

  /* ---------- свой Telegram в профиле ---------- */
  app.get('/api/me/telegram', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const b = await botRow(db);
      const l = (await db.query('select tg_name as "tgName", summary, linked_at as "linkedAt" from staff_telegram where user_id = $1', [ctx.userId])).rows[0] ?? null;
      return { botReady: !!(b?.enabled && b.token_enc), username: b?.bot_username ?? null, link: l, getsSummary: ctx.roles.some((r) => SUMMARY_ROLES.includes(r)), summaryHour: b?.summary_hour ?? 8 };
    });
  });
  app.post('/api/me/telegram/link', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const b = await botRow(db);
      if (!b?.enabled || !b.token_enc || !b.bot_username) throw badRequest('Бот сотрудников ещё не подключён. Его подключает собственник в своём профиле, блок «Бот сотрудников в Telegram»');
      await db.query('delete from staff_link_codes where user_id = $1 or expires_at < now()', [ctx.userId]);
      const code = randomBytes(12).toString('base64url');
      await db.query(`insert into staff_link_codes(code, tenant_id, user_id, expires_at) values ($1, $2, $3, now() + interval '30 minutes')`, [code, ctx.tenantId, ctx.userId]);
      return { url: `https://t.me/${b.bot_username}?start=${code}` };
    });
  });
  app.put('/api/me/telegram', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { summary?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const k = await db.query('update staff_telegram set summary = $2 where user_id = $1', [ctx.userId, !!b.summary]);
      if (!k.rowCount) throw badRequest('Telegram не подключён');
      return { ok: true };
    });
  });
  app.delete('/api/me/telegram', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      await db.query('delete from staff_telegram where user_id = $1', [ctx.userId]);
      await audit(db, ctx, 'staff_bot.unlinked', 'user', ctx.userId, null, null);
      return { ok: true };
    });
  });
}
