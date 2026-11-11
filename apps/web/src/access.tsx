// Шаг 11. Проходы: экран ресепшн (лента, эмулятор турникета, ручной проход), отчёт, настройка турникетов и шлюзов,
// а в карточке клиента — карты, браслеты, QR и посещения. Модель турникета подключим на финише.
import { useEffect, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { api, can, type Club, type Me, type Person, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { Md } from './fiscal.tsx';
import guide from '../../../docs/03_Инструкции/Турникеты_и_шлюз.md?raw';

type Ev = { id: string; at: string; direction: string; decision: string; reasonCode: string; reason: string; mode: string; code: string | null; personId: string | null;
  userId: string | null; name: string | null; point: string | null; manualBy: string | null; visitEffect: string | null };
type Gw = { id: string; name: string; status: string; lastSeenAt: string | null; lastSyncAt?: string | null; queued: number; online: boolean; version?: string | null; hasKey?: boolean };
type Point = { id: string; name: string; direction: string; gatewayId: string | null; isActive?: boolean };
type Feed = { events: Ev[]; inside: number; today: number; gateways: Gw[]; points: Point[]; alerts: string[] };
type Verdict = { decision: string; reason: string; name: string | null; warn?: string | null; personId: string | null; visitEffect?: string };

const MODE: Record<string, string> = { online: 'турникет', offline: 'без связи', manual: 'вручную', emulator: 'эмулятор', desk: 'ресепшн' };
const DIR: Record<string, string> = { in: 'вход', out: 'выход', both: 'вход и выход' };
const KIND: Record<string, string> = { card: 'Карта', bracelet: 'Браслет', qr: 'QR-код' };
const CRED_STATUS: Record<string, string> = { active: 'действует', replaced: 'заменена', lost: 'утеряна', blocked: 'заблокирована' };
const MANUAL: [string, string][] = [['turnstile_fault', 'Турникет не работает'], ['card_not_read', 'Карта не считывается'], ['forgot_card', 'Забыл карту'],
  ['guest', 'Гость по приглашению'], ['admin_decision', 'Решение администратора'], ['other', 'Другое']];
const time = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const mins = (m: number | null) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`);

export function AccessPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const views: [string, string, boolean][] = [
    ['desk', 'Ресепшн', can(me, 'acs.work')], ['report', 'Отчёт', can(me, 'acs.manage')], ['setup', 'Настройка', can(me, 'acs.manage')], ['guide', 'Инструкция', true]];
  const allowed = views.filter((v) => v[2]);
  const [view, setView] = useState(() => { const v = navParams('access').view; return allowed.some((a) => a[0] === v) ? v : allowed[0][0]; });
  if (!club) return <p className="muted">Клубов нет.</p>;
  return (
    <div className="acs" style={{ display: 'grid', gap: 14 }}>
      <div className="row between">
        <div className="tabs" role="group" aria-label="Проходы">{allowed.map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{t}</button>)}</div>
        {clubId === 'all' && <select aria-label="Клуб" value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      </div>
      {view === 'desk' && <Desk key={club} clubId={club} openPerson={openPerson} />}
      {view === 'report' && <Report key={club} clubId={club} />}
      {view === 'setup' && <Setup key={club} clubId={club} />}
      {view === 'guide' && <div className="card md"><Md text={guide} /></div>}
    </div>
  );
}

/* ---------------- ресепшн ---------------- */
function Desk({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [err, setErr] = useState('');
  const [point, setPoint] = useState('');
  const [code, setCode] = useState('');
  const [last, setLast] = useState<Verdict | null>(null);
  const [manual, setManual] = useState(false);
  const load = () => api<Feed>('GET', `/api/acs/feed?clubId=${clubId}`).then((f) => { setFeed(f); setErr(''); setPoint((p) => p || f.points[0]?.id || ''); }).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [clubId]);
  const pass = async (direction: 'in' | 'out') => {
    try { setLast(await api<Verdict>('POST', '/api/acs/emulate', { pointId: point, code, direction })); load(); } catch (e) { setErr(errText(e)); }
  };
  if (!feed) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  return (
    <>
      {(feed.alerts.length > 0 || err) && <div className="alerts">{feed.alerts.map((a) => <p key={a} className="err">{a}</p>)}{err && <p className="err">{err}</p>}</div>}
      <div className="kpis">
        <div className="card"><span className="lbl">В клубе сейчас</span><b className="num">{feed.inside}</b></div>
        <div className="card"><span className="lbl">Посещений сегодня</span><b className="num">{feed.today}</b></div>
        <div className="card"><span className="lbl">Шлюз турникетов</span>
          {feed.gateways.length === 0 ? <span className="muted">не подключён</span> : feed.gateways.map((g) => (
            <span key={g.id} className="row"><span className={`chip ${g.online ? 'ok' : 'bad'}`}>{g.online ? 'на связи' : 'нет связи'}</span>{g.name}
              {g.queued > 0 && <span className="small">ждут выгрузки: {g.queued}</span>}</span>))}
        </div>
      </div>
      <div className="acs-grid">
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="row between"><b>Эмулятор турникета</b><span className="small">пока нет настоящего турникета</span></div>
          <div className="row">
            <select aria-label="Турникет" value={point} onChange={(e) => setPoint(e.target.value)} style={{ flex: '1 1 160px' }}>
              {feed.points.map((p) => <option key={p.id} value={p.id}>{p.name} ({DIR[p.direction]})</option>)}</select>
            <input aria-label="Номер карты или QR" placeholder="Номер карты или QR" value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: '1 1 160px' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) pass('in'); }} />
          </div>
          <div className="row"><button className="btn pri" disabled={!code.trim() || !point} onClick={() => pass('in')}>Приложить на вход</button>
            <button className="btn" disabled={!code.trim() || !point} onClick={() => pass('out')}>Приложить на выход</button>
            <button className="btn" onClick={() => setManual(!manual)}>Ручной проход</button></div>
          {last && (
            <div className={`verdict ${last.decision === 'allow' ? 'allow' : 'deny'}`}>
              <b>{last.decision === 'allow' ? 'Проход открыт' : 'Проход закрыт'}{last.name ? `: ${last.name}` : ''}</b>
              <span>{last.reason}</span>
              {last.warn && <span className="bad">{last.warn}</span>}
              {last.visitEffect === 'repeat' && <span className="small">Повторное прикладывание: новое посещение не засчитано</span>}
              {last.visitEffect === 'reopen' && <span className="small">Вернулся вскоре после выхода: то же посещение</span>}
              {last.personId && <button className="btn sm" onClick={() => openPerson(last.personId!)}>Открыть карточку</button>}
            </div>)}
        </div>
        {manual && <ManualPass clubId={clubId} points={feed.points} onDone={() => { setManual(false); load(); }} />}
      </div>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Время</th><th className="hide-narrow">Турникет</th><th>Кто</th><th>Решение</th><th className="hide-narrow">Как</th></tr></thead>
        <tbody>{feed.events.map((e) => (
          <tr key={e.id}>
            <td className="num">{time(e.at)}<div className="small show-narrow">{e.direction === 'out' ? 'выход' : MODE[e.mode]}</div></td>
            <td className="hide-narrow">{e.point ?? '—'} <span className="small">{DIR[e.direction]}</span></td>
            <td>{e.personId ? <a href="#" onClick={(x) => { x.preventDefault(); openPerson(e.personId!); }}>{e.name}</a> : e.name ?? <span className="muted">{e.code ?? 'без карты'}</span>}
              {e.userId && <span className="small"> сотрудник</span>}</td>
            <td><span className={`chip ${e.decision === 'allow' ? 'ok' : 'bad'}`}>{e.decision === 'allow' ? 'пропущен' : 'отказ'}</span> {e.reason}</td>
            <td className="small hide-narrow">{MODE[e.mode]}{e.manualBy ? `: ${e.manualBy}` : ''}</td>
          </tr>))}</tbody>
      </table></div>{feed.events.length === 0 && <p className="muted">Проходов ещё не было.</p>}</div>
    </>
  );
}

function ManualPass({ clubId, points, onDone }: { clubId: string; points: Point[]; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [person, setPerson] = useState<Person | null>(null);
  const [f, setF] = useState({ reason: 'forgot_card', comment: '', pointId: points.find((p) => p.direction !== 'out')?.id ?? '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api<Person[]>('GET', `/api/persons?clubId=${clubId}&q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 6))).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ wouldDeny: string | null }>('POST', '/api/acs/manual', { clubId, pointId: f.pointId || undefined, personId: person?.id, reason: f.reason, comment: f.comment });
      toast(r.wouldDeny ? `Пропущен вручную. Система бы не пустила: ${r.wouldDeny}` : 'Пропущен вручную, записано в отчёт'); onDone();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <form className="card" style={{ display: 'grid', gap: 8 }} onSubmit={save}>
      <b>Ручной проход</b>
      <span className="small">Запишется, кто пустил и почему. Управляющий видит это в отчёте.</span>
      {person ? <div className="row between item"><span>{person.fullName} <span className="small">{person.phone}</span></span><button type="button" className="btn sm" onClick={() => setPerson(null)}>Другой</button></div>
        : <>
          <input placeholder="Клиент: имя или телефон (можно пропустить для гостя)" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.map((p) => <button type="button" key={p.id} className="opt" onClick={() => { setPerson(p); setQ(''); }}><b>{p.fullName}</b><span className="small">{p.phone ?? ''} {p.segment}</span></button>)}
        </>}
      <select aria-label="Причина" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{MANUAL.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
      <input placeholder={f.reason === 'other' || f.reason === 'admin_decision' ? 'Комментарий (обязательно)' : 'Комментарий'} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
      <select aria-label="Турникет" value={f.pointId} onChange={(e) => setF({ ...f, pointId: e.target.value })}>
        <option value="">Без турникета (только отметка)</option>{points.map((p) => <option key={p.id} value={p.id}>Открыть: {p.name}</option>)}</select>
      {err && <p className="err">{err}</p>}
      <button className="btn pri">Пропустить и записать</button>
    </form>
  );
}

/* ---------------- отчёт ---------------- */
type Report = { summary: { visits: number; people: number; avgMinutes: number | null; noExit: number }; byHour: { hour: number; visits: number }[]; byDay: { day: string; visits: number }[];
  manual: { at: string; reason: string; manualBy: string | null; person: string | null; point: string | null }[]; denials: { reasonCode: string; title: string; n: number; people: number }[];
  offline: number; staff: { name: string; day: string; firstIn: string | null; lastOut: string | null; events: number }[] };
function Report({ clubId }: { clubId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Report>('GET', `/api/acs/report?clubId=${clubId}&from=${from}&to=${to}`).then(setR).catch((e) => setErr(errText(e))); }, [clubId, from, to]);
  const max = Math.max(1, ...(r?.byHour ?? []).map((h) => h.visits));
  return (
    <>
      <div className="row"><label className="row small">с <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      {err && <p className="err">{err}</p>}
      {r && <>
        <div className="kpis">
          <div className="card"><span className="lbl">Посещений</span><b className="num">{r.summary.visits}</b><span className="small">клиентов: {r.summary.people}</span></div>
          <div className="card"><span className="lbl">Среднее время в клубе</span><b className="num">{mins(r.summary.avgMinutes)}</b><span className="small">без отметки выхода: {r.summary.noExit}</span></div>
          <div className="card"><span className="lbl">Ручных проходов</span><b className="num">{r.manual.length}</b></div>
          <div className="card"><span className="lbl">Проходов без связи</span><b className="num">{r.offline}</b><span className="small">выгружены шлюзом позже</span></div>
        </div>
        <div className="card" style={{ display: 'grid', gap: 4 }}><b>Посещения по часам</b>
          {r.byHour.length === 0 ? <p className="muted">Нет посещений.</p> : r.byHour.map((h) => (
            <div key={h.hour} className="bar"><i style={{ width: `${(h.visits / max) * 100}%` }} /><span>{String(h.hour).padStart(2, '0')}:00</span><span className="num">{h.visits}</span></div>))}
        </div>
        <div className="card"><b>Ручные проходы</b><div className="tbl"><table><thead><tr><th>Когда</th><th>Кого</th><th>Кто пустил</th><th>Причина</th></tr></thead>
          <tbody>{r.manual.map((m, i) => <tr key={i}><td className="num">{dt(m.at)}</td><td>{m.person ?? 'гость'}</td><td>{m.manualBy}</td><td>{m.reason.replace(/^Ручной проход: /, '')}</td></tr>)}</tbody></table></div>
          {r.manual.length === 0 && <p className="muted">Ручных проходов не было.</p>}</div>
        <div className="card"><b>Отказы в проходе</b><div className="tbl"><table><thead><tr><th>Причина</th><th>Отказов</th><th>Человек</th></tr></thead>
          <tbody>{r.denials.map((d) => <tr key={d.reasonCode}><td>{d.title}</td><td className="num">{d.n}</td><td className="num">{d.people}</td></tr>)}</tbody></table></div>
          {r.denials.length === 0 && <p className="muted">Отказов не было.</p>}</div>
        <div className="card"><b>Приход и уход сотрудников</b><div className="tbl"><table><thead><tr><th>Дата</th><th>Сотрудник</th><th>Пришёл</th><th>Ушёл</th><th>На работе</th></tr></thead>
          <tbody>{r.staff.map((s, i) => <tr key={i}><td>{s.day.split('-').reverse().join('.')}</td><td>{s.name}</td><td className="num">{s.firstIn ? time(s.firstIn) : '—'}</td>
            <td className="num">{s.lastOut ? time(s.lastOut) : '—'}</td>
            <td className="num">{s.firstIn && s.lastOut && s.lastOut > s.firstIn ? mins(Math.round((Date.parse(s.lastOut) - Date.parse(s.firstIn)) / 60000)) : '—'}</td></tr>)}</tbody></table></div>
          {r.staff.length === 0 && <p className="muted">Сотрудники карты не прикладывали.</p>}
          <p className="small">Основа для табеля: графики, обед и зарплата будут в шаге «Персонал».</p></div>
      </>}
    </>
  );
}

/* ---------------- настройка ---------------- */
type Setup = { settings: { openFrom: string; openTo: string; repeatEntryMinutes: number; offlineHours: number }; gateways: Gw[]; points: Point[];
  staff: { id: string; name: string; roles: string; credentials: { id: string; kind: string; code: string }[] | null }[] };
function Setup({ clubId }: { clubId: string }) {
  const [s, setS] = useState<Setup | null>(null);
  const [form, setForm] = useState<Setup['settings'] | null>(null);
  const [key, setKey] = useState<{ id: string; token: string } | null>(null);
  const [pt, setPt] = useState({ name: '', direction: 'in', gatewayId: '' });
  const [staffCard, setStaffCard] = useState<{ id: string; code: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Setup>('GET', `/api/acs/setup?clubId=${clubId}`).then((r) => { setS(r); setForm(r.settings); }).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [clubId]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); toast(ok); load(); } catch (e) { setErr(errText(e)); } };
  if (!s || !form) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  return (
    <>
      {err && <p className="err">{err}</p>}
      <form className="card" style={{ display: 'grid', gap: 8 }} onSubmit={(e) => { e.preventDefault(); act(() => api('PUT', `/api/acs/settings/${clubId}`, form), 'Правила прохода сохранены'); }}>
        <b>Правила прохода</b>
        <div className="row">
          <label className="row small">Клуб работает с <input type="time" value={form.openFrom} onChange={(e) => setForm({ ...form, openFrom: e.target.value })} /></label>
          <label className="row small">до <input type="time" value={form.openTo} onChange={(e) => setForm({ ...form, openTo: e.target.value })} /></label>
        </div>
        <span className="small">Одинаковое время «с» и «до» — круглосуточно. Сотрудников пускает в любое время.</span>
        <label className="row small">Вернулся в течение <input type="number" min={0} max={720} style={{ width: 80 }} value={form.repeatEntryMinutes} onChange={(e) => setForm({ ...form, repeatEntryMinutes: Number(e.target.value) })} /> минут после выхода — то же посещение</label>
        <label className="row small">Без интернета шлюз пускает по сохранённым правилам до <input type="number" min={1} max={168} style={{ width: 80 }} value={form.offlineHours} onChange={(e) => setForm({ ...form, offlineHours: Number(e.target.value) })} /> часов</label>
        <div><button className="btn pri">Сохранить</button></div>
      </form>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><b>Шлюзы</b><button className="btn sm" onClick={() => act(async () => setKey(await api('POST', '/api/acs/gateways', { clubId, name: 'Шлюз ресепшн' })), 'Шлюз добавлен')}>Добавить шлюз</button></div>
        <span className="small">Шлюз — программа на компьютере ресепшн, к которой подключаются турникеты. Запуск: <code>npm run gateway</code>, затем откройте http://localhost:3100.</span>
        {key && <div className="note" style={{ display: 'grid', gap: 6 }}>
          <b>Скопируйте сейчас: ключ больше не покажем</b>
          <span className="small">Номер шлюза</span><span className="secret">{key.id}</span>
          <span className="small">Ключ шлюза</span><span className="secret">{key.token}</span>
          <div><button className="btn sm" onClick={() => setKey(null)}>Скопировал</button></div></div>}
        <div className="tbl"><table><thead><tr><th>Шлюз</th><th>Связь</th><th>Правила</th><th>Ждут выгрузки</th><th /></tr></thead>
          <tbody>{s.gateways.map((g) => <tr key={g.id}>
            <td>{g.name}<div className="small">{g.id}</div></td>
            <td><span className={`chip ${g.online ? 'ok' : 'bad'}`}>{g.status === 'disabled' ? 'отключён' : g.online ? 'на связи' : g.lastSeenAt ? `нет связи с ${dt(g.lastSeenAt)}` : 'не подключался'}</span></td>
            <td className="small">{g.lastSyncAt ? dt(g.lastSyncAt) : '—'}</td><td className="num">{g.queued}</td>
            <td className="row"><button className="btn sm" onClick={() => act(async () => setKey(await api('POST', `/api/acs/gateways/${g.id}/key`)), 'Выпущен новый ключ, старый больше не действует')}>Новый ключ</button>
              <button className="btn sm" onClick={() => act(() => api('PATCH', `/api/acs/gateways/${g.id}`, { status: g.status === 'active' ? 'disabled' : 'active' }), 'Сохранено')}>{g.status === 'active' ? 'Отключить' : 'Включить'}</button></td>
          </tr>)}</tbody></table></div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <b>Турникеты и двери</b>
        <div className="tbl"><table><thead><tr><th>Название</th><th>Направление</th><th>Шлюз</th><th /></tr></thead>
          <tbody>{s.points.map((p) => <tr key={p.id} className={p.isActive ? '' : 'muted'}>
            <td>{p.name}</td><td>{DIR[p.direction]}</td><td>{s.gateways.find((g) => g.id === p.gatewayId)?.name ?? '—'}</td>
            <td><button className="btn sm" onClick={() => act(() => api('PATCH', `/api/acs/points/${p.id}`, { isActive: !p.isActive }), 'Сохранено')}>{p.isActive ? 'Выключить' : 'Включить'}</button></td></tr>)}</tbody></table></div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); act(async () => { await api('POST', '/api/acs/points', { clubId, ...pt, gatewayId: pt.gatewayId || null }); setPt({ name: '', direction: 'in', gatewayId: '' }); }, 'Турникет добавлен'); }}>
          <input placeholder="Например, «Вход 2»" value={pt.name} onChange={(e) => setPt({ ...pt, name: e.target.value })} style={{ flex: '1 1 160px' }} />
          <select aria-label="Направление" value={pt.direction} onChange={(e) => setPt({ ...pt, direction: e.target.value })} style={{ width: 'auto' }}>{Object.entries(DIR).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
          <select aria-label="Шлюз" value={pt.gatewayId} onChange={(e) => setPt({ ...pt, gatewayId: e.target.value })} style={{ width: 'auto' }}><option value="">Без шлюза</option>{s.gateways.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          <button className="btn">Добавить</button>
        </form>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <b>Карты сотрудников</b>
        <span className="small">По карте сотрудник проходит в любое время, а приход и уход попадают в отчёт (основа для табеля).</span>
        <div className="tbl"><table><thead><tr><th>Сотрудник</th><th>Роль</th><th>Карта</th><th /></tr></thead>
          <tbody>{s.staff.map((u) => <tr key={u.id}><td>{u.name}</td><td className="small">{u.roles}</td>
            <td className="num">{u.credentials?.map((c) => `${KIND[c.kind]} ${c.code}`).join(', ') ?? '—'}</td>
            <td>{staffCard?.id === u.id
              ? <form className="row" onSubmit={(e) => { e.preventDefault(); act(async () => { await api('POST', `/api/staff/${u.id}/credentials`, { kind: 'card', code: staffCard.code, clubId }); setStaffCard(null); }, 'Карта выдана'); }}>
                  <input autoFocus placeholder="Номер карты" value={staffCard.code} onChange={(e) => setStaffCard({ ...staffCard, code: e.target.value })} style={{ width: 130 }} /><button className="btn sm">Выдать</button></form>
              : <button className="btn sm" onClick={() => setStaffCard({ id: u.id, code: '' })}>Выдать карту</button>}</td></tr>)}</tbody></table></div>
      </div>
    </>
  );
}

/* ---------------- карточка клиента ---------------- */
type Passes = { credentials: { id: string; kind: string; code: string; status: string; issuedAt: string; revokedAt: string | null; revokeReason: string | null; issuedBy: string | null; club: string }[];
  visits: { id: string; at: string; exitAt: string | null; source: string; club: string; minutes: number | null }[];
  stats: { last30: number; total: number; avgMinutes: number | null; lastAt: string | null }; now: { allow: boolean; reason: string; warn: string | null } | null; canWork: boolean };

function Qr({ text }: { text: string }) {
  const src = (() => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(5, 2); })();
  return <img src={src} className="qr" alt={`QR-код ${text}`} />;
}

export function PersonPasses({ me, personId, clubId }: { me: Me; personId: string; clubId: string }) {
  const [p, setP] = useState<Passes | null>(null);
  const [form, setForm] = useState<{ kind: string; code: string; replaceId: string | null } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Passes>('GET', `/api/persons/${personId}/passes${clubId ? `?clubId=${clubId}` : ''}`).then(setP).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [personId, clubId]);
  const issue = async (e: FormEvent) => {
    e.preventDefault(); if (!form) return; setErr('');
    try {
      const r = await api<{ code: string; kind: string }>('POST', `/api/persons/${personId}/credentials`, { kind: form.kind, code: form.code, clubId, replaceId: form.replaceId ?? undefined, reason: form.replaceId ? 'Перевыпуск' : undefined });
      toast(form.replaceId ? 'Выдана новая карта, старая больше не откроет турникет' : r.kind === 'qr' ? 'QR-код создан' : r.kind === 'bracelet' ? 'Браслет выдан' : 'Карта выдана');
      if (r.kind === 'qr') setQr(r.code);
      setForm(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  const revoke = async (id: string) => {
    try { await api('POST', `/api/acs/credentials/${id}/revoke`, { status: 'lost', reason: 'Клиент сообщил об утере' }); toast('Карта отмечена утерянной'); load(); } catch (e) { setErr(errText(e)); }
  };
  if (!p) return err ? <p className="err">{err}</p> : null;
  const active = p.credentials.filter((c) => c.status === 'active');
  const old = p.credentials.filter((c) => c.status !== 'active');
  const work = p.canWork && can(me, 'acs.work');
  return (
    <div className="card acs" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><b>Проход в клуб</b>
        {p.now && <span className={`chip ${p.now.allow ? 'ok' : 'bad'}`}>{p.now.allow ? 'пустит' : 'не пустит'}</span>}</div>
      {p.now && <span className="small">{p.now.reason}{p.now.warn ? `. ${p.now.warn}` : ''}</span>}
      <div className="list">
        {active.map((c) => (
          <div key={c.id} className="item row between">
            <span><b>{KIND[c.kind]}</b> <span className="num">{c.code}</span> <span className="small">выдана {dt(c.issuedAt)}{c.issuedBy ? `, ${c.issuedBy}` : ''}</span></span>
            {work && <span className="row">
              {c.kind === 'qr' && <button className="btn sm" onClick={() => setQr(qr === c.code ? null : c.code)}>{qr === c.code ? 'Скрыть' : 'Показать QR'}</button>}
              <button className="btn sm" onClick={() => setForm({ kind: c.kind === 'qr' ? 'qr' : c.kind, code: '', replaceId: c.id })}>Перевыпустить</button>
              <button className="btn sm" onClick={() => revoke(c.id)}>Утеряна</button></span>}
          </div>))}
        {active.length === 0 && <span className="muted">Карта, браслет или QR не выданы.</span>}
      </div>
      {qr && <div className="row" style={{ alignItems: 'flex-start' }}><Qr text={qr} /><span className="small" style={{ maxWidth: 260 }}>QR-код клиента для прохода. Позже он будет в мобильном приложении и в мессенджере.</span></div>}
      {work && !form && <div className="row"><button className="btn sm" onClick={() => setForm({ kind: 'card', code: '', replaceId: null })}>Выдать карту или браслет</button>
        <button className="btn sm" onClick={() => setForm({ kind: 'qr', code: '', replaceId: null })}>Сделать QR-код</button></div>}
      {form && (
        <form className="row" onSubmit={issue}>
          {form.replaceId && <span className="small">Перевыпуск: старая карта перестанет открывать турникет, клиент останется тем же.</span>}
          <select aria-label="Что выдаём" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ width: 'auto' }}>{Object.entries(KIND).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
          {form.kind !== 'qr' && <input autoFocus placeholder="Номер с карты или со считывателя" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} style={{ flex: '1 1 160px' }} />}
          <button className="btn pri">{form.kind === 'qr' ? 'Создать' : 'Выдать'}</button><button type="button" className="btn" onClick={() => setForm(null)}>Отмена</button>
        </form>)}
      {err && <p className="err">{err}</p>}
      <div className="row small"><span>За 30 дней: <b>{p.stats.last30}</b></span><span>Всего: <b>{p.stats.total}</b></span><span>В среднем в клубе: <b>{mins(p.stats.avgMinutes)}</b></span>
        <span>Последний раз: <b>{p.stats.lastAt ? dt(p.stats.lastAt) : '—'}</b></span></div>
      {p.visits.length > 0 && <details><summary className="small">Последние посещения</summary><div className="tbl"><table><thead><tr><th>Пришёл</th><th>Ушёл</th><th>Время</th><th>Клуб</th></tr></thead>
        <tbody>{p.visits.map((v) => <tr key={v.id}><td className="num">{dt(v.at)}</td><td className="num">{v.exitAt ? time(v.exitAt) : '—'}</td><td>{mins(v.minutes)}</td>
          <td className="small">{v.club}{v.source === 'manual' ? ', вручную' : v.source === 'import' ? ', из 1С' : ''}</td></tr>)}</tbody></table></div></details>}
      {old.length > 0 && <details><summary className="small">Старые карты ({old.length})</summary>
        {old.map((c) => <div key={c.id} className="small">{KIND[c.kind]} {c.code}: {CRED_STATUS[c.status]} {c.revokedAt ? dt(c.revokedAt) : ''}{c.revokeReason ? `, ${c.revokeReason}` : ''}</div>)}</details>}
    </div>
  );
}
