// Шаг 7. Юрлицо клуба, PDF договора и правил с версиями, договор клиента, подписание на бумаге (скан) и на планшете.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { guardReveal } from './privacy.ts';

const MAX_UPLOAD = 15 * 1024 * 1024;
export const UPLOAD_LIMIT = { bodyLimit: Math.ceil(MAX_UPLOAD * 1.4) + 4096 };
export type Upload = { fileName?: string; mime?: string; dataBase64?: string };
type Actor = Pick<Ctx, 'tenantId' | 'userId' | 'ip'>;

const SIGNATURES: [string, number[]][] = [['application/pdf', [0x25, 0x50, 0x44, 0x46]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]]];
const sniff = (b: Buffer) => SIGNATURES.find(([, sig]) => sig.every((x, i) => b[i] === x))?.[0] ?? null;
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

export function decode(u: Upload, allowed: string[]) {
  if (!u.dataBase64) throw badRequest('Файл не передан');
  const buf = Buffer.from(u.dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw badRequest('Файл пустой');
  if (buf.length > MAX_UPLOAD) throw badRequest('Файл больше 15 МБ');
  const mime = sniff(buf);
  if (!mime || !allowed.includes(mime)) throw badRequest(allowed.length === 1 && allowed[0] === 'application/pdf' ? 'Нужен файл PDF' : 'Нужен файл PDF, JPG или PNG');
  return { buf, mime, name: (u.fileName || `файл.${EXT[mime]}`).slice(0, 200) };
}

export async function saveFile(db: Db, storage: string, ctx: Actor, clubId: string, kind: string, f: { buf: Buffer; mime: string; name: string; ext?: string }) {
  const sha = createHash('sha256').update(f.buf).digest('hex');
  const rel = join(ctx.tenantId, sha.slice(0, 2), `${sha}.${f.ext ?? EXT[f.mime]}`);
  const abs = join(storage, rel);
  if (!existsSync(abs)) { mkdirSync(join(storage, ctx.tenantId, sha.slice(0, 2)), { recursive: true }); writeFileSync(abs, f.buf); }
  const id = (await db.query(
    'insert into files(tenant_id, club_id, kind, original_name, mime, size_bytes, sha256, storage_path, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
    [ctx.tenantId, clubId, kind, f.name, f.mime, f.buf.length, sha, rel, ctx.userId])).rows[0].id as string;
  return { id, sha };
}

/* ---------- юрлицо ---------- */
const LE_FIELDS: [string, string][] = [
  ['fullName', 'full_name'], ['inn', 'inn'], ['kpp', 'kpp'], ['ogrn', 'ogrn'], ['address', 'address'], ['bankName', 'bank_name'], ['bik', 'bik'],
  ['account', 'account'], ['corrAccount', 'corr_account'], ['signerName', 'signer_name'], ['signerBasis', 'signer_basis'], ['contractPrefix', 'contract_prefix'],
];
const LE_SELECT = `select ${LE_FIELDS.map(([k, c]) => `${c} as "${k}"`).join(', ')}, updated_at as "updatedAt" from legal_entities where club_id = $1`;
export const getLegalEntity = async (db: Db, clubId: string) => (await db.query(LE_SELECT, [clubId])).rows[0] ?? null;

/* ---------- договор ---------- */
export async function createContract(db: Db, ctx: Actor, membershipId: string) {
  const m = (await db.query(`select id, club_id, person_id, to_char((now() at time zone (select timezone from clubs where id = club_id))::date, 'YYYY-MM-DD') as today
    from memberships where id = $1`, [membershipId])).rows[0];
  const le = await getLegalEntity(db, m.club_id);
  const year = Number(m.today.slice(0, 4));
  const no = (await db.query(
    `insert into contract_counters(club_id, tenant_id, year, last_no) values ($1,$2,$3,1)
     on conflict (club_id, year) do update set last_no = contract_counters.last_no + 1 returning last_no`, [m.club_id, ctx.tenantId, year])).rows[0].last_no;
  const number = `${le?.contractPrefix ?? 'Д'}-${year}-${String(no).padStart(5, '0')}`;
  const docs = (await db.query(`select id, kind from club_documents where club_id = $1 and is_current`, [m.club_id])).rows;
  const id = (await db.query(
    `insert into contracts(tenant_id, club_id, person_id, membership_id, number, contract_date, legal_entity, contract_doc_id, rules_doc_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, m.club_id, m.person_id, membershipId, number, m.today, le ? JSON.stringify(le) : null,
      docs.find((d) => d.kind === 'contract')?.id ?? null, docs.find((d) => d.kind === 'rules')?.id ?? null, ctx.userId])).rows[0].id;
  await audit(db, ctx, 'contract.created', 'contract', id, null, { number, membershipId });
  return { id, number };
}

export async function contractsByMembership(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, ContractBrief>();
  const rows = (await db.query(`select id, membership_id, number, to_char(contract_date, 'YYYY-MM-DD') as "date", status, sign_method as "signMethod", signed_at as "signedAt",
      scan_file_id as "scanFileId", signature_file_id as "signatureFileId", legal_entity is not null as "hasLegalEntity", contract_doc_id is not null as "hasContractDoc"
    from contracts where membership_id = any($1)`, [ids])).rows;
  return new Map(rows.map((r) => [r.membership_id as string, { ...r, membership_id: undefined } as ContractBrief]));
}
export type ContractBrief = { id: string; number: string; date: string; status: string; signMethod: string | null; signedAt: string | null;
  scanFileId: string | null; signatureFileId: string | null; hasLegalEntity: boolean; hasContractDoc: boolean };

async function loadContract(db: Db, id: string) {
  const c = (await db.query(`select *, to_char(contract_date, 'YYYY-MM-DD') as contract_date from contracts where id = $1`, [id])).rows[0];
  if (!c) throw notFound('Договор не найден');
  return c;
}

async function markSigned(db: Db, ctx: Actor, c: { id: string }, method: 'paper_scan' | 'tablet', extra: Record<string, unknown>) {
  const cols = Object.keys(extra);
  await db.query(
    `update contracts set status = 'signed', sign_method = $2, signed_at = now(), accepted_by = $3${cols.map((k, i) => `, ${k} = $${i + 4}`).join('')} where id = $1`,
    [c.id, method, ctx.userId, ...cols.map((k) => extra[k])]);
  await audit(db, ctx, 'contract.signed', 'contract', c.id, { status: 'awaiting_signature' }, { status: 'signed', method });
}

/* ---------- маршруты ---------- */
export function contractRoutes(app: FastifyInstance, pool: pg.Pool, storage: string) {
  app.get('/api/clubs/:id/legal-entity', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => ({ legalEntity: await getLegalEntity(db, id) }));
  });

  app.put('/api/clubs/:id/legal-entity', async (req) => {
    const ctx = requirePerm(req, P.contractsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const DIGITS = new Set(['inn', 'kpp', 'ogrn', 'bik', 'account', 'corrAccount']);
    const v: Record<string, string | null> = Object.fromEntries(LE_FIELDS.map(([k]) => {
      const raw = typeof b[k] === 'string' ? b[k]!.trim() : '';
      return [k, (DIGITS.has(k) ? raw.replace(/\s/g, '') : raw) || null];
    }));
    if (!v.fullName) throw badRequest('Укажите название юрлица');
    if (!/^\d{10}(\d{2})?$/.test(v.inn ?? '')) throw badRequest('ИНН: 10 цифр для организации или 12 для ИП');
    const checks: [string, RegExp, string][] = [['kpp', /^\d{9}$/, 'КПП: 9 цифр'], ['ogrn', /^\d{13}(\d{2})?$/, 'ОГРН: 13 цифр (ОГРНИП: 15)'],
      ['bik', /^\d{9}$/, 'БИК: 9 цифр'], ['account', /^\d{20}$/, 'Расчётный счёт: 20 цифр'], ['corrAccount', /^\d{20}$/, 'Корр. счёт: 20 цифр']];
    for (const [k, re, msg] of checks) if (v[k] && !re.test(v[k]!)) throw badRequest(msg);
    return withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw notFound('Клуб не найден');
      const before = await getLegalEntity(db, id);
      const cols = LE_FIELDS.map(([, c]) => c);
      const vals = LE_FIELDS.map(([k]) => (k === 'contractPrefix' ? v[k] ?? 'Д' : v[k]));
      await db.query(
        `insert into legal_entities(club_id, tenant_id, ${cols.join(', ')}, updated_by) values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3})
         on conflict (club_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_by = excluded.updated_by, updated_at = now()`,
        [id, ctx.tenantId, ...vals, ctx.userId]);
      const after = await getLegalEntity(db, id);
      await audit(db, ctx, 'club.legal_entity_changed', 'club', id, before, after);
      return { legalEntity: after };
    });
  });

  app.get('/api/clubs/:id/documents', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select d.id, d.kind, d.title, d.version, d.is_current as "isCurrent", d.created_at as "createdAt", d.file_id as "fileId",
         f.original_name as "fileName", f.size_bytes as "sizeBytes", u.full_name as "uploadedBy"
       from club_documents d join files f on f.id = d.file_id left join users u on u.id = d.uploaded_by
       where d.club_id = $1 order by d.kind, d.version desc`, [id])).rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) })));
  });

  app.post('/api/clubs/:id/documents', UPLOAD_LIMIT, async (req, reply) => {
    const ctx = requirePerm(req, P.contractsManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Upload & { kind?: string; title?: string };
    if (!['contract', 'rules'].includes(b.kind ?? '')) throw badRequest('Выберите тип документа');
    const f = decode(b, ['application/pdf']);
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw notFound('Клуб не найден');
      const file = await saveFile(db, storage, ctx, id, 'club_document', f);
      const version = (await db.query('select coalesce(max(version), 0) + 1 as v from club_documents where club_id = $1 and kind = $2', [id, b.kind])).rows[0].v;
      await db.query('update club_documents set is_current = false where club_id = $1 and kind = $2 and is_current', [id, b.kind]);
      const title = b.title?.trim() || (b.kind === 'contract' ? 'Договор оказания услуг' : 'Правила клуба');
      const docId = (await db.query(
        'insert into club_documents(tenant_id, club_id, kind, title, version, file_id, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [ctx.tenantId, id, b.kind, title, version, file.id, ctx.userId])).rows[0].id;
      await audit(db, ctx, 'club.document_uploaded', 'club_document', docId, null, { kind: b.kind, title, version, sha256: file.sha });
      return { id: docId, version };
    });
    reply.code(201);
    return res;
  });

  // Выдача файла: база сама не покажет файл чужого клуба
  app.get('/api/files/:id', async (req, reply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const f = await withCtx(pool, ctx, async (db) => (await db.query('select original_name, mime, storage_path from files where id = $1', [id])).rows[0]);
    if (!f) throw notFound('Файл не найден');
    const abs = join(storage, f.storage_path);
    if (!existsSync(abs)) throw notFound('Файл не найден в хранилище');
    reply.header('Content-Type', f.mime);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(readFileSync(abs));
  });

  // Всё для печати и для экрана подписания на планшете
  app.get('/api/contracts/:id', async (req) => {
    const ctx = requirePerm(req, P.membershipsView);
    const { id } = req.params as { id: string };
    // В договоре полный телефон и e-mail клиента — считается как раскрытие номера (защита базы)
    await guardReveal(pool, ctx, {});
    return withCtx(pool, ctx, async (db) => {
      const c = await loadContract(db, id);
      const person = (await db.query(`select p.full_name as "fullName", to_char(p.birth_date, 'DD.MM.YYYY') as "birthDate",
          (select value from person_contacts pc where pc.person_id = p.id and pc.type = 'phone' order by is_primary desc limit 1) as phone,
          (select value from person_contacts pc where pc.person_id = p.id and pc.type = 'email' order by is_primary desc limit 1) as email
        from persons p where p.id = $1`, [c.person_id])).rows[0];
      const m = c.membership_id ? (await db.query(`select product_name as "productName", kind, amount_kop as "amountKop", installments,
          to_char(starts_on, 'YYYY-MM-DD') as "startsOn", to_char(ends_on, 'YYYY-MM-DD') as "endsOn", visits_left as "visitsLeft" from memberships where id = $1`, [c.membership_id])).rows[0] : null;
      const charges = c.membership_id ? (await db.query(`select title, to_char(due_on, 'YYYY-MM-DD') as "dueOn", amount_kop as "amountKop" from charges
          where membership_id = $1 and kind <> 'freeze_fee' and status <> 'cancelled' order by due_on`, [c.membership_id])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop) })) : [];
      const doc = async (docId: string | null) => docId ? (await db.query('select id, title, version, file_id as "fileId" from club_documents where id = $1', [docId])).rows[0] : null;
      const club = (await db.query('select name, address from clubs where id = $1', [c.club_id])).rows[0];
      return {
        id: c.id, number: c.number, date: c.contract_date, status: c.status, signMethod: c.sign_method, signedAt: c.signed_at,
        scanFileId: c.scan_file_id, signatureFileId: c.signature_file_id, legalEntity: c.legal_entity, club, person,
        membership: m ? { ...m, amountKop: Number(m.amountKop) } : null, charges,
        contractDoc: await doc(c.contract_doc_id), rulesDoc: await doc(c.rules_doc_id),
      };
    });
  });

  app.post('/api/contracts/:id/scan', UPLOAD_LIMIT, async (req) => {
    const ctx = requirePerm(req, P.contractsSign);
    const { id } = req.params as { id: string };
    const f = decode((req.body ?? {}) as Upload, ['application/pdf', 'image/jpeg', 'image/png']);
    return withCtx(pool, ctx, async (db) => {
      const c = await loadContract(db, id);
      if (c.status !== 'awaiting_signature') throw badRequest(c.status === 'signed' ? 'Договор уже подписан' : 'Договор расторгнут');
      const file = await saveFile(db, storage, ctx, c.club_id, 'contract_scan', f);
      await markSigned(db, ctx, c, 'paper_scan', { scan_file_id: file.id });
      return { ok: true };
    });
  });

  app.post('/api/contracts/:id/sign-tablet', UPLOAD_LIMIT, async (req: FastifyRequest) => {
    const ctx = requirePerm(req, P.contractsSign);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { signaturePng?: string; accepted?: boolean };
    if (b.accepted !== true) throw badRequest('Клиент должен подтвердить, что ознакомлен с договором и правилами');
    const f = decode({ dataBase64: b.signaturePng, fileName: 'подпись.png' }, ['image/png']);
    if (f.buf.length < 1500) throw badRequest('Подпись пустая, распишитесь в поле');
    return withCtx(pool, ctx, async (db) => {
      const c = await loadContract(db, id);
      if (c.status !== 'awaiting_signature') throw badRequest(c.status === 'signed' ? 'Договор уже подписан' : 'Договор расторгнут');
      if (!c.legal_entity) throw badRequest('В договоре нет реквизитов клуба. Управляющий заполняет их в разделе «Договоры»');
      const hashes = (await db.query(`select string_agg(d.kind || ':' || f.sha256, ';' order by d.kind) as h from club_documents d join files f on f.id = d.file_id
        where d.id = any($1)`, [[c.contract_doc_id, c.rules_doc_id].filter(Boolean)])).rows[0].h;
      const file = await saveFile(db, storage, ctx, c.club_id, 'signature', f);
      await markSigned(db, ctx, c, 'tablet', {
        signature_file_id: file.id, signed_docs_sha256: hashes, signer_ip: req.ip, signer_user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      });
      return { ok: true };
    });
  });
}
