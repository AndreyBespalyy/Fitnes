// ИИ-агент: кнопка «Коротко о ситуации» в задаче и сделке. Окно с текстом до 6000 знаков, главное выделено жирным.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Brief = { text: string; engine: string; createdAt: string; cached: boolean; note?: string | null;
  sources: { tasks: number; calls: number; clientMessages: number; team: number; stages: number; observations: number } };

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
  return (
    <div className="modal-bg brief-bg" role="dialog" aria-modal="true" aria-label="Коротко о ситуации" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card modal" style={{ display: 'grid', gap: 10, maxWidth: 720 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>✦ Коротко о ситуации</h2><button className="btn sm" onClick={onClose} aria-label="Закрыть">×</button></div>
        {err && <div className="err">{err}</div>}
        {!b && !err && <p className="muted">ИИ-помощник собирает задачи, звонки, переписку и обсуждения…</p>}
        {b && <BriefText text={b.text} />}
        {b?.note && <div className="small muted">{b.note}</div>}
        {b && s && (
          <div className="small muted">
            {b.engine === 'yandexgpt' ? 'Составил ИИ-помощник (YandexGPT)' : 'Собрано по данным CRM без нейросети'} · {dt(b.createdAt)} ·
            учтено: задач {s.tasks}, звонков {s.calls}, сообщений клиента {s.clientMessages}, обсуждений в команде {s.team}{s.observations ? `, наблюдений ${s.observations}` : ''}
          </div>)}
        <div className="row"><button className="btn sm" disabled={busy} onClick={() => load(true)}>{busy ? 'Обновляю…' : 'Обновить'}</button>
          <button className="btn sm pri" onClick={onClose}>Понятно</button></div>
      </div>
    </div>
  );
}

/* ---------- Настройки ИИ-помощника клуба: лестница напоминаний и авто-передача заявок ---------- */
type AgentSets = { enabled: boolean; taskRopMinutes: number; taskGmMinutes: number; taskOwnerMinutes: number; replyWaitMinutes: number;
  leadReassignMinutes: number; quietFrom: number; quietTo: number; canEdit: boolean };
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
      {!ro && <div><button className="btn pri" onClick={save}>Сохранить</button></div>}
    </div>
  );
}
