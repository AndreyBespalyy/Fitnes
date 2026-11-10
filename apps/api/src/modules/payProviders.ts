// Шаг 12. Подключения к эквайрингу. Один интерфейс для всех банков:
// создать оплату по ссылке, узнать её состояние, списать с сохранённой карты, проверить подключение.
//  - test     — встроенный «Тестовый банк»: страница оплаты внутри системы, деньги не двигаются.
//  - yookassa — ЮKassa (API v3). В тестовом магазине ЮKassa ключи тестовые, адрес тот же.
//  - tbank    — Т-Банк (интернет-эквайринг API v2). Тестовый терминал оканчивается на DEMO.
// Смена банка или переход с песочницы на боевой режим — только настройка клуба, код не меняется.
import { createHash } from 'node:crypto';

export type Fetch = typeof fetch;
export type Acq = { provider: string; live: boolean; shopId: string | null; secret: string | null };
export type PayState = { status: 'pending' | 'succeeded' | 'failed' | 'cancelled'; method?: 'card' | 'sbp' | null; saved?: { token: string; title: string } | null; error?: string | null };
export class PayError extends Error {}

const need = (v: string | null | undefined, what: string) => { if (!v) throw new PayError(`Не указан ${what}`); return v; };
const rub = (kop: number) => (kop / 100).toFixed(2);
const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; } };

/* ---------- ЮKassa ---------- */
const YK = 'https://api.yookassa.ru/v3';
const ykHeaders = (a: Acq, idem?: string) => ({
  Authorization: `Basic ${Buffer.from(`${need(a.shopId, 'shopId магазина')}:${need(a.secret, 'секретный ключ')}`).toString('base64')}`,
  'Content-Type': 'application/json', ...(idem ? { 'Idempotence-Key': idem } : {}),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ykState(p: any): PayState {
  const pm = p.payment_method ?? {};
  const method = pm.type === 'sbp' ? 'sbp' : pm.type ? 'card' : null;
  const saved = pm.saved && pm.id ? { token: String(pm.id), title: pm.card ? `${pm.card.card_type ?? 'Карта'} •••• ${pm.card.last4}` : 'Сохранённый способ оплаты' } : null;
  if (p.status === 'succeeded') return { status: 'succeeded', method, saved };
  if (p.status === 'canceled') {
    const r = p.cancellation_details?.reason;
    const why: Record<string, string> = { insufficient_funds: 'Недостаточно средств', card_expired: 'Срок карты истёк', expired_on_confirmation: 'Клиент не завершил оплату', permission_revoked: 'Клиент отозвал разрешение на списания', fraud_suspected: 'Банк заподозрил мошенничество', general_decline: 'Банк отказал' };
    return { status: r === 'expired_on_confirmation' ? 'cancelled' : 'failed', method, error: why[r] ?? r ?? 'Оплата отменена' };
  }
  return { status: 'pending', method };
}

/* ---------- Т-Банк ---------- */
const TB = 'https://securepay.tinkoff.ru/v2';
/** Подпись запроса Т-Банка: значения корневых полей + пароль, отсортированные по имени поля, SHA-256. */
export function tbankToken(params: Record<string, unknown>, password: string) {
  const flat: Record<string, string> = { Password: password };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && typeof v !== 'object' && k !== 'Token') flat[k] = String(v);
  return createHash('sha256').update(Object.keys(flat).sort().map((k) => flat[k]).join('')).digest('hex');
}
async function tb(f: Fetch, a: Acq, method: string, params: Record<string, unknown>) {
  const body = { TerminalKey: need(a.shopId, 'TerminalKey терминала'), ...params };
  const r = await json(await f(`${TB}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, Token: tbankToken(body, need(a.secret, 'пароль терминала')) }) }));
  if (r.Success === false || (r.ErrorCode && r.ErrorCode !== '0')) throw new PayError(`Т-Банк: ${r.Message ?? 'ошибка'}${r.Details ? ` (${r.Details})` : ''}`);
  return r;
}
const TB_DONE = ['CONFIRMED', 'AUTHORIZED'];
const TB_FAIL = ['REJECTED', 'AUTH_FAIL'];
const TB_CANCEL = ['CANCELED', 'DEADLINE_EXPIRED', 'REVERSED', 'REFUNDED'];

/* ---------- общий интерфейс ---------- */
export async function createPayment(f: Fetch, a: Acq, p: { id: string; amountKop: number; description: string; returnUrl: string; notifyUrl: string | null; save: boolean; customerKey: string }) {
  if (a.provider === 'test') return { externalId: `test-${p.id}`, url: null as string | null };
  if (a.provider === 'yookassa') {
    const r = await json(await f(`${YK}/payments`, { method: 'POST', headers: ykHeaders(a, p.id), body: JSON.stringify({
      amount: { value: rub(p.amountKop), currency: 'RUB' }, capture: true, confirmation: { type: 'redirect', return_url: p.returnUrl },
      description: p.description.slice(0, 128), save_payment_method: p.save, metadata: { op: p.id } }) }));
    if (!r.id) throw new PayError(`ЮKassa: ${r.description ?? r.raw ?? 'не удалось создать оплату'}`);
    return { externalId: String(r.id), url: r.confirmation?.confirmation_url as string };
  }
  if (a.provider === 'tbank') {
    const r = await tb(f, a, 'Init', { Amount: p.amountKop, OrderId: p.id, Description: p.description.slice(0, 140), SuccessURL: p.returnUrl, FailURL: p.returnUrl,
      ...(p.notifyUrl ? { NotificationURL: p.notifyUrl } : {}), ...(p.save ? { Recurrent: 'Y', CustomerKey: p.customerKey } : {}) });
    return { externalId: String(r.PaymentId), url: r.PaymentURL as string };
  }
  throw new PayError('Неизвестный банк');
}

export async function getPayment(f: Fetch, a: Acq, externalId: string, o: { save: boolean; customerKey: string }): Promise<PayState> {
  if (a.provider === 'yookassa') {
    const r = await json(await f(`${YK}/payments/${encodeURIComponent(externalId)}`, { headers: ykHeaders(a) }));
    if (!r.id) throw new PayError(`ЮKassa: ${r.description ?? 'нет ответа'}`);
    return ykState(r);
  }
  if (a.provider === 'tbank') {
    const r = await tb(f, a, 'GetState', { PaymentId: externalId });
    if (TB_DONE.includes(r.Status)) {
      let saved: PayState['saved'] = null;
      if (o.save) {
        const cards = await tb(f, a, 'GetCardList', { CustomerKey: o.customerKey }).catch(() => []);
        const c = (Array.isArray(cards) ? cards : []).filter((x: { RebillId?: string; Status?: string }) => x.RebillId && x.Status !== 'D').pop();
        if (c) saved = { token: String(c.RebillId), title: `Карта ${String(c.Pan ?? '').replace(/^.*(\d{4})$/, '•••• $1')}` };
      }
      return { status: 'succeeded', method: r.PaymentMethod === 'SBP' ? 'sbp' : 'card', saved };
    }
    if (TB_FAIL.includes(r.Status)) return { status: 'failed', error: 'Банк отказал в оплате' };
    if (TB_CANCEL.includes(r.Status)) return { status: 'cancelled', error: 'Оплата отменена или истёк срок' };
    return { status: 'pending' };
  }
  throw new PayError('Неизвестный банк');
}

/** Списание с сохранённой карты без участия клиента (автосписание подписки). */
export async function chargeSaved(f: Fetch, a: Acq, p: { id: string; amountKop: number; description: string; token: string; customerKey: string }): Promise<PayState & { externalId: string }> {
  if (a.provider === 'test') {
    // Тестовые карты: оканчивается на 0002 — банк отказывает, на 9995 — «недостаточно средств»
    if (p.token.endsWith('0002')) return { externalId: `test-${p.id}`, status: 'failed', error: 'Банк отказал' };
    if (p.token.endsWith('9995')) return { externalId: `test-${p.id}`, status: 'failed', error: 'Недостаточно средств' };
    return { externalId: `test-${p.id}`, status: 'succeeded', method: 'card' };
  }
  if (a.provider === 'yookassa') {
    const r = await json(await f(`${YK}/payments`, { method: 'POST', headers: ykHeaders(a, p.id), body: JSON.stringify({
      amount: { value: rub(p.amountKop), currency: 'RUB' }, capture: true, payment_method_id: p.token, description: p.description.slice(0, 128), metadata: { op: p.id } }) }));
    if (!r.id) throw new PayError(`ЮKassa: ${r.description ?? 'не удалось списать'}`);
    return { externalId: String(r.id), ...ykState(r) };
  }
  if (a.provider === 'tbank') {
    const init = await tb(f, a, 'Init', { Amount: p.amountKop, OrderId: p.id, Description: p.description.slice(0, 140), CustomerKey: p.customerKey });
    try {
      const r = await tb(f, a, 'Charge', { PaymentId: init.PaymentId, RebillId: p.token });
      return { externalId: String(init.PaymentId), ...(TB_DONE.includes(r.Status) ? { status: 'succeeded', method: 'card' } : { status: 'pending' }) } as PayState & { externalId: string };
    } catch (e) { return { externalId: String(init.PaymentId), status: 'failed', error: (e as Error).message }; }
  }
  throw new PayError('Неизвестный банк');
}

export async function checkConnection(f: Fetch, a: Acq): Promise<string> {
  if (a.provider === 'test') return 'Тестовый банк работает. Деньги не списываются';
  if (a.provider === 'yookassa') {
    const res = await f(`${YK}/me`, { headers: ykHeaders(a) });
    const r = await json(res);
    if (res.status === 401) throw new PayError('ЮKassa: неверный shopId или секретный ключ');
    if (!res.ok) throw new PayError(`ЮKassa: ${r.description ?? res.status}`);
    if (a.live && r.test) throw new PayError('ЮKassa: это ключи тестового магазина, а выбран боевой режим');
    return `ЮKassa подключена${r.test ? ' (тестовый магазин)' : ''}`;
  }
  if (a.provider === 'tbank') {
    if (a.live && /DEMO$/i.test(a.shopId ?? '')) throw new PayError('Т-Банк: это тестовый терминал (…DEMO), а выбран боевой режим');
    try { await tb(f, a, 'GetCardList', { CustomerKey: 'check-connection' }); } catch (e) {
      const m = (e as Error).message;
      if (/токен|token|термин/i.test(m)) throw e; // неверный ключ или пароль
    }
    return `Т-Банк подключён${/DEMO$/i.test(a.shopId ?? '') ? ' (тестовый терминал)' : ''}`;
  }
  throw new PayError('Неизвестный банк');
}

/** Уведомление банка: из тела достаём номер оплаты у банка. Состояние всё равно перепроверяем запросом к банку. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notificationId(a: Acq, body: any): string | null {
  if (a.provider === 'yookassa') return body?.object?.id ? String(body.object.id) : null;
  if (a.provider === 'tbank') {
    if (!body?.PaymentId || !a.secret || body.Token !== tbankToken(body, a.secret)) return null;
    return String(body.PaymentId);
  }
  return null;
}
