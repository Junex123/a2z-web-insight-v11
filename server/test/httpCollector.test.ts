// Tests for collectHttp's core fetch mechanics - body reading, size
// calculation, compression handling, content-type detection, header
// capture. Deliberately separate from httpCollectorSecurity.test.ts
// (which only covers the SSRF/redirect guard) - this file exists
// because no test previously exercised collectHttp's basic body/size
// measurement logic directly, which was a real, verifiable gap found
// while investigating a reported "0KB HTML despite HTTP 200" symptom
// on a live site this sandbox cannot reach (see PROJECT_PROGRESS.md's
// Session 8 entry for the full account of what could and couldn't be
// verified).
//
// Uses only node:http/node:zlib - no express/cheerio - so it has zero
// dependency on this sandbox's package-installation limitations.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { after, before, test } from "node:test";
import { collectHttp, CollectorError } from "../src/collectors/httpCollector.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/empty-body") {
      // HTTP 200, correct content-type, genuinely zero bytes in the body -
      // this is what a bot-blocking WAF/edge response often looks like.
      res.writeHead(200, { "content-type": "text/html" });
      res.end();
      return;
    }

    if (url === "/normal") {
      const html = "<html><body><h1>Hello</h1></body></html>";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }

    if (url === "/gzipped") {
      const html = "<html><body>" + "gzip test content ".repeat(500) + "</body></html>";
      const compressed = gzipSync(Buffer.from(html, "utf-8"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(compressed);
      return;
    }

    if (url === "/deflated") {
      const html = "<html><body>" + "deflate test content ".repeat(500) + "</body></html>";
      const compressed = deflateSync(Buffer.from(html, "utf-8"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" });
      res.end(compressed);
      return;
    }

    if (url === "/brotli") {
      const html = "<html><body>" + "brotli test content ".repeat(500) + "</body></html>";
      const compressed = brotliCompressSync(Buffer.from(html, "utf-8"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
      res.end(compressed);
      return;
    }

    if (url === "/charset-param") {
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end("<html><body>with charset param</body></html>");
      return;
    }

    if (url === "/xhtml") {
      res.writeHead(200, { "content-type": "application/xhtml+xml" });
      res.end("<html><body>xhtml</body></html>");
      return;
    }

    if (url === "/non-html") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"not":"html"}');
      return;
    }

    if (url === "/no-content-type") {
      res.writeHead(200, {});
      res.end("<html><body>no content-type header at all</body></html>");
      return;
    }

    if (url === "/unicode") {
      const html = "<html><body>caf\u00e9 \u4e2d\u6587 \ud83d\ude00</body></html>";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url === "/large") {
      // just under the 5MB cap
      const big = "x".repeat(4_000_000);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${big}</body></html>`);
      return;
    }

    if (url === "/too-large") {
      // over the 5MB cap
      const big = "x".repeat(6_000_000);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${big}</body></html>`);
      return;
    }

    if (url === "/redirect-to-normal") {
      res.writeHead(302, { location: "/normal" });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  delete process.env.ALLOW_LOCAL_TARGETS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a genuinely empty body is reported honestly as bodyBytes: 0, not as an error or a crash", async () => {
  const result = await collectHttp(`${base}/empty-body`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.bodyBytes, 0);
  assert.equal(result.bodyText, "");
  assert.equal(result.contentType, "text/html");
});

test("a normal HTML body reports the correct, non-zero byte count matching the real UTF-8 byte length", async () => {
  const html = "<html><body><h1>Hello</h1></body></html>";
  const result = await collectHttp(`${base}/normal`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.bodyBytes, Buffer.byteLength(html, "utf-8"));
  assert.equal(result.bodyText, html);
});

test("a gzip-compressed response is transparently decompressed - bodyBytes reflects the DECOMPRESSED size, not the wire size", async () => {
  const result = await collectHttp(`${base}/gzipped`);
  assert.equal(result.statusCode, 200);
  assert.match(result.bodyText, /gzip test content/);
  assert.ok(result.bodyText.length > 5000, "expected the real decompressed content, not compressed bytes");
  assert.equal(result.bodyBytes, Buffer.byteLength(result.bodyText, "utf-8"));
});

test("a deflate-compressed response is transparently decompressed", async () => {
  const result = await collectHttp(`${base}/deflated`);
  assert.match(result.bodyText, /deflate test content/);
  assert.equal(result.bodyBytes, Buffer.byteLength(result.bodyText, "utf-8"));
});

test("a brotli-compressed response is transparently decompressed", async () => {
  const result = await collectHttp(`${base}/brotli`);
  assert.match(result.bodyText, /brotli test content/);
  assert.equal(result.bodyBytes, Buffer.byteLength(result.bodyText, "utf-8"));
});

test("a content-type with a charset parameter is still recognized as HTML, not rejected", async () => {
  const result = await collectHttp(`${base}/charset-param`);
  assert.equal(result.statusCode, 200);
  assert.match(result.bodyText, /with charset param/);
});

test("application/xhtml+xml is recognized as HTML", async () => {
  const result = await collectHttp(`${base}/xhtml`);
  assert.match(result.bodyText, /xhtml/);
});

test("a non-HTML content-type is rejected as NON_HTML, not silently returned as an empty/zero report", async () => {
  await assert.rejects(
    () => collectHttp(`${base}/non-html`),
    (err: unknown) => err instanceof CollectorError && err.code === "NON_HTML",
  );
});

test("a response with no content-type header at all is rejected as NON_HTML (fails closed, not open)", async () => {
  await assert.rejects(
    () => collectHttp(`${base}/no-content-type`),
    (err: unknown) => err instanceof CollectorError && err.code === "NON_HTML",
  );
});

test("multi-byte UTF-8 content (accents, CJK, emoji) round-trips correctly and byte count reflects real UTF-8 encoding, not character count", async () => {
  const result = await collectHttp(`${base}/unicode`);
  assert.match(result.bodyText, /café/);
  assert.match(result.bodyText, /中文/);
  // byte length must exceed character length for multi-byte content
  assert.ok(result.bodyBytes > result.bodyText.length);
  assert.equal(result.bodyBytes, Buffer.byteLength(result.bodyText, "utf-8"));
});

test("a large body just under the 5MB cap is accepted and measured correctly", async () => {
  const result = await collectHttp(`${base}/large`, { timeoutMs: 20_000 });
  assert.ok(result.bodyBytes > 3_900_000 && result.bodyBytes < 5_000_000);
});

test("a body over the 5MB cap is rejected as TARGET_UNREACHABLE, not silently truncated", async () => {
  await assert.rejects(
    () => collectHttp(`${base}/too-large`, { timeoutMs: 20_000 }),
    (err: unknown) => err instanceof CollectorError && err.code === "TARGET_UNREACHABLE",
  );
});

test("headers are captured and lowercased consistently", async () => {
  const result = await collectHttp(`${base}/normal`);
  assert.equal(result.headers["content-type"], "text/html");
});

test("a redirect followed to a normal page reports the FINAL page's body correctly, not the redirect's (empty) body", async () => {
  const result = await collectHttp(`${base}/redirect-to-normal`);
  assert.equal(result.redirected, true);
  assert.equal(result.redirectCount, 1);
  assert.match(result.bodyText, /Hello/);
  assert.ok(result.bodyBytes > 0);
});

test("timing fields are populated and non-negative", async () => {
  const result = await collectHttp(`${base}/normal`);
  assert.ok(result.timing.approxTtfbMs >= 0);
  assert.ok(result.timing.totalDownloadMs >= result.timing.approxTtfbMs - 1); // allow rounding
});
