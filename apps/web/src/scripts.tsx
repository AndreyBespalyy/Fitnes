// «Отдел продаж → Скрипты звонков» (проверка CRM 17.11.2026, п. 4): тексты скриптов больше не вшиты в программу.
// РОП или управляющий правит их для своего клуба; по ним работают кнопка «Показать скрипт звонка» и разборы звонков Дяди Вити.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Line = [string, string];
type Item = { id: string; text: string; how: string };
type Script = { code: string; title: string; custom: boolean; updatedAt: string | null; lines: Line[]; ifSays: Line[]; never: string; steps: Item[]; neverItems: Item[] };

// В поле — по строке на пункт: «Этап — текст» и «Пункт проверки | как сказать правильно»
const linesToText = (l: Line[]) => l.map(([a, b]) => `${a} — ${b}`).join('\n');
const textToLines = (t: string): Line[] => t.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf(' — '); return (i > 0 ? [s.slice(0, i), s.slice(i + 3)] : ['Этап', s]) as Line; });
const itemsToText = (l: Item[]) => l.map((x) => `${x.text} | ${x.how}`).join('\n');
const textToItems = (t: string, old: Item[]): Item[] => t.split('\n').map((s) => s.trim()).filter(Boolean).map((s, i) => {
  const [text, how = ''] = s.split(' | '); const same = old.find((o) => o.text === text.trim());
  return { id: same?.id ?? old[i]?.id ?? '', text: text.trim(), how: how.trim() };
});

export function CallScripts({ clubId }: { clubId: string }) {
  const [d, setD] = useState<{ items: Script[]; canEdit: boolean } | null>(null);
  const [code, setCode] = useState('lead');
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<{ items: Script[]; canEdit: boolean }>('GET', `/api/call-scripts?clubId=${clubId}`).then((x) => { setD(x); setErr(''); }).catch((x) => setErr(errText(x)));
  useEffect(() => { setD(null); void load(); }, [clubId]);
  const s = d?.items.find((x) => x.code === code);
  useEffect(() => { if (s) setF({ lines: linesToText(s.lines), ifSays: linesToText(s.ifSays), never: s.never, steps: itemsToText(s.steps), neverItems: itemsToText(s.neverItems) }); }, [s?.code, d]);
  if (!d || !s || !f) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const ro = !d.canEdit;
  const save = async () => {
    setErr('');
    try {
      await api('PUT', '/api/call-scripts', { clubId, code, lines: textToLines(f.lines), ifSays: textToLines(f.ifSays), never: f.never,
        steps: textToItems(f.steps, s.steps), neverItems: textToItems(f.neverItems, s.neverItems) });
      toast('Скрипт сохранён: по нему работают «Показать скрипт» и разборы звонков'); void load();
    } catch (x) { setErr(errText(x)); }
  };
  const reset = async () => { try { await api('DELETE', `/api/call-scripts?clubId=${clubId}&code=${code}`); toast('Вернули стандартный текст'); void load(); } catch (x) { setErr(errText(x)); } };
  const area = (k: string, label: string, hint: string, rows = 8) => (
    <label className="f">{label}<span className="small muted">{hint}</span>
      <textarea rows={rows} value={f[k]} readOnly={ro} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="small muted" style={{ margin: 0 }}>Один скрипт на клуб — для кнопки «Показать скрипт звонка» и для разборов звонков Дяди Вити.
        Подстановки: {'{к}'} — имя клиента, {'{я}'} — имя менеджера, {'{когда}'} — день и время встречи, {'{до}'} — окончание абонемента, {'{адрес}'} — адрес клуба из карточки клуба.</p>
      <div className="tabs" role="group" aria-label="Скрипт">{d.items.map((x) => <button key={x.code} aria-pressed={code === x.code} onClick={() => setCode(x.code)}>{x.title}{x.custom ? ' ✎' : ''}</button>)}</div>
      <div className={`card${ro ? ' ro-view' : ''}`} style={{ display: 'grid', gap: 10 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0 }}>{s.title}</h2>
          <span className="small muted">{s.custom ? `изменён ${dt(s.updatedAt!)}` : 'стандартный текст'}</span></div>
        {area('lines', 'Что говорить', 'По строке на этап: «Этап — текст».', 10)}
        {area('ifSays', 'Если клиент говорит', 'По строке: «Что сказал — что ответить».', 6)}
        {area('never', 'Чего не говорить (коротко, для менеджера)', '', 2)}
        {area('steps', 'Что проверяет Дядя Витя в разговоре', 'По строке: «Этап разговора | как сказать правильно». Пропущенный этап попадёт в разбор менеджеру и в рейтинг.', 8)}
        {area('neverItems', 'Что нельзя говорить (проверка)', 'По строке: «Не прозвучало: фраза | как сказать вместо неё».', 4)}
        {err && <div className="err">{err}</div>}
        {!ro && <div className="row"><button className="btn pri" onClick={() => void save()}>Сохранить скрипт</button>
          {s.custom && <button className="btn" onClick={() => void reset()}>Вернуть стандартный</button>}</div>}
        {ro && <p className="small muted" style={{ margin: 0 }}>Скрипт меняют РОП и управляющий клуба.</p>}
      </div>
    </div>
  );
}
