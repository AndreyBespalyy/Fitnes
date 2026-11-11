// «Приведи друга» (список «20 новых возможностей», п. 8).
// У клиента своя ссылка /r/КОД. Друг оставляет по ней заявку: лид с источником «Рекомендация» и отметкой, кто привёл.
// Первая покупка друга идёт со скидкой (по умолчанию 10 %), а привёдшему добавляются дни к срочному абонементу (по умолчанию 14).
// Нет срочного абонемента — ответственному ставится задача начислить бонус вручную.
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { createLead } from './crm.ts';
import { addDays, clubToday } from './memberships.ts';
import { renderTemplate } from './messaging.ts';
import { responsibleFor, sendText } from './retention.ts';

type Actor = Pick<Ctx, 'tenantId' | 'userId'> & { ip?: string };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O и 1/I
const baseUrl = (req?: FastifyRequest) => (process.env.PUBLIC_URL || (req ? `${req.protocol}://${req.headers.host}` : 'https://app.amoglobal.ru')).replace(/\/$/, '');
export const INVITE_TEMPLATE = '{имя}, приводите друзей в {клуб}! Друг получит скидку {скидка} на первый абонемент, а вы — {дни} к своему абонементу, когда он купит. Ваша ссылка для друзей: {ссылка}';

export async function referralSettings(db: Db, clubId: string) {
  const r = (await db.query('select enabled, friend_percent, referrer_days from referral_settings where club_id = $1', [clubId])).rows[0];
  return { enabled: r?.enabled ?? true, friendPercent: r ? Number(r.friend_percent) : 10, referrerDays: r?.referrer_days ?? 14 };
}

/** Код клиента для приглашений: создаётся при первом обращении и дальше не меняется */
export async function referralCode(db: Db, personId: string) {
  const cur = (await db.query('select referral_code from persons where id = $1', [personId])).rows[0];
  if (!cur) throw notFound('Клиент не найден');
  if (cur.referral_code) return cur.referral_code as string;
  for (let i = 0; i < 10; i++) {
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const r = await db.query(`update persons set referral_code = $2 where id = $1 and referral_code is null and not exists (select 1 from persons where referral_code = $2) returning referral_code`, [personId, code]);
    if (r.rowCount) return code;
  }
  throw new HttpError(500, 'Не удалось создать код. Попробуйте ещё раз');
}

/** Записать, что друга привёл клиент. Не засчитывается, если друг уже был клиентом клуба или это он сам. */
export async function attachReferral(db: Db, actor: Actor, a: { clubId: string; friendId: string; code: string; leadId?: string | null; via: 'link' | 'staff' }) {
  const ref = (await db.query('select id, full_name from persons where referral_code = upper($1)', [a.code.trim()])).rows[0];
  if (!ref) throw badRequest('Код приглашения не найден', 'ref_not_found');
  if (ref.id === a.friendId) throw badRequest('Нельзя пригласить самого себя', 'ref_self');
  if ((await db.query(`select 1 from memberships where person_id = $1 and club_id = $2 and kind <> 'guest' and status <> 'cancelled'`, [a.friendId, a.clubId])).rowCount)
    throw badRequest('Этот человек уже был клиентом клуба: рекомендация не засчитывается', 'ref_existing');
  const r = await db.query(`insert into referrals(tenant_id, club_id, referrer_id, friend_id, lead_id, via, created_by) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (club_id, friend_id) do nothing returning id`, [actor.tenantId, a.clubId, ref.id, a.friendId, a.leadId ?? null, a.via, actor.userId]);
  if (!r.rowCount) throw badRequest('Друг уже записан как приглашённый', 'ref_duplicate');
  await audit(db, actor, 'referral.attached', 'person', a.friendId, null, { referrerId: ref.id, via: a.via });
  return { id: r.rows[0].id as string, referrerName: ref.full_name as string };
}

/** Скидка другу на первую покупку. Вызывается из продажи, если другой скидки нет. */
export async function referralDiscount(db: Db, personId: string, clubId: string, category: string, amountKop: number) {
  if (category !== 'new' && category !== 'subscription') return null;
  const r = (await db.query(`select r.id, p.full_name from referrals r join persons p on p.id = r.referrer_id where r.friend_id = $1 and r.club_id = $2 and r.status = 'lead'`, [personId, clubId])).rows[0];
  if (!r) return null;
  const s = await referralSettings(db, clubId);
  if (!s.enabled || !s.friendPercent) return null;
  return { discountKop: Math.round(amountKop * s.friendPercent / 100), label: `скидка ${s.friendPercent} % по рекомендации (${r.full_name})` };
}

/** Друг купил: засчитать рекомендацию и наградить того, кто привёл. Вызывается из продажи. */
export async function onReferralPurchase(db: Db, actor: Actor, a: { personId: string; clubId: string; membershipId: string; category: string; amountKop: number; discountKop: number }) {
  if (a.category !== 'new' && a.category !== 'subscription') return;
  const r = (await db.query(`select r.*, p.full_name as friend_name from referrals r join persons p on p.id = r.friend_id where r.friend_id = $1 and r.club_id = $2 and r.status = 'lead' for update of r`, [a.personId, a.clubId])).rows[0];
  if (!r) return;
  const s = await referralSettings(db, a.clubId);
  await db.query(`update referrals set status = 'bought', membership_id = $2, revenue_kop = $3, friend_discount_kop = $4, bought_at = now() where id = $1`, [r.id, a.membershipId, a.amountKop, a.discountKop]);
  if (!s.enabled || !s.referrerDays) return;
  const today = await clubToday(db, a.clubId);
  // Дни добавляются к действующему срочному абонементу привёдшего, который заканчивается позже всех
  const m = (await db.query(`select id, ends_on::text as ends_on, product_name from memberships where person_id = $1 and club_id = $2 and status = 'active' and kind = 'term' and ends_on >= $3
    order by ends_on desc limit 1`, [r.referrer_id, a.clubId, today])).rows[0];
  if (m) {
    const newEnd = addDays(m.ends_on, s.referrerDays);
    await db.query('update memberships set ends_on = $2 where id = $1', [m.id, newEnd]);
    await db.query('insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id) values ($1,$2,$3,$4,$5,$6)',
      [actor.tenantId, a.clubId, m.id, 'bonus_days', JSON.stringify({ days: s.referrerDays, reason: 'referral', referralId: r.id, endsBefore: m.ends_on, endsAfter: newEnd }), actor.userId]);
    await db.query(`update referrals set status = 'rewarded', reward_days = $2, reward_membership_id = $3 where id = $1`, [r.id, s.referrerDays, m.id]);
    await audit(db, actor, 'referral.rewarded', 'membership', m.id, { endsOn: m.ends_on }, { endsOn: newEnd, days: s.referrerDays, referralId: r.id });
    const opt = (await db.query('select messaging_opt_out from persons where id = $1', [r.referrer_id])).rows[0];
    if (!opt?.messaging_opt_out) {
      const text = await renderTemplate(db, `{имя}, спасибо за рекомендацию! Ваш друг стал клиентом клуба {клуб}. Мы добавили ${s.referrerDays} дн. к абонементу «${m.product_name}»: теперь он действует до ${newEnd.split('-').reverse().join('.')}.`, r.referrer_id, a.clubId);
      await sendText(db, null, actor, r.referrer_id, a.clubId, text);
    }
  } else {
    const assignee = await responsibleFor(db, r.referrer_id, a.clubId);
    const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,'call',$5, now() + interval '2 days', $6) returning id`,
      [actor.tenantId, a.clubId, assignee, r.referrer_id, `Рекомендация: друг (${r.friend_name}) купил абонемент. У клиента нет срочного абонемента — договоритесь о бонусе (${s.referrerDays} дн.) и начислите вручную`, actor.userId])).rows[0].id;
    await db.query(`update referrals set status = 'reward_manual', task_id = $2 where id = $1`, [r.id, tid]);
  }
}

/* ---------- публичная страница приглашения ---------- */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function invitePage(code: string, v: { firstName: string; clubName: string; percent: number } | null) {
  const body = v
    ? `<h1>${esc(v.firstName || 'Ваш друг')} приглашает вас в ${esc(v.clubName)}</h1>
      ${v.percent ? `<p>По этому приглашению скидка <b>${v.percent} %</b> на первый абонемент.</p>` : ''}
      <p>Оставьте имя и телефон — менеджер клуба позвонит и запишет на первое посещение.</p>
      <form id="f">
        <label>Имя<input name="name" required maxlength="100" autocomplete="name"></label>
        <label>Телефон<input name="phone" required inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00"></label>
        <label class="c"><input type="checkbox" name="consent" required> Согласен на обработку персональных данных для связи со мной</label>
        <button>Отправить</button><p id="m" role="status"></p>
      </form>
      <script>
        document.getElementById('f').onsubmit = async (e) => {
          e.preventDefault(); const f = e.target; const m = document.getElementById('m'); m.textContent = 'Отправляем…';
          const r = await fetch('/api/public/v1/ref/${esc(code)}', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: f.name.value, phone: f.phone.value, consent: f.consent.checked }) }).catch(() => null);
          const j = r ? await r.json().catch(() => ({})) : {};
          if (r && r.ok) { f.innerHTML = '<p><b>Спасибо!</b> Менеджер клуба скоро свяжется с вами.</p>'; } else { m.textContent = j.message || 'Не получилось отправить. Попробуйте ещё раз'; }
        };
      </script>`
    : '<h1>Приглашение не найдено</h1><p>Проверьте ссылку или спросите её у друга ещё раз.</p>';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Приглашение в клуб</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f6f5;color:#142320;margin:0;padding:24px 16px}main{max-width:460px;margin:0 auto;background:#fff;border:1px solid #d8e2df;border-radius:14px;padding:24px}
h1{font-size:22px;margin:0 0 12px}label{display:grid;gap:4px;margin:12px 0;font-size:14px}label.c{display:flex;gap:8px;align-items:flex-start}input{font:inherit;padding:10px;border:1px solid #c5d3cf;border-radius:8px}
input[type=checkbox]{margin-top:3px}button{font:inherit;font-weight:600;background:#127a6e;color:#fff;border:0;border-radius:8px;padding:12px 18px;width:100%;cursor:pointer}#m{color:#a33;font-size:14px}</style>
</head><body><main>${body}</main></body></html>`;
}

/* ---------- маршруты ---------- */
export function referralRoutes(app: FastifyInstance, pool: pg.Pool) {
  const hits = new Map<string, number[]>();
  const limited = (ip: string) => {
    const now = Date.now(); const h = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    h.push(now); hits.set(ip, h); return h.length > 10;
  };
  const lookup = async (code: string) => (/^[A-Z0-9]{4,12}$/i.test(code) ? (await pool.query('select * from referral_lookup($1)', [code])).rows[0] : undefined);

  app.get('/r/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const r = await lookup(code);
    const s = r ? await withCtx(pool, { tenantId: r.tenant_id, allClubs: true, clubIds: [] }, (db) => referralSettings(db, r.club_id)) : null;
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    return invitePage(code.toUpperCase(), r && s?.enabled ? { firstName: r.first_name, clubName: r.club_name, percent: s.friendPercent } : null);
  });

  app.post('/api/public/v1/ref/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const b = (req.body ?? {}) as { name?: string; phone?: string; consent?: boolean };
    if (limited(req.ip)) throw new HttpError(429, 'Слишком много заявок. Попробуйте позже', 'rate_limited');
    if (!b.consent) throw badRequest('Нужно согласие на обработку персональных данных');
    if (!b.name?.trim() || !b.phone?.trim()) throw badRequest('Укажите имя и телефон');
    const r = await lookup(code);
    if (!r) throw notFound('Приглашение не найдено');
    const actor = { tenantId: r.tenant_id as string, userId: null as unknown as string, ip: req.ip };
    await withCtx(pool, { tenantId: r.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const s = await referralSettings(db, r.club_id);
      if (!s.enabled) throw notFound('Приглашение не найдено');
      const lead = await createLead(db, actor, { clubId: r.club_id, fullName: b.name!.trim().slice(0, 100), phone: b.phone, sourceCode: 'referral',
        comment: `По приглашению клиента (код ${code.toUpperCase()}). Согласие на обработку данных дано на странице приглашения` });
      await attachReferral(db, actor, { clubId: r.club_id, friendId: lead.personId, code, leadId: lead.leadId, via: 'link' }).catch((e) => {
        // Уже был клиентом или уже приглашён — заявка всё равно принята, просто без отметки рекомендации
        if (!(e instanceof HttpError) || e.status !== 400) throw e;
      });
    });
    reply.code(201);
    return { ok: true };
  });

  // Код и ссылка клиента, кого он привёл
  app.get('/api/persons/:id/referral', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const code = await referralCode(db, id);
      const invited = (await db.query(`select r.id, r.friend_id as "friendId", p.full_name as name, r.status, r.created_at as "createdAt", r.bought_at as "boughtAt", r.reward_days as "rewardDays", c.name as "clubName"
        from referrals r join persons p on p.id = r.friend_id join clubs c on c.id = r.club_id where r.referrer_id = $1 order by r.created_at desc`, [id])).rows;
      const by = (await db.query(`select r.referrer_id as "referrerId", p.full_name as name, r.status from referrals r join persons p on p.id = r.referrer_id where r.friend_id = $1 limit 1`, [id])).rows[0] ?? null;
      return { code, link: `${baseUrl(req)}/r/${code}`, invited, invitedBy: by };
    });
  });

  // Отправить клиенту его ссылку в мессенджер
  app.post('/api/persons/:id/referral/send', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const s = await referralSettings(db, clubId);
      if (!s.enabled) throw badRequest('В клубе программа «Приведи друга» выключена');
      const code = await referralCode(db, id);
      const text = await renderTemplate(db, INVITE_TEMPLATE, id, clubId, { скидка: `${s.friendPercent} %`, дни: `${s.referrerDays} дн.`, ссылка: `${baseUrl(req)}/r/${code}` });
      const mid = await sendText(db, null, ctx, id, clubId, text);
      if (!mid) throw badRequest('У клиента нет мессенджера, через который можно написать. Продиктуйте код или ссылку');
      await audit(db, ctx, 'referral.link_sent', 'person', id, null, { messageId: mid });
      return { ok: true };
    });
  });

  // Друг пришёл сам и назвал код — менеджер или ресепшн отмечает, кто привёл
  app.post('/api/referrals/attach', async (req, reply) => {
    const ctx = requirePerm(req, P.leadsCreate);
    const b = (req.body ?? {}) as { friendId?: string; code?: string; clubId?: string };
    if (!b.friendId || !b.code?.trim() || !b.clubId) throw badRequest('Укажите клиента, клуб и код приглашения');
    const res = await withCtx(pool, ctx, (db) => attachReferral(db, ctx, { clubId: b.clubId!, friendId: b.friendId!, code: b.code!, via: 'staff' }));
    reply.code(201);
    return res;
  });

  // Отчёт: лучшие «амбассадоры», воронка рекомендаций, настройки
  app.get('/api/referrals', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const top = (await db.query(`select r.referrer_id as "personId", p.full_name as name, count(*)::int as invited,
          count(*) filter (where r.status <> 'lead')::int as bought, coalesce(sum(r.revenue_kop), 0)::bigint as revenue, coalesce(sum(r.reward_days), 0)::int as days
        from referrals r join persons p on p.id = r.referrer_id where r.club_id = $1 group by r.referrer_id, p.full_name order by bought desc, invited desc limit 50`, [clubId])).rows
        .map((x) => ({ ...x, revenue: Number(x.revenue) }));
      const recent = (await db.query(`select r.id, r.friend_id as "friendId", f.full_name as friend, r.referrer_id as "referrerId", p.full_name as referrer, r.status, r.via,
          r.created_at as "createdAt", r.revenue_kop::bigint as revenue, r.task_id as "taskId"
        from referrals r join persons f on f.id = r.friend_id join persons p on p.id = r.referrer_id where r.club_id = $1 order by r.created_at desc limit 100`, [clubId])).rows
        .map((x) => ({ ...x, revenue: x.revenue == null ? null : Number(x.revenue) }));
      const st = (await db.query(`select count(*)::int as invited, count(*) filter (where status <> 'lead')::int as bought, coalesce(sum(revenue_kop), 0)::bigint as revenue,
          coalesce(sum(friend_discount_kop), 0)::bigint as discounts, count(*) filter (where status = 'reward_manual')::int as manual
        from referrals where club_id = $1 and created_at > now() - interval '90 days'`, [clubId])).rows[0];
      return { settings: await referralSettings(db, clubId), canManage: can(ctx, P.retentionManage), top, recent,
        stats: { ...st, revenue: Number(st.revenue), discounts: Number(st.discounts), conversion: st.invited ? Math.round(st.bought * 100 / st.invited) : null } };
    });
  });

  app.put('/api/referrals/settings', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as { clubId?: string; enabled?: boolean; friendPercent?: number; referrerDays?: number };
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (b.friendPercent !== undefined && !(Number(b.friendPercent) >= 0 && Number(b.friendPercent) <= 50)) throw badRequest('Скидка другу: от 0 до 50 %');
    if (b.referrerDays !== undefined && !(Number.isInteger(Number(b.referrerDays)) && Number(b.referrerDays) >= 0 && Number(b.referrerDays) <= 90)) throw badRequest('Дни за друга: от 0 до 90');
    return withCtx(pool, ctx, async (db) => {
      const before = await referralSettings(db, b.clubId!);
      const after = { enabled: b.enabled ?? before.enabled, friendPercent: b.friendPercent === undefined ? before.friendPercent : Number(b.friendPercent),
        referrerDays: b.referrerDays === undefined ? before.referrerDays : Number(b.referrerDays) };
      await db.query(`insert into referral_settings(club_id, tenant_id, enabled, friend_percent, referrer_days, updated_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (club_id) do update set enabled = excluded.enabled, friend_percent = excluded.friend_percent, referrer_days = excluded.referrer_days, updated_by = excluded.updated_by, updated_at = now()`,
        [b.clubId, ctx.tenantId, after.enabled, after.friendPercent, after.referrerDays, ctx.userId]);
      await audit(db, ctx, 'referral.settings', 'club', b.clubId!, before, after);
      return after;
    });
  });
}
