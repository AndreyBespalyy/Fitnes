// Разбор недели (ИИ-агент, этап 7): каждый понедельник помощник сравнивает прошлую неделю с позапрошлой,
// находит главные узкие места и пишет, что сделать. Здесь — архив разборов по клубу и сборка заново.
import { useEffect, useState } from 'react';
import { api, navParams, type Club } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { BriefText } from './agent.tsx';

type Item = { id: string; weekStart: string; label: string; engine: string; createdAt: string; deliveredAt: string | null; top: string[] };
type Review = Item & { body: string };

export function WeeklyPage({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const club = clubId !== 'all' ? clubId : clubs[0]?.id ?? '';
  const [items, setItems] = useState<Item[] | null>(null);
  const [sel, setSel] = useState<string | null>(() => navParams('weekly').id ?? null);
  const [rev, setRev] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => club && api<{ items: Item[] }>('GET', `/api/agent/weekly?clubId=${club}`).then((r) => { setItems(r.items); setSel((s) => (s && r.items.some((x) => x.id === s) ? s : r.items[0]?.id ?? null)); }).catch((e) => toast(errText(e)));
  useEffect(() => { setItems(null); setRev(null); void load(); }, [club]);
  useEffect(() => { setRev(null); if (sel) api<Review>('GET', `/api/agent/weekly/${sel}`).then(setRev).catch((e) => toast(errText(e))); }, [sel]);
  const run = async () => {
    setBusy(true);
    try { const r = await api<{ id: string }>('POST', '/api/agent/weekly/run', { clubId: club }); toast('Разбор собран'); setSel(r.id); await load(); if (r.id === sel) setRev(await api<Review>('GET', `/api/agent/weekly/${r.id}`)); }
    catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  if (!club) return <p className="muted">Нет клубов.</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {clubId === 'all' && <p className="small muted" style={{ margin: 0 }}>Показан клуб «{clubs[0]?.name}». Другой клуб выберите вверху.</p>}
      <div className="card row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <b>✦ Разбор недели</b>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Каждый понедельник в 9:00 помощник сравнивает прошлую неделю с позапрошлой: заявки, задачи, переписку, вопросы коллегам, звонки, сделки, занятия и бизнес-процессы. Руководители получают разбор, каждый сотрудник — свои цифры и подсказку.</p>
        </div>
        {items && items.length > 0 && (
          <label className="f" style={{ minWidth: 200 }}>Неделя
            <select value={sel ?? ''} onChange={(e) => setSel(e.target.value)}>{items.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          </label>
        )}
        <button className="btn" disabled={busy} onClick={run}>{busy ? 'Собираю…' : 'Собрать заново'}</button>
      </div>
      {items && !items.length && <div className="card"><p className="muted" style={{ margin: 0 }}>Разборов пока нет. Первый придёт в понедельник утром, а можно собрать сейчас — кнопка «Собрать заново».</p></div>}
      {rev && (
        <div className="card weekly-body">
          <BriefText text={rev.body} />
          <p className="small muted" style={{ margin: '12px 0 0' }}>Собран {dt(rev.createdAt)}{rev.deliveredAt ? `, разослан ${dt(rev.deliveredAt)}` : ''} · {rev.engine === 'yandexgpt' ? 'YandexGPT' : 'по правилам'}</p>
        </div>
      )}
    </div>
  );
}
