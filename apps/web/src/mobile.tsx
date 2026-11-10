// Шаг 16. Мобильное рабочее место: установка на телефон, push-уведомления, мои устройства, работа без связи, звонок в один клик.
import { useEffect, useRef, useState } from 'react';
import { api, clearFailed, onNet, netState, flushQueue, type Me, type NetState } from './api.ts';
import { dt, errText, toast } from './ui.ts';

/* ---------- служебный файл приложения ---------- */
export function registerServiceWorker(onOpen: (url: string) => void) {
  if (!('serviceWorker' in navigator) || location.hostname === '127.0.0.1') return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open') onOpen(e.data.url); });
}

/* ---------- признак «нет связи» ---------- */
export function OfflineBar() {
  const [s, setS] = useState<NetState>(netState());
  useEffect(() => onNet(setS), []);
  if (!s.offline && !s.queued && !s.failed.length) return null;
  return (
    <div className={`netbar ${s.offline ? 'off' : ''}`} role="status" aria-live="polite">
      {s.offline && <span><b>Нет связи.</b> {s.savedAt ? `Показаны данные, сохранённые ${dt(s.savedAt)}.` : 'Показаны сохранённые данные.'}</span>}
      {s.queued > 0 && <span>{s.offline ? 'Ждут отправки' : 'Отправляю'}: {s.queued} {s.queued === 1 ? 'действие' : 'действий'}. Отправятся сами, когда появится связь.</span>}
      {!s.offline && s.queued > 0 && <button className="btn sm" onClick={() => flushQueue()}>Отправить сейчас</button>}
      {s.failed.length > 0 && <span className="bad">Не принято сервером: {s.failed.map((f) => `${f.label} — ${f.message}`).join('; ')} <button className="btn sm" onClick={clearFailed}>Понятно</button></span>}
    </div>
  );
}

/* ---------- звонок в один клик ---------- */
export function DialButton({ personId, label = 'Позвонить', className = 'btn sm' }: { personId: string; label?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const dial = async () => {
    setBusy(true);
    try {
      const r = await api<{ phone: string }>('POST', `/api/persons/${personId}/dial`);
      window.location.href = `tel:${r.phone}`;
    } catch (x) { toast(errText(x)); } finally { setBusy(false); }
  };
  return <button className={className} onClick={dial} disabled={busy} title="Номер откроется в телефоне. Звонок записывается в журнал">📞 {label}</button>;
}

/* ---------- профиль: пароль, уведомления, устройства, установка ---------- */
const b64ToBytes = (s: string) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

type Prefs = { pushTasks: boolean; pushLeads: boolean; pushMessages: boolean };
type Sess = { id: string; device: string | null; createdAt: string; lastSeenAt: string; current?: boolean; push: boolean };

export function deviceName(ua: string | null) {
  if (!ua) return 'Неизвестное устройство';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Устройство';
  const br = /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'браузер';
  return `${os}, ${br}`;
}

function PushBlock() {
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [on, setOn] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Prefs>('GET', '/api/me/prefs').then(setPrefs).catch(() => {});
    if (!supported) { setOn(false); return; }
    navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => setOn(false));
  }, []);
  const enable = async () => {
    setErr('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setErr('Уведомления запрещены в настройках телефона или браузера. Разрешите их для этого сайта и попробуйте снова.'); return; }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      await api('POST', '/api/push/subscribe', sub.toJSON());
      setOn(true); toast('Уведомления включены');
    } catch (x) { setErr(x instanceof Error && !('code' in x) ? 'Не удалось включить уведомления на этом устройстве' : errText(x)); }
  };
  const disable = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    setOn(false); toast('Уведомления на этом устройстве выключены');
  };
  const test = async () => { try { await api('POST', '/api/push/test'); toast('Отправлено. Уведомление придёт через несколько секунд'); } catch (x) { setErr(errText(x)); } };
  const setPref = async (k: keyof Prefs, v: boolean) => { try { setPrefs(await api<Prefs>('PUT', '/api/me/prefs', { [k]: v })); } catch (x) { setErr(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ margin: 0 }}>Уведомления</h2>
      {!supported ? (
        <p className="small" style={{ margin: 0 }}>{isIos() && !standalone()
          ? 'На iPhone уведомления работают, когда приложение установлено на экран «Домой» (см. ниже). Откройте его с экрана «Домой» и включите уведомления здесь.'
          : 'Этот браузер не поддерживает уведомления. Откройте систему в Chrome, Safari или Яндекс Браузере.'}</p>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {on ? <><span className="chip ok">включены на этом устройстве</span><button className="btn sm" onClick={test}>Проверить</button><button className="btn sm" onClick={disable}>Выключить</button></>
            : <button className="btn pri" onClick={enable} disabled={on === null}>Включить уведомления на этом устройстве</button>}
        </div>
      )}
      {prefs && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="small muted">Что присылать (на всех ваших устройствах):</span>
          {([['pushLeads', 'Новые лиды — сразу, чтобы успеть ответить вовремя'], ['pushTasks', 'Задачи — за 10 минут до срока'], ['pushMessages', 'Сообщения клиентов в Telegram и WhatsApp']] as [keyof Prefs, string][]).map(([k, t]) => (
            <label key={k} className="row small" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><input type="checkbox" style={{ width: 'auto', flex: 'none', marginTop: 2 }} checked={prefs[k]} onChange={(e) => setPref(k, e.target.checked)} />{t}</label>
          ))}
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function DevicesBlock() {
  const [list, setList] = useState<Sess[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<Sess[]>('GET', '/api/me/sessions').then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  const revoke = async (s: Sess) => {
    if (!confirm(`Завершить сеанс на устройстве «${deviceName(s.device)}»? На нём придётся войти заново.`)) return;
    try { await api('POST', `/api/me/sessions/${s.id}/revoke`); toast('Сеанс завершён'); load(); } catch (x) { setErr(errText(x)); }
  };
  const others = async () => {
    if (!confirm('Выйти на всех устройствах, кроме этого?')) return;
    try { const r = await api<{ revoked: number }>('POST', '/api/me/sessions/revoke-others'); toast(`Завершено сеансов: ${r.revoked}`); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0 }}>Мои устройства</h2>
        {list.length > 1 && <button className="btn sm" onClick={others}>Выйти на всех, кроме этого</button>}</div>
      <p className="small muted" style={{ margin: 0 }}>Потеряли телефон — завершите на нём сеанс здесь или попросите управляющего. Данные на телефоне станут недоступны, уведомления на него прекратятся.</p>
      {list.map((s) => (
        <div key={s.id} className="item row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div><b>{deviceName(s.device)}</b> {s.current && <span className="chip ok">это устройство</span>} {s.push && <span className="chip">уведомления</span>}
            <div className="small muted">вход {dt(s.createdAt)} · последний раз {dt(s.lastSeenAt)}</div></div>
          {!s.current && <button className="btn sm" onClick={() => revoke(s)}>Завершить</button>}
        </div>
      ))}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function InstallBlock() {
  const [prompt, setPrompt] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setPrompt(e as Event & { prompt: () => Promise<void> }); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (standalone()) return <div className="card"><h2 style={{ margin: 0 }}>Приложение на телефоне</h2><p className="small" style={{ margin: '6px 0 0' }}>Вы работаете в установленном приложении.</p></div>;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>Установить на телефон</h2>
      {prompt && <div><button className="btn pri" onClick={() => prompt.prompt().then(() => setPrompt(null))}>Установить приложение</button></div>}
      <div className="small"><b>iPhone (Safari):</b> кнопка «Поделиться» внизу экрана → «На экран „Домой“» → «Добавить». Затем откройте «Клубная ОС» с экрана «Домой» и включите уведомления.</div>
      <div className="small"><b>Android (Chrome или Яндекс Браузер):</b> меню ⋮ → «Установить приложение» или «Добавить на главный экран».</div>
      <div className="small muted">Магазины приложений не нужны: обновления приходят сами при следующем открытии.</div>
    </div>
  );
}

export function ProfilePage({ me, passwordForm }: { me: Me; passwordForm: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card"><h2 style={{ margin: 0 }}>{me.full_name}</h2><div className="small muted">Логин {me.login} · {me.roles.map((r) => r.name).join(', ')}</div></div>
      <InstallBlock />
      <PushBlock />
      <DevicesBlock />
      {passwordForm}
    </div>
  );
}

/* ---------- сеансы сотрудника (для управляющего) ---------- */
export function StaffSessions({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const [list, setList] = useState<Sess[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Sess[]>('GET', `/api/staff/${userId}/sessions`).then(setList).catch((x) => setErr(errText(x)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { load(); ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [userId]);
  const revokeAll = async () => {
    if (!confirm(`Завершить все сеансы сотрудника ${name}? Ему придётся войти заново на всех устройствах.`)) return;
    try { const r = await api<{ revoked: number }>('POST', `/api/staff/${userId}/sessions/revoke`); toast(`Завершено сеансов: ${r.revoked}`); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div ref={ref} className="card" style={{ display: 'grid', gap: 8, borderColor: 'var(--accent)', scrollMarginTop: 70 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0 }}>Устройства: {name}</h2><button className="btn sm" onClick={onClose}>Закрыть</button></div>
      {list && !list.length && <p className="small muted" style={{ margin: 0 }}>Активных сеансов нет.</p>}
      {list?.map((s) => <div key={s.id} className="small"><b>{deviceName(s.device)}</b>{s.push ? ' · уведомления' : ''} · вход {dt(s.createdAt)} · последний раз {dt(s.lastSeenAt)}</div>)}
      {!!list?.length && <div><button className="btn pri sm" onClick={revokeAll}>Завершить все сеансы</button></div>}
      <p className="small muted" style={{ margin: 0 }}>Для увольнения используйте «Заблокировать»: это и завершает сеансы, и запрещает вход. «Завершить все сеансы» — когда сотрудник потерял телефон.</p>
      {err && <div className="err">{err}</div>}
    </div>
  );
}
