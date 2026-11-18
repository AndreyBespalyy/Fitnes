// «Мой день менеджера» (повторная проверка CRM 18.11.2026, п. 14): что делать сейчас — на одном экране сверху вниз:
// заявки без ответа → задачи на сегодня → кому звонить. Раньше это было в пяти разделах.
import { useEffect, useState } from 'react';
import { api, type Club } from './api.ts';
import { dt, errText } from './ui.ts';
import { LeadsSpeed } from './salesOps.tsx';
import { DayPlan } from './hot.tsx';

type T = { id: string; title: string; dueAt: string; personId: string | null; personName: string | null; overdue: boolean; clubId: string };
const goTo = (url: string) => window.dispatchEvent(new CustomEvent('crm-go', { detail: url }));

export function MyDay({ clubs, clubId, openPerson }: { clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const club = clubId !== 'all' ? clubId : clubs[0]?.id ?? '';
  const [tasks, setTasks] = useState<T[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<T[]>('GET', `/api/tasks${clubId !== 'all' ? `?clubId=${clubId}` : ''}`).then(setTasks).catch((x) => setErr(errText(x))); }, [clubId]);
  if (!club) return null;
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const today = (tasks ?? []).filter((t) => new Date(t.dueAt) <= end);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}><h1 style={{ margin: 0 }}>Мой день</h1>
        <button className="btn pri sm" onClick={() => goTo('/?tab=leads&add=1')}>+ Лид</button></div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>1. Заявки без ответа</h2>
        <LeadsSpeed clubId={club} openPerson={openPerson} />
      </div>
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div className="row between"><h2 style={{ margin: 0 }}>2. Задачи на сегодня{tasks ? ` · ${today.length}` : ''}</h2>
          <button className="btn sm" onClick={() => goTo('/?tab=tasks')}>Все задачи</button></div>
        {err && <div className="err">{err}</div>}
        {tasks && !today.length && <p className="muted small" style={{ margin: 0 }}>На сегодня задач нет.</p>}
        {today.slice(0, 15).map((t) => (
          <div key={t.id} className={`item row between ${t.overdue ? 'over' : ''}`} style={{ gap: 8, flexWrap: 'wrap' }}>
            <span><b>{t.title}</b>{t.personName ? ` · ${t.personName}` : ''}<br /><span className="small muted">{t.overdue ? 'просрочено, ' : ''}до {dt(t.dueAt)}</span></span>
            {t.personId && <button className="btn sm" onClick={() => openPerson(t.personId!)}>Карточка</button>}
          </div>))}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>3. Кому звонить</h2>
        <DayPlan clubId={club} openPerson={openPerson} />
      </div>
    </div>
  );
}
