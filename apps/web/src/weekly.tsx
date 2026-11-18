// Разбор недели (ИИ-агент, этап 7): каждый понедельник помощник сравнивает прошлую неделю с позапрошлой,
// находит главные узкие места и пишет, что сделать. Здесь — архив разборов по клубу и сборка заново.
import { useEffect, useState } from 'react';
import { useClubPick } from './clubPick.tsx';
import { api, navParams, type Club } from './api.ts';
import { dt, errText, toast } from './ui.ts';
import { BriefText } from './agent.tsx';

type Item = { id: string; weekStart: string; label: string; engine: string; createdAt: string; deliveredAt: string | null; top: string[] };
type M = {
  salesKop: number; leads: { total: number; noAnswer: number; late: number; reassigned: number; median: number | null };
  tasks: { total: number; late: number; escalations: number }; waits: { over: number }; questions: { total: number; slow: number };
  calls: { missed: number; noCallback: number }; deals: { stuck: number; slowStage: { name: string; days: number } | null };
  classes: { sessions: number; cap: number; booked: number; came: number; noShow: number; cancelled: number };
  processes: { started: number; done: number; late: number };
};
type Bn = { key: string; title: string; fact: string; todo: string };
type Review = Item & { body: string; data?: { metrics?: M; prev?: M; bottlenecks?: Bn[]; tips?: Record<string, string> } | null };

const ROLE_T: Record<string, string> = { manager: 'Менеджеры', rop: 'РОП', desk: 'Администраторы', trainer: 'Тренеры', gm: 'Управляющий' };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const rubK = (kop: number) => `${Math.round(kop / 100).toLocaleString('ru-RU')} ₽`;

/** Плитка «цифра недели» со сравнением с прошлой неделей: зелёный — стало лучше, красный — хуже */
function Tile({ label, cur, prev, fmt = String, lowerBetter = false, note }: { label: string; cur: number | null; prev: number | null; fmt?: (n: number) => string; lowerBetter?: boolean; note?: string }) {
  const d = cur != null && prev != null ? cur - prev : 0;
  const good = d === 0 ? null : lowerBetter ? d < 0 : d > 0;
  return (
    <div className={`wk-tile${good === false ? ' bad' : good ? ' good' : ''}`}>
      <div className="wk-l">{label}</div>
      <div className="wk-v">{cur == null ? '—' : fmt(cur)}</div>
      <div className="wk-d">{prev == null || cur == null ? '' : d === 0 ? 'как неделей раньше' : <>{d > 0 ? '▲' : '▼'} неделей раньше {fmt(prev)}</>}</div>
      {note && <div className="wk-n">{note}</div>}
    </div>
  );
}

/** Наглядный разбор: главное, узкие места карточками, цифры плитками, подсказки по ролям */
function WeeklyVisual({ rev }: { rev: Review }) {
  const m = rev.data?.metrics, p = rev.data?.prev, bn = rev.data?.bottlenecks ?? [], tips = rev.data?.tips ?? {};
  if (!m || !p) return <BriefText text={rev.body} />;
  const lines = rev.body.split('\n');
  const end = lines.findIndex((l) => l.startsWith('**Главные узкие места'));
  const intro = lines.slice(1, end > 0 ? end : 3).join('\n').trim();
  return (
    <div className="wk">
      <h2 className="wk-h">{lines[0].replace(/\*\*/g, '')}</h2>
      {intro && <div className="wk-intro"><BriefText text={intro} /></div>}
      <div className="wk-sec">Главные узкие места</div>
      {bn.length ? <div className="wk-bns">{bn.slice(0, 3).map((b, i) => (
        <div key={b.key} className="wk-bn"><span className="wk-num">{i + 1}</span>
          <div><b>{b.title}</b><div className="small">{b.fact}</div><div className="wk-todo"><span>Что сделать</span>{b.todo}</div></div></div>))}</div>
        : <p className="small muted">Явных узких мест нет — показатели в норме.</p>}
      {bn.length > 3 && <p className="small muted">Ещё стоит посмотреть: {bn.slice(3).map((b) => b.title.toLowerCase()).join('; ')}.</p>}
      <div className="wk-sec">Цифры недели</div>
      <div className="wk-tiles">
        <Tile label="Продажи" cur={m.salesKop} prev={p.salesKop} fmt={rubK} />
        <Tile label="Заявки" cur={m.leads.total} prev={p.leads.total} note={`без ответа ${m.leads.noAnswer}, позже нормы ${m.leads.late}`} />
        <Tile label="Ответ на заявку, мин" cur={m.leads.median} prev={p.leads.median} lowerBetter />
        <Tile label="Задачи с опозданием, %" cur={pct(m.tasks.late, m.tasks.total)} prev={pct(p.tasks.late, p.tasks.total)} lowerBetter note={`${m.tasks.late} из ${m.tasks.total}`} />
        <Tile label="Клиент ждал ответа" cur={m.waits.over} prev={p.waits.over} lowerBetter />
        <Tile label="Не перезвонили" cur={m.calls.noCallback} prev={p.calls.noCallback} lowerBetter note={`пропущено ${m.calls.missed}`} />
        <Tile label="Сделки без движения 7+ дн." cur={m.deals.stuck} prev={p.deals.stuck} lowerBetter note={m.deals.slowStage ? `дольше всего — «${m.deals.slowStage.name}»` : undefined} />
        <Tile label="Заполняемость занятий, %" cur={pct(m.classes.booked, m.classes.cap)} prev={pct(p.classes.booked, p.classes.cap)} note={`занятий ${m.classes.sessions}`} />
        <Tile label="Неявки, %" cur={pct(m.classes.noShow, m.classes.came + m.classes.noShow)} prev={pct(p.classes.noShow, p.classes.came + p.classes.noShow)} lowerBetter />
        <Tile label="Вопросы коллегам без ответа" cur={m.questions.slow} prev={p.questions.slow} lowerBetter note={`всего вопросов ${m.questions.total}`} />
        <Tile label="Процессы вышли за срок" cur={m.processes.late} prev={p.processes.late} lowerBetter note={`запущено ${m.processes.started}, завершено ${m.processes.done}`} />
      </div>
      {Object.keys(tips).length > 0 && (<>
        <div className="wk-sec">Что делать каждой роли</div>
        <div className="wk-tips">{Object.entries(tips).map(([r, t]) => <div key={r} className="wk-tip"><b>{ROLE_T[r] ?? r}</b><div className="small">{t}</div></div>)}</div>
      </>)}
    </div>
  );
}

export function WeeklyPage({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const [clubObj, clubChips] = useClubPick(clubs, clubId);
  const club = clubObj?.id ?? '';
  const [items, setItems] = useState<Item[] | null>(null);
  const [sel, setSel] = useState<string | null>(() => navParams('weekly').id ?? null);
  const [rev, setRev] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'visual' | 'text'>('visual');
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
      {clubChips}
      <div className="card row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <b>✦ Разбор недели</b>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Каждый понедельник в 9:00 Дядя Витя сравнивает прошлую неделю с позапрошлой: заявки, задачи, переписку, вопросы коллегам, звонки, сделки, занятия и бизнес-процессы. Руководители получают разбор, каждый сотрудник — свои цифры и подсказку.</p>
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
          <div className="tabs" role="group" aria-label="Вид" style={{ marginBottom: 10 }}>
            <button aria-pressed={view === 'visual'} onClick={() => setView('visual')}>Наглядно</button>
            <button aria-pressed={view === 'text'} onClick={() => setView('text')}>Текстом</button></div>
          {view === 'visual' ? <WeeklyVisual rev={rev} /> : <BriefText text={rev.body} />}
          <p className="small muted" style={{ margin: '12px 0 0' }}>Собран {dt(rev.createdAt)}{rev.deliveredAt ? `, разослан ${dt(rev.deliveredAt)}` : ''} · {rev.engine === 'yandexgpt' ? 'YandexGPT' : 'по правилам'}</p>
        </div>
      )}
    </div>
  );
}
