// Кнопки под подсказками тренера: «Написать клиентам» — готовое приглашение на следующее занятие (дата, время, коротко о занятии),
// отправляется в мессенджер клиента; «Позвонить» — тренер может звонить своим клиентам.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { queueMessage } from './messaging.ts';

type Kind = 'noshow' | 'newbie' | 'idle';
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Клиент занимается у этого тренера: был записан к нему за 60 дней или записан на ближайшие 2 недели */
export async function isTrainerClient(db: Db, trainerId: string, personId: string) {
  return !!(await db.query(`select 1 from class_bookings b join class_sessions s on s.id = b.session_id where b.person_id = $1 and s.trainer_id = $2
    and s.starts_at between now() - interval '60 days' and now() + interval '14 days' limit 1`, [personId, trainerId])).rowCount;
}

/** Писать и звонить клиенту можно менеджерам/администраторам, а тренеру — только своим клиентам */
async function mayContact(db: Db, ctx: Ctx, personId: string) {
  if (can(ctx, P.messagesWork) || can(ctx, P.crmWork)) return true;
  return isTrainerClient(db, ctx.userId, personId);
}

/** Куда пригласить: новичка — на его ближайшее занятие у этого тренера; остальных — на ближайшее занятие тренера со свободными местами */
async function nextSession(db: Db, trainerId: string, kind: Kind, personId: string | null) {
  const own = kind === 'newbie' && personId ? (await db.query(`select s.id from class_sessions s join class_bookings b on b.session_id = s.id
    where b.person_id = $1 and s.trainer_id = $2 and b.status = 'booked' and s.status = 'scheduled' and s.starts_at > now() order by s.starts_at limit 1`, [personId, trainerId])).rows[0]?.id : null;
  const r = (await db.query(`select s.id, s.starts_at, t.name, t.description, c.timezone, c.name as club,
      to_char(s.starts_at at time zone c.timezone, 'DD.MM') as d, to_char(s.starts_at at time zone c.timezone, 'HH24:MI') as hm,
      extract(dow from s.starts_at at time zone c.timezone)::int as dow,
      (s.starts_at at time zone c.timezone)::date = (now() at time zone c.timezone)::date as today,
      (s.starts_at at time zone c.timezone)::date = (now() at time zone c.timezone)::date + 1 as tomorrow
    from class_sessions s join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id
    where ${own ? 's.id = $2' : `s.trainer_id = $1 and s.status = 'scheduled' and s.starts_at > now() + interval '1 hour'
      and (select count(*) from class_bookings b where b.session_id = s.id and b.status in ('booked', 'attended')) < s.capacity`}
    order by s.starts_at limit 1`, own ? [trainerId, own] : [trainerId])).rows[0];
  if (!r) return null;
  const when = `${r.today ? 'сегодня' : r.tomorrow ? 'завтра' : `${WD[r.dow]} ${r.d}`} в ${r.hm}`;
  const about = String(r.description ?? '').replace(/\s+/g, ' ').trim();
  return { id: r.id as string, name: r.name as string, when, about: about.length > 140 ? `${about.slice(0, 137).replace(/\s+\S*$/, '')}…` : about };
}

/** Текст приглашения; {имя} подставится каждому клиенту */
function inviteText(kind: Kind, me: string, s: { name: string; when: string; about: string } | null) {
  const intro = `{имя}, здравствуйте! Это ${me}, ваш тренер.`;
  const about = s?.about ? ` ${s.about}` : '';
  if (!s) return kind === 'noshow' ? `${intro} Вчера не увиделись на занятии — всё в порядке? Подскажите, когда вам удобно прийти, запишу.` : `${intro} Давно вас не видно — всё в порядке? Подскажите, когда удобно прийти, запишу.`;
  if (kind === 'newbie') return `${intro} Жду вас ${s.when} на «${s.name}».${about} Приходите за 10 минут — познакомимся и покажу зал.`;
  if (kind === 'noshow') return `${intro} Вчера не увиделись на занятии — всё в порядке? Приглашаю на следующее: «${s.name}», ${s.when}.${about} Записать вас?`;
  return `${intro} Давно вас не видно — соскучились! Ближайшее занятие: «${s.name}», ${s.when}.${about} Записать вас?`;
}

/** Канал для сообщения: последняя переписка клиента, а если её нет — WhatsApp клуба по телефону */
async function conversationFor(db: Db, ctx: Ctx, personId: string): Promise<{ id: string } | { error: string }> {
  const p = (await db.query(`select full_name, messaging_opt_out, home_club_id from persons where id = $1`, [personId])).rows[0];
  if (!p) return { error: 'клиент не найден' };
  if (p.messaging_opt_out) return { error: 'отписался от сообщений' };
  const c = (await db.query(`select c.id from msg_conversations c join msg_channels ch on ch.id = c.channel_id and ch.status = 'active'
    where c.person_id = $1 order by c.last_message_at desc nulls last limit 1`, [personId])).rows[0];
  if (c) return { id: c.id };
  const ch = (await db.query(`select id, club_id from msg_channels where status = 'active' and messenger = 'whatsapp' order by (club_id = $1) desc limit 1`, [p.home_club_id])).rows[0];
  const phone = (await db.query(`select normalized_value from person_contacts where person_id = $1 and type in ('phone', 'whatsapp') order by is_primary desc limit 1`, [personId])).rows[0]?.normalized_value;
  if (!ch || !phone) return { error: 'нет переписки в мессенджере — позвоните' };
  return (await db.query(`insert into msg_conversations(tenant_id, club_id, channel_id, person_id, external_chat_id, title, assigned_to) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (channel_id, external_chat_id) do update set person_id = coalesce(msg_conversations.person_id, excluded.person_id) returning id`,
  [ctx.tenantId, ch.club_id, ch.id, personId, String(phone).replace(/\D/g, ''), p.full_name, ctx.userId])).rows[0];
}

/** Имя для обращения: в CRM пишут «Имя Фамилия»; если первым словом стоит фамилия на -ов/-ев/-ин/-ова… — берём второе */
const firstName = (full: string) => { const w = full.trim().split(/\s+/); return w.length >= 2 && /(ов|ев|ёв|ин|ын|ова|ева|ина|ына|ский|цкий|ская|цкая)$/i.test(w[0]) ? w[1] : w[0]; };

export function agentInviteRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Черновик: текст приглашения и кому получится отправить
  app.post<{ Body: { kind: Kind; personIds: string[] } }>('/api/agent/invite-draft', async (req, reply) => {
    const ctx = requireCtx(req);
    const kind = (['noshow', 'newbie', 'idle'] as const).find((k) => k === req.body?.kind);
    const ids = (req.body?.personIds ?? []).slice(0, 20);
    if (!kind || !ids.length) return reply.code(400).send({ error: 'bad_request', message: 'Кому писать?' });
    return withCtx(pool, ctx, async (db) => {
      const me = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0]?.full_name ?? '';
      const s = await nextSession(db, ctx.userId, kind, ids[0]);
      const people = [];
      for (const id of ids) {
        if (!(await mayContact(db, ctx, id))) continue;
        const p = (await db.query(`select p.full_name, p.messaging_opt_out,
            exists (select 1 from msg_conversations c join msg_channels ch on ch.id = c.channel_id and ch.status = 'active' where c.person_id = p.id) as chat,
            exists (select 1 from person_contacts c where c.person_id = p.id and c.type in ('phone', 'whatsapp')) as phone
          from persons p where p.id = $1`, [id])).rows[0];
        if (p) people.push({ id, name: p.full_name as string, ok: !p.messaging_opt_out && (p.chat || p.phone), note: p.messaging_opt_out ? 'отписался от сообщений' : p.chat ? 'в мессенджере' : p.phone ? 'WhatsApp по телефону' : 'нет мессенджера — только звонок' });
      }
      return { text: inviteText(kind, me.split(' ')[0], s), session: s, people };
    });
  });

  // Отправить: каждому — со своим именем; сообщения уходят в мессенджер клиента через очередь отправки
  app.post<{ Body: { personIds: string[]; text: string } }>('/api/agent/invite-send', async (req, reply) => {
    const ctx = requireCtx(req);
    const text = String(req.body?.text ?? '').trim();
    const ids = (req.body?.personIds ?? []).slice(0, 20);
    if (text.length < 5 || text.length > 1500) return reply.code(400).send({ error: 'text', message: 'Напишите текст сообщения' });
    return withCtx(pool, ctx, async (db) => {
      const sent: string[] = []; const failed: { name: string; reason: string }[] = [];
      for (const id of ids) {
        const p = (await db.query(`select full_name from persons where id = $1`, [id])).rows[0];
        if (!p) continue;
        if (!(await mayContact(db, ctx, id))) { failed.push({ name: p.full_name, reason: 'не ваш клиент' }); continue; }
        const c = await conversationFor(db, ctx, id);
        if ('error' in c) { failed.push({ name: p.full_name, reason: c.error }); continue; }
        await queueMessage(db, ctx, c.id, text.replaceAll('{имя}', firstName(p.full_name)));
        await db.query('update msg_conversations set last_message_at = now() where id = $1', [c.id]);
        await audit(db, ctx, 'agent.invite_sent', 'person', id, null, { via: 'agent_hint' });
        sent.push(p.full_name);
      }
      return { sent, failed };
    });
  });
}

/* ---------- чат: «кто не пришёл на последнюю тренировку» ---------- */
export const NOSHOW_RE = /(кто\s+не\s+приш(е|ё)л|кто\s+не\s+был|не\s+пришли|неявк|прогулял)/i;

/** Последнее прошедшее занятие тренера и кто на него не пришёл; кнопки — позвонить каждому и написать с приглашением */
export async function noShowAnswer(db: Db, ctx: Ctx): Promise<{ text: string; actions: { label: string; call?: { persons: { id: string; name: string }[] }; write?: { kind: Kind; personIds: string[] }; url?: string }[] } | null> {
  const s = (await db.query(`select s.id, t.name, to_char(s.starts_at at time zone c.timezone, 'DD.MM') as d, to_char(s.starts_at at time zone c.timezone, 'HH24:MI') as hm,
      extract(dow from s.starts_at at time zone c.timezone)::int as dow, to_char(s.starts_at at time zone c.timezone, 'YYYY-MM-DD') as day
    from class_sessions s join class_types t on t.id = s.type_id join clubs c on c.id = s.club_id
    where s.trainer_id = $1 and s.starts_at < now() and s.status <> 'cancelled' order by s.starts_at desc limit 1`, [ctx.userId])).rows[0];
  if (!s) return null;
  const rows = (await db.query(`select p.id, p.full_name, b.status from class_bookings b join persons p on p.id = b.person_id
    where b.session_id = $1 and b.status in ('no_show', 'booked', 'attended') order by p.full_name`, [s.id])).rows as { id: string; full_name: string; status: string }[];
  const head = `**Прошлое занятие — «${s.name}», ${WD[s.dow]} ${s.d} в ${s.hm}.**`;
  const ns = rows.filter((r) => r.status === 'no_show');
  const unmarked = rows.filter((r) => r.status === 'booked');
  const open = { label: 'Открыть занятие', url: `/?tab=schedule&date=${s.day}&session=${s.id}` };
  if (!ns.length) {
    if (unmarked.length) return { text: `${head}\nПосещения ещё не отмечены у ${unmarked.length} из ${rows.length} записанных. Отметьте, кто пришёл, — тогда покажу, кому позвонить.`, actions: [open] };
    return { text: `${head}\nПришли все записанные${rows.length ? ` (${rows.length})` : ''}.`, actions: [open] };
  }
  const persons = ns.map((r) => ({ id: r.id, name: r.full_name }));
  return {
    text: `${head}\nНе пришли (${ns.length} из ${rows.length}):\n${ns.map((r, i) => `${i + 1}. ${r.full_name}`).join('\n')}\n\nПозвоните или напишите им — спросите, всё ли в порядке, и пригласите на следующее занятие. Звонки через АТС клуба записываются, и помощник прикрепляет итог разговора к карточке клиента.${unmarked.length ? `\nЕщё не отмечены: ${unmarked.length}.` : ''}`,
    actions: [{ label: 'Позвонить клиентам', call: { persons } }, { label: 'Написать клиентам', write: { kind: 'noshow', personIds: persons.map((p) => p.id) } }, open],
  };
}
