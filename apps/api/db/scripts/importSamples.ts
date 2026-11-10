// Образцы пяти отчётов «как из 1С» для проверки переноса: шапка отчёта над таблицей, строка итогов,
// CSV в кодировке Windows-1251 с разделителем «;», Excel с датами-числами. Данные вымышленные.
// Запуск: npm run import:samples -- <папка>  (по умолчанию ./образцы_1С)
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const p2 = (n: number) => String(n).padStart(2, '0');
function day(offset: number) { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d; }
const ru = (d: Date) => `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
const excelSerial = (d: Date, h = 0, m = 0) => d.getTime() / 86400000 + 25569 + (h * 60 + m) / 1440;

/* ---------- запись XLSX ---------- */
type Cell = string | number | { date: number };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i: number) => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

function zip(files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name); const z = deflateRawSync(data); const crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(z.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    parts.push(h, n, z);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(z.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += 30 + n.length + z.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

export function xlsx(rows: Cell[][]): Buffer {
  const strings: string[] = []; const idx = new Map<string, number>();
  const si = (s: string) => { if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); } return idx.get(s)!; };
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'object') return `<c r="${ref}" s="${Number.isInteger(v.date) ? 1 : 2}"><v>${v.date}</v></c>`;
    return v === '' ? '' : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
  }).join('')}</row>`).join('');
  const x = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);
  return zip([
    ['[Content_Types].xml', x(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`)],
    ['_rels/.rels', x(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)],
    ['xl/workbook.xml', x(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Отчёт" sheetId="1" r:id="rId1"/></sheets></workbook>`)],
    ['xl/_rels/workbook.xml.rels', x(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)],
    ['xl/styles.xml', x(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`)],
    ['xl/sharedStrings.xml', x(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`)],
    ['xl/worksheets/sheet1.xml', x(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)],
  ]);
}

export function csv1251(rows: string[][]): Buffer {
  const text = rows.map((r) => r.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';')).join('\r\n') + '\r\n';
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) out.push(code);
    else if (code >= 0x410 && code <= 0x44f) out.push(code - 0x410 + 0xc0);
    else if (code === 0x401) out.push(0xa8); else if (code === 0x451) out.push(0xb8);
    else if (code === 0x2116) out.push(0xb9); else if (code === 0xab) out.push(0xab); else if (code === 0xbb) out.push(0xbb);
    else if (code === 0xa0) out.push(0xa0); else out.push(0x3f);
  }
  return Buffer.from(out);
}

/* ---------- данные ---------- */
// Клиенты. К-0003 — телефон совпадает с клиентом, который уже есть в системе (Павел Рябов) → конфликт.
// К-0007 и К-0008 — один телефон на двоих (родственники) → конфликт. К-0005 повторяется строкой целиком.
const CLIENTS: [string, string, string, string, Date | null][] = [
  ['К-0001', 'Иванова Мария Сергеевна', '8 (916) 111-22-01', 'maria.ivanova@example.ru', day(-11000)],
  ['К-0002', 'Петров Илья Андреевич', '+7 916 111-22-02', '', day(-12500)],
  ['К-0003', 'Рябов Павел Игоревич', '89260000155', 'p.ryabov@example.ru', day(-13000)],
  ['К-0004', 'Соколова Анна Викторовна', '9161112204', '', day(-9500)],
  ['К-0005', 'Кузнецов Дмитрий Олегович', '8-916-111-22-05', 'kuznetsov@example', null],
  ['К-0006', 'Новикова Ольга Павловна', '111-22-06', '', day(-10200)],
  ['К-0007', 'Морозов Артём Ильич', '+79161112207', '', day(-8000)],
  ['К-0008', 'Морозова Вера Николаевна', '+79161112207', '', day(-8300)],
  ['К-0009', 'Лебедев Константин Юрьевич', '+79161112209', '', day(-14000)],
  ['К-0010', 'Ёлкина Дарья Максимовна', '+79161112210', 'elkina@example.ru', day(-7600)],
];

export function samples() {
  const clients = xlsx([
    ['Отчёт «Список клиентов»'], ['Организация: ООО «Фитнес Центр»'], [],
    ['Код', 'ФИО', 'Телефон', 'E-mail', 'Дата рождения', 'Номер карты'],
    ...CLIENTS.flatMap(([code, name, phone, email, birth], i): Cell[][] => {
      const row: Cell[] = [code, name, phone, email, birth ? { date: Math.round(excelSerial(birth)) } : '', `0400${100 + i}`];
      return code === 'К-0005' ? [row, row] : [row];
    }),
  ]);
  const mem: [string, string, string, string, number, number, number, string, string][] = [
    // код, клиент, договор, вид, начало (сдвиг дней), окончание (сдвиг), стоимость, остаток, состояние
    ['А-101', 'К-0001', 'ЦФ-2026-0101', 'Безлимит 12 месяцев', -200, 165, 3600000, '', 'Действует'],
    ['А-102', 'К-0002', 'ЦФ-2026-0102', 'Безлимит 3 месяца', -400, -310, 1200000, '', 'Закрыт'],
    ['А-103', 'К-0002', 'ЦФ-2026-0103', 'Безлимит 3 месяца', -30, 60, 1200000, '', 'Действует'],
    ['А-104', 'К-0004', 'ЦФ-2026-0104', 'Пакет 10 персональных', -20, 70, 2500000, '6', 'Действует'],
    ['А-105', 'К-0005', 'ЦФ-2026-0105', 'Безлимит 12 месяцев', -100, 265, 3600000, '', 'Заморожен'],
    ['А-106', 'К-0006', 'ЦФ-2026-0106', 'Безлимит 3 месяца', -50, 40, 1200000, '', 'Аннулирован'],
    ['А-107', 'К-0009', 'ЦФ-2026-0107', 'Утро 6 месяцев', -10, 172, 1800050, '', 'Действует'],
    ['А-108', 'К-0010', 'ЦФ-2026-0108', 'Безлимит 3 месяца', 5, 95, 1200000, '', 'Не начат'],
    ['А-109', 'К-0099', 'ЦФ-2026-0109', 'Безлимит 3 месяца', -60, 30, 1200000, '', 'Действует'],
  ];
  const kop = (k: number) => `${Math.floor(k / 100).toLocaleString('ru-RU').replace(/ /g, ' ')},${p2(k % 100)}`;
  const memberships = csv1251([
    ['Абонементы клиентов на ' + ru(day(0))], [''],
    ['Код абонемента', 'Код клиента', 'Номер договора', 'Дата договора', 'Вид абонемента', 'Дата начала', 'Дата окончания', 'Стоимость', 'Остаток посещений', 'Состояние'],
    ...mem.map(([c, cl, n, v, s, e, a, left, st]) => [c, cl, n, ru(day(s)), v, ru(day(s)), ru(day(e)), kop(a), left, st]),
  ]);
  // Платежи: А-101 оплачен полностью, А-103 — частично (долг 4 000 ₽ в остатках), А-104 в два платежа, по А-106 возврат.
  const pay: [string, number, string, number, string, string, string][] = [
    ['ПКО-0001', -200, 'К-0001', 3600000, 'Наличные', 'Оплата', 'ЦФ-2026-0101'],
    ['ЭКВ-0002', -400, 'К-0002', 1200000, 'Банковская карта', 'Оплата', 'ЦФ-2026-0102'],
    ['ЭКВ-0003', -30, 'К-0002', 800000, 'Банковская карта', 'Оплата', 'ЦФ-2026-0103'],
    ['ЭКВ-0004', -20, 'К-0004', 1250000, 'Эквайринг', 'Оплата', 'ЦФ-2026-0104'],
    ['ЭКВ-0005', -5, 'К-0004', 1250000, 'Эквайринг', 'Оплата', 'ЦФ-2026-0104'],
    ['ПКО-0006', -100, 'К-0005', 3600000, 'Наличные', 'Оплата', 'ЦФ-2026-0105'],
    ['ПКО-0007', -50, 'К-0006', 1200000, 'Наличные', 'Оплата', 'ЦФ-2026-0106'],
    ['РКО-0008', -45, 'К-0006', -1100000, 'Наличные', 'Возврат', 'ЦФ-2026-0106'],
    ['СБП-0009', -10, 'К-0009', 1800050, 'СБП', 'Оплата', 'ЦФ-2026-0107'],
    ['ЭКВ-0010', -2, 'К-0010', 1200000, 'Банковская карта', 'Оплата', ''],
    ['ПКО-0011', -3, 'К-0099', 500000, 'Наличные', 'Оплата', ''],
  ];
  const total = pay.reduce((s, p) => s + p[3], 0);
  const payments = csv1251([
    ['Оплаты клиентов за период'], [''],
    ['Дата', 'Номер документа', 'Код клиента', 'Сумма', 'Вид оплаты', 'Операция', 'Договор'],
    ...pay.map(([n, d, cl, a, m, op, dog]) => [`${ru(day(d))} 11:${p2(Math.abs(d) % 60)}:00`, n, cl, a < 0 ? `-${kop(-a)}` : kop(a), m, op, dog]),
    ['Итого', '', '', total < 0 ? `-${kop(-total)}` : kop(total), '', '', ''],
  ]);
  const vis: [string, number, number, number][] = [
    ['К-0001', -3, 8, 15], ['К-0001', -1, 19, 5], ['К-0002', -2, 7, 40], ['К-0004', -4, 12, 0], ['К-0004', -4, 12, 0], ['К-0009', -1, 9, 30], ['К-0055', -1, 10, 0],
  ];
  const visits = xlsx([
    ['Посещения клиентов'], [],
    ['Код клиента', 'Дата посещения', 'Зона'],
    ...vis.map(([cl, d, h, m]): Cell[] => [cl, { date: excelSerial(day(d), h, m) }, 'Тренажёрный зал']),
  ]);
  const balances = csv1251([
    ['Остатки по клиентам на ' + ru(day(0))], [''],
    ['Код клиента', 'Номер договора', 'Задолженность', 'Аванс'],
    ['К-0002', 'ЦФ-2026-0103', '4 000,00', '0,00'],
    ['К-0004', '', '0,00', '1 500,00'],
    ['К-0009', '', '0,00', '0,00'],
  ]);
  return {
    'Клиенты.xlsx': clients,
    'Абонементы.csv': memberships,
    'Оплаты.csv': payments,
    'Посещения.xlsx': visits,
    'Остатки_и_долги.csv': balances,
  } as Record<string, Buffer>;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? 'образцы_1С');
  mkdirSync(dir, { recursive: true });
  for (const [n, b] of Object.entries(samples())) writeFileSync(join(dir, n), b);
  console.log(`Образцы сохранены в ${dir}`);
}
