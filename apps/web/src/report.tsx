// Кнопка «Сообщить о проблеме» на каждом экране: обращение в поддержку с разделом, версией и последними сбоями (без данных клиентов).
import { useState } from 'react';
import { api, techLog } from './api.ts';
import { errText, toast } from './ui.ts';

export function ReportProblem({ tab, tabLabel, clubId, openHelp }: { tab: string; tabLabel: string; clubId: string; openHelp: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'bug' | 'question' | 'idea'>('bug');
  const [text, setText] = useState('');
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const log = techLog();
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const first = text.trim().split(/[.!?\n]/)[0].slice(0, 80) || 'Проблема';
      const r = await api<{ number: number }>('POST', '/api/support', {
        subject: `${tabLabel}: ${first}`, body: text.trim(), kind, clubId, page: tab,
        clientInfo: `web; ${window.innerWidth}×${window.innerHeight}; ${navigator.userAgent.slice(0, 200)}`,
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
        techLog: attach ? log : undefined,
      });
      toast(`Обращение № ${r.number} отправлено. Ответ придёт в «Помощь → Написать в поддержку»`);
      setOpen(false); setText('');
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <button className="report-btn" onClick={() => setOpen(true)} aria-label="Сообщить о проблеме" title="Сообщить о проблеме">?</button>
      {open && (
        <div className="modal-bg" role="dialog" aria-modal="true" aria-label="Сообщить о проблеме" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="card modal" style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
            <div className="row between"><h2 style={{ margin: 0 }}>Сообщить о проблеме</h2><button className="btn sm" onClick={() => setOpen(false)} aria-label="Закрыть">×</button></div>
            <div className="tabs" role="group" aria-label="Что случилось">
              {([['bug', 'Что-то не работает'], ['question', 'Вопрос'], ['idea', 'Идея']] as const).map(([k, l]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
            </div>
            <label className="f">Раздел «{tabLabel}». Что произошло?
              <textarea rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'bug' ? 'Что делали, что ожидали и что получилось. Например: нажала «Оплатить», выдало ошибку' : kind === 'idea' ? 'Что было бы удобно' : 'Ваш вопрос'} /></label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={attach} onChange={(e) => setAttach(e.target.checked)} />
              Приложить технические сведения ({log.length ? `последние сбои: ${log.length}` : 'сбоев не было'}, версия, размер экрана). Данные клиентов не передаются.</label>
            {attach && log.length > 0 && <details><summary className="small muted">Что будет приложено</summary>
              {log.slice(-8).map((e, i) => <div key={i} className="small muted">{e.at.slice(11, 19)} · {e.text.replace(/\?[^\s]*/g, '')}</div>)}</details>}
            {err && <div className="err">{err}</div>}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn pri" disabled={busy || text.trim().length < 5} onClick={send}>{busy ? 'Отправляю…' : 'Отправить'}</button>
              <button className="btn" onClick={() => { setOpen(false); openHelp(); }}>Мои обращения</button>
            </div>
          </div>
        </div>)}
    </>
  );
}
