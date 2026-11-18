// «Чему научился помощник» (17.11.2026, просьба Андрея: «чтобы ИИ-помощник обучался и совершенствовался»).
// Сотрудники оценивают подсказки («Полезно» / «Не то» с причиной), система сама смотрит, чем кончилось
// (сделали, была продажа или проигнорировали). Здесь — что помощник из этого вынес: что показывает чаще, что реже,
// что выключил, на что жалуются, какие ответы берёт за образец. Руководитель может сам сказать «чаще» или «не показывать».
import { useEffect, useState } from 'react';
import { api, type Club } from './api.ts';
import { dt, errText, toast } from './ui.ts';

type Row = { kind: string; name: string; role: string | null; roleName: string; shown: number; likes: number; dislikes: number; done: number; sales: number; ignored: number;
  evaluated: number; usefulPct: number | null; weight: number; status: 'off' | 'auto_off' | 'boost' | 'up' | 'down' | 'normal'; mode: 'auto' | 'boost' | 'off' };
type Report = { days: number; learning: boolean; canEdit: boolean; lessons: string[]; items: Row[];
  summary: { shown: number; likes: number; dislikes: number; done: number; sales: number; ignored: number; evaluated: number; usefulPct: number | null };
  reasons: { reason: string | null; name: string; n: number }[];
  comments: { at: string; user: string; kindName: string; rating: number; reasonName: string | null; comment: string | null; body: string }[];
  examples: { question: string; body: string; at: string; user: string }[] };

const plain = (s: string) => s.replace(/\*\*/g, '');

const STATUS: Record<Row['status'], [string, string]> = {
  up: ['▲ чаще', 'good'], down: ['▼ реже', 'warn'], auto_off: ['выключил сам', 'bad'], off: ['не показывать', 'bad'], boost: ['▲ чаще (решение руководителя)', 'good'], normal: ['как обычно', ''],
};

export function LearnPage({ clubs, clubId }: { clubs: Club[]; clubId: string }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState<Report | null>(null);
  const [role, setRole] = useState('');
  // «Все клубы» вверху: клуб выбирается кнопками на странице (повторная проверка CRM 18.11.2026, п. 15)
  const [sel, setSel] = useState('');
  const club = clubId === 'all' ? sel : clubId;
  const load = () => api<Report>('GET', `/api/agent/learning?days=${days}${club ? `&clubId=${club}` : ''}`).then(setR).catch((e) => toast(errText(e)));
  useEffect(() => { setR(null); void load(); }, [club, days]);
  const setMode = async (x: Row, mode: string) => {
    try { await api('PUT', '/api/agent/learning/rule', { clubId: club, role: x.role, kind: x.kind, mode }); toast('Сохранено'); await load(); }
    catch (e) { toast(errText(e)); }
  };
  const setLearning = async (on: boolean) => {
    try { await api('PUT', '/api/agent/learning/settings', { clubId: club, learning: on }); toast(on ? 'Обучение включено' : 'Обучение выключено'); await load(); }
    catch (e) { toast(errText(e)); }
  };
  if (!clubs.length) return <p className="muted">Нет клубов.</p>;
  const s = r?.summary;
  const roles = r ? [...new Set(r.items.map((x) => x.roleName))].filter((x) => x !== '—') : [];
  const rows = r ? r.items.filter((x) => !role || x.roleName === role) : [];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <b>✦ Чему научился Дядя Витя</b>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Под каждой подсказкой Дяди Вити есть кнопки «Полезно» и «Не то». Дядя Витя ещё и сам смотрит, что сделали после подсказки: закрыли задачу, позвонили, написали клиенту, продали — или проигнорировали. Полезное он показывает чаще, лишнее — реже, совсем бесполезное выключает на месяц, а удачные ответы берёт за образец.</p>
        </div>
        <label className="f" style={{ minWidth: 140 }}>Период
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option></select>
        </label>
        {r?.canEdit && <label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={r.learning} onChange={(e) => void setLearning(e.target.checked)} /> Учиться на отзывах</label>}
      </div>
      {clubId === 'all' && clubs.length > 1 && <div className="tabs" role="group" aria-label="Клуб"><button aria-pressed={!sel} onClick={() => setSel('')}>Все клубы</button>
        {clubs.map((c) => <button key={c.id} aria-pressed={sel === c.id} onClick={() => setSel(c.id)}>{c.name}</button>)}</div>}
      {clubId === 'all' && !sel && <p className="small muted" style={{ margin: 0 }}>Показаны все клубы вместе. Чтобы менять решения по подсказкам, выберите клуб кнопкой выше.</p>}
      {!r && <p className="muted">Загружаю…</p>}
      {r && s && <>
        <div className="wk-tiles">
          <Tile label="Подсказок показано" v={s.shown} />
          <Tile label="Оценено и проверено" v={s.evaluated} note="оценкой или по результату" />
          <Tile label="Польза" v={s.usefulPct == null ? '—' : `${s.usefulPct} %`} note="полезно, сделали или продали" />
          <Tile label="👍 Полезно" v={s.likes} />
          <Tile label="👎 Не то" v={s.dislikes} />
          <Tile label="Сделали по подсказке" v={s.done} />
          <Tile label="Продажи после подсказки" v={s.sales} />
          <Tile label="Проигнорировали" v={s.ignored} />
        </div>
        <div className="card">
          <b>Что Дядя Витя понял</b>
          <ul className="learn-lessons">{r.lessons.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <b>Подсказки по типам</b>
            {roles.length > 1 && <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Роль"><option value="">Все роли</option>{roles.map((x) => <option key={x}>{x}</option>)}</select>}
          </div>
          {!rows.length ? <p className="muted small" style={{ margin: '8px 0 0' }}>Пока подсказок не было. Они появятся с утренними «3 подсказками», карточками в колокольчике и ответами Дяди Вити в чате.</p> : (
            <div className="tbl" style={{ marginTop: 8 }}><table>
              <thead><tr><th>Подсказка</th><th>Кому</th><th className="num">Показано</th><th className="num">👍</th><th className="num">👎</th><th className="num">Сделали</th><th className="num">Продажи</th><th className="num">Игнор</th><th className="num">Польза</th><th>Что делает Дядя Витя</th>{r.canEdit && <th>Решение</th>}</tr></thead>
              <tbody>{rows.map((x) => (
                <tr key={`${x.kind}|${x.role}`}>
                  <td>{x.name}</td><td>{x.roleName}</td><td className="num">{x.shown}</td><td className="num">{x.likes}</td><td className="num">{x.dislikes}</td>
                  <td className="num">{x.done}</td><td className="num">{x.sales}</td><td className="num">{x.ignored}</td>
                  <td className="num">{x.usefulPct == null ? '—' : `${x.usefulPct} %`}</td>
                  <td><span className={`learn-st ${STATUS[x.status][1]}`}>{STATUS[x.status][0]}</span></td>
                  {r.canEdit && <td>{x.role ? <select value={x.mode} aria-label="Решение" onChange={(e) => void setMode(x, e.target.value)}>
                    <option value="auto">Как решит Дядя Витя</option><option value="boost">Показывать чаще</option><option value="off">Не показывать</option></select> : '—'}</td>}
                </tr>))}</tbody>
            </table></div>)}
        </div>
        <div className="learn-cols">
          <div className="card">
            <b>Почему «Не то»</b>
            {!r.reasons.length ? <p className="muted small">Жалоб нет.</p> : <ul className="learn-reasons">{r.reasons.map((x) => <li key={x.reason ?? '-'}><span>{x.name}</span><b>{x.n}</b></li>)}</ul>}
            {r.comments.length > 0 && <>
              <b style={{ display: 'block', marginTop: 12 }}>Что пишут сотрудники</b>
              <ul className="learn-comments">{r.comments.map((c, i) => (
                <li key={i}><div className="small muted">{dt(c.at)} · {c.user} · {c.kindName}{c.reasonName ? ` · ${c.reasonName}` : ''}</div>
                  {c.comment ? <div>«{c.comment}»</div> : <div className="small muted">{plain(c.body)}</div>}</li>))}</ul>
            </>}
          </div>
          <div className="card">
            <b>Образцы удачных ответов</b>
            <p className="small muted" style={{ margin: '4px 0 8px' }}>Ответы, которые сотрудники отметили «Полезно». Нейросеть Дяди Вити получает их как пример, каким должен быть ответ.</p>
            {!r.examples.length ? <p className="muted small">Пока нет — появятся, когда руководители оценят ответы Дяди Вити в чате.</p>
              : <ul className="learn-comments">{r.examples.map((e, i) => <li key={i}><div className="small muted">{dt(e.at)} · {e.user}</div><div><b>Вопрос:</b> {e.question}</div><div className="small">{plain(e.body)}</div></li>)}</ul>}
          </div>
        </div>
      </>}
    </div>
  );
}

function Tile({ label, v, note }: { label: string; v: number | string; note?: string }) {
  return <div className="wk-tile"><div className="wk-l">{label}</div><div className="wk-v">{v}</div>{note && <div className="wk-n">{note}</div>}</div>;
}
