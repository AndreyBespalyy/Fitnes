// Товары и услуги на ресепшне: продажа в пару касаний, склад (приход, списание, пересчёт), отчёт.
import { Fragment, useEffect, useState } from 'react';
import { api, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { GiftsView } from './gifts.tsx';

type Goods = { id: string; name: string; kind: 'goods' | 'service'; category: string | null; priceKop: number; stock: number | null; minStock: number | null; isActive: boolean; sort: number; low: boolean };
type Person = { id: string; fullName: string; phone: string | null };
type Report = {
  from: string; to: string; total: number; byGoods: { goodsId: string; name: string; qty: number; sum: number }[]; byMethod: { method: string; n: number; sum: number }[];
  recent: { id: string; createdAt: string; total: number; method: string | null; status: string; person: string | null; personId: string | null; by: string | null; chargeStatus: string | null; items: string }[];
  unpaid: { n: number; sum: number }; low: { id: string; name: string; stock: number; minStock: number }[];
};
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const toKop = (s: string) => Math.round(Number(s.replace(',', '.').replace(/\s/g, '')) * 100);
const METHOD: Record<string, string> = { cash: 'Наличные', card_terminal: 'Карта', on_account: 'На счёт', deposit: 'С депозита', points: 'Баллами' };

export function ShopPage({ me: _me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [view, setView] = useState<'sell' | 'stock' | 'report' | 'gifts'>('sell');
  const [data, setData] = useState<{ items: Goods[]; canManage: boolean; canSell: boolean } | null>(null);
  const load = () => club && api<NonNullable<typeof data>>('GET', `/api/goods?clubId=${club}`).then(setData).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, [club]);
  if (!club) return <p className="muted">Клубов нет.</p>;
  return (
    <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="tabs" role="group" aria-label="Товары">
          {data?.canSell && <button aria-pressed={view === 'sell'} onClick={() => setView('sell')}>Продажа</button>}
          <button aria-pressed={view === 'stock'} onClick={() => setView('stock')}>Товары и остатки</button>
          <button aria-pressed={view === 'report'} onClick={() => setView('report')}>Отчёт</button>
          <button aria-pressed={view === 'gifts'} onClick={() => setView('gifts')}>Сертификаты</button>
        </div>
        {clubId === 'all' && <select value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      </div>
      {!data ? <p className="muted">Загрузка…</p> : <>
        {view === 'sell' && data.canSell && <Sell club={club} items={data.items.filter((g) => g.isActive)} onSold={load} />}
        {view === 'stock' && <Stock club={club} items={data.items} manage={data.canManage} reload={load} />}
        {view === 'report' && <ReportView club={club} openPerson={openPerson} />}
        {view === 'gifts' && <GiftsView club={club} openPerson={openPerson} />}
      </>}
    </>
  );
}

function Sell({ club, items, onSold }: { club: string; items: Goods[]; onSold: () => void }) {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [person, setPerson] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (q.trim().length < 3 || person) { setFound([]); return; }
    const t = setTimeout(() => api<Person[]>('GET', `/api/persons?clubId=${club}&q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 8))).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q, person]);
  const add = (g: Goods, d: number) => setCart((c) => { const n = Math.max(0, (c[g.id] ?? 0) + d); const x = { ...c }; if (n) x[g.id] = n; else delete x[g.id]; return x; });
  const lines = Object.entries(cart).map(([id, qty]) => ({ g: items.find((x) => x.id === id)!, qty })).filter((l) => l.g);
  const total = lines.reduce((s, l) => s + l.g.priceKop * l.qty, 0);
  const pay = async (method: string | null) => {
    setErr(''); setBusy(true);
    try {
      const r = await api<{ totalKop: number; receiptId: string | null }>('POST', '/api/goods/sales', { clubId: club, personId: person?.id ?? null, method, items: lines.map((l) => ({ goodsId: l.g.id, qty: l.qty })) });
      toast(method === 'deposit' ? `Оплачено с депозита: ${rub(r.totalKop)}` : method === 'points' ? `Оплачено баллами: ${rub(r.totalKop)}` : method ? `Продано на ${rub(r.totalKop)}${r.receiptId ? ', чек отправлен в кассу' : ''}` : `Записано на счёт клиента: ${rub(r.totalKop)}`);
      setCart({}); setPerson(null); setQ(''); onSold();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const cats = [...new Set(items.map((g) => g.category ?? 'Без категории'))];
  return (
    <div className="grid2" style={{ alignItems: 'start' }}>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {items.length === 0 && <p className="muted" style={{ margin: 0 }}>Товаров пока нет. Добавьте их во вкладке «Товары и остатки».</p>}
        {cats.map((c) => (
          <div key={c} style={{ display: 'grid', gap: 6 }}>
            <span className="small muted">{c}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{items.filter((g) => (g.category ?? 'Без категории') === c).map((g) => {
              const out = g.kind === 'goods' && (g.stock ?? 0) <= (cart[g.id] ?? 0);
              return <button key={g.id} className="btn" disabled={out} onClick={() => add(g, 1)} style={{ minHeight: 56, minWidth: 140, display: 'grid', textAlign: 'left' }}>
                <b>{g.name}</b><span className="small">{rub(g.priceKop)}{g.kind === 'goods' ? ` · ${g.stock ?? 0} шт.` : ''}</span></button>;
            })}</div>
          </div>))}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Чек</h2>
        {lines.length === 0 ? <p className="muted" style={{ margin: 0 }}>Нажмите на товар, чтобы добавить.</p> : lines.map((l) => (
          <div key={l.g.id} className="row between"><span>{l.g.name}</span>
            <span className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => add(l.g, -1)} aria-label="Меньше">−</button><b>{l.qty}</b>
              <button className="btn sm" onClick={() => add(l.g, 1)} disabled={l.g.kind === 'goods' && (l.g.stock ?? 0) <= l.qty} aria-label="Больше">+</button>
              <span className="num" style={{ minWidth: 80, textAlign: 'right' }}>{rub(l.g.priceKop * l.qty)}</span></span></div>))}
        <div className="row between"><b>Итого</b><b className="num">{rub(total)}</b></div>
        {person ? <div className="row between small"><span>Покупатель: <b>{person.fullName}</b></span><button className="btn sm" onClick={() => { setPerson(null); setQ(''); }}>Убрать</button></div> : (
          <div style={{ display: 'grid', gap: 4 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Клиент: имя или телефон (необязательно)" aria-label="Клиент" />
            {found.map((p) => <button key={p.id} className="btn sm" style={{ textAlign: 'left' }} onClick={() => setPerson(p)}>{p.fullName}{p.phone ? ` · ${p.phone}` : ''}</button>)}
          </div>)}
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn pri" disabled={!lines.length || busy} onClick={() => pay('card_terminal')}>Карта</button>
          <button className="btn pri" disabled={!lines.length || busy} onClick={() => pay('cash')}>Наличные</button>
          <button className="btn" disabled={!lines.length || busy || !person} onClick={() => pay(null)} title={person ? '' : 'Сначала выберите клиента'}>На счёт клиента</button>
          <button className="btn" disabled={!lines.length || busy || !person} onClick={() => pay('deposit')} title={person ? '' : 'Сначала выберите клиента'}>С депозита</button>
          <button className="btn" disabled={!lines.length || busy || !person} onClick={() => pay('points')} title={person ? 'Списать бонусные баллы клиента' : 'Сначала выберите клиента'}>Баллами</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Наличные — только при открытой кассовой смене. «На счёт» — клиент оплатит позже: долг виден в его карточке и в «Финансах». «С депозита» — списать с внутреннего счёта клиента.</p>
      </div>
    </div>
  );
}

function Stock({ club, items, manage, reload }: { club: string; items: Goods[]; manage: boolean; reload: () => void }) {
  const empty = { name: '', kind: 'goods', category: '', price: '', stock: '', minStock: '' };
  const [f, setF] = useState(empty);
  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<{ id: string; kind: string; qty: string; cost: string; comment: string } | null>(null);
  const [moves, setMoves] = useState<{ id: string; rows: { kind: string; qty: number; stockAfter: number; costKop: number | null; comment: string | null; createdAt: string; by: string | null }[] } | null>(null);
  const [err, setErr] = useState('');
  const create = async () => {
    setErr('');
    try {
      await api('POST', '/api/goods', { clubId: club, name: f.name, kind: f.kind, category: f.category || null, priceKop: toKop(f.price), stock: f.kind === 'goods' ? Number(f.stock || 0) : undefined, minStock: f.minStock ? Number(f.minStock) : null });
      toast('Добавлено'); setF(empty); setOpen(false); reload();
    } catch (x) { setErr(errText(x)); }
  };
  const doOp = async () => {
    if (!op) return; setErr('');
    try { await api('POST', `/api/goods/${op.id}/stock`, { kind: op.kind, qty: Number(op.qty), costKop: op.cost ? toKop(op.cost) : undefined, comment: op.comment || undefined }); toast('Остаток обновлён'); setOp(null); reload(); }
    catch (x) { setErr(errText(x)); }
  };
  const patch = (id: string, b: object) => api('PATCH', `/api/goods/${id}`, b).then(reload).catch((x) => setErr(errText(x)));
  const showMoves = (id: string) => moves?.id === id ? setMoves(null) : api<NonNullable<typeof moves>['rows']>('GET', `/api/goods/${id}/moves`).then((rows) => setMoves({ id, rows }));
  const MK: Record<string, string> = { in: 'приход', sale: 'продажа', writeoff: 'списание', cancel: 'отмена продажи', count: 'пересчёт' };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="row between"><h2>Товары и услуги</h2>{manage && !open && <button className="btn sm pri" onClick={() => setOpen(true)}>+ Добавить</button>}</div>
      {err && <div className="err">{err}</div>}
      {open && (
        <div className="item grid2">
          <label className="f">Название<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Вода 0,5 л" /></label>
          <label className="f">Вид<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="goods">Товар (с остатком)</option><option value="service">Услуга (без остатка)</option></select></label>
          <label className="f">Категория<input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Напитки, спортпит, услуги" /></label>
          <label className="f">Цена, ₽<input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" /></label>
          {f.kind === 'goods' && <label className="f">Начальный остаток<input value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} inputMode="numeric" /></label>}
          {f.kind === 'goods' && <label className="f">Сигнал, когда остаток не больше<input value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} inputMode="numeric" placeholder="не нужен" /></label>}
          <div className="row" style={{ gap: 6 }}><button className="btn sm pri" onClick={create}>Сохранить</button><button className="btn sm" onClick={() => setOpen(false)}>Отмена</button></div>
        </div>)}
      {items.length === 0 ? <p className="muted" style={{ margin: 0 }}>Пока пусто.</p> : (
        <div className="tbl"><table>
          <thead><tr><th>Название</th><th>Категория</th><th>Цена</th><th>Остаток</th><th></th></tr></thead>
          <tbody>{items.map((g) => (<Fragment key={g.id}>
            <tr className={g.isActive ? '' : 'muted'}>
              <td><b>{g.name}</b>{!g.isActive && <span className="chip">снят с продажи</span>}<div className="small muted">{g.kind === 'service' ? 'услуга' : 'товар'}</div></td>
              <td>{g.category ?? '—'}</td>
              <td>{manage ? <button className="link" onClick={() => { const v = prompt('Новая цена, ₽', String(g.priceKop / 100)); if (v) patch(g.id, { priceKop: toKop(v) }); }}>{rub(g.priceKop)}</button> : rub(g.priceKop)}</td>
              <td className={g.low ? 'bad' : ''}>{g.kind === 'goods' ? `${g.stock ?? 0} шт.${g.low ? ' — пора заказать' : ''}` : '—'}</td>
              <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {manage && g.kind === 'goods' && <>
                  <button className="btn sm" onClick={() => setOp({ id: g.id, kind: 'in', qty: '', cost: '', comment: '' })}>Приход</button>
                  <button className="btn sm" onClick={() => setOp({ id: g.id, kind: 'writeoff', qty: '', cost: '', comment: '' })}>Списать</button>
                  <button className="btn sm" onClick={() => setOp({ id: g.id, kind: 'count', qty: String(g.stock ?? 0), cost: '', comment: 'Инвентаризация' })}>Пересчёт</button></>}
                {g.kind === 'goods' && <button className="btn sm" onClick={() => showMoves(g.id)}>История</button>}
                {manage && <button className="btn sm" onClick={() => patch(g.id, { isActive: !g.isActive })}>{g.isActive ? 'Снять' : 'Вернуть'}</button>}
              </div></td>
            </tr>
            {op?.id === g.id && <tr key={`${g.id}op`}><td colSpan={5}><div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
              <label className="f" style={{ width: 120 }}>{op.kind === 'count' ? 'Фактически, шт.' : 'Количество'}<input value={op.qty} onChange={(e) => setOp({ ...op, qty: e.target.value })} inputMode="numeric" /></label>
              {op.kind === 'in' && <label className="f" style={{ width: 160 }}>Закупка, ₽ (всего)<input value={op.cost} onChange={(e) => setOp({ ...op, cost: e.target.value })} inputMode="decimal" /></label>}
              <label className="f" style={{ flex: 1, minWidth: 200 }}>{op.kind === 'writeoff' ? 'Причина' : 'Комментарий'}<input value={op.comment} onChange={(e) => setOp({ ...op, comment: e.target.value })} /></label>
              <button className="btn sm pri" onClick={doOp}>{op.kind === 'in' ? 'Оприходовать' : op.kind === 'writeoff' ? 'Списать' : 'Сохранить'}</button><button className="btn sm" onClick={() => setOp(null)}>Отмена</button>
            </div></td></tr>}
            {moves?.id === g.id && <tr key={`${g.id}mv`}><td colSpan={5}><div className="list small">{moves.rows.map((m, i) => (
              <div key={i} className="row between"><span>{dt(m.createdAt)} · {MK[m.kind] ?? m.kind}{m.comment ? `: ${m.comment}` : ''}{m.by ? ` · ${m.by}` : ''}</span>
                <span className="num">{m.qty > 0 ? `+${m.qty}` : m.qty} → {m.stockAfter}{m.costKop ? ` · ${rub(m.costKop)}` : ''}</span></div>))}</div></td></tr>}
          </Fragment>))}</tbody>
        </table></div>)}
    </div>
  );
}

function ReportView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [r, setR] = useState<Report | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => { api<Report>('GET', `/api/goods/report?clubId=${club}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`).then((x) => { setR(x); if (!from) setFrom(x.from); if (!to) setTo(x.to); }).catch((x) => toast(errText(x))); }, [club, from, to]);
  if (!r) return <p className="muted">Загрузка…</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row" style={{ gap: 8 }}><label className="f">С<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="f">по<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Продано за период</span><b className="num">{rub(r.total)}</b></div>
        {r.byMethod.map((m) => <div key={m.method} className="card kpi-c"><span className="lbl">{METHOD[m.method] ?? m.method}</span><b className="num">{rub(m.sum)}</b><span className="small muted">покупок {m.n}</span></div>)}
        <div className="card kpi-c"><span className="lbl">Не оплачено «на счёт»</span><b className={`num ${r.unpaid.n ? 'bad' : ''}`}>{rub(r.unpaid.sum)}</b><span className="small muted">покупок {r.unpaid.n}</span></div>
      </div>
      {r.low.length > 0 && <div className="card"><h2>Пора заказать</h2>{r.low.map((g) => <div key={g.id} className="small">{g.name}: осталось {g.stock ?? 0} (сигнал при {g.minStock})</div>)}</div>}
      <div className="card"><h2>По товарам</h2>{r.byGoods.length === 0 ? <p className="muted" style={{ margin: 0 }}>Продаж за период нет.</p> : (
        <div className="tbl"><table><thead><tr><th>Товар</th><th>Количество</th><th>Сумма</th></tr></thead>
          <tbody>{r.byGoods.map((g) => <tr key={g.goodsId}><td>{g.name}</td><td>{g.qty}</td><td>{rub(g.sum)}</td></tr>)}</tbody></table></div>)}</div>
      <div className="card"><h2>Последние покупки</h2>{r.recent.length === 0 ? <p className="muted" style={{ margin: 0 }}>Пока нет.</p> : (
        <div className="tbl"><table><thead><tr><th>Когда</th><th>Что</th><th>Покупатель</th><th>Сумма</th><th>Оплата</th></tr></thead>
          <tbody>{r.recent.map((s) => <tr key={s.id}><td className="small">{dt(s.createdAt)}<div className="muted">{s.by}</div></td><td className="small">{s.items}</td>
            <td>{s.personId ? <button className="link" onClick={() => openPerson(s.personId!)}>{s.person}</button> : '—'}</td><td>{rub(s.total)}</td>
            <td className="small">{s.status === 'cancelled' ? <span className="chip">отменена</span> : s.status === 'on_account' ? <span className="chip bad">на счёт, не оплачено</span> : METHOD[s.method ?? ''] ?? s.method}</td></tr>)}</tbody></table></div>)}</div>
    </div>
  );
}
