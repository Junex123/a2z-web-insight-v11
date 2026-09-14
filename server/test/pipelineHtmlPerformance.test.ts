import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { analyzeUrl } from "../src/pipeline.js";
import { resetIssueIdCounter } from "../src/analysis/issues.js";
import { resetHtmlPerformanceIssueIdCounter } from "../src/analysis/htmlPerformanceIssues.js";

process.env.ALLOW_LOCAL_TARGETS = "true";
delete process.env.PAGESPEED_INSIGHTS_API_KEY;

let mockServer: Server;
let mockPort: number;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

test("the /clean fixture's hero image (no width/height) is caught by the new static HTML performance rule", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`);
  assert.ok(report.allIssues.some((i) => i.title === "Images missing explicit width/height"));
});

test("the /clean fixture's canonical link (which legitimately points at localhost, since that IS the test server) is NOT flagged as a dev/localhost resource", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`);
  assert.ok(!report.allIssues.some((i) => i.title.includes("Development/localhost")));
});

test("performanceVerification is present on every report and covers all seven areas", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`);
  const areas = report.performanceVerification.map((e) => e.area);
  assert.deepEqual(
    [...areas].sort(),
    [
      "core-web-vitals",
      "html-static-resource-patterns",
      "mobile-performance",
      "production-build-quality",
      "rendering-and-runtime-behavior",
      "resource-payload-and-third-party",
      "site-wide-performance-patterns",
    ].sort(),
  );
});

test("with no PageSpeed API key configured, core-web-vitals and resource-payload are 'unverified', not silently 'verified'", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`);
  const cwv = report.performanceVerification.find((e) => e.area === "core-web-vitals")!;
  const resources = report.performanceVerification.find((e) => e.area === "resource-payload-and-third-party")!;
  assert.equal(cwv.state, "unverified");
  assert.equal(resources.state, "unverified");
});

test("a single-page scan always reports site-wide-performance-patterns as not_applicable", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`);
  const siteWide = report.performanceVerification.find((e) => e.area === "site-wide-performance-patterns")!;
  assert.equal(siteWide.state, "not_applicable");
});

test("regression: /messy still triggers the pre-existing render-blocking-scripts-in-head and stylesheet findings alongside the new HTML performance findings", async () => {
  resetIssueIdCounter();
  resetHtmlPerformanceIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/messy`);
  const titles = report.allIssues.map((i) => i.title);
  assert.ok(titles.some((t) => t.includes("render-blocking scripts")));
  assert.ok(titles.some((t) => t.includes("render-blocking stylesheets")));
  assert.ok(titles.some((t) => t === "Images missing explicit width/height"));
});
