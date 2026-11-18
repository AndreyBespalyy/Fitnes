// Меню по ролям (решение Андрея 15.11.2026): каждая роль видит в меню только своё.
// Это только меню: права не меняются. Раздел, на который у сотрудника есть право, по-прежнему открывается
// по ссылке, из уведомления или по клику в отчёте (например, собственник из «Проблемных моментов» переходит в «Долги»).
// Если у сотрудника несколько ролей — меню объединяется. Роль, которой нет в списке, видит всё, на что есть право.
import type { Me } from './api.ts';

const ALWAYS = ['dash', 'team', 'help', 'profile'];

export const ROLE_MENU: Record<string, string[]> = {
  // Собственник: только отчёты — финансы, посещаемость, выплаты, проблемные моменты. Без операционки.
  // Тарифы и настройки клуба — отдельным блоком «Настройки» внизу меню. «Перенос из 1С» — тоже там (17.11.2026).
  // «Товары» — в «Настройки» рядом с «Тарифами»: товары добавляют собственник и управляющий (проверка CRM 17.11.2026).
  // «Проходы и турникеты» — тоже в «Настройки»: подключение СКУД PocketKey и терминалы, без экрана ресепшн (18.11.2026).
  owner: ['problems', 'finance', 'pnl', 'load', 'cohorts', 'payouts', 'weekly', 'learn', 'reviews', 'staff', 'activity', 'tariffs', 'shop', 'config', 'telephony', 'access', 'privacy', 'import', 'system', 'notes', 'usage'],
  // Управляющий: отчёты собственника по своему клубу + управление клубом. Без сетевых разделов и рабочих экранов сотрудников.
  // «Выплаты» и «Статистика сотрудников» — как у собственника, по своему клубу (проверка CRM 17.11.2026).
  gm: ['problems', 'finance', 'pnl', 'load', 'cohorts', 'payouts', 'weekly', 'learn', 'reviews', 'staff', 'activity', 'sales', 'calls', 'tasks', 'processes', 'schedule', 'home',
    'retention', 'fiscal', 'tariffs', 'shop', 'contracts', 'site', 'messaging', 'stafftime', 'config', 'telephony', 'access', 'privacy'],
  // «Настройки клуба» у РОПа — только вкладка «Продажи» и история (повторная проверка CRM 18.11.2026, п. 4)
  rop: ['tasks', 'processes', 'weekly', 'learn', 'hot', 'calls', 'sales', 'schedule', 'leads', 'board', 'chats', 'home', 'tariffs', 'shop', 'load', 'cohorts',
    'staff', 'retention', 'reviews', 'stafftime', 'config'],
  // «Компании» — вкладка «Корпоративные клиенты» в «Клиентах» (замечание №45, 18.11.2026); «Бизнес-процессы» у менеджера убраны (№35): его шаги — в «Задачах»
  // «Лиды» у менеджера убраны из меню: заявки — в «Мой день» на рабочем столе, новый лид — кнопкой «+ Лид» (повторная проверка CRM 18.11.2026, п. 14)
  manager: ['tasks', 'hot', 'calls', 'sales', 'schedule', 'board', 'chats', 'home', 'tariffs', 'shop', 'reviews', 'stafftime'],
  // «Мои задачи» у ресепшна, финансиста и тренера: им приходят шаги процессов и задачи из советов (проверка CRM 17.11.2026)
  desk: ['desk', 'tasks', 'schedule', 'leads', 'chats', 'home', 'access', 'tariffs', 'shop', 'finance', 'fiscal', 'stafftime'],
  fin: ['problems', 'tasks', 'finance', 'pnl', 'cohorts', 'payouts', 'weekly', 'home', 'import', 'staff', 'reviews', 'stafftime'],
  trainer: ['trainer', 'tasks', 'schedule', 'home', 'stafftime'],
  admin: ['clubs', 'onboarding', 'staff', 'stafftime', 'pipelines', 'intake', 'import', 'access', 'usage', 'system'],
  // Технический администратор (18.11.2026): только техническая часть — СКУД, перенос из 1С, сотрудники и роли, подключения, состояние системы
  techadmin: ['access', 'import', 'staff', 'roles', 'telephony', 'messaging', 'intake', 'system', 'stafftime'],
};

/** Показывать ли раздел в меню этой роли (право на раздел проверяется отдельно). */
export function inRoleMenu(me: Me, tab: string): boolean {
  if (ALWAYS.includes(tab)) return true;
  if (!me.roles.length) return true;
  return me.roles.some((r) => !ROLE_MENU[r.code] || ROLE_MENU[r.code].includes(tab));
}

/** Только собственник (без других ролей): тарифы уходят из «Клуба» в блок «Настройки». */
export const ownerOnly = (me: Me) => me.roles.length > 0 && me.roles.every((r) => r.code === 'owner');

/** Тренер без продаж: в меню «Мои клиенты» — только записанные к нему. */
export const trainerOnly = (me: Me) => me.roles.length > 0 && me.roles.every((r) => r.code === 'trainer');
