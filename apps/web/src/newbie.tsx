// Программа первых 30 дней новичка: кто сейчас в программе, какие шаги пройдены, кто в зоне риска; настройка шагов.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { errText, toast } from './ui.ts';

type Step = { key: string; title: string; day: number; kind: 'intro' | 'call' | 'visits'; minVisits?: number; assignTo: 'manager' | 'trainer' };
type PStep = { key: string; title: string; kind: string; dueOn: string; status: string; visits: number | null; minVisits: number | null; assignee: string | null };
type Prog = { id: string; personId: string; name: string; startedOn: string; status: string; product: string; steps: PStep[]; visits: number; day: number; risk: boolean };
type Data = { settings: { enabled: boolean; steps: Step[]; custom: boolean }; canManage: boolean; list: Prog[]; stats: { active: number; risk: number; done: number } };

const d = (s: string) => s.split('-').reverse().slice(0, 2).join('.');
const ST: Record<string, [string, string]> = { pending: ['впереди', ''], task: ['задача', 'warn'], done: ['сделано', 'ok'], ok: ['само', 'ok'], skipped: ['пропущено', ''] };
const KIND: Record<string, string> = { intro: 'Вводная тренировка', call: 'Звонок', visits: 'Проверка визитов' };

export function NewbieView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<'active' | 'risk' | 'done'>('active');
  const [edit, setEdit] = useState<Step[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Data>('GET', `/api/newbie?clubId=${club}`).then(setData).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club]);
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const rows = data.list.filter((p) => (filter === 'done' ? p.status === 'done' : p.status === 'active' && (filter === 'active' || p.risk)));
  const save = async (body: object) => {
    setErr('');
    try { await api('PUT', '/api/newbie/settings', { clubId: club, ...body }); toast('Сохранено'); setEdit(null); load(); } catch (x) { setErr(errText(x)); }
  };
  const runNow = async () => { try { const r = await api<{ tasks: number }>('POST', '/api/newbie/run', { clubId: club }); toast(`Поставлено задач: ${r.tasks}`); load(); } catch (x) { setErr(errText(x)); } };
  const setStep = (i: number, p: Partial<Step>) => setEdit(edit!.map((s, j) => (j === i ? { ...s, ...p } : s)));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0, maxWidth: 760 }}>
        После первой покупки клиент попадает в программу на 30 дней. Система сама ставит задачи по шагам: записать на вводную тренировку, позвонить через неделю,
        проверить визиты за 2 недели. Если клиент уже записан на занятие или ходит достаточно, шаг закрывается сам.
        {!data.settings.enabled && <b> Программа в клубе выключена.</b>}
      </p>
      {err && <div className="err">{err}</div>}
      <div className="kpis">
        <button className={`card kpi-c click ${filter === 'active' ? 'on' : ''}`} aria-pressed={filter === 'active'} onClick={() => setFilter('active')} style={{ textAlign: 'left' }}><span className="lbl">В программе</span><b className="num">{data.stats.active}</b></button>
        <button className={`card kpi-c click ${filter === 'risk' ? 'on' : ''}`} aria-pressed={filter === 'risk'} onClick={() => setFilter('risk')} style={{ textAlign: 'left' }}><span className="lbl">В зоне риска</span><b className={`num ${data.stats.risk ? 'bad' : ''}`}>{data.stats.risk}</b></button>
        <button className={`card kpi-c click ${filter === 'done' ? 'on' : ''}`} aria-pressed={filter === 'done'} onClick={() => setFilter('done')} style={{ textAlign: 'left' }}><span className="lbl">Прошли программу</span><b className="num">{data.stats.done}</b></button>
      </div>

      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>{filter === 'risk' ? 'Новичков в зоне риска нет.' : 'Пока никого.'}</p> : (
          <div className="tbl"><table>
            <thead><tr><th>Клиент</th><th>День</th><th>Визитов</th>{data.settings.steps.map((s) => <th key={s.key} title={s.title}>{s.day === 0 ? 'Сразу' : `День ${s.day}`}</th>)}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id} className={p.risk ? 'over' : ''}>
                <td><button className="link" onClick={() => openPerson(p.personId)}>{p.name}</button><div className="small muted">{p.product} · с {d(p.startedOn)}</div></td>
                <td>{Math.min(p.day, 30)}</td>
                <td className={p.risk ? 'bad' : ''}>{p.visits}</td>
                {data.settings.steps.map((s) => {
                  const x = p.steps.find((y) => y.key === s.key);
                  if (!x) return <td key={s.key}>—</td>;
                  const [label, cls] = ST[x.status] ?? [x.status, ''];
                  return <td key={s.key} title={x.title}><span className={`chip ${cls}`}>{label}</span>{x.assignee && x.status === 'task' && <div className="small muted">{x.assignee}</div>}</td>;
                })}
              </tr>))}</tbody>
          </table></div>)}
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Шаги программы</h2>
          {data.canManage && !edit && <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={runNow}>Проверить сейчас</button>
            <button className="btn sm" onClick={() => save({ enabled: !data.settings.enabled })}>{data.settings.enabled ? 'Выключить' : 'Включить'}</button>
            <button className="btn sm pri" onClick={() => setEdit(data.settings.steps)}>Изменить шаги</button></div>}
        </div>
        {!edit ? (
          <ol style={{ margin: 0, paddingLeft: 20 }}>{data.settings.steps.map((s) => (
            <li key={s.key}><b>{s.day === 0 ? 'В день покупки' : `День ${s.day}`}</b>: {s.title}
              <span className="small muted"> · {KIND[s.kind]}{s.kind === 'visits' ? `, нужно ${s.minVisits}` : ''} · {s.assignTo === 'trainer' ? 'тренеру' : 'менеджеру'}</span></li>))}</ol>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {edit.map((s, i) => (
              <div key={i} className="item row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <label className="f" style={{ width: 80 }}>День<input type="number" value={s.day} onChange={(e) => setStep(i, { day: Number(e.target.value) })} /></label>
                <label className="f" style={{ flex: 1, minWidth: 220 }}>Что сделать<input value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} /></label>
                <label className="f">Вид<select value={s.kind} onChange={(e) => setStep(i, { kind: e.target.value as Step['kind'], minVisits: e.target.value === 'visits' ? s.minVisits ?? 3 : undefined })}>
                  <option value="intro">Вводная тренировка</option><option value="call">Звонок</option><option value="visits">Проверка визитов</option></select></label>
                {s.kind === 'visits' && <label className="f" style={{ width: 110 }}>Визитов не меньше<input type="number" value={s.minVisits ?? 3} onChange={(e) => setStep(i, { minVisits: Number(e.target.value) })} /></label>}
                <label className="f">Кому<select value={s.assignTo} onChange={(e) => setStep(i, { assignTo: e.target.value as Step['assignTo'] })}><option value="manager">Менеджеру</option><option value="trainer">Тренеру</option></select></label>
                <button className="btn sm" onClick={() => setEdit(edit.filter((_, j) => j !== i))} aria-label="Удалить шаг">✕</button>
              </div>))}
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" disabled={edit.length >= 10} onClick={() => setEdit([...edit, { key: `s${Date.now() % 100000}`, title: '', day: 21, kind: 'call', assignTo: 'manager' }])}>+ Шаг</button>
              <button className="btn sm pri" onClick={() => save({ steps: edit })}>Сохранить</button>
              <button className="btn sm" onClick={() => setEdit(null)}>Отмена</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Новые шаги применяются к клиентам, которые попадут в программу после сохранения.</p>
          </div>)}
      </div>
    </div>
  );
}
