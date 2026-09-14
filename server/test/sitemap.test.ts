import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { discoverSitemapUrls } from "../src/crawler/sitemap.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let mockPort: number;
let mockOrigin: string;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;
  mockOrigin = `http://localhost:${mockPort}`;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

test("URLs are extracted from a real sitemap.xml", async () => {
  const urls = await discoverSitemapUrls(`${mockOrigin}/sitemap.xml`, mockOrigin, { timeoutMs: 5000 });
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.endsWith("/site/home")));
  assert.ok(urls.some((u) => u.endsWith("/site/only-in-sitemap")));
});

test("cross-origin <loc> entries are excluded", async () => {
  const express = (await import("express")).default;
  const app = express();
  app.get("/sitemap.xml", (_req, res) =>
    res
      .type("application/xml")
      .send(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${mockOrigin}/site/home</loc></url><url><loc>https://external-example.test/page</loc></url></urlset>`,
      ),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const urls = await discoverSitemapUrls(`http://localhost:${port}/sitemap.xml`, mockOrigin, { timeoutMs: 5000 });
    assert.equal(urls.length, 1);
    assert.ok(urls[0].endsWith("/site/home"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("a missing sitemap.xml returns an empty list rather than throwing", async () => {
  const urls = await discoverSitemapUrls(`${mockOrigin}/does-not-exist-sitemap.xml`, mockOrigin, { timeoutMs: 5000 });
  assert.deepEqual(urls, []);
});

test("a malformed <loc> entry is skipped without failing the whole sitemap", async () => {
  const express = (await import("express")).default;
  const app = express();
  app.get("/sitemap.xml", (_req, res) =>
    res
      .type("application/xml")
      .send(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>not a valid url</loc></url><url><loc>${mockOrigin}/site/home</loc></url></urlset>`,
      ),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const urls = await discoverSitemapUrls(`http://localhost:${port}/sitemap.xml`, mockOrigin, { timeoutMs: 5000 });
    assert.equal(urls.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
