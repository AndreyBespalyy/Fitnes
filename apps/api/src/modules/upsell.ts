// Подсказки для допродаж (список «20 новых возможностей», п. 9).
// По данным клиента система видит повод и подсказывает, что предложить: новичку — вводную персональную тренировку,
// при заканчивающемся пакете — новый пакет, частому гостю — абонемент, тому, кто ходит только днём, — дневной тариф вместо ухода,
// постоянному клиенту с коротким абонементом — более длинный и выгодный. Цены — только из действующего прейскуранта клуба.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { withCtx, type Db } from '../db.ts';
import { badRequest } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { clubToday } from './memberships.ts';

export type Hint = { key: string; title: string; text: string; productId: string | null; priceKop: number | null; who: 'manager' | 'trainer' };
type Product = { id: string; name: string; kind: string; price: number; duration_days: number | null; visits_count: number | null; access_to: string | null };
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const plural = (n: number, one: string, few: string, many: string) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

async function products(db: Db, clubId: string): Promise<Product[]> {
  return (await db.query(`select p.id, p.name, p.kind, p.duration_days, p.visits_count, p.access_to::text as access_to,
      (select amount_kop from price_versions v where v.product_id = p.id and v.valid_from <= now() order by v.valid_from desc limit 1)::bigint as price
    from products p where p.club_id = $1 and p.is_active`, [clubId])).rows.filter((p) => p.price != null).map((p) => ({ ...p, price: Number(p.price) }));
}

/** Подсказки для нескольких клиентов сразу (карточка, «Кому звонить», список допродаж) */
export async function hintsFor(db: Db, clubId: string, personIds: string[]): Promise<Map<string, Hint[]>> {
  const out = new Map<string, Hint[]>(personIds.map((id) => [id, []]));
  if (!personIds.length) return out;
  const today = await clubToday(db, clubId);
  const prods = await products(db, clubId);
  const ms = (await db.query(`select m.person_id, m.kind, m.product_id, m.product_name, m.status, m.starts_on::text as starts_on, m.ends_on::text as ends_on, m.visits_left, m.amount_kop::bigint as amount
    from memberships m where m.club_id = $1 and m.person_id = any($2) and m.status <> 'cancelled'`, [clubId, personIds])).rows;
  const vis = (await db.query(`select v.person_id, count(*) filter (where v.visited_at > now() - interval '30 days')::int as v30, count(*)::int as v60,
      count(*) filter (where extract(hour from v.visited_at at time zone c.timezone) < 17)::int as day60
    from visits v join clubs c on c.id = v.club_id where v.club_id = $1 and v.person_id = any($2) and v.visited_at > now() - interval '60 days' group by v.person_id`, [clubId, personIds])).rows;
  const vmap = new Map(vis.map((v) => [v.person_id as string, v]));
  const cheapest = (kind: string) => prods.filter((p) => p.kind === kind).sort((a, b) => a.price - b.price)[0];

  for (const pid of personIds) {
    const mine = ms.filter((m) => m.person_id === pid);
    const active = mine.filter((m) => m.status === 'active' && (!m.ends_on || m.ends_on >= today));
    const v = vmap.get(pid) ?? { v30: 0, v60: 0, day60: 0 };
    const hints: Hint[] = [];
    const nonGuest = mine.filter((m) => m.kind !== 'guest').sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    const firstStart = nonGuest[0]?.starts_on;
    const daysSinceFirst = firstStart ? Math.round((Date.parse(today) - Date.parse(firstStart)) / 86400_000) : null;
    const pt = cheapest('personal');

    // 1. Новичок без персональных — вводная персональная тренировка
    if (pt && daysSinceFirst !== null && daysSinceFirst <= 30 && !mine.some((m) => m.kind === 'personal'))
      hints.push({ key: 'intro_pt', title: 'Вводная персональная тренировка', who: 'trainer', productId: pt.id, priceKop: pt.price,
        text: `Клиент в клубе ${daysSinceFirst + 1} ${plural(daysSinceFirst + 1, 'день', 'дня', 'дней')}, с тренером ещё не занимался. Предложите вводную тренировку: тренер составит программу, а дальше — пакет «${pt.name}» за ${rub(pt.price)}` });

    // 2. Пакет персональных заканчивается
    const ptLeft = active.find((m) => m.kind === 'personal' && m.visits_left !== null && m.visits_left <= 2);
    if (ptLeft) {
      const p = prods.find((x) => x.id === ptLeft.product_id) ?? pt;
      if (p) hints.push({ key: 'pt_renew', title: 'Новый пакет персональных', who: 'trainer', productId: p.id, priceKop: p.price,
        text: `В пакете «${ptLeft.product_name}» ${ptLeft.visits_left ? `осталось ${ptLeft.visits_left} ${plural(ptLeft.visits_left, 'занятие', 'занятия', 'занятий')}` : 'занятия закончились'}. Предложите продолжить: «${p.name}» за ${rub(p.price)}` });
    }

    // 3. Пакет посещений заканчивается — новый пакет или безлимит, если ходит часто
    const visLeft = active.find((m) => m.kind === 'visits' && m.visits_left !== null && m.visits_left <= 2);
    if (visLeft) {
      const month = prods.filter((p) => p.kind === 'term' && (p.duration_days ?? 0) >= 28 && (p.duration_days ?? 0) <= 31).sort((a, b) => a.price - b.price)[0]
        ?? prods.filter((p) => p.kind === 'subscription' && !p.access_to).sort((a, b) => a.price - b.price)[0];
      const same = prods.find((x) => x.id === visLeft.product_id);
      const perVisit = same?.visits_count ? same.price / same.visits_count : null;
      if (month && perVisit && v.v30 * perVisit > month.price)
        hints.push({ key: 'visits_to_unlimited', title: 'Безлимит вместо пакета', who: 'manager', productId: month.id, priceKop: month.price,
          text: `Пакет посещений заканчивается, а клиент ходит ${v.v30} ${plural(v.v30, 'раз', 'раза', 'раз')} в месяц: по пакету это ${rub(Math.round(v.v30 * perVisit))}. «${month.name}» за ${rub(month.price)} выгоднее` });
      else if (same) hints.push({ key: 'visits_renew', title: 'Новый пакет посещений', who: 'manager', productId: same.id, priceKop: same.price,
        text: `В пакете «${visLeft.product_name}» осталось ${visLeft.visits_left}. Предложите новый пакет «${same.name}» за ${rub(same.price)}` });
    }

    // 4. Часто приходит разово — абонемент выгоднее
    const guests = mine.filter((m) => m.kind === 'guest' && m.starts_on > addDaysIso(today, -60));
    if (guests.length >= 2 && !active.some((m) => m.kind !== 'guest')) {
      const g = cheapest('guest');
      const offer = prods.filter((p) => (p.kind === 'term' && (p.duration_days ?? 0) <= 31) || (p.kind === 'subscription' && !p.access_to) || p.kind === 'visits').sort((a, b) => a.price - b.price)[0];
      if (offer && g) {
        const pays = Math.ceil(offer.price / g.price);
        hints.push({ key: 'guest_to_member', title: 'Абонемент вместо разовых визитов', who: 'manager', productId: offer.id, priceKop: offer.price,
          text: `Приходил разово ${guests.length} ${plural(guests.length, 'раз', 'раза', 'раз')} за 2 месяца и заплатил ${rub(guests.reduce((a, m) => a + Number(m.amount), 0))}. «${offer.name}» за ${rub(offer.price)} окупается с ${pays}-го визита` });
      }
    }

    // 5. Ходит только днём — дневной тариф вместо ухода
    const main = active.find((m) => m.kind === 'term' || m.kind === 'subscription');
    if (main && v.v60 >= 5 && v.day60 / v.v60 >= 0.8) {
      const cur = prods.find((x) => x.id === main.product_id);
      const day = prods.filter((p) => p.access_to && p.access_to.slice(0, 5) <= '18:00' && p.kind === main.kind && p.id !== main.product_id && (!cur || p.price < cur.price)).sort((a, b) => a.price - b.price)[0];
      if (day) hints.push({ key: 'daytime', title: 'Дневной тариф вместо ухода', who: 'manager', productId: day.id, priceKop: day.price,
        text: `${Math.round(v.day60 * 100 / v.v60)} % визитов — до 17:00. Если клиент говорит, что дорого, или собирается уйти, предложите «${day.name}» за ${rub(day.price)}${cur ? ` (дешевле на ${rub(cur.price - day.price)})` : ''}` });
    }

    // 6. Постоянный клиент с коротким абонементом — длинный выгоднее
    if (main && main.kind === 'term' && main.ends_on && main.ends_on <= addDaysIso(today, 30) && v.v30 >= 6) {
      const cur = prods.find((x) => x.id === main.product_id);
      if (cur?.duration_days && cur.duration_days <= 62) {
        const perMonth = (p: Product) => p.price / Math.max(1, Math.round((p.duration_days ?? 30) / 30.4));
        const longer = prods.filter((p) => p.kind === 'term' && !p.access_to && (p.duration_days ?? 0) >= 150 && perMonth(p) < perMonth(cur) * 0.95).sort((a, b) => perMonth(a) - perMonth(b))[0];
        if (longer) hints.push({ key: 'longer_term', title: 'Продлить на дольше', who: 'manager', productId: longer.id, priceKop: longer.price,
          text: `Ходит регулярно (${v.v30} ${plural(v.v30, 'раз', 'раза', 'раз')} за месяц), абонемент заканчивается ${main.ends_on.split('-').reverse().join('.')}. «${longer.name}» выйдет ${rub(Math.round(perMonth(longer)))} в месяц вместо ${rub(Math.round(perMonth(cur)))}` });
      }
    }
    out.set(pid, hints);
  }
  return out;
}
const addDaysIso = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

/* ---------- маршруты ---------- */
export function upsellRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/persons/:id/upsell', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    const { clubId } = req.query as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => (await hintsFor(db, clubId, [id])).get(id) ?? []);
  });

  app.post('/api/upsell/batch', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const b = (req.body ?? {}) as { clubId?: string; personIds?: string[] };
    if (!b.clubId || !Array.isArray(b.personIds)) throw badRequest('Выберите клуб и клиентов');
    const ids = [...new Set(b.personIds)].slice(0, 200);
    return withCtx(pool, ctx, async (db) => Object.fromEntries(await hintsFor(db, b.clubId!, ids)));
  });

  // Все клиенты клуба с поводом для допродажи: действующие и те, кто приходил разово за 2 месяца
  app.get('/api/upsell', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { clubId, who } = req.query as { clubId?: string; who?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const cands = (await db.query(`select distinct m.person_id from memberships m where m.club_id = $1 and m.status = 'active'
          and (m.kind <> 'guest' or m.starts_on > current_date - 60) limit 2000`, [clubId])).rows.map((r) => r.person_id as string);
      const names = new Map((await db.query('select id, full_name from persons where id = any($1)', [cands])).rows.map((r) => [r.id as string, r.full_name as string]));
      const rows: { personId: string; name: string; hints: Hint[] }[] = [];
      for (let i = 0; i < cands.length; i += 200) {
        const part = await hintsFor(db, clubId, cands.slice(i, i + 200));
        for (const [pid, hints] of part) {
          const h = who === 'trainer' || who === 'manager' ? hints.filter((x) => x.who === who) : hints;
          if (h.length) rows.push({ personId: pid, name: names.get(pid) ?? '—', hints: h });
        }
      }
      const byKey: Record<string, number> = {};
      for (const r of rows) for (const h of r.hints) byKey[h.key] = (byKey[h.key] ?? 0) + 1;
      return { rows: rows.sort((a, b) => b.hints.length - a.hints.length || a.name.localeCompare(b.name)).slice(0, 300), byKey, total: rows.length };
    });
  });
}
