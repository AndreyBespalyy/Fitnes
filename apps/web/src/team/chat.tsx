// Мессенджер сотрудников: список чатов и переписка. Один и тот же экран в разделе CRM «Мессенджер» и в приложении на телефоне.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';

export type ChatItem = {
  id: string; kind: 'direct' | 'group' | 'club' | 'dept'; title: string; clubId: string | null; dept: string | null; onlyAdminsPost: boolean; isAdmin: boolean; muted: boolean;
  at: string; unread: number; members: number; lastBody: string | null; lastFile: boolean | null; lastAuthor: string | null; lastMine: boolean | null; lastSystem: boolean | null;
  peerId: string | null; peerName: string | null; peerApp: string | null;
};
type Member = { id: string; fullName: string; isAdmin: boolean; auto: boolean; lastReadAt: string; roles: string | null; app: string | null };
type ChatInfo = { id: string; kind: ChatItem['kind']; title: string; onlyAdminsPost: boolean; isAdmin: boolean; muted: boolean; canAnnounce: boolean; canPost: boolean; canManage: boolean; members: Member[] };
type FileMeta = { id: string; name: string; mime: string; size: number };
type Msg = { id: string; userId: string | null; author: string | null; body: string; important: boolean; createdAt: string; editedAt: string | null; deleted: boolean;
  replyTo: string | null; replyBody: string | null; replyAuthor: string | null; file: FileMeta | null; pending?: boolean;
  meta?: { kind?: string; meetingId?: string; status?: 'confirmed' | 'declined' } | null };
type Person = { id: string; fullName: string; login: string; roles: string[]; clubs: string[]; app: string | null };

const err = (x: unknown) => (x instanceof ApiError ? x.message : 'Нет связи с сервером');
export const initials = (s: string) => s.replace(/[«»"]/g, '').split(/[\s·]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hm = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function listTime(s: string) {
  const d = new Date(s); const now = new Date();
  if (sameDay(d, now)) return hm(s);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}
function dayLabel(s: string) {
  const d = new Date(s); const now = new Date();
  if (sameDay(d, now)) return 'Сегодня';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const coarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

const Ico = ({ d, s = 18 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  plus: 'M12 5v14M5 12h14', back: 'M15 18l-6-6 6-6', send: 'M4 12l16-8-6 16-3-7z', clip: 'M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0', mute: 'M6 8a6 6 0 0 1 9.5-4.9M18 8c0 7 3 9 3 9H9M10.3 21a2 2 0 0 0 3.4 0M3 3l18 18',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M12 11v5M12 8h.01', x: 'M6 6l12 12M18 6L6 18', reply: 'M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 6 6v4',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 8a5 5 0 0 1 0 8', search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14M21 21l-4.3-4.3',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6', group: 'M9 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6',
  club: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6', phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2M11 18h2',
};

/** **жирный** в тексте сообщения (так пишет ИИ-помощник) */
function boldify(s: string): ReactNode[] {
  return s.split(/(\*\*[^*\n]+\*\*)/g).map((p, i) => (p.length > 4 && p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p));
}

export function Avatar({ chat, name, size: sz = 40 }: { chat?: Pick<ChatItem, 'kind' | 'title' | 'dept'>; name?: string; size?: number }) {
  const kind = chat?.kind ?? 'direct';
  const label = name ?? chat?.title ?? '';
  const icon = kind === 'club' ? I.club : kind === 'dept' || kind === 'group' ? I.group : null;
  let h = 0; for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className={`tm-ava k-${kind}`} style={{ width: sz, height: sz, ['--h' as string]: String(h) }} aria-hidden="true">
      {icon && kind !== 'direct' ? <Ico d={icon} s={Math.round(sz * 0.45)} /> : initials(label)}
    </span>
  );
}

/* ---------- Сжатие фото перед отправкой: телефоны снимают по 5–10 МБ ---------- */
async function readFile(f: File): Promise<{ fileName: string; dataBase64: string }> {
  const asData = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); });
  if (/^image\/(jpeg|png|webp)$/.test(f.type) && f.size > 600_000) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85));
      if (blob) return { fileName: f.name.replace(/\.\w+$/, '') + '.jpg', dataBase64: await asData(blob) };
    } catch { /* отправим как есть */ }
  }
  return { fileName: f.name, dataBase64: await asData(f) };
}

/* ======================================================================= */
export function TeamChat({ meId, initialChat, onUnread, emptyHint, header }: { meId: string; initialChat?: string | null; onUnread?: (n: number) => void; emptyHint?: ReactNode; header?: ReactNode }) {
  const [list, setList] = useState<ChatItem[] | null>(null);
  const [listErr, setListErr] = useState('');
  const [active, setActive] = useState<string | null>(initialChat ?? null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const loadList = () => api<ChatItem[]>('GET', '/api/team/chats').then((l) => { setList(l); setListErr(''); }).catch((x) => setListErr(err(x)));
  useEffect(() => {
    loadList();
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadList(); }, 5000);
    const vis = () => { if (document.visibilityState === 'visible') loadList(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);
  useEffect(() => { if (initialChat) setActive(initialChat); }, [initialChat]);
  useEffect(() => { onUnread?.((list ?? []).filter((c) => !c.muted).reduce((s, c) => s + c.unread, 0)); }, [list]);
  // Адрес открытого чата — чтобы «Назад» на телефоне возвращал к списку
  const open = (id: string | null) => {
    setActive(id);
    const u = new URL(location.href);
    if (id) u.searchParams.set('chat', id); else u.searchParams.delete('chat');
    history.replaceState(history.state, '', u.toString());
    if (id) setList((l) => l?.map((c) => (c.id === id ? { ...c, unread: 0 } : c)) ?? l);
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list ?? []).filter((c) => !s || c.title.toLowerCase().includes(s));
  }, [list, q]);
  const activeItem = list?.find((c) => c.id === active);
  const openAi = async () => { try { const r = await api<{ id: string }>('POST', '/api/agent/chat'); await loadList(); open(r.id); } catch (x) { setListErr(err(x)); } };

  return (
    <div className={`tm ${active ? 'has-active' : ''}`}>
      <aside className="tm-list" aria-label="Чаты">
        {header}
        <div className="tm-list-head">
          <h2>Чаты</h2>
          <button className="tm-icon-btn pri" onClick={() => setCreating(true)} aria-label="Новый чат" title="Новый чат"><Ico d={I.plus} /></button>
        </div>
        <button className="tm-ai" onClick={openAi} title="Спросите о задачах, перенесите срок, узнайте суть ситуации по клиенту">
          <span className="tm-ai-ico" aria-hidden="true">✦</span><span><b>ИИ-помощник</b><small>«мои задачи», «перенеси Анну на завтра»</small></span></button>
        <label className="tm-search"><Ico d={I.search} s={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти чат" aria-label="Найти чат" /></label>
        {listErr && <div className="tm-err">{listErr}</div>}
        {list === null && !listErr && <p className="tm-muted tm-pad">Загрузка…</p>}
        <ul className="tm-chats">
          {shown.map((c) => (
            <li key={c.id}>
              <button className={`tm-chat ${c.id === active ? 'on' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => open(c.id)} aria-current={c.id === active}>
                <Avatar chat={c} />
                <span className="tm-chat-main">
                  <span className="tm-chat-top"><b className="tm-chat-title">{c.title}</b><time>{listTime(c.at)}</time></span>
                  <span className="tm-chat-bottom">
                    <span className="tm-chat-last">
                      {c.lastBody === null && !c.lastFile ? <i>{c.kind === 'direct' ? 'Напишите первым' : `${c.members} участн.`}</i>
                        : <>{c.lastSystem ? '' : c.lastMine ? 'Вы: ' : c.kind !== 'direct' && c.lastAuthor ? `${c.lastAuthor.split(' ')[0]}: ` : ''}{c.lastBody?.replace(/\*\*/g, '') || (c.lastFile ? '📎 Файл' : '')}</>}
                    </span>
                    {c.muted && <span className="tm-muted-ico" title="Без уведомлений"><Ico d={I.mute} s={14} /></span>}
                    {c.unread > 0 && <span className={`tm-badge ${c.muted ? 'grey' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list && list.length === 0 && <p className="tm-muted tm-pad">Чатов пока нет. Нажмите «+», чтобы написать коллеге или создать группу.</p>}
      </aside>
      <section className="tm-conv">
        {active ? <Conversation key={active} id={active} meId={meId} item={activeItem} onBack={() => open(null)} onChanged={loadList} onLeft={() => { open(null); loadList(); }} />
          : <div className="tm-empty">{emptyHint ?? <><Ico d={I.group} s={40} /><p>Выберите чат слева или начните новый</p></>}</div>}
      </section>
      {creating && <NewChat onClose={() => setCreating(false)} onOpen={(id) => { setCreating(false); loadList(); open(id); }} />}
    </div>
  );
}

/* ======================================================================= */
function Conversation({ id, meId, item, onBack, onChanged, onLeft }: { id: string; meId: string; item?: ChatItem; onBack: () => void; onChanged: () => void; onLeft: () => void }) {
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [reads, setReads] = useState<{ userId: string; lastReadAt: string }[]>([]);
  const [more, setMore] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [text, setText] = useState('');
  const [important, setImportant] = useState(false);
  const [reply, setReply] = useState<Msg | null>(null);
  const [edit, setEdit] = useState<Msg | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [readers, setReaders] = useState<{ msg: Msg; read: { id: string; fullName: string }[]; unread: { id: string; fullName: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const cursor = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const prevH = useRef<number | null>(null);

  const loadInfo = () => api<ChatInfo>('GET', `/api/team/chats/${id}`).then(setInfo).catch((x) => setLoadErr(err(x)));
  const markRead = () => { if (document.visibilityState === 'visible') api('POST', `/api/team/chats/${id}/read`).catch(() => {}); };
  const merge = (incoming: Msg[]) => setMsgs((cur) => {
    const map = new Map(cur.filter((m) => !m.pending).map((m) => [m.id, m]));
    for (const m of incoming) map.set(m.id, m);
    const pend = cur.filter((m) => m.pending);
    return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).concat(pend);
  });
  useEffect(() => {
    loadInfo();
    api<{ messages: Msg[]; reads: typeof reads; cursor: string; more: boolean }>('GET', `/api/team/chats/${id}/messages`).then((r) => {
      setMsgs(r.messages); setReads(r.reads); setMore(r.more); cursor.current = r.cursor; markRead();
    }).catch((x) => setLoadErr(err(x)));
    const poll = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !cursor.current) return;
      try {
        const r = await api<{ messages: Msg[]; reads: typeof reads; cursor: string }>('GET', `/api/team/chats/${id}/messages?since=${encodeURIComponent(cursor.current)}`);
        cursor.current = r.cursor; setReads(r.reads);
        if (r.messages.length) { merge(r.messages); if (r.messages.some((m) => m.userId !== meId)) markRead(); }
      } catch { /* следующая попытка через 3 секунды */ }
    }, 3000);
    const infoT = setInterval(() => { if (document.visibilityState === 'visible') loadInfo(); }, 30_000);
    const vis = () => markRead();
    document.addEventListener('visibilitychange', vis);
    if (!coarse()) setTimeout(() => ta.current?.focus(), 50);
    return () => { clearInterval(poll); clearInterval(infoT); document.removeEventListener('visibilitychange', vis); };
  }, [id]);

  // Прокрутка: новые сообщения — вниз, если пользователь и так внизу; подгрузка старых — без прыжка
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    if (prevH.current !== null) { el.scrollTop = el.scrollHeight - prevH.current; prevH.current = null; return; }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);
  const onScroll = () => { const el = box.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  const loadOlder = async () => {
    const first = msgs.find((m) => !m.pending); if (!first) return;
    const r = await api<{ messages: Msg[]; more: boolean }>('GET', `/api/team/chats/${id}/messages?before=${encodeURIComponent(first.createdAt)}`);
    prevH.current = box.current?.scrollHeight ?? null; setMore(r.more); merge(r.messages);
  };

  const autosize = () => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; } };
  useEffect(autosize, [text]);

  const send = async (e?: FormEvent, file?: { fileName: string; dataBase64: string }) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body && !file) return;
    setSendErr('');
    if (edit) {
      try { await api('PATCH', `/api/team/messages/${edit.id}`, { body }); merge([{ ...edit, body, editedAt: new Date().toISOString() }]); setEdit(null); setText(''); }
      catch (x) { setSendErr(err(x)); }
      return;
    }
    const tmp: Msg = { id: `tmp-${Date.now()}`, userId: meId, author: null, body: file ? body : body, important, createdAt: new Date().toISOString(), editedAt: null, deleted: false,
      replyTo: reply?.id ?? null, replyBody: reply?.body ?? null, replyAuthor: reply?.author ?? null, file: file ? { id: '', name: file.fileName, mime: '', size: 0 } : null, pending: true };
    stick.current = true;
    setMsgs((m) => [...m, tmp]); setText(''); setReply(null); setImportant(false); setBusy(!!file);
    try {
      const m = await api<Msg>('POST', `/api/team/chats/${id}/messages`, { body, replyTo: tmp.replyTo, important: tmp.important, file });
      setMsgs((cur) => cur.filter((x) => x.id !== tmp.id && x.id !== m.id).concat(m).sort((a, b) => Number(!!a.pending) - Number(!!b.pending) || a.createdAt.localeCompare(b.createdAt)));
      onChanged();
    } catch (x) {
      setMsgs((cur) => cur.filter((m) => m.id !== tmp.id)); setText(body); setSendErr(err(x));
    } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse() && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
    if (e.key === 'Escape') { setReply(null); setEdit(null); }
  };
  const pickFile = async (f: File | undefined) => { if (!f) return; if (f.size > 25 * 1024 * 1024) { setSendErr('Файл больше 10 МБ'); return; } await send(undefined, await readFile(f)); };
  const del = async (m: Msg) => { setSel(null); try { await api('DELETE', `/api/team/messages/${m.id}`); merge([{ ...m, deleted: true, body: '', file: null }]); onChanged(); } catch (x) { setSendErr(err(x)); } };
  const toggleMute = async () => { if (!info) return; const r = await api<{ muted: boolean }>('PUT', `/api/team/chats/${id}/mute`, { muted: !info.muted }); setInfo({ ...info, muted: r.muted }); onChanged(); };
  const showReaders = async (m: Msg) => { const r = await api<{ read: { id: string; fullName: string }[]; unread: { id: string; fullName: string }[] }>('GET', `/api/team/messages/${m.id}/readers`); setReaders({ msg: m, ...r }); };

  const others = (info?.members ?? []).filter((x) => x.id !== meId);
  const readCount = (m: Msg) => reads.filter((r) => r.userId !== meId && r.userId !== m.userId && r.lastReadAt >= m.createdAt).length;
  const title = info?.title ?? item?.title ?? '…';
  const kind = info?.kind ?? item?.kind ?? 'direct';
  const subtitle = !info ? '' : kind === 'direct' ? (others[0]?.roles ?? '') + (others[0]?.app ? ' · в приложении' : '')
    : `${info.members.length} участн.${info.onlyAdminsPost ? ' · пишут руководители' : ''}`;

  let lastDay = ''; let lastAuthor: string | null = null; let lastAt = 0;
  return (
    <>
      <header className="tm-conv-head">
        <button className="tm-icon-btn tm-back" onClick={onBack} aria-label="К списку чатов"><Ico d={I.back} /></button>
        <button className="tm-conv-title" onClick={() => setShowInfo(true)}>
          <Avatar chat={{ kind, title, dept: item?.dept ?? null }} size={36} />
          <span><b>{title}</b><small>{subtitle}</small></span>
        </button>
        {info && <button className="tm-icon-btn" onClick={toggleMute} aria-label={info.muted ? 'Включить уведомления' : 'Без уведомлений'} title={info.muted ? 'Уведомления выключены' : 'Уведомления включены'}><Ico d={info.muted ? I.mute : I.bell} /></button>}
        <button className="tm-icon-btn" onClick={() => setShowInfo(true)} aria-label="Участники и настройки"><Ico d={I.info} /></button>
      </header>
      <div className="tm-msgs" ref={box} onScroll={onScroll} onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
        {loadErr && <div className="tm-err">{loadErr}</div>}
        {more && <button className="tm-older" onClick={loadOlder}>Показать раньше</button>}
        {msgs.map((m) => {
          const day = dayLabel(m.createdAt);
          const dayBreak = day !== lastDay; lastDay = day;
          const t = new Date(m.createdAt).getTime();
          const cont = !dayBreak && lastAuthor === m.userId && t - lastAt < 5 * 60_000 && !m.important;
          lastAuthor = m.userId; lastAt = t;
          const mine = m.userId === meId;
          const nodes: ReactNode[] = [];
          if (dayBreak) nodes.push(<div key={`d-${m.id}`} className="tm-day"><span>{day}</span></div>);
          if (m.userId === null) { nodes.push(<div key={m.id} className="tm-sys">{m.body}</div>); lastAuthor = '__sys'; return nodes; }
          const n = readCount(m);
          nodes.push(
            <div key={m.id} className={`tm-row ${mine ? 'mine' : ''} ${cont ? 'cont' : ''}`}>
              {!mine && kind !== 'direct' && <span className="tm-row-ava">{!cont && <Avatar name={m.author ?? '?'} size={30} />}</span>}
              <div className={`tm-bubble ${m.important ? 'imp' : ''} ${m.deleted ? 'del' : ''} ${m.pending ? 'pending' : ''} ${sel === m.id ? 'sel' : ''}`}
                onClick={() => !m.deleted && !m.pending && setSel(sel === m.id ? null : m.id)}>
                {m.important && !m.meta?.kind && <div className="tm-imp-lbl"><Ico d={I.megaphone} s={14} /> Объявление</div>}
                {!mine && kind !== 'direct' && !cont && <div className="tm-author">{m.author}</div>}
                {m.replyTo && <div className="tm-quote"><b>{m.replyAuthor ?? ''}</b><span>{m.replyBody || '📎 Файл'}</span></div>}
                {m.deleted ? <i className="tm-muted">Сообщение удалено</i> : <>
                  {m.file && (m.file.mime.startsWith('image/')
                    ? <a href={`/api/team/files/${m.file.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><img className="tm-img" src={`/api/team/files/${m.file.id}`} alt={m.file.name} loading="lazy" /></a>
                    : m.file.id ? <a className="tm-file" href={`/api/team/files/${m.file.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><Ico d={I.file} s={22} /><span><b>{m.file.name}</b><small>{size(m.file.size)}</small></span></a>
                      : <span className="tm-file"><Ico d={I.file} s={22} /><span><b>{m.file.name}</b><small>Отправляется…</small></span></span>)}
                  {m.body && <div className="tm-text">{boldify(m.body)}</div>}
                  {m.meta?.kind === 'meeting_invite' && m.meta.meetingId && <MeetingButtons meetingId={m.meta.meetingId} status={m.meta.status}
                    onDone={(st) => setMsgs((cur) => cur.map((x) => (x.meta?.meetingId === m.meta!.meetingId ? { ...x, meta: { ...x.meta, status: st } } : x)))} />}
                </>}
                <div className="tm-meta">
                  {m.editedAt && !m.deleted && <span>изменено</span>}
                  <time>{hm(m.createdAt)}</time>
                  {mine && !m.deleted && (m.pending ? <span title="Отправляется">◷</span> : kind === 'direct' ? <span className={n ? 'tm-read' : ''} title={n ? 'Прочитано' : 'Доставлено'}>{n ? '✓✓' : '✓'}</span> : null)}
                </div>
                {m.important && (mine || info?.canAnnounce) && !m.deleted && <button className="tm-readers" onClick={(e) => { e.stopPropagation(); void showReaders(m); }}>Прочитали {n} из {Math.max(0, (info?.members.length ?? 1) - 1)}</button>}
              </div>
              {sel === m.id && (
                <div className="tm-actions" role="menu">
                  <button onClick={() => { setReply(m); setEdit(null); setSel(null); ta.current?.focus(); }}><Ico d={I.reply} s={15} />Ответить</button>
                  {m.body && <button onClick={() => { void navigator.clipboard?.writeText(m.body); setSel(null); }}>Копировать</button>}
                  {mine && m.body && Date.now() - t < 48 * 3600_000 && <button onClick={() => { setEdit(m); setReply(null); setText(m.body); setSel(null); ta.current?.focus(); }}>Изменить</button>}
                  {(mine || (info?.isAdmin && kind !== 'direct')) && <button className="bad" onClick={() => del(m)}>Удалить</button>}
                </div>
              )}
            </div>,
          );
          return nodes;
        })}
        {msgs.length === 0 && !loadErr && <div className="tm-hello">{kind === 'direct' ? 'Здесь будет ваша переписка. Напишите первое сообщение.' : 'В чате пока тихо.'}</div>}
      </div>
      {info && !info.canPost ? <div className="tm-readonly">В этом канале пишут только руководители</div> : (
        <form className="tm-compose" onSubmit={send}>
          {(reply || edit) && (
            <div className="tm-replybar">
              <Ico d={edit ? I.file : I.reply} s={16} />
              <span><b>{edit ? 'Изменение сообщения' : `Ответ: ${reply!.author ?? 'вам'}`}</b><small>{(edit ?? reply)!.body || '📎 Файл'}</small></span>
              <button type="button" className="tm-icon-btn" onClick={() => { setReply(null); if (edit) setText(''); setEdit(null); }} aria-label="Отменить"><Ico d={I.x} s={16} /></button>
            </div>
          )}
          {sendErr && <div className="tm-err">{sendErr}</div>}
          <div className="tm-compose-row">
            <button type="button" className="tm-icon-btn" onClick={() => fileIn.current?.click()} aria-label="Прикрепить фото или файл" title="Фото или файл" disabled={busy || !!edit}><Ico d={I.clip} /></button>
            <input ref={fileIn} type="file" hidden accept="image/*,application/pdf,.docx,.xlsx" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ''; }} />
            {info?.canAnnounce && !edit && <button type="button" className={`tm-icon-btn ${important ? 'on' : ''}`} onClick={() => setImportant(!important)} aria-pressed={important} title="Объявление: придёт даже тем, кто выключил уведомления, и будет видно, кто прочитал"><Ico d={I.megaphone} /></button>}
            <textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={important ? 'Текст объявления для всех участников' : 'Сообщение'} aria-label="Сообщение" maxLength={4000} />
            <button className="tm-send" disabled={!text.trim() || busy} aria-label={edit ? 'Сохранить' : 'Отправить'}><Ico d={I.send} /></button>
          </div>
        </form>
      )}
      {showInfo && info && <ChatInfoSheet info={info} meId={meId} onClose={() => setShowInfo(false)} reload={() => { loadInfo(); onChanged(); }} onLeft={onLeft} toggleMute={toggleMute} />}
      {readers && (
        <Sheet title="Кто прочитал объявление" onClose={() => setReaders(null)}>
          <p className="tm-muted" style={{ margin: 0 }}>{readers.msg.body.slice(0, 140)}</p>
          <h3>Прочитали · {readers.read.length}</h3>
          <ul className="tm-people">{readers.read.map((p) => <li key={p.id}><Avatar name={p.fullName} size={28} /><span>{p.fullName}</span><span className="tm-ok">✓✓</span></li>)}</ul>
          <h3>Ещё не прочитали · {readers.unread.length}</h3>
          <ul className="tm-people">{readers.unread.map((p) => <li key={p.id}><Avatar name={p.fullName} size={28} /><span>{p.fullName}</span></li>)}</ul>
        </Sheet>
      )}
    </>
  );
}

/* ---------- Окно поверх: на телефоне выезжает снизу ---------- */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, []);
  return (
    <div className="tm-sheet-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tm-sheet" role="dialog" aria-label={title}>
        <div className="tm-sheet-head"><h2>{title}</h2><button className="tm-icon-btn" onClick={onClose} aria-label="Закрыть"><Ico d={I.x} /></button></div>
        <div className="tm-sheet-body">{children}</div>
      </div>
    </div>
  );
}

function PeoplePicker({ exclude = [], picked, setPicked, multi, onPick }: { exclude?: string[]; picked?: string[]; setPicked?: (ids: string[]) => void; multi?: boolean; onPick?: (p: Person) => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api<Person[]>('GET', '/api/team/people').then(setPeople).catch(() => setPeople([])); }, []);
  const s = q.trim().toLowerCase();
  const shown = (people ?? []).filter((p) => !exclude.includes(p.id) && (!s || p.fullName.toLowerCase().includes(s) || p.roles.join(' ').toLowerCase().includes(s) || p.clubs.join(' ').toLowerCase().includes(s)));
  return (
    <>
      <label className="tm-search"><Ico d={I.search} s={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, должность или клуб" aria-label="Поиск сотрудника" autoFocus={!coarse()} /></label>
      {people === null && <p className="tm-muted">Загрузка…</p>}
      <ul className="tm-people pick">
        {shown.map((p) => {
          const on = picked?.includes(p.id);
          return (
            <li key={p.id}>
              <button type="button" className={on ? 'on' : ''} aria-pressed={multi ? on : undefined}
                onClick={() => (multi ? setPicked?.(on ? picked!.filter((x) => x !== p.id) : [...(picked ?? []), p.id]) : onPick?.(p))}>
                <Avatar name={p.fullName} size={34} />
                <span className="tm-person"><b>{p.fullName}</b><small>{p.roles.join(', ')}{p.clubs.length ? ` · ${p.clubs.join(', ')}` : ''}</small></span>
                {multi && <span className={`tm-check ${on ? 'on' : ''}`} aria-hidden="true">{on ? '✓' : ''}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {people && shown.length === 0 && <p className="tm-muted">Никого не нашли.</p>}
    </>
  );
}

function NewChat({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [channel, setChannel] = useState(false);
  const [e, setE] = useState('');
  const direct = async (p: Person) => { try { const r = await api<{ id: string }>('POST', '/api/team/direct', { userId: p.id }); onOpen(r.id); } catch (x) { setE(err(x)); } };
  const group = async () => { try { const r = await api<{ id: string }>('POST', '/api/team/groups', { title, memberIds: picked, onlyAdminsPost: channel }); onOpen(r.id); } catch (x) { setE(err(x)); } };
  return (
    <Sheet title="Новый чат" onClose={onClose}>
      <div className="tm-seg" role="group">
        <button aria-pressed={mode === 'direct'} onClick={() => setMode('direct')}>Написать сотруднику</button>
        <button aria-pressed={mode === 'group'} onClick={() => setMode('group')}>Создать группу</button>
      </div>
      {e && <div className="tm-err">{e}</div>}
      {mode === 'direct' ? <PeoplePicker onPick={direct} /> : <>
        <label className="tm-field">Название группы<input value={title} onChange={(x) => setTitle(x.target.value)} placeholder="Например: Смена выходного дня" maxLength={80} /></label>
        <label className="tm-toggle"><input type="checkbox" checked={channel} onChange={(x) => setChannel(x.target.checked)} /><span>Канал объявлений: пишут только руководители группы</span></label>
        <PeoplePicker multi picked={picked} setPicked={setPicked} />
        <div className="tm-sheet-foot"><button className="tm-btn pri" disabled={!title.trim() || !picked.length} onClick={group}>Создать группу{picked.length ? ` · ${picked.length + 1} участн.` : ''}</button></div>
      </>}
    </Sheet>
  );
}

function ChatInfoSheet({ info, meId, onClose, reload, onLeft, toggleMute }: { info: ChatInfo; meId: string; onClose: () => void; reload: () => void; onLeft: () => void; toggleMute: () => void }) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState(info.title);
  const [e, setE] = useState('');
  const run = async (f: () => Promise<unknown>) => { setE(''); try { await f(); reload(); } catch (x) { setE(err(x)); } };
  const KIND: Record<string, string> = { direct: 'Личный чат', group: 'Группа', club: 'Общий чат клуба: все сотрудники клуба, состав обновляется сам', dept: 'Чат отдела: состав обновляется сам по должностям' };
  return (
    <Sheet title={info.kind === 'direct' ? 'Собеседник' : 'О чате'} onClose={onClose}>
      <p className="tm-muted" style={{ margin: 0 }}>{KIND[info.kind]}</p>
      {e && <div className="tm-err">{e}</div>}
      {info.canManage && (
        <div className="tm-row-form">
          <label className="tm-field" style={{ flex: 1 }}>Название<input value={title} onChange={(x) => setTitle(x.target.value)} maxLength={80} /></label>
          <button className="tm-btn" disabled={!title.trim() || title === info.title} onClick={() => run(() => api('PATCH', `/api/team/chats/${info.id}`, { title }))}>Сохранить</button>
        </div>
      )}
      {info.canManage && <label className="tm-toggle"><input type="checkbox" checked={info.onlyAdminsPost} onChange={(x) => run(() => api('PATCH', `/api/team/chats/${info.id}`, { onlyAdminsPost: x.target.checked }))} /><span>Пишут только руководители группы</span></label>}
      <label className="tm-toggle"><input type="checkbox" checked={!info.muted} onChange={toggleMute} /><span>Уведомления о новых сообщениях{info.muted ? ' (объявления приходят всегда)' : ''}</span></label>
      <h3>Участники · {info.members.length}</h3>
      {info.canManage && !adding && <button className="tm-btn" onClick={() => setAdding(true)}><Ico d={I.plus} s={16} /> Добавить участников</button>}
      {adding && <>
        <PeoplePicker multi exclude={info.members.map((m) => m.id)} picked={picked} setPicked={setPicked} />
        <div className="tm-sheet-foot"><button className="tm-btn" onClick={() => setAdding(false)}>Отмена</button><button className="tm-btn pri" disabled={!picked.length} onClick={() => run(async () => { await api('POST', `/api/team/chats/${info.id}/members`, { userIds: picked }); setAdding(false); setPicked([]); })}>Добавить · {picked.length}</button></div>
      </>}
      <ul className="tm-people">
        {info.members.map((m) => (
          <li key={m.id}>
            <Avatar name={m.fullName} size={34} />
            <span className="tm-person"><b>{m.fullName}{m.id === meId ? ' (вы)' : ''}</b><small>{m.roles ?? ''}{m.isAdmin ? ' · руководитель чата' : ''}</small></span>
            {m.app && <span className="tm-chip" title="Установил приложение-мессенджер"><Ico d={I.phone} s={13} /> приложение</span>}
            {info.canManage && m.id !== meId && <button className="tm-btn sm" onClick={() => run(() => api('DELETE', `/api/team/chats/${info.id}/members/${m.id}`))}>Убрать</button>}
          </li>
        ))}
      </ul>
      {info.kind === 'group' && <div className="tm-sheet-foot"><button className="tm-btn bad" onClick={() => run(async () => { await api('DELETE', `/api/team/chats/${info.id}/members/${meId}`); onClose(); onLeft(); })}>Выйти из группы</button></div>}
    </Sheet>
  );
}

/** Приглашение на собрание от ИИ-помощника: «Подтвердить участие» / «Не смогу» */
function MeetingButtons({ meetingId, status, onDone }: { meetingId: string; status?: 'confirmed' | 'declined'; onDone: (s: 'confirmed' | 'declined') => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async (answer: 'confirmed' | 'declined') => {
    setBusy(true); setErr('');
    try { await api('POST', `/api/agent/meetings/${meetingId}/answer`, { answer }); onDone(answer); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось, попробуйте ещё раз'); }
    finally { setBusy(false); }
  };
  return (
    <div className="tm-meet" onClick={(e) => e.stopPropagation()}>
      {status === 'confirmed' && <span className="tm-meet-ok">✓ Вы подтвердили участие</span>}
      {status === 'declined' && <span className="tm-meet-no">Вы ответили, что не сможете</span>}
      <div className="tm-meet-btns">
        {status !== 'confirmed' && <button type="button" className="tm-meet-yes" disabled={busy} onClick={() => void send('confirmed')}>Подтвердить участие</button>}
        {status !== 'declined' && <button type="button" className="tm-meet-later" disabled={busy} onClick={() => void send('declined')}>{status === 'confirmed' ? 'Не смогу' : 'Не смогу прийти'}</button>}
      </div>
      {err && <small className="tm-meet-err">{err}</small>}
    </div>
  );
}
