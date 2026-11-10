// Шаг 18, часть 3. Обзоры менеджеров, рекомендации с обратной связью, прогноз плана, план до клиентов, оценка звонков по стандарту.
import { useEffect, useState } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';

type Metric = { id: string; name: string; value: number | null; norm: number | null; peersAvg: number | null; ok: boolean | null; higherIsBetter: boolean };
type Rec = { metric: string; title: string; details: string; higherBetter: boolean; baseline: number | null; target: number | null };
type Review = { user: { id: string; name: string; role: string }; from: string; to: string; workDays: number; metrics: Metric[];
  funnel: { mine: Funnel | null; dept: Funnel }; plan: { month: string; rows: PlanRow[]; total: PlanRow };
  quality: { evaluated: number; avg: number | null; weakItems: { text: string; missed: number; total: number }[] };
  work: { hasSchedule: boolean; plannedMin: number; workedMin: number; shifts: number; workedShifts: number; lateCount: number; airMin: number; recordedCalls: number; callsPerHour: number | null; peersCallsPerHour: number | null };
  strengths: string[]; weaknesses: string[]; recommendations: Rec[]; confidence: string; basis: string; enoughData: boolean; openRecommendations: { id: string; title: string }[] };
type Funnel = { leads: number; contacted: number; meetingSet: number; meetingDone: number; bought: number; boughtPct: number | null; meetingSetPct: number | null };
type PlanRow = { category?: string; name?: string; planKop: number | null; factKop: number; forecastKop: number; deficitKop: number | null; percent: number | null; light: string; dayPlanKop: number | null };
type RecRow = { id: string; userId: string; userName: string; authorName: string | null; origin: string; title: string; details: string | null; metric: string; higherBetter: boolean;
  baseline: number | null; target: number | null; result: number | null; startsOn: string; dueOn: string; status: string; userMark: string | null; userComment: string | null };

const d2 = (s: string) => s.split('-').reverse().join('.');
const h = (min: number) => `${Math.floor(min / 60)} ч ${min % 60} мин`;
const LIGHT: Record<string, [string, string]> = { green: ['в темпе', 'ok'], yellow: ['отстаёт', 'warn'], red: ['риск', 'bad'], none: ['нет плана', ''] };
const RST: Record<string, [string, string]> = { open: ['в работе', ''], done: ['выполнена', 'ok'], not_done: ['не выполнена', 'bad'], cancelled: ['отменена', ''] };
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

export function ReviewsPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const leader = can(me, 'dash.view') || can(me, 'ai.review');
  const tabs: [string, string, boolean][] = [['my', 'Мой обзор', can(me, 'crm.work')], ['team', 'Отдел', leader], ['forecast', 'Прогноз плана', can(me, 'dash.view') || can(me, 'plan.manage')],
    ['recs', 'Рекомендации', true], ['quality', 'Качество звонков', can(me, 'ai.review')]];
  const [tab, setTab] = useState(leader ? 'team' : 'my');
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const club = clubs.find((c) => c.id === clubId) ?? (clubs.length === 1 ? clubs[0] : null);
  if (!club) return <div className="card"><p style={{ margin: 0 }}>Выберите клуб вверху страницы.</p></div>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="tabs" role="group" aria-label="Обзоры">{tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={tab === k} onClick={() => { setTab(k); setPerson(null); }}>{t}</button>)}</div>
      {tab === 'my' && <ReviewView clubId={club.id} userId={null} leader={false} />}
      {tab === 'team' && (person
        ? <><div><button className="btn sm" onClick={() => setPerson(null)}>← Весь отдел</button></div><ReviewView clubId={club.id} userId={person.id} leader /></>
        : <Team clubId={club.id} onOpen={setPerson} />)}
      {tab === 'forecast' && <Forecast clubId={club.id} openPerson={openPerson} />}
      {tab === 'recs' && <Recs clubId={club.id} leader={leader} meId={me.id} />}
      {tab === 'quality' && <QualityView clubId={club.id} />}
    </div>
  );
}

function Team({ clubId, onOpen }: { clubId: string; onOpen: (p: { id: string; name: string }) => void }) {
  const [period, setPeriod] = useState('week');
  const [d, setD] = useState<{ from: string; to: string; rows: { userId: string; name: string; weaknesses: number; strengths: number; suggestions: number; quality: number | null; plan: number | null; light: string; calls: number; sales: number }[] } | null>(null);
  useEffect(() => { setD(null); api<typeof d>('GET', `/api/reviews/team?clubId=${clubId}&period=${period}`).then(setD).catch((x) => toast(errText(x))); }, [clubId, period]);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <b>Отдел продаж{d ? `: ${d2(d.from)} — ${d2(d.to)}` : ''}</b>
        <div className="tabs" role="group" aria-label="Период"><button aria-pressed={period === 'week'} onClick={() => setPeriod('week')}>Неделя</button><button aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Месяц</button></div>
      </div>
      {!d ? <p className="muted">Загрузка…</p> : (
        <div className="tbl"><table><thead><tr><th>Сотрудник</th><th>План месяца</th><th>Звонки</th><th>Продажи</th><th className="hide-narrow">Качество</th><th>Сильные / слабые</th><th></th></tr></thead>
          <tbody>{d.rows.map((r) => (
            <tr key={r.userId}><td><b>{r.name}</b></td><td><span className={`chip ${LIGHT[r.light]?.[1] ?? ''}`}>{r.plan === null ? LIGHT[r.light]?.[0] : `${r.plan} %`}</span></td>
              <td className="num">{r.calls}</td><td className="num">{r.sales}</td><td className="num hide-narrow">{r.quality === null ? '—' : `${r.quality} %`}</td>
              <td className="small"><span style={{ color: 'var(--ok)' }}>{r.strengths}</span> / <span style={{ color: r.weaknesses ? 'var(--bad)' : undefined }}>{r.weaknesses}</span>{r.suggestions ? ` · рекомендаций: ${r.suggestions}` : ''}</td>
              <td><button className="btn sm" onClick={() => onOpen({ id: r.userId, name: r.name })}>Обзор</button></td></tr>))}</tbody></table></div>)}
    </div>
  );
}

function ReviewView({ clubId, userId, leader }: { clubId: string; userId: string | null; leader: boolean }) {
  const [period, setPeriod] = useState('week');
  const [r, setR] = useState<Review | null>(null);
  const [err, setErr] = useState('');
  const load = () => { setR(null); api<Review>('GET', `/api/reviews?clubId=${clubId}&period=${period}${userId ? `&userId=${userId}` : ''}`).then((x) => { setR(x); setErr(''); }).catch((x) => setErr(errText(x))); };
  useEffect(load, [clubId, userId, period]);
  const assign = async (rec: Rec) => {
    try {
      await api('POST', '/api/recommendations', { clubId, userId: r!.user.id, title: rec.title, details: rec.details, metric: rec.metric, higherBetter: rec.higherBetter, target: rec.target, days: 7, origin: 'ai' });
      toast('Рекомендация назначена на неделю: сотрудник получил задачу, результат проверится сам'); load();
    } catch (x) { toast(errText(x)); }
  };
  if (err) return <div className="err">{err}</div>;
  if (!r) return <p className="muted">Загрузка…</p>;
  const w = r.work;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div><b>{r.user.name}</b> <span className="small muted">{r.user.role}</span><div className="small muted">{period === 'week' ? 'Недельный обзор' : 'Месячная сводка'}: {d2(r.from)} — {d2(r.to)}</div></div>
          <div className="tabs" role="group" aria-label="Период"><button aria-pressed={period === 'week'} onClick={() => setPeriod('week')}>Неделя</button><button aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Месяц</button></div>
        </div>
        <div className="small muted">{r.basis} Уверенность: {r.confidence}.</div>
        {!r.enoughData && <div className="small">Данных за период недостаточно для выводов: обзор покажет больше, когда появятся звонки, встречи и продажи.</div>}
      </div>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
        <div className="card"><b style={{ color: 'var(--ok)' }}>{period === 'week' ? 'Сильные места' : 'Что удалось'}</b>
          {r.strengths.length ? <ul className="small" style={{ margin: '6px 0 0 18px', padding: 0 }}>{r.strengths.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="small muted">Пока не видно</p>}</div>
        <div className="card"><b style={{ color: 'var(--bad)' }}>{period === 'week' ? 'Где проседает' : 'Что не удалось'}</b>
          {r.weaknesses.length ? <ul className="small" style={{ margin: '6px 0 0 18px', padding: 0 }}>{r.weaknesses.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="small muted">Явных провалов нет</p>}</div>
      </div>
      {r.recommendations.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <b>{period === 'week' ? 'Рекомендации на неделю' : 'Что сделать для роста'}</b>
          {r.recommendations.map((x) => (
            <div key={x.metric} className="row between" style={{ gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div style={{ flex: '1 1 300px' }}><b className="small">{x.title}</b><div className="small muted">{x.details}{x.baseline !== null && x.target !== null ? ` Цель: ${fmt(x.target)}, сейчас ${fmt(x.baseline)}.` : ''}</div></div>
              {leader && <button className="btn sm" onClick={() => assign(x)}>Назначить на неделю</button>}
            </div>))}
        </div>)}
      <div className="card">
        <b>Показатели и норма</b> <span className="small muted">норма — на {r.workDays} {w.hasSchedule ? 'отработанных смен' : 'рабочих дн.'}</span>
        <div className="tbl"><table><thead><tr><th>Показатель</th><th>Факт</th><th>Норма</th><th>В среднем по отделу</th></tr></thead>
          <tbody>{r.metrics.map((m) => <tr key={m.id}><td>{m.name}</td><td className={`num ${m.ok === false ? 'bad' : m.ok ? 'ok' : ''}`}>{fmt(m.value)}</td><td className="num">{fmt(m.norm)}</td><td className="num">{fmt(m.peersAvg)}</td></tr>)}</tbody></table></div>
      </div>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
        <div className="card small" style={{ display: 'grid', gap: 4 }}><b>Воронка</b>
          {r.funnel.mine ? <>
            <span>Лидов {r.funnel.mine.leads} → связались {r.funnel.mine.contacted} → встреча {r.funnel.mine.meetingSet} → пришли {r.funnel.mine.meetingDone} → купили {r.funnel.mine.bought}</span>
            <span className="muted">Конверсия в покупку {fmt(r.funnel.mine.boughtPct)} % · по отделу {fmt(r.funnel.dept.boughtPct)} %</span></> : <span className="muted">Лидов за период не было</span>}</div>
        <div className="card small" style={{ display: 'grid', gap: 4 }}><b>Рабочее время и эфир</b>
          {w.hasSchedule ? <span>Смен {w.workedShifts} из {w.shifts}, отработано {h(w.workedMin)} из {h(w.plannedMin)}{w.lateCount ? `, опозданий ${w.lateCount}` : ''}</span> : <span className="muted">График в клубе не ведётся</span>}
          <span>Записанных разговоров {w.recordedCalls}, эфир {w.airMin} мин</span>
          {w.callsPerHour !== null && <span>Звонков в час работы {w.callsPerHour}{w.peersCallsPerHour !== null ? ` · у коллег ${w.peersCallsPerHour}` : ''}</span>}</div>
        <div className="card small" style={{ display: 'grid', gap: 4 }}><b>Личный план {r.plan.month.split('-').reverse().join('.')}</b>
          {r.plan.rows.length ? r.plan.rows.map((p) => <span key={p.category}>{p.name}: {rub(p.factKop)} из {p.planKop === null ? '—' : rub(p.planKop)} <span className={`chip ${LIGHT[p.light]?.[1] ?? ''}`}>{LIGHT[p.light]?.[0]}</span></span>) : <span className="muted">Личный план не задан</span>}</div>
        <div className="card small" style={{ display: 'grid', gap: 4 }}><b>Разговоры по стандарту</b>
          {r.quality.evaluated ? <><span>Оценено {r.quality.evaluated}, средняя оценка {r.quality.avg} %</span>{r.quality.weakItems.map((i) => <span key={i.text} className="muted">Пропускается: «{i.text}» — {i.missed} из {i.total}</span>)}</> : <span className="muted">Оценённых разговоров нет</span>}</div>
      </div>
    </div>
  );
}

function Recs({ clubId, leader, meId }: { clubId: string; leader: boolean; meId: string }) {
  const [rows, setRows] = useState<RecRow[] | null>(null);
  const [mark, setMark] = useState<{ id: string; mark: 'done' | 'failed'; comment: string } | null>(null);
  const load = () => api<RecRow[]>('GET', `/api/recommendations?clubId=${clubId}`).then(setRows).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, [clubId]);
  const save = async () => { if (!mark) return; try { await api('POST', `/api/recommendations/${mark.id}/mark`, { mark: mark.mark, comment: mark.comment }); setMark(null); load(); toast('Отметка сохранена: руководитель её увидит'); } catch (x) { toast(errText(x)); } };
  const cancel = async (id: string) => { try { await api('POST', `/api/recommendations/${id}/cancel`); load(); } catch (x) { toast(errText(x)); } };
  if (!rows) return <p className="muted">Загрузка…</p>;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <b>{leader ? 'Рекомендации сотрудникам' : 'Мои рекомендации'}</b>
      <div className="small muted">Рекомендацию назначает руководитель из обзора сотрудника. В срок система сама сверяет показатель: выполнена или нет и как он изменился. Отметка сотрудника и его комментарий видны руководителю.</div>
      {!rows.length && <p className="small muted">Рекомендаций пока нет.</p>}
      {rows.map((r) => (
        <div key={r.id} className="item" style={{ display: 'grid', gap: 4 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
            <b className="small">{leader ? `${r.userName}: ` : ''}{r.title}</b>
            <span className={`chip ${RST[r.status]?.[1] ?? ''}`}>{RST[r.status]?.[0]}</span>
          </div>
          <div className="small muted">{r.details ? `${r.details} ` : ''}Срок {d2(r.startsOn)} — {d2(r.dueOn)}. {r.authorName ? `Назначил ${r.authorName}${r.origin === 'ai' ? ' по предложению обзора' : ''}.` : ''}</div>
          <div className="small">Было {fmt(r.baseline)}{r.target !== null ? ` · цель ${fmt(r.target)}` : ''}{r.result !== null ? ` · стало ${fmt(r.result)}` : ''}
            {r.userMark && <> · сотрудник: <b>{r.userMark === 'done' ? 'сделал' : 'не получилось'}</b>{r.userComment ? ` — «${r.userComment}»` : ''}</>}</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {r.userId === meId && r.status === 'open' && !r.userMark && <>
              <button className="btn sm pri" onClick={() => setMark({ id: r.id, mark: 'done', comment: '' })}>Сделал</button>
              <button className="btn sm" onClick={() => setMark({ id: r.id, mark: 'failed', comment: '' })}>Не получилось</button></>}
            {leader && r.status === 'open' && <button className="btn sm" onClick={() => cancel(r.id)}>Отменить</button>}
          </div>
          {mark?.id === r.id && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <input placeholder={mark.mark === 'failed' ? 'Что помешало (обязательно)' : 'Комментарий (необязательно)'} value={mark.comment} onChange={(e) => setMark({ ...mark, comment: e.target.value })} style={{ flex: '1 1 220px' }} />
              <button className="btn sm pri" onClick={save}>Сохранить</button><button className="btn sm" onClick={() => setMark(null)}>Отмена</button>
            </div>)}
        </div>))}
    </div>
  );
}

type Forecast = { month: string; daysPassed: number; daysInMonth: number; total: PlanRow; rows: (PlanRow & { needClients: number | null; hot: number; warm: number; ending: number; avgCheckKop: number | null })[];
  recommendations: string[]; confidence: string; basis: string; alert: { createdAt: string; deficitKop: number } | null };
function Forecast({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const [f, setF] = useState<Forecast | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  useEffect(() => { setF(null); api<Forecast>('GET', `/api/plan/forecast?clubId=${clubId}`).then(setF).catch((x) => toast(errText(x))); }, [clubId]);
  if (!f) return <p className="muted">Загрузка…</p>;
  const t = f.total;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <b>Прогноз на {f.month.split('-').reverse().join('.')}: прошло {f.daysPassed} из {f.daysInMonth} дней</b>
        {t.planKop === null ? <p className="small muted" style={{ margin: 0 }}>План на месяц не задан: задайте его в «Рабочий стол» → «План продаж».</p> : (
          <div className="kpis">
            <div className="card kpi-c"><span className="lbl">План</span><b className="num">{rub(t.planKop)}</b></div>
            <div className="card kpi-c"><span className="lbl">Факт</span><b className="num">{rub(t.factKop)}</b><span className="small muted">{fmt(t.percent)} %</span></div>
            <div className="card kpi-c"><span className="lbl">Прогноз</span><b className="num">{rub(t.forecastKop)}</b></div>
            <div className="card kpi-c"><span className="lbl">Не хватит</span><b className={`num ${t.deficitKop ? 'bad' : 'ok'}`}>{t.deficitKop ? rub(t.deficitKop) : 'план будет выполнен'}</b></div>
          </div>)}
        <div className="small muted">{f.basis} Уверенность: {f.confidence}.{f.alert ? ` Руководителям отправлена задача ${dt(f.alert.createdAt)}.` : ''}</div>
      </div>
      {f.recommendations.length > 0 && <div className="card" style={{ display: 'grid', gap: 6 }}><b>Что делать</b>{f.recommendations.map((r) => <p key={r} className="small" style={{ margin: 0 }}>{r}</p>)}</div>}
      <div className="card">
        <div className="tbl"><table><thead><tr><th>Категория</th><th>План</th><th>Факт</th><th>Прогноз</th><th>Не хватит</th><th className="hide-narrow">Продаж нужно</th><th className="hide-narrow">Горячих / тёплых</th><th></th></tr></thead>
          <tbody>{f.rows.map((r) => <tr key={r.category}><td>{r.name}</td><td className="num">{rub(r.planKop)}</td><td className="num">{rub(r.factKop)}</td><td className="num">{rub(r.forecastKop)}</td>
            <td className={`num ${r.deficitKop ? 'bad' : ''}`}>{r.deficitKop ? rub(r.deficitKop) : '—'}</td><td className="num hide-narrow">{r.needClients ?? '—'}</td><td className="num hide-narrow">{r.hot} / {r.warm}{r.ending ? ` · заканчиваются ${r.ending}` : ''}</td>
            <td><button className="btn sm" onClick={() => setDrill(r.category!)}>Клиенты</button></td></tr>)}</tbody></table></div>
      </div>
      {drill && <PlanDrill clubId={clubId} month={f.month} category={drill} userId={null} onClose={() => setDrill(null)} openPerson={openPerson} />}
    </div>
  );
}

type Drill = { categoryName: string; sales: { id: string; at: string; personId: string | null; person: string; product: string | null; seller: string; amountKop: number; kind: string }[]; totalKop: number; clients: number;
  candidates: { personId: string; name: string; kind: string; segment: string; score: number; offer: { name?: string; priceKop?: number } | null; owner: string | null }[] };
/** Цифра плана → оплаты и клиенты за ней, и кто может закрыть дефицит (AT36) */
export function PlanDrill({ clubId, month, category, userId, onClose, openPerson }: { clubId: string; month: string; category: string | null; userId: string | null; onClose: () => void; openPerson: (id: string) => void }) {
  const [d, setD] = useState<Drill | null>(null);
  useEffect(() => { api<Drill>('GET', `/api/plan/drill?clubId=${clubId}&month=${month}${category ? `&category=${category}` : ''}${userId ? `&userId=${userId}` : ''}`).then(setD).catch((x) => toast(errText(x))); }, [clubId, month, category, userId]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Из чего сложилась цифра">
        <div className="row between"><span className="lbl">План {month.split('-').reverse().join('.')}</span><button className="btn sm" onClick={onClose}>Закрыть</button></div>
        {!d ? <p className="muted">Загрузка…</p> : <>
          <h1 style={{ margin: 0 }}>{d.categoryName}: {rub(d.totalKop)}</h1>
          <div className="small muted">{d.sales.length} оплат, {d.clients} клиентов. Нажмите на клиента, чтобы открыть карточку.</div>
          <div className="tbl"><table><thead><tr><th>Когда</th><th>Клиент</th><th>Тариф</th><th className="hide-narrow">Продал</th><th>Сумма</th></tr></thead>
            <tbody>{d.sales.map((s) => <tr key={s.id}><td className="small">{s.at.slice(8, 10)}.{s.at.slice(5, 7)} {s.at.slice(11)}</td>
              <td>{s.personId ? <button className="btn sm" onClick={() => openPerson(s.personId!)}>{s.person}</button> : s.person}</td><td className="small">{s.product ?? '—'}</td>
              <td className="small hide-narrow">{s.seller}</td><td className={`num ${s.amountKop < 0 ? 'bad' : ''}`}>{rub(s.amountKop)}</td></tr>)}
              {!d.sales.length && <tr><td colSpan={5} className="small muted">Оплат пока нет</td></tr>}</tbody></table></div>
          <h2 style={{ margin: '8px 0 0' }}>Кто может закрыть дефицит</h2>
          <div className="small muted">Горячие и тёплые клиенты по оценке ИИ с рассчитанным предложением.</div>
          {d.candidates.map((c) => (
            <div key={c.personId + c.kind} className="item row between" style={{ gap: 6, flexWrap: 'wrap' }}>
              <div><button className="btn sm" onClick={() => openPerson(c.personId)}>{c.name}</button> <span className={`chip ${c.segment === 'hot' ? 'bad' : ''}`}>{c.segment === 'hot' ? 'горячий' : 'тёплый'} · {c.score}</span></div>
              <span className="small muted">{c.offer?.name ? `${c.offer.name}${c.offer.priceKop ? ` за ${rub(c.offer.priceKop)}` : ''}` : ''}{c.owner ? ` · ${c.owner}` : ''}</span>
            </div>))}
          {!d.candidates.length && <p className="small muted">Подходящих клиентов в оценке ИИ нет.</p>}
        </>}
      </aside>
    </div>
  );
}

function QualityView({ clubId }: { clubId: string }) {
  const [q, setQ] = useState<{ from: string; to: string; byUser: { userId: string; name: string; n: number; avg: number }[]; items: { text: string; total: number; ok: number; pct: number | null }[];
    best: { callId: string; score: number; startedAt: string; userName: string; standardVersion: number }[]; suggestions: string[] } | null>(null);
  useEffect(() => { api<typeof q>('GET', `/api/quality?clubId=${clubId}`).then(setQ).catch((x) => toast(errText(x))); }, [clubId]);
  if (!q) return <p className="muted">Загрузка…</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card small muted">Оценка разговоров по чек-листу стандарта продаж клуба: РОП отмечает пункты в карточке разговора («Звонки» → разговор), после подключения ИИ-сервера оценку будет предлагать ИИ. Каждый звонок оценивается по версии стандарта на момент звонка. Период: {d2(q.from)} — {d2(q.to)}.</div>
      {!q.byUser.length ? <div className="card"><p className="small muted" style={{ margin: 0 }}>Оценённых разговоров пока нет.</p></div> : <>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
          <div className="card"><b>По сотрудникам</b><div className="tbl"><table><tbody>{q.byUser.map((u) => <tr key={u.userId}><td>{u.name}</td><td className="num">{u.avg} %</td><td className="small muted">{u.n} разг.</td></tr>)}</tbody></table></div></div>
          <div className="card"><b>По пунктам стандарта</b><div className="tbl"><table><tbody>{q.items.map((i) => <tr key={i.text}><td className="small">{i.text}</td><td className={`num ${(i.pct ?? 0) < 50 ? 'bad' : ''}`}>{i.pct} %</td></tr>)}</tbody></table></div></div>
        </div>
        <div className="card"><b>Лучшие разговоры — для разбора с отделом</b>{q.best.map((b) => <div key={b.callId} className="small">{dt(b.startedAt)} · {b.userName} · {b.score} % (стандарт v{b.standardVersion})</div>)}</div>
        {q.suggestions.length > 0 && <div className="card"><b>Предложения по стандарту</b>{q.suggestions.map((s) => <p key={s} className="small" style={{ margin: '4px 0 0' }}>{s}</p>)}</div>}
      </>}
    </div>
  );
}

/** Оценка разговора по чек-листу стандарта (в карточке разговора) */
export function CallEvaluation({ callId }: { callId: string }) {
  const [d, setD] = useState<{ standard: { versionNo: number; items: { id: string; text: string; weight: number }[] }; evaluations: { source: string; items: { id: string; text: string; weight: number; ok: boolean | null; comment?: string }[]; score: number; standardVersion: number; by: string | null; at: string; engine: string | null }[]; canEvaluate: boolean } | null>(null);
  const [marks, setMarks] = useState<Record<string, boolean | null>>({});
  const load = () => api<NonNullable<typeof d>>('GET', `/api/calls/${callId}/evaluation`).then((x) => { setD(x); const rop = x.evaluations.find((e) => e.source === 'rop'); setMarks(Object.fromEntries((rop?.items ?? x.standard.items.map((i) => ({ ...i, ok: null }))).map((i) => [i.id, i.ok ?? null]))); }).catch(() => setD(null));
  useEffect(() => { load(); }, [callId]);
  if (!d || (!d.canEvaluate && !d.evaluations.length)) return null;
  const rop = d.evaluations.find((e) => e.source === 'rop'); const ai = d.evaluations.find((e) => e.source === 'ai');
  const items = rop?.items ?? d.standard.items;
  const save = async () => { try { const r = await api<{ score: number }>('POST', `/api/calls/${callId}/evaluation`, { items: Object.entries(marks).map(([id, ok]) => ({ id, ok })) }); toast(`Оценка сохранена: ${r.score} %`); load(); } catch (x) { toast(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 6 }}>
      <h2 style={{ margin: 0 }}>Разговор по стандарту {rop ? `· ${rop.score} %` : ''}</h2>
      <div className="small muted">Чек-лист версии {rop?.standardVersion ?? d.standard.versionNo} — действовал в момент звонка.{ai ? ` Оценка ИИ: ${ai.score} %.` : ''}{rop?.by ? ` Оценил ${rop.by} ${dt(rop.at)}.` : ''}</div>
      {items.map((i) => {
        const aiItem = ai?.items.find((x) => x.id === i.id);
        return (
          <div key={i.id} className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="small" style={{ flex: '1 1 240px' }}>{i.text} <span className="muted">(вес {i.weight}){aiItem && aiItem.ok !== null ? ` · ИИ: ${aiItem.ok ? 'да' : 'нет'}` : ''}</span></span>
            {d.canEvaluate ? <span className="row" style={{ gap: 4 }}>
              <button className={`btn sm ${marks[i.id] === true ? 'pri' : ''}`} onClick={() => setMarks({ ...marks, [i.id]: true })}>да</button>
              <button className={`btn sm ${marks[i.id] === false ? 'pri' : ''}`} onClick={() => setMarks({ ...marks, [i.id]: false })}>нет</button>
            </span> : <span className="small">{marks[i.id] === null ? '—' : marks[i.id] ? 'да' : 'нет'}</span>}
          </div>);
      })}
      {d.canEvaluate && <div><button className="btn sm pri" disabled={!Object.values(marks).some((v) => v !== null)} onClick={save}>Сохранить оценку</button></div>}
    </div>
  );
}
