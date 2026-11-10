import { useEffect, useState, type FormEvent } from 'react';
import { api, can, MODEL, MODEL_SHORT, type Club, type Me, type Person, type RoleDef, type Staff } from './api.ts';
import { errText, toast as alertOk } from './ui.ts';
import { BoardPage, LeadsPage, PersonCard, PipelinesAdmin, TasksPage } from './crm.tsx';
import { TariffsPage } from './memberships.tsx';
import { ContractsAdminPage, SitePage } from './contracts.tsx';
import { FiscalPage, LocalKktAgent } from './fiscal.tsx';
import { FinancePage } from './finance.tsx';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { api<Me>('GET', '/api/auth/me').then(setMe).catch(() => setMe(null)); }, []);
  if (me === undefined) return <div className="login"><span className="muted">Загрузка…</span></div>;
  if (me === null) return <Login onDone={setMe} />;
  if (me.mustChangePassword) return <ChangePassword me={me} forced onDone={() => setMe({ ...me, mustChangePassword: false })} onLogout={() => setMe(null)} />;
  return <Shell me={me} onLogout={() => setMe(null)} />;
}

function Login({ onDone }: { onDone: (m: Me) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { onDone(await api<Me>('POST', '/api/auth/login', { login, password })); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ color: 'var(--ink)' }}><i />Клубная ОС</div>
        <h1>Вход</h1>
        <label className="f">Логин<input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus /></label>
        <label className="f">Пароль<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn pri" disabled={busy || !login || !password}>{busy ? 'Входим…' : 'Войти'}</button>
        <p className="small" style={{ margin: 0 }}>Забыли пароль? Обратитесь к администратору системы, он выдаст временный.</p>
      </form>
    </div>
  );
}

function ChangePassword({ me, forced, onDone, onLogout }: { me: Me; forced?: boolean; onDone: () => void; onLogout?: () => void }) {
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (p1 !== p2) return setErr('Новые пароли не совпадают');
    try { await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: p1 }); onDone(); } catch (x) { setErr(errText(x)); }
  };
  const logout = async () => { await api('POST', '/api/auth/logout').catch(() => {}); onLogout?.(); };
  return (
    <div className={forced ? 'login' : ''}>
      <form className="card" onSubmit={submit} style={forced ? undefined : { maxWidth: 420 }}>
        <h1>{forced ? 'Смените временный пароль' : 'Смена пароля'}</h1>
        {forced && <p className="muted" style={{ margin: 0 }}>{me.full_name}, администратор выдал вам временный пароль. Придумайте свой, не короче 10 символов.</p>}
        <label className="f">{forced ? 'Временный пароль' : 'Текущий пароль'}<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="f">Новый пароль<input type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></label>
        <label className="f">Повторите новый пароль<input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></label>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row">
          <button className="btn pri" disabled={!cur || !p1 || !p2}>Сохранить пароль</button>
          {forced && <button type="button" className="btn" onClick={logout}>Выйти</button>}
        </div>
      </form>
    </div>
  );
}

type Tab = 'leads' | 'board' | 'tasks' | 'home' | 'clubs' | 'tariffs' | 'contracts' | 'site' | 'fiscal' | 'finance' | 'pipelines' | 'staff' | 'password';

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const isAdmin = can(me, 'clubs.manage') || can(me, 'staff.manage');
  const firstTab: Tab = can(me, 'crm.work') ? 'tasks' : can(me, 'leads.create') ? 'leads' : isAdmin ? 'clubs' : 'home';
  const [tab, setTab] = useState<Tab>(firstTab);
  const [personId, setPersonId] = useState<string | null>(null);
  const [ver, setVer] = useState(0);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [clubId, setClubId] = useState<string>('all');
  const reloadClubs = () => api<Club[]>('GET', '/api/clubs').then(setClubs).catch(() => setClubs([]));
  useEffect(() => { reloadClubs(); }, []);
  useEffect(() => { if (!me.allClubs && clubs.length && clubId === 'all') setClubId(clubs[0].id); }, [clubs]);
  const logout = async () => { await api('POST', '/api/auth/logout').catch(() => {}); onLogout(); };
  const roleNames = me.roles.map((r) => r.name).join(', ');
  const tabs: [Tab, string, boolean][] = [
    ['tasks', 'Задачи', can(me, 'crm.work')],
    ['leads', 'Лиды', can(me, 'leads.create')],
    ['board', 'Сделки', can(me, 'crm.work')],
    ['home', 'Клиенты', can(me, 'persons.view')],
    ['clubs', 'Клубы', can(me, 'clubs.manage')],
    ['tariffs', 'Тарифы', can(me, 'tariffs.manage') || can(me, 'memberships.sell')],
    ['contracts', 'Договоры', can(me, 'contracts.manage')],
    ['site', 'Сайт', can(me, 'site.manage')],
    ['finance', 'Финансы', can(me, 'finance.view') || can(me, 'shifts.work') || can(me, 'approvals.decide')],
    ['fiscal', 'Касса', can(me, 'fiscal.manage') || can(me, 'memberships.manage')],
    ['pipelines', 'Воронки', can(me, 'pipelines.manage')],
    ['staff', 'Сотрудники', can(me, 'staff.view')],
    ['password', 'Пароль', true],
  ];
  return (
    <>
      <header className="top">
        <div className="brand"><i />Клубная ОС</div>
        {clubs.length > 0 && (
          <select aria-label="Клуб" value={clubId} onChange={(e) => setClubId(e.target.value)}>
            {me.allClubs && <option value="all">Вся сеть</option>}
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div className="sp"><LocalKktAgent me={me} clubId={clubId} /><span>{me.full_name} · {roleNames}</span><button onClick={logout}>Выйти</button></div>
      </header>
      <main className="wrap">
        <div className="tabs" role="group" aria-label="Разделы">
          {tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{t}</button>)}
        </div>
        {tab === 'tasks' && <TasksPage key={ver} me={me} clubId={clubId} openPerson={setPersonId} />}
        {tab === 'leads' && <LeadsPage key={ver} me={me} clubs={clubs} clubId={clubId} openPerson={setPersonId} />}
        {tab === 'board' && <BoardPage key={ver} clubs={clubs} clubId={clubId} openPerson={setPersonId} />}
        {tab === 'tariffs' && <TariffsPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'contracts' && <ContractsAdminPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'finance' && <FinancePage me={me} clubs={clubs} clubId={clubId} openPerson={setPersonId} />}
        {tab === 'fiscal' && <FiscalPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'site' && <SitePage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'pipelines' && <PipelinesAdmin clubs={clubs} clubId={clubId} />}
        {tab === 'home' && <Home key={ver} me={me} clubs={clubs} clubId={clubId} openPerson={setPersonId} />}
        {tab === 'clubs' && <Clubs me={me} clubs={clubs} reload={reloadClubs} />}
        {tab === 'staff' && <StaffPage me={me} clubs={clubs} />}
        {tab === 'password' && <ChangePassword me={me} onDone={() => { alertOk('Пароль изменён'); setTab(firstTab); }} />}
      </main>
      {personId && <PersonCard me={me} id={personId} onClose={() => { setPersonId(null); setVer((v) => v + 1); }} />}
    </>
  );
}


function Home({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [persons, setPersons] = useState<Person[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      if (clubId !== 'all') qs.set('clubId', clubId);
      if (q.trim()) qs.set('q', q.trim());
      api<Person[]>('GET', `/api/persons?${qs}`).then(setPersons).catch(() => setPersons([]));
    }, 250);
    return () => clearTimeout(t);
  }, [clubId, q]);
  const club = clubs.find((c) => c.id === clubId);
  return (
    <>
      <div className="row between">
        <div><div className="lbl">{club ? MODEL[club.salesModel] : 'Все клубы сети'}</div><h1>{club ? club.name : 'Вся сеть'}</h1></div>
      </div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по имени или телефону" aria-label="Поиск клиента" style={{ maxWidth: 420 }} />
      <p className="small" style={{ margin: 0 }}>Видны клиенты {me.allClubs ? 'всей сети' : 'вашего клуба'}. Нажмите на имя, чтобы открыть карточку.</p>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Клиент</th><th>Категория</th><th>Клуб</th><th>Телефон</th></tr></thead>
        <tbody>{persons.map((p) => <tr key={p.id}><td><button className="btn sm" onClick={() => openPerson(p.id)}>{p.fullName}</button></td><td><span className="chip acc">{p.segment}</span></td><td>{p.clubName}</td><td className="num">{p.phone}</td></tr>)}</tbody>
      </table></div>{persons.length === 0 && <p className="muted">Клиентов нет.</p>}</div>
    </>
  );
}

function Clubs({ me, clubs, reload }: { me: Me; clubs: Club[]; reload: () => void }) {
  const [wiz, setWiz] = useState(false);
  const [err, setErr] = useState('');
  const changeModel = async (c: Club, model: string) => {
    setErr('');
    try { await api('PATCH', `/api/clubs/${c.id}`, { salesModel: model }); alertOk(`Модель продаж «${c.name}»: ${MODEL[model]}`); reload(); } catch (x) { setErr(errText(x)); }
  };
  const saveNorm = async (c: Club, v: number) => {
    setErr('');
    try { await api('PATCH', `/api/clubs/${c.id}`, { firstResponseMinutes: v }); alertOk(`Норма первого ответа: ${v} мин`); reload(); } catch (x) { setErr(errText(x)); }
  };
  if (wiz) return <Wizard onClose={(created) => { setWiz(false); if (created) reload(); }} />;
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>У каждого клуба своя модель продаж. От неё зависят категории плана, воронки, тарифы и показатели.</p>
        {me.allClubs && <button className="btn pri" onClick={() => setWiz(true)}>+ Новый клуб</button>}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="grid2">
        {clubs.map((c) => (
          <div className="card" key={c.id}>
            <div className="row between"><h2>{c.name}</h2><span className="chip acc">{MODEL_SHORT[c.salesModel]}</span></div>
            <p className="muted" style={{ margin: '4px 0 10px' }}>{c.address || 'адрес не указан'} · сотрудников: {c.staffCount} · клиентов: {c.personsCount}</p>
            <label className="f">Модель продаж
              <select className="f" value={c.salesModel} onChange={(e) => changeModel(c, e.target.value)}>
                <option value="term">{MODEL.term}</option><option value="subscription">{MODEL.subscription}</option>
              </select>
            </label>
            <p className="small">При смене модели действующие договоры сохраняют условия, новый набор плана применяется со следующего периода.</p>
            <label className="f" style={{ marginTop: 8 }}>Норма первого ответа новому лиду, минут
              <input type="number" min={1} max={1440} defaultValue={c.firstResponseMinutes} style={{ maxWidth: 140 }}
                onBlur={(e) => { const v = Number(e.target.value); if (v !== c.firstResponseMinutes) saveNorm(c, v); }} /></label>
          </div>
        ))}
      </div>
    </>
  );
}

const TZ: [string, string][] = [['Europe/Kaliningrad', 'Калининград (МСК−1)'], ['Europe/Moscow', 'Москва (МСК)'], ['Europe/Samara', 'Самара (МСК+1)'],
  ['Asia/Yekaterinburg', 'Екатеринбург (МСК+2)'], ['Asia/Omsk', 'Омск (МСК+3)'], ['Asia/Novosibirsk', 'Новосибирск (МСК+4)'],
  ['Asia/Krasnoyarsk', 'Красноярск (МСК+4)'], ['Asia/Irkutsk', 'Иркутск (МСК+5)'], ['Asia/Yakutsk', 'Якутск (МСК+6)'],
  ['Asia/Vladivostok', 'Владивосток (МСК+7)'], ['Asia/Magadan', 'Магадан (МСК+8)'], ['Asia/Kamchatka', 'Камчатка (МСК+9)']];

function Wizard({ onClose }: { onClose: (created: boolean) => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [model, setModel] = useState<'term' | 'subscription' | null>(null);
  const [err, setErr] = useState('');
  const create = async () => {
    setErr('');
    try { await api('POST', '/api/clubs', { name, address, timezone, salesModel: model }); alertOk(`Создан: ${name}`); onClose(true); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card" style={{ maxWidth: 560, display: 'grid', gap: 12 }}>
      <div className="steps">{['Клуб', 'Модель продаж', 'Готовые настройки'].map((s, i) => <span key={s} className={i <= step ? 'on' : ''}>{i + 1}. {s}</span>)}</div>
      {step === 0 && (<>
        <h2>Новый клуб</h2>
        <label className="f">Название<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Клуб «Юг»" autoFocus /></label>
        <label className="f">Адрес<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Город, улица, дом" /></label>
        <label className="f">Часовой пояс<select className="f" value={timezone} onChange={(e) => setTimezone(e.target.value)}>{TZ.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <div className="row"><button className="btn" onClick={() => onClose(false)}>Отмена</button><button className="btn pri" disabled={!name.trim()} onClick={() => setStep(1)}>Далее</button></div>
      </>)}
      {step === 1 && (<>
        <h2>По какой модели продаёт клуб?</h2>
        <p className="small" style={{ margin: 0 }}>Выбор обязателен. Позже его можно изменить в карточке клуба.</p>
        {(['term', 'subscription'] as const).map((m) => (
          <button key={m} className="opt" aria-pressed={model === m} onClick={() => setModel(m)}>
            <b>{MODEL[m]}</b>
            <span className="small">{m === 'term' ? 'План: новые клиенты, продления, возобновление бывших' : 'План: новые подписки, возврат отписавшихся, удержание; показатели: регулярная выручка и отток'}</span>
          </button>
        ))}
        <div className="row"><button className="btn" onClick={() => setStep(0)}>Назад</button><button className="btn pri" disabled={!model} onClick={() => setStep(2)}>Далее</button></div>
      </>)}
      {step === 2 && model && (<>
        <h2>Готовые настройки</h2>
        <p className="muted" style={{ margin: 0 }}>Клуб «{name}» будет создан с моделью «{MODEL[model]}». Сразу будут созданы воронки для этой модели. Примеры тарифов и категорий плана подключатся на следующих шагах.</p>
        {err && <div className="err">{err}</div>}
        <div className="row"><button className="btn" onClick={() => setStep(1)}>Назад</button><button className="btn pri" onClick={create}>Создать клуб</button></div>
      </>)}
    </div>
  );
}

function StaffPage({ me, clubs }: { me: Me; clubs: Club[] }) {
  const manage = can(me, 'staff.manage');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [fullName, setFullName] = useState('');
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('manager');
  const [clubId, setClubId] = useState('');
  const [err, setErr] = useState('');
  const [issued, setIssued] = useState<{ name: string; login: string; password: string } | null>(null);
  const reload = () => api<Staff[]>('GET', '/api/staff').then(setStaff).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); api<RoleDef[]>('GET', '/api/roles').then(setRoles).catch(() => {}); }, []);
  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  const roleDef = roles.find((r) => r.code === role);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ user: Staff; tempPassword: string }>('POST', '/api/staff', { fullName, login: login || undefined, role, clubId: roleDef?.networkWide ? null : clubId });
      setIssued({ name: r.user.fullName, login: r.user.login, password: r.tempPassword });
      setFullName(''); setLogin(''); reload();
    } catch (x) { setErr(errText(x)); }
  };
  const act = async (s: Staff, action: 'block' | 'unblock' | 'reset-password') => {
    setErr('');
    try {
      const r = await api<{ user?: Staff; tempPassword?: string }>('POST', `/api/staff/${s.id}/${action}`);
      if (r.tempPassword) setIssued({ name: s.fullName, login: s.login, password: r.tempPassword });
      else alertOk(action === 'block' ? 'Сотрудник заблокирован, история сохранена' : 'Доступ возвращён');
      reload();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      {issued && (
        <div className="card" style={{ borderColor: 'var(--accent)', display: 'grid', gap: 8 }}>
          <h2>Передайте данные для входа: {issued.name}</h2>
          <div className="row"><span className="muted">Логин</span><span className="secret">{issued.login}</span><span className="muted">Временный пароль</span><span className="secret">{issued.password}</span></div>
          <p className="small" style={{ margin: 0 }}>Пароль показывается один раз. При первом входе сотрудник обязан сменить его на свой.</p>
          <div><button className="btn sm" onClick={() => setIssued(null)}>Готово, передал</button></div>
        </div>
      )}
      {manage && (
        <form className="card" onSubmit={add} style={{ display: 'grid', gap: 10 }}>
          <h2>Добавить сотрудника</h2>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', alignItems: 'end' }}>
            <label className="f">ФИО<input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Иван Иванов" /></label>
            <label className="f">Логин (необязательно)<input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="создастся сам" /></label>
            <label className="f">Роль<select className="f" value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.filter((r) => (r.code !== 'owner' || can(me, '*')) && (!r.networkWide || me.allClubs)).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></label>
            <label className="f">Клуб<select className="f" value={roleDef?.networkWide ? '' : clubId} disabled={roleDef?.networkWide} onChange={(e) => setClubId(e.target.value)}>
              {roleDef?.networkWide ? <option value="">Вся сеть</option> : clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <button className="btn pri" disabled={!fullName.trim()}>Добавить</button>
          </div>
        </form>
      )}
      {err && <div className="err">{err}</div>}
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Сотрудник</th><th>Логин</th><th>Роль</th><th>Клуб</th><th>Статус</th>{manage && <th />}</tr></thead>
        <tbody>{staff.map((s) => (
          <tr key={s.id}>
            <td>{s.fullName}</td><td className="num">{s.login}</td>
            <td>{s.assignments.map((a) => a.roleName).join(', ')}</td>
            <td>{s.assignments.map((a) => a.clubName ?? 'Вся сеть').join(', ')}</td>
            <td>{s.status === 'active' ? <span className="chip ok">{s.mustChangePassword ? 'ждёт смены пароля' : 'активен'}</span> : <span className="chip bad">заблокирован</span>}</td>
            {manage && <td className="r">{s.id !== me.id && !s.assignments.some((a) => a.role === 'owner') && (
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={() => act(s, 'reset-password')}>Новый пароль</button>
                <button className="btn sm" onClick={() => act(s, s.status === 'active' ? 'block' : 'unblock')}>{s.status === 'active' ? 'Заблокировать' : 'Вернуть'}</button>
              </span>)}</td>}
          </tr>))}</tbody>
      </table></div>
      <p className="small">Заблокированный сотрудник сразу выходит из системы и не может войти, его история и клиенты сохраняются.</p></div>
    </>
  );
}
