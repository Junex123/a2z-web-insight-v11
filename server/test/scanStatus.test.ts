import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { analyzeUrl } from "../src/pipeline.js";
import { CollectorError } from "../src/collectors/httpCollector.js";
import { resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import type { PerformanceProvider, PerformanceProviderResult } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

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

function providerWith(result: PerformanceProviderResult): PerformanceProvider {
  return { name: "fake", analyze: async () => result };
}

test('status is "success" when both HTTP measurement and PageSpeed complete', async () => {
  resetCwvIssueIdCounter();
  const evidence = {
    strategy: "mobile" as const,
    lighthousePerformanceScore: 90,
    metrics: {
      lcp: { value: 2000, unit: "ms" as const, status: "good" as const, source: "pagespeed-lab" as const },
      inp: { value: 150, unit: "ms" as const, status: "good" as const, source: "pagespeed-lab" as const },
      cls: { value: 0.05, unit: "unitless" as const, status: "good" as const, source: "pagespeed-lab" as const },
      ttfb: { value: 300, unit: "ms" as const, status: "good" as const, source: "pagespeed-lab" as const },
      fcp: { value: 1200, unit: "ms" as const, status: "good" as const, source: "pagespeed-lab" as const },
      speedIndex: { value: 2000, unit: "ms" as const, status: "good" as const, source: "pagespeed-lab" as const },
      tbt: { value: 100, unit: "ms" as const, status: "good" as const, source: "pagespeed-lab" as const },
    },
    opportunities: [],
    coverage: { metricsAvailable: 7, metricsTotal: 7 },
  };
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, {
    performanceProvider: providerWith({ status: "available", evidence }),
  });
  assert.equal(report.status, "success");
});

test('status is "partial" when PageSpeed is rate limited', async () => {
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, {
    performanceProvider: providerWith({ status: "rate_limited", evidence: null, errorMessage: "rate limited" }),
  });
  assert.equal(report.status, "partial");
  // the rest of the report is still fully usable
  assert.ok(report.scores.seo >= 0);
  assert.ok(report.scores.security >= 0);
  assert.ok(report.allIssues.length >= 0);
});

test('status is "partial" when PageSpeed times out', async () => {
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, {
    performanceProvider: providerWith({ status: "timeout", evidence: null, errorMessage: "timed out" }),
  });
  assert.equal(report.status, "partial");
});

test('status is "partial" when PageSpeed is not configured (no API key)', async () => {
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, {
    performanceProvider: providerWith({ status: "not_configured", evidence: null, errorMessage: "no key" }),
  });
  assert.equal(report.status, "partial");
});

test("a completely unreachable target throws before any report is built (the FAILED case)", async () => {
  await assert.rejects(
    () => analyzeUrl(`http://localhost:1/nowhere`), // port 1 - nothing listens there
    (err: unknown) => err instanceof CollectorError,
  );
});

test("every report carries a unique reportId", async () => {
  resetCwvIssueIdCounter();
  const provider = providerWith({ status: "not_configured", evidence: null, errorMessage: "no key" });
  const a = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });
  const b = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });
  assert.ok(a.reportId);
  assert.ok(b.reportId);
  assert.notEqual(a.reportId, b.reportId);
});
