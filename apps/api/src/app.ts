import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type pg from 'pg';
import { authRoutes, COOKIE, loadCtx } from './auth.ts';
import { HttpError } from './errors.ts';
import { audit, withCtx } from './db.ts';
import { clubRoutes } from './modules/clubs.ts';
import { personRoutes } from './modules/persons.ts';
import { crmRoutes } from './modules/crm.ts';
import { pipelineRoutes } from './modules/pipelines.ts';
import { staffRoutes } from './modules/staff.ts';
import { membershipRoutes } from './modules/memberships.ts';
import { contractRoutes } from './modules/contracts.ts';
import { siteRoutes } from './modules/site.ts';
import { fiscalRoutes, startFiscalWorker } from './modules/fiscal.ts';
import { financeRoutes } from './modules/finance.ts';
import { importRoutes } from './modules/import.ts';
import { messagingRoutes, startMessagingWorker } from './modules/messaging.ts';
import { acsRoutes } from './modules/acs.ts';
import { billingRoutes, startBillingWorker } from './modules/billing.ts';
import { bankRoutes } from './modules/bank.ts';
import { dashRoutes } from './modules/dash.ts';
import { aiRoutes, startAiWorker } from './modules/ai.ts';
import { aiSalesRoutes, startScoringWorker } from './modules/aiSales.ts';
import { staffTimeRoutes } from './modules/staffTime.ts';
import { configRoutes } from './modules/config.ts';
import { insightsRoutes, startInsightsWorker } from './modules/insights.ts';
import { onboardingRoutes } from './modules/onboarding.ts';
import { scheduleRoutes, startScheduleWorker } from './modules/schedule.ts';
import { retentionRoutes, startRetentionWorker } from './modules/retention.ts';
import { startSurveyWorker, surveyRoutes } from './modules/surveys.ts';
import { promoRoutes } from './modules/promos.ts';
import { newbieRoutes } from './modules/newbie.ts';
import { churnRoutes } from './modules/churn.ts';
import { staffBotRoutes } from './modules/staffBot.ts';
import { morningRoutes, startStaffBotWorker } from './modules/morning.ts';
import { mobileRoutes, startPushWorker } from './modules/mobile.ts';
import { aiConfigFromEnv, type AiConfig } from './lib/aiClient.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildApp(pool: pg.Pool, opts: { webDist?: string; secureCookie?: boolean; logger?: boolean; storageDir?: string; fiscalWorker?: boolean; messagingWorker?: boolean; billingWorker?: boolean; aiWorker?: boolean; scoringWorker?: boolean; pushWorker?: boolean; insightsWorker?: boolean; scheduleWorker?: boolean; retentionWorker?: boolean; surveyWorker?: boolean; staffBotWorker?: boolean; ai?: AiConfig | null; fetch?: typeof fetch } = {}) {
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

  // Заголовки безопасности (шаг 17): запрет встраивания чужими сайтами, только свои скрипты, без угадывания типов файлов
  const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self' http: https:", "frame-src 'self'", "frame-ancestors 'self'", "object-src 'none'",
    "base-uri 'self'", "form-action 'self'", "worker-src 'self'", "manifest-src 'self'"].join('; ');
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (opts.secureCookie) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    else reply.header('Content-Security-Policy', CSP);
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.audit) {
        const a = err.audit;
        await withCtx(pool, a.ctx, (db) => audit(db, a.ctx, a.action, a.objectType, a.objectId, null, a.after)).catch((e) => req.log.error(e));
      }
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
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
  // Файлы (PDF договоров, сканы, подписи) лежат на диске; путь задаётся STORAGE_DIR, по умолчанию папка storage в корне проекта
  const storage = opts.storageDir ?? process.env.STORAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'storage');
  contractRoutes(app, pool, storage);
  siteRoutes(app, pool, storage);
  fiscalRoutes(app, pool, { fetch: opts.fetch });
  financeRoutes(app, pool);
  importRoutes(app, pool);
  messagingRoutes(app, pool, { fetch: opts.fetch });
  acsRoutes(app, pool);
  billingRoutes(app, pool, { fetch: opts.fetch });
  bankRoutes(app, pool);
  dashRoutes(app, pool);
  // ИИ-сервер (свой, внутренний): AI_URL и AI_TOKEN. Без него записи ждут, итог можно написать вручную
  const ai = opts.ai !== undefined ? opts.ai : aiConfigFromEnv(opts.fetch ?? fetch);
  aiRoutes(app, pool, storage, ai);
  aiSalesRoutes(app, pool);
  mobileRoutes(app, pool, { fetch: opts.fetch });
  staffTimeRoutes(app, pool);
  configRoutes(app, pool);
  insightsRoutes(app, pool);
  onboardingRoutes(app, pool);
  scheduleRoutes(app, pool, { fetch: opts.fetch });
  retentionRoutes(app, pool, { fetch: opts.fetch });
  surveyRoutes(app, pool);
  promoRoutes(app, pool);
  newbieRoutes(app, pool);
  churnRoutes(app, pool, { fetch: opts.fetch });
  staffBotRoutes(app, pool, { fetch: opts.fetch });
  morningRoutes(app, pool, { fetch: opts.fetch });
  // Фоновая отправка чеков в облачную кассу (в тестах выключена, там вызывается напрямую)
  if (opts.messagingWorker) { const stop = startMessagingWorker(pool, opts.fetch); app.addHook('onClose', async () => stop()); }
  if (opts.billingWorker) { const stop = startBillingWorker(pool, opts.fetch); app.addHook('onClose', async () => stop()); }
  if (opts.scheduleWorker) { const stop = startScheduleWorker(pool, opts.fetch ?? fetch); app.addHook('onClose', async () => stop()); }
  if (opts.staffBotWorker) { const stop = startStaffBotWorker(pool, opts.fetch ?? fetch); app.addHook('onClose', async () => stop()); }
  if (opts.surveyWorker) { const stop = startSurveyWorker(pool, opts.fetch ?? fetch); app.addHook('onClose', async () => stop()); }
  if (opts.retentionWorker) { const stop = startRetentionWorker(pool, opts.fetch ?? fetch); app.addHook('onClose', async () => stop()); }
  if (opts.pushWorker) { const stop = startPushWorker(pool, opts.fetch ?? fetch); app.addHook('onClose', async () => stop()); }
  if (opts.scoringWorker) { const stop = startScoringWorker(pool); app.addHook('onClose', async () => stop()); }
  if (opts.aiWorker) { const stop = startAiWorker(pool, ai, storage); app.addHook('onClose', async () => stop()); }
  if (opts.insightsWorker) { const stop = startInsightsWorker(pool, ai); app.addHook('onClose', async () => stop()); }
  if (opts.fiscalWorker) { const stop = startFiscalWorker(pool); app.addHook('onClose', async () => stop()); }

  if (opts.webDist && existsSync(opts.webDist)) {
    // Служебный файл приложения (sw.js), манифест и index.html не кэшируются, чтобы обновления доходили до телефонов сразу
    await app.register(fstatic, {
      root: opts.webDist,
      cacheControl: false,
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
        if (path.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Не найдено' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
