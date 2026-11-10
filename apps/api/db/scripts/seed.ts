// Тестовые данные: сеть, два клуба на разных моделях продаж, по сотруднику на роль, клиенты по категориям.
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { connect, need } from './common.ts';
import { ROLE_SEED } from '../../src/roles.ts';
import { applyClubPreset, ensureLeadSources } from '../../src/presets.ts';
import { createLead } from '../../src/modules/crm.ts';
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await seed();
