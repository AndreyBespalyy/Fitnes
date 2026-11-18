// Разбор переписки с клиентами (решение Андрея 18.11.2026): так же, как разбор записей звонков.
// Когда в диалоге затихло (30 минут без новых сообщений), ИИ читает новые сообщения с прошлого разбора и составляет итог:
// суть, потребность, возражения, договорённости, результат, следующий шаг. Итог виден в переписке и в карточке клиента
// и попадает в «Коротко о ситуации». Следующий шаг становится задачей ответственному менеджеру.
// Переписка уходит только на свой ИИ-сервер клуба (или Яндекс, если включён он) — как расшифровки звонков.
import type pg from 'pg';
import { withCtx, type Db } from '../db.ts';
import { aiSummarize, normalizeSummary, type AiConfig, type Summary } from '../lib/aiClient.ts';

export const QUIET_MIN = 30;
const BATCH = 5;
const MESSENGER: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };

type Episode = { id: string; club_id: string; person_id: string | null; assigned_to: string | null; messenger: string; club_name: string; timezone: string;
  person_name: string | null; title: string; manager: string | null; since: string | null };

/** Диалоги, где после прошлого разбора есть новые сообщения клиента и уже 30 минут тихо. */
export async function dueEpisodes(db: Db, limit = BATCH): Promise<Episode[]> {
  return (await db.query(`
    with last as (select conversation_id, max(upto) as upto from msg_chat_summaries group by conversation_id)
    select c.id, c.club_id, c.person_id, c.assigned_to, ch.messenger, cl.name as club_name, cl.timezone, p.full_name as person_name, c.title,
      u.full_name as manager, l.upto as since
    from msg_conversations c join msg_channels ch on ch.id = c.channel_id join clubs cl on cl.id = c.club_id
    left join persons p on p.id = c.person_id left join users u on u.id = c.assigned_to left join last l on l.conversation_id = c.id
    where c.last_message_at < now() - make_interval(mins => $1)
      and exists (select 1 from msg_messages m where m.conversation_id = c.id and m.direction = 'in' and (l.upto is null or m.created_at > l.upto))
    order by c.last_message_at limit $2`, [QUIET_MIN, limit])).rows;
}

/** Переписка эпизода в виде «расшифровки»: тот же разбор, что у звонков. */
export async function episodeTranscript(db: Db, e: Pick<Episode, 'id' | 'since'>) {
  const rows = (await db.query(`select m.created_at, m.direction, m.body, m.auto, u.full_name as author from msg_messages m left join users u on u.id = m.author_id
    where m.conversation_id = $1 and ($2::timestamptz is null or m.created_at > $2) and m.status <> 'failed' order by m.created_at, m.id limit 300`, [e.id, e.since])).rows;
  const segments = rows.map((m, i) => ({ speaker: m.direction === 'in' ? 'Клиент' : m.auto ? 'Автосообщение клуба' : `Клуб${m.author ? ` (${m.author})` : ''}`,
    start: i, end: i, text: String(m.body) }));
  return { rows, transcript: { text: segments.map((s) => `${s.speaker}: ${s.text}`).join('\n'), segments } };
}

async function addNextStep(db: Db, tenantId: string, e: Episode, s: Summary) {
  if (!s.nextStep || !e.assigned_to) return;
  const due = s.nextStep.dueAt ? new Date(s.nextStep.dueAt) : new Date(Date.now() + 24 * 3600_000);
  const kind = s.nextStep.kind === 'call' ? 'call' : s.nextStep.kind === 'meeting' ? 'meeting' : s.nextStep.kind === 'message' ? 'message' : 'other';
  await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at) values ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, e.club_id, e.assigned_to, e.person_id, kind, `${s.nextStep.title} (из переписки в ${MESSENGER[e.messenger] ?? e.messenger}, ИИ)`.slice(0, 300), due]);
}

export async function processChats(pool: pg.Pool, ai: AiConfig) {
  const tenants = (await pool.query('select tenant_id from msg_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] };
    const eps = await withCtx(pool, sys, (db) => dueEpisodes(db));
    for (const e of eps) {
      const { rows, transcript } = await withCtx(pool, sys, (db) => episodeTranscript(db, e));
      if (!rows.length) continue;
      const upto = rows[rows.length - 1].created_at; const from = rows[0].created_at;
      let summary: Summary | null = null; let engine: string | null = null; let error: string | null = null;
      // Совсем короткая переписка («Здравствуйте» — «Добрый день») — итог не нужен
      const words = rows.filter((m) => m.direction === 'in').map((m) => String(m.body)).join(' ').split(/\s+/).filter(Boolean).length;
      if (words >= 3) {
        try {
          const r = await aiSummarize(ai, transcript, { kind: 'chat', channel: `переписка в ${MESSENGER[e.messenger] ?? e.messenger}`, clubName: e.club_name,
            managerName: e.manager, clientName: e.person_name ?? e.title, now: new Date().toISOString(), timezone: e.timezone,
            callTime: new Date(upto).toLocaleString('ru-RU', { timeZone: e.timezone }) });
          summary = normalizeSummary(r.summary); engine = r.engine ?? null;
        } catch (x) { error = (x as Error).message.slice(0, 300); }
      }
      // ИИ-сервер недоступен — не записываем ничего, повторим в следующий проход
      if (error && /fetch failed|ECONNREFUSED|timeout|aborted|ответил 5\d\d/i.test(error)) continue;
      await withCtx(pool, sys, async (db) => {
        await db.query(`insert into msg_chat_summaries(tenant_id, club_id, conversation_id, person_id, from_at, upto, messages, summary, engine, status, error)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenantId, e.club_id, e.id, e.person_id, from, upto, rows.length, summary ? JSON.stringify(summary) : null, engine, summary ? 'done' : error ? 'failed' : 'empty', error]);
        if (summary) await addNextStep(db, tenantId, e, summary);
      });
    }
  }
}

export function startChatAiWorker(pool: pg.Pool, ai: AiConfig | null, everyMs = 60_000) {
  if (!ai) return () => undefined; // без ИИ переписка копится и будет разобрана, когда ИИ подключат
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processChats(pool, ai); } catch (e) { console.error('Разбор переписки:', (e as Error).message); } finally { busy = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/** Итоги переписки для карточки клиента и «Коротко о ситуации». */
export async function chatSummariesOf(db: Db, where: { personId?: string; conversationId?: string }, limit = 5) {
  return (await db.query(`select s.upto as at, s.messages, s.summary, ch.messenger, u.full_name as manager
    from msg_chat_summaries s join msg_conversations c on c.id = s.conversation_id join msg_channels ch on ch.id = c.channel_id left join users u on u.id = c.assigned_to
    where s.status = 'done' and ($1::uuid is null or s.person_id = $1) and ($2::uuid is null or s.conversation_id = $2) order by s.upto desc limit $3`,
  [where.personId ?? null, where.conversationId ?? null, limit])).rows.map((r) => ({ at: r.at as string, messages: r.messages as number, messenger: MESSENGER[r.messenger] ?? r.messenger,
    manager: r.manager as string | null, ...(r.summary as Summary) }));
}
