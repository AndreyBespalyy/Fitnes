// Шаг 7. Раздел «Договоры» (юрлицо и PDF клуба), договор в карточке клиента: печать, скан, подпись на планшете.
// Плюс раздел «Сайт»: предложения клуба для выгрузки на сайт.
import { OnlineBuyBlock } from './onlineBuy.tsx';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, can, type Club, type Me } from './api.ts';
import { errText, toast } from './ui.ts';
import { rub, type Product } from './memberships.tsx';

export type ContractBrief = { id: string; number: string; date: string; status: string; signMethod: string | null; signedAt: string | null;
  scanFileId: string | null; signatureFileId: string | null; hasLegalEntity: boolean; hasContractDoc: boolean };
type LegalEntity = { fullName: string; inn: string; kpp: string | null; ogrn: string | null; address: string | null; bankName: string | null; bik: string | null;
  account: string | null; corrAccount: string | null; signerName: string | null; signerBasis: string | null; contractPrefix: string };
type Doc = { id: string; kind: string; title: string; version: number; isCurrent: boolean; createdAt: string; fileId: string; fileName: string; sizeBytes: number; uploadedBy: string | null };
type FullContract = { id: string; number: string; date: string; status: string; signMethod: string | null; signedAt: string | null; scanFileId: string | null; signatureFileId: string | null;
  legalEntity: LegalEntity | null; club: { name: string; address: string | null }; person: { fullName: string; birthDate: string | null; phone: string | null; email: string | null };
  membership: { productName: string; kind: string; amountKop: number; installments: number; startsOn: string; endsOn: string | null; visitsLeft: number | null } | null;
  charges: { title: string; dueOn: string; amountKop: number }[];
  contractDoc: { id: string; title: string; version: number; fileId: string } | null; rulesDoc: { id: string; title: string; version: number; fileId: string } | null };

const d = (s: string | null | undefined) => (s ? s.slice(0, 10).split('-').reverse().join('.') : '—');
const fileUrl = (id: string) => `/api/files/${id}`;
export const readFile = (f: File) => new Promise<{ fileName: string; dataBase64: string }>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res({ fileName: f.name, dataBase64: String(r.result) });
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});
function ClubPicker({ clubs, clubId, value, onChange }: { clubs: Club[]; clubId: string; value: string; onChange: (v: string) => void }) {
  if (clubId !== 'all') return null;
  return <select aria-label="Клуб" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>;
}

/* ---------------- Раздел «Договоры» ---------------- */
export function ContractsAdminPage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const c = clubs.find((x) => x.id === club);
  if (!c) return <p className="muted">Клубов нет.</p>;
  const manage = can(me, 'contracts.manage');
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>У каждого клуба своё юрлицо и свой договор. Реквизиты и PDF попадают в каждый новый договор клиента; уже выданные договоры остаются с теми реквизитами и той версией, что были на день продажи.</p>
        <ClubPicker clubs={clubs} clubId={clubId} value={club} onChange={setClub} />
      </div>
      <LegalEntityForm key={`le${club}`} club={c} manage={manage} />
      <Documents key={`d${club}`} club={c} manage={manage} />
      {me.allClubs && (can(me, '*') || manage) && <SmsSettings />}
    </>
  );
}

function SmsSettings() {
  type S = { provider: 'test' | 'smsru' | 'smsc'; sender: string | null; login: string | null; hasSecret: boolean; updatedAt: string | null; outbox: { phone: string; text: string; provider: string; status: string; error: string | null; at: string }[] };
  const [s, setS] = useState<S | null>(null);
  const [f, setF] = useState({ provider: 'test', sender: '', login: '', secret: '' });
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState('');
  const load = () => api<S>('GET', '/api/sms/settings').then((x) => { setS(x); setF({ provider: x.provider, sender: x.sender ?? '', login: x.login ?? '', secret: '' }); }).catch(() => setS(null));
  useEffect(() => { load(); }, []);
  if (!s) return null;
  const save = async () => { setErr(''); try { await api('PUT', '/api/sms/settings', f); toast('Настройки СМС сохранены'); load(); } catch (x) { setErr(errText(x)); } };
  const test = async () => { setErr(''); try { await api('POST', '/api/sms/settings/test', { phone }); toast('Проверочное СМС отправлено'); load(); } catch (x) { setErr(errText(x)); } };
  const ST: Record<string, string> = { sent: 'отправлено', failed: 'ошибка', test: 'тест, не отправлялось' };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2>СМС для подписи договоров</h2>
      <p className="small muted" style={{ margin: 0 }}>Клиент подписывает договор кодом из СМС — это простая электронная подпись: в клубе (код вводят на экране подписания) или удалённо по ссылке. В тестовом режиме СМС не отправляются, код показывается сотруднику — так можно проверить порядок работы до подключения провайдера.</p>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', alignItems: 'end' }}>
        <label className="f">Провайдер<select className="f" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
          <option value="test">Тестовый (без отправки)</option><option value="smsru">SMS.ru</option><option value="smsc">SMSC.ru</option></select></label>
        {f.provider !== 'test' && <>
          {f.provider === 'smsc' && <label className="f">Логин SMSC<input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></label>}
          <label className="f">{f.provider === 'smsru' ? 'API-ключ (api_id)' : 'Пароль или API-ключ'}<input type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} placeholder={s.hasSecret ? 'сохранён, введите новый для замены' : ''} /></label>
          <label className="f">Имя отправителя<input value={f.sender} maxLength={11} onChange={(e) => setF({ ...f, sender: e.target.value })} placeholder="согласованное у провайдера" /></label>
        </>}
        <button className="btn pri" onClick={save}>Сохранить</button>
      </div>
      {s.provider !== 'test' && <div className="row" style={{ gap: 6 }}><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 900 000-00-00" aria-label="Телефон для проверки" style={{ maxWidth: 200 }} /><button className="btn sm" disabled={!phone} onClick={test}>Отправить проверочное СМС</button></div>}
      {err && <div className="err">{err}</div>}
      {s.outbox.length > 0 && <details><summary className="small">Последние СМС ({s.outbox.length})</summary>
        {s.outbox.map((o, i) => <div key={i} className="small">{new Date(o.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {o.phone} · {ST[o.status] ?? o.status}{o.error ? ` (${o.error})` : ''} · <span className="muted">{o.text}</span></div>)}
      </details>}
    </div>
  );
}

const LE_LABELS: [keyof LegalEntity, string, string?][] = [
  ['fullName', 'Название юрлица', 'ООО «Фитнес Центр» или ИП Иванов И. И.'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН / ОГРНИП'], ['address', 'Юридический адрес'],
  ['bankName', 'Банк'], ['bik', 'БИК'], ['account', 'Расчётный счёт'], ['corrAccount', 'Корр. счёт'],
  ['signerName', 'Кто подписывает от клуба', 'Смирнов О. А.'], ['signerBasis', 'На основании', 'Устава / доверенности № 1 от 01.11.2026'], ['contractPrefix', 'Префикс номера договора', 'Ц'],
];
function LegalEntityForm({ club, manage }: { club: Club; manage: boolean }) {
  const [le, setLe] = useState<Partial<LegalEntity> | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ legalEntity: LegalEntity | null }>('GET', `/api/clubs/${club.id}/legal-entity`).then((r) => setLe(r.legalEntity ?? { contractPrefix: 'Д' })).catch((x) => setErr(errText(x))); }, [club.id]);
  if (!le) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { const r = await api<{ legalEntity: LegalEntity }>('PUT', `/api/clubs/${club.id}/legal-entity`, le); setLe(r.legalEntity); toast(`Реквизиты «${club.name}» сохранены`); } catch (x) { setErr(errText(x)); }
  };
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 10 }}>
      <h2>Юрлицо и реквизиты клуба</h2>
      {err && <div className="err">{err}</div>}
      {!le.inn && <div className="item small">Реквизиты ещё не заполнены. Без них договор не распечатать и не подписать на планшете.</div>}
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
        {LE_LABELS.map(([k, label, ph]) => (
          <label key={k} className="f">{label}<input value={(le[k] as string | null) ?? ''} placeholder={ph} disabled={!manage} onChange={(e) => setLe({ ...le, [k]: e.target.value })} /></label>))}
      </div>
      {manage && <div><button className="btn pri">Сохранить реквизиты</button></div>}
    </form>
  );
}

function Documents({ club, manage }: { club: Club; manage: boolean }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const reload = () => api<Doc[]>('GET', `/api/clubs/${club.id}/documents`).then(setDocs).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [club.id]);
  const upload = async (kind: string, f: File | undefined) => {
    if (!f) return;
    setErr(''); setBusy(kind);
    try {
      const r = await api<{ version: number }>('POST', `/api/clubs/${club.id}/documents`, { kind, ...(await readFile(f)) });
      toast(`${kind === 'contract' ? 'Договор' : 'Правила'} загружены, версия ${r.version}`); reload();
    } catch (x) { setErr(errText(x)); } finally { setBusy(''); }
  };
  const block = (kind: 'contract' | 'rules', title: string) => {
    const list = docs.filter((x) => x.kind === kind);
    const cur = list.find((x) => x.isCurrent);
    return (
      <div className="item" style={{ display: 'grid', gap: 6 }}>
        <div className="row between"><b>{title}</b>{cur ? <span className="chip ok">версия {cur.version}</span> : <span className="chip warn">не загружен</span>}</div>
        {cur && <a href={fileUrl(cur.fileId)} target="_blank" rel="noreferrer">{cur.fileName}</a>}
        {list.length > 1 && <div className="small">Прошлые версии: {list.filter((x) => !x.isCurrent).map((x) => <a key={x.id} href={fileUrl(x.fileId)} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>v{x.version} от {new Date(x.createdAt).toLocaleDateString('ru-RU')}</a>)}</div>}
        {manage && <label className="btn sm" style={{ width: 'fit-content' }}>{busy === kind ? 'Загрузка…' : cur ? 'Загрузить новую версию (PDF)' : 'Загрузить PDF'}
          <input type="file" accept="application/pdf" hidden onChange={(e) => { upload(kind, e.target.files?.[0]); e.target.value = ''; }} /></label>}
      </div>);
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <h2>Документы клуба</h2>
      <p className="small" style={{ margin: 0 }}>PDF до 15 МБ. Новая версия применяется к новым договорам; клиенты, подписавшие прошлую версию, остаются на ней.</p>
      {err && <div className="err">{err}</div>}
      <div className="grid2">{block('contract', 'Договор оказания услуг')}{block('rules', 'Правила клуба')}</div>
    </div>
  );
}

/* ---------------- Договор в карточке клиента ---------------- */
export function ContractLine({ me, c, reload }: { me: Me; c: ContractBrief; reload: () => void }) {
  const [view, setView] = useState<'print' | 'tablet' | 'sms' | null>(null);
  const [err, setErr] = useState('');
  const sign = can(me, 'contracts.sign');
  const [linkInfo, setLinkInfo] = useState<ReactNode>(null);
  const sendLink = async () => {
    setErr('');
    try {
      const r = await api<{ phoneMasked: string; expiresInDays: number; testUrl?: string }>('POST', `/api/contracts/${c.id}/sms/link`);
      setLinkInfo(<>Ссылка на подпись отправлена на {r.phoneMasked}, действует {r.expiresInDays} дня. Клиент откроет договор и правила и подпишет кодом из СМС; статус обновится сам.
        {r.testUrl && <><br /><b>Тестовый режим:</b> СМС не отправлялось, ссылка: <a href={r.testUrl} target="_blank" rel="noreferrer">{r.testUrl}</a></>}</>);
    } catch (x) { setErr(errText(x)); }
  };
  const scan = async (f: File | undefined) => {
    if (!f) return;
    setErr('');
    try { await api('POST', `/api/contracts/${c.id}/scan`, await readFile(f)); toast(`Скан договора № ${c.number} загружен, договор подписан`); reload(); } catch (x) { setErr(errText(x)); }
  };
  const label = c.status === 'signed' ? (c.signMethod === 'tablet' ? 'подписан на планшете' : c.signMethod === 'sms' ? 'подписан кодом из СМС' : c.signMethod === 'online_offer' ? 'заключён онлайн (оферта принята и оплачена)' : c.scanFileId ? 'подписан, скан в системе' : 'подписан на бумаге') : c.status === 'cancelled' ? 'расторгнут' : 'ждёт подписи';
  return (
    <div className="row between small" style={{ borderTop: '1px dashed var(--line)', paddingTop: 6 }}>
      <span>Договор № {c.number} от {d(c.date)} · <span className={`chip ${c.status === 'signed' ? 'ok' : c.status === 'cancelled' ? '' : 'warn'}`}>{label}</span>
        {!c.hasLegalEntity && c.status === 'awaiting_signature' && <span className="bad"> · нет реквизитов клуба</span>}</span>
      <span className="row">
        <button className="btn sm" onClick={() => setView('print')}>Печать</button>
        {c.scanFileId && <a className="btn sm" href={fileUrl(c.scanFileId)} target="_blank" rel="noreferrer">Скан</a>}
        {c.signatureFileId && <a className="btn sm" href={fileUrl(c.signatureFileId)} target="_blank" rel="noreferrer">Подпись</a>}
        {sign && c.status === 'awaiting_signature' && <>
          <label className="btn sm">Загрузить скан<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { scan(e.target.files?.[0]); e.target.value = ''; }} /></label>
          <button className="btn sm pri" onClick={() => setView('tablet')} disabled={!c.hasLegalEntity}>Подписать на планшете</button>
          <button className="btn sm" onClick={() => setView('sms')} disabled={!c.hasLegalEntity}>Код из СМС</button>
          <button className="btn sm" onClick={sendLink} disabled={!c.hasLegalEntity}>Ссылку клиенту</button></>}
      </span>
      {err && <div className="err" style={{ width: '100%' }}>{err}</div>}
      {view === 'print' && <PrintContract id={c.id} onClose={() => setView(null)} />}
      {view === 'tablet' && <TabletSign id={c.id} onClose={(done) => { setView(null); if (done) reload(); }} />}
      {view === 'sms' && <SmsSign id={c.id} onClose={(done) => { setView(null); if (done) reload(); }} />}
      {linkInfo && <div className="item small" style={{ width: '100%' }}>{linkInfo}</div>}
    </div>
  );
}

function useContract(id: string) {
  const [c, setC] = useState<FullContract | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<FullContract>('GET', `/api/contracts/${id}`).then(setC).catch((x) => setErr(errText(x))); }, [id]);
  return { c, err };
}

function Terms({ c }: { c: FullContract }) {
  const le = c.legalEntity;
  const m = c.membership;
  return (
    <>
      <div className="sheet-h"><b>{le?.fullName ?? 'Реквизиты клуба не заполнены'}</b><span>{c.club.name}{c.club.address ? `, ${c.club.address}` : ''}</span></div>
      <h1 style={{ textAlign: 'center', margin: '12px 0 2px' }}>Договор № {c.number}</h1>
      <p style={{ textAlign: 'center', margin: 0 }}>оказания физкультурно-оздоровительных услуг от {d(c.date)}</p>
      <p>{le?.fullName ?? '________'}, в лице {le?.signerName ?? '________'}, действующего на основании {le?.signerBasis ?? '________'} (Исполнитель), и {c.person.fullName}
        {c.person.birthDate ? `, ${c.person.birthDate} г. р.` : ''} (Заказчик) заключили договор на условиях
        {c.contractDoc ? ` документа «${c.contractDoc.title}» (версия ${c.contractDoc.version})` : ' договора оказания услуг клуба'}
        {c.rulesDoc ? ` и «${c.rulesDoc.title}» (версия ${c.rulesDoc.version})` : ' и правил клуба'}, которые являются неотъемлемой частью настоящего договора.</p>
      {m && <table className="sheet-t"><tbody>
        <tr><td>Услуга</td><td><b>{m.productName}</b></td></tr>
        <tr><td>Срок</td><td>{d(m.startsOn)} — {d(m.endsOn)}{m.visitsLeft !== null ? `, занятий: ${m.visitsLeft}` : ''}</td></tr>
        <tr><td>Стоимость</td><td>{rub(m.amountKop)}{m.kind === 'subscription' ? ' в месяц, списание ежемесячно' : ''}</td></tr>
        {c.charges.length > 1 && <tr><td>График оплаты</td><td>{c.charges.map((x) => `${d(x.dueOn)} — ${rub(x.amountKop)}`).join('; ')}</td></tr>}
      </tbody></table>}
      <table className="sheet-t"><tbody>
        <tr><td style={{ width: '50%' }}><b>Исполнитель</b><br />{le?.fullName}<br />ИНН {le?.inn}{le?.kpp ? `, КПП ${le.kpp}` : ''}{le?.ogrn ? `, ОГРН ${le.ogrn}` : ''}<br />{le?.address}
          {le?.account && <><br />р/с {le.account} в {le.bankName}, БИК {le.bik}, к/с {le.corrAccount}</>}</td>
          <td><b>Заказчик</b><br />{c.person.fullName}<br />{c.person.phone ?? ''}{c.person.email ? `, ${c.person.email}` : ''}</td></tr>
      </tbody></table>
    </>
  );
}

function PrintContract({ id, onClose }: { id: string; onClose: () => void }) {
  const { c, err } = useContract(id);
  return (
    <div className="overlay print-root" style={{ zIndex: 60 }}>
      <div className="sheet">
        <div className="row between no-print"><span className="lbl">Печать договора</span>
          <span className="row">{c && <button className="btn pri sm" onClick={() => window.print()}>Печать</button>}<button className="btn sm" onClick={onClose}>Закрыть</button></span></div>
        {err && <div className="err">{err}</div>}
        {!c ? <p className="muted">Загрузка…</p> : (<>
          <Terms c={c} />
          <p>Заказчик подтверждает, что ознакомлен с договором и правилами клуба, получил их копию и согласен с ними.</p>
          <div className="sheet-sign"><span>Исполнитель ____________ / {c.legalEntity?.signerName ?? '________'} /</span><span>Заказчик ____________ / {c.person.fullName} /</span></div>
          <div className="no-print item small" style={{ marginTop: 14 }}>
            Распечатайте этот лист вместе с текстом договора и правил{c.contractDoc ? <>: <a href={fileUrl(c.contractDoc.fileId)} target="_blank" rel="noreferrer">договор (PDF)</a></> : ''}
            {c.rulesDoc ? <>, <a href={fileUrl(c.rulesDoc.fileId)} target="_blank" rel="noreferrer">правила (PDF)</a></> : ''}. После подписи отсканируйте и нажмите «Загрузить скан» в карточке клиента.
          </div>
        </>)}
      </div>
    </div>
  );
}

function SmsSign({ id, onClose }: { id: string; onClose: (done: boolean) => void }) {
  const { c, err: loadErr } = useContract(id);
  const [err, setErr] = useState('');
  const [agree, setAgree] = useState(false);
  const [sent, setSent] = useState<{ phoneMasked: string; testCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [doc, setDoc] = useState<'contract' | 'rules' | null>(null);
  const send = async () => {
    setErr('');
    try { setSent(await api<{ phoneMasked: string; testCode?: string }>('POST', `/api/contracts/${id}/sms/send`)); } catch (x) {
      setErr(errText(x));
      // Код уже отправлен минуту назад (окно открыли заново) — сразу поле для кода
      if (x instanceof ApiError && x.code === 'too_soon' && !sent) setSent({ phoneMasked: c?.person.phone ?? 'телефон клиента' });
    }
  };
  const submit = async () => {
    setErr('');
    try { await api('POST', `/api/contracts/${id}/sms/confirm`, { code, accepted: agree }); toast('Договор подписан кодом из СМС'); onClose(true); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="overlay" style={{ zIndex: 60, background: 'var(--bg)' }}>
      <div className="sheet tablet">
        <div className="row between"><span className="lbl">Подписание кодом из СМС</span><button className="btn sm" onClick={() => onClose(false)}>Отмена</button></div>
        {(loadErr || err) && <div className="err">{loadErr || err}</div>}
        {!c ? <p className="muted">Загрузка…</p> : (<>
          <Terms c={c} />
          <div className="row">
            {c.contractDoc && <button className="btn" aria-pressed={doc === 'contract'} onClick={() => setDoc(doc === 'contract' ? null : 'contract')}>Текст договора</button>}
            {c.rulesDoc && <button className="btn" aria-pressed={doc === 'rules'} onClick={() => setDoc(doc === 'rules' ? null : 'rules')}>Правила клуба</button>}
          </div>
          {doc && <iframe title="Документ" src={fileUrl((doc === 'contract' ? c.contractDoc : c.rulesDoc)!.fileId)} style={{ width: '100%', height: '55vh', border: '1px solid var(--line)', borderRadius: 8 }} />}
          <label className="row" style={{ gap: 10, fontSize: 16 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            Я ознакомлен(а) с договором и правилами клуба и согласен(на) с ними. Ввод кода из СМС — моя простая электронная подпись</label>
          {!sent ? <div className="row between"><span className="small muted">Код придёт на телефон клиента {c.person.phone ?? '(в карточке нет телефона)'}</span>
            <button className="btn pri" disabled={!c.person.phone} onClick={send}>Отправить код</button></div>
          : <>
            <div className="small">Код отправлен на {sent.phoneMasked}, действует 10 минут. <button className="link small" onClick={send}>Отправить ещё раз</button></div>
            {sent.testCode && <div className="small" style={{ background: 'var(--warn-soft, #fff6d6)', padding: 8, borderRadius: 8 }}>Тестовый режим: СМС не отправлялось, код {sent.testCode}. Настоящие СМС включаются в разделе «Договоры» → «СМС для подписи».</div>}
            <div className="row between">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="Код из СМС" aria-label="Код из СМС" style={{ fontSize: 22, letterSpacing: 6, maxWidth: 200 }} />
              <button className="btn pri" style={{ fontSize: 17, padding: '12px 22px' }} disabled={!agree || code.length !== 6} onClick={submit}>Подписать договор</button>
            </div>
          </>}
        </>)}
      </div>
    </div>
  );
}

function TabletSign({ id, onClose }: { id: string; onClose: (done: boolean) => void }) {
  const { c, err: loadErr } = useContract(id);
  const [err, setErr] = useState('');
  const [agree, setAgree] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [doc, setDoc] = useState<'contract' | 'rules' | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = cv.current; if (!el) return;
    const r = el.getBoundingClientRect(); const k = window.devicePixelRatio || 1;
    el.width = r.width * k; el.height = r.height * k;
    const g = el.getContext('2d')!; g.scale(k, k); g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0b2540';
  }, [c]);
  const pos = (e: React.PointerEvent) => { const r = cv.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { cv.current!.setPointerCapture(e.pointerId); last.current = pos(e); };
  const move = (e: React.PointerEvent) => {
    if (!last.current) return;
    const g = cv.current!.getContext('2d')!; const p = pos(e);
    g.beginPath(); g.moveTo(last.current.x, last.current.y); g.lineTo(p.x, p.y); g.stroke(); last.current = p; setDrawn(true);
  };
  const clear = () => { const el = cv.current!; el.getContext('2d')!.clearRect(0, 0, el.width, el.height); setDrawn(false); };
  const submit = async () => {
    setErr('');
    try { await api('POST', `/api/contracts/${id}/sign-tablet`, { accepted: agree, signaturePng: cv.current!.toDataURL('image/png') }); toast('Договор подписан'); onClose(true); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="overlay" style={{ zIndex: 60, background: 'var(--bg)' }}>
      <div className="sheet tablet">
        <div className="row between"><span className="lbl">Подписание договора</span><button className="btn sm" onClick={() => onClose(false)}>Отмена</button></div>
        {(loadErr || err) && <div className="err">{loadErr || err}</div>}
        {!c ? <p className="muted">Загрузка…</p> : (<>
          <Terms c={c} />
          <div className="row">
            {c.contractDoc && <button className="btn" aria-pressed={doc === 'contract'} onClick={() => setDoc(doc === 'contract' ? null : 'contract')}>Текст договора</button>}
            {c.rulesDoc && <button className="btn" aria-pressed={doc === 'rules'} onClick={() => setDoc(doc === 'rules' ? null : 'rules')}>Правила клуба</button>}
          </div>
          {doc && <iframe title="Документ" src={fileUrl((doc === 'contract' ? c.contractDoc : c.rulesDoc)!.fileId)} style={{ width: '100%', height: '55vh', border: '1px solid var(--line)', borderRadius: 8 }} />}
          <label className="row" style={{ gap: 10, fontSize: 16 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            Я ознакомлен(а) с договором и правилами клуба и согласен(на) с ними</label>
          <div className="lbl">Подпись клиента</div>
          <canvas ref={cv} className="sigpad" onPointerDown={down} onPointerMove={move} onPointerUp={() => (last.current = null)} onPointerLeave={() => (last.current = null)} />
          <div className="row between">
            <button className="btn" onClick={clear}>Очистить</button>
            <button className="btn pri" style={{ fontSize: 17, padding: '12px 22px' }} disabled={!agree || !drawn} onClick={submit}>Подписать договор</button>
          </div>
        </>)}
      </div>
    </div>
  );
}

/* ---------------- Раздел «Сайт» ---------------- */
type Offer = { id: string; clubId: string; clubName: string; productId: string | null; title: string; description: string | null; priceKop: number | null; oldPriceKop: number | null;
  priceNote: string | null; validFrom: string | null; validTo: string | null; imageFileId: string | null; status: string; publishedAt: string | null };
const toKop = (s: string) => (s.trim() === '' ? null : Math.round(Number(s.replace(',', '.').replace(/\s/g, '')) * 100));
const EMPTY = { title: '', description: '', price: '', oldPrice: '', priceNote: '', validFrom: '', validTo: '', productId: '' };

export function SitePage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson?: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [f, setF] = useState(EMPTY);
  const [img, setImg] = useState<File | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const manage = can(me, 'site.manage');
  const reload = () => api<Offer[]>('GET', `/api/site/offers?clubId=${club}`).then(setOffers).catch((x) => setErr(errText(x)));
  useEffect(() => { if (club) { reload(); api<Product[]>('GET', `/api/products?clubId=${club}&active=1`).then(setProducts).catch(() => setProducts([])); } }, [club]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); toast(ok); reload(); return true; } catch (x) { setErr(errText(x)); return false; } };
  const fromProduct = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    setF({ ...f, productId: pid, title: p ? p.name : f.title, price: p?.priceKop ? String(p.priceKop / 100) : f.price, priceNote: p?.kind === 'subscription' ? 'в месяц' : f.priceNote });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { clubId: club, productId: f.productId || null, title: f.title, description: f.description, priceKop: toKop(f.price), oldPriceKop: toKop(f.oldPrice),
      priceNote: f.priceNote, validFrom: f.validFrom || null, validTo: f.validTo || null, image: img ? await readFile(img) : undefined };
    const ok = await act(() => edit ? api('PATCH', `/api/site/offers/${edit}`, body) : api('POST', '/api/site/offers', body), edit ? 'Предложение сохранено' : 'Черновик предложения создан');
    if (ok) { setF(EMPTY); setImg(null); setEdit(null); }
  };
  const startEdit = (o: Offer) => {
    setEdit(o.id);
    setF({ title: o.title, description: o.description ?? '', price: o.priceKop === null ? '' : String(o.priceKop / 100), oldPrice: o.oldPriceKop === null ? '' : String(o.oldPriceKop / 100),
      priceNote: o.priceNote ?? '', validFrom: o.validFrom ?? '', validTo: o.validTo ?? '', productId: o.productId ?? '' });
  };
  const published = offers.filter((o) => o.status === 'published').length;
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 700 }}>Предложения клуба для сайта. Опубликованные предложения сайт забирает автоматически, черновики видны только здесь.</p>
        <ClubPicker clubs={clubs} clubId={clubId} value={club} onChange={setClub} />
      </div>
      <div className="item small">
        Сейчас на сайт выгружается: <b>{published}</b>. Сайта пока нет: когда он появится, он будет забирать предложения по адресу <code>/api/public/v1/offers</code>{' '}
        с ключом источника «Сайт» (тот же ключ, что для заявок, его выдаёт администратор в разделе «Воронки»). Снятые и просроченные предложения пропадают с сайта сами.
      </div>
      {club && <OnlineBuyBlock club={club} openPerson={openPerson} />}
      {err && <div className="err">{err}</div>}
      <div className="offers">{offers.map((o) => (
        <div key={o.id} className="card offer">
          {o.imageFileId ? <img src={fileUrl(o.imageFileId)} alt="" /> : <div className="noimg">без картинки</div>}
          <div style={{ display: 'grid', gap: 4, padding: 12 }}>
            <div className="row between"><b>{o.title}</b><span className={`chip ${o.status === 'published' ? 'ok' : ''}`}>{o.status === 'published' ? 'на сайте' : 'черновик'}</span></div>
            {o.priceKop !== null && <div><b>{rub(o.priceKop)}</b> {o.oldPriceKop ? <s className="muted">{rub(o.oldPriceKop)}</s> : null} <span className="small">{o.priceNote}</span></div>}
            {o.description && <div className="small">{o.description}</div>}
            {(o.validFrom || o.validTo) && <div className="small">Действует {o.validFrom ? `с ${d(o.validFrom)}` : ''} {o.validTo ? `по ${d(o.validTo)}` : ''}</div>}
            {manage && <div className="row" style={{ marginTop: 4 }}>
              {o.status === 'published'
                ? <button className="btn sm" onClick={() => act(() => api('PATCH', `/api/site/offers/${o.id}`, { status: 'draft' }), 'Снято с сайта')}>Снять с сайта</button>
                : <button className="btn sm pri" onClick={() => act(() => api('PATCH', `/api/site/offers/${o.id}`, { status: 'published' }), 'Опубликовано на сайте')}>Выгрузить на сайт</button>}
              <button className="btn sm" onClick={() => startEdit(o)}>Изменить</button>
              <button className="btn sm" onClick={() => act(() => api('PATCH', `/api/site/offers/${o.id}`, { status: 'archived' }), 'Предложение в архиве')}>В архив</button>
            </div>}
          </div>
        </div>))}
        {offers.length === 0 && <p className="muted">Предложений нет.</p>}
      </div>
      {manage && (
        <form className="card" onSubmit={save} style={{ display: 'grid', gap: 8 }}>
          <h2>{edit ? 'Изменить предложение' : 'Новое предложение'}</h2>
          <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', alignItems: 'end' }}>
            {!edit && <label className="f">На основе тарифа<select value={f.productId} onChange={(e) => fromProduct(e.target.value)}><option value="">— без тарифа —</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
            <label className="f">Заголовок<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Год со скидкой 15 %" /></label>
            <label className="f">Цена, ₽<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
            <label className="f">Старая цена, ₽<input inputMode="decimal" value={f.oldPrice} onChange={(e) => setF({ ...f, oldPrice: e.target.value })} placeholder="для зачёркивания" /></label>
            <label className="f">Подпись к цене<input value={f.priceNote} onChange={(e) => setF({ ...f, priceNote: e.target.value })} placeholder="в месяц, за год" /></label>
            <label className="f">Показывать с<input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></label>
            <label className="f">по<input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></label>
          </div>
          <label className="f">Описание<textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="f">Картинка (JPG или PNG)<input type="file" accept="image/jpeg,image/png" onChange={(e) => setImg(e.target.files?.[0] ?? null)} /></label>
          <div className="row"><button className="btn pri" disabled={!f.title.trim()}>{edit ? 'Сохранить' : 'Создать черновик'}</button>
            {edit && <button type="button" className="btn" onClick={() => { setEdit(null); setF(EMPTY); }}>Отмена</button>}</div>
        </form>)}
    </>
  );
}
