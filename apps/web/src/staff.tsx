// Шаг 18. Персонал: график и замены, табель, зарплата и ведомость; «Моё» — свой график, табель и расчёт.
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';

type Shift = { id: string; userId: string; day: string; starts: string; ends: string; breakMinutes: number; replacedUserId: string | null; replacedName: string | null; note: string | null };
type Absence = { id: string; userId: string; kind: string; from: string; to: string; comment: string | null };
type Sched = { staff: { id: string; fullName: string; role: string }[]; shifts: Shift[]; absences: Absence[]; canEdit: boolean };
type DayRow = { day: string; planned: { starts: string; ends: string; minutes: number } | null; absence: string | null; firstIn: string | null; lastOut: string | null;
  workedMin: number; breakMin: number; lateMin: number; earlyMin: number; overtimeMin: number; status: string };
type TsRow = { userId: string; name: string; days: DayRow[]; totals: { plannedMin: number; workedMin: number; lateMin: number; lateCount: number; overtimeMin: number; shifts: number; workedShifts: number; absentDays: number; absences: Record<string, number> } };
type Item = { code: string; title: string; basis: string; amountKop: number };
type Line = { userId: string; name: string; items: Item[]; totalKop: number };
type Payroll = { period: { status: string; calculatedAt: string | null; approvedAt: string | null; approvedBy: string | null } | null; lines: Line[]; totalKop: number };

const ABS: Record<string, string> = { vacation: 'Отпуск', sick: 'Больничный', dayoff: 'Отгул', unpaid: 'Без сохранения' };
const KIND: Record<string, string> = { salary: 'Оклад в месяц', hourly: 'Ставка за час', shift: 'Ставка за смену', trainer: 'За занятие (тренер)' };
const ST: Record<string, [string, string]> = { ok: ['норма', 'ok'], late: ['опоздание', 'warn'], absent: ['не пришёл', 'bad'], no_out: ['нет ухода', 'warn'], extra: ['вне графика', ''], absence: ['', ''], planned: ['по графику', ''] };
const h = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monday = (d: Date) => { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
const addD = (s: string, n: number) => { const x = new Date(`${s}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function StaffTimePage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const manage = can(me, 'staff.schedule'); const pay = can(me, 'payroll.manage');
  const tabs: [string, string, boolean][] = [['my', 'Моё', true], ['schedule', 'График', manage || can(me, 'staff.view')], ['timesheet', 'Табель', manage || pay], ['payroll', 'Зарплата', pay]];
  const [tab, setTab] = useState(() => (tabs.some((t) => t[0] === navParams('stafftime').tab && t[2]) ? navParams('stafftime').tab : manage ? 'schedule' : 'my'));
  const club = clubs.find((c) => c.id === clubId) ?? (clubs.length === 1 ? clubs[0] : null);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="tabs" role="group" aria-label="Персонал">{tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{t}</button>)}</div>
      {!club ? <div className="card"><p style={{ margin: 0 }}>Выберите клуб вверху страницы.</p></div> : <>
        {tab === 'my' && <MyPage club={club} />}
        {tab === 'schedule' && <Schedule club={club} />}
        {tab === 'timesheet' && <Timesheet club={club} canFix={manage} />}
        {tab === 'payroll' && <PayrollPage club={club} />}
      </>}
    </div>
  );
}

function MyPage({ club }: { club: Club }) {
  const [month, setMonth] = useState(thisMonth());
  const [ts, setTs] = useState<TsRow | null>(null);
  const [pay, setPay] = useState<{ clubName: string; status: string; items: Item[]; totalKop: number }[]>([]);
  const load = () => {
    api<{ rows: TsRow[] }>('GET', `/api/staff-time/timesheet?clubId=${club.id}&month=${month}`).then((r) => setTs(r.rows[0] ?? null)).catch(() => setTs(null));
    api<typeof pay>('GET', `/api/payroll/my?month=${month}`).then(setPay).catch(() => setPay([]));
  };
  useEffect(load, [club.id, month]);
  const mark = async (direction: 'in' | 'out') => { try { await api('POST', '/api/staff-time/mark', { clubId: club.id, direction }); toast(direction === 'in' ? 'Приход отмечен' : 'Уход отмечен'); load(); } catch (x) { toast(errText(x)); } };
  return (
    <>
      <div className="card row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div><b>Отметка в {club.name}</b><div className="small muted">Если в клубе есть считыватель, проход по карте отмечается сам.</div></div>
        <div className="row"><button className="btn pri" onClick={() => mark('in')}>Пришёл</button><button className="btn" onClick={() => mark('out')}>Ушёл</button></div>
      </div>
      <div className="row"><label className="f" style={{ maxWidth: 200 }}>Месяц<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label></div>
      {ts ? <TsTable rows={[ts]} /> : <div className="card small muted">Смен и отметок за месяц нет.</div>}
      {pay.map((p, i) => <PayLine key={i} title={`Расчёт: ${p.clubName}`} status={p.status} items={p.items} totalKop={p.totalKop} />)}
    </>
  );
}

function PayLine({ title, status, items, totalKop }: { title: string; status?: string; items: Item[]; totalKop: number }) {
  return (
    <div className="card" style={{ display: 'grid', gap: 6 }}>
      <div className="row between"><b>{title}</b>{status && <span className={`chip ${status === 'approved' ? 'ok' : ''}`}>{status === 'approved' ? 'утверждено' : 'черновик'}</span>}</div>
      {items.map((i, k) => <div key={k} className="row between small" style={{ gap: 12, alignItems: 'flex-start' }}><span><b>{i.title}</b><br /><span className="muted">{i.basis}</span></span><span className="num" style={{ whiteSpace: 'nowrap' }}>{rub(i.amountKop)}</span></div>)}
      <div className="row between"><b>Итого</b><b className="num">{rub(totalKop)}</b></div>
    </div>
  );
}

function Schedule({ club }: { club: Club }) {
  const [week, setWeek] = useState(iso(monday(new Date())));
  const [s, setS] = useState<Sched | null>(null);
  const [form, setForm] = useState<{ userId: string; days: string[]; starts: string; ends: string; breakMinutes: string } | null>(null);
  const [abs, setAbs] = useState<{ userId: string; kind: string; from: string; to: string } | null>(null);
  const [err, setErr] = useState('');
  const to = addD(week, 6);
  const load = () => api<Sched>('GET', `/api/staff-time/schedule?clubId=${club.id}&from=${week}&to=${to}`).then(setS).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club.id, week]);
  const daysW = Array.from({ length: 7 }, (_, i) => addD(week, i));
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ created: number; conflicts: string[] }>('POST', '/api/staff-time/shifts', { clubId: club.id, userId: form!.userId, days: form!.days, starts: form!.starts, ends: form!.ends, breakMinutes: Number(form!.breakMinutes) || 0 });
      toast(`Смен добавлено: ${r.created}${r.conflicts.length ? `, уже были: ${r.conflicts.length}` : ''}`); setForm(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  const saveAbs = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ shiftsToReplace: string[] }>('POST', '/api/staff-time/absences', { clubId: club.id, ...abs });
      toast(r.shiftsToReplace.length ? `Сохранено. Найдите замену на смены: ${r.shiftsToReplace.join(', ')}` : 'Сохранено'); setAbs(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  const replace = async (sh: Shift, userId: string) => { try { await api('POST', `/api/staff-time/shifts/${sh.id}/replace`, { userId }); toast('Замена сохранена: смена и оплата перешли заменяющему'); load(); } catch (x) { toast(errText(x)); } };
  const del = async (sh: Shift) => { try { await api('DELETE', `/api/staff-time/shifts/${sh.id}`); load(); } catch (x) { toast(errText(x)); } };
  if (!s) return err ? <div className="err">{err}</div> : null;
  const name = (id: string) => s.staff.find((x) => x.id === id)?.fullName ?? '—';
  return (
    <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row"><button className="btn sm" onClick={() => setWeek(addD(week, -7))}>←</button><b>{week.split('-').reverse().join('.')} – {to.split('-').reverse().join('.')}</b><button className="btn sm" onClick={() => setWeek(addD(week, 7))}>→</button></div>
        {s.canEdit && <div className="row"><button className="btn sm pri" onClick={() => setForm({ userId: s.staff[0]?.id ?? '', days: [], starts: '09:00', ends: '18:00', breakMinutes: '60' })}>Добавить смены</button>
          <button className="btn sm" onClick={() => setAbs({ userId: s.staff[0]?.id ?? '', kind: 'vacation', from: week, to: week })}>Отпуск, больничный</button></div>}
      </div>
      {form && (
        <form className="card" onSubmit={save} style={{ display: 'grid', gap: 8 }}>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <label className="f">Сотрудник<select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>{s.staff.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
            <label className="f">Начало<input type="time" value={form.starts} onChange={(e) => setForm({ ...form, starts: e.target.value })} /></label>
            <label className="f">Конец<input type="time" value={form.ends} onChange={(e) => setForm({ ...form, ends: e.target.value })} /></label>
            <label className="f">Обед, мин<input inputMode="numeric" value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })} /></label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>{Array.from({ length: 14 }, (_, i) => addD(week, i)).map((d, i) => (
            <label key={d} className="row small" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={form.days.includes(d)} onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, d] : form.days.filter((x) => x !== d) })} />{WD[i % 7]} {d.slice(8)}.{d.slice(5, 7)}</label>))}</div>
          <div className="row"><button className="btn pri sm" disabled={!form.days.length}>Сохранить</button><button type="button" className="btn sm" onClick={() => setForm(null)}>Отмена</button></div>
        </form>)}
      {abs && (
        <form className="card" onSubmit={saveAbs} style={{ display: 'grid', gap: 8 }}>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <label className="f">Сотрудник<select value={abs.userId} onChange={(e) => setAbs({ ...abs, userId: e.target.value })}>{s.staff.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
            <label className="f">Что<select value={abs.kind} onChange={(e) => setAbs({ ...abs, kind: e.target.value })}>{Object.entries(ABS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="f">С<input type="date" value={abs.from} onChange={(e) => setAbs({ ...abs, from: e.target.value })} /></label>
            <label className="f">По<input type="date" value={abs.to} onChange={(e) => setAbs({ ...abs, to: e.target.value })} /></label>
          </div>
          <div className="row"><button className="btn pri sm">Сохранить</button><button type="button" className="btn sm" onClick={() => setAbs(null)}>Отмена</button></div>
        </form>)}
      {err && <div className="err">{err}</div>}
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Сотрудник</th>{daysW.map((d, i) => <th key={d}>{WD[i]} {d.slice(8)}</th>)}</tr></thead>
        <tbody>{s.staff.map((u) => (
          <tr key={u.id}><td><b>{u.fullName}</b><div className="small muted">{u.role}</div></td>
            {daysW.map((d) => {
              const sh = s.shifts.find((x) => x.userId === u.id && x.day === d);
              const ab = s.absences.find((a) => a.userId === u.id && a.from <= d && a.to >= d);
              return <td key={d} className="small" style={{ minWidth: 96 }}>
                {ab && <span className="chip warn">{ABS[ab.kind]}</span>}
                {sh && <div><b className="num">{sh.starts}–{sh.ends}</b>{sh.replacedName && <div className="muted">за {sh.replacedName}</div>}
                  {s.canEdit && <div className="row" style={{ gap: 4, marginTop: 2 }}>
                    <select aria-label="Замена" value="" onChange={(e) => e.target.value && replace(sh, e.target.value)} style={{ width: 'auto', fontSize: 12, padding: '2px 4px' }}>
                      <option value="">замена…</option>{s.staff.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</select>
                    <button className="btn sm" onClick={() => del(sh)} title="Удалить смену">×</button></div>}</div>}
              </td>;
            })}</tr>))}
        </tbody></table></div>
        {!s.staff.length && <p className="small muted">В клубе нет сотрудников.</p>}
        {s.absences.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>Отсутствия: {s.absences.map((a) => `${name(a.userId)} — ${ABS[a.kind].toLowerCase()} ${a.from.split('-').reverse().join('.')}–${a.to.split('-').reverse().join('.')}`).join('; ')}</p>}
      </div>
    </>
  );
}

function TsTable({ rows, onFix }: { rows: TsRow[]; onFix?: (r: TsRow, d: DayRow) => void }) {
  const [open, setOpen] = useState<string | null>(rows.length === 1 ? rows[0].userId : null);
  return (
    <div className="card"><div className="tbl"><table>
      <thead><tr><th>Сотрудник</th><th>План</th><th>Факт</th><th>Смен</th><th>Опоздания</th><th>Переработка</th><th>Прогулы</th><th>Отсутствия</th></tr></thead>
      <tbody>{rows.map((r) => (
        <>
          <tr key={r.userId} onClick={() => setOpen(open === r.userId ? null : r.userId)} style={{ cursor: 'pointer' }}>
            <td><b>{r.name}</b></td><td className="num">{h(r.totals.plannedMin)}</td><td className="num">{h(r.totals.workedMin)}</td><td className="num">{r.totals.workedShifts} из {r.totals.shifts}</td>
            <td className={`num ${r.totals.lateCount ? 'bad' : ''}`}>{r.totals.lateCount ? `${r.totals.lateCount} (${r.totals.lateMin} мин)` : '—'}</td>
            <td className="num">{r.totals.overtimeMin ? h(r.totals.overtimeMin) : '—'}</td><td className={`num ${r.totals.absentDays ? 'bad' : ''}`}>{r.totals.absentDays || '—'}</td>
            <td className="small">{Object.entries(r.totals.absences).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}</td></tr>
          {open === r.userId && r.days.map((d) => (
            <tr key={r.userId + d.day} className="small">
              <td>{d.day.split('-').reverse().slice(0, 2).join('.')}</td>
              <td className="num">{d.planned ? `${d.planned.starts}–${d.planned.ends}` : '—'}</td>
              <td className="num">{d.firstIn || d.lastOut ? <>{d.firstIn ?? '—'}–{d.lastOut ?? '—'}<br />{h(d.workedMin)}{d.breakMin ? ` (обед ${d.breakMin} мин)` : ''}</> : '—'}</td>
              <td colSpan={2}>{d.absence ? <span className="chip warn">{d.absence}</span> : <span className={`chip ${ST[d.status]?.[1] ?? ''}`}>{ST[d.status]?.[0] ?? d.status}{d.lateMin ? ` ${d.lateMin} мин` : ''}</span>}</td>
              <td className="num">{d.overtimeMin ? h(d.overtimeMin) : ''}</td>
              <td colSpan={2}>{onFix && !d.absence && <button className="btn sm" onClick={() => onFix(r, d)}>Исправить</button>}</td></tr>))}
        </>))}
      </tbody></table></div>
      <p className="small muted" style={{ marginBottom: 0 }}>Факт — из проходов по карте сотрудника и отметок «Пришёл / Ушёл». Обед по считывателю вычитается сам; если не отмечен — вычитается плановый. Опоздание — позже 5 минут.</p>
    </div>
  );
}

function Timesheet({ club, canFix }: { club: Club; canFix: boolean }) {
  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState<TsRow[]>([]);
  const [fix, setFix] = useState<{ userId: string; name: string; day: string; time: string; direction: 'in' | 'out'; reason: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<{ rows: TsRow[] }>('GET', `/api/staff-time/timesheet?clubId=${club.id}&month=${month}`).then((r) => setRows(r.rows)).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club.id, month]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('POST', '/api/staff-time/marks', { clubId: club.id, userId: fix!.userId, at: new Date(`${fix!.day}T${fix!.time}`).toISOString(), direction: fix!.direction, reason: fix!.reason }); toast('Исправление записано в журнал'); setFix(null); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      <div className="row"><label className="f" style={{ maxWidth: 200 }}>Месяц<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label></div>
      {fix && (
        <form className="card" onSubmit={save} style={{ display: 'grid', gap: 8 }}>
          <b>Исправить табель: {fix.name}, {fix.day.split('-').reverse().join('.')}</b>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <label className="f">Отметка<select value={fix.direction} onChange={(e) => setFix({ ...fix, direction: e.target.value as 'in' | 'out' })}><option value="in">Приход</option><option value="out">Уход</option></select></label>
            <label className="f">Время<input type="time" value={fix.time} onChange={(e) => setFix({ ...fix, time: e.target.value })} /></label>
            <label className="f">Причина<input value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} placeholder="забыл карту, подтверждаю" /></label>
          </div>
          <div className="row"><button className="btn pri sm" disabled={!fix.reason.trim()}>Сохранить</button><button type="button" className="btn sm" onClick={() => setFix(null)}>Отмена</button></div>
        </form>)}
      {err && <div className="err">{err}</div>}
      {rows.length ? <TsTable rows={rows} onFix={canFix ? (r, d) => setFix({ userId: r.userId, name: r.name, day: d.day, time: d.planned?.starts ?? '09:00', direction: d.firstIn ? 'out' : 'in', reason: '' }) : undefined} />
        : <div className="card small muted">За месяц нет смен и отметок. Начните с вкладки «График».</div>}
    </>
  );
}

function PayrollPage({ club }: { club: Club }) {
  const [month, setMonth] = useState(thisMonth());
  const [p, setP] = useState<Payroll | null>(null);
  const [schemes, setSchemes] = useState<{ id: string; userId: string; name: string; validFrom: string; kind: string; rateKop: number; salesPercent: number; planBonusKop: number; planBonusThreshold: number }[]>([]);
  const [staff, setStaff] = useState<{ id: string; fullName: string }[]>([]);
  const [sf, setSf] = useState<{ userId: string; kind: string; rate: string; pct: string; bonus: string; threshold: string; validFrom: string } | null>(null);
  const [af, setAf] = useState<{ userId: string; kind: string; quantity: string; amount: string; reason: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    api<Payroll>('GET', `/api/payroll?clubId=${club.id}&month=${month}`).then(setP).catch((x) => setErr(errText(x)));
    api<typeof schemes>('GET', `/api/payroll/schemes?clubId=${club.id}`).then(setSchemes).catch(() => {});
    api<Sched>('GET', `/api/staff-time/schedule?clubId=${club.id}&from=${month}-01&to=${month}-01`).then((s) => setStaff(s.staff)).catch(() => {});
  };
  useEffect(load, [club.id, month]);
  const run = async (path: 'calculate' | 'approve') => {
    setErr('');
    if (path === 'approve' && !confirm('Утвердить ведомость? После утверждения изменить её нельзя, только корректировкой в следующем месяце.')) return;
    try { setP(await api<Payroll>('POST', `/api/payroll/${path}`, { clubId: club.id, month })); toast(path === 'approve' ? 'Ведомость утверждена' : 'Рассчитано'); } catch (x) { setErr(errText(x)); }
  };
  const kop = (s: string) => Math.round(Number(s.replace(/\s/g, '').replace(',', '.') || 0) * 100);
  const saveScheme = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('POST', '/api/payroll/schemes', { clubId: club.id, userId: sf!.userId, validFrom: sf!.validFrom, kind: sf!.kind, rateKop: kop(sf!.rate), salesPercent: Number(sf!.pct.replace(',', '.') || 0), planBonusKop: kop(sf!.bonus), planBonusThreshold: Number(sf!.threshold) || 100 }); setSf(null); toast('Схема сохранена'); load(); } catch (x) { setErr(errText(x)); }
  };
  const saveAdj = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('POST', '/api/payroll/adjustments', { clubId: club.id, month, userId: af!.userId, kind: af!.kind, quantity: Number(af!.quantity), amountKop: kop(af!.amount), reason: af!.reason }); setAf(null); toast('Строка добавлена. Пересчитайте ведомость'); load(); } catch (x) { setErr(errText(x)); }
  };
  const approved = p?.period?.status === 'approved';
  return (
    <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
        <label className="f" style={{ maxWidth: 200 }}>Месяц<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => setSf({ userId: staff[0]?.id ?? '', kind: 'salary', rate: '', pct: '0', bonus: '0', threshold: '100', validFrom: `${month}-01` })}>Схема оплаты</button>
          {!approved && <button className="btn sm" onClick={() => setAf({ userId: staff[0]?.id ?? '', kind: 'bonus', quantity: '', amount: '', reason: '' })}>Премия, удержание, занятия</button>}
          {!approved && <button className="btn sm pri" onClick={() => run('calculate')}>Рассчитать</button>}
          {!approved && p?.period?.calculatedAt && <button className="btn sm" onClick={() => run('approve')}>Утвердить</button>}
          {p?.period && <><a className="btn sm" href={`/api/payroll/export?clubId=${club.id}&month=${month}&format=xlsx`}>XLSX</a><a className="btn sm" href={`/api/payroll/export?clubId=${club.id}&month=${month}&format=csv`}>CSV</a></>}
        </div>
      </div>
      {sf && (
        <form className="card" onSubmit={saveScheme} style={{ display: 'grid', gap: 8 }}>
          <b>Схема оплаты</b>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <label className="f">Сотрудник<select value={sf.userId} onChange={(e) => setSf({ ...sf, userId: e.target.value })}>{staff.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
            <label className="f">Вид<select value={sf.kind} onChange={(e) => setSf({ ...sf, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="f">Сумма, ₽<input inputMode="decimal" value={sf.rate} onChange={(e) => setSf({ ...sf, rate: e.target.value })} /></label>
            <label className="f">% от личных продаж<input inputMode="decimal" value={sf.pct} onChange={(e) => setSf({ ...sf, pct: e.target.value })} /></label>
            <label className="f">Премия за план, ₽<input inputMode="decimal" value={sf.bonus} onChange={(e) => setSf({ ...sf, bonus: e.target.value })} /></label>
            <label className="f">Премия от, % плана<input inputMode="numeric" value={sf.threshold} onChange={(e) => setSf({ ...sf, threshold: e.target.value })} /></label>
            <label className="f">Действует с<input type="date" value={sf.validFrom} onChange={(e) => setSf({ ...sf, validFrom: e.target.value })} /></label>
          </div>
          <div className="row"><button className="btn pri sm">Сохранить</button><button type="button" className="btn sm" onClick={() => setSf(null)}>Отмена</button></div>
        </form>)}
      {af && (
        <form className="card" onSubmit={saveAdj} style={{ display: 'grid', gap: 8 }}>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <label className="f">Сотрудник<select value={af.userId} onChange={(e) => setAf({ ...af, userId: e.target.value })}>{staff.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
            <label className="f">Что<select value={af.kind} onChange={(e) => setAf({ ...af, kind: e.target.value })}><option value="bonus">Разовая премия</option><option value="deduction">Удержание</option><option value="correction">Корректировка прошлого месяца (±)</option><option value="sessions">Проведённые занятия (тренер)</option></select></label>
            {af.kind === 'sessions' ? <label className="f">Занятий<input inputMode="numeric" value={af.quantity} onChange={(e) => setAf({ ...af, quantity: e.target.value })} /></label>
              : <label className="f">Сумма, ₽<input inputMode="decimal" value={af.amount} onChange={(e) => setAf({ ...af, amount: e.target.value })} /></label>}
            <label className="f">Основание<input value={af.reason} onChange={(e) => setAf({ ...af, reason: e.target.value })} /></label>
          </div>
          <div className="row"><button className="btn pri sm" disabled={!af.reason.trim()}>Добавить</button><button type="button" className="btn sm" onClick={() => setAf(null)}>Отмена</button></div>
        </form>)}
      {err && <div className="err">{err}</div>}
      {p?.period ? <>
        <div className="card row between" style={{ flexWrap: 'wrap' }}><span>{approved ? <span className="chip ok">утверждена {p.period.approvedBy ? `· ${p.period.approvedBy}` : ''}</span> : <span className="chip">черновик</span>} Сотрудников: {p.lines.length}</span><b className="num">Всего {rub(p.totalKop)}</b></div>
        {p.lines.map((l) => <PayLine key={l.userId} title={l.name} items={l.items} totalKop={l.totalKop} />)}
      </> : <div className="card small muted">Ведомость за месяц ещё не рассчитана. Задайте схемы оплаты и нажмите «Рассчитать».</div>}
      {schemes.length > 0 && <div className="card"><b>Схемы оплаты</b><div className="tbl"><table><thead><tr><th>Сотрудник</th><th>С</th><th>Вид</th><th>Сумма</th><th>% продаж</th><th>Премия за план</th></tr></thead>
        <tbody>{schemes.map((s) => <tr key={s.id}><td>{s.name}</td><td className="num">{s.validFrom.split('-').reverse().join('.')}</td><td>{KIND[s.kind]}</td><td className="num">{rub(s.rateKop)}</td><td className="num">{s.salesPercent ? `${s.salesPercent} %` : '—'}</td><td className="num">{s.planBonusKop ? `${rub(s.planBonusKop)} от ${s.planBonusThreshold} %` : '—'}</td></tr>)}</tbody></table></div></div>}
    </>
  );
}
