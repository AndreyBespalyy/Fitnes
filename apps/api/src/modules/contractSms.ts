// Подпись договора кодом из СМС — простая электронная подпись (список «20 улучшений», п. 17).
// В клубе: сотрудник отправляет код на телефон клиента, клиент вводит его на экране подписания.
// Удалённо: клиенту приходит ссылка, он открывает договор и правила, получает код и подписывает сам.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { normalizePhone } from './crm.ts';
import { decrypt, encrypt } from './fiscal.ts';

type Fetch = typeof fetch;
type Actor = { tenantId: string; userId: string | null; ip?: string };
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES = 5;
const RESEND_SEC = 60;
const LINK_DAYS = 3;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mask = (p: string) => `${p.slice(0, 2)} ••• •••-${p.slice(-4, -2)}-${p.slice(-2)}`;
const base = (req: FastifyRequest) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
const codeHash = (requestId: string, code: string) => sha(`${requestId}:${code}`);

/* ---------- отправка СМС ---------- */
export async function smsSettings(db: Db) {
  const s = (await db.query('select * from sms_settings')).rows[0];
  return { provider: (s?.provider ?? 'test') as 'test' | 'smsru' | 'smsc', sender: s?.sender ?? null, login: s?.login ?? null, secret: s?.secret_enc ? decrypt(s.secret_enc) : null };
}

/** Отправляет СМС через провайдера сети. Текст в журнал пишется с замаскированным кодом. */
export async function sendSms(db: Db, f: Fetch, a: { tenantId: string; clubId: string | null; phone: string; text: string; logText?: string }) {
  const s = await smsSettings(db);
  let status: 'sent' | 'failed' | 'test' = 'test'; let error: string | null = null;
  if (s.provider !== 'test') {
    if (!s.secret) throw badRequest('СМС не настроены: укажите ключ провайдера в разделе «Договоры» → «СМС для подписи»');
    try {
      const to = a.phone.replace(/^\+/, '');
      const r = s.provider === 'smsru'
        ? await f('https://sms.ru/sms/send', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ api_id: s.secret, to, msg: a.text, json: '1', ...(s.sender ? { from: s.sender } : {}) }).toString() })
        : await f('https://smsc.ru/sys/send.php', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ login: s.login ?? '', psw: s.secret, phones: to, mes: a.text, fmt: '3', charset: 'utf-8', ...(s.sender ? { sender: s.sender } : {}) }).toString() });
      const j = (await r.json().catch(() => ({}))) as { status?: string; status_text?: string; error?: string; sms?: Record<string, { status?: string; status_text?: string }> };
      const one = j.sms ? Object.values(j.sms)[0] : undefined;
      const ok = r.ok && (s.provider === 'smsru' ? j.status === 'OK' && (!one || one.status === 'OK') : !j.error);
      status = ok ? 'sent' : 'failed';
      if (!ok) error = String(one?.status_text ?? j.status_text ?? j.error ?? `HTTP ${r.status}`).slice(0, 200);
    } catch (e) { status = 'failed'; error = String((e as Error).message).slice(0, 200); }
  }
  await db.query('insert into sms_outbox(tenant_id, club_id, to_phone, text, provider, status, error) values ($1,$2,$3,$4,$5,$6,$7)',
    [a.tenantId, a.clubId, a.phone, a.logText ?? a.text, s.provider, status, error]);
  if (status === 'failed') throw badRequest(`СМС не отправлено: ${error}. Проверьте настройки СМС или подпишите договор на планшете`);
  return { status, test: s.provider === 'test' };
}

/* ---------- запрос на подпись ---------- */
async function contractFor(db: Db, id: string) {
  const c = (await db.query(`select c.*, cl.name as club_name,
      (select normalized_value from person_contacts pc where pc.person_id = c.person_id and pc.type = 'phone' order by is_primary desc limit 1) as phone
    from contracts c join clubs cl on cl.id = c.club_id where c.id = $1`, [id])).rows[0];
  if (!c) throw notFound('Договор не найден');
  if (c.status !== 'awaiting_signature') throw badRequest(c.status === 'signed' ? 'Договор уже подписан' : 'Договор расторгнут');
  if (!c.legal_entity) throw badRequest('В договоре нет реквизитов клуба. Управляющий заполняет их в разделе «Договоры»');
  return c;
}

async function openRequest(db: Db, ctx: Actor, c: { id: string; tenant_id: string; club_id: string; phone: string | null }, phoneIn?: string) {
  const phone = phoneIn ? normalizePhone(phoneIn) : c.phone;
  if (!phone) throw badRequest(phoneIn ? 'Телефон указан неверно. Нужен номер вида +7 900 000-00-00' : 'У клиента нет телефона. Добавьте его в карточку или подпишите на планшете');
  let r = (await db.query(`select * from contract_sign_requests where contract_id = $1 and status = 'active' and phone = $2 order by created_at desc limit 1`, [c.id, phone])).rows[0];
  if (!r) {
    await db.query(`update contract_sign_requests set status = 'cancelled' where contract_id = $1 and status = 'active'`, [c.id]);
    r = (await db.query(`insert into contract_sign_requests(tenant_id, club_id, contract_id, phone, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [c.tenant_id, c.club_id, c.id, phone, ctx.userId])).rows[0];
  }
  return r;
}

async function sendCode(db: Db, f: Fetch, ctx: Actor, r: { id: string; tenant_id: string; club_id: string; phone: string; code_sent_at: string | null; codes_sent: number }, c: { number: string; club_name: string }) {
  if (r.codes_sent >= MAX_CODES) throw badRequest('Код отправляли уже 5 раз. Подпишите договор на планшете или на бумаге');
  if (r.code_sent_at && Date.now() - new Date(r.code_sent_at).getTime() < RESEND_SEC * 1000) {
    throw new HttpError(429, `Новый код можно запросить через ${Math.ceil((RESEND_SEC * 1000 - (Date.now() - new Date(r.code_sent_at).getTime())) / 1000)} с`, 'too_soon');
  }
  const code = String(randomInt(100000, 1000000));
  const text = `Код ${code} — подпись договора № ${c.number} с ${c.club_name}. Никому не сообщайте его, кроме администратора клуба при подписании.`;
  const res = await sendSms(db, f, { tenantId: r.tenant_id, clubId: r.club_id, phone: r.phone, text, logText: text.replace(code, '••••••') });
  await db.query(`update contract_sign_requests set code_hash = $2, code_sent_at = now(), code_expires_at = now() + make_interval(mins => $3), codes_sent = codes_sent + 1, attempts = 0 where id = $1`,
    [r.id, codeHash(r.id, code), CODE_TTL_MIN]);
  await audit(db, { tenantId: r.tenant_id, userId: ctx.userId, ip: ctx.ip }, 'contract.sms_code_sent', 'contract', (r as unknown as { contract_id: string }).contract_id, null, { phone: mask(r.phone) });
  return { phoneMasked: mask(r.phone), expiresInMin: CODE_TTL_MIN, testCode: res.test ? code : undefined };
}

/** Проверка кода и подпись. Неверный код — счётчик попыток (сохраняется, даже если вернём ошибку). */
async function confirm(db: Db, ctx: Actor, r: Record<string, unknown>, code: string, meta: { ip: string; ua: string; acceptedBy: string | null }) {
  if (!r.code_hash || !r.code_expires_at) return { error: 'Сначала получите код' };
  if (new Date(r.code_expires_at as string) < new Date()) return { error: 'Код истёк. Запросите новый' };
  if ((r.attempts as number) >= MAX_ATTEMPTS) return { error: 'Слишком много неверных попыток. Запросите новый код' };
  const a = Buffer.from(codeHash(r.id as string, code.replace(/\D/g, ''))); const b = Buffer.from(r.code_hash as string);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await db.query('update contract_sign_requests set attempts = attempts + 1 where id = $1', [r.id]);
    const left = MAX_ATTEMPTS - (r.attempts as number) - 1;
    return { error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Неверный код. Попытки закончились, запросите новый код' };
  }
  const c = (await db.query(`select id, status, contract_doc_id, rules_doc_id from contracts where id = $1 for update`, [r.contract_id])).rows[0];
  if (c.status !== 'awaiting_signature') return { error: c.status === 'signed' ? 'Договор уже подписан' : 'Договор расторгнут' };
  const hashes = (await db.query(`select string_agg(d.kind || ':' || f.sha256, ';' order by d.kind) as h from club_documents d join files f on f.id = d.file_id
    where d.id = any($1)`, [[c.contract_doc_id, c.rules_doc_id].filter(Boolean)])).rows[0].h;
  await db.query(`update contracts set status = 'signed', sign_method = 'sms', signed_at = now(), accepted_by = $2, signer_phone = $3, signed_docs_sha256 = $4,
      signer_ip = $5, signer_user_agent = $6 where id = $1`, [c.id, meta.acceptedBy, r.phone, hashes, meta.ip, meta.ua.slice(0, 300)]);
  await db.query(`update contract_sign_requests set status = 'signed', confirmed_at = now() where id = $1`, [r.id]);
  await audit(db, { tenantId: r.tenant_id as string, userId: ctx.userId, ip: meta.ip }, 'contract.signed', 'contract', c.id, { status: 'awaiting_signature' },
    { status: 'signed', method: 'sms', phone: mask(r.phone as string), remote: !meta.acceptedBy });
  return { ok: true };
}

/* ---------- страница удалённой подписи ---------- */
type PageData = { clubName: string; number: string; date: string; person: string; product: string | null; period: string | null; price: string | null; docs: { kind: string; title: string }[]; phone: string };
function signPage(token: string, v: PageData | null, st: { stage?: 'start' | 'code' | 'done'; err?: string; testCode?: string; info?: string } = {}) {
  const t = esc(token);
  const body = !v ? '<h1>Ссылка недействительна</h1><p>Срок ссылки истёк или договор уже подписан. Попросите клуб прислать новую ссылку.</p>'
    : st.stage === 'done' ? `<h1>Договор подписан</h1><p>Договор № ${esc(v.number)} с ${esc(v.clubName)} подписан кодом из СМС. Копию договора и правил можно получить в клубе.</p>`
    : `<h1>Договор № ${esc(v.number)} от ${esc(v.date)}</h1>
      <p>${esc(v.clubName)} · ${esc(v.person)}</p>
      ${v.product ? `<p><b>${esc(v.product)}</b>${v.period ? `<br>${esc(v.period)}` : ''}${v.price ? `<br>${esc(v.price)}` : ''}</p>` : ''}
      <p>Прочитайте документы:</p>${docsList(t, v)}
      ${st.stage === 'code' ? `<form method="post" action="/sign/${t}/confirm">
          <p>Код отправлен на ${esc(v.phone)}. ${st.info ? esc(st.info) : ''}</p>
          ${st.testCode ? `<p class="t">Тестовый режим: СМС не отправлялось, код ${esc(st.testCode)}</p>` : ''}
          <label>Код из СМС<input name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"></label>
          <label class="c"><input type="checkbox" name="accepted" value="1" required> Я ознакомлен(а) с договором и правилами клуба и согласен(на) с ними. Ввод кода из СМС — моя простая электронная подпись</label>
          <button>Подписать договор</button>${st.err ? `<p id="m" role="alert">${esc(st.err)}</p>` : ''}
        </form>
        <form method="post" action="/sign/${t}/code"><button class="s">Прислать код ещё раз</button></form>`
      : `<form method="post" action="/sign/${t}/code"><p>Для подписи пришлём код на ${esc(v.phone)}.</p><button>Получить код</button>${st.err ? `<p id="m" role="alert">${esc(st.err)}</p>` : ''}</form>`}`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Подписание договора</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f6f5;color:#142320;margin:0;padding:24px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #d8e2df;border-radius:14px;padding:24px}
h1{font-size:22px;margin:0 0 12px}label{display:grid;gap:4px;margin:12px 0;font-size:14px}label.c{display:flex;gap:8px;align-items:flex-start}input{font:inherit;padding:10px;border:1px solid #c5d3cf;border-radius:8px;font-size:20px;letter-spacing:4px;box-sizing:border-box;width:100%}
input[type=checkbox]{margin-top:3px;width:auto;flex:none}button{font:inherit;font-weight:600;background:#127a6e;color:#fff;border:0;border-radius:8px;padding:12px 18px;width:100%;cursor:pointer;margin-top:6px}button.s{background:#fff;color:#127a6e;border:1px solid #127a6e}
#m{color:#a33;font-size:14px}.t{background:#fff6d6;padding:8px;border-radius:8px;font-size:14px}ul{padding-left:18px}a{color:#127a6e}</style>
</head><body><main>${body}</main></body></html>`;
}
const docsList = (t: string, v: PageData) => v.docs.length
  ? `<ul>${v.docs.map((d) => `<li><a href="/sign/${t}/doc/${esc(d.kind)}" target="_blank" rel="noopener">${esc(d.title)} (PDF)</a></li>`).join('')}</ul>`
  : '<p>Текст договора и правил — в клубе.</p>';

/* ---------- маршруты ---------- */
export function contractSmsRoutes(app: FastifyInstance, pool: pg.Pool, storage: string, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;
  const net = (ctx: Ctx) => { if (!ctx.allClubs || !(can(ctx, '*') || can(ctx, P.contractsManage))) throw forbidden('СМС настраивает собственник или администратор сети'); };

  app.get('/api/sms/settings', async (req) => {
    const ctx = requireCtx(req); net(ctx);
    return withCtx(pool, ctx, async (db) => {
      const s = (await db.query('select provider, sender, login, secret_enc is not null as "hasSecret", updated_at as "updatedAt" from sms_settings')).rows[0]
        ?? { provider: 'test', sender: null, login: null, hasSecret: false, updatedAt: null };
      const outbox = (await db.query(`select to_phone as phone, text, provider, status, error, created_at as "at" from sms_outbox order by created_at desc limit 20`)).rows
        .map((r) => ({ ...r, phone: mask(r.phone) }));
      return { ...s, outbox };
    });
  });

  app.put('/api/sms/settings', async (req) => {
    const ctx = requireCtx(req); net(ctx);
    const b = (req.body ?? {}) as { provider?: string; sender?: string; login?: string; secret?: string };
    if (!['test', 'smsru', 'smsc'].includes(b.provider ?? '')) throw badRequest('Выберите провайдера СМС');
    if (b.provider === 'smsc' && !b.login?.trim()) throw badRequest('Для SMSC укажите логин');
    return withCtx(pool, ctx, async (db) => {
      const prev = (await db.query('select secret_enc from sms_settings')).rows[0];
      const secretEnc = b.secret?.trim() ? encrypt(b.secret.trim()) : prev?.secret_enc ?? null;
      if (b.provider !== 'test' && !secretEnc) throw badRequest('Укажите ключ провайдера (API-ключ или пароль)');
      await db.query(`insert into sms_settings(tenant_id, provider, sender, login, secret_enc, updated_by) values ($1,$2,$3,$4,$5,$6)
        on conflict (tenant_id) do update set provider = $2, sender = $3, login = $4, secret_enc = $5, updated_by = $6, updated_at = now()`,
        [ctx.tenantId, b.provider, b.sender?.trim().slice(0, 11) || null, b.login?.trim().slice(0, 60) || null, secretEnc, ctx.userId]);
      await audit(db, ctx, 'sms.settings', 'tenant', ctx.tenantId, null, { provider: b.provider });
      return { ok: true };
    });
  });

  app.post('/api/sms/settings/test', async (req) => {
    const ctx = requireCtx(req); net(ctx);
    const phone = normalizePhone((req.body as { phone?: string } | undefined)?.phone);
    if (!phone) throw badRequest('Укажите телефон для проверки');
    return withCtx(pool, ctx, async (db) => sendSms(db, f, { tenantId: ctx.tenantId, clubId: null, phone, text: 'Клубная ОС: проверка отправки СМС' }));
  });

  // В клубе: код на телефон клиента, клиент вводит его на экране подписания
  app.post('/api/contracts/:id/sms/send', async (req) => {
    const ctx = requirePerm(req, P.contractsSign);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { phone?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await contractFor(db, id);
      const r = await openRequest(db, ctx, c, b.phone);
      return sendCode(db, f, ctx, r, c);
    });
  });

  app.post('/api/contracts/:id/sms/confirm', async (req) => {
    const ctx = requirePerm(req, P.contractsSign);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { code?: string; accepted?: boolean };
    if (b.accepted !== true) throw badRequest('Клиент должен подтвердить, что ознакомлен с договором и правилами');
    if (!b.code) throw badRequest('Введите код из СМС');
    const res = await withCtx(pool, ctx, async (db) => {
      await contractFor(db, id);
      const r = (await db.query(`select * from contract_sign_requests where contract_id = $1 and status = 'active' order by created_at desc limit 1`, [id])).rows[0];
      if (!r) return { error: 'Сначала отправьте код клиенту' };
      return confirm(db, ctx, r, b.code!, { ip: req.ip, ua: String(req.headers['user-agent'] ?? ''), acceptedBy: ctx.userId });
    });
    if ('error' in res) throw badRequest(res.error!, 'bad_code');
    return res;
  });

  // Удалённо: ссылка на страницу подписи
  app.post('/api/contracts/:id/sms/link', async (req) => {
    const ctx = requirePerm(req, P.contractsSign);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { phone?: string };
    return withCtx(pool, ctx, async (db) => {
      const c = await contractFor(db, id);
      const r = await openRequest(db, ctx, c, b.phone);
      const token = `sg_${randomBytes(18).toString('base64url')}`;
      await db.query(`update contract_sign_requests set link_token_hash = $2, link_expires_at = now() + make_interval(days => $3) where id = $1`, [r.id, sha(token), LINK_DAYS]);
      const url = `${base(req)}/sign/${token}`;
      const res = await sendSms(db, f, { tenantId: c.tenant_id, clubId: c.club_id, phone: r.phone, text: `${c.club_name}: договор № ${c.number} на подпись: ${url}`,
        logText: `${c.club_name}: договор № ${c.number} на подпись: ${base(req)}/sign/•••` });
      await audit(db, ctx, 'contract.sms_link_sent', 'contract', c.id, null, { phone: mask(r.phone) });
      return { phoneMasked: mask(r.phone), expiresInDays: LINK_DAYS, testUrl: res.test ? url : undefined };
    });
  });

  const byLink = async (token: string) => {
    if (!/^sg_[\w-]{20,40}$/.test(token)) return null;
    return (await pool.query('select * from auth_sign_link($1)', [sha(token)])).rows[0] as { request_id: string; tenant_id: string } | undefined ?? null;
  };
  const pageData = async (db: Db, r: Record<string, unknown>): Promise<PageData> => {
    const c = (await db.query(`select c.number, to_char(c.contract_date, 'DD.MM.YYYY') as date, cl.name as club, p.full_name as person, c.contract_doc_id, c.rules_doc_id,
        m.product_name, to_char(m.starts_on, 'DD.MM.YYYY') || ' — ' || to_char(m.ends_on, 'DD.MM.YYYY') as period, m.amount_kop, m.kind
      from contracts c join clubs cl on cl.id = c.club_id join persons p on p.id = c.person_id left join memberships m on m.id = c.membership_id where c.id = $1`, [r.contract_id])).rows[0];
    const docs = (await db.query(`select kind, title from club_documents where id = any($1) order by kind`, [[c.contract_doc_id, c.rules_doc_id].filter(Boolean)])).rows;
    const price = c.amount_kop != null ? `${Math.round(Number(c.amount_kop) / 100).toLocaleString('ru-RU')} ₽${c.kind === 'subscription' ? ' в месяц' : ''}` : null;
    return { clubName: c.club, number: c.number, date: c.date, person: c.person, product: c.product_name, period: c.period, price, docs, phone: mask(r.phone as string) };
  };
  const html = (reply: { type: (t: string) => unknown; header: (k: string, v: string) => unknown }) => { reply.type('text/html; charset=utf-8'); reply.header('cache-control', 'no-store'); reply.header('x-robots-tag', 'noindex'); };
  const sysActor = (tenantId: string, ip: string): Actor => ({ tenantId, userId: null, ip });

  app.get('/sign/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    html(reply);
    const l = await byLink(token);
    if (!l) return reply.code(404).send(signPage(token, null));
    return withCtx(pool, { tenantId: l.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const r = (await db.query('select * from contract_sign_requests where id = $1', [l.request_id])).rows[0];
      return signPage(token, await pageData(db, r), { stage: r.code_hash && new Date(r.code_expires_at) > new Date() ? 'code' : 'start' });
    });
  });

  app.get('/sign/:token/doc/:kind', async (req, reply) => {
    const { token, kind } = req.params as { token: string; kind: string };
    const l = await byLink(token);
    if (!l) throw notFound('Ссылка недействительна');
    const file = await withCtx(pool, { tenantId: l.tenant_id, allClubs: true, clubIds: [] }, async (db) => (await db.query(`select f.original_name, f.mime, f.storage_path
        from contract_sign_requests r join contracts c on c.id = r.contract_id join club_documents d on d.id in (c.contract_doc_id, c.rules_doc_id) and d.kind = $2
        join files f on f.id = d.file_id where r.id = $1`, [l.request_id, kind])).rows[0]);
    if (!file) throw notFound('Документ не найден');
    const abs = join(storage, file.storage_path);
    if (!existsSync(abs)) throw notFound('Документ не найден в хранилище');
    reply.header('Content-Type', file.mime).header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`).header('Cache-Control', 'no-store');
    return reply.send(readFileSync(abs));
  });

  app.post('/sign/:token/code', async (req, reply) => {
    const { token } = req.params as { token: string };
    html(reply);
    const l = await byLink(token);
    if (!l) return reply.code(404).send(signPage(token, null));
    return withCtx(pool, { tenantId: l.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const r = (await db.query('select * from contract_sign_requests where id = $1', [l.request_id])).rows[0];
      const v = await pageData(db, r);
      const c = (await db.query('select c.number, cl.name as club_name from contracts c join clubs cl on cl.id = c.club_id where c.id = $1', [r.contract_id])).rows[0];
      try {
        const s = await sendCode(db, f, sysActor(l.tenant_id, req.ip), r, c);
        return signPage(token, v, { stage: 'code', testCode: s.testCode, info: `Код действует ${CODE_TTL_MIN} минут.` });
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) return signPage(token, v, { stage: r.code_hash ? 'code' : 'start', err: e.message });
        throw e;
      }
    });
  });

  app.post('/sign/:token/confirm', async (req, reply) => {
    const { token } = req.params as { token: string };
    const b = (req.body ?? {}) as { code?: string; accepted?: string };
    html(reply);
    const l = await byLink(token);
    if (!l) return reply.code(404).send(signPage(token, null));
    return withCtx(pool, { tenantId: l.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const r = (await db.query('select * from contract_sign_requests where id = $1', [l.request_id])).rows[0];
      const v = await pageData(db, r);
      if (b.accepted !== '1') return signPage(token, v, { stage: 'code', err: 'Отметьте, что ознакомились с договором и правилами' });
      const res = await confirm(db, sysActor(l.tenant_id, req.ip), r, String(b.code ?? ''), { ip: req.ip, ua: String(req.headers['user-agent'] ?? ''), acceptedBy: null });
      if ('error' in res) return signPage(token, v, { stage: 'code', err: res.error });
      return signPage(token, v, { stage: 'done' });
    });
  });
}
