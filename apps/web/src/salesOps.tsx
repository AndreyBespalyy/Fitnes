// Отдел продаж: заявки и скорость ответа, списки обзвона, окно продлений, новички, воронка «где теряем», стоп-лист, дубли, настройки.
// Плюс блок «Обзвон» в карточке клиента (стоп-лист и теги) и кнопка «Беру в работу».
import { useEffect, useState } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';

const d2 = (s: string) => s.split('-').reverse().slice(0, 2).join('.');
const rubles = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;

type View = 'leads' | 'lists' | 'renewals' | 'newbies' | 'funnel' | 'base' | 'settings';

export function SalesOpsPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const views: [View, string, boolean][] = [
    ['leads', 'Заявки', true], ['lists', 'Списки обзвона', true], ['renewals', 'Окно продлений', true], ['newbies', 'Новички', true],
    ['funnel', 'Воронка и источники', can(me, 'dash.view')], ['base', 'Стоп-лист и дубли', can(me, 'crm.view_all')], ['settings', 'Настройки', true],
  ];
  const [view, setView] = useState<View>(() => (views.some((v) => v[0] === navParams('sales').view && v[2]) ? navParams('sales').view as View : 'leads'));
  const club = clubId !== 'all' ? clubId : clubs[0]?.id ?? '';
  if (!club) return <p className="muted">Нет клубов.</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {clubId === 'all' && <p className="small muted" style={{ margin: 0 }}>Показан клуб «{clubs[0]?.name}». Другой клуб выберите вверху.</p>}
      <div className="tabs" role="group" aria-label="Отдел продаж">{views.filter((v) => v[2]).map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{t}</button>)}</div>
      {view === 'leads' && <LeadsSpeed clubId={club} openPerson={openPerson} />}
      {view === 'lists' && <CallLists clubId={club} openPerson={openPerson} />}
      {view === 'renewals' && <Renewals clubId={club} openPerson={openPerson} />}
      {view === 'newbies' && <Newbies clubId={club} openPerson={openPerson} />}
      {view === 'funnel' && <Funnel clubId={club} />}
      {view === 'base' && <BaseCleanup clubId={club} openPerson={openPerson} />}
      {view === 'settings' && <Settings clubId={club} />}
    </div>
  );
}

function useLoad<T>(url: string, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); api<T>('GET', url).then(setData).catch((x) => setErr(errText(x))); };
  useEffect(() => { setData(null); load(); }, deps);
  return { data, err, load, setErr };
}
const Kpi = ({ label, value, cls = '' }: { label: string; value: string | number; cls?: string }) => <div className="card kpi-c"><span className="lbl">{label}</span><b className={`num ${cls}`}>{value}</b></div>;

/* ---------- Заявки ---------- */
type Waiting = { id: string; personId: string; name: string; source: string | null; manager: string | null; createdAt: string; waited: number; escalated: boolean; phone: string | null };
type SpeedRow = { id: string | null; name: string; total: number; inNorm: number; late: number; waiting: number; escalated: number; avgMinutes: number | null };
type LeadsData = { waiting: Waiting[]; speed: { day: string; norm: number; escalateAfter: number; total: SpeedRow; managers: SpeedRow[] } };

export function TakeLeadButton({ leadId, onDone, small = true }: { leadId: string; onDone?: () => void; small?: boolean }) {
  const take = async () => {
    try {
      const r = await api<{ already: boolean; takenBy?: string | null }>('POST', `/api/sales-ops/leads/${leadId}/take`);
      toast(r.already ? `Заявку уже взял(а) ${r.takenBy ?? 'коллега'}` : 'Заявка ваша: свяжитесь с клиентом');
      onDone?.();
    } catch (x) { toast(errText(x)); }
  };
  return <button className={`btn pri ${small ? 'sm' : ''}`} onClick={take}>Беру в работу</button>;
}

function LeadsSpeed({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const [day, setDay] = useState('');
  const { data, err, load } = useLoad<LeadsData>(`/api/sales-ops/leads?clubId=${clubId}${day ? `&day=${day}` : ''}`, [clubId, day]);
  useEffect(() => { const t = setInterval(load, 30_000); return () => clearInterval(t); }, [clubId, day]);
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const s = data.speed;
  return (
    <>
      <p className="muted" style={{ margin: 0, maxWidth: 780 }}>
        Новая заявка ждёт кнопку «Беру в работу». Через {s.norm} мин без неё менеджеру приходит напоминание, через {s.escalateAfter} мин — сигнал руководителю отдела
        и задача. Сигналы приходят в CRM: колокольчик «Уведомления» в шапке и push в приложении на телефоне.
      </p>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Ждут «Беру в работу» ({data.waiting.length})</h2>
        {data.waiting.length === 0 ? <p className="muted" style={{ margin: 0 }}>Все заявки разобраны.</p> : (
          <div className="tbl"><table>
            <thead><tr><th>Клиент</th><th>Источник</th><th>Ответственный</th><th>Ждёт</th><th></th></tr></thead>
            <tbody>{data.waiting.map((w) => (
              <tr key={w.id} className={w.waited > s.norm ? 'over' : ''}>
                <td><button className="link" onClick={() => openPerson(w.personId)}>{w.name}</button><div className="small muted">{w.phone ?? ''} · {dt(w.createdAt)}</div></td>
                <td>{w.source ?? '—'}</td><td>{w.manager ?? <span className="chip bad">не назначен</span>}</td>
                <td className={w.waited > s.norm ? 'bad num' : 'num'}>{Math.max(0, w.waited)} мин{w.escalated && <div className="chip bad">у РОПа</div>}</td>
                <td><TakeLeadButton leadId={w.id} onDone={load} /></td>
              </tr>))}</tbody>
          </table></div>)}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Скорость ответа за день</h2>
          <label className="f" style={{ maxWidth: 180 }}>День<input type="date" value={day || s.day} onChange={(e) => setDay(e.target.value)} /></label></div>
        <div className="kpis">
          <Kpi label="Заявок" value={s.total.total} /><Kpi label={`В норме (до ${s.norm} мин)`} value={s.total.inNorm} cls="ok" />
          <Kpi label="Дольше нормы" value={s.total.late} cls={s.total.late ? 'bad' : ''} /><Kpi label="Ушло РОПу" value={s.total.escalated} cls={s.total.escalated ? 'bad' : ''} />
          <Kpi label="В среднем, мин" value={s.total.avgMinutes ?? '—'} />
        </div>
        {s.managers.length > 0 && <div className="tbl"><table>
          <thead><tr><th>Менеджер</th><th>Заявок</th><th>В норме</th><th>Дольше нормы</th><th>Ждут</th><th>Ушло РОПу</th><th>Среднее, мин</th></tr></thead>
          <tbody>{s.managers.map((m) => <tr key={m.id ?? 'none'}><td>{m.name}</td><td className="num">{m.total}</td><td className="num ok">{m.inNorm}</td>
            <td className={`num ${m.late ? 'bad' : ''}`}>{m.late}</td><td className="num">{m.waiting}</td><td className="num">{m.escalated}</td><td className="num">{m.avgMinutes ?? '—'}</td></tr>)}</tbody>
        </table></div>}
      </div>
    </>
  );
}

/* ---------- Списки обзвона ---------- */
type CRow = { personId: string; name: string; phone: string | null; block: string; why: string; paidKop: number; lastVisit: string | null; tags: string[] };
type Block = { count: number; rows: CRow[] };
type ListsData = { managers: { id: string; name: string; blocks: Record<string, Block> }[]; recurrent: Block | null; zero: Block | null; excluded: Record<string, number> | null;
  unassigned: number; limit: number; blocks: Record<string, string> };

function Rows({ rows, openPerson }: { rows: CRow[]; openPerson: (id: string) => void }) {
  if (!rows.length) return <p className="muted small" style={{ margin: 0 }}>Пусто.</p>;
  return <div className="tbl"><table>
    <thead><tr><th>Клиент</th><th>Почему</th><th>Оплатил</th><th>Последний визит</th><th>Теги</th></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.personId}><td><button className="link" onClick={() => openPerson(r.personId)}>{r.name}</button><div className="small muted">{r.phone}</div></td>
      <td className="small">{r.why}</td><td className="num">{rubles(r.paidKop)}</td><td>{r.lastVisit ? d2(r.lastVisit) : '—'}</td>
      <td>{r.tags.map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>{t}</span>)}</td></tr>)}</tbody>
  </table></div>;
}

function CallLists({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const { data, err } = useLoad<ListsData>(`/api/sales-ops/call-lists?clubId=${clubId}`, [clubId]);
  const [who, setWho] = useState('');
  const [block, setBlock] = useState('new');
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Собираю списки…</p>;
  const sel = who || data.managers[0]?.id || (data.recurrent ? 'recurrent' : '');
  const m = data.managers.find((x) => x.id === sel);
  const special = sel === 'recurrent' ? data.recurrent : sel === 'zero' ? data.zero : null;
  const ex = (w: string, f = 'xlsx') => `/api/sales-ops/call-lists/export?clubId=${clubId}&who=${w}&format=${f}`;
  return (
    <>
      <p className="muted" style={{ margin: 0, maxWidth: 780 }}>
        База клуба разложена по менеджерам: новые, продления, обычная база. Отдельно — рекурренты (подписка с автосписанием) и те, кто не заплатил ни рубля.
        Не попадают: стоп-лист (сотрудники, переезд, отказ, «просил не звонить» и т. п.), действующие клиенты вне окна продлений, члены клуба с 0–2 посещениями, карточки без телефона и склеенные дубли.
      </p>
      <div className="tabs" role="group" aria-label="Чей список">
        {data.managers.map((x) => <button key={x.id} aria-pressed={sel === x.id} onClick={() => setWho(x.id)}>{x.name} ({Object.values(x.blocks).reduce((a, b) => a + b.count, 0)})</button>)}
        {data.recurrent && <button aria-pressed={sel === 'recurrent'} onClick={() => setWho('recurrent')}>Рекурренты ({data.recurrent.count})</button>}
        {data.zero && <button aria-pressed={sel === 'zero'} onClick={() => setWho('zero')}>Ни рубля ({data.zero.count})</button>}
      </div>
      {m && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="row between"><h2>{m.name}</h2><span className="row" style={{ gap: 6 }}><a className="btn sm pri" href={ex(m.id)}>Файл менеджеру (Excel)</a><a className="btn sm" href={ex(m.id, 'csv')}>CSV</a></span></div>
          <div className="tabs" role="group" aria-label="Блок">{['new', 'renewal', 'base', 'zero'].map((b) => <button key={b} aria-pressed={block === b} onClick={() => setBlock(b)}>{data.blocks[b]} ({m.blocks[b]?.count ?? 0})</button>)}</div>
          <Rows rows={m.blocks[block]?.rows ?? []} openPerson={openPerson} />
          {(m.blocks[block]?.count ?? 0) > data.limit && <p className="small muted" style={{ margin: 0 }}>На экране первые {data.limit}. Весь список — в файле.</p>}
        </div>)}
      {special && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="row between"><h2>{sel === 'recurrent' ? 'Рекурренты' : 'Не заплатили ни рубля'}</h2><a className="btn sm" href={ex(sel)}>Excel</a></div>
          <Rows rows={special.rows} openPerson={openPerson} />
        </div>)}
      {data.excluded && Object.keys(data.excluded).length > 0 && (
        <div className="card small"><b>Не попали в обзвон:</b> {Object.entries(data.excluded).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} — ${v}`).join(' · ')}
          {data.unassigned > 0 && <> · <span className="bad">без менеджера — {data.unassigned} (в клубе нет менеджеров)</span></>}</div>)}
    </>
  );
}

/* ---------- Окно продлений ---------- */
type RenewRow = { id: string; personId: string; name: string; product: string; endsOn: string; phone: string | null; owner: string | null; lastCallAt: string | null; visits30: number; expired: boolean; called: boolean };
function Renewals({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const { data, err } = useLoad<{ from: string; to: string; list: RenewRow[]; stats: { total: number; thisMonth: number; notCalled: number } }>(`/api/sales-ops/renewals?clubId=${clubId}`, [clubId]);
  const [onlyNot, setOnlyNot] = useState(false);
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const rows = data.list.filter((r) => !onlyNot || !r.called);
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>Абонементы, которые заканчиваются с {d2(data.from)} по {d2(data.to)}, а клиент ещё не продлил. «Звонили» — звонок или выполненная задача-звонок за 14 дней. Каждое утро в 9:00 РОП и менеджеры получают сводку.</p>
      <div className="kpis"><Kpi label="В окне" value={data.stats.total} /><Kpi label="В этом месяце" value={data.stats.thisMonth} /><Kpi label="Не звонили" value={data.stats.notCalled} cls={data.stats.notCalled ? 'bad' : ''} /></div>
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={onlyNot} onChange={(e) => setOnlyNot(e.target.checked)} />Только кому не звонили</label>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Клиент</th><th>Абонемент</th><th>Заканчивается</th><th>Визитов за 30 дн.</th><th>Ответственный</th><th>Звонили</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className={r.expired ? 'over' : ''}>
          <td><button className="link" onClick={() => openPerson(r.personId)}>{r.name}</button><div className="small muted">{r.phone}</div></td>
          <td>{r.product}</td><td className={r.expired ? 'bad' : ''}>{d2(r.endsOn)}{r.expired && <div className="small">уже закончился</div>}</td><td className="num">{r.visits30}</td>
          <td>{r.owner ?? '—'}</td><td>{r.called ? <span className="chip ok">{dt(r.lastCallAt)}</span> : <span className="chip warn">нет</span>}</td></tr>)}</tbody>
      </table></div>{rows.length === 0 && <p className="muted" style={{ margin: 0 }}>Пусто.</p>}</div>
    </>
  );
}

/* ---------- Новички ---------- */
type NewRow = { id: string; personId: string; name: string; product: string; startedOn: string; day: number; visits: number; phone: string | null; owner: string | null; firstMonthOver: boolean };
function Newbies({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const { data, err } = useLoad<{ days: number; minVisits: number; total: number; list: NewRow[] }>(`/api/sales-ops/newbies?clubId=${clubId}`, [clubId]);
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>Купили впервые за последние {data.days} дней, а в первый месяц сходили меньше {data.minVisits} раз. Список уходит РОПу по понедельникам в 10:00.</p>
      <div className="kpis"><Kpi label={`Новичков за ${data.days} дн.`} value={data.total} /><Kpi label="Мало визитов" value={data.list.length} cls={data.list.length ? 'bad' : ''} /></div>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Клиент</th><th>Абонемент</th><th>С</th><th>День</th><th>Визитов в 1-й месяц</th><th>Менеджер</th></tr></thead>
        <tbody>{data.list.map((r) => <tr key={r.id}><td><button className="link" onClick={() => openPerson(r.personId)}>{r.name}</button><div className="small muted">{r.phone}</div></td>
          <td>{r.product}</td><td>{d2(r.startedOn)}</td><td>{r.day}{!r.firstMonthOver && <div className="small muted">месяц идёт</div>}</td><td className="num bad">{r.visits}</td><td>{r.owner ?? '—'}</td></tr>)}</tbody>
      </table></div>{data.list.length === 0 && <p className="muted" style={{ margin: 0 }}>Таких нет.</p>}</div>
    </>
  );
}

/* ---------- Воронка ---------- */
type Step = { key: string; title: string; count: number; fromPrev: number | null; lost: number };
type FunnelGroup = { name: string; steps: Step[]; conversion: number | null; worstStep: string | null };
function Funnel({ clubId }: { clubId: string }) {
  const [by, setBy] = useState<'source' | 'manager'>('source');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const { data, err } = useLoad<{ from: string; to: string; total: FunnelGroup; noSource: { count: number; share: number }; groups: FunnelGroup[] }>(
    `/api/sales-ops/funnel?clubId=${clubId}&by=${by}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, [clubId, by, from, to]);
  const [pv, setPv] = useState<string | null>(null);
  const preview = (kind: string) => api<{ text: string }>('GET', `/api/sales-ops/digest-preview?clubId=${clubId}&kind=${kind}`).then((r) => setPv(r.text)).catch((x) => toast(errText(x)));
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const max = data.total.steps[0].count || 1;
  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="f">С<input type="date" value={from || data.from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f">По<input type="date" value={to || data.to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="tabs" role="group" aria-label="Разрез"><button aria-pressed={by === 'source'} onClick={() => setBy('source')}>По каналам</button><button aria-pressed={by === 'manager'} onClick={() => setBy('manager')}>По менеджерам</button></div>
      </div>
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <h2>Где теряем людей{data.total.worstStep ? `: больше всего на шаге «${data.total.worstStep}»` : ''}</h2>
        {data.total.steps.map((s, i) => (
          <div key={s.key} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 150px', gap: 8, alignItems: 'center' }}>
            <span>{s.title}</span>
            <div style={{ background: 'var(--line, #e5e5e5)', borderRadius: 4, height: 18 }}><div style={{ width: `${Math.round((s.count / max) * 100)}%`, background: 'var(--acc, #2a7)', height: '100%', borderRadius: 4 }} /></div>
            <span className="num">{s.count}{i > 0 && s.fromPrev !== null && <span className={`small ${s.fromPrev < 50 ? 'bad' : 'muted'}`}> · {s.fromPrev} % · −{s.lost}</span>}</span>
          </div>))}
        <p className="small muted" style={{ margin: 0 }}>Один человек считается один раз (по первому обращению за период). Кто дошёл или купил без отметки встречи, засчитан и на предыдущих шагах. «Дошёл» — встреча с отметкой «пришёл» или проход в клуб после обращения.</p>
      </div>
      <div className={`card small ${data.noSource.count ? 'warn' : ''}`}>Без источника: <b>{data.noSource.count}</b> обращений ({data.noSource.share} %). {data.noSource.count ? 'Попросите менеджеров указывать, откуда пришёл клиент.' : ''}</div>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>{by === 'source' ? 'Канал' : 'Менеджер'}</th>{data.total.steps.map((s) => <th key={s.key}>{s.title}</th>)}<th>Конверсия</th><th>Теряем на шаге</th></tr></thead>
        <tbody>{data.groups.map((g) => <tr key={g.name}><td>{g.name}</td>{g.steps.map((s) => <td key={s.key} className="num">{s.count}</td>)}<td className="num">{g.conversion ?? '—'} %</td><td className="small">{g.worstStep ?? '—'}</td></tr>)}</tbody>
      </table></div></div>
      <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => preview('weekly')}>Как выглядит недельная сводка</button><button className="btn sm" onClick={() => preview('marketing')}>Как выглядит маркетинг-дайджест</button></div>
      {pv && <pre className="card small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{pv}</pre>}
      <p className="small muted" style={{ margin: 0 }}>Недельная сводка уходит собственнику, управляющему и РОПу в понедельник в 9:00, маркетинг-дайджест — собственнику и управляющему в 20:00. Приходят в колокольчик «Уведомления» в шапке CRM.</p>
    </>
  );
}

/* ---------- Стоп-лист и дубли ---------- */
type Dup = { why: string; main: DupP; dup: DupP };
type DupP = { id: string; name: string; birthDate: string | null; phone: string | null; memberships: number; visits: number; createdAt: string; segment: string };
function BaseCleanup({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const blocks = useLoad<{ list: { personId: string; name: string; title: string; until: string | null; comment: string | null; createdAt: string; createdBy: string | null }[];
    byReason: { reason: string; title: string; count: number }[]; tags: { tag: string; auto: boolean; count: number }[] }>(`/api/sales-ops/blocks?clubId=${clubId}`, [clubId]);
  const dups = useLoad<{ pairs: Dup[] }>(`/api/sales-ops/duplicates?clubId=${clubId}`, [clubId]);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); dups.load(); } catch (x) { toast(errText(x)); } finally { setBusy(false); } };
  const recompute = () => act(() => api('POST', '/api/sales-ops/tags/recompute', { clubId }).then(() => blocks.load()), 'Теги пересчитаны');
  const P = ({ p }: { p: DupP }) => <div><button className="link" onClick={() => openPerson(p.id)}>{p.name}</button><div className="small muted">{p.phone ?? ''}{p.birthDate ? ` · ${p.birthDate.split('-').reverse().join('.')}` : ''} · абонементов {p.memberships}, визитов {p.visits} · с {dt(p.createdAt)}</div></div>;
  return (
    <>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Возможные дубли {dups.data ? `(${dups.data.pairs.length})` : ''}</h2>
        <p className="small muted" style={{ margin: 0 }}>Совпадает телефон или e-mail, либо ФИО и дата рождения. При склейке всё (абонементы, оплаты, визиты, звонки, переписка) переходит на основную карточку, дубль скрывается. Отменить склейку нельзя.</p>
        {dups.err && <div className="err">{dups.err}</div>}
        {dups.data && (dups.data.pairs.length === 0 ? <p className="muted" style={{ margin: 0 }}>Дублей не найдено.</p> : (
          <div className="tbl"><table><thead><tr><th>Основная</th><th>Дубль</th><th>Почему</th><th></th></tr></thead>
            <tbody>{dups.data.pairs.map((x) => <tr key={x.main.id + x.dup.id}><td><P p={x.main} /></td><td><P p={x.dup} /></td><td className="small">{x.why}</td>
              <td><div className="row" style={{ gap: 4 }}>
                <button className="btn sm pri" disabled={busy} onClick={() => confirm(`Склеить «${x.dup.name}» в «${x.main.name}»? Отменить нельзя.`) && act(() => api('POST', '/api/sales-ops/merge', { mainId: x.main.id, dupId: x.dup.id }), 'Карточки склеены')}>Склеить</button>
                <button className="btn sm" disabled={busy} onClick={() => act(() => api('POST', '/api/sales-ops/merge', { mainId: x.dup.id, dupId: x.main.id }), 'Карточки склеены')} title="Оставить основной вторую карточку">Наоборот</button>
                <button className="btn sm" disabled={busy} onClick={() => act(() => api('POST', '/api/sales-ops/not-duplicate', { a: x.main.id, b: x.dup.id }), 'Больше не предложим')}>Разные люди</button>
              </div></td></tr>)}</tbody></table></div>))}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>Стоп-лист обзвона</h2>
        {blocks.err && <div className="err">{blocks.err}</div>}
        {blocks.data && <>
          <p className="small" style={{ margin: 0 }}>{blocks.data.byReason.length ? blocks.data.byReason.map((r) => `${r.title} — ${r.count}`).join(' · ') : 'Пока никого. Отметка ставится в карточке клиента, блок «Обзвон».'}</p>
          {blocks.data.list.length > 0 && <div className="tbl"><table><thead><tr><th>Клиент</th><th>Причина</th><th>Комментарий</th><th>Кто, когда</th></tr></thead>
            <tbody>{blocks.data.list.map((b) => <tr key={b.personId}><td><button className="link" onClick={() => openPerson(b.personId)}>{b.name}</button></td>
              <td>{b.title}{b.until ? ` до ${d2(b.until)}` : ''}</td><td className="small">{b.comment ?? ''}</td><td className="small">{b.createdBy ?? '—'}, {dt(b.createdAt)}</td></tr>)}</tbody></table></div>}
        </>}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Теги</h2><button className="btn sm" disabled={busy} onClick={recompute}>Пересчитать автотеги</button></div>
        <p className="small muted" style={{ margin: 0 }}>Автотеги система ставит каждую ночь: новичок, продление, рекуррент, ни рубля, бывший, мало визитов, лид. Свои теги менеджеры ставят в карточке.</p>
        {blocks.data && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{blocks.data.tags.map((t) => <span key={t.tag + t.auto} className={`chip ${t.auto ? 'acc' : ''}`}>{t.tag}: {t.count}</span>)}</div>}
      </div>
    </>
  );
}

/* ---------- Настройки ---------- */
type Sets = { remindMinutes: number; escalateMinutes: number; newbieDays: number; newbieMinVisits: number; excludeLowVisits: boolean };
function Settings({ clubId }: { clubId: string }) {
  const { data, err, setErr } = useLoad<{ settings: Sets; canManage: boolean }>(`/api/sales-ops/settings?clubId=${clubId}`, [clubId]);
  const [f, setF] = useState<Sets | null>(null);
  useEffect(() => { if (data) setF(data.settings); }, [data]);
  if (!data || !f) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const ro = !data.canManage;
  const num = (k: keyof Sets, label: string) => <label className="f">{label}<input type="number" disabled={ro} value={f[k] as number} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></label>;
  const save = async () => { setErr(''); try { await api('PUT', '/api/sales-ops/settings', { clubId, ...f }); toast('Сохранено'); } catch (x) { setErr(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
      {err && <div className="err">{err}</div>}
      {ro && <p className="small muted" style={{ margin: 0 }}>Менять может управляющий или собственник.</p>}
      <div className="grid2">{num('remindMinutes', 'Напоминание менеджеру, мин')}{num('escalateMinutes', 'Сигнал РОПу, мин')}{num('newbieDays', 'Новички: за сколько дней')}{num('newbieMinVisits', 'Новички: визитов в 1-й месяц меньше')}</div>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" disabled={ro} checked={f.excludeLowVisits} onChange={(e) => setF({ ...f, excludeLowVisits: e.target.checked })} />Не звонить членам клуба с 0–2 посещениями за всё время</label>
      {!ro && <div><button className="btn pri" onClick={save}>Сохранить</button></div>}
    </div>
  );
}

/* ---------- Блок «Обзвон» в карточке клиента ---------- */
type Flags = { block: { reason: string; title: string; until: string | null; comment: string | null; createdAt: string; createdBy: string | null } | null; tags: { tag: string; auto: boolean }[]; reasons: Record<string, string>; canEdit: boolean };
export function PersonCallFlags({ personId }: { personId: string }) {
  const [f, setF] = useState<Flags | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [comment, setComment] = useState('');
  const [tag, setTag] = useState('');
  const load = () => api<Flags>('GET', `/api/persons/${personId}/call-flags`).then(setF).catch(() => setF(null));
  useEffect(() => { load(); }, [personId]);
  if (!f) return null;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); setReason(''); setComment(''); setUntil(''); setTag(''); load(); } catch (x) { toast(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Обзвон</h2>
      {f.block ? (
        <div className="row between"><span><span className="chip bad">Не звонить: {f.block.title}{f.block.until ? ` до ${d2(f.block.until)}` : ''}</span>
          <span className="small muted"> {f.block.comment ?? ''} · {f.block.createdBy ?? ''}, {dt(f.block.createdAt)}</span></span>
          {f.canEdit && <button className="btn sm" onClick={() => act(() => api('DELETE', `/api/persons/${personId}/call-block`), 'Снова в обзвоне')}>Вернуть в обзвон</button>}</div>
      ) : f.canEdit && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="f">Убрать из обзвона<select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">— причина —</option>{Object.entries(f.reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {reason === 'postponed' && <label className="f">До<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>}
          {reason && <label className="f">Комментарий<input value={comment} onChange={(e) => setComment(e.target.value)} /></label>}
          {reason && <button className="btn sm" onClick={() => act(() => api('PUT', `/api/persons/${personId}/call-block`, { reason, until: until || undefined, comment }), 'Убран из обзвона')}>Сохранить</button>}
        </div>)}
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {f.tags.map((t) => <span key={t.tag} className={`chip ${t.auto ? 'acc' : ''}`} title={t.auto ? 'Ставит система' : 'Свой тег'}>{t.tag}
          {!t.auto && f.canEdit && <button className="link" aria-label={`Убрать тег ${t.tag}`} onClick={() => act(() => api('DELETE', `/api/persons/${personId}/tags/${encodeURIComponent(t.tag)}`), 'Тег убран')}> ×</button>}</span>)}
        {f.canEdit && <form className="row" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); if (tag.trim()) act(() => api('POST', `/api/persons/${personId}/tags`, { tag }), 'Тег добавлен'); }}>
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="новый тег" maxLength={40} style={{ width: 130 }} /><button className="btn sm">+</button></form>}
      </div>
    </div>
  );
}
