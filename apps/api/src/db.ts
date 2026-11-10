import pg from 'pg';

export type Ctx = {
  userId: string;
  tenantId: string;
  sessionId: string;
  roles: string[];
  allClubs: boolean;
  clubIds: string[];
  permissions: Set<string>;
  ip?: string;
};

export type Db = pg.PoolClient;

export function createPool(url: string) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Выполняет функцию в транзакции с контекстом пользователя: база сама отсекает чужие сеть и клубы. */
export async function withCtx<T>(
  pool: pg.Pool,
  ctx: Pick<Ctx, 'tenantId' | 'allClubs' | 'clubIds'>,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query(
      `select set_config('app.tenant_id', $1, true), set_config('app.all_clubs', $2, true), set_config('app.club_ids', $3, true)`,
      [ctx.tenantId, ctx.allClubs ? 'on' : 'off', ctx.clubIds.join(',')],
    );
    const res = await fn(db);
    await db.query('commit');
    return res;
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

export async function audit(db: Db, ctx: { tenantId: string; userId: string | null; ip?: string }, action: string, objectType: string,
  objectId: string | null, before: unknown, after: unknown) {
  await db.query(
    'insert into audit_log(tenant_id, actor_id, action, object_type, object_id, before, after, ip) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [ctx.tenantId, ctx.userId, action, objectType, objectId, before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after), ctx.ip ?? null],
  );
}
