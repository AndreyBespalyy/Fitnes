// Быстрый режим ресепшна: один экран под планшет. Поиск по телефону, карте или имени → карточка с фото и решением о проходе →
// крупные кнопки. Горячие клавиши для компьютера: «/» или F2 — поиск, Enter — первый найденный, 1–5 — действия, Esc — следующий клиент.
import { useEffect, useRef, useState } from 'react';
import { api, can, type Club, type Me } from './api.ts';
import { errText, toast } from './ui.ts';

type Found = { id: string; name: string; phone: string | null; hasPhoto: boolean; lastVisit: string | null; byCard: boolean; homeClub: boolean };
type Card = {
  id: string; name: string; phone: string | null; hasPhoto: boolean; birthday: boolean; inside: boolean;
  verdict: { allow: boolean; reason: string; warn: string | null; reasonCode: string };
  memberships: { id: string; productName: string; kind: string; endsOn: string | null; visitsLeft: number | null; state: string; access: boolean; reason: string }[];
  debts: { id: string; title: string; amountKop: number; dueOn: string; overdue: boolean; productName: string }[];
  renew: { membershipId: string; productName: string; priceKop: number } | null;
  single: { productId: string; name: string; priceKop: number } | null;
  depositKop: number; bookings: { id: string; typeName: string; at: string; status: string }[]; lastVisit: { at: string } | null;
  canSell: boolean; canTakeMoney: boolean;
};
type Goods = { id: string; name: string; kind: string; priceKop: number; stock: number | null; isActive: boolean };
type Mode = null | { op: 'single' | 'renew' | 'pay_debt' } | { op: 'goods' } | { op: 'manual' };
const rub = (k: number) => `${Math.round(k / 100).toLocaleString('ru-RU')} ₽`;
const METHODS: [string, string][] = [['card_terminal', 'Картой'], ['sbp', 'СБП'], ['cash', 'Наличными']];
const REASONS: [string, string][] = [['forgot_card', 'Забыл карту'], ['card_not_read', 'Карта не считывается'], ['guest', 'Гость по приглашению'], ['admin_decision', 'Решение администратора'], ['other', 'Другое']];
const ru = (d: string | null) => (d ? d.split('-').reverse().join('.') : '');

export function DeskPage({ me, clubs, clubId, openPerson }: { me: Me; clubs: Club[]; clubId: string; openPerson: (id: string) => void }) {
  const [club, setClub] = useState(clubId !== 'all' ? clubId : clubs[0]?.id ?? '');
  useEffect(() => { if (clubId !== 'all') setClub(clubId); }, [clubId]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [photoV, setPhotoV] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  // Замер: от первого ввода в поиске до результата операции, с числом касаний
  const metric = useRef<{ t0: number; taps: number } | null>(null);
  const tap = () => { if (metric.current) metric.current.taps++; };
  const measure = (op: string) => {
    const m = metric.current; metric.current = null;
    if (m) api('POST', '/api/desk/ops', { clubId: club, op, ms: Math.round(performance.now() - m.t0), taps: m.taps }).catch(() => null);
  };

  useEffect(() => {
    if (q.trim().length < 2) { setFound(null); return; }
    const t = setTimeout(() => api<Found[]>('GET', `/api/desk/find?clubId=${club}&q=${encodeURIComponent(q.trim())}`).then((r) => {
      setFound(r);
      // Карта или единственное совпадение по телефону — сразу открываем
      if (r.length === 1 && (r[0].byCard || q.replace(/\D/g, '').length >= 10)) open(r[0].id);
    }).catch((x) => setErr(errText(x))), 220);
    return () => clearTimeout(t);
  }, [q, club]);

  const open = async (id: string, keepDone = false) => {
    setErr(''); setMode(null); if (!keepDone) setDone(null);
    try { setCard(await api<Card>('GET', `/api/desk/person/${id}?clubId=${club}`)); } catch (x) { setErr(errText(x)); }
  };
  const reload = () => card && open(card.id, true);
  const next = () => { setQ(''); setFound(null); setCard(null); setMode(null); setDone(null); setErr(''); setNewName(''); metric.current = null; setTimeout(() => search.current?.focus(), 0); };
  const run = async (op: string, fn: () => Promise<{ ok: boolean; text: string }>) => {
    if (busy) return;
    setBusy(true); setErr('');
    try { const r = await fn(); setDone(r); if (r.ok) measure(op); setMode(null); await reload(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };

  const pass = () => card && run('pass', async () => {
    const r = await api<{ ok: boolean; reason: string; warn: string | null; effect?: string }>('POST', '/api/desk/pass', { clubId: club, personId: card.id });
    return r.ok ? { ok: true, text: r.effect === 'repeat' ? 'Уже в клубе — повторный проход' : `Проходите! ${r.warn ?? ''}` } : { ok: false, text: r.reason };
  });
  const payWith = (method: string) => {
    if (!card || !mode) return;
    if (mode.op === 'single') run('single', async () => {
      const r = await api<{ pass: { ok: boolean; reason: string } }>('POST', '/api/desk/single', { clubId: club, personId: card.id, method });
      return { ok: true, text: r.pass.ok ? 'Разовый визит оплачен — проходите!' : `Оплачено, но проход не открыт: ${r.pass.reason}` };
    });
    if (mode.op === 'renew' && card.renew) run('renew', async () => {
      const r = await api<{ startsOn: string; endsOn: string | null }>('POST', '/api/desk/renew', { clubId: club, membershipId: card.renew!.membershipId, method });
      return { ok: true, text: `Продлено: ${card.renew!.productName}${r.endsOn ? ` с ${ru(r.startsOn)} по ${ru(r.endsOn)}` : ''}` };
    });
    if (mode.op === 'pay_debt') run('pay_debt', async () => {
      const r = await api<{ paid: number; totalKop: number }>('POST', '/api/desk/pay-debts', { clubId: club, personId: card.id, method });
      return { ok: true, text: `Долг погашен: ${rub(r.totalKop)}` };
    });
  };
  const debtKop = card ? card.debts.reduce((s, d) => s + d.amountKop, 0) : 0;
  const actions: { key: string; label: string; sub?: string; show: boolean; pri?: boolean; act: () => void }[] = card ? [
    { key: '1', label: 'Пропустить', sub: card.verdict.allow ? undefined : 'система не пустит', show: true, pri: card.verdict.allow, act: () => (card.verdict.allow ? pass() : setMode({ op: 'manual' })) },
    { key: '2', label: 'Разовый визит', sub: card.single ? rub(card.single.priceKop) : undefined, show: !!card.single && card.canSell && card.canTakeMoney, pri: !card.verdict.allow && !card.renew, act: () => setMode({ op: 'single' }) },
    { key: '3', label: 'Продлить', sub: card.renew ? `${card.renew.productName}, ${rub(card.renew.priceKop)}` : undefined, show: !!card.renew && card.canSell && card.canTakeMoney, pri: !card.verdict.allow && !!card.renew, act: () => setMode({ op: 'renew' }) },
    { key: '4', label: 'Товар', show: true, act: () => setMode({ op: 'goods' }) },
    { key: '5', label: 'Погасить долг', sub: debtKop ? rub(debtKop) : undefined, show: debtKop > 0 && card.canTakeMoney, pri: debtKop > 0 && card.verdict.reasonCode === 'debt', act: () => setMode({ op: 'pay_debt' }) },
  ] : [];

  // Горячие клавиши
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if (e.key === 'F2' || (e.key === '/' && !inInput)) { e.preventDefault(); search.current?.focus(); search.current?.select(); return; }
      if (e.key === 'Escape') { e.preventDefault(); if (mode) setMode(null); else next(); return; }
      if (e.key === 'Enter' && document.activeElement === search.current && found?.length) { e.preventDefault(); tap(); open(found[0].id); search.current?.blur(); return; }
      if (inInput || !card || busy || e.metaKey || e.ctrlKey || e.altKey) return;
      if (mode && 'op' in mode && ['single', 'renew', 'pay_debt'].includes(mode.op)) {
        const m = METHODS[Number(e.key) - 1]; if (m) { e.preventDefault(); tap(); payWith(m[0]); } return;
      }
      if (mode) return;
      const a = actions.find((x) => x.key === e.key && x.show); if (a) { e.preventDefault(); tap(); a.act(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  useEffect(() => { search.current?.focus(); }, []);

  const createClient = async () => {
    setErr('');
    try {
      const r = await api<{ personId: string }>('POST', '/api/leads', { clubId: club, fullName: newName.trim(), phone: q.trim(), sourceCode: 'walk_in' });
      measure('new_client'); metric.current = { t0: performance.now(), taps: 0 }; toast('Клиент добавлен'); setNewName(''); open(r.personId);
    } catch (x) { setErr(errText(x)); }
  };
  const phoneLike = q.replace(/\D/g, '').length >= 10;

  return (
    <div className="desk" onPointerDown={tap}>
      <div className="desk-search">
        <div className="row" style={{ gap: 8 }}>
          <input ref={search} className="desk-q" value={q} placeholder="Телефон, карта или имя" aria-label="Поиск клиента" inputMode="search" autoComplete="off"
            onChange={(e) => { if (!metric.current) metric.current = { t0: performance.now(), taps: 1 }; setQ(e.target.value); }} />
          {clubId === 'all' && clubs.length > 1 && <select value={club} onChange={(e) => setClub(e.target.value)} aria-label="Клуб" style={{ width: 'auto' }}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        </div>
        {found && !card && (
          <div className="desk-found">
            {found.map((f, i) => (
              <button key={f.id} className="desk-hit" onClick={() => open(f.id)}>
                <Avatar id={f.id} has={f.hasPhoto} v={photoV} size={44} />
                <span style={{ display: 'grid', textAlign: 'left' }}><b>{f.name}</b><span className="small muted">{f.phone ?? 'телефона нет'}{f.byCard ? ' · по карте' : ''}{!f.homeClub ? ' · другой клуб' : ''}</span></span>
                {i === 0 && <kbd className="hide-narrow">Enter</kbd>}
              </button>))}
            {found.length === 0 && <p className="muted" style={{ margin: 0 }}>Никого не нашли.</p>}
            {found.length === 0 && phoneLike && can(me, 'leads.create') && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Имя и фамилия нового клиента" style={{ flex: 1, minWidth: 200 }} />
                <button className="btn pri" disabled={newName.trim().length < 2} onClick={createClient}>Новый клиент</button>
              </div>)}
          </div>)}
        {!found && !card && <p className="muted small" style={{ margin: 0 }}>Наберите 4 последние цифры телефона, приложите карту к считывателю или начните имя. Клавиши: «/» — поиск, Enter — выбрать, 1–5 — действия, Esc — следующий.</p>}
      </div>
      {err && <div className="err">{err}</div>}

      {card && (
        <div className={`desk-card ${card.verdict.allow ? 'ok' : 'no'}`}>
          <div className="desk-head">
            <Photo card={card} v={photoV} onSaved={() => setPhotoV((x) => x + 1)} />
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <button className="link desk-name" onClick={() => openPerson(card.id)}>{card.name}</button>
              <span className="small muted">{card.phone ?? ''}{card.depositKop ? ` · депозит ${rub(card.depositKop)}` : ''}{card.inside ? ' · сейчас в клубе' : ''}</span>
              {card.birthday && <span className="chip acc">Сегодня день рождения — поздравьте!</span>}
              <div className={`desk-verdict ${card.verdict.allow ? 'ok' : 'no'}`}>{card.verdict.allow ? '✓ Можно' : '✕ Нельзя'}: {card.verdict.reason}</div>
              {card.verdict.warn && <span className="small bad">{card.verdict.warn}</span>}
            </div>
          </div>

          {done && <div className={`desk-done ${done.ok ? 'ok' : 'no'}`} role="status">{done.text}{done.ok && <button className="btn sm" onClick={next} style={{ marginLeft: 'auto' }}>Следующий (Esc)</button>}</div>}

          {!mode && (
            <div className="desk-actions">
              {actions.filter((a) => a.show).map((a) => (
                <button key={a.key} className={`desk-btn ${a.pri ? 'pri' : ''}`} disabled={busy} onClick={a.act}>
                  <span>{a.label}</span>{a.sub && <span className="small">{a.sub}</span>}<kbd className="hide-narrow">{a.key}</kbd>
                </button>))}
            </div>)}

          {mode && mode.op !== 'goods' && mode.op !== 'manual' && (
            <div className="desk-pay">
              <b>{mode.op === 'single' ? `Разовый визит, ${rub(card.single?.priceKop ?? 0)}` : mode.op === 'renew' ? `Продлить «${card.renew?.productName}», ${rub(card.renew?.priceKop ?? 0)}` : `Погасить долг ${rub(debtKop)}`} — как платит?</b>
              <div className="desk-actions">
                {METHODS.map(([m, l], i) => <button key={m} className="desk-btn pri" disabled={busy} onClick={() => payWith(m)}><span>{l}</span><kbd className="hide-narrow">{i + 1}</kbd></button>)}
              </div>
              <button className="btn" onClick={() => setMode(null)}>Отмена (Esc)</button>
            </div>)}
          {mode?.op === 'goods' && <QuickGoods club={club} personId={card.id} depositKop={card.depositKop} onDone={(t) => { setDone({ ok: true, text: t }); measure('goods'); setMode(null); reload(); }} onCancel={() => setMode(null)} />}
          {mode?.op === 'manual' && <ManualPass club={club} card={card} onDone={(t) => { setDone({ ok: true, text: t }); measure('manual_pass'); setMode(null); reload(); }} onCancel={() => setMode(null)} />}

          <div className="desk-info">
            {card.memberships.length === 0 ? <span className="muted small">Абонементов нет</span> : card.memberships.map((m) => (
              <div key={m.id} className="row between small" style={{ gap: 8 }}><span><b>{m.productName}</b>{m.visitsLeft != null ? ` · осталось ${m.visitsLeft}` : ''}</span>
                <span className={m.access ? 'muted' : 'bad'}>{m.reason}</span></div>))}
            {card.debts.map((d) => <div key={d.id} className="row between small bad"><span>{d.title}</span><span>{rub(d.amountKop)}{d.overdue ? `, срок был ${ru(d.dueOn)}` : `, до ${ru(d.dueOn)}`}</span></div>)}
            {card.bookings.map((b) => <div key={b.id} className="small">Сегодня в {b.at}: {b.typeName}</div>)}
          </div>
        </div>)}
      {!card && <Speed club={club} />}
    </div>
  );
}

function Avatar({ id, has, v, size }: { id: string; has: boolean; v: number; size: number }) {
  return has ? <img src={`/api/persons/${id}/photo?v=${v}`} alt="" width={size} height={size} className="desk-ava" />
    : <span className="desk-ava empty" style={{ width: size, height: size }} aria-hidden>☺</span>;
}

/** Фото для сверки: снимок с камеры планшета или файл, уменьшаем до 360 px и отправляем. */
function Photo({ card, v, onSaved }: { card: Card; v: number; onSaved: () => void }) {
  const inp = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr('');
    try {
      const img = await createImageBitmap(f);
      const k = Math.min(1, 360 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      await api('PUT', `/api/persons/${card.id}/photo`, { image: c.toDataURL('image/jpeg', 0.82) });
      toast('Фото сохранено'); onSaved();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <div style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
      <button className="desk-photo" onClick={() => inp.current?.click()} title={card.hasPhoto ? 'Переснять фото' : 'Сфотографировать'}>
        {card.hasPhoto || v ? <img src={`/api/persons/${card.id}/photo?v=${v}`} alt={`Фото: ${card.name}`} /> : <span>📷<br /><span className="small">Сделать фото</span></span>}
      </button>
      <input ref={inp} type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {err && <span className="small bad">{err}</span>}
    </div>
  );
}

function QuickGoods({ club, personId, depositKop, onDone, onCancel }: { club: string; personId: string; depositKop: number; onDone: (t: string) => void; onCancel: () => void }) {
  const [items, setItems] = useState<Goods[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ items: Goods[] }>('GET', `/api/goods?clubId=${club}`).then((r) => setItems(r.items.filter((g) => g.isActive))).catch((x) => setErr(errText(x))); }, [club]);
  const total = items.reduce((s, g) => s + (cart[g.id] ?? 0) * g.priceKop, 0);
  const sell = async (method: string) => {
    setBusy(true); setErr('');
    try {
      await api('POST', '/api/goods/sales', { clubId: club, personId, method, items: Object.entries(cart).filter(([, n]) => n > 0).map(([goodsId, qty]) => ({ goodsId, qty })) });
      onDone(`Продано на ${rub(total)}`);
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <div className="desk-pay">
      <div className="desk-goods">
        {items.map((g) => (
          <button key={g.id} className={`desk-good ${cart[g.id] ? 'on' : ''}`} disabled={g.kind === 'goods' && (g.stock ?? 0) <= (cart[g.id] ?? 0)}
            onClick={() => setCart({ ...cart, [g.id]: (cart[g.id] ?? 0) + 1 })}>
            <b>{g.name}</b><span className="small">{rub(g.priceKop)}{g.kind === 'goods' ? ` · ост. ${g.stock ?? 0}` : ''}</span>
            {cart[g.id] ? <span className="chip acc">× {cart[g.id]}</span> : null}
          </button>))}
        {items.length === 0 && !err && <span className="muted small">Товаров и услуг пока нет: добавьте их в разделе «Магазин».</span>}
      </div>
      {err && <div className="err">{err}</div>}
      {total > 0 && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <b style={{ alignSelf: 'center' }}>Итого {rub(total)}</b>
        {METHODS.map(([m, l]) => <button key={m} className="btn pri" disabled={busy} onClick={() => sell(m)}>{l}</button>)}
        {depositKop >= total && <button className="btn" disabled={busy} onClick={() => sell('deposit')}>С депозита</button>}
        <button className="btn" onClick={() => setCart({})}>Очистить</button>
      </div>}
      <button className="btn" onClick={onCancel}>Отмена (Esc)</button>
    </div>
  );
}

function ManualPass({ club, card, onDone, onCancel }: { club: string; card: Card; onDone: (t: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    try { await api('POST', '/api/acs/manual', { clubId: club, personId: card.id, reason, comment }); onDone('Пропущен вручную. Проход попадёт в отчёт для управляющего'); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="desk-pay">
      <b>Система не пускает: {card.verdict.reason}. Пустить под вашу ответственность?</b>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {REASONS.map(([k, l]) => <button key={k} className={`btn ${reason === k ? 'pri' : ''}`} aria-pressed={reason === k} onClick={() => setReason(k)}>{l}</button>)}
      </div>
      {(reason === 'other' || reason === 'admin_decision') && <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Почему пускаете" />}
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ gap: 6 }}><button className="btn pri" disabled={!reason} onClick={go}>Пустить</button><button className="btn" onClick={onCancel}>Отмена (Esc)</button></div>
    </div>
  );
}

const OP_NAMES: Record<string, string> = { pass: 'Пропустить', single: 'Разовый визит', renew: 'Продление', goods: 'Товар', pay_debt: 'Погасить долг', new_client: 'Новый клиент', manual_pass: 'Ручной проход' };
/** Замеры на пилоте: сколько секунд и касаний занимает каждая операция. */
function Speed({ club }: { club: string }) {
  const [s, setS] = useState<{ days: number; ops: { op: string; n: number; medianMs: number; avgTaps: number; maxTaps: number }[] } | null>(null);
  useEffect(() => { api<NonNullable<typeof s>>('GET', `/api/desk/stats?clubId=${club}`).then(setS).catch(() => setS(null)); }, [club]);
  if (!s || !s.ops.length) return null;
  return (
    <details className="card">
      <summary><b>Скорость ресепшна за {s.days} дней</b></summary>
      <div className="tbl"><table><thead><tr><th>Операция</th><th>Сколько раз</th><th>Обычно, сек</th><th>Касаний в среднем</th></tr></thead>
        <tbody>{s.ops.map((o) => <tr key={o.op}><td>{OP_NAMES[o.op] ?? o.op}</td><td className="num">{o.n}</td><td className="num">{(o.medianMs / 1000).toFixed(1)}</td><td className={`num ${o.avgTaps > 3 ? 'bad' : ''}`}>{o.avgTaps}</td></tr>)}</tbody></table></div>
      <span className="small muted">Время считается от первого ввода в поиске до результата. Цель — не больше 3 касаний.</span>
    </details>
  );
}
