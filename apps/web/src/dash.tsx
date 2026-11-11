// Шаг 13. Рабочий стол из виджетов: дашборды собственника, управляющего, РОПа и менеджера,
// план продаж по клубу и менеджерам, нормы KPI, отчёт по продажам, словарь метрик, выгрузки.
import { PlanDrill } from './insights.tsx';
import { Fragment, useEffect, useState } from 'react';
import { api, can, type Club, type Go, type Me } from './api.ts';
import { errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';
import { ExportButton } from './privacy.tsx';

type Layout = { widgets: string[]; custom: boolean; role: string; available: { id: string; title: string; description: string }[]; canSetRoleDefaults: boolean; roles: string[] };
type Metric = { id: string; name: string; definition: string; formula: string; source: string; delay: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ROLE_NAME: Record<string, string> = { owner: 'Собственник', gm: 'Управляющий', rop: 'Руководитель ОП', manager: 'Менеджер ОП', fin: 'Финансист', desk: 'Администратор ресепшн', trainer: 'Тренер', admin: 'Администратор системы' };
const LIGHT: Record<string, [string, string]> = { green: ['в темпе', 'ok'], yellow: ['отстаёт', 'warn'], red: ['сильно отстаёт', 'bad'], none: ['план не задан', ''] };
const pctText = (v: number | null | undefined) => (v === null || v === undefined ? 'нет данных' : `${v.toLocaleString('ru-RU')} %`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? 'нет данных' : v.toLocaleString('ru-RU'));
const d2 = (s: string) => s.split('-').reverse().join('.');
const time = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const monthName = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addD = (s: string, n: number) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function DashPage({ me, clubs, clubId, openPerson, go: goTo, canGo, pickClub }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void; go: (g: Go) => void; canGo: (tab: string) => boolean; pickClub: (id: string) => void }) {
  // Переход только в разделы, доступные роли; иначе окно не кликабельно
  const nav = (g: Go) => (canGo(g.tab) ? () => goTo(g) : undefined);
  const [drill, setDrill] = useState<{ category: string | null; userId: string | null; month: string; clubId: string } | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [view, setView] = useState<'desk' | 'edit' | 'plan' | 'norms' | 'sales' | 'metrics'>('desk');
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [range, setRange] = useState<{ from: string; to: string }>({ from: `${todayIso().slice(0, 7)}-01`, to: todayIso() });
  const [tick, setTick] = useState(0);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<Layout>('GET', '/api/dash/layout').then(setLayout).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); api<Metric[]>('GET', '/api/dash/metrics').then(setMetrics).catch(() => {}); }, []);
  // Онлайн: виджеты пересчитываются каждые 60 секунд
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);
  if (!layout) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  const club = clubId === 'all' ? null : clubs.find((c) => c.id === clubId) ?? null;
  const manage = can(me, 'plan.manage');
  const dashView = can(me, 'dash.view');
  const tabs: [typeof view, string, boolean][] = [
    ['desk', 'Рабочий стол', true], ['plan', 'План продаж', dashView || manage], ['norms', 'Нормы KPI', dashView || manage],
    ['sales', 'Отчёт по продажам', dashView || can(me, 'crm.work') || can(me, 'finance.view')], ['metrics', 'Словарь метрик', true], ['edit', 'Настроить', true],
  ];
  const q = `clubId=${clubId}&month=${month}&from=${range.from}&to=${range.to}`;
  return (
    <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="tabs" role="group" aria-label="Рабочий стол">
          {tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{t}</button>)}
        </div>
        {view === 'desk' && (dashView || can(me, 'crm.work')) && <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
          <label className="row">Месяц плана <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 'auto' }} /></label>
          <label className="row">Период <select value="" onChange={(e) => {
            const t = todayIso(); const v = e.target.value;
            if (v === 'today') setRange({ from: t, to: t }); if (v === 'week') setRange({ from: addD(t, -6), to: t });
            if (v === 'month') setRange({ from: `${t.slice(0, 7)}-01`, to: t }); if (v === '30') setRange({ from: addD(t, -29), to: t });
          }} style={{ width: 'auto' }}><option value="">{d2(range.from)} — {d2(range.to)}</option><option value="today">Сегодня</option><option value="week">7 дней</option><option value="month">С начала месяца</option><option value="30">30 дней</option></select></label>
          <input type="date" aria-label="С" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} style={{ width: 'auto' }} />
          <input type="date" aria-label="По" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} style={{ width: 'auto' }} />
        </div>}
      </div>
      {drill && <PlanDrill clubId={drill.clubId} month={drill.month} category={drill.category} userId={drill.userId} onClose={() => setDrill(null)} openPerson={openPerson} />}
      {view === 'desk' && (layout.widgets.length ? layout.widgets.map((w) => <Widget key={`${w}-${clubId}`} id={w} q={q} tick={tick} metrics={metrics} openPerson={openPerson} nav={nav} pickClub={pickClub}
        onDrill={(x) => { const c = club?.id ?? (clubs.length === 1 ? clubs[0].id : null); if (!c) { toast('Выберите клуб вверху страницы, чтобы раскрыть цифру до клиентов'); return; } setDrill({ ...x, month, clubId: c }); }}
        title={layout.available.find((a) => a.id === w)?.title ?? w} />)
        : <div className="card"><p>На рабочем столе пока нет виджетов. Нажмите «Настроить» и выберите нужные.</p></div>)}
      {view === 'edit' && <LayoutEditor layout={layout} onSaved={() => { load(); setView('desk'); }} />}
      {view === 'plan' && (club ? <PlanEditor club={club} month={month} setMonth={setMonth} /> : <SelectClub />)}
      {view === 'norms' && (club ? <NormsEditor club={club} /> : <SelectClub />)}
      {view === 'sales' && <SalesReport clubId={clubId} />}
      {view === 'metrics' && <MetricsDictionary metrics={metrics} />}
    </>
  );
}
const SelectClub = () => <div className="card"><p>Выберите клуб в списке вверху страницы.</p></div>;

/* ---------- обёртка виджета ---------- */
type DrillFn = (x: { category: string | null; userId: string | null }) => void;
type Nav = { nav: (g: Go) => (() => void) | undefined; pickClub: (id: string) => void };
function Widget({ id, q, tick, title, metrics, onDrill, openPerson, nav, pickClub }: { id: string; q: string; tick: number; title: string; metrics: Metric[]; onDrill: DrillFn; openPerson?: (id: string) => void } & Nav) {
  const [d, setD] = useState<Any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Any>('GET', `/api/dash/widget/${id}?${q}`).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(errText(e))); }, [id, q, tick]);
  return (
    <section className="card dash-w" aria-label={title}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
        <span className="row small muted" style={{ gap: 6 }}>
          {d && <span title="Цифры пересчитываются каждые 60 секунд">обновлено {time(d.updatedAt)}</span>}
          <a className="btn sm" href={`/api/dash/widget/${id}/export?${q}&format=xlsx`}>XLSX</a>
          <a className="btn sm" href={`/api/dash/widget/${id}/export?${q}&format=csv`}>CSV</a>
        </span>
      </div>
      {err && <p className="err">{err}</p>}
      {!d && !err && <p className="muted">Загрузка…</p>}
      {d && <WidgetBody d={d} metrics={metrics} onDrill={onDrill} openPerson={openPerson} nav={nav} pickClub={pickClub} />}
    </section>
  );
}
const Hint = ({ id, metrics }: { id: string; metrics: Metric[] }) => {
  const m = metrics.find((x) => x.id === id);
  return m ? <span className="hint" tabIndex={0} title={`${m.definition}. Формула: ${m.formula}. Источник: ${m.source}. Обновление: ${m.delay}`}>?</span> : null;
};
/** Нажатие мышью или Enter/пробел с клавиатуры */
const clickable = (fn?: () => void) => (fn ? { role: 'button', tabIndex: 0, onClick: fn, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } } } : {});
const Kpi = ({ label, value, sub, metric, metrics, tone, onClick }: { label: string; value: string; sub?: string; metric?: string; metrics: Metric[]; tone?: string; onClick?: () => void }) => (
  <div className={`card kpi-c ${onClick ? 'click' : ''}`} {...clickable(onClick)}><span className="lbl">{label} {metric && <Hint id={metric} metrics={metrics} />}</span><b className={`num ${tone ?? ''}`}>{value}</b>{sub && <span className="small muted">{sub}</span>}{onClick && <span className="go" aria-hidden>›</span>}</div>
);
const Bar = ({ v }: { v: number | null }) => <div className="meter" aria-hidden><i style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%` }} /></div>;
const Light = ({ l }: { l: string }) => <span className={`chip ${LIGHT[l]?.[1] ?? ''}`}>{LIGHT[l]?.[0] ?? l}</span>;

function WidgetBody({ d, metrics, onDrill, openPerson, nav, pickClub }: { d: Any; metrics: Metric[]; onDrill: DrillFn; openPerson?: (id: string) => void } & Nav) {
  if (d.tiles) return <Panel d={d} nav={nav} openPerson={openPerson} />;
  if (d.widget === 'day') {
    const m = d.monthPlan;
    return <>
      <div className="kpis">
        <Kpi label="Продажи сегодня" value={rub(d.day.salesKop)} sub={`${d.day.salesCount} шт.`} metric="sales" metrics={metrics} onClick={nav({ tab: 'finance', p: { view: 'payments' } })} />
        <Kpi label="Поступления" value={rub(d.day.inflowKop)} metric="inflow" metrics={metrics} onClick={nav({ tab: 'finance', p: { view: 'payments' } })} />
        <Kpi label="Расходы" value={rub(d.day.expensesKop)} metric="expenses" metrics={metrics} onClick={nav({ tab: 'finance', p: { view: 'expenses' } })} />
        <Kpi label="Лиды сегодня" value={num(d.day.leads)} sub={`встреч на сегодня: ${d.day.meetings}`} metric="leads" metrics={metrics} onClick={nav({ tab: 'leads' })} />
        <Kpi label="Посещения" value={num(d.day.visits)} metric="visits" metrics={metrics} onClick={nav({ tab: 'access', p: { view: 'report' } })} />
        <Kpi label="Конверсия месяца" value={pctText(d.day.conversion)} metric="conversion" metrics={metrics} onClick={nav({ tab: 'board' })} />
      </div>
      <div className="kpis">
        <Kpi label={`План на ${monthName(d.month)}`} value={m.planKop === null ? 'план не задан' : rub(m.planKop)} metric="plan" metrics={metrics} onClick={() => onDrill({ category: null, userId: null })} />
        <Kpi label="Факт" value={rub(m.factKop)} sub={pctText(m.percent)} metric="percent" metrics={metrics} onClick={() => onDrill({ category: null, userId: null })} />
        <Kpi label="Прогноз" value={rub(m.forecastKop)} sub={m.deficitKop ? `не хватит ${rub(m.deficitKop)}` : m.planKop ? 'план будет выполнен' : undefined} metric="forecast" metrics={metrics} tone={m.deficitKop ? 'bad' : ''} onClick={nav({ tab: 'reviews', p: { tab: 'forecast' } })} />
        <Kpi label="Нужно сегодня" value={m.dayPlanKop === null ? '—' : rub(m.dayPlanKop)} metric="day_plan" metrics={metrics} onClick={nav({ tab: 'hot', p: { tab: 'day' } })} />
        <Kpi label="Долги клиентов" value={rub(d.day.debtsKop)} metric="debts" metrics={metrics} tone={d.day.debtsKop ? 'bad' : ''} onClick={nav({ tab: 'finance', p: { view: 'debts' } })} />
      </div>
    </>;
  }
  if (d.widget === 'clubs') return (
    <div className="tbl"><table><thead><tr><th>Клуб</th><th>Продажи сегодня</th><th>Лиды</th><th className="hide-narrow">Посещения</th><th>Факт месяца</th><th>План</th><th>Прогноз</th><th className="hide-narrow">Конверсия</th><th className="hide-narrow">Долги</th></tr></thead>
      <tbody>{d.perClub.map((c: Any) => <tr key={c.clubId}><td><button className="btn sm" title="Открыть рабочий стол клуба" onClick={() => pickClub(c.clubId)}><b>{c.name}</b></button></td><td className="num">{rub(c.salesKop)}</td><td className="num">{c.leads}</td><td className="num hide-narrow">{num(c.visits)}</td>
        <td className="num">{rub(c.factKop)}<Bar v={c.percent} /></td><td className="num">{c.planKop === null ? 'не задан' : `${rub(c.planKop)} · ${pctText(c.percent)}`}</td>
        <td className={`num ${c.deficitKop ? 'bad' : ''}`}>{rub(c.forecastKop)}</td><td className="num hide-narrow">{pctText(c.conversion)}</td><td className="num hide-narrow">{rub(c.debtsKop)}</td></tr>)}</tbody></table></div>
  );
  if (d.widget === 'plan' || d.widget === 'my_plan') {
    const t = d.total;
    return <>
      <p className="small muted" style={{ margin: 0 }}>{monthName(d.month)}: прошло {d.daysPassed} из {d.daysInMonth} дней. {d.personal ? 'Личный план; продажи засчитываются по проданным вами абонементам.' : ''}</p>
      <div className="kpis">
        <Kpi label="План" value={t.planKop === null ? 'план не задан' : rub(t.planKop)} sub={t.planClients ? `${t.planClients} клиентов` : undefined} metric="plan" metrics={metrics} />
        <Kpi label="Факт" value={rub(t.factKop)} sub={`${t.factClients} клиентов · ${pctText(t.percent)}`} metric="percent" metrics={metrics} />
        <Kpi label="Прогноз" value={rub(t.forecastKop)} metric="forecast" metrics={metrics} />
        <Kpi label="Дефицит" value={t.deficitKop === null ? '—' : rub(t.deficitKop)} metric="deficit" metrics={metrics} tone={t.deficitKop ? 'bad' : 'ok'} />
        <Kpi label="План на сегодня" value={t.dayPlanKop === null ? '—' : rub(t.dayPlanKop)} sub={`сегодня продано ${rub(t.todayKop)}`} metric="day_plan" metrics={metrics} />
      </div>
      <div className="tbl"><table><thead><tr><th>Категория</th><th>План</th><th>Факт</th><th>Выполнение</th><th className="hide-narrow">Клиенты, план / факт</th><th>Прогноз</th><th>Дефицит</th><th className="hide-narrow">На сегодня</th><th>Темп</th></tr></thead>
        <tbody>{d.rows.map((r: Any) => <tr key={r.category}><td><button className="btn sm" title="Раскрыть до клиентов" onClick={() => onDrill({ category: r.category, userId: null })}>{r.name}</button></td><td className="num">{r.planKop === null ? 'не задан' : rub(r.planKop)}</td><td className="num">{rub(r.factKop)}</td>
          <td className="num">{pctText(r.percent)}<Bar v={r.percent} /></td><td className="num hide-narrow">{r.planClients ?? '—'} / {r.factClients}</td><td className="num">{rub(r.forecastKop)}</td>
          <td className={`num ${r.deficitKop ? 'bad' : ''}`}>{r.deficitKop === null ? '—' : rub(r.deficitKop)}</td><td className="num hide-narrow">{r.dayPlanKop === null ? '—' : rub(r.dayPlanKop)}</td><td><Light l={r.light} /></td></tr>)}
          {d.rows.length === 0 && <tr><td colSpan={9} className="muted">План на этот месяц не задан и продаж ещё нет</td></tr>}</tbody></table></div>
    </>;
  }
  if (d.widget === 'team') return (
    <div className="tbl"><table><thead><tr><th>Менеджер</th><th>План</th><th>Факт</th><th>Выполнение</th><th>Прогноз</th><th className="hide-narrow">Дефицит</th><th className="hide-narrow">Нужно сегодня</th><th className="hide-narrow">Клиентов</th><th>Светофор <Hint id="light" metrics={metrics} /></th></tr></thead>
      <tbody>{d.rows.map((r: Any) => <tr key={r.userId}><td><button className="btn sm" title="Раскрыть до клиентов" onClick={() => onDrill({ category: null, userId: r.userId })}><b>{r.name}</b></button><div className="small muted">{r.role}{d.clubs.length > 1 ? ` · ${r.club}` : ''}</div></td>
        <td className="num">{r.planKop === null ? 'не задан' : rub(r.planKop)}</td><td className="num">{rub(r.factKop)}</td><td className="num">{pctText(r.percent)}<Bar v={r.percent} /></td>
        <td className="num">{rub(r.forecastKop)}</td><td className={`num hide-narrow ${r.deficitKop ? 'bad' : ''}`}>{r.deficitKop === null ? '—' : rub(r.deficitKop)}</td>
        <td className="num hide-narrow">{r.dayPlanKop === null ? '—' : rub(r.dayPlanKop)}</td><td className="num hide-narrow">{r.factClients}{r.planClients ? ` из ${r.planClients}` : ''}</td><td><Light l={r.light} /></td></tr>)}
        {d.rows.length === 0 && <tr><td colSpan={9} className="muted">В отделе продаж нет сотрудников</td></tr>}</tbody></table></div>
  );
  if (d.widget === 'funnel_sources' || d.widget === 'funnel_managers') {
    const Row = ({ r, total }: { r: Any; total?: boolean }) => <tr className={total ? 'total' : ''}><td>{total ? <b>{r.name}</b> : <button className="btn sm" onClick={nav(d.widget === 'funnel_sources' ? { tab: 'leads' } : { tab: 'reviews', p: { tab: 'team' } })}>{r.name}</button>}</td><td className="num">{r.leads}</td>
      <td className="num">{r.contacted} <span className="small muted">{pctText(r.contactedPct)}</span></td><td className="num">{r.meetingSet} <span className="small muted">{pctText(r.meetingSetPct)}</span></td>
      <td className="num">{r.meetingDone} <span className="small muted">{pctText(r.meetingDonePct)}</span></td><td className="num"><b>{r.bought}</b> <span className="small muted">{pctText(r.boughtPct)}</span><Bar v={r.boughtPct} /></td></tr>;
    return <>
      <p className="small muted" style={{ margin: 0 }}>Лиды за {d2(d.from)} — {d2(d.to)}. Процент — доля от числа лидов. <Hint id="conversion" metrics={metrics} /></p>
      <div className="tbl"><table><thead><tr><th>{d.widget === 'funnel_sources' ? 'Канал' : 'Менеджер'}</th><th>Лиды</th><th>Связались <Hint id="contacted" metrics={metrics} /></th><th>Встреча назначена</th><th>Встреча состоялась</th><th>Покупка</th></tr></thead>
        <tbody>{d.rows.map((r: Any) => <Row key={r.name} r={r} />)}<Row r={d.total} total /></tbody></table></div>
    </>;
  }
  if (d.widget === 'kpi' || d.widget === 'my_kpi') {
    if (d.widget === 'my_kpi') {
      const r = d.rows[0];
      return <><p className="small muted" style={{ margin: 0 }}>{d.from === d.to ? `За ${d2(d.from)}` : `${d2(d.from)} — ${d2(d.to)}`}. Норма — на рабочий день, её задаёт клуб.</p>
        <div className="kpis">{r.metrics.map((m: Any) => <Kpi key={m.id} label={m.name} value={num(m.value)} sub={m.norm === null ? undefined : `норма ${m.norm}`} metric={m.id} metrics={metrics}
          tone={m.status === 'red' ? 'bad' : m.status === 'green' ? 'ok' : ''} onClick={nav(KPI_GO[m.id] ?? { tab: 'reviews', p: { tab: 'my' } })} />)}</div></>;
    }
    return <>
      <p className="small muted" style={{ margin: 0 }}>{d2(d.from)} — {d2(d.to)} ({d.days} дн.). Под значением — норма за период. Звонки до подключения телефонии — выполненные задачи «позвонить».</p>
      <div className="tbl"><table><thead><tr><th>Сотрудник</th>{d.metrics.map((m: Any) => <th key={m.id}>{m.name} <Hint id={m.id} metrics={metrics} /></th>)}</tr></thead>
        <tbody>{d.rows.map((r: Any) => <tr key={r.userId}><td><button className="btn sm" title="Обзор сотрудника" onClick={nav({ tab: 'reviews', p: { tab: 'team', user: r.userId } })}><b>{r.name}</b></button>{d.clubs.length > 1 && <div className="small muted">{r.club}</div>}</td>
          {r.metrics.map((m: Any) => <td key={m.id} className={`num kpi-${m.status}`}>{num(m.value)}{m.norm !== null && <div className="small muted">{m.norm}</div>}</td>)}</tr>)}</tbody></table></div>
    </>;
  }
  if (d.widget === 'nps') {
    const tone = (v: number | null) => (v == null ? '' : v >= 50 ? 'ok' : v >= 0 ? 'warn' : 'bad');
    const sign = (v: number | null) => (v == null ? '—' : v > 0 ? `+${v}` : String(v));
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <b className={`num ${tone(d.total.index)}`} style={{ fontSize: 28 }}>{sign(d.total.index)}</b>
          <span className="small muted">оценок {d.total.n} из {d.total.sent} опросов{d.total.answeredPct != null ? ` (${d.total.answeredPct}%)` : ''} · довольных {d.total.promoters}, нейтральных {d.total.passives}, недовольных {d.total.detractors}</span>
        </div>
        {d.clubs.length > 1 && <div className="small">{d.clubs.map((c: Any) => <span key={c.id} style={{ marginRight: 12 }}>{c.name}: <b className={tone(c.index)}>{sign(c.index)}</b> <span className="muted">({c.n})</span></span>)}</div>}
        {d.byStaff.length > 0 && <div className="tbl"><table><thead><tr><th>Продавал абонемент</th><th className="num">Индекс</th><th className="num">Оценок</th></tr></thead>
          <tbody>{d.byStaff.map((x: Any) => <tr key={x.name}><td>{x.name}</td><td className={`num ${tone(x.index)}`}>{sign(x.index)}</td><td className="num">{x.n}</td></tr>)}</tbody></table></div>}
        {d.lows.length > 0 && <div style={{ display: 'grid', gap: 4 }}><b className="small">Низкие оценки</b>{d.lows.map((l: Any) => (
          <div key={l.id} className="item row between" style={{ gap: 8 }}>
            <span><button className="btn sm" onClick={() => openPerson?.(l.personId)}>{l.name}</button> <b className="bad">{l.score}</b>{l.comment && <div className="small muted">«{l.comment}»</div>}</span>
            <span className={`chip ${l.taskDoneAt ? 'ok' : 'warn'}`}>{l.taskDoneAt ? 'разобрались' : 'ждёт звонка'}</span>
          </div>))}</div>}
        {!d.total.n && <p className="small muted" style={{ margin: 0 }}>Оценок за период пока нет. Опросы уходят клиентам после первого визита, через месяц после покупки и раз в квартал.</p>}
      </div>
    );
  }
  if (d.widget === 'risks') return (
    <div className="risk-list">{d.items.map((i: Any) => (
      <div key={i.id} className={`item row between ${i.go && nav(i.go) ? 'click' : ''} ${i.value ? 'risk-on' : ''}`} style={{ gap: 8 }} {...clickable(i.go ? nav(i.go) : undefined)}>
        <span><b>{i.title}</b><div className="small muted">{i.hint}{d.clubs.length > 1 && i.value ? ` · ${i.perClub.filter((p: Any) => p.value).map((p: Any) => `${p.name}: ${p.value}`).join(', ')}` : ''}</div></span>
        <b className={`num ${i.value ? 'bad' : 'ok'}`} style={{ fontSize: 20 }}>{num(i.value)}{i.moneyKop ? <div className="small">{rub(i.moneyKop)}</div> : null}</b>
      </div>))}</div>
  );
  return null;
}

const KPI_GO: Record<string, Go> = { calls: { tab: 'calls' }, messages: { tab: 'chats', p: { filter: 'mine' } }, meetings_set: { tab: 'board' }, meetings_done: { tab: 'board' },
  sales: { tab: 'board' }, refusals: { tab: 'board' }, tasks_done: { tab: 'tasks' }, tasks_overdue: { tab: 'tasks' }, first_response: { tab: 'leads', p: { filter: 'noresponse' } } };

/* ---------- окна ролей: плитки и списки, всё кликабельно ---------- */
function Panel({ d, nav, openPerson }: { d: Any; nav: Nav['nav']; openPerson?: (id: string) => void }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="kpis">{d.tiles.map((x: Any) => (
        <div key={x.label} className={`card kpi-c ${x.go && nav(x.go) ? 'click' : ''}`} {...clickable(x.go ? nav(x.go) : undefined)}>
          <span className="lbl">{x.label}</span><b className={`num ${x.tone === 'ok' ? '' : x.tone ?? ''}`}>{typeof x.value === 'number' ? x.value.toLocaleString('ru-RU') : x.value}</b>
          {x.sub && <span className="small muted">{x.sub}</span>}{x.go && nav(x.go) && <span className="go" aria-hidden>›</span>}
        </div>))}</div>
      {d.lists.map((l: Any) => (
        <div key={l.title} style={{ display: 'grid', gap: 4 }}>
          <div className="row between"><b className="small">{l.title}</b>{l.more && <button className="btn sm" onClick={nav(l.more)}>Все ›</button>}</div>
          {l.rows.map((r: Any, i: number) => (
            <div key={i} className={`item row between ${r.personId || (r.go && nav(r.go)) ? 'click' : ''}`} style={{ gap: 8 }} {...clickable(r.personId ? () => openPerson?.(r.personId) : r.go ? nav(r.go) : undefined)}>
              <span><b>{r.text}</b>{r.sub && <div className="small muted">{r.sub}</div>}</span>
              {r.right && <span className={`small num ${r.tone === 'ok' ? '' : r.tone ?? ''}`} style={{ whiteSpace: 'nowrap' }}>{r.right}</span>}
            </div>))}
          {!l.rows.length && <p className="small muted" style={{ margin: 0 }}>{l.empty}</p>}
        </div>))}
    </div>
  );
}

/* ---------- настройка рабочего стола ---------- */
function LayoutEditor({ layout, onSaved }: { layout: Layout; onSaved: () => void }) {
  const [list, setList] = useState<string[]>(layout.widgets);
  const [role, setRole] = useState(layout.roles[0] ?? 'manager');
  const [err, setErr] = useState('');
  const move = (i: number, d: number) => { const l = [...list]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x); setList(l); };
  const save = async (body: unknown, url = '/api/dash/layout') => { setErr(''); try { await api('PUT', url, body); toast('Сохранено'); onSaved(); } catch (e) { setErr(errText(e)); } };
  const title = (id: string) => layout.available.find((a) => a.id === id)?.title ?? id;
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ margin: 0 }}>Мой рабочий стол</h2>
      <p className="small muted" style={{ margin: 0 }}>Отметьте нужные виджеты и расставьте их по порядку стрелками. {layout.custom ? 'Сейчас у вас свой набор.' : `Сейчас стандартный набор для роли «${ROLE_NAME[layout.role] ?? layout.role}».`}</p>
      {err && <p className="err">{err}</p>}
      <div style={{ display: 'grid', gap: 6 }}>
        {list.map((id, i) => <div key={id} className="item row between"><span><b>{i + 1}. {title(id)}</b></span><span className="row" style={{ gap: 4 }}>
          <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Выше">↑</button>
          <button className="btn sm" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">↓</button>
          <button className="btn sm" onClick={() => setList(list.filter((x) => x !== id))}>Убрать</button></span></div>)}
      </div>
      <b>Добавить</b>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
        {layout.available.filter((a) => !list.includes(a.id)).map((a) => <button key={a.id} className="opt" onClick={() => setList([...list, a.id])}><b>+ {a.title}</b><span className="small">{a.description}</span></button>)}
      </div>
      <div className="row"><button className="btn pri" onClick={() => save({ widgets: list })}>Сохранить</button>
        {layout.custom && <button className="btn" onClick={() => save({ widgets: null })}>Вернуть стандартный</button>}</div>
      {layout.canSetRoleDefaults && <div className="item row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="small">Сделать этот набор стандартным для роли</span>
        <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 'auto' }}>{layout.roles.map((r) => <option key={r} value={r}>{ROLE_NAME[r] ?? r}</option>)}</select>
        <button className="btn sm" onClick={() => save({ role, widgets: list }, '/api/dash/role-layout')}>Применить для роли</button>
        <span className="small muted">Сотрудник видит только виджеты, на которые у него есть права.</span></div>}
    </div>
  );
}

/* ---------- план продаж ---------- */
type T = { amountKop: number; avgCheckKop: number | null } | null;
type Plans = { month: string; categories: { id: string; name: string; suggestedAvgCheckKop: number | null }[]; club: Record<string, T>; managers: { userId: string; name: string; role: string; targets: Record<string, T> }[]; canEdit: boolean };
const toRub = (kop: number | null | undefined) => (kop === null || kop === undefined ? '' : String(kop / 100));
const toKop = (s: string) => (s.trim() === '' ? null : Math.round(Number(s.replace(/\s/g, '').replace(',', '.')) * 100));

function PlanEditor({ club, month, setMonth }: { club: Club; month: string; setMonth: (m: string) => void }) {
  const [p, setP] = useState<Plans | null>(null);
  const [form, setForm] = useState<Record<string, Record<string, { amount: string; avg: string }>>>({});
  const [err, setErr] = useState('');
  const [ai, setAi] = useState<{ rows: { category: string; name: string; suggestedKop: number | null; avgCheckKop: number | null; basis: string[] }[]; confidence: string; note: string } | null>(null);
  const load = () => api<Plans>('GET', `/api/plans?clubId=${club.id}&month=${month}`).then((x) => {
    setP(x);
    const f: typeof form = {};
    const fill = (key: string, t: Record<string, T>) => { f[key] = Object.fromEntries(x.categories.map((c) => [c.id, { amount: toRub(t[c.id]?.amountKop), avg: toRub(t[c.id]?.avgCheckKop) }])); };
    fill('club', x.club); x.managers.forEach((m) => fill(m.userId, m.targets));
    setForm(f);
  }).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); setAi(null); }, [club.id, month]);
  if (!p) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  const askAi = async () => { setErr(''); try { setAi(await api('GET', `/api/ai/plan-suggestion?clubId=${club.id}&month=${month}`)); } catch (e) { setErr(errText(e)); } };
  const applyAi = () => {
    if (!ai) return;
    const f = { ...form, club: { ...form.club } };
    for (const r of ai.rows) if (r.suggestedKop && f.club[r.category]) f.club[r.category] = { amount: toRub(r.suggestedKop), avg: f.club[r.category].avg || toRub(r.avgCheckKop) };
    setForm(f); toast('Расчёт ИИ подставлен в план клуба. Проверьте и сохраните');
  };
  const set = (key: string, cat: string, field: 'amount' | 'avg', v: string) => setForm({ ...form, [key]: { ...form[key], [cat]: { ...form[key][cat], [field]: v } } });
  const avgOf = (cat: string) => toKop(form.club[cat].avg) ?? p.categories.find((c) => c.id === cat)?.suggestedAvgCheckKop ?? null;
  const clients = (key: string, cat: string) => { const a = toKop(form[key][cat].amount); const avg = avgOf(cat); return a && avg ? Math.ceil(a / avg) : null; };
  const sumMgr = (cat: string) => p.managers.reduce((s, m) => s + (toKop(form[m.userId][cat].amount) ?? 0), 0);
  const save = async () => {
    setErr('');
    const pack = (key: string, withAvg: boolean) => Object.fromEntries(p.categories.map((c) => {
      const a = toKop(form[key][c.id].amount);
      if (a !== null && (!Number.isFinite(a) || a < 0)) throw new Error('Сумма указана неверно');
      return [c.id, a === null ? null : { amountKop: a, avgCheckKop: withAvg ? toKop(form[key][c.id].avg) : avgOf(c.id) }];
    }));
    try {
      await api('PUT', '/api/plans', { clubId: club.id, month, club: pack('club', true), managers: Object.fromEntries(p.managers.map((m) => [m.userId, pack(m.userId, false)])) });
      toast('План сохранён'); load();
    } catch (e) { setErr(e instanceof Error && !('status' in e) ? e.message : errText(e)); }
  };
  const ro = !p.canEdit;
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0 }}>План продаж: {club.name}</h2>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 'auto' }} /></div>
      <p className="small muted" style={{ margin: 0 }}>Суммы в рублях. Количество клиентов система считает сама: сумма ÷ плановый средний чек. Пустое поле — план по категории не задан. {ro ? 'Менять план может собственник или управляющий.' : ''}</p>
      {err && <p className="err">{err}</p>}
      <div className="tbl"><table><thead><tr><th>Категория</th><th>План клуба, ₽</th><th>Средний чек, ₽</th><th>Клиентов</th>{p.managers.map((m) => <th key={m.userId}>{m.name}<div className="small muted">{m.role}</div></th>)}<th>Распределено</th></tr></thead>
        <tbody>{p.categories.map((c) => {
          const clubKop = toKop(form.club[c.id].amount) ?? 0; const dist = sumMgr(c.id);
          return <tr key={c.id}><td><b>{c.name}</b></td>
            <td><input inputMode="decimal" aria-label={`План клуба: ${c.name}`} value={form.club[c.id].amount} disabled={ro} onChange={(e) => set('club', c.id, 'amount', e.target.value)} style={{ minWidth: 110 }} /></td>
            <td><input inputMode="decimal" aria-label={`Средний чек: ${c.name}`} value={form.club[c.id].avg} disabled={ro} placeholder={c.suggestedAvgCheckKop ? `≈ ${toRub(c.suggestedAvgCheckKop)}` : ''} onChange={(e) => set('club', c.id, 'avg', e.target.value)} style={{ minWidth: 90 }} /></td>
            <td className="num">{clients('club', c.id) ?? '—'}</td>
            {p.managers.map((m) => <td key={m.userId}><input inputMode="decimal" aria-label={`${m.name}: ${c.name}`} value={form[m.userId][c.id].amount} disabled={ro} onChange={(e) => set(m.userId, c.id, 'amount', e.target.value)} style={{ minWidth: 100 }} />
              {clients(m.userId, c.id) ? <div className="small muted">{clients(m.userId, c.id)} кл.</div> : null}</td>)}
            <td className={`num small ${clubKop && dist !== clubKop ? 'bad' : ''}`}>{dist ? rub(dist) : '—'}{clubKop && dist !== clubKop ? <div>{dist < clubKop ? `не распределено ${rub(clubKop - dist)}` : `больше плана на ${rub(dist - clubKop)}`}</div> : null}</td></tr>;
        })}</tbody></table></div>
      {!ro && <div className="row"><button className="btn pri" onClick={save}>Сохранить план</button>
        <button className="btn" onClick={() => {
          const f = { ...form };
          for (const c of p.categories) {
            const total = toKop(form.club[c.id].amount); if (!total || !p.managers.length) continue;
            const mgr = p.managers.filter((m) => m.role.startsWith('Менеджер')); const rop = p.managers.filter((m) => !m.role.startsWith('Менеджер'));
            for (const m of p.managers) {
              const share = mgr.length && rop.length ? (m.role.startsWith('Менеджер') ? 0.7 / mgr.length : 0.3 / rop.length) : 1 / p.managers.length;
              f[m.userId] = { ...f[m.userId], [c.id]: { ...f[m.userId][c.id], amount: String(Math.round((total * share) / 100)) } };
            }
          }
          setForm(f);
        }}>Распределить план клуба между менеджерами</button>
        <button className="btn" onClick={askAi}>Расчёт ИИ</button></div>}
      {ai && (
        <div className="item" style={{ display: 'grid', gap: 6 }}>
          <b>Расчётный план ИИ на {month} · уверенность {ai.confidence}</b>
          {ai.rows.map((r) => <div key={r.category} className="small"><b>{r.name}: {r.suggestedKop ? rub(r.suggestedKop) : 'данных недостаточно'}</b>{r.basis.length ? ` · ${r.basis.join('; ')}` : ''}</div>)}
          <div className="small muted">{ai.note}</div>
          {!ro && <div><button className="btn sm pri" onClick={applyAi}>Подставить в план клуба</button></div>}
        </div>)}
    </div>
  );
}

/* ---------- нормы KPI ---------- */
function NormsEditor({ club }: { club: Club }) {
  const [d, setD] = useState<{ metrics: { id: string; name: string }[]; norms: Record<string, number | null>; light: { green: number; yellow: number }; canEdit: boolean } | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [lg, setLg] = useState({ green: '100', yellow: '85' });
  const [err, setErr] = useState('');
  const load = () => api<NonNullable<typeof d>>('GET', `/api/kpi-norms?clubId=${club.id}`).then((x) => { setD(x); setLg({ green: String(x.light.green), yellow: String(x.light.yellow) }); setF(Object.fromEntries(x.metrics.map((m) => [m.id, x.norms[m.id] === null ? '' : String(x.norms[m.id])]))); }).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [club.id]);
  if (!d) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  const save = async () => {
    setErr('');
    try { await api('PUT', '/api/kpi-norms', { clubId: club.id, norms: Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v.replace(',', '.'))])), light: { green: Number(lg.green), yellow: Number(lg.yellow) } }); toast('Нормы сохранены'); load(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ margin: 0 }}>Нормы KPI: {club.name}</h2>
      <p className="small muted" style={{ margin: 0 }}>Норма на один рабочий день сотрудника отдела продаж. За период норма умножается на число дней; «просрочено задач» и «первый ответ» — предел на любой момент.</p>
      {err && <p className="err">{err}</p>}
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        {d.metrics.map((m) => <label key={m.id} className="f">{m.name}<input inputMode="decimal" value={f[m.id] ?? ''} disabled={!d.canEdit} onChange={(e) => setF({ ...f, [m.id]: e.target.value })} /></label>)}
      </div>
      <h3 style={{ margin: '6px 0 0' }}>Светофор плана</h3>
      <p className="small muted" style={{ margin: 0 }}>Сравнивается факт с планом на сегодняшний день месяца. Зелёный — не ниже первого порога, жёлтый — не ниже второго, иначе красный.</p>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        <label className="f">Зелёный от, %<input inputMode="numeric" value={lg.green} disabled={!d.canEdit} onChange={(e) => setLg({ ...lg, green: e.target.value })} /></label>
        <label className="f">Жёлтый от, %<input inputMode="numeric" value={lg.yellow} disabled={!d.canEdit} onChange={(e) => setLg({ ...lg, yellow: e.target.value })} /></label>
      </div>
      {d.canEdit && <div><button className="btn pri" onClick={save}>Сохранить нормы</button></div>}
    </div>
  );
}

/* ---------- отчёт по продажам ---------- */
function SalesReport({ clubId }: { clubId: string }) {
  const t = todayIso();
  const [f, setF] = useState({ from: `${t.slice(0, 7)}-01`, to: t, category: '' });
  const [d, setD] = useState<{ rows: Any[]; total: number } | null>(null);
  const [err, setErr] = useState('');
  const q = `clubId=${clubId}&from=${f.from}&to=${f.to}${f.category ? `&category=${f.category}` : ''}`;
  useEffect(() => { api<NonNullable<typeof d>>('GET', `/api/reports/sales?${q}`).then(setD).catch((e) => setErr(errText(e))); }, [q]);
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ margin: 0 }}>Отчёт по продажам</h2>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="row small">С <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={{ width: 'auto' }} /></label>
        <label className="row small">По <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={{ width: 'auto' }} /></label>
        <select aria-label="Категория" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={{ width: 'auto' }}>
          <option value="">Все категории</option><option value="new">Новые клиенты</option><option value="renewal">Продления</option><option value="return">Возобновление бывших</option><option value="subscription">Подписки</option></select>
        <ExportButton url={`/api/reports/sales?${q}&format=xlsx`}>Скачать XLSX</ExportButton><ExportButton url={`/api/reports/sales?${q}&format=csv`}>CSV</ExportButton>
      </div>
      {err && <p className="err">{err}</p>}
      {d && <>
        <span className="small">Операций: {d.rows.length}, итого {rub(d.total)}</span>
        <div className="tbl"><table><thead><tr><th>Когда</th><th>Клиент</th><th>Тариф</th><th className="hide-narrow">Категория</th><th>Менеджер</th><th>Сумма</th></tr></thead>
          <tbody>{d.rows.slice(0, 300).map((r, i) => <tr key={i}><td className="num">{r.at.slice(8, 10)}.{r.at.slice(5, 7)} {r.at.slice(11)}</td><td>{r.person}</td><td className="small">{r.product ?? '—'}</td>
            <td className="small hide-narrow">{r.categoryName}</td><td className="small">{r.seller}</td><td className={`num ${r.amountKop < 0 ? 'bad' : ''}`}>{rub(r.amountKop)}</td></tr>)}</tbody></table></div>
        {d.rows.length > 300 && <span className="small muted">Показаны первые 300 строк, полный список — в выгрузке.</span>}
      </>}
    </div>
  );
}

function MetricsDictionary({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>Словарь метрик</h2>
      <p className="small muted" style={{ margin: 0 }}>Как считается каждая цифра на рабочем столе. Если данных нет, система пишет «нет данных», а не ноль.</p>
      <div className="tbl"><table><thead><tr><th>Показатель</th><th>Что это</th><th className="hide-narrow">Формула</th><th className="hide-narrow">Источник</th><th className="hide-narrow">Обновление</th></tr></thead>
        <tbody>{metrics.map((m) => <Fragment key={m.id}><tr><td><b>{m.name}</b></td><td className="small">{m.definition}</td><td className="small hide-narrow">{m.formula}</td><td className="small hide-narrow">{m.source}</td><td className="small hide-narrow">{m.delay}</td></tr></Fragment>)}</tbody></table></div>
    </div>
  );
}
