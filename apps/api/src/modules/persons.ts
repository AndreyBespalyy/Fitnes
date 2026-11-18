import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requirePerm, trainerOnly } from '../auth.ts';
import { withCtx } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';

import { maskPhone as mask } from './crm.ts';
import { trackAccess } from './privacy.ts';

export function personRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/persons', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { clubId, q, mine, kind } = req.query as { clubId?: string; q?: string; mine?: string; kind?: string };
    // «Мои клиенты» тренера: только те, кто записан на его занятия за 90 дней или вперёд
    // Тренер без других ролей видит в списке только своих клиентов; поиск по имени или телефону (записать на занятие) остаётся
    const trainerId = mine === '1' || (trainerOnly(ctx) && !(q ?? '').trim()) ? ctx.userId : null;
    const digits = (q ?? '').replace(/\D/g, '');
    const text = (q ?? '').trim();
    await trackAccess(pool, ctx, 'search', { clubId: clubId || null });
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(
        `select p.id, p.full_name as "fullName", p.segment, p.home_club_id as "clubId", c.name as "clubName",
           (select value from person_contacts pc where pc.person_id = p.id and pc.is_primary limit 1) as phone
         from persons p join clubs c on c.id = p.home_club_id
         where p.merged_into_id is null and ($1::uuid is null or p.home_club_id = $1)
           and ($4::uuid is null or p.id in (select b.person_id from class_bookings b join class_sessions s on s.id = b.session_id
                                             where s.trainer_id = $4 and s.starts_at > now() - interval '90 days'))
           and (($2 = '' and $3 = '') or ($2 <> '' and p.id in (select person_ids_by_name($2)))
                or ($3 <> '' and p.id in (select person_ids_by_phone($3))))
           -- Фильтр «новые / члены клуба / бывшие» (замечание №39): по абонементам и подпискам, без гостевых
           and ($5 = '' or ($5 = 'member') = exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.kind <> 'guest' and (m.ends_on is null or m.ends_on >= current_date)))
           and ($5 <> 'new' or not exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest'))
           and ($5 <> 'former' or exists (select 1 from memberships m where m.person_id = p.id and m.kind <> 'guest'))
         order by c.name, p.full_name limit 300`, [clubId || null, digits.length >= 4 ? '' : text, digits.length >= 4 ? digits : '', trainerId, ['new', 'member', 'former'].includes(kind ?? '') ? kind : ''])).rows;
      return rows.map((r) => ({ ...r, phone: mask(r.phone) }));
    });
  });

  // Общий поиск (⌘K): сотрудники по фамилии и договоры по номеру — в дополнение к клиентам и разделам
  app.get('/api/search/more', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return { staff: [], contracts: [] };
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return withCtx(pool, ctx, async (db) => {
      const staff = can(ctx, P.staffView) ? (await db.query(
        `select u.id, u.full_name as "fullName",
           string_agg(distinct r.name, ', ') as roles, string_agg(distinct c.name, ', ') as clubs
         from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code left join clubs c on c.id = a.club_id
         where not u.is_bot and u.full_name ilike $1
           and ($2::boolean or exists (select 1 from user_assignments x where x.user_id = u.id and x.club_id = any($3::uuid[])))
         group by u.id order by u.full_name limit 6`, [like, ctx.allClubs, ctx.clubIds])).rows : [];
      const contracts = (await db.query(
        `select k.id, k.number, k.status, k.person_id as "personId", p.full_name as "personName"
         from contracts k join persons p on p.id = k.person_id
         where k.number ilike $1 and ($2::boolean or k.club_id = any($3::uuid[]))
         order by k.created_at desc limit 6`, [like, ctx.allClubs, ctx.clubIds])).rows;
      return { staff, contracts };
    });
  });
}
