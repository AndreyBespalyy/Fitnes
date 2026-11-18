// Шаг 18, часть 2. Настройки клуба с версиями: правка → черновик → проверка (и на истории) → утверждение → публикация → откат.
// ИИ-помощник понимает просьбу словами и готовит черновик; рабочие настройки меняются только после утверждения человеком.
import { useEffect, useState } from 'react';
import { useClubPick } from './clubPick.tsx';
import { api, type Club, type Me } from './api.ts';
import { errText, toast } from './ui.ts';
import { RulesDiff, RulesEditor, RulesJournal, type Rule } from './rulesEditor.tsx';
import { can, navParams } from './api.ts';
import { Settings as SalesOpsSettings } from './salesOps.tsx';
import { NormsEditor } from './dash.tsx';
import { AgentSettingsCard } from './agent.tsx';
/** Эти разделы правятся во вкладке «Продажи» (сразу, с историей), а не через черновик и утверждение */
const HIDDEN = ['club', 'kpi'];

type Field = { path: string; section: string; label: string; type: 'int' | 'num' | 'bool' | 'text' | 'checklist' | 'money' | 'rules'; min?: number; max?: number; unit?: string; nullable?: boolean; hint?: string };
type Item = { id: string; text: string; weight: number };
type Version = { id: string; number: number; status: string; source: string; title: string; createdAt: string; createdBy: string | null; approvedAt: string | null; approvedBy: string | null;
  publishedAt: string | null; publishedBy: string | null; aiRequest: string | null; checksOk: boolean | null; checkedCurrent: boolean | null };
type Diff = { path: string; label: string; section: string; from: unknown; to: unknown };
type Backtest = { path: string; title: string; summary: string; before?: string; sample?: string[] };
type Checks = { ok: boolean; at: string; items: { code: string; ok: boolean; title: string; details: string[] }[]; history: Backtest[] };
type Cfg = { live: Record<string, unknown>; fields: Field[]; sections: { id: string; title: string }[]; versions: Version[]; presets: { id: string; name: string; description: string }[]; canApprove: boolean; aiServer: boolean };
type VersionFull = Version & { diff: Diff[]; checks: Checks | null; checksCurrent: boolean; approvedCurrent: boolean; differsFromLive: number; canApprove: boolean };

const STATUS: Record<string, [string, string]> = { draft: ['черновик', ''], approved: ['утверждена', 'ok'], published: ['рабочая', 'ok'], superseded: ['была рабочей', ''], rejected: ['отклонена', 'bad'] };
const SOURCE: Record<string, string> = { human: 'вручную', ai: 'Дядя Витя', preset: 'готовый набор', rollback: 'откат', initial: 'исходные' };
const get = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
const dt = (s: string | null) => (s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
function show(f: Field | undefined, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (Array.isArray(v)) return `${v.length} пункт.`;
  if (f?.type === 'money') return `${(Number(v) / 100).toLocaleString('ru-RU')} ₽`;
  return `${v}${f?.unit ? ` ${f.unit}` : ''}`;
}

// Все настройки клуба в одном разделе (повторная проверка CRM 18.11.2026, п. 4): вкладки «Продажи», «Абонементы, сообщения, правила»
// (только здесь — черновик и утверждение: деньги и правила для клиентов), «Другие настройки» и «История изменений» по всем настройкам.
type Page = 'sales' | 'rules' | 'other' | 'history';
export function ConfigPage({ me, clubs, clubId }: { me: Me; clubs: Club[]; clubId: string }) {
  const [club, clubChips] = useClubPick(clubs, clubId);
  const full = can(me, 'config.manage');
  const [page, setPage] = useState<Page>(() => { const v = navParams('config').view as Page; return ['sales', 'rules', 'other', 'history'].includes(v) && (full || v === 'sales' || v === 'history') ? v : full ? 'rules' : 'sales'; });
  if (!club) return <div className="card"><p style={{ margin: 0 }}>Клубов пока нет.</p></div>;
  const tabs: [Page, string, boolean][] = [['rules', 'Абонементы, сообщения, правила', full], ['sales', 'Продажи', true], ['other', 'Другие настройки', full], ['history', 'История изменений', true]];
  const go = (url: string) => window.dispatchEvent(new CustomEvent('crm-go', { detail: url }));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {clubChips}
      <div className="tabs" role="group" aria-label="Настройки клуба" style={{ flexWrap: 'wrap' }}>
        {tabs.filter((t) => t[2]).map(([k, t]) => <button key={k} aria-pressed={page === k} onClick={() => setPage(k)}>{t}</button>)}</div>
      {page === 'rules' && full && <VersionedSettings key={club.id} club={club} />}
      {page === 'sales' && <div style={{ display: 'grid', gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>Правила отдела продаж меняются сразу, каждое изменение — в «Истории изменений». Меняют РОП, управляющий и собственник.</p>
        <SalesOpsSettings key={`s${club.id}`} clubId={club.id} />
        <NormsEditor key={`n${club.id}`} club={club} />
        <AgentSettingsCard key={`a${club.id}`} clubId={club.id} />
        <div className="card row between" style={{ gap: 8, flexWrap: 'wrap' }}><span>Скрипты звонков: этапы, что говорить и что проверяет Дядя Витя.</span>
          <button className="btn sm" onClick={() => go('/?tab=sales&view=scripts')}>Открыть скрипты</button></div>
      </div>}
      {page === 'other' && full && <div className="card" style={{ display: 'grid', gap: 8 }}>
        <p className="small muted" style={{ margin: 0 }}>Настройки, которые живут рядом со своей работой. Каждое изменение тоже попадает в «Историю изменений».</p>
        {OTHER.map(([t, d, url]) => <div key={url} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}><span><b>{t}</b><br /><span className="small muted">{d}</span></span>
          <button className="btn sm" onClick={() => go(url)}>Изменить</button></div>)}
      </div>}
      {page === 'history' && <ChangesHistory key={`h${club.id}`} clubId={club.id} />}
    </div>
  );
}

const OTHER: [string, string, string][] = [
  ['Каналы сообщений', 'Telegram, WhatsApp, бот клиента', '/?tab=messaging'],
  ['Досрочное продление и опросы', 'текст предложения, звонок без мессенджера, опросы после визитов', '/?tab=retention&view=early'],
  ['Бонусная программа', 'баллы, уровни, сгорание', '/?tab=retention&view=referrals'],
  ['Расписание', 'запись, отмена, лист ожидания', '/?tab=schedule'],
  ['Проходы', 'турникеты и правила прохода', '/?tab=access'],
  ['Телефония', 'номера и запись разговоров', '/?tab=telephony'],
];

function ChangesHistory({ clubId }: { clubId: string }) {
  const [rows, setRows] = useState<{ id: string; action: string; title: string; at: string; by: string | null; versionNo: number | null; before: unknown; after: unknown }[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api<NonNullable<typeof rows>>('GET', `/api/config/changes?clubId=${clubId}`).then(setRows).catch((x) => setErr(errText(x))); }, [clubId]);
  if (!rows) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  return (
    <div className="card" style={{ display: 'grid', gap: 6 }}>
      <b>История изменений настроек</b>
      {!rows.length && <p className="muted small" style={{ margin: 0 }}>Изменений пока не было.</p>}
      {rows.map((r) => (
        <div key={r.id} className="item" style={{ display: 'grid', gap: 4, cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? null : r.id)}>
          <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}><span><b>{r.title}</b>{r.versionNo != null ? ` · версия № ${r.versionNo}` : ''}</span>
            <span className="small muted">{r.by ?? 'система'} · {dt(r.at)}</span></div>
          {open === r.id && <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.before ? `Было: ${JSON.stringify(r.before)}\n` : ''}Стало: {JSON.stringify(r.after)}</pre>}
        </div>))}
    </div>
  );
}

function VersionedSettings({ club }: { club: Club }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [sec, setSec] = useState('membership');
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiRes, setAiRes] = useState<{ understood: boolean; unknown: string[]; errors?: string[]; engine: string } | null>(null);
  const [bt, setBt] = useState<Backtest[] | null>(null);
  const load = () => { if (club) api<Cfg>('GET', `/api/config?clubId=${club.id}`).then((r) => { setCfg(r); setErr(''); }).catch((x) => setErr(errText(x))); };
  useEffect(() => { setCfg(null); setOpen(null); setEdits({}); load(); }, [club?.id]);
  if (!cfg) return err ? <div className="err">{err}</div> : null;
  const changes = Object.entries(edits).map(([path, value]) => ({ path, value }));
  const assistant = async () => {
    setBusy(true); setAiRes(null);
    try {
      const r = await api<{ understood: boolean; versionId?: string; unknown: string[]; errors?: string[]; engine: string }>('POST', '/api/config/assistant', { clubId: club.id, text: ask });
      setAiRes(r);
      if (r.understood && r.versionId) { setAsk(''); load(); setOpen(r.versionId); }
    } catch (x) { toast(errText(x)); } finally { setBusy(false); }
  };
  const draft = async (body: object) => {
    try { const r = await api<{ id: string }>('POST', '/api/config/versions', { clubId: club.id, ...body }); setEdits({}); setBt(null); load(); setOpen(r.id); toast('Черновик создан. Рабочие настройки не изменились'); } catch (x) { toast(errText(x)); }
  };
  const backtest = async () => { try { setBt(await api<Backtest[]>('POST', '/api/config/backtest', { clubId: club.id, changes })); } catch (x) { toast(errText(x)); } };
  const fields = cfg.fields.filter((f) => f.section === sec);
  const published = cfg.versions.find((v) => v.status === 'published');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div><b>Настройки {club.name}</b><div className="small muted">Рабочая версия: {published ? `№ ${published.number} от ${dt(published.publishedAt)}, ${published.publishedBy ?? ''}` : 'исходные настройки клуба'}. Любое изменение — через черновик, проверку и утверждение.</div></div>
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <b>Дядя Витя: изменить настройки словами</b>
        <div className="small muted">Опишите словами, что поменять. Дядя Витя подготовит черновик с разницей «было → станет»; рабочие настройки изменятся только после проверки и утверждения руководителем.</div>
        <textarea rows={2} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Например: срок первого ответа 10 минут, норма звонков 50, включи поздравление с днём рождения" />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn pri sm" disabled={busy || ask.trim().length < 3} onClick={assistant}>{busy ? 'Готовлю…' : 'Подготовить черновик'}</button>
          {['Норма звонков 50, жёлтый порог 80 %', 'Заморозка до 45 дней в год, не больше 2 раз', 'Добавь в чек-лист пункт «Предложил пробную тренировку»'].map((x) => <button key={x} className="btn sm" onClick={() => setAsk(x)}>{x}</button>)}
        </div>
        {aiRes && !aiRes.understood && <div className="err">Не понял просьбу: {aiRes.unknown.join('; ')}. Попробуйте назвать настройку, как она подписана ниже.</div>}
        {aiRes?.understood && aiRes.unknown.length > 0 && <div className="small muted">Не разобрал часть просьбы: {aiRes.unknown.join('; ')}</div>}
        {aiRes?.understood && aiRes.errors && aiRes.errors.length > 0 && <div className="small" style={{ color: 'var(--bad)' }}>В черновике есть ошибки, проверка их покажет: {aiRes.errors.join('; ')}</div>}
        {!cfg.aiServer && <div className="small muted">ИИ-сервер ещё не подключён: Дядя Витя понимает типовые фразы о настройках этого экрана. После подключения будет понимать свободный текст.</div>}
      </div>

      {open && <VersionView id={open} fields={cfg.fields} onClose={() => setOpen(null)} onChanged={load} onOpen={setOpen} />}

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <b>Изменить вручную</b>
          <div className="tabs" role="group" aria-label="Раздел настроек" style={{ flexWrap: 'wrap' }}>{cfg.sections.filter((s) => !HIDDEN.includes(s.id)).map((s) => <button key={s.id} aria-pressed={sec === s.id} onClick={() => setSec(s.id)}>{s.title}</button>)}</div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {fields.map((f) => <FieldEdit key={f.path} f={f} live={get(cfg.live, f.path)} value={f.path in edits ? edits[f.path] : get(cfg.live, f.path)} changed={f.path in edits}
            onChange={(v) => setEdits((e) => { const n = { ...e }; if (JSON.stringify(v) === JSON.stringify(get(cfg.live, f.path))) delete n[f.path]; else n[f.path] = v; return n; })} />)}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn pri sm" disabled={!changes.length} onClick={() => draft({ changes, title: `Изменение: ${changes.map((c) => cfg.fields.find((f) => f.path === c.path)?.label).slice(0, 3).join(', ')}` })}>Сохранить как черновик ({changes.length})</button>
          <button className="btn sm" disabled={!changes.length} onClick={backtest}>Проверить на истории</button>
          {changes.length > 0 && <button className="btn sm" onClick={() => { setEdits({}); setBt(null); }}>Сбросить правки</button>}
        </div>
        {bt && <BacktestList items={bt} empty="Для этих изменений проверка на истории не нужна." />}
        {sec === 'rules' && <RulesJournal clubId={club.id} />}
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <b>Готовые наборы под тип клуба</b>
        <div className="small muted">Набор создаёт черновик: перед утверждением видно каждое изменение. «Стандартные значения» возвращают настройки к шаблону платформы.</div>
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          {cfg.presets.map((p) => <div key={p.id} className="card" style={{ display: 'grid', gap: 6, alignContent: 'space-between' }}><div><b>{p.name}</b><div className="small muted">{p.description}</div></div>
            <div><button className="btn sm" onClick={() => draft({ preset: p.id })}>Создать черновик</button></div></div>)}
        </div>
      </div>

      <div className="card">
        <b>Версии настроек</b>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl"><thead><tr><th>№</th><th>Что меняется</th><th>Статус</th><th>Откуда</th><th>Создал</th><th>Опубликована</th></tr></thead>
            <tbody>{cfg.versions.map((v) => (
              <tr key={v.id} style={{ cursor: 'pointer', background: open === v.id ? 'var(--accent-soft)' : undefined }} onClick={() => setOpen(v.id)}>
                <td className="num">{v.number}</td><td>{v.title}</td><td><span className={`chip ${STATUS[v.status]?.[1] ?? ''}`}>{STATUS[v.status]?.[0] ?? v.status}</span></td>
                <td className="small">{SOURCE[v.source] ?? v.source}</td><td className="small">{v.createdBy ?? '—'}<br /><span className="muted">{dt(v.createdAt)}</span></td>
                <td className="small">{v.publishedAt ? <>{dt(v.publishedAt)}<br /><span className="muted">{v.publishedBy}</span></> : '—'}</td>
              </tr>))}
              {!cfg.versions.length && <tr><td colSpan={6} className="muted small">Версий пока нет: настройки клуба исходные.</td></tr>}</tbody></table>
        </div>
      </div>
    </div>
  );
}

function FieldEdit({ f, live, value, changed, onChange }: { f: Field; live: unknown; value: unknown; changed: boolean; onChange: (v: unknown) => void }) {
  const lab = <span>{f.label}{changed && <span className="small muted"> · было {show(f, live)}</span>}</span>;
  if (f.type === 'rules') return <RulesEditor value={(value as Rule[]) ?? []} changed={changed} onChange={onChange} />;
  if (f.type === 'checklist') return <Checklist items={(value as Item[]) ?? []} changed={changed} onChange={onChange} />;
  if (f.type === 'bool') return <label className="row" style={{ gap: 8, fontWeight: changed ? 600 : undefined }}><input type="checkbox" style={{ width: 'auto' }} checked={!!value} onChange={(e) => onChange(e.target.checked)} />{lab}</label>;
  if (f.type === 'text') return <label className="f">{lab}<textarea rows={2} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
  const v = value === null || value === undefined ? '' : f.type === 'money' ? String(Number(value) / 100) : String(value);
  return (
    <label className="f" style={{ maxWidth: 520 }}>{lab}
      <div className="row" style={{ gap: 6 }}>
        <input inputMode="decimal" style={{ maxWidth: 140, fontWeight: changed ? 600 : undefined }} value={v} placeholder={f.nullable ? 'без нормы' : ''}
          onChange={(e) => { const s = e.target.value.replace(',', '.'); if (s === '' && f.nullable) return onChange(null); const n = Number(s); if (s !== '' && Number.isFinite(n)) onChange(f.type === 'money' ? Math.round(n * 100) : n); }} />
        <span className="small muted">{f.type === 'money' ? '₽' : f.unit ?? ''}{f.min !== undefined ? ` (от ${f.min} до ${f.max})` : ''}</span>
      </div>
    </label>
  );
}

function Checklist({ items, changed, onChange }: { items: Item[]; changed: boolean; onChange: (v: Item[]) => void }) {
  const total = items.reduce((a, i) => a + (i.weight || 0), 0);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="small muted">По этим пунктам оценивается разговор менеджера. Вес — сколько пункт значит в итоговой оценке. Звонки оцениваются по версии стандарта, действовавшей в момент звонка; прошлые оценки не пересчитываются.{changed && ' · есть правки'}</div>
      {items.map((it, i) => (
        <div key={it.id} className="row" style={{ gap: 6 }}>
          <span className="small muted" style={{ width: 18 }}>{i + 1}.</span>
          <input value={it.text} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
          <input inputMode="numeric" aria-label="Вес" title="Вес пункта, 1–10" style={{ width: 56 }} value={it.weight} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) || 0 } : x)))} />
          <span className="small muted" style={{ width: 40 }}>{total ? Math.round((it.weight / total) * 100) : 0} %</span>
          <button className="btn sm" aria-label="Убрать пункт" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
        </div>))}
      <div><button className="btn sm" onClick={() => onChange([...items, { id: `n${Date.now().toString(36)}`, text: '', weight: 1 }])}>Добавить пункт</button></div>
    </div>
  );
}

function BacktestList({ items, empty }: { items: Backtest[]; empty: string }) {
  if (!items.length) return <div className="small muted">{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {items.map((b) => (
        <div key={b.path} className="card" style={{ padding: 10 }}>
          <b className="small">Проверка на истории: {b.title}</b>
          <div className="small">{b.summary}</div>
          {b.before && <div className="small muted">{b.before}</div>}
          {b.sample && b.sample.length > 0 && <div className="small muted">Например: {b.sample.join(', ')}</div>}
        </div>))}
    </div>
  );
}

function VersionView({ id, fields, onClose, onChanged, onOpen }: { id: string; fields: Field[]; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const [v, setV] = useState<VersionFull | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<VersionFull>('GET', `/api/config/versions/${id}`).then(setV).catch((x) => toast(errText(x)));
  useEffect(() => { setV(null); load(); }, [id]);
  if (!v) return null;
  const act = async (path: string, ok: string) => {
    setBusy(true);
    try {
      const r = await api<{ versionId?: string; ok?: boolean }>('POST', `/api/config/versions/${v.id}/${path}`);
      toast(ok); onChanged();
      if (r.versionId) onOpen(r.versionId); else load();
    } catch (x) { toast(errText(x)); load(); onChanged(); } finally { setBusy(false); }
  };
  const fieldOf = (p: string) => fields.find((f) => f.path === p);
  const editable = v.status === 'draft' || v.status === 'approved';
  const checksFresh = v.checks && v.checksCurrent;
  return (
    <div className="card" style={{ display: 'grid', gap: 10, borderColor: 'var(--accent)' }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div><b>Версия № {v.number}: {v.title}</b> <span className={`chip ${STATUS[v.status]?.[1] ?? ''}`}>{STATUS[v.status]?.[0]}</span>
          <div className="small muted">{SOURCE[v.source]} · создал {v.createdBy ?? '—'} {dt(v.createdAt)}{v.approvedBy ? ` · утвердил ${v.approvedBy} ${dt(v.approvedAt)}` : ''}{v.publishedBy ? ` · опубликовал ${v.publishedBy} ${dt(v.publishedAt)}` : ''}</div>
          {v.aiRequest && <div className="small">Просьба к ИИ: «{v.aiRequest.trim()}»</div>}
        </div>
        <button className="btn sm" onClick={onClose}>Закрыть</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl"><thead><tr><th>Настройка</th><th>Было</th><th>Станет</th></tr></thead>
          <tbody>{v.diff.map((d) => (
            <tr key={d.path}><td>{d.label}</td><td className="num muted">{fieldOf(d.path)?.type === 'rules' ? <RulesDiff from={null} to={d.from as Rule[]} /> : fieldOf(d.path)?.type === 'checklist' ? <ItemsList items={d.from as Item[]} /> : show(fieldOf(d.path), d.from)}</td>
              <td className="num"><b>{fieldOf(d.path)?.type === 'rules' ? <RulesDiff from={d.from as Rule[]} to={d.to as Rule[]} /> : fieldOf(d.path)?.type === 'checklist' ? <ItemsList items={d.to as Item[]} /> : show(fieldOf(d.path), d.to)}</b></td></tr>))}
            {!v.diff.length && <tr><td colSpan={3} className="small muted">Изменений нет</td></tr>}</tbody></table>
      </div>
      {v.checks && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div className="small"><b>Проверка {dt(v.checks.at)}</b>{!v.checksCurrent && <span style={{ color: 'var(--bad)' }}> — устарела: черновик меняли после неё</span>}</div>
          {v.checks.items.map((i) => (
            <div key={i.code} className="small"><span className={`chip ${i.ok ? 'ok' : 'bad'}`}>{i.ok ? 'да' : 'нет'}</span> {i.title}
              {i.details.length > 0 && i.code !== 'history' && <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{i.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>))}
          {v.checks.history.length > 0 && <BacktestList items={v.checks.history} empty="" />}
        </div>)}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {editable && <button className="btn sm" disabled={busy} onClick={() => act('check', 'Проверка выполнена')}>{v.checks ? 'Проверить ещё раз' : 'Проверить'}</button>}
        {v.status === 'draft' && v.canApprove && <button className="btn sm pri" disabled={busy || !checksFresh || !v.checks?.ok} title={!checksFresh ? 'Сначала проверьте' : ''} onClick={() => act('approve', 'Утверждено')}>Утвердить</button>}
        {v.status === 'approved' && v.canApprove && <button className="btn sm pri" disabled={busy} onClick={() => act('publish', 'Опубликовано: настройки клуба обновлены')}>Опубликовать</button>}
        {editable && <button className="btn sm" disabled={busy} onClick={() => act('reject', 'Черновик отклонён')}>Отклонить</button>}
        {v.status === 'superseded' && v.canApprove && <button className="btn sm" disabled={busy} onClick={() => act('rollback', 'Настройки возвращены к этой версии')}>Вернуть эту версию</button>}
        {v.status === 'draft' && !v.canApprove && <span className="small muted">Утвердить и опубликовать может управляющий клуба или собственник.</span>}
      </div>
    </div>
  );
}

function ItemsList({ items }: { items: Item[] | null }) {
  if (!Array.isArray(items)) return <>—</>;
  return <ol style={{ margin: 0, paddingLeft: 18, textAlign: 'left', fontFamily: 'var(--f)' }}>{items.map((i) => <li key={i.id} className="small">{i.text} <span className="muted">({i.weight})</span></li>)}</ol>;
}
