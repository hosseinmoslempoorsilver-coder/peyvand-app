// سرویس‌ورکر ساده — فقط برای قابل‌نصب شدن اپ روی صفحه‌ی اصلی گوشی
self.addEventListener("install", function (e) {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  self.clients.claim();
});
self.addEventListener("fetch", function (e) {
  e.respondWith(fetch(e.request).catch(function () {
    return new Response("آفلاین هستید", { status: 503 });
  }));
});
