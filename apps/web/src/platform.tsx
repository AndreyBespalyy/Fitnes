// Кабинет оператора платформы (адрес /platform): сети-клиенты, договоры и лимиты, счета, приостановка, поддержка.
// Отдельный вход оператора: сотрудники сетей сюда не попадают, а оператор не видит рабочих экранов клубов.
import { useEffect, useState, type FormEvent } from 'react';

class PErr extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }
async function papi<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new PErr(res.status, j.error ?? '', j.message ?? 'Ошибка сервера');
  return j as T;
}
const rub = (k: number | null | undefined) => (k == null ? '—' : `${(k / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`);
const d = (s: string | null | undefined) => (s ? new Date(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString('ru-RU') : '—');
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const ago = (s: string | null) => { if (!s) return 'не заходили'; const h = (Date.now() - new Date(s).getTime()) / 3.6e6; return h < 1 ? 'в течение часа' : h < 24 ? `${Math.round(h)} ч назад` : `${Math.round(h / 24)} дн. назад`; };

type Op = { login: string; fullName: string; mustChange: boolean };
type Tenant = { id: string; name: string; status: string; statusReason: string | null; createdAt: string; contractNumber: string | null; plan: string | null; clubsLimit: number | null; usersLimit: number | null;
  feeKop: number | null; validTo: string | null; signedOn: string | null; note: string | null; clubs: number; users: number; persons: number; lastActivity: string | null; openTickets: number; unpaidKop: number; overdueKop: number };
type ClubH = { id: string; name: string; salesModel: string; status: string; isDemo: boolean; activeMemberships: number; visits7d: number; lastVisit: string | null; revenue30dKop: number; channelErrors: number; gatewaysOffline: number };
type Invoice = { id: string; number: string; periodFrom: string; periodTo: string; amountKop: number; status: string; dueOn: string; paidAt: string | null; paidNote: string | null; cancelledReason: string | null };
type TenantFull = Tenant & { clubsList: ClubH[]; invoices: Invoice[]; owners: { login: string; fullName: string; status: string; lastSeen: string | null }[] };
type Ticket = { id: string; number: number; subject: string; kind: string; status: string; page: string | null; updatedAt: string; escalatedAt: string | null; tenantName: string; clubName: string | null; author: string };

export function PlatformApp() {
  const [me, setMe] = useState<Op | null | undefined>(undefined);
  useEffect(() => { document.title = 'Кабинет оператора'; papi<Op>('GET', '/api/platform/me').then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return <div className="login"><span className="muted">Загрузка…</span></div>;
  if (!me) return <Login onDone={setMe} />;
  if (me.mustChange) return <Password onDone={() => setMe({ ...me, mustChange: false })} />;
  return <Cabinet me={me} onLogout={async () => { await papi('POST', '/api/platform/logout'); setMe(null); }} />;
}

function Login({ onDone }: { onDone: (o: Op) => void }) {
  const [login, setLogin] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); try { onDone(await papi<Op>('POST', '/api/platform/login', { login, password })); } catch (x) { setErr((x as Error).message); } };
  return (
    <div className="login"><form className="card" onSubmit={submit}>
      <div className="brand" style={{ color: 'var(--ink)' }}><i />Клубная ОС</div>
      <h1>Кабинет оператора</h1>
      <label className="f">Логин<input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus /></label>
      <label className="f">Пароль<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn pri" disabled={!login || !password}>Войти</button>
      <p className="small" style={{ margin: 0 }}>Это вход для команды платформы. Сотрудники клубов входят на главной странице.</p>
    </form></div>);
}

function Password({ onDone }: { onDone: () => void }) {
  const [cur, setCur] = useState(''); const [p1, setP1] = useState(''); const [p2, setP2] = useState(''); const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (p1 !== p2) { setErr('Пароли не совпадают'); return; }
    try { await papi('POST', '/api/platform/password', { current: cur, newPassword: p1 }); onDone(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="login"><form className="card" onSubmit={submit}>
      <h1>Смените временный пароль</h1>
      <label className="f">Временный пароль<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus /></label>
      <label className="f">Новый пароль (от 10 символов)<input type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></label>
      <label className="f">Повторите новый пароль<input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn pri" disabled={!cur || !p1 || !p2}>Сохранить пароль</button>
    </form></div>);
}

function Cabinet({ me, onLogout }: { me: Op; onLogout: () => void }) {
  const [tab, setTab] = useState<'tenants' | 'support'>('tenants');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <header className="top" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <div className="brand"><i />Кабинет оператора</div>
        <nav className="tabs" aria-label="Разделы">
          <button aria-pressed={tab === 'tenants'} onClick={() => { setTab('tenants'); setOpen(null); }}>Сети</button>
          <button aria-pressed={tab === 'support'} onClick={() => setTab('support')}>Поддержка</button>
        </nav>
        <span className="small" style={{ marginLeft: 'auto' }}>{me.fullName}</span>
        <button className="btn sm" onClick={onLogout}>Выйти</button>
      </header>
      <main className="wrap">
        {tab === 'tenants' && (open ? <TenantCard id={open} onBack={() => setOpen(null)} /> : <Tenants onOpen={setOpen} />)}
        {tab === 'support' && <Support />}
      </main>
    </div>);
}

function Tenants({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<Tenant[]>([]); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [add, setAdd] = useState<{ name: string; ownerLogin: string; ownerName: string; ownerPhone: string } | null>(null);
  const [created, setCreated] = useState<{ ownerLogin: string; tempPassword: string; name: string } | null>(null);
  const load = () => papi<Tenant[]>('GET', '/api/platform/tenants').then(setList, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const create = async (e: FormEvent) => {
    e.preventDefault(); if (!add) return; setErr('');
    try { const r = await papi<{ ownerLogin: string; tempPassword: string }>('POST', '/api/platform/tenants', add); setCreated({ ...r, name: add.name }); setAdd(null); load(); } catch (x) { setErr((x as Error).message); }
  };
  const monthly = async () => {
    setErr(''); setMsg('');
    try { const r = await papi<{ issued: number; skipped: number }>('POST', '/api/platform/invoices/monthly', {}); setMsg(`Выставлено счетов за месяц: ${r.issued}${r.skipped ? `, уже были: ${r.skipped}` : ''}`); load(); } catch (x) { setErr((x as Error).message); }
  };
  const total = list.reduce((s, t) => s + (t.status === 'active' ? t.feeKop ?? 0 : 0), 0);
  return (
    <>
      {err && <div className="err">{err}</div>}
      {msg && <div className="card">{msg}</div>}
      {created && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <b>Сеть «{created.name}» подключена</b>
          <p style={{ margin: '6px 0' }}>Передайте собственнику: логин <code>{created.ownerLogin}</code>, временный пароль <code>{created.tempPassword}</code>. При первом входе система попросит сменить пароль. Пароль показывается один раз.</p>
          <p className="small" style={{ margin: 0 }}>Дальше собственник добавляет клубы в разделе «Клубы» и выбирает модель продаж. Не забудьте оформить договор и тариф в карточке сети.</p>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setCreated(null)}>Понятно</button>
        </div>)}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
        <div className="card"><span className="small">Сетей</span><b className="num">{list.length}</b></div>
        <div className="card"><span className="small">Клубов</span><b className="num">{list.reduce((s, t) => s + t.clubs, 0)}</b></div>
        <div className="card"><span className="small">Подписка в месяц</span><b className="num">{rub(total)}</b></div>
        <div className="card"><span className="small">Не оплачено</span><b className="num">{rub(list.reduce((s, t) => s + t.unpaidKop, 0))}</b></div>
      </div>
      <div className="card tbl">
        <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}><h2>Сети-клиенты</h2>
          <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={monthly}>Выставить счета за месяц</button>
            {!add && <button className="btn pri sm" onClick={() => setAdd({ name: '', ownerLogin: '', ownerName: '', ownerPhone: '' })}>Подключить сеть</button>}</div></div>
        {add && (
          <form onSubmit={create} style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
            <div className="grid2">
              <label className="f">Название сети<input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} autoFocus /></label>
              <label className="f">ФИО собственника<input value={add.ownerName} onChange={(e) => setAdd({ ...add, ownerName: e.target.value })} /></label>
              <label className="f">Логин собственника (латиницей)<input value={add.ownerLogin} onChange={(e) => setAdd({ ...add, ownerLogin: e.target.value })} placeholder="i.ivanov" /></label>
              <label className="f">Телефон собственника<input value={add.ownerPhone} onChange={(e) => setAdd({ ...add, ownerPhone: e.target.value })} /></label>
            </div>
            <div className="row" style={{ gap: 6 }}><button className="btn pri">Подключить</button><button type="button" className="btn" onClick={() => setAdd(null)}>Отмена</button></div>
          </form>)}
        <table><thead><tr><th>Сеть</th><th>Тариф</th><th>Клубы</th><th>Сотрудники</th><th>Клиенты</th><th>Последний вход</th><th>Счета</th><th>Поддержка</th></tr></thead>
          <tbody>{list.map((t) => (
            <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(t.id)}>
              <td><b>{t.name}</b> {t.status !== 'active' && <span className="chip bad">приостановлена</span>}</td>
              <td>{t.plan ?? <span className="chip warn">нет договора</span>}{t.feeKop ? <div className="small">{rub(t.feeKop)} в мес.</div> : null}</td>
              <td className="num">{t.clubs}{t.clubsLimit ? ` из ${t.clubsLimit}` : ''}</td>
              <td className="num">{t.users}{t.usersLimit ? ` из ${t.usersLimit}` : ''}</td>
              <td className="num">{t.persons.toLocaleString('ru-RU')}</td>
              <td className="small">{ago(t.lastActivity)}</td>
              <td>{t.overdueKop ? <span className="chip bad">просрочено {rub(t.overdueKop)}</span> : t.unpaidKop ? <span className="chip warn">к оплате {rub(t.unpaidKop)}</span> : t.feeKop ? <span className="chip ok">оплачено</span> : <span className="small">—</span>}</td>
              <td>{t.openTickets ? <span className="chip acc">{t.openTickets} открыто</span> : <span className="small">—</span>}</td>
            </tr>))}</tbody></table>
      </div>
    </>);
}

function TenantCard({ id, onBack }: { id: string; onBack: () => void }) {
  const [t, setT] = useState<TenantFull | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [c, setC] = useState<{ number: string; signedOn: string; plan: string; clubsLimit: string; usersLimit: string; validTo: string; fee: string; note: string } | null>(null);
  const load = () => papi<TenantFull>('GET', `/api/platform/tenants/${id}`).then((x) => {
    setT(x);
    setC({ number: x.contractNumber ?? '', signedOn: x.signedOn ?? '', plan: x.plan ?? '', clubsLimit: x.clubsLimit ? String(x.clubsLimit) : '', usersLimit: x.usersLimit ? String(x.usersLimit) : '',
      validTo: x.validTo ?? '', fee: x.feeKop != null ? String(x.feeKop / 100) : '', note: x.note ?? '' });
  }, (e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  const run = async (f: () => Promise<unknown>, ok: string) => { setErr(''); setMsg(''); try { await f(); setMsg(ok); load(); } catch (x) { setErr((x as Error).message); } };
  if (!t || !c) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const saveContract = (e: FormEvent) => { e.preventDefault(); run(() => papi('PUT', `/api/platform/tenants/${id}/contract`, {
    number: c.number, signedOn: c.signedOn, plan: c.plan, clubsLimit: c.clubsLimit ? Number(c.clubsLimit) : null, usersLimit: c.usersLimit ? Number(c.usersLimit) : null,
    validTo: c.validTo || null, feeKop: c.fee ? Math.round(Number(c.fee.replace(',', '.')) * 100) : null, note: c.note || null }), 'Договор сохранён'); };
  const suspend = () => { const reason = prompt('Причина приостановки (например, долг за 2 месяца):'); if (reason) run(() => papi('POST', `/api/platform/tenants/${id}/status`, { status: 'suspended', reason }), 'Доступ сети приостановлен, сотрудники вышли из системы'); };
  const paid = (i: Invoice) => { const note = prompt(`Как пришла оплата по счёту ${i.number}? Номер платёжки или дата выписки:`); if (note) run(() => papi('POST', `/api/platform/invoices/${i.id}/paid`, { note }), 'Счёт отмечен оплаченным'); };
  const cancel = (i: Invoice) => { const reason = prompt(`Причина аннулирования счёта ${i.number}:`); if (reason) run(() => papi('POST', `/api/platform/invoices/${i.id}/cancel`, { reason }), 'Счёт аннулирован'); };
  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={onBack}>← Все сети</button>
        <h1 style={{ margin: 0 }}>{t.name}</h1>
        {t.status === 'active' ? <span className="chip ok">работает</span> : <span className="chip bad" title={t.statusReason ?? ''}>приостановлена: {t.statusReason}</span>}
        <span style={{ marginLeft: 'auto' }} />
        {t.status === 'active' ? <button className="btn sm" onClick={suspend}>Приостановить доступ</button>
          : <button className="btn sm pri" onClick={() => run(() => papi('POST', `/api/platform/tenants/${id}/status`, { status: 'active' }), 'Доступ возобновлён')}>Возобновить доступ</button>}
      </div>
      {err && <div className="err">{err}</div>}
      {msg && <div className="card">{msg}</div>}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
        <div className="card"><span className="small">Клубы</span><b className="num">{t.clubs}{t.clubsLimit ? ` из ${t.clubsLimit}` : ''}</b></div>
        <div className="card"><span className="small">Активные сотрудники</span><b className="num">{t.users}{t.usersLimit ? ` из ${t.usersLimit}` : ''}</b></div>
        <div className="card"><span className="small">Клиенты в базе</span><b className="num">{t.persons.toLocaleString('ru-RU')}</b></div>
        <div className="card"><span className="small">Последний вход</span><b>{ago(t.lastActivity)}</b></div>
      </div>
      <div className="card tbl"><h2>Клубы и их состояние</h2>
        {!t.clubsList.length ? <p className="muted">Клубов пока нет: собственник добавляет их сам в разделе «Клубы».</p> : (
          <table><thead><tr><th>Клуб</th><th>Модель</th><th>Действующих абонементов</th><th>Посещений за 7 дн.</th><th>Последнее посещение</th><th>Выручка за 30 дн.</th><th>Сбои</th></tr></thead>
            <tbody>{t.clubsList.map((k) => (
              <tr key={k.id}><td><b>{k.name}</b> {k.isDemo && <span className="chip">демо</span>} {k.status !== 'active' && <span className="chip">закрыт</span>}</td>
                <td className="small">{k.salesModel === 'subscription' ? 'подписка' : 'на срок'}</td>
                <td className="num">{k.activeMemberships}</td><td className="num">{k.visits7d}</td><td className="small">{dt(k.lastVisit)}</td><td className="num">{rub(k.revenue30dKop)}</td>
                <td>{!k.channelErrors && !k.gatewaysOffline ? <span className="chip ok">нет</span> : <>
                  {k.channelErrors > 0 && <span className="chip bad">мессенджер: {k.channelErrors}</span>} {k.gatewaysOffline > 0 && <span className="chip bad">турникет не на связи: {k.gatewaysOffline}</span>}</>}</td></tr>))}</tbody></table>)}
      </div>
      <div className="grid2">
        <form className="card" onSubmit={saveContract} style={{ display: 'grid', gap: 8 }}>
          <h2>Договор и тариф</h2>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}>
            <label className="f">Номер договора<input value={c.number} onChange={(e) => setC({ ...c, number: e.target.value })} /></label>
            <label className="f">Дата договора<input type="date" value={c.signedOn} onChange={(e) => setC({ ...c, signedOn: e.target.value })} /></label>
            <label className="f">Тариф<input value={c.plan} onChange={(e) => setC({ ...c, plan: e.target.value })} placeholder="Пилот, Старт, Сеть" /></label>
            <label className="f">Плата в месяц, ₽<input inputMode="decimal" value={c.fee} onChange={(e) => setC({ ...c, fee: e.target.value })} /></label>
            <label className="f">Лимит клубов<input inputMode="numeric" value={c.clubsLimit} onChange={(e) => setC({ ...c, clubsLimit: e.target.value })} placeholder="без лимита" /></label>
            <label className="f">Лимит сотрудников<input inputMode="numeric" value={c.usersLimit} onChange={(e) => setC({ ...c, usersLimit: e.target.value })} placeholder="без лимита" /></label>
            <label className="f">Действует до<input type="date" value={c.validTo} onChange={(e) => setC({ ...c, validTo: e.target.value })} /></label>
          </div>
          <label className="f">Примечание<input value={c.note} onChange={(e) => setC({ ...c, note: e.target.value })} /></label>
          <p className="small" style={{ margin: 0 }}>Лимиты действуют сразу: сверх лимита сеть не сможет добавить клуб или сотрудника, работа существующих не блокируется.</p>
          <div><button className="btn pri">Сохранить договор</button></div>
        </form>
        <div className="card" style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <h2>Доступ собственника</h2>
          {t.owners.map((o) => <div key={o.login}><b>{o.fullName}</b> <code>{o.login}</code> <span className="small">{o.status === 'active' ? ago(o.lastSeen) : 'заблокирован'}</span></div>)}
          <p className="small" style={{ margin: 0 }}>Пароль сотрудникам сети выдаёт её собственник или администратор в разделе «Персонал».</p>
        </div>
      </div>
      <div className="card tbl">
        <div className="row between"><h2>Счета за подписку</h2>
          <button className="btn sm" onClick={() => run(() => papi('POST', `/api/platform/tenants/${id}/invoices`, {}), 'Счёт за текущий месяц выставлен')}>Выставить за текущий месяц</button></div>
        {!t.invoices.length ? <p className="muted">Счетов нет.</p> : (
          <table><thead><tr><th>Номер</th><th>Период</th><th>Сумма</th><th>Оплатить до</th><th>Состояние</th><th /></tr></thead>
            <tbody>{t.invoices.map((i) => (
              <tr key={i.id}><td>{i.number}</td><td className="small">{d(i.periodFrom)} – {d(i.periodTo)}</td><td className="num">{rub(i.amountKop)}</td><td className="small">{d(i.dueOn)}</td>
                <td>{i.status === 'paid' ? <span className="chip ok" title={i.paidNote ?? ''}>оплачен {d(i.paidAt)}</span> : i.status === 'cancelled' ? <span className="chip" title={i.cancelledReason ?? ''}>аннулирован</span>
                  : i.dueOn < new Date().toISOString().slice(0, 10) ? <span className="chip bad">просрочен</span> : <span className="chip warn">ждёт оплаты</span>}</td>
                <td className="r">{i.status === 'issued' && <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}><button className="btn sm" onClick={() => paid(i)}>Оплачен</button><button className="btn sm" onClick={() => cancel(i)}>Аннулировать</button></div>}</td></tr>))}</tbody></table>)}
        <p className="small" style={{ margin: '8px 0 0' }}>Счёт оплачивается по реквизитам платформы, оплату отмечаете по выписке. Автооплату картой подключим после договора платформы с банком.</p>
      </div>
    </>);
}

function Support() {
  const [all, setAll] = useState(false); const [list, setList] = useState<Ticket[]>([]); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState('');
  const load = () => papi<Ticket[]>('GET', `/api/platform/support${all ? '?all=1' : ''}`).then(setList, (e) => setErr(e.message));
  useEffect(() => { load(); }, [all]);
  return (
    <>
      {err && <div className="err">{err}</div>}
      <div className="card tbl">
        <div className="row between"><h2>Обращения</h2>
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ width: 'auto' }} /> все открытые, не только переданные платформе</label></div>
        {!list.length ? <p className="muted">Открытых обращений нет.</p> : (
          <table><thead><tr><th>№</th><th>Сеть и клуб</th><th>Тема</th><th>Автор</th><th>Состояние</th><th>Обновлено</th></tr></thead>
            <tbody>{list.map((k) => (
              <tr key={k.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(k.id)}><td>{k.number}</td><td>{k.tenantName}{k.clubName ? <div className="small">{k.clubName}</div> : null}</td>
                <td><b>{k.subject}</b>{k.kind === 'bug' && <> <span className="chip bad">ошибка</span></>}</td><td className="small">{k.author}</td>
                <td>{k.status === 'open' ? <span className="chip acc">ждёт ответа</span> : <span className="chip ok">отвечено</span>}</td><td className="small">{dt(k.updatedAt)}</td></tr>))}</tbody></table>)}
      </div>
      {open && <TicketView id={open} onClose={() => { setOpen(null); load(); }} />}
    </>);
}

function TicketView({ id, onClose }: { id: string; onClose: () => void }) {
  type Full = { number: number; subject: string; tenantName: string; clubName: string | null; author: string; page: string | null; appVersion: string | null; clientInfo: string | null; techLog: unknown;
    messages: { body: string; fromSupport: boolean; createdAt: string; author: string | null }[] };
  const [k, setK] = useState<Full | null>(null); const [text, setText] = useState(''); const [err, setErr] = useState('');
  const load = () => papi<Full>('GET', `/api/platform/support/${id}`).then(setK, (e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  const answer = async (e: FormEvent) => { e.preventDefault(); setErr(''); try { await papi('POST', `/api/platform/support/${id}/answer`, { text }); setText(''); load(); } catch (x) { setErr((x as Error).message); } };
  if (!k) return null;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>№{k.number}. {k.subject}</h2><button className="btn sm" onClick={onClose}>Закрыть</button></div>
      <div className="small">{k.tenantName}{k.clubName ? `, ${k.clubName}` : ''} · {k.author}{k.page ? ` · раздел «${k.page}»` : ''}{k.appVersion ? ` · версия ${k.appVersion}` : ''}</div>
      {k.messages.map((m, i) => (
        <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: m.fromSupport ? 'var(--accent-soft)' : 'var(--surface-2)' }}>
          <div className="small">{m.fromSupport ? 'Поддержка платформы' : m.author} · {dt(m.createdAt)}</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>))}
      {k.techLog ? <details><summary className="small">Технический журнал</summary><pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(k.techLog, null, 2)}</pre></details> : null}
      {err && <div className="err">{err}</div>}
      <form onSubmit={answer} style={{ display: 'grid', gap: 6 }}>
        <label className="f">Ответ<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <div><button className="btn pri" disabled={!text.trim()}>Отправить ответ</button></div>
      </form>
    </div>);
}
