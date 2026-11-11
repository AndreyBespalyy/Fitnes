// Рабочие столы ролей: у каждой роли свой набор окон, все окна открываются, у плиток есть переходы.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, login } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const USERS: Record<string, { login: string; first: string }> = {
  owner: { login: 'a.bespalyy', first: 'day' }, gm: { login: 'o.smirnov', first: 'club_today' }, rop: { login: 'o.astafeva', first: 'team' },
  manager: { login: 'm.volkova', first: 'my_day' }, desk: { login: 'd.lis', first: 'desk_day' }, fin: { login: 'e.orlova', first: 'fin_day' },
  trainer: { login: 'a.kim', first: 'trainer_day' }, admin: { login: 'i.kotova', first: 'system' },
};
const req = (url: string, who: string) => t.app.inject({ method: 'GET', url, cookies: ck[who] });

before(async () => {
  t = await setupTestApp();
  for (const u of Object.values(USERS)) ck[u.login] = (await login(t.app, u.login)).cookie!;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('у каждой роли свой рабочий стол, и все его окна открываются', async () => {
  for (const [role, u] of Object.entries(USERS)) {
    const l = await req('/api/dash/layout', u.login);
    assert.equal(l.statusCode, 200, `${role}: ${l.body}`);
    const lay = l.json();
    assert.equal(lay.role, role);
    assert.equal(lay.widgets[0], u.first, `${role}: ${lay.widgets.join(',')}`);
    for (const w of lay.widgets) {
      const r = await req(`/api/dash/widget/${w}?clubId=all&month=2026-11&from=2026-11-01&to=2026-11-11`, u.login);
      assert.equal(r.statusCode, 200, `${role}/${w}: ${r.body}`);
      const d = r.json();
      if (d.tiles) {
        assert.ok(d.tiles.length >= 4, `${role}/${w}`);
        for (const x of d.tiles) assert.ok(x.go?.tab, `${role}/${w}: у плитки «${x.label}» нет перехода`);
      }
    }
  }
});

test('чужие окна недоступны: менеджер не видит финансы, тренер — систему', async () => {
  assert.equal((await req('/api/dash/widget/fin_day?clubId=all', 'm.volkova')).statusCode, 403);
  assert.equal((await req('/api/dash/widget/system?clubId=all', 'a.kim')).statusCode, 403);
  assert.equal((await req('/api/dash/widget/system?clubId=all', 'o.smirnov')).statusCode, 403); // сетевое окно — только для сети
});

test('риски ведут в нужные разделы', async () => {
  const d = (await req('/api/dash/widget/risks?clubId=all', 'a.bespalyy')).json();
  assert.ok(d.items.every((i: { go?: { tab: string } }) => i.go?.tab));
});

test('окно «Защита данных» у собственника и управляющего, плитка «Состояние системы» у администратора', async () => {
  const lay = (await req('/api/dash/layout', 'o.smirnov')).json();
  assert.ok(lay.widgets.includes('protection'));
  const p = (await req('/api/dash/widget/protection?clubId=all', 'o.smirnov')).json();
  assert.ok(p.tiles.every((x: { go: { tab: string } }) => x.go.tab === 'privacy'));
  assert.equal((await req('/api/dash/widget/protection?clubId=all', 'm.volkova')).statusCode, 403);
  const s = (await req('/api/dash/widget/system?clubId=all', 'i.kotova')).json();
  assert.ok(s.tiles.some((x: { label: string; go: { tab: string } }) => x.label === 'Состояние системы' && x.go.tab === 'system'));
});
