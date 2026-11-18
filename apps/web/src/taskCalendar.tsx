// Календарь задач (замечание №41): сколько задач на каждый день ближайших двух недель и сколько просрочено.
// На рабочем столе нажатие на день открывает «Задачи» за этот день; в «Задачах» — фильтрует список.
import { useEffect, useState } from 'react';
import { api } from './api.ts';

type T = { dueAt: string; overdue: boolean; doneAt?: string | null };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function TaskCalendar({ tasks, value, onPick, days = 14 }: { tasks: T[]; value?: string | null; onPick: (day: string | null) => void; days?: number }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const open = tasks.filter((t) => !t.doneAt);
  const overdue = open.filter((t) => t.overdue).length;
  const by: Record<string, number> = {};
  for (const t of open) if (!t.overdue) { const k = iso(new Date(t.dueAt)); by[k] = (by[k] ?? 0) + 1; }
  const list = Array.from({ length: days }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() + i); return d; });
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2 style={{ margin: 0 }}>Календарь задач</h2>{value && <button className="btn sm" onClick={() => onPick(null)}>Все дни</button>}</div>
      <div className="tcal" role="group" aria-label="Задачи по дням">
        {overdue > 0 && <button className="tcal-d over" aria-pressed={value === 'overdue'} onClick={() => onPick('overdue')}><span className="small">просрочено</span><b className="num">{overdue}</b></button>}
        {list.map((d, i) => {
          const k = iso(d); const n = by[k] ?? 0; const wk = d.getDay() === 0 || d.getDay() === 6;
          return (
            <button key={k} className={`tcal-d ${n ? 'has' : ''} ${wk ? 'wk' : ''}`} aria-pressed={value === k} onClick={() => onPick(k)}
              title={`${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: задач ${n}`}>
              <span className="small">{i === 0 ? 'сегодня' : i === 1 ? 'завтра' : `${WD[d.getDay()]} ${d.getDate()}`}</span>
              <b className="num">{n || '·'}</b>
            </button>);
        })}
      </div>
    </div>
  );
}

/** Для рабочего стола: сам загружает свои задачи. */
export function MyTaskCalendar({ clubId, onPick }: { clubId: string; onPick: (day: string) => void }) {
  const [tasks, setTasks] = useState<T[] | null>(null);
  useEffect(() => { api<T[]>('GET', `/api/tasks?scope=mine${clubId !== 'all' ? `&clubId=${clubId}` : ''}`).then(setTasks).catch(() => setTasks(null)); }, [clubId]);
  if (!tasks) return null;
  return <TaskCalendar tasks={tasks} onPick={(d) => d && onPick(d)} />;
}

export const sameDay = (dueAt: string, day: string) => iso(new Date(dueAt)) === day;
