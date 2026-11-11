// Уведомления внутри CRM: колокольчик в шапке. Сюда приходят сигналы и сводки отдела продаж
// (заявка ждёт, сигнал РОПу, окно продлений, новички, недельная сводка, маркетинг). Те же уведомления приходят push-ом на телефон.
// Решение Андрея 12.11.2026: вся связь — в CRM, без Telegram.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type Go } from './api.ts';

type Note = { id: string; kind: string; title: string; body: string | null; link: Go | null; createdAt: string; readAt: string | null };

const when = (s: string) => {
  const d = new Date(s); const now = new Date();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${t}`;
};

export function NotificationsBell({ go }: { go: (g: Go) => void }) {
  const [items, setItems] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState<number | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const load = () => api<{ items: Note[]; unread: number }>('GET', '/api/notifications').then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const mark = async (ids?: string[]) => {
    await api('POST', '/api/notifications/read', ids ? { ids } : {}).catch(() => {});
    const at = new Date().toISOString();
    setItems((xs) => xs.map((x) => (!ids || ids.includes(x.id)) && !x.readAt ? { ...x, readAt: at } : x));
    setUnread((n) => (ids ? Math.max(0, n - ids.filter((id) => items.find((x) => x.id === id && !x.readAt)).length) : 0));
  };
  const openNote = (n: Note) => {
    if (!n.readAt) mark([n.id]);
    if (n.link?.tab) { setOpen(false); go({ tab: n.link.tab, p: n.link.p }); }
  };

  return (
    <div className="bell" ref={box}>
      <button type="button" aria-label={`Уведомления${unread ? `: непрочитанных ${unread}` : ''}`} aria-expanded={open} onClick={(e) => { setTop(e.currentTarget.getBoundingClientRect().bottom + 8); setOpen(!open); if (!open) load(); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread > 0 && <b className="bell-n">{unread > 99 ? '99+' : unread}</b>}
      </button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Уведомления" style={{ '--bell-top': `${top ?? 58}px` } as CSSProperties}>
          <div className="bell-head">
            <strong>Уведомления</strong>
            {unread > 0 && <button type="button" className="link" onClick={() => mark()}>Прочитать все</button>}
          </div>
          {items.length === 0 && <p className="small" style={{ padding: '12px 14px', margin: 0 }}>Пока ничего. Сюда приходят сигналы по заявкам, продлениям и сводки отдела продаж.</p>}
          <ul>
            {items.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'new'}>
                <button type="button" onClick={() => openNote(n)}>
                  <span className="bell-t">{n.title}</span>
                  {n.body && <span className="bell-b">{n.body}</span>}
                  <span className="bell-w">{when(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
