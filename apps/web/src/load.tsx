// Загрузка клуба по часам: тепловая карта «день недели × час», сравнение с прошлым месяцем, залы, входы и прогноз на неделю.
import { useEffect, useState } from 'react';
import { api, type Club, type Me } from './api.ts';
import { errText } from './ui.ts';

type Grid = number[][];
type Room = { id: string; name: string; sessions: number; seats: number; taken: number; fill: number; cells: { dow: number; hr: number; sessions: number; fill: number }[] };
type Load = {
  month: string; prevMonth: string; today: string; openFrom: string; openTo: string; stayMin: number;
  inside: Grid; entries: Grid; visits: number; prev: { inside: Grid; entries: Grid; visits: number };
  zones: { id: string; name: string; total: number; grid: Grid }[]; rooms: Room[];
  forecast: { day: string; dow: number; hours: number[]; visits: number; peakHour: number; classes: number }[];
  peak: number; hints: { kind: string; text: string }[]; exitsKnown: number;
};
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const mName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shift = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const fmt = (v: number) => (v === 0 ? '' : v < 10 ? v.toFixed(1).replace('.', ',') : String(Math.round(v)));

export function LoadPage({ clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [month, setMonth] = useState('');
  const [metric, setMetric] = useState<'inside' | 'entries'>('inside');
  const [view, setView] = useState<'now' | 'diff'>('now');
  const [zone, setZone] = useState('');
  const [d, setD] = useState<Load | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!club) return;
    setErr('');
    api<Load>('GET', `/api/load?clubId=${club}${month ? `&month=${month}` : ''}`).then(setD).catch((x) => setErr(errText(x)));
  }, [club, month]);
  if (!club) return <p className="muted">Клубов нет.</p>;
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;

  const h0 = Number(d.openFrom.slice(0, 2));
  const h1 = Math.min(24, Math.max(h0 + 1, Number(d.openTo.slice(0, 2)) + (d.openTo.endsWith(':00') ? 0 : 1)));
  const hours = Array.from({ length: h1 - h0 }, (_, i) => h0 + i);
  const z = d.zones.find((x) => x.id === zone);
  const cur = z ? z.grid : d[metric];
  const prev = d.prev[metric];
  const max = Math.max(0.1, ...cur.flatMap((r) => r.slice(h0, h1)));
  const dmax = Math.max(0.1, ...cur.flatMap((r, i) => r.slice(h0, h1).map((v, j) => Math.abs(v - prev[i][h0 + j]))));
  const unit = z ? 'входов в час' : metric === 'inside' ? 'человек в клубе' : 'входов в час';
  const isCurrent = d.month === d.today.slice(0, 7);
  const delta = d.prev.visits ? Math.round(((d.visits / Math.max(1, Number(isCurrent ? d.today.slice(8, 10) : 30))) / (d.prev.visits / 30) - 1) * 100) : null;
  const fmax = Math.max(1, ...d.forecast.map((f) => f.visits));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Загрузка клуба по часам</h2>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {clubId === 'all' && clubs.length > 1 && <select value={club} onChange={(e) => setClub(e.target.value)} aria-label="Клуб" style={{ width: 'auto' }}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          <button className="btn sm" onClick={() => setMonth(shift(d.month, -1))} aria-label="Предыдущий месяц">←</button>
          <b style={{ alignSelf: 'center', minWidth: 120, textAlign: 'center' }}>{mName(d.month)}</b>
          <button className="btn sm" disabled={isCurrent} onClick={() => setMonth(shift(d.month, 1))} aria-label="Следующий месяц">→</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Посещений за {isCurrent ? 'месяц пока' : 'месяц'}</span><b className="num">{d.visits.toLocaleString('ru-RU')}</b>
          <span className="small muted">{mName(d.prevMonth)}: {d.prev.visits.toLocaleString('ru-RU')}{delta != null ? ` · в день ${delta >= 0 ? '+' : ''}${delta} %` : ''}</span></div>
        <div className="card kpi-c"><span className="lbl">Пик в клубе одновременно</span><b className="num">≈ {Math.round(d.peak)}</b><span className="small muted">в среднем в самый загруженный час</span></div>
        <div className="card kpi-c"><span className="lbl">Выход отмечен</span><b className="num">{d.exitsKnown} %</b><span className="small muted">{d.exitsKnown < 80 ? `остальным считаем ${d.stayMin} минут в клубе` : 'точный расчёт по выходам'}</span></div>
      </div>

      {d.hints.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <h2>Что видно</h2>
          {d.hints.map((h, i) => <div key={i} className="small">• {h.text}</div>)}
        </div>)}

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="seg" role="group" aria-label="Что показать">
            <button className={!z && metric === 'inside' ? 'on' : ''} aria-pressed={!z && metric === 'inside'} onClick={() => { setZone(''); setMetric('inside'); }}>В клубе</button>
            <button className={!z && metric === 'entries' ? 'on' : ''} aria-pressed={!z && metric === 'entries'} onClick={() => { setZone(''); setMetric('entries'); }}>Входы</button>
            {d.zones.map((x) => <button key={x.id} className={zone === x.id ? 'on' : ''} aria-pressed={zone === x.id} onClick={() => setZone(x.id)}>{x.name}</button>)}
          </div>
          {!z && <div className="seg" role="group" aria-label="Сравнение">
            <button className={view === 'now' ? 'on' : ''} aria-pressed={view === 'now'} onClick={() => setView('now')}>{mName(d.month)}</button>
            <button className={view === 'diff' ? 'on' : ''} aria-pressed={view === 'diff'} onClick={() => setView('diff')}>Разница с прошлым</button>
          </div>}
        </div>
        <div className="heat-wrap">
          <table className="heat">
            <thead><tr><th />{hours.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{DOW.map((name, i) => (
              <tr key={name}><th scope="row">{name}</th>{hours.map((h) => {
                const v = cur[i][h]; const p = prev[i][h];
                if (view === 'diff' && !z) {
                  const x = v - p; const a = Math.min(1, Math.abs(x) / dmax);
                  return <td key={h} title={`${name} ${h}:00 — ${mName(d.month)}: ${fmt(v) || 0}, ${mName(d.prevMonth)}: ${fmt(p) || 0} (${unit})`}
                    style={{ background: x === 0 ? 'transparent' : `color-mix(in srgb, var(${x > 0 ? '--ok' : '--bad'}) ${Math.round(12 + a * 60)}%, transparent)` }}>{x === 0 ? '' : `${x > 0 ? '+' : '−'}${fmt(Math.abs(x))}`}</td>;
                }
                const a = v / max;
                return <td key={h} title={`${name} ${h}:00 — ${fmt(v) || 0} ${unit} в среднем`}
                  style={{ background: v ? `color-mix(in srgb, var(--accent) ${Math.round(8 + a * 82)}%, transparent)` : 'transparent', color: a > 0.55 ? 'var(--accent-ink)' : undefined }}>{fmt(v)}</td>;
              })}</tr>))}</tbody>
          </table>
        </div>
        <span className="small muted">{view === 'diff' && !z ? `Зелёный — людей стало больше, чем в ${mName(d.prevMonth).split(' ')[0]}е, красный — меньше. ` : ''}Числа — среднее за один {`день недели в этом часу`} ({unit}). Наведите на клетку, чтобы увидеть подробности.</span>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Прогноз на неделю</h2>
        <div className="fc">
          {d.forecast.map((f) => (
            <div key={f.day} className="fc-day" title={`${f.day.split('-').reverse().join('.')}: ожидаем ≈${f.visits} посещений, пик около ${f.peakHour}:00${f.classes ? `, записано на групповые ${f.classes}` : ''}`}>
              <span className="fc-bar" style={{ height: `${Math.max(4, (f.visits / fmax) * 90)}px` }} />
              <b className="small">{f.visits}</b>
              <span className="small muted">{DOW[f.dow]} {f.day.slice(8, 10)}.{f.day.slice(5, 7)}</span>
              <span className="small muted">пик {f.peakHour}:00</span>
              {f.classes > 0 && <span className="small muted">групп. {f.classes}</span>}
            </div>))}
        </div>
        <span className="small muted">По средней за последние 4 недели для того же дня недели. Удобно сверять с графиком ресепшна и тренеров.</span>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Групповые залы</h2>
        {d.rooms.length === 0 ? <p className="muted" style={{ margin: 0 }}>В этом месяце групповых занятий не было.</p> : d.rooms.map((r) => (
          <div key={r.id} style={{ display: 'grid', gap: 6 }}>
            <div className="row between"><b>{r.name}</b><span className="small muted">{r.sessions} занятий · заполнено {r.fill} % мест</span></div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {r.cells.map((c) => <span key={`${c.dow}-${c.hr}`} className={`chip ${c.fill >= 85 ? 'ok' : c.fill < 40 ? 'bad' : ''}`} title={`${c.sessions} занятий в этом слоте`}>{DOW[c.dow]} {c.hr}:00 — {c.fill} %</span>)}
            </div>
          </div>))}
      </div>
    </div>
  );
}
