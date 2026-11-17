// Статистика сотрудников для собственника (17.11.2026): за сутки по каждой роли — кто заходил, что делал, какие замечания и пожелания оставил.
import { Fragment, useEffect, useState } from 'react';
import { api } from './api.ts';
import { errText } from './ui.ts';

type Note = { number: number; at: string; kind: string | null; kindLabel: string; page: string | null; body: string; status: string; source: 'note' | 'support'; hasShot?: boolean };
type Person = {
  id: string; fullName: string; role: string; roleName: string; clubs: string | null; active: boolean; firstAt: string | null; lastAt: string | null;
  logins: { at: string; device: string | null }[]; failed: number;
  views: { at: string; tab: string; label: string | null }[];
  actions: { at: string; action: string; label: string; object: string | null }[];
  notes: Note[];
};
type Data = { hours: number; since: string; till: string; roles: { code: string; name: string; staff: number; active: number; actions: number; notes: number; people: Person[] }[] };

const STATUS: Record<string, [string, string]> = {
  new: ['новое', 'warn'], in_work: ['в работе', 'acc'], done: ['сделано', 'ok'], rejected: ['отклонено', ''], open: ['ждёт ответа', 'warn'], answered: ['есть ответ', 'ok'], closed: ['закрыто', ''],
};
const tz = { timeZone: 'Europe/Moscow' } as const;
const hm = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { ...tz, hour: '2-digit', minute: '2-digit' });
const day = (s: string) => new Date(s).toLocaleDateString('ru-RU', { ...tz, day: 'numeric', month: 'short' });
const when = (s: string, multi: boolean) => (multi ? `${day(s)}, ${hm(s)}` : hm(s));
const device = (ua: string | null) => (!ua ? '' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'браузер');
const PERIODS: [number, string][] = [[24, 'Сутки'], [72, '3 дня'], [168, 'Неделя']];

/** Подряд идущие открытия одного раздела — одной строкой */
function squash(views: Person['views']) {
  const out: { at: string; label: string; n: number }[] = [];
  for (const v of views) {
    const label = v.label ?? v.tab;
    const last = out[out.length - 1];
    if (last && last.label === label) last.n++; else out.push({ at: v.at, label, n: 1 });
  }
  return out;
}

export function ActivityPage() {
  const [hours, setHours] = useState(24);
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [role, setRole] = useState<string>('');
  const load = () => api<Data>('GET', `/api/activity?hours=${hours}`).then((x) => { setD(x); setErr(''); }).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [hours]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const multi = d.hours > 24 || day(d.since) !== day(d.till);
  const shown = d.roles.filter((r) => !role || r.code === role);
  const total = d.roles.reduce((a, r) => ({ staff: a.staff + r.staff, active: a.active + r.active, actions: a.actions + r.actions, notes: a.notes + r.notes }), { staff: 0, active: 0, actions: 0, notes: 0 });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div><h1 style={{ margin: 0 }}>Статистика сотрудников</h1>
          <span className="small muted">с {day(d.since)}, {hm(d.since)} по {day(d.till)}, {hm(d.till)} (время московское). Нажмите на сотрудника — входы, разделы, действия и замечания по времени.</span></div>
        <div className="row" style={{ gap: 6 }}>
          <div className="tabs" role="group" aria-label="Период">{PERIODS.map(([h, t]) => <button key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>{t}</button>)}</div>
          <button className="btn sm" onClick={load}>Обновить</button>
        </div>
      </div>

      <div className="kpis">
        <div className={`card kpi-c click ${role === '' ? 'on' : ''}`} onClick={() => setRole('')} role="button">
          <span className="lbl">Все роли</span><b className="num">{total.active} из {total.staff}</b>
          <span className="small muted">заходили · действий {total.actions} · замечаний и пожеланий {total.notes}</span></div>
        {d.roles.map((r) => (
          <div key={r.code} className={`card kpi-c click ${role === r.code ? 'on' : ''}`} onClick={() => setRole(role === r.code ? '' : r.code)} role="button">
            <span className="lbl">{r.name}</span><b className="num">{r.active} из {r.staff}</b>
            <span className="small muted">заходили · действий {r.actions} · замечаний {r.notes}</span></div>))}
      </div>

      {shown.map((r) => (
        <div key={r.code} className="card" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ margin: 0 }}>{r.name}</h2>
          <div className="tbl"><table>
            <thead><tr><th>Сотрудник</th><th>В системе</th><th>Входы</th><th>Разделы</th><th>Действия</th><th>Замечания и пожелания</th></tr></thead>
            <tbody>{r.people.map((p) => (
              <Fragment key={p.id}>
                <tr className="click" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                  <td><b>{p.fullName}</b>{p.clubs && <div className="small muted">{p.clubs}</div>}</td>
                  <td className="small">{p.active && p.firstAt && p.lastAt ? `${when(p.firstAt, multi)} – ${when(p.lastAt, multi)}` : <span className="muted">не заходил</span>}</td>
                  <td className="num">{p.logins.length || '—'}{p.failed ? <div className="small bad">неверный пароль: {p.failed}</div> : null}</td>
                  <td className="num">{p.views.length || '—'}</td>
                  <td className="num">{p.actions.length || '—'}</td>
                  <td className="num">{p.notes.length ? <b>{p.notes.length}</b> : '—'}</td>
                </tr>
                {open === p.id && <tr><td colSpan={6}><Details p={p} multi={multi} /></td></tr>}
              </Fragment>))}
            </tbody></table></div>
        </div>))}
    </div>
  );
}

function Details({ p, multi }: { p: Person; multi: boolean }) {
  const views = squash(p.views);
  if (!p.active && !p.notes.length) return <p className="muted" style={{ margin: 0 }}>За этот период сотрудник в систему не заходил.</p>;
  return (
    <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 10 }}>
      <div className="item" style={{ display: 'grid', gap: 4, alignContent: 'start' }}><b>Входы</b>
        {p.logins.length ? p.logins.map((l, i) => <div key={i} className="small">{when(l.at, multi)}{l.device ? ` · ${device(l.device)}` : ''}</div>)
          : <span className="small muted">Входа с паролем не было — работал в уже открытом сеансе.</span>}
        {p.failed > 0 && <span className="small bad">Неверный пароль: {p.failed} раз</span>}</div>
      <div className="item" style={{ display: 'grid', gap: 4, alignContent: 'start' }}><b>Открывал разделы</b>
        {views.length ? views.map((v, i) => <div key={i} className="small">{when(v.at, multi)} · {v.label}{v.n > 1 ? ` (×${v.n})` : ''}</div>) : <span className="small muted">Нет.</span>}</div>
      <div className="item" style={{ display: 'grid', gap: 4, alignContent: 'start' }}><b>Действия</b>
        {p.actions.length ? p.actions.map((a, i) => <div key={i} className="small">{when(a.at, multi)} · {a.label}{a.object ? ` · ${a.object}` : ''}</div>) : <span className="small muted">Ничего не менял.</span>}</div>
      <div className="item" style={{ display: 'grid', gap: 6, alignContent: 'start' }}><b>Замечания и пожелания</b>
        {p.notes.length ? p.notes.map((n, i) => (
          <div key={i} className="small" style={{ display: 'grid', gap: 2 }}>
            <span>{when(n.at, multi)} · <b>{n.kindLabel}</b> № {n.number}{n.page ? ` · ${n.page}` : ''} {STATUS[n.status] && <span className={`chip ${STATUS[n.status][1]}`}>{STATUS[n.status][0]}</span>}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{n.body}</span>
          </div>)) : <span className="small muted">Не оставлял.</span>}
        {p.notes.some((n) => n.source === 'note') && <span className="small muted">Полностью, со скриншотами, — в «Журнале замечаний».</span>}</div>
    </div>
  );
}
