// Шаг 10. Переписка с клиентами в Telegram и WhatsApp: каналы клуба, единое окно, входящие → лиды с меткой источника,
// шаблоны, автосообщения по событиям (окончание абонемента, долг, давно не был, день рождения, приветствие),
// согласия и отписка, лимит частоты, автоответ в нерабочее время.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { createLead, normalizePhone } from './crm.ts';
import { decrypt, encrypt } from './fiscal.ts';
import { addDays, clubToday } from './memberships.ts';
import { parseWebhook, poll, ProviderError, sendMessage, testChannel, type ChannelRow, type Fetch, type Inbound } from './msgProviders.ts';

type Actor = { tenantId: string; userId: string | null; ip?: string };
type Channel = ChannelRow & { club_id: string; tenant_id: string; name: string; status: string };
const KINDS: Record<string, { name: string; messengers: string[]; polling: boolean }> = {
  telegram_bot: { name: 'Telegram-бот клуба', messengers: ['telegram'], polling: true },
  green_api: { name: 'WhatsApp через Green-API', messengers: ['whatsapp'], polling: true },
  wazzup: { name: 'WhatsApp или Telegram через Wazzup', messengers: ['whatsapp', 'telegram'], polling: false },
  test: { name: 'Тестовый канал', messengers: ['whatsapp', 'telegram'], polling: false },
};
const STOP = /^\s*(стоп|stop|отписаться|отписка)\s*[.!]?\s*$/i;
const MAX_ATTEMPTS = 5;

async function loadChannel(db: Db, id: string): Promise<Channel> {
  const c = (await db.query('select * from msg_channels where id = $1', [id])).rows[0];
  if (!c) throw notFound('Канал не найден');
  return { ...c, secret: c.secret_enc ? decrypt(c.secret_enc) : null };
}

/** «Иванова Мария Сергеевна» → «Мария», «Павел Рябов» → «Павел». */
export function firstName(full: string) {
  const w = full.trim().split(/\s+/);
  return w.length >= 3 ? w[1] : w[0] || '';
}
const ru = (d: string | null | undefined) => (d ? d.split('-').reverse().join('.') : '');
const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** Подстановка в шаблон: {имя}, {клуб}, {абонемент}, {дата_окончания}, {долг}, {дата_платежа}, {дней}. */
export async function renderTemplate(db: Db, body: string, personId: string | null, clubId: string, extra: Record<string, string> = {}) {
  // «Клуб «Центр»» → «Центр»: в шаблонах уже написано «в клубе {клуб}»
  const club = String((await db.query('select name from clubs where id = $1', [clubId])).rows[0]?.name ?? '').replace(/^клуб\s+/i, '');
  const vars: Record<string, string> = { клуб: club, имя: '', абонемент: '', дата_окончания: '', долг: '', дата_платежа: '', дней: '' };
  if (personId) {
    const p = (await db.query('select full_name from persons where id = $1', [personId])).rows[0];
    vars.имя = p ? firstName(p.full_name) : '';
    const m = (await db.query(`select product_name, to_char(ends_on, 'YYYY-MM-DD') as e from memberships where person_id = $1 and club_id = $2 and status = 'active'
      order by ends_on desc nulls first limit 1`, [personId, clubId])).rows[0];
    if (m) { vars.абонемент = m.product_name; vars.дата_окончания = ru(m.e); }
    const d = (await db.query(`select coalesce(sum(amount_kop), 0) as s, to_char(min(due_on), 'YYYY-MM-DD') as due from charges where person_id = $1 and club_id = $2 and status = 'due'
      and due_on <= (now() at time zone (select timezone from clubs where id = $2))::date`, [personId, clubId])).rows[0];
    if (Number(d.s)) { vars.долг = rub(Number(d.s)); vars.дата_платежа = ru(d.due); }
  }
  Object.assign(vars, extra);
  return body.replace(/\{([а-яё_]+)\}/gi, (all, k: string) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : all)).replace(/[ \t]+([,.!?])/g, '$1').trim();
}

/* ---------- входящие ---------- */
async function clubHour(db: Db, clubId: string) {
  return Number((await db.query(`select extract(hour from now() at time zone timezone)::int as h from clubs where id = $1`, [clubId])).rows[0].h);
}
async function settingsOf(db: Db, clubId: string) {
  const s = (await db.query('select * from club_msg_settings where club_id = $1', [clubId])).rows[0];
  return s ?? { work_from: 9, work_to: 21, autoreply_enabled: true, autoreply_text: 'Здравствуйте! Мы получили ваше сообщение. Менеджер ответит в рабочее время.', max_auto_per_week: 2 };
}

/** Входящее сообщение: находит или создаёт диалог и клиента (новый — это лид с источником Telegram или WhatsApp). */
export async function handleInbound(db: Db, actor: Actor, ch: Channel, ev: Inbound) {
  let conv = (await db.query('select * from msg_conversations where channel_id = $1 and external_chat_id = $2', [ch.id, ev.chatId])).rows[0];
  if (conv && (await db.query('select 1 from msg_messages where conversation_id = $1 and direction = $2 and external_id = $3', [conv.id, 'in', ev.externalId])).rowCount) {
    return { duplicate: true, conversationId: conv.id as string, autoreplyId: null as string | null };
  }
  const phone = ch.messenger === 'whatsapp' ? normalizePhone(ev.phone ?? ev.chatId) : normalizePhone(ev.phone);
  const tgContact = ch.messenger === 'telegram' ? { type: 'telegram' as const, value: ev.name, normalized: `tg:${ev.chatId}` } : undefined;
  const recent = conv?.last_inbound_at && Date.now() - new Date(conv.last_inbound_at).getTime() < 30 * 86_400_000;
  let personId: string | null = conv?.person_id ?? null;
  let assignee: string | null = conv?.assigned_to ?? null;
  // Новое обращение (впервые или после месяца тишины) — заявка с меткой канала; повторное у известного клиента не плодит клиентов
  // Действующий клиент клуба пишет по своим делам — это не продажа, заявку не создаём
  if (!personId) {
    for (const v of [phone, tgContact?.normalized].filter((x): x is string => !!x)) {
      const found = (await db.query('select * from find_person_by_contact($1, $2)', [actor.tenantId, v])).rows[0];
      if (found) { personId = found.person_id; break; }
    }
  }
  const activeClient = personId ? !!(await db.query(`select 1 from memberships where person_id = $1 and club_id = $2 and status = 'active'
    and starts_on <= (now() at time zone (select timezone from clubs where id = $2))::date
    and (ends_on is null or ends_on >= (now() at time zone (select timezone from clubs where id = $2))::date)`, [personId, ch.club_id])).rowCount : false;
  if (activeClient && !assignee) {
    assignee = (await db.query(`select o.owner_id from opportunities o where o.person_id = $1 and o.club_id = $2 order by o.created_at desc limit 1`, [personId, ch.club_id])).rows[0]?.owner_id ?? null;
  }
  if (!recent && !activeClient) {
    try {
      await db.query('savepoint inbound_lead');
      const lead = await createLead(db, actor, { clubId: ch.club_id, fullName: ev.name, phone: phone ?? undefined, contact: phone ? undefined : tgContact,
        sourceCode: ch.messenger, comment: `${ch.messenger === 'whatsapp' ? 'WhatsApp' : 'Telegram'}: ${ev.text.slice(0, 300)}`,
        externalEventId: `msg:${ch.id}:${ev.chatId}:${ev.externalId}` });
      personId = lead.personId;
      assignee = (await db.query('select assigned_to from leads where id = $1', [lead.leadId])).rows[0]?.assigned_to ?? assignee;
      if (tgContact && !(await db.query('select 1 from person_contacts where person_id = $1 and normalized_value = $2', [personId, tgContact.normalized])).rowCount) {
        await db.query(`insert into person_contacts(tenant_id, person_id, type, value, normalized_value) values ($1,$2,'telegram',$3,$4)`, [actor.tenantId, personId, ev.name, tgContact.normalized]);
      }
    } catch (e) {
      // Без воронки в клубе заявка не создаётся, но сообщение всё равно сохраняем
      if (!(e instanceof HttpError)) throw e;
      await db.query('rollback to savepoint inbound_lead');
    }
  }
  if (!conv) {
    conv = (await db.query(`insert into msg_conversations(tenant_id, club_id, channel_id, person_id, external_chat_id, title, assigned_to)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`, [actor.tenantId, ch.club_id, ch.id, personId, ev.chatId, ev.name, assignee])).rows[0];
  } else if (!conv.person_id && personId) {
    await db.query('update msg_conversations set person_id = $2, assigned_to = coalesce(assigned_to, $3) where id = $1', [conv.id, personId, assignee]);
  }
  await db.query(`insert into msg_messages(tenant_id, club_id, conversation_id, direction, body, status, external_id, created_at)
    values ($1,$2,$3,'in',$4,'received',$5,coalesce($6, now()))`, [actor.tenantId, ch.club_id, conv.id, ev.text, ev.externalId, ev.at ?? null]);
  await db.query(`update msg_conversations set last_message_at = now(), last_inbound_at = now(), unread = unread + 1 where id = $1`, [conv.id]);
  personId = personId ?? conv.person_id;
  if (personId && STOP.test(ev.text)) {
    await db.query('update persons set messaging_opt_out = true, messaging_changed_at = now() where id = $1', [personId]);
    await audit(db, actor, 'person.messaging_opt_out', 'person', personId, null, { via: ch.messenger });
  }
  // Автоответ в нерабочее время, не чаще раза в 12 часов
  let autoreplyId: string | null = null;
  const s = await settingsOf(db, ch.club_id);
  const h = await clubHour(db, ch.club_id);
  const offHours = h < s.work_from || h >= s.work_to;
  const lastAuto = conv.last_autoreply_at ? new Date(conv.last_autoreply_at).getTime() : 0;
  if (offHours && s.autoreply_enabled && Date.now() - lastAuto > 12 * 3_600_000 && !STOP.test(ev.text)) {
    autoreplyId = await queueMessage(db, actor, conv.id, s.autoreply_text, { auto: true });
    await db.query('update msg_conversations set last_autoreply_at = now() where id = $1', [conv.id]);
  }
  return { duplicate: false, conversationId: conv.id as string, personId, autoreplyId };
}

/* ---------- исходящие ---------- */
export async function queueMessage(db: Db, actor: Actor, conversationId: string, text: string, o: { auto?: boolean; templateId?: string | null; triggerId?: string | null } = {}) {
  const c = (await db.query('select club_id from msg_conversations where id = $1', [conversationId])).rows[0];
  return (await db.query(`insert into msg_messages(tenant_id, club_id, conversation_id, direction, body, status, author_id, template_id, trigger_id, auto, next_attempt_at)
    values ($1,$2,$3,'out',$4,'queued',$5,$6,$7,$8,now()) returning id`,
  [actor.tenantId, c.club_id, conversationId, text, o.auto ? null : actor.userId, o.templateId ?? null, o.triggerId ?? null, !!o.auto])).rows[0].id as string;
}

/** Отправка через провайдера. Ошибка не теряет сообщение: повтор через 1, 2, 4, 8 минут, потом «не отправлено». */
export async function deliver(db: Db, f: Fetch, messageId: string) {
  const m = (await db.query(`select m.*, c.external_chat_id, c.channel_id from msg_messages m join msg_conversations c on c.id = m.conversation_id where m.id = $1 for update of m`, [messageId])).rows[0];
  if (!m || m.status !== 'queued') return m?.status ?? null;
  const ch = await loadChannel(db, m.channel_id);
  try {
    if (ch.status !== 'active') throw new ProviderError('Канал отключён');
    const r = await sendMessage(f, ch, m.external_chat_id, m.body);
    await db.query(`update msg_messages set status = 'sent', external_id = $2, sent_at = now(), error = null, attempts = attempts + 1, next_attempt_at = null where id = $1`, [messageId, r.externalId]);
    await db.query('update msg_channels set last_ok_at = now(), last_error = null where id = $1', [ch.id]);
    return 'sent';
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : `Нет связи с ${KINDS[ch.kind]?.name ?? 'провайдером'}`;
    const attempts = Number(m.attempts) + 1;
    const final = attempts >= MAX_ATTEMPTS || msg === 'Клиент заблокировал бота' || msg === 'Канал отключён';
    await db.query(`update msg_messages set status = $2, error = $3, attempts = $4, next_attempt_at = $5 where id = $1`,
      [messageId, final ? 'failed' : 'queued', msg, attempts, final ? null : new Date(Date.now() + 2 ** (attempts - 1) * 60_000)]);
    await db.query('update msg_channels set last_error = $2 where id = $1', [ch.id, msg]);
    return final ? 'failed' : 'queued';
  }
}

/** Ответ менеджера закрывает «первый ответ» по заявкам этого клиента. */
async function markFirstResponse(db: Db, personId: string | null, clubId: string) {
  if (!personId) return;
  const leads = (await db.query(`update leads set first_response_at = now() where person_id = $1 and club_id = $2 and first_response_at is null returning id`, [personId, clubId])).rows.map((r) => r.id);
  if (leads.length) await db.query(`update tasks set done_at = now(), result = 'Ответил клиенту в мессенджере' where lead_id = any($1) and kind = 'first_response' and done_at is null`, [leads]);
}

/* ---------- автосообщения ---------- */
type Candidate = { personId: string; name: string; key: string; extra: Record<string, string> };
async function candidates(db: Db, t: { event: string; days: number; club_id: string }, today: string): Promise<Candidate[]> {
  const q = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows as (Candidate & { person_id: string; full_name: string; k: string; dn?: string })[];
  let rows: { person_id: string; full_name: string; k: string; dn?: string }[] = [];
  if (t.event === 'membership_ending') {
    rows = await q(`select m.person_id, p.full_name, m.id::text as k from memberships m join persons p on p.id = m.person_id
      where m.club_id = $1 and m.status = 'active' and m.ends_on > $2 and m.ends_on <= $3 and m.kind <> 'subscription'
        and not exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = m.club_id and n.status = 'active' and n.id <> m.id and n.starts_on >= m.ends_on)`,
    [t.club_id, today, addDays(today, t.days)]);
  } else if (t.event === 'debt_overdue') {
    rows = await q(`select ch.person_id, p.full_name, ch.id::text as k from charges ch join persons p on p.id = ch.person_id
      where ch.club_id = $1 and ch.status = 'due' and ch.due_on <= $2`, [t.club_id, addDays(today, -t.days)]);
  } else if (t.event === 'inactive') {
    rows = await q(`select x.person_id, x.full_name, 'с ' || coalesce(x.last::text, x.started::text) as k, ($2::date - coalesce(x.last, x.started))::text as dn from (
        select m.person_id, p.full_name, min(m.starts_on) as started,
          (select max((v.visited_at at time zone c.timezone)::date) from visits v where v.person_id = m.person_id and v.club_id = m.club_id) as last
        from memberships m join persons p on p.id = m.person_id join clubs c on c.id = m.club_id
        where m.club_id = $1 and m.status = 'active' and m.starts_on <= $2 and (m.ends_on is null or m.ends_on >= $2)
        group by m.person_id, p.full_name) x
      where coalesce(x.last, x.started) <= $3`, [t.club_id, today, addDays(today, -t.days)]);
  } else if (t.event === 'birthday') {
    rows = await q(`select p.id as person_id, p.full_name, extract(year from $2::date)::text as k from persons p
      where p.birth_date is not null and to_char(p.birth_date, 'MM-DD') = to_char($2::date, 'MM-DD') and p.merged_into_id is null
        and (p.home_club_id = $1 or exists (select 1 from memberships m where m.person_id = p.id and m.club_id = $1))`, [t.club_id, today]);
  } else if (t.event === 'welcome') {
    rows = await q(`select m.person_id, p.full_name, m.id::text as k from memberships m join persons p on p.id = m.person_id
      where m.club_id = $1 and m.status = 'active' and m.import_batch_id is null and m.created_at >= now() - interval '2 days'
        and not exists (select 1 from memberships o where o.person_id = m.person_id and o.id <> m.id and o.created_at < m.created_at)`, [t.club_id]);
  } else if (t.event === 'ai_nurture') {
    // Неприоритетные по оценке ИИ (шаг 15): не чаще раза в t.days дней, с предложением по действующему прейскуранту
    rows = await q(`select s.person_id, p.full_name, 'ai:' || floor(($2::date - date '2026-01-01') / greatest($3::int, 1))::text as k,
        case when s.offer ? 'name' then '«' || (s.offer ->> 'name') || '» за ' || to_char(((s.offer ->> 'priceKop')::bigint / 100), 'FM999 999 999') || ' ₽' else 'абонемент' end as dn
      from client_scores s join persons p on p.id = s.person_id
      where s.club_id = $1 and s.segment = 'auto' and s.kind in ('purchase', 'return') order by s.score desc limit 200`, [t.club_id, today, t.days]);
    const seenAi = new Set<string>();
    return rows.filter((r) => !seenAi.has(r.person_id) && seenAi.add(r.person_id)).map((r) => ({ personId: r.person_id, name: r.full_name, key: r.k, extra: { предложение: r.dn ?? 'абонемент' } }));
  }
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.person_id) && seen.add(r.person_id)).map((r) => ({ personId: r.person_id, name: r.full_name, key: r.k, extra: (r.dn ? { дней: r.dn } : {}) as Record<string, string> }));
}

/** Диалог для автосообщения: последний живой диалог клиента в клубе, иначе новый в WhatsApp по телефону. */
export async function conversationFor(db: Db, actor: Actor, personId: string, clubId: string, create: boolean) {
  const c = (await db.query(`select c.id from msg_conversations c join msg_channels ch on ch.id = c.channel_id
    where c.person_id = $1 and c.club_id = $2 and ch.status = 'active' order by c.last_message_at desc nulls last limit 1`, [personId, clubId])).rows[0];
  if (c) return c.id as string;
  const phone = (await db.query(`select normalized_value from person_contacts where person_id = $1 and type = 'phone' order by is_primary desc limit 1`, [personId])).rows[0]?.normalized_value;
  const wa = (await db.query(`select id from msg_channels where club_id = $1 and messenger = 'whatsapp' and status = 'active' order by created_at limit 1`, [clubId])).rows[0];
  if (!phone || !wa) return null;
  if (!create) return 'new';
  const p = (await db.query('select full_name from persons where id = $1', [personId])).rows[0];
  return (await db.query(`insert into msg_conversations(tenant_id, club_id, channel_id, person_id, external_chat_id, title) values ($1,$2,$3,$4,$5,$6)
    on conflict (channel_id, external_chat_id) do update set person_id = coalesce(msg_conversations.person_id, excluded.person_id) returning id`,
  [actor.tenantId, clubId, wa.id, personId, phone.replace(/\D/g, ''), p.full_name])).rows[0].id as string;
}

export type TriggerResult = { triggerId: string; event: string; ready: { personId: string; name: string; text: string }[]; skipped: { personId: string; name: string; reason: string }[]; sent: number };
export async function runTriggers(db: Db, f: Fetch, actor: Actor, clubId: string, o: { dryRun: boolean; onlyTriggerId?: string; force?: boolean }) {
  const today = await clubToday(db, clubId);
  const s = await settingsOf(db, clubId);
  const h = await clubHour(db, clubId);
  const triggers = (await db.query(`select t.*, tp.body from msg_triggers t join msg_templates tp on tp.id = t.template_id
    where t.club_id = $1 and ($2::uuid is null or t.id = $2) and ($3 or t.enabled) order by t.event`, [clubId, o.onlyTriggerId ?? null, o.dryRun])).rows;
  const out: TriggerResult[] = [];
  for (const t of triggers) {
    const r: TriggerResult = { triggerId: t.id, event: t.event, ready: [], skipped: [], sent: 0 };
    out.push(r);
    // Автосообщения уходят только в рабочее время клуба и не раньше выбранного часа
    if (!o.dryRun && !o.force && (h < t.send_hour || h < s.work_from || h >= s.work_to)) continue;
    for (const c of await candidates(db, t, today)) {
      if ((await db.query('select 1 from msg_trigger_sends where trigger_id = $1 and person_id = $2 and period_key = $3', [t.id, c.personId, c.key])).rowCount) continue;
      const p = (await db.query('select marketing_consent, messaging_opt_out from persons where id = $1', [c.personId])).rows[0];
      const skip = (reason: string) => r.skipped.push({ personId: c.personId, name: c.name, reason });
      if (p.messaging_opt_out) { skip('клиент отписался от сообщений'); continue; }
      if (t.marketing && !p.marketing_consent) { skip('нет согласия на рекламные сообщения'); continue; }
      const week = Number((await db.query(`select count(*) from msg_trigger_sends where person_id = $1 and club_id = $2 and created_at > now() - interval '7 days'`, [c.personId, clubId])).rows[0].count);
      if (week >= s.max_auto_per_week) { skip(`лимит: уже ${week} автосообщ. за неделю`); continue; }
      const conv = await conversationFor(db, actor, c.personId, clubId, !o.dryRun);
      if (!conv) { skip('нет мессенджера: клиент не писал в Telegram и в клубе не подключён WhatsApp'); continue; }
      const text = await renderTemplate(db, t.body, c.personId, clubId, c.extra);
      r.ready.push({ personId: c.personId, name: c.name, text });
      if (o.dryRun) continue;
      const mid = await queueMessage(db, actor, conv, text, { auto: true, templateId: t.template_id, triggerId: t.id });
      await db.query(`insert into msg_trigger_sends(tenant_id, club_id, trigger_id, person_id, period_key, message_id) values ($1,$2,$3,$4,$5,$6)`,
        [actor.tenantId, clubId, t.id, c.personId, c.key, mid]);
      await db.query('update msg_conversations set last_message_at = now() where id = $1', [conv]);
      await deliver(db, f, mid);
      r.sent++;
    }
  }
  return out;
}

/* ---------- фоновая работа ---------- */
export async function processMessaging(pool: pg.Pool, f: Fetch, o: { triggers: boolean }) {
  const tenants = (await pool.query('select tenant_id from msg_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const actor = { tenantId, userId: null };
    const channels = await withCtx(pool, sys, async (db) => (await db.query(`select id from msg_channels where status = 'active' and kind in ('telegram_bot', 'green_api')`)).rows);
    for (const { id } of channels) {
      await withCtx(pool, sys, async (db) => {
        const ch = await loadChannel(db, id);
        try {
          const r = await poll(f, ch);
          for (const ev of r.events) {
            const res = await handleInbound(db, actor, ch, ev);
            if (res.autoreplyId) await deliver(db, f, res.autoreplyId);
          }
          await db.query('update msg_channels set poll_offset = $2, last_ok_at = now(), last_error = null where id = $1', [id, r.offset ?? ch.poll_offset]);
        } catch (e) {
          await db.query('update msg_channels set last_error = $2 where id = $1', [id, e instanceof ProviderError ? e.message : 'Нет связи с мессенджером']);
        }
      }).catch((e) => console.error('Ошибка канала сообщений:', (e as Error).message));
    }
    await withCtx(pool, sys, async (db) => {
      const due = (await db.query(`select id from msg_messages where status = 'queued' and next_attempt_at <= now() order by next_attempt_at limit 50`)).rows;
      for (const m of due) await deliver(db, f, m.id);
    }).catch((e) => console.error('Ошибка отправки сообщений:', (e as Error).message));
    if (o.triggers) {
      const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select distinct club_id from msg_triggers where enabled`)).rows);
      for (const { club_id } of clubs) {
        await withCtx(pool, sys, (db) => runTriggers(db, f, actor, club_id, { dryRun: false }))
          .catch((e) => console.error('Ошибка автосообщений:', (e as Error).message));
      }
    }
  }
}

export function startMessagingWorker(pool: pg.Pool, f: Fetch = fetch, everyMs = 10_000) {
  let busy = false; let lastTriggers = 0;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    const triggers = Date.now() - lastTriggers > 10 * 60_000;
    try { await processMessaging(pool, f, { triggers }); if (triggers) lastTriggers = Date.now(); } catch (e) { console.error('Ошибка сообщений:', (e as Error).message); } finally { busy = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/* ---------- значения по умолчанию для клуба ---------- */
export const DEFAULT_TEMPLATES: [string, string, string | null, number, boolean][] = [
  // название, текст, событие, дней, рекламное
  ['Окончание абонемента', 'Здравствуйте, {имя}! Ваш абонемент «{абонемент}» в клубе {клуб} заканчивается {дата_окончания}. Продлите заранее, а мы подскажем лучший вариант. Просто ответьте на это сообщение.', 'membership_ending', 7, false],
  ['Напоминание о долге', '{имя}, напоминаем об оплате {долг} в клубе {клуб}, срок был {дата_платежа}. Оплатить можно на ресепшн, или ответьте сюда, и мы поможем.', 'debt_overdue', 3, false],
  ['Давно не были', '{имя}, мы скучаем! Вы не были в клубе {клуб} уже {дней} дн. Подобрать удобное время для тренировки?', 'inactive', 14, true],
  ['День рождения', '{имя}, клуб {клуб} поздравляет вас с днём рождения! Ждём на тренировке, на ресепшн для вас подарок.', 'birthday', 0, true],
  ['Добро пожаловать', '{имя}, добро пожаловать в клуб {клуб}! Если будут вопросы по абонементу или расписанию, пишите сюда.', 'welcome', 0, false],
  ['Предложение неприоритетным (ИИ)', 'Здравствуйте, {имя}! Это клуб {клуб}. Вы интересовались занятиями у нас: сейчас можно оформить {предложение}. Если интересно, просто ответьте на это сообщение, подберём удобное время.', 'ai_nurture', 14, true],
  ['Приглашение на пробную тренировку', 'Здравствуйте, {имя}! Это клуб {клуб}. Приглашаем вас на бесплатную пробную тренировку. Когда вам удобно прийти?', null, 0, true],
  ['Как прошла тренировка', '{имя}, как вам первая тренировка в клубе {клуб}? Будем рады отзыву и ответим на вопросы.', null, 0, false],
];
export async function ensureMsgDefaults(db: { query: Db['query'] }, tenantId: string, clubId: string) {
  await db.query('insert into club_msg_settings(club_id, tenant_id) values ($1,$2) on conflict (club_id) do nothing', [clubId, tenantId]);
  const fresh = !(await db.query('select 1 from msg_templates where club_id = $1', [clubId])).rowCount;
  for (const [name, body, event, days, marketing] of DEFAULT_TEMPLATES) {
    // Уже настроенный клуб получает только автосообщения, которых раньше не было (например, ai_nurture с шага 15)
    if (!fresh && (!event || (await db.query('select 1 from msg_triggers where club_id = $1 and event = $2', [clubId, event])).rowCount)) continue;
    const id = (await db.query('insert into msg_templates(tenant_id, club_id, name, body) values ($1,$2,$3,$4) returning id', [tenantId, clubId, name, body])).rows[0].id;
    if (event) await db.query('insert into msg_triggers(tenant_id, club_id, event, days, template_id, marketing) values ($1,$2,$3,$4,$5,$6)', [tenantId, clubId, event, days, id, marketing]);
  }
}

/* ---------- маршруты ---------- */
const CONV_SELECT = `select c.id, c.club_id as "clubId", c.channel_id as "channelId", ch.name as "channelName", ch.kind as "channelKind", ch.messenger,
  c.person_id as "personId", p.full_name as "personName", p.segment, c.title, c.external_chat_id as "chatId", c.assigned_to as "assignedTo", u.full_name as "assigneeName",
  c.last_message_at as "lastMessageAt", c.unread, p.messaging_opt_out as "optOut", p.marketing_consent as "marketingConsent",
  (select body from msg_messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as "lastText",
  (select direction from msg_messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as "lastDirection"
  from msg_conversations c join msg_channels ch on ch.id = c.channel_id left join persons p on p.id = c.person_id left join users u on u.id = c.assigned_to`;
const onlyMine = (ctx: Ctx) => !can(ctx, P.crmViewAll) && !can(ctx, P.messagesManage);
async function loadConv(db: Db, ctx: Ctx, id: string) {
  const c = (await db.query(`${CONV_SELECT} where c.id = $1`, [id])).rows[0];
  if (!c) throw notFound('Диалог не найден');
  if (onlyMine(ctx) && c.assignedTo && c.assignedTo !== ctx.userId) throw notFound('Диалог не найден');
  return c;
}
const CHANNEL_SELECT = `select id, club_id as "clubId", kind, messenger, name, settings, secret_enc is not null as "hasSecret", status, last_error as "lastError",
  last_ok_at as "lastOkAt", webhook_token as "webhookToken", created_at as "createdAt" from msg_channels`;

export function messagingRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;
  const base = (req: { protocol: string; headers: Record<string, unknown> }) => process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.headers.host}`;

  /* каналы */
  app.get('/api/msg/channels', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.messagesManage) && !can(ctx, P.messagesWork)) throw forbidden();
    const { clubId } = req.query as { clubId?: string };
    const rows = await withCtx(pool, ctx, async (db) => (await db.query(`${CHANNEL_SELECT} where ($1::uuid is null or club_id = $1) order by created_at`, [clubId || null])).rows);
    const manage = can(ctx, P.messagesManage);
    return rows.map((c) => ({ ...c, kindName: KINDS[c.kind]?.name, webhookToken: undefined, webhookUrl: manage ? `${base(req)}/api/hooks/msg/${c.id}/${c.webhookToken}` : undefined,
      polling: KINDS[c.kind]?.polling ?? false }));
  });

  const checkChannel = (b: { kind?: string; messenger?: string; settings?: Record<string, string> }) => {
    const k = KINDS[b.kind ?? ''];
    if (!k) throw badRequest('Выберите способ подключения');
    if (!k.messengers.includes(b.messenger ?? '')) throw badRequest('Этот способ не подходит для выбранного мессенджера');
    const s = b.settings ?? {};
    if (b.kind === 'green_api' && !/^\d{5,15}$/.test(s.idInstance ?? '')) throw badRequest('Укажите номер инстанса Green-API (idInstance, только цифры)');
    if (b.kind === 'wazzup' && !/^[0-9a-f-]{36}$/i.test(s.channelId ?? '')) throw badRequest('Укажите идентификатор канала Wazzup (channelId)');
    if (s.apiUrl && !/^https:\/\//.test(s.apiUrl)) throw badRequest('Адрес API должен начинаться с https://');
    return Object.fromEntries(Object.entries(s).filter(([key]) => ['idInstance', 'apiUrl', 'channelId', 'botName'].includes(key)).map(([key, v]) => [key, String(v).trim()]));
  };

  app.post('/api/msg/channels', async (req, reply) => {
    const ctx = requirePerm(req, P.messagesManage);
    const b = (req.body ?? {}) as { clubId?: string; kind?: string; messenger?: string; name?: string; settings?: Record<string, string>; secret?: string };
    if (!b.clubId) throw badRequest('Выберите клуб');
    const settings = checkChannel(b);
    if (b.kind !== 'test' && !b.secret?.trim()) throw badRequest(b.kind === 'telegram_bot' ? 'Вставьте токен бота от @BotFather' : 'Вставьте токен или ключ API');
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      const id = (await db.query(`insert into msg_channels(tenant_id, club_id, kind, messenger, name, settings, secret_enc, webhook_token, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [ctx.tenantId, b.clubId, b.kind, b.messenger, b.name?.trim() || `${b.messenger === 'whatsapp' ? 'WhatsApp' : 'Telegram'} клуба`, JSON.stringify(settings),
        b.secret?.trim() ? encrypt(b.secret.trim()) : null, randomBytes(18).toString('base64url'), ctx.userId])).rows[0].id;
      await ensureMsgDefaults(db, ctx.tenantId, b.clubId!);
      await audit(db, ctx, 'msg_channel.created', 'msg_channel', id, null, { kind: b.kind, messenger: b.messenger, settings });
      return (await db.query(`${CHANNEL_SELECT} where id = $1`, [id])).rows[0];
    });
    reply.code(201);
    return { ...res, webhookToken: undefined };
  });

  app.patch('/api/msg/channels/:id', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; settings?: Record<string, string>; secret?: string; status?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select * from msg_channels where id = $1', [id])).rows[0];
      if (!c) throw notFound('Канал не найден');
      const settings = b.settings ? checkChannel({ kind: c.kind, messenger: c.messenger, settings: b.settings }) : c.settings;
      if (b.status && !['active', 'disabled'].includes(b.status)) throw badRequest('Неверное состояние');
      await db.query(`update msg_channels set name = coalesce($2, name), settings = $3, secret_enc = coalesce($4, secret_enc), status = coalesce($5, status), updated_at = now() where id = $1`,
        [id, b.name?.trim() || null, JSON.stringify(settings), b.secret?.trim() ? encrypt(b.secret.trim()) : null, b.status ?? null]);
      await audit(db, ctx, 'msg_channel.updated', 'msg_channel', id, { status: c.status, settings: c.settings }, { status: b.status ?? c.status, settings, secretChanged: !!b.secret?.trim() });
      return { ok: true };
    });
  });

  app.post('/api/msg/channels/:id/test', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const ch = await loadChannel(db, id);
      try {
        const info = await testChannel(f, ch);
        await db.query('update msg_channels set last_ok_at = now(), last_error = null where id = $1', [id]);
        return { ok: true, info };
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : 'Нет связи с сервисом мессенджера';
        await db.query('update msg_channels set last_error = $2 where id = $1', [id, msg]);
        return { ok: false, info: msg };
      }
    });
  });

  // Тестовый канал: имитация сообщения от клиента
  app.post('/api/msg/channels/:id/simulate', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.messagesManage) && !can(ctx, P.messagesWork)) throw forbidden();
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; phone?: string; chatId?: string; text?: string };
    if (!b.text?.trim()) throw badRequest('Введите текст сообщения');
    return withCtx(pool, ctx, async (db) => {
      const ch = await loadChannel(db, id);
      if (ch.kind !== 'test') throw badRequest('Имитировать сообщение можно только в тестовом канале');
      const phone = normalizePhone(b.phone);
      if (ch.messenger === 'whatsapp' && !phone) throw badRequest('Укажите телефон клиента');
      const chatId = ch.messenger === 'whatsapp' ? phone!.replace(/\D/g, '') : (b.chatId?.trim() || String(Date.now()));
      const res = await handleInbound(db, { tenantId: ctx.tenantId, userId: null }, ch,
        { chatId, externalId: `sim-${Date.now()}`, text: b.text!.trim(), name: b.name?.trim() || 'Клиент', phone: phone });
      if (res.autoreplyId) await deliver(db, f, res.autoreplyId);
      return res;
    });
  });

  // Входящие от провайдера (Telegram-вебхук, Green-API, Wazzup). Адрес содержит секрет канала.
  app.post('/api/hooks/msg/:id/:token', async (req, reply) => {
    const { id, token } = req.params as { id: string; token: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: 'not_found' });
    const auth = (await pool.query('select * from msg_channel_by_token($1, $2)', [id, token])).rows[0];
    if (!auth) return reply.code(404).send({ error: 'not_found' });
    await withCtx(pool, { tenantId: auth.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const ch = await loadChannel(db, id);
      for (const ev of parseWebhook(ch, req.body)) {
        const r = await handleInbound(db, { tenantId: auth.tenant_id, userId: null }, ch, ev);
        if (r.autoreplyId) await deliver(db, f, r.autoreplyId);
      }
    });
    return { ok: true };
  });

  /* настройки клуба */
  app.get('/api/msg/settings/:clubId', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { clubId } = req.params as { clubId: string };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw notFound('Клуб не найден');
      await ensureMsgDefaults(db, ctx.tenantId, clubId);
      const s = await settingsOf(db, clubId);
      return { workFrom: s.work_from, workTo: s.work_to, autoreplyEnabled: s.autoreply_enabled, autoreplyText: s.autoreply_text, maxAutoPerWeek: s.max_auto_per_week };
    });
  });
  app.put('/api/msg/settings/:clubId', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { clubId } = req.params as { clubId: string };
    const b = (req.body ?? {}) as { workFrom?: number; workTo?: number; autoreplyEnabled?: boolean; autoreplyText?: string; maxAutoPerWeek?: number };
    const int = (v: unknown, lo: number, hi: number, what: string) => { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw badRequest(what); return v as number; };
    const wf = int(b.workFrom, 0, 23, 'Неверное начало рабочего времени'); const wt = int(b.workTo, 1, 24, 'Неверный конец рабочего времени');
    if (wt <= wf) throw badRequest('Конец рабочего времени раньше начала');
    const mx = int(b.maxAutoPerWeek, 0, 14, 'Лимит автосообщений: от 0 до 14 в неделю');
    if (!b.autoreplyText?.trim()) throw badRequest('Введите текст автоответа');
    return withCtx(pool, ctx, async (db) => {
      await ensureMsgDefaults(db, ctx.tenantId, clubId);
      await db.query(`update club_msg_settings set work_from = $2, work_to = $3, autoreply_enabled = $4, autoreply_text = $5, max_auto_per_week = $6, updated_at = now() where club_id = $1`,
        [clubId, wf, wt, !!b.autoreplyEnabled, b.autoreplyText!.trim().slice(0, 1000), mx]);
      await audit(db, ctx, 'msg_settings.updated', 'club', clubId, null, b);
      return { ok: true };
    });
  });

  /* шаблоны */
  app.get('/api/msg/templates', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.messagesManage) && !can(ctx, P.messagesWork)) throw forbidden();
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`select t.id, t.club_id as "clubId", t.name, t.body, t.is_active as "isActive",
        (select event from msg_triggers r where r.template_id = t.id limit 1) as "event"
      from msg_templates t where ($1::uuid is null or t.club_id = $1) order by t.created_at`, [clubId || null])).rows);
  });
  app.post('/api/msg/templates', async (req, reply) => {
    const ctx = requirePerm(req, P.messagesManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string; body?: string };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!b.name?.trim() || !b.body?.trim()) throw badRequest('Укажите название и текст шаблона');
    if (b.body.length > 2000) throw badRequest('Текст не длиннее 2000 символов');
    const id = await withCtx(pool, ctx, async (db) => {
      const id = (await db.query('insert into msg_templates(tenant_id, club_id, name, body, created_by) values ($1,$2,$3,$4,$5) returning id', [ctx.tenantId, b.clubId, b.name!.trim(), b.body!.trim(), ctx.userId])).rows[0].id;
      await audit(db, ctx, 'msg_template.created', 'msg_template', id, null, { name: b.name });
      return id;
    });
    reply.code(201);
    return { id };
  });
  app.patch('/api/msg/templates/:id', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; body?: string; isActive?: boolean };
    if (b.body !== undefined && (!b.body.trim() || b.body.length > 2000)) throw badRequest('Текст шаблона: от 1 до 2000 символов');
    return withCtx(pool, ctx, async (db) => {
      const t = (await db.query('select * from msg_templates where id = $1', [id])).rows[0];
      if (!t) throw notFound('Шаблон не найден');
      await db.query('update msg_templates set name = coalesce($2, name), body = coalesce($3, body), is_active = coalesce($4, is_active), updated_at = now() where id = $1',
        [id, b.name?.trim() || null, b.body?.trim() ?? null, b.isActive ?? null]);
      await audit(db, ctx, 'msg_template.updated', 'msg_template', id, { name: t.name, body: t.body }, b);
      return { ok: true };
    });
  });

  /* автосообщения */
  app.get('/api/msg/triggers', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      await ensureMsgDefaults(db, ctx.tenantId, clubId);
      return (await db.query(`select t.id, t.event, t.days, t.template_id as "templateId", tp.name as "templateName", t.marketing, t.enabled, t.send_hour as "sendHour",
          (select count(*)::int from msg_trigger_sends s where s.trigger_id = t.id and s.created_at > now() - interval '30 days') as "sent30"
        from msg_triggers t join msg_templates tp on tp.id = t.template_id where t.club_id = $1
        order by array_position(array['membership_ending','debt_overdue','inactive','birthday','welcome','ai_nurture'], t.event)`, [clubId])).rows;
    });
  });
  app.put('/api/msg/triggers/:id', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { enabled?: boolean; days?: number; templateId?: string; marketing?: boolean; sendHour?: number };
    if (b.days !== undefined && (!Number.isInteger(b.days) || b.days < 0 || b.days > 365)) throw badRequest('Дней: от 0 до 365');
    if (b.sendHour !== undefined && (!Number.isInteger(b.sendHour) || b.sendHour < 0 || b.sendHour > 23)) throw badRequest('Неверный час отправки');
    return withCtx(pool, ctx, async (db) => {
      const t = (await db.query('select * from msg_triggers where id = $1', [id])).rows[0];
      if (!t) throw notFound('Автосообщение не найдено');
      if (b.templateId && !(await db.query('select 1 from msg_templates where id = $1 and club_id = $2', [b.templateId, t.club_id])).rowCount) throw badRequest('Шаблон другого клуба');
      await db.query(`update msg_triggers set enabled = coalesce($2, enabled), days = coalesce($3, days), template_id = coalesce($4, template_id), marketing = coalesce($5, marketing),
        send_hour = coalesce($6, send_hour), updated_by = $7, updated_at = now() where id = $1`, [id, b.enabled ?? null, b.days ?? null, b.templateId ?? null, b.marketing ?? null, b.sendHour ?? null, ctx.userId]);
      await audit(db, ctx, 'msg_trigger.updated', 'msg_trigger', id, { enabled: t.enabled, days: t.days, templateId: t.template_id }, b);
      return { ok: true };
    });
  });
  // Кому и что уйдёт сегодня — без отправки
  app.get('/api/msg/triggers/:id/preview', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const t = (await db.query('select club_id from msg_triggers where id = $1', [id])).rows[0];
      if (!t) throw notFound('Автосообщение не найдено');
      return (await runTriggers(db, f, { tenantId: ctx.tenantId, userId: ctx.userId }, t.club_id, { dryRun: true, onlyTriggerId: id }))[0];
    });
  });
  app.post('/api/msg/triggers/:id/run', async (req) => {
    const ctx = requirePerm(req, P.messagesManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const t = (await db.query('select club_id, enabled from msg_triggers where id = $1', [id])).rows[0];
      if (!t) throw notFound('Автосообщение не найдено');
      if (!t.enabled) throw badRequest('Сначала включите это автосообщение');
      const r = (await runTriggers(db, f, { tenantId: ctx.tenantId, userId: ctx.userId }, t.club_id, { dryRun: false, onlyTriggerId: id, force: true }))[0];
      await audit(db, ctx, 'msg_trigger.run', 'msg_trigger', id, null, { sent: r.sent, skipped: r.skipped.length });
      return r;
    });
  });

  /* диалоги */
  app.get('/api/msg/conversations', async (req) => {
    const ctx = requirePerm(req, P.messagesWork);
    const { clubId, personId, filter } = req.query as { clubId?: string; personId?: string; filter?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`${CONV_SELECT}
      where ($1::uuid is null or c.club_id = $1) and ($2::uuid is null or c.person_id = $2)
        and ($3::uuid is null or c.assigned_to = $3 or c.assigned_to is null)
        and ($4 <> 'unread' or c.unread > 0) and ($4 <> 'mine' or c.assigned_to = $5)
      order by c.last_message_at desc nulls last limit 200`,
    [clubId || null, personId || null, onlyMine(ctx) ? ctx.userId : null, filter ?? 'all', ctx.userId])).rows);
  });

  app.get('/api/msg/conversations/:id/messages', async (req) => {
    const ctx = requirePerm(req, P.messagesWork);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadConv(db, ctx, id);
      const messages = (await db.query(`select m.id, m.direction, m.body, m.status, m.error, m.auto, m.created_at as "createdAt", m.sent_at as "sentAt",
          u.full_name as "authorName", tr.event as "triggerEvent"
        from msg_messages m left join users u on u.id = m.author_id left join msg_triggers tr on tr.id = m.trigger_id
        where m.conversation_id = $1 order by m.created_at, m.id limit 500`, [id])).rows;
      if (c.unread) await db.query('update msg_conversations set unread = 0 where id = $1', [id]);
      return { conversation: { ...c, unread: 0 }, messages };
    });
  });

  app.post('/api/msg/conversations/:id/render', async (req) => {
    const ctx = requirePerm(req, P.messagesWork);
    const { id } = req.params as { id: string };
    const { templateId } = (req.body ?? {}) as { templateId?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await loadConv(db, ctx, id);
      const t = (await db.query('select body from msg_templates where id = $1 and club_id = $2', [templateId, c.clubId])).rows[0];
      if (!t) throw notFound('Шаблон не найден');
      return { text: await renderTemplate(db, t.body, c.personId, c.clubId) };
    });
  });

  app.post('/api/msg/conversations/:id/messages', async (req, reply) => {
    const ctx = requirePerm(req, P.messagesWork);
    const { id } = req.params as { id: string };
    const { text, templateId } = (req.body ?? {}) as { text?: string; templateId?: string };
    if (!text?.trim()) throw badRequest('Введите текст сообщения');
    if (text.length > 4000) throw badRequest('Сообщение не длиннее 4000 символов');
    const res = await withCtx(pool, ctx, async (db) => {
      const c = await loadConv(db, ctx, id);
      const mid = await queueMessage(db, ctx, id, text.trim(), { templateId: templateId ?? null });
      await db.query('update msg_conversations set last_message_at = now(), unread = 0, assigned_to = coalesce(assigned_to, $2) where id = $1', [id, ctx.userId]);
      const status = await deliver(db, f, mid);
      await markFirstResponse(db, c.personId, c.clubId);
      return (await db.query('select id, direction, body, status, error, created_at as "createdAt" from msg_messages where id = $1', [mid])).rows[0] ?? { id: mid, status };
    });
    reply.code(201);
    return res;
  });

  app.post('/api/msg/messages/:id/retry', async (req) => {
    const ctx = requirePerm(req, P.messagesWork);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const m = (await db.query('select conversation_id, status from msg_messages where id = $1', [id])).rows[0];
      if (!m) throw notFound('Сообщение не найдено');
      await loadConv(db, ctx, m.conversation_id);
      if (m.status !== 'failed') throw badRequest('Повторить можно только неотправленное сообщение');
      await db.query(`update msg_messages set status = 'queued', attempts = 0, next_attempt_at = now() where id = $1`, [id]);
      return { status: await deliver(db, f, id) };
    });
  });

  // Начать диалог из карточки клиента: WhatsApp по телефону клиента
  app.post('/api/persons/:id/conversations', async (req, reply) => {
    const ctx = requirePerm(req, P.messagesWork);
    const { id } = req.params as { id: string };
    const { channelId } = (req.body ?? {}) as { channelId?: string };
    const res = await withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select id, full_name from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      const ch = (await db.query(`select * from msg_channels where id = $1 and status = 'active'`, [channelId])).rows[0];
      if (!ch) throw badRequest('Канал не найден или отключён');
      if (ch.messenger !== 'whatsapp') throw badRequest('В Telegram клиент должен написать клубу первым: бот не может начать переписку сам');
      const phone = (await db.query(`select normalized_value from person_contacts where person_id = $1 and type in ('phone', 'whatsapp') order by is_primary desc limit 1`, [id])).rows[0]?.normalized_value;
      if (!phone) throw badRequest('У клиента нет телефона');
      return (await db.query(`insert into msg_conversations(tenant_id, club_id, channel_id, person_id, external_chat_id, title, assigned_to) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (channel_id, external_chat_id) do update set person_id = coalesce(msg_conversations.person_id, excluded.person_id) returning id`,
      [ctx.tenantId, ch.club_id, ch.id, id, phone.replace(/\D/g, ''), p.full_name, ctx.userId])).rows[0];
    });
    reply.code(201);
    return res;
  });

  // Согласие на рассылки и отписка — в карточке клиента
  app.post('/api/persons/:id/messaging', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.messagesWork) && !can(ctx, P.crmWork)) throw forbidden();
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { marketingConsent?: boolean; optOut?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select marketing_consent, messaging_opt_out from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      await db.query(`update persons set marketing_consent = coalesce($2, marketing_consent), messaging_opt_out = coalesce($3, messaging_opt_out), messaging_changed_at = now() where id = $1`,
        [id, b.marketingConsent ?? null, b.optOut ?? null]);
      await audit(db, ctx, 'person.messaging_changed', 'person', id, { marketingConsent: p.marketing_consent, optOut: p.messaging_opt_out }, b);
      return { ok: true };
    });
  });
}
