// Рабочая сборка сервера (п. 10 списка улучшений): TypeScript собирается заранее в обычный JavaScript,
// на сервере запускается node без tsx. Пакеты из node_modules не вшиваются — ставятся в образ отдельно.
// Пути выбраны так, чтобы файлы лежали на той же глубине, что и исходники:
//   src/main.ts      → dist/main.mjs      (веб лежит в ../../web/dist, как и для src)
//   db/scripts/*.ts  → db/dist/*.mjs      (миграции в ../migrations, как и для db/scripts)
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true, logLevel: 'warning' };

await build({ ...common, entryPoints: { main: 'src/main.ts' }, outdir: 'dist', outExtension: { '.js': '.mjs' } });
await build({
  ...common,
  entryPoints: { setup: 'db/scripts/setup.ts', migrate: 'db/scripts/migrate.ts', seed: 'db/scripts/seed.ts', reset: 'db/scripts/reset.ts', platform: 'db/scripts/platform.ts' },
  outdir: 'db/dist', outExtension: { '.js': '.mjs' },
});
console.log('Сервер собран: dist/main.mjs, db/dist/*.mjs');
