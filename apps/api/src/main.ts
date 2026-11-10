import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Не задана DATABASE_URL. Скопируйте .env.example в .env и заполните.');
  process.exit(1);
}
const pool = createPool(url);
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const app = await buildApp(pool, { webDist, secureCookie: process.env.COOKIE_SECURE === '1', logger: true, fiscalWorker: true, messagingWorker: true });
const port = Number(process.env.API_PORT || 3000);
await app.listen({ port, host: process.env.API_HOST || '127.0.0.1' });
console.log(`Клубная ОС: API запущен на http://localhost:${port}`);
