// Конструктор правил «если — то»: условия из готового списка, цепочка шагов с задержками. Правила сохраняются как черновик версии настроек.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt } from './ui.ts';

type Cond = { type: string; n?: number };
type Step = { action: 'message' | 'task' | 'points'; afterDays: number; text?: string; title?: string; points?: number; dueHours?: number };
export type Rule = { id: string; name: string; enabled: boolean; conditions: Cond[]; steps: Step[]; stopOnVisit: boolean; stopOnPurchase: boolean; cooldownDays: number; marketing: boolean };
type Meta = { conditions: { type: string; label: string; unit: string | null; min: number | null; max: number | null }[]; actions: { action: Step['action']; label: string }[]; templates: Omit<Rule, 'id'>[] };

let metaCache: Meta | null = null;
function useMeta() {
  const [m, setM] = useState<Meta | null>(metaCache);
  useEffect(() => { if (!metaCache) api<Meta>('GET', '/api/rules/meta').then((x) => { metaCache = x; setM(x); }).catch(() => null); }, []);
  return m;
}
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function ruleSentence(r: Rule, meta: Meta | null) {
  const cond = r.conditions.map((c) => { const d = meta?.conditions.find((x) => x.type === c.type); return d ? `${d.label.toLowerCase()}${d.unit ? ` ${c.n ?? '?'} ${d.unit}` : ''}` : c.type; }).join(' и ') || '…';
  const steps = r.steps.map((s) => `${s.afterDays ? `через ${s.afterDays} дн. ` : 'сразу '}${s.action === 'message' ? 'сообщение клиенту' : s.action === 'task' ? `задача «${s.title ?? ''}»` : `+${s.points ?? 0} баллов`}`).join(', затем ') || '…';
  return `Если ${cond}, то ${steps}`;
}

export function RulesEditor({ value, onChange, changed }: { value: Rule[]; onChange: (v: Rule[]) => void; changed: boolean }) {
  const meta = useMeta();
  const [open, setOpen] = useState<string | null>(null);
  const set = (i: number, r: Rule) => onChange(value.map((x, j) => (j === i ? r : x)));
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="small muted">Правило срабатывает раз в день для клиентов, которые подходят под все условия, и запускает цепочку шагов. Сообщения уходят в рабочее время, с учётом отписки и лимита автосообщений в неделю. Изменения вступят в силу после проверки на истории и утверждения.{changed && ' · есть правки'}</div>
      {value.map((r, i) => (
        <div key={r.id} className="item" style={{ display: 'grid', gap: 8 }}>
          <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="link" style={{ textAlign: 'left' }} onClick={() => setOpen(open === r.id ? null : r.id)}><b>{r.name || 'Без названия'}</b></button>
            <span className="row" style={{ gap: 6 }}>
              <label className="row small" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={r.enabled} onChange={(e) => set(i, { ...r, enabled: e.target.checked })} />включено</label>
              <button className="btn sm" aria-label="Удалить правило" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
            </span>
          </div>
          <span className="small">{ruleSentence(r, meta)}</span>
          {open === r.id && meta && <RuleForm r={r} meta={meta} onChange={(x) => set(i, x)} />}
        </div>))}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => { const r: Rule = { id: newId(), name: '', enabled: true, conditions: [{ type: 'inactive_days', n: 10 }], steps: [{ action: 'task', afterDays: 0, title: '', dueHours: 24 }], stopOnVisit: true, stopOnPurchase: true, cooldownDays: 30, marketing: false }; onChange([...value, r]); setOpen(r.id); }}>Новое правило</button>
        {meta?.templates.map((t) => <button key={t.name} className="btn sm" onClick={() => { const r = { ...structuredClone(t), id: newId() }; onChange([...value, r]); setOpen(r.id); }}>Шаблон: {t.name}</button>)}
      </div>
    </div>
  );
}

function RuleForm({ r, meta, onChange }: { r: Rule; meta: Meta; onChange: (r: Rule) => void }) {
  const setC = (i: number, c: Cond) => onChange({ ...r, conditions: r.conditions.map((x, j) => (j === i ? c : x)) });
  const setS = (i: number, s: Step) => onChange({ ...r, steps: r.steps.map((x, j) => (j === i ? s : x)) });
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label className="f">Название<input value={r.name} onChange={(e) => onChange({ ...r, name: e.target.value })} placeholder="Например: пропал перед окончанием абонемента" /></label>
      <b className="small">Если (все условия вместе)</b>
      {r.conditions.map((c, i) => {
        const d = meta.conditions.find((x) => x.type === c.type);
        return (
          <div key={i} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select value={c.type} onChange={(e) => { const nd = meta.conditions.find((x) => x.type === e.target.value); setC(i, nd?.unit ? { type: e.target.value, n: c.n ?? nd.min ?? 1 } : { type: e.target.value }); }} style={{ width: 'auto', maxWidth: 360 }} aria-label="Условие">
              {meta.conditions.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</select>
            {d?.unit && <><input type="number" value={c.n ?? ''} min={d.min ?? 0} max={d.max ?? undefined} onChange={(e) => setC(i, { ...c, n: Number(e.target.value) })} style={{ width: 80 }} aria-label="Число" /><span className="small muted">{d.unit}</span></>}
            {r.conditions.length > 1 && <button className="btn sm" aria-label="Убрать условие" onClick={() => onChange({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}>×</button>}
          </div>);
      })}
      {r.conditions.length < 6 && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => onChange({ ...r, conditions: [...r.conditions, { type: 'has_active' }] })}>+ условие</button>}

      <b className="small">То (шаги по порядку)</b>
      {r.steps.map((s, i) => (
        <div key={i} className="card" style={{ display: 'grid', gap: 6, padding: 10 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="small">Через</span><input type="number" min={0} max={60} value={s.afterDays} onChange={(e) => setS(i, { ...s, afterDays: Number(e.target.value) })} style={{ width: 64 }} aria-label="Через сколько дней" /><span className="small">дн. после срабатывания</span>
            <select value={s.action} onChange={(e) => { const a = e.target.value as Step['action']; setS(i, a === 'message' ? { action: a, afterDays: s.afterDays, text: '' } : a === 'task' ? { action: a, afterDays: s.afterDays, title: '', dueHours: 24 } : { action: a, afterDays: s.afterDays, points: 100 }); }} style={{ width: 'auto' }} aria-label="Действие">
              {meta.actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}</select>
            {r.steps.length > 1 && <button className="btn sm" aria-label="Убрать шаг" onClick={() => onChange({ ...r, steps: r.steps.filter((_, j) => j !== i) })}>×</button>}
          </div>
          {s.action === 'message' && <textarea rows={2} value={s.text ?? ''} onChange={(e) => setS(i, { ...s, text: e.target.value })} placeholder="{имя}, давно вас не видели! … ({имя} и {клуб} подставятся сами)" />}
          {s.action === 'task' && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><input value={s.title ?? ''} onChange={(e) => setS(i, { ...s, title: e.target.value })} placeholder="Что сделать: позвонить {имя}…" style={{ flex: 1, minWidth: 220 }} />
            <span className="small">срок</span><input type="number" min={1} value={s.dueHours ?? 24} onChange={(e) => setS(i, { ...s, dueHours: Number(e.target.value) })} style={{ width: 64 }} aria-label="Срок, часов" /><span className="small">ч</span></div>}
          {s.action === 'points' && <div className="row" style={{ gap: 6 }}><input type="number" min={1} value={s.points ?? 0} onChange={(e) => setS(i, { ...s, points: Number(e.target.value) })} style={{ width: 100 }} aria-label="Баллов" /><span className="small">баллов (если бонусная программа включена)</span></div>}
        </div>))}
      {r.steps.length < 5 && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => onChange({ ...r, steps: [...r.steps, { action: 'task', afterDays: r.steps[r.steps.length - 1]?.afterDays ?? 0, title: '', dueHours: 24 }] })}>+ шаг</button>}

      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={r.stopOnVisit} onChange={(e) => onChange({ ...r, stopOnVisit: e.target.checked })} />остановить, если клиент пришёл</label>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={r.stopOnPurchase} onChange={(e) => onChange({ ...r, stopOnPurchase: e.target.checked })} />остановить, если купил</label>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={r.marketing} onChange={(e) => onChange({ ...r, marketing: e.target.checked })} />рекламное (только с согласием)</label>
        <label className="row small" style={{ gap: 4 }}>повторно тому же клиенту не чаще раза в<input type="number" min={1} max={365} value={r.cooldownDays} onChange={(e) => onChange({ ...r, cooldownDays: Number(e.target.value) })} style={{ width: 64 }} aria-label="Не чаще раза в дней" />дн.</label>
      </div>
    </div>
  );
}

/** «Было → станет» для правил в версии настроек */
export function RulesDiff({ from, to }: { from: Rule[] | null; to: Rule[] | null }) {
  const meta = useMeta();
  const was = new Map((from ?? []).map((r) => [r.id, JSON.stringify(r)]));
  const now = to ?? [];
  const removed = (from ?? []).filter((r) => !now.some((x) => x.id === r.id));
  return (
    <ul style={{ margin: 0, paddingLeft: 18, textAlign: 'left', fontFamily: 'var(--f)' }}>
      {now.map((r) => {
        const tag = !was.has(r.id) ? 'новое' : was.get(r.id) !== JSON.stringify(r) ? 'изменено' : '';
        return <li key={r.id} className="small"><b>{r.name}</b>{!r.enabled && ' (выключено)'}{tag && <span className="chip acc" style={{ marginLeft: 6 }}>{tag}</span>}<br /><span className="muted">{ruleSentence(r, meta)}</span></li>;
      })}
      {removed.map((r) => <li key={r.id} className="small"><s>{r.name}</s> <span className="chip bad">удалено</span></li>)}
      {!now.length && !removed.length && <li className="small muted">правил нет</li>}
    </ul>
  );
}

/** Журнал: сколько раз сработало за 30 дней и последние действия */
export function RulesJournal({ clubId, openPerson }: { clubId: string; openPerson?: (id: string) => void }) {
  const [d, setD] = useState<{ rules: { id: string; name: string; enabled: boolean; text: string; runs: number; active: number; goal: number }[];
    recent: { at: string; rule: string; person: string; personId: string; action: string; result: string; details: string | null }[] } | null>(null);
  useEffect(() => { api<NonNullable<typeof d>>('GET', `/api/rules/runs?clubId=${clubId}`).then(setD).catch(() => setD(null)); }, [clubId]);
  if (!d || (!d.rules.length && !d.recent.length)) return null;
  const A: Record<string, string> = { message: 'сообщение', task: 'задача', points: 'баллы' };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <b className="small">Как работают действующие правила (30 дней)</b>
      <div className="tbl"><table><thead><tr><th>Правило</th><th className="num">Сработало</th><th className="num">В работе</th><th className="num">Цель достигнута</th></tr></thead>
        <tbody>{d.rules.map((r) => <tr key={r.id}><td>{r.name}{!r.enabled && <span className="muted"> (выключено)</span>}</td><td className="num">{r.runs}</td><td className="num">{r.active}</td><td className="num">{r.goal}</td></tr>)}</tbody></table></div>
      {d.recent.length > 0 && <details><summary className="small">Последние действия</summary>
        {d.recent.map((x, i) => <div key={i} className="small">{dt(x.at)} · {x.rule} · {openPerson ? <button className="link" onClick={() => openPerson(x.personId)}>{x.person}</button> : x.person} · {A[x.action] ?? x.action}: {x.result === 'done' ? 'сделано' : `пропущено — ${x.details}`}</div>)}
      </details>}
      <span className="small muted">«Цель достигнута» — цепочка остановилась, потому что клиент пришёл или купил.</span>
    </div>
  );
}
