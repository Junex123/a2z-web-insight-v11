import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { fetchSitemap, parseSitemapXml } from "../src/collectors/sitemapCollector.js";

test("parses a valid urlset sitemap", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`;
  const result = parseSitemapXml(xml);
  assert.equal(result.parseError, null);
  assert.equal(result.isSitemapIndex, false);
  assert.equal(result.urls.length, 2);
  assert.equal(result.urls[0].loc, "https://example.com/");
  assert.equal(result.urls[0].lastmod, "2026-01-01");
  assert.equal(result.malformedUrlCount, 0);
});

test("flags <url> entries with no <loc> as malformed", () => {
  const xml = `<urlset><url><lastmod>2026-01-01</lastmod></url><url><loc>https://example.com/ok</loc></url></urlset>`;
  const result = parseSitemapXml(xml);
  assert.equal(result.malformedUrlCount, 1);
  assert.equal(result.urls.length, 1);
});

test("flags an unparseable <loc> URL as malformed but still records it", () => {
  const xml = `<urlset><url><loc>not a url at all</loc></url></urlset>`;
  const result = parseSitemapXml(xml);
  assert.equal(result.urls.length, 1);
  assert.equal(result.urls[0].isWellFormedUrl, false);
  assert.equal(result.malformedUrlCount, 1);
});

test("returns a parse error for content with no recognizable root element", () => {
  const result = parseSitemapXml("<html><body>this is not a sitemap</body></html>");
  assert.ok(result.parseError);
  assert.equal(result.urls.length, 0);
});

test("returns a parse error for empty content", () => {
  const result = parseSitemapXml("   ");
  assert.ok(result.parseError);
});

test("parses a sitemap index into child sitemap URLs", () => {
  const xml = `<sitemapindex>
    <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
    <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
  </sitemapindex>`;
  const result = parseSitemapXml(xml);
  assert.equal(result.isSitemapIndex, true);
  assert.deepEqual(result.childSitemapUrls, ["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"]);
});

test("decodes basic XML entities in <loc>", () => {
  const xml = `<urlset><url><loc>https://example.com/search?a=1&amp;b=2</loc></url></urlset>`;
  const result = parseSitemapXml(xml);
  assert.equal(result.urls[0].loc, "https://example.com/search?a=1&b=2");
});

// ---------------- fetching (real HTTP, including a sitemap index with children) ----------------

process.env.ALLOW_LOCAL_TARGETS = "true";

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.get("/sitemap.xml", (_req, res) => {
    res.type("application/xml").send(`<urlset><url><loc>http://localhost:${port}/a</loc></url><url><loc>http://localhost:${port}/b</loc></url></urlset>`);
  });
  app.get("/sitemap-index.xml", (_req, res) => {
    res.type("application/xml").send(`<sitemapindex><sitemap><loc>http://localhost:${port}/sitemap-child.xml</loc></sitemap></sitemapindex>`);
  });
  app.get("/sitemap-child.xml", (_req, res) => {
    res.type("application/xml").send(`<urlset><url><loc>http://localhost:${port}/c</loc></url></urlset>`);
  });
  app.get("/duplicate-sitemap.xml", (_req, res) => {
    res.type("application/xml").send(`<urlset><url><loc>http://localhost:${port}/a</loc></url><url><loc>http://localhost:${port}/a</loc></url></urlset>`);
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test("fetchSitemap retrieves and parses a real sitemap over HTTP", async () => {
  const result = await fetchSitemap(`http://localhost:${port}/sitemap.xml`);
  assert.equal(result.available, true);
  assert.equal(result.urls.length, 2);
});

test("fetchSitemap follows a sitemap index and merges child URLs", async () => {
  const result = await fetchSitemap(`http://localhost:${port}/sitemap-index.xml`);
  assert.equal(result.available, true);
  assert.equal(result.isSitemapIndex, true);
  assert.equal(result.urls.length, 1);
  assert.equal(result.urls[0].loc, `http://localhost:${port}/c`);
});

test("fetchSitemap counts duplicate URL entries", async () => {
  const result = await fetchSitemap(`http://localhost:${port}/duplicate-sitemap.xml`);
  assert.equal(result.duplicateUrlCount, 1);
});

test("fetchSitemap resolves to available:false (not an error) for a missing sitemap", async () => {
  const result = await fetchSitemap(`http://localhost:${port}/does-not-exist.xml`);
  assert.equal(result.available, false);
});
