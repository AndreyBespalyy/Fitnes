// Рабочее место тренера: «Мой день» в приложении. Свои занятия и окна, отметка проведённого, клиенты и остатки пакетов,
// «предложить продление» и предварительный заработок за месяц. Экран рассчитан на телефон.
import { useEffect, useState } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Person = { id: string; personId: string; name: string; status: string; trial: boolean; visitsLeft: number | null; package: string | null };
type Session = { id: string; typeName: string; kind: string; roomName: string | null; status: string; capacity: number; day: string; from: string; to: string; started: boolean; people: Person[] };
type Client = { personId: string; name: string; lastAt: string | null; nextAt: string | null; sessions30: number; membershipId: string | null; package: string | null;
  visitsLeft: number | null; endsOn: string | null; reserved: number; reason?: string | null };
type Desk = {
  trainer: { id: string; name: string }; clubId: string; today: string; date: string;
  days: { day: string; shifts: { from: string; to: string }[]; windows: { from: string; to: string }[]; sessions: Session[] }[];
  unmarked: { id: string; typeName: string; at: string }[]; clients: Client[]; renew: Client[];
  earnings: { month: string; items: { code: string; title: string; basis: string; amountKop: number }[]; totalKop: number } | null;
  done: { personal: number; group: number }; offers: { n: number; agreed: number; renewed: number };
};
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayLabel = (d: string, today: string) => {
  const w = WD[new Date(`${d}T12:00:00Z`).getUTCDay()];
  return d === today ? `Сегодня, ${w}` : `${d.slice(8, 10)}.${d.slice(5, 7)}, ${w}`;
};
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ST: Record<string, string> = { booked: 'записан', attended: 'пришёл', no_show: 'не пришёл' };

export function TrainerPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [date, setDate] = useState('');
  const [trainerId, setTrainerId] = useState('');
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [d, setD] = useState<Desk | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const manager = can(me, 'schedule.manage');
  const load = () => club && api<Desk>('GET', `/api/trainer/desk?clubId=${club}${date ? `&date=${date}` : ''}${trainerId ? `&trainerId=${trainerId}` : ''}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club, date, trainerId]);
  useEffect(() => { if (manager && club) api<{ trainers: { id: string; fullName?: string; name?: string }[] }>('GET', `/api/schedule/setup?clubId=${club}`).then((s) => setTrainers(s.trainers.map((x) => ({ id: x.id, name: x.fullName ?? x.name ?? '' })))).catch(() => setTrainers([])); }, [club]);
  if (!club) return <p className="muted">Клубов нет.</p>;
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const offer = async (c: Client, result: string) => {
    try {
      const r = await api<{ taskId: string | null }>('POST', '/api/trainer/offers', { clubId: club, personId: c.personId, membershipId: c.membershipId, result });
      toast(r.taskId ? 'Менеджер получил задачу оформить продление' : 'Отмечено'); load();
    } catch (x) { setErr(errText(x)); }
  };
  const left = (c: Client) => (c.visitsLeft == null ? null : c.visitsLeft - c.reserved);
  return (
    <div className="trainer" style={{ display: 'grid', gap: 12, maxWidth: 900 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{trainerId && d.trainer.id !== me.id ? `Стол тренера: ${d.trainer.name}` : 'Мой день'}</h2>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {manager && trainers.length > 0 && <select value={trainerId} onChange={(e) => setTrainerId(e.target.value)} aria-label="Тренер" style={{ width: 'auto' }}>
            <option value="">Мой стол</option>{trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
          {clubId === 'all' && clubs.length > 1 && <select value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }} aria-label="Клуб">{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {d.unmarked.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 6, borderColor: 'var(--warn, #d97706)' }}>
          <b>Отметьте прошедшие занятия — без отметки они не попадут в зарплату</b>
          {d.unmarked.map((u) => <div key={u.id} className="row between"><span>{u.at} · {u.typeName}</span><button className="btn sm pri" onClick={() => setMark(u.id)}>Отметить</button></div>)}
        </div>)}
      {mark && <MarkSession id={mark} onDone={() => { setMark(null); load(); }} />}

      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Проведено в этом месяце</span><b className="num">{d.done.personal + d.done.group}</b><span className="small muted">персональных {d.done.personal}, групповых {d.done.group}</span></div>
        <div className="card kpi-c"><span className="lbl">Заработок за месяц</span><b className="num">{d.earnings ? rub(d.earnings.totalKop) : '—'}</b><span className="small muted">{d.earnings ? 'предварительно, до утверждения' : 'схема оплаты не задана'}</span></div>
        <div className="card kpi-c"><span className="lbl">Предложил продлить за 30 дней</span><b className="num">{d.offers.n}</b><span className="small muted">согласились {d.offers.agreed}, купили {d.offers.renewed}</span></div>
      </div>

      {d.renew.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <h2>Предложить продление</h2>
          {d.renew.map((c) => (
            <div key={c.personId} className="item" style={{ display: 'grid', gap: 6 }}>
              <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}><button className="link" onClick={() => openPerson(c.personId)}><b>{c.name}</b></button><span className="chip warn">{c.reason}</span></div>
              {c.package && <span className="small muted">{c.package}{c.nextAt ? ` · следующее занятие ${dt(c.nextAt)}` : ''}</span>}
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn sm pri" onClick={() => offer(c, 'agreed')}>Согласен продлить</button>
                <button className="btn sm" onClick={() => offer(c, 'thinking')}>Подумает</button>
                <button className="btn sm" onClick={() => offer(c, 'refused')}>Отказался</button>
              </div>
            </div>))}
          <span className="small muted">«Согласен» — менеджер получит задачу оформить новый пакет, продажа засчитается вам.</span>
        </div>)}

      <div className="row between"><h2 style={{ margin: 0 }}>Расписание</h2>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => setDate(addDays(d.date, -7))} aria-label="Предыдущая неделя">←</button>
          {d.date !== d.today && <button className="btn sm" onClick={() => setDate('')}>Сегодня</button>}
          <button className="btn sm" onClick={() => setDate(addDays(d.date, 7))} aria-label="Следующая неделя">→</button>
        </span></div>
      {d.days.filter((x) => x.sessions.length || x.windows.length).length === 0 && <p className="muted" style={{ margin: 0 }}>На этой неделе занятий и смен нет.</p>}
      {d.days.filter((x) => x.sessions.length || x.windows.length).map((x) => (
        <div key={x.day} className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}><b>{dayLabel(x.day, d.today)}</b>
            {x.shifts.length > 0 && <span className="small muted">смена {x.shifts.map((s) => `${s.from}–${s.to}`).join(', ')}</span>}</div>
          {x.sessions.map((s) => (
            <div key={s.id} className="item" style={{ display: 'grid', gap: 4 }}>
              <div className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span><b>{s.from}–{s.to}</b> · {s.typeName}{s.roomName ? ` · ${s.roomName}` : ''}</span>
                {s.status === 'done' ? <span className="chip ok">проведено</span> : s.started ? <button className="btn sm pri" onClick={() => setMark(s.id)}>Отметить</button>
                  : <span className="small muted">{s.kind === 'group' ? `${s.people.length} из ${s.capacity}` : ''}</span>}
              </div>
              {s.people.length === 0 ? <span className="small muted">Никто не записан</span> : s.kind === 'group' && s.people.length > 3 ? (
                <details><summary className="small">Записаны: {s.people.length}</summary>{s.people.map((p) => <People key={p.id} p={p} openPerson={openPerson} />)}</details>
              ) : s.people.map((p) => <People key={p.id} p={p} openPerson={openPerson} />)}
            </div>))}
          {x.windows.length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="small muted">Свободно:</span>{x.windows.map((w) => <span key={w.from} className="chip">{w.from}–{w.to}</span>)}</div>}
        </div>))}

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Мои клиенты</h2>
        {d.clients.length === 0 ? <p className="muted" style={{ margin: 0 }}>Здесь появятся клиенты, которые занимаются у вас персонально.</p> : (
          <div className="tbl"><table><thead><tr><th>Клиент</th><th>Пакет</th><th>Свободно занятий</th><th>Следующее</th></tr></thead>
            <tbody>{d.clients.map((c) => { const l = left(c); return <tr key={c.personId}><td><button className="link" onClick={() => openPerson(c.personId)}>{c.name}</button><div className="small muted">за 30 дней: {c.sessions30}</div></td>
              <td className="small">{c.package ?? <span className="bad">нет пакета</span>}{c.endsOn && <div className="muted">до {c.endsOn.split('-').reverse().join('.')}</div>}</td>
              <td className={l != null && l <= 2 ? 'bad' : ''}>{l ?? '—'}{c.reserved ? <span className="small muted"> (+{c.reserved} записано)</span> : null}</td>
              <td className="small">{c.nextAt ? dt(c.nextAt) : '—'}</td></tr>; })}</tbody></table></div>)}
      </div>

      {d.earnings && (
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <h2>Заработок за {d.earnings.month.split('-').reverse().join('.')}</h2>
          {d.earnings.items.map((i, k) => <div key={k} className="row between small" style={{ gap: 8 }}><span><b>{i.title}</b><br /><span className="muted">{i.basis}</span></span><b>{rub(i.amountKop)}</b></div>)}
          <div className="row between"><b>Итого предварительно</b><b>{rub(d.earnings.totalKop)}</b></div>
          <span className="small muted">Точная сумма — в ведомости после утверждения управляющим.</span>
        </div>)}
    </div>
  );
}

function People({ p, openPerson }: { p: Person; openPerson: (id: string) => void }) {
  return <div className="row between small"><button className="link" onClick={() => openPerson(p.personId)}>{p.name}</button>
    <span className="muted">{p.trial ? 'пробное' : p.package ? `${p.package}${p.visitsLeft != null ? `, осталось ${p.visitsLeft}` : ''}` : ''}{p.status !== 'booked' ? ` · ${ST[p.status]}` : ''}</span></div>;
}

function MarkSession({ id, onDone }: { id: string; onDone: () => void }) {
  const [s, setS] = useState<{ typeName: string; localStart: string; bookings: { id: string; name: string; status: string; membership: string | null; visitsLeft: number | null }[] } | null>(null);
  const [att, setAtt] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  useEffect(() => {
    api<NonNullable<typeof s>>('GET', `/api/schedule/sessions/${id}`).then((x) => {
      setS(x); setAtt(Object.fromEntries(x.bookings.filter((b) => ['booked', 'attended', 'no_show'].includes(b.status)).map((b) => [b.id, b.status === 'booked' ? 'attended' : b.status])));
    }).catch((x) => setErr(errText(x)));
  }, [id]);
  if (!s) return err ? <div className="err">{err}</div> : null;
  const save = async () => { setErr(''); try { await api('POST', `/api/schedule/sessions/${id}/done`, { attendance: att }); toast('Занятие отмечено'); onDone(); } catch (x) { setErr(errText(x)); } };
  const list = s.bookings.filter((b) => att[b.id]);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <b>{s.typeName}, {s.localStart.slice(8, 10)}.{s.localStart.slice(5, 7)} в {s.localStart.slice(11, 16)}</b>
      {list.length === 0 && <span className="small muted">Никто не был записан. Отметьте занятие проведённым, если оно было.</span>}
      {list.map((b) => (
        <div key={b.id} className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span>{b.name}{b.membership ? <span className="small muted"> · {b.membership}</span> : null}</span>
          <span className="row" style={{ gap: 6 }}>
            <button className={`btn sm ${att[b.id] === 'attended' ? 'pri' : ''}`} aria-pressed={att[b.id] === 'attended'} onClick={() => setAtt({ ...att, [b.id]: 'attended' })}>Пришёл</button>
            <button className={`btn sm ${att[b.id] === 'no_show' ? 'pri' : ''}`} aria-pressed={att[b.id] === 'no_show'} onClick={() => setAtt({ ...att, [b.id]: 'no_show' })}>Не пришёл</button>
          </span>
        </div>))}
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ gap: 6 }}><button className="btn pri" onClick={save}>Готово</button><button className="btn" onClick={onDone}>Закрыть</button></div>
    </div>
  );
}
