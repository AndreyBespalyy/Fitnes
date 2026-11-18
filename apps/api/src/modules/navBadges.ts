// Счётчики в меню (замечание тестировщика №44, 18.11.2026): сколько непрочитанных в Мессенджере,
// необработанных диалогов в «Переписке» и задач на сегодня и просроченных — в скобках рядом с разделом.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { withCtx } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';

export function navBadgeRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/nav/badges', async (req) => {
    const ctx = requireCtx(req);
    const { clubId } = req.query as { clubId?: string };
    const club = clubId && clubId !== 'all' ? clubId : null;
    return withCtx(pool, ctx, async (db) => {
      const team = (await db.query(`select coalesce(sum((select count(*) from team_messages x where x.chat_id = m.chat_id and x.created_at > m.last_read_at and x.deleted_at is null and x.user_id is distinct from $1)), 0)::int as n
        from team_members m join team_chats c on c.id = m.chat_id and c.archived_at is null where m.user_id = $1 and not m.muted`, [ctx.userId])).rows[0].n as number;
      const chats = can(ctx, P.messagesWork) ? (await db.query(`select count(*)::int as n from msg_conversations c where c.unread > 0 and ($1::uuid is null or c.club_id = $1)
        and ($2::uuid is null or c.assigned_to = $2 or c.assigned_to is null)`, [club, can(ctx, P.crmViewAll) ? null : ctx.userId])).rows[0].n as number : 0;
      // Задачи: свои, на сегодня и просроченные
      const tasks = (await db.query(`select count(*)::int as n from tasks t left join clubs c on c.id = t.club_id, lateral (select coalesce(c.timezone, 'Europe/Moscow') as tz) z
        where t.done_at is null and t.assignee_id = $1 and ($2::uuid is null or t.club_id = $2)
          and t.due_at < (date_trunc('day', now() at time zone z.tz) + interval '1 day') at time zone z.tz`, [ctx.userId, club])).rows[0].n as number;
      return { team, chats, tasks };
    });
  });
}
