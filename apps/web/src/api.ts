export type Role = { code: string; name: string; club_id: string | null };
export type Me = { id: string; login: string; full_name: string; roles: Role[]; allClubs: boolean; permissions: string[]; mustChangePassword: boolean };
export type Club = { id: string; name: string; address: string | null; timezone: string; salesModel: 'term' | 'subscription'; status: string; firstResponseMinutes: number; staffCount: number; personsCount: number; isDemo?: boolean };
export type Staff = { id: string; login: string; fullName: string; phone: string | null; status: 'active' | 'blocked'; mustChangePassword: boolean;
  assignments: { role: string; roleName: string; clubId: string | null; clubName: string | null }[] };
export type RoleDef = { code: string; name: string; networkWide: boolean };
export type Person = { id: string; fullName: string; segment: string; clubId: string; clubName: string; phone: string | null };

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

/* ---------- Связь: признак «без связи», сохранённые данные и очередь действий (FR-MOB-04) ---------- */
export type NetState = { offline: boolean; savedAt: string | null; queued: number; failed: { label: string; message: string }[] };
const net: NetState = { offline: false, savedAt: null, queued: 0, failed: [] };
const listeners = new Set<(s: NetState) => void>();
const emit = () => listeners.forEach((l) => l({ ...net }));
export const netState = () => ({ ...net });
export function onNet(l: (s: NetState) => void) { listeners.add(l); return () => { listeners.delete(l); }; }

// Действия, которые можно отправить позже: отметка о выполнении задачи и новая задача
const QUEUEABLE: [RegExp, string][] = [[/^\/api\/tasks\/[^/]+\/complete$/, 'Задача выполнена'], [/^\/api\/tasks$/, 'Новая задача'], [/^\/api\/meetings\/[^/]+\/status$/, 'Итог встречи']];
type Queued = { id: string; method: string; url: string; body: unknown; label: string; at: string };
const QKEY = 'klub.queue';
const readQ = (): Queued[] => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
const writeQ = (q: Queued[]) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* хранилище недоступно */ } net.queued = q.length; emit(); };
net.queued = readQ().length;

function setOffline(offline: boolean, savedAt: string | null = null) {
  if (net.offline === offline && net.savedAt === savedAt) return;
  net.offline = offline; net.savedAt = savedAt; emit();
  if (!offline) void flushQueue();
}

let flushing = false;
export async function flushQueue() {
  if (flushing) return; flushing = true;
  try {
    let q = readQ();
    while (q.length) {
      const item = q[0];
      let res: Response;
      try {
        res = await fetch(item.url, { method: item.method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) });
      } catch { setOffline(true, net.savedAt); return; }
      if (!res.ok && res.status !== 401) {
        const d = await res.json().catch(() => ({}));
        net.failed = [...net.failed, { label: item.label, message: d.message ?? 'Сервер не принял действие' }];
      }
      if (res.status === 401) return; // войдите заново: очередь сохранится
      q = readQ().filter((x) => x.id !== item.id); writeQ(q);
    }
  } finally { flushing = false; }
}
export const clearFailed = () => { net.failed = []; emit(); };
export function clearDeviceData() {
  writeQ([]);
  navigator.serviceWorker?.controller?.postMessage('clear');
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOffline(false));
  window.addEventListener('offline', () => setOffline(true, net.savedAt));
}

/** Последние сбои на экране для «Сообщить о проблеме»: без тел запросов и без параметров адреса */
export type TechEntry = { at: string; kind: 'api' | 'js' | 'offline'; text: string };
const tech: TechEntry[] = [];
export const noteTech = (kind: TechEntry['kind'], text: string) => { tech.push({ at: new Date().toISOString(), kind, text: text.slice(0, 300) }); if (tech.length > 30) tech.shift(); };
export const techLog = () => [...tech];
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => noteTech('js', `${e.message} (${String(e.filename ?? '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason as { message?: string } | undefined; if (!(r instanceof ApiError)) noteTech('js', String(r?.message ?? r)); });
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const path = url.split('?')[0];
  const q = method === 'POST' ? QUEUEABLE.find(([r]) => r.test(path)) : undefined;
  let res: Response;
  try {
    if (q && typeof navigator !== 'undefined' && navigator.onLine === false) throw new TypeError('offline');
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setOffline(true, net.savedAt);
    if (q) {
      writeQ([...readQ(), { id: `${Date.now()}-${Math.random()}`, method, url, body, label: q[1], at: new Date().toISOString() }]);
      return { ok: true, queued: true } as T;
    }
    noteTech('offline', `${method} ${url.split('?')[0]}`);
    throw new ApiError(0, 'offline', 'Нет связи с сервером');
  }
  if (res.headers.get('X-Offline')) setOffline(true, res.headers.get('X-Saved-At'));
  else setOffline(false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!url.startsWith('/api/usage')) noteTech('api', `${method} ${url.split('?')[0]} → ${res.status} ${data.error ?? ''}: ${data.message ?? ''}`);
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Ошибка связи с сервером');
  }
  return data as T;
}

export const MODEL: Record<string, string> = { term: 'Абонементы на срок', subscription: 'Подписка (ежемесячное списание)' };
export const MODEL_SHORT: Record<string, string> = { term: 'абонементы', subscription: 'подписка' };
export const can = (me: Me, p: string) => me.permissions.includes('*') || me.permissions.includes(p);

/* ---------- Переходы с рабочего стола: раздел + фильтр, который раздел применит при открытии ---------- */
export type Go = { tab: string; p?: Record<string, string> };
let navIntent: Go | null = null;
export const setNavIntent = (g: Go | null) => { navIntent = g; };
/** Параметры перехода для раздела (или пустой объект). Читать в начальном значении состояния раздела */
export const navParams = (tab: string): Record<string, string> => (navIntent?.tab === tab ? navIntent.p ?? {} : {});
