export type Role = { code: string; name: string; club_id: string | null };
export type Me = { id: string; login: string; full_name: string; roles: Role[]; allClubs: boolean; permissions: string[]; mustChangePassword: boolean };
export type Club = { id: string; name: string; address: string | null; timezone: string; salesModel: 'term' | 'subscription'; status: string; staffCount: number; personsCount: number };
export type Staff = { id: string; login: string; fullName: string; phone: string | null; status: 'active' | 'blocked'; mustChangePassword: boolean;
  assignments: { role: string; roleName: string; clubId: string | null; clubName: string | null }[] };
export type RoleDef = { code: string; name: string; networkWide: boolean };
export type Person = { id: string; fullName: string; segment: string; clubId: string; clubName: string; phone: string | null };

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Ошибка связи с сервером');
  return data as T;
}

export const MODEL: Record<string, string> = { term: 'Абонементы на срок', subscription: 'Подписка (ежемесячное списание)' };
export const MODEL_SHORT: Record<string, string> = { term: 'абонементы', subscription: 'подписка' };
export const can = (me: Me, p: string) => me.permissions.includes('*') || me.permissions.includes(p);
