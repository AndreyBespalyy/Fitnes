// Приём заявок: форма сайта (CORS, робот, лимит, ошибки), Tilda (проверка и поля), VK (подтверждение, ключ, форма), Авито (сообщения, подключение).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestApp, login } from './helpers.ts';
import { mapFields } from '../src/modules/leadIntake.ts';

const calls: { url: string; body?: string }[] = [];
const fakeFetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body as string | undefined });
  if (String(url).endsWith('/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
  if (String(url).includes('/accounts/self')) return new Response(JSON.stringify({ id: 555 }), { status: 200 });
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupTestApp>>;
const ck: Record<string, Record<string, string>> = {};
const req = (method: string, url: string, who: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, cookies: ck[who], payload: payload as object });
const sql = async (q: string, p: unknown[] = []) => { const c = new pg.Client(t.ownerUrl); await c.connect(); try { return (await c.query(q, p)).rows; } finally { await c.end(); } };
const pub = (url: string, payload: unknown, form = false, ip = '198.51.100.9') => t.app.inject({ method: 'POST', url: new URL(url).pathname, remoteAddress: ip,
  ...(form ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload as Record<string, string>).toString() } : { payload: payload as object }) });
let centr = '';

before(async () => {
  t = await setupTestApp({ fetch: fakeFetch });
  for (const l of ['a.bespalyy', 'o.smirnov', 'm.volkova']) ck[l] = (await login(t.app, l)).cookie!;
  centr = (await req('GET', '/api/clubs', 'a.bespalyy')).json().find((c: { name: string }) => c.name.includes('Центр')).id;
});
after(async () => { await t.app.close(); await t.pool.end(); });

test('поля формы распознаются по смыслу', () => {
  const f = mapFields({ Name: 'Анна', Phone: '+7 (916) 111-22-33', Email: 'a@b.ru', Textarea: 'Хочу пробную', 'Удобное время': 'вечер', tranid: '123:45', formid: 'form1', utm_source: 'yandex' });
  assert.deepEqual([f.name, f.phone, f.email, f.externalId, f.utm?.utm_source], ['Анна', '+7 (916) 111-22-33', 'a@b.ru', '123:45', 'yandex']);
  assert.equal(f.comment, 'Хочу пробную\nУдобное время: вечер');
});

test('форма на сайте и Tilda', async () => {
  // Менеджер не настраивает подключения
  assert.equal((await req('POST', '/api/intake', 'm.volkova', { clubId: centr, kind: 'site' })).statusCode, 403);
  const site = (await req('POST', '/api/intake', 'o.smirnov', { clubId: centr, kind: 'site' })).json();
  assert.match(site.url, /\/api\/public\/v1\/intake\/li_/);
  assert.equal(site.intake.sourceName, 'Сайт');

  // Предварительный запрос браузера с чужого сайта
  const opt = await t.app.inject({ method: 'OPTIONS', url: new URL(site.url).pathname });
  assert.equal(opt.headers['access-control-allow-origin'], '*');

  let r = await pub(site.url, { name: 'Ирина Сайтова', phone: '+7 916 555-01-01', comment: 'Хочу в бассейн' }, true);
  assert.equal(r.statusCode, 201);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  const lead = (await sql(`select l.comment, s.code, p.full_name, t.kind from leads l join lead_sources s on s.id = l.source_id join persons p on p.id = l.person_id
    join tasks t on t.lead_id = l.id where p.full_name = 'Ирина Сайтова'`))[0];
  assert.deepEqual([lead.code, lead.kind], ['site', 'first_response']);
  assert.match(lead.comment, /Заявка: Форма на сайте\nХочу в бассейн/);

  // Ошибка в телефоне — понятный ответ форме и запись в журнале
  r = await pub(site.url, { name: 'Х', phone: '123' }, true);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /Телефон указан неверно/);
  // Робот заполнил скрытое поле — вежливо «принято», лид не создан
  r = await pub(site.url, { name: 'Бот', phone: '+7 916 555-01-02', website: 'http://spam' }, true);
  assert.equal(r.statusCode, 200);
  assert.equal((await sql(`select count(*)::int as n from persons where full_name = 'Бот'`))[0].n, 0);
  // Проверочная заявка
  r = await pub(site.url, { name: 'Проверка', phone: '+7 916 555-01-03', test: 'true' }, true);
  assert.equal(r.json().test, true);

  // Лимит: больше 10 заявок за 10 минут с одного адреса
  for (let i = 0; i < 8; i++) await pub(site.url, { name: `Поток ${i}`, phone: `+7 916 555-02-${String(i).padStart(2, '0')}` }, true, '203.0.113.50');
  r = await pub(site.url, { name: 'Поток 9', phone: '+7 916 555-02-09' }, true, '203.0.113.50');
  r = await pub(site.url, { name: 'Поток 10', phone: '+7 916 555-02-10' }, true, '203.0.113.50');
  r = await pub(site.url, { name: 'Поток 11', phone: '+7 916 555-02-11' }, true, '203.0.113.50');
  assert.equal(r.statusCode, 429);

  // Tilda: проверочный запрос при подключении и обычная заявка; повтор той же заявки — дубль
  const tilda = (await req('POST', '/api/intake', 'o.smirnov', { clubId: centr, kind: 'tilda' })).json();
  r = await pub(tilda.url, { test: 'test' }, true);
  assert.equal(r.body, 'ok');
  const form = { Name: 'Олег Тильдин', Phone: '+7 (916) 555-03-03', tranid: '9999:1', utm_source: 'vk', utm_campaign: 'autumn' };
  assert.equal((await pub(tilda.url, form, true)).body, 'ok');
  assert.equal((await pub(tilda.url, form, true)).body, 'ok');
  const tl = await sql(`select l.campaign, l.utm from leads l join persons p on p.id = l.person_id where p.full_name = 'Олег Тильдин'`);
  assert.equal(tl.length, 1, 'повтор Tilda не создал второй лид');
  assert.equal(tl[0].campaign, 'autumn');

  const g = (await req('GET', `/api/intake?clubId=${centr}`, 'o.smirnov')).json();
  const st = g.list.find((x: { kind: string }) => x.kind === 'site');
  assert.ok(st.leads >= 9 && st.errors === 1);
  const statuses = new Set(g.log.map((x: { status: string }) => x.status));
  for (const s of ['lead', 'error', 'skipped', 'test', 'limited', 'duplicate']) assert.ok(statuses.has(s), s);

  // Выключенное подключение и старая ссылка после перевыпуска не принимают заявки
  const nu = (await req('POST', `/api/intake/${st.id}/token`, 'o.smirnov')).json();
  assert.equal((await pub(site.url, { name: 'Старая', phone: '+7 916 555-04-04' }, true, '192.0.2.1')).statusCode, 404);
  assert.equal((await pub(nu.url, { name: 'Новая', phone: '+7 916 555-04-05' }, true, '192.0.2.1')).statusCode, 201);
  await req('PUT', `/api/intake/${st.id}`, 'o.smirnov', { isActive: false });
  assert.equal((await pub(nu.url, { name: 'Выкл', phone: '+7 916 555-04-06' }, true, '192.0.2.1')).statusCode, 404);
});

test('VK: подтверждение адреса, секретный ключ, форма сбора заявок', async () => {
  const vk = (await req('POST', '/api/intake', 'o.smirnov', { clubId: centr, kind: 'vk', settings: { confirmation: 'a1b2c3d4', groupId: '123', secret: 'sekret-vk' } })).json();
  assert.equal(vk.intake.sourceName, 'ВКонтакте');
  assert.equal(vk.intake.settings.hasSecret, true);
  assert.equal(JSON.stringify(vk).includes('sekret-vk'), false, 'секрет не возвращается');
  assert.equal((await pub(vk.url, { type: 'confirmation', group_id: 123, secret: 'sekret-vk' })).body, 'a1b2c3d4');
  // Чужой запрос без ключа: «ok», но лид не создан, в журнале ошибка
  const ev = { type: 'lead_forms_new', group_id: 123, object: { lead_id: 77, user_id: 9001, form_name: 'Пробная тренировка',
    answers: [{ key: 'first_name', answer: 'Вера' }, { key: 'last_name', answer: 'Вконтактова' }, { key: 'phone_number', answer: '+79165550505' }, { key: 'custom_0', question: 'Цель', answer: 'похудеть' }] } };
  assert.equal((await pub(vk.url, { ...ev, secret: 'wrong' })).body, 'ok');
  assert.equal((await sql(`select count(*)::int as n from persons where full_name = 'Вера Вконтактова'`))[0].n, 0);
  assert.equal((await pub(vk.url, { ...ev, secret: 'sekret-vk' })).body, 'ok');
  const p = (await sql(`select p.id, l.comment, s.code from persons p join leads l on l.person_id = p.id join lead_sources s on s.id = l.source_id where p.full_name = 'Вера Вконтактова'`))[0];
  assert.equal(p.code, 'vk');
  assert.match(p.comment, /Форма VK «Пробная тренировка»\nЦель: похудеть/);
  const contacts = (await sql(`select type, normalized_value from person_contacts where person_id = $1 order by type`, [p.id])).map((c) => `${c.type}:${c.normalized_value}`);
  assert.deepEqual(contacts, ['phone:+79165550505', 'vk:vk:9001']);
  // Другие события VK пропускаются
  assert.equal((await pub(vk.url, { type: 'wall_post_new', secret: 'sekret-vk' })).body, 'ok');
});

test('Авито: подключение по Client ID и сообщения в заявки, одна заявка на переписку в день', async () => {
  const av = (await req('POST', '/api/intake', 'o.smirnov', { clubId: centr, kind: 'avito', settings: { clientId: 'cid', clientSecret: 'csecret' } })).json();
  let r = await req('POST', `/api/intake/${av.intake.id}/avito/connect`, 'o.smirnov', { url: av.url });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().avitoUserId, 555);
  assert.ok(calls.some((c) => c.url.endsWith('/messenger/v3/webhook') && c.body?.includes('/api/public/v1/intake/li_')));
  assert.ok(calls.some((c) => c.url.endsWith('/token') && c.body?.includes('client_secret=csecret')));

  const msg = (text: string, author = 4242) => ({ id: 'x', version: 'v3', payload: { type: 'message', value: { chat_id: 'chat-1', author_id: author, user_id: 555, content: { text }, item_id: 3001, created: Math.floor(Date.now() / 1000) } } });
  assert.equal((await pub(av.url, msg('Здравствуйте, есть ли абонемент на 3 месяца?'))).statusCode, 200);
  assert.equal((await pub(av.url, msg('И сколько стоит?'))).statusCode, 200);
  assert.equal((await pub(av.url, msg('Ответ клуба', 555))).statusCode, 200);
  const leads = await sql(`select l.comment, p.full_name from leads l join lead_sources s on s.id = l.source_id join persons p on p.id = l.person_id where s.code = 'avito'`);
  assert.equal(leads.length, 1, 'второе сообщение того же дня и своё сообщение не создают заявок');
  assert.match(leads[0].comment, /по объявлению 3001:\nЗдравствуйте, есть ли абонемент/);
  const g = (await req('GET', `/api/intake?clubId=${centr}`, 'o.smirnov')).json();
  assert.equal(g.list.find((x: { kind: string }) => x.kind === 'avito').settings.avitoUserId, '555');
});
