import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { createPool } from '../src/db.ts';
import { migrate } from '../db/scripts/migrate.ts';
import { seed } from '../db/scripts/seed.ts';

process.env.FISCAL_SECRET_KEY ||= 'test-fiscal-secret-key-0123456789';

const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

/** Поднимает чистую тестовую базу fitnes_test с тестовыми данными и возвращает приложение. */
export async function setupTestApp() {
  const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  const exists = await admin.query(`select 1 from pg_database where datname = 'fitnes_test'`);
  if (!exists.rowCount) await admin.query(`create database fitnes_test owner fitnes_owner encoding 'UTF8' template template0 locale_provider icu icu_locale 'ru-RU' locale 'C'`);
  await admin.end();
  const ownerUrl = withDb(process.env.OWNER_DATABASE_URL!, 'fitnes_test');
  const appUrl = withDb(process.env.DATABASE_URL!, 'fitnes_test');
  const o = new pg.Client({ connectionString: ownerUrl });
  await o.connect();
  await o.query('drop schema public cascade; create schema public;');
  await o.end();
  await migrate(ownerUrl, true);
  await seed(ownerUrl, true);
  const pool = createPool(appUrl);
  const app = await buildApp(pool, { storageDir: mkdtempSync(join(tmpdir(), 'fitnes-storage-')) });
  return { app, pool, ownerUrl };
}

export const PASSWORD = process.env.SEED_PASSWORD || 'Fitnes-2026';

export async function login(app: Awaited<ReturnType<typeof setupTestApp>>['app'], loginName: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: loginName, password } });
  const sid = res.cookies.find((c) => c.name === 'sid')?.value;
  return { res, cookie: sid ? { sid } : undefined };
}
