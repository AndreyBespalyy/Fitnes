// Возврат бывших клиентов (группы, кампании) и досрочное продление.
import { NewbieView } from './newbie.tsx';
import { ChurnView } from './churn.tsx';
import { useEffect, useState } from 'react';
import { api, type Club, type Me, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Group = { key: string; title: string; monthsFrom: number; monthsTo: number | null; count: number; message: number; call: number; products: [string, number][] };
type Campaign = { id: string; name: string; offer: string | null; status: string; createdAt: string; launchedAt: string | null; author: string | null;
  members: number; messages: number; calls: number; skipped: number; replied: number; bought: number; revenueKop: number };
type Preview = { total: number; message: number; call: number; skip: number; sample: { personId: string; name: string; leftOn: string; lastProduct: string; visits: number; channel: string; reason: string | null }[] };
type Early = { settings: { enabled: boolean; days: number; callWithoutMessenger: boolean; template: string }; total: number; renewed: number; percent: number | null;
  offers: { id: string; personId: string; name: string; product: string; amountKop: number | null; validUntil: string; status: string; reason: string | null; repliedAt: string | null; createdAt: string; renewed: boolean }[] };

const rub = (k: number) => `${Math.round(Number(k) / 100).toLocaleString('ru-RU')} ₽`;
const d2 = (s: string) => s.split('-').reverse().join('.');
const CH: Record<string, [string, string]> = { message: ['сообщение', 'ok'], call: ['звонок', 'warn'], skip: ['не связываемся', ''] };
const DEFAULT_TEXT = '{имя}, давно не виделись! В клубе {клуб} для вас {предложение}. Ответьте на это сообщение, и мы подберём удобное время.';

export function RetentionPage({ me: _me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [view, setView] = useState<'groups' | 'campaigns' | 'early' | 'surveys' | 'newbie' | 'churn'>(() => (['groups', 'campaigns', 'early', 'surveys', 'newbie', 'churn'].includes(navParams('retention').view) ? navParams('retention').view as 'groups' : 'groups'));
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [draft, setDraft] = useState<{ monthsFrom: number; monthsTo: number | null; product: string } | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const loadGroups = () => club && api<{ groups: Group[] }>('GET', `/api/retention/segments?clubId=${club}`).then((r) => setGroups(r.groups)).catch((x) => toast(errText(x)));
  const loadCampaigns = () => club && api<Campaign[]>('GET', `/api/retention/campaigns?clubId=${club}`).then(setCampaigns).catch((x) => toast(errText(x)));
  useEffect(() => { loadGroups(); loadCampaigns(); }, [club]);
  if (!club) return <p className="muted">Клубов нет.</p>;
  return (
    <>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="tabs" role="group" aria-label="Возврат клиентов">
          <button aria-pressed={view === 'groups'} onClick={() => setView('groups')}>Бывшие клиенты</button>
          <button aria-pressed={view === 'campaigns'} onClick={() => setView('campaigns')}>Кампании</button>
          <button aria-pressed={view === 'early'} onClick={() => setView('early')}>Досрочное продление</button>
          <button aria-pressed={view === 'surveys'} onClick={() => setView('surveys')}>Опросы после визита</button>
          <button aria-pressed={view === 'newbie'} onClick={() => setView('newbie')}>Новички: первые 30 дней</button>
          <button aria-pressed={view === 'churn'} onClick={() => setView('churn')}>Риск ухода</button>
        </div>
        {clubId === 'all' && <select value={club} onChange={(e) => setClub(e.target.value)}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      </div>
      {view === 'groups' && !draft && (
        <>
          <p className="muted" style={{ margin: 0, maxWidth: 760 }}>Бывшие клиенты — те, у кого был абонемент, а сейчас нет действующего. Сообщение уходит тем, у кого есть мессенджер и согласие на рекламные сообщения. Остальным менеджер звонит.</p>
          <div className="grid2">
            {groups?.map((g) => (
              <div key={g.key} className="card">
                <div className="row between"><h2>{g.title}</h2><b style={{ fontSize: 22 }}>{g.count}</b></div>
                <div className="small">сообщением: {g.message} · звонком: {g.call} · без связи: {g.count - g.message - g.call}</div>
                {g.products.length > 0 && <div className="small muted" style={{ margin: '4px 0' }}>Чаще всего были на: {g.products.map(([p, n]) => `${p} (${n})`).join(', ')}</div>}
                <button className="btn pri" disabled={!g.count} onClick={() => setDraft({ monthsFrom: g.monthsFrom, monthsTo: g.monthsTo, product: '' })}>Создать кампанию</button>
              </div>
            ))}
          </div>
        </>
      )}
      {view === 'groups' && draft && <NewCampaign club={club} init={draft} products={groups?.flatMap((g) => g.products.map((p) => p[0])) ?? []} onDone={(launched) => { setDraft(null); loadGroups(); loadCampaigns(); if (launched) setView('campaigns'); }} />}
      {view === 'campaigns' && (
        <div className="card">
          <div className="tbl"><table><thead><tr><th>Кампания</th><th>Статус</th><th className="num">Охват</th><th className="num hide-narrow">Сообщений / звонков</th><th className="num">Ответили</th><th className="num">Купили</th><th className="num">Выручка</th></tr></thead>
            <tbody>{campaigns.map((c) => (
              <tr key={c.id}>
                <td><button className="btn sm" onClick={() => setOpen(c.id)}>{c.name}</button><div className="small muted">{c.offer ?? ''}</div></td>
                <td><span className={`chip ${c.status === 'running' ? 'ok' : c.status === 'draft' ? 'warn' : ''}`}>{c.status === 'draft' ? 'черновик' : c.status === 'running' ? 'идёт' : 'завершена'}</span>
                  <div className="small muted">{c.launchedAt ? dt(c.launchedAt) : ''}</div></td>
                <td className="num">{c.members}</td><td className="num hide-narrow">{c.messages} / {c.calls}</td><td className="num">{c.replied}</td>
                <td className="num">{c.bought}{c.members ? <span className="small muted"> ({Math.round((c.bought * 100) / Math.max(1, c.members - c.skipped))}%)</span> : ''}</td>
                <td className="num">{rub(c.revenueKop)}</td>
              </tr>))}
              {!campaigns.length && <tr><td colSpan={7} className="small muted">Кампаний пока нет. Выберите группу на вкладке «Бывшие клиенты».</td></tr>}</tbody></table></div>
          <p className="small muted">Покупка засчитывается кампании, если клиент купил в течение 45 дней после сообщения или звонка.</p>
        </div>
      )}
      {view === 'early' && <EarlyView club={club} openPerson={openPerson} />}
      {view === 'surveys' && <SurveysView club={club} openPerson={openPerson} />}
      {view === 'newbie' && <NewbieView club={club} openPerson={openPerson} />}
      {view === 'churn' && <ChurnView club={club} openPerson={openPerson} />}
      {open && <CampaignDrawer id={open} onClose={() => { setOpen(null); loadCampaigns(); }} openPerson={openPerson} />}
    </>
  );
}

function NewCampaign({ club, init, products, onDone }: { club: string; init: { monthsFrom: number; monthsTo: number | null; product: string }; products: string[]; onDone: (launched: boolean) => void }) {
  const [f, setF] = useState({ name: '', offer: '', template: DEFAULT_TEXT, callWithoutMessenger: true, minVisits: '', ...init, monthsTo: init.monthsTo ?? '' as number | '' });
  const [pv, setPv] = useState<Preview | null>(null);
  const body = () => ({ clubId: club, ...f, monthsTo: f.monthsTo === '' ? null : Number(f.monthsTo), minVisits: f.minVisits ? Number(f.minVisits) : null, product: f.product || null });
  useEffect(() => { api<Preview>('POST', '/api/retention/preview', body()).then(setPv).catch((x) => toast(errText(x))); }, [f.monthsFrom, f.monthsTo, f.product, f.minVisits, f.callWithoutMessenger]);
  const save = async (launch: boolean) => {
    try {
      const { id } = await api<{ id: string }>('POST', '/api/retention/campaigns', body());
      if (launch) {
        if (!window.confirm(`Отправить ${pv?.message ?? 0} сообщений и поставить ${pv?.call ?? 0} звонков?`)) { toast('Кампания сохранена как черновик'); onDone(false); return; }
        const r = await api<{ message: number; call: number; skip: number }>('POST', `/api/retention/campaigns/${id}/launch`);
        toast(`Запущено: сообщений ${r.message}, звонков ${r.call}`);
      } else toast('Черновик сохранён');
      onDone(launch);
    } catch (x) { toast(errText(x)); }
  };
  const uniq = [...new Set(products)];
  return (
    <div className="grid2">
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <h2>Новая кампания</h2>
        <label className="f">Название<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Например: Возвращение осенью" /></label>
        <div className="row" style={{ gap: 6 }}>
          <label className="f">Ушли от, мес. назад<input type="number" min={0} value={f.monthsFrom} onChange={(e) => setF({ ...f, monthsFrom: Number(e.target.value) })} /></label>
          <label className="f">до (пусто — без границы)<input type="number" min={1} value={f.monthsTo} onChange={(e) => setF({ ...f, monthsTo: e.target.value === '' ? '' : Number(e.target.value) })} /></label>
        </div>
        <label className="f">Последний тариф<select className="f" value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}><option value="">любой</option>{uniq.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label className="f">Визитов за всё время не меньше<input type="number" min={0} value={f.minVisits} onChange={(e) => setF({ ...f, minVisits: e.target.value })} /></label>
        <label className="f">Предложение (подставляется вместо {'{предложение}'})<input value={f.offer} onChange={(e) => setF({ ...f, offer: e.target.value })} placeholder="первый месяц за 3 900 ₽" /></label>
        <label className="f">Текст сообщения<textarea rows={4} value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} /></label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={f.callWithoutMessenger} onChange={(e) => setF({ ...f, callWithoutMessenger: e.target.checked })} /> Тем, кому нельзя написать, поставить звонок менеджеру</label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn pri" onClick={() => save(true)}>Запустить</button>
          <button className="btn" onClick={() => save(false)}>Сохранить черновик</button>
          <button className="btn" onClick={() => onDone(false)}>Отмена</button>
        </div>
      </div>
      <div className="card">
        <h2>Кто попадёт: {pv?.total ?? '…'}</h2>
        {pv && <div className="small">сообщение: {pv.message} · звонок: {pv.call} · не связываемся: {pv.skip}</div>}
        <div className="tbl"><table><thead><tr><th>Клиент</th><th>Ушёл</th><th className="hide-narrow">Был на</th><th>Как</th></tr></thead>
          <tbody>{pv?.sample.map((r) => <tr key={r.personId}><td>{r.name}</td><td className="small">{d2(r.leftOn)}</td><td className="small hide-narrow">{r.lastProduct} · визитов {r.visits}</td>
            <td><span className={`chip ${CH[r.channel][1]}`}>{CH[r.channel][0]}</span>{r.reason && <div className="small muted">{r.reason}</div>}</td></tr>)}</tbody></table></div>
        {pv && pv.total > pv.sample.length && <p className="small muted">Показаны первые {pv.sample.length}.</p>}
      </div>
    </div>
  );
}

function CampaignDrawer({ id, onClose, openPerson }: { id: string; onClose: () => void; openPerson: (id: string) => void }) {
  const [c, setC] = useState<{ name: string; status: string; offer: string | null; members: { personId: string; name: string; leftOn: string; channel: string; reason: string | null; messageStatus: string | null; repliedAt: string | null; boughtAt: string | null; boughtKop: number | null; taskDoneAt: string | null; taskResult: string | null }[] } | null>(null);
  useEffect(() => { api<NonNullable<typeof c>>('GET', `/api/retention/campaigns/${id}`).then(setC).catch((x) => toast(errText(x))); }, [id]);
  const launch = async () => { try { const r = await api<{ message: number; call: number }>('POST', `/api/retention/campaigns/${id}/launch`); toast(`Запущено: сообщений ${r.message}, звонков ${r.call}`); onClose(); } catch (x) { toast(errText(x)); } };
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Кампания">
        <div className="row between"><span className="lbl">Кампания</span><button className="btn sm" onClick={onClose}>Закрыть</button></div>
        {!c ? <p className="muted">Загрузка…</p> : <>
          <h1 style={{ margin: 0 }}>{c.name}</h1>
          {c.offer && <div className="small">Предложение: {c.offer}</div>}
          {c.status === 'draft' && <button className="btn pri" onClick={launch}>Запустить</button>}
          <div className="tbl"><table><thead><tr><th>Клиент</th><th>Как</th><th>Итог</th></tr></thead>
            <tbody>{c.members.map((m) => <tr key={m.personId}>
              <td><button className="btn sm" onClick={() => openPerson(m.personId)}>{m.name}</button><div className="small muted">ушёл {d2(m.leftOn)}</div></td>
              <td><span className={`chip ${CH[m.channel][1]}`}>{CH[m.channel][0]}</span>{m.reason && <div className="small muted">{m.reason}</div>}</td>
              <td className="small">{m.boughtAt ? <span className="chip ok">купил · {rub(m.boughtKop ?? 0)}</span> : m.repliedAt ? 'ответил' : m.taskDoneAt ? `звонок: ${m.taskResult ?? 'сделан'}` : m.messageStatus === 'failed' ? 'не доставлено' : '—'}</td>
            </tr>)}</tbody></table></div>
        </>}
      </aside>
    </div>
  );
}

function EarlyView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [e, setE] = useState<Early | null>(null);
  const [s, setS] = useState<Early['settings'] | null>(null);
  const load = () => api<Early>('GET', `/api/retention/early?clubId=${club}`).then((r) => { setE(r); setS(r.settings); }).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, [club]);
  if (!e || !s) return <p className="muted">Загрузка…</p>;
  const save = async () => { try { await api('PUT', '/api/retention/early', { clubId: club, ...s }); toast('Сохранено'); load(); } catch (x) { toast(errText(x)); } };
  const ST: Record<string, [string, string]> = { sent: ['сообщение', 'ok'], call: ['звонок', 'warn'], skipped: ['пропущено', ''], used: ['продлил', 'ok'] };
  return (
    <div className="grid2">
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <h2>Досрочное продление</h2>
        <p className="small muted" style={{ margin: 0 }}>За выбранное число дней до конца абонемента клиенту приходит предложение продлиться по текущей цене. Цена держится до конца абонемента, даже если тариф подорожает: при продлении система сама поставит цену из предложения.</p>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={s.enabled} onChange={(x) => setS({ ...s, enabled: x.target.checked })} /> Предлагать досрочное продление</label>
        <label className="f">За сколько дней до конца<input type="number" min={7} max={90} value={s.days} onChange={(x) => setS({ ...s, days: Number(x.target.value) })} /></label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={s.callWithoutMessenger} onChange={(x) => setS({ ...s, callWithoutMessenger: x.target.checked })} /> Без мессенджера — задача менеджеру позвонить</label>
        <label className="f">Текст<textarea rows={5} value={s.template} onChange={(x) => setS({ ...s, template: x.target.value })} /></label>
        <button className="btn pri" onClick={save}>Сохранить</button>
      </div>
      <div className="card">
        <h2>Предложения: {e.total}, продлили {e.renewed}{e.percent != null ? ` (${e.percent}%)` : ''}</h2>
        <div className="tbl"><table><thead><tr><th>Клиент</th><th className="hide-narrow">Абонемент</th><th>Цена до</th><th>Статус</th></tr></thead>
          <tbody>{e.offers.map((o) => <tr key={o.id}>
            <td><button className="btn sm" onClick={() => openPerson(o.personId)}>{o.name}</button></td>
            <td className="small hide-narrow">{o.product}</td>
            <td className="small">{o.amountKop != null ? rub(o.amountKop) : '—'}<div className="muted">{d2(o.validUntil)}</div></td>
            <td><span className={`chip ${o.renewed ? 'ok' : ST[o.status][1]}`}>{o.renewed ? 'продлил' : ST[o.status][0]}</span>{o.repliedAt && !o.renewed && <div className="small">ответил</div>}{o.reason && <div className="small muted">{o.reason}</div>}</td>
          </tr>)}
            {!e.offers.length && <tr><td colSpan={4} className="small muted">Предложений пока не было</td></tr>}</tbody></table></div>
      </div>
    </div>
  );
}

type SurveySettings = { enabled: boolean; firstVisit: boolean; day30: boolean; quarterly: boolean; question: string; lowMax: number; highMin: number; taskHours: number; yandexUrl: string | null; gisUrl: string | null };
type SurveyData = {
  settings: SurveySettings;
  report: { index: number | null; n: number; sent: number; answeredPct: number | null; promoters: number; passives: number; detractors: number;
    byKind: { kind: string; index: number | null; n: number }[]; byStaff: { name: string; index: number | null; n: number }[] };
  recent: { id: string; personId: string; name: string; kind: string; status: string; score: number | null; comment: string | null; createdAt: string; answeredAt: string | null; reviewAskedAt: string | null; staff: string | null }[];
};
const KIND: Record<string, string> = { first_visit: 'после первого визита', day30: 'через месяц', quarterly: 'раз в квартал' };
const iso = (d: Date) => d.toISOString().slice(0, 10);
function SurveysView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<SurveyData | null>(null);
  const [s, setS] = useState<SurveySettings | null>(null);
  const load = () => api<SurveyData>('GET', `/api/surveys?clubId=${club}&from=${iso(new Date(Date.now() - days * 86400_000))}&to=${iso(new Date())}`).then((r) => { setD(r); setS(r.settings); }).catch((x) => toast(errText(x)));
  useEffect(() => { load(); }, [club, days]);
  if (!d || !s) return <p className="muted">Загрузка…</p>;
  const save = async () => { try { await api('PUT', '/api/surveys/settings', { clubId: club, ...s }); toast('Сохранено'); load(); } catch (x) { toast(errText(x)); } };
  const sign = (v: number | null) => (v == null ? '—' : v > 0 ? `+${v}` : String(v));
  const r = d.report;
  return (
    <div className="grid2">
      <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <div className="card">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2>Индекс лояльности</h2>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}><option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option><option value={365}>год</option></select>
          </div>
          <div className="row" style={{ gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 32 }} className={r.index == null ? '' : r.index >= 50 ? 'ok' : r.index >= 0 ? 'warn' : 'bad'}>{sign(r.index)}</b>
            <span className="small muted">оценок {r.n} из {r.sent}{r.answeredPct != null ? ` (${r.answeredPct}%)` : ''} · довольных {r.promoters} · нейтральных {r.passives} · недовольных {r.detractors}</span>
          </div>
          <p className="small muted">Индекс = доля поставивших {s.highMin}–10 минус доля поставивших 0–{s.lowMax}, от −100 до +100.</p>
          <div className="small">{r.byKind.map((k) => <span key={k.kind} style={{ marginRight: 12 }}>{KIND[k.kind]}: <b>{sign(k.index)}</b> <span className="muted">({k.n})</span></span>)}</div>
          {r.byStaff.length > 0 && <div className="tbl" style={{ marginTop: 8 }}><table><thead><tr><th>Продавал абонемент</th><th className="num">Индекс</th><th className="num">Оценок</th></tr></thead>
            <tbody>{r.byStaff.map((x) => <tr key={x.name}><td>{x.name}</td><td className="num">{sign(x.index)}</td><td className="num">{x.n}</td></tr>)}</tbody></table></div>}
        </div>
        <div className="card">
          <h2>Ответы</h2>
          <div className="tbl"><table><thead><tr><th>Клиент</th><th>Оценка</th><th className="hide-narrow">Когда</th></tr></thead>
            <tbody>{d.recent.map((x) => <tr key={x.id}>
              <td><button className="btn sm" onClick={() => openPerson(x.personId)}>{x.name}</button><div className="small muted">{KIND[x.kind]}</div></td>
              <td>{x.score != null ? <b className={x.score <= s.lowMax ? 'bad' : x.score >= s.highMin ? 'ok' : ''}>{x.score}</b> : <span className="small muted">{x.status === 'expired' ? 'не ответил' : 'ждём ответа'}</span>}
                {x.comment && <div className="small">«{x.comment}»</div>}{x.reviewAskedAt && <div className="small muted">попросили отзыв</div>}</td>
              <td className="small hide-narrow">{dt(x.answeredAt ?? x.createdAt)}</td>
            </tr>)}
              {!d.recent.length && <tr><td colSpan={3} className="small muted">Опросов за период не было</td></tr>}</tbody></table></div>
        </div>
      </div>
      <div className="card" style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
        <h2>Настройки опроса</h2>
        <p className="small muted" style={{ margin: 0 }}>Клиент отвечает цифрой от 0 до 10 в мессенджере. Низкая оценка — задача управляющему разобраться, высокая — просьба оставить отзыв на картах. Один клиент получает не больше одного опроса в месяц; кто отказался от сообщений, опросы не получает.</p>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.enabled} onChange={(x) => setS({ ...s, enabled: x.target.checked })} /> Отправлять опросы</label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.firstVisit} onChange={(x) => setS({ ...s, firstVisit: x.target.checked })} /> После первого визита</label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.day30} onChange={(x) => setS({ ...s, day30: x.target.checked })} /> Через 30 дней после первой покупки</label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.quarterly} onChange={(x) => setS({ ...s, quarterly: x.target.checked })} /> Раз в квартал действующим клиентам</label>
        <label className="f">Текст вопроса<textarea rows={4} value={s.question} onChange={(x) => setS({ ...s, question: x.target.value })} /></label>
        <div className="row" style={{ gap: 8 }}>
          <label className="f">Недоволен — до<input type="number" min={0} max={9} value={s.lowMax} onChange={(x) => setS({ ...s, lowMax: Number(x.target.value) })} /></label>
          <label className="f">Доволен — от<input type="number" min={1} max={10} value={s.highMin} onChange={(x) => setS({ ...s, highMin: Number(x.target.value) })} /></label>
          <label className="f">Срок задачи, ч<input type="number" min={1} max={168} value={s.taskHours} onChange={(x) => setS({ ...s, taskHours: Number(x.target.value) })} /></label>
        </div>
        <label className="f">Ссылка на клуб в Яндекс Картах<input placeholder="https://yandex.ru/maps/org/…" value={s.yandexUrl ?? ''} onChange={(x) => setS({ ...s, yandexUrl: x.target.value })} /></label>
        <label className="f">Ссылка на клуб в 2ГИС<input placeholder="https://2gis.ru/…" value={s.gisUrl ?? ''} onChange={(x) => setS({ ...s, gisUrl: x.target.value })} /></label>
        {!s.yandexUrl && !s.gisUrl && <p className="small warn" style={{ margin: 0 }}>Пока ссылок нет, довольным клиентам просто приходит «спасибо» без просьбы об отзыве.</p>}
        <button className="btn pri" onClick={save}>Сохранить</button>
      </div>
    </div>
  );
}
