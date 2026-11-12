// Мессенджер сотрудников: служебный файл приложения на телефоне (отдельно от приложения CRM, своя область /team/).
// 1) Приложение открывается быстро и без связи показывает экран (переписка подгрузится, когда появится интернет).
// 2) Push-уведомления о новых сообщениях; нажатие открывает нужный чат.
const SHELL = 'team-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(['/team/', '/team/manifest.webmanifest', '/team/icon-192.png', '/team/badge-96.png']);
    const html = await (await c.match('/team/')).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    if (assets.length) await c.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('team-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/assets/') || /^\/team\/[\w-]+\.(png|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const c = res.clone(); caches.open(SHELL).then((s) => s.put(req, c)); } return res; })));
    return;
  }
  if (req.mode === 'navigate' && url.pathname.startsWith('/team')) {
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const c = res.clone(); caches.open(SHELL).then((s) => s.put('/team/', c)); } return res; })
      .catch(() => caches.match('/team/', { cacheName: SHELL })));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Мессенджер', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // Чат уже открыт на экране — не дублируем уведомлением
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = d.url ? new URL(d.url, self.location.origin) : null;
    const chat = target && target.searchParams.get('chat');
    if (chat && wins.some((w) => w.visibilityState === 'visible' && w.focused && new URL(w.url).searchParams.get('chat') === chat)) return;
    await self.registration.showNotification(d.title || 'Мессенджер', {
      body: d.body || '', tag: d.tag, renotify: !!d.tag, icon: '/team/icon-192.png', badge: '/team/badge-96.png', data: { url: d.url || '/team/' }, lang: 'ru',
    });
    if (self.navigator && 'setAppBadge' in self.navigator) { try { await self.navigator.setAppBadge(); } catch { /* значок на иконке не поддерживается */ } }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/team/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      const u = new URL(c.url);
      if (u.origin === self.location.origin && u.pathname.startsWith('/team')) { await c.focus(); c.postMessage({ type: 'open', url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
