// Расписание занятий и запись клиентов: неделя по дням, запись с листом ожидания, отметка посещения, настройка залов, занятий и правил.
import { useEffect, useState } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { errText, toast } from './ui.ts';

type Session = { id: string; typeName: string; kind: 'group' | 'personal'; roomName: string | null; trainerId: string | null; trainerName: string | null; localStart: string; localEnd: string;
  capacity: number; status: 'scheduled' | 'done' | 'cancelled'; booked: number; waitlist: number; note: string | null; cancelReason: string | null };
type Booking = { id: string; personId: string; name: string; phone: string | null; status: string; trial: boolean; lateCancel: boolean; charged: boolean; membership: string | null; visitsLeft: number | null };
type Full = Session & { bookings: Booking[]; canMark: boolean; canManage: boolean };
type Setup = { rooms: { id: string; name: string; capacity: number | null }[]; types: { id: string; name: string; kind: string; durationMin: number; capacity: number }[];
  trainers: { id: string; name: string }[];
  settings: { lateCancelHours: number; chargePersonalLate: boolean; chargeGroupNoShow: boolean; noShowLimit: number | null; noShowBlockDays: number; remind24: boolean; remind2: boolean; bookAheadDays: number } };

const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monday = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const ddmm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const STATUS: Record<string, [string, string]> = { booked: ['записан', 'acc'], waitlist: ['ожидание', 'warn'], attended: ['пришёл', 'ok'], no_show: ['не пришёл', 'bad'], cancelled: ['отменил', ''] };

export function SchedulePage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [week, setWeek] = useState(monday(iso(new Date())));
  const [list, setList] = useState<Session[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [trainer, setTrainer] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<'week' | 'new' | 'setup'>('week');
  const manage = can(me, 'schedule.manage');
  const isTrainer = me.roles.some((r) => r.code === 'trainer');
  const load = () => club && api<Session[]>('GET', `/api/schedule?clubId=${club}&from=${week}&to=${addDays(week, 6)}${trainer ? `&trainerId=${trainer}` : ''}`).then(setList).catch((x) => toast(errText(x)));
  const loadSetup = () => club && api<Setup>('GET', `/api/schedule/setup?clubId=${club}`).then(setSetup).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, [club, week, trainer]);
  useEffect(() => { loadSetup(); }, [club]);
  useEffect(() => { if (isTrainer && !trainer) setTrainer(me.id); }, []);
  if (!club) return <p className="muted">Клубов нет.</p>;
  const today = iso(new Date());
  return (
    <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="tabs" role="group" aria-label="Расписание">
          <button aria-pressed={view === 'week'} onClick={() => setView('week')}>Неделя</button>
          {manage && <button aria-pressed={view === 'new'} onClick={() => setView('new')}>Новое занятие</button>}
          {manage && <button aria-pressed={view === 'setup'} onClick={() => setView('setup')}>Залы, занятия, правила</button>}
        </div>
        {clubId === 'all' && <select value={club} onChange={(e) => setClub(e.target.value)}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      </div>
      {view === 'week' && <>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn sm" onClick={() => setWeek(addDays(week, -7))}>← Неделя</button>
          <b>{ddmm(week)} – {ddmm(addDays(week, 6))}</b>
          <button className="btn sm" onClick={() => setWeek(addDays(week, 7))}>Неделя →</button>
          <button className="btn sm" onClick={() => setWeek(monday(today))}>Сегодня</button>
          <select value={trainer} onChange={(e) => setTrainer(e.target.value)} aria-label="Тренер">
            <option value="">Все тренеры</option>
            {setup?.trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="week7">
          {DOW.map((d, i) => {
            const day = addDays(week, i);
            const items = list.filter((s) => s.localStart.startsWith(day));
            return (
              <div key={day} className={`card day ${day === today ? 'today' : ''}`}>
                <div className="lbl">{d}, {ddmm(day)}</div>
                {items.map((s) => (
                  <button key={s.id} className={`item cls ${s.status}`} onClick={() => setOpen(s.id)}>
                    <div className="row between"><b>{s.localStart.slice(11)}</b><span className={`chip ${s.status === 'cancelled' ? 'bad' : s.booked >= s.capacity ? 'warn' : 'ok'}`}>{s.status === 'cancelled' ? 'отменено' : `${s.booked}/${s.capacity}`}{s.waitlist ? ` +${s.waitlist}` : ''}</span></div>
                    <div>{s.typeName}</div>
                    <div className="small muted">{[s.trainerName, s.roomName].filter(Boolean).join(' · ')}</div>
                  </button>
                ))}
                {!items.length && <div className="small muted">Занятий нет</div>}
              </div>
            );
          })}
        </div>
      </>}
      {view === 'new' && setup && <NewSession club={club} setup={setup} onDone={() => { setView('week'); load(); }} />}
      {view === 'setup' && setup && <SetupView club={club} setup={setup} reload={loadSetup} />}
      {open && <SessionDrawer id={open} onClose={() => { setOpen(null); load(); }} openPerson={openPerson} />}
    </>
  );
}

function SessionDrawer({ id, onClose, openPerson }: { id: string; onClose: () => void; openPerson: (id: string) => void }) {
  const [s, setS] = useState<Full | null>(null);
  const [att, setAtt] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; fullName: string; phone: string | null }[]>([]);
  const load = () => api<Full>('GET', `/api/schedule/sessions/${id}`).then((r) => { setS(r); setAtt(Object.fromEntries(r.bookings.filter((b) => ['booked', 'attended', 'no_show'].includes(b.status)).map((b) => [b.id, b.status === 'booked' ? 'attended' : b.status]))); }).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api<typeof found>('GET', `/api/persons?q=${encodeURIComponent(q.trim())}`).then((r) => setFound(r.slice(0, 6))).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const act = async (fn: () => Promise<unknown>, ok?: (r: never) => string) => { try { const r = await fn(); if (ok) toast(ok(r as never)); load(); } catch (x) { toast(errText(x)); } };
  const book = (personId: string, trial = false) => act(() => api('POST', `/api/schedule/sessions/${id}/book`, { personId, trial }),
    (r: { status: string; position: number | null }) => (r.status === 'waitlist' ? `Мест нет: в листе ожидания ${r.position}-й` : 'Записан, клиенту ушло подтверждение')).then(() => setQ(''));
  const started = s ? new Date(`${s.localStart}:00`) <= new Date() : false;
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Занятие">
        <div className="row between"><span className="lbl">Занятие</span><button className="btn sm" onClick={onClose}>Закрыть</button></div>
        {!s ? <p className="muted">Загрузка…</p> : <>
          <h1 style={{ margin: 0 }}>{s.typeName}</h1>
          <div className="small">{ddmm(s.localStart)} {s.localStart.slice(11)}–{s.localEnd}{s.trainerName ? ` · тренер ${s.trainerName}` : ''}{s.roomName ? ` · ${s.roomName}` : ''}</div>
          <div className="small muted">{s.kind === 'personal' ? 'Персональное: списывается из пакета персональных' : 'Групповое'} · записано {s.booked} из {s.capacity}{s.waitlist ? `, в ожидании ${s.waitlist}` : ''}</div>
          {s.status === 'cancelled' && <div className="err">Отменено: {s.cancelReason}</div>}
          {s.status === 'scheduled' && !started && (
            <div className="item" style={{ display: 'grid', gap: 6 }}>
              <b>Записать клиента</b>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя или телефон клиента" />
              {found.map((p) => (
                <div key={p.id} className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span>{p.fullName} <span className="small muted">{p.phone ?? ''}</span></span>
                  <span className="row" style={{ gap: 4 }}><button className="btn sm pri" onClick={() => book(p.id)}>Записать</button>{s.kind === 'group' && <button className="btn sm" onClick={() => book(p.id, true)}>Пробное</button>}</span>
                </div>
              ))}
            </div>
          )}
          <div className="tbl"><table><thead><tr><th>Клиент</th><th className="hide-narrow">Абонемент</th><th>Статус</th><th></th></tr></thead>
            <tbody>{s.bookings.map((b) => (
              <tr key={b.id}>
                <td><button className="btn sm" onClick={() => openPerson(b.personId)}>{b.name}</button>{b.trial && <span className="chip acc">пробное</span>}</td>
                <td className="small hide-narrow">{b.membership ?? '—'}{b.visitsLeft != null ? ` · осталось ${b.visitsLeft}` : ''}{b.charged ? ' · списано' : ''}</td>
                <td>{started && s.status !== 'cancelled' && s.canMark && ['booked', 'attended', 'no_show'].includes(b.status)
                  ? <select value={att[b.id]} onChange={(e) => setAtt({ ...att, [b.id]: e.target.value })}><option value="attended">пришёл</option><option value="no_show">не пришёл</option></select>
                  : <span className={`chip ${STATUS[b.status][1]}`}>{STATUS[b.status][0]}{b.lateCancel ? ', поздно' : ''}</span>}</td>
                <td>{s.status === 'scheduled' && !started && ['booked', 'waitlist'].includes(b.status) && <button className="btn sm" onClick={() => act(() => api('POST', `/api/schedule/bookings/${b.id}/cancel`),
                  (r: { late: boolean; charged: boolean; promoted: string | null }) => [r.charged ? 'Поздняя отмена: занятие списано' : 'Запись отменена', r.promoted ? 'место отдано клиенту из листа ожидания' : ''].filter(Boolean).join(', '))}>Отменить</button>}</td>
              </tr>))}
              {!s.bookings.length && <tr><td colSpan={4} className="small muted">Никто не записан</td></tr>}</tbody></table></div>
          {started && s.status !== 'cancelled' && s.canMark && (
            <button className="btn pri" onClick={() => act(() => api('POST', `/api/schedule/sessions/${id}/done`, { attendance: att }), (r: { attended: number; total: number }) => `Отмечено: пришли ${r.attended} из ${r.total}`)}>
              {s.status === 'done' ? 'Исправить отметки' : 'Занятие проведено'}</button>
          )}
          {s.status === 'scheduled' && s.canManage && !started && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => { const v = window.prompt('Сколько мест?', String(s.capacity)); if (v) act(() => api('PATCH', `/api/schedule/sessions/${id}`, { capacity: Number(v) }), () => 'Мест: ' + v); }}>Изменить число мест</button>
              <button className="btn" onClick={() => { const reason = window.prompt('Причина отмены (её увидят записанные клиенты)'); if (reason?.trim()) act(() => api('POST', `/api/schedule/sessions/${id}/cancel`, { reason }), (r: { cancelled: number; notified: number }) => `Занятие отменено, сообщение получили ${r.notified} из ${r.cancelled}`); }}>Отменить занятие</button>
            </div>
          )}
        </>}
      </aside>
    </div>
  );
}

function NewSession({ club, setup, onDone }: { club: string; setup: Setup; onDone: () => void }) {
  const [f, setF] = useState({ typeId: setup.types[0]?.id ?? '', roomId: '', trainerId: '', start: `${iso(new Date(Date.now() + 864e5))}T19:00`, repeatWeeks: 1, capacity: '' });
  const type = setup.types.find((t) => t.id === f.typeId);
  if (!setup.types.length) return <div className="card"><p className="muted">Сначала добавьте виды занятий во вкладке «Залы, занятия, правила».</p></div>;
  const save = async () => {
    try {
      const r = await api<{ created: number; conflicts: string[] }>('POST', '/api/schedule/sessions', { clubId: club, typeId: f.typeId, roomId: f.roomId || null, trainerId: f.trainerId || null, start: f.start, repeatWeeks: f.repeatWeeks, capacity: f.capacity ? Number(f.capacity) : undefined });
      toast(`Создано занятий: ${r.created}${r.conflicts.length ? `. Пропущено из-за занятости: ${r.conflicts.join('; ')}` : ''}`); onDone();
    } catch (x) { toast(errText(x)); }
  };
  return (
    <div className="card" style={{ maxWidth: 560, display: 'grid', gap: 8 }}>
      <h2>Новое занятие</h2>
      <label className="f">Занятие<select className="f" value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })}>{setup.types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.kind === 'group' ? 'групповое' : 'персональное'}, {t.durationMin} мин)</option>)}</select></label>
      <label className="f">Начало<input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
      <label className="f">Тренер<select className="f" value={f.trainerId} onChange={(e) => setF({ ...f, trainerId: e.target.value })}><option value="">—</option>{setup.trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="f">Зал<select className="f" value={f.roomId} onChange={(e) => setF({ ...f, roomId: e.target.value })}><option value="">—</option>{setup.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="f">Мест (по умолчанию {type?.capacity})<input type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></label>
      <label className="f">Повторять каждую неделю, недель<input type="number" min={1} max={26} value={f.repeatWeeks} onChange={(e) => setF({ ...f, repeatWeeks: Number(e.target.value) })} /></label>
      <button className="btn pri" onClick={save}>Создать</button>
    </div>
  );
}

function SetupView({ club, setup, reload }: { club: string; setup: Setup; reload: () => void }) {
  const [t, setT] = useState({ name: '', kind: 'group', durationMin: 60, capacity: 15 });
  const [room, setRoom] = useState({ name: '', capacity: '' });
  const [st, setSt] = useState(setup.settings);
  const call = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); reload(); } catch (x) { toast(errText(x)); } };
  return (
    <div className="grid2">
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <h2>Виды занятий</h2>
        {setup.types.map((x) => <div key={x.id} className="item small">{x.name} · {x.kind === 'group' ? 'групповое' : 'персональное'} · {x.durationMin} мин · мест {x.capacity}</div>)}
        <label className="f">Название<input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
        <label className="f">Вид<select className="f" value={t.kind} onChange={(e) => setT({ ...t, kind: e.target.value, capacity: e.target.value === 'personal' ? 1 : 15 })}><option value="group">Групповое</option><option value="personal">Персональное</option></select></label>
        <div className="row" style={{ gap: 6 }}>
          <label className="f">Минут<input type="number" value={t.durationMin} onChange={(e) => setT({ ...t, durationMin: Number(e.target.value) })} /></label>
          <label className="f">Мест<input type="number" value={t.capacity} onChange={(e) => setT({ ...t, capacity: Number(e.target.value) })} /></label>
        </div>
        <button className="btn" onClick={() => call(() => api('POST', '/api/schedule/types', { clubId: club, ...t }), 'Занятие добавлено').then(() => setT({ ...t, name: '' }))}>Добавить занятие</button>
        <h2 style={{ marginTop: 10 }}>Залы</h2>
        {setup.rooms.map((x) => <div key={x.id} className="item small">{x.name}{x.capacity ? ` · до ${x.capacity} человек` : ''}</div>)}
        <div className="row" style={{ gap: 6 }}>
          <label className="f">Зал<input value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} /></label>
          <label className="f">Вместимость<input type="number" value={room.capacity} onChange={(e) => setRoom({ ...room, capacity: e.target.value })} /></label>
        </div>
        <button className="btn" onClick={() => call(() => api('POST', '/api/schedule/rooms', { clubId: club, name: room.name, capacity: room.capacity ? Number(room.capacity) : null }), 'Зал добавлен').then(() => setRoom({ name: '', capacity: '' }))}>Добавить зал</button>
      </div>
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <h2>Правила записи</h2>
        <label className="f">Поздняя отмена — меньше чем за, часов<input type="number" value={st.lateCancelHours} onChange={(e) => setSt({ ...st, lateCancelHours: Number(e.target.value) })} /></label>
        <label><input type="checkbox" checked={st.chargePersonalLate} onChange={(e) => setSt({ ...st, chargePersonalLate: e.target.checked })} /> Персональное: поздняя отмена и неявка списываются из пакета</label>
        <label><input type="checkbox" checked={st.chargeGroupNoShow} onChange={(e) => setSt({ ...st, chargeGroupNoShow: e.target.checked })} /> Групповое: неявка списывает посещение из пакета посещений</label>
        <label className="f">Закрыть запись после неявок за 30 дней (пусто — не закрывать)<input type="number" value={st.noShowLimit ?? ''} onChange={(e) => setSt({ ...st, noShowLimit: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="f">На сколько дней закрыть запись<input type="number" value={st.noShowBlockDays} onChange={(e) => setSt({ ...st, noShowBlockDays: Number(e.target.value) })} /></label>
        <label className="f">Запись открыта вперёд, дней<input type="number" value={st.bookAheadDays} onChange={(e) => setSt({ ...st, bookAheadDays: Number(e.target.value) })} /></label>
        <label><input type="checkbox" checked={st.remind24} onChange={(e) => setSt({ ...st, remind24: e.target.checked })} /> Напоминание клиенту за сутки</label>
        <label><input type="checkbox" checked={st.remind2} onChange={(e) => setSt({ ...st, remind2: e.target.checked })} /> Напоминание за 2 часа</label>
        <button className="btn pri" onClick={() => call(() => api('PUT', '/api/schedule/settings', { clubId: club, ...st }), 'Правила сохранены')}>Сохранить правила</button>
      </div>
    </div>
  );
}
