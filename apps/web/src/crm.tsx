import { DialButton } from './mobile.tsx';
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { dt, errText, fromLocal, localInput, toast } from './ui.ts';
import { MembershipsBlock } from './memberships.tsx';
import { ReferralBlock } from './referrals.tsx';
import { UpsellBlock } from './upsell.tsx';
import { DepositBlock } from './gifts.tsx';
import { FamilyBlock } from './familyCorp.tsx';
import { PersonChats } from './chat.tsx';
import { PersonPasses } from './access.tsx';
import { PersonCards } from './payments.tsx';
import { CallDialog, PersonCalls } from './calls.tsx';

type Stage = { id: string; name: string; kind: 'open' | 'won' | 'lost'; openCount?: number };
type Pipeline = { id: string; clubId: string; name: string; purpose: string; isDefaultForLeads: boolean; isActive: boolean; stages: Stage[] };
type Source = { id: string; code: string; name: string; channel: string; isActive: boolean; hasApiKey: boolean };
type Lead = { id: string; createdAt: string; clubName: string; personId: string; personName: string; sourceName: string | null; comment: string | null;
  isRepeat: boolean; assigneeName: string | null; dueAt: string; respondedAt: string | null; responseState: 'in_time' | 'late' | 'overdue' | 'waiting' };
type Opp = { id: string; stageId: string; personId: string; personName: string; ownerName: string | null; nextTaskAt: string | null; overdue: boolean };
type Task = { id: string; kind: string; title: string; dueAt: string; doneAt: string | null; result: string | null; personId: string | null; personName: string | null;
  opportunityId: string | null; assigneeName: string | null; overdue: boolean; callId: string | null };
type Card = {
  person: { id: string; fullName: string; segment: string; homeClubId: string | null; homeClubName: string | null; createdAt: string; autopayEnabled: boolean; autopayChangedAt: string | null; marketingConsent: boolean; messagingOptOut: boolean };
  contacts: { type: string; value: string; isPrimary: boolean }[];
  leads: { id: string; createdAt: string; sourceName: string | null; comment: string | null; isRepeat: boolean; clubName: string; dueAt: string; respondedAt: string | null }[];
  opportunities: { id: string; status: string; clubName: string; pipelineName: string; stageId: string; stageName: string; ownerName: string | null; lostReason: string | null; stages: Stage[] }[];
  tasks: Task[];
  meetings: { id: string; scheduledAt: string; status: string; opportunityId: string }[];
  history: { at: string; fromStage: string | null; toStage: string; actorName: string | null; comment: string | null }[];
};

const RESPONSE: Record<Lead['responseState'], [string, string]> = {
  in_time: ['ответили вовремя', 'ok'], late: ['ответили с опозданием', 'warn'], overdue: ['норма ответа нарушена', 'bad'], waiting: ['ждёт ответа', 'acc'],
};
const MEETING: Record<string, string> = { scheduled: 'назначена', attended: 'пришёл', no_show: 'не пришёл', cancelled: 'отменена' };
const KIND: Record<string, string> = { first_response: 'первый ответ', call: 'звонок', meeting: 'встреча', message: 'сообщение', other: 'другое' };

function useClubChoice(clubs: Club[], clubId: string) {
  return clubId !== 'all' ? clubId : clubs[0]?.id ?? '';
}

/* ---------- Лиды ---------- */
export function LeadsPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [form, setForm] = useState({ fullName: '', phone: '', sourceId: '', comment: '' });
  const [err, setErr] = useState('');
  const club = useClubChoice(clubs, clubId);
  // С рабочего стола: «лиды ждут первого ответа»
  const [noResp, setNoResp] = useState(() => navParams('leads').filter === 'noresponse');
  const shownLeads = noResp ? leads.filter((l) => !l.respondedAt) : leads;
  const reload = () => api<Lead[]>('GET', `/api/leads${clubId !== 'all' ? `?clubId=${clubId}` : ''}`).then(setLeads).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [clubId]);
  useEffect(() => { api<Source[]>('GET', '/api/lead-sources').then((s) => setSources(s.filter((x) => x.isActive))).catch(() => {}); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ personId: string; duplicate: boolean; otherClub: boolean }>('POST', '/api/leads', { clubId: club, ...form });
      toast(r.duplicate ? (r.otherClub ? 'Клиент уже есть в другом клубе сети: обращение добавлено к его карточке' : 'Клиент уже есть в базе: обращение добавлено к его карточке') : 'Лид создан и назначен менеджеру');
      setForm({ fullName: '', phone: '', sourceId: form.sourceId, comment: '' });
      reload();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <div className="row between"><h2>Новый лид</h2><span className="small">{clubs.find((c) => c.id === club)?.name}</span></div>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', alignItems: 'end' }}>
          <label className="f">Имя<input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="Анна Иванова" /></label>
          <label className="f">Телефон<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+7 900 000-00-00" /></label>
          <label className="f">Откуда узнал (обязательно)<select className="f" value={form.sourceId} onChange={(e) => setForm({ ...form, sourceId: e.target.value })}>
            <option value="">— выберите —</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="f">Комментарий<input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} placeholder="что хочет клиент" /></label>
          <button className="btn pri" disabled={!form.phone || !form.sourceId || !club}>Создать лид</button>
        </div>
        <p className="small" style={{ margin: 0 }}>Если клиент с таким телефоном уже есть в сети, второй клиент не создаётся: обращение добавится к его карточке.</p>
      </form>
      {err && <div className="err">{err}</div>}
      <div className="tabs" role="group" aria-label="Какие лиды"><button aria-pressed={!noResp} onClick={() => setNoResp(false)}>Все</button><button aria-pressed={noResp} onClick={() => setNoResp(true)}>Ждут первого ответа ({leads.filter((l) => !l.respondedAt).length})</button></div>
      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Когда</th><th>Клиент</th><th>Источник</th><th>Ответственный</th><th>Первый ответ</th>{clubId === 'all' && <th>Клуб</th>}</tr></thead>
        <tbody>{shownLeads.map((l) => (
          <tr key={l.id}>
            <td className="num">{dt(l.createdAt)}</td>
            <td><button className="btn sm" onClick={() => openPerson(l.personId)}>{l.personName}</button> {l.isRepeat && <span className="chip">повторно</span>}
              {l.comment && <div className="small">{l.comment}</div>}</td>
            <td>{l.sourceName ?? '—'}</td><td>{l.assigneeName ?? <span className="chip bad">не назначен</span>}</td>
            <td><span className={`chip ${RESPONSE[l.responseState][1]}`}>{RESPONSE[l.responseState][0]}</span><div className="small">до {dt(l.dueAt)}</div></td>
            {clubId === 'all' && <td>{l.clubName}</td>}
          </tr>))}</tbody>
      </table></div>{leads.length === 0 && <p className="muted">Лидов пока нет.</p>}
      {!can(me, 'crm.view_all') && can(me, 'crm.work') && <p className="small">Показаны лиды, назначенные вам.</p>}</div>
    </>
  );
}

/* ---------- Сделки (доска по этапам) ---------- */
export function BoardPage({ clubs, clubId, openPerson }: { clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const club = useClubChoice(clubs, clubId);
  const [pipes, setPipes] = useState<Pipeline[]>([]);
  const [pid, setPid] = useState('');
  const [opps, setOpps] = useState<Opp[]>([]);
  const [closed, setClosed] = useState<{ won: Opp[]; lost: Opp[] }>({ won: [], lost: [] });
  useEffect(() => {
    if (!club) return;
    api<Pipeline[]>('GET', `/api/pipelines?clubId=${club}`).then((p) => {
      const act = p.filter((x) => x.isActive);
      setPipes(act);
      setPid((cur) => (act.some((x) => x.id === cur) ? cur : act.find((x) => x.isDefaultForLeads)?.id ?? act[0]?.id ?? ''));
    }).catch(() => setPipes([]));
  }, [club]);
  useEffect(() => {
    if (!pid) return;
    api<Opp[]>('GET', `/api/opportunities?pipelineId=${pid}`).then(setOpps).catch(() => setOpps([]));
    Promise.all([api<Opp[]>('GET', `/api/opportunities?pipelineId=${pid}&status=won`), api<Opp[]>('GET', `/api/opportunities?pipelineId=${pid}&status=lost`)])
      .then(([won, lost]) => setClosed({ won, lost })).catch(() => {});
  }, [pid]);
  const pipe = pipes.find((p) => p.id === pid);
  return (
    <>
      <div className="row between">
        <div className="tabs" role="group" aria-label="Воронки">{pipes.map((p) => <button key={p.id} aria-pressed={p.id === pid} onClick={() => setPid(p.id)}>{p.name}</button>)}</div>
        {clubId === 'all' && <span className="small">Показан {clubs.find((c) => c.id === club)?.name}. Другой клуб выберите вверху.</span>}
      </div>
      {pipe && (
        <div className="board">
          {pipe.stages.map((s) => {
            const list = s.kind === 'open' ? opps.filter((o) => o.stageId === s.id) : (s.kind === 'won' ? closed.won : closed.lost).filter((o) => o.stageId === s.id);
            return (
              <div key={s.id} className={`col ${s.kind}`}>
                <h3><span>{s.name}</span><span className="num">{list.length}</span></h3>
                {list.slice(0, 50).map((o) => (
                  <button key={o.id} className={`oc ${o.overdue ? 'over' : ''}`} onClick={() => openPerson(o.personId)}>
                    <b>{o.personName}</b>
                    <span className="small">{o.ownerName ?? 'не назначен'}</span>
                    {s.kind === 'open' && <span className="small">{o.nextTaskAt ? `следующий шаг: ${dt(o.nextTaskAt)}` : 'нет следующего шага'}{o.overdue ? ' · просрочено' : ''}</span>}
                  </button>))}
              </div>
            );
          })}
        </div>
      )}
      {!pipe && <p className="muted">В клубе нет активных воронок.</p>}
    </>
  );
}

/* ---------- Задачи ---------- */
export function TasksPage({ me, clubId, openPerson }: { me: Me; clubId: string; openPerson: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scope, setScope] = useState<'mine' | 'all'>(() => (navParams('tasks').scope === 'all' && can(me, 'crm.view_all') ? 'all' : 'mine'));
  const [doing, setDoing] = useState<Task | null>(null);
  const [call, setCall] = useState<string | null>(null);
  const reload = () => api<Task[]>('GET', `/api/tasks?scope=${scope}${clubId !== 'all' ? `&clubId=${clubId}` : ''}`).then(setTasks).catch(() => setTasks([]));
  useEffect(() => { reload(); }, [scope, clubId]);
  const now = Date.now();
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const groups: [string, Task[]][] = [
    ['Просрочено', tasks.filter((t) => t.overdue)],
    ['Сегодня', tasks.filter((t) => !t.overdue && new Date(t.dueAt).getTime() <= endOfDay.getTime())],
    ['Позже', tasks.filter((t) => new Date(t.dueAt).getTime() > endOfDay.getTime() && new Date(t.dueAt).getTime() > now)],
  ];
  return (
    <>
      {can(me, 'crm.view_all') && (
        <div className="tabs" role="group"><button aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>Мои</button><button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Все в клубе</button></div>
      )}
      {groups.map(([title, list]) => list.length > 0 && (
        <div key={title} className="card" style={{ display: 'grid', gap: 8 }}>
          <h2 style={title === 'Просрочено' ? { color: 'var(--bad)' } : undefined}>{title} · {list.length}</h2>
          <div className="list">{list.map((t) => (
            <div key={t.id} className={`item ${t.overdue ? 'over' : ''}`}>
              <div className="row between">
                <div><b>{t.title}</b> <span className="chip">{KIND[t.kind] ?? t.kind}</span>
                  <div className="small">{dt(t.dueAt)}{scope === 'all' && t.assigneeName ? ` · ${t.assigneeName}` : ''}</div></div>
                <div className="row">
                  {t.personId && <button className="btn sm" onClick={() => openPerson(t.personId!)}>{t.personName}</button>}
                  {t.personId && (t.kind === 'call' || t.kind === 'first_response') && !t.doneAt && <DialButton personId={t.personId} />}
                  {t.callId && <button className="btn sm pri" onClick={() => setCall(t.callId)}>Итог разговора</button>}
                  <button className={`btn sm ${t.callId ? '' : 'pri'}`} onClick={() => setDoing(t)}>Выполнить</button>
                </div>
              </div>
              {doing?.id === t.id && <CompleteTask task={t} onDone={() => { setDoing(null); reload(); }} onCancel={() => setDoing(null)} />}
            </div>))}</div>
        </div>
      ))}
      {tasks.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>Открытых задач нет.</p></div>}
      {call && <CallDialog id={call} onClose={() => { setCall(null); reload(); }} openPerson={openPerson} />}
    </>
  );
}

function CompleteTask({ task, onDone, onCancel }: { task: Task; onDone: () => void; onCancel: () => void }) {
  const [result, setResult] = useState('');
  const [next, setNext] = useState(!!task.opportunityId);
  const [title, setTitle] = useState('Перезвонить');
  const [due, setDue] = useState(localInput(24 * 60));
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ queued?: boolean }>('POST', `/api/tasks/${task.id}/complete`, { result, nextTask: next ? { title, dueAt: fromLocal(due) } : undefined });
      toast(r.queued ? 'Нет связи: отметка сохранена на телефоне и отправится сама' : 'Задача выполнена'); onDone();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <label className="f">Результат<input value={result} onChange={(e) => setResult(e.target.value)} placeholder="дозвонился, договорились о встрече" autoFocus /></label>
      {task.opportunityId && (
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={next} onChange={(e) => setNext(e.target.checked)} />Поставить следующую задачу</label>
      )}
      {next && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
          <label className="f">Следующий шаг<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="f">Когда<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="row"><button className="btn pri sm" disabled={!result.trim()}>Готово</button><button type="button" className="btn sm" onClick={onCancel}>Отмена</button></div>
    </form>
  );
}

/* ---------- Карточка клиента ---------- */
export function PersonCard({ me, id, onClose }: { me: Me; id: string; onClose: () => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [err, setErr] = useState('');
  const [move, setMove] = useState<{ oppId: string; stage: Stage } | null>(null);
  const [reason, setReason] = useState('');
  const [taskTitle, setTaskTitle] = useState('Перезвонить');
  const [taskDue, setTaskDue] = useState(localInput(24 * 60));
  const [meetAt, setMeetAt] = useState(localInput(24 * 60));
  const reload = () => api<Card>('GET', `/api/persons/${id}`).then(setCard).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const work = can(me, 'crm.work');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setErr('');
    try { await fn(); toast(ok); setMove(null); setReason(''); reload(); } catch (x) { setErr(errText(x)); }
  };
  const doMove = (oppId: string, stage: Stage, withTask: boolean) => act(() => api('POST', `/api/opportunities/${oppId}/stage`, {
    stageId: stage.id, lostReason: stage.kind === 'lost' ? reason : undefined,
    nextTask: withTask ? { title: taskTitle, dueAt: fromLocal(taskDue) } : undefined,
  }), `Этап: ${stage.name}`);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Карточка клиента">
        <div className="row between"><span className="lbl">Карточка клиента</span><button className="btn sm" onClick={onClose}>Закрыть</button></div>
        {err && <div className="err">{err}</div>}
        {!card ? <p className="muted">Загрузка…</p> : (<>
          <div><h1>{card.person.fullName}</h1>
            <div className="row" style={{ marginTop: 4 }}><span className="chip acc">{card.person.segment}</span>
              <span className="small">{card.person.homeClubName ?? 'клиент другого клуба сети'} · в базе с {dt(card.person.createdAt)}</span></div></div>
          <div className="card kv">{card.contacts.map((c, i) => <span key={i} style={{ display: 'contents' }}><span>{c.type === 'phone' ? 'Телефон' : c.type === 'email' ? 'E-mail' : c.type === 'telegram' ? 'Telegram' : c.type === 'whatsapp' ? 'WhatsApp' : c.type}</span><span className="num">{c.value}{c.type === 'phone' && c.isPrimary && <> <DialButton personId={id} label="" /></>}</span></span>)}</div>
          {can(me, 'memberships.view') && (
            <label className="item row" style={{ gap: 10 }}>
              <input type="checkbox" style={{ width: 20, height: 20 }} checked={card.person.autopayEnabled} disabled={!can(me, 'memberships.manage')}
                onChange={(e) => act(() => api('POST', `/api/persons/${card.person.id}/autopay`, { enabled: e.target.checked }), e.target.checked ? 'Автосписание включено' : 'Автосписание выключено')} />
              <span><b>Списывать подписку автоматически с привязанной карты</b><br />
                <span className="small">Отметьте, только если клиент согласен на автосписание{card.person.autopayChangedAt ? ` (изменено ${dt(card.person.autopayChangedAt)})` : ''}. Карта сохранится, когда клиент оплатит подписку по ссылке. Дальше деньги будут списываться в день оплаты.</span></span>
            </label>)}
          {can(me, 'memberships.view') && <PersonCards me={me} personId={card.person.id} autopayEnabled={card.person.autopayEnabled} />}
          {can(me, 'messages.work') && <PersonChats me={me} personId={card.person.id} homeClubId={card.person.homeClubId}
            marketingConsent={card.person.marketingConsent} optOut={card.person.messagingOptOut} reload={reload} />}
          {can(me, 'persons.view') && <UpsellBlock personId={card.person.id} clubId={card.person.homeClubId} />}
          <MembershipsBlock me={me} personId={card.person.id} homeClubId={card.person.homeClubId} />
          {can(me, 'memberships.view') && <FamilyBlock me={me} personId={card.person.id} clubId={card.person.homeClubId} />}
          {can(me, 'memberships.view') && <DepositBlock personId={card.person.id} clubId={card.person.homeClubId} />}
          {can(me, 'persons.view') && <ReferralBlock me={me} personId={card.person.id} clubId={card.person.homeClubId} />}
          {(can(me, 'acs.work') || can(me, 'acs.manage')) && <PersonPasses me={me} personId={card.person.id} clubId={card.person.homeClubId ?? ''} />}

          {card.opportunities.map((o) => (
            <div key={o.id} className="card" style={{ display: 'grid', gap: 8 }}>
              <div className="row between"><h2>{o.pipelineName}</h2>
                <span className={`chip ${o.status === 'won' ? 'ok' : o.status === 'lost' ? 'bad' : 'acc'}`}>{o.status === 'open' ? 'в работе' : o.status === 'won' ? 'успешно' : 'отказ'}</span></div>
              <div className="small">{o.clubName} · ответственный: {o.ownerName ?? 'не назначен'}{o.lostReason ? ` · причина отказа: ${o.lostReason}` : ''}</div>
              <div className="stagebar">{o.stages.map((s) => (
                <button key={s.id} className={s.kind} aria-current={s.id === o.stageId} disabled={!work || o.status !== 'open' || s.id === o.stageId}
                  onClick={() => setMove({ oppId: o.id, stage: s })}>{s.name}</button>))}</div>
              {move?.oppId === o.id && (
                <div className="item" style={{ display: 'grid', gap: 8 }}>
                  <b>Перевести на этап «{move.stage.name}»</b>
                  {move.stage.kind === 'lost' && <label className="f">Причина отказа (обязательно)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="дорого, переехал, выбрал другой клуб" /></label>}
                  {move.stage.kind === 'open' && (
                    <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
                      <label className="f">Следующий шаг<input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} /></label>
                      <label className="f">Когда<input type="datetime-local" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} /></label>
                    </div>)}
                  <div className="row">
                    <button className="btn pri sm" onClick={() => doMove(o.id, move.stage, move.stage.kind === 'open')}>Перевести</button>
                    {move.stage.kind === 'open' && <button className="btn sm" onClick={() => doMove(o.id, move.stage, false)}>Без новой задачи</button>}
                    <button className="btn sm" onClick={() => setMove(null)}>Отмена</button>
                  </div>
                </div>)}
              {work && o.status === 'open' && (
                <div className="row">
                  <input type="datetime-local" value={meetAt} onChange={(e) => setMeetAt(e.target.value)} style={{ width: 'auto' }} aria-label="Время встречи" />
                  <button className="btn sm" onClick={() => act(() => api('POST', '/api/meetings', { opportunityId: o.id, scheduledAt: fromLocal(meetAt) }), 'Встреча назначена, задача создана')}>Назначить встречу</button>
                </div>)}
            </div>
          ))}

          {card.meetings.length > 0 && (
            <div className="card" style={{ display: 'grid', gap: 6 }}><h2>Встречи</h2>
              {card.meetings.map((m) => (
                <div key={m.id} className="row between"><span>{dt(m.scheduledAt)} · <span className="chip">{MEETING[m.status]}</span></span>
                  {work && m.status === 'scheduled' && <span className="row">
                    <button className="btn sm" onClick={() => act(() => api('POST', `/api/meetings/${m.id}/status`, { status: 'attended' }), 'Отмечено: пришёл')}>Пришёл</button>
                    <button className="btn sm" onClick={() => act(() => api('POST', `/api/meetings/${m.id}/status`, { status: 'no_show' }), 'Отмечено: не пришёл')}>Не пришёл</button></span>}
                </div>))}
            </div>)}

          {work && <PersonCalls personId={card.person.id} />}
          <div className="card" style={{ display: 'grid', gap: 6 }}><h2>Задачи</h2>
            {card.tasks.length === 0 && <p className="muted" style={{ margin: 0 }}>Задач нет.</p>}
            {card.tasks.map((t) => (
              <div key={t.id} className={`item ${t.overdue ? 'over' : ''}`}>
                <div className="row between"><span><b>{t.title}</b> <span className="chip">{KIND[t.kind] ?? t.kind}</span></span><span className="small">{t.doneAt ? `выполнено ${dt(t.doneAt)}` : `до ${dt(t.dueAt)}`}</span></div>
                {t.result && <div className="small">Результат: {t.result}</div>}
              </div>))}
          </div>

          <div className="card" style={{ display: 'grid', gap: 6 }}><h2>Обращения</h2>
            {card.leads.map((l) => <div key={l.id} className="small">{dt(l.createdAt)} · {l.sourceName ?? 'источник не указан'} · {l.clubName}{l.isRepeat ? ' · повторно' : ''}{l.comment ? ` · «${l.comment}»` : ''}</div>)}
          </div>
          <div className="card" style={{ display: 'grid', gap: 6 }}><h2>История</h2>
            {card.history.map((h, i) => <div key={i} className="small">{dt(h.at)} · {h.fromStage ? `${h.fromStage} → ` : ''}{h.toStage}{h.actorName ? ` · ${h.actorName}` : ''}{h.comment ? ` · ${h.comment}` : ''}</div>)}
          </div>
        </>)}
      </aside>
    </div>
  );
}

/* ---------- Администратор: воронки и этапы ---------- */
type EditStage = { id?: string; name: string; kind: Stage['kind']; openCount?: number };

export function PipelinesAdmin({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const club = useClubChoice(clubs, clubId);
  const [pipes, setPipes] = useState<Pipeline[]>([]);
  const [edit, setEdit] = useState<{ id?: string; name: string; stages: EditStage[] } | null>(null);
  const [err, setErr] = useState('');
  const reload = () => club && api<Pipeline[]>('GET', `/api/pipelines?clubId=${club}`).then(setPipes).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); setEdit(null); }, [club]);
  const save = async () => {
    if (!edit) return;
    setErr('');
    try {
      const stages = edit.stages.map(({ id, name, kind }) => ({ id, name, kind }));
      if (edit.id) await api('PUT', `/api/pipelines/${edit.id}/stages`, { stages });
      else await api('POST', '/api/pipelines', { clubId: club, name: edit.name, stages });
      toast('Воронка сохранена'); setEdit(null); reload();
    } catch (x) { setErr(errText(x)); }
  };
  const patch = async (p: Pipeline, body: object, ok: string) => {
    setErr('');
    try { await api('PATCH', `/api/pipelines/${p.id}`, body); toast(ok); reload(); } catch (x) { setErr(errText(x)); }
  };
  const upd = (i: number, v: Partial<EditStage>) => edit && setEdit({ ...edit, stages: edit.stages.map((s, j) => (j === i ? { ...s, ...v } : s)) });
  const moveStage = (i: number, d: number) => {
    if (!edit) return;
    const s = [...edit.stages]; const j = i + d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setEdit({ ...edit, stages: s });
  };
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>Воронка — цепочка этапов, по которой менеджер ведёт клиента. Первый этап рабочий: с него начинаются новые сделки. В конце нужны этап успеха и этап отказа.</p>
        <button className="btn pri" onClick={() => setEdit({ name: '', stages: [{ name: 'Новый лид', kind: 'open' }, { name: 'В работе', kind: 'open' }, { name: 'Купил', kind: 'won' }, { name: 'Отказ', kind: 'lost' }] })}>+ Новая воронка</button>
      </div>
      {clubId === 'all' && <p className="small">Показан {clubs.find((c) => c.id === club)?.name}. Другой клуб выберите вверху.</p>}
      {err && <div className="err">{err}</div>}
      {edit && (
        <div className="card" style={{ display: 'grid', gap: 10, borderColor: 'var(--accent)' }}>
          <h2>{edit.id ? `Этапы воронки «${edit.name}»` : 'Новая воронка'}</h2>
          {!edit.id && <label className="f">Название<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Корпоративные клиенты" /></label>}
          {edit.stages.map((s, i) => (
            <div key={s.id ?? `n${i}`} className="srow">
              <span className="num small">{i + 1}</span>
              <input value={s.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label="Название этапа" />
              <select className="f" value={s.kind} onChange={(e) => upd(i, { kind: e.target.value as Stage['kind'] })} aria-label="Тип этапа">
                <option value="open">рабочий</option><option value="won">успех (продажа)</option><option value="lost">отказ</option></select>
              <span className="row ord">
                <button type="button" className="btn sm" onClick={() => moveStage(i, -1)} aria-label="Выше">↑</button>
                <button type="button" className="btn sm" onClick={() => moveStage(i, 1)} aria-label="Ниже">↓</button>
                <button type="button" className="btn sm" disabled={!!s.openCount} title={s.openCount ? 'На этапе есть сделки' : ''}
                  onClick={() => setEdit({ ...edit, stages: edit.stages.filter((_, j) => j !== i) })}>Удалить</button>
              </span>
            </div>))}
          <div className="row">
            <button type="button" className="btn sm" onClick={() => setEdit({ ...edit, stages: [...edit.stages.slice(0, -2), { name: '', kind: 'open' }, ...edit.stages.slice(-2)] })}>+ Этап</button>
          </div>
          <div className="row"><button className="btn pri" onClick={save}>Сохранить</button><button className="btn" onClick={() => setEdit(null)}>Отмена</button></div>
        </div>
      )}
      <div className="grid2">
        {pipes.map((p) => (
          <div key={p.id} className="card" style={{ display: 'grid', gap: 8, opacity: p.isActive ? 1 : 0.6 }}>
            <div className="row between"><h2>{p.name}</h2>
              <span className="row">{p.isDefaultForLeads && <span className="chip acc">сюда идут новые лиды</span>}{!p.isActive && <span className="chip">отключена</span>}</span></div>
            <div className="stagebar">{p.stages.map((s) => <button key={s.id} className={s.kind} disabled>{s.name}{s.openCount ? ` · ${s.openCount}` : ''}</button>)}</div>
            <div className="row">
              <button className="btn sm" onClick={() => setEdit({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ ...s })) })}>Изменить этапы</button>
              {!p.isDefaultForLeads && p.isActive && <button className="btn sm" onClick={() => patch(p, { isDefaultForLeads: true }, 'Новые лиды будут попадать в эту воронку')}>Новые лиды сюда</button>}
              {!p.isDefaultForLeads && <button className="btn sm" onClick={() => patch(p, { isActive: !p.isActive }, p.isActive ? 'Воронка отключена' : 'Воронка включена')}>{p.isActive ? 'Отключить' : 'Включить'}</button>}
            </div>
          </div>))}
      </div>
    </>
  );
}
