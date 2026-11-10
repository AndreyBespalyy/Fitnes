// Чтение таблиц из файлов выгрузки: CSV (UTF-8 или Windows-1251, разделитель ; , или табуляция) и XLSX.
// Без сторонних библиотек: XLSX — это zip-архив с XML, читаем первый лист.
import { inflateRawSync } from 'node:zlib';

export type Table = string[][];

export class TableError extends Error {}

export function readTable(buf: Buffer, fileName: string): Table {
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new TableError(`Файл «${fileName}» в старом формате Excel (.xls). Откройте его в Excel и сохраните как .xlsx или .csv`);
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return readXlsx(buf, fileName);
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    throw new TableError(`Файл «${fileName}» — это PDF. Нужна выгрузка таблицей: Excel (.xlsx) или .csv`);
  }
  return readCsv(decodeText(buf));
}

/* ---------- CSV ---------- */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

export function readCsv(text: string): Table {
  const firstLines = text.split(/\r?\n/).slice(0, 30).join('\n');
  const count = (ch: string) => firstLines.split(ch).length - 1;
  const delim = [';', '\t', ','].map((d) => [d, count(d)] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: Table = [];
  let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/* ---------- XLSX ---------- */
function unzip(buf: Buffer): Map<string, Buffer> {
  // Центральный каталог в конце архива
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new TableError('Файл Excel повреждён');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new TableError('Файл Excel повреждён');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26); const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data));
    p += 46 + nameLen + extraLen + commLen;
  }
  return out;
}

const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const textOf = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => xmlText(m[1])).join('');
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// Стандартные и пользовательские форматы, которые означают дату
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function readXlsx(buf: Buffer, fileName: string): Table {
  let files: Map<string, Buffer>;
  try { files = unzip(buf); } catch (e) { if (e instanceof TableError) throw e; throw new TableError(`Не удалось открыть «${fileName}» как файл Excel`); }
  const str = (n: string) => files.get(n)?.toString('utf8') ?? '';
  const wb = str('xl/workbook.xml');
  if (!wb) throw new TableError(`«${fileName}» не похож на файл Excel`);
  const firstSheet = wb.match(/<(?:\w+:)?sheet\b[^>]*r:id="([^"]+)"/);
  const rels = str('xl/_rels/workbook.xml.rels');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (firstSheet) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${firstSheet[1]}"`));
    const target = rel?.match(/Target="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const shared = [...str('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));
  // Стили: какие индексы стиля ячеек означают дату
  const styles = str('xl/styles.xml');
  const customDate = new Set([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)]
    .filter((m) => /[dyдг]/i.test(m[2].replace(/\[[^\]]*\]|"[^"]*"/g, ''))).map((m) => Number(m[1])));
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => { const id = Number(m[0].match(/numFmtId="(\d+)"/)?.[1] ?? 0); return DATE_FMT_IDS.has(id) || customDate.has(id); });
  const sheet = str(sheetPath);
  if (!sheet) throw new TableError(`В «${fileName}» не найден лист с данными`);
  const rows: Table = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const r: string[] = [];
    for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1]; const inner = cm[2] ?? '';
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
      const t = attrs.match(/t="(\w+)"/)?.[1];
      const s = Number(attrs.match(/s="(\d+)"/)?.[1] ?? -1);
      const v = inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'b') val = v === '1' ? 'да' : 'нет';
      else if (v !== undefined) {
        val = xmlText(v);
        if ((t === undefined || t === 'n') && s >= 0 && dateStyle[s] && /^\d+(\.\d+)?$/.test(val)) val = excelDate(Number(val));
      }
      const idx = ref ? colIndex(ref) : r.length;
      while (r.length < idx) r.push('');
      r[idx] = val.trim();
    }
    rows.push(r);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Число-дата Excel → «ДД.ММ.ГГГГ» или «ДД.ММ.ГГГГ ЧЧ:ММ». */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return serial % 1 ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}
