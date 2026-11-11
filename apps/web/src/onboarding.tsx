/// <reference types="vite/client" />
// Шаг 18, часть 4. Подключение клуба по чек-листу, демо-клуб, тариф платформы; раздел «Помощь»: инструкции и обращения в поддержку.
import { useEffect, useState } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { Md } from './fiscal.tsx';

type Item = { code: string; title: string; hint: string; tab: string; day: number; due: string; optional: boolean; manualOnly: boolean;
  status: 'todo' | 'done' | 'skipped'; by: string | null; at: string | null; note: string | null; overdue: boolean };
type State = { clubId: string; name: string; isDemo: boolean; start: string; finish: string; today: string; items: Item[]; done: number; total: number; percent: number; overdue: number; next: Item | null };
type Contract = { number: string; signedOn: string; plan: string; clubsLimit: number | null; usersLimit: number | null; validTo: string | null; feeKop: number | null; note: string | null };
type Overview = { clubs: State[]; contract: Contract | null; usage: { clubs: number; users: number } };

const d2 = (s: string | null) => (s ? s.split('-').reverse().join('.') : '—');

export function OnboardingPage({ me, clubId, go, reloadClubs }: { me: Me; clubId: string; go: (tab: string) => void; reloadClubs: () => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [sel, setSel] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Overview>('GET', '/api/onboarding').then((r) => { setO(r); if (!sel || !r.clubs.some((c) => c.clubId === sel)) setSel(r.clubs.find((c) => c.clubId === clubId)?.clubId ?? r.clubs.find((c) => c.percent < 100)?.clubId ?? r.clubs[0]?.clubId ?? ''); }).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (clubId !== 'all' && o?.clubs.some((c) => c.clubId === clubId)) setSel(clubId); }, [clubId]);
  if (!o) return <p className="muted">Загрузка…</p>;
  const s = o.clubs.find((c) => c.clubId === sel);
  const setItem = (st: State, it: Item, status: string) => {
    let note: string | null = null;
    if (status === 'skipped') { note = window.prompt('Почему этот пункт не нужен клубу?') ?? null; if (!note?.trim()) return; }
    if (status === 'done' && it.manualOnly) note = window.prompt('Комментарий (необязательно)') ?? '';
    api<State>('POST', `/api/onboarding/${st.clubId}/items/${it.code}`, { status, note }).then((r) => setO({ ...o, clubs: o.clubs.map((c) => (c.clubId === r.clubId ? r : c)) })).catch((x) => toast(errText(x)));
  };
  const setStart = (st: State, v: string) => api<State>('PATCH', `/api/onboarding/${st.clubId}`, { start: v }).then((r) => setO({ ...o, clubs: o.clubs.map((c) => (c.clubId === r.clubId ? r : c)) })).catch((x) => toast(errText(x)));
  const demo = async (model: string) => {
    setBusy(true);
    try { const r = await api<{ id: string; name: string; leads: number; sold: number }>('POST', '/api/clubs/demo', { salesModel: model }); toast(`${r.name}: ${r.leads} учебных заявок, ${r.sold} продаж`); reloadClubs(); load(); } catch (x) { toast(errText(x)); }
    setBusy(false);
  };
  const closeDemo = async (st: State) => {
    if (!window.confirm(`Закрыть «${st.name}»? Учебные данные останутся в архиве, клуб пропадёт из списков.`)) return;
    try { await api('POST', `/api/clubs/${st.clubId}/close-demo`); toast('Демо-клуб закрыт'); reloadClubs(); load(); } catch (x) { toast(errText(x)); }
  };
  const c = o.contract;
  return (
    <>
      <p className="muted" style={{ margin: 0, maxWidth: 760 }}>Чек-лист подключения клуба: что настроить до первого рабочего дня. Срок — 10 рабочих дней. Пункты, которые система видит по данным, отмечаются сами.</p>
      <div className="grid2">
        <div className="card">
          <h2>Клубы</h2>
          {o.clubs.map((st) => (
            <button key={st.clubId} className="item row between" style={{ width: '100%', textAlign: 'left', background: st.clubId === sel ? 'var(--accent-soft)' : undefined }} onClick={() => setSel(st.clubId)}>
              <span>{st.name} {st.isDemo && <span className="chip">демо</span>}</span>
              <span className={`chip ${st.percent === 100 ? 'ok' : st.overdue ? 'bad' : 'warn'}`}>{st.done} из {st.total}{st.overdue ? ` · просрочено ${st.overdue}` : ''}</span>
            </button>
          ))}
        </div>
        <div className="card">
          <h2>Договор с платформой</h2>
          {c ? <div className="small" style={{ display: 'grid', gap: 4 }}>
            <div>Договор № {c.number} от {d2(c.signedOn)}{c.validTo ? `, действует до ${d2(c.validTo)}` : ''}</div>
            <div>Тариф: <b>{c.plan}</b>{c.feeKop != null ? ` · ${Math.round(c.feeKop / 100).toLocaleString('ru-RU')} ₽ в месяц` : ''}</div>
            <div>Клубов: {o.usage.clubs}{c.clubsLimit ? ` из ${c.clubsLimit}` : ''} · сотрудников: {o.usage.users}{c.usersLimit ? ` из ${c.usersLimit}` : ''}</div>
          </div> : <p className="small muted">Пилот: ограничений тарифа нет. Клубов: {o.usage.clubs}, сотрудников: {o.usage.users}.</p>}
          {me.allClubs && <>
            <h2 style={{ marginTop: 12 }}>Демо-клуб</h2>
            <p className="small muted" style={{ margin: '0 0 6px' }}>Учебный клуб с вымышленными клиентами, заявками и продажами за месяц: показать систему или потренировать новых сотрудников. В цифры сети и тариф не входит.</p>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy} onClick={() => demo('term')}>Создать: абонементы</button>
              <button className="btn" disabled={busy} onClick={() => demo('subscription')}>Создать: подписка</button>
            </div>
          </>}
        </div>
      </div>
      {s && (
        <div className="card">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0 }}>{s.name}: {s.percent}%</h2>
            <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
              <label>Начало подключения <input type="date" value={s.start} onChange={(e) => e.target.value && setStart(s, e.target.value)} /></label>
              <span>Запуск по плану: <b>{d2(s.finish)}</b></span>
              {s.isDemo && me.allClubs && <button className="btn sm" onClick={() => closeDemo(s)}>Закрыть демо-клуб</button>}
            </div>
          </div>
          <div role="progressbar" aria-valuenow={s.percent} style={{ height: 8, background: "var(--line)", borderRadius: 4, margin: "8px 0", overflow: "hidden" }}><div style={{ width: `${s.percent}%`, height: '100%', background: 'var(--ok)', borderRadius: 4 }} /></div>
          {s.next && <p className="small" style={{ margin: '0 0 6px' }}>Следующий шаг: <b>{s.next.title}</b> — {s.next.hint}</p>}
          <div className="tbl"><table><thead><tr><th>День</th><th>Что сделать</th><th className="hide-narrow">Срок</th><th>Состояние</th><th></th></tr></thead>
            <tbody>{s.items.map((it) => (
              <tr key={it.code}>
                <td className="small">{it.day}</td>
                <td><div>{it.title}{it.optional && <span className="small muted"> · если нужно</span>}</div><div className="small muted">{it.hint}</div>
                  {it.note && <div className="small">Комментарий: {it.note}</div>}</td>
                <td className={`small hide-narrow ${it.overdue ? 'bad' : ''}`}>{d2(it.due)}</td>
                <td>{it.status === 'done' ? <span className="chip ok">сделано</span> : it.status === 'skipped' ? <span className="chip">не нужно</span> : <span className={`chip ${it.overdue ? 'bad' : 'warn'}`}>{it.overdue ? 'просрочено' : 'в работе'}</span>}
                  {it.by && <div className="small muted">{it.by}{it.at ? `, ${d2(it.at)}` : ''}</div>}</td>
                <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {it.status === 'todo' && <button className="btn sm" onClick={() => go(it.tab)}>Открыть</button>}
                  {it.status === 'todo' && it.manualOnly && <button className="btn sm pri" onClick={() => setItem(s, it, 'done')}>Сделано</button>}
                  {it.status === 'todo' && it.optional && <button className="btn sm" onClick={() => setItem(s, it, 'skipped')}>Не нужно</button>}
                  {it.status !== 'todo' && it.by !== 'система' && <button className="btn sm" onClick={() => setItem(s, it, 'todo')}>Вернуть</button>}
                </div></td>
              </tr>))}</tbody></table></div>
        </div>
      )}
    </>
  );
}

// ——— Помощь ———
const DOCS = import.meta.glob('../../../docs/03_Инструкции/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const GUIDES = Object.entries(DOCS).map(([path, text]) => ({ id: path.split('/').pop()!.replace(/\.md$/, ''), title: (text.match(/^#\s+(.+)$/m)?.[1] ?? path).replace(/\s*\(шаг[^)]*\)\s*$/i, ''), text }))
  .sort((a, b) => a.title.localeCompare(b.title, 'ru'));

type Ticket = { id: string; number: number; subject: string; kind: string; status: string; clubName: string | null; author: string; authorId: string; escalatedAt: string | null; createdAt: string; updatedAt: string; messages: number; page?: string | null };
type TicketFull = Ticket & { techLog?: { at: string; kind: string; text: string }[] | null; clientInfo?: string | null; appVersion?: string | null; canAnswer: boolean; messagesList: { id: string; body: string; fromSupport: boolean; createdAt: string; author: string }[] };
const KIND: Record<string, string> = { question: 'Вопрос', bug: 'Ошибка', idea: 'Предложение', access: 'Доступ' };
const STATUS: Record<string, [string, string]> = { open: ['ждёт ответа', 'warn'], answered: ['есть ответ', 'ok'], closed: ['закрыто', ''] };

export function HelpPage({ me, clubs, clubId, page }: { me: Me; clubs: Club[]; clubId: string; page: string }) {
  const [view, setView] = useState<'guides' | 'support'>(() => (navParams('help').view === 'support' ? 'support' : 'guides'));
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const found = GUIDES.filter((g) => !q.trim() || g.text.toLowerCase().includes(q.trim().toLowerCase()));
  const g = GUIDES.find((x) => x.id === open);
  return (
    <>
      <div className="tabs" role="group" aria-label="Помощь">
        <button aria-pressed={view === 'guides'} onClick={() => setView('guides')}>Инструкции</button>
        <button aria-pressed={view === 'support'} onClick={() => setView('support')}>{can(me, 'support.answer') ? 'Обращения сотрудников' : 'Написать в поддержку'}</button>
      </div>
      {view === 'guides' && (g ? (
        <div className="card md"><button className="btn sm" onClick={() => setOpen(null)}>← Все инструкции</button><Md text={g.text} /></div>
      ) : (
        <div className="card">
          <input placeholder="Поиск по инструкциям: заморозка, касса, план…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', maxWidth: 420 }} />
          {found.map((x) => <button key={x.id} className="item" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setOpen(x.id)}>{x.title}</button>)}
          {!found.length && <p className="small muted">Ничего не нашлось. Напишите в поддержку — ответим.</p>}
        </div>
      ))}
      {view === 'support' && <Support me={me} clubs={clubs} clubId={clubId} page={page} />}
    </>
  );
}

function Support({ me, clubs, clubId, page }: { me: Me; clubs: Club[]; clubId: string; page: string }) {
  const [list, setList] = useState<Ticket[]>([]);
  const [cur, setCur] = useState<TicketFull | null>(null);
  const [f, setF] = useState({ subject: '', body: '', kind: 'question' });
  const [reply, setReply] = useState('');
  const load = () => api<Ticket[]>('GET', '/api/support').then(setList).catch((x) => toast(errText(x)));
  const openT = (id: string) => api<TicketFull>('GET', `/api/support/${id}`).then(setCur).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, []);
  const send = async () => {
    try {
      const t = await api<Ticket>('POST', '/api/support', { ...f, clubId, page, clientInfo: `web; ${navigator.userAgent.slice(0, 200)}` });
      toast(`Обращение № ${t.number} отправлено`); setF({ subject: '', body: '', kind: 'question' }); load();
    } catch (x) { toast(errText(x)); }
  };
  const answer = async () => {
    if (!cur || !reply.trim()) return;
    try { await api('POST', `/api/support/${cur.id}/messages`, { body: reply }); setReply(''); openT(cur.id); load(); } catch (x) { toast(errText(x)); }
  };
  const status = async (body: object) => { if (!cur) return; try { await api('POST', `/api/support/${cur.id}/status`, body); openT(cur.id); load(); } catch (x) { toast(errText(x)); } };
  const clubName = clubs.find((c) => c.id === clubId)?.name;
  return (
    <div className="grid2">
      <div className="card">
        <h2>Новое обращение</h2>
        <p className="small muted" style={{ margin: '0 0 6px' }}>Опишите, что случилось и в каком разделе. Не пишите сюда телефоны и паспортные данные клиентов.{clubName ? ` Клуб: ${clubName}.` : ''}</p>
        <label className="f">Тема<input value={f.subject} maxLength={200} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <label className="f">Тип<select className="f" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f">Что случилось<textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <button className="btn pri" onClick={send}>Отправить</button>
      </div>
      <div className="card">
        <h2>{can(me, 'support.answer') ? 'Все обращения' : 'Мои обращения'}</h2>
        {list.map((t) => (
          <button key={t.id} className="item row between" style={{ width: '100%', textAlign: 'left', background: cur?.id === t.id ? 'var(--accent-soft)' : undefined }} onClick={() => openT(t.id)}>
            <span>№ {t.number} · {t.subject}<span className="small muted"> · {KIND[t.kind]}{can(me, 'support.answer') ? ` · ${t.author}` : ''}</span></span>
            <span className={`chip ${STATUS[t.status][1]}`}>{STATUS[t.status][0]}</span>
          </button>
        ))}
        {!list.length && <p className="small muted">Обращений нет</p>}
        {cur && (
          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            <div className="row between"><b>№ {cur.number}: {cur.subject}</b><span className="small muted">{cur.clubName ?? 'вся сеть'}{cur.escalatedAt ? ' · передано разработчикам' : ''}</span></div>
            {cur.messagesList.map((m) => (
              <div key={m.id} className="item" style={{ background: m.fromSupport ? 'var(--ok-soft)' : undefined }}>
                <div className="small muted">{m.fromSupport ? `Поддержка: ${m.author}` : m.author} · {dt(m.createdAt)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </div>
            ))}
            {cur.canAnswer && (cur.techLog?.length || cur.clientInfo) && <details><summary className="small">Технические сведения{cur.page ? ` · раздел ${cur.page}` : ''}</summary>
              <div className="small muted">{cur.appVersion ? `Версия ${cur.appVersion} · ` : ''}{cur.clientInfo}</div>
              {(cur.techLog ?? []).map((e, i) => <div key={i} className="small" style={{ fontFamily: 'var(--mono, monospace)' }}>{dt(e.at)} · {e.kind} · {e.text}</div>)}
            </details>}
            {cur.status !== 'closed' && <>
              <textarea rows={3} placeholder="Ответ" value={reply} onChange={(e) => setReply(e.target.value)} />
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn pri" onClick={answer}>Отправить</button>
                {cur.canAnswer && !cur.escalatedAt && <button className="btn" onClick={() => status({ escalate: true })}>Передать разработчикам</button>}
                <button className="btn" onClick={() => status({ status: 'closed' })}>Вопрос решён</button>
              </div>
            </>}
            {cur.status === 'closed' && <button className="btn sm" onClick={() => status({ status: 'open' })}>Открыть снова</button>}
          </div>
        )}
      </div>
    </div>
  );
}
