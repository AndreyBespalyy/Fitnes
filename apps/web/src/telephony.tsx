// Телефония: подключение АТС клуба (OnlinePBX), внутренние номера сотрудников, окно «Звонит клиент».
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Club } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Conn = { id: string; clubId: string; kind: string; domain: string | null; hasKey: boolean; status: string; lastError: string | null; lastOkAt: string | null; lastEventAt: string | null; webhookUrl: string };
type StaffRow = { id: string; name: string; role: string; ext: string | null };
type Settings = { kinds: Record<string, string>; connection: Conn | null; staff: StaffRow[] };

export function PbxSettings({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState({ kind: 'onlinepbx', domain: '', apiKey: '' });
  const [exts, setExts] = useState<Record<string, string>>({});
  const [pbxUsers, setPbxUsers] = useState<{ ext: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api<Settings>('GET', `/api/pbx?clubId=${club}`).then((r) => {
    setS(r);
    setForm({ kind: r.connection?.kind ?? 'onlinepbx', domain: r.connection?.domain ?? '', apiKey: '' });
    setExts(Object.fromEntries(r.staff.map((u) => [u.id, u.ext ?? ''])));
  }).catch((x) => toast(errText(x)));
  useEffect(() => { if (club) load(); }, [club]); // eslint-disable-line react-hooks/exhaustive-deps

  const test = async (id: string) => {
    const t = await api<{ ok: boolean; info: string; users: { ext: string; name: string }[] }>('POST', `/api/pbx/${id}/test`);
    toast(t.info); setPbxUsers(t.users); load();
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string }>('PUT', '/api/pbx', { clubId: club, ...form, apiKey: form.apiKey || undefined });
      await test(r.id);
    } catch (x) { toast(errText(x)); } finally { setBusy(false); }
  };
  const setStatus = async (status: string) => { try { await api('PUT', '/api/pbx', { clubId: club, kind: s!.connection!.kind, domain: s!.connection!.domain, status }); load(); } catch (x) { toast(errText(x)); } };
  const saveExts = async () => {
    try {
      const r = await api<{ count: number }>('PUT', `/api/pbx/${s!.connection!.id}/extensions`, { items: Object.entries(exts).filter(([, e]) => e.trim()).map(([userId, ext]) => ({ userId, ext: ext.trim() })) });
      toast(`Сохранено: внутренних номеров ${r.count}`); load();
    } catch (x) { toast(errText(x)); }
  };
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => toast('Адрес скопирован')).catch(() => toast(text)); };
  const c = s?.connection;

  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 720 }}>
      <h2>Телефония (АТС клуба)</h2>
      <p className="small" style={{ margin: 0 }}>После подключения звонок из карточки идёт через АТС и записывается, входящий показывает карточку клиента, пропущенный ставит задачу «Перезвонить», а запись каждого разговора сама уходит ИИ на расшифровку и итог.</p>
      <label className="f">Клуб<select value={club} onChange={(e) => setClub(e.target.value)}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      {s && (<>
        <label className="f">АТС<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(s.kinds).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        {form.kind === 'onlinepbx' && (<>
          <label className="f">Адрес АТС (из адресной строки кабинета OnlinePBX)<input placeholder="pbx12345.onpbx.ru" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} /></label>
          <label className="f">Ключ API (кабинет OnlinePBX → Сервисы → Интеграция → API){c?.hasKey && <span className="small"> · сохранён, вставьте новый только для замены</span>}
            <input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
        </>)}
        <div className="row"><button className="btn pri" disabled={busy} onClick={save}>{c ? 'Сохранить и проверить' : 'Подключить'}</button>
          {c && <button className="btn" onClick={() => test(c.id).catch((x) => toast(errText(x)))}>Проверить связь</button>}
          {c && <button className="btn" onClick={() => setStatus(c.status === 'active' ? 'disabled' : 'active')}>{c.status === 'active' ? 'Отключить' : 'Включить'}</button>}</div>
        {c && (<>
          <p className="small" style={{ margin: 0 }}>
            {c.status !== 'active' ? <span className="chip warn">отключена</span> : c.lastError ? <span className="chip bad">ошибка: {c.lastError}</span> : c.lastOkAt ? <span className="chip ok">на связи</span> : <span className="chip warn">не проверена</span>}
            {' '}{c.lastEventAt ? `Последнее событие от АТС: ${dt(c.lastEventAt)}.` : 'От АТС ещё не было событий о звонках.'}
          </p>
          <div className="f"><span>Адрес для событий о звонках (вставьте в кабинете OnlinePBX → Сервисы → Интеграция → Webhooks, отметьте все события)</span>
            <div className="row"><input readOnly value={c.webhookUrl} onFocus={(e) => e.target.select()} style={{ flex: 1 }} /><button className="btn" onClick={() => copy(c.webhookUrl)}>Скопировать</button></div></div>
          <h3>Внутренние номера сотрудников</h3>
          <p className="small" style={{ margin: 0 }}>Укажите номер, под которым сотрудник работает в АТС (от 100 до 4999). Без номера сотрудник звонит с телефона, как раньше.{pbxUsers.length > 0 && ` В АТС: ${pbxUsers.map((u) => `${u.ext} ${u.name}`).join(', ')}.`}</p>
          <div className="tbl"><table><thead><tr><th>Сотрудник</th><th>Внутренний номер</th></tr></thead><tbody>
            {s.staff.map((u) => <tr key={u.id}><td>{u.name}</td><td><input inputMode="numeric" style={{ width: 90 }} value={exts[u.id] ?? ''} onChange={(e) => setExts({ ...exts, [u.id]: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></td></tr>)}
          </tbody></table></div>
          <button className="btn pri" style={{ justifySelf: 'start' }} onClick={saveExts}>Сохранить номера</button>
          {c.kind === 'test' && <TestCall connId={c.id} staff={s.staff} />}
        </>)}
      </>)}
    </div>
  );
}

function TestCall({ connId, staff }: { connId: string; staff: StaffRow[] }) {
  const withExt = staff.filter((u) => u.ext);
  const [ext, setExt] = useState(withExt[0]?.ext ?? '');
  const [phone, setPhone] = useState('');
  const send = async (event: string) => { try { await api('POST', `/api/pbx/${connId}/simulate`, { event, phone, ext }); toast('Событие отправлено'); } catch (x) { toast(errText(x)); } };
  if (!withExt.length) return <p className="small">Чтобы проверить окно входящего звонка, укажите сотруднику внутренний номер.</p>;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h3>Проверка без настоящих звонков</h3>
      <div className="row"><select value={ext} onChange={(e) => setExt(e.target.value)}>{withExt.map((u) => <option key={u.id} value={u.ext!}>{u.ext} {u.name}</option>)}</select>
        <input placeholder="Телефон клиента" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
      <div className="row"><button className="btn" onClick={() => send('call_user_start')}>Входящий звонок</button><button className="btn" onClick={() => send('call_missed')}>Пропущенный</button></div>
    </div>
  );
}

/* ---------- окно «Звонит клиент» ---------- */
type Live = { uuid: string; phone: string | null; personId: string | null; personName: string | null; answered: boolean };

export function IncomingCall({ openPerson }: { openPerson: (id: string) => void }) {
  const [calls, setCalls] = useState<Live[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const opened = useRef(new Set<string>());
  useEffect(() => {
    let stop = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let next = 4000;
      try {
        if (document.visibilityState === 'visible') {
          const r = await api<{ enabled: boolean; calls: Live[] }>('GET', '/api/pbx/live');
          if (!r.enabled) next = 120_000; // у сотрудника нет внутреннего номера — проверяем редко
          setCalls(r.calls);
        }
      } catch { next = 30_000; }
      if (!stop) timer = setTimeout(tick, next);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, []);
  // Ответил — карточка клиента открывается сама
  useEffect(() => {
    for (const c of calls) if (c.answered && c.personId && !opened.current.has(c.uuid)) { opened.current.add(c.uuid); openPerson(c.personId); }
  }, [calls, openPerson]);
  const shown = calls.filter((c) => !hidden.includes(c.uuid));
  if (!shown.length) return null;
  // В корень страницы: шапка с размытием фона ломает position: fixed у вложенных элементов
  return createPortal(
    <div role="alert" aria-live="assertive" style={{ position: 'fixed', right: 16, bottom: 84, zIndex: 60, display: 'grid', gap: 8, maxWidth: 'calc(100vw - 32px)' }}>
      {shown.map((c) => (
        <div key={c.uuid} className="card" style={{ display: 'grid', gap: 6, minWidth: 260, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
          <b>{c.answered ? '📞 Идёт разговор' : '📞 Звонит клиент'}</b>
          <span>{c.personName ?? 'Новый номер'}{c.phone ? ` · ${c.phone}` : ''}</span>
          <div className="row">
            {c.personId && <button className="btn sm pri" onClick={() => openPerson(c.personId!)}>Открыть карточку</button>}
            <button className="btn sm" onClick={() => setHidden([...hidden, c.uuid])}>Скрыть</button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
