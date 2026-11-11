// Шаг 15. ИИ-помощник продаж: план дня, горячий список с предложением, теневой режим.
import { HintLine, UpsellList, useUpsell, type Hint } from './upsell.tsx';
import { DialButton } from './mobile.tsx';
import { useEffect, useState } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';

type Reason = { effect: '+' | '-'; text: string };
type HotRow = { personId: string; personName: string; kind: string; kindName: string; score: number; priority: number; segment: string; ownerId: string | null; ownerName: string | null;
  opportunityId: string | null; reasons: Reason[]; offer: { text: string; priceKop?: number } | null; model: string; computedAt: string; clubId: string; phone: string | null;
  nextTaskAt: string | null; lastContactAt: string | null };
type Model = { clubId: string; version: string; metrics: { samples?: number; won?: number; aucModel?: number | null; aucRules?: number | null; note?: string }; trainedAt: string };

const SEG: Record<string, [string, string]> = { hot: ['звонить первым', 'bad'], warm: ['после горячих', 'warn'], auto: ['автосообщение', ''], low: ['без срочности', ''], excluded: ['исключён', ''] };
const KINDS: [string, string][] = [['', 'Все задачи'], ['purchase', 'Покупка'], ['renewal', 'Продление'], ['return', 'Возврат'], ['churn', 'Удержание']];

export function HotPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const tabs: [string, string, boolean][] = [['day', 'План дня', true], ['list', 'Горячий список', true], ['upsell', 'Допродажи', clubId !== 'all' || clubs.length > 0], ['shadow', 'Теневой режим', can(me, 'ai.review')]];
  const [tab, setTab] = useState(() => (tabs.some((t) => t[0] === navParams('hot').tab && t[2]) ? navParams('hot').tab : 'day'));
  const club = clubId !== 'all' ? clubId : clubs[0]?.id ?? '';
  return (
    <>
      <div className="tabs" role="group" aria-label="ИИ-помощник">{tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{t}</button>)}</div>
      <p className="small muted" style={{ margin: 0 }}>Рекомендации ИИ: основание, период и уверенность указаны. Цены — по действующему прейскуранту клуба, ИИ их не меняет.</p>
      {tab === 'day' && club && <DayPlan clubId={club} openPerson={openPerson} />}
      {tab === 'list' && <HotList me={me} clubId={clubId} openPerson={openPerson} />}
      {tab === 'shadow' && <Shadow clubId={clubId} />}
      {tab === 'upsell' && club && <UpsellList clubId={club} openPerson={openPerson} />}
    </>
  );
}

function Reasons({ r }: { r: Reason[] }) {
  return <span className="small">{r.map((x, i) => <span key={i} className={x.effect === '+' ? 'num ok' : 'num bad'} style={{ marginRight: 10, fontFamily: 'inherit' }}>{x.effect === '+' ? '▲' : '▼'} {x.text}</span>)}</span>;
}

function Take({ row, onDone }: { row: HotRow; onDone: () => void }) {
  const take = async () => {
    try { await api('POST', '/api/ai/hot-list/take', { clubId: row.clubId, personId: row.personId, kind: row.kind }); toast('Задача на звонок поставлена на ближайший час'); onDone(); }
    catch (x) { toast(errText(x)); }
  };
  return <button className="btn sm pri" onClick={take}>Взять в работу</button>;
}

function HotItem({ r, openPerson, reload, showOwner, hints }: { r: HotRow; openPerson: (id: string) => void; reload: () => void; showOwner?: boolean; hints?: Hint[] }) {
  return (
    <div className="item" style={{ display: 'grid', gap: 4 }}>
      <div className="row between">
        <span><b>{r.personName}</b> <span className="chip">{r.kindName}</span> <span className={`chip ${SEG[r.segment]?.[1] ?? ''}`}>{SEG[r.segment]?.[0]}</span></span>
        <span className="small">приоритет <b className="num">{r.priority}</b></span>
      </div>
      <div className="hot-meter"><i style={{ width: `${r.priority}%` }} /></div>
      {r.reasons.length > 0 && <Reasons r={r.reasons} />}
      {r.offer?.text && <div className="small"><b>Предложение:</b> {r.offer.text}</div>}
      {hints && <HintLine hints={hints} />}
      <div className="small muted">{r.phone ?? 'телефона нет'}{r.lastContactAt ? ` · последний контакт ${dt(r.lastContactAt)}` : ' · ещё не общались'}{r.nextTaskAt ? ` · задача на ${dt(r.nextTaskAt)}` : ''}{showOwner ? ` · ${r.ownerName ?? 'общий список клуба'}` : ''}</div>
      <div className="row">{r.segment !== 'excluded' && <Take row={r} onDone={reload} />}{r.phone && r.segment !== 'excluded' && <DialButton personId={r.personId} />}<button className="btn sm" onClick={() => openPerson(r.personId)}>Карточка</button></div>
    </div>
  );
}

/* ---------- план дня ---------- */
type Day = {
  date: string; needs: { category: string; name: string; needKop: number; clients: number | null }[]; needKop: number | null; clients: number;
  targets: { calls: number | null; meetings: number | null }; tasks: { overdue: number; today: number; reviews: number }; meetings: { at: string; name: string }[];
  callFirst: HotRow[]; byKind: Record<string, number>; blocks: { from: string; to: string; title: string; detail: string }[]; basis: string[]; confidence: string; own: boolean;
};
function DayPlan({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const [d, setD] = useState<Day | null>(null);
  const [err, setErr] = useState('');
  const hintsOf = useUpsell(d?.callFirst);
  const load = () => api<Day>('GET', `/api/ai/day-plan?clubId=${clubId}`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [clubId]);
  if (!d) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  return (
    <>
      <div className="kpis">
        <div className="card"><span className="lbl">Нужно продать сегодня</span><b className="num">{d.needKop ? rub(d.needKop) : '—'}</b><span className="small">{d.needKop ? `≈ ${d.clients} клиент(ов) по среднему чеку` : 'личный план не задан или уже выполнен'}</span></div>
        <div className="card"><span className="lbl">Звонков на сегодня</span><b className="num">{d.targets.calls ?? '—'}</b><span className="small">по {d.own ? 'вашей' : 'клубной'} конверсии за 60 дней</span></div>
        <div className="card"><span className="lbl">Встреч на сегодня</span><b className="num">{d.meetings.length}{d.targets.meetings ? ` из ${d.targets.meetings}` : ''}</b><span className="small">назначено / нужно для плана</span></div>
        <div className="card"><span className="lbl">Задачи</span><b className="num">{d.tasks.overdue + d.tasks.today}</b><span className="small">просрочено {d.tasks.overdue}, на сегодня {d.tasks.today}</span></div>
      </div>
      {d.needs.length > 0 && <div className="card small">{d.needs.map((n) => <div key={n.category}>{n.name}: {rub(n.needKop)}{n.clients ? ` (≈ ${n.clients} кл.)` : ''}</div>)}</div>}
      <div className="card" style={{ display: 'grid', gap: 8 }}><h2>Как распределить день</h2>
        {d.blocks.length === 0 ? <p className="muted" style={{ margin: 0 }}>Рабочий день закончился или задач нет.</p> : d.blocks.map((b, i) => (
          <div key={i} className="row" style={{ alignItems: 'baseline', gap: 12 }}><span className="num small" style={{ minWidth: 92 }}>{b.from ? `${b.from}–${b.to}` : 'по времени'}</span><span><b>{b.title}</b><div className="small">{b.detail}</div></span></div>))}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}><h2>Звонить первым</h2>
        {d.callFirst.length === 0 ? <p className="muted" style={{ margin: 0 }}>Горячих клиентов сейчас нет: посмотрите тёплых в горячем списке.</p>
          : <div className="list">{d.callFirst.map((r) => <HotItem key={r.kind + r.personId} r={r} openPerson={openPerson} reload={load} hints={hintsOf(r.clubId, r.personId)} />)}</div>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Основание: {d.basis.join('; ')}. Уверенность: {d.confidence}.</p>
    </>
  );
}

/* ---------- горячий список ---------- */
function HotList({ me, clubId, openPerson }: { me: Me; clubId: string; openPerson: (id: string) => void }) {
  const [kind, setKind] = useState('');
  const [seg, setSeg] = useState('');
  const [mine, setMine] = useState(true);
  const [d, setD] = useState<{ rows: HotRow[]; models: Model[]; ms: number; computedAt: string | null } | null>(null);
  const load = () => {
    const qs = new URLSearchParams(); if (clubId !== 'all') qs.set('clubId', clubId); if (kind) qs.set('kind', kind); if (seg) qs.set('segment', seg); if (mine) qs.set('mine', '1');
    api<NonNullable<typeof d>>('GET', `/api/ai/hot-list?${qs}`).then(setD).catch(() => setD(null));
  };
  useEffect(() => { load(); }, [clubId, kind, seg, mine]);
  const recompute = async () => {
    if (clubId === 'all') { toast('Выберите клуб'); return; }
    try { await api('POST', '/api/ai/scores/recompute', { clubId }); toast('Оценки пересчитаны'); load(); } catch (x) { toast(errText(x)); }
  };
  const model = d?.models.find((m) => m.clubId === clubId) ?? d?.models[0];
  const hintsOf = useUpsell(d?.rows);
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="tabs" role="group">{KINDS.map(([k, t]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{t}</button>)}</div>
        <select value={seg} onChange={(e) => setSeg(e.target.value)} style={{ width: 'auto' }} aria-label="Сегмент">
          <option value="">Горячие и тёплые</option><option value="hot">Только горячие</option><option value="auto">Неприоритетные (автосообщения)</option><option value="excluded">Исключённые</option><option value="all">Все</option></select>
        {can(me, 'crm.view_all') && <div className="tabs" role="group"><button aria-pressed={mine} onClick={() => setMine(true)}>Мои</button><button aria-pressed={!mine} onClick={() => setMine(false)}>Весь клуб</button></div>}
        {can(me, 'ai.review') && <button className="btn sm" onClick={recompute}>Пересчитать</button>}
      </div>
      {!d ? <p className="muted">Загрузка…</p> : (<>
        <p className="small muted" style={{ margin: 0 }}>Список собран за {d.ms} мс, оценки обновлены {d.computedAt ? dt(d.computedAt) : '—'} (пересчёт каждые 15 минут). Модель: {model ? `${model.version}${model.metrics.aucModel ? `, качество на проверке AUC ${model.metrics.aucModel}` : ''}` : 'правила'}{model?.metrics.note ? `. ${model.metrics.note}` : ''}. {mine ? 'Ваши клиенты и общий список клуба.' : ''}</p>
        {d.rows.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>Клиентов в этом списке нет.</p></div>
          : <div className="list">{d.rows.map((r) => <HotItem key={r.kind + r.personId} r={r} openPerson={openPerson} reload={load} showOwner={!mine} hints={hintsOf(r.clubId, r.personId)} />)}</div>}
      </>)}
    </>
  );
}

/* ---------- теневой режим ---------- */
type ShadowData = {
  days: number; firstDay: string | null; enough: boolean;
  buyers: { bought: number; scored: number; listed: number; hot: number; listedPct: number | null; hotPct: number | null; byCategory: { cat: string; name: string; bought: number; scored: number; listed: number; listedPct: number | null }[] };
  lift: { hotRate: number | null; allRate: number | null; x: number | null; target: number; segments: { segment: string; n: number; won: number; rate: number | null; contacted: number; contactedPct: number | null }[] };
};
function Shadow({ clubId }: { clubId: string }) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(new Date(Date.now() - 14 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [d, setD] = useState<ShadowData | null>(null);
  useEffect(() => { api<ShadowData>('GET', `/api/ai/shadow?clubId=${clubId}&from=${from}&to=${to}`).then(setD).catch(() => setD(null)); }, [clubId, from, to]);
  const pct = (v: number | null) => (v === null ? '—' : `${String(v).replace('.', ',')} %`);
  return (
    <>
      <div className="card small" style={{ display: 'grid', gap: 4 }}>
        <b>Как проходит теневой режим</b>
        <span>Две недели менеджеры работают как обычно, а ИИ каждый день составляет списки. Потом сравниваем: кто купил и был ли он в списке, и покупают ли «горячие» чаще остальных. Цель из ТЗ: горячие покупают минимум в 2 раза чаще среднего.</span>
      </div>
      <div className="row"><label className="f">С<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="f">По<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      {!d ? <p className="muted">Загрузка…</p> : (<>
        {!d.enough && <p className="small" style={{ margin: 0 }}><span className="chip warn">Данных пока мало</span> Списки сохраняются с {d.firstDay ? d.firstDay.split('-').reverse().join('.') : 'сегодняшнего дня'}, накоплено дней: {d.days} из 14. Выводы можно делать после двух недель.</p>}
        <div className="kpis">
          <div className="card"><span className="lbl">Покупатели, которые были в списке</span><b className="num">{pct(d.buyers.listedPct)}</b><span className="small">из {d.buyers.scored} оценённых покупателей в горячем или тёплом списке были {d.buyers.listed}; всего покупок {d.buyers.bought}</span></div>
          <div className="card"><span className="lbl">Горячие покупают чаще среднего</span><b className={`num ${d.lift.x !== null ? (d.lift.x >= d.lift.target ? 'ok' : 'bad') : ''}`}>{d.lift.x !== null ? `в ${String(d.lift.x).replace('.', ',')} раза` : '—'}</b><span className="small">горячие {pct(d.lift.hotRate)}, все {pct(d.lift.allRate)}; цель — в {d.lift.target} раза</span></div>
        </div>
        <div className="card"><h2>По сегментам</h2><div className="tbl"><table>
          <thead><tr><th>Сегмент</th><th>Клиентов</th><th>Купили за 14 дней</th><th>Конверсия</th><th>Связались за 2 дня</th></tr></thead>
          <tbody>{d.lift.segments.map((s) => <tr key={s.segment}><td>{SEG[s.segment]?.[0] ?? s.segment}</td><td className="num">{s.n}</td><td className="num">{s.won}</td><td className="num">{pct(s.rate)}</td><td className="num">{pct(s.contactedPct)}</td></tr>)}</tbody></table></div></div>
        {d.buyers.byCategory.length > 0 && <div className="card"><h2>Покупки по категориям</h2><div className="tbl"><table>
          <thead><tr><th>Категория</th><th>Покупок</th><th>Были оценены</th><th>Были в списке</th></tr></thead>
          <tbody>{d.buyers.byCategory.map((c) => <tr key={c.cat}><td>{c.name}</td><td className="num">{c.bought}</td><td className="num">{c.scored}</td><td className="num">{c.listed} ({pct(c.listedPct)})</td></tr>)}</tbody></table></div></div>}
      </>)}
    </>
  );
}
