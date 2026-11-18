// «Роли и права» (18.11.2026): встроенные роли и свои роли сети. Свою роль собирают галочками только из тех прав,
// которые есть у самого сотрудника: технический администратор не может создать роль с доступом к клиентам или деньгам.
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { errText, toast } from './ui.ts';

type Perm = { code: string; label: string; sensitive: boolean; available: boolean };
type Role = { code: string; name: string; custom: boolean; networkWide: boolean; description: string | null; users: number; permissions: string[]; canEdit: boolean; canAssign: boolean };
type Catalog = { roles: Role[]; permissions: Perm[] };
type Form = { code: string | null; name: string; description: string; networkWide: boolean; permissions: string[] };

export function RolesPage() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Catalog>('GET', '/api/roles/catalog').then(setCat).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, []);
  if (!cat) return err ? <div className="err">{err}</div> : <p className="muted">Загрузка…</p>;
  const label = (p: string) => cat.permissions.find((x) => x.code === p)?.label ?? p;
  const sensitive = (p: string) => !!cat.permissions.find((x) => x.code === p)?.sensitive;

  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!form) return; setErr('');
    const body = { name: form.name, description: form.description, networkWide: form.networkWide, permissions: form.permissions };
    try {
      if (form.code) await api('PUT', `/api/roles/${form.code}`, body); else await api('POST', '/api/roles', body);
      toast(form.code ? 'Роль сохранена' : 'Роль создана: её можно назначить в «Сотрудниках»'); setForm(null); load();
    } catch (x) { setErr(errText(x)); }
  };
  const remove = async (r: Role) => {
    if (!window.confirm(`Удалить роль «${r.name}»?`)) return;
    setErr('');
    try { await api('DELETE', `/api/roles/${r.code}`); toast('Роль удалена'); load(); } catch (x) { setErr(errText(x)); }
  };
  const copy = (r: Role) => setForm({ code: null, name: `${r.name} (копия)`, description: r.description ?? '', networkWide: r.networkWide,
    permissions: r.permissions.filter((p) => cat.permissions.some((x) => x.code === p && x.available)) });
  const toggle = (p: string) => form && setForm({ ...form, permissions: form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : [...form.permissions, p] });

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div className="row between"><h2>Роли и права</h2>
          {!form && <button className="btn pri sm" onClick={() => setForm({ code: null, name: '', description: '', networkWide: false, permissions: [] })}>+ Своя роль</button>}</div>
        <p className="small" style={{ margin: 0 }}>Своя роль — набор прав для новой должности или рабочего места (например, «Инженер СКУД»). В неё можно включить только те права,
          которые есть у вас. Назначают роль в разделе «Сотрудники».</p>
      </div>
      {err && <div className="err">{err}</div>}

      {form && (
        <form className="card" onSubmit={save} style={{ display: 'grid', gap: 10 }}>
          <h2>{form.code ? 'Изменить роль' : 'Новая роль'}</h2>
          <div className="grid2">
            <label className="f">Название<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Инженер СКУД" /></label>
            <label className="f">Для кого (необязательно)<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Обслуживает турникеты клуба" /></label>
          </div>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={form.networkWide} onChange={(e) => setForm({ ...form, networkWide: e.target.checked })} style={{ width: 'auto' }} />
            На всю сеть (иначе при назначении выбирают клуб)</label>
          <div style={{ display: 'grid', gap: 4, gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
            {cat.permissions.map((p) => (
              <label key={p.code} className="row" style={{ gap: 6, alignItems: 'center', opacity: p.available ? 1 : 0.45 }} title={p.available ? '' : 'Этого права нет у вас — включить его в роль нельзя'}>
                <input type="checkbox" disabled={!p.available} checked={form.permissions.includes(p.code)} onChange={() => toggle(p.code)} style={{ width: 'auto' }} />
                <span>{p.label}{p.sensitive && <span className="small muted"> · клиенты/деньги</span>}</span>
              </label>))}
          </div>
          <div className="row"><button className="btn pri" disabled={!form.name.trim() || !form.permissions.length}>{form.code ? 'Сохранить' : 'Создать роль'}</button>
            <button type="button" className="btn" onClick={() => setForm(null)}>Отмена</button></div>
        </form>
      )}

      <div className="card"><div className="tbl"><table>
        <thead><tr><th>Роль</th><th>Где действует</th><th className="r">Сотрудников</th><th>Права</th><th /></tr></thead>
        <tbody>{cat.roles.map((r) => (
          <tr key={r.code}>
            <td><b>{r.name}</b>{r.custom ? <span className="chip" style={{ marginLeft: 6 }}>своя</span> : null}{r.description && <div className="small muted">{r.description}</div>}</td>
            <td className="small">{r.networkWide ? 'Вся сеть' : 'Один клуб'}</td>
            <td className="r num">{r.users || ''}</td>
            <td className="small">
              {r.permissions.includes('*') ? 'Полный доступ' : (
                <button className="btn sm" type="button" onClick={() => setOpen(open === r.code ? null : r.code)}>{open === r.code ? 'Скрыть' : `${r.permissions.length} прав`}</button>)}
              {open === r.code && <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{r.permissions.map((p) => <li key={p}>{label(p)}{sensitive(p) && <span className="muted"> · клиенты/деньги</span>}</li>)}</ul>}
            </td>
            <td className="r"><span className="row" style={{ justifyContent: 'flex-end' }}>
              {!r.permissions.includes('*') && <button className="btn sm" onClick={() => copy(r)}>Копия</button>}
              {r.canEdit && <button className="btn sm" onClick={() => setForm({ code: r.code, name: r.name, description: r.description ?? '', networkWide: r.networkWide, permissions: r.permissions })}>Изменить</button>}
              {r.canEdit && !r.users && <button className="btn sm" onClick={() => remove(r)}>Удалить</button>}
            </span></td>
          </tr>))}</tbody>
      </table></div>
      <p className="small">«Копия» встроенной роли переносит только те права, которые есть у вас. Роль с доступом к клиентам или деньгам может изменить и назначить только собственник.</p></div>
    </div>
  );
}
