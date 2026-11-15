// ИИ-агент: кнопка «Коротко о ситуации» в задаче и сделке. Окно с текстом до 6000 знаков, главное выделено жирным.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type FlowEvent = { at: string; kind: string; title: string; detail?: string; full?: string; bad?: boolean };
type FlowAct = 'chat' | 'person' | 'deal' | 'task' | 'tasks';
type FlowStep = { title: string; detail?: string; urgent?: boolean; act?: FlowAct; branches?: { when: string; then: string }[] };
type FlowStage = { title: string; status: 'done' | 'active' | 'pending' | 'skipped'; who: string | null; when: string | null; result: string | null; late: boolean };
type Flow = { head: string; history: FlowEvent[]; now: string; steps: FlowStep[]; stages?: FlowStage[]; personId?: string | null };

const ACT_LABEL: Record<FlowAct, string> = { chat: 'Открыть переписку', person: 'Открыть карточку клиента', deal: 'Открыть сделку', task: 'Открыть задачу', tasks: 'К задачам' };
/** Куда ведёт шаг: карточка клиента (там переписка, сделка, оплата и продление) или раздел «Задачи» */
function actUrl(act: FlowAct, personId: string | null | undefined): string | null {
  if (act === 'task' || act === 'tasks') return '/?tab=tasks';
  return personId ? `/?person=${personId}` : null;
}
const goTo = (url: string) => window.dispatchEvent(new CustomEvent('crm-go', { detail: url }));
type Brief = { text: string; engine: string; createdAt: string; cached: boolean; note?: string | null; flow?: Flow;
  sources: { tasks: number; calls: number; clientMessages: number; team: number; stages: number; observations: number } };

const EV_ICON: Record<string, string> = { lead: '📥', call: '📞', stage: '➜', task: '✓', message: '💬', buy: '🎫', visit: '🏋', class: '🏋', meeting: '🤝' };

/** «Коротко о ситуации» схемой: как развивалась ситуация → где сейчас → что делать по шагам с развилками «если … →» */
export function FlowView({ flow, onGo }: { flow: Flow; onGo?: () => void }) {
  const [openEv, setOpenEv] = useState<number | null>(null);
  const run = (act: FlowAct) => { const u = actUrl(act, flow.personId); if (u) { onGo?.(); goTo(u); } };
  return (
    <div className="flow">
      {flow.head && <div className="flow-head">{flow.head}</div>}
      {flow.stages && flow.stages.length > 0 && (<>
        <div className="flow-sec">Шаги процесса</div>
        <ol className="flow-stages">{flow.stages.map((x, i) => (
          <li key={i} className={`fs fs-${x.status}${x.late ? ' fs-late' : ''}`}>
            <span className="fs-dot" aria-hidden="true">{x.status === 'done' ? '✓' : x.status === 'active' ? i + 1 : x.status === 'skipped' ? '–' : i + 1}</span>
            <div><b>{x.title}</b>{x.late && <span className="chip bad" style={{ marginLeft: 6 }}>просрочен</span>}
              <div className="small muted">{[x.who, x.when].filter(Boolean).join(' · ')}</div>
              {x.result && <div className="small">Итог: {x.result}</div>}</div>
          </li>))}</ol>
      </>)}
      {flow.history.length > 0 && (<>
        <div className="flow-sec">Как развивалась ситуация</div>
        <ol className="flow-tl">{flow.history.map((e, i) => (
          <li key={i} className={e.bad ? 'bad' : ''}>
            <span className="tl-ic" aria-hidden="true">{EV_ICON[e.kind] ?? '•'}</span>
            <div><span className="small muted">{dt(e.at)}</span> {e.full
              ? <button className="link flow-ev" aria-expanded={openEv === i} onClick={() => setOpenEv(openEv === i ? null : i)}><b>{e.title}</b> <span className="small">{openEv === i ? '▴ скрыть' : '▾ текст и итог'}</span></button>
              : <b>{e.title}</b>}
              {openEv === i && e.full ? <div className="flow-full">{e.full}</div> : e.detail && <div className="small">{e.detail}</div>}</div>
          </li>))}</ol>
      </>)}
      <div className="flow-now"><span className="flow-now-l">Сейчас</span>{flow.now}</div>
      <div className="flow-sec">Что делать — по шагам</div>
      <ol className="flow-steps">{flow.steps.map((x, i) => (
        <li key={i} className={x.urgent ? 'urgent' : ''}>
          <span className="st-n" aria-hidden="true">{i + 1}</span>
          <div className="st-b">{x.act && actUrl(x.act, flow.personId)
              ? <button className="link flow-act" onClick={() => run(x.act!)} title={ACT_LABEL[x.act]}><b>{x.title}</b> <span aria-hidden="true">→</span></button>
              : <b>{x.title}</b>}{x.urgent && <span className="chip acc" style={{ marginLeft: 6 }}>срочно</span>}
            {x.detail && <div className="small">{x.detail}</div>}
            {x.act && actUrl(x.act, flow.personId) && <button className="btn sm flow-go" onClick={() => run(x.act!)}>{ACT_LABEL[x.act]} →</button>}
            {x.branches && x.branches.length > 0 && <div className="st-br">{x.branches.map((br, j) => (
              <div key={j} className="br"><span className="br-if">Если {br.when}</span><span className="br-ar" aria-hidden="true">→</span><span>{br.then}</span></div>))}</div>}
          </div>
        </li>))}</ol>
    </div>
  );
}

/** **жирный** внутри строки */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>));
}

/** Текст сводки: заголовки (строка целиком жирная), списки «• » или «- », абзацы */
export function BriefText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={`l${blocks.length}`} className="brief-ul">{list.map((x, i) => <li key={i}>{x.split('\n').map((y, j) => <span key={j}>{j > 0 && <br />}{inline(y)}</span>)}</li>)}</ul>); list = []; } };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    if (/^\s{2,}/.test(raw) && list.length) { list[list.length - 1] += `\n${l}`; continue; } // продолжение пункта списка
    const li = l.match(/^(?:[•\-*]|\d+[.)])\s+(.*)$/);
    if (li && !/^\*\*/.test(l)) { list.push(li[1]); continue; }
    flush();
    const h = l.match(/^(?:#+\s*)?\*\*([^*]+)\*\*:?(\s*\([^)]*\))?:?$/) ?? l.match(/^#+\s*(.+)$/);
    if (h) blocks.push(<h3 key={`h${blocks.length}`} className="brief-h">{h[1].replace(/:$/, '')}{h[2] && <span className="small muted" style={{ fontWeight: 400 }}>{h[2]}</span>}</h3>);
    else blocks.push(<p key={`p${blocks.length}`} className="brief-p">{inline(l)}</p>);
  }
  flush();
  return <div className="brief">{blocks}</div>;
}

export function SituationButton({ type, id, small = true, label = 'Коротко о ситуации' }: { type: 'task' | 'opportunity' | 'process'; id: string; small?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className={`btn ${small ? 'sm' : ''} brief-btn`} onClick={(e) => { e.stopPropagation(); setOpen(true); }} title="ИИ-помощник соберёт всё по этой ситуации: задачи, звонки, переписку, обсуждения">
      <span aria-hidden="true">✦</span> {label}</button>
    {open && <SituationDialog type={type} id={id} onClose={() => setOpen(false)} />}
  </>);
}

export function SituationDialog({ type, id, onClose }: { type: 'task' | 'opportunity' | 'process'; id: string; onClose: () => void }) {
  const [b, setB] = useState<Brief | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (force = false) => {
    setBusy(true); setErr('');
    api<Brief>('GET', `/api/agent/brief/${type}/${id}${force ? '?force=1' : ''}`).then(setB).catch((x) => setErr(errText(x))).finally(() => setBusy(false));
  };
  useEffect(() => { load(); }, [type, id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true); }, []);
  const s = b?.sources;
  const [view, setView] = useState<'flow' | 'text'>('flow');
  // Окно выносим в body: внутри шапки (колокольчик) fixed-позиция обрезалась и клик мимо окна не закрывал его
  return createPortal(
    <div className="modal-bg brief-bg" role="dialog" aria-modal="true" aria-label="Коротко о ситуации" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card modal" style={{ display: 'grid', gap: 10, maxWidth: 720 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>✦ Коротко о ситуации</h2><button className="btn sm" onClick={onClose} aria-label="Закрыть">×</button></div>
        {err && <div className="err">{err}</div>}
        {!b && !err && <p className="muted">ИИ-помощник собирает задачи, звонки, переписку и обсуждения…</p>}
        {b?.flow && <div className="tabs" role="group" aria-label="Вид"><button aria-pressed={view === 'flow'} onClick={() => setView('flow')}>Схемой</button><button aria-pressed={view === 'text'} onClick={() => setView('text')}>Текстом</button></div>}
        {b && (b.flow && view === 'flow' ? <FlowView flow={b.flow} onGo={onClose} /> : <BriefText text={b.text} />)}
        {b?.note && <div className="small muted">{b.note}</div>}
        {b && s && (
          <div className="small muted">
            {b.engine === 'yandexgpt' ? 'Составил ИИ-помощник (YandexGPT)' : 'Собрано по данным CRM без нейросети'} · {dt(b.createdAt)} ·
            учтено: задач {s.tasks}, звонков {s.calls}, сообщений клиента {s.clientMessages}, обсуждений в команде {s.team}{s.observations ? `, наблюдений ${s.observations}` : ''}
          </div>)}
        <div className="row"><button className="btn sm" disabled={busy} onClick={() => load(true)}>{busy ? 'Обновляю…' : 'Обновить'}</button>
          <button className="btn sm pri" onClick={onClose}>Понятно</button></div>
      </div>
    </div>, document.body);
}

/* ---------- Настройки ИИ-помощника клуба: лестница напоминаний и авто-передача заявок ---------- */
type AgentSets = { enabled: boolean; taskRopMinutes: number; taskGmMinutes: number; taskOwnerMinutes: number; replyWaitMinutes: number;
  leadReassignMinutes: number; quietFrom: number; quietTo: number; morningHints: boolean; morningHour: number; canEdit: boolean };
export function AgentSettingsCard({ clubId }: { clubId: string }) {
  const [f, setF] = useState<AgentSets | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setF(null); api<AgentSets>('GET', `/api/agent/settings?clubId=${clubId}`).then(setF).catch((x) => setErr(errText(x))); }, [clubId]);
  if (!f) return err ? <div className="err">{err}</div> : null;
  const ro = !f.canEdit;
  const num = (k: keyof AgentSets, label: string) => <label className="f">{label}<input type="number" disabled={ro} value={f[k] as number} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></label>;
  const save = async () => { setErr(''); try { const { canEdit: _c, ...b } = f; await api('PUT', '/api/agent/settings', { clubId, ...b }); toast('Сохранено'); } catch (x) { setErr(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
      <h2 style={{ margin: 0 }}>✦ ИИ-помощник: напоминания</h2>
      <p className="small muted" style={{ margin: 0 }}>Помощник присылает карточки с кнопками в колокольчик и на телефон. Если исполнитель не реагирует, сигнал поднимается выше по лестнице. Клиентам помощник сам не пишет.</p>
      {err && <div className="err">{err}</div>}
      {ro && <p className="small muted" style={{ margin: 0 }}>Менять может управляющий или собственник.</p>}
      <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} disabled={ro} checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Напоминания и эскалация включены</label>
      <div className="grid2">
        {num('taskRopMinutes', 'Просроченная задача → РОП, через мин')}{num('taskGmMinutes', '→ управляющий, через мин')}
        {num('taskOwnerMinutes', '→ собственник, через мин')}{num('replyWaitMinutes', 'Клиент ждёт ответа в переписке, мин')}
        {num('leadReassignMinutes', 'Передать заявку другому менеджеру, если не взяли за мин (0 — не передавать)')}
        <div className="grid2">{num('quietFrom', 'Тишина с, ч')}{num('quietTo', 'до, ч')}</div>
      </div>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} disabled={ro} checked={f.morningHints} onChange={(e) => setF({ ...f, morningHints: e.target.checked })} />Утром присылать каждому сотруднику «3 подсказки на сегодня»</label>
      {f.morningHints && <div className="grid2">{num('morningHour', 'Во сколько присылать, ч (5–12, время клуба)')}</div>}
      {!ro && <div><button className="btn pri" onClick={save}>Сохранить</button></div>}
    </div>
  );
}
