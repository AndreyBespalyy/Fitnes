import pg from 'pg';

export function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Не задана переменная ${name}. Скопируйте .env.example в .env и заполните.`);
    process.exit(1);
  }
  return v;
}

export async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

export function dbNameFrom(url: string): string {
  return new URL(url).pathname.replace(/^\//, '') || 'fitnes';
}
