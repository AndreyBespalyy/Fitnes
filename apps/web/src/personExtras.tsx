// Карточка клиента: доработки по замечаниям тестировщиков 18.11.2026.
//  №32 — фото клиента и правка ФИО и даты рождения; №47 — «Показать номер» (с записью, кто смотрел);
//  №31 — документы клиента с камеры телефона; №48 — ответственный менеджер и второй с долей.
import { useEffect, useRef, useState } from 'react';
import { api, can, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';

const WORK = ['crm.work', 'memberships.sell', 'memberships.manage', 'acs.work'];
const canWork = (me: Me) => WORK.some((p) => can(me, p));

/** Картинку уменьшаем на телефоне до max px по большей стороне и отправляем как JPEG. */
async function shrink(f: File, max: number, q = 0.85) {
  const img = await createImageBitmap(f);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
const fileData = (f: File) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(f); });

/** Шапка карточки: фото, ФИО, дата рождения и правка (№32). */
export function PersonHead({ me, person, reload, children }: { me: Me; person: { id: string; fullName: string; birthDate?: string | null }; reload: () => void; children?: React.ReactNode }) {
  const [v, setV] = useState(0);
  const [hasPhoto, setHasPhoto] = useState(true);
  const [edit, setEdit] = useState<{ fullName: string; birthDate: string } | null>(null);
  const [err, setErr] = useState('');
  const inp = useRef<HTMLInputElement>(null);
  const work = canWork(me);
  const photo = async (f: File | undefined) => {
    if (!f) return; setErr('');
    try { await api('PUT', `/api/persons/${person.id}/photo`, { image: await shrink(f, 360, 0.82) }); setHasPhoto(true); setV((x) => x + 1); toast('Фото сохранено'); }
    catch (x) { setErr(errText(x)); }
  };
  const save = async () => {
    if (!edit) return; setErr('');
    try { await api('PATCH', `/api/persons/${person.id}`, { fullName: edit.fullName, birthDate: edit.birthDate || null }); setEdit(null); toast('Данные клиента сохранены'); reload(); }
    catch (x) { setErr(errText(x)); }
  };
  const age = person.birthDate ? Math.floor((Date.now() - new Date(person.birthDate).getTime()) / (365.25 * 86400000)) : null;
  return (
    <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
      <button type="button" className="pc-photo" disabled={!work} onClick={() => inp.current?.click()} title={work ? (hasPhoto ? 'Сменить фото' : 'Сфотографировать клиента') : undefined}>
        {hasPhoto ? <img src={`/api/persons/${person.id}/photo?v=${v}`} alt={`Фото: ${person.fullName}`} onError={() => setHasPhoto(false)} />
          : <span>{work ? <>📷<br /><span className="small">Фото</span></> : '☺'}</span>}
      </button>
      <input ref={inp} type="file" accept="image/*" capture="user" hidden onChange={(e) => { void photo(e.target.files?.[0]); e.target.value = ''; }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {edit ? (
          <div style={{ display: 'grid', gap: 6 }}>
            <label className="f">Фамилия, имя, отчество<input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} autoFocus /></label>
            <label className="f">Дата рождения<input type="date" value={edit.birthDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setEdit({ ...edit, birthDate: e.target.value })} /></label>
            <div className="row"><button className="btn pri sm" onClick={() => void save()}>Сохранить</button><button className="btn sm" onClick={() => setEdit(null)}>Отмена</button></div>
          </div>
        ) : (<>
          <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{person.fullName}</h1>
            {work && <button className="btn sm" onClick={() => setEdit({ fullName: person.fullName, birthDate: person.birthDate?.slice(0, 10) ?? '' })} title="Исправить ФИО и дату рождения">Изменить</button>}
          </div>
          <div className="small muted">{person.birthDate ? `Дата рождения: ${new Date(person.birthDate).toLocaleDateString('ru-RU')}${age !== null ? ` (${age})` : ''}` : 'Дата рождения не указана'}</div>
        </>)}
        {err && <div className="err">{err}</div>}
        {children}
      </div>
    </div>
  );
}

/** «Показать номер»: полный номер по нажатию, в журнал пишется, кто смотрел (№47). */
export function ShowPhone({ me, personId, onShow }: { me: Me; personId: string; onShow: (phones: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  if (!canWork(me)) return null;
  return <button className="btn sm" disabled={busy} title="Номер откроется полностью. В журнал запишется, кто его смотрел." onClick={async () => {
    setBusy(true);
    try { onShow((await api<{ phones: string[] }>('POST', `/api/persons/${personId}/phone`)).phones); } catch (x) { toast(errText(x)); } finally { setBusy(false); }
  }}>Показать номер</button>;
}

type Doc = { id: string; title: string; fileId: string; mime: string; createdAt: string; byName: string | null };
const TITLES = ['Паспорт', 'Медицинская справка', 'Заявление', 'Договор', 'Другое'];

/** Документы клиента: снять телефоном или загрузить файл (№31). */
export function PersonDocuments({ me, personId }: { me: Me; personId: string }) {
  const [list, setList] = useState<Doc[] | null>(null);
  const [title, setTitle] = useState(TITLES[0]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cam = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const work = canWork(me);
  const reload = () => api<Doc[]>('GET', `/api/persons/${personId}/documents`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [personId]);
  const add = async (f: File | undefined) => {
    if (!f) return; setErr(''); setBusy(true);
    try {
      const data = f.type.startsWith('image/') ? await shrink(f, 1800, 0.85) : await fileData(f);
      await api('POST', `/api/persons/${personId}/documents`, { title, fileName: f.name || `${title}.jpg`, dataBase64: data });
      toast(`Документ «${title}» сохранён`); reload();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  if (!list?.length && !work) return null;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h2>Документы клиента</h2>
      {err && <div className="err">{err}</div>}
      {list === null ? <p className="muted" style={{ margin: 0 }}>Загрузка…</p> : list.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Документов нет. Паспорт или справку можно сфотографировать телефоном.</p> : (
        <div className="pc-docs">{list.map((d) => (
          <div key={d.id} className="pc-doc">
            <a href={`/api/persons/${personId}/documents/${d.id}/file`} target="_blank" rel="noreferrer">
              {d.mime.startsWith('image/') ? <img src={`/api/persons/${personId}/documents/${d.id}/file`} alt={d.title} loading="lazy" /> : <span className="pc-pdf">PDF</span>}
            </a>
            <b className="small">{d.title}</b>
            <span className="small muted">{dt(d.createdAt)}{d.byName ? ` · ${d.byName}` : ''}</span>
            {work && <button className="btn sm" onClick={async () => { try { await api('DELETE', `/api/persons/${personId}/documents/${d.id}`); reload(); } catch (x) { setErr(errText(x)); } }}>Удалить</button>}
          </div>))}
        </div>)}
      {work && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: 'auto' }} aria-label="Какой документ">{TITLES.map((t) => <option key={t}>{t}</option>)}</select>
          <button className="btn pri sm" disabled={busy} onClick={() => cam.current?.click()}>📷 Снять документ</button>
          <button className="btn sm" disabled={busy} onClick={() => file.current?.click()}>Загрузить файл</button>
          <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={file} type="file" accept="image/jpeg,image/png,application/pdf" hidden onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ''; }} />
        </div>)}
    </div>
  );
}

type Owner = { ownerId: string | null; ownerName: string | null; coOwnerId: string | null; coOwnerName: string | null; coOwnerShare: number | null };
type Staff = { id: string; name: string; role: string; code?: string };

/** Ответственный менеджер клиента; если продавали вдвоём — второй и его доля (№48). */
export function OwnerBlock({ me, personId, clubId }: { me: Me; personId: string; clubId: string | null }) {
  const [o, setO] = useState<Owner | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [edit, setEdit] = useState<{ ownerId: string; coOwnerId: string; share: number } | null>(null);
  const [err, setErr] = useState('');
  const boss = can(me, 'crm.view_all') || can(me, 'sales.manage');
  const seller = can(me, 'crm.work') || can(me, 'memberships.sell');
  const reload = () => api<Owner>('GET', `/api/persons/${personId}/owner`).then(setO).catch(() => setO(null));
  useEffect(() => { reload(); }, [personId]);
  const open = async () => {
    if (!o) return;
    setEdit({ ownerId: o.ownerId ?? (boss ? '' : me.id), coOwnerId: o.coOwnerId ?? '', share: o.coOwnerShare ?? 50 });
    if (clubId) setStaff((await api<Staff[]>('GET', `/api/tasks/assignees?clubId=${clubId}`).catch(() => [])).filter((s) => ['manager', 'rop', 'gm', 'desk'].includes(s.code ?? '')));
  };
  const save = async () => {
    if (!edit) return; setErr('');
    try {
      await api('PUT', `/api/persons/${personId}/owner`, { ownerId: edit.ownerId || null, coOwnerId: edit.coOwnerId || null, coOwnerShare: edit.coOwnerId ? edit.share : null });
      setEdit(null); toast('Ответственный сохранён'); reload();
    } catch (x) { setErr(errText(x)); }
  };
  if (!o) return null;
  const mine = o.ownerId === me.id;
  const canEdit = boss || (seller && (!o.ownerId || mine));
  return (
    <div className="item" style={{ display: 'grid', gap: 6 }}>
      <div className="row between" style={{ gap: 8 }}>
        <span className="small"><b>Ответственный:</b> {o.ownerName ?? 'не назначен'}
          {o.coOwnerName ? <> · <b>второй менеджер:</b> {o.coOwnerName} ({o.coOwnerShare}%), у ответственного {100 - (o.coOwnerShare ?? 0)}%</> : null}</span>
        {canEdit && !edit && <button className="btn sm" onClick={() => void open()}>{!o.ownerId && !boss ? 'Взять себе' : 'Изменить'}</button>}
      </div>
      {edit && (
        <div style={{ display: 'grid', gap: 6 }}>
          {boss
            ? <label className="f">Ответственный менеджер<select value={edit.ownerId} onChange={(e) => setEdit({ ...edit, ownerId: e.target.value })}>
                <option value="">— не назначен —</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}</select></label>
            : <span className="small">Ответственный: вы</span>}
          <label className="f">Продавали вдвоём — второй менеджер<select value={edit.coOwnerId} onChange={(e) => setEdit({ ...edit, coOwnerId: e.target.value })}>
            <option value="">— нет —</option>{staff.filter((s) => s.id !== edit.ownerId).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}</select></label>
          {edit.coOwnerId && <label className="f">Доля второго менеджера, %<input type="number" min={1} max={99} value={edit.share} onChange={(e) => setEdit({ ...edit, share: Number(e.target.value) })} style={{ width: 100 }} /></label>}
          {err && <div className="err">{err}</div>}
          <div className="row"><button className="btn pri sm" onClick={() => void save()}>Сохранить</button><button className="btn sm" onClick={() => { setEdit(null); setErr(''); }}>Отмена</button></div>
        </div>)}
    </div>
  );
}
