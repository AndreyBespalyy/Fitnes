// Шаг 9. Перенос данных из 1С по пяти отчётам: загрузка → распознавание → карта полей → пробный перенос
// (проверка строк, дубли, конфликты, отчёт сверки) → перенос → принятие или отмена.
// Переносит детерминированный код; деньги не округляются и не исправляются.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Ctx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { verifyPassword } from '../passwords.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { readTable, TableError } from '../lib/tables.ts';
import { clubToday, daysBetween } from './memberships.ts';
import {
  detectReport, FIELDS, findHeaderRow, headerSignature, isFooter, mapColumns, methodOf, normEmail, normName, normalizePhone,
  parseDate, parseInt10, parseMoney, REPORT_NAMES, REPORT_TYPES, type Mapping, type ReportType,
} from './importMap.ts';

const SOURCE = '1c';
const MAX_FILE = 40 * 1024 * 1024;
const FILE_LIMIT = { bodyLimit: Math.ceil(MAX_FILE * 1.4) + 4096 };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

type Actor = Pick<Ctx, 'tenantId' | 'userId' | 'ip' | 'allClubs' | 'clubIds'>;
type FileRow = { id: string; original_name: string; report_type: ReportType | null; mapping: Mapping; mapping_confirmed: boolean; headers: string[]; header_signature: string };
type Row = { id: string; file_id: string; row_no: number; cells: string[]; checksum: string; resolution: 'merge' | 'new' | 'skip' | null };
type Status = 'ok' | 'warning' | 'excluded' | 'conflict' | 'skipped';
type Mark = { status: Status; issue: string | null; group: string | null; conflictWith?: string | null; conflictPersonId?: string | null };

type ClientRef = { kind: 'batch'; key: string } | { kind: 'person'; personId: string };
type PClient = { row: Row; key: string; name: string; phone: string | null; email: string | null; birth: string | null; card: string | null;
  target: { kind: 'new' } | { kind: 'existing'; personId: string } | { kind: 'alias'; key: string } };
type PMembership = { row: Row; key: string; client: ClientRef; productName: string; starts: string; ends: string | null; amount: number;
  visitsLeft: number | null; visitsTotal: number | null; cancelled: boolean; contractNumber: string | null; contractDate: string | null };
type PPayment = { row: Row; key: string; client: ClientRef | null; membershipKey: string | null; at: string; month: string; dir: 'in' | 'out'; amount: number; method: string };
type PVisit = { row: Row; key: string; client: ClientRef; membershipKey: string | null; at: string };
type PDebt = { row: Row; key: string; client: ClientRef; membershipKey: string | null; amount: number; dueOn: string };

/* ======================= анализ (пробный перенос) ======================= */
async function analyze(db: Db, batch: { id: string; club_id: string }) {
  const files = (await db.query(`select id, original_name, report_type, mapping, mapping_confirmed, headers, header_signature from import_files
    where batch_id = $1 order by uploaded_at`, [batch.id])).rows as FileRow[];
  const rows = (await db.query(`select id, file_id, row_no, cells, checksum, resolution from import_rows where batch_id = $1 order by file_id, row_no`, [batch.id])).rows as Row[];
  const byFile = new Map<string, Row[]>();
  for (const r of rows) { if (!byFile.has(r.file_id)) byFile.set(r.file_id, []); byFile.get(r.file_id)!.push(r); }
  const filesOf = (t: ReportType) => files.filter((f) => f.report_type === t);
  const today = await clubToday(db, batch.club_id);

  const marks = new Map<string, Mark>();
  const mark = (r: Row, status: Status, group: string | null = null, issue: string | null = group, extra: Partial<Mark> = {}) =>
    marks.set(r.id, { status, issue, group, ...extra });
  const getter = (f: FileRow) => (r: Row, key: string) => { const m = f.mapping[key]; return m ? String(r.cells[m.col] ?? '').trim() : ''; };

  // Ранее перенесённые записи этого клуба: повторный перенос их не дублирует
  const earlier = new Map<string, string>();
  for (const e of (await db.query(`select entity, external_id, target_id from import_external_ids where club_id = $1 and source_system = $2 and import_batch_id <> $3`,
    [batch.club_id, SOURCE, batch.id])).rows) earlier.set(`${e.entity}:${e.external_id}`, e.target_id);
  // Телефоны клиентов, которые уже есть в системе
  const dbPhones = new Map<string, { id: string; name: string }>();
  for (const p of (await db.query(`select pc.normalized_value as phone, p.id, p.full_name from person_contacts pc join persons p on p.id = pc.person_id
    where pc.type = 'phone' and p.merged_into_id is null and (p.import_batch_id is null or p.import_batch_id <> $1)`, [batch.id])).rows) {
    if (!dbPhones.has(p.phone)) dbPhones.set(p.phone, { id: p.id, name: p.full_name });
  }

  const footers: Partial<Record<ReportType, number>> = {};
  const occ = new Map<string, number>();
  const occKey = (base: string) => { const n = (occ.get(base) ?? 0) + 1; occ.set(base, n); return `${base}#${n}`; };

  /* ---- клиенты ---- */
  const clients: PClient[] = [];
  const cByKey = new Map<string, PClient>();
  const cByPhone = new Map<string, PClient>();
  const cByName = new Map<string, PClient[]>();
  const skippedClientKeys = new Map<string, string>();
  const cSeen = new Map<string, Row>();
  const earlierPersonByExt = (ext: string) => earlier.get(`person:${ext}`);
  for (const f of filesOf('clients')) {
    const g = getter(f);
    for (const r of byFile.get(f.id) ?? []) {
      if (isFooter(r.cells)) { mark(r, 'skipped', 'Строка итогов отчёта'); continue; }
      const name = g(r, 'full_name').replace(/\s+/g, ' ');
      if (!name) { mark(r, 'excluded', 'Нет ФИО'); continue; }
      const rawPhone = g(r, 'phone');
      const phone = normalizePhone(rawPhone);
      const email = g(r, 'email') ? normEmail(g(r, 'email')) : null;
      const rawBirth = g(r, 'birth_date');
      const birth = rawBirth ? parseDate(rawBirth)?.date ?? null : null;
      const key = g(r, 'ext_id') || (phone ? `tel:${phone}` : `fio:${normName(name)}|${birth ?? ''}`);
      const prev = cSeen.get(key);
      if (prev) {
        if (prev.checksum === r.checksum) mark(r, 'skipped', 'Повтор строки', `Повтор строки ${prev.row_no}`);
        else mark(r, 'excluded', 'Код клиента повторяется', `Код клиента «${key}» уже есть в строке ${prev.row_no}`);
        continue;
      }
      cSeen.set(key, r);
      if (earlierPersonByExt(key)) { mark(r, 'skipped', 'Уже перенесено раньше'); skippedClientKeys.set(key, 'earlier'); continue; }
      const c: PClient = { row: r, key, name, phone, email, birth, card: g(r, 'card') || null, target: { kind: 'new' } };
      const warns: string[] = [];
      if (rawPhone && !phone) warns.push(`телефон не распознан: «${rawPhone}»`);
      if (g(r, 'email') && !email) warns.push(`почта не распознана: «${g(r, 'email')}»`);
      if (rawBirth && !birth) warns.push(`дата рождения не распознана: «${rawBirth}»`);
      // Совпадения по телефону — конфликт, решает человек
      const inDb = phone ? dbPhones.get(phone) : undefined;
      const inBatch = phone ? cByPhone.get(phone) : undefined;
      if (inDb || inBatch) {
        const withText = inDb ? `В системе уже есть «${inDb.name}» с тем же телефоном` : `Тот же телефон у «${inBatch!.name}» (строка ${inBatch!.row.row_no})`;
        if (!r.resolution) { mark(r, 'conflict', 'Совпадает телефон', withText, { conflictWith: withText, conflictPersonId: inDb?.id ?? null }); skippedClientKeys.set(key, 'conflict'); continue; }
        if (r.resolution === 'skip') { mark(r, 'skipped', 'Пропущено по решению', 'Пропущено по решению сотрудника', { conflictWith: withText }); skippedClientKeys.set(key, 'skip'); continue; }
        if (r.resolution === 'merge') {
          c.target = inDb ? { kind: 'existing', personId: inDb.id } : { kind: 'alias', key: inBatch!.key };
          warns.unshift(inDb ? `объединён с клиентом в системе «${inDb.name}»` : `объединён с «${inBatch!.name}» (строка ${inBatch!.row.row_no})`);
        } else warns.unshift('создаётся отдельный клиент по решению сотрудника');
      }
      clients.push(c); cByKey.set(key, c);
      if (phone && !cByPhone.has(phone)) cByPhone.set(phone, c);
      const nn = normName(name); cByName.set(nn, [...(cByName.get(nn) ?? []), c]);
      if (warns.length) mark(r, 'warning', warns.some((w) => w.startsWith('объедин') || w.startsWith('создаётся')) ? 'Конфликт решён' : 'Часть полей не распознана',
        warns.join('; '), { conflictWith: inDb || inBatch ? (inDb ? inDb.name : inBatch!.name) : null, conflictPersonId: inDb?.id ?? null });
      else mark(r, 'ok');
    }
  }
  const canonical = (key: string): string => { const c = cByKey.get(key); return c && c.target.kind === 'alias' ? canonical(c.target.key) : key; };
  const findClient = (ext: string, name: string, rawPhone: string): { ref: ClientRef } | { error: string; group: string } => {
    if (ext) {
      if (cByKey.has(ext)) return { ref: refOfKey(ext) };
      const pid = earlierPersonByExt(ext); if (pid) return { ref: { kind: 'person', personId: pid } };
      if (skippedClientKeys.has(ext)) return skippedErr(ext);
      return { error: `Клиента с кодом «${ext}» нет в отчёте клиентов`, group: 'Клиент не найден' };
    }
    const phone = normalizePhone(rawPhone);
    if (phone && cByPhone.has(phone)) return { ref: refOfKey(cByPhone.get(phone)!.key) };
    if (name) {
      const list = cByName.get(normName(name)) ?? [];
      if (list.length === 1) return { ref: refOfKey(list[0].key) };
      if (list.length > 1) return { error: `По ФИО «${name}» найдено несколько клиентов, нужен код клиента или телефон`, group: 'Неоднозначный клиент' };
      return { error: `Клиента «${name}» нет в отчёте клиентов`, group: 'Клиент не найден' };
    }
    return { error: 'Не указан клиент', group: 'Не указан клиент' };
  };
  const refOfKey = (key: string): ClientRef => { const k = canonical(key); const c = cByKey.get(k)!; return c.target.kind === 'existing' ? { kind: 'person', personId: c.target.personId } : { kind: 'batch', key: k }; };
  const skippedErr = (ext: string) => ({ error: skippedClientKeys.get(ext) === 'conflict' ? `Клиент «${ext}» ждёт решения по конфликту` : `Клиент «${ext}» пропущен`, group: 'Клиент не переносится' });
  // Клиент так, как он записан в исходной строке: ключи не зависят от того, в каком пакете клиент перенесён
  const srcClient = (g: (r: Row, k: string) => string, r: Row) => g(r, 'client_ext') || normalizePhone(g(r, 'client_phone')) || normName(g(r, 'client_name'));
  const refId = (c: ClientRef) => (c.kind === 'batch' ? `b:${c.key}` : `p:${c.personId}`);

  /* ---- абонементы ---- */
  const memberships: PMembership[] = [];
  const mByKey = new Map<string, PMembership>();
  const mByContract = new Map<string, PMembership>();
  const mByClient = new Map<string, PMembership[]>();
  const mSeen = new Map<string, Row>();
  const earlierMembership = (k: string) => earlier.get(`membership:${k}`);
  for (const f of filesOf('memberships')) {
    const g = getter(f);
    for (const r of byFile.get(f.id) ?? []) {
      if (isFooter(r.cells)) { const s = parseMoney(g(r, 'amount')); if (s !== null) footers.memberships = (footers.memberships ?? 0) + s; mark(r, 'skipped', 'Строка итогов отчёта'); continue; }
      const productName = g(r, 'product_name');
      const starts = parseDate(g(r, 'starts_on'))?.date;
      const rawEnds = g(r, 'ends_on'); const ends = rawEnds ? parseDate(rawEnds)?.date ?? null : null;
      const contractNumber = g(r, 'contract_number') || null;
      const key = g(r, 'ext_id') || contractNumber || `h:${sha(JSON.stringify(r.cells)).slice(0, 24)}`;
      const prev = mSeen.get(key);
      if (prev) {
        if (prev.checksum === r.checksum) mark(r, 'skipped', 'Повтор строки', `Повтор строки ${prev.row_no}`);
        else mark(r, 'excluded', 'Код абонемента повторяется', `Абонемент «${key}» уже есть в строке ${prev.row_no}`);
        continue;
      }
      mSeen.set(key, r);
      if (earlierMembership(key)) { mark(r, 'skipped', 'Уже перенесено раньше'); continue; }
      if (!productName) { mark(r, 'excluded', 'Нет названия абонемента'); continue; }
      if (!starts) { mark(r, 'excluded', 'Нет даты начала', g(r, 'starts_on') ? `Дата начала не распознана: «${g(r, 'starts_on')}»` : 'Нет даты начала'); continue; }
      if (rawEnds && !ends) { mark(r, 'excluded', 'Дата окончания не распознана', `Дата окончания не распознана: «${rawEnds}»`); continue; }
      if (ends && ends < starts) { mark(r, 'excluded', 'Окончание раньше начала'); continue; }
      const cl = findClient(g(r, 'client_ext'), g(r, 'client_name'), g(r, 'client_phone'));
      if ('error' in cl) { mark(r, 'excluded', cl.group, cl.error); continue; }
      const rawAmount = g(r, 'amount'); const amount = rawAmount ? parseMoney(rawAmount) : 0;
      if (amount === null || amount < 0) { mark(r, 'excluded', 'Стоимость не распознана', `Стоимость не распознана: «${rawAmount}»`); continue; }
      const st = g(r, 'status').toLowerCase();
      const warns: string[] = [];
      if (!rawAmount) warns.push('нет стоимости, записана 0 ₽');
      if (/заморож/.test(st)) warns.push('в 1С абонемент заморожен: оформите заморозку в системе');
      const contractDateRaw = g(r, 'contract_date');
      const m: PMembership = { row: r, key, client: cl.ref, productName, starts, ends, amount,
        visitsLeft: parseInt10(g(r, 'visits_left')), visitsTotal: parseInt10(g(r, 'visits_total')),
        cancelled: /аннул|расторг|отмен|возврат|закрыт досрочно/.test(st), contractNumber, contractDate: contractDateRaw ? parseDate(contractDateRaw)?.date ?? null : null };
      if (contractNumber && mByContract.has(contractNumber)) { warns.push(`номер договора «${contractNumber}» повторяется, договор не создаётся`); m.contractNumber = null; }
      memberships.push(m); mByKey.set(key, m);
      if (m.contractNumber) mByContract.set(m.contractNumber, m);
      const ck = refId(m.client); mByClient.set(ck, [...(mByClient.get(ck) ?? []), m]);
      if (warns.length) mark(r, 'warning', warns[0].startsWith('в 1С абонемент заморожен') ? 'Заморозка из 1С' : 'Есть замечания', warns.join('; '));
      else mark(r, 'ok');
    }
  }
  const findMembership = (client: ClientRef | null, memExt: string, contract: string, date: string): string | null => {
    if (memExt && mByKey.has(memExt)) return memExt;
    if (contract && mByContract.has(contract)) return mByContract.get(contract)!.key;
    if (contract && mByKey.has(contract)) return contract;
    if (!client) return null;
    const list = (mByClient.get(refId(client)) ?? []).filter((m) => m.starts <= date && (!m.ends || m.ends >= date));
    if (list.length === 1) return list[0].key;
    const all = mByClient.get(refId(client)) ?? [];
    return all.length === 1 ? all[0].key : null;
  };

  /* ---- платежи ---- */
  const payments: PPayment[] = [];
  const paySeen = new Map<string, Row>();
  const moneyAll: { month: string; dir: 'in' | 'out'; amount: number; loaded: boolean }[] = [];
  for (const f of filesOf('payments')) {
    const g = getter(f);
    for (const r of byFile.get(f.id) ?? []) {
      if (isFooter(r.cells)) { const s = parseMoney(g(r, 'amount')); if (s !== null) footers.payments = (footers.payments ?? 0) + s; mark(r, 'skipped', 'Строка итогов отчёта'); continue; }
      const d = parseDate(g(r, 'date'));
      const signed = parseMoney(g(r, 'amount'));
      if (!d) { mark(r, 'excluded', 'Нет даты платежа', g(r, 'date') ? `Дата не распознана: «${g(r, 'date')}»` : 'Нет даты платежа'); continue; }
      if (signed === null) { mark(r, 'excluded', 'Сумма не распознана', `Сумма не распознана: «${g(r, 'amount')}»`); continue; }
      if (signed === 0) { mark(r, 'skipped', 'Нулевая сумма'); continue; }
      const op = g(r, 'operation').toLowerCase();
      const dir: 'in' | 'out' = signed < 0 || /возврат|выдача|расход/.test(op) ? 'out' : 'in';
      const amount = Math.abs(signed);
      const month = d.date.slice(0, 7);
      const entry = { month, dir, amount, loaded: false };
      moneyAll.push(entry);
      const ext = g(r, 'ext_id');
      const base = ext ? `${ext}|${d.date}|${dir}` : `h:${sha([d.date, d.time, g(r, 'client_ext'), g(r, 'client_name'), signed, g(r, 'method'), op].join('|')).slice(0, 24)}`;
      const key = ext ? base : occKey(base);
      const prev = paySeen.get(key);
      if (prev) {
        if (prev.checksum === r.checksum) mark(r, 'skipped', 'Повтор строки', `Повтор строки ${prev.row_no}`);
        else mark(r, 'excluded', 'Номер документа повторяется', `Документ «${ext}» за ${d.date.split('-').reverse().join('.')} уже есть в строке ${prev.row_no}`);
        continue;
      }
      paySeen.set(key, r);
      if (earlier.has(`payment:${key}`)) { mark(r, 'skipped', 'Уже перенесено раньше'); entry.loaded = true; continue; }
      const hasClient = g(r, 'client_ext') || g(r, 'client_name') || g(r, 'client_phone');
      let client: ClientRef | null = null;
      if (hasClient) {
        const cl = findClient(g(r, 'client_ext'), g(r, 'client_name'), g(r, 'client_phone'));
        if ('error' in cl) { mark(r, 'excluded', cl.group, cl.error); continue; }
        client = cl.ref;
      }
      const method = methodOf(g(r, 'method'));
      payments.push({ row: r, key, client, membershipKey: findMembership(client, g(r, 'membership_ext'), g(r, 'contract_number'), d.date),
        at: `${d.date} ${d.time ?? '12:00:00'}`, month, dir, amount, method });
      entry.loaded = true;
      const warns: string[] = [];
      if (!client) warns.push('платёж без клиента');
      if (method === 'other') warns.push(g(r, 'method') ? `способ оплаты «${g(r, 'method')}» не распознан` : 'не указан способ оплаты');
      if (warns.length) mark(r, 'warning', 'Есть замечания', warns.join('; ')); else mark(r, 'ok');
    }
  }

  /* ---- посещения ---- */
  const visits: PVisit[] = [];
  const visitSeen = new Set<string>();
  for (const f of filesOf('visits')) {
    const g = getter(f);
    for (const r of byFile.get(f.id) ?? []) {
      if (isFooter(r.cells)) { mark(r, 'skipped', 'Строка итогов отчёта'); continue; }
      const d = parseDate(g(r, 'visited_at'));
      if (!d) { mark(r, 'excluded', 'Нет даты посещения', g(r, 'visited_at') ? `Дата не распознана: «${g(r, 'visited_at')}»` : 'Нет даты посещения'); continue; }
      const cl = findClient(g(r, 'client_ext'), g(r, 'client_name'), g(r, 'client_phone'));
      if ('error' in cl) { mark(r, 'excluded', cl.group, cl.error); continue; }
      const ext = g(r, 'ext_id');
      // Один и тот же клиент в ту же минуту — это повтор, а не второе посещение
      const key = ext || `h:${sha([d.date, d.time, srcClient(g, r)].join('|')).slice(0, 24)}`;
      if (visitSeen.has(key)) { mark(r, 'skipped', 'Повтор строки'); continue; }
      visitSeen.add(key);
      if (earlier.has(`visit:${key}`)) { mark(r, 'skipped', 'Уже перенесено раньше'); continue; }
      visits.push({ row: r, key, client: cl.ref, membershipKey: findMembership(cl.ref, g(r, 'membership_ext'), g(r, 'contract_number'), d.date),
        at: `${d.date} ${d.time ?? '12:00:00'}` });
      if (!d.time) mark(r, 'warning', 'Нет времени посещения', 'нет времени, записано 12:00'); else mark(r, 'ok');
    }
  }

  /* ---- остатки и долги ---- */
  const debts: PDebt[] = [];
  let debtSource = 0; let advanceSource = 0; let advanceCount = 0;
  for (const f of filesOf('balances')) {
    const g = getter(f);
    for (const r of byFile.get(f.id) ?? []) {
      if (isFooter(r.cells)) { mark(r, 'skipped', 'Строка итогов отчёта'); continue; }
      const rawDebt = g(r, 'debt'); const rawAdv = g(r, 'advance');
      const debt = rawDebt ? parseMoney(rawDebt) : 0; const adv = rawAdv ? parseMoney(rawAdv) : 0;
      if (debt === null || adv === null) { mark(r, 'excluded', 'Сумма не распознана', `Сумма не распознана: «${debt === null ? rawDebt : rawAdv}»`); continue; }
      // В части отчётов долг идёт со знаком минус в колонке «Баланс»
      const debtKop = Math.max(0, debt) + (adv < 0 ? -adv : 0);
      const advKop = Math.max(0, adv) + (debt < 0 ? -debt : 0);
      debtSource += debtKop; advanceSource += advKop; if (advKop) advanceCount++;
      if (!debtKop && !advKop) { mark(r, 'skipped', 'Нулевой остаток'); continue; }
      const cl = findClient(g(r, 'client_ext'), g(r, 'client_name'), g(r, 'client_phone'));
      if ('error' in cl) { mark(r, 'excluded', cl.group, cl.error); continue; }
      const dueRaw = g(r, 'due_on');
      const dueOn = (dueRaw ? parseDate(dueRaw)?.date : null) ?? today;
      const membershipKey = findMembership(cl.ref, g(r, 'membership_ext'), g(r, 'contract_number'), dueOn);
      const key = `${srcClient(g, r)}|${g(r, 'membership_ext') || g(r, 'contract_number') || ''}|${debtKop}|${dueOn}`;
      if (earlier.has(`debt:${key}`)) { mark(r, 'skipped', 'Уже перенесено раньше'); continue; }
      if (debtKop) debts.push({ row: r, key, client: cl.ref, membershipKey, amount: debtKop, dueOn });
      if (advKop) mark(r, 'warning', 'Аванс клиента', `аванс ${rub(advKop)}: лицевого счёта в системе пока нет, сумма показана в отчёте сверки`);
      else mark(r, 'ok');
    }
  }

  /* ---- отчёт ---- */
  const missing = REPORT_TYPES.filter((t) => !filesOf(t).length);
  const unconfirmed = files.filter((f) => f.report_type && !f.mapping_confirmed).map((f) => f.original_name);
  const unknown = files.filter((f) => !f.report_type).map((f) => f.original_name);
  const counts = Object.fromEntries(REPORT_TYPES.map((t) => {
    const ids = new Set(filesOf(t).map((f) => f.id));
    const st = rows.filter((r) => ids.has(r.file_id)).map((r) => marks.get(r.id));
    const c = (s: Status) => st.filter((m) => m?.status === s).length;
    const footer = st.filter((m) => m?.group === 'Строка итогов отчёта').length;
    return [t, { name: REPORT_NAMES[t], files: ids.size, source: st.length - footer, load: c('ok') + c('warning'), warning: c('warning'), excluded: c('excluded'),
      conflict: c('conflict'), skipped: c('skipped') - footer, earlier: st.filter((m) => m?.group === 'Уже перенесено раньше').length }];
  }));
  const months = [...new Set(moneyAll.map((m) => m.month))].sort().map((month) => {
    const sum = (dir: 'in' | 'out', loaded?: boolean) => moneyAll.filter((m) => m.month === month && m.dir === dir && (loaded === undefined || m.loaded === loaded)).reduce((x, m) => x + m.amount, 0);
    return { month, inSourceKop: sum('in'), inLoadKop: sum('in', true), outSourceKop: sum('out'), outLoadKop: sum('out', true) };
  });
  const tot = (k: keyof (typeof months)[number]) => months.reduce((x, m) => x + (m[k] as number), 0);
  const issues = new Map<string, { type: ReportType; status: Status; group: string; count: number; examples: { rowNo: number; file: string; issue: string }[] }>();
  const fileById = new Map(files.map((f) => [f.id, f]));
  for (const r of rows) {
    const m = marks.get(r.id); if (!m || !m.group || m.group === 'Строка итогов отчёта') continue;
    const f = fileById.get(r.file_id)!;
    const k = `${f.report_type}|${m.status}|${m.group}`;
    if (!issues.has(k)) issues.set(k, { type: f.report_type!, status: m.status, group: m.group, count: 0, examples: [] });
    const it = issues.get(k)!; it.count++;
    if (it.examples.length < 5) it.examples.push({ rowNo: r.row_no, file: f.original_name, issue: m.issue ?? m.group });
  }
  const unresolved = [...marks.values()].filter((m) => m.status === 'conflict').length;
  const blockers = [
    ...missing.map((t) => `Не загружен отчёт «${REPORT_NAMES[t]}»`),
    ...unknown.map((n) => `Не указано, какой это отчёт: «${n}»`),
    ...unconfirmed.map((n) => `Не подтверждена карта полей: «${n}»`),
    ...(unresolved ? [`Не решены конфликты: ${unresolved}`] : []),
  ];
  const membershipSource = memberships.reduce((x, m) => x + m.amount, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    canApply: blockers.length === 0,
    blockers,
    counts,
    money: {
      months,
      totals: { inSourceKop: tot('inSourceKop'), inLoadKop: tot('inLoadKop'), outSourceKop: tot('outSourceKop'), outLoadKop: tot('outLoadKop') },
      paymentsFooterKop: footers.payments ?? null,
      debts: { sourceKop: debtSource, loadKop: debts.reduce((x, d) => x + d.amount, 0) },
      advances: { sourceKop: advanceSource, count: advanceCount },
      memberships: { loadKop: membershipSource, footerKop: footers.memberships ?? null },
    },
    completeness: {
      clientsWithoutPhone: clients.filter((c) => !c.phone).length,
      clientsWithoutBirthDate: clients.filter((c) => !c.birth).length,
      clientsWithoutEmail: clients.filter((c) => !c.email).length,
      membershipsWithoutContract: memberships.filter((m) => !m.contractNumber).length,
      membershipsActive: memberships.filter((m) => !m.cancelled && m.starts <= today && (!m.ends || m.ends >= today)).length,
      paymentsWithoutMembership: payments.filter((p) => !p.membershipKey).length,
      notTransferred: [
        'Заморозки из 1С переносятся отметкой в отчёте: сами заморозки оформляются в системе',
        'Авансы клиентов показаны в отчёте: лицевого счёта в системе пока нет',
        'Чеки по историческим платежам не пробиваются повторно',
      ],
    },
    issues: [...issues.values()].sort((a, b) => ['conflict', 'excluded', 'warning', 'skipped'].indexOf(a.status) - ['conflict', 'excluded', 'warning', 'skipped'].indexOf(b.status) || b.count - a.count),
  };
  return { files, rows, marks, report, today, clients, memberships, payments, visits, debts, canonical };
}

async function saveMarks(db: Db, marks: Map<string, Mark>) {
  const e = [...marks.entries()];
  for (let i = 0; i < e.length; i += 5000) {
    const part = e.slice(i, i + 5000);
    await db.query(`update import_rows r set status = x.status, issue = x.issue, conflict_with = x.cw, conflict_person_id = x.cp
      from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::uuid[]) as x(id, status, issue, cw, cp) where r.id = x.id`,
    [part.map(([id]) => id), part.map(([, m]) => m.status), part.map(([, m]) => m.issue), part.map(([, m]) => m.conflictWith ?? null), part.map(([, m]) => m.conflictPersonId ?? null)]);
  }
}

/* ======================= перенос ======================= */
async function apply(db: Db, ctx: Actor, batch: { id: string; club_id: string; tenant_id: string }) {
  const a = await analyze(db, batch);
  if (!a.report.canApply) throw badRequest(`Перенос невозможен: ${a.report.blockers.join('; ')}`);
  const t = batch.tenant_id; const club = batch.club_id;
  const ext: { entity: string; key: string; target: string; row: Row; type: ReportType }[] = [];
  const fileType = new Map(a.files.map((f) => [f.id, f.report_type!]));
  const reg = (entity: string, key: string, target: string, row: Row) => ext.push({ entity, key, target, row, type: fileType.get(row.file_id)! });

  // Клиенты
  const personOfKey = new Map<string, string>();
  const newPersons = a.clients.filter((c) => c.target.kind === 'new').map((c) => ({ c, id: randomUUID() }));
  for (const { c, id } of newPersons) personOfKey.set(c.key, id);
  for (const c of a.clients) if (c.target.kind === 'existing') personOfKey.set(c.key, c.target.personId);
  for (const c of a.clients) if (c.target.kind === 'alias') personOfKey.set(c.key, personOfKey.get(a.canonical(c.key))!);
  await bulk(db, `insert into persons(id, tenant_id, home_club_id, full_name, birth_date, segment, import_batch_id)
    select x.id, $1, $2, x.name, x.birth, 'лид', $3 from unnest($4::uuid[], $5::text[], $6::date[]) as x(id, name, birth)`,
  [t, club, batch.id], newPersons, (p) => [p.id, p.c.name, p.c.birth]);
  const contacts: [string, string, string, boolean][] = [];
  for (const { c, id } of newPersons) {
    if (c.phone) contacts.push([id, 'phone', c.phone, true]);
    if (c.email) contacts.push([id, 'email', c.email, !c.phone]);
  }
  for (const c of a.clients) if (c.target.kind !== 'new') {
    // Объединение: недостающие телефон и почту добавляем к найденной карточке
    const pid = personOfKey.get(c.key)!;
    const have = new Set((await db.query('select normalized_value from person_contacts where person_id = $1', [pid])).rows.map((r) => r.normalized_value));
    if (c.phone && !have.has(c.phone)) contacts.push([pid, 'phone', c.phone, false]);
    if (c.email && !have.has(c.email)) contacts.push([pid, 'email', c.email, false]);
  }
  await bulk(db, `insert into person_contacts(tenant_id, person_id, type, value, normalized_value, is_primary)
    select $1, x.pid, x.type, x.v, x.v, x.prim from unnest($2::uuid[], $3::text[], $4::text[], $5::bool[]) as x(pid, type, v, prim)`, [t], contacts, (c) => c);
  for (const c of a.clients) reg('person', c.key, personOfKey.get(c.key)!, c.row);
  const personOf = (r: ClientRef) => (r.kind === 'person' ? r.personId : personOfKey.get(a.canonical(r.key))!);

  // Тарифы из 1С: находим по названию или создаём архивные (в прайс не попадают)
  const products = new Map<string, { id: string; pv: string; kind: string }>();
  for (const name of [...new Set(a.memberships.map((m) => m.productName))]) {
    const ex = (await db.query(`select p.id, p.kind, (select id from price_versions v where v.product_id = p.id order by valid_from desc limit 1) as pv
      from products p where p.club_id = $1 and lower(p.name) = lower($2)`, [club, name])).rows[0];
    const list = a.memberships.filter((m) => m.productName === name);
    if (ex?.pv) { products.set(name, { id: ex.id, pv: ex.pv, kind: ex.kind }); continue; }
    const isVisits = list.some((m) => m.visitsLeft !== null || m.visitsTotal !== null);
    const durations = list.filter((m) => m.ends).map((m) => daysBetween(m.starts, m.ends!) + 1).sort((x, y) => x - y);
    const dur = Math.min(3660, Math.max(1, durations[Math.floor(durations.length / 2)] ?? 30));
    const amounts = new Map<number, number>(); for (const m of list) amounts.set(m.amount, (amounts.get(m.amount) ?? 0) + 1);
    const price = [...amounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
    const visitsCount = Math.min(1000, Math.max(1, ...list.map((m) => m.visitsTotal ?? m.visitsLeft ?? 1)));
    const id = ex?.id ?? (await db.query(`insert into products(tenant_id, club_id, kind, name, duration_days, visits_count, validity_days, is_active, import_batch_id)
      values ($1,$2,$3,$4,$5,$6,$7,false,$8) returning id`,
    [t, club, isVisits ? 'visits' : 'term', name, isVisits ? null : dur, isVisits ? visitsCount : null, isVisits ? dur : null, batch.id])).rows[0].id;
    const pv = (await db.query(`insert into price_versions(tenant_id, club_id, product_id, amount_kop, valid_from, created_by, import_batch_id)
      values ($1,$2,$3,$4,'2000-01-01',$5,$6) returning id`, [t, club, id, price, ctx.userId, batch.id])).rows[0].id;
    products.set(name, { id, pv, kind: ex?.kind ?? (isVisits ? 'visits' : 'term') });
  }

  // Абонементы, договоры, операции
  const mId = new Map<string, string>();
  const ms = a.memberships.map((m) => { const id = randomUUID(); mId.set(m.key, id); return { m, id, p: products.get(m.productName)! }; });
  await bulk(db, `insert into memberships(id, tenant_id, club_id, person_id, product_id, price_version_id, kind, product_name, amount_kop, status, starts_on, ends_on,
      visits_left, cancel_reason, created_by, created_at, import_batch_id)
    select x.id, $1, $2, x.person, x.product, x.pv, x.kind, x.name, x.amount, x.status, x.starts, x.ends, x.vl, x.reason, $3, x.starts::timestamp at time zone c.timezone, $4
    from unnest($5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::text[], $11::bigint[], $12::text[], $13::date[], $14::date[], $15::int[], $16::text[])
      as x(id, person, product, pv, kind, name, amount, status, starts, ends, vl, reason) join clubs c on c.id = $2`,
  [t, club, ctx.userId, batch.id], ms, ({ m, id, p }) => [id, personOf(m.client), p.id, p.pv, p.kind, m.productName, m.amount, m.cancelled ? 'cancelled' : 'active',
    m.starts, m.ends, m.visitsLeft, m.cancelled ? 'Расторгнут в 1С' : null]);
  await bulk(db, `insert into membership_operations(tenant_id, club_id, membership_id, kind, params, actor_id, import_batch_id)
    select $1, $2, x.id, 'sale', jsonb_build_object('source', '1С', 'externalId', x.k), $3, $4 from unnest($5::uuid[], $6::text[]) as x(id, k)`,
  [t, club, ctx.userId, batch.id], ms, ({ m, id }) => [id, m.key]);
  const taken = new Set((await db.query('select number from contracts where club_id = $1 and number = any($2)', [club, ms.map((x) => x.m.contractNumber).filter(Boolean)])).rows.map((r) => r.number));
  const withContract = ms.filter((x) => x.m.contractNumber && !taken.has(x.m.contractNumber));
  await bulk(db, `insert into contracts(tenant_id, club_id, person_id, membership_id, number, contract_date, status, sign_method, signed_at, created_by, import_batch_id)
    select $1, $2, x.person, x.mid, x.num, x.d, x.st, 'paper_scan', x.d::timestamp at time zone c.timezone, $3, $4
    from unnest($5::uuid[], $6::uuid[], $7::text[], $8::date[], $9::text[]) as x(person, mid, num, d, st) join clubs c on c.id = $2`,
  [t, club, ctx.userId, batch.id], withContract, ({ m, id }) => [personOf(m.client), id, m.contractNumber, m.contractDate ?? m.starts, m.cancelled ? 'cancelled' : 'signed']);
  for (const x of ms) reg('membership', x.m.key, x.id, x.m.row);

  // Оплачено по абонементу: одно начисление на сумму платежей (приход минус возвраты) — нужно для расчёта возврата
  const paidCharge = new Map<string, string>();
  const byM = new Map<string, PPayment[]>();
  for (const p of a.payments) if (p.membershipKey) byM.set(p.membershipKey, [...(byM.get(p.membershipKey) ?? []), p]);
  const charges: { id: string; mid: string; person: string; amount: number; due: string; paidAt: string; method: string }[] = [];
  for (const x of ms) {
    const list = byM.get(x.m.key) ?? [];
    const net = list.reduce((s, p) => s + (p.dir === 'in' ? p.amount : -p.amount), 0);
    if (net <= 0) continue;
    const id = randomUUID(); paidCharge.set(x.m.key, id);
    const last = list.filter((p) => p.dir === 'in').sort((p, q) => (p.at < q.at ? 1 : -1))[0];
    charges.push({ id, mid: x.id, person: personOf(x.m.client), amount: net, due: x.m.starts, paidAt: last.at, method: last.method });
  }
  await bulk(db, `insert into charges(id, tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop, status, paid_at, paid_method, created_at, import_batch_id)
    select x.id, $1, $2, x.mid, x.person, 'full', 'Оплачено в 1С', x.due, x.amount, 'paid', x.paid::timestamp at time zone c.timezone, x.method, x.paid::timestamp at time zone c.timezone, $3
    from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::bigint[], $8::date[], $9::text[], $10::text[]) as x(id, mid, person, amount, due, paid, method) join clubs c on c.id = $2`,
  [t, club, batch.id], charges, (c) => [c.id, c.mid, c.person, c.amount, c.due, c.paidAt, c.method]);
  // Долги
  const debts = a.debts.map((d) => ({ d, id: randomUUID() }));
  await bulk(db, `insert into charges(id, tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop, status, import_batch_id)
    select x.id, $1, $2, x.mid, x.person, 'full', 'Долг из 1С', x.due, x.amount, 'due', $3 from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::bigint[], $8::date[]) as x(id, mid, person, amount, due)`,
  [t, club, batch.id], debts, ({ d, id }) => [id, d.membershipKey ? mId.get(d.membershipKey) ?? null : null, personOf(d.client), d.amount, d.dueOn]);
  for (const { d, id } of debts) reg('debt', d.key, id, d.row);

  // Платежи — в журнал с исходной датой
  const pays = a.payments.map((p) => ({ p, id: randomUUID() }));
  await bulk(db, `insert into payments(id, tenant_id, club_id, direction, kind, amount_kop, method, person_id, charge_id, created_by, created_at, import_batch_id)
    select x.id, $1, $2, x.dir, case when x.dir = 'in' then 'charge' else 'refund' end, x.amount, x.method, x.person, x.charge, $3, x.at::timestamp at time zone c.timezone, $4
    from unnest($5::uuid[], $6::text[], $7::bigint[], $8::text[], $9::uuid[], $10::uuid[], $11::text[]) as x(id, dir, amount, method, person, charge, at) join clubs c on c.id = $2`,
  [t, club, ctx.userId, batch.id], pays, ({ p, id }) => [id, p.dir, p.amount, p.method, p.client ? personOf(p.client) : null,
    p.dir === 'in' && p.membershipKey ? paidCharge.get(p.membershipKey) ?? null : null, p.at]);
  for (const { p, id } of pays) reg('payment', p.key, id, p.row);

  // Посещения
  const vs = a.visits.map((v) => ({ v, id: randomUUID() }));
  await bulk(db, `insert into visits(id, tenant_id, club_id, person_id, membership_id, visited_at, source, import_batch_id)
    select x.id, $1, $2, x.person, x.mid, x.at::timestamp at time zone c.timezone, 'import', $3
    from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::text[]) as x(id, person, mid, at) join clubs c on c.id = $2`,
  [t, club, batch.id], vs, ({ v, id }) => [id, personOf(v.client), v.membershipKey ? mId.get(v.membershipKey) ?? null : null, v.at]);
  for (const { v, id } of vs) reg('visit', v.key, id, v.row);

  // Сегменты перенесённых клиентов по их абонементам
  await db.query(`update persons p set segment = case
      when exists (select 1 from memberships m where m.person_id = p.id and m.status = 'active' and m.starts_on <= $2 and (m.ends_on is null or m.ends_on >= $2)) then 'действующий'
      when exists (select 1 from memberships m where m.person_id = p.id) then 'бывший' else 'лид' end
    where p.import_batch_id = $1`, [batch.id, a.today]);

  // Библиотека карт и таблица соответствия
  const version = new Map<string, number>();
  for (const f of a.files) {
    const v = (await db.query(`insert into import_templates(tenant_id, source_system, report_type, header_signature, headers, mapping, confirmed_by)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (tenant_id, source_system, header_signature) do update set mapping = excluded.mapping, report_type = excluded.report_type, confirmed_by = excluded.confirmed_by,
        updated_at = now(), version = import_templates.version + case when import_templates.mapping = excluded.mapping and import_templates.report_type = excluded.report_type then 0 else 1 end
      returning version`, [t, SOURCE, f.report_type, f.header_signature, JSON.stringify(f.headers), JSON.stringify(f.mapping), ctx.userId])).rows[0].version;
    version.set(f.id, v);
    await db.query('update import_files set mapping_version = $2 where id = $1', [f.id, v]);
  }
  await bulk(db, `insert into import_external_ids(tenant_id, club_id, source_system, entity, external_id, target_id, source_report_type, source_file_id, source_row_id,
      mapping_version, import_batch_id, checksum)
    select $1, $2, $3, x.entity, x.k, x.target, x.type, x.file, x.rowno, x.ver, $4, x.sum
    from unnest($5::text[], $6::text[], $7::uuid[], $8::text[], $9::uuid[], $10::int[], $11::int[], $12::text[]) as x(entity, k, target, type, file, rowno, ver, sum)
    on conflict (club_id, source_system, entity, external_id) do nothing`,
  [t, club, SOURCE, batch.id], ext, (e) => [e.entity, e.key, e.target, e.type, e.row.file_id, e.row.row_no, version.get(e.row.file_id) ?? null, e.row.checksum]);

  // Строки отмечаем перенесёнными, отчёт сохраняем
  for (const [id, m] of a.marks) if (m.status === 'ok' || m.status === 'warning') a.marks.set(id, { ...m, status: m.status === 'ok' ? ('imported' as Status) : m.status });
  await saveMarks(db, a.marks);
  await db.query(`update import_rows set status = 'imported' where batch_id = $1 and status = 'warning'`, [batch.id]);
  const applied = { persons: newPersons.length, merged: a.clients.length - newPersons.length, memberships: ms.length, contracts: withContract.length,
    payments: pays.length, visits: vs.length, debts: debts.length, products: products.size };
  const report = { ...a.report, mode: 'applied', applied };
  await db.query(`update import_batches set status = 'applied', report = $2, applied_at = now(), applied_by = $3 where id = $1`, [batch.id, JSON.stringify(report), ctx.userId]);
  await audit(db, ctx, 'import.applied', 'import_batch', batch.id, null, applied);
  return report;
}

/** Вставка большими порциями через unnest: params — общие параметры, затем массивы по колонкам. */
async function bulk<T>(db: Db, sql: string, common: unknown[], items: T[], cols: (x: T) => unknown[]) {
  for (let i = 0; i < items.length; i += 2000) {
    const part = items.slice(i, i + 2000).map(cols);
    if (!part.length) continue;
    const arrays = part[0].map((_, k) => part.map((r) => r[k]));
    await db.query(sql, [...common, ...arrays]);
  }
}

/* ======================= маршруты ======================= */
const BATCH_SELECT = `select b.id, b.club_id as "clubId", c.name as "clubName", b.status, b.report, b.created_at as "createdAt", b.checked_at as "checkedAt",
  b.applied_at as "appliedAt", b.accepted_at as "acceptedAt", b.rolled_back_at as "rolledBackAt", u.full_name as "createdByName"
  from import_batches b join clubs c on c.id = b.club_id left join users u on u.id = b.created_by`;

async function loadBatch(db: Db, id: string) {
  const b = (await db.query('select * from import_batches where id = $1', [id])).rows[0];
  if (!b) throw notFound('Перенос не найден');
  return b;
}
const editable = (b: { status: string }) => {
  if (!['draft', 'checked'].includes(b.status)) throw badRequest('Этот перенос уже выполнен: для изменений начните новый');
};
async function checkPassword(db: Db, ctx: Actor, password: string | undefined) {
  if (!password) throw badRequest('Введите свой пароль для подтверждения');
  const u = (await db.query('select password_hash from users where id = $1', [ctx.userId])).rows[0];
  if (!(await verifyPassword(u.password_hash, password))) throw badRequest('Пароль введён неверно', 'wrong_password');
}

export function importRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/import/fields', async (req) => {
    requirePerm(req, P.importManage);
    return REPORT_TYPES.map((t) => ({ type: t, name: REPORT_NAMES[t], fields: FIELDS[t].map((f) => ({ key: f.key, label: f.label, required: !!f.required })) }));
  });

  app.get('/api/import/batches', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`${BATCH_SELECT} where ($1::uuid is null or b.club_id = $1) order by b.created_at desc limit 50`, [clubId || null])).rows
      .map((b) => ({ ...b, report: undefined, canApply: b.report?.canApply ?? false, applied: b.report?.applied ?? null })));
  });

  app.post('/api/import/batches', async (req, reply) => {
    const ctx = requirePerm(req, P.importManage);
    const { clubId } = (req.body ?? {}) as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [clubId])).rowCount) throw badRequest('Клуб не найден');
      const id = (await db.query('insert into import_batches(tenant_id, club_id, created_by) values ($1,$2,$3) returning id', [ctx.tenantId, clubId, ctx.userId])).rows[0].id;
      await audit(db, ctx, 'import.created', 'import_batch', id, null, { clubId });
      return (await db.query(`${BATCH_SELECT} where b.id = $1`, [id])).rows[0];
    });
    reply.code(201);
    return res;
  });

  app.get('/api/import/batches/:id', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const b = (await db.query(`${BATCH_SELECT} where b.id = $1`, [id])).rows[0];
      if (!b) throw notFound('Перенос не найден');
      const files = (await db.query(`select f.id, f.original_name as "fileName", f.report_type as "reportType", f.detected_type as "detectedType", f.confidence::float as confidence,
          f.headers, f.header_row as "headerRow", f.mapping, f.mapping_confirmed as "mappingConfirmed", f.mapping_version as "mappingVersion", f.row_count as "rowCount",
          f.uploaded_at as "uploadedAt",
          (select coalesce(json_agg(r.cells order by r.row_no), '[]') from (select cells, row_no from import_rows where file_id = f.id order by row_no limit 5) r) as sample
        from import_files f where f.batch_id = $1 order by f.uploaded_at`, [id])).rows;
      const statusCounts = (await db.query(`select status, count(*)::int as n from import_rows where batch_id = $1 group by status`, [id])).rows;
      return { ...b, files, statusCounts: Object.fromEntries(statusCounts.map((r) => [r.status, r.n])) };
    });
  });

  // Загрузка файла: читаем таблицу, ищем заголовок, определяем отчёт и колонки, строки кладём в промежуточную таблицу как есть
  app.post('/api/import/batches/:id/files', FILE_LIMIT, async (req, reply) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { fileName, dataBase64 } = (req.body ?? {}) as { fileName?: string; dataBase64?: string };
    if (!dataBase64) throw badRequest('Файл не передан');
    const buf = Buffer.from(dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw badRequest('Файл пустой');
    if (buf.length > MAX_FILE) throw badRequest('Файл больше 40 МБ: выгрузите отчёт за несколько периодов отдельными файлами');
    const name = (fileName || 'отчёт').slice(0, 200);
    let table: string[][];
    try { table = readTable(buf, name); } catch (e) { if (e instanceof TableError) throw badRequest(e.message); throw e; }
    const h = findHeaderRow(table);
    const headers = (table[h] ?? []).map((x) => x.replace(/\s+/g, ' ').trim());
    const data = table.slice(h + 1);
    if (!data.length) throw badRequest(`В файле «${name}» не нашлось строк с данными под заголовком`);
    const width = headers.length;
    const signature = headerSignature(headers);
    const fileSha = createHash('sha256').update(buf).digest('hex');
    const res = await withCtx(pool, ctx, async (db) => {
      const b = await loadBatch(db, id); editable(b);
      if ((await db.query('select 1 from import_files where batch_id = $1 and sha256 = $2', [id, fileSha])).rowCount) throw badRequest(`Файл «${name}» уже загружен в этот перенос`);
      const tpl = (await db.query(`select report_type, mapping, version from import_templates where source_system = $1 and header_signature = $2`, [SOURCE, signature])).rows[0];
      const det = detectReport(headers, name);
      const type = (tpl?.report_type ?? (det.confidence >= 0.35 ? det.type : null)) as ReportType | null;
      const mapping = tpl?.mapping ?? (type ? (type === det.type ? det.mapping : mapColumns(type, headers).mapping) : {});
      const fid = (await db.query(`insert into import_files(tenant_id, club_id, batch_id, original_name, sha256, size_bytes, report_type, detected_type, confidence, headers, header_row,
          header_signature, mapping, mapping_confirmed, mapping_version, row_count, uploaded_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [ctx.tenantId, b.club_id, id, name, fileSha, buf.length, type, tpl ? 'template' : det.type, tpl ? 1 : det.confidence, JSON.stringify(headers), h + 1, signature,
        JSON.stringify(mapping), !!tpl, tpl?.version ?? null, data.length, ctx.userId])).rows[0].id;
      const rows = data.map((cells, i) => { const c = Array.from({ length: Math.max(width, cells.length) }, (_, k) => cells[k] ?? ''); return { no: h + 2 + i, cells: JSON.stringify(c) }; });
      await bulk(db, `insert into import_rows(tenant_id, club_id, batch_id, file_id, row_no, cells, checksum)
        select $1, $2, $3, $4, x.no, x.cells, encode(sha256(convert_to(x.cells::text, 'UTF8')), 'hex') from unnest($5::int[], $6::jsonb[]) as x(no, cells)`,
      [ctx.tenantId, b.club_id, id, fid], rows, (r) => [r.no, r.cells]);
      await db.query(`update import_batches set status = 'draft' where id = $1`, [id]);
      await audit(db, ctx, 'import.file_uploaded', 'import_batch', id, null, { fileName: name, rows: data.length, type, fromTemplate: !!tpl });
      return { id: fid, reportType: type, detectedType: det.type, confidence: tpl ? 1 : det.confidence, fromTemplate: !!tpl, candidates: det.candidates, rowCount: data.length };
    });
    reply.code(201);
    return res;
  });

  // Человек подтверждает или правит тип отчёта и карту полей
  app.put('/api/import/files/:id', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { reportType, mapping } = (req.body ?? {}) as { reportType?: ReportType; mapping?: Record<string, number | null> };
    if (!reportType || !REPORT_TYPES.includes(reportType)) throw badRequest('Выберите, какой это отчёт');
    return withCtx(pool, ctx, async (db) => {
      const f = (await db.query('select * from import_files where id = $1', [id])).rows[0];
      if (!f) throw notFound('Файл не найден');
      editable(await loadBatch(db, f.batch_id));
      let m: Mapping;
      if (mapping) {
        m = {};
        const used = new Set<number>();
        for (const fd of FIELDS[reportType]) {
          const col = mapping[fd.key];
          if (col === null || col === undefined) { m[fd.key] = null; continue; }
          if (!Number.isInteger(col) || col < 0 || col >= f.headers.length) throw badRequest(`Неверная колонка для поля «${fd.label}»`);
          if (used.has(col)) throw badRequest(`Колонка «${f.headers[col]}» выбрана для двух полей`);
          used.add(col); m[fd.key] = { col, confidence: 1 };
        }
        const miss = FIELDS[reportType].filter((fd) => fd.required && !m[fd.key]);
        if (miss.length) throw badRequest(`Укажите колонку для поля: ${miss.map((x) => `«${x.label}»`).join(', ')}`);
      } else m = reportType === f.report_type ? f.mapping : mapColumns(reportType, f.headers).mapping;
      await db.query(`update import_files set report_type = $2, mapping = $3, mapping_confirmed = $4 where id = $1`, [id, reportType, JSON.stringify(m), !!mapping]);
      await db.query(`update import_batches set status = 'draft' where id = $1`, [f.batch_id]);
      await audit(db, ctx, 'import.mapping_saved', 'import_file', id, { reportType: f.report_type, mapping: f.mapping }, { reportType, mapping: m, confirmed: !!mapping });
      return { ok: true };
    });
  });

  app.delete('/api/import/files/:id', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const f = (await db.query('select * from import_files where id = $1', [id])).rows[0];
      if (!f) throw notFound('Файл не найден');
      editable(await loadBatch(db, f.batch_id));
      await db.query('delete from import_files where id = $1', [id]);
      await db.query(`update import_batches set status = 'draft' where id = $1`, [f.batch_id]);
      await audit(db, ctx, 'import.file_removed', 'import_batch', f.batch_id, { fileName: f.original_name }, null);
      return { ok: true };
    });
  });

  // Пробный перенос: ничего не пишет в рабочие таблицы, только проверяет строки и строит отчёт сверки
  app.post('/api/import/batches/:id/check', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const b = await loadBatch(db, id); editable(b);
      const a = await analyze(db, b);
      await saveMarks(db, a.marks);
      const report = { ...a.report, mode: 'check' };
      await db.query(`update import_batches set status = 'checked', report = $2, checked_at = now() where id = $1`, [id, JSON.stringify(report)]);
      return report;
    });
  });

  app.get('/api/import/batches/:id/rows', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { status, type, limit } = req.query as { status?: string; type?: string; limit?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`select r.id::text, r.row_no as "rowNo", r.cells, r.status, r.issue, r.conflict_with as "conflictWith",
        r.conflict_person_id as "conflictPersonId", r.resolution, f.original_name as "fileName", f.report_type as "reportType", f.headers
      from import_rows r join import_files f on f.id = r.file_id
      where r.batch_id = $1 and ($2::text is null or ($2 = 'conflict' and r.conflict_with is not null) or ($2 <> 'conflict' and r.status = $2)) and ($3::text is null or f.report_type = $3)
      order by f.uploaded_at, r.row_no limit $4`, [id, status || null, type || null, Math.min(Number(limit) || 200, 1000)])).rows);
  });

  app.post('/api/import/rows/:id/resolve', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { resolution } = (req.body ?? {}) as { resolution?: string | null };
    if (resolution !== null && !['merge', 'new', 'skip'].includes(resolution ?? '')) throw badRequest('Выберите решение');
    return withCtx(pool, ctx, async (db) => {
      const r = (await db.query('select * from import_rows where id = $1', [id])).rows[0];
      if (!r) throw notFound('Строка не найдена');
      editable(await loadBatch(db, r.batch_id));
      if (!r.conflict_with) throw badRequest('По этой строке нет конфликта');
      await db.query(`update import_rows set resolution = $2, resolved_by = $3, resolved_at = now() where id = $1`, [id, resolution, ctx.userId]);
      await db.query(`update import_batches set status = 'draft' where id = $1`, [r.batch_id]);
      await audit(db, ctx, 'import.conflict_resolved', 'import_row', String(id), { resolution: r.resolution }, { resolution, conflictWith: r.conflict_with });
      return { ok: true };
    });
  });

  app.post('/api/import/batches/:id/apply', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    return withCtx(pool, ctx, async (db) => {
      await checkPassword(db, ctx, password);
      const b = (await db.query('select * from import_batches where id = $1 for update', [id])).rows[0];
      if (!b) throw notFound('Перенос не найден');
      if (b.status === 'applied' || b.status === 'accepted') throw badRequest('Этот перенос уже выполнен');
      if (b.status !== 'checked') throw badRequest('Сначала выполните пробный перенос и проверьте отчёт');
      return apply(db, ctx, b);
    });
  });

  app.post('/api/import/batches/:id/rollback', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    return withCtx(pool, ctx, async (db) => {
      await checkPassword(db, ctx, password);
      const b = await loadBatch(db, id);
      if (b.status !== 'applied') throw badRequest('Отменить можно только выполненный и ещё не принятый перенос');
      try {
        await db.query('savepoint rb');
        await db.query('select import_rollback($1, $2)', [id, ctx.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23503') {
          await db.query('rollback to savepoint rb');
          throw badRequest('После переноса с этими клиентами уже работали (продажи, заявки, задачи): отменить перенос целиком нельзя');
        }
        throw e;
      }
      await audit(db, ctx, 'import.rolled_back', 'import_batch', id, { status: 'applied' }, { status: 'rolled_back' });
      return { ok: true };
    });
  });

  app.post('/api/import/batches/:id/accept', async (req) => {
    const ctx = requirePerm(req, P.importManage);
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    return withCtx(pool, ctx, async (db) => {
      await checkPassword(db, ctx, password);
      const b = await loadBatch(db, id);
      if (b.status !== 'applied') throw badRequest('Принять можно только выполненный перенос');
      await db.query(`update import_batches set status = 'accepted', accepted_at = now(), accepted_by = $2 where id = $1`, [id, ctx.userId]);
      await audit(db, ctx, 'import.accepted', 'import_batch', id, { status: 'applied' }, { status: 'accepted' });
      return { ok: true };
    });
  });
}
