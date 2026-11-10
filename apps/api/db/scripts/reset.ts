// Полностью очищает схему и заново применяет миграции и тестовые данные. Только для разработки.
import { connect, need } from './common.ts';
import { migrate } from './migrate.ts';
import { seed } from './seed.ts';

const url = need('OWNER_DATABASE_URL');
const c = await connect(url);
await c.query('drop schema public cascade; create schema public;');
await c.end();
await migrate(url);
await seed(url);
