// Шаг 9. Раздел «Перенос из 1С»: загрузка пяти отчётов, карта полей, пробный перенос с отчётом сверки,
// решение конфликтов, перенос с паролем, принятие или отмена.
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';
import { readFile } from './contracts.tsx';

type FieldDef = { key: string; label: string; required: boolean };
type TypeDef = { type: string; name: string; fields: FieldDef[] };
type Batch = { id: string; clubId: string; clubName: string; status: string; createdAt: string; checkedAt: string | null; appliedAt: string | null; acceptedAt: string | null;
  rolledBackAt: string | null; createdByName: string | null; canApply?: boolean; applied?: Applied | null };
type Applied = { persons: number; merged: number; memberships: number; contracts: number; payments: number; visits: number; debts: number; products: number; tasks?: number; taskHistory?: number; staff?: number };
type IFile = { id: string; fileName: string; reportType: string | null; detectedType: string; confidence: number; headers: string[]; headerRow: number;
  mapping: Record<string, { col: number; confidence: number } | null>; mappingConfirmed: boolean; mappingVersion: number | null; rowCount: number; sample: string[][] };
type Count = { name: string; files: number; source: number; load: number; warning: number; excluded: number; conflict: number; skipped: number; earlier: number };
type Month = { month: string; inSourceKop: number; inLoadKop: number; outSourceKop: number; outLoadKop: number };
type Issue = { type: string; status: string; group: string; count: number; examples: { rowNo: number; file: string; issue: string }[] };
type Report = { generatedAt: string; mode: 'check' | 'applied'; canApply: boolean; blockers: string[]; counts: Record<string, Count>;
  money: { months: Month[]; totals: Omit<Month, 'month'>; paymentsFooterKop: number | null; debts: { sourceKop: number; loadKop: number };
    advances: { sourceKop: number; count: number }; memberships: { loadKop: number; footerKop: number | null } };
  completeness: { clientsWithoutPhone: number; clientsWithoutBirthDate: number; clientsWithoutEmail: number; membershipsWithoutContract: number; membershipsActive: number;
    paymentsWithoutMembership: number; tasksOpen?: number; tasksHistory?: number;
    staffNew?: number; staffRoles?: { position: string; role: string | null; count: number }[]; notTransferred: string[] };
  issues: Issue[]; applied?: Applied };
type BatchFull = Batch & { report: Report | null; files: IFile[]; statusCounts: Record<string, number> };
type IRow = { id: string; rowNo: number; cells: string[]; status: string; issue: string | null; conflictWith: string | null; resolution: string | null; fileName: string; headers: string[] };

const ORDER = ['clients', 'memberships', 'payments', 'visits', 'balances', 'tasks', 'staff'];
const OPTIONAL = ['tasks', 'staff'];
const ROLE_NAMES: Record<string, string> = { gm: 'Управляющий', rop: 'Руководитель ОП', manager: 'Менеджер ОП', desk: 'Администратор ресепшн', trainer: 'Тренер', fin: 'Финансист' };
type Credential = { fullName: string; login: string; tempPassword: string; role: string; position: string };
const STATUS: Record<string, [string, string]> = {
  draft: ['Подготовка', 'acc'], checked: ['Проверен', 'acc'], applied: ['Перенесён, ждёт принятия', 'warn'], accepted: ['Принят', 'ok'], rolled_back: ['Отменён', 'bad'],
};
const ISSUE_STATUS: Record<string, [string, string]> = { conflict: ['Конфликт', 'bad'], excluded: ['Не переносится', 'bad'], warning: ['С замечанием', 'warn'], skipped: ['Пропущено', ''] };
const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
const pct = (x: number) => `${Math.round(x * 100)} %`;

export function ImportPage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [list, setList] = useState<Batch[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<Batch[]>('GET', `/api/import/batches?clubId=${club}`).then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => { setOpen(null); if (club) load(); }, [club]);
  useEffect(() => { api<TypeDef[]>('GET', '/api/import/fields').then(setTypes).catch(() => {}); }, []);
  const create = async () => {
    try { const b = await api<Batch>('POST', '/api/import/batches', { clubId: club }); await load(); setOpen(b.id); } catch (e) { setErr(errText(e)); }
  };
  if (!clubs.length) return <p className="muted">Клубов нет.</p>;
  if (open) return <BatchView id={open} types={types} back={() => { setOpen(null); load(); }} />;
  return (
    <>
      <div className="row between">
        <h1>Перенос из 1С</h1>
        <div className="row">
          {clubId === 'all' && <select aria-label="Клуб" value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          <button className="btn pri" onClick={create}>Начать перенос</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="note">
        Нужны пять отчётов из 1С по клубу: <b>клиенты</b>, <b>абонементы и договоры</b>, <b>платежи</b>, <b>посещения</b>, <b>остатки и долги</b>, в Excel (.xlsx) или CSV. Шестой — <b>задачи и звонки</b> — по желанию: открытые задачи перейдут в работу, выполненные — в историю клиента. Седьмой — <b>сотрудники</b> — по желанию: каждому создаётся вход в систему с ролью по должности. Пропущенное (сотрудников, недостающих клиентов) можно догрузить позже отдельным переносом.
        Система сама узнаёт отчёт и колонки, вы проверяете карту полей. Пробный перенос ничего не меняет в базе и показывает отчёт сверки.
        Перенос можно отменить, пока вы его не приняли. Повторная загрузка тех же данных не создаёт дублей.
      </div>
      <div className="card tbl">
        {!list.length ? <p className="muted">Переносов по этому клубу ещё не было.</p> : (
          <table>
            <thead><tr><th>Начат</th><th>Кто</th><th>Состояние</th><th>Перенесено</th><th /></tr></thead>
            <tbody>{list.map((b) => (
              <tr key={b.id}>
                <td>{dt(b.createdAt)}</td><td>{b.createdByName ?? '—'}</td>
                <td><span className={`chip ${STATUS[b.status]?.[1] ?? ''}`}>{STATUS[b.status]?.[0] ?? b.status}</span></td>
                <td className="small">{b.applied ? `клиентов ${b.applied.persons}, абонементов ${b.applied.memberships}, платежей ${b.applied.payments}, посещений ${b.applied.visits}` : '—'}</td>
                <td className="r"><button className="btn sm" onClick={() => setOpen(b.id)}>Открыть</button></td>
              </tr>))}
            </tbody>
          </table>)}
      </div>
      {can(me, '*') && club && <DemoCleanup clubId={club} clubName={clubs.find((x) => x.id === club)?.name ?? ''} />}
    </>
  );
}

// Названия таблиц для предпросмотра удаления демо-данных; остальные показываются как есть
const TABLE_NAMES: Record<string, string> = {
  persons: 'Клиенты', person_contacts: 'Телефоны и почта', memberships: 'Абонементы', membership_operations: 'Операции по абонементам', payments: 'Оплаты',
  visits: 'Посещения', charges: 'Начисления и долги', contracts: 'Договоры', tasks: 'Задачи', calls: 'Звонки', leads: 'Заявки', opportunities: 'Сделки',
  opportunity_stage_history: 'История сделок', class_bookings: 'Записи на занятия', messages: 'Сообщения', conversations: 'Переписки', access_credentials: 'Карты доступа',
  person_payment_methods: 'Привязанные карты', consents: 'Согласия', surveys: 'Опросы', survey_responses: 'Ответы на опросы', receipts: 'Чеки',
};

/** Удаление выдуманных клиентов клуба после переноса настоящей базы (решение Андрея 18.11.2026) */
function DemoCleanup({ clubId, clubName }: { clubId: string; clubName: string }) {
  const [pre, setPre] = useState<{ counts: Record<string, number>; imported: number } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setPre(null); setErr(''); setPassword(''); }, [clubId]);
  const preview = async () => {
    setBusy(true); setErr('');
    try { setPre(await api('POST', '/api/import/demo-cleanup/preview', { clubId })); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const run = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api<{ counts: Record<string, number> }>('POST', '/api/import/demo-cleanup', { clubId, password });
      toast(`Удалено демо-клиентов: ${r.counts.persons ?? 0}`); setPre(null); setPassword('');
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const rows = pre ? Object.entries(pre.counts).sort((a, b) => (a[0] === 'persons' ? -1 : b[0] === 'persons' ? 1 : b[1] - a[1])) : [];
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Демо-данные клуба</h2>
      <p className="small" style={{ margin: 0 }}>Удаляет из клуба «{clubName}» всех клиентов, которые не перенесены из 1С (тестовое наполнение и заведённые вручную), вместе с их абонементами, оплатами, посещениями, задачами, звонками и перепиской. Данные из 1С не затрагиваются: если удаление их заденет, оно не выполнится. Отменить удаление нельзя.</p>
      {err && <div className="err">{err}</div>}
      {!pre && <div className="row"><button className="btn" disabled={busy} onClick={preview}>{busy ? 'Считаю…' : 'Показать, что удалится'}</button></div>}
      {pre && (rows.length === 0 ? <p className="muted">Демо-клиентов в этом клубе нет.</p> : (
        <>
          <p style={{ margin: 0 }}>Клиентов из 1С останется: <b>{pre.imported}</b>. Будет удалено:</p>
          <div className="tbl"><table><tbody>{rows.map(([k, n]) => <tr key={k}><td>{TABLE_NAMES[k] ?? k}</td><td className="num">{n}</td></tr>)}</tbody></table></div>
          <form onSubmit={run} className="row">
            <label className="f">Ваш пароль для подтверждения<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button className="btn pri" disabled={!password || busy}>{busy ? 'Удаляю…' : 'Удалить демо-данные'}</button>
            <button type="button" className="btn" onClick={() => setPre(null)}>Отмена</button>
          </form>
        </>))}
    </div>);
}

function BatchView({ id, types, back }: { id: string; types: TypeDef[]; back: () => void }) {
  const [b, setB] = useState<BatchFull | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api<BatchFull>('GET', `/api/import/batches/${id}`).then(setB).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [id]);
  if (!b) return <p className="muted">{err || 'Загрузка…'}</p>;
  const editable = b.status === 'draft' || b.status === 'checked';
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr('');
    for (const f of Array.from(files)) {
      setBusy(`Загружаю «${f.name}»…`);
      try {
        const r = await api<{ reportType: string | null; fromTemplate: boolean; rowCount: number }>('POST', `/api/import/batches/${id}/files`, await readFile(f));
        toast(`«${f.name}»: ${r.reportType ? types.find((t) => t.type === r.reportType)?.name : 'тип не определён'}, строк ${r.rowCount}`);
      } catch (e) { setErr(errText(e)); }
    }
    setBusy(''); load();
  };
  const check = async () => {
    setBusy('Пробный перенос…'); setErr('');
    try { await api('POST', `/api/import/batches/${id}/check`); await load(); } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  };
  const step = b.status === 'accepted' ? 5 : b.status === 'applied' ? 4 : b.report ? 3 : b.files.length ? 2 : 1;
  return (
    <>
      <div className="row between">
        <div className="row"><button className="btn sm" onClick={back}>← Все переносы</button><h1>Перенос из 1С · {b.clubName}</h1></div>
        <span className={`chip ${STATUS[b.status]?.[1] ?? ''}`}>{STATUS[b.status]?.[0]}</span>
      </div>
      <div className="steps">{['Загрузка отчётов', 'Карта полей', 'Пробный перенос', 'Перенос', 'Принятие'].map((s, i) => <span key={s} className={i < step ? 'on' : ''}>{i + 1}. {s}</span>)}</div>
      {err && <div className="err">{err}</div>}
      {busy && <div className="note">{busy}</div>}

      {editable && (
        <div className="card row between">
          <div><h2>Файлы отчётов</h2><p className="small">Можно выбрать сразу несколько файлов. Старый формат .xls сохраните в Excel как .xlsx.</p></div>
          <label className="btn pri">Добавить файлы<input type="file" multiple accept=".xlsx,.csv,.txt" hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} /></label>
        </div>)}

      <div style={{ display: 'grid', gap: 12 }}>
        {ORDER.map((t) => {
          const def = types.find((x) => x.type === t);
          const fs = b.files.filter((f) => f.reportType === t);
          return (
            <div key={t} className="card" style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
              <div className="row between"><h2>{def?.name ?? t}</h2>{fs.length ? <span className="chip ok">загружен</span> : OPTIONAL.includes(t) ? <span className="chip">по желанию</span> : <span className="chip bad">нужен отчёт</span>}</div>
              {fs.map((f) => <FileCard key={f.id} f={f} types={types} editable={editable} reload={load} />)}
            </div>);
        })}
        {b.files.filter((f) => !f.reportType).map((f) => (
          <div key={f.id} className="card" style={{ display: 'grid', gap: 8 }}><h2>Не распознан</h2><FileCard f={f} types={types} editable={editable} reload={load} /></div>))}
      </div>

      {editable && <div className="row"><button className="btn pri" disabled={!!busy || !b.files.length} onClick={check}>Пробный перенос</button>
        <span className="small">Ничего не меняет в базе: проверяет каждую строку и строит отчёт сверки.</span></div>}

      {b.report && <ReportView r={b.report} />}
      {b.report && editable && <Conflicts batchId={id} reload={load} />}
      {b.report && <IssueRows batchId={id} />}
      <Actions b={b} reload={load} />
    </>
  );
}

function FileCard({ f, types, editable, reload }: { f: IFile; types: TypeDef[]; editable: boolean; reload: () => void }) {
  const [type, setType] = useState(f.reportType ?? '');
  const [map, setMap] = useState<Record<string, number | null>>({});
  const [openMap, setOpenMap] = useState(!f.mappingConfirmed && !!f.reportType);
  const [err, setErr] = useState('');
  useEffect(() => { setType(f.reportType ?? ''); setMap(Object.fromEntries(Object.entries(f.mapping ?? {}).map(([k, v]) => [k, v ? v.col : null]))); }, [f]);
  const def = types.find((t) => t.type === type);
  const changeType = async (t: string) => {
    setType(t); setErr('');
    try { await api('PUT', `/api/import/files/${f.id}`, { reportType: t }); reload(); setOpenMap(true); } catch (e) { setErr(errText(e)); }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('PUT', `/api/import/files/${f.id}`, { reportType: type, mapping: map }); toast('Карта полей подтверждена'); setOpenMap(false); reload(); } catch (x) { setErr(errText(x)); }
  };
  const remove = async () => { try { await api('DELETE', `/api/import/files/${f.id}`); reload(); } catch (e) { setErr(errText(e)); } };
  const fromTpl = f.detectedType === 'template';
  return (
    <div className="item" style={{ display: 'grid', gap: 6 }}>
      <div className="row between">
        <b>{f.fileName}</b>
        <span className="small">строк {f.rowCount}, заголовок в строке {f.headerRow}</span>
      </div>
      <div className="row">
        {fromTpl ? <span className="chip ok">карта из библиотеки, версия {f.mappingVersion}</span>
          : <span className={`chip ${f.confidence >= 0.8 ? 'ok' : f.confidence >= 0.5 ? 'warn' : 'bad'}`}>уверенность {pct(f.confidence)}</span>}
        {f.mappingConfirmed ? <span className="chip ok">карта подтверждена</span> : <span className="chip warn">проверьте карту полей</span>}
        {editable && <select aria-label="Какой это отчёт" value={type} onChange={(e) => changeType(e.target.value)} style={{ width: 'auto' }}>
          <option value="" disabled>Какой это отчёт?</option>{types.map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}</select>}
        {def && <button className="btn sm" onClick={() => setOpenMap(!openMap)}>{openMap ? 'Скрыть карту' : 'Карта полей'}</button>}
        {editable && <button className="btn sm" onClick={remove}>Убрать</button>}
      </div>
      {err && <div className="err">{err}</div>}
      {openMap && def && (
        <form onSubmit={save} style={{ display: 'grid', gap: 6 }}>
          <div className="tbl"><table>
            <thead><tr><th>Поле в системе</th><th>Колонка в файле</th><th>Пример</th></tr></thead>
            <tbody>{def.fields.map((fd) => {
              const col = map[fd.key];
              const conf = f.mapping?.[fd.key]?.confidence;
              return (
                <tr key={fd.key}>
                  <td>{fd.label}{fd.required && <b className="small bad"> *</b>}</td>
                  <td><select className="f" disabled={!editable} value={col ?? ''} onChange={(e) => setMap({ ...map, [fd.key]: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">— нет в отчёте —</option>{f.headers.map((h, i) => <option key={i} value={i}>{h || `(колонка ${i + 1})`}</option>)}</select>
                    {col !== null && col !== undefined && conf !== undefined && conf < 1 && !f.mappingConfirmed && <span className="small"> найдено по названию, {pct(conf)}</span>}</td>
                  <td className="small">{col !== null && col !== undefined ? f.sample.slice(0, 3).map((r) => r[col]).filter(Boolean).join(' · ') || '—' : ''}</td>
                </tr>);
            })}</tbody>
          </table></div>
          {editable && <div className="row"><button className="btn pri sm">Карта верна</button><span className="small">* обязательные поля</span></div>}
        </form>)}
    </div>
  );
}

function ReportView({ r }: { r: Report }) {
  const m = r.money;
  const rowsSum = m.totals.inSourceKop - m.totals.outSourceKop;
  return (
    <>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <div className="row between">
          <h2>{r.mode === 'applied' ? 'Отчёт сверки переноса' : 'Отчёт сверки (пробный перенос)'}</h2>
          <span className="small">сформирован {dt(r.generatedAt)}</span>
        </div>
        {r.blockers.length > 0 && <div className="err"><b>Перенос пока невозможен:</b><ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{r.blockers.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        {r.blockers.length === 0 && r.mode === 'check' && <div className="note ok-msg">Всё готово к переносу. Проверьте цифры ниже.</div>}
        <div className="tbl"><table>
          <thead><tr><th>Отчёт</th><th className="r">Записей в 1С</th><th className="r">{r.mode === 'applied' ? 'Перенесено' : 'Перенесётся'}</th><th className="r">из них с замечанием</th>
            <th className="r">Не переносится</th><th className="r">Конфликты</th><th className="r">Повторы и пропуски</th><th className="r">Перенесено раньше</th></tr></thead>
          <tbody>{ORDER.filter((t) => r.counts[t] && (!OPTIONAL.includes(t) || r.counts[t].files)).map((t) => { const c = r.counts[t]; return (
            <tr key={t}><td>{c.name}</td><td className="r num">{c.source}</td><td className="r num"><b>{c.load}</b></td><td className="r num">{c.warning || ''}</td>
              <td className={`r num ${c.excluded ? 'bad' : ''}`}>{c.excluded || ''}</td><td className={`r num ${c.conflict ? 'bad' : ''}`}>{c.conflict || ''}</td>
              <td className="r num">{c.skipped - c.earlier || ''}</td><td className="r num">{c.earlier || ''}</td></tr>); })}</tbody>
        </table></div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <h2>Деньги: сверка с 1С без округлений</h2>
        {m.paymentsFooterKop !== null && (
          <div className={`note ${m.paymentsFooterKop === rowsSum ? 'ok-msg' : ''}`}>
            Итог отчёта платежей в 1С: <b className="num">{rub(m.paymentsFooterKop)}</b>, сумма строк: <b className="num">{rub(rowsSum)}</b>
            {m.paymentsFooterKop === rowsSum ? ' — совпадает.' : ` — расхождение ${rub(rowsSum - m.paymentsFooterKop)}.`}
          </div>)}
        <div className="tbl"><table>
          <thead><tr><th>Месяц</th><th className="r">Оплаты в 1С</th><th className="r">Переносится</th><th className="r">Возвраты в 1С</th><th className="r">Переносится</th><th className="r">Не переносится</th></tr></thead>
          <tbody>
            {m.months.map((x) => { const miss = x.inSourceKop - x.inLoadKop + (x.outSourceKop - x.outLoadKop); return (
              <tr key={x.month}><td>{monthName(x.month)}</td><td className="r num">{rub(x.inSourceKop)}</td><td className="r num">{rub(x.inLoadKop)}</td>
                <td className="r num">{x.outSourceKop ? rub(x.outSourceKop) : ''}</td><td className="r num">{x.outLoadKop ? rub(x.outLoadKop) : ''}</td>
                <td className={`r num ${miss ? 'bad' : ''}`}>{miss ? rub(miss) : ''}</td></tr>); })}
            <tr><td><b>Итого</b></td><td className="r num"><b>{rub(m.totals.inSourceKop)}</b></td><td className="r num"><b>{rub(m.totals.inLoadKop)}</b></td>
              <td className="r num"><b>{rub(m.totals.outSourceKop)}</b></td><td className="r num"><b>{rub(m.totals.outLoadKop)}</b></td>
              <td className="r num bad"><b>{m.totals.inSourceKop - m.totals.inLoadKop + m.totals.outSourceKop - m.totals.outLoadKop ? rub(m.totals.inSourceKop - m.totals.inLoadKop + m.totals.outSourceKop - m.totals.outLoadKop) : ''}</b></td></tr>
          </tbody>
        </table></div>
        <div className="kv">
          <span>Долги клиентов в 1С</span><span className="num">{rub(m.debts.sourceKop)}, переносится {rub(m.debts.loadKop)}</span>
          <span>Авансы клиентов в 1С</span><span className="num">{rub(m.advances.sourceKop)} у {m.advances.count} клиентов (показаны здесь, лицевого счёта пока нет)</span>
          <span>Стоимость абонементов</span><span className="num">{rub(m.memberships.loadKop)}</span>
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Полнота данных</h2>
        <div className="kv">
          <span>Клиентов без телефона</span><span className="num">{r.completeness.clientsWithoutPhone}</span>
          <span>Без даты рождения</span><span className="num">{r.completeness.clientsWithoutBirthDate}</span>
          <span>Без эл. почты</span><span className="num">{r.completeness.clientsWithoutEmail}</span>
          <span>Действующих абонементов</span><span className="num">{r.completeness.membershipsActive}</span>
          <span>Абонементов без номера договора</span><span className="num">{r.completeness.membershipsWithoutContract}</span>
          <span>Платежей без привязки к абонементу</span><span className="num">{r.completeness.paymentsWithoutMembership}</span>
          {r.completeness.tasksOpen !== undefined && (r.counts.tasks?.files ?? 0) > 0 && <>
            <span>Открытых задач и звонков</span><span className="num">{r.completeness.tasksOpen}</span>
            <span>Выполненных задач (история в карточке)</span><span className="num">{r.completeness.tasksHistory}</span></>}
          {(r.counts.staff?.files ?? 0) > 0 && <><span>Новых сотрудников</span><span className="num">{r.completeness.staffNew ?? 0}</span></>}
        </div>
        {(r.counts.staff?.files ?? 0) > 0 && !!r.completeness.staffRoles?.length && (
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>Роли по должностям из 1С</h3>
            <p className="small" style={{ margin: 0 }}>Проверьте, какую роль получит каждая должность. Чтобы поменять роль, впишите её в колонку «Роль» в файле и загрузите файл заново, или поправьте роль после переноса в «Персонале».</p>
            <div className="tbl"><table>
              <thead><tr><th>Должность в 1С</th><th>Роль в системе</th><th className="num">Человек</th></tr></thead>
              <tbody>{r.completeness.staffRoles.map((x) => <tr key={x.position}><td>{x.position}</td>
                <td>{x.role ? ROLE_NAMES[x.role] ?? x.role : <span className="chip bad">не определена, не переносится</span>}</td><td className="num">{x.count}</td></tr>)}</tbody>
            </table></div>
          </div>)}
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.completeness.notTransferred.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>
    </>
  );
}

function Conflicts({ batchId, reload }: { batchId: string; reload: () => void }) {
  const [rows, setRows] = useState<IRow[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<IRow[]>('GET', `/api/import/batches/${batchId}/rows?status=conflict&limit=1000`).then(setRows).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [batchId]);
  if (!rows.length) return null;
  const resolve = async (id: string, resolution: string) => {
    try { await api('POST', `/api/import/rows/${id}/resolve`, { resolution }); await load(); reload(); } catch (e) { setErr(errText(e)); }
  };
  const LBL: Record<string, string> = { merge: 'объединить', new: 'отдельный клиент', skip: 'не переносить' };
  const open = rows.filter((r) => !r.resolution).length;
  const resolveAll = async (resolution: 'new' | 'skip') => {
    const what = resolution === 'new' ? 'создать отдельными клиентами' : 'не переносить';
    if (!window.confirm(`Все нерешённые конфликты (${open}) — ${what}? Решение по отдельной строке потом можно поменять.`)) return;
    try { await api('POST', `/api/import/batches/${batchId}/resolve-conflicts`, { resolution }); await load(); reload(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Конфликты: решите по каждой строке</h2>
      <p className="small">Исходная строка не удаляется: решение сохраняется вместе с ней. После решений запустите пробный перенос ещё раз.</p>
      {err && <div className="err">{err}</div>}
      {open > 1 && (
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="small">Не решено: {open}. Чаще всего это члены одной семьи с общим телефоном.</span>
          <button className="btn sm pri" onClick={() => resolveAll('new')}>Всех создать отдельными клиентами</button>
          <button className="btn sm" onClick={() => resolveAll('skip')}>Всех не переносить</button>
        </div>)}
      {rows.map((r) => (
        <div key={r.id} className="item" style={{ display: 'grid', gap: 6 }}>
          <div className="small">{r.fileName}, строка {r.rowNo}</div>
          <div>{r.cells.filter(Boolean).slice(0, 5).join(' · ')}</div>
          <div className="small bad">{r.conflictWith}</div>
          <div className="row">
            {(['merge', 'new', 'skip'] as const).map((k) => (
              <button key={k} className={`btn sm ${r.resolution === k ? 'pri' : ''}`} onClick={() => resolve(r.id, k)}>
                {k === 'merge' ? 'Это один человек: объединить' : k === 'new' ? 'Разные люди: создать отдельно' : 'Не переносить'}</button>))}
            {r.resolution && <span className="chip ok">решено: {LBL[r.resolution]}</span>}
          </div>
        </div>))}
    </div>
  );
}

function IssueRows({ batchId }: { batchId: string }) {
  const [status, setStatus] = useState('excluded');
  const [rows, setRows] = useState<IRow[] | null>(null);
  useEffect(() => { setRows(null); }, [batchId]);
  const show = (s: string) => { setStatus(s); api<IRow[]>('GET', `/api/import/batches/${batchId}/rows?status=${s}&limit=300`).then(setRows).catch(() => setRows([])); };
  return (
    <details className="card">
      <summary><b>Строки, которые не переносятся или с замечаниями</b></summary>
      <div className="tabs" style={{ margin: '8px 0' }}>
        {Object.entries(ISSUE_STATUS).filter(([k]) => k !== 'conflict').map(([k, [t]]) => <button key={k} aria-pressed={rows !== null && status === k} onClick={() => show(k)}>{t}</button>)}
      </div>
      {rows && (rows.length ? (
        <div className="tbl"><table>
          <thead><tr><th>Файл</th><th>Строка</th><th>Данные</th><th>Причина</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td className="small">{r.fileName}</td><td className="num">{r.rowNo}</td>
            <td className="small">{r.cells.filter(Boolean).slice(0, 6).join(' · ')}</td><td>{r.issue}</td></tr>)}</tbody>
        </table></div>) : <p className="muted">Таких строк нет.</p>)}
    </details>
  );
}

function Actions({ b, reload }: { b: BatchFull; reload: () => void }) {
  const [act, setAct] = useState<'apply' | 'accept' | 'rollback' | null>(null);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<Credential[]>([]);
  const run = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const res = await api<{ staffCredentials?: Credential[] }>('POST', `/api/import/batches/${b.id}/${act}`, { password });
      if (act === 'apply' && res.staffCredentials?.length) setCreds(res.staffCredentials);
      toast(act === 'apply' ? 'Данные перенесены' : act === 'accept' ? 'Перенос принят' : 'Перенос отменён');
      setAct(null); setPassword(''); reload();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const applied = b.report?.applied;
  const TEXT = {
    apply: 'Перенести данные в систему. Клиенты, абонементы, договоры, платежи, посещения, долги и задачи появятся в рабочих разделах. До принятия перенос можно отменить целиком.',
    accept: 'Принять перенос: после этого отменить его будет нельзя. Принимайте после выборочной проверки карточек знакомых клиентов.',
    rollback: 'Отменить перенос: всё, что он создал, будет удалено. Исходные файлы и решения по конфликтам останутся в истории.',
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      {applied && (
        <div className="kv">
          <span>Новых клиентов</span><span className="num">{applied.persons}{applied.merged ? `, объединено с существующими ${applied.merged}` : ''}</span>
          <span>Абонементов</span><span className="num">{applied.memberships}, договоров {applied.contracts}</span>
          <span>Платежей</span><span className="num">{applied.payments}</span>
          <span>Посещений</span><span className="num">{applied.visits}</span>
          <span>Долгов</span><span className="num">{applied.debts}</span>
          {applied.tasks !== undefined && (applied.tasks || applied.taskHistory) ? <><span>Задач и звонков</span><span className="num">{applied.tasks} открытых, {applied.taskHistory} в истории</span></> : null}
          {applied.staff ? <><span>Сотрудников</span><span className="num">{applied.staff}</span></> : null}
          <span>Тарифов из 1С</span><span className="num">{applied.products} (в прайс не попадают)</span>
        </div>)}
      {creds.length > 0 && <StaffCredentials list={creds} />}
      <div className="row">
        {b.status === 'checked' && <button className="btn pri" disabled={!b.report?.canApply} onClick={() => setAct('apply')}>Перенести в систему</button>}
        {b.status === 'draft' && b.report && <span className="small">Есть изменения после проверки: запустите пробный перенос.</span>}
        {b.status === 'applied' && <><button className="btn pri" onClick={() => setAct('accept')}>Принять перенос</button>
          <button className="btn" onClick={() => setAct('rollback')}>Отменить перенос</button></>}
        {b.status === 'accepted' && <span className="chip ok">Принят {dt(b.acceptedAt)}</span>}
        {b.status === 'rolled_back' && <span className="chip bad">Отменён {dt(b.rolledBackAt)}</span>}
      </div>
      {act && (
        <form onSubmit={run} className="item" style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0 }}>{TEXT[act]}</p>
          <label className="f">Ваш пароль для подтверждения<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {err && <div className="err">{err}</div>}
          <div className="row"><button className="btn pri" disabled={!password || busy}>{busy ? 'Выполняю…' : 'Подтвердить'}</button><button type="button" className="btn" onClick={() => setAct(null)}>Отмена</button></div>
        </form>)}
    </div>
  );
}

/** Логины и временные пароли новых сотрудников: показываются один раз, сразу после переноса */
function StaffCredentials({ list }: { list: Credential[] }) {
  const text = list.map((c) => `${c.fullName}\t${ROLE_NAMES[c.role] ?? c.role}\tлогин: ${c.login}\tвременный пароль: ${c.tempPassword}`).join('\n');
  const copy = () => navigator.clipboard.writeText(`Вход: ${location.origin}\n${text}`).then(() => toast('Скопировано')).catch(() => toast('Не удалось скопировать: выделите таблицу вручную'));
  return (
    <div className="item" style={{ display: 'grid', gap: 8 }}>
      <b>Учётные записи сотрудников: {list.length}</b>
      <p className="small" style={{ margin: 0 }}>Сохраните или раздайте эти данные сейчас: временные пароли показываются только один раз. При первом входе каждый задаст свой пароль. Потерянный пароль можно сбросить в «Персонале».</p>
      <div className="tbl"><table>
        <thead><tr><th>Сотрудник</th><th>Роль</th><th>Логин</th><th>Временный пароль</th></tr></thead>
        <tbody>{list.map((c) => <tr key={c.login}><td>{c.fullName}<div className="small muted">{c.position}</div></td><td>{ROLE_NAMES[c.role] ?? c.role}</td><td><code>{c.login}</code></td><td><code>{c.tempPassword}</code></td></tr>)}</tbody>
      </table></div>
      <div className="row"><button type="button" className="btn" onClick={copy}>Скопировать всё</button><button type="button" className="btn" onClick={() => window.print()}>Распечатать</button></div>
    </div>);
}
