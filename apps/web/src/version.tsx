// Новая версия CRM: если вкладка открыта давно (телефон, планшет на ресепшне), она не знает об обновлении.
// Раз в 5 минут и при возврате на вкладку сверяем главный файл приложения с сервером; если он сменился — предлагаем обновить.
import { useEffect, useState } from 'react';

const mainOf = (html: string) => html.match(/\/assets\/main-[^"']+\.js/)?.[0] ?? null;

export function UpdateBanner() {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const mine = [...document.scripts].map((s) => s.src).find((s) => /\/assets\/main-/.test(s));
    if (!mine) return; // режим разработки
    const cur = new URL(mine).pathname;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== 'visible') return;
      try {
        const srv = mainOf(await (await fetch('/', { cache: 'no-store' })).text());
        if (srv && srv !== cur) setFresh(true);
      } catch { /* нет связи — проверим позже */ }
    };
    const t = setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    check();
    return () => { stop = true; clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, []);
  if (!fresh) return null;
  return (
    <div className="upd-bar" role="status">
      <span>Вышла новая версия CRM</span>
      <button className="btn sm pri" onClick={() => location.reload()}>Обновить</button>
    </div>
  );
}
