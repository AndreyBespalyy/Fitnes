// Применяет SQL-миграции по порядку (под владельцем схемы) и выдаёт права приложению.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { connect, need } from './common.ts';

export async function migrate(url = need('OWNER_DATABASE_URL'), quiet = false) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const c = await connect(url);
  await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await c.query('begin');
    try {
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('insert into schema_migrations(name) values ($1)', [f]);
      await c.query('commit');
      if (!quiet) console.log(`Применена миграция ${f}`);
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  }
  await c.query(`
    grant usage on schema public to fitnes_app;
    grant select, insert, update, delete on all tables in schema public to fitnes_app;
    revoke update, delete on audit_log from fitnes_app;
    revoke update, delete on price_versions, membership_operations from fitnes_app;
    revoke delete on charges, memberships, freezes from fitnes_app;
    revoke update, delete on files from fitnes_app;
    revoke delete on contracts, club_documents, legal_entities from fitnes_app;
    revoke insert, update, delete on schema_migrations, roles from fitnes_app;
    grant usage, select on all sequences in schema public to fitnes_app;
    grant execute on all functions in schema public to fitnes_app;
  `);
  await c.end();
  if (!quiet) console.log('Миграции применены');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await migrate();
