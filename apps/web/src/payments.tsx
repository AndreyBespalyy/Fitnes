// Шаг 12. Онлайн-оплата: настройка банка клуба, кнопка «Ссылка на оплату», карты клиента и автосписание,
// журнал онлайн-оплат и сверка с банковской выпиской.
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { Md } from './fiscal.tsx';
import guide from '../../../docs/03_Инструкции/Онлайн_оплата_и_сверка_с_банком.md?raw';

const rub = (kop: number) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const d = (s: string) => s.split('-').reverse().join('.');
const STATUS: Record<string, [string, string]> = { created: ['ждёт оплаты', 'warn'], pending: ['банк проверяет', 'acc'], succeeded: ['оплачено', 'ok'], failed: ['отказ', 'bad'], cancelled: ['отменено', ''], expired: ['ссылка устарела', ''] };

/* ---------------- настройка банка (в разделе «Касса») ---------------- */
type Acq = { provider: string; providerName: string; live: boolean; shopId: string | null; hasSecret: boolean; sbpEnabled: boolean; autopayEnabled: boolean; linkHours: number };
const BANK: Record<string, { name: string; text: string; id?: string; secret?: string }> = {
  test: { name: 'Тестовый банк', text: 'Встроенная проверочная страница оплаты. Деньги не списываются. Подходит, пока банк не выбран.' },
  yookassa: { name: 'ЮKassa', text: 'Карты, СБП, сохранение карты для автосписания. Ключи: личный кабинет ЮKassa → Интеграция → Ключи API.', id: 'shopId', secret: 'Секретный ключ' },
  tbank: { name: 'Т-Банк', text: 'Интернет-эквайринг Т-Банка: карты, СБП, рекуррентные платежи. Ключи: личный кабинет → Магазины → Терминалы.', id: 'TerminalKey', secret: 'Пароль терминала' },
};

export function AcquiringForm({ club, manage }: { club: Club; manage: boolean }) {
  const [s, setS] = useState<Acq | null>(null);
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<Acq>('GET', `/api/clubs/${club.id}/acquiring`).then(setS).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club.id]);
  if (!s) return err ? <div className="err">{err}</div> : null;
  const ro = !manage;
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      const r = await api<Acq>('PUT', `/api/clubs/${club.id}/acquiring`, { ...s, secret: secret || undefined }); setS(r); setSecret('');
      const t = await api<{ info: string }>('POST', `/api/clubs/${club.id}/acquiring/test`); setMsg(`Сохранено. ${t.info}`);
    } catch (x) { setErr(errText(x)); }
  };
  const run = async () => {
    try { const r = await api<{ periods: number; charged: number; failed: number; noCard: number }>('POST', '/api/billing/run', { clubId: club.id });
      toast(`Новых периодов подписки: ${r.periods}. Списано: ${r.charged}, отказов: ${r.failed}, без карты: ${r.noCard}`); } catch (x) { setErr(errText(x)); }
  };
  const b = BANK[s.provider];
  return (
    <form className="card" style={{ display: 'grid', gap: 10 }} onSubmit={save}>
      <div className="row between"><h2 style={{ margin: 0 }}>Онлайн-оплата картой и СБП</h2>
        <span className={`chip ${s.live ? 'ok' : 'warn'}`}>{s.live ? 'боевой режим: настоящие деньги' : s.provider === 'test' ? 'тестовый банк' : 'песочница банка'}</span></div>
      <p className="small" style={{ margin: 0 }}>Менеджер отправляет клиенту ссылку на оплату. После оплаты начисление закрывается само, пробивается чек, а карта сохраняется для автосписания подписки, если клиент согласен. Чтобы сменить банк, достаточно выбрать его здесь и ввести ключи.</p>
      {err && <div className="err">{err}</div>}
      {msg && <div className="item ok-msg">{msg}</div>}
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        {Object.entries(BANK).map(([k, v]) => (
          <button type="button" key={k} disabled={ro} className={`opt modecard ${s.provider === k ? 'on' : ''}`} aria-pressed={s.provider === k}
            onClick={() => setS({ ...s, provider: k, live: k === 'test' ? false : s.live, shopId: k === s.provider ? s.shopId : '' })}>
            <b>{v.name}</b><span className="small">{v.text}</span></button>))}
      </div>
      {b.id && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <label className="f">{b.id}<input value={s.shopId ?? ''} disabled={ro} autoComplete="off" onChange={(e) => setS({ ...s, shopId: e.target.value })} /></label>
          <label className="f">{b.secret}<input type="password" value={secret} disabled={ro} autoComplete="new-password" placeholder={s.hasSecret ? 'сохранён, введите, чтобы заменить' : ''} onChange={(e) => setSecret(e.target.value)} /></label>
          <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 18, height: 18 }} checked={s.live} disabled={ro} onChange={(e) => setS({ ...s, live: e.target.checked })} />
            Боевой режим (настоящие деньги). Без галочки — тестовые ключи банка</label>
        </div>)}
      <div className="row">
        <label className="row small"><input type="checkbox" style={{ width: 18, height: 18 }} checked={s.sbpEnabled} disabled={ro} onChange={(e) => setS({ ...s, sbpEnabled: e.target.checked })} />Оплата через СБП</label>
        <label className="row small"><input type="checkbox" style={{ width: 18, height: 18 }} checked={s.autopayEnabled} disabled={ro} onChange={(e) => setS({ ...s, autopayEnabled: e.target.checked })} />Автосписание подписки с сохранённой карты</label>
        <label className="row small">Ссылка действует <input type="number" min={1} max={720} value={s.linkHours} disabled={ro} style={{ width: 80 }} onChange={(e) => setS({ ...s, linkHours: Number(e.target.value) })} /> ч</label>
      </div>
      {s.provider !== 'test' && <span className="small">Адрес для уведомлений (укажите в кабинете банка): <code>{`${location.origin}/api/hooks/pay/${club.id}`}</code>. Без него оплаты тоже придут, система сама опрашивает банк раз в минуту.</span>}
      <span className="small">Сколько раз повторять автосписание и с каким интервалом, задаётся в «Тарифы» → «Правила клуба». Списания и проверка оплат идут сами раз в минуту.</span>
      {manage && <div className="row"><button className="btn pri">Сохранить и проверить</button><button type="button" className="btn" onClick={run}>Запустить списания сейчас</button></div>}
      <details className="item"><summary><b>Инструкция: онлайн-оплата, автосписание, сверка с банком</b></summary><Md text={guide} /></details>
    </form>
  );
}

/* ---------------- кнопка «Ссылка на оплату» у начисления ---------------- */
export function PayLinkButton({ chargeId, onDone }: { chargeId: string; onDone?: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const make = async (send: boolean) => {
    setErr('');
    try {
      const r = await api<{ url: string; sent: boolean }>('POST', `/api/charges/${chargeId}/pay-link`, { send });
      setLink(r.url);
      if (send) toast('Ссылка отправлена клиенту в переписку');
      else { try { await navigator.clipboard.writeText(r.url); toast('Ссылка скопирована'); } catch { toast('Ссылка готова'); } }
      onDone?.();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <span className="row" style={{ gap: 4 }}>
      <button className="btn sm" onClick={() => make(true)} title="Отправить ссылку на оплату в WhatsApp или Telegram">Ссылка в чат</button>
      <button className="btn sm" onClick={() => make(false)}>Ссылка</button>
      {link && <a className="small" href={link} target="_blank" rel="noreferrer">открыть</a>}
      {err && <span className="small bad">{err}</span>}
    </span>
  );
}

/* ---------------- карты клиента и автосписание (карточка клиента) ---------------- */
type PM = { methods: { id: string; title: string; providerName: string; live: boolean; createdAt: string; lastUsedAt: string | null }[];
  payments: { id: string; createdAt: string; purpose: string; amountKop: number; status: string; method: string | null; error: string | null; conflict: string | null; description: string }[];
  autopay: { id: string; title: string; dueOn: string; amountKop: number; attempts: number; nextOn: string | null; error: string | null }[] };

export function PersonCards({ me, personId, autopayEnabled }: { me: Me; personId: string; autopayEnabled: boolean }) {
  const [p, setP] = useState<PM | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<PM>('GET', `/api/persons/${personId}/payment-methods`).then(setP).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [personId]);
  if (!p) return err ? <p className="err">{err}</p> : null;
  if (!p.methods.length && !p.payments.length && !p.autopay.length) return null;
  const remove = async (id: string) => { try { await api('POST', `/api/payment-methods/${id}/remove`); toast('Карта отвязана, автосписаний с неё не будет'); load(); } catch (e) { setErr(errText(e)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <b>Онлайн-оплата</b>
      {err && <p className="err">{err}</p>}
      {p.methods.map((m) => (
        <div key={m.id} className="item row between"><span><b>{m.title}</b> <span className="small">{m.providerName}{m.live ? '' : ', тест'} · сохранена {dt(m.createdAt)}{m.lastUsedAt ? ` · списание ${dt(m.lastUsedAt)}` : ''}</span></span>
          {can(me, 'memberships.manage') && <button className="btn sm" onClick={() => remove(m.id)}>Отвязать</button>}</div>))}
      {p.methods.length === 0 && <span className="small">Сохранённой карты нет. Она появится после первой оплаты подписки по ссылке{autopayEnabled ? '' : ', если отмечено согласие на автосписание'}.</span>}
      {p.autopay.filter((a) => a.attempts > 0 || a.error).map((a) => (
        <div key={a.id} className="small bad">Автосписание «{a.title}» ({rub(a.amountKop)}): {a.error ?? 'не прошло'}{a.attempts ? `, попыток: ${a.attempts}` : ''}{a.nextOn ? `, следующая ${d(a.nextOn)}` : ''}</div>))}
      {p.payments.length > 0 && <details><summary className="small">Онлайн-оплаты ({p.payments.length})</summary>
        {p.payments.map((o) => <div key={o.id} className="small">{dt(o.createdAt)} · {o.purpose === 'autopay' ? 'автосписание' : 'по ссылке'} · {rub(o.amountKop)} ·{' '}
          <span className={`chip ${STATUS[o.status]?.[1] ?? ''}`}>{STATUS[o.status]?.[0] ?? o.status}</span>{o.method === 'sbp' ? ' СБП' : ''}{o.error ? ` · ${o.error}` : ''}{o.conflict ? ` · ${o.conflict}` : ''}</div>)}
      </details>}
    </div>
  );
}

/* ---------------- журнал онлайн-оплат (раздел «Финансы») ---------------- */
type OP = { id: string; createdAt: string; paidAt: string | null; purpose: string; amountKop: number; description: string; providerName: string; live: boolean; status: string; method: string | null;
  error: string | null; conflict: string | null; person: string; personId: string; createdBy: string | null; card: string | null };
export function OnlinePayments({ club, openPerson }: { club: Club; openPerson: (id: string) => void }) {
  const [list, setList] = useState<OP[]>([]);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const load = () => api<OP[]>('GET', `/api/online-payments?clubId=${club.id}${status ? `&status=${status}` : ''}`).then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [club.id, status]);
  const check = async (id: string) => { try { const r = await api<{ status: string }>('POST', `/api/online-payments/${id}/check`); toast(`Статус: ${STATUS[r.status]?.[0] ?? r.status}`); load(); } catch (e) { setErr(errText(e)); } };
  const ok = list.filter((o) => o.status === 'succeeded');
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><b>Онлайн-оплаты и автосписания</b>
        <select aria-label="Статус" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Все</option>{Object.entries(STATUS).map(([k, [t]]) => <option key={k} value={k}>{t}</option>)}</select></div>
      <span className="small">Оплачено: {ok.length} на {rub(ok.reduce((s, o) => s + o.amountKop, 0))}. Отказов: {list.filter((o) => o.status === 'failed').length}.</span>
      {err && <p className="err">{err}</p>}
      <div className="tbl"><table><thead><tr><th>Когда</th><th>Клиент</th><th>За что</th><th>Сумма</th><th>Как</th><th>Статус</th><th /></tr></thead>
        <tbody>{list.map((o) => <tr key={o.id}>
          <td className="num">{dt(o.paidAt ?? o.createdAt)}</td>
          <td><a href="#" onClick={(e) => { e.preventDefault(); openPerson(o.personId); }}>{o.person}</a></td>
          <td className="small">{o.description}</td><td className="num">{rub(o.amountKop)}</td>
          <td className="small">{o.purpose === 'autopay' ? `автосписание${o.card ? `, ${o.card}` : ''}` : `ссылка${o.createdBy ? `, ${o.createdBy}` : ''}`}{o.method === 'sbp' ? ', СБП' : ''}<br />{o.providerName}{o.live ? '' : ' (тест)'}</td>
          <td><span className={`chip ${STATUS[o.status]?.[1] ?? ''}`}>{STATUS[o.status]?.[0] ?? o.status}</span>{o.error && <div className="small">{o.error}</div>}{o.conflict && <div className="small bad">{o.conflict}</div>}</td>
          <td>{['created', 'pending'].includes(o.status) && <button className="btn sm" onClick={() => check(o.id)}>Проверить</button>}</td></tr>)}</tbody></table></div>
      {list.length === 0 && <p className="muted">Онлайн-оплат ещё не было.</p>}
    </div>
  );
}

/* ---------------- сверка с банком (раздел «Финансы») ---------------- */
type Line = { id: string; date: string; number: string | null; direction: string; amountKop: number; counterparty: string | null; inn: string | null; purpose: string | null; status: string;
  matchKind: string | null; note: string | null; auto: boolean | null; matchedBy: string | null; grossKop: number | null; payPerson: string; expense: string | null };
type Bank = { lines: Line[]; statements: { id: string; fileName: string; from: string | null; to: string | null; lines: number; createdAt: string; uploadedBy: string | null }[];
  notPaidOut: { day: string; gross: number }[]; missing: { id: string; at: string; amountKop: number; direction: string; who: string | null }[];
  totals: { inKop: number; outKop: number; unmatched: number; feesKop: number } };
const KIND: Record<string, string> = { acquiring: 'эквайринг', payment: 'платёж в системе', expense: 'расход', bank_fee: 'комиссия банка', other: 'другое' };

export function BankReconciliation({ me, club }: { me: Me; club: Club }) {
  const [b, setB] = useState<Bank | null>(null);
  const [only, setOnly] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const work = can(me, 'finance.work');
  const load = () => api<Bank>('GET', `/api/bank/lines?clubId=${club.id}${only ? '&status=unmatched' : ''}`).then(setB).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [club.id, only]);
  const upload = async (file: File) => {
    setErr('');
    const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(file); });
    try {
      const r = await api<{ added: number; duplicates: number; unmatched: number; matched: Record<string, number> }>('POST', '/api/bank/statements', { clubId: club.id, fileName: file.name, dataBase64: data });
      toast(`Загружено операций: ${r.added}${r.duplicates ? `, уже были: ${r.duplicates}` : ''}. Не сопоставлено: ${r.unmatched}`); load();
    } catch (e) { setErr(errText(e)); }
  };
  if (!b) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  return (
    <>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <b>Сверка с выпиской банка</b>
        <span className="small">В интернет-банке выгрузите выписку по счёту клуба в формате «1С: Предприятие» (файл .txt) и загрузите сюда. Система сама найдёт возмещение эквайринга с комиссией, комиссии банка, переводы и оплату расходов. Повторная загрузка той же выписки дублей не создаст.</span>
        {work && <div className="row">
          <label className="btn pri" style={{ cursor: 'pointer' }}>Загрузить выписку<input type="file" accept=".txt" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></label>
          <a className="btn" style={{ textDecoration: 'none', color: 'inherit' }} href={`/api/bank/sample?clubId=${club.id}`}>Скачать пример выписки для проверки</a></div>}
        {err && <p className="err">{err}</p>}
      </div>
      <div className="kpis">
        <div className="card"><span className="lbl">Поступления по выписке</span><b className="num">{rub(b.totals.inKop)}</b></div>
        <div className="card"><span className="lbl">Списания по выписке</span><b className="num">{rub(b.totals.outKop)}</b></div>
        <div className="card"><span className="lbl">Комиссия эквайринга</span><b className="num">{rub(b.totals.feesKop)}</b></div>
        <div className="card"><span className="lbl">Не сопоставлено</span><b className={`num ${b.totals.unmatched ? 'bad' : ''}`}>{b.totals.unmatched}</b></div>
      </div>
      {(b.notPaidOut.length > 0 || b.missing.length > 0) && <div className="card" style={{ display: 'grid', gap: 4 }}>
        <b>В системе есть, в выписке нет</b>
        {b.notPaidOut.map((x) => <span key={x.day} className="small bad">Онлайн-оплаты за {d(x.day)} на {rub(x.gross)}: банк ещё не перечислил деньги</span>)}
        {b.missing.map((x) => <span key={x.id} className="small bad">Перевод {dt(x.at)} на {rub(x.amountKop)} ({x.who ?? '—'}) не найден в выписке</span>)}
      </div>}
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><b>Операции</b><label className="row small"><input type="checkbox" style={{ width: 16, height: 16 }} checked={only} onChange={(e) => setOnly(e.target.checked)} />Только несопоставленные</label></div>
        <div className="tbl"><table><thead><tr><th>Дата</th><th>Сумма</th><th>Контрагент и назначение</th><th>Что это</th></tr></thead>
          <tbody>{b.lines.map((l) => <tr key={l.id}>
            <td className="num">{d(l.date)}</td>
            <td className={`num ${l.direction === 'out' ? 'bad' : ''}`} style={{ whiteSpace: 'nowrap' }}>{l.direction === 'out' ? '−' : '+'}{rub(l.amountKop)}</td>
            <td><b>{l.counterparty ?? '—'}</b>{l.inn ? <span className="small"> ИНН {l.inn}</span> : null}<div className="small">{l.purpose}</div></td>
            <td style={{ minWidth: 200 }}>
              {l.status === 'unmatched' ? <span className="chip bad">не сопоставлено</span> : l.status === 'ignored' ? <span className="chip">не учитываем</span>
                : <span className="chip ok">{KIND[l.matchKind ?? ''] ?? 'сопоставлено'}{l.auto ? ', авто' : ''}</span>}
              {l.note && <div className="small">{l.note.replace(/\s\[[^\]]*\]$/, '')}</div>}
              {l.payPerson && <div className="small">{l.payPerson}</div>}{l.expense && <div className="small">{l.expense}</div>}
              {l.matchedBy && <div className="small">отметил(а): {l.matchedBy}</div>}
              {work && (open === l.id ? <MatchForm line={l} onDone={() => { setOpen(null); load(); }} onCancel={() => setOpen(null)} />
                : <button className="btn sm" onClick={() => setOpen(l.id)}>{l.status === 'unmatched' ? 'Сопоставить' : 'Изменить'}</button>)}
            </td></tr>)}</tbody></table></div>
        {b.lines.length === 0 && <p className="muted">Выписок ещё не загружали.</p>}
      </div>
      {b.statements.length > 0 && <div className="card small">Загруженные выписки: {b.statements.map((s) => `${s.fileName} (${s.from ? d(s.from) : '?'} — ${s.to ? d(s.to) : '?'}, новых операций ${s.lines}, ${s.uploadedBy ?? ''})`).join('; ')}</div>}
    </>
  );
}

function MatchForm({ line, onDone, onCancel }: { line: Line; onDone: () => void; onCancel: () => void }) {
  const [c, setC] = useState<{ payments: { id: string; at: string; amountKop: number; method: string; who: string }[]; expenses: { id: string; date: string; amountKop: number; description: string }[] } | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api<typeof c>('GET', `/api/bank/lines/${line.id}/candidates`).then(setC).catch(() => setC({ payments: [], expenses: [] })); }, [line.id]);
  const go = async (body: Record<string, string>) => { setErr(''); try { await api('POST', `/api/bank/lines/${line.id}/match`, { ...body, note }); toast('Сохранено'); onDone(); } catch (e) { setErr(errText(e)); } };
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      {c?.payments.map((p) => <button key={p.id} className="opt" onClick={() => go({ kind: 'payment', paymentId: p.id })}><b>Платёж {dt(p.at)} · {rub(p.amountKop)}</b><span className="small">{p.who}, {p.method}</span></button>)}
      {c?.expenses.map((e) => <button key={e.id} className="opt" onClick={() => go({ kind: 'expense', expenseId: e.id })}><b>Расход {d(e.date)} · {rub(e.amountKop)}</b><span className="small">{e.description}</span></button>)}
      {c && !c.payments.length && !c.expenses.length && <span className="small">Платежей и расходов с такой суммой в системе нет.</span>}
      <input placeholder="Комментарий: что это за операция" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        {line.direction === 'out' && <button className="btn sm" onClick={() => go({ kind: 'bank_fee' })}>Комиссия банка</button>}
        <button className="btn sm" onClick={() => go({ kind: 'other' })}>Другое (с комментарием)</button>
        <button className="btn sm" onClick={() => go({ kind: 'ignored' })}>Не учитывать</button>
        {line.status !== 'unmatched' && <button className="btn sm" onClick={() => go({ kind: 'reset' })}>Сбросить</button>}
        <button className="btn sm" onClick={onCancel}>Отмена</button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
