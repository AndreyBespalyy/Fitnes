// Шаг 13. Демо-история продаж за полтора месяца, чтобы дашборды, конверсия и KPI показывали живые цифры:
// лиды из разных каналов, первые ответы, звонки, встречи, покупки менеджеров, отказы, посещения, личные планы.
// Запускается один раз для демо-сети (при заполнении тестовыми данными или при обновлении уже заполненной демо-базы).
import { createLead } from '../../src/modules/crm.ts';
import { addDays, sellMembership } from '../../src/modules/memberships.ts';
import type { Db } from '../../src/db.ts';

const FIRST_M = ['Иван', 'Дмитрий', 'Максим', 'Артём', 'Никита', 'Михаил', 'Андрей', 'Егор', 'Илья', 'Сергей', 'Владимир', 'Олег'];
const FIRST_F = ['Анна', 'Мария', 'Екатерина', 'Ольга', 'Наталья', 'Юлия', 'Дарья', 'Алина', 'Виктория', 'Ирина', 'Татьяна', 'Полина'];
const LAST = ['Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов'];
const LOST = ['Дорого', 'Выбрал другой клуб', 'Неудобное расположение', 'Не дозвонились', 'Передумал'];

export const DEMO_MARK = 'demo.history_seeded';

export async function seedDemoHistory(c: Db, t: string) {
  if ((await c.query(`select 1 from audit_log where tenant_id = $1 and action = $2`, [t, DEMO_MARK])).rowCount) return false;
  let seed = 20261110;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const today = (await c.query(`select to_char((now() at time zone 'Europe/Moscow')::date, 'YYYY-MM-DD') as d`)).rows[0].d as string;
  // Местное время Москвы (UTC+3) → момент времени
  const at = (day: string, minutes: number) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 0, 0) + (minutes - 180) * 60_000); };
  const now = Date.now();
  const sources = (await c.query(`select code from lead_sources where tenant_id = $1 and is_active and code in ('site', 'yandex_direct', 'vk_ads', 'telegram', 'whatsapp', 'walk_in', 'referral', 'yandex_maps', 'phone')`, [t])).rows.map((r) => r.code as string);
  const srcWeights = sources.flatMap((s) => Array(s === 'site' || s === 'yandex_direct' ? 3 : s === 'walk_in' || s === 'referral' ? 1 : 2).fill(s));
  const clubs = (await c.query(`select id, sales_model from clubs where tenant_id = $1 order by created_at`, [t])).rows;
  let phoneN = 0;
  for (const club of clubs) {
    const staff = (await c.query(`select u.id, a.role_code as role from users u join user_assignments a on a.user_id = u.id where a.club_id = $1 and a.role_code in ('manager', 'rop') order by a.role_code`, [club.id])).rows;
    if (!staff.length) continue;
    const weighted = staff.flatMap((s) => Array(s.role === 'manager' ? 3 : 1).fill(s.id as string));
    const products = (await c.query(`select id, kind from products where club_id = $1 and is_active and kind in ('term', 'visits', 'subscription') order by created_at`, [club.id])).rows;
    const stages = (await c.query(`select s.id, s.kind from pipeline_stages s join pipelines p on p.id = s.pipeline_id where p.club_id = $1 and p.is_default_for_leads order by s.sort`, [club.id])).rows;
    const won = stages.find((s) => s.kind === 'won')?.id; const lost = stages.find((s) => s.kind === 'lost')?.id;
    for (let back = 45; back >= 0; back--) {
      const day = addDays(today, -back);
      const n = Math.floor(rnd() * 3) + (back === 0 ? 1 : 1);
      for (let k = 0; k < n; k++) {
        const startMin = 9 * 60 + Math.floor(rnd() * 11 * 60);
        const created = at(day, startMin);
        if (created.getTime() > now - 10 * 60_000) continue;
        const female = rnd() < 0.55;
        const name = `${female ? pick(FIRST_F) : pick(FIRST_M)} ${pick(LAST)}${female ? 'а' : ''}`;
        const phone = `+7999${String(1000000 + phoneN++).slice(-7)}`;
        const mgr = pick(weighted);
        const lead = await createLead(c, { tenantId: t, userId: null }, { clubId: club.id, fullName: name, phone, sourceCode: pick(srcWeights), assignedTo: mgr, comment: 'Заявка' });
        const responded = rnd() < 0.93;
        const respMin = rnd() < 0.8 ? 1 + Math.floor(rnd() * 5) : 6 + Math.floor(rnd() * 40);
        const respAt = new Date(created.getTime() + respMin * 60_000);
        await c.query(`update leads set created_at = $2, first_response_due_at = $3, first_response_at = $4 where id = $1`,
          [lead.leadId, created, new Date(created.getTime() + 5 * 60_000), responded ? respAt : null]);
        await c.query(`update tasks set created_at = $2, due_at = $3, done_at = $4, result = $5 where lead_id = $1`,
          [lead.leadId, created, new Date(created.getTime() + 5 * 60_000), responded ? respAt : null, responded ? 'Связался, рассказал о клубе' : null]);
        await c.query(`update opportunities set created_at = $2, updated_at = $2 where id = $1`, [lead.opportunityId, created]);
        await c.query(`update opportunity_stage_history set at = $2 where opportunity_id = $1`, [lead.opportunityId, created]);
        if (!responded) continue;
        // Повторные звонки
        for (let j = 0; j < Math.floor(rnd() * 3); j++) {
          const due = new Date(respAt.getTime() + (j + 1) * 86_400_000 * (0.5 + rnd()));
          if (due.getTime() > now) break;
          await c.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, opportunity_id, kind, title, due_at, done_at, result, created_by, created_at)
            values ($1,$2,$3,$4,$5,'call','Перезвонить',$6,$6,'Поговорили',$3,$7)`, [t, club.id, mgr, lead.personId, lead.opportunityId, due, respAt]);
        }
        const daysAgo = (now - created.getTime()) / 86_400_000;
        let bought = false;
        if (rnd() < 0.58) {
          const sched = new Date(respAt.getTime() + (1 + Math.floor(rnd() * 3)) * 86_400_000);
          const past = sched.getTime() < now - 3600_000;
          const status = !past ? 'scheduled' : rnd() < 0.78 ? 'attended' : 'no_show';
          await c.query(`insert into meetings(tenant_id, club_id, opportunity_id, person_id, scheduled_at, status, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [t, club.id, lead.opportunityId, lead.personId, sched, status, mgr, respAt, past ? sched : respAt]);
          const prods = products.filter((p) => p.kind !== 'subscription' || (now - sched.getTime()) / 86_400_000 < 27);
          if (status === 'attended' && rnd() < 0.62 && prods.length) {
            const prod = club.sales_model === 'subscription' ? (prods.find((p) => p.kind === 'subscription') ?? pick(prods)) : pick(prods.filter((p) => p.kind !== 'subscription').length ? prods.filter((p) => p.kind !== 'subscription') : prods);
            const sale = await sellMembership(c, { tenantId: t, userId: mgr }, { personId: lead.personId, productId: prod.id });
            const saleAt = new Date(sched.getTime() + 40 * 60_000);
            const saleDay = (await c.query(`select to_char(($1::timestamptz at time zone 'Europe/Moscow')::date, 'YYYY-MM-DD') as d`, [saleAt])).rows[0].d as string;
            const shift = Math.round((Date.parse(today) - Date.parse(saleDay)) / 86_400_000);
            await c.query('update memberships set created_at = $2, starts_on = starts_on - $3::int, ends_on = ends_on - $3::int, next_charge_on = next_charge_on - $3::int where id = $1', [sale.id, saleAt, shift]);
            await c.query('update charges set due_on = due_on - $2::int, created_at = $3 where membership_id = $1', [sale.id, shift, saleAt]);
            await c.query('update contracts set contract_date = contract_date - $2::int, created_at = $3 where membership_id = $1', [sale.id, shift, saleAt]);
            await c.query('update membership_operations set at = $2 where membership_id = $1', [sale.id, saleAt]);
            await c.query(`update charges set status = 'paid', paid_at = $2, paid_method = $3 where membership_id = $1 and due_on <= $4`, [sale.id, saleAt, rnd() < 0.7 ? 'card_terminal' : 'sbp', today]);
            await c.query(`insert into payments(tenant_id, club_id, direction, kind, amount_kop, method, person_id, charge_id, sale_category, created_by, created_at)
              select ch.tenant_id, ch.club_id, 'in', 'charge', ch.amount_kop, ch.paid_method, ch.person_id, ch.id, m.sale_category, $2, ch.paid_at
              from charges ch join memberships m on m.id = ch.membership_id where ch.membership_id = $1 and ch.status = 'paid'`, [sale.id, mgr]);
            await c.query(`update contracts set status = 'signed', sign_method = 'paper_scan', signed_at = $2 where membership_id = $1`, [sale.id, saleAt]);
            if (won) await c.query(`update opportunities set status = 'won', stage_id = $2, closed_at = $3, updated_at = $3 where id = $1`, [lead.opportunityId, won, saleAt]);
            // Посещения купивших: два-три раза в неделю, сегодня — у части клиентов
            for (let d = shift; d >= 0; d--) {
              if (rnd() < (d === 0 ? 0.35 : 0.33)) {
                const v = at(addDays(today, -d), 7 * 60 + Math.floor(rnd() * 14 * 60));
                if (v.getTime() < now) await c.query(`insert into visits(tenant_id, club_id, person_id, membership_id, visited_at, source) values ($1,$2,$3,$4,$5,'manual')`, [t, club.id, lead.personId, sale.id, v]);
              }
            }
            bought = true;
          }
        }
        if (!bought && lost && daysAgo > 7 && rnd() < 0.55) {
          const closed = new Date(created.getTime() + (2 + rnd() * 5) * 86_400_000);
          await c.query(`update opportunities set status = 'lost', stage_id = $2, lost_reason = $3, closed_at = $4, updated_at = $4 where id = $1`, [lead.opportunityId, lost, pick(LOST), closed]);
          await c.query(`update persons set segment = 'отказ' where id = $1`, [lead.personId]);
        }
      }
    }
    // Личные планы менеджеров на текущий месяц: план клуба делится между отделом (менеджер 70 %, РОП 30 %)
    const month = `${today.slice(0, 7)}-01`;
    const plan = (await c.query(`select category, amount_kop from plan_targets where club_id = $1 and month = $2 and user_id is null`, [club.id, month])).rows;
    const avg = (await c.query(`select coalesce(sale_category, 'new') as cat, (round(avg(amount_kop) / 10000) * 10000)::bigint as a from memberships where club_id = $1 and kind <> 'guest' group by 1`, [club.id])).rows;
    for (const p of plan) {
      const a = avg.find((x) => x.cat === p.category)?.a ?? (club.sales_model === 'subscription' ? 490000 : 650000);
      await c.query(`update plan_targets set avg_check_kop = $3 where club_id = $1 and month = $2 and user_id is null and category = $4`, [club.id, month, a, p.category]);
      for (const s of staff) {
        const share = s.role === 'manager' ? 0.7 / staff.filter((x) => x.role === 'manager').length : 0.3 / Math.max(1, staff.filter((x) => x.role === 'rop').length);
        await c.query(`insert into plan_targets(tenant_id, club_id, month, user_id, category, amount_kop, avg_check_kop) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [t, club.id, month, s.id, p.category, Math.round(Number(p.amount_kop) * share / 100) * 100, a]);
      }
    }
  }
  await c.query(`insert into audit_log(tenant_id, actor_id, action, object_type, object_id) values ($1, null, $2, 'tenant', $3)`, [t, DEMO_MARK, String(t)]);
  return true;
}
