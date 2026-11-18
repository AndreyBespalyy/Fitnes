import { lazy, Suspense, useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { api, ApiError, can, clearDeviceData, setNavIntent, type Go, MODEL, MODEL_SHORT, type Club, type Me, type Person, type RoleDef, type Staff } from './api.ts';
import { errText, toast as alertOk } from './ui.ts';
import { ReportProblem } from './report.tsx';
import { CommandPalette, SideNav } from './nav.tsx';
import { UpdateBanner } from './version.tsx';
import { OfflineBar, ProfilePage, registerServiceWorker, StaffSessions } from './mobile.tsx';
import { NotificationsBell } from './notifications.tsx';
import { IncomingCall, PbxSettings } from './telephony.tsx';
import { AiButton, TeamButton } from './team/button.tsx';
import { TestNotesWidget } from './testNotes.tsx';
import { InstallWizard } from './installWizard.tsx';
import { inRoleMenu, ownerOnly, trainerOnly } from './roleMenu.ts';

// Разделы грузятся по мере открытия: первый вход быстрее, особенно на планшете ресепшна
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = <M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) => lazy(async () => {
  try {
    const m = await load();
    try { sessionStorage.removeItem('chunk-reload'); } catch { /* нет хранилища */ }
    return { default: m[name] };
  } catch {
    // После обновления сайта старых файлов разделов уже нет — один раз перезагружаем страницу
    let tried = true;
    try { tried = !!sessionStorage.getItem('chunk-reload'); if (!tried) sessionStorage.setItem('chunk-reload', '1'); } catch { /* нет хранилища */ }
    if (navigator.onLine && !tried) location.reload();
    return { default: (() => <div className="err">Раздел не загрузился. {navigator.onLine ? 'Обновите страницу.' : 'Нет связи: этот раздел ещё не открывался на устройстве и недоступен без интернета.'}</div>) as unknown as M[K] };
  }
});
const RetentionPage = page(() => import('./retention.tsx'), 'RetentionPage');
const SchedulePage = page(() => import('./schedule.tsx'), 'SchedulePage');
const HelpPage = page(() => import('./onboarding.tsx'), 'HelpPage');
const OnboardingPage = page(() => import('./onboarding.tsx'), 'OnboardingPage');
const CallsPage = page(() => import('./calls.tsx'), 'CallsPage');
const HotPage = page(() => import('./hot.tsx'), 'HotPage');
const DashPage = page(() => import('./dash.tsx'), 'DashPage');
const BoardPage = page(() => import('./crm.tsx'), 'BoardPage');
const LeadsPage = page(() => import('./crm.tsx'), 'LeadsPage');
const PersonCard = page(() => import('./crm.tsx'), 'PersonCard');
const PipelinesAdmin = page(() => import('./crm.tsx'), 'PipelinesAdmin');
const TasksPage = page(() => import('./crm.tsx'), 'TasksPage');
const TariffsPage = page(() => import('./memberships.tsx'), 'TariffsPage');
const ShopPage = page(() => import('./shop.tsx'), 'ShopPage');
const CompaniesPage = page(() => import('./familyCorp.tsx'), 'CompaniesPage');
const TrainerPage = page(() => import('./trainer.tsx'), 'TrainerPage');
const DeskPage = page(() => import('./desk.tsx'), 'DeskPage');
const LoadPage = page(() => import('./load.tsx'), 'LoadPage');
const CohortsPage = page(() => import('./cohorts.tsx'), 'CohortsPage');
const PnlPage = page(() => import('./pnl.tsx'), 'PnlPage');
const ContractsAdminPage = page(() => import('./contracts.tsx'), 'ContractsAdminPage');
const SitePage = page(() => import('./contracts.tsx'), 'SitePage');
const FiscalPage = page(() => import('./fiscal.tsx'), 'FiscalPage');
const LocalKktAgent = page(() => import('./fiscal.tsx'), 'LocalKktAgent');
const FinancePage = page(() => import('./finance.tsx'), 'FinancePage');
const ImportPage = page(() => import('./importer.tsx'), 'ImportPage');
const AccessPage = page(() => import('./access.tsx'), 'AccessPage');
const ChatsPage = page(() => import('./chat.tsx'), 'ChatsPage');
const MessagingAdmin = page(() => import('./chat.tsx'), 'MessagingAdmin');
const RolesPage = page(() => import('./roles.tsx'), 'RolesPage');
const StaffTimePage = page(() => import('./staff.tsx'), 'StaffTimePage');
const ProblemsPage = page(() => import('./problems.tsx'), 'ProblemsPage');
const LoginSecurity = page(() => import('./loginSecurity.tsx'), 'LoginSecurity');
const UsagePage = page(() => import('./usage.tsx'), 'UsagePage');
const ActivityPage = page(() => import('./activity.tsx'), 'ActivityPage');
const IntakePage = page(() => import('./intake.tsx'), 'IntakePage');
const ConfigPage = page(() => import('./config.tsx'), 'ConfigPage');
const ReviewsPage = page(() => import('./insights.tsx'), 'ReviewsPage');
const SalesOpsPage = page(() => import('./salesOps.tsx'), 'SalesOpsPage');
const ProcessesPage = page(() => import('./processes.tsx'), 'ProcessesPage');
const WeeklyPage = page(() => import('./weekly.tsx'), 'WeeklyPage');
const LearnPage = page(() => import('./learn.tsx'), 'LearnPage');
const TeamPage = page(() => import('./team.tsx'), 'TeamPage');
const PrivacyPage = page(() => import('./privacy.tsx'), 'PrivacyPage');
const SystemPage = page(() => import('./privacy.tsx'), 'SystemPage');
const TestNotesPage = page(() => import('./testNotes.tsx'), 'TestNotesPage');


export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [noNet, setNoNet] = useState(false);
  const loadMe = () => { setNoNet(false); api<Me>('GET', '/api/auth/me').then(setMe).catch((x) => (x instanceof ApiError && x.code === 'offline' ? setNoNet(true) : setMe(null))); };
  useEffect(loadMe, []);
  // Ссылка «открыть на телефоне» из профиля: сначала пошаговая установка, потом вход
  const [install, setInstall] = useState(() => new URLSearchParams(location.search).has('install'));
  if (install) return <InstallPage onDone={() => { setInstall(false); const u = new URL(location.href); u.searchParams.delete('install'); history.replaceState(null, '', u.toString()); }} />;
  if (noNet) return <div className="login"><div className="card" style={{ display: 'grid', gap: 10 }}><b>Нет связи с сервером</b><span className="small muted">Проверьте интернет на телефоне и попробуйте снова.</span><button className="btn pri" onClick={loadMe}>Повторить</button></div></div>;
  if (me === undefined) return <div className="login"><span className="muted">Загрузка…</span></div>;
  if (me === null) return <Login onDone={setMe} />;
  if (me.mustChangePassword) return <ChangePassword me={me} forced onDone={() => setMe({ ...me, mustChangePassword: false })} onLogout={() => setMe(null)} />;
  return <Shell me={me} onLogout={() => setMe(null)} />;
}

function InstallPage({ onDone }: { onDone: () => void }) {
  return (
    <div className="login" style={{ placeItems: 'start center' }}>
      <div className="card" style={{ display: 'grid', gap: 10, width: 'min(640px, 100%)' }}>
        <div className="lbl">Клубная ОС</div>
        <h1 style={{ margin: 0 }}>Установите CRM на телефон</h1>
        <p className="small muted" style={{ margin: 0 }}>Без App Store и Google Play — значок ставится из браузера за минуту. Логин и пароль — те же, что на компьютере.</p>
        <InstallWizard app="crm" />
        <button className="btn" onClick={onDone}>Открыть CRM без установки</button>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: (m: Me) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const m = await api<Me>('POST', '/api/auth/login', { login, password }); clearDeviceData(); onDone(m); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
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

type Tab = 'dash' | 'hot' | 'calls' | 'leads' | 'board' | 'tasks' | 'home' | 'clubs' | 'tariffs' | 'contracts' | 'site' | 'fiscal' | 'finance' | 'import' | 'chats' | 'access' | 'messaging' | 'pipelines' | 'staff' | 'stafftime' | 'config' | 'reviews' | 'onboarding' | 'privacy' | 'system' | 'help' | 'schedule' | 'retention' | 'shop' | 'corp' | 'trainer' | 'desk' | 'load' | 'cohorts' | 'pnl' | 'usage' | 'intake' | 'sales' | 'processes' | 'weekly' | 'learn' | 'team' | 'notes' | 'profile' | 'problems' | 'payouts' | 'activity' | 'telephony' | 'roles';

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  // Главный экран роли (проверка CRM, п. 11): ресепшн начинает с «Ресепшна», тренер — с «Моего дня», остальные — с рабочего стола
  const only = (code: string) => me.roles.length > 0 && me.roles.every((r) => r.code === code);
  const firstTab: Tab = only('desk') ? 'desk' : only('trainer') ? 'trainer' : 'dash';
  // Адрес раздела: ?tab=finance&view=debts&person=<id> — ссылки, закладки и кнопка «Назад» в браузере
  const readUrl = () => {
    const q = new URLSearchParams(location.search);
    const t = q.get('tab') as Tab | null;
    const p = Object.fromEntries([...q.entries()].filter(([k]) => k !== 'tab' && k !== 'person'));
    return { tab: t, p, person: q.get('person') };
  };
  const [init] = useState(() => { const u = readUrl(); if (u.tab && Object.keys(u.p).length) setNavIntent({ tab: u.tab, p: u.p }); return u; });
  const [tab, setTabState] = useState<Tab>(init.tab ?? firstTab);
  const [more, setMore] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const [personId, setPersonId] = useState<string | null>(init.person);
  const [teamKey, setTeamKey] = useState(0); // «Дядя Витя» в шапке: заново открыть мессенджер на чате Дяди Вити
  const href = (t: string, p: Record<string, string> = {}, person?: string | null) => {
    const q = new URLSearchParams({ tab: t, ...p }); if (person) q.set('person', person); return `/?${q}`;
  };
  const push = (url: string, state: unknown = null) => { if (url !== location.pathname + location.search) history.pushState(state, '', url); };
  const setTab = (t: Tab) => { setNavIntent(null); setTabState(t); setMore(false); setPersonId(null); window.scrollTo(0, 0); push(href(t)); };
  /** Переход с рабочего стола: раздел с фильтром */
  const go = (g: Go) => {
    setNavIntent(g); setTabState(g.tab as Tab); setMore(false); setPersonId(null); window.scrollTo(0, 0); push(href(g.tab, g.p)); };
  const openPerson = (id: string) => { setPersonId(id); const u = readUrl(); push(href(u.tab ?? tab, u.p, id), { card: true }); };
  const closePerson = () => {
    setPersonId(null); setVer((v) => v + 1);
    const u = readUrl();
    // Карточку открыли в этом окне — «Закрыть» работает как «Назад»; пришли по ссылке — просто убираем карточку из адреса
    if (u.person && (history.state as { card?: boolean } | null)?.card) history.back();
    else if (u.person) history.replaceState(null, '', href(u.tab ?? tab, u.p));
  };
  useEffect(() => {
    if (!init.tab) history.replaceState(null, '', href(firstTab));
    const onPop = () => {
      const u = readUrl();
      setNavIntent(u.tab && Object.keys(u.p).length ? { tab: u.tab, p: u.p } : null);
      setTabState(u.tab ?? firstTab); setPersonId(u.person); setMore(false);
    };
    window.addEventListener('popstate', onPop);
    // Нажали на уведомление — открываем нужный раздел (и карточку клиента, если она в ссылке)
    registerServiceWorker((url) => {
      const q = new URL(url, location.origin).searchParams; const t = q.get('tab') as Tab | null; if (!t) return;
      const p = Object.fromEntries([...q.entries()].filter(([k]) => k !== 'tab' && k !== 'person'));
      go({ tab: t, p }); const person = q.get('person'); if (person) openPerson(person);
    });
    // Переход из любого окна (например, шаг в «Коротко о ситуации»): событие crm-go с адресом вида /?tab=…&person=…
    const onGo = (e: Event) => {
      const q = new URL((e as CustomEvent<string>).detail, location.origin).searchParams; const t = q.get('tab') as Tab | null;
      const p = Object.fromEntries([...q.entries()].filter(([k]) => k !== 'tab' && k !== 'person'));
      if (t) go({ tab: t, p }); const person = q.get('person'); if (person) openPerson(person);
    };
    window.addEventListener('crm-go', onGo);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('crm-go', onGo); };
  }, []);
  const [ver, setVer] = useState(0);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [clubId, setClubId] = useState<string>('all');
  const reloadClubs = () => api<Club[]>('GET', '/api/clubs').then(setClubs).catch(() => setClubs([]));
  useEffect(() => { reloadClubs(); }, []);
  useEffect(() => { if (!me.allClubs && clubs.length && clubId === 'all') setClubId(clubs[0].id); }, [clubs]);
  const logout = async () => { await api('POST', '/api/auth/logout').catch(() => {}); clearDeviceData(); onLogout(); };
  const roleNames = me.roles.map((r) => r.name).join(', ');
  // Выбор клуба: у тех, кому доступно несколько клубов (собственник, сеть), — вверху окна, рядом с поиском
  const clubPick = (cls: string) => (clubs.length === 1 && !me.allClubs
    // Один клуб и выбрать нечего — просто название, без поля выбора
    ? <div className={`${cls} club-one`}>{clubs[0].name}</div>
    : <select className={cls} aria-label="Клуб" value={clubId} onChange={(e) => setClubId(e.target.value)}>
      {me.allClubs && <option value="all">Все клубы</option>}
      {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>);
  const tabs: [Tab, string, boolean][] = [
    ['dash', 'Рабочий стол', true],
    ['problems', 'Проблемные моменты', can(me, 'dash.view') || can(me, 'finance.view')],
    ['team', 'Мессенджер', true],
    // «Мои задачи» — у всех ролей: шаги процессов и задачи из советов приходят и ресепшну, и тренеру, и финансисту
    ['tasks', can(me, 'crm.work') ? 'Задачи' : 'Мои задачи', true],
    ['processes', 'Бизнес-процессы', true],
    ['weekly', 'Разбор недели', can(me, 'dash.view') || can(me, 'crm.view_all')],
    ['learn', 'Чему научился Дядя Витя', can(me, 'dash.view') || can(me, 'crm.view_all')],
    ['hot', 'Кому звонить', can(me, 'crm.work')],
    ['calls', 'Звонки', can(me, 'crm.work')],
    ['sales', 'Отдел продаж', can(me, 'crm.work')],
    ['schedule', 'Расписание', can(me, 'schedule.book')],
    ['leads', 'Лиды', can(me, 'leads.create')],
    ['board', 'Сделки', can(me, 'crm.work')],
    ['chats', 'Переписка', can(me, 'messages.work')],
    ['home', trainerOnly(me) ? 'Мои клиенты' : 'Клиенты', can(me, 'persons.view')],
    ['access', 'Проходы и турникеты', can(me, 'acs.work') || can(me, 'acs.manage')],
    ['clubs', 'Клубы', can(me, 'clubs.manage')],
    ['tariffs', 'Тарифы', can(me, 'tariffs.manage') || can(me, 'memberships.sell')],
    ['shop', 'Товары', can(me, 'tariffs.manage') || can(me, 'memberships.sell') || can(me, 'shifts.work')],
    ['desk', 'Ресепшн', can(me, 'acs.work')],
    ['trainer', can(me, 'memberships.sell') ? 'Столы тренеров' : 'Мой день', can(me, 'schedule.book') && (!can(me, 'memberships.sell') || can(me, 'schedule.manage'))],
    ['corp', 'Компании', can(me, 'tariffs.manage') || can(me, 'finance.work') || can(me, 'crm.view_all') || can(me, 'memberships.sell')],
    ['contracts', 'Договоры', can(me, 'contracts.manage')],
    ['site', 'Сайт', can(me, 'site.manage')],
    ['load', 'Посещаемость', can(me, 'dash.view') || can(me, 'schedule.manage')],
    ['cohorts', 'Удержание', can(me, 'dash.view') || can(me, 'finance.view')],
    ['pnl', 'Прибыль', can(me, 'finance.view')],
    ['finance', 'Финансы', can(me, 'finance.view') || can(me, 'shifts.work') || can(me, 'approvals.decide')],
    ['payouts', 'Выплаты', can(me, 'payroll.manage')],
    // Ресепшну здесь только журнал чеков — «Касса смены» у него в «Финансах»
    ['fiscal', can(me, 'fiscal.manage') ? 'Касса и чеки' : 'Чеки', can(me, 'fiscal.manage') || can(me, 'memberships.manage')],
    // Технический администратор видит здесь только подключение каналов и СМС, без шаблонов и автосообщений клиентам
    ['messaging', can(me, 'messages.manage') ? 'Сообщения' : 'Мессенджеры и СМС', can(me, 'messages.manage') || can(me, 'integrations.manage')],
    ['import', 'Перенос из 1С', can(me, 'import.manage')],
    ['pipelines', 'Воронки', can(me, 'pipelines.manage')],
    ['intake', 'Приём заявок', can(me, 'sources.manage') || can(me, 'config.manage') || can(me, 'integrations.manage')],
    ['staff', 'Сотрудники', can(me, 'staff.view')],
    ['roles', 'Роли и права', can(me, 'roles.manage')],
    ['retention', 'Возврат клиентов', can(me, 'retention.manage')],
    ['reviews', 'Обзоры', can(me, 'crm.work') || can(me, 'dash.view') || can(me, 'ai.review')],
    ['stafftime', 'График и зарплата', true],
    ['config', 'Настройки клуба', can(me, 'config.manage') || can(me, 'sales.manage')],
    ['telephony', 'Телефония', can(me, 'plan.manage') || can(me, 'integrations.manage')],
    ['onboarding', 'Подключение клубов', can(me, 'clubs.manage')],
    ['notes', 'Журнал замечаний', can(me, '*')],
    ['activity', 'Статистика сотрудников', (me.allClubs && can(me, '*')) || (!me.allClubs && me.roles.some((r) => r.code === 'gm'))],
    ['usage', 'Использование', me.allClubs && (can(me, '*') || me.roles.some((r) => r.code === 'admin'))],
    ['privacy', 'Защита данных', can(me, 'data.protect')],
    ['system', 'Состояние системы', can(me, 'system.monitor')],
    ['help', 'Помощь', true],
    ['profile', 'Профиль', true],
  ];
  // Право на раздел (t[2]) — можно открыть по ссылке и из отчёта; в меню — только разделы своей роли (roleMenu.ts)
  const allowed = tabs.filter((t) => t[2]);
  const visible = allowed.filter((t) => inRoleMenu(me, t[0]));
  // Открыт ли раздел этой роли: кнопки «Открыть …» на чужой раздел не показываем (повторная проверка CRM 18.11.2026, п. 11)
  const canTab = (t: string) => allowed.some((x) => x[0] === t);
  const tabLabel = tabs.find((t) => t[0] === tab)?.[1] ?? tab;
  // Статистика использования: какой раздел открыли (без содержимого экрана)
  useEffect(() => { api('POST', '/api/usage/view', { tab, label: tabLabel }).catch(() => null); }, [tab]);
  // Нижняя панель на телефоне: главные разделы роли под большим пальцем, остальное — в «Ещё»
  // Свой набор для каждой роли (проверка CRM, п. 10); для нескольких ролей или незнакомой роли — общий список
  const ROLE_BOTTOM: Record<string, Tab[]> = {
    owner: ['dash', 'problems', 'finance', 'pnl'], gm: ['dash', 'problems', 'tasks', 'finance'], fin: ['dash', 'finance', 'problems', 'pnl'],
    rop: ['dash', 'sales', 'tasks', 'chats'], manager: ['dash', 'hot', 'tasks', 'chats'], desk: ['desk', 'chats', 'home', 'tasks'],
    trainer: ['trainer', 'schedule', 'home', 'tasks'], admin: ['dash', 'access', 'staff', 'system'], techadmin: ['access', 'import', 'staff', 'system'],
  };
  const PRIMARY: Tab[] = (me.roles.length === 1 && ROLE_BOTTOM[me.roles[0].code]) || ['dash', 'desk', 'trainer', 'hot', 'tasks', 'chats', 'home', 'schedule', 'access', 'problems', 'finance', 'pnl'];
  const bottom = PRIMARY.filter((k) => visible.some((v) => v[0] === k)).slice(0, 4);
  // Главные разделы роли подгружаем заранее, в свободную минуту: они откроются мгновенно и будут работать без связи
  useEffect(() => {
    const PRELOAD: Partial<Record<Tab, () => Promise<unknown>>> = { dash: () => import('./dash.tsx'), desk: () => import('./desk.tsx'), trainer: () => import('./trainer.tsx'),
      hot: () => import('./hot.tsx'), tasks: () => import('./crm.tsx'), chats: () => import('./chat.tsx'), home: () => import('./crm.tsx'), schedule: () => import('./schedule.tsx'),
      access: () => import('./access.tsx'), finance: () => import('./finance.tsx') };
    const run = () => { for (const k of bottom) PRELOAD[k]?.().catch(() => null); import('./crm.tsx').catch(() => null); };
    const w = window as Window & { requestIdleCallback?: (f: () => void) => number };
    const id = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 1500);
    return () => { if (!w.requestIdleCallback) clearTimeout(id); };
  }, [bottom.join()]);
  const short: Partial<Record<Tab, string>> = { sales: 'Продажи', staff: 'Люди', system: 'Система', dash: 'Главная', trainer: 'Мой день', desk: 'Ресепшн', hot: 'Звонить', tasks: 'Задачи', schedule: 'Занятия', chats: 'Чаты', home: 'Клиенты', access: 'Проходы', finance: 'Финансы', problems: 'Проблемы', pnl: 'Прибыль' };
  const icon: Partial<Record<Tab, string>> = { sales: '↗', staff: '☺', system: '♥', dash: '◧', trainer: '◷', desk: '⚑', hot: '☎', tasks: '✓', schedule: '▦', chats: '✉', home: '☺', access: '⇥', finance: '₽', problems: '⚠', pnl: '↗' };
  return (
    <>
      <div className="shell">
      <SideNav items={visible.map(([k, t]) => [k, t])} groupOf={ownerOnly(me) ? { tariffs: 'setup', shop: 'setup', access: 'setup', load: 'money' } : undefined} tab={tab} setTab={(t) => setTab(t as Tab)} open={more}
        brand={<div className="brand"><i />Клубная ОС</div>}
        club={clubs.length === 1 && !me.allClubs ? clubPick('club-pick') : null} />
      <div className="main-col">
      <header className="top">
        {(clubs.length > 1 || (me.allClubs && clubs.length > 0)) && <label className="top-club"><span>Клуб</span>{clubPick('top-club-pick')}</label>}
        <button className="search-btn" onClick={() => setCmdk(true)}><span aria-hidden="true">⌕</span><span className="search-ph">Клиент, сотрудник, договор или раздел</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button>
        <div className="sp"><Suspense fallback={null}><LocalKktAgent me={me} clubId={clubId} /></Suspense><AiButton onOpen={(id) => { setTeamKey((k) => k + 1); go({ tab: 'team', p: { chat: id } }); }} /><TeamButton onOpen={() => setTab('team')} /><NotificationsBell go={go} openPerson={openPerson} /><IncomingCall openPerson={openPerson} />
          <span className="who-me"><span className="ava" aria-hidden="true">{me.full_name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span><span className="who-txt"><b>{me.full_name}</b><small>{roleNames}</small></span></span>
          <button className="btn sm" onClick={logout}>Выйти</button></div>
      </header>
      <main className="wrap">
        <OfflineBar />
        <UpdateBanner />
        {!allowed.some((t) => t[0] === tab) ? <NoAccess label={tabLabel} home={() => setTab(firstTab)} /> :
        <Suspense fallback={<p className="muted">Загрузка…</p>}>
        {tab === 'dash' && <DashPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} go={go} canGo={(t) => allowed.some((v) => v[0] === t)} pickClub={setClubId} />}
        {tab === 'hot' && <HotPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'team' && <TeamPage key={teamKey} me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'sales' && <SalesOpsPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'weekly' && <WeeklyPage clubs={clubs} clubId={clubId} />}
        {tab === 'learn' && <LearnPage clubs={clubs} clubId={clubId} />}
        {tab === 'processes' && <ProcessesPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} go={go} canTab={canTab} />}
        {tab === 'calls' && <CallsPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'tasks' && <TasksPage key={ver} me={me} clubId={clubId} openPerson={openPerson} />}
        {tab === 'leads' && <LeadsPage key={ver} me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'board' && <BoardPage key={ver} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'tariffs' && <TariffsPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'shop' && <ShopPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'contracts' && <ContractsAdminPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'finance' && <FinancePage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'fiscal' && <FiscalPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'chats' && <ChatsPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'access' && <AccessPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'messaging' && <MessagingAdmin me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'import' && <ImportPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'pnl' && <PnlPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'intake' && <IntakePage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'activity' && <ActivityPage />}
        {tab === 'usage' && <UsagePage tabs={tabs.map(([k, l]) => [k, l])} />}
        {tab === 'cohorts' && <CohortsPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'load' && <LoadPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'desk' && <DeskPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'trainer' && <TrainerPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'corp' && <CompaniesPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'site' && <SitePage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'pipelines' && <PipelinesAdmin clubs={clubs} clubId={clubId} />}
        {tab === 'home' && <Home key={ver} me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'clubs' && <Clubs me={me} clubs={clubs} reload={reloadClubs} />}
        {tab === 'staff' && <StaffPage me={me} clubs={clubs} />}
        {tab === 'roles' && <RolesPage />}
        {tab === 'stafftime' && <StaffTimePage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'payouts' && <StaffTimePage key="payouts" me={me} clubs={clubs} clubId={clubId} only="payroll" />}
        {tab === 'problems' && <ProblemsPage me={me} clubs={clubs} clubId={clubId} go={go} canGo={(t: string) => allowed.some((v) => v[0] === t)} openPerson={openPerson} />}
        {tab === 'config' && <ConfigPage me={me} clubs={clubs} clubId={clubId} />}
        {tab === 'telephony' && <PbxSettings clubs={clubs} clubId={clubId} />}
        {tab === 'schedule' && <SchedulePage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'retention' && <RetentionPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'onboarding' && <OnboardingPage me={me} clubId={clubId} go={(t) => setTab(t as Tab)} canTab={canTab} reloadClubs={reloadClubs} />}
        {tab === 'privacy' && <PrivacyPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'system' && <SystemPage />}
        {tab === 'help' && <HelpPage me={me} clubs={clubs} clubId={clubId} page={tab} tabs={visible.map((v) => v[0])} />}
        {tab === 'reviews' && <ReviewsPage me={me} clubs={clubs} clubId={clubId} openPerson={openPerson} />}
        {tab === 'notes' && <TestNotesPage me={me} />}
        {tab === 'profile' && <ProfilePage me={me} passwordForm={<ChangePassword me={me} onDone={() => { alertOk('Пароль изменён'); setTab(firstTab); }} />} />}
        </Suspense>}
        {me.isTester && <TestNotesWidget me={me} tab={tab} tabLabel={tabLabel} personOpen={!!personId} clubId={clubId} />}
        <ReportProblem tab={tab} tabLabel={tabLabel} clubId={clubId} openHelp={() => go({ tab: 'help', p: { view: 'support' } })} />
      </main>
      </div>
      </div>
      <CommandPalette items={visible.map(([k, t]) => [k, t])} open={cmdk} setOpen={setCmdk} setTab={(t) => setTab(t as Tab)} openPerson={openPerson} canPersons={can(me, 'persons.view')} />
      <nav className="bottom-nav" aria-label="Главные разделы">
        {bottom.map((k) => <button key={k} aria-pressed={tab === k && !more} onClick={() => setTab(k)}><span aria-hidden="true">{icon[k]}</span>{short[k]}</button>)}
        <button aria-pressed={more || !bottom.includes(tab)} onClick={() => { setMore(!more); window.scrollTo(0, 0); }}><span aria-hidden="true">☰</span>Ещё</button>
      </nav>
      {personId && <Suspense fallback={null}><PersonCard me={me} id={personId} onClose={closePerson} /></Suspense>}
    </>
  );
}


/** Раздел закрыт для роли (кнопка, ссылка или уведомление привели не туда): понятное сообщение вместо пустой страницы */
function NoAccess({ label, home }: { label: string; home: () => void }) {
  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
      <b>Раздел «{label}» не для вашей роли</b>
      <p className="small muted" style={{ margin: 0 }}>Его ведут руководители. Всё, что нужно вам, — на главном экране и в разделах меню слева. Если вам сюда действительно нужно, напишите управляющему в мессенджере.</p>
      <div><button className="btn pri" onClick={home}>На главный экран</button></div>
    </div>
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
      if (trainerOnly(me)) qs.set('mine', '1');
      api<Person[]>('GET', `/api/persons?${qs}`).then(setPersons).catch(() => setPersons([]));
    }, 250);
    return () => clearTimeout(t);
  }, [clubId, q]);
  const club = clubs.find((c) => c.id === clubId);
  // Колонка «Клуб» нужна, только когда в списке клиенты нескольких клубов
  const manyClubs = clubId === 'all' && clubs.length > 1;
  return (
    <>
      <div className="row between">
        <div><div className="lbl">{club ? MODEL[club.salesModel] : 'Все клубы сети'}</div><h1>{club ? club.name : 'Вся сеть'}</h1></div>
      </div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по имени или телефону" aria-label="Поиск клиента" style={{ maxWidth: 420 }} />
      <p className="small" style={{ margin: 0 }}>{trainerOnly(me) ? 'Видны клиенты, записанные на ваши занятия за 90 дней и вперёд.' : `Видны клиенты ${me.allClubs ? 'всей сети' : 'вашего клуба'}.`} Нажмите на имя, чтобы открыть карточку.</p>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Клиент</th><th>Категория</th>{manyClubs && <th>Клуб</th>}<th>Телефон</th></tr></thead>
        <tbody>{persons.map((p) => <tr key={p.id}><td><button className="btn sm" onClick={() => openPerson(p.id)}>{p.fullName}</button></td><td><span className="chip acc">{p.segment}</span></td>{manyClubs && <td>{p.clubName}</td>}<td className="num">{p.phone}</td></tr>)}</tbody>
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
            <div className="row between"><h2>{c.name}</h2><span>{c.isDemo && <span className="chip">демо</span>} <span className="chip acc">{MODEL_SHORT[c.salesModel]}</span></span></div>
            <p className="muted" style={{ margin: '4px 0 10px' }}>{c.address || 'адрес не указан'} · сотрудников: {c.staffCount} · клиентов: {c.personsCount}</p>
            <label className="f">Модель продаж
              <select className="f" value={c.salesModel} onChange={(e) => changeModel(c, e.target.value)}>
                <option value="term">{MODEL.term}</option><option value="subscription">{MODEL.subscription}</option>
              </select>
            </label>
            <p className="small">При смене модели действующие договоры сохраняют условия, новый набор плана применяется со следующего периода.</p>
            <p className="small muted" style={{ marginTop: 8 }}>Норма ответа на заявку: {c.firstResponseMinutes} мин. Её задают РОП и управляющий в «Отдел продаж → Настройки».</p>
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
  const [role, setRole] = useState('');
  const [clubId, setClubId] = useState('');
  const [err, setErr] = useState('');
  const [issued, setIssued] = useState<{ name: string; login: string; password: string } | null>(null);
  const [sess, setSess] = useState<Staff | null>(null);
  const reload = () => api<Staff[]>('GET', '/api/staff').then(setStaff).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); api<RoleDef[]>('GET', '/api/roles').then((r) => { setRoles(r); setRole((cur) => cur || (r.find((x) => x.code === 'manager' && x.canAssign) ?? r.find((x) => x.canAssign))?.code || ''); }).catch(() => {}); }, []);
  // Учётной записью управляет только тот, кто мог бы выдать все её роли (техадмин — только технические)
  const manageable = (s: Staff) => s.assignments.every((a) => roles.find((r) => r.code === a.role)?.canAssign);
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
              {roles.filter((r) => r.canAssign && (r.code !== 'owner' || can(me, '*')) && (!r.networkWide || me.allClubs)).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></label>
            <label className="f">Клуб<select className="f" value={roleDef?.networkWide ? '' : clubId} disabled={roleDef?.networkWide} onChange={(e) => setClubId(e.target.value)}>
              {roleDef?.networkWide ? <option value="">Вся сеть</option> : clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <button className="btn pri" disabled={!fullName.trim() || !role}>Добавить</button>
          </div>
        </form>
      )}
      {err && <div className="err">{err}</div>}
      {sess && <StaffSessions userId={sess.id} name={sess.fullName} onClose={() => setSess(null)} />}
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Сотрудник</th><th>Логин</th><th>Роль</th><th>Клуб</th><th>Статус</th>{manage && <th />}</tr></thead>
        <tbody>{staff.map((s) => (
          <tr key={s.id}>
            <td>{s.fullName}</td><td className="num">{s.login}</td>
            <td>{s.assignments.map((a) => a.roleName).join(', ')}</td>
            <td>{s.assignments.map((a) => a.clubName ?? 'Вся сеть').join(', ')}</td>
            <td>{s.status === 'active' ? <span className="chip ok">{s.mustChangePassword ? 'ждёт смены пароля' : 'активен'}</span> : <span className="chip bad">заблокирован</span>}</td>
            {manage && <td className="r">{s.id !== me.id && !s.assignments.some((a) => a.role === 'owner') && manageable(s) && (
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                {s.status === 'active' && <button className="btn sm" onClick={() => setSess(s)}>Устройства</button>}
                <button className="btn sm" onClick={() => act(s, 'reset-password')}>Новый пароль</button>
                <button className="btn sm" onClick={() => act(s, s.status === 'active' ? 'block' : 'unblock')}>{s.status === 'active' ? 'Заблокировать' : 'Вернуть'}</button>
              </span>)}</td>}
          </tr>))}</tbody>
      </table></div>
      <p className="small">Заблокированный сотрудник сразу выходит из системы и не может войти, его история и клиенты сохраняются.</p></div>
      {manage && me.allClubs && <LoginSecurity selfId={me.id} />}
    </>
  );
}
