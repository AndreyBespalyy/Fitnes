// Свой модуль Telegram (решение Андрея 18.11.2026): CRM входит в Telegram-аккаунт клуба по коду из Telegram, как обычное приложение,
// и ведёт переписку от его имени. Без сервисов-посредников: соединение напрямую с Telegram из фонового процесса.
//  - Вход: номер аккаунта → код из Telegram → облачный пароль (если включён). Ключ входа хранится зашифрованным в канале.
//  - Входящие: личные сообщения аккаунту → «Переписка», новые люди → заявки (как у остальных каналов).
//  - Исходящие: по идентификатору клиента в Telegram; если его ещё нет — по номеру телефона (номер клиента = его номер в Telegram).
// Массовых рассылок нет (решение Андрея): только переписка с отдельными клиентами, поэтому риск ограничений Telegram низкий.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { computeCheck } from 'telegram/Password.js';
import bigInt from 'big-integer';
import { requireAnyPerm } from '../auth.ts';
import { audit, withCtx } from '../db.ts';
import { badRequest } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { normalizePhone } from './crm.ts';
import { encrypt } from './fiscal.ts';
import { deliver, ensureMsgDefaults, handleInbound, loadChannel, type Channel } from './messaging.ts';
import { liveSenders, ProviderError, type Fetch, type SendOpts, type SendResult } from './msgProviders.ts';

type Secret = { apiHash: string; session: string };
const tgError = (e: unknown) => String((e as { errorMessage?: string }).errorMessage ?? (e as Error).message ?? '');
const waitSec = (e: unknown) => Number((e as { seconds?: number }).seconds ?? 0);

/** Понятный текст ошибки Telegram для сотрудника. */
export function tgErrorText(e: unknown): string {
  const m = tgError(e);
  if (/FLOOD_WAIT|FLOOD_PREMIUM_WAIT/.test(m)) return `Telegram просит подождать ${Math.ceil(waitSec(e) / 60) || 1} мин перед следующим действием`;
  if (m === 'PEER_FLOOD') return 'Telegram временно ограничил аккаунт клуба: слишком много сообщений новым людям. Пишите тем, кто уже обращался, или позвоните';
  if (m === 'PHONE_CODE_INVALID') return 'Неверный код. Проверьте код в Telegram и введите ещё раз';
  if (m === 'PHONE_CODE_EXPIRED') return 'Код устарел. Запросите новый';
  if (m === 'PASSWORD_HASH_INVALID') return 'Неверный облачный пароль Telegram';
  if (m === 'PHONE_NUMBER_INVALID') return 'Неверный номер телефона аккаунта';
  if (m === 'PHONE_NUMBER_BANNED') return 'Этот номер заблокирован в Telegram';
  if (m === 'API_ID_INVALID') return 'Неверные api_id или api_hash: проверьте их на my.telegram.org';
  if (/USER_PRIVACY_RESTRICTED|PRIVACY_PREMIUM_REQUIRED/.test(m)) return 'Клиент запретил писать ему незнакомым в настройках Telegram. Напишите в WhatsApp или позвоните';
  if (m === 'USER_IS_BLOCKED' || m === 'YOU_BLOCKED_USER') return 'Клиент заблокировал аккаунт клуба в Telegram';
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(m)) return 'Вход в Telegram сброшен (вышли из аккаунта на телефоне). Войдите заново в «Сообщения» → «Каналы»';
  return `Telegram: ${m || 'нет связи'}`;
}

const apiCreds = (b: { apiId?: string | number; apiHash?: string }) => {
  const apiId = Number(b.apiId || process.env.TG_API_ID || 0);
  const apiHash = String(b.apiHash || process.env.TG_API_HASH || '').trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw badRequest('Укажите api_id и api_hash приложения Telegram: их выдают бесплатно на my.telegram.org → API development tools');
  }
  return { apiId, apiHash };
};

function newClient(session: string, apiId: number, apiHash: string) {
  const c = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5, deviceModel: 'Клубная ОС (CRM)', appVersion: '1.0', systemVersion: 'server' });
  c.setLogLevel(LogLevel.ERROR);
  return c;
}

/* ---------- вход в аккаунт клуба ---------- */
type Pending = { client: TelegramClient; phone: string; hash: string; apiId: number; apiHash: string; clubId: string; channelId: string | null; tenantId: string; userId: string; timer: NodeJS.Timeout };

export function tgUserRoutes(app: FastifyInstance, pool: pg.Pool) {
  const pending = new Map<string, Pending>();
  const drop = (id: string) => { const p = pending.get(id); if (!p) return; clearTimeout(p.timer); pending.delete(id); void p.client.disconnect().catch(() => null); };
  app.addHook('onClose', async () => { for (const id of [...pending.keys()]) drop(id); });

  // Шаг 1: номер аккаунта клуба → Telegram присылает код (в приложение Telegram или СМС)
  app.post('/api/msg/tg-login/start', async (req) => {
    const ctx = requireAnyPerm(req, P.messagesManage, P.integrationsManage);
    const b = (req.body ?? {}) as { clubId?: string; channelId?: string; phone?: string; apiId?: string; apiHash?: string };
    const phone = normalizePhone(b.phone);
    if (!phone) throw badRequest('Укажите номер телефона Telegram-аккаунта клуба');
    const { apiId, apiHash } = apiCreds(b);
    const clubId = await withCtx(pool, ctx, async (db) => {
      if (b.channelId) {
        const ch = (await db.query(`select club_id from msg_channels where id = $1 and kind = 'tg_user'`, [b.channelId])).rows[0];
        if (!ch) throw badRequest('Канал не найден');
        return ch.club_id as string;
      }
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId ?? null])).rowCount) throw badRequest('Выберите клуб');
      return b.clubId!;
    });
    const client = newClient('', apiId, apiHash);
    try {
      await client.connect();
      const r = await client.sendCode({ apiId, apiHash }, phone);
      const id = randomUUID();
      pending.set(id, { client, phone, hash: r.phoneCodeHash, apiId, apiHash, clubId, channelId: b.channelId ?? null, tenantId: ctx.tenantId, userId: ctx.userId!,
        timer: setTimeout(() => drop(id), 10 * 60_000) });
      return { loginId: id, viaApp: r.isCodeViaApp };
    } catch (e) {
      await client.disconnect().catch(() => null);
      if (e instanceof Error && 'statusCode' in e) throw e;
      throw badRequest(tgErrorText(e));
    }
  });

  // Шаг 2: код из Telegram (и облачный пароль, если он включён) → канал «Telegram-аккаунт клуба»
  app.post('/api/msg/tg-login/code', async (req) => {
    const ctx = requireAnyPerm(req, P.messagesManage, P.integrationsManage);
    const b = (req.body ?? {}) as { loginId?: string; code?: string; password?: string };
    const p = pending.get(b.loginId ?? '');
    if (!p || p.tenantId !== ctx.tenantId || p.userId !== ctx.userId) throw badRequest('Вход устарел. Начните заново: «Войти в Telegram»');
    try {
      if (b.password) {
        const pw = await p.client.invoke(new Api.account.GetPassword());
        await p.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pw, b.password) }));
      } else {
        const code = String(b.code ?? '').replace(/\D/g, '');
        if (!code) throw badRequest('Введите код из Telegram');
        try {
          await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.hash, phoneCode: code }));
        } catch (e) {
          if (tgError(e) === 'SESSION_PASSWORD_NEEDED') return { needPassword: true };
          throw e;
        }
      }
      const me = await p.client.getMe() as Api.User;
      const secret: Secret = { apiHash: p.apiHash, session: (p.client.session as StringSession).save() };
      const settings = { apiId: String(p.apiId), account: me.username ? `@${me.username}` : `+${String(me.phone ?? '').replace(/^(\d)(\d{3})\d+(\d{2})$/, '$1 $2 ***-**-$3')}` };
      const name = `Telegram ${[me.firstName, me.lastName].filter(Boolean).join(' ') || settings.account}`.slice(0, 100);
      const res = await withCtx(pool, ctx, async (db) => {
        let id = p.channelId;
        if (id) {
          await db.query(`update msg_channels set settings = $2, secret_enc = $3, status = 'active', last_error = null, last_ok_at = now(), updated_at = now() where id = $1`,
            [id, JSON.stringify(settings), encrypt(JSON.stringify(secret))]);
        } else {
          id = (await db.query(`insert into msg_channels(tenant_id, club_id, kind, messenger, name, settings, secret_enc, webhook_token, created_by, last_ok_at)
            values ($1,$2,'tg_user','telegram',$3,$4,$5,$6,$7, now()) returning id`,
          [ctx.tenantId, p.clubId, name, JSON.stringify(settings), encrypt(JSON.stringify(secret)), randomBytes(18).toString('base64url'), ctx.userId])).rows[0].id as string;
          await ensureMsgDefaults(db, ctx.tenantId, p.clubId);
        }
        await audit(db, ctx, p.channelId ? 'msg_channel.relogin' : 'msg_channel.created', 'msg_channel', id, null, { kind: 'tg_user', account: settings.account });
        return { id, name, account: settings.account };
      });
      drop(b.loginId!);
      return { ok: true, ...res };
    } catch (e) {
      if (e instanceof Error && 'statusCode' in e) throw e;
      const m = tgError(e);
      if (m === 'PHONE_CODE_EXPIRED') drop(b.loginId!);
      throw badRequest(tgErrorText(e));
    }
  });
}

/* ---------- фоновый процесс: живые соединения аккаунтов клубов ---------- */
type Live = { client: TelegramClient; key: string; tenantId: string };

/** Отправка от имени аккаунта клуба. chatId — идентификатор клиента в Telegram или «tel:7…» (первое сообщение по номеру). */
export function tgSender(client: Pick<TelegramClient, 'getInputEntity' | 'sendMessage' | 'invoke'>) {
  const byPhone = async (digits: string, name?: string | null) => {
    const r = await client.invoke(new Api.contacts.ImportContacts({ contacts: [new Api.InputPhoneContact({
      clientId: bigInt(Date.now()), phone: `+${digits}`, firstName: (name || 'Клиент клуба').slice(0, 60), lastName: '' })] }));
    const u = r.users.find((x) => x instanceof Api.User) as Api.User | undefined;
    if (!u) throw new ProviderError('Клиента нет в Telegram по этому номеру, или он скрыл номер от поиска. Напишите в WhatsApp или позвоните');
    return u;
  };
  return async (chatId: string, text: string, o: SendOpts): Promise<SendResult> => {
    try {
      let peer: Api.TypeInputPeer | Api.User | null = null;
      let resolved: string | undefined;
      if (!chatId.startsWith('tel:')) peer = await client.getInputEntity(bigInt(chatId)).catch(() => null);
      if (!peer) {
        const digits = chatId.startsWith('tel:') ? chatId.slice(4) : (o.phone ?? '').replace(/\D/g, '');
        if (!digits) throw new ProviderError('Telegram не нашёл клиента, а номера телефона в карточке нет');
        const u = await byPhone(digits, o.name);
        peer = u; resolved = u.id.toString();
      }
      const msg = await client.sendMessage(peer, { message: text });
      return { externalId: String(msg.id), chatId: resolved };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(tgErrorText(e));
    }
  };
}

/** Входящее личное сообщение аккаунту клуба → общий разбор входящих (заявка, диалог, автоответ). */
export async function tgInbound(pool: pg.Pool, f: Fetch, tenantId: string, channelId: string, ev: { senderId: string; bot: boolean; self: boolean; firstName?: string; lastName?: string;
  username?: string; phone?: string; messageId: number; text: string; date: number }) {
  if (ev.bot || ev.self) return;
  await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, async (db) => {
    const ch: Channel = await loadChannel(db, channelId);
    const name = [ev.firstName, ev.lastName].filter(Boolean).join(' ') || (ev.username ? `@${ev.username}` : 'Клиент из Telegram');
    const r = await handleInbound(db, { tenantId, userId: null }, ch, { chatId: ev.senderId, externalId: String(ev.messageId), text: ev.text || '[вложение]', name,
      phone: ev.phone ? `+${ev.phone}` : null, ownPhone: !!ev.phone, at: new Date(ev.date * 1000) });
    if (r.autoreplyId) await deliver(db, f, r.autoreplyId);
  });
}

export function startTgUserHub(pool: pg.Pool, f: Fetch = fetch, everyMs = 30_000) {
  const live = new Map<string, Live>();
  let stopped = false;
  const disconnect = (id: string) => { const l = live.get(id); live.delete(id); liveSenders.delete(id); void l?.client.disconnect().catch(() => null); };
  const setError = (tenantId: string, id: string, msg: string | null) => withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, (db) =>
    db.query(`update msg_channels set last_error = $2, last_ok_at = case when $2::text is null then now() else last_ok_at end where id = $1`, [id, msg])).catch(() => null);

  const connect = async (tenantId: string, ch: Channel) => {
    let s: Secret;
    try { s = JSON.parse(ch.secret ?? '') as Secret; } catch { await setError(tenantId, ch.id, 'Войдите в Telegram заново: ключ входа повреждён'); return; }
    const client = newClient(s.session, Number(ch.settings.apiId), s.apiHash);
    try {
      await client.connect();
      if (!(await client.checkAuthorization())) throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
      // Прогреваем адресную книгу соединения: без неё Telegram не даст написать по сохранённому идентификатору после перезапуска
      await client.getDialogs({ limit: 300 }).catch(() => null);
      client.addEventHandler(async (e: NewMessageEvent) => {
        try {
          if (!e.isPrivate) return;
          const u = await e.message.getSender();
          if (!(u instanceof Api.User)) return;
          await tgInbound(pool, f, tenantId, ch.id, { senderId: u.id.toString(), bot: !!u.bot, self: !!u.self, firstName: u.firstName ?? undefined, lastName: u.lastName ?? undefined,
            username: u.username ?? undefined, phone: u.phone ?? undefined, messageId: e.message.id, text: e.message.message ?? '', date: e.message.date });
        } catch (x) { console.error('Telegram-аккаунт клуба, входящее:', (x as Error).message); }
      }, new NewMessage({ incoming: true }));
      live.set(ch.id, { client, key: ch.secret ?? '', tenantId });
      liveSenders.set(ch.id, tgSender(client));
      await setError(tenantId, ch.id, null);
    } catch (e) {
      await client.disconnect().catch(() => null);
      await setError(tenantId, ch.id, tgErrorText(e));
    }
  };

  const sync = async () => {
    const tenants = (await pool.query('select tenant_id from msg_tenants()')).rows.map((r) => r.tenant_id as string);
    const want = new Set<string>();
    for (const tenantId of tenants) {
      const chans = await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, async (db) => {
        const ids = (await db.query(`select id from msg_channels where kind = 'tg_user' and status = 'active'`)).rows.map((r) => r.id as string);
        return Promise.all(ids.map((id) => loadChannel(db, id)));
      });
      for (const ch of chans) {
        want.add(ch.id);
        const l = live.get(ch.id);
        if (l && l.key === (ch.secret ?? '') && l.client.connected) continue;
        if (l) disconnect(ch.id); // ключ входа сменился (вошли заново) или соединение упало
        if (!stopped) await connect(tenantId, ch);
      }
    }
    for (const id of [...live.keys()]) if (!want.has(id)) disconnect(id);
  };
  // Сообщения, поставленные в очередь сайтом, уходят отсюда за несколько секунд
  const flush = async () => {
    const byTenant = new Map<string, string[]>();
    for (const [id, l] of live) byTenant.set(l.tenantId, [...(byTenant.get(l.tenantId) ?? []), id]);
    for (const [tenantId, ids] of byTenant) {
      await withCtx(pool, { tenantId, allClubs: true, clubIds: [] }, async (db) => {
        const due = (await db.query(`select m.id from msg_messages m join msg_conversations c on c.id = m.conversation_id
          where m.status = 'queued' and m.next_attempt_at <= now() and c.channel_id = any($1::uuid[]) order by m.created_at limit 20`, [ids])).rows;
        for (const m of due) await deliver(db, f, m.id);
      });
    }
  };
  let busy = false;
  const tick = async (full: boolean) => {
    if (busy || stopped) return; busy = true;
    try { if (full) await sync(); await flush(); } catch (e) { console.error('Telegram-аккаунты клубов:', (e as Error).message); } finally { busy = false; }
  };
  void tick(true);
  let n = 0;
  const t = setInterval(() => { n += 1; void tick(n % Math.max(1, Math.round(everyMs / 3000)) === 0); }, 3000);
  t.unref();
  return () => { stopped = true; clearInterval(t); for (const id of [...live.keys()]) disconnect(id); };
}
