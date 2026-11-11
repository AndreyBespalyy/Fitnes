// Покупка абонемента онлайн без менеджера (список «20 новых возможностей», п. 12).
// Клиент открывает ссылку клуба, выбирает тариф, вводит данные, принимает договор-оферту и правила, платит онлайн.
// После оплаты система сама оформляет абонемент, заключает договор (акцепт оферты оплатой), выдаёт QR-код для прохода
// и ставит менеджеру задачу «поздравить и записать на вводную». Пока клиент не заплатил, абонемента нет: продажи не завышаются.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { checkOp, esc, getAcq, page } from './billing.ts';
import { createLead, normalizePhone } from './crm.ts';
import { addDays, clubToday, payCharge, sellMembership } from './memberships.ts';
import { createPayment, PayError, type Fetch } from './payProviders.ts';
import { referralDiscount } from './referrals.ts';
import { task } from './retention.ts';

type Actor = { tenantId: string; userId: string | null; ip?: string };
const sys = (tenantId: string) => ({ tenantId, allClubs: true, clubIds: [] as string[] });
const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND: Record<string, string> = { term: 'абонемент на срок', subscription: 'подписка, оплата каждый месяц', visits: 'пакет посещений', personal: 'персональные тренировки', guest: 'разовый визит' };
const publicBase = (req: FastifyRequest) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');

export async function buySettings(db: Db, clubId: string) {
  const r = (await db.query('select enabled, max_start_days, note from club_online_buy where club_id = $1', [clubId])).rows[0];
  return { enabled: r?.enabled ?? false, maxStartDays: r?.max_start_days ?? 30, note: (r?.note ?? null) as string | null };
}
async function buyProducts(db: Db, clubId: string) {
  return (await db.query(`select p.id, p.name, p.kind, p.duration_days as "durationDays", p.visits_count as "visitsCount", p.validity_days as "validityDays",
      to_char(p.access_from, 'HH24:MI') as "accessFrom", to_char(p.access_to, 'HH24:MI') as "accessTo",
      (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by v.valid_from desc limit 1)::bigint as "priceKop"
    from products p where p.club_id = $1 and p.is_active and p.sell_online order by p.sort, p.name`, [clubId])).rows
    .filter((p) => p.priceKop).map((p) => ({ ...p, priceKop: Number(p.priceKop) }));
}
async function currentDocs(db: Db, clubId: string) {
  return (await db.query(`select d.kind, d.title, d.version, f.sha256, f.storage_path, f.mime from club_documents d join files f on f.id = d.file_id where d.club_id = $1 and d.is_current`, [clubId])).rows as
    { kind: 'contract' | 'rules'; title: string; version: number; sha256: string; storage_path: string; mime: string }[];
}
function productLine(p: { kind: string; durationDays: number | null; visitsCount: number | null; validityDays: number | null; accessFrom: string | null; accessTo: string | null }) {
  const parts = [KIND[p.kind] ?? p.kind];
  if (p.kind === 'term' && p.durationDays) parts.push(`${p.durationDays} дн.`);
  if ((p.kind === 'visits' || p.kind === 'personal') && p.visitsCount) parts.push(`${p.visitsCount} занятий за ${p.validityDays ?? 90} дн.`);
  if (p.accessFrom || p.accessTo) parts.push(`проход ${p.accessFrom ?? '00:00'}–${p.accessTo ?? '24:00'}`);
  return parts.join(', ');
}

/* ---------- заказ ---------- */
type OrderIn = { productId?: string; name?: string; phone?: string; email?: string; startsOn?: string; offer?: string | boolean; consent?: string | boolean; autopay?: string | boolean };

export async function placeOrder(db: Db, f: Fetch, actor: Actor, clubId: string, b: OrderIn, meta: { ip: string; ua: string; base: string }) {
  const s = await buySettings(db, clubId);
  if (!s.enabled) throw badRequest('Онлайн-покупка в этом клубе сейчас не работает');
  const p = (await buyProducts(db, clubId)).find((x) => x.id === b.productId);
  if (!p) throw badRequest('Выберите тариф');
  const name = (b.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) throw badRequest('Укажите имя и фамилию');
  const phone = normalizePhone(b.phone);
  if (!phone) throw badRequest('Телефон указан неверно. Нужен номер вида +7 900 000-00-00');
  const email = (b.email ?? '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('E-mail указан неверно');
  if (!b.offer) throw badRequest('Нужно принять договор-оферту и правила клуба');
  if (!b.consent) throw badRequest('Нужно согласие на обработку персональных данных');
  const docs = await currentDocs(db, clubId);
  if (!docs.some((d) => d.kind === 'contract')) throw badRequest('Онлайн-покупка в этом клубе сейчас не работает');
  const today = await clubToday(db, clubId);
  const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(b.startsOn ?? '') ? b.startsOn! : today;
  if (startsOn < today || startsOn > addDays(today, s.maxStartDays)) throw badRequest(`Дата начала: с сегодня до ${ru(addDays(today, s.maxStartDays))}`);

  const lead = await createLead(db, actor as never, { clubId, fullName: name, phone, email: email || undefined, sourceCode: 'site',
    comment: `Покупка онлайн: ${p.name}. Клиент принял договор-оферту и правила клуба, дал согласие на обработку персональных данных` });
  const personId = lead.personId as string;
  // Повторное нажатие: та же неоплаченная покупка — та же ссылка на оплату
  const same = (await db.query(`select o.id, o.online_payment_id from online_orders o join online_payments op on op.id = o.online_payment_id
    where o.person_id = $1 and o.product_id = $2 and o.status = 'awaiting_payment' and op.status in ('created', 'pending') and op.expires_at > now() order by o.created_at desc limit 1`, [personId, p.id])).rows[0];
  if (same) return { orderId: same.id as string, payUrl: `${meta.base}/pay/${same.online_payment_id}` };

  // Цена как при продаже на ресепшне: друг по рекомендации получает скидку на первую покупку
  const before = (await db.query('select count(*)::int as n from memberships where person_id = $1 and club_id = $2', [personId, clubId])).rows[0].n;
  const category = p.kind === 'subscription' ? 'subscription' : before > 0 ? 'return' : 'new';
  const rd = await referralDiscount(db, personId, clubId, category, p.priceKop);
  const amount = p.priceKop - (rd?.discountKop ?? 0);
  const autopay = p.kind === 'subscription' && !!b.autopay;
  const { view, acq } = await getAcq(db, clubId);
  const club = (await db.query('select name from clubs where id = $1', [clubId])).rows[0].name as string;
  const description = `${club}: ${p.name}`;
  const opId = (await db.query(`insert into online_payments(tenant_id, club_id, person_id, purpose, amount_kop, description, provider, live, save_method, expires_at)
    values ($1,$2,$3,'buy',$4,$5,$6,$7,$8, now() + interval '2 hours') returning id`,
  [actor.tenantId, clubId, personId, amount, description, view.provider, view.live, autopay && view.autopayEnabled])).rows[0].id as string;
  const docsSha = docs.map((d) => `${d.kind}:v${d.version}:${d.sha256}`).sort().join(';');
  const orderId = (await db.query(`insert into online_orders(tenant_id, club_id, person_id, product_id, online_payment_id, amount_kop, autopay, docs_sha256, ip, user_agent, starts_on)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
  [actor.tenantId, clubId, personId, p.id, opId, amount, autopay, docsSha, meta.ip, meta.ua.slice(0, 300), startsOn])).rows[0].id as string;
  try {
    const r = await createPayment(f, acq, { id: opId, amountKop: amount, description, returnUrl: `${meta.base}/pay/${opId}?back=1`,
      notifyUrl: process.env.PUBLIC_URL ? `${meta.base}/api/hooks/pay/${clubId}` : null, save: autopay && view.autopayEnabled, customerKey: personId });
    await db.query('update online_payments set external_id = $2, confirmation_url = $3 where id = $1', [opId, r.externalId, r.url]);
  } catch (e) {
    if (e instanceof PayError) throw badRequest('Банк сейчас не принимает оплату. Попробуйте позже или купите на ресепшне');
    throw e;
  }
  if (autopay) await db.query(`update persons set autopay_enabled = true, autopay_changed_at = now() where id = $1 and not autopay_enabled`, [personId]);
  await audit(db, actor as never, 'online_order.created', 'online_order', orderId, null, { productId: p.id, amountKop: amount, startsOn, autopay, ip: meta.ip });
  return { orderId, payUrl: `${meta.base}/pay/${opId}` };
}

/** Оплата пришла: оформить абонемент, закрыть начисление, заключить договор, выдать QR, отдать менеджеру задачу. Повторный вызов ничего не меняет. */
export async function finalizeOrder(db: Db, actor: Actor, orderId: string) {
  const o = (await db.query(`select o.*, to_char(o.starts_on, 'YYYY-MM-DD') as start, op.status as pay_status, op.method as pay_method, op.paid_at as op_paid_at, op.created_at as op_created
    from online_orders o join online_payments op on op.id = o.online_payment_id where o.id = $1 for update of o`, [orderId])).rows[0];
  if (!o || o.status !== 'awaiting_payment') return o?.status ?? null;
  if (['failed', 'cancelled', 'expired'].includes(o.pay_status)) {
    await db.query(`update online_orders set status = 'expired' where id = $1`, [orderId]);
    return 'expired';
  }
  if (o.pay_status !== 'succeeded') return 'awaiting_payment';
  const today = await clubToday(db, o.club_id);
  const sale = await sellMembership(db, { ...actor, ip: actor.ip ?? '' } as never, { personId: o.person_id, productId: o.product_id, startsOn: o.start < today ? today : o.start, confirmDuplicate: true });
  const charge = (await db.query(`select id, amount_kop from charges where membership_id = $1 and status = 'due' order by due_on limit 1`, [sale.id])).rows[0];
  let conflict: string | null = null;
  const method = o.pay_method === 'sbp' ? 'sbp' : 'online';
  if (charge && Number(charge.amount_kop) === Number(o.amount_kop)) {
    await payCharge(db, actor, charge.id, method);
    await db.query('update online_payments set charge_id = $2 where id = $1', [o.online_payment_id, charge.id]);
  } else conflict = `Оплачено онлайн ${rub(Number(o.amount_kop))}, а по тарифу сейчас ${charge ? rub(Number(charge.amount_kop)) : '—'}: цена изменилась, пока клиент платил. Отметьте оплату вручную и при необходимости верните разницу`;
  // Договор заключён акцептом оферты: клиент принял условия на странице и оплатил (ст. 438 ГК РФ)
  await db.query(`update contracts set status = 'signed', sign_method = 'online_offer', signed_at = coalesce($2, now()), signed_docs_sha256 = $3, signer_ip = $4, signer_user_agent = $5
    where membership_id = $1 and status = 'awaiting_signature'`, [sale.id, o.op_paid_at, o.docs_sha256, o.ip, o.user_agent]);
  // QR-код для прохода: если у клиента в этом клубе уже есть действующий — оставляем его
  let cred = (await db.query(`select id from access_credentials where person_id = $1 and club_id = $2 and kind = 'qr' and status = 'active' order by issued_at desc limit 1`, [o.person_id, o.club_id])).rows[0]?.id as string | undefined;
  if (!cred) {
    cred = (await db.query(`insert into access_credentials(tenant_id, club_id, person_id, kind, code) values ($1,$2,$3,'qr',$4) returning id`,
      [actor.tenantId, o.club_id, o.person_id, `QR${randomBytes(6).toString('hex').toUpperCase()}`])).rows[0].id as string;
  }
  // Сделка в воронке выиграна: продажа случилась без менеджера
  await db.query(`update opportunities x set status = 'won', closed_at = now(), updated_at = now(),
      stage_id = coalesce((select s.id from pipeline_stages s where s.pipeline_id = x.pipeline_id and s.kind = 'won' order by s.sort limit 1), x.stage_id)
    where x.person_id = $1 and x.club_id = $2 and x.status = 'open'`, [o.person_id, o.club_id]);
  const prod = (await db.query('select name from products where id = $1', [o.product_id])).rows[0]?.name ?? 'абонемент';
  const taskId = await task(db, actor as never, o.club_id, o.person_id,
    conflict ? `Покупка онлайн «${prod}»: ${conflict}` : `Купил(а) онлайн «${prod}»: поздравить, записать на вводную и рассказать, как пройти по QR-коду`, conflict ? 2 : 24);
  await db.query(`update online_orders set status = 'paid', paid_at = coalesce($2, now()), membership_id = $3, charge_id = $4, credential_id = $5, task_id = $6 where id = $1`,
    [orderId, o.op_paid_at, sale.id, charge?.id ?? null, cred, taskId]);
  if (conflict) await db.query('update online_payments set conflict = $2 where id = $1', [o.online_payment_id, conflict]);
  await audit(db, actor as never, 'online_order.paid', 'online_order', orderId, { status: 'awaiting_payment' }, { status: 'paid', membershipId: sale.id, contractId: sale.contractId, conflict });
  return 'paid';
}

/** Фоновая обработка: проверить оплату у банка, оформить оплаченные заказы, закрыть брошенные. */
export async function processOnlineOrders(db: Db, f: Fetch | null, actor: Actor, clubId: string) {
  const rows = (await db.query(`select o.id, o.online_payment_id from online_orders o where o.club_id = $1 and o.status = 'awaiting_payment' order by o.created_at limit 50`, [clubId])).rows;
  for (const r of rows) {
    await checkOp(db, f ?? fetch, r.online_payment_id, actor).catch(() => null);
    await finalizeOrder(db, actor, r.id);
  }
}

/* ---------- публичные страницы ---------- */
const CSS = `<style>.prod{display:grid;gap:8px}.prod label{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;border:1px solid var(--line);border-radius:12px;padding:12px;cursor:pointer}
.prod label:has(input:checked){border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}.prod b{display:block}.f{display:grid;gap:4px;font-size:14px;min-width:0}.f input{letter-spacing:0;min-width:0;max-width:100%}.c{min-width:0}
.chk{display:flex;gap:8px;align-items:flex-start;font-size:14px}.chk input{width:auto;margin-top:3px}a{color:var(--acc)}.err{background:#fee2e2;color:#7f1d1d;border-radius:10px;padding:10px;font-size:14px}
.qr{display:block;margin:0 auto;width:240px;height:240px;background:#fff;padding:8px;border-radius:10px}.code{text-align:center;font-family:ui-monospace,monospace;letter-spacing:.08em}</style>`;

function buyForm(clubId: string, club: { name: string; address: string | null }, s: { maxStartDays: number; note: string | null }, products: Awaited<ReturnType<typeof buyProducts>>,
  docs: { kind: string; title: string }[], today: string, v: OrderIn, err: string | null) {
  const sel = v.productId ?? products[0]?.id;
  const doc = (k: string) => docs.find((d) => d.kind === k);
  const link = (k: string, t: string) => (doc(k) ? `<a href="/buy/${clubId}/doc/${k}" target="_blank" rel="noopener">${esc(t)}</a>` : esc(t));
  return page(`Купить абонемент — ${club.name}`, `${CSS}<form class="c" method="post" action="/buy/${clubId}">
    <div><div class="m">${esc(club.name)}${club.address ? ` · ${esc(club.address)}` : ''}</div><h1>Купить абонемент онлайн</h1></div>
    ${s.note ? `<div class="m">${esc(s.note)}</div>` : ''}
    ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
    <div class="prod" role="radiogroup" aria-label="Тариф">${products.map((p) => `<label><input type="radio" name="productId" value="${p.id}"${p.id === sel ? ' checked' : ''}>
      <span><b>${esc(p.name)}</b><span class="m">${esc(productLine(p))}</span></span><b>${rub(p.priceKop)}</b></label>`).join('')}</div>
    <label class="f">Имя и фамилия<input name="name" required maxlength="100" autocomplete="name" value="${esc(v.name ?? '')}"></label>
    <label class="f">Телефон<input name="phone" required inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" value="${esc(v.phone ?? '')}"></label>
    <label class="f">E-mail для чека (необязательно)<input name="email" type="email" autocomplete="email" value="${esc(v.email ?? '')}"></label>
    <label class="f">Начать с<input name="startsOn" type="date" min="${today}" max="${addDays(today, s.maxStartDays)}" value="${esc(v.startsOn ?? today)}"></label>
    ${products.some((p) => p.kind === 'subscription') ? `<label class="chk"><input type="checkbox" name="autopay" value="1"${v.autopay ? ' checked' : ''}><span>Для подписки: согласен(на), чтобы клуб списывал оплату с этой карты каждый месяц. Отключить можно в любой момент на ресепшне</span></label>` : ''}
    <label class="chk"><input type="checkbox" name="offer" value="1" required${v.offer ? ' checked' : ''}><span>Я прочитал(а) и принимаю ${link('contract', 'договор-оферту')}${doc('rules') ? ` и ${link('rules', 'правила клуба')}` : ''}. Оплата означает заключение договора</span></label>
    <label class="chk"><input type="checkbox" name="consent" value="1" required${v.consent ? ' checked' : ''}><span>Согласен(на) на обработку персональных данных для заключения и исполнения договора</span></label>
    <button class="p">Перейти к оплате</button>
    <div class="m">После оплаты на этой странице появится QR-код для прохода в клуб, а менеджер позвонит, чтобы записать вас на вводное занятие.</div>
  </form>`);
}

function qrSvg(text: string) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

export function onlineBuyRoutes(app: FastifyInstance, pool: pg.Pool, storage: string, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;
  const hits = new Map<string, number[]>();
  const limited = (ip: string) => {
    const now = Date.now(); const h = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    h.push(now); hits.set(ip, h); return h.length > 10;
  };
  const tenantOfClub = async (clubId: string) => (UUID.test(clubId) ? (await pool.query('select tenant_id from acquiring_club_tenant($1)', [clubId])).rows[0]?.tenant_id as string | undefined : undefined);
  const closed = (msg = 'Онлайн-покупка в этом клубе сейчас не работает. Купить абонемент можно на ресепшне клуба.') => page('Покупка недоступна', `<div class="c"><h1>Покупка недоступна</h1><p class="m">${esc(msg)}</p></div>`);

  const loadBuy = async (clubId: string) => {
    const t = await tenantOfClub(clubId);
    if (!t) return null;
    return withCtx(pool, sys(t), async (db) => {
      const club = (await db.query(`select name, address from clubs where id = $1 and status = 'active'`, [clubId])).rows[0];
      if (!club) return null;
      const s = await buySettings(db, clubId);
      const docs = await currentDocs(db, clubId);
      const products = await buyProducts(db, clubId);
      return { t, club, s, docs, products, today: await clubToday(db, clubId), open: s.enabled && products.length > 0 && docs.some((d) => d.kind === 'contract') };
    });
  };

  app.get('/buy/:clubId', async (req, reply) => {
    const { clubId } = req.params as { clubId: string };
    const { p } = req.query as { p?: string };
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    const d = await loadBuy(clubId);
    if (!d) return reply.code(404).send(closed('Клуб не найден. Проверьте ссылку.'));
    if (!d.open) return closed();
    return buyForm(clubId, d.club, d.s, d.products, d.docs, d.today, { productId: p }, null);
  });

  // Форма отправляется обычным POST (без скриптов на странице — их запрещают настройки безопасности)
  app.post('/buy/:clubId', async (req, reply) => {
    const { clubId } = req.params as { clubId: string };
    const b = (req.body ?? {}) as OrderIn;
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    const d = await loadBuy(clubId);
    if (!d) return reply.code(404).send(closed('Клуб не найден. Проверьте ссылку.'));
    if (!d.open) return closed();
    if (limited(req.ip)) return reply.code(429).send(buyForm(clubId, d.club, d.s, d.products, d.docs, d.today, b, 'Слишком много попыток. Попробуйте через час или купите на ресепшне'));
    try {
      const r = await withCtx(pool, sys(d.t), (db) => placeOrder(db, f, { tenantId: d.t, userId: null, ip: req.ip }, clubId, b,
        { ip: req.ip, ua: String(req.headers['user-agent'] ?? ''), base: publicBase(req) }));
      return reply.redirect(r.payUrl.replace(publicBase(req), ''), 303);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return reply.code(400).send(buyForm(clubId, d.club, d.s, d.products, d.docs, d.today, b, e.message));
      throw e;
    }
  });

  app.get('/buy/:clubId/doc/:kind', async (req, reply) => {
    const { clubId, kind } = req.params as { clubId: string; kind: string };
    const t = await tenantOfClub(clubId);
    if (!t || !['contract', 'rules'].includes(kind)) throw notFound('Документ не найден');
    const doc = await withCtx(pool, sys(t), async (db) => (await currentDocs(db, clubId)).find((x) => x.kind === kind));
    if (!doc || !existsSync(join(storage, doc.storage_path))) throw notFound('Документ не найден');
    reply.header('Content-Type', doc.mime).header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${doc.title}.pdf`)}`).header('Cache-Control', 'no-store');
    return reply.send(readFileSync(join(storage, doc.storage_path)));
  });

  app.get('/buy/order/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    const t = UUID.test(id) ? (await pool.query('select tenant_id from online_order_tenant($1)', [id])).rows[0]?.tenant_id as string | undefined : undefined;
    if (!t) return reply.code(404).send(page('Заказ не найден', '<div class="c"><h1>Заказ не найден</h1><p class="m">Проверьте ссылку.</p></div>'));
    const actor = { tenantId: t, userId: null };
    const o = await withCtx(pool, sys(t), async (db) => {
      const x = (await db.query('select online_payment_id from online_orders where id = $1', [id])).rows[0];
      await checkOp(db, f, x.online_payment_id, actor).catch(() => null);
      await finalizeOrder(db, actor, id);
      return (await db.query(`select o.id, o.status, o.club_id, o.amount_kop, o.paid_at, o.online_payment_id, c.name as club, c.address, p.name as product, pe.full_name as person,
          to_char(m.starts_on, 'YYYY-MM-DD') as starts, to_char(m.ends_on, 'YYYY-MM-DD') as ends, ct.number as contract, ac.code as qr, ac.status as qr_status
        from online_orders o join clubs c on c.id = o.club_id join products p on p.id = o.product_id join persons pe on pe.id = o.person_id
        left join memberships m on m.id = o.membership_id left join contracts ct on ct.membership_id = o.membership_id left join access_credentials ac on ac.id = o.credential_id
        where o.id = $1`, [id])).rows[0];
    });
    const head = `<div class="m">${esc(o.club)}${o.address ? ` · ${esc(o.address)}` : ''}</div><h1>${esc(o.product)}</h1><div class="sum">${rub(Number(o.amount_kop))}</div>`;
    if (o.status === 'awaiting_payment') {
      return page('Ожидаем оплату', `${CSS}<div class="c">${head}<p>Оплата ещё не поступила.</p><a href="/pay/${o.online_payment_id}"><button class="p" type="button">Перейти к оплате</button></a>
        <p class="m">Если вы уже оплатили, обновите страницу через минуту.</p></div>`);
    }
    if (o.status === 'expired') {
      return page('Оплата не прошла', `${CSS}<div class="c">${head}<h1 class="bad">Оплата не прошла</h1><p class="m">Деньги не списаны. Можно попробовать ещё раз.</p>
        <a href="/buy/${o.club_id}"><button class="p" type="button">Купить заново</button></a></div>`);
    }
    // Оплачено: QR показываем только первые 30 дней после покупки, дальше — в клубе или в приложении
    const fresh = o.paid_at && Date.now() - new Date(o.paid_at).getTime() < 30 * 86400_000 && o.qr && o.qr_status === 'active';
    return page('Абонемент оплачен', `${CSS}<div class="c">${head}<h1 class="ok">Оплата прошла, абонемент оформлен</h1>
      <div>${esc(o.person)}${o.starts ? ` · с ${ru(o.starts)}${o.ends ? ` по ${ru(o.ends)}` : ''}` : ''}</div>
      ${o.contract ? `<div class="m">Договор № ${esc(o.contract)} заключён. Чек придёт на телефон или почту.</div>` : ''}
      ${fresh ? `<div class="m">Ваш QR-код для прохода. Сохраните скриншот этой страницы и покажите код на турникете или на ресепшне.</div>${qrSvg(o.qr).replace('<svg ', '<svg class="qr" role="img" aria-label="QR-код для прохода" ')}<div class="code">${esc(o.qr)}</div>` : '<div class="m">QR-код для прохода выдадут на ресепшне клуба.</div>'}
      <div class="m">Менеджер клуба позвонит, чтобы поздравить и записать вас на вводное занятие.</div></div>`);
  });

  /* ---------- настройки и заказы для сотрудников ---------- */
  app.get('/api/online-buy', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const s = await buySettings(db, clubId);
      const products = (await db.query(`select p.id, p.name, p.kind, p.sell_online as "sellOnline",
          (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by v.valid_from desc limit 1)::bigint as "priceKop"
        from products p where p.club_id = $1 and p.is_active order by p.sort, p.name`, [clubId])).rows.map((p) => ({ ...p, priceKop: p.priceKop === null ? null : Number(p.priceKop) }));
      const docs = (await currentDocs(db, clubId)).map((d) => ({ kind: d.kind, title: d.title, version: d.version }));
      const orders = (await db.query(`select o.id, o.status, o.amount_kop::bigint as "amountKop", o.created_at as "createdAt", o.paid_at as "paidAt", o.person_id as "personId", pe.full_name as person,
          p.name as product, op.status as "payStatus", op.conflict, o.task_id as "taskId"
        from online_orders o join persons pe on pe.id = o.person_id join products p on p.id = o.product_id join online_payments op on op.id = o.online_payment_id
        where o.club_id = $1 order by o.created_at desc limit 50`, [clubId])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop) }));
      const st = (await db.query(`select count(*) filter (where status = 'paid')::int as paid, coalesce(sum(amount_kop) filter (where status = 'paid'), 0)::bigint as sum,
          count(*)::int as started from online_orders where club_id = $1 and created_at > now() - interval '30 days'`, [clubId])).rows[0];
      return { settings: s, products, docs, orders, link: `${publicBase(req)}/buy/${clubId}`,
        stats: { started: st.started, paid: st.paid, sum: Number(st.sum), conversion: st.started ? Math.round(st.paid * 100 / st.started) : null },
        canManage: can(ctx, P.tariffsManage) || can(ctx, P.siteManage) };
    });
  });

  app.put('/api/online-buy/settings', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    if (!can(ctx, P.tariffsManage) && !can(ctx, P.siteManage)) throw forbidden();
    const b = (req.body ?? {}) as { clubId?: string; enabled?: boolean; maxStartDays?: number; note?: string | null; productIds?: string[] };
    if (!b.clubId || b.clubId === 'all') throw badRequest('Выберите клуб');
    const days = b.maxStartDays ?? 30;
    if (!(Number.isInteger(days) && days >= 0 && days <= 90)) throw badRequest('Начало абонемента: не дальше 90 дней');
    const note = b.note?.trim() ? b.note.trim().slice(0, 500) : null;
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      const ids = Array.isArray(b.productIds) ? b.productIds.filter((x) => UUID.test(x)) : null;
      if (b.enabled && !(await currentDocs(db, b.clubId!)).some((d) => d.kind === 'contract'))
        throw badRequest('Сначала загрузите договор-оферту клуба (раздел «Договоры»): без него клиент не может принять условия онлайн');
      if (ids) {
        if (b.enabled && !ids.length) throw badRequest('Отметьте хотя бы один тариф для продажи онлайн');
        await db.query('update products set sell_online = (id = any($2::uuid[])) where club_id = $1', [b.clubId, ids]);
      }
      const before = await buySettings(db, b.clubId!);
      await db.query(`insert into club_online_buy(club_id, tenant_id, enabled, max_start_days, note, updated_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (club_id) do update set enabled = $3, max_start_days = $4, note = $5, updated_by = $6, updated_at = now()`, [b.clubId, ctx.tenantId, !!b.enabled, days, note, ctx.userId]);
      await audit(db, ctx, 'online_buy.settings', 'club', b.clubId!, before, { enabled: !!b.enabled, maxStartDays: days, note, productIds: ids });
      return { ok: true };
    });
  });
}

