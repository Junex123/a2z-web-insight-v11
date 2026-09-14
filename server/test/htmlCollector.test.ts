import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHtml } from "../src/collectors/htmlCollector.js";

test("extracts title, meta description, and headings", () => {
  const html = `<html><head><title>Hello World</title>
    <meta name="description" content="A short description of the page."></head>
    <body><h1>Main Heading</h1></body></html>`;
  const result = collectHtml(html, true);
  assert.equal(result.title, "Hello World");
  assert.equal(result.metaDescription, "A short description of the page.");
  assert.equal(result.h1Count, 1);
  assert.deepEqual(result.h1Texts, ["Main Heading"]);
});

test("flags images missing alt text", () => {
  const html = `<html><body>
    <img src="a.png" alt="described">
    <img src="b.png">
    <img src="c.png" alt="">
  </body></html>`;
  const result = collectHtml(html, true);
  assert.equal(result.images.total, 3);
  assert.equal(result.images.missingAlt, 2);
});

test("counts render-blocking scripts vs async/defer scripts", () => {
  const html = `<html><head>
    <script src="blocking.js"></script>
    <script src="deferred.js" defer></script>
    <script src="async.js" async></script>
  </head><body></body></html>`;
  const result = collectHtml(html, true);
  assert.equal(result.scripts.total, 3);
  assert.equal(result.scripts.blockingInHead, 1);
  assert.equal(result.scripts.asyncOrDefer, 2);
});

test("detects mixed content only when page is https", () => {
  const html = `<html><body><img src="http://insecure.example.com/x.png"></body></html>`;
  const httpsResult = collectHtml(html, true);
  assert.equal(httpsResult.insecureResourceRefs.length, 1);

  const httpResult = collectHtml(html, false);
  assert.equal(httpResult.insecureResourceRefs.length, 0);
});

test("handles a page with none of the expected tags gracefully", () => {
  const result = collectHtml("<html><body>plain</body></html>", true);
  assert.equal(result.title, null);
  assert.equal(result.metaDescription, null);
  assert.equal(result.canonicalUrl, null);
  assert.equal(result.h1Count, 0);
});
