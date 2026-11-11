// Промокоды и акции: список с окупаемостью в разделе «Тарифы» и выбор скидки в форме продажи.
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Club } from './api.ts';
import { errText, toast } from './ui.ts';

type Promo = {
  id: string; name: string; code: string | null; channel: string | null; status: string; validFrom: string; validTo: string;
  discountPercent: number | null; discountKop: number | null; condition: string; maxUses: number | null; productIds: string[]; createdBy: string | null;
  sales: number; revenue: number; cost: number; clients: number; newClients: number; renewed: number; renewalPct: number | null; roi: number | null; canManage: boolean;
};
type Product = { id: string; name: string; priceKop: number | null; isActive: boolean };
const rub = (k: number | null | undefined) => (k == null ? '—' : `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`);
const d = (s: string) => s.split('-').reverse().join('.');
const STATUS: Record<string, [string, string]> = { active: ['действует', 'ok'], pending: ['ждёт согласования', 'warn'], stopped: ['остановлена', ''], rejected: ['отказано', 'bad'] };
const COND: Record<string, string> = { any: 'всем', new: 'новым', renewal: 'при продлении', return: 'вернувшимся' };
const disc = (p: Pick<Promo, 'discountPercent' | 'discountKop'>) => (p.discountPercent != null ? `−${p.discountPercent} %` : `−${rub(p.discountKop)}`);

/* ---------- Акции и промокоды (раздел «Тарифы») ---------- */
export function PromosBlock({ club, manage }: { club: Club; manage: boolean }) {
  const [list, setList] = useState<Promo[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const empty = { name: '', code: '', channel: '', type: 'percent', value: '', productIds: [] as string[], condition: 'any', validFrom: today, validTo: '', maxUses: '' };
  const [f, setF] = useState(empty);
  const reload = () => api<Promo[]>('GET', `/api/promos?clubId=${club.id}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); api<Product[]>('GET', `/api/products?clubId=${club.id}&active=1`).then(setProducts).catch(() => setProducts([])); }, [club.id]);

  const create = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    const v = Number(f.value.replace(',', '.'));
    try {
      const r = await api<{ status: string }>('POST', '/api/promos', {
        clubId: club.id, name: f.name, code: f.code || null, channel: f.channel || null, productIds: f.productIds, condition: f.condition, validFrom: f.validFrom, validTo: f.validTo,
        maxUses: f.maxUses ? Number(f.maxUses) : null, discountPercent: f.type === 'percent' ? v : null, discountKop: f.type === 'sum' ? Math.round(v * 100) : null,
      });
      toast(r.status === 'active' ? 'Акция создана и уже действует' : 'Скидка больше вашего лимита: акция включится после согласования');
      setF(empty); setOpen(false); reload();
    } catch (x) { setErr(errText(x)); }
  };
  const setStatus = (id: string, status: string) => api('POST', `/api/promos/${id}/status`, { status }).then(reload).catch((x) => setErr(errText(x)));
  const pname = (ids: string[]) => (ids.length ? ids.map((id) => products.find((p) => p.id === id)?.name ?? '…').join(', ') : 'все тарифы');

  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="row between">
        <h2>Акции и промокоды</h2>
        {manage && !open && <button className="btn sm pri" onClick={() => setOpen(true)}>+ Новая акция</button>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        По каждой акции видно, сколько продаж она дала, во что обошлась скидка и сколько клиентов потом продлили абонемент. Окупаемость — выручка на рубль скидки.
        Скидка больше вашего лимита включается после согласования.
      </p>
      {err && <div className="err">{err}</div>}
      {open && (
        <form className="item" onSubmit={create} style={{ display: 'grid', gap: 8 }}>
          <div className="grid2">
            <label className="f">Название<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Осень с блогером" required /></label>
            <label className="f">Промокод<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="OSEN10" />
              <span className="small">Пусто — акцию выбирают из списка при продаже</span></label>
            <label className="f">Канал или партнёр<input value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} placeholder="Блогер, листовки, партнёр" /></label>
            <label className="f">Скидка<span className="row" style={{ gap: 6 }}>
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={{ width: 'auto' }}><option value="percent">%</option><option value="sum">₽</option></select>
              <input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} inputMode="decimal" required /></span></label>
            <label className="f">Кому<select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>
              <option value="any">Всем</option><option value="new">Только новым клиентам</option><option value="renewal">Только при продлении</option><option value="return">Только вернувшимся</option></select></label>
            <label className="f">Сколько раз можно использовать<input value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} inputMode="numeric" placeholder="без ограничений" /></label>
            <label className="f">Действует с<input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} required /></label>
            <label className="f">по<input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} required /></label>
          </div>
          <div className="f">Тарифы <span className="small muted">(ничего не выбрано — все тарифы клуба)</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>{products.map((p) => (
              <label key={p.id} className="row" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.productIds.includes(p.id)}
                onChange={(e) => setF({ ...f, productIds: e.target.checked ? [...f.productIds, p.id] : f.productIds.filter((x) => x !== p.id) })} />{p.name}</label>))}</div>
          </div>
          <div className="row"><button className="btn pri sm">Создать</button><button type="button" className="btn sm" onClick={() => setOpen(false)}>Отмена</button></div>
        </form>)}
      {list === null ? <p className="muted">Загрузка…</p> : list.length === 0 ? <p className="muted" style={{ margin: 0 }}>Акций пока нет.</p> : (
        <div className="tbl"><table>
          <thead><tr><th>Акция</th><th>Скидка</th><th>Срок</th><th>Продаж</th><th>Выручка</th><th>Скидка обошлась</th><th>Окупаемость</th><th>Продлили</th><th></th></tr></thead>
          <tbody>{list.map((p) => {
            const [label, cls] = STATUS[p.status] ?? [p.status, ''];
            return (
              <tr key={p.id}>
                <td><b>{p.name}</b>{p.code && <> · <code>{p.code}</code></>}<div className="small muted">{[p.channel, COND[p.condition], pname(p.productIds), p.maxUses ? `до ${p.maxUses} раз` : null].filter(Boolean).join(' · ')}</div>
                  <span className={`chip ${cls}`}>{label}</span></td>
                <td>{disc(p)}</td>
                <td className="small">{d(p.validFrom)} — {d(p.validTo)}</td>
                <td>{p.sales}{p.newClients ? <div className="small muted">новых {p.newClients}</div> : null}</td>
                <td>{rub(p.revenue)}</td>
                <td>{rub(p.cost)}</td>
                <td>{p.roi != null ? `${p.roi} ₽ на 1 ₽` : '—'}</td>
                <td>{p.renewalPct != null ? `${p.renewalPct} %` : '—'}</td>
                <td>{p.canManage && p.status === 'active' && <button className="btn sm" onClick={() => setStatus(p.id, 'stopped')}>Остановить</button>}
                  {p.canManage && p.status === 'stopped' && <button className="btn sm" onClick={() => setStatus(p.id, 'active')}>Включить</button>}</td>
              </tr>);
          })}</tbody>
        </table></div>)}
    </div>
  );
}

/* ---------- Скидка в форме продажи ---------- */
export type SaleDiscountValue = { promoCode?: string; discountPercent?: number; discountRequestId?: string };
type Req = { id: string; productId: string; productName: string; percent: number; reason: string; status: string };

export function SaleDiscount({ personId, product, clubId, onChange }: { personId: string; product: { id: string; priceKop: number | null } | undefined; clubId?: string; onChange: (v: SaleDiscountValue) => void }) {
  const [mode, setMode] = useState<'none' | 'code' | 'manual' | 'request'>('none');
  const [code, setCode] = useState('');
  const [checked, setChecked] = useState<{ name: string; totalKop: number; discountKop: number } | null>(null);
  const [pct, setPct] = useState('');
  const [limit, setLimit] = useState<number | null | undefined>(undefined);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [reqId, setReqId] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const price = product?.priceKop ?? 0;
  const loadReqs = () => api<Req[]>('GET', `/api/persons/${personId}/discount-requests`).then(setReqs).catch(() => setReqs([]));
  useEffect(() => { loadReqs(); }, [personId]);
  useEffect(() => { if (clubId) api<{ percent: number | null }>('GET', `/api/promos/limit?clubId=${clubId}`).then((r) => setLimit(r.percent)).catch(() => setLimit(0)); }, [clubId]);
  useEffect(() => { setChecked(null); setErr(''); }, [product?.id]);
  useEffect(() => {
    const p = Number(pct.replace(',', '.'));
    onChange(mode === 'code' && checked ? { promoCode: code } : mode === 'manual' && p > 0 ? { discountPercent: p } : mode === 'request' && reqId ? { discountRequestId: reqId } : {});
  }, [mode, checked, code, pct, reqId]);
  if (!product) return null;
  const forProduct = reqs.filter((r) => r.productId === product.id);
  const p = Number(pct.replace(',', '.'));
  const over = mode === 'manual' && limit !== undefined && limit !== null && p > limit;
  const check = async () => {
    setErr(''); setChecked(null);
    try { setChecked(await api('POST', '/api/promos/check', { code, personId, productId: product.id })); } catch (x) { setErr(errText(x)); }
  };
  const request = async () => {
    setErr('');
    try {
      const r = await api<{ status: string; id: string }>('POST', '/api/discount-requests', { personId, productId: product.id, percent: p, reason });
      toast(r.status === 'approved' ? 'Скидка согласована' : 'Запрос на скидку отправлен на согласование. Продажу можно оформить после решения');
      await loadReqs(); setMode('request'); if (r.status === 'approved') setReqId(r.id);
    } catch (x) { setErr(errText(x)); }
  };
  const sel = forProduct.find((r) => r.id === reqId);
  const total = mode === 'code' && checked ? checked.totalKop : mode === 'manual' && p > 0 && !over ? Math.round(price * (1 - p / 100)) : mode === 'request' && sel?.status === 'approved' ? Math.round(price * (1 - sel.percent / 100)) : null;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label className="f">Скидка<select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setErr(''); }}>
        <option value="none">Без скидки</option><option value="code">Промокод или акция</option>
        <option value="manual">Ручная скидка{limit === null ? '' : limit ? ` (до ${limit} %)` : ''}</option>
        <option value="request">Согласованная скидка{forProduct.length ? ` (${forProduct.length})` : ''}</option></select></label>
      {mode === 'code' && <div className="row" style={{ gap: 6 }}>
        <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setChecked(null); }} placeholder="Промокод" aria-label="Промокод" />
        <button type="button" className="btn sm" disabled={!code.trim()} onClick={check}>Проверить</button></div>}
      {mode === 'code' && checked && <div className="small ok">Акция «{checked.name}»: скидка {rub(checked.discountKop)}</div>}
      {mode === 'manual' && <>
        <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" placeholder="Скидка, %" aria-label="Скидка, %" />
        {over && <div className="item" style={{ display: 'grid', gap: 6 }}>
          <div className="small bad">Это больше вашего лимита ({limit} %). Запросите согласование: управляющий или собственник увидит запрос в «Финансах».</div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Причина скидки" aria-label="Причина скидки" />
          <div><button type="button" className="btn sm" disabled={!reason.trim()} onClick={request}>Запросить согласование</button></div></div>}
      </>}
      {mode === 'request' && (forProduct.length === 0 ? <div className="small muted">Согласованных скидок на этот тариф нет. Выберите «Ручная скидка» и запросите согласование.</div> : (
        <select value={reqId} onChange={(e) => setReqId(e.target.value)} aria-label="Согласованная скидка">
          <option value="">— выберите —</option>
          {forProduct.map((r) => <option key={r.id} value={r.id} disabled={r.status !== 'approved'}>{r.percent} % · {r.reason}{r.status === 'pending' ? ' (ждёт решения)' : ''}</option>)}</select>))}
      {err && <div className="err">{err}</div>}
      {total !== null && <div className="small">К оплате: <s className="muted">{rub(price)}</s> <b>{rub(total)}</b></div>}
    </div>
  );
}
