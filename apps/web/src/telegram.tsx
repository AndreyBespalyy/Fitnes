// Telegram сотрудника (утренняя сводка и уведомления) и настройка бота сотрудников собственником.
import { useEffect, useState } from 'react';
import { api, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type MyTg = { botReady: boolean; username: string | null; link: { tgName: string | null; summary: boolean; linkedAt: string } | null; getsSummary: boolean; summaryHour: number };
type Bot = { configured: boolean; username: string | null; enabled: boolean; summaryEnabled: boolean; summaryHour: number; lastError: string | null;
  staff: { id: string; name: string; tgName: string | null; summary: boolean; linkedAt: string; getsSummary: boolean }[] };

/** Превращает HTML Telegram в безопасный текст для предпросмотра */
const plain = (html: string) => html.replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1').replace(/<\/?b>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function TelegramBlock({ me }: { me: Me }) {
  const [d, setD] = useState<MyTg | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<MyTg>('GET', '/api/me/telegram').then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const connect = async () => {
    setErr('');
    try {
      const r = await api<{ url: string }>('POST', '/api/me/telegram/link');
      window.open(r.url, '_blank', 'noopener');
      toast('Нажмите «Старт» в Telegram, затем вернитесь сюда');
      // Привязка подтверждается ботом в течение минуты
      let n = 0; const t = setInterval(async () => { n++; const x = await api<MyTg>('GET', '/api/me/telegram').catch(() => null); if (x?.link || n > 30) { clearInterval(t); if (x) setD(x); } }, 5000);
    } catch (x) { setErr(errText(x)); }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); toast(ok); load(); } catch (x) { setErr(errText(x)); } };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>Telegram</h2>
      <p className="small muted" style={{ margin: 0 }}>
        {d.getsSummary ? `Каждое утро в ${d.summaryHour}:00 сюда приходит сводка: выручка вчера и с начала месяца против плана, продажи, продления, ушедшие, долги, жалобы, отклонения и три дела на сегодня. ` : ''}
        Также в Telegram приходят важные служебные уведомления.
      </p>
      {!d.botReady && <p className="small warn" style={{ margin: 0 }}>Бот сотрудников ещё не подключён. {me.allClubs ? 'Подключите его ниже, в блоке «Бот сотрудников в Telegram».' : 'Его подключает собственник.'}</p>}
      {d.botReady && !d.link && <div><button className="btn pri" onClick={connect}>Подключить Telegram</button></div>}
      {d.link && (
        <>
          <div className="small">Подключён{d.link.tgName ? `: ${d.link.tgName}` : ''} · {dt(d.link.linkedAt)}</div>
          {d.getsSummary && <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={d.link.summary} onChange={(x) => act(() => api('PUT', '/api/me/telegram', { summary: x.target.checked }), x.target.checked ? 'Сводка включена' : 'Сводка отключена')} /> Присылать утреннюю сводку</label>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {d.getsSummary && <button className="btn sm" onClick={() => act(() => api('POST', '/api/morning-summary/send-me'), 'Сводка отправлена в Telegram')}>Прислать сводку сейчас</button>}
            <button className="btn sm" onClick={() => { if (confirm('Отключить Telegram? Сводка и уведомления перестанут приходить.')) act(() => api('DELETE', '/api/me/telegram'), 'Telegram отключён'); }}>Отключить</button>
          </div>
        </>
      )}
      {d.getsSummary && <div><button className="btn sm" onClick={() => preview ? setPreview(null) : api<{ text: string }>('GET', '/api/morning-summary/preview').then((r) => setPreview(plain(r.text))).catch((x) => setErr(errText(x)))}>{preview ? 'Скрыть пример' : 'Как выглядит сводка'}</button></div>}
      {preview && <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 10, background: 'var(--bg)', borderRadius: 8, fontFamily: 'inherit' }}>{preview}</pre>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

export function StaffBotBlock() {
  const [b, setB] = useState<Bot | null>(null);
  const [token, setToken] = useState('');
  const [hour, setHour] = useState(8);
  const [summaryOn, setSummaryOn] = useState(true);
  const [err, setErr] = useState('');
  const load = () => api<Bot>('GET', '/api/staff-bot').then((r) => { setB(r); setHour(r.summaryHour); setSummaryOn(r.summaryEnabled); }).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  if (!b) return null;
  const save = async () => {
    setErr('');
    try { const r = await api<{ username: string | null }>('PUT', '/api/staff-bot', { token: token || undefined, summaryHour: hour, summaryEnabled: summaryOn, enabled: true }); setToken(''); toast(r.username ? `Бот @${r.username} подключён` : 'Сохранено'); load(); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>Бот сотрудников в Telegram</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Один бот на всю сеть: через него собственник и управляющие получают утреннюю сводку, а сотрудники — служебные уведомления.
        Создайте бота в Telegram у @BotFather (команда /newbot), скопируйте токен и вставьте сюда. Токен хранится в зашифрованном виде и больше нигде не показывается.
        Не используйте бота, который уже подключён для переписки с клиентами.
      </p>
      {b.configured && <div className="small">Подключён бот <b>@{b.username}</b>{b.lastError ? <span className="bad"> · ошибка: {b.lastError}</span> : ''}</div>}
      <label className="f">{b.configured ? 'Заменить токен' : 'Токен бота'}<input type="password" autoComplete="off" placeholder="123456789:AA…" value={token} onChange={(x) => setToken(x.target.value)} /></label>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={summaryOn} onChange={(x) => setSummaryOn(x.target.checked)} /> Отправлять утреннюю сводку</label>
      <label className="f">Время сводки (по времени клуба)<select value={hour} onChange={(x) => setHour(Number(x.target.value))}>{[5, 6, 7, 8, 9, 10, 11, 12].map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
      <div><button className="btn pri" onClick={save}>Сохранить</button></div>
      {err && <div className="err">{err}</div>}
      {b.staff.length > 0 && (
        <div className="tbl"><table><thead><tr><th>Подключили Telegram</th><th>Сводка</th></tr></thead>
          <tbody>{b.staff.map((s) => <tr key={s.id}><td>{s.name}<div className="small muted">{s.tgName ?? ''}</div></td><td className="small">{s.getsSummary ? (s.summary ? 'получает' : 'отключил') : '—'}</td></tr>)}</tbody></table></div>
      )}
      {b.configured && !b.staff.length && <p className="small muted" style={{ margin: 0 }}>Пока никто не подключился. Каждый сотрудник подключает свой Telegram сам, в «Профиле».</p>}
    </div>
  );
}
