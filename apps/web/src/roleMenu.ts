// Меню по ролям (решение Андрея 15.11.2026): каждая роль видит в меню только своё.
// Это только меню: права не меняются. Раздел, на который у сотрудника есть право, по-прежнему открывается
// по ссылке, из уведомления или по клику в отчёте (например, собственник из «Проблемных моментов» переходит в «Долги»).
// Если у сотрудника несколько ролей — меню объединяется. Роль, которой нет в списке, видит всё, на что есть право.
import type { Me } from './api.ts';

const ALWAYS = ['dash', 'team', 'help', 'profile'];

export const ROLE_MENU: Record<string, string[]> = {
  // Собственник: только отчёты — финансы, посещаемость, выплаты, проблемные моменты. Без операционки.
  // Тарифы и настройки клуба — отдельным блоком «Настройки» внизу меню.
  owner: ['problems', 'finance', 'pnl', 'load', 'cohorts', 'payouts', 'weekly', 'reviews', 'staff', 'tariffs', 'config', 'privacy', 'system', 'notes', 'usage'],
  // Управляющий: отчёты собственника по своему клубу + управление клубом. Без сетевых разделов и рабочих экранов сотрудников.
  gm: ['problems', 'finance', 'pnl', 'load', 'cohorts', 'weekly', 'reviews', 'staff', 'sales', 'calls', 'tasks', 'processes', 'schedule', 'home',
    'retention', 'fiscal', 'tariffs', 'shop', 'contracts', 'site', 'messaging', 'stafftime', 'config', 'corp', 'access', 'privacy'],
  rop: ['tasks', 'processes', 'weekly', 'hot', 'calls', 'sales', 'schedule', 'leads', 'board', 'chats', 'home', 'tariffs', 'shop', 'corp', 'load', 'cohorts',
    'staff', 'retention', 'reviews', 'stafftime'],
  manager: ['tasks', 'processes', 'hot', 'calls', 'sales', 'schedule', 'leads', 'board', 'chats', 'home', 'tariffs', 'shop', 'corp', 'reviews', 'stafftime'],
  desk: ['desk', 'schedule', 'leads', 'chats', 'home', 'access', 'tariffs', 'shop', 'finance', 'fiscal', 'stafftime'],
  fin: ['problems', 'finance', 'pnl', 'cohorts', 'payouts', 'weekly', 'home', 'corp', 'import', 'staff', 'reviews', 'stafftime'],
  trainer: ['trainer', 'schedule', 'home', 'stafftime'],
  admin: ['clubs', 'onboarding', 'staff', 'stafftime', 'pipelines', 'intake', 'import', 'access', 'usage', 'system'],
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
