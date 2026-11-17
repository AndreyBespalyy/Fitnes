// Рейтинг менеджеров (ИИ-агент, просьба Андрея 17.11.2026): балл 0–100 каждое утро по темпу личного плана, перевыполнению,
// скорости ответа на заявки и сообщения и дисциплине по наблюдениям агента; вывод агента — почему такой балл.
// Видят: сам менеджер (только свой), РОП, управляющий, собственник.
import { useEffect, useState } from 'react';
import { api, type Me } from './api.ts';
import { errText } from './ui.ts';

type Item = { userId: string; name: string; clubName: string; day: string; score: number; note: string;
  parts: { plan: number; over: number; speed: number; discipline: number; script?: number };
  facts: { percent: number | null; pace: number | null; forecastPct: number | null; leadMin: number | null; msgMin: number | null; overdue: number; escalations: number; waiting: number; notDone: number; moved: number; scriptChecks?: number; scriptMisses?: number; scriptAvg?: number | null };
  history: { day: string; score: number }[] };

const PARTS: [keyof Item['parts'], string, number][] = [['plan', 'Темп плана', 35], ['over', 'Перевыполнение', 10], ['speed', 'Скорость ответа', 20], ['discipline', 'Дисциплина', 20], ['script', 'Скрипты', 15]];
const tone = (s: number) => (s >= 75 ? 'good' : s >= 50 ? 'mid' : 'bad');
const dd = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

export const canSeeRating = (me: Me) => me.roles.some((r) => ['manager', 'rop', 'gm', 'owner'].includes(r.code));

export function ManagerRatings({ clubId, mine }: { clubId?: string; mine?: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setItems(null); api<{ items: Item[] }>('GET', `/api/manager-ratings${clubId ? `?clubId=${clubId}` : ''}`).then((r) => setItems(r.items)).catch((e) => setErr(errText(e))); }, [clubId]);
  if (err) return <div className="card"><p className="muted" style={{ margin: 0 }}>{err}</p></div>;
  if (!items) return <div className="card"><p className="muted" style={{ margin: 0 }}>Загрузка…</p></div>;
  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div><b>✦ {mine ? 'Мой рейтинг' : 'Рейтинг менеджеров'}</b>
        <p className="small muted" style={{ margin: '4px 0 0' }}>Каждое утро ИИ-агент ставит балл от 0 до 100: темп личного плана (40), перевыполнение (10), скорость ответа на заявки и сообщения (25), дисциплина — просрочки, эскалации до руководителя, клиенты без ответа (25).</p></div>
      {!items.length && <p className="muted" style={{ margin: 0 }}>Рейтинга пока нет — он появится завтра утром.</p>}
      {items.map((it, i) => {
        const on = open === it.userId || items.length === 1;
        const max = Math.max(100, ...it.history.map((h) => h.score));
        return (
          <div key={`${it.userId}-${it.clubName}`} className={`mr ${tone(it.score)}`}>
            <button type="button" className="mr-head" onClick={() => setOpen(on ? null : it.userId)} aria-expanded={on}>
              {!mine && <span className="mr-place">{i + 1}</span>}
              <span className="mr-name"><b>{it.name}</b><small>{it.clubName} · за {dd(it.day)}{it.facts.pace !== null ? ` · план ${it.facts.percent} %, ${it.facts.pace < 100 ? `отстаёт на ${100 - it.facts.pace} %` : it.facts.pace > 100 ? `опережает на ${it.facts.pace - 100} %` : 'по графику'}` : ' · личный план не задан'}</small></span>
              <span className="mr-score">{it.score}</span>
            </button>
            {on && <div className="mr-body">
              <div className="mr-parts">{PARTS.map(([k, t, w]) => (
                <div key={k} className="mr-part"><span>{t}</span><div className="mr-bar"><i style={{ width: `${((it.parts[k] ?? 0) / w) * 100}%` }} /></div><b>{it.parts[k] ?? '—'} / {w}</b></div>))}</div>
              <p className="mr-note">✦ {it.note}</p>
              <div className="small muted">Ответ на заявку: {it.facts.leadMin ?? '—'} мин · в переписке: {it.facts.msgMin ?? '—'} мин · просрочено: {it.facts.overdue} · эскалаций за неделю: {it.facts.escalations} · клиенты ждали: {it.facts.waiting} · вчера не сделано: {it.facts.notDone}, перенесено: {it.facts.moved}{it.facts.scriptChecks ? ` · разговоры по скрипту: ${it.facts.scriptAvg} %, с ошибками ${it.facts.scriptMisses} из ${it.facts.scriptChecks}` : ''}</div>
              {it.history.length > 1 && <div className="mr-hist" aria-label="Рейтинг по дням">{it.history.map((h) => (
                <span key={h.day} title={`${dd(h.day)}: ${h.score}`}><i className={tone(h.score)} style={{ height: `${Math.max(4, (h.score / max) * 100)}%` }} /><small>{dd(h.day)}</small></span>))}</div>}
            </div>}
          </div>
        );
      })}
    </div>
  );
}
