// Приём заявок с сайта, Tilda, VK и Авито (список «20 улучшений», п. 16).
// У подключения своя секретная ссылка /api/public/v1/intake/<ключ>. Заявка становится лидом с источником,
// антидублями и задачей первого ответа, как и заявки, введённые вручную.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { createLead, normalizePhone, type LeadInput } from './crm.ts';
import { decrypt, encrypt } from './fiscal.ts';

type Fetch = typeof fetch;
type Kind = 'site' | 'tilda' | 'vk' | 'avito';
const KINDS: Kind[] = ['site', 'tilda', 'vk', 'avito'];
const NAMES: Record<Kind, string> = { site: 'Форма на сайте', tilda: 'Tilda', vk: 'ВКонтакте: формы сбора заявок', avito: 'Авито: сообщения' };
// Источник по умолчанию: код в справочнике, название, канал
const SOURCE: Record<Kind, [string, string, string]> = { site: ['site', 'Сайт', 'site'], tilda: ['site', 'Сайт', 'site'], vk: ['vk', 'ВКонтакте', 'ads'], avito: ['avito', 'Авито', 'ads'] };
const LIMIT_PER_IP = 10; // заявок с одного адреса за 10 минут на подключение
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const base = (req: FastifyRequest) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');

type Fields = { name?: string; phone?: string; email?: string; comment?: string; utm?: Record<string, string>; externalId?: string; contact?: { type: 'vk' | 'avito'; value: string; normalized: string } };
type Parsed = { reply?: string; skip?: string; lead?: Fields; test?: boolean; deny?: string };

/** Поля обычной формы или Tilda: имена полей задаёт владелец сайта, ищем по смыслу */
export function mapFields(b: Record<string, unknown>): Fields {
  const f: Fields = {};
  const extra: string[] = [];
  const utm: Record<string, string> = {};
  for (const [k0, v0] of Object.entries(b)) {
    if (v0 == null || typeof v0 === 'object') continue;
    const k = k0.toLowerCase().replace(/[\s_-]/g, ''); const v = String(v0).trim().slice(0, 1000);
    if (!v) continue;
    if (k0.toLowerCase().startsWith('utm_')) { utm[k0.toLowerCase()] = v.slice(0, 200); continue; }
    if (['tranid', 'formid', 'formname', 'cookies', 'website', 'test', 'token', 'consent', 'agree'].includes(k)) continue;
    if (!f.phone && /phone|tel|телефон|номер/.test(k)) f.phone = v;
    else if (!f.email && /email|mail|почта/.test(k)) f.email = v;
    else if (!f.name && /^(name|fio|фио|имя|firstname|clientname|yourname)$/.test(k)) f.name = v;
    else if (!f.comment && /comment|message|textarea|вопрос|сообщение|комментарий/.test(k)) f.comment = v;
    else extra.push(`${k0}: ${v}`);
  }
  if (extra.length) f.comment = [f.comment, ...extra.slice(0, 10)].filter(Boolean).join('\n');
  if (Object.keys(utm).length) f.utm = utm;
  if (b.tranid) f.externalId = String(b.tranid).slice(0, 100);
  return f;
}

export function parseVk(b: Record<string, unknown>, s: { confirmation?: string; groupId?: string; secret?: string | null }): Parsed {
  if (s.secret && !(typeof b.secret === 'string' && b.secret.length === s.secret.length && timingSafeEqual(Buffer.from(b.secret), Buffer.from(s.secret)))) return { deny: 'Неверный секретный ключ VK', reply: 'ok' };
  if (b.type === 'confirmation') return { reply: s.confirmation || 'ok', skip: 'Подтверждение адреса сервера' };
  if (b.type !== 'lead_forms_new') return { reply: 'ok', skip: `Событие VK «${String(b.type ?? '?')}» не нужно для заявок` };
  const o = (b.object ?? {}) as { lead_id?: number; user_id?: number; form_name?: string; answers?: { key?: string; question?: string; answer?: unknown }[] };
  const ans = Object.fromEntries((o.answers ?? []).map((a) => [a.key ?? a.question ?? '', String(a.answer ?? '')]));
  const name = [ans.first_name, ans.last_name].filter(Boolean).join(' ') || ans.name || undefined;
  const other = (o.answers ?? []).filter((a) => !['first_name', 'last_name', 'phone_number', 'email', 'name'].includes(a.key ?? '')).map((a) => `${a.question ?? a.key}: ${a.answer}`);
  return {
    reply: 'ok',
    lead: {
      name, phone: ans.phone_number || undefined, email: ans.email || undefined,
      comment: [`Форма VK «${o.form_name ?? ''}»`, ...other].join('\n'),
      externalId: o.lead_id ? `vk:${o.lead_id}` : undefined,
      contact: o.user_id ? { type: 'vk', value: `https://vk.com/id${o.user_id}`, normalized: `vk:${o.user_id}` } : undefined,
    },
  };
}

export function parseAvito(b: Record<string, unknown>, s: { userId?: string }): Parsed {
  const v = ((b.payload as { value?: unknown } | undefined)?.value ?? {}) as { chat_id?: string; author_id?: number; user_id?: number; content?: { text?: string }; item_id?: number; created?: number };
  if ((b.payload as { type?: string } | undefined)?.type !== 'message' || !v.chat_id) return { reply: 'ok', skip: 'Не сообщение' };
  if (!v.author_id || String(v.author_id) === String(v.user_id ?? s.userId)) return { reply: 'ok', skip: 'Своё сообщение' };
  const day = new Date((v.created ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  return {
    reply: 'ok',
    lead: {
      name: 'Клиент с Авито',
      comment: [`Сообщение на Авито${v.item_id ? ` по объявлению ${v.item_id}` : ''}:`, v.content?.text ?? '(без текста)', 'Ответить можно в мессенджере Авито'].join('\n'),
      // Одна заявка на переписку в день: следующие сообщения того же дня — дубль
      externalId: `avito:${v.chat_id}:${day}`,
      contact: { type: 'avito', value: `Авито, чат ${v.chat_id}`, normalized: `avito:${v.author_id}` },
    },
  };
}

async function sourceFor(db: Db, tenantId: string, kind: Kind) {
  const [code, name, channel] = SOURCE[kind];
  const s = (await db.query('select id from lead_sources where code = $1', [code])).rows[0];
  if (s) return s.id as string;
  return (await db.query('insert into lead_sources(tenant_id, code, name, channel) values ($1,$2,$3,$4) returning id', [tenantId, code, name, channel])).rows[0].id as string;
}

/** Подключения клуба настраивает администратор (источники) или управляющий своего клуба */
const manager = (req: FastifyRequest) => { const ctx = requireCtx(req); if (!can(ctx, P.sourcesManage) && !can(ctx, P.configManage)) throw forbidden(); return ctx; };
const newToken = () => `li_${randomBytes(24).toString('base64url')}`;
const view = (r: Record<string, unknown>) => {
  const s = (r.settings ?? {}) as Record<string, unknown>;
  return { id: r.id, clubId: r.club_id, sourceId: r.source_id, sourceName: r.source_name, kind: r.kind, name: r.name, tokenHint: r.token_hint, isActive: r.is_active,
    createdAt: r.created_at, lastAt: r.last_at, leads: r.leads, errors: r.errors,
    settings: { confirmation: s.confirmation ?? null, groupId: s.groupId ?? null, hasSecret: !!s.secretEnc, clientId: s.clientId ?? null, hasClientSecret: !!s.clientSecretEnc, avitoUserId: s.userId ?? null, webhookAt: s.webhookAt ?? null } };
};

export function leadIntakeRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;
  const LIST = `select i.*, s.name as source_name from lead_intakes i join lead_sources s on s.id = i.source_id`;

  /* ---------- приём ---------- */
  const cors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'POST, OPTIONS').header('access-control-allow-headers', 'content-type');
  app.options('/api/public/v1/intake/:token', async (_req, reply) => { cors(reply); reply.code(204); return ''; });

  app.post('/api/public/v1/intake/:token', async (req, reply) => {
    cors(reply);
    const { token } = req.params as { token: string };
    const it = (await pool.query('select * from auth_lead_intake($1)', [sha(token)])).rows[0];
    if (!it) throw notFound('Подключение не найдено или выключено');
    const b = (typeof req.body === 'object' && req.body ? req.body : {}) as Record<string, unknown>;
    return withCtx(pool, { tenantId: it.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const row = (await db.query('select * from lead_intakes where id = $1', [it.intake_id])).rows[0];
      const kind = row.kind as Kind; const s = row.settings as Record<string, string>;
      const log = (status: string, message: string | null, leadId: string | null = null) => db.query(
        'insert into lead_intake_log(tenant_id, club_id, intake_id, status, message, lead_id, ip) values ($1,$2,$3,$4,$5,$6,$7)',
        [row.tenant_id, row.club_id, row.id, status, message?.slice(0, 300) ?? null, leadId, req.ip]);
      let p: Parsed;
      if (kind === 'vk') p = parseVk(b, { confirmation: s.confirmation, secret: s.secretEnc ? decrypt(s.secretEnc) : null });
      else if (kind === 'avito') p = parseAvito(b, { userId: s.userId });
      else if (kind === 'tilda' && (b.test === 'test' || (Object.keys(b).length === 1 && 'test' in b))) p = { reply: 'ok', test: true };
      else if (typeof b.website === 'string' && b.website.trim()) p = { reply: 'ok', skip: 'Заполнено скрытое поле — похоже на робота' };
      else p = { reply: 'ok', lead: mapFields(b), test: b.test === true || b.test === 'true' };
      const done = (status: number, body: unknown) => {
        if (kind === 'vk' || kind === 'tilda') { reply.type('text/plain; charset=utf-8'); return p.reply ?? 'ok'; }
        reply.code(kind === 'avito' ? 200 : status); return body; // Авито повторяет запросы при ошибке — отвечаем 200, ошибка в журнале
      };
      if (p.deny) { await log('error', p.deny); await db.query('update lead_intakes set errors = errors + 1 where id = $1', [row.id]); return done(403, { ok: false }); }
      if (p.test && !p.lead?.phone && !p.lead?.email) { await log('test', 'Проверка подключения'); await db.query('update lead_intakes set last_at = now() where id = $1', [row.id]); return done(200, { ok: true, test: true }); }
      if (p.skip || !p.lead) { await log('skipped', p.skip ?? 'Пустой запрос'); return done(200, { ok: true }); }
      const recent = (await db.query(`select count(*)::int as n from lead_intake_log where intake_id = $1 and ip = $2 and at > now() - interval '10 minutes' and status in ('lead', 'duplicate', 'error', 'test')`, [row.id, req.ip])).rows[0].n;
      if (kind !== 'vk' && kind !== 'avito' && recent >= LIMIT_PER_IP) {
        await log('limited', `Больше ${LIMIT_PER_IP} заявок за 10 минут с одного адреса`);
        return done(429, { error: 'limited', message: 'Слишком много заявок подряд. Попробуйте позже или позвоните в клуб' });
      }
      const L = p.lead;
      try {
        if (p.test) {
          if (L.phone && !normalizePhone(L.phone)) throw badRequest('Телефон указан неверно. Нужен номер вида +7 900 000-00-00');
          if (!L.phone && !L.email) throw badRequest('Укажите телефон или e-mail');
          await log('test', 'Проверочная заявка: данные верные, лид не создан');
          await db.query('update lead_intakes set last_at = now() where id = $1', [row.id]);
          return done(200, { ok: true, test: true, message: 'Проверочная заявка принята. Клиент и сделка не созданы' });
        }
        const input: LeadInput = { clubId: row.club_id, sourceId: row.source_id, fullName: L.name?.slice(0, 100), phone: L.phone, email: L.email,
          comment: [`Заявка: ${row.name}`, L.comment].filter(Boolean).join('\n').slice(0, 2000), utm: L.utm, campaign: L.utm?.utm_campaign,
          externalEventId: L.externalId, contact: L.contact as LeadInput['contact'] };
        const r = await createLead(db, { tenantId: row.tenant_id, userId: null, ip: req.ip }, input);
        await log(r.idempotent ? 'duplicate' : 'lead', r.idempotent ? 'Эта заявка уже принята' : r.duplicate ? 'Повторное обращение известного клиента' : 'Новый лид', r.leadId);
        await db.query(`update lead_intakes set last_at = now(), leads = leads + $2 where id = $1`, [row.id, r.idempotent ? 0 : 1]);
        return done(201, { ok: true, message: 'Спасибо! Мы свяжемся с вами в ближайшее время' });
      } catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        await log('error', e.message);
        await db.query('update lead_intakes set errors = errors + 1, last_at = now() where id = $1', [row.id]);
        // Журнал ошибки сохраняется: ответ без исключения, чтобы не откатить запись
        return done(e.status, { error: e.code, message: e.message });
      }
    });
  });

  /* ---------- настройка ---------- */
  app.get('/api/intake', async (req) => {
    const ctx = manager(req);
    const q = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const list = (await db.query(`${LIST} where ($1::uuid is null or i.club_id = $1) order by i.created_at`, [q.clubId && q.clubId !== 'all' ? q.clubId : null])).rows.map(view);
      const log = (await db.query(`select l.at, l.status, l.message, l.lead_id as "leadId", i.name as intake, p.full_name as person, p.id as "personId"
        from lead_intake_log l join lead_intakes i on i.id = l.intake_id left join leads ld on ld.id = l.lead_id left join persons p on p.id = ld.person_id
        where ($1::uuid is null or l.club_id = $1) order by l.at desc limit 50`, [q.clubId && q.clubId !== 'all' ? q.clubId : null])).rows;
      const sources = (await db.query(`select id, name from lead_sources where is_active order by name`)).rows;
      return { list, log, sources, kinds: KINDS.map((k) => ({ kind: k, name: NAMES[k] })) };
    });
  });

  const settingsIn = (kind: Kind, s: Record<string, unknown> = {}, prev: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = { ...prev };
    if (kind === 'vk') {
      if (s.confirmation !== undefined) out.confirmation = String(s.confirmation ?? '').trim().slice(0, 40) || null;
      if (s.groupId !== undefined) out.groupId = String(s.groupId ?? '').trim().slice(0, 20) || null;
      if (typeof s.secret === 'string') out.secretEnc = s.secret.trim() ? encrypt(s.secret.trim()) : null;
    }
    if (kind === 'avito') {
      if (s.clientId !== undefined) out.clientId = String(s.clientId ?? '').trim().slice(0, 100) || null;
      if (typeof s.clientSecret === 'string' && s.clientSecret.trim()) out.clientSecretEnc = encrypt(s.clientSecret.trim());
    }
    return out;
  };

  app.post('/api/intake', async (req, reply) => {
    const ctx = manager(req);
    const b = (req.body ?? {}) as { clubId?: string; kind?: Kind; name?: string; sourceId?: string; settings?: Record<string, unknown> };
    if (!b.kind || !KINDS.includes(b.kind)) throw badRequest('Выберите, откуда принимать заявки');
    if (!b.clubId || b.clubId === 'all') throw badRequest('Выберите клуб: заявки попадут в его воронку');
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      const sourceId = b.sourceId && (await db.query('select 1 from lead_sources where id = $1', [b.sourceId])).rowCount ? b.sourceId : await sourceFor(db, ctx.tenantId, b.kind!);
      const token = newToken();
      const id = (await db.query(`insert into lead_intakes(tenant_id, club_id, source_id, kind, name, token_hash, token_hint, settings, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, b.clubId, sourceId, b.kind, (b.name?.trim() || NAMES[b.kind!]).slice(0, 100), sha(token), token.slice(-4), JSON.stringify(settingsIn(b.kind!, b.settings)), ctx.userId])).rows[0].id;
      await audit(db, ctx, 'intake.created', 'lead_intake', id, null, { kind: b.kind, clubId: b.clubId });
      return { intake: view((await db.query(`${LIST} where i.id = $1`, [id])).rows[0]), url: `${base(req)}/api/public/v1/intake/${token}` };
    });
    reply.code(201);
    return res;
  });

  app.put('/api/intake/:id', async (req) => {
    const ctx = manager(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; isActive?: boolean; sourceId?: string; settings?: Record<string, unknown> };
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query('select * from lead_intakes where id = $1', [id])).rows[0];
      if (!r) throw notFound('Подключение не найдено');
      const sourceId = b.sourceId && (await db.query('select 1 from lead_sources where id = $1', [b.sourceId])).rowCount ? b.sourceId : r.source_id;
      await db.query('update lead_intakes set name = $2, is_active = $3, source_id = $4, settings = $5 where id = $1',
        [id, (b.name?.trim() || r.name).slice(0, 100), b.isActive ?? r.is_active, sourceId, JSON.stringify(settingsIn(r.kind, b.settings, r.settings))]);
      await audit(db, ctx, 'intake.updated', 'lead_intake', id, { isActive: r.is_active }, { isActive: b.isActive ?? r.is_active });
      return view((await db.query(`${LIST} where i.id = $1`, [id])).rows[0]);
    });
  });

  // Новая ссылка: старая сразу перестаёт работать (утекла или сотрудник уволился)
  app.post('/api/intake/:id/token', async (req) => {
    const ctx = manager(req);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from lead_intakes where id = $1', [id])).rowCount) throw notFound('Подключение не найдено');
      const token = newToken();
      await db.query('update lead_intakes set token_hash = $2, token_hint = $3 where id = $1', [id, sha(token), token.slice(-4)]);
      await audit(db, ctx, 'intake.token_reissued', 'lead_intake', id, null, null);
      return { url: `${base(req)}/api/public/v1/intake/${token}` };
    });
  });

  // Авито: получить ключ доступа по Client ID и Client Secret и подписать нашу ссылку на новые сообщения
  app.post('/api/intake/:id/avito/connect', async (req) => {
    const ctx = manager(req);
    const { id } = req.params as { id: string };
    const { url } = (req.body ?? {}) as { url?: string };
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query('select * from lead_intakes where id = $1', [id])).rows[0];
      if (!r || r.kind !== 'avito') throw notFound('Подключение Авито не найдено');
      const s = r.settings as Record<string, string>;
      if (!s.clientId || !s.clientSecretEnc) throw badRequest('Укажите Client ID и Client Secret из кабинета Авито (раздел «Для профессионалов» → API)');
      if (!url || !url.includes('/api/public/v1/intake/li_')) throw badRequest('Вставьте ссылку подключения, которую показали при создании (или выпустите новую)');
      const tr = await f('https://api.avito.ru/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: decrypt(s.clientSecretEnc) }).toString() });
      const tj = (await tr.json().catch(() => ({}))) as { access_token?: string };
      if (!tr.ok || !tj.access_token) throw badRequest('Авито не принял Client ID и Client Secret. Проверьте их в кабинете Авито');
      const auth = { authorization: `Bearer ${tj.access_token}` };
      const me = (await (await f('https://api.avito.ru/core/v1/accounts/self', { headers: auth })).json().catch(() => ({}))) as { id?: number };
      const wr = await f('https://api.avito.ru/messenger/v3/webhook', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      if (!wr.ok) throw badRequest('Авито не подключил получение сообщений. Проверьте, что у аккаунта есть доступ к мессенджеру по API');
      await db.query('update lead_intakes set settings = settings || $2 where id = $1', [id, JSON.stringify({ userId: me.id ? String(me.id) : null, webhookAt: new Date().toISOString() })]);
      await audit(db, ctx, 'intake.avito_connected', 'lead_intake', id, null, null);
      return { ok: true, avitoUserId: me.id ?? null };
    });
  });
}
