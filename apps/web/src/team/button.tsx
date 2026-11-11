// Значок мессенджера в шапке CRM (лёгкий файл: грузится сразу, сам мессенджер — по открытию раздела)
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

/** Значок непрочитанных сообщений в шапке CRM: нажатие открывает мессенджер */
export function TeamButton({ onOpen }: { onOpen: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => api<{ count: number }>('GET', '/api/team/unread').then((r) => setN(r.count)).catch(() => {});
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="bell">
      <button type="button" onClick={onOpen} aria-label={`Мессенджер${n ? `: непрочитанных ${n}` : ''}`} title="Мессенджер">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /></svg>
        {n > 0 && <b className="bell-n" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>{n > 99 ? '99+' : n}</b>}
      </button>
    </div>
  );
}
