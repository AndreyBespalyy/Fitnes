// Шаг 8. Касса клуба и чеки по 54-ФЗ.
// Режимы: облачная касса (АТОЛ Онлайн, API v5) — сервер сам отправляет чек и забирает фискальные данные;
// касса в клубе (АТОЛ через «Веб-сервер ККТ» из драйвера ДТО10) — чек пробивает компьютер ресепшн из браузера;
// вручную — кассир пробивает чек на любой кассе и вписывает номер фискального документа.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';

/* ---------- шифрование пароля облачной кассы ---------- */
function key() {
  const k = process.env.FISCAL_SECRET_KEY;
  if (!k || k.length < 16) throw badRequest('Не задан ключ шифрования FISCAL_SECRET_KEY в файле .env (строка не короче 16 символов). Без него пароль кассы не сохранить');
  return createHash('sha256').update(k).digest();
}
export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(blob: string) {
  const [, iv, tag, enc] = blob.split(':');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/* ---------- настройки ---------- */
export type FiscalSettings = {
  mode: 'none' | 'cloud' | 'local'; provider: string | null; taxation: string; vat: string; paymentMethod: string; inn: string | null; companyEmail: string | null;
  paymentAddress: string | null; apiUrl: string | null; groupCode: string | null; login: string | null; hasPassword: boolean; localUrl: string; acquiringProvider: string; updatedAt?: string;
};
const COLS = `mode, provider, taxation, vat, payment_method as "paymentMethod", inn, company_email as "companyEmail", payment_address as "paymentAddress",
  api_url as "apiUrl", group_code as "groupCode", login, password_enc is not null as "hasPassword", local_url as "localUrl", acquiring_provider as "acquiringProvider", updated_at as "updatedAt"`;
const DEFAULTS: FiscalSettings = { mode: 'none', provider: null, taxation: 'usn_income', vat: 'none', paymentMethod: 'full_prepayment', inn: null, companyEmail: null,
  paymentAddress: null, apiUrl: 'https://online.atol.ru/possystem/v5', groupCode: null, login: null, hasPassword: false, localUrl: 'http://127.0.0.1:16732', acquiringProvider: 'none' };
export async function getFiscal(db: Db, clubId: string): Promise<FiscalSettings> {
  return (await db.query(`select ${COLS} from club_fiscal_settings where club_id = $1`, [clubId])).rows[0] ?? { ...DEFAULTS };
}

/* ---------- чек ---------- */
type Generic = { items: { name: string; priceKop: number; quantity: number; sumKop: number }[]; totalKop: number; payment: 'cash' | 'electronic';
  client: { email: string | null; phone: string | null; name: string | null } };
const rub = (kop: number) => Math.round(kop) / 100;
const LOCAL_TAX: Record<string, string> = { osn: 'osn', usn_income: 'usnIncome', usn_income_outcome: 'usnIncomeOutcome', esn: 'esn', patent: 'patent' };
const LOCAL_METHOD: Record<string, string> = { full_prepayment: 'fullPrepayment', full_payment: 'fullPayment', advance: 'advance' };
const atolTime = (d = new Date()) => {
  const m = new Date(d.getTime() + 3 * 3600_000); const p = (n: number) => String(n).padStart(2, '0');
  return `${p(m.getUTCDate())}.${p(m.getUTCMonth() + 1)}.${m.getUTCFullYear()} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}:${p(m.getUTCSeconds())}`;
};

/** Задание для АТОЛ Онлайн (облако), формат API v5. */
export function atolOnlinePayload(r: Generic, s: FiscalSettings, externalId: string) {
  const client = r.client.email ? { email: r.client.email } : r.client.phone ? { phone: r.client.phone } : { email: s.companyEmail };
  return {
    timestamp: atolTime(), external_id: externalId,
    receipt: {
      client: { ...client, ...(r.client.name ? { name: r.client.name } : {}) },
      company: { email: s.companyEmail, sno: s.taxation, inn: s.inn, payment_address: s.paymentAddress },
      items: r.items.map((i) => ({ name: i.name.slice(0, 128), price: rub(i.priceKop), quantity: i.quantity, sum: rub(i.sumKop), measure: 0,
        payment_method: s.paymentMethod, payment_object: 4, vat: { type: s.vat } })),
      payments: [{ type: r.payment === 'cash' ? 0 : 1, sum: rub(r.totalKop) }],
      total: rub(r.totalKop),
    },
  };
}
/** Задание для кассы в клубе: JSON-задание «Веб-сервера ККТ» АТОЛ (драйвер ДТО10). */
export function atolLocalPayload(r: Generic, s: FiscalSettings, operatorName: string) {
  return {
    type: 'sell', taxationType: LOCAL_TAX[s.taxation], operator: { name: operatorName },
    ...(r.client.email || r.client.phone ? { clientInfo: { emailOrPhone: r.client.email ?? r.client.phone } } : {}),
    items: r.items.map((i) => ({ type: 'position', name: i.name.slice(0, 128), price: rub(i.priceKop), quantity: i.quantity, amount: rub(i.sumKop),
      paymentMethod: LOCAL_METHOD[s.paymentMethod], paymentObject: 'service', tax: { type: s.vat } })),
    payments: [{ type: r.payment === 'cash' ? 'cash' : 'electronically', sum: rub(r.totalKop) }],
    total: rub(r.totalKop),
  };
}

function checkReady(s: FiscalSettings) {
  const miss: string[] = [];
  if (!s.inn) miss.push('ИНН');
  if (s.mode === 'cloud') {
    if (!s.companyEmail) miss.push('e-mail организации');
    if (!s.paymentAddress) miss.push('адрес расчётов (сайт или адрес клуба)');
    if (!s.apiUrl) miss.push('адрес сервиса');
    if (!s.groupCode) miss.push('код группы');
    if (!s.login) miss.push('логин');
    if (!s.hasPassword) miss.push('пароль');
  }
  return miss;
}

/** Собирает задание чека для платежа по текущим настройкам кассы клуба. null, если касса не подключена. */
async function draft(db: Db, ctx: Pick<Ctx, 'userId'>, receiptId: string, chargeId: string, method: string) {
  const c = (await db.query(`select ch.*, p.full_name from charges ch join persons p on p.id = ch.person_id where ch.id = $1`, [chargeId])).rows[0];
  const s = await getFiscal(db, c.club_id);
  if (s.mode === 'none') return null;
  const contacts = (await db.query(`select type, value from person_contacts where person_id = $1 order by is_primary desc`, [c.person_id])).rows;
  const g: Generic = {
    items: [{ name: c.title, priceKop: Number(c.amount_kop), quantity: 1, sumKop: Number(c.amount_kop) }], totalKop: Number(c.amount_kop),
    payment: method === 'cash' ? 'cash' : 'electronic',
    client: { email: contacts.find((x) => x.type === 'email')?.value ?? null, phone: contacts.find((x) => x.type === 'phone')?.value ?? null, name: c.full_name },
  };
  const operator = ctx.userId ? (await db.query('select full_name from users where id = $1', [ctx.userId])).rows[0]?.full_name ?? 'Кассир' : 'Кассир';
  const miss = checkReady(s);
  return {
    clubId: c.club_id as string, personId: c.person_id as string, amountKop: Number(c.amount_kop), mode: s.mode,
    provider: s.mode === 'cloud' ? 'atol_online' : s.provider === 'manual' ? 'manual' : 'atol_local',
    payload: s.mode === 'cloud' ? atolOnlinePayload(g, s, receiptId) : atolLocalPayload(g, s, operator),
    status: miss.length ? 'failed' : 'pending', error: miss.length ? `Касса настроена не полностью: ${miss.join(', ')}` : null,
  };
}

/** Ставит чек в очередь после оплаты. Если касса клуба не подключена, чек не создаётся. */
export async function receiptForCharge(db: Db, ctx: Pick<Ctx, 'tenantId' | 'userId'>, chargeId: string, method: string) {
  const id = (await db.query('select gen_random_uuid() as id')).rows[0].id as string;
  const d = await draft(db, ctx, id, chargeId, method);
  if (!d) return null;
  await db.query(
    `insert into receipts(id, tenant_id, club_id, charge_id, person_id, mode, provider, status, amount_kop, payload, error, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ctx.tenantId, d.clubId, chargeId, d.personId, d.mode, d.provider, d.status, d.amountKop, JSON.stringify(d.payload), d.error, ctx.userId]);
  return id;
}

/* ---------- облачная касса: отправка и получение результата ---------- */
type Fetch = typeof fetch;
async function atolCall(f: Fetch, url: string, init: RequestInit) {
  const res = await f(url, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({})) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, body };
}
const atolErr = (b: Record<string, any>) => b?.error ? `${b.error.code ?? ''} ${b.error.text ?? b.error.type ?? ''}`.trim() : null; // eslint-disable-line @typescript-eslint/no-explicit-any
export async function atolToken(f: Fetch, apiUrl: string, login: string, pass: string) {
  const r = await atolCall(f, `${apiUrl.replace(/\/$/, '')}/getToken`, { method: 'POST', body: JSON.stringify({ login, pass }) });
  if (!r.body.token) throw new Error(atolErr(r.body) ?? `Касса не выдала токен (HTTP ${r.status})`);
  return r.body.token as string;
}

const BACKOFF = [10, 30, 60, 120, 300, 600, 1800, 3600];
export async function processCloudReceipts(pool: pg.Pool, f: Fetch = fetch, limit = 20) {
  const due = (await pool.query('select * from fiscal_due_receipts($1)', [limit])).rows as { id: string; tenant_id: string }[];
  let done = 0;
  for (const { id, tenant_id } of due) {
    await withCtx(pool, { tenantId: tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const r = (await db.query('select * from receipts where id = $1 for update skip locked', [id])).rows[0];
      if (!r || !['pending', 'sent'].includes(r.status)) return;
      const s = (await db.query('select * from club_fiscal_settings where club_id = $1', [r.club_id])).rows[0];
      const base = String(s?.api_url ?? '').replace(/\/$/, '');
      try {
        if (!s || !s.password_enc) throw new Error('Облачная касса не настроена');
        const token = await atolToken(f, base, s.login, decrypt(s.password_enc));
        if (r.status === 'pending') {
          const res = await atolCall(f, `${base}/${s.group_code}/${r.kind}`, { method: 'POST', headers: { Token: token }, body: JSON.stringify(r.payload) });
          if (!res.body.uuid) throw new Error(atolErr(res.body) ?? `Касса не приняла чек (HTTP ${res.status})`);
          await db.query(`update receipts set status = 'sent', external_id = $2, error = null, attempts = attempts + 1, next_attempt_at = now() + interval '5 seconds', updated_at = now() where id = $1`, [id, res.body.uuid]);
          return;
        }
        const rep = await atolCall(f, `${base}/${s.group_code}/report/${r.external_id}`, { method: 'GET', headers: { Token: token } });
        if (rep.body.status === 'done') {
          const p = rep.body.payload ?? {};
          const fiscal = { fnNumber: p.fn_number, fiscalDocumentNumber: p.fiscal_document_number, fiscalSign: p.fiscal_document_attribute,
            receiptNumber: p.fiscal_receipt_number, shiftNumber: p.shift_number, receiptDatetime: p.receipt_datetime, registrationNumber: p.ecr_registration_number, ofdUrl: p.ofd_receipt_url ?? null };
          await db.query(`update receipts set status = 'done', fiscal = $2, error = null, updated_at = now() where id = $1`, [id, JSON.stringify(fiscal)]);
          done++;
        } else if (rep.body.status === 'fail') {
          await db.query(`update receipts set status = 'failed', error = $2, updated_at = now() where id = $1`, [id, atolErr(rep.body) ?? 'Касса отклонила чек']);
        } else {
          await db.query(`update receipts set attempts = attempts + 1, next_attempt_at = now() + interval '10 seconds', updated_at = now() where id = $1`, [id]);
        }
      } catch (e) {
        const attempts = r.attempts + 1;
        const msg = (e as Error).message || 'Нет связи с облачной кассой';
        if (attempts >= 12) await db.query(`update receipts set status = 'failed', error = $2, attempts = $3, updated_at = now() where id = $1`, [id, msg, attempts]);
        else await db.query(`update receipts set error = $2, attempts = $3, next_attempt_at = now() + make_interval(secs => $4), updated_at = now() where id = $1`,
          [id, msg, attempts, BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]]);
      }
    });
  }
  return { processed: due.length, done };
}

export function startFiscalWorker(pool: pg.Pool, everyMs = 15_000) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processCloudReceipts(pool); } catch (e) { console.error('Ошибка отправки чеков:', (e as Error).message); } finally { busy = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

/* ---------- маршруты ---------- */
const RECEIPT_SELECT = `select r.id, r.club_id as "clubId", r.charge_id as "chargeId", r.kind, r.mode, r.provider, r.status, r.amount_kop as "amountKop", r.external_id as "externalId",
  r.fiscal, r.error, r.attempts, r.created_at as "createdAt", r.updated_at as "updatedAt", p.full_name as "personName", ch.title, ch.paid_method as "paidMethod"
  from receipts r left join persons p on p.id = r.person_id left join charges ch on ch.id = r.charge_id`;
const fixR = (r: Record<string, unknown>) => ({ ...r, amountKop: Number(r.amountKop) });

export function fiscalRoutes(app: FastifyInstance, pool: pg.Pool, opts: { fetch?: Fetch } = {}) {
  const f = opts.fetch ?? fetch;

  app.get('/api/clubs/:id/fiscal', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, (db) => getFiscal(db, id));
  });

  app.put('/api/clubs/:id/fiscal', async (req) => {
    const ctx = requirePerm(req, P.fiscalManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Partial<FiscalSettings> & { password?: string };
    const s = { ...DEFAULTS, ...b };
    if (!['none', 'cloud', 'local'].includes(s.mode)) throw badRequest('Выберите режим кассы');
    if (s.mode === 'local' && !['atol_local', 'manual'].includes(s.provider ?? '')) s.provider = 'atol_local';
    if (s.mode === 'cloud') s.provider = 'atol_online';
    if (s.mode === 'none') s.provider = null;
    const inn = s.inn?.replace(/\s/g, '') || null;
    if (inn && !/^\d{10}(\d{2})?$/.test(inn)) throw badRequest('ИНН: 10 или 12 цифр');
    if (s.companyEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.companyEmail)) throw badRequest('Неверный e-mail организации');
    for (const u of [s.apiUrl, s.localUrl]) if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw badRequest('Адрес должен начинаться с http:// или https://');
    const pass = b.password ? encrypt(b.password) : undefined;
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw notFound('Клуб не найден');
      const before = await getFiscal(db, id);
      try {
        await db.query(
          `insert into club_fiscal_settings(club_id, tenant_id, mode, provider, taxation, vat, payment_method, inn, company_email, payment_address, api_url, group_code, login, local_url, acquiring_provider, password_enc, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           on conflict (club_id) do update set mode = excluded.mode, provider = excluded.provider, taxation = excluded.taxation, vat = excluded.vat,
             payment_method = excluded.payment_method, inn = excluded.inn, company_email = excluded.company_email, payment_address = excluded.payment_address,
             api_url = excluded.api_url, group_code = excluded.group_code, login = excluded.login, local_url = excluded.local_url, acquiring_provider = excluded.acquiring_provider,
             password_enc = coalesce(excluded.password_enc, club_fiscal_settings.password_enc), updated_by = excluded.updated_by, updated_at = now()`,
          [id, ctx.tenantId, s.mode, s.provider, s.taxation, s.vat, s.paymentMethod, inn, s.companyEmail?.trim() || null, s.paymentAddress?.trim() || null,
            s.apiUrl?.trim() || null, s.groupCode?.trim() || null, s.login?.trim() || null, s.localUrl?.trim() || DEFAULTS.localUrl, s.acquiringProvider, pass ?? null, ctx.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23514') throw badRequest('Недопустимое значение в настройках кассы');
        throw e;
      }
      const after = await getFiscal(db, id);
      await audit(db, ctx, 'club.fiscal_changed', 'club', id, before, { ...after, passwordChanged: !!pass });
      return after;
    });
  });

  // Проверка связи с облачной кассой: получаем токен
  app.post('/api/clubs/:id/fiscal/test', async (req) => {
    const ctx = requirePerm(req, P.fiscalManage);
    const { id } = req.params as { id: string };
    const s = await withCtx(pool, ctx, async (db) => (await db.query('select * from club_fiscal_settings where club_id = $1', [id])).rows[0]);
    if (!s || s.mode !== 'cloud') throw badRequest('Сначала выберите облачную кассу и сохраните настройки');
    if (!s.password_enc || !s.login || !s.api_url) throw badRequest('Заполните адрес, логин и пароль');
    try { await atolToken(f, s.api_url, s.login, decrypt(s.password_enc)); } catch (e) { throw badRequest(`Касса не ответила: ${(e as Error).message}`); }
    return { ok: true, message: 'Связь с облачной кассой есть, логин и пароль подходят' };
  });

  app.get('/api/receipts', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { clubId, status } = req.query as { clubId?: string; status?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`${RECEIPT_SELECT} where ($1::uuid is null or r.club_id = $1) and ($2::text is null or r.status = $2)
      order by r.created_at desc limit 200`, [clubId || null, status || null])).rows.map(fixR));
  });

  app.post('/api/receipts/:id/retry', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query('select status from receipts where id = $1', [id])).rows[0];
      if (!r) throw notFound('Чек не найден');
      if (r.status !== 'failed') throw badRequest('Повторить можно только чек с ошибкой');
      // Настройки могли исправить: собираем задание заново
      const c = (await db.query('select r.charge_id, ch.paid_method from receipts r join charges ch on ch.id = r.charge_id where r.id = $1', [id])).rows[0];
      const d = await draft(db, ctx, id, c.charge_id, c.paid_method ?? 'card_terminal');
      if (!d) throw badRequest('Касса клуба отключена. Включите её в разделе «Касса» или отметьте чек вручную');
      await db.query(`update receipts set mode = $2, provider = $3, payload = $4, status = $5, error = $6, attempts = 0, next_attempt_at = now(), external_id = null, updated_at = now() where id = $1`,
        [id, d.mode, d.provider, JSON.stringify(d.payload), d.status, d.error]);
      const fresh = d.status;
      await audit(db, ctx, 'receipt.retry', 'receipt', id, { status: 'failed' }, { status: fresh });
      return { ok: true, status: fresh };
    });
  });

  // Касса в клубе или ручной режим: кассир пробил чек сам и вписал данные
  app.post('/api/receipts/:id/manual', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { fiscalDocumentNumber?: string; fnNumber?: string; fiscalSign?: string };
    if (!/^\d{1,10}$/.test(String(b.fiscalDocumentNumber ?? '').trim())) throw badRequest('Укажите номер фискального документа (ФД) с чека');
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query('select status from receipts where id = $1', [id])).rows[0];
      if (!r) throw notFound('Чек не найден');
      if (r.status === 'done') throw badRequest('Чек уже пробит');
      const fiscal = { fiscalDocumentNumber: String(b.fiscalDocumentNumber).trim(), fnNumber: b.fnNumber?.trim() || null, fiscalSign: b.fiscalSign?.trim() || null, manual: true };
      await db.query(`update receipts set status = 'done', fiscal = $2, error = null, manual_by = $3, updated_at = now() where id = $1`, [id, JSON.stringify(fiscal), ctx.userId]);
      await audit(db, ctx, 'receipt.manual', 'receipt', id, { status: r.status }, { status: 'done', fiscal });
      return { ok: true };
    });
  });

  // Очередь для кассы в клубе: браузер ресепшн забирает задания и отправляет их в «Веб-сервер ККТ»
  app.get('/api/receipts/local-queue', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => {
      const rows = (await db.query(`select r.id, r.club_id as "clubId", r.status, r.external_id as "externalId", r.payload, r.amount_kop as "amountKop", s.local_url as "localUrl"
        from receipts r join club_fiscal_settings s on s.club_id = r.club_id
        where r.mode = 'local' and r.provider = 'atol_local' and r.status in ('pending', 'sent') and ($1::uuid is null or r.club_id = $1)
        order by r.created_at limit 20`, [clubId || null])).rows;
      return rows.map(fixR);
    });
  });

  app.post('/api/receipts/:id/local-sent', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const { externalId } = (req.body ?? {}) as { externalId?: string };
    if (!externalId) throw badRequest('Нет номера задания');
    return withCtx(pool, ctx, async (db) => {
      const n = (await db.query(`update receipts set status = 'sent', external_id = $2, attempts = attempts + 1, updated_at = now() where id = $1 and status = 'pending' and mode = 'local'`, [id, externalId])).rowCount;
      if (!n) throw badRequest('Чек уже отправлен в кассу');
      return { ok: true };
    });
  });

  app.post('/api/receipts/:id/local-result', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { ok?: boolean; fiscal?: Record<string, unknown>; error?: string };
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query(`select status from receipts where id = $1 and mode = 'local'`, [id])).rows[0];
      if (!r) throw notFound('Чек не найден');
      if (r.status === 'done') return { ok: true };
      if (b.ok) await db.query(`update receipts set status = 'done', fiscal = $2, error = null, updated_at = now() where id = $1`, [id, JSON.stringify(b.fiscal ?? {})]);
      else await db.query(`update receipts set status = 'failed', error = $2, updated_at = now() where id = $1`, [id, String(b.error ?? 'Касса вернула ошибку').slice(0, 500)]);
      await audit(db, ctx, b.ok ? 'receipt.local_done' : 'receipt.local_failed', 'receipt', id, { status: r.status }, { status: b.ok ? 'done' : 'failed' });
      return { ok: true };
    });
  });

  // Галочка «списывать подписку автоматически с привязанной карты» (заработает с подключением банка)
  app.post('/api/persons/:id/autopay', async (req) => {
    const ctx = requirePerm(req, P.membershipsManage);
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') throw badRequest('Неверное значение');
    return withCtx(pool, ctx, async (db) => {
      const p = (await db.query('select autopay_enabled from persons where id = $1', [id])).rows[0];
      if (!p) throw notFound('Клиент не найден');
      await db.query('update persons set autopay_enabled = $2, autopay_changed_at = now(), autopay_changed_by = $3 where id = $1', [id, enabled, ctx.userId]);
      await audit(db, ctx, 'person.autopay_changed', 'person', id, { autopay: p.autopay_enabled }, { autopay: enabled });
      return { ok: true, enabled };
    });
  });
}
