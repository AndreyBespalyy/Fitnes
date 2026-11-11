// Шаг 16. Мобильное рабочее место (FR-MOB): push-уведомления, мои устройства, звонок в один клик.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { loadVapid, sendPush, type PushPayload, type Vapid } from '../lib/webpush.ts';

// Отправлять уведомления можно только в службы доставки браузеров и телефонов, а не на произвольный адрес
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /^push\.yandex\.ru$/];
export function allowedEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}

const shortName = (full: string | null) => {
  if (!full) return 'клиент';
  const [a, b] = full.trim().split(/\s+/);
  return b ? `${a} ${b[0]}.` : a;
};
const hhmm = (d: Date | string, tz: string) => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });

type Note = { userId: string; ref: string; kind: 'lead' | 'task' | 'message' | 'note'; pref?: 'tasks' | 'leads' | 'messages'; payload: PushPayload };

/** Что пора прислать: новые лиды, задачи через 10 минут, входящие сообщения. */
async function collect(db: Db): Promise<Note[]> {
  const notes: Note[] = [];
  const leads = (await db.query(
    `select t.id, t.assignee_id, t.club_id, t.due_at, c.timezone, p.full_name from tasks t join clubs c on c.id = t.club_id left join persons p on p.id = t.person_id
     where t.kind = 'first_response' and t.done_at is null and t.created_at > now() - interval '15 minutes'`)).rows;
  for (const l of leads) {
    const to = l.assignee_id ? [l.assignee_id as string] : (await db.query(
      `select distinct a.user_id from user_assignments a join users u on u.id = a.user_id
       where a.club_id = $1 and a.role_code in ('manager', 'rop') and u.status = 'active'
         and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`, [l.club_id])).rows.map((r) => r.user_id as string);
    for (const u of to) notes.push({ userId: u, ref: `lead:${l.id}`, kind: 'lead',
      payload: { title: 'Новый лид', body: `${shortName(l.full_name)} · ответить до ${hhmm(l.due_at, l.timezone)}`, url: '/?tab=tasks', tag: `lead-${l.id}` } });
  }
  const tasks = (await db.query(
    `select t.id, t.assignee_id, t.title, t.due_at, c.timezone, p.full_name from tasks t join clubs c on c.id = t.club_id left join persons p on p.id = t.person_id
     where t.kind <> 'first_response' and t.done_at is null and t.assignee_id is not null and t.due_at between now() and now() + interval '10 minutes'`)).rows;
  for (const t of tasks) notes.push({ userId: t.assignee_id, ref: `task:${t.id}:${new Date(t.due_at).getTime()}`, kind: 'task',
    payload: { title: `Задача в ${hhmm(t.due_at, t.timezone)}`, body: `${t.title}${t.full_name ? ` · ${shortName(t.full_name)}` : ''}`, url: '/?tab=tasks', tag: `task-${t.id}` } });
  // Входящие сообщения: одно уведомление на разговор за 10 минут
  const msgs = (await db.query(
    `select distinct on (v.id) v.id, v.title, p.full_name, m.created_at,
       coalesce(v.assigned_to, (select o.owner_id from opportunities o where o.person_id = v.person_id and o.club_id = v.club_id and o.status = 'open' and o.owner_id is not null order by o.created_at desc limit 1)) as to_user
     from msg_messages m join msg_conversations v on v.id = m.conversation_id left join persons p on p.id = v.person_id
     where m.direction = 'in' and m.created_at > now() - interval '10 minutes' order by v.id, m.created_at desc`)).rows;
  for (const m of msgs) {
    if (!m.to_user) continue;
    const bucket = Math.floor(new Date(m.created_at).getTime() / 600_000);
    notes.push({ userId: m.to_user, ref: `msg:${m.id}:${bucket}`, kind: 'message',
      payload: { title: 'Новое сообщение', body: m.full_name ? shortName(m.full_name) : 'Клиент написал в чат', url: '/?tab=chats', tag: `msg-${m.id}` } });
  }
  // Уведомления CRM (колокольчик): сигналы и сводки отдела продаж
  const crm = (await db.query(`select id, user_id, kind, title, body, link from staff_notifications
    where read_at is null and created_at > now() - interval '15 minutes'`)).rows;
  for (const n of crm) {
    const link = n.link as { tab?: string; p?: Record<string, string> } | null;
    const url = link?.tab ? `/?${new URLSearchParams({ tab: link.tab, ...(link.p ?? {}) }).toString()}` : '/';
    notes.push({ userId: n.user_id, ref: `note:${n.id}`, kind: 'note', pref: String(n.kind).startsWith('lead') ? 'leads' : undefined,
      payload: { title: n.title, body: (n.body ?? '').split('\n')[0].slice(0, 160), url, tag: `note-${n.id}` } });
  }
  return notes;
}

export async function processPush(pool: pg.Pool, vapid: Vapid, fetchFn: typeof fetch) {
  let sent = 0;
  const tenants = (await pool.query('select tenant_id from billing_tenants()')).rows.map((r) => r.tenant_id as string);
  for (const tenantId of tenants) {
    const sys = { tenantId, allClubs: true, clubIds: [] as string[] };
    await withCtx(pool, sys, async (db) => {
      const notes = await collect(db);
      for (const n of notes) {
        const pref = (await db.query('select push_tasks, push_leads, push_messages from user_prefs where user_id = $1', [n.userId])).rows[0];
        const key = n.kind === 'note' ? n.pref : n.kind === 'task' ? 'tasks' : n.kind === 'lead' ? 'leads' : 'messages';
        if (pref && key && !pref[`push_${key}`]) continue;
        const subs = (await db.query(
          `select p.id, p.endpoint, p.p256dh, p.auth from push_subscriptions p join sessions s on s.id = p.session_id join users u on u.id = p.user_id
           where p.user_id = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`, [n.userId])).rows;
        if (!subs.length) continue;
        const ins = await db.query(`insert into push_log(tenant_id, user_id, ref, kind, title) values ($1,$2,$3,$4,$5) on conflict do nothing`, [tenantId, n.userId, n.ref, n.kind, n.payload.title]);
        if (!ins.rowCount) continue;
        let ok = 0;
        for (const s of subs) {
          const r = await sendPush(fetchFn, vapid, s, n.payload);
          if (r.ok) { ok++; await db.query('update push_subscriptions set failures = 0, last_ok_at = now() where id = $1', [s.id]); }
          else if (r.gone) await db.query('delete from push_subscriptions where id = $1', [s.id]);
          else await db.query('update push_subscriptions set failures = failures + 1 where id = $1', [s.id]);
        }
        await db.query('update push_log set delivered = $3 where user_id = $1 and ref = $2', [n.userId, n.ref, ok]);
        sent += ok;
      }
      await db.query(`delete from push_subscriptions where failures >= 20`);
      await db.query(`delete from push_log where created_at < now() - interval '30 days'`);
    }).catch((e) => console.error('Уведомления:', (e as Error).message));
  }
  return sent;
}

export function startPushWorker(pool: pg.Pool, fetchFn: typeof fetch, everyMs = 30_000) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { await processPush(pool, await loadVapid(pool), fetchFn); } catch (e) { console.error('Ошибка уведомлений:', (e as Error).message); } finally { busy = false; }
  };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}

const PREFS = `select coalesce(p.push_tasks, true) as "pushTasks", coalesce(p.push_leads, true) as "pushLeads", coalesce(p.push_messages, true) as "pushMessages"
  from (select 1) x left join user_prefs p on p.user_id = $1`;

export function mobileRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: typeof fetch } = {}) {
  const fetchFn = opts.fetch ?? fetch;
  let vapid: Promise<Vapid> | null = null;
  const getVapid = () => (vapid ??= loadVapid(pool).catch((e) => { vapid = null; throw e; }));

  app.get('/api/push/key', async (req) => {
    requireCtx(req);
    return { publicKey: (await getVapid()).publicKey };
  });

  app.post('/api/push/subscribe', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!b.endpoint || !allowedEndpoint(b.endpoint)) throw badRequest('Этот браузер не поддерживает уведомления');
    const p256dh = b.keys?.p256dh ?? ''; const auth = b.keys?.auth ?? '';
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length < 16) throw badRequest('Неверные ключи подписки');
    return withCtx(pool, ctx, async (db) => {
      await db.query(
        `insert into push_subscriptions(tenant_id, user_id, session_id, endpoint, p256dh, auth, device) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (endpoint) do update set tenant_id = excluded.tenant_id, user_id = excluded.user_id, session_id = excluded.session_id,
           p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, failures = 0`,
        [ctx.tenantId, ctx.userId, ctx.sessionId, b.endpoint, p256dh, auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
      await audit(db, ctx, 'push.subscribed', 'user', ctx.userId, null, null);
      return { ok: true };
    });
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const ctx = requireCtx(req);
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    return withCtx(pool, ctx, async (db) => {
      await db.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [endpoint ?? '', ctx.userId]);
      return { ok: true };
    });
  });

  app.post('/api/push/test', async (req) => {
    const ctx = requireCtx(req);
    const v = await getVapid();
    return withCtx(pool, ctx, async (db) => {
      const subs = (await db.query('select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1 and session_id = $2', [ctx.userId, ctx.sessionId])).rows;
      if (!subs.length) throw badRequest('Уведомления на этом устройстве не включены');
      let ok = 0;
      for (const s of subs) {
        const r = await sendPush(fetchFn, v, s, { title: 'Клубная ОС', body: 'Проверка: уведомления на этом устройстве работают', url: '/', tag: 'test' });
        if (r.ok) ok++; else if (r.gone) await db.query('delete from push_subscriptions where id = $1', [s.id]);
      }
      return { sent: ok, total: subs.length };
    });
  });

  app.get('/api/me/prefs', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => (await db.query(PREFS, [ctx.userId])).rows[0]);
  });

  app.put('/api/me/prefs', async (req) => {
    const ctx = requireCtx(req);
    const b = (req.body ?? {}) as { pushTasks?: boolean; pushLeads?: boolean; pushMessages?: boolean };
    return withCtx(pool, ctx, async (db) => {
      const cur = (await db.query(PREFS, [ctx.userId])).rows[0];
      const v = (k: 'pushTasks' | 'pushLeads' | 'pushMessages') => (typeof b[k] === 'boolean' ? b[k] : cur[k]);
      await db.query(
        `insert into user_prefs(user_id, tenant_id, push_tasks, push_leads, push_messages) values ($1,$2,$3,$4,$5)
         on conflict (user_id) do update set push_tasks = $3, push_leads = $4, push_messages = $5, updated_at = now()`,
        [ctx.userId, ctx.tenantId, v('pushTasks'), v('pushLeads'), v('pushMessages')]);
      return (await db.query(PREFS, [ctx.userId])).rows[0];
    });
  });

  // Мои устройства: где я вошёл в систему; можно завершить сеанс на потерянном телефоне
  app.get('/api/me/sessions', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select s.id, s.device, s.created_at as "createdAt", coalesce(s.last_seen_at, s.created_at) as "lastSeenAt", s.id = $2 as current,
         exists (select 1 from push_subscriptions p where p.session_id = s.id) as push
       from sessions s where s.user_id = $1 and s.revoked_at is null and s.expires_at > now()
       order by s.id = $2 desc, coalesce(s.last_seen_at, s.created_at) desc`, [ctx.userId, ctx.sessionId])).rows);
  });

  app.post('/api/me/sessions/:id/revoke', async (req) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    if (id === ctx.sessionId) throw badRequest('Чтобы выйти на этом устройстве, нажмите «Выйти»');
    return withCtx(pool, ctx, async (db) => {
      const r = await db.query('update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null', [id, ctx.userId]);
      if (!r.rowCount) throw notFound('Сеанс не найден');
      await db.query('delete from push_subscriptions where session_id = $1', [id]);
      await audit(db, ctx, 'auth.session_revoked', 'session', id, null, null);
      return { ok: true };
    });
  });

  app.post('/api/me/sessions/revoke-others', async (req) => {
    const ctx = requireCtx(req);
    return withCtx(pool, ctx, async (db) => {
      const ids = (await db.query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null and expires_at > now() returning id', [ctx.userId, ctx.sessionId])).rows.map((r) => r.id);
      if (ids.length) await db.query('delete from push_subscriptions where session_id = any($1::uuid[])', [ids]);
      await audit(db, ctx, 'auth.sessions_revoked_others', 'user', ctx.userId, null, { sessions: ids.length });
      return { revoked: ids.length };
    });
  });

  // Звонок в один клик: полный номер отдаётся только для звонка и записывается в журнал. С телефонией здесь будет звонок через АТС клуба.
  app.post('/api/persons/:id/dial', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    if (!can(ctx, P.crmWork) && !can(ctx, P.messagesWork) && !can(ctx, P.acsWork)) throw badRequest('Звонки клиентам недоступны для вашей роли');
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select id from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      const ph = (await db.query(`select normalized_value from person_contacts where person_id = $1 and type = 'phone' order by is_primary desc limit 1`, [id])).rows[0];
      if (!ph?.normalized_value) throw badRequest('У клиента нет телефона', 'no_phone');
      await audit(db, ctx, 'person.dial', 'person', id, null, { via: 'device' });
      return { phone: ph.normalized_value as string, mode: 'device' };
    });
  });
}
