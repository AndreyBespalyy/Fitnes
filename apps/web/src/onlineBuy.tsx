// Покупка онлайн без менеджера: настройка для клуба, ссылка для клиентов, последние заказы. Показывается в разделе «Сайт».
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Data = {
  settings: { enabled: boolean; maxStartDays: number; note: string | null }; canManage: boolean; link: string;
  products: { id: string; name: string; kind: string; sellOnline: boolean; priceKop: number | null }[];
  docs: { kind: string; title: string; version: number }[];
  orders: { id: string; status: string; amountKop: number; createdAt: string; paidAt: string | null; personId: string; person: string; product: string; payStatus: string; conflict: string | null }[];
  stats: { started: number; paid: number; sum: number; conversion: number | null };
};
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const ST: Record<string, [string, string]> = { paid: ['оплачено, оформлено', 'ok'], awaiting_payment: ['ждём оплату', 'warn'], expired: ['не оплачено', ''] };

export function OnlineBuyBlock({ club, openPerson }: { club: string; openPerson?: (id: string) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [edit, setEdit] = useState<{ enabled: boolean; maxStartDays: number; note: string; ids: string[] } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Data>('GET', `/api/online-buy?clubId=${club}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { if (club) load(); }, [club]);
  if (!d) return err ? <div className="err">{err}</div> : null;
  const hasOffer = d.docs.some((x) => x.kind === 'contract');
  const selling = d.products.filter((p) => p.sellOnline);
  const save = async () => {
    setErr('');
    try { await api('PUT', '/api/online-buy/settings', { clubId: club, enabled: edit!.enabled, maxStartDays: edit!.maxStartDays, note: edit!.note, productIds: edit!.ids }); toast('Сохранено'); setEdit(null); load(); } catch (x) { setErr(errText(x)); }
  };
  const copy = () => navigator.clipboard?.writeText(d.link).then(() => toast('Ссылка скопирована')).catch(() => toast(d.link));
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>Покупка онлайн без менеджера</h2>
        <span className={`chip ${d.settings.enabled ? 'ok' : ''}`}>{d.settings.enabled ? 'включена' : 'выключена'}</span>
      </div>
      <p className="small muted" style={{ margin: 0, maxWidth: 780 }}>
        Клиент открывает ссылку, выбирает тариф, принимает договор-оферту и правила, платит картой или через СБП. После оплаты система сама оформляет абонемент и договор,
        показывает клиенту QR-код для прохода и ставит менеджеру задачу поздравить и записать на вводное занятие. Пока клиент не заплатил, абонемента нет.
      </p>
      {!hasOffer && <div className="item small bad">Чтобы включить, загрузите договор-оферту клуба в разделе «Договоры» (и, желательно, правила клуба).</div>}
      {d.settings.enabled && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <code style={{ wordBreak: 'break-all' }}>{d.link}</code>
          <button className="btn sm" onClick={copy}>Скопировать ссылку</button>
          <a className="btn sm" href={d.link} target="_blank" rel="noreferrer">Открыть</a>
        </div>)}
      {d.settings.enabled && <div className="small muted">Ссылку можно поставить на сайт, в соцсети и в сообщения клиентам. Ссылка сразу на тариф: добавьте в конце <code>?p=</code> и номер тарифа.</div>}
      {!edit ? (
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="small">Продаются онлайн: {selling.length ? selling.map((p) => p.name).join(', ') : 'ничего не выбрано'}. Начало абонемента — не дальше {d.settings.maxStartDays} дн.</span>
          {d.canManage && <button className="btn sm pri" onClick={() => setEdit({ enabled: d.settings.enabled, maxStartDays: d.settings.maxStartDays, note: d.settings.note ?? '', ids: selling.map((p) => p.id) })}>Настроить</button>}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />Продавать онлайн</label>
          <span className="small muted">Какие тарифы можно купить онлайн</span>
          {d.products.map((p) => (
            <label key={p.id} className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} disabled={!p.priceKop} checked={edit.ids.includes(p.id)}
              onChange={(e) => setEdit({ ...edit, ids: e.target.checked ? [...edit.ids, p.id] : edit.ids.filter((x) => x !== p.id) })} />
              {p.name} · {p.priceKop ? rub(p.priceKop) : 'нет цены'}</label>))}
          <label className="f">Начало абонемента не позже чем через, дней<input type="number" min={0} max={90} value={edit.maxStartDays} onChange={(e) => setEdit({ ...edit, maxStartDays: Number(e.target.value) })} /></label>
          <label className="f">Текст для клиента на странице покупки (необязательно)<textarea rows={2} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          <div className="row" style={{ gap: 6 }}><button className="btn sm pri" onClick={save}>Сохранить</button><button className="btn sm" onClick={() => setEdit(null)}>Отмена</button></div>
        </div>)}
      {err && <div className="err">{err}</div>}
      {d.stats.started > 0 && (
        <div className="kpis">
          <div className="card kpi-c"><span className="lbl">Начали покупку за 30 дней</span><b className="num">{d.stats.started}</b></div>
          <div className="card kpi-c"><span className="lbl">Оплатили</span><b className="num">{d.stats.paid}</b><span className="small muted">{d.stats.conversion === null ? '' : `${d.stats.conversion} %`}</span></div>
          <div className="card kpi-c"><span className="lbl">Выручка онлайн</span><b className="num">{rub(d.stats.sum)}</b></div>
        </div>)}
      {d.orders.length > 0 && (
        <div className="tbl"><table><thead><tr><th>Когда</th><th>Клиент</th><th>Тариф</th><th>Сумма</th><th>Статус</th></tr></thead>
          <tbody>{d.orders.map((o) => {
            const [l, cls] = ST[o.status] ?? [o.status, ''];
            return <tr key={o.id}><td className="small">{dt(o.createdAt)}</td>
              <td>{openPerson ? <button className="link" onClick={() => openPerson(o.personId)}>{o.person}</button> : o.person}</td>
              <td>{o.product}</td><td>{rub(o.amountKop)}</td>
              <td><span className={`chip ${o.conflict ? 'bad' : cls}`}>{o.conflict ? 'нужна проверка' : l}</span>{o.conflict && <div className="small bad">{o.conflict}</div>}</td></tr>;
          })}</tbody></table></div>)}
    </div>
  );
}
