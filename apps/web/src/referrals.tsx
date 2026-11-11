// «Приведи друга»: блок в карточке клиента и отчёт в разделе «Возврат клиентов».
import { useEffect, useState } from 'react';
import { api, can, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Card = { code: string; link: string; invited: { id: string; friendId: string; name: string; status: string; createdAt: string; rewardDays: number | null; clubName: string }[];
  invitedBy: { referrerId: string; name: string; status: string } | null };
const ST: Record<string, [string, string]> = { lead: ['заявка', 'acc'], bought: ['купил', 'ok'], rewarded: ['купил, бонус начислен', 'ok'], reward_manual: ['купил, бонус вручную', 'warn'] };
const rub = (k: number | null) => (k == null ? '—' : `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`);

export function ReferralBlock({ me, personId, clubId, openPerson }: { me: Me; personId: string; clubId: string | null; openPerson?: (id: string) => void }) {
  const [c, setC] = useState<Card | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const load = () => api<Card>('GET', `/api/persons/${personId}/referral`).then(setC).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [personId]);
  if (!c) return err ? <div className="card err">{err}</div> : null;
  const copy = () => navigator.clipboard?.writeText(c.link).then(() => toast('Ссылка скопирована')).catch(() => toast(c.link));
  const send = async () => { setErr(''); try { await api('POST', `/api/persons/${personId}/referral/send`, { clubId }); toast('Ссылка отправлена клиенту'); } catch (x) { setErr(errText(x)); } };
  const attach = async () => {
    setErr('');
    try { const r = await api<{ referrerName: string }>('POST', '/api/referrals/attach', { friendId: personId, code, clubId }); toast(`Отмечено: привёл(а) ${r.referrerName}`); setCode(''); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Приведи друга</h2>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span>Код клиента: <b style={{ letterSpacing: '.08em' }}>{c.code}</b></span>
        <button className="btn sm" onClick={copy}>Скопировать ссылку</button>
        {clubId && can(me, 'crm.work') && <button className="btn sm" onClick={send}>Отправить ссылку в мессенджер</button>}
      </div>
      {c.invitedBy ? <div className="small">Пришёл по рекомендации: {openPerson ? <button className="link" onClick={() => openPerson(c.invitedBy!.referrerId)}>{c.invitedBy.name}</button> : c.invitedBy.name}</div>
        : clubId && can(me, 'leads.create') && (
          <div className="row" style={{ gap: 6 }}>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Код друга, если клиента пригласили" aria-label="Код приглашения" style={{ maxWidth: 260 }} />
            <button className="btn sm" disabled={code.trim().length < 4} onClick={attach}>Отметить</button>
          </div>)}
      {c.invited.length > 0 && (
        <div className="list">{c.invited.map((x) => {
          const [l, cls] = ST[x.status] ?? [x.status, ''];
          return <div key={x.id} className="row between small"><span>{openPerson ? <button className="link" onClick={() => openPerson(x.friendId)}>{x.name}</button> : x.name} · {dt(x.createdAt)}</span>
            <span className={`chip ${cls}`}>{l}{x.rewardDays ? ` +${x.rewardDays} дн.` : ''}</span></div>;
        })}</div>)}
    </div>
  );
}

type Report = {
  settings: { enabled: boolean; friendPercent: number; referrerDays: number }; canManage: boolean;
  top: { personId: string; name: string; invited: number; bought: number; revenue: number; days: number }[];
  recent: { id: string; friendId: string; friend: string; referrerId: string; referrer: string; status: string; via: string; createdAt: string; revenue: number | null }[];
  stats: { invited: number; bought: number; revenue: number; discounts: number; manual: number; conversion: number | null };
};

export function ReferralsView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [d, setD] = useState<Report | null>(null);
  const [edit, setEdit] = useState<Report['settings'] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Report>('GET', `/api/referrals?clubId=${club}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const save = async () => { setErr(''); try { await api('PUT', '/api/referrals/settings', { clubId: club, ...edit }); toast('Сохранено'); setEdit(null); load(); } catch (x) { setErr(errText(x)); } };
  const s = d.stats;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0, maxWidth: 780 }}>
        У каждого клиента есть код и ссылка для друзей (в карточке клиента, блок «Приведи друга»). Друг по ссылке оставляет заявку — она приходит в «Лиды» с источником «Рекомендация».
        Первая покупка друга идёт со скидкой {d.settings.friendPercent} %, а тому, кто привёл, добавляется {d.settings.referrerDays} дн. к абонементу.
        {!d.settings.enabled && <b> Программа в клубе выключена.</b>}
      </p>
      {err && <div className="err">{err}</div>}
      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Приглашено за 90 дней</span><b className="num">{s.invited}</b></div>
        <div className="card kpi-c"><span className="lbl">Купили</span><b className="num">{s.bought}</b><span className="small muted">{s.conversion === null ? '' : `конверсия ${s.conversion} %`}</span></div>
        <div className="card kpi-c"><span className="lbl">Выручка от друзей</span><b className="num">{rub(s.revenue)}</b><span className="small muted">скидки друзьям {rub(s.discounts)}</span></div>
        <div className="card kpi-c"><span className="lbl">Бонус вручную</span><b className={`num ${s.manual ? 'bad' : ''}`}>{s.manual}</b><span className="small muted">нет срочного абонемента</span></div>
      </div>
      <div className="card">
        <h2>Лучшие амбассадоры</h2>
        {d.top.length === 0 ? <p className="muted" style={{ margin: 0 }}>Пока никто никого не привёл.</p> : (
          <div className="tbl"><table><thead><tr><th>Клиент</th><th>Привёл</th><th>Купили</th><th>Выручка</th><th>Бонус, дней</th></tr></thead>
            <tbody>{d.top.map((x) => <tr key={x.personId}><td><button className="link" onClick={() => openPerson(x.personId)}>{x.name}</button></td><td>{x.invited}</td><td>{x.bought}</td><td>{rub(x.revenue)}</td><td>{x.days}</td></tr>)}</tbody></table></div>)}
      </div>
      <div className="card">
        <h2>Последние рекомендации</h2>
        {d.recent.length === 0 ? <p className="muted" style={{ margin: 0 }}>Пока нет.</p> : (
          <div className="tbl"><table><thead><tr><th>Друг</th><th>Кто привёл</th><th>Как</th><th>Когда</th><th>Статус</th></tr></thead>
            <tbody>{d.recent.map((x) => {
              const [l, cls] = ST[x.status] ?? [x.status, ''];
              return <tr key={x.id}><td><button className="link" onClick={() => openPerson(x.friendId)}>{x.friend}</button></td><td><button className="link" onClick={() => openPerson(x.referrerId)}>{x.referrer}</button></td>
                <td className="small">{x.via === 'link' ? 'по ссылке' : 'назвал код'}</td><td className="small">{dt(x.createdAt)}</td><td><span className={`chip ${cls}`}>{l}</span></td></tr>;
            })}</tbody></table></div>)}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Условия программы</h2>{d.canManage && !edit && <button className="btn sm pri" onClick={() => setEdit(d.settings)}>Изменить</button>}</div>
        {!edit ? <p style={{ margin: 0 }}>{d.settings.enabled ? 'Включена' : 'Выключена'}. Скидка другу на первую покупку: {d.settings.friendPercent} %. Бонус тому, кто привёл: {d.settings.referrerDays} дн. к срочному абонементу.</p> : (
          <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />Программа включена</label>
            <label className="f">Скидка другу на первую покупку, %<input type="number" value={edit.friendPercent} onChange={(e) => setEdit({ ...edit, friendPercent: Number(e.target.value) })} /></label>
            <label className="f">Дней к абонементу тому, кто привёл<input type="number" value={edit.referrerDays} onChange={(e) => setEdit({ ...edit, referrerDays: Number(e.target.value) })} /></label>
            <div className="row" style={{ gap: 6 }}><button className="btn sm pri" onClick={save}>Сохранить</button><button className="btn sm" onClick={() => setEdit(null)}>Отмена</button></div>
          </div>)}
      </div>
    </div>
  );
}
