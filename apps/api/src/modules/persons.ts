import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requirePerm } from '../auth.ts';
import { withCtx } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';

import { maskPhone as mask } from './crm.ts';
import { trackAccess } from './privacy.ts';

export function personRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/persons', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { clubId, q } = req.query as { clubId?: string; q?: string };
    const digits = (q ?? '').replace(/\D/g, '');
    const text = (q ?? '').trim();
    await trackAccess(pool, ctx, 'search', { clubId: clubId || null });
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(
        `select p.id, p.full_name as "fullName", p.segment, p.home_club_id as "clubId", c.name as "clubName",
           (select value from person_contacts pc where pc.person_id = p.id and pc.is_primary limit 1) as phone
         from persons p join clubs c on c.id = p.home_club_id
         where p.merged_into_id is null and ($1::uuid is null or p.home_club_id = $1)
           and (($2 = '' and $3 = '') or ($2 <> '' and p.full_name ilike '%' || $2 || '%')
                or ($3 <> '' and exists (select 1 from person_contacts pc where pc.person_id = p.id and pc.normalized_value like '%' || $3 || '%')))
         order by c.name, p.full_name limit 300`, [clubId || null, digits.length >= 4 ? '' : text, digits.length >= 4 ? digits : ''])).rows;
      return rows.map((r) => ({ ...r, phone: mask(r.phone) }));
    });
  });
}
