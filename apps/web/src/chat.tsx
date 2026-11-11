// Шаг 10. Переписка с клиентами: единое окно (Telegram и WhatsApp), чат в карточке клиента,
// настройки: каналы, шаблоны, автосообщения, рабочее время и автоответ.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { Md } from './fiscal.tsx';
import guide from '../../../docs/03_Инструкции/Мессенджеры_Telegram_WhatsApp.md?raw';

type Conv = { id: string; clubId: string; channelId: string; channelName: string; channelKind: string; messenger: 'telegram' | 'whatsapp'; personId: string | null;
  personName: string | null; segment: string | null; title: string; chatId: string; assignedTo: string | null; assigneeName: string | null; lastMessageAt: string | null;
  unread: number; optOut: boolean | null; marketingConsent: boolean | null; lastText: string | null; lastDirection: 'in' | 'out' | null };
type Msg = { id: string; direction: 'in' | 'out'; body: string; status: string; error: string | null; auto: boolean; createdAt: string; authorName: string | null; triggerEvent: string | null };
type Channel = { id: string; clubId: string; kind: string; kindName: string; messenger: string; name: string; settings: Record<string, string>; hasSecret: boolean; status: string;
  lastError: string | null; lastOkAt: string | null; webhookUrl?: string; polling: boolean; clientBot?: boolean };
type Template = { id: string; clubId: string; name: string; body: string; isActive: boolean; event: string | null };
type Trigger = { id: string; event: string; days: number; templateId: string; templateName: string; marketing: boolean; enabled: boolean; sendHour: number; sent30: number };
type Preview = { ready: { personId: string; name: string; text: string }[]; skipped: { personId: string; name: string; reason: string }[]; sent: number };

const MESSENGER: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };
const EVENT: Record<string, [string, string]> = {
  membership_ending: ['Абонемент заканчивается', 'за сколько дней до окончания'],
  debt_overdue: ['Долг по оплате', 'через сколько дней после срока платежа'],
  inactive: ['Давно не был в клубе', 'сколько дней без посещений'],
  birthday: ['День рождения', ''],
  welcome: ['Приветствие после покупки', ''],
  ai_nurture: ['Неприоритетные клиенты по оценке ИИ', 'не чаще одного раза в столько дней'],
};
const STATUS: Record<string, string> = { queued: 'отправляется…', sent: 'отправлено', failed: 'не отправлено', received: '' };
const time = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// Номер показываем так же, как в карточке клиента: середина скрыта
const maskWa = (d: string) => d.replace(/^7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 ***-**-$4');
const who = (c: Conv) => c.personName ?? c.title;

/* ---------------- окно переписки ---------------- */
export function ChatsPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [list, setList] = useState<Conv[]>([]);
  const [filter, setFilter] = useState(() => navParams('chats').filter ?? 'all');
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const load = () => api<Conv[]>('GET', `/api/msg/conversations?filter=${filter}${clubId !== 'all' ? `&clubId=${clubId}` : ''}`).then(setList).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [filter, clubId]);
  const shown = list.filter((c) => !q || who(c).toLowerCase().includes(q.toLowerCase()) || (q.replace(/\D/g, '').length >= 4 && c.chatId.endsWith(q.replace(/\D/g, ''))));
  const cur = list.find((c) => c.id === open) ?? null;
  return (
    <div className="chat-layout">
      <div className={`card chat-list ${open ? 'hide-narrow' : ''}`}>
        <div className="row between"><h2>Переписка</h2>
          <div className="tabs">{[['all', 'Все'], ['unread', 'Непрочитанные'], ['mine', 'Мои']].map(([k, t]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{t}</button>)}</div></div>
        <input placeholder="Поиск по имени или номеру" value={q} onChange={(e) => setQ(e.target.value)} />
        {!shown.length && <p className="muted">Диалогов нет. Сообщения клиентов из Telegram и WhatsApp появятся здесь.</p>}
        {shown.map((c) => (
          <button key={c.id} className={`conv ${open === c.id ? 'on' : ''}`} onClick={() => setOpen(c.id)}>
            <span className="row between"><b>{who(c)}</b><span className="small">{c.lastMessageAt ? time(c.lastMessageAt) : ''}</span></span>
            <span className="row between"><span className="small ellipsis">{c.lastDirection === 'out' ? 'Вы: ' : ''}{c.lastText ?? ''}</span>
              {c.unread > 0 && <span className="badge">{c.unread}</span>}</span>
            <span className="row"><span className={`chip ${c.messenger === 'telegram' ? 'acc' : 'ok'}`}>{MESSENGER[c.messenger]}</span>
              {clubId === 'all' && <span className="small">{clubs.find((x) => x.id === c.clubId)?.name}</span>}
              {c.segment && <span className="small">{c.segment}</span>}{c.assigneeName && <span className="small">· {c.assigneeName}</span>}</span>
          </button>))}
      </div>
      <div className={`card chat-main ${open ? '' : 'hide-narrow'}`}>
        {cur ? <ChatPane me={me} conv={cur} onBack={() => setOpen(null)} onSent={load} openPerson={openPerson} /> : <p className="muted">Выберите диалог слева.</p>}
      </div>
    </div>
  );
}

export function ChatPane({ me, conv, onBack, onSent, openPerson, compact }: { me: Me; conv: Conv; onBack?: () => void; onSent?: () => void;
  openPerson?: (id: string) => void; compact?: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [tpl, setTpl] = useState<Template[]>([]);
  const [tplId, setTplId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = () => api<{ messages: Msg[] }>('GET', `/api/msg/conversations/${conv.id}/messages`).then((r) => setMsgs(r.messages)).catch((e) => setErr(errText(e)));
  useEffect(() => { setMsgs([]); setText(''); setErr(''); load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [conv.id]);
  useEffect(() => { api<Template[]>('GET', `/api/msg/templates?clubId=${conv.clubId}`).then((x) => setTpl(x.filter((t) => t.isActive))).catch(() => {}); }, [conv.clubId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);
  const pick = async (id: string) => {
    if (!id) return;
    try { const r = await api<{ text: string }>('POST', `/api/msg/conversations/${conv.id}/render`, { templateId: id }); setText(r.text); setTplId(id); } catch (e) { setErr(errText(e)); }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault(); if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const m = await api<Msg>('POST', `/api/msg/conversations/${conv.id}/messages`, { text, templateId: tplId ?? undefined });
      if (m.status !== 'sent') setErr(m.error ? `Не отправлено: ${m.error}. Повторим автоматически.` : 'Сообщение в очереди на отправку');
      setText(''); setTplId(null); load(); onSent?.();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const retry = async (id: string) => { try { await api('POST', `/api/msg/messages/${id}/retry`); load(); } catch (e) { setErr(errText(e)); } };
  void me;
  return (
    <div className="chat-pane">
      {!compact && (
        <div className="row between">
          <div className="row">{onBack && <button className="btn sm show-narrow" onClick={onBack}>←</button>}
            <div><b>{who(conv)}</b><div className="small">{MESSENGER[conv.messenger]} · {conv.channelName}{conv.messenger === 'whatsapp' ? ` · ${maskWa(conv.chatId)}` : ''}</div></div></div>
          {conv.personId && openPerson && <button className="btn sm" onClick={() => openPerson(conv.personId!)}>Карточка клиента</button>}
        </div>)}
      {conv.optOut && <div className="note">Клиент отписался от сообщений: автосообщения ему не уходят. Отвечать на его вопросы можно.</div>}
      <div className="msgs" style={compact ? { maxHeight: 320 } : undefined}>
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="bubble">{m.body}</div>
            <div className="small">{time(m.createdAt)}
              {m.direction === 'out' && <> · {m.auto ? (m.triggerEvent ? `автосообщение «${EVENT[m.triggerEvent]?.[0]}»` : 'автоответ') : m.authorName ?? ''}{STATUS[m.status] ? ` · ${STATUS[m.status]}` : ''}</>}
              {m.status === 'failed' && <> · <button className="link" onClick={() => retry(m.id)}>повторить</button></>}</div>
            {m.status === 'failed' && m.error && <div className="small bad">{m.error}</div>}
          </div>))}
        <div ref={end} />
      </div>
      {err && <div className="err">{err}</div>}
      <form onSubmit={send} className="composer">
        <select aria-label="Шаблон" value="" onChange={(e) => pick(e.target.value)}><option value="">Шаблон…</option>{tpl.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <textarea rows={compact ? 2 : 3} placeholder="Сообщение клиенту" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e as unknown as FormEvent); }} />
        <button className="btn pri" disabled={busy || !text.trim()}>Отправить</button>
      </form>
      {!compact && <div className="small">Отправить: ⌘ + Enter</div>}
    </div>
  );
}

/* ---------------- переписка в карточке клиента ---------------- */
export function PersonChats({ me, personId, homeClubId, marketingConsent, optOut, reload }: { me: Me; personId: string; homeClubId: string | null;
  marketingConsent: boolean; optOut: boolean; reload: () => void }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [err, setErr] = useState('');
  const load = () => api<Conv[]>('GET', `/api/msg/conversations?personId=${personId}`).then((x) => { setConvs(x); setOpen((o) => o ?? x[0]?.id ?? null); }).catch(() => {});
  useEffect(() => { load(); api<Channel[]>('GET', `/api/msg/channels${homeClubId ? `?clubId=${homeClubId}` : ''}`).then(setChannels).catch(() => {}); }, [personId]);
  const wa = channels.filter((c) => c.messenger === 'whatsapp' && c.status === 'active' && !convs.some((v) => v.channelId === c.id));
  const start = async (channelId: string) => {
    try { const r = await api<{ id: string }>('POST', `/api/persons/${personId}/conversations`, { channelId }); await load(); setOpen(r.id); } catch (e) { setErr(errText(e)); }
  };
  const setFlag = async (b: Record<string, boolean>, ok: string) => { try { await api('POST', `/api/persons/${personId}/messaging`, b); toast(ok); reload(); } catch (e) { setErr(errText(e)); } };
  const cur = convs.find((c) => c.id === open);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>Переписка</h2>
        <div className="row">{convs.length > 1 && convs.map((c) => <button key={c.id} className={`btn sm ${open === c.id ? 'pri' : ''}`} onClick={() => setOpen(c.id)}>{MESSENGER[c.messenger]} · {c.channelName}</button>)}
          {wa.map((c) => <button key={c.id} className="btn sm" onClick={() => start(c.id)}>Написать в WhatsApp ({c.name})</button>)}</div></div>
      {err && <div className="err">{err}</div>}
      {cur ? <ChatPane me={me} conv={cur} compact onSent={load} /> : <p className="small">Переписки пока нет.{!wa.length && ' В Telegram клиент пишет клубу первым.'}</p>}
      <div className="row" style={{ gap: 16 }}>
        <label className="row small"><input type="checkbox" style={{ width: 16, height: 16 }} checked={marketingConsent}
          onChange={(e) => setFlag({ marketingConsent: e.target.checked }, e.target.checked ? 'Согласие на рекламные сообщения отмечено' : 'Согласие снято')} />Согласен получать рекламные сообщения</label>
        <label className="row small"><input type="checkbox" style={{ width: 16, height: 16 }} checked={optOut}
          onChange={(e) => setFlag({ optOut: e.target.checked }, e.target.checked ? 'Автосообщения отключены' : 'Автосообщения включены')} />Отписался от автосообщений</label>
      </div>
    </div>
  );
}

/* ---------------- настройки ---------------- */
export function MessagingAdmin({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [view, setView] = useState('channels');
  void me;
  if (!club) return <p className="muted">Клубов нет.</p>;
  return (
    <>
      <div className="row between">
        <div className="tabs">{[['channels', 'Каналы'], ['triggers', 'Автосообщения'], ['templates', 'Шаблоны'], ['settings', 'Рабочее время и автоответ'], ['guide', 'Инструкция']]
          .map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{t}</button>)}</div>
        {clubId === 'all' && <select aria-label="Клуб" value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      </div>
      {view === 'channels' && <Channels key={club} clubId={club} />}
      {view === 'triggers' && <Triggers key={club} clubId={club} />}
      {view === 'templates' && <Templates key={club} clubId={club} />}
      {view === 'settings' && <Settings key={club} clubId={club} />}
      {view === 'guide' && <div className="card md"><Md text={guide} /></div>}
    </>
  );
}

const KIND_INFO: Record<string, { title: string; messengers: string[]; text: string; secret?: string; fields: [string, string][] }> = {
  telegram_bot: { title: 'Telegram-бот клуба', messengers: ['telegram'], secret: 'Токен бота от @BotFather', fields: [],
    text: 'Клиенты пишут боту клуба. Создайте бота в @BotFather и вставьте токен. Работает сразу, внешний адрес не нужен.' },
  green_api: { title: 'WhatsApp через Green-API', messengers: ['whatsapp'], secret: 'apiTokenInstance', fields: [['idInstance', 'Номер инстанса (idInstance)'], ['apiUrl', 'Адрес API (если в кабинете указан свой)']],
    text: 'Номер WhatsApp клуба подключается по QR-коду в кабинете Green-API. Работает сразу, внешний адрес не нужен.' },
  wazzup: { title: 'Wazzup (WhatsApp или Telegram)', messengers: ['whatsapp', 'telegram'], secret: 'Ключ API Wazzup', fields: [['channelId', 'Идентификатор канала (channelId)']],
    text: 'Подходит для личных номеров менеджеров. Входящие приходят на внешний адрес системы, поэтому заработает после переезда на сервер.' },
  test: { title: 'Тестовый канал', messengers: ['whatsapp', 'telegram'], fields: [], text: 'Для проверки: отправка всегда успешна, сообщение клиента можно сымитировать.' },
};

function Channels({ clubId }: { clubId: string }) {
  const [list, setList] = useState<Channel[]>([]);
  const [form, setForm] = useState<{ kind: string; messenger: string; name: string; secret: string; settings: Record<string, string> } | null>(null);
  const [sim, setSim] = useState<{ id: string; messenger: string; name: string; phone: string; text: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Channel[]>('GET', `/api/msg/channels?clubId=${clubId}`).then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [clubId]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const c = await api<{ id: string }>('POST', '/api/msg/channels', { clubId, ...form });
      const t = await api<{ ok: boolean; info: string }>('POST', `/api/msg/channels/${c.id}/test`);
      toast(t.info); setForm(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  const test = async (id: string) => { try { const t = await api<{ ok: boolean; info: string }>('POST', `/api/msg/channels/${id}/test`); toast(t.info); load(); } catch (e) { setErr(errText(e)); } };
  const botToggle = async (c: Channel) => {
    try { await api('PATCH', `/api/msg/channels/${c.id}`, { clientBot: !c.clientBot }); toast(c.clientBot ? 'Клиентский бот выключен' : 'Клиентский бот включён: клиенты видят абонемент, продлевают и замораживают его сами'); load(); } catch (e) { setErr(errText(e)); }
  };
  const toggle = async (c: Channel) => { try { await api('PATCH', `/api/msg/channels/${c.id}`, { status: c.status === 'active' ? 'disabled' : 'active' }); load(); } catch (e) { setErr(errText(e)); } };
  const simulate = async (e: FormEvent) => {
    e.preventDefault(); if (!sim) return; setErr('');
    try { await api('POST', `/api/msg/channels/${sim.id}/simulate`, sim); toast('Сообщение клиента получено: смотрите «Переписку»'); setSim(null); } catch (x) { setErr(errText(x)); }
  };
  const info = form ? KIND_INFO[form.kind] : null;
  return (
    <>
      {err && <div className="err">{err}</div>}
      <div className="card tbl">
        <div className="row between"><h2>Каналы клуба</h2>{!form && <button className="btn pri sm" onClick={() => setForm({ kind: 'telegram_bot', messenger: 'telegram', name: '', secret: '', settings: {} })}>Подключить канал</button>}</div>
        {!list.length ? <p className="muted">Каналов нет.</p> : (
          <table><thead><tr><th>Канал</th><th>Мессенджер</th><th>Подключение</th><th>Состояние</th><th /></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b>{c.webhookUrl && !c.polling && c.kind !== 'test' && <div className="small">Адрес для входящих: <code>{c.webhookUrl}</code></div>}
                  {c.messenger === 'telegram' && (c.kind === 'telegram_bot' || c.kind === 'test') && (
                    <label className="small row" style={{ gap: 6, marginTop: 4 }} title="Клиент делится номером и в боте видит абонемент и остаток, продлевает с оплатой онлайн и оформляет заморозку. Остальные сообщения, как и раньше, приходят в «Переписку»">
                      <input type="checkbox" checked={!!c.clientBot} onChange={() => botToggle(c)} style={{ width: 'auto' }} /> Клиентский бот: абонемент, продление, заморозка</label>)}</td>
                <td>{MESSENGER[c.messenger]}</td><td className="small">{c.kindName}</td>
                <td>{c.status !== 'active' ? <span className="chip">отключён</span> : c.lastError ? <span className="chip bad" title={c.lastError}>ошибка: {c.lastError}</span>
                  : <span className="chip ok">работает{c.lastOkAt ? `, ${dt(c.lastOkAt)}` : ''}</span>}</td>
                <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {c.kind === 'test' && c.status === 'active' && <button className="btn sm" onClick={() => setSim({ id: c.id, messenger: c.messenger, name: 'Анна Тестова', phone: c.messenger === 'whatsapp' ? '+7 916 000-00-01' : '', text: 'Здравствуйте! Сколько стоит абонемент?' })}>Написать от клиента</button>}
                  <button className="btn sm" onClick={() => test(c.id)}>Проверить</button>
                  <button className="btn sm" onClick={() => toggle(c)}>{c.status === 'active' ? 'Отключить' : 'Включить'}</button></div></td>
              </tr>))}</tbody></table>)}
      </div>
      {sim && (
        <form className="card" onSubmit={simulate} style={{ display: 'grid', gap: 8 }}>
          <h2>Сообщение от клиента (имитация)</h2>
          <div className="grid2"><label className="f">Имя в мессенджере<input value={sim.name} onChange={(e) => setSim({ ...sim, name: e.target.value })} /></label>
            <label className="f">{sim.messenger === 'whatsapp' ? 'Телефон' : 'Номер, которым клиент поделился (необязательно)'}<input value={sim.phone} onChange={(e) => setSim({ ...sim, phone: e.target.value })} /></label></div>
          <label className="f">Текст<input value={sim.text} onChange={(e) => setSim({ ...sim, text: e.target.value })} /></label>
          <div className="row"><button className="btn pri">Отправить в клуб</button><button type="button" className="btn" onClick={() => setSim(null)}>Отмена</button></div>
        </form>)}
      {form && info && (
        <form className="card" onSubmit={save} style={{ display: 'grid', gap: 10 }}>
          <h2>Подключить канал</h2>
          <div className="grid2">
            {Object.entries(KIND_INFO).map(([k, v]) => (
              <button type="button" key={k} className="card modecard" aria-pressed={form.kind === k}
                onClick={() => setForm({ ...form, kind: k, messenger: v.messengers.includes(form.messenger) ? form.messenger : v.messengers[0], settings: {} })}>
                <b>{v.title}</b><span className="small">{v.text}</span></button>))}
          </div>
          {info.messengers.length > 1 && <label className="f">Мессенджер<select className="f" value={form.messenger} onChange={(e) => setForm({ ...form, messenger: e.target.value })}>
            {info.messengers.map((m) => <option key={m} value={m}>{MESSENGER[m]}</option>)}</select></label>}
          <label className="f">Название в системе<input value={form.name} placeholder={`${MESSENGER[form.messenger]} клуба`} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          {info.fields.map(([k, l]) => <label key={k} className="f">{l}<input value={form.settings[k] ?? ''} onChange={(e) => setForm({ ...form, settings: { ...form.settings, [k]: e.target.value } })} /></label>)}
          {info.secret && <label className="f">{info.secret}<input type="password" autoComplete="off" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} /></label>}
          <p className="small">Токены хранятся в зашифрованном виде и больше не показываются. Подробно по шагам: вкладка «Инструкция».</p>
          <div className="row"><button className="btn pri">Подключить и проверить</button><button type="button" className="btn" onClick={() => setForm(null)}>Отмена</button></div>
        </form>)}
    </>
  );
}

function Triggers({ clubId }: { clubId: string }) {
  const [list, setList] = useState<Trigger[]>([]);
  const [tpl, setTpl] = useState<Template[]>([]);
  const [prev, setPrev] = useState<{ id: string; p: Preview } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Trigger[]>('GET', `/api/msg/triggers?clubId=${clubId}`).then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); api<Template[]>('GET', `/api/msg/templates?clubId=${clubId}`).then(setTpl).catch(() => {}); }, [clubId]);
  const upd = async (id: string, b: Partial<Trigger>) => { setErr(''); try { await api('PUT', `/api/msg/triggers/${id}`, b); load(); } catch (e) { setErr(errText(e)); } };
  const preview = async (id: string) => { try { setPrev({ id, p: await api<Preview>('GET', `/api/msg/triggers/${id}/preview`) }); } catch (e) { setErr(errText(e)); } };
  const run = async (id: string) => { try { const r = await api<Preview>('POST', `/api/msg/triggers/${id}/run`); toast(`Отправлено: ${r.sent}`); setPrev(null); load(); } catch (e) { setErr(errText(e)); } };
  return (
    <>
      <div className="note">Автосообщения уходят сами раз в день в выбранный час, только в рабочее время клуба. Одному клиенту — не больше лимита в неделю, повторно за тот же повод — никогда.
        Отписавшимся не уходят. Рекламные — только клиентам с согласием. По умолчанию всё выключено: включите нужные и посмотрите, кому уйдёт.</div>
      {err && <div className="err">{err}</div>}
      <div className="card tbl"><table>
        <thead><tr><th>Включено</th><th>Повод</th><th>Дней</th><th>Шаблон</th><th>Час</th><th>Рекламное</th><th>За 30 дней</th><th /></tr></thead>
        <tbody>{list.map((t) => (
          <tr key={t.id}>
            <td><input type="checkbox" style={{ width: 18, height: 18 }} checked={t.enabled} onChange={(e) => upd(t.id, { enabled: e.target.checked })} /></td>
            <td><b>{EVENT[t.event]?.[0]}</b>{EVENT[t.event]?.[1] && <div className="small">{EVENT[t.event][1]}</div>}</td>
            <td>{EVENT[t.event]?.[1] ? <input type="number" min={0} max={365} style={{ width: 70 }} defaultValue={t.days} onBlur={(e) => Number(e.target.value) !== t.days && upd(t.id, { days: Number(e.target.value) })} /> : '—'}</td>
            <td><select className="f" value={t.templateId} onChange={(e) => upd(t.id, { templateId: e.target.value })}>{tpl.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
            <td><select className="f" value={t.sendHour} onChange={(e) => upd(t.id, { sendHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}</select></td>
            <td><input type="checkbox" style={{ width: 18, height: 18 }} checked={t.marketing} onChange={(e) => upd(t.id, { marketing: e.target.checked })} /></td>
            <td className="num">{t.sent30}</td>
            <td className="r"><button className="btn sm" onClick={() => preview(t.id)}>Кому уйдёт сегодня</button></td>
          </tr>))}</tbody>
      </table></div>
      {prev && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="row between"><h2>{EVENT[list.find((x) => x.id === prev.id)?.event ?? '']?.[0]}: кому уйдёт сегодня</h2>
            <div className="row">{list.find((x) => x.id === prev.id)?.enabled && prev.p.ready.length > 0 && <button className="btn pri sm" onClick={() => run(prev.id)}>Отправить сейчас ({prev.p.ready.length})</button>}
              <button className="btn sm" onClick={() => setPrev(null)}>Закрыть</button></div></div>
          {!prev.p.ready.length && !prev.p.skipped.length && <p className="muted">Сегодня никому.</p>}
          {prev.p.ready.map((r) => <div key={r.personId} className="item"><b>{r.name}</b><div className="small">{r.text}</div></div>)}
          {prev.p.skipped.length > 0 && <><div className="lbl">Не уйдёт</div>{prev.p.skipped.map((r) => <div key={r.personId} className="small">{r.name}: {r.reason}</div>)}</>}
        </div>)}
    </>
  );
}

function Templates({ clubId }: { clubId: string }) {
  const [list, setList] = useState<Template[]>([]);
  const [edit, setEdit] = useState<{ id?: string; name: string; body: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Template[]>('GET', `/api/msg/templates?clubId=${clubId}`).then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [clubId]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!edit) return; setErr('');
    try {
      if (edit.id) await api('PATCH', `/api/msg/templates/${edit.id}`, { name: edit.name, body: edit.body });
      else await api('POST', '/api/msg/templates', { clubId, name: edit.name, body: edit.body });
      toast('Шаблон сохранён'); setEdit(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      {err && <div className="err">{err}</div>}
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Шаблоны сообщений</h2><button className="btn pri sm" onClick={() => setEdit({ name: '', body: '' })}>Новый шаблон</button></div>
        <p className="small">Подстановки: {'{имя}'}, {'{клуб}'}, {'{абонемент}'}, {'{дата_окончания}'}, {'{долг}'}, {'{дата_платежа}'}, {'{дней}'}. Система заменит их данными клиента.</p>
        {edit && (
          <form onSubmit={save} className="item" style={{ display: 'grid', gap: 8 }}>
            <label className="f">Название<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="f">Текст<textarea rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
            <div className="row"><button className="btn pri sm">Сохранить</button><button type="button" className="btn sm" onClick={() => setEdit(null)}>Отмена</button></div>
          </form>)}
        {list.map((t) => (
          <div key={t.id} className="item" style={{ opacity: t.isActive ? 1 : 0.55 }}>
            <div className="row between"><b>{t.name}</b>
              <div className="row">{t.event && <span className="chip acc">автосообщение: {EVENT[t.event]?.[0]}</span>}
                <button className="btn sm" onClick={() => setEdit({ id: t.id, name: t.name, body: t.body })}>Изменить</button>
                {!t.event && <button className="btn sm" onClick={() => api('PATCH', `/api/msg/templates/${t.id}`, { isActive: !t.isActive }).then(load)}>{t.isActive ? 'Скрыть' : 'Вернуть'}</button>}</div></div>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.body}</div>
          </div>))}
      </div>
    </>
  );
}

function Settings({ clubId }: { clubId: string }) {
  const [s, setS] = useState<{ workFrom: number; workTo: number; autoreplyEnabled: boolean; autoreplyText: string; maxAutoPerWeek: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<typeof s>('GET', `/api/msg/settings/${clubId}`).then(setS).catch((e) => setErr(errText(e))); }, [clubId]);
  if (!s) return <p className="muted">{err || 'Загрузка…'}</p>;
  const save = async (e: FormEvent) => { e.preventDefault(); setErr(''); try { await api('PUT', `/api/msg/settings/${clubId}`, s); toast('Сохранено'); } catch (x) { setErr(errText(x)); } };
  const hours = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
      <h2>Рабочее время переписки</h2>
      <div className="row">
        <label className="f">С<select className="f" value={s.workFrom} onChange={(e) => setS({ ...s, workFrom: Number(e.target.value) })}>{hours(0, 23).map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
        <label className="f">До<select className="f" value={s.workTo} onChange={(e) => setS({ ...s, workTo: Number(e.target.value) })}>{hours(1, 24).map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
      </div>
      <label className="row"><input type="checkbox" style={{ width: 18, height: 18 }} checked={s.autoreplyEnabled} onChange={(e) => setS({ ...s, autoreplyEnabled: e.target.checked })} />
        Автоответ на сообщения в нерабочее время (не чаще раза в 12 часов одному клиенту)</label>
      <label className="f">Текст автоответа<textarea rows={3} value={s.autoreplyText} onChange={(e) => setS({ ...s, autoreplyText: e.target.value })} /></label>
      <label className="f">Не больше автосообщений одному клиенту в неделю<input type="number" min={0} max={14} value={s.maxAutoPerWeek} onChange={(e) => setS({ ...s, maxAutoPerWeek: Number(e.target.value) })} /></label>
      {err && <div className="err">{err}</div>}
      <div><button className="btn pri">Сохранить</button></div>
    </form>
  );
}
