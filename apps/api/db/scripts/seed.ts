// Тестовые данные: сеть, два клуба на разных моделях продаж, по сотруднику на роль, клиенты по категориям.
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { connect, need } from './common.ts';
import { ROLE_SEED } from '../../src/roles.ts';
import { applyClubPreset, applyMembershipPreset, ensureLeadSources } from '../../src/presets.ts';
import { addDays, addMonths, sellMembership } from '../../src/modules/memberships.ts';
import { createLead } from '../../src/modules/crm.ts';
import { handleInbound } from '../../src/modules/messaging.ts';
import { decide, recordEvent } from '../../src/modules/acs.ts';
import { createHash } from 'node:crypto';
import type { Db } from '../../src/db.ts';

const STAFF: [string, string, string, 'c1' | 'c2' | '*'][] = [
  ['a.bespalyy', 'Андрей Беспалый', 'owner', '*'],
  ['i.kotova', 'Ирина Котова', 'admin', '*'],
  ['o.smirnov', 'Олег Смирнов', 'gm', 'c1'],
  ['o.astafeva', 'Ольга Астафьева', 'rop', 'c1'],
  ['m.volkova', 'Мария Волкова', 'manager', 'c1'],
  ['d.lis', 'Дарья Лис', 'desk', 'c1'],
  ['e.orlova', 'Екатерина Орлова', 'fin', 'c1'],
  ['a.kim', 'Артём Ким', 'trainer', 'c1'],
  ['s.pavlov', 'Сергей Павлов', 'gm', 'c2'],
  ['n.belova', 'Наталья Белова', 'rop', 'c2'],
  ['i.zuev', 'Игорь Зуев', 'manager', 'c2'],
  ['a.morozova', 'Алина Морозова', 'desk', 'c2'],
  ['v.gusev', 'Виктор Гусев', 'fin', 'c2'],
  ['p.ershova', 'Полина Ершова', 'trainer', 'c2'],
];

const PERSONS: [string, string, 'c1' | 'c2', string][] = [
  ['Светлана Юдина', 'лид', 'c1', '+79030000108'],
  ['Кирилл Демин', 'новый', 'c1', '+79150000190'],
  ['Павел Рябов', 'действующий', 'c1', '+79260000155'],
  ['Алексей Громов', 'на продление', 'c1', '+79160000121'],
  ['Елена Миронова', 'бывший', 'c1', '+79850000114'],
  ['Глеб Ушаков', 'гость', 'c1', '+79250000177'],
  ['Анна Ковалёва', 'лид', 'c2', '+79050000177'],
  ['Роман Фёдоров', 'активный подписчик', 'c2', '+79160000146'],
  ['Ксения Лаптева', 'отписавшийся', 'c2', '+79990000112'],
  ['Тимур Ахметов', 'долг по списанию', 'c2', '+79770000131'],
  ['Глеб Орлов', 'гость', 'c2', '+79250000165'],
];

// Демо-абонементы: действующий, скоро окончание, истёкший, подписка, подписка с долгом (проход закрыт), расторгнутая
async function seedMemberships(c: Db, t: string) {
  const today = (await c.query(`select to_char((now() at time zone 'Europe/Moscow')::date, 'YYYY-MM-DD') as d`)).rows[0].d as string;
  const ctx = { tenantId: t, userId: null as unknown as string };
  const pid = async (name: string) => (await c.query('select id from persons where full_name = $1', [name])).rows[0].id as string;
  const prod = async (name: string) => (await c.query('select id from products where name = $1 limit 1', [name])).rows[0].id as string;
  // Сдвигает абонемент в прошлое на days дней вместе с графиком платежей
  const shift = async (id: string, days: number) => {
    await c.query('update memberships set starts_on = starts_on - $2::int, ends_on = ends_on - $2::int, next_charge_on = next_charge_on - $2::int where id = $1', [id, days]);
    await c.query('update charges set due_on = due_on - $2::int where membership_id = $1', [id, days]);
    await c.query('update contracts set contract_date = contract_date - $2::int where membership_id = $1', [id, days]);
  };
  const payAll = async (id: string) => {
    await c.query(`update charges set status = 'paid', paid_at = due_on::timestamp + interval '12 hours', paid_method = 'card_terminal' where membership_id = $1 and due_on <= $2`, [id, today]);
    await c.query(`insert into payments(tenant_id, club_id, direction, kind, amount_kop, method, person_id, charge_id, sale_category, created_at)
      select ch.tenant_id, ch.club_id, 'in', 'charge', ch.amount_kop, 'card_terminal', ch.person_id, ch.id, m.sale_category, ch.paid_at
      from charges ch join memberships m on m.id = ch.membership_id where ch.membership_id = $1 and ch.status = 'paid'`, [id]);
  };
  const sell = async (person: string, product: string, installments = 1) => (await sellMembership(c, ctx, { personId: await pid(person), productId: await prod(product), installments })).id;

  // Реквизиты демо-клубов (вымышленные, для проверки печати договора)
  const clubsRows = (await c.query(`select id, name from clubs order by created_at`)).rows;
  const demo = [['ООО «Фитнес Центр» (демо)', '7701000001', 'Ц', 'Смирнов О. А.'], ['ООО «Фитнес Север» (демо)', '7713000002', 'С', 'Павлов С. И.']];
  for (const [i, cl] of clubsRows.entries()) {
    const [fullName, inn, prefix, signer] = demo[i] ?? demo[0];
    await c.query(`insert into legal_entities(club_id, tenant_id, full_name, inn, kpp, ogrn, address, bank_name, bik, account, corr_account, signer_name, signer_basis, contract_prefix)
      values ($1,$2,$3,$4,'770101001','1027700000001',$5,'ПАО «Демо-банк»','044525000','40702810000000000001','30101810400000000225',$7,'доверенности № 1 от 01.11.2026',$6)`,
      [cl.id, t, fullName, inn, `Москва, ${cl.name}`, prefix, signer]);
  }
  const ryabov = await sell('Павел Рябов', 'Годовой безлимит'); await shift(ryabov, 90); await payAll(ryabov);
  const gromov = await sell('Алексей Громов', 'Полгода безлимит', 3); await shift(gromov, 177); await payAll(gromov);
  const mironova = await sell('Елена Миронова', 'Месяц безлимит'); await shift(mironova, 90); await payAll(mironova);
  const fedorov = await sell('Роман Фёдоров', 'Подписка «Безлимит»'); await shift(fedorov, 10); await payAll(fedorov);
  const akhmetov = await sell('Тимур Ахметов', 'Подписка «Безлимит»'); await shift(akhmetov, 35); await payAll(akhmetov);
  // Следующий период выставлен, но списание не прошло 5 дней назад
  const due = addDays(today, -5);
  await c.query(`insert into charges(tenant_id, club_id, membership_id, person_id, kind, title, due_on, amount_kop)
    select tenant_id, club_id, id, person_id, 'subscription', product_name || ': следующий месяц', $2, amount_kop from memberships where id = $1`, [akhmetov, due]);
  await c.query('update memberships set ends_on = $2, next_charge_on = $3 where id = $1', [akhmetov, addDays(addMonths(due, 1), -1), addMonths(due, 1)]);
  const laptevaId = await sell('Ксения Лаптева', 'Подписка «Безлимит»'); await shift(laptevaId, 60); await payAll(laptevaId);
  await c.query(`update memberships set status = 'cancelled', cancel_reason = 'Переезд', next_charge_on = null where id = $1`, [laptevaId]);
  // Демо-предложения для сайта: одно опубликовано, одно в черновике
  const [c1, c2] = clubsRows;
  await c.query(`insert into site_offers(tenant_id, club_id, title, description, price_kop, old_price_kop, price_note, status, published_at)
    values ($1,$2,'Годовой безлимит со скидкой 15 %','Оформите годовой абонемент до конца месяца и получите 2 гостевых визита для друзей.',3570000,4200000,'за год','published',now()),
           ($1,$3,'Первый месяц подписки за 990 ₽','Для новых клиентов. Дальше 4 900 ₽ в месяц, отменить можно в любой момент.',99000,490000,'первый месяц','draft',null)`,
    [t, c1.id, c2.id]);
  // Продажи этого месяца, чтобы в ДДС и план-факте были цифры
  const demin = await sell('Кирилл Демин', 'Месяц безлимит'); await payAll(demin);
  const ushakov = await sell('Глеб Ушаков', '10 посещений'); await payAll(ushakov);
  const orlov = await sell('Глеб Орлов', 'Подписка «Безлимит»'); await payAll(orlov);
  // План продаж на текущий месяц
  const month = `${today.slice(0, 7)}-01`;
  for (const [cl, plan] of [[c1, [['new', 50_000_000], ['renewal', 30_000_000], ['return', 10_000_000]]], [c2, [['subscription', 40_000_000], ['new', 5_000_000]]]] as const) {
    for (const [cat, kop] of plan) await c.query('insert into sales_plans(tenant_id, club_id, month, category, amount_kop) values ($1,$2,$3,$4,$5)', [t, cl.id, month, cat, kop]);
  }
  // Старые договоры подписаны на бумаге, у новой подписки договор ждёт подписи
  await c.query(`update contracts set status = 'signed', sign_method = 'paper_scan', signed_at = now() - interval '1 day'
    where membership_id = any($1)`, [[ryabov, gromov, mironova, akhmetov, laptevaId]]);
  await c.query(`update contracts set status = 'cancelled' where membership_id = $1`, [laptevaId]);
  await c.query(`update persons set segment = s.seg from (values ('Павел Рябов','действующий'),('Алексей Громов','на продление'),('Елена Миронова','бывший'),
    ('Роман Фёдоров','активный подписчик'),('Кирилл Демин','действующий'),('Глеб Ушаков','действующий'),('Глеб Орлов','активный подписчик'),('Тимур Ахметов','долг по списанию'),('Ксения Лаптева','отписавшийся')) s(n, seg) where full_name = s.n`);
}

export async function seed(url = need('OWNER_DATABASE_URL'), quiet = false) {
  const password = process.env.SEED_PASSWORD || 'Fitnes-2026';
  const c = await connect(url);
  await c.query('begin');
  for (const r of ROLE_SEED) {
    await c.query(
      `insert into roles(code, name, permissions, network_wide, sort) values ($1,$2,$3,$4,$5)
       on conflict (code) do update set name = excluded.name, permissions = excluded.permissions,
         network_wide = excluded.network_wide, sort = excluded.sort`,
      [r.code, r.name, r.permissions, r.network_wide, r.sort],
    );
  }
  const existing = await c.query('select id from tenants limit 1');
  if (existing.rowCount) {
    // Обновление уже заполненной базы: готовые воронки и источники для клубов, у которых их ещё нет
    const tid = existing.rows[0].id;
    await ensureLeadSources(c, tid);
    for (const cl of (await c.query('select id, sales_model from clubs where not exists (select 1 from pipelines p where p.club_id = clubs.id)')).rows) {
      await applyClubPreset(c, tid, cl.id, cl.sales_model);
    }
    for (const cl of (await c.query('select id, sales_model from clubs where not exists (select 1 from club_membership_settings s where s.club_id = clubs.id)')).rows) {
      await applyMembershipPreset(c, tid, cl.id, cl.sales_model);
    }
    await c.query('commit');
    await c.end();
    if (!quiet) console.log('Тестовые данные уже есть, роли обновлены. Для полного пересоздания: npm run db:reset');
    return;
  }
  const t = (await c.query(`insert into tenants(name) values ('Демо-сеть клубов') returning id`)).rows[0].id;
  const clubs = {
    c1: (await c.query(`insert into clubs(tenant_id, name, address, sales_model) values ($1, 'Клуб «Центр»', 'Москва, ул. Тверская, 12', 'term') returning id`, [t])).rows[0].id,
    c2: (await c.query(`insert into clubs(tenant_id, name, address, sales_model) values ($1, 'Клуб «Север»', 'Москва, Дмитровское ш., 89', 'subscription') returning id`, [t])).rows[0].id,
  };
  for (const [k, model] of [['c1', 'term'], ['c2', 'subscription']] as const) {
    await c.query('insert into club_sales_model_history(tenant_id, club_id, old_model, new_model, apply_from) values ($1,$2,null,$3,$4)', [t, clubs[k], model, 'now']);
  }
  const pwHash = await hash(password);
  for (const [login, name, role, club] of STAFF) {
    const u = (await c.query(
      'insert into users(tenant_id, login, password_hash, full_name, must_change_password) values ($1,$2,$3,$4,false) returning id',
      [t, login, pwHash, name],
    )).rows[0].id;
    await c.query('insert into user_assignments(tenant_id, user_id, role_code, club_id) values ($1,$2,$3,$4)', [t, u, role, club === '*' ? null : clubs[club]]);
  }
  await ensureLeadSources(c, t);
  await applyClubPreset(c, t, clubs.c1, 'term');
  await applyClubPreset(c, t, clubs.c2, 'subscription');
  const sources = ['site', 'yandex_direct', 'telegram', 'walk_in'];
  let si = 0;
  for (const [name, segment, club, phone] of PERSONS) {
    if (segment === 'лид' || segment === 'гость') {
      const r = await createLead(c as unknown as Db, { tenantId: t, userId: null }, {
        clubId: clubs[club], fullName: name, phone, sourceCode: sources[si++ % sources.length],
        comment: segment === 'гость' ? 'Гостевой визит' : 'Заявка: интересуется стоимостью',
      });
      if (segment === 'гость') await c.query(`update persons set segment = 'гость' where id = $1`, [r.personId]);
      continue;
    }
    const p = (await c.query('insert into persons(tenant_id, home_club_id, full_name, segment) values ($1,$2,$3,$4) returning id', [t, clubs[club], name, segment])).rows[0].id;
    await c.query(`insert into person_contacts(tenant_id, person_id, type, value, normalized_value, is_primary) values ($1,$2,'phone',$3,$3,true)`, [t, p, phone]);
  }
  const limits: [string, string, number | null, number | null][] = [
    ['manager', 'discount', null, 5], ['rop', 'discount', null, 10],
    ['gm', 'refund', 1_500_000, null], ['gm', 'discount', null, 15], ['gm', 'expense', 5_000_000, null],
  ];
  for (const [role, kind, kop, pct] of limits) {
    await c.query('insert into approval_limits(tenant_id, role_code, kind, max_amount_kop, max_percent) values ($1,$2,$3,$4,$5)', [t, role, kind, kop, pct]);
  }
  await seedMemberships(c as unknown as Db, t);
  await seedMessaging(c as unknown as Db, t, clubs);
  await seedAccess(c as unknown as Db, t, clubs);
  // Один лид с просроченным первым ответом, чтобы было видно контроль нормы
  await c.query(`update leads set created_at = now() - interval '20 minutes', first_response_due_at = now() - interval '15 minutes'
                 where id = (select id from leads order by created_at limit 1)`);
  await c.query(`update tasks set due_at = now() - interval '15 minutes' where lead_id = (select id from leads order by created_at limit 1)`);
  await c.query('commit');
  await c.end();
  if (!quiet) {
    console.log(`Тестовые данные созданы: 2 клуба, ${STAFF.length} сотрудников, ${PERSONS.length} клиентов.`);
    console.log(`Вход: логин, например a.bespalyy (собственник) или i.kotova (администратор), пароль ${password}`);
  }
}

// Шаг 10. Тестовые каналы и пара диалогов, чтобы окно переписки не было пустым
async function seedMessaging(c: Db, t: string, clubs: Record<string, string>) {
  const ch = async (club: string, messenger: string, name: string) => (await c.query(`insert into msg_channels(tenant_id, club_id, kind, messenger, name, webhook_token)
    values ($1,$2,'test',$3,$4,md5(random()::text)) returning *`, [t, club, messenger, name])).rows[0];
  const wa = await ch(clubs.c1, 'whatsapp', 'Тестовый WhatsApp');
  const tg = await ch(clubs.c1, 'telegram', 'Тестовый Telegram');
  await ch(clubs.c2, 'whatsapp', 'Тестовый WhatsApp');
  const actor = { tenantId: t, userId: null };
  const at = (min: number) => new Date(Date.now() - min * 60_000);
  await handleInbound(c, actor, { ...wa, secret: null }, { chatId: '79161230011', externalId: 'seed-1', text: 'Здравствуйте! Сколько стоит годовой абонемент?', name: 'Марина Белых', phone: '79161230011', at: at(95) });
  await handleInbound(c, actor, { ...tg, secret: null }, { chatId: '500100200', externalId: 'seed-2', text: 'Добрый день, есть ли у вас бассейн?', name: 'Игорь Пан', phone: null, at: at(40) });
  // Действующий клиент пишет в WhatsApp со своего номера — диалог попадает в его карточку
  await handleInbound(c, actor, { ...wa, secret: null }, { chatId: '79260000155', externalId: 'seed-3', text: 'Можно перенести персональную тренировку на завтра?', name: 'Павел', phone: '79260000155', at: at(15) });
  await c.query(`update persons set marketing_consent = true where full_name in ('Павел Рябов', 'Алексей Громов', 'Роман Фёдоров')`);
  await c.query(`update persons set birth_date = (now() at time zone 'Europe/Moscow')::date - interval '30 years' where full_name = 'Павел Рябов'`);
}

// Шаг 11. Турникеты, шлюзы, карты и немного проходов
export const DEMO_GATEWAY_KEYS = { c1: 'demo-centr-gateway-key', c2: 'demo-sever-gateway-key' };
async function seedAccess(c: Db, t: string, clubs: Record<string, string>) {
  const ids: Record<string, { gw: string; inP: string; outP: string }> = {};
  for (const k of ['c1', 'c2'] as const) {
    const gw = (await c.query(`insert into access_gateways(tenant_id, club_id, name, token_hash) values ($1,$2,'Шлюз ресепшн',$3) returning id`,
      [t, clubs[k], createHash('sha256').update(DEMO_GATEWAY_KEYS[k]).digest('hex')])).rows[0].id;
    const inP = (await c.query(`insert into access_points(tenant_id, club_id, gateway_id, name, direction) values ($1,$2,$3,'Турникет вход','in') returning id`, [t, clubs[k], gw])).rows[0].id;
    const outP = (await c.query(`insert into access_points(tenant_id, club_id, gateway_id, name, direction) values ($1,$2,$3,'Турникет выход','out') returning id`, [t, clubs[k], gw])).rows[0].id;
    ids[k] = { gw, inP, outP };
  }
  const card = async (k: 'c1' | 'c2', name: string, code: string, kind = 'card', status = 'active') => {
    const p = (await c.query('select id from persons where full_name = $1', [name])).rows[0];
    const u = p ? null : (await c.query('select id from users where full_name = $1', [name])).rows[0];
    await c.query(`insert into access_credentials(tenant_id, club_id, person_id, user_id, kind, code, status, revoked_at, revoke_reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t, clubs[k], p?.id ?? null, u?.id ?? null, kind, code, status, status === 'active' ? null : new Date(), status === 'active' ? null : 'Сломалась, выдана новая']);
  };
  await card('c1', 'Павел Рябов', '099999', 'card', 'replaced');
  await card('c1', 'Павел Рябов', '100001');
  await card('c1', 'Алексей Громов', '100002', 'bracelet');
  await card('c1', 'Елена Миронова', '100003');
  await card('c1', 'Кирилл Демин', '100004');
  await card('c1', 'Глеб Ушаков', '100005');
  await card('c2', 'Роман Фёдоров', '200001');
  await card('c2', 'Тимур Ахметов', '200002');
  await card('c2', 'Ксения Лаптева', '200003');
  await card('c2', 'Глеб Орлов', '200004');
  await card('c1', 'Дарья Лис', '900001');
  await card('c2', 'Алина Морозова', '900002');
  // История посещений Рябова за месяц: вход и выход
  const ryabov = (await c.query(`select id from persons where full_name = 'Павел Рябов'`)).rows[0].id;
  for (const d of [3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26, 29]) {
    await c.query(`insert into visits(tenant_id, club_id, person_id, visited_at, exit_at, source) values ($1,$2,$3, now() - make_interval(days => $4) - interval '3 hours', now() - make_interval(days => $4) - interval '90 minutes', 'acs')`,
      [t, clubs.c1, ryabov, d]);
  }
  // Сегодняшние проходы на ресепшн (по часам клуба, ночью система честно ответит «клуб закрыт»)
  const ev = async (k: 'c1' | 'c2', code: string, dir: 'in' | 'out', minAgo: number) => {
    const at = new Date(Date.now() - minAgo * 60_000);
    const d = await decide(c, clubs[k], code, dir, at);
    await recordEvent(c, t, { clubId: clubs[k], pointId: dir === 'in' ? ids[k].inP : ids[k].outP, gatewayId: ids[k].gw, externalId: `seed-${k}-${code}-${minAgo}`, at, direction: dir, code, mode: 'online' }, d);
  };
  await ev('c1', '900001', 'in', 125);
  await ev('c1', '100001', 'in', 95);
  await ev('c1', '100003', 'in', 80);
  await ev('c1', '099999', 'in', 70);
  await ev('c1', '100002', 'in', 50);
  await ev('c1', '100001', 'out', 20);
  await ev('c2', '200002', 'in', 60);
  await ev('c2', '200001', 'in', 40);
  await ev('c2', '900002', 'in', 130);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await seed();
