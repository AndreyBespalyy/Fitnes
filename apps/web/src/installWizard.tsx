// Пошаговая инструкция «Установить на телефон» — для CRM («Клубная ОС») и для Мессенджера сотрудников.
// Сначала выбор телефона, потом браузера, дальше по одному шагу с картинкой-подсказкой и кнопками «Назад / Далее».
// На компьютере — QR-код и ссылка, которую нужно открыть на телефоне (замечания тестировщика №24–25, 17.11.2026).
import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import './installWizard.css';

export type InstallApp = 'crm' | 'team';
type Os = 'ios' | 'android' | 'desktop';
type Step = { t: string; d: string; ico?: string };
type Browser = { id: string; name: string; steps: (app: AppInfo) => Step[] };
type AppInfo = { name: string; url: string };
type InstallEvt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const isIos = /iPhone|iPad|iPod/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
export const detectOs = (): Os => (isIos ? 'ios' : isAndroid ? 'android' : 'desktop');
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
const inMessenger = /Telegram|WhatsApp|Instagram|FBAN|FBAV|VKClient|OKApp/.test(ua);

function detectBrowser(os: Os): string {
  if (inMessenger) return 'inapp';
  if (/YaBrowser|YaApp/.test(ua)) return 'yandex';
  if (os === 'ios') return /CriOS/.test(ua) ? 'chrome' : /FxiOS|EdgiOS|OPiOS/.test(ua) ? 'other' : 'safari';
  if (os === 'android') return /SamsungBrowser/.test(ua) ? 'samsung' : /Firefox/.test(ua) ? 'firefox' : /Chrome/.test(ua) ? 'chrome' : 'other';
  return /Firefox/.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'chrome' : /Chrome/.test(ua) ? 'chrome' : /Safari/.test(ua) ? 'safari' : 'chrome';
}

// Вход и уведомления — общий последний шаг
const finish = (a: AppInfo, os: Os): Step => ({ ico: '🔔', t: `Откройте «${a.name}» со значка и войдите`,
  d: `Логин и пароль — те же, что для CRM. Когда приложение спросит про уведомления, нажмите «Разрешить».${os === 'ios' ? ' На iPhone уведомления работают на iOS 16.4 и новее и только в приложении со значка.' : ''}` });
const openIn = (where: string): Step => ({ ico: '🔗', t: `Откройте ссылку в ${where}`,
  d: `Нажмите «Скопировать ссылку» внизу, откройте ${where}, нажмите на адресную строку, вставьте ссылку и перейдите по ней.` });

const IOS: Browser[] = [
  { id: 'safari', name: 'Safari', steps: (a) => [
    { ico: '⬆️', t: 'Нажмите «Поделиться»', d: 'Квадрат со стрелкой вверх — внизу экрана по центру (на iPad — вверху справа). Если панели не видно, коснитесь низа экрана.' },
    { ico: '➕', t: 'Выберите «На экран „Домой“»', d: 'Пролистайте открывшееся меню вниз — пункт с квадратом и плюсом.' },
    { ico: '✅', t: 'Нажмите «Добавить»', d: `Справа вверху. Название уже заполнено — «${a.name}». На экране телефона появится значок.` },
    finish(a, 'ios')] },
  { id: 'chrome', name: 'Chrome', steps: (a) => [
    { ico: '⬆️', t: 'Нажмите «Поделиться»', d: 'Значок квадрата со стрелкой — в правой части адресной строки вверху.' },
    { ico: '➕', t: 'Выберите «На экран „Домой“»', d: 'Пролистайте меню вниз. Если пункта нет — у вас старая версия iOS: откройте ссылку в Safari (выберите Safari выше).' },
    { ico: '✅', t: 'Нажмите «Добавить»', d: `Значок «${a.name}» появится на экране «Домой».` },
    finish(a, 'ios')] },
  { id: 'yandex', name: 'Яндекс Браузер', steps: (a) => [openIn('Safari'), ...IOS[0].steps(a)] },
  { id: 'inapp', name: 'Telegram, WhatsApp и др.', steps: (a) => [
    { ico: '🧭', t: 'Выйдите из мессенджера в Safari', d: 'Ссылка открылась внутри Telegram или WhatsApp — оттуда установить нельзя. Нажмите ⋯ или значок компаса вверху и выберите «Открыть в Safari». Если такого пункта нет — скопируйте ссылку и вставьте её в Safari.' },
    ...IOS[0].steps(a)] },
];
const ANDROID: Browser[] = [
  { id: 'chrome', name: 'Chrome', steps: (a) => [
    { ico: '⋮', t: 'Нажмите ⋮ в правом верхнем углу', d: 'Это меню браузера — три точки рядом с адресной строкой.' },
    { ico: '📲', t: 'Выберите «Установить приложение»', d: 'В некоторых телефонах пункт называется «Добавить на главный экран».' },
    { ico: '✅', t: 'Подтвердите «Установить»', d: `Значок «${a.name}» появится на главном экране и в списке приложений.` },
    finish(a, 'android')] },
  { id: 'yandex', name: 'Яндекс Браузер', steps: (a) => [
    { ico: '⋮', t: 'Нажмите ⋮ справа от адресной строки', d: 'В новых версиях меню открывается кнопкой с тремя полосками внизу экрана.' },
    { ico: '📲', t: 'Выберите «Добавить ярлык» или «Установить приложение»', d: 'Иногда пункт называется «Добавить на главный экран».' },
    { ico: '✅', t: 'Нажмите «Добавить»', d: `Значок «${a.name}» появится на главном экране.` },
    finish(a, 'android')] },
  { id: 'samsung', name: 'Samsung Internet', steps: (a) => [
    { ico: '☰', t: 'Нажмите ☰ внизу справа', d: 'Если в адресной строке есть значок со стрелкой вниз — можно нажать его и сразу перейти к шагу 3.' },
    { ico: '📲', t: 'Выберите «Добавить страницу на» → «Главный экран»', d: 'В некоторых версиях пункт называется «Установить».' },
    { ico: '✅', t: 'Нажмите «Добавить»', d: `Значок «${a.name}» появится на главном экране.` },
    finish(a, 'android')] },
  { id: 'firefox', name: 'Firefox', steps: (a) => [
    { ico: '⋮', t: 'Нажмите ⋮ в правом верхнем углу', d: 'В некоторых версиях меню внизу справа.' },
    { ico: '📲', t: 'Выберите «Установить» или «Добавить на главный экран»', d: '' },
    { ico: '✅', t: 'Подтвердите «Добавить»', d: `Значок «${a.name}» появится на главном экране.` },
    finish(a, 'android')] },
  { id: 'inapp', name: 'Telegram, WhatsApp и др.', steps: (a) => [
    { ico: '🧭', t: 'Откройте ссылку в Chrome', d: 'Ссылка открылась внутри мессенджера — оттуда установить нельзя. Нажмите ⋮ вверху справа → «Открыть в браузере» (или «Открыть в Chrome»).' },
    ...ANDROID[0].steps(a)] },
];
const DESKTOP: Browser[] = [
  { id: 'chrome', name: 'Chrome, Edge, Яндекс', steps: (a) => [
    { ico: '⊕', t: 'Нажмите значок установки в адресной строке', d: 'Справа в адресной строке — значок монитора со стрелкой или ⊕. Нет значка — откройте меню ⋮ → «Сохранить и поделиться» → «Установить страницу как приложение» (в Яндекс Браузере — меню → «Установить приложение»).' },
    { ico: '✅', t: 'Нажмите «Установить»', d: `«${a.name}» откроется отдельным окном, значок появится на рабочем столе и в Dock / меню «Пуск».` }] },
  { id: 'safari', name: 'Safari на Mac', steps: (a) => [
    { ico: '📁', t: 'Откройте меню «Файл» → «Добавить в Dock»', d: 'Нужна macOS 14 Sonoma или новее. В старых версиях добавьте страницу в закладки (⌘D).' },
    { ico: '✅', t: 'Нажмите «Добавить»', d: `Значок «${a.name}» появится в Dock.` }] },
  { id: 'firefox', name: 'Firefox', steps: () => [
    { ico: '⭐', t: 'Добавьте страницу в закладки', d: 'Firefox на компьютере не умеет ставить сайты как приложения. Нажмите ⌘D (на Windows — Ctrl+D) или откройте страницу в Chrome.' }] },
];
const BROWSERS: Record<Os, Browser[]> = { ios: IOS, android: ANDROID, desktop: DESKTOP };
const OS_NAME: [Os, string, string][] = [['ios', 'iPhone / iPad', '📱'], ['android', 'Android', '🤖'], ['desktop', 'Компьютер', '💻']];

export function installLink(app: InstallApp) {
  return `${location.origin}${app === 'team' ? '/team/?guide=1' : '/?install=1'}`;
}

/** Блок «Откройте эту ссылку на телефоне»: QR-код, копирование и отправка */
export function PhoneLink({ app, link = installLink(app) }: { app: InstallApp; link?: string }) {
  const [copied, setCopied] = useState(false);
  const q = qrcode(0, 'M'); q.addData(link); q.make();
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { prompt('Скопируйте ссылку', link); } };
  const send = async () => { try { await navigator.share({ title: 'Установить на телефон', url: link }); } catch { /* отменили */ } };
  return (
    <div className="iw-link">
      <img src={q.createDataURL(5, 1)} alt="QR-код ссылки для телефона" />
      <div className="iw-link-t">
        <b>Откройте эту ссылку на телефоне</b>
        <span>Наведите камеру телефона на QR-код — откроется эта же инструкция, и установка займёт минуту. Или отправьте ссылку себе.</span>
        <code>{link}</code>
        <div className="iw-row">
          <button type="button" className="iw-btn pri" onClick={copy}>{copied ? 'Ссылка скопирована ✓' : 'Скопировать ссылку'}</button>
          {'share' in navigator && <button type="button" className="iw-btn" onClick={send}>Отправить…</button>}
        </div>
      </div>
    </div>
  );
}

// Android/компьютер: браузер сам предлагает «Установить» — ловим это предложение заранее
let installEvt: InstallEvt | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e as InstallEvt; listeners.forEach((f) => f()); });

/** Сама пошаговая инструкция */
export function InstallWizard({ app, compact = false, link = installLink(app) }: { app: InstallApp; compact?: boolean; link?: string }) {
  const info: AppInfo = { name: app === 'team' ? 'Мессенджер' : 'Клубная ОС', url: link };
  const dev = detectOs();
  // На компьютере обычно ставят на телефон: сначала ссылка для телефона, устройство выбирают сами
  const [os, setOsState] = useState<Os | null>(dev === 'desktop' ? null : dev);
  const [br, setBr] = useState<string>(() => detectBrowser(dev));
  const [step, setStep] = useState(0);
  const [canInstall, setCanInstall] = useState(!!installEvt);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const f = () => setCanInstall(true); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  const setOs = (o: Os) => { setOsState(o); setBr(o === dev ? detectBrowser(o) : BROWSERS[o][0].id); setStep(0); };
  const browsers = os ? BROWSERS[os] : [];
  const b = browsers.find((x) => x.id === br) ?? browsers[0];
  const steps = b ? b.steps(info) : [];
  const s = steps[Math.min(step, steps.length - 1)];
  const last = step >= steps.length - 1;
  const here = os === dev;
  const install = async () => { if (!installEvt) return; await installEvt.prompt(); const r = await installEvt.userChoice; if (r.outcome === 'accepted') { installEvt = null; setCanInstall(false); } };
  const copy = async () => { try { await navigator.clipboard.writeText(info.url); setCopied(true); } catch { prompt('Скопируйте ссылку', info.url); } };

  if (isStandalone() && here) return <div className="iw"><div className="iw-done">✅ «{info.name}» уже установлен на этом устройстве — вы работаете в приложении.</div></div>;
  return (
    <div className={`iw${compact ? ' compact' : ''}`}>
      <div className="iw-q">1. Какое у вас устройство?</div>
      <div className="iw-seg" role="group" aria-label="Устройство">
        {OS_NAME.map(([k, l, ic]) => <button type="button" key={k} aria-pressed={os === k} onClick={() => setOs(k)}>{ic && <span aria-hidden="true">{ic} </span>}{l}</button>)}
      </div>
      {!os && <PhoneLink app={app} link={link} />}
      {os && b && s && <>
      {dev === 'desktop' && os !== 'desktop' && <PhoneLink app={app} link={link} />}
      <div className="iw-q">2. В каком браузере {os === 'desktop' ? 'вы работаете' : 'открыта ссылка'}?</div>
      <div className="iw-seg" role="group" aria-label="Браузер">
        {browsers.map((x) => <button type="button" key={x.id} aria-pressed={b.id === x.id} onClick={() => { setBr(x.id); setStep(0); }}>{x.name}</button>)}
      </div>
      {here && canInstall && (os === 'android' || os === 'desktop') && (
        <div className="iw-fast"><button type="button" className="iw-btn pri big" onClick={install}>Установить «{info.name}» в один клик</button><span>Не сработало — сделайте по шагам ниже.</span></div>
      )}
      <div className="iw-q">3. Сделайте по шагам</div>
      <ol className="iw-dots" aria-label="Шаги">
        {steps.map((x, i) => <li key={i}><button type="button" aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : ''} onClick={() => setStep(i)} title={x.t}>{i < step ? '✓' : i + 1}</button></li>)}
      </ol>
      <div className="iw-step" aria-live="polite">
        <div className="iw-ico" aria-hidden="true">{s.ico}</div>
        <div>
          <div className="iw-n">Шаг {step + 1} из {steps.length}</div>
          <b>{s.t}</b>
          {s.d && <p>{s.d}</p>}
          {/Скопировать ссылку|Откройте ссылку/.test(s.t + s.d) && <button type="button" className="iw-btn" onClick={copy}>{copied ? 'Ссылка скопирована ✓' : 'Скопировать ссылку'}</button>}
        </div>
      </div>
      <div className="iw-row between">
        <button type="button" className="iw-btn" disabled={step === 0} onClick={() => setStep(step - 1)}>← Назад</button>
        {last ? <span className="iw-ok">Готово! Если что-то не получилось — нажмите на номер шага и пройдите заново.</span>
          : <button type="button" className="iw-btn pri" onClick={() => setStep(step + 1)}>Сделал, дальше →</button>}
      </div>
      </>}
    </div>
  );
}
