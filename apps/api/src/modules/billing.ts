// Шаг 12. Онлайн-оплата по ссылке (карта и СБП), сохранённая карта, автосписание подписки, начисления подписки по периодам.
// Банк клуба выбирается в настройках («Касса» → «Онлайн-оплата»). Пока стоит встроенный «Тестовый банк».
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { decrypt, encrypt } from './fiscal.ts';
import { addDays, addMonths, clubToday, getSettings, payCharge } from './memberships.ts';
import { chargeSaved, checkConnection, createPayment, getPayment, notificationId, PayError, type Acq, type Fetch, type PayState } from './payProviders.ts';
import { conversationFor, deliver, queueMessage } from './messaging.ts';

type Actor = { tenantId: string; userId: string | null };
const PROVIDERS: Record<string, string> = { test: 'Тестовый банк', yookassa: 'ЮKassa', tbank: 'Т-Банк' };
const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const rubText = (kop: number) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/* ---------- настройки банка клуба ---------- */
export async function getAcq(db: Db, clubId: string) {
  const r = (await db.query(`select provider, live, shop_id, secret_enc, sbp_enabled, autopay_enabled, link_hours, updated_at from club_acquiring where club_id = $1`, [clubId])).rows[0];
  const row = r ?? { provider: 'test', live: false, shop_id: null, secret_enc: null, sbp_enabled: true, autopay_enabled: true, link_hours: 72 };
  return {
    view: { provider: row.provider as string, providerName: PROVIDERS[row.provider], live: row.live as boolean, shopId: row.shop_id as string | null, hasSecret: !!row.secret_enc,
      sbpEnabled: row.sbp_enabled as boolean, autopayEnabled: row.autopay_enabled as boolean, linkHours: row.link_hours as number, updatedAt: row.updated_at ?? null },
    acq: { provider: row.provider, live: row.live, shopId: row.shop_id, secret: row.secret_enc ? decrypt(row.secret_enc) : null } as Acq,
  };
}
const base = (req: FastifyRequest) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');

/* ---------- результат оплаты ---------- */
type Op = { id: string; tenant_id: string; club_id: string; person_id: string; charge_id: string | null; purpose: string; amount_kop: string; description: string;
  provider: string; live: boolean; status: string; external_id: string | null; save_method: boolean; created_by: string | null };

/** Применяет ответ банка: оплачено — закрываем начисление, пробиваем чек, сохраняем карту; отказ — записываем причину. */
export async function applyState(db: Db, op: Op, st: PayState, actor: Actor) {
  if (op.status === 'succeeded' || op.status === 'failed' || op.status === 'cancelled') return op.status;
  if (st.status === 'pending') { await db.query(`update online_payments set status = 'pending', last_checked_at = now() where id = $1`, [op.id]); return 'pending'; }
  if (st.status === 'succeeded') {
    let pmId: string | null = null;
    if (op.save_method && st.saved) {
      const ex = (await db.query(`select id from person_payment_methods where person_id = $1 and provider = $2 and status = 'active' and title = $3`, [op.person_id, op.provider, st.saved.title])).rows[0];
      pmId = ex?.id ?? (await db.query(`insert into person_payment_methods(tenant_id, club_id, person_id, provider, live, token_enc, title) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [op.tenant_id, op.club_id, op.person_id, op.provider, op.live, encrypt(st.saved.token), st.saved.title])).rows[0].id;
      if (ex) await db.query('update person_payment_methods set token_enc = $2 where id = $1', [ex.id, encrypt(st.saved.token)]);
    }
    let conflict: string | null = null;
    const method = st.method === 'sbp' ? 'sbp' : 'online';
    if (op.charge_id) {
      const receipt = await payCharge(db, actor, op.charge_id, method);
      if (receipt === null) {
        const c = (await db.query('select status, paid_method from charges where id = $1', [op.charge_id])).rows[0];
        if (c?.status === 'paid' && c.paid_method !== method) conflict = 'Начисление уже было оплачено другим способом: оформите возврат клиенту';
      }
    }
    await db.query(`update online_payments set status = 'succeeded', method = $2, paid_at = now(), last_checked_at = now(), payment_method_id = coalesce($3, payment_method_id), conflict = $4 where id = $1`,
      [op.id, st.method ?? 'card', pmId, conflict]);
    return 'succeeded';
  }
  await db.query(`update online_payments set status = $2, error = $3, last_checked_at = now() where id = $1`, [op.id, st.status, st.error ?? null]);
  if (op.purpose === 'autopay' && op.charge_id) {
    const s = await getSettings(db, op.club_id);
    const today = await clubToday(db, op.club_id);
    await db.query(`update charges set autopay_attempts = autopay_attempts + 1, autopay_next_on = $2, autopay_error = $3 where id = $1`,
      [op.charge_id, addDays(today, s.subscriptionRetryIntervalDays), st.error ?? 'Банк отказал']);
  }
  return st.status;
}

/** Перепроверить оплату у банка (уведомления на компьютер в клубе не доходят, поэтому система спрашивает сама). */
export async function checkOp(db: Db, f: Fetch, opId: string, actor: Actor) {
  const op = (await db.query(`select * from online_payments where id = $1 for update`, [opId])).rows[0] as Op & { expires_at: string | null; payment_method_id: string | null } | undefined;
  if (!op || !['created', 'pending'].includes(op.status)) return op?.status ?? null;
  if (op.expires_at && Date.parse(op.expires_at) < Date.now() && op.status === 'created') {
    await db.query(`update online_payments set status = 'expired' where id = $1`, [opId]); return 'expired';
  }
  if (op.provider === 'test' || !op.external_id) return op.status;
  const { acq } = await getAcq(db, op.club_id);
  try {
    return await applyState(db, op, await getPayment(f, { ...acq, provider: op.provider, live: op.live }, op.external_id, { save: op.save_method, customerKey: op.person_id }), actor);
  } catch (e) {
    await db.query('update online_payments set last_checked_at = now(), error = $2 where id = $1', [opId, e instanceof PayError ? e.message : 'Банк не ответил']);
    return op.status;
  }
}

/** Ссылка на оплату начисления. Одна действующая ссылка на начисление: повторный запрос вернёт ту же. */
export async function payLink(db: Db, f: Fetch, actor: Actor, chargeId: string, baseUrl: string) {
  const c = (await db.query(`select ch.*, cl.name as club_name, p.autopay_enabled from charges ch join clubs cl on cl.id = ch.club_id join persons p on p.id = ch.person_id where ch.id = $1`, [chargeId])).rows[0];
  if (!c) throw notFound('Начисление не найдено');
  if (c.status !== 'due') throw badRequest('Начисление уже оплачено или отменено');
  const live = (await db.query(`select id from online_payments where charge_id = $1 and purpose = 'link' and status in ('created', 'pending') and (expires_at is null or expires_at > now()) order by created_at desc limit 1`, [chargeId])).rows[0];
  if (live) return { id: live.id as string, url: `${baseUrl}/pay/${live.id}`, reused: true };
  const { view, acq } = await getAcq(db, c.club_id);
  // Карту сохраняем для подписки, если клиент согласился на автосписание (галочка в карточке)
  const save = c.kind === 'subscription' && c.autopay_enabled && view.autopayEnabled;
  const description = `${c.club_name}: ${c.title}`;
  const id = (await db.query(`insert into online_payments(tenant_id, club_id, person_id, charge_id, purpose, amount_kop, description, provider, live, save_method, expires_at, created_by)
    values ($1,$2,$3,$4,'link',$5,$6,$7,$8,$9, now() + make_interval(hours => $10), $11) returning id`,
  [actor.tenantId, c.club_id, c.person_id, chargeId, c.amount_kop, description, view.provider, view.live, save, view.linkHours, actor.userId])).rows[0].id as string;
  try {
    const r = await createPayment(f, acq, { id, amountKop: Number(c.amount_kop), description, returnUrl: `${baseUrl}/pay/${id}?back=1`,
      notifyUrl: process.env.PUBLIC_URL ? `${baseUrl}/api/hooks/pay/${c.club_id}` : null, save, customerKey: c.person_id });
    await db.query('update online_payments set external_id = $2, confirmation_url = $3 where id = $1', [id, r.externalId, r.url]);
  } catch (e) {
    if (e instanceof PayError) throw badRequest(e.message);
    throw e;
  }
  return { id, url: `${baseUrl}/pay/${id}`, reused: false };
}

/* ---------- подписка: начисления по периодам и автосписание ---------- */
/** Наступила дата очередного списания подписки — создаём начисление за следующий месяц и продлеваем период. Без оплаты проход закроется по правилам долга. */
export async function generateSubscriptionCharges(db: Db, actor: Actor, clubId: string, today: string) {
  const subs = (await db.query(`select id, person_id, product_name, amount_kop, to_char(next_charge_on, 'YYYY-MM-DD') as next from memberships
    where club_id = $1 and kind = 'subscription' and status = 'active' and next_charge_on <= $2`, [clubId, today])).rows;
  let created = 0;
  for (const m of subs) {
    let next = m.next as string;
    for (let i = 0; i < 3 && next <= today; i++) {
      const end = addDays(addMonths(next, 1), -1);
      const exists = (await db.query(`select 1 from charges where membership_id = $1 and kind = 'subscription' and due_on = $2`, [m.id, next])).rowCount;
      if (!exists) {
        await db.query(`insert into charges(tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop) values ($1,$2,$3,$4,'subscription',$5,$6,$7)`,
          [actor.tenantId, clubId, m.id, m.person_id, `${m.product_name}: ${ru(next)} – ${ru(end)}`, next, m.amount_kop]);
        await db.query(`insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,'subscription_period',$4,$5)`,
          [actor.tenantId, clubId, m.id, JSON.stringify({ from: next, to: end }), actor.userId]);
        created++;
      }
      await db.query(`update memberships set ends_on = greatest(ends_on, $2::date), next_charge_on = $3, updated_at = now() where id = $1`, [m.id, end, addMonths(next, 1)]);
      next = addMonths(next, 1);
    }
  }
  return created;
}

/** Автосписание с сохранённой карты: подписка, клиент согласен (галочка), у клуба включено, попытки по настройкам клуба. */
export async function runAutopay(db: Db, f: Fetch, actor: Actor, clubId: string, today: string) {
  const { view, acq } = await getAcq(db, clubId);
  const out = { charged: 0, failed: 0, noCard: 0 };
  if (!view.autopayEnabled) return out;
  const s = await getSettings(db, clubId);
  const due = (await db.query(`select c.id, c.person_id, c.amount_kop, c.title, cl.name as club_name from charges c join persons p on p.id = c.person_id join clubs cl on cl.id = c.club_id
    where c.club_id = $1 and c.kind = 'subscription' and c.status = 'due' and c.due_on <= $2 and p.autopay_enabled
      and c.autopay_attempts < $3 and (c.autopay_next_on is null or c.autopay_next_on <= $2)
      and not exists (select 1 from online_payments o where o.charge_id = c.id and o.status in ('created', 'pending') and o.purpose = 'autopay')
    order by c.due_on limit 200`, [clubId, today, s.subscriptionRetryAttempts])).rows;
  for (const c of due) {
    const pm = (await db.query(`select id, token_enc from person_payment_methods where person_id = $1 and provider = $2 and live = $3 and status = 'active' order by created_at desc limit 1`,
      [c.person_id, view.provider, view.live])).rows[0];
    if (!pm) {
      await db.query(`update charges set autopay_error = 'Нет сохранённой карты: отправьте клиенту ссылку на оплату' where id = $1 and autopay_error is distinct from 'Нет сохранённой карты: отправьте клиенту ссылку на оплату'`, [c.id]);
      out.noCard++; continue;
    }
    const description = `${c.club_name}: ${c.title}`;
    const op = (await db.query(`insert into online_payments(tenant_id, club_id, person_id, charge_id, purpose, amount_kop, description, provider, live, payment_method_id, status)
      values ($1,$2,$3,$4,'autopay',$5,$6,$7,$8,$9,'pending') returning *`, [actor.tenantId, clubId, c.person_id, c.id, c.amount_kop, description, view.provider, view.live, pm.id])).rows[0] as Op;
    try {
      const r = await chargeSaved(f, acq, { id: op.id, amountKop: Number(c.amount_kop), description, token: decrypt(pm.token_enc), customerKey: c.person_id });
      await db.query('update online_payments set external_id = $2 where id = $1', [op.id, r.externalId]);
      await db.query('update person_payment_methods set last_used_at = now() where id = $1', [pm.id]);
      const st = await applyState(db, op, { ...r, saved: null }, actor);
      if (st === 'succeeded') out.charged++; else if (st !== 'pending') out.failed++;
    } catch (e) {
      await applyState(db, op, { status: 'failed', error: e instanceof PayError ? e.message : 'Банк не ответил' }, actor);
      out.failed++;
    }
  }
  return out;
}

export async function runBillingForClub(db: Db, f: Fetch, actor: Actor, clubId: string) {
  const today = await clubToday(db, clubId);
  const periods = await generateSubscriptionCharges(db, actor, clubId, today);
  const autopay = await runAutopay(db, f, actor, clubId, today);
  return { periods, ...autopay };
}

export async function processBilling(pool: pg.Pool, f: Fetch) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const actor = { tenantId, userId: null };
    const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select id from clubs where status = 'active'`)).rows);
    for (const { id } of clubs) {
      await withCtx(pool, sys, (db) => runBillingForClub(db, f, actor, id)).catch((e) => console.error('Ошибка списаний:', (e as Error).message));
    }
    const pending = await withCtx(pool, sys, async (db) => (await db.query(`select id from online_payments where status in ('created', 'pending')
      and (last_checked_at is null or last_checked_at < now() - interval '30 seconds') and created_at > now() - interval '3 days' order by created_at limit 50`)).rows);
    for (const { id } of pending) await withCtx(pool, sys, (db) => checkOp(db, f, id, actor)).catch(() => {});
  }
}

export function startBillingWorker(pool: pg.Pool, f: Fetch = fetch, everyMs = 60_000) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processBilling(pool, f); } catch (e) { console.error('Ошибка оплат:', (e as Error).message); } finally { busy = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/* ---------- страницы для клиента ---------- */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function page(title: string, body: string) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#f4f6f7;--card:#fff;--fg:#13232a;--mut:#5f6f75;--ok:#15803d;--bad:#b91c1c;--line:#dde3e5;--acc:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1517;--card:#172024;--fg:#e6eef0;--mut:#9fb0b5;--line:#2a373b;--ok:#4ade80;--bad:#f87171;--acc:#2dd4bf}}
*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.w{max-width:440px;margin:0 auto;padding:24px 16px}.c{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;display:grid;gap:12px}
h1{font-size:20px;margin:0}.m{color:var(--mut);font-size:14px}.sum{font-size:30px;font-weight:700}.ok{color:var(--ok)}.bad{color:var(--bad)}
input{width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit;letter-spacing:.06em}
button{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-weight:600;cursor:pointer}
button.p{background:var(--acc);border-color:var(--acc);color:#fff}.tag{display:inline-block;padding:2px 10px;border-radius:99px;background:#fde68a;color:#713f12;font-size:12px;font-weight:700}
label{display:flex;gap:8px;align-items:center;font-size:14px}label input{width:auto}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}</style></head>
<body><div class="w">${body}</div></body></html>`;
}

export function billingRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;
  // Форма тестового банка отправляется обычным POST формы
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 10_000 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  }
  const sysCtx = (tenantId: string) => ({ tenantId, allClubs: true, clubIds: [] as string[] });

  /* --- настройки банка --- */
  app.get('/api/clubs/:id/acquiring', async (req) => {
    const ctx = requirePerm(req, P.fiscalManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await getAcq(db, id)).view);
  });

  app.put('/api/clubs/:id/acquiring', async (req) => {
    const ctx = requirePerm(req, P.fiscalManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { provider?: string; live?: boolean; shopId?: string; secret?: string; sbpEnabled?: boolean; autopayEnabled?: boolean; linkHours?: number };
    if (!PROVIDERS[b.provider ?? '']) throw badRequest('Выберите банк');
    if (b.provider === 'test' && b.live) throw badRequest('Тестовый банк не принимает настоящие деньги: выберите банк для боевого режима');
    if (b.provider !== 'test' && !b.shopId?.trim()) throw badRequest(b.provider === 'tbank' ? 'Укажите TerminalKey терминала' : 'Укажите shopId магазина');
    if (b.linkHours !== undefined && !(Number.isInteger(b.linkHours) && b.linkHours >= 1 && b.linkHours <= 720)) throw badRequest('Срок ссылки: от 1 до 720 часов');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw notFound('Клуб не найден');
      const before = (await getAcq(db, id)).view;
      const secret = b.secret?.trim() ? encrypt(b.secret.trim()) : null;
      if (b.provider !== 'test' && !secret && !(before.hasSecret && before.provider === b.provider)) throw badRequest(b.provider === 'tbank' ? 'Укажите пароль терминала' : 'Укажите секретный ключ');
      await db.query(`insert into club_acquiring(club_id, tenant_id, provider, live, shop_id, secret_enc, sbp_enabled, autopay_enabled, link_hours, updated_by, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) on conflict (club_id) do update set provider = excluded.provider, live = excluded.live, shop_id = excluded.shop_id,
          secret_enc = case when excluded.provider = 'test' then null else coalesce(excluded.secret_enc, club_acquiring.secret_enc) end,
          sbp_enabled = excluded.sbp_enabled, autopay_enabled = excluded.autopay_enabled, link_hours = excluded.link_hours, updated_by = excluded.updated_by, updated_at = now()`,
      [id, ctx.tenantId, b.provider, !!b.live, b.provider === 'test' ? null : b.shopId!.trim(), secret, b.sbpEnabled ?? true, b.autopayEnabled ?? true, b.linkHours ?? 72, ctx.userId]);
      const after = (await getAcq(db, id)).view;
      await audit(db, ctx, 'club.acquiring_changed', 'club', id, before, after);
      return after;
    });
  });

  app.post('/api/clubs/:id/acquiring/test', async (req) => {
    const ctx = requirePerm(req, P.fiscalManage);
    const { id } = req.params as { id: string };
    const { acq } = await withCtx(pool, ctx, (db) => getAcq(db, id));
    try { return { ok: true, info: await checkConnection(f, acq) }; } catch (e) { if (e instanceof PayError) throw badRequest(e.message); throw badRequest('Банк не ответил: проверьте интернет'); }
  });

  /* --- ссылка на оплату --- */
  app.post('/api/charges/:id/pay-link', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    const { send } = (req.body ?? {}) as { send?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const r = await payLink(db, f, ctx, id, base(req));
      let sent: string | null = null;
      if (send) {
        const c = (await db.query(`select ch.person_id, ch.club_id, ch.title, ch.amount_kop from charges ch where ch.id = $1`, [id])).rows[0];
        const conv = await conversationFor(db, ctx, c.person_id, c.club_id, true);
        if (!conv || conv === 'new') throw badRequest('У клиента нет переписки в мессенджере клуба и телефона для WhatsApp: скопируйте ссылку и отправьте сами');
        const msg = await queueMessage(db, ctx, conv, `Ссылка на оплату «${c.title}», ${rubText(Number(c.amount_kop))}: ${r.url}\nМожно оплатить картой или через СБП.`);
        await deliver(db, f, msg);
        sent = msg;
      }
      await audit(db, ctx, 'charge.pay_link', 'charge', id, null, { onlinePaymentId: r.id, sent: !!sent });
      return { ...r, sent: !!sent };
    });
  });

  app.get('/api/online-payments', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId, status } = req.query as { clubId?: string; status?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`select o.id, o.created_at as "createdAt", o.paid_at as "paidAt", o.purpose, o.amount_kop::int as "amountKop", o.description,
        o.provider, o.live, o.status, o.method, o.error, o.conflict, p.full_name as person, o.person_id as "personId", u.full_name as "createdBy", pm.title as card
      from online_payments o join persons p on p.id = o.person_id left join users u on u.id = o.created_by left join person_payment_methods pm on pm.id = o.payment_method_id
      where ($1::uuid is null or o.club_id = $1) and ($2::text is null or o.status = $2) order by o.created_at desc limit 300`, [clubId || null, status || null])).rows
      .map((r) => ({ ...r, providerName: PROVIDERS[r.provider] ?? r.provider })));
  });

  app.post('/api/online-payments/:id/check', async (req) => {
    const ctx = requirePerm(req, P.membershipsSell);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => ({ status: await checkOp(db, f, id, ctx) }));
  });

  /* --- карты клиента --- */
  app.get('/api/persons/:id/payment-methods', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const methods = (await db.query(`select id, provider, live, title, created_at as "createdAt", last_used_at as "lastUsedAt" from person_payment_methods where person_id = $1 and status = 'active' order by created_at desc`, [id])).rows
        .map((m) => ({ ...m, providerName: PROVIDERS[m.provider] ?? m.provider }))
        .map((r) => ({ ...r, providerName: PROVIDERS[r.provider] }));
      const payments = (await db.query(`select id, created_at as "createdAt", purpose, amount_kop::int as "amountKop", status, method, error, conflict, description
        from online_payments where person_id = $1 order by created_at desc limit 10`, [id])).rows;
      const autopay = (await db.query(`select id, title, to_char(due_on, 'YYYY-MM-DD') as "dueOn", amount_kop::int as "amountKop", autopay_attempts as attempts,
          to_char(autopay_next_on, 'YYYY-MM-DD') as "nextOn", autopay_error as error from charges where person_id = $1 and kind = 'subscription' and status = 'due' order by due_on`, [id])).rows;
      return { methods, payments, autopay };
    });
  });

  app.post('/api/payment-methods/:id/remove', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const m = (await db.query(`select person_id, status, title from person_payment_methods where id = $1`, [id])).rows[0];
      if (!m) throw notFound('Карта не найдена');
      if (m.status !== 'active') throw badRequest('Карта уже отвязана');
      await db.query(`update person_payment_methods set status = 'removed', removed_at = now(), removed_by = $2 where id = $1`, [id, ctx.userId]);
      await audit(db, ctx, 'person.card_removed', 'person', m.person_id, { card: m.title }, null);
      return { ok: true };
    });
  });

  /* --- запуск списаний вручную (обычно раз в минуту сам) --- */
  app.post('/api/billing/run', async (req) => {
    const ctx = requirePerm(req, P.fiscalManage);
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!clubId || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
      return runBillingForClub(db, f, ctx, clubId);
    });
  });

  /* --- уведомления банка (после переезда на сервер с внешним адресом) --- */
  app.post('/api/hooks/pay/:clubId', async (req, reply) => {
    const { clubId } = req.params as { clubId: string };
    if (!/^[0-9a-f-]{36}$/i.test(clubId)) return reply.code(404).send({ error: 'not_found' });
    const t = (await pool.query('select tenant_id from acquiring_club_tenant($1)', [clubId])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    await withCtx(pool, sysCtx(t.tenant_id), async (db) => {
      const { acq } = await getAcq(db, clubId);
      const ext = notificationId(acq, req.body);
      if (!ext) return;
      const op = (await db.query('select id from online_payments where provider = $1 and external_id = $2 and club_id = $3', [acq.provider, ext, clubId])).rows[0];
      if (op) await checkOp(db, f, op.id, { tenantId: t.tenant_id, userId: null });
    });
    return acq_ok(reply);
  });
  const acq_ok = (reply: FastifyReply) => reply.type('text/plain').send('OK');

  /* --- страница оплаты по ссылке --- */
  const loadPublic = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const t = (await pool.query('select tenant_id from online_payment_tenant($1)', [id])).rows[0];
    if (!t) return null;
    return withCtx(pool, sysCtx(t.tenant_id), async (db) => {
      await checkOp(db, f, id, { tenantId: t.tenant_id, userId: null });
      const op = (await db.query(`select o.*, c.name as club_name, (select x.id from online_orders x where x.online_payment_id = o.id) as order_id from online_payments o join clubs c on c.id = o.club_id where o.id = $1`, [id])).rows[0];
      const acq = (await db.query('select sbp_enabled from club_acquiring where club_id = $1', [op.club_id])).rows[0];
      return { ...op, tenant: t.tenant_id as string, sbp: acq?.sbp_enabled ?? true };
    });
  };

  app.get('/pay/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const op = await loadPublic(id);
    reply.type('text/html; charset=utf-8');
    if (!op) return reply.code(404).send(page('Ссылка не найдена', '<div class="c"><h1>Ссылка не найдена</h1><p class="m">Попросите клуб прислать новую ссылку на оплату.</p></div>'));
    const head = `<div class="m">${esc(op.club_name)}</div><h1>${esc(op.description.replace(`${op.club_name}: `, ''))}</h1><div class="sum">${rubText(Number(op.amount_kop))}</div>`;
    // Покупка онлайн: после оплаты клиент попадает на страницу заказа с QR-кодом для прохода
    if (op.order_id && ['succeeded', 'failed', 'cancelled', 'expired'].includes(op.status)) return reply.redirect(`/buy/order/${op.order_id}`, 303);
    if (op.status === 'succeeded') return page('Оплачено', `<div class="c">${head}<h1 class="ok">Оплата прошла</h1><p class="m">Спасибо! Чек придёт на телефон или почту, указанные в клубе.${op.payment_method_id ? ' Карта сохранена для автосписания подписки.' : ''}</p></div>`);
    if (op.status === 'expired') return page('Ссылка устарела', `<div class="c">${head}<h1 class="bad">Ссылка устарела</h1><p class="m">Попросите клуб прислать новую ссылку.</p></div>`);
    if (op.status === 'failed' || op.status === 'cancelled') return page('Оплата не прошла', `<div class="c">${head}<h1 class="bad">Оплата не прошла</h1><p class="m">${esc(op.error ?? '')} Попросите клуб прислать новую ссылку или оплатите на ресепшн.</p></div>`);
    if (op.purpose !== 'link' && op.purpose !== 'buy') return reply.code(404).send(page('Ссылка не найдена', '<div class="c"><h1>Ссылка не найдена</h1></div>'));
    if (op.provider !== 'test') {
      if ((req.query as { back?: string }).back) return page('Проверяем оплату', `<div class="c">${head}<h1>Проверяем оплату…</h1><p class="m">Банк ещё не подтвердил оплату. Страница обновится сама.</p></div><script>setTimeout(()=>location.reload(),4000)</script>`);
      if (op.confirmation_url) return reply.redirect(op.confirmation_url);
      return page('Ошибка', `<div class="c">${head}<p class="bad">Банк не выдал страницу оплаты. Попросите клуб прислать новую ссылку.</p></div>`);
    }
    // Тестовый банк: страница оплаты внутри системы
    return page('Тестовый банк', `<form class="c" method="post" action="/pay/${op.id}/test"><span class="tag">ТЕСТОВЫЙ БАНК: деньги не списываются</span>${head}
      <div class="row"><label><input type="radio" name="method" value="card" checked> Картой</label>${op.sbp ? '<label><input type="radio" name="method" value="sbp"> Через СБП</label>' : ''}</div>
      <input name="card" value="4242 4242 4242 4242" aria-label="Номер карты" inputmode="numeric">
      <div class="m">Тестовые карты: 4242… — успех; …0002 — банк откажет; …9995 — оплата пройдёт, а автосписание потом не пройдёт («недостаточно средств»).</div>
      ${op.save_method ? '<label><input type="checkbox" name="save" value="1" checked> Сохранить карту для автосписания подписки</label>' : ''}
      <button class="p" name="result" value="pay">Оплатить ${rubText(Number(op.amount_kop))}</button><button name="result" value="cancel">Отказаться</button></form>`);
  });

  app.post('/pay/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { method?: string; card?: string; save?: string; result?: string };
    const t = /^[0-9a-f-]{36}$/i.test(id) ? (await pool.query('select tenant_id from online_payment_tenant($1)', [id])).rows[0] : null;
    if (!t) return reply.code(404).send({ error: 'not_found' });
    await withCtx(pool, sysCtx(t.tenant_id), async (db) => {
      const op = (await db.query(`select * from online_payments where id = $1 for update`, [id])).rows[0] as Op | undefined;
      if (!op || op.provider !== 'test' || !['created', 'pending'].includes(op.status)) return;
      const digits = String(b.card ?? '').replace(/\D/g, '');
      const actor = { tenantId: t.tenant_id, userId: null };
      if (b.result === 'cancel') { await applyState(db, op, { status: 'cancelled', error: 'Клиент отказался от оплаты' }, actor); return; }
      if (b.method !== 'sbp' && digits.endsWith('0002')) { await applyState(db, op, { status: 'failed', error: 'Банк отказал в оплате' }, actor); return; }
      const save = op.save_method && b.save === '1' && b.method !== 'sbp';
      await applyState(db, { ...op, save_method: save }, { status: 'succeeded', method: b.method === 'sbp' ? 'sbp' : 'card',
        saved: save ? { token: `tok-${randomBytes(6).toString('hex')}-${digits.slice(-4)}`, title: `Карта •••• ${digits.slice(-4) || '0000'}` } : null }, actor);
    });
    return reply.redirect(`/pay/${id}`, 303);
  });
}

