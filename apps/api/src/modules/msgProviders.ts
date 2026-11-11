// Шаг 10. Подключения к мессенджерам. Один интерфейс для всех каналов:
// отправить сообщение, забрать входящие (опрос) или разобрать входящий запрос провайдера (вебхук), проверить подключение.
//  - telegram_bot — бот клуба в Telegram (Bot API). Работает и без внешнего адреса: входящие забираются опросом.
//  - green_api    — WhatsApp через Green-API (номер клуба). Тоже работает опросом.
//  - wazzup       — WhatsApp или Telegram через Wazzup. Входящие приходят только на внешний адрес (после переезда на сервер).
//  - test         — тестовый канал: отправка всегда успешна, входящие можно сымитировать из интерфейса.

export type Fetch = typeof fetch;
export type ChannelRow = { id: string; kind: string; messenger: string; settings: Record<string, string>; secret: string | null; poll_offset: string | null };
// ownPhone — клиент поделился своим номером кнопкой Telegram (а не переслал чужой контакт): только так бот узнаёт клиента
export type Inbound = { chatId: string; externalId: string; text: string; name: string; phone: string | null; at?: Date; ownPhone?: boolean };
export type PollResult = { events: Inbound[]; offset?: number | null };

export class ProviderError extends Error {}

const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; } };
const need = (v: string | null | undefined, what: string) => { if (!v) throw new ProviderError(`Не указан ${what}`); return v; };
const digits = (s: string) => s.replace(/\D/g, '');

/* ---------- Telegram Bot API ---------- */
const tg = (ch: ChannelRow, method: string) => `https://api.telegram.org/bot${need(ch.secret, 'токен бота')}/${method}`;
function tgMessage(u: Record<string, any>): Inbound | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = u.message ?? u.edited_message;
  if (!m || m.chat?.type !== 'private') return null;
  const text = m.text ?? m.caption ?? (m.contact ? `Отправил контакт: ${m.contact.phone_number}` : m.photo ? '[фото]' : m.voice ? '[голосовое сообщение]' : m.sticker ? '[стикер]' : '[вложение]');
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || (m.from?.username ? `@${m.from.username}` : 'Клиент из Telegram');
  return { chatId: String(m.chat.id), externalId: String(m.message_id), text, name, phone: m.contact?.phone_number ?? null, at: new Date(m.date * 1000),
    ownPhone: !!m.contact && m.contact.user_id != null && m.contact.user_id === m.from?.id };
}

/* ---------- Green-API (WhatsApp) ---------- */
const ga = (ch: ChannelRow, method: string) =>
  `${(ch.settings.apiUrl || 'https://api.green-api.com').replace(/\/$/, '')}/waInstance${need(ch.settings.idInstance, 'номер инстанса (idInstance)')}/${method}/${need(ch.secret, 'токен инстанса')}`;
function gaMessage(body: Record<string, any>): Inbound | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (body?.typeWebhook !== 'incomingMessageReceived') return null;
  const chatId: string = body.senderData?.chatId ?? '';
  if (!chatId.endsWith('@c.us')) return null; // группы не берём
  const md = body.messageData ?? {};
  const text = md.textMessageData?.textMessage ?? md.extendedTextMessageData?.text ?? (md.typeMessage ? `[${md.typeMessage}]` : '[сообщение]');
  return { chatId: digits(chatId), externalId: String(body.idMessage), text, name: body.senderData?.senderName || 'Клиент из WhatsApp', phone: digits(chatId),
    at: body.timestamp ? new Date(body.timestamp * 1000) : undefined };
}

/* ---------- Wazzup ---------- */
const WZ = 'https://api.wazzup24.com/v3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wazzupMessages(ch: ChannelRow, body: Record<string, any>): Inbound[] {
  return (body?.messages ?? [])
    .filter((m: any) => !m.isEcho && !m.isEchoed) // свои исходящие (эхо) не берём; eslint-disable-line @typescript-eslint/no-explicit-any
    .filter((m: any) => !ch.settings.channelId || m.channelId === ch.settings.channelId) // eslint-disable-line @typescript-eslint/no-explicit-any
    .map((m: any) => ({ chatId: String(m.chatId), externalId: String(m.messageId), text: m.text ?? `[${m.type ?? 'вложение'}]`, // eslint-disable-line @typescript-eslint/no-explicit-any
      name: m.contact?.name || (ch.messenger === 'whatsapp' ? 'Клиент из WhatsApp' : 'Клиент из Telegram'),
      phone: ch.messenger === 'whatsapp' ? digits(String(m.chatId)) : m.contact?.phone ?? null, at: m.dateTime ? new Date(m.dateTime) : undefined }));
}

/** markup — кнопки клиентского бота (только Telegram-бот; другие каналы отправляют один текст). */
export async function sendMessage(f: Fetch, ch: ChannelRow, chatId: string, text: string, markup?: unknown): Promise<{ externalId: string }> {
  if (ch.kind === 'test') return { externalId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  if (ch.kind === 'telegram_bot') {
    const r = await json(await f(tg(ch, 'sendMessage'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) }) }));
    if (!r.ok) throw new ProviderError(r.description === 'Forbidden: bot was blocked by the user' ? 'Клиент заблокировал бота' : `Telegram: ${r.description ?? 'ошибка отправки'}`);
    return { externalId: String(r.result.message_id) };
  }
  if (ch.kind === 'green_api') {
    const res = await f(ga(ch, 'sendMessage'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: `${digits(chatId)}@c.us`, message: text }) });
    const r = await json(res);
    if (!res.ok || !r.idMessage) throw new ProviderError(`WhatsApp (Green-API): ${r.message ?? r.raw ?? res.status}`);
    return { externalId: String(r.idMessage) };
  }
  if (ch.kind === 'wazzup') {
    const res = await f(`${WZ}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${need(ch.secret, 'ключ API Wazzup')}` },
      body: JSON.stringify({ channelId: need(ch.settings.channelId, 'канал Wazzup'), chatType: ch.messenger, chatId, text }) });
    const r = await json(res);
    if (!res.ok || !r.messageId) throw new ProviderError(`Wazzup: ${r.description ?? r.error ?? r.raw ?? res.status}`);
    return { externalId: String(r.messageId) };
  }
  throw new ProviderError('Неизвестный тип канала');
}

/** Забрать новые входящие опросом (Telegram-бот и Green-API). Для Wazzup и тестового канала — пусто. */
export async function poll(f: Fetch, ch: ChannelRow): Promise<PollResult> {
  if (ch.kind === 'telegram_bot') {
    const offset = ch.poll_offset ? Number(ch.poll_offset) + 1 : undefined;
    const r = await json(await f(tg(ch, `getUpdates?timeout=0&allowed_updates=${encodeURIComponent('["message","edited_message"]')}${offset ? `&offset=${offset}` : ''}`)));
    if (!r.ok) throw new ProviderError(`Telegram: ${r.description ?? 'ошибка получения сообщений'}`);
    const ups = r.result as { update_id: number }[];
    return { events: ups.map(tgMessage).filter((x): x is Inbound => !!x), offset: ups.length ? ups[ups.length - 1].update_id : ch.poll_offset ? Number(ch.poll_offset) : null };
  }
  if (ch.kind === 'green_api') {
    const events: Inbound[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await f(`${ga(ch, 'receiveNotification')}?receiveTimeout=5`);
      const r = await json(res);
      if (!res.ok) throw new ProviderError(`WhatsApp (Green-API): ${r.message ?? res.status}`);
      if (!r || !r.receiptId) break;
      const m = gaMessage(r.body);
      if (m) events.push(m);
      await f(`${ga(ch, 'deleteNotification')}/${r.receiptId}`, { method: 'DELETE' });
    }
    return { events };
  }
  return { events: [] };
}

/** Разобрать входящий запрос провайдера на наш адрес. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseWebhook(ch: ChannelRow, body: any): Inbound[] {
  if (ch.kind === 'telegram_bot') { const m = tgMessage(body ?? {}); return m ? [m] : []; }
  if (ch.kind === 'green_api') { const m = gaMessage(body ?? {}); return m ? [m] : []; }
  if (ch.kind === 'wazzup') return wazzupMessages(ch, body ?? {});
  return [];
}

/** Проверка подключения: возвращает понятное описание, что подключено. */
export async function testChannel(f: Fetch, ch: ChannelRow): Promise<string> {
  if (ch.kind === 'test') return 'Тестовый канал работает';
  if (ch.kind === 'telegram_bot') {
    const r = await json(await f(tg(ch, 'getMe')));
    if (!r.ok) throw new ProviderError(r.error_code === 401 ? 'Токен бота неверный' : `Telegram: ${r.description}`);
    return `Бот @${r.result.username} подключён`;
  }
  if (ch.kind === 'green_api') {
    const res = await f(ga(ch, 'getStateInstance'));
    const r = await json(res);
    if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'Номер инстанса или токен неверный' : `Green-API: ${res.status}`);
    if (r.stateInstance !== 'authorized') throw new ProviderError(`WhatsApp не авторизован (${r.stateInstance}): отсканируйте QR-код в личном кабинете Green-API`);
    return 'WhatsApp подключён';
  }
  if (ch.kind === 'wazzup') {
    const res = await f(`${WZ}/channels`, { headers: { Authorization: `Bearer ${need(ch.secret, 'ключ API Wazzup')}` } });
    const r = await json(res);
    if (!res.ok) throw new ProviderError(res.status === 401 ? 'Ключ API Wazzup неверный' : `Wazzup: ${res.status}`);
    const list = Array.isArray(r) ? r : [];
    const c = list.find((x: { channelId: string }) => x.channelId === ch.settings.channelId);
    if (!c) throw new ProviderError(`Канал не найден. Доступные каналы: ${list.map((x: { channelId: string; plainId?: string; transport?: string }) => `${x.transport ?? ''} ${x.plainId ?? ''} (${x.channelId})`).join(', ') || 'нет'}`);
    return `Канал Wazzup подключён (${c.transport ?? ''} ${c.plainId ?? ''}, состояние: ${c.state ?? 'неизвестно'})`;
  }
  throw new ProviderError('Неизвестный тип канала');
}
