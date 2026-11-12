// Раздел CRM «Мессенджер»: рабочая переписка сотрудников и приглашения в приложение-мессенджер на телефоне.
// Решение Андрея 12.11.2026: вся рабочая связь — внутри CRM, а не в Telegram.
import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api, can, navParams, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { TeamChat } from './team/chat.tsx';
import './team/team.css';

export function TeamPage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [view, setView] = useState<'chats' | 'invite'>(() => (navParams('team').view === 'invite' ? 'invite' : 'chats'));
  const [chat] = useState(() => navParams('team').chat ?? new URLSearchParams(location.search).get('chat'));
  const canInvite = can(me, 'staff.manage');
  return (
    <>
      <div className="row between">
        <div><div className="lbl">Рабочая связь внутри CRM</div><h1>Мессенджер</h1></div>
        {canInvite && (
          <div className="tabs" role="group" aria-label="Мессенджер">
            <button aria-pressed={view === 'chats'} onClick={() => setView('chats')}>Чаты</button>
            <button aria-pressed={view === 'invite'} onClick={() => setView('invite')}>Приложение для сотрудников</button>
          </div>
        )}
      </div>
      {view === 'chats' ? <TeamChat meId={me.id} initialChat={chat} /> : <Invites me={me} clubs={clubs} clubId={clubId} />}
    </>
  );
}

export function Qr({ text, cell = 4 }: { text: string; cell?: number }) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return <img src={q.createDataURL(cell, 0)} alt={`QR-код: ${text}`} />;
}

type InvPerson = { id: string; fullName: string; login: string; roles: string | null; appPlatform: string | null; appFirstAt: string | null; appLastAt: string | null; push: boolean;
  inviteId: string | null; link: string | null; invitedAt: string | null; openedAt: string | null; openCount: number | null };
type InvData = { people: InvPerson[]; general: { id: string; link: string; createdAt: string; openCount: number } | null; appLink: string };
type Created = { userId: string | null; fullName: string | null; link: string; text: string };
const PLATFORM: Record<string, string> = { ios: 'iPhone', android: 'Android', desktop: 'компьютер', other: 'телефон' };

async function share(text: string, link: string) {
  if (navigator.share && /Android|iPhone|iPad/.test(navigator.userAgent)) { try { await navigator.share({ text }); return; } catch { /* отменили */ } }
  try { await navigator.clipboard.writeText(text); toast('Текст с инструкцией скопирован: вставьте его сотруднику в SMS или мессенджер'); }
  catch { prompt('Скопируйте текст приглашения', link); }
}

function Invites({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : me.allClubs ? 'all' : clubs[0]?.id ?? '');
  const [data, setData] = useState<InvData | null>(null);
  const [e, setE] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [made, setMade] = useState<Created[] | null>(null);
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const load = () => { if (!club) return; setE(''); api<InvData>('GET', `/api/team/invites?clubId=${club}`).then(setData).catch((x) => setE(errText(x))); };
  useEffect(load, [club]);
  const create = async (userIds: string[]) => {
    if (club === 'all' && !userIds.length) { setE('Выберите клуб, чтобы сделать общую ссылку'); return; }
    try { const r = await api<Created[]>('POST', '/api/team/invites', { clubId: club, userIds }); setMade(r); setPicked([]); load(); } catch (x) { setE(errText(x)); }
  };
  const people = data?.people ?? [];
  const installed = people.filter((p) => p.appPlatform).length;
  const opened = people.filter((p) => !p.appPlatform && p.openedAt).length;
  const clubName = clubs.find((c) => c.id === club)?.name;

  return (
    <div className="tm-inv">
      <div className="card tm-inv-hero">
        <div>
          <h2>Приложение-мессенджер для сотрудников и тренеров</h2>
          <p className="muted" style={{ margin: '0 0 10px' }}>Отдельное приложение на телефон: ставится по ссылке, без App Store и Google Play. Сотрудник открывает ссылку, видит инструкцию для своего телефона (iPhone или Android), ставит значок «Мессенджер» на экран и входит по логину и паролю CRM. Уведомления о сообщениях приходят как в обычном мессенджере.</p>
          <div className="row">
            {(me.allClubs || clubs.length > 1) && (
              <select aria-label="Клуб" value={club} onChange={(x) => setClub(x.target.value)} style={{ width: 'auto' }}>
                {me.allClubs && <option value="all">Все клубы</option>}
                {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button className="btn pri" disabled={club === 'all'} onClick={() => create([])} title={club === 'all' ? 'Выберите клуб' : ''}>Общая ссылка для клуба</button>
            {data && <a className="btn" href={data.appLink} target="_blank" rel="noreferrer">Открыть приложение</a>}
          </div>
        </div>
        {data && <div className="tm-qr" title="Наведите камеру телефона"><Qr text={data.general?.link ?? data.appLink} /></div>}
      </div>
      {e && <div className="err">{e}</div>}
      {made && (
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <div className="row between"><h2>{made.length === 1 ? 'Ссылка готова' : `Готово ссылок: ${made.length}`}</h2><button className="btn sm" onClick={() => setMade(null)}>Закрыть</button></div>
          <p className="small" style={{ margin: 0 }}>Отправьте сотруднику текст ниже в SMS, WhatsApp или лично. По ссылке откроется страница с инструкцией для его телефона. Ссылка действует 30 дней.</p>
          {made.map((m) => (
            <div key={m.link} style={{ display: 'grid', gap: 6 }}>
              {m.fullName && <b>{m.fullName}</b>}
              <pre className="tm-inv-text">{m.text}</pre>
              <div className="row">
                <button className="btn pri sm" onClick={() => share(m.text, m.link)}>Скопировать текст с инструкцией</button>
                <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(m.link); toast('Ссылка скопирована'); }}>Только ссылку</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && (
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <div className="row between">
            <div><h2>Кто уже установил{clubName ? ` · ${clubName}` : ''}</h2><span className="small">Отметка появляется, когда сотрудник входит в приложение со значка на телефоне</span></div>
            <div className="tm-inv-stats">
              <div className="tm-stat"><b>{installed}<span style={{ fontSize: 14 }}> / {people.length}</span></b><span>установили</span></div>
              <div className="tm-stat"><b>{opened}</b><span>открыли ссылку</span></div>
            </div>
          </div>
          {picked.length > 0 && <div className="row"><button className="btn pri" onClick={() => create(picked)}>Сделать личные ссылки · {picked.length}</button><button className="btn" onClick={() => setPicked([])}>Снять выбор</button></div>}
          <div className="tbl"><table>
            <thead><tr><th style={{ width: 28 }}><input type="checkbox" aria-label="Выбрать всех без приложения" checked={picked.length > 0 && picked.length === people.filter((p) => !p.appPlatform).length}
              onChange={(x) => setPicked(x.target.checked ? people.filter((p) => !p.appPlatform).map((p) => p.id) : [])} /></th><th>Сотрудник</th><th>Приложение</th><th>Приглашение</th><th></th></tr></thead>
            <tbody>{people.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" aria-label={`Выбрать: ${p.fullName}`} checked={picked.includes(p.id)} onChange={(x) => setPicked(x.target.checked ? [...picked, p.id] : picked.filter((i) => i !== p.id))} /></td>
                <td><b>{p.fullName}</b><div className="small">{p.roles} · логин {p.login}</div></td>
                <td>{p.appPlatform ? <><span className="chip ok">установлено · {PLATFORM[p.appPlatform] ?? p.appPlatform}</span><div className="small">заходил {dt(p.appLastAt)}{p.push ? '' : ' · уведомления выключены'}</div></> : <span className="chip">нет</span>}</td>
                <td>{p.invitedAt ? <><span className="small">отправлено {dt(p.invitedAt)}</span><div className="small">{p.openedAt ? `открыл ссылку ${dt(p.openedAt)}` : 'ещё не открывал'}</div></> : <span className="small">—</span>}</td>
                <td className="r">
                  {p.link ? <button className="btn sm" onClick={() => share(`${me.full_name} приглашает вас в рабочий мессенджер.\nУстановите приложение по ссылке: ${p.link}\nНа странице — инструкция для iPhone и Android.\nВход: логин ${p.login} и пароль от CRM.`, p.link!)}>Скопировать снова</button>
                    : <button className="btn sm" onClick={() => create([p.id])}>Ссылка</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
          {data.general && <p className="small" style={{ margin: 0 }}>Общая ссылка клуба: <a href={data.general.link} target="_blank" rel="noreferrer">{data.general.link}</a> · открывали {data.general.openCount} раз · подходит, чтобы повесить QR-код в комнате персонала.</p>}
        </div>
      )}
    </div>
  );
}
