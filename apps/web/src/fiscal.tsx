// Шаг 8. Раздел «Касса»: выбор кассы клуба (облачная или в клубе), банк эквайринга, инструкции, журнал чеков.
// LocalKktAgent работает в браузере компьютера ресепшн и отправляет чеки на кассу АТОЛ через «Веб-сервер ККТ».
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';
import cloudMd from '../../../docs/03_Инструкции/Касса_облачная_АТОЛ_Онлайн.md?raw';
import localMd from '../../../docs/03_Инструкции/Касса_в_клубе_АТОЛ.md?raw';

type Fiscal = { mode: 'none' | 'cloud' | 'local'; provider: string | null; taxation: string; vat: string; paymentMethod: string; inn: string | null; companyEmail: string | null;
  paymentAddress: string | null; apiUrl: string | null; groupCode: string | null; login: string | null; hasPassword: boolean; localUrl: string; acquiringProvider: string };
type Receipt = { id: string; status: string; mode: string; provider: string; amountKop: number; fiscal: Record<string, unknown> | null; error: string | null; attempts: number;
  createdAt: string; personName: string | null; title: string | null; paidMethod: string | null };
type Job = { id: string; clubId: string; status: string; externalId: string | null; payload: Record<string, unknown>; localUrl: string };

const TAX: Record<string, string> = { osn: 'ОСН (общая)', usn_income: 'УСН «Доходы»', usn_income_outcome: 'УСН «Доходы минус расходы»', esn: 'ЕСХН', patent: 'Патент' };
const VAT: Record<string, string> = { none: 'Без НДС', vat0: 'НДС 0 %', vat5: 'НДС 5 %', vat7: 'НДС 7 %', vat10: 'НДС 10 %', vat20: 'НДС 20 %', vat22: 'НДС 22 %' };
const METHOD: Record<string, string> = { full_prepayment: 'Полная предоплата', full_payment: 'Полный расчёт', advance: 'Аванс' };
const BANKS: Record<string, string> = { none: 'Пока не выбран', sber: 'Сбер', tbank: 'Т-Банк', yookassa: 'ЮKassa', other: 'Другой банк' };
const STATUS: Record<string, [string, string]> = { pending: ['ждёт отправки', 'warn'], sent: ['отправлен в кассу', 'acc'], done: ['пробит', 'ok'], failed: ['ошибка', 'bad'] };
const PAY: Record<string, string> = { cash: 'наличные', card_terminal: 'карта', sbp: 'СБП' };

/* Небольшой показ инструкции из Markdown: заголовки, списки, таблицы, абзацы, `код` и **жирный**. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((p, i) => p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>);
}
export function Md({ text }: { text: string }) {
  const out: ReactNode[] = []; const lines = text.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('#')) { const n = l.match(/^#+/)![0].length; const T = (n === 1 ? 'h2' : 'h3') as 'h2'; out.push(<T key={i} style={{ margin: '10px 0 4px' }}>{inline(l.replace(/^#+\s*/, ''))}</T>); i++; continue; }
    if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) { if (!/^\|[-|\s]+\|$/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim())); i++; }
      out.push(<div key={i} className="tbl"><table><thead><tr>{rows[0].map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^(\d+\.|-)\s/.test(l)) {
      const ordered = /^\d+\./.test(l); const items: string[] = [];
      while (i < lines.length && /^(\d+\.|-)\s/.test(lines[i])) { items.push(lines[i].replace(/^(\d+\.|-)\s/, '')); i++; }
      const L = (ordered ? 'ol' : 'ul') as 'ol';
      out.push(<L key={i} style={{ margin: '4px 0', paddingLeft: 22 }}>{items.map((x, k) => <li key={k} style={{ margin: '3px 0' }}>{inline(x)}</li>)}</L>);
      continue;
    }
    out.push(<p key={i} style={{ margin: '6px 0' }}>{inline(l)}</p>); i++;
  }
  return <div className="md">{out}</div>;
}

export function FiscalPage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const c = clubs.find((x) => x.id === club);
  if (!c) return <p className="muted">Клубов нет.</p>;
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 700 }}>Касса и банк выбираются для каждого клуба отдельно. После каждой оплаты система создаёт чек и отправляет его в кассу клуба.</p>
        {clubId === 'all' && <select aria-label="Клуб" value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      </div>
      <FiscalForm key={`f${club}`} club={c} manage={can(me, 'fiscal.manage')} />
      <Receipts key={`r${club}`} me={me} club={c} />
    </>
  );
}

function FiscalForm({ club, manage }: { club: Club; manage: boolean }) {
  const [s, setS] = useState<Fiscal | null>(null);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api<Fiscal>('GET', `/api/clubs/${club.id}/fiscal`).then(setS).catch((x) => setErr(errText(x))); }, [club.id]);
  if (!s) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const set = <K extends keyof Fiscal>(k: K, v: Fiscal[K]) => setS({ ...s, [k]: v });
  const ro = !manage;
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setMsg('');
    try { setS(await api<Fiscal>('PUT', `/api/clubs/${club.id}/fiscal`, { ...s, password: pass || undefined })); setPass(''); toast(`Касса «${club.name}» сохранена`); } catch (x) { setErr(errText(x)); }
  };
  const testCloud = async () => {
    setErr(''); setMsg('');
    try { setMsg((await api<{ message: string }>('POST', `/api/clubs/${club.id}/fiscal/test`)).message); } catch (x) { setErr(errText(x)); }
  };
  const testLocal = async () => {
    setErr(''); setMsg('');
    try { const r = await localCall(s.localUrl, { type: 'getDeviceStatus' }); setMsg(`Касса на связи${r ? `: ${r}` : ''}`); } catch (x) { setErr(`Нет связи с кассой: ${(x as Error).message}. Проверьте, что «Веб-сервер ККТ» запущен на этом компьютере`); }
  };
  const mode = (m: Fiscal['mode'], title: string, text: string) => (
    <button type="button" className="item modecard" aria-pressed={s.mode === m} disabled={ro} onClick={() => set('mode', m)}><b>{title}</b><span className="small">{text}</span></button>);
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 12 }}>
      <h2>Касса клуба</h2>
      {err && <div className="err">{err}</div>}
      {msg && <div className="item ok-msg">{msg}</div>}
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
        {mode('none', 'Без кассы', 'Чеки не создаются. Только для проверки системы')}
        {mode('cloud', 'Облачная касса', 'АТОЛ Онлайн: касса в облаке, клиент получает электронный чек')}
        {mode('local', 'Касса в клубе', 'Касса подключена к компьютеру ресепшн: АТОЛ автоматически или любая касса вручную')}
      </div>
      {s.mode !== 'none' && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <label className="f">ИНН организации<input value={s.inn ?? ''} disabled={ro} onChange={(e) => set('inn', e.target.value)} /></label>
          <label className="f">Система налогообложения<select value={s.taxation} disabled={ro} onChange={(e) => set('taxation', e.target.value)}>{Object.entries(TAX).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f">Ставка НДС<select value={s.vat} disabled={ro} onChange={(e) => set('vat', e.target.value)}>{Object.entries(VAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f">Признак расчёта<select value={s.paymentMethod} disabled={ro} onChange={(e) => set('paymentMethod', e.target.value)}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>)}
      {s.mode === 'cloud' && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <label className="f">Адрес сервиса<input value={s.apiUrl ?? ''} disabled={ro} onChange={(e) => set('apiUrl', e.target.value)} /></label>
          <label className="f">Код группы<input value={s.groupCode ?? ''} disabled={ro} onChange={(e) => set('groupCode', e.target.value)} /></label>
          <label className="f">Логин интеграции<input value={s.login ?? ''} disabled={ro} autoComplete="off" onChange={(e) => set('login', e.target.value)} /></label>
          <label className="f">Пароль интеграции<input type="password" value={pass} disabled={ro} autoComplete="new-password" placeholder={s.hasPassword ? 'сохранён, введите, чтобы заменить' : ''} onChange={(e) => setPass(e.target.value)} /></label>
          <label className="f">E-mail организации (в чеке)<input value={s.companyEmail ?? ''} disabled={ro} onChange={(e) => set('companyEmail', e.target.value)} /></label>
          <label className="f">Адрес расчётов (сайт или адрес)<input value={s.paymentAddress ?? ''} disabled={ro} onChange={(e) => set('paymentAddress', e.target.value)} /></label>
        </div>)}
      {s.mode === 'local' && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <label className="f">Как пробивать чек<select value={s.provider ?? 'atol_local'} disabled={ro} onChange={(e) => set('provider', e.target.value)}>
            <option value="atol_local">Касса АТОЛ, автоматически</option><option value="manual">Любая касса, вручную (вписать номер ФД)</option></select></label>
          {s.provider !== 'manual' && <label className="f">Адрес веб-сервера кассы на компьютере ресепшн<input value={s.localUrl} disabled={ro} onChange={(e) => set('localUrl', e.target.value)} /></label>}
        </div>)}
      <div className="item" style={{ display: 'grid', gap: 6 }}>
        <b>Банк для оплаты картой и СБП</b>
        <label className="f" style={{ maxWidth: 320 }}><select value={s.acquiringProvider} disabled={ro} onChange={(e) => set('acquiringProvider', e.target.value)}>
          {Object.entries(BANKS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <span className="small">Банк подключим к запуску. До этого оплату картой принимают на терминале банка в клубе и отмечают в карточке клиента.</span>
      </div>
      <div className="row">
        {manage && <button className="btn pri">Сохранить</button>}
        {s.mode === 'cloud' && manage && <button type="button" className="btn" onClick={testCloud}>Проверить связь</button>}
        {s.mode === 'local' && s.provider !== 'manual' && <button type="button" className="btn" onClick={testLocal}>Проверить кассу (с этого компьютера)</button>}
      </div>
      {s.mode === 'cloud' && <details className="item"><summary><b>Инструкция: как подключить облачную кассу</b></summary><Md text={cloudMd} /></details>}
      {s.mode === 'local' && <details className="item"><summary><b>Инструкция: как подключить кассу в клубе</b></summary><Md text={localMd} /></details>}
    </form>
  );
}

function Receipts({ me, club }: { me: Me; club: Club }) {
  const [list, setList] = useState<Receipt[]>([]);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState<{ id: string; fd: string } | null>(null);
  const reload = () => api<Receipt[]>('GET', `/api/receipts?clubId=${club.id}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [club.id]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); toast(ok); setManual(null); reload(); } catch (x) { setErr(errText(x)); } };
  const work = can(me, 'memberships.manage');
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Журнал чеков</h2>
      {err && <div className="err">{err}</div>}
      <div className="tbl"><table>
        <thead><tr><th>Когда</th><th>Клиент</th><th>За что</th><th>Сумма</th><th>Статус</th><th>Фискальные данные</th>{work && <th />}</tr></thead>
        <tbody>{list.map((r) => { const [label, cls] = r.provider === 'manual' && r.status === 'pending' ? ['пробить на кассе', 'warn'] : STATUS[r.status] ?? [r.status, '']; return (
          <tr key={r.id}>
            <td>{dt(r.createdAt)}</td><td>{r.personName}</td><td>{r.title}{r.paidMethod ? <span className="small">, {PAY[r.paidMethod] ?? r.paidMethod}</span> : null}</td>
            <td className="num">{rub(r.amountKop)}</td>
            <td><span className={`chip ${cls}`}>{label}</span>{r.error && <div className="small bad">{r.error}</div>}</td>
            <td className="small">{r.fiscal ? <>ФД {String(r.fiscal.fiscalDocumentNumber ?? '—')}{r.fiscal.fnNumber ? `, ФН ${r.fiscal.fnNumber}` : ''}{r.fiscal.manual ? ' (вручную)' : ''}
              {r.fiscal.ofdUrl ? <> · <a href={String(r.fiscal.ofdUrl)} target="_blank" rel="noreferrer">чек</a></> : null}</> : '—'}</td>
            {work && <td className="row">
              {r.status === 'failed' && <button className="btn sm" onClick={() => act(() => api('POST', `/api/receipts/${r.id}/retry`), 'Чек отправлен повторно')}>Повторить</button>}
              {r.status !== 'done' && (manual?.id === r.id
                ? <span className="row"><input value={manual.fd} onChange={(e) => setManual({ ...manual, fd: e.target.value })} placeholder="№ ФД" style={{ width: 90 }} aria-label="Номер ФД" />
                    <button className="btn sm pri" onClick={() => act(() => api('POST', `/api/receipts/${r.id}/manual`, { fiscalDocumentNumber: manual.fd }), 'Чек отмечен пробитым')}>OK</button></span>
                : <button className="btn sm" onClick={() => setManual({ id: r.id, fd: '' })}>Отметить пробитым</button>)}
            </td>}
          </tr>); })}</tbody>
      </table></div>
      {list.length === 0 && <p className="muted" style={{ margin: 0 }}>Чеков пока нет. Они появятся после первой оплаты, когда касса подключена.</p>}
    </div>
  );
}

/* ---------- касса в клубе: связь с «Веб-сервером ККТ» АТОЛ ---------- */
async function localCall(base: string, task: Record<string, unknown>) {
  const uuid = crypto.randomUUID();
  const url = base.replace(/\/$/, '');
  const r = await fetch(`${url}/api/v2/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid, request: [task] }), signal: AbortSignal.timeout(8000) });
  if (r.status >= 300) throw new Error(`веб-сервер ответил ${r.status}`);
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 700));
    const res = await (await fetch(`${url}/api/v2/requests/${uuid}`, { signal: AbortSignal.timeout(8000) })).json();
    const x = res.results?.[0];
    if (x?.status === 'ready') return x.result?.deviceStatus?.model ?? x.result?.deviceInfo?.modelName ?? '';
    if (x?.status === 'error') throw new Error(x.errorDescription ?? 'касса вернула ошибку');
  }
  throw new Error('касса не ответила');
}

/** Работает в браузере ресепшн: забирает чеки из очереди, отправляет на кассу, возвращает фискальные данные. */
export function LocalKktAgent({ me, clubId }: { me: Me; clubId: string }) {
  const [state, setState] = useState<{ queue: number; error: string | null; active: boolean }>({ queue: 0, error: null, active: false });
  const busy = useRef(false);
  useEffect(() => {
    if (!can(me, 'memberships.manage') || clubId === 'all') return;
    let stop = false;
    const tick = async () => {
      if (busy.current || stop) return; busy.current = true;
      try {
        const jobs = await api<Job[]>('GET', `/api/receipts/local-queue?clubId=${clubId}`);
        if (!jobs.length) { setState({ queue: 0, error: null, active: true }); return; }
        let error: string | null = null;
        for (const j of jobs) {
          const base = j.localUrl.replace(/\/$/, '');
          try {
            let ext = j.externalId;
            if (j.status === 'pending') {
              ext = j.id;
              const r = await fetch(`${base}/api/v2/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: ext, request: [j.payload] }), signal: AbortSignal.timeout(8000) });
              if (r.status >= 300 && r.status !== 409) throw new Error(`веб-сервер ответил ${r.status}`);
              await api('POST', `/api/receipts/${j.id}/local-sent`, { externalId: ext });
            }
            const res = await (await fetch(`${base}/api/v2/requests/${ext}`, { signal: AbortSignal.timeout(8000) })).json();
            const x = res.results?.[0];
            if (x?.status === 'ready') {
              const f = x.result?.fiscalParams ?? {};
              await api('POST', `/api/receipts/${j.id}/local-result`, { ok: true, fiscal: { fiscalDocumentNumber: f.fiscalDocumentNumber, fiscalSign: f.fiscalDocumentSign, fnNumber: f.fnNumber,
                receiptNumber: f.fiscalReceiptNumber, shiftNumber: f.shiftNumber, receiptDatetime: f.fiscalDocumentDateTime, ofdUrl: f.fnsUrl ?? null } });
            } else if (x?.status === 'error') {
              await api('POST', `/api/receipts/${j.id}/local-result`, { ok: false, error: x.errorDescription ?? 'Касса вернула ошибку' });
            }
          } catch (e) { error = (e as Error).message; break; }
        }
        setState({ queue: jobs.length, error, active: true });
      } catch { /* нет связи с сервером системы: попробуем позже */ } finally { busy.current = false; }
    };
    // Агент нужен только если в клубе касса АТОЛ в клубе
    api<Fiscal>('GET', `/api/clubs/${clubId}/fiscal`).then((s) => {
      if (s.mode !== 'local' || s.provider === 'manual') return setState({ queue: 0, error: null, active: false });
      tick();
    }).catch(() => {});
    const t = setInterval(async () => { const s = await api<Fiscal>('GET', `/api/clubs/${clubId}/fiscal`).catch(() => null); if (s?.mode === 'local' && s.provider !== 'manual') tick(); }, 6000);
    return () => { stop = true; clearInterval(t); };
  }, [clubId]);
  if (!state.active) return null;
  return <span className={`chip ${state.error ? 'bad' : state.queue ? 'warn' : 'ok'}`} title={state.error ?? ''}>
    Касса: {state.error ? 'нет связи' : state.queue ? `в очереди ${state.queue}` : 'очередь пуста'}</span>;
}
