// Статистика сотрудников для собственника (17.11.2026): за последние сутки по каждой роли —
// кто заходил в систему, что делал (открытые разделы и действия) и какие оставил замечания и пожелания.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx } from '../auth.ts';
import { withCtx } from '../db.ts';
import { forbidden } from '../errors.ts';

// Действия из журнала: сначала точное название, иначе «раздел — глагол»
const ACTION: Record<string, string> = {
  'auth.login': 'Вход в систему', 'auth.failed': 'Неверный пароль при входе', 'auth.locked': 'Вход заблокирован после неверных паролей',
  'auth.password_changed': 'Сменил пароль', 'auth.must_change_forced': 'Система попросила сменить пароль', 'auth.session_revoked': 'Вышел на другом устройстве',
  'auth.sessions_revoked_others': 'Завершил сеансы на других устройствах',
  'lead.taken': 'Взял заявку в работу', 'task.created': 'Поставил задачу', 'task.completed': 'Выполнил задачу',
  'opportunity.stage_changed': 'Перевёл сделку на другой этап', 'opportunity.owner_changed': 'Сменил ответственного по сделке', 'opportunity.won_unpaid': 'Сделка выиграна, оплаты ещё нет',
  'meeting.created': 'Назначил встречу', 'meeting.status': 'Отметил встречу', 'person.dial': 'Позвонил клиенту', 'person.merged': 'Объединил дубли клиента',
  'person.call_block': 'Добавил в стоп-лист обзвона', 'person.call_unblock': 'Убрал из стоп-листа обзвона', 'person.autopay_changed': 'Изменил автосписание',
  'person.photo_set': 'Загрузил фото клиента', 'person.messaging_changed': 'Изменил согласие на рассылки', 'person.card_removed': 'Удалил карту клиента',
  'call.registered': 'Записан звонок', 'call.summary_saved': 'Сохранил итог разговора', 'call.evaluated': 'Оценил звонок', 'call.linked': 'Привязал звонок к клиенту',
  'membership.frozen': 'Заморозил абонемент', 'membership.unfrozen': 'Разморозил абонемент', 'membership.cancelled': 'Отменил абонемент',
  'membership.seat_added': 'Добавил человека в семейный абонемент', 'membership.seat_removed': 'Убрал человека из семейного абонемента',
  'contract.created': 'Создан договор', 'contract.signed': 'Подписан договор', 'contract.sms_link_sent': 'Отправил договор на подпись по СМС',
  'charge.marked_paid': 'Отметил оплату', 'charge.paid_deposit': 'Оплата с депозита', 'charge.pay_link': 'Отправил ссылку на оплату',
  'refund.requested': 'Запросил возврат', 'refund.paid': 'Выплатил возврат', 'deposit.topup': 'Пополнил депозит', 'deposit.refund': 'Вернул депозит',
  'goods.sold': 'Продал товар', 'goods.sale_cancelled': 'Отменил продажу товара', 'gift.sold': 'Продал сертификат', 'gift.redeemed': 'Погасил сертификат',
  'shift.opened': 'Открыл кассовую смену', 'shift.closed': 'Закрыл кассовую смену', 'expense.created': 'Внёс расход', 'receipt.manual': 'Пробил чек вручную',
  'desk.renew': 'Продлил абонемент на ресепшне', 'desk.single': 'Продал разовое посещение', 'access.manual_pass': 'Пропустил клиента вручную',
  'class.booked': 'Записал клиента на занятие', 'class.booking_cancelled': 'Отменил запись на занятие', 'class.done': 'Отметил проведённое занятие',
  'class.cancelled': 'Отменил занятие', 'class.updated': 'Изменил занятие', 'trainer.offer': 'Предложил клиенту продление',
  'schedule.sessions_created': 'Добавил занятия в расписание', 'plan.changed': 'Изменил план продаж', 'kpi.norms_changed': 'Изменил нормы KPI',
  'staff.created': 'Добавил сотрудника', 'staff.password_reset': 'Выдал сотруднику временный пароль', 'staff.blocked': 'Заблокировал сотрудника',
  'staff.shifts_created': 'Поставил смены в график', 'payroll.calculated': 'Рассчитал зарплату', 'payroll.approved': 'Утвердил зарплату',
  'process.started': 'Запустил бизнес-процесс', 'team.announcement': 'Отправил объявление команде', 'report.exported': 'Выгрузил отчёт',
  'support.created': 'Написал в поддержку', 'recommendation.created': 'Дал рекомендацию сотруднику', 'agent.task_snoozed': 'Отложил задачу от ИИ-помощника',
  'referral.link_sent': 'Отправил ссылку «Приведи друга»', 'retention.launched': 'Запустил кампанию возврата клиентов', 'push.subscribed': 'Включил уведомления на телефоне',
};
const AREA: Record<string, string> = {
  access: 'Проходы', agent: 'Дядя Витя', ai: 'ИИ', bank: 'Сверка с банком', call: 'Звонки', charge: 'Оплаты', churn: 'Риск ухода', class: 'Расписание',
  club: 'Клуб', company: 'Компании', config: 'Настройки клуба', contract: 'Договоры', dash: 'Рабочий стол', deposit: 'Депозит', desk: 'Ресепшн',
  expense: 'Расходы', family: 'Семейный абонемент', finance: 'Финансы', gift: 'Сертификаты', goods: 'Товары', import: 'Перенос из 1С', intake: 'Приём заявок',
  kpi: 'Нормы KPI', lead: 'Лиды', lead_source: 'Источники заявок', loyalty: 'Бонусы', meeting: 'Встречи', membership: 'Абонементы', msg_channel: 'Каналы переписки',
  msg_settings: 'Сообщения', msg_template: 'Шаблоны сообщений', msg_trigger: 'Автосообщения', newbie: 'Новички', onboarding: 'Подключение клуба',
  online_buy: 'Покупка онлайн', opportunity: 'Сделки', payroll: 'Зарплата', pd: 'Персональные данные', person: 'Клиент', pipeline: 'Воронки', plan: 'План продаж',
  pnl: 'Прибыль', privacy: 'Защита данных', process: 'Бизнес-процессы', product: 'Тарифы', promo: 'Акции', push: 'Уведомления', receipt: 'Чеки',
  recommendation: 'Рекомендации', referral: 'Приведи друга', refund: 'Возвраты', report: 'Отчёты', retention: 'Возврат клиентов', sales_ops: 'Отдел продаж',
  schedule: 'Расписание', security: 'Безопасность', shift: 'Касса', site_offer: 'Сайт', sms: 'СМС', staff: 'Сотрудники', staff_bot: 'Бот сотрудников',
  support: 'Поддержка', surveys: 'Опросы', system: 'Система', task: 'Задачи', team: 'Мессенджер', test_notes: 'Журнал замечаний', trainer: 'Тренер',
};
const VERB: Record<string, string> = {
  created: 'создал', updated: 'изменил', changed: 'изменил', settings: 'изменил настройки', settings_changed: 'изменил настройки', cancelled: 'отменил',
  deleted: 'удалил', removed: 'удалил', added: 'добавил', approved: 'утвердил', published: 'опубликовал', rejected: 'отклонил', uploaded: 'загрузил', sent: 'отправил',
};
export function actionLabel(action: string) {
  if (ACTION[action]) return ACTION[action];
  const [area, ...rest] = action.split('.');
  const tail = rest.join('.');
  const verb = VERB[tail] ?? VERB[tail.split('_').slice(-2).join('_')] ?? VERB[tail.split('_').pop() ?? ''] ?? tail.replace(/_/g, ' ');
  return `${AREA[area] ?? area}: ${verb}`;
}

const KIND: Record<string, string> = { bug: 'Ошибка', ux: 'Неудобно', idea: 'Пожелание', question: 'Вопрос', access: 'Доступ' };

export function activityRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/activity', async (req) => {
    const ctx = requireCtx(req);
    // Собственник — вся сеть; управляющий — сотрудники своего клуба (проверка CRM 17.11.2026, п. 6)
    const gm = !ctx.allClubs && ctx.roles.includes('gm');
    if (!(can(ctx, '*') && ctx.allClubs) && !gm) throw forbidden('Статистику сотрудников видят собственник и управляющий');
    const onlyClubs = gm ? ctx.clubIds : null;
    const hours = [24, 72, 168].includes(Number((req.query as { hours?: string }).hours)) ? Number((req.query as { hours?: string }).hours) : 24;
    return withCtx(pool, ctx, async (db) => {
      const since = (await db.query(`select now() - make_interval(hours => $1) as since, now() as till`, [hours])).rows[0];
      // Сотрудник показывается в своей главной роли (первой по порядку ролей)
      const staff = (await db.query(`select distinct on (u.id) u.id, u.full_name as "fullName", r.code as role, r.name as "roleName", r.sort,
          (select string_agg(distinct c.name, ', ') from user_assignments a2 join clubs c on c.id = a2.club_id where a2.user_id = u.id) as clubs
        from users u join user_assignments a on a.user_id = u.id join roles r on r.code = a.role_code
        where u.status = 'active' and not u.is_bot
          and ($1::uuid[] is null or (exists (select 1 from user_assignments a3 where a3.user_id = u.id and a3.club_id = any($1))
            and not exists (select 1 from user_assignments a4 where a4.user_id = u.id and a4.club_id is null)))
        order by u.id, r.sort`, [onlyClubs])).rows;
      const roles = (await db.query(`select code, name from roles order by sort`)).rows as { code: string; name: string }[];
      const ids = staff.map((s) => s.id);
      const q = async (sql: string) => (await db.query(sql, [ids, since.since])).rows;
      const logins = await q(`select object_id::uuid as "userId", at, action, ip from audit_log
        where action in ('auth.login', 'auth.failed', 'auth.locked') and object_type = 'user' and object_id = any($1::text[]) and at >= $2 order by at`);
      const devices = await q(`select user_id as "userId", device, created_at as at from sessions where user_id = any($1) and created_at >= $2`);
      const seen = await q(`select user_id as "userId", max(last_seen_at) as at from sessions where user_id = any($1) and last_seen_at >= $2 group by user_id`);
      const views = await q(`select user_id as "userId", at, tab, label from usage_events where user_id = any($1) and at >= $2 order by at`);
      const actions = await q(`select l.actor_id as "userId", l.at, l.action, l.object_type as "objectType",
          case when l.object_type = 'person' and l.object_id ~ '^[0-9a-f-]{36}$' then (select p.full_name from persons p where p.id = l.object_id::uuid)
               when l.object_type = 'opportunity' and l.object_id ~ '^[0-9a-f-]{36}$' then (select p.full_name from opportunities o join persons p on p.id = o.person_id where o.id = l.object_id::uuid)
               when l.object_type = 'task' and l.object_id ~ '^[0-9a-f-]{36}$' then (select t.title from tasks t where t.id = l.object_id::uuid) end as object
        from audit_log l where l.actor_id = any($1) and l.at >= $2 and l.action not in ('auth.login', 'auth.failed', 'auth.locked') order by l.at`);
      const notes = await q(`select user_id as "userId", number, created_at as at, kind, page_label as page, body, status,
          shot_path is not null as "hasShot" from test_notes where user_id = any($1) and created_at >= $2 order by created_at`);
      const tickets = await q(`select author_id as "userId", number, created_at as at, kind, page, subject as body, status
        from support_tickets where author_id = any($1) and created_at >= $2 order by created_at`);
      const by = <T extends { userId: string }>(rows: T[], id: string) => rows.filter((r) => r.userId === id);
      const people = staff.map((s) => {
        const lg = by(logins, s.id); const v = by(views, s.id); const a = by(actions, s.id);
        const n = [...by(notes, s.id).map((x) => ({ ...x, source: 'note', kindLabel: KIND[x.kind] ?? 'Замечание' })),
          ...by(tickets, s.id).map((x) => ({ ...x, source: 'support', kindLabel: `Поддержка: ${KIND[x.kind] ?? 'обращение'}` }))]
          .sort((x, y) => +new Date(x.at) - +new Date(y.at));
        const times = [...lg.filter((x) => x.action === 'auth.login').map((x) => x.at), ...v.map((x) => x.at), ...a.map((x) => x.at), ...by(seen, s.id).map((x) => x.at)]
          .filter(Boolean).map((x) => new Date(x).getTime());
        return {
          id: s.id, fullName: s.fullName, role: s.role, roleName: s.roleName, clubs: s.clubs,
          active: times.length > 0, firstAt: times.length ? new Date(Math.min(...times)) : null, lastAt: times.length ? new Date(Math.max(...times)) : null,
          logins: lg.filter((x) => x.action === 'auth.login').map((x) => ({ at: x.at, device: by(devices, s.id).find((d) => Math.abs(+new Date(d.at) - +new Date(x.at)) < 5000)?.device ?? null })),
          failed: lg.filter((x) => x.action !== 'auth.login').length,
          views: v.map((x) => ({ at: x.at, tab: x.tab, label: x.label })),
          actions: a.map((x) => ({ at: x.at, action: x.action, label: actionLabel(x.action), object: x.object ?? null })),
          notes: n,
        };
      });
      return {
        hours, since: since.since, till: since.till,
        roles: roles.filter((r) => people.some((p) => p.role === r.code)).map((r) => {
          const list = people.filter((p) => p.role === r.code);
          return { code: r.code, name: r.name, staff: list.length, active: list.filter((p) => p.active).length,
            actions: list.reduce((x, p) => x + p.actions.length, 0), notes: list.reduce((x, p) => x + p.notes.length, 0), people: list };
        }),
      };
    });
  });
}
