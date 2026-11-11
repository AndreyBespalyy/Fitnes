// Подарочные сертификаты и депозит клиента: блок «Депозит» в карточке клиента и вкладка «Сертификаты» в разделе «Товары».
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const toKop = (s: string) => Math.round(Number(s.replace(',', '.').replace(/\s/g, '')) * 100);
const MOVE: Record<string, string> = { topup: 'Пополнение', cert: 'Подарочный сертификат', spend: 'Оплата', refund: 'Возврат денег', correction: 'Исправление' };
const METHOD: Record<string, string> = { cash: 'наличные', card_terminal: 'карта', bank_transfer: 'перевод' };
type Person = { id: string; fullName: string; phone: string | null };
type Cert = { id: string; code: string; kind: 'amount' | 'product'; amountKop: number; productName: string | null; validTo: string; status: string; buyerId: string | null; buyer: string | null;
  recipientName: string | null; method: string; soldAt: string; usedPersonId: string | null; usedBy: string | null; usedAt: string | null };
const CST: Record<string, [string, string]> = { active: ['действует', 'ok'], used: ['использован', ''], cancelled: ['аннулирован', 'bad'], expired: ['истёк срок', 'warn'] };

export function usePersonSearch(club: string | null) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [person, setPerson] = useState<Person | null>(null);
  useEffect(() => {
    if (q.trim().length < 3 || person) { setFound([]); return; }
    const t = setTimeout(() => api<Person[]>('GET', `/api/persons?${club ? `clubId=${club}&` : ''}q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 6))).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q, person]);
  const reset = () => { setPerson(null); setQ(''); };
  const ui = (placeholder: string) => person
    ? <div className="row between small"><span>Клиент: <b>{person.fullName}</b></span><button className="btn sm" onClick={reset}>Другой</button></div>
    : <div style={{ display: 'grid', gap: 4 }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {found.map((p) => <button key={p.id} className="btn sm" style={{ textAlign: 'left' }} onClick={() => setPerson(p)}>{p.fullName}{p.phone ? ` · ${p.phone}` : ''}</button>)}
    </div>;
  return { person, q, reset, ui };
}

/* ---------- карточка клиента ---------- */
type Dep = { balanceKop: number; balances: { clubId: string; clubName: string; balanceKop: number }[]; canTopup: boolean; canRefund: boolean;
  moves: { id: string; kind: string; amountKop: number; method: string | null; comment: string | null; createdAt: string; by: string | null; clubName: string; certCode: string | null }[] };

export function DepositBlock({ personId, clubId }: { personId: string; clubId: string | null }) {
  const [d, setD] = useState<Dep | null>(null);
  const [mode, setMode] = useState<'' | 'topup' | 'cert' | 'refund'>('');
  const [sum, setSum] = useState('');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const load = () => api<Dep>('GET', `/api/persons/${personId}/deposit${clubId ? `?clubId=${clubId}` : ''}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [personId]);
  if (!d) return err ? <div className="card err">{err}</div> : null;
  const run = async (f: () => Promise<unknown>, ok: string) => { setErr(''); try { await f(); toast(ok); setMode(''); setSum(''); setCode(''); setReason(''); load(); } catch (x) { setErr(errText(x)); } };
  const topup = (method: string) => run(() => api('POST', `/api/persons/${personId}/deposit/topup`, { clubId, amountKop: toKop(sum), method }), `Депозит пополнен на ${rub(toKop(sum))}`);
  const redeem = () => run(async () => {
    const r = await api<{ kind: string }>('POST', '/api/gift-certs/redeem', { code, personId });
    if (r.kind === 'product') toast('Абонемент по сертификату оформлен и оплачен');
  }, 'Сертификат принят');
  const refund = (method: string) => run(() => api('POST', `/api/persons/${personId}/deposit/refund`, { clubId, amountKop: toKop(sum), method, comment: reason }), 'Возврат с депозита оформлен');
  if (!clubId && d.moves.length === 0) return null;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>Депозит</h2>
        <b className="num" style={{ fontSize: 22 }}>{rub(d.balanceKop)}</b>
      </div>
      {d.balances.length > 1 && <div className="small muted">{d.balances.map((b) => `${b.clubName}: ${rub(b.balanceKop)}`).join(' · ')}</div>}
      {clubId && d.canTopup && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm" aria-pressed={mode === 'topup'} onClick={() => setMode(mode === 'topup' ? '' : 'topup')}>Пополнить</button>
          <button className="btn sm" aria-pressed={mode === 'cert'} onClick={() => setMode(mode === 'cert' ? '' : 'cert')}>Принять сертификат</button>
          {d.canRefund && d.balanceKop > 0 && <button className="btn sm" aria-pressed={mode === 'refund'} onClick={() => setMode(mode === 'refund' ? '' : 'refund')}>Вернуть деньги</button>}
        </div>)}
      {mode === 'topup' && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input value={sum} onChange={(e) => setSum(e.target.value)} placeholder="Сумма, ₽" aria-label="Сумма пополнения" inputMode="decimal" style={{ maxWidth: 140 }} />
          <button className="btn sm pri" disabled={!(toKop(sum) >= 100)} onClick={() => topup('card_terminal')}>Картой</button>
          <button className="btn sm pri" disabled={!(toKop(sum) >= 100)} onClick={() => topup('cash')}>Наличными</button>
        </div>)}
      {mode === 'cert' && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="GIFT-XXXX-XXXX" aria-label="Код сертификата" style={{ maxWidth: 200, letterSpacing: '.05em' }} />
          <button className="btn sm pri" disabled={code.trim().length < 9} onClick={redeem}>Принять</button>
          <span className="small muted">Сертификат на сумму зачислится на депозит, на абонемент — абонемент оформится оплаченным.</span>
        </div>)}
      {mode === 'refund' && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input value={sum} onChange={(e) => setSum(e.target.value)} placeholder="Сумма, ₽" aria-label="Сумма возврата" inputMode="decimal" style={{ maxWidth: 140 }} />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Причина" aria-label="Причина возврата" style={{ maxWidth: 240 }} />
          <button className="btn sm" disabled={!(toKop(sum) >= 100) || !reason.trim()} onClick={() => refund('card_terminal')}>На карту</button>
          <button className="btn sm" disabled={!(toKop(sum) >= 100) || !reason.trim()} onClick={() => refund('cash')}>Наличными</button>
        </div>)}
      {err && <div className="err">{err}</div>}
      {d.moves.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Движений нет. С депозита можно оплатить абонемент, персональные и покупки на ресепшне.</p> : (
        <div className="list">{d.moves.slice(0, 8).map((m) => (
          <div key={m.id} className="row between small">
            <span>{dt(m.createdAt)} · {MOVE[m.kind] ?? m.kind}{m.certCode ? ` ${m.certCode}` : ''}{m.method ? `, ${METHOD[m.method] ?? m.method}` : ''}{m.comment && m.kind !== 'topup' && !m.certCode ? ` · ${m.comment}` : ''}</span>
            <b className={m.amountKop < 0 ? '' : 'ok'}>{m.amountKop > 0 ? '+' : '−'}{rub(Math.abs(m.amountKop))}</b>
          </div>))}</div>)}
    </div>
  );
}

/* ---------- раздел «Товары» → «Сертификаты» ---------- */
type List = { items: Cert[]; stats: { sold30: number; sum30: number; outstanding: number; active: number; used30: number; deposits: number }; canSell: boolean; canCancel: boolean };
type Product = { id: string; name: string; kind: string; priceKop: number | null; isActive: boolean };

export function GiftsView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [d, setD] = useState<List | null>(null);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'' | 'sell' | 'redeem'>('');
  const [err, setErr] = useState('');
  const load = () => api<List>('GET', `/api/gift-certs?clubId=${club}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [club, q]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const s = d.stats;
  const cancel = async (c: Cert) => {
    const comment = window.prompt(`Аннулировать ${c.code} и вернуть ${rub(c.amountKop)} покупателю на карту? Укажите причину:`);
    if (!comment?.trim()) return;
    try { await api('POST', `/api/gift-certs/${c.id}/cancel`, { method: 'card_terminal', comment }); toast('Сертификат аннулирован, возврат записан'); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Продано за 30 дней</span><b className="num">{rub(s.sum30)}</b><span className="small muted">сертификатов {s.sold30}</span></div>
        <div className="card kpi-c"><span className="lbl">Действуют, не использованы</span><b className="num">{rub(s.outstanding)}</b><span className="small muted">штук {s.active}</span></div>
        <div className="card kpi-c"><span className="lbl">Использовано за 30 дней</span><b className="num">{s.used30}</b></div>
        <div className="card kpi-c"><span className="lbl">На депозитах клиентов</span><b className="num">{rub(s.deposits)}</b><span className="small muted">обязательства клуба</span></div>
      </div>
      {d.canSell && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn pri" aria-pressed={mode === 'sell'} onClick={() => setMode(mode === 'sell' ? '' : 'sell')}>Продать сертификат</button>
          <button className="btn" aria-pressed={mode === 'redeem'} onClick={() => setMode(mode === 'redeem' ? '' : 'redeem')}>Принять сертификат</button>
        </div>)}
      {mode === 'sell' && <SellCert club={club} done={() => { setMode(''); load(); }} />}
      {mode === 'redeem' && <RedeemCert club={club} done={() => { setMode(''); load(); }} />}
      {err && <div className="err">{err}</div>}
      <div className="card">
        <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}><h2>Сертификаты</h2>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, покупатель или получатель" aria-label="Поиск сертификата" style={{ maxWidth: 280 }} /></div>
        {d.items.length === 0 ? <p className="muted" style={{ margin: 0 }}>Сертификатов пока нет.</p> : (
          <div className="tbl"><table><thead><tr><th>Код</th><th>Что</th><th>Покупатель</th><th>Кому</th><th>До</th><th>Статус</th><th></th></tr></thead>
            <tbody>{d.items.map((c) => {
              const [l, cls] = CST[c.status] ?? [c.status, ''];
              return <tr key={c.id}>
                <td><b style={{ letterSpacing: '.04em' }}>{c.code}</b><div className="small muted">{dt(c.soldAt)}</div></td>
                <td>{c.kind === 'product' ? c.productName : 'На сумму'}<div className="small">{rub(c.amountKop)}</div></td>
                <td>{c.buyerId ? <button className="link" onClick={() => openPerson(c.buyerId!)}>{c.buyer}</button> : c.buyer ?? '—'}</td>
                <td>{c.usedPersonId ? <button className="link" onClick={() => openPerson(c.usedPersonId!)}>{c.usedBy}</button> : c.recipientName ?? '—'}</td>
                <td className="small">{c.validTo.split('-').reverse().join('.')}</td>
                <td><span className={`chip ${cls}`}>{l}</span>{c.usedAt && <div className="small muted">{dt(c.usedAt)}</div>}</td>
                <td>{d.canCancel && c.status === 'active' && <button className="btn sm" onClick={() => cancel(c)}>Аннулировать</button>}</td>
              </tr>;
            })}</tbody></table></div>)}
      </div>
      <p className="small muted" style={{ margin: 0, maxWidth: 780 }}>
        Деньги за сертификат и пополнение депозита приходят сразу, чек пробивается как аванс. Когда клиент тратит депозит или сертификат, второго платежа нет, поэтому выручка не задваивается.
        Сертификат на сумму зачисляется на депозит получателя, сертификат на абонемент сразу оформляет абонемент оплаченным.
      </p>
    </div>
  );
}

function SellCert({ club, done }: { club: string; done: () => void }) {
  const [kind, setKind] = useState<'amount' | 'product'>('amount');
  const [sum, setSum] = useState('3000');
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [recipient, setRecipient] = useState('');
  const [days, setDays] = useState(365);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sold, setSold] = useState<Cert | null>(null);
  const buyer = usePersonSearch(club);
  useEffect(() => { api<Product[]>('GET', `/api/products?clubId=${club}`).then((r) => setProducts(r.filter((p) => p.isActive && p.kind !== 'subscription' && p.priceKop))).catch(() => setProducts([])); }, [club]);
  const sell = async (method: string) => {
    setErr(''); setBusy(true);
    try {
      const c = await api<Cert>('POST', '/api/gift-certs', { clubId: club, kind, amountKop: kind === 'amount' ? toKop(sum) : undefined, productId: kind === 'product' ? productId : undefined,
        buyerPersonId: buyer.person?.id ?? null, buyerName: buyer.person ? undefined : (buyerName.trim() || buyer.q.trim()), recipientName: recipient, method, validDays: days });
      toast(`Сертификат ${c.code} продан`);
      setSold(c);
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const ready = (kind === 'amount' ? toKop(sum) >= 100 : !!productId) && (buyer.person || buyerName.trim() || buyer.q.trim());
  if (sold) return (
    <div className="card" style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <h2>Сертификат продан</h2>
      <div style={{ fontSize: 26, letterSpacing: '.08em' }}><b>{sold.code}</b></div>
      <div>{sold.kind === 'product' ? sold.productName : `На сумму ${rub(sold.amountKop)}`}{sold.recipientName ? ` · для: ${sold.recipientName}` : ''} · действует до {sold.validTo.split('-').reverse().join('.')}</div>
      <p className="small muted" style={{ margin: 0 }}>Перепишите код на бланк сертификата или отправьте покупателю. По этому коду получатель придёт в клуб.</p>
      <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => navigator.clipboard?.writeText(sold.code).then(() => toast('Код скопирован')).catch(() => toast(sold.code))}>Скопировать код</button>
        <button className="btn sm pri" onClick={done}>Готово</button></div>
    </div>);
  return (
    <div className="card" style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <h2>Продажа сертификата</h2>
      <div className="tabs" role="group" aria-label="Вид сертификата">
        <button aria-pressed={kind === 'amount'} onClick={() => setKind('amount')}>На сумму</button>
        <button aria-pressed={kind === 'product'} onClick={() => setKind('product')}>На абонемент</button>
      </div>
      {kind === 'amount' ? <label className="f">Номинал, ₽<input value={sum} onChange={(e) => setSum(e.target.value)} inputMode="decimal" /></label>
        : <label className="f">Абонемент<select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Выберите…</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {rub(p.priceKop ?? 0)}</option>)}</select></label>}
      <span className="small muted">Покупатель: найдите клиента или просто впишите имя</span>
      {buyer.ui('Покупатель: имя или телефон')}
      {!buyer.person && buyer.q.trim().length === 0 && <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Или имя покупателя без карточки" aria-label="Имя покупателя" />}
      <label className="f">Кому (будет на сертификате, необязательно)<input value={recipient} onChange={(e) => setRecipient(e.target.value)} /></label>
      <label className="f">Срок действия<select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={90}>3 месяца</option><option value={180}>6 месяцев</option><option value={365}>1 год</option></select></label>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn pri" disabled={!ready || busy} onClick={() => sell('card_terminal')}>Оплата картой</button>
        <button className="btn pri" disabled={!ready || busy} onClick={() => sell('cash')}>Наличными</button>
      </div>
    </div>
  );
}

function RedeemCert({ club, done }: { club: string; done: () => void }) {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<Cert | null>(null);
  const [err, setErr] = useState('');
  const who = usePersonSearch(club);
  const check = async () => { setErr(''); setInfo(null); try { setInfo(await api<Cert>('GET', `/api/gift-certs/check?code=${encodeURIComponent(code)}`)); } catch (x) { setErr(errText(x)); } };
  const redeem = async () => {
    setErr('');
    try {
      const r = await api<{ kind: string; balanceKop: number | null }>('POST', '/api/gift-certs/redeem', { code, personId: who.person!.id });
      toast(r.kind === 'product' ? 'Абонемент по сертификату оформлен и оплачен' : `Зачислено на депозит, баланс ${rub(r.balanceKop ?? 0)}`);
      done();
    } catch (x) { setErr(errText(x)); }
  };
  const [l, cls] = info ? CST[info.status] ?? [info.status, ''] : ['', ''];
  return (
    <div className="card" style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <h2>Принять сертификат</h2>
      <div className="row" style={{ gap: 6 }}>
        <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setInfo(null); }} placeholder="GIFT-XXXX-XXXX" aria-label="Код сертификата" style={{ letterSpacing: '.05em' }} />
        <button className="btn" disabled={code.trim().length < 9} onClick={check}>Проверить</button>
      </div>
      {info && <div className="item small">
        <b>{info.kind === 'product' ? info.productName : `На сумму ${rub(info.amountKop)}`}</b> · <span className={`chip ${cls}`}>{l}</span> · до {info.validTo.split('-').reverse().join('.')}
        {info.recipientName ? <div>Для: {info.recipientName}</div> : null}{info.buyer ? <div>Подарил(а): {info.buyer}</div> : null}
      </div>}
      {info?.status === 'active' && <>
        {who.ui('Кто получает подарок: имя или телефон')}
        <button className="btn pri" disabled={!who.person} onClick={redeem}>{info.kind === 'product' ? 'Оформить абонемент' : 'Зачислить на депозит'}</button>
      </>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
