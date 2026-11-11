// Упрощённый управленческий отчёт о прибыли: доходы, расходы и прибыль клуба за месяц со сравнением.
import { useEffect, useState } from 'react';
import { api, type Club, type Me } from './api.ts';
import { errText, toast } from './ui.ts';

type M = {
  month: string; revenue: { code: string; name: string; amountKop: number }[]; revenueKop: number; refundsKop: number; netRevenueKop: number;
  expenses: { code: string; name: string; amountKop: number; note?: string }[]; expensesKop: number; profitKop: number; marginPct: number | null; activeClients: number;
};
type Data = { month: string; today: string; current: boolean; cur: M; prev: M; lastYear: M; trend: M[]; areaM2: number | null; perM2Kop: number | null; perClientKop: number | null;
  signals: { kind: string; month: string; text: string }[]; alerts: { month: string; kind: string; text: string; at: string; club: string }[]; canEditArea: boolean };
const rub = (k: number) => `${k < 0 ? '−' : ''}${Math.round(Math.abs(k) / 100).toLocaleString('ru-RU')} ₽`;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const mName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const mShort = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
const shift = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const delta = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);

export function PnlPage({ clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId);
  useEffect(() => setClub(clubId), [clubId]);
  const [month, setMonth] = useState('');
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [area, setArea] = useState<string | null>(null);
  const load = () => api<Data>('GET', `/api/pnl?clubId=${club}${month ? `&month=${month}` : ''}`).then((x) => { setD(x); setErr(''); }).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club, month]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const c = d.cur;
  const saveArea = async () => {
    try { await api('PUT', '/api/pnl/area', { clubId: club, areaM2: area === '' ? null : Number(area) }); toast('Площадь сохранена'); setArea(null); load(); } catch (x) { setErr(errText(x)); }
  };
  // Строки отчёта: все статьи, что встречаются в текущем, прошлом месяце или год назад
  const keys = (pick: (m: M) => { code: string; name: string }[]) => {
    const map = new Map<string, string>();
    for (const m of [c, d.prev, d.lastYear]) for (const x of pick(m)) map.set(x.code, x.name);
    return [...map.entries()];
  };
  const amt = (m: M, kind: 'revenue' | 'expenses', code: string) => m[kind].find((x) => x.code === code)?.amountKop ?? 0;
  const row = (label: string, f: (m: M) => number, opt: { bold?: boolean; neg?: boolean; note?: string; costs?: boolean; key?: string } = {}) => {
    const a = f(c), b = f(d.prev), y = f(d.lastYear);
    const dv = delta(a, b);
    const good = dv == null || dv === 0 ? '' : (dv > 0) !== !!opt.costs ? 'ok' : 'bad';
    return (
      <tr key={opt.key ?? label} className={opt.bold ? 'pnl-total' : ''}>
        <td>{opt.bold ? <b>{label}</b> : label}{opt.note && <div className="small muted">{opt.note}</div>}</td>
        <td className="num">{opt.neg && a ? `−${rub(a)}` : rub(a)}</td>
        <td className="num muted">{opt.neg && b ? `−${rub(b)}` : rub(b)}</td>
        <td className={`num small ${good}`}>{dv == null ? '—' : `${dv > 0 ? '+' : ''}${dv} %`}</td>
        <td className="num muted hide-narrow">{y ? rub(y) : '—'}</td>
      </tr>);
  };
  const tmax = Math.max(1, ...d.trend.flatMap((m) => [m.netRevenueKop, m.expensesKop]));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Прибыль клуба</h2>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {clubs.length > 1 && <select value={club} onChange={(e) => setClub(e.target.value)} aria-label="Клуб" style={{ width: 'auto' }}>
            <option value="all">Все клубы</option>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          <button className="btn sm" onClick={() => setMonth(shift(d.month, -1))} aria-label="Предыдущий месяц">←</button>
          <b style={{ alignSelf: 'center', minWidth: 120, textAlign: 'center' }}>{mName(d.month)}</b>
          <button className="btn sm" disabled={d.current} onClick={() => setMonth(shift(d.month, 1))} aria-label="Следующий месяц">→</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {d.current && <div className="small muted">Месяц ещё идёт: цифры неполные, зарплата — оценка, пока ведомость не утверждена.</div>}
      {d.signals.map((s, i) => <div key={i} className="err" role="status">⚠ {s.text}</div>)}

      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Выручка</span><b className="num">{rub(c.netRevenueKop)}</b><span className="small muted">оплаты минус возвраты</span></div>
        <div className="card kpi-c"><span className="lbl">Расходы</span><b className="num">{rub(c.expensesKop)}</b><span className="small muted">включая зарплату</span></div>
        <div className="card kpi-c"><span className="lbl">Прибыль</span><b className={`num ${c.profitKop < 0 ? 'bad' : ''}`}>{rub(c.profitKop)}</b><span className="small muted">{c.marginPct != null ? `рентабельность ${c.marginPct.toLocaleString('ru-RU')} %` : '—'}</span></div>
        <div className="card kpi-c"><span className="lbl">На одного клиента</span><b className="num">{d.perClientKop != null ? rub(d.perClientKop) : '—'}</b><span className="small muted">клиентов с абонементом: {c.activeClients}</span></div>
        <div className="card kpi-c"><span className="lbl">На 1 м² площади</span>
          {area == null ? <><b className="num">{d.perM2Kop != null ? rub(d.perM2Kop) : '—'}</b>
            <span className="small muted">{d.areaM2 ? `площадь ${d.areaM2.toLocaleString('ru-RU')} м²` : 'площадь не указана'}{d.canEditArea && <> · <button className="link small" onClick={() => setArea(d.areaM2 ? String(d.areaM2) : '')}>изменить</button></>}</span></>
            : <div className="row" style={{ gap: 4 }}><input type="number" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Площадь, м²" placeholder="м²" style={{ width: 90 }} /><button className="btn sm pri" onClick={saveArea}>OK</button><button className="btn sm" onClick={() => setArea(null)}>×</button></div>}
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="tbl"><table className="pnl">
          <thead><tr><th>Статья</th><th className="num">{mShort(c.month)}</th><th className="num">{mShort(d.prev.month)}</th><th className="num">Изменение</th><th className="num hide-narrow">{mShort(d.lastYear.month)}</th></tr></thead>
          <tbody>
            <tr className="pnl-sec"><td colSpan={5}>Доходы</td></tr>
            {keys((m) => m.revenue).map(([code, name]) => row(name, (m) => amt(m, 'revenue', code), { key: `r${code}` }))}
            {row('Возвраты клиентам', (m) => m.refundsKop, { neg: true, costs: true })}
            {row('Выручка', (m) => m.netRevenueKop, { bold: true })}
            <tr className="pnl-sec"><td colSpan={5}>Расходы</td></tr>
            {keys((m) => m.expenses).map(([code, name]) => row(name, (m) => amt(m, 'expenses', code), { key: `e${code}`, costs: true, note: c.expenses.find((x) => x.code === code)?.note }))}
            {row('Всего расходов', (m) => m.expensesKop, { bold: true, costs: true })}
            {row('Прибыль', (m) => m.profitKop, { bold: true })}
          </tbody></table></div>
        <span className="small muted">Доходы — по оплатам клиентов в этом месяце (депозиты и сертификаты — предоплата, отдельной строкой). Расходы — из раздела «Финансы», зарплата — по утверждённой ведомости месяца.</span>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>За полгода</h2>
        <div className="pnl-trend" role="img" aria-label="Выручка и расходы по месяцам">
          {d.trend.map((m) => (
            <div key={m.month} className="pnl-col" title={`${mName(m.month)}: выручка ${rub(m.netRevenueKop)}, расходы ${rub(m.expensesKop)}, прибыль ${rub(m.profitKop)}`}>
              <div className="pnl-bars">
                <span className="pnl-bar rev" style={{ height: `${Math.max(2, (m.netRevenueKop / tmax) * 120)}px` }} />
                <span className="pnl-bar exp" style={{ height: `${Math.max(2, (m.expensesKop / tmax) * 120)}px` }} />
              </div>
              <b className={`small ${m.profitKop < 0 ? 'bad' : ''}`}>{rub(m.profitKop)}</b>
              <span className="small muted">{mShort(m.month)}</span>
            </div>))}
        </div>
        <div className="row small muted" style={{ gap: 14 }}><span><span className="pnl-key rev" /> выручка</span><span><span className="pnl-key exp" /> расходы</span><span>число — прибыль</span></div>
      </div>

      {d.alerts.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          <h2>Сигналы собственнику</h2>
          {d.alerts.map((a, i) => <div key={i} className="small">{a.club}: {a.text}</div>)}
        </div>)}
    </div>
  );
}
