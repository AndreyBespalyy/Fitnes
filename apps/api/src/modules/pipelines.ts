// Воронки и этапы (настраивает администратор), источники лидов и их ключи API.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';

type StageIn = { id?: string; name?: string; kind?: string };

function validateStages(stages: StageIn[] | undefined) {
  if (!Array.isArray(stages) || stages.length < 3) throw badRequest('В воронке должно быть не меньше трёх этапов: рабочий, успешный и отказ');
  const names = new Set<string>();
  for (const s of stages) {
    const name = s.name?.trim();
    if (!name) throw badRequest('У каждого этапа должно быть название');
    if (!['open', 'won', 'lost'].includes(s.kind ?? '')) throw badRequest(`Неизвестный тип этапа «${name}»`);
    if (names.has(name.toLowerCase())) throw badRequest(`Этап «${name}» повторяется`);
    names.add(name.toLowerCase());
  }
  if (!stages.some((s) => s.kind === 'open')) throw badRequest('Нужен хотя бы один рабочий этап');
  if (!stages.some((s) => s.kind === 'won')) throw badRequest('Нужен этап успешного завершения (например, «Купил»)');
  if (!stages.some((s) => s.kind === 'lost')) throw badRequest('Нужен этап отказа');
  if (stages[0].kind !== 'open') throw badRequest('Первый этап должен быть рабочим: с него начинаются новые сделки');
}

export async function listPipelines(db: Db, clubId?: string) {
  const rows = (await db.query(
    `select p.id, p.club_id as "clubId", p.name, p.purpose, p.is_default_for_leads as "isDefaultForLeads", p.is_active as "isActive", p.sort,
       coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'sort', s.sort,
           'openCount', (select count(*)::int from opportunities o where o.stage_id = s.id and o.status = 'open')) order by s.sort)
         from pipeline_stages s where s.pipeline_id = p.id), '[]') as stages
     from pipelines p where ($1::uuid is null or p.club_id = $1) order by p.club_id, p.sort, p.name`, [clubId || null])).rows;
  return rows;
}

async function writeStages(db: Db, tenantId: string, pipelineId: string, stages: StageIn[]) {
  const existing = (await db.query('select id, name from pipeline_stages where pipeline_id = $1', [pipelineId])).rows as { id: string; name: string }[];
  const keep = new Set(stages.filter((s) => s.id).map((s) => s.id));
  for (const s of stages) if (s.id && !existing.some((e) => e.id === s.id)) throw badRequest('Этап не принадлежит этой воронке');
  for (const e of existing.filter((e) => !keep.has(e.id))) {
    const used = (await db.query('select count(*)::int as n from opportunities where stage_id = $1', [e.id])).rows[0].n;
    const hist = (await db.query('select count(*)::int as n from opportunity_stage_history where to_stage_id = $1 or from_stage_id = $1', [e.id])).rows[0].n;
    if (used) throw badRequest(`Этап «${e.name}» используется в сделках (${used}). Сначала перенесите их на другой этап`);
    if (hist) throw badRequest(`Этап «${e.name}» есть в истории сделок, его нельзя удалить. Переименуйте его или оставьте`);
    await db.query('delete from pipeline_stages where id = $1', [e.id]);
  }
  for (const [i, s] of stages.entries()) {
    if (s.id) await db.query('update pipeline_stages set name = $2, kind = $3, sort = $4 where id = $1', [s.id, s.name!.trim(), s.kind, i]);
    else await db.query('insert into pipeline_stages(tenant_id, pipeline_id, name, kind, sort) values ($1,$2,$3,$4,$5)', [tenantId, pipelineId, s.name!.trim(), s.kind, i]);
  }
  // У открытых сделок этап должен оставаться рабочим
  const bad = (await db.query(
    `select count(*)::int as n from opportunities o join pipeline_stages s on s.id = o.stage_id where o.pipeline_id = $1 and o.status = 'open' and s.kind <> 'open'`, [pipelineId])).rows[0].n;
  if (bad) throw badRequest('Нельзя сделать завершающим этап, на котором стоят открытые сделки');
}

export function pipelineRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/pipelines', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, (db) => listPipelines(db, clubId));
  });

  app.post('/api/pipelines', async (req, reply) => {
    const ctx = requirePerm(req, P.pipelinesManage);
    const b = (req.body ?? {}) as { clubId?: string; name?: string; stages?: StageIn[] };
    const name = b.name?.trim();
    if (!b.clubId) throw badRequest('Выберите клуб');
    if (!name) throw badRequest('Укажите название воронки');
    validateStages(b.stages);
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      if ((await db.query('select 1 from pipelines where club_id = $1 and lower(name) = lower($2)', [b.clubId, name])).rowCount) throw badRequest('Воронка с таким названием уже есть');
      const sort = (await db.query('select coalesce(max(sort), -1) + 1 as s from pipelines where club_id = $1', [b.clubId])).rows[0].s;
      const id = (await db.query('insert into pipelines(tenant_id, club_id, name, sort) values ($1,$2,$3,$4) returning id', [ctx.tenantId, b.clubId, name, sort])).rows[0].id;
      await writeStages(db, ctx.tenantId, id, b.stages!);
      const p = (await listPipelines(db, b.clubId)).find((x) => x.id === id);
      await audit(db, ctx, 'pipeline.created', 'pipeline', id, null, p);
      return p;
    });
    reply.code(201);
    return res;
  });

  app.patch('/api/pipelines/:id', async (req) => {
    const ctx = requirePerm(req, P.pipelinesManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; isActive?: boolean; isDefaultForLeads?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const before = (await db.query('select * from pipelines where id = $1', [id])).rows[0];
      if (!before) throw notFound('Воронка не найдена');
      if (b.name !== undefined && !b.name.trim()) throw badRequest('Название не может быть пустым');
      if (b.isActive === false && before.is_default_for_leads) throw badRequest('Нельзя отключить воронку, в которую попадают новые лиды. Сначала назначьте другую');
      if (b.isDefaultForLeads) await db.query('update pipelines set is_default_for_leads = false where club_id = $1', [before.club_id]);
      await db.query(
        `update pipelines set name = coalesce($2, name), is_active = coalesce($3, is_active),
           is_default_for_leads = case when $4::boolean then true else is_default_for_leads end, updated_at = now() where id = $1`,
        [id, b.name?.trim() ?? null, b.isActive ?? null, b.isDefaultForLeads ?? false]);
      const after = (await listPipelines(db, before.club_id)).find((x) => x.id === id);
      await audit(db, ctx, 'pipeline.updated', 'pipeline', id, before, after);
      return after;
    });
  });

  app.put('/api/pipelines/:id/stages', async (req) => {
    const ctx = requirePerm(req, P.pipelinesManage);
    const { id } = req.params as { id: string };
    const { stages } = (req.body ?? {}) as { stages?: StageIn[] };
    validateStages(stages);
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select club_id from pipelines where id = $1', [id])).rows[0];
      if (!p) throw notFound('Воронка не найдена');
      const before = (await listPipelines(db, p.club_id)).find((x) => x.id === id);
      await writeStages(db, ctx.tenantId, id, stages!);
      const after = (await listPipelines(db, p.club_id)).find((x) => x.id === id);
      await audit(db, ctx, 'pipeline.stages_changed', 'pipeline', id, before?.stages, after?.stages);
      return after;
    });
  });

  // Источники лидов
  app.get('/api/lead-sources', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select id, code, name, channel, is_active as "isActive", api_token_hash is not null as "hasApiKey" from lead_sources order by created_at`)).rows);
  });

  app.post('/api/lead-sources', async (req, reply) => {
    const ctx = requirePerm(req, P.sourcesManage);
    const b = (req.body ?? {}) as { name?: string; channel?: string };
    const name = b.name?.trim();
    if (!name) throw badRequest('Укажите название источника');
    const res = await withCtx(pool, ctx, async (db) => {
      const code = `custom_${randomBytes(4).toString('hex')}`;
      const row = (await db.query('insert into lead_sources(tenant_id, code, name, channel) values ($1,$2,$3,$4) returning id, code, name, channel',
        [ctx.tenantId, code, name, b.channel || 'other'])).rows[0];
      await audit(db, ctx, 'lead_source.created', 'lead_source', row.id, null, row);
      return row;
    });
    reply.code(201);
    return res;
  });

  app.post('/api/lead-sources/:id/api-key', async (req) => {
    const ctx = requirePerm(req, P.sourcesManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query('select id, name from lead_sources where id = $1', [id])).rows[0];
      if (!s) throw notFound('Источник не найден');
      const key = `ls_${randomBytes(24).toString('base64url')}`;
      await db.query('update lead_sources set api_token_hash = $2 where id = $1', [id, createHash('sha256').update(key).digest('hex')]);
      await audit(db, ctx, 'lead_source.api_key_issued', 'lead_source', id, null, null);
      return { source: s.name, apiKey: key };
    });
  });
}
