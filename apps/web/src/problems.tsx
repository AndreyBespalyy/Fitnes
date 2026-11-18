// «Проблемные моменты»: всё, что требует внимания руководителя, на одном экране (разграничение доступов, 15.11.2026).
// Собственник видит суть без операционки: число и сумму по каждому пункту, разбивку по клубам и куда перейти, чтобы разобраться.
import { useEffect, useState } from 'react';
import { api, type Club, type Go, type Me } from './api.ts';
import { errText } from './ui.ts';

type Item = { id: string; group: string; title: string; hint: string; go: Go; value: number | null; moneyKop: number | null;
  perClub: { clubId: string; name: string; value: number | null; moneyKop: number | null }[] };
type Low = { id: string; personId: string; name: string; score: number; comment: string | null; at: string; club: string; handled: boolean };
type Data = { clubs: { id: string; name: string }[]; items: Item[]; lows: Low[]; total: number };

const GROUPS: [string, string][] = [['money', 'Деньги'], ['cash', 'Касса'], ['clients', 'Клиенты'], ['team', 'Команда']];
const rub = (kop: number | null) => (kop ? `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽` : '');

export function ProblemsPage({ clubs, clubId, go, canGo, openPerson }: { me: Me; clubs: Club[]; clubId: string; go: (g: Go) => void; canGo: (t: string) => boolean; openPerson: (id: string) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  // Плитка «Требуют внимания» нажимается: оставляет в списке только пункты, где что-то есть, и ведёт к ним (замечание №27)
  const [onlyOn, setOnlyOn] = useState(false);
  const showOn = () => { setOnlyOn((v) => !v); setTimeout(() => document.getElementById('prob-groups')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
  useEffect(() => {
    setD(null); setErr('');
    api<Data>('GET', `/api/problems?clubId=${encodeURIComponent(clubId)}`).then(setD).catch((e) => setErr(errText(e)));
  }, [clubId]);
  const club = clubs.find((c) => c.id === clubId);
  const open = (i: Item) => { if (canGo(i.go.tab)) go({ tab: i.go.tab, p: i.go.p }); };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <div className="lbl">{club ? club.name : 'Вся сеть'}</div>
        <h1>Проблемные моменты</h1>
        <p className="small muted" style={{ margin: 0 }}>Что требует внимания сейчас. Нажмите на пункт, чтобы перейти к подробностям.</p>
      </div>
      {err && <div className="err">{err}</div>}
      {!d && !err && <p className="muted">Загрузка…</p>}
      {d && (
        <div className="kpis">
          <div className={`card kpi-c click ${onlyOn ? 'on' : ''}`} onClick={showOn} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') showOn(); }}
            title={onlyOn ? 'Показать все проверки' : 'Показать только то, что требует внимания'}>
            <span className="lbl">Требуют внимания</span><b className={`num ${d.total ? 'bad' : ''}`}>{d.total}</b>
            <span className="small muted">{onlyOn ? 'показаны только они · нажмите, чтобы вернуть все' : `из ${d.items.length} проверок · нажмите, чтобы показать`}</span></div>
          {d.items.filter((i) => i.moneyKop).slice(0, 3).map((i) => (
            <div key={i.id} className={`card kpi-c ${canGo(i.go.tab) ? 'click' : ''}`} onClick={() => open(i)} role={canGo(i.go.tab) ? 'button' : undefined} tabIndex={canGo(i.go.tab) ? 0 : undefined}>
              <span className="lbl">{i.title}</span><b className="num bad">{rub(i.moneyKop)}</b><span className="small muted">{i.value} шт.</span>
            </div>))}
        </div>
      )}
      <div id="prob-groups" />
      {d && onlyOn && d.total === 0 && <p className="muted">Сейчас ничего не требует внимания.</p>}
      {d && GROUPS.map(([g, title]) => {
        const list = d.items.filter((i) => i.group === g && (!onlyOn || (i.value ?? 0) > 0));
        if (!list.length) return null;
        return (
          <div key={g} className="card">
            <h2>{title}</h2>
            <div className="risk-list">{list.map((i) => {
              const on = (i.value ?? 0) > 0; const click = canGo(i.go.tab);
              return (
                <div key={i.id} className={`item row between ${click ? 'click' : ''} ${on ? 'risk-on' : ''}`} style={{ gap: 8 }}
                  onClick={() => open(i)} role={click ? 'button' : undefined} tabIndex={click ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') open(i); }}>
                  <span><b>{i.title}</b>
                    <div className="small muted">{i.hint}{d.clubs.length > 1 && on ? ` · ${i.perClub.filter((p) => p.value).map((p) => `${p.name}: ${p.value}${p.moneyKop ? ` (${rub(p.moneyKop)})` : ''}`).join(', ')}` : ''}</div></span>
                  <b className={`num ${on ? 'bad' : 'ok'}`} style={{ fontSize: 20, textAlign: 'right' }}>{i.value === null ? '—' : i.value}
                    {i.moneyKop ? <div className="small">{rub(i.moneyKop)}</div> : null}</b>
                </div>);
            })}</div>
          </div>);
      })}
      {d && d.lows.length > 0 && (
        <div className="card">
          <h2>Недовольные клиенты за 30 дней</h2>
          <div className="tbl"><table>
            <thead><tr><th>Клиент</th><th>Клуб</th><th>Оценка</th><th>Комментарий</th><th>Разобрано</th></tr></thead>
            <tbody>{d.lows.map((l) => (
              <tr key={l.id}><td><button className="btn sm" onClick={() => openPerson(l.personId)}>{l.name}</button></td><td>{l.club}</td>
                <td className="num bad">{l.score}</td><td>{l.comment || <span className="muted">без комментария</span>}</td><td>{l.handled ? 'да' : <span className="bad">нет</span>}</td></tr>))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
