// Приём заявок: подключения сайта, Tilda, VK и Авито со своей ссылкой, инструкция для каждого и журнал.
import { useEffect, useState } from 'react';
import { api, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Kind = 'site' | 'tilda' | 'vk' | 'avito';
type Intake = { id: string; clubId: string; sourceId: string; sourceName: string; kind: Kind; name: string; tokenHint: string; isActive: boolean; createdAt: string; lastAt: string | null; leads: number; errors: number;
  settings: { confirmation: string | null; groupId: string | null; hasSecret: boolean; clientId: string | null; hasClientSecret: boolean; avitoUserId: string | null; webhookAt: string | null } };
type Data = { list: Intake[]; log: { at: string; status: string; message: string | null; intake: string; person: string | null; personId: string | null }[]; sources: { id: string; name: string }[]; kinds: { kind: Kind; name: string }[] };
const ST: Record<string, [string, string]> = { lead: ['лид', 'ok'], duplicate: ['дубль', ''], test: ['проверка', 'acc'], skipped: ['пропущено', ''], error: ['ошибка', 'bad'], limited: ['лимит', 'warn'] };

function snippet(url: string) {
  return `<form id="club-lead" style="display:grid;gap:8px;max-width:360px">
  <input name="name" placeholder="Имя" required>
  <input name="phone" type="tel" placeholder="Телефон" required>
  <input name="website" style="display:none" tabindex="-1" autocomplete="off">
  <label><input type="checkbox" name="consent" required> Согласен на обработку персональных данных</label>
  <button>Записаться</button>
  <div id="club-lead-msg"></div>
</form>
<script>
document.getElementById('club-lead').onsubmit = async function (e) {
  e.preventDefault(); var f = this, m = document.getElementById('club-lead-msg');
  var r = await fetch('${url}', { method: 'POST', body: new URLSearchParams(new FormData(f)) });
  var j = await r.json().catch(function () { return {}; });
  m.textContent = j.message || (r.ok ? 'Спасибо! Мы свяжемся с вами' : 'Не удалось отправить, позвоните нам');
  if (r.ok) f.reset();
};
</script>`;
}

function Howto({ kind, url, intake, onConnected }: { kind: Kind; url: string; intake: Intake; onConnected: () => void }) {
  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast('Скопировано')).catch(() => null);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try { await api('POST', `/api/intake/${intake.id}/avito/connect`, { url }); toast('Авито подключён: новые сообщения станут заявками'); onConnected(); } catch (x) { toast(errText(x)); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--accent)', display: 'grid', gap: 8 }}>
      <b>Ссылка подключения «{intake.name}»</b>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="secret" style={{ wordBreak: 'break-all' }}>{url}</span><button className="btn sm" onClick={() => copy(url)}>Копировать</button></div>
      <span className="small">Ссылка показывается один раз: сохраните её там, куда вставляете. Если потеряете — выпустите новую, старая перестанет работать.</span>
      {kind === 'site' && <>
        <span className="small"><b>Как подключить.</b> Вставьте этот код на страницу сайта, где нужна форма. Имя, телефон и комментарий попадут в лиды клуба с источником «{intake.sourceName}». Если на сайте уже есть своя форма, пусть она отправляет поля name, phone, email, comment методом POST на ссылку выше.</span>
        <textarea readOnly rows={8} value={snippet(url)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        <div><button className="btn sm" onClick={() => copy(snippet(url))}>Копировать код формы</button></div>
      </>}
      {kind === 'tilda' && <span className="small"><b>Как подключить.</b> В Tilda: Настройки сайта → Формы → Другое → Webhook. Вставьте ссылку в поле «Адрес», нажмите «Добавить»: Tilda отправит проверочный запрос, он появится в журнале как «проверка». Затем в каждой нужной форме на вкладке «Контент» отметьте сервис Webhook. Поля Name, Phone, Email и метки UTM распознаются сами, остальные поля попадут в комментарий.</span>}
      {kind === 'vk' && <span className="small"><b>Как подключить.</b> В сообществе VK: Управление → Работа с API → Callback API. Выберите последнюю версию API, вставьте ссылку в поле «Адрес». Строку, которую VK просит вернуть, впишите в поле «Строка подтверждения» у этого подключения ниже и сохраните, затем нажмите «Подтвердить» в VK. Там же задайте «Секретный ключ» и впишите его сюда. На вкладке «Типы событий» отметьте «Формы сбора заявок: новая заявка».</span>}
      {kind === 'avito' && <>
        <span className="small"><b>Как подключить.</b> Client ID и Client Secret берутся в кабинете Авито: «Для профессионалов» → «Интеграции» (API). Мы уже сохранили их у этого подключения. Нажмите кнопку: система получит доступ и подпишется на новые сообщения. Каждое новое обращение покупателя станет заявкой (одна в день на переписку), отвечать по-прежнему в мессенджере Авито.</span>
        <div><button className="btn pri sm" disabled={busy || !intake.settings.hasClientSecret} onClick={connect}>{busy ? 'Подключаю…' : 'Подключить Авито'}</button></div>
      </>}
    </div>
  );
}

export function IntakePage({ clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); else if (!club && clubs[0]) setClub(clubs[0].id); }, [clubId, clubs]);
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [kind, setKind] = useState<Kind>('site');
  const [name, setName] = useState('');
  const [set, setSet] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<{ url: string; id: string } | null>(null);
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({});
  const load = () => club && api<Data>('GET', `/api/intake?clubId=${club}`).then((x) => { setD(x); setErr(''); }).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); }, [club]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const create = async () => {
    try {
      const r = await api<{ intake: Intake; url: string }>('POST', '/api/intake', { clubId: club, kind, name: name || undefined, settings: set });
      setShown({ url: r.url, id: r.intake.id }); setName(''); setSet({}); load();
    } catch (x) { setErr(errText(x)); }
  };
  const put = async (i: Intake, body: object, msg: string) => { try { await api('PUT', `/api/intake/${i.id}`, body); toast(msg); load(); } catch (x) { setErr(errText(x)); } };
  const reissue = async (i: Intake) => { try { const r = await api<{ url: string }>('POST', `/api/intake/${i.id}/token`); setShown({ url: r.url, id: i.id }); } catch (x) { setErr(errText(x)); } };
  const shownIntake = shown && d.list.find((x) => x.id === shown.id);
  const field = (k: string, label: string, ph: string, type = 'text') => <label className="f">{label}<input type={type} value={set[k] ?? ''} onChange={(e) => setSet({ ...set, [k]: e.target.value })} placeholder={ph} /></label>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Приём заявок</h2>
        {clubs.length > 1 && <select value={club} onChange={(e) => setClub(e.target.value)} aria-label="Клуб" style={{ width: 'auto' }}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      </div>
      <div className="small muted">Заявки с сайта, Tilda, VK и Авито сразу становятся лидами клуба: с источником, проверкой на дубли по телефону и задачей первого ответа менеджеру.</div>
      {err && <div className="err">{err}</div>}
      {shown && shownIntake && <Howto kind={shownIntake.kind} url={shown.url} intake={shownIntake} onConnected={load} />}
      {shown && <div><button className="btn sm" onClick={() => setShown(null)}>Готово, ссылку сохранил</button></div>}

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <b>Новое подключение</b>
        <div className="tabs" role="group" aria-label="Откуда">{d.kinds.map((k) => <button key={k.kind} aria-pressed={kind === k.kind} onClick={() => { setKind(k.kind); setSet({}); }}>{k.name}</button>)}</div>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', alignItems: 'end' }}>
          <label className="f">Название (необязательно)<input value={name} onChange={(e) => setName(e.target.value)} placeholder={d.kinds.find((k) => k.kind === kind)?.name} /></label>
          {kind === 'vk' && <>{field('groupId', 'ID сообщества', '123456')}{field('confirmation', 'Строка подтверждения', 'например, a1b2c3d4')}{field('secret', 'Секретный ключ', 'задайте в VK и впишите сюда', 'password')}</>}
          {kind === 'avito' && <>{field('clientId', 'Client ID', 'из кабинета Авито')}{field('clientSecret', 'Client Secret', 'хранится зашифрованным', 'password')}</>}
        </div>
        <div><button className="btn pri sm" disabled={!club || (kind === 'avito' && (!set.clientId || !set.clientSecret))} onClick={create}>Создать подключение</button></div>
      </div>

      {d.list.length > 0 && <div className="card" style={{ display: 'grid', gap: 8 }}>
        <b>Подключения клуба</b>
        {d.list.map((i) => {
          const e = edit[i.id];
          return (
            <div key={i.id} className="item" style={{ display: 'grid', gap: 6, opacity: i.isActive ? 1 : 0.6 }}>
              <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span><b>{i.name}</b> <span className="small muted">{d.kinds.find((k) => k.kind === i.kind)?.name !== i.name && `· ${d.kinds.find((k) => k.kind === i.kind)?.name} `}· источник «{i.sourceName}» · ссылка …{i.tokenHint}</span></span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => reissue(i)}>Новая ссылка</button>
                  {(i.kind === 'vk' || i.kind === 'avito') && <button className="btn sm" onClick={() => setEdit({ ...edit, [i.id]: e ? (undefined as unknown as Record<string, string>) : {} })}>Настройки</button>}
                  <button className="btn sm" onClick={() => put(i, { isActive: !i.isActive }, i.isActive ? 'Подключение выключено' : 'Подключение включено')}>{i.isActive ? 'Выключить' : 'Включить'}</button>
                </span>
              </div>
              <span className="small">Лидов: <b>{i.leads}</b> · ошибок: {i.errors} · последняя заявка: {i.lastAt ? dt(i.lastAt) : 'ещё не было'}
                {i.kind === 'vk' && ` · строка подтверждения: ${i.settings.confirmation ?? 'не задана'} · секретный ключ: ${i.settings.hasSecret ? 'задан' : 'не задан'}`}
                {i.kind === 'avito' && ` · ${i.settings.webhookAt ? `подключено ${dt(i.settings.webhookAt)}` : 'ещё не подключено: выпустите новую ссылку и нажмите «Подключить Авито»'}`}</span>
              {e && <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
                {i.kind === 'vk' && <>
                  <label className="f">Строка подтверждения<input value={e.confirmation ?? i.settings.confirmation ?? ''} onChange={(x) => setEdit({ ...edit, [i.id]: { ...e, confirmation: x.target.value } })} /></label>
                  <label className="f">Секретный ключ<input type="password" value={e.secret ?? ''} placeholder={i.settings.hasSecret ? 'задан, введите новый' : ''} onChange={(x) => setEdit({ ...edit, [i.id]: { ...e, secret: x.target.value } })} /></label></>}
                {i.kind === 'avito' && <>
                  <label className="f">Client ID<input value={e.clientId ?? i.settings.clientId ?? ''} onChange={(x) => setEdit({ ...edit, [i.id]: { ...e, clientId: x.target.value } })} /></label>
                  <label className="f">Client Secret<input type="password" value={e.clientSecret ?? ''} placeholder="задан, введите новый" onChange={(x) => setEdit({ ...edit, [i.id]: { ...e, clientSecret: x.target.value } })} /></label></>}
                <button className="btn sm pri" onClick={() => { put(i, { settings: e }, 'Настройки сохранены'); setEdit({ ...edit, [i.id]: undefined as unknown as Record<string, string> }); }}>Сохранить</button>
              </div>}
              <label className="row small" style={{ gap: 6 }}>Источник для отчётов:
                <select value={i.sourceId} onChange={(x) => put(i, { sourceId: x.target.value }, 'Источник изменён')} style={{ width: 'auto' }}>{d.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            </div>);
        })}
      </div>}

      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <b>Журнал приёма</b>
        {d.log.length ? <div className="tbl"><table><thead><tr><th>Когда</th><th>Подключение</th><th>Итог</th><th>Клиент</th><th>Подробности</th></tr></thead>
          <tbody>{d.log.map((l, i) => <tr key={i}><td className="small">{dt(l.at)}</td><td className="small">{l.intake}</td><td><span className={`chip ${ST[l.status]?.[1] ?? ''}`}>{ST[l.status]?.[0] ?? l.status}</span></td>
            <td>{l.personId ? <button className="link" onClick={() => openPerson(l.personId!)}>{l.person}</button> : '—'}</td><td className="small">{l.message}</td></tr>)}</tbody></table></div>
          : <span className="small muted">Заявок ещё не было.</span>}
      </div>
    </div>
  );
}
