// Прогноз ухода клиента и сценарии удержания (список «20 новых возможностей», п. 4).
// Риск считает оценка «Удержание» (scoring.ts): реже ходит, долгая пауза, частые заморозки, долг, низкая оценка, клиент первого месяца.
// Для горячих (верхние 20 % по риску): мягкое сообщение уходит само, звонок с подсказкой ставится ответственному.
// Через 14 дней система смотрит, что стало: пришёл в клуб, продлил или без изменений.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { renderTemplate } from './messaging.ts';
import type { Fetch } from './msgProviders.ts';
import { responsibleFor, sendText } from './retention.ts';

type Actor = { tenantId: string; userId: string | null };
export const CHURN_TEMPLATE = '{имя}, давно не видели вас в клубе {клуб}! Как ваши тренировки? Если что-то мешает приходить, напишите — подберём удобное время или тренера.';
const DAILY_LIMIT = 50;

export async function churnSettings(db: Db, clubId: string) {
  const r = (await db.query('select churn_enabled, churn_message, churn_cooldown_days, churn_template from club_retention_settings where club_id = $1', [clubId])).rows[0];
  return { enabled: r?.churn_enabled ?? true, message: r?.churn_message ?? true, cooldownDays: r?.churn_cooldown_days ?? 30, template: (r?.churn_template as string | null) ?? CHURN_TEMPLATE };
}

/** Итоги прошлых действий: пришёл ли клиент в клуб или продлил после сообщения и звонка */
export async function trackChurnOutcomes(db: Db, clubId: string) {
  await db.query(`update churn_actions a set outcome = 'renewed', outcome_at = now() where a.club_id = $1 and a.outcome is null
    and exists (select 1 from memberships m where m.person_id = a.person_id and m.club_id = a.club_id and m.created_at > a.created_at and m.status <> 'cancelled' and m.kind <> 'guest')`, [clubId]);
  await db.query(`update churn_actions a set outcome = 'returned', outcome_at = now() where a.club_id = $1 and a.outcome is null
    and exists (select 1 from visits v where v.person_id = a.person_id and v.club_id = a.club_id and v.visited_at > a.created_at)`, [clubId]);
  await db.query(`update churn_actions set outcome = 'none', outcome_at = now() where club_id = $1 and outcome is null and created_at < now() - interval '14 days'`, [clubId]);
}

/** Сценарий удержания для горячих клиентов из оценки «Удержание». sendMessages=false — только звонки (вне рабочего времени клуба). */
export async function churnPlays(db: Db, f: Fetch | null, actor: Actor, clubId: string, sendMessages = true) {
  const s = await churnSettings(db, clubId);
  if (!s.enabled) return { calls: 0, messages: 0 };
  const today = (await db.query(`select count(*)::int as n from churn_actions where club_id = $1 and created_at > now() - interval '1 day'`, [clubId])).rows[0].n;
  const left = Math.max(0, DAILY_LIMIT - today);
  if (!left) return { calls: 0, messages: 0 };
  const rows = (await db.query(`select cs.person_id, cs.score, cs.reasons, cs.offer, cs.owner_id, p.full_name, p.messaging_opt_out
    from client_scores cs join persons p on p.id = cs.person_id
    where cs.club_id = $1 and cs.kind = 'churn' and cs.segment = 'hot' and p.merged_into_id is null
      and not exists (select 1 from churn_actions a where a.person_id = cs.person_id and a.club_id = cs.club_id and a.created_at > now() - make_interval(days => $2::int))
    order by cs.score desc limit $3`, [clubId, s.cooldownDays, left])).rows;
  let calls = 0; let messages = 0;
  for (const r of rows) {
    const reasons = (r.reasons as { effect: string; text: string }[]).filter((x) => x.effect === '+').map((x) => x.text);
    const script = (r.offer as { text?: string } | null)?.text ?? null;
    let mid: string | null = null;
    if (s.message && sendMessages && !r.messaging_opt_out) {
      const text = await renderTemplate(db, s.template, r.person_id, clubId, {});
      mid = await sendText(db, f, actor, r.person_id, clubId, text);
      if (mid) messages++;
    }
    const title = `Риск ухода: ${reasons.join(', ') || 'реже ходит'}${mid ? '. Сообщение уже отправлено' : ''}. Что сказать: ${script ?? 'узнать, как дела, пригласить на занятие'}`;
    const assignee = r.owner_id ?? await responsibleFor(db, r.person_id, clubId);
    const tid = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,'call',$5, now() + interval '2 days', $6) returning id`,
      [actor.tenantId, clubId, assignee, r.person_id, title.slice(0, 900), actor.userId])).rows[0].id;
    calls++;
    await db.query(`insert into churn_actions(tenant_id, club_id, person_id, score, reasons, script, message_id, task_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor.tenantId, clubId, r.person_id, r.score, JSON.stringify(r.reasons), script, mid, tid]);
  }
  return { calls, messages };
}

/* ---------- маршруты ---------- */
export function churnRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? null;
  app.get('/api/churn', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId || clubId === 'all') throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const list = (await db.query(`select cs.person_id as "personId", p.full_name as name, cs.score::float as score, cs.segment, cs.reasons, cs.offer->>'text' as script,
          u.full_name as owner, a.created_at as "actedAt", a.outcome, (a.message_id is not null) as messaged, t.done_at as "callDoneAt", t.result as "callResult",
          (select max(v.visited_at) from visits v where v.person_id = cs.person_id and v.club_id = cs.club_id) as "lastVisit"
        from client_scores cs join persons p on p.id = cs.person_id left join users u on u.id = cs.owner_id
          left join lateral (select * from churn_actions a where a.person_id = cs.person_id and a.club_id = cs.club_id order by a.created_at desc limit 1) a on true
          left join tasks t on t.id = a.task_id
        where cs.club_id = $1 and cs.kind = 'churn' and cs.segment in ('hot', 'warm') order by cs.score desc limit 200`, [clubId])).rows;
      const st = (await db.query(`select count(*)::int as acted, count(*) filter (where message_id is not null)::int as messaged,
          count(*) filter (where outcome = 'returned')::int as returned, count(*) filter (where outcome = 'renewed')::int as renewed, count(*) filter (where outcome = 'none')::int as "none"
        from churn_actions where club_id = $1 and created_at > now() - interval '60 days'`, [clubId])).rows[0];
      const total = (await db.query(`select count(*)::int as n from client_scores where club_id = $1 and kind = 'churn'`, [clubId])).rows[0].n;
      const decided = st.returned + st.renewed + st.none;
      return { settings: await churnSettings(db, clubId), canManage: can(ctx, P.retentionManage), list,
        stats: { scored: total, hot: list.filter((x) => x.segment === 'hot').length, warm: list.filter((x) => x.segment === 'warm').length, ...st,
          savedPct: decided ? Math.round(((st.returned + st.renewed) * 100) / decided) : null } };
    });
  });

  app.put('/api/churn/settings', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const b = (req.body ?? {}) as { clubId?: string; enabled?: boolean; message?: boolean; cooldownDays?: number; template?: string | null };
    if (!b.clubId) throw badRequest('Выберите клуб');
    const cd = b.cooldownDays === undefined ? undefined : Number(b.cooldownDays);
    if (cd !== undefined && !(Number.isInteger(cd) && cd >= 7 && cd <= 120)) throw badRequest('Повторно не чаще: от 7 до 120 дней');
    if (b.template !== undefined && b.template !== null && (!b.template.trim() || b.template.length > 1000)) throw badRequest('Текст сообщения: от 1 до 1000 знаков');
    return withCtx(pool, ctx, async (db) => {
      const before = await churnSettings(db, b.clubId!);
      const after = { enabled: b.enabled ?? before.enabled, message: b.message ?? before.message, cooldownDays: cd ?? before.cooldownDays,
        template: b.template === undefined ? before.template : (b.template?.trim() || CHURN_TEMPLATE) };
      await db.query(`insert into club_retention_settings(club_id, tenant_id, churn_enabled, churn_message, churn_cooldown_days, churn_template, updated_by) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (club_id) do update set churn_enabled = excluded.churn_enabled, churn_message = excluded.churn_message, churn_cooldown_days = excluded.churn_cooldown_days,
          churn_template = excluded.churn_template, updated_by = excluded.updated_by, updated_at = now()`,
        [b.clubId, ctx.tenantId, after.enabled, after.message, after.cooldownDays, after.template === CHURN_TEMPLATE ? null : after.template, ctx.userId]);
      await audit(db, ctx, 'churn.settings', 'club', b.clubId!, before, after);
      return after;
    });
  });

  app.post('/api/churn/run', async (req) => {
    const ctx = requirePerm(req, P.retentionManage);
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => { await trackChurnOutcomes(db, clubId); return churnPlays(db, f, ctx, clubId); });
  });
}
