// Шаг 12. Сверка с банковской выпиской. Формат 1CClientBankExchange («выгрузка в 1С») умеет отдавать любой банк.
// Система сама находит: возмещение эквайринга за день (минус комиссия), переводы от клиентов и юрлиц, оплату расходов, комиссии банка.
// Что не нашлось — показывает списком, бухгалтер сопоставляет вручную или отмечает «другое».
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { addDays, clubToday } from './memberships.ts';

export type BankDoc = { date: string; number: string | null; direction: 'in' | 'out'; amountKop: number; counterparty: string | null; inn: string | null; purpose: string | null };
export type Statement = { account: string | null; from: string | null; to: string | null; openingKop: number | null; closingKop: number | null; docs: BankDoc[] };

const MAX = 15 * 1024 * 1024;
// ИНН эквайеров: НКО «ЮМани» (ЮKassa), Т-Банк, Сбербанк, Альфа-Банк, ВТБ
const ACQUIRER_INN = ['7750005725', '7710140679', '7707083893', '7728168971', '7702070139'];
const isoDate = (s: string | undefined) => { const m = (s ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const kop = (s: string | undefined) => { if (!s) return null; const n = Number(s.replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

export function decodeStatement(buf: Buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1251').decode(buf); }
}

/** Разбор выписки в формате 1CClientBankExchange. */
const money = (kop: number) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
export function parseStatement(text: string): Statement {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  if (!lines[0]?.startsWith('1CClientBankExchange')) throw badRequest('Это не выписка в формате 1С. В интернет-банке выберите «Экспорт выписки» → «1С: Предприятие» (файл .txt)');
  const head: Record<string, string> = {};
  const docs: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  let section = '';
  for (const l of lines) {
    const i = l.indexOf('=');
    const k = i > 0 ? l.slice(0, i) : l; const v = i > 0 ? l.slice(i + 1) : '';
    if (k === 'СекцияДокумент') { cur = { Вид: v }; continue; }
    if (k === 'КонецДокумента') { if (cur) docs.push(cur); cur = null; continue; }
    if (k === 'СекцияРасчСчет') { section = 'acc'; continue; }
    if (k === 'КонецРасчСчет') { section = ''; continue; }
    if (cur) { if (!(k in cur)) cur[k] = v; continue; }
    if (section === 'acc' || !(k in head)) head[k] = v;
  }
  const account = head['РасчСчет'] ?? null;
  const out: BankDoc[] = [];
  for (const d of docs) {
    const amountKop = kop(d['Сумма']);
    if (!amountKop || amountKop <= 0) continue;
    let direction: 'in' | 'out';
    if (account && d['ПолучательСчет'] === account) direction = 'in';
    else if (account && d['ПлательщикСчет'] === account) direction = 'out';
    else direction = d['ДатаПоступило'] ? 'in' : 'out';
    const date = isoDate(direction === 'in' ? d['ДатаПоступило'] || d['Дата'] : d['ДатаСписано'] || d['Дата']);
    if (!date) continue;
    const who = direction === 'in' ? (d['Плательщик1'] || d['Плательщик']) : (d['Получатель1'] || d['Получатель']);
    out.push({ date, number: d['Номер'] || null, direction, amountKop, counterparty: who?.replace(/^ИНН \d+\s*/, '') || null,
      inn: (direction === 'in' ? d['ПлательщикИНН'] : d['ПолучательИНН']) || null, purpose: d['НазначениеПлатежа'] || null });
  }
  return { account, from: isoDate(head['ДатаНачала']), to: isoDate(head['ДатаКонца']), openingKop: kop(head['НачальныйОстаток']), closingKop: kop(head['КонечныйОстаток']), docs: out };
}

const fingerprint = (d: BankDoc) => createHash('sha256').update([d.date, d.number, d.direction, d.amountKop, d.inn, d.purpose].join('|')).digest('hex').slice(0, 32);

/* ---------- автоматическое сопоставление ---------- */
/** Онлайн-оплаты клуба по дням (по часам клуба): сколько клиенты заплатили — от этой суммы банк вернёт деньги минус комиссия. */
async function onlineByDay(db: Db, clubId: string, from: string, to: string) {
  return (await db.query(`select to_char((p.created_at at time zone c.timezone)::date, 'YYYY-MM-DD') as day, sum(p.amount_kop)::bigint as gross
    from payments p join clubs c on c.id = p.club_id where p.club_id = $1 and p.direction = 'in' and p.method in ('online', 'sbp')
      and (p.created_at at time zone c.timezone)::date between $2 and $3 group by 1 order by 1`, [clubId, from, to])).rows.map((r) => ({ day: r.day as string, gross: Number(r.gross) }));
}

async function autoMatch(db: Db, clubId: string, lineId: string) {
  const l = (await db.query(`select id, to_char(op_date, 'YYYY-MM-DD') as op_date, direction, amount_kop, counterparty, counterparty_inn, purpose from bank_lines where id = $1`, [lineId])).rows[0];
  const amount = Number(l.amount_kop);
  const text = `${l.counterparty ?? ''} ${l.purpose ?? ''}`;
  const set = (q: string, p: unknown[]) => db.query(`update bank_lines set status = 'matched', matched_auto = true, ${q} where id = $1`, [lineId, ...p]);
  if (l.direction === 'in' && (ACQUIRER_INN.includes(l.counterparty_inn ?? '') || /эквайр|возмещ|ю ?касс|юмани|yookassa|интернет-платеж|по операциям с картами|сбп/i.test(text))) {
    // Возмещение за 1–3 дня подряд (после выходных банк присылает сразу за несколько дней), комиссия от 0 до 5 %
    const days = await onlineByDay(db, clubId, addDays(l.op_date, -10), addDays(l.op_date, -1));
    const used = new Set((await db.query(`select to_char(acquiring_day, 'YYYY-MM-DD') as d, note from bank_lines where club_id = $1 and match_kind = 'acquiring' and acquiring_day is not null and id <> $2`, [clubId, lineId])).rows
      .flatMap((r) => [r.d, ...(String(r.note ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [])]));
    const free = days.filter((d) => !used.has(d.day)).reverse();
    for (let span = 1; span <= 3; span++) {
      for (let i = 0; i + span <= free.length; i++) {
        const grp = free.slice(i, i + span);
        const gross = grp.reduce((s, d) => s + d.gross, 0);
        const fee = gross - amount;
        if (gross >= amount && fee <= gross * 0.05) {
          const ds = grp.map((d) => d.day).sort();
          await set(`match_kind = 'acquiring', acquiring_day = $2, acquiring_gross_kop = $3, note = $4`,
            [ds[0], gross, `Эквайринг за ${ds.map(ru).join(', ')}: оплачено ${money(gross)}, комиссия банка ${money(fee)} (${((fee / gross) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} %) [${ds.join(',')}]`]);
          return 'acquiring';
        }
      }
    }
    return null;
  }
  if (l.direction === 'out' && /комисси|обслуживан|тариф/i.test(text) && amount < 5_000_000) {
    await set(`match_kind = 'bank_fee', note = 'Комиссия банка'`, []);
    return 'bank_fee';
  }
  if (l.direction === 'in') {
    const p = (await db.query(`select p.id from payments p where p.club_id = $1 and p.direction = 'in' and p.method = 'bank_transfer' and p.amount_kop = $2
        and p.created_at::date between $3::date - 7 and $3::date + 1 and not exists (select 1 from bank_lines b where b.payment_id = p.id) order by abs(p.created_at::date - $3::date) limit 1`,
    [clubId, amount, l.op_date])).rows[0];
    if (p) { await set(`match_kind = 'payment', payment_id = $2`, [p.id]); return 'payment'; }
    return null;
  }
  const e = (await db.query(`select e.id from expenses e where e.club_id = $1 and e.method = 'bank_transfer' and e.status = 'approved' and e.amount_kop = $2
      and e.spent_on between $3::date - 10 and $3::date + 3 and not exists (select 1 from bank_lines b where b.expense_id = e.id) order by abs(e.spent_on - $3::date) limit 1`,
  [clubId, amount, l.op_date])).rows[0];
  if (e) { await set(`match_kind = 'expense', expense_id = $2`, [e.id]); return 'expense'; }
  const r = (await db.query(`select p.id from payments p where p.club_id = $1 and p.direction = 'out' and p.method = 'bank_transfer' and p.amount_kop = $2
      and p.created_at::date between $3::date - 7 and $3::date + 1 and not exists (select 1 from bank_lines b where b.payment_id = p.id) limit 1`, [clubId, amount, l.op_date])).rows[0];
  if (r) { await set(`match_kind = 'payment', payment_id = $2`, [r.id]); return 'payment'; }
  return null;
}

/** Пример выписки для проверки сверки: возмещение по онлайн-оплатам клуба за последние дни, комиссия банка и пара «неизвестных» операций. */
async function sampleStatement(db: Db, clubId: string) {
  const today = await clubToday(db, clubId);
  const days = await onlineByDay(db, clubId, addDays(today, -14), today);
  const le = (await db.query(`select full_name, inn, account from legal_entities where club_id = $1`, [clubId])).rows[0] ?? { full_name: 'ООО «Клуб»', inn: '7700000000', account: '40702810000000000001' };
  const acc = le.account ?? '40702810000000000001';
  const d = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  const sum = (k: number) => (k / 100).toFixed(2);
  const doc = (o: { date: string; n: number; amount: number; in: boolean; who: string; inn: string; purpose: string }) => [
    'СекцияДокумент=Платежное поручение', `Номер=${o.n}`, `Дата=${d(o.date)}`, `Сумма=${sum(o.amount)}`,
    `ПлательщикСчет=${o.in ? '30233810000000000001' : acc}`, `Плательщик=${o.in ? o.who : le.full_name}`, `ПлательщикИНН=${o.in ? o.inn : le.inn}`,
    `ПолучательСчет=${o.in ? acc : '40702810900000000777'}`, `Получатель=${o.in ? le.full_name : o.who}`, `ПолучательИНН=${o.in ? le.inn : o.inn}`,
    o.in ? `ДатаПоступило=${d(o.date)}` : `ДатаСписано=${d(o.date)}`, `НазначениеПлатежа=${o.purpose}`, 'КонецДокумента'].join('\r\n');
  const docs: string[] = []; let n = 100;
  for (const x of days) {
    const pay = addDays(x.day, 1);
    if (pay > today) continue;
    const fee = Math.round(x.gross * 0.022);
    docs.push(doc({ date: pay, n: n++, amount: x.gross - fee, in: true, who: 'НКО «ЮМани» (ООО)', inn: '7750005725', purpose: `Перечисление денежных средств по операциям за ${d(x.day)} по договору эквайринга. НДС не облагается` }));
  }
  docs.push(doc({ date: today, n: n++, amount: 49_000, in: false, who: 'ПАО «Банк»', inn: '7707083893', purpose: 'Комиссия за обслуживание счёта за месяц' }));
  docs.push(doc({ date: today, n: n++, amount: 1_250_000, in: true, who: 'ООО «Ромашка»', inn: '7712345678', purpose: 'Оплата по счёту № 15 за корпоративные абонементы. НДС не облагается' }));
  docs.push(doc({ date: today, n: n++, amount: 3_800_000, in: false, who: 'ИП Петров А. А.', inn: '771234567890', purpose: 'Оплата за ремонт душевых по счёту № 7' }));
  return ['1CClientBankExchange', 'ВерсияФормата=1.03', 'Кодировка=Windows', `ДатаНачала=${d(addDays(today, -14))}`, `ДатаКонца=${d(today)}`, `РасчСчет=${acc}`,
    'СекцияРасчСчет', `ДатаНачала=${d(addDays(today, -14))}`, `ДатаКонца=${d(today)}`, `РасчСчет=${acc}`, 'НачальныйОстаток=150000.00', 'КонечныйОстаток=150000.00', 'КонецРасчСчет',
    ...docs, 'КонецФайла', ''].join('\r\n');
}

export function bankRoutes(app: FastifyInstance, pool: pg.Pool) {
  const club = async (db: Db, id?: string) => { if (!id || !(await db.query('select 1 from clubs where id = $1', [id])).rowCount) throw badRequest('Выберите клуб'); return id; };

  app.post('/api/bank/statements', { bodyLimit: Math.ceil(MAX * 1.4) + 4096 }, async (req, reply) => {
    const ctx = requirePerm(req, P.financeWork);
    const b = (req.body ?? {}) as { clubId?: string; fileName?: string; dataBase64?: string };
    if (!b.dataBase64) throw badRequest('Файл не передан');
    const buf = Buffer.from(b.dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw badRequest('Файл пустой');
    if (buf.length > MAX) throw badRequest('Файл больше 15 МБ: выгрузите выписку за меньший период');
    const st = parseStatement(decodeStatement(buf));
    if (!st.docs.length) throw badRequest('В выписке нет операций');
    const res = await withCtx(pool, ctx, async (db) => {
      await club(db, b.clubId);
      const sid = (await db.query(`insert into bank_statements(tenant_id, club_id, file_name, account, date_from, date_to, opening_kop, closing_kop, lines, uploaded_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [ctx.tenantId, b.clubId, (b.fileName || 'выписка.txt').slice(0, 200), st.account, st.from, st.to, st.openingKop, st.closingKop, st.docs.length, ctx.userId])).rows[0].id;
      let added = 0; let dup = 0; const matched: Record<string, number> = {};
      for (const d of st.docs) {
        const r = (await db.query(`insert into bank_lines(tenant_id, club_id, statement_id, fingerprint, op_date, doc_number, direction, amount_kop, counterparty, counterparty_inn, purpose)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (club_id, fingerprint) do nothing returning id`,
        [ctx.tenantId, b.clubId, sid, fingerprint(d), d.date, d.number, d.direction, d.amountKop, d.counterparty?.slice(0, 300) ?? null, d.inn, d.purpose?.slice(0, 1000) ?? null])).rows[0];
        if (!r) { dup++; continue; }
        added++;
        const k = await autoMatch(db, b.clubId!, r.id);
        if (k) matched[k] = (matched[k] ?? 0) + 1;
      }
      await db.query('update bank_statements set lines = $2 where id = $1', [sid, added]);
      // AT13: операции без пары не сводятся «как-нибудь» — остаются «не сверено», финансист (или управляющий) получает задачу
      const unmatched = added - Object.values(matched).reduce((s, n) => s + n, 0);
      if (unmatched > 0) {
        const fin = (await db.query(`select distinct a.user_id, a.role_code from user_assignments a join users u on u.id = a.user_id
          where (a.club_id = $1 or a.club_id is null) and a.role_code in ('fin', 'gm') and u.status = 'active' and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date)`, [b.clubId])).rows;
        const to = fin.some((f) => f.role_code === 'fin') ? fin.filter((f) => f.role_code === 'fin') : fin;
        for (const f of to) await db.query(`insert into tasks(tenant_id, club_id, assignee_id, kind, title, due_at, created_by) values ($1,$2,$3,'other',$4, now() + interval '1 day', $5)`,
          [ctx.tenantId, b.clubId, f.user_id, `Сверка с банком: ${unmatched} операц. без пары в выписке за ${st.from ?? ''}–${st.to ?? ''} — разберите во вкладке «Финансы»`, ctx.userId]);
      }
      await audit(db, ctx, 'bank.statement_uploaded', 'club', b.clubId!, null, { statementId: sid, added, dup, matched });
      return { id: sid, added, duplicates: dup, matched, unmatched: added - Object.values(matched).reduce((s, n) => s + n, 0), period: { from: st.from, to: st.to } };
    });
    reply.code(201);
    return res;
  });

  app.get('/api/bank/sample', async (req, reply) => {
    const ctx = requirePerm(req, P.financeWork);
    const { clubId } = req.query as { clubId?: string };
    const text = await withCtx(pool, ctx, async (db) => sampleStatement(db, await club(db, clubId)));
    // Как настоящая выгрузка банка: кодировка Windows-1251
    const bytes = Buffer.from(Array.from(text, (ch) => { const c = ch.charCodeAt(0); if (c < 128) return c; if (c >= 0x410 && c <= 0x44f) return c - 0x350; if (c === 0x401) return 0xa8; if (c === 0x451) return 0xb8; if (c === 0xab) return 0xab; if (c === 0xbb) return 0xbb; if (c === 0x2116) return 0xb9; return 0x3f; }));
    reply.header('content-type', 'text/plain; charset=windows-1251').header('content-disposition', 'attachment; filename="kl_to_1c_sample.txt"');
    return reply.send(bytes);
  });

  app.get('/api/bank/lines', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { clubId, status, from, to } = req.query as { clubId?: string; status?: string; from?: string; to?: string };
    return withCtx(pool, ctx, async (db) => {
      await club(db, clubId);
      const lines = (await db.query(`select b.id, to_char(b.op_date, 'YYYY-MM-DD') as "date", b.doc_number as number, b.direction, b.amount_kop::bigint as "amountKop", b.counterparty, b.counterparty_inn as inn,
          b.purpose, b.status, b.match_kind as "matchKind", b.note, b.matched_auto as "auto", u.full_name as "matchedBy", b.acquiring_gross_kop::bigint as "grossKop",
          coalesce(pp.full_name, '') as "payPerson", e.description as "expense"
        from bank_lines b left join users u on u.id = b.matched_by left join payments p on p.id = b.payment_id left join persons pp on pp.id = p.person_id left join expenses e on e.id = b.expense_id
        where b.club_id = $1 and ($2::text is null or b.status = $2) and ($3::date is null or b.op_date >= $3) and ($4::date is null or b.op_date <= $4)
        order by b.op_date desc, b.created_at desc limit 500`, [clubId, status || null, from || null, to || null])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop), grossKop: r.grossKop == null ? null : Number(r.grossKop) }));
      const statements = (await db.query(`select s.id, s.file_name as "fileName", to_char(s.date_from, 'YYYY-MM-DD') as "from", to_char(s.date_to, 'YYYY-MM-DD') as "to", s.lines, s.created_at as "createdAt", u.full_name as "uploadedBy"
        from bank_statements s left join users u on u.id = s.uploaded_by where s.club_id = $1 order by s.created_at desc limit 20`, [clubId])).rows;
      // Чего нет в выписке: дни с онлайн-оплатами без возмещения (старше 3 дней) и переводы, которые в системе есть, а в банке нет
      const today = await clubToday(db, clubId!);
      const covered = new Set((await db.query(`select note from bank_lines where club_id = $1 and match_kind = 'acquiring'`, [clubId])).rows.flatMap((r) => String(r.note ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? []));
      const range = (await db.query(`select to_char(min(op_date), 'YYYY-MM-DD') as a, to_char(max(op_date), 'YYYY-MM-DD') as b from bank_lines where club_id = $1`, [clubId])).rows[0];
      const notPaidOut = range.a ? (await onlineByDay(db, clubId!, addDays(range.a, -3), addDays(today, -3))).filter((d) => !covered.has(d.day) && d.day <= range.b) : [];
      const missing = range.a ? (await db.query(`select p.id, p.created_at as "at", p.amount_kop::bigint as "amountKop", p.direction, coalesce(pp.full_name, e.description) as who
        from payments p left join persons pp on pp.id = p.person_id left join expenses e on e.id = p.expense_id
        where p.club_id = $1 and p.method = 'bank_transfer' and p.created_at::date between $2 and $3 and not exists (select 1 from bank_lines b where b.payment_id = p.id)
          and not exists (select 1 from bank_lines b where b.expense_id = p.expense_id and p.expense_id is not null)`, [clubId, range.a, range.b])).rows.map((r) => ({ ...r, amountKop: Number(r.amountKop) })) : [];
      const sum = (f: (l: typeof lines[number]) => boolean) => lines.filter(f).reduce((s, l) => s + l.amountKop, 0);
      return { lines, statements, notPaidOut, missing,
        totals: { inKop: sum((l) => l.direction === 'in'), outKop: sum((l) => l.direction === 'out'), unmatched: lines.filter((l) => l.status === 'unmatched').length,
          feesKop: lines.filter((l) => l.matchKind === 'acquiring').reduce((s, l) => s + ((l.grossKop ?? 0) - l.amountKop), 0) } };
    });
  });

  app.get('/api/bank/lines/:id/candidates', async (req) => {
    const ctx = requirePerm(req, P.financeView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      const l = (await db.query('select club_id, direction, amount_kop, op_date from bank_lines where id = $1', [id])).rows[0];
      if (!l) throw notFound('Операция не найдена');
      const payments = (await db.query(`select p.id, p.created_at as "at", p.amount_kop::bigint as "amountKop", p.method, p.kind, coalesce(pp.full_name, '—') as who
        from payments p left join persons pp on pp.id = p.person_id where p.club_id = $1 and p.direction = $2 and p.amount_kop = $3 and p.created_at::date between $4::date - 30 and $4::date + 3
          and not exists (select 1 from bank_lines b where b.payment_id = p.id) order by abs(p.created_at::date - $4::date) limit 10`, [l.club_id, l.direction, l.amount_kop, l.op_date])).rows;
      const expenses = l.direction === 'out' ? (await db.query(`select e.id, to_char(e.spent_on, 'YYYY-MM-DD') as "date", e.amount_kop::bigint as "amountKop", e.description, e.status from expenses e
        where e.club_id = $1 and e.amount_kop = $2 and e.spent_on between $3::date - 30 and $3::date + 3 and not exists (select 1 from bank_lines b where b.expense_id = e.id) limit 10`, [l.club_id, l.amount_kop, l.op_date])).rows : [];
      return { payments: payments.map((p) => ({ ...p, amountKop: Number(p.amountKop) })), expenses: expenses.map((e) => ({ ...e, amountKop: Number(e.amountKop) })) };
    });
  });

  app.post('/api/bank/lines/:id/match', async (req) => {
    const ctx = requirePerm(req, P.financeWork);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { kind?: string; paymentId?: string; expenseId?: string; note?: string };
    const kinds = ['payment', 'expense', 'bank_fee', 'other', 'ignored', 'reset'];
    if (!kinds.includes(b.kind ?? '')) throw badRequest('Выберите, что это за операция');
    if ((b.kind === 'other' || b.kind === 'ignored') && !b.note?.trim()) throw badRequest('Напишите, что это за операция');
    return withCtx(pool, ctx, async (db) => {
      const l = (await db.query('select * from bank_lines where id = $1', [id])).rows[0];
      if (!l) throw notFound('Операция не найдена');
      if (b.kind === 'reset') {
        await db.query(`update bank_lines set status = 'unmatched', match_kind = null, payment_id = null, expense_id = null, acquiring_day = null, acquiring_gross_kop = null, matched_auto = null, matched_by = null, note = null where id = $1`, [id]);
      } else if (b.kind === 'payment') {
        const p = (await db.query('select amount_kop from payments where id = $1 and club_id = $2', [b.paymentId, l.club_id])).rows[0];
        if (!p) throw badRequest('Платёж не найден');
        if (Number(p.amount_kop) !== Number(l.amount_kop)) throw badRequest('Сумма платежа в системе не совпадает с суммой в выписке');
        await db.query(`update bank_lines set status = 'matched', match_kind = 'payment', payment_id = $2, matched_auto = false, matched_by = $3, note = $4 where id = $1`, [id, b.paymentId, ctx.userId, b.note?.trim() || null]);
      } else if (b.kind === 'expense') {
        const e = (await db.query('select amount_kop from expenses where id = $1 and club_id = $2', [b.expenseId, l.club_id])).rows[0];
        if (!e) throw badRequest('Расход не найден');
        await db.query(`update bank_lines set status = 'matched', match_kind = 'expense', expense_id = $2, matched_auto = false, matched_by = $3, note = $4 where id = $1`, [id, b.expenseId, ctx.userId, b.note?.trim() || null]);
      } else {
        await db.query(`update bank_lines set status = $2, match_kind = $3, matched_auto = false, matched_by = $4, note = $5 where id = $1`,
          [id, b.kind === 'ignored' ? 'ignored' : 'matched', b.kind === 'ignored' ? null : b.kind, ctx.userId, b.note?.trim() || (b.kind === 'bank_fee' ? 'Комиссия банка' : null)]);
      }
      await audit(db, ctx, 'bank.line_matched', 'club', l.club_id, { status: l.status, kind: l.match_kind }, { kind: b.kind, paymentId: b.paymentId ?? null, expenseId: b.expenseId ?? null, note: b.note ?? null });
      return { ok: true };
    });
  });
}
