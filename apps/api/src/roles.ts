// Роли и разрешения. Хранятся в БД (таблица roles), здесь — исходный набор для заполнения.
export const PERMISSIONS = {
  clubsView: 'clubs.view',
  clubsManage: 'clubs.manage',
  staffView: 'staff.view',
  staffManage: 'staff.manage',
  personsView: 'persons.view',
  approvalsDecide: 'approvals.decide',
  leadsCreate: 'leads.create',
  crmWork: 'crm.work',
  crmViewAll: 'crm.view_all',
  pipelinesManage: 'pipelines.manage',
  sourcesManage: 'sources.manage',
  tariffsManage: 'tariffs.manage',
  membershipsSell: 'memberships.sell',
  membershipsManage: 'memberships.manage',
  membershipsView: 'memberships.view',
  contractsManage: 'contracts.manage', // юрлицо клуба, PDF договора и правил
  contractsSign: 'contracts.sign',     // печать, скан, подписание на планшете
  siteManage: 'site.manage',           // предложения клуба для сайта
  fiscalManage: 'fiscal.manage',       // касса клуба и банк эквайринга
  shiftsWork: 'shifts.work',           // открытие и закрытие кассовой смены
  financeWork: 'finance.work',         // расходы, план продаж
  financeView: 'finance.view',         // журнал платежей, долги, ДДС, план-факт
  importManage: 'import.manage',       // перенос данных из 1С
  messagesWork: 'messages.work',       // переписка с клиентами
  messagesManage: 'messages.manage',   // каналы, шаблоны, автосообщения
  acsWork: 'acs.work',                 // ресепшн: проходы, ручной проход, выдача карт
  acsManage: 'acs.manage',             // турникеты, шлюзы, правила прохода, отчёт
  dashView: 'dash.view',               // дашборды клуба: план-факт, конверсия, KPI сотрудников
  planManage: 'plan.manage',           // план продаж клуба и менеджеров, нормы KPI, стандартные рабочие столы ролей
  aiReview: 'ai.review',               // оценка резюме звонков, качество ИИ, звонки всего отдела
  staffSchedule: 'staff.schedule',     // графики смен, замены, отпуска, исправления табеля
  payrollManage: 'payroll.manage',     // схемы оплаты, расчётная ведомость, утверждение
  configManage: 'config.manage',       // черновики настроек клуба, ИИ-помощник настройки, проверка на истории
  configApprove: 'config.approve',     // утверждение, публикация и откат версий настроек
  scheduleManage: 'schedule.manage',   // залы, виды занятий, расписание, отмена занятий, правила записи
  scheduleBook: 'schedule.book',       // запись клиентов на занятия, отметка посещения своих занятий
  retentionManage: 'retention.manage', // возврат бывших клиентов, досрочное продление, опросы клиентов
  supportAnswer: 'support.answer',     // все обращения сети в поддержку, ответы, передача разработчикам
  dataProtect: 'data.protect',         // защита базы клиентов: пороги, согласование выгрузок, сигналы; согласия и обращения по 152-ФЗ
  systemMonitor: 'system.monitor',     // состояние системы: проверки, оповещения о сбоях
  salesManage: 'sales.manage',         // правила отдела продаж в своём клубе: план менеджеров, нормы KPI, сроки и сигналы, скрипты звонков (РОП)
  rolesManage: 'roles.manage',         // свои роли сети: создание, состав прав (не шире своих), удаление неиспользуемых
  integrationsManage: 'integrations.manage', // технические подключения: телефония, каналы мессенджеров, СМС, приём заявок
} as const;

const P = PERMISSIONS;
export const ROLE_SEED = [
  { code: 'owner', name: 'Собственник', network_wide: true, sort: 1, permissions: ['*'] },
  { code: 'admin', name: 'Администратор системы', network_wide: true, sort: 2,
    permissions: [P.clubsView, P.clubsManage, P.staffView, P.staffManage, P.personsView, P.crmViewAll, P.pipelinesManage, P.sourcesManage, P.membershipsView, P.importManage, P.acsManage, P.supportAnswer, P.systemMonitor] },
  // Технический администратор (18.11.2026): настройка и обслуживание системы — СКУД и проходы, перенос из 1С, учётные записи
  // сотрудников, свои роли, телефония и другие подключения, состояние системы. Финансов и клиентов не видит: в переносе из 1С —
  // только счётчики и ошибки без ФИО и сумм, в журналах подключений — без имён клиентов.
  { code: 'techadmin', name: 'Технический администратор', network_wide: true, sort: 3,
    permissions: [P.clubsView, P.staffView, P.staffManage, P.importManage, P.acsManage, P.systemMonitor, P.rolesManage, P.integrationsManage, P.supportAnswer] },
  // Управляющий: всё, что собственник, но только в своём клубе (решение Андрея 10.11.2026).
  // Сетевые действия (создание клубов, общие источники лидов, сетевые роли) проверяются отдельно по ctx.allClubs.
  { code: 'gm', name: 'Управляющий', network_wide: false, sort: 4,
    permissions: Object.values(P).filter((p) => p !== P.sourcesManage && p !== P.supportAnswer && p !== P.systemMonitor && p !== P.rolesManage) },
  // РОП: правила своего отдела (план менеджеров, нормы KPI, сроки и сигналы, скрипты) — sales.manage; общий план клуба и
  // настройки клуба — у управляющего (проверка CRM 17.11.2026, п. 5). Черновиков настроек клуба у РОПа нет.
  { code: 'rop', name: 'Руководитель ОП', network_wide: false, sort: 5, permissions: [P.dashView, P.aiReview, P.clubsView, P.staffView, P.personsView, P.leadsCreate, P.crmWork, P.crmViewAll, P.membershipsSell, P.membershipsView, P.contractsSign, P.messagesWork, P.salesManage, P.scheduleBook, P.retentionManage] },
  { code: 'manager', name: 'Менеджер ОП', network_wide: false, sort: 6, permissions: [P.clubsView, P.personsView, P.leadsCreate, P.crmWork, P.membershipsSell, P.membershipsView, P.contractsSign, P.messagesWork, P.scheduleBook] },
  { code: 'desk', name: 'Администратор ресепшн', network_wide: false, sort: 7, permissions: [P.clubsView, P.personsView, P.leadsCreate, P.membershipsSell, P.membershipsView, P.membershipsManage, P.contractsSign, P.shiftsWork, P.messagesWork, P.acsWork, P.scheduleBook] },
  { code: 'fin', name: 'Финансист', network_wide: false, sort: 8, permissions: [P.dashView, P.clubsView, P.personsView, P.membershipsView, P.financeWork, P.financeView, P.importManage, P.payrollManage, P.staffView] },
  { code: 'trainer', name: 'Тренер', network_wide: false, sort: 9, permissions: [P.clubsView, P.membershipsView, P.personsView, P.scheduleBook] },
];

/** Права, открывающие клиентов и деньги. Встроенную роль с таким правом может выдать только тот, у кого это право есть сам. */
export const SENSITIVE_PERMISSIONS: readonly string[] = [P.personsView, P.crmViewAll, P.membershipsView, P.financeView, P.financeWork, P.payrollManage,
  P.dashView, P.aiReview, P.dataProtect];

/** Названия прав для конструктора ролей (раздел «Роли»). */
export const PERMISSION_LABELS: Record<string, string> = {
  [P.clubsView]: 'Видеть список клубов', [P.clubsManage]: 'Карточки клубов и подключение новых', [P.staffView]: 'Видеть сотрудников',
  [P.staffManage]: 'Учётные записи сотрудников', [P.personsView]: 'Клиенты: карточки и поиск', [P.approvalsDecide]: 'Согласования (скидки, возвраты)',
  [P.leadsCreate]: 'Создавать заявки', [P.crmWork]: 'Работа с заявками и сделками', [P.crmViewAll]: 'Все заявки и сделки клуба',
  [P.pipelinesManage]: 'Этапы воронок', [P.sourcesManage]: 'Источники заявок', [P.tariffsManage]: 'Тарифы и прейскурант',
  [P.membershipsSell]: 'Продажа абонементов', [P.membershipsManage]: 'Заморозки, переоформления, возвраты', [P.membershipsView]: 'Видеть абонементы и чеки',
  [P.contractsManage]: 'Юрлицо, шаблоны договоров', [P.contractsSign]: 'Подписание договоров', [P.siteManage]: 'Предложения на сайте',
  [P.fiscalManage]: 'Касса и эквайринг', [P.shiftsWork]: 'Кассовые смены', [P.financeWork]: 'Расходы и план продаж', [P.financeView]: 'Финансы: платежи, долги, ДДС',
  [P.importManage]: 'Перенос из 1С', [P.messagesWork]: 'Переписка с клиентами', [P.messagesManage]: 'Шаблоны и автосообщения',
  [P.acsWork]: 'Ресепшн: проходы и карты', [P.acsManage]: 'СКУД: турникеты, PocketKey, правила прохода', [P.dashView]: 'Отчёты и показатели клуба',
  [P.planManage]: 'План продаж и нормы KPI', [P.aiReview]: 'Разборы звонков', [P.staffSchedule]: 'Графики смен и табель',
  [P.payrollManage]: 'Зарплата и выплаты', [P.configManage]: 'Черновики настроек клуба', [P.configApprove]: 'Утверждение настроек клуба',
  [P.scheduleManage]: 'Расписание: залы и занятия', [P.scheduleBook]: 'Запись клиентов на занятия', [P.retentionManage]: 'Возврат клиентов и опросы',
  [P.supportAnswer]: 'Обращения в поддержку', [P.dataProtect]: 'Защита данных клиентов (152-ФЗ)', [P.systemMonitor]: 'Состояние системы и сбои',
  [P.salesManage]: 'Правила отдела продаж', [P.rolesManage]: 'Свои роли', [P.integrationsManage]: 'Подключения: телефония, мессенджеры, СМС, заявки',
};
