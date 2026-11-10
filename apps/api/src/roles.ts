// Роли и разрешения. Хранятся в БД (таблица roles), здесь — исходный набор для заполнения.
export const PERMISSIONS = {
  clubsView: 'clubs.view',
  clubsManage: 'clubs.manage',
  staffView: 'staff.view',
  staffManage: 'staff.manage',
  personsView: 'persons.view',
  approvalsDecide: 'approvals.decide',
} as const;

const P = PERMISSIONS;
export const ROLE_SEED = [
  { code: 'owner', name: 'Собственник', network_wide: true, sort: 1, permissions: ['*'] },
  { code: 'admin', name: 'Администратор системы', network_wide: true, sort: 2,
    permissions: [P.clubsView, P.clubsManage, P.staffView, P.staffManage, P.personsView] },
  { code: 'gm', name: 'Управляющий', network_wide: false, sort: 3,
    permissions: [P.clubsView, P.staffView, P.personsView, P.approvalsDecide] },
  { code: 'rop', name: 'Руководитель ОП', network_wide: false, sort: 4, permissions: [P.clubsView, P.staffView, P.personsView] },
  { code: 'manager', name: 'Менеджер ОП', network_wide: false, sort: 5, permissions: [P.clubsView, P.personsView] },
  { code: 'desk', name: 'Администратор ресепшн', network_wide: false, sort: 6, permissions: [P.clubsView, P.personsView] },
  { code: 'fin', name: 'Финансист', network_wide: false, sort: 7, permissions: [P.clubsView, P.personsView] },
  { code: 'trainer', name: 'Тренер', network_wide: false, sort: 8, permissions: [P.clubsView] },
];
