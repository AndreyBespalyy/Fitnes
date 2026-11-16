// Персональные данные (152-ФЗ): тексты согласий с версиями, журнал согласий клиента, обращения клиентов
// (выдать сведения, отозвать согласие, удалить) со сроком 10 рабочих дней, выгрузка данных клиента и обезличивание.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';

export type ConsentKind = 'pd' | 'marketing';
export type ConsentChannel = 'paper' | 'tablet' | 'site' | 'messenger' | 'staff' | 'import';
const CHANNELS: ConsentChannel[] = ['paper', 'tablet', 'site', 'messenger', 'staff', 'import'];
const REQUEST_KINDS = ['access', 'delete', 'revoke', 'correct'] as const;

/** Тексты по умолчанию: сеть заменяет их своими (реквизиты оператора, перечень целей) в разделе «Защита данных». */
export const DEFAULT_TEXTS: Record<ConsentKind, { title: string; body: string }> = {
  pd: {
    title: 'Согласие на обработку персональных данных',
    body: 'Я даю согласие клубу (оператор — юрлицо, указанное в договоре) на обработку моих персональных данных: фамилия, имя, отчество, дата рождения, '
      + 'телефон, e-mail, фотография для пропуска, сведения о посещениях, покупках и оплатах, записи разговоров с клубом. '
      + 'Цели: заключение и исполнение договора, пропуск в клуб, учёт оплат и посещений, связь со мной по вопросам договора, выполнение требований закона. '
      + 'Действия: сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, передача кассе и банку для расчётов '
      + '(54-ФЗ), обезличивание, блокирование, удаление, уничтожение, с использованием средств автоматизации и без них. Данные хранятся в России. '
      + 'Согласие действует до достижения целей обработки или до его отзыва. Отозвать согласие можно письменным заявлением в клубе; '
      + 'после отзыва клуб прекращает обработку, кроме данных, которые обязан хранить по закону (бухгалтерские документы и чеки).',
  },
  marketing: {
    title: 'Согласие на получение рекламных и информационных сообщений',
    body: 'Я согласен получать от клуба сообщения об акциях, новых услугах и специальных предложениях по телефону, в SMS, мессенджерах (Telegram, WhatsApp) '
      + 'и по e-mail (ст. 18 Федерального закона «О рекламе»). Отказаться можно в любой момент: ответить «стоп» на сообщение или сказать сотруднику клуба. '
      + 'Сообщения о договоре, оплатах и посещениях приходят независимо от этого согласия.',
  },
};

/** Действующий текст согласия; если сеть ещё не завела свой, создаётся версия 1 из текста по умолчанию. */
export async function currentConsentText(db: Db, tenantId: string, kind: ConsentKind) {
  const cur = (await db.query('select id, version, title, body, created_at as "createdAt" from consent_texts where tenant_id = $1 and kind = $2 order by version desc limit 1', [tenantId, kind])).rows[0];
  if (cur) return cur as { id: string; version: number; title: string; body: string; createdAt: string };
  await db.query(`insert into consent_texts(tenant_id, kind, version, title, body) values ($1,$2,1,$3,$4) on conflict (tenant_id, kind, version) do nothing`,
    [tenantId, kind, DEFAULT_TEXTS[kind].title, DEFAULT_TEXTS[kind].body]);
  return (await db.query('select id, version, title, body, created_at as "createdAt" from consent_texts where tenant_id = $1 and kind = $2 order by version desc limit 1', [tenantId, kind])).rows[0];
}

/** Записывает согласие или отказ. Для рекламы синхронизирует признак в карточке, по которому работают рассылки. */
export async function recordConsent(db: Db, actor: { tenantId: string; userId: string | null; ip?: string }, personId: string,
  c: { kind: ConsentKind; granted: boolean; channel: ConsentChannel; note?: string | null; textId?: string | null }) {
  const text = c.textId ? { id: c.textId } : await currentConsentText(db, actor.tenantId, c.kind);
  await db.query(`insert into person_consents(tenant_id, person_id, kind, granted, text_id, channel, note, actor_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.tenantId, personId, c.kind, c.granted, text.id, c.channel, c.note ?? null, actor.userId]);
  if (c.kind === 'marketing') {
    await db.query(`update persons set marketing_consent = $2, messaging_changed_at = now() where id = $1`, [personId, c.granted]);
  }
  await audit(db, actor, c.granted ? 'pd.consent_granted' : 'pd.consent_revoked', 'person', personId, null, { kind: c.kind, channel: c.channel, textId: text.id });
}

/** Срок ответа: 10 рабочих дней (пн–пт; праздники клуб учитывает сам, срок можно поправить). */
export function dueInWorkingDays(from: string, days = 10) {
  const d = new Date(`${from}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

async function consentState(db: Db, personId: string) {
  const rows = (await db.query(
    `select pc.id, pc.kind, pc.granted, pc.channel, pc.note, pc.created_at as "at", t.version, t.title, u.full_name as "actorName"
     from person_consents pc left join consent_texts t on t.id = pc.text_id left join users u on u.id = pc.actor_id
     where pc.person_id = $1 order by pc.created_at desc, pc.id`, [personId])).rows;
  const last = (k: ConsentKind) => rows.find((r) => r.kind === k) ?? null;
  return { pd: last('pd'), marketing: last('marketing'), history: rows };
}

const canTakeConsent = (ctx: Ctx) => can(ctx, P.crmWork) || can(ctx, P.membershipsSell) || can(ctx, P.messagesWork) || can(ctx, P.dataProtect);

/** Обезличивание по запросу клиента: контакты удаляются, имя заменяется, переписка и записи разговоров очищаются.
 *  Платежи, договоры, чеки и посещения остаются (их клуб обязан хранить), но больше не связаны с личностью. */
async function anonymize(db: Db, ctx: Ctx, personId: string, reason: string) {
  const p = (await db.query('select id, full_name, anonymized_at from persons where id = $1 for update', [personId])).rows[0];
  if (!p) throw notFound('Клиент не найден');
  if (p.anonymized_at) throw badRequest('Данные клиента уже обезличены');
  const active = (await db.query(`select count(*)::int as n from memberships where person_id = $1 and status = 'active' and (ends_on is null or ends_on >= current_date)`, [personId])).rows[0].n;
  if (active) throw badRequest('У клиента есть действующий абонемент или подписка. Сначала расторгните его в карточке, затем обезличьте данные', 'has_active_membership');
  const debt = (await db.query(`select count(*)::int as n from charges where person_id = $1 and status = 'due'`, [personId])).rows[0].n;
  if (debt) throw badRequest('У клиента есть неоплаченные начисления. Закройте долг или отмените начисления, затем обезличьте данные', 'has_debt');
  const label = `Обезличенный клиент ${personId.slice(0, 8)}`;
  await db.query(`update persons set full_name = $2, birth_date = null, marketing_consent = false, messaging_opt_out = true, autopay_enabled = false,
    anonymized_at = now(), updated_at = now() where id = $1`, [personId, label]);
  await db.query('delete from person_contacts where person_id = $1', [personId]);
  await db.query(`update msg_messages set body = '[удалено по запросу клиента]' where conversation_id in (select id from msg_conversations where person_id = $1)`, [personId]);
  await db.query(`update msg_conversations set title = $2, external_chat_id = 'anon-' || id::text where person_id = $1`, [personId, label]);
  await db.query(`update calls set transcript = null, phone = null where person_id = $1`, [personId]);
  await db.query(`update call_summaries set draft = null, final = null where call_id in (select id from calls where person_id = $1)`, [personId]);
  await db.query(`update tasks set result = null where person_id = $1`, [personId]);
  await db.query(`delete from client_scores where person_id = $1`, [personId]);
  await db.query(`update access_credentials set status = 'blocked' where person_id = $1 and status = 'active'`, [personId]);
  await db.query(`update person_payment_methods set status = 'removed' where person_id = $1 and status = 'active'`, [personId]);
  // Имя не пишем в журнал: в журнале остаётся только факт и причина
  await audit(db, ctx, 'pd.anonymized', 'person', personId, null, { reason });
  return { ok: true, label };
}

/** Все сведения о клиенте, которые хранит система, — для ответа на запрос клиента (ст. 14 152-ФЗ). */
async function personExport(db: Db, personId: string) {
  const q = async (sql: string) => (await db.query(sql, [personId])).rows;
  const person = (await db.query(`select p.full_name as "ФИО", to_char(p.birth_date, 'DD.MM.YYYY') as "Дата рождения", c.name as "Клуб",
      to_char(p.created_at, 'DD.MM.YYYY') as "В базе с", p.segment as "Категория", p.marketing_consent as "Согласие на рекламу"
    from persons p left join clubs c on c.id = p.home_club_id where p.id = $1`, [personId])).rows[0];
  if (!person) throw notFound('Клиент не найден');
  return {
    'Что это': 'Сведения о персональных данных клиента, которые обрабатывает клуб (ст. 14 Федерального закона № 152-ФЗ)',
    'Сформировано': new Date().toISOString(),
    'Клиент': person,
    'Контакты': await q(`select type as "Вид", value as "Значение" from person_contacts where person_id = $1`),
    'Согласия': await q(`select pc.kind as "Вид", pc.granted as "Дано", pc.channel as "Способ", to_char(pc.created_at, 'DD.MM.YYYY HH24:MI') as "Когда", t.version as "Версия текста"
      from person_consents pc left join consent_texts t on t.id = pc.text_id where pc.person_id = $1 order by pc.created_at`),
    'Абонементы': await q(`select product_name as "Тариф", to_char(starts_on, 'DD.MM.YYYY') as "С", to_char(ends_on, 'DD.MM.YYYY') as "По", status as "Статус", amount_kop / 100.0 as "Сумма"
      from memberships where person_id = $1 order by created_at`),
    'Договоры': await q(`select number as "Номер", to_char(contract_date, 'DD.MM.YYYY') as "Дата", status as "Статус", sign_method as "Как подписан" from contracts where person_id = $1 order by contract_date`),
    'Оплаты': await q(`select to_char(created_at, 'DD.MM.YYYY') as "Дата", amount_kop / 100.0 as "Сумма", direction as "Направление", method as "Способ" from payments where person_id = $1 order by created_at`),
    'Посещения': await q(`select to_char(v.visited_at, 'DD.MM.YYYY HH24:MI') as "Дата", c.name as "Клуб" from visits v join clubs c on c.id = v.club_id where v.person_id = $1 order by v.visited_at`),
    'Карты и браслеты': await q(`select kind as "Вид", status as "Статус", to_char(issued_at, 'DD.MM.YYYY') as "Выдана" from access_credentials where person_id = $1`),
    'Переписка, сообщений': (await db.query(`select count(*)::int as n from msg_messages m join msg_conversations c on c.id = m.conversation_id where c.person_id = $1`, [personId])).rows[0].n,
    'Записи разговоров, шт.': (await db.query(`select count(*)::int as n from calls where person_id = $1`, [personId])).rows[0].n,
    'Где хранятся': 'Серверы на территории Российской Федерации',
  };
}

export function pdRoutes(app: FastifyInstance, pool: pg.Pool) {
  /* --- тексты согласий --- */
  app.get('/api/consent-texts', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    return withCtx(pool, ctx, async (db) => {
      await currentConsentText(db, ctx.tenantId, 'pd');
      await currentConsentText(db, ctx.tenantId, 'marketing');
      const rows = (await db.query(`select t.id, t.kind, t.version, t.title, t.body, t.created_at as "createdAt", u.full_name as "authorName",
          (select count(*)::int from person_consents pc where pc.text_id = t.id) as used
        from consent_texts t left join users u on u.id = t.created_by order by t.kind, t.version desc`)).rows;
      return { pd: rows.filter((r) => r.kind === 'pd'), marketing: rows.filter((r) => r.kind === 'marketing') };
    });
  });

  app.post('/api/consent-texts', async (req, reply) => {
    const ctx = requirePerm(req, P.dataProtect);
    if (!ctx.allClubs) throw forbidden('Тексты согласий общие для сети: их меняет собственник');
    const b = (req.body ?? {}) as { kind?: ConsentKind; title?: string; body?: string };
    if (b.kind !== 'pd' && b.kind !== 'marketing') throw badRequest('Выберите вид согласия');
    if (!b.title?.trim() || (b.body?.trim().length ?? 0) < 50) throw badRequest('Заполните заголовок и текст согласия (не короче 50 символов)');
    const r = await withCtx(pool, ctx, async (db) => {
      const cur = await currentConsentText(db, ctx.tenantId, b.kind!);
      if (cur.title === b.title!.trim() && cur.body === b.body!.trim()) throw badRequest('Текст не изменился');
      const row = (await db.query(`insert into consent_texts(tenant_id, kind, version, title, body, created_by) values ($1,$2,$3,$4,$5,$6) returning id, version`,
        [ctx.tenantId, b.kind, cur.version + 1, b.title!.trim(), b.body!.trim(), ctx.userId])).rows[0];
      await audit(db, ctx, 'pd.consent_text_published', 'consent_text', row.id, { version: cur.version }, { kind: b.kind, version: row.version });
      return row;
    });
    reply.code(201);
    return r;
  });

  /* --- согласия клиента --- */
  app.get('/api/persons/:id/consents', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from persons where id = $1', [id])).rowCount) throw notFound('Клиент не найден');
      const state = await consentState(db, id);
      const requests = (await db.query(`select r.id, r.kind, to_char(r.received_on, 'YYYY-MM-DD') as "receivedOn", to_char(r.due_on, 'YYYY-MM-DD') as "dueOn", r.status, r.note, r.result
        from pd_requests r where r.person_id = $1 order by r.created_at desc`, [id])).rows;
      const anon = (await db.query('select anonymized_at from persons where id = $1', [id])).rows[0]?.anonymized_at ?? null;
      return { ...state, requests, anonymizedAt: anon,
        texts: { pd: await currentConsentText(db, ctx.tenantId, 'pd'), marketing: await currentConsentText(db, ctx.tenantId, 'marketing') } };
    });
  });

  app.post('/api/persons/:id/consents', async (req) => {
    const ctx = requireCtx(req);
    if (!canTakeConsent(ctx)) throw forbidden();
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { kind?: ConsentKind; granted?: boolean; channel?: ConsentChannel; note?: string };
    if (b.kind !== 'pd' && b.kind !== 'marketing') throw badRequest('Выберите вид согласия');
    if (typeof b.granted !== 'boolean') throw badRequest('Укажите: согласие дано или отозвано');
    const channel = b.channel ?? 'staff';
    if (!CHANNELS.includes(channel)) throw badRequest('Неизвестный способ получения согласия');
    if (b.granted && b.kind === 'pd' && channel === 'staff') throw badRequest('Укажите, как получено согласие на обработку данных: на бумаге или на планшете');
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select anonymized_at from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      if (p.anonymized_at) throw badRequest('Данные клиента обезличены');
      await recordConsent(db, ctx, id, { kind: b.kind!, granted: b.granted!, channel, note: b.note?.trim() || null });
      return consentState(db, id);
    });
  });

  /* --- обращения клиентов по персональным данным --- */
  app.get('/api/pd-requests', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { clubId, status } = req.query as { clubId?: string; status?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select r.id, r.kind, to_char(r.received_on, 'YYYY-MM-DD') as "receivedOn", to_char(r.due_on, 'YYYY-MM-DD') as "dueOn", r.status, r.note, r.result,
         r.person_id as "personId", p.full_name as "personName", c.name as "clubName", u.full_name as "createdByName", d.full_name as "doneByName", r.done_at as "doneAt",
         (r.status = 'open' and r.due_on < current_date) as overdue
       from pd_requests r join persons p on p.id = r.person_id join clubs c on c.id = r.club_id
       left join users u on u.id = r.created_by left join users d on d.id = r.done_by
       where ($1::uuid is null or r.club_id = $1) and ($2::text is null or r.status = $2)
       order by (r.status = 'open') desc, r.due_on, r.created_at desc limit 300`, [clubId || null, status || null])).rows);
  });

  app.post('/api/persons/:id/pd-requests', async (req, reply) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.dataProtect) && !can(ctx, P.membershipsManage) && !can(ctx, P.crmWork)) throw forbidden();
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { kind?: string; receivedOn?: string; note?: string };
    if (!REQUEST_KINDS.includes(b.kind as typeof REQUEST_KINDS[number])) throw badRequest('Выберите, что просит клиент');
    const received = b.receivedOn && /^\d{4}-\d{2}-\d{2}$/.test(b.receivedOn) ? b.receivedOn : new Date().toISOString().slice(0, 10);
    const r = await withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select home_club_id from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      const due = dueInWorkingDays(received);
      const row = (await db.query(`insert into pd_requests(tenant_id, club_id, person_id, kind, received_on, due_on, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, p.home_club_id, id, b.kind, received, due, b.note?.trim() || null, ctx.userId])).rows[0];
      // Отзыв согласия на рекламу выполняется сразу, на обработку данных — фиксируется сразу, а обработку прекращает руководитель
      if (b.kind === 'revoke') await recordConsent(db, ctx, id, { kind: 'marketing', granted: false, channel: 'paper', note: 'Обращение клиента' });
      // Задача управляющему клуба со сроком ответа
      const gm = (await db.query(`select a.user_id from user_assignments a join users u on u.id = a.user_id where a.club_id = $1 and a.role_code = 'gm' and u.status = 'active' limit 1`, [p.home_club_id])).rows[0];
      const KIND: Record<string, string> = { access: 'выдать сведения о данных', delete: 'удалить данные', revoke: 'отозвать согласие', correct: 'исправить данные' };
      await db.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, kind, title, due_at) values ($1,$2,$3,$4,'other',$5, ($6::date + interval '18 hours'))`,
        [ctx.tenantId, p.home_club_id, gm?.user_id ?? ctx.userId, id, `Обращение по персональным данным: ${KIND[b.kind!]}. Ответить до ${due.split('-').reverse().join('.')}`, due]);
      await audit(db, ctx, 'pd.request_created', 'person', id, null, { kind: b.kind, receivedOn: received, dueOn: due });
      return { id: row.id, dueOn: due };
    });
    reply.code(201);
    return r;
  });

  app.post('/api/pd-requests/:id/complete', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: 'done' | 'rejected'; result?: string };
    if (b.status !== 'done' && b.status !== 'rejected') throw badRequest('Укажите итог');
    if (!b.result?.trim()) throw badRequest('Опишите, что сделано или почему отказано: это ответ клиенту');
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query(`update pd_requests set status = $2, result = $3, done_by = $4, done_at = now() where id = $1 and status = 'open' returning person_id, kind`,
        [id, b.status, b.result!.trim(), ctx.userId])).rows[0];
      if (!r) throw notFound('Обращение не найдено или уже закрыто');
      await audit(db, ctx, 'pd.request_closed', 'pd_request', id, null, { status: b.status });
      return { ok: true };
    });
  });

  app.get('/api/persons/:id/pd-export', async (req, reply) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { id } = req.params as { id: string };
    const data = await withCtx(pool, ctx, async (db) => {
      const d = await personExport(db, id);
      await audit(db, ctx, 'pd.exported_for_client', 'person', id, null, null);
      return d;
    });
    reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="personal-data.json"; filename*=UTF-8''${encodeURIComponent('Сведения о данных клиента')}.json`);
    return reply.send(JSON.stringify(data, null, 2));
  });

  app.post('/api/persons/:id/anonymize', async (req) => {
    const ctx = requirePerm(req, P.dataProtect);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string; requestId?: string; confirm?: string };
    if (!b.reason?.trim()) throw badRequest('Укажите основание: например, «заявление клиента от 12.11.2026»');
    if (b.confirm !== 'ОБЕЗЛИЧИТЬ') throw badRequest('Для подтверждения введите слово ОБЕЗЛИЧИТЬ');
    return withCtx(pool, ctx, async (db) => {
      const res = await anonymize(db, ctx, id, b.reason!.trim());
      if (b.requestId) {
        await db.query(`update pd_requests set status = 'done', result = coalesce(result, 'Данные обезличены'), done_by = $2, done_at = now() where id = $1 and person_id = $3 and status = 'open'`,
          [b.requestId, ctx.userId, id]);
      }
      return res;
    });
  });
}
