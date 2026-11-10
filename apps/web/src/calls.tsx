// Шаг 14. Звонки: записи разговоров, черновик итога от ИИ, подтверждение менеджером, оценка РОПа и качество ИИ.
import { CallEvaluation } from './insights.tsx';
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me, type Staff } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type CallRow = {
  id: string; clubId: string; startedAt: string; direction: 'in' | 'out'; durationSec: number | null; phone: string | null; personId: string | null; personName: string | null;
  userId: string | null; userName: string | null; source: string; asrStatus: string; asrError: string | null; engine: string | null; hasAudio: boolean;
  summaryStatus: string | null; essence: string | null; editRatio: string | null; ropRating: string | null; confidence: string | null; short: boolean;
};
type NextStep = { title: string; kind: 'call' | 'meeting' | 'message' | 'other'; dueAt: string | null };
type Summary = { essence: string; need: string; objections: string[]; agreements: string; outcome: string | null; nextStep: NextStep | null };
type CallFull = {
  id: string; clubName: string; startedAt: string; direction: 'in' | 'out'; durationSec: number | null; phone: string | null; personId: string | null; personName: string | null;
  userName: string | null; source: string; asrStatus: string; asrError: string | null; engine: string | null; hasAudio: boolean; fillControlHours: number;
  transcript: { text: string; segments: { speaker: string | null; start: number; end: number; text: string }[] } | null;
  summary: null | { status: string; draft: Summary | null; final: Summary | null; engine: string | null; confidence: number | null; editRatio: number | null;
    confirmedBy: string | null; confirmedAt: string | null; createdAt: string; ropRating: string | null; ropComment: string | null; ratedBy: string | null };
  canRate: boolean;
};
type AiStatus = { connected: boolean; message?: string; asr?: string; llm?: string; promptVersion?: string };

export const OUTCOME: Record<string, string> = { interested: 'интересно, движемся дальше', thinking: 'думает', refused: 'отказ', bought: 'купил или оплатит', other: 'другое' };
const KIND: Record<string, string> = { call: 'звонок', meeting: 'встреча', message: 'сообщение', other: 'другое' };
const RATING: Record<string, string> = { ok: 'без правок', minor: 'мелкие правки', major: 'существенные правки' };
const ASR: Record<string, string> = { queued: 'в очереди ИИ', processing: 'ИИ расшифровывает', waiting_ai: 'ждёт ИИ-сервер', failed: 'не распозналась', no_audio: 'без записи', done: 'расшифрована' };

export function callState(c: { summaryStatus: string | null; asrStatus: string; short?: boolean }): [string, string] {
  if (c.summaryStatus === 'draft') return ['черновик ИИ: проверьте', 'warn'];
  if (c.summaryStatus === 'needs_manual') return ['нужен итог вручную', 'bad'];
  if (c.summaryStatus === 'auto_applied') return ['перенесено ИИ без проверки', 'warn'];
  if (c.summaryStatus === 'confirmed') return ['итог подтверждён', 'ok'];
  if (c.summaryStatus === 'manual') return ['итог написан вручную', 'ok'];
  if (c.short) return ['короткий, итог не нужен', ''];
  return [ASR[c.asrStatus] ?? c.asrStatus, c.asrStatus === 'failed' ? 'bad' : ''];
}
const dur = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const pad = (n: number) => String(n).padStart(2, '0');
const toLocal = (iso: string | null | undefined) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function AiStatusLine() {
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => { api<AiStatus>('GET', '/api/ai/status').then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  return s.connected
    ? <p className="small" style={{ margin: 0 }}><span className="chip ok">ИИ-сервер подключён</span> Распознавание: {s.asr}; итоги: {s.llm}{s.promptVersion ? `, ${s.promptVersion}` : ''}.</p>
    : <p className="small" style={{ margin: 0 }}><span className="chip warn">ИИ-сервер не подключён</span> {s.message}</p>;
}

/* ---------- раздел «Звонки» ---------- */
export function CallsPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const tabs: [string, string, boolean][] = [
    ['review', 'На проверку', true], ['all', 'Все разговоры', true], ['upload', 'Загрузить записи', true],
    ['quality', 'Качество ИИ', can(me, 'ai.review')], ['settings', 'Настройки', can(me, 'plan.manage')],
  ];
  const [tab, setTab] = useState('review');
  const [open, setOpen] = useState<string | null>(null);
  const [ver, setVer] = useState(0);
  return (
    <>
      <div className="tabs" role="group" aria-label="Звонки">
        {tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{t}</button>)}
      </div>
      <AiStatusLine />
      {(tab === 'review' || tab === 'all') && <CallList key={`${tab}${ver}`} me={me} clubId={clubId} scope={tab} onOpen={setOpen} openPerson={openPerson} />}
      {tab === 'upload' && <UploadCalls me={me} clubs={clubs} clubId={clubId} onOpen={setOpen} />}
      {tab === 'quality' && <Quality clubs={clubs} clubId={clubId} />}
      {tab === 'settings' && <AiSettings clubs={clubs} clubId={clubId} />}
      {open && <CallDialog id={open} onClose={() => { setOpen(null); setVer((v) => v + 1); }} openPerson={openPerson} />}
    </>
  );
}

function CallList({ me, clubId, scope, onOpen, openPerson }: { me: Me; clubId: string; scope: string; onOpen: (id: string) => void; openPerson: (id: string) => void }) {
  const [rows, setRows] = useState<CallRow[] | null>(null);
  const [mine, setMine] = useState(!can(me, 'crm.view_all'));
  useEffect(() => {
    const qs = new URLSearchParams({ scope });
    if (mine) qs.set('mine', '1');
    if (clubId !== 'all') qs.set('clubId', clubId);
    api<CallRow[]>('GET', `/api/calls?${qs}`).then(setRows).catch(() => setRows([]));
  }, [clubId, scope, mine]);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between">
        <h2>{scope === 'review' ? 'Итоги разговоров на проверку' : 'Разговоры'}</h2>
        {can(me, 'crm.view_all') && <div className="tabs" role="group"><button aria-pressed={mine} onClick={() => setMine(true)}>Мои</button><button aria-pressed={!mine} onClick={() => setMine(false)}>Все в клубе</button></div>}
      </div>
      {scope === 'review' && <p className="small" style={{ margin: 0 }}>ИИ составляет черновик итога после каждого разговора. Проверьте его, поправьте и подтвердите: итог попадёт в карточку клиента, следующий шаг станет задачей.</p>}
      {!rows ? <p className="muted">Загрузка…</p> : rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>{scope === 'review' ? 'Всё проверено.' : 'Разговоров пока нет.'}</p> : (
        <div className="list">{rows.map((c) => {
          const [st, cls] = callState(c);
          return (
            <div key={c.id} className="item" style={{ display: 'grid', gap: 4 }}>
              <div className="row between">
                <span><b>{c.personName ?? c.phone ?? 'Клиент не определён'}</b> <span className="small">{c.direction === 'in' ? 'входящий' : 'исходящий'} · {dt(c.startedAt)}{c.durationSec ? ` · ${dur(c.durationSec)}` : ''}{!mine || scope === 'all' ? ` · ${c.userName ?? 'сотрудник не указан'}` : ''}</span></span>
                <span className={`chip ${cls}`}>{st}</span>
              </div>
              {c.essence && <div className="small">{c.essence}</div>}
              <div className="row">
                <button className={`btn sm ${['draft', 'needs_manual'].includes(c.summaryStatus ?? '') ? 'pri' : ''}`} onClick={() => onOpen(c.id)}>Открыть</button>
                {c.personId && <button className="btn sm" onClick={() => openPerson(c.personId!)}>Карточка клиента</button>}
                {c.ropRating && <span className="small">Оценка РОПа: {RATING[c.ropRating]}</span>}
              </div>
            </div>);
        })}</div>)}
    </div>
  );
}

/* ---------- один разговор ---------- */
export function CallDialog({ id, onClose, openPerson }: { id: string; onClose: () => void; openPerson?: (id: string) => void }) {
  const [c, setC] = useState<CallFull | null>(null);
  const [err, setErr] = useState('');
  const reload = () => api<CallFull>('GET', `/api/calls/${id}`).then(setC).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const s = c?.summary;
  const editable = !!c && (!s || ['draft', 'needs_manual', 'auto_applied'].includes(s.status));
  return (
    <div className="overlay" style={{ zIndex: 30 }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Разговор">
        <div className="row between"><span className="lbl">Разговор</span><button className="btn sm" onClick={onClose}>Закрыть</button></div>
        {err && <div className="err">{err}</div>}
        {!c ? <p className="muted">Загрузка…</p> : (<>
          <div>
            <h1>{c.personName ?? c.phone ?? 'Клиент не определён'}</h1>
            <div className="small">{c.direction === 'in' ? 'Входящий' : 'Исходящий'} · {dt(c.startedAt)}{c.durationSec ? ` · ${dur(c.durationSec)}` : ''} · {c.userName ?? 'сотрудник не указан'} · {c.clubName}</div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className={`chip ${callState({ summaryStatus: s?.status ?? null, asrStatus: c.asrStatus })[1]}`}>{callState({ summaryStatus: s?.status ?? null, asrStatus: c.asrStatus })[0]}</span>
              {c.personId && openPerson && <button className="btn sm" onClick={() => openPerson(c.personId!)}>Карточка клиента</button>}
            </div>
          </div>
          {!c.personId && <LinkPerson callId={c.id} onDone={reload} />}
          {c.hasAudio && <audio controls preload="none" src={`/api/calls/${c.id}/audio`} style={{ width: '100%' }} />}
          {c.asrError && <div className="small" style={{ color: 'var(--bad)' }}>ИИ: {c.asrError}</div>}

          {s?.status === 'auto_applied' && <div className="item small">Менеджер не проверил итог за {c.fillControlHours} ч, поэтому система перенесла черновик ИИ в карточку и сообщила РОПу. Итог можно поправить.</div>}
          {s?.draft && editable && <div className="small">Черновик составил ИИ{s.confidence !== null ? `, уверенность ${Math.round(s.confidence * 100)} %` : ''}. Это предложение: проверьте и поправьте. Итог нужно подтвердить за {c.fillControlHours} ч.</div>}
          {s?.status === 'needs_manual' && <div className="small">ИИ не смог составить итог{c.asrStatus === 'failed' ? ': запись не распозналась' : ': в разговоре мало данных'}. Напишите коротко сами.</div>}
          {!s && c.asrStatus === 'waiting_ai' && <div className="small">Запись ждёт ИИ-сервер. Если итог нужен сейчас, напишите его сами.</div>}

          {editable
            ? <SummaryForm initial={s?.final ?? s?.draft ?? null} callId={c.id} onSaved={reload} />
            : s?.final && <SummaryView s={s.final} title="Итог в карточке" />}
          {s && !editable && (
            <div className="small">{s.status === 'confirmed' ? `Подтвердил ${s.confirmedBy ?? '—'} ${dt(s.confirmedAt)}${s.editRatio !== null ? `, правки ${Math.round(s.editRatio * 100)} % текста` : ''}` : `Написал вручную ${s.confirmedBy ?? '—'} ${dt(s.confirmedAt)}`}</div>)}
          {s?.draft && !editable && s.editRatio !== null && s.editRatio > 0 && (
            <details className="item"><summary>Черновик ИИ до правок</summary><SummaryView s={s.draft} /></details>)}
          {c.canRate && s?.draft && s.status !== 'draft' && <Rating callId={c.id} s={s} onDone={reload} />}
          <CallEvaluation callId={c.id} />

          {c.transcript && (
            <div className="card" style={{ display: 'grid', gap: 6 }}><h2>Расшифровка</h2>
              {c.transcript.segments.length > 0 && c.transcript.segments.some((x) => x.speaker)
                ? c.transcript.segments.map((x, i) => <div key={i} className="tr-line"><span className={`who ${x.speaker ?? ''}`}>{x.speaker === 'manager' ? 'Менеджер' : x.speaker === 'client' ? 'Клиент' : ''}</span><span>{x.text}</span></div>)
                : <div style={{ whiteSpace: 'pre-wrap' }} className="small">{c.transcript.text}</div>}
              {c.engine && <div className="small muted">Обработано: {c.engine}</div>}
            </div>)}
        </>)}
      </aside>
    </div>
  );
}

function SummaryView({ s, title }: { s: Summary; title?: string }) {
  return (
    <div className="card kv">
      {title && <><span>{title}</span><span /></>}
      <span>Суть</span><span>{s.essence}</span>
      {s.need && <><span>Потребность</span><span>{s.need}</span></>}
      {s.objections.length > 0 && <><span>Возражения</span><span>{s.objections.join('; ')}</span></>}
      {s.agreements && <><span>Договорённости</span><span>{s.agreements}</span></>}
      {s.outcome && <><span>Итог</span><span>{OUTCOME[s.outcome] ?? s.outcome}</span></>}
      {s.nextStep && <><span>Следующий шаг</span><span>{s.nextStep.title} ({KIND[s.nextStep.kind]}){s.nextStep.dueAt ? `, ${dt(s.nextStep.dueAt)}` : ''}</span></>}
    </div>
  );
}

function SummaryForm({ initial, callId, onSaved }: { initial: Summary | null; callId: string; onSaved: () => void }) {
  const [essence, setEssence] = useState(initial?.essence ?? '');
  const [need, setNeed] = useState(initial?.need ?? '');
  const [objections, setObjections] = useState((initial?.objections ?? []).join('\n'));
  const [agreements, setAgreements] = useState(initial?.agreements ?? '');
  const [outcome, setOutcome] = useState(initial?.outcome ?? '');
  const [hasNext, setHasNext] = useState(!!initial?.nextStep);
  const [title, setTitle] = useState(initial?.nextStep?.title ?? 'Перезвонить');
  const [kind, setKind] = useState<NextStep['kind']>(initial?.nextStep?.kind ?? 'call');
  const [due, setDue] = useState(toLocal(initial?.nextStep?.dueAt) || toLocal(new Date(Date.now() + 86_400_000).toISOString()));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await api('POST', `/api/calls/${callId}/summary`, {
        essence, need, objections: objections.split('\n'), agreements, outcome: outcome || null,
        nextStep: hasNext ? { title, kind, dueAt: due ? new Date(due).toISOString() : '' } : null,
      });
      toast(initial ? 'Итог подтверждён и сохранён в карточке' : 'Итог сохранён в карточке'); onSaved();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 8 }}>
      <h2>{initial ? 'Итог разговора (черновик ИИ)' : 'Итог разговора'}</h2>
      <label className="f">Суть разговора<textarea rows={3} value={essence} onChange={(e) => setEssence(e.target.value)} placeholder="о чём говорили, к чему пришли" /></label>
      <label className="f">Потребность клиента<input value={need} onChange={(e) => setNeed(e.target.value)} /></label>
      <label className="f">Возражения (каждое с новой строки)<textarea rows={2} value={objections} onChange={(e) => setObjections(e.target.value)} /></label>
      <label className="f">Договорённости<textarea rows={2} value={agreements} onChange={(e) => setAgreements(e.target.value)} /></label>
      <label className="f">Итог<select value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">не указан</option>{Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={hasNext} onChange={(e) => setHasNext(e.target.checked)} />Следующий шаг (станет задачей)</label>
      {hasNext && (
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
          <label className="f">Что сделать<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="f">Как<select value={kind} onChange={(e) => setKind(e.target.value as NextStep['kind'])}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f">Когда<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>)}
      {err && <div className="err">{err}</div>}
      <div className="row"><button className="btn pri" disabled={busy || !essence.trim()}>{initial ? 'Подтвердить итог' : 'Сохранить итог'}</button></div>
    </form>
  );
}

function Rating({ callId, s, onDone }: { callId: string; s: NonNullable<CallFull['summary']>; onDone: () => void }) {
  const [comment, setComment] = useState(s.ropComment ?? '');
  const rate = async (rating: string) => {
    try { await api('POST', `/api/calls/${callId}/rating`, { rating, comment }); toast('Оценка сохранена'); onDone(); } catch (x) { toast(errText(x)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Оценка резюме ИИ</h2>
      <p className="small" style={{ margin: 0 }}>Сравните черновик ИИ с разговором: насколько его пришлось править? Цель — не менее 80 % резюме без существенных правок.{s.ropRating ? ` Сейчас: ${RATING[s.ropRating]}${s.ratedBy ? ` (${s.ratedBy})` : ''}.` : ''}</p>
      <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий: что ИИ упустил или исказил" />
      <div className="row">{Object.entries(RATING).map(([k, v]) => <button key={k} className={`btn sm ${s.ropRating === k ? 'pri' : ''}`} onClick={() => rate(k)}>{v}</button>)}</div>
    </div>
  );
}

function LinkPerson({ callId, onDone }: { callId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<{ id: string; fullName: string; phone: string | null }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setList([]); return; }
    const t = setTimeout(() => api<typeof list>('GET', `/api/persons?q=${encodeURIComponent(q.trim())}`).then((r) => setList(r.slice(0, 8))).catch(() => setList([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const link = async (personId: string) => {
    try { await api('POST', `/api/calls/${callId}/link`, { personId }); toast('Разговор привязан к клиенту'); onDone(); } catch (x) { toast(errText(x)); }
  };
  return (
    <div className="item" style={{ display: 'grid', gap: 6 }}>
      <b>Клиент не определён по телефону</b>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найдите клиента по имени или телефону" />
      {list.map((p) => <button key={p.id} className="btn sm" onClick={() => link(p.id)}>{p.fullName} {p.phone ? `· ${p.phone}` : ''}</button>)}
    </div>
  );
}

/* ---------- загрузка записей ---------- */
function UploadCalls({ me, clubs, clubId, onOpen }: { me: Me; clubs: Club[]; clubId: string; onOpen: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [who, setWho] = useState(can(me, 'crm.view_all') ? '' : me.id);
  const [done, setDone] = useState<{ name: string; ok: boolean; text: string; id?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  useEffect(() => { if (can(me, 'staff.view')) api<Staff[]>('GET', '/api/staff').then(setStaff).catch(() => setStaff([])); }, []);
  const sales = staff.filter((s) => s.status === 'active' && s.assignments.some((a) => a.clubId === club && ['manager', 'rop'].includes(a.role)));
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const res: typeof done = [];
    for (const f of Array.from(files)) {
      try {
        const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(f); });
        const r = await api<{ id: string; duplicate: boolean; personId: string | null; status: string | null }>('POST', '/api/calls/upload', { clubId: club, fileName: f.name, dataBase64: data, userId: who || undefined });
        res.push({ name: f.name, ok: true, id: r.id, text: r.duplicate ? 'уже загружена раньше' : `${r.personId ? 'клиент найден по телефону' : 'клиент не найден, привяжите вручную'}; ${r.status === 'waiting_ai' ? 'ждёт ИИ-сервер' : 'отправлена ИИ'}` });
      } catch (x) { res.push({ name: f.name, ok: false, text: errText(x) }); }
      setDone([...res]);
    }
    setBusy(false);
    toast(`Загружено: ${res.filter((r) => r.ok).length} из ${res.length}`);
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2>Загрузить записи разговоров</h2>
      <p className="small" style={{ margin: 0 }}>Пока телефония не подключена, записи можно выгрузить из АТС и загрузить сюда, можно сразу пачкой. Из имени файла система берёт телефон, дату и время, по телефону находит клиента. Например: <code>out-79001234567-20261110-143512.mp3</code>. Форматы: MP3, WAV, OGG, M4A, до 60 МБ.</p>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        <label className="f">Клуб<select value={club} onChange={(e) => setClub(e.target.value)}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {can(me, 'crm.view_all') && (
          <label className="f">Чей разговор<select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">ответственный по сделке клиента</option>
            <option value={me.id}>мой</option>
            {sales.filter((s) => s.id !== me.id).map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select></label>)}
      </div>
      <label className="btn pri" style={{ justifySelf: 'start', cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'Загружаю…' : 'Выбрать файлы'}
        <input type="file" multiple accept="audio/*,.mp3,.wav,.ogg,.m4a,.webm,.flac" disabled={busy || !club} style={{ display: 'none' }} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {done.length > 0 && <div className="list">{done.map((d, i) => (
        <div key={i} className="item row between"><span><b>{d.name}</b> <span className="small" style={d.ok ? undefined : { color: 'var(--bad)' }}>{d.text}</span></span>
          {d.id && <button className="btn sm" onClick={() => onOpen(d.id!)}>Открыть</button>}</div>))}</div>}
    </div>
  );
}

/* ---------- качество ИИ ---------- */
type Q = { calls: number; recognized: number; failed: number; waiting: number; short: number; drafted: number; pending: number; confirmed: number; accepted: number; autoApplied: number; manual: number; avgEditPct: number | null; rated: number; ratedOk: number; acceptedPct: number | null; ratedOkPct: number | null; name?: string };
function Quality({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const first = new Date(); first.setDate(1);
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [d, setD] = useState<{ target: number; minorEditPct: number; total: Q; byUser: Q[]; byEngine: Q[] } | null>(null);
  const qs = new URLSearchParams({ from, to }); if (clubId !== 'all') qs.set('clubId', clubId);
  useEffect(() => { api<typeof d>('GET', `/api/ai/quality?${qs}`).then(setD).catch(() => setD(null)); }, [clubId, from, to]);
  const pct = (v: number | null) => (v === null ? '—' : `${String(v).replace('.', ',')} %`);
  const t = d?.total;
  const row = (q: Q) => <tr key={q.name}><td>{q.name}</td><td className="num">{q.calls}</td><td className="num">{q.drafted}</td><td className="num">{q.confirmed}</td>
    <td className={`num ${q.acceptedPct !== null ? (q.acceptedPct >= (d?.target ?? 80) ? 'ok' : 'bad') : ''}`}>{pct(q.acceptedPct)}</td><td className="num">{pct(q.avgEditPct)}</td>
    <td className="num">{q.autoApplied}</td><td className="num">{q.manual}</td><td className="num">{q.rated ? `${pct(q.ratedOkPct)} из ${q.rated}` : '—'}</td></tr>;
  return (
    <>
      <div className="row"><label className="f">С<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="f">По<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <a className="btn sm" href={`/api/ai/summaries/export?${qs}&format=xlsx`}>Резюме в Excel</a><a className="btn sm" href={`/api/ai/summaries/export?${qs}&format=csv`}>CSV</a></div>
      {!t ? <p className="muted">Загрузка…</p> : (<>
        <div className="kpis">
          <div className="card"><span className="lbl">Принято без существенных правок</span><b className={t.acceptedPct === null ? '' : t.acceptedPct >= d!.target ? 'num ok' : 'num bad'}>{pct(t.acceptedPct)}</b><span className="small">цель {d!.target} %; правки до {d!.minorEditPct} % текста считаются мелкими; подтверждено {t.confirmed}</span></div>
          <div className="card"><span className="lbl">Оценка РОПа: без существенных правок</span><b>{pct(t.ratedOkPct)}</b><span className="small">оценено {t.rated}</span></div>
          <div className="card"><span className="lbl">Разговоров</span><b>{t.calls}</b><span className="small">расшифровано {t.recognized}, не распознано {t.failed}, ждут ИИ {t.waiting}, коротких {t.short}</span></div>
          <div className="card"><span className="lbl">Резюме ИИ</span><b>{t.drafted}</b><span className="small">ждут менеджера {t.pending}; перенесено без проверки {t.autoApplied}; вручную {t.manual}</span></div>
        </div>
        <div className="card"><h2>По сотрудникам</h2><div className="tbl"><table>
          <thead><tr><th>Сотрудник</th><th>Разговоров</th><th>Резюме ИИ</th><th>Подтверждено</th><th>Без существ. правок</th><th>Правки в среднем</th><th>Без проверки</th><th>Вручную</th><th>Оценка РОПа</th></tr></thead>
          <tbody>{d!.byUser.map(row)}</tbody></table></div></div>
        {d!.byEngine.length > 0 && <div className="card"><h2>По версиям ИИ</h2><p className="small">Новая версия модели или промпта внедряется, только если её качество не хуже текущей.</p><div className="tbl"><table>
          <thead><tr><th>Версия</th><th>Разговоров</th><th>Резюме ИИ</th><th>Подтверждено</th><th>Без существ. правок</th><th>Правки в среднем</th><th>Без проверки</th><th>Вручную</th><th>Оценка РОПа</th></tr></thead>
          <tbody>{d!.byEngine.map(row)}</tbody></table></div></div>}
      </>)}
      {clubs.length === 0 && null}
    </>
  );
}

function AiSettings({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  const [hours, setHours] = useState('2');
  useEffect(() => { if (club) api<{ fillControlHours: number }>('GET', `/api/ai/settings?clubId=${club}`).then((s) => setHours(String(s.fillControlHours))).catch(() => {}); }, [club]);
  const save = async () => { try { await api('PUT', '/api/ai/settings', { clubId: club, fillControlHours: Number(hours) }); toast('Сохранено'); } catch (x) { toast(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
      <h2>Контроль заполнения итогов</h2>
      <label className="f">Клуб<select value={club} onChange={(e) => setClub(e.target.value)}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="f">Сколько часов у менеджера на проверку черновика ИИ<input type="number" min={1} max={72} value={hours} onChange={(e) => setHours(e.target.value)} /></label>
      <p className="small" style={{ margin: 0 }}>Если менеджер не подтвердил итог за это время, система переносит черновик ИИ в карточку с пометкой «без проверки», ставит задачу следующего шага и сообщает РОПу.</p>
      <button className="btn pri" style={{ justifySelf: 'start' }} onClick={save}>Сохранить</button>
    </div>
  );
}

/* ---------- блок в карточке клиента ---------- */
export function PersonCalls({ personId }: { personId: string }) {
  const [rows, setRows] = useState<CallRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<CallRow[]>('GET', `/api/calls?personId=${personId}`).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [personId]);
  if (!rows.length) return null;
  return (
    <div className="card" style={{ display: 'grid', gap: 6 }}><h2>Разговоры</h2>
      {rows.map((c) => { const [st, cls] = callState(c); return (
        <div key={c.id} className="item" style={{ display: 'grid', gap: 4 }}>
          <div className="row between"><span className="small">{dt(c.startedAt)} · {c.direction === 'in' ? 'входящий' : 'исходящий'}{c.durationSec ? ` · ${dur(c.durationSec)}` : ''} · {c.userName ?? '—'}</span><span className={`chip ${cls}`}>{st}</span></div>
          {c.essence && <div>{c.essence}</div>}
          <div><button className="btn sm" onClick={() => setOpen(c.id)}>Открыть</button></div>
        </div>); })}
      {open && <CallDialog id={open} onClose={() => { setOpen(null); load(); }} />}
    </div>
  );
}
