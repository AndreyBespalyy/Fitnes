// Защита базы клиентов, персональные данные (152-ФЗ) и состояние системы.
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, can, navParams, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';

/** Скачивание выгрузки. Если сервер отказал (например, нужно согласование управляющего), показываем причину, а не пустую страницу. */
export async function downloadFile(url: string) {
  let res: Response;
  try { res = await fetch(url, { credentials: 'same-origin' }); } catch { toast('Нет связи с сервером'); return; }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    const msg = d.message ?? 'Не удалось скачать файл';
    if (d.error === 'export_needs_approval') alert(msg); else toast(msg);
    return;
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : 'report';
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Кнопка-ссылка на выгрузку с проверкой ответа сервера. */
export function ExportButton({ url, children }: { url: string; children: ReactNode }) {
  return <a className="btn sm" href={url} onClick={(e) => { e.preventDefault(); void downloadFile(url); }}>{children}</a>;
}

const KIND_ALERT: Record<string, string> = { reveal: 'полные номера', card: 'карточки клиентов', search: 'поиск по базе', export: 'выгрузка' };
const REPORT: Record<string, string> = { sales: 'Продажи', ai_summaries: 'Резюме звонков' };
const PD_KIND: Record<string, string> = { access: 'выдать сведения о данных', delete: 'удалить данные', revoke: 'отозвать согласие', correct: 'исправить данные' };
const CHANNEL: Record<string, string> = { paper: 'на бумаге', tablet: 'на планшете', site: 'на сайте', messenger: 'в мессенджере', staff: 'отметка сотрудника', import: 'перенос из 1С' };
const date = (s: string) => s.split('-').reverse().join('.');

type ExportReq = { id: string; report: string; title: string; rows: number; status: string; createdAt: string; decidedAt: string | null; usedAt: string | null; comment: string | null; userName: string; deciderName: string | null; clubName: string | null };
type Alert = { id: string; kind: string; count: number; threshold: number; createdAt: string; reviewedAt: string | null; note: string | null; userName: string; login: string; reviewerName: string | null; clubName: string | null };
type Limits = { clubId: string; clubName: string; exportRowsLimit: number; revealsPerHour: number; cardViewsAlert: number; searchesAlert: number };
type PdReq = { id: string; kind: string; receivedOn: string; dueOn: string; status: string; note: string | null; result: string | null; personId: string; personName: string; clubName: string; overdue: boolean; doneByName: string | null };
type Text = { id: string; kind: string; version: number; title: string; body: string; createdAt: string; authorName: string | null; used: number };

export function PrivacyPage({ me, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  type View = 'exports' | 'alerts' | 'activity' | 'requests' | 'texts' | 'limits';
  const views: [View, string][] = [['exports', 'Выгрузки'], ['alerts', 'Сигналы'], ['activity', 'Кто что смотрел'], ['requests', 'Обращения клиентов'], ['texts', 'Тексты согласий'], ['limits', 'Пороги']];
  const [view, setView] = useState<View>(() => { const v = navParams('privacy').view; return (views.find((x) => x[0] === v)?.[0]) ?? 'exports'; });
  return (
    <>
      <div><div className="lbl">Защита данных</div><h1>База клиентов и персональные данные</h1></div>
      <p className="muted" style={{ margin: 0, maxWidth: 760 }}>Система считает, сколько полных номеров, карточек и поисков открывает каждый сотрудник, и сообщает вам о всплесках.
        Большие выгрузки с данными клиентов скачиваются только после вашего одобрения. Здесь же — согласия клиентов и их обращения по 152-ФЗ.</p>
      <div className="tabs" role="group" aria-label="Защита данных">{views.map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{t}</button>)}</div>
      {view === 'exports' && <Exports me={me} />}
      {view === 'alerts' && <Alerts />}
      {view === 'activity' && <Activity />}
      {view === 'requests' && <PdRequests clubId={clubId} openPerson={openPerson} />}
      {view === 'texts' && <Texts me={me} />}
      {view === 'limits' && <LimitsView />}
    </>
  );
}

function Exports({ me }: { me: Me }) {
  const [rows, setRows] = useState<ExportReq[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<ExportReq[]>('GET', '/api/privacy/export-requests').then(setRows).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  const decide = async (r: ExportReq, approve: boolean) => {
    const comment = approve ? '' : prompt('Причина отказа (её увидит сотрудник)') ?? '';
    if (!approve && !comment.trim()) return;
    try { await api('POST', `/api/privacy/export-requests/${r.id}/decide`, { approve, comment }); toast(approve ? 'Одобрено: сотрудник может скачать выгрузку в течение суток' : 'Отказано'); load(); } catch (x) { setErr(errText(x)); }
  };
  const ST: Record<string, [string, string]> = { pending: ['ждёт решения', 'warn'], approved: ['одобрено', 'ok'], rejected: ['отказано', 'bad'], used: ['скачано', ''] };
  return (
    <div className="card">
      <h2>Запросы на выгрузку</h2>
      <p className="small">Если в выгрузке с именами клиентов больше строк, чем разрешено порогом клуба, она ждёт вашего решения. Одобренную выгрузку сотрудник скачивает один раз в течение суток.</p>
      {err && <div className="err">{err}</div>}
      <div className="tbl"><table>
        <thead><tr><th>Когда</th><th>Сотрудник</th><th>Отчёт</th><th className="num">Строк</th><th>Статус</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <td>{dt(r.createdAt)}</td><td>{r.userName}{r.clubName ? <span className="small"> · {r.clubName}</span> : null}</td>
          <td>{REPORT[r.report] ?? r.report}<div className="small">{r.title}</div></td><td className="num">{r.rows}</td>
          <td><span className={`chip ${ST[r.status]?.[1] ?? ''}`}>{ST[r.status]?.[0] ?? r.status}</span>{r.deciderName && <div className="small">{r.deciderName}{r.comment ? `: ${r.comment}` : ''}</div>}</td>
          <td>{r.status === 'pending' && can(me, 'data.protect') && <span className="row"><button className="btn sm pri" onClick={() => decide(r, true)}>Одобрить</button><button className="btn sm" onClick={() => decide(r, false)}>Отказать</button></span>}</td>
        </tr>)}</tbody>
      </table></div>
      {rows.length === 0 && <p className="muted">Запросов нет.</p>}
    </div>
  );
}

function Alerts() {
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Alert[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<Alert[]>('GET', `/api/privacy/alerts${all ? '?all=1' : ''}`).then(setRows).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [all]);
  const review = async (a: Alert) => {
    const note = prompt('Что выяснили? Например: «обзванивала список продлений по заданию РОПа»');
    if (!note?.trim()) return;
    try { await api('POST', `/api/privacy/alerts/${a.id}/review`, { note }); toast('Сигнал разобран'); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card">
      <div className="row between"><h2>Сигналы о необычной активности</h2>
        <div className="tabs" role="group"><button aria-pressed={!all} onClick={() => setAll(false)}>Не разобраны</button><button aria-pressed={all} onClick={() => setAll(true)}>Все</button></div></div>
      <p className="small">Сигнал появляется, когда сотрудник за час открыл больше карточек, номеров или поисков, чем задано в порогах, или запросил большую выгрузку. Управляющему клуба ставится задача.</p>
      {err && <div className="err">{err}</div>}
      <div className="tbl"><table>
        <thead><tr><th>Когда</th><th>Сотрудник</th><th>Что</th><th className="num">Сколько</th><th className="num">Порог</th><th>Разбор</th></tr></thead>
        <tbody>{rows.map((a) => <tr key={a.id}>
          <td>{dt(a.createdAt)}</td><td>{a.userName} <span className="small">({a.login}){a.clubName ? ` · ${a.clubName}` : ''}</span></td>
          <td>{KIND_ALERT[a.kind] ?? a.kind}</td><td className="num">{a.count}</td><td className="num">{a.threshold}</td>
          <td>{a.reviewedAt ? <span className="small">{a.reviewerName}: {a.note}</span> : <button className="btn sm" onClick={() => review(a)}>Разобрать</button>}</td>
        </tr>)}</tbody>
      </table></div>
      {rows.length === 0 && <p className="muted">{all ? 'Сигналов не было.' : 'Неразобранных сигналов нет.'}</p>}
    </div>
  );
}

function Activity() {
  const [d, setD] = useState<{ access: { userName: string; login: string; reveals: number; cards: number; searches: number; maxCardsHour: number | null }[];
    exports: { at: string; userName: string; report: string; rows: number | null; format: string | null; approved: boolean }[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<NonNullable<typeof d>>('GET', '/api/privacy/activity').then(setD).catch((x) => setErr(errText(x))); }, []);
  if (err) return <div className="err">{err}</div>;
  if (!d) return <p className="muted">Загрузка…</p>;
  return (
    <div className="grid2">
      <div className="card"><h2>Обращения к данным за 7 дней</h2>
        <div className="tbl"><table><thead><tr><th>Сотрудник</th><th className="num">Полных номеров</th><th className="num">Карточек</th><th className="num">Поисков</th><th className="num">Карточек за час, макс.</th></tr></thead>
          <tbody>{d.access.map((a) => <tr key={a.login}><td>{a.userName}</td><td className="num">{a.reveals}</td><td className="num">{a.cards}</td><td className="num">{a.searches}</td><td className="num">{a.maxCardsHour ?? '—'}</td></tr>)}</tbody></table></div>
        {d.access.length === 0 && <p className="muted">Пока нет данных.</p>}</div>
      <div className="card"><h2>Выгрузки за 30 дней</h2>
        <div className="tbl"><table><thead><tr><th>Когда</th><th>Кто</th><th>Отчёт</th><th className="num">Строк</th><th /></tr></thead>
          <tbody>{d.exports.map((e, i) => <tr key={i}><td>{dt(e.at)}</td><td>{e.userName}</td><td>{REPORT[e.report] ?? e.report}</td><td className="num">{e.rows ?? '—'}</td><td>{e.approved && <span className="chip ok">по согласованию</span>}</td></tr>)}</tbody></table></div>
        {d.exports.length === 0 && <p className="muted">Выгрузок не было.</p>}</div>
    </div>
  );
}

function PdRequests({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const [rows, setRows] = useState<PdReq[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<PdReq[]>('GET', `/api/pd-requests${clubId !== 'all' ? `?clubId=${clubId}` : ''}`).then(setRows).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [clubId]);
  const close = async (r: PdReq, status: 'done' | 'rejected') => {
    const result = prompt(status === 'done' ? 'Что сделано (это ответ клиенту)' : 'Причина отказа (это ответ клиенту)');
    if (!result?.trim()) return;
    try { await api('POST', `/api/pd-requests/${r.id}/complete`, { status, result }); toast('Обращение закрыто'); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card">
      <h2>Обращения клиентов по персональным данным</h2>
      <p className="small">Клиент может попросить выдать сведения о своих данных, отозвать согласие, исправить или удалить данные. Ответить нужно в течение 10 рабочих дней. Обращение регистрируют в карточке клиента, кнопка «Обращение по данным».</p>
      {err && <div className="err">{err}</div>}
      <div className="tbl"><table>
        <thead><tr><th>Клиент</th><th>Просит</th><th>Получено</th><th>Ответить до</th><th>Статус</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <td><button className="btn sm" onClick={() => openPerson(r.personId)}>{r.personName}</button><div className="small">{r.clubName}</div></td>
          <td>{PD_KIND[r.kind]}{r.note && <div className="small">{r.note}</div>}</td><td>{date(r.receivedOn)}</td>
          <td>{date(r.dueOn)} {r.overdue && <span className="chip bad">просрочено</span>}</td>
          <td>{r.status === 'open' ? <span className="chip warn">в работе</span> : <span className={`chip ${r.status === 'done' ? 'ok' : ''}`}>{r.status === 'done' ? 'выполнено' : 'отказано'}</span>}
            {r.result && <div className="small">{r.doneByName}: {r.result}</div>}</td>
          <td>{r.status === 'open' && <span className="row"><button className="btn sm" onClick={() => close(r, 'done')}>Выполнено</button><button className="btn sm" onClick={() => close(r, 'rejected')}>Отказать</button></span>}</td>
        </tr>)}</tbody>
      </table></div>
      {rows.length === 0 && <p className="muted">Обращений нет.</p>}
    </div>
  );
}

function Texts({ me }: { me: Me }) {
  const [d, setD] = useState<{ pd: Text[]; marketing: Text[] } | null>(null);
  const [edit, setEdit] = useState<{ kind: 'pd' | 'marketing'; title: string; body: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<NonNullable<typeof d>>('GET', '/api/consent-texts').then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!edit) return;
    try { const r = await api<{ version: number }>('POST', '/api/consent-texts', edit); toast(`Опубликована версия ${r.version}. Новые согласия будут записываться с ней`); setEdit(null); load(); } catch (x) { setErr(errText(x)); }
  };
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const block = (kind: 'pd' | 'marketing', name: string) => {
    const cur = d[kind][0];
    return (
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>{name}</h2><span className="chip acc">версия {cur?.version}</span></div>
        {edit?.kind === kind ? (<>
          <label className="f">Заголовок<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          <label className="f">Текст<textarea rows={10} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          <p className="small">Старые согласия остаются со своей версией текста. Новая версия действует для согласий, полученных после публикации.</p>
          <div className="row"><button className="btn pri sm" onClick={save}>Опубликовать новую версию</button><button className="btn sm" onClick={() => setEdit(null)}>Отмена</button></div>
        </>) : (<>
          <b>{cur?.title}</b>
          <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{cur?.body}</p>
          <p className="small" style={{ margin: 0 }}>Опубликовано {dt(cur?.createdAt)}{cur?.authorName ? `, ${cur.authorName}` : ' (текст по умолчанию)'} · записано согласий: {cur?.used}</p>
          {can(me, 'data.protect') && me.allClubs && <div><button className="btn sm" onClick={() => setEdit({ kind, title: cur?.title ?? '', body: cur?.body ?? '' })}>Изменить текст</button></div>}
          {d[kind].length > 1 && <details><summary className="small">Прошлые версии ({d[kind].length - 1})</summary>
            {d[kind].slice(1).map((t) => <div key={t.id} className="item small"><b>Версия {t.version}</b> от {dt(t.createdAt)} · согласий: {t.used}<br />{t.body}</div>)}</details>}
        </>)}
      </div>
    );
  };
  return (
    <>
      {err && <div className="err">{err}</div>}
      <p className="small" style={{ margin: 0 }}>Текст по умолчанию — шаблон. Перед запуском впишите в него наименование и реквизиты юрлица клуба и проверьте у юриста. Менять тексты может собственник сети.</p>
      <div className="grid2">{block('pd', 'Согласие на обработку персональных данных')}{block('marketing', 'Согласие на рекламные сообщения')}</div>
    </>
  );
}

function LimitsView() {
  const [d, setD] = useState<{ clubs: Limits[] } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<NonNullable<typeof d>>('GET', '/api/privacy/settings').then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  const save = async (c: Limits, patch: Partial<Limits>) => {
    setErr('');
    try { await api('PUT', `/api/privacy/settings/${c.clubId}`, patch); toast('Сохранено'); load(); } catch (x) { setErr(errText(x)); }
  };
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const F: [keyof Limits, string, string][] = [
    ['exportRowsLimit', 'Строк с клиентами в выгрузке без согласования', 'Больше — только после одобрения управляющего. 0 — согласовывать любую выгрузку'],
    ['revealsPerHour', 'Полных номеров и договоров в час на сотрудника', 'Сверх лимита номер не откроется до следующего часа. Управляющего и собственника не касается'],
    ['cardViewsAlert', 'Карточек клиентов в час: сообщить управляющему', 'Работа не блокируется, приходит сигнал и задача'],
    ['searchesAlert', 'Поисков по базе в час: сообщить управляющему', 'Работа не блокируется, приходит сигнал и задача'],
  ];
  return (
    <>
      {err && <div className="err">{err}</div>}
      <div className="grid2">{d.clubs.map((c) => (
        <div className="card" key={c.clubId} style={{ display: 'grid', gap: 8 }}>
          <h2>{c.clubName}</h2>
          {F.map(([k, label, hint]) => (
            <label className="f" key={k}>{label}
              <input type="number" min={0} defaultValue={c[k] as number} style={{ maxWidth: 140 }}
                onBlur={(e) => { const v = Number(e.target.value); if (v !== c[k]) save(c, { [k]: v }); }} />
              <span className="small">{hint}</span></label>
          ))}
        </div>))}</div>
    </>
  );
}

/* ---------- блок в карточке клиента ---------- */
type ConsentRow = { id: string; kind: string; granted: boolean; channel: string; note: string | null; at: string; version: number | null; actorName: string | null };
type Consents = { pd: ConsentRow | null; marketing: ConsentRow | null; history: ConsentRow[]; anonymizedAt: string | null;
  requests: { id: string; kind: string; receivedOn: string; dueOn: string; status: string; result: string | null }[];
  texts: { pd: { version: number; title: string; body: string }; marketing: { version: number; title: string; body: string } } };

export function PersonPrivacy({ me, personId, reload }: { me: Me; personId: string; reload: () => void }) {
  const [d, setD] = useState<Consents | null>(null);
  const [err, setErr] = useState('');
  const [reqKind, setReqKind] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const load = () => api<Consents>('GET', `/api/persons/${personId}/consents`).then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [personId]);
  const takeConsent = can(me, 'crm.work') || can(me, 'memberships.sell') || can(me, 'messages.work') || can(me, 'data.protect');
  const takeRequest = can(me, 'data.protect') || can(me, 'memberships.manage') || can(me, 'crm.work');
  const protect = can(me, 'data.protect');
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); toast(ok); load(); reload(); } catch (x) { setErr(x instanceof ApiError ? x.message : errText(x)); } };
  const consent = (kind: 'pd' | 'marketing', granted: boolean, channel: string) => act(() => api('POST', `/api/persons/${personId}/consents`, { kind, granted, channel }),
    granted ? 'Согласие записано' : 'Отзыв согласия записан');
  const anonymize = async () => {
    const reason = prompt('Основание (например, «заявление клиента от 11.11.2026»)');
    if (!reason?.trim()) return;
    const confirm = prompt('Имя, телефоны, переписка и записи разговоров клиента будут удалены без возможности восстановления. Платежи, договоры и посещения останутся без имени. Для подтверждения введите ОБЕЗЛИЧИТЬ');
    if (!confirm) return;
    const open = d?.requests.find((r) => r.kind === 'delete' && r.status === 'open');
    await act(() => api('POST', `/api/persons/${personId}/anonymize`, { reason, confirm: confirm.trim(), requestId: open?.id }), 'Данные клиента обезличены');
  };
  if (!d) return err ? <div className="err">{err}</div> : null;
  if (d.anonymizedAt) return <div className="card"><h2>Персональные данные</h2><p className="muted" style={{ margin: 0 }}>Данные клиента обезличены {dt(d.anonymizedAt)} по его обращению. Платежи и посещения сохранены без имени.</p></div>;
  const line = (c: ConsentRow | null, kind: 'pd' | 'marketing', name: string) => (
    <div className="item" style={{ display: 'grid', gap: 6 }}>
      <div className="row between"><b>{name}</b>
        {c ? <span className={`chip ${c.granted ? 'ok' : 'bad'}`}>{c.granted ? 'дано' : 'отозвано'}</span> : <span className="chip warn">нет</span>}</div>
      {c && <span className="small">{dt(c.at)}, {CHANNEL[c.channel] ?? c.channel}{c.version ? `, текст версии ${c.version}` : ''}{c.actorName ? `, ${c.actorName}` : ''}</span>}
      {takeConsent && <div className="row">
        {(!c || !c.granted) && <><button className="btn sm" onClick={() => consent(kind, true, 'paper')}>Дано на бумаге</button><button className="btn sm" onClick={() => consent(kind, true, 'tablet')}>Дано на планшете</button></>}
        {c?.granted && <button className="btn sm" onClick={() => consent(kind, false, 'paper')}>Клиент отозвал</button>}
      </div>}
      <details><summary className="small">Текст согласия (версия {d.texts[kind].version})</summary><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.texts[kind].body}</p></details>
    </div>
  );
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Персональные данные</h2>
      {err && <div className="err">{err}</div>}
      {line(d.pd, 'pd', 'Согласие на обработку данных')}
      {line(d.marketing, 'marketing', 'Согласие на рекламу')}
      {d.requests.length > 0 && <div className="small">{d.requests.map((r) => <div key={r.id}>Обращение: {PD_KIND[r.kind]}, получено {date(r.receivedOn)}, ответить до {date(r.dueOn)} — {r.status === 'open' ? 'в работе' : r.status === 'done' ? `выполнено${r.result ? `: ${r.result}` : ''}` : `отказано${r.result ? `: ${r.result}` : ''}`}</div>)}</div>}
      {takeRequest && (reqKind ? (
        <div className="item" style={{ display: 'grid', gap: 6 }}>
          <label className="f">Клиент просит<select value={reqKind} onChange={(e) => setReqKind(e.target.value)}>{Object.entries(PD_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f">Комментарий<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="письменное заявление на ресепшн" /></label>
          <div className="row"><button className="btn pri sm" onClick={() => act(() => api('POST', `/api/persons/${personId}/pd-requests`, { kind: reqKind, note }), 'Обращение зарегистрировано, управляющему поставлена задача').then(() => { setReqKind(null); setNote(''); })}>Зарегистрировать</button>
            <button className="btn sm" onClick={() => setReqKind(null)}>Отмена</button></div>
        </div>) : (
        <div className="row">
          <button className="btn sm" onClick={() => setReqKind('access')}>Обращение по данным</button>
          {protect && <ExportButton url={`/api/persons/${personId}/pd-export`}>Сведения для клиента</ExportButton>}
          {protect && <button className="btn sm" onClick={anonymize}>Обезличить</button>}
        </div>))}
    </div>
  );
}

/* ---------- состояние системы ---------- */
type CheckRow = { scope: string; code: string; status: 'ok' | 'warn' | 'bad'; value: number | null; detail: string; since: string; checkedAt: string; notifiedAt: string | null };
const CHECK_NAME: Record<string, string> = { db: 'База данных', disk: 'Место на диске', backup: 'Резервная копия', errors: 'Ошибки сервера', memory: 'Память приложения',
  receipts: 'Чеки в кассу', messages: 'Сообщения клиентам', autopay: 'Автосписания' };

export function SystemPage() {
  const [d, setD] = useState<{ checks: CheckRow[]; version: string | null; startedAt: string; operatorAlerts: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => { setBusy(true); api<NonNullable<typeof d>>('GET', `/api/system/status${refresh ? '?refresh=1' : ''}`).then(setD).catch((x) => setErr(errText(x))).finally(() => setBusy(false)); };
  useEffect(() => { load(true); const t = setInterval(() => load(), 60_000); return () => clearInterval(t); }, []);
  const test = async () => {
    try { const r = await api<{ operator: boolean; staff: number }>('POST', '/api/system/test-alert');
      toast(r.operator || r.staff ? `Проверочное сообщение отправлено${r.operator ? ' в служебный чат' : ''}${r.staff ? ' вам в Telegram' : ''}` : 'Оповещения не настроены: ни служебного чата, ни вашего Telegram'); } catch (x) { setErr(errText(x)); }
  };
  const ICON = { ok: ['ok', 'в порядке'], warn: ['warn', 'внимание'], bad: ['bad', 'сбой'] } as const;
  const group = (rows: CheckRow[], title: string) => (
    <div className="card"><h2>{title}</h2>
      <div className="tbl"><table><thead><tr><th>Проверка</th><th>Состояние</th><th>Подробно</th><th>С какого времени</th></tr></thead>
        <tbody>{rows.map((c) => <tr key={c.scope + c.code}><td>{CHECK_NAME[c.code] ?? c.code}</td><td><span className={`chip ${ICON[c.status][0]}`}>{ICON[c.status][1]}</span></td><td>{c.detail}</td><td>{dt(c.since)}</td></tr>)}</tbody></table></div>
      {rows.length === 0 && <p className="muted">Проверок ещё не было.</p>}</div>
  );
  return (
    <>
      <div className="row between">
        <div><div className="lbl">Состояние системы</div><h1>{d ? (d.checks.some((c) => c.status === 'bad') ? 'Есть сбои' : d.checks.some((c) => c.status === 'warn') ? 'Работает, есть замечания' : 'Всё работает') : 'Проверяем…'}</h1></div>
        <div className="row"><button className="btn sm" disabled={busy} onClick={() => load(true)}>Проверить сейчас</button><button className="btn sm" onClick={test}>Проверить оповещения</button></div>
      </div>
      {err && <div className="err">{err}</div>}
      <p className="small" style={{ margin: 0, maxWidth: 760 }}>Проверки выполняются раз в минуту. Когда что-то ломается и когда восстанавливается, приходит сообщение в Telegram: о сбоях сервера — в служебный чат
        {d && !d.operatorAlerts ? ' (пока не настроен: нужен бот и чат, см. инструкцию «Состояние системы»)' : ''}, о сбоях клубов (чеки, автосписания, рассылки) — собственнику и администратору, подключившим Telegram в профиле.</p>
      {d && <>{group(d.checks.filter((c) => c.scope === 'platform'), 'Сервер')}{group(d.checks.filter((c) => c.scope !== 'platform'), 'Работа клубов')}
        <p className="small">Версия: {d.version ?? 'не указана'} · приложение запущено {dt(d.startedAt)}</p></>}
    </>
  );
}
