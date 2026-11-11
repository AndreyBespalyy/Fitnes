// Шаг 8 (финансы). Раздел «Финансы»: смена, согласования, расходы, ДДС, план-факт, долги, журнал платежей.
// Плюс форма возврата в карточке клиента.
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type Club, type Me, navParams } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { rub } from './memberships.tsx';
import { BankReconciliation, OnlinePayments } from './payments.tsx';

type Shift = { id: string; status: string; openedAt: string; closedAt: string | null; openingCashKop: number; expectedCashKop: number | null; countedCashKop: number | null;
  note: string | null; openedBy: string; closedBy: string | null; cashMovementKop: number };
type Approval = { id: string; clubName: string; kind: string; amountKop: number; summary: string; status: string; auto: boolean; requestedAt: string; requestedBy: string;
  decidedBy: string | null; decidedAt: string | null; comment: string | null; canDecide: boolean };
type Expense = { id: string; categoryName: string; amountKop: number; description: string; method: string; spentOn: string; status: string; createdBy: string };
type Cashflow = { inflowKop: number; refundsKop: number; expensesKop: number; netKop: number; inflowByMethod: Row[]; inflowByCategory: Row[]; expensesByCategory: Row[] };
type Row = { name: string; amountKop: number };
type PlanFact = { items: { category: string; name: string; planKop: number; factKop: number; percent: number | null }[]; totalPlanKop: number; totalFactKop: number; totalPercent: number | null };
type Debt = { personId: string; personName: string; clubName: string; debtKop: number; charges: number; oldestDueOn: string; daysOverdue: number };
type Payment = { id: string; at: string; direction: string; kind: string; amountKop: number; method: string; personName: string | null; title: string; createdBy: string | null };

const toKop = (s: string) => Math.round(Number(s.replace(',', '.').replace(/\s/g, '')) * 100);
const METHOD: Record<string, string> = { cash: 'наличные', card_terminal: 'карта', sbp: 'СБП', bank_transfer: 'перевод', card: 'карта', online: 'онлайн', other: 'другое' };
const KIND: Record<string, string> = { refund: 'Возврат', expense: 'Расход', discount: 'Скидка' };
const d = (s: string) => s.split('-').reverse().join('.');
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function FinancePage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const views: [string, string, boolean][] = [
    ['shift', 'Касса смены', can(me, 'shifts.work') || can(me, 'finance.view')],
    ['approvals', 'Согласования', can(me, 'approvals.decide') || can(me, 'memberships.manage') || can(me, 'finance.work')],
    ['expenses', 'Расходы', can(me, 'finance.view')],
    ['cashflow', 'ДДС и план-факт', can(me, 'finance.view')],
    ['debts', 'Долги', can(me, 'finance.view')],
    ['payments', 'Журнал платежей', can(me, 'finance.view')],
    ['online', 'Онлайн-оплаты', can(me, 'finance.view')],
    ['bank', 'Сверка с банком', can(me, 'finance.view')],
  ];
  const allowed = views.filter((v) => v[2]);
  const [view, setView] = useState(() => { const v = navParams('finance').view; return allowed.some((a) => a[0] === v) ? v : allowed[0]?.[0] ?? 'shift'; });
  const c = clubs.find((x) => x.id === club);
  if (!c) return <p className="muted">Клубов нет.</p>;
  return (
    <>
      <div className="row between">
        <div className="tabs" role="group" aria-label="Финансы">{allowed.map(([k, t]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{t}</button>)}</div>
        {clubId === 'all' && <select aria-label="Клуб" value={club} onChange={(e) => setClub(e.target.value)} style={{ width: 'auto' }}>{clubs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      </div>
      {view === 'shift' && <ShiftView key={club} me={me} club={c} />}
      {view === 'approvals' && <Approvals key={club} club={c} />}
      {view === 'expenses' && <Expenses key={club} me={me} club={c} />}
      {view === 'cashflow' && <CashflowView key={club} me={me} club={c} />}
      {view === 'debts' && <Debts key={club} club={c} openPerson={openPerson} />}
      {view === 'payments' && <Payments key={club} club={c} />}
      {view === 'online' && <OnlinePayments key={club} club={c} openPerson={openPerson} />}
      {view === 'bank' && <BankReconciliation key={club} me={me} club={c} />}
    </>
  );
}

function ShiftView({ me, club }: { me: Me; club: Club }) {
  const [list, setList] = useState<Shift[]>([]);
  const [cash, setCash] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const reload = () => api<Shift[]>('GET', `/api/shifts?clubId=${club.id}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [club.id]);
  const open = list.find((s) => s.status === 'open');
  const work = can(me, 'shifts.work');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      if (open) { const r = await api<{ differenceKop: number }>('POST', `/api/shifts/${open.id}/close`, { countedCashKop: toKop(cash), note }); toast(r.differenceKop ? `Смена закрыта, расхождение ${rub(r.differenceKop)}` : 'Смена закрыта, касса сошлась'); }
      else { const r = await api<{ warning: string | null }>('POST', '/api/shifts/open', { clubId: club.id, openingCashKop: toKop(cash || '0') }); toast(r.warning ?? 'Смена открыта'); }
      setCash(''); setNote(''); reload();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <h2>{open ? 'Смена открыта' : 'Смена закрыта'}</h2>
        {err && <div className="err">{err}</div>}
        {open ? <div className="kv"><span>Открыта</span><span>{dt(open.openedAt)}, {open.openedBy}</span><span>На начало</span><span>{rub(open.openingCashKop)}</span>
          <span>Движение наличных</span><span>{rub(open.cashMovementKop)}</span><span>Должно быть в кассе</span><span><b>{rub(open.openingCashKop + open.cashMovementKop)}</b></span></div>
          : <p className="small" style={{ margin: 0 }}>Наличные принимаются и выдаются только при открытой смене. Оплаты картой и СБП смену не требуют.</p>}
        {work && <form onSubmit={submit} className="row" style={{ alignItems: 'end' }}>
          <label className="f">{open ? 'Пересчитали наличные, ₽' : 'Наличных в кассе на начало, ₽'}<input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} style={{ width: 160 }} /></label>
          {open && <label className="f" style={{ flex: 1 }}>Комментарий (обязателен при расхождении)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>}
          <button className="btn pri" disabled={open ? !cash : false}>{open ? 'Закрыть смену' : 'Открыть смену'}</button>
        </form>}
      </div>
      <div className="card"><h2>Прошлые смены</h2><div className="tbl"><table>
        <thead><tr><th>Открыта</th><th>Закрыта</th><th>На начало</th><th>Ожидалось</th><th>Пересчитано</th><th>Расхождение</th><th>Комментарий</th></tr></thead>
        <tbody>{list.filter((s) => s.status === 'closed').map((s) => { const diff = (s.countedCashKop ?? 0) - (s.expectedCashKop ?? 0); return (
          <tr key={s.id}><td>{dt(s.openedAt)} · {s.openedBy}</td><td>{dt(s.closedAt)} · {s.closedBy}</td><td className="num">{rub(s.openingCashKop)}</td>
            <td className="num">{rub(s.expectedCashKop)}</td><td className="num">{rub(s.countedCashKop)}</td>
            <td className={`num ${diff ? 'bad' : ''}`}>{diff ? rub(diff) : '—'}</td><td className="small">{s.note}</td></tr>); })}</tbody>
      </table></div></div>
    </>
  );
}

function Approvals({ club }: { club: Club }) {
  const [list, setList] = useState<Approval[]>([]);
  const [all, setAll] = useState(false);
  const [dec, setDec] = useState<{ id: string; decision: 'approve' | 'reject'; password: string; comment: string } | null>(null);
  const [err, setErr] = useState('');
  const reload = () => api<Approval[]>('GET', `/api/approvals?clubId=${club.id}${all ? '' : '&status=pending'}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); }, [club.id, all]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!dec) return; setErr('');
    try { await api('POST', `/api/approvals/${dec.id}/decide`, dec); toast(dec.decision === 'approve' ? 'Утверждено' : 'Отклонено'); setDec(null); reload(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>Согласования</h2><label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={all} onChange={(e) => setAll(e.target.checked)} />показать решённые</label></div>
      <p className="small" style={{ margin: 0 }}>Возвраты и расходы сверх лимита сотрудника ждут решения. Лимиты управляющего: возврат 15 000 ₽, расход 50 000 ₽; сверх них решает собственник. Решение подтверждается вашим паролем.</p>
      {err && <div className="err">{err}</div>}
      {list.length === 0 && <p className="muted" style={{ margin: 0 }}>{all ? 'Согласований нет.' : 'Ничего не ждёт решения.'}</p>}
      {list.map((a) => (
        <div key={a.id} className="item" style={{ display: 'grid', gap: 6 }}>
          <div className="row between"><b>{KIND[a.kind]} · {rub(a.amountKop)}</b>
            <span className={`chip ${a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : 'warn'}`}>{a.status === 'pending' ? 'ждёт решения' : a.status === 'approved' ? (a.auto ? 'в пределах лимита' : 'утверждено') : 'отклонено'}</span></div>
          <div className="small">{a.summary}</div>
          <div className="small">Запросил {a.requestedBy}, {dt(a.requestedAt)}{a.decidedBy && !a.auto ? ` · решение: ${a.decidedBy}, ${dt(a.decidedAt)}` : ''}{a.comment ? ` · ${a.comment}` : ''}</div>
          {a.status === 'pending' && !a.canDecide && <div className="small">Решение принимает сотрудник с достаточным лимитом.</div>}
          {a.canDecide && dec?.id !== a.id && <div className="row">
            <button className="btn sm pri" onClick={() => setDec({ id: a.id, decision: 'approve', password: '', comment: '' })}>Утвердить</button>
            <button className="btn sm" onClick={() => setDec({ id: a.id, decision: 'reject', password: '', comment: '' })}>Отклонить</button></div>}
          {dec?.id === a.id && <form onSubmit={submit} className="row" style={{ alignItems: 'end' }}>
            <label className="f">{dec.decision === 'approve' ? 'Комментарий' : 'Причина отказа'}<input value={dec.comment} onChange={(e) => setDec({ ...dec, comment: e.target.value })} /></label>
            <label className="f">Ваш пароль<input type="password" autoComplete="current-password" value={dec.password} onChange={(e) => setDec({ ...dec, password: e.target.value })} /></label>
            <button className="btn pri sm" disabled={!dec.password}>{dec.decision === 'approve' ? 'Утвердить' : 'Отклонить'}</button>
            <button type="button" className="btn sm" onClick={() => setDec(null)}>Отмена</button>
          </form>}
        </div>))}
    </div>
  );
}

function Expenses({ me, club }: { me: Me; club: Club }) {
  const [month, setMonth] = useState(thisMonth());
  const [list, setList] = useState<Expense[]>([]);
  const [cats, setCats] = useState<{ code: string; name: string }[]>([]);
  const [f, setF] = useState({ category: 'household', amount: '', description: '', method: 'bank_transfer' });
  const [err, setErr] = useState('');
  const reload = () => api<Expense[]>('GET', `/api/expenses?clubId=${club.id}&month=${month}`).then(setList).catch((x) => setErr(errText(x)));
  useEffect(() => { reload(); api<{ code: string; name: string }[]>('GET', '/api/expense-categories').then(setCats).catch(() => {}); }, [club.id, month]);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ status: string }>('POST', '/api/expenses', { clubId: club.id, category: f.category, amountKop: toKop(f.amount), description: f.description, method: f.method });
      toast(r.status === 'approved' ? 'Расход проведён' : 'Расход отправлен на согласование'); setF({ ...f, amount: '', description: '' }); reload();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      {can(me, 'finance.work') && <form className="card" onSubmit={add} style={{ display: 'grid', gap: 8 }}>
        <h2>Новый расход</h2>
        {err && <div className="err">{err}</div>}
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', alignItems: 'end' }}>
          <label className="f">Статья<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
          <label className="f">Сумма, ₽<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label className="f">Как оплачен<select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="bank_transfer">Перевод со счёта</option><option value="card">Корпоративная карта</option><option value="cash">Наличные из кассы</option></select></label>
          <label className="f">Описание<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="за что" /></label>
          <button className="btn pri" disabled={!f.amount || !f.description.trim()}>Провести</button>
        </div>
      </form>}
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>Расходы</h2><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} aria-label="Месяц" /></div>
        <div className="tbl"><table><thead><tr><th>Дата</th><th>Статья</th><th>Описание</th><th>Сумма</th><th>Оплата</th><th>Статус</th><th>Внёс</th></tr></thead>
          <tbody>{list.map((e) => <tr key={e.id}><td>{d(e.spentOn)}</td><td>{e.categoryName}</td><td>{e.description}</td><td className="num">{rub(e.amountKop)}</td><td>{METHOD[e.method]}</td>
            <td><span className={`chip ${e.status === 'approved' ? 'ok' : e.status === 'rejected' ? 'bad' : 'warn'}`}>{e.status === 'approved' ? 'проведён' : e.status === 'rejected' ? 'отклонён' : 'на согласовании'}</span></td><td className="small">{e.createdBy}</td></tr>)}</tbody></table></div>
        {list.length === 0 && <p className="muted" style={{ margin: 0 }}>Расходов за месяц нет.</p>}
      </div>
    </>
  );
}

function Bars({ rows, total }: { rows: Row[]; total: number }) {
  return <div className="list">{rows.map((r) => (
    <div key={r.name} className="bar"><span>{r.name}</span><span className="num">{rub(r.amountKop)}</span>
      <i style={{ width: `${total ? Math.max(2, Math.round(r.amountKop * 100 / total)) : 0}%` }} /></div>))}{rows.length === 0 && <span className="small">нет данных</span>}</div>;
}

function CashflowView({ me, club }: { me: Me; club: Club }) {
  const [month, setMonth] = useState(thisMonth());
  const [cf, setCf] = useState<Cashflow | null>(null);
  const [pf, setPf] = useState<PlanFact | null>(null);
  const [plan, setPlan] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState('');
  const reload = () => {
    api<Cashflow>('GET', `/api/finance/cashflow?clubId=${club.id}&month=${month}`).then(setCf).catch((x) => setErr(errText(x)));
    api<PlanFact>('GET', `/api/finance/plan-fact?clubId=${club.id}&month=${month}`).then(setPf).catch((x) => setErr(errText(x)));
  };
  useEffect(() => { reload(); }, [club.id, month]);
  const savePlan = async (e: FormEvent) => {
    e.preventDefault(); if (!plan) return; setErr('');
    try { await api('PUT', '/api/finance/plan', { clubId: club.id, month, amounts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, toKop(v || '0')])) }); toast('План сохранён'); setPlan(null); reload(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <>
      <div className="row between"><span className="lbl">{club.name}</span><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} aria-label="Месяц" /></div>
      {err && <div className="err">{err}</div>}
      {cf && <div className="kpis">
        <div className="card"><span className="lbl">Поступило</span><b className="num">{rub(cf.inflowKop)}</b></div>
        <div className="card"><span className="lbl">Возвраты</span><b className="num">{rub(cf.refundsKop)}</b></div>
        <div className="card"><span className="lbl">Расходы</span><b className="num">{rub(cf.expensesKop)}</b></div>
        <div className="card"><span className="lbl">Итог движения</span><b className={`num ${cf.netKop < 0 ? 'bad' : ''}`}>{rub(cf.netKop)}</b></div>
      </div>}
      {cf && <div className="grid2">
        <div className="card"><h2>Поступления по способам</h2><Bars rows={cf.inflowByMethod} total={cf.inflowKop} /></div>
        <div className="card"><h2>Расходы по статьям</h2><Bars rows={cf.expensesByCategory} total={cf.expensesKop} /></div>
      </div>}
      {pf && <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between"><h2>План-факт продаж</h2>{can(me, 'finance.work') && !plan && <button className="btn sm" onClick={() => setPlan(Object.fromEntries(pf.items.map((x) => [x.category, String(x.planKop / 100)])))}>Изменить план</button>}</div>
        <form onSubmit={savePlan}><div className="tbl"><table><thead><tr><th>Категория</th><th>План</th><th>Факт</th><th>Выполнение</th></tr></thead>
          <tbody>{pf.items.map((x) => <tr key={x.category}><td>{x.name}</td>
            <td className="num">{plan ? <input inputMode="decimal" value={plan[x.category]} onChange={(e) => setPlan({ ...plan, [x.category]: e.target.value })} style={{ width: 130 }} aria-label={`План: ${x.name}`} /> : rub(x.planKop)}</td>
            <td className="num">{rub(x.factKop)}</td><td>{x.percent === null ? '—' : <span className="meter"><i style={{ width: `${Math.min(100, x.percent)}%` }} />{x.percent} %</span>}</td></tr>)}
            <tr><td><b>Итого</b></td><td className="num"><b>{rub(pf.totalPlanKop)}</b></td><td className="num"><b>{rub(pf.totalFactKop)}</b></td><td>{pf.totalPercent === null ? '—' : `${pf.totalPercent} %`}</td></tr></tbody></table></div>
          {plan && <div className="row" style={{ marginTop: 8 }}><button className="btn pri sm">Сохранить план</button><button type="button" className="btn sm" onClick={() => setPlan(null)}>Отмена</button></div>}
        </form>
        <p className="small" style={{ margin: 0 }}>Факт — поступившие деньги за месяц за вычетом возвратов. Категория определяется при продаже: подписка, продление, возобновление (клиент уже покупал в клубе) или новая продажа.</p>
      </div>}
    </>
  );
}

function Debts({ club, openPerson }: { club: Club; openPerson: (id: string) => void }) {
  const [list, setList] = useState<Debt[]>([]);
  useEffect(() => { api<Debt[]>('GET', `/api/finance/debts?clubId=${club.id}`).then(setList).catch(() => setList([])); }, [club.id]);
  const total = list.reduce((a, x) => a + x.debtKop, 0);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>Долги клиентов</h2><b className="num">{rub(total)}</b></div>
      <div className="tbl"><table><thead><tr><th>Клиент</th><th>Долг</th><th>Платежей</th><th>Самый старый срок</th><th>Просрочка</th></tr></thead>
        <tbody>{list.map((x) => <tr key={x.personId}><td><button className="btn sm" onClick={() => openPerson(x.personId)}>{x.personName}</button></td><td className="num">{rub(x.debtKop)}</td>
          <td>{x.charges}</td><td>{d(x.oldestDueOn)}</td><td className={x.daysOverdue > 3 ? 'bad' : ''}>{x.daysOverdue} дн.</td></tr>)}</tbody></table></div>
      {list.length === 0 && <p className="muted" style={{ margin: 0 }}>Просроченных платежей нет.</p>}
    </div>
  );
}

function Payments({ club }: { club: Club }) {
  const [month, setMonth] = useState(thisMonth());
  const [list, setList] = useState<Payment[]>([]);
  useEffect(() => { api<Payment[]>('GET', `/api/finance/payments?clubId=${club.id}&month=${month}`).then(setList).catch(() => setList([])); }, [club.id, month]);
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row between"><h2>Журнал платежей</h2><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} aria-label="Месяц" /></div>
      <p className="small" style={{ margin: 0 }}>Записи в журнале не меняются и не удаляются. Ошибка исправляется возвратом.</p>
      <div className="tbl"><table><thead><tr><th>Когда</th><th>Операция</th><th>Клиент</th><th>За что</th><th>Способ</th><th>Сумма</th><th>Провёл</th></tr></thead>
        <tbody>{list.map((p) => <tr key={p.id}><td>{dt(p.at)}</td><td>{p.kind === 'charge' ? 'Оплата' : p.kind === 'refund' ? 'Возврат' : 'Расход'}</td><td>{p.personName ?? '—'}</td><td>{p.title}</td>
          <td>{METHOD[p.method] ?? p.method}</td><td className={`num ${p.direction === 'out' ? 'bad' : ''}`}>{p.direction === 'out' ? '−' : ''}{rub(p.amountKop)}</td><td className="small">{p.createdBy ?? 'система'}</td></tr>)}</tbody></table></div>
      {list.length === 0 && <p className="muted" style={{ margin: 0 }}>Платежей за месяц нет.</p>}
    </div>
  );
}

/* ---------- возврат в карточке клиента ---------- */
type Quote = { paidKop: number; usedKop: number; refundedKop: number; suggestedKop: number; maxKop: number; explanation: string };
export function RefundForm({ membershipId, onDone, onCancel }: { membershipId: string; onDone: (msg: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState<Quote | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('card_terminal');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api<Quote>('GET', `/api/memberships/${membershipId}/refund-quote`).then((x) => { setQ(x); setAmount(String(x.suggestedKop / 100)); }).catch((x) => setErr(errText(x))); }, [membershipId]);
  const submit = async () => {
    setErr('');
    try {
      const r = await api<{ status: string }>('POST', `/api/memberships/${membershipId}/refund`, { amountKop: toKop(amount), method, reason, cancelMembership: true });
      onDone(r.status === 'paid' ? 'Возврат проведён, абонемент закрыт' : 'Возврат отправлен на согласование');
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="item" style={{ display: 'grid', gap: 8 }}>
      <b>Возврат денег и закрытие абонемента</b>
      {err && <div className="err">{err}</div>}
      {q && <div className="small">{q.explanation}. Рекомендуемая сумма: <b>{rub(q.suggestedKop)}</b>, максимум {rub(q.maxKop)}.</div>}
      <div className="row" style={{ alignItems: 'end' }}>
        <label className="f">Сумма, ₽<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} /></label>
        <label className="f">Как вернуть<select value={method} onChange={(e) => setMethod(e.target.value)}><option value="card_terminal">На карту (терминал)</option><option value="sbp">СБП</option><option value="cash">Наличными</option><option value="bank_transfer">Переводом по заявлению</option></select></label>
        <label className="f" style={{ flex: 1 }}>Причина<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="переезд, болезнь, по заявлению" /></label>
      </div>
      <div className="row"><button className="btn pri sm" disabled={!amount || !reason.trim()} onClick={submit}>Оформить возврат</button><button className="btn sm" onClick={onCancel}>Отмена</button></div>
      <span className="small">Если сумма больше вашего лимита, возврат уйдёт на согласование управляющему или собственнику.</span>
    </div>
  );
}
