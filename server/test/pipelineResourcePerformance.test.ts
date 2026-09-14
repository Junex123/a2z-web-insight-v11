import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { analyzeUrl } from "../src/pipeline.js";
import { resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import { resetResourceIssueIdCounter } from "../src/analysis/resourceIssues.js";
import { aggregateSitePerformance, buildPagePerformanceResult } from "../src/analysis/siteWidePerformance.js";
import type { CoreWebVitalsEvidence, PerformanceProvider, PerformanceProviderResult, ResourceEvidence } from "../src/types.js";

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

function emptyResources(): ResourceEvidence {
  return {
    totalTransferBytes: null,
    totalRequestCount: null,
    resourceSummary: [],
    renderBlockingResources: [],
    thirdParty: [],
    unusedCssBytes: null,
    unusedJsBytes: null,
    unminifiedCssBytes: null,
    unminifiedJsBytes: null,
    modernImageFormatSavingsBytes: null,
    offscreenImageSavingsBytes: null,
    responsiveImageSavingsBytes: null,
    textCompressionSavingsBytes: null,
    longCacheTtlWastedBytes: null,
    cacheableAssets: [],
    fontDisplayIssueCount: null,
    fontDisplayItems: [],
    domSize: null,
    mainThreadWorkMs: null,
    bootupTimeMs: null,
  };
}

function goodEvidence(resources: ResourceEvidence): CoreWebVitalsEvidence {
  return {
    strategy: "mobile",
    lighthousePerformanceScore: 90,
    metrics: {
      lcp: { value: 1000, unit: "ms", status: "good", source: "pagespeed-lab" },
      inp: { value: 100, unit: "ms", status: "good", source: "pagespeed-lab" },
      cls: { value: 0.01, unit: "unitless", status: "good", source: "pagespeed-lab" },
      ttfb: { value: 200, unit: "ms", status: "good", source: "pagespeed-lab" },
      fcp: { value: 800, unit: "ms", status: "good", source: "pagespeed-lab" },
      speedIndex: { value: 1500, unit: "ms", status: "good", source: "pagespeed-lab" },
      tbt: { value: 50, unit: "ms", status: "good", source: "pagespeed-lab" },
    },
    opportunities: [],
    coverage: { metricsAvailable: 7, metricsTotal: 7 },
    resources,
  };
}

test("resource-level findings surface in the single-page report's allIssues when PageSpeed evidence includes them", async () => {
  resetCwvIssueIdCounter();
  resetResourceIssueIdCounter();
  const resources = emptyResources();
  resources.resourceSummary = [{ type: "script", requestCount: 8, transferSize: 700_000 }];
  const provider = fakeProvider({ status: "available", evidence: goodEvidence(resources) });

  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });
  assert.ok(report.allIssues.some((i) => i.title === "Large JavaScript payload"));
  assert.ok(report.scores.performance < 100);
});

test("regression: without resource evidence, no resource-level findings appear (existing PageSpeed behavior preserved)", async () => {
  resetCwvIssueIdCounter();
  resetResourceIssueIdCounter();
  const provider = fakeProvider({ status: "available", evidence: goodEvidence(emptyResources()) });

  const report = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });
  assert.equal(report.allIssues.filter((i) => i.title === "Large JavaScript payload").length, 0);
});

test("per-page results from repeated analyzeUrl calls can be fed directly into whole-site aggregation", async () => {
  resetCwvIssueIdCounter();
  resetResourceIssueIdCounter();
  const resources = emptyResources();
  resources.resourceSummary = [{ type: "script", requestCount: 8, transferSize: 700_000 }];
  const provider = fakeProvider({ status: "available", evidence: goodEvidence(resources) });

  // Simulates what a crawler (owned by Main Claude) would do: call the
  // existing single-page pipeline once per discovered page, then hand
  // the results to this feature's aggregation function - no second
  // crawler or fetch layer implemented here.
  const reportA = await analyzeUrl(`http://localhost:${mockPort}/clean`, { performanceProvider: provider });
  const reportB = await analyzeUrl(`http://localhost:${mockPort}/messy`, { performanceProvider: provider });

  const pageResults = [
    buildPagePerformanceResult(reportA.url, reportA.allIssues, reportA.coreWebVitals),
    buildPagePerformanceResult(reportB.url, reportB.allIssues, reportB.coreWebVitals),
  ];
  const summary = aggregateSitePerformance(pageResults);

  assert.equal(summary.pagesScanned, 2);
  assert.equal(summary.healthy + summary.warning + summary.critical, 2);
  // both pages hit the same injected JS-payload issue
  assert.ok(summary.pageResults.every((p) => p.issues.some((i) => i.title === "Large JavaScript payload")));
});
