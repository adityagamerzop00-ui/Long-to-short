/* Long to Shorts Clipper - service worker (app install, offline shell, share target) */
var VER = "lts-v1";
var SHELL = ["./", "./index.html", "./hark.css", "./hark-hero.css", "./hark.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VER).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VER && k !== "lts-share" && k !== "lts-cdn"; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  // Video shared from gallery / share sheet
  if (req.method === "POST" && url.origin === location.origin && url.pathname.slice(-12) === "/share-target") {
    e.respondWith((async function () {
      try {
        var fd = await req.formData(), f = fd.get("video");
        if (f && f.size) {
          var c = await caches.open("lts-share");
          await c.put("./shared-video", new Response(f, { headers: { "Content-Type": f.type || "video/mp4", "X-Name": encodeURIComponent(f.name || "shared-video.mp4") } }));
        }
      } catch (err) {}
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }
  if (req.method !== "GET") return;
  // Same-origin: network first (always newest), cache fallback (offline)
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var cp = res.clone(); caches.open(VER).then(function (c) { c.put(req, cp); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match("./index.html"); });
    }));
    return;
  }
  // Small CDN libraries (not AI models): cache after first use
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.indexOf("@huggingface") < 0) {
    e.respondWith(caches.open("lts-cdn").then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) { if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone()); return res; });
        return hit || net;
      });
    }));
  }
});
