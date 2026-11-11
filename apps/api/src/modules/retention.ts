// Возврат бывших клиентов и досрочное продление (список «20 новых возможностей», п. 5).
// Бывшие клиенты делятся на группы по давности ухода, тарифу и визитам; кампания отправляет предложение тем, у кого есть мессенджер
// и согласие на рекламу, остальным ставит звонок. Ответившим — задача менеджеру. Покупка в течение 45 дней засчитывается кампании.
// Досрочное продление: за N дней до конца абонемента клиенту предлагают продлиться по текущей цене, цена держится до конца абонемента.
import { processLoyalty } from './loyalty.ts';
import { pnlAlerts } from './pnl.ts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { clubToday } from './memberships.ts';
import { processNewbies } from './newbie.ts';
import { churnPlays, trackChurnOutcomes } from './churn.ts';
import { processOnlineOrders } from './onlineBuy.ts';
import { conversationFor, deliver, queueMessage, renderTemplate } from './messaging.ts';
import type { Fetch } from './msgProviders.ts';

type Actor = { tenantId: string; userId: string | null };
const uuid = (s?: string | null) => !!s && /^[0-9a-f-]{36}$/i.test(s);
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU').replace(/,/g, ' ')} ₽`;
const ru = (d: string) => d.split('-').reverse().join('.');

export type Filter = { monthsFrom?: number; monthsTo?: number | null; product?: string | null; minVisits?: number | null };
export const BUCKETS: [string, string, number, number | null][] = [['m1', 'Ушли 1–3 месяца назад', 1, 3], ['m3', '3–6 месяцев', 3, 6], ['m6', '6–12 месяцев', 6, 12], ['m12', 'Больше года', 12, null]];
export const EARLY_TEMPLATE = '{имя}, ваш абонемент «{абонемент}» в клубе {клуб} заканчивается {дата_окончания}. Продлите заранее по текущей цене {цена} — она сохранится за вами до {дата_окончания}, даже если цены вырастут. Ответьте на это сообщение, и мы всё оформим.';
export const DEFAULT_TEMPLATE = '{имя}, давно не виделись! В клубе {клуб} для вас {предложение}. Ответьте на это сообщение, и мы подберём удобное время.';

/** Бывшие клиенты клуба: был абонемент, сейчас нет действующего. Возвращает и то, как с ними можно связаться */
export async function formerClients(db: Db, clubId: string, today: string, f: Filter, limit = 5000) {
  return (await db.query(`with m as (
      select m.person_id, max(coalesce(m.ends_on, (m.updated_at at time zone 'UTC')::date)) as left_on,
        (array_agg(m.product_name order by coalesce(m.ends_on, m.updated_at::date) desc))[1] as last_product,
        bool_or(m.status = 'active' and (m.ends_on is null or m.ends_on >= $2)) as has_active
      from memberships m where m.club_id = $1 and m.kind <> 'guest' group by m.person_id)
    select m.person_id as "personId", p.full_name as name, to_char(m.left_on, 'YYYY-MM-DD') as "leftOn", m.last_product as "lastProduct",
      (select count(*)::int from visits v where v.person_id = m.person_id and v.club_id = $1) as visits,
      p.marketing_consent as consent, p.messaging_opt_out as "optOut",
      exists (select 1 from msg_conversations c join msg_channels ch on ch.id = c.channel_id where c.person_id = m.person_id and c.club_id = $1 and ch.status = 'active') as "hasChat",
      exists (select 1 from person_contacts pc where pc.person_id = m.person_id and pc.type = 'phone') as "hasPhone",
      exists (select 1 from campaign_members cm where cm.person_id = m.person_id and cm.club_id = $1 and cm.created_at > now() - interval '30 days') as "recentCampaign"
    from m join persons p on p.id = m.person_id
    where not m.has_active and p.merged_into_id is null
      and m.left_on <= ($2::date - make_interval(months => $3::int))::date
      and ($4::int is null or m.left_on > ($2::date - make_interval(months => $4::int))::date)
      and ($5::text is null or m.last_product = $5)
    order by m.left_on desc limit $6`,
  [clubId, today, Math.max(0, Number(f.monthsFrom ?? 1)), f.monthsTo ?? null, f.product || null, limit])).rows
    .filter((r) => !f.minVisits || r.visits >= f.minVisits) as {
      personId: string; name: string; leftOn: string; lastProduct: string; visits: number; consent: boolean; optOut: boolean; hasChat: boolean; hasPhone: boolean; recentCampaign: boolean }[];
}

type Former = Awaited<ReturnType<typeof formerClients>>[number];
/** Как связаться: сообщение (есть мессенджер и согласие на рекламу), звонок или никак */
function channelFor(c: Former, hasWhatsApp: boolean, callWithout: boolean): ['message' | 'call' | 'skip', string | null] {
  if (c.recentCampaign) return ['skip', 'уже был в кампании за последние 30 дней'];
  if (c.optOut) return ['skip', 'отказался от сообщений'];
  const canMsg = c.consent && (c.hasChat || (hasWhatsApp && c.hasPhone));
  if (canMsg) return ['message', null];
  if (callWithout && c.hasPhone) return ['call', c.consent ? 'нет мессенджера' : 'нет согласия на рекламные сообщения'];
  return ['skip', !c.hasPhone ? 'нет телефона' : c.consent ? 'нет мессенджера' : 'нет согласия на рекламные сообщения'];
}

/** Ответственный за клиента: владелец последней сделки, если работает в клубе, иначе менеджер с наименьшим числом открытых задач */
export async function responsibleFor(db: Db, personId: string, clubId: string) {
  const own = (await db.query(`select o.owner_id from opportunities o join users u on u.id = o.owner_id
    where o.person_id = $1 and o.club_id = $2 and u.status = 'active' and o.owner_id is not null order by o.updated_at desc limit 1`, [personId, clubId])).rows[0]?.owner_id;
  if (own) return own as string;
  return ((await db.query(`select u.id from users u join user_assignments a on a.user_id = u.id
    where a.club_id = $1 and a.role_code in ('manager', 'rop') and u.status = 'active'
    order by a.role_code = 'rop', (select count(*) from tasks t where t.assignee_id = u.id and t.done_at is null), u.full_name limit 1`, [clubId])).rows[0]?.id ?? null) as string | null;
}
export async function task(db: Db, actor: Actor, clubId: string, personId: string, title: string, dueHours = 24) {
  const assignee = await responsibleFor(db, personId, clubId);
  return (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,'call',$5, now() + make_interval(hours => $6::int), $7) returning id`,
    [actor.tenantId, clubId, assignee, personId, title, dueHours, actor.userId])).rows[0].id as string;
}
export async function sendText(db: Db, f: Fetch | null, actor: Actor, personId: string, clubId: string, text: string) {
  const conv = await conversationFor(db, actor, personId, clubId, true);
  if (!conv || conv === 'new') return null;
  const mid = await queueMessage(db, actor, conv, text, { auto: true });
  await db.query('update msg_conversations set last_message_at = now() where id = $1', [conv]);
  if (f) await deliver(db, f, mid);
  return mid;
}

export async function launchCampaign(db: Db, f: Fetch | null, ctx: Pick<Ctx, 'tenantId' | 'userId'>, id: string) {
  const c = (await db.query('select * from retention_campaigns where id = $1 for update', [id])).rows[0];
  if (!c) throw notFound('Кампания не найдена');
  if (c.status !== 'draft') throw badRequest('Кампания уже запущена');
  const today = await clubToday(db, c.club_id);
  const list = await formerClients(db, c.club_id, today, c.filter);
  if (!list.length) throw badRequest('В группе нет клиентов');
  const hasWa = !!(await db.query(`select 1 from msg_channels where club_id = $1 and messenger = 'whatsapp' and status = 'active'`, [c.club_id])).rowCount;
  const stat = { message: 0, call: 0, skip: 0 };
  for (const p of list) {
    let [ch, reason] = channelFor(p, hasWa, c.call_without_messenger);
    let mid: string | null = null; let tid: string | null = null;
    if (ch === 'message') {
      const text = await renderTemplate(db, c.template, p.personId, c.club_id, { предложение: c.offer || 'специальное предложение для возвращения' });
      mid = await sendText(db, f, ctx, p.personId, c.club_id, text);
      if (!mid) { ch = c.call_without_messenger ? 'call' : 'skip'; reason = 'не удалось открыть диалог'; }
    }
    if (ch === 'call') tid = await task(db, ctx, c.club_id, p.personId, `Возврат: ${c.name}. Предложить: ${c.offer || 'вернуться в клуб'} (ушёл ${ru(p.leftOn)}, был «${p.lastProduct}»)`, 72);
    await db.query(`insert into campaign_members(tenant_id, club_id, campaign_id, person_id, left_on, channel, skip_reason, message_id, task_id, sent_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ctx.tenantId, c.club_id, id, p.personId, p.leftOn, ch, ch === 'message' ? null : reason, mid, tid, ch === 'skip' ? null : new Date()]);
    stat[ch]++;
  }
  await db.query(`update retention_campaigns set status = 'running', launched_at = now(), launched_by = $2 where id = $1`, [id, ctx.userId]);
  await audit(db, ctx, 'retention.launched', 'retention_campaign', id, null, { name: c.name, ...stat });
  return stat;
}

/** Ответы и покупки: ответил в мессенджере — задача менеджеру; купил в течение 45 дней — засчитывается кампании или предложению */
export async function trackResults(db: Db, actor: Actor, clubId: string) {
  const replied = (await db.query(`select cm.id, cm.person_id, c.name, c.offer from campaign_members cm join retention_campaigns c on c.id = cm.campaign_id
    where cm.club_id = $1 and cm.channel = 'message' and cm.replied_at is null and cm.sent_at > now() - interval '45 days'
      and exists (select 1 from msg_messages m join msg_conversations cv on cv.id = m.conversation_id where cv.person_id = cm.person_id and cv.club_id = cm.club_id and m.direction = 'in' and m.created_at > cm.sent_at)`, [clubId])).rows;
  for (const r of replied) {
    const tid = await task(db, actor, clubId, r.person_id, `Ответил на предложение «${r.name}»: позвонить и записать в клуб${r.offer ? ` (${r.offer})` : ''}`, 2);
    await db.query('update campaign_members set replied_at = now(), task_id = coalesce(task_id, $2) where id = $1', [r.id, tid]);
  }
  const offers = (await db.query(`select o.id, o.person_id, o.amount_kop, to_char(o.valid_until, 'YYYY-MM-DD') as until from renewal_offers o
    where o.club_id = $1 and o.status = 'sent' and o.replied_at is null
      and exists (select 1 from msg_messages m join msg_conversations cv on cv.id = m.conversation_id where cv.person_id = o.person_id and cv.club_id = o.club_id and m.direction = 'in' and m.created_at > o.created_at)`, [clubId])).rows;
  for (const o of offers) {
    const tid = await task(db, actor, clubId, o.person_id, `Ответил на досрочное продление: оформить по цене ${rub(Number(o.amount_kop))} (держится до ${ru(o.until)})`, 2);
    await db.query('update renewal_offers set replied_at = now(), task_id = coalesce(task_id, $2) where id = $1', [o.id, tid]);
  }
  await db.query(`update campaign_members cm set bought_membership_id = m.id, bought_at = m.created_at, bought_kop = m.amount_kop
    from memberships m where cm.club_id = $1 and cm.bought_at is null and cm.channel <> 'skip' and m.person_id = cm.person_id and m.club_id = cm.club_id
      and m.created_at > cm.created_at and m.created_at < cm.created_at + interval '45 days' and m.status <> 'cancelled' and m.kind <> 'guest'`, [clubId]);
  await db.query(`update retention_campaigns c set status = 'finished', finished_at = now() where c.club_id = $1 and c.status = 'running' and c.launched_at < now() - interval '45 days'`, [clubId]);
}

/** Досрочное продление: предложения клиентам, у кого абонемент заканчивается через early_days дней */
export async function earlyRenewals(db: Db, f: Fetch | null, actor: Actor, clubId: string, today: string) {
  const s = (await db.query('select * from club_retention_settings where club_id = $1', [clubId])).rows[0]
    ?? { early_enabled: true, early_days: 30, early_call_without_messenger: true, early_template: null };
  if (!s.early_enabled) return 0;
  const template = s.early_template ?? EARLY_TEMPLATE;
  const list = (await db.query(`select m.id, m.person_id, m.product_id, m.product_name, to_char(m.ends_on, 'YYYY-MM-DD') as ends_on, p.messaging_opt_out, pr.is_active,
      (select pv.id from price_versions pv where pv.product_id = m.product_id and pv.valid_from <= now() order by pv.valid_from desc limit 1) as pv_id,
      (select pv.amount_kop from price_versions pv where pv.product_id = m.product_id and pv.valid_from <= now() order by pv.valid_from desc limit 1) as pv_amount
    from memberships m join persons p on p.id = m.person_id join products pr on pr.id = m.product_id
    where m.club_id = $1 and m.status = 'active' and m.kind in ('term', 'visits') and m.ends_on > $2 and m.ends_on <= $2::date + $3::int
      and not exists (select 1 from renewal_offers o where o.membership_id = m.id)
      and not exists (select 1 from memberships n where n.person_id = m.person_id and n.club_id = m.club_id and n.status = 'active' and n.id <> m.id and n.starts_on >= m.ends_on)
    order by m.ends_on limit 200`, [clubId, today, s.early_days])).rows;
  let n = 0;
  for (const m of list) {
    const ins = (status: string, reason: string | null, mid: string | null, tid: string | null) => db.query(`insert into renewal_offers(tenant_id, club_id, membership_id, person_id, product_id, price_version_id, amount_kop, valid_until, status, skip_reason, message_id, task_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [actor.tenantId, clubId, m.id, m.person_id, m.product_id, m.pv_id, m.pv_amount, m.ends_on, status, reason, mid, tid]);
    if (!m.is_active || !m.pv_id) { await ins('skipped', 'тариф снят с продажи: подберите другой при продлении', null, null); continue; }
    const price = rub(Number(m.pv_amount));
    const text = await renderTemplate(db, template, m.person_id, clubId, { абонемент: m.product_name, дата_окончания: ru(m.ends_on), цена: price });
    const mid = m.messaging_opt_out ? null : await sendText(db, f, actor, m.person_id, clubId, text);
    if (mid) { await ins('sent', null, mid, null); n++; continue; }
    if (s.early_call_without_messenger) {
      const tid = await task(db, actor, clubId, m.person_id, `Досрочное продление «${m.product_name}»: предложить по текущей цене ${price}, цена держится до ${ru(m.ends_on)}`, 48);
      await ins('call', m.messaging_opt_out ? 'отказался от сообщений' : 'нет мессенджера', null, tid); n++;
    } else await ins('skipped', m.messaging_opt_out ? 'отказался от сообщений' : 'нет мессенджера', null, null);
  }
  return n;
}

/** Цена продления по предложению: если сейчас тариф дороже, действует цена из предложения. Вызывается из продажи */
export async function lockedRenewalPrice(db: Db, renewFromId: string, productId: string, today: string) {
  return (await db.query(`select id, price_version_id, amount_kop from renewal_offers where membership_id = $1 and product_id = $2 and status in ('sent', 'call') and valid_until >= $3`,
    [renewFromId, productId, today])).rows[0] as { id: string; price_version_id: string; amount_kop: string } | undefined;
}

export async function processRetention(pool: pg.Pool, f: Fetch | null) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const actor = { tenantId, userId: null };
    const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select c.id, to_char(now() at time zone c.timezone, 'YYYY-MM-DD') as today,
      extract(hour from now() at time zone c.timezone)::int as h, coalesce(s.work_from, 9) as wf, coalesce(s.work_to, 21) as wt
      from clubs c left join club_msg_settings s on s.club_id = c.id where c.status = 'active' and not c.is_demo`)).rows);
    for (const c of clubs) {
      await withCtx(pool, sys, async (db) => {
        await trackResults(db, actor, c.id);
        await processNewbies(db, actor, c.id, c.today);
        await trackChurnOutcomes(db, c.id);
        await processOnlineOrders(db, f, actor, c.id);
        // Предложения уходят только в рабочее время клуба
        if (c.h >= Math.max(11, c.wf) && c.h < c.wt) { await earlyRenewals(db, f, actor, c.id, c.today); await churnPlays(db, f, actor, c.id); }
      }).catch((e) => console.error('Удержание:', (e as Error).message));
      await withCtx(pool, sys, (db) => processLoyalty(db, tenantId, c.id)).catch((e) => console.error('Баллы:', (e as Error).message));
      // Сигнал собственнику о прибыли — по закрытым месяцам, со 2-го по 5-е число в 9 утра (повторно не шлём)
      if (Number(c.today.slice(8, 10)) >= 2 && Number(c.today.slice(8, 10)) <= 5 && c.h === 9) await withCtx(pool, sys, (db) => pnlAlerts(db, f, tenantId, c.id, c.today)).catch((e) => console.error('Прибыль:', (e as Error).message));
    }
  }
}
export function startRetentionWorker(pool: pg.Pool, f: Fetch = fetch, everyMs = 15 * 60_000) {
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await processRetention(pool, f); } finally { busy = false; } };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

/* ---------- маршруты ---------- */
export function retentionRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? null;
  const club = async (db: Db, id?: string) => { if (!uuid(id) || !(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw badRequest('Выберите клуб'); return id!; };
  const parseFilter = (b: Filter): Filter => {
    const from = Number(b.monthsFrom ?? 1); const to = b.monthsTo == null || (b.monthsTo as unknown) === '' ? null : Number(b.monthsTo);
    if (!Number.isInteger(from) || from < 0 || from > 120) throw badRequest('Сколько месяцев назад ушёл: от 0 до 120');
    if (to !== null && (!Number.isInteger(to) || to <= from)) throw badRequest('Конец периода должен быть больше начала');
    return { monthsFrom: from, monthsTo: to, product: b.product || null, minVisits: b.minVisits ? Number(b.minVisits) : null };
  };

  // Группы бывших клиентов: сколько людей и сколько из них можно достать сообщением
  app.get('/api/retention/segments', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      await club(db, clubId);
      const today = await clubToday(db, clubId!);
      const hasWa = !!(await db.query(`select 1 from msg_channels where club_id = $1 and messenger = 'whatsapp' and status = 'active'`, [clubId])).rowCount;
      const all = await formerClients(db, clubId!, today, { monthsFrom: 0 });
      const groups = BUCKETS.map(([key, title, from, to]) => {
        const rows = all.filter((r) => { const m = monthsAgo(r.leftOn, today); return m >= from && (to === null || m < to); });
        const ch = rows.map((r) => channelFor(r, hasWa, true)[0]);
        return { key, title, monthsFrom: from, monthsTo: to, count: rows.length, message: ch.filter((x) => x === 'message').length, call: ch.filter((x) => x === 'call').length,
          products: Object.entries(rows.reduce((a, r) => ({ ...a, [r.lastProduct]: (a[r.lastProduct] ?? 0) + 1 }), {} as Record<string, number>)).sort((a, b) => b[1] - a[1]).slice(0, 5) };
      });
      return { groups, recentlyLeft: all.filter((r) => monthsAgo(r.leftOn, today) < 1).length };
    });
  });

  app.post('/api/retention/preview', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as Filter & { clubId?: string; callWithoutMessenger?: boolean };
    const flt = parseFilter(b);
    return withCtx(pool, ctx, async (db) => {
      await club(db, b.clubId);
      const today = await clubToday(db, b.clubId!);
      const hasWa = !!(await db.query(`select 1 from msg_channels where club_id = $1 and messenger = 'whatsapp' and status = 'active'`, [b.clubId])).rowCount;
      const rows = (await formerClients(db, b.clubId!, today, flt)).map((r) => { const [channel, reason] = channelFor(r, hasWa, b.callWithoutMessenger !== false); return { ...r, channel, reason }; });
      return { total: rows.length, message: rows.filter((r) => r.channel === 'message').length, call: rows.filter((r) => r.channel === 'call').length,
        skip: rows.filter((r) => r.channel === 'skip').length, sample: rows.slice(0, 50) };
    });
  });

  app.post('/api/retention/campaigns', async (req, reply) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as Filter & { clubId?: string; name?: string; template?: string; offer?: string; callWithoutMessenger?: boolean };
    const flt = parseFilter(b);
    if (!b.name?.trim()) throw badRequest('Назовите кампанию');
    const template = b.template?.trim() || DEFAULT_TEMPLATE;
    if (template.length > 1000) throw badRequest('Сообщение слишком длинное');
    const r = await withCtx(pool, ctx, async (db) => {
      await club(db, b.clubId);
      const id = (await db.query(`insert into retention_campaigns(tenant_id, club_id, name, filter, template, offer, call_without_messenger, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, b.clubId, b.name!.trim(), flt, template, b.offer?.trim() || null, b.callWithoutMessenger !== false, ctx.userId])).rows[0].id;
      await audit(db, ctx, 'retention.created', 'retention_campaign', id, null, { name: b.name, filter: flt });
      return { id };
    });
    reply.code(201); return r;
  });

  app.post('/api/retention/campaigns/:id/launch', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { id } = req.params as { id: string };
    if (!uuid(id)) throw notFound('Кампания не найдена');
    return withCtx(pool, ctx, (db) => launchCampaign(db, f, ctx, id));
  });

  app.get('/api/retention/campaigns', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      await club(db, clubId);
      await trackResults(db, ctx, clubId!);
      return (await db.query(`select c.id, c.name, c.offer, c.status, c.filter, c.template, c.created_at as "createdAt", c.launched_at as "launchedAt", u.full_name as author,
          count(cm.id)::int as members, count(cm.id) filter (where cm.channel = 'message')::int as messages, count(cm.id) filter (where cm.channel = 'call')::int as calls,
          count(cm.id) filter (where cm.channel = 'skip')::int as skipped, count(cm.replied_at)::int as replied, count(cm.bought_at)::int as bought,
          coalesce(sum(cm.bought_kop), 0)::bigint as "revenueKop"
        from retention_campaigns c left join campaign_members cm on cm.campaign_id = c.id left join users u on u.id = c.created_by
        where c.club_id = $1 group by c.id, u.full_name order by c.created_at desc`, [clubId])).rows;
    });
  });

  app.get('/api/retention/campaigns/:id', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { id } = req.params as { id: string };
    if (!uuid(id)) throw notFound('Кампания не найдена');
    return withCtx(pool, ctx, async (db) => {
      const c = (await db.query('select id, name, status, offer from retention_campaigns where id = $1', [id])).rows[0];
      if (!c) throw notFound('Кампания не найдена');
      const members = (await db.query(`select cm.person_id as "personId", p.full_name as name, to_char(cm.left_on, 'YYYY-MM-DD') as "leftOn", cm.channel, cm.skip_reason as reason,
          m.status as "messageStatus", cm.replied_at as "repliedAt", cm.bought_at as "boughtAt", cm.bought_kop as "boughtKop", t.done_at as "taskDoneAt", t.result as "taskResult"
        from campaign_members cm join persons p on p.id = cm.person_id left join msg_messages m on m.id = cm.message_id left join tasks t on t.id = cm.task_id
        where cm.campaign_id = $1 order by cm.bought_at desc nulls last, cm.replied_at desc nulls last, p.full_name`, [id])).rows;
      return { ...c, members };
    });
  });

  app.get('/api/retention/early', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      await club(db, clubId);
      const s = (await db.query(`select early_enabled as "enabled", early_days as "days", early_call_without_messenger as "callWithoutMessenger", early_template as template
        from club_retention_settings where club_id = $1`, [clubId])).rows[0] ?? { enabled: true, days: 30, callWithoutMessenger: true, template: EARLY_TEMPLATE };
      const offers = (await db.query(`select o.id, o.person_id as "personId", p.full_name as name, m.product_name as product, o.amount_kop as "amountKop", to_char(o.valid_until, 'YYYY-MM-DD') as "validUntil",
          o.status, o.skip_reason as reason, o.replied_at as "repliedAt", o.created_at as "createdAt", (n.id is not null) as renewed
        from renewal_offers o join persons p on p.id = o.person_id join memberships m on m.id = o.membership_id
        left join memberships n on n.renewed_from_id = o.membership_id and n.status <> 'cancelled'
        where o.club_id = $1 order by o.created_at desc limit 200`, [clubId])).rows;
      const total = offers.filter((o) => o.status !== 'skipped').length; const renewed = offers.filter((o) => o.renewed).length;
      return { settings: s, offers, total, renewed, percent: total ? Math.round((renewed * 100) / total) : null };
    });
  });

  app.put('/api/retention/early', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as { clubId?: string; enabled?: boolean; days?: number; callWithoutMessenger?: boolean; template?: string };
    const days = Number(b.days ?? 30);
    if (!Number.isInteger(days) || days < 7 || days > 90) throw badRequest('За сколько дней предлагать: от 7 до 90');
    if (b.template !== undefined && b.template.trim().length < 10) throw badRequest('Текст предложения слишком короткий');
    return withCtx(pool, ctx, async (db) => {
      await club(db, b.clubId);
      await db.query(`insert into club_retention_settings(club_id, tenant_id, early_enabled, early_days, early_call_without_messenger, updated_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (club_id) do update set early_enabled = excluded.early_enabled, early_days = excluded.early_days, early_call_without_messenger = excluded.early_call_without_messenger,
          updated_by = excluded.updated_by, updated_at = now()`, [b.clubId, ctx.tenantId, b.enabled !== false, days, b.callWithoutMessenger !== false, ctx.userId]);
      if (b.template?.trim()) await db.query('update club_retention_settings set early_template = $2 where club_id = $1', [b.clubId, b.template.trim()]);
      await audit(db, ctx, 'retention.early_settings', 'club', b.clubId!, null, { enabled: b.enabled !== false, days });
      return { ok: true };
    });
  });
}

function monthsAgo(d: string, today: string) {
  const [y1, m1, d1] = d.split('-').map(Number); const [y2, m2, d2] = today.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}
