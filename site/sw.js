"use strict";

const scope = self.registration.scope;
const prefix = "fileroom:" + new URL(scope).pathname + ":";
const cacheName = prefix + "830babfd8156-405adc75516f";
const tail = value => new URL(value, scope).href;
const core = ["qr-code-generator/", "date-converter/", "assets/vendor/utilities.js?v=5ce71d9b87f2", "passport-photo-maker/", "pdf-page-numbers/", "organize-pdf/", "crop-image/", "extract-text/", "sign-pdf/", "jpg-to-pdf/", "pdf-to-jpg/", "watermark/", "background-remover/", "./", "merge-pdf/", "split-pdf/", "compress-pdf/", "compress-image/", "resize-image/", "convert-image/", "about/", "privacy/", "contact/", "assets/styles.css?v=405adc75516f", "assets/app.js?v=830babfd8156", "assets/vendor/pdf-lib.min.js?v=0f9a5cad0794", "assets/vendor/jszip.min.js?v=acc7e41455a8", "assets/vendor/pdf.min.js?v=5b5799e6f8c6", "assets/vendor/pdf.worker.min.js", "assets/fonts/plus-jakarta-sans.woff2", "assets/fonts/jetbrains-mono.woff2", "assets/icon-192.png", "assets/icon-512.png", "manifest.webmanifest"].map(tail);
const optional = new Set(["assets/background/ort-wasm-simd-threaded.mjs", "assets/background/ort-wasm-simd-threaded.wasm", "assets/background/ort.wasm.min.js", "assets/background/u2netp.onnx", "assets/ocr/deu.traineddata.gz", "assets/ocr/eng.traineddata.gz", "assets/ocr/fra.traineddata.gz", "assets/ocr/por.traineddata.gz", "assets/ocr/spa.traineddata.gz", "assets/ocr/tesseract-core-lstm.wasm.js", "assets/ocr/tesseract-core-simd-lstm.wasm.js", "assets/ocr/tesseract.min.js", "assets/ocr/worker.min.js"].map(tail));
const scopePath = new URL(scope).pathname;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(core)));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== cacheName).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== new URL(scope).origin || !url.pathname.startsWith(scopePath)) return;
  if (request.mode === "navigate") {
    url.search = "";
    url.pathname = url.pathname.replace(/index\.html$/, "");
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    if (!core.includes(url.href)) return;
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch {
        return (await (await caches.open(cacheName)).match(url.href)) || Response.error();
      }
    })());
    return;
  }
  if (!core.includes(url.href) && !optional.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const existing = await cache.match(request);
    if (existing) return existing;
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      try { await cache.put(request, response.clone()); }
      catch { /* Browser quota can prevent optional offline caching. */ }
    }
    return response;
  })());
});
