// Демо-расписание: залы, виды занятий, занятия на 2 недели назад и 2 недели вперёд, записи клиентов.
// Запускается один раз для демо-сети (при заполнении тестовыми данными или при обновлении уже заполненной демо-базы).
import type { Db } from '../../src/db.ts';

export const DEMO_SCHEDULE_MARK = 'demo.schedule_seeded';

const TYPES: [string, 'group' | 'personal', number, number][] = [
  ['Йога', 'group', 60, 15], ['Функциональный тренинг', 'group', 50, 20], ['Пилатес', 'group', 55, 12], ['Персональная тренировка', 'personal', 60, 1],
];
// день недели (1 — понедельник), время, вид
const WEEK: [number, string, number][] = [[1, '09:00', 0], [1, '19:00', 1], [2, '18:30', 2], [3, '09:00', 0], [3, '19:00', 1], [4, '18:30', 2], [5, '19:00', 1], [6, '11:00', 0], [2, '10:00', 3], [4, '12:00', 3]];

export async function seedDemoSchedule(c: Db, t: string) {
  if ((await c.query(`select 1 from audit_log where tenant_id = $1 and action = $2`, [t, DEMO_SCHEDULE_MARK])).rowCount) return false;
  let seed = 31; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const clubs = (await c.query(`select id, timezone from clubs where tenant_id = $1 and status = 'active' and not is_demo order by created_at`, [t])).rows;
  for (const club of clubs) {
    const trainer = (await c.query(`select u.id from users u join user_assignments a on a.user_id = u.id where a.club_id = $1 and a.role_code = 'trainer' limit 1`, [club.id])).rows[0]?.id ?? null;
    const big = (await c.query(`insert into rooms(tenant_id, club_id, name, capacity) values ($1,$2,'Большой зал',25) returning id`, [t, club.id])).rows[0].id;
    const small = (await c.query(`insert into rooms(tenant_id, club_id, name, capacity) values ($1,$2,'Зал персональных',3) returning id`, [t, club.id])).rows[0].id;
    const types = [];
    for (const [name, kind, dur, cap] of TYPES) {
      types.push((await c.query(`insert into class_types(tenant_id, club_id, name, kind, duration_min, capacity) values ($1,$2,$3,$4,$5,$6) returning id, kind, duration_min, capacity`, [t, club.id, name, kind, dur, cap])).rows[0]);
    }
    const members = (await c.query(`select distinct on (m.person_id) m.person_id, m.id from memberships m where m.club_id = $1 and m.status = 'active' and m.kind in ('term', 'subscription', 'visits')
      and (m.ends_on is null or m.ends_on >= current_date) order by m.person_id`, [club.id])).rows;
    const today = (await c.query(`select (now() at time zone $1)::date as d, extract(isodow from now() at time zone $1)::int as dow`, [club.timezone])).rows[0];
    for (let w = -2; w <= 1; w++) {
      for (const [dow, time, ti] of WEEK) {
        const ty = types[ti];
        const offset = w * 7 + dow - today.dow;
        const se = (await c.query(`select ($1::date + $2::int + $3::time) at time zone $4 as s, ($1::date + $2::int + $3::time + make_interval(mins => $5::int)) at time zone $4 as e`,
          [today.d, offset, time, club.timezone, ty.duration_min])).rows[0];
        const past = se.e < new Date();
        const sid = (await c.query(`insert into class_sessions(tenant_id, club_id, type_id, room_id, trainer_id, starts_at, ends_at, capacity, status, done_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [t, club.id, ty.id, ty.kind === 'personal' ? small : big, trainer, se.s, se.e, ty.capacity, past ? 'done' : 'scheduled', past ? se.e : null])).rows[0].id;
        if (ty.kind === 'personal' || !members.length) continue;
        const n = Math.min(members.length, Math.floor(ty.capacity * (0.4 + rnd() * 0.7)));
        const pool = [...members].sort(() => rnd() - 0.5).slice(0, n + 2);
        for (const [i, m] of pool.entries()) {
          const status = i >= ty.capacity ? 'waitlist' : past ? (rnd() < 0.85 ? 'attended' : 'no_show') : i < n ? 'booked' : 'cancelled';
          if (past && i >= n) continue;
          await c.query(`insert into class_bookings(tenant_id, club_id, session_id, person_id, membership_id, status, waitlist_at, reminded_24, reminded_2, created_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`, [t, club.id, sid, m.person_id, m.id, status, status === 'waitlist' ? se.s : null, past, new Date(se.s.getTime() - 3 * 864e5)]);
        }
      }
    }
  }
  await c.query(`insert into audit_log(tenant_id, actor_id, action, object_type, object_id) values ($1, null, $2, 'tenant', $3)`, [t, DEMO_SCHEDULE_MARK, String(t)]);
  return true;
}
