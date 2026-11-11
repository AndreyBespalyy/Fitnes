// Быстрый режим ресепшна (список «20 новых возможностей», п. 15).
// Один экран под планшет и поток людей: поиск по телефону, карте или имени, фото для сверки,
// крупные действия «Пропустить», «Разовый визит», «Продлить», «Товар», «Погасить долг» в 2–3 касания.
// Каждая операция пишет замер (время и число нажатий), чтобы на пилоте видеть, где ресепшн теряет время.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { decidePerson, recordEvent } from './acs.ts';
import { maskPhone } from './crm.ts';
import { depositBalance } from './gifts.ts';
import { loyaltyBalance, loyaltySettings } from './loyalty.ts';
import { clubToday, loadMembership, payCharge, personMemberships, sellMembership } from './memberships.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAY = ['cash', 'card_terminal', 'sbp'];
const OPS = ['pass', 'single', 'renew', 'goods', 'pay_debt', 'new_client', 'manual_pass'];
const PHOTO_MAX = 400 * 1024;

/** Найти клиента: 4+ цифры — телефон, код карты или QR — карта, иначе имя. */
export async function deskFind(db: Db, clubId: string, q: string) {
  const text = q.trim();
  const digits = text.replace(/\D/g, '');
  if (text.length < 2) return [];
  const byCard = (await db.query(`select person_id from access_credentials where upper(code) = upper($1) and person_id is not null`, [text])).rows.map((r) => r.person_id as string);
  const rows = (await db.query(`select p.id, p.full_name as name, p.home_club_id = $1 as "homeClub",
      (select value from person_contacts pc where pc.person_id = p.id and pc.is_primary limit 1) as phone,
      exists (select 1 from person_photos f where f.person_id = p.id) as "hasPhoto",
      (select max(v.visited_at) from visits v where v.person_id = p.id) as "lastVisit"
    from persons p
    where p.merged_into_id is null and (p.id = any($2::uuid[])
      or ($3 <> '' and exists (select 1 from person_contacts pc where pc.person_id = p.id and pc.normalized_value like '%' || $3 || '%'))
      or ($4 <> '' and p.full_name ilike '%' || $4 || '%'))
    order by (p.id = any($2::uuid[])) desc, (p.home_club_id = $1) desc, "lastVisit" desc nulls last, p.full_name limit 8`,
  [clubId, byCard, digits.length >= 4 ? digits : '', digits.length >= 4 || byCard.length ? '' : text])).rows;
  return rows.map((r) => ({ ...r, phone: maskPhone(r.phone), byCard: byCard.includes(r.id) }));
}

/** Всё, что нужно ресепшну по клиенту на одном экране. */
export async function deskCard(db: Db, clubId: string, personId: string) {
  const p = (await db.query(`select id, full_name as name, to_char(birth_date, 'MM-DD') as bd,
      (select value from person_contacts pc where pc.person_id = persons.id and pc.is_primary limit 1) as phone,
      exists (select 1 from person_photos f where f.person_id = persons.id) as "hasPhoto"
    from persons where id = $1 and merged_into_id is null`, [personId])).rows[0];
  if (!p) throw notFound('Клиент не найден');
  const today = await clubToday(db, clubId);
  const verdict = await decidePerson(db, clubId, personId, new Date());
  const ms = (await personMemberships(db, personId)).filter((m) => m.clubId === clubId || m.networkAccess);
  const visible = ms.filter((m) => m.status !== 'cancelled' && (m.access || !m.endsOn || m.endsOn >= addDaysIso(today, -60) || (m.visitsLeft ?? 0) > 0)).slice(0, 4);
  const debts = ms.flatMap((m) => m.charges.filter((c) => c.status === 'due' && !c.company && c.dueOn <= addDaysIso(today, 3)).map((c) => ({ ...c, membershipId: m.id, productName: m.productName })));
  // Что продлевать: последний абонемент на срок или пакет посещений (персональные продлевает менеджер с тренером)
  const renewable = ms.find((m) => m.status !== 'cancelled' && (m.kind === 'term' || m.kind === 'visits' || m.kind === 'subscription')) ?? null;
  const renewProduct = renewable ? (await db.query(`select p.id, p.name, p.is_active, (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by valid_from desc limit 1) as price
    from memberships m join products p on p.id = m.product_id where m.id = $1`, [renewable.id])).rows[0] : null;
  const single = (await db.query(`select p.id, p.name, (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by valid_from desc limit 1) as price
    from products p where p.club_id = $1 and p.kind = 'guest' and p.is_active order by p.sort, p.name limit 1`, [clubId])).rows[0] ?? null;
  const bookings = (await db.query(`select b.id, t.name as "typeName", to_char(s.starts_at at time zone c.timezone, 'HH24:MI') as at, b.status
    from class_bookings b join class_sessions s on s.id = b.session_id join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id
    where b.person_id = $1 and s.club_id = $2 and (s.starts_at at time zone c.timezone)::date = $3::date and b.status in ('booked', 'attended') order by s.starts_at`,
  [personId, clubId, today])).rows;
  const lastVisit = (await db.query('select visited_at as at, exit_at is null and visited_at > now() - interval \'16 hours\' as inside from visits where person_id = $1 and club_id = $2 order by visited_at desc limit 1', [personId, clubId])).rows[0] ?? null;
  return {
    id: p.id, name: p.name, phone: maskPhone(p.phone), hasPhoto: p.hasPhoto, birthday: p.bd === today.slice(5),
    verdict: { allow: verdict.decision === 'allow', reason: verdict.reason, warn: verdict.warn ?? null, reasonCode: verdict.reasonCode },
    memberships: visible.map((m) => ({ id: m.id, productName: m.productName, kind: m.kind, endsOn: m.endsOn, visitsLeft: m.visitsLeft, state: m.state, access: m.access, reason: m.reason })),
    debts: debts.map((d) => ({ id: d.id, title: d.title, amountKop: d.amountKop, dueOn: d.dueOn, overdue: d.overdue, productName: d.productName })),
    renew: renewable && renewProduct?.is_active && renewProduct.price != null ? { membershipId: renewable.id, productName: renewProduct.name, priceKop: Number(renewProduct.price) } : null,
    single: single && single.price != null ? { productId: single.id, name: single.name, priceKop: Number(single.price) } : null,
    depositKop: await depositBalance(db, personId, clubId),
    points: await (async () => { const ls = await loyaltySettings(db, clubId); return ls.enabled ? { balance: await loyaltyBalance(db, personId, clubId), valueKop: ls.pointValueKop, goods: ls.spendGoods } : null; })(),
    bookings, lastVisit, inside: !!lastVisit?.inside,
  };
}
const addDaysIso = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Пропустить: только если система разрешает. Иначе — причина, а решение «пустить вопреки» идёт ручным проходом с причиной. */
async function pass(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, clubId: string, personId: string, pointId: string | null) {
  const d = await decidePerson(db, clubId, personId, new Date());
  if (d.decision !== 'allow') return { ok: false, reason: d.reason, reasonCode: d.reasonCode };
  const pt = pointId ? (await db.query('select id, gateway_id from access_points where id = $1 and club_id = $2', [pointId, clubId])).rows[0] : null;
  const r = await recordEvent(db, ctx.tenantId, { clubId, pointId: pt?.id ?? null, at: new Date(), direction: 'in', mode: 'desk', manualBy: ctx.userId }, d);
  if (pt?.gateway_id) await db.query(`insert into access_commands(tenant_id, club_id, gateway_id, point_id, kind, event_id, created_by) values ($1,$2,$3,$4,'open',$5,$6)`,
    [ctx.tenantId, clubId, pt.gateway_id, pt.id, r.id, ctx.userId]);
  return { ok: true, reason: d.reason, warn: d.warn ?? null, effect: r.effect, eventId: r.id };
}

export function frontDeskRoutes(app: FastifyInstance, pool: pg.Pool) {
  const clubCheck = async (db: Db, clubId?: string) => {
    if (!clubId || !UUID.test(clubId) || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
    return clubId;
  };
  const method = (m?: string) => { if (!PAY.includes(m ?? '')) throw badRequest('Выберите способ оплаты'); return m!; };

  app.get('/api/desk/find', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const q = req.query as { clubId?: string; q?: string };
    return withCtx(pool, ctx, async (db) => deskFind(db, await clubCheck(db, q.clubId), q.q ?? ''));
  });

  app.get('/api/desk/person/:id', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const { id } = req.params as { id: string };
    const q = req.query as { clubId?: string };
    if (!UUID.test(id)) throw notFound('Клиент не найден');
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, q.clubId);
      return { ...(await deskCard(db, clubId, id)), canSell: can(ctx, P.membershipsSell), canTakeMoney: can(ctx, P.membershipsManage) };
    });
  });

  app.post('/api/desk/pass', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const b = (req.body ?? {}) as { clubId?: string; personId?: string; pointId?: string };
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      if (!b.personId || !UUID.test(b.personId)) throw badRequest('Выберите клиента');
      return pass(db, ctx, clubId, b.personId, b.pointId && UUID.test(b.pointId) ? b.pointId : null);
    });
  });

  // Разовый визит: продажа гостевого, оплата и проход одним нажатием
  app.post('/api/desk/single', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsSell);
    requirePerm(req, P.membershipsManage);
    const b = (req.body ?? {}) as { clubId?: string; personId?: string; method?: string; pointId?: string };
    const m = method(b.method);
    const res = await withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      if (!b.personId || !UUID.test(b.personId)) throw badRequest('Выберите клиента');
      const prod = (await db.query(`select id from products where club_id = $1 and kind = 'guest' and is_active order by sort, name limit 1`, [clubId])).rows[0];
      if (!prod) throw badRequest('В клубе нет тарифа «разовый визит»: добавьте гостевой тариф в прейскурант', 'no_single');
      const sale = await sellMembership(db, ctx, { personId: b.personId, productId: prod.id, confirmDuplicate: true });
      const receiptId = await payAll(db, ctx, sale.id, m);
      const p = await pass(db, ctx, clubId, b.personId, b.pointId && UUID.test(b.pointId) ? b.pointId : null);
      await audit(db, ctx, 'desk.single', 'membership', sale.id, null, { method: m, passed: p.ok });
      return { membershipId: sale.id, receiptId, pass: p };
    });
    reply.code(201);
    return res;
  });

  // Продлить тем же тарифом: продажа с даты окончания текущего и оплата
  app.post('/api/desk/renew', async (req, reply) => {
    const ctx = requirePerm(req, P.membershipsSell);
    requirePerm(req, P.membershipsManage);
    const b = (req.body ?? {}) as { membershipId?: string; method?: string; clubId?: string; pass?: boolean; pointId?: string };
    const m = method(b.method);
    const res = await withCtx(pool, ctx, async (db) => {
      if (!b.membershipId || !UUID.test(b.membershipId)) throw badRequest('Выберите абонемент');
      const cur = await loadMembership(db, b.membershipId);
      const sale = await sellMembership(db, ctx, { personId: cur.person_id, productId: cur.product_id, renewFromId: cur.id });
      const receiptId = await payAll(db, ctx, sale.id, m);
      const p = b.pass ? await pass(db, ctx, cur.club_id, cur.person_id, b.pointId && UUID.test(b.pointId) ? b.pointId : null) : null;
      await audit(db, ctx, 'desk.renew', 'membership', sale.id, null, { from: cur.id, method: m });
      return { membershipId: sale.id, startsOn: sale.startsOn, endsOn: sale.endsOn, receiptId, pass: p };
    });
    reply.code(201);
    return res;
  });

  // Погасить долг: все платежи клиента к оплате в этом клубе одним нажатием
  app.post('/api/desk/pay-debts', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const b = (req.body ?? {}) as { clubId?: string; personId?: string; method?: string };
    const m = method(b.method);
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      const card = await deskCard(db, clubId, b.personId ?? '');
      if (!card.debts.length) throw badRequest('Платежей к оплате нет');
      const receipts = [];
      for (const d of card.debts) receipts.push(await payCharge(db, ctx, d.id, m));
      return { paid: card.debts.length, totalKop: card.debts.reduce((s, d) => s + d.amountKop, 0), receipts };
    });
  });

  app.get('/api/persons/:id/photo', async (req, reply) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw notFound('Фото нет');
    const r = await withCtx(pool, ctx, async (db) => (await db.query('select image, mime from person_photos where person_id = $1', [id])).rows[0]);
    if (!r) throw notFound('Фото нет');
    reply.header('content-type', r.mime).header('cache-control', 'private, max-age=60');
    return reply.send(r.image);
  });

  // Фото с камеры планшета: приходит как data URL, храним у себя
  app.put('/api/persons/:id/photo', { bodyLimit: 700 * 1024 }, async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const { id } = req.params as { id: string };
    const { image } = (req.body ?? {}) as { image?: string };
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image ?? '');
    if (!m) throw badRequest('Нужна фотография в формате JPEG, PNG или WebP');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > PHOTO_MAX) throw badRequest('Фото слишком большое: не больше 400 КБ');
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from persons where id = $1', [id])).rowCount) throw notFound('Клиент не найден');
      await db.query(`insert into person_photos(person_id, tenant_id, image, mime, updated_by) values ($1,$2,$3,$4,$5)
        on conflict (person_id) do update set image = excluded.image, mime = excluded.mime, updated_at = now(), updated_by = excluded.updated_by`, [id, ctx.tenantId, buf, m[1], ctx.userId]);
      await audit(db, ctx, 'person.photo_set', 'person', id, null, { bytes: buf.length });
      return { ok: true };
    });
  });

  // Замер: время от выбора клиента до результата и число нажатий
  app.post('/api/desk/ops', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const b = (req.body ?? {}) as { clubId?: string; op?: string; ms?: number; taps?: number };
    if (!OPS.includes(b.op ?? '')) throw badRequest('Неизвестная операция');
    const ms = Math.min(Math.max(Math.round(Number(b.ms) || 0), 0), 30 * 60_000);
    const taps = Math.min(Math.max(Math.round(Number(b.taps) || 0), 0), 200);
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, b.clubId);
      await db.query('insert into desk_ops(tenant_id, club_id, user_id, op, ms, taps) values ($1,$2,$3,$4,$5,$6)', [ctx.tenantId, clubId, ctx.userId, b.op, ms, taps]);
      return { ok: true };
    });
  });

  app.get('/api/desk/stats', async (req) => {
    const ctx = requirePerm(req, P.acsWork);
    const q = req.query as { clubId?: string; days?: string };
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
    return withCtx(pool, ctx, async (db) => {
      const clubId = await clubCheck(db, q.clubId);
      const ops = (await db.query(`select op, count(*)::int as n, (percentile_cont(0.5) within group (order by ms))::int as "medianMs",
          round(avg(taps)::numeric, 1)::float as "avgTaps", max(taps)::int as "maxTaps"
        from desk_ops where club_id = $1 and created_at > now() - make_interval(days => $2) group by op order by n desc`, [clubId, days])).rows;
      return { days, ops };
    });
  });
}

/** Оплатить все платежи новой продажи (без рассрочки это один платёж). Возвращает чек первого. */
async function payAll(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, membershipId: string, m: string) {
  const due = (await db.query(`select id from charges where membership_id = $1 and status = 'due' order by due_on limit 1`, [membershipId])).rows;
  let receiptId = null;
  for (const c of due) receiptId = (await payCharge(db, ctx, c.id, m)) ?? receiptId;
  return receiptId;
}
