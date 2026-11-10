// Применяет SQL-миграции по порядку (под владельцем схемы) и выдаёт права приложению.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { connect, need } from './common.ts';
import { ROLE_SEED } from '../../src/roles.ts';
import { seedDemoHistory } from './demoHistory.ts';
import { seedDemoCalls } from './demoCalls.ts';
import type { Db } from '../../src/db.ts';

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
  // Роли и их разрешения всегда соответствуют коду: новые разрешения появляются на сервере сами при обновлении
  for (const r of ROLE_SEED) {
    await c.query(`insert into roles(code, name, permissions, network_wide, sort) values ($1,$2,$3,$4,$5)
      on conflict (code) do update set name = excluded.name, permissions = excluded.permissions, network_wide = excluded.network_wide, sort = excluded.sort`,
    [r.code, r.name, r.permissions, r.network_wide, r.sort]);
  }
  await c.query(`
    grant usage on schema public to fitnes_app;
    grant select, insert, update, delete on all tables in schema public to fitnes_app;
    revoke update, delete on audit_log from fitnes_app;
    revoke update, delete on price_versions, membership_operations from fitnes_app;
    revoke delete on charges, memberships, freezes from fitnes_app;
    revoke update, delete on files from fitnes_app;
    revoke delete on contracts, club_documents, legal_entities from fitnes_app;
    revoke delete on receipts from fitnes_app;
    revoke update, delete on payments from fitnes_app;
    revoke delete on cash_shifts, approvals, refunds, expenses from fitnes_app;
    revoke insert, update, delete on expense_categories from fitnes_app;
    revoke delete on visits, import_batches, import_external_ids from fitnes_app;
    revoke update on import_external_ids from fitnes_app;
    revoke delete on msg_conversations, msg_messages, msg_trigger_sends from fitnes_app;
    revoke update, delete on access_events from fitnes_app;
    revoke delete on online_payments, person_payment_methods, bank_statements, bank_lines from fitnes_app;
    revoke delete on access_credentials, access_gateways, access_points, access_commands from fitnes_app;
    revoke insert, update, delete on schema_migrations, roles, tenant_contracts from fitnes_app;
    revoke delete on support_tickets, support_messages from fitnes_app;
    grant usage, select on all sequences in schema public to fitnes_app;
    grant execute on all functions in schema public to fitnes_app;
  `);
  // Демо-сеть, заполненная до шага 13, один раз получает историю продаж для дашбордов
  const demo = (await c.query(`select id from tenants where name = 'Демо-сеть клубов' limit 1`)).rows[0];
  if (demo) {
    await c.query('begin');
    try { if (await seedDemoHistory(c as unknown as Db, demo.id) && !quiet) console.log('Добавлена демо-история продаж'); await c.query('commit'); }
    catch (e) { await c.query('rollback'); console.error('Демо-история не добавлена:', (e as Error).message); }
    await c.query('begin');
    try { if (await seedDemoCalls(c as unknown as Db, demo.id) && !quiet) console.log('Добавлены демо-разговоры'); await c.query('commit'); }
    catch (e) { await c.query('rollback'); console.error('Демо-разговоры не добавлены:', (e as Error).message); }
  }
  await c.end();
  if (!quiet) console.log('Миграции применены');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await migrate();
