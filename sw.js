// ゆるスケ service worker — ネットワーク優先＋キャッシュフォールバック。
// 更新は常にネット側を採り、オフライン時だけ最後に取れた版で開けるようにする。
const CACHE = "yuru-suke-v1";
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // Gemini API(POST)はキャッシュしない
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then((m) => m || caches.match("./index.html"))
      )
  );
});
