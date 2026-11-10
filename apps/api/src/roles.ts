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
} as const;

const P = PERMISSIONS;
export const ROLE_SEED = [
  { code: 'owner', name: 'Собственник', network_wide: true, sort: 1, permissions: ['*'] },
  { code: 'admin', name: 'Администратор системы', network_wide: true, sort: 2,
    permissions: [P.clubsView, P.clubsManage, P.staffView, P.staffManage, P.personsView, P.crmViewAll, P.pipelinesManage, P.sourcesManage] },
  { code: 'gm', name: 'Управляющий', network_wide: false, sort: 3,
    permissions: [P.clubsView, P.staffView, P.personsView, P.approvalsDecide, P.leadsCreate, P.crmWork, P.crmViewAll] },
  { code: 'rop', name: 'Руководитель ОП', network_wide: false, sort: 4, permissions: [P.clubsView, P.staffView, P.personsView, P.leadsCreate, P.crmWork, P.crmViewAll] },
  { code: 'manager', name: 'Менеджер ОП', network_wide: false, sort: 5, permissions: [P.clubsView, P.personsView, P.leadsCreate, P.crmWork] },
  { code: 'desk', name: 'Администратор ресепшн', network_wide: false, sort: 6, permissions: [P.clubsView, P.personsView, P.leadsCreate] },
  { code: 'fin', name: 'Финансист', network_wide: false, sort: 7, permissions: [P.clubsView, P.personsView] },
  { code: 'trainer', name: 'Тренер', network_wide: false, sort: 8, permissions: [P.clubsView] },
];
