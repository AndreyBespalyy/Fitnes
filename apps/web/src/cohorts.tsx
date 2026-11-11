// Удержание по месяцам прихода и ценность клиента по каналам, тарифам, продавцам и тренерам.
import { useEffect, useState } from 'react';
import { api, type Club, type Me } from './api.ts';
import { errText } from './ui.ts';

type Row = { name: string; clients: number; avgKop: number; totalKop: number; avgMonths: number; after3: { pct: number; n: number } | null; after6: { pct: number; n: number } | null };
type Data = { today: string; offsets: number[]; clients: number; avgKop: number; cohorts: { cohort: string; clients: number; avgKop: number; retained: (number | null)[] }[];
  by: Record<'channel' | 'tariff' | 'seller' | 'trainer' | 'promo', Row[]> };
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const mName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const DIMS: [keyof Data['by'], string, string][] = [
  ['channel', 'Каналы', 'Канал рекламы'], ['tariff', 'Первый тариф', 'Тариф первой покупки'], ['seller', 'Продавцы', 'Кто продал первый абонемент'],
  ['trainer', 'Тренеры', 'Персональный тренер'], ['promo', 'Акции', 'Первая покупка'],
];
const pct = (x: { pct: number; n: number } | null) => (x ? `${x.pct} %` : '—');

export function CohortsPage({ clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId);
  useEffect(() => setClub(clubId), [clubId]);
  const [dim, setDim] = useState<keyof Data['by']>('channel');
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setErr(''); api<Data>('GET', `/api/cohorts?clubId=${club}&months=13`).then(setD).catch((x) => setErr(errText(x))); }, [club]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const rows = d.by[dim];
  const best = rows.filter((r) => r.clients >= 3).sort((a, b) => b.avgKop - a.avgKop);
  const label = DIMS.find((x) => x[0] === dim)!;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Удержание и ценность клиента</h2>
        {clubs.length > 1 && <select value={club} onChange={(e) => setClub(e.target.value)} aria-label="Клуб" style={{ width: 'auto' }}>
          <option value="all">Все клубы</option>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="kpis">
        <div className="card kpi-c"><span className="lbl">Новых клиентов за 13 месяцев</span><b className="num">{d.clients}</b><span className="small muted">первая покупка в клубе, без гостевых</span></div>
        <div className="card kpi-c"><span className="lbl">Средние деньги с клиента</span><b className="num">{rub(d.avgKop)}</b><span className="small muted">оплаты минус возвраты за всё время</span></div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Сколько клиентов остаётся</h2>
        <div className="heat-wrap">
          <table className="heat coh">
            <thead><tr><th scope="col">Месяц прихода</th><th scope="col">Клиентов</th>{d.offsets.map((k) => <th key={k} scope="col">через {k} мес.</th>)}<th scope="col">Денег с клиента</th></tr></thead>
            <tbody>{d.cohorts.map((c) => (
              <tr key={c.cohort}><th scope="row">{mName(c.cohort)}</th><td>{c.clients}</td>
                {c.retained.map((v, i) => v == null ? <td key={i} className="muted">·</td> : (
                  <td key={i} title={`${mName(c.cohort)}: через ${d.offsets[i]} мес. с нами ${v} % из ${c.clients}`}
                    style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(6 + v * 0.84)}%, transparent)`, color: v > 55 ? 'var(--accent-ink)' : undefined }}>{v} %</td>))}
                <td>{rub(c.avgKop)}</td></tr>))}
              {d.cohorts.length === 0 && <tr><td colSpan={d.offsets.length + 3} className="muted">Новых клиентов за этот период нет.</td></tr>}
            </tbody>
          </table>
        </div>
        <span className="small muted">Клиент считается оставшимся в месяце, если у него действовал абонемент или было посещение. Точка — месяц ещё не наступил.</span>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Ценность клиента</h2>
          <div className="seg" role="group" aria-label="Разрез">{DIMS.map(([k, l]) => <button key={k} className={dim === k ? 'on' : ''} aria-pressed={dim === k} onClick={() => setDim(k)}>{l}</button>)}</div>
        </div>
        {best.length >= 2 && dim !== 'promo' && <div className="small">Больше всего денег с клиента: <b>{best[0].name}</b> ({rub(best[0].avgKop)}), меньше всего: <b>{best[best.length - 1].name}</b> ({rub(best[best.length - 1].avgKop)}).</div>}
        <div className="tbl"><table>
          <thead><tr><th>{label[2]}</th><th className="num">Клиентов</th><th className="num">Денег с клиента</th><th className="num">Всего</th><th className="num">Месяцев с нами</th><th className="num">Остались через 3 мес.</th><th className="num">через 6 мес.</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.name}><td>{r.name}</td><td className="num">{r.clients}</td><td className="num"><b>{rub(r.avgKop)}</b></td><td className="num">{rub(r.totalKop)}</td>
              <td className="num">{r.avgMonths.toLocaleString('ru-RU')}</td><td className="num" title={r.after3 ? `из ${r.after3.n}, у кого прошло 3 месяца` : 'ещё рано'}>{pct(r.after3)}</td>
              <td className="num" title={r.after6 ? `из ${r.after6.n}, у кого прошло 6 месяцев` : 'ещё рано'}>{pct(r.after6)}</td></tr>))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">{dim === 'trainer' ? 'Персональных тренировок у новых клиентов пока не было.' : 'Данных пока нет.'}</td></tr>}
          </tbody></table></div>
        <span className="small muted">Сравнивайте не только число клиентов, но и деньги с клиента и долю оставшихся: канал с дешёвыми заявками может приводить тех, кто купил месяц по акции и ушёл.</span>
      </div>
    </div>
  );
}
