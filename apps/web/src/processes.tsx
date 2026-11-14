// Бизнес-процессы (ИИ-агент, этап 6): идущие процессы с ходом по шагам и кнопкой «Коротко о ситуации»,
// готовые шаблоны и конструктор, «опишите процесс словами» — помощник сам разложит на шаги.
import { useEffect, useState } from 'react';
import { api, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { SituationButton } from './agent.tsx';

type Step = { title: string; role: string; hours: number };
type Tpl = { id: string; name: string; description: string; steps: Step[]; builtin: string | null };
type PStep = { ord: number; title: string; role: string; status: string; assignee: string | null; assigneeId: string | null; dueAt: string | null; doneAt: string | null };
type Proc = { id: string; title: string; status: string; startedAt: string; dueAt: string; finishedAt: string | null; personId: string | null; person: string | null; owner: string | null; isOwner: boolean; steps: PStep[] };
type View = 'run' | 'done' | 'templates' | 'words';

const hoursText = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24} дн.` : h < 1 ? `${Math.round(h * 60)} мин` : `${h} ч`);

export function ProcessesPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const club = clubId !== 'all' ? clubId : clubs[0]?.id ?? '';
  const [view, setView] = useState<View>('run');
  const [tpls, setTpls] = useState<{ items: Tpl[]; canEdit: boolean; roles: Record<string, string> } | null>(null);
  const [edit, setEdit] = useState<Partial<Tpl> | null>(null);
  const loadTpls = () => api<{ items: Tpl[]; canEdit: boolean; roles: Record<string, string> }>('GET', '/api/processes/templates').then(setTpls).catch((e) => toast(errText(e)));
  useEffect(() => { void loadTpls(); }, []);
  if (!club) return <p className="muted">Нет клубов.</p>;
  const views: [View, string, boolean][] = [['run', 'Идут сейчас', true], ['done', 'Завершённые', true], ['templates', 'Шаблоны', true], ['words', 'Описать словами', !!tpls?.canEdit]];
  void me;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {clubId === 'all' && <p className="small muted" style={{ margin: 0 }}>Показан клуб «{clubs[0]?.name}». Другой клуб выберите вверху.</p>}
      <div className="tabs" role="group" aria-label="Бизнес-процессы">{views.filter((v) => v[2]).map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => { setView(k); setEdit(null); }}>{t}</button>)}</div>
      {edit && tpls && <TemplateEditor tpl={edit} roles={tpls.roles} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void loadTpls(); setView('templates'); }} />}
      {!edit && (view === 'run' || view === 'done') && tpls && <Running clubId={club} status={view === 'run' ? 'active' : 'done'} tpls={tpls.items} canEdit={tpls.canEdit} roles={tpls.roles} openPerson={openPerson} />}
      {!edit && view === 'templates' && tpls && <Templates data={tpls} onEdit={setEdit} onChanged={loadTpls} />}
      {!edit && view === 'words' && tpls && <Words onDraft={(d) => setEdit(d)} />}
    </div>
  );
}

function Running({ clubId, status, tpls, canEdit, roles, openPerson }: { clubId: string; status: string; tpls: Tpl[]; canEdit: boolean; roles: Record<string, string>; openPerson: (id: string) => void }) {
  const [items, setItems] = useState<Proc[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<{ items: Proc[] }>('GET', `/api/processes?clubId=${clubId}&status=${status}`).then((r) => setItems(r.items)).catch((e) => toast(errText(e)));
  useEffect(() => { setItems(null); void load(); }, [clubId, status]);
  const act = async (url: string, msg: string) => { try { await api('POST', url, {}); toast(msg); void load(); } catch (e) { toast(errText(e)); } };
  return (<>
    {status === 'active' && <StartForm clubId={clubId} tpls={tpls} onStarted={load} />}
    {!items ? <p className="muted">Загрузка…</p> : !items.length ? <p className="muted">{status === 'active' ? 'Запущенных процессов нет. Выберите шаблон выше и запустите.' : 'Завершённых процессов пока нет.'}</p> :
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((p) => {
          const done = p.steps.filter((s) => s.status === 'done').length;
          const cur = p.steps.find((s) => s.status === 'active');
          const late = cur?.dueAt && new Date(cur.dueAt) < new Date();
          const procLate = p.status === 'active' && new Date(p.dueAt) < new Date();
          return (
            <div key={p.id} className="card proc">
              <div className="proc-head">
                <div style={{ minWidth: 0 }}>
                  <b className="proc-title">{p.title}</b>
                  <div className="small muted">Ответственный: {p.owner ?? '—'} · запущен {dt(p.startedAt)} · срок {dt(p.dueAt)}{procLate && <span className="proc-late"> · срок прошёл</span>}</div>
                </div>
                <div className="proc-acts">
                  <SituationButton type="process" id={p.id} />
                  {p.personId && <button className="btn sm" onClick={() => openPerson(p.personId!)}>Клиент</button>}
                </div>
              </div>
              <div className="proc-bar" aria-label={`Выполнено ${done} из ${p.steps.length}`}><i style={{ width: `${(done / Math.max(1, p.steps.length)) * 100}%` }} /></div>
              {cur && <div className={`proc-cur ${late ? 'late' : ''}`}>
                <span>Шаг {cur.ord} из {p.steps.length}: <b>{cur.title}</b> — {cur.assignee ?? roles[cur.role]}{cur.dueAt && <>, до {dt(cur.dueAt)}</>}{late && ' · просрочен'}</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm primary" onClick={() => void act(`/api/processes/${p.id}/step-done`, 'Шаг выполнен, следующий запущен')}>Шаг выполнен</button>
                  {(canEdit || p.isOwner) && <button className="btn sm" onClick={() => void act(`/api/processes/${p.id}/cancel`, 'Процесс отменён')}>Отменить</button>}
                </span>
              </div>}
              <button className="linkish small" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Скрыть шаги' : `Все шаги (${done} из ${p.steps.length})`}</button>
              {open === p.id && <ol className="proc-steps">{p.steps.map((s) => (
                <li key={s.ord} className={s.status}>{s.status === 'done' ? '✅' : s.status === 'active' ? '▶️' : s.status === 'skipped' ? '—' : '○'} {s.title} <span className="muted">— {s.assignee ?? roles[s.role]}{s.doneAt ? `, выполнен ${dt(s.doneAt)}` : s.dueAt ? `, срок ${dt(s.dueAt)}` : ''}</span></li>))}</ol>}
            </div>
          );
        })}
      </div>}
  </>);
}

function StartForm({ clubId, tpls, onStarted }: { clubId: string; tpls: Tpl[]; onStarted: () => void }) {
  const [tpl, setTpl] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; fullName: string; phone: string | null }[]>([]);
  const [person, setPerson] = useState<{ id: string; fullName: string } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2 || person) { setFound([]); return; }
    const t = setTimeout(() => { api<{ id: string; fullName: string; phone: string | null }[]>('GET', `/api/persons?clubId=${clubId}&q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 6))).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, person, clubId]);
  const start = async () => {
    if (!tpl) { toast('Выберите шаблон'); return; }
    setBusy(true);
    try { await api('POST', '/api/processes', { clubId, templateId: tpl, personId: person?.id, note }); toast('Процесс запущен: первый шаг уже у исполнителя'); setTpl(''); setPerson(null); setQ(''); setNote(''); onStarted(); }
    catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  const t = tpls.find((x) => x.id === tpl);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <b>Запустить процесс</b>
      <div className="proc-form">
        <select value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Шаблон"><option value="">Шаблон процесса…</option>{tpls.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <div style={{ position: 'relative' }}>
          {person ? <div className="proc-person">{person.fullName} <button className="linkish" onClick={() => { setPerson(null); setQ(''); }}>×</button></div>
            : <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Клиент (необязательно): имя или телефон" aria-label="Клиент" />}
          {!!found.length && <div className="proc-found">{found.map((f) => <button key={f.id} onClick={() => { setPerson(f); setFound([]); }}>{f.fullName}{f.phone ? ` · ${f.phone}` : ''}</button>)}</div>}
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Пометка для исполнителей" aria-label="Пометка" />
        <button className="btn primary" disabled={busy} onClick={() => void start()}>Запустить</button>
      </div>
      {t && <p className="small muted" style={{ margin: 0 }}>{t.steps.length} шагов: {t.steps.map((s) => s.title).join(' → ')}</p>}
    </div>
  );
}

function Templates({ data, onEdit, onChanged }: { data: { items: Tpl[]; canEdit: boolean; roles: Record<string, string> }; onEdit: (t: Partial<Tpl>) => void; onChanged: () => void }) {
  const del = async (id: string) => { try { await api('DELETE', `/api/processes/templates/${id}`); toast('Шаблон убран'); onChanged(); } catch (e) { toast(errText(e)); } };
  return (<>
    {data.canEdit && <div><button className="btn primary" onClick={() => onEdit({ name: '', description: '', steps: [{ title: '', role: 'manager', hours: 24 }] })}>+ Новый процесс</button></div>}
    <div style={{ display: 'grid', gap: 10 }}>
      {data.items.map((t) => (
        <div key={t.id} className="card">
          <div className="proc-head">
            <div><b>{t.name}</b>{t.builtin && <span className="tag" style={{ marginLeft: 8 }}>готовый</span>}{t.description && <div className="small muted">{t.description}</div>}</div>
            {data.canEdit && <div className="proc-acts"><button className="btn sm" onClick={() => onEdit(t)}>Изменить</button><button className="btn sm" onClick={() => void del(t.id)}>Убрать</button></div>}
          </div>
          <ol className="proc-steps">{t.steps.map((s, i) => <li key={i}>{s.title} <span className="muted">— {data.roles[s.role] ?? s.role}, {hoursText(s.hours)}</span></li>)}</ol>
        </div>
      ))}
    </div>
  </>);
}

function TemplateEditor({ tpl, roles, onClose, onSaved }: { tpl: Partial<Tpl>; roles: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(tpl.name ?? '');
  const [desc, setDesc] = useState(tpl.description ?? '');
  const [steps, setSteps] = useState<Step[]>(tpl.steps?.length ? tpl.steps.map((s) => ({ ...s })) : [{ title: '', role: 'manager', hours: 24 }]);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, p: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => setSteps((s) => { const a = [...s]; const j = i + d; if (j < 0 || j >= a.length) return s; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const save = async () => {
    setBusy(true);
    try { await api('POST', '/api/processes/templates', { id: tpl.id, name, description: desc, steps }); toast('Шаблон сохранён'); onSaved(); }
    catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <b>{tpl.id ? 'Изменить процесс' : 'Новый процесс'}</b>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название процесса" aria-label="Название" />
      <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Когда запускать и зачем (необязательно)" aria-label="Описание" />
      <div className="small muted">Шаги по порядку. Срок — сколько времени даётся на шаг после того, как он начался. Следующий шаг помощник запустит сам.</div>
      {steps.map((s, i) => (
        <div key={i} className="proc-step-row">
          <span className="proc-n">{i + 1}</span>
          <input value={s.title} onChange={(e) => upd(i, { title: e.target.value })} placeholder="Что сделать" aria-label={`Шаг ${i + 1}`} />
          <select value={s.role} onChange={(e) => upd(i, { role: e.target.value })} aria-label="Кто делает">{Object.entries(roles).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input type="number" min={0.25} step={0.25} value={s.hours} onChange={(e) => upd(i, { hours: Number(e.target.value) })} aria-label="Срок, часов" style={{ width: 90 }} /><span className="small muted">ч</span>
          <button className="btn sm" onClick={() => move(i, -1)} aria-label="Выше">↑</button>
          <button className="btn sm" onClick={() => move(i, 1)} aria-label="Ниже">↓</button>
          <button className="btn sm" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Удалить шаг" disabled={steps.length === 1}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setSteps((x) => [...x, { title: '', role: 'manager', hours: 24 }])}>+ Шаг</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>Сохранить</button>
      </div>
    </div>
  );
}

function Words({ onDraft }: { onDraft: (t: Partial<Tpl>) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api<{ name: string; steps: Step[] }>('POST', '/api/processes/from-text', { text }); onDraft({ name: r.name, description: 'Создан по описанию словами', steps: r.steps }); toast('Проверьте шаги и сохраните'); }
    catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <b>Опишите процесс словами</b>
      <p className="small muted" style={{ margin: 0 }}>Как рассказали бы новому сотруднику: что делаем, кто и за какое время. Помощник разложит на шаги, вы проверите и сохраните. То же можно написать ИИ-помощнику в мессенджере: «создай процесс …».</p>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: Жалоба клиента: администратор принимает жалобу в течение часа; управляющий разбирается за сутки; затем управляющий звонит клиенту; через неделю менеджер уточняет, всё ли в порядке" />
      <div><button className="btn primary" disabled={busy || text.trim().length < 10} onClick={() => void go()}>Разложить на шаги</button></div>
    </div>
  );
}
