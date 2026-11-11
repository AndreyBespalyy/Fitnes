// Клиентский Telegram-бот (список «20 улучшений», п. 18). Работает в боте клуба, который уже подключён в «Переписке»:
// клиент делится своим номером, бот узнаёт его и показывает абонемент и остаток, продлевает с оплатой по ссылке банка
// и оформляет заморозку по правилам клуба. Напоминания об окончании и долге приходят автосообщениями в тот же чат.
// Всё, что не кнопка бота, как и раньше попадает менеджеру в «Переписку».
import type { Db } from '../db.ts';
import { HttpError } from '../errors.ts';
import { normalizePhone } from './crm.ts';
import { firstName, queueMessage } from './messaging.ts';
import { addDays, clubToday, daysBetween, freezeMembership, getSettings, personMemberships } from './memberships.ts';
import type { Inbound } from './msgProviders.ts';
import { buyProducts, buySettings, placeOrder, productLine } from './onlineBuy.ts';

type Actor = { tenantId: string; userId: string | null; ip?: string };
type Ch = { id: string; club_id: string };
type State = { step?: 'renew' | 'renew_confirm' | 'freeze' | 'freeze_confirm' | 'human'; productId?: string; startsOn?: string; membershipId?: string; days?: number; options?: string[] };

export const BTN = { my: 'Мой абонемент', renew: 'Продлить', freeze: 'Заморозить', human: 'Написать в клуб', share: 'Поделиться номером', cancel: 'Отмена', pay: 'Принимаю и оплачиваю', yes: 'Да, заморозить' };
const MENU = { keyboard: [[{ text: BTN.my }, { text: BTN.renew }], [{ text: BTN.freeze }, { text: BTN.human }]], resize_keyboard: true };
const SHARE = { keyboard: [[{ text: BTN.share, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
const kb = (rows: string[][]) => ({ keyboard: rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true });
const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const appBase = () => (process.env.PUBLIC_URL || 'https://app.amoglobal.ru').replace(/\/$/, '');
const norm = (t: string) => t.trim().replace(/^\//, '').toLowerCase();
const is = (t: string, ...v: string[]) => v.some((x) => norm(t) === x.toLowerCase());

/** Ответить на сообщение клиента. null — это не команда бота: сообщение ждёт менеджера, как обычно. */
export async function clientBot(db: Db, actor: Actor, ch: Ch, convId: string, ev: Inbound): Promise<string[] | null> {
  const conv = (await db.query('select bot_state, bot_person_id, title from msg_conversations where id = $1', [convId])).rows[0];
  let state = (conv.bot_state ?? {}) as State;
  const out: string[] = [];
  const say = async (text: string, markup: unknown = MENU) => { out.push(await queueMessage(db, actor, convId, text, { auto: true, markup })); };
  const setState = async (s: State) => { state = s; await db.query('update msg_conversations set bot_state = $2 where id = $1', [convId, JSON.stringify(s)]); };
  const text = ev.text ?? '';
  let personId = conv.bot_person_id as string | null;

  // Клиент поделился своим номером: узнаём его по телефону в базе клуба
  if (ev.phone && ev.ownPhone) {
    const phone = normalizePhone(ev.phone);
    const found = phone ? (await db.query('select * from find_person_by_contact($1, $2)', [actor.tenantId, phone])).rows[0] : null;
    if (!found) {
      await say('Не нашли клиента с этим номером. Если вы уже занимаетесь у нас, напишите имя и фамилию, менеджер привяжет номер. Если ещё нет, напишите, что вас интересует, и мы ответим.', { remove_keyboard: true });
      return out;
    }
    personId = found.person_id as string;
    await db.query('update msg_conversations set bot_person_id = $2, person_id = $2, bot_state = $3 where id = $1', [convId, personId, '{}']);
    if (!(await db.query('select 1 from person_contacts where person_id = $1 and normalized_value = $2', [personId, `tg:${ev.chatId}`])).rowCount) {
      await db.query(`insert into person_contacts(tenant_id, person_id, type, value, normalized_value) values ($1,$2,'telegram',$3,$4)`, [actor.tenantId, personId, ev.name, `tg:${ev.chatId}`]);
    }
    const name = (await db.query('select full_name from persons where id = $1', [personId])).rows[0].full_name as string;
    await say(`Готово, ${firstName(name)}! Теперь здесь можно посмотреть абонемент, продлить и оплатить его или оформить заморозку.`);
    return out;
  }

  const command = is(text, 'start', 'меню', BTN.my, BTN.renew, BTN.freeze, BTN.human, BTN.cancel);
  if (!command && !state.step) return null;
  if (is(text, BTN.cancel) || is(text, 'start', 'меню')) {
    await setState({});
    if (!personId) { await say('Здравствуйте! Это бот клуба. Чтобы показать ваш абонемент, нажмите «Поделиться номером» внизу.', SHARE); return out; }
    await say(is(text, BTN.cancel) ? 'Хорошо, отменили.' : 'Здравствуйте! Выберите, что нужно.');
    return out;
  }
  if (is(text, BTN.human)) {
    await setState({ step: 'human' });
    await say('Напишите вопрос одним сообщением, менеджер клуба ответит здесь.', personId ? MENU : { remove_keyboard: true });
    return out;
  }
  if (state.step === 'human' && !command) { await setState({}); return null; }
  if (!personId) { await say('Сначала поделитесь номером телефона: так бот узнает вас и покажет только ваши данные.', SHARE); return out; }

  const today = await clubToday(db, ch.club_id);
  const mine = (await personMemberships(db, personId)).filter((m) => m.clubId === ch.club_id && m.status === 'active' && (!m.endsOn || m.endsOn >= today));

  if (is(text, BTN.my)) {
    await setState({});
    if (!mine.length) { await say('Действующего абонемента нет. Нажмите «Продлить», чтобы оформить новый.'); return out; }
    const lines = mine.map((m) => {
      const parts = [`«${m.productName}»`];
      if (m.kind === 'subscription') parts.push(m.nextChargeOn ? `подписка, следующее списание ${ru(m.nextChargeOn)}` : 'подписка');
      else if (m.endsOn) parts.push(`действует до ${ru(m.endsOn)} (осталось ${Math.max(0, daysBetween(today, m.endsOn))} дн.)`);
      if (m.visitsLeft != null) parts.push(`осталось посещений: ${m.visitsLeft}`);
      if (m.startsOn > today) parts.push(`начнётся ${ru(m.startsOn)}`);
      const fr = m.freezes.find((f) => f.startsOn <= today && (f.endedEarlyOn ? f.endedEarlyOn > today : f.endsOn >= today));
      if (fr) parts.push(`заморожен до ${ru(fr.endsOn)}`);
      return parts.join(', ');
    });
    const debt = mine.flatMap((m) => m.charges).filter((c) => c.status === 'due' && c.dueOn <= today).reduce((s, c) => s + c.amountKop, 0);
    await say(`${lines.join('\n')}${debt ? `\n\nК оплате: ${rub(debt)}. Оплатить можно на ресепшне или ответьте сюда, и мы пришлём ссылку.` : ''}`);
    return out;
  }

  /* ---------- продление ---------- */
  if (is(text, BTN.renew)) {
    const s = await buySettings(db, ch.club_id);
    const products = s.enabled ? await buyProducts(db, ch.club_id) : [];
    if (!products.length) { await setState({ step: 'human' }); await say('Продлить можно на ресепшне. Или напишите сюда удобный тариф, менеджер поможет.'); return out; }
    const list = products.slice(0, 8);
    await setState({ step: 'renew', options: list.map((p) => p.id) });
    await say(`Выберите тариф:\n${list.map((p, i) => `${i + 1}. ${p.name} — ${rub(p.priceKop)} (${productLine(p)})`).join('\n')}`,
      kb([...chunk(list.map((_, i) => String(i + 1)), 4), [BTN.cancel]]));
    return out;
  }
  if (state.step === 'renew') {
    const n = Number(text.trim()) - 1;
    const productId = state.options?.[n];
    const p = productId ? (await buyProducts(db, ch.club_id)).find((x) => x.id === productId) : null;
    if (!p) { await say('Напишите номер тарифа из списка или нажмите «Отмена».', kb([...chunk((state.options ?? []).map((_, i) => String(i + 1)), 4), [BTN.cancel]])); return out; }
    // Новый абонемент начинается после текущего, если до его окончания не больше месяца; иначе с сегодня
    const s = await buySettings(db, ch.club_id);
    const lastEnd = mine.filter((m) => m.kind !== 'subscription' && m.endsOn).map((m) => m.endsOn!).sort().pop();
    const after = lastEnd ? addDays(lastEnd, 1) : today;
    const startsOn = after > today && after <= addDays(today, s.maxStartDays) ? after : today;
    await setState({ step: 'renew_confirm', productId: p.id, startsOn });
    const docs = `${appBase()}/buy/${ch.club_id}/doc/contract`;
    await say(`«${p.name}» за ${rub(p.priceKop)}, начало ${ru(startsOn)}.\n\nНажимая «${BTN.pay}», вы принимаете договор-оферту и правила клуба (${docs}) и соглашаетесь на обработку персональных данных. После оплаты абонемент оформится сам.`,
      kb([[BTN.pay], [BTN.cancel]]));
    return out;
  }
  if (state.step === 'renew_confirm' && is(text, BTN.pay)) {
    const st = state;
    const person = (await db.query(`select p.full_name, (select normalized_value from person_contacts c where c.person_id = p.id and c.type = 'phone' order by c.is_primary desc limit 1) as phone
      from persons p where p.id = $1`, [personId])).rows[0];
    try {
      const r = await placeOrder(db, fetch, actor, ch.club_id, { productId: st.productId, name: person.full_name, phone: person.phone ?? undefined, startsOn: st.startsOn, offer: true, consent: true },
        { ip: 'telegram', ua: 'Telegram-бот клуба', base: appBase(), personId });
      await setState({});
      await say(`Оплатите по ссылке, она действует 2 часа:\n${r.payUrl}\n\nКак только оплата пройдёт, я пришлю подтверждение.`);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await setState({});
      await say(`${e.message}. Можно продлить на ресепшне или написать сюда, менеджер поможет.`);
    }
    return out;
  }

  /* ---------- заморозка ---------- */
  if (is(text, BTN.freeze)) {
    const s = await getSettings(db, ch.club_id);
    const m = mine.find((x) => x.kind !== 'subscription' && x.freezeAllowed);
    if (!s.freezeEnabled || !m) {
      await setState({});
      await say(mine.some((x) => x.kind === 'subscription') ? 'Подписку не замораживают. Если нужно приостановить списания, напишите сюда, менеджер поможет.' : 'Для вашего абонемента заморозка не предусмотрена. Если есть вопрос, нажмите «Написать в клуб».');
      return out;
    }
    await setState({ step: 'freeze', membershipId: m.id });
    await say(`На сколько дней заморозить «${m.productName}»? Напишите число: от ${s.freezeMinDays} до ${s.freezeMaxDaysPerYear} дней за год. Заморозка начнётся завтра.${s.freezePaid && s.freezePriceKop ? ` Стоимость заморозки ${rub(s.freezePriceKop)}.` : ''}`,
      kb([['7', '14', '30'], [BTN.cancel]]));
    return out;
  }
  if (state.step === 'freeze') {
    const days = Number(text.trim());
    if (!Number.isInteger(days) || days < 1 || days > 365) { await say('Напишите число дней, например 14, или нажмите «Отмена».', kb([['7', '14', '30'], [BTN.cancel]])); return out; }
    const m = mine.find((x) => x.id === state.membershipId);
    if (!m) { await setState({}); await say('Абонемент уже не действует.'); return out; }
    const startsOn = addDays(today, 1);
    await setState({ step: 'freeze_confirm', membershipId: m.id, days, startsOn });
    await say(`Заморозить «${m.productName}» с ${ru(startsOn)} по ${ru(addDays(startsOn, days - 1))}? Абонемент продлится до ${ru(addDays(m.endsOn!, days))}.`, kb([[BTN.yes], [BTN.cancel]]));
    return out;
  }
  if (state.step === 'freeze_confirm' && is(text, BTN.yes)) {
    const st = state;
    await setState({});
    try {
      await db.query('savepoint bot_freeze');
      const r = await freezeMembership(db, { tenantId: actor.tenantId, userId: null as unknown as string, ip: 'telegram' }, st.membershipId!, { startsOn: st.startsOn, days: st.days });
      const s = await getSettings(db, ch.club_id);
      await say(`Готово: абонемент заморожен с ${ru(r.startsOn)} по ${ru(r.endsOn)} и теперь действует до ${ru(r.membershipEndsOn)}.${s.freezePaid && s.freezePriceKop ? ` Оплатить заморозку ${rub(s.freezePriceKop)} можно на ресепшне.` : ''}`);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await db.query('rollback to savepoint bot_freeze');
      await say(`Не получилось: ${e.message}. Если нужна помощь, нажмите «Написать в клуб».`);
    }
    return out;
  }
  // Нажал кнопку не того шага: начинаем заново
  await setState({});
  await say('Выберите, что нужно.');
  return out;
}

/** После онлайн-оплаты из бота сообщить клиенту, что абонемент оформлен. */
export async function botNotifyPaid(db: Db, actor: Actor, personId: string, clubId: string, text: string) {
  const conv = (await db.query(`select c.id from msg_conversations c join msg_channels ch on ch.id = c.channel_id
    where c.bot_person_id = $1 and c.club_id = $2 and ch.client_bot and ch.status = 'active' order by c.last_inbound_at desc nulls last limit 1`, [personId, clubId])).rows[0];
  if (conv) await queueMessage(db, actor, conv.id, text, { auto: true, markup: MENU });
}

function chunk<T>(a: T[], n: number) { const r: T[][] = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; }
