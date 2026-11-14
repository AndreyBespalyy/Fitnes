// ИИ-агент, этап 2 (выбор Андрея 14.11.2026): напоминания-карточки «что случилось и что сделать» с кнопками,
// лестница эскалации (исполнитель → РОП → управляющий → собственник) и авто-передача заявки другому менеджеру.
// Агент действует сам только внутри CRM (2Б): ставит напоминания, переносит сроки по кнопке, передаёт заявки. Клиентам не пишет.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { processMeetingReminders } from './agentMeetings.ts';
import { advanceProcesses } from './agentProcesses.ts';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { staffOf } from './salesOps.ts';
import { processWeeklyReview } from './agentWeekly.ts';

type Actor = { tenantId: string; userId: string | null };
export type AgentSettings = { enabled: boolean; taskRopMinutes: number; taskGmMinutes: number; taskOwnerMinutes: number; replyWaitMinutes: number;
  leadReassignMinutes: number; quietFrom: number; quietTo: number };
export const AGENT_DEFAULTS: AgentSettings = { enabled: true, taskRopMinutes: 60, taskGmMinutes: 240, taskOwnerMinutes: 1440, replyWaitMinutes: 15,
  leadReassignMinutes: 10, quietFrom: 22, quietTo: 8 };
const LIMITS: Record<keyof Omit<AgentSettings, 'enabled'>, [number, number]> = {
  taskRopMinutes: [5, 2880], taskGmMinutes: [10, 10080], taskOwnerMinutes: [60, 20160], replyWaitMinutes: [3, 240], leadReassignMinutes: [0, 240], quietFrom: [0, 23], quietTo: [0, 23] };

export async function agentSettings(db: Db, clubId: string): Promise<AgentSettings> {
  const r = (await db.query(`select * from agent_settings where club_id = $1`, [clubId])).rows[0];
  if (!r) return { ...AGENT_DEFAULTS };
  return { enabled: r.enabled, taskRopMinutes: r.task_rop_minutes, taskGmMinutes: r.task_gm_minutes, taskOwnerMinutes: r.task_owner_minutes,
    replyWaitMinutes: r.reply_wait_minutes, leadReassignMinutes: r.lead_reassign_minutes, quietFrom: r.quiet_from, quietTo: r.quiet_to };
}

export type Action = 'brief' | 'open' | 'snooze_1h' | 'snooze_tomorrow' | 'nudge' | 'reassign' | 'chat';
type Card = { kind: string; title: string; body: string; objectType: 'task' | 'opportunity' | 'lead' | 'conversation' | null; objectId: string | null;
  actions: Action[]; link: { tab: string; p?: Record<string, string> } | null };

/** Карточка-уведомление с кнопками */
export async function card(db: Db, clubId: string, userIds: string[], c: Card) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;
  await db.query(`insert into staff_notifications(tenant_id, club_id, user_id, kind, title, body, link, object_type, object_id, actions)
    select app_tenant(), $1, u, $3, $4, $5, $6, $7, $8, $9 from unnest($2::uuid[]) u`,
  [clubId, ids, c.kind, c.title.slice(0, 200), c.body.slice(0, 1000), c.link ? JSON.stringify(c.link) : null, c.objectType, c.objectId, JSON.stringify(c.actions)]);
  return ids.length;
}

async function once(db: Db, clubId: string, key: string) {
  return !!(await db.query(`insert into agent_sent(tenant_id, club_id, key) values (app_tenant(), $1, $2) on conflict do nothing`, [clubId, key])).rowCount;
}

async function observe(db: Db, clubId: string, o: { personId?: string | null; opportunityId?: string | null; taskId?: string | null }, kind: string, body: string) {
  await db.query(`insert into agent_observations(tenant_id, club_id, person_id, opportunity_id, task_id, kind, body) values (app_tenant(),$1,$2,$3,$4,$5,$6)`,
    [clubId, o.personId ?? null, o.opportunityId ?? null, o.taskId ?? null, kind, body.slice(0, 1000)]);
}

const hm = (min: number) => (min >= 1440 ? `${Math.floor(min / 1440)} дн.` : min >= 60 ? `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ''}` : `${min} мин`);
const personLink = (personId: string | null) => (personId ? { tab: 'tasks', p: { person: personId } } : { tab: 'tasks' });

/* ---------- 1. Просроченные задачи: лестница ---------- */
export async function processTaskLadder(db: Db, clubId: string, s: AgentSettings) {
  // Только свежие просрочки (не старше недели): старые висящие задачи разбирает недельный обзор, а не поток уведомлений
  const rows = (await db.query(`select t.id, t.title, t.assignee_id, t.person_id, t.opportunity_id, u.full_name as assignee, p.full_name as person,
      floor(extract(epoch from now() - t.due_at) / 60)::int as over
    from tasks t left join users u on u.id = t.assignee_id left join persons p on p.id = t.person_id
    where t.club_id = $1 and t.done_at is null and t.due_at < now() and t.due_at > now() - interval '7 days' order by t.due_at limit 200`, [clubId])).rows;
  const heads = { rop: await staffOf(db, clubId, ['rop']), gm: await staffOf(db, clubId, ['gm']), owner: await staffOf(db, clubId, ['owner']) };
  let sent = 0;
  for (const t of rows) {
    const who = t.person ? ` — ${t.person}` : '';
    const acts: Action[] = t.opportunity_id || t.person_id ? ['brief', 'open'] : ['brief'];
    // Уровень 1: исполнителю, сразу как просрочилась
    if (t.assignee_id && await once(db, clubId, `task:${t.id}:1`)) {
      sent += await card(db, clubId, [t.assignee_id], { kind: 'agent_task', title: `Просрочена задача: ${t.title}`, body: `${t.person ? `Клиент: ${t.person}. ` : ''}Выполните сейчас или перенесите срок.`,
        objectType: 'task', objectId: t.id, actions: [...acts, 'snooze_1h', 'snooze_tomorrow'], link: personLink(t.person_id) });
    }
    const steps: [number, number, { id: string }[], string][] = [
      [2, s.taskRopMinutes, heads.rop.length ? heads.rop : heads.gm, 'РОП'],
      [3, s.taskGmMinutes, heads.gm, 'управляющий'],
      [4, s.taskOwnerMinutes, heads.owner, 'собственник'],
    ];
    for (const [level, after, to, role] of steps) {
      if (t.over < after) continue;
      const targets = to.map((u) => u.id).filter((id) => id !== t.assignee_id);
      if (!targets.length || !(await once(db, clubId, `task:${t.id}:${level}`))) continue;
      sent += await card(db, clubId, targets, { kind: 'agent_escalate', title: `${t.assignee ?? 'Без исполнителя'}: задача просрочена на ${hm(t.over)}`,
        body: `«${t.title}»${who}. Исполнитель не выполнил задачу, сигнал передан вам (${role}).`,
        objectType: 'task', objectId: t.id, actions: [...acts, 'nudge', 'reassign'], link: personLink(t.person_id) });
      await observe(db, clubId, { personId: t.person_id, opportunityId: t.opportunity_id, taskId: t.id }, 'escalation',
        `Задача «${t.title}» просрочена на ${hm(t.over)} (исполнитель ${t.assignee ?? 'не назначен'}), сигнал: ${role}.`);
    }
  }
  return sent;
}

/* ---------- 2. Клиент написал и ждёт ответа ---------- */
export async function processReplyWait(db: Db, clubId: string, s: AgentSettings) {
  const rows = (await db.query(`select c.id, c.person_id, c.last_inbound_at, p.full_name, c.assigned_to,
      (select o.owner_id from opportunities o where o.person_id = c.person_id and o.club_id = c.club_id and o.status = 'open' order by o.created_at desc limit 1) as owner,
      (select o.id from opportunities o where o.person_id = c.person_id and o.club_id = c.club_id and o.status = 'open' order by o.created_at desc limit 1) as opp,
      floor(extract(epoch from now() - c.last_inbound_at) / 60)::int as waited
    from msg_conversations c left join persons p on p.id = c.person_id
    where c.club_id = $1 and c.last_inbound_at > now() - interval '1 day' and c.last_inbound_at < now() - make_interval(mins => $2)
      and not exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'out' and not m.auto and m.created_at > c.last_inbound_at)`,
  [clubId, s.replyWaitMinutes])).rows;
  let sent = 0;
  for (const c of rows) {
    const name = c.full_name ?? 'Клиент';
    const stamp = new Date(c.last_inbound_at).getTime();
    const to = c.assigned_to ?? c.owner;
    const acts: Action[] = c.opp ? ['chat', 'brief'] : ['chat'];
    const link: { tab: string; p?: Record<string, string> } = c.person_id ? { tab: 'chats', p: { person: c.person_id } } : { tab: 'chats' };
    if (await once(db, clubId, `reply:${c.id}:${stamp}:1`)) {
      const ids = to ? [to] : (await staffOf(db, clubId, ['manager'])).map((u) => u.id);
      sent += await card(db, clubId, ids, { kind: 'agent_reply', title: `${name} ждёт ответа ${hm(c.waited)}`, body: 'Клиент написал в мессенджер, ответа ещё нет.',
        objectType: c.opp ? 'opportunity' : 'conversation', objectId: c.opp ?? c.id, actions: acts, link });
    }
    // Втрое дольше нормы — РОПу
    if (c.waited >= s.replyWaitMinutes * 3 && (await once(db, clubId, `reply:${c.id}:${stamp}:2`))) {
      const heads = await staffOf(db, clubId, ['rop']);
      const who = to ? (await db.query('select full_name from users where id = $1', [to])).rows[0]?.full_name : null;
      sent += await card(db, clubId, (heads.length ? heads : await staffOf(db, clubId, ['gm'])).map((u) => u.id).filter((id) => id !== to), {
        kind: 'agent_escalate', title: `${name} ждёт ответа ${hm(c.waited)}`, body: `Ответственный: ${who ?? 'не назначен'}. Клиент написал и до сих пор без ответа.`,
        objectType: c.opp ? 'opportunity' : 'conversation', objectId: c.opp ?? c.id, actions: acts, link });
      await observe(db, clubId, { personId: c.person_id, opportunityId: c.opp }, 'reply_wait', `Клиент ждал ответа в переписке ${hm(c.waited)}, сигнал РОПу.`);
    }
  }
  return sent;
}

/* ---------- 3. Авто-передача заявки ---------- */
/** Менеджер клуба с наименьшей загрузкой (открытые задачи), кроме исключённого */
export async function leastLoaded(db: Db, clubId: string, except: string | null) {
  return (await db.query(`select u.id, u.full_name, (select count(*) from tasks t where t.assignee_id = u.id and t.done_at is null) as load
    from users u join user_assignments a on a.user_id = u.id
    where a.club_id = $1 and a.role_code = 'manager' and u.status = 'active' and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)
      and u.id is distinct from $2 order by load, u.full_name limit 1`, [clubId, except])).rows[0] as { id: string; full_name: string } | undefined;
}

export async function reassignOpenWork(db: Db, opts: { opportunityId: string | null; leadId?: string | null; from: string | null; to: string }) {
  if (opts.opportunityId) {
    await db.query('update opportunities set owner_id = $2, updated_at = now() where id = $1', [opts.opportunityId, opts.to]);
    await db.query('update tasks set assignee_id = $2 where opportunity_id = $1 and done_at is null', [opts.opportunityId, opts.to]);
  }
  if (opts.leadId) await db.query('update leads set assigned_to = $2 where id = $1', [opts.leadId, opts.to]);
}

export async function processLeadReassign(db: Db, actor: Actor, clubId: string, s: AgentSettings) {
  if (!s.leadReassignMinutes) return 0;
  const rows = (await db.query(`select l.id, l.person_id, l.assigned_to, l.opportunity_id, p.full_name, u.full_name as mgr
    from leads l join clubs c on c.id = l.club_id join persons p on p.id = l.person_id left join users u on u.id = l.assigned_to
    where l.club_id = $1 and l.taken_at is null and l.first_response_at is null and l.agent_reassigned_at is null and l.created_at > now() - interval '1 day'
      and now() >= (l.first_response_due_at - make_interval(mins => c.first_response_minutes)) + make_interval(mins => $2)`, [clubId, s.leadReassignMinutes])).rows;
  let n = 0;
  for (const l of rows) {
    const to = await leastLoaded(db, clubId, l.assigned_to);
    if (!to) { await db.query('update leads set agent_reassigned_at = now() where id = $1', [l.id]); continue; }
    await reassignOpenWork(db, { opportunityId: l.opportunity_id, leadId: l.id, from: l.assigned_to, to: to.id });
    await db.query('update leads set agent_reassigned_at = now(), agent_reassigned_from = $2 where id = $1', [l.id, l.assigned_to]);
    const link = { tab: 'sales', p: { view: 'leads', person: l.person_id } };
    await card(db, clubId, [to.id], { kind: 'agent_lead', title: `Вам передана заявка: ${l.full_name}`,
      body: `${l.mgr ? `${l.mgr} не взял(а) её` : 'Заявку никто не взял'} за ${s.leadReassignMinutes} мин. Позвоните клиенту сейчас.`,
      objectType: 'opportunity', objectId: l.opportunity_id, actions: ['open', 'brief'], link });
    if (l.assigned_to) await card(db, clubId, [l.assigned_to], { kind: 'agent_lead', title: `Заявка ${l.full_name} передана: ${to.full_name}`,
      body: `Вы не взяли её за ${s.leadReassignMinutes} мин. Заявки в работу берите кнопкой «Беру в работу».`, objectType: 'opportunity', objectId: l.opportunity_id, actions: [], link: null });
    const heads = await staffOf(db, clubId, ['rop']);
    await card(db, clubId, heads.map((u) => u.id), { kind: 'agent_lead', title: `Заявка передана: ${l.full_name}`,
      body: `${l.mgr ?? 'Ответственного не было'} → ${to.full_name}: заявку не взяли за ${s.leadReassignMinutes} мин.`, objectType: 'opportunity', objectId: l.opportunity_id, actions: ['brief'], link });
    await observe(db, clubId, { personId: l.person_id, opportunityId: l.opportunity_id }, 'lead_reassign',
      `Заявку не взяли за ${s.leadReassignMinutes} мин (${l.mgr ?? 'без ответственного'}), агент передал её: ${to.full_name}.`);
    await audit(db, actor, 'agent.lead_reassigned', 'lead', l.id, { assignedTo: l.assigned_to }, { assignedTo: to.id });
    n++;
  }
  return n;
}

/* ---------- цикл ---------- */
export async function processAgentClub(db: Db, actor: Actor, c: { id: string; h: number }) {
  await processMeetingReminders(db, c.id); // собрания — всегда, даже в тихие часы: напоминание за час до начала
  await advanceProcesses(db, actor, c.id); // бизнес-процессы: выполненный шаг → следующий
  const s = await agentSettings(db, c.id);
  if (!s.enabled) return { tasks: 0, replies: 0, reassigned: 0 };
  await processWeeklyReview(db, actor, c.id); // понедельник утром — разбор прошлой недели
  const quiet = s.quietFrom > s.quietTo ? c.h >= s.quietFrom || c.h < s.quietTo : c.h >= s.quietFrom && c.h < s.quietTo;
  if (quiet) return { tasks: 0, replies: 0, reassigned: 0 };
  return { tasks: await processTaskLadder(db, c.id, s), replies: await processReplyWait(db, c.id, s), reassigned: await processLeadReassign(db, actor, c.id, s) };
}

export async function processAgent(pool: pg.Pool) {
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const clubs = await withCtx(pool, sys, async (db) => (await db.query(`select id, extract(hour from now() at time zone timezone)::int as h
      from clubs where status = 'active' and not is_demo`)).rows);
    for (const c of clubs) await withCtx(pool, sys, (db) => processAgentClub(db, { tenantId, userId: null }, c)).catch((e) => console.error('ИИ-агент:', (e as Error).message));
  }
}

export function startAgentWorker(pool: pg.Pool, everyMs = 60_000) {
  let busy = false;
  const t = setInterval(async () => { if (busy) return; busy = true; try { await processAgent(pool); } catch (e) { console.error('ИИ-агент:', (e as Error).message); } finally { busy = false; } }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/* ---------- кнопки в карточке ---------- */
async function tomorrow10(db: Db, clubId: string) {
  return (await db.query(`select ((date_trunc('day', now() at time zone timezone) + interval '1 day 10 hours') at time zone timezone) as at from clubs where id = $1`, [clubId])).rows[0].at as Date;
}

export async function doAction(db: Db, ctx: Ctx, noteId: string, action: Action) {
  const n = (await db.query(`select * from staff_notifications where id = $1 and user_id = $2`, [noteId, ctx.userId])).rows[0];
  if (!n) throw notFound('Уведомление не найдено');
  const acts: string[] = n.actions ?? [];
  if (!acts.includes(action)) throw badRequest('Это действие здесь недоступно');
  let message = '';
  if (n.object_type === 'task' && ['snooze_1h', 'snooze_tomorrow', 'nudge', 'reassign'].includes(action)) {
    const t = (await db.query(`select t.*, p.full_name as person from tasks t left join persons p on p.id = t.person_id where t.id = $1`, [n.object_id])).rows[0];
    if (!t) throw notFound('Задача не найдена');
    if (t.done_at) message = 'Задача уже выполнена';
    else if (action === 'snooze_1h' || action === 'snooze_tomorrow') {
      if (t.assignee_id !== ctx.userId && !can(ctx, P.crmViewAll)) throw notFound('Задача не найдена');
      const at = action === 'snooze_1h' ? new Date(Date.now() + 3_600_000) : await tomorrow10(db, t.club_id);
      await db.query('update tasks set due_at = $2 where id = $1', [t.id, at]);
      await audit(db, ctx, 'agent.task_snoozed', 'task', t.id, { dueAt: t.due_at }, { dueAt: at });
      message = action === 'snooze_1h' ? 'Перенесено на час' : 'Перенесено на завтра, 10:00';
    } else if (action === 'nudge') {
      const me = (await db.query('select full_name from users where id = $1', [ctx.userId])).rows[0]?.full_name ?? 'Руководитель';
      await card(db, t.club_id, [t.assignee_id], { kind: 'agent_nudge', title: `${me} просит выполнить задачу`, body: `«${t.title}»${t.person ? ` — ${t.person}` : ''}`,
        objectType: 'task', objectId: t.id, actions: ['brief', 'open', 'snooze_1h'], link: personLink(t.person_id) });
      message = 'Напоминание отправлено исполнителю';
    } else {
      if (!can(ctx, P.crmViewAll)) throw badRequest('Передать задачу может руководитель');
      const to = await leastLoaded(db, t.club_id, t.assignee_id);
      if (!to) throw badRequest('В клубе нет другого менеджера');
      if (t.opportunity_id) await reassignOpenWork(db, { opportunityId: t.opportunity_id, from: t.assignee_id, to: to.id });
      else await db.query('update tasks set assignee_id = $2 where id = $1', [t.id, to.id]);
      await card(db, t.club_id, [to.id], { kind: 'agent_task', title: `Вам передана задача: ${t.title}`, body: t.person ? `Клиент: ${t.person}` : '',
        objectType: 'task', objectId: t.id, actions: ['brief', 'open'], link: personLink(t.person_id) });
      await audit(db, ctx, 'agent.task_reassigned', 'task', t.id, { assigneeId: t.assignee_id }, { assigneeId: to.id });
      message = `Передано: ${to.full_name}`;
    }
  }
  await db.query(`update staff_notifications set acted_at = now(), acted = $2, read_at = coalesce(read_at, now()) where id = $1`, [noteId, action]);
  return { ok: true, message };
}

export function agentReminderRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post('/api/agent/notifications/:id/action', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const { action } = (req.body ?? {}) as { action?: Action };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Уведомление не найдено');
    return withCtx(pool, ctx, (db) => doAction(db, ctx, id, action as Action));
  });

  app.get('/api/agent/settings', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!clubId || !(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Выберите клуб');
      return { ...(await agentSettings(db, clubId)), canEdit: can(ctx, P.tariffsManage) };
    });
  });

  // Бизнес-настройки клуба: собственник по любому клубу, управляющий по своему (право tariffs.manage)
  app.put('/api/agent/settings', async (req) => {
    const ctx = requirePerm(req, P.tariffsManage);
    const b = (req.body ?? {}) as Partial<AgentSettings> & { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      if (!b.clubId || !(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Выберите клуб');
      const cur = await agentSettings(db, b.clubId);
      const next = { ...cur };
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      for (const [k, [min, max]] of Object.entries(LIMITS) as [keyof typeof LIMITS, [number, number]][]) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!Number.isInteger(v) || v < min || v > max) throw badRequest(`Значение вне допустимых пределов (${min}–${max})`);
        next[k] = v;
      }
      if (!(next.taskRopMinutes < next.taskGmMinutes && next.taskGmMinutes < next.taskOwnerMinutes)) throw badRequest('Сроки лестницы должны расти: РОП → управляющий → собственник');
      await db.query(`insert into agent_settings(club_id, tenant_id, enabled, task_rop_minutes, task_gm_minutes, task_owner_minutes, reply_wait_minutes, lead_reassign_minutes, quiet_from, quiet_to, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (club_id) do update set enabled = $3, task_rop_minutes = $4, task_gm_minutes = $5, task_owner_minutes = $6,
        reply_wait_minutes = $7, lead_reassign_minutes = $8, quiet_from = $9, quiet_to = $10, updated_by = $11, updated_at = now()`,
      [b.clubId, ctx.tenantId, next.enabled, next.taskRopMinutes, next.taskGmMinutes, next.taskOwnerMinutes, next.replyWaitMinutes, next.leadReassignMinutes, next.quietFrom, next.quietTo, ctx.userId]);
      await audit(db, ctx, 'agent.settings', 'club', b.clubId, cur, next);
      return next;
    });
  });
}
