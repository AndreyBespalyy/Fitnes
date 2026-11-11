// Семейные и корпоративные абонементы: блок «Семья» в карточке клиента, выбор плательщика при продаже, раздел «Компании».
import { Fragment, useEffect, useState } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { usePersonSearch } from './gifts.tsx';

const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const ru = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('.') : '—');

/* ---------- выбор плательщика в форме продажи ---------- */
export type PayerValue = { payer?: 'self' | 'family' | 'company'; companyId?: string };
type Payers = { family: { payerName: string; discountPercent: number; isPayer: boolean } | null; companies: { id: string; name: string; discountPercent: number }[] };

export function PayerPick({ personId, clubId, kind, onChange }: { personId: string; clubId?: string; kind?: string; onChange: (v: PayerValue) => void }) {
  const [p, setP] = useState<Payers | null>(null);
  const [v, setV] = useState('self');
  useEffect(() => { setV('self'); onChange({}); if (clubId) api<Payers>('GET', `/api/persons/${personId}/payers?clubId=${clubId}`).then(setP).catch(() => setP(null)); }, [personId, clubId]);
  if (!p || (!p.family && !p.companies.length)) return null;
  const pick = (x: string) => { setV(x); onChange(x === 'self' ? {} : x === 'family' ? { payer: 'family' } : { payer: 'company', companyId: x.slice(2) }); };
  return (
    <label className="f">Кто платит<select value={v} onChange={(e) => pick(e.target.value)}>
      <option value="self">Сам клиент</option>
      {p.family && <option value="family">Семья: платит {p.family.payerName}{p.family.discountPercent ? `, семейная скидка ${p.family.discountPercent} %` : ''}</option>}
      {p.companies.map((c) => <option key={c.id} value={`c:${c.id}`} disabled={kind === 'subscription'}>Компания «{c.name}» по счёту{c.discountPercent ? `, скидка ${c.discountPercent} %` : ''}{kind === 'subscription' ? ' (не для подписки)' : ''}</option>)}
    </select>{v.startsWith('c:') && <span className="small">Клиент ничего не платит на ресепшне: сумма войдёт в счёт компании за месяц.</span>}</label>
  );
}

/* ---------- семья в карточке клиента ---------- */
type Fam = {
  discountPercent: number; maxMembers: number; canManage: boolean;
  group: null | { id: string; payerId: string; dueKop: number;
    members: { personId: string; name: string; relation: string | null; payer: boolean; active: { product: string; endsOn: string | null; visitsLeft: number | null }[] | null }[];
    due: { id: string; title: string; amountKop: number; dueOn: string; person: string }[] };
};

export function FamilyBlock({ me, personId, clubId, openPerson }: { me: Me; personId: string; clubId: string | null; openPerson?: (id: string) => void }) {
  const [d, setD] = useState<Fam | null>(null);
  const [adding, setAdding] = useState(false);
  const [relation, setRelation] = useState('');
  const [err, setErr] = useState('');
  const who = usePersonSearch(clubId);
  const load = () => clubId ? api<Fam>('GET', `/api/persons/${personId}/family?clubId=${clubId}`).then(setD).catch((x) => setErr(errText(x))) : undefined;
  useEffect(() => { load(); }, [personId, clubId]);
  if (!clubId || !d) return null;
  const run = async (f: () => Promise<unknown>, ok: string) => { setErr(''); try { await f(); toast(ok); setAdding(false); setRelation(''); who.reset(); load(); } catch (x) { setErr(errText(x)); } };
  const g = d.group;
  if (!g && !d.canManage) return null;
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>Семья</h2>{g && <span className="small muted">скидка второму и следующим {d.discountPercent} %</span>}</div>
      {err && <div className="err">{err}</div>}
      {!g ? (
        <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="small muted">Семейный абонемент: один плательщик, у каждого свой абонемент и проход. Второму и следующим — скидка {d.discountPercent} %.</span>
          <button className="btn sm" onClick={() => run(() => api('POST', '/api/families', { clubId, payerId: personId }), 'Семья создана: клиент — плательщик')}>Создать семью</button>
        </div>
      ) : <>
        <div className="list">{g.members.map((m) => (
          <div key={m.personId} className="row between small" style={{ gap: 8 }}>
            <span>{m.personId === personId || !openPerson ? <b>{m.name}</b> : <button className="link" onClick={() => openPerson(m.personId)}>{m.name}</button>}
              {m.payer ? <span className="chip acc" style={{ marginLeft: 6 }}>плательщик</span> : m.relation ? <span className="muted"> · {m.relation}</span> : null}</span>
            <span className="row" style={{ gap: 6 }}>
              <span className="muted">{m.active?.length ? m.active.map((a) => `${a.product}${a.endsOn ? ` до ${ru(a.endsOn)}` : ''}`).join(', ') : 'нет абонемента'}</span>
              {d.canManage && !m.payer && <button className="btn sm" onClick={() => run(() => api('POST', `/api/families/${g.id}/members/${m.personId}/remove`), 'Убран из семьи')} aria-label={`Убрать ${m.name} из семьи`}>×</button>}
            </span>
          </div>))}</div>
        {d.canManage && g.members.length < d.maxMembers && (adding ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {who.ui('Член семьи: имя или телефон')}
            <div className="row" style={{ gap: 6 }}>
              <input value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="Кем приходится: жена, сын…" aria-label="Кем приходится" style={{ maxWidth: 220 }} />
              <button className="btn sm pri" disabled={!who.person} onClick={() => run(() => api('POST', `/api/families/${g.id}/members`, { personId: who.person!.id, relation }), 'Добавлен в семью')}>Добавить</button>
              <button className="btn sm" onClick={() => setAdding(false)}>Отмена</button>
            </div>
            <span className="small muted">Нет в базе? Сначала заведите его как клиента (раздел «Лиды»), затем добавьте сюда.</span>
          </div>) : <div><button className="btn sm" onClick={() => setAdding(true)}>+ Добавить члена семьи</button></div>)}
        {g.due.length > 0 && (
          <div className="item" style={{ display: 'grid', gap: 6 }}>
            <b>К оплате за семью: {rub(g.dueKop)}</b>
            {g.due.map((c) => <div key={c.id} className="row between small"><span>{c.person}: {c.title}</span><span>{rub(c.amountKop)}</span></div>)}
            {can(me, 'memberships.manage') && <div className="row" style={{ gap: 6 }}>
              <button className="btn sm pri" onClick={() => run(() => api('POST', `/api/families/${g.id}/pay`, { method: 'card_terminal' }), 'Оплата за семью отмечена')}>Оплатить всё картой</button>
              <button className="btn sm" onClick={() => run(() => api('POST', `/api/families/${g.id}/pay`, { method: 'cash' }), 'Оплата за семью отмечена')}>Наличными</button>
            </div>}
          </div>)}
        <span className="small muted">При продаже абонемента члену семьи выберите «Кто платит: семья» — скидка посчитается сама.</span>
      </>}
    </div>
  );
}

/* ---------- раздел «Компании» ---------- */
type CompanyRow = { id: string; name: string; inn: string | null; contractNumber: string | null; discountPercent: number; status: string; maxEmployees: number | null; employees: number; uninvoicedKop: number; unpaidKop: number };
type Company = { id: string; clubId: string; name: string; inn: string | null; kpp: string | null; address: string | null; contactName: string | null; contactPhone: string | null; contactEmail: string | null;
  contractNumber: string | null; contractDate: string | null; discountPercent: number; paymentDays: number; maxEmployees: number | null; status: string };
type Detail = { company: Company; month: string; canManage: boolean;
  employees: { id: string; personId: string; name: string; position: string | null; addedAt: string; membership: string | null; visits: number; lastVisit: string | null }[];
  invoices: { id: string; number: string; period: string; amountKop: number; dueOn: string; status: string; createdAt: string; paidAt: string | null }[];
  pending: { id: string; title: string; amountKop: number; person: string; dueOn: string }[] };
const EMPTY: Partial<Company> = { name: '', discountPercent: 10, paymentDays: 10, maxEmployees: null };
const INV: Record<string, [string, string]> = { issued: ['выставлен', 'warn'], paid: ['оплачен', 'ok'], cancelled: ['отменён', ''] };

export function CompaniesPage({ me: _me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [list, setList] = useState<{ items: CompanyRow[]; canManage: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Company> | null>(null);
  const [err, setErr] = useState('');
  const load = () => club && api<NonNullable<typeof list>>('GET', `/api/companies?clubId=${club}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { load(); setOpen(null); }, [club]);
  const save = async () => {
    setErr('');
    try {
      const body = { ...form, clubId: club };
      if (form!.id) await api('PATCH', `/api/companies/${form!.id}`, body); else { const r = await api<{ id: string }>('POST', '/api/companies', body); setOpen(r.id); }
      toast('Сохранено'); setForm(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  if (!club) return <p className="muted">Клубов нет.</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <p className="muted" style={{ margin: 0, maxWidth: 760 }}>Корпоративные клиенты: договор с компанией, список сотрудников, абонементы за счёт компании, счёт юрлицу раз в месяц и отчёт о посещениях.</p>
        <div className="row" style={{ gap: 8 }}>
          {clubId === 'all' && <select value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          {list?.canManage && !form && <button className="btn pri" onClick={() => setForm({ ...EMPTY })}>+ Компания</button>}
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {form && <CompanyForm v={form} set={setForm} save={save} cancel={() => setForm(null)} />}
      {!list ? <p className="muted">Загрузка…</p> : list.items.length === 0 ? <p className="muted">Компаний пока нет.</p> : (
        <div className="card"><div className="tbl"><table>
          <thead><tr><th>Компания</th><th>Договор</th><th>Скидка</th><th>Сотрудников</th><th>Ещё не в счёте</th><th>Счета не оплачены</th></tr></thead>
          <tbody>{list.items.map((c) => <Fragment key={c.id}>
            <tr className={open === c.id ? 'sel' : ''} style={{ cursor: 'pointer', opacity: c.status === 'archived' ? 0.6 : 1 }} onClick={() => setOpen(open === c.id ? null : c.id)}>
              <td><b>{c.name}</b>{c.inn && <div className="small muted">ИНН {c.inn}</div>}</td><td className="small">{c.contractNumber ?? '—'}</td><td>{c.discountPercent} %</td>
              <td>{c.employees}{c.maxEmployees ? ` из ${c.maxEmployees}` : ''}</td><td>{rub(c.uninvoicedKop)}</td><td className={c.unpaidKop ? 'bad' : ''}>{rub(c.unpaidKop)}</td></tr>
            {open === c.id && <tr><td colSpan={6} style={{ padding: 0 }}><CompanyDetail id={c.id} openPerson={openPerson} edit={(x) => setForm(x)} reloadList={load} /></td></tr>}
          </Fragment>)}</tbody></table></div></div>)}
    </div>
  );
}

function CompanyForm({ v, set, save, cancel }: { v: Partial<Company>; set: (x: Partial<Company>) => void; save: () => void; cancel: () => void }) {
  const f = (k: keyof Company, label: string, type = 'text') => <label className="f">{label}<input type={type} value={(v[k] as string | number | null) ?? ''}
    onChange={(e) => set({ ...v, [k]: type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value })} /></label>;
  return (
    <div className="card" style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
      <h2>{v.id ? 'Компания' : 'Новая компания'}</h2>
      <div className="grid2">{f('name', 'Название')}{f('inn', 'ИНН')}{f('kpp', 'КПП')}{f('address', 'Адрес')}{f('contactName', 'Контактное лицо')}{f('contactPhone', 'Телефон')}{f('contactEmail', 'E-mail для счетов')}
        {f('contractNumber', 'Номер договора')}{f('contractDate', 'Дата договора', 'date')}{f('discountPercent', 'Скидка сотрудникам, %', 'number')}{f('paymentDays', 'Срок оплаты счёта, дней', 'number')}{f('maxEmployees', 'Сотрудников по договору, не больше', 'number')}</div>
      {v.id && <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={v.status === 'archived'} onChange={(e) => set({ ...v, status: e.target.checked ? 'archived' : 'active' })} />Договор закончился (в архив)</label>}
      <div className="row" style={{ gap: 6 }}><button className="btn sm pri" onClick={save}>Сохранить</button><button className="btn sm" onClick={cancel}>Отмена</button></div>
    </div>
  );
}

function CompanyDetail({ id, openPerson, edit, reloadList }: { id: string; openPerson: (id: string) => void; edit: (c: Company) => void; reloadList: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [month, setMonth] = useState('');
  const [adding, setAdding] = useState(false);
  const [position, setPosition] = useState('');
  const [err, setErr] = useState('');
  const load = () => api<Detail>('GET', `/api/companies/${id}${month ? `?month=${month}` : ''}`).then((x) => { setD(x); if (!month) setMonth(x.month); }).catch((x) => setErr(errText(x)));
  const who = usePersonSearch(d?.company.clubId ?? null);
  useEffect(() => { load(); }, [id, month]);
  if (!d) return err ? <div className="err">{err}</div> : <p className="muted" style={{ padding: 12 }}>Загрузка…</p>;
  const run = async (f: () => Promise<unknown>, ok: string) => { setErr(''); try { await f(); toast(ok); setAdding(false); setPosition(''); who.reset(); load(); reloadList(); } catch (x) { setErr(errText(x)); } };
  const csv = () => {
    const rows = [['Сотрудник', 'Должность', 'Абонемент', `Посещений за ${month}`, 'Последний визит'], ...d.employees.map((e) => [e.name, e.position ?? '', e.membership ?? '', String(e.visits), e.lastVisit ? dt(e.lastVisit) : ''])];
    const blob = new Blob(['﻿' + rows.map((r) => r.map((x) => `"${x.replace(/"/g, '""')}"`).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${d.company.name} посещения ${month}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const c = d.company;
  return (
    <div style={{ display: 'grid', gap: 10, padding: 12, background: 'var(--bg)' }}>
      {err && <div className="err">{err}</div>}
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="small">{c.contractNumber ? `Договор № ${c.contractNumber}${c.contractDate ? ` от ${ru(c.contractDate)}` : ''}` : 'Номер договора не указан'} · скидка {c.discountPercent} % · счёт оплачивается за {c.paymentDays} дн.
          {c.contactName ? ` · ${c.contactName}` : ''}{c.contactPhone ? `, ${c.contactPhone}` : ''}{c.contactEmail ? `, ${c.contactEmail}` : ''}</span>
        {d.canManage && <button className="btn sm" onClick={() => edit(c)}>Изменить</button>}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2>Сотрудники и посещения</h2>
          <span className="row" style={{ gap: 6 }}><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Месяц отчёта" style={{ width: 'auto' }} />
            <button className="btn sm" onClick={csv} disabled={!d.employees.length}>Отчёт для компании (CSV)</button></span></div>
        {d.employees.length === 0 ? <p className="muted" style={{ margin: 0 }}>Сотрудников пока нет.</p> : (
          <div className="tbl"><table><thead><tr><th>Сотрудник</th><th>Абонемент</th><th>Посещений</th><th>Последний визит</th><th></th></tr></thead>
            <tbody>{d.employees.map((e) => <tr key={e.id}><td><button className="link" onClick={() => openPerson(e.personId)}>{e.name}</button>{e.position && <div className="small muted">{e.position}</div>}</td>
              <td className="small">{e.membership ?? <span className="muted">нет</span>}</td><td>{e.visits}</td><td className="small">{e.lastVisit ? dt(e.lastVisit) : '—'}</td>
              <td><button className="btn sm" onClick={() => run(() => api('POST', `/api/companies/${id}/employees/${e.id}/remove`), 'Убран из списка сотрудников')}>Убрать</button></td></tr>)}</tbody></table></div>)}
        {c.status === 'active' && (adding ? (
          <div style={{ display: 'grid', gap: 6, maxWidth: 520 }}>
            {who.ui('Сотрудник: имя или телефон клиента')}
            <div className="row" style={{ gap: 6 }}><input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Должность (необязательно)" aria-label="Должность" />
              <button className="btn sm pri" disabled={!who.person} onClick={() => run(() => api('POST', `/api/companies/${id}/employees`, { personId: who.person!.id, position }), 'Сотрудник добавлен')}>Добавить</button>
              <button className="btn sm" onClick={() => setAdding(false)}>Отмена</button></div>
          </div>) : <div><button className="btn sm" onClick={() => setAdding(true)}>+ Сотрудник</button> <span className="small muted">Абонемент продаётся в карточке сотрудника: «Кто платит — компания».</span></div>)}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2>Счета</h2>
          {d.canManage && d.pending.length > 0 && <button className="btn sm pri" onClick={() => run(() => api('POST', `/api/companies/${id}/invoices`, { period: month }), 'Счёт выставлен')}>Выставить счёт за {month.split('-').reverse().join('.')}</button>}</div>
        {d.pending.length > 0 && <div className="small">Ещё не в счёте: {d.pending.map((p) => `${p.person} — ${p.title}, ${rub(p.amountKop)}`).join('; ')}</div>}
        {d.invoices.length === 0 ? <p className="muted" style={{ margin: 0 }}>Счетов пока нет.</p> : (
          <div className="tbl"><table><thead><tr><th>Счёт</th><th>Месяц</th><th>Сумма</th><th>Оплатить до</th><th>Статус</th><th></th></tr></thead>
            <tbody>{d.invoices.map((i) => { const [l, cls] = INV[i.status] ?? [i.status, '']; return <tr key={i.id}><td><b>{i.number}</b></td><td>{i.period.split('-').reverse().join('.')}</td><td>{rub(i.amountKop)}</td><td>{ru(i.dueOn)}</td>
              <td><span className={`chip ${cls}`}>{l}</span></td>
              <td className="row" style={{ gap: 6 }}><a className="btn sm" href={`/api/company-invoices/${i.id}/print`} target="_blank" rel="noreferrer">Печать</a>
                {d.canManage && i.status === 'issued' && <><button className="btn sm pri" onClick={() => run(() => api('POST', `/api/company-invoices/${i.id}/paid`), 'Оплата счёта отмечена, абонементы оплачены')}>Оплачен</button>
                  <button className="btn sm" onClick={() => run(() => api('POST', `/api/company-invoices/${i.id}/cancel`), 'Счёт отменён')}>Отменить</button></>}</td></tr>; })}</tbody></table></div>)}
      </div>
    </div>
  );
}
