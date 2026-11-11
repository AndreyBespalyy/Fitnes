// Приложение-мессенджер для сотрудников и тренеров. Ставится на телефон по ссылке (без App Store и Google Play),
// вход по логину и паролю CRM. По ссылке-приглашению сначала открывается инструкция по установке для iPhone и Android.
import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import qrcode from 'qrcode-generator';
import { api, ApiError, type Me } from '../api.ts';
import { Avatar, Sheet, TeamChat } from './chat.tsx';
import './team.css';
import './app.css';

const err = (x: unknown) => (x instanceof ApiError ? x.message : 'Нет связи с сервером');
const ua = navigator.userAgent;
const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const platform = isIos ? 'ios' : isAndroid ? 'android' : 'desktop';
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

// Android: предложение браузера «Установить приложение» приходит один раз и сразу — запоминаем его
type InstallEvt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let installEvt: InstallEvt | null = null;
const installListeners = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e as InstallEvt; installListeners.forEach((f) => f()); });

if ('serviceWorker' in navigator && location.hostname !== '127.0.0.1') navigator.serviceWorker.register('/team/sw.js', { scope: '/team/' }).catch(() => {});

const Svg = ({ d, s = 16 }: { d: string; s?: number }) => <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const SHARE = 'M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7';
const ADD = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M12 8v8M8 12h8';
const DOTS = 'M12 5h.01M12 12h.01M12 19h.01';

function App() {
  const params = new URLSearchParams(location.search);
  const token = params.get('i');
  const [guide, setGuide] = useState(() => !!token && !standalone());
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [invite, setInvite] = useState<{ fullName: string | null; login: string | null; clubName: string | null; inviter: string | null } | null>(null);
  const [inviteErr, setInviteErr] = useState('');
  useEffect(() => { api<Me>('GET', '/api/auth/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => {
    if (!token) return;
    api<typeof invite>('GET', `/api/team/invite/${encodeURIComponent(token)}`).then(setInvite).catch((x) => setInviteErr(err(x)));
  }, [token]);
  const leaveGuide = () => { setGuide(false); const u = new URL(location.href); u.searchParams.delete('i'); history.replaceState(null, '', u.toString()); };

  if (guide) return <InstallGuide invite={invite} inviteErr={inviteErr} onSkip={leaveGuide} />;
  if (me === undefined) return <div className="gate"><span className="hint">Загрузка…</span></div>;
  if (me === null) return <Login hint={invite?.login ?? null} onDone={setMe} />;
  if (me.mustChangePassword) return <ChangePassword me={me} onDone={() => setMe({ ...me, mustChangePassword: false })} onLogout={() => setMe(null)} />;
  return <Main me={me} onLogout={() => setMe(null)} openGuide={() => setGuide(true)} />;
}

function Logo({ sub }: { sub?: string }) {
  return <div className="gate-logo"><img src="/team/icon-192.png" alt="" /><span><b>Мессенджер</b><small>{sub ?? 'Рабочая связь сотрудников клуба'}</small></span></div>;
}

function Login({ hint, onDone }: { hint: string | null; onDone: (m: Me) => void }) {
  const [login, setLogin] = useState(hint ?? '');
  const [password, setPassword] = useState('');
  const [e, setE] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault(); setE(''); setBusy(true);
    try { onDone(await api<Me>('POST', '/api/auth/login', { login: login.trim(), password })); } catch (x) { setE(err(x)); } finally { setBusy(false); }
  };
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Logo />
        <h1>Вход</h1>
        <label className="fld">Логин<input autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={login} onChange={(x) => setLogin(x.target.value)} /></label>
        <label className="fld">Пароль<input type="password" autoComplete="current-password" value={password} onChange={(x) => setPassword(x.target.value)} /></label>
        {e && <div className="e" role="alert">{e}</div>}
        <button className="big" disabled={busy || !login || !password}>{busy ? 'Входим…' : 'Войти'}</button>
        <p className="hint">Логин и пароль — те же, что для CRM. Забыли пароль? Спросите управляющего, он выдаст временный.</p>
      </form>
    </div>
  );
}

function ChangePassword({ me, onDone, onLogout }: { me: Me; onDone: () => void; onLogout: () => void }) {
  const [cur, setCur] = useState(''); const [p1, setP1] = useState(''); const [p2, setP2] = useState(''); const [e, setE] = useState('');
  const submit = async (ev: FormEvent) => {
    ev.preventDefault(); setE('');
    if (p1 !== p2) return setE('Новые пароли не совпадают');
    try { await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: p1 }); onDone(); } catch (x) { setE(err(x)); }
  };
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Logo />
        <h1>Придумайте пароль</h1>
        <p className="hint">{me.full_name}, управляющий выдал вам временный пароль. Придумайте свой, не короче 10 символов. Он же подойдёт для входа в CRM.</p>
        <label className="fld">Временный пароль<input type="password" autoComplete="current-password" value={cur} onChange={(x) => setCur(x.target.value)} /></label>
        <label className="fld">Новый пароль<input type="password" autoComplete="new-password" value={p1} onChange={(x) => setP1(x.target.value)} /></label>
        <label className="fld">Повторите новый пароль<input type="password" autoComplete="new-password" value={p2} onChange={(x) => setP2(x.target.value)} /></label>
        {e && <div className="e" role="alert">{e}</div>}
        <button className="big" disabled={!cur || !p1 || !p2}>Сохранить</button>
        <button type="button" className="big ghost" onClick={async () => { await api('POST', '/api/auth/logout').catch(() => {}); onLogout(); }}>Выйти</button>
      </form>
    </div>
  );
}

/* ---------- Push в приложении-мессенджере ---------- */
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/team/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Уведомления запрещены. Разрешите их в настройках телефона для приложения «Мессенджер» и попробуйте снова.');
  const reg = await navigator.serviceWorker.register('/team/sw.js', { scope: '/team/' });
  await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('POST', '/api/team/push/subscribe', sub.toJSON());
}

function Main({ me, onLogout, openGuide }: { me: Me; onLogout: () => void; openGuide: () => void }) {
  const [chat, setChat] = useState<string | null>(() => new URLSearchParams(location.search).get('chat'));
  const [push, setPush] = useState<'on' | 'off' | 'na' | null>(null);
  const [pushErr, setPushErr] = useState('');
  const [hidePush, setHidePush] = useState(() => { try { return localStorage.getItem('team.hidePush') === '1'; } catch { return false; } });
  const [menu, setMenu] = useState(false);
  const inApp = standalone();
  useEffect(() => {
    if (inApp) api('POST', '/api/team/installed', { platform }).catch(() => {});
    if (!pushSupported()) { setPush('na'); return; }
    currentSub().then((s) => setPush(s ? 'on' : 'off')).catch(() => setPush('off'));
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'open') { const c = new URL(e.data.url, location.origin).searchParams.get('chat'); if (c) setChat(c); } };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);
  const turnOn = async () => { setPushErr(''); try { await enablePush(); setPush('on'); } catch (x) { setPushErr(x instanceof ApiError ? x.message : (x as Error).message || 'Не удалось включить уведомления'); } };
  const turnOff = async () => { const s = await currentSub(); if (s) { await api('POST', '/api/team/push/unsubscribe', { endpoint: s.endpoint }).catch(() => {}); await s.unsubscribe().catch(() => {}); } setPush('off'); };
  const logout = async () => { await turnOff().catch(() => {}); await api('POST', '/api/auth/logout').catch(() => {}); onLogout(); };
  const badge = (n: number) => { const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }; try { if (n) void nav.setAppBadge?.(n); else void nav.clearAppBadge?.(); } catch { /* нет значка */ } };
  const roles = me.roles.map((r) => r.name).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  let banner: ReactNode = null;
  if (!inApp && platform !== 'desktop') banner = <div className="app-banner"><span className="sp">Поставьте <b>Мессенджер</b> значком на телефон — так придут уведомления</span><button className="tm-btn sm pri" onClick={openGuide}>Как?</button></div>;
  else if (push === 'off' && !hidePush) banner = (
    <div className="push-card"><span className="sp">{pushErr || 'Включите уведомления, чтобы не пропускать сообщения коллег'}</span><button onClick={turnOn}>Включить</button>
      <button className="x" aria-label="Скрыть" onClick={() => { setHidePush(true); try { localStorage.setItem('team.hidePush', '1'); } catch { /* нет хранилища */ } }}>✕</button></div>);
  return (
    <div className="app">
      <header className="app-top">
        <span className="app-brand"><img src="/team/icon-192.png" alt="" />Мессенджер</span>
        <button className="app-me" onClick={() => setMenu(true)} aria-label="Профиль и настройки"><Avatar name={me.full_name} size={34} /></button>
      </header>
      {banner}
      <TeamChat meId={me.id} initialChat={chat} onUnread={badge} />
      {menu && (
        <Sheet title="Профиль" onClose={() => setMenu(false)}>
          <ul className="tm-people"><li><Avatar name={me.full_name} size={44} /><span className="tm-person"><b>{me.full_name}</b><small>{roles} · {me.login}</small></span></li></ul>
          <h3>Уведомления</h3>
          {push === 'na' ? <p className="tm-muted" style={{ margin: 0 }}>{isIos && !inApp ? 'На iPhone уведомления работают, когда Мессенджер установлен значком на экран «Домой».' : 'Этот браузер не поддерживает уведомления.'}</p>
            : <label className="tm-toggle"><input type="checkbox" checked={push === 'on'} onChange={(x) => (x.target.checked ? turnOn() : turnOff())} /><span>Присылать уведомления о новых сообщениях на этот телефон</span></label>}
          {pushErr && <div className="tm-err">{pushErr}</div>}
          <p className="tm-muted" style={{ margin: 0, fontSize: 13 }}>Чтобы заглушить отдельный чат, откройте его и нажмите на колокольчик. Объявления руководителя приходят всегда.</p>
          <h3>Ещё</h3>
          <button className="tm-btn" onClick={() => { setMenu(false); openGuide(); }}>Как установить на телефон</button>
          <a className="tm-btn" href="/">Открыть CRM</a>
          <button className="tm-btn bad" onClick={logout}>Выйти</button>
        </Sheet>
      )}
    </div>
  );
}

/* ---------- Инструкция по установке ---------- */
function InstallGuide({ invite, inviteErr, onSkip }: { invite: { fullName: string | null; login: string | null; clubName: string | null; inviter: string | null } | null; inviteErr: string; onSkip: () => void }) {
  const [os, setOs] = useState<'ios' | 'android' | 'desktop'>(platform);
  const [canInstall, setCanInstall] = useState(!!installEvt);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const f = () => setCanInstall(true); installListeners.add(f); return () => { installListeners.delete(f); }; }, []);
  const link = location.href;
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { prompt('Скопируйте ссылку', link); } };
  const install = async () => { if (!installEvt) return; await installEvt.prompt(); const r = await installEvt.userChoice; if (r.outcome === 'accepted') { installEvt = null; setCanInstall(false); } };
  const iosOther = isIos && /CriOS|FxiOS|EdgiOS|YaBrowser|OPiOS|Telegram|WhatsApp|Instagram|FBAN|FBAV/.test(ua);
  const qr = (() => { const q = qrcode(0, 'M'); q.addData(link); q.make(); return q.createDataURL(6, 1); })();
  const first = invite?.fullName?.split(' ')[0];
  return (
    <div className="guide">
      <section className="guide-hero">
        <Logo sub={invite?.clubName ?? 'Клубная ОС'} />
        <h1>{first ? `${first}, установите рабочий мессенджер` : 'Установите рабочий мессенджер'}</h1>
        {invite?.inviter && <p className="who">{invite.inviter} приглашает вас в рабочий мессенджер{invite.clubName ? ` (${invite.clubName})` : ''}.</p>}
        <p>Общий чат клуба и вашего отдела, личные сообщения коллегам и объявления управляющего — в одном приложении. Ставится за минуту, без App Store и Google Play.</p>
      </section>
      {inviteErr && <div className="note-warn">{inviteErr}. Инструкция ниже всё равно подходит.</div>}
      <div className="guide-seg" role="group" aria-label="Ваш телефон">
        <button aria-pressed={os === 'ios'} onClick={() => setOs('ios')}>iPhone</button>
        <button aria-pressed={os === 'android'} onClick={() => setOs('android')}>Android</button>
        {platform === 'desktop' && <button aria-pressed={os === 'desktop'} onClick={() => setOs('desktop')}>Компьютер</button>}
      </div>
      {os === 'desktop' && (
        <div className="qr-box">
          <img src={qr} alt="QR-код ссылки на установку" />
          <b>Наведите камеру телефона на код</b>
          <p className="hint">На телефоне откроется эта страница с инструкцией. Мессенджер можно открыть и на компьютере — кнопка внизу.</p>
        </div>
      )}
      {os === 'ios' && <>
        {iosOther && <div className="note-warn">Вы открыли ссылку не в Safari. На iPhone установить приложение можно только из Safari — начните с шага 1.</div>}
        <ol className="steps">
          <li><div><b>Откройте эту страницу в Safari</b><p>Если ссылка открылась в WhatsApp, Telegram или другом браузере, нажмите <span className="kbd"><Svg d={DOTS} s={14} /></span> или значок компаса и выберите «Открыть в Safari». Или скопируйте ссылку и вставьте в Safari.</p>
            <p style={{ marginTop: 8 }}><button className="tm-btn sm" onClick={copy}>{copied ? 'Ссылка скопирована ✓' : 'Скопировать ссылку'}</button></p></div></li>
          <li><div><b>Нажмите «Поделиться»</b><p>Кнопка <span className="kbd"><Svg d={SHARE} s={15} /></span> внизу экрана (на iPad — вверху справа).</p></div></li>
          <li><div><b>Выберите «На экран „Домой“»</b><p>Пролистайте меню вниз до пункта <span className="kbd"><Svg d={ADD} s={15} /> На экран «Домой»</span>.</p></div></li>
          <li><div><b>Нажмите «Добавить»</b><p>Название уже заполнено — «Мессенджер». На экране телефона появится оранжевый значок с облачком.</p></div></li>
          <li><div><b>Откройте Мессенджер со значка и войдите</b><p>Логин и пароль — те же, что для CRM. Приложение предложит включить уведомления — нажмите «Включить» и «Разрешить».</p></div></li>
        </ol>
        <p className="hint">Уведомления на iPhone работают на iOS 16.4 и новее и только в приложении со значка.</p>
      </>}
      {os === 'android' && <>
        {canInstall && <button className="big" onClick={install}>Установить приложение</button>}
        <ol className="steps">
          <li><div><b>Откройте эту страницу в Chrome</b><p>Подойдёт и Яндекс Браузер. Если ссылка открылась внутри WhatsApp или Telegram, нажмите <span className="kbd"><Svg d={DOTS} s={14} /></span> → «Открыть в браузере».</p>
            <p style={{ marginTop: 8 }}><button className="tm-btn sm" onClick={copy}>{copied ? 'Ссылка скопирована ✓' : 'Скопировать ссылку'}</button></p></div></li>
          <li><div><b>Нажмите <span className="kbd"><Svg d={DOTS} s={14} /></span> в правом верхнем углу</b><p>{canInstall ? 'Или просто нажмите оранжевую кнопку «Установить приложение» выше.' : 'Это меню браузера.'}</p></div></li>
          <li><div><b>Выберите «Установить приложение»</b><p>В некоторых телефонах пункт называется «Добавить на главный экран» (в Яндекс Браузере — «Добавить ярлык»).</p></div></li>
          <li><div><b>Подтвердите «Установить»</b><p>Значок «Мессенджер» появится на главном экране и в списке приложений.</p></div></li>
          <li><div><b>Откройте Мессенджер и войдите</b><p>Логин и пароль — те же, что для CRM. Разрешите уведомления, когда приложение спросит.</p></div></li>
        </ol>
      </>}
      <div className="login-box">
        {invite?.login ? <><span className="hint">Ваш логин</span><span className="num">{invite.login}</span></> : <b>Вход — по вашему логину от CRM</b>}
        <span className="hint">Пароль — тот же, что для CRM. Забыли — спросите управляющего, он выдаст временный.</span>
      </div>
      <button className="big ghost" onClick={onSkip}>Открыть в браузере без установки</button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
