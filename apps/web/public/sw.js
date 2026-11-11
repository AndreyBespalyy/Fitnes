// Клубная ОС: служебный файл приложения на телефоне.
// 1) Приложение открывается без связи: оболочка и последние загруженные данные хранятся на устройстве.
// 2) Push-уведомления о задачах, лидах и сообщениях.
// Данные удаляются с устройства при выходе из системы.
const SHELL = 'shell-v2';
const API = 'api-v1';
const NO_CACHE = [/^\/api\/auth\/(?!me$)/, /^\/api\/push\//, /\/audio$/, /\/pdf$/, /\/file/, /export/, /\/api\/me\/sessions/, /\/api\/health/, /^\/api\/team\//];

self.addEventListener('install', (e) => {
  // Сохраняем страницу и её файлы, чтобы приложение открывалось без связи
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png']);
    const html = await (await c.match('/')).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    if (assets.length) await c.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear') e.waitUntil(caches.delete(API));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') return;
  // Мессенджер (/team/) — отдельное приложение со своим служебным файлом
  if (url.pathname === '/team' || url.pathname.startsWith('/team/') || url.pathname.startsWith('/m/')) return;

  // Данные: сначала сервер, при отсутствии связи — сохранённая копия с пометкой времени
  if (url.pathname.startsWith('/api/')) {
    if (NO_CACHE.some((r) => r.test(url.pathname))) return;
    e.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req), timeout(8000)]);
        if (res.ok) {
          const copy = res.clone();
          const body = await copy.blob();
          const headers = new Headers(copy.headers); headers.set('X-Saved-At', new Date().toISOString());
          caches.open(API).then((c) => c.put(req, new Response(body, { status: 200, headers })));
        } else if (res.status === 401) {
          caches.delete(API);
        }
        return res;
      } catch {
        const hit = await caches.match(req, { cacheName: API });
        if (hit) { const h = new Headers(hit.headers); h.set('X-Offline', '1'); return new Response(await hit.blob(), { status: 200, headers: h }); }
        return new Response(JSON.stringify({ error: 'offline', message: 'Нет связи с сервером, а сохранённых данных для этого раздела нет' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Offline': '1' } });
      }
    })());
    return;
  }

  // Файлы приложения с хешем в имени не меняются: берём с устройства
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const c = res.clone(); caches.open(SHELL).then((s) => s.put(req, c)); } return res; })));
    return;
  }

  // Страница: сначала сервер (чтобы обновления приходили сразу), без связи — сохранённая
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const c = res.clone(); caches.open(SHELL).then((s) => s.put('/', c)); return res; })
      .catch(() => caches.match('/', { cacheName: SHELL })));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Клубная ОС', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Клубная ОС', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: d.url || '/' }, lang: 'ru',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); c.postMessage({ type: 'open', url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
