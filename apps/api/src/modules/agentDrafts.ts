// Советы помощника — не текстом «откройте… поставьте…», а готовой задачей: помощник сам выбирает
// наименее загруженного менеджера и заполняет задачу под ситуацию; руководителю остаётся проверить и нажать «Поставить».
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { botSay } from './agentMeetings.ts';
import { fmtDate } from './agent.ts';

export type Candidate = { id: string; name: string; open: number; overdue: number };
export type TaskDraft = {
  clubId: string; clubName: string; kind: 'call' | 'other';
  assigneeId: string; assigneeName: string; why: string;
  title: string; dueAt: string; candidates: Candidate[];
};

/** Менеджеры клуба по загрузке: сначала у кого меньше просроченных, затем открытых задач; кто сегодня не работает — не предлагаем */
export async function managersByLoad(db: Db, clubId: string): Promise<Candidate[]> {
  const rows = (await db.query(`select u.id, u.full_name as name,
      (select count(*) from tasks t where t.assignee_id = u.id and t.done_at is null)::int as open,
      (select count(*) from tasks t where t.assignee_id = u.id and t.done_at is null and t.due_at < now())::int as overdue
    from users u join clubs c on c.id = $1
    where u.status = 'active' and not u.is_bot
      and exists (select 1 from user_assignments a where a.user_id = u.id and a.club_id = $1 and a.role_code = 'manager'
        and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date))
      and not exists (select 1 from staff_absences s where s.user_id = u.id and (now() at time zone c.timezone)::date between s.date_from and s.date_to)
    order by overdue, open, u.full_name`, [clubId])).rows as Candidate[];
  return rows;
}

const first = (n: string) => n.split(' ').slice(0, 2).join(' ');
const tasksWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'задача' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'задачи' : 'задач');

/** Готовая задача по совету: исполнитель — наименее загруженный менеджер клуба, срок — сегодня до 19:00 (вечером — завтра до 12:00) */
export async function draftTask(db: Db, club: { id: string; name: string; timezone: string }, title: string, kind: 'call' | 'other' = 'call'): Promise<TaskDraft | null> {
  const cands = await managersByLoad(db, club.id);
  if (!cands.length) return null;
  const best = cands[0];
  const next = cands[1];
  const why = `Свободнее всех: ${best.open} ${tasksWord(best.open)}${best.overdue ? `, просрочено ${best.overdue}` : ''}`
    + (next ? `; у ${first(next.name)} — ${next.open}${next.overdue ? `, просрочено ${next.overdue}` : ''}` : '');
  const due = (await db.query(`select case when (now() at time zone $1)::time < time '18:00'
      then ((now() at time zone $1)::date + time '19:00') at time zone $1
      else ((now() at time zone $1)::date + 1 + time '12:00') at time zone $1 end as d`, [club.timezone])).rows[0].d as Date;
  return { clubId: club.id, clubName: club.name, kind, assigneeId: best.id, assigneeName: best.name, why, title: title.slice(0, 300), dueAt: new Date(due).toISOString(), candidates: cands.slice(0, 8) };
}

/** Кнопка под ответом помощника */
export const draftButton = (d: TaskDraft, what: string, manyClubs: boolean) =>
  ({ label: `Поставить задачу${manyClubs ? ` в «${d.clubName.replace(/^Клуб\s+«?|»$/g, '')}»` : ''}: ${first(d.assigneeName)} — ${what}`, task: d });

/** Сколько звонков в дневной цели: по 10 на отстающее направление, от 20 до 40 */
export const callsGoal = (cats: number) => Math.min(40, Math.max(20, cats * 10));

export function agentDraftRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Руководитель проверил задачу из совета помощника и нажал «Поставить»
  app.post<{ Body: { messageId: string; idx: number; assigneeId: string; title: string; dueAt: string } }>('/api/agent/advice-task', async (req, reply) => {
    const ctx = requireCtx(req);
    if (!(can(ctx, P.dashView) || can(ctx, P.crmViewAll))) return reply.code(403).send({ error: 'forbidden', message: 'Ставить задачи из советов могут руководители' });
    const b = req.body ?? ({} as never);
    const title = String(b.title ?? '').trim();
    if (title.length < 3) return reply.code(400).send({ error: 'title', message: 'Напишите, что сделать' });
    const due = new Date(b.dueAt);
    if (Number.isNaN(due.getTime())) return reply.code(400).send({ error: 'due', message: 'Укажите срок' });
    return withCtx(pool, ctx, async (db) => {
      // Сообщение помощника в чате этого руководителя
      const m = (await db.query(`select m.id, m.meta from team_messages m join users u on u.id = m.user_id and u.is_bot
        where m.id = $1 and exists (select 1 from team_members tm where tm.chat_id = m.chat_id and tm.user_id = $2)`, [b.messageId, ctx.userId])).rows[0];
      const acts = (m?.meta?.actions ?? []) as { task?: TaskDraft; done?: unknown }[];
      const a = acts[Number(b.idx)];
      if (!a?.task) return reply.code(404).send({ error: 'not_found', message: 'Совет не найден' });
      if (a.done) return reply.code(409).send({ error: 'done', message: 'Задача по этому совету уже поставлена' });
      const who = (await db.query(`select u.id, u.full_name from users u where u.id = $1 and u.status = 'active' and not u.is_bot
        and exists (select 1 from user_assignments x where x.user_id = u.id and (x.club_id = $2 or x.club_id is null) and (x.active_to is null or x.active_to >= current_date))`, [b.assigneeId, a.task.clubId])).rows[0];
      if (!who) return reply.code(400).send({ error: 'assignee', message: 'Этот сотрудник не работает в клубе' });
      const id = (await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, a.task.clubId, who.id, a.task.kind, title.slice(0, 300), due, ctx.userId])).rows[0].id as string;
      await audit(db, ctx, 'task.created', 'task', id, null, { title, via: 'agent_advice' });
      acts[Number(b.idx)] = { ...a, done: { taskId: id, name: who.full_name } };
      await db.query(`update team_messages set meta = jsonb_set(meta, '{actions}', $2::jsonb) where id = $1`, [m.id, JSON.stringify(acts)]);
      const boss = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0]?.full_name ?? 'Руководитель';
      const tz = (await db.query(`select timezone from clubs where id = $1`, [a.task.clubId])).rows[0]?.timezone ?? 'Europe/Moscow';
      if (who.id !== ctx.userId) await botSay(db, ctx.tenantId, who.id, `**Новая задача от руководителя — ${boss}:** ${title}\nСрок — ${fmtDate(due, tz)}. Она в разделе «Задачи».`, { kind: 'advice_task', taskId: id }, false);
      return { taskId: id, name: who.full_name };
    });
  });
}
