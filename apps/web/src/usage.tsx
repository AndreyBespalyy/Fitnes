// Как пользуются системой: какие разделы открывают, какие нет, кто из сотрудников работает каждый день.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt, errText } from './ui.ts';

type Data = {
  days: number;
  sections: { tab: string; label: string | null; opens: number; users: number; lastDay: string }[];
  roles: { role: string; staff: number; active: number; top: { tab: string; label: string | null; opens: number }[] }[];
  people: { id: string; fullName: string; roles: string | null; activeDays: number; opens: number; lastDay: string | null; lastSeenAt: string | null }[];
  daily: { day: string; users: number; opens: number }[];
};
const dday = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

export function UsagePage({ tabs }: { tabs: [string, string][] }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Data>('GET', `/api/usage?days=${days}`).then((x) => { setD(x); setErr(''); }).catch((x) => setErr(errText(x))); }, [days]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const name = (tab: string, label: string | null) => tabs.find((t) => t[0] === tab)?.[1] ?? label ?? tab;
  const used = new Set(d.sections.map((s) => s.tab));
  const unused = tabs.filter(([k]) => !used.has(k) && k !== 'usage' && k !== 'profile');
  const max = Math.max(1, ...d.sections.map((s) => s.opens));
  const dmax = Math.max(1, ...d.daily.map((x) => x.users));
  const since = Date.now() - d.days * 86400_000;
  const quiet = d.people.filter((p) => p.activeDays === 0 && (!p.lastSeenAt || new Date(p.lastSeenAt).getTime() < since));
  // Все дни периода, включая пустые
  const byDay = new Map(d.daily.map((x) => [String(x.day).slice(0, 10), x]));
  const allDays = Array.from({ length: d.days }, (_, i) => { const t = new Date(Date.now() - (d.days - 1 - i) * 86400_000); const k = t.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); return byDay.get(k) ?? { day: k, users: 0, opens: 0 }; });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Как пользуются системой</h2>
        <div className="tabs" role="group" aria-label="Период">{[7, 30, 90].map((n) => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} дней</button>)}</div>
      </div>
      <div className="small muted">Считаем только открытия разделов: что сотрудник делал внутри, не записывается. Помогает понять, что нужно обучить, упростить или убрать.</div>

      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <b>Сотрудников в системе по дням</b>
        <div className="use-days" role="img" aria-label="Сотрудников в системе по дням">
          {allDays.map((x) => <span key={x.day} title={`${dday(x.day)}: ${x.users} сотр., ${x.opens} открытий`} style={{ height: `${x.users ? Math.max(4, (x.users / dmax) * 60) : 2}px`, opacity: x.users ? 1 : 0.3 }} />)}
        </div>
        <div className="row between small muted"><span>{dday(allDays[0].day)}</span><span>сегодня</span></div>
        {d.daily.length < 3 && <span className="small muted">Статистика копится с 11 ноября 2026 года, через пару недель картина станет полной.</span>}
      </div>

      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', alignItems: 'start' }}>
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <b>Разделы</b>
          <div className="tbl"><table><thead><tr><th>Раздел</th><th className="num">Открытий</th><th className="num">Сотрудников</th></tr></thead>
            <tbody>{d.sections.map((s) => <tr key={s.tab}><td>{name(s.tab, s.label)}<div className="use-bar"><i style={{ width: `${(s.opens / max) * 100}%` }} /></div></td><td className="num">{s.opens}</td><td className="num">{s.users}</td></tr>)}</tbody></table></div>
          {unused.length > 0 && <div className="small"><b>Никто не открывал:</b> {unused.map(([, l]) => l).join(', ')}</div>}
        </div>
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <b>По ролям</b>
          {d.roles.map((r) => (
            <div key={r.role} className="item" style={{ display: 'grid', gap: 2 }}>
              <span><b>{r.role}</b> <span className="small muted">· заходили {r.active} из {r.staff}</span></span>
              <span className="small">{r.top.length ? r.top.map((x) => `${name(x.tab, x.label)} (${x.opens})`).join(', ') : <span className="muted">не заходили</span>}</span>
            </div>))}
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <b>Сотрудники</b>
        {quiet.length > 0 && <div className="small" style={{ color: 'var(--bad)' }}>Не заходили в систему за {d.days} дней: {quiet.map((p) => p.fullName).join(', ')}</div>}
        <div className="tbl"><table><thead><tr><th>Сотрудник</th><th>Роль</th><th className="num">Дней в системе</th><th className="num">Открытий</th><th>Последний раз</th></tr></thead>
          <tbody>{d.people.map((p) => <tr key={p.id}><td>{p.fullName}</td><td className="small">{p.roles}</td><td className="num">{p.activeDays}</td><td className="num">{p.opens}</td>
            <td className="small">{p.lastSeenAt ? dt(p.lastSeenAt) : p.lastDay ? dday(p.lastDay) : '—'}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}
