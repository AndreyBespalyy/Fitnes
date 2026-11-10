import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type pg from 'pg';
import { authRoutes, COOKIE, loadCtx } from './auth.ts';
import { HttpError } from './errors.ts';
import { clubRoutes } from './modules/clubs.ts';
import { personRoutes } from './modules/persons.ts';
import { crmRoutes } from './modules/crm.ts';
import { pipelineRoutes } from './modules/pipelines.ts';
import { staffRoutes } from './modules/staff.ts';
import { membershipRoutes } from './modules/memberships.ts';

export async function buildApp(pool: pg.Pool, opts: { webDist?: string; secureCookie?: boolean; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  await app.register(cookie);

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const loaded = await loadCtx(pool, req.cookies[COOKIE], req.ip);
    if (loaded) {
      req.ctx = loaded.ctx;
      req.mustChangePassword = loaded.mustChange;
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.code === '22P02') return reply.code(400).send({ error: 'bad_request', message: 'Неверный идентификатор' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка. Попробуйте ещё раз' });
  });

  app.get('/api/health', async () => {
    await pool.query('select 1');
    return { ok: true };
  });
  authRoutes(app, pool, { secureCookie: !!opts.secureCookie });
  clubRoutes(app, pool);
  staffRoutes(app, pool);
  personRoutes(app, pool);
  crmRoutes(app, pool);
  pipelineRoutes(app, pool);
  membershipRoutes(app, pool);

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fstatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Не найдено' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
