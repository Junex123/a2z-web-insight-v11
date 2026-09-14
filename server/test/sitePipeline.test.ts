import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { analyzeSite } from "../src/sitePipeline.js";
import { createApp } from "../src/app.js";

process.env.ALLOW_LOCAL_TARGETS = "true";
delete process.env.PAGESPEED_INSIGHTS_API_KEY;

let mockServer: Server;
let mockPort: number;
let origin: string;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;
  origin = `http://localhost:${mockPort}`;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

test("analyzeSite() returns a complete SiteAnalysisReport with pages, stats, and rollups", async () => {
  const report = await analyzeSite(`${origin}/site/home`, { maxPages: 10, maxDepth: 3, respectRobots: false, useSitemap: false, requestTimeoutMs: 5000 });
  assert.ok(report.siteReportId);
  assert.equal(report.seedUrl, `${origin}/site/home`);
  assert.ok(report.pages.length > 0);
  assert.equal(report.stats.seedUrl, `${origin}/site/home`);
  assert.equal(report.categorySummaries.length, 4);
  assert.ok(Array.isArray(report.siteWideFindings));
});

test("POST /api/analyze-site returns a full site report for a valid URL", async () => {
  const app = createApp({ rateLimiter: false, siteRateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const response = await fetch(`http://localhost:${port}/api/analyze-site`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${origin}/site/deep/level2`, maxPages: 5, maxDepth: 2 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.siteReportId);
    assert.ok(body.pages.length > 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("POST /api/analyze-site rejects a missing url with 400", async () => {
  const app = createApp({ rateLimiter: false, siteRateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const response = await fetch(`http://localhost:${port}/api/analyze-site`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_URL");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("POST /api/analyze-site clamps maxPages/maxDepth to server-side ceilings rather than trusting the client", async () => {
  const app = createApp({ rateLimiter: false, siteRateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const response = await fetch(`http://localhost:${port}/api/analyze-site`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${origin}/site/contact`, maxPages: 99999, maxDepth: 99999 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.crawlOptions.maxPages <= 50);
    assert.ok(body.crawlOptions.maxDepth <= 10);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("/api/analyze and /api/analyze-site are routed independently (no path-prefix collision)", async () => {
  const app = createApp({ rateLimiter: false, siteRateLimiter: false });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const singlePage = await fetch(`http://localhost:${port}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${origin}/site/contact` }),
    });
    assert.equal(singlePage.status, 200);
    const singleBody = await singlePage.json();
    assert.ok(!("pages" in singleBody)); // a single-page AnalysisReport, not a SiteAnalysisReport

    const site = await fetch(`http://localhost:${port}/api/analyze-site`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${origin}/site/contact`, maxPages: 1 }),
    });
    assert.equal(site.status, 200);
    const siteBody = await site.json();
    assert.ok("pages" in siteBody);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
