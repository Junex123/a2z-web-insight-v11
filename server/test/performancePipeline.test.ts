import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { analyzeUrl } from "../src/pipeline.js";
import { resetIssueIdCounter } from "../src/analysis/issues.js";
import { resetSeoIssueIdCounter } from "../src/analysis/seoIssues.js";
import { resetAiGeneratedSeoIssueIdCounter } from "../src/analysis/aiGeneratedSeoIssues.js";
import { resetAccessibilityIssueIdCounter } from "../src/analysis/accessibilityIssues.js";
import { resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import { resetResourceIssueIdCounter } from "../src/analysis/resourceIssues.js";
import type { PerformanceProvider } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";
delete process.env.PAGESPEED_INSIGHTS_API_KEY;
delete process.env.PAGESPEED_API_KEY;

const notConfiguredProvider: PerformanceProvider = {
  name: "test-provider",
  analyze: async () => ({ status: "not_configured", evidence: null, errorMessage: "no key" }),
};

function providerWithOpportunity(estimatedSavingsMs: number): PerformanceProvider {
  return {
    name: "test-provider-with-opportunity",
    analyze: async () => ({
      status: "available",
      evidence: {
        strategy: "mobile",
        lighthousePerformanceScore: 65,
        metrics: {
          lcp: { value: 2000, unit: "ms", status: "good", source: "pagespeed-lab" },
          inp: { value: 150, unit: "ms", status: "good", source: "pagespeed-lab" },
          cls: { value: 0.05, unit: "unitless", status: "good", source: "pagespeed-lab" },
          ttfb: { value: 300, unit: "ms", status: "good", source: "pagespeed-lab" },
          fcp: { value: 1200, unit: "ms", status: "good", source: "pagespeed-lab" },
          speedIndex: { value: 2000, unit: "ms", status: "good", source: "pagespeed-lab" },
          tbt: { value: 100, unit: "ms", status: "good", source: "pagespeed-lab" },
        },
        opportunities: [{ id: "render-blocking-resources", title: "Eliminate render-blocking resources", estimatedSavingsMs }],
        coverage: { metricsAvailable: 7, metricsTotal: 7 },
        lcpElement: null,
      },
    }),
  };
}

function providerWithPoorLcpElement(imageUrl: string): PerformanceProvider {
  return {
    name: "test-provider-with-lcp-element",
    analyze: async () => ({
      status: "available",
      evidence: {
        strategy: "mobile",
        lighthousePerformanceScore: 40,
        metrics: {
          lcp: { value: 4800, unit: "ms", status: "poor", source: "pagespeed-field" },
          inp: { value: 150, unit: "ms", status: "good", source: "pagespeed-lab" },
          cls: { value: 0.05, unit: "unitless", status: "good", source: "pagespeed-lab" },
          ttfb: { value: 300, unit: "ms", status: "good", source: "pagespeed-lab" },
          fcp: { value: 1200, unit: "ms", status: "good", source: "pagespeed-lab" },
          speedIndex: { value: 2000, unit: "ms", status: "good", source: "pagespeed-lab" },
          tbt: { value: 100, unit: "ms", status: "good", source: "pagespeed-lab" },
        },
        opportunities: [],
        coverage: { metricsAvailable: 7, metricsTotal: 7 },
        lcpElement: { nodeSnippet: `<img src="${imageUrl}" class="hero">`, selector: "img.hero", imageUrl },
      },
    }),
  };
}

let server: Server;
let port: number;

before(async () => {
  const app = express();

  app.get("/heavy-script.js", (_req, res) => {
    res.set("Content-Length", "700000").type("application/javascript").end();
  });
  app.get("/uncompressed.css", (_req, res) => {
    res.set("Content-Length", "50000").type("text/css").end(); // no Content-Encoding, no Cache-Control
  });

  app.get("/resource-heavy-page", (_req, res) => {
    res.type("html").send(`<html><head>
      <script src="http://localhost:${port}/heavy-script.js"></script>
      <link rel="stylesheet" href="http://localhost:${port}/uncompressed.css">
    </head><body><p>content</p></body></html>`);
  });

  app.get("/plain-page", (_req, res) => {
    res.type("html").send(`<html><head><title>Plain Page</title></head><body><p>${"content ".repeat(20)}</p></body></html>`);
  });

  app.get("/empty-page", (_req, res) => {
    // HTTP 200, Content-Type: text/html, genuinely zero-byte body - the
    // exact "0KB HTML" scenario this session was asked to verify.
    res.status(200).type("html").end();
  });

  app.get("/hero.jpg", (_req, res) => {
    res.set("Content-Length", "612000").type("image/jpeg").end();
  });
  app.get("/lcp-page", (_req, res) => {
    res.type("html").send(`<html><head><title>LCP Demo</title></head><body><img src="http://localhost:${port}/hero.jpg" class="hero"></body></html>`);
  });

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

function resetAllCounters() {
  resetIssueIdCounter();
  resetSeoIssueIdCounter();
  resetAiGeneratedSeoIssueIdCounter();
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  resetResourceIssueIdCounter();
}

test("report.resourceIntelligence reflects real probed sub-resources", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/resource-heavy-page`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.resourceIntelligence.probedCount, 2);
  const script = report.resourceIntelligence.entries.find((e) => e.kind === "script");
  assert.equal(script?.contentLength, 700000);
});

test("a resource-heavy page produces resource findings (large script, missing compression, missing caching)", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/resource-heavy-page`, { performanceProvider: notConfiguredProvider });
  const resourceFindings = report.allIssues.filter((i) => i.id.startsWith("performance-res-"));
  assert.ok(resourceFindings.some((i) => i.title.includes("Large script resource")));
  assert.ok(resourceFindings.some((i) => i.title.includes("without compression")));
  assert.ok(resourceFindings.some((i) => i.title.includes("no Cache-Control")));
});

test("a page with no sub-resources produces no resource findings and resourceIntelligence is empty but present", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.resourceIntelligence.candidateCount, 0);
  assert.ok(!report.allIssues.some((i) => i.id.startsWith("performance-res-")));
});

test("a PageSpeed opportunity with material savings flows through to allIssues", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: providerWithOpportunity(900) });
  assert.ok(report.allIssues.some((i) => i.id.startsWith("performance-opp-") && i.title === "Eliminate render-blocking resources"));
});

test("a trivial PageSpeed opportunity does not flow through to allIssues", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: providerWithOpportunity(30) });
  assert.ok(!report.allIssues.some((i) => i.id.startsWith("performance-opp-")));
});

test("report.performanceVerification is present and reflects the injected provider's status honestly", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: notConfiguredProvider });
  const cwvCheck = report.performanceVerification.checks.find((c) => c.check === "core_web_vitals");
  assert.equal(cwvCheck?.state, "not_applicable");
  const runtimeCheck = report.performanceVerification.checks.find((c) => c.check === "browser_runtime");
  assert.equal(runtimeCheck?.state, "unverified");
});

test("performance category is still the only performance category (resource findings are additive, not a new category)", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/resource-heavy-page`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.categoriesAnalyzed.filter((c) => c === "performance").length, 1);
  const resourceFindings = report.allIssues.filter((i) => i.id.startsWith("performance-res-"));
  for (const f of resourceFindings) assert.equal(f.category, "performance");
});

test("resource findings count toward the performance score", async () => {
  resetAllCounters();
  const heavy = await analyzeUrl(`http://localhost:${port}/resource-heavy-page`, { performanceProvider: notConfiguredProvider });
  resetAllCounters();
  const plain = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: notConfiguredProvider });
  assert.ok(heavy.scores.performance < plain.scores.performance);
});

// ---------------- Session 11: 0KB HTML / empty response verification ----------------

test("REGRESSION: an HTTP 200 with a genuinely empty HTML body is flagged as critical, end to end - never scored as a lean/fast page", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/empty-page`, { performanceProvider: notConfiguredProvider });

  assert.equal(report.evidenceLog.fetch.bodyBytes, 0);
  const found = report.allIssues.find((i) => i.title === "Empty HTML response");
  assert.ok(found, "empty HTML response must produce a finding, not silently pass");
  assert.equal(found?.severity, "critical");
});

test("an empty HTML response scores substantially worse than a real page, not better", async () => {
  resetAllCounters();
  const empty = await analyzeUrl(`http://localhost:${port}/empty-page`, { performanceProvider: notConfiguredProvider });
  resetAllCounters();
  const plain = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: notConfiguredProvider });
  // this is the exact "backwards" failure mode this session was asked to
  // rule out: a 0-byte page must never score AS WELL AS OR BETTER THAN
  // a real one on the strength of having "nothing to flag".
  assert.ok(empty.scores.performance < plain.scores.performance);
  assert.ok(empty.scores.overall < plain.scores.overall);
});

test("resourceIntelligence for an empty page correctly reports zero candidates rather than fabricating any", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/empty-page`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.resourceIntelligence.candidateCount, 0);
  assert.equal(report.resourceIntelligence.probedCount, 0);
});

// ---------------- Session 11: desktop/mobile PageSpeed strategy plumbing ----------------

test("pageSpeedStrategy defaults to mobile and is passed through to the default provider's outgoing request", async () => {
  process.env.PAGESPEED_INSIGHTS_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ lighthouseResult: { categories: {}, audits: {} } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    resetAllCounters();
    await analyzeUrl(`http://localhost:${port}/plain-page`); // no performanceProvider injected - exercises the real default-provider path
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PAGESPEED_INSIGHTS_API_KEY;
  }

  assert.ok(capturedUrl, "the default provider should have made a real outgoing request");
  const strategyParam = new URL(capturedUrl!).searchParams.get("strategy");
  assert.equal(strategyParam, "mobile");
});

test("pageSpeedStrategy: 'desktop' is passed through to the default provider's outgoing request", async () => {
  process.env.PAGESPEED_INSIGHTS_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ lighthouseResult: { categories: {}, audits: {} } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    resetAllCounters();
    await analyzeUrl(`http://localhost:${port}/plain-page`, { pageSpeedStrategy: "desktop" });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PAGESPEED_INSIGHTS_API_KEY;
  }

  assert.ok(capturedUrl);
  const strategyParam = new URL(capturedUrl!).searchParams.get("strategy");
  assert.equal(strategyParam, "desktop");
});

test("pageSpeedStrategy is ignored when a performanceProvider is injected directly (the injected provider owns its own strategy, if any)", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/plain-page`, { performanceProvider: notConfiguredProvider, pageSpeedStrategy: "desktop" });
  assert.equal(report.coreWebVitals.providerStatus, "not_configured");
});

// ---------------- Session 12: LCP root-cause correlation, end to end ----------------

test("REGRESSION: when Lighthouse's LCP element matches a resource this scan independently probed, the LCP finding is enriched with real cross-verified evidence", async () => {
  resetAllCounters();
  const imageUrl = `http://localhost:${port}/hero.jpg`;
  const report = await analyzeUrl(`http://localhost:${port}/lcp-page`, { performanceProvider: providerWithPoorLcpElement(imageUrl) });

  const lcpIssue = report.allIssues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(lcpIssue, "a poor-LCP finding should exist");
  assert.match(lcpIssue!.estimatedImpact!, /hero\.jpg/);
  assert.ok(lcpIssue!.evidence.some((e) => e.label.includes("cross-verified")));

  // and, critically, still only ONE LCP finding - not a second parallel "root cause" issue
  const lcpIssues = report.allIssues.filter((i) => i.title.includes("Largest Contentful Paint"));
  assert.equal(lcpIssues.length, 1);
});

test("does not fabricate an LCP root cause when Lighthouse's identified element wasn't actually among the probed resources", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/lcp-page`, { performanceProvider: providerWithPoorLcpElement("http://localhost:9999/does-not-exist-on-this-page.jpg") });
  const lcpIssue = report.allIssues.find((i) => i.title.includes("Largest Contentful Paint"));
  assert.ok(lcpIssue);
  assert.ok(!lcpIssue!.evidence.some((e) => e.label.includes("cross-verified")));
});
