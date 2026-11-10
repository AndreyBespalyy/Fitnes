// Шаг 6. Раздел «Тарифы» (настройки клуба, тарифы и цены) и абонементы в карточке клиента.
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { PayLinkButton } from './payments.tsx';
import { api, can, type Club, type Me } from './api.ts';
import { errText, toast } from './ui.ts';
import { ContractLine, type ContractBrief } from './contracts.tsx';
import { RefundForm } from './finance.tsx';

export type Settings = {
  freezeEnabled: boolean; freezeMaxDaysPerYear: number; freezeMaxTimesPerYear: number; freezeMinDays: number; freezePaid: boolean; freezePriceKop: number;
  installmentsEnabled: boolean; installmentsMaxPayments: number; overdueBlockAfterDays: number;
  subscriptionRetryAttempts: number; subscriptionRetryIntervalDays: number; renewalReminderDays: number; contractRequiredForAccess: boolean;
};
export type Product = { id: string; clubId: string; kind: string; name: string; durationDays: number | null; visitsCount: number | null; validityDays: number | null;
  freezeAllowed: boolean; installmentsAllowed: boolean; isActive: boolean; priceKop: number | null;
  networkAccess: boolean; accessFrom: string | null; accessTo: string | null; prices: { amountKop: number; validFrom: string }[] };
type Charge = { id: string; kind: string; title: string; dueOn: string; amountKop: number; status: string; paidMethod: string | null; overdue: boolean };
type Membership = { id: string; clubId: string; clubName: string; kind: string; productName: string; amountKop: number; startsOn: string; endsOn: string | null;
  visitsLeft: number | null; installments: number; nextChargeOn: string | null; status: string; state: string; access: boolean; reason: string; freezeAllowed: boolean;
  freezes: { id: string; startsOn: string; endsOn: string; endedEarlyOn: string | null; days: number }[]; charges: Charge[]; contract: ContractBrief | null };

export const KIND: Record<string, string> = { term: 'Абонемент на срок', subscription: 'Подписка', visits: 'Пакет посещений', personal: 'Персональные', guest: 'Гостевой' };
const STATE: Record<string, [string, string]> = {
  active: ['действует', 'ok'], debt_grace: ['долг', 'warn'], debt_blocked: ['проход закрыт: долг', 'bad'], frozen: ['заморожен', 'acc'],
  unsigned: ['проход закрыт: нет подписи', 'bad'], not_started: ['ещё не начался', ''], expired: ['закончился', ''], used_up: ['посещения закончились', ''], cancelled: ['расторгнут', 'bad'],
};
const PAY: Record<string, string> = { online: 'онлайн',  cash: 'наличные', card_terminal: 'карта (терминал)', sbp: 'СБП' };
export const rub = (kop: number | null | undefined) => (kop === null || kop === undefined ? '—' : `${(kop / 100).toLocaleString('ru-RU')} ₽`);
const d = (s: string | null) => (s ? s.split('-').reverse().join('.') : '—');
const toKop = (s: string) => Math.round(Number(s.replace(',', '.').replace(/\s/g, '')) * 100);

/* ---------------- Тарифы ---------------- */
export function TariffsPage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const c = clubs.find((x) => x.id === club);
  const manage = can(me, 'tariffs.manage');
  if (!c) return <p className="muted">Клубов нет.</p>;
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Тарифы и правила задаются для каждого клуба отдельно. {manage ? (me.allClubs ? 'Вы меняете их во всех клубах сети.' : 'Вы меняете их в своём клубе.') : 'Изменять их могут собственник и управляющий клуба.'}
        </p>
        {clubId === 'all' && (
          <select aria-label="Клуб" value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>
            {clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>)}
      </div>
      <SettingsForm key={`s${club}`} club={c} manage={manage} />
      <Products key={`p${club}`} club={c} manage={manage} />
    </>
  );
}

function Num({ label, value, onChange, disabled, hint }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean; hint?: string }) {
  return <label className="f">{label}<input type="number" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />{hint && <span className="small">{hint}</span>}</label>;
}
function Check({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

function SettingsForm({ club, manage }: { club: Club; manage: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Settings>('GET', `/api/clubs/${club.id}/membership-settings`).then(setS).catch((x) => setErr(errText(x))); }, [club.id]);
  if (!s) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => setS({ ...s, [k]: v });
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { setS(await api<Settings>('PUT', `/api/clubs/${club.id}/membership-settings`, s)); toast(`Правила клуба «${club.name}» сохранены`); } catch (x) { setErr(errText(x)); }
  };
  const ro = !manage;
  const sub = club.salesModel === 'subscription';
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 14 }}>
      <h2>Правила клуба</h2>
      {err && <div className="err">{err}</div>}
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
        <fieldset className="item" style={{ display: 'grid', gap: 8 }}><b>Заморозка</b>
          <Check label="Разрешить заморозку абонементов" value={s.freezeEnabled} onChange={set('freezeEnabled')} disabled={ro} />
          <Num label="Дней в год, не больше" value={s.freezeMaxDaysPerYear} onChange={set('freezeMaxDaysPerYear')} disabled={ro || !s.freezeEnabled} />
          <Num label="Раз в год, не больше" value={s.freezeMaxTimesPerYear} onChange={set('freezeMaxTimesPerYear')} disabled={ro || !s.freezeEnabled} />
          <Num label="Минимальный срок, дней" value={s.freezeMinDays} onChange={set('freezeMinDays')} disabled={ro || !s.freezeEnabled} />
          <Check label="Заморозка платная" value={s.freezePaid} onChange={set('freezePaid')} disabled={ro || !s.freezeEnabled} />
          {s.freezePaid && <label className="f">Цена заморозки, ₽<input inputMode="decimal" defaultValue={s.freezePriceKop / 100} disabled={ro} onChange={(e) => set('freezePriceKop')(toKop(e.target.value) || 0)} /></label>}
        </fieldset>
        <fieldset className="item" style={{ display: 'grid', gap: 8 }}><b>Рассрочка и долги</b>
          <Check label="Разрешить рассрочку" value={s.installmentsEnabled} onChange={set('installmentsEnabled')} disabled={ro} />
          <Num label="Платежей в рассрочке, не больше" value={s.installmentsMaxPayments} onChange={set('installmentsMaxPayments')} disabled={ro || !s.installmentsEnabled} hint="Платежи раз в месяц, первый в день покупки" />
          <Num label="Закрыть проход при просрочке больше, дней" value={s.overdueBlockAfterDays} onChange={set('overdueBlockAfterDays')} disabled={ro} hint="0 — закрыть на следующий день после срока платежа" />
          <Num label="Напомнить о продлении за, дней" value={s.renewalReminderDays} onChange={set('renewalReminderDays')} disabled={ro} />
          <Check label="Не пускать в клуб без подписанного договора" value={s.contractRequiredForAccess} onChange={set('contractRequiredForAccess')} disabled={ro} />
        </fieldset>
        {sub && (
          <fieldset className="item" style={{ display: 'grid', gap: 8 }}><b>Подписка</b>
            <Num label="Повторных попыток списания" value={s.subscriptionRetryAttempts} onChange={set('subscriptionRetryAttempts')} disabled={ro} />
            <Num label="Интервал между попытками, дней" value={s.subscriptionRetryIntervalDays} onChange={set('subscriptionRetryIntervalDays')} disabled={ro} hint="Автосписание заработает с подключением эквайринга" />
          </fieldset>)}
      </div>
      {manage && <div><button className="btn pri">Сохранить правила</button></div>}
    </form>
  );
}

function Products({ club, manage }: { club: Club; manage: boolean }) {
  const [list, setList] = useState<Product[]>([]);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [hist, setHist] = useState<string | null>(null);
  const kinds = club.salesModel === 'term' ? ['term', 'visits', 'personal', 'guest'] : ['subscription', 'visits', 'personal', 'guest'];
  const [f, setF] = useState({ kind: kinds[0], name: '', price: '', durationDays: 30, visitsCount: 10, validityDays: 60, installmentsAllowed: false, freezeAllowed: true, networkAccess: false, accessFrom: '', accessTo: '' });
  const reload = () => api<Product[]>('GET', `/api/products?clubId=${club.id}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [club.id]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); toast(ok); reload(); return true; } catch (x) { setErr(errText(x)); return false; } };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const done = await act(() => api('POST', '/api/products', {
      clubId: club.id, kind: f.kind, name: f.name, priceKop: toKop(f.price),
      durationDays: f.kind === 'term' ? f.durationDays : undefined,
      visitsCount: ['visits', 'personal'].includes(f.kind) ? f.visitsCount : undefined,
      validityDays: ['visits', 'personal', 'guest'].includes(f.kind) ? f.validityDays : undefined,
      installmentsAllowed: f.installmentsAllowed, freezeAllowed: f.kind === 'term' ? f.freezeAllowed : false,
      networkAccess: f.networkAccess, accessFrom: f.accessFrom || null, accessTo: f.accessTo || null,
    }), `Тариф «${f.name}» добавлен`);
    if (done) setF({ ...f, name: '', price: '' });
  };
  const base = (p: Product) => p.kind === 'term' ? `${p.durationDays} дн.` : p.kind === 'subscription' ? 'в месяц' : p.visitsCount ? `${p.visitsCount} зан., ${p.validityDays ?? 90} дн.` : `${p.validityDays ?? 1} дн.`;
  const terms = (p: Product) => [base(p), p.accessFrom || p.accessTo ? `проход ${p.accessFrom ? `с ${p.accessFrom} ` : ''}${p.accessTo ? `до ${p.accessTo}` : ''}`.trim() : '', p.networkAccess ? 'все клубы сети' : ''].filter(Boolean).join(', ');
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2>Тарифы клуба</h2>
      <p className="small" style={{ margin: 0 }}>Новая цена действует только для новых продаж: проданные абонементы сохраняют цену и условия на день покупки.</p>
      {err && <div className="err">{err}</div>}
      <div className="tbl"><table>
        <thead><tr><th>Тариф</th><th>Тип</th><th>Условия</th><th>Цена</th><th>Заморозка</th><th>Рассрочка</th><th>Статус</th>{manage && <th />}</tr></thead>
        <tbody>{list.map((p) => (<Fragment key={p.id}>
          <tr>
            <td><b>{p.name}</b></td><td>{KIND[p.kind]}</td><td>{terms(p)}</td>
            <td className="num">{edit === p.id
              ? <span className="row"><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 110 }} aria-label="Новая цена, ₽" />
                  <button className="btn sm pri" onClick={async () => { if (await act(() => api('PATCH', `/api/products/${p.id}`, { priceKop: toKop(price) }), `Новая цена «${p.name}»: ${price} ₽`)) setEdit(null); }}>OK</button>
                  <button className="btn sm" onClick={() => setEdit(null)}>×</button></span>
              : <button className="btn sm" onClick={() => setHist(hist === p.id ? null : p.id)} title="История цен">{rub(p.priceKop)}</button>}</td>
            <td>{p.freezeAllowed ? 'да' : '—'}</td><td>{p.installmentsAllowed ? 'да' : '—'}</td>
            <td><span className={`chip ${p.isActive ? 'ok' : ''}`}>{p.isActive ? 'в продаже' : 'снят'}</span></td>
            {manage && <td className="row">
              <button className="btn sm" onClick={() => { setEdit(p.id); setPrice(String((p.priceKop ?? 0) / 100)); }}>Цена</button>
              <button className="btn sm" onClick={() => act(() => api('PATCH', `/api/products/${p.id}`, { isActive: !p.isActive }), p.isActive ? 'Тариф снят с продажи' : 'Тариф снова в продаже')}>{p.isActive ? 'Снять' : 'Вернуть'}</button>
            </td>}
          </tr>
          {hist === p.id && <tr><td colSpan={8} className="small">История цен: {p.prices.map((v) => `${rub(v.amountKop)} с ${new Date(v.validFrom).toLocaleDateString('ru-RU')}`).join(' · ')}</td></tr>}
        </Fragment>))}</tbody>
      </table></div>
      {manage && (
        <form onSubmit={add} className="item" style={{ display: 'grid', gap: 8 }}>
          <b>Новый тариф</b>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <label className="f">Тип<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></label>
            <label className="f">Название<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="3 месяца безлимит" /></label>
            <label className="f">Цена, ₽{f.kind === 'subscription' ? ' в месяц' : ''}<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
            {f.kind === 'term' && <Num label="Срок, дней" value={f.durationDays} onChange={(v) => setF({ ...f, durationDays: v })} />}
            {['visits', 'personal'].includes(f.kind) && <Num label="Занятий" value={f.visitsCount} onChange={(v) => setF({ ...f, visitsCount: v })} />}
            {['visits', 'personal', 'guest'].includes(f.kind) && <Num label="Действует, дней" value={f.validityDays} onChange={(v) => setF({ ...f, validityDays: v })} />}
          </div>
          <div className="row">
            {f.kind === 'term' && <Check label="Можно заморозить" value={f.freezeAllowed} onChange={(v) => setF({ ...f, freezeAllowed: v })} />}
            {f.kind !== 'subscription' && <Check label="Можно в рассрочку" value={f.installmentsAllowed} onChange={(v) => setF({ ...f, installmentsAllowed: v })} />}
            {f.kind !== 'personal' && <Check label="Проход во все клубы сети" value={f.networkAccess} onChange={(v) => setF({ ...f, networkAccess: v })} />}
          </div>
          {f.kind !== 'personal' && <div className="row small">Проход по тарифу: с <input type="time" value={f.accessFrom} onChange={(e) => setF({ ...f, accessFrom: e.target.value })} style={{ width: 'auto' }} />
            до <input type="time" value={f.accessTo} onChange={(e) => setF({ ...f, accessTo: e.target.value })} style={{ width: 'auto' }} /> (пусто — в любое время работы клуба)</div>}
          <div><button className="btn pri" disabled={!f.name.trim() || !f.price}>Добавить тариф</button></div>
        </form>)}
    </div>
  );
}

/* ---------------- Абонементы в карточке клиента ---------------- */
export function MembershipsBlock({ me, personId, homeClubId }: { me: Me; personId: string; homeClubId: string | null }) {
  const [ms, setMs] = useState<Membership[] | null>(null);
  const [err, setErr] = useState('');
  const [sell, setSell] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [inst, setInst] = useState(1);
  const [maxInst, setMaxInst] = useState(1);
  const [freeze, setFreeze] = useState<{ id: string; days: number; startsOn: string } | null>(null);
  const [cancel, setCancel] = useState<{ id: string; reason: string } | null>(null);
  const [refund, setRefund] = useState<string | null>(null);
  const reload = () => api<Membership[]>('GET', `/api/persons/${personId}/memberships`).then(setMs).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [personId]);
  const canSell = can(me, 'memberships.sell');
  const canManage = can(me, 'memberships.manage');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setErr('');
    try { await fn(); toast(ok); setFreeze(null); setCancel(null); setSell(false); reload(); } catch (x) { setErr(errText(x)); }
  };
  const openSell = async () => {
    setSell(true);
    const all = await api<Product[]>('GET', `/api/products?active=1${homeClubId ? `&clubId=${homeClubId}` : ''}`).catch(() => []);
    setProducts(all.length ? all : await api<Product[]>('GET', '/api/products?active=1').catch(() => []));
    setProductId(''); setInst(1);
  };
  const prod = products.find((p) => p.id === productId);
  if (!can(me, 'memberships.view')) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>Абонементы и подписки</h2>{canSell && !sell && <button className="btn sm pri" onClick={openSell}>+ Продать</button>}</div>
      {err && <div className="err">{err}</div>}
      {sell && (
        <div className="item" style={{ display: 'grid', gap: 8 }}>
          <label className="f">Тариф<select value={productId} onChange={(e) => {
            const v = e.target.value; setProductId(v); setInst(1);
            const p = products.find((x) => x.id === v);
            if (p?.installmentsAllowed) api<Settings>('GET', `/api/clubs/${p.clubId}/membership-settings`).then((st) => setMaxInst(st.installmentsEnabled ? st.installmentsMaxPayments : 1)).catch(() => setMaxInst(1));
          }}>
            <option value="">— выберите —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {rub(p.priceKop)}</option>)}</select></label>
          {prod?.installmentsAllowed && maxInst > 1 && (
            <label className="f">Оплата<select value={inst} onChange={(e) => setInst(Number(e.target.value))}>
              {Array.from({ length: maxInst }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? 'Сразу полностью' : `Рассрочка: ${n} ${n < 5 ? 'платежа' : 'платежей'} по ${rub(Math.floor((prod.priceKop ?? 0) / n))}`}</option>)}</select></label>)}
          <div className="row">
            <button className="btn pri sm" disabled={!productId} onClick={() => act(() => api('POST', '/api/memberships', { personId, productId, installments: inst }), `Продано: ${prod?.name}. Платёж ждёт оплаты`)}>Оформить</button>
            <button className="btn sm" onClick={() => setSell(false)}>Отмена</button>
          </div>
        </div>)}
      {ms === null ? <p className="muted" style={{ margin: 0 }}>Загрузка…</p> : ms.length === 0 ? <p className="muted" style={{ margin: 0 }}>Абонементов нет.</p> : ms.map((m) => {
        const [label, cls] = STATE[m.state] ?? [m.state, ''];
        const activeFreeze = m.freezes.find((f) => !f.endedEarlyOn && f.endsOn >= today);
        return (
          <div key={m.id} className={`item ${m.state === 'debt_blocked' ? 'over' : ''}`} style={{ display: 'grid', gap: 6 }}>
            <div className="row between"><b>{m.productName}</b><span className={`chip ${cls}`}>{label}</span></div>
            <div className="small">{m.clubName} · {rub(m.amountKop)}{m.kind === 'subscription' ? ' в месяц' : ''} · {d(m.startsOn)} — {d(m.endsOn)}
              {m.visitsLeft !== null ? ` · осталось занятий: ${m.visitsLeft}` : ''}{m.nextChargeOn ? ` · следующее списание ${d(m.nextChargeOn)}` : ''}</div>
            <div className={`small ${m.access ? '' : 'bad'}`}>{m.access ? 'Проход открыт' : 'Проход закрыт'}: {m.reason}</div>
            {m.freezes.length > 0 && <div className="small">Заморозки: {m.freezes.map((f) => `${d(f.startsOn)} — ${d(f.endedEarlyOn ?? f.endsOn)}${f.endedEarlyOn ? ' (досрочно)' : ''}`).join(', ')}</div>}
            {m.charges.length > 0 && (
              <div className="list">{m.charges.map((c) => (
                <div key={c.id} className="row between small">
                  <span>{d(c.dueOn)} · {c.title} · <b>{rub(c.amountKop)}</b></span>
                  {c.status === 'paid' ? <span className="chip ok">оплачен{c.paidMethod ? `, ${PAY[c.paidMethod] ?? c.paidMethod}` : ''}</span>
                    : c.status === 'cancelled' ? <span className="chip">отменён</span>
                    : <span className="row"><span className={`chip ${c.overdue ? 'bad' : 'warn'}`}>{c.overdue ? 'просрочен' : 'к оплате'}</span>
                      {canManage && <><button className="btn sm" onClick={() => act(() => api('POST', `/api/charges/${c.id}/mark-paid`, { method: 'card_terminal' }), 'Оплата картой отмечена')}>Картой</button>
                        <button className="btn sm" onClick={() => act(() => api('POST', `/api/charges/${c.id}/mark-paid`, { method: 'cash' }), 'Оплата наличными отмечена')}>Наличными</button></>}
                      {can(me, 'memberships.sell') && <PayLinkButton chargeId={c.id} />}</span>}
                </div>))}</div>)}
            {m.contract && <ContractLine me={me} c={m.contract} reload={reload} />}
            {m.status === 'active' && (
              <div className="row">
                {canSell && ['active', 'expired', 'used_up', 'debt_grace'].includes(m.state) && m.kind !== 'subscription' &&
                  <button className="btn sm" onClick={() => act(() => api('POST', `/api/memberships/${m.id}/renew`, {}), 'Продление оформлено с даты окончания текущего')}>Продлить</button>}
                {canManage && m.freezeAllowed && !activeFreeze && m.state !== 'expired' && <button className="btn sm" onClick={() => setFreeze({ id: m.id, days: 14, startsOn: today })}>Заморозить</button>}
                {canManage && activeFreeze && <button className="btn sm" onClick={() => act(() => api('POST', `/api/memberships/${m.id}/unfreeze`), 'Заморозка снята, неиспользованные дни возвращены')}>Разморозить</button>}
                {canManage && <button className="btn sm" onClick={() => setCancel({ id: m.id, reason: '' })}>Расторгнуть</button>}
                {canManage && m.charges.some((c) => c.status === 'paid') && <button className="btn sm" onClick={() => setRefund(m.id)}>Возврат денег</button>}
              </div>)}
            {freeze?.id === m.id && (
              <div className="row">
                <label className="f">С<input type="date" value={freeze.startsOn} onChange={(e) => setFreeze({ ...freeze, startsOn: e.target.value })} /></label>
                <label className="f">Дней<input type="number" value={freeze.days} onChange={(e) => setFreeze({ ...freeze, days: Number(e.target.value) })} style={{ width: 80 }} /></label>
                <button className="btn pri sm" onClick={() => act(() => api('POST', `/api/memberships/${m.id}/freeze`, { startsOn: freeze.startsOn, days: freeze.days }), `Заморозка на ${freeze.days} дн., окончание сдвинуто`)}>Заморозить</button>
                <button className="btn sm" onClick={() => setFreeze(null)}>Отмена</button>
              </div>)}
            {refund === m.id && <RefundForm membershipId={m.id} onCancel={() => setRefund(null)} onDone={(msg) => { setRefund(null); toast(msg); reload(); }} />}
            {cancel?.id === m.id && (
              <div className="row">
                <input value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} placeholder="Причина расторжения" aria-label="Причина расторжения" />
                <button className="btn sm" disabled={!cancel.reason.trim()} onClick={() => act(() => api('POST', `/api/memberships/${m.id}/cancel`, { reason: cancel.reason }), 'Абонемент расторгнут')}>Расторгнуть</button>
                <button className="btn sm" onClick={() => setCancel(null)}>Отмена</button>
              </div>)}
          </div>);
      })}
    </div>
  );
}
