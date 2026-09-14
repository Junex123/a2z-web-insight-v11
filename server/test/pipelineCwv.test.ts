import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { analyzeUrl } from "../src/pipeline.js";
import { resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import type { NormalizedMetricValue, PerformanceProvider, PerformanceProviderResult } from "../src/types.js";

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

function fakeProvider(result: PerformanceProviderResult): PerformanceProvider {
  return { name: "fake-provider", analyze: async () => result };
}

function throwingProvider(): PerformanceProvider {
  return {
    name: "broken-provider",
    analyze: async () => {
      throw new Error("boom");
    },
  };
}

function goodMetric(value: number): NormalizedMetricValue {
  return { value, unit: "ms", status: "good", source: "pagespeed-lab" };
}
function poorMetric(value: number, unit: "ms" | "unitless" = "ms"): NormalizedMetricValue {
  return { value, unit, status: "poor", source: "pagespeed-field" };
}

test("scan completes successfully when the performance provider is rate limited", async () => {
  resetCwvIssueIdCounter();
  const provider = fakeProvider({ status: "rate_limited", evidence: null, errorMessage: "rate limited" });
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });

  assert.equal(report.coreWebVitals.providerStatus, "rate_limited");
  assert.equal(report.coreWebVitals.evidence, null);
  assert.ok(report.scores.performance >= 0 && report.scores.performance <= 100);
  // the rest of the report is still fully populated
  assert.ok(report.scores.seo >= 0);
  assert.ok(report.scores.security >= 0);
});

test("scan completes successfully when the performance provider throws unexpectedly", async () => {
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: throwingProvider() });
  assert.equal(report.coreWebVitals.providerStatus, "error");
  assert.ok(report.scores.overall >= 0 && report.scores.overall <= 100);
});

test("with no API key configured, the default provider reports not_configured and the scan still completes", async () => {
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`);
  assert.equal(report.coreWebVitals.providerStatus, "not_configured");
  assert.equal(report.coreWebVitals.evidence, null);
  assert.equal(report.coreWebVitals.factors.length, 0);
  assert.ok(report.scores.overall >= 0 && report.scores.overall <= 100);
});

test("poor Core Web Vitals evidence lowers the performance score and appears in findings", async () => {
  resetCwvIssueIdCounter();
  const evidence = {
    strategy: "mobile" as const,
    lighthousePerformanceScore: 34,
    metrics: {
      lcp: poorMetric(6200),
      inp: poorMetric(650),
      cls: poorMetric(0.4, "unitless"),
      ttfb: goodMetric(300),
      fcp: poorMetric(3800),
      speedIndex: poorMetric(8000),
      tbt: poorMetric(900),
    },
    opportunities: [],
    coverage: { metricsAvailable: 7, metricsTotal: 7 },
  };
  const provider = fakeProvider({ status: "available", evidence });
  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });

  assert.equal(report.coreWebVitals.providerStatus, "available");
  assert.ok(report.scores.performance < 100, "performance score should drop below a perfect 100");
  const cwvFindingTitles = report.allIssues.filter((i) => i.category === "performance").map((i) => i.title);
  assert.ok(cwvFindingTitles.some((t) => t.includes("Largest Contentful Paint")));
  assert.ok(cwvFindingTitles.some((t) => t.includes("Interaction to Next Paint")));
  assert.ok(report.coreWebVitals.factors.length === 7);
});

test("scores stay within 0-100 even when both HTTP-based and CWV-based issues stack up heavily", async () => {
  resetCwvIssueIdCounter();
  const evidence = {
    strategy: "mobile" as const,
    lighthousePerformanceScore: 5,
    metrics: {
      lcp: poorMetric(9000),
      inp: poorMetric(1200),
      cls: poorMetric(0.9, "unitless"),
      ttfb: poorMetric(4000),
      fcp: poorMetric(6000),
      speedIndex: poorMetric(12000),
      tbt: poorMetric(2000),
    },
    opportunities: [],
    coverage: { metricsAvailable: 7, metricsTotal: 7 },
  };
  const provider = fakeProvider({ status: "available", evidence });
  // /messy already trips ~9 performance/seo/security issues on its own
  const report = await analyzeUrl(`http://localhost:${mockPort}/messy`, { performanceProvider: provider });

  for (const score of [report.scores.performance, report.scores.seo, report.scores.security, report.scores.overall]) {
    assert.ok(Number.isFinite(score), "score must be finite");
    assert.ok(score >= 0 && score <= 100, `score ${score} out of 0-100 range`);
  }
});
