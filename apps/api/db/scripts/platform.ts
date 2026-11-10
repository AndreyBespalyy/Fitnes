// Оператор платформы: договор сети с платформой (тариф и ограничения) и обращения, переданные разработчикам.
//   npm run platform -- contract show
//   npm run platform -- contract set --number П-1 --signed 2026-11-10 --plan Пилот [--clubs 3] [--users 40] [--valid-to 2027-11-10] [--fee 0]
//   npm run platform -- support [--all]          список обращений, переданных разработчикам (или всех открытых)
//   npm run platform -- answer <номер> "текст"    ответ от поддержки платформы
// Работает под владельцем базы (OWNER_DATABASE_URL), из приложения договор менять нельзя.
import { connect, need } from './common.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const num = (v?: string) => (v === undefined ? null : Number(v));

const c = await connect(need('OWNER_DATABASE_URL'));
try {
  const tenants = (await c.query('select id, name from tenants order by created_at')).rows;
  const tName = opt('tenant');
  const t = tName ? tenants.find((x) => x.name === tName) : tenants[0];
  if (!t) throw new Error(`Сеть не найдена. Есть: ${tenants.map((x) => x.name).join(', ')}`);
  const [cmd, sub] = args;
  if (cmd === 'contract' && sub === 'set') {
    const number = opt('number'); const signed = opt('signed'); const plan = opt('plan');
    if (!number || !signed || !plan) throw new Error('Нужны --number, --signed (ГГГГ-ММ-ДД) и --plan');
    await c.query(`insert into tenant_contracts(tenant_id, number, signed_on, plan, clubs_limit, users_limit, valid_to, fee_kop, note)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id) do update set number = excluded.number, signed_on = excluded.signed_on, plan = excluded.plan,
      clubs_limit = excluded.clubs_limit, users_limit = excluded.users_limit, valid_to = excluded.valid_to, fee_kop = excluded.fee_kop, note = excluded.note, updated_at = now()`,
      [t.id, number, signed, plan, num(opt('clubs')), num(opt('users')), opt('valid-to') ?? null, opt('fee') ? Math.round(Number(opt('fee')) * 100) : null, opt('note') ?? null]);
    await c.query(`insert into audit_log(tenant_id, actor_id, action, object_type, object_id, after) values ($1, null, 'platform.contract_set', 'tenant', $1, $2)`,
      [t.id, JSON.stringify({ number, signed, plan, clubs: opt('clubs'), users: opt('users') })]);
    console.log(`Договор сохранён для сети «${t.name}»`);
  } else if (cmd === 'contract') {
    const r = (await c.query('select * from tenant_contracts where tenant_id = $1', [t.id])).rows[0];
    console.log(r ? r : 'Договора нет: ограничений тарифа нет');
  } else if (cmd === 'support') {
    const rows = (await c.query(`select t.number, t.subject, t.kind, t.status, to_char(t.created_at, 'DD.MM HH24:MI') as at, u.full_name as author,
      (select body from support_messages m where m.ticket_id = t.id order by created_at desc limit 1) as last
      from support_tickets t join users u on u.id = t.author_id where t.tenant_id = $1 and ($2 or t.escalated_at is not null) and t.status <> 'closed' order by t.number`, [t.id, args.includes('--all')])).rows;
    for (const r of rows) console.log(`№${r.number} [${r.status}] ${r.at} ${r.author}: ${r.subject}\n   ${String(r.last).slice(0, 300)}`);
    if (!rows.length) console.log('Открытых обращений нет');
  } else if (cmd === 'answer') {
    const n = Number(args[1]); const text = args[2];
    if (!n || !text) throw new Error('npm run platform -- answer <номер> "текст"');
    const tk = (await c.query('select id from support_tickets where tenant_id = $1 and number = $2', [t.id, n])).rows[0];
    if (!tk) throw new Error('Обращение не найдено');
    await c.query(`insert into support_messages(tenant_id, ticket_id, author_id, from_support, body) values ($1,$2,null,true,$3)`, [t.id, tk.id, text]);
    await c.query(`update support_tickets set status = 'answered', updated_at = now() where id = $1`, [tk.id]);
    console.log('Ответ отправлен');
  } else {
    console.log('Команды: contract show | contract set … | support [--all] | answer <номер> "текст"');
  }
} catch (e) {
  console.error((e as Error).message); process.exitCode = 1;
} finally { await c.end(); }
