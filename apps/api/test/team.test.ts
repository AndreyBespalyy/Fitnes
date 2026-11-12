import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { processTeamPush, resetTeamSync } from '../src/modules/team.ts';
import { loadVapid } from '../src/lib/webpush.ts';

const sent: { url: string }[] = [];
const fakeFetch = (async (url: string) => { sent.push({ url }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
let center: string; let north: string;
const req = (method: string, url: string, who: string | null, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: who ? ck[who] : undefined, payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
type Chat = { id: string; kind: string; title: string; unread: number; dept: string | null; clubId: string | null; members: number };
const chats = async (who: string) => (await req('GET', '/api/team/chats', who)).json() as Chat[];
const sub = () => {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/team-${randomBytes(4).toString('hex')}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  resetTeamSync();
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova', 'o.astafeva', 'a.kim', 'd.lis', 'i.zuev', 's.pavlov', 'e.orlova']) ck[l] = (await login(t.app, l)).cookie!;
  for (const r of await sql('select id, login from users')) ids[r.login] = r.id;
  const clubs = (await req('GET', '/api/clubs', 'a.bespalyy')).json() as { id: string; name: string }[];
  center = clubs.find((c) => c.name.includes('Центр'))!.id; north = clubs.find((c) => c.name.includes('Север'))!.id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('общий чат клуба и чаты отделов создаются сами по ролям', async () => {
  const mv = await chats('m.volkova');
  const club = mv.find((c) => c.kind === 'club');
  assert.ok(club && club.title.includes('Центр') && club.title.includes('весь клуб'));
  assert.ok(mv.some((c) => c.kind === 'dept' && c.dept === 'sales'), 'менеджер в отделе продаж');
  assert.ok(!mv.some((c) => c.dept === 'desk' || c.dept === 'trainers'), 'менеджера нет в чатах ресепшна и тренеров');
  assert.ok(!mv.some((c) => c.clubId === north), 'чужой клуб не виден');
  const kim = await chats('a.kim');
  assert.deepEqual(kim.map((c) => c.dept ?? c.kind).sort(), ['club', 'trainers']);
  // Управляющий — во всех отделах своего клуба, собственник — в общих чатах всех клубов
  const gm = await chats('o.smirnov');
  assert.deepEqual(gm.filter((c) => c.kind === 'dept').map((c) => c.dept).sort(), ['desk', 'sales', 'trainers']);
  const owner = await chats('a.bespalyy');
  assert.equal(owner.filter((c) => c.kind === 'club').length, 2);
  assert.equal(owner.filter((c) => c.kind === 'dept').length, 0);
  // Сотрудник ушёл из клуба — пропадает из авточатов
  await sql(`update user_assignments set active_to = current_date - 1 where user_id = $1`, [ids['a.kim']]);
  resetTeamSync();
  assert.equal((await chats('a.kim')).length, 0);
  await sql(`update user_assignments set active_to = null where user_id = $1`, [ids['a.kim']]);
  resetTeamSync();
  assert.equal((await chats('a.kim')).length, 2);
});

test('личный чат: один на пару, сообщения, непрочитанные, прочтение', async () => {
  const people = (await req('GET', '/api/team/people', 'm.volkova')).json() as { id: string; fullName: string }[];
  assert.ok(people.some((p) => p.id === ids['a.kim']));
  assert.ok(people.some((p) => p.id === ids['a.bespalyy']), 'собственник виден всем');
  assert.ok(!people.some((p) => p.id === ids['i.zuev']), 'менеджер чужого клуба не виден');
  assert.equal((await req('POST', '/api/team/direct', 'm.volkova', { userId: ids['i.zuev'] })).statusCode, 404);
  const a = (await req('POST', '/api/team/direct', 'm.volkova', { userId: ids['a.kim'] })).json();
  const b = (await req('POST', '/api/team/direct', 'a.kim', { userId: ids['m.volkova'] })).json();
  assert.equal(a.id, b.id);
  // Пустой личный чат собеседник не видит
  assert.ok(!(await chats('a.kim')).some((c) => c.id === a.id));
  const m = (await req('POST', `/api/team/chats/${a.id}/messages`, 'm.volkova', { body: 'Артём, клиентка Иванова придёт в 18:00' })).json();
  assert.equal(m.author, 'Мария Волкова');
  const kim = (await chats('a.kim')).find((c) => c.id === a.id)!;
  assert.equal(kim.title, 'Мария Волкова'); assert.equal(kim.unread, 1);
  const reply = (await req('POST', `/api/team/chats/${a.id}/messages`, 'a.kim', { body: 'Принял', replyTo: m.id })).json();
  assert.equal(reply.replyBody, 'Артём, клиентка Иванова придёт в 18:00');
  assert.equal((await chats('a.kim')).find((c) => c.id === a.id)!.unread, 0, 'ответил — значит прочитал');
  const list = (await req('GET', `/api/team/chats/${a.id}/messages`, 'm.volkova')).json();
  assert.equal(list.messages.length, 2);
  assert.ok(new Date(list.reads.find((r: { userId: string }) => r.userId === ids['a.kim']).lastReadAt) >= new Date(m.createdAt));
  // Обновление открытого чата: изменения после отметки
  const since = list.cursor;
  await req('PATCH', `/api/team/messages/${m.id}`, 'm.volkova', { body: 'Артём, клиентка Иванова придёт в 18:30' });
  const upd = (await req('GET', `/api/team/chats/${a.id}/messages?since=${encodeURIComponent(since)}`, 'a.kim')).json();
  assert.ok(upd.messages.some((x: { id: string; body: string; editedAt: string }) => x.id === m.id && x.body.includes('18:30') && x.editedAt));
  assert.equal((await req('PATCH', `/api/team/messages/${m.id}`, 'a.kim', { body: 'взлом' })).statusCode, 403);
  assert.equal((await req('DELETE', `/api/team/messages/${m.id}`, 'a.kim')).statusCode, 403);
  assert.equal((await req('DELETE', `/api/team/messages/${m.id}`, 'm.volkova')).statusCode, 200);
  const after = (await req('GET', `/api/team/chats/${a.id}/messages`, 'a.kim')).json();
  const del = after.messages.find((x: { id: string }) => x.id === m.id);
  assert.equal(del.deleted, true); assert.equal(del.body, '');
  // Чужой не читает
  assert.equal((await req('GET', `/api/team/chats/${a.id}/messages`, 'd.lis')).statusCode, 404);
  assert.equal((await req('POST', `/api/team/chats/${a.id}/messages`, 'd.lis', { body: 'x' })).statusCode, 404);
});

test('группа: создание, участники, выход, руководитель', async () => {
  assert.equal((await req('POST', '/api/team/groups', 'o.smirnov', { title: 'Акция на ноябрь', memberIds: [ids['i.zuev']] })).statusCode, 400, 'сотрудник чужого клуба');
  const g = (await req('POST', '/api/team/groups', 'o.smirnov', { title: 'Акция на ноябрь', memberIds: [ids['m.volkova'], ids['d.lis']] })).json();
  const info = (await req('GET', `/api/team/chats/${g.id}`, 'o.smirnov')).json();
  assert.equal(info.members.length, 3); assert.equal(info.canManage, true);
  assert.equal((await req('GET', `/api/team/chats/${g.id}`, 'd.lis')).json().canManage, false);
  assert.equal((await req('POST', `/api/team/chats/${g.id}/members`, 'd.lis', { userIds: [ids['a.kim']] })).statusCode, 403);
  assert.equal((await req('POST', `/api/team/chats/${g.id}/members`, 'o.smirnov', { userIds: [ids['a.kim']] })).json().added, 1);
  assert.equal((await req('PATCH', `/api/team/chats/${g.id}`, 'o.smirnov', { title: 'Акция «Чёрная пятница»' })).statusCode, 200);
  assert.equal((await req('DELETE', `/api/team/chats/${g.id}/members/${ids['d.lis']}`, 'd.lis')).statusCode, 200);
  const msgs = (await req('GET', `/api/team/chats/${g.id}/messages`, 'o.smirnov')).json().messages as { userId: string | null; body: string }[];
  assert.ok(msgs.every((x) => x.userId === null), 'служебные сообщения');
  assert.ok(msgs.some((x) => x.body.includes('вышел(а)')) && msgs.some((x) => x.body.includes('Чёрная пятница')));
  assert.equal((await req('GET', `/api/team/chats/${g.id}`, 'd.lis')).statusCode, 404);
  // Из общего чата клуба выйти нельзя, можно заглушить
  const club = (await chats('m.volkova')).find((c) => c.kind === 'club')!;
  assert.equal((await req('DELETE', `/api/team/chats/${club.id}/members/${ids['m.volkova']}`, 'm.volkova')).statusCode, 400);
  assert.equal((await req('PUT', `/api/team/chats/${club.id}/mute`, 'm.volkova', { muted: true })).json().muted, true);
  // Канал, где пишут только руководители
  await req('PATCH', `/api/team/chats/${g.id}`, 'o.smirnov', { onlyAdminsPost: true });
  assert.equal((await req('POST', `/api/team/chats/${g.id}/messages`, 'm.volkova', { body: 'можно?' })).statusCode, 403);
  assert.equal((await req('POST', `/api/team/chats/${g.id}/messages`, 'o.smirnov', { body: 'Старт в пятницу' })).statusCode, 200);
});

test('объявление: только руководитель, видно кто прочитал, push даже в заглушённом чате', async () => {
  const club = (await chats('o.smirnov')).find((c) => c.kind === 'club' && c.clubId === center)!;
  assert.equal((await req('POST', `/api/team/chats/${club.id}/messages`, 'm.volkova', { body: 'Всем!', important: true })).statusCode, 403);
  const s = sub();
  assert.equal((await req('POST', '/api/team/push/subscribe', 'm.volkova', s)).statusCode, 200);
  assert.equal((await req('POST', '/api/team/push/subscribe', 'm.volkova', { ...s, endpoint: 'https://evil.example.com/x' })).statusCode, 400);
  const ann = (await req('POST', `/api/team/chats/${club.id}/messages`, 'o.smirnov', { body: 'Завтра санитарный день, клуб закрыт до 12:00', important: true })).json();
  assert.equal(ann.important, true);
  await sql(`update team_messages set created_at = now() - interval '10 seconds' where id = $1`, [ann.id]);
  await sql(`update team_members set last_read_at = now() - interval '1 minute' where chat_id = $1 and user_id <> $2`, [club.id, ids['o.smirnov']]);
  sent.length = 0;
  const n = await processTeamPush(t.pool, await loadVapid(t.pool), fakeFetch);
  assert.ok(n >= 1);
  assert.ok(sent.some((x) => x.url === s.endpoint), 'Мария заглушила чат, но объявление пришло');
  // Второй прогон не дублирует
  sent.length = 0;
  await processTeamPush(t.pool, await loadVapid(t.pool), fakeFetch);
  assert.ok(!sent.some((x) => x.url === s.endpoint));
  await req('POST', `/api/team/chats/${club.id}/read`, 'm.volkova');
  const r = (await req('GET', `/api/team/messages/${ann.id}/readers`, 'o.smirnov')).json() as { read: { id: string }[]; unread: { id: string }[] };
  assert.ok(r.read.some((x) => x.id === ids['m.volkova']));
  assert.ok(r.unread.some((x) => x.id === ids['a.kim']));
  // Обычное сообщение в заглушённый чат push не присылает
  const plain = (await req('POST', `/api/team/chats/${club.id}/messages`, 'o.smirnov', { body: 'Кофемашина починена' })).json();
  await sql(`update team_messages set created_at = now() - interval '10 seconds' where id = $1`, [plain.id]);
  await sql(`update team_members set last_read_at = now() - interval '1 minute' where chat_id = $1 and user_id <> $2`, [club.id, ids['o.smirnov']]);
  sent.length = 0;
  await processTeamPush(t.pool, await loadVapid(t.pool), fakeFetch);
  assert.ok(!sent.some((x) => x.url === s.endpoint));
});

test('фото и документы: проверка типа, доступ только участникам', async () => {
  const d = (await req('POST', '/api/team/direct', 'o.smirnov', { userId: ids['e.orlova'] })).json();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const m = (await req('POST', `/api/team/chats/${d.id}/messages`, 'o.smirnov', { body: '', file: { fileName: 'чек.png', dataBase64: png.toString('base64') } })).json();
  assert.equal(m.file.mime, 'image/png');
  const f = await req('GET', `/api/team/files/${m.file.id}`, 'e.orlova');
  assert.equal(f.statusCode, 200); assert.equal(f.headers['content-type'], 'image/png');
  assert.equal((await req('GET', `/api/team/files/${m.file.id}`, 'm.volkova')).statusCode, 404);
  const bad = await req('POST', `/api/team/chats/${d.id}/messages`, 'o.smirnov', { file: { fileName: 'x.exe', dataBase64: Buffer.from('MZ\x90\x00').toString('base64') } });
  assert.equal(bad.statusCode, 400);
});

test('приглашения: управляющий своего клуба, страница установки без входа', async () => {
  assert.equal((await req('GET', `/api/team/invites?clubId=${center}`, 'm.volkova')).statusCode, 403);
  assert.equal((await req('GET', `/api/team/invites?clubId=${north}`, 'o.smirnov')).statusCode, 403);
  const list = (await req('GET', `/api/team/invites?clubId=${center}`, 'o.smirnov')).json();
  assert.ok(list.people.some((p: { id: string }) => p.id === ids['a.kim']));
  assert.ok(list.appLink.endsWith('/team/'));
  assert.equal((await req('POST', '/api/team/invites', 'o.smirnov', { clubId: center, userIds: [ids['i.zuev']] })).statusCode, 400);
  const [inv] = (await req('POST', '/api/team/invites', 'o.smirnov', { clubId: center, userIds: [ids['a.kim']] })).json();
  assert.match(inv.link, /\/m\/[\w-]{12}$/);
  assert.match(inv.text, /a\.kim/); assert.match(inv.text, /iPhone и Android/);
  const token = inv.link.split('/m/')[1];
  const r = await t.app.inject({ method: 'GET', url: `/m/${token}` });
  assert.equal(r.statusCode, 302); assert.equal(r.headers.location, `/team/?i=${token}`);
  const page = (await req('GET', `/api/team/invite/${token}`, null)).json();
  assert.equal(page.fullName, 'Артём Ким'); assert.equal(page.login, 'a.kim'); assert.equal(page.inviter, 'Олег Смирнов');
  assert.equal((await req('GET', '/api/team/invite/nope', null)).statusCode, 404);
  const after = (await req('GET', `/api/team/invites?clubId=${center}`, 'o.smirnov')).json();
  const kim = after.people.find((p: { id: string }) => p.id === ids['a.kim']);
  assert.equal(kim.openCount, 1); assert.equal(kim.link, inv.link);
  // Новая ссылка отменяет старую
  await req('POST', '/api/team/invites', 'o.smirnov', { clubId: center, userIds: [ids['a.kim']] });
  assert.equal((await req('GET', `/api/team/invite/${token}`, null)).statusCode, 404);
  // Общая ссылка клуба и отметка об установке
  const [gen] = (await req('POST', '/api/team/invites', 'o.smirnov', { clubId: center })).json();
  assert.equal(gen.userId, null);
  assert.equal((await req('GET', `/api/team/invite/${gen.link.split('/m/')[1]}`, null)).json().clubName, 'Клуб «Центр»');
  await req('POST', '/api/team/installed', 'a.kim', { platform: 'ios' });
  const fin = (await req('GET', `/api/team/invites?clubId=${center}`, 'o.smirnov')).json();
  assert.equal(fin.people.find((p: { id: string }) => p.id === ids['a.kim']).appPlatform, 'ios');
  assert.ok(fin.general);
});

test('непрочитанные для значка в шапке', async () => {
  const before = (await req('GET', '/api/team/unread', 'a.kim')).json().count;
  const d = (await req('POST', '/api/team/direct', 'o.smirnov', { userId: ids['a.kim'] })).json();
  await req('POST', `/api/team/chats/${d.id}/messages`, 'o.smirnov', { body: 'Зайди ко мне' });
  assert.equal((await req('GET', '/api/team/unread', 'a.kim')).json().count, before + 1);
  assert.equal((await req('GET', '/api/team/unread', null)).statusCode, 401);
});
