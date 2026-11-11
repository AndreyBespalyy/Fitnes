// Риск ухода: кто может не продлиться, почему, что сказать, что уже сделано и чем закончилось; настройки сценария.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Row = { personId: string; name: string; score: number; segment: string; reasons: { effect: string; text: string }[]; script: string | null; owner: string | null;
  actedAt: string | null; outcome: string | null; messaged: boolean; callDoneAt: string | null; callResult: string | null; lastVisit: string | null };
type Data = {
  settings: { enabled: boolean; message: boolean; cooldownDays: number; template: string }; canManage: boolean; list: Row[];
  stats: { scored: number; hot: number; warm: number; acted: number; messaged: number; returned: number; renewed: number; none: number; savedPct: number | null };
};
const OUT: Record<string, [string, string]> = { returned: ['пришёл в клуб', 'ok'], renewed: ['продлил', 'ok'], none: ['без изменений', 'bad'] };

export function ChurnView({ club, openPerson }: { club: string; openPerson: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [seg, setSeg] = useState<'hot' | 'warm'>('hot');
  const [edit, setEdit] = useState<Data['settings'] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Data>('GET', `/api/churn?clubId=${club}`).then(setData).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club]);
  if (!data) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const s = data.stats;
  const rows = data.list.filter((r) => r.segment === seg);
  const save = async () => { setErr(''); try { await api('PUT', '/api/churn/settings', { clubId: club, ...edit }); toast('Сохранено'); setEdit(null); load(); } catch (x) { setErr(errText(x)); } };
  const run = async () => { try { const r = await api<{ calls: number; messages: number }>('POST', '/api/churn/run', { clubId: club }); toast(`Звонков поручено: ${r.calls}, сообщений: ${r.messages}`); load(); } catch (x) { setErr(errText(x)); } };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0, maxWidth: 780 }}>
        Каждый день система оценивает риск, что клиент с действующим абонементом перестанет ходить и не продлится. Признаки: стал ходить реже, долгая пауза,
        частые заморозки, долг, низкая оценка клубу, первый месяц. Тем, у кого риск выше всего, уходит мягкое сообщение, а ответственному — звонок с подсказкой, что сказать.
        Абонементы, которые заканчиваются в ближайшие 30 дней, — в «Кому звонить» и «Досрочном продлении».
        {!data.settings.enabled && <b> Сценарий в клубе выключен: риск считается, но сообщения и звонки не назначаются.</b>}
      </p>
      {err && <div className="err">{err}</div>}
      {s.scored === 0 && <div className="item small">Риск не считается: в клубе нет данных о посещениях. Он появится, когда заработают проходы через турникет или ресепшн.</div>}
      <div className="kpis">
        <button className={`card kpi-c click ${seg === 'hot' ? 'on' : ''}`} aria-pressed={seg === 'hot'} onClick={() => setSeg('hot')} style={{ textAlign: 'left' }}><span className="lbl">Высокий риск</span><b className={`num ${s.hot ? 'bad' : ''}`}>{s.hot}</b><span className="small muted">из {s.scored} с абонементом</span></button>
        <button className={`card kpi-c click ${seg === 'warm' ? 'on' : ''}`} aria-pressed={seg === 'warm'} onClick={() => setSeg('warm')} style={{ textAlign: 'left' }}><span className="lbl">Средний риск</span><b className="num">{s.warm}</b><span className="small muted">только наблюдаем</span></button>
        <div className="card kpi-c"><span className="lbl">Сценарий за 60 дней</span><b className="num">{s.acted}</b><span className="small muted">сообщений {s.messaged}</span></div>
        <div className="card kpi-c"><span className="lbl">Удалось удержать</span><b className="num">{s.savedPct === null ? '—' : `${s.savedPct} %`}</b><span className="small muted">пришли {s.returned}, продлили {s.renewed}, без изменений {s.none}</span></div>
      </div>

      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>Никого.</p> : (
          <div className="tbl"><table>
            <thead><tr><th>Клиент</th><th>Риск</th><th>Почему</th><th>Что сказать</th><th>Что сделано</th></tr></thead>
            <tbody>{rows.map((r) => {
              const [ol, oc] = r.outcome ? OUT[r.outcome] : ['', ''];
              return (
                <tr key={r.personId}>
                  <td><button className="link" onClick={() => openPerson(r.personId)}>{r.name}</button>
                    <div className="small muted">{r.lastVisit ? `был ${dt(r.lastVisit)}` : 'не был'}{r.owner ? ` · ${r.owner}` : ''}</div></td>
                  <td>{Math.round(r.score * 100)} %</td>
                  <td className="small">{r.reasons.filter((x) => x.effect === '+').map((x) => x.text).join('; ') || '—'}</td>
                  <td className="small" style={{ maxWidth: 360 }}>{r.script}</td>
                  <td className="small">{r.actedAt ? <>
                    {dt(r.actedAt)}: {r.messaged ? 'сообщение и звонок' : 'звонок'}
                    {r.callDoneAt ? <div>позвонили{r.callResult ? `: ${r.callResult}` : ''}</div> : <div className="muted">звонок ещё не сделан</div>}
                    {r.outcome && <span className={`chip ${oc}`}>{ol}</span>}</> : <span className="muted">{seg === 'hot' ? 'в очереди' : '—'}</span>}</td>
                </tr>);
            })}</tbody>
          </table></div>)}
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Сценарий удержания</h2>
          {data.canManage && !edit && <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={run}>Запустить сейчас</button>
            <button className="btn sm pri" onClick={() => setEdit(data.settings)}>Настроить</button></div>}
        </div>
        {!edit ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>{data.settings.enabled ? 'Включён' : 'Выключен'}. Срабатывает в рабочее время клуба, не больше 50 клиентов в день.</li>
            <li>Мягкое сообщение: {data.settings.message ? <>«{data.settings.template}»</> : 'не отправляется, только звонок'}.</li>
            <li>Один и тот же клиент — не чаще раза в {data.settings.cooldownDays} дн. Итог смотрим 14 дней: пришёл в клуб, продлил или без изменений.</li>
          </ul>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />Сценарий включён</label>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={edit.message} onChange={(e) => setEdit({ ...edit, message: e.target.checked })} />Отправлять мягкое сообщение перед звонком</label>
            <label className="f">Текст сообщения<textarea rows={3} value={edit.template} onChange={(e) => setEdit({ ...edit, template: e.target.value })} /><span className="small">Можно использовать {'{имя}'} и {'{клуб}'}</span></label>
            <label className="f" style={{ maxWidth: 260 }}>Одного клиента не чаще, чем раз в (дней)<input type="number" value={edit.cooldownDays} onChange={(e) => setEdit({ ...edit, cooldownDays: Number(e.target.value) })} /></label>
            <div className="row" style={{ gap: 6 }}><button className="btn sm pri" onClick={save}>Сохранить</button><button className="btn sm" onClick={() => setEdit(null)}>Отмена</button></div>
          </div>)}
      </div>
    </div>
  );
}
