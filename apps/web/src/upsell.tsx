// Подсказки для допродаж: блок в карточке клиента, строка в «Кому звонить» и список «Допродажи».
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { errText } from './ui.ts';

export type Hint = { key: string; title: string; text: string; productId: string | null; priceKop: number | null; who: 'manager' | 'trainer' };

/** Подсказки для строк списка: один запрос на клуб */
export function useUpsell(rows: { personId: string; clubId: string }[] | undefined) {
  const [m, setM] = useState<Record<string, Hint[]>>({});
  const key = (rows ?? []).map((r) => r.clubId + r.personId).join(',');
  useEffect(() => {
    if (!rows?.length) { setM({}); return; }
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.clubId, [...(by.get(r.clubId) ?? []), r.personId]);
    Promise.all([...by].map(([clubId, personIds]) => api<Record<string, Hint[]>>('POST', '/api/upsell/batch', { clubId, personIds })
      .then((res) => Object.entries(res).map(([pid, h]) => [`${clubId}:${pid}`, h] as const)).catch(() => [])))
      .then((parts) => setM(Object.fromEntries(parts.flat())));
  }, [key]);
  return (clubId: string, personId: string) => m[`${clubId}:${personId}`] ?? [];
}

export function HintLine({ hints }: { hints: Hint[] }) {
  if (!hints.length) return null;
  return <>{hints.map((h) => <div key={h.key} className="small"><span className="chip acc">Допродажа</span> <b>{h.title}.</b> {h.text}</div>)}</>;
}

export function UpsellBlock({ personId, clubId }: { personId: string; clubId: string | null }) {
  const [h, setH] = useState<Hint[]>([]);
  useEffect(() => { if (clubId) api<Hint[]>('GET', `/api/persons/${personId}/upsell?clubId=${clubId}`).then(setH).catch(() => setH([])); }, [personId, clubId]);
  if (!h.length) return null;
  return (
    <div className="card" style={{ display: 'grid', gap: 6 }}>
      <h2>Что предложить</h2>
      {h.map((x) => <div key={x.key} className="item"><b>{x.title}</b> <span className="small muted">· {x.who === 'trainer' ? 'тренеру или менеджеру' : 'менеджеру'}</span><div className="small">{x.text}</div></div>)}
      <p className="small muted" style={{ margin: 0 }}>Подсказки по визитам и покупкам клиента. Цены — из действующего прейскуранта клуба.</p>
    </div>
  );
}

const KEYS: Record<string, string> = { intro_pt: 'Вводная персональная', pt_renew: 'Новый пакет персональных', visits_to_unlimited: 'Безлимит вместо пакета', visits_renew: 'Новый пакет посещений',
  guest_to_member: 'Абонемент вместо разовых', daytime: 'Дневной тариф вместо ухода', longer_term: 'Продлить на дольше' };

export function UpsellList({ clubId, openPerson }: { clubId: string; openPerson: (id: string) => void }) {
  const [who, setWho] = useState('');
  const [key, setKey] = useState('');
  const [d, setD] = useState<{ rows: { personId: string; name: string; hints: Hint[] }[]; byKey: Record<string, number>; total: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setD(null); api<NonNullable<typeof d>>('GET', `/api/upsell?clubId=${clubId}${who ? `&who=${who}` : ''}`).then(setD).catch((x) => setErr(errText(x))); }, [clubId, who]);
  if (!d) return err ? <p className="err">{err}</p> : <p className="muted">Загрузка…</p>;
  const rows = key ? d.rows.filter((r) => r.hints.some((h) => h.key === key)) : d.rows;
  return (
    <>
      <p className="small muted" style={{ margin: 0 }}>Клиенты, которым есть что предложить: по визитам, остаткам пакетов и тарифам клуба. Те же подсказки видны в карточке клиента и в «Плане дня».</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="tabs" role="group"><button aria-pressed={who === ''} onClick={() => setWho('')}>Все</button><button aria-pressed={who === 'manager'} onClick={() => setWho('manager')}>Менеджеру</button><button aria-pressed={who === 'trainer'} onClick={() => setWho('trainer')}>Тренеру</button></div>
        <select value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 'auto' }} aria-label="Повод">
          <option value="">Все поводы ({d.total})</option>{Object.entries(d.byKey).map(([k, n]) => <option key={k} value={k}>{KEYS[k] ?? k} ({n})</option>)}</select>
      </div>
      {rows.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>Сейчас поводов нет.</p></div> : (
        <div className="list">{rows.map((r) => (
          <div key={r.personId} className="item" style={{ display: 'grid', gap: 4 }}>
            <div className="row between"><b>{r.name}</b><button className="btn sm" onClick={() => openPerson(r.personId)}>Карточка</button></div>
            {r.hints.filter((h) => !key || h.key === key).map((h) => <div key={h.key} className="small"><b>{h.title}.</b> {h.text}</div>)}
          </div>))}</div>)}
    </>
  );
}
