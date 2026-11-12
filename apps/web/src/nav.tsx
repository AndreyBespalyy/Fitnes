// Оформление «Зал ночью»: меню слева по группам и поиск по всему (⌘K / Ctrl+K).
// Новые разделы, которых нет в GROUP, сами попадают в группу «Прочее» — ничего не потеряется.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Person } from './api.ts';

type Item = [string, string];

const GROUPS: [string, string][] = [
  ['today', 'Сегодня'], ['sales', 'Клиенты и продажи'], ['club', 'Клуб'], ['money', 'Деньги и аналитика'], ['team', 'Команда'], ['setup', 'Настройки'], ['other', 'Прочее'],
];
const GROUP: Record<string, string> = {
  dash: 'today', tasks: 'today', hot: 'today', calls: 'today', desk: 'today', trainer: 'today',
  leads: 'sales', board: 'sales', home: 'sales', chats: 'sales', retention: 'sales', reviews: 'sales', corp: 'sales',
  schedule: 'club', access: 'club', load: 'club', shop: 'club', tariffs: 'club', contracts: 'club',
  finance: 'money', fiscal: 'money', pnl: 'money', cohorts: 'money',
  team: 'today', staff: 'team', stafftime: 'team',
  clubs: 'setup', config: 'setup', pipelines: 'setup', intake: 'setup', messaging: 'setup', site: 'setup', import: 'setup', onboarding: 'setup', usage: 'setup',
  help: 'foot', profile: 'foot',
};

const P: Record<string, string> = {
  dash: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  hot: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 2 1 3 3 3 3',
  calls: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  desk: 'M14 12v.01M5 21h14M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17',
  trainer: 'M6 9v6M18 9v6M3 11v2M21 11v2M6 12h12',
  leads: 'M12 5v14M5 12h14',
  board: 'M3 4h18l-7 9v6l-4 2v-8z',
  home: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8M4 21a8 8 0 0 1 16 0',
  chats: 'M4 5h16v11H8l-4 4z',
  team: 'M3 6h13v9H7l-4 3zM8 18h9l4 3V9h-2',
  retention: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  reviews: 'M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.1L12 17l-5.5 3 1-6.1L3 9.5l6.3-.9z',
  corp: 'M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M3 21h18M8 8h2M8 12h2M8 16h2',
  schedule: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 3v4M8 3v4M3 10h18',
  access: 'M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5',
  load: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  shop: 'M6 7h12l-1 13H7zM9 7a3 3 0 0 1 6 0',
  tariffs: 'M3 12l9-9h9v9l-9 9zM16 8h.01',
  contracts: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h6',
  finance: 'M3 6h18v12H3zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5',
  fiscal: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  pnl: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  cohorts: 'M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM4 16h4v4H4z',
  staff: 'M9 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6',
  stafftime: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M12 7v5l3 3',
  clubs: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  config: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  pipelines: 'M4 5h16M7 12h10M10 19h4',
  intake: 'M4 13h4l2 3h4l2-3h4M4 13l3-8h10l3 8v6H4z',
  messaging: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  site: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  import: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  onboarding: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 13l-3-3c2-5 7-8 13-8 0 6-3 11-8 13zM14 7.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3',
  usage: 'M3 12h4l3-8 4 16 3-8h4',
  help: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01',
  profile: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8M4 21a8 8 0 0 1 16 0',
};
export const NavIcon = ({ k }: { k: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={P[k] ?? 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6'} />
  </svg>
);

export function SideNav({ items, tab, setTab, open, brand, club }: { items: Item[]; tab: string; setTab: (t: string) => void; open: boolean; brand: ReactNode; club: ReactNode }) {
  const groups = GROUPS.map(([g, title]) => [title, items.filter(([k]) => (GROUP[k] ?? 'other') === g)] as const).filter(([, l]) => l.length);
  const foot = items.filter(([k]) => GROUP[k] === 'foot');
  const btn = ([k, t]: Item) => <button key={k} className="nv" aria-pressed={tab === k} onClick={() => setTab(k)}><NavIcon k={k} /><span>{t}</span></button>;
  return (
    <aside className={`side main-tabs ${open ? 'open' : ''}`} aria-label="Разделы">
      {brand}
      {club}
      <nav className="side-groups">
        {groups.map(([title, list]) => <div key={title} className="navg"><div className="gh">{title}</div>{list.map(btn)}</div>)}
      </nav>
      {foot.length > 0 && <div className="navg side-foot">{foot.map(btn)}</div>}
    </aside>
  );
}

/** Поиск по всему: разделы и клиенты. Открывается по ⌘K / Ctrl+K или кнопке в шапке. */
export function CommandPalette({ items, open, setOpen, setTab, openPerson, canPersons }: { items: Item[]; open: boolean; setOpen: (v: boolean) => void; setTab: (t: string) => void; openPerson: (id: string) => void; canPersons: boolean }) {
  const [q, setQ] = useState('');
  const [persons, setPersons] = useState<Person[]>([]);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(!open); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => { if (open) { setQ(''); setI(0); setPersons([]); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => {
    if (!canPersons || q.trim().length < 2) { setPersons([]); return; }
    const t = setTimeout(() => api<Person[]>('GET', `/api/persons?q=${encodeURIComponent(q.trim())}`).then((r) => setPersons(r.slice(0, 6))).catch(() => setPersons([])), 220);
    return () => clearTimeout(t);
  }, [q]);
  const s = q.trim().toLowerCase();
  const sections = useMemo(() => items.filter(([, t]) => !s || t.toLowerCase().includes(s)).slice(0, s ? 8 : 10), [s, items]);
  const rows: { key: string; label: ReactNode; sub: string; run: () => void }[] = [
    ...persons.map((p) => ({ key: `p${p.id}`, label: p.fullName, sub: [p.phone, p.clubName].filter(Boolean).join(' · '), run: () => openPerson(p.id) })),
    ...sections.map(([k, t]) => ({ key: `t${k}`, label: <span className="row" style={{ gap: 8 }}><NavIcon k={k} />{t}</span>, sub: 'раздел', run: () => setTab(k) })),
  ];
  if (!open) return null;
  const pick = (n: number) => { const r = rows[n]; if (r) { setOpen(false); r.run(); } };
  return (
    <div className="modal-bg cmdk-bg" onClick={() => setOpen(false)}>
      <div className="cmdk" role="dialog" aria-label="Поиск" onClick={(e) => e.stopPropagation()}>
        <input ref={input} value={q} placeholder={canPersons ? 'Клиент, телефон или раздел' : 'Раздел'} aria-label="Что найти"
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, rows.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            if (e.key === 'Enter') pick(i);
          }} />
        <div className="cmdk-list" role="listbox">
          {rows.map((r, n) => <button key={r.key} role="option" aria-selected={n === i} className="cmdk-row" onMouseEnter={() => setI(n)} onClick={() => pick(n)}><b>{r.label}</b><span className="small muted">{r.sub}</span></button>)}
          {!rows.length && <p className="small muted" style={{ margin: 8 }}>Ничего не нашлось</p>}
        </div>
        <div className="small muted cmdk-hint">↑↓ — выбрать · Enter — открыть · Esc — закрыть</div>
      </div>
    </div>
  );
}
