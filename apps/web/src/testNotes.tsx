// Журнал замечаний тестировщика (13.11.2026).
// TestNotesWidget — окно на каждой странице: тестировщик пишет замечания именно к этой странице.
//   Страница = раздел + выбранная вкладка раздела («Финансы → Касса»); карточка клиента — одна страница на тип.
//   У каждой страницы своё окно и свой черновик; при уходе со страницы с несохранённой записью спрашиваем, сохранить ли её.
// TestNotesPage — раздел «Журнал замечаний» для собственника: сводки по страницам, все записи, тестировщики, ключ выгрузки.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { ShotEditor } from './shotEditor.tsx';

type Kind = 'bug' | 'ux' | 'idea';
type Status = 'new' | 'in_work' | 'done' | 'rejected';
export type TestNote = { id: string; number: number; pageKey: string; pageLabel: string; role: string; roleName: string | null; author: string; clubName: string | null;
  kind: Kind | null; body: string; hasShot: boolean; status: Status; statusNote: string | null; statusAt: string | null; createdAt: string };
type Draft = { text: string; kind: Kind | null; shot: string | null };
type Page = { key: string; label: string };

const KIND: [Kind, string][] = [['bug', 'Ошибка'], ['ux', 'Неудобно'], ['idea', 'Пожелание']];
const KIND_TEXT: Record<Kind, string> = { bug: 'Ошибка', ux: 'Неудобно', idea: 'Пожелание' };
const STATUS_TEXT: Record<Status, string> = { new: 'Новое', in_work: 'В работе', done: 'Сделано', rejected: 'Не будем делать' };
const STATUS_CHIP: Record<Status, string> = { new: 'chip', in_work: 'chip warn', done: 'chip ok', rejected: 'chip bad' };
// Группы вкладок-фильтров (период, разрез и т.п.) — это не отдельные страницы
const FILTER_GROUPS = new Set(['Период', 'Какие лиды', 'Чей список', 'Блок', 'Разрез', 'Вид сертификата', 'Откуда', 'Что случилось']);
const EMPTY: Draft = { text: '', kind: null, shot: null };
const isEmpty = (d: Draft | undefined) => !d || (!d.text.trim() && !d.shot);

/** Какая вкладка раздела сейчас выбрана: первая группа вкладок в разделе, кроме фильтров и окон поверх */
function readSubTab(): string | null {
  const main = document.querySelector('main.wrap');
  if (!main) return null;
  for (const g of main.querySelectorAll<HTMLElement>('.tabs')) {
    if (g.closest('.modal-bg, .tn-panel, .overlay, .tn-ask')) continue;
    if (FILTER_GROUPS.has(g.getAttribute('aria-label') ?? '')) continue;
    const b = g.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!b) continue;
    const t = (b.textContent ?? '').replace(/\s+/g, ' ').replace(/\s*\d+$/, '').trim();
    return t ? t.slice(0, 60) : null;
  }
  return null;
}

function usePage(tab: string, tabLabel: string, personOpen: boolean): Page {
  const [sub, setSub] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const read = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setSub(readSubTab())); };
    read();
    const main = document.querySelector('main.wrap');
    if (!main) return;
    const mo = new MutationObserver(read);
    mo.observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] });
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, [tab]);
  return useMemo(() => {
    if (personOpen) return { key: 'card:person', label: 'Карточка клиента' };
    if (sub && sub !== tabLabel) return { key: `${tab}:${sub}`, label: `${tabLabel} → ${sub}` };
    return { key: tab, label: tabLabel };
  }, [tab, tabLabel, sub, personOpen]);
}

/* ---------- Скриншоты: из буфера обмена, из файла или снимок экрана ---------- */
async function shrink(blob: Blob): Promise<string> {
  // Большие снимки (Retina) уменьшаем до 1920 px по ширине и сохраняем в JPEG — так они быстро уходят и не упираются в лимит
  const read = (b: Blob) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = fail; r.readAsDataURL(b); });
  if (blob.size < 1_500_000 && /png|jpeg|webp/.test(blob.type)) return read(blob);
  const img = await createImageBitmap(blob);
  const k = Math.min(1, 1920 / img.width);
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

/** Снимок видимой части страницы прямо в браузере — без системного диалога выбора экрана.
 *  Окно журнала, кнопки и всплывающие окна в снимок не попадают. */
async function captureScreen(): Promise<string | null> {
  const { toCanvas } = await import('html-to-image');
  const skip = (n: Node) => !(n instanceof Element && n.matches('.tn-panel, .tn-btn, .report-btn, .shot-ed, .tn-ask, .toast'));
  const W = window.innerWidth, H = window.innerHeight, sx = window.scrollX, sy = window.scrollY;
  const opts = {
    filter: skip, pixelRatio: Math.min(2, window.devicePixelRatio || 1), cacheBust: false,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#0D1117',
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
  };
  // Со шрифтами страницы снимок выглядит как экран; если шрифты не встроились — снимаем без них
  const full = await toCanvas(document.body, opts).catch(() => toCanvas(document.body, { ...opts, skipFonts: true }));
  // Оставляем то, что было на экране
  const k = full.width / document.documentElement.scrollWidth;
  const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
  c.getContext('2d')!.drawImage(full, Math.round(sx * k), Math.round(sy * k), c.width, c.height, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  return blob ? shrink(blob) : null;
}

/* ---------- Окно журнала на странице ---------- */
export function TestNotesWidget({ me, tab, tabLabel, personOpen, clubId }: { me: Me; tab: string; tabLabel: string; personOpen: boolean; clubId: string }) {
  const page = usePage(tab, tabLabel, personOpen);
  const store = `tn:${me.id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(`${store}:open`) === '1'; } catch { return false; } });
  const drafts = useRef<Record<string, Draft>>({});
  const [draft, setDraftState] = useState<Draft>(EMPTY);
  const [notes, setNotes] = useState<TestNote[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState<{ page: Page; draft: Draft } | null>(null);
  const prev = useRef<Page | null>(null);
  const roleName = me.roles[0]?.name ?? '';

  const loadDraft = (key: string): Draft => {
    if (drafts.current[key]) return drafts.current[key];
    try { const s = localStorage.getItem(`${store}:d:${key}`); if (s) return { ...EMPTY, ...JSON.parse(s), shot: null }; } catch { /* нет хранилища */ }
    return EMPTY;
  };
  const keepDraft = (key: string, d: Draft) => {
    drafts.current[key] = d;
    try { if (isEmpty(d)) localStorage.removeItem(`${store}:d:${key}`); else localStorage.setItem(`${store}:d:${key}`, JSON.stringify({ text: d.text, kind: d.kind })); } catch { /* нет хранилища */ }
  };
  const setDraft = (d: Draft) => { setDraftState(d); keepDraft(page.key, d); };

  const load = (key: string) => { setNotes(null); api<TestNote[]>('GET', `/api/test-notes/mine?page=${encodeURIComponent(key)}`).then(setNotes).catch(() => setNotes([])); };

  // Сменилась страница: своё окно и свой черновик; несохранённую запись прошлой страницы предлагаем сохранить
  useEffect(() => {
    const was = prev.current;
    prev.current = page;
    if (was && was.key !== page.key) {
      const d = drafts.current[was.key];
      if (!isEmpty(d)) setAsk({ page: was, draft: d });
    }
    setDraftState(loadDraft(page.key)); setErr('');
    if (open) load(page.key);
  }, [page.key]);
  useEffect(() => { if (open) load(page.key); try { localStorage.setItem(`${store}:open`, open ? '1' : '0'); } catch { /* нет хранилища */ } }, [open]);

  // Закрывают вкладку браузера с несохранённой записью — браузер переспросит
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (Object.values(drafts.current).some((d) => !isEmpty(d))) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const save = async (p: Page, d: Draft) => {
    await api<TestNote>('POST', '/api/test-notes', { pageKey: p.key, pageLabel: p.label, kind: d.kind, body: d.text.trim() || 'Замечание на скриншоте', clubId, shot: d.shot });
    keepDraft(p.key, EMPTY);
  };
  const saveHere = async () => {
    if (!draft.text.trim() && !draft.shot) { setErr('Напишите замечание или сделайте скрин экрана'); return; }
    setBusy(true); setErr('');
    try { await save(page, draft); setDraftState(EMPTY); toast('Запись сохранена в журнале замечаний'); load(page.key); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const answer = async (yes: boolean) => {
    if (!ask) return;
    if (yes) {
      try { await save(ask.page, ask.draft); toast(`Запись сохранена: ${ask.page.label}`); } catch (x) { toast(errText(x)); return; }
    } else keepDraft(ask.page.key, EMPTY);
    setAsk(null);
  };

  // Новый скриншот сразу открывается в редакторе поверх страницы: обвести, подписать, сохранить
  const [editing, setEditing] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const addShot = async (b: Blob) => { try { setEditing(await shrink(b)); } catch { setErr('Не получилось прочитать картинку'); } };
  const snap = async () => {
    // Окно журнала на время снимка прячем, чтобы оно не закрывало страницу
    setCapturing(true);
    await new Promise((r) => setTimeout(r, 120));
    try { const s = await captureScreen(); if (s) setEditing(s); else setErr('Не получилось снять экран'); } catch { setErr('Не получилось снять экран. Вставьте снимок через ⌘V'); } finally { setCapturing(false); }
  };

  return (
    <>
      {!open && !capturing && <button className="tn-btn" onClick={() => setOpen(true)} title="Журнал замечаний к этой странице">
        <span aria-hidden="true">✎</span><span className="tn-btn-t">Замечания</span>{!isEmpty(draft) && <i className="tn-dot" aria-label="есть черновик" />}</button>}
      {editing && <ShotEditor src={editing} onCancel={() => setEditing(null)} onSave={(img, areaNotes) => {
        // Если текст записи пустой — берём подписи областей со скриншота
        const text = draft.text.trim() ? draft.text : areaNotes.map((t, i) => `${i + 1}. ${t}`).join('\n');
        setDraft({ ...draft, text, shot: img }); setEditing(null); }} />}
      {open && (
        <section className="tn-panel card" aria-label="Журнал замечаний" style={capturing ? { visibility: 'hidden' } : undefined}>
          <div className="row between" style={{ alignItems: 'flex-start', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div className="lbl">Журнал замечаний</div>
              <div className="tn-page" title={page.label}>{page.label}</div>
              <div className="small">Роль: {roleName}</div>
            </div>
            <button className="btn sm" onClick={() => setOpen(false)} aria-label="Свернуть журнал">–</button>
          </div>
          <textarea rows={4} value={draft.text} placeholder="Что не так на этой странице или что хотелось бы"
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveHere(); } }}
            onPaste={(e) => { const f = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); addShot(f); } }} />
          <button className="btn pri tn-snap" onClick={snap} disabled={capturing}><span aria-hidden="true">📷</span> {capturing ? 'Снимаю…' : 'Сделать скрин экрана'}</button>
          {draft.shot && <div className="tn-shot"><img src={draft.shot} alt="Скриншот к записи" onClick={() => setEditing(draft.shot)} title="Открыть и дорисовать" style={{ cursor: 'zoom-in' }} />
            <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => setEditing(draft.shot)}>Дорисовать</button><button className="btn sm" onClick={() => setDraft({ ...draft, shot: null })}>Убрать скриншот</button></div></div>}
          {err && <div className="err">{err}</div>}
          <div className="tn-kinds" role="group" aria-label="Тип записи">
            {KIND.map(([k, l]) => <button key={k} className={`tn-kind k-${k}`} aria-pressed={draft.kind === k} onClick={() => setDraft({ ...draft, kind: draft.kind === k ? null : k })}>{l}</button>)}
          </div>
          <button className="btn pri tn-save" disabled={busy || (!draft.text.trim() && !draft.shot)} onClick={saveHere}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </section>)}
      {ask && (
        <div className="modal-bg tn-ask" role="dialog" aria-modal="true" aria-label="Сохранить запись">
          <div className="card modal" style={{ display: 'grid', gap: 10, maxWidth: 440 }}>
            <h2>Сохранить ваши записи в журнале замечаний?</h2>
            <div className="small">Страница «{ask.page.label}». Запись не сохранена:</div>
            <div className="tn-quote">{ask.draft.text.trim() || 'только скриншот, без текста'}{ask.draft.shot ? ' (+ скриншот)' : ''}</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn pri" autoFocus onClick={() => answer(true)}>Сохранить</button>
              <button className="btn" onClick={() => answer(false)}>Не сохранять</button>
            </div>
          </div>
        </div>)}
    </>
  );
}

/* ---------- Сводка в Markdown: заголовки, списки, жирный шрифт, код ---------- */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <b key={i}>{p.slice(2, -2)}</b>
    : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>);
}
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => { if (list) { const L = list.ordered ? 'ol' : 'ul'; out.push(<L key={out.length}>{list.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</L>); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) { flush(); const H = (['h2', 'h2', 'h3', 'h4'] as const)[h[1].length - 1]; out.push(<H key={out.length}>{inline(h[2])}</H>); }
    else if (ul || ol) { const ordered = !!ol; if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; } list.items.push((ul ?? ol)![1]); }
    else if (!line.trim()) flush();
    else { flush(); out.push(<p key={out.length}>{inline(line)}</p>); }
  }
  flush();
  return <div className="md">{out}</div>;
}

/* ---------- Раздел «Журнал замечаний» для собственника ---------- */
type PageRow = { pageKey: string; pageLabel: string; total: number; fresh: number; summaryAt: string | null; summaryCount: number | null };
type Summary = { pageKey: string; pageLabel: string; bodyMd: string; notesCount: number; updatedAt: string };
type Tester = { id: string; fullName: string; login: string; isTester: boolean; roles: string | null; notes: number };

export function TestNotesPage({ me }: { me: Me }) {
  const [view, setView] = useState<'sum' | 'all' | 'testers' | 'key'>('sum');
  const [data, setData] = useState<{ notes: TestNote[]; pages: PageRow[]; key: { createdAt: string; lastUsedAt: string | null } | null } | null>(null);
  const [sums, setSums] = useState<Summary[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [f, setF] = useState({ page: '', role: '', status: '' });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [testers, setTesters] = useState<Tester[]>([]);
  const [newKey, setNewKey] = useState('');
  const [confirmKey, setConfirmKey] = useState(false);
  const [err, setErr] = useState('');
  const load = () => {
    api<NonNullable<typeof data>>('GET', '/api/test-notes').then(setData).catch((x) => setErr(errText(x)));
    api<Summary[]>('GET', '/api/test-notes/summaries').then(setSums).catch(() => setSums([]));
  };
  useEffect(load, []);
  useEffect(() => { if (view === 'testers') api<Tester[]>('GET', '/api/test-notes/testers').then(setTesters).catch((x) => setErr(errText(x))); }, [view]);
  if (err) return <div className="err">{err}</div>;
  if (!data) return <p className="muted">Загрузка…</p>;
  const fresh = data.notes.filter((n) => n.status === 'new').length;
  const roles = [...new Map(data.notes.map((n) => [n.role, n.roleName ?? n.role])).entries()];
  const list = data.notes.filter((n) => (!f.page || n.pageKey === f.page) && (!f.role || n.role === f.role) && (!f.status || n.status === f.status));
  const cur = pick ?? data.pages[0]?.pageKey ?? null;
  const summary = sums.find((s) => s.pageKey === cur);
  const curNotes = data.notes.filter((n) => n.pageKey === cur);
  const setStatus = async (status: Status) => {
    try { await api('PATCH', '/api/test-notes/status', { ids: [...sel], status, statusNote: note.trim() || null }); setSel(new Set()); setNote(''); toast('Статус изменён, тестировщики получат уведомление'); load(); } catch (x) { toast(errText(x)); }
  };
  const toggle = async (t: Tester) => {
    try { await api('PATCH', `/api/test-notes/testers/${t.id}`, { isTester: !t.isTester }); setTesters(testers.map((x) => (x.id === t.id ? { ...x, isTester: !x.isTester } : x))); } catch (x) { toast(errText(x)); }
  };
  const issueKey = async () => {
    if (data.key && !confirmKey) { setConfirmKey(true); return; }
    try { setNewKey((await api<{ key: string }>('POST', '/api/test-notes/key')).key); setConfirmKey(false); load(); } catch (x) { toast(errText(x)); }
  };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div><h1>Журнал замечаний</h1>
          <div className="small">Записей: {data.notes.length}, новых: {fresh}, страниц: {data.pages.length}. Сводки обновляются каждый день к 10:00 по Москве.</div></div>
      </div>
      <div className="tabs" role="group" aria-label="Журнал замечаний">
        {([['sum', 'Сводки по страницам'], ['all', 'Все записи'], ['testers', 'Тестировщики'], ['key', 'Выгрузка']] as const).map(([k, l]) =>
          <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>

      {view === 'sum' && (data.pages.length === 0
        ? <div className="card muted">Записей пока нет. Тестировщики пишут их в окне «Замечания» внизу справа на любой странице.</div>
        : <div className="tn-sum">
          <div className="card tn-pages">
            {data.pages.map((p) => <button key={p.pageKey} aria-pressed={p.pageKey === cur} onClick={() => setPick(p.pageKey)}>
              <span>{p.pageLabel}</span><span className="small">{p.total}{p.fresh ? <b className="tn-new"> +{p.fresh}</b> : null}</span></button>)}
          </div>
          <div className="card" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            {summary ? <><div className="small">Сводка от {dt(summary.updatedAt)}, разобрано записей: {summary.notesCount}</div><Markdown text={summary.bodyMd} /></>
              : <div className="muted">Сводки по этой странице ещё нет: она появится после ближайшего разбора в 9:30. Ниже — записи как есть.</div>}
            <details open={!summary}><summary className="small">Записи по странице: {curNotes.length}</summary>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>{curNotes.map((n) => <NoteRow key={n.id} n={n} />)}</div></details>
          </div>
        </div>)}

      {view === 'all' && <>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={f.page} onChange={(e) => setF({ ...f, page: e.target.value })}><option value="">Все страницы</option>{data.pages.map((p) => <option key={p.pageKey} value={p.pageKey}>{p.pageLabel}</option>)}</select>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="">Все роли</option>{roles.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Все статусы</option>{(Object.keys(STATUS_TEXT) as Status[]).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}</select>
        </div>
        {sel.size > 0 && <div className="card row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <b>Выбрано: {sel.size}</b>
          <input placeholder="Ответ тестировщику (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 220px' }} />
          {(['in_work', 'done', 'rejected', 'new'] as Status[]).map((s) => <button key={s} className="btn sm" onClick={() => setStatus(s)}>{STATUS_TEXT[s]}</button>)}
        </div>}
        <div style={{ display: 'grid', gap: 8 }}>
          {list.length === 0 && <div className="card muted">Нет записей под эти условия.</div>}
          {list.map((n) => <NoteRow key={n.id} n={n} showPage selected={sel.has(n.id)} onSelect={() => { const s = new Set(sel); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); setSel(s); }} />)}
        </div>
      </>}

      {view === 'testers' && <div className="card tbl">
        <table><thead><tr><th>Сотрудник</th><th className="hide-narrow">Роли</th><th className="r">Записей</th><th>Окно журнала</th></tr></thead>
          <tbody>{testers.map((t) => <tr key={t.id}><td>{t.fullName}<div className="small">{t.login}</div></td><td className="hide-narrow small">{t.roles}</td><td className="r num">{t.notes}</td>
            <td><label className="row small" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={t.isTester} onChange={() => toggle(t)} />{t.isTester ? 'показывается' : 'скрыто'}</label></td></tr>)}</tbody></table>
        <p className="small">Окно «Замечания» видят только отмеченные сотрудники. Настоящим сотрудникам клубов его не включайте.</p>
      </div>}

      {view === 'key' && <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
        <h2>Ключ для ежедневного разбора</h2>
        <p className="small" style={{ margin: 0 }}>Каждый день в 9:30 по Москве Claude забирает новые записи по этому ключу, раскладывает их по смыслу и возвращает сводку по каждой странице. Ключ даёт доступ только к журналу замечаний.</p>
        <div className="small">{data.key ? `Ключ выпущен ${dt(data.key.createdAt)}, последний разбор: ${data.key.lastUsedAt ? dt(data.key.lastUsedAt) : 'ещё не было'}` : 'Ключ ещё не выпущен.'}</div>
        {newKey && <div className="tn-key"><code>{newKey}</code><button className="btn sm" onClick={() => navigator.clipboard?.writeText(newKey).then(() => toast('Ключ скопирован'))}>Скопировать</button>
          <div className="small">Ключ показывается один раз. Передайте его Claude в настройках среды (см. сообщение в чате проекта).</div></div>}
        {confirmKey && <div className="err">Старый ключ перестанет работать. Нажмите ещё раз, чтобы выпустить новый.</div>}
        <div><button className="btn pri" onClick={issueKey}>{data.key ? 'Выпустить новый ключ' : 'Выпустить ключ'}</button></div>
      </div>}
    </div>
  );
}

function NoteRow({ n, showPage, selected, onSelect }: { n: TestNote; showPage?: boolean; selected?: boolean; onSelect?: () => void }) {
  return (
    <div className="card tn-row">
      {onSelect && <input type="checkbox" style={{ width: 'auto' }} checked={!!selected} onChange={onSelect} aria-label={`Выбрать запись № ${n.number}`} />}
      <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <div className="row between small" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span>№ {n.number} · {dt(n.createdAt)} · {n.author} ({n.roleName ?? n.role}){n.clubName ? `, ${n.clubName}` : ''}{showPage ? ` · ${n.pageLabel}` : ''}</span>
          <span>{n.kind && <span className="chip">{KIND_TEXT[n.kind]}</span>} <span className={STATUS_CHIP[n.status]}>{STATUS_TEXT[n.status]}</span></span>
        </div>
        <div className="tn-body">{n.body}</div>
        {n.hasShot && <a href={`/api/test-notes/${n.id}/shot`} target="_blank" rel="noreferrer"><img className="tn-thumb" src={`/api/test-notes/${n.id}/shot`} alt={`Скриншот к записи № ${n.number}`} loading="lazy" /></a>}
        {n.statusNote && <div className="small">Ответ: {n.statusNote}</div>}
      </div>
    </div>
  );
}
