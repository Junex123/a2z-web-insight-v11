import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { analyzeUrl } from "../src/pipeline.js";
import { analyzeSite } from "../src/sitePipeline.js";
import { resetIssueIdCounter } from "../src/analysis/issues.js";
import { resetHtmlPerformanceIssueIdCounter } from "../src/analysis/htmlPerformanceIssues.js";

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

test("a single-page report's performanceOpportunities groups its own performance issues", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`${origin}/clean`);
  // /clean's hero image has no width/height (see htmlPerformanceIssues session) -> one image-delivery opportunity
  const imageOpportunity = report.performanceOpportunities.find((o) => o.category === "image-delivery");
  assert.ok(imageOpportunity);
  assert.ok(imageOpportunity!.affectedIssueIds.length > 0);
  // every id it references really exists in allIssues
  for (const id of imageOpportunity!.affectedIssueIds) {
    assert.ok(report.allIssues.some((i) => i.id === id));
  }
  // fix-priority fields are always populated
  assert.ok(["quick-win", "major-project", "fill-in", "reconsider"].includes(imageOpportunity!.fixPriority));
  assert.equal(typeof imageOpportunity!.fixPriorityRank, "number");
});

test("performanceRootCauseChains is always present (possibly empty) on a real report", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`${origin}/clean`);
  assert.ok(Array.isArray(report.performanceRootCauseChains));
  // without a PageSpeed API key configured, there's no CWV evidence, so no chain requiring a CWV metric can fire
  assert.equal(report.performanceRootCauseChains.length, 0);
});

test("a clean-enough page produces no opportunities for categories with zero findings", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`${origin}/clean`);
  assert.ok(!report.performanceOpportunities.some((o) => o.category === "javascript-delivery"));
});

test("a site-wide crawl produces sitePerformanceOpportunities alongside siteWideFindings", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const site = await analyzeSite(`${origin}/site/home`, { maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false, requestTimeoutMs: 5000 });
  assert.ok(Array.isArray(site.sitePerformanceOpportunities));
  // every site-wide opportunity's pagesAnalyzed matches the crawl's actual analyzed count
  for (const o of site.sitePerformanceOpportunities) {
    assert.equal(o.pagesAnalyzed, site.stats.pagesAnalyzed);
  }
});

test("siteWideRootCauseChains is always present (possibly empty) on a real site-wide report", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const site = await analyzeSite(`${origin}/site/home`, { maxPages: 20, maxDepth: 5, respectRobots: false, useSitemap: false, requestTimeoutMs: 5000 });
  assert.ok(Array.isArray(site.siteWideRootCauseChains));
  // without a PageSpeed API key configured, there's no CWV evidence at all, so no chain requiring a CWV metric can fire
  assert.equal(site.siteWideRootCauseChains.length, 0);
});
