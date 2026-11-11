// Защита входа: обязательные личные пароли, массовая выдача временных паролей, подозрительные адреса.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type U = { id: string; fullName: string; login: string; status: string; mustChange: boolean; own: boolean; changedAt: string | null; lastLoginAt: string | null; owner: boolean; roles: string | null };
type Ip = { ip: string; fails: number; oks: number; logins: number; lastAt: string; stopped: boolean; suspicious: boolean };
type Data = { required: boolean; users: U[]; ips: Ip[]; alerts: { ip: string; at: string }[]; limits: { ipMaxFails: number; windowMin: number; alertLogins: number } };

export function LoginSecurity({ selfId }: { selfId: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [issued, setIssued] = useState<{ fullName: string; login: string; tempPassword: string }[] | null>(null);
  const load = () => api<Data>('GET', '/api/security/login').then(setD).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, []);
  if (err && !d) return null; // раздел только для собственника и администратора сети
  if (!d) return null;
  const notOwn = d.users.filter((u) => u.status === 'active' && !u.own && u.id !== selfId);
  const toggle = async () => {
    try { await api('PUT', '/api/security/login', { required: !d.required }); toast(d.required ? 'Обязательные личные пароли выключены' : 'Теперь каждый при входе задаёт свой пароль'); load(); } catch (x) { setErr(errText(x)); }
  };
  const reset = async () => {
    if (!pick.size) return;
    try { const r = await api<{ issued: NonNullable<typeof issued> }>('POST', '/api/security/login/reset', { userIds: [...pick] }); setIssued(r.issued); setPick(new Set()); load(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2>Защита входа</h2>
      {err && <div className="err">{err}</div>}
      <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div><b>Личные пароли обязательны</b>
          <div className="small muted">Если включено, сотрудник, который ни разу не задавал свой пароль или входит с простым паролем, при входе обязан сменить его. Так общий тестовый пароль перестаёт работать для всех сразу.</div></div>
        <button className={`btn sm ${d.required ? '' : 'pri'}`} onClick={toggle}>{d.required ? 'Выключить' : 'Включить'}</button>
      </div>
      <div className="small">{notOwn.length ? <>Ещё не задали свой пароль: <b>{notOwn.length}</b> из {d.users.filter((u) => u.status === 'active').length} активных.</> : 'Все активные сотрудники задали свои пароли.'}</div>

      {issued && (
        <div className="card" style={{ borderColor: 'var(--accent)', display: 'grid', gap: 6 }}>
          <b>Передайте каждому его временный пароль</b>
          <div className="tbl"><table><thead><tr><th>Сотрудник</th><th>Логин</th><th>Временный пароль</th></tr></thead>
            <tbody>{issued.map((x) => <tr key={x.login}><td>{x.fullName}</td><td className="num">{x.login}</td><td><span className="secret">{x.tempPassword}</span></td></tr>)}</tbody></table></div>
          <span className="small">Пароли показываются один раз. При первом входе каждый задаст свой. Все прежние сеансы этих сотрудников завершены.</span>
          <div><button className="btn sm" onClick={() => setIssued(null)}>Готово, передал</button></div>
        </div>)}

      {notOwn.length > 0 && (
        <details>
          <summary className="small">Выдать временные пароли тем, кто не задал свой ({notOwn.length})</summary>
          <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={pick.size === notOwn.length} onChange={(e) => setPick(e.target.checked ? new Set(notOwn.map((u) => u.id)) : new Set())} />выбрать всех</label>
            {notOwn.map((u) => (
              <label key={u.id} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={pick.has(u.id)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(u.id); else n.delete(u.id); setPick(n); }} />
                {u.fullName} <span className="muted">· {u.login} · {u.roles ?? ''} · {u.lastLoginAt ? `входил ${dt(u.lastLoginAt)}` : 'не входил'}</span>
              </label>))}
            <div><button className="btn sm pri" disabled={!pick.size} onClick={reset}>Выдать временные пароли ({pick.size})</button></div>
          </div>
        </details>)}

      <b className="small">Попытки входа с чужих адресов</b>
      <span className="small muted">С одного адреса можно ошибиться {d.limits.ipMaxFails} раз за {d.limits.windowMin} минут, дальше вход с него ставится на паузу. Если с адреса пробуют {d.limits.alertLogins} и больше разных логинов, собственнику и администратору приходит сигнал в Telegram. Учётная запись дополнительно блокируется на 15 минут после 5 неверных паролей подряд.</span>
      {d.ips.length ? (
        <div className="tbl"><table><thead><tr><th>Адрес</th><th className="num">Неудач</th><th className="num">Логинов</th><th className="num">Удачных входов</th><th>Последняя</th><th /></tr></thead>
          <tbody>{d.ips.map((x) => <tr key={x.ip}><td className="num">{x.ip}</td><td className="num">{x.fails}</td><td className="num">{x.logins}</td><td className="num">{x.oks}</td><td className="small">{dt(x.lastAt)}</td>
            <td>{x.stopped && <span className="chip bad">на паузе</span>} {x.suspicious && <span className="chip warn">похоже на подбор</span>}</td></tr>)}</tbody></table></div>
      ) : <span className="small muted">За неделю подозрительных попыток не было.</span>}
    </div>
  );
}
