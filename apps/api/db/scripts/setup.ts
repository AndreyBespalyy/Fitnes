// Создаёт служебных пользователей и базу данных. Запускается один раз под администратором PostgreSQL.
import { connect, need, dbNameFrom } from './common.ts';

const admin = await connect(need('ADMIN_DATABASE_URL'));
const ownerPw = need('DB_OWNER_PASSWORD');
const appPw = need('DB_APP_PASSWORD');
const dbName = dbNameFrom(need('OWNER_DATABASE_URL'));

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
for (const [role, pw] of [['fitnes_owner', ownerPw], ['fitnes_app', appPw]] as const) {
  const exists = await admin.query('select 1 from pg_roles where rolname = $1', [role]);
  const verb = exists.rowCount ? 'alter' : 'create';
  await admin.query(`${verb} role ${role} with login password ${lit(pw)} nosuperuser nobypassrls`);
  console.log(`Пользователь ${role}: ${exists.rowCount ? 'обновлён' : 'создан'}`);
}
const db = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
if (!db.rowCount) {
  await admin.query(`create database "${dbName}" owner fitnes_owner encoding 'UTF8' template template0 locale_provider icu icu_locale 'ru-RU' locale 'C'`);
  console.log(`База ${dbName} создана`);
} else {
  console.log(`База ${dbName} уже есть`);
}
await admin.end();
console.log('Готово. Дальше: npm run db:migrate && npm run db:seed');
