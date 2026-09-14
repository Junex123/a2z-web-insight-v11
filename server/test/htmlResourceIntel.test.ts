import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHtml } from "../src/collectors/htmlCollector.js";

test("a minimal page produces an all-zero/empty resourceIntel, never fabricated", () => {
  const result = collectHtml("<html><head></head><body>plain</body></html>", true);
  const r = result.resourceIntel!;
  assert.equal(r.resourceHints.preload, 0);
  assert.equal(r.images.missingDimensions, 0);
  assert.equal(r.scripts.devOrLocalhostRefs.length, 0);
  assert.equal(r.fonts.linkCount, 0);
});

test("resource hints are counted by type, and preload without as= is flagged", () => {
  const html = `<html><head>
    <link rel="preload" href="/a.js" as="script">
    <link rel="preload" href="/b.woff2">
    <link rel="prefetch" href="/c.js">
    <link rel="preconnect" href="https://fonts.gstatic.com">
    <link rel="dns-prefetch" href="https://analytics.example.com">
    <link rel="modulepreload" href="/d.js">
  </head><body></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.resourceHints.preload, 2);
  assert.equal(r.resourceHints.preloadMissingAs, 1);
  assert.equal(r.resourceHints.prefetch, 1);
  assert.equal(r.resourceHints.preconnect, 1);
  assert.equal(r.resourceHints.dnsPrefetch, 1);
  assert.equal(r.resourceHints.modulepreload, 1);
});

test("images without width/height are counted with examples", () => {
  const html = `<html><body>
    <img src="/a.jpg" width="100" height="100">
    <img src="/b.jpg">
    <img src="/c.jpg" width="50">
  </body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.images.missingDimensions, 1);
  assert.deepEqual(r.images.missingDimensionsExamples, ["/b.jpg"]);
});

test("images past the first few without loading=lazy are flagged as likely-eager-below-fold", () => {
  const imgs = Array.from({ length: 6 }, (_, i) => `<img src="/img${i}.jpg" width="10" height="10">`).join("\n");
  const html = `<html><body>${imgs}</body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  // first 3 are exempt from the heuristic; images 3,4,5 (0-indexed) should be flagged
  assert.equal(r.images.eagerLikelyBelowFold, 3);
});

test("loading=lazy on later images suppresses the eager-below-fold flag", () => {
  const imgs = Array.from({ length: 6 }, (_, i) => `<img src="/img${i}.jpg" width="10" height="10" loading="lazy">`).join("\n");
  const html = `<html><body>${imgs}</body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.images.eagerLikelyBelowFold, 0);
});

test("localhost and common dev-port references are detected across script/link/img/iframe", () => {
  const html = `<html><head>
    <script src="http://localhost:5173/app.js"></script>
    <link rel="stylesheet" href="http://127.0.0.1:8080/style.css">
  </head><body>
    <img src="http://localhost/hero.jpg">
    <iframe src="http://localhost:3000/embed"></iframe>
  </body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.ok(r.scripts.devOrLocalhostRefs.length >= 4);
  assert.ok(r.scripts.devOrLocalhostRefs.some((s) => s.includes("localhost:5173")));
});

test("a normal production CDN URL is never mistaken for a dev/localhost reference", () => {
  const html = `<html><head><script src="https://cdn.example.com/app.js"></script></head><body></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.scripts.devOrLocalhostRefs.length, 0);
});

test("source maps are detected via a .js.map src and an inline sourceMappingURL comment", () => {
  const html = `<html><body>
    <script src="/app.js.map"></script>
    <script>//# sourceMappingURL=inline.js.map</script>
  </body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.scripts.sourceMapRefs.length, 2);
});

test("duplicate script and stylesheet references are detected", () => {
  const html = `<html><head>
    <script src="/vendor.js"></script>
    <script src="/vendor.js"></script>
    <link rel="stylesheet" href="/main.css">
    <link rel="stylesheet" href="/main.css">
  </head><body></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.scripts.duplicateSrcCount, 1);
  assert.deepEqual(r.scripts.duplicateSrcExamples, ["/vendor.js"]);
  assert.equal(r.stylesheets.duplicateHrefCount, 1);
});

test("inline script and style bytes are summed", () => {
  const html = `<html><head><style>body{color:red}</style></head><body><script>console.log("hello world");</script></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.ok(r.scripts.inlineScriptBytes > 0);
  assert.ok(r.stylesheets.inlineStyleBytes > 0);
});

test("Google Fonts links are detected and variant counts parsed from the family query param", () => {
  const html = `<html><head>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  </head><body></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.fonts.linkCount, 1);
  assert.equal(r.fonts.families[0].variantCount, 5);
});

test("a non-Google-Fonts stylesheet link is not misparsed as a font with a variant count", () => {
  const html = `<html><head><link href="/main.css" rel="stylesheet"></head><body></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.fonts.linkCount, 0);
  assert.equal(r.fonts.families.length, 0);
});

test("video/audio/iframe counts are captured", () => {
  const html = `<html><body><video src="/a.mp4"></video><audio src="/a.mp3"></audio><iframe src="https://example.com/embed"></iframe></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  assert.equal(r.media.videoCount, 1);
  assert.equal(r.media.audioCount, 1);
  assert.equal(r.media.iframeCount, 1);
});

test("known library keywords in script/link srcs are captured as hints", () => {
  const html = `<html><head>
    <link href="/font-awesome.min.css" rel="stylesheet">
    <script src="/material-icons.js"></script>
  </head><body></body></html>`;
  const r = collectHtml(html, true).resourceIntel!;
  const keywords = r.libraryHints.map((h) => h.keyword);
  assert.ok(keywords.includes("font-awesome"));
  assert.ok(keywords.includes("material-icons"));
});

test("regression: existing top-level HtmlAnalysis fields (scripts.blockingInHead, images.missingAlt, etc.) are unchanged", () => {
  const html = `<html><head><script></script></head><body><img src="/a.jpg"></body></html>`;
  const result = collectHtml(html, true);
  assert.equal(result.images.total, 1);
  assert.equal(result.images.missingAlt, 1);
  assert.ok(result.resourceIntel !== undefined);
});
