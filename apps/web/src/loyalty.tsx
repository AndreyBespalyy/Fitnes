// Бонусная программа: правила клуба (в «Тарифах») и блок баллов в карточке клиента.
import { useEffect, useState } from 'react';
import { api, type Club } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Level = { code: string; name: string; minMonths: number; minSpendKop: number; bonusPercent: number };
type Settings = {
  enabled: boolean; enabledAt: string | null; pointValueKop: number; visitPoints: number; purchasePercent: number; renewalPoints: number; referralPoints: number; reviewPoints: number;
  expireDays: number; spendGoods: boolean; dayPricePoints: number; personalPricePoints: number; levels: Level[]; canEdit: boolean;
  stats: { issued: number; spent: number; expired: number; outstanding: number; outstandingKop: number; members: number };
};
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const n = (x: number) => x.toLocaleString('ru-RU');

export function LoyaltySettings({ club }: { club: Club }) {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Settings>('GET', `/api/loyalty/settings?clubId=${club.id}`).then(setS).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club.id]);
  if (!s) return err ? <div className="err">{err}</div> : null;
  const ro = !s.canEdit;
  const set = (k: keyof Settings) => (v: number | boolean) => setS({ ...s, [k]: v });
  const setLevel = (i: number, k: keyof Level, v: string | number) => setS({ ...s, levels: s.levels.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const { canEdit: _c, stats: _s, enabledAt: _e, ...body } = s;
      await api('PUT', '/api/loyalty/settings', { clubId: club.id, ...body }); toast('Правила бонусной программы сохранены'); load();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const num = (label: string, k: keyof Settings, hint?: string) => (
    <label className="f">{label}<input type="number" value={s[k] as number} disabled={ro} onChange={(e) => set(k)(Number(e.target.value))} />{hint && <span className="small">{hint}</span>}</label>);
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Бонусная программа</h2>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.enabled} disabled={ro} onChange={(e) => set('enabled')(e.target.checked)} />Включена</label>
      </div>
      {s.enabled && <div className="small muted">За 30 дней начислено {n(s.stats.issued)}, потрачено {n(s.stats.spent)}, сгорело {n(s.stats.expired)} баллов. На счетах клиентов {n(s.stats.outstanding)} баллов — это {rub(s.stats.outstandingKop)} возможных скидок, участников {s.stats.members}.</div>}
      <div className="grid3">
        {num('Цена 1 балла при трате, коп.', 'pointValueKop', '100 коп. — 1 балл = 1 ₽')}
        {num('Баллов за посещение', 'visitPoints')}
        {num('Баллов с покупки, % от суммы', 'purchasePercent', 'Пополнение депозита и сертификаты не считаются')}
        {num('Баллов за продление', 'renewalPoints', 'Когда продление оплачено')}
        {num('Баллов за рекомендацию друга', 'referralPoints', 'Когда друг купил абонемент')}
        {num('Баллов за отзыв', 'reviewPoints', 'За ответ на опрос с комментарием')}
        {num('Срок жизни баллов, дней', 'expireDays', 'Сначала сгорают самые старые')}
        {num('Цена 1 дня абонемента, баллов', 'dayPricePoints')}
        {num('Цена персональной тренировки, баллов', 'personalPricePoints')}
      </div>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.spendGoods} disabled={ro} onChange={(e) => set('spendGoods')(e.target.checked)} />Можно оплачивать баллами товары и услуги на ресепшне</label>
      <b>Уровни клиента</b>
      <div className="tbl"><table>
        <thead><tr><th>Название</th><th>Стаж, мес.</th><th>или покупок на, ₽</th><th>Надбавка к баллам за визиты и покупки, %</th>{!ro && <th />}</tr></thead>
        <tbody>{s.levels.map((l, i) => (
          <tr key={i}>
            <td><input value={l.name} disabled={ro} onChange={(e) => setLevel(i, 'name', e.target.value)} aria-label="Название уровня" /></td>
            <td><input type="number" value={l.minMonths} disabled={ro || i === 0} onChange={(e) => setLevel(i, 'minMonths', Number(e.target.value))} aria-label="Стаж" /></td>
            <td><input type="number" value={Math.round(l.minSpendKop / 100)} disabled={ro || i === 0} onChange={(e) => setLevel(i, 'minSpendKop', Number(e.target.value) * 100)} aria-label="Сумма покупок" /></td>
            <td><input type="number" value={l.bonusPercent} disabled={ro} onChange={(e) => setLevel(i, 'bonusPercent', Number(e.target.value))} aria-label="Надбавка" /></td>
            {!ro && <td>{i > 0 && <button className="btn sm" onClick={() => setS({ ...s, levels: s.levels.filter((_, j) => j !== i) })}>Убрать</button>}</td>}
          </tr>))}</tbody></table></div>
      {!ro && s.levels.length < 6 && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setS({ ...s, levels: [...s.levels, { code: `l${Date.now()}`, name: 'Новый уровень', minMonths: 24, minSpendKop: 10000000, bonusPercent: 75 }] })}>Добавить уровень</button>}
      <span className="small muted">Уровень даётся, если выполнено любое из условий: стаж с первой покупки или сумма покупок за всё время. Баллы начисляются только за события после включения программы.</span>
      {err && <div className="err">{err}</div>}
      {!ro && <button className="btn pri" style={{ justifySelf: 'start' }} disabled={busy} onClick={save}>Сохранить</button>}
    </div>
  );
}

type PersonL = { enabled: false } | {
  enabled: true; balance: number; valueKop: number; level: Level; next: Level | null; months: number; spentKop: number; expiringSoon: number; pointValueKop: number;
  dayPricePoints: number; personalPricePoints: number; spendGoods: boolean; canSpend: boolean; canAdjust: boolean;
  moves: { id: string; kind: string; title: string; points: number; comment: string | null; at: string; expiresOn: string | null; by: string | null }[];
  memberships: { id: string; name: string; kind: string; endsOn: string | null; visitsLeft: number | null }[];
};

export function LoyaltyBlock({ personId, clubId }: { personId: string; clubId: string | null }) {
  const [d, setD] = useState<PersonL | null>(null);
  const [err, setErr] = useState('');
  const [spend, setSpend] = useState<{ kind: 'days' | 'personal'; membershipId: string; qty: number } | null>(null);
  const [adj, setAdj] = useState<{ points: number; comment: string } | null>(null);
  const [all, setAll] = useState(false);
  const load = () => clubId && api<PersonL>('GET', `/api/persons/${personId}/loyalty?clubId=${clubId}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [personId, clubId]);
  if (!d || !d.enabled) return err ? <div className="err">{err}</div> : null;
  const cost = spend ? spend.qty * (spend.kind === 'days' ? d.dayPricePoints : d.personalPricePoints) : 0;
  const doSpend = async () => {
    if (!spend) return; setErr('');
    try { await api('POST', `/api/persons/${personId}/loyalty/spend`, { clubId, ...spend }); toast(spend.kind === 'days' ? `Добавлено дней: ${spend.qty}` : `Добавлено тренировок: ${spend.qty}`); setSpend(null); load(); } catch (x) { setErr(errText(x)); }
  };
  const doAdj = async () => {
    if (!adj) return; setErr('');
    try { await api('POST', `/api/persons/${personId}/loyalty/adjust`, { clubId, ...adj }); toast('Баллы скорректированы'); setAdj(null); load(); } catch (x) { setErr(errText(x)); }
  };
  const daysM = d.memberships.filter((m) => m.kind !== 'personal' && m.endsOn);
  const persM = d.memberships.filter((m) => m.kind === 'personal');
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
        <h2 style={{ margin: 0 }}>Баллы</h2>
        <span className="chip acc">{d.level.name}{d.level.bonusPercent ? ` · +${d.level.bonusPercent} %` : ''}</span>
      </div>
      <div className="row" style={{ gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 26 }}>{n(d.balance)}</b><span className="muted">баллов ≈ {rub(d.valueKop)}</span>
        {d.expiringSoon > 0 && <span className="small bad">{n(d.expiringSoon)} сгорят в ближайшие 30 дней</span>}
      </div>
      {d.next && <span className="small muted">До уровня «{d.next.name}»: стаж {d.months} из {d.next.minMonths} мес. или покупки {rub(d.spentKop)} из {rub(d.next.minSpendKop)}.</span>}
      {d.canSpend && !spend && !adj && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {daysM.length > 0 && <button className="btn sm" disabled={d.balance < d.dayPricePoints} onClick={() => setSpend({ kind: 'days', membershipId: daysM[0].id, qty: 1 })}>Дни абонемента ({d.dayPricePoints} за день)</button>}
          {persM.length > 0 && <button className="btn sm" disabled={d.balance < d.personalPricePoints} onClick={() => setSpend({ kind: 'personal', membershipId: persM[0].id, qty: 1 })}>Персональная ({n(d.personalPricePoints)})</button>}
          {d.canAdjust && <button className="btn sm" onClick={() => setAdj({ points: 0, comment: '' })}>Корректировка</button>}
        </div>)}
      {d.spendGoods && <span className="small muted">Товары и услуги баллами — в «Магазине» и на «Ресепшне», кнопка «Баллами».</span>}
      {spend && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="f">{spend.kind === 'days' ? 'Абонемент' : 'Пакет'}<select value={spend.membershipId} onChange={(e) => setSpend({ ...spend, membershipId: e.target.value })}>
            {(spend.kind === 'days' ? daysM : persM).map((m) => <option key={m.id} value={m.id}>{m.name}{m.endsOn ? ` до ${m.endsOn.split('-').reverse().join('.')}` : ''}</option>)}</select></label>
          <label className="f" style={{ width: 110 }}>{spend.kind === 'days' ? 'Дней' : 'Тренировок'}<input type="number" min={1} value={spend.qty} onChange={(e) => setSpend({ ...spend, qty: Math.max(1, Number(e.target.value)) })} /></label>
          <button className="btn pri" disabled={cost > d.balance} onClick={doSpend}>Списать {n(cost)} баллов</button>
          <button className="btn" onClick={() => setSpend(null)}>Отмена</button>
        </div>)}
      {adj && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="f" style={{ width: 130 }}>Баллы (+/−)<input type="number" value={adj.points} onChange={(e) => setAdj({ ...adj, points: Number(e.target.value) })} /></label>
          <label className="f" style={{ flex: 1, minWidth: 180 }}>Причина<input value={adj.comment} onChange={(e) => setAdj({ ...adj, comment: e.target.value })} /></label>
          <button className="btn pri" disabled={!adj.points || !adj.comment.trim()} onClick={doAdj}>Сохранить</button>
          <button className="btn" onClick={() => setAdj(null)}>Отмена</button>
        </div>)}
      {err && <div className="err">{err}</div>}
      {d.moves.length > 0 && (
        <div style={{ display: 'grid', gap: 2 }}>
          {(all ? d.moves : d.moves.slice(0, 5)).map((m) => (
            <div key={m.id} className="row between small" style={{ gap: 8 }}>
              <span>{dt(m.at)} · {m.title}{m.comment ? `: ${m.comment}` : ''}{m.by ? ` (${m.by})` : ''}</span>
              <b className={m.points < 0 ? 'bad' : ''}>{m.points > 0 ? '+' : '−'}{n(Math.abs(m.points))}</b>
            </div>))}
          {d.moves.length > 5 && <button className="link small" style={{ justifySelf: 'start' }} onClick={() => setAll(!all)}>{all ? 'Свернуть' : 'Вся история'}</button>}
        </div>)}
    </div>
  );
}
