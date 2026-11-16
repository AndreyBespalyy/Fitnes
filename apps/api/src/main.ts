import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Не задана DATABASE_URL. Скопируйте .env.example в .env и заполните.');
  process.exit(1);
}
// Роль процесса (п. 11 списка улучшений): на сервере сайт и фоновые задачи — разные процессы,
// чтобы тяжёлый пересчёт или зависшая касса не тормозили ресепшн, а сайт можно было перезапускать, не прерывая списаний.
//   APP_ROLE=web    — только сайт и API (плюс «Состояние системы»: оно считает ошибки ответов этого процесса)
//   APP_ROLE=worker — только фоновые задачи: касса, автосписания, рассылки, ИИ, push, обзоры, напоминания
//   APP_ROLE=test   — тестовый стенд test.amoglobal.ru: только сайт, без фоновых задач и оповещений
//                     (его база — копия рабочей, в ней настоящие токены ботов и банков: стенд не должен ими пользоваться)
//   без APP_ROLE    — всё в одном процессе, как раньше (для запуска на своём компьютере)
const ROLES = ['web', 'worker', 'test'] as const;
const role = (ROLES as readonly string[]).includes(process.env.APP_ROLE ?? '') ? process.env.APP_ROLE as typeof ROLES[number] : 'all';
const bg = role === 'worker' || role === 'all';
const pool = createPool(url);
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const app = await buildApp(pool, {
  webDist, secureCookie: process.env.COOKIE_SECURE === '1', logger: true,
  monitorWorker: role === 'web' || role === 'all',
  fiscalWorker: bg, messagingWorker: bg, billingWorker: bg, aiWorker: bg, scoringWorker: bg, pushWorker: bg, insightsWorker: bg, scheduleWorker: bg,
  retentionWorker: bg, surveyWorker: bg, staffBotWorker: bg, salesOpsWorker: bg, teamPushWorker: bg, agentWorker: bg,
});

const stop = async (sig: string) => { console.log(`Клубная ОС (${role}): остановка по ${sig}`); await app.close().catch(() => null); await pool.end().catch(() => null); process.exit(0); };
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));

if (role === 'worker') {
  await app.ready();
  // Таймеры фоновых задач не держат процесс (unref), поэтому держим его сами
  setInterval(() => undefined, 1 << 30);
  console.log('Клубная ОС: фоновые задачи запущены');
} else {
  const port = Number(process.env.API_PORT || 3000);
  await app.listen({ port, host: process.env.API_HOST || '127.0.0.1' });
  console.log(`Клубная ОС: API запущен на http://localhost:${port}${role === 'web' ? ' (фоновые задачи — отдельным процессом)' : role === 'test' ? ' (тестовый стенд, без фоновых задач)' : ''}`);
}
