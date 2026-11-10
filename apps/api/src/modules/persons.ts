import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { withCtx } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';

const mask = (phone: string | null) => (phone ? phone.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1 $2 ***-**-$5') : null);

export function personRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/persons', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(
        `select p.id, p.full_name as "fullName", p.segment, p.home_club_id as "clubId", c.name as "clubName",
           (select value from person_contacts pc where pc.person_id = p.id and pc.is_primary limit 1) as phone
         from persons p join clubs c on c.id = p.home_club_id
         where p.merged_into_id is null and ($1::uuid is null or p.home_club_id = $1)
         order by c.name, p.full_name`, [clubId || null])).rows;
      return rows.map((r) => ({ ...r, phone: mask(r.phone) }));
    });
  });
}
