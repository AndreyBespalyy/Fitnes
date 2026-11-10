// CRM: лиды (вручную и через API), антидубли, назначение, сделки по воронкам, задачи, встречи, карточка клиента.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { can, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound, unauthorized } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';

/** Телефон в формат +7XXXXXXXXXX; null, если это не российский мобильный или городской номер. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d.length === 11 && d.startsWith('7') ? `+${d}` : null;
}
export const maskPhone = (p: string | null) => (p ? p.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1 $2 ***-**-$5') : null);

type Actor = { tenantId: string; userId: string | null; ip?: string };
export type LeadInput = {
  clubId?: string; fullName?: string; phone?: string; email?: string; sourceId?: string | null; sourceCode?: string;
  comment?: string; campaign?: string; utm?: Record<string, string>; externalEventId?: string; assignedTo?: string;
  contact?: { type: 'telegram' | 'whatsapp'; value: string; normalized: string }; // мессенджер без телефона (Telegram)
};

async function pickAssignee(db: Db, clubId: string): Promise<string | null> {
  const r = (await db.query(
    `select u.id from users u join user_assignments a on a.user_id = u.id
     where a.club_id = $1 and a.role_code = $2 and u.status = 'active'
     order by (select count(*) from opportunities o where o.owner_id = u.id and o.status = 'open'), u.created_at limit 1`, [clubId, 'manager'])).rows[0];
  if (r) return r.id;
  const rop = (await db.query(
    `select u.id from users u join user_assignments a on a.user_id = u.id where a.club_id = $1 and a.role_code = 'rop' and u.status = 'active' limit 1`, [clubId])).rows[0];
  return rop?.id ?? null;
}

async function firstOpenStage(db: Db, pipelineId: string) {
  return (await db.query(`select id from pipeline_stages where pipeline_id = $1 and kind = 'open' order by sort limit 1`, [pipelineId])).rows[0]?.id as string | undefined;
}

/** Создание лида: антидубли по телефону во всей сети, одна открытая сделка на клиента в клубе, назначение и задача первого ответа. */
export async function createLead(db: Db, actor: Actor, b: LeadInput) {
  if (!b.clubId) throw badRequest('Выберите клуб');
  const club = (await db.query('select id, first_response_minutes from clubs where id = $1', [b.clubId])).rows[0];
  if (!club) throw badRequest('Клуб не найден');
  const phone = normalizePhone(b.phone);
  if (b.phone && !phone) throw badRequest('Телефон указан неверно. Нужен номер вида +7 900 000-00-00');
  const email = b.email?.trim().toLowerCase() || null;
  if (!phone && !email && !b.contact) throw badRequest('Укажите телефон или e-mail');
  let sourceId = b.sourceId ?? null;
  if (!sourceId && b.sourceCode) sourceId = (await db.query('select id from lead_sources where code = $1', [b.sourceCode])).rows[0]?.id ?? null;
  if (!sourceId) throw badRequest('Укажите источник лида (откуда клиент узнал о клубе)', 'source_required');

  if (b.externalEventId) {
    const dup = (await db.query('select id, person_id, opportunity_id from leads where source_id = $1 and external_event_id = $2', [sourceId, b.externalEventId])).rows[0];
    if (dup) return { leadId: dup.id, personId: dup.person_id, opportunityId: dup.opportunity_id, duplicate: true, idempotent: true, otherClub: false };
  }

  let found: { person_id: string; home_club_id: string } | undefined;
  for (const v of [phone, email, b.contact?.normalized].filter((x): x is string => !!x)) {
    found = (await db.query('select * from find_person_by_contact($1, $2)', [actor.tenantId, v])).rows[0];
    if (found) break;
  }
  let personId: string;
  if (found) {
    personId = found.person_id;
  } else {
    const name = b.fullName?.trim() || 'Без имени';
    personId = (await db.query('insert into persons(tenant_id, home_club_id, full_name, segment) values ($1,$2,$3,$4) returning id',
      [actor.tenantId, b.clubId, name, 'лид'])).rows[0].id;
    if (phone) await db.query(`insert into person_contacts(tenant_id, person_id, type, value, normalized_value, is_primary) values ($1,$2,'phone',$3,$3,true)`, [actor.tenantId, personId, phone]);
    if (email) await db.query(`insert into person_contacts(tenant_id, person_id, type, value, normalized_value, is_primary) values ($1,$2,'email',$3,$3,$4)`, [actor.tenantId, personId, email, !phone]);
    if (b.contact) await db.query(`insert into person_contacts(tenant_id, person_id, type, value, normalized_value, is_primary) values ($1,$2,$3,$4,$5,$6)`,
      [actor.tenantId, personId, b.contact.type, b.contact.value, b.contact.normalized, !phone && !email]);
  }

  // Открытая сделка этого клиента в клубе используется повторно, вторая не создаётся
  let opp = (await db.query(`select id, owner_id from opportunities where person_id = $1 and club_id = $2 and status = 'open' order by created_at limit 1`, [personId, b.clubId])).rows[0];
  let assignee: string | null = null;
  if (b.assignedTo) {
    const ok = (await db.query(`select 1 from user_assignments a join users u on u.id = a.user_id where a.user_id = $1 and (a.club_id = $2 or a.club_id is null) and u.status = 'active'`, [b.assignedTo, b.clubId])).rowCount;
    if (!ok) throw badRequest('Ответственный не работает в этом клубе');
    assignee = b.assignedTo;
  }
  if (!opp) {
    const pipe = (await db.query('select id from pipelines where club_id = $1 and is_default_for_leads and is_active', [b.clubId])).rows[0];
    if (!pipe) throw badRequest('В клубе не выбрана воронка для новых лидов. Администратор настраивает её в разделе «Воронки»');
    const stage = await firstOpenStage(db, pipe.id);
    if (!stage) throw badRequest('В воронке для новых лидов нет рабочего этапа');
    assignee ??= await pickAssignee(db, b.clubId);
    opp = (await db.query(
      'insert into opportunities(tenant_id, club_id, person_id, pipeline_id, stage_id, owner_id) values ($1,$2,$3,$4,$5,$6) returning id, owner_id',
      [actor.tenantId, b.clubId, personId, pipe.id, stage, assignee])).rows[0];
    await db.query('insert into opportunity_stage_history(tenant_id, club_id, opportunity_id, from_stage_id, to_stage_id, actor_id, comment) values ($1,$2,$3,null,$4,$5,$6)',
      [actor.tenantId, b.clubId, opp.id, stage, actor.userId, 'Создана из лида']);
  } else {
    assignee ??= opp.owner_id ?? (await pickAssignee(db, b.clubId));
  }

  const dueAt = new Date(Date.now() + club.first_response_minutes * 60_000);
  const leadId = (await db.query(
    `insert into leads(tenant_id, club_id, person_id, source_id, opportunity_id, campaign, utm, comment, external_event_id, is_repeat, assigned_to, first_response_due_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [actor.tenantId, b.clubId, personId, sourceId, opp.id, b.campaign || null, b.utm ? JSON.stringify(b.utm) : null, b.comment?.trim() || null,
      b.externalEventId || null, !!found, assignee, dueAt, actor.userId])).rows[0].id;
  await db.query(
    `insert into tasks(tenant_id, club_id, assignee_id, person_id, opportunity_id, lead_id, kind, title, due_at, created_by)
     values ($1,$2,$3,$4,$5,$6,'first_response',$7,$8,$9)`,
    [actor.tenantId, b.clubId, assignee, personId, opp.id, leadId, found ? 'Повторное обращение: связаться' : 'Первый ответ новому лиду', dueAt, actor.userId]);
  await audit(db, { tenantId: actor.tenantId, userId: actor.userId, ip: actor.ip }, 'lead.created', 'lead', leadId, null,
    { personId, opportunityId: opp.id, duplicate: !!found, sourceId, assignee });
  return { leadId, personId, opportunityId: opp.id, duplicate: !!found, idempotent: false, otherClub: !!found && found.home_club_id !== b.clubId };
}

const onlyMine = (ctx: Ctx) => !can(ctx, P.crmViewAll);

async function loadOpp(db: Db, ctx: Ctx, id: string) {
  const o = (await db.query(
    `select o.*, s.kind as stage_kind from opportunities o join pipeline_stages s on s.id = o.stage_id where o.id = $1`, [id])).rows[0];
  if (!o) throw notFound('Сделка не найдена');
  if (onlyMine(ctx) && o.owner_id !== ctx.userId) throw notFound('Сделка не найдена');
  return o;
}

type NextTask = { title?: string; dueAt?: string; kind?: string };
async function addTask(db: Db, ctx: Ctx, o: { id: string; club_id: string; person_id: string; owner_id: string | null }, t: NextTask) {
  const title = t.title?.trim();
  if (!title) throw badRequest('Укажите, что нужно сделать');
  const due = t.dueAt ? new Date(t.dueAt) : null;
  if (!due || Number.isNaN(due.getTime())) throw badRequest('Укажите дату и время задачи');
  const kind = ['call', 'meeting', 'message', 'other'].includes(t.kind ?? '') ? t.kind : 'call';
  return (await db.query(
    `insert into tasks(tenant_id, club_id, assignee_id, person_id, opportunity_id, kind, title, due_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, o.club_id, o.owner_id ?? ctx.userId, o.person_id, o.id, kind, title, due, ctx.userId])).rows[0].id as string;
}

const TASK_SELECT = `select t.id, t.kind, t.title, t.due_at as "dueAt", t.done_at as "doneAt", t.result, t.club_id as "clubId",
  t.person_id as "personId", p.full_name as "personName", t.opportunity_id as "opportunityId", t.assignee_id as "assigneeId",
  u.full_name as "assigneeName", (t.done_at is null and t.due_at < now()) as overdue
  from tasks t left join persons p on p.id = t.person_id left join users u on u.id = t.assignee_id`;

export function crmRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Лиды
  app.post('/api/leads', async (req, reply) => {
    const ctx = requirePerm(req, P.leadsCreate);
    const res = await withCtx(pool, ctx, (db) => createLead(db, ctx, (req.body ?? {}) as LeadInput));
    reply.code(201);
    return res;
  });

  app.get('/api/leads', async (req) => {
    const ctx = requirePerm(req, P.leadsCreate);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select l.id, l.created_at as "createdAt", l.club_id as "clubId", c.name as "clubName", p.id as "personId", p.full_name as "personName",
         s.name as "sourceName", l.comment, l.is_repeat as "isRepeat", u.full_name as "assigneeName",
         l.first_response_due_at as "dueAt", l.first_response_at as "respondedAt",
         case when l.first_response_at is not null then (case when l.first_response_at <= l.first_response_due_at then 'in_time' else 'late' end)
              when now() > l.first_response_due_at then 'overdue' else 'waiting' end as "responseState"
       from leads l join persons p on p.id = l.person_id join clubs c on c.id = l.club_id
       left join lead_sources s on s.id = l.source_id left join users u on u.id = l.assigned_to
       where ($1::uuid is null or l.club_id = $1) and ($2::uuid is null or l.assigned_to = $2)
       order by l.created_at desc limit 200`, [clubId || null, onlyMine(ctx) && can(ctx, P.crmWork) ? ctx.userId : null])).rows);
  });

  // Приём заявок от сайта и других источников: Authorization: Bearer <ключ источника>
  app.post('/api/v1/leads', async (req: FastifyRequest, reply) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw unauthorized('Нужен ключ источника');
    const src = (await pool.query('select * from auth_lead_source($1)', [createHash('sha256').update(token).digest('hex')])).rows[0];
    if (!src) throw unauthorized('Ключ источника не найден или отключён');
    const b = (req.body ?? {}) as LeadInput;
    const res = await withCtx(pool, { tenantId: src.tenant_id, allClubs: true, clubIds: [] }, (db) =>
      createLead(db, { tenantId: src.tenant_id, userId: null, ip: req.ip }, { ...b, sourceId: src.source_id, assignedTo: undefined }));
    reply.code(res.idempotent ? 200 : 201);
    return { leadId: res.leadId, duplicate: res.duplicate };
  });

  // Карточка клиента на одной странице
  app.get('/api/persons/:id', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const person = (await db.query(
        `select p.id, p.full_name as "fullName", p.birth_date as "birthDate", p.segment, p.home_club_id as "homeClubId", c.name as "homeClubName", p.created_at as "createdAt",
           p.autopay_enabled as "autopayEnabled", p.autopay_changed_at as "autopayChangedAt",
           p.marketing_consent as "marketingConsent", p.messaging_opt_out as "messagingOptOut"
         from persons p left join clubs c on c.id = p.home_club_id where p.id = $1`, [id])).rows[0];
      if (!person) throw notFound('Клиент не найден');
      const contacts = (await db.query('select type, value, is_primary as "isPrimary" from person_contacts where person_id = $1 order by is_primary desc', [id])).rows
        .map((c) => ({ ...c, value: c.type === 'phone' ? maskPhone(c.value) : c.value }));
      const leads = (await db.query(
        `select l.id, l.created_at as "createdAt", s.name as "sourceName", l.comment, l.is_repeat as "isRepeat", c.name as "clubName",
           l.first_response_due_at as "dueAt", l.first_response_at as "respondedAt"
         from leads l left join lead_sources s on s.id = l.source_id join clubs c on c.id = l.club_id where l.person_id = $1 order by l.created_at desc`, [id])).rows;
      const opps = (await db.query(
        `select o.id, o.status, o.club_id as "clubId", c.name as "clubName", o.pipeline_id as "pipelineId", pl.name as "pipelineName",
           o.stage_id as "stageId", s.name as "stageName", o.owner_id as "ownerId", u.full_name as "ownerName", o.lost_reason as "lostReason",
           o.created_at as "createdAt", o.closed_at as "closedAt",
           (select json_agg(json_build_object('id', st.id, 'name', st.name, 'kind', st.kind) order by st.sort) from pipeline_stages st where st.pipeline_id = o.pipeline_id) as stages
         from opportunities o join pipelines pl on pl.id = o.pipeline_id join pipeline_stages s on s.id = o.stage_id join clubs c on c.id = o.club_id
         left join users u on u.id = o.owner_id where o.person_id = $1 order by (o.status = 'open') desc, o.created_at desc`, [id])).rows;
      const tasks = (await db.query(`${TASK_SELECT} where t.person_id = $1 order by (t.done_at is null) desc, t.due_at desc limit 50`, [id])).rows;
      const meetings = (await db.query(
        `select m.id, m.scheduled_at as "scheduledAt", m.status, m.opportunity_id as "opportunityId" from meetings m where m.person_id = $1 order by m.scheduled_at desc`, [id])).rows;
      const history = (await db.query(
        `select h.at, fs.name as "fromStage", ts.name as "toStage", u.full_name as "actorName", h.comment
         from opportunity_stage_history h join opportunities o on o.id = h.opportunity_id
         left join pipeline_stages fs on fs.id = h.from_stage_id join pipeline_stages ts on ts.id = h.to_stage_id left join users u on u.id = h.actor_id
         where o.person_id = $1 order by h.at desc limit 50`, [id])).rows;
      return { person, contacts, leads, opportunities: opps, tasks, meetings, history };
    });
  });

  // Сделки
  app.get('/api/opportunities', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { pipelineId, status } = req.query as { pipelineId?: string; status?: string };
    if (!pipelineId) throw badRequest('Выберите воронку');
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select o.id, o.stage_id as "stageId", o.status, p.id as "personId", p.full_name as "personName", u.full_name as "ownerName", o.owner_id as "ownerId",
         o.updated_at as "updatedAt",
         (select min(t.due_at) from tasks t where t.opportunity_id = o.id and t.done_at is null) as "nextTaskAt",
         exists (select 1 from tasks t where t.opportunity_id = o.id and t.done_at is null and t.due_at < now()) as overdue
       from opportunities o join persons p on p.id = o.person_id left join users u on u.id = o.owner_id
       where o.pipeline_id = $1 and o.status = coalesce($2, 'open') and ($3::uuid is null or o.owner_id = $3)
       order by o.updated_at desc limit 500`, [pipelineId, status || null, onlyMine(ctx) ? ctx.userId : null])).rows);
  });

  app.post('/api/opportunities/:id/stage', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { stageId?: string; lostReason?: string; comment?: string; nextTask?: NextTask };
    return withCtx(pool, ctx, async (db) => {
      const o = await loadOpp(db, ctx, id);
      if (o.status !== 'open') throw badRequest('Сделка уже закрыта');
      const stage = (await db.query('select id, name, kind from pipeline_stages where id = $1 and pipeline_id = $2', [b.stageId, o.pipeline_id])).rows[0];
      if (!stage) throw badRequest('Этап не из этой воронки');
      if (stage.id === o.stage_id) throw badRequest('Сделка уже на этом этапе');
      if (stage.kind === 'lost' && !b.lostReason?.trim()) throw badRequest('Укажите причину отказа', 'lost_reason_required');
      if (stage.kind === 'open') {
        if (b.nextTask) await addTask(db, ctx, o, b.nextTask);
        const open = (await db.query('select count(*)::int as n from tasks where opportunity_id = $1 and done_at is null', [id])).rows[0].n;
        if (!open) throw badRequest('Поставьте следующую задачу: у сделки в работе всегда должен быть следующий шаг', 'next_task_required');
        await db.query('update opportunities set stage_id = $2, updated_at = now() where id = $1', [id, stage.id]);
      } else {
        await db.query(`update opportunities set stage_id = $2, status = $3, lost_reason = $4, closed_at = now(), updated_at = now() where id = $1`,
          [id, stage.id, stage.kind, stage.kind === 'lost' ? b.lostReason!.trim() : null]);
        await db.query(`update tasks set done_at = now(), result = $2 where opportunity_id = $1 and done_at is null`, [id, `Сделка закрыта: ${stage.name}`]);
        if (stage.kind === 'won') await db.query(`update persons set segment = 'новый', updated_at = now() where id = $1 and segment = 'лид'`, [o.person_id]);
      }
      await db.query('insert into opportunity_stage_history(tenant_id, club_id, opportunity_id, from_stage_id, to_stage_id, actor_id, comment) values ($1,$2,$3,$4,$5,$6,$7)',
        [ctx.tenantId, o.club_id, id, o.stage_id, stage.id, ctx.userId, b.comment?.trim() || b.lostReason?.trim() || null]);
      await audit(db, ctx, 'opportunity.stage_changed', 'opportunity', id, { stageId: o.stage_id }, { stageId: stage.id, status: stage.kind === 'open' ? 'open' : stage.kind });
      return { ok: true, status: stage.kind === 'open' ? 'open' : stage.kind };
    });
  });

  app.post('/api/opportunities/:id/owner', async (req) => {
    const ctx = requirePerm(req, P.crmViewAll);
    const { id } = req.params as { id: string };
    const { ownerId } = (req.body ?? {}) as { ownerId?: string };
    return withCtx(pool, ctx, async (db) => {
      const o = await loadOpp(db, ctx, id);
      const ok = (await db.query(`select 1 from user_assignments a join users u on u.id = a.user_id where a.user_id = $1 and a.club_id = $2 and u.status = 'active'`, [ownerId, o.club_id])).rowCount;
      if (!ok) throw badRequest('Сотрудник не работает в этом клубе');
      await db.query('update opportunities set owner_id = $2, updated_at = now() where id = $1', [id, ownerId]);
      await db.query('update tasks set assignee_id = $2 where opportunity_id = $1 and done_at is null', [id, ownerId]);
      await audit(db, ctx, 'opportunity.owner_changed', 'opportunity', id, { ownerId: o.owner_id }, { ownerId });
      return { ok: true };
    });
  });

  // Задачи
  app.get('/api/tasks', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId, scope } = req.query as { clubId?: string; scope?: string };
    const mine = scope !== 'all' || onlyMine(ctx);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `${TASK_SELECT} where t.done_at is null and ($1::uuid is null or t.club_id = $1) and ($2::uuid is null or t.assignee_id = $2)
       order by t.due_at limit 300`, [clubId || null, mine ? ctx.userId : null])).rows);
  });

  app.post('/api/tasks', async (req, reply) => {
    const ctx = requirePerm(req, P.crmWork);
    const b = (req.body ?? {}) as NextTask & { opportunityId?: string };
    const id = await withCtx(pool, ctx, async (db) => {
      const o = await loadOpp(db, ctx, b.opportunityId ?? '');
      if (o.status !== 'open') throw badRequest('Сделка закрыта');
      const tid = await addTask(db, ctx, o, b);
      await audit(db, ctx, 'task.created', 'task', tid, null, b);
      return tid;
    });
    reply.code(201);
    return { id };
  });

  app.post('/api/tasks/:id/complete', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { result?: string; nextTask?: NextTask };
    return withCtx(pool, ctx, async (db) => {
      const t = (await db.query('select * from tasks where id = $1', [id])).rows[0];
      if (!t || (onlyMine(ctx) && t.assignee_id !== ctx.userId)) throw notFound('Задача не найдена');
      if (t.done_at) throw badRequest('Задача уже выполнена');
      if (!b.result?.trim()) throw badRequest('Коротко напишите результат');
      if (t.opportunity_id) {
        const o = (await db.query('select * from opportunities where id = $1', [t.opportunity_id])).rows[0];
        if (o?.status === 'open') {
          if (b.nextTask) await addTask(db, ctx, o, b.nextTask);
          const others = (await db.query('select count(*)::int as n from tasks where opportunity_id = $1 and done_at is null and id <> $2', [o.id, id])).rows[0].n;
          if (!others) throw badRequest('Нельзя закрыть задачу без следующего шага: поставьте новую задачу или закройте сделку', 'next_task_required');
        }
      }
      await db.query('update tasks set done_at = now(), result = $2 where id = $1', [id, b.result.trim()]);
      if (t.lead_id) await db.query('update leads set first_response_at = coalesce(first_response_at, now()) where id = $1', [t.lead_id]);
      else if (t.opportunity_id) await db.query('update leads set first_response_at = now() where opportunity_id = $1 and first_response_at is null', [t.opportunity_id]);
      await audit(db, ctx, 'task.completed', 'task', id, null, { result: b.result.trim() });
      return { ok: true };
    });
  });

  // Встречи
  app.post('/api/meetings', async (req, reply) => {
    const ctx = requirePerm(req, P.crmWork);
    const b = (req.body ?? {}) as { opportunityId?: string; scheduledAt?: string };
    const res = await withCtx(pool, ctx, async (db) => {
      const o = await loadOpp(db, ctx, b.opportunityId ?? '');
      if (o.status !== 'open') throw badRequest('Сделка закрыта');
      const at = b.scheduledAt ? new Date(b.scheduledAt) : null;
      if (!at || Number.isNaN(at.getTime())) throw badRequest('Укажите дату и время встречи');
      const mid = (await db.query('insert into meetings(tenant_id, club_id, opportunity_id, person_id, scheduled_at, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
        [ctx.tenantId, o.club_id, o.id, o.person_id, at, ctx.userId])).rows[0].id;
      await addTask(db, ctx, o, { title: 'Встреча в клубе', dueAt: at.toISOString(), kind: 'meeting' });
      await audit(db, ctx, 'meeting.created', 'meeting', mid, null, { scheduledAt: at });
      return { id: mid };
    });
    reply.code(201);
    return res;
  });

  app.post('/api/meetings/:id/status', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (!['attended', 'no_show', 'cancelled'].includes(status ?? '')) throw badRequest('Неизвестный статус встречи');
    return withCtx(pool, ctx, async (db) => {
      const m = (await db.query('select * from meetings where id = $1', [id])).rows[0];
      if (!m) throw notFound('Встреча не найдена');
      if (m.opportunity_id) await loadOpp(db, ctx, m.opportunity_id);
      await db.query('update meetings set status = $2, updated_at = now() where id = $1', [id, status]);
      await audit(db, ctx, 'meeting.status', 'meeting', id, { status: m.status }, { status });
      return { ok: true };
    });
  });
}
